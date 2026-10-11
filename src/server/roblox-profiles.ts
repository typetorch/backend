/**
 * Roblox profiles for the explorer's player detail: the username, display name and avatar headshot of a UserId, from
 * Roblox's public APIs. Only two fixed https hosts are called (users.roblox.com, thumbnails.roblox.com); the UserId is
 * the only input and it is a checked integer, so nothing from a request becomes a URL. Redirects are refused, every call
 * has a timeout and a body cap.
 *
 * Answers are cached in memory only (never on disk, never logged): good ones for `ttlMs`, failures for `failTtlMs`
 * (so an outage isn't hammered), at most `maxEntries` UserIds (the least recently used go first). At most `perMinute`
 * lookups a minute and `maxInFlight` at once leave the server; past that the caller gets an older answer if there is
 * one, else `unavailable` (the explorer then shows the bare UserId).
 */
import { RateLimiter } from "./http.ts";

export const ROBLOX_USERS_URL = "https://users.roblox.com/v1/users/";
export const ROBLOX_HEADSHOT_URL = "https://thumbnails.roblox.com/v1/users/avatar-headshot";
/** The largest answer read from either API (a user or one thumbnail is well under 2 KB). */
const MAX_BODY = 64 * 1024;

export interface RobloxProfile {
	userId: number;
	/** The username (letters, digits, `_`). */
	name: string | null;
	displayName: string | null;
	/** An https headshot on Roblox's CDN (*.rbxcdn.com). */
	avatar: string | null;
}

/** ok: both APIs answered; partial: one did (or the headshot isn't rendered yet); not-found: no such user. */
export type ProfileStatus = "ok" | "partial" | "not-found" | "unavailable";

export interface ProfileAnswer {
	profile: RobloxProfile;
	status: ProfileStatus;
	/** Served from memory (a fresh entry, or an older one while Roblox didn't answer). */
	cached: boolean;
}

export interface RobloxProfilesOptions {
	fetch?: typeof fetch;
	clock?: () => number;
	/** How long a good answer is kept (default 6 h). */
	ttlMs?: number;
	/** How long a failed or partial answer is kept (default 60 s). */
	failTtlMs?: number;
	/** Most UserIds kept (default 5000). */
	maxEntries?: number;
	/** Per call (default 4 s). */
	timeoutMs?: number;
	/** Lookups (two calls each) a minute, across all callers (default 120). */
	perMinute?: number;
	/** Lookups at once (default 8). */
	maxInFlight?: number;
}

interface Entry {
	answer: { profile: RobloxProfile; status: ProfileStatus };
	expires: number;
}

type Fetched = { status: number; body?: unknown } | { status: 0 };

const USERNAME = /^[A-Za-z0-9_]{1,32}$/;

export class RobloxProfiles {
	private readonly cache = new Map<number, Entry>();
	private readonly inFlight = new Map<number, Promise<ProfileAnswer>>();
	private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	private readonly limiter: RateLimiter;
	private readonly ttlMs: number;
	private readonly failTtlMs: number;
	private readonly maxEntries: number;
	private readonly timeoutMs: number;
	private readonly maxInFlight: number;

	constructor(o: RobloxProfilesOptions = {}) {
		this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
		this.clock = o.clock ?? Date.now;
		this.limiter = new RateLimiter(o.perMinute ?? 120, this.clock);
		this.ttlMs = o.ttlMs ?? 6 * 3_600_000;
		this.failTtlMs = o.failTtlMs ?? 60_000;
		this.maxEntries = Math.max(1, o.maxEntries ?? 5000);
		this.timeoutMs = o.timeoutMs ?? 4000;
		this.maxInFlight = Math.max(1, o.maxInFlight ?? 8);
	}

	/** UserIds in memory now. */
	get size(): number {
		return this.cache.size;
	}

	/** A UserId's profile from memory only (no lookup, no rate limit used), and whether it is still fresh; undefined when not cached. */
	peek(userId: number): { profile: RobloxProfile; fresh: boolean } | undefined {
		const hit = this.cache.get(userId);
		return hit ? { profile: hit.answer.profile, fresh: hit.expires > this.clock() } : undefined;
	}

