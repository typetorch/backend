/**
 * Small lookups for explorers (the web app's player search, filter bar suggestions and event rows):
 *   players — players seen in the range, most recent first (or top spenders first), optionally matching part of a pid,
 *             with the Robux each spent in the range;
 *   values  — the branches, artifacts, channels and devices seen in the range (for filter pickers);
 *   events  — the newest rows, optionally of one kind / name / player.
 * `fleet` rows never return their props here: a heartbeat's props can hold a private server's access code (`k`).
 */
import { assertSafeKey, lit } from "../sql/dialect.ts";
import { PROP_KEYS } from "../schema.ts";
import { checkPid, defineQuery, eventsTable, intOption, iso, num, playerRows, round, SERVER_PURCHASE, str, strOrNull, where } from "./core.ts";

// players -------------------------------------------------------------------------------------------------------------

export interface PlayersOptions {
	/** Only pids containing this text (letters, digits, `_`, `-`). */
	search?: string;
	/** Also (or only) these pids, e.g. a UserId's pids from the server's identity table (at most 50). */
	pids?: string[];
	/** Most players to return (default 50). */
	limit: number;
	/** `recent` (default): last seen first. `robux`: most Robux spent first, then last seen. */
	sort: PlayersSort;
	/** A column to order by instead (the explorer's sortable headers); ties go to last seen, then pid. */
	orderBy?: PlayersOrder;
	/** With orderBy: largest, latest or Z first (default true). */
	desc?: boolean;
}

/** The columns `orderBy` takes, and their SQL. */
const PLAYERS_ORDER = {
	pid: "p.pid",
	lastSeen: "p.last_t",
	firstSeen: "p.first_t",
	sessions: "sp.sessions",
	playtime: "sp.playtime_ms",
	robux: "COALESCE(pu.robux, 0)",
	events: "p.events",
	new: "p.isnew",
} as const;
export type PlayersOrder = keyof typeof PLAYERS_ORDER;
export const PLAYERS_ORDERS = Object.keys(PLAYERS_ORDER) as PlayersOrder[];

export const PLAYERS_SORTS = ["recent", "robux"] as const;
export type PlayersSort = (typeof PLAYERS_SORTS)[number];

export interface PlayerSummary {
	pid: string;
	firstSeen: string;
	lastSeen: string;
	sessions: number;
	events: number;
	playtimeMinutes: number;
	/**
	 * Robux spent in the range: the sum of `props.robux` over server-sent `purchase` rows (SERVER_PURCHASE, like the
	 * revenue queries), 0 for none. Purchase rows carry no receipt id, so a purchase is one distinct row (same pid,
	 * session, time, name and props): a resent copy of a row counts once.
	 */
	robux: number;
	/** Their first-ever session is in the range. */
	newInRange: boolean;
	/** The UserId, when the analytics server knows it (identity rows; added by the server, not the query). */
	uid?: number;
}

export interface PlayersResult {
	players: PlayerSummary[];
}

