/**
 * Plans/35 D: the busy 503 on POST /v1/ingest (raw backlog, requests in flight), answered before the body is read; the
 * fleet, error and identity routes are never refused this way; 0 turns a limit off; the counters in /v1/admin/stats.
 * Plus the export API's door (plans/35 A): the admin token as a Bearer only. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { IngestBusy } from "../src/server/busy.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, post, type Harness } from "./harness.ts";

const XT = { "x-typetorch": "1" };

/** An ingest request whose body records whether anything read it (and, with `hold`, waits until released). */
function watchedIngest(hold?: Promise<void>): { req: RequestInit; read: () => boolean } {
	let read = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			read = true;
			if (hold) await hold;
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ events: [] })));
			controller.close();
		},
	}, { highWaterMark: 0 });
	return { req: { method: "POST", body, headers: { ...bearer(API), "content-type": "application/json" }, duplex: "half" } as RequestInit, read: () => read };
}

const event = (t: number) => ({ v: 1, t, kind: "economy", name: "busy_test", sid: "s-busy-1", pid: "pBusy1", job: "job-busy-1", art: "art-1", src: "server" });

describe("the busy 503", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_BUSY_BYTES: "1000", TYPETORCH_BUSY_REQUESTS: "0", TYPETORCH_JOB_PER_MINUTE: "1000" });
	});
	afterAll(() => h.close());
	const patch = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", ...json(body), headers: { ...bearer(ADMIN), "content-type": "application/json" } });

	test("a raw backlog over busyBytes: 503 + Retry-After 10-30 before the body is read; other game routes go on", async () => {
		// The loader is behind: 2 KB waiting in raw/incoming (the limit is 1000 bytes).
		writeFileSync(join(h.dir, "raw", "incoming", `events-${T0}-999.ndjson`), `${JSON.stringify(event(T0))}\n`.repeat(40));
		const watched = watchedIngest();
		const res = await h.call("/v1/ingest", watched.req);
		expect(res.status).toBe(503);
		const body = await asJson(res);
		expect(body.busy).toBe(true);
		expect(body.error).toMatch(/^busy: the loader is behind/);
		const after = Number(res.headers.get("retry-after"));
		expect(after).toBeGreaterThanOrEqual(10);
		expect(after).toBeLessThanOrEqual(30);
		expect(watched.read()).toBe(false);
		// A wrong key is still a 401, not a busy answer (the key is checked first).
		expect((await h.call("/v1/ingest", { method: "POST", body: "{}", headers: { ...bearer("wrong-key-0123456789abcdef0123456789") } })).status).toBe(401);
		// Heartbeats, error logs and identities are never refused this way.
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: "job-busy-1", t: "public", b: "prod", c: "prod", a: "art-1", n: 1, m: 10, s: Math.floor(T0 / 1000) - 60, u: Math.floor(T0 / 1000), p: 1, v: "0.3.2", q: 1, g: 1, h: "ok", sv: 2 }))).status).toBeLessThan(300);
		const errors = await h.call("/v1/errors", post(API, { v: 1, j: "job-busy-1", errors: [{ fp: "fp-busy", template: "boom", count: 1, firstAt: T0, lastAt: T0, branch: "prod", build: "b1", realm: "server", pids: [] }] }));
		expect(errors.status).toBe(202);
		expect((await h.call("/v1/identity", post(API, { identities: [{ pid: "pBusy1", uid: 77, t: T0 }] }))).status).toBeLessThan(300);
	});

	test("0 turns the backlog limit off (a runtime setting, group limits)", async () => {
		const view = await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }));
		const setting = (view.settings as { key: string; group: string; value: number; zero?: string }[]).find((s) => s.key === "busyBytes");
		expect(setting).toMatchObject({ group: "limits", value: 1000, zero: "off" });
		expect((await patch({ busyBytes: 0 })).status).toBe(200);
		const res = await h.call("/v1/ingest", post(API, { events: [event(T0)] }));
		expect(res.status).toBe(202);
	});

	test("more than busyRequests ingest requests in flight: 503; the fleet routes still answer", async () => {
		expect((await patch({ busyRequests: 1 })).status).toBe(200);
		let release!: () => void;
		const hold = new Promise<void>((done) => (release = done));
		const first = watchedIngest(hold);
		const pending = h.call("/v1/ingest", first.req);
		// The first one is inside (reading its body, which waits).
		for (let i = 0; i < 50 && !first.read(); i++) await new Promise((done) => setTimeout(done, 10));
		expect(first.read()).toBe(true);
		const second = watchedIngest();
		const refused = await h.call("/v1/ingest", second.req);
		expect(refused.status).toBe(503);
		expect((await asJson(refused)).error).toMatch(/in flight/);
		expect(second.read()).toBe(false);
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: "job-busy-2", t: "public", b: "prod", c: "prod", a: "art-1", n: 1, m: 10, s: Math.floor(T0 / 1000) - 60, u: Math.floor(T0 / 1000), p: 1, v: "0.3.2", q: 1, g: 1, h: "ok", sv: 2 }))).status).toBeLessThan(300);
		const stats = await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }));
		expect(stats.ingest).toMatchObject({ inflight: 1, lastBusyAt: T0 });
		expect(stats.ingest.busy).toBeGreaterThanOrEqual(2);
		release();
		expect((await pending).status).toBe(202);
		expect((await h.call("/v1/ingest", post(API, { events: [event(T0 + 1)] }))).status).toBe(202);
		expect((await patch({ busyRequests: 0 })).status).toBe(200);
		expect((await asJson(await h.call("/v1/admin/stats?window=1m", { headers: bearer(ADMIN) }))).ingest.inflight).toBe(0);
	});

	test("the settings refuse values out of bounds", async () => {
		expect((await patch({ busyRequests: -1 })).status).toBe(400);
		expect((await patch({ busyBytes: 10 })).status).toBe(400);
	});
});

