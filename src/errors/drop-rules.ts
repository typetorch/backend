/**
 * Error drop rules: filter expressions an owner sets (runtime setting `errorDropRules`, the Errors page's Drop rules).
 * POST /v1/errors runs each kept item through the rules right after parsing; an item any rule matches is dropped there
 * and never reaches the queue or the error tables (noise like failed asset / mesh loads). Drops are counted per rule in
 * memory (since the process started), for the page.
 *
 * An expression:
 *
 *   expr  := term (("or" | "and") term)*        "and" binds tighter than "or"
 *   term  := "not" term | "(" expr ")" | field op value
 *   field := message | stack | any | realm | branch | build | fp
 *   op    := contains | startswith | endswith | is | = | != | matches
 *   value := "text" | 'text' (\" \' \\ escapes) | /regex/ or /regex/i (only for matches)
 *
 * `message` is the templated message (player names already replaced), `stack` the sample stack, `any` either one.
 * Text comparisons ignore case; `is` / `=` compare the whole value, `!=` is its negation. Keywords ignore case too.
 *
 *   message contains "Failed to load mesh"
 *   (message contains "asset" or message contains "mesh") and realm = client
 *   any matches /Content failed to load|HTTP 4\d\d/i and not branch is "dev"
 *
 * Bounds keep the matching cheap on every ingest: 50 rules, 500 characters each, regexes of 200 characters without a
 * quantified group that is itself quantified (the classic catastrophic backtracking shape); messages are at most 1,000
 * characters and stacks 4,000 (parse.ts).
 */
import type { ErrorItem } from "./parse.ts";

export const DROP_RULES_MAX = 50;
export const DROP_EXPR_MAX = 500;
export const DROP_REGEX_MAX = 200;
export const DROP_NOTE_MAX = 120;

export const DROP_FIELDS = ["message", "stack", "any", "realm", "branch", "build", "fp"] as const;
export type DropField = (typeof DROP_FIELDS)[number];
const OPS = ["contains", "startswith", "endswith", "is", "=", "!=", "matches"] as const;
type Op = (typeof OPS)[number];

/** One saved rule. `id` is stable (the counters and the page use it). */
export interface ErrorDropRule {
	id: string;
	expr: string;
	note?: string;
	on: boolean;
}

/** The fields a rule looks at; an ErrorItem gives them, so does a stored error kind (the preview). */
export interface DropSubject {
	message: string;
	stack: string | null;
	realm: string;
	branch: string | null;
	build: string | null;
	fp: string;
}

type Node =
	| { t: "or" | "and"; a: Node; b: Node }
	| { t: "not"; a: Node }
	| { t: "cond"; field: DropField; op: Op; text?: string; re?: RegExp };

export class DropRuleError extends Error {
	override name = "DropRuleError";
}

type Token = { k: "word"; v: string; at: number } | { k: "str"; v: string; at: number } | { k: "re"; v: string; flags: string; at: number } | { k: "(" | ")"; at: number } | { k: "op"; v: "=" | "!="; at: number };

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "(" || c === ")") {
			out.push({ k: c, at: i });
			i++;
			continue;
		}
		if (c === "=" || (c === "!" && src[i + 1] === "=")) {
			out.push({ k: "op", v: c === "=" ? "=" : "!=", at: i });
			i += c === "=" ? (src[i + 1] === "=" ? 2 : 1) : 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const start = i;
			let v = "";
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === "\\" && i + 1 < src.length) {
					v += src[i + 1];
					i += 2;
				} else v += src[i++];
			}
			if (i >= src.length) throw new DropRuleError(`unclosed quote at character ${start + 1}`);
			i++;
			out.push({ k: "str", v, at: start });
			continue;
		}
		if (c === "/") {
			const start = i;
			let v = "";
			i++;
			while (i < src.length && src[i] !== "/") {
				if (src[i] === "\\" && i + 1 < src.length) {
					v += src[i] + (src[i + 1] as string);
					i += 2;
				} else v += src[i++];
			}
			if (i >= src.length) throw new DropRuleError(`unclosed /regex/ at character ${start + 1}`);
			i++;
			let flags = "";
			while (i < src.length && /[a-z]/i.test(src[i] as string)) flags += src[i++];
			out.push({ k: "re", v, flags, at: start });
			continue;
		}
		const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
		if (!m) throw new DropRuleError(`unexpected "${c}" at character ${i + 1}`);
		out.push({ k: "word", v: m[0].toLowerCase(), at: i });
		i += m[0].length;
	}
	return out;
}

