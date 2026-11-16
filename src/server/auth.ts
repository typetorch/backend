/**
 * Who is calling. Three roles (and one narrow token):
 *   game  - the API key (or the previous one while it is rotated): game servers write events, heartbeats, deploy reports,
 *           alerts and error logs. It reads nothing.
 *   admin - the admin token as a Bearer header (the CLI), or an explorer session cookie: reads and manages.
 *   web   - read-only: a Roblox viewer's explorer session (the `webViewers` setting; Sign in with Roblox only, no token).
 *           Sees everything the explorer shows, changes nothing.
 *   lookup - the lookup token (TYPETORCH_LOOKUP_TOKEN, optional) as a Bearer header: GET /v1/identity/resolve only (pid <->
 *           UserId), for scripts and LLM agents. It is not a Principal: every other route refuses it before any handler runs.
 *
 * Named API keys (plans/31, server/keys.ts: `ttk_<id>_<secret>`) are Bearers with a role: `admin` keys act as the admin
 * role, `game` keys as the API key, `analyst` keys as the read-only role (their scopes stop them before anything else),
 * `lookup` / `support` keys like the lookup token. A key never opens an explorer session.
 *
 * Mobile app tokens (`ttm_<id>_<secret>`, server/mobile-tokens.ts) are Bearers with the admin or the web role of the
 * sign-in that made them, re-checked on every request like an explorer session (the Roblox user's role, the token login
 * for one made with the admin token, the trusted browser for one an owner made through typetorch.dev).
 *
 * Explorer sessions are signed JWTs (HS256, 3 days by default; see Sessions), keyed by a secret in the data dir and a
 * hash of the admin token, so they survive deploys and changing the token ends them all. A session is made by pasting the admin token or by
 * signing in with Roblox as an owner (admin) or a viewer (web). The cookie is HttpOnly, SameSite=Strict (Lax for the short OAuth state cookie only)
 * and Secure over https. A request authenticated by the cookie that changes something also needs the X-TypeTorch header
 * (and a matching Origin when the browser sends one); Bearer requests need neither, a browser can't attach them by itself.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bearer, readCookie, tokenIn } from "./http.ts";
import { KeyStore, type CallerKey, type KeyRole } from "./keys.ts";

export const SESSION_COOKIE = "tt_session";
export const CSRF_HEADER = "x-typetorch";

/** Who a session belongs to. */
export type SessionUser =
	| { kind: "token" }
	| { kind: "roblox"; userId: number; name: string; displayName?: string; avatar?: string; login?: "typetorch.dev" }
	/** A named API key (plans/31): never a session, only a Bearer. */
	| { kind: "key"; id: string; name: string; role: KeyRole };

/** What a session (or a Bearer) may do: `admin` reads and manages, `web` only reads. */
export type AccessRole = "admin" | "web";

export interface Session {
	user: SessionUser;
	role: AccessRole;
	created: number;
	seen: number;
	/** The JWT's id (jti). */
	id?: string;
	/** Hash of the admin token this session was made with. */
	tokenHash: string;
	/** The blessed device a typetorch.dev admin session came from: revoking the device ends the session. */
	device?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface SessionsOptions {
	adminToken: string;
	/** Absolute lifetime of a session (the JWT's exp), ms. */
	maxMs: number;
	/**
	 * Where the signing secret and the signed-out list live (`<data dir>/sessions.json`, mode 0600), so sessions survive a
	 * restart or a deploy. Absent (tests): a random secret in memory.
	 */
	file?: string;
	/** Live sessions this process remembers (for counts and ending them by a rule); oldest go first past this many. */
	maxSessions?: number;
	clock?: () => number;
}

/** The only header a session JWT may carry (anything else, `alg: none` included, is refused before the signature). */
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
/** A JWT is a few hundred bytes; anything far bigger is not ours. */
const JWT_MAX = 4096;
/** Clock skew allowed on `iat` between the two containers of a rolling deploy. */
const SKEW_MS = 60_000;
/** Signed-out ids kept on disk at most (the oldest expire first anyway). */
const REVOKED_MAX = 5000;

interface Claims {
	v: 1;
	jti: string;
	iat: number;
	exp: number;
	role: AccessRole;
	user: SessionUser;
	dev?: string;
}

interface SessionsFile {
	secret: string;
	/** jti -> exp (ms): signed out before their time. */
	revoked: Record<string, number>;
}

function validUser(u: unknown): u is SessionUser {
	if (typeof u !== "object" || u === null) return false;
	const user = u as Record<string, unknown>;
	if (user.kind === "token") return true;
	return user.kind === "roblox" && Number.isSafeInteger(user.userId) && typeof user.name === "string";
}

/**
 * Explorer sessions as signed JWTs (HS256) in the session cookie: nothing per session is kept on the server, so a
 * deploy or a restart signs no one out. The key is HMAC(secret, admin token hash): the secret is made once and kept in
 * the data dir, and changing the admin token makes every session's signature wrong. A session lasts `maxMs` from sign-in
 * (no idle timeout, no sliding renewal). Signing out puts the token's id on a small list on disk until it would have
 * expired anyway, so a copied cookie stops working too.
 */
export class Sessions {
	private readonly tokenHash: string;
	private readonly clock: () => number;
	private secret: Buffer;
	private revoked = new Map<string, number>();
	/** Sessions this process issued or saw since it started (jti -> session, exp): counts and endWhere only. */
	private readonly live = new Map<string, { session: Session; exp: number }>();
	private fileMtime = 0;
	private checkedAt = 0;

