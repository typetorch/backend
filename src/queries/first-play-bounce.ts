/**
 * first-play-bounce: Creator Hub's "First play bounce rate (<60s Average Rate)" chart, with the per-device breakdown
 * Creator Hub doesn't offer. Per time bucket, the share of new players whose first session was shorter than
 * `bounceSeconds`:
 *   - a first session is a session (one `sid`, first to last event) whose rows carry `newp`; Studio play tests are
 *     left out;
 *   - it counts in the bucket where it STARTED (the first-play date, as Creator Hub dates it), with its full length
 *     (the read reaches SESSION_SLACK_MS past the range);
 *   - only first sessions that are over count (a session/leave row, or no event for ENDED_AFTER_MS): one still
 *     running could still pass the bar;
 *   - `rate` per bucket is pooled (bounced / first sessions, all devices); the summary has the pooled rate over the
 *     period and `dailyMean`, the unweighted mean of the non-empty buckets' rates (Creator Hub's "average over selected
 *     period"), each vs the period of equal length before.
 * Computed in TS from one row per session (the SQL only groups events by sid).
 */
import type { NormalizedFilters } from "../sql/filters.ts";
import { ENDED_AFTER_MS, NOT_STUDIO, SESSION_SLACK_MS, defineQuery, int, intOption, iso, num, playerRows, ratio, str, windowBucketMs, type QueryContext } from "./core.ts";
import { SESSION_TIME_BUCKETS } from "./session-time.ts";

const MINUTE_MS = 60_000;
const MAX_BUCKETS = 2000;
/** First sessions read at most (one row each). */
const MAX_SESSIONS = 500_000;

export interface FirstPlayBounceOptions {
	/** A first session shorter than this is a bounce. Default 60 seconds (Creator Hub's bar). */
	bounceSeconds: number;
	/** Bucket length, minutes (1, 5, 15, 60 or 1440); default: the explorer's step for the range (windowBucketMs). */
	bucketMinutes?: number;
}

export interface BounceCount {
	/** bounced / firstSessions, 0-1; null when there were none. */
	rate: number | null;
	bounced: number;
	firstSessions: number;
}

export interface FirstPlayBounceBucket extends BounceCount {
	/** Bucket start, unix ms, and as ISO. */
	t: number;
	time: string;
	byDevice: Record<string, BounceCount>;
}

export interface FirstPlayBounceSummary extends BounceCount {
	/** The unweighted mean of the non-empty buckets' rates (Creator Hub's headline); null when no bucket has any. */
	dailyMean: number | null;
	byDevice: Record<string, BounceCount & { dailyMean: number | null }>;
	/** First sessions not over yet that started in the period (not counted). */
	running: number;
}

export interface FirstPlayBounceResult {
	from: string;
	to: string;
	bounceSeconds: number;
	bucketMinutes: number;
	/** Device classes with first sessions in the period, busiest first ("unknown" when no row named one). */
	devices: string[];
	buckets: FirstPlayBounceBucket[];
	summary: FirstPlayBounceSummary;
	/** The same for the period of equal length just before. */
	previous: FirstPlayBounceSummary;
	/** True when the session read hit its row limit. */
	truncated: boolean;
}

interface FirstSession {
	t0: number;
	len: number;
	dev: string;
	over: boolean;
}

function bucketMsOf(f: NormalizedFilters, o: FirstPlayBounceOptions): number {
	const span = f.to - f.from;
	if (!(span > 0)) throw new Error("the range must end after it starts");
	const ms = o.bucketMinutes !== undefined ? o.bucketMinutes * MINUTE_MS : windowBucketMs(span);
	if (span / ms > MAX_BUCKETS) throw new Error(`more than ${MAX_BUCKETS} buckets: use a larger bucketMinutes or a shorter range`);
	return ms;
}

interface Acc {
	n: number;
	bounced: number;
	dev: Map<string, { n: number; bounced: number }>;
}

const accOf = (): Acc => ({ n: 0, bounced: 0, dev: new Map() });
const countOf = (bounced: number, n: number): BounceCount => ({ rate: n ? ratio(bounced, n) : null, bounced, firstSessions: n });
const meanOf = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10_000) / 10_000 : null);

function add(a: Acc, dev: string, bounced: boolean) {
	a.n += 1;
	if (bounced) a.bounced += 1;
	const d = a.dev.get(dev) ?? { n: 0, bounced: 0 };
	d.n += 1;
	if (bounced) d.bounced += 1;
	a.dev.set(dev, d);
}

