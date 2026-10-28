/**
 * The numbers behind a Creator-Hub-style overview, from our own events, computed the way Roblox defines them
 * (create.roblox.com/docs/production/analytics; README "Queries", "Roblox parity"):
 *   benchmarks — the headline metrics for the last N full UTC days and the N days before (period over period);
 *   realtime   — concurrent users from fleet heartbeats (hourly peak and average, N days), and session time, client
 *                errors per session, client fps and server memory for the last H hours vs the H hours before;
 *   trends     — per day, N-day moving averages of new users, daily active users, average session time, playtime per
 *                active user, revenue and D1 retention, in total and per join source (session/join `from`).
 *
 * The rules, shared by the three:
 *   - Days are UTC (midnight to midnight), like Roblox's daily buckets. Only full days count: today isn't over.
 *   - A session is one `sid`, from its first to its last event, counted on the day it started (DAU = players who
 *     joined at least once that day). No minimum length. Sessions crossing a window's edge keep their real start and
 *     length (the queries read SESSION_SLACK_MS around the window).
 *   - Studio play tests (`srv = studio`) don't count (Roblox's analytics are published games only); private and
 *     reserved servers do.
 *   - Retention is by cohort: new players by their first play date, back when a later session started exactly
 *     N days after it.
 *   - A ratio over several days (average session time, playtime per DAU, payer conversion, ARPPU, ARPDAU, D1/D7/D30) is
 *     the mean of its daily values, as Roblox's 7-day averages are. Counts (DAU, new users, revenue) are averaged
 *     over all days of the window.
 *   - Revenue is the Robux the creator keeps: the price players paid times `creatorShare` (0.7: Roblox keeps 30% of
 *     developer product and pass sales). Robux spent (the price) is returned too.
 * Roblox's own Home / Search split isn't visible to games: those joins are `direct`.
 */
import { FLEET_HEARTBEAT, PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import { whereSql, type NormalizedFilters } from "../sql/filters.ts";
import {
	ENDED_AFTER_MS,
	NOT_STUDIO,
	SERVER_PURCHASE,
	SESSIONS_CTE,
	SESSION_SLACK_MS,
	dayOf,
	defineQuery,
	int,
	intOption,
	iso,
	isoDay,
	meanOf,
	num,
	numOrNull,
	playerRows,
	round,
	sessionDaysCte,
	str,
	type QueryContext,
	type Row,
} from "./core.ts";

const HOUR_MS = 3_600_000;

interface Rate {
	rate: number;
	count: number;
	of: number;
}

/**
 * A retention rate over a window of cohort days, and how much of that window the data covers: `complete` when there
 * were events from the first cohort day on, `partial` when the events start inside the window (`dataFrom`, the cohorts
 * before it are missing), `none` when they start after it (a game tracked for 10 days has no D30 cohort yet) or there
 * are no events at all (`dataFrom` null). `rate` / `count` / `of` are 0 when `none`.
 */
export interface Retention extends Rate {
	cohortFrom: string;
	cohortTo: string;
	history: "complete" | "partial" | "none";
	/** The first UTC day with a session in the data read for the cohorts (the first cohort day at the earliest). */
	dataFrom: string | null;
}

/** Roblox keeps 30% of developer product and pass sales; the creator gets the rest. */
export const DEFAULT_CREATOR_SHARE = 0.7;

function shareOption(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_CREATOR_SHARE;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1) throw new Error("creatorShare must be a number above 0 and at most 1");
	return n;
}

const rate4 = (v: number | null) => (v === null ? 0 : Math.round(v * 10_000) / 10_000);

/** A rate as the mean of daily rates (days whose base is above 0); count and of are the sums. */
function meanRate(points: { count: number; of: number }[]): Rate {
	const count = points.reduce((s, p) => s + p.count, 0);
	const of = points.reduce((s, p) => s + p.of, 0);
	return { rate: rate4(meanOf(points.map((p) => (p.of > 0 ? p.count / p.of : null)))), count, of };
}

const minutesOrNull = (v: number | null) => (v === null ? null : round(v / 60_000, 2));

/** Player events in [from, to) with the filters (time replaced), Studio play tests left out. */
function playerEvents(ctx: QueryContext, f: NormalizedFilters, from: number, to: number, cols: string): string {
	const fr: NormalizedFilters = { ...f, from, to };
	return `SELECT ${cols} FROM ${ctx.table("events", from, to)} e WHERE ${playerRows(fr, ctx, NOT_STUDIO)}`;
}

