/**
 * The recorded UI tree (plans/36 tt-ext-1, phase 4) at a moment of the replay, without React: which nodes are alive, their
 * fields merged up to that moment, the draw order, a readable path per node, and Roblox rich text as plain spans.
 *
 * Fields per node are folded once per `ui` array (a snapshot after each change, kept in a WeakMap), so a lookup at any
 * moment is a binary search per node: cheap enough to run every animation frame for a few thousand nodes.
 */
import type { ExtUiFields, ExtUiNode } from "@/lib/types";

export const UI_CLASS_NAMES = ["ScreenGui", "Frame", "TextLabel", "TextButton", "TextBox", "ImageLabel", "ImageButton", "ScrollingFrame", "ViewportFrame", "CanvasGroup", "VideoFrame"] as const;

export function uiClassName(cls: number): string {
	return UI_CLASS_NAMES[cls] ?? "Frame";
}

export const isTextClass = (cls: number) => cls === 2 || cls === 3 || cls === 4;
export const isImageClass = (cls: number) => cls === 5 || cls === 6;
/** ScrollingFrame and CanvasGroup always clip their descendants. */
export const alwaysClips = (cls: number) => cls === 7 || cls === 9;

export interface UiNodeState {
	i: number;
	cls: number;
	parent: number | null;
	/** Fields merged up to the moment (a change replaces a whole field). */
	fields: ExtUiFields;
}

interface Folded {
	node: ExtUiNode;
	/** Change times, ascending. */
	times: number[];
	/** states[0] = the node's first fields; states[k + 1] = after change k. */
	states: ExtUiFields[];
}

const folded = new WeakMap<readonly ExtUiNode[], { list: Folded[]; byI: Map<number, ExtUiNode> }>();

function fold(ui: readonly ExtUiNode[]): { list: Folded[]; byI: Map<number, ExtUiNode> } {
	const known = folded.get(ui);
	if (known) return known;
	const list: Folded[] = [];
	const byI = new Map<number, ExtUiNode>();
	for (const node of ui) {
		byI.set(node.i, node);
		const changes = [...(node.ch ?? [])].sort((a, b) => a[0] - b[0]);
		const times: number[] = [];
		const states: ExtUiFields[] = [node.f];
		let current = node.f;
		for (const [t, change] of changes) {
			current = { ...current, ...change };
			times.push(t);
			states.push(current);
		}
		list.push({ node, times, states });
	}
	const out = { list, byI };
	folded.set(ui, out);
	return out;
}

/** The last index with times[k] <= t, or -1. */
function lastAtOrBefore(times: readonly number[], t: number): number {
	let lo = 0;
	let hi = times.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((times[mid] as number) <= t) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

/** The fields of one node at `t` (its first fields before any change). */
export function fieldsAt(ui: readonly ExtUiNode[], i: number, t: number): ExtUiFields | null {
	const entry = fold(ui).list.find((f) => f.node.i === i);
	if (!entry) return null;
	return entry.states[lastAtOrBefore(entry.times, t) + 1] as ExtUiFields;
}

/** The nodes alive at `t` with their fields, in draw order: by their ScreenGui's DisplayOrder, the ScreenGui first, then `order`, then `i`. */
export function uiStateAt(ui: readonly ExtUiNode[], t: number): UiNodeState[] {
	const { list } = fold(ui);
	const alive = new Map<number, UiNodeState>();
	for (const entry of list) {
		const n = entry.node;
		if (n.from > t || (n.to !== null && t >= n.to)) continue;
		const fields = entry.states[lastAtOrBefore(entry.times, t) + 1] as ExtUiFields;
		const parent = fields.parent !== undefined ? fields.parent : n.parent;
		alive.set(n.i, { i: n.i, cls: n.cls, parent, fields });
	}
	const rootOf = new Map<number, UiNodeState>();
	const root = (s: UiNodeState): UiNodeState => {
		const known = rootOf.get(s.i);
		if (known) return known;
		let at = s;
		const seen = new Set<number>([at.i]);
		while (at.parent !== null) {
			const up = alive.get(at.parent);
			if (!up || seen.has(up.i)) break;
			seen.add(up.i);
			at = up;
		}
		rootOf.set(s.i, at);
		return at;
	};
	const out = [...alive.values()];
	const key = new Map<number, [number, number, number, number]>();
	for (const s of out) {
		const r = root(s);
		key.set(s.i, [r.fields.order ?? 0, r.i, s === r ? 0 : 1, s.fields.order ?? 0]);
	}
	return out.sort((a, b) => {
		const ka = key.get(a.i) as [number, number, number, number];
		const kb = key.get(b.i) as [number, number, number, number];
		for (let k = 0; k < 4; k++) if (ka[k] !== kb[k]) return (ka[k] as number) - (kb[k] as number);
		return a.i - b.i;
	});
}

/** A readable path: nodes have no names on the wire, so the class and the index among same-class siblings (1-based). */
export function uiPath(ui: readonly ExtUiNode[], i: number): string {
	const { byI } = fold(ui);
	const parts: string[] = [];
	const seen = new Set<number>();
	let node = byI.get(i);
	while (node && !seen.has(node.i)) {
		seen.add(node.i);
		const current = node;
		const siblings = ui.filter((n) => n.parent === current.parent && n.cls === current.cls).sort((a, b) => a.i - b.i);
		parts.unshift(`${uiClassName(current.cls)}[${siblings.findIndex((n) => n.i === current.i) + 1}]`);
		node = current.parent === null ? undefined : byI.get(current.parent);
	}
	return parts.join("/");
}

// Rich text ---------------------------------------------------------------------------------------------------------------

export interface RichSpan {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	color?: string;
	size?: number;
	face?: string;
	weight?: number;
	uppercase?: boolean;
	smallcaps?: boolean;
	/** A line break (<br />): text is "\n". */
	br?: boolean;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
	return text.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => ENTITIES[name] as string);
}