function periodOf(sessions: readonly FirstSession[], from: number, to: number, bucketMs: number, barMs: number) {
	const total = accOf();
	const buckets = new Map<number, Acc>();
	let running = 0;
	for (const s of sessions) {
		if (s.t0 < from || s.t0 >= to) continue;
		if (!s.over) {
			running += 1;
			continue;
		}
		const bounced = s.len < barMs;
		add(total, s.dev, bounced);
		const b = Math.floor(s.t0 / bucketMs);
		let acc = buckets.get(b);
		if (!acc) buckets.set(b, (acc = accOf()));
		add(acc, s.dev, bounced);
	}
	const filled = [...buckets.values()];
	const byDevice: FirstPlayBounceSummary["byDevice"] = {};
	for (const [d, v] of total.dev) {
		const rates = filled.map((a) => a.dev.get(d)).filter((x): x is { n: number; bounced: number } => !!x && x.n > 0).map((x) => x.bounced / x.n);
		byDevice[d] = { ...countOf(v.bounced, v.n), dailyMean: meanOf(rates) };
	}
	const summary: FirstPlayBounceSummary = {
		...countOf(total.bounced, total.n),
		dailyMean: meanOf(filled.filter((a) => a.n > 0).map((a) => a.bounced / a.n)),
		byDevice,
		running,
	};
	return { summary, total, buckets };
}

export const firstPlayBounce = defineQuery<FirstPlayBounceOptions, FirstPlayBounceResult>({
	name: "first-play-bounce",
	summary:
		"First-play bounce rate (Creator Hub's <60s chart) per bucket, in total and per device: the share of new players whose first session (over, Studio left out) was shorter than bounceSeconds, by the bucket it started in; a summary (pooled and the mean of the bucket rates) vs the period before",
	defaultDays: 7,
	options: (input = {}) => {
		const out: FirstPlayBounceOptions = { bounceSeconds: intOption(input.bounceSeconds, "bounceSeconds", 60, 5, 3600) };
		if (input.bucketMinutes !== undefined && input.bucketMinutes !== null) {
			const m = intOption(input.bucketMinutes, "bucketMinutes", 1440, 1, 1440);
			if (!(SESSION_TIME_BUCKETS as readonly number[]).includes(m)) throw new Error(`bucketMinutes must be one of ${SESSION_TIME_BUCKETS.join(", ")}`);
			out.bucketMinutes = m;
		}
		return out;
	},
	statements(ctx: QueryContext, f, o) {
		bucketMsOf(f, o);
		const prevFrom = f.from - (f.to - f.from);
		// Back so a session read starts at its real start; forward past `to` so a first session that started in the
		// range keeps its full length.
		const lo = prevFrom - SESSION_SLACK_MS;
		const hi = Math.min(f.to + SESSION_SLACK_MS, ctx.now + MINUTE_MS);
		const fr: NormalizedFilters = { ...f, from: lo, to: hi };
		const ev = `SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp, e.dev AS dev, e.kind AS kind, e.name AS name FROM ${ctx.table("events", lo, hi)} e WHERE ${playerRows(fr, ctx, NOT_STUDIO)}`;
		return {
			sessions:
				`WITH ev AS (${ev}) SELECT sid, MIN(t) AS t0, MAX(t) AS t1, ` +
				`COALESCE(MAX(CASE WHEN dev <> '' AND dev <> 'unknown' THEN dev END), 'unknown') AS dev, ` +
				`MAX(CASE WHEN kind = 'session' AND name = 'leave' THEN 1 ELSE 0 END) AS lft FROM ev GROUP BY sid ` +
				`HAVING MAX(CASE WHEN newp THEN 1 ELSE 0 END) = 1 AND MIN(t) >= ${int(prevFrom)} AND MIN(t) < ${int(f.to)} ` +
				`ORDER BY t0 DESC ${ctx.dialect.limit(MAX_SESSIONS)}`,
		};
	},
	shape(rows, ctx, f, o) {
		const bucketMs = bucketMsOf(f, o);
		const barMs = o.bounceSeconds * 1000;
		const endedBefore = ctx.now - ENDED_AFTER_MS;
		const sessions: FirstSession[] = rows.sessions.map((r) => {
			const t0 = num(r.t0);
			const t1 = num(r.t1);
			return { t0, len: t1 - t0, dev: str(r.dev) || "unknown", over: num(r.lft) === 1 || t1 < endedBefore };
		});
		const cur = periodOf(sessions, f.from, f.to, bucketMs, barMs);
		const prev = periodOf(sessions, f.from - (f.to - f.from), f.from, bucketMs, barMs);
		const devices = [...cur.total.dev].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([d]) => d);
		const buckets: FirstPlayBounceBucket[] = [];
		const first = Math.floor(f.from / bucketMs);
		const last = Math.floor((Math.min(f.to, ctx.now + 1) - 1) / bucketMs);
		for (let b = first; b <= last; b++) {
			const a = cur.buckets.get(b) ?? accOf();
			buckets.push({
				t: b * bucketMs,
				time: iso(b * bucketMs),
				...countOf(a.bounced, a.n),
				byDevice: Object.fromEntries([...a.dev].map(([d, v]) => [d, countOf(v.bounced, v.n)])),
			});
		}
		return {
			from: iso(f.from),
			to: iso(f.to),
			bounceSeconds: o.bounceSeconds,
			bucketMinutes: bucketMs / MINUTE_MS,
			devices,
			buckets,
			summary: cur.summary,
			previous: prev.summary,
			truncated: rows.sessions.length >= MAX_SESSIONS,
		};
	},
});