	async get(userId: number): Promise<ProfileAnswer> {
		if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("userId must be a positive integer");
		const now = this.clock();
		const hit = this.cache.get(userId);
		if (hit && hit.expires > now) {
			this.cache.delete(userId);
			this.cache.set(userId, hit);
			return { ...hit.answer, cached: true };
		}
		const pending = this.inFlight.get(userId);
		if (pending) return pending;
		if (this.inFlight.size >= this.maxInFlight || !this.limiter.take("roblox")) {
			return hit ? { ...hit.answer, cached: true } : { profile: bare(userId), status: "unavailable", cached: false };
		}
		const lookup = this.lookup(userId)
			.then((answer): ProfileAnswer => {
				// Roblox didn't answer: keep serving an older good answer for a while instead of dropping to the bare UserId.
				if (answer.status === "unavailable" && hit && hit.answer.status !== "unavailable") {
					this.remember(userId, { answer: hit.answer, expires: this.clock() + this.failTtlMs });
					return { ...hit.answer, cached: true };
				}
				const good = answer.status === "ok" || answer.status === "not-found";
				this.remember(userId, { answer, expires: this.clock() + (good ? this.ttlMs : this.failTtlMs) });
				return { ...answer, cached: false };
			})
			.finally(() => this.inFlight.delete(userId));
		this.inFlight.set(userId, lookup);
		return lookup;
	}

	private remember(userId: number, entry: Entry): void {
		this.cache.delete(userId);
		this.cache.set(userId, entry);
		while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as number);
	}

	private async lookup(userId: number): Promise<{ profile: RobloxProfile; status: ProfileStatus }> {
		const id = String(userId);
		const [user, thumbs] = await Promise.all([
			this.getJson(`${ROBLOX_USERS_URL}${id}`),
			this.getJson(`${ROBLOX_HEADSHOT_URL}?userIds=${id}&size=150x150&format=Png&isCircular=false`),
		]);
		const profile = bare(userId);
		if (user.status === 404 || user.status === 400) return { profile, status: "not-found" };
		const userOk = user.status === 200 && "body" in user && readUser(user.body, userId, profile);
		const thumb = thumbs.status === 200 && "body" in thumbs ? readHeadshot(thumbs.body, userId) : undefined;
		if (thumb?.url) profile.avatar = thumb.url;
		// A headshot still rendering ("Pending") is asked again soon; a moderated one ("Blocked") is an answer.
		const thumbOk = thumb !== undefined && thumb.state !== "Pending";
		return { profile, status: userOk && thumbOk ? "ok" : userOk || thumb?.url ? "partial" : "unavailable" };
	}

	/**
	 * One GET: the status and the parsed JSON body (status 0 when it failed, timed out or was too big). The deadline covers
	 * the body too, and holds even if the fetch ignored its signal (a plain timer, not AbortSignal.timeout: Bun doesn't fire
	 * that one while nothing else keeps the event loop busy).
	 */
	private async getJson(url: string): Promise<Fetched> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<Fetched>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve({ status: 0 });
			}, this.timeoutMs);
		});
		try {
			return await Promise.race([this.fetchJson(url, controller.signal), deadline]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async fetchJson(url: string, signal: AbortSignal): Promise<Fetched> {
		let response: Response;
		try {
			response = await this.doFetch(url, { headers: { accept: "application/json" }, redirect: "error", signal });
		} catch {
			return { status: 0 };
		}
		try {
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => {});
				return { status: response.status };
			}
			const text = await readCapped(response, MAX_BODY);
			if (text === null) return { status: 0 };
			return { status: 200, body: JSON.parse(text) };
		} catch {
			return { status: 0 };
		}
	}
}

function bare(userId: number): RobloxProfile {
	return { userId, name: null, displayName: null, avatar: null };
}

/** users.roblox.com/v1/users/<id>: { id, name, displayName, ... }. Fills `profile`; false when the shape is wrong. */
function readUser(body: unknown, userId: number, profile: RobloxProfile): boolean {
	if (typeof body !== "object" || body === null) return false;
	const b = body as Record<string, unknown>;
	if (b.id !== userId) return false;
	if (typeof b.name === "string" && USERNAME.test(b.name)) profile.name = b.name;
	if (typeof b.displayName === "string") {
		const clean = b.displayName.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 64);
		if (clean) profile.displayName = clean;
	}
	return profile.name !== null;
}

/** thumbnails.roblox.com avatar-headshot: { data: [{ targetId, state, imageUrl }] }. Only an https URL on *.rbxcdn.com. */
function readHeadshot(body: unknown, userId: number): { state: string; url: string | null } | undefined {
	const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) return undefined;
	const item = data.find((d): d is Record<string, unknown> => typeof d === "object" && d !== null && (d as { targetId?: unknown }).targetId === userId);
	if (!item) return undefined;
	const state = typeof item.state === "string" ? item.state : "";
	return { state, url: state === "Completed" ? cdnUrl(item.imageUrl) : null };
}

export function cdnUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 512) return null;
	try {
		const u = new URL(value);
		return u.protocol === "https:" && !u.username && !u.password && !u.port && u.hostname.endsWith(".rbxcdn.com") ? u.toString() : null;
	} catch {
		return null;
	}
}

/** The body as text, or null past `max` bytes (stops reading there). */
export async function readCapped(response: Response, max: number): Promise<string | null> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > max) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}
