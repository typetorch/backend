/**
 * Sign in with typetorch.dev (plans typetorch-dev-login, "Backend changes" tests): the whole flow against a fake broker
 * (its own Ed25519 key pair, /authorize, /token, /report with the origin challenge, the JWKS, the login metadata at
 * /.well-known/typetorch-login that names TypeTorch's Roblox client id and discovery) and a fake Roblox (an
 * ES256 key pair, discovery, JWKS). Nothing leaves the process: every request goes to the fake fetch below, and every
 * id, key, token and secret is made up here. No real typetorch.dev or Roblox is ever called.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeConfig, loadConfig } from "../src/server/config.ts";
import { CentralLogin } from "../src/server/central-login.ts";
import { ROBLOX_DISCOVERY_URL } from "../src/server/roblox-oauth.ts";
import { canonicalReport } from "../src/server/central-report.ts";
import { blessMessage } from "../src/server/devices.ts";
import { fingerprintOf, FINGERPRINT_PATTERN } from "../src/server/instance-key.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, type Harness } from "./harness.ts";

const BROKER = "https://broker.test";
const PUBLIC = "https://backend.example.com";
const ROBLOX_ISSUER = "https://roblox.test/oauth/";
// Roblox's real discovery URL (the default pin of an unpinned backend); the fake fetch below answers it, nothing leaves the process.
const ROBLOX_DISCOVERY = ROBLOX_DISCOVERY_URL;
const ROBLOX_JWKS = "https://roblox.test/oauth/v1/certs";
const BROKER_CLIENT_ID = "8888000011112222";
const OWNER = 1001;
const VIEWER = 4004;
const STRANGER = 7007;
const XT = { "x-typetorch": "1" };
const b64 = (bytes: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).toString("base64url");
const sec = (ms: number) => Math.floor(ms / 1000);

interface RobloxKey {
	kid: string;
	privateKey: CryptoKey;
	jwk: Record<string, unknown>;
}

async function robloxKey(kid: string): Promise<RobloxKey> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
	return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
}

async function robloxJwt(key: RobloxKey, claims: Record<string, unknown>): Promise<string> {
	const head = b64(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid }));
	const body = b64(JSON.stringify(claims));
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64(signature)}`;
}

interface BrokerKey {
	kid: string;
	privateKey: KeyObject;
	x: string;
}

function brokerKey(kid: string): BrokerKey {
	const pair = generateKeyPairSync("ed25519");
	const x = (pair.publicKey.export({ format: "jwk" }) as { x: string }).x;
	return { kid, privateKey: pair.privateKey, x };
}

function jws(key: BrokerKey, claims: Record<string, unknown>, kid = key.kid): string {
	const head = b64(JSON.stringify({ alg: "EdDSA", kid, typ: "JWT" }));
	const body = b64(JSON.stringify(claims));
	return `${head}.${body}.${b64(edSign(null, Buffer.from(`${head}.${body}`), key.privateKey))}`;
}

/** How one login should go wrong (or not): changes to the assertion, the Roblox ID token, or who signs them. */
interface Twist {
	sub?: number;
	assertion?: (claims: Record<string, unknown>) => Record<string, unknown>;
	roblox?: (claims: Record<string, unknown>) => Record<string, unknown>;
	assertionKid?: string;
	assertionSigner?: BrokerKey;
	robloxSigner?: RobloxKey;
	jti?: string;
}

interface Code {
	fingerprint: string;
	redirectUri: string;
	nonce: string;
	challenge: string;
	used: boolean;
	twist: Twist;
}

/** A fake typetorch.dev (the contract of plans/dash-agent-prompt.md) and a fake Roblox, behind one fetch. */
class Fakes {
	brokerKeys: BrokerKey[] = [brokerKey("broker-k1")];
	robloxKeys: RobloxKey[] = [];
	codes = new Map<string, Code>();
	/** fingerprint -> stored origin (the project's current address). */
	origins = new Map<string, string>();
	pendingChallenge = new Map<string, { origin: string; token: string }>();
	challengesIssued: string[] = [];
	reportTokens = new Map<string, string>();
	reports: { body: Record<string, unknown>; auth?: string; status: number }[] = [];
	calls = { token: 0, jwks: 0, report: 0, metadata: 0 };
	tokenStatus = 200;
	/** What /.well-known/typetorch-login answers (dash publishes its Roblox client id and discovery there). */
	metadata: Record<string, unknown> = { issuer: BROKER, jwks_uri: `${BROKER}/.well-known/jwks.json`, roblox_client_id: BROKER_CLIENT_ID, roblox_discovery: ROBLOX_DISCOVERY };
	metadataStatus = 200;
	h?: Harness;
	now = () => this.h?.now() ?? T0;

	readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url === ROBLOX_DISCOVERY) return reply({ issuer: ROBLOX_ISSUER, authorization_endpoint: "https://roblox.test/oauth/v1/authorize", token_endpoint: "https://roblox.test/oauth/v1/token", jwks_uri: ROBLOX_JWKS });
		if (url === ROBLOX_JWKS) return reply({ keys: this.robloxKeys.map((k) => k.jwk) });
		if (url === `${BROKER}/.well-known/jwks.json`) {
			this.calls.jwks++;
			return reply({ keys: this.brokerKeys.map((k) => ({ kty: "OKP", crv: "Ed25519", kid: k.kid, x: k.x, use: "sig", alg: "EdDSA" })) });
		}
		if (url === `${BROKER}/.well-known/typetorch-login`) {
			this.calls.metadata++;
			return reply(this.metadata, this.metadataStatus);
		}
		if (url === `${BROKER}/token` && init?.method === "POST") {
			this.calls.token++;
			if (this.tokenStatus !== 200) return reply({ error: "invalid_grant", leaked: "broker-detail-never-shown" }, this.tokenStatus);
			const body = JSON.parse(String(init.body)) as Record<string, string>;
			const code = this.codes.get(body.code ?? "");
			if (body.grant_type !== "authorization_code" || !code) return reply({ error: "invalid_grant" }, 400);
			if (code.used) return reply({ error: "invalid_grant" }, 400);
			if (body.redirect_uri !== code.redirectUri) return reply({ error: "invalid_grant" }, 400);
			if (b64(createHash("sha256").update(body.code_verifier ?? "").digest()) !== code.challenge) return reply({ error: "invalid_grant" }, 400);
			code.used = true;
			const t = code.twist;
			const sub = String(t.sub ?? OWNER);
			const iat = sec(this.now());
			const assertionClaims = { iss: BROKER, aud: code.fingerprint, sub, name: "PersonName", display_name: "Person", nonce: code.nonce, iat, exp: iat + 120, jti: t.jti ?? b64(randomBytes(16)) };
			const robloxClaims = { iss: ROBLOX_ISSUER, aud: BROKER_CLIENT_ID, sub, nonce: code.nonce, iat, exp: iat + 900, preferred_username: "PersonName", nickname: "Person" };
			const assertion = jws(t.assertionSigner ?? (this.brokerKeys[0] as BrokerKey), t.assertion ? t.assertion(assertionClaims) : assertionClaims, t.assertionKid);
			const roblox_id_token = await robloxJwt(t.robloxSigner ?? (this.robloxKeys[0] as RobloxKey), t.roblox ? t.roblox(robloxClaims) : robloxClaims);
			return reply({ assertion, roblox_id_token, sub, name: "PersonName", display_name: "Person" });
		}
		if (url === `${BROKER}/report` && init?.method === "POST") return this.report(init);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	/** POST /report as dash does it: signature or bearer, iat window, the challenge for a new origin. */
	private async report(init: RequestInit): Promise<Response> {
		this.calls.report++;
		const reply = (body: unknown, status: number) => {
			this.reports.push({ body: JSON.parse(String(init.body)), ...(auth ? { auth } : {}), status });
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		};
		const auth = new Headers(init.headers).get("authorization") ?? undefined;
		const b = JSON.parse(String(init.body)) as Record<string, unknown>;
		const fingerprint = String(b.fingerprint);
		if (auth) {
			const owner = this.reportTokens.get(auth.replace(/^Bearer /, ""));
			if (owner !== fingerprint) return reply({ error: "unauthorized" }, 401);
		} else {
			const pub = Buffer.from(String(b.public_key), "base64");
			if (fingerprintOf(pub) !== fingerprint) return reply({ error: "unauthorized" }, 401);
			const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") }, format: "jwk" });
			const canonical = JSON.stringify({ fingerprint: b.fingerprint, origin: b.origin, label: b.label, iat: b.iat });
			if (!edVerify(null, Buffer.from(canonical), key, Buffer.from(String(b.signature), "base64"))) return reply({ error: "unauthorized" }, 401);
		}
		if (typeof b.iat !== "number" || Math.abs(sec(this.now()) - b.iat) > 300) return reply({ error: "unauthorized" }, 401);
		if (typeof b.label !== "string" || b.label.length > 64) return reply({ error: "bad_request" }, 400);
		const origin = String(b.origin);
		if (this.origins.get(fingerprint) !== origin) {
			const pending = this.pendingChallenge.get(fingerprint);
			if (pending && pending.origin === origin && this.h) {
				// The challenge fetch: the backend's own route, through app.handle (the "network").
				const res = await this.h.app.handle(new Request(`${origin}/api/typetorch/challenge/${pending.token}`), "203.0.113.50");
				if (res.status === 200 && (await res.text()) === pending.token) {
					this.origins.set(fingerprint, origin);
					this.pendingChallenge.delete(fingerprint);
				}
			}
			if (this.origins.get(fingerprint) !== origin) {
				const token = b64(randomBytes(32));
				this.challengesIssued.push(token);
				this.pendingChallenge.set(fingerprint, { origin, token });
				return reply({ challenge: token, retry_after: 2 }, 202);
			}
		}
		const access = b64(randomBytes(32));
		this.reportTokens.set(access, fingerprint);
		return reply({ ok: true, origin, access_token: access, expires_in: 3600 }, 200);
	}

	/** What /authorize and the person do: the authorize URL goes in, the callback URL with a code comes out. */
	authorize(authorizeUrl: string, twist: Twist = {}): string {
		const q = new URL(authorizeUrl).searchParams;
		const code = b64(randomBytes(32));
		this.codes.set(code, { fingerprint: q.get("project") as string, redirectUri: q.get("redirect_uri") as string, nonce: q.get("nonce") as string, challenge: q.get("code_challenge") as string, used: false, twist });
		const back = new URL(q.get("redirect_uri") as string);
		back.searchParams.set("code", code);
		back.searchParams.set("state", q.get("state") as string);
		return back.toString();
	}
}

