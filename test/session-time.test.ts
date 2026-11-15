/**
 * session-time: Creator Hub's Session time chart from a small hand-made game on DuckDB. Sessions count in the bucket
 * where they ended (or started), only once over, weighted and Roblox-style (the mean of the device averages), with
 * rejoins merged on request, vs the period before.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { mergeSessions } from "../src/queries/session-time.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { NOW, fixtureDb } from "./fixtures.ts";

type Dev = NonNullable<EventRow["dev"]>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const H10 = NOW - 2 * HOUR; // NOW is 12:00 UTC: buckets 10:00 and 11:00
const at = (h: number, m: number) => H10 + (h - 10) * HOUR + m * MIN;

function row(pid: string, sid: string, t: number, dev: Dev, extra: Partial<EventRow> = {}): EventRow {
	return { v: 1, t, kind: "zone", name: "enter", pid, sid, job: "job-1", srv: "public", art: "a1", branch: "prod", channel: "prod", dev, src: "server", props: "{}", ...extra };
}

/** A session from `start` to `end` with a join and a leave row. */
function session(pid: string, sid: string, dev: Dev, start: number, end: number, extra: Partial<EventRow> = {}): EventRow[] {
	return [row(pid, sid, start, dev, { kind: "session", name: "join", ...extra }), row(pid, sid, (start + end) / 2, dev, extra), row(pid, sid, end, dev, { kind: "session", name: "leave", ...extra })];
}

const events: EventRow[] = [
	...session("A", "a1", "desktop", at(9, 30), at(10, 20)), // 50 min, started in the previous period, ended at 10:20
	...session("A", "a2", "desktop", at(10, 22), at(10, 40)), // 18 min, A back 2 minutes later
	...session("B", "b1", "phone", at(10, 10), at(10, 14)), // 4
	...session("C", "c1", "phone", at(10, 30), at(10, 40)), // 10
	...session("H", "h1", "phone", at(10, 41), at(10, 43)), // 2
	...session("G", "g1", "phone", at(11, 5), at(11, 15)), // 10, the 11:00 bucket
	// E: still running (a row 2 minutes ago, no leave).
	row("E", "e1", at(11, 0), "desktop", { kind: "session", name: "join" }),
	row("E", "e1", NOW - 2 * MIN, "desktop"),
	// F: the previous period, 20 min.
	...session("F", "f1", "tablet", at(8, 30), at(8, 50)),
	// A Studio play test in the window: never counts.
	...session("S", "s1", "desktop", at(10, 0), at(11, 0), { srv: "studio" }),
];

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;