	constructor(private readonly options: SessionsOptions) {
		this.tokenHash = Sessions.hashToken(options.adminToken);
		this.clock = options.clock ?? Date.now;
		this.secret = randomBytes(32);
		if (options.file) this.load(true);
	}

	static hashToken(adminToken: string): string {
		return sha256(`tt-session-v1\0${adminToken}`);
	}

	private key(tokenHash: string): Buffer {
		return createHmac("sha256", this.secret).update(`tt-session-jwt-v1\0${tokenHash}`).digest();
	}

	private readFile(): SessionsFile | undefined {
		const file = this.options.file;
		if (!file || !existsSync(file)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionsFile>;
			if (typeof parsed.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.secret)) return undefined;
			const revoked: Record<string, number> = {};
			if (parsed.revoked && typeof parsed.revoked === "object") {
				for (const [jti, exp] of Object.entries(parsed.revoked)) if (typeof exp === "number") revoked[jti] = exp;
			}
			return { secret: parsed.secret, revoked };
		} catch {
			return undefined;
		}
	}

	/** Reads the file (the other container of a rolling deploy may have written it); makes the secret on first start. */
	private load(first = false): void {
		const file = this.options.file as string;
		const found = this.readFile();
		if (found) {
			this.secret = Buffer.from(found.secret, "base64url");
			this.revoked = new Map(Object.entries(found.revoked));
		} else if (first) {
			if (existsSync(file)) throw new Error(`${file} is unreadable: fix or delete it (deleting signs everyone out)`);
			this.write();
		}
		try {
			this.fileMtime = statSync(file).mtimeMs;
		} catch {}
	}

	/** Picks up what the other process wrote, at most every 2 s. */
	private refresh(now: number): void {
		if (!this.options.file || now - this.checkedAt < 2000) return;
		this.checkedAt = now;
		try {
			if (statSync(this.options.file).mtimeMs !== this.fileMtime) this.load();
		} catch {}
	}