const ENV = {
	TYPETORCH_PUBLIC_URL: PUBLIC,
	TYPETORCH_CENTRAL_LOGIN: "on",
	TYPETORCH_CENTRAL_LOGIN_ISSUER: BROKER,
	TYPETORCH_WEB_VIEWERS: String(VIEWER),
	// Most tests here cover the trusted-browser flow; the default (admin) has its own describe below.
	TYPETORCH_CENTRAL_LOGIN_UNBLESSED: "web",
};
/** The optional pins of the broker's published Roblox settings. */
const PINS = { TYPETORCH_ROBLOX_BROKER_CLIENT_ID: BROKER_CLIENT_ID, TYPETORCH_ROBLOX_BROKER_DISCOVERY: ROBLOX_DISCOVERY };

interface Login {
	status: number;
	location: string;
	session?: string;
	device?: string;
	res: Response;
}

/** Shared steps of a login against one harness. */
function client(get: () => { h: Harness; fakes: Fakes }) {
	let n = 0;
	const freshIp = () => `10.30.${Math.floor(++n / 250)}.${(n % 250) + 1}`;
	const cookieValue = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
	async function start(ip: string, extra: Record<string, string> = {}) {
		const res = await get().h.call("/auth/typetorch/start", { ip, headers: extra });
		expect(res.status).toBe(302);
		const set = cookieValue(res, "tt_central") as string;
		return { authorizeUrl: res.headers.get("location") as string, cookie: set.split(";")[0] as string, setCookie: set };
	}
	async function callback(callbackUrl: string, cookies: string[], ip: string): Promise<Login> {
		const u = new URL(callbackUrl);
		const res = await get().h.call(`${u.pathname}${u.search}`, { ip, headers: cookies.length ? { cookie: cookies.join("; ") } : {} });
		const session = cookieValue(res, "tt_session")?.split(";")[0];
		const device = cookieValue(res, "tt_device")?.split(";")[0];
		return { status: res.status, location: res.headers.get("location") ?? "", ...(session && session !== "tt_session=" ? { session } : {}), ...(device ? { device } : {}), res };
	}
	/** One full login: start, the broker, the callback. `device` is a tt_device cookie to present. */
	async function login(twist: Twist = {}, o: { device?: string; ip?: string } = {}): Promise<Login> {
		const ip = o.ip ?? freshIp();
		const s = await start(ip);
		return callback(get().fakes.authorize(s.authorizeUrl, twist), [s.cookie, ...(o.device ? [o.device] : [])], ip);
	}
	return { freshIp, start, callback, login, cookieValue };
}

