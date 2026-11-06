/**
 * The backend's two roles and its door: env and secrets, API key vs admin token, the explorer's login (cookie, rate limit,
 * sessions), the admin allow list, security headers and the explorer's files. All tokens here are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app.ts";
import { Sessions } from "../src/server/auth.ts";
import { applyLegacyEnv, LEGACY_CLIENT_ENV } from "../src/legacy-env.ts";
import { CLOUDFLARE_IPS, loadConfig, MIN_SECRET_LENGTH } from "../src/server/config.ts";
import { FailureLimiter, clientIp } from "../src/server/http.ts";
import { ipAllowed, parseIpRules } from "../src/server/ipfilter.ts";
import { storeConfigFromEnv } from "../src/store/index.ts";

import { ADMIN, API, PREVIOUS, T0, asJson, bearer, cookieOf, harness, json, post, type Harness } from "./harness.ts";

describe("environment", () => {
	const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_EXPLORER: "off" };

	test("both secrets are required, 32+ characters, and different", () => {
		expect(() => loadConfig([], {})).toThrow("TYPETORCH_API_KEY is required");
		expect(() => loadConfig([], { TYPETORCH_API_KEY: API })).toThrow("TYPETORCH_ADMIN_TOKEN is required");
		expect(() => loadConfig([], { TYPETORCH_ADMIN_TOKEN: ADMIN })).toThrow("TYPETORCH_API_KEY is required");
		expect(MIN_SECRET_LENGTH).toBe(32);
		expect(() => loadConfig([], { ...base, TYPETORCH_ADMIN_TOKEN: "x".repeat(31) })).toThrow("at least 32");
		expect(() => loadConfig([], { ...base, TYPETORCH_API_KEY: "x".repeat(31) })).toThrow("at least 32");
		expect(() => loadConfig([], { ...base, TYPETORCH_API_KEY_PREVIOUS: "short" })).toThrow("TYPETORCH_API_KEY_PREVIOUS must be at least 32");
		expect(() => loadConfig([], { ...base, TYPETORCH_ADMIN_TOKEN: API })).toThrow("must be different");
		expect(() => loadConfig([], { ...base, TYPETORCH_API_KEY_PREVIOUS: ADMIN })).toThrow("must differ");
		expect(loadConfig([], { ...base, TYPETORCH_API_KEY: "y".repeat(32) }).apiKeys).toEqual(["y".repeat(32)]);
	});

	test("an error never carries the secret itself", () => {
		const secret = "s3cret-value-that-is-too-short";
		try {
			loadConfig([], { ...base, TYPETORCH_ADMIN_TOKEN: secret });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as Error).message).not.toContain(secret);
		}
	});

	test("the previous key is accepted too; defaults", () => {
		const c = loadConfig([], { ...base, TYPETORCH_API_KEY_PREVIOUS: PREVIOUS });
		expect(c.apiKeys).toEqual([API, PREVIOUS]);
		expect(c).toMatchObject({ host: "127.0.0.1", port: 8787, tokenLogin: true, trustProxy: 0 });
		// The warnings: remove the previous key once the rotation is done; Sign in with typetorch.dev (on by default) needs
		// a public URL, so it stays off.
		expect(c.warnings).toEqual([expect.stringContaining("TYPETORCH_API_KEY_PREVIOUS is set"), expect.stringContaining("Sign in with typetorch.dev is off: set TYPETORCH_PUBLIC_URL")]);
		expect(c.centralLogin).toBeUndefined();
		expect(c.sessionIdleMs).toBe(12 * 3_600_000);
		expect(c.sessionMaxMs).toBe(7 * 86_400_000);
		expect(c.loginMaxFailures).toBe(5);
		expect(c.loginWindowMs).toBe(15 * 60_000);
		expect(c.adminAllowIps).toBeUndefined();
		expect(c.robloxOAuth).toBeUndefined();
	});

	test("the optional variables", () => {
		const c = loadConfig([], {
			...base,
			TYPETORCH_DATA_DIR: "/tmp/tt-data-x",
			HOST: "0.0.0.0",
			PORT: "9000",
			TYPETORCH_PUBLIC_URL: "https://backend.example.com/",
			ROBLOX_WEBHOOK_SECRET: "w",
			OPENCLOUD_API_KEY: "o",
			TYPETORCH_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x",
			TYPETORCH_TRUST_PROXY: "1",
			TYPETORCH_ADMIN_ALLOW_IPS: "10.0.0.0/8, 203.0.113.7,2001:db8::/32",
			TYPETORCH_TOKEN_LOGIN: "off",
		});
		expect(c).toMatchObject({ host: "0.0.0.0", port: 9000, publicUrl: "https://backend.example.com", webhookSecret: "w", openCloudKey: "o", trustProxy: 1, tokenLogin: false });
		expect(c.dataDir.replace(/\\/g, "/")).toContain("tt-data-x");
		expect(c.adminAllowIps?.length).toBe(3);
		expect(loadConfig([], { ...base, TYPETORCH_TRUST_PROXY: "2" }).trustProxy).toBe(2);
		expect(loadConfig([], { ...base, TYPETORCH_TRUST_PROXY: "off" }).trustProxy).toBe(0);
		expect(() => loadConfig([], { ...base, TYPETORCH_ADMIN_ALLOW_IPS: "not-an-ip" })).toThrow("TYPETORCH_ADMIN_ALLOW_IPS");
		expect(() => loadConfig([], { ...base, TYPETORCH_PUBLIC_URL: "ftp://x" })).toThrow("TYPETORCH_PUBLIC_URL");
		expect(() => loadConfig([], { ...base, TYPETORCH_TOKEN_LOGIN: "maybe" })).toThrow("on or off");
	});

	test("old names are still read for one release, each with a warning that names the new one (never the value)", () => {
		const c = loadConfig([], {
			TT_ANALYTICS_INGEST_TOKENS: `${API},${PREVIOUS}`,
			TT_ANALYTICS_ADMIN_TOKEN: ADMIN,
			TT_ANALYTICS_DATA: "/tmp/tt-old-data",
			TT_ANALYTICS_PORT: "8123",
			TT_SERVER_PARTS: "fleet",
			TT_FLEET_WEBHOOK_URL: "https://discord.com/api/webhooks/9/z",
			TT_ANALYTICS_WEBHOOK_SECRET: "old-secret",
			TT_ANALYTICS_OPENCLOUD_KEY: "old-key",
			TT_ANALYTICS_MEMORY_LIMIT: "300MB",
			TT_ANALYTICS_TRUST_PROXY: "1",
			TYPETORCH_EXPLORER: "off",
		});
		expect(c.apiKeys).toEqual([API, PREVIOUS]);
		expect(c).toMatchObject({ adminToken: ADMIN, port: 8123, memoryLimit: "300MB", webhookSecret: "old-secret", openCloudKey: "old-key", alertWebhookUrl: "https://discord.com/api/webhooks/9/z", trustProxy: 1 });
		expect([...c.parts]).toEqual(["fleet"]);
		const text = c.warnings.join("\n");
		for (const [old, now] of [
			["TT_ANALYTICS_INGEST_TOKENS", "TYPETORCH_API_KEY"],
			["TT_ANALYTICS_ADMIN_TOKEN", "TYPETORCH_ADMIN_TOKEN"],
			["TT_ANALYTICS_DATA", "TYPETORCH_DATA_DIR"],
			["TT_ANALYTICS_PORT", "PORT"],
			["TT_SERVER_PARTS", "TYPETORCH_PARTS"],
			["TT_FLEET_WEBHOOK_URL", "TYPETORCH_ALERT_WEBHOOK_URL"],
			["TT_ANALYTICS_WEBHOOK_SECRET", "ROBLOX_WEBHOOK_SECRET"],
			["TT_ANALYTICS_OPENCLOUD_KEY", "OPENCLOUD_API_KEY"],
		]) {
			expect(c.warnings.some((w) => w.includes(old) && w.includes(now))).toBe(true);
		}
		expect(c.warnings.every((w) => !w.includes("\n"))).toBe(true);
		for (const value of [API, ADMIN, "old-secret", "old-key", "tt-old-data"]) expect(text).not.toContain(value);
	});

	test("the new name wins when both are set, and says so", () => {
		const c = loadConfig([], { ...base, PORT: "8200", TT_ANALYTICS_PORT: "9999", TYPETORCH_CENTRAL_LOGIN: "off" });
		expect(c.port).toBe(8200);
		expect(c.warnings).toEqual(["TT_ANALYTICS_PORT is ignored because PORT is set; remove it"]);
	});

	test("TT_ANALYTICS_INGEST_TOKENS is wholly ignored once TYPETORCH_API_KEY is set (no tail entry stays a game key)", () => {
		const third = "t".repeat(40);
		const both = loadConfig([], { ...base, TT_ANALYTICS_INGEST_TOKENS: `${"a".repeat(40)},${"b".repeat(40)},${third}` });
		expect(both.apiKeys).toEqual([API]);
		expect(both.warnings).toContain("TT_ANALYTICS_INGEST_TOKENS is ignored because TYPETORCH_API_KEY is set; remove it");
		// Without TYPETORCH_API_KEY the old list still works in full for its last release.
		const old = loadConfig([], { TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_EXPLORER: "off", TT_ANALYTICS_INGEST_TOKENS: `${API},${PREVIOUS},${third}` });
		expect(old.apiKeys).toEqual([API, PREVIOUS, third]);
	});

	test("an env file sits under the real environment", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-envfile-"));
		try {
			const file = join(dir, "backend.env");
			writeFileSync(file, `# comment\nTYPETORCH_API_KEY=${API}\nTYPETORCH_ADMIN_TOKEN="${ADMIN}"\nPORT=8300\nTT_FLEET_DB=${join(dir, "x.sqlite").replace(/\\/g, "/")}\n`);
			const c = loadConfig(["--env-file", file], { PORT: "8301", TYPETORCH_EXPLORER: "off" });
			expect(c.port).toBe(8301);
			expect(c.adminToken).toBe(ADMIN);
			expect(c.warnings.some((w) => w.includes("TT_FLEET_DB") && w.includes("TYPETORCH_SQLITE"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the client side (store config) reads the new names and warns about the old", () => {
		const warned: string[] = [];
		expect(storeConfigFromEnv({ TYPETORCH_BACKEND_URL: "https://b.example.com", TYPETORCH_ADMIN_TOKEN: ADMIN }, undefined, (w) => warned.push(w))).toEqual({ backend: "duckdb", url: "https://b.example.com", token: ADMIN });
		expect(warned).toEqual([]);
		expect(storeConfigFromEnv({ TT_ANALYTICS_URL: "https://b.example.com", TT_ANALYTICS_ADMIN_TOKEN: ADMIN }, undefined, (w) => warned.push(w))).toMatchObject({ backend: "duckdb", url: "https://b.example.com" });
		expect(warned).toEqual(["TT_ANALYTICS_URL is deprecated: use TYPETORCH_BACKEND_URL", "TT_ANALYTICS_ADMIN_TOKEN is deprecated: use TYPETORCH_ADMIN_TOKEN"]);
		expect(applyLegacyEnv({ TYPETORCH_FLEET_TOKEN: ADMIN }, LEGACY_CLIENT_ENV).env.TYPETORCH_ADMIN_TOKEN).toBe(ADMIN);
	});
});

describe("IP rules and the failure limiter", () => {
	test("allow lists: addresses, CIDR ranges, IPv6, IPv4-mapped", () => {
		const rules = parseIpRules("10.0.0.0/8, 203.0.113.7, 192.168.1.0/24, 2001:db8::/32, ::1");
		for (const ip of ["10.1.2.3", "203.0.113.7", "192.168.1.200", "2001:db8:abcd::1", "::1", "::ffff:10.9.9.9", "[::1]"]) expect(ipAllowed(rules, ip)).toBe(true);
		for (const ip of ["11.0.0.1", "203.0.113.8", "192.168.2.1", "2001:db9::1", "::2", "", "garbage", "999.1.1.1"]) expect(ipAllowed(rules, ip)).toBe(false);
		expect(ipAllowed(parseIpRules("0.0.0.0/0"), "8.8.8.8")).toBe(true);
		expect(() => parseIpRules("10.0.0.0/33")).toThrow("prefix");
		expect(() => parseIpRules("10.0.0.256")).toThrow("not an IP");
		expect(parseIpRules("")).toEqual([]);
	});

	test("client IP: the peer, or a trusted proxy's hop of X-Forwarded-For", () => {
		const req = (xff?: string) => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });
		expect(clientIp(req("1.1.1.1"), "10.0.0.5", 0)).toBe("10.0.0.5");
		expect(clientIp(req("1.1.1.1, 2.2.2.2"), "10.0.0.5", 1)).toBe("2.2.2.2");
		expect(clientIp(req("1.1.1.1, 2.2.2.2"), "10.0.0.5", 2)).toBe("1.1.1.1");
		expect(clientIp(req("1.1.1.1"), "10.0.0.5", 3)).toBe("1.1.1.1");
		expect(clientIp(req(), "10.0.0.5", 1)).toBe("10.0.0.5");
		expect(clientIp(req("9.9.9.9"), "10.0.0.5", true)).toBe("9.9.9.9");
	});

	test("failures block after the limit and age out", () => {
		let now = 0;
		const l = new FailureLimiter(3, 60_000, () => now);
		for (let i = 0; i < 3; i++) {
			expect(l.blocked("a")).toBe(0);
			l.fail("a");
			now += 1000;
		}
		expect(l.blocked("a")).toBe(57);
		expect(l.blocked("b")).toBe(0);
		now += 57_000;
		expect(l.blocked("a")).toBe(0);
		l.fail("a");
		l.reset("a");
		expect(l.size).toBe(0);
	});
});

describe("sessions", () => {
	test("random ids, idle and absolute lifetimes, bound to the admin token", () => {
		let now = 1_000_000;
		const s = new Sessions({ adminToken: ADMIN, idleMs: 12 * 3_600_000, maxMs: 7 * 86_400_000, clock: () => now });
		const id = s.create({ kind: "token" });
		const other = s.create({ kind: "token" });
		expect(id).not.toBe(other);
		expect(Buffer.from(id, "base64url").length).toBe(32);
		expect(s.get(id)?.user).toEqual({ kind: "token" });
		expect(s.get("not-a-session")).toBeUndefined();
		expect(s.get(undefined)).toBeUndefined();
		// Active use keeps it alive past 12 h in total.
		for (let step = 0; step < 6; step++) {
			now += 11 * 3_600_000;
			expect(s.get(id)).toBeDefined();
		}
		// 66 h in; idle for 13 h ends it.
		now += 13 * 3_600_000;
		expect(s.get(id)).toBeUndefined();
		// The absolute limit ends even a busy session: used every 11 h it still dies at 7 days.
		const busy = s.create({ kind: "token" });
		const born = now;
		let alive = 0;
		while (s.get(busy)) {
			now += 11 * 3_600_000;
			alive = now - born;
			if (alive > 8 * 86_400_000) break;
		}
		expect(alive).toBeGreaterThan(7 * 86_400_000);
		expect(alive).toBeLessThanOrEqual(7 * 86_400_000 + 11 * 3_600_000);
		// A session made under another admin token is dead under this one.
		const foreign = s.create({ kind: "token" }, "admin", Sessions.hashToken("another-admin-token-0123456789abcdef"));
		expect(s.get(foreign)).toBeUndefined();
		// Logout.
		const mine = s.create({ kind: "token" });
		expect(s.destroy(mine)).toBe(true);
		expect(s.get(mine)).toBeUndefined();
		// The store is bounded.
		const small = new Sessions({ adminToken: ADMIN, idleMs: 1e9, maxMs: 1e9, maxSessions: 3, clock: () => now });
		const ids = [1, 2, 3, 4].map(() => small.create({ kind: "token" }));
		expect(small.size).toBe(3);
		expect(small.get(ids[0] as string)).toBeUndefined();
		expect(small.get(ids[3] as string)).toBeDefined();
	});
});

describe("roles", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_API_KEY_PREVIOUS: PREVIOUS });
	});
	afterAll(() => h.close());

	const status = async (path: string, token: string | undefined, init: RequestInit = {}) => (await h.call(path, { ...init, headers: { ...(token ? bearer(token) : {}), ...(init.headers as Record<string, string> | undefined) } })).status;
	const postJson = (path: string, token: string | undefined, body: unknown) => h.call(path, post(token, body));

	test("game routes take the API key (and the previous one) and nothing else", async () => {
		const routes: [string, unknown][] = [
			["/v1/ingest", { events: [] }],
			["/v1/errors", { j: "job-roles", errors: [] }],
			["/v1/identity", { identities: [] }],
			["/v1/fleet/heartbeat", { j: "job-roles" }],
			["/v1/fleet/report", { s: 1, j: "job-roles", r: "booted" }],
			["/v1/fleet/alert", { level: "info", code: "roles_test", message: "m", j: "job-roles" }],
			["/v1/fleet/closing", { j: "job-roles" }],
			["/v1/fleet/deploy", { s: 1, b: "prod" }],
		];
		for (const [path, body] of routes) {
			expect([path, (await postJson(path, API, body)).status]).toEqual([path, 202]);
			expect([path, (await postJson(path, PREVIOUS, body)).status]).toEqual([path, 202]);
			expect([path, (await postJson(path, ADMIN, body)).status]).toEqual([path, 401]);
			expect([path, (await postJson(path, "wrong-token-0123456789abcdef0123456789", body)).status]).toEqual([path, 401]);
			expect([path, (await postJson(path, undefined, body)).status]).toEqual([path, 401]);
		}
	});

	test("everything that reads or manages is admin only; the API key reads nothing", async () => {
		const reads = ["/v1/queries", "/v1/storage", "/v1/settings", "/v1/identity", "/v1/errors", "/v1/errors/some-fp", "/v1/fleet/servers", "/v1/fleet/reports?latest", "/v1/fleet/alerts", "/v1/access", "/v1/rollups/daily", "/v1/live", "/v1/nope"];
		for (const path of reads) {
			expect([path, await status(path, API)]).toEqual([path, 401]);
			expect([path, await status(path, PREVIOUS)]).toEqual([path, 401]);
			expect([path, await status(path, undefined)]).toEqual([path, 401]);
		}
		const writes: [string, unknown][] = [
			["/v1/query/overview", {}],
			["/v1/sql", { sql: "SELECT 1" }],
			["/v1/identity/backfill", {}],
			["/v1/fleet/alerts/1/ack", {}],
			["/v1/erasure", { pid: "p1" }],
		];
		for (const [path, body] of writes) {
			expect([path, (await postJson(path, API, body)).status === 200]).toEqual([path, false]);
			expect([path, (await postJson(path, undefined, body)).status === 200]).toEqual([path, false]);
		}
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [1] }), headers: { "content-type": "application/json", ...bearer(API) } })).status).toBe(401);
		for (const path of ["/v1/queries", "/v1/storage", "/v1/settings", "/v1/identity", "/v1/errors", "/v1/fleet/servers", "/v1/fleet/alerts", "/v1/access", "/v1/rollups/daily"]) {
			expect([path, await status(path, ADMIN)]).toEqual([path, 200]);
		}
		expect(await status("/v1/errors/some-fp", ADMIN)).toBe(404);
		expect(await status("/v1/nope", ADMIN)).toBe(404);
		expect((await postJson("/v1/query/overview", ADMIN, {})).status).toBe(200);
	});

	test("tokens are never accepted in the query string", async () => {
		for (const name of ["token", "access_token", "key", "api_key", "admin_token"]) {
			expect((await h.call(`/v1/queries?${name}=${ADMIN}`)).status).toBe(401);
			expect((await h.call(`/v1/ingest?${name}=${API}`, { method: "POST", ...json({ events: [] }) })).status).toBe(401);
		}
	});

	test("GET /v1/auth/check says the role and has no side effects", async () => {
		const check = async (token?: string) => h.call("/v1/auth/check", { headers: token ? bearer(token) : {} });
		expect(await asJson(await check(API))).toMatchObject({ ok: true, role: "game", via: "bearer", service: "typetorch-backend" });
		expect(await asJson(await check(PREVIOUS))).toMatchObject({ ok: true, role: "game" });
		expect(await asJson(await check(ADMIN))).toMatchObject({ ok: true, role: "admin", via: "bearer", user: { kind: "token" } });
		const none = await check();
		expect(none.status).toBe(401);
		expect(await asJson(none)).toMatchObject({ login: { token: true, roblox: false } });
		expect((await check("wrong-token-0123456789abcdef0123456789")).status).toBe(401);
		expect((await h.call("/v1/auth/check", { method: "POST", headers: bearer(API) })).status).toBe(405);
		// No session, no state was created by any of this.
		const published = JSON.stringify(h.app.bus.stats().published);
		await check(API);
		await check();
		expect(JSON.stringify(h.app.bus.stats().published)).toBe(published);
		expect(h.app.sessionCount()).toBe(0);
	});

	test("the explorer's /api prefix reaches the same routes", async () => {
		expect((await h.call("/api/v1/auth/check", { headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/api/v1/queries")).status).toBe(401);
		expect(await (await h.call("/api/healthz")).json()).toEqual({ ok: true }); // the explorer asks its health there
	});

	test("/healthz without the admin token says only ok", async () => {
		expect(await (await h.call("/healthz")).json()).toEqual({ ok: true });
		expect(await (await h.call("/healthz", { headers: bearer(API) })).json()).toEqual({ ok: true });
		const detail = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		expect(detail).toMatchObject({ ok: true });
		// The alert notifier is subscribed even without a webhook, so one saved on the Settings page works at once.
		expect(detail.bus.subscribers.map((s: { name: string }) => s.name).sort()).toEqual(["alert-notifier", "duckdb-writer", "error-store", "fleet-store", "live"]);
		expect(detail.errors).toBeDefined();
	});
});

describe("explorer login", () => {
	let h: Harness;
	const XT = { "x-typetorch": "1" };
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet" });
	});
	afterAll(() => h.close());

	const login = (token: unknown, extra: Record<string, string> = {}, ip = "198.51.100.20") => h.call("/v1/auth/login", { method: "POST", ...json({ token }), headers: { "content-type": "application/json", ...XT, ...extra }, ip });
	const withCookie = (cookie: string, extra: Record<string, string> = {}): Record<string, string> => ({ cookie, ...extra });

	test("pasting the admin token sets an HttpOnly, SameSite=Strict session cookie; Bearer is not needed after", async () => {
		const res = await login(ADMIN);
		expect(res.status).toBe(200);
		const raw = res.headers.getSetCookie().find((c) => c.startsWith("tt_session="));
		expect(raw).toBeDefined();
		expect(raw).toContain("HttpOnly");
		expect(raw).toContain("SameSite=Strict");
		expect(raw).toContain("Path=/");
		expect(raw).toContain("Max-Age=604800");
		expect(raw).not.toContain("Secure"); // plain http here
		expect(raw).not.toContain(ADMIN);
		const cookie = cookieOf(res) as string;
		expect(cookie.length).toBeGreaterThan(40);
		const check = await asJson(await h.call("/v1/auth/check", { headers: withCookie(cookie) }));
		expect(check).toMatchObject({ ok: true, role: "admin", via: "cookie", user: { kind: "token" } });
		expect((await h.call("/v1/queries", { headers: withCookie(cookie) })).status).toBe(200);
		expect((await h.call("/v1/fleet/servers", { headers: withCookie(cookie) })).status).toBe(200);
	});

	test("the cookie is Secure on https: directly, behind a trusted proxy that says so, or with an https public URL", async () => {
		const direct = await h.app.handle(new Request("https://backend.test/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } }), "198.51.100.21");
		expect(direct.headers.getSetCookie().find((c) => c.startsWith("tt_session="))).toContain("Secure");
		// X-Forwarded-Proto counts only when the proxy is trusted.
		const proxied = (g: Harness) => g.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-forwarded-proto": "https", ...XT }, ip: "198.51.100.22" });
		expect((await proxied(h)).headers.getSetCookie().find((c) => c.startsWith("tt_session="))).not.toContain("Secure");
		const trusted = await harness({ TYPETORCH_TRUST_PROXY: "1" });
		const withPublic = await harness({ TYPETORCH_PUBLIC_URL: "https://backend.example.com" });
		try {
			expect((await proxied(trusted)).headers.getSetCookie().find((c) => c.startsWith("tt_session="))).toContain("Secure");
			expect((await proxied(withPublic)).headers.getSetCookie().find((c) => c.startsWith("tt_session="))).toContain("Secure");
			expect((await proxied(trusted)).headers.get("strict-transport-security")).toContain("max-age=");
		} finally {
			await trusted.close();
			await withPublic.close();
		}
	});

	test("changes made with the cookie need the X-TypeTorch header; Bearer requests don't; GETs don't", async () => {
		const cookie = cookieOf(await login(ADMIN)) as string;
		const body = json({ filters: {} });
		const noHeader = await h.call("/v1/sql", { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }), headers: { "content-type": "application/json", cookie } });
		expect(noHeader.status).toBe(403);
		expect((await asJson(noHeader)).error).toContain("X-TypeTorch".toLowerCase());
		const wrongValue = await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...body, headers: { "content-type": "application/json", cookie, "x-typetorch": "0" } });
		expect(wrongValue.status).toBe(403);
		const ok = await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...body, headers: { "content-type": "application/json", cookie, ...XT } });
		expect(ok.status).toBe(404); // got through the gate: there is no alert 1
		// Bearer: no header needed.
		expect((await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...body, headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(404);
		// A cross-origin browser request is refused even with the header.
		const cross = await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...body, headers: { "content-type": "application/json", cookie, origin: "https://evil.example", ...XT } });
		expect(cross.status).toBe(403);
		const same = await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...body, headers: { "content-type": "application/json", cookie, origin: "http://backend.test", ...XT } });
		expect(same.status).toBe(404);
	});

	test("a wrong Bearer is not rescued by a valid cookie", async () => {
		const cookie = cookieOf(await login(ADMIN)) as string;
		expect((await h.call("/v1/queries", { headers: { cookie, ...bearer("wrong-token-0123456789abcdef0123456789") } })).status).toBe(401);
	});

	test("logout ends the session and clears the cookie", async () => {
		const cookie = cookieOf(await login(ADMIN)) as string;
		const noHeader = await h.call("/v1/auth/logout", { method: "POST", headers: { cookie } });
		expect(noHeader.status).toBe(403);
		const out = await h.call("/v1/auth/logout", { method: "POST", headers: { cookie, ...XT } });
		expect(out.status).toBe(200);
		expect(out.headers.getSetCookie().find((c) => c.startsWith("tt_session="))).toContain("Max-Age=0");
		expect((await h.call("/v1/queries", { headers: { cookie } })).status).toBe(401);
	});

	test("the session ends after 12 h idle and after 7 days", async () => {
		const cookie = cookieOf(await login(ADMIN)) as string;
		const start = h.now();
		try {
			h.setNow(start + 11 * 3_600_000);
			expect((await h.call("/v1/auth/check", { headers: { cookie } })).status).toBe(200);
			h.setNow(start + 11 * 3_600_000 + 13 * 3_600_000);
			expect((await h.call("/v1/auth/check", { headers: { cookie } })).status).toBe(401);
			h.setNow(start);
			const busy = cookieOf(await login(ADMIN)) as string;
			// Used every 11 hours it stays alive...
			for (let t = 11 * 3_600_000; t < 7 * 86_400_000; t += 11 * 3_600_000) {
				h.setNow(start + t);
				expect((await h.call("/v1/auth/check", { headers: { cookie: busy } })).status).toBe(200);
			}
			// ...until 7 days after it was made.
			h.setNow(start + 7 * 86_400_000 + 60_000);
			expect((await h.call("/v1/auth/check", { headers: { cookie: busy } })).status).toBe(401);
		} finally {
			h.setNow(start);
		}
	});

	test("login wants JSON and the custom header; a login from another origin is refused", async () => {
		expect((await h.call("/v1/auth/login", { method: "POST", body: "token=x", headers: { "content-type": "application/x-www-form-urlencoded", ...XT }, ip: "198.51.100.30" })).status).toBe(415);
		expect((await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), ip: "198.51.100.30" })).status).toBe(403);
		expect((await login(ADMIN, { origin: "https://evil.example" }, "198.51.100.30")).status).toBe(403);
		expect((await h.call("/v1/auth/login", { ip: "198.51.100.30" })).status).toBe(405);
	});

	test("5 failed attempts in 15 minutes block the address with 429 and Retry-After; failures are logged without the value", async () => {
		const ip = "198.51.100.77";
		const guesses = ["guess-number-one-0123456789abcdef0123", "guess-number-two-0123456789abcdef0123", "guess-3", "guess-4", "guess-5"];
		for (const g of guesses) {
			const res = await login(g, {}, ip);
			expect(res.status).toBe(401);
			expect(res.headers.getSetCookie()).toEqual([]);
		}
		// The sixth attempt is refused even with the right token.
		const blocked = await login(ADMIN, {}, ip);
		expect(blocked.status).toBe(429);
		const wait = Number(blocked.headers.get("retry-after"));
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(900);
		// Bearer requests and the check are blocked for that address too, other addresses are not.
		expect((await h.call("/v1/queries", { headers: bearer(ADMIN), ip })).status).toBe(429);
		expect((await h.call("/v1/auth/check", { headers: bearer(ADMIN), ip })).status).toBe(429);
		expect((await h.call("/v1/queries", { headers: bearer(ADMIN), ip: "198.51.100.78" })).status).toBe(200);
		// Game servers behind the same address are untouched.
		expect((await h.call("/v1/errors", { ...post(API, { j: "job-login", errors: [] }), ip })).status).toBe(202);
		// The log names the address, never what was typed.
		const lines = h.logs.filter((l) => l.includes(ip));
		expect(lines.length).toBeGreaterThanOrEqual(5);
		expect(lines.some((l) => l.includes("admin login failed from"))).toBe(true);
		for (const g of guesses) expect(h.logs.join("\n")).not.toContain(g);
		expect(h.logs.join("\n")).not.toContain(ADMIN);
		// After the window the address may try again.
		const start = h.now();
		try {
			h.setNow(start + 15 * 60_000 + 1000);
			expect((await login(ADMIN, {}, ip)).status).toBe(200);
		} finally {
			h.setNow(start);
		}
	});

	test("bad Bearer tokens on admin routes and the check count toward the limit too", async () => {
		const ip = "198.51.100.88";
		for (let i = 0; i < 5; i++) expect((await h.call(i % 2 ? "/v1/queries" : "/v1/auth/check", { headers: bearer(`wrong-token-${i}-0123456789abcdef0123456789`), ip })).status).toBe(401);
		expect((await h.call("/v1/auth/check", { headers: bearer(ADMIN), ip })).status).toBe(429);
	});

	test("the check is rate limited", async () => {
		let limited = 0;
		for (let i = 0; i < 130; i++) if ((await h.call("/v1/auth/check", { headers: bearer(API), ip: "198.51.100.99" })).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
	});

	test("TYPETORCH_TOKEN_LOGIN=off hides and refuses the token login; the CLI's Bearer still works", async () => {
		const g = await harness({ TYPETORCH_TOKEN_LOGIN: "off" });
		try {
			const res = await g.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			expect(res.status).toBe(404);
			expect(res.headers.getSetCookie()).toEqual([]);
			expect((await asJson(await g.call("/v1/auth/check"))).login).toEqual({ token: false, roblox: false });
			expect((await g.call("/v1/queries", { headers: bearer(ADMIN) })).status).toBe(200);
		} finally {
			await g.close();
		}
	});
});

describe("admin allow list", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_ADMIN_ALLOW_IPS: "10.0.0.0/8, 203.0.113.7", TYPETORCH_TRUST_PROXY: "1" });
	});
	afterAll(() => h.close());
	const OUT = "198.51.100.5";
	const IN = "10.1.2.3";

	test("other addresses get 404 on admin routes, the login and the check; allowed ones work", async () => {
		for (const path of ["/v1/queries", "/v1/storage", "/v1/errors", "/v1/fleet/servers", "/v1/access", "/v1/live", "/v1/nope"]) {
			expect([path, (await h.call(path, { headers: bearer(ADMIN), ip: OUT })).status]).toEqual([path, 404]);
			expect([path, (await h.call(path, { headers: bearer(ADMIN), ip: IN })).status]).toEqual([path, path === "/v1/live" ? 200 : path === "/v1/nope" ? 404 : 200]);
		}
		expect((await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" }, ip: OUT })).status).toBe(404);
		expect((await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" }, ip: IN })).status).toBe(200);
		expect((await h.call("/v1/auth/check", { headers: bearer(ADMIN), ip: OUT })).status).toBe(404);
		expect((await h.call("/v1/auth/check", { ip: OUT })).status).toBe(404);
		expect((await h.call("/v1/auth/roblox/start", { ip: OUT })).status).toBe(404);
		// The session cookie does not help from another address.
		const cookie = cookieOf(await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" }, ip: "203.0.113.7" })) as string;
		expect((await h.call("/v1/queries", { headers: { cookie }, ip: "203.0.113.7" })).status).toBe(200);
		expect((await h.call("/v1/queries", { headers: { cookie }, ip: OUT })).status).toBe(404);
	});

	test("game routes stay open to any address (they still need the API key); a game key may check itself from anywhere", async () => {
		expect((await h.call("/v1/errors", { ...post(API, { j: "job-out", errors: [] }), ip: OUT })).status).toBe(202);
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, { j: "job-out" }), ip: OUT })).status).toBe(202);
		expect((await h.call("/v1/errors", { ...post(undefined, { errors: [] }), ip: OUT })).status).toBe(401);
		const check = await h.call("/v1/auth/check", { headers: bearer(API), ip: OUT });
		expect(check.status).toBe(200);
		expect((await asJson(check)).role).toBe("game");
		// An admin token from outside is not an admin there, and /healthz stays minimal.
		expect(await (await h.call("/healthz", { headers: bearer(ADMIN), ip: OUT })).json()).toEqual({ ok: true });
		expect(Object.keys(await asJson(await h.call("/healthz", { headers: bearer(ADMIN), ip: IN }))).length).toBeGreaterThan(3);
	});

	test("the address comes from X-Forwarded-For when the proxy is trusted", async () => {
		const via = (xff: string) => h.call("/v1/queries", { headers: { ...bearer(ADMIN), "x-forwarded-for": xff }, ip: "172.16.0.2" });
		expect((await via("10.9.9.9")).status).toBe(200);
		expect((await via("10.9.9.9, 198.51.100.5")).status).toBe(404); // the last hop is what the proxy saw
		expect((await via("198.51.100.5, 10.9.9.9")).status).toBe(200);
	});
});

describe("headers and the explorer's files", () => {
	let h: Harness;
	let web: string;
	beforeAll(async () => {
		web = mkdtempSync(join(tmpdir(), "tt-web-"));
		mkdirSync(join(web, "assets"));
		writeFileSync(join(web, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>');
		writeFileSync(join(web, "assets", "app-abc123.js"), "console.log('explorer')");
		writeFileSync(join(web, "assets", "style-def456.css"), "body{margin:0}");
		writeFileSync(join(web, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
		writeFileSync(join(web, "..secret.txt"), "not in the web dir");
		h = await harness({ TYPETORCH_EXPLORER: "on", TYPETORCH_WEB_DIR: web });
	});
	afterAll(async () => {
		await h.close();
		rmSync(web, { recursive: true, force: true });
	});

	test("the explorer is served at / with its routes, files and cache rules", async () => {
		const root = await h.call("/");
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type")).toContain("text/html");
		expect(root.headers.get("cache-control")).toBe("no-cache");
		expect(await root.text()).toContain('id="root"');
		for (const route of ["/errors", "/fleet", "/players/p1"]) expect(await (await h.call(route)).text()).toContain('id="root"');
		const js = await h.call("/assets/app-abc123.js");
		expect(js.headers.get("content-type")).toContain("text/javascript");
		expect(js.headers.get("cache-control")).toContain("immutable");
		expect((await h.call("/assets/style-def456.css")).headers.get("content-type")).toContain("text/css");
		expect((await h.call("/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
		expect((await h.call("/assets/missing.js")).status).toBe(404); // a missing file is not an explorer route
		expect((await h.call("/", { method: "HEAD" })).status).toBe(200);
		expect((await h.call("/", { method: "POST" })).status).toBe(404);
	});

	test("paths cannot leave the web folder", async () => {
		for (const path of ["/../package.json", "/%2e%2e/package.json", "/assets/../../package.json", "/..%2fpackage.json", "/%2e%2e%2f%2e%2e%2fsrc%2fserver%2fconfig.ts", "/assets%5c..%5c..%5cpackage.json", "/%00"]) {
			const res = await h.call(path);
			expect([path, res.status === 200 && (await res.text()).includes("typetorch")]).toEqual([path, false]);
		}
		expect((await h.call("/..secret.txt")).status).toBe(404); // any segment starting with a dot is refused, even inside the folder
	});

	test("security headers on the explorer, the API and errors; no CORS anywhere", async () => {
		const page = await h.call("/");
		const csp = page.headers.get("content-security-policy") as string;
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).toContain("frame-ancestors 'none'");
		for (const res of [page, await h.call("/v1/queries"), await h.call("/healthz"), await h.call("/nope-api/x"), await h.call("/v1/auth/check")]) {
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("referrer-policy")).toBe("no-referrer");
			expect(res.headers.get("x-frame-options")).toBe("DENY");
			expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
			expect(res.headers.get("strict-transport-security")).toBeNull(); // http
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}
		expect((await h.call("/v1/queries")).headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
		// A preflight gets no CORS grant.
		const preflight = await h.call("/v1/queries", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
		expect(preflight.status).toBe(405);
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
		const https = await h.app.handle(new Request("https://backend.test/v1/queries"), "127.0.0.1");
		expect(https.headers.get("strict-transport-security")).toContain("max-age=31536000");
	});

	test("without a built explorer / is a plain 404", async () => {
		const g = await harness({ TYPETORCH_EXPLORER: "on", TYPETORCH_WEB_DIR: join(web, "nowhere") });
		try {
			expect((await g.call("/")).status).toBe(404);
			expect((await g.call("/healthz")).status).toBe(200);
		} finally {
			await g.close();
		}
	});
});

describe("the bus inside the app", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	test("a stuck subscriber never slows ingest, heartbeats or error logs; its drops are counted and shown in /healthz", async () => {
		const unstick = h.app.bus.subscribe("stuck", ["events", "heartbeat", "deploy", "alert", "error"], () => new Promise<void>(() => {}), { mode: "queue", maxQueue: 3 });
		const row = (i: number) => ({ v: 1, t: T0, kind: "custom", name: `n${i}`, job: "job-bus", art: "art-1", pid: "p1", sid: "s1" });
		const started = performance.now();
		for (let i = 0; i < 20; i++) {
			expect((await h.call("/v1/ingest", post(API, { events: [row(i)] }))).status).toBe(202);
			expect((await h.call("/v1/fleet/heartbeat", post(API, { j: "job-bus", n: i }))).status).toBe(202);
			expect((await h.call("/v1/errors", post(API, { j: "job-bus", errors: [{ fp: "fp-bus", template: "t", count: 1, firstAt: T0, lastAt: T0, realm: "server" }] }))).status).toBe(202);
		}
		expect(performance.now() - started).toBeLessThan(5000);
		const health = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		const stuck = health.bus.subscribers.find((s: { name: string }) => s.name === "stuck");
		expect(stuck.queued).toBeLessThanOrEqual(3);
		expect(stuck.dropped).toBeGreaterThan(40);
		expect(health.bus.dropped).toBe(stuck.dropped);
		expect(health.bus.published).toMatchObject({ events: 20, heartbeat: 20, error: 20 });
		// The stores that answer for their data got every message.
		const byName = (n: string) => health.bus.subscribers.find((s: { name: string }) => s.name === n);
		expect(byName("duckdb-writer")).toMatchObject({ processed: 20, failed: 0, dropped: 0 });
		expect(byName("fleet-store")).toMatchObject({ processed: 20, dropped: 0 });
		expect(byName("error-store")).toMatchObject({ processed: 20, dropped: 0 });
		expect(h.app.errors.stats.occurrences).toBe(20);
		expect((await h.app.warehouse?.raw.pendingBytes()) ?? 0).toBeGreaterThan(0);
		unstick();
	});

	test("an awaited store that fails answers 500 and nothing else sees the message", async () => {
		const seen: string[] = [];
		h.app.bus.subscribe("watch", ["error"], (_t, m) => void seen.push(m.items[0]?.fp ?? ""), { mode: "queue" });
		const off = h.app.bus.subscribe("broken-store", ["error"], () => Promise.reject(new Error("disk full")), { mode: "await" });
		const res = await h.call("/v1/errors", post(API, { j: "job-lost", errors: [{ fp: "fp-lost", template: "t", count: 1, firstAt: T0, lastAt: T0, realm: "server" }] }));
		off();
		expect(res.status).toBe(500);
		expect(await h.app.bus.idle(2000)).toBe(true);
		expect(seen).not.toContain("fp-lost");
		expect(JSON.stringify(await res.json())).not.toContain("disk full");
	});
});

describe("wrong tokens on /healthz and the game routes are counted (no free token oracle)", () => {
	const WRONG = "wrong-token-for-tests-0123456789abcdef0";

	test("/healthz: a wrong Bearer counts toward the login lockout; a blocked address gets the plain answer even with the right token", async () => {
		const h = await harness();
		try {
			const ip = "203.0.113.90";
			for (let i = 0; i < 5; i++) expect(await asJson(await h.call("/healthz", { headers: bearer(WRONG), ip }))).toEqual({ ok: true });
			expect(h.logs.filter((l) => l.includes(`health check token failed from ${ip}`)).length).toBe(5);
			expect(h.logs.join("\n")).not.toContain(WRONG);
			// Blocked: the admin token gets { ok } only, and the other admin routes 429.
			expect(await asJson(await h.call("/healthz", { headers: bearer(ADMIN), ip }))).toEqual({ ok: true });
			expect((await h.call("/v1/settings", { headers: bearer(ADMIN), ip })).status).toBe(429);
			// No token: the container health check is never counted or blocked.
			expect((await h.call("/healthz", { ip: "203.0.113.91" })).status).toBe(200);
			expect((await asJson(await h.call("/healthz", { headers: bearer(ADMIN), ip: "203.0.113.91" }))).version).toBeDefined();
			// The API key on /healthz is not a failure (and shows nothing more).
			for (let i = 0; i < 6; i++) expect(await asJson(await h.call("/healthz", { headers: bearer(API), ip: "203.0.113.92" }))).toEqual({ ok: true });
			expect((await asJson(await h.call("/healthz", { headers: bearer(ADMIN), ip: "203.0.113.92" }))).version).toBeDefined();
			// The window passes: the address may try again.
			h.setNow(T0 + 16 * 60_000);
			expect((await asJson(await h.call("/healthz", { headers: bearer(ADMIN), ip }))).version).toBeDefined();
		} finally {
			await h.close();
		}
	});

	test("game routes: 30 wrong keys per address, then wrong keys get 429; the right key from that address still works", async () => {
		const h = await harness();
		try {
			const ip = "203.0.113.95";
			const routes: [string, unknown][] = [
				["/v1/errors", { j: "job-x", errors: [] }],
				["/v1/identity", { identities: [] }],
				["/v1/fleet/heartbeat", { j: "job-x" }],
				["/v1/ingest", { events: [] }],
			];
			const codes: number[] = [];
			for (let i = 0; i < 31; i++) {
				const [path, body] = routes[i % routes.length] as [string, unknown];
				codes.push((await h.call(path, { ...post(WRONG, body), ip })).status);
			}
			expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
			expect(codes[30]).toBe(429);
			// One log line for the first failure and one when the block starts, not one per try.
			expect(h.logs.filter((l) => l.includes(`wrong API key from ${ip}`)).length).toBe(1);
			expect(h.logs.some((l) => l.includes(`${ip}: wrong API keys are refused`))).toBe(true);
			expect(h.logs.join("\n")).not.toContain(WRONG);
			// A real game server behind the same address is never blocked.
			expect((await h.call("/v1/errors", { ...post(API, { j: "job-real", errors: [] }), ip })).status).toBe(202);
			expect((await h.call("/v1/fleet/heartbeat", { ...post(API, { j: "job-real" }), ip })).status).toBe(202);
			// No key at all is a plain 401 and not counted.
			expect((await h.call("/v1/errors", { ...post(undefined, { j: "job-x", errors: [] }), ip: "203.0.113.96" })).status).toBe(401);
			expect(h.logs.some((l) => l.includes("203.0.113.96"))).toBe(false);
		} finally {
			await h.close();
		}
	});
});

describe("which proxies are believed (TYPETORCH_TRUSTED_PROXIES, TYPETORCH_CLOUDFLARE)", () => {
	const req = (headers: Record<string, string> = {}) => new Request("http://x/", { headers });

	test("with a trusted proxy list, X-Forwarded-For only counts when the peer is a listed proxy", () => {
		const proxies = parseIpRules("10.0.0.0/8");
		// Through the proxy: the address it appended.
		expect(clientIp(req({ "x-forwarded-for": "198.51.100.7" }), "10.0.1.2", { hops: 1, proxies })).toBe("198.51.100.7");
		// Straight to the port from the internet: the forged header is ignored.
		expect(clientIp(req({ "x-forwarded-for": "10.0.0.1" }), "203.0.113.77", { hops: 1, proxies })).toBe("203.0.113.77");
		// Two hops: the inner hop must be trusted too, else it is the client.
		const two = parseIpRules("10.0.0.0/8, 162.158.0.0/15");
		expect(clientIp(req({ "x-forwarded-for": "198.51.100.7, 162.158.1.1" }), "10.0.1.2", { hops: 2, proxies: two })).toBe("198.51.100.7");
		expect(clientIp(req({ "x-forwarded-for": "10.9.9.9, 203.0.113.5" }), "10.0.1.2", { hops: 2, proxies: two })).toBe("203.0.113.5");
		// Without a list, the old rule (the Nth hop from the right) stands.
		expect(clientIp(req({ "x-forwarded-for": "10.0.0.1" }), "203.0.113.77", { hops: 1 })).toBe("10.0.0.1");
	});

	test("Cloudflare: CF-Connecting-IP replaces an address inside Cloudflare's ranges, never another one", () => {
		const cloudflare = parseIpRules(CLOUDFLARE_IPS.join(","));
		// Cloudflare -> Traefik (which saw the edge) -> the backend.
		expect(clientIp(req({ "x-forwarded-for": "162.158.10.20", "cf-connecting-ip": "198.51.100.9" }), "10.0.1.2", { hops: 1, cloudflare })).toBe("198.51.100.9");
		// Someone who reaches Traefik directly can't use the header.
		expect(clientIp(req({ "x-forwarded-for": "203.0.113.66", "cf-connecting-ip": "10.0.0.1" }), "10.0.1.2", { hops: 1, cloudflare })).toBe("203.0.113.66");
		// A header that isn't an address is ignored.
		expect(clientIp(req({ "x-forwarded-for": "162.158.10.20", "cf-connecting-ip": "nonsense" }), "10.0.1.2", { hops: 1, cloudflare })).toBe("162.158.10.20");
		expect(clientIp(req({ "cf-connecting-ip": "2001:db8::5" }), "2606:4700::1", { hops: 0, cloudflare })).toBe("2001:db8::5");
	});

	test("env: the lists parse; a trusted proxy on a public HOST without a list warns; the previous API key warns", () => {
		// Sign in with typetorch.dev off: on by default it warns about the missing public URL.
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_EXPLORER: "off", TYPETORCH_CENTRAL_LOGIN: "off" };
		const c = loadConfig([], { ...base, TYPETORCH_TRUSTED_PROXIES: "10.0.0.0/8, 172.16.0.0/12", TYPETORCH_CLOUDFLARE: "on", HOST: "0.0.0.0", TYPETORCH_TRUST_PROXY: "1" });
		expect(c.trustedProxies?.length).toBe(2);
		expect(c.cloudflareIps?.length).toBe(CLOUDFLARE_IPS.length);
		expect(c.warnings).toEqual([]);
		expect(() => loadConfig([], { ...base, TYPETORCH_TRUSTED_PROXIES: "nope" })).toThrow("TYPETORCH_TRUSTED_PROXIES");
		expect(loadConfig([], { ...base, HOST: "0.0.0.0", TYPETORCH_TRUST_PROXY: "1" }).warnings.join("\n")).toContain("Ports Mappings");
		expect(loadConfig([], { ...base, TYPETORCH_TRUST_PROXY: "1" }).warnings).toEqual([]);
		const rotated = loadConfig([], { ...base, TYPETORCH_API_KEY_PREVIOUS: PREVIOUS });
		expect(rotated.warnings.join("\n")).toContain("TYPETORCH_API_KEY_PREVIOUS is set");
		expect(rotated.warnings.join("\n")).not.toContain(PREVIOUS);
	});

	test("through the app: a client reaching the port directly can't pass the allow list or dodge the lockout with X-Forwarded-For", async () => {
		const h = await harness({ TYPETORCH_TRUST_PROXY: "1", TYPETORCH_TRUSTED_PROXIES: "10.0.0.0/8", TYPETORCH_ADMIN_ALLOW_IPS: "198.51.100.0/24" });
		try {
			const forged = { ...bearer(ADMIN), "x-forwarded-for": "198.51.100.5" };
			expect((await h.call("/v1/settings", { headers: forged, ip: "203.0.113.77" })).status).toBe(404);
			expect((await h.call("/v1/settings", { headers: forged, ip: "10.0.1.2" })).status).toBe(200);
			// Rotating forged addresses from one direct peer: the lockout still counts the peer.
			for (let i = 0; i < 5; i++) await h.call("/v1/settings", { headers: { authorization: "Bearer wrong-token-0123456789abcdef0123456789", "x-forwarded-for": `198.51.100.${i + 10}` }, ip: "198.51.100.200" });
			expect((await h.call("/v1/settings", { headers: { ...bearer(ADMIN), "x-forwarded-for": "198.51.100.99" }, ip: "198.51.100.200" })).status).toBe(429);
		} finally {
			await h.close();
		}
	});
});

describe("fleet routes: stream cap and route names", () => {
	test("GET /v1/fleet/stream is capped like /v1/live", async () => {
		const h = await harness({ TYPETORCH_LIVE_MAX_CLIENTS: "2" });
		try {
			const a = await h.call("/v1/fleet/stream", { headers: bearer(ADMIN) });
			const b = await h.call("/v1/fleet/stream", { headers: bearer(ADMIN) });
			const c = await h.call("/v1/fleet/stream", { headers: bearer(ADMIN) });
			expect([a.status, b.status, c.status]).toEqual([200, 200, 429]);
			await a.body?.cancel();
			await b.body?.cancel();
			await Bun.sleep(20);
			const d = await h.call("/v1/fleet/stream", { headers: bearer(ADMIN) });
			expect(d.status).toBe(200);
			await d.body?.cancel();
		} finally {
			await h.close();
		}
	});

	test("inherited names are not game routes", async () => {
		const h = await harness();
		try {
			for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
				expect((await h.call(`/v1/fleet/${name}`, post(API, { j: "job-x" }))).status).toBe(401);
			}
		} finally {
			await h.close();
		}
	});
});