	private write(): void {
		const file = this.options.file;
		if (!file) return;
		const now = this.clock();
		// Merge what the other process may have added meanwhile.
		const onDisk = this.readFile();
		if (onDisk && onDisk.secret === this.secret.toString("base64url")) for (const [jti, exp] of Object.entries(onDisk.revoked)) if (!this.revoked.has(jti)) this.revoked.set(jti, exp);
		for (const [jti, exp] of this.revoked) if (exp <= now) this.revoked.delete(jti);
		while (this.revoked.size > REVOKED_MAX) this.revoked.delete(this.revoked.keys().next().value as string);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ secret: this.secret.toString("base64url"), revoked: Object.fromEntries(this.revoked) })}\n`, { mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {}
		renameSync(tmp, file);
		try {
			this.fileMtime = statSync(file).mtimeMs;
		} catch {}
	}

	/** Re-reads the file now (the handover: the previous container is gone). */
	reload(): void {
		if (this.options.file) this.load();
	}

	/** A new session; returns the cookie value (a JWT). */
	create(user: SessionUser, role: AccessRole = "admin", tokenHash: string = this.tokenHash, device?: string): string {
		const now = this.clock();
		const claims: Claims = {
			v: 1,
			jti: randomBytes(16).toString("base64url"),
			iat: Math.floor(now / 1000),
			exp: Math.floor((now + this.options.maxMs) / 1000),
			role,
			user,
			...(device ? { dev: device } : {}),
		};
		const body = `${JWT_HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
		const token = `${body}.${createHmac("sha256", this.key(tokenHash)).update(body).digest("base64url")}`;
		if (tokenHash === this.tokenHash) this.remember(claims, now);
		return token;
	}

	private remember(claims: Claims, now: number): Session {
		const session: Session = { user: claims.user, role: claims.role, created: claims.iat * 1000, seen: now, tokenHash: this.tokenHash, id: claims.jti, ...(claims.dev ? { device: claims.dev } : {}) };
		this.live.delete(claims.jti);
		this.live.set(claims.jti, { session, exp: claims.exp * 1000 });
		const max = this.options.maxSessions ?? 1000;
		while (this.live.size > max) this.live.delete(this.live.keys().next().value as string);
		return session;
	}

	/** Checks a cookie value: our signature, not expired, not signed out. */
	private verify(token: string, now: number): Claims | undefined {
		const parts = token.split(".");
		if (parts.length !== 3 || parts[0] !== JWT_HEADER) return undefined;
		const [header, payload, signature] = parts as [string, string, string];
		const expected = createHmac("sha256", this.key(this.tokenHash)).update(`${header}.${payload}`).digest();
		const given = Buffer.from(signature, "base64url");
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
		let claims: Claims;
		try {
			claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
		} catch {
			return undefined;
		}
		if (claims?.v !== 1 || typeof claims.jti !== "string" || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return undefined;
		if (claims.role !== "admin" && claims.role !== "web") return undefined;
		if (!validUser(claims.user) || (claims.dev !== undefined && typeof claims.dev !== "string")) return undefined;
		const iat = claims.iat * 1000;
		// exp, and the lifetime as it is set now (lowering TYPETORCH_SESSION_MAX_DAYS shortens old sessions too).
		if (claims.exp * 1000 <= now || iat > now + SKEW_MS || now - iat > this.options.maxMs) return undefined;
		if (this.revoked.has(claims.jti)) return undefined;
		return claims;
	}

	/** The live session for a cookie value, or undefined. */
	get(token: string | undefined): Session | undefined {
		if (!token || token.length > JWT_MAX) return undefined;
		const now = this.clock();
		this.refresh(now);
		const claims = this.verify(token, now);
		if (!claims) {
			return undefined;
		}
		return this.remember(claims, now);
	}

	/** Signs a cookie value out (it stays refused until it would have expired). */
	destroy(token: string | undefined): boolean {
		if (!token || token.length > JWT_MAX) return false;
		const claims = this.verify(token, this.clock());
		if (!claims) return false;
		this.revoke(claims.jti, claims.exp * 1000);
		this.write();
		return true;
	}

	private revoke(jti: string, exp: number): void {
		this.revoked.set(jti, exp);
		this.live.delete(jti);
	}

	/**
	 * Ends every session this process knows of that the predicate matches; returns how many. Sessions it never saw are
	 * stopped by the checks on every request instead (Auth: the owner / viewer lists, the device, the token login).
	 */
	endWhere(match: (session: Session) => boolean): number {
		const now = this.clock();
		let ended = 0;
		for (const [jti, { session, exp }] of [...this.live]) {
			if (exp <= now) {
				this.live.delete(jti);
				continue;
			}
			if (match(session)) {
				this.revoke(jti, exp);
				ended++;
			}
		}
		if (ended) this.write();
		return ended;
	}

	/** Live sessions this process has issued or seen since it started. */
	get size(): number {
		const now = this.clock();
		for (const [jti, { exp }] of this.live) if (exp <= now || this.revoked.has(jti)) this.live.delete(jti);
		return this.live.size;
	}
}

/** A mobile app token behind a Bearer principal (server/mobile-tokens.ts): its id and when it expires (unix ms). */
export interface MobileRef {
	id: string;
	expires: number;
}

export type Principal =
	| { role: "game"; via: "bearer" }
	| { role: AccessRole; via: "bearer"; user: SessionUser; mobile?: MobileRef }
	| { role: AccessRole; via: "cookie"; user: SessionUser; cookie: string };

/** A signed-in caller: the admin or the web role (never the game key). */
export type SignedIn = Principal & { role: AccessRole };

