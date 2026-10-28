/**
 * Roblox parity: small hand-made games on DuckDB that pin down each Creator Hub definition the Roblox page follows
 * (README "Roblox parity"): UTC day boundaries and full days only, a session counted on the day it started, retention
 * by first play date with a return only when a later session starts that day, Studio play tests left out, period
 * averages as the mean of daily values, MAU as the trailing 30 days, revenue after Roblox's 30% fee, and CCU as the
 * peak minute.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, TODAY, fixtureDb } from "./fixtures.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const D = (offset: number) => (TODAY + offset) * DAY; // 00:00 UTC, `offset` days from today
const isoDay = (offset: number) => new Date(D(offset)).toISOString().slice(0, 10);

function row(pid: string, sid: string, t: number, extra: Partial<EventRow> = {}): EventRow {
	return { v: 1, t, kind: "zone", name: "enter", pid, sid, job: "job-1", srv: "public", art: "a1", branch: "prod", channel: "prod", dev: "desktop", src: "server", props: "{}", ...extra };
}

/** A session: a join at `start`, one row every 5 minutes, a leave at start + minutes. */
function session(pid: string, sid: string, start: number, minutes: number, extra: Partial<EventRow> = {}): EventRow[] {
	const out = [row(pid, sid, start, { kind: "session", name: "join", props: JSON.stringify({ from: "direct" }), ...extra })];
	for (let m = 5; m < minutes; m += 5) out.push(row(pid, sid, start + m * MIN, extra));
	out.push(row(pid, sid, start + minutes * MIN, { kind: "session", name: "leave", ...extra }));
	return out;
}

