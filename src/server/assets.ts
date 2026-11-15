/**
 * Image and animation routes for the replays and the textured maps (plans/36 phase 5, "The clips").
 *
 *   GET  /v1/images                 (every signed-in role)  the image store's numbers (stored, blocked, failed, queued)
 *   GET  /v1/images/<assetId>       (every signed-in role)  200 image/png (or webp / jpeg) with a long immutable cache
 *                                   when stored; 202 `{ state: "pending" }` while it resolves (an id never asked
 *                                   before is queued); 404 `{ state: "blocked" | "error" | "unknown" }`
 *   GET  /v1/anims                  (every signed-in role)  the clip store's numbers, the last pass, the default ids
 *   GET  /v1/anims/<animationId>    (every signed-in role)  200 the clip JSON (anims/format.ts Clip); 404 `{ state:
 *                                   "pending" | "failed" }` until exported (an id never seen is noted for the next pass).
 *                                   The id: digits, or a url-encoded `rbxassetid://123`
 *   POST /v1/anims/export           (owners, audited)       runs just the animation pass (a read-only Luau Execution
 *                                   task); 202 with its state, 200 `{ pass: null }` when nothing waits, 409 / 429
 *
 * Images come from Roblox's public thumbnails API (no key); the animation pass needs the map export's key and scope
 * (OPENCLOUD_API_KEY with universe.place.luau-execution-session read and write, TYPETORCH_UNIVERSE_ID).
 */
import { type AnimStore, AnimsError } from "../anims/store.ts";
import { assetIdOf, ASSET_ID, CONTENT_TYPES, type ImageStore } from "../images/store.ts";
import { json, type RateLimiter } from "./http.ts";

export interface AssetsDeps {
	images: ImageStore;
	anims: AnimStore;
	/** Image and clip reads per address per minute. */
	limiter: RateLimiter;
	openCloud(): { apiKey: string; universeId: number } | null;
	placeId(): Promise<number | null>;
}

export interface AssetsCaller {
	/** The owner's name for the records, or the 403 for everyone else. */
	manage(): string | Response;
	note(note: { action: string; outcome?: "ok" | "failed" | "refused"; details?: Record<string, unknown> }): void;
	auditDone(outcome: "ok" | "failed", details: Record<string, unknown>): void;
}

/** A stored image never changes (an asset id's pixels are fixed): the browser keeps it a year. */
export const IMAGE_CACHE = "private, max-age=31536000, immutable";

export function isAssetsPath(path: string): boolean {
	return path === "/v1/images" || path.startsWith("/v1/images/") || path === "/v1/anims" || path.startsWith("/v1/anims/");
}

export async function handleAssets(req: Request, path: string, ip: string, caller: AssetsCaller, deps: AssetsDeps): Promise<Response> {
	const method = req.method;
	if (path === "/v1/anims/export") {
		if (method !== "POST") return json(405, { error: "POST only" });
		const who = caller.manage();
		return typeof who === "string" ? animPass(who, caller, deps) : who;
	}
	if (method !== "GET") return json(405, { error: "GET only" });
	if (path === "/v1/images") return json(200, { ...deps.images.status(), diskBytes: deps.images.diskBytes() });
	if (path === "/v1/anims") return json(200, deps.anims.summary());
	if (!deps.limiter.take(ip)) return json(429, { error: "too many image or animation reads: slow down" }, { "retry-after": String(deps.limiter.retryAfter(ip)) });
	const image = /^\/v1\/images\/([^/]+)$/.exec(path);
	if (image) {
		const id = image[1] as string;
		if (!ASSET_ID.test(id)) return json(400, { error: "an image is asked for by its asset id (digits)" });
		const answer = deps.images.get(id);
		if (answer.state === "stored") {
			return new Response(answer.bytes as Uint8Array<ArrayBuffer>, {
				status: 200,
				headers: { "content-type": CONTENT_TYPES[answer.type], "content-length": String(answer.bytes.byteLength), "cache-control": IMAGE_CACHE, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
			});
		}
		if (answer.state === "pending") return json(202, { state: "pending" }, { "cache-control": "no-store", "retry-after": "5" });
		return json(404, { state: answer.state }, { "cache-control": "no-store" });
	}
	const anim = /^\/v1\/anims\/(.+)$/.exec(path);
	if (anim) {
		let raw: string;
		try {
			raw = decodeURIComponent(anim[1] as string);
		} catch {
			return json(400, { error: "bad animation id" });
		}
		const id = raw.length <= 200 ? assetIdOf(raw) : null;
		if (!id) return json(400, { error: "an animation is asked for by its id (digits, or rbxassetid://<id> url-encoded)" });
		const answer = deps.anims.clip(id);
		if (answer.state === "exported") return json(200, answer.clip, { "cache-control": IMAGE_CACHE });
		if (answer.state === "pending") deps.anims.note([id]);
		return json(404, answer.state === "failed" ? { state: "failed", error: answer.error } : { state: "pending" }, { "cache-control": "no-store" });
	}
	return json(404, { error: "not found" });
}

async function animPass(who: string, caller: AssetsCaller, deps: AssetsDeps): Promise<Response> {
	const oc = deps.openCloud();
	if (!oc) {
		caller.note({ action: "anims.export", outcome: "refused", details: { error: "not configured" } });
		return json(409, { error: "the animation pass needs OPENCLOUD_API_KEY (universe.place.luau-execution-session:read and :write) and TYPETORCH_UNIVERSE_ID" });
	}
	const placeId = await deps.placeId();
	if (!placeId) return json(409, { error: "the place isn't known: TYPETORCH_UNIVERSE_ID's root place couldn't be read and no game server has reported its PlaceId" });
	try {
		const pass = startAnimPass(deps.anims, { ...oc, placeId, by: who }, caller);
		caller.note({ action: "anims.export", details: { placeId, ids: pass ? deps.anims.summary().waiting : 0 } });
		return pass ? json(202, { pass }) : json(200, { pass: null, note: "every animation seen is exported already" });
	} catch (error) {
		if (error instanceof AnimsError) {
			caller.note({ action: "anims.export", outcome: "refused", details: { error: error.message } });
			return json(error.status, { error: error.message }, error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {});
		}
		throw error;
	}
}

/** Starts an animation pass (the route, or after a map export); its end goes to the audit log. Null: nothing waits. */
export function startAnimPass(anims: AnimStore, input: { apiKey: string; universeId: number; placeId: number; by: string }, caller: Pick<AssetsCaller, "auditDone">) {
	return anims.start({ ...input, onDone: (outcome, details) => caller.auditDone(outcome, details) });
}
