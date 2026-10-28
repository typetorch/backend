/**
 * One player's numbers over a window, for the explorer's player detail (Players page): spending, playtime and sessions
 * per bucket, the totals, each session and each purchase. Buckets follow the window like the explorer's other charts: up
 * to an hour per minute, up to 6 hours per 5 minutes, up to a day per hour ("today", one custom date), longer per UTC day;
 * the series is dense (empty buckets are zeros). The window is the
 * filter range, cut to the last 400 days (`window.clamped` says so).
 *
 * A session counts in the bucket where it starts, with its whole length (first to last event, like every other query).
 * Spending counts server-sent `purchase` rows only (SERVER_PURCHASE), like the revenue queries.
 */
import { PROP_KEYS } from "../schema.ts";
import { DAY_MS, int, lit } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { checkPid, defineQuery, intOption, iso, num, round, SERVER_PURCHASE, str, strOrNull, where, windowBucketMs, type QueryContext } from "./core.ts";

/** The longest window the query reads; a wider filter range is cut to its last 400 days. */
export const PLAYER_MAX_DAYS = 400;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type PlayerBucketUnit = "minute" | "5 minutes" | "hour" | "day";

/** The step for a window: the explorer's shared rule (core.ts `windowBucketMs`, also used by Overview and Performance). */
export const playerBucketMs = windowBucketMs;

const UNITS: Record<number, PlayerBucketUnit> = { [MINUTE_MS]: "minute", [5 * MINUTE_MS]: "5 minutes", [HOUR_MS]: "hour", [DAY_MS]: "day" };

export interface PlayerStatsOptions {
	pid: string;
	/** Most sessions listed, newest first (default 1000). */
	sessions: number;
	/** Most purchases listed, newest first (default 500). */
	purchases: number;
}

export interface PlayerBucket {
	/** The bucket's start (ISO). */
	start: string;
	/** Sessions that started in it. */
	sessions: number;
	/** Their playtime, minutes. */
	minutes: number;
	robux: number;
	purchases: number;
}

export interface PlayerSession {
	sid: string;
	start: string;
	end: string;
	minutes: number;
	events: number;
	firstSession: boolean;
	dev: string | null;
	art: string;
	/** The game server's JobId the session ran on (the smallest one when a session spans several, as `dev` and `art`). */
	job: string | null;
}

export interface PlayerPurchase {
	time: string;
	t: number;
	/** The purchase kind (the row's name: `product`, `gamepass`, ...). */
	kind: string;
	product: string | null;
	robux: number | null;
	where: string | null;
	sid: string | null;
}

export interface PlayerStatsResult {
	pid: string;
	window: {
		from: string;
		to: string;
		/** The step of `series`. */
		bucket: PlayerBucketUnit;
		bucketMs: number;
		/** UTC days the window touches (at least 1): what "per day" divides by. */
		days: number;
		/** The filter range was longer than PLAYER_MAX_DAYS and was cut to its end. */
		clamped: boolean;
	};
	totals: {
		sessions: number;
		events: number;
		playtimeMinutes: number;
		avgSessionMinutes: number;
		medianSessionMinutes: number;
		/** Playtime over the window's days. */
		playtimePerDayMinutes: number;
		/** Days with a session start. */
		activeDays: number;
		robux: number;
		purchases: number;
		firstSeen: string | null;
		lastSeen: string | null;
	};
	series: PlayerBucket[];
	/** Newest first. */
	sessions: PlayerSession[];
	sessionsTruncated: boolean;
	/** Newest first. */
	purchases: PlayerPurchase[];
	purchasesTruncated: boolean;
}

interface Window {
	from: number;
	to: number;
	bucketMs: number;
	clamped: boolean;
}

function windowOf(f: NormalizedFilters): Window {
	const clamped = f.to - f.from > PLAYER_MAX_DAYS * DAY_MS;
	const from = clamped ? f.to - PLAYER_MAX_DAYS * DAY_MS : f.from;
	return { from, to: f.to, bucketMs: playerBucketMs(f.to - from), clamped };
}

/** The bucket number of an int64 ms expression. */
const bucketOf = (column: string, bucketMs: number) => `CAST(floor(${column} / ${int(bucketMs)}.0) AS BIGINT)`;

