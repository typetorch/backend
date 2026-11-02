/**
 * The players query's Robux spent: the sum of `props.robux` over server-sent purchase rows, each distinct row once
 * (a resent copy of a row is an exact duplicate), 0 for players without one, and sort=robux for top spenders first.
 * Hand-made rows in an in-memory DuckDB, plus a reference check against the shared fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, fixtureDb, generateFixture, insertRows } from "./fixtures.ts";

const T = NOW - DAY;

const row = (pid: string, t: number, kind: EventRow["kind"], name: string, props?: object, src: "server" | "client" = "server"): EventRow => ({
	v: 1,
	t,
	kind,
	name,
	pid,
	sid: `${pid}-s1`,
	job: "job-1",
	art: "a1b2c3d-000001",
	src,
	...(props ? { props: JSON.stringify(props) } : {}),
});

describe("players: Robux spent", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		const buy = { product: 1234, robux: 99, where: "shop" };
		await insertRows(connection, "events", [
			// buyer: one purchase delivered twice (exact duplicate), and a second one of a different product.
			row("buyer-0001", T, "session", "start"),
			row("buyer-0001", T + 1000, "purchase", "product", buy),
			row("buyer-0001", T + 1000, "purchase", "product", buy),
			row("buyer-0001", T + 2000, "purchase", "gamepass", { product: 77, robux: 400 }),
			// Same amount at another time is a second purchase, not a duplicate.
			row("buyer-0001", T + 3000, "purchase", "product", buy),
			// whale: one big purchase, seen earlier than the others.
			row("whale-00002", T - 5000, "purchase", "product", { product: 9, robux: 1500 }),
			// liar: a client-sent purchase row (old framework engines) never counts; a row without robux counts 0.
			row("liar-000003", T + 4000, "purchase", "product", { product: 9, robux: 100_000 }, "client"),
			row("liar-000003", T + 4500, "purchase", "product", { product: 9 }),
			// free: no purchases at all, seen last.
			row("free-000004", T + 9000, "session", "start"),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	test("sums distinct server-sent purchase rows per player; 0 without any", async () => {
		const r = await store.query("players", {}, { limit: 100 });
		const by = new Map(r.players.map((p) => [p.pid, p.robux]));
		expect(by.get("buyer-0001")).toBe(99 + 400 + 99);
		expect(by.get("whale-00002")).toBe(1500);
		expect(by.get("liar-000003")).toBe(0);
		expect(by.get("free-000004")).toBe(0);
	});

	test("default order stays most recent first; sort=robux puts top spenders first", async () => {
		const recent = await store.query("players", {}, { limit: 100 });
		expect(recent.players.map((p) => p.pid)).toEqual(["free-000004", "liar-000003", "buyer-0001", "whale-00002"]);
		const top = await store.query("players", {}, { limit: 100, sort: "robux" });
		// Ties (0 Robux) fall back to last seen.
		expect(top.players.map((p) => p.pid)).toEqual(["whale-00002", "buyer-0001", "free-000004", "liar-000003"]);
		const first = await store.query("players", {}, { limit: 1, sort: "robux" });
		expect(first.players.map((p) => p.pid)).toEqual(["whale-00002"]);
	});

	test("search keeps the sums of the matching players", async () => {
		const r = await store.query("players", {}, { search: "buyer", sort: "robux", limit: 10 });
		expect(r.players).toHaveLength(1);
		expect(r.players[0]).toMatchObject({ pid: "buyer-0001", robux: 598 });
	});

	test("orderBy orders the whole range in the database, not the page the limit keeps", async () => {
		const top = await store.query("players", {}, { limit: 1, orderBy: "robux", desc: true });
		expect(top.players.map((p) => p.pid)).toEqual(["whale-00002"]);
		const fewest = await store.query("players", {}, { limit: 100, orderBy: "robux", desc: false });
		expect(fewest.players.map((p) => p.robux)).toEqual([0, 0, 598, 1500]);
		const firstSeen = await store.query("players", {}, { limit: 1, orderBy: "firstSeen", desc: false });
		expect(firstSeen.players.map((p) => p.pid)).toEqual(["whale-00002"]);
		const byPid = await store.query("players", {}, { limit: 100, orderBy: "pid", desc: false });
		expect(byPid.players.map((p) => p.pid)).toEqual(["buyer-0001", "free-000004", "liar-000003", "whale-00002"]);
	});

	test("an unknown orderBy is refused", () => {
		expect(() => store.render("players", {}, { orderBy: "pid; DROP TABLE events" } as never)).toThrow("orderBy");
		expect(() => store.render("players", {}, { orderBy: "pid", desc: "yes" } as never)).toThrow("desc");
	});

	test("an unknown sort is refused", () => {
		expect(() => store.render("players", {}, { sort: "robux DESC; DROP TABLE events" } as never)).toThrow("sort");
	});
});

describe("players: Robux spent on the fixture", () => {
	test("matches a reference sum per player", async () => {
		const fx = generateFixture();
		const { instance, connection } = await fixtureDb(fx);
		try {
			const store = new DuckDbStore(connection, (name) => name, () => NOW);
			const r = await store.query("players", {}, { limit: 1000 });
			const ref = new Map<string, number>();
			for (const e of fx.events) {
				if (e.t < NOW - 30 * DAY || e.t >= NOW || !e.pid || !e.sid || e.kind !== "purchase" || e.src === "client") continue;
				ref.set(e.pid, (ref.get(e.pid) ?? 0) + Number(JSON.parse(e.props ?? "{}").robux ?? 0));
			}
			expect([...ref.values()].some((v) => v > 0)).toBe(true);
			for (const p of r.players) expect(p.robux).toBe(ref.get(p.pid) ?? 0);
		} finally {
			connection.closeSync();
			instance.closeSync();
		}
	});
});
