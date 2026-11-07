/**
 * The experience-notification funnel (plans/29 "Explorer page") per kind and UTC day, from the `notify` rows:
 * wants (framework `want` rows) -> planned (backend, distinct nid) -> sent (backend `sent`, real: neither `dry` nor
 * `test`; dry runs and tests counted apart) -> opened (sends whose nid has an `open` row) -> played >= 1 min (a `played`
 * row with secs >= 60) -> returned D1 (players sent to on day d with a session row on day d + 1).
 *
 * Plus "assisted returns": players sent to (real) who never opened that notification but came back (a session row)
 * within 24 h of the send. Days are the send's day (opens, plays and returns of a send on the last day are read up to
 * two days past the range).
 *
 * `players`, `returnedD1` and `assisted` are distinct players per kind and day; the per-kind and overall totals add
 * the days up (player-days). The send-based counts (planned, sent, opened, played) are distinct nids, so they add up
 * exactly.
 */
import { DAY_MS } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { dayOf, defineQuery, int, iso, isoDay, num, ratio, str, type QueryContext, type Row } from "./core.ts";
import { kindCondition, NOTIFY_SLACK_MS, notifyCte, notifyKindOption, propTrue } from "./notify-common.ts";

export interface NotifyFunnelOptions {
	/** One kind only (the `k` prop). */
	kind?: string;
}

export interface NotifyFunnelCounts {
	/** `want` rows (game servers asking for a notification). */
	wants: number;
	/** Sends the backend planned (distinct nid). */
	planned: number;
	/** Real sends: POSTed to Roblox, not a dry run, not a test. */
	sent: number;
	/** Dry-run sends (planned and logged, never POSTed). */
	dry: number;
	/** Test sends (`POST /v1/notify/test`, real but outside the caps). */
	tests: number;
	/** Distinct players with a real send. */
	players: number;
	/** Real sends that were opened (an `open` row with that nid). */
	opened: number;
	/** Real sends whose opened session lasted at least a minute. */
	played: number;
	/** Players with a real send on day d and a session row on day d + 1. */
	returnedD1: number;
	/** Players with a real send they never opened who came back within 24 h of it. */
	assisted: number;
	/** opened / sent. */
	openRate: number;
	/** played / opened. */
	playedRate: number;
	/** returnedD1 / players. */
	returnRate: number;
}

export interface NotifyFunnelDay extends NotifyFunnelCounts {
	date: string;
	kind: string;
}

export interface NotifyFunnelKind extends NotifyFunnelCounts {
	kind: string;
}

export interface NotifyFunnelResult {
	from: string;
	to: string;
	/** The kind filter, or null for every kind. */
	kind: string | null;
	/** Per kind, the whole range (busiest first). */
	kinds: NotifyFunnelKind[];
	/** Per kind and day (date, then kind). */
	days: NotifyFunnelDay[];
	/** Per day, every kind added up. */
	daily: (NotifyFunnelCounts & { date: string })[];
	totals: NotifyFunnelCounts;
}

const COUNT_KEYS = ["wants", "planned", "sent", "dry", "tests", "players", "opened", "played", "returnedD1", "assisted"] as const;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;

const zero = (): Counts => ({ wants: 0, planned: 0, sent: 0, dry: 0, tests: 0, players: 0, opened: 0, played: 0, returnedD1: 0, assisted: 0 });

function withRates(c: Counts): NotifyFunnelCounts {
	return { ...c, openRate: ratio(c.opened, c.sent), playedRate: ratio(c.played, c.opened), returnRate: ratio(c.returnedD1, c.players) };
}

function add(into: Counts, from: Counts): void {
	for (const key of COUNT_KEYS) into[key] += from[key];
}

/**
 * The CTEs: `n` (notify rows), `s(nid, k, pid, t, dry, tst)` one row per sent nid in the range, `rs` the real ones with
 * their day, `op` opened nids, `pl` nids played >= 60 s, `sd(pid, day)` days with a session row, `se(pid, t0, t1)`
 * sessions (for the 24 h window).
 */
function ctes(ctx: QueryContext, f: NormalizedFilters, o: NotifyFunnelOptions): string {
	const d = ctx.dialect;
	const to = int(f.to);
	const end = f.to + NOTIFY_SLACK_MS;
	const sessionRows =
		`FROM ${ctx.table("events", f.from, end)} e WHERE e.t >= ${int(f.from)} AND e.t < ${int(end)} AND e.kind <> 'notify' ` +
		`AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> ''`;
	return [
		notifyCte(ctx, f, NOTIFY_SLACK_MS),
		`s AS (SELECT nid, MIN(k) AS k, MAX(pid) AS pid, MIN(t) AS t, MAX(dry) AS dry, MAX(tst) AS tst FROM (SELECT ${d.jsonText("props", "nid")} AS nid, ` +
			`COALESCE(${d.jsonText("props", "k")}, '') AS k, pid, t, CASE WHEN ${propTrue("props", "dry")} THEN 1 ELSE 0 END AS dry, ` +
			`CASE WHEN ${propTrue("props", "test")} THEN 1 ELSE 0 END AS tst FROM n WHERE name = 'sent' AND t < ${to}${kindCondition(ctx, o.kind)}) x ` +
			`WHERE nid IS NOT NULL AND nid <> '' GROUP BY nid)`,
		`rs AS (SELECT nid, k, pid, t, ${dayOf("t")} AS day FROM s WHERE dry = 0 AND tst = 0)`,
		`op AS (SELECT DISTINCT ${d.jsonText("props", "nid")} AS nid FROM n WHERE name = 'open')`,
		`pl AS (SELECT DISTINCT nid FROM (SELECT ${d.jsonText("props", "nid")} AS nid, ${d.jsonNumber("props", "secs")} AS secs FROM n WHERE name = 'played') x WHERE secs >= 60)`,
		`sd AS (SELECT DISTINCT e.pid AS pid, ${dayOf("e.t")} AS day ${sessionRows})`,
		`se AS (SELECT e.pid AS pid, e.sid AS sid, MIN(e.t) AS t0, MAX(e.t) AS t1 ${sessionRows} GROUP BY e.pid, e.sid)`,
	].join(", ");
}

