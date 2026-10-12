/** The fleet API: ingest from kernels and the CLI, live reads, server-side alerts, webhooks, the SSE stream. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFleetClient, FleetApiError } from "../src/fleet/client.ts";
import { openSqlite } from "../src/fleet/db.ts";
import { FLEET_NEW_JOBS_PER_MINUTE, handleFleet, NewJobLimiter } from "../src/fleet/http.ts";
import { alertText, createNotifier, detectFormat, webhookBody } from "../src/fleet/notify.ts";
import { FleetService, KEEP_METRICS_MS, METRIC_MEMORY_MAX, METRIC_RATE_MAX, METRICS_MAX_POINTS, METRICS_MAX_ROWS, parseBudget, parseHeartbeat, parseMetrics, type FleetEvent } from "../src/fleet/service.ts";
import { startApp, type App } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";

const INGEST = "fleet-ingest-token-0123456789abcdef0123";
const ADMIN = "fleet-admin-token-0123456789abcdef01234";
const ACCESS_CODE = "PRIVATE-ACCESS-CODE-777";
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

let now = T0;
let dir: string;
let app: App;
let base: string;
const hooks: { url: string; body: unknown }[] = [];
const hookFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	hooks.push({ url: String(input), body: JSON.parse(String(init?.body)) });
	return new Response("", { status: 204 });
}) as typeof fetch;

const ingest = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base}/v1/fleet/${path}`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** The kernel's heartbeat (kernel Fleet.luau / fleetStatus): t = server type, s and u in unix seconds, sv = 2. */
const hb = (j: string, over: Record<string, unknown> = {}) => ({ j, t: "public", b: "prod", c: "prod", a: "art-41", n: 10, m: 20, s: Math.floor((T0 - 3_600_000) / 1000), u: Math.floor(now / 1000), p: 1001, v: "0.3.2", q: 41, g: 3, h: "ok", sv: 2, ...over });

