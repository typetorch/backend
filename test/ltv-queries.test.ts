/**
 * The `ltv` query (revenue per join-day cohort) on hand-made rows in an in-memory DuckDB: cumulative Robux per player
 * and payer share at D0 / D1 / D3 / D7 / D14 / D30, days not started null, today's day partial and out of the
 * weighted average, server-sent distinct purchases only, the audience filters narrowing the cohorts; Basin's SQL
 * gives the same answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import type { BasinStore } from "../src/store/basin.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { basinOver } from "./basin-shim.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const A = (TODAY - 8) * DAY; // cohort A's join day
const B = (TODAY - 1) * DAY; // cohort B's join day: its D1 is today

let sids = 0;
/** A session: a join (with `country`), `buys` (minutes after t0 -> robux, src) and a leave 20 minutes later. */
function session(pid: string, t0: number, newp: boolean, country: string, buys: [number, number, ("server" | "client")?][] = []): EventRow[] {
	const sid = `s${++sids}`;
	const base = { v: 1 as const, pid, sid, job: "job-1", art: "a1b2c3d-000001", dev: "desktop" as const, newp, src: "server" as const };
	return [
		{ ...base, t: t0, kind: "session", name: "join", props: JSON.stringify({ from: "direct", country }) },
		...buys.map(([m, robux, src]): EventRow => ({ ...base, t: t0 + m * MIN, kind: "purchase", name: "product", props: JSON.stringify({ product: 1, robux }), src: src ?? "server" })),
		{ ...base, t: t0 + 20 * MIN, kind: "session", name: "leave" },
	];
}

describe("ltv", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;
	let basin: BasinStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		await insertRows(connection, "events", [
			// Cohort A (3 new players): a1 pays 100 on D0, 50 on D2 and 30 today (D8); a3 pays 200 on D1 (delivered twice,
			// plus a client-sent row that never counts); a2 never pays.
			...session("a1", A + 10 * HOUR, true, "BR", [[5, 100]]),
			...session("a1", A + 2 * DAY + 9 * HOUR, false, "BR", [[5, 50]]),
			...session("a1", A + 8 * DAY + 1 * HOUR, false, "BR", [[5, 30]]),
			...session("a2", A + 11 * HOUR, true, "BR"),
			...session("a3", A + 12 * HOUR, true, "BR"),
			...session("a3", A + DAY + 9 * HOUR, false, "BR", [
				[5, 200],
				[5, 200],
				[6, 9999, "client"],
			]),
			// Cohort B (2 new players): b1 pays 10 on D0 and 20 today (D1, in progress); b2 never pays.
			...session("b1", B + 10 * HOUR, true, "US", [[5, 10]]),
			...session("b1", TODAY * DAY + 1 * HOUR, false, "US", [[5, 20]]),
			...session("b2", B + 11 * HOUR, true, "BR"),
			// A returning player's purchase: in no cohort.
			...session("old", A + 13 * HOUR, false, "BR", [[5, 500]]),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
		basin = await basinOver(connection, NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	test("cumulative Robux and revenue per player, payer share; not started null, today partial, weighted average over days that are over", async () => {
		const r = await store.query("ltv");
		expect(r.days).toEqual([0, 1, 3, 7, 14, 30]);
		expect(r.creatorShare).toBe(0.7);
		expect(r.cohorts.map((c) => [c.date, c.size])).toEqual([
			[new Date(A).toISOString().slice(0, 10), 3],
			[new Date(B).toISOString().slice(0, 10), 2],
		]);
		const [a, b] = r.cohorts;
		expect(a?.days[0]).toEqual({ robux: 100, robuxPerPlayer: 33.33, revenuePerPlayer: 23.33, payers: 1, payerShare: 0.3333 });
		expect(a?.days[1]).toEqual({ robux: 300, robuxPerPlayer: 100, revenuePerPlayer: 70, payers: 2, payerShare: 0.6667 });
		expect(a?.days[3]).toMatchObject({ robux: 350, robuxPerPlayer: 116.67, payers: 2 });
		expect(a?.days[7]).toMatchObject({ robux: 350, payers: 2 });
		expect(a?.days[7]?.partial).toBeUndefined();
		// D14 and D30 haven't started (the 30 Robux of D8 is in neither D7 nor a later day yet).
		expect(a?.days[14]).toBeNull();
		expect(a?.days[30]).toBeNull();
		expect(b?.days[0]).toEqual({ robux: 10, robuxPerPlayer: 5, revenuePerPlayer: 3.5, payers: 1, payerShare: 0.5 });
		expect(b?.days[1]).toEqual({ robux: 30, robuxPerPlayer: 15, revenuePerPlayer: 10.5, payers: 1, payerShare: 0.5, partial: true });
		expect(b?.days[3]).toBeNull();
		// D0: both cohorts (110 / 5); D1: only A (B's is partial).
		expect(r.average[0]).toEqual({ robux: 110, robuxPerPlayer: 22, revenuePerPlayer: 15.4, payers: 2, payerShare: 0.4, players: 5 });
		expect(r.average[1]).toMatchObject({ robuxPerPlayer: 100, payers: 2, players: 3 });
		expect(r.average[14]).toBeNull();
		expect(r.todayElapsed).toBe(0.5);
	});

	test("options: days and creatorShare; bad ones refused", async () => {
		const r = await store.query("ltv", {}, { days: [8, 0], creatorShare: 1 });
		expect(r.days).toEqual([0, 8]);
		expect(r.cohorts[0]?.days[8]).toEqual({ robux: 380, robuxPerPlayer: 126.67, revenuePerPlayer: 126.67, payers: 2, payerShare: 0.6667, partial: true });
		expect(() => store.render("ltv", {}, { days: [91] })).toThrow("0 to 90");
		expect(() => store.render("ltv", {}, { days: [] })).toThrow();
		expect(() => store.render("ltv", {}, { creatorShare: 2 })).toThrow("creatorShare");
	});

	test("the filters narrow the cohorts (a campaign's players): country, new player's device, range", async () => {
		const us = await store.query("ltv", { country: "US" });
		expect(us.cohorts.map((c) => c.size)).toEqual([1]);
		expect(us.cohorts[0]?.days[0]).toMatchObject({ robuxPerPlayer: 10, payerShare: 1 });
		expect((await store.query("ltv", { dev: "phone" })).cohorts).toEqual([]);
		const late = await store.query("ltv", { from: new Date(B).toISOString().slice(0, 10) });
		expect(late.cohorts.map((c) => c.size)).toEqual([2]);
	});

	test("Basin's SQL gives the same answer", async () => {
		for (const filters of [{}, { country: "US" }]) {
			expect(JSON.parse(JSON.stringify(await basin.query("ltv", filters)))).toEqual(JSON.parse(JSON.stringify(await store.query("ltv", filters))));
		}
	});
});