export const players = defineQuery<PlayersOptions, PlayersResult>({
	name: "players",
	summary: "players seen in the range, most recent first, sort=robux for top spenders, or orderBy=<column> with desc=true|false (pid, lastSeen, firstSeen, sessions, playtime, robux, events, new); search = part of a pid",
	defaultDays: 30,
	options: (input = {}) => {
		const sort = input.sort ?? "recent";
		if (!PLAYERS_SORTS.includes(sort as PlayersSort)) throw new Error(`sort must be one of ${PLAYERS_SORTS.join(", ")}`);
		const out: PlayersOptions = { limit: intOption(input.limit, "limit", 50, 1, 1000), sort: sort as PlayersSort };
		if (input.orderBy !== undefined) {
			if (!PLAYERS_ORDERS.includes(input.orderBy as PlayersOrder)) throw new Error(`orderBy must be one of ${PLAYERS_ORDERS.join(", ")}`);
			if (input.desc !== undefined && typeof input.desc !== "boolean") throw new Error("desc must be true or false");
			out.orderBy = input.orderBy as PlayersOrder;
			out.desc = input.desc !== false;
		}
		if (input.search !== undefined && input.search !== "") {
			if (typeof input.search !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.search)) throw new Error("search must be 1-64 characters of letters, digits, _ or -");
			out.search = input.search;
		}
		if (input.pids !== undefined) {
			if (!Array.isArray(input.pids) || input.pids.length > 50) throw new Error("pids must be a list of at most 50 pids");
			if (input.pids.length) out.pids = input.pids.map((p) => checkPid(p));
		}
		return out;
	},
	statements(ctx, f, o) {
		const parts = [...(o.search ? [`strpos(e.pid, ${lit(o.search)}) > 0`] : []), ...(o.pids ? [`e.pid IN (${o.pids.map(lit).join(", ")})`] : [])];
		const search = parts.length > 1 ? `(${parts.join(" OR ")})` : (parts[0] ?? "");
		const table = eventsTable(ctx, f);
		const robux = ctx.dialect.jsonNumber("props", PROP_KEYS.purchaseRobux);
		const order = o.orderBy
			? `${PLAYERS_ORDER[o.orderBy]} ${o.desc === false ? "ASC" : "DESC"}, p.last_t DESC, p.pid`
			: o.sort === "robux"
				? "COALESCE(pu.robux, 0) DESC, p.last_t DESC, p.pid"
				: "p.last_t DESC, p.pid";
		return {
			players:
				`WITH ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp FROM ${table} e WHERE ${playerRows(f, ctx, search)}), ` +
				// One row per distinct purchase row (no receipt id exists; a resent copy is an exact duplicate), server-sent only.
				`pr AS (SELECT DISTINCT e.pid AS pid, e.sid AS sid, e.t AS t, e.name AS name, e.props AS props, e.src AS esrc FROM ${table} e ` +
				`WHERE ${playerRows(f, ctx, search)} AND e.kind = 'purchase'), ` +
				`pu AS (SELECT pid, SUM(COALESCE(${robux}, 0)) AS robux FROM pr WHERE ${SERVER_PURCHASE} GROUP BY pid), ` +
				`s AS (SELECT sid, MIN(pid) AS pid, MAX(t) - MIN(t) AS len FROM ev GROUP BY sid), ` +
				`sp AS (SELECT pid, COUNT(*) AS sessions, SUM(len) AS playtime_ms FROM s GROUP BY pid), ` +
				`p AS (SELECT pid, MIN(t) AS first_t, MAX(t) AS last_t, COUNT(*) AS events, MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew FROM ev GROUP BY pid) ` +
				`SELECT p.pid AS pid, p.first_t AS first_t, p.last_t AS last_t, p.events AS events, p.isnew AS isnew, sp.sessions AS sessions, sp.playtime_ms AS playtime_ms, COALESCE(pu.robux, 0) AS robux ` +
				`FROM p JOIN sp ON sp.pid = p.pid LEFT JOIN pu ON pu.pid = p.pid ORDER BY ${order} ${ctx.dialect.limit(o.limit)}`,
		};
	},
	shape: (rows) => ({
		players: rows.players.map((r) => ({
			pid: str(r.pid),
			firstSeen: iso(num(r.first_t)),
			lastSeen: iso(num(r.last_t)),
			sessions: num(r.sessions),
			events: num(r.events),
			playtimeMinutes: round(num(r.playtime_ms) / 60_000, 1),
			robux: round(num(r.robux), 2),
			newInRange: num(r.isnew) === 1,
		})),
	}),
});

// values ----------------------------------------------------------------------------------------------------------------

export interface ValueCount {
	value: string;
	events: number;
	lastSeen: string;
}

export interface ValuesResult {
	/** Each list is busiest first, except `art`: newest first. */
	branch: ValueCount[];
	art: ValueCount[];
	channel: ValueCount[];
	dev: ValueCount[];
}

const VALUE_COLUMNS = ["branch", "art", "channel", "dev"] as const;

