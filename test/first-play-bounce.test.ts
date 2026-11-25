/**
 * first-play-bounce: Creator Hub's first-play bounce chart with a per-device split, from a small hand-made game on
 * DuckDB. Only first sessions that are over count, in the bucket where they started; Studio is left out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import type { FirstPlayBounceResult } from "../src/queries/first-play-bounce.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { NOW, fixtureDb } from "./fixtures.ts";

type Dev = NonNullable<EventRow["dev"]>;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const H10 = NOW - 2 * HOUR; // NOW is 12:00 UTC: buckets 10:00 and 11:00
const at = (h: number, m: number) => H10 + (h - 10) * HOUR + m * MIN;

function row(pid: string, sid: string, t: number, dev: Dev, extra: Partial<EventRow> = {}): EventRow {
	return { v: 1, t, kind: "zone", name: "enter", pid, sid, job: "job-1", srv: "public", art: "a1", branch: "prod", channel: "prod", dev, src: "server", props: "{}", ...extra };
}

function session(pid: string, sid: string, dev: Dev, start: number, end: number, extra: Partial<EventRow> = {}): EventRow[] {
	return [row(pid, sid, start, dev, { kind: "session", name: "join", ...extra }), row(pid, sid, end, dev, { kind: "session", name: "leave", ...extra })];
}
const first = { newp: true } as Partial<EventRow>;

const events: EventRow[] = [
	...session("A", "a1", "phone", at(10, 0), at(10, 0) + 30 * SEC, first), // bounce
	...session("B", "b1", "phone", at(10, 5), at(10, 9), first), // stays 4 min
	...session("C", "c1", "desktop", at(10, 10), at(10, 10) + 50 * SEC, first), // bounce
	...session("D", "d1", "desktop", at(11, 0), at(11, 20), first), // 11:00, stays
	...session("D", "d2", "desktop", at(11, 30), at(11, 30) + 10 * SEC), // not a first session: never counts
	// E: first session still running (no leave, a row 2 minutes ago): not counted, in `running`.
	row("E", "e1", at(11, 50), "phone", { kind: "session", name: "join", newp: true }),
	row("E", "e1", NOW - 2 * MIN, "phone", { newp: true }),
	// F: the previous period, a bounce on a tablet.
	...session("F", "f1", "tablet", at(8, 30), at(8, 30) + 20 * SEC, first),
	// Studio: never counts.
	...session("S", "s1", "desktop", at(10, 0), at(10, 0) + 5 * SEC, { newp: true, srv: "studio" }),
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

describe("first-play-bounce", () => {
	test("per bucket by first-session start, per device, running and Studio left out, vs the period before", async () => {
		const r = (await store.query("first-play-bounce", range, { bucketMinutes: 60 })) as FirstPlayBounceResult;
		expect(r.buckets.map((b) => [b.time.slice(11, 16), b.bounced, b.firstSessions, b.rate])).toEqual([
			["10:00", 2, 3, 0.6667],
			["11:00", 0, 1, 0],
		]);
		expect(r.buckets[0].byDevice).toEqual({ phone: { rate: 0.5, bounced: 1, firstSessions: 2 }, desktop: { rate: 1, bounced: 1, firstSessions: 1 } });
		expect(r.summary).toMatchObject({ bounced: 2, firstSessions: 4, rate: 0.5, dailyMean: 0.3333, running: 1 });
		expect(r.summary.byDevice.desktop).toEqual({ rate: 0.5, bounced: 1, firstSessions: 2, dailyMean: 0.5 });
		expect(r.devices).toEqual(["desktop", "phone"]);
		expect(r.previous).toMatchObject({ bounced: 1, firstSessions: 1, rate: 1 });
		expect(r.previous.byDevice.tablet?.bounced).toBe(1);
	});

	test("bounceSeconds moves the bar; bad options throw", async () => {
		const r = (await store.query("first-play-bounce", range, { bucketMinutes: 60, bounceSeconds: 300 })) as FirstPlayBounceResult;
		expect(r.summary).toMatchObject({ bounced: 3, firstSessions: 4 });
		expect(() => store.render("first-play-bounce", range, { bucketMinutes: 7 })).toThrow("bucketMinutes");
		expect(() => store.render("first-play-bounce", range, { bounceSeconds: 1 })).toThrow("bounceSeconds");
	});
});
