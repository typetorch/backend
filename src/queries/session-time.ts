/**
 * session-time: the Session time explorer, the counterpart of Creator Hub's Performance > Session time chart
 * (README "Queries", "Roblox parity"). Per time bucket, the average length of the sessions counted in it, in total and
 * per device class, with Roblox's way of counting by default:
 *   - a session (one `sid`, first to last event, Studio play tests left out) counts in the bucket where it ENDED
 *     (`by: "end"`), with its full length (it may have started before the range: the read reaches SESSION_SLACK_MS
 *     back); `by: "start"` counts it where it started instead. Only sessions that are over count: a session/leave row,
 *     or no event for ENDED_AFTER_MS;
 *   - `mergeGapMinutes` (0 = off) joins a player's sessions when the next one starts less than that after the previous
 *     ended (rejoins, teleports between places): the merged session keeps the earliest start, the latest end, the
 *     last one's "over" and the first known device;
 *   - `avgMinutes` is weighted (all sessions of the bucket); `robloxTotal` is the unweighted mean of the device
 *     averages in the bucket (unknown devices left out; the weighted value when no device is known). Roblox doesn't
 *     publish how its Total line or its smoothing is computed: both are offered, the explorer smooths client-side.
 * Computed in TS from one row per session (the SQL only groups events by sid).
 */
import type { NormalizedFilters } from "../sql/filters.ts";
import { ENDED_AFTER_MS, NOT_STUDIO, SESSION_SLACK_MS, defineQuery, int, intOption, iso, num, playerRows, round, str, windowBucketMs, type QueryContext } from "./core.ts";

const MINUTE_MS = 60_000;
/** Bucket sizes the explorer offers, minutes. */
export const SESSION_TIME_BUCKETS = [1, 5, 15, 60, 1440] as const;
const MAX_BUCKETS = 2000;
/** Sessions read at most (one row each). */
const MAX_SESSIONS = 500_000;

export interface SessionTimeOptions {
	/** Bucket length, minutes (1, 5, 15, 60 or 1440); default: the explorer's step for the range (windowBucketMs). */
	bucketMinutes?: number;
	/** Merge a player's sessions closer than this, minutes (0 = off, up to 30). */
	mergeGapMinutes: number;
	/** Which bucket a session counts in: where it ended (Roblox) or where it started. */
	by: "end" | "start";
}

export interface SessionTimeDevice {
	sessions: number;
	avgMinutes: number | null;
	playtimeMinutes: number;
}

export interface SessionTimeBucket {
	/** Bucket start, unix ms, and as ISO. */
	t: number;
	time: string;
	sessions: number;
	/** Weighted: total length / sessions, minutes; null in an empty bucket. */
	avgMinutes: number | null;
	/** The unweighted mean of the device averages in the bucket (unknown left out); null in an empty bucket. */
	robloxTotal: number | null;
	/** Total length of the sessions counted in the bucket, minutes. */
	playtimeMinutes: number;
	/** Distinct players among them. */
	players: number;
	playtimePerPlayer: number | null;
	byDevice: Record<string, SessionTimeDevice>;
}

export interface SessionTimeSummary {
	/** Over sessions counted in the period. */
	sessions: number;
	players: number;
	avgMinutes: number | null;
	medianMinutes: number | null;
	/** Mean over non-empty buckets of robloxTotal (Creator Hub's "minute-by-minute average over selected period"). */
	robloxHeadline: number | null;
	/** Mean over non-empty buckets of avgMinutes. */
	weightedMinuteMean: number | null;
	playtimeMinutes: number;
	playtimePerPlayer: number | null;
	/** Sessions not over (no leave row, an event in the last 10 minutes) that overlap the period. */
	running: number;
	/**
	 * The time all players spent in the game inside the period, minutes: every session (over or running) cut at the
	 * period's edges, a running one counted up to now. Unlike `playtimeMinutes` (the full length of the sessions counted).
	 */
	playedMinutes: number;
}

