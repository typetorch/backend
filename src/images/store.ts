/**
 * Roblox image assets for the explorer (plans/36 phase 5): map Decals / Textures / MaterialVariant ColorMaps, the
 * tracked models' clothing and the UI's images, as PNGs the browser can draw.
 *
 * The pixels come from Roblox's PUBLIC thumbnails API (no key, nothing runs in the game):
 *   GET https://thumbnails.roblox.com/v1/assets?assetIds=<up to 100>&size=700x700&format=Png&isCircular=false
 *   -> data[]: { targetId, state: Completed | Pending | Blocked | Error | InReview | TemporarilyUnavailable, imageUrl }
 * A Completed id's imageUrl (a *.rbxcdn.com host) is downloaded once and stored as `<data dir>/images/<id>.<png|webp|jpg>`
 * (the type sniffed from the bytes, never the answer's header): an asset id's pixels never change, so a stored image is
 * never fetched again.
 *
 * One resolver loop per backend, gentle on Roblox: at most one thumbnails call a second (BATCH_MAX ids each), Pending /
 * InReview ids retried with a backoff, a 429 / 5xx / no answer backs the whole loop off exponentially (Retry-After
 * honoured), downloads at most DOWNLOADS_MAX at a time. Ids come from the route (`GET /v1/images/<id>`: an unknown id is
 * queued, 202) and from `noteImageIds` (the map export's textures; the replay decoder's UI images and clothing). The
 * queue and the remembered states are bounded; final states (stored, blocked, error, unknown) are kept in
 * `<data dir>/images/index.json` (atomic, 0600) so a restart neither forgets them nor asks Roblox again (blocked is
 * asked again after a week, error / unknown after a day, and only when something asks for the id).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const THUMBNAILS_URL = "https://thumbnails.roblox.com/v1/assets";
export const THUMB_SIZE = "700x700";
/** Ids per thumbnails call (the API's own limit). */
export const BATCH_MAX = 100;
/** The least time between two thumbnails calls (ms). */
export const CALL_GAP_MS = 1000;
/** Ids waiting at most (resolving or downloading); past it new ids are dropped until the queue drains (asked again later). */
export const QUEUE_MAX = 5000;
/** Remembered final states at most (the oldest non-stored ones go first). */
export const KNOWN_MAX = 50_000;
/** A stored image's size at most. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const DOWNLOADS_MAX = 4;
/** Pending retries: PENDING_BASE_MS x 2^try, at most PENDING_CAP_MS; after PENDING_TRIES the id is an error. */
export const PENDING_BASE_MS = 3000;
export const PENDING_CAP_MS = 60_000;
export const PENDING_TRIES = 10;
/** An id the answer leaves out this many times is unknown. */
export const MISSING_TRIES = 3;
export const DOWNLOAD_TRIES = 3;
/** The loop's backoff after a 429 / 5xx / no answer: BACKOFF_BASE_MS x 2^n, at most BACKOFF_CAP_MS. */
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_CAP_MS = 5 * 60_000;
/** When a final failure may be asked again (only when something asks for the id). */
export const RETRY_BLOCKED_MS = 7 * 86_400_000;
export const RETRY_FAILED_MS = 86_400_000;
const INDEX_VERSION = 1;
const SAVE_DELAY_MS = 2000;

export type ImageType = "png" | "webp" | "jpg";
export const CONTENT_TYPES: Record<ImageType, string> = { png: "image/png", webp: "image/webp", jpg: "image/jpeg" };

/** An asset id: digits, no leading zero, at most 20. */
export const ASSET_ID = /^[1-9][0-9]{0,19}$/;

/**
 * The asset id in a Content string, or null: `rbxassetid://123`, `123`, `http(s)://www.roblox.com/asset/?id=123` (any
 * roblox.com host, `asset` or `asset/`, the id anywhere in the query), `rbxthumb://type=Asset&id=123&w=420&h=420`.
 * Built-in content (`rbxasset://textures/...`), other hosts and anything else: null.
 */
