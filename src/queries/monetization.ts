/**
 * Revenue from `purchase` rows (`name` = kind, `product` or `gamepass`; props `robux` and `product`, the framework's
 * `purchase(player?, {product, robux, where?, kind?})`): Robux, purchases and payers per UTC day, revenue by product,
 * payer conversion, ARPPU, ARPDAU, repeat purchase rate, and how long new players take to their first purchase.
 *
 * Purchases follow the other revenue queries: server-sent rows only (SERVER_PURCHASE), each distinct row once (no
 * receipt id exists; a resent copy is an exact duplicate, as in `players`), player rows only (pid and sid set).
 *   - `robux` is what players paid; `revenue` is what the creator keeps: robux x `creatorShare` (0.7 by default:
 *     Roblox keeps 30% of developer product and pass sales), as on the Roblox page (benchmarks.ts);
 *   - payer conversion = payers / active players (any row in the range); ARPPU = revenue / payers;
 *   - ARPDAU = revenue / player-days (each day's active players added up), so it is the average day's revenue per DAU;
 *   - repeat purchase rate = payers with 2+ purchases in the range / payers;
 *   - first purchase: new players (first-ever session, `newp`, in the range) whose first purchase in the range came
 *     after they joined: the time from their first row to it, and which of their sessions it was in (1 = the first).
 */
import { PROP_KEYS } from "../schema.ts";
import { shareOption } from "./benchmarks.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { dayOf, defineQuery, eventsTable, intOption, iso, isoDay, lit, num, playerRows, ratio, round, SERVER_PURCHASE, str, strOrNull, type QueryContext } from "./core.ts";

/** Dense day series up to this many days; a longer range lists only days with rows. */
const DENSE_DAYS = 400;

/** The session-number buckets of the first purchase: 1, 2, 3, 4-5, 6-10, 11+. */
export const FIRST_PURCHASE_SESSIONS = [
	{ label: "1", from: 1 },
	{ label: "2", from: 2 },
	{ label: "3", from: 3 },
	{ label: "4-5", from: 4 },
	{ label: "6-10", from: 6 },
	{ label: "11+", from: 11 },
] as const;

export interface MonetizationOptions {
	/** props key of the Robux amount. */
	robuxKey: string;
	/** props key of the product id. */
	productKey: string;
	/** Products listed (default 25, at most 100). */
	top: number;
	/** Share of the price the creator keeps (default 0.7); revenue = robux x this. */
	creatorShare: number;
}

export interface MonetizationDay {
	date: string;
	/** Robux players paid. */
	robux: number;
	/** What the creator keeps: robux x creatorShare. */
	revenue: number;
	purchases: number;
	payers: number;
	/** Players with any row that day. */
	activePlayers: number;
	/** revenue / activePlayers (0 without any). */
	arpdau: number;
}

export interface MonetizationProduct {
	/** The purchase kind (the row's name: `product`, `gamepass`, ...). */
	kind: string;
	/** The product id as logged (text), null when the row had none. */
	product: string | null;
	robux: number;
	/** robux x creatorShare. */
	revenue: number;
	purchases: number;
	payers: number;
	/** Of all Robux, 0-1. */
	share: number;
}

export interface MonetizationResult {
	from: string;
	to: string;
	/** Share of the price the creator keeps. */
	creatorShare: number;
	totals: {
		/** Robux players paid. */
		robux: number;
		/** What the creator keeps: robux x creatorShare. */
		revenue: number;
		purchases: number;
		payers: number;
		activePlayers: number;
		/** Sum of each day's active players. */
		playerDays: number;
		/** payers / activePlayers. */
		payerConversion: number;
		/** Revenue per payer (0 without payers). */
		arppu: number;
		/** Revenue per player-day (0 without players). */
		arpdau: number;
		/** Revenue per active player. */
		arpu: number;
		repeatPayers: number;
		/** repeatPayers / payers. */
		repeatRate: number;
		/** purchases / payers. */
		purchasesPerPayer: number;
	};
	days: MonetizationDay[];
	products: MonetizationProduct[];
	firstPurchase: {
		/** New players (first-ever session in the range). */
		newPlayers: number;
		/** Of them, who bought something after joining. */
		payers: number;
		/** payers / newPlayers. */
		conversion: number;
		/** Minutes from the first row to the first purchase (null without payers). */
		medianMinutes: number | null;
		avgMinutes: number | null;
		/** Which session the first purchase was in. */
		bySession: { session: string; payers: number; share: number }[];
	};
}