describe("Sign in with typetorch.dev", () => {
	let h: Harness;
	let fakes: Fakes;
	const c = client(() => ({ h, fakes }));
	const role = async (session: string | undefined) => (await asJson(await h.call("/v1/auth/check", { headers: session ? { cookie: session } : {} }))).role as string | undefined;
	const blessWithToken = async (token = ADMIN, ip = c.freshIp()) => h.call("/auth/device", { method: "POST", ip, ...json({ token }), headers: { "content-type": "application/json", ...XT } });

	beforeAll(async () => {
		fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		h = await harness(ENV, { fetch: fakes.fetch, reportSleep: async () => {} });
		fakes.h = h;
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
	});
	afterAll(() => h.close());

	test("the instance key: made on first start (0600 where the OS has modes), a tt1- fingerprint of its public key", () => {
		const file = join(h.dir, "instance.key");
		expect(existsSync(file)).toBe(true);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(h.app.central?.fingerprint).toMatch(FINGERPRINT_PATTERN);
		expect(h.logs.join("\n")).not.toContain("PRIVATE KEY");
	});

	test("the login page learns of the third way; /healthz shows the fingerprint to the admin token only", async () => {
		expect((await asJson(await h.call("/v1/auth/check"))).login).toEqual({ token: true, roblox: false, typetorch: true, dashboard: BROKER });
		// Signed in, the check names the dashboard (the broker's origin) too; nothing else of the broker's settings.
		const signed = await asJson(await h.call("/v1/auth/check", { headers: bearer(ADMIN) }));
		expect(signed.dashboard).toBe(BROKER);
		expect(JSON.stringify(signed)).not.toContain(h.app.central?.fingerprint as string);
		expect(await asJson(await h.call("/healthz"))).toEqual({ ok: true });
		expect((await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }))).central).toMatchObject({ fingerprint: h.app.central?.fingerprint, issuer: BROKER });
	});

	test("start: a redirect to the broker's /authorize with project, redirect_uri, state, nonce, S256 challenge; a Lax HttpOnly state cookie", async () => {
		const s = await c.start(c.freshIp());
		const u = new URL(s.authorizeUrl);
		expect(`${u.origin}${u.pathname}`).toBe(`${BROKER}/authorize`);
		const q = u.searchParams;
		expect(q.get("response_type")).toBe("code");
		expect(q.get("project")).toBe(h.app.central?.fingerprint as string);
		expect(q.get("redirect_uri")).toBe(`${PUBLIC}/auth/typetorch/callback`);
		expect(q.get("code_challenge_method")).toBe("S256");
		expect((q.get("state") as string).length).toBeGreaterThanOrEqual(43);
		expect((q.get("nonce") as string).length).toBeGreaterThanOrEqual(43);
		expect((q.get("code_challenge") as string).length).toBe(43);
		expect(q.has("client_id")).toBe(false);
		expect(s.setCookie).toContain("HttpOnly");
		expect(s.setCookie).toContain("SameSite=Lax");
		expect(s.setCookie).toContain("Path=/auth/typetorch");
		expect(s.setCookie).toContain("Secure");
	});

	test("an owner on a device that was never blessed gets the read-only web role (TYPETORCH_CENTRAL_LOGIN_UNBLESSED=web)", async () => {
		const r = await c.login();
		expect(r.status).toBe(302);
		expect(r.location).toBe("/");
		expect(r.device).toBeUndefined();
		expect(await role(r.session)).toBe("web");
		const check = await asJson(await h.call("/v1/auth/check", { headers: { cookie: r.session as string } }));
		expect(check.user).toMatchObject({ kind: "roblox", userId: OWNER, login: "typetorch.dev" });
		// Read-only: nothing that changes something, nothing of the server's configuration.
		expect((await h.call("/v1/admin/settings", { headers: { cookie: r.session as string } })).status).toBe(403);
		expect((await h.call("/v1/admin/settings", { method: "PATCH", ...json({ ipPerMinute: 5000 }), headers: { "content-type": "application/json", cookie: r.session as string, ...XT } })).status).toBe(403);
		expect(h.logs.some((l) => l.includes(`login: typetorch.dev user ${OWNER} role web`))).toBe(true);
	});

	test("the check tells an owner on an unblessed browser so (untrustedOwner); blessing that browser upgrades its session in place", async () => {
		const r = await c.login();
		// The same owner signed in on another browser (read-only too), and a viewer.
		const elsewhere = await c.login();
		const viewer = await c.login({ sub: VIEWER });
		const post = (session: string | undefined, token: string, origin = PUBLIC) => h.call("/auth/device", { method: "POST", ip: c.freshIp(), ...json({ token }), headers: { "content-type": "application/json", cookie: session as string, ...XT, origin } });
		const check = await asJson(await h.call("/v1/auth/check", { headers: { cookie: r.session as string } }));
		expect(check.role).toBe("web");
		expect(check.untrustedOwner).toBe(true);
		expect(check.trustWithToken).toBe(true);
		// A foreign Origin is refused, and upgrades nothing; nor does a wrong token.
		expect((await post(r.session, ADMIN, "https://evil.example")).status).toBe(403);
		expect((await post(r.session, "not-the-admin-token-0123456789abcdef")).status).toBe(401);
		expect(await role(r.session)).toBe("web");
		// The admin token on the bless route, from this read-only session (X-TypeTorch + Origin like every cookie write).
		const blessed = await post(r.session, ADMIN);
		expect(blessed.status).toBe(200);
		const body = await asJson(blessed);
		expect(body).toEqual({ ok: true, blessed: true, upgraded: true });
		const device = c.cookieValue(blessed, "tt_device")?.split(";")[0] as string;
		expect(device).toBeDefined();
		const set = c.cookieValue(blessed, "tt_session") as string;
		expect(set).toContain("HttpOnly");
		expect(set).toContain("SameSite=Strict");
		const upgraded = set.split(";")[0] as string;
		// The session id rotated: the old one is gone, the new one is admin and no longer flagged.
		expect(upgraded).not.toBe(r.session);
		expect(await role(r.session)).toBeUndefined();
		const after = await asJson(await h.call("/v1/auth/check", { headers: { cookie: upgraded } }));
		expect(after.role).toBe("admin");
		expect(after.user).toMatchObject({ kind: "roblox", userId: OWNER, login: "typetorch.dev" });
		expect(after.untrustedOwner).toBeUndefined();
		expect(after.trustWithToken).toBeUndefined();
		expect(h.logs.some((l) => l.includes(`typetorch.dev user ${OWNER} upgraded to admin`))).toBe(true);
		const logs = h.logs.join("\n");
		expect(logs).not.toContain(upgraded.slice("tt_session=".length));
		expect(logs).not.toContain(ADMIN);
		// The owner's session on the other browser stays read-only.
		expect(await role(elsewhere.session)).toBe("web");
		// A viewer who blesses with the admin token: the device is blessed, the viewer's session stays read-only.
		const fromViewer = await post(viewer.session, ADMIN);
		expect(fromViewer.status).toBe(200);
		expect(await asJson(fromViewer)).toEqual({ ok: true, blessed: true });
		expect(c.cookieValue(fromViewer, "tt_session")).toBeUndefined();
		expect(await role(viewer.session)).toBe("web");
		// The upgraded session is tied to the device it was blessed with: revoking that device ends it.
		const here = ((await asJson(await h.call("/v1/admin/devices", { headers: { cookie: `${upgraded}; ${device}` } }))).devices as { id: string; current?: boolean }[]).find((d) => d.current) as { id: string };
		expect(here).toBeDefined();
		expect((await asJson(await h.call(`/v1/admin/devices/${here.id}`, { method: "DELETE", headers: bearer(ADMIN) }))).sessionsEnded).toBe(1);
		expect(await role(upgraded)).toBeUndefined();
		// The admin token itself (Bearer) never carries the flag.
		expect((await asJson(await h.call("/v1/auth/check", { headers: bearer(ADMIN) }))).untrustedOwner).toBeUndefined();
	});

	test("an owner taken off the list is not upgraded by a bless (the list is checked at bless time)", async () => {
		const r = await c.login();
		expect(await role(r.session)).toBe("web");
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 2, owners: [] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
		try {
			const blessed = await h.call("/auth/device", { method: "POST", ip: c.freshIp(), ...json({ token: ADMIN }), headers: { "content-type": "application/json", cookie: r.session as string, ...XT, origin: PUBLIC } });
			expect(blessed.status).toBe(200);
			expect(c.cookieValue(blessed, "tt_session")).toBeUndefined();
			expect(await role(r.session)).toBeUndefined();
		} finally {
			expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 3, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
		}
	});

	test("an owner on a device blessed with the admin token gets admin; the device cookie rotates on every use", async () => {
		const wrong = await blessWithToken("not-the-admin-token-0123456789abcdef");
		expect(wrong.status).toBe(401);
		expect(wrong.headers.getSetCookie().some((x) => x.startsWith("tt_device="))).toBe(false);
		// The cookie route needs the X-TypeTorch header like every cookie write.
		expect((await h.call("/auth/device", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json" }, ip: c.freshIp() })).status).toBe(403);
		const ok = await blessWithToken();
		expect(ok.status).toBe(200);
		const set = c.cookieValue(ok, "tt_device") as string;
		expect(set).toContain("HttpOnly");
		expect(set).toContain("SameSite=Lax");
		expect(set).toContain("Secure");
		expect(set).toContain(`Max-Age=${180 * 86400}`);
		const device = set.split(";")[0] as string;

		const first = await c.login({}, { device });
		expect(await role(first.session)).toBe("admin");
		expect(first.device).toBeDefined();
		expect(first.device).not.toBe(device);
		// The rotated cookie works next time.
		const second = await c.login({}, { device: first.device as string });
		expect(await role(second.session)).toBe("admin");
		// The pre-rotation value works for a minute (two tabs), then not.
		h.setNow(h.now() + 61_000);
		const stale = await c.login({}, { device: first.device as string });
		expect(await role(stale.session)).toBe("web");
		const fresh = await c.login({}, { device: second.device as string });
		expect(await role(fresh.session)).toBe("admin");
		// Owners list and revoke devices; a revoked device logs in read-only.
		const list = await asJson(await h.call("/v1/admin/devices", { headers: bearer(ADMIN) }));
		const mine = (list.devices as { id: string; via: string }[]).find((d) => d.via === "admin token") as { id: string };
		expect(JSON.stringify(list)).not.toMatch(/hash|secret/);
		expect(await role(fresh.session)).toBe("admin");
		const gone = await asJson(await h.call(`/v1/admin/devices/${mine.id}`, { method: "DELETE", headers: bearer(ADMIN) }));
		expect(gone.ok).toBe(true);
		// The admin sessions that device opened end with it; the next login there is read-only.
		expect(gone.sessionsEnded).toBeGreaterThanOrEqual(1);
		expect(await role(fresh.session)).toBeUndefined();
		const revoked = await c.login({}, { device: fresh.device as string });
		expect(await role(revoked.session)).toBe("web");
	});


	test("a viewer gets the web role; a stranger is refused like a wrong token, with no session", async () => {
		const viewer = await c.login({ sub: VIEWER });
		expect(await role(viewer.session)).toBe("web");
		const stranger = await c.login({ sub: STRANGER });
		expect(stranger.location).toBe("/?login_error=not_owner");
		expect(stranger.session).toBeUndefined();
	});

	test("a fresh session every time: a session id from before the login is ended", async () => {
		const before = `tt_session=${h.app.sessions.create({ kind: "token" })}`;
		const ip = c.freshIp();
		const s = await c.start(ip);
		const r = await c.callback(fakes.authorize(s.authorizeUrl), [s.cookie, before], ip);
		expect(r.session).toBeDefined();
		expect(r.session).not.toBe(before);
		expect(await role(before)).toBeUndefined();
	});

	test("a reused code fails (the broker answers invalid_grant); so does a spent state", async () => {
		const ip = c.freshIp();
		const s = await c.start(ip);
		const back = fakes.authorize(s.authorizeUrl);
		expect((await c.callback(back, [s.cookie], ip)).session).toBeDefined();
		// The same callback again: the state is spent.
		expect((await c.callback(back, [s.cookie], ip)).location).toBe("/?login_error=state");
		// The old code with a new state: the broker refuses the second use.
		const again = await c.start(ip);
		const reuse = new URL(back);
		reuse.searchParams.set("state", new URL(again.authorizeUrl).searchParams.get("state") as string);
		const r = await c.callback(reuse.toString(), [again.cookie], ip);
		expect(r.location).toBe("/?login_error=failed");
		expect(r.session).toBeUndefined();
	});

	test("a wrong state (not the cookie's) fails before the broker is asked", async () => {
		const ip = c.freshIp();
		const s = await c.start(ip);
		const other = await c.start(ip);
		const tokenCalls = fakes.calls.token;
		const r = await c.callback(fakes.authorize(s.authorizeUrl), [other.cookie], ip);
		expect(r.location).toBe("/?login_error=state");
		expect(fakes.calls.token).toBe(tokenCalls);
		// No cookie at all.
		const none = await c.start(ip);
		expect((await c.callback(fakes.authorize(none.authorizeUrl), [], ip)).location).toBe("/?login_error=state");
	});

	const refused: [string, Twist, string][] = [
		["a wrong nonce in the assertion", { assertion: (x) => ({ ...x, nonce: "another-nonce-0123456789abcdef" }) }, "assertion nonce does not match"],
		["an aud for another backend (another fingerprint)", { assertion: (x) => ({ ...x, aud: `tt1-${"a".repeat(32)}` }) }, "audience is not this backend's fingerprint"],
		["an aud that is a URL", { assertion: (x) => ({ ...x, aud: PUBLIC }) }, "audience is not this backend's fingerprint"],
		["another issuer", { assertion: (x) => ({ ...x, iss: "https://evil.test" }) }, "assertion issuer is wrong"],
		["an expired assertion", { assertion: (x) => ({ ...x, exp: (x.iat as number) - 60 }) }, "assertion expired"],
		["an assertion issued more than two minutes ago", { assertion: (x) => ({ ...x, iat: (x.iat as number) - 180, exp: (x.iat as number) + 60 }) }, "two-minute window"],
		["an unknown kid", { assertionKid: "broker-unknown" }, "kid is unknown"],
		["an assertion signed by another key under the known kid", { assertionSigner: brokerKey("broker-k1") }, "assertion signature is not valid"],
		["a Roblox ID token with the wrong nonce", { roblox: (x) => ({ ...x, nonce: "another-nonce-0123456789abcdef" }) }, "nonce mismatch after typetorch.dev login"],
		["a Roblox ID token for another app (aud)", { roblox: (x) => ({ ...x, aud: "1234" }) }, "ID token audience is not this app"],
		["a Roblox ID token whose sub differs from the assertion", { roblox: (x) => ({ ...x, sub: String(STRANGER) }) }, "sub differs from the typetorch.dev assertion"],
		["a Roblox ID token from another issuer", { roblox: (x) => ({ ...x, iss: "https://evil.test/" }) }, "ID token issuer is wrong"],
		["an expired Roblox ID token", { roblox: (x) => ({ ...x, exp: (x.iat as number) - 120 }) }, "ID token expired"],
	];
	for (const [what, twist, why] of refused) {
		test(`refused: ${what}`, async () => {
			const before = h.logs.length;
			const r = await c.login(twist);
			expect(r.location).toBe("/?login_error=failed");
			expect(r.session).toBeUndefined();
			expect(h.logs.slice(before).join("\n")).toContain(why);
		});
	}

	test("refused: a Roblox ID token with a bad signature (signed by a key Roblox doesn't publish)", async () => {
		const r = await c.login({ robloxSigner: await robloxKey("roblox-k1") });
		expect(r.location).toBe("/?login_error=failed");
		expect(h.logs.some((l) => l.includes("ID token signature is not valid"))).toBe(true);
	});

	test("the wrong-nonce Roblox token is logged as a nonce mismatch after a typetorch.dev login", () => {
		expect(h.logs.some((l) => l.includes("nonce mismatch after typetorch.dev login"))).toBe(true);
	});

	test("a replayed assertion (a jti seen before) fails", async () => {
		const jti = b64(randomBytes(16));
		expect((await c.login({ jti })).session).toBeDefined();
		const r = await c.login({ jti });
		expect(r.location).toBe("/?login_error=failed");
		expect(h.logs.some((l) => l.includes("jti was seen before"))).toBe(true);
	});

	test("a broker key published later is picked up (unknown kid refetches the JWKS, at most once a minute)", async () => {
		const k2 = brokerKey("broker-k2");
		fakes.brokerKeys.push(k2);
		h.setNow(h.now() + 61_000);
		const r = await c.login({ assertionSigner: k2 });
		expect(await role(r.session)).toBe("web");
	});

	test("a failed /token answer is 'not signed in'; its body is never shown or logged", async () => {
		fakes.tokenStatus = 400;
		const r = await c.login();
		fakes.tokenStatus = 200;
		expect(r.location).toBe("/?login_error=failed");
		expect(await r.res.text()).toBe("");
		expect(h.logs.join("\n")).not.toContain("broker-detail-never-shown");
	});

	test("failed logins count toward the five-failure lockout", async () => {
		const ip = "10.31.0.1";
		for (let i = 0; i < 5; i++) await c.login({ assertion: (x) => ({ ...x, nonce: "wrong-nonce-0123456789abcdefgh" }) }, { ip });
		expect((await h.call("/auth/typetorch/start", { ip })).status).toBe(429);
		h.setNow(h.now() + 16 * 60_000);
	});

	test("logs carry no code, assertion, ID token, device cookie or token", async () => {
		const ok = await blessWithToken();
		const device = c.cookieValue(ok, "tt_device")?.split(";")[0] as string;
		const ip = c.freshIp();
		const s = await c.start(ip);
		const back = fakes.authorize(s.authorizeUrl);
		await c.callback(back, [s.cookie, device], ip);
		const all = h.logs.join("\n");
		expect(all).not.toContain(new URL(back).searchParams.get("code") as string);
		expect(all).not.toContain(device.split("=")[1] as string);
		expect(all).not.toContain(ADMIN);
		expect(all).not.toMatch(/eyJ[\w-]+\.eyJ/);
	});

	test("the origin report: signed canonical JSON, the challenge served only while pending, then the hour-long bearer token", async () => {
		const fp = h.app.central?.fingerprint as string;
		expect(await h.app.central?.report()).toBe("ok");
		// First a 202 challenge (new origin), then a signed poll that passed the challenge.
		const mine = fakes.reports.filter((r) => r.body.fingerprint === fp);
		expect(mine.map((r) => r.status)).toEqual([202, 200]);
		const first = mine[0]?.body as Record<string, unknown>;
		expect(Object.keys(first)).toEqual(["fingerprint", "public_key", "origin", "label", "iat", "signature"]);
		expect(first).toMatchObject({ fingerprint: fp, origin: PUBLIC, label: "backend.example.com", iat: sec(h.now()) });
		expect(canonicalReport(first as never)).toBe(`{"fingerprint":"${fp}","origin":"${PUBLIC}","label":"backend.example.com","iat":${sec(h.now())}}`);
		expect(fakes.origins.get(fp)).toBe(PUBLIC);
		// The challenge was served while pending (the broker's fetch above) and is gone once the report is done.
		expect(fakes.challengesIssued.length).toBe(1);
		expect((await h.call(`/api/typetorch/challenge/${fakes.challengesIssued[0]}`)).status).toBe(404);
		// The next report in the hour uses the bearer token instead of a signature.
		expect(await h.app.central?.report()).toBe("ok");
		const last = fakes.reports.at(-1) as { body: Record<string, unknown>; auth?: string; status: number };
		expect(last.auth).toMatch(/^Bearer /);
		expect(last.body).toEqual({ fingerprint: fp, origin: PUBLIC, label: "backend.example.com", iat: sec(h.now()) });
		expect(last.status).toBe(200);
		// A refused bearer falls back to a signed report.
		fakes.reportTokens.clear();
		expect(await h.app.central?.report()).toBe("ok");
		expect(fakes.reports.at(-1)?.auth).toBeUndefined();
		expect(fakes.reports.at(-2)?.status).toBe(401);
		// The access token is never written to disk or the log.
		expect(h.logs.join("\n")).not.toContain([...fakes.reportTokens.keys()][0] as string);
	});

	test("the report's iat window: a report older than five minutes is refused by the broker and the login keeps working", async () => {
		// A backend clock 10 minutes behind the broker's: the report fails, nothing is fatal.
		const fp = h.app.central?.fingerprint as string;
		fakes.reportTokens.clear();
		const brokerNow = fakes.now;
		fakes.now = () => h.now() + 10 * 60_000;
		expect(await h.app.central?.report()).toBe("failed");
		fakes.now = brokerNow;
		expect(h.logs.some((l) => l.includes("typetorch.dev report failed: typetorch.dev answered 401"))).toBe(true);
		expect(fakes.origins.get(fp)).toBeDefined();
		const r = await c.login();
		expect(r.session).toBeDefined();
	});
});

describe("Sign in with typetorch.dev: the challenge while pending", () => {
	test("served while the report polls, 404 before and after", async () => {
		const fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		let h!: Harness;
		const served: number[] = [];
		// A broker that keeps answering 202 for the same token: the backend serves it while polling, then gives up.
		const token = b64(randomBytes(32));
		const stubborn = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === `${BROKER}/report`) {
				served.push((await h.app.handle(new Request(`${PUBLIC}/api/typetorch/challenge/${token}`), "203.0.113.9")).status);
				return new Response(JSON.stringify({ challenge: token, retry_after: 2 }), { status: 202, headers: { "content-type": "application/json" } });
			}
			return fakes.fetch(input, init);
		}) as typeof fetch;
		h = await harness(ENV, { fetch: stubborn, reportSleep: async () => h.setNow(h.now() + 2000) });
		try {
			expect((await h.call(`/api/typetorch/challenge/${token}`)).status).toBe(404);
			expect(await h.app.central?.report()).toBe("failed");
			// The first fetch comes before the 202 (404); every poll after it finds the token, until 60 s are up.
			expect(served[0]).toBe(404);
			expect(served.slice(1, 5)).toEqual([200, 200, 200, 200]);
			expect((await h.call(`/api/typetorch/challenge/${token}`)).status).toBe(404);
			expect(h.logs.some((l) => l.includes("origin challenge did not pass"))).toBe(true);
		} finally {
			await h.close();
		}
	});
});

