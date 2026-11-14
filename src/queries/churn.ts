/**
 * Churn risk per player, from play patterns: when they last played against their own usual rhythm.
 *
 * The players: everyone with a session row in the range that the filters keep (the audience filters, device, ...).
 * Their play days: the UTC days they started a session in the range on any device or build (as retention reads return
 * days; Studio left out). As of the range's last day (today for "last N days"):
 *   - `daysSince`: days since the last play day (0 = played that day);
 *   - `usualGap`: the median days between their consecutive play days (null with one play day: then 1 is used, so a
 *     one-day player counts as "late" after 2 days);
 *   - `recentDays` / `priorDays`: play days in the last 14 days and in the 14 before.
 * The buckets, first rule that matches (CHURN_RULES, the README says the same):
 *   - churned:  daysSince >= 28;
 *   - lapsing:  daysSince >= 14, or daysSince > 3 x usualGap;
 *   - at_risk:  daysSince >= 2 and daysSince > 1.5 x usualGap (late for their rhythm), or cooling:
 *               recentDays <= priorDays / 2 with priorDays >= 3 (half the play days of the two weeks before, or fewer;
 *               3 so a once-a-week player's two-week windows don't read as a drop);
 *   - active:   everyone else.
 * The range bounds what is seen: with the default 90 days, a player last seen 90+ days ago isn't in it at all.
 */
import { DAY_MS } from "../sql/dialect.ts";
import { NOT_STUDIO, dayOf, defineQuery, eventsTable, int, intOption, isoDay, lit, num, numOrNull, playerRows, ratio, str, checkPid, type QueryContext } from "./core.ts";
import type { NormalizedFilters } from "../sql/filters.ts";

export const CHURN_BUCKETS = ["active", "at_risk", "lapsing", "churned"] as const;
export type ChurnBucket = (typeof CHURN_BUCKETS)[number];

/** The thresholds of the rule above (days; gap multiples). */
export const CHURN_RULES = { churnedDays: 28, lapsingDays: 14, lapsingGaps: 3, atRiskGaps: 1.5, atRiskMinDays: 2, trendDays: 14, coolingMinPrior: 3 } as const;

export interface ChurnOptions {
	/** The bucket listed in `players` (default at_risk); ignored with `pids`. */
	bucket: ChurnBucket;
	/** Players listed (default 100, at most 1,000): the most play days first (the most engaged, the best win-back targets), then the longest away. */
	limit: number;
	/** These players' risk instead of a bucket's list (the Players page's column; at most 200). */
	pids?: string[];
}

export interface ChurnPlayer {
	pid: string;
	bucket: ChurnBucket;
	firstPlayed: string;
	lastPlayed: string;
	daysSince: number;
	/** Median days between play days; null with one play day. */
	usualGap: number | null;
	playDays: number;
	recentDays: number;
	priorDays: number;
	/** Set by the server: the UserId and Roblox names from identities, and (owners) the notification opt-in state. */
	uid?: number;
	name?: string;
	displayName?: string;
	optin?: string | null;
}

export interface ChurnResult {
	from: string;
	to: string;
	/** The day the risk is measured on (the range's last day, UTC). */
	asOf: string;
	players: number;
	buckets: { bucket: ChurnBucket; players: number; share: number }[];
	/** Per bucket, the players with a purchase in the range (who is worth winning back). */
	payers: Record<ChurnBucket, number>;
	/** The bucket listed, or null for a `pids` lookup. */
	bucket: ChurnBucket | null;
	list: ChurnPlayer[];
	/** Players in that bucket (the list holds the first `limit`). */
	total: number;
	more: number;
}

/** The bucket as a SQL CASE over `ds` (days since), `g` (usual gap, >= 1), `recent`, `prior`. */
function bucketSql(): string {
	const r = CHURN_RULES;
	return (
		`CASE WHEN ds >= ${r.churnedDays} THEN 'churned' ` +
		`WHEN ds >= ${r.lapsingDays} OR ds > ${r.lapsingGaps} * g THEN 'lapsing' ` +
		`WHEN (ds >= ${r.atRiskMinDays} AND ds > ${r.atRiskGaps} * g) OR (prior >= ${r.coolingMinPrior} AND recent * 2 <= prior) THEN 'at_risk' ` +
		`ELSE 'active' END`
	);
}