export const values = defineQuery<Record<string, never>, ValuesResult>({
	name: "values",
	summary: "the branches, artifacts, channels and devices seen in the range (for filter pickers)",
	defaultDays: 30,
	options: () => ({}),
	statements(ctx, f) {
		return {
			combos:
				`SELECT e.branch AS branch, e.art AS art, e.channel AS channel, e.dev AS dev, COUNT(*) AS n, MAX(e.t) AS last_t ` +
				`FROM ${eventsTable(ctx, f)} e WHERE ${where(f, ctx)} GROUP BY e.branch, e.art, e.channel, e.dev ORDER BY n DESC ${ctx.dialect.limit(10_000)}`,
		};
	},
	shape(rows) {
		const sums = Object.fromEntries(VALUE_COLUMNS.map((c) => [c, new Map<string, { events: number; last: number }>()])) as Record<
			(typeof VALUE_COLUMNS)[number],
			Map<string, { events: number; last: number }>
		>;
		for (const r of rows.combos) {
			for (const column of VALUE_COLUMNS) {
				const value = strOrNull(r[column]);
				if (!value) continue;
				const entry = sums[column].get(value) ?? { events: 0, last: 0 };
				entry.events += num(r.n);
				entry.last = Math.max(entry.last, num(r.last_t));
				sums[column].set(value, entry);
			}
		}
		const list = (column: (typeof VALUE_COLUMNS)[number], newestFirst = false) =>
			[...sums[column]]
				.map(([value, e]) => ({ value, events: e.events, last: e.last }))
				.sort((a, b) => (newestFirst ? b.last - a.last : b.events - a.events) || a.value.localeCompare(b.value))
				.map((e) => ({ value: e.value, events: e.events, lastSeen: iso(e.last) }));
		return { branch: list("branch"), art: list("art", true), channel: list("channel"), dev: list("dev") };
	},
});

// events ----------------------------------------------------------------------------------------------------------------

export interface EventsOptions {
	kind?: string;
	name?: string;
	pid?: string;
	/** Most rows (newest first, default 100). */
	limit: number;
}

export interface EventRowOut {
	time: string;
	t: number;
	kind: string;
	name: string;
	pid: string | null;
	sid: string | null;
	job: string;
	state: string | null;
	art: string;
	branch: string | null;
	dev: string | null;
	src: string | null;
	/** Parsed props; always null on `fleet` rows. */
	props: unknown;
}

export interface EventsResult {
	events: EventRowOut[];
}

export const events = defineQuery<EventsOptions, EventsResult>({
	name: "events",
	summary: "the newest event rows, optionally of one kind, name or player (fleet rows without props)",
	defaultDays: 7,
	options: (input = {}) => {
		const out: EventsOptions = { limit: intOption(input.limit, "limit", 100, 1, 1000) };
		if (input.kind) out.kind = assertSafeKey(input.kind, "kind");
		if (input.name) out.name = assertSafeKey(input.name, "name");
		if (input.pid) out.pid = checkPid(input.pid);
		return out;
	},
	statements(ctx, f, o) {
		const cond = [where(f, ctx)];
		if (o.kind) cond.push(`e.kind = ${lit(o.kind)}`);
		if (o.name) cond.push(`e.name = ${lit(o.name)}`);
		if (o.pid) cond.push(`e.pid = ${lit(o.pid)}`);
		return {
			events:
				`SELECT e.t AS t, e.kind AS kind, e.name AS name, e.pid AS pid, e.sid AS sid, e.job AS job, e.state AS state, e.art AS art, e.branch AS branch, ` +
				`e.dev AS dev, e.src AS src, CASE WHEN e.kind = 'fleet' THEN NULL ELSE e.props END AS props ` +
				`FROM ${eventsTable(ctx, f)} e WHERE ${cond.join(" AND ")} ORDER BY e.t DESC ${ctx.dialect.limit(o.limit)}`,
		};
	},
	shape: (rows) => ({
		events: rows.events.map((r) => {
			let props: unknown = null;
			if (typeof r.props === "string" && r.props) {
				try {
					props = JSON.parse(r.props);
				} catch {
					props = r.props;
				}
			}
			const opt = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
			return {
				time: iso(num(r.t)),
				t: num(r.t),
				kind: str(r.kind),
				name: str(r.name),
				pid: opt(r.pid),
				sid: opt(r.sid),
				job: str(r.job),
				state: opt(r.state),
				art: str(r.art),
				branch: opt(r.branch),
				dev: opt(r.dev),
				src: opt(r.src),
				props: str(r.kind) === "fleet" ? null : props,
			};
		}),
	}),
});