/** `ev(pid, sid, t, newp, kind, props, esrc)`: player rows; `p(pid, sid, t, kind, robux, product)`: the distinct server-sent purchases. */
function purchaseCtes(ctx: QueryContext, f: NormalizedFilters, o: Pick<MonetizationOptions, "robuxKey" | "productKey">): string {
	const d = ctx.dialect;
	// A product id may be logged as a number or a string: the text, else the number as digits (Basin's json_get_str skips numbers).
	const product = `COALESCE(${d.jsonText("props", o.productKey)}, CAST(CAST(${d.jsonNumber("props", o.productKey)} AS BIGINT) AS VARCHAR))`;
	return (
		`pr AS (SELECT DISTINCT e.pid AS pid, e.sid AS sid, e.t AS t, e.name AS name, e.props AS props, e.src AS esrc FROM ${eventsTable(ctx, f)} e ` +
		`WHERE ${playerRows(f, ctx)} AND e.kind = 'purchase'), ` +
		`p AS (SELECT pid, sid, t, name AS kind, COALESCE(${d.jsonNumber("props", o.robuxKey)}, 0) AS robux, ${product} AS product FROM pr WHERE ${SERVER_PURCHASE})`
	);
}

export const monetization = defineQuery<MonetizationOptions, MonetizationResult>({
	name: "monetization",
	summary: "Robux, purchases and payers per day, revenue by product, payer conversion, ARPPU, ARPDAU, repeat purchase rate, time and session to first purchase",
	defaultDays: 30,
	options: (input = {}) => ({
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
		productKey: assertSafeKey(input.productKey ?? PROP_KEYS.purchaseProduct, "productKey"),
		top: intOption(input.top, "top", 25, 1, 100),
		creatorShare: shareOption(input.creatorShare),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const ctes = purchaseCtes(ctx, f, o);
		const table = eventsTable(ctx, f);
		const nth = FIRST_PURCHASE_SESSIONS.slice(1)
			.reverse()
			.map((b) => `WHEN nth >= ${b.from} THEN ${b.from}`)
			.join(" ");
		const firstCtes =
			`ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp FROM ${table} e WHERE ${playerRows(f, ctx)}), ` +
			`s AS (SELECT sid, MIN(pid) AS pid, MIN(t) AS t0 FROM ev GROUP BY sid), ` +
			`np AS (SELECT pid, MIN(t) AS j FROM ev WHERE newp = TRUE GROUP BY pid), ` +
			`fp AS (SELECT p.pid AS pid, MIN(p.t) AS ft FROM p JOIN np ON np.pid = p.pid WHERE p.t >= np.j GROUP BY p.pid), ` +
			`k AS (SELECT fp.pid AS pid, fp.ft - np.j AS wait, COUNT(*) AS nth FROM fp JOIN np ON np.pid = fp.pid JOIN s ON s.pid = fp.pid AND s.t0 >= np.j AND s.t0 <= fp.ft ` +
			`GROUP BY fp.pid, fp.ft, np.j)`;
		return {
			totals:
				`WITH ${ctes}, pp AS (SELECT pid, COUNT(*) AS n FROM p GROUP BY pid) ` +
				`SELECT a.robux, a.purchases, b.payers, b.repeat_payers FROM (SELECT SUM(robux) AS robux, COUNT(*) AS purchases FROM p) a ` +
				`CROSS JOIN (SELECT COUNT(*) AS payers, SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) AS repeat_payers FROM pp) b ${lim(1)}`,
			days:
				`WITH ${ctes} SELECT day, SUM(robux) AS robux, COUNT(*) AS purchases, COUNT(DISTINCT pid) AS payers FROM (SELECT ${dayOf("t")} AS day, pid, robux FROM p) d ` +
				`GROUP BY day ORDER BY day ${lim(10_000)}`,
			active: `SELECT ${dayOf("e.t")} AS day, COUNT(DISTINCT e.pid) AS players FROM ${table} e WHERE ${playerRows(f, ctx)} GROUP BY ${dayOf("e.t")} ORDER BY day ${lim(10_000)}`,
			activeTotal: `SELECT COUNT(DISTINCT e.pid) AS players FROM ${table} e WHERE ${playerRows(f, ctx)} ${lim(1)}`,
			products:
				`WITH ${ctes} SELECT kind, product, SUM(robux) AS robux, COUNT(*) AS purchases, COUNT(DISTINCT pid) AS payers FROM p ` +
				`GROUP BY kind, product ORDER BY robux DESC, purchases DESC, kind, product ${lim(o.top)}`,
			firstTotals:
				`WITH ${ctes}, ${firstCtes} SELECT a.new_players, b.payers, b.avg_wait, b.median_wait FROM (SELECT COUNT(*) AS new_players FROM np) a ` +
				`CROSS JOIN (SELECT COUNT(*) AS payers, AVG(wait) AS avg_wait, ${ctx.dialect.percentile("wait", 0.5)} AS median_wait FROM k) b ${lim(1)}`,
			firstBySession:
				`WITH ${ctes}, ${firstCtes} SELECT b, COUNT(*) AS payers FROM (SELECT CASE ${nth} ELSE 1 END AS b FROM k) x GROUP BY b ORDER BY b ${lim(FIRST_PURCHASE_SESSIONS.length)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const t = rows.totals[0] ?? {};
		const robux = num(t.robux);
		const revenue = robux * o.creatorShare;
		const purchases = num(t.purchases);
		const payers = num(t.payers);
		const repeatPayers = num(t.repeat_payers);
		const activePlayers = num(rows.activeTotal[0]?.players);
		const active = new Map(rows.active.map((r) => [num(r.day), num(r.players)]));
		const playerDays = [...active.values()].reduce((a, b) => a + b, 0);
		const found = new Map(rows.days.map((r) => [num(r.day), r]));
		const first = Math.floor(f.from / DAY_MS);
		const last = Math.floor((f.to - 1) / DAY_MS);
		const dayNumbers = last - first < DENSE_DAYS ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [...new Set([...found.keys(), ...active.keys()])].sort((a, b) => a - b);
		const days = dayNumbers.map((day) => {
			const r = found.get(day);
			const act = active.get(day) ?? 0;
			const dayRobux = num(r?.robux);
			const dayRevenue = dayRobux * o.creatorShare;
			return {
				date: isoDay(day),
				robux: round(dayRobux),
				revenue: round(dayRevenue),
				purchases: num(r?.purchases),
				payers: num(r?.payers),
				activePlayers: act,
				arpdau: act ? round(dayRevenue / act, 4) : 0,
			};
		});
		const ft = rows.firstTotals[0] ?? {};
		const firstPayers = num(ft.payers);
		const newPlayers = num(ft.new_players);
		const bySession = new Map(rows.firstBySession.map((r) => [num(r.b), num(r.payers)]));
		return {
			from: iso(f.from),
			to: iso(f.to),
			creatorShare: o.creatorShare,
			totals: {
				robux: round(robux),
				revenue: round(revenue),
				purchases,
				payers,
				activePlayers,
				playerDays,
				payerConversion: ratio(payers, activePlayers),
				arppu: payers ? round(revenue / payers) : 0,
				arpdau: playerDays ? round(revenue / playerDays, 4) : 0,
				arpu: activePlayers ? round(revenue / activePlayers) : 0,
				repeatPayers,
				repeatRate: ratio(repeatPayers, payers),
				purchasesPerPayer: payers ? round(purchases / payers) : 0,
			},
			days,
			products: rows.products.map((r) => ({
				kind: str(r.kind),
				product: strOrNull(r.product)?.slice(0, 64) ?? null,
				robux: round(num(r.robux)),
				revenue: round(num(r.robux) * o.creatorShare),
				purchases: num(r.purchases),
				payers: num(r.payers),
				share: robux > 0 ? round(num(r.robux) / robux, 4) : 0,
			})),
			firstPurchase: {
				newPlayers,
				payers: firstPayers,
				conversion: ratio(firstPayers, newPlayers),
				medianMinutes: firstPayers ? round(num(ft.median_wait) / 60_000, 1) : null,
				avgMinutes: firstPayers ? round(num(ft.avg_wait) / 60_000, 1) : null,
				bySession: FIRST_PURCHASE_SESSIONS.map((b) => {
					const n = bySession.get(b.from) ?? 0;
					return { session: b.label, payers: n, share: ratio(n, firstPayers) };
				}),
			},
		};
	},
});

// monetization-players ---------------------------------------------------------------------------------------------------

/** Most players one monetization -> players read lists (the cap). */
export const MONETIZATION_PLAYERS_MAX = 200;

export interface MonetizationPlayersOptions {
	robuxKey: string;
	productKey: string;
	creatorShare: number;
	/** The purchase kind (`product`, `gamepass`, ...); all kinds when unset. */
	kind?: string;
	/** The product id as text (as `monetization` lists it); every product when unset. */
	product?: string;
	/** Most rows listed (1-200, default 200). */
	limit: number;
}

/** One buyer: what they bought (of the selected product, or of everything) in the range. */
export interface MonetizationPlayer {
	pid: string;
	purchases: number;
	/** Robux they paid. */
	robux: number;
	/** robux x creatorShare. */
	revenue: number;
	/** Distinct products they bought (kind + id). */
	products: number;
	firstAt: string;
	lastAt: string;
	/** Joined in by the server route: the UserId (identity table) and Roblox names (profile cache), when known. */
	uid?: number;
	name?: string;
	displayName?: string;
}

export interface MonetizationPlayersResult {
	kind: string | null;
	product: string | null;
	creatorShare: number;
	/** Buyers matching; `more` of them are not listed. */
	total: number;
	more: number;
	players: MonetizationPlayer[];
}

/**
 * The buyers of one product (or kind, or of anything): the same purchases as `monetization` (server-sent, each distinct
 * row once), per player: purchases, Robux paid, revenue, distinct products, first and last purchase. Biggest spenders
 * first; the total rides along as a window count.
 */
export const monetizationPlayers = defineQuery<MonetizationPlayersOptions, MonetizationPlayersResult>({
	name: "monetization-players",
	summary: "who bought one product (or kind, or anything): purchases, Robux paid, revenue, first and last purchase per player (at most 200)",
	defaultDays: 30,
	options: (input = {}) => {
		const out: MonetizationPlayersOptions = {
			robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
			productKey: assertSafeKey(input.productKey ?? PROP_KEYS.purchaseProduct, "productKey"),
			creatorShare: shareOption(input.creatorShare),
			limit: intOption(input.limit, "limit", MONETIZATION_PLAYERS_MAX, 1, MONETIZATION_PLAYERS_MAX),
		};
		for (const key of ["kind", "product"] as const) {
			const v: unknown = input[key];
			if (v === undefined || v === null || v === "") continue;
			const text = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
			if (typeof text !== "string" || text.length > 64) throw new Error(`${key} must be text of at most 64 characters`);
			out[key] = text;
		}
		return out;
	},
	statements(ctx, f, o) {
		const conds = [o.kind !== undefined ? `kind = ${lit(o.kind)}` : "", o.product !== undefined ? `product = ${lit(o.product)}` : ""].filter(Boolean);
		return {
			players:
				`WITH ${purchaseCtes(ctx, f, o)}, q AS (SELECT * FROM p${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}) ` +
				`SELECT pid, COUNT(*) AS purchases, SUM(robux) AS robux, COUNT(DISTINCT kind || ':' || COALESCE(product, '')) AS products, ` +
				`MIN(t) AS first_t, MAX(t) AS last_t, COUNT(*) OVER () AS total FROM q GROUP BY pid ` +
				`ORDER BY SUM(robux) DESC, MAX(t) DESC, pid ${ctx.dialect.limit(o.limit)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const total = num(rows.players[0]?.total);
		const players = rows.players.map((r) => {
			const robux = num(r.robux);
			return {
				pid: str(r.pid),
				purchases: num(r.purchases),
				robux: round(robux),
				revenue: round(robux * o.creatorShare),
				products: num(r.products),
				firstAt: iso(num(r.first_t)),
				lastAt: iso(num(r.last_t)),
			};
		});
		return { kind: o.kind ?? null, product: o.product ?? null, creatorShare: o.creatorShare, total, more: Math.max(0, total - players.length), players };
	},
});
