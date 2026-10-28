/**
 * The Creator-Hub-style queries (benchmarks, realtime, trends) on a DuckDB holding the fixture, with a third of the
 * players joining by teleport and some tech rows, checked against plain-JS reference computations.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, TODAY, fixtureDb, generateFixture, type Fixture } from "./fixtures.ts";

const HOUR = 3_600_000;
const ENDED = NOW - 10 * 60_000;

/** The fixture, with every 3rd player's joins coming from a teleport and a day of tech rows. */
function fixture(): Fixture {
	const fx = generateFixture();
	for (const e of fx.events) {
		if (e.kind === "session" && e.name === "join" && e.pid && Number(e.pid.slice(1)) % 3 === 0) {
			e.props = JSON.stringify({ ...JSON.parse(e.props as string), from: "teleport" });
		}
	}
	const tech = (t: number, name: string, src: "server" | "client", props: object): EventRow => ({
		v: 1,
		t,
		kind: "tech",
		name,
		job: "job-1",
		art: "a1b2c3d-111111",
		branch: "prod",
		src,
		props: JSON.stringify(props),
		...(src === "client" ? { pid: "p0001", sid: "tech-session" } : {}),
	});
	for (let h = 1; h <= 47; h++) {
		const cur = h <= 24; // NOW - 24 h is the first moment of the current window
		fx.events.push(tech(NOW - h * HOUR, "client", "client", { fps: cur ? 50 : 30, mem: 2000 }));
		fx.events.push(tech(NOW - h * HOUR, "server", "server", { fps: 60, mem: cur ? 400 : 300 }));
	}
	fx.events.push(tech(NOW - 2 * HOUR, "error", "client", { msg: "boom", n: 3 }));
	fx.events.push(tech(NOW - 3 * HOUR, "error", "client", { msg: "boom" }));
	fx.events.push(tech(NOW - 30 * HOUR, "error", "server", { msg: "server only", n: 5 }));
	return fx;
}

const fx = fixture();
let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;

beforeAll(async () => {
	({ instance, connection } = await fixtureDb(fx));
	store = new DuckDbStore(connection, (name) => name, () => NOW);
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

const day = (t: number) => Math.floor(t / DAY);
const players = (from: number, to: number) => fx.events.filter((e) => e.pid && e.sid && e.t >= from && e.t < to);

function sessions(rows: EventRow[]) {
	const out = new Map<string, { pid: string; t0: number; t1: number; isnew: boolean; src: string }>();
	for (const e of rows) {
		const s = out.get(e.sid as string) ?? { pid: e.pid as string, t0: e.t, t1: e.t, isnew: false, src: "unknown" };
		s.t0 = Math.min(s.t0, e.t);
		s.t1 = Math.max(s.t1, e.t);
		s.isnew ||= e.newp === true;
		if (e.kind === "session" && e.name === "join") s.src = JSON.parse(e.props as string).from;
		out.set(e.sid as string, s);
	}
	return [...out.values()];
}

const mean = (values: (number | null)[]) => {
	const kept = values.filter((v): v is number => v !== null);
	return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : null;
};

describe("benchmarks", () => {
	test("period over period, by full UTC days: session time, playtime per DAU, payers, ARPPU, ARPDAU, play-through", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		expect(r.days).toBe(7);
		expect(r.creatorShare).toBe(0.7);
		// The current period is the 7 full days before today (today isn't over).
		const curStart = TODAY - 7;
		expect(r.current.from).toBe(new Date(curStart * DAY).toISOString());
		expect(r.current.to).toBe(new Date(TODAY * DAY).toISOString());
		expect(r.previous.to).toBe(r.current.from);
		const all = sessions(players(0, NOW + DAY));
		for (const [period, start] of [
			[r.current, curStart],
			[r.previous, curStart - 7],
		] as const) {
			const days = Array.from({ length: 7 }, (_, i) => start + i);
			const list = all.filter((s) => day(s.t0) >= start && day(s.t0) < start + 7);
			const perDay = days.map((d) => {
				const ss = list.filter((s) => day(s.t0) === d);
				const dau = new Set(ss.map((s) => s.pid));
				const buys = fx.events.filter((e) => e.kind === "purchase" && day(e.t) === d);
				const payers = new Set(buys.filter((e) => dau.has(e.pid as string)).map((e) => e.pid));
				const robux = buys.reduce((sum, e) => sum + JSON.parse(e.props as string).robux, 0);
				return { dau: dau.size, sessions: ss.length, playtime: ss.reduce((sum, s) => sum + s.t1 - s.t0, 0), payers: payers.size, robux };
			});
			expect(period.players).toBe(new Set(list.map((s) => s.pid)).size);
			expect(period.sessions).toBe(list.length);
			expect(period.dau).toBeCloseTo(perDay.reduce((s, d) => s + d.dau, 0) / 7, 2);
			// Averages of daily values, as Roblox's period averages.
			expect(period.avgSessionMinutes).toBeCloseTo((mean(perDay.map((d) => (d.sessions ? d.playtime / d.sessions : null))) ?? 0) / 60_000, 2);
			expect(period.avgPlaytimeMinutes).toBeCloseTo((mean(perDay.map((d) => (d.dau ? d.playtime / d.dau : null))) ?? 0) / 60_000, 2);
			const cvr = mean(perDay.map((d) => (d.dau ? d.payers / d.dau : null))) ?? 0;
			expect(period.payerConversion.rate).toBeCloseTo(cvr, 4);
			expect(period.payerConversion.count).toBe(perDay.reduce((s, d) => s + d.payers, 0));
			expect(period.payerConversion.of).toBe(perDay.reduce((s, d) => s + d.dau, 0));
			const robux = perDay.reduce((s, d) => s + d.robux, 0);
			expect(period.robux).toBe(robux);
			expect(period.revenue).toBe(Math.round(robux * 0.7));
			const arppu = mean(perDay.map((d) => (d.payers ? (d.robux * 0.7) / d.payers : null)));
			if (arppu === null) expect(period.arppu).toBeNull();
			else expect(period.arppu).toBeCloseTo(arppu, 2);
			expect(period.arpdau).toBeCloseTo(mean(perDay.map((d) => (d.dau ? (d.robux * 0.7) / d.dau : null))) ?? 0, 3);
			const first = list.filter((s) => s.isnew && s.t1 < ENDED);
			expect(period.playThrough.of).toBe(first.length);
			expect(period.playThrough.count).toBe(first.filter((s) => s.t1 - s.t0 >= 5 * 60_000).length);
		}
		expect(r.current.robux).toBeGreaterThan(0);
	});

	test("D1 / D7 by first play date: the 7 latest cohorts whose day 1 / 7 is over, the mean of their rates", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		const firsts = new Map<string, number>();
		for (const e of fx.events) if (e.pid && e.sid && e.newp) firsts.set(e.pid, Math.min(firsts.get(e.pid) ?? Infinity, e.t));
		const starts = new Set(sessions(players(0, NOW + DAY)).map((s) => `${s.pid}|${day(s.t0)}`));
		for (const k of [1, 7] as const) {
			const last = TODAY - 1 - k;
			const rates: (number | null)[] = [];
			let count = 0;
			let of = 0;
			for (let d = last - 6; d <= last; d++) {
				const cohort = [...firsts].filter(([, t]) => day(t) === d);
				const kept = cohort.filter(([pid]) => starts.has(`${pid}|${d + k}`)).length;
				rates.push(cohort.length ? kept / cohort.length : null);
				count += kept;
				of += cohort.length;
			}
			const got = k === 1 ? r.current.d1Retention : r.current.d7Retention;
			expect(got).toMatchObject({ count, of, cohortFrom: new Date((last - 6) * DAY).toISOString().slice(0, 10), cohortTo: new Date(last * DAY).toISOString().slice(0, 10) });
			expect(got.rate).toBeCloseTo(mean(rates) ?? 0, 4);
		}
		expect(r.current.d7Retention.of).toBeGreaterThan(0);
	});
});