function attrs(source: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of source.matchAll(/([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? "";
	return out;
}

const WEIGHTS: Record<string, number> = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, heavy: 900 };

/** A CSS colour from a rich text colour: #rgb / #rrggbb or rgb(r, g, b); anything else is dropped. */
export function richColor(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const v = value.trim();
	if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v.toLowerCase();
	const m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(v);
	if (m) return `rgb(${[m[1], m[2], m[3]].map((c) => Math.min(255, Number(c))).join(", ")})`;
	return undefined;
}

type Style = Omit<RichSpan, "text" | "br">;

/** Roblox rich text as spans (plain data, never HTML): b, i, u, s, font, uppercase / uc, smallcaps / sc, br; other tags dropped, their text kept. */
export function richText(text: string): RichSpan[] {
	const spans: RichSpan[] = [];
	const stack: { tag: string; style: Style }[] = [];
	let style: Style = {};
	const push = (raw: string) => {
		if (!raw) return;
		const value = decodeEntities(raw);
		const last = spans[spans.length - 1];
		const { text: _t, br: _b, ...lastStyle } = last ?? { text: "" };
		if (last && !last.br && JSON.stringify(lastStyle) === JSON.stringify(style)) last.text += value;
		else spans.push({ text: value, ...style });
	};
	const re = /<\s*(\/)?\s*([a-zA-Z]+)([^<>]*?)(\/)?\s*>/g;
	let at = 0;
	for (const m of text.matchAll(re)) {
		push(text.slice(at, m.index));
		at = (m.index ?? 0) + m[0].length;
		const closing = m[1] === "/";
		const tag = (m[2] as string).toLowerCase();
		if (tag === "br") {
			spans.push({ text: "\n", br: true });
			continue;
		}
		if (closing) {
			const k = stack.map((s) => s.tag).lastIndexOf(tag);
			if (k >= 0) {
				style = (stack[k] as { style: Style }).style;
				stack.length = k;
			}
			continue;
		}
		if (m[4] === "/") continue;
		const next: Style = { ...style };
		if (tag === "b") next.bold = true;
		else if (tag === "i") next.italic = true;
		else if (tag === "u") next.underline = true;
		else if (tag === "s") next.strike = true;
		else if (tag === "uppercase" || tag === "uc") next.uppercase = true;
		else if (tag === "smallcaps" || tag === "sc") next.smallcaps = true;
		else if (tag === "font") {
			const a = attrs(m[3] ?? "");
			const color = richColor(a.color);
			if (color) next.color = color;
			const size = Number(a.size);
			if (a.size && Number.isFinite(size) && size > 0 && size < 500) next.size = size;
			if (a.face && /^[\w -]{1,64}$/.test(a.face)) next.face = a.face;
			if (a.family && !a.face) {
				const name = /([\w-]+)\.json$/i.exec(a.family)?.[1];
				if (name) next.face = name;
			}
			const weight = a.weight ? (WEIGHTS[a.weight.toLowerCase()] ?? Number(a.weight)) : undefined;
			if (weight && Number.isFinite(weight) && weight >= 100 && weight <= 900) next.weight = weight;
		}
		// anything else (stroke, mark, comment-like tags, unknown ones): kept on the stack so its closing tag pops it,
		// its text stays, nothing about it is drawn
		stack.push({ tag, style });
		style = next;
	}
	push(text.slice(at));
	return spans;
}

/** The text without rich text markup. */
export function stripRichText(text: string): string {
	return richText(text)
		.map((s) => s.text)
		.join("");
}