export interface SessionTimeResult {
	from: string;
	to: string;
	bucketMinutes: number;
	mergeGapMinutes: number;
	by: "end" | "start";
	/** Device classes in the period, busiest first. */
	devices: string[];
	buckets: SessionTimeBucket[];
	summary: SessionTimeSummary;
	/** The same for the period of equal length just before. */
	previous: SessionTimeSummary;
	/** Over sessions of the period by length. */
	histogram: { label: string; fromSeconds: number; toSeconds: number | null; count: number }[];
	/** True when the session read hit its row limit (the oldest part of the read may be missing). */
	truncated: boolean;
}

/** One session after merging: start, end, player, device, over. */
export interface SessionSpan {
	pid: string;
	t0: number;
	t1: number;
	dev: string;
	over: boolean;
}

const HISTOGRAM_BINS: { label: string; from: number; to: number | null }[] = [
	{ label: "<30s", from: 0, to: 30 },
	{ label: "30s-1m", from: 30, to: 60 },
	{ label: "1-3m", from: 60, to: 180 },
	{ label: "3-5m", from: 180, to: 300 },
	{ label: "5-10m", from: 300, to: 600 },
	{ label: "10-20m", from: 600, to: 1200 },
	{ label: "20-30m", from: 1200, to: 1800 },
	{ label: "30-60m", from: 1800, to: 3600 },
	{ label: "60m+", from: 3600, to: null },
];

/**
 * A player's consecutive sessions joined when the next starts less than `gapMs` after the previous ended (overlapping
 * ones too). `spans` must be sorted by pid, then start. gapMs 0 = unchanged.
 */
export function mergeSessions(spans: readonly SessionSpan[], gapMs: number): SessionSpan[] {
	if (gapMs <= 0) return spans.slice();
	const out: SessionSpan[] = [];
	let cur: SessionSpan | null = null;
	for (const s of spans) {
		if (cur && cur.pid === s.pid && s.t0 - cur.t1 < gapMs) {
			if (s.t1 >= cur.t1) {
				cur.t1 = s.t1;
				cur.over = s.over;
			}
			if (cur.dev === "unknown") cur.dev = s.dev;
			continue;
		}
		cur = { ...s };
		out.push(cur);
	}
	return out;
}

function bucketMsOf(f: NormalizedFilters, o: SessionTimeOptions): number {
	const span = f.to - f.from;
	if (!(span > 0)) throw new Error("the range must end after it starts");
	const ms = o.bucketMinutes !== undefined ? o.bucketMinutes * MINUTE_MS : windowBucketMs(span);
	if (span / ms > MAX_BUCKETS) throw new Error(`more than ${MAX_BUCKETS} buckets: use a larger bucketMinutes or a shorter range`);
	return ms;
}

const avg = (ms: number, n: number) => (n ? round(ms / n / MINUTE_MS, 2) : null);
const mean = (values: number[]) => (values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 2) : null);

interface Acc {
	n: number;
	ms: number;
	pids: Set<string>;
	dev: Map<string, { n: number; ms: number }>;
}

function accOf(): Acc {
	return { n: 0, ms: 0, pids: new Set(), dev: new Map() };
}

function add(a: Acc, s: SessionSpan) {
	const len = s.t1 - s.t0;
	a.n += 1;
	a.ms += len;
	a.pids.add(s.pid);
	const d = a.dev.get(s.dev) ?? { n: 0, ms: 0 };
	d.n += 1;
	d.ms += len;
	a.dev.set(s.dev, d);
}

/** The unweighted mean of the known devices' averages; the weighted average when no device is known. */
function robloxTotalOf(a: Acc): number | null {
	if (!a.n) return null;
	const known = [...a.dev].filter(([d]) => d !== "unknown").map(([, v]) => v.ms / v.n / MINUTE_MS);
	return known.length ? round(known.reduce((x, y) => x + y, 0) / known.length, 2) : avg(a.ms, a.n);
}

