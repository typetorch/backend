/**
 * Game pass and developer product names, prices and icons for the explorer's product tooltips, from Roblox's public APIs.
 * Only fixed https hosts are called (apis.roblox.com, thumbnails.roblox.com), without credentials (never the Open Cloud
 * key: the public endpoints below answer by id); the only inputs are checked positive integers, so nothing from a request
 * becomes anything but digits in a fixed URL. Redirects are refused, every call has a timeout and a body cap, and icons
 * must be https URLs on *.rbxcdn.com (the explorer's CSP img-src already allows that).
 *
 *   game pass        GET apis.roblox.com/game-passes/v1/game-passes/<id>/product-info
 *                    GET thumbnails.roblox.com/v1/game-passes?gamePassIds=<ids>
 *   developer product GET apis.roblox.com/developer-products/v1/developer-products/<id>/details
 *                    GET thumbnails.roblox.com/v1/developer-products/icons?developerProductIds=<TargetIds from details>
 *
 * Answers are kept in memory (found: `ttlMs`, default 1 h; not found: 10 min; Roblox down: 1 min), at most MAX_ENTRIES
 * items; while Roblox doesn't answer, an older good answer is served. At most `perMinute` calls a minute leave the server
 * (items past the cap answer `unavailable` and are not cached), at most CONCURRENCY at a time, one lookup per item at a time.
 */
import { RateLimiter } from "./http.ts";
import { cdnUrl, readCapped } from "./roblox-profiles.ts";

export const ROBLOX_GAME_PASS_INFO_URL = "https://apis.roblox.com/game-passes/v1/game-passes/";
export const ROBLOX_DEV_PRODUCT_INFO_URL = "https://apis.roblox.com/developer-products/v1/developer-products/";
export const ROBLOX_GAME_PASS_ICONS_URL = "https://thumbnails.roblox.com/v1/game-passes";
export const ROBLOX_DEV_PRODUCT_ICONS_URL = "https://thumbnails.roblox.com/v1/developer-products/icons";
/** Ids per request (and per thumbnails batch). */
export const MAX_PRODUCT_IDS = 50;
/** A product's details are 1-2 KB; an icon batch of 50 well under 16 KB. */
const MAX_BODY = 64 * 1024;
const MAX_ENTRIES = 2000;
const CONCURRENCY = 6;
const NOT_FOUND_TTL = 10 * 60_000;
const DOWN_TTL = 60_000;

export type ProductType = "gamepass" | "product";
/** ok: Roblox answered; not_found: Roblox has no such item; unavailable: Roblox didn't answer (or the call cap was hit). */
export type ProductStatus = "ok" | "not_found" | "unavailable";

export interface ProductInfo {
	type: ProductType;
	id: number;
	status: ProductStatus;
	name: string | null;
	/** Robux; null when Roblox gives none (e.g. off sale). */
	price: number | null;
	forSale: boolean | null;
	/** An https icon on Roblox's CDN (*.rbxcdn.com), 150x150. */
	icon: string | null;
}

export interface ProductRequest {
	gamepass: number[];
	product: number[];
}

export interface RobloxProductsOptions {
	fetch?: typeof fetch;
	clock?: () => number;
	/** How long a found item is kept (default 1 h). */
	ttlMs?: number;
	/** Per call (default 4 s). */
	timeoutMs?: number;
	/** Roblox calls a minute (default 240). */
	perMinute?: number;
}

type Fetched = { status: number; body?: unknown } | { status: 0 };

interface Entry {
	info: ProductInfo;
	expires: number;
}

export const isProductId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const keyOf = (type: ProductType, id: number) => `${type}:${id}`;
const bare = (type: ProductType, id: number, status: ProductStatus): ProductInfo => ({ type, id, status, name: null, price: null, forSale: null, icon: null });

