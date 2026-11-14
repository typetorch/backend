/**
 * A live event's lift report: the windows (same weekdays and hours, weeks that clash with other events skipped, cut at
 * now), the raw numbers per window from the `live-event-lift` query on hand-made rows in an in-memory DuckDB, and the
 * math and verdict on a hand-checked case (the example in the README).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { LiftWindowMetrics } from "../src/queries/live-event-lift.ts";
import type { EventRow } from "../src/schema.ts";
import { buildLiftReport, liftOf, metricsOf, planLiftWindows } from "../src/server/live-event-lift.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const WEEK = 7 * DAY;
/** Saturday 2026-10-03 12:00 UTC (the fixtures' NOW is Monday 2026-10-05 12:00). */
const SAT = (TODAY - 2) * DAY + 12 * HOUR;

describe("the windows", () => {
	test("event, after and 3 baseline weeks at the same weekday and hours", () => {
		const plan = planLiftWindows({ start: SAT, end: SAT + 36 * HOUR }, SAT + 30 * DAY, {});
		expect(plan.event).toEqual({ from: SAT, to: SAT + 36 * HOUR });
		expect(plan.after).toEqual({ from: SAT + 36 * HOUR, to: SAT + 36 * HOUR + 3 * DAY });
		expect(plan.stepDays).toBe(7);
		expect(plan.baselines.map((b) => b.event)).toEqual([1, 2, 3].map((k) => ({ from: SAT - k * WEEK, to: SAT + 36 * HOUR - k * WEEK })));
		expect(new Date(plan.baselines[0]!.event.from).getUTCDay()).toBe(6);
		expect(plan.windows).toHaveLength(8);
		expect(plan).toMatchObject({ partial: false, afterPartial: false, skipped: [] });
	});

	test("a long event steps whole weeks past itself and its after window", () => {
		const plan = planLiftWindows({ start: SAT, end: SAT + 6 * DAY }, SAT + 60 * DAY, { weeks: 2, afterDays: 3 });
		expect(plan.stepDays).toBe(14);
		expect(plan.baselines.map((b) => b.event.from)).toEqual([SAT - 2 * WEEK, SAT - 4 * WEEK]);
		expect(plan.baselines[0]!.after!.to).toBeLessThanOrEqual(SAT);
	});

	test("weeks overlapping another event are skipped for earlier ones", () => {
		const other = { from: SAT - WEEK - HOUR, to: SAT - WEEK + HOUR };
		const plan = planLiftWindows({ start: SAT, end: SAT + DAY }, SAT + 10 * DAY, { weeks: 3, afterDays: 1 }, [other]);
		expect(plan.baselines.map((b) => b.weeksBack)).toEqual([2, 3, 4]);
		expect(plan.skipped).toEqual([{ weeksBack: 1, reason: "another live event ran then (2026-09-26T11:00Z)" }]);
	});

	test("while it runs: cut at now, the baselines cut alike; no after window yet", () => {
		const plan = planLiftWindows({ start: SAT, end: SAT + DAY }, SAT + 6 * HOUR, { weeks: 2, afterDays: 2 });
		expect(plan.event).toEqual({ from: SAT, to: SAT + 6 * HOUR });
		expect(plan.baselines[0]!.event).toEqual({ from: SAT - WEEK, to: SAT + 6 * HOUR - WEEK });
		expect(plan).toMatchObject({ partial: true, after: null, afterPartial: true });
		expect(() => planLiftWindows({ start: SAT, end: SAT + DAY }, SAT, {})).toThrow(/hasn't started/);
		expect(() => planLiftWindows({ start: SAT, end: SAT - 1 }, SAT + DAY, {})).toThrow(/never ran/);
	});
});

describe("the math", () => {
	test("hand-checked: 118 against 100, 97, 103", () => {
		const l = liftOf(118, [100, 97, 103]);
		// baseline 100; lift 118 / 100 - 1 = +18%.
		expect(l.baseline).toBe(100);
		expect(l.lift).toBeCloseTo(0.18, 10);
		// Leave-one-out: 100 / 100 - 1 = 0; 97 / 101.5 - 1 = -4.43%; 103 / 98.5 - 1 = +4.57%.
		expect(l.spread!.min).toBeCloseTo(97 / 101.5 - 1, 10);
		expect(l.spread!.max).toBeCloseTo(103 / 98.5 - 1, 10);
		expect(l.direction).toBe("up");
		expect(liftOf(102, [100, 97, 103]).direction).toBe("flat");
		expect(liftOf(90, [100, 97, 103]).direction).toBe("down");
	});

	test("too little baseline: unknown; a zero baseline: no lift; nulls are skipped", () => {
		expect(liftOf(5, [4]).direction).toBe("unknown");
		expect(liftOf(5, []).baseline).toBeNull();
		expect(liftOf(5, [0, 0]).lift).toBeNull();
		expect(liftOf(5, [null, 4, 6]).baseline).toBe(5);
	});

	test("per-player metrics: none without players", () => {
		const m = { from: 0, to: 1, players: 0, newPlayers: 0, sessions: 0, playtimeMinutes: 0, robux: 0, purchases: 0, payers: 0 };
		expect(metricsOf(m)).toEqual({ players: 0, playtimePerPlayer: null, sessionsPerPlayer: null, robuxPerPlayer: null, payerConversion: null, newPlayers: 0 });
	});
});

let sids = 0;
function session(pid: string, t0: number, minutes: number, opts: { newp?: boolean; srv?: string; buys?: [number, number, ("server" | "client")?][] } = {}): EventRow[] {
	const sid = `s${++sids}`;
	const base = { v: 1 as const, pid, sid, job: "job-1", art: "a1b2c3d-000001", dev: "desktop" as const, newp: opts.newp ?? false, src: "server" as const, ...(opts.srv ? { srv: opts.srv } : {}) };
	return [
		{ ...base, t: t0, kind: "session" as const, name: "join" },
		...(opts.buys ?? []).map(([m, robux, src]) => ({ ...base, t: t0 + m * MIN, kind: "purchase" as const, name: "product", props: JSON.stringify({ product: 1, robux }), src: src ?? ("server" as const) })),
		{ ...base, t: t0 + minutes * MIN, kind: "session" as const, name: "leave" },
	];
}

/** One window's players: `players` sessions of `minutes`, the first `payers` buying 100 Robux, the first `fresh` new. */
function crowd(tag: string, from: number, players: number, minutes: number, payers: number, fresh = 0): EventRow[] {
	return Array.from({ length: players }, (_, i) => session(`${tag}-${i}`, from + HOUR + i * 5 * MIN, minutes, { newp: i < fresh, buys: i < payers ? [[5, 100]] : [] })).flat();
}

describe("the query and the report", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;
	const W = { from: SAT, to: SAT + DAY };
	const W2 = { from: SAT + 2 * DAY - 12 * HOUR, to: SAT + 2 * DAY + 11 * HOUR };

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		await insertRows(connection, "events", [
			// The edge cases, in W = Sat 12:00 to Sun 12:00.
			...session("p1", SAT - 30 * MIN, 60), // crosses the start: 30 min inside, didn't start inside
			...session("p2", SAT + HOUR, 20, { newp: true, buys: [[5, 99], [5, 99], [6, 500, "client"]] }), // a resent copy counts once; a client purchase never
			...session("p3", SAT + DAY - 10 * MIN, 20), // crosses the end: 10 min inside
			...session("studio", SAT + 2 * HOUR, 30, { srv: "studio" }), // Studio never counts
			...session("p5", SAT + 2 * DAY - 2 * HOUR, 20), // outside W, inside W2
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	test("per window: players, new players, sessions, clipped playtime, server-sent distinct purchases", async () => {
		const r = await store.query("live-event-lift", { from: W.from, to: W2.to }, { windows: [W, W2] });
		expect(r.windows).toEqual([
			{ ...W, players: 3, newPlayers: 1, sessions: 2, playtimeMinutes: 60, robux: 99, purchases: 1, payers: 1 },
			{ ...W2, players: 1, newPlayers: 0, sessions: 1, playtimeMinutes: 20, robux: 0, purchases: 0, payers: 0 },
		]);
		expect(() => store.render("live-event-lift", {}, { windows: [{ from: 2, to: 1 }] })).toThrow(/from < to/);
		expect(() => store.render("live-event-lift", {}, { windows: [{ from: 0, to: 40 * DAY }] })).toThrow(/32 days/);
	});

	test("the README example: +20% playtime per player, a dip after, +2% net", async () => {
		const { instance: i2, connection: c2 } = await fixtureDb({ events: [], recordings: [] });
		try {
			const ev = { start: SAT, end: SAT + DAY };
			const plan = planLiftWindows(ev, NOW, { weeks: 3, afterDays: 1 });
			// Event: 10 players x 36 min, 3 payers; after: 9 players x 28 min, 1 payer.
			// Baselines (event | after): 10 x 30 | 10 x 30; 10 x 29 | 10 x 31; 10 x 31 | 10 x 29; 2 payers | 1 payer each.
			const rows = [
				...crowd("e", SAT, 10, 36, 3, 2),
				...crowd("a", SAT + DAY, 9, 28, 1),
				...[30, 29, 31].flatMap((m, k) => crowd(`b${k}`, SAT - (k + 1) * WEEK, 10, m, 2, 2)),
				...[30, 31, 29].flatMap((m, k) => crowd(`ba${k}`, SAT + DAY - (k + 1) * WEEK, 10, m, 1)),
			];
			await insertRows(c2, "events", rows);
			const s2 = new DuckDbStore(c2, (name) => name, () => NOW);
			const lo = Math.min(...plan.windows.map((w) => w.from));
			const hi = Math.max(...plan.windows.map((w) => w.to));
			const r = await s2.query("live-event-lift", { from: lo, to: hi }, { windows: plan.windows });
			const report = buildLiftReport(plan, r.windows as LiftWindowMetrics[]);
			expect(report.weeksUsed).toEqual([1, 2, 3]);
			expect(report.event.playtimePerPlayer).toMatchObject({ value: 36, baseline: 30, direction: "up" });
			expect(report.event.playtimePerPlayer.lift).toBeCloseTo(0.2, 10);
			expect(report.event.robuxPerPlayer).toMatchObject({ value: 30, baseline: 20, direction: "up" });
			expect(report.event.sessionsPerPlayer.direction).toBe("flat");
			expect(report.after!.players).toMatchObject({ value: 9, baseline: 10, direction: "down" });
			expect(report.net!.playtimeMinutes).toMatchObject({ value: 612, baseline: 600 });
			expect(report.headline).toBe("up");
			expect(report.verdict).toBe(
				"+20% playtime per player (baseline range -5% to +5%), +50% Robux per player (baseline range +0% to +0%), +50% payer conversion (baseline range +0% to +0%). " +
					"Dip after: -7% playtime per player (baseline range -5% to +5%), -10% players (baseline range +0% to +0%) the 1 day after: part of it was pulled forward; net over the event and the 1 day after: +2% playtime.",
			);
		} finally {
			c2.closeSync();
			i2.closeSync();
		}
	});
});
