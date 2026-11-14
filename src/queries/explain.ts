/**
 * "Explain this change": a metric in two windows (current = the filter range, baseline = the same length right before
 * it unless given), broken down by segment, with a shift-share split of the change.
 *
 * Every player belongs to one segment per dimension and window, the way `demographics` does it: the highest value
 * their rows in that window carry (join props for country, language, account age, Premium and join source; the row
 * columns for device, build and branch; `new` when one of their sessions in the window was their first-ever).
 * Players without a join in the window (a session that started before it) fall in the `null` segment ("not sent").
 *
 * Two kinds of metric:
 *   - ratios (playtime per player, D1, payer conversion, ...): R = sum(num) / sum(den) over the population, so
 *     R = sum_i s_i * r_i with s_i = den_i / den (the segment's share) and r_i = num_i / den_i (its own value). The change
 *     splits exactly into, per segment,
 *       rate effect = (r1_i - r0_i) * (s0_i + s1_i) / 2                 (the segment itself got better or worse)
 *       mix effect  = (s1_i - s0_i) * ((r0_i + r1_i) / 2 - (R0 + R1) / 2) (its share of players changed; a bigger share
 *                                                                          only helps when it is above average)
 *     A segment missing from one window takes its value from the other (no rate effect; all mix). The rate and mix
 *     effects of all segments add up to R1 - R0 (the mix effects' average term cancels: the shares sum to 1 both times).
 *   - counts (players, new players, sessions, ...): V = sum(num) * scale; a segment's contribution is its own change,
 *     reported as the rate effect (mix = 0).
 * Segments are ranked by |rate + mix| and cut to `top`; the rest fold into one `other` row (effects summed, so the
 * totals stay exact).
 */
import { PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import { normalizeFilters, whereSql, type NormalizedFilters } from "../sql/filters.ts";
import { shareOption } from "./benchmarks.ts";
import { NOT_STUDIO, SERVER_PURCHASE, dayOf, defineQuery, int, intOption, iso, lit, num, round, sessionDaysCte, str, type QueryContext } from "./core.ts";

export const EXPLAIN_DIMENSIONS = ["device", "country", "language", "accountAge", "premium", "source", "build", "branch", "playerType"] as const;
export type ExplainDimension = (typeof EXPLAIN_DIMENSIONS)[number];

export const EXPLAIN_METRICS = [
	"players",
	"dau",
	"newPlayers",
	"returningPlayers",
	"sessions",
	"playtime",
	"playtimePerPlayer",
	"sessionsPerPlayer",
	"avgSession",
	"d1",
	"payerConversion",
	"robuxPerPlayer",
	"revenuePerPlayer",
] as const;
export type ExplainMetric = (typeof EXPLAIN_METRICS)[number];

type Family = "sessions" | "d1" | "money";

/** What each metric is: its family (which CTEs it needs), ratio or count, and its unit. */
export const METRIC_INFO: Record<ExplainMetric, { kind: "ratio" | "count"; family: Family; unit: "players" | "sessions" | "hours" | "minutes" | "share" | "robux" | "number" }> = {
	players: { kind: "count", family: "sessions", unit: "players" },
	dau: { kind: "count", family: "sessions", unit: "players" },
	newPlayers: { kind: "count", family: "sessions", unit: "players" },
	returningPlayers: { kind: "count", family: "sessions", unit: "players" },
	sessions: { kind: "count", family: "sessions", unit: "sessions" },
	playtime: { kind: "count", family: "sessions", unit: "hours" },
	playtimePerPlayer: { kind: "ratio", family: "sessions", unit: "minutes" },
	sessionsPerPlayer: { kind: "ratio", family: "sessions", unit: "number" },
	avgSession: { kind: "ratio", family: "sessions", unit: "minutes" },
	d1: { kind: "ratio", family: "d1", unit: "share" },
	payerConversion: { kind: "ratio", family: "money", unit: "share" },
	robuxPerPlayer: { kind: "ratio", family: "money", unit: "robux" },
	revenuePerPlayer: { kind: "ratio", family: "money", unit: "robux" },
};

export interface ExplainWithin {
	dimension: ExplainDimension;
	/** The segment's value; null = the "not sent" segment. */
	value: string | null;
}

export interface ExplainOptions {
	metric: ExplainMetric;
	/** One dimension, or every one ("all", the default). */
	dimension: ExplainDimension | "all";
	/** The baseline window (unix ms); undefined = the same length right before the filter range. */
	baseline?: { from: number; to: number };
	/** Only the players of one segment (the drill-down: that segment split by the other dimensions). */
	within?: ExplainWithin;
	/** Segments kept per dimension before the rest fold into `other` (default 8, at most 20). */
	top: number;
	/** A segment with fewer players than this in either window is flagged `small` (default 30). */
	minPlayers: number;
	robuxKey: string;
	/** revenuePerPlayer: the share of the price the creator keeps (default 0.7). */
	creatorShare: number;
}

export interface ExplainWindow {
	from: string;
	to: string;
	/** The metric over the whole population. */
	value: number;
	/** Players in the population (for D1 the cohort whose day 1 is over; for new players the new players). */
	players: number;
}

export interface ExplainSegment {
	/** The segment's value (a device, a country code, a build id, "new" / "returning", ...); null = not sent. */
	value: string | null;
	/** true for the folded rest. */
	other?: true;
	/** How many segments the `other` row holds. */
	segments?: number;
	baseline: { players: number; value: number | null; share: number };
	current: { players: number; value: number | null; share: number };
	/** Its part of the change, in the metric's unit (rate + mix). */
	contribution: number;
	rate: number;
	mix: number;
	/** contribution / the total change (null when the total didn't move). */
	shareOfChange: number | null;
	/** Fewer than minPlayers players in one of the windows: shown, but not to be trusted. */
	small: boolean;
}

export interface ExplainDimensionResult {
	dimension: ExplainDimension;
	/** Ranked by |contribution|, then `other` last. */
	segments: ExplainSegment[];
	/** Segments in this dimension before folding. */
	total: number;
}

export interface ExplainResult {
	metric: ExplainMetric;
	kind: "ratio" | "count";
	unit: (typeof METRIC_INFO)[ExplainMetric]["unit"];
	within: ExplainWithin | null;
	minPlayers: number;
	current: ExplainWindow;
	baseline: ExplainWindow;
	change: number;
	/** change / baseline value (null when the baseline is 0). */
	relative: number | null;
	dimensions: ExplainDimensionResult[];
}

const MAX_WINDOW_MS = 400 * DAY_MS;
/** Segment rows read per window and dimension (countries ~200; builds can be many). */
const MAX_SEGMENT_ROWS = 4_000;

function oneOf<T extends string>(value: unknown, list: readonly T[], what: string, fallback: T): T {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "string" || !(list as readonly string[]).includes(value)) throw new Error(`${what} must be one of ${list.join(", ")}`);
	return value as T;
}

function baselineOption(value: unknown): { from: number; to: number } | undefined {
	if (value === undefined || value === null) return undefined;
	const b = value as { from?: unknown; to?: unknown };
	if (typeof b !== "object" || b.from === undefined || b.to === undefined) throw new Error("baseline needs from and to");
	if ((typeof b.from !== "string" && typeof b.from !== "number") || (typeof b.to !== "string" && typeof b.to !== "number")) throw new Error("baseline from / to: unix ms, an ISO time or a date");
	const n = normalizeFilters({ from: b.from, to: b.to }, { now: 0, defaultDays: 1 });
	return { from: n.from, to: n.to };
}

function withinOption(value: unknown): ExplainWithin | undefined {
	if (value === undefined || value === null) return undefined;
	const w = value as { dimension?: unknown; value?: unknown };
	if (typeof w !== "object") throw new Error("within must be { dimension, value }");
	const dimension = oneOf(w.dimension, EXPLAIN_DIMENSIONS, "within.dimension", "device");
	if (w.value !== null && (typeof w.value !== "string" || w.value.length === 0 || w.value.length > 128)) throw new Error("within.value must be a string of 1-128 characters, or null");
	return { dimension, value: w.value as string | null };
}