const events: EventRow[] = [
	// A: one first session from 23:50 UTC on day -3 to 00:20 on day -2. Day -3's DAU only; not a D1 return.
	...session("A", "a1", D(-3) + 23 * HOUR + 50 * MIN, 30, { newp: true }),
	// B: first session on day -3 (10 min), back on day -2 (20 min) with a 100 Robux purchase.
	...session("B", "b1", D(-3) + 10 * HOUR, 10, { newp: true }),
	...session("B", "b2", D(-2) + 9 * HOUR, 20),
	row("B", "b2", D(-2) + 9 * HOUR + 7 * MIN, { kind: "purchase", name: "product", props: JSON.stringify({ product: 1, robux: 100 }) }),
	// C: two sessions on day -2 (5 and 15 min), never back.
	...session("C", "c1", D(-2) + 8 * HOUR, 5, { newp: true }),
	...session("C", "c2", D(-2) + 12 * HOUR, 15),
	// S: Studio play tests on days -3 and -2, with a purchase: none of it counts.
	...session("S", "s1", D(-3) + 11 * HOUR, 60, { newp: true, srv: "studio" }),
	...session("S", "s2", D(-2) + 11 * HOUR, 60, { srv: "studio" }),
	row("S", "s2", D(-2) + 11 * HOUR + 1 * MIN, { srv: "studio", kind: "purchase", name: "product", props: JSON.stringify({ product: 1, robux: 500 }) }),
	// M: first session on day -40, back on day -10 (its day 30): a D30 return in the previous period, MAU only in the current.
	...session("M", "m1", D(-40) + 10 * HOUR, 10, { newp: true }),
	...session("M", "m2", D(-10) + 10 * HOUR, 10),
	// T: today, 02:00 UTC (over by NOW = 12:00): today isn't a full day yet.
	...session("T", "t1", D(0) + 2 * HOUR, 10, { newp: true }),
	// Heartbeats: a live server with 3 players and a Studio session with 5.
	{ v: 1, t: NOW - MIN, kind: "fleet", name: "heartbeat", job: "job-1", art: "a1", branch: "prod", src: "server", props: JSON.stringify({ t: "public", n: 3 }) },
	{ v: 1, t: NOW - MIN, kind: "fleet", name: "heartbeat", job: "studio-1", art: "a1", branch: "prod", src: "server", props: JSON.stringify({ t: "studio", n: 5 }) },
	{ v: 1, t: NOW - 2 * HOUR, kind: "fleet", name: "heartbeat", job: "job-1", art: "a1", branch: "prod", src: "server", props: JSON.stringify({ t: "public", n: 7 }) },
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

describe("benchmarks follow Creator Hub", () => {
	test("full UTC days, sessions on their start day, Studio left out, averages of daily values, revenue after the fee", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		const p = r.current;
		expect(p.from).toBe(`${isoDay(-7)}T00:00:00.000Z`);
		expect(p.to).toBe(`${isoDay(0)}T00:00:00.000Z`); // today (T's session) isn't in it
		expect(p.players).toBe(3); // A, B, C; not S (Studio), not T (today)
		expect(p.newUsers).toBe(3);
		expect(p.sessions).toBe(5); // a1, b1 on day -3; b2, c1, c2 on day -2
		// DAU: day -3 {A, B}, day -2 {B, C}; A's session past midnight doesn't make A active on day -2.
		expect(p.dau).toBeCloseTo(4 / 7, 2);
		// Average session time: day -3 40 min / 2 sessions, day -2 40 min / 3 sessions; the mean of the days (not 80 / 5 = 16).
		expect(p.avgSessionMinutes).toBeCloseTo((20 + 40 / 3) / 2, 2);
		// Average playtime per DAU: 40 / 2 on both days.
		expect(p.avgPlaytimeMinutes).toBe(20);
		// Payer conversion: day -3 0 of 2, day -2 1 of 2: the mean of the daily rates.
		expect(p.payerConversion).toEqual({ rate: 0.25, count: 1, of: 4 });
		// Revenue after Roblox's 30%: 100 Robux spent -> 70; ARPPU 70 on the day with a payer; ARPDAU (0 + 35) / 2.
		expect(p.robux).toBe(100);
		expect(p.revenue).toBe(70);
		expect(p.arppu).toBe(70);
		expect(p.arpdau).toBe(17.5);
		const all = await store.query("benchmarks", {}, { days: 7, creatorShare: 1 });
		expect(all.current.revenue).toBe(100);
		expect(() => store.render("benchmarks", {}, { creatorShare: 0 })).toThrow("creatorShare");
	});

	test("D1 by first play date: a first session past midnight is not a return; a new session the next day is", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		// D1 cohorts: the 7 latest join days whose day 1 is over (days -8 to -2). Day -3: A and B, B back. Day -2: C, not back.
		expect(r.current.d1Retention).toEqual({ rate: 0.25, count: 1, of: 3, cohortFrom: isoDay(-8), cohortTo: isoDay(-2), history: "complete", dataFrom: isoDay(-40) });
		// D7: no cohort is old enough; the data (from day -40) covers the window, so there just were no new players.
		expect(r.current.d7Retention).toMatchObject({ rate: 0, count: 0, of: 0, history: "complete" });
	});

	test("D30 by first play date, and MAU as the distinct players of the 30 days ending on the period's last day", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		// M joined on day -40 and came back on day -10: a day-30 return for the previous period's cohorts (days -44 to -38).
		// The events start on day -40, inside that window: its first cohorts are missing (partial history).
		expect(r.previous.d30Retention).toEqual({ rate: 1, count: 1, of: 1, cohortFrom: isoDay(-44), cohortTo: isoDay(-38), history: "partial", dataFrom: isoDay(-40) });
		expect(r.current.d30Retention).toEqual({ rate: 0, count: 0, of: 0, cohortFrom: isoDay(-37), cohortTo: isoDay(-31), history: "complete", dataFrom: isoDay(-40) });
		// MAU: days -30 to -1 hold A, B, C and M's return; days -37 to -8 hold M only. S is Studio, T is today.
		expect(r.current.mau).toBe(4);
		expect(r.previous.mau).toBe(1);
		expect(r.current.players).toBe(3); // the period itself (days -7 to -1) doesn't have M
		expect(r.previous.players).toBe(1);
		expect(r.previous.newUsers).toBe(0);
	});
});

