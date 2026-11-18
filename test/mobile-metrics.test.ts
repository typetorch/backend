/**
 * The mobile app's widget stats (mobile docs WIDGET_STATS.md, section 1): GET /v1/mobile/live?metrics=... (every metric
 * on seeded sessions, its value and the window before), the parsing of ids and windows, the per-source cache (TTL, one
 * computation at a time, the last good numbers on a failure, bounded), `releases` (mobile docs WIDGET_RELEASES.md,
 * section 1: seeded deploys per UTC day over 26 weeks, the cell tokens, "rnone" before the history, lastProd) and `game.iconUrl` (6 h, null on failure). Every
 * token is made up; no player id ever shows in an answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ICON_RETRY_MS, ICON_TTL_MS, IconCache } from "../src/server/mobile-live.ts";
import type { ReleaseDay } from "../src/fleet/deploys.ts";
import { METRICS_MAX, METRICS_PARAM_MAX, METRIC_SLOW_TTL_MS, METRIC_TTL_MS, MetricsCache, MobileMetrics, parseMetricId, parseMetricsParam, parseWindow, releaseCell, releaseLevel, releasesFrom, RELEASE_DAYS, type Numbers, type ReleaseCell } from "../src/server/mobile-metrics.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("widget stats: ids and windows", () => {
	test("windows: <n>h 1..72, <n>d 1..90", () => {
		expect(parseWindow("1h")).toBe(HOUR);
		expect(parseWindow("72h")).toBe(72 * HOUR);
		expect(parseWindow("1d")).toBe(DAY);
		expect(parseWindow("90d")).toBe(90 * DAY);
		for (const bad of ["0h", "73h", "0d", "91d", "07d", "1w", "h", "1", "1.5h", "-1h", " 1h", "1H", "100d"]) expect(parseWindow(bad)).toBeUndefined();
	});

	test("ids: units, labels, sources and TTLs; unknown ones null", () => {
		expect(parseMetricId("dau")).toEqual({ id: "dau", unit: "count", label: "DAU", source: `players:${DAY}`, field: "players", ttlMs: METRIC_TTL_MS });
		expect(parseMetricId("mau")).toMatchObject({ unit: "count", label: "MAU", source: `players:${30 * DAY}`, ttlMs: METRIC_SLOW_TTL_MS });
		expect(parseMetricId("d1")).toMatchObject({ unit: "ratio", label: "D1", source: "retention:1", ttlMs: METRIC_TTL_MS });
		expect(parseMetricId("d7")).toMatchObject({ unit: "ratio", label: "D7", source: "retention:7", ttlMs: METRIC_SLOW_TTL_MS });
		expect(parseMetricId("ccu")).toMatchObject({ unit: "count", label: "CCU", source: "live" });
		expect(parseMetricId("peakToday")).toMatchObject({ unit: "count", label: "Peak today", source: "live" });
		expect(parseMetricId("revenue:72h")).toMatchObject({ unit: "robux", label: "Revenue 72h", source: `money:${72 * HOUR}`, field: "revenue" });
		expect(parseMetricId("payers:72h")).toMatchObject({ unit: "count", label: "Payers 72h", source: `money:${72 * HOUR}`, field: "payers" });
		expect(parseMetricId("session:1h")).toMatchObject({ unit: "seconds", label: "Session 1h", source: `sessions:${HOUR}` });
		expect(parseMetricId("playtime:7d")).toMatchObject({ unit: "hours", label: "Playtime 7d", source: `sessions:${7 * DAY}` });
		expect(parseMetricId("sessions:24h")).toMatchObject({ unit: "count", label: "Sessions 24h", source: `sessions:${DAY}` });
		expect(parseMetricId("new:30d")).toMatchObject({ unit: "count", label: "New 30d", source: `players:${30 * DAY}`, field: "new", ttlMs: METRIC_TTL_MS });
		// 24h and 1d are one source.
		expect(parseMetricId("new:24h")?.source).toBe(parseMetricId("new:1d")?.source as string);
		for (const bad of ["", "DAU", "foo", "dau:1h", "new", "new:", "new:0h", "new:73h", "revenue:91d", "revenue:07d", "__proto__", "constructor", "toString", "session:1h:x", "d30"]) expect(parseMetricId(bad)).toBeNull();
	});

	test("the parameter: absent, trimmed, repeats and empties dropped, only an overlong one refused", () => {
		expect(parseMetricsParam(null)).toBeUndefined();
		expect(parseMetricsParam("")).toEqual({ ids: [] });
		expect(parseMetricsParam(" dau , d1,,dau,revenue:72h ")).toEqual({ ids: ["dau", "d1", "revenue:72h"] });
		expect(parseMetricsParam("x".repeat(METRICS_PARAM_MAX))).toEqual({ ids: ["x".repeat(METRICS_PARAM_MAX)] });
		expect(parseMetricsParam("x".repeat(METRICS_PARAM_MAX + 1))).toEqual({ error: `metrics: at most ${METRICS_PARAM_MAX} characters` });
	});
});

describe("widget stats: the cache", () => {
	/** A computation the test resolves or fails by hand. */
	function gate() {
		const calls: { now: number; resolve: (v: Numbers | undefined) => void; reject: (e: Error) => void }[] = [];
		const compute = (now: number) => new Promise<Numbers | undefined>((resolve, reject) => calls.push({ now, resolve, reject }));
		return { calls, compute };
	}
	const tick = () => new Promise((r) => setTimeout(r, 0));

	test("fresh within the TTL; one computation at a time per key; recomputed after the TTL", async () => {
		let now = T0;
		const cache = new MetricsCache(() => now);
		const g = gate();
		const a = cache.get("k", METRIC_TTL_MS, g.compute, 5000);
		const b = cache.get("k", METRIC_TTL_MS, g.compute, 5000);
		await tick();
		expect(g.calls).toHaveLength(1);
		g.calls[0]?.resolve({ x: 1 });
		expect(await a).toEqual({ x: 1 });
		expect(await b).toEqual({ x: 1 });
		now += METRIC_TTL_MS - 1;
		expect(await cache.get("k", METRIC_TTL_MS, g.compute, 5000)).toEqual({ x: 1 });
		expect(g.calls).toHaveLength(1);
		// A shorter TTL asked on the same source (new:30d next to mau) refreshes it.
		now += 1;
		const c = cache.get("k", METRIC_SLOW_TTL_MS, g.compute, 5000);
		expect(await c).toEqual({ x: 1 });
		const d = cache.get("k", METRIC_TTL_MS, g.compute, 5000);
		await tick();
		expect(g.calls).toHaveLength(2);
		g.calls[1]?.resolve({ x: 2 });
		expect(await d).toEqual({ x: 2 });
		expect(cache.computations).toBe(2);
	});

	test("a failure keeps the last good numbers and waits a minute before trying again; no numbers yet: undefined", async () => {
		let now = T0;
		const lines: string[] = [];
		const cache = new MetricsCache(() => now, (l) => lines.push(l));
		const g = gate();
		const first = cache.get("k", METRIC_TTL_MS, g.compute, 5000);
		await tick();
		g.calls[0]?.reject(new Error("boom"));
		expect(await first).toBeUndefined();
		expect(lines.at(-1)).toContain("metric k failed (boom)");
		// Within the minute: no new try.
		now += 30_000;
		expect(await cache.get("k", METRIC_TTL_MS, g.compute, 5000)).toBeUndefined();
		expect(g.calls).toHaveLength(1);
		now += 30_000;
		const second = cache.get("k", METRIC_TTL_MS, g.compute, 5000);
		await tick();
		g.calls[1]?.resolve({ x: 7 });
		expect(await second).toEqual({ x: 7 });
		// Stale and failing: the last good numbers.
		now += METRIC_TTL_MS;
		const third = cache.get("k", METRIC_TTL_MS, g.compute, 5000);
		await tick();
		g.calls[2]?.reject(new Error("down"));
		expect(await third).toEqual({ x: 7 });
		now += 10_000;
		expect(await cache.get("k", METRIC_TTL_MS, g.compute, 5000)).toEqual({ x: 7 });
		expect(g.calls).toHaveLength(3);
	});

	test("a slow computation: the request stops waiting, the next one gets the numbers", async () => {
		const now = T0;
		const cache = new MetricsCache(() => now);
		const g = gate();
		expect(await cache.get("k", METRIC_TTL_MS, g.compute, 5)).toBeUndefined();
		g.calls[0]?.resolve({ x: 3 });
		await tick();
		expect(await cache.get("k", METRIC_TTL_MS, g.compute, 5)).toEqual({ x: 3 });
		expect(g.calls).toHaveLength(1);
	});

	test("bounded: at most `entries` sources (least recently asked go, never a running one); at most `concurrency` at once", async () => {
		const now = T0;
		const cache = new MetricsCache(() => now, () => {}, { entries: 3, concurrency: 2 });
		const g = gate();
		const pending = ["a", "b", "c"].map((k) => cache.get(k, METRIC_TTL_MS, g.compute, 5000));
		await tick();
		// Two run, the third waits for a slot.
		expect(g.calls).toHaveLength(2);
		// Every entry is computing: a fourth key gets nothing (and starts nothing).
		expect(await cache.get("d", METRIC_TTL_MS, g.compute, 5000)).toBeUndefined();
		expect(cache.size).toBe(3);
		g.calls[0]?.resolve({ a: 1 });
		await tick();
		expect(g.calls).toHaveLength(3);
		g.calls[1]?.resolve({ b: 1 });
		g.calls[2]?.resolve({ c: 1 });
		expect(await Promise.all(pending)).toEqual([{ a: 1 }, { b: 1 }, { c: 1 }]);
		// "a" was asked least recently: it goes for "d".
		const d = cache.get("d", METRIC_TTL_MS, g.compute, 5000);
		await tick();
		g.calls[3]?.resolve({ d: 1 });
		expect(await d).toEqual({ d: 1 });
		expect(cache.size).toBe(3);
		expect(await cache.get("b", METRIC_TTL_MS, g.compute, 5000)).toEqual({ b: 1 });
		expect(g.calls).toHaveLength(4);
	});

	test("answer(): ids in order, unknown and past-12 ids null, one computation per source, analytics off -> null values", async () => {
		const runs: string[] = [];
		const metrics = new MobileMetrics({
			clock: () => T0,
			run: () => async (name, filters) => {
				runs.push(`${name} ${filters.to - filters.from}`);
				if (name === "session-time") return { summary: { sessions: 4, avgMinutes: 2.5, playedMinutes: 90 }, previous: { sessions: 2, avgMinutes: null, playedMinutes: 0 } };
				throw new Error("not in this test");
			},
		});
		const ids = ["session:1h", "nope", "playtime:1h", "sessions:1h", "ccu", ...Array.from({ length: 10 }, (_, i) => `new:${i + 1}h`)];
		const out = await metrics.answer(ids, { ccu: 5, ccuPrev: null, servers: 1, peakToday: 9 });
		expect(Object.keys(out)).toEqual(ids);
		expect(out.nope).toBeNull();
		expect(out["session:1h"]).toEqual({ value: 150, prev: null, unit: "seconds", label: "Session 1h" });
		expect(out["playtime:1h"]).toEqual({ value: 1.5, prev: 0, unit: "hours", label: "Playtime 1h" });
		expect(out["sessions:1h"]).toEqual({ value: 4, prev: 2, unit: "count", label: "Sessions 1h" });
		expect(out.ccu).toEqual({ value: 5, prev: null, unit: "count", label: "CCU" });
		// The overview source fails here: a known metric without numbers keeps its unit and label.
		expect(out["new:1h"]).toEqual({ value: null, prev: null, unit: "count", label: "New 1h" });
		// Past METRICS_MAX: null, never computed.
		expect(ids.length).toBeGreaterThan(METRICS_MAX);
		for (const id of ids.slice(METRICS_MAX)) expect(out[id]).toBeNull();
		expect(runs.filter((r) => r.startsWith("session-time"))).toEqual([`session-time ${HOUR}`]);
		expect(runs.some((r) => r === `overview ${10 * HOUR}`)).toBe(false);

		const off = new MobileMetrics({ clock: () => T0, run: () => undefined });
		expect(await off.answer(["dau", "ccu"], { ccu: 2, ccuPrev: 1, servers: 1, peakToday: 2 })).toEqual({
			dau: { value: null, prev: null, unit: "count", label: "DAU" },
			ccu: { value: 2, prev: 1, unit: "count", label: "CCU" },
		});
	});
});

