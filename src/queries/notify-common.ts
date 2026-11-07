/**
 * Shared parts of the notify-* queries (plans/29 "Rows"): `kind = 'notify'` rows, written by the framework (game server)
 * and the backend (`src = backend`, `sid` empty, `pid` maybe empty).
 *
 * Only the time range applies: backend rows have no device, artifact, branch or place, so the segment filters would
 * drop them (and with them every send). JSON booleans (`dry`, `test`, `can`, `final`) are read with LIKE on the props
 * text (`"dry":true`, or the string `"true"`): Basin's json_get_str skips booleans and json_get_bool isn't in the shared
 * dialect, and the writers serialise props with JSON.stringify (no spaces), so the match is exact on both engines.
 */
import type { NormalizedFilters } from "../sql/filters.ts";
import { int, lit, type QueryContext } from "./core.ts";

/** Kind names as the contract allows them (`[a-z0-9_]{1,24}`; `custom` for one-offs). */
export const NOTIFY_KIND = /^[a-z0-9_]{1,24}$/;

/** How long after the range opens, plays and returns are read (an open of a send on the range's last day). */
export const NOTIFY_SLACK_MS = 2 * 86_400_000;

export function notifyKindOption(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !NOTIFY_KIND.test(value)) throw new Error("kind must be a notification kind: 1-24 characters of a-z, 0-9 or _");
	return value;
}

/** A JSON boolean prop is true (as the backend writes it: `"key":true`, or the string "true"). */
export function propTrue(column: string, key: "dry" | "test" | "can" | "final" | "first"): string {
	return `(${column} LIKE ${lit(`%"${key}":true%`)} OR ${column} LIKE ${lit(`%"${key}":"true"%`)})`;
}

/**
 * `n(pid, t, name, props)`: the distinct notify rows from the range start to `to + slackMs` (a resent copy is an exact
 * duplicate; no row id exists). `pid` is '' when missing.
 */
export function notifyCte(ctx: QueryContext, f: NormalizedFilters, slackMs = 0): string {
	const to = f.to + slackMs;
	return (
		`n AS (SELECT DISTINCT COALESCE(e.pid, '') AS pid, e.t AS t, e.name AS name, e.props AS props FROM ${ctx.table("events", f.from, to)} e ` +
		`WHERE e.t >= ${int(f.from)} AND e.t < ${int(to)} AND e.kind = 'notify')`
	);
}

/** `AND k = '<kind>'` on a notify row's props, or nothing. */
export function kindCondition(ctx: QueryContext, kind: string | undefined, column = "props"): string {
	return kind ? ` AND ${ctx.dialect.jsonText(column, "k")} = ${lit(kind)}` : "";
}

/** The hour number (hours since 1970) of an int64 ms column. */
export function hourOf(column: string): string {
	return `CAST(floor(${column} / 3600000.0) AS BIGINT)`;
}
