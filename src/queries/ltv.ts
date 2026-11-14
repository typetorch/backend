/**
 * Revenue per cohort (LTV): per join-day cohort (the `retention` query's: new players, first-ever session in the range,
 * by the UTC day of their first row; every filter applies, so with a join source or country filter it answers "did
 * the players from this campaign pay back"), the Robux they spent from their join day through day N (D0 = the join day
 * itself), per player of the cohort, and the share of the cohort who had paid by then.
 *
 * Purchases follow `monetization`: server-sent rows only (SERVER_PURCHASE), each distinct row once, Studio left out;
 * `robux` is what players paid (gross), `revenue` what the creator keeps (robux x `creatorShare`, 0.7 by default).
 * A cohort player's purchases count on any device, branch or build (like retention's return days: the cohort is
 * filtered, their later play isn't).
 *
 * Cells: a day not started yet (join day + N after today, UTC) is null; the day in progress (join day + N = today) is
 * `partial` (so far, can only go up) and stays out of the average; the average is weighted by cohort size over the
 * cohorts whose day N is over.
 */
import { PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import { shareOption } from "./benchmarks.ts";
import { NOT_STUDIO, SERVER_PURCHASE, dayOf, defineQuery, int, iso, isoDay, num, ratio, round, type QueryContext } from "./core.ts";
import { cohortCte } from "./overview.ts";

export const LTV_DAYS = [0, 1, 3, 7, 14, 30];

export interface LtvOptions {
	/** Day offsets (default 0, 1, 3, 7, 14, 30; 0-90, at most 12). */
	days: number[];
	/** props key of the Robux amount. */
	robuxKey: string;
	/** Share of the price the creator keeps (default 0.7). */
	creatorShare: number;
}

export interface LtvCell {
	/** Robux the cohort paid from its join day through this day (gross). */
	robux: number;
	/** robux / cohort size. */
	robuxPerPlayer: number;
	/** What the creator keeps, per player: robuxPerPlayer x creatorShare. */
	revenuePerPlayer: number;
	/** Cohort players with a purchase by this day. */
	payers: number;
	/** payers / cohort size. */
	payerShare: number;
	/** The day in progress (today, UTC), so far. */
	partial?: true;
	/** The average row: the new players it is weighted over. */
	players?: number;
}

export interface LtvCohort {
	date: string;
	size: number;
	/** offset -> the cumulative numbers; null while that day hasn't started. */
	days: Record<string, LtvCell | null>;
}

export interface LtvResult {
	from: string;
	to: string;
	days: number[];
	creatorShare: number;
	cohorts: LtvCohort[];
	/** Weighted by cohort size over the cohorts whose day is over (partial days left out); null when none is. */
	average: Record<string, LtvCell | null>;
	/** How much of today (UTC) is over, 0-1. */
	todayElapsed: number;
}

function cell(robux: number, payers: number, size: number, share: number): LtvCell {
	const perPlayer = size > 0 ? robux / size : 0;
	return { robux: round(robux, 2), robuxPerPlayer: round(perPlayer, 2), revenuePerPlayer: round(perPlayer * share, 2), payers, payerShare: ratio(payers, size) };
}

export const ltv = defineQuery<LtvOptions, LtvResult>({
	name: "ltv",
	summary: "revenue per join-day cohort: cumulative Robux per player and payer share by D0, D1, D3, D7, D14, D30",
	defaultDays: 30,
	options: (input = {}) => {
		const days = input.days ?? LTV_DAYS;
		if (!Array.isArray(days) || days.length === 0 || days.length > 12 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 90)) {
			throw new Error("days must be 1-12 whole numbers from 0 to 90");
		}
		return {
			days: [...new Set(days)].sort((a, b) => a - b),
			robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
			creatorShare: shareOption(input.creatorShare),
		};
	},
	statements(ctx: QueryContext, f, o) {
		const lim = ctx.dialect.limit;
		const maxDay = Math.max(...o.days);
		const end = f.to + (maxDay + 1) * DAY_MS;
		const robux = `COALESCE(${ctx.dialect.jsonNumber("props", o.robuxKey)}, 0)`;
		const ctes =
			`${cohortCte(ctx, f)}, ` +
			`pr AS (SELECT DISTINCT e.pid AS pid, e.sid AS sid, e.t AS t, e.name AS name, e.props AS props, e.src AS esrc FROM ${ctx.table("events", f.from, end)} e ` +
			`WHERE e.t >= ${int(f.from)} AND e.t < ${int(end)} AND e.kind = 'purchase' AND e.pid IS NOT NULL AND e.pid <> '' AND e.sid IS NOT NULL AND e.sid <> '' AND ${NOT_STUDIO}), ` +
			`p AS (SELECT pid, t, ${robux} AS robux FROM pr WHERE ${SERVER_PURCHASE}), ` +
			`x AS (SELECT c.pid AS pid, c.cday AS cday, ${dayOf("p.t")} - c.cday AS k, p.robux AS robux FROM c JOIN p ON p.pid = c.pid)`;
		const inWindow = `k >= 0 AND k <= ${int(maxDay)}`;
		return {
			cohorts: `WITH ${cohortCte(ctx, f)} SELECT cday, COUNT(*) AS size FROM c GROUP BY cday ORDER BY cday ${lim(10_000)}`,
			robux: `WITH ${ctes} SELECT cday, k, SUM(robux) AS robux FROM x WHERE ${inWindow} GROUP BY cday, k ORDER BY cday, k ${lim(10_000)}`,
			// Each payer once, on the day of their first purchase (cumulated in shape).
			payers:
				`WITH ${ctes} SELECT cday, fk AS k, COUNT(*) AS payers FROM (SELECT pid, cday, MIN(k) AS fk FROM x WHERE ${inWindow} GROUP BY pid, cday) y ` +
				`GROUP BY cday, fk ORDER BY cday, fk ${lim(10_000)}`,
		};
	},
	shape(rows, ctx, f, o) {
		const today = Math.floor(ctx.now / DAY_MS);
		const robuxAt = new Map<number, number[]>();
		const payersAt = new Map<number, number[]>();
		const maxDay = Math.max(...o.days);
		const put = (m: Map<number, number[]>, cday: number, k: number, v: number) => {
			const list = m.get(cday) ?? new Array<number>(maxDay + 1).fill(0);
			if (k >= 0 && k <= maxDay) list[k] = (list[k] ?? 0) + v;
			m.set(cday, list);
		};
		for (const r of rows.robux) put(robuxAt, num(r.cday), num(r.k), num(r.robux));
		for (const r of rows.payers) put(payersAt, num(r.cday), num(r.k), num(r.payers));
		const upTo = (list: number[] | undefined, d: number) => (list ? list.slice(0, d + 1).reduce((a, b) => a + b, 0) : 0);
		const sums: Record<string, { robux: number; payers: number; size: number }> = {};
		const cohorts = rows.cohorts.map((r): LtvCohort => {
			const cday = num(r.cday);
			const size = num(r.size);
			const days: Record<string, LtvCell | null> = {};
			for (const d of o.days) {
				if (cday + d > today) {
					days[d] = null;
					continue;
				}
				const robux = upTo(robuxAt.get(cday), d);
				const payers = upTo(payersAt.get(cday), d);
				days[d] = cell(robux, payers, size, o.creatorShare);
				if (cday + d === today) {
					days[d] = { ...(days[d] as LtvCell), partial: true };
					continue;
				}
				sums[d] ??= { robux: 0, payers: 0, size: 0 };
				sums[d].robux += robux;
				sums[d].payers += payers;
				sums[d].size += size;
			}
			return { date: isoDay(cday), size, days };
		});
		const average: Record<string, LtvCell | null> = {};
		for (const d of o.days) {
			const s = sums[d];
			average[d] = s && s.size > 0 ? { ...cell(s.robux, s.payers, s.size, o.creatorShare), players: s.size } : null;
		}
		const todayElapsed = Math.round(((ctx.now - today * DAY_MS) / DAY_MS) * 1000) / 1000;
		return { from: iso(f.from), to: iso(f.to), days: o.days, creatorShare: o.creatorShare, cohorts, average, todayElapsed };
	},
});
