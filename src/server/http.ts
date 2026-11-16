/** Small HTTP helpers shared by the analytics and fleet routes: JSON answers, bearer tokens, rate limits. */
import { createHash, timingSafeEqual } from "node:crypto";
import { ipAllowed, parseIp, type IpRule } from "./ipfilter.ts";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export function bearer(req: Request): string | undefined {
	const header = req.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(\S+)$/i.exec(header);
	return match?.[1];
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/** Constant-time check of a token against a list (hashes first, so lengths don't leak). */
export function tokenIn(given: string | undefined, accepted: readonly (string | undefined)[]): boolean {
	if (!given) return false;
	const g = digest(given);
	let ok = false;
	for (const token of accepted) if (token && timingSafeEqual(g, digest(token))) ok = true;
	return ok;
}

/** Which proxies are believed about the client's address. */
export interface ProxyTrust {
	/** How many proxies sit in front (Coolify's Traefik = 1); 0 = the TCP peer is the client. */
	hops: number;
	/** When set, X-Forwarded-For is only read when the TCP peer is one of these (and only trusted hops are walked). */
	proxies?: readonly IpRule[];
	/** When set and the address found so far is one of these (Cloudflare's edge), CF-Connecting-IP is the client. */
	cloudflare?: readonly IpRule[];
}

/**
 * The client's IP: the TCP peer, or with trusted proxies the Nth hop from the right of X-Forwarded-For (what the
 * nearest proxy appended: the address it saw). `trust` = how many proxies sit in front (true = 1, false/0 = none), or
 * a ProxyTrust: with `proxies`, a peer outside that list is the client whatever headers it sends (so a client that
 * reaches the port directly can't choose its address), and hops are walked right to left only while they are trusted.
 * With `cloudflare`, an address inside Cloudflare's ranges is replaced by the CF-Connecting-IP header.
 */
export function clientIp(req: Request, peer: string, trust: boolean | number | ProxyTrust): string {
	const t: ProxyTrust = typeof trust === "object" ? trust : { hops: trust === true ? 1 : trust === false ? 0 : trust };
	let ip = peer;
	if (t.hops > 0 && (!t.proxies || ipAllowed(t.proxies, peer))) {
		const forwarded = req.headers.get("x-forwarded-for");
		const list = forwarded
			?.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
		if (list?.length) {
			if (!t.proxies) ip = list[Math.max(0, list.length - t.hops)] as string;
			else {
				let i = list.length - 1;
				for (let hop = 1; hop < t.hops && i > 0 && ipAllowed(t.proxies, list[i] as string); hop++) i--;
				ip = list[i] as string;
			}
		}
	}
	if (t.cloudflare && ipAllowed(t.cloudflare, ip)) {
		const real = req.headers.get("cf-connecting-ip")?.trim();
		if (real && parseIp(real)) ip = real;
	}
	return ip;
}

/**
 * Token buckets per key: `perMinute` requests, refilled continuously. Idle keys are dropped. `perMinute` may be a function
 * (a runtime setting): it is read on every request, so a change applies to the next one.
 */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; at: number }>();
	private sweeps = 0;
	private readonly limit: () => number;

	constructor(
		perMinute: number | (() => number),
		private readonly clock: () => number = Date.now,
	) {
		this.limit = typeof perMinute === "function" ? perMinute : () => perMinute;
	}

	/** The current limit. */
	get perMinute(): number {
		return this.limit();
	}

	/** True when the request may go ahead; false = 429. */
	take(key: string, cost = 1): boolean {
		const now = this.clock();
		if (++this.sweeps % 10_000 === 0) this.sweep(now);
		const perMinute = this.limit();
		const bucket = this.buckets.get(key) ?? { tokens: perMinute, at: now };
		bucket.tokens = Math.min(perMinute, bucket.tokens + (Math.max(0, now - bucket.at) / 60_000) * perMinute);
		bucket.at = Math.max(bucket.at, now);
		this.buckets.set(key, bucket);
		if (bucket.tokens < cost) return false;
		bucket.tokens -= cost;
		return true;
	}

	/** Seconds until `cost` tokens are back. */
	retryAfter(key: string, cost = 1): number {
		const bucket = this.buckets.get(key);
		if (!bucket) return 0;
		return Math.max(1, Math.ceil(((cost - bucket.tokens) / this.perMinute) * 60));
	}

	private sweep(now: number): void {
		for (const [key, bucket] of this.buckets) if (now - bucket.at > 120_000) this.buckets.delete(key);
	}

	get size(): number {
		return this.buckets.size;
	}
}

