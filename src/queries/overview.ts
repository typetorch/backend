/** Overview, the Roblox-style numbers, retention by join-day cohort, and the busiest event names. */
import { PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import {
	ENDED_AFTER_MS,
	NOT_STUDIO,
	SESSIONS_CTE,
	sessionDaysCte,
	dayOf,
	defineQuery,
	eventsTable,
	int,
	intOption,
	iso,
	isoDay,
	num,
	playerRows,
	ratio,
	round,
	SERVER_PURCHASE,
	str,
	where,
	windowBucketMs,
	type QueryContext,
} from "./core.ts";
import type { NormalizedFilters } from "../sql/filters.ts";

function sessionCtes(ctx: QueryContext, f: NormalizedFilters, extraCols = "", extraWhere = ""): string {
	return `ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp${extraCols} FROM ${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx, extraWhere)}), ${SESSIONS_CTE}`;
}

// overview ------------------------------------------------------------------------------------------------------------

export interface OverviewDay {
	date: string;
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeHours: number;
}

/** One step of a window shorter than a day (1 min, 5 min or 1 h), by the time a session started. */
export interface OverviewBucket {
	/** Bucket start, unix ms. */
	t: number;
	time: string;
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeHours: number;
}

export interface OverviewResult {
	from: string;
	to: string;
	/** The chart step for this window (windowBucketMs): a day for windows over a day, else 1 h, 5 min or 1 min. */
	bucketMs: number;
	players: number;
	newPlayers: number;
	returningPlayers: number;
	sessions: number;
	events: number;
	playtimeHours: number;
	avgSessionMinutes: number;
	playtimePerPlayerMinutes: number;
	days: OverviewDay[];
	/** Windows of a day or less: the same numbers per bucketMs (buckets without sessions are left out). */
	buckets?: OverviewBucket[];
}

export const overview = defineQuery<Record<string, never>, OverviewResult>({
	name: "overview",
	summary: "players, new players, sessions and playtime, in total and per day (per hour, 5 min or minute for windows of a day or less)",
	defaultDays: 30,
	options: () => ({}),
	statements(ctx, f) {
		const lim = ctx.dialect.limit;
		const bucketMs = windowBucketMs(f.to - f.from);
		// Below a day: the same numbers per bucket (at most 78 rows; the window bounds the raw rows read).
		const buckets: Record<string, string> =
			bucketMs < DAY_MS
				? {
						buckets:
							`WITH ${sessionCtes(ctx, f)}, sb AS (SELECT pid, isnew, t1 - t0 AS len, CAST(floor(t0 / ${int(bucketMs)}.0) AS BIGINT) AS b FROM s) ` +
							`SELECT b, COUNT(DISTINCT pid) AS players, COUNT(DISTINCT CASE WHEN isnew = 1 THEN pid END) AS new_players, ` +
							`COUNT(*) AS sessions, SUM(len) AS playtime_ms FROM sb GROUP BY b ORDER BY b ${lim(1000)}`,
					}
				: {};
		return {
			...buckets,
			days:
				`WITH ${sessionCtes(ctx, f)}, sd AS (SELECT pid, isnew, t1 - t0 AS len, ${dayOf("t0")} AS day FROM s) ` +
				`SELECT day, COUNT(DISTINCT pid) AS players, COUNT(DISTINCT CASE WHEN isnew = 1 THEN pid END) AS new_players, ` +
				`COUNT(*) AS sessions, SUM(len) AS playtime_ms FROM sd GROUP BY day ORDER BY day ${lim(10_000)}`,
			totals:
				`WITH ${sessionCtes(ctx, f)} SELECT COUNT(DISTINCT pid) AS players, COUNT(DISTINCT CASE WHEN isnew = 1 THEN pid END) AS new_players, ` +
				`COUNT(*) AS sessions, SUM(t1 - t0) AS playtime_ms FROM s ${lim(1)}`,
			events: `SELECT COUNT(*) AS events FROM ${eventsTable(ctx, f)} e WHERE ${where(f, ctx)} ${lim(1)}`,
		};
	},
	shape(rows, _ctx, f) {
		const bucketMs = windowBucketMs(f.to - f.from);
		const t = rows.totals[0] ?? {};
		const players = num(t.players);
		const newPlayers = num(t.new_players);
		const sessions = num(t.sessions);
		const playtime = num(t.playtime_ms);
		return {
			from: iso(f.from),
			to: iso(f.to),
			bucketMs,
			players,
			newPlayers,
			returningPlayers: players - newPlayers,
			sessions,
			events: num(rows.events[0]?.events),
			playtimeHours: round(playtime / 3_600_000, 1),
			avgSessionMinutes: sessions ? round(playtime / sessions / 60_000, 1) : 0,
			playtimePerPlayerMinutes: players ? round(playtime / players / 60_000, 1) : 0,
			days: rows.days.map((r) => ({
				date: isoDay(num(r.day)),
				players: num(r.players),
				newPlayers: num(r.new_players),
				sessions: num(r.sessions),
				playtimeHours: round(num(r.playtime_ms) / 3_600_000, 1),
			})),
			...(rows.buckets
				? {
						buckets: rows.buckets.map((r) => {
							const at = num(r.b) * bucketMs;
							return {
								t: at,
								time: iso(at),
								players: num(r.players),
								newPlayers: num(r.new_players),
								sessions: num(r.sessions),
								playtimeHours: round(num(r.playtime_ms) / 3_600_000, 2),
							};
						}),
					}
				: {}),
		};
	},
});

// roblox: the Roblox-style numbers --------------------------------------------------------------------------------------

export interface RobloxOptions {
	/** A session this long or longer is a qualified play. Default 5 minutes. */
	qualifiedMinutes: number;
	/** A first session shorter than this is a first-play bounce. Default 60 seconds. */
	bounceSeconds: number;
	/** props key of the Robux amount on purchase rows. */
	robuxKey: string;
}

export interface Rate {
	rate: number;
	count: number;
	of: number;
}

export interface RobloxResult {
	from: string;
	to: string;
	players: number;
	/** New players whose first session was shorter than bounceSeconds (sessions still running are left out). */
	firstPlayBounce: Rate & { seconds: number };
	/** Sessions of at least qualifiedMinutes. */
	qualifiedPlays: Rate & { minutes: number };
	/** New players (first session in the range) who played again exactly 1 / 7 days later. Days not over yet are left out. */
	d1Retention: Rate;
	d7Retention: Rate;
	playtimePerUserMinutes: number;
	playDaysPerUser: number;
	payerConversion: Rate;
	robuxPerUser: number;
	robuxPerPayer: number;
	purchases: number;
}

/**
 * `c(pid, cday)`: new players whose first session started in the range, with their join day (UTC): the cohort is the
 * first play date, as on Roblox. Studio play tests don't count.
 */
function cohortCte(ctx: QueryContext, f: NormalizedFilters): string {
	return `c AS (SELECT e.pid AS pid, ${dayOf("MIN(e.t)")} AS cday FROM ${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx, `e.newp = TRUE AND ${NOT_STUDIO}`)} GROUP BY e.pid)`;
}

/** `c` plus `a(pid, day)`: the days a player started a session, from the range start to `windowDays` after its end. */
function cohortCtes(ctx: QueryContext, f: NormalizedFilters, windowDays: number): string {
	return `${cohortCte(ctx, f)}, ${sessionDaysCte(ctx, f.from, f.to + windowDays * DAY_MS)}`;
}

export const roblox = defineQuery<RobloxOptions, RobloxResult>({
	name: "roblox",
	summary: "Roblox-style numbers: first-play bounce, qualified plays, D1/D7, playtime and play days per user, payer conversion, Robux per user",
	defaultDays: 30,
	options: (input = {}) => ({
		qualifiedMinutes: intOption(input.qualifiedMinutes, "qualifiedMinutes", 5, 1, 240),
		bounceSeconds: intOption(input.bounceSeconds, "bounceSeconds", 60, 5, 3600),
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const ended = int(ctx.now - ENDED_AFTER_MS);
		const today = Math.floor(ctx.now / DAY_MS);
		const robux = ctx.dialect.jsonNumber("props", o.robuxKey);
		return {
			numbers:
				`WITH ${sessionCtes(ctx, f, ", e.kind AS kind, e.props AS props, e.src AS esrc", NOT_STUDIO)}, ` +
				`p AS (SELECT pid, SUM(t1 - t0) AS playtime, COUNT(DISTINCT day0) AS days FROM (SELECT pid, t0, t1, ${dayOf("t0")} AS day0 FROM s) x GROUP BY pid), ` +
				`pu AS (SELECT pid, SUM(COALESCE(robux, 0)) AS robux, COUNT(*) AS purchases FROM (SELECT pid, ${robux} AS robux FROM ev WHERE kind = 'purchase' AND ${SERVER_PURCHASE}) y GROUP BY pid) ` +
				`SELECT a.players, a.playtime_ms, a.play_days, b.sessions, b.qualified, b.first_sessions, b.bounced, c.payers, c.robux, c.purchases ` +
				`FROM (SELECT COUNT(*) AS players, SUM(playtime) AS playtime_ms, SUM(days) AS play_days FROM p) a ` +
				`CROSS JOIN (SELECT COUNT(*) AS sessions, SUM(CASE WHEN t1 - t0 >= ${int(o.qualifiedMinutes * 60_000)} THEN 1 ELSE 0 END) AS qualified, ` +
				`SUM(CASE WHEN isnew = 1 AND t1 < ${ended} THEN 1 ELSE 0 END) AS first_sessions, ` +
				`SUM(CASE WHEN isnew = 1 AND t1 < ${ended} AND t1 - t0 < ${int(o.bounceSeconds * 1000)} THEN 1 ELSE 0 END) AS bounced FROM s) b ` +
				`CROSS JOIN (SELECT COUNT(*) AS payers, SUM(robux) AS robux, SUM(purchases) AS purchases FROM pu) c ${lim(1)}`,
			retention:
				`WITH ${cohortCtes(ctx, f, 8)}, ` +
				`r AS (SELECT c.pid AS pid, c.cday AS cday, MAX(CASE WHEN a.day = c.cday + 1 THEN 1 ELSE 0 END) AS d1, MAX(CASE WHEN a.day = c.cday + 7 THEN 1 ELSE 0 END) AS d7 FROM c LEFT JOIN a ON a.pid = c.pid GROUP BY c.pid, c.cday) ` +
				`SELECT SUM(CASE WHEN cday + 1 < ${int(today)} THEN 1 ELSE 0 END) AS d1_cohort, SUM(CASE WHEN cday + 1 < ${int(today)} THEN d1 ELSE 0 END) AS d1_kept, ` +
				`SUM(CASE WHEN cday + 7 < ${int(today)} THEN 1 ELSE 0 END) AS d7_cohort, SUM(CASE WHEN cday + 7 < ${int(today)} THEN d7 ELSE 0 END) AS d7_kept FROM r ${lim(1)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const n = rows.numbers[0] ?? {};
		const r = rows.retention[0] ?? {};
		const players = num(n.players);
		const payers = num(n.payers);
		const robux = num(n.robux);
		const rate = (count: number, of: number): Rate => ({ rate: ratio(count, of), count, of });
		return {
			from: iso(f.from),
			to: iso(f.to),
			players,
			firstPlayBounce: { ...rate(num(n.bounced), num(n.first_sessions)), seconds: o.bounceSeconds },
			qualifiedPlays: { ...rate(num(n.qualified), num(n.sessions)), minutes: o.qualifiedMinutes },
			d1Retention: rate(num(r.d1_kept), num(r.d1_cohort)),
			d7Retention: rate(num(r.d7_kept), num(r.d7_cohort)),
			playtimePerUserMinutes: players ? round(num(n.playtime_ms) / players / 60_000, 1) : 0,
			playDaysPerUser: players ? round(num(n.play_days) / players, 2) : 0,
			payerConversion: rate(payers, players),
			robuxPerUser: players ? round(robux / players, 2) : 0,
			robuxPerPayer: payers ? round(robux / payers, 2) : 0,
			purchases: num(n.purchases),
		};
	},
});

// retention by join-day cohort --------------------------------------------------------------------------------------

export interface RetentionOptions {
	/** Day offsets to report (default 1, 3, 7, 14, 30). */
	days: number[];
}

export interface RetentionCohort {
	date: string;
	size: number;
	/** offset -> share kept; null while that day isn't over yet. */
	kept: Record<string, number | null>;
	keptPlayers: Record<string, number | null>;
}

export interface RetentionResult {
	from: string;
	to: string;
	days: number[];
	cohorts: RetentionCohort[];
	/** Weighted over the cohorts whose day is over. */
	average: Record<string, number | null>;
}

export const retention = defineQuery<RetentionOptions, RetentionResult>({
	name: "retention",
	summary: "retention by join-day cohort (share of new players back on day 1, 3, 7, 14, 30)",
	defaultDays: 30,
	options: (input = {}) => {
		const days = input.days ?? [1, 3, 7, 14, 30];
		if (!Array.isArray(days) || days.length === 0 || days.length > 12 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 90)) {
			throw new Error("days must be 1-12 whole numbers from 1 to 90");
		}
		return { days: [...new Set(days)].sort((a, b) => a - b) };
	},
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const window = Math.max(...o.days) + 1;
		return {
			cohorts: `WITH ${cohortCte(ctx, f)} SELECT cday, COUNT(*) AS size FROM c GROUP BY cday ORDER BY cday ${lim(10_000)}`,
			kept:
				`WITH ${cohortCtes(ctx, f, window)} ` +
				`SELECT cday, k, COUNT(DISTINCT pid) AS kept FROM (SELECT c.pid AS pid, c.cday AS cday, a.day - c.cday AS k FROM c JOIN a ON a.pid = c.pid) x ` +
				`WHERE k IN (${o.days.map((d) => int(d)).join(", ")}) GROUP BY cday, k ORDER BY cday, k ${lim(10_000)}`,
		};
	},
	shape(rows, ctx, f, o) {
		const today = Math.floor(ctx.now / DAY_MS);
		const kept = new Map<string, number>();
		for (const r of rows.kept) kept.set(`${num(r.cday)}:${num(r.k)}`, num(r.kept));
		const sums: Record<string, { kept: number; size: number }> = {};
		const cohorts = rows.cohorts.map((r) => {
			const cday = num(r.cday);
			const size = num(r.size);
			const out: RetentionCohort = { date: isoDay(cday), size, kept: {}, keptPlayers: {} };
			for (const d of o.days) {
				if (cday + d >= today) {
					out.kept[d] = null;
					out.keptPlayers[d] = null;
					continue;
				}
				const k = kept.get(`${cday}:${d}`) ?? 0;
				out.kept[d] = ratio(k, size);
				out.keptPlayers[d] = k;
				sums[d] ??= { kept: 0, size: 0 };
				sums[d].kept += k;
				sums[d].size += size;
			}
			return out;
		});
		const average: Record<string, number | null> = {};
		for (const d of o.days) average[d] = sums[d] ? ratio(sums[d].kept, sums[d].size) : null;
		return { from: iso(f.from), to: iso(f.to), days: o.days, cohorts, average };
	},
});

// top events ------------------------------------------------------------------------------------------------------------

export interface TopEventsResult {
	events: { kind: string; name: string; count: number; players: number }[];
}

export const topEvents = defineQuery<{ limit: number }, TopEventsResult>({
	name: "top-events",
	summary: "the most logged event names per kind",
	defaultDays: 7,
	options: (input = {}) => ({ limit: intOption(input.limit, "limit", 100, 1, 10_000) }),
	statements(ctx, f, o) {
		return {
			events:
				`SELECT e.kind AS kind, e.name AS name, COUNT(*) AS n, COUNT(DISTINCT e.pid) AS players FROM ${eventsTable(ctx, f)} e ` +
				`WHERE ${where(f, ctx)} GROUP BY e.kind, e.name ORDER BY n DESC, kind, name ${ctx.dialect.limit(o.limit)}`,
		};
	},
	shape: (rows) => ({ events: rows.events.map((r) => ({ kind: str(r.kind), name: str(r.name), count: num(r.n), players: num(r.players) })) }),
});