describe("realtime", () => {
	test("sessions, client errors per session, fps, server memory: last 24 h vs the 24 h before", async () => {
		const r = await store.query("realtime", {}, { hours: 24 });
		const mid = NOW - 24 * HOUR;
		const all = sessions(players(NOW - 48 * HOUR, NOW));
		const cur = all.filter((s) => s.t0 >= mid);
		const ended = cur.filter((s) => s.t1 < ENDED);
		expect(r.current.sessions).toBe(cur.length);
		expect(r.current.avgSessionMinutes).toBeCloseTo(ended.reduce((sum, s) => sum + s.t1 - s.t0, 0) / ended.length / 60_000, 2);
		expect(r.current.clientErrors).toBe(4); // n = 3, and one row without n; the server error doesn't count
		expect(r.current.errorsPerSession).toBeCloseTo(4 / cur.length, 3);
		expect(r.previous.clientErrors).toBe(0);
		expect(r.current.clientFps).toBe(50);
		expect(r.previous.clientFps).toBe(30);
		expect(r.current.serverMemoryMb).toBe(400);
		expect(r.previous.serverMemoryMb).toBe(300);
	});

	test("concurrent users from heartbeats: per minute, summed over servers, hourly averages and peaks", async () => {
		const r = await store.query("realtime", {}, { ccuDays: 2 });
		expect(r.ccu.now).toBe(30); // three servers with 10 players each sent a heartbeat in the last 2 minutes
		expect(r.ccu.series.length).toBe(49);
		const perMinute = new Map<number, Map<string, number>>();
		for (const e of fx.events.filter((x) => x.kind === "fleet" && x.name === "heartbeat" && x.t >= NOW - 2 * DAY)) {
			const m = Math.floor(e.t / 60_000);
			const jobs = perMinute.get(m) ?? new Map<string, number>();
			jobs.set(e.job, Math.max(jobs.get(e.job) ?? 0, JSON.parse(e.props as string).n));
			perMinute.set(m, jobs);
		}
		const byHour = new Map<number, { sum: number; peak: number }>();
		for (const [m, jobs] of perMinute) {
			const ccu = [...jobs.values()].reduce((a, b) => a + b, 0);
			const h = Math.floor(m / 60);
			const v = byHour.get(h) ?? { sum: 0, peak: 0 };
			v.sum += ccu;
			v.peak = Math.max(v.peak, ccu);
			byHour.set(h, v);
		}
		const last = r.ccu.series.at(-1);
		const before = r.ccu.series.at(-2);
		const h = Math.floor(NOW / HOUR);
		expect(before?.peak).toBe(byHour.get(h - 1)?.peak ?? 0);
		expect(before?.avg).toBeCloseTo((byHour.get(h - 1)?.sum ?? 0) / 60, 2);
		expect(last?.hour).toBe(new Date(h * HOUR).toISOString());
		expect(r.ccu.series.slice(0, 20).every((p) => p.avg === 0 && p.peak === 0)).toBe(true);
		expect(r.ccu.currentAvg).toBeGreaterThan(0);
		// Roblox's "Peak concurrent players": the highest minute (three servers with 10 each).
		expect(r.ccu.currentPeak).toBe(30);
		expect(r.ccu.previousPeak).toBe(0);
	});
});