/** The last full UTC day at or before `to` (today isn't over, so at most yesterday). */
function lastFullDay(ctx: QueryContext, to: number): number {
	return Math.min(Math.floor((to - 1) / DAY_MS), Math.floor(ctx.now / DAY_MS) - 1);
}

// benchmarks -------------------------------------------------------------------------------------------------------

export interface BenchmarkOptions {
	/** Period length in days (default 7). */
	days: number;
	/** A session this long or longer is a qualified play (default 5 minutes). */
	qualifiedMinutes: number;
	robuxKey: string;
	/** Share of the price the creator keeps (default 0.7); revenue = Robux spent x this. 1 = Robux spent. */
	creatorShare: number;
}

export interface BenchmarkPeriod {
	/** The period's first day, 00:00 UTC, and the end of its last day (exclusive). */
	from: string;
	to: string;
	/** Players with a session in the period. */
	players: number;
	/** Players whose first-ever session started in the period. */
	newUsers: number;
	/** Daily active users, averaged over the period's days. */
	dau: number;
	/** Monthly active users: distinct players in the 30 UTC days ending on the period's last day (Roblox's trailing MAU). */
	mau: number;
	sessions: number;
	/** Roblox's "Average session time": per day playtime / sessions, the mean of the days. Minutes. */
	avgSessionMinutes: number | null;
	/** Roblox's "Average playtime": per day playtime / DAU, the mean of the days. Minutes. */
	avgPlaytimeMinutes: number | null;
	/** New players by first play date, back on day 1 / 7 / 30: the `days` latest cohorts whose day 1 / 7 / 30 is over. */
	d1Retention: Retention;
	d7Retention: Retention;
	d30Retention: Retention;
	/** Paying DAU / DAU per day, the mean of the days (count = payer-days, of = player-days). */
	payerConversion: Rate;
	/** Revenue / paying users per day, the mean of the days with payers; null without any. */
	arppu: number | null;
	/** Revenue / DAU per day, the mean of the days with players; null without any. */
	arpdau: number | null;
	/** Robux players spent (the prices). */
	robux: number;
	/** The creator's estimated revenue: robux x creatorShare, rounded. */
	revenue: number;
	/** Ours: first sessions (over) that lasted at least qualifiedMinutes, out of all first sessions that are over. */
	playThrough: Rate & { minutes: number };
}

export interface BenchmarksResult {
	days: number;
	creatorShare: number;
	current: BenchmarkPeriod;
	previous: BenchmarkPeriod;
}

