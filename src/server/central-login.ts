/**
 * Sign in with typetorch.dev (plans typetorch-dev-login): the backend is the relying party of the central broker.
 * Authorization code with PKCE (S256), `state` in a short-lived cookie, a `nonce` that goes through the broker to Roblox,
 * no client secret. The callback redeems the code server to server at `<issuer>/token` and checks two signatures:
 *
 *  1. the broker's identity assertion (EdDSA JWS, keys from `<issuer>/.well-known/jwks.json` cached by kid, optional kid
 *     pinning): `iss` is the issuer, `aud` is this backend's own fingerprint (never a URL or the Host header), `nonce` is
 *     the cookie's, `exp` in the future, `iat` at most two minutes old, `jti` never seen before;
 *  2. Roblox's own ID token passed through the broker: signed by Roblox, `aud` TypeTorch's Roblox client id, `nonce` the
 *     cookie's, `sub` the assertion's. So the broker alone can never produce a login.
 *
 * TypeTorch's Roblox client id and Roblox's discovery document come from the broker's public login metadata
 * (`<issuer>/.well-known/typetorch-login`: its `issuer` must equal the configured one exactly; cached an hour; a failed
 * fetch backs off, and until one succeeds every login fails closed). TYPETORCH_ROBLOX_BROKER_CLIENT_ID and
 * TYPETORCH_ROBLOX_BROKER_DISCOVERY pin them: a pinned value is used, and a published value that differs refuses logins.
 * The discovery URL is always pinned: unset, the pin is Roblox's own (ROBLOX_DISCOVERY_URL), so the broker can never
 * choose whose keys sign the Roblox ID token. Only a local (loopback) broker, e.g. dash with its fake Roblox, may name
 * its own discovery URL without a pin.
 *
 * Either failing is "not signed in". The broker's answers are never shown to the person; log details carry no token.
 * The role decision, the device check and the session are app.ts's (the per-game sign-in's code path).
 */
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { discoveryUrlOf, ROBLOX_CLIENT_ID_PATTERN } from "./config.ts";
import { OAuthError, PENDING_TTL_MS, MAX_PENDING_PER_ADDRESS, ROBLOX_DISCOVERY_URL, RobloxIdTokens, isLoopbackHost, safeEqual, type RobloxIdentity } from "./roblox-oauth.ts";

const MAX_PENDING = 1000;
const HTTP_TIMEOUT_MS = 10_000;
const JWKS_TTL_MS = 3_600_000;
const JWKS_REFETCH_MIN_MS = 60_000;
const CLOCK_SKEW_MS = 30_000;
/** An assertion older than this (by its `iat`) is refused. */
export const ASSERTION_MAX_AGE_MS = 120_000;
const JTI_MAX = 10_000;
const MAX_TOKEN_ANSWER = 64 * 1024;
/** The broker's login metadata: size cap, cache, and the backoff after a failed fetch (doubling up to the max). */
const MAX_METADATA = 16 * 1024;
const METADATA_TTL_MS = 3_600_000;
const METADATA_BACKOFF_MIN_MS = 2_000;
const METADATA_BACKOFF_MAX_MS = 300_000;
export const LOGIN_METADATA_PATH = "/.well-known/typetorch-login";

/** What Roblox's ID token is checked against: the broker's published values, or the pins. */
export interface RobloxSettings {
	clientId: string;
	discoveryUrl: string;
}

