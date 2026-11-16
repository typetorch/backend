/**
 * A fake Roblox OAuth (discovery, token endpoint, JWKS with a key pair made here) for tests that drive Sign in with
 * Roblox (the same fake as test/oauth.test.ts). Every id, key and secret is made up; nothing leaves the process.
 */
import { createHash } from "node:crypto";
import { T0 } from "./harness.ts";

export const CLIENT_ID = "1234567890123456789";
export const CLIENT_SECRET = "RBX-fake-client-secret-for-tests-0123456789";
export const PUBLIC = "https://backend.example.com";
const ISSUER = "https://apis.roblox.com/oauth/";
export const OWNER = 1001;
const b64 = (bytes: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).toString("base64url");

export interface TestKey {
	kid: string;
	privateKey: CryptoKey;
	jwk: Record<string, unknown>;
}

export async function makeKey(kid: string): Promise<TestKey> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
	return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
}

export async function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
	const head = b64(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid, ...header }));
	const body = b64(JSON.stringify(claims));
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64(signature)}`;
}

/** A fake Roblox: records what it was asked and answers like the real endpoints do. */
export class FakeRoblox {
	keys: TestKey[] = [];
	calls = { discovery: 0, jwks: 0, token: 0 };
	/** Code -> what the authorize request asked for and which ID token claims to hand out. */
	codes = new Map<string, { challenge: string; nonce: string; claims: (base: Record<string, unknown>) => Record<string, unknown>; signer?: TestKey; header?: Record<string, unknown> }>();
	tokenRequests: URLSearchParams[] = [];
	now = () => T0;

	readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url === "https://apis.roblox.com/oauth/.well-known/openid-configuration") {
			this.calls.discovery++;
			return reply({
				issuer: ISSUER,
				authorization_endpoint: "https://apis.roblox.com/oauth/v1/authorize",
				token_endpoint: "https://apis.roblox.com/oauth/v1/token",
				jwks_uri: "https://apis.roblox.com/oauth/v1/certs",
				userinfo_endpoint: "https://apis.roblox.com/oauth/v1/userinfo",
			});
		}
		if (url === "https://apis.roblox.com/oauth/v1/certs") {
			this.calls.jwks++;
			return reply({ keys: this.keys.map((k) => k.jwk) });
		}
		if (url === "https://apis.roblox.com/oauth/v1/token" && init?.method === "POST") {
			this.calls.token++;
			const form = new URLSearchParams(String(init.body));
			this.tokenRequests.push(form);
			const entry = this.codes.get(form.get("code") ?? "");
			if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET || !entry) return reply({ error: "invalid_grant" }, 400);
			if (form.get("redirect_uri") !== `${PUBLIC}/v1/auth/roblox/callback`) return reply({ error: "invalid_request" }, 400);
			// PKCE: the verifier must hash to the challenge sent with the authorize request.
			if (b64(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== entry.challenge) return reply({ error: "invalid_grant" }, 400);
			this.codes.delete(form.get("code") as string);
			const claims = entry.claims({ iss: ISSUER, aud: CLIENT_ID, sub: String(OWNER), exp: Math.floor(this.now() / 1000) + 900, iat: Math.floor(this.now() / 1000), nonce: entry.nonce });
			const id_token = await signJwt(entry.signer ?? (this.keys[0] as TestKey), claims, entry.header);
			return reply({ access_token: "fake-access-token-never-kept", refresh_token: "fake-refresh-token-never-kept", token_type: "Bearer", expires_in: 900, id_token, scope: "openid profile" });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	/** What the user does at Roblox: the authorize URL goes in, a code for the callback comes out. */
	approve(authorizeUrl: string, claims: (base: Record<string, unknown>) => Record<string, unknown> = (c) => c, extra: { signer?: TestKey; header?: Record<string, unknown> } = {}): string {
		const q = new URL(authorizeUrl).searchParams;
		const code = `code-${this.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
		this.codes.set(code, { challenge: q.get("code_challenge") as string, nonce: q.get("nonce") as string, claims, ...extra });
		return code;
	}
}

