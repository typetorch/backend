/**
 * Error log reads (admin):
 *   GET /v1/errors?window=24h|from=&to=&branch=&build=&realm=&q=&limit=&bucket=   -> kinds with counts, players, sparkline,
 *     and the builds (artifact ids) with errors in the window, most recent first (for the build filter)
 *   GET /v1/errors/<fp>?window=|from=&to=&branch=&build=&realm=&bucket=             -> one kind: sample stack, series, where
 *   GET /v1/errors/<fp>/players?window=|from=&to=&branch=&build=&realm=&limit=       -> the players who hit it (at most 200),
 *     most occurrences first, with their UserId and Roblox name when known, and the occurrences that named no player
 *   GET /v1/players/<pid>/errors?window=|from=&to=&branch=&build=&realm=&limit=      -> the kinds one player hit (at most 200),
 *     most occurrences first, with the kind's message, side, first/last seen and all-time count
 *   GET /v1/servers/<job>/errors?window=|from=&to=&branch=&build=&realm=&limit=     -> the kinds one game server reported
 *     (at most 200), the same shape without `days`
 * `window` is a number and a unit (30m, 6h, 7d); without `from` the window ends now. Times are unix ms or ISO.
 */
import { ERROR_JOB_PATTERN, ErrorInputError, FP_PATTERN } from "./parse.ts";
import { chooseBucket, ERROR_PLAYERS_MAX, PLAYER_ERRORS_MAX, SERVER_ERRORS_MAX, type ErrorFilter, type ErrorStore, type ErrorWindow } from "./store.ts";

/** What the server knows about a pid: its UserId and Roblox names (when linked), or that it was erased (left out). */
export interface PlayerIdentity {
	uid?: number;
	name?: string;
	displayName?: string;
}
export interface ErrorReadOptions {
	now: number;
	keepDays: number;
	/** pid -> identity for the players list; a pid missing from the map is unknown, `null` means erased (left out). */
	identify?: (pids: string[]) => Promise<Map<string, PlayerIdentity | null>>;
}

/** Control characters: a branch or build filter with one is refused (stored labels never need them). */
const CONTROL = /[\u0000-\u001f\u007f]/;

const UNITS: Record<string, number> ={ m: 60_000, h: 3_600_000, d: 86_400_000 };

function timeParam(value: string | null, name: string): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value) < 1e11 ? Number(value) * 1000 : Number(value);
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new ErrorInputError(`${name} must be unix ms or an ISO time`);
	return ms;
}

export function parseWindow(q: URLSearchParams, now: number, keepDays: number): ErrorWindow {
	const keepMs = keepDays * 86_400_000;
	let to = timeParam(q.get("to"), "to") ?? now;
	to = Math.min(to, now + 60_000);
	let from = timeParam(q.get("from"), "from");
	if (from === undefined) {
		const raw = q.get("window") ?? "24h";
		const m = /^(\d{1,4})([mhd])$/.exec(raw);
		if (!m) throw new ErrorInputError("window is a number and m, h or d (e.g. 30m, 24h, 7d)");
		from = to - Number(m[1]) * (UNITS[m[2] as string] as number);
	}
	if (from >= to) throw new ErrorInputError("from must be before to");
	from = Math.max(from, now - keepMs, to - keepMs);
	const bucketText = q.get("bucket");
	let requested: number | undefined;
	if (bucketText) {
		requested = Number(bucketText);
		if (!Number.isFinite(requested) || requested < 60 || requested > 86_400) throw new ErrorInputError("bucket is seconds from 60 to 86400");
	}
	return { from, to, bucketSeconds: chooseBucket(to - from, requested) };
}