export function tooMany(seconds: number): Response {
	return json(429, { error: "rate limited" }, { "retry-after": String(seconds) });
}

/** Reads a request body as bytes, refusing more than `max`. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > max) return null;
	const body = new Uint8Array(await req.arrayBuffer());
	return body.length > max ? null : body;
}

/** Failures per key (an IP) inside a window; past the limit the key is blocked until its oldest failure ages out. */
export class FailureLimiter {
	private failures = new Map<string, number[]>();
	private sweeps = 0;

	constructor(
		readonly maxFailures: number,
		readonly windowMs: number,
		private readonly clock: () => number = Date.now,
	) {}

	private recent(key: string, now: number): number[] {
		const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
		if (list.length) this.failures.set(key, list);
		else this.failures.delete(key);
		return list;
	}

	/** Seconds until the key may try again; 0 = not blocked. */
	blocked(key: string): number {
		const now = this.clock();
		const list = this.recent(key, now);
		if (list.length < this.maxFailures) return 0;
		return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
	}

	/** Failures inside the window. */
	count(key: string): number {
		return this.recent(key, this.clock()).length;
	}

	fail(key: string): void {
		const now = this.clock();
		if (++this.sweeps % 1000 === 0) for (const k of [...this.failures.keys()]) this.recent(k, now);
		const list = this.recent(key, now);
		list.push(now);
		this.failures.set(key, list.slice(-this.maxFailures * 2));
		// Never track an unbounded number of addresses.
		if (this.failures.size > 50_000) this.failures.delete(this.failures.keys().next().value as string);
	}

	reset(key: string): void {
		this.failures.delete(key);
	}

	get size(): number {
		return this.failures.size;
	}
}

// Cookies -----------------------------------------------------------------------------------------------------------------

export function readCookie(req: Request, name: string): string | undefined {
	const header = req.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

export interface CookieOptions {
	maxAgeSeconds?: number;
	secure: boolean;
	sameSite: "Strict" | "Lax";
	path?: string;
}

/** A Set-Cookie value: always HttpOnly; Secure when the request came over https. */
export function setCookie(name: string, value: string, o: CookieOptions): string {
	const parts = [`${name}=${value}`, `Path=${o.path ?? "/"}`, "HttpOnly", `SameSite=${o.sameSite}`];
	if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAgeSeconds)}`);
	if (o.secure) parts.push("Secure");
	return parts.join("; ");
}

export function clearCookie(name: string, o: Omit<CookieOptions, "maxAgeSeconds">): string {
	return setCookie(name, "", { ...o, maxAgeSeconds: 0 });
}

// Security headers --------------------------------------------------------------------------------------------------------

/** The explorer's CSP: its own scripts and styles only; avatars from Roblox's CDN; it talks to this origin only. */
export const EXPLORER_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.rbxcdn.com; font-src 'self' data:; connect-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** Everything that isn't the explorer's page: JSON and event streams load nothing. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Returns the response with the security headers added (a copy: the headers of a Response may be immutable). */
export function withSecurityHeaders(response: Response, o: { https: boolean; csp: string }): Response {
	const headers = new Headers(response.headers);
	headers.set("x-content-type-options", "nosniff");
	// A page may ask for a looser one (the mobile consent page: same-origin, so its form POST carries a real Origin).
	if (!headers.has("referrer-policy")) headers.set("referrer-policy", "no-referrer");
	headers.set("x-frame-options", "DENY");
	headers.set("cross-origin-resource-policy", "same-origin");
	headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
	if (!headers.has("content-security-policy")) headers.set("content-security-policy", o.csp);
	if (o.https) headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
