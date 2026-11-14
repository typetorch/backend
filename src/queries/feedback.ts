/**
 * Player feedback (plans/32-feedback.md): the `feedback` kind's `submit` rows, plus CuceGame's older
 * `kind = 'custom', name = 'feedback'` rows mapped at query time (no migration): scale `legacy_faces5`, type `scale`,
 * steps 5, r = props.rating, norm = (r - 1) / 4, label BAD / MEH / OK / GOOD / GREAT, text = props.text,
 * len = props.length. Those rows answer with `legacy: true`.
 *
 *   feedback-summary  totals (count, with text, players, rated, legacy), one distribution per scale (its type, steps,
 *                     the labels seen, a count per r, text-only, average r and norm), the thumbs-up share, and a trend
 *                     (count and average norm per hour when the range is 2 days or less, else per UTC day)
 *   feedback-list     newest first, `limit` (1..200, default 50) + `offset` (0..5000), with `total` and `more`;
 *                     options `pid`, `scale`, `r`, `hasText`, `q` (a case-insensitive substring of the text)
 *
 * Every filter of the filter bar applies (the rows carry dev, art, branch, place like any player row), so the device
 * filter is the filters' `dev`. A resent copy of a row is an exact duplicate (no row id exists): DISTINCT on the row.
 * Numbers are read with jsonNumber (Basin's json_get_str skips JSON numbers); `ctx`, `topic`, `label` and `play_s`
 * come from the props text, parsed in `shape`.
 */
import { assertSafeKey, DAY_MS } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { checkPid, defineQuery, eventsTable, int, intOption, iso, isoDay, lit, num, round, str, where, type QueryContext, type Row } from "./core.ts";

export const LEGACY_SCALE = "legacy_faces5";
export const LEGACY_LABELS = ["BAD", "MEH", "OK", "GOOD", "GREAT"] as const;
export const FEEDBACK_TYPES = ["thumbs", "stars", "scale"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
/** Ranges up to this long trend per hour; longer ones per UTC day. */
export const HOURLY_MAX_MS = 2 * DAY_MS;
export const FEEDBACK_LIST_MAX = 200;
export const FEEDBACK_OFFSET_MAX = 5000;
/** The text search: at most this many characters. */
export const SEARCH_MAX = 100;
const HOUR_MS = 3_600_000;
/** At most this many trend buckets are filled in (a 400-day range per day). */
const TREND_MAX = 1000;
/** Distribution groups read (scales x steps x labels). */
const DIST_MAX = 2000;

/**
 * `fb`: the distinct feedback rows of the range and filters; `m`: their mapped columns (legacy 0/1, scale, type, steps,
 * r, norm, text (NULL when empty), len, label).
 */
function feedbackCtes(ctx: QueryContext, f: NormalizedFilters): string {
	const d = ctx.dialect;
	const rating = d.jsonNumber("props", "rating");
	const legacyR = `CASE WHEN ${rating} IN (1, 2, 3, 4, 5) THEN CAST(${rating} AS BIGINT) END`;
	const isLegacy = "kind = 'custom'";
	return (
		`fb AS (SELECT DISTINCT e.t AS t, e.pid AS pid, e.sid AS sid, e.dev AS dev, e.state AS state, e.kind AS kind, e.props AS props FROM ${eventsTable(ctx, f)} e ` +
		`WHERE ${where(f, ctx)} AND ((e.kind = 'feedback' AND e.name = 'submit') OR (e.kind = 'custom' AND e.name = 'feedback'))), ` +
		`m AS (SELECT t, COALESCE(pid, '') AS pid, COALESCE(sid, '') AS sid, dev, state, props, ` +
		`CASE WHEN ${isLegacy} THEN 1 ELSE 0 END AS legacy, ` +
		`CASE WHEN ${isLegacy} THEN ${lit(LEGACY_SCALE)} ELSE COALESCE(${d.jsonText("props", "scale")}, '') END AS scale, ` +
		`CASE WHEN ${isLegacy} THEN 'scale' ELSE COALESCE(${d.jsonText("props", "type")}, '') END AS type, ` +
		`CASE WHEN ${isLegacy} THEN 5 ELSE CAST(${d.jsonNumber("props", "steps")} AS BIGINT) END AS steps, ` +
		`CASE WHEN ${isLegacy} THEN ${legacyR} ELSE CAST(${d.jsonNumber("props", "r")} AS BIGINT) END AS r, ` +
		`CASE WHEN ${isLegacy} THEN (${legacyR} - 1) / 4.0 ELSE ${d.jsonNumber("props", "norm")} END AS norm, ` +
		`NULLIF(${d.jsonText("props", "text")}, '') AS text, ` +
		`COALESCE(CAST(CASE WHEN ${isLegacy} THEN ${d.jsonNumber("props", "length")} ELSE ${d.jsonNumber("props", "len")} END AS BIGINT), 0) AS len, ` +
		`CASE WHEN ${isLegacy} THEN NULL ELSE ${d.jsonText("props", "label")} END AS label ` +
		`FROM fb)`
	);
}

function propsObject(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || !raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const intOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Math.round(num(v)));
const numOrNullRounded = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : round(num(v), 4));