export const notifyFunnel = defineQuery<NotifyFunnelOptions, NotifyFunnelResult>({
	name: "notify-funnel",
	summary: "experience notifications per kind and day: wants, planned, sent (and dry), opened, played >= 1 min, returned D1, assisted returns (notify rows)",
	defaultDays: 14,
	options: (input = {}) => {
		const kind = notifyKindOption(input.kind);
		return kind !== undefined ? { kind } : {};
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const lim = d.limit(10_000);
		const w = `WITH ${ctes(ctx, f, o)} `;
		const byRows = (name: string, count: string) =>
			`${w}SELECT k, day, ${count} AS n FROM (SELECT COALESCE(${d.jsonText("props", "k")}, '') AS k, ${dayOf("t")} AS day, ${d.jsonText("props", "nid")} AS nid FROM n ` +
			`WHERE name = '${name}' AND t < ${int(f.to)}${kindCondition(ctx, o.kind)}) x GROUP BY k, day ORDER BY k, day ${lim}`;
		return {
			wants: byRows("want", "COUNT(*)"),
			planned: byRows("planned", "COUNT(DISTINCT nid)"),
			sends:
				`${w}SELECT k, day, SUM(CASE WHEN dry = 0 AND tst = 0 THEN 1 ELSE 0 END) AS sent, SUM(dry) AS dry, SUM(CASE WHEN dry = 0 AND tst = 1 THEN 1 ELSE 0 END) AS tests, ` +
				`COUNT(DISTINCT CASE WHEN dry = 0 AND tst = 0 AND pid <> '' THEN pid END) AS players FROM (SELECT k, pid, dry, tst, ${dayOf("t")} AS day FROM s) x ` +
				`GROUP BY k, day ORDER BY k, day ${lim}`,
			opened: `${w}SELECT rs.k AS k, rs.day AS day, COUNT(*) AS n FROM rs JOIN op ON op.nid = rs.nid GROUP BY rs.k, rs.day ORDER BY k, day ${lim}`,
			played: `${w}SELECT rs.k AS k, rs.day AS day, COUNT(*) AS n FROM rs JOIN pl ON pl.nid = rs.nid GROUP BY rs.k, rs.day ORDER BY k, day ${lim}`,
			returned:
				`${w}SELECT r.k AS k, r.day AS day, COUNT(DISTINCT r.pid) AS n FROM (SELECT DISTINCT k, day, pid FROM rs WHERE pid <> '') r ` +
				`JOIN sd ON sd.pid = r.pid AND sd.day = r.day + 1 GROUP BY r.k, r.day ORDER BY k, day ${lim}`,
			assisted:
				`${w}SELECT a.k AS k, a.day AS day, COUNT(DISTINCT a.pid) AS n FROM (SELECT rs.k AS k, rs.day AS day, rs.pid AS pid, rs.t AS t FROM rs ` +
				`LEFT JOIN op ON op.nid = rs.nid WHERE op.nid IS NULL AND rs.pid <> '') a JOIN se ON se.pid = a.pid AND se.t1 > a.t AND se.t0 <= a.t + ${DAY_MS} ` +
				`GROUP BY a.k, a.day ORDER BY k, day ${lim}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const cells = new Map<string, { kind: string; day: number; c: Counts }>();
		const cell = (r: Row) => {
			const kind = str(r.k);
			const day = num(r.day);
			const key = `${kind}|${day}`;
			let found = cells.get(key);
			if (!found) cells.set(key, (found = { kind, day, c: zero() }));
			return found.c;
		};
		for (const r of rows.wants) cell(r).wants = num(r.n);
		for (const r of rows.planned) cell(r).planned = num(r.n);
		for (const r of rows.sends) {
			const c = cell(r);
			c.sent = num(r.sent);
			c.dry = num(r.dry);
			c.tests = num(r.tests);
			c.players = num(r.players);
		}
		for (const r of rows.opened) cell(r).opened = num(r.n);
		for (const r of rows.played) cell(r).played = num(r.n);
		for (const r of rows.returned) cell(r).returnedD1 = num(r.n);
		for (const r of rows.assisted) cell(r).assisted = num(r.n);

		const list = [...cells.values()].sort((a, b) => a.day - b.day || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
		const perKind = new Map<string, Counts>();
		const perDay = new Map<number, Counts>();
		const totals = zero();
		for (const { kind, day, c } of list) {
			if (!perKind.has(kind)) perKind.set(kind, zero());
			if (!perDay.has(day)) perDay.set(day, zero());
			add(perKind.get(kind) as Counts, c);
			add(perDay.get(day) as Counts, c);
			add(totals, c);
		}
		return {
			from: iso(f.from),
			to: iso(f.to),
			kind: o.kind ?? null,
			kinds: [...perKind.entries()]
				.map(([kind, c]) => ({ kind, ...withRates(c) }))
				.sort((a, b) => b.sent - a.sent || b.wants - a.wants || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
			days: list.map(({ kind, day, c }) => ({ date: isoDay(day), kind, ...withRates(c) })),
			daily: [...perDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, c]) => ({ date: isoDay(day), ...withRates(c) })),
			totals: withRates(totals),
		};
	},
});
