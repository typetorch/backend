/**
 * The raw numbers behind a live event's lift report (src/server/live-event-lift.ts plans the windows and does the
 * math): for each time window [from, to), the same numbers in one pass over the events table.
 *   - players: distinct players with a player row in the window; newPlayers: first-ever sessions (`newp`) started in it;
 *   - sessions: sessions that started in it; playtime: each session's time inside the window (a session crossing an
 *     edge counts its part: the read reaches SESSION_SLACK_MS past both ends, so it keeps its real start and end);
 *   - robux, purchases, payers: monetization's convention (server-sent purchase rows, each distinct row once).
 * Studio rows never count. Windows default to the filter range; at most WINDOWS_MAX, each at most WINDOW_MAX_DAYS long,
 * spanning at most SPAN_MAX_DAYS.
 */
import { PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import { NOT_STUDIO, SERVER_PURCHASE, SESSIONS_CTE, SESSION_SLACK_MS, defineQuery, int, num, where, type QueryContext } from "./core.ts";
import type { NormalizedFilters } from "../sql/filters.ts";

export const WINDOWS_MAX = 40;
export const WINDOW_MAX_DAYS = 32;
export const SPAN_MAX_DAYS = 200;

export interface LiftWindow {
	from: number;
	to: number;
}

export interface LiveEventLiftOptions {
	/** The windows (unix ms, `to` exclusive); empty: the filter range. */
	windows: LiftWindow[];
	robuxKey: string;
}

export interface LiftWindowMetrics extends LiftWindow {
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeMinutes: number;
	robux: number;
	purchases: number;
	payers: number;
}

export interface LiveEventLiftResult {
	windows: LiftWindowMetrics[];
}

function windowsOption(input: unknown): LiftWindow[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) throw new Error("windows must be a list of { from, to } (unix ms)");
	if (input.length > WINDOWS_MAX) throw new Error(`windows: at most ${WINDOWS_MAX}`);
	const out = input.map((w, i) => {
		const pair = Array.isArray(w) ? { from: w[0], to: w[1] } : (w as { from?: unknown; to?: unknown });
		const from = Number(pair?.from);
		const to = Number(pair?.to);
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new Error(`windows[${i}] must be { from, to } in unix ms with from < to`);
		if (to - from > WINDOW_MAX_DAYS * DAY_MS) throw new Error(`windows[${i}] is longer than ${WINDOW_MAX_DAYS} days`);
		return { from, to };
	});
	if (out.length) {
		const lo = Math.min(...out.map((w) => w.from));
		const hi = Math.max(...out.map((w) => w.to));
		if (hi - lo > SPAN_MAX_DAYS * DAY_MS) throw new Error(`windows span more than ${SPAN_MAX_DAYS} days`);
	}
	return out;
}

/** `w(k, a, b)`: the windows as rows (UNION ALL: no VALUES lists, so Basin reads it too). */
function windowsCte(windows: LiftWindow[]): string {
	return `w AS (${windows.map((w, k) => `SELECT ${k} AS k, ${int(w.from)} AS a, ${int(w.to)} AS b`).join(" UNION ALL ")})`;
}

function read(ctx: QueryContext, f: NormalizedFilters, windows: LiftWindow[]): { table: string; lo: number; hi: number; filters: string } {
	const lo = Math.min(...windows.map((w) => w.from)) - SESSION_SLACK_MS;
	const hi = Math.max(...windows.map((w) => w.to)) + SESSION_SLACK_MS;
	const filters = `${where(f, ctx, { noTime: true })} AND e.t >= ${int(lo)} AND e.t < ${int(hi)} AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> '' AND ${NOT_STUDIO}`;
	return { table: ctx.table("events", lo, hi), lo, hi, filters };
}

export const liveEventLift = defineQuery<LiveEventLiftOptions, LiveEventLiftResult>({
	name: "live-event-lift",
	summary: "players, new players, sessions, playtime, Robux and payers per time window (the raw numbers of a live event's lift report)",
	defaultDays: 7,
	options: (input = {}) => ({
		windows: windowsOption(input.windows),
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
	}),
	statements(ctx, f, o) {
		const windows = o.windows.length ? o.windows : [{ from: f.from, to: f.to }];
		const lim = ctx.dialect.limit;
		const r = read(ctx, f, windows);
		const w = windowsCte(windows);
		const ev = `ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp FROM ${r.table} e WHERE ${r.filters})`;
		// The part of [t0, t1] inside [a, b): min(t1, b) - max(t0, a) (CASE, not LEAST/GREATEST: both dialects).
		const inside = "(CASE WHEN s.t1 < w.b THEN s.t1 ELSE w.b END) - (CASE WHEN s.t0 > w.a THEN s.t0 ELSE w.a END)";
		return {
			players: `WITH ${w}, ${ev} SELECT w.k AS k, COUNT(DISTINCT ev.pid) AS players FROM w JOIN ev ON ev.t >= w.a AND ev.t < w.b GROUP BY w.k ORDER BY k ${lim(WINDOWS_MAX)}`,
			sessions:
				`WITH ${w}, ${ev}, ${SESSIONS_CTE} SELECT w.k AS k, SUM(CASE WHEN s.t0 >= w.a THEN 1 ELSE 0 END) AS sessions, ` +
				`COUNT(DISTINCT CASE WHEN s.isnew = 1 AND s.t0 >= w.a THEN s.pid END) AS new_players, SUM(${inside}) AS playtime_ms ` +
				`FROM w JOIN s ON s.t0 < w.b AND s.t1 >= w.a GROUP BY w.k ORDER BY k ${lim(WINDOWS_MAX)}`,
			purchases:
				`WITH ${w}, pr AS (SELECT DISTINCT e.pid AS pid, e.sid AS sid, e.t AS t, e.name AS name, e.props AS props, e.src AS esrc FROM ${r.table} e WHERE ${r.filters} AND e.kind = 'purchase'), ` +
				`p AS (SELECT pid, t, COALESCE(${ctx.dialect.jsonNumber("props", o.robuxKey)}, 0) AS robux FROM pr WHERE ${SERVER_PURCHASE}) ` +
				`SELECT w.k AS k, SUM(p.robux) AS robux, COUNT(*) AS purchases, COUNT(DISTINCT p.pid) AS payers FROM w JOIN p ON p.t >= w.a AND p.t < w.b GROUP BY w.k ORDER BY k ${lim(WINDOWS_MAX)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const windows = o.windows.length ? o.windows : [{ from: f.from, to: f.to }];
		const by = (name: string) => new Map((rows[name] ?? []).map((r) => [num(r.k), r]));
		const players = by("players");
		const sessions = by("sessions");
		const purchases = by("purchases");
		return {
			windows: windows.map((win, k) => {
				const s = sessions.get(k);
				const p = purchases.get(k);
				return {
					...win,
					players: num(players.get(k)?.players),
					newPlayers: num(s?.new_players),
					sessions: num(s?.sessions),
					playtimeMinutes: Math.round((num(s?.playtime_ms) / 60_000) * 10) / 10,
					robux: num(p?.robux),
					purchases: num(p?.purchases),
					payers: num(p?.payers),
				};
			}),
		};
	},
});