describe("game.iconUrl: the icon cache", () => {
	test("kept 6 h; a failure keeps the last good URL; none yet: null; retried after 10 minutes", async () => {
		let now = T0;
		let answer: string | null | Error = null;
		let lookups = 0;
		const icons = new IconCache(
			async () => {
				lookups++;
				if (answer instanceof Error) throw answer;
				return answer;
			},
			() => now,
		);
		expect(await icons.get(null)).toBeNull();
		expect(lookups).toBe(0);
		// Roblox has none: null, not asked again for 10 minutes.
		expect(await icons.get(42)).toBeNull();
		now += ICON_RETRY_MS - 1;
		expect(await icons.get(42)).toBeNull();
		expect(lookups).toBe(1);
		now += 1;
		answer = "https://tr.rbxcdn.com/icon-a/256/256/Image/Png";
		expect(await icons.get(42)).toBe("https://tr.rbxcdn.com/icon-a/256/256/Image/Png");
		now += ICON_TTL_MS - 1;
		expect(await icons.get(42)).toBe("https://tr.rbxcdn.com/icon-a/256/256/Image/Png");
		expect(lookups).toBe(2);
		// Stale and Roblox down: the last good URL.
		now += 1;
		answer = new Error("timeout");
		expect(await icons.get(42)).toBe("https://tr.rbxcdn.com/icon-a/256/256/Image/Png");
		expect(lookups).toBe(3);
		// Another universe: its own icon only.
		answer = null;
		expect(await icons.get(43)).toBeNull();
	});
});

