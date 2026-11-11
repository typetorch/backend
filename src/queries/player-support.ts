/**
 * Per-player support reads (plans/31, behind GET /v1/players/by-uid/{uid}/events and /summary): one player's rows of
 * the named events, for every pid of their UserId (the route resolves the pids from `identities`; the query never takes
 * a free-form filter). `join` / `leave` are the `session` kind's rows; other names match any kind but `session` and
 * `fleet`. Only the time range applies: `from` / `to` in the filters (the route sends `since` / `before`).
 *
 *   player-events   newest first, `limit` (1..100, default 50) rows of { t, name, kind, pid, job, props } (+1 to say `more`)
 *   player-summary  counts per name (the given names, 0 when none), `ac_flag` rows by `props.cat`, distinct sessions,
 *                   the newest row of any kind
 */
import { defineQuery, intOption, lit, num, str, type QueryContext } from "./core.ts";
import type { NormalizedFilters } from "../sql/filters.ts";

export const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The session kind's row names the support list may name. */
export const SESSION_NAMES = ["join", "leave"];
export const PIDS_MAX = 50;
export const NAMES_MAX = 64;

export interface PlayerSupportOptions {
	pids: string[];
	names: string[];
	limit: number;
}

export interface PlayerEventRow {
	t: number;
	name: string;
	kind: string;
	pid: string;
	job: string;
	/** Always an object (props parsed; {} when none or unreadable). */
	props: Record<string, unknown>;
}

export interface PlayerEventsResult {
	rows: PlayerEventRow[];
	more: boolean;
}

export interface PlayerSummaryResult {
	byName: Record<string, number>;
	byCategory: Record<string, number>;
	sessions: number;
	lastSeen: number | null;
}

function options(input: Partial<PlayerSupportOptions> = {}): PlayerSupportOptions {
	const pids = input.pids ?? [];
	if (!Array.isArray(pids) || pids.length > PIDS_MAX || pids.some((p) => typeof p !== "string" || !PID_RE.test(p))) throw new Error(`pids is a list of at most ${PIDS_MAX} pids`);
	const names = input.names ?? [];
	if (!Array.isArray(names) || names.length > NAMES_MAX || names.some((n) => typeof n !== "string" || !NAME_RE.test(n))) throw new Error(`names is a list of at most ${NAMES_MAX} event names`);
	return { pids: [...new Set(pids)], names: [...new Set(names)], limit: intOption(input.limit, "limit", 50, 1, 100) };
}

/** The player's rows of the names in the range, on alias `e`. */
function rowsWhere(ctx: QueryContext, f: NormalizedFilters, o: PlayerSupportOptions): string {
	const who = o.pids.length ? `e.pid IN (${o.pids.map(lit).join(", ")})` : "1 = 0";
	const session = o.names.filter((n) => SESSION_NAMES.includes(n));
	const other = o.names.filter((n) => !SESSION_NAMES.includes(n));
	const parts = [
		...(session.length ? [`(e.kind = 'session' AND e.name IN (${session.map(lit).join(", ")}))`] : []),
		...(other.length ? [`(e.kind <> 'session' AND e.kind <> 'fleet' AND e.name IN (${other.map(lit).join(", ")}))`] : []),
	];
	return `e.t >= ${Math.floor(f.from)} AND e.t < ${Math.floor(f.to)} AND ${who} AND ${parts.length ? `(${parts.join(" OR ")})` : "1 = 0"}`;
}

function propsObject(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw !== "string" || !raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export const playerEvents = defineQuery<PlayerSupportOptions, PlayerEventsResult>({
	name: "player-events",
	summary: "one player's rows of the named events (pids from identities; join / leave = session rows), newest first, props parsed",
	defaultDays: 30,
	options,
	statements(ctx, f, o) {
		// DISTINCT: a resent copy of a row is an exact duplicate (no row id exists).
		return {
			rows:
				`SELECT DISTINCT e.t AS t, e.name AS name, e.kind AS kind, e.pid AS pid, e.job AS job, e.props AS props FROM ${ctx.table("events", f.from, f.to)} e ` +
				`WHERE ${rowsWhere(ctx, f, o)} ORDER BY t DESC, name, pid ${ctx.dialect.limit(o.limit + 1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const list = rows.rows ?? [];
		return {
			rows: list.slice(0, o.limit).map((r) => ({ t: num(r.t), name: str(r.name), kind: str(r.kind), pid: str(r.pid), job: str(r.job), props: propsObject(r.props) })),
			more: list.length > o.limit,
		};
	},
});

export const playerSummary = defineQuery<PlayerSupportOptions, PlayerSummaryResult>({
	name: "player-summary",
	summary: "one player's counts per named event, ac_flag rows by props.cat, distinct sessions and last seen (pids from identities)",
	defaultDays: 30,
	options,
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const table = ctx.table("events", f.from, f.to);
		const who = o.pids.length ? `e.pid IN (${o.pids.map(lit).join(", ")})` : "1 = 0";
		const range = `e.t >= ${Math.floor(f.from)} AND e.t < ${Math.floor(f.to)}`;
		const distinct = `SELECT DISTINCT e.t AS t, e.name AS name, e.kind AS kind, e.pid AS pid, e.props AS props FROM ${table} e WHERE ${rowsWhere(ctx, f, o)}`;
		return {
			byName: `SELECT name, COUNT(*) AS n FROM (${distinct}) r GROUP BY name ORDER BY name ${d.limit(NAMES_MAX)}`,
			byCategory:
				`SELECT COALESCE(${d.jsonText("props", "cat")}, '') AS cat, COUNT(*) AS n FROM (${distinct}) r WHERE name = 'ac_flag' GROUP BY COALESCE(${d.jsonText("props", "cat")}, '') ` +
				`ORDER BY n DESC, cat ${d.limit(200)}`,
			totals: `SELECT COUNT(DISTINCT CASE WHEN e.sid IS NOT NULL AND e.sid <> '' THEN e.sid END) AS sessions, MAX(e.t) AS last FROM ${table} e WHERE ${range} AND ${who} AND e.kind <> 'fleet' ${d.limit(1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const byName: Record<string, number> = Object.fromEntries(o.names.map((n) => [n, 0]));
		for (const r of rows.byName ?? []) byName[str(r.name)] = num(r.n);
		const byCategory: Record<string, number> = {};
		for (const r of rows.byCategory ?? []) byCategory[str(r.cat) || "(none)"] = num(r.n);
		const t = rows.totals?.[0] ?? {};
		return { byName, byCategory, sessions: num(t.sessions), lastSeen: t.last === null || t.last === undefined ? null : num(t.last) };
	},
});