export function assetIdOf(content: string): string | null {
	if (typeof content !== "string") return null;
	const s = content.trim();
	if (s.length === 0 || s.length > 2048) return null;
	if (ASSET_ID.test(s)) return s;
	let m = /^rbxassetid:\/\/([0-9]+)\/?(?:[?#].*)?$/i.exec(s);
	if (m) return clean(m[1]);
	m = /^rbxthumb:\/\/(.*)$/i.exec(s);
	if (m) {
		const params = new URLSearchParams(m[1]);
		return /^asset$/i.test(params.get("type") ?? "") ? clean(params.get("id")) : null;
	}
	if (!/^https?:\/\//i.test(s)) return null;
	let url: URL;
	try {
		url = new URL(s);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (host !== "roblox.com" && !host.endsWith(".roblox.com")) return null;
	if (!/^\/asset\/?$/i.test(url.pathname)) return null;
	for (const [k, v] of url.searchParams) if (k.toLowerCase() === "id") return clean(v);
	return null;
}

function clean(id: string | null | undefined): string | null {
	if (!id) return null;
	const digits = id.replace(/^0+/, "");
	return ASSET_ID.test(digits) ? digits : null;
}

/** What `get` answers: the image's bytes, still resolving, or why there is none. */
export type ImageAnswer = { state: "stored"; type: ImageType; bytes: Uint8Array } | { state: "pending" } | { state: "blocked" | "error" | "unknown" };

type FinalState = "stored" | "blocked" | "error" | "unknown";
interface Known {
	state: FinalState;
	at: number;
	type?: ImageType;
	bytes?: number;
}
interface Waiting {
	phase: "resolve" | "download";
	due: number;
	/** Pending answers (resolve), answers that left the id out (missing), failed downloads (download). */
	tries: number;
	missing: number;
	url?: string;
	busy?: boolean;
}

export interface ImageStoreOptions {
	dataDir: string;
	clock?: () => number;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	/** false: no timer (tests call `tick()`). Default true. */
	auto?: boolean;
	/** Timeout of one Roblox call (ms). */
	timeoutMs?: number;
}

export class ImageStore {
	readonly dir: string;
	private readonly file: string;
	private readonly clock: () => number;
	private readonly known = new Map<string, Known>();
	private readonly queue = new Map<string, Waiting>();
	private lastCall = 0;
	private backoff = 0;
	private backoffUntil = 0;
	private downloads = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private ticking: Promise<void> | null = null;
	private stopped = false;
	/** Counters for the status line (GET /v1/images). */
	readonly counts = { calls: 0, rateLimited: 0, downloaded: 0, failedDownloads: 0, dropped: 0 };

	constructor(private readonly options: ImageStoreOptions) {
		this.dir = join(options.dataDir, "images");
		this.file = join(this.dir, "index.json");
		this.clock = options.clock ?? Date.now;
		this.load();
	}

	private load(): void {
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { format?: number; known?: Record<string, Known> };
			if (parsed?.format !== INDEX_VERSION || !parsed.known || typeof parsed.known !== "object") return;
			for (const [id, k] of Object.entries(parsed.known)) {
				if (!ASSET_ID.test(id) || !k || !["stored", "blocked", "error", "unknown"].includes(k.state)) continue;
				if (k.state === "stored" && !(k.type && k.type in CONTENT_TYPES)) continue;
				this.known.set(id, { state: k.state, at: Number(k.at) || 0, ...(k.type ? { type: k.type } : {}), ...(k.bytes ? { bytes: k.bytes } : {}) });
				if (this.known.size >= KNOWN_MAX) break;
			}
		} catch (error) {
			this.options.log?.(`images: ${this.file} is unreadable (${(error as Error).message}); starting empty`);
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer || this.stopped) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.save();
		}, SAVE_DELAY_MS);
		(this.saveTimer as { unref?: () => void }).unref?.();
	}

	/** Writes index.json now (atomic, 0600). */
	save(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			mkdirSync(this.dir, { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ format: INDEX_VERSION, known: Object.fromEntries(this.known) }), { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, this.file);
		} catch (error) {
			this.options.log?.(`images: couldn't write ${this.file} (${(error as Error).message})`);
		}
	}

	private remember(id: string, k: Known): void {
		this.known.delete(id);
		this.known.set(id, k);
		if (this.known.size > KNOWN_MAX) {
			// Forget the oldest failures first (they are asked again when needed); stored files stay on disk either way.
			for (const [old, v] of this.known) {
				if (this.known.size <= KNOWN_MAX) break;
				if (v.state !== "stored") this.known.delete(old);
			}
			for (const [old] of this.known) {
				if (this.known.size <= KNOWN_MAX) break;
				this.known.delete(old);
			}
		}
		this.scheduleSave();
	}

	private fileOf(id: string, type: ImageType): string {
		return join(this.dir, `${id}.${type}`);
	}

	/** Whether a final failure is old enough to ask Roblox again. */
	private stale(k: Known): boolean {
		if (k.state === "stored") return false;
		const age = this.clock() - k.at;
		return k.state === "blocked" ? age >= RETRY_BLOCKED_MS : age >= RETRY_FAILED_MS;
	}

	/**
	 * Queues ids to resolve (fire and forget). Accepts asset ids or Content strings (`rbxassetid://...`); anything else is
	 * ignored. Stored ids and recent failures are skipped; past QUEUE_MAX new ids are dropped (asked again later).
	 */
	note(ids: readonly string[]): number {
		if (this.stopped || !Array.isArray(ids)) return 0;
		let added = 0;
		for (const raw of ids.slice(0, 10_000)) {
			const id = typeof raw === "string" ? assetIdOf(raw) : null;
			if (!id || this.queue.has(id)) continue;
			const k = this.known.get(id);
			if (k && !this.stale(k)) {
				if (k.state !== "stored" || existsSync(this.fileOf(id, k.type as ImageType))) continue;
				this.known.delete(id); // the file went missing: fetch it again
			}
			if (this.queue.size >= QUEUE_MAX) {
				this.counts.dropped++;
				continue;
			}
			this.queue.set(id, { phase: "resolve", due: 0, tries: 0, missing: 0 });
			added++;
		}
		if (added) this.schedule();
		return added;
	}

	/** The image, or its state. An id never seen (or a failure old enough) is queued and answers pending. */
	get(id: string): ImageAnswer {
		if (!ASSET_ID.test(id)) return { state: "unknown" };
		if (this.queue.has(id)) return { state: "pending" };
		const k = this.known.get(id);
		if (k?.state === "stored" && k.type) {
			try {
				return { state: "stored", type: k.type, bytes: new Uint8Array(readFileSync(this.fileOf(id, k.type))) };
			} catch {
				this.known.delete(id);
			}
		} else if (k && !this.stale(k)) {
			return { state: k.state as "blocked" | "error" | "unknown" };
		}
		this.note([id]);
		return { state: "pending" };
	}

	/** Numbers for the explorer (no ids). */
	status(): { stored: number; blocked: number; failed: number; queued: number; downloading: number; backoffMs: number; calls: number; rateLimited: number; dropped: number } {
		let stored = 0;
		let blocked = 0;
		let failed = 0;
		for (const k of this.known.values()) {
			if (k.state === "stored") stored++;
			else if (k.state === "blocked") blocked++;
			else failed++;
		}
		let downloading = 0;
		for (const w of this.queue.values()) if (w.phase === "download") downloading++;
		return { stored, blocked, failed, queued: this.queue.size - downloading, downloading, backoffMs: Math.max(0, this.backoffUntil - this.clock()), calls: this.counts.calls, rateLimited: this.counts.rateLimited, dropped: this.counts.dropped };
	}

	/** When the loop has work next (ms from now), or null with nothing to do. */
	private nextDelay(): number | null {
		const now = this.clock();
		let soonest = Infinity;
		for (const w of this.queue.values()) {
			if (w.busy) continue;
			if (w.phase === "resolve") soonest = Math.min(soonest, Math.max(w.due, this.lastCall + CALL_GAP_MS, this.backoffUntil));
			else if (this.downloads < DOWNLOADS_MAX) soonest = Math.min(soonest, w.due);
		}
		return soonest === Infinity ? null : Math.max(0, soonest - now);
	}

	private schedule(): void {
		if (this.options.auto === false || this.stopped || this.timer) return;
		const delay = this.nextDelay();
		if (delay === null) return;
		// The clock may be a test's frozen one: wait at least a moment, at most a minute, then look again.
		this.timer = setTimeout(
			() => {
				this.timer = null;
				void this.tick().finally(() => this.schedule());
			},
			Math.min(Math.max(delay, 50), 60_000),
		);
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** One step: a thumbnails call for the due ids (if the gap and the backoff allow) and the due downloads. */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = this.step().finally(() => {
			this.ticking = null;
		});
		return this.ticking;
	}

	/** Runs steps until nothing is due now (tests, with a clock they move). */
	async drain(): Promise<void> {
		for (let i = 0; i < 1000; i++) {
			await this.tick();
			await Promise.all(this.inflight);
			if (this.nextDelay() !== 0) return;
		}
	}

	private readonly inflight = new Set<Promise<void>>();

	private async step(): Promise<void> {
		if (this.stopped) return;
		const now = this.clock();
		// Downloads (the CDN, not the API: no pacing beyond DOWNLOADS_MAX at a time).
		for (const [id, w] of this.queue) {
			if (this.downloads >= DOWNLOADS_MAX) break;
			if (w.phase !== "download" || w.busy || w.due > now) continue;
			w.busy = true;
			this.downloads++;
			const p = this.download(id, w).finally(() => {
				w.busy = false;
				this.downloads--;
				this.inflight.delete(p);
				this.schedule();
			});
			this.inflight.add(p);
		}
		if (now < this.backoffUntil || now < this.lastCall + CALL_GAP_MS) return;
		const batch: string[] = [];
		for (const [id, w] of this.queue) {
			if (w.phase === "resolve" && w.due <= now) batch.push(id);
			if (batch.length >= BATCH_MAX) break;
		}
		if (!batch.length) return;
		this.lastCall = now;
		await this.resolve(batch);
	}

	private slowDown(retryAfterSeconds: number | null): void {
		const wait = Math.min(BACKOFF_CAP_MS, Math.max(BACKOFF_BASE_MS * 2 ** this.backoff, (retryAfterSeconds ?? 0) * 1000));
		this.backoff = Math.min(this.backoff + 1, 16);
		this.backoffUntil = this.clock() + wait;
	}

	private async resolve(ids: string[]): Promise<void> {
		const url = `${THUMBNAILS_URL}?assetIds=${ids.join(",")}&size=${THUMB_SIZE}&format=Png&isCircular=false`;
		this.counts.calls++;
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
		} catch (error) {
			this.options.log?.(`images: thumbnails call failed (${String((error as Error)?.message ?? error).slice(0, 120)}); backing off`);
			this.slowDown(null);
			return;
		}
		if (response.status === 429 || response.status >= 500) {
			if (response.status === 429) this.counts.rateLimited++;
			const after = Number(response.headers.get("retry-after"));
			this.slowDown(Number.isFinite(after) && after > 0 ? Math.min(after, 600) : null);
			await response.body?.cancel().catch(() => {});
			return;
		}
		let body: unknown = null;
		try {
			body = response.ok ? await response.json() : null;
		} catch {
			body = null;
		}
		if (!response.ok || !body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
			// A 4xx for the whole batch (a bad id in it?): the ids count as missing this round.
			this.options.log?.(`images: thumbnails answered ${response.status} for ${ids.length} ids`);
			for (const id of ids) this.missed(id);
			this.slowDown(null);
			return;
		}
		this.backoff = 0;
		const seen = new Set<string>();
		for (const item of (body as { data: unknown[] }).data.slice(0, BATCH_MAX * 2)) {
			if (!item || typeof item !== "object") continue;
			const r = item as { targetId?: unknown; state?: unknown; imageUrl?: unknown };
			const id = String(r.targetId ?? "");
			const w = this.queue.get(id);
			if (!w || w.phase !== "resolve" || seen.has(id)) continue;
			seen.add(id);
			const state = String(r.state ?? "");
			if (state === "Completed" && typeof r.imageUrl === "string" && cdnUrl(r.imageUrl)) {
				w.phase = "download";
				w.url = r.imageUrl;
				w.tries = 0;
				w.due = 0;
			} else if (state === "Blocked") {
				this.finish(id, { state: "blocked", at: this.clock() });
			} else if (state === "Error" || (state === "Completed" && !(typeof r.imageUrl === "string" && cdnUrl(r.imageUrl)))) {
				this.finish(id, { state: "error", at: this.clock() });
			} else {
				// Pending, InReview, TemporarilyUnavailable, anything new: ask again later.
				w.tries++;
				if (w.tries >= PENDING_TRIES) this.finish(id, { state: "error", at: this.clock() });
				else w.due = this.clock() + Math.min(PENDING_CAP_MS, PENDING_BASE_MS * 2 ** (w.tries - 1)) * (state === "InReview" ? 4 : 1);
			}
		}
		for (const id of ids) if (!seen.has(id)) this.missed(id);
	}

	private missed(id: string): void {
		const w = this.queue.get(id);
		if (!w) return;
		w.missing++;
		if (w.missing >= MISSING_TRIES) this.finish(id, { state: "unknown", at: this.clock() });
		else w.due = this.clock() + PENDING_BASE_MS * 2 ** w.missing;
	}

	private finish(id: string, k: Known): void {
		this.queue.delete(id);
		this.remember(id, k);
	}

	private async download(id: string, w: Waiting): Promise<void> {
		const url = w.url as string;
		try {
			const response = await (this.options.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) });
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`HTTP ${response.status}`);
			}
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
				await response.body?.cancel().catch(() => {});
				this.counts.failedDownloads++;
				this.finish(id, { state: "error", at: this.clock() });
				return;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			const type = sniff(bytes);
			if (bytes.byteLength > IMAGE_MAX_BYTES || !type) {
				this.counts.failedDownloads++;
				this.finish(id, { state: "error", at: this.clock() });
				return;
			}
			mkdirSync(this.dir, { recursive: true });
			const file = this.fileOf(id, type);
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, bytes, { mode: 0o600 });
			renameSync(tmp, file);
			this.counts.downloaded++;
			this.finish(id, { state: "stored", at: this.clock(), type, bytes: bytes.byteLength });
		} catch (error) {
			w.tries++;
			if (w.tries >= DOWNLOAD_TRIES) {
				this.counts.failedDownloads++;
				this.options.log?.(`images: downloading asset ${id} failed (${String((error as Error)?.message ?? error).replace(/https?:\/\/\S+/g, "<url>").slice(0, 120)})`);
				// Back to resolving: the CDN URL may have expired; a fresh thumbnails answer gives a new one.
				if (w.missing < MISSING_TRIES) {
					w.phase = "resolve";
					w.tries = 0;
					w.missing++;
					w.due = this.clock() + PENDING_BASE_MS;
					delete w.url;
				} else this.finish(id, { state: "error", at: this.clock() });
			} else w.due = this.clock() + 1000 * w.tries;
		}
	}

	/** Stops the loop and writes the index (shutdown). */
	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.save();
		this.stopped = true;
	}

	/** Bytes of stored images on disk (the status line). */
	diskBytes(): number {
		let total = 0;
		for (const [id, k] of this.known) {
			if (k.state !== "stored" || !k.type) continue;
			try {
				total += statSync(this.fileOf(id, k.type)).size;
			} catch {
				// gone
			}
		}
		return total;
	}
}