/** The two windows: current = the filter range; baseline as given, else the same length right before. */
export function explainWindows(f: NormalizedFilters, o: Pick<ExplainOptions, "baseline">): { current: { from: number; to: number }; baseline: { from: number; to: number } } {
	const current = { from: f.from, to: f.to };
	const baseline = o.baseline ?? { from: f.from - (f.to - f.from), to: f.from };
	if (current.to - current.from > MAX_WINDOW_MS || baseline.to - baseline.from > MAX_WINDOW_MS) throw new Error("explain windows are at most 400 days long");
	if (baseline.from < current.to && current.from < baseline.to) throw new Error("the baseline window must not overlap the current one");
	return { current, baseline };
}

/** A segment's value expression on the `ev` CTE (one player's highest value per window wins). */
function segmentExpr(ctx: QueryContext, d: ExplainDimension): string {
	const j = (key: string) => ctx.dialect.jsonText("props", key);
	switch (d) {
		case "country":
			return `UPPER(${j("country")})`;
		case "language":
			return `LOWER(split_part(${j("locale")}, '-', 1))`;
		case "accountAge":
			return j("age");
		case "premium":
			return `LOWER(${j("prem")})`;
		case "source":
			return j("from");
		case "device":
			return "dev";
		case "build":
			return "art";
		case "branch":
			return "branch";
		case "playerType":
			return "CASE WHEN newp THEN 'new' ELSE 'returning' END";
	}
}

const JOIN_DIMENSIONS = new Set<ExplainDimension>(["country", "language", "accountAge", "premium", "source"]);

/** `name(w, pid, v)`: each player's segment per window. */
function segmentCte(ctx: QueryContext, d: ExplainDimension, name: string): string {
	if (d === "playerType") return `${name} AS (SELECT w, pid, CASE WHEN MAX(CASE WHEN newp THEN 1 ELSE 0 END) = 1 THEN 'new' ELSE 'returning' END AS v FROM ev GROUP BY w, pid)`;
	const rows = JOIN_DIMENSIONS.has(d) ? "ev WHERE kind = 'session' AND name = 'join' AND studio = 0" : "ev";
	// A player's rows from before the client reported its device say "unknown"; any real device wins over it (a plain
	// MAX would pick "unknown", which sorts after every device name).
	if (d === "device") return `${name} AS (SELECT w, pid, COALESCE(MAX(NULLIF(NULLIF(dev, ''), 'unknown')), MAX(NULLIF(dev, ''))) AS v FROM ${rows} GROUP BY w, pid)`;
	return `${name} AS (SELECT w, pid, MAX(NULLIF(${segmentExpr(ctx, d)}, '')) AS v FROM ${rows} GROUP BY w, pid)`;
}