/** A quantifier right after a group that itself holds one: (a+)+, (\w*)*, (x|y+){2,}. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?]/;

function compileRegex(source: string, flags: string): RegExp {
	if (source.length === 0) throw new DropRuleError("an empty /regex/");
	if (source.length > DROP_REGEX_MAX) throw new DropRuleError(`a /regex/ is at most ${DROP_REGEX_MAX} characters`);
	if (!/^i?$/.test(flags)) throw new DropRuleError(`regex flags: only i (got "${flags}")`);
	if (NESTED_QUANTIFIER.test(source)) throw new DropRuleError("a /regex/ may not repeat a group that repeats inside ((a+)+ and the like: slow on long messages)");
	try {
		return new RegExp(source, flags);
	} catch (error) {
		throw new DropRuleError(`bad /regex/: ${(error as Error).message.replace(/^Invalid regular expression: /, "")}`);
	}
}

class Parser {
	private i = 0;
	constructor(private readonly tokens: Token[]) {}

	parse(): Node {
		if (this.tokens.length === 0) throw new DropRuleError("an empty expression");
		const node = this.or();
		const extra = this.tokens[this.i];
		if (extra) throw new DropRuleError(`unexpected ${describe(extra)} at character ${extra.at + 1}: join conditions with and / or`);
		return node;
	}

	private peekWord(word: string): boolean {
		const t = this.tokens[this.i];
		return t?.k === "word" && t.v === word;
	}

	private or(): Node {
		let a = this.and();
		while (this.peekWord("or")) {
			this.i++;
			a = { t: "or", a, b: this.and() };
		}
		return a;
	}

	private and(): Node {
		let a = this.term();
		while (this.peekWord("and")) {
			this.i++;
			a = { t: "and", a, b: this.term() };
		}
		return a;
	}

	private term(): Node {
		const t = this.tokens[this.i];
		if (!t) throw new DropRuleError("the expression ends too early");
		if (t.k === "word" && t.v === "not") {
			this.i++;
			return { t: "not", a: this.term() };
		}
		if (t.k === "(") {
			this.i++;
			const inner = this.or();
			const close = this.tokens[this.i];
			if (close?.k !== ")") throw new DropRuleError(`missing ) for the ( at character ${t.at + 1}`);
			this.i++;
			return inner;
		}
		return this.cond();
	}

	private cond(): Node {
		const f = this.tokens[this.i++] as Token;
		if (f.k !== "word" || !(DROP_FIELDS as readonly string[]).includes(f.v)) throw new DropRuleError(`expected a field (${DROP_FIELDS.join(", ")}) at character ${f.at + 1}, got ${describe(f)}`);
		const o = this.tokens[this.i++];
		if (!o) throw new DropRuleError(`${f.v}: missing an operator (${OPS.join(", ")})`);
		const op = (o.k === "op" ? o.v : o.k === "word" ? o.v : "") as Op;
		if (!(OPS as readonly string[]).includes(op)) throw new DropRuleError(`expected an operator (${OPS.join(", ")}) at character ${o.at + 1}, got ${describe(o)}`);
		const v = this.tokens[this.i++];
		if (!v) throw new DropRuleError(`${f.v} ${op}: missing a value`);
		const field = f.v as DropField;
		if (op === "matches") {
			if (v.k !== "re") throw new DropRuleError(`matches takes a /regex/ (character ${v.at + 1})`);
			return { t: "cond", field, op, re: compileRegex(v.v, v.flags) };
		}
		if (v.k !== "str") throw new DropRuleError(`${op} takes a quoted "text" (character ${v.at + 1})${v.k === "re" ? ": use matches for a /regex/" : ""}`);
		return { t: "cond", field, op, text: v.v.toLowerCase() };
	}
}

function describe(t: Token): string {
	if (t.k === "word") return `"${t.v}"`;
	if (t.k === "str") return "a quoted text";
	if (t.k === "re") return "a /regex/";
	if (t.k === "op") return `"${t.v}"`;
	return `"${t.k}"`;
}

/** A compiled expression: test(subject) says whether it matches. Throws DropRuleError with a readable reason. */
export function compileDropExpr(expr: string): { test(s: DropSubject): boolean } {
	if (typeof expr !== "string" || expr.trim() === "") throw new DropRuleError("an empty expression");
	if (expr.length > DROP_EXPR_MAX) throw new DropRuleError(`an expression is at most ${DROP_EXPR_MAX} characters`);
	const tree = new Parser(tokenize(expr)).parse();
	return { test: (s) => evaluate(tree, s) };
}

function values(field: DropField, s: DropSubject): string[] {
	switch (field) {
		case "message":
			return [s.message];
		case "stack":
			return [s.stack ?? ""];
		case "any":
			return [s.message, s.stack ?? ""];
		case "realm":
			return [s.realm];
		case "branch":
			return [s.branch ?? ""];
		case "build":
			return [s.build ?? ""];
		case "fp":
			return [s.fp];
	}
}

function evaluate(n: Node, s: DropSubject): boolean {
	switch (n.t) {
		case "or":
			return evaluate(n.a, s) || evaluate(n.b, s);
		case "and":
			return evaluate(n.a, s) && evaluate(n.b, s);
		case "not":
			return !evaluate(n.a, s);
		case "cond": {
			const vs = values(n.field, s);
			if (n.op === "!=") return vs.every((v) => v.toLowerCase() !== n.text);
			return vs.some((raw) => {
				if (n.re) {
					n.re.lastIndex = 0;
					return n.re.test(raw);
				}
				const v = raw.toLowerCase();
				const t = n.text as string;
				return n.op === "contains" ? v.includes(t) : n.op === "startswith" ? v.startsWith(t) : n.op === "endswith" ? v.endsWith(t) : v === t;
			});
		}
	}
}