describe("Sign in with typetorch.dev: settings and switches", () => {
	const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off" };

	test("on by default with an https public URL; explicit off turns it off", () => {
		const unset = loadConfig([], { ...base, TYPETORCH_PUBLIC_URL: PUBLIC });
		expect(unset.centralLogin).toEqual({ issuer: "https://dash.typetorch.dev", unblessed: "admin", label: "backend.example.com" });
		expect(unset.warnings.join(" ")).not.toContain("typetorch.dev");
		for (const off of ["off", "0", "false", "no", "OFF"]) {
			const c = loadConfig([], { ...base, TYPETORCH_PUBLIC_URL: PUBLIC, TYPETORCH_CENTRAL_LOGIN: off });
			expect(c.centralLogin).toBeUndefined();
			expect(c.warnings.join(" ")).not.toContain("typetorch.dev");
		}
	});

	test("unset without an https public URL: off with a warning, nothing else required", () => {
		const none = loadConfig([], base);
		expect(none.centralLogin).toBeUndefined();
		expect(none.warnings.join(" ")).toContain("Sign in with typetorch.dev is off: set TYPETORCH_PUBLIC_URL");
		const http = loadConfig([], { ...base, TYPETORCH_PUBLIC_URL: "http://backend.example.com" });
		expect(http.centralLogin).toBeUndefined();
		expect(http.warnings.join(" ")).toContain("must be https");
	});

	test("unset without a public URL: the backend starts normally, routes 404, no instance key, no report", async () => {
		let calls = 0;
		const h = await harness({ TYPETORCH_CENTRAL_LOGIN: undefined as never }, { fetch: (async () => (calls++, new Response("no", { status: 500 }))) as unknown as typeof fetch });
		try {
			expect(h.app.central).toBeUndefined();
			expect((await h.call("/healthz")).status).toBe(200);
			expect((await h.call("/auth/typetorch/start")).status).toBe(404);
			expect(existsSync(join(h.dir, "instance.key"))).toBe(false);
			expect(calls).toBe(0);
			const login = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			expect(login.status).toBe(200);
		} finally {
			await h.close();
		}
	});

	test("on needs only the public URL (no Roblox client id); the pins are optional; the issuer is an origin", () => {
		const on = loadConfig([], { ...base, ...ENV });
		expect(on.centralLogin).toEqual({ issuer: BROKER, unblessed: "web", label: "backend.example.com" });
		expect(on.warnings.join(" ")).not.toContain("TYPETORCH_ROBLOX_BROKER_CLIENT_ID");
		expect(loadConfig([], { ...base, ...ENV, ...PINS }).centralLogin).toEqual({ issuer: BROKER, unblessed: "web", robloxClientId: BROKER_CLIENT_ID, robloxDiscoveryUrl: ROBLOX_DISCOVERY, label: "backend.example.com" });
		expect(loadConfig([], { ...base, TYPETORCH_CENTRAL_LOGIN: "on" }).warnings.join(" ")).toContain("set TYPETORCH_PUBLIC_URL");
		expect(() => loadConfig([], { ...base, ...ENV, TYPETORCH_ROBLOX_BROKER_CLIENT_ID: "not a client id" })).toThrow(/TYPETORCH_ROBLOX_BROKER_CLIENT_ID/);
		expect(loadConfig([], { ...base, ...ENV }).centralLogin?.issuer).toBe(BROKER);
		expect(loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_ISSUER: undefined as never }).centralLogin?.issuer).toBe("https://dash.typetorch.dev");
		expect(loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_ISSUER: "http://127.0.0.1:8788" }).centralLogin?.issuer).toBe("http://127.0.0.1:8788");
		for (const bad of ["http://broker.example.com", "https://broker.test/path", "https://user:pw@broker.test", "nope"]) {
			expect(() => loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_ISSUER: bad })).toThrow(/TYPETORCH_CENTRAL_LOGIN_ISSUER/);
		}
		for (const [value, mode] of [["admin", "admin"], ["web", "web"], ["refuse", "refuse"], ["REFUSE", "refuse"], ["", "admin"]] as const) {
			expect(loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_UNBLESSED: value }).centralLogin?.unblessed).toBe(mode);
		}
		expect(loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_UNBLESSED: undefined as never }).centralLogin?.unblessed).toBe("admin");
		for (const bad of ["owner", "read-only", "yes", "admin,web"]) {
			expect(() => loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_UNBLESSED: bad })).toThrow(/admin, web or refuse/);
		}
		expect(loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_KIDS: "a1, b2" }).centralLogin?.kids).toEqual(["a1", "b2"]);
		expect(() => loadConfig([], { ...base, ...ENV, TYPETORCH_ROBLOX_BROKER_DISCOVERY: "http://roblox.example.com/x" })).toThrow(/TYPETORCH_ROBLOX_BROKER_DISCOVERY/);
		// Plain http on loopback only with a local broker.
		expect(() => loadConfig([], { ...base, ...ENV, TYPETORCH_ROBLOX_BROKER_DISCOVERY: "http://127.0.0.1:8790/x" })).toThrow(/TYPETORCH_ROBLOX_BROKER_DISCOVERY/);
		expect(loadConfig([], { ...base, ...ENV, TYPETORCH_CENTRAL_LOGIN_ISSUER: "http://127.0.0.1:8788", TYPETORCH_ROBLOX_BROKER_DISCOVERY: "http://127.0.0.1:8790/x" }).centralLogin?.robloxDiscoveryUrl).toBe("http://127.0.0.1:8790/x");
	});

	test("the switch off: no button, every route 404, no instance key, no report, admin token and per-game sign-in untouched", async () => {
		let calls = 0;
		const h = await harness({ TYPETORCH_PUBLIC_URL: PUBLIC, TYPETORCH_CENTRAL_LOGIN: "off", TYPETORCH_CENTRAL_LOGIN_ISSUER: BROKER }, { fetch: (async () => (calls++, new Response("no", { status: 500 }))) as unknown as typeof fetch });
		try {
			expect((await asJson(await h.call("/v1/auth/check"))).login).toEqual({ token: true, roblox: false });
			expect((await asJson(await h.call("/v1/auth/check", { headers: bearer(ADMIN) }))).dashboard).toBeUndefined();
			for (const path of ["/auth/typetorch/start", "/auth/typetorch/callback?code=x&state=y", "/auth/bless/challenge", "/auth/bless?challenge=a&sig=b", "/api/typetorch/challenge/abc"]) {
				expect(`${path} ${(await h.call(path)).status}`).toBe(`${path} 404`);
			}
			expect((await h.call("/auth/device", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } })).status).toBe(404);
			expect((await h.call("/v1/admin/devices", { headers: bearer(ADMIN) })).status).toBe(404);
			expect((await h.call("/v1/central/report", { method: "POST", headers: bearer(ADMIN) })).status).toBe(404);
			expect(h.app.central).toBeUndefined();
			expect(existsSync(join(h.dir, "instance.key"))).toBe(false);
			expect(calls).toBe(0);
			// The admin token works as before.
			const login = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			expect(login.status).toBe(200);
			expect(((await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }))).centralLogin as { on: boolean }).on).toBe(false);
		} finally {
			await h.close();
		}
	});

	test("blessing with the admin token follows the token login switch (TYPETORCH_TOKEN_LOGIN=off: 404)", async () => {
		const h = await harness({ ...ENV, TYPETORCH_TOKEN_LOGIN: "off" }, { fetch: new Fakes().fetch });
		try {
			const res = await h.call("/auth/device", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			expect(res.status).toBe(404);
			expect(res.headers.getSetCookie().some((x) => x.startsWith("tt_device="))).toBe(false);
		} finally {
			await h.close();
		}
	});

	test("a public URL over plain http (not loopback) keeps the login off", () => {
		const c = loadConfig([], { ...base, ...ENV, TYPETORCH_PUBLIC_URL: "http://backend.example.com" });
		expect(c.centralLogin).toBeUndefined();
		expect(c.warnings.join(" ")).toContain("must be https");
		expect(loadConfig([], { ...base, ...ENV, TYPETORCH_PUBLIC_URL: "http://127.0.0.1:8787" }).centralLogin).toBeDefined();
	});

	test("a pinned kid (TYPETORCH_CENTRAL_LOGIN_KIDS) refuses an assertion from any other key, even one the JWKS lists", async () => {
		const fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		const h = await harness({ ...ENV, TYPETORCH_CENTRAL_LOGIN_KIDS: "broker-pinned" }, { fetch: fakes.fetch });
		fakes.h = h;
		const c = client(() => ({ h, fakes }));
		try {
			await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
			const r = await c.login();
			expect(r.location).toBe("/?login_error=failed");
			expect(h.logs.some((l) => l.includes("not pinned"))).toBe(true);
			// The pinned key itself works.
			const pinned = brokerKey("broker-pinned");
			fakes.brokerKeys.push(pinned);
			h.setNow(h.now() + 61_000);
			expect((await c.login({ assertionSigner: pinned })).session).toBeDefined();
		} finally {
			await h.close();
		}
	});

	/** A harness with its own fakes; `ready` adds the owner. */
	async function own(env: Record<string, string>, setup: (fakes: Fakes) => void = () => {}) {
		const fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		setup(fakes);
		const h = await harness(env, { fetch: fakes.fetch });
		fakes.h = h;
		await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		return { h, fakes, c: client(() => ({ h, fakes })) };
	}

	test("the broker's login metadata names the Roblox client id and discovery: fetched once, cached an hour", async () => {
		const { h, fakes, c } = await own(ENV, (f) => {
			f.metadata = { ...f.metadata, roblox_client_id: "5555000011112222" };
		});
		try {
			// The Roblox token is checked against the published client id, not a built-in one.
			expect((await c.login()).location).toBe("/?login_error=failed");
			expect(h.logs.some((l) => l.includes("ID token audience is not this app"))).toBe(true);
			const ok = await c.login({ roblox: (x) => ({ ...x, aud: "5555000011112222" }) });
			expect(ok.session).toBeDefined();
			expect(fakes.calls.metadata).toBe(1);
			h.setNow(h.now() + 3_600_000 + 1000);
			expect((await c.login({ roblox: (x) => ({ ...x, aud: "5555000011112222" }) })).session).toBeDefined();
			expect(fakes.calls.metadata).toBe(2);
		} finally {
			await h.close();
		}
	});

	test("login metadata naming another issuer is refused (fails closed, the code is never redeemed)", async () => {
		for (const issuer of ["https://evil.test", `${BROKER}/`, "https://BROKER.test"]) {
			const { h, fakes, c } = await own(ENV, (f) => {
				f.metadata = { ...f.metadata, issuer };
			});
			try {
				const r = await c.login();
				expect(r.location).toBe("/?login_error=failed");
				expect(r.session).toBeUndefined();
				expect(fakes.calls.token).toBe(0);
				expect(h.logs.some((l) => l.includes("names another issuer"))).toBe(true);
			} finally {
				await h.close();
			}
		}
	});

	test("malformed login metadata is refused: a bad client id, a plain-http (non-loopback) discovery, too large", async () => {
		const bad: [string, (f: Fakes) => void, string][] = [
			["client id", (f) => (f.metadata = { ...f.metadata, roblox_client_id: "a b" }), "no valid roblox_client_id"],
			["discovery", (f) => (f.metadata = { ...f.metadata, roblox_discovery: "http://roblox.test/oauth/.well-known/openid-configuration" }), "no valid roblox_discovery"],
			["loopback discovery for a public issuer", (f) => (f.metadata = { ...f.metadata, roblox_discovery: "http://127.0.0.1:8790/oauth/.well-known/openid-configuration" }), "no valid roblox_discovery"],
			["size", (f) => (f.metadata = { ...f.metadata, pad: "x".repeat(20_000) }), "too large"],
		];
		for (const [, setup, why] of bad) {
			const { h, fakes, c } = await own(ENV, setup);
			try {
				expect((await c.login()).location).toBe("/?login_error=failed");
				expect(fakes.calls.token).toBe(0);
				expect(h.logs.some((l) => l.includes(why))).toBe(true);
			} finally {
				await h.close();
			}
		}
	});

	test("a pin (TYPETORCH_ROBLOX_BROKER_CLIENT_ID / _DISCOVERY) that differs from the published value refuses logins, logged once", async () => {
		const { h, fakes, c } = await own({ ...ENV, ...PINS, TYPETORCH_ROBLOX_BROKER_CLIENT_ID: "7777000011112222" });
		try {
			for (let i = 0; i < 2; i++) {
				const r = await c.login({ roblox: (x) => ({ ...x, aud: "7777000011112222" }) });
				expect(r.location).toBe("/?login_error=failed");
				expect(r.session).toBeUndefined();
			}
			expect(fakes.calls.token).toBe(0);
			expect(h.logs.filter((l) => l.includes("differs from the pinned one")).length).toBe(1);
			// The published value changes to match: logins work again.
			fakes.metadata = { ...fakes.metadata, roblox_client_id: "7777000011112222" };
			h.setNow(h.now() + 3_600_000 + 1000);
			expect((await c.login({ roblox: (x) => ({ ...x, aud: "7777000011112222" }) })).session).toBeDefined();
		} finally {
			await h.close();
		}
		const d = await own({ ...ENV, ...PINS, TYPETORCH_ROBLOX_BROKER_DISCOVERY: "https://other.test/.well-known/openid-configuration" });
		try {
			expect((await d.c.login()).location).toBe("/?login_error=failed");
			expect(d.h.logs.some((l) => l.includes("Roblox discovery URL (TYPETORCH_ROBLOX_BROKER_DISCOVERY) differs from the pinned one"))).toBe(true);
		} finally {
			await d.h.close();
		}
		// Pins equal to the published values: logins work.
		const same = await own({ ...ENV, ...PINS });
		try {
			expect((await same.c.login()).session).toBeDefined();
		} finally {
			await same.h.close();
		}
	});

	test("unpinned, the discovery URL is Roblox's own: a broker publishing another one can't choose the Roblox signing keys", async () => {
		const evil = "https://evil.test/.well-known/openid-configuration";
		const { h, fakes, c } = await own(ENV, (f) => (f.metadata = { ...f.metadata, roblox_discovery: evil }));
		try {
			const r = await c.login();
			expect(r.location).toBe("/?login_error=failed");
			expect(r.session).toBeUndefined();
			expect(fakes.calls.token).toBe(0);
			expect(h.logs.some((l) => l.includes("Roblox discovery URL (TYPETORCH_ROBLOX_BROKER_DISCOVERY) differs from the pinned one"))).toBe(true);
		} finally {
			await h.close();
		}
		// Straight on the class: a public broker is held to ROBLOX_DISCOVERY_URL; an explicit pin may name another (tests,
		// a fake Roblox); a loopback broker (dash with its fake Roblox) may name its own without a pin.
		const at = (issuer: string, discovery: string, pin?: string) =>
			new CentralLogin({
				issuer,
				fingerprint: "f",
				redirectUri: `${PUBLIC}/auth/typetorch/callback`,
				...(pin ? { robloxDiscoveryUrl: pin } : {}),
				fetch: (async () => new Response(JSON.stringify({ issuer, roblox_client_id: BROKER_CLIENT_ID, roblox_discovery: discovery }))) as unknown as typeof fetch,
			}).robloxSettings();
		await expect(at(BROKER, evil)).rejects.toThrow(/differs from the pin/);
		expect((await at(BROKER, ROBLOX_DISCOVERY_URL)).discoveryUrl).toBe(ROBLOX_DISCOVERY_URL);
		expect((await at(BROKER, evil, evil)).discoveryUrl).toBe(evil);
		await expect(at(BROKER, ROBLOX_DISCOVERY_URL, evil)).rejects.toThrow(/differs from the pin/);
		expect((await at("http://127.0.0.1:8788", "http://127.0.0.1:8790/oauth/.well-known/openid-configuration")).discoveryUrl).toBe("http://127.0.0.1:8790/oauth/.well-known/openid-configuration");
	});

	test("login metadata that can't be fetched fails closed, backs off, and recovers; other sign-ins are untouched", async () => {
		const { h, fakes, c } = await own(ENV, (f) => (f.metadataStatus = 503));
		try {
			const r = await c.login();
			expect(r.location).toBe("/?login_error=failed");
			expect(r.session).toBeUndefined();
			expect(fakes.calls.token).toBe(0);
			expect(fakes.calls.metadata).toBe(1);
			// Inside the backoff: no new fetch, still refused.
			expect((await c.login()).location).toBe("/?login_error=failed");
			expect(fakes.calls.metadata).toBe(1);
			// The admin token login is unaffected.
			const token = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			expect(token.status).toBe(200);
			// After the backoff the broker is back: the login works.
			fakes.metadataStatus = 200;
			h.setNow(h.now() + 2_001);
			expect((await c.login()).session).toBeDefined();
			expect(fakes.calls.metadata).toBe(2);
		} finally {
			await h.close();
		}
	});

	test("TYPETORCH_CENTRAL_LOGIN_UNBLESSED=refuse: an owner on an unblessed device gets no session; a blessed one gets admin", async () => {
		const fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		const h = await harness({ ...ENV, TYPETORCH_CENTRAL_LOGIN_UNBLESSED: "refuse" }, { fetch: fakes.fetch });
		fakes.h = h;
		const c = client(() => ({ h, fakes }));
		try {
			await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
			const r = await c.login();
			expect(r.location).toBe("/?login_error=not_blessed");
			expect(r.session).toBeUndefined();
			// A viewer is not affected by the device rule.
			expect((await c.login({ sub: VIEWER })).session).toBeDefined();
			const blessed = await h.call("/auth/device", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			const device = c.cookieValue(blessed, "tt_device")?.split(";")[0] as string;
			const ok = await c.login({}, { device });
			expect((await asJson(await h.call("/v1/auth/check", { headers: { cookie: ok.session as string } }))).role).toBe("admin");
		} finally {
			await h.close();
		}
	});

	test("a device blessed with the admin token stops counting when the token changes", async () => {
		const fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		const dir = mkdtempSync(join(tmpdir(), "tt-central-"));
		try {
			const h1 = await harness({ ...ENV, TYPETORCH_DATA_DIR: dir }, { fetch: fakes.fetch });
			fakes.h = h1;
			await h1.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
			const blessed = await h1.call("/auth/device", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
			const device = blessed.headers.getSetCookie().find((x) => x.startsWith("tt_device="))?.split(";")[0] as string;
			const fp = h1.app.central?.fingerprint;
			await h1.app.stop();
			const h2 = await harness({ ...ENV, TYPETORCH_DATA_DIR: dir, TYPETORCH_ADMIN_TOKEN: "another-admin-token-for-tests-0123456789ab" }, { fetch: fakes.fetch });
			fakes.h = h2;
			// The same instance key (same fingerprint) after a restart.
			expect(h2.app.central?.fingerprint).toBe(fp as string);
			const c = client(() => ({ h: h2, fakes }));
			const r = await c.login({}, { device });
			expect((await asJson(await h2.call("/v1/auth/check", { headers: { cookie: r.session as string } }))).role).toBe("web");
			await h2.app.stop();
			rmSync(h1.dir, { recursive: true, force: true });
			rmSync(h2.dir, { recursive: true, force: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Sign in with typetorch.dev: TYPETORCH_CENTRAL_LOGIN_UNBLESSED=admin (the default)", () => {
	let h: Harness;
	let fakes: Fakes;
	const c = client(() => ({ h, fakes }));
	const check = async (session: string | undefined) => asJson(await h.call("/v1/auth/check", { headers: session ? { cookie: session } : {} }));
	const { TYPETORCH_CENTRAL_LOGIN_UNBLESSED: _web, ...DEFAULT_ENV } = ENV;

	beforeAll(async () => {
		fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		h = await harness(DEFAULT_ENV, { fetch: fakes.fetch, reportSleep: async () => {} });
		fakes.h = h;
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
	});
	afterAll(() => h.close());

	test("the startup line names the mode and says owners get admin without device trust", () => {
		expect(h.app.central).toBeDefined();
		expect(describeConfig(loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off", ...DEFAULT_ENV }))).toContain("unblessed owners: admin (typetorch.dev logins grant owners admin without device trust)");
		expect(describeConfig(loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off", ...ENV }))).not.toContain("without device trust");
	});

	test("an owner on a browser that was never trusted gets full admin, with no banner and no device tie", async () => {
		const r = await c.login();
		expect(r.status).toBe(302);
		expect(r.location).toBe("/");
		expect(r.device).toBeUndefined();
		const info = await check(r.session);
		expect(info.role).toBe("admin");
		expect(info.user).toMatchObject({ kind: "roblox", userId: OWNER, login: "typetorch.dev" });
		expect(info.untrustedOwner).toBeUndefined();
		expect(info.trustWithToken).toBeUndefined();
		expect((await h.call("/v1/admin/settings", { headers: { cookie: r.session as string } })).status).toBe(200);
		expect(h.logs.some((l) => l.includes(`login: typetorch.dev user ${OWNER} role admin (unblessed device, TYPETORCH_CENTRAL_LOGIN_UNBLESSED=admin)`))).toBe(true);
		expect(h.logs.join("\n")).not.toContain((r.session as string).slice("tt_session=".length));
	});

	test("a viewer stays read-only, without the banner", async () => {
		const v = await c.login({ sub: VIEWER });
		const info = await check(v.session);
		expect(info.role).toBe("web");
		expect(info.untrustedOwner).toBeUndefined();
		expect((await h.call("/v1/admin/settings", { headers: { cookie: v.session as string } })).status).toBe(403);
	});

	test("someone not on the lists is still refused; the owner list is checked at login", async () => {
		const r = await c.login({ sub: STRANGER });
		expect(r.location).toBe("/?login_error=not_owner");
		expect(r.session).toBeUndefined();
	});

	test("blessing still works: a trusted browser's login is tied to its device", async () => {
		const blessed = await h.call("/auth/device", { method: "POST", ip: c.freshIp(), ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
		expect(blessed.status).toBe(200);
		const device = c.cookieValue(blessed, "tt_device")?.split(";")[0] as string;
		expect(device).toBeDefined();
		const ok = await c.login({}, { device });
		expect(ok.device).toBeDefined();
		expect((await check(ok.session)).role).toBe("admin");
		expect(h.logs.some((l) => l.includes(`login: typetorch.dev user ${OWNER} role admin (blessed device)`))).toBe(true);
	});
});

describe("Sign in with typetorch.dev: blessing with the CLI's signed link", () => {
	test("PUT /v1/access/keys (admin token only), a one-time challenge, a link signed by the signing key", async () => {
		const fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		const h = await harness(ENV, { fetch: fakes.fetch });
		fakes.h = h;
		const c = client(() => ({ h, fakes }));
		try {
			await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
			const signing = generateKeyPairSync("ed25519");
			const raw = Buffer.from((signing.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("base64");
			// No keys yet: no challenge.
			expect((await h.call("/auth/bless/challenge")).status).toBe(404);
			// The keys come with the admin token, never from a browser session.
			const session = `tt_session=${h.app.sessions.create({ kind: "token" })}`;
			expect((await h.call("/v1/access/keys", { method: "PUT", ...json({ keys: [raw] }), headers: { "content-type": "application/json", cookie: session, ...XT } })).status).toBe(403);
			expect((await h.call("/v1/access/keys", { method: "PUT", ...json({ keys: ["short"] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(400);
			expect(await asJson(await h.call("/v1/access/keys", { method: "PUT", ...json({ keys: [raw] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } }))).toEqual({ keys: [raw] });

			const challenge = async () => (await asJson(await h.call("/auth/bless/challenge"))) as { challenge: string; fingerprint: string };
			const link = (ch: string, key = signing.privateKey, fp = h.app.central?.fingerprint as string) => `/auth/bless?challenge=${ch}&sig=${b64(edSign(null, Buffer.from(blessMessage(fp, ch)), key))}`;
			const one = await challenge();
			expect(one.fingerprint).toBe(h.app.central?.fingerprint as string);
			// Signed by another key, or for another backend: refused (and the challenge is spent).
			const other = generateKeyPairSync("ed25519").privateKey;
			expect((await h.call(link(one.challenge, other))).headers.get("location")).toBe("/?login_error=bless");
			expect((await h.call(link(one.challenge))).headers.get("location")).toBe("/?login_error=bless");
			const two = await challenge();
			expect((await h.call(link(two.challenge, signing.privateKey, `tt1-${"b".repeat(32)}`))).headers.get("location")).toBe("/?login_error=bless");
			// A good link blesses this browser.
			const three = await challenge();
			const ok = await h.call(link(three.challenge), { ip: "10.40.0.1" });
			expect(ok.headers.get("location")).toBe("/?blessed=1");
			const device = ok.headers.getSetCookie().find((x) => x.startsWith("tt_device="))?.split(";")[0] as string;
			expect(device).toBeDefined();
			// Single use.
			expect((await h.call(link(three.challenge), { ip: "10.40.0.2" })).headers.get("location")).toBe("/?login_error=bless");
			// The CLI's link pasted into a browser where the owner is signed in read-only: that session becomes admin
			// (a new id); the owner's session in another browser and a viewer's session stay read-only.
			const roleOf = async (cookie: string | undefined) => (await asJson(await h.call("/v1/auth/check", { headers: cookie ? { cookie } : {} }))).role as string | undefined;
			const owner = await c.login();
			const otherBrowser = await c.login();
			const viewer = await c.login({ sub: VIEWER });
			expect(await roleOf(owner.session)).toBe("web");
			const four = await challenge();
			const pasted = await h.call(link(four.challenge), { ip: "10.40.0.3", headers: { cookie: owner.session as string } });
			expect(pasted.headers.get("location")).toBe("/?blessed=1");
			const setSession = pasted.headers.getSetCookie().find((x) => x.startsWith("tt_session="));
			expect(setSession).toContain("SameSite=Strict");
			const upgraded = setSession?.split(";")[0] as string;
			expect(upgraded).not.toBe(owner.session);
			expect(await roleOf(owner.session)).toBeUndefined();
			expect(await roleOf(upgraded)).toBe("admin");
			expect(await roleOf(otherBrowser.session)).toBe("web");
			const five = await challenge();
			const fromViewer = await h.call(link(five.challenge), { ip: "10.40.0.4", headers: { cookie: viewer.session as string } });
			expect(fromViewer.headers.get("location")).toBe("/?blessed=1");
			expect(fromViewer.headers.getSetCookie().some((x) => x.startsWith("tt_session="))).toBe(false);
			expect(await roleOf(viewer.session)).toBe("web");
			// A bad link upgrades nothing.
			const six = await challenge();
			const bad = await h.call(link(six.challenge, other), { ip: "10.40.0.5", headers: { cookie: otherBrowser.session as string } });
			expect(bad.headers.get("location")).toBe("/?login_error=bless");
			expect(bad.headers.getSetCookie().some((x) => x.startsWith("tt_session="))).toBe(false);
			expect(await roleOf(otherBrowser.session)).toBe("web");
			const r = await c.login({}, { device });
			expect((await asJson(await h.call("/v1/auth/check", { headers: { cookie: r.session as string } }))).role).toBe("admin");
			const list = await asJson(await h.call("/v1/admin/devices", { headers: { cookie: r.session as string } }));
			expect((list.devices as { via: string }[]).some((d) => d.via === "signing key")).toBe(true);
		} finally {
			await h.close();
		}
	});
});

describe("Sign in with typetorch.dev: viewers stay strictly read-only", () => {
	let h: Harness;
	let fakes: Fakes;
	let viewer: Record<string, string>;
	let owner: Record<string, string>;
	let web: string;
	const c = client(() => ({ h, fakes }));

	beforeAll(async () => {
		fakes = new Fakes();
		fakes.robloxKeys = [await robloxKey("roblox-k1")];
		// The explorer is served from a build folder with a stray .env next to it and inside it.
		const root = mkdtempSync(join(tmpdir(), "tt-web-"));
		web = join(root, "dist");
		mkdirSync(web);
		writeFileSync(join(web, "index.html"), "<!doctype html><title>explorer</title>");
		writeFileSync(join(web, ".env"), "TYPETORCH_ADMIN_TOKEN=leaked-admin-token-0123456789abcdef");
		writeFileSync(join(root, ".env"), "TYPETORCH_ADMIN_TOKEN=leaked-admin-token-0123456789abcdef");
		mkdirSync(join(web, "assets", ".hidden"), { recursive: true });
		writeFileSync(join(web, "assets", ".hidden", "x.js"), "leaked-admin-token-nested");
		writeFileSync(join(web, "..env"), "leaked-admin-token-dotdot");
		h = await harness({ ...ENV, TYPETORCH_EXPLORER: "on", TYPETORCH_WEB_DIR: web, TYPETORCH_ALERT_WEBHOOK_URL: "https://hooks.example.com/secret-webhook-path" }, { fetch: fakes.fetch });
		fakes.h = h;
		await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		const v = await c.login({ sub: VIEWER });
		viewer = { cookie: v.session as string, ...XT, origin: PUBLIC };
		const o = await c.login({ sub: OWNER });
		owner = { cookie: o.session as string, ...XT, origin: PUBLIC };
	});
	afterAll(async () => {
		await h.close();
		rmSync(join(web, ".."), { recursive: true, force: true });
	});

	for (const who of ["viewer", "owner on an unblessed device"] as const) {
		test(`${who}: the server's configuration, secrets and every write are refused`, async () => {
			const headers = who === "viewer" ? viewer : owner;
			const check = await asJson(await h.call("/v1/auth/check", { headers }));
			expect(check.role).toBe("web");
			// Only the owner is told the browser isn't trusted yet; a viewer just reads.
			expect(check.untrustedOwner).toBe(who === "viewer" ? undefined : true);
			const refused = async (path: string, init: RequestInit = {}) => {
				const res = await h.call(path, { ...init, headers: { "content-type": "application/json", ...headers } });
				expect(`${init.method ?? "GET"} ${path} ${res.status}`).toBe(`${init.method ?? "GET"} ${path} 403`);
				const text = await res.text();
				expect(text).not.toContain("secret-webhook-path");
				expect(text).not.toContain(ADMIN);
			};
			// The settings (runtime and file), storage, the access list, the signing keys, devices, a report.
			await refused("/v1/admin/settings");
			await refused("/v1/settings");
			await refused("/v1/storage");
			await refused("/v1/access");
			await refused("/v1/access/keys");
			await refused("/v1/admin/devices");
			// Every write.
			await refused("/v1/admin/settings", { method: "PATCH", body: JSON.stringify({ alertWebhookUrl: null }) });
			await refused("/v1/admin/settings/test-alert", { method: "POST" });
			await refused("/v1/access", { method: "PUT", body: JSON.stringify({ seq: 2, owners: [VIEWER] }) });
			await refused("/v1/access/keys", { method: "PUT", body: JSON.stringify({ keys: [] }) });
			await refused("/v1/admin/devices/0123456789abcdef", { method: "DELETE" });
			await refused("/v1/central/report", { method: "POST" });
			await refused("/v1/identity/backfill", { method: "POST", body: "{}" });
			await refused("/v1/erasure", { method: "POST", body: JSON.stringify({ pid: "p1" }) });
			// A session can't bless its own device: that takes the admin token or the signing key.
			const bless = await h.call("/auth/device", { method: "POST", body: JSON.stringify({ token: "" }), headers: { "content-type": "application/json", ...headers } });
			expect(bless.status).toBe(401);
			expect(bless.headers.getSetCookie().some((x) => x.startsWith("tt_device="))).toBe(false);
			// /healthz gives the session the plain answer.
			expect(await asJson(await h.call("/healthz", { headers }))).toEqual({ ok: true });
		});
	}

	test("no .env (or any dotfile, or anything outside the build folder) is ever served", async () => {
		for (const path of ["/.env", "/api/.env", "/assets/../.env", "/%2e%2e/.env", "/..%2f.env", "/.git/config", "/../.env", "/%2eenv", "/%2Eenv", "/assets/.hidden/x.js", "/assets/%2ehidden/x.js", "/..env", "/%2e%2eenv", "/assets/./.hidden/x.js"]) {
			const res = await h.call(path, { headers: viewer });
			const text = await res.text();
			expect(`${path} ${text.includes("leaked-admin-token")}`).toBe(`${path} false`);
			expect(res.status === 404 || text.includes("<title>explorer</title>")).toBe(true);
		}
		// The data folder's files are not routes.
		for (const path of ["/instance.key", "/devices.json", "/access.json", "/api/instance.key"]) {
			const res = await h.call(path, { headers: viewer });
			expect(res.status).toBe(404);
		}
		expect(T0).toBeGreaterThan(0);
	});
});