/** A step's label: the legacy faces, else the row's own label. */
function labelOf(legacy: boolean, r: number | null, label: unknown): string | null {
	if (legacy) return r !== null && r >= 1 && r <= 5 ? LEGACY_LABELS[r - 1] : null;
	return typeof label === "string" && label ? label : null;
}

// feedback-summary --------------------------------------------------------------------------------------------------

export interface FeedbackScaleSummary {
	/** The scale's id (`legacy_faces5` for the mapped custom rows). */
	scale: string;
	type: string;
	steps: number;
	legacy: boolean;
	/** Rows of this scale (rated + text-only). */
	n: number;
	/** Rated rows. */
	rated: number;
	/** Rows without a rating (text only). */
	textOnly: number;
	/** Count per r, every step listed (thumbs 0 / 1, else 1..steps; plus any r seen outside them). */
	counts: { r: number; label: string | null; n: number }[];
	/** The labels seen, by r. */
	labels: Record<string, string>;
	avgR: number | null;
	avgNorm: number | null;
	firstAt: string | null;
	lastAt: string | null;
}

export interface FeedbackTrendPoint {
	/** The bucket's start: an ISO time (hours) or a date (days). */
	at: string;
	t: number;
	n: number;
	rated: number;
	withText: number;
	/** Average norm (0..1) of the bucket's rated rows, across scales; null when none. */
	avgNorm: number | null;
}

export interface FeedbackSummaryResult {
	from: string;
	to: string;
	total: number;
	withText: number;
	players: number;
	rated: number;
	legacy: number;
	avgNorm: number | null;
	scales: FeedbackScaleSummary[];
	/** Over every thumbs scale: up / (up + down); null without thumbs rows. */
	thumbs: { up: number; down: number; upShare: number } | null;
	bucket: "hour" | "day";
	trend: FeedbackTrendPoint[];
}

