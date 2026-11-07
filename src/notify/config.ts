/**
 * The pushed notification config (`typetorch.json` -> `notifications`, plans/29-contract.md "Config"): validated here
 * (the authoritative check; the CLI runs a copy before pushing), stored in notify.db by PUT /v1/notify/config.
 */
import { KIND_PATTERN } from "./token.ts";

export const REPEATS = ["once_ever", "per_key", "daily"] as const;
export type Repeat = (typeof REPEATS)[number];
export const SEND_MODES = ["asap", "preferred_hour"] as const;
export type SendMode = (typeof SEND_MODES)[number];
/** Reserved: the kind of one-off sends (POST /v1/notify/send). */
export const CUSTOM_KIND = "custom";
export const KINDS_MAX = 64;
export const CONFIG_BODY_MAX = 64 * 1024;

export interface KindConfig {
	/** The template's text (<= 99 chars, `{placeholder}`s), pushed so the backend can check a want's params against it. */
	text?: string;
	template?: string;
	priority: number;
	repeat: Repeat;
	send: SendMode;
	perWeek?: number;
	maxWaitHours?: number;
	category?: string;
	allowTemplate?: boolean;
	beats?: { kinds: string[]; withinHours: number };
}

export interface NotifyConfig {
	dailyCap: number;
	quietAfterLeaveMinutes: number;
	/** [days since last seen, max sends per week], ascending; past the last entry nothing is sent. */
	lapse: [number, number][];
	unopenedBackoff: { after: number; factor: number; days: number };
	kinds: Record<string, KindConfig>;
}

export class ConfigError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, name: string, min: number, max: number): number => {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
	return v;
};
/** A message id: 1-128 characters, no control characters (Roblox's ids are printable). */
export const TEMPLATE = /^[^\0-\x1f\x7f]{1,128}$/;
/** Roblox's analytics category: any non-empty text (bounded). */
const CATEGORY = /^[^\0-\x1f\x7f]{1,1024}$/;
/** A param / placeholder name (contract: dashes too, Roblox templates use `{user-streak-remaining}`). */
export const PARAM_NAME = /^[a-zA-Z0-9_-]{1,32}$/;
export const TEXT_MAX = 99;

/** Why a template text is wrong (too long, an odd brace, a bad placeholder name), or undefined. */
export function textProblem(text: string): string | undefined {
	if ([...text].length > TEXT_MAX) return `at most ${TEXT_MAX} characters`;
	if (/[\0-\x1f\x7f]/.test(text)) return "no control characters";
	let rest = text;
	for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
		if (!PARAM_NAME.test(m[1] as string)) return `placeholder names are ${PARAM_NAME.source}`;
		rest = rest.replace(m[0], "");
	}
	if (/[{}]/.test(rest)) return "an unbalanced { or }";
	return undefined;
}

/** The placeholders of a template text, in order, without repeats. */
export function placeholders(text: string): string[] {
	return [...new Set([...text.matchAll(/\{([a-zA-Z0-9_-]{1,32})\}/g)].map((m) => m[1] as string))];
}

/** A positive number of hours (fractions allowed), at most ~100 years. */
const hours = (v: unknown, name: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 876_000) throw new ConfigError(`${name} must be a number of hours above 0`);
	return v;
};

export const DEFAULTS = {
	dailyCap: 1,
	quietAfterLeaveMinutes: 120,
	lapse: [
		[14, 7],
		[30, 2],
		[60, 1],
	] as [number, number][],
	unopenedBackoff: { after: 5, factor: 0.5, days: 14 },
};

