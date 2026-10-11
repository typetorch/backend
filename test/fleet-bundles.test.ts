/**
 * Kernel 0.5.3 debug bundles and the offline history of gone servers: POST /v1/fleet/bundle (validation, idempotent ids,
 * the 512 KB cap, the ingest key, the new-JobId gate, its limiter), the reads (owners get everything, the read-only web
 * role gets no playerLogs), retention, alert details (`d`), the 5-minute metrics rollups, and GET /v1/fleet/servers/<job>
 * for a server that closed, was lost or is gone. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSqlite } from "../src/fleet/db.ts";
import { FLEET_LIMITS, handleFleet, NewJobLimiter } from "../src/fleet/http.ts";
import {
	ALERT_DETAILS_MAX_KEYS,
	BUNDLES_PER_JOB,
	FleetService,
	GONE_SERVERS_MAX,
	KEEP_BUNDLES_MS,
	KEEP_GONE_SERVERS_MS,
	KEEP_METRICS_MS,
	KEEP_ROLLUPS_MS,
	ROLLUP_MS,
	parseAlert,
	parseAlertDetails,
	parseBundle,
} from "../src/fleet/service.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const VIEWER = 5005;
const JOB = "bundle-job-0000-1111-2222-333333333333";
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** A bundle as the kernel sends it (contract: kernel 0.5.3 <-> backend). */
const bundle = (over: Record<string, unknown> = {}) => ({
	v: 1,
	id: hex(1),
	j: JOB,
	t: Math.floor(T0 / 1000),
	k: "0.5.3",
	b: "prod",
	a: "art-9",
	s: 12,
	g: 3,
	code: "deploy_failed",
	level: "critical",
	message: "generation 3 failed to start",
	closing: false,
	failure: { stage: "start", error: "Round.luau:42: attempt to index nil", report: { r: "failed" } },
	server: { jobId: JOB, placeVersion: 77, uptime: 120 },
	deploy: {
		appliedSeq: 12,
		history: [
			{ name: "g1", artifactId: "art-8", branch: "prod", at: new Date(T0 - 600_000).toISOString(), reason: "boot", loadSeconds: 1.5, swapSeconds: 0.2 },
			{ name: "g2", artifactId: "art-9", branch: "prod", at: new Date(T0 - 60_000).toISOString(), reason: "deploy", loadSeconds: 2.5, swapSeconds: 0.4 },
		],
		reports: [{ s: 12, r: "failed", e: "boom" }],
		failing: true,
		refusals: [],
	},
	fallback: { active: false },
	alerts: [{ code: "deploy_failed", level: "critical", message: "m", t: Math.floor(T0 / 1000) }],
	players: [
		{ u: 101, n: "PlayerOne", joinedAt: Math.floor(T0 / 1000) - 100 },
		{ u: 102, n: "PlayerTwo", joinedAt: Math.floor(T0 / 1000) - 50, leftAt: Math.floor(T0 / 1000) - 5 },
	],
	serverLog: [{ i: 1, t: Math.floor(T0 / 1000), kind: "error", text: "<b>not html</b>" }],
	playerLogs: { "101": [{ t: Math.floor(T0 / 1000), kind: "warning", text: "client line" }] },
	...over,
});

