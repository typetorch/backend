/**
 * Server metrics (src/server/metrics.ts) and GET /v1/admin/stats: the histogram's percentiles, the route groups, the
 * rings, the SQLite meter, and the route's roles. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Histogram, meterSqlite, parseStatsWindow, routeGroup, ServerMetrics, type StatsView } from "../src/server/metrics.ts";
import { openSqlite } from "../src/fleet/db.ts";
import { ADMIN, API, T0, bearer, harness, post, type Harness } from "./harness.ts";

describe("Histogram", () => {
	test("percentiles come from the bins, never above the max, and are null without samples", () => {
		const h = new Histogram();
		expect(h.percentile(0.5)).toBeNull();
		expect(h.summary()).toEqual({ count: 0, p50: null, p90: null, p99: null, max: null, avg: null });
		for (let i = 1; i <= 100; i++) h.add(i);
		const s = h.summary();
		expect(s.count).toBe(100);
		expect(s.max).toBe(100);
		expect(s.avg).toBe(50.5);
		// Bins grow by 25%: a percentile is the upper edge of its bin, so within 25% above the true value.
		expect(s.p50 as number).toBeGreaterThanOrEqual(50);
		expect(s.p50 as number).toBeLessThanOrEqual(63);
		expect(s.p99 as number).toBeGreaterThanOrEqual(99);
		expect(s.p99 as number).toBeLessThanOrEqual(100);
		expect(h.percentile(1)).toBe(100);
	});

	test("merge adds counts and keeps the max; tiny and huge values land in the end bins", () => {
		const a = new Histogram();
		const b = new Histogram();
		a.add(0.01);
		b.add(100_000);
		a.merge(b);
		expect(a.count).toBe(2);
		expect(a.max).toBe(100_000);
		expect(a.percentile(0.5)).toBe(0.05);
		expect(a.percentile(1)).toBe(100_000);
	});
});

describe("routeGroup", () => {
	test("sorts the routes into their groups", () => {
		const cases: [string, string, string][] = [
			["GET", "/healthz", "health"],
			["POST", "/v1/ingest", "ingest"],
			["POST", "/v1/identity", "ingest"],
			["POST", "/v1/errors", "errors-in"],
			["GET", "/v1/errors", "errors"],
			["GET", "/v1/errors/abc/players", "errors"],
			["GET", "/v1/players/p1/errors", "errors"],
			["GET", "/v1/experiments/k/players", "errors"],
			["POST", "/v1/fleet/heartbeat", "fleet-in"],
			["POST", "/v1/fleet/results", "fleet-in"],
			["GET", "/v1/fleet/commands", "long-poll"],
			["GET", "/v1/fleet/stream", "stream"],
			["GET", "/v1/live", "stream"],
			["GET", "/v1/fleet/servers", "fleet"],
			["POST", "/v1/fleet/servers/j/watch", "fleet"],
			["POST", "/v1/query/overview", "query"],
			["GET", "/v1/queries", "query"],
			["POST", "/v1/sql", "sql"],
			["GET", "/v1/rollups/daily", "rollups"],
			["GET", "/v1/place", "roblox"],
			["GET", "/v1/roblox/products", "roblox"],
			["GET", "/v1/identity/p1/profile", "roblox"],
			["POST", "/v1/auth/login", "auth"],
			["GET", "/auth/typetorch/start", "auth"],
			["GET", "/v1/admin/settings", "admin"],
			["GET", "/v1/admin/stats", "admin"],
			["GET", "/v1/storage", "admin"],
			["PUT", "/v1/access", "admin"],
			["GET", "/v1/nope", "other"],
			["GET", "/", "explorer"],
			["GET", "/assets/app.js", "explorer"],
		];
		for (const [method, path, group] of cases) expect(`${method} ${path} ${routeGroup(method, path)}`).toBe(`${method} ${path} ${group}`);
	});
});

describe("ServerMetrics", () => {
	const fixed = () => ({ rss: 200 * 1048576, heapUsed: 50 * 1048576, heapTotal: 80 * 1048576, external: 10 * 1048576, arrayBuffers: 2 * 1048576 } as NodeJS.MemoryUsage);
	function metrics(startAt = T0) {
		let now = startAt;
		let real = 0;
		let cpu = 0;
		const m = new ServerMetrics({
			clock: () => now,
			memory: fixed,
			// 300 ms of CPU per second of wall time -> 30%.
			cpu: (previous) => (previous ? { user: 200_000, system: 100_000 } : { user: cpu, system: 0 }),
			realNow: () => real,
		});
		return { m, setNow: (ms: number) => (now = ms), tick: (ms: number) => (real += ms), setCpu: (us: number) => (cpu = us) };
	}

	test("counts requests into both rings; rates average the last 10 whole seconds; streams stay out of the latency", () => {
		const { m, setNow } = metrics();
		// 20 requests spread over the 10 seconds before T0 + 10 s: 2 a second, one of them a 500.
		for (let s = 0; s < 10; s++) {
			setNow(T0 + s * 1000 + 100);
			m.request("POST", "/v1/ingest", 202, 4);
			m.request("GET", "/v1/fleet/servers", s === 0 ? 500 : 200, 12);
		}
		setNow(T0 + 10_000 + 500);
		m.request("GET", "/v1/live", 200, 60_000); // a stream open for a minute
		const v = m.view("5m");
		expect(v.rates.requests).toBe(2);
		expect(v.rates.errors).toBe(0.1);
		expect(v.totals.requests).toBe(21);
		expect(v.totals.errors).toBe(1);
		expect(v.latency.recent.count).toBe(20);
		expect(v.latency.recent.max).toBe(12);
		// The window (this minute) has every request, but the stream's minute is out of the latency.
		expect(v.latency.window.count).toBe(20);
		expect(v.latency.window.max).toBeLessThan(100);
		expect(v.seconds.length).toBe(10);
		expect(v.seconds[0].requests).toBe(2);
		expect(v.seconds[0].status).toEqual({ "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 1 });
		expect(v.minutes.length).toBe(1);
		expect(v.minutes[0].requests).toBe(21);
		const groups = Object.fromEntries(v.routes.map((r) => [r.group, r]));
		expect(groups.ingest.requests).toBe(10);
		expect(groups.ingest.latency.p50).toBeGreaterThanOrEqual(4);
		expect(groups.fleet.errors).toBe(1);
		expect(groups.stream.requests).toBe(1);
		expect(groups.stream.latency.count).toBe(0);
		expect(v.routes[0].group).toBe("ingest");
	});

	test("queries, rows in, rows loaded and SQLite statements are counted and rated", () => {
		const { m, setNow } = metrics();
		for (let s = 0; s < 10; s++) {
			setNow(T0 + s * 1000);
			m.duckQuery(5);
			m.duckQuery(50);
			m.rowsIn(30, 1000);
			m.rowsLoaded(300);
			m.sqlite("read", 3);
			m.sqlite("write");
		}
		setNow(T0 + 10_000);
		const v = m.view("1m");
		expect(v.rates).toEqual({ seconds: 10, requests: 0, errors: 0, duckQueries: 2, rowsIn: 30, rowsLoaded: 300, sqliteReads: 3, sqliteWrites: 1 });
		expect(v.totals).toMatchObject({ duckQueries: 20, rowsIn: 300, bytesIn: 10_000, rowsLoaded: 3000, sqliteReads: 30, sqliteWrites: 10, since: T0 });
		expect(v.duckdb.recent.count).toBe(20);
		expect(v.duckdb.recent.p50).toBeGreaterThanOrEqual(5);
		expect(v.duckdb.recent.max).toBe(50);
		expect(v.seconds[0].duckdb).toEqual({ queries: 2, latency: v.seconds[0].duckdb.latency, rowsLoaded: 300 });
		expect(v.seconds[0].sqlite).toEqual({ reads: 3, writes: 1 });
		expect(v.seconds[0].ingest).toEqual({ rows: 30, bytes: 1000 });
		expect(v.uptimeSeconds).toBe(10);
	});

	test("the sampler reads memory, the CPU share since the last sample and the event loop lag", () => {
		const { m, tick, setNow } = metrics();
		const first = m.sample();
		expect(first).toEqual({ rssMb: 200, heapMb: 50, heapTotalMb: 80, externalMb: 12, cpuPercent: 0, loopLagMs: 0 });
		tick(1000);
		setNow(T0 + 1000);
		expect(m.sample()).toMatchObject({ cpuPercent: 30, loopLagMs: 0 });
		// The next tick comes 250 ms late.
		tick(1250);
		setNow(T0 + 2250);
		const late = m.sample();
		expect(late.loopLagMs).toBe(250);
		expect(late.cpuPercent).toBe(24);
		setNow(T0 + 3000);
		const v = m.view();
		expect(v.sample).toEqual(late);
		expect(v.seconds.at(-1)?.memory).toEqual({ rssMb: 200, heapMb: 50, heapTotalMb: 80, externalMb: 12 });
		expect(v.seconds.at(-1)?.loopLagMs).toBe(250);
		expect(v.minutes[0].loopLagMs).toBe(250);
		expect(v.minutes[0].cpuPercent).toBe(24);
	});

	test("the rings keep 2 minutes of seconds and an hour of minutes; the window picks the minutes it covers", () => {
		const { m, setNow } = metrics();
		for (let min = 0; min < 90; min++) {
			setNow(T0 + min * 60_000);
			m.request("GET", "/healthz", 200, 1);
		}
		setNow(T0 + 89 * 60_000 + 30_000);
		const v = m.view("1h");
		expect(v.minutes.length).toBe(60);
		expect(v.minutes[0].at).toBe(T0 + 30 * 60_000);
		// The seconds ring holds the last 2 minutes: the requests of minutes 88 and 89.
		expect(v.seconds.length).toBe(2);
		expect(v.routes[0].requests).toBe(60);
		expect(m.view("5m").routes[0].requests).toBe(5);
		expect(m.view("15m").routes[0].requests).toBe(15);
		expect(m.view("1m").routes[0].requests).toBe(1);
	});

	test("parseStatsWindow", () => {
		expect(parseStatsWindow(null)).toBe("5m");
		expect(parseStatsWindow("")).toBe("5m");
		expect(parseStatsWindow("1h")).toBe("1h");
		expect(parseStatsWindow("2h")).toBeUndefined();
	});

	test("meterSqlite counts reads and writes, inside transactions too", async () => {
		const { m, setNow } = metrics();
		const db = meterSqlite(await openSqlite(":memory:"), m);
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
		await db.run("INSERT INTO t (v) VALUES (?)", ["a"]);
		expect(await db.all("SELECT v FROM t")).toEqual([{ v: "a" }]);
		expect(await db.first<{ v: string }>("SELECT v FROM t")).toEqual({ v: "a" });
		await db.transaction((tx) => {
			tx.run("INSERT INTO t (v) VALUES (?)", ["b"]);
			tx.all("SELECT 1");
			tx.first("SELECT 1");
		});
		await db.close();
		setNow(T0 + 1000);
		expect(m.view().totals).toMatchObject({ sqliteReads: 4, sqliteWrites: 3 });
	});
});

describe("GET /v1/admin/stats", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: "4242" });
	});
	afterAll(() => h.close());

	test("admin only: 401 without credentials, 403 for the web role, 400 on a bad window, 405 on POST", async () => {
		expect((await h.call("/v1/admin/stats")).status).toBe(401);
		expect((await h.call("/v1/admin/stats", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/admin/stats?window=2h", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/admin/stats", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		const viewer = h.app.sessions.create({ kind: "roblox", userId: 4242, name: "viewer" }, "web");
		expect((await h.call("/v1/admin/stats", { headers: { cookie: `tt_session=${viewer}` } })).status).toBe(403);
	});

	test("counts what the server did: requests by group and status, queries, rows in and loaded, SQLite, the sample", async () => {
		const row = { v: 1, t: T0, kind: "custom", name: "n1", job: "job-stats", art: "art-1", pid: "p1", sid: "s1" };
		expect((await h.call("/v1/ingest", post(API, { events: [row] }))).status).toBe(202);
		h.setNow(T0 + 1000);
		await h.app.load();
		expect((await h.call("/v1/query/overview", post(ADMIN, {}))).status).toBe(200);
		expect((await h.call("/v1/fleet/servers", { headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/v1/nope")).status).toBe(401);
		h.setNow(T0 + 2000);
		const res = await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) });
		expect(res.status).toBe(200);
		const v = (await res.json()) as StatsView & { state: string; version: string; runtime: string };
		expect(v.state).toBe("ready");
		expect(v.window).toBe("1m");
		expect(v.totals.requests).toBeGreaterThanOrEqual(4);
		expect(v.totals.rowsIn).toBe(1);
		expect(v.totals.bytesIn).toBeGreaterThan(0);
		expect(v.totals.rowsLoaded).toBe(1);
		expect(v.totals.duckQueries).toBeGreaterThan(0);
		expect(v.totals.sqliteReads).toBeGreaterThan(0);
		expect(v.sample?.rssMb).toBeGreaterThan(0);
		expect(v.seconds.length).toBeGreaterThan(0);
		const groups = Object.fromEntries(v.routes.map((r) => [r.group, r]));
		expect(groups.ingest.requests).toBe(1);
		expect(groups.ingest.latency.count).toBe(1);
		expect(groups.query.requests).toBe(1);
		expect(groups.fleet.requests).toBe(1);
		expect(groups.other.requests).toBe(1);
		expect(v.latency.window.count).toBeGreaterThanOrEqual(4);
		const minute = v.minutes.find((b) => b.requests > 0);
		expect(minute?.status["4xx"]).toBeGreaterThanOrEqual(1);
	});
});
