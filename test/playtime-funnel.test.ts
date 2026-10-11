/** The built-in playtime funnel: thresholds (edges inclusive), total vs first session, filters, open sessions, empty data. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { PLAYTIME_STEPS_SECONDS } from "../src/queries/funnel.ts";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, fixtureDb } from "./fixtures.ts";

const S = 1000;
const rows: EventRow[] = [];
/** A session: an event at each offset (ms) from `start`. */
function session(pid: string, sid: string, start: number, offsets: number[], extra: Partial<EventRow> = {}) {
	for (const o of offsets) rows.push({ v: 1, t: start + o, kind: "custom", name: "x", pid, sid, job: "job-1", art: "art-1", branch: "main", ...extra });
}
const T = NOW - 2 * DAY;
session("pA", "sA", T, [0, 10 * S, 30 * S], { newp: true }); // exactly 30 s
session("pB", "sB", T, [0], { newp: true }); // one event: zero playtime
session("pC", "sC1", T, [0, 25 * S], { newp: true }); // first session 25 s
session("pC", "sC2", T + DAY, [0, 40 * S]); // + 40 s = 65 s total
session("pD", "sD", T, [0, 60 * S], { branch: "beta" }); // exactly 1 min
session("pE", "sE", NOW - 3 * DAY, [0, 3 * DAY - 60 * S], { newp: true }); // still open, 3 days long: capped at 12 h
session("pF", "sF", T, [0, 179_999]); // just under 3 min
session("pG", "sG", T, [0, 7200 * S]); // exactly 2 h
session("pOld", "sOld", NOW - 40 * DAY, [0, 3600 * S]); // outside the default 30 days
rows.push({ v: 1, t: T, kind: "tech", name: "server", job: "job-1", art: "art-1" }); // a server row: no player

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;
beforeAll(async () => {
	({ instance, connection } = await fixtureDb({ events: rows, recordings: [] }));
	store = new DuckDbStore(connection, (n) => n, () => NOW);
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

const reached = (r: { steps: { reached: number }[] }) => r.steps.map((s) => s.reached);

describe("playtime-funnel", () => {
	test("total playtime: every player in the base, edges inclusive, long sessions capped", async () => {
		const r = await store.query("playtime-funnel");
		expect(r.measure).toBe("total");
		expect(r.players).toBe(7);
		expect(r.steps.map((s) => s.seconds)).toEqual([...PLAYTIME_STEPS_SECONDS]);
		expect(r.steps.map((s) => s.label)).toEqual(["30s", "1m", "3m", "5m", "10m", "30m", "1h", "2h"]);
		// A (30 s), C (65 s), D (60 s), E (capped 12 h), F (179.999 s), G (2 h); B has zero.
		expect(reached(r)).toEqual([6, 5, 2, 2, 2, 2, 2, 2]);
		expect(r.steps[0].ofTotal).toBe(0.8571);
		expect(r.steps[1].fromPrevious).toBe(0.8333);
		expect(r.steps[2].fromPrevious).toBe(0.4);
		expect(r.biggestDrop).toEqual({ seconds: 180, lost: 3, share: 0.6 });
		expect(r.sessionCapHours).toBe(12);
	});

	test("first session: new players' first-ever session only", async () => {
		const r = await store.query("playtime-funnel", {}, { measure: "first" });
		expect(r.measure).toBe("first");
		// A 30 s, B 0, C 25 s (its 40 s session isn't the first), E capped.
		expect(r.players).toBe(4);
		expect(reached(r)).toEqual([2, 1, 1, 1, 1, 1, 1, 1]);
	});

	test("an open session counts up to its latest event", async () => {
		const r = await store.query("playtime-funnel", { from: NOW - 3 * DAY - 1, to: NOW - 3 * DAY + 4 * 60 * S }, {});
		// Only E: its events in the window are its first one; nothing later yet.
		expect(r.players).toBe(1);
		expect(reached(r)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});

	test("filters apply (branch, range)", async () => {
		const beta = await store.query("playtime-funnel", { branch: "beta" });
		expect(beta.players).toBe(1);
		expect(reached(beta)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
		const wide = await store.query("playtime-funnel", { from: NOW - 60 * DAY, to: NOW });
		expect(wide.players).toBe(8);
	});

	test("empty data: zeros, no drop", async () => {
		const r = await store.query("playtime-funnel", { branch: "none" });
		expect(r.players).toBe(0);
		expect(r.steps.every((s) => s.reached === 0 && s.ofTotal === 0 && s.fromPrevious === 0)).toBe(true);
		expect(r.biggestDrop).toBeNull();
	});

	test("one statement; bad measure refused", async () => {
		expect(Object.keys(store.render("playtime-funnel", {}, { measure: "first" }).statements)).toEqual(["funnel"]);
		await expect(store.query("playtime-funnel", {}, { measure: "nope" as never })).rejects.toThrow(/measure/);
	});
});