/** Fake Roblox: the game's name, and its icon at 256x256 when `icon` is set (a 500 when `iconDown`). */
class FakeRoblox {
	icon: string | null = null;
	iconDown = false;
	iconAsks: string[] = [];
	fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url.startsWith("https://games.roblox.com/v1/games?universeIds=123456789")) return Response.json({ data: [{ id: 123456789, rootPlaceId: 1001, name: "The Prison", playing: 7 }] });
		if (url.startsWith("https://thumbnails.roblox.com/")) {
			if (url.includes("size=256x256")) {
				this.iconAsks.push(url);
				if (this.iconDown) return new Response("down", { status: 500 });
				return Response.json({ data: this.icon ? [{ targetId: 123456789, state: "Completed", imageUrl: this.icon }] : [] });
			}
			return Response.json({ data: [] });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

const hb = (j: string, n: number, now: number) => ({ j, t: "public", b: "prod", c: "prod", a: "art-41", n, m: 50, s: Math.floor((now - 3_600_000) / 1000), u: Math.floor(now / 1000), p: 1001, v: "0.3.2", q: 41, g: 3, h: "ok", sv: 2 });
const ICON = "https://tr.rbxcdn.com/180DAY-icon/256/256/Image/Png/noFilter";
const ALL = ["ccu", "servers", "peakToday", "dau", "wau", "mau", "new:24h", "new:7d", "d1", "d7", "session:1h", "playtime:1h"];
const MORE = ["sessions:1h", "revenue:72h", "payers:72h"];

describe("GET /v1/mobile/live?metrics= through the app", () => {
	let h: Harness;
	let fake: FakeRoblox;
	let ipN = 0;
	const ip = () => `10.88.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
	let token = "";
	const live = (query = "") => h.call(`/v1/mobile/live${query}`, { headers: bearer(token), ip: ip() });
	const N = T0;

	const base = { v: 1, job: "job-1", srv: "public", place: 1001, art: "a1b2c3d-000001", seq: 1, branch: "prod", channel: "prod", dev: "phone", newp: false, exp: "{}", sexp: "", src: "server" };
	let sid = 0;
	/** A session: join at `from`, leave `minutes` later (or a tick at `last` while running); purchases one minute in. */
	const session = (pid: string, from: number, minutes: number | null, o: { newp?: boolean; last?: number; buys?: number[] } = {}) => {
		const s = `${pid}-s${++sid}`;
		return [
			{ ...base, pid, sid: s, t: from, kind: "session", name: "join", newp: o.newp ?? false },
			...(o.buys ?? []).map((robux, i) => ({ ...base, pid, sid: s, t: from + MIN + i * 1000, kind: "purchase", name: "product", props: JSON.stringify({ product: 1, robux }) })),
			minutes !== null ? { ...base, pid, sid: s, t: from + minutes * MIN, kind: "session", name: "leave" } : { ...base, pid, sid: s, t: o.last as number, kind: "custom", name: "tick" },
		];
	};
	const ingest = async (events: object[]) => {
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		await h.app.load();
	};
	const beat = async (players: number) => {
		const r = await h.call("/v1/fleet/heartbeat", { method: "POST", body: JSON.stringify(hb("job-1", players, h.now())), headers: { "content-type": "application/json", ...bearer(API) } });
		expect(r.status).toBe(202);
	};

	beforeAll(async () => {
		fake = new FakeRoblox();
		h = await harness({ TYPETORCH_UNIVERSE_ID: "123456789" }, { fetch: fake.fetch });
		// N = 2026-10-09 12:00 UTC: today is 10-09, the latest complete D1 cohort joined 10-07, D7's 10-01.
		await ingest([
			// The last hours (as the live test): p1, p2 new; p3 still running; p6 ended in the hour before.
			...session("p1", N - 40 * MIN, 10, { newp: true, buys: [100] }),
			...session("p2", N - 50 * MIN, 20, { newp: true, buys: [50, 25] }),
			...session("p3", N - 30 * MIN, null, { last: N - MIN }),
			...session("p4", N - 180 * MIN, 10),
			...session("p5", N - 90 * MIN, 45),
			...session("p6", N - 100 * MIN, 30),
			// D7: a1, a2 joined 10-01, a1 back 10-08; b1 joined 09-30, back 10-07.
			...session("a1", N - 8 * DAY, 10, { newp: true }),
			...session("a1", N - DAY + 30 * MIN, 10),
			...session("a2", N - 8 * DAY + HOUR, 10, { newp: true }),
			...session("b1", N - 9 * DAY, 10, { newp: true }),
			...session("b1", N - 2 * DAY + 30 * MIN, 10),
			// D1: c1, c2, c3 joined 10-07, c1 back 10-08 (and bought); d1p, d2p joined 10-06, d1p back 10-07.
			...session("c1", N - 2 * DAY + 5 * MIN, 10, { newp: true, buys: [400] }),
			...session("c1", N - DAY + 30 * MIN, 10),
			...session("c2", N - 2 * DAY + HOUR, 10, { newp: true }),
			...session("c3", N - 2 * DAY + 2 * HOUR, 10, { newp: true }),
			...session("d1p", N - 3 * DAY - HOUR, 10, { newp: true }),
			...session("d1p", N - 2 * DAY + 30 * MIN, 10),
			...session("d2p", N - 3 * DAY - 2 * HOUR, 10, { newp: true, buys: [300] }),
			// The 30 days before the last 30.
			...session("old", N - 40 * DAY, 10),
		]);
		const mint = await h.call("/v1/auth/mobile/token", { method: "POST", body: JSON.stringify({ device: "Pixel 9" }), headers: { "content-type": "application/json", ...bearer(ADMIN) }, ip: ip() });
		token = (await asJson(mint)).token as string;
		// The milestone rule off (its push would read the last hour early).
		const s = await h.call("/v1/admin/settings", { method: "PATCH", body: JSON.stringify({ backendAlerts: { rules: { ccuMilestone: { on: false } } } }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		expect(s.status).toBe(200);
	});
	afterAll(() => h.close());

	test("game.iconUrl: null while Roblox fails, the 256x256 icon once it answers, kept 6 hours", async () => {
		h.setNow(N - 2 * HOUR);
		await beat(1);
		fake.iconDown = true;
		const down = await asJson(await live());
		expect(down.game).toEqual({ name: "The Prison", universeId: 123456789, iconUrl: null });
		// Without `metrics` the answer is today's (no `metrics` key).
		expect("metrics" in down).toBe(false);
		fake.iconDown = false;
		fake.icon = ICON;
		h.setNow(N - 2 * HOUR + 11 * MIN);
		await beat(1);
		expect((await asJson(await live())).game.iconUrl).toBe(ICON);
		const asks = fake.iconAsks.length;
		h.setNow(N - 30 * MIN);
		await beat(1);
		expect((await asJson(await live())).game.iconUrl).toBe(ICON);
		expect(fake.iconAsks.length).toBe(asks);
		expect(fake.iconAsks.every((u) => u.startsWith("https://thumbnails.roblox.com/v1/games/icons?universeIds=123456789&") && u.includes("format=Png"))).toBe(true);
	});

	test("every metric on seeded sessions: value and the window before", async () => {
		const alerts = h.app.backendAlerts;
		if (!alerts) throw new Error("no evaluator");
		// CCU 10 five minutes ago (the evaluator's sample), 14 now.
		h.setNow(N - 5 * MIN);
		await beat(10);
		await alerts.tick();
		h.setNow(N);
		await beat(14);
		const res = await live(`?minutes=5&metrics=${ALL.join(",")}`);
		expect(res.status).toBe(200);
		const body = await asJson(res);
		const more = await asJson(await live(`?metrics=${MORE.join(",")}`));
		if (process.env.TT_PRINT_LIVE) console.log(JSON.stringify({ ...body, series: body.series.slice(-2), metrics: { ...body.metrics, ...more.metrics } }, null, 2));
		expect(Object.keys(body.metrics)).toEqual(ALL);
		expect(body.metrics).toEqual({
			ccu: { value: 14, prev: 10, unit: "count", label: "CCU" },
			servers: { value: 1, prev: null, unit: "count", label: "Servers" },
			peakToday: { value: 14, prev: null, unit: "count", label: "Peak today" },
			// Last 24 h: p1-p6, a1 and c1 back; the 24 h before: b1, c1, c2, c3, d1p.
			dau: { value: 8, prev: 5, unit: "count", label: "DAU" },
			// Last 7 days: p1-p6, a1, b1, c1-c3, d1p, d2p; the 7 before: a1, a2, b1.
			wau: { value: 13, prev: 3, unit: "count", label: "WAU" },
			// Last 30 days: all but `old`; the 30 before: `old`.
			mau: { value: 14, prev: 1, unit: "count", label: "MAU" },
			"new:24h": { value: 2, prev: 3, unit: "count", label: "New 24h" },
			"new:7d": { value: 7, prev: 3, unit: "count", label: "New 7d" },
			// 10-07's cohort: c1 of 3 back on 10-08; 10-06's: d1p of 2.
			d1: { value: 0.3333, prev: 0.5, unit: "ratio", label: "D1" },
			// 10-01's cohort: a1 of 2 back on 10-08; 09-30's: b1 of 1.
			d7: { value: 0.5, prev: 1, unit: "ratio", label: "D7" },
			// Ended in the hour: p1 10, p2 20, p5 45 min (mean 25 min); the hour before: p6 30 min.
			"session:1h": { value: 1500, prev: 1800, unit: "seconds", label: "Session 1h" },
			// In the hour: p1 10 + p2 20 + p3 30 (running) + p5 15 = 75 min; before: p5 30 + p6 30 = 60 min.
			"playtime:1h": { value: 1.3, prev: 1, unit: "hours", label: "Playtime 1h" },
		});
		expect(more.metrics).toEqual({
			"sessions:1h": { value: 3, prev: 1, unit: "count", label: "Sessions 1h" },
			// p1 100 + p2 75 + c1 400; before: d2p 300.
			"revenue:72h": { value: 575, prev: 300, unit: "robux", label: "Revenue 72h" },
			"payers:72h": { value: 3, prev: 1, unit: "count", label: "Payers 72h" },
		});
		// The rest of the answer as before.
		expect(body).toMatchObject({ ccu: 14, servers: 1, delta: 4, peakToday: 14, game: { name: "The Prison", universeId: 123456789, iconUrl: ICON } });
		// Aggregates only.
		for (const pid of ["p1", "a1", "c1", "d1p", "old"]) expect(JSON.stringify({ body, more })).not.toContain(`"${pid}`);
	});

	test("cached: 5 minutes (mau and d7 15)", async () => {
		// A new player a minute later.
		await ingest(session("q1", N + MIN, 2, { newp: true }));
		const ask = async (at: number) => {
			h.setNow(at);
			await beat(14);
			return (await asJson(await live("?metrics=dau,mau,new:24h"))).metrics;
		};
		expect((await ask(N + 4 * MIN)).dau.value).toBe(8);
		const later = await ask(N + 6 * MIN);
		expect(later.dau.value).toBe(9);
		expect(later["new:24h"].value).toBe(3);
		// mau and new:24h read different sources; mau's (30 days) is kept 15 minutes.
		expect(later.mau.value).toBe(14);
		expect((await ask(N + 16 * MIN)).mau.value).toBe(15);
	});

	test("unknown, invalid and extra ids answer null; only an overlong or repeated parameter is a 400", async () => {
		h.setNow(N + 20 * MIN);
		await beat(14);
		const res = await live("?metrics=foo,new:0h,new:73h,revenue:91d,revenue:07d,DAU,__proto__,session:,ccu");
		expect(res.status).toBe(200);
		const metrics = (await asJson(res)).metrics;
		expect(Object.keys(metrics)).toEqual(["foo", "new:0h", "new:73h", "revenue:91d", "revenue:07d", "DAU", "__proto__", "session:", "ccu"]);
		for (const id of Object.keys(metrics).slice(0, -1)) expect(metrics[id]).toBeNull();
		expect(metrics.ccu.value).toBe(14);
		// More than 12: the first 12 answered, the rest null.
		const many = Array.from({ length: 14 }, (_, i) => `sessions:${i + 1}h`);
		const m = (await asJson(await live(`?metrics=${many.join(",")}`))).metrics;
		expect(Object.keys(m)).toEqual(many);
		expect(m["sessions:12h"]).not.toBeNull();
		expect(m["sessions:13h"]).toBeNull();
		expect(m["sessions:14h"]).toBeNull();
		// An empty list: an empty object.
		expect((await asJson(await live("?metrics="))).metrics).toEqual({});
		expect((await live(`?metrics=${"x".repeat(1001)}`)).status).toBe(400);
		expect((await live("?metrics=dau&metrics=d1")).status).toBe(400);
		expect((await live("?metrics=dau&other=1")).status).toBe(400);
	});
});

