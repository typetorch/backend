/**
 * Mobile app tokens (README "Mobile app"): the admin-token mint, the browser sign-in (Sign in with Roblox against a fake
 * Roblox) with its consent page and PKCE, refresh, logout, revocation, expiry, the role re-check, the admin token
 * changing, the redirect_uri allow list, and the store's caps. Every id, key, token and secret is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/fleet/db.ts";
import { startApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { MOBILE_TOKEN_PATTERN, MobileTokens } from "../src/server/mobile-tokens.ts";
import { CLIENT_ID, CLIENT_SECRET, FakeRoblox, OWNER, PUBLIC, makeKey } from "./fake-roblox.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, type Harness } from "./harness.ts";

const VIEWER = 4004;
const OTHER_VIEWER = 5005;
const DAY = 86_400_000;
const REDIRECT = "typetorch://auth/callback";
const b64 = (b: Buffer) => b.toString("base64url");

const tokenPost = (body: unknown, headers: Record<string, string> = {}, ip?: string) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers }, ...(ip ? { ip } : {}) });

describe("mobile app tokens", () => {
	let h: Harness;
	let roblox: FakeRoblox;
	let n = 0;
	const freshIp = () => `10.40.${Math.floor(++n / 250)}.${(n % 250) + 1}`;
	const env = { ROBLOX_OAUTH_CLIENT_ID: CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET: CLIENT_SECRET, TYPETORCH_PUBLIC_URL: PUBLIC, TYPETORCH_WEB_VIEWERS: `${VIEWER},${OTHER_VIEWER}`, TYPETORCH_UNIVERSE_ID: "123456789", TYPETORCH_PARTS: "fleet" };
	const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
	const check = async (token: string, ip = freshIp()) => h.call("/v1/auth/check", { headers: bearer(token), ip });
	const putAccess = (seq: number, owners: number[]) => h.call("/v1/access", { method: "PUT", ...json({ seq, owners }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });

	/** The app's PKCE pair. */
	const pkce = () => {
		const verifier = b64(randomBytes(32));
		return { verifier, challenge: b64(createHash("sha256").update(verifier).digest()) };
	};

	/** The browser part: start, Roblox, the callback; returns the consent page and the browser's cookies. */
	async function browserLogin(o: { sub?: number; redirect?: string; device?: string } = {}) {
		const ip = freshIp();
		const p = pkce();
		const state = b64(randomBytes(16));
		const q = new URLSearchParams({ redirect_uri: o.redirect ?? REDIRECT, state, code_challenge: p.challenge, code_challenge_method: "S256", device: o.device ?? "Pixel 9" });
		const start = await h.call(`/auth/mobile/start?${q}`, { ip });
		expect(start.status).toBe(302);
		expect(start.headers.get("location")).toBe("/v1/auth/roblox/start?mobile=1");
		const mobileSet = cookieOf(start, "tt_mobile") as string;
		for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=600", "Secure"]) expect(mobileSet).toContain(part);
		const mobile = mobileSet.split(";")[0] as string;
		const rs = await h.call("/v1/auth/roblox/start?mobile=1", { ip, headers: { cookie: mobile } });
		expect(rs.status).toBe(302);
		// The mobile start keeps its cookie through the Roblox start.
		expect(cookieOf(rs, "tt_mobile")).toBeUndefined();
		const oauth = (cookieOf(rs, "tt_oauth") as string).split(";")[0] as string;
		const authorizeUrl = rs.headers.get("location") as string;
		const code = roblox.approve(authorizeUrl, (c) => ({ ...c, sub: String(o.sub ?? OWNER), preferred_username: o.sub === VIEWER ? "ViewerName" : "OwnerName" }));
		const cb = await h.call(`/v1/auth/roblox/callback?${new URLSearchParams({ code, state: new URL(authorizeUrl).searchParams.get("state") as string })}`, { ip, headers: { cookie: `${oauth}; ${mobile}` } });
		return { ip, p, state, mobile, cb };
	}

	/** The whole sign-in up to the app's redirect: returns the code. */
	async function signIn(o: { sub?: number; redirect?: string; device?: string } = {}) {
		const b = await browserLogin(o);
		expect(b.cb.status).toBe(302);
		expect(b.cb.headers.get("location")).toBe("/auth/mobile/consent");
		// No explorer session for an app sign-in.
		expect(cookieOf(b.cb, "tt_session")).toBeUndefined();
		const page = await h.call("/auth/mobile/consent", { ip: b.ip, headers: { cookie: b.mobile } });
		expect(page.status).toBe(200);
		const html = await page.text();
		const form = /name="form" value="([^"]+)"/.exec(html)?.[1] as string;
		const res = await h.call("/auth/mobile/consent", { method: "POST", ip: b.ip, body: new URLSearchParams({ form, decision: "allow" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", cookie: b.mobile, origin: "http://backend.test" } });
		expect(res.status).toBe(303);
		const back = new URL(res.headers.get("location") as string);
		return { ...b, html, back, code: back.searchParams.get("code") as string };
	}

	async function redeem(code: string, verifier: string, ip = freshIp()) {
		return h.call("/v1/auth/mobile/token", tokenPost({ code, code_verifier: verifier, device: "ignored" }, {}, ip));
	}

	beforeAll(async () => {
		roblox = new FakeRoblox();
		roblox.keys = [await makeKey("key-1")];
		h = await harness(env, { fetch: roblox.fetch });
		roblox.now = () => h.now();
		expect((await putAccess(1, [OWNER])).status).toBe(200);
	});
	afterAll(() => h.close());

	test("the admin token mints a token (the app never keeps the admin token); it reads and manages like an admin", async () => {
		const res = await h.call("/v1/auth/mobile/token", tokenPost({ device: "My phone" }, bearer(ADMIN)));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await asJson(res);
		expect(body.token).toMatch(MOBILE_TOKEN_PATTERN);
		expect(body).toMatchObject({ role: "admin", user: { kind: "token" }, expiresAt: new Date(h.now() + 60 * DAY).toISOString() });
		expect(body.token.startsWith(`ttm_${body.id}_`)).toBe(true);
		const me = await asJson(await check(body.token));
		expect(me).toMatchObject({ ok: true, role: "admin", via: "bearer", user: { kind: "token" }, mobile: { id: body.id, expiresAt: body.expiresAt }, game: { universeId: 123456789 } });
		expect((await h.call("/v1/fleet/servers", { headers: bearer(body.token) })).status).toBe(200);
		// The admin-token-only routes stay the admin token's: not a token made with it.
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 99, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(body.token) } })).status).toBe(403);
		// Listed (no hash, no secret), audited without the token.
		const list = await asJson(await h.call("/v1/auth/mobile/tokens", { headers: bearer(ADMIN) }));
		expect(list.tokens.find((t: { id: string }) => t.id === body.id)).toMatchObject({ device: "My phone", role: "admin", user: { kind: "token" } });
		expect(JSON.stringify(list)).not.toContain(body.token.split("_")[2]);
		expect(JSON.stringify(list)).not.toMatch(/hash/);
		const audit = await asJson(await h.call("/v1/admin/audit?action=mobile.*", { headers: bearer(ADMIN) }));
		expect(audit.entries.some((e: { action: string; details: { mobile?: string } }) => e.action === "mobile.token.mint" && e.details?.mobile === body.id)).toBe(true);
		expect(JSON.stringify(audit)).not.toContain(body.token);
		expect(h.logs.join("\n")).not.toContain(body.token);
	});

	test("a wrong Bearer can't mint, and counts toward the lockout like every wrong token", async () => {
		const ip = freshIp();
		const res = await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer("not-the-admin-token-0123456789abcdef"), ip));
		expect(res.status).toBe(401);
		const fake = `ttm_abcdefghij_${b64(randomBytes(32))}`;
		for (let i = 0; i < 6; i++) await h.call("/v1/queries", { headers: bearer(fake), ip });
		expect((await h.call("/v1/queries", { headers: bearer(fake), ip })).status).toBe(429);
	});

	test("a revoked or expired token hears 'sign in again' (code mobile_token_dead) and never locks its address out", async () => {
		const ip = freshIp();
		const { token, id } = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN))));
		expect((await h.call(`/v1/auth/mobile/tokens/${id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
		for (let i = 0; i < 8; i++) {
			const res = await h.call("/v1/fleet/servers", { headers: bearer(token), ip });
			expect(res.status).toBe(401);
			expect(await asJson(res)).toMatchObject({ code: "mobile_token_dead", reason: "revoked on the Settings page" });
		}
		expect((await asJson(await h.call("/v1/auth/check", { headers: bearer(token), ip }))).code).toBe("mobile_token_dead");
		// The address is not locked out: the admin token still works from it.
		expect((await h.call("/v1/fleet/servers", { headers: bearer(ADMIN), ip })).status).toBe(200);
		// A forged secret on that id is a wrong token like any other.
		const forged = await h.call("/v1/fleet/servers", { headers: bearer(`ttm_${id}_${b64(randomBytes(32))}`), ip });
		expect((await asJson(forged)).code).toBeUndefined();
		const was = h.now();
		const late = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN))));
		h.setNow(was + 61 * DAY);
		expect(await asJson(await check(late.token))).toMatchObject({ code: "mobile_token_dead", reason: "expired" });
		h.setNow(was);
	});

	test("expiry: refused once the lifetime has passed", async () => {
		const was = h.now();
		const { token } = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN))));
		h.setNow(was + 60 * DAY - 1000);
		expect((await check(token)).status).toBe(200);
		h.setNow(was + 60 * DAY);
		expect((await check(token)).status).toBe(401);
		h.setNow(was);
	});

	test("redirect_uri: typetorch:// only (Expo Go's exp:// is off by default); nothing else is redirected to", async () => {
		const p = pkce();
		const start = (redirect: string, extra: Record<string, string> = {}) =>
			h.call(`/auth/mobile/start?${new URLSearchParams({ redirect_uri: redirect, state: "s1", code_challenge: p.challenge, code_challenge_method: "S256", ...extra })}`, { ip: freshIp() });
		for (const bad of ["https://evil.example/cb", "http://localhost/cb", "javascript:alert(1)", "exp://192.168.1.5:8081/--/auth", "exps://u.expo.dev/x", "typetorch://cb#frag", "typetorch://user:pw@cb", "", "typetorch://a b"]) {
			const res = await start(bad);
			expect(res.status).toBe(400);
			expect(res.headers.get("location")).toBeNull();
			expect(cookieOf(res, "tt_mobile")).toBeUndefined();
			expect(res.headers.get("content-security-policy")).toContain("form-action 'self' typetorch:");
		}
		// PKCE is required: S256 and a 43-character challenge.
		expect((await start(REDIRECT, { code_challenge_method: "plain" })).status).toBe(400);
		expect((await h.call(`/auth/mobile/start?${new URLSearchParams({ redirect_uri: REDIRECT, state: "s", code_challenge: "short", code_challenge_method: "S256" })}`, { ip: freshIp() })).status).toBe(400);
		expect((await start(REDIRECT)).status).toBe(302);
		// The switch turns Expo Go's addresses on.
		const dev = await harness({ ...env, TYPETORCH_MOBILE_DEV_REDIRECTS: "on" }, { fetch: roblox.fetch });
		try {
			const res = await dev.call(`/auth/mobile/start?${new URLSearchParams({ redirect_uri: "exp://192.168.1.5:8081/--/auth", state: "s", code_challenge: p.challenge, code_challenge_method: "S256" })}`);
			expect(res.status).toBe(302);
			expect((await dev.call(`/auth/mobile/start?${new URLSearchParams({ redirect_uri: "https://evil.example", state: "s", code_challenge: p.challenge, code_challenge_method: "S256" })}`)).status).toBe(400);
		} finally {
			await dev.close();
		}
	});

	test("an owner signs in in the browser: consent page, a one-time code to the app, PKCE; admin role, the device's name", async () => {
		const s = await signIn();
		expect(s.html).toContain("OwnerName");
		expect(s.html).toContain("admin");
		expect(s.html).toContain("Pixel 9");
		expect(s.back.protocol).toBe("typetorch:");
		expect(s.back.searchParams.get("state")).toBe(s.state);
		const res = await redeem(s.code, s.p.verifier);
		expect(res.status).toBe(200);
		const body = await asJson(res);
		expect(body).toMatchObject({ role: "admin", user: { kind: "roblox", userId: OWNER, name: "OwnerName" } });
		expect(body.token).toMatch(MOBILE_TOKEN_PATTERN);
		expect((await asJson(await check(body.token))).role).toBe("admin");
		const list = await asJson(await h.call("/v1/auth/mobile/tokens", { headers: bearer(body.token) }));
		expect(list.tokens.find((t: { id: string }) => t.id === body.id)).toMatchObject({ device: "Pixel 9", current: true });
		// The code is single use.
		expect((await redeem(s.code, s.p.verifier)).status).toBe(400);
	});

	test("a PKCE mismatch fails and burns the code; an unknown or expired code fails", async () => {
		const s = await signIn();
		const wrong = await redeem(s.code, pkce().verifier);
		expect(wrong.status).toBe(400);
		expect((await asJson(wrong)).error).toBe("invalid_grant");
		expect((await redeem(s.code, s.p.verifier)).status).toBe(400);
		const late = await signIn();
		const was = h.now();
		h.setNow(was + 61_000);
		expect((await redeem(late.code, late.p.verifier)).status).toBe(400);
		h.setNow(was);
		expect((await redeem(b64(randomBytes(32)), s.p.verifier)).status).toBe(400);
	});

	test("the consent form: its token, the same origin and the pending cookie are all needed; Cancel tells the app access_denied", async () => {
		const b = await browserLogin();
		const html = await (await h.call("/auth/mobile/consent", { ip: b.ip, headers: { cookie: b.mobile } })).text();
		const form = /name="form" value="([^"]+)"/.exec(html)?.[1] as string;
		const post = (fields: Record<string, string>, headers: Record<string, string>) => h.call("/auth/mobile/consent", { method: "POST", ip: b.ip, body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
		expect((await post({ form: "wrong", decision: "allow" }, { cookie: b.mobile })).status).toBe(403);
		expect((await post({ form, decision: "allow" }, { cookie: b.mobile, origin: "https://evil.example" })).status).toBe(403);
		expect((await post({ form, decision: "allow" }, {})).status).toBe(400);
		const cancel = await post({ form, decision: "deny" }, { cookie: b.mobile });
		expect(cancel.status).toBe(303);
		const back = new URL(cancel.headers.get("location") as string);
		expect(back.searchParams.get("error")).toBe("access_denied");
		expect(back.searchParams.get("state")).toBe(b.state);
		expect(back.searchParams.get("code")).toBeNull();
		// One answer per sign-in.
		expect((await post({ form, decision: "allow" }, { cookie: b.mobile })).status).toBe(400);
	});

	test("a stranger is refused: the app hears not_owner, no code", async () => {
		const b = await browserLogin({ sub: 9999 });
		const back = new URL(b.cb.headers.get("location") as string);
		expect(back.protocol).toBe("typetorch:");
		expect(back.searchParams.get("error")).toBe("not_owner");
		expect(back.searchParams.get("code")).toBeNull();
	});

	test("a plain explorer sign-in in the same browser is never captured by an app sign-in left pending", async () => {
		const ip = freshIp();
		const p = pkce();
		const start = await h.call(`/auth/mobile/start?${new URLSearchParams({ redirect_uri: REDIRECT, state: "s", code_challenge: p.challenge, code_challenge_method: "S256" })}`, { ip });
		const mobile = (cookieOf(start, "tt_mobile") as string).split(";")[0] as string;
		const rs = await h.call("/v1/auth/roblox/start", { ip, headers: { cookie: mobile } });
		expect(cookieOf(rs, "tt_mobile")).toContain("Max-Age=0");
		const oauth = (cookieOf(rs, "tt_oauth") as string).split(";")[0] as string;
		const authorizeUrl = rs.headers.get("location") as string;
		const code = roblox.approve(authorizeUrl);
		const cb = await h.call(`/v1/auth/roblox/callback?${new URLSearchParams({ code, state: new URL(authorizeUrl).searchParams.get("state") as string })}`, { ip, headers: { cookie: `${oauth}; ${mobile}` } });
		expect(cb.headers.get("location")).toBe("/");
		expect(cookieOf(cb, "tt_session")).toBeDefined();
	});

	test("refresh rotates: a new token with a fresh expiry, the old one revoked; logout revokes", async () => {
		const s = await signIn();
		const first = await asJson(await redeem(s.code, s.p.verifier));
		const was = h.now();
		h.setNow(was + 50 * DAY);
		const res = await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(first.token), ip: freshIp() });
		expect(res.status).toBe(200);
		const second = await asJson(res);
		expect(second.id).not.toBe(first.id);
		expect(second.expiresAt).toBe(new Date(was + 110 * DAY).toISOString());
		expect(second).toMatchObject({ role: "admin", user: { kind: "roblox", userId: OWNER } });
		expect((await check(first.token)).status).toBe(401);
		expect((await check(second.token)).status).toBe(200);
		// Only a mobile token refreshes; the admin token is not one.
		expect((await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(ADMIN) })).status).toBe(401);
		expect((await h.call("/v1/auth/mobile/logout", { method: "POST", headers: bearer(second.token) })).status).toBe(200);
		expect((await check(second.token)).status).toBe(401);
		const all = await asJson(await h.call("/v1/auth/mobile/tokens?all=1", { headers: bearer(ADMIN) }));
		expect(all.tokens.find((t: { id: string }) => t.id === second.id)).toMatchObject({ revokeReason: "signed out in the app" });
		expect(all.tokens.find((t: { id: string }) => t.id === first.id)).toMatchObject({ revokeReason: "refreshed" });
		h.setNow(was);
	});

	test("the role is re-checked on every request: an owner taken off the list loses the token for good", async () => {
		const s = await signIn();
		const { token } = await asJson(await redeem(s.code, s.p.verifier));
		expect((await check(token)).status).toBe(200);
		expect((await putAccess(2, [7777])).status).toBe(200);
		expect((await check(token)).status).toBe(401);
		expect((await putAccess(3, [OWNER])).status).toBe(200);
		expect((await check(token)).status).toBe(401);
	});

	test("a viewer's token is web: reads, never manages; it lists and revokes only its own tokens", async () => {
		const s = await signIn({ sub: VIEWER });
		expect(s.html).toContain("read-only");
		const viewer = await asJson(await redeem(s.code, s.p.verifier));
		expect(viewer).toMatchObject({ role: "web", user: { kind: "roblox", userId: VIEWER } });
		expect((await h.call("/v1/fleet/servers", { headers: bearer(viewer.token) })).status).toBe(200);
		expect((await h.call("/v1/admin/settings", { headers: bearer(viewer.token) })).status).toBe(403);
		const other = await signIn({ sub: OTHER_VIEWER });
		const otherToken = await asJson(await redeem(other.code, other.p.verifier));
		const mine = await asJson(await h.call("/v1/auth/mobile/tokens", { headers: bearer(viewer.token) }));
		expect(mine.tokens.map((t: { user: { userId: number } }) => t.user.userId)).toEqual([VIEWER]);
		expect((await h.call(`/v1/auth/mobile/tokens/${otherToken.id}`, { method: "DELETE", headers: bearer(viewer.token) })).status).toBe(404);
		expect((await check(otherToken.token)).status).toBe(200);
		// The admin revokes anyone's.
		expect((await h.call(`/v1/auth/mobile/tokens/${otherToken.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
		expect((await check(otherToken.token)).status).toBe(401);
		const own = await h.call(`/v1/auth/mobile/tokens/${viewer.id}`, { method: "DELETE", headers: bearer(viewer.token) });
		expect(own.status).toBe(200);
		expect((await check(viewer.token)).status).toBe(401);
	});

	test("a viewer taken off the list loses its web token", async () => {
		const s = await signIn({ sub: OTHER_VIEWER });
		const { token } = await asJson(await redeem(s.code, s.p.verifier));
		expect((await check(token)).status).toBe(200);
		const patch = await h.call("/v1/admin/settings", { method: "PATCH", ...json({ webViewers: [VIEWER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		expect(patch.status).toBe(200);
		expect((await check(token)).status).toBe(401);
	});

	test("auth/check tells a signed-out app which game this is and that the browser sign-in is on", async () => {
		const res = await h.call("/v1/auth/check", { ip: freshIp() });
		expect(res.status).toBe(401);
		expect(await asJson(res)).toMatchObject({ game: { universeId: 123456789, label: "backend.example.com" }, mobileLogin: true });
	});
});

describe("mobile app tokens: the admin token changing, and restarts", () => {
	test("a token made with the admin token survives a restart and dies when the admin token changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-mobile-"));
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_DATA_DIR: dir, PORT: "0", TYPETORCH_EXPLORER: "off", TYPETORCH_CENTRAL_LOGIN: "off", TYPETORCH_PARTS: "fleet" };
		const open = (admin: string) => startApp(loadConfig([], { ...base, TYPETORCH_ADMIN_TOKEN: admin }), { clock: () => T0, manualJobs: true, log: () => {} });
		const ask = (app: Awaited<ReturnType<typeof open>>, token: string) => app.handle(new Request("http://backend.test/v1/auth/check", { headers: bearer(token) }), "127.0.0.1");
		try {
			let app = await open(ADMIN);
			const { token } = (await (await app.handle(new Request("http://backend.test/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN))), "127.0.0.1")).json()) as { token: string };
			await app.stop();
			app = await open(ADMIN);
			expect((await ask(app, token)).status).toBe(200);
			await app.stop();
			app = await open("a-different-admin-token-0123456789abcdef");
			expect((await ask(app, token)).status).toBe(401);
			await app.stop();
			// Revoked for good, even with the old admin token back.
			app = await open(ADMIN);
			expect((await ask(app, token)).status).toBe(401);
			await app.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("TYPETORCH_MOBILE_TOKEN_DAYS is kept between 30 and 90 (default 60)", () => {
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/unused" };
		expect(loadConfig([], base).mobileTokenDays).toBe(60);
		const low = loadConfig([], { ...base, TYPETORCH_MOBILE_TOKEN_DAYS: "7" });
		expect(low.mobileTokenDays).toBe(30);
		expect(low.warnings.some((w) => w.includes("TYPETORCH_MOBILE_TOKEN_DAYS"))).toBe(true);
		expect(loadConfig([], { ...base, TYPETORCH_MOBILE_TOKEN_DAYS: "365" }).mobileTokenDays).toBe(90);
		expect(loadConfig([], { ...base, TYPETORCH_MOBILE_TOKEN_DAYS: "45" }).mobileTokenDays).toBe(45);
		expect(loadConfig([], base).mobileDevRedirects).toBe(false);
	});
});

describe("mobile app tokens: the store's caps", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "tt-mobile-store-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("past the per-user cap the token used longest ago is revoked; past the server's cap a new user is refused", async () => {
		let now = T0;
		const db = await openSqlite(join(dir, "a.sqlite"));
		const store = await MobileTokens.open(db, { days: 60, clock: () => now, perUser: 2, max: 3 });
		const user = { kind: "roblox" as const, userId: 1, name: "A" };
		const a = await store.mint({ user, role: "admin", device: "a" });
		now += 1000;
		const b = await store.mint({ user, role: "admin", device: "b" });
		now += 1000;
		expect(store.resolve(a.token, "x")?.id).toBe(a.record.id);
		now += 1000;
		const c = await store.mint({ user, role: "admin", device: "c" });
		// b was used longest ago (never), a was used just now.
		expect(store.resolve(b.token, "x")).toBeUndefined();
		expect(store.resolve(a.token, "x")).toBeDefined();
		expect(store.resolve(c.token, "x")).toBeDefined();
		await store.mint({ user: { kind: "roblox", userId: 2, name: "B" }, role: "web", device: "d" });
		await expect(store.mint({ user: { kind: "roblox", userId: 3, name: "C" }, role: "web", device: "e" })).rejects.toThrow("too many");
		// A wrong secret with a right id is refused.
		expect(store.resolve(`ttm_${a.record.id}_${b64(randomBytes(32))}`, "x")).toBeUndefined();
		await db.close();
	});
});