export const benchmarks = defineQuery<BenchmarkOptions, BenchmarksResult>({
	name: "benchmarks",
	summary: "headline metrics as Roblox defines them (DAU, MAU, new users, session time, playtime per DAU, D1/D7/D30, payer conversion, ARPPU, ARPDAU, revenue) for the last N full UTC days and the N days before",
	defaultDays: 7,
	options: (input = {}) => ({
		days: intOption(input.days, "days", 7, 1, 90),
		qualifiedMinutes: intOption(input.qualifiedMinutes, "qualifiedMinutes", 5, 1, 240),
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
		creatorShare: shareOption(input.creatorShare),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const lastDay = lastFullDay(ctx, f.to);
		const curStart = lastDay - o.days + 1;
		const prevStart = curStart - o.days;
		const pFrom = prevStart * DAY_MS;
		const pTo = (lastDay + 1) * DAY_MS;
		const ended = int(ctx.now - ENDED_AFTER_MS);
		const robux = ctx.dialect.jsonNumber("props", o.robuxKey);
		const sessions =
			`WITH ev AS (${playerEvents(ctx, f, pFrom - SESSION_SLACK_MS, pTo + SESSION_SLACK_MS, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp, e.kind AS kind, e.props AS props, e.src AS esrc")}), ${SESSIONS_CTE}, ` +
			`sd AS (SELECT pid, t0, t1, isnew, ${dayOf("t0")} AS day FROM s WHERE t0 >= ${int(pFrom)} AND t0 < ${int(pTo)})`;
		// Retention: cohorts back to 30 days before the previous period's first return day.
		const cohortFrom = (prevStart - 30) * DAY_MS;
		// MAU: the 30 days ending on each period's last day.
		const mauFrom = (lastDay - o.days - 29) * DAY_MS;
		const fc: NormalizedFilters = { ...f, from: cohortFrom, to: pTo };
		return {
			daily:
				`${sessions}, ` +
				`d AS (SELECT day, COUNT(DISTINCT pid) AS dau, COUNT(DISTINCT CASE WHEN isnew = 1 THEN pid END) AS new_users, COUNT(*) AS sessions, SUM(t1 - t0) AS playtime_ms, ` +
				`SUM(CASE WHEN isnew = 1 AND t1 < ${ended} THEN 1 ELSE 0 END) AS first_sessions, ` +
				`SUM(CASE WHEN isnew = 1 AND t1 < ${ended} AND t1 - t0 >= ${int(o.qualifiedMinutes * 60_000)} THEN 1 ELSE 0 END) AS first_qualified FROM sd GROUP BY day), ` +
				`pdays AS (SELECT DISTINCT pid, day FROM sd), ` +
				`pu AS (SELECT pid, ${dayOf("t")} AS day, robux FROM (SELECT pid, t, ${robux} AS robux FROM ev WHERE kind = 'purchase' AND ${SERVER_PURCHASE} AND t >= ${int(pFrom)} AND t < ${int(pTo)}) q), ` +
				// Paying users are daily active users who bought something that day; revenue counts every purchase.
				`pay AS (SELECT pu.day AS day, COUNT(DISTINCT pdays.pid) AS payers, SUM(COALESCE(pu.robux, 0)) AS robux FROM pu LEFT JOIN pdays ON pdays.pid = pu.pid AND pdays.day = pu.day GROUP BY pu.day) ` +
				`SELECT COALESCE(d.day, pay.day) AS day, d.dau AS dau, d.new_users AS new_users, d.sessions AS sessions, d.playtime_ms AS playtime_ms, ` +
				`d.first_sessions AS first_sessions, d.first_qualified AS first_qualified, pay.payers AS payers, pay.robux AS robux ` +
				`FROM d FULL OUTER JOIN pay ON pay.day = d.day ORDER BY day ${lim(1000)}`,
			players:
				`${sessions} SELECT CASE WHEN day >= ${int(curStart)} THEN 1 ELSE 0 END AS cur, COUNT(DISTINCT pid) AS players, ` +
				`COUNT(DISTINCT CASE WHEN isnew = 1 THEN pid END) AS new_users FROM sd GROUP BY CASE WHEN day >= ${int(curStart)} THEN 1 ELSE 0 END ORDER BY cur ${lim(10)}`,
			retention:
				`WITH c AS (SELECT e.pid AS pid, ${dayOf("MIN(e.t)")} AS cday FROM ${ctx.table("events", cohortFrom, pTo)} e WHERE ${playerRows(fc, ctx, `e.newp = TRUE AND ${NOT_STUDIO}`)} GROUP BY e.pid), ` +
				`${sessionDaysCte(ctx, cohortFrom, pTo)}, ` +
				`r AS (SELECT c.pid AS pid, c.cday AS cday, MAX(CASE WHEN a.day = c.cday + 1 THEN 1 ELSE 0 END) AS k1, MAX(CASE WHEN a.day = c.cday + 7 THEN 1 ELSE 0 END) AS k7, ` +
				`MAX(CASE WHEN a.day = c.cday + 30 THEN 1 ELSE 0 END) AS k30 FROM c LEFT JOIN a ON a.pid = c.pid GROUP BY c.pid, c.cday) ` +
				`SELECT cday, COUNT(*) AS cohort, SUM(k1) AS k1, SUM(k7) AS k7, SUM(k30) AS k30 FROM r GROUP BY cday ORDER BY cday ${lim(1000)}`,
			// The first day with any session since the earliest cohort day read: tells a cohort window with no new
			// players ("0 of 0") apart from one the data doesn't reach (tracking started later).
			history: `WITH ${sessionDaysCte(ctx, cohortFrom, pTo)} SELECT MIN(day) AS first_day FROM a ${lim(1)}`,
			mau:
				`WITH ev AS (${playerEvents(ctx, f, mauFrom - SESSION_SLACK_MS, pTo, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp")}), ${SESSIONS_CTE}, ` +
				`sd AS (SELECT pid, ${dayOf("t0")} AS day FROM s WHERE t0 >= ${int(mauFrom)} AND t0 < ${int(pTo)}) ` +
				`SELECT COUNT(DISTINCT CASE WHEN day >= ${int(lastDay - 29)} THEN pid END) AS cur_mau, ` +
				`COUNT(DISTINCT CASE WHEN day <= ${int(lastDay - o.days)} THEN pid END) AS prev_mau FROM sd ${lim(1)}`,
		};
	},
	shape(rows, ctx, f, o) {
		const lastDay = lastFullDay(ctx, f.to);
		const curStart = lastDay - o.days + 1;
		const daily = new Map<number, Row>(rows.daily.map((r) => [num(r.day), r]));
		const cohorts = new Map<number, Row>(rows.retention.map((r) => [num(r.cday), r]));
		const firstDay = numOrNull(rows.history[0]?.first_day);
		const retention = (k: 1 | 7 | 30, first: number, last: number): Retention => ({
			...meanRate(
				Array.from({ length: last - first + 1 }, (_, i) => {
					const r = cohorts.get(first + i);
					return { count: num(r?.[`k${k}`]), of: num(r?.cohort) };
				}),
			),
			cohortFrom: isoDay(first),
			cohortTo: isoDay(last),
			history: firstDay === null || firstDay > last ? "none" : firstDay > first ? "partial" : "complete",
			dataFrom: firstDay === null ? null : isoDay(firstDay),
		});
		const period = (cur: 0 | 1): BenchmarkPeriod => {
			const start = cur ? curStart : curStart - o.days;
			const days = Array.from({ length: o.days }, (_, i) => {
				const r = daily.get(start + i) ?? {};
				return {
					dau: num(r.dau),
					sessions: num(r.sessions),
					playtime: num(r.playtime_ms),
					payers: num(r.payers),
					revenue: num(r.robux) * o.creatorShare,
					robux: num(r.robux),
					first: num(r.first_sessions),
					qualified: num(r.first_qualified),
				};
			});
			const sum = (k: keyof (typeof days)[number]) => days.reduce((s, d) => s + d[k], 0);
			const p = rows.players.find((x) => num(x.cur) === cur) ?? {};
			const arppu = meanOf(days.map((d) => (d.payers > 0 ? d.revenue / d.payers : null)));
			const arpdau = meanOf(days.map((d) => (d.dau > 0 ? d.revenue / d.dau : null)));
			const first = sum("first");
			return {
				from: iso(start * DAY_MS),
				to: iso((start + o.days) * DAY_MS),
				players: num(p.players),
				newUsers: num(p.new_users),
				dau: round(sum("dau") / o.days, 2),
				mau: num(rows.mau[0]?.[cur ? "cur_mau" : "prev_mau"]),
				sessions: sum("sessions"),
				avgSessionMinutes: minutesOrNull(meanOf(days.map((d) => (d.sessions > 0 ? d.playtime / d.sessions : null)))),
				avgPlaytimeMinutes: minutesOrNull(meanOf(days.map((d) => (d.dau > 0 ? d.playtime / d.dau : null)))),
				d1Retention: retention(1, start - 1, start + o.days - 2),
				d7Retention: retention(7, start - 7, start + o.days - 8),
				d30Retention: retention(30, start - 30, start + o.days - 31),
				payerConversion: meanRate(days.map((d) => ({ count: d.payers, of: d.dau }))),
				arppu: arppu === null ? null : round(arppu, 2),
				arpdau: arpdau === null ? null : round(arpdau, 3),
				robux: sum("robux"),
				revenue: Math.round(sum("revenue")),
				playThrough: { rate: first ? Math.round((sum("qualified") / first) * 10_000) / 10_000 : 0, count: sum("qualified"), of: first, minutes: o.qualifiedMinutes },
			};
		};
		return { days: o.days, creatorShare: o.creatorShare, current: period(1), previous: period(0) };
	},
});

// realtime ---------------------------------------------------------------------------------------------------------

export interface RealtimeOptions {
	/** Window for the period-over-period numbers, hours (default 24). */
	hours: number;
	/** Days of concurrent-user history (default 7). */
	ccuDays: number;
}

export interface RealtimeWindow {
	sessions: number;
	/** Average length of the sessions that started in the window and are over, minutes. */
	avgSessionMinutes: number | null;
	/** tech/error rows sent by clients (each counts its `n`). */
	clientErrors: number;
	errorsPerSession: number | null;
	/** Average of tech/client `fps`. */
	clientFps: number | null;
	/** Average of tech/server `mem` (MB). */
	serverMemoryMb: number | null;
}

export interface RealtimeResult {
	hours: number;
	current: RealtimeWindow;
	previous: RealtimeWindow;
	ccu: {
		/** Players on servers that sent a heartbeat in the last 2 minutes (the newest minute's sum). */
		now: number;
		/** Per hour (UTC): the peak minute (Roblox's "Peak concurrent players") and the average (minutes without heartbeats count as 0). */
		series: { hour: string; avg: number; peak: number }[];
		currentAvg: number;
		previousAvg: number;
		/** The highest minute in the last `hours` and in the hours before. */
		currentPeak: number;
		previousPeak: number;
	};
}

export const realtime = defineQuery<RealtimeOptions, RealtimeResult>({
	name: "realtime",
	summary: "concurrent users per hour (peak and average) from fleet heartbeats; session time, client errors per session, client fps, server memory: last hours vs the hours before",
	defaultDays: 7,
	options: (input = {}) => ({
		hours: intOption(input.hours, "hours", 24, 1, 168),
		ccuDays: intOption(input.ccuDays, "ccuDays", 7, 1, 30),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const d = ctx.dialect;
		const now = ctx.now;
		const mid = now - o.hours * HOUR_MS;
		const from = now - 2 * o.hours * HOUR_MS;
		const ended = int(now - ENDED_AFTER_MS);
		const ccuFrom = Math.floor((now - o.ccuDays * DAY_MS) / HOUR_MS) * HOUR_MS;
		// Server rows (tech/server, fleet) have no player: only the branch / artifact / place filters apply to them.
		const serverFilters: NormalizedFilters = { from, to: now, ...(f.branch ? { branch: f.branch } : {}), ...(f.art ? { art: f.art } : {}), ...(f.place !== undefined ? { place: f.place } : {}) };
		const fleetFilters: NormalizedFilters = { ...serverFilters, from: ccuFrom };
		// Heartbeats carry the server type in props.t; Studio play tests aren't players.
		const notStudioServer = `COALESCE(${d.jsonText("e.props", "t")}, '') <> 'studio'`;
		return {
			sessions:
				`WITH ev AS (${playerEvents(ctx, f, from - SESSION_SLACK_MS, now, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp")}), ${SESSIONS_CTE} ` +
				`SELECT CASE WHEN t0 >= ${int(mid)} THEN 1 ELSE 0 END AS cur, COUNT(*) AS sessions, ` +
				`SUM(CASE WHEN t1 < ${ended} THEN t1 - t0 ELSE 0 END) AS ended_ms, SUM(CASE WHEN t1 < ${ended} THEN 1 ELSE 0 END) AS ended_n FROM s WHERE t0 >= ${int(from)} GROUP BY CASE WHEN t0 >= ${int(mid)} THEN 1 ELSE 0 END ORDER BY cur ${lim(10)}`,
			tech:
				`SELECT cur, AVG(CASE WHEN name = 'client' THEN fps END) AS fps, AVG(CASE WHEN name = 'server' THEN mem END) AS mem, ` +
				`SUM(CASE WHEN name = 'error' AND src = 'client' THEN COALESCE(n, 1) ELSE 0 END) AS errors ` +
				`FROM (SELECT CASE WHEN e.t >= ${int(mid)} THEN 1 ELSE 0 END AS cur, e.name AS name, e.src AS src, ${d.jsonNumber("e.props", "fps")} AS fps, ` +
				`${d.jsonNumber("e.props", "mem")} AS mem, ${d.jsonNumber("e.props", "n")} AS n FROM ${ctx.table("events", from, now)} e ` +
				`WHERE ${whereSql(serverFilters, d, { prefix: "e." })} AND e.kind = 'tech' AND ${NOT_STUDIO}) x GROUP BY cur ORDER BY cur ${lim(10)}`,
			ccu:
				`WITH hb AS (SELECT e.job AS job, CAST(floor(e.t / 60000.0) AS BIGINT) AS minute, ${d.jsonNumber("e.props", "n")} AS players FROM ${ctx.table("events", ccuFrom, now)} e ` +
				`WHERE ${whereSql(fleetFilters, d, { prefix: "e." })} AND e.kind = 'fleet' AND e.name = '${FLEET_HEARTBEAT}' AND ${notStudioServer}), ` +
				`pm AS (SELECT minute, job, MAX(COALESCE(players, 0)) AS players FROM hb GROUP BY minute, job), ` +
				`m AS (SELECT minute, SUM(players) AS ccu FROM pm GROUP BY minute) ` +
				`SELECT CAST(floor(minute / 60.0) AS BIGINT) AS hour, SUM(ccu) AS ccu_sum, MAX(ccu) AS peak, MAX(minute) AS last_minute FROM m GROUP BY CAST(floor(minute / 60.0) AS BIGINT) ORDER BY hour ${lim(10_000)}`,
			ccuNow:
				`WITH hb AS (SELECT e.job AS job, e.t AS t, ${d.jsonNumber("e.props", "n")} AS players, ROW_NUMBER() OVER (PARTITION BY e.job ORDER BY e.t DESC) AS rn ` +
				`FROM ${ctx.table("events", now - 120_000, now + 60_000)} e WHERE ${whereSql({ ...serverFilters, from: now - 120_000, to: now + 60_000 }, d, { prefix: "e." })} ` +
				`AND e.kind = 'fleet' AND e.name = '${FLEET_HEARTBEAT}' AND ${notStudioServer}) SELECT SUM(COALESCE(players, 0)) AS players FROM hb WHERE rn = 1 ${lim(1)}`,
		};
	},
	shape(rows, ctx, _f, o) {
		const window = (cur: 0 | 1): RealtimeWindow => {
			const s = rows.sessions.find((x) => num(x.cur) === cur) ?? {};
			const t = rows.tech.find((x) => num(x.cur) === cur) ?? {};
			const sessions = num(s.sessions);
			const errors = num(t.errors);
			const fps = numOrNull(t.fps);
			const mem = numOrNull(t.mem);
			return {
				sessions,
				avgSessionMinutes: num(s.ended_n) ? round(num(s.ended_ms) / num(s.ended_n) / 60_000, 2) : null,
				clientErrors: errors,
				errorsPerSession: sessions ? round(errors / sessions, 3) : null,
				clientFps: fps === null ? null : round(fps, 1),
				serverMemoryMb: mem === null ? null : round(mem, 0),
			};
		};
		const byHour = new Map(rows.ccu.map((r) => [num(r.hour), { avg: num(r.ccu_sum) / 60, peak: num(r.peak) }]));
		const firstHour = Math.floor((ctx.now - o.ccuDays * DAY_MS) / HOUR_MS);
		const lastHour = Math.floor(ctx.now / HOUR_MS);
		const series: RealtimeResult["ccu"]["series"] = [];
		for (let h = firstHour; h <= lastHour; h++) {
			const v = byHour.get(h);
			// The current hour isn't over: average over the minutes so far.
			const minutes = h === lastHour ? Math.max(1, Math.floor((ctx.now - h * HOUR_MS) / 60_000)) : 60;
			series.push({ hour: iso(h * HOUR_MS), avg: v ? round((v.avg * 60) / minutes, 2) : 0, peak: v?.peak ?? 0 });
		}
		const hoursBack = (a: number, b: number) => series.filter((p) => {
			const t = Date.parse(p.hour);
			return t >= ctx.now - a * HOUR_MS && t < ctx.now - b * HOUR_MS;
		});
		const mean = (points: { avg: number }[]) => (points.length ? round(points.reduce((s, p) => s + p.avg, 0) / points.length, 2) : 0);
		const peak = (points: { peak: number }[]) => points.reduce((m, p) => Math.max(m, p.peak), 0);
		return {
			hours: o.hours,
			current: window(1),
			previous: window(0),
			ccu: {
				now: num(rows.ccuNow[0]?.players),
				series,
				currentAvg: mean(hoursBack(o.hours, 0)),
				previousAvg: mean(hoursBack(2 * o.hours, o.hours)),
				currentPeak: peak(hoursBack(o.hours, 0)),
				previousPeak: peak(hoursBack(2 * o.hours, o.hours)),
			},
		};
	},
});

// trends -----------------------------------------------------------------------------------------------------------

export interface TrendsOptions {
	/** Moving-average window, days (default 7). */
	window: number;
	/** Join sources shown separately (busiest first); the rest is "other" (default 6). */
	maxSources: number;
	robuxKey: string;
	/** Share of the price the creator keeps (default 0.7), for `revenue`. */
	creatorShare: number;
}

export interface TrendValues {
	newUsers: number;
	dau: number;
	/** Average session time: the window's mean of daily playtime / sessions, minutes (null without sessions). */
	sessionMinutes: number | null;
	/** Average playtime: the window's mean of daily playtime / DAU, minutes (null without players). */
	playtimeMinutes: number | null;
	/** Robux spent per day. */
	robux: number;
	/** The creator's estimated revenue per day (robux x creatorShare). */
	revenue: number;
	/** The window's mean of daily D1 (join-day cohorts whose next day is over); null without any. */
	d1: number | null;
}

export interface TrendsResult {
	from: string;
	to: string;
	window: number;
	creatorShare: number;
	/** Join sources (session/join `from`), busiest first; "other" folds the rest, "unknown" = no join row. */
	sources: string[];
	/** Full UTC days only: the last one is yesterday at the latest. */
	days: { date: string; total: TrendValues; bySource: Record<string, TrendValues> }[];
}

export const trends = defineQuery<TrendsOptions, TrendsResult>({
	name: "trends",
	summary: "per full UTC day, moving averages of new users, DAU, session time, playtime per DAU, revenue and D1, in total and per join source",
	defaultDays: 28,
	options: (input = {}) => ({
		window: intOption(input.window, "window", 7, 1, 28),
		maxSources: intOption(input.maxSources, "maxSources", 6, 1, 20),
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
		creatorShare: shareOption(input.creatorShare),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const d = ctx.dialect;
		const firstDay = Math.floor(f.from / DAY_MS) - (o.window - 1);
		const lastDay = lastFullDay(ctx, f.to);
		const lo = firstDay * DAY_MS;
		const hi = (lastDay + 2) * DAY_MS; // one more day: the last cohort's return day
		const sessions =
			`WITH ev AS (${playerEvents(ctx, f, lo - SESSION_SLACK_MS, hi, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp, e.kind AS kind, e.name AS name, e.props AS props, e.src AS esrc")}), ` +
			`s AS (SELECT sid, MIN(pid) AS pid, MIN(t) AS t0, MAX(t) AS t1, MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew, ` +
			`MAX(CASE WHEN kind = 'session' AND name = 'join' THEN ${d.jsonText("props", "from")} END) AS src FROM ev GROUP BY sid), ` +
			`s1 AS (SELECT sid, pid, t0, t1, isnew, COALESCE(src, 'unknown') AS src, ${dayOf("t0")} AS day FROM s WHERE t0 >= ${int(lo)}), ` +
			`sd AS (SELECT sid, pid, t0, t1, isnew, src, day, ROW_NUMBER() OVER (PARTITION BY pid, day ORDER BY t0) AS rn FROM s1)`;
		return {
			days:
				`${sessions}, ` +
				`pd AS (SELECT pid, day, src FROM sd WHERE rn = 1), ` +
				`pdn AS (SELECT pid, day, MAX(isnew) AS isnew, SUM(t1 - t0) AS playtime, COUNT(*) AS sessions FROM sd GROUP BY pid, day), ` +
				`pr AS (SELECT pid, day, SUM(COALESCE(robux, 0)) AS robux FROM (SELECT pid, ${dayOf("t")} AS day, ${d.jsonNumber("props", o.robuxKey)} AS robux FROM ev WHERE kind = 'purchase' AND ${SERVER_PURCHASE}) q GROUP BY pid, day) ` +
				`SELECT pd.day AS day, pd.src AS src, COUNT(*) AS dau, SUM(pdn.isnew) AS new_users, SUM(pdn.playtime) AS playtime_ms, SUM(pdn.sessions) AS sessions, SUM(COALESCE(pr.robux, 0)) AS robux ` +
				`FROM pd JOIN pdn ON pdn.pid = pd.pid AND pdn.day = pd.day LEFT JOIN pr ON pr.pid = pd.pid AND pr.day = pd.day ` +
				`WHERE pd.day >= ${int(firstDay)} AND pd.day <= ${int(lastDay)} GROUP BY pd.day, pd.src ORDER BY day, src ${lim(10_000)}`,
			d1:
				`${sessions}, ` +
				`c AS (SELECT pid, day AS cday, src FROM (SELECT pid, day, src, ROW_NUMBER() OVER (PARTITION BY pid ORDER BY t0) AS n FROM sd WHERE isnew = 1) x WHERE n = 1), ` +
				`${sessionDaysCte(ctx, lo, hi)} ` +
				`SELECT cday, src, COUNT(*) AS cohort, SUM(kept) AS kept FROM (SELECT c.pid AS pid, c.cday AS cday, c.src AS src, MAX(CASE WHEN a.day = c.cday + 1 THEN 1 ELSE 0 END) AS kept ` +
				`FROM c LEFT JOIN a ON a.pid = c.pid GROUP BY c.pid, c.cday, c.src) r WHERE cday >= ${int(firstDay)} AND cday < ${int(lastDay)} GROUP BY cday, src ORDER BY cday, src ${lim(10_000)}`,
		};
	},
	shape(rows, ctx, f, o) {
		interface Raw {
			dau: number;
			newUsers: number;
			playtime: number;
			sessions: number;
			robux: number;
			cohort: number;
			kept: number;
		}
		const zero = (): Raw => ({ dau: 0, newUsers: 0, playtime: 0, sessions: 0, robux: 0, cohort: 0, kept: 0 });
		// Sources, busiest first by active-user days; past maxSources - 1 they fold into "other".
		const weight = new Map<string, number>();
		for (const r of rows.days) weight.set(str(r.src), (weight.get(str(r.src)) ?? 0) + num(r.dau));
		const ranked = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
		const kept = ranked.length > o.maxSources ? ranked.slice(0, o.maxSources - 1) : ranked;
		const sourceOf = (src: string) => (kept.includes(src) ? src : "other");
		const sources = ranked.length > o.maxSources ? [...kept, "other"] : kept;
		const raw = new Map<string, Raw>(); // `${day}|${source}` and `${day}|*` for the total
		const add = (day: number, src: string, patch: Partial<Raw>) => {
			for (const key of [`${day}|${sourceOf(src)}`, `${day}|*`]) {
				const v = raw.get(key) ?? zero();
				for (const [k, x] of Object.entries(patch) as [keyof Raw, number][]) v[k] += x;
				raw.set(key, v);
			}
		};
		for (const r of rows.days) add(num(r.day), str(r.src), { dau: num(r.dau), newUsers: num(r.new_users), playtime: num(r.playtime_ms), sessions: num(r.sessions), robux: num(r.robux) });
		for (const r of rows.d1) add(num(r.cday), str(r.src), { cohort: num(r.cohort), kept: num(r.kept) });
		const first = Math.floor(f.from / DAY_MS);
		const last = lastFullDay(ctx, f.to);
		const average = (day: number, src: string): TrendValues => {
			const window = Array.from({ length: o.window }, (_, i) => raw.get(`${day - o.window + 1 + i}|${src}`) ?? zero());
			const total = (k: keyof Raw) => window.reduce((s, v) => s + v[k], 0);
			const session = meanOf(window.map((v) => (v.sessions > 0 ? v.playtime / v.sessions : null)));
			const playtime = meanOf(window.map((v) => (v.dau > 0 ? v.playtime / v.dau : null)));
			const d1 = meanOf(window.map((v) => (v.cohort > 0 ? v.kept / v.cohort : null)));
			return {
				newUsers: round(total("newUsers") / o.window, 2),
				dau: round(total("dau") / o.window, 2),
				sessionMinutes: minutesOrNull(session),
				playtimeMinutes: minutesOrNull(playtime),
				robux: round(total("robux") / o.window, 2),
				revenue: round((total("robux") * o.creatorShare) / o.window, 2),
				d1: d1 === null ? null : rate4(d1),
			};
		};
		const days: TrendsResult["days"] = [];
		for (let day = first; day <= last; day++) {
			days.push({ date: isoDay(day), total: average(day, "*"), bySource: Object.fromEntries(sources.map((s) => [s, average(day, s)])) });
		}
		return { from: iso(f.from), to: iso(f.to), window: o.window, creatorShare: o.creatorShare, sources, days };
	},
});