/** `m(w, pid, den, num)`: one row per player of the metric's population and window. */
function metricCtes(ctx: QueryContext, o: ExplainOptions, windows: ReturnType<typeof explainWindows>): string {
	const sessions = "s AS (SELECT w, sid, MIN(pid) AS pid, MIN(t) AS t0, MAX(t) AS t1, MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew FROM ev GROUP BY w, sid)";
	switch (o.metric) {
		case "players":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, 1 AS num FROM s GROUP BY w, pid)`;
		case "dau":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, COUNT(DISTINCT ${dayOf("t0")}) AS num FROM s GROUP BY w, pid)`;
		case "newPlayers":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, 1 AS num FROM s WHERE isnew = 1 GROUP BY w, pid)`;
		case "returningPlayers":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, 1 AS num FROM s GROUP BY w, pid HAVING MAX(isnew) = 0)`;
		case "sessions":
		case "sessionsPerPlayer":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, COUNT(*) AS num FROM s GROUP BY w, pid)`;
		case "playtime":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, SUM(t1 - t0) / 3600000.0 AS num FROM s GROUP BY w, pid)`;
		case "playtimePerPlayer":
			return `${sessions}, m AS (SELECT w, pid, 1 AS den, SUM(t1 - t0) / 60000.0 AS num FROM s GROUP BY w, pid)`;
		case "avgSession":
			return `${sessions}, m AS (SELECT w, pid, COUNT(*) AS den, SUM(t1 - t0) / 60000.0 AS num FROM s GROUP BY w, pid)`;
		case "d1": {
			// Cohorts as in `roblox` / `retention`: new players by the day of their first newp row (Studio left out), only
			// those whose day 1 is over (before today, UTC); back = a session started the day after (no segment filters).
			const today = Math.floor(ctx.now / DAY_MS);
			const from = Math.min(windows.baseline.from, windows.current.from);
			const to = Math.max(windows.baseline.to, windows.current.to) + 2 * DAY_MS;
			return (
				`c AS (SELECT w, pid, cday FROM (SELECT w, pid, ${dayOf("MIN(t)")} AS cday FROM ev WHERE newp = TRUE AND studio = 0 GROUP BY w, pid) x WHERE cday + 1 < ${int(today)}), ` +
				`${sessionDaysCte(ctx, from, to)}, ` +
				`m AS (SELECT c.w AS w, c.pid AS pid, 1 AS den, MAX(CASE WHEN a.day = c.cday + 1 THEN 1 ELSE 0 END) AS num FROM c LEFT JOIN a ON a.pid = c.pid GROUP BY c.w, c.pid)`
			);
		}
		case "payerConversion":
		case "robuxPerPlayer":
		case "revenuePerPlayer": {
			// As `monetization`: active players = any player row; purchases = distinct server-sent rows.
			const robux = ctx.dialect.jsonNumber("props", o.robuxKey);
			const value = o.metric === "payerConversion" ? "CASE WHEN pp.pid IS NULL THEN 0 ELSE 1 END" : "COALESCE(pp.robux, 0)";
			return (
				`pr AS (SELECT DISTINCT w, pid, sid, t, name, props, esrc FROM ev WHERE kind = 'purchase'), ` +
				`pp AS (SELECT w, pid, SUM(COALESCE(${robux}, 0)) AS robux FROM pr WHERE ${SERVER_PURCHASE} GROUP BY w, pid), ` +
				`pl AS (SELECT w, pid FROM ev GROUP BY w, pid), ` +
				`m AS (SELECT pl.w AS w, pl.pid AS pid, 1 AS den, ${value} AS num FROM pl LEFT JOIN pp ON pp.w = pl.w AND pp.pid = pl.pid)`
			);
		}
	}
}

/** Days a window touches (UTC), for DAU. */
function daysTouched(w: { from: number; to: number }): number {
	return Math.floor((w.to - 1) / DAY_MS) - Math.floor(w.from / DAY_MS) + 1;
}

/** Multiplier on sum(num) per window: DAU divides player-days by the days; revenue keeps the creator's share. */
function scaleOf(o: ExplainOptions, w: { from: number; to: number }): number {
	if (o.metric === "dau") return 1 / daysTouched(w);
	if (o.metric === "revenuePerPlayer") return o.creatorShare;
	return 1;
}

function dimensionsOf(o: ExplainOptions): ExplainDimension[] {
	const all = o.dimension === "all" ? [...EXPLAIN_DIMENSIONS] : [o.dimension];
	// Inside a segment, its own dimension says nothing new.
	return o.within ? all.filter((d) => d !== o.within?.dimension) : all;
}

