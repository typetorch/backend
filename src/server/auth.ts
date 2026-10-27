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
 * Explorer sessions are random 32-byte ids kept in memory (12 h idle / 7 days at most), bound to a hash of the admin
 * token they were made with, so changing the token ends them all. A session is made by pasting the admin token or by
 * signing in with Roblox as an owner (admin) or a viewer (web). The cookie is HttpOnly, SameSite=Strict (Lax for the short OAuth state cookie only)
 * and Secure over https. A request authenticated by the cookie that changes something also needs the X-TypeTorch header
 * (and a matching Origin when the browser sends one); Bearer requests need neither, a browser can't attach them by itself.
 */
import { createHash, randomBytes } from "node:crypto";
import { bearer, readCookie, tokenIn } from "./http.ts";

export const SESSION_COOKIE = "tt_session";
export const CSRF_HEADER = "x-typetorch";

/** Who a session belongs to. */
export type SessionUser =
	| { kind: "token" }
	| { kind: "roblox"; userId: number; name: string; displayName?: string; avatar?: string; login?: "typetorch.dev" };

/** What a session (or a Bearer) may do: `admin` reads and manages, `web` only reads. */
export type AccessRole = "admin" | "web";

export interface Session {
	user: SessionUser;
	role: AccessRole;
	created: number;
	seen: number;
	/** Hash of the admin token this session was made with. */
	tokenHash: string;
	/** The blessed device a typetorch.dev admin session came from: revoking the device ends the session. */
	device?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface SessionsOptions {
	adminToken: string;
	idleMs: number;
	maxMs: number;
	/** Oldest sessions go first past this many. */
	maxSessions?: number;
	clock?: () => number;
}

export class Sessions {
	private readonly byId = new Map<string, Session>();
	private readonly tokenHash: string;
	private readonly clock: () => number;

	constructor(private readonly options: SessionsOptions) {
		this.tokenHash = Sessions.hashToken(options.adminToken);
		this.clock = options.clock ?? Date.now;
	}

	static hashToken(adminToken: string): string {
		return sha256(`tt-session-v1\0${adminToken}`);
	}

	/** A new session; returns the cookie value (a random 32-byte id, base64url). */
	create(user: SessionUser, role: AccessRole = "admin", tokenHash: string = this.tokenHash, device?: string): string {
		const id = randomBytes(32).toString("base64url");
		const now = this.clock();
		this.sweep(now);
		this.byId.set(sha256(id), { user, role, created: now, seen: now, tokenHash, ...(device ? { device } : {}) });
		const max = this.options.maxSessions ?? 200;
		while (this.byId.size > max) this.byId.delete(this.byId.keys().next().value as string);
		return id;
	}

	/** The live session for a cookie value (and refreshes its idle timer), or undefined. */
	get(id: string | undefined): Session | undefined {
		if (!id || id.length > 128) return undefined;
		const key = sha256(id);
		const session = this.byId.get(key);
		if (!session) return undefined;
		const now = this.clock();
		if (session.tokenHash !== this.tokenHash || now - session.seen > this.options.idleMs || now - session.created > this.options.maxMs) {
			this.byId.delete(key);
			return undefined;
		}
		session.seen = now;
		return session;
	}

	destroy(id: string | undefined): boolean {
		return id ? this.byId.delete(sha256(id)) : false;
	}

	/** Ends every session the predicate matches; returns how many. */
	endWhere(match: (session: Session) => boolean): number {
		let ended = 0;
		for (const [key, session] of this.byId) {
			if (match(session)) {
				this.byId.delete(key);
				ended++;
			}
		}
		return ended;
	}

	private sweep(now: number): void {
		for (const [key, s] of this.byId) if (now - s.seen > this.options.idleMs || now - s.created > this.options.maxMs) this.byId.delete(key);
	}

	get size(): number {
		return this.byId.size;
	}
}

export type Principal =
	| { role: "game"; via: "bearer" }
	| { role: AccessRole; via: "bearer"; user: SessionUser }
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
}

export class Auth {
	constructor(private readonly o: AuthOptions) {}

	get sessions(): Sessions {
		return this.o.sessions;
	}

	/** The request carries the admin token as a Bearer header. */
	hasAdminBearer(req: Request): boolean {
		return tokenIn(bearer(req), [this.o.adminToken]);
	}

	hasGameKey(req: Request): boolean {
		return tokenIn(bearer(req), this.o.apiKeys);
	}

	/** The request carries the lookup token as a Bearer header (never true while no lookup token is set). */
	hasLookupBearer(req: Request): boolean {
		return this.o.lookupToken !== undefined && tokenIn(bearer(req), [this.o.lookupToken]);
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
		if (session.user.kind === "roblox" && !this.robloxStillHolds(session.user.userId, session.role)) {
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
	 * The caller's role. A Bearer header decides alone (a wrong Bearer is not rescued by a cookie); without one the
	 * session cookie counts. Tokens are never read from the URL.
	 */
	principal(req: Request): Principal | undefined {
		if (bearer(req) !== undefined) {
			if (this.hasAdminBearer(req)) return { role: "admin", via: "bearer", user: { kind: "token" } };
			if (this.hasGameKey(req)) return { role: "game", via: "bearer" };
			return undefined;
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
		if (!allowed.has(host)) return "cross-origin request refused";
	}
	return undefined;
}