export class RobloxProducts {
	private readonly cache = new Map<string, Entry>();
	private readonly inFlight = new Map<string, Promise<ProductInfo>>();
	private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	private readonly limiter: RateLimiter;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;
	private running = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(o: RobloxProductsOptions = {}) {
		this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
		this.clock = o.clock ?? Date.now;
		this.limiter = new RateLimiter(o.perMinute ?? 240, this.clock);
		this.ttlMs = o.ttlMs ?? 60 * 60_000;
		this.timeoutMs = o.timeoutMs ?? 4000;
	}

	/** The items in request order (game passes first), duplicates dropped. Throws on a bad id or too many ids. */
	async get(request: ProductRequest): Promise<ProductInfo[]> {
		const wanted: [ProductType, number][] = [];
		const seen = new Set<string>();
		for (const type of ["gamepass", "product"] as const) {
			for (const id of request[type]) {
				if (!isProductId(id)) throw new Error("ids must be positive integers");
				const key = keyOf(type, id);
				if (seen.has(key)) continue;
				seen.add(key);
				wanted.push([type, id]);
			}
		}
		if (wanted.length > MAX_PRODUCT_IDS) throw new Error(`at most ${MAX_PRODUCT_IDS} ids`);
		const now = this.clock();
		const answers = new Map<string, Promise<ProductInfo>>();
		const fresh: [ProductType, number][] = [];
		for (const [type, id] of wanted) {
			const key = keyOf(type, id);
			const hit = this.cache.get(key);
			if (hit && hit.expires > now) answers.set(key, Promise.resolve(hit.info));
			else if (this.inFlight.has(key)) answers.set(key, this.inFlight.get(key) as Promise<ProductInfo>);
			else fresh.push([type, id]);
		}
		if (fresh.length) {
			const batch = this.lookup(fresh);
			for (const [type, id] of fresh) {
				const key = keyOf(type, id);
				const stale = this.cache.get(key)?.info;
				const one = batch
					.then((found) => {
						const info = found.get(key) ?? bare(type, id, "unavailable");
						// Roblox didn't answer: keep serving the older good answer for another while.
						if (info.status === "unavailable" && stale?.status === "ok") {
							this.remember(key, stale, DOWN_TTL);
							return stale;
						}
						// A call refused by the cap is not remembered: the next request may get it.
						if (!found.refused.has(key)) this.remember(key, info);
						return info;
					})
					.finally(() => this.inFlight.delete(key));
				this.inFlight.set(key, one);
				answers.set(key, one);
			}
		}
		return Promise.all(wanted.map(([type, id]) => answers.get(keyOf(type, id)) as Promise<ProductInfo>));
	}

	/** The cached item, fresh or not (tests and diagnostics). */
	peek(type: ProductType, id: number): ProductInfo | undefined {
		return this.cache.get(keyOf(type, id))?.info;
	}

	private remember(key: string, info: ProductInfo, ttlMs?: number): void {
		const ttl = ttlMs ?? (info.status === "ok" ? this.ttlMs : info.status === "not_found" ? NOT_FOUND_TTL : DOWN_TTL);
		this.cache.delete(key);
		this.cache.set(key, { info, expires: this.clock() + ttl });
		while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
	}

	private async lookup(items: [ProductType, number][]): Promise<Map<string, ProductInfo> & { refused: Set<string> }> {
		const out = Object.assign(new Map<string, ProductInfo>(), { refused: new Set<string>() });
		const targets = new Map<string, number>();
		// The details first (they take from the call cap first), then the game pass icons alongside them (by game pass id).
		const details = Promise.all(
			items.map(async ([type, id]) => {
				const info = await this.details(type, id, targets);
				if (info === "refused") out.refused.add(keyOf(type, id));
				else out.set(keyOf(type, id), info);
			}),
		);
		const passes = items.filter(([t]) => t === "gamepass").map(([, id]) => id);
		const passIcons = passes.length ? this.icons(ROBLOX_GAME_PASS_ICONS_URL, "gamePassIds", passes) : Promise.resolve(new Map<number, string>());
		await details;
		const productTargets = [...targets.values()];
		const productIcons = productTargets.length ? await this.icons(ROBLOX_DEV_PRODUCT_ICONS_URL, "developerProductIds", productTargets) : new Map<number, string>();
		const gotPassIcons = await passIcons;
		for (const info of out.values()) {
			if (info.status !== "ok") continue;
			const icon = info.type === "gamepass" ? gotPassIcons.get(info.id) : productIcons.get(targets.get(keyOf("product", info.id)) ?? 0);
			if (icon) info.icon = icon;
		}
		return out;
	}

