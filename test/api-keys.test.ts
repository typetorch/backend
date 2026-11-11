/**
 * Plans/31: named API keys with roles, and the per-player support endpoints, through the whole app (test/harness.ts):
 * create / list / revoke / expiry / hash-only storage, scope enforcement (a support key walked over every documented
 * route), the env tokens unchanged, the per-key rate limit, GET /v1/players/by-uid/<uid>/events and /summary, the audit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KeyStore, ROLE_SCOPES, scopeOf } from "../src/server/keys.ts";
import { openApiSpec } from "../src/server/openapi.ts";
import { ADMIN, API, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const DAY = 86_400_000;
const json = (method: string, token: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json", ...bearer(token) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

describe("named API keys", () => {
	let h: Harness;
	const made: Record<string, { id: string; key: string }> = {};
	beforeAll(async () => {
		h = await harness();
		for (const role of ["game", "lookup", "support", "analyst", "admin"]) {
			const r = await h.call("/v1/admin/keys", json("POST", ADMIN, { name: `${role}-key`, role }));
			expect(r.status).toBe(201);
			const body = await asJson(r);
			made[role] = { id: body.id, key: body.key };
		}
	});
	afterAll(() => h.close());

	test("create: the key once, ttk_<id>_<secret>, the role's scopes; bad input refused", async () => {
		const r = await asJson(await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "bot.one", role: "support", expiresDays: 365 })));
		expect(r.key).toMatch(/^ttk_[0-9a-z]{10}_[A-Za-z0-9_-]{43}$/);
		expect(r.key.startsWith(`ttk_${r.id}_`)).toBe(true);
		expect(r).toMatchObject({ name: "bot.one", role: "support", scopes: ["identity:resolve", "players:read"] });
		expect(Date.parse(r.expiresAt) - Date.parse(r.createdAt)).toBe(365 * DAY);
		expect((await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "bot.one", role: "support" }))).status).toBe(409);
		expect((await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "Bad Name", role: "support" }))).status).toBe(400);
		expect((await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "x", role: "root" }))).status).toBe(400);
		expect((await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "y", role: "support", expiresDays: 4000 }))).status).toBe(400);
		expect((await h.call("/v1/admin/keys", json("POST", API, { name: "z", role: "admin" }))).status).toBe(401);
	});

	test("storage: the SHA-256 hash only, never the secret; the list shows no hash; the audit never the key", async () => {
		const { Database } = (await import("bun:sqlite")) as { Database: new (path: string, o?: object) => { query(sql: string): { all(): Record<string, unknown>[] }; close(): void } };
		const db = new Database(join(h.dir, "fleet.sqlite"), { readonly: true });
		const rows = db.query("SELECT * FROM api_keys").all();
		db.close();
		const text = JSON.stringify(rows);
		for (const { key } of Object.values(made)) expect(text).not.toContain(key.slice("ttk_".length + 10 + 1)); // the whole secret (base64url may hold "_")
		const support = rows.find((r) => r.id === made.support.id);
		expect(support?.hash).toBe(new Bun.CryptoHasher("sha256").update(made.support.key).digest("hex"));
		const list = await asJson(await h.call("/v1/admin/keys", { headers: bearer(ADMIN) }));
		expect(JSON.stringify(list)).not.toContain("hash");
		for (const { key } of Object.values(made)) expect(JSON.stringify(list)).not.toContain(key);
		const audit = await asJson(await h.call("/v1/admin/audit?action=keys.create", { headers: bearer(ADMIN) }));
		expect(audit.entries.length).toBeGreaterThanOrEqual(5);
		for (const { key } of Object.values(made)) expect(JSON.stringify(audit)).not.toContain(key);
		expect(h.logs.join("\n")).not.toContain(made.admin.key);
	});

	test("the env tokens are listed as built-in keys, not revocable; they work as before", async () => {
		const list = (await asJson(await h.call("/v1/admin/keys", { headers: bearer(ADMIN) }))).keys as { id: string; role: string; builtIn: boolean }[];
		expect(list.filter((k) => k.builtIn).map((k) => [k.id, k.role])).toEqual([
			["env:api", "game"],
			["env:admin", "admin"],
		]);
		expect((await h.call("/v1/admin/keys/env:admin", json("DELETE", ADMIN))).status).toBe(400);
		expect((await h.call("/v1/ingest", post(API, { events: [] }))).status).toBe(202);
		expect((await h.call("/v1/admin/settings", { headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/v1/admin/settings", { headers: bearer(API) })).status).toBe(401);
	});

	test("roles: each key reaches its scopes; outside them 403 { error: forbidden, need }", async () => {
		const call = (role: string, path: string, init: RequestInit = {}) => h.call(path, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), ...bearer(made[role].key) } });
		// game
		expect((await call("game", "/v1/ingest", post(made.game.key, { events: [] }))).status).toBe(202);
		expect(await asJson(await call("game", "/v1/query/overview", post(made.game.key, {})))).toEqual({ error: "forbidden", need: "analytics:query" });
		// lookup / support: identity resolve
		for (const role of ["lookup", "support"]) expect((await call(role, "/v1/identity/resolve?uid=1")).status).toBe(200);
		expect(await asJson(await call("lookup", "/v1/players/by-uid/1/events"))).toEqual({ error: "forbidden", need: "players:read" });
		// analyst: queries and SQL, nothing else
		expect((await call("analyst", "/v1/query/overview", post(made.analyst.key, {}))).status).toBe(200);
		expect((await call("analyst", "/v1/sql", post(made.analyst.key, { sql: "SELECT 1" }))).status).toBe(200);
		expect(await asJson(await call("analyst", "/v1/admin/settings"))).toEqual({ error: "forbidden", need: "admin" });
		expect(await asJson(await call("analyst", "/v1/admin/settings", json("PATCH", made.analyst.key, { ipPerMinute: 8000 })))).toEqual({ error: "forbidden", need: "settings:write" });
		// admin: everything
		expect((await call("admin", "/v1/admin/settings")).status).toBe(200);
		expect((await call("admin", "/v1/admin/keys")).status).toBe(200);
		expect((await call("admin", "/v1/ingest", post(made.admin.key, { events: [] }))).status).toBe(202);
		// auth check names the key
		expect(await asJson(await call("support", "/v1/auth/check"))).toMatchObject({ ok: true, role: "support", key: { id: made.support.id, name: "support-key" } });
		expect(await asJson(await call("analyst", "/v1/auth/check"))).toMatchObject({ ok: true, key: { role: "analyst" }, scopes: ROLE_SCOPES.analyst });
	});

	test("a support key reaches no admin route: every documented route outside its scopes answers 403", async () => {
		const spec = openApiSpec() as { paths: Record<string, Record<string, unknown>> };
		const extra: [string, string][] = [
			["GET", "/v1/admin/keys"],
			["POST", "/v1/admin/keys"],
			["DELETE", "/v1/admin/keys/abcdefghij"],
			["GET", "/v1/notify/config"],
			["PUT", "/v1/notify/config"],
			["GET", "/v1/admin/backups"],
			["POST", "/v1/admin/backups/download"],
			["GET", "/v1/players/p0001/errors"],
			["GET", "/"],
		];
		const routes: [string, string][] = [...Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m): [string, string] => [m.toUpperCase(), p.replace(/\{[^}]+\}/g, "x1")])), ...extra];
		expect(routes.length).toBeGreaterThan(60);
		const allowed = ROLE_SCOPES.support;
		let checked = 0;
		for (const [method, path] of routes) {
			if (path === "/healthz" || path === "/v1/auth/check") continue;
			const need = scopeOf(method, path);
			const res = await h.call(path, { method, headers: { ...bearer(made.support.key), "content-type": "application/json" }, ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }) });
			if (allowed.includes(need)) continue;
			expect([method, path, res.status, need]).toEqual([method, path, 403, need]);
			checked++;
		}
		expect(checked).toBeGreaterThan(50);
	});

	test("revoke: the key stops (401); expired keys stop; ?all=1 lists revoked ones", async () => {
		const r = await asJson(await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "short-lived", role: "lookup", expiresDays: 1 })));
		expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer(r.key) })).status).toBe(200);
		const t0 = h.now();
		h.setNow(t0 + DAY + 1);
		expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer(r.key) })).status).toBe(401);
		h.setNow(t0);
		const gone = await asJson(await h.call(`/v1/admin/keys/${r.id}`, json("DELETE", ADMIN)));
		expect(gone).toMatchObject({ ok: true, id: r.id });
		expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer(r.key) })).status).toBe(401);
		const active = (await asJson(await h.call("/v1/admin/keys", { headers: bearer(ADMIN) }))).keys as { id: string }[];
		expect(active.some((k) => k.id === r.id)).toBe(false);
		const all = (await asJson(await h.call("/v1/admin/keys?all=1", { headers: bearer(ADMIN) }))).keys as { id: string; revokedAt: string | null }[];
		expect(all.find((k) => k.id === r.id)?.revokedAt).toBeTruthy();
		// The name is free again once revoked.
		expect((await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "short-lived", role: "lookup" }))).status).toBe(201);
		expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer("ttk_zzzzzzzzzz_" + "A".repeat(43)) })).status).toBe(401);
		expect((await h.call("/v1/admin/keys/zzzzzzzzzz", json("DELETE", ADMIN))).status).toBe(404);
	});

	test("KeyStore.looksLikeKey and scopeOf", () => {
		expect(KeyStore.looksLikeKey("ttk_x")).toBe(true);
		expect(KeyStore.looksLikeKey(API)).toBe(false);
		expect(scopeOf("POST", "/v1/fleet/heartbeat")).toBe("ingest:write");
		expect(scopeOf("GET", "/v1/fleet/commands")).toBe("ingest:write");
		expect(scopeOf("POST", "/v1/notify/opened")).toBe("ingest:write");
		expect(scopeOf("GET", "/v1/fleet/servers")).toBe("admin");
		expect(scopeOf("GET", "/v1/players/by-uid/1/summary")).toBe("players:read");
	});

	test("the per-key rate limit: keys.ratePerMinute, then 429 { error: rate_limited } with Retry-After", async () => {
		expect((await h.call("/v1/admin/settings", json("PATCH", ADMIN, { "keys.ratePerMinute": 3 }))).status).toBe(200);
		const r = await asJson(await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "limited", role: "lookup" })));
		for (let i = 0; i < 3; i++) expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer(r.key) })).status).toBe(200);
		const over = await h.call("/v1/identity/resolve?uid=1", { headers: bearer(r.key) });
		expect(over.status).toBe(429);
		expect(await asJson(over)).toEqual({ error: "rate_limited" });
		expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
		// The env admin token is not limited by it.
		for (let i = 0; i < 5; i++) expect((await h.call("/v1/admin/keys", { headers: bearer(ADMIN) })).status).toBe(200);
		await h.call("/v1/admin/settings", json("PATCH", ADMIN, { "keys.ratePerMinute": null }));
	});
});

describe("per-player support endpoints", () => {
	let h: Harness;
	let support = "";
	let admin = "";
	const UID = 555_123_456;
	beforeAll(async () => {
		h = await harness();
		support = (await asJson(await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "standard-bot", role: "support", expiresDays: 365 })))).key;
		admin = (await asJson(await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "ops", role: "admin" })))).key;
		const t = h.now();
		const row = (pid: string, sid: string, dt: number, kind: string, name: string, props?: object) => ({ v: 1, t: t - dt, kind, name, pid, sid, job: "job-7", art: "a1", src: "server", ...(props ? { props: JSON.stringify(props) } : {}) });
		const res = await h.call(
			"/v1/ingest",
			post(API, {
				events: [
					row("pid-a", "s1", 50 * 60_000, "session", "join", { from: "direct" }),
					row("pid-a", "s1", 40 * 60_000, "custom", "ac_flag", { cat: "speed", v: 42.1 }),
					row("pid-a", "s1", 39 * 60_000, "custom", "ac_flag", { cat: "speed", v: 50 }),
					row("pid-a", "s1", 38 * 60_000, "custom", "ac_action", { act: "kick" }),
					row("pid-a", "s1", 30 * 60_000, "session", "leave", { secs: 1200 }),
					row("pid-b", "s2", 20 * 60_000, "session", "join", { from: "share" }),
					row("pid-b", "s2", 10 * 60_000, "custom", "ac_flag", { cat: "fly" }),
					row("pid-b", "s2", 9 * 60_000, "custom", "secret_event", { x: 1 }),
					row("pid-b", "s2", 40 * DAY, "custom", "ac_flag", { cat: "old" }),
					row("pid-z", "s9", 5 * 60_000, "custom", "ac_flag", { cat: "someone_else" }),
				],
				identities: [
					{ pid: "pid-a", uid: UID, t: t - DAY },
					{ pid: "pid-b", uid: UID, t: t - 1000 },
					{ pid: "pid-z", uid: 999, t },
				],
			}),
		);
		expect(res.status).toBe(202);
		await h.app.load();
	});
	afterAll(() => h.close());

	const get = (path: string, token = support) => h.call(path, { headers: bearer(token) });

	test("events: the allow-list's rows for every pid, newest first, props as objects", async () => {
		const r = await asJson(await get(`/v1/players/by-uid/${UID}/events`));
		expect(r.uid).toBe(UID);
		expect(r.known).toBe(true);
		expect([...r.pids].sort()).toEqual(["pid-a", "pid-b"]);
		expect(r.rows.map((x: { name: string; pid: string }) => `${x.name}/${x.pid}`)).toEqual(["ac_flag/pid-b", "join/pid-b", "leave/pid-a", "ac_action/pid-a", "ac_flag/pid-a", "ac_flag/pid-a", "join/pid-a"]);
		expect(r.rows[0]).toEqual({ t: expect.any(Number), name: "ac_flag", kind: "custom", pid: "pid-b", job: "job-7", props: { cat: "fly" } });
		expect(r.rows[2]).toMatchObject({ name: "leave", kind: "session", props: { secs: 1200 } });
		expect(r.more).toBe(false);
	});

	test("names, limit, since / before", async () => {
		const flags = await asJson(await get(`/v1/players/by-uid/${UID}/events?names=ac_flag&limit=2`));
		expect(flags.rows.map((x: { props: { cat: string } }) => x.props.cat)).toEqual(["fly", "speed"]);
		expect(flags.more).toBe(true);
		const t = h.now();
		const window = await asJson(await get(`/v1/players/by-uid/${UID}/events?names=ac_flag,join&since=${t - 45 * 60_000}&before=${t - 15 * 60_000}`));
		expect(window.rows.map((x: { name: string }) => x.name)).toEqual(["join", "ac_flag", "ac_flag"]);
		const old = await asJson(await get(`/v1/players/by-uid/${UID}/events?names=ac_flag&since=${t - 41 * DAY}&before=${t - 39 * DAY}`));
		expect(old.rows.map((x: { props: { cat: string } }) => x.props.cat)).toEqual(["old"]);
		expect((await get(`/v1/players/by-uid/${UID}/events?limit=101`)).status).toBe(400);
		expect((await get(`/v1/players/by-uid/${UID}/events?since=abc`)).status).toBe(400);
		expect((await get("/v1/players/by-uid/abc/events")).status).toBe(400);
	});

	test("a name outside the allow-list: 403 for support, read for an admin", async () => {
		expect(await asJson(await get(`/v1/players/by-uid/${UID}/events?names=ac_flag,secret_event`))).toEqual({ error: "event_not_allowed", name: "secret_event" });
		const r = await asJson(await get(`/v1/players/by-uid/${UID}/events?names=secret_event`, admin));
		expect(r.rows).toEqual([{ t: expect.any(Number), name: "secret_event", kind: "custom", pid: "pid-b", job: "job-7", props: { x: 1 } }]);
		expect((await get(`/v1/players/by-uid/${UID}/events?names=secret_event`, ADMIN)).status).toBe(200);
	});

	test("an unknown UserId: known false, nothing else", async () => {
		expect(await asJson(await get("/v1/players/by-uid/42/events"))).toEqual({ uid: 42, known: false, pids: [], rows: [], more: false });
		expect(await asJson(await get("/v1/players/by-uid/42/summary"))).toMatchObject({ uid: 42, known: false, pids: [], sessions: 0, lastSeen: null });
	});

	test("summary: counts per allow-listed name (0 when none), ac_flag by category, sessions, last seen", async () => {
		const r = await asJson(await get(`/v1/players/by-uid/${UID}/summary`));
		expect(r).toMatchObject({ uid: UID, known: true, byName: { ac_flag: 3, ac_action: 1, ac_honeypot: 0, join: 2, leave: 1 }, byCategory: { speed: 2, fly: 1 }, sessions: 2 });
		expect(r.lastSeen).toBe(h.now() - 9 * 60_000);
		expect(r.since).toBe(h.now() - 30 * DAY);
		const all = await asJson(await get(`/v1/players/by-uid/${UID}/summary?since=${h.now() - 60 * DAY}`));
		expect(all.byCategory).toEqual({ speed: 2, fly: 1, old: 1 });
	});

	test("who may call: support and admin keys, an admin; not the game key, an analyst key or a viewer", async () => {
		const analyst = (await asJson(await h.call("/v1/admin/keys", json("POST", ADMIN, { name: "analyst", role: "analyst" })))).key;
		expect(await asJson(await get(`/v1/players/by-uid/${UID}/events`, analyst))).toEqual({ error: "forbidden", need: "players:read" });
		expect((await get(`/v1/players/by-uid/${UID}/events`, API)).status).toBe(401);
		expect((await h.call(`/v1/players/by-uid/${UID}/events`)).status).toBe(401);
	});

	test("the audit: one players.read row per call with the key, route template and status; never the UserId", async () => {
		const audit = await asJson(await h.call("/v1/admin/audit?action=players.read&limit=200", { headers: bearer(ADMIN) }));
		const entries = audit.entries as { actor: { kind: string; label: string }; status: number; ip: string; details: Record<string, unknown> }[];
		expect(entries.length).toBeGreaterThanOrEqual(10);
		const forbidden = entries.find((e) => e.status === 403);
		expect(forbidden?.details).toMatchObject({ route: "/v1/players/by-uid/:uid/events", keyName: "standard-bot", keyRole: "support" });
		expect(entries.some((e) => e.details.route === "/v1/players/by-uid/:uid/summary" && e.status === 200 && e.details.pids === 2)).toBe(true);
		expect(entries[0]?.ip).toBe("127.0.0.1");
		expect(JSON.stringify(audit)).not.toContain(String(UID));
	});
});