/** Time inside [from, to) over every session, ms: an over one ends at its last event, a running one at `now`. */
export function playedInside(spans: readonly SessionSpan[], from: number, to: number, now: number): number {
	let ms = 0;
	for (const s of spans) {
		const end = s.over ? s.t1 : Math.max(s.t1, now);
		const overlap = Math.min(end, to, now) - Math.max(s.t0, from);
		if (overlap > 0) ms += overlap;
	}
	return ms;
}

function summaryOf(spans: readonly SessionSpan[], from: number, to: number, bucketMs: number, by: "end" | "start", now: number): { summary: SessionTimeSummary; counted: SessionSpan[]; buckets: Map<number, Acc> } {
	const at = (s: SessionSpan) => (by === "end" ? s.t1 : s.t0);
	const counted = spans.filter((s) => s.over && at(s) >= from && at(s) < to);
	const total = accOf();
	const buckets = new Map<number, Acc>();
	for (const s of counted) {
		add(total, s);
		const b = Math.floor(at(s) / bucketMs);
		let acc = buckets.get(b);
		if (!acc) buckets.set(b, (acc = accOf()));
		add(acc, s);
	}
	const lengths = counted.map((s) => s.t1 - s.t0).sort((a, b) => a - b);
	const mid = lengths.length >> 1;
	const median = lengths.length ? (lengths.length % 2 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2) : null;
	const filled = [...buckets.values()];
	const playtime = round(total.ms / MINUTE_MS, 1);
	return {
		counted,
		buckets,
		summary: {
			sessions: total.n,
			players: total.pids.size,
			avgMinutes: avg(total.ms, total.n),
			medianMinutes: median === null ? null : round(median / MINUTE_MS, 2),
			robloxHeadline: mean(filled.map((a) => robloxTotalOf(a)).filter((v): v is number => v !== null)),
			weightedMinuteMean: mean(filled.map((a) => a.ms / a.n / MINUTE_MS)),
			playtimeMinutes: playtime,
			playtimePerPlayer: total.pids.size ? round(playtime / total.pids.size, 2) : null,
			running: spans.filter((s) => !s.over && s.t1 >= from && s.t0 < to).length,
			playedMinutes: round(playedInside(spans, from, to, now) / MINUTE_MS, 1),
		},
	};
}