export const feedbackSummary = defineQuery<Record<string, never>, FeedbackSummaryResult>({
	name: "feedback-summary",
	summary: "player feedback: totals, the distribution per scale (labels, counts per rating, averages), the thumbs-up share and a trend of count and average norm (feedback rows + legacy custom/feedback)",
	defaultDays: 30,
	options: () => ({}),
	statements(ctx, f) {
		const d = ctx.dialect;
		const hourly = f.to - f.from <= HOURLY_MAX_MS;
		const bucket = hourly ? HOUR_MS : DAY_MS;
		const w = `WITH ${feedbackCtes(ctx, f)} `;
		return {
			totals: `${w}SELECT COUNT(*) AS n, COUNT(text) AS with_text, COUNT(DISTINCT CASE WHEN pid <> '' THEN pid END) AS players, COUNT(r) AS rated, SUM(legacy) AS legacy, AVG(norm) AS avg_norm FROM m ${d.limit(1)}`,
			dist:
				`${w}SELECT scale, type, steps, legacy, r, label, COUNT(*) AS n, SUM(norm) AS sum_norm, COUNT(norm) AS n_norm, MIN(t) AS t0, MAX(t) AS t1 FROM m ` +
				`GROUP BY scale, type, steps, legacy, r, label ORDER BY scale, type, steps, r ${d.limit(DIST_MAX)}`,
			trend:
				`${w}SELECT CAST(floor(t / ${int(bucket)}.0) AS BIGINT) AS b, COUNT(*) AS n, COUNT(norm) AS rated, COUNT(text) AS with_text, AVG(norm) AS avg_norm FROM m ` +
				`GROUP BY CAST(floor(t / ${int(bucket)}.0) AS BIGINT) ORDER BY b ${d.limit(TREND_MAX * 2)}`,
		};
	},
	shape(rows, _ctx, f) {
		const t = rows.totals?.[0] ?? {};
		const scales = new Map<string, FeedbackScaleSummary & { sumR: number; sumNorm: number; nNorm: number; t0: number; t1: number }>();
		for (const row of rows.dist ?? []) {
			const legacy = num(row.legacy) === 1;
			const scale = str(row.scale);
			const type = str(row.type);
			const steps = Math.round(num(row.steps));
			const key = `${scale}\u0000${type}\u0000${steps}`;
			let s = scales.get(key);
			if (!s) {
				s = { scale, type, steps, legacy, n: 0, rated: 0, textOnly: 0, counts: [], labels: {}, avgR: null, avgNorm: null, firstAt: null, lastAt: null, sumR: 0, sumNorm: 0, nNorm: 0, t0: Infinity, t1: -Infinity };
				scales.set(key, s);
			}
			const n = num(row.n);
			const r = intOrNull(row.r);
			s.n += n;
			s.t0 = Math.min(s.t0, num(row.t0));
			s.t1 = Math.max(s.t1, num(row.t1));
			s.sumNorm += num(row.sum_norm);
			s.nNorm += num(row.n_norm);
			if (r === null) {
				s.textOnly += n;
				continue;
			}
			s.rated += n;
			s.sumR += r * n;
			const label = labelOf(legacy, r, row.label);
			if (label && !s.labels[r]) s.labels[r] = label;
			const at = s.counts.find((c) => c.r === r);
			if (at) at.n += n;
			else s.counts.push({ r, label: null, n });
		}
		const list: FeedbackScaleSummary[] = [];
		for (const s of scales.values()) {
			// Every step of the scale, so the histogram keeps its shape when a step got no votes.
			const first = s.type === "thumbs" ? 0 : 1;
			const last = s.type === "thumbs" ? 1 : Math.min(Math.max(s.steps, 1), 10);
			for (let r = first; r <= last; r++) if (!s.counts.some((c) => c.r === r)) s.counts.push({ r, label: null, n: 0 });
			s.counts.sort((a, b) => a.r - b.r);
			for (const c of s.counts) c.label = s.labels[c.r] ?? (s.legacy && c.r >= 1 && c.r <= 5 ? LEGACY_LABELS[c.r - 1] : null);
			const { sumR, sumNorm, nNorm, t0, t1, ...out } = s;
			list.push({
				...out,
				avgR: s.rated ? round(sumR / s.rated, 3) : null,
				avgNorm: nNorm ? round(sumNorm / nNorm, 4) : null,
				firstAt: Number.isFinite(t0) ? iso(t0) : null,
				lastAt: Number.isFinite(t1) ? iso(t1) : null,
			});
		}
		// The newest scale first (a scale change shows the current one on top).
		list.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.scale.localeCompare(b.scale));
		const thumbRows = list.filter((s) => s.type === "thumbs");
		const up = thumbRows.reduce((a, s) => a + (s.counts.find((c) => c.r === 1)?.n ?? 0), 0);
		const down = thumbRows.reduce((a, s) => a + (s.counts.find((c) => c.r === 0)?.n ?? 0), 0);

		const hourly = f.to - f.from <= HOURLY_MAX_MS;
		const bucket = hourly ? HOUR_MS : DAY_MS;
		const byBucket = new Map<number, Row>();
		for (const row of rows.trend ?? []) byBucket.set(num(row.b), row);
		const trend: FeedbackTrendPoint[] = [];
		const firstB = Math.floor(f.from / bucket);
		const lastB = Math.floor((f.to - 1) / bucket);
		const start = Math.max(firstB, lastB - TREND_MAX + 1);
		for (let b = start; b <= lastB; b++) {
			const row = byBucket.get(b);
			const avg = row?.avg_norm;
			trend.push({
				at: hourly ? iso(b * bucket) : isoDay(b),
				t: b * bucket,
				n: num(row?.n),
				rated: num(row?.rated),
				withText: num(row?.with_text),
				avgNorm: avg === null || avg === undefined ? null : round(num(avg), 4),
			});
		}
		return {
			from: iso(f.from),
			to: iso(f.to),
			total: num(t.n),
			withText: num(t.with_text),
			players: num(t.players),
			rated: num(t.rated),
			legacy: num(t.legacy),
			avgNorm: t.avg_norm === null || t.avg_norm === undefined ? null : round(num(t.avg_norm), 4),
			scales: list,
			thumbs: up + down ? { up, down, upShare: round(up / (up + down), 4) } : null,
			bucket: hourly ? "hour" : "day",
			trend,
		};
	},
});