describe("trends", () => {
	test("moving averages per day, in total and per join source", async () => {
		const r = await store.query("trends", {}, { window: 7 });
		expect(r.window).toBe(7);
		expect(r.sources.sort()).toEqual(["direct", "teleport"]);
		expect(r.days.length).toBe(28); // 28 days back from mid-day: 29 calendar days, today isn't over
		const lastDay = r.days.at(-1);
		expect(lastDay?.date).toBe(new Date((TODAY - 1) * DAY).toISOString().slice(0, 10));
		// Reference: player-days by the day their first session that day started, source = that session's join.
		const all = sessions(players(NOW - 35 * DAY, NOW + DAY));
		const firstOfDay = new Map<string, { src: string; t0: number }>();
		for (const s of all) {
			const key = `${s.pid}|${day(s.t0)}`;
			const seen = firstOfDay.get(key);
			if (!seen || s.t0 < seen.t0) firstOfDay.set(key, { src: s.src, t0: s.t0 });
		}
		const dauOn = (d: number, src?: string) => [...firstOfDay].filter(([key, v]) => Number(key.split("|")[1]) === d && (!src || v.src === src)).length;
		const ma = (d: number, src?: string) => Math.round((Array.from({ length: 7 }, (_, i) => dauOn(d - i, src)).reduce((a, b) => a + b, 0) / 7) * 100) / 100;
		for (const [i, point] of r.days.entries()) {
			const d = Math.floor((NOW - 28 * DAY) / DAY) + i;
			expect(point.total.dau).toBeCloseTo(ma(d), 2);
			expect(point.bySource.teleport.dau).toBeCloseTo(ma(d, "teleport"), 2);
			expect(point.bySource.direct.dau + point.bySource.teleport.dau).toBeCloseTo(point.total.dau, 1);
		}
		// D1: the mean of the window's daily cohort rates (cohorts by first play date whose next day is over).
		const firsts = new Map<string, number>();
		for (const s of all) if (s.isnew) firsts.set(s.pid, Math.min(firsts.get(s.pid) ?? Infinity, s.t0));
		const starts = new Set(all.map((s) => `${s.pid}|${day(s.t0)}`));
		const d1At = (d: number) => {
			const rates: number[] = [];
			for (let c = d - 6; c <= d; c++) {
				if (c + 1 >= TODAY) continue;
				const cohort = [...firsts].filter(([, t]) => day(t) === c);
				if (cohort.length) rates.push(cohort.filter(([pid]) => starts.has(`${pid}|${c + 1}`)).length / cohort.length);
			}
			return rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10_000) / 10_000 : null;
		};
		expect(r.days.at(-3)?.total.d1).toBe(d1At(TODAY - 3));
		expect(r.days.at(-1)?.total.d1).toBe(d1At(TODAY - 1));
		// Session time and playtime per DAU: means of the daily values.
		const perDay = (d: number) => {
			const ss = all.filter((s) => day(s.t0) === d);
			return { sessions: ss.length, dau: new Set(ss.map((s) => s.pid)).size, playtime: ss.reduce((sum, s) => sum + s.t1 - s.t0, 0) };
		};
		const window = Array.from({ length: 7 }, (_, i) => perDay(TODAY - 7 + i));
		expect(r.days.at(-1)?.total.sessionMinutes).toBeCloseTo((mean(window.map((v) => (v.sessions ? v.playtime / v.sessions : null))) ?? 0) / 60_000, 2);
		expect(r.days.at(-1)?.total.playtimeMinutes).toBeCloseTo((mean(window.map((v) => (v.dau ? v.playtime / v.dau : null))) ?? 0) / 60_000, 2);
		expect(r.days[10].total.newUsers).toBeGreaterThan(0);
		expect(r.days[10].total.playtimeMinutes).toBeGreaterThan(0);
	});

	test("sources past maxSources fold into other", async () => {
		const r = await store.query("trends", {}, { maxSources: 1 });
		expect(r.sources).toEqual(["other"]);
		expect(r.days.at(-2)?.bySource.other.dau).toBeCloseTo(r.days.at(-2)?.total.dau ?? -1, 2);
	});
});