beforeAll(async () => {
	({ instance, connection } = await fixtureDb({ events, recordings: [] }));
	store = new DuckDbStore(connection, (name) => name, () => NOW);
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

const range = { from: H10, to: NOW };

describe("session-time", () => {
	test("by end (default): each over session in the bucket where it ended, full length; weighted vs Roblox-style total", async () => {
		const r = await store.query("session-time", range, { bucketMinutes: 60 });
		expect(r.by).toBe("end");
		expect(r.buckets.map((b) => b.time)).toEqual([new Date(H10).toISOString(), new Date(H10 + HOUR).toISOString()]);
		const [b10, b11] = r.buckets;
		// 10:00: A 50 + 18 (desktop), B 4, C 10, H 2 (phone).
		expect(b10.sessions).toBe(5);
		expect(b10.avgMinutes).toBe(16.8); // 84 / 5
		expect(b10.byDevice.desktop).toEqual({ sessions: 2, avgMinutes: 34, playtimeMinutes: 68 });
		expect(b10.byDevice.phone.avgMinutes).toBeCloseTo(16 / 3, 2);
		expect(b10.robloxTotal).toBeCloseTo((34 + 16 / 3) / 2, 2); // the mean of the device lines, not 16.8
		expect(b10.players).toBe(4);
		expect(b10.playtimeMinutes).toBe(84);
		expect(b11).toMatchObject({ sessions: 1, avgMinutes: 10, robloxTotal: 10 });
		expect(r.summary).toMatchObject({ sessions: 6, players: 5, medianMinutes: 10, running: 1, playtimeMinutes: 94 });
		expect(r.summary.avgMinutes).toBeCloseTo(94 / 6, 2);
		expect(r.summary.weightedMinuteMean).toBeCloseTo((16.8 + 10) / 2, 2);
		expect(r.summary.robloxHeadline).toBeCloseTo(((34 + 16 / 3) / 2 + 10) / 2, 1);
		expect(r.devices).toEqual(["phone", "desktop"]);
		// The previous period (08:00-10:00): only F ended in it; A ended at 10:20.
		expect(r.previous).toMatchObject({ sessions: 1, avgMinutes: 20, running: 0 });
		const hist = Object.fromEntries(r.histogram.map((h) => [h.label, h.count]));
		expect(hist).toMatchObject({ "<30s": 0, "1-3m": 1, "3-5m": 1, "10-20m": 3, "30-60m": 1, "60m+": 0 });
		expect(r.histogram.reduce((s, h) => s + h.count, 0)).toBe(6);
	});

	test("by start: a session counts where it started", async () => {
		const r = await store.query("session-time", range, { bucketMinutes: 60, by: "start" });
		expect(r.buckets[0].sessions).toBe(4); // A's first session started at 09:30
		expect(r.previous).toMatchObject({ sessions: 2, avgMinutes: 35 }); // A 50 and F 20
	});

	test("mergeGapMinutes joins a player's rejoins into one session", async () => {
		const r = await store.query("session-time", range, { bucketMinutes: 60, mergeGapMinutes: 5 });
		expect(r.buckets[0].byDevice.desktop).toEqual({ sessions: 1, avgMinutes: 70, playtimeMinutes: 70 }); // 09:30-10:40
		expect(r.summary.sessions).toBe(5);
		const off = await store.query("session-time", range, { bucketMinutes: 60, mergeGapMinutes: 1 });
		expect(off.summary.sessions).toBe(6); // 2 minutes apart: not merged at 1
	});

	test("empty buckets stay, with nulls; the default bucket follows the range", async () => {
		const r = await store.query("session-time", { from: NOW - 3 * HOUR, to: NOW }, { bucketMinutes: 60 });
		expect(r.buckets[0]).toMatchObject({ sessions: 0, avgMinutes: null, robloxTotal: null, playtimePerPlayer: null });
		const d = await store.query("session-time", range);
		expect(d.bucketMinutes).toBe(5); // windowBucketMs: 2 hours -> 5 minutes
		expect(d.buckets.length).toBe(24);
	});

	test("options are checked", () => {
		expect(() => store.render("session-time", range, { bucketMinutes: 7 })).toThrow("bucketMinutes");
		expect(() => store.render("session-time", range, { mergeGapMinutes: 31 })).toThrow("mergeGapMinutes");
		expect(() => store.render("session-time", range, { by: "middle" as never })).toThrow("by");
		expect(() => store.render("session-time", { from: NOW - 7 * 24 * HOUR, to: NOW }, { bucketMinutes: 1 })).toThrow("buckets");
	});

	test("mergeSessions keeps the earliest start, the latest end, the last one's over flag and the first known device", () => {
		const out = mergeSessions(
			[
				{ pid: "p", t0: 0, t1: 10, dev: "unknown", over: true },
				{ pid: "p", t0: 12, t1: 20, dev: "phone", over: false },
				{ pid: "q", t0: 13, t1: 14, dev: "desktop", over: true },
			],
			5,
		);
		expect(out).toEqual([
			{ pid: "p", t0: 0, t1: 20, dev: "phone", over: false },
			{ pid: "q", t0: 13, t1: 14, dev: "desktop", over: true },
		]);
	});
});