// feedback-list -----------------------------------------------------------------------------------------------------

export interface FeedbackListOptions {
	limit: number;
	offset: number;
	pid?: string;
	scale?: string;
	r?: number;
	hasText?: boolean;
	/** A case-insensitive substring of the text. */
	q?: string;
}

export interface FeedbackRow {
	t: number;
	at: string;
	pid: string;
	sid: string;
	dev: string | null;
	state: string | null;
	scale: string;
	type: string;
	steps: number;
	r: number | null;
	norm: number | null;
	label: string | null;
	text: string | null;
	/** The original text length in characters (0 = no text). */
	len: number;
	topic: string | null;
	ctx: Record<string, string | number | boolean> | null;
	play_s: number | null;
	/** A mapped `custom/feedback` row. */
	legacy: boolean;
	/** Joined in by the server from `identities` (never stored on the row). */
	uid?: number;
	name?: string;
	displayName?: string;
}

export interface FeedbackListResult {
	total: number;
	offset: number;
	more: boolean;
	rows: FeedbackRow[];
}

function boolOption(value: unknown, name: string): boolean | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === true || value === "true" || value === 1 || value === "1") return true;
	if (value === false || value === "false" || value === 0 || value === "0") return false;
	throw new Error(`${name} must be true or false`);
}

function listOptions(input: Partial<FeedbackListOptions> = {}): FeedbackListOptions {
	const out: FeedbackListOptions = {
		limit: intOption(input.limit, "limit", 50, 1, FEEDBACK_LIST_MAX),
		offset: intOption(input.offset, "offset", 0, 0, FEEDBACK_OFFSET_MAX),
	};
	if (input.pid !== undefined && input.pid !== "") out.pid = checkPid(input.pid);
	if (input.scale !== undefined && input.scale !== "") {
		if (typeof input.scale !== "string") throw new Error("scale must be a scale id");
		out.scale = assertSafeKey(input.scale, "scale");
	}
	if (input.r !== undefined && input.r !== null && (input.r as unknown) !== "") out.r = intOption(input.r, "r", 0, 0, 10);
	const hasText = boolOption(input.hasText, "hasText");
	if (hasText !== undefined) out.hasText = hasText;
	if (input.q !== undefined && input.q !== null && input.q !== "") {
		if (typeof input.q !== "string") throw new Error("q must be text");
		const q = input.q.trim();
		if (q.length > SEARCH_MAX) throw new Error(`q is at most ${SEARCH_MAX} characters`);
		if (/[\p{Cc}]/u.test(q)) throw new Error("q must not hold control characters");
		if (q) out.q = q;
	}
	return out;
}

