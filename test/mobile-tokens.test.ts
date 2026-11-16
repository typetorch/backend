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
import { isPrivateNetworkHost, mobileDevRedirectAllowed, parseMobileDevRedirects } from "../src/server/config.ts";
import { MOBILE_TOKEN_PATTERN, MobileTokenError, MobileTokens, REUSE_GRACE_MS } from "../src/server/mobile-tokens.ts";
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
	let hh: Harness;
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
	async function browserLogin(o: { sub?: number; redirect?: string; device?: string; on?: Harness } = {}) {
		const h = o.on ?? hh;
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
	async function signIn(o: { sub?: number; redirect?: string; device?: string; on?: Harness } = {}) {
		const h = o.on ?? hh;
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

	async function redeem(code: string, verifier: string, ip = freshIp(), on: Harness = hh) {
		return on.call("/v1/auth/mobile/token", tokenPost({ code, code_verifier: verifier, device: "ignored" }, {}, ip));
	}

	beforeAll(async () => {
		roblox = new FakeRoblox();
		roblox.keys = [await makeKey("key-1")];
		h = await harness(env, { fetch: roblox.fetch, ssePingSeconds: 0.05 });
		hh = h;
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
		// `on` turns Expo Go's addresses on for loopback and private-network addresses only; a list names any other host.
		const devStart = (app: Harness, redirect: string) => app.call(`/auth/mobile/start?${new URLSearchParams({ redirect_uri: redirect, state: "s", code_challenge: p.challenge, code_challenge_method: "S256" })}`, { ip: freshIp() });
		const dev = await harness({ ...env, TYPETORCH_MOBILE_DEV_REDIRECTS: "on" }, { fetch: roblox.fetch });
		try {
			for (const ok of ["exp://192.168.1.5:8081/--/auth", "exp://10.0.0.2:8081/--/auth", "exp://172.20.1.1/--/x", "exp://127.0.0.1:8081", "exp://localhost:19000/--/x", "exp://[::1]:8081/x"]) expect({ ok, status: (await devStart(dev, ok)).status }).toEqual({ ok, status: 302 });
			for (const bad of ["exp://evil.example:8081/--/auth", "exps://u.expo.dev/x", "exp://abc-anon-8081.exp.direct/--/x", "exp://8.8.8.8:8081/x", "exp://192.168.1.5.nip.io/x", "exp://172.32.0.1/x", "exp:/x", "https://evil.example"]) {
				const res = await devStart(dev, bad);
				expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
				expect(res.headers.get("location")).toBeNull();
			}
		} finally {
			await dev.close();
		}
		const listed = await harness({ ...env, TYPETORCH_MOBILE_DEV_REDIRECTS: "abc-anon-8081.exp.direct, 10.1.2.3:19000" }, { fetch: roblox.fetch });
		try {
			expect((await devStart(listed, "exp://abc-anon-8081.exp.direct/--/x")).status).toBe(302);
			expect((await devStart(listed, "exps://ABC-anon-8081.exp.direct:443/--/x")).status).toBe(302);
			expect((await devStart(listed, "exp://10.1.2.3:19000/--/x")).status).toBe(302);
			// The port is part of a listed entry; a private address is not allowed by a list without `on`.
			expect((await devStart(listed, "exp://10.1.2.3:8081/--/x")).status).toBe(400);
			expect((await devStart(listed, "exp://192.168.1.5:8081/--/x")).status).toBe(400);
			expect((await devStart(listed, "exp://evil.exp.direct/--/x")).status).toBe(400);
		} finally {
			await listed.close();
		}
	});

	test("TYPETORCH_MOBILE_DEV_REDIRECTS: off, on, or a list of host[:port]; a warning when it is on with a public URL", () => {
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/unused" };
		expect(parseMobileDevRedirects(undefined)).toBe(false);
		expect(parseMobileDevRedirects("off")).toBe(false);
		expect(parseMobileDevRedirects("on")).toEqual({ privateNetwork: true, hosts: [] });
		expect(parseMobileDevRedirects("On, Abc.exp.direct ,10.1.2.3:19000")).toEqual({ privateNetwork: true, hosts: ["abc.exp.direct", "10.1.2.3:19000"] });
		for (const bad of ["exp://abc.exp.direct", "a b", "host:99999", "*.exp.direct", "host/path", "user@host"]) expect(() => parseMobileDevRedirects(bad)).toThrow("TYPETORCH_MOBILE_DEV_REDIRECTS");
		for (const yes of ["127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "localhost", "[::1]", "[fd12:3456::1]"]) expect({ yes, ok: isPrivateNetworkHost(yes) }).toEqual({ yes, ok: true });
		for (const no of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "010.0.0.1", "10.0.0.1.nip.io", "example.com", "[2001:db8::1]", "0x7f.1", ""]) expect({ no, ok: isPrivateNetworkHost(no) }).toEqual({ no, ok: false });
		expect(mobileDevRedirectAllowed({ privateNetwork: false, hosts: ["abc.exp.direct"] }, "abc.exp.direct:8081", "abc.exp.direct")).toBe(true);
		expect(mobileDevRedirectAllowed({ privateNetwork: false, hosts: ["abc.exp.direct:443"] }, "abc.exp.direct:8081", "abc.exp.direct")).toBe(false);
		expect(mobileDevRedirectAllowed(false, "10.0.0.1", "10.0.0.1")).toBe(false);
		const warned = (extra: Record<string, string>) => loadConfig([], { ...base, ...extra }).warnings.some((w) => w.includes("TYPETORCH_MOBILE_DEV_REDIRECTS is on while TYPETORCH_PUBLIC_URL is public"));
		expect(warned({ TYPETORCH_MOBILE_DEV_REDIRECTS: "on", TYPETORCH_PUBLIC_URL: "https://backend.example.com" })).toBe(true);
		expect(warned({ TYPETORCH_MOBILE_DEV_REDIRECTS: "abc.exp.direct", TYPETORCH_PUBLIC_URL: "https://backend.example.com" })).toBe(true);
		expect(warned({ TYPETORCH_MOBILE_DEV_REDIRECTS: "on", TYPETORCH_PUBLIC_URL: "http://localhost:8787" })).toBe(false);
		expect(warned({ TYPETORCH_MOBILE_DEV_REDIRECTS: "on", TYPETORCH_PUBLIC_URL: "http://192.168.1.10:8787" })).toBe(false);
		expect(warned({ TYPETORCH_PUBLIC_URL: "https://backend.example.com" })).toBe(false);
	});

	test("an Expo Go sign-in never gets the admin role: an owner gets read-only, and the page says where the code goes", async () => {
		const dev = await harness({ ...env, TYPETORCH_MOBILE_DEV_REDIRECTS: "on" }, { fetch: roblox.fetch });
		try {
			expect((await dev.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
			const s = await signIn({ on: dev, redirect: "exp://192.168.1.5:8081/--/auth" });
			expect(s.back.protocol).toBe("exp:");
			expect(s.html).toContain("read-only");
			expect(s.html).not.toContain("admin (reads and manages)");
			expect(s.html).toContain("<code>192.168.1.5:8081</code>");
			expect(s.html).toContain("Development build");
			const body = await asJson(await redeem(s.code, s.p.verifier, freshIp(), dev));
			expect(body).toMatchObject({ role: "web", user: { kind: "roblox", userId: OWNER } });
			expect((await dev.call("/v1/fleet/servers", { headers: bearer(body.token) })).status).toBe(200);
			expect((await dev.call("/v1/admin/settings", { headers: bearer(body.token) })).status).toBe(403);
		} finally {
			await dev.close();
		}
	});

	test("an owner signs in in the browser: consent page, a one-time code to the app, PKCE; admin role, the device's name", async () => {
		const s = await signIn();
		expect(s.html).toContain("OwnerName");
		expect(s.html).toContain("admin");
		// The device name is the app's own claim, labelled so; where the code goes is shown as the fact.
		expect(s.html).toContain('The app calls itself "Pixel 9" (its own claim');
		expect(s.html).not.toContain("TypeTorch app (<strong>Pixel 9");
		expect(s.html).toContain("<code>typetorch://</code>");
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
		expect((await post({ form, decision: "allow" }, { cookie: b.mobile, origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
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

	/** A plain explorer session (Sign in with Roblox, no app sign-in pending): the cookie. */
	async function explorerSession(sub: number): Promise<string> {
		const ip = freshIp();
		const rs = await h.call("/v1/auth/roblox/start", { ip });
		const oauth = (cookieOf(rs, "tt_oauth") as string).split(";")[0] as string;
		const authorizeUrl = rs.headers.get("location") as string;
		const code = roblox.approve(authorizeUrl, (c) => ({ ...c, sub: String(sub), preferred_username: sub === VIEWER ? "ViewerName" : "OwnerName" }));
		const cb = await h.call(`/v1/auth/roblox/callback?${new URLSearchParams({ code, state: new URL(authorizeUrl).searchParams.get("state") as string })}`, { ip, headers: { cookie: oauth } });
		return (cookieOf(cb, "tt_session") as string).split(";")[0] as string;
	}

	test("every explorer route answers a mobile token exactly as it answers the same user's explorer session (streams included)", async () => {
		const XT = { "x-typetorch": "1", origin: "http://backend.test" };
		const routes: [string, string][] = [
			["GET", "/v1/fleet/servers"],
			["GET", "/v1/fleet/stream"],
			["GET", "/v1/fleet/columns"],
			["GET", "/v1/fleet/live-map"],
			["POST", "/v1/fleet/live-map/watch"],
			["GET", "/v1/live-events"],
			["GET", "/v1/maps"],
			["GET", "/v1/notify/recent"],
			["GET", "/v1/errors"],
			["GET", "/v1/saved-queries"],
			["GET", "/v1/experiments"],
			["GET", "/v1/admin/settings"],
			["GET", "/v1/admin/keys"],
			["GET", "/v1/admin/audit"],
			["GET", "/v1/auth/mobile/tokens"],
		];
		const status = async (method: string, path: string, headers: Record<string, string>) => {
			const res = await h.call(path, { method, headers, ip: freshIp() });
			await res.body?.cancel();
			return res.status;
		};
		for (const sub of [OWNER, VIEWER]) {
			const cookie = await explorerSession(sub);
			const s = await signIn({ sub });
			const { token } = await asJson(await redeem(s.code, s.p.verifier));
			const seen: Record<string, [number, number]> = {};
			for (const [method, path] of routes) seen[`${method} ${path}`] = [await status(method, path, { cookie, ...XT }), await status(method, path, bearer(token))];
			for (const [route, [web, app]] of Object.entries(seen)) {
				expect({ route, sub, status: app }).toEqual({ route, sub, status: web });
				expect({ route, status: app }).not.toEqual({ route, status: 401 });
			}
			// Signed in for real, both ways: the event stream opens for every signed-in role.
			expect(seen["GET /v1/fleet/stream"]).toEqual([200, 200]);
			expect(seen["GET /v1/live-events"]).toEqual([200, 200]);
			// Owners manage, viewers read.
			expect(seen["GET /v1/admin/settings"]?.[1]).toBe(sub === OWNER ? 200 : 403);
			expect(seen["POST /v1/fleet/live-map/watch"]?.[1]).toBe(sub === OWNER ? 200 : 403);
		}
	});

	test("a named API key never mints a mobile token; a mobile admin token never reaches the export API", async () => {
		const made = await asJson(await h.call("/v1/admin/keys", { method: "POST", ...json({ name: "mobile-test-admin", role: "admin" }), headers: { "content-type": "application/json", ...bearer(ADMIN) } }));
		const ip = freshIp();
		const refused = await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(made.key), ip));
		expect(refused.status).toBe(403);
		// Not counted as a wrong token: the same address still mints with the admin token.
		const minted = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN), ip)));
		expect(minted.role).toBe("admin");
		expect((await h.call("/v1/admin/export/manifest", { headers: bearer(minted.token) })).status).toBe(403);
	});

	test("the token login turned off ends the tokens made with the admin token (like its sessions), and the admin token mints none", async () => {
		const byAdmin = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN))));
		const s = await signIn();
		const owner = await asJson(await redeem(s.code, s.p.verifier));
		const patch = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", ...json(body), headers: { "content-type": "application/json", ...bearer(owner.token) } });
		// An owner's app token counts as a Roblox sign-in for the guard, like the owner's explorer session.
		const off = await patch({ tokenLogin: false });
		expect(off.status).toBe(200);
		expect((await asJson(off)).sessionsEnded).toBeGreaterThanOrEqual(1);
		const dead = await check(byAdmin.token);
		expect(dead.status).toBe(401);
		expect(await asJson(dead)).toMatchObject({ code: "mobile_token_dead", reason: "token login turned off" });
		expect((await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN)))).status).toBe(403);
		expect((await check(owner.token)).status).toBe(200);
		expect((await patch({ tokenLogin: true })).status).toBe(200);
		// Revoked for good.
		expect((await check(byAdmin.token)).status).toBe(401);
		expect((await h.call("/v1/auth/mobile/token", tokenPost({ device: "x" }, bearer(ADMIN)))).status).toBe(200);
	});

	test("the consent page asks for a same-origin Referer, and its form POST with Origin: null works (a foreign Origin still doesn't)", async () => {
		const b = await browserLogin();
		const page = await h.call("/auth/mobile/consent", { ip: b.ip, headers: { cookie: b.mobile } });
		expect(page.headers.get("referrer-policy")).toBe("same-origin");
		const html = await page.text();
		expect(html).toContain('<meta name="referrer" content="same-origin">');
		// Every other response keeps no-referrer.
		expect((await h.call("/v1/auth/check", { ip: freshIp() })).headers.get("referrer-policy")).toBe("no-referrer");
		const form = /name="form" value="([^"]+)"/.exec(html)?.[1] as string;
		const post = (origin: string) => h.call("/auth/mobile/consent", { method: "POST", ip: b.ip, body: new URLSearchParams({ form, decision: "allow" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", cookie: b.mobile, origin } });
		const foreign = await post("https://evil.example");
		expect(foreign.status).toBe(403);
		expect(foreign.headers.get("location")).toBeNull();
		const ok = await post("null");
		expect(ok.status).toBe(303);
		const back = new URL(ok.headers.get("location") as string);
		expect(back.searchParams.get("state")).toBe(b.state);
		expect((await redeem(back.searchParams.get("code") as string, b.p.verifier)).status).toBe(200);
	});

	test("the consent routes are rate limited per address and honour the lockout (a wrong form token counts)", async () => {
		const ip = freshIp();
		let last = 0;
		for (let i = 0; i < 31; i++) last = (await h.call("/auth/mobile/consent", { ip })).status;
		expect(last).toBe(429);
		expect((await h.call("/auth/mobile/consent", { method: "POST", ip, body: "form=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(429);
		// Wrong form tokens lock the address out (5 failures), for the page and for the rest of the admin side.
		const b = await browserLogin();
		for (let i = 0; i < 5; i++) {
			const res = await h.call("/auth/mobile/consent", { method: "POST", ip: b.ip, body: new URLSearchParams({ form: `wrong-${i}`, decision: "allow" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", cookie: b.mobile, origin: "http://backend.test" } });
			expect(res.status).toBe(403);
		}
		expect((await h.call("/auth/mobile/consent", { ip: b.ip, headers: { cookie: b.mobile } })).status).toBe(429);
		expect((await h.call("/v1/fleet/servers", { ip: b.ip, headers: bearer(ADMIN) })).status).toBe(429);
	});

	test("parallel refreshes of one token make exactly one new token; the others are refused", async () => {
		const first = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "race" }, bearer(ADMIN))));
		const ip = freshIp();
		const answers = await Promise.all([0, 1, 2, 3].map(() => h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(first.token), ip })));
		const statuses = answers.map((r) => r.status);
		expect(statuses.filter((s) => s === 200)).toHaveLength(1);
		for (const s of statuses) expect([200, 401, 409]).toContain(s);
		const bodies = await Promise.all(answers.map((r) => asJson(r)));
		const winner = bodies[statuses.indexOf(200)] as Record<string, any>;
		expect((await check(winner.token)).status).toBe(200);
		expect((await check(first.token)).status).toBe(401);
		// One family member is live: the old one revoked "refreshed", one child.
		const all = await asJson(await h.call("/v1/auth/mobile/tokens?all=1", { headers: bearer(ADMIN) }));
		const race = all.tokens.filter((t: { device: string; revokedAt?: string }) => t.device === "race");
		expect(race.filter((t: { revokedAt?: string }) => !t.revokedAt)).toHaveLength(1);
		expect(race).toHaveLength(2);
		expect(h.logs.join("\n")).not.toContain(winner.token);
	});

	test("reuse detection: a refreshed token presented again (past a 10 s grace) revokes the token it was replaced by", async () => {
		const was = h.now();
		const a = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "reuse" }, bearer(ADMIN))));
		const b = await asJson(await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(a.token), ip: freshIp() }));
		// A request that was already on its way: refused, nothing else happens.
		h.setNow(was + 5_000);
		expect(await asJson(await check(a.token))).toMatchObject({ code: "mobile_token_dead", reason: "refreshed" });
		expect((await check(b.token)).status).toBe(200);
		const c = await asJson(await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(b.token), ip: freshIp() }));
		expect((await check(c.token)).status).toBe(200);
		// The first token again, later: the whole sign-in ends (c, b's child, included).
		h.setNow(was + 60_000);
		const again = await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(a.token), ip: freshIp() });
		expect(again.status).toBe(401);
		expect(await asJson(again)).toMatchObject({ code: "mobile_token_dead", reason: "refreshed" });
		expect(await asJson(await check(c.token))).toMatchObject({ code: "mobile_token_dead", reason: "a refreshed token was used again" });
		const audit = await asJson(await h.call("/v1/admin/audit?action=mobile.*", { headers: bearer(ADMIN) }));
		expect(audit.entries.some((e: { action: string; details?: { mobile?: string; reason?: string } }) => e.action === "mobile.token.revoke" && e.details?.mobile === a.id && e.details?.reason === "a refreshed token was used again")).toBe(true);
		h.setNow(was);
	});

	test("refresh keeps the sign-in's time: no token outlives TYPETORCH_MOBILE_TOKEN_MAX_DAYS (180) after the sign-in", async () => {
		const was = h.now();
		const s = await signIn({ sub: VIEWER });
		let token = (await asJson(await redeem(s.code, s.p.verifier))).token as string;
		const refresh = async (day: number) => {
			h.setNow(was + day * DAY);
			const res = await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(token), ip: freshIp() });
			const body = await asJson(res);
			if (res.status === 200) token = body.token;
			return { status: res.status, body };
		};
		expect((await refresh(50)).body.expiresAt).toBe(new Date(was + 110 * DAY).toISOString());
		expect((await refresh(100)).body.expiresAt).toBe(new Date(was + 160 * DAY).toISOString());
		// Capped at the sign-in + 180 days.
		expect((await refresh(150)).body.expiresAt).toBe(new Date(was + 180 * DAY).toISOString());
		const late = await refresh(170);
		expect(late.status).toBe(403);
		expect(late.body.code).toBe("mobile_signin_too_old");
		h.setNow(was + 180 * DAY - 1000);
		expect((await check(token)).status).toBe(200);
		h.setNow(was + 180 * DAY);
		expect((await check(token)).status).toBe(401);
		h.setNow(was);
	});

	/** Reads an event stream until it ends (true) or `ms` pass (false). */
	async function endsWithin(res: Response, ms: number): Promise<{ ended: boolean; text: string }> {
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const next = await Promise.race([reader.read(), new Promise<"wait">((r) => setTimeout(() => r("wait"), Math.max(1, deadline - Date.now())))]);
			if (next === "wait") break;
			if (next.done) return { ended: true, text };
			text += decoder.decode(next.value);
		}
		await reader.cancel().catch(() => {});
		return { ended: false, text };
	}

	test("open event streams close once their mobile token is revoked (GET /v1/live, GET /v1/fleet/stream); live ones stay open", async () => {
		for (const path of ["/v1/live", "/v1/fleet/stream"]) {
			const doomed = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "stream" }, bearer(ADMIN))));
			const kept = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "stream" }, bearer(ADMIN))));
			const a = await h.call(path, { headers: bearer(doomed.token) });
			const b = await h.call(path, { headers: bearer(kept.token) });
			expect([a.status, b.status]).toEqual([200, 200]);
			expect((await h.call(`/v1/auth/mobile/tokens/${doomed.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
			const closed = await endsWithin(a, 2000);
			expect({ path, ended: closed.ended }).toEqual({ path, ended: true });
			const open = await endsWithin(b, 300);
			expect({ path, ended: open.ended }).toEqual({ path, ended: false });
			expect(open.text).toContain(": ping");
		}
	});

	test("an open stream closes when its session ends or its owner loses the role", async () => {
		const cookie = await explorerSession(OWNER);
		const s = await signIn();
		const { token } = await asJson(await redeem(s.code, s.p.verifier));
		const viaCookie = await h.call("/v1/live", { headers: { cookie } });
		const viaToken = await h.call("/v1/fleet/stream", { headers: bearer(token) });
		expect([viaCookie.status, viaToken.status]).toEqual([200, 200]);
		expect((await putAccess(10, [7777])).status).toBe(200);
		try {
			expect((await endsWithin(viaCookie, 2000)).ended).toBe(true);
			expect((await endsWithin(viaToken, 2000)).ended).toBe(true);
		} finally {
			expect((await putAccess(11, [OWNER])).status).toBe(200);
		}
		// Signing out ends a session's stream too.
		const second = await explorerSession(OWNER);
		const stream = await h.call("/v1/live", { headers: { cookie: second } });
		expect(stream.status).toBe(200);
		expect((await h.call("/v1/auth/logout", { method: "POST", headers: { cookie: second, "x-typetorch": "1", origin: "http://backend.test" } })).status).toBe(200);
		expect((await endsWithin(stream, 2000)).ended).toBe(true);
	});

	test("revoke all: owners sign every phone out at once (audited); the web role can't; a cookie needs the CSRF header", async () => {
		const byAdmin = await asJson(await h.call("/v1/auth/mobile/token", tokenPost({ device: "all-1" }, bearer(ADMIN))));
		const s = await signIn();
		const owner = await asJson(await redeem(s.code, s.p.verifier));
		const v = await signIn({ sub: VIEWER });
		const viewer = await asJson(await redeem(v.code, v.p.verifier));
		expect((await h.call("/v1/auth/mobile/tokens/revoke-all", { method: "POST", headers: bearer(viewer.token) })).status).toBe(403);
		expect((await h.call("/v1/auth/mobile/tokens/revoke-all", { method: "GET", headers: bearer(ADMIN) })).status).toBe(405);
		const cookie = await explorerSession(OWNER);
		expect((await h.call("/v1/auth/mobile/tokens/revoke-all", { method: "POST", headers: { cookie } })).status).toBe(403);
		for (const t of [byAdmin, owner, viewer]) expect((await check(t.token)).status).toBe(200);
		const res = await h.call("/v1/auth/mobile/tokens/revoke-all", { method: "POST", headers: { cookie, "x-typetorch": "1", origin: "http://backend.test" } });
		expect(res.status).toBe(200);
		const body = await asJson(res);
		expect(body.revoked).toBeGreaterThanOrEqual(3);
		expect(body.tokens).toEqual([]);
		for (const t of [byAdmin, owner, viewer]) expect(await asJson(await check(t.token))).toMatchObject({ code: "mobile_token_dead", reason: "every token revoked on the Settings page" });
		const audit = await asJson(await h.call("/v1/admin/audit?action=mobile.*", { headers: bearer(ADMIN) }));
		expect(audit.entries.some((e: { action: string; details?: { revoked?: number } }) => e.action === "mobile.token.revoke-all" && e.details?.revoked === body.revoked)).toBe(true);
		// New sign-ins work again afterwards.
		expect((await h.call("/v1/auth/mobile/token", tokenPost({ device: "after" }, bearer(ADMIN)))).status).toBe(200);
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

	test("TYPETORCH_MOBILE_TOKEN_MAX_DAYS: default 180, at least the token lifetime, at most 730", () => {
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/unused" };
		expect(loadConfig([], base).mobileTokenMaxDays).toBe(180);
		expect(loadConfig([], { ...base, TYPETORCH_MOBILE_TOKEN_MAX_DAYS: "365" }).mobileTokenMaxDays).toBe(365);
		const low = loadConfig([], { ...base, TYPETORCH_MOBILE_TOKEN_MAX_DAYS: "45" });
		expect(low.mobileTokenMaxDays).toBe(60);
		expect(low.warnings.some((w) => w.includes("TYPETORCH_MOBILE_TOKEN_MAX_DAYS"))).toBe(true);
		expect(loadConfig([], { ...base, TYPETORCH_MOBILE_TOKEN_MAX_DAYS: "5000" }).mobileTokenMaxDays).toBe(730);
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

	test("reload picks up what another process made or revoked (a rolling deploy's handover)", async () => {
		const now = T0;
		const db = await openSqlite(join(dir, "b.sqlite"));
		const mine = await MobileTokens.open(db, { days: 60, clock: () => now });
		const other = await MobileTokens.open(db, { days: 60, clock: () => now });
		const user = { kind: "roblox" as const, userId: 9, name: "N" };
		const made = await other.mint({ user, role: "web", device: "p" });
		expect(mine.resolve(made.token, "x")).toBeUndefined();
		await mine.reload();
		expect(mine.resolve(made.token, "x")?.id).toBe(made.record.id);
		await other.revoke(made.record.id, "signed out in the app");
		await mine.reload();
		expect(mine.resolve(made.token, "x")).toBeUndefined();
		expect(mine.deadReason(made.token)).toBe("signed out in the app");
		await db.close();
	});

	test("refresh: parallel calls make one token; a failed mint gives the claim back; a revoke during the refresh revokes the new one", async () => {
		let now = T0;
		const real = await openSqlite(join(dir, "c.sqlite"));
		let failInsert = false;
		const db: typeof real = {
			exec: (sql) => real.exec(sql),
			run: (sql, params) => (failInsert && sql.startsWith("INSERT") ? Promise.reject(new Error("disk full")) : real.run(sql, params)),
			all: (sql, params) => real.all(sql, params),
			first: (sql, params) => real.first(sql, params),
			transaction: (fn) => real.transaction(fn),
			close: () => real.close(),
		};
		const store = await MobileTokens.open(db, { days: 60, clock: () => now });
		const user = { kind: "roblox" as const, userId: 5, name: "R" };
		const a = await store.mint({ user, role: "web", device: "p" });
		const results = await Promise.allSettled([0, 1, 2, 3, 4].map(() => store.refresh(a.record.id)));
		const ok = results.filter((r) => r.status === "fulfilled");
		expect(ok).toHaveLength(1);
		for (const r of results) if (r.status === "rejected") expect((r.reason as MobileTokenError).status).toBe(409);
		expect(store.size).toBe(1);
		const b = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<MobileTokens["refresh"]>>>).value;
		expect(b.record.family).toBe(a.record.family);
		expect(b.record.signedIn).toBe(a.record.signedIn);
		expect(store.resolve(a.token, "x")).toBeUndefined();
		// A mint that fails gives the claim back: the next refresh works.
		failInsert = true;
		await expect(store.refresh(b.record.id)).rejects.toThrow("disk full");
		failInsert = false;
		now += 1000;
		const c = await store.refresh(b.record.id);
		expect(store.resolve(c.token, "x")?.id).toBe(c.record.id);
		// Revoked while the new token is being made: the new one goes too.
		now += 1000;
		const pending = store.refresh(c.record.id);
		await store.revoke(c.record.id, "revoked on the Settings page");
		await expect(pending).rejects.toMatchObject({ status: 401 });
		expect(store.size).toBe(0);
		await db.close();
	});

	test("reuse detection after a restart, and a table from before the sign-in time and family columns", async () => {
		let now = T0;
		const path = join(dir, "d.sqlite");
		const old = await openSqlite(path);
		await old.exec(`CREATE TABLE mobile_tokens (
	id TEXT PRIMARY KEY, hash TEXT NOT NULL, user_kind TEXT NOT NULL, user_id INTEGER, user_name TEXT, login TEXT, role TEXT NOT NULL,
	device_name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER,
	revoke_reason TEXT, admin_token_hash TEXT, blessed_device TEXT)`);
		const legacy = `ttm_abcdefghij_${b64(randomBytes(32))}`;
		await old.run("INSERT INTO mobile_tokens (id, hash, user_kind, user_id, user_name, login, role, device_name, created_at, expires_at) VALUES ('abcdefghij', ?, 'roblox', 8, 'L', 'roblox', 'web', 'old phone', ?, ?)", [
			createHash("sha256").update(legacy).digest("hex"),
			T0 - 10 * DAY,
			T0 + 50 * DAY,
		]);
		await old.close();
		let db = await openSqlite(path);
		let store = await MobileTokens.open(db, { days: 60, maxDays: 180, clock: () => now });
		const rec = store.resolve(legacy, "x");
		expect(rec).toMatchObject({ id: "abcdefghij", family: "abcdefghij", signedIn: T0 - 10 * DAY });
		const child = await store.refresh("abcdefghij");
		expect(child.record.expires).toBe(T0 + 60 * DAY);
		await db.close();
		// A restart keeps what reuse detection needs.
		db = await openSqlite(path);
		const seen: string[] = [];
		store = await MobileTokens.open(db, { days: 60, maxDays: 180, clock: () => now, onReuse: (i) => seen.push(`${i.id} ${i.revoked} ${i.user.kind}`) });
		expect(store.resolve(child.token, "x")?.signedIn).toBe(T0 - 10 * DAY);
		now += REUSE_GRACE_MS + 1;
		expect(store.deadReason(legacy)).toBe("refreshed");
		expect(store.resolve(child.token, "x")).toBeUndefined();
		expect(store.deadReason(child.token)).toBe("a refreshed token was used again");
		expect(seen).toEqual(["abcdefghij 1 roblox"]);
		await db.close();
	});
});