let client: ReturnType<typeof createFleetClient>;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tt-fleet-"));
	const config = loadConfig([], {
		TYPETORCH_DATA_DIR: dir,
		PORT: "0",
		TYPETORCH_PARTS: "fleet",
		TYPETORCH_API_KEY: INGEST,
		TYPETORCH_ADMIN_TOKEN: ADMIN,
		TYPETORCH_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
	});
	app = await startApp(config, { clock: () => now, manualJobs: true, log: () => {}, fetch: hookFetch });
	base = `http://127.0.0.1:${app.port}`;
	client = createFleetClient({ url: base, token: ADMIN, ingestToken: INGEST });
});
afterAll(async () => {
	await app.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("auth check", () => {
	test("GET /v1/auth/check says the role and that only the fleet part runs here, and changes nothing", async () => {
		const check = (token?: string) => fetch(`${base}/v1/auth/check`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
		expect(await (await check(INGEST)).json()).toMatchObject({ ok: true, role: "game", parts: { analytics: false, fleet: true } });
		expect(await (await check(ADMIN)).json()).toMatchObject({ ok: true, role: "admin", parts: { analytics: false, fleet: true } });
		expect((await check()).status).toBe(401);
		expect((await check("not-a-token-0123456789abcdefgh01234567")).status).toBe(401);
		expect((await client.servers()).servers).toEqual([]);
	});
});

describe("ingest", () => {
	test("tokens, shapes, sizes", async () => {
		expect((await ingest("heartbeat", hb("job-1"), { authorization: `Bearer ${ADMIN}` })).status).toBe(401);
		expect((await ingest("heartbeat", { t: 1 })).status).toBe(400); // no JobId
		expect((await ingest("report", { s: 1, j: "job-1", r: "exploded" })).status).toBe(400);
		expect((await ingest("alert", { level: "panic", code: "x", message: "m" })).status).toBe(400);
		expect((await ingest("heartbeat", { j: "job-1", pad: "x".repeat(20_000) })).status).toBe(413);
		expect((await fetch(`${base}/v1/fleet/servers`)).status).toBe(401);
		expect((await fetch(`${base}/v1/fleet/servers`, { headers: { authorization: `Bearer ${INGEST}` } })).status).toBe(401);
	});

	test("heartbeats upsert one row per JobId; the access code is never stored or returned", async () => {
		for (const j of ["job-1", "job-2", "job-3"]) expect((await ingest("heartbeat", hb(j, j === "job-2" ? { k: ACCESS_CODE } : {}))).status).toBe(202);
		// The JobId may also come in a header.
		const { j: _j, ...noJob } = hb("job-4");
		expect((await ingest("heartbeat", noJob, { "x-tt-job": "job-4" })).status).toBe(202);
		expect((await ingest("heartbeat", hb("job-1", { n: 12 }))).status).toBe(202);
		const started = performance.now();
		const list = await client.servers();
		const ms = performance.now() - started;
		expect(list.servers.map((s) => s.job).sort()).toEqual(["job-1", "job-2", "job-3", "job-4"]);
		expect(list.players).toBe(42);
		expect(list.servers.find((s) => s.job === "job-1")?.players).toBe(12);
		expect(JSON.stringify(list)).not.toContain(ACCESS_CODE);
		expect(ms).toBeLessThan(200);
		expect((await client.servers({ branch: "dev" })).servers).toEqual([]);
	});

	test("rate limit per JobId", async () => {
		let limited = 0;
		for (let i = 0; i < 45; i++) if ((await ingest("heartbeat", hb("job-9"))).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
		const closing = await ingest("closing", { j: "job-9", t: now });
		expect(closing.status).toBe(202);
	});
});

describe("deploys, reports, stuck servers", () => {
	test("reports: results, errors, servers behind", async () => {
		await client.deployStarted({ s: 42, b: "prod", a: "art-42", ch: "prod" });
		await ingest("report", { s: 42, b: "prod", a: "art-42", j: "job-1", r: "swapped", d: 1.2, t: now, g: 4, k: "0.3.2", p: 12 });
		await ingest("heartbeat", hb("job-1", { q: 42, a: "art-42", g: 4 }));
		await ingest("report", { s: 42, b: "prod", a: "art-42", j: "job-2", r: "failed", e: "swap failed: boom", d: 0.4, t: now, g: 3, k: "0.3.2", p: 10 });
		const r = await client.reports({ seq: 42 });
		expect(r).toMatchObject({ seq: 42, branch: "prod", artifact: "art-42", reported: 2 });
		expect(r.results).toEqual([
			{ result: "swapped", servers: 1, players: 12, medianSeconds: 1.2, maxSeconds: 1.2 },
			{ result: "failed", servers: 1, players: 10, medianSeconds: 0.4, maxSeconds: 0.4 },
		]);
		expect(r.errors).toEqual([{ error: "swap failed: boom", servers: 1, exampleJob: "job-2" }]);
		expect(r.behind.map((s) => s.job)).toEqual(["job-2", "job-3", "job-4"]);
		expect(r.stuck).toEqual([]); // not 3 minutes yet
		expect((await client.reports()).seq).toBe(42);
		expect((await client.reports({ artifact: "art-42" })).seq).toBe(42);
	});

	test("server_stuck after 3 minutes lists the JobIds with no report (a warning, not a verdict on the build)", async () => {
		now += 3 * 60_000 + 1000;
		for (const j of ["job-1", "job-2", "job-3", "job-4"]) await ingest("heartbeat", hb(j, j === "job-1" ? { q: 42 } : {}));
		const swept = await app.fleet?.sweep();
		expect(swept?.stuck).toBe(2);
		const alerts = await client.alerts({ level: "warning" });
		const stuck = alerts.find((a) => a.code === "server_stuck");
		expect(stuck?.details).toEqual({ jobs: ["job-3", "job-4"], count: 2 });
		expect(stuck?.message).toContain("still below seq 42");
		expect(stuck?.message).not.toMatch(/bad|broken|fail/i);
		expect((await client.reports({ seq: 42 })).stuck).toEqual(["job-3", "job-4"]);
		// Once per deploy.
		expect((await app.fleet?.sweep())?.stuck).toBe(0);
	});
});

describe("alerts", () => {
	test("server_lost after 90 s without a closing message; closing servers are not lost", async () => {
		await ingest("closing", { j: "job-4", t: now });
		now += 91_000;
		await ingest("heartbeat", hb("job-1", { q: 42 }));
		const swept = await app.fleet?.sweep();
		expect(swept?.lost).toBe(2); // job-2 and job-3; job-4 closed
		const lost = (await client.alerts()).find((a) => a.code === "server_lost");
		expect(lost).toMatchObject({ level: "warning", branch: "prod", source: "server" });
		expect((lost?.details as { jobs: string[] }).jobs.sort()).toEqual(["job-2", "job-3"]);
		expect((await client.servers()).servers.map((s) => s.job)).toEqual(["job-1"]);
		// Three at once is critical.
		for (const j of ["job-5", "job-6", "job-7"]) await ingest("heartbeat", hb(j, { b: "dev" }));
		now += 91_000;
		await ingest("heartbeat", hb("job-1", { q: 42 }));
		await app.fleet?.sweep();
		expect((await client.alerts({ level: "critical" })).find((a) => a.code === "server_lost")?.branch).toBe("dev");
	});

	test("game and CLI alerts, ack, filters", async () => {
		const id = await client.alert({ level: "critical", code: "auto_rollback", message: "rolled prod back to seq 41 after 3 failed swaps", b: "prod", a: "art-42", s: 42 });
		const a = (await client.alerts({ unacked: true })).find((x) => x.id === id);
		expect(a).toMatchObject({ code: "auto_rollback", source: "cli", level: "critical" });
		const game = await ingest("alert", { level: "warning", code: "swap_slow", message: "swap took 12 s", j: "job-1", b: "prod", a: "art-42", s: 42, t: now, g: 4, k: "0.3.2" });
		expect(game.status).toBe(202);
		expect(await client.ack(id, "dev-pc")).toBe(true);
		expect(await client.ack(id)).toBe(false);
		expect((await client.alerts({ unacked: true })).some((x) => x.id === id)).toBe(false);
		expect((await client.alerts({ since: now + 1 })).length).toBe(0);
		await expect(client.alerts({ level: "nope" as never })).rejects.toBeInstanceOf(FleetApiError);
	});

	test("critical alerts reach the webhook (Discord format), deduped per (code, branch, artifact)", async () => {
		await app.bus.idle();
		await app.notifier?.flush();
		const sent = hooks.map((h) => (h.body as { content: string }).content);
		expect(sent.some((c) => c.startsWith("CRITICAL: auto_rollback (prod, art-42, seq 42)"))).toBe(true);
		expect(sent.some((c) => c.includes("server_lost (dev"))).toBe(true);
		expect(sent.some((c) => c.includes("swap_slow"))).toBe(false); // warnings aren't sent by default
		const before = hooks.length;
		await client.alert({ level: "critical", code: "auto_rollback", message: "again", b: "prod", a: "art-42" });
		await app.bus.idle();
		await app.notifier?.flush();
		expect(hooks.length).toBe(before);
		expect(app.notifier?.stats.deduped).toBeGreaterThan(0);
	});
});

test("SSE stream: live changes and new alerts", async () => {
	const seen: FleetEvent["type"][] = [];
	const got = new Promise<void>((done) => {
		const s = client.stream((event) => {
			if (event.type === "hello") {
				void ingest("heartbeat", hb("job-1", { q: 42, n: 3 }));
				return;
			}
			seen.push(event.type);
			if (event.type === "server") {
				expect(JSON.stringify(event)).not.toContain(ACCESS_CODE);
				void client.alert({ level: "warning", code: "test_alert", message: "hello" });
			}
			if (event.type === "alert") {
				s.close();
				done();
			}
		});
	});
	await got;
	expect(seen).toEqual(["server", "alert"]);
});

describe("the kernel's and the CLI's shapes", () => {
	test("servers: long names, seconds -> ISO, x -> experiment, sv -> serverVersion", async () => {
		await ingest("heartbeat", hb("job-k", { x: 1, t: "reserved", b: "kernel-shape" }));
		const [s] = (await client.servers({ branch: "kernel-shape" })).servers;
		expect(s).toMatchObject({ job: "job-k", serverType: "reserved", experiment: true, serverVersion: 2, appliedSeq: 41, kernel: "0.3.2", health: "ok" });
		expect(s.startedAt).toBe(new Date(Math.floor((T0 - 3_600_000) / 1000) * 1000).toISOString());
	});

	test("closing with the heartbeat body plus closing = true (BindToClose)", async () => {
		expect((await ingest("closing", { ...hb("job-k", { b: "kernel-shape", n: 0 }), closing: true })).status).toBe(202);
		expect((await client.servers({ branch: "kernel-shape" })).servers).toEqual([]);
	});

	test("GET reports carries { reports: [...] } rows; alerts carry at (ms) and acked", async () => {
		const body = (await (await fetch(`${base}/v1/fleet/reports?seq=42`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { reports: { seq: number; job: string; result: string; at: number }[] };
		expect(body.reports.map((r) => [r.seq, r.job, r.result])).toEqual([
			[42, "job-1", "swapped"],
			[42, "job-2", "failed"],
		]);
		expect(typeof body.reports[0].at).toBe("number");
		const latest = (await (await fetch(`${base}/v1/fleet/reports?latest`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { seq: number };
		expect(latest.seq).toBe(42);
		const cli = await ingest("alert", { level: "warning", code: "server_stuck", message: "2 servers below #42 [job-3, job-4]", j: "cli", b: "prod", s: 42, t: Math.floor(now / 1000) });
		expect(cli.status).toBe(202);
		const alerts = (await (await fetch(`${base}/v1/fleet/alerts?since=0&level=warning`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { alerts: { code: string; at: number; acked: boolean; source: string; job: string | null }[] };
		const stuck = alerts.alerts.find((a) => a.code === "server_stuck" && a.source === "cli");
		expect(stuck).toMatchObject({ acked: false, job: null });
		expect(typeof stuck?.at).toBe("number");
	});
});

describe("new-JobId flood limit", () => {
	const LIMIT = 3;
	let floodNow = T0 + 5_000; // 5 s into a clock minute
	let floodDir: string;
	let floodApp: App;
	let floodBase: string;
	const floodHooks: string[] = [];
	const events: FleetEvent[] = [];
	const post = (path: string, body: unknown) =>
		fetch(`${floodBase}/v1/fleet/${path}`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-type": "application/json" }, body: JSON.stringify(body) });
	const floodAlerts = async () => (await createFleetClient({ url: floodBase, token: ADMIN }).alerts()).filter((a) => a.code === "fleet_flood");

	beforeAll(async () => {
		floodDir = mkdtempSync(join(tmpdir(), "tt-fleet-flood-"));
		const config = loadConfig([], {
			TYPETORCH_DATA_DIR: floodDir,
			PORT: "0",
			TYPETORCH_PARTS: "fleet",
			TYPETORCH_API_KEY: INGEST,
			TYPETORCH_ADMIN_TOKEN: ADMIN,
			TYPETORCH_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/2/def",
			TYPETORCH_NEW_JOBS_PER_MINUTE: String(LIMIT),
		});
		const capture = (async (_input: string | URL | Request, init?: RequestInit) => {
			floodHooks.push((JSON.parse(String(init?.body)) as { content: string }).content);
			return new Response("", { status: 204 });
		}) as typeof fetch;
		floodApp = await startApp(config, { clock: () => floodNow, manualJobs: true, log: () => {}, fetch: capture });
		floodBase = `http://127.0.0.1:${floodApp.port}`;
		floodApp.fleet?.subscribe((event) => events.push(event));
	});
	afterAll(async () => {
		await floodApp.stop();
		rmSync(floodDir, { recursive: true, force: true });
	});

	test("past the limit never-seen JobIds get 429 and one fleet_flood alert goes to the webhook and the stream; known JobIds and the CLI pass", async () => {
		for (const j of ["srv-1", "srv-2", "srv-3"]) expect((await post("heartbeat", hb(j))).status).toBe(202);
		const refused = await post("heartbeat", hb("fake-1"));
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("55"); // until the minute ends
		expect(((await refused.json()) as { error: string }).error).toContain("new JobIds");
		expect((await post("report", { s: 1, j: "fake-2", r: "booted" })).status).toBe(429);
		expect((await post("alert", { level: "warning", code: "x", message: "m", j: "fake-3" })).status).toBe(429);
		// Known servers keep going, and so does the CLI (j = "cli").
		for (const j of ["srv-1", "srv-2", "srv-3"]) expect((await post("heartbeat", hb(j, { n: 5 }))).status).toBe(202);
		expect((await post("report", { s: 1, j: "srv-2", r: "booted" })).status).toBe(202);
		expect((await post("alert", { level: "warning", code: "server_stuck", message: "x", j: "cli" })).status).toBe(202);
		const servers = await createFleetClient({ url: floodBase, token: ADMIN }).servers();
		expect(servers.servers.map((s) => s.job).sort()).toEqual(["srv-1", "srv-2", "srv-3"]);
		const floods = await floodAlerts();
		expect(floods.length).toBe(1);
		expect(floods[0]).toMatchObject({ level: "critical", source: "server", job: null, details: { limit: LIMIT, windowSeconds: 60, example: "fake-1" } });
		expect(events.filter((e) => e.type === "alert" && e.alert.code === "fleet_flood").length).toBe(1);
		await floodApp.bus.idle();
		await floodApp.notifier?.flush();
		expect(floodHooks.filter((c) => c.startsWith("CRITICAL: fleet_flood")).length).toBe(1);
	});

	test("the next minute lets new JobIds in again; another flood raises one more alert (the webhook dedupes it)", async () => {
		floodNow += 60_000;
		for (const j of ["srv-4", "fake-1", "fake-4"]) expect((await post("heartbeat", hb(j))).status).toBe(202);
		expect((await post("heartbeat", hb("fake-5"))).status).toBe(429);
		expect((await post("heartbeat", hb("fake-6"))).status).toBe(429);
		expect((await floodAlerts()).length).toBe(2);
		await floodApp.bus.idle();
		await floodApp.notifier?.flush();
		expect(floodHooks.filter((c) => c.startsWith("CRITICAL: fleet_flood")).length).toBe(1);
	});

	test("a JobId over 64 characters is refused before any limiter", async () => {
		expect((await post("heartbeat", hb("x".repeat(65)))).status).toBe(400);
		expect((await post("report", { s: 1, j: "y".repeat(65), r: "booted" })).status).toBe(400);
	});

	test("refused JobIds never reach the per-JobId limiters, and the limiter holds at most its limit", async () => {
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => T0 });
		const keys = new Set<string>();
		const counting = { take: (key: string) => (keys.add(key), true), retryAfter: () => 1 };
		const gate = new NewJobLimiter(10, () => T0);
		const options = { service, isIngest: () => true, isAdmin: () => false, limiters: { heartbeat: counting, report: counting, alert: counting, closing: counting, deploy: counting, mark: counting, bundle: counting }, newJobs: gate };
		const statuses: number[] = [];
		for (let i = 0; i < 100; i++) {
			const req = new Request("http://fleet.test/v1/fleet/heartbeat", { method: "POST", body: JSON.stringify({ j: `random-${i}` }) });
			statuses.push((await handleFleet(req, new URL(req.url), options))?.status ?? 0);
		}
		expect(statuses.filter((s) => s === 202).length).toBe(10);
		expect(statuses.filter((s) => s === 429).length).toBe(90);
		expect(keys.size).toBe(10);
		expect(gate.stats).toEqual({ admitted: 10, refused: 90 });
		expect((await service.servers()).servers.length).toBe(10);
		expect((await service.alerts()).filter((a) => a.code === "fleet_flood").length).toBe(1);
		await service.close();
	});

	test("the default fits a 1,250-server fleet restarting in one minute; a JobId counts once per window", () => {
		const gate = new NewJobLimiter(undefined, () => T0);
		expect(gate.perMinute).toBe(FLEET_NEW_JOBS_PER_MINUTE);
		expect(FLEET_NEW_JOBS_PER_MINUTE).toBe(2000);
		for (let i = 0; i < 1250; i++) expect(gate.take(`job-${i}`)).toBe("ok");
		for (let i = 0; i < 1250; i++) gate.take(`job-${i}`);
		expect(gate.stats).toEqual({ admitted: 1250, refused: 0 });
		expect(loadConfig([], { TYPETORCH_API_KEY: INGEST, TYPETORCH_ADMIN_TOKEN: ADMIN }).fleetNewJobsPerMinute).toBe(2000);
	});
});

describe("notifier and storage units", () => {
	test("formats", () => {
		expect(detectFormat("https://discord.com/api/webhooks/1/x")).toBe("discord");
		expect(detectFormat("https://hooks.slack.com/services/x")).toBe("slack");
		expect(detectFormat("https://example.com/hook")).toBe("json");
		const alert = { id: 1, level: "critical" as const, code: "server_lost", message: "3 servers ...", job: null, branch: "prod", artifact: "a", seq: null, generation: null, kernel: null, source: "server" as const, details: null, createdAt: "", at: 0, acked: false, ackedAt: null, ackedBy: null };
		expect(alertText(alert)).toBe("CRITICAL: server_lost (prod, a): 3 servers ...");
		expect(webhookBody(alert, "slack")).toEqual({ text: "CRITICAL: server_lost (prod, a): 3 servers ..." });
		expect(webhookBody(alert, "json")).toEqual({ alert });
		expect(() => createNotifier({ url: "http://insecure.example.com" })).toThrow("https");
	});

	test("throttle", async () => {
		const posts: unknown[] = [];
		const n = createNotifier({ url: "https://example.com/h", perMinute: 2, fetch: (async (_u: unknown, init?: RequestInit) => (posts.push(init?.body), new Response(""))) as unknown as typeof fetch, clock: () => T0 });
		for (let i = 0; i < 5; i++) n.notify({ id: i, level: "critical", code: `c${i}`, message: "m", job: null, branch: null, artifact: null, seq: null, generation: null, kernel: null, source: "game", details: null, createdAt: "", at: 0, acked: false, ackedAt: null, ackedBy: null });
		await n.flush();
		expect(posts.length).toBe(2);
		expect(n.stats.throttled).toBe(3);
	});

	test("the service works on its own over an in-memory SQLite", async () => {
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => T0 });
		await service.heartbeat({ j: "a", b: "prod", q: 1 });
		expect((await service.servers()).servers.length).toBe(1);
		await service.close();
	});
});

describe("budget summary (kernel 0.4.0 heartbeat bu)", () => {
	const T1 = Date.UTC(2026, 9, 9, 12, 0, 0);
	const bu = { p: 4, ds: { r: 3, w: 1, l: 0, x: 0, lr: 220, lw: 220, br: 900 }, ms: { u: 2, l: 480 }, h: { r: 5, l: 500 }, mg: { p: 0, lp: 1560, s: 3, ls: 240 }, by: { k: 9, a: 4 }, mem: { t: 812.5, h: 120.3 } };

	test("parseBudget keeps a small object of numbers, ignores anything else", () => {
		expect(parseBudget(bu)).toBe(JSON.stringify(bu));
		expect(parseBudget(undefined)).toBeNull();
		expect(parseBudget("x")).toBeNull();
		expect(parseBudget({ ds: { r: "3" } })).toBeNull();
		expect(parseBudget({ a: { b: { c: 1 } } })).toBeNull(); // one level of nesting only
		expect(parseBudget({ "bad key!": 1 })).toBeNull();
		expect(parseBudget({ x: Number.POSITIVE_INFINITY })).toBeNull();
		const big: Record<string, Record<string, number>> = {};
		for (let i = 0; i < 16; i++) {
			const inner: Record<string, number> = {};
			for (let j = 0; j < 16; j++) inner[`k${j}`] = 123456.789;
			big[`g${i}`] = inner;
		}
		expect(parseBudget(big)).toBeNull(); // over BUDGET_MAX characters
	});

	test("stored per server and returned on the server row; a bad bu never refuses the heartbeat", async () => {
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => T1 });
		await service.heartbeat({ j: "job-bu", t: "public", b: "prod", n: 4, m: 10, s: 1791547000, u: 1791547200, p: 1, v: "0.4.0", q: 5, g: 1, h: "ok", sv: 2, bu });
		let { servers } = await service.servers({});
		expect(servers[0].budget).toEqual(bu);
		await service.heartbeat({ j: "job-bu", t: "public", b: "prod", n: 4, m: 10, s: 1791547000, u: 1791547230, p: 1, v: "0.3.9", q: 5, g: 1, h: "ok", sv: 2, bu: { evil: "x" } });
		({ servers } = await service.servers({}));
		expect(servers[0].budget).toBeNull();
		expect(servers[0].kernel).toBe("0.3.9");
	});

	test("a fleet file made before the budget column gets it on open", async () => {
		const db = await openSqlite(":memory:");
		await db.exec(
			"CREATE TABLE servers (job TEXT PRIMARY KEY, server_type TEXT, branch TEXT, channel TEXT, artifact TEXT, players INTEGER, max_players INTEGER, started_at INTEGER, last_write INTEGER, place_id INTEGER, experiment INTEGER, kernel TEXT, applied_seq INTEGER, generation INTEGER, health TEXT, last_error TEXT, server_version INTEGER, sent_at INTEGER, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, closed_at INTEGER, lost_at INTEGER);",
		);
		const service = await FleetService.open({ db, clock: () => T1 });
		await service.heartbeat({ j: "job-old", t: "public", b: "prod", n: 1, m: 10, s: 1791547000, u: 1791547200, p: 1, v: "0.4.0", q: 1, g: 1, h: "ok", sv: 2, bu });
		const { servers } = await service.servers({});
		expect(servers[0].budget).toEqual(bu);
		// Kernel 0.4.2's columns came with it.
		expect(servers[0].memMb).toBe(812.5);
		expect(servers[0].tps).toBeNull();
	});
});

describe("metrics (kernel 0.4.2 heartbeat pf, bu.mem)", () => {
	const T2 = Date.UTC(2026, 9, 9, 18, 0, 0);
	const pf = { a: 59.8, m: 41.5, p: 60 };
	const mem = { t: 812.5, h: 120.3 };
	const beat = (j: string, over: Record<string, unknown> = {}) => ({ j, t: "public", b: "prod", n: 7, m: 20, s: 1791547000, u: 1791547200, p: 1, v: "0.4.2", q: 9, g: 2, h: "ok", sv: 2, pf, bu: { p: 7, mem }, ...over });
	const metricsUrl = (job: string, query = "") => `${base}/v1/fleet/servers/${encodeURIComponent(job)}/metrics${query}`;
	const admin = { authorization: `Bearer ${ADMIN}` };

	test("parseMetrics: each value on its own; malformed ones are null", () => {
		expect(parseMetrics(pf, { mem })).toEqual({ tps: 59.8, tpsMin: 41.5, physFps: 60, memMb: 812.5, luaMb: 120.3 });
		expect(parseMetrics(undefined, undefined)).toEqual({ tps: null, tpsMin: null, physFps: null, memMb: null, luaMb: null });
		expect(parseMetrics("fast", 3)).toEqual({ tps: null, tpsMin: null, physFps: null, memMb: null, luaMb: null });
		expect(parseMetrics([59, 41], { mem: [1, 2] })).toEqual({ tps: null, tpsMin: null, physFps: null, memMb: null, luaMb: null });
		// Strings, negatives, out of range: that value only.
		expect(parseMetrics({ a: "59", m: -1, p: METRIC_RATE_MAX + 1 }, { mem: { t: METRIC_MEMORY_MAX + 1, h: 64 } })).toEqual({ tps: null, tpsMin: null, physFps: null, memMb: null, luaMb: 64 });
		expect(parseMetrics({ a: 0, m: 0.3 }, { mem: { t: 0 } })).toEqual({ tps: 0, tpsMin: 0.3, physFps: null, memMb: 0, luaMb: null });
		expect(parseHeartbeat(beat("job-x", { pf: { a: Number.POSITIVE_INFINITY } }), null).tps).toBeNull();
	});

	test("the latest values on the server row; a malformed pf or bu never refuses the heartbeat; old kernels give nulls", async () => {
		expect((await ingest("heartbeat", beat("job-m1"))).status).toBe(202);
		let row = (await client.servers()).servers.find((s) => s.job === "job-m1");
		expect(row).toMatchObject({ tps: 59.8, tpsMin: 41.5, physFps: 60, memMb: 812.5, luaMb: 120.3 });
		expect((await ingest("heartbeat", beat("job-m1", { pf: { a: "lots", m: { x: 1 } }, bu: "nope" }))).status).toBe(202);
		row = (await client.servers()).servers.find((s) => s.job === "job-m1");
		expect(row).toMatchObject({ tps: null, tpsMin: null, physFps: null, memMb: null, luaMb: null, players: 7 });
		const { pf: _pf, bu: _bu, ...old } = beat("job-m2", { v: "0.3.9" });
		expect((await ingest("heartbeat", old)).status).toBe(202);
		row = (await client.servers()).servers.find((s) => s.job === "job-m2");
		expect(row).toMatchObject({ tps: null, tpsMin: null, physFps: null, memMb: null, luaMb: null, kernel: "0.3.9" });
	});

	test("GET /v1/fleet/servers/<job>/metrics: admin only, one point per heartbeat, oldest first, since filters", async () => {
		const start = now;
		for (let i = 0; i < 3; i++) {
			now = start + i * 30_000;
			expect((await ingest("heartbeat", beat("job-m3", { pf: { a: 60 - i, m: 50 - i, p: 60 }, n: 3 + i }))).status).toBe(202);
		}
		// Roles: nobody and the game's API key get 401 (the key writes, it doesn't read); a write method is refused.
		expect((await fetch(metricsUrl("job-m3"))).status).toBe(401);
		expect((await fetch(metricsUrl("job-m3"), { headers: { authorization: `Bearer ${INGEST}` } })).status).toBe(401);
		expect((await fetch(metricsUrl("job-m3"), { method: "POST", headers: { authorization: `Bearer ${INGEST}` } })).status).toBe(401);
		expect((await fetch(metricsUrl("job-m3"), { method: "POST", headers: admin })).status).toBe(405);
		const res = await fetch(metricsUrl("job-m3"), { headers: admin });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { points: Record<string, unknown>[] };
		expect(Object.keys(body)).toEqual(["points"]);
		expect(body.points).toEqual([
			{ t: start, tps: 60, tpsMin: 50, physFps: 60, memMb: 812.5, luaMb: 120.3, players: 3 },
			{ t: start + 30_000, tps: 59, tpsMin: 49, physFps: 60, memMb: 812.5, luaMb: 120.3, players: 4 },
			{ t: start + 60_000, tps: 58, tpsMin: 48, physFps: 60, memMb: 812.5, luaMb: 120.3, players: 5 },
		]);
		// since = unix ms: only later points (a page polls with the last t it has).
		const later = (await (await fetch(metricsUrl("job-m3", `?since=${start}`), { headers: admin })).json()) as { points: { t: number }[] };
		expect(later.points.map((p) => p.t)).toEqual([start + 30_000, start + 60_000]);
		// Another server's points never mix in; an unknown JobId has none.
		expect(((await (await fetch(metricsUrl("job-m1"), { headers: admin })).json()) as { points: unknown[] }).points.length).toBe(2);
		expect(await (await fetch(metricsUrl("never-seen"), { headers: admin })).json()).toEqual({ points: [] });
		// Bad input: 400, not 500.
		expect((await fetch(metricsUrl("job-m3", "?since=yesterday-ish"), { headers: admin })).status).toBe(400);
		expect((await fetch(metricsUrl("j".repeat(65)), { headers: admin })).status).toBe(400);
		expect((await fetch(`${base}/v1/fleet/servers/%E0%A4%A/metrics`, { headers: admin })).status).toBe(400);
	});

	test("history is pruned: older than 2 h by the sweep, and at most METRICS_MAX_POINTS per server", async () => {
		let clock = T2;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => clock });
		for (let i = 0; i < METRICS_MAX_POINTS + 25; i++) {
			clock = T2 + i * 1000;
			await service.heartbeat(beat("job-cap", { pf: { a: i % 60, m: 1, p: 60 } }));
		}
		await service.heartbeat(beat("job-other"));
		let points = (await service.metrics("job-cap")).points;
		expect(points.length).toBe(METRICS_MAX_POINTS);
		expect(points[0].t).toBe(T2 + 25_000); // the oldest went first
		expect(points.at(-1)?.t).toBe(clock);
		expect((await service.metrics("job-other")).points.length).toBe(1);
		// Two hours later the sweep drops everything older than KEEP_METRICS_MS (and reads never return it meanwhile).
		clock += KEEP_METRICS_MS - 10_000;
		expect((await service.metrics("job-cap")).points.length).toBe(10);
		await service.heartbeat(beat("job-cap"));
		await service.sweep();
		points = (await service.metrics("job-cap")).points;
		expect(points.length).toBe(11);
		const stored = await (service as unknown as { db: { first<T>(sql: string): Promise<T> } }).db.first<{ n: number }>("SELECT COUNT(*) AS n FROM server_metrics");
		expect(stored.n).toBe(12); // job-cap's 11 and job-other's one (10 s inside the window)
		await service.close();
	});

	test("the whole history has a cap too (many JobIds): the sweep keeps the newest metricsMaxRows points", async () => {
		expect(METRICS_MAX_ROWS).toBeGreaterThanOrEqual(1250 * METRICS_MAX_POINTS); // a 1,250-server fleet fits
		let clock = T2;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => clock, metricsMaxRows: 50 });
		for (let i = 0; i < 80; i++) {
			clock = T2 + i * 100;
			await service.heartbeat(beat(`job-flood-${i % 40}`, { n: i }));
		}
		await service.sweep();
		const db = (service as unknown as { db: { first<T>(sql: string): Promise<T> } }).db;
		expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM server_metrics")).n).toBe(50);
		// The oldest went: job-flood-0's first point (players 0) is gone, its second (40) stays.
		expect((await service.metrics("job-flood-0")).points.map((p) => p.players)).toEqual([40]);
		expect((await service.metrics("job-flood-39")).points.map((p) => p.players)).toEqual([39, 79]);
		// Under the cap the sweep deletes nothing.
		await service.sweep();
		expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM server_metrics")).n).toBe(50);
		await service.close();
	});
});
