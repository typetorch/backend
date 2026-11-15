/**
 * Plans/35 C: optional ingest nodes feeding one main server through a queue bucket. A fake S3 server (test/s3-fake.ts)
 * stands in for R2; Bun's own S3Client talks to it. Covers: `all` (the default) ignores and needs no queue settings and
 * starts no queue work; an ingest node accepts, rotates, uploads and deletes its local copy only after the upload, and
 * re-uploads after a crash; the main server loads bucket files and identities, and a re-load never doubles rows in the
 * day file; erased pids are filtered at both ends; the node 404s everything but its routes; busy on both roles; a bucket
 * that is down leaves the main server ingesting its own rows, with an alert. Every token and credential is made up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeConfig, loadConfig } from "../src/server/config.ts";
import { startIngestNode, type IngestNode, type IngestNodeOptions } from "../src/server/ingest-node.ts";
import { parseQueueKey, s3Bucket, type QueueBucket } from "../src/server/queue.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";
import { FAKE_ACCESS_KEY, FAKE_SECRET, fakeS3, queueEnv, type FakeS3 } from "./s3-fake.ts";

const BASE_ENV = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, PORT: "0", TYPETORCH_MEMORY_LIMIT: "256MB", TYPETORCH_EXPLORER: "off", TYPETORCH_CENTRAL_LOGIN: "off" };
const event = (pid: string, t: number, name = "queue_test") => ({ v: 1, t, kind: "custom", name, sid: `s-${pid}`, pid, job: `job-${pid}`, art: "art-1", src: "server" });

interface Node {
	node: IngestNode;
	dir: string;
	call(path: string, init?: RequestInit & { ip?: string }): Promise<Response>;
	logs: string[];
}

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tt-ingest-"));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let now = T0;
async function startNode(s3: FakeS3, mainUrl: string, env: Record<string, string> = {}, options: IngestNodeOptions & { dir?: string } = {}): Promise<Node> {
	const dir = options.dir ?? tempDir();
	const logs: string[] = [];
	const config = loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: dir, TYPETORCH_ROLE: "ingest", TYPETORCH_MAIN_URL: mainUrl, ...queueEnv(s3), ...env });
	const node = await startIngestNode(config, { clock: () => now, manualJobs: true, log: (l) => logs.push(l), ...options });
	return {
		node,
		dir,
		logs,
		call: (path, init = {}) => {
			const { ip, ...rest } = init;
			return node.handle(new Request(`http://ingest.test${path}`, rest), ip ?? "127.0.0.1");
		},
	};
}

const liveCount = async (h: Harness, where = "TRUE") => Number((await h.app.warehouse!.sql(`SELECT COUNT(*) AS n FROM live.events WHERE ${where}`))[0].n);

describe("TYPETORCH_ROLE=all (the default) is today's single server", () => {
	test("config: no role set = all; queue settings are ignored with a warning (names only) and need not be set", () => {
		const plain = loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir() });
		expect(plain.role).toBe("all");
		expect(plain.queue).toBeUndefined();
		expect(plain.mainUrl).toBeUndefined();
		expect(plain.warnings.join("\n")).not.toMatch(/QUEUE|ROLE/);
		expect(describeConfig(plain)).not.toMatch(/role=|queue=/);
		const s3 = { endpoint: "https://acct.r2.cloudflarestorage.com" } as FakeS3;
		const ignored = loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), ...queueEnv(s3), TYPETORCH_MAIN_URL: "https://main.example.com" });
		expect(ignored.role).toBe("all");
		expect(ignored.queue).toBeUndefined();
		const warning = ignored.warnings.find((w) => w.includes("TYPETORCH_QUEUE_BUCKET"));
		expect(warning).toMatch(/ignored: TYPETORCH_ROLE is all/);
		expect(warning).toContain("TYPETORCH_MAIN_URL");
		expect(ignored.warnings.join("\n")).not.toContain(FAKE_SECRET);
		expect(ignored.warnings.join("\n")).not.toContain(FAKE_ACCESS_KEY);
		expect(loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), TYPETORCH_ROLE: "ALL" }).role).toBe("all");
	});

	test("config: main and ingest need the queue settings; ingest needs TYPETORCH_MAIN_URL; secrets never in an error", () => {
		const s3 = { endpoint: "https://acct.r2.cloudflarestorage.com" } as FakeS3;
		const load = (env: Record<string, string>) => () => loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), ...env });
		expect(load({ TYPETORCH_ROLE: "main" })).toThrow(/TYPETORCH_ROLE=main needs the queue bucket: set TYPETORCH_QUEUE_BUCKET, TYPETORCH_QUEUE_ENDPOINT, TYPETORCH_QUEUE_ACCESS_KEY_ID, TYPETORCH_QUEUE_SECRET_ACCESS_KEY/);
		expect(load({ TYPETORCH_ROLE: "ingest", ...queueEnv(s3) })).toThrow(/needs TYPETORCH_MAIN_URL/);
		expect(load({ TYPETORCH_ROLE: "edge" })).toThrow(/TYPETORCH_ROLE is all/);
		expect(load({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_QUEUE_ENDPOINT: "http://r2.example.com" })).toThrow(/TYPETORCH_QUEUE_ENDPOINT must be an origin/);
		expect(load({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_QUEUE_PREFIX: "../x/" })).toThrow(/TYPETORCH_QUEUE_PREFIX/);
		expect(load({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_PARTS: "fleet" })).toThrow(/needs the analytics part/);
		expect(load({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_QUEUE_SECRET_ACCESS_KEY: ADMIN })).toThrow(/not TYPETORCH_API_KEY or TYPETORCH_ADMIN_TOKEN/);
		for (const env of [{ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_QUEUE_ENDPOINT: "ftp://x" }, { TYPETORCH_ROLE: "ingest", ...queueEnv(s3), TYPETORCH_MAIN_URL: "nope" }]) {
			try {
				load(env)();
				throw new Error("expected a refusal");
			} catch (error) {
				expect((error as Error).message).not.toContain(FAKE_SECRET);
				expect((error as Error).message).not.toContain(FAKE_ACCESS_KEY);
			}
		}
		const main = loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), TYPETORCH_ROLE: "main", ...queueEnv(s3) });
		expect(main.queue).toMatchObject({ bucket: "tt-queue", endpoint: s3.endpoint, prefix: "incoming/" });
		const line = describeConfig(main);
		expect(line).toContain("role=main");
		expect(line).not.toContain(FAKE_SECRET);
		expect(line).not.toContain(FAKE_ACCESS_KEY);
		const ingest = loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), TYPETORCH_ROLE: "ingest", ...queueEnv(s3), TYPETORCH_MAIN_URL: "https://main.example.com/", TYPETORCH_INGEST_ROTATE_SECONDS: "2" });
		expect(ingest.mainUrl).toBe("https://main.example.com");
		expect(ingest.ingestRotateSeconds).toBe(2);
	});

	test("a server with queue settings but no role never calls the bucket and has no queue state", async () => {
		const s3 = fakeS3();
		const h = await harness({ ...queueEnv(s3) });
		try {
			expect(h.app.queue).toBeUndefined();
			expect((await h.call("/v1/ingest", post(API, { events: [event("pAll1", T0)] }))).status).toBe(202);
			expect(await h.app.load()).toEqual({ files: 1, rows: 1 });
			expect(await liveCount(h)).toBe(1);
			const stats = await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }));
			expect(stats).not.toHaveProperty("queue");
			expect(await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }))).not.toHaveProperty("queue");
			expect(s3.requests).toEqual([]);
			expect(existsSync(join(h.dir, "raw", "remote"))).toBe(false);
			expect(await h.app.warehouse!.sql("SELECT table_name FROM information_schema.tables WHERE table_name = 'loaded_remote'")).toEqual([]);
			expect(h.logs.join("\n")).not.toMatch(/queue bucket/);
		} finally {
			await h.close();
			s3.stop();
		}
	});
});

describe("an ingest node", () => {
	let s3: FakeS3;
	let h: Harness;
	beforeAll(async () => {
		s3 = fakeS3();
		h = await harness({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_JOB_PER_MINUTE: "1000" });
	});
	afterAll(async () => {
		await h.close();
		s3.stop();
	});
	afterEach(() => {
		now = T0;
	});

	test("answers only its routes: 404 with a hint elsewhere; /v1/auth/check says role game for the game key", async () => {
		const n = await startNode(s3, h.base);
		try {
			for (const [path, method] of [["/", "GET"], ["/v1/fleet/heartbeat", "POST"], ["/v1/query/overview", "POST"], ["/v1/admin/stats", "GET"], ["/v1/errors", "POST"], ["/v1/sql", "POST"], ["/v1/identity", "GET"]] as const) {
				const res = await n.call(path, { method, headers: bearer(ADMIN), ...(method === "POST" ? { body: "{}" } : {}) });
				expect(res.status).toBe(404);
				expect((await asJson(res)).error).toContain("this is an ingest node; the explorer and the fleet API are on the main server");
			}
			const game = await asJson(await n.call("/v1/auth/check", { headers: bearer(API) }));
			expect(game).toMatchObject({ ok: true, role: "game", node: "ingest", service: "typetorch-backend" });
			expect((await n.call("/v1/auth/check")).status).toBe(401);
			expect((await n.call("/v1/auth/check", { headers: bearer("wrong-token-0123456789abcdef0123456789") })).status).toBe(401);
			expect(await asJson(await n.call("/healthz"))).toEqual({ ok: true });
			const health = await asJson(await n.call("/healthz", { headers: bearer(ADMIN) }));
			expect(health).toMatchObject({ ok: true, role: "ingest", state: "ready", queue: { role: "ingest", node: n.node.node } });
			expect(JSON.stringify(health)).not.toContain(FAKE_SECRET);
			expect((await n.call("/v1/ingest", post(undefined, { events: [] }))).status).toBe(401);
			expect((await n.call("/v1/ingest", { method: "GET" })).status).toBe(405);
			// Security headers like a server's.
			expect((await n.call("/healthz")).headers.get("x-content-type-options")).toBe("nosniff");
		} finally {
			await n.node.stop();
		}
	});

	test("accepts, rotates, uploads one Parquet file per table, and deletes its local copy only after the upload", async () => {
		const n = await startNode(s3, h.base);
		try {
			const res = await n.call("/v1/ingest", post(API, { events: [event("pNode1", T0), event("pNode1", T0 + 1)], identities: [{ pid: "pNode1", uid: 4242, t: T0 }] }));
			expect(res.status).toBe(202);
			expect(await asJson(res)).toMatchObject({ accepted: 2, rejected: 0, identities: 1 });
			// Before the rotation: on the node's disk, nothing in the bucket.
			expect(readdirSync(join(n.dir, "raw", "incoming")).length).toBe(2);
			expect(s3.keys()).toEqual([]);
			// The bucket refuses: the batch stays (raw rows written as Parquet, not deleted).
			s3.down = true;
			expect(await n.node.cycle()).toEqual({ uploaded: 0, failed: 1 });
			const spool = join(n.dir, "ingest", "spool");
			expect(readdirSync(spool).length).toBeGreaterThan(0);
			expect(n.node.stats()).toMatchObject({ bucket: "down", pendingFiles: 2 });
			expect(n.node.stats().errors).toBeGreaterThan(0);
			expect(n.node.stats().lastError).not.toContain(FAKE_SECRET);
			s3.down = false;
			expect(await n.node.cycle()).toEqual({ uploaded: 2, failed: 0 });
			expect(readdirSync(spool)).toEqual([]);
			expect(readdirSync(join(n.dir, "raw", "incoming"))).toEqual([]);
			const keys = s3.keys("incoming/");
			expect(keys.length).toBe(2);
			expect(keys.map((k) => parseQueueKey("incoming/", k)?.table).sort()).toEqual(["events", "identities"]);
			for (const key of keys) expect(parseQueueKey("incoming/", key)?.node).toBe(n.node.node);
			expect(n.node.stats()).toMatchObject({ bucket: "ok", files: 2, pendingFiles: 0, lastUploadAt: T0 });
			// No DuckDB warehouse on a node: no live.duckdb, no day files.
			expect(existsSync(join(n.dir, "live.duckdb"))).toBe(false);
			expect(existsSync(join(n.dir, "events"))).toBe(false);

			// The main server loads them with its own raw rows, upserts the identity, then empties the bucket.
			expect((await h.call("/v1/ingest", post(API, { events: [event("pMain1", T0)] }))).status).toBe(202);
			const before = await liveCount(h);
			const loaded = await h.app.load();
			expect(loaded.rows).toBe(3);
			expect(await liveCount(h)).toBe(before + 3);
			expect(await liveCount(h, "pid = 'pNode1'")).toBe(2);
			const rt = await h.app.warehouse!.sql("SELECT DISTINCT rt FROM live.events WHERE pid = 'pNode1'");
			expect(rt).toEqual([{ rt: T0 }]);
			expect(s3.keys("incoming/")).toEqual([]);
			const who = await asJson(await h.call("/v1/identity?pid=pNode1", { headers: bearer(ADMIN) }));
			expect(who.identities[0]).toMatchObject({ pid: "pNode1", uid: 4242 });
			const stats = await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }));
			expect(stats.queue).toMatchObject({ role: "main", bucket: "ok", lastLoadAt: T0, errors: 0 });
			expect(stats.queue.files).toBeGreaterThanOrEqual(1);
			expect(JSON.stringify(stats)).not.toContain(FAKE_SECRET);
		} finally {
			await n.node.stop();
		}
	});

	test("a crash re-uploads: what the last run left (open raw files, batches) goes at the next start, under the same key", async () => {
		const dir = tempDir();
		const first = await startNode(s3, h.base, {}, { dir });
		const id = first.node.node;
		expect((await first.call("/v1/ingest", post(API, { events: [event("pCrash1", T0)] }))).status).toBe(202);
		// The bucket is down at the stop: the batch stays on disk.
		s3.down = true;
		await first.node.stop();
		s3.down = false;
		expect(s3.keys("incoming/events/")).toEqual([]);
		// And a raw file a crash left open (written, never rotated).
		writeFileSync(join(dir, "raw", "incoming", `events-${T0}-777.ndjson.open`), `${JSON.stringify({ ...event("pCrash2", T0), rt: T0 })}\n`);
		const second = await startNode(s3, h.base, {}, { dir });
		try {
			expect(second.node.node).toBe(id);
			expect(await second.node.cycle()).toEqual({ uploaded: 2, failed: 0 });
			expect(s3.keys("incoming/events/").length).toBe(2);
			await h.app.load();
			expect(await liveCount(h, "pid IN ('pCrash1', 'pCrash2')")).toBe(2);
		} finally {
			await second.node.stop();
		}
	});

	test("an upload confirmed but not noted (a crash right after it) goes again under the same key; the main server never doubles it", async () => {
		const real = s3Bucket(loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), TYPETORCH_ROLE: "main", ...queueEnv(s3) }).queue!);
		let crashAfterPut = true;
		const flaky: QueueBucket = {
			...real,
			put: async (key, path) => {
				await real.put(key, path);
				if (crashAfterPut) throw new Error("connection reset after the upload");
			},
		};
		const n = await startNode(s3, h.base, {}, { bucket: flaky });
		try {
			expect((await n.call("/v1/ingest", post(API, { events: [event("pTwice", T0), event("pTwice", T0 + 5)] }))).status).toBe(202);
			expect(await n.node.cycle()).toEqual({ uploaded: 0, failed: 1 });
			const [key] = s3.keys("incoming/events/");
			expect(key).toBeDefined();
			// The main server loads it (and deletes it) meanwhile.
			await h.app.load();
			expect(await liveCount(h, "pid = 'pTwice'")).toBe(2);
			expect(s3.keys("incoming/events/")).toEqual([]);
			// The node uploads the same batch again, same key: the main server only deletes it.
			crashAfterPut = false;
			expect(await n.node.cycle()).toEqual({ uploaded: 1, failed: 0 });
			expect(s3.keys("incoming/events/")).toEqual([key]);
			await h.app.load();
			expect(await liveCount(h, "pid = 'pTwice'")).toBe(2);
			expect(s3.keys("incoming/events/")).toEqual([]);
		} finally {
			await n.node.stop();
		}
	});

	test("busy: the node's backlog not yet uploaded over busyBytes = 503 before the body is read", async () => {
		const n = await startNode(s3, h.base, { TYPETORCH_BUSY_BYTES: "1000", TYPETORCH_JOB_PER_MINUTE: "1000" });
		try {
			s3.down = true;
			const big = Array.from({ length: 30 }, (_, i) => event("pBusyNode", T0 + i));
			expect((await n.call("/v1/ingest", post(API, { events: big }))).status).toBe(202);
			await n.node.cycle();
			expect(n.node.stats().pendingBytes).toBeGreaterThan(1000);
			await new Promise((done) => setTimeout(done, 1100));
			let read = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					read = true;
					controller.enqueue(new TextEncoder().encode("{}"));
					controller.close();
				},
			}, { highWaterMark: 0 });
			const res = await n.call("/v1/ingest", { method: "POST", body, headers: { ...bearer(API), "content-type": "application/json" }, duplex: "half" } as RequestInit);
			expect(res.status).toBe(503);
			expect(await asJson(res)).toMatchObject({ busy: true });
			expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(10);
			expect(read).toBe(false);
			// Identities are never refused this way.
			expect((await n.call("/v1/identity", post(API, { identities: [{ pid: "pBusyNode", uid: 9, t: T0 }] }))).status).toBe(202);
			expect(n.node.busy.view().busy).toBe(1);
			s3.down = false;
			expect((await n.node.cycle()).failed).toBe(0);
			await h.app.load();
		} finally {
			s3.down = false;
			await n.node.stop();
		}
	});
});

describe("erased pids are filtered at both ends", () => {
	let s3: FakeS3;
	let h: Harness;
	beforeAll(async () => {
		s3 = fakeS3();
		h = await harness({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_JOB_PER_MINUTE: "1000" });
	});
	afterAll(async () => {
		await h.close();
		s3.stop();
	});

	test("the node pulls the list each minute and drops erased players' rows; the main server drops them again at load", async () => {
		const dir = tempDir();
		const n = await startNode(s3, h.base, {}, { dir });
		try {
			// A batch the node accepted before the erasure (its list was empty): uploaded with pGone's rows.
			expect((await n.call("/v1/ingest", post(API, { events: [event("pGone", T0), event("pStay", T0)] }))).status).toBe(202);
			expect((await n.node.cycle()).uploaded).toBe(1);
			// The owner erases pGone on the main server.
			expect((await h.call("/v1/erasure", { method: "POST", body: JSON.stringify({ pid: "pGone" }), headers: { ...bearer(ADMIN), "content-type": "application/json" } })).status).toBe(200);
			// The main server filters what the node sent before it knew.
			await h.app.load();
			expect(await liveCount(h, "pid = 'pGone'")).toBe(0);
			expect(await liveCount(h, "pid = 'pStay'")).toBe(1);
			// The node's pull: the list arrives (admin token, the main server's export API).
			expect(await n.node.pullErased()).toBe(true);
			expect(n.node.stats().erased.pids).toBe(1);
			// Now the node drops pGone's identity rows at once and its event rows in the Parquet file.
			const res = await asJson(await n.call("/v1/ingest", post(API, { events: [event("pGone", T0 + 1), event("pStay", T0 + 1)], identities: [{ pid: "pGone", uid: 555, t: T0 }] })));
			expect(res).toMatchObject({ accepted: 2, identities: 0 });
			expect((await n.call("/v1/identity", post(API, { identities: [{ pid: "pGone", uid: 555, t: T0 }] })).then(asJson))).toMatchObject({ accepted: 0 });
			expect((await n.node.cycle()).uploaded).toBe(1);
			expect(s3.keys("incoming/identities/")).toEqual([]);
			await h.app.load();
			expect(await liveCount(h, "pid = 'pGone'")).toBe(0);
			expect(await liveCount(h, "pid = 'pStay'")).toBe(2);
			// The main server down: the node keeps the last list (also across a restart: it is on disk).
			await n.node.stop();
			const offline = await startNode(s3, "http://127.0.0.1:1", {}, { dir });
			try {
				expect(await offline.node.pullErased()).toBe(false);
				expect(offline.node.stats().erased).toMatchObject({ pids: 1, errors: 1 });
				expect(offline.node.stats().erased.lastError).not.toContain(ADMIN);
				expect(await asJson(await offline.call("/v1/ingest", post(API, { events: [event("pGone", T0 + 2)], identities: [{ pid: "pGone", uid: 555, t: T0 }] })))).toMatchObject({ identities: 0 });
			} finally {
				await offline.node.stop();
			}
		} finally {
			await n.node.stop();
		}
	});

	test("a wrong admin token or another origin's redirect never yields a list", async () => {
		const seen: { token: string | null } = { token: null };
		const fake: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.token = new Headers(init?.headers).get("authorization");
			expect(init?.redirect).toBe("manual");
			return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
		}) as typeof fetch;
		const n = await startNode(s3, "https://main.example.com", {}, { fetch: fake });
		try {
			expect(await n.node.pullErased()).toBe(false);
			expect(seen.token).toBe(`Bearer ${ADMIN}`);
			expect(n.node.stats().erased.lastError).toContain("302");
		} finally {
			await n.node.stop();
		}
	});
});

describe("the main server", () => {
	test("a re-load after a crash before the delete doesn't double rows (live or the day file)", async () => {
		const s3 = fakeS3();
		const config = loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), TYPETORCH_ROLE: "main", ...queueEnv(s3) });
		const real = s3Bucket(config.queue!);
		let deletes = 0;
		const failingDelete: QueueBucket = {
			...real,
			remove: async (key) => {
				if (deletes++ === 0) throw new Error("the process died before the delete");
				await real.remove(key);
			},
		};
		const h = await harness({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_JOB_PER_MINUTE: "1000" }, { queue: { bucket: failingDelete } });
		const n = await startNode(s3, h.base);
		try {
			expect((await n.call("/v1/ingest", post(API, { events: [event("pDup", T0), event("pDup", T0 + 10), event("pDup", T0 + 20)] }))).status).toBe(202);
			await n.node.cycle();
			const [key] = s3.keys("incoming/events/");
			const object = s3.objects.get(key) as Uint8Array;
			// Committed, but the delete failed: the key stays in the bucket.
			await h.app.load();
			expect(await liveCount(h, "pid = 'pDup'")).toBe(3);
			expect(s3.keys("incoming/events/")).toEqual([key]);
			// The next tick sees a committed key: deleted, never loaded again.
			await h.app.load();
			expect(await liveCount(h, "pid = 'pDup'")).toBe(3);
			expect(s3.keys("incoming/events/")).toEqual([]);
			// Even a copy under another key (the main server's memory of it gone) only doubles live rows until the export:
			// exact duplicates drop there (same rows, same rt).
			const copyKey = key.replace(/-(\d+)\.parquet$/, (_m, n) => `-${Number(n) + 1}.parquet`);
			s3.objects.set(copyKey, object);
			await h.app.load();
			expect(await liveCount(h, "pid = 'pDup'")).toBe(6);
			h.setNow(T0 + 86_400_000 + 10 * 60_000);
			const nightly = await h.app.nightly();
			expect(nightly.days).toContain("2026-10-09");
			const file = join(h.dir, "events", "2026-10-09.parquet");
			const rows = await h.app.warehouse!.sql(`SELECT COUNT(*) AS n, COUNT(DISTINCT t) AS d FROM read_parquet('${file.replace(/\\/g, "/")}') WHERE pid = 'pDup'`);
			expect(rows[0]).toEqual({ n: 3, d: 3 });
		} finally {
			await n.node.stop();
			await h.close();
			s3.stop();
		}
	});

	test("the bucket down: the server goes on with its own ingest, counts it, and raises one backend alert", async () => {
		const s3 = fakeS3();
		const h = await harness({ TYPETORCH_ROLE: "main", ...queueEnv(s3) }, { queue: { downAfterMs: 0 } });
		try {
			s3.down = true;
			expect((await h.call("/v1/ingest", post(API, { events: [event("pOwn", T0)] }))).status).toBe(202);
			expect((await h.app.load()).rows).toBe(1);
			expect((await h.call("/v1/ingest", post(API, { events: [event("pOwn", T0 + 1)] }))).status).toBe(202);
			expect((await h.app.load()).rows).toBe(1);
			expect(await liveCount(h, "pid = 'pOwn'")).toBe(2);
			const stats = await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }));
			expect(stats.queue).toMatchObject({ role: "main", bucket: "down" });
			expect(stats.queue.errors).toBeGreaterThanOrEqual(2);
			expect(stats.queue.lastError).not.toContain(FAKE_SECRET);
			await new Promise((done) => setTimeout(done, 50));
			const alerts = (await asJson(await h.call("/v1/fleet/alerts", { headers: bearer(ADMIN) }))).alerts as { code: string; level: string; message: string }[];
			const down = alerts.filter((a) => a.code === "queue_bucket_down");
			expect(down.length).toBe(1);
			expect(down[0].level).toBe("critical");
			expect(down[0].message).not.toContain(FAKE_SECRET);
			s3.down = false;
			await h.app.load();
			expect((await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }))).queue.bucket).toBe("ok");
		} finally {
			await h.close();
			s3.stop();
		}
	});

	test("busy counts the bucket backlog it has seen; a file it can't load waits (quarantined) with an alert", async () => {
		const s3 = fakeS3();
		const h = await harness({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_BUSY_BYTES: "1000" });
		try {
			// Not Parquet: the load refuses it; the server's own rows still go in.
			s3.objects.set("incoming/events/abcd1234-1000-1.parquet", new Uint8Array(4096).fill(65));
			// Not a key the queue writes: left alone.
			s3.objects.set("incoming/events/../../etc.parquet", new Uint8Array(10));
			expect((await h.call("/v1/ingest", post(API, { events: [event("pBacklog", T0)] }))).status).toBe(202);
			expect((await h.app.load()).rows).toBe(1);
			expect(await liveCount(h, "pid = 'pBacklog'")).toBe(1);
			expect(s3.keys("incoming/events/abcd")).toEqual(["incoming/events/abcd1234-1000-1.parquet"]);
			expect(s3.objects.has("incoming/events/../../etc.parquet")).toBe(true);
			const stats = await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }));
			expect(stats.queue.pendingBytes).toBeGreaterThanOrEqual(4096);
			await new Promise((done) => setTimeout(done, 1100));
			const res = await h.call("/v1/ingest", post(API, { events: [event("pBacklog", T0 + 1)] }));
			expect(res.status).toBe(503);
			expect((await asJson(res)).error).toMatch(/^busy: the loader is behind/);
			const alerts = (await asJson(await h.call("/v1/fleet/alerts", { headers: bearer(ADMIN) }))).alerts as { code: string }[];
			expect(alerts.some((a) => a.code === "queue_file_bad")).toBe(true);
			// Quarantined: the next tick doesn't try it again (no second download).
			const downloads = s3.requests.filter((r) => r === "GET incoming/events/abcd1234-1000-1.parquet").length;
			await h.app.load();
			expect(s3.requests.filter((r) => r === "GET incoming/events/abcd1234-1000-1.parquet").length).toBe(downloads);
		} finally {
			await h.close();
			s3.stop();
		}
	});
});

describe("several ingest nodes", () => {
	test("two nodes and a main server: every row once, node ids differ", async () => {
		const s3 = fakeS3();
		const h = await harness({ TYPETORCH_ROLE: "main", ...queueEnv(s3), TYPETORCH_JOB_PER_MINUTE: "100000" });
		const a = await startNode(s3, h.base);
		const b = await startNode(s3, h.base);
		try {
			expect(a.node.node).not.toBe(b.node.node);
			for (let i = 0; i < 20; i++) {
				const target = i % 2 ? a : b;
				expect((await target.call("/v1/ingest", post(API, { events: [event(`pMany${i % 5}`, T0 + i)] }))).status).toBe(202);
			}
			await Promise.all([a.node.cycle(), b.node.cycle()]);
			await h.app.load();
			expect(await liveCount(h, "pid LIKE 'pMany%'")).toBe(20);
		} finally {
			await a.node.stop();
			await b.node.stop();
			await h.close();
			s3.stop();
		}
	});
});

test("one node per data folder: a rolling deploy's new node waits for the folder (503 meanwhile, /healthz 200)", async () => {
	const s3 = fakeS3();
	const dir = tempDir();
	// DuckDB's file locks are per process on Linux: the other holder is a real process (as in handover.test.ts).
	const holder = Bun.spawn(["bun", join(import.meta.dir, "hold-duckdb.ts"), dir], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const reader = holder.stdout.getReader();
	let out = "";
	while (!out.includes("held")) out += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
	const n = await startNode(s3, "http://127.0.0.1:1", {}, { dir, handoverRetryMs: 50 });
	try {
		expect(n.node.state).toBe("handover");
		expect((await n.call("/healthz")).status).toBe(200);
		const refused = await n.call("/v1/ingest", post(API, { events: [event("pTwin", T0)] }));
		expect(refused.status).toBe(503);
		expect(refused.headers.get("retry-after")).toBe("5");
		holder.stdin.write("release\n");
		holder.stdin.flush();
		await holder.exited;
		for (let i = 0; i < 200 && n.node.state !== "ready"; i++) await new Promise((done) => setTimeout(done, 25));
		expect(n.node.state).toBe("ready");
		expect(n.node.node).toMatch(/^[a-z0-9]{12}$/);
		expect((await n.call("/v1/ingest", post(API, { events: [event("pTwin", T0)] }))).status).toBe(202);
	} finally {
		holder.kill();
		await n.node.stop();
		s3.stop();
	}
});

// The fake's own sanity: multipart uploads (Bun splits big files) land whole.
test("the fake S3 server takes a multipart upload", async () => {
	const s3 = fakeS3();
	try {
		const bucket = s3Bucket(loadConfig([], { ...BASE_ENV, TYPETORCH_DATA_DIR: tempDir(), TYPETORCH_ROLE: "main", ...queueEnv(s3) }).queue!);
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "big.bin");
		const data = new Uint8Array(12 * 1024 * 1024).map((_, i) => i % 251);
		writeFileSync(path, data);
		await bucket.put("incoming/events/abcd1234-1-1.parquet", path);
		expect(s3.objects.get("incoming/events/abcd1234-1-1.parquet")?.length).toBe(data.length);
		const back = join(dir, "back.bin");
		expect(await bucket.download("incoming/events/abcd1234-1-1.parquet", back)).toBe(data.length);
		expect((await bucket.list("incoming/", 10)).objects).toEqual([{ key: "incoming/events/abcd1234-1-1.parquet", size: data.length }]);
	} finally {
		s3.stop();
	}
});
