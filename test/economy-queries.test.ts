/**
 * The economy query on hand-made currency rows in an in-memory DuckDB: earned vs spent per day with the running
 * balance, sources and sinks, per-player numbers, the busiest currency as the default, server-sent distinct rows only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { basinOver } from "./basin-shim.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const D1 = (TODAY - 2) * DAY + 10 * 3_600_000;
const D2 = (TODAY - 1) * DAY + 10 * 3_600_000;
const RANGE = { from: "2026-10-03", to: "2026-10-04" };

const row = (pid: string, t: number, kind: EventRow["kind"], name: string, props?: object, extra: Partial<EventRow> = {}): EventRow => ({
	v: 1,
	t,
	kind,
	name,
	pid,
	sid: pid ? `${pid}-${Math.floor(t / DAY)}` : "",
	job: "job-1",
	art: "a1b2c3d-000001",
	dev: "desktop",
	src: "server",
	...(props ? { props: JSON.stringify(props) } : {}),
	...extra,
});
const coins = (pid: string, t: number, delta: number, reason: string, extra: Partial<EventRow> = {}) => row(pid, t, "currency", "coins", { delta, reason }, extra);

describe("economy", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		await insertRows(connection, "events", [
			row("alice-01", D1, "session", "join"),
			row("bob-0002", D1, "session", "join"),
			row("carol-03", D1, "session", "join"),
			// alice: earns 150, spends 30 on day 1 (one reward row delivered twice).
			coins("alice-01", D1 + 1000, 100, "round_reward"),
			coins("alice-01", D1 + 1000, 100, "round_reward"),
			coins("alice-01", D1 + 2000, 50, "daily_bonus"),
			coins("alice-01", D1 + 3000, -30, "shop"),
			// bob: earns 100 on day 1, spends 210 on day 2.
			coins("bob-0002", D1 + 4000, 100, "round_reward"),
			coins("bob-0002", D2, -200, "shop"),
			coins("bob-0002", D2 + 1000, -10, "upgrade"),
			// A server-level grant (no player), a client-sent row (never counts), a row without a delta.
			coins("", D2 + 2000, 10, "event"),
			coins("bob-0002", D2 + 3000, 99_999, "exploit", { src: "client" }),
			row("alice-01", D2, "currency", "gems", { delta: 5, reason: "quest" }),
			row("alice-01", D2 + 1000, "currency", "gems", { reason: "quest" }),
			// A phone player's coins: gone with the dev filter.
			coins("dave-004", D1, 1000, "round_reward", { dev: "phone" }),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	test("the busiest currency by default: totals, per player, sinks vs sources", async () => {
		const r = await store.query("economy", { ...RANGE, dev: "desktop" });
		expect(r.currency).toBe("coins");
		expect(r.currencies.map((c) => [c.currency, c.rows, c.earned, c.spent, c.players])).toEqual([
			["coins", 7, 260, 240, 2],
			["gems", 2, 5, 0, 1],
		]);
		expect(r.totals).toEqual({
			earned: 260,
			spent: 240,
			net: 20,
			rows: 7,
			players: 2,
			earners: 2,
			spenders: 2,
			activePlayers: 3,
			earnedPerActive: 86.67,
			spentPerActive: 80,
			// alice +120, bob -110.
			avgNetPerPlayer: 5,
			medianNetPerPlayer: 5,
			sinkRatio: 0.9231,
		});
	});

	test("per day: earned, spent, net and the running balance", async () => {
		const r = await store.query("economy", { ...RANGE, dev: "desktop" });
		expect(r.days).toEqual([
			{ date: "2026-10-03", earned: 250, spent: 30, net: 220, balance: 220, players: 2, activePlayers: 3, earnedPerActive: 83.33 },
			{ date: "2026-10-04", earned: 10, spent: 210, net: -200, balance: 20, players: 1, activePlayers: 2, earnedPerActive: 5 },
		]);
	});

	test("top sources and sinks", async () => {
		const r = await store.query("economy", { ...RANGE, dev: "desktop" });
		expect(r.sources).toEqual([
			{ reason: "round_reward", amount: 200, rows: 2, players: 2, share: 0.7692 },
			{ reason: "daily_bonus", amount: 50, rows: 1, players: 1, share: 0.1923 },
			{ reason: "event", amount: 10, rows: 1, players: 0, share: 0.0385 },
		]);
		expect(r.sinks).toEqual([
			{ reason: "shop", amount: 230, rows: 2, players: 2, share: 0.9583 },
			{ reason: "upgrade", amount: 10, rows: 1, players: 1, share: 0.0417 },
		]);
		expect((await store.query("economy", { ...RANGE, dev: "desktop" }, { top: 1 })).sources.map((s) => s.reason)).toEqual(["round_reward"]);
	});

	test("a picked currency, and the filters apply", async () => {
		const gems = await store.query("economy", RANGE, { currency: "gems" });
		expect(gems.currency).toBe("gems");
		expect(gems.totals).toMatchObject({ earned: 5, spent: 0, rows: 1, players: 1, sinkRatio: 0 });
		const all = await store.query("economy", RANGE);
		expect(all.totals.earned).toBe(1260);
		expect(all.totals.activePlayers).toBe(4);
		const missing = await store.query("economy", RANGE, { currency: "tokens" });
		expect(missing.currency).toBe("tokens");
		expect(missing.totals.rows).toBe(0);
		expect(missing.days.every((d) => d.earned === 0 && d.balance === 0)).toBe(true);
	});

	test("no currency rows: no currency, no days", async () => {
		const r = await store.query("economy", { from: "2026-09-01", to: "2026-09-02" });
		expect(r.currency).toBeNull();
		expect(r.currencies).toEqual([]);
		expect(r.days).toEqual([]);
		expect(r.totals.earned).toBe(0);
	});

	test("the Basin SQL gives the same answer", async () => {
		const basin = await basinOver(connection, NOW);
		for (const [filters, options] of [[{ ...RANGE, dev: "desktop" }, {}], [RANGE, { currency: "gems" }]] as const) {
			expect(await basin.query("economy", filters, options)).toEqual(await store.query("economy", filters, options));
		}
	});

	test("bad options are refused", () => {
		expect(() => store.render("economy", {}, { currency: "x".repeat(129) })).toThrow(/currency/);
		expect(() => store.render("economy", {}, { deltaKey: "a'b" })).toThrow(/deltaKey/);
		expect(() => store.render("economy", {}, { top: 500 })).toThrow(/top/);
		// A quote in a currency name is a literal, not SQL.
		expect(store.render("economy", {}, { currency: "o'clock" }).statements.days).toContain("'o''clock'");
	});
});