describe("widget stats: releases", () => {
	const day = (ago: number, hour = 12) => (Math.floor(T0 / DAY) - ago) * DAY + hour * HOUR;
	const rel = (seq: number, channel: string | null, at: number, artifact: string | null = `art-${seq}`): ReleaseDay => ({ seq, artifact, channel, at });
	/** The cell `ago` days before today (today the last). */
	const on = (r: { days: ReleaseCell[] }, ago: number) => r.days[RELEASE_DAYS - 1 - ago];

	test("level: 0, 1, 2 for 2-3, 3 for 4+", () => {
		expect([0, 1, 2, 3, 4, 5, 50].map(releaseLevel)).toEqual([0, 1, 2, 2, 3, 3, 3]);
	});

	test("cell tokens: every case", () => {
		const t = (p: number, d: number) => {
			const c = releaseCell("2026-10-09", p, d);
			return `${c.bg}/${c.tri}`;
		};
		// Neither.
		expect(t(0, 0)).toBe("r0/rnone");
		// Dev alone: blue background, no corner.
		expect([1, 2, 3, 4, 9].map((d) => t(0, d))).toEqual(["rb1/rnone", "rb2/rnone", "rb2/rnone", "rb3/rnone", "rb3/rnone"]);
		// Prod alone: green background, no corner.
		expect([1, 2, 3, 4, 9].map((p) => t(p, 0))).toEqual(["rg1/rnone", "rg2/rnone", "rg2/rnone", "rg3/rnone", "rg3/rnone"]);
		// Both: green background, the dev level in the corner.
		expect(t(1, 1)).toBe("rg1/rb1");
		expect(t(4, 2)).toBe("rg3/rb2");
		expect(t(2, 5)).toBe("rg2/rb3");
		expect(t(3, 3)).toBe("rg2/rb2");
		expect(releaseCell("2026-10-09", 2, 5)).toEqual({ date: "2026-10-09", p: 2, d: 5, bg: "rg2", tri: "rb3" });
	});

	test("182 UTC days (26 weeks) oldest first, today the last; counts over 182 and 30; older and later ones left out", () => {
		expect(RELEASE_DAYS).toBe(182);
		const r = releasesFrom(
			[
				rel(1, "prod", day(182)), // the day before the first: not counted
				rel(2, "prod", day(181, 0)), // the first day, 00:00
				rel(3, "dev", day(30, 23)), // just outside the last 30
				rel(4, "dev", day(29, 0)), // the last 30's first day
				rel(5, "staging", day(10)), // anything else is dev
				rel(6, null, day(10)), // no channel (known from reports): dev
				rel(7, "prod", day(10)),
				rel(8, "prod", day(0, 1)),
				rel(9, "dev", (Math.floor(T0 / DAY) + 1) * DAY), // tomorrow (a clock ahead): not counted
			],
			T0,
		);
		expect(r.days).toHaveLength(182);
		expect(r.days[0]?.date).toBe("2026-04-11");
		expect(r.days.at(-1)?.date).toBe("2026-10-09");
		// Consecutive days, oldest first.
		for (let i = 1; i < r.days.length; i++) expect(Date.parse(r.days[i]?.date as string) - Date.parse(r.days[i - 1]?.date as string)).toBe(DAY);
		expect(r.days[0]).toEqual({ date: "2026-04-11", p: 1, d: 0, bg: "rg1", tri: "rnone" });
		// No history start given: an empty day is r0.
		expect(r.days[1]).toEqual({ date: "2026-04-12", p: 0, d: 0, bg: "r0", tri: "rnone" });
		expect(on(r, 30)).toMatchObject({ date: "2026-09-09", p: 0, d: 1, bg: "rb1" });
		expect(on(r, 29)).toMatchObject({ date: "2026-09-10", p: 0, d: 1, bg: "rb1" });
		expect(on(r, 10)).toEqual({ date: "2026-09-29", p: 1, d: 2, bg: "rg1", tri: "rb2" });
		expect(on(r, 0)).toEqual({ date: "2026-10-09", p: 1, d: 0, bg: "rg1", tri: "rnone" });
		expect({ value: r.value, prod: r.prod, dev: r.dev, prod30: r.prod30, dev30: r.dev30 }).toEqual({ value: 3, prod: 3, dev: 4, prod30: 2, dev30: 3 });
		expect(r.lastProd).toBe("today");
		expect(r.lastProdLabel).toBe("#8 · art-8");
	});

	test("no data: days before the history's first release are rnone; its own day and later are normal; no history: all rnone", () => {
		// The history began 20 days ago at 15:00 (a dev release); a prod release 3 days ago.
		const r = releasesFrom([rel(1, "dev", day(20, 15)), rel(2, "prod", day(3))], T0, day(20, 15));
		expect(r.days).toHaveLength(182);
		for (let ago = 181; ago > 20; ago--) expect(on(r, ago)).toMatchObject({ p: 0, d: 0, bg: "rnone", tri: "rnone" });
		expect(on(r, 21)).toEqual({ date: "2026-09-18", p: 0, d: 0, bg: "rnone", tri: "rnone" });
		// The first release's own day, then empty days r0 again.
		expect(on(r, 20)).toEqual({ date: "2026-09-19", p: 0, d: 1, bg: "rb1", tri: "rnone" });
		expect(on(r, 19)).toEqual({ date: "2026-09-20", p: 0, d: 0, bg: "r0", tri: "rnone" });
		expect(on(r, 3)).toMatchObject({ p: 1, bg: "rg1" });
		expect(on(r, 0)).toMatchObject({ bg: "r0" });
		expect(r.days.filter((c) => c.bg === "rnone")).toHaveLength(161);
		expect(r).toMatchObject({ prod: 1, dev: 1, lastProd: "3 d ago" });

		// A history that began before the 182 days: no rnone cell.
		const old = releasesFrom([rel(2, "prod", day(3))], T0, day(400));
		expect(old.days.some((c) => c.bg === "rnone")).toBe(false);
		// It began today: only today is a normal cell.
		const fresh = releasesFrom([rel(1, "prod", day(0, 0))], T0, day(0, 0));
		expect(fresh.days.filter((c) => c.bg !== "rnone").map((c) => c.date)).toEqual(["2026-10-09"]);
		expect(on(fresh, 0)).toMatchObject({ bg: "rg1" });

		// No history at all: every one of the 182 days rnone, nothing counted.
		const none = releasesFrom([], T0, null);
		expect(none.days).toHaveLength(182);
		expect(none.days.every((c) => c.bg === "rnone" && c.tri === "rnone" && c.p === 0 && c.d === 0)).toBe(true);
		expect(none).toMatchObject({ value: 0, prod: 0, dev: 0, prod30: 0, dev30: 0, lastProd: null, lastProdLabel: null });
	});

	test("lastProd: today, 1 d ago, n d ago, none; the label without an artifact; the newest prod wins", () => {
		const at = (rows: ReleaseDay[]) => releasesFrom(rows, T0);
		expect(at([rel(3, "prod", day(0, 0))]).lastProd).toBe("today");
		expect(at([rel(3, "prod", day(1, 23)), rel(4, "dev", day(0))]).lastProd).toBe("1 d ago");
		const twelve = at([rel(3, "prod", day(12)), rel(2, "prod", day(20)), rel(9, "dev", day(1))]);
		expect(twelve.lastProd).toBe("12 d ago");
		expect(twelve.lastProdLabel).toBe("#3 · art-3");
		expect(at([rel(5, "prod", day(181, 0), null)])).toMatchObject({ lastProd: "181 d ago", lastProdLabel: "#5" });
		// Same start: the higher seq.
		expect(at([rel(7, "prod", day(2)), rel(6, "prod", day(2))]).lastProdLabel).toBe("#7 · art-7");
		// None in the 182 days (dev only, or prod older).
		const none = at([rel(1, "prod", day(182)), rel(2, "dev", day(3))]);
		expect(none).toMatchObject({ value: 0, prod: 0, dev: 1, lastProd: null, lastProdLabel: null });
		const empty = at([]);
		expect(empty.days).toHaveLength(RELEASE_DAYS);
		expect(empty.days.every((c) => c.bg === "r0" && c.tri === "rnone" && c.p === 0 && c.d === 0)).toBe(true);
	});

	test("answer(): reads the whole history from 0, cached 5 minutes, one read at a time, a failure keeps the last good value; no fleet: null numbers; counts toward 12", async () => {
		let now = T0;
		let rows: ReleaseDay[] = [rel(1, "prod", day(1))];
		let fail = false;
		const reads: [number, number][] = [];
		const metrics = new MobileMetrics({
			clock: () => now,
			run: () => undefined,
			releases: () => async (from, to) => {
				reads.push([from, to]);
				if (fail) throw new Error("db closed");
				return rows;
			},
		});
		const ask = async () => (await metrics.answer(["releases"], {})).releases;
		const [a, b] = await Promise.all([ask(), ask()]);
		expect(a).toMatchObject({ value: 1, prev: null, unit: "count", label: "Releases", lastProd: "1 d ago" });
		expect(b).toEqual(a);
		// From 0 to the end of today: the history's first release is its earliest row.
		expect(reads).toEqual([[0, Date.UTC(2026, 9, 10)]]);
		expect(a?.days?.at(-3)?.bg).toBe("rnone");
		expect(a?.days?.at(-2)?.bg).toBe("rg1");
		expect(a?.days?.at(-1)?.bg).toBe("r0");
		// An older first release (before the 182 days): no rnone.
		rows = [rel(9, "dev", day(300)), rel(1, "prod", day(1)), rel(2, "prod", day(0))];
		now += METRIC_TTL_MS - 1;
		expect((await ask())?.value).toBe(1);
		now += 1;
		const c = await ask();
		expect(c).toMatchObject({ value: 2, dev: 0, lastProd: "today", lastProdLabel: "#2 · art-2" });
		expect(c?.days?.some((cell) => cell.bg === "rnone")).toBe(false);
		fail = true;
		now += METRIC_TTL_MS;
		expect(await ask()).toMatchObject({ value: 2, lastProd: "today" });
		expect(reads).toHaveLength(3);
		// The key order of the answer.
		expect(Object.keys((await ask()) as object)).toEqual(["value", "prev", "unit", "label", "prod", "dev", "prod30", "dev30", "lastProd", "lastProdLabel", "days"]);
		// No history at all: every day rnone.
		const empty = new MobileMetrics({ clock: () => T0, run: () => undefined, releases: () => async () => [] });
		const e = (await empty.answer(["releases"], {})).releases;
		expect(e?.days).toHaveLength(182);
		expect(e?.days?.every((cell) => cell.bg === "rnone" && cell.tri === "rnone")).toBe(true);

		// Past the 12th id: null, never read.
		const many = [...Array.from({ length: 12 }, (_, i) => `ccu${i}`), "releases"];
		expect((await metrics.answer(many, {})).releases).toBeNull();
		expect(reads).toHaveLength(3);

		const off = new MobileMetrics({ clock: () => T0, run: () => undefined, releases: () => undefined });
		expect(await off.answer(["releases"], {})).toEqual({ releases: { value: null, prev: null, unit: "count", label: "Releases" } });
		expect(parseMetricId("releases")).toEqual({ id: "releases", unit: "count", label: "Releases", source: "releases", field: "value", ttlMs: METRIC_TTL_MS });
		for (const bad of ["releases:7d", "Releases", "release"]) expect(parseMetricId(bad)).toBeNull();
	});
});