export const sessionTime = defineQuery<SessionTimeOptions, SessionTimeResult>({
	name: "session-time",
	summary:
		"Session time explorer (Creator Hub's Session time chart): per bucket, the average length of the sessions that ended in it (or started: `by`), weighted and Roblox-style (mean of the device averages), per device, playtime and players; optional merge of rejoins (`mergeGapMinutes`); a summary vs the period before and a length histogram",
	defaultDays: 1,
	options: (input = {}) => {
		const out: SessionTimeOptions = {
			mergeGapMinutes: intOption(input.mergeGapMinutes, "mergeGapMinutes", 0, 0, 30),
			by: (() => {
				const by = input.by ?? "end";
				if (by !== "end" && by !== "start") throw new Error('by must be "end" or "start"');
				return by;
			})(),
		};
		if (input.bucketMinutes !== undefined && input.bucketMinutes !== null) {
			const m = intOption(input.bucketMinutes, "bucketMinutes", 60, 1, 1440);
			if (!(SESSION_TIME_BUCKETS as readonly number[]).includes(m)) throw new Error(`bucketMinutes must be one of ${SESSION_TIME_BUCKETS.join(", ")}`);
			out.bucketMinutes = m;
		}
		return out;
	},
	statements(ctx: QueryContext, f, o) {
		bucketMsOf(f, o);
		const span = f.to - f.from;
		const prevFrom = f.from - span;
		// Back far enough for a session ending in the previous period to keep its start; forward past `to` so a session
		// counted by start keeps its end (and one still going isn't cut at `to`).
		const lo = prevFrom - SESSION_SLACK_MS;
		const hi = Math.min(f.to + SESSION_SLACK_MS, ctx.now + MINUTE_MS);
		const fr: NormalizedFilters = { ...f, from: lo, to: hi };
		const ev = `SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.dev AS dev, e.kind AS kind, e.name AS name FROM ${ctx.table("events", lo, hi)} e WHERE ${playerRows(fr, ctx, NOT_STUDIO)}`;
		return {
			sessions:
				`WITH ev AS (${ev}) SELECT sid, MIN(pid) AS pid, MIN(t) AS t0, MAX(t) AS t1, ` +
				`COALESCE(MAX(CASE WHEN dev <> '' AND dev <> 'unknown' THEN dev END), 'unknown') AS dev, ` +
				`MAX(CASE WHEN kind = 'session' AND name = 'leave' THEN 1 ELSE 0 END) AS lft FROM ev GROUP BY sid ` +
				`HAVING MAX(t) >= ${int(prevFrom - 30 * MINUTE_MS)} ORDER BY t1 DESC ${ctx.dialect.limit(MAX_SESSIONS)}`,
		};
	},
	shape(rows, ctx, f, o) {
		const bucketMs = bucketMsOf(f, o);
		const endedBefore = ctx.now - ENDED_AFTER_MS;
		const raw: SessionSpan[] = rows.sessions.map((r) => {
			const t1 = num(r.t1);
			return { pid: str(r.pid), t0: num(r.t0), t1, dev: str(r.dev) || "unknown", over: num(r.lft) === 1 || t1 < endedBefore };
		});
		raw.sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : a.t0 - b.t0));
		const spans = mergeSessions(raw, o.mergeGapMinutes * MINUTE_MS);
		const span = f.to - f.from;
		const cur = summaryOf(spans, f.from, f.to, bucketMs, o.by, ctx.now);
		const prev = summaryOf(spans, f.from - span, f.from, bucketMs, o.by, ctx.now);
		const weight = new Map<string, number>();
		for (const s of cur.counted) weight.set(s.dev, (weight.get(s.dev) ?? 0) + 1);
		const devices = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
		const buckets: SessionTimeBucket[] = [];
		const first = Math.floor(f.from / bucketMs);
		const last = Math.floor((Math.min(f.to, ctx.now + 1) - 1) / bucketMs);
		for (let b = first; b <= last; b++) {
			const a = cur.buckets.get(b) ?? accOf();
			const playtime = round(a.ms / MINUTE_MS, 1);
			buckets.push({
				t: b * bucketMs,
				time: iso(b * bucketMs),
				sessions: a.n,
				avgMinutes: avg(a.ms, a.n),
				robloxTotal: robloxTotalOf(a),
				playtimeMinutes: playtime,
				players: a.pids.size,
				playtimePerPlayer: a.pids.size ? round(playtime / a.pids.size, 2) : null,
				byDevice: Object.fromEntries([...a.dev].map(([d, v]) => [d, { sessions: v.n, avgMinutes: avg(v.ms, v.n), playtimeMinutes: round(v.ms / MINUTE_MS, 1) }])),
			});
		}
		const histogram = HISTOGRAM_BINS.map((bin) => ({ label: bin.label, fromSeconds: bin.from, toSeconds: bin.to, count: 0 }));
		for (const s of cur.counted) {
			const sec = (s.t1 - s.t0) / 1000;
			const i = HISTOGRAM_BINS.findIndex((bin) => bin.to === null || sec < bin.to);
			histogram[i].count += 1;
		}
		return {
			from: iso(f.from),
			to: iso(f.to),
			bucketMinutes: bucketMs / MINUTE_MS,
			mergeGapMinutes: o.mergeGapMinutes,
			by: o.by,
			devices,
			buckets,
			summary: cur.summary,
			previous: prev.summary,
			histogram,
			truncated: rows.sessions.length >= MAX_SESSIONS,
		};
	},
});