export interface AuthOptions {
	adminToken: string;
	apiKeys: readonly string[];
	/** The lookup token, when one is set. */
	lookupToken?: string;
	sessions: Sessions;
	/** Whether a Roblox user is (still) an owner; an owner's (admin) session ends when this turns false. */
	isOwner(userId: number): boolean;
	/** Whether a Roblox user is (still) a viewer; a viewer's (web) session ends when this turns false. */
	isViewer(userId: number): boolean;
	/** Named API keys (plans/31); absent = env tokens only. */
	keys?: KeyStore;
	/** Whether the token login is on; a token session ends while it is off. */
	tokenLogin?(): boolean;
	/** Whether a blessed device still is; a session a device opened ends with it. */
	deviceActive?(id: string): boolean;
	/** The mobile app tokens (`ttm_...` Bearers), when the server keeps them. */
	mobileTokens?: {
		resolve(token: string, currentAdminTokenHash: string): { id: string; user: SessionUser; role: AccessRole; expires: number; blessedDevice: string | null } | undefined;
		revoke(id: string, reason: string): Promise<boolean>;
		deadReason(token: string): string | undefined;
	};
}

export class Auth {
	private readonly adminTokenHash: string;

	constructor(private readonly o: AuthOptions) {
		this.adminTokenHash = Sessions.hashToken(o.adminToken);
	}

	get sessions(): Sessions {
		return this.o.sessions;
	}

	/** The request carries the admin token as a Bearer header. */
	hasAdminBearer(req: Request): boolean {
		return tokenIn(bearer(req), [this.o.adminToken]);
	}

	/** The game key (or the previous one), or a named key with `ingest:write` (a game or admin key). */
	hasGameKey(req: Request): boolean {
		return tokenIn(bearer(req), this.o.apiKeys) || Boolean(this.key(req)?.scopes.includes("ingest:write"));
	}

	/**
	 * The lookup token (never true while none is set), or a named lookup / support key: callers that are not principals
	 * and reach only their scoped routes. (Analyst keys read as the web role; admin keys as the admin role.)
	 */
	hasLookupBearer(req: Request): boolean {
		if (this.o.lookupToken !== undefined && tokenIn(bearer(req), [this.o.lookupToken])) return true;
		const key = this.key(req);
		return key?.role === "lookup" || key?.role === "support";
	}

	/** A non-admin bearer that may resolve identities: the lookup token, or a named key with `identity:resolve`. */
	mayResolve(req: Request): boolean {
		if (this.hasLookupBearer(req)) return true;
		const key = this.key(req);
		return Boolean(key && key.role !== "admin" && key.scopes.includes("identity:resolve"));
	}

	/** The active named key behind the Bearer header, or undefined. */
	key(req: Request): CallerKey | undefined {
		const token = bearer(req);
		return this.o.keys && KeyStore.looksLikeKey(token) ? this.o.keys.resolve(token) : undefined;
	}

	/** The role a Roblox user signs in with: owners are admins, viewers get the web role, anyone else stays out. */
	roleOfRobloxUser(userId: number): AccessRole | undefined {
		if (this.o.isOwner(userId)) return "admin";
		if (this.o.isViewer(userId)) return "web";
		return undefined;
	}

	/**
	 * The explorer session behind the request's cookie, if it is live (and its Roblox user still holds the role it signed
	 * in with: an owner for admin, a viewer for web; a promotion or demotion takes a new sign-in).
	 */
	cookieSession(req: Request): { session: Session; cookie: string } | undefined {
		const cookie = readCookie(req, SESSION_COOKIE);
		const session = this.o.sessions.get(cookie);
		if (!session || !cookie) return undefined;
		const stale =
			(session.user.kind === "roblox" && !this.robloxStillHolds(session.user.userId, session.role)) ||
			(session.user.kind === "token" && this.o.tokenLogin !== undefined && !this.o.tokenLogin()) ||
			(session.device !== undefined && this.o.deviceActive !== undefined && !this.o.deviceActive(session.device));
		if (stale) {
			this.o.sessions.destroy(cookie);
			return undefined;
		}
		return { session, cookie };
	}

	/**
	 * Whether a Roblox user still holds the role of their session. A web session is held by a viewer, or by an owner
	 * who signed in through typetorch.dev on a device that was never blessed (read-only until the device is blessed).
	 */
	robloxStillHolds(userId: number, role: AccessRole): boolean {
		return role === "admin" ? this.o.isOwner(userId) : this.o.isViewer(userId) || this.o.isOwner(userId);
	}