/** Reads at most `max` bytes of a body; more is an error (the rest is cancelled). */
async function readCapped(response: Response, max: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			throw new Error("too long");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export interface CentralLoginOptions {
	/** The broker's origin, e.g. https://dash.typetorch.dev (the assertion's `iss`). */
	issuer: string;
	/** This backend's fingerprint (the assertion's `aud`). */
	fingerprint: string;
	/** `<public url>/auth/typetorch/callback` */
	redirectUri: string;
	/**
	 * A pin of TypeTorch's Roblox OAuth client id (the `aud` of Roblox's ID token). Unset: the broker's published
	 * `roblox_client_id` is used. Set: it is used, and a different published value refuses every login.
	 */
	robloxClientId?: string;
	/**
	 * A pin of Roblox's OIDC discovery document, same rules (a fake Roblox in tests and local runs). Unset, the pin is
	 * Roblox's own ROBLOX_DISCOVERY_URL (none only for a loopback issuer).
	 */
	robloxDiscoveryUrl?: string;
	/** Where the once-only pin mismatch line goes. */
	log?: (line: string) => void;
	/** Only these broker key ids are accepted (TYPETORCH_CENTRAL_LOGIN_KIDS). */
	pinnedKids?: readonly string[];
	fetch?: typeof fetch;
	clock?: () => number;
}

interface Pending {
	verifier: string;
	nonce: string;
	created: number;
	owner: string;
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");

export class CentralLogin {
	private readonly pending = new Map<string, Pending>();
	private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	/** Plain http for Roblox's discovery and keys only when the broker itself is a local one (dash's fake Roblox). */
	private readonly loopbackIssuer: boolean;
	/** The discovery URL the broker's published one must equal: the configured pin, else Roblox's own (none on loopback). */
	private readonly discoveryPin: string | undefined;
	/** Roblox's discovery and keys, for the discovery URL in use (made again if it changes). */
	private roblox: { url: string; tokens: RobloxIdTokens } | undefined;
	private metadata: { at: number; settings: RobloxSettings } | undefined;
	private metadataFailure: { at: number; backoffMs: number; reason: string } | undefined;
	private metadataInFlight: Promise<RobloxSettings> | undefined;
	/** Pin mismatches already logged (one line each). */
	private readonly loggedMismatch = new Set<string>();
	private keys: { at: number; fetchedAt: number; byKid: Map<string, KeyObject> } | undefined;
	/** jti -> when it may be forgotten (its exp). */
	private readonly seenJti = new Map<string, number>();

	constructor(private readonly o: CentralLoginOptions) {
		this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
		this.clock = o.clock ?? Date.now;
		this.loopbackIssuer = isLoopbackHost(new URL(o.issuer).hostname);
		this.discoveryPin = o.robloxDiscoveryUrl ?? (this.loopbackIssuer ? undefined : ROBLOX_DISCOVERY_URL);
	}

	/**
	 * The Roblox client id and discovery URL for the ID token check: the broker's metadata (cached an hour), with the
	 * pins winning. Throws OAuthError (fail closed) when the metadata can't be had, is malformed, names another issuer,
	 * or differs from a pin.
	 */
	async robloxSettings(): Promise<RobloxSettings> {
		const now = this.clock();
		let published: RobloxSettings;
		if (this.metadata && now - this.metadata.at < METADATA_TTL_MS) published = this.metadata.settings;
		else {
			const failed = this.metadataFailure;
			if (failed && now - failed.at < failed.backoffMs) throw new OAuthError("failed", `typetorch.dev login metadata unavailable (${failed.reason}; retrying later)`);
			this.metadataInFlight ??= this.fetchMetadata().finally(() => (this.metadataInFlight = undefined));
			published = await this.metadataInFlight;
		}
		const mismatch = (what: string, pinned: string | undefined, value: string) => {
			if (pinned === undefined || pinned === value) return;
			const line = `typetorch.dev login: the broker's published ${what} differs from the pinned one; refusing typetorch.dev logins until they match`;
			if (!this.loggedMismatch.has(what)) {
				this.loggedMismatch.add(what);
				this.o.log?.(line);
			}
			throw new OAuthError("failed", `typetorch.dev login metadata: ${what} differs from the pin`);
		};
		mismatch("Roblox client id (TYPETORCH_ROBLOX_BROKER_CLIENT_ID)", this.o.robloxClientId, published.clientId);
		mismatch("Roblox discovery URL (TYPETORCH_ROBLOX_BROKER_DISCOVERY)", this.discoveryPin, published.discoveryUrl);
		return published;
	}

	/** GET <issuer>/.well-known/typetorch-login, validated. A failure starts (or doubles) the backoff. */
	private async fetchMetadata(): Promise<RobloxSettings> {
		try {
			const settings = await this.readMetadata();
			this.metadata = { at: this.clock(), settings };
			this.metadataFailure = undefined;
			return settings;
		} catch (error) {
			const reason = error instanceof OAuthError ? error.detail : "unexpected error";
			const backoffMs = this.metadataFailure ? Math.min(this.metadataFailure.backoffMs * 2, METADATA_BACKOFF_MAX_MS) : METADATA_BACKOFF_MIN_MS;
			this.metadataFailure = { at: this.clock(), backoffMs, reason };
			// A stale cached value is not used: the login fails closed until a fetch succeeds.
			this.metadata = undefined;
			throw error instanceof OAuthError ? error : new OAuthError("failed", reason);
		}
	}

	private async readMetadata(): Promise<RobloxSettings> {
		let text: string;
		try {
			const response = await this.doFetch(new URL(LOGIN_METADATA_PATH, this.o.issuer).toString(), { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => {});
				throw new OAuthError("failed", `typetorch.dev login metadata answered ${response.status}`);
			}
			text = await readCapped(response, MAX_METADATA);
		} catch (error) {
			if (error instanceof OAuthError) throw error;
			throw new OAuthError("failed", `typetorch.dev login metadata unreachable or too large (${(error as Error).name})`);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new OAuthError("failed", "typetorch.dev login metadata is not JSON");
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new OAuthError("failed", "typetorch.dev login metadata is not an object");
		const m = raw as Record<string, unknown>;
		if (m.issuer !== this.o.issuer) throw new OAuthError("failed", "typetorch.dev login metadata names another issuer");
		if (typeof m.roblox_client_id !== "string" || !ROBLOX_CLIENT_ID_PATTERN.test(m.roblox_client_id)) throw new OAuthError("failed", "typetorch.dev login metadata has no valid roblox_client_id");
		const discoveryUrl = typeof m.roblox_discovery === "string" ? discoveryUrlOf(m.roblox_discovery) : undefined;
		if (!discoveryUrl || (!this.loopbackIssuer && !discoveryUrl.startsWith("https:"))) throw new OAuthError("failed", "typetorch.dev login metadata has no valid roblox_discovery (https; http on loopback only for a loopback issuer)");
		return { clientId: m.roblox_client_id, discoveryUrl };
	}

	private robloxTokens(discoveryUrl: string): RobloxIdTokens {
		if (this.roblox?.url !== discoveryUrl) {
			this.roblox = { url: discoveryUrl, tokens: new RobloxIdTokens({ allowLoopbackHttp: this.loopbackIssuer, discoveryUrl, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.clock ? { clock: this.o.clock } : {}) }) };
		}
		return this.roblox.tokens;
	}

	get issuer(): string {
		return this.o.issuer;
	}

	get fingerprint(): string {
		return this.o.fingerprint;
	}

	/**
	 * Step 2: where to send the browser and the state for the short-lived cookie. `owner` (the client's address) holds at
	 * most MAX_PENDING_PER_ADDRESS sign-ins in progress; when the table is full the biggest holder loses its oldest.
	 */
	start(owner = ""): { url: string; state: string } {
		const now = this.clock();
		for (const [state, p] of this.pending) if (now - p.created > PENDING_TTL_MS) this.pending.delete(state);
		const mine = [...this.pending].filter(([, p]) => p.owner === owner).map(([state]) => state);
		while (mine.length >= MAX_PENDING_PER_ADDRESS) this.pending.delete(mine.shift() as string);
		while (this.pending.size >= MAX_PENDING) {
			const by = new Map<string, string[]>();
			for (const [state, p] of this.pending) by.set(p.owner, [...(by.get(p.owner) ?? []), state]);
			let most: string[] = [];
			for (const list of by.values()) if (list.length > most.length) most = list;
			this.pending.delete(most[0] as string);
		}
		const state = b64url(randomBytes(32));
		const nonce = b64url(randomBytes(32));
		const verifier = b64url(randomBytes(32));
		this.pending.set(state, { verifier, nonce, created: now, owner });
		const url = new URL("/authorize", this.o.issuer);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("project", this.o.fingerprint);
		url.searchParams.set("redirect_uri", this.o.redirectUri);
		url.searchParams.set("state", state);
		url.searchParams.set("nonce", nonce);
		url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
		url.searchParams.set("code_challenge_method", "S256");
		return { url: url.toString(), state };
	}

	/**
	 * Steps 5 to 7: the browser came back with a code. Single use: the state is spent whatever happens next. Returns the
	 * verified Roblox identity; throws OAuthError.
	 */
	async complete(query: { code?: string | null; state?: string | null; error?: string | null }, cookieState: string | undefined): Promise<RobloxIdentity> {
		const state = query.state ?? "";
		const pending = state && state.length <= 128 ? this.pending.get(state) : undefined;
		if (state) this.pending.delete(state);
		if (!state || !cookieState || !safeEqual(state, cookieState)) throw new OAuthError("state", "state does not match the cookie");
		if (!pending || this.clock() - pending.created > PENDING_TTL_MS) throw new OAuthError("state", "state unknown or expired");
		if (query.error) throw new OAuthError(query.error === "access_denied" ? "denied" : "failed", `typetorch.dev answered error=${query.error.slice(0, 40).replace(/[^\w.-]/g, "_")}`);
		if (!query.code || query.code.length > 512) throw new OAuthError("failed", "no code");

		// Before the code is redeemed: without the broker's metadata (or with a pin mismatch) nothing can be verified.
		const roblox = await this.robloxSettings();
		const answer = await this.redeem(query.code, pending.verifier);
		const claims = await this.verifyAssertion(answer.assertion, pending.nonce);
		let identity: RobloxIdentity;
		try {
			identity = await this.robloxTokens(roblox.discoveryUrl).verify(answer.robloxIdToken, { clientId: roblox.clientId, nonce: pending.nonce });
		} catch (error) {
			const detail = error instanceof OAuthError ? error.detail : "unexpected error";
			// The broker sent a Roblox token for another login: a live login was redirected (plans: "Trust concentration").
			throw new OAuthError("failed", /nonce/.test(detail) ? "Roblox ID token: nonce mismatch after typetorch.dev login" : `Roblox ID token: ${detail}`);
		}
		if (String(identity.userId) !== claims.sub) throw new OAuthError("failed", "Roblox ID token sub differs from the typetorch.dev assertion");
		return identity;
	}

	/** POST <issuer>/token: the code, the redirect URI and the PKCE verifier. Any failure is "not signed in". */
	private async redeem(code: string, verifier: string): Promise<{ assertion: string; robloxIdToken: string }> {
		let response: Response;
		try {
			response = await this.doFetch(new URL("/token", this.o.issuer).toString(), {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: this.o.redirectUri, code_verifier: verifier }),
				redirect: "manual",
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
		} catch (error) {
			throw new OAuthError("failed", `typetorch.dev /token unreachable (${(error as Error).name})`);
		}
		// The body of a failed answer is never read into a message or the log.
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw new OAuthError("failed", `typetorch.dev /token answered ${response.status}`);
		}
		let body: Record<string, unknown>;
		try {
			const text = await response.text();
			if (text.length > MAX_TOKEN_ANSWER) throw new Error("too long");
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new OAuthError("failed", "typetorch.dev /token did not answer JSON");
		}
		if (typeof body !== "object" || body === null || typeof body.assertion !== "string" || typeof body.roblox_id_token !== "string") throw new OAuthError("failed", "typetorch.dev /token answer is missing the assertion or the Roblox ID token");
		return { assertion: body.assertion, robloxIdToken: body.roblox_id_token };
	}

	private async fetchKeys(): Promise<Map<string, KeyObject>> {
		let raw: { keys?: unknown };
		try {
			const response = await this.doFetch(new URL("/.well-known/jwks.json", this.o.issuer).toString(), { redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => {});
				throw new OAuthError("failed", `typetorch.dev JWKS answered ${response.status}`);
			}
			raw = (await response.json()) as { keys?: unknown };
		} catch (error) {
			if (error instanceof OAuthError) throw error;
			throw new OAuthError("failed", `typetorch.dev JWKS unreachable or not JSON (${(error as Error).name})`);
		}
		const byKid = new Map<string, KeyObject>();
		for (const k of Array.isArray(raw?.keys) ? raw.keys.slice(0, 20) : []) {
			const jwk = k as Record<string, unknown>;
			if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.kid !== "string" || jwk.kid.length > 128) continue;
			if (jwk.alg !== undefined && jwk.alg !== "EdDSA") continue;
			if (jwk.use !== undefined && jwk.use !== "sig") continue;
			try {
				byKid.set(jwk.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }));
			} catch {}
		}
		return byKid;
	}

	/** The broker key for `kid`: from the cache, or the JWKS fetched again (an unknown kid refetches at most once a minute). */
	private async keyFor(kid: string): Promise<KeyObject | undefined> {
		const now = this.clock();
		if (this.keys && now - this.keys.at < JWKS_TTL_MS) {
			const cached = this.keys.byKid.get(kid);
			if (cached) return cached;
			if (now - this.keys.fetchedAt < JWKS_REFETCH_MIN_MS) return undefined;
		}
		const byKid = await this.fetchKeys();
		this.keys = { at: now, fetchedAt: now, byKid };
		return byKid.get(kid);
	}

	private async verifyAssertion(jws: string, nonce: string): Promise<{ sub: string }> {
		const parts = jws.split(".");
		if (parts.length !== 3 || jws.length > 8192) throw new OAuthError("failed", "assertion is not a compact JWS");
		let header: Record<string, unknown>;
		let claims: Record<string, unknown>;
		try {
			header = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8"));
			claims = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
		} catch {
			throw new OAuthError("failed", "assertion is not JSON");
		}
		if (typeof header !== "object" || header === null || typeof claims !== "object" || claims === null) throw new OAuthError("failed", "assertion is not JSON");
		if (header.alg !== "EdDSA") throw new OAuthError("failed", "assertion alg is not EdDSA");
		if (header.crit !== undefined) throw new OAuthError("failed", "assertion header has crit");
		const kid = header.kid;
		if (typeof kid !== "string" || !kid || kid.length > 128) throw new OAuthError("failed", "assertion has no kid");
		if (this.o.pinnedKids?.length && !this.o.pinnedKids.includes(kid)) throw new OAuthError("failed", "assertion kid is not pinned (TYPETORCH_CENTRAL_LOGIN_KIDS)");
		const key = await this.keyFor(kid);
		if (!key) throw new OAuthError("failed", "assertion kid is unknown to typetorch.dev's JWKS");
		let valid = false;
		try {
			valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), key, Buffer.from(parts[2] as string, "base64url"));
		} catch {
			valid = false;
		}
		if (!valid) throw new OAuthError("failed", "assertion signature is not valid");

		const now = this.clock();
		if (claims.iss !== this.o.issuer) throw new OAuthError("failed", "assertion issuer is wrong");
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (aud.length !== 1 || aud[0] !== this.o.fingerprint) throw new OAuthError("failed", "assertion audience is not this backend's fingerprint");
		if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, nonce)) throw new OAuthError("failed", "assertion nonce does not match");
		if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS < now) throw new OAuthError("failed", "assertion expired");
		if (typeof claims.iat !== "number" || now - claims.iat * 1000 > ASSERTION_MAX_AGE_MS || claims.iat * 1000 - CLOCK_SKEW_MS > now) throw new OAuthError("failed", "assertion iat is outside the two-minute window");
		if (typeof claims.sub !== "string" || !/^\d{1,16}$/.test(claims.sub) || Number(claims.sub) <= 0) throw new OAuthError("failed", "assertion has no Roblox user id");
		const jti = claims.jti;
		if (typeof jti !== "string" || jti.length < 8 || jti.length > 128) throw new OAuthError("failed", "assertion has no jti");
		for (const [seen, until] of this.seenJti) if (until < now) this.seenJti.delete(seen);
		if (this.seenJti.has(jti)) throw new OAuthError("failed", "assertion jti was seen before (replay)");
		this.seenJti.set(jti, Math.max(claims.exp * 1000 + CLOCK_SKEW_MS, claims.iat * 1000 + ASSERTION_MAX_AGE_MS));
		while (this.seenJti.size > JTI_MAX) this.seenJti.delete(this.seenJti.keys().next().value as string);
		return { sub: claims.sub };
	}
}
