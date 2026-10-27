/**
 * GET /v1/identity/resolve: pid <-> UserId in bulk for the admin role and the lookup token (TYPETORCH_LOOKUP_TOKEN), the
 * token that reaches nothing else. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const LOOKUP = "lookup-token-for-tests-0123456789abcdef0";
const VIEWER = 4004;

describe("GET /v1/identity/resolve", () => {
	let h: Harness;
	const resolve = (query: string, token = LOOKUP, ip?: string) => h.call(`/v1/identity/resolve?${query}`, { headers: bearer(token), ...(ip ? { ip } : {}) });

	beforeAll(async () => {
		h = await harness({ TYPETORCH_LOOKUP_TOKEN: LOOKUP, TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		const rows = [
			{ pid: "pidA", uid: 1001, t: T0 },
			{ pid: "pidB", uid: 1001, t: T0 + 1000 },
			{ pid: "pidC", uid: 2002, t: T0 },
		];
		expect((await h.call("/v1/identity", post(API, { identities: rows }))).status).toBe(202);
	});
	afterAll(() => h.close());

	test("the config: optional, 32+ characters, different from the other keys", () => {
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off" };
		expect(loadConfig([], base).lookupToken).toBeUndefined();
		expect(loadConfig([], { ...base, TYPETORCH_LOOKUP_TOKEN: LOOKUP }).lookupToken).toBe(LOOKUP);
		expect(() => loadConfig([], { ...base, TYPETORCH_LOOKUP_TOKEN: "short" })).toThrow(/at least 32/);
		expect(() => loadConfig([], { ...base, TYPETORCH_LOOKUP_TOKEN: ADMIN })).toThrow(/must differ/);
		expect(() => loadConfig([], { ...base, TYPETORCH_LOOKUP_TOKEN: API })).toThrow(/must differ/);
	});

	test("pid -> UserId and UserId -> pids, unknown ones as null / empty, in the order asked", async () => {
		const res = await resolve("pid=pidA,pidC,nobody&uid=1001&uid=9999");
		expect(res.status).toBe(200);
		expect(await asJson(res)).toEqual({
			byPid: [
				{ pid: "pidA", uid: 1001 },
				{ pid: "pidC", uid: 2002 },
				{ pid: "nobody", uid: null },
			],
			byUid: [
				{ uid: 1001, pids: ["pidB", "pidA"] },
				{ uid: 9999, pids: [] },
			],
		});
		// Counts are logged, never the ids.
		const line = h.logs.find((l) => l.startsWith("identity resolve:"));
		expect(line).toBe("identity resolve: 3 pid(s), 2 UserId(s) by lookup token from 127.0.0.1");
	});

	test("the admin token works too; the web role, the API key and no token don't", async () => {
		expect(await asJson(await resolve("uid=2002", ADMIN))).toEqual({ byPid: [], byUid: [{ uid: 2002, pids: ["pidC"] }] });
		const web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "ViewerName" }, "web")}` };
		expect((await h.call("/v1/identity/resolve?uid=2002", { headers: web })).status).toBe(403);
		expect((await resolve("uid=2002", API)).status).toBe(401);
		expect((await h.call("/v1/identity/resolve?uid=2002")).status).toBe(401);
	});

	test("bad input is 400; only GET", async () => {
		expect((await resolve("")).status).toBe(400);
		expect((await resolve("pid=bad%20pid")).status).toBe(400);
		expect((await resolve("uid=12ab")).status).toBe(400);
		expect((await resolve(`pid=${Array.from({ length: 101 }, (_, i) => `p${i}`).join(",")}`)).status).toBe(400);
		expect((await h.call("/v1/identity/resolve?uid=1", { method: "POST", headers: bearer(LOOKUP) })).status).toBe(405);
	});

	test("the lookup token reaches nothing else, and that doesn't lock the address out", async () => {
		const ip = "203.0.113.77";
		for (const path of ["/v1/identity?uid=1001", "/v1/identity/pidA/profile", "/v1/queries", "/v1/errors", "/v1/fleet/servers", "/v1/admin/settings"]) {
			const res = await h.call(path, { headers: bearer(LOOKUP), ip });
			expect(`${path} ${res.status}`).toBe(`${path} 403`);
			expect((await asJson(res)).error).toContain("lookup token only");
		}
		expect((await h.call("/v1/sql", { ...post(LOOKUP, { sql: "select 1" }), ip })).status).toBe(403);
		expect((await h.call("/v1/erasure", { ...post(LOOKUP, { pid: "pidA" }), ip })).status).toBe(401);
		// More than the 5-failure limit of refusals, and the address still resolves.
		expect((await resolve("pid=pidA", LOOKUP, ip)).status).toBe(200);
		expect(await asJson(await h.call("/v1/auth/check", { headers: bearer(LOOKUP), ip }))).toMatchObject({ ok: true, role: "lookup" });
		expect(await asJson(await h.call("/healthz", { headers: bearer(LOOKUP), ip }))).toEqual({ ok: true });
	});

	test("erased pids are unknown", async () => {
		expect((await h.call("/v1/erasure", post(ADMIN, { pid: "pidC" }))).status).toBe(200);
		expect(await asJson(await resolve("pid=pidC&uid=2002"))).toEqual({ byPid: [{ pid: "pidC", uid: null }], byUid: [{ uid: 2002, pids: [] }] });
	});

	test("rate limited per address", async () => {
		const ip = "203.0.113.88";
		const statuses: number[] = [];
		for (let i = 0; i < 61; i++) statuses.push((await resolve("pid=pidA", LOOKUP, ip)).status);
		expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
		expect(statuses[60]).toBe(429);
	});
});

describe("without a lookup token", () => {
	test("the route is admin only, and a random Bearer is a failed login", async () => {
		const h = await harness();
		try {
			expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer(ADMIN) })).status).toBe(200);
			expect((await h.call("/v1/identity/resolve?uid=1", { headers: bearer(LOOKUP) })).status).toBe(401);
		} finally {
			await h.close();
		}
	});
});