/** The list's own filters on the mapped rows. */
function listWhere(o: FeedbackListOptions): string {
	const parts: string[] = [];
	if (o.pid) parts.push(`pid = ${lit(o.pid)}`);
	if (o.scale) parts.push(`scale = ${lit(o.scale)}`);
	if (o.r !== undefined) parts.push(`r = ${int(o.r)}`);
	if (o.hasText === true) parts.push("text IS NOT NULL");
	if (o.hasText === false) parts.push("text IS NULL");
	// strpos on lower(): a plain substring (no LIKE wildcards to escape), the needle a quoted literal.
	if (o.q) parts.push(`strpos(lower(text), ${lit(o.q.toLowerCase())}) > 0`);
	return parts.length ? parts.join(" AND ") : "TRUE";
}

function ctxObject(value: unknown): Record<string, string | number | boolean> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const out: Record<string, string | number | boolean> = {};
	let n = 0;
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (n >= 8 || !/^[a-z0-9_]{1,24}$/.test(k)) continue;
		if (typeof v === "string") out[k] = v.slice(0, 64);
		else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		else if (typeof v === "boolean") out[k] = v;
		else continue;
		n++;
	}
	return n ? out : null;
}

export const feedbackList = defineQuery<FeedbackListOptions, FeedbackListResult>({
	name: "feedback-list",
	summary: "player feedback rows, newest first (limit / offset; options pid, scale, r, hasText, q = a text search), feedback rows + legacy custom/feedback",
	defaultDays: 30,
	options: listOptions,
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const w = `WITH ${feedbackCtes(ctx, f)} `;
		const cond = listWhere(o);
		return {
			// The page through ROW_NUMBER (both engines), so the statement still ends in its LIMIT.
			rows:
				`${w}SELECT t, pid, sid, dev, state, legacy, scale, type, steps, r, norm, text, len, label, props FROM (` +
				`SELECT m.*, ROW_NUMBER() OVER (ORDER BY t DESC, pid, sid, props) AS rn FROM m WHERE ${cond}) x ` +
				`WHERE rn > ${int(o.offset)} ORDER BY rn ${d.limit(o.limit + 1)}`,
			total: `${w}SELECT COUNT(*) AS n FROM m WHERE ${cond} ${d.limit(1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const list = rows.rows ?? [];
		const total = num(rows.total?.[0]?.n);
		return {
			total,
			offset: o.offset,
			more: list.length > o.limit,
			rows: list.slice(0, o.limit).map((row) => {
				const legacy = num(row.legacy) === 1;
				const props = propsObject(row.props);
				const r = intOrNull(row.r);
				const topic = !legacy && typeof props.topic === "string" && props.topic ? props.topic : null;
				const play = !legacy && typeof props.play_s === "number" && Number.isFinite(props.play_s) ? Math.round(props.play_s) : null;
				return {
					t: num(row.t),
					at: iso(num(row.t)),
					pid: str(row.pid),
					sid: str(row.sid),
					dev: row.dev === null || row.dev === undefined || row.dev === "" ? null : str(row.dev),
					state: row.state === null || row.state === undefined || row.state === "" ? null : str(row.state),
					scale: str(row.scale),
					type: str(row.type),
					steps: Math.round(num(row.steps)),
					r,
					norm: numOrNullRounded(row.norm),
					label: labelOf(legacy, r, row.label),
					text: row.text === null || row.text === undefined || row.text === "" ? null : str(row.text),
					len: Math.max(0, Math.round(num(row.len))),
					topic,
					ctx: legacy ? null : ctxObject(props.ctx),
					play_s: play,
					legacy,
				};
			}),
		};
	},
});