describe("a game tracked for a few days", () => {
	let recent: { instance: DuckDBInstance; connection: DuckDBConnection };
	let young: DuckDbStore;
	beforeAll(async () => {
		// Only the events of the last 3 days: tracking started on day -3.
		recent = await fixtureDb({ events: events.filter((e) => e.t >= D(-3)), recordings: [] });
		young = new DuckDbStore(recent.connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		recent.connection.closeSync();
		recent.instance.closeSync();
	});

	test("D7 and D30 say the history doesn't reach their cohorts, instead of 0 of 0", async () => {
		const r = await young.query("benchmarks", {}, { days: 7 });
		expect(r.current.d1Retention).toMatchObject({ count: 1, of: 3, history: "partial", dataFrom: isoDay(-3) }); // cohorts -8 to -2, events from -3
		expect(r.current.d7Retention).toMatchObject({ count: 0, of: 0, history: "none", dataFrom: isoDay(-3) }); // cohorts -14 to -8
		expect(r.current.d30Retention).toMatchObject({ count: 0, of: 0, history: "none", dataFrom: isoDay(-3) });
		expect(r.previous.d1Retention).toMatchObject({ history: "none" });
	});
});

describe("retention and roblox use the same cohort rule", () => {
	test("retention: day 1 counts a session that started on day 1", async () => {
		const r = await store.query("retention", { from: isoDay(-3), to: isoDay(-1) }, { days: [1] });
		const day3 = r.cohorts.find((c) => c.date === isoDay(-3));
		expect(day3).toMatchObject({ size: 2, keptPlayers: { 1: 1 }, kept: { 1: 0.5 } }); // B only, not A
		expect(r.cohorts.find((c) => c.date === isoDay(-2))).toMatchObject({ size: 1, keptPlayers: { 1: 0 } });
		expect(r.cohorts.some((c) => c.size === 0)).toBe(false);
		expect(r.cohorts.reduce((s, c) => s + c.size, 0)).toBe(3); // A, B, C; S is a Studio test (T joined today, after the range)
	});

	test("roblox: Studio play tests are not players", async () => {
		const r = await store.query("roblox", { from: isoDay(-7) });
		expect(r.players).toBe(4); // A, B, C, T
		expect(r.purchases).toBe(1);
		expect(r.d1Retention).toEqual({ rate: 0.3333, count: 1, of: 3 });
	});
});

describe("trends", () => {
	test("one point per full UTC day; ratios are the mean of the window's daily values", async () => {
		const r = await store.query("trends", { from: isoDay(-3) }, { window: 2 });
		expect(r.days.map((d) => d.date)).toEqual([isoDay(-3), isoDay(-2), isoDay(-1)]); // not today
		const [d3, d2, d1] = r.days.map((d) => d.total);
		expect(d3).toMatchObject({ dau: 1, newUsers: 1, sessionMinutes: 20, playtimeMinutes: 20, d1: 0.5 });
		expect(d2.dau).toBe(2);
		expect(d2.sessionMinutes).toBeCloseTo((20 + 40 / 3) / 2, 2);
		expect(d2.playtimeMinutes).toBe(20);
		expect(d2.d1).toBe(0.25); // (day -3: 0.5, day -2: 0) / 2
		expect(d2).toMatchObject({ robux: 50, revenue: 35 }); // 100 Robux on day -2, over a 2-day window
		expect(d1.dau).toBe(1);
		expect(d1.sessionMinutes).toBeCloseTo(40 / 3, 2); // day -1 has no sessions: only day -2 counts
		expect(r.sources).toEqual(["direct"]);
	});
});

describe("realtime", () => {
	test("concurrent users leave Studio servers out; the peak minute is kept per hour", async () => {
		const r = await store.query("realtime", {}, { ccuDays: 1 });
		expect(r.ccu.now).toBe(3);
		expect(r.ccu.currentPeak).toBe(7);
		const twoHoursAgo = r.ccu.series.find((p) => p.hour === new Date(Math.floor((NOW - 2 * HOUR) / HOUR) * HOUR).toISOString());
		expect(twoHoursAgo?.peak).toBe(7);
		expect(r.current.sessions).toBe(1); // T's session today; Studio sessions are older than 24 h anyway
	});
});