export const explain = defineQuery<ExplainOptions, ExplainResult>({
	name: "explain",
	summary: "explain a metric's change between two windows: per segment (device, country, language, account age, Premium, join source, build, branch, new/returning) both values and a shift-share split into rate and mix effects",
	defaultDays: 7,
	options: (input = {}) => {
		const within = withinOption(input.within);
		const baseline = baselineOption(input.baseline);
		return {
			metric: oneOf(input.metric, EXPLAIN_METRICS, "metric", "players"),
			dimension: oneOf(input.dimension, [...EXPLAIN_DIMENSIONS, "all"] as const, "dimension", "all"),
			...(baseline ? { baseline } : {}),
			...(within ? { within } : {}),
			top: intOption(input.top, "top", 8, 1, 20),
			minPlayers: intOption(input.minPlayers, "minPlayers", 30, 1, 100_000),
			robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
			creatorShare: shareOption(input.creatorShare),
		};
	},
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const windows = explainWindows(f, o);
		const { current: cur, baseline: base } = windows;
		const inWindow = (w: { from: number; to: number }) => `(e.t >= ${int(w.from)} AND e.t < ${int(w.to)})`;
		const tableFrom = Math.min(cur.from, base.from);
		const tableTo = Math.max(cur.to, base.to);
		const ev =
			`ev AS (SELECT CASE WHEN ${inWindow(cur)} THEN 1 ELSE 0 END AS w, e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp, e.kind AS kind, e.name AS name, ` +
			`e.props AS props, e.src AS esrc, e.dev AS dev, e.art AS art, e.branch AS branch, CASE WHEN ${NOT_STUDIO} THEN 0 ELSE 1 END AS studio ` +
			`FROM ${ctx.table("events", tableFrom, tableTo)} e WHERE ${whereSql(f, ctx.dialect, { prefix: "e.", noTime: true })} AND (${inWindow(cur)} OR ${inWindow(base)}) ` +
			`AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> '')`;
		const ctes = `${ev}, ${metricCtes(ctx, o, windows)}`;
		// The drill-down: only the players of one segment (per window).
		const within = o.within ? `, ${segmentCte(ctx, o.within.dimension, "gw")}` : "";
		const withinJoin = o.within ? ` LEFT JOIN gw ON gw.w = m.w AND gw.pid = m.pid WHERE ${o.within.value === null ? "gw.v IS NULL" : `gw.v = ${lit(o.within.value)}`}` : "";
		const out: Record<string, string> = {
			totals: `WITH ${ctes}${within} SELECT m.w AS w, COUNT(*) AS players, SUM(m.den) AS den, SUM(m.num) AS num FROM m${withinJoin} GROUP BY m.w ORDER BY w ${lim(2)}`,
		};
		for (const d of dimensionsOf(o)) {
			out[d] =
				`WITH ${ctes}${within}, ${segmentCte(ctx, d, "g")} SELECT m.w AS w, g.v AS v, COUNT(*) AS players, SUM(m.den) AS den, SUM(m.num) AS num ` +
				`FROM m LEFT JOIN g ON g.w = m.w AND g.pid = m.pid${withinJoin} GROUP BY m.w, g.v ORDER BY players DESC, v ${lim(MAX_SEGMENT_ROWS)}`;
		}
		return out;
	},
	shape(rows, _ctx, f, o) {
		const windows = explainWindows(f, o);
		const info = METRIC_INFO[o.metric];
		const scale = [scaleOf(o, windows.baseline), scaleOf(o, windows.current)];
		const totals = [0, 1].map((w) => {
			const r = rows.totals.find((x) => num(x.w) === w);
			return { players: num(r?.players), den: num(r?.den), num: num(r?.num) * scale[w] };
		});
		const valueOf = (t: { den: number; num: number }) => (info.kind === "count" ? t.num : t.den > 0 ? t.num / t.den : 0);
		const R0 = valueOf(totals[0]);
		const R1 = valueOf(totals[1]);
		const change = R1 - R0;
		// The mix effects' average term cancels only when the shares sum to 1 in both windows (both have a population).
		const Rbar = totals[0].den > 0 && totals[1].den > 0 ? (R0 + R1) / 2 : 0;
		const places = info.unit === "share" ? 6 : 4;
		const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
		// `|| 0`: no -0 (the engines' float sums differ in the last bit).
		const fix = (v: number, p = places) => round(v, p) || 0;

		const dimensions = dimensionsOf(o).map((d): ExplainDimensionResult => {
			const bySeg = new Map<string, { value: string | null; t: { players: number; den: number; num: number }[] }>();
			for (const r of rows[d] ?? []) {
				const value = r.v === null || r.v === undefined ? null : str(r.v).slice(0, 64);
				const key = value === null ? "\u0000" : `v${value}`;
				let seg = bySeg.get(key);
				if (!seg) {
					seg = { value, t: [{ players: 0, den: 0, num: 0 }, { players: 0, den: 0, num: 0 }] };
					bySeg.set(key, seg);
				}
				const w = num(r.w) === 1 ? 1 : 0;
				seg.t[w] = { players: num(r.players), den: num(r.den), num: num(r.num) * scale[w] };
			}
			const segments = [...bySeg.values()].map((seg) => {
				const [a, b] = seg.t;
				const s0 = share(a.den, totals[0].den);
				const s1 = share(b.den, totals[1].den);
				let rate: number;
				let mix: number;
				let v0: number | null;
				let v1: number | null;
				if (info.kind === "count") {
					v0 = a.num;
					v1 = b.num;
					rate = b.num - a.num;
					mix = 0;
				} else {
					v0 = a.den > 0 ? a.num / a.den : null;
					v1 = b.den > 0 ? b.num / b.den : null;
					const r0 = v0 ?? v1 ?? 0;
					const r1 = v1 ?? v0 ?? 0;
					rate = (r1 - r0) * ((s0 + s1) / 2);
					mix = (s1 - s0) * ((r0 + r1) / 2 - Rbar);
				}
				return {
					value: seg.value,
					baseline: { players: a.players, value: v0, share: s0 },
					current: { players: b.players, value: v1, share: s1 },
					raw: seg.t,
					rate,
					mix,
				};
			});
			segments.sort(
				(x, y) =>
					fix(Math.abs(y.rate + y.mix)) - fix(Math.abs(x.rate + x.mix)) ||
					y.current.players + y.baseline.players - (x.current.players + x.baseline.players) ||
					String(x.value ?? "").localeCompare(String(y.value ?? "")),
			);
			const kept = segments.slice(0, o.top);
			const rest = segments.slice(o.top);
			const finish = (s: (typeof segments)[number], extra: Partial<ExplainSegment> = {}): ExplainSegment => {
				const contribution = s.rate + s.mix;
				return {
					value: s.value,
					...extra,
					baseline: { players: s.baseline.players, value: s.baseline.value === null ? null : fix(s.baseline.value), share: fix(s.baseline.share, 4) },
					current: { players: s.current.players, value: s.current.value === null ? null : fix(s.current.value), share: fix(s.current.share, 4) },
					contribution: fix(contribution),
					rate: fix(s.rate),
					mix: fix(s.mix),
					shareOfChange: Math.abs(change) > 1e-9 ? fix(contribution / change, 4) : null,
					small: Math.min(s.baseline.players, s.current.players) < o.minPlayers,
				};
			};
			const out = kept.map((s) => finish(s));
			if (rest.length) {
				const sum = (w: 0 | 1) => rest.reduce((acc, s) => ({ players: acc.players + s.raw[w].players, den: acc.den + s.raw[w].den, num: acc.num + s.raw[w].num }), { players: 0, den: 0, num: 0 });
				const a = sum(0);
				const b = sum(1);
				const value = (t: { den: number; num: number }) => (info.kind === "count" ? t.num : t.den > 0 ? t.num / t.den : null);
				out.push(
					finish(
						{
							value: null,
							baseline: { players: a.players, value: value(a), share: share(a.den, totals[0].den) },
							current: { players: b.players, value: value(b), share: share(b.den, totals[1].den) },
							raw: [a, b],
							rate: rest.reduce((acc, s) => acc + s.rate, 0),
							mix: rest.reduce((acc, s) => acc + s.mix, 0),
						},
						{ other: true, segments: rest.length },
					),
				);
			}
			return { dimension: d, segments: out, total: segments.length };
		});
		const win = (w: 0 | 1, range: { from: number; to: number }): ExplainWindow => ({
			from: iso(range.from),
			to: iso(range.to),
			value: fix(w ? R1 : R0),
			players: totals[w].players,
		});
		return {
			metric: o.metric,
			kind: info.kind,
			unit: info.unit,
			within: o.within ?? null,
			minPlayers: o.minPlayers,
			current: win(1, windows.current),
			baseline: win(0, windows.baseline),
			change: fix(change),
			relative: Math.abs(R0) > 1e-12 ? fix(change / R0, 4) : null,
			dimensions,
		};
	},
});
