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
		expect(r.creatorShare).toBe(0.7);
		expect(r.totals).toEqual({
			robux: 797,
			revenue: 557.9,
			purchases: 4,
			payers: 3,
			activePlayers: 4,
			playerDays: 6,
			payerConversion: 0.75,
			arppu: 185.97,
			arpdau: 92.9833,
			arpu: 139.48,
			repeatPayers: 1,
			repeatRate: 0.3333,
			purchasesPerPayer: 1.33,
		});
	});

	test("per day", async () => {
		const r = await store.query("monetization", RANGE);
		expect(r.days).toEqual([
			{ date: "2026-10-03", robux: 99, revenue: 69.3, purchases: 1, payers: 1, activePlayers: 3, arpdau: 23.1 },
			{ date: "2026-10-04", robux: 698, revenue: 488.6, purchases: 3, payers: 3, activePlayers: 3, arpdau: 162.8667 },
		]);
	});

	test("by product, numbers and text ids alike", async () => {
		const r = await store.query("monetization", RANGE);
		expect(r.products).toEqual([
			{ kind: "gamepass", product: "77", robux: 400, revenue: 280, purchases: 1, payers: 1, share: 0.5019 },
			{ kind: "product", product: "555", robux: 199, revenue: 139.3, purchases: 1, payers: 1, share: 0.2497 },
			{ kind: "product", product: "1234", robux: 198, revenue: 138.6, purchases: 2, payers: 2, share: 0.2484 },
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

	test("creatorShare sets the creator's cut; 1 is the Robux paid", async () => {
		const full = await store.query("monetization", RANGE, { creatorShare: 1 });
		expect(full.totals).toMatchObject({ robux: 797, revenue: 797, arppu: 265.67, arpdau: 132.8333, arpu: 199.25 });
		expect(() => store.render("monetization", {}, { creatorShare: 0 })).toThrow(/creatorShare/);
	});

	test("filters apply; an empty range is all zeros", async () => {
		const returning = await store.query("monetization", { ...RANGE, players: "returning" });
		expect(returning.totals).toMatchObject({ robux: 400 + 99 + 199, payers: 3 });
		const none = await store.query("monetization", { from: "2026-09-01", to: "2026-09-02" });
		expect(none.totals).toMatchObject({ robux: 0, revenue: 0, purchases: 0, payers: 0, payerConversion: 0, arppu: 0, arpdau: 0, repeatRate: 0 });
		expect(none.products).toEqual([]);
		expect(none.firstPurchase).toMatchObject({ payers: 0, medianMinutes: null, avgMinutes: null });
		expect(none.days.every((d) => d.robux === 0)).toBe(true);
	});

	test("monetization-players: who bought what, biggest spenders first", async () => {
		const all = await store.query("monetization-players", RANGE);
		expect(all).toMatchObject({ kind: null, product: null, creatorShare: 0.7, total: 3, more: 0 });
		expect(all.players).toEqual([
			{ pid: "new1", purchases: 2, robux: 499, revenue: 349.3, products: 2, firstAt: new Date(D1 + 10 * HOUR + 10 * MIN).toISOString(), lastAt: new Date(D2 + 10 * HOUR + 5 * MIN).toISOString() },
			{ pid: "old1", purchases: 1, robux: 199, revenue: 139.3, products: 1, firstAt: new Date(D2 + 12 * HOUR + MIN).toISOString(), lastAt: new Date(D2 + 12 * HOUR + MIN).toISOString() },
			{ pid: "new2", purchases: 1, robux: 99, revenue: 69.3, products: 1, firstAt: new Date(D2 + 15 * HOUR + 5 * MIN).toISOString(), lastAt: new Date(D2 + 15 * HOUR + 5 * MIN).toISOString() },
		]);
		const product = await store.query("monetization-players", RANGE, { kind: "product", product: "1234" });
		expect(product.players.map((p) => [p.pid, p.purchases, p.robux])).toEqual([
			// Same spend: the latest buyer first.
			["new2", 1, 99],
			["new1", 1, 99],
		]);
		// A number id is the same product as its text; the kind narrows.
		expect((await store.query("monetization-players", RANGE, { product: 77 as never })).players.map((p) => p.pid)).toEqual(["new1"]);
		expect((await store.query("monetization-players", RANGE, { kind: "gamepass", product: "1234" })).total).toBe(0);
		const capped = await store.query("monetization-players", RANGE, { limit: 1 });
		expect(capped).toMatchObject({ total: 3, more: 2 });
		expect(() => store.render("monetization-players", {}, { product: "x".repeat(65) })).toThrow(/product/);
	});

	test("monetization-purchases: the latest purchases, newest first", async () => {
		const latest = await store.query("monetization-purchases", RANGE);
		expect(latest).toMatchObject({ creatorShare: 0.7, total: 4, more: 0 });
		expect(latest.purchases.map((p) => [p.pid, p.kind, p.product, p.robux, p.revenue, p.where])).toEqual([
			["new2", "product", "1234", 99, 69.3, "shop"],
			["old1", "product", "555", 199, 139.3, null],
			["new1", "gamepass", "77", 400, 280, null],
			// The resent copy counts once.
			["new1", "product", "1234", 99, 69.3, "shop"],
		]);
		expect(latest.purchases[0]?.at).toBe(new Date(D2 + 15 * HOUR + 5 * MIN).toISOString());
		expect(await store.query("monetization-purchases", RANGE, { limit: 1 })).toMatchObject({ total: 4, more: 3 });
		expect(() => store.render("monetization-purchases", {}, { limit: 0 })).toThrow(/limit/);
	});

	test("the Basin SQL gives the same answer", async () => {
		const basin = await basinOver(connection, NOW);
		for (const [filters, options] of [[RANGE, {}], [{ ...RANGE, players: "returning" }, {}]] as const) {
			expect(await basin.query("monetization", filters, options)).toEqual(await store.query("monetization", filters, options));
		}
		for (const options of [{}, { kind: "product", product: "1234" }] as const) {
			expect(await basin.query("monetization-players", RANGE, options)).toEqual(await store.query("monetization-players", RANGE, options));
		}
		expect(await basin.query("monetization-purchases", RANGE)).toEqual(await store.query("monetization-purchases", RANGE));
	});

	test("bad options are refused", () => {
		expect(() => store.render("monetization", {}, { robuxKey: "a b" })).toThrow(/robuxKey/);
		expect(() => store.render("monetization", {}, { top: 0 })).toThrow(/top/);
	});
});