export function parseFilter(q: URLSearchParams): ErrorFilter {
	const filter: ErrorFilter = {};
	for (const key of ["branch", "build"] as const) {
		const v = q.get(key);
		if (v) {
			if (v.length > 64) throw new ErrorInputError(`${key} is at most 64 characters`);
			if (CONTROL.test(v)) throw new ErrorInputError(`${key} has control characters`);
			filter[key] = v === "(unknown)" ? "" : v;
		}
	}
	const realm = q.get("realm");
	if (realm) {
		if (realm !== "server" && realm !== "client") throw new ErrorInputError('realm is "server" or "client"');
		filter.realm = realm;
	}
	return filter;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handleErrorReads(store: ErrorStore, url: URL, o: ErrorReadOptions): Promise<Response> {
	const q = url.searchParams;
	try {
		const window = parseWindow(q, o.now, o.keepDays);
		const filter = parseFilter(q);
		const one = /^\/v1\/errors\/([^/]+)(\/players)?$/.exec(url.pathname);
		if (one) {
			let fp: string;
			try {
				fp = decodeURIComponent(one[1] as string);
			} catch {
				return json(400, { error: "bad fingerprint" });
			}
			if (!FP_PATTERN.test(fp)) return json(400, { error: "bad fingerprint" });
			if (one[2]) return await players(store, fp, window, filter, q, o);
			const detail = await store.detail(fp, window, filter);
			return detail ? json(200, detail) : json(404, { error: "no such error kind" });
		}
		if (url.pathname !== "/v1/errors") return json(404, { error: "not found" });
		const limitText = q.get("limit");
		const limit = limitText ? Number(limitText) : 100;
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ErrorInputError("limit is a whole number from 1 to 500");
		const search = q.get("q") ?? undefined;
		if (search && search.length > 100) throw new ErrorInputError("q is at most 100 characters");
		return json(200, await store.list(window, filter, { limit, ...(search ? { search } : {}) }));
	} catch (error) {
		if (error instanceof ErrorInputError) return json(400, { error: error.message });
		throw error;
	}
}

/** GET /v1/errors/<fp>/players: the store's list, with UserIds and names joined in and erased players left out. */
async function players(store: ErrorStore, fp: string, window: ErrorWindow, filter: ErrorFilter, q: URLSearchParams, o: ErrorReadOptions): Promise<Response> {
	const limitText = q.get("limit");
	const limit = limitText ? Number(limitText) : ERROR_PLAYERS_MAX;
	if (!Number.isInteger(limit) || limit < 1 || limit > ERROR_PLAYERS_MAX) throw new ErrorInputError(`limit is a whole number from 1 to ${ERROR_PLAYERS_MAX}`);
	const found = await store.players(fp, window, filter, limit);
	if (!found) return json(404, { error: "no such error kind" });
	const who = o.identify ? await o.identify(found.players.map((p) => p.pid)) : new Map<string, PlayerIdentity | null>();
	const shown = found.players.filter((p) => who.get(p.pid) !== null);
	const erased = found.players.length - shown.length;
	return json(200, {
		...found,
		total: found.total - erased,
		players: shown.map((p) => {
			const id = who.get(p.pid);
			return { ...p, ...(id?.uid !== undefined ? { uid: id.uid } : {}), ...(id?.name ? { name: id.name } : {}), ...(id?.displayName ? { displayName: id.displayName } : {}) };
		}),
	});
}

/**
 * GET /v1/players/<pid>/errors: the error kinds one player hit in the window, under the error filters. The caller checks
 * the pid's shape and that it isn't erased (erasure deletes the rows too, so an erased pid has none either way).
 */
export async function handlePlayerErrors(store: ErrorStore, pid: string, url: URL, o: { now: number; keepDays: number }): Promise<Response> {
	const q = url.searchParams;
	try {
		const window = parseWindow(q, o.now, o.keepDays);
		const filter = parseFilter(q);
		const limitText = q.get("limit");
		const limit = limitText ? Number(limitText) : PLAYER_ERRORS_MAX;
		if (!Number.isInteger(limit) || limit < 1 || limit > PLAYER_ERRORS_MAX) throw new ErrorInputError(`limit is a whole number from 1 to ${PLAYER_ERRORS_MAX}`);
		return json(200, await store.playerErrors(pid, window, filter, limit));
	} catch (error) {
		if (error instanceof ErrorInputError) return json(400, { error: error.message });
		throw error;
	}
}

/** GET /v1/servers/<job>/errors: the error kinds one game server reported in the window, under the error filters. */
export async function handleServerErrors(store: ErrorStore, rawJob: string, url: URL, o: { now: number; keepDays: number }): Promise<Response> {
	let job: string;
	try {
		job = decodeURIComponent(rawJob);
	} catch {
		return json(400, { error: "bad JobId" });
	}
	if (!ERROR_JOB_PATTERN.test(job)) return json(400, { error: "bad JobId" });
	const q = url.searchParams;
	try {
		const window = parseWindow(q, o.now, o.keepDays);
		const filter = parseFilter(q);
		const limitText = q.get("limit");
		const limit = limitText ? Number(limitText) : SERVER_ERRORS_MAX;
		if (!Number.isInteger(limit) || limit < 1 || limit > SERVER_ERRORS_MAX) throw new ErrorInputError(`limit is a whole number from 1 to ${SERVER_ERRORS_MAX}`);
		return json(200, await store.serverErrors(job, window, filter, limit));
	} catch (error) {
		if (error instanceof ErrorInputError) return json(400, { error: error.message });
		throw error;
	}
}
