/**
 * The monetization query on hand-made purchase rows in an in-memory DuckDB: revenue per day and by product, payer
 * conversion, ARPPU, ARPDAU, repeat purchases and time / session to first purchase, server-sent distinct rows only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { basinOver } from "./basin-shim.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const D1 = (TODAY - 2) * DAY;
const D2 = (TODAY - 1) * DAY;
const RANGE = { from: "2026-10-03", to: "2026-10-04" };

let sids = 0;
/** A session's rows: join at t0, leave 20 minutes later, and `inside` (minutes after t0 -> kind, name, props, src). */
function session(pid: string, t0: number, newp: boolean, inside: [number, EventRow["kind"], string, object, ("server" | "client")?][] = []): EventRow[] {
	const sid = `s${++sids}`;
	const base = { v: 1 as const, pid, sid, job: "job-1", art: "a1b2c3d-000001", dev: "desktop" as const, newp, src: "server" as const };
	return [
		{ ...base, t: t0, kind: "session", name: "join" },
		...inside.map(([m, kind, name, props, src]) => ({ ...base, t: t0 + m * MIN, kind, name, props: JSON.stringify(props), src: src ?? "server" })),
		{ ...base, t: t0 + 20 * MIN, kind: "session", name: "leave" },
	];
}

describe("monetization", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		const buy = { product: 1234, robux: 99, where: "shop" };
		await insertRows(connection, "events", [
			// new1: buys in their first session (delivered twice), and a game pass the next day.
			...session("new1", D1 + 10 * HOUR, true, [
				[10, "purchase", "product", buy],
				[10, "purchase", "product", buy],
			]),
			...session("new1", D2 + 10 * HOUR, false, [[5, "purchase", "gamepass", { product: 77, robux: 400 }]]),
			// new2: first purchase in their third session, 28 h 5 min after joining.
			...session("new2", D1 + 11 * HOUR, true),
			...session("new2", D2 + 9 * HOUR, false),
			...session("new2", D2 + 15 * HOUR, false, [[5, "purchase", "product", buy]]),
			// old1: a returning player; a product id logged as text, and a client-sent purchase (never counts).
			...session("old1", D2 + 12 * HOUR, false, [
				[1, "purchase", "product", { product: "555", robux: 199 }],
				[2, "purchase", "product", { product: 9, robux: 100_000 }, "client"],
			]),
			// free: new, never buys.
			...session("free", D1 + 12 * HOUR, true),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	test("totals: revenue, payers, conversion, ARPPU, ARPDAU, repeat rate", async () => {
		const r = await store.query("monetization", RANGE);
		expect(r.totals).toEqual({
			robux: 797,
			purchases: 4,
			payers: 3,
			activePlayers: 4,
			playerDays: 6,
			payerConversion: 0.75,
			arppu: 265.67,
			arpdau: 132.8333,
			arpu: 199.25,
			repeatPayers: 1,
			repeatRate: 0.3333,
			purchasesPerPayer: 1.33,
		});
	});

	test("per day", async () => {
		const r = await store.query("monetization", RANGE);
		expect(r.days).toEqual([
			{ date: "2026-10-03", robux: 99, purchases: 1, payers: 1, activePlayers: 3, arpdau: 33 },
			{ date: "2026-10-04", robux: 698, purchases: 3, payers: 3, activePlayers: 3, arpdau: 232.6667 },
		]);
	});

	test("by product, numbers and text ids alike", async () => {
		const r = await store.query("monetization", RANGE);
		expect(r.products).toEqual([
			{ kind: "gamepass", product: "77", robux: 400, purchases: 1, payers: 1, share: 0.5019 },
			{ kind: "product", product: "555", robux: 199, purchases: 1, payers: 1, share: 0.2497 },
			{ kind: "product", product: "1234", robux: 198, purchases: 2, payers: 2, share: 0.2484 },
		]);
		expect((await store.query("monetization", RANGE, { top: 1 })).products).toHaveLength(1);
	});

	test("first purchase: time and session after joining, new players only", async () => {
		const r = await store.query("monetization", RANGE);
		expect(r.firstPurchase).toEqual({
			newPlayers: 3,
			payers: 2,
			conversion: 0.6667,
			medianMinutes: 847.5,
			avgMinutes: 847.5,
			bySession: [
				{ session: "1", payers: 1, share: 0.5 },
				{ session: "2", payers: 0, share: 0 },
				{ session: "3", payers: 1, share: 0.5 },
				{ session: "4-5", payers: 0, share: 0 },
				{ session: "6-10", payers: 0, share: 0 },
				{ session: "11+", payers: 0, share: 0 },
			],
		});
	});

	test("filters apply; an empty range is all zeros", async () => {
		const returning = await store.query("monetization", { ...RANGE, players: "returning" });
		expect(returning.totals).toMatchObject({ robux: 400 + 99 + 199, payers: 3 });
		const none = await store.query("monetization", { from: "2026-09-01", to: "2026-09-02" });
		expect(none.totals).toMatchObject({ robux: 0, purchases: 0, payers: 0, payerConversion: 0, arppu: 0, arpdau: 0, repeatRate: 0 });
		expect(none.products).toEqual([]);
		expect(none.firstPurchase).toMatchObject({ payers: 0, medianMinutes: null, avgMinutes: null });
		expect(none.days.every((d) => d.robux === 0)).toBe(true);
	});

	test("the Basin SQL gives the same answer", async () => {
		const basin = await basinOver(connection, NOW);
		for (const [filters, options] of [[RANGE, {}], [{ ...RANGE, players: "returning" }, {}]] as const) {
			expect(await basin.query("monetization", filters, options)).toEqual(await store.query("monetization", filters, options));
		}
	});

	test("bad options are refused", () => {
		expect(() => store.render("monetization", {}, { robuxKey: "a b" })).toThrow(/robuxKey/);
		expect(() => store.render("monetization", {}, { top: 0 })).toThrow(/top/);
	});
});
