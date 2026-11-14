/**
 * The `churn` query on hand-made players in an in-memory DuckDB: each bucket's rule (late for their own rhythm,
 * cooling, lapsing, churned), the bucket counts with payers, the list order, a pids lookup, the filters choosing the
 * population (not their play days), and Basin's SQL giving the same answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import type { BasinStore } from "../src/store/basin.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { basinOver } from "./basin-shim.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const HOUR = 3_600_000;
let sids = 0;
/** One session per listed day (relative to today), at 09:00 UTC (today's is over by NOW, 12:00). */
function plays(pid: string, days: number[], dev: EventRow["dev"] = "desktop", buyOn?: number): EventRow[] {
	return days.flatMap((d, i) => {
		const sid = `s${++sids}`;
		const t0 = (TODAY + d) * DAY + 9 * HOUR;
		const base = { v: 1 as const, pid, sid, job: "job-1", art: "a1b2c3d-000001", dev, newp: i === 0, src: "server" as const };
		return [
			{ ...base, t: t0, kind: "session", name: "join" },
			...(d === buyOn ? [{ ...base, t: t0 + 60_000, kind: "purchase" as const, name: "product", props: JSON.stringify({ product: 1, robux: 99 }) }] : []),
			{ ...base, t: t0 + 20 * 60_000, kind: "session", name: "leave" },
		];
	});
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("churn", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;
	let basin: BasinStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		await insertRows(connection, "events", [
			...plays("daily", range(-6, 0)), // every day, today too: active
			...plays("weekly", [-28, -21, -14, -7]), // once a week, a week ago: on rhythm, active
			...plays("late", range(-9, -2), "phone", -5), // every day until 2 days ago: late for their rhythm, at risk (a payer)
			...plays("cooling", [-27, -25, -23, -21, -19, -17, -15, -1]), // 7 play days in the 2 weeks before, 1 since: at risk
			...plays("once", [-5]), // one play day, 5 days ago: lapsing (past 3x the default 1-day gap)
			...plays("lapsed", [-40, -38, -20], "desktop", -38), // 20 days away: lapsing (a payer)
			...plays("gone", [-60, -50], "phone"), // 50 days away: churned
			// A phone player's later desktop session still counts as play (the population is filtered, their play isn't).
			...plays("switch", [-3], "phone"),
			...plays("switch", [0], "desktop"),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
		basin = await basinOver(connection, NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	const bucketOf = async (pids: string[], filters: object = {}) =>
		Object.fromEntries((await store.query("churn", filters as never, { pids })).list.map((p) => [p.pid, p.bucket]));

	test("each player's bucket follows the rule", async () => {
		expect(await bucketOf(["daily", "weekly", "late", "cooling", "once", "lapsed", "gone", "switch"])).toEqual({
			daily: "active",
			weekly: "active",
			late: "at_risk",
			cooling: "at_risk",
			once: "lapsing",
			lapsed: "lapsing",
			gone: "churned",
			switch: "active",
		});
	});

	test("the numbers behind it: days since, usual gap, play days, the two-week trend", async () => {
		const r = await store.query("churn", {}, { pids: ["weekly", "cooling", "once"] });
		expect(r.bucket).toBeNull();
		const by = Object.fromEntries(r.list.map((p) => [p.pid, p]));
		expect(by.weekly).toMatchObject({ daysSince: 7, usualGap: 7, playDays: 4, recentDays: 1, priorDays: 2 });
		expect(by.cooling).toMatchObject({ daysSince: 1, usualGap: 2, playDays: 8, recentDays: 1, priorDays: 7 });
		expect(by.once).toMatchObject({ daysSince: 5, usualGap: null, playDays: 1, firstPlayed: by.once?.lastPlayed });
		expect(r.asOf).toBe(new Date(TODAY * DAY).toISOString().slice(0, 10));
	});

	test("bucket counts with payers; the list: the most play days first, then the longest away", async () => {
		const r = await store.query("churn");
		expect(r.players).toBe(8);
		expect(r.buckets).toEqual([
			{ bucket: "active", players: 3, share: 0.375 },
			{ bucket: "at_risk", players: 2, share: 0.25 },
			{ bucket: "lapsing", players: 2, share: 0.25 },
			{ bucket: "churned", players: 1, share: 0.125 },
		]);
		expect(r.payers).toEqual({ active: 0, at_risk: 1, lapsing: 1, churned: 0 });
		expect(r.bucket).toBe("at_risk");
		expect(r.list.map((p) => p.pid)).toEqual(["late", "cooling"]);
		expect(r.total).toBe(2);
		const lapsing = await store.query("churn", {}, { bucket: "lapsing", limit: 1 });
		expect(lapsing.list.map((p) => p.pid)).toEqual(["lapsed"]);
		expect(lapsing.more).toBe(1);
	});

	test("filters choose the population: phone players, a shorter range", async () => {
		const phone = await store.query("churn", { dev: "phone" });
		expect(phone.players).toBe(3);
		// switch played on desktop today: still active.
		expect(await bucketOf(["switch"], { dev: "phone" })).toEqual({ switch: "active" });
		const month = await store.query("churn", { from: new Date((TODAY - 29) * DAY).toISOString().slice(0, 10) });
		expect(month.buckets.find((b) => b.bucket === "churned")?.players).toBe(0);
	});

	test("bad options refused", () => {
		expect(() => store.render("churn", {}, { bucket: "gone" as never })).toThrow("bucket must be one of");
		expect(() => store.render("churn", {}, { pids: ["a'b"] })).toThrow("pid");
		expect(() => store.render("churn", {}, { limit: 5000 })).toThrow("limit");
	});

	test("Basin's SQL gives the same answer", async () => {
		for (const [filters, options] of [
			[{}, {}],
			[{ dev: "phone" }, { bucket: "churned" }],
			[{}, { pids: ["weekly", "cooling"] }],
		] as const) {
			expect(JSON.parse(JSON.stringify(await basin.query("churn", filters as never, options as never)))).toEqual(
				JSON.parse(JSON.stringify(await store.query("churn", filters as never, options as never))),
			);
		}
	});
});