	private async details(type: ProductType, id: number, targets: Map<string, number>): Promise<ProductInfo | "refused"> {
		if (!this.limiter.take("roblox")) return "refused";
		const url = type === "gamepass" ? `${ROBLOX_GAME_PASS_INFO_URL}${id}/product-info` : `${ROBLOX_DEV_PRODUCT_INFO_URL}${id}/details`;
		const r = await this.limited(() => this.getJson(url));
		if (r.status === 404 || r.status === 400) return bare(type, id, "not_found");
		if (r.status !== 200 || !("body" in r) || typeof r.body !== "object" || r.body === null) return bare(type, id, "unavailable");
		const b = r.body as Record<string, unknown>;
		// The answer must be about this id: TargetId for a game pass, ProductId for a developer product.
		if ((type === "gamepass" ? b.TargetId : b.ProductId) !== id) return bare(type, id, "unavailable");
		const info = bare(type, id, "ok");
		info.name = cleanName(b.Name) ?? cleanName(b.DisplayName);
		const priceInfo = typeof b.PriceInformation === "object" && b.PriceInformation !== null ? (b.PriceInformation as Record<string, unknown>).defaultPriceInRobux : undefined;
		info.price = robux(b.PriceInRobux) ?? robux(priceInfo);
		info.forSale = typeof b.IsForSale === "boolean" ? b.IsForSale : null;
		// A developer product's icon goes by its internal TargetId.
		if (type === "product" && isProductId(b.TargetId)) targets.set(keyOf(type, id), b.TargetId);
		return info;
	}

	/** One thumbnails batch: id -> https icon on *.rbxcdn.com; empty on any failure. */
	private async icons(base: string, param: string, ids: number[]): Promise<Map<number, string>> {
		const out = new Map<number, string>();
		for (let i = 0; i < ids.length; i += MAX_PRODUCT_IDS) {
			if (!this.limiter.take("roblox")) break;
			const chunk = ids.slice(i, i + MAX_PRODUCT_IDS);
			const r = await this.limited(() => this.getJson(`${base}?${param}=${chunk.join(",")}&size=150x150&format=Png&isCircular=false`));
			const data = r.status === 200 && "body" in r && typeof r.body === "object" && r.body !== null ? (r.body as { data?: unknown }).data : undefined;
			if (!Array.isArray(data)) continue;
			for (const d of data) {
				if (typeof d !== "object" || d === null) continue;
				const item = d as Record<string, unknown>;
				if (!isProductId(item.targetId) || !chunk.includes(item.targetId) || item.state !== "Completed") continue;
				const url = cdnUrl(item.imageUrl);
				if (url) out.set(item.targetId, url);
			}
		}
		return out;
	}

	/** At most CONCURRENCY calls at a time. */
	private async limited<T>(run: () => Promise<T>): Promise<T> {
		if (this.running >= CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.running++;
		try {
			return await run();
		} finally {
			this.running--;
			this.waiting.shift()?.();
		}
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

function cleanName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100);
	return clean || null;
}

function robux(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** "1,2,3" -> [1, 2, 3]; undefined for an empty or bad list (digits only, up to 19 each, at most MAX_PRODUCT_IDS + 1 items read). */
export function parseIdList(text: string | null): number[] | undefined {
	if (text === null) return [];
	if (text.length > (MAX_PRODUCT_IDS + 1) * 21) return undefined;
	const parts = text.split(",");
	const out: number[] = [];
	for (const p of parts) {
		if (!/^[1-9]\d{0,18}$/.test(p)) return undefined;
		const n = Number(p);
		if (!isProductId(n)) return undefined;
		out.push(n);
	}
	return out;
}