function kind(name: string, raw: unknown): KindConfig {
	if (!isRecord(raw)) throw new ConfigError(`kinds.${name} must be an object`);
	const known = new Set(["text", "template", "priority", "repeat", "send", "perWeek", "maxWaitHours", "category", "allowTemplate", "beats"]);
	for (const key of Object.keys(raw)) if (!known.has(key)) throw new ConfigError(`kinds.${name}: unknown field ${/^[A-Za-z]{1,32}$/.test(key) ? key : "(a field name)"}`);
	const out: KindConfig = {
		priority: int(raw.priority ?? 100, `kinds.${name}.priority`, 0, 1000),
		repeat: (() => {
			if (!REPEATS.includes(raw.repeat as Repeat)) throw new ConfigError(`kinds.${name}.repeat is one of ${REPEATS.join(", ")}`);
			return raw.repeat as Repeat;
		})(),
		send: (() => {
			const s = raw.send ?? "preferred_hour";
			if (!SEND_MODES.includes(s as SendMode)) throw new ConfigError(`kinds.${name}.send is one of ${SEND_MODES.join(", ")}`);
			return s as SendMode;
		})(),
	};
	if (raw.text !== undefined && raw.text !== null && raw.text !== "") {
		if (typeof raw.text !== "string") throw new ConfigError(`kinds.${name}.text is the template's text`);
		const problem = textProblem(raw.text);
		if (problem) throw new ConfigError(`kinds.${name}.text: ${problem}`);
		out.text = raw.text;
	}
	if (raw.template !== undefined && raw.template !== null && raw.template !== "") {
		if (typeof raw.template !== "string" || !TEMPLATE.test(raw.template)) throw new ConfigError(`kinds.${name}.template is a message id of at most 128 characters`);
		out.template = raw.template;
	}
	if (raw.perWeek !== undefined) out.perWeek = int(raw.perWeek, `kinds.${name}.perWeek`, 1, 7);
	if (raw.maxWaitHours !== undefined) out.maxWaitHours = hours(raw.maxWaitHours, `kinds.${name}.maxWaitHours`);
	if (raw.category !== undefined) {
		if (typeof raw.category !== "string" || !CATEGORY.test(raw.category)) throw new ConfigError(`kinds.${name}.category is a non-empty string`);
		out.category = raw.category;
	}
	if (raw.allowTemplate !== undefined) {
		if (typeof raw.allowTemplate !== "boolean") throw new ConfigError(`kinds.${name}.allowTemplate is true or false`);
		if (raw.allowTemplate) out.allowTemplate = true;
	}
	if (raw.beats !== undefined) {
		const b = raw.beats;
		if (!isRecord(b) || !Array.isArray(b.kinds) || b.kinds.length === 0 || b.kinds.length > KINDS_MAX) throw new ConfigError(`kinds.${name}.beats is { kinds: [names], withinHours }`);
		for (const k of b.kinds) if (typeof k !== "string" || !KIND_PATTERN.test(k)) throw new ConfigError(`kinds.${name}.beats.kinds holds kind names`);
		out.beats = { kinds: [...new Set(b.kinds as string[])], withinHours: hours(b.withinHours, `kinds.${name}.beats.withinHours`) };
	}
	return out;
}

/** Validates the `notifications` object; returns it normalised (defaults filled in). Throws ConfigError. */
export function validateConfig(raw: unknown): NotifyConfig {
	if (!isRecord(raw)) throw new ConfigError("send the notifications object: { dailyCap, quietAfterLeaveMinutes, lapse, unopenedBackoff, kinds }");
	const dailyCap = int(raw.dailyCap ?? DEFAULTS.dailyCap, "dailyCap", 1, 3);
	const quietAfterLeaveMinutes = int(raw.quietAfterLeaveMinutes ?? DEFAULTS.quietAfterLeaveMinutes, "quietAfterLeaveMinutes", 0, 1_000_000);
	let lapse = DEFAULTS.lapse;
	if (raw.lapse !== undefined) {
		if (!Array.isArray(raw.lapse) || raw.lapse.length === 0 || raw.lapse.length > 64) throw new ConfigError("lapse is a list of [days, perWeek] pairs");
		lapse = raw.lapse.map((pair, i) => {
			if (!Array.isArray(pair) || pair.length !== 2) throw new ConfigError(`lapse[${i}] is [days, perWeek]`);
			return [int(pair[0], `lapse[${i}][0]`, 0, 1_000_000), int(pair[1], `lapse[${i}][1]`, 0, 7)] as [number, number];
		});
		for (let i = 1; i < lapse.length; i++) if ((lapse[i] as [number, number])[0] <= (lapse[i - 1] as [number, number])[0]) throw new ConfigError("lapse days must be ascending");
	}
	let unopenedBackoff = DEFAULTS.unopenedBackoff;
	if (raw.unopenedBackoff !== undefined) {
		const u = raw.unopenedBackoff;
		if (!isRecord(u)) throw new ConfigError("unopenedBackoff is { after, factor, days }");
		const factor = u.factor ?? DEFAULTS.unopenedBackoff.factor;
		if (typeof factor !== "number" || !(factor > 0) || factor > 1) throw new ConfigError("unopenedBackoff.factor is a number above 0, at most 1");
		unopenedBackoff = { after: int(u.after ?? DEFAULTS.unopenedBackoff.after, "unopenedBackoff.after", 1, 1_000_000), factor, days: int(u.days ?? DEFAULTS.unopenedBackoff.days, "unopenedBackoff.days", 1, 365) };
	}
	if (!isRecord(raw.kinds)) throw new ConfigError("kinds is an object of kind name -> { template, priority, repeat, ... }");
	const names = Object.keys(raw.kinds);
	if (names.length > KINDS_MAX) throw new ConfigError(`at most ${KINDS_MAX} kinds`);
	const kinds: Record<string, KindConfig> = {};
	for (const name of names) {
		if (!KIND_PATTERN.test(name)) throw new ConfigError("kind names are 1-24 of a-z 0-9 _");
		if (name === CUSTOM_KIND) throw new ConfigError(`"${CUSTOM_KIND}" is reserved (one-off sends)`);
		kinds[name] = kind(name, raw.kinds[name]);
	}
	return { dailyCap, quietAfterLeaveMinutes, lapse, unopenedBackoff, kinds };
}