function parseProps(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const shortText = (v: unknown, max = 64): string | null => (typeof v === "string" && v !== "" ? v.slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

export const playerStats = defineQuery<PlayerStatsOptions, PlayerStatsResult>({
	name: "player-stats",
	summary: "one player's spending, playtime and sessions per day (finer for windows up to a day), with each session and purchase (by pid)",
	defaultDays: 30,
	options: (input = {}) => ({
		pid: checkPid(input.pid),
		sessions: intOption(input.sessions, "sessions", 1000, 1, 5000),
		purchases: intOption(input.purchases, "purchases", 500, 1, 2000),
	}),
	statements(ctx: QueryContext, f, o) {
		const w = windowOf(f);
		const lim = ctx.dialect.limit;
		const table = ctx.table("events", w.from, w.to);
		const cond = `${where({ ...f, from: w.from }, ctx)} AND e.pid = ${lit(o.pid)}`;
		const sessionsCte =
			`ev AS (SELECT e.sid AS sid, e.t AS t, e.newp AS newp, e.dev AS dev, e.art AS art, e.job AS job FROM ${table} e WHERE ${cond} AND e.sid IS NOT NULL AND e.sid <> ''), ` +
			`s AS (SELECT sid, MIN(t) AS t0, MAX(t) AS t1, COUNT(*) AS n, MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew, MIN(dev) AS dev, MIN(art) AS art, MIN(job) AS job FROM ev GROUP BY sid)`;
		const buckets = Math.ceil((w.to - w.from) / w.bucketMs) + 2;
		return {
			totals:
				`WITH ${sessionsCte} SELECT COUNT(*) AS sessions, SUM(n) AS events, SUM(t1 - t0) AS playtime_ms, MEDIAN(t1 - t0) AS median_ms, ` +
				`MIN(t0) AS first_t, MAX(t1) AS last_t, COUNT(DISTINCT ${bucketOf("t0", DAY_MS)}) AS active_days FROM s ${lim(1)}`,
			activity:
				`WITH ${sessionsCte} SELECT bk, COUNT(*) AS sessions, SUM(len) AS ms FROM (SELECT ${bucketOf("t0", w.bucketMs)} AS bk, t1 - t0 AS len FROM s) x ` +
				`GROUP BY bk ORDER BY bk ${lim(buckets)}`,
			spend:
				`SELECT bk, COUNT(*) AS purchases, SUM(COALESCE(robux, 0)) AS robux FROM (SELECT ${bucketOf("e.t", w.bucketMs)} AS bk, ` +
				`${ctx.dialect.jsonNumber("e.props", PROP_KEYS.purchaseRobux)} AS robux, e.src AS esrc FROM ${table} e WHERE ${cond} AND e.kind = 'purchase') y ` +
				`WHERE ${SERVER_PURCHASE} GROUP BY bk ORDER BY bk ${lim(buckets)}`,
			sessions: `WITH ${sessionsCte} SELECT sid, t0, t1, n, isnew, dev, art, job FROM s ORDER BY t0 DESC, sid ${lim(o.sessions + 1)}`,
			purchases:
				`SELECT e.t AS t, e.name AS name, e.sid AS sid, e.props AS props FROM ${table} e WHERE ${cond} AND e.kind = 'purchase' AND (e.src IS NULL OR e.src <> 'client') ` +
				`ORDER BY e.t DESC, e.sid ${lim(o.purchases + 1)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const w = windowOf(f);
		const firstDay = Math.floor(w.from / DAY_MS);
		const lastDay = Math.floor((w.to - 1) / DAY_MS);
		const days = Math.max(1, lastDay - firstDay + 1);
		// Dense buckets over the window.
		const byBucket = new Map<number, PlayerBucket>();
		const first = Math.floor(w.from / w.bucketMs);
		const last = Math.floor((w.to - 1) / w.bucketMs);
		for (let b = first; b <= last; b++) byBucket.set(b, { start: iso(b * w.bucketMs), sessions: 0, minutes: 0, robux: 0, purchases: 0 });
		for (const r of rows.activity) {
			const bucket = byBucket.get(num(r.bk));
			if (!bucket) continue;
			bucket.sessions = num(r.sessions);
			bucket.minutes = round(num(r.ms) / 60_000, 1);
		}
		let robux = 0;
		let purchases = 0;
		for (const r of rows.spend) {
			robux += num(r.robux);
			purchases += num(r.purchases);
			const bucket = byBucket.get(num(r.bk));
			if (!bucket) continue;
			bucket.robux = round(num(r.robux), 2);
			bucket.purchases = num(r.purchases);
		}
		const t = rows.totals[0] ?? {};
		const sessions = num(t.sessions);
		const playtimeMs = num(t.playtime_ms);
		return {
			pid: o.pid,
			window: { from: iso(w.from), to: iso(w.to), bucket: UNITS[w.bucketMs] ?? "day", bucketMs: w.bucketMs, days, clamped: w.clamped },
			totals: {
				sessions,
				events: num(t.events),
				playtimeMinutes: round(playtimeMs / 60_000, 1),
				avgSessionMinutes: sessions ? round(playtimeMs / sessions / 60_000, 1) : 0,
				medianSessionMinutes: sessions ? round(num(t.median_ms) / 60_000, 1) : 0,
				playtimePerDayMinutes: round(playtimeMs / days / 60_000, 1),
				activeDays: num(t.active_days),
				robux: round(robux, 2),
				purchases,
				firstSeen: sessions ? iso(num(t.first_t)) : null,
				lastSeen: sessions ? iso(num(t.last_t)) : null,
			},
			series: [...byBucket.values()],
			sessions: rows.sessions.slice(0, o.sessions).map((r) => ({
				sid: str(r.sid),
				start: iso(num(r.t0)),
				end: iso(num(r.t1)),
				minutes: round((num(r.t1) - num(r.t0)) / 60_000, 1),
				events: num(r.n),
				firstSession: num(r.isnew) === 1,
				dev: strOrNull(r.dev),
				art: str(r.art),
				job: strOrNull(r.job),
			})),
			sessionsTruncated: rows.sessions.length > o.sessions,
			purchases: rows.purchases.slice(0, o.purchases).map((r) => {
				const props = parseProps(r.props);
				const price = props[PROP_KEYS.purchaseRobux];
				return {
					time: iso(num(r.t)),
					t: num(r.t),
					kind: str(r.name),
					product: shortText(props[PROP_KEYS.purchaseProduct]),
					robux: typeof price === "number" && Number.isFinite(price) ? price : null,
					where: shortText(props.where),
					sid: strOrNull(r.sid) || null,
				};
			}),
			purchasesTruncated: rows.purchases.length > o.purchases,
		};
	},
});