/** An image URL the loop may download: https on a Roblox CDN host. */
export function cdnUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		const host = url.hostname.toLowerCase();
		return url.protocol === "https:" && (host === "rbxcdn.com" || host.endsWith(".rbxcdn.com")) && !url.username && !url.password && (url.port === "" || url.port === "443");
	} catch {
		return false;
	}
}

/** The image type by its first bytes (PNG, WebP, JPEG), or null. */
export function sniff(bytes: Uint8Array): ImageType | null {
	if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
	if (bytes.byteLength >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	return null;
}

// The module's store (one per backend: one backend serves one game) ------------------------------------------------------

let current: ImageStore | null = null;
/** Ids noted before the server installed its store (startup order), bounded. */
const early = new Set<string>();

/** The server's store (app start), or null (stop / tests). Ids noted before it are handed over. */
export function installImageStore(store: ImageStore | null): void {
	current = store;
	if (store && early.size) {
		store.note([...early]);
		early.clear();
	}
}

export function imageStore(): ImageStore | null {
	return current;
}

/**
 * Remembers image ids to resolve and store (fire and forget, idempotent): asset ids or Content strings
 * (`rbxassetid://123`, `https://www.roblox.com/asset/?id=123`); anything else is ignored. Called by the map export (its
 * Decals, Textures, MaterialVariants) and the replay decoders (UI images, clothing).
 */
export function noteImageIds(ids: readonly string[]): void {
	if (!Array.isArray(ids) || ids.length === 0) return;
	if (current) {
		current.note(ids);
		return;
	}
	for (const raw of ids.slice(0, 1000)) {
		const id = typeof raw === "string" ? assetIdOf(raw) : null;
		if (id && early.size < QUEUE_MAX) early.add(id);
	}
}