	/**
	 * The live mobile app token behind the request's Bearer (`ttm_...`), with its Roblox user still holding its role (an
	 * owner for admin, a viewer or an owner for web; else the token is revoked), or undefined.
	 */
	mobilePrincipal(req: Request): (Principal & { role: AccessRole; via: "bearer"; mobile: MobileRef }) | undefined {
		const given = bearer(req);
		if (!given?.startsWith("ttm_") || !this.o.mobileTokens) return undefined;
		const t = this.o.mobileTokens.resolve(given, this.adminTokenHash);
		if (!t) return undefined;
		// The same checks as an explorer session (cookieSession): the role still held, the token login still on for a
		// token made with the admin token, the trusted browser still trusted for an owner's typetorch.dev sign-in.
		const stale =
			t.user.kind === "roblox" && !this.robloxStillHolds(t.user.userId, t.role)
				? t.role === "admin"
					? "no longer an owner"
					: "no longer a viewer or an owner"
				: t.user.kind === "token" && this.o.tokenLogin !== undefined && !this.o.tokenLogin()
					? "token login turned off"
					: t.blessedDevice && this.o.deviceActive !== undefined && !this.o.deviceActive(t.blessedDevice)
						? "trusted browser revoked"
						: undefined;
		if (stale) {
			void this.o.mobileTokens.revoke(t.id, stale).catch(() => {});
			return undefined;
		}
		return { role: t.role, via: "bearer", user: t.user, mobile: { id: t.id, expires: t.expires } };
	}

	/**
	 * Why the request's Bearer, a real mobile app token, no longer works (revoked or expired), or undefined. Such a token is
	 * refused without counting as a wrong token (the phone just signs in again).
	 */
	deadMobileToken(req: Request): string | undefined {
		const given = bearer(req);
		if (!given?.startsWith("ttm_") || !this.o.mobileTokens) return undefined;
		return this.o.mobileTokens.deadReason(given);
	}

	/**
	 * The caller's role. A Bearer header decides alone (a wrong Bearer is not rescued by a cookie); without one the
	 * session cookie counts. Tokens are never read from the URL. A mobile app token (`ttm_...`) is a Bearer with the role
	 * and user of its sign-in.
	 */
	principal(req: Request): Principal | undefined {
		if (bearer(req) !== undefined) {
			if (this.hasAdminBearer(req)) return { role: "admin", via: "bearer", user: { kind: "token" } };
			const key = this.key(req);
			if (key) {
				const user: SessionUser = { kind: "key", id: key.id, name: key.name, role: key.role };
				if (key.role === "admin") return { role: "admin", via: "bearer", user };
				if (key.role === "game") return { role: "game", via: "bearer" };
				// An analyst key reads like the web role (its scopes keep it to the query routes); lookup / support keys
				// are not principals, like the lookup token.
				if (key.role === "analyst") return { role: "web", via: "bearer", user };
				return undefined;
			}
			if (this.hasGameKey(req)) return { role: "game", via: "bearer" };
			return this.mobilePrincipal(req);
		}
		const found = this.cookieSession(req);
		return found ? { role: found.session.role, via: "cookie", user: found.session.user, cookie: found.cookie } : undefined;
	}
}

/** Whether the request came over https (directly, or through a trusted proxy that says so, or the public URL is https). */
export function isHttps(req: Request, o: { trustProxy: number; publicUrl?: string }): boolean {
	if (o.publicUrl?.startsWith("https:")) return true;
	if (new URL(req.url).protocol === "https:") return true;
	if (o.trustProxy > 0) {
		const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
		if (proto === "https") return true;
	}
	return false;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The extra checks for a request that changes something and is authenticated by a cookie: the X-TypeTorch header
 * (a cross-site page can't send it without a CORS preflight, which this server never grants) and, when the browser sends
 * an Origin, that it is this site. Returns the reason to refuse, or undefined.
 */
export function cookieMutationProblem(req: Request, o: { trustProxy: number; publicUrl?: string }): string | undefined {
	if (SAFE_METHODS.has(req.method)) return undefined;
	if (req.headers.get(CSRF_HEADER) !== "1") return `requests that change something need the header ${CSRF_HEADER}: 1`;
	return originProblem(req, o);
}

/** When the browser sends an Origin, that it is this site (the host, the public URL's, a trusted proxy's); else the reason. */
export function originProblem(req: Request, o: { trustProxy: number; publicUrl?: string }): string | undefined {
	const origin = req.headers.get("origin");
	if (origin) {
		let host = "";
		try {
			host = new URL(origin).host;
		} catch {
			return "bad Origin";
		}
		const allowed = new Set<string>();
		const own = req.headers.get("host");
		if (own) allowed.add(own);
		allowed.add(new URL(req.url).host);
		if (o.publicUrl) allowed.add(new URL(o.publicUrl).host);
		if (o.trustProxy > 0) {
			const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
			if (forwarded) allowed.add(forwarded);
		}
		if (!host || !allowed.has(host)) return "cross-origin request refused";
	}
	return undefined;
}
