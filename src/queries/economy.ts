/**
 * The in-game economy from `currency` rows (`name` = currency, props `delta` signed and `reason`, the framework's
 * `currency(player?, name, delta, reason)`): earned vs spent per UTC day with the net and its running total, the top
 * sources (reasons money came in) and sinks (reasons it went out), and per-player numbers over the active players.
 *
 * One currency at a time (`currency`; default the busiest in the range), with the list of every currency seen. Rows are
 * counted once each (DISTINCT: no row id exists, a resent copy is an exact duplicate) and only when the server sent
 * them: the economy is server-authoritative like revenue (SERVER_ONLY_KINDS; old engines let clients send them), so
 * the purchase rule SERVER_PURCHASE applies. Rows without a player (a server-level `currency(name, delta, reason)`)
 * count in the flows but not in the per-player numbers. The games log flows, not balances, so "balance" is the running
 * net since the range start, and "net per player" is what a player gained or lost in the range.
 */
import { PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { dayOf, defineQuery, eventsTable, intOption, iso, isoDay, lit, num, playerRows, round, SERVER_PURCHASE, str, where, type QueryContext } from "./core.ts";

/** Dense day series up to this many days; a longer range lists only days with rows. */
const DENSE_DAYS = 400;

export interface EconomyOptions {
	/** The currency (`name` of the rows); default the busiest in the range. */
	currency?: string;
	/** props key of the signed amount. */
	deltaKey: string;
	/** props key of the source or sink reason. */
	reasonKey: string;
	/** Sources and sinks listed (default 10, at most 50). */
	top: number;
}

export interface EconomyCurrency {
	currency: string;
	rows: number;
	earned: number;
	spent: number;
	players: number;
}

export interface EconomyDay {
	date: string;
	earned: number;
	spent: number;
	/** earned - spent. */
	net: number;
	/** The net added up from the range start to the end of this day. */
	balance: number;
	/** Players with a currency row that day. */
	players: number;
	/** Players with any row that day. */
	activePlayers: number;
	/** earned / activePlayers (0 without any). */
	earnedPerActive: number;
}

export interface EconomyFlow {
	/** The reason as logged ("" when the row had none). */
	reason: string;
	amount: number;
	rows: number;
	players: number;
	/** Of all earned (sources) or all spent (sinks), 0-1. */
	share: number;
}

export interface EconomyResult {
	from: string;
	to: string;
	/** The currency shown, or null when the range has no currency rows. */
	currency: string | null;
	/** Every currency in the range, busiest first (at most 50). */
	currencies: EconomyCurrency[];
	totals: {
		earned: number;
		spent: number;
		net: number;
		rows: number;
		/** Players with a row of this currency. */
		players: number;
		earners: number;
		spenders: number;
		/** Players with any row in the range (the filters applied). */
		activePlayers: number;
		earnedPerActive: number;
		spentPerActive: number;
		/** Each player's net in the range (earned - spent), averaged over the players with a row of this currency. */
		avgNetPerPlayer: number;
		medianNetPerPlayer: number;
		/** spent / earned (0 without earnings): above 1 the economy drains, below 1 it inflates. */
		sinkRatio: number;
	};
	days: EconomyDay[];
	sources: EconomyFlow[];
	sinks: EconomyFlow[];
}

/** A currency name for SQL: a row name (at most 128 characters, no control characters). */
function checkCurrency(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > 128 || /[\0-\x1f]/.test(value)) throw new Error("currency must be a currency name of at most 128 characters");
	return value;
}

/**
 * `cr(pid, t, name, delta, reason)`: the distinct server-sent currency rows in the filters, and `cur(name)`: the one
 * currency shown (the given one, or the busiest).
 */
function currencyCtes(ctx: QueryContext, f: NormalizedFilters, o: EconomyOptions): string {
	const d = ctx.dialect;
	const raw =
		`raw AS (SELECT DISTINCT e.pid AS pid, e.sid AS sid, e.t AS t, e.name AS name, e.props AS props, e.src AS esrc FROM ${eventsTable(ctx, f)} e ` +
		`WHERE ${where(f, ctx)} AND e.kind = 'currency')`;
	const cr =
		`cr AS (SELECT CASE WHEN pid IS NULL OR pid = '' THEN NULL ELSE pid END AS pid, t, name, ${d.jsonNumber("props", o.deltaKey)} AS delta, ` +
		`COALESCE(${d.jsonText("props", o.reasonKey)}, '') AS reason FROM raw WHERE ${SERVER_PURCHASE})`;
	const cur = o.currency
		? `cur AS (SELECT ${lit(o.currency)} AS name)`
		: `cur AS (SELECT name FROM (SELECT name, COUNT(*) AS n FROM cr GROUP BY name) c ORDER BY n DESC, name ${d.limit(1)})`;
	return `${raw}, ${cr}, ${cur}, x AS (SELECT cr.pid AS pid, cr.t AS t, cr.delta AS delta, cr.reason AS reason FROM cr JOIN cur ON cur.name = cr.name WHERE cr.delta IS NOT NULL)`;
}