export const subjectOf = (item: ErrorItem): DropSubject => ({ message: item.template, stack: item.stack, realm: item.realm, branch: item.branch, build: item.build, fp: item.fp });

/** Checks a saved list strictly (the settings PATCH); returns it normalised. */
export function checkDropRules(raw: unknown): ErrorDropRule[] {
	if (!Array.isArray(raw)) throw new DropRuleError("errorDropRules is a list of { id, expr, note?, on }");
	if (raw.length > DROP_RULES_MAX) throw new DropRuleError(`at most ${DROP_RULES_MAX} drop rules`);
	const out: ErrorDropRule[] = [];
	const ids = new Set<string>();
	raw.forEach((r, index) => {
		const where = `rule ${index + 1}`;
		if (typeof r !== "object" || r === null || Array.isArray(r)) throw new DropRuleError(`${where} is { id, expr, note?, on }`);
		const rule = r as Record<string, unknown>;
		const id = typeof rule.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(rule.id) ? rule.id : undefined;
		if (!id) throw new DropRuleError(`${where}: id is 1-24 of A-Z a-z 0-9 _ -`);
		if (ids.has(id)) throw new DropRuleError(`${where}: the id ${id} is used twice`);
		ids.add(id);
		if (typeof rule.expr !== "string") throw new DropRuleError(`${where}: expr is a string`);
		try {
			compileDropExpr(rule.expr);
		} catch (error) {
			throw new DropRuleError(`${where}: ${(error as Error).message}`);
		}
		if (rule.note !== undefined && (typeof rule.note !== "string" || rule.note.length > DROP_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(rule.note))) throw new DropRuleError(`${where}: note is text up to ${DROP_NOTE_MAX} characters`);
		if (typeof rule.on !== "boolean") throw new DropRuleError(`${where}: on is true or false`);
		out.push({ id, expr: rule.expr.trim(), ...(rule.note ? { note: rule.note as string } : {}), on: rule.on });
	});
	return out;
}

export interface DropRuleCount {
	/** Items (error kinds as reported in a batch) and their occurrences (their `count`s). */
	items: number;
	occurrences: number;
	lastAt: number | null;
}

/**
 * The compiled rules and their counters. `set` swaps the list (compiled ones are kept by expression); `filter` takes a
 * batch's items and returns those no active rule matches, counting the rest on the first rule that matched.
 */
export class ErrorDropper {
	private rules: { rule: ErrorDropRule; test: (s: DropSubject) => boolean }[] = [];
	private readonly compiled = new Map<string, (s: DropSubject) => boolean>();
	private readonly counts = new Map<string, DropRuleCount>();
	readonly since: number;

	constructor(
		rules: ErrorDropRule[],
		private readonly clock: () => number = Date.now,
	) {
		this.since = clock();
		this.set(rules);
	}

	set(rules: ErrorDropRule[]): void {
		const next: typeof this.rules = [];
		for (const rule of rules) {
			let test = this.compiled.get(rule.expr);
			if (!test) {
				try {
					test = compileDropExpr(rule.expr).test;
				} catch {
					continue; // Saved rules were checked; an env one that doesn't parse is skipped (the page shows its error).
				}
				this.compiled.set(rule.expr, test);
			}
			next.push({ rule, test });
		}
		this.rules = next;
		for (const id of [...this.counts.keys()]) if (!rules.some((r) => r.id === id)) this.counts.delete(id);
		while (this.compiled.size > DROP_RULES_MAX * 2) this.compiled.delete(this.compiled.keys().next().value as string);
	}

	/** The rule that drops this subject, if any (only rules that are on). */
	match(s: DropSubject): ErrorDropRule | undefined {
		for (const r of this.rules) if (r.rule.on && r.test(s)) return r.rule;
		return undefined;
	}

	filter(items: ErrorItem[]): { kept: ErrorItem[]; dropped: number } {
		if (!this.rules.some((r) => r.rule.on)) return { kept: items, dropped: 0 };
		const kept: ErrorItem[] = [];
		let dropped = 0;
		const now = this.clock();
		for (const item of items) {
			const rule = this.match(subjectOf(item));
			if (!rule) {
				kept.push(item);
				continue;
			}
			dropped++;
			const c = this.counts.get(rule.id) ?? { items: 0, occurrences: 0, lastAt: null };
			c.items++;
			c.occurrences += item.count;
			c.lastAt = now;
			this.counts.set(rule.id, c);
		}
		return { kept, dropped };
	}

	stats(): Record<string, DropRuleCount> {
		return Object.fromEntries(this.counts);
	}
}