/** `b(pid, first_day, last_day, play_days, gap, recent, prior, ds, bucket, paid)`: every player's risk. */
function riskCtes(ctx: QueryContext, f: NormalizedFilters, asOf: number): string {
	const t = CHURN_RULES.trendDays;
	const end = Math.min(f.to, (asOf + 1) * DAY_MS);
	return (
		`pop AS (SELECT DISTINCT e.pid AS pid FROM ${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx, NOT_STUDIO)}), ` +
		// Session starts on any device or build (the population is filtered, their play isn't).
		`st AS (SELECT e.pid AS pid, MIN(e.t) AS t0 FROM ${ctx.table("events", f.from, end)} e WHERE e.t >= ${int(f.from)} AND e.t < ${int(end)} ` +
		`AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> '' AND ${NOT_STUDIO} GROUP BY e.pid, e.sid), ` +
		`d AS (SELECT DISTINCT st.pid AS pid, ${dayOf("st.t0")} AS day FROM st JOIN pop ON pop.pid = st.pid), ` +
		`gd AS (SELECT pid, day, day - LAG(day) OVER (PARTITION BY pid ORDER BY day) AS gap FROM d), ` +
		`p AS (SELECT pid, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(*) AS play_days, ${ctx.dialect.percentile("gap", 0.5)} AS gap, ` +
		`SUM(CASE WHEN day > ${int(asOf - t)} THEN 1 ELSE 0 END) AS recent, SUM(CASE WHEN day <= ${int(asOf - t)} AND day > ${int(asOf - 2 * t)} THEN 1 ELSE 0 END) AS prior FROM gd GROUP BY pid), ` +
		`q AS (SELECT pid, first_day, last_day, play_days, gap, recent, prior, ${int(asOf)} - last_day AS ds, CASE WHEN gap IS NULL OR gap < 1 THEN 1 ELSE gap END AS g FROM p), ` +
		`pay AS (SELECT DISTINCT e.pid AS pid FROM ${ctx.table("events", f.from, end)} e WHERE e.t >= ${int(f.from)} AND e.t < ${int(end)} AND e.kind = 'purchase' ` +
		`AND e.pid IS NOT NULL AND (e.src IS NULL OR e.src <> 'client') AND ${NOT_STUDIO}), ` +
		`b AS (SELECT q.pid AS pid, first_day, last_day, play_days, gap, recent, prior, ds, ${bucketSql()} AS bucket, CASE WHEN pay.pid IS NULL THEN 0 ELSE 1 END AS paid ` +
		`FROM q LEFT JOIN pay ON pay.pid = q.pid)`
	);
}

/** The range's last UTC day (its end is exclusive), and never past today. */
function asOfDay(ctx: QueryContext, f: NormalizedFilters): number {
	return Math.floor((Math.min(f.to, ctx.now + 1) - 1) / DAY_MS);
}

export const churn = defineQuery<ChurnOptions, ChurnResult>({
	name: "churn",
	summary: "churn risk per player from play patterns (days since last play vs their usual gap, play days, trend): active / at risk / lapsing / churned",
	defaultDays: 90,
	options: (input = {}) => {
		const bucket = input.bucket ?? "at_risk";
		if (!(CHURN_BUCKETS as readonly string[]).includes(bucket)) throw new Error(`bucket must be one of ${CHURN_BUCKETS.join(", ")}`);
		const out: ChurnOptions = { bucket, limit: intOption(input.limit, "limit", 100, 1, 1000) };
		if (input.pids !== undefined) {
			if (!Array.isArray(input.pids) || input.pids.length === 0 || input.pids.length > 200) throw new Error("pids: 1 to 200 pids");
			out.pids = [...new Set(input.pids.map(checkPid))];
		}
		return out;
	},
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const ctes = riskCtes(ctx, f, asOfDay(ctx, f));
		const cols = "pid, first_day, last_day, play_days, gap, recent, prior, ds, bucket";
		const list = o.pids
			? `SELECT ${cols} FROM b WHERE pid IN (${o.pids.map(lit).join(", ")}) ORDER BY pid ${lim(o.pids.length)}`
			: `SELECT ${cols} FROM b WHERE bucket = ${lit(o.bucket)} ORDER BY play_days DESC, ds DESC, pid ${lim(o.limit)}`;
		return {
			buckets: `WITH ${ctes} SELECT bucket, COUNT(*) AS players, SUM(paid) AS payers FROM b GROUP BY bucket ORDER BY bucket ${lim(10)}`,
			list: `WITH ${ctes} ${list}`,
		};
	},
	shape(rows, ctx, f, o) {
		const counts = new Map<string, { players: number; payers: number }>();
		for (const r of rows.buckets) counts.set(str(r.bucket), { players: num(r.players), payers: num(r.payers) });
		const players = [...counts.values()].reduce((s, c) => s + c.players, 0);
		const payers = Object.fromEntries(CHURN_BUCKETS.map((b) => [b, counts.get(b)?.payers ?? 0])) as Record<ChurnBucket, number>;
		const list = rows.list.map(
			(r): ChurnPlayer => ({
				pid: str(r.pid),
				bucket: str(r.bucket) as ChurnBucket,
				firstPlayed: isoDay(num(r.first_day)),
				lastPlayed: isoDay(num(r.last_day)),
				daysSince: num(r.ds),
				usualGap: numOrNull(r.gap) === null ? null : Math.round(num(r.gap) * 10) / 10,
				playDays: num(r.play_days),
				recentDays: num(r.recent),
				priorDays: num(r.prior),
			}),
		);
		const total = o.pids ? list.length : (counts.get(o.bucket)?.players ?? 0);
		return {
			from: new Date(f.from).toISOString(),
			to: new Date(f.to).toISOString(),
			asOf: isoDay(asOfDay(ctx, f)),
			players,
			buckets: CHURN_BUCKETS.map((b) => ({ bucket: b, players: counts.get(b)?.players ?? 0, share: ratio(counts.get(b)?.players ?? 0, players) })),
			payers,
			bucket: o.pids ? null : o.bucket,
			list,
			total,
			more: Math.max(0, total - list.length),
		};
	},
});
