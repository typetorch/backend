/**
 * The building blocks of a logical query: a definition renders one or more SQL statements for a dialect, a store runs
 * them, and the definition shapes the rows into a plain result. The same definition serves every backend.
 */
import { DAY_MS, dayOf, int, lit, type Dialect } from "../sql/dialect.ts";
import { whereSql, type NormalizedFilters, type WhereOptions } from "../sql/filters.ts";

export type Row = Record<string, unknown>;
export type Rows = Record<string, Row[]>;
export type TableName = "events" | "recordings";

/** What a query renders against. */
export interface QueryContext {
	dialect: Dialect;
	/** A table expression for a time range ("typetorch.events", or a subquery over today's file + Parquet files). */
	table(name: TableName, from: number, to: number): string;
	/** Now, unix ms (tests pin it). */
	now: number;
}

/** Runs statements (each a full SQL text) and returns their rows by statement name. */
export type RunStatements = (statements: Record<string, string>) => Promise<Rows>;

export interface QueryDef<O extends object, R> {
	name: string;
	/** One line for `typetorch analytics --help` and the server's index. */
	summary: string;
	/** Range when the filters give no `from`. */
	defaultDays: number;
	/** Fills in option defaults and checks them (throws on bad input). */
	options(input: Partial<O> | undefined): O;
	statements(ctx: QueryContext, f: NormalizedFilters, o: O): Record<string, string>;
	shape(rows: Rows, ctx: QueryContext, f: NormalizedFilters, o: O): R;
	/** An optional second phase that may run more SQL (e.g. reading recordings). */
	finish?(result: R, ctx: QueryContext, f: NormalizedFilters, o: O, run: RunStatements): Promise<R>;
}

export function defineQuery<O extends object, R>(def: QueryDef<O, R>): QueryDef<O, R> {
	return def;
}

// Row helpers -------------------------------------------------------------------------------------------------------

/** A number from a row value (DuckDB BIGINTs arrive as bigint or string, Basin may send strings); null/NaN -> 0. */
export function num(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "boolean") return value ? 1 : 0;
	const n = Number(String(value));
	return Number.isFinite(n) ? n : 0;
}

/** Like num, but null stays null. */
export function numOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return num(value);
}

export function str(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value);
}

export function strOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

/** A share 0-1 rounded to 4 places (0 when the base is 0). */
export function ratio(part: number, whole: number): number {
	return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;
}

export function round(value: number, places = 2): number {
	const f = 10 ** places;
	return Math.round(value * f) / f;
}

export function isoDay(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// SQL helpers -------------------------------------------------------------------------------------------------------

/** The filters as a condition on alias `e`. */
export function where(f: NormalizedFilters, ctx: QueryContext, options: WhereOptions = {}): string {
	return whereSql(f, ctx.dialect, { prefix: "e.", ...options });
}

/** The events table for the filter range (plus `extraDaysAfter` for retention windows). */
export function eventsTable(ctx: QueryContext, f: NormalizedFilters, extraDaysAfter = 0): string {
	return ctx.table("events", f.from, f.to + extraDaysAfter * DAY_MS);
}

/** The player's state, or one part of it ("zone" -> the value after `zone:`), as a nullable expression. */
export function stateExpr(column: string, facet: string): string {
	if (facet === "all") return `NULLIF(${column}, '')`;
	if (!/^[a-z_]{1,32}$/.test(facet)) throw new Error(`facet must be "all" or a lowercase state key such as zone, screen or activity`);
	// '|' || state, split on '|zone:', the part after it up to the next '|'. Works the same in DuckDB and Basin.
	return `NULLIF(split_part(split_part('|' || ${column}, ${lit(`|${facet}:`)}, 2), '|', 1), '')`;
}

/** Player events (pid and sid set) on alias `e`. */
export function playerRows(f: NormalizedFilters, ctx: QueryContext, extra = ""): string {
	return `${where(f, ctx)} AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> ''${extra ? ` AND ${extra}` : ""}`;
}

/** Sessions from an `ev(pid, sid, t, newp)` CTE: start, end and whether it was a first-ever session. */
export const SESSIONS_CTE =
	"s AS (SELECT sid, MIN(pid) AS pid, MIN(t) AS t0, MAX(t) AS t1, MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew FROM ev GROUP BY sid)";

/** Sessions whose last event is older than this are over (for "left the game" and bounce counts). */
export const ENDED_AFTER_MS = 10 * 60 * 1000;

/**
 * Rows from Studio play tests (`srv = studio`) on alias `e`. Roblox's analytics only count published games (Studio
 * sends nothing), so the Creator-Hub-style queries leave them out. Rows without `srv` count.
 */
export const NOT_STUDIO = "(e.srv IS NULL OR e.srv <> 'studio')";

/**
 * How far before and after a window the session queries read, so a session that crosses the window's edge keeps its
 * real start (it isn't counted as starting at the edge) and its full length. Sessions are at most this long in the
 * playtime funnel too (stuck or AFK servers).
 */
export const SESSION_SLACK_MS = 12 * 3_600_000;

/**
 * `a(pid, day)`: the UTC days on which a player started a session, from the events in [from, to). Retention counts a
 * player as back on day N when a session *started* that day, as Roblox does ("played again after their first
 * session ended"): a first session running past midnight is not a return. No segment filters (a player back on
 * another device still counts); Studio sessions don't count.
 */
export function sessionDaysCte(ctx: QueryContext, from: number, to: number): string {
	return (
		`a AS (SELECT DISTINCT pid, ${dayOf("t0")} AS day FROM (SELECT e.pid AS pid, MIN(e.t) AS t0 FROM ${ctx.table("events", from, to)} e ` +
		`WHERE e.t >= ${int(from)} AND e.t < ${int(to)} AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> '' AND ${NOT_STUDIO} ` +
		`GROUP BY e.pid, e.sid) x)`
	);
}

/** The mean of the values that aren't null (null when there are none): Roblox's N-day averages of a daily ratio. */
export function meanOf(values: readonly (number | null)[]): number | null {
	const kept = values.filter((v): v is number => v !== null && Number.isFinite(v));
	return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : null;
}

/**
 * Revenue counts server-sent purchase rows only. Older framework engines let a client send `purchase` events
 * (src = client), so an exploiter could inflate payers and Robux; clients can't send them now and ingest refuses them
 * (SERVER_ONLY_KINDS), but rows already stored or sent to Basin may hold some. Rows from before `src` existed (NULL)
 * count. The CTE must expose `e.src AS esrc` (the name `src` is taken by the join source in some queries).
 */
export const SERVER_PURCHASE = "(esrc IS NULL OR esrc <> 'client')";

export { dayOf, int, lit };

/** A pid for SQL: the framework's random ids are short tokens. */
export function checkPid(pid: unknown): string {
	if (typeof pid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pid)) throw new Error("pid must be 1-64 characters of letters, digits, _ or -");
	return pid;
}

/**
 * A chart's time step for a window (the explorer's date range): up to an hour -> 1 min, up to 6 hours -> 5 min, up to a
 * day -> 1 hour, longer -> 1 day (the day series, as before). A little slack, so a window that starts on a whole minute
 * (the explorer's "Last hour" is up to 61 minutes) keeps its step. At most 78 buckets below a day.
 */
export function windowBucketMs(spanMs: number): number {
	if (spanMs <= 65 * 60_000) return 60_000;
	if (spanMs <= 6.5 * 3_600_000) return 5 * 60_000;
	if (spanMs <= 26 * 3_600_000) return 3_600_000;
	return DAY_MS;
}

export function intOption(value: unknown, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === null) return fallback;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
	return Math.round(n);
}
