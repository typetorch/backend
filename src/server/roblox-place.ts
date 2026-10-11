/**
 * The game's place card in the explorer's sidebar: its name, live player count and icon, from Roblox's public APIs.
 * Only fixed https hosts are called (apis.roblox.com, games.roblox.com, thumbnails.roblox.com), without credentials
 * (never the Open Cloud key); the only inputs are checked positive integers (TYPETORCH_UNIVERSE_ID, or a PlaceId from
 * the fleet's heartbeats), so nothing from a request becomes a URL. Redirects are refused, every call has a timeout and
 * a body cap, and the icon must be an https URL on *.rbxcdn.com (the explorer's CSP img-src already allows that).
 *
 * Answers are kept in memory for `ttlMs` (default 60 s). While Roblox doesn't answer, an older good answer is served for
 * another `ttlMs`; with none, the answer is `unavailable` (the card shows a placeholder icon and no count). At most
 * `perMinute` lookups a minute leave the server, and one lookup per source at a time.
 */
import { RateLimiter } from "./http.ts";
import { cdnUrl, readCapped } from "./roblox-profiles.ts";

export const ROBLOX_PLACE_UNIVERSE_URL = "https://apis.roblox.com/universes/v1/places/";
export const ROBLOX_GAMES_URL = "https://games.roblox.com/v1/games";
export const ROBLOX_GAME_ICONS_URL = "https://thumbnails.roblox.com/v1/games/icons";
/** A game's details are a few KB; the icon answer well under 1 KB. */
const MAX_BODY = 128 * 1024;
const MAX_ENTRIES = 8;

export type PlaceStatus = "ok" | "partial" | "unavailable";

export interface PlaceSource {
	universeId?: number;
	placeId?: number;
}

export interface PlaceInfo {
	placeId: number | null;
	universeId: number | null;
	name: string | null;
	/** Players in the game right now (Roblox's count, refreshed by Roblox every minute or so). */
	playing: number | null;
	/** An https icon on Roblox's CDN (*.rbxcdn.com), 512x512. */
	icon: string | null;
}

export interface PlaceAnswer {
	place: PlaceInfo;
	status: PlaceStatus;
	cached: boolean;
}

export interface RobloxPlaceOptions {
	fetch?: typeof fetch;
	clock?: () => number;
	/** How long an answer is kept (default 60 s). */
	ttlMs?: number;
	/** Per call (default 4 s). */
	timeoutMs?: number;
	/** Lookups a minute (default 30). */
	perMinute?: number;
}

type Fetched = { status: number; body?: unknown } | { status: 0 };

interface Entry {
	answer: { place: PlaceInfo; status: PlaceStatus };
	expires: number;
}

const isId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export class RobloxPlace {
	private readonly cache = new Map<string, Entry>();
	private readonly inFlight = new Map<string, Promise<PlaceAnswer>>();
	/** PlaceId -> UniverseId (fixed for a place, so kept for the life of the process; bounded). */
	private readonly universeOf = new Map<number, number>();
	private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	private readonly limiter: RateLimiter;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;

	constructor(o: RobloxPlaceOptions = {}) {
		this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
		this.clock = o.clock ?? Date.now;
		this.limiter = new RateLimiter(o.perMinute ?? 30, this.clock);
		this.ttlMs = o.ttlMs ?? 60_000;
		this.timeoutMs = o.timeoutMs ?? 4000;
	}

	async get(source: PlaceSource): Promise<PlaceAnswer> {
		const universeId = isId(source.universeId) ? source.universeId : undefined;
		const placeId = isId(source.placeId) ? source.placeId : undefined;
		if (!universeId && !placeId) throw new Error("a positive universeId or placeId is required");
		const key = universeId ? `u${universeId}` : `p${placeId}`;
		const now = this.clock();
		const hit = this.cache.get(key);
		if (hit && hit.expires > now) return { ...hit.answer, cached: true };
		const pending = this.inFlight.get(key);
		if (pending) return pending;
		const bare: PlaceInfo = { placeId: placeId ?? null, universeId: universeId ?? null, name: null, playing: null, icon: null };
		if (!this.limiter.take("roblox")) return hit ? { ...hit.answer, cached: true } : { place: bare, status: "unavailable", cached: false };
		const lookup = this.lookup(bare)
			.then((answer): PlaceAnswer => {
				// Roblox didn't answer: keep serving the older good answer for another while.
				if (answer.status === "unavailable" && hit && hit.answer.status !== "unavailable") {
					this.remember(key, { answer: hit.answer, expires: this.clock() + this.ttlMs });
					return { ...hit.answer, cached: true };
				}
				this.remember(key, { answer, expires: this.clock() + this.ttlMs });
				return { ...answer, cached: false };
			})
			.finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, lookup);
		return lookup;
	}

	private remember(key: string, entry: Entry): void {
		this.cache.delete(key);
		this.cache.set(key, entry);
		while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
	}

	private async lookup(bare: PlaceInfo): Promise<{ place: PlaceInfo; status: PlaceStatus }> {
		const place = { ...bare };
		if (!place.universeId && place.placeId) {
			const known = this.universeOf.get(place.placeId);
			if (known) place.universeId = known;
			else {
				const r = await this.getJson(`${ROBLOX_PLACE_UNIVERSE_URL}${place.placeId}/universe`);
				const u = r.status === 200 && "body" in r && typeof r.body === "object" && r.body !== null ? (r.body as { universeId?: unknown }).universeId : undefined;
				if (!isId(u)) return { place, status: "unavailable" };
				place.universeId = u;
				if (this.universeOf.size >= MAX_ENTRIES) this.universeOf.clear();
				this.universeOf.set(place.placeId, u);
			}
		}
		const id = String(place.universeId);
		const [games, icons] = await Promise.all([
			this.getJson(`${ROBLOX_GAMES_URL}?universeIds=${id}`),
			this.getJson(`${ROBLOX_GAME_ICONS_URL}?universeIds=${id}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`),
		]);
		const gameOk = games.status === 200 && "body" in games && readGame(games.body, place);
		const icon = icons.status === 200 && "body" in icons ? readIcon(icons.body, place.universeId as number) : null;
		if (icon) place.icon = icon;
		return { place, status: gameOk && icon ? "ok" : gameOk || icon ? "partial" : "unavailable" };
	}

	/** One GET with a deadline over the body too (a plain timer: see RobloxProfiles.getJson). Status 0 on any failure. */
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

/** games.roblox.com/v1/games: { data: [{ id, rootPlaceId, name, playing, ... }] }. Fills `place`; false on a wrong shape. */
function readGame(body: unknown, place: PlaceInfo): boolean {
	const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) return false;
	const g = data.find((d): d is Record<string, unknown> => typeof d === "object" && d !== null && (d as { id?: unknown }).id === place.universeId);
	if (!g) return false;
	if (typeof g.name === "string") {
		const clean = g.name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100);
		if (clean) place.name = clean;
	}
	if (typeof g.playing === "number" && Number.isSafeInteger(g.playing) && g.playing >= 0) place.playing = g.playing;
	if (isId(g.rootPlaceId)) place.placeId = g.rootPlaceId;
	return place.name !== null;
}

/** thumbnails.roblox.com/v1/games/icons: { data: [{ targetId, state, imageUrl }] }. Only an https URL on *.rbxcdn.com. */
function readIcon(body: unknown, universeId: number): string | null {
	const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) return null;
	const item = data.find((d): d is Record<string, unknown> => typeof d === "object" && d !== null && (d as { targetId?: unknown }).targetId === universeId);
	if (!item || item.state !== "Completed") return null;
	return cdnUrl(item.imageUrl);
}