describe("GET /v1/mobile/live?metrics=releases through the app", () => {
	let h: Harness;
	let token = "";
	const N = T0;
	const day = (ago: number, hour = 12) => (Math.floor(N / DAY) - ago) * DAY + hour * HOUR;
	const on = (r: { days: ReleaseCell[] }, ago: number) => r.days[RELEASE_DAYS - 1 - ago];
	/** The CLI's POST /v1/fleet/deploy at `at` (the backend's clock there too), processed before the next. */
	const deploy = async (seq: number, ch: string | null, at: number, o: { t?: number } = {}) => {
		h.setNow(at);
		const body = { j: "cli", s: seq, b: ch === "prod" ? "prod" : "dev", a: `a1b2c3d-${String(seq).padStart(6, "0")}`, ...(ch ? { ch } : {}), k: "deploy", t: o.t ?? at };
		expect((await h.call("/v1/fleet/deploy", post(API, body))).status).toBe(202);
		await h.app.bus.idle(2000);
	};

	beforeAll(async () => {
		h = await harness();
		// The history's first release, 61 days ago; one 60 days ago.
		await deploy(1, "prod", day(61));
		await deploy(2, "prod", day(60, 23));
		// 59 days ago: one dev.
		await deploy(3, "dev", day(59, 0) + MIN);
		// 40 days ago: one prod (not in the last 30).
		await deploy(4, "prod", day(40));
		// 10 days ago: two prod and a dev without a channel (the dashboard shows "–": dev).
		await deploy(5, "prod", day(10, 9));
		await deploy(6, "prod", day(10, 10));
		await deploy(7, null, day(10, 11));
		// 5 days ago: five dev.
		for (let i = 0; i < 5; i++) await deploy(8 + i, "dev", day(5, 8) + i * MIN);
		// Posted at 00:10 on day 4 with the CLI's time 23:55 on day 5... counted on its start's day (day 5).
		await deploy(13, "dev", day(4, 0) + 10 * MIN, { t: day(5, 23) + 55 * MIN });
		// A release known only from a server's report (no CLI post, no channel): dev, 2 days ago.
		h.setNow(day(2));
		expect((await h.call("/v1/fleet/report", post(API, { s: 14, j: "job-1", r: "swapped", b: "prod", a: "a1b2c3d-000014" }))).status).toBe(202);
		await h.app.bus.idle(2000);
		// Today: one prod.
		await deploy(15, "prod", day(0, 9));
		h.setNow(N);
		const mint = await h.call("/v1/auth/mobile/token", { method: "POST", body: JSON.stringify({ device: "Pixel 9" }), headers: { "content-type": "application/json", ...bearer(ADMIN) }, ip: "10.89.0.1" });
		token = (await asJson(mint)).token as string;
	});
	afterAll(() => h.close());

	const live = async (query: string) => {
		const res = await h.call(`/v1/mobile/live${query}`, { headers: bearer(token), ip: "10.89.0.2" });
		expect(res.status).toBe(200);
		return asJson(res);
	};

	test("counted per UTC day from the Deploys page's rows: prod vs the rest, 182 days, today the last, rnone before the history", async () => {
		const body = await live("?metrics=releases,ccu");
		expect(Object.keys(body.metrics)).toEqual(["releases", "ccu"]);
		const r = body.metrics.releases;
		if (process.env.TT_PRINT_LIVE) console.log(JSON.stringify({ ...r, days: [...r.days.slice(118, 123), "...", ...r.days.slice(-12)] }, null, 2));
		expect(r).toMatchObject({ value: 6, prev: null, unit: "count", label: "Releases", prod: 6, dev: 9, prod30: 3, dev30: 8, lastProd: "today", lastProdLabel: "#15 · a1b2c3d-000015" });
		// The top-level copy (the widgets draw from it) is the same.
		expect(body.releases).toEqual(r);
		expect(r.days).toHaveLength(182);
		expect(r.days[0]).toEqual({ date: "2026-04-11", p: 0, d: 0, bg: "rnone", tri: "rnone" });
		// Before the history's first release (61 days ago): no data.
		expect(r.days.filter((c: ReleaseCell) => c.bg === "rnone")).toHaveLength(181 - 61);
		expect(on(r, 62)).toEqual({ date: "2026-08-08", p: 0, d: 0, bg: "rnone", tri: "rnone" });
		expect(on(r, 61)).toEqual({ date: "2026-08-09", p: 1, d: 0, bg: "rg1", tri: "rnone" });
		expect(on(r, 60)).toEqual({ date: "2026-08-10", p: 1, d: 0, bg: "rg1", tri: "rnone" });
		expect(on(r, 59)).toEqual({ date: "2026-08-11", p: 0, d: 1, bg: "rb1", tri: "rnone" });
		expect(on(r, 58)).toEqual({ date: "2026-08-12", p: 0, d: 0, bg: "r0", tri: "rnone" });
		expect(on(r, 40)).toEqual({ date: "2026-08-30", p: 1, d: 0, bg: "rg1", tri: "rnone" });
		expect(on(r, 10)).toEqual({ date: "2026-09-29", p: 2, d: 1, bg: "rg2", tri: "rb1" });
		expect(on(r, 5)).toEqual({ date: "2026-10-04", p: 0, d: 6, bg: "rb3", tri: "rnone" });
		expect(on(r, 4)).toMatchObject({ p: 0, d: 0, bg: "r0" });
		expect(on(r, 2)).toEqual({ date: "2026-10-07", p: 0, d: 1, bg: "rb1", tri: "rnone" });
		expect(on(r, 0)).toEqual({ date: "2026-10-09", p: 1, d: 0, bg: "rg1", tri: "rnone" });
		expect(r.days.reduce((n: number, c: { p: number; d: number }) => n + c.p + c.d, 0)).toBe(15);

		// The same rows the Deploys page lists: all 15, the channel as it shows it.
		const page = await asJson(await h.call("/v1/fleet/deploys?limit=100", { headers: bearer(ADMIN) }));
		expect(page.deploys).toHaveLength(15);
		expect(page.deploys.filter((d: { channel: string | null }) => d.channel === "prod").map((d: { seq: number }) => d.seq)).toEqual([15, 6, 5, 4, 2, 1]);
	});

	test("cached 5 minutes; a new day moves the grid", async () => {
		await deploy(16, "prod", N + MIN);
		h.setNow(N + 4 * MIN);
		expect((await live("?metrics=releases")).metrics.releases.prod).toBe(6);
		h.setNow(N + 6 * MIN);
		const r = (await live("?metrics=releases")).metrics.releases;
		expect(r).toMatchObject({ prod: 7, prod30: 4, lastProd: "today", lastProdLabel: "#16 · a1b2c3d-000016" });
		expect(r.days.at(-1)).toMatchObject({ p: 2, bg: "rg2" });
		// Tomorrow: today's releases are 1 d ago, the grid starts a day later.
		h.setNow(N + DAY);
		const next = (await live("?metrics=releases")).metrics.releases;
		expect(next.days).toHaveLength(182);
		expect(next.days[0].date).toBe("2026-04-12");
		expect(next.days.at(-1)).toEqual({ date: "2026-10-10", p: 0, d: 0, bg: "r0", tri: "rnone" });
		expect(next).toMatchObject({ prod: 7, dev: 9, lastProd: "1 d ago" });
		expect(next.days.filter((c: ReleaseCell) => c.bg === "rnone")).toHaveLength(181 - 62);
	});

	test("a release older than the 182 days: not counted, but the history starts before the grid (no rnone left)", async () => {
		await deploy(100, "prod", day(200));
		h.setNow(N + DAY + 10 * MIN);
		const r = (await live("?metrics=releases")).metrics.releases;
		expect(r).toMatchObject({ prod: 7, dev: 9, lastProd: "1 d ago", lastProdLabel: "#16 · a1b2c3d-000016" });
		expect(r.days.some((c: ReleaseCell) => c.bg === "rnone")).toBe(false);
		expect(r.days[0]).toEqual({ date: "2026-04-12", p: 0, d: 0, bg: "r0", tri: "rnone" });
	});
});