describe("IngestBusy", () => {
	test("Retry-After stays within 10-30 s whatever the jitter; the backlog is measured at most once a second", () => {
		let measured = 0;
		for (const r of [0, 0.5, 0.9999]) {
			const busy = new IngestBusy({ maxBytes: () => 1, maxRequests: () => 0, pendingBytes: () => (measured++, 10), random: () => r });
			const refused = busy.check();
			expect(refused?.retryAfter).toBeGreaterThanOrEqual(10);
			expect(refused?.retryAfter).toBeLessThanOrEqual(30);
			busy.check();
		}
		expect(measured).toBe(3);
		const off = new IngestBusy({ maxBytes: () => 0, maxRequests: () => 0, pendingBytes: () => 1e12 });
		expect(off.check()).toBeUndefined();
		expect(off.view()).toEqual({ busy: 0, inflight: 0, lastBusyAt: null });
	});
});

describe("the export API's door", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: "4004" });
	});
	afterAll(() => h.close());

	test("admin token as a Bearer only: the game key, the web role, a browser session and anonymous callers are refused", async () => {
		const routes = ["/v1/admin/export/manifest", "/v1/admin/export/erased", "/v1/admin/export/fleet?table=deploys", "/v1/admin/export/rows?table=events&day=2026-10-09", "/v1/admin/export/hash?table=events&day=2026-10-09"];
		const web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 4004, name: "Viewer" }, "web")}` };
		const owner = { cookie: `tt_session=${h.app.sessions.create({ kind: "token" }, "admin")}` };
		for (const route of routes) {
			expect((await h.call(route, { headers: bearer(ADMIN) })).status).toBe(200);
			expect((await h.call(route, { headers: bearer(API) })).status).toBe(401);
			expect((await h.call(route)).status).toBe(401);
			expect((await h.call(route, { headers: web })).status).toBe(403);
			expect((await h.call(route, { headers: { ...owner, ...XT } })).status).toBe(403);
		}
		// The migration job: admin (the web role reads nothing of it).
		expect((await h.call("/v1/admin/migrate", { headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/v1/admin/migrate", { headers: web })).status).toBe(403);
		expect((await h.call("/v1/admin/migrate", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/admin/migrate", { method: "POST", ...json({ action: "pause" }), headers: { ...web, ...XT, "content-type": "application/json" } })).status).toBe(403);
	});

	test("a named API key, even an admin one, can't export or run the migration (the env admin token only)", async () => {
		const made = await asJson(await h.call("/v1/admin/keys", { method: "POST", headers: { ...bearer(ADMIN), "content-type": "application/json" }, body: JSON.stringify({ name: "ops-admin", role: "admin" }) }));
		const key = String(made.key);
		expect(key.startsWith("ttk_")).toBe(true);
		for (const route of ["/v1/admin/export/manifest", "/v1/admin/export/erased", "/v1/admin/export/rows?table=events&day=2026-10-09"]) {
			expect((await h.call(route, { headers: bearer(key) })).status).toBe(403);
		}
		expect((await h.call("/v1/admin/migrate", { headers: bearer(key) })).status).toBe(200);
		expect((await h.call("/v1/admin/migrate", { method: "POST", headers: { ...bearer(key), "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) })).status).toBe(403);
	});

	test("the manifest's shape on an empty server; bad parameters are 400; unknown routes 404", async () => {
		const m = await asJson(await h.call("/v1/admin/export/manifest", { headers: bearer(ADMIN) }));
		expect(m).toMatchObject({ version: 1, server: { now: T0 }, tables: { events: [], recordings: [] }, live: { day: null, rows: 0, lastRt: null }, erased: 0 });
		expect(typeof m.server.instance).toBe("string");
		expect(m.fleet.deploys).toEqual({ rows: 0, maxId: null });
		expect(m.fleet.error_counts).toEqual({ rows: 0, maxId: null });
		expect((await h.call("/v1/admin/export/rows?table=nope&day=2026-10-09", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/admin/export/rows?table=events&day=10/09/2026", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/admin/export/rows?table=events&day=2026-10-09&size=50001", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/admin/export/fleet?table=api_keys", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/admin/export/hash?table=events&day=2026-10-09&exclude=bad%20pid", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/admin/export/nope", { headers: bearer(ADMIN) })).status).toBe(404);
		const empty = await h.call("/v1/admin/export/rows?table=events&day=2026-10-09", { headers: bearer(ADMIN) });
		expect(empty.headers.get("x-typetorch-rows")).toBe("0");
		expect(empty.headers.get("x-typetorch-last-page")).toBe("1");
	});

	test("POST /v1/admin/migrate: bad bodies 400 (Basin directions too); nothing to pause or resolve is 409; the token is never echoed", async () => {
		const call = (body: unknown) => h.call("/v1/admin/migrate", { method: "POST", ...json(body), headers: { ...bearer(ADMIN), "content-type": "application/json" } });
		const basin = await call({ action: "start", from: { kind: "basin", accountId: "a", bucket: "b", token: "t".repeat(40), namespace: "typetorch" } });
		expect(basin.status).toBe(400);
		expect(JSON.stringify(await asJson(basin))).not.toContain("t".repeat(40));
		expect((await call({ action: "start", from: { kind: "basin", accountId: "0".repeat(32), bucket: "typetorch-analytics", token: "t".repeat(40), namespace: "bad-name" } })).status).toBe(400);
		expect((await call({ action: "start", to: { kind: "basin", events: "http://x.ingest.cloudflare.com", recordings: "https://y", token: "t".repeat(40) } })).status).toBe(400);
		expect((await call({ action: "start", to: { kind: "basin", events: "https://x.ingest.cloudflare.com", recordings: "https://y", token: "short" } })).status).toBe(400);
		expect((await call({ action: "start", from: { kind: "backend", url: "https://old.example.com", token: ADMIN }, to: { kind: "basin" } })).status).toBe(400);
		expect((await call({ action: "resolve", page: "events:2026-10-09:0:0", choice: "skip" })).status).toBe(409);
		expect((await call({ action: "start", from: { kind: "backend", url: "http://old.example.com", token: ADMIN } })).status).toBe(400);
		expect((await call({ action: "start", from: { kind: "backend", url: "https://old.example.com", token: "short" } })).status).toBe(400);
		expect((await call({ action: "pause" })).status).toBe(409);
		expect((await call({ action: "fly" })).status).toBe(400);
		const status = await asJson(await h.call("/v1/admin/migrate", { headers: bearer(ADMIN) }));
		expect(status).toMatchObject({ state: "idle", direction: null, steps: expect.any(Array), days: [], decision: null, error: null });
		expect(JSON.stringify(status)).not.toContain(ADMIN);
	});
});