export const economy = defineQuery<EconomyOptions, EconomyResult>({
	name: "economy",
	summary: "one currency's earned vs spent per day (net and running balance), top sources and sinks, per active player (currency rows)",
	defaultDays: 30,
	options: (input = {}) => {
		const currency = checkCurrency(input.currency);
		return {
			...(currency !== undefined ? { currency } : {}),
			deltaKey: assertSafeKey(input.deltaKey ?? PROP_KEYS.currencyAmount, "deltaKey"),
			reasonKey: assertSafeKey(input.reasonKey ?? "reason", "reasonKey"),
			top: intOption(input.top, "top", 10, 1, 50),
		};
	},
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const ctes = currencyCtes(ctx, f, o);
		const flows = (sign: "in" | "out") =>
			`WITH ${ctes} SELECT reason, SUM(${sign === "in" ? "delta" : "-delta"}) AS amount, COUNT(*) AS n, COUNT(DISTINCT pid) AS players FROM x ` +
			`WHERE delta ${sign === "in" ? ">" : "<"} 0 GROUP BY reason ORDER BY amount DESC, reason ${lim(o.top)}`;
		return {
			currencies:
				`WITH ${ctes} SELECT name, COUNT(*) AS n, SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS earned, ` +
				`SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS spent, COUNT(DISTINCT pid) AS players FROM cr GROUP BY name ORDER BY n DESC, name ${lim(50)}`,
			shown: `WITH ${ctes} SELECT name FROM cur ${lim(1)}`,
			days:
				`WITH ${ctes} SELECT day, SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS earned, SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS spent, ` +
				`COUNT(DISTINCT pid) AS players FROM (SELECT ${dayOf("t")} AS day, pid, delta FROM x) d GROUP BY day ORDER BY day ${lim(10_000)}`,
			active: `SELECT ${dayOf("e.t")} AS day, COUNT(DISTINCT e.pid) AS players FROM ${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx)} GROUP BY ${dayOf("e.t")} ORDER BY day ${lim(10_000)}`,
			activeTotal: `SELECT COUNT(DISTINCT e.pid) AS players FROM ${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx)} ${lim(1)}`,
			totals:
				`WITH ${ctes}, pp AS (SELECT pid, SUM(delta) AS net, MAX(CASE WHEN delta > 0 THEN 1 ELSE 0 END) AS earns, MAX(CASE WHEN delta < 0 THEN 1 ELSE 0 END) AS spends ` +
				`FROM x WHERE pid IS NOT NULL GROUP BY pid) ` +
				`SELECT a.n, a.earned, a.spent, b.players, b.earners, b.spenders, b.avg_net, b.median_net FROM ` +
				`(SELECT COUNT(*) AS n, SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS earned, SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS spent FROM x) a ` +
				`CROSS JOIN (SELECT COUNT(*) AS players, SUM(earns) AS earners, SUM(spends) AS spenders, AVG(net) AS avg_net, ${ctx.dialect.percentile("net", 0.5)} AS median_net FROM pp) b ${lim(1)}`,
			sources: flows("in"),
			sinks: flows("out"),
		};
	},
	shape(rows, _ctx, f) {
		const currency = rows.shown[0] ? str(rows.shown[0].name) : null;
		const t = rows.totals[0] ?? {};
		const earned = num(t.earned);
		const spent = num(t.spent);
		const activePlayers = num(rows.activeTotal[0]?.players);
		const active = new Map(rows.active.map((r) => [num(r.day), num(r.players)]));
		const found = new Map(rows.days.map((r) => [num(r.day), r]));
		const first = Math.floor(f.from / DAY_MS);
		const last = Math.floor((f.to - 1) / DAY_MS);
		// Dense days (a day without rows is zeros, so the balance line is flat there), unless the range is very long.
		const dayNumbers = currency !== null && last - first < DENSE_DAYS ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [...found.keys()];
		let balance = 0;
		const days: EconomyDay[] = dayNumbers.map((day) => {
			const r = found.get(day);
			const e = num(r?.earned);
			const s = num(r?.spent);
			balance += e - s;
			const act = active.get(day) ?? 0;
			return {
				date: isoDay(day),
				earned: round(e),
				spent: round(s),
				net: round(e - s),
				balance: round(balance),
				players: num(r?.players),
				activePlayers: act,
				earnedPerActive: act ? round(e / act) : 0,
			};
		});
		const flow = (r: Record<string, unknown>, whole: number): EconomyFlow => ({
			reason: str(r.reason).slice(0, 64),
			amount: round(num(r.amount)),
			rows: num(r.n),
			players: num(r.players),
			share: whole > 0 ? round(num(r.amount) / whole, 4) : 0,
		});
		return {
			from: iso(f.from),
			to: iso(f.to),
			currency,
			currencies: rows.currencies.map((r) => ({ currency: str(r.name), rows: num(r.n), earned: round(num(r.earned)), spent: round(num(r.spent)), players: num(r.players) })),
			totals: {
				earned: round(earned),
				spent: round(spent),
				net: round(earned - spent),
				rows: num(t.n),
				players: num(t.players),
				earners: num(t.earners),
				spenders: num(t.spenders),
				activePlayers,
				earnedPerActive: activePlayers ? round(earned / activePlayers) : 0,
				spentPerActive: activePlayers ? round(spent / activePlayers) : 0,
				avgNetPerPlayer: round(num(t.avg_net)),
				medianNetPerPlayer: round(num(t.median_net)),
				sinkRatio: earned > 0 ? round(spent / earned, 4) : 0,
			},
			days,
			sources: rows.sources.map((r) => flow(r, earned)),
			sinks: rows.sinks.map((r) => flow(r, spent)),
		};
	},
});