describe("debug bundles over HTTP", () => {
	let h: Harness;
	let web: Record<string, string>;
	const admin = bearer(ADMIN);
	/** One post, 10 s after the previous one (the bundle limiter's refill: invalid posts count too, like the other routes). */
	const send = (body: unknown, headers: Record<string, string> = bearer(API), tick = true) => (tick && h.setNow(h.now() + 10_000), h.call("/v1/fleet/bundle", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));

	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}` };
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: JOB, b: "prod", a: "art-9", n: 2 }))).status).toBe(202);
	});
	afterAll(() => h.close());

	test("the ingest key only; shapes are checked; sections are opaque", async () => {
		expect((await send(bundle(), {})).status).toBe(401);
		expect((await send(bundle(), admin)).status).toBe(401);
		expect((await send(bundle({ v: 2 }))).status).toBe(400);
		expect((await send(bundle({ id: "ABC" }))).status).toBe(400);
		expect((await send(bundle({ id: hex(0xabc).toUpperCase() }))).status).toBe(400);
		expect((await send(bundle({ j: undefined }))).status).toBe(400);
		expect((await send(bundle({ code: "Deploy Failed" }))).status).toBe(400);
		expect((await send(bundle({ level: "panic" }))).status).toBe(400);
		expect((await send(bundle({ message: "x".repeat(2001) }))).status).toBe(400);
		expect((await send(bundle({ players: { u: 1 } }))).status).toBe(400);
		expect((await send(bundle({ deploy: [1, 2] }))).status).toBe(400);
		expect((await send(bundle({ closing: "yes" }))).status).toBe(400);
		expect((await send("{not json")).status).toBe(400);
		const res = await send(bundle());
		expect(res.status).toBe(202);
		expect(await asJson(res)).toEqual({ ok: true, id: hex(1) });
	});

	test("a repeat id is idempotent: 202, nothing new stored", async () => {
		const res = await send(bundle({ message: "a second copy" }));
		expect(res.status).toBe(202);
		expect(await asJson(res)).toMatchObject({ ok: true, id: hex(1), duplicate: true });
		const list = await asJson(await h.call(`/v1/fleet/servers/${JOB}/bundles`, { headers: admin }));
		expect(list.bundles).toHaveLength(1);
		expect(list.bundles[0]).toMatchObject({ id: hex(1), job: JOB, code: "deploy_failed", level: "critical", message: "generation 3 failed to start", closing: false, at: T0, kernel: "0.5.3", branch: "prod", artifact: "art-9", seq: 12, generation: 3, players: 2, stage: "start" });
		expect(list.bundles[0].size).toBeGreaterThan(500);
		expect(list.bundles[0].time).toBe(new Date(T0).toISOString());
	});

	test("over 512 KB: 413 (declared or not)", async () => {
		const big = bundle({ id: hex(2), serverLog: [{ i: 1, t: 1, kind: "output", text: "x".repeat(520 * 1024) }] });
		expect((await send(big)).status).toBe(413);
		// No content-length: the stream is cut at the cap.
		const text = JSON.stringify(big);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(text));
				c.close();
			},
		});
		expect((await h.call("/v1/fleet/bundle", { method: "POST", body: stream, headers: { "content-type": "application/json", ...bearer(API) }, duplex: "half" } as RequestInit)).status).toBe(413);
		// Just under the cap is fine.
		expect((await send(bundle({ id: hex(3), serverLog: [{ i: 1, t: 1, kind: "output", text: "y".repeat(400 * 1024) }] }))).status).toBe(202);
	});

	test("Content-Encoding: gzip (the kernel compresses bodies over 1 KB): inflated, and the 512 KB cap holds inflated too", async () => {
		const gz = (value: unknown) => Bun.gzipSync(new TextEncoder().encode(JSON.stringify(value)));
		const sendGz = (body: Uint8Array) => (h.setNow(h.now() + 10_000), h.call("/v1/fleet/bundle", { method: "POST", body, headers: { "content-type": "application/json", "content-encoding": "gzip", ...bearer(API) } }));
		// b, a, s and g are left out when unknown: stored as null.
		const { b: _b, a: _a, s: _s, g: _g, ...lean } = bundle({ id: hex(5) });
		expect((await sendGz(gz(lean))).status).toBe(202);
		const list = await asJson(await h.call(`/v1/fleet/servers/${JOB}/bundles`, { headers: admin }));
		expect(list.bundles.find((b: { id: string }) => b.id === hex(5))).toMatchObject({ branch: null, artifact: null, seq: null, generation: null });
		// Small on the wire, over the cap inflated.
		const bomb = gz(bundle({ id: hex(6), serverLog: [{ i: 1, t: 1, kind: "output", text: "z".repeat(600 * 1024) }] }));
		expect(bomb.length).toBeLessThan(10_000);
		expect((await sendGz(bomb)).status).toBe(413);
		expect((await sendGz(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).status).toBe(400);
	});

	test("owners read the body; the read-only web role reads it without playerLogs; 404 when gone", async () => {
		const owner = await asJson(await h.call(`/v1/fleet/bundles/${hex(1)}`, { headers: admin }));
		expect(owner.bundle.body.playerLogs).toEqual({ "101": [{ t: Math.floor(T0 / 1000), kind: "warning", text: "client line" }] });
		expect(owner.bundle.body.serverLog[0].text).toBe("<b>not html</b>");
		expect(owner.bundle.playerLogsHidden).toBeUndefined();
		const viewer = await asJson(await h.call(`/v1/fleet/bundles/${hex(1)}`, { headers: web }));
		expect(viewer.bundle.body.playerLogs).toBeUndefined();
		expect(viewer.bundle.playerLogsHidden).toBe(true);
		expect(viewer.bundle.body.players).toHaveLength(2);
		expect(JSON.stringify(viewer)).not.toContain("client line");
		expect((await h.call(`/v1/fleet/servers/${JOB}/bundles`, { headers: web })).status).toBe(200);
		expect((await h.call(`/v1/fleet/bundles/${hex(99)}`, { headers: admin })).status).toBe(404);
		expect((await h.call("/v1/fleet/bundles/not-an-id", { headers: admin })).status).toBe(404);
		// No reads with the API key or without credentials.
		expect((await h.call(`/v1/fleet/bundles/${hex(1)}`, { headers: bearer(API) })).status).toBe(401);
		expect((await h.call(`/v1/fleet/bundles/${hex(1)}`)).status).toBe(401);
		// The web role can't post one either (the ingest key only).
		expect((await send(bundle({ id: hex(4) }), web)).status).toBe(401);
	});

	test("its own limiter per JobId, and the new-JobId gate like the other fleet POSTs", async () => {
		const job = "bundle-limit-job";
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: job }))).status).toBe(202);
		const statuses: number[] = [];
		for (let i = 0; i < FLEET_LIMITS.bundle + 2; i++) statuses.push((await send(bundle({ id: hex(100 + i), j: job }), bearer(API), false)).status);
		expect(statuses.filter((s) => s === 202).length).toBe(FLEET_LIMITS.bundle);
		expect(statuses.at(-1)).toBe(429);
	});

	test("never-seen JobIds go through the new-JobId gate; known ones don't", async () => {
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => T0 });
		await service.heartbeat({ j: "known" });
		const open = { take: () => true, retryAfter: () => 1 };
		const limiters = Object.fromEntries(Object.keys(FLEET_LIMITS).map((k) => [k, open])) as Record<keyof typeof FLEET_LIMITS, typeof open>;
		const options = { service, isIngest: () => true, isAdmin: () => false, limiters, newJobs: new NewJobLimiter(1, () => T0) };
		const postBundle = async (body: unknown) => {
			const req = new Request("http://fleet.test/v1/fleet/bundle", { method: "POST", body: JSON.stringify(body) });
			return (await handleFleet(req, new URL(req.url), options))?.status;
		};
		expect(await postBundle(bundle({ id: hex(300), j: "new-1" }))).toBe(202);
		expect(await postBundle(bundle({ id: hex(301), j: "new-2" }))).toBe(429);
		expect(await postBundle(bundle({ id: hex(302), j: "known" }))).toBe(202);
		expect((await service.bundles("new-2"))).toEqual([]);
		await service.close();
	});

	test("GET /v1/fleet/servers/<job> carries the history: alerts with details, reports, bundles, swaps, metrics range", async () => {
		expect((await h.call("/v1/fleet/alert", post(API, { level: "critical", code: "deploy_failed", message: "start failed", j: JOB, d: { stage: "start", attempts: 2, transient: false, bundle: hex(1) } }))).status).toBe(202);
		expect((await h.call("/v1/fleet/report", post(API, { s: 12, j: JOB, r: "failed", e: "boom", b: "prod", a: "art-9" }))).status).toBe(202);
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: JOB, b: "prod", a: "art-9", n: 2 }))).status).toBe(202);
		const view = await asJson(await h.call(`/v1/fleet/servers/${JOB}`, { headers: web }));
		expect(view.state).toBe("live");
		expect(view.history.alerts[0]).toMatchObject({ code: "deploy_failed", details: { stage: "start", attempts: 2, transient: false, bundle: hex(1) } });
		expect(view.history.reports[0]).toMatchObject({ seq: 12, result: "failed", error: "boom" });
		expect(view.history.bundles.map((b: { id: string }) => b.id)).toContain(hex(1));
		expect(view.history.swaps.map((s: { name: string }) => s.name)).toEqual(["g2", "g1"]);
		expect(view.history.swaps[0]).toMatchObject({ at: T0 - 60_000, artifact: "art-9", reason: "deploy", bundle: expect.any(String) });
		expect(view.history.metrics.from).toBe(T0);
	});

	test("Recently gone: GET /v1/fleet/servers?gone=1 lists closed and lost servers, the most recently gone first", async () => {
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: "gone-a" }))).status).toBe(202);
		expect((await h.call("/v1/fleet/closing", post(API, { j: "gone-a" }))).status).toBe(202);
		const gone = await asJson(await h.call("/v1/fleet/servers?gone=1", { headers: web }));
		expect(gone.servers[0]).toMatchObject({ job: "gone-a", state: "closed", closedAt: new Date(h.now()).toISOString(), lostAt: null });
		expect(gone.servers.some((s: { job: string }) => s.job === JOB)).toBe(false);
	});
});

describe("alert details (`d`)", () => {
	test("a flat object of strings, numbers and booleans is kept; anything else is null, never a 400", () => {
		const base = { level: "critical", code: "deploy_failed", message: "m", j: "job" };
		expect(parseAlert({ ...base, d: { stage: "load", error: "x", attempts: 3, transient: true } }).details).toEqual({ stage: "load", error: "x", attempts: 3, transient: true });
		expect(parseAlert(base).details).toBeNull();
		for (const d of [
			"text",
			[1, 2],
			{ nested: { a: 1 } },
			{ list: [1] },
			{ nothing: null },
			{ big: "x".repeat(1001) },
			{ "bad key": 1 },
			{ n: Number.NaN },
			Object.fromEntries(Array.from({ length: ALERT_DETAILS_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i])),
			// 16 keys of 300 characters: each fits, the whole is over 4 KB.
			Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "y".repeat(300)])),
			{},
		])
			expect(parseAlertDetails(d)).toBeNull();
		// Strings are counted in bytes: 400 three-byte characters are over 1,000.
		expect(parseAlertDetails({ s: "€".repeat(400) })).toBeNull();
		expect(parseAlertDetails({ s: "€".repeat(300) })).toEqual({ s: "€".repeat(300) });
	});
});

describe("retention and history in the store", () => {
	test("bundles: 30 days, at most 20 per JobId, at most the byte cap in all (the oldest go first)", async () => {
		let now = T0;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => now, bundlesMaxBytes: 3000 });
		for (let i = 0; i < BUNDLES_PER_JOB + 5; i++) {
			now = T0 + i * 1000;
			await service.bundle(bundle({ id: hex(i), t: null, j: "many" }));
		}
		let list = await service.bundles("many");
		expect(list).toHaveLength(BUNDLES_PER_JOB);
		expect(list[0].id).toBe(hex(BUNDLES_PER_JOB + 4));
		expect(list.at(-1)?.id).toBe(hex(5));
		// The byte cap: each stores ~600 bytes gzipped, so 3,000 keeps the newest few.
		await service.pruneBundles(now);
		list = await service.bundles("many");
		expect(list.length).toBeGreaterThan(0);
		expect(list.length).toBeLessThan(BUNDLES_PER_JOB);
		expect(list[0].id).toBe(hex(BUNDLES_PER_JOB + 4));
		// 30 days later the hourly sweep drops them all.
		now += KEEP_BUNDLES_MS + 1;
		await service.sweep();
		expect(await service.bundles("many")).toEqual([]);
		expect(await service.bundleById(hex(BUNDLES_PER_JOB + 4), { playerLogs: true })).toBeNull();
		await service.close();
	});

	test("the body round-trips through gzip; a kernel time a day off is replaced by the arrival time", async () => {
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => T0 });
		await service.bundle(bundle({ t: 1 }));
		const got = await service.bundleById(hex(1), { playerLogs: true });
		expect(got?.at).toBe(T0);
		expect(got?.body).toEqual(JSON.parse(JSON.stringify(bundle({ t: 1 }))));
		const raw = await (service as unknown as { db: { first<T>(sql: string): Promise<T> } }).db.first<{ stored: number; size: number }>("SELECT stored, size FROM bundles");
		expect(raw.stored).toBeLessThan(raw.size);
		expect(parseBundle(bundle()).swaps).toHaveLength(2);
		await service.close();
	});

	test("gone servers stay 30 days (not 1), at most goneServersMax, then the JobId is 'gone' while its history lasts", async () => {
		expect(KEEP_GONE_SERVERS_MS).toBe(30 * 86_400_000);
		expect(GONE_SERVERS_MAX).toBe(50_000);
		let now = T0;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => now, goneServersMax: 2 });
		for (const j of ["g1", "g2", "g3"]) {
			await service.heartbeat({ j, b: "prod" });
			now += 1000;
			await service.closing({ j });
		}
		await service.heartbeat({ j: "live-one" });
		await service.alert({ level: "warning", code: "slow", message: "m", j: "g1", d: { tps: 41 } });
		// Two days on: a 1-day rule would have dropped them; the cap keeps the 2 most recently gone (g2, g3).
		now += 2 * 86_400_000;
		await service.heartbeat({ j: "live-one" });
		await service.sweep();
		expect((await service.server("g3")).state).toBe("closed");
		expect((await service.server("g2")).state).toBe("closed");
		expect((await service.knows("live-one"))).toBe(true);
		const g1 = await service.server("g1");
		expect(g1.state).toBe("gone");
		expect(g1.server).toBeNull();
		expect(g1.history.alerts[0]).toMatchObject({ code: "slow", details: { tps: 41 } });
		expect((await service.server("never")).state).toBe("unknown");
		// Past 30 days the rows go.
		now += KEEP_GONE_SERVERS_MS;
		await service.heartbeat({ j: "live-one" });
		await service.sweep();
		expect((await service.server("g3")).server).toBeNull();
		expect((await service.goneServers()).servers).toEqual([]);
		await service.close();
	});

	test("a lost server shows when it was lost; its history has the deploy reports", async () => {
		let now = T0;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => now });
		await service.heartbeat({ j: "lost-1", b: "prod" });
		await service.report({ s: 4, j: "lost-1", r: "swapped", d: 1.5 });
		now += 120_000;
		await service.sweep();
		const view = await service.server("lost-1");
		expect(view.state).toBe("lost");
		expect(view.server?.lostAt).toBe(new Date(now).toISOString());
		expect(view.history.reports).toMatchObject([{ seq: 4, result: "swapped" }]);
		expect(view.history.alerts.map((a) => a.code)).toEqual(["server_lost"]);
		expect((await service.goneServers()).servers).toMatchObject([{ job: "lost-1", state: "lost" }]);
		await service.close();
	});
});

describe("metrics rollups", () => {
	test("finished 5-minute buckets are rolled up, kept 30 days, and the chart reads them for a since older than the raw window", async () => {
		const start = Math.ceil(T0 / ROLLUP_MS) * ROLLUP_MS;
		let now = start;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => now });
		// 30 minutes of heartbeats every 30 s: TPS 60 in even buckets, 40 in odd ones.
		for (let i = 0; i < 60; i++) {
			now = start + i * 30_000;
			const bucket = Math.floor((now - start) / ROLLUP_MS);
			await service.heartbeat({ j: "roll", n: i, pf: { a: bucket % 2 ? 40 : 60, m: bucket % 2 ? 30 : 55, p: 60 }, bu: { mem: { t: 1000 + i, h: 100 } } });
			await service.sweep();
		}
		const db = (service as unknown as { db: { all<T>(sql: string): Promise<T[]> } }).db;
		const rows = await db.all<{ t: number; n: number; tps: number; tps_min: number; players: number }>("SELECT t, n, tps, tps_min, players FROM server_metrics_5m ORDER BY t");
		// Five finished buckets of 10 points (the sixth is still going).
		expect(rows.map((r) => r.t)).toEqual([0, 1, 2, 3, 4].map((b) => start + b * ROLLUP_MS));
		expect(rows.map((r) => r.n)).toEqual([10, 10, 10, 10, 10]);
		expect(rows.map((r) => r.tps)).toEqual([60, 40, 60, 40, 60]);
		expect(rows[1].tps_min).toBe(30);
		expect(rows[0].players).toBe(9);
		// Sweeping again changes nothing (an upsert per bucket).
		await service.sweep();
		expect((await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM server_metrics_5m"))[0].n).toBe(5);
		// Three hours later the raw points are gone; the server's whole life comes from the rollups.
		now = start + 3 * 3_600_000;
		await service.sweep();
		expect((await service.metrics("roll")).points).toEqual([]);
		const life = await service.metrics("roll", { since: start });
		expect(life.points.map((p) => p.tps)).toEqual([60, 40, 60, 40, 60, 40]);
		expect(life.rolledUntil).toBe(Math.floor((now - KEEP_METRICS_MS) / ROLLUP_MS) * ROLLUP_MS);
		expect((await service.server("roll")).history.metrics).toEqual({ from: start, to: start + 6 * ROLLUP_MS });
		// A since inside the raw window reads raw points only (the old shape).
		expect(await service.metrics("roll", { since: now - 60_000 })).toEqual({ points: [] });
		// 30 days on, the hourly sweep drops them.
		now += KEEP_ROLLUPS_MS;
		await service.sweep();
		expect((await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM server_metrics_5m"))[0].n).toBe(0);
		await service.close();
	});

	test("a restart goes on from the newest rollup and never re-rolls a bucket the raw pruning cut", async () => {
		const start = Math.ceil(T0 / ROLLUP_MS) * ROLLUP_MS;
		let now = start;
		const sqlite = await openSqlite(":memory:");
		let service = await FleetService.open({ db: sqlite, clock: () => now });
		for (let i = 0; i < 20; i++) {
			now = start + i * 30_000;
			await service.heartbeat({ j: "restart", pf: { a: 50, m: 50, p: 60 } });
		}
		now = start + 11 * 60_000;
		await service.sweep();
		// The same file, a new service (a deploy's next container): its first sweep reads where the rollup got to.
		service = await FleetService.open({ db: sqlite, clock: () => now });
		now = start + 16 * 60_000;
		await service.sweep();
		const rows = await sqlite.all<{ t: number; n: number }>("SELECT t, n FROM server_metrics_5m ORDER BY t");
		expect(rows).toEqual([
			{ t: start, n: 10 },
			{ t: start + ROLLUP_MS, n: 10 },
		]);
		await sqlite.close();
	});
});
