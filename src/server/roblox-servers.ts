/**
 * Roblox's logs for one game server (Open Cloud server management, beta: GameServers_ListGameServerLogs), read with
 * OPENCLOUD_API_KEY (scope universe:read) on TYPETORCH_UNIVERSE_ID: the errors and warnings Roblox kept for a JobId
 * (about 3 minutes behind; Roblox folds repeats into a count), filed under the place version the server ran (heartbeat
 * `pv`). Roblox documents only part of the shape, so each entry is read loosely: the fields the explorer shows (time,
 * severity, message, count, stack) are picked from the names Roblox uses, and the other plain fields come along as
 * `fields` (bounded, control characters taken out). The key goes only into `x-api-key`
 * (opencloud.ts); it is never in an answer, an error or a log line.
 *
 * Roblox allows 100 calls a minute per key owner (shared with every other use of the key), so answers are kept for
 * `logsTtlMs` (20 s), one lookup per query at a time, and at most `perMinute` (default 60) leave the server.
 * Over that, an older answer is served when there is one, else RobloxServersError 429.
 */
import { listGameServerLogs, OpenCloudError } from "../opencloud.ts";
import { RateLimiter } from "./http.ts";

export interface GameServerLog {
	/** When it was logged (ISO), or null when Roblox sent no usable time. */
	time: string | null;
	/** Roblox's severity as sent (e.g. an error or a warning). */
	severity: string | null;
	message: string | null;
	/** How many identical messages this entry stands for (Roblox folds repeats), when Roblox says. */
	count: number | null;
	stack: string | null;
	placeVersion: number | null;
	/** The entry's other plain fields, as Roblox sent them. */
	fields: Record<string, string | number | boolean>;
}

export interface LogsQuery {
	jobId: string;
	placeId: number;
	placeVersion: number;
	pageToken?: string;
	/** Severities as Roblox spells them (`severity in [...]`). */
	severity?: string[];
	/** Case-insensitive full-text match (`search == "..."`). */
	search?: string;
	/** Oldest first (default newest first). */
	ascending?: boolean;
	pageSize?: number;
}

export class RobloxServersError extends Error {
	override name = "RobloxServersError";
	constructor(
		message: string,
		/** What the explorer gets: 400 (Roblox refused the query), 409 (not configured), 429, 502 (Roblox failed or refused the key). */
		readonly status: number,
	) {
		super(message);
	}
}

export interface RobloxServersOptions {
	apiKey?: string;
	universeId?: number;
	fetch?: typeof fetch;
	clock?: () => number;
	/** Open Cloud calls a minute at most (default 60, under Roblox's 100). */
	perMinute?: number;
	logsTtlMs?: number;
	/**
	 * Per Open Cloud call (default 8 s), two tries at most: the answer must reach the explorer well inside the server's
	 * 30 s idle timeout, or the proxy in front answers a bare 502 instead of the reason.
	 */
	timeoutMs?: number;
}

const MAX_ENTRIES = 64;
const MAX_FIELDS = 40;
const MAX_TEXT = 8 * 1024;
const MAX_FIELD_TEXT = 500;
/** Severities and the search text are put into a CEL filter: severities are plain words, the search a quoted string. */
export const SEVERITY_PATTERN = /^[A-Za-z_]{1,32}$/;
export const SEARCH_MAX = 200;

interface Entry<T> {
	value: T;
	expires: number;
}

export class RobloxServers {
	private readonly cache = new Map<string, Entry<unknown>>();
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private readonly limiter: RateLimiter;
	private readonly clock: () => number;

	constructor(private readonly o: RobloxServersOptions) {
		this.clock = o.clock ?? Date.now;
		this.limiter = new RateLimiter(o.perMinute ?? 60, this.clock);
	}

	/** Logs need the key and the universe. */
	get configured(): boolean {
		return Boolean(this.o.apiKey && this.o.universeId);
	}

	/** One page of a server's logs, newest first unless `ascending`. */
	async logs(q: LogsQuery): Promise<{ logs: GameServerLog[]; nextPageToken: string | null; cached: boolean }> {
		const filter = logFilter(q);
		const orderBy = q.ascending ? "message_timestamp" : "message_timestamp desc";
		const key = `logs ${JSON.stringify([q.jobId, q.placeId, q.placeVersion, q.pageToken ?? "", filter, orderBy, q.pageSize ?? 50])}`;
		return this.cached(key, this.o.logsTtlMs ?? 20_000, async () => {
			const page = await listGameServerLogs({
				...this.cloud(),
				placeId: q.placeId,
				placeVersion: q.placeVersion,
				jobId: q.jobId,
				maxPageSize: q.pageSize ?? 50,
				orderBy,
				...(filter ? { filter } : {}),
				...(q.pageToken ? { pageToken: q.pageToken } : {}),
			});
			return { logs: page.logs.map(readLog), nextPageToken: page.nextPageToken ?? null };
		});
	}

	private cloud() {
		if (!this.o.apiKey || !this.o.universeId) throw new RobloxServersError("Roblox server management is off: set OPENCLOUD_API_KEY (scope universe:read) and TYPETORCH_UNIVERSE_ID", 409);
		return { apiKey: this.o.apiKey, universeId: this.o.universeId, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), timeoutMs: this.o.timeoutMs ?? 8000, attempts: 2 };
	}

	private async cached<T extends object>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T & { cached: boolean }> {
		const hit = this.cache.get(key) as Entry<T> | undefined;
		if (hit && hit.expires > this.clock()) return { ...hit.value, cached: true };
		const pending = this.inFlight.get(key) as Promise<T & { cached: boolean }> | undefined;
		if (pending) return pending;
		this.cloud();
		if (!this.limiter.take("roblox")) {
			if (hit) return { ...hit.value, cached: true };
			throw new RobloxServersError("too many Roblox server management calls: try again in a minute", 429);
		}
		const lookup = load()
			.then((value) => {
				this.cache.delete(key);
				this.cache.set(key, { value, expires: this.clock() + ttlMs });
				while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
				return { ...value, cached: false };
			})
			.catch((error: unknown) => {
				throw toServersError(error);
			})
			.finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, lookup);
		return lookup;
	}
}

/** The CEL filter for a logs query, or undefined. Callers check severities against SEVERITY_PATTERN first. */
export function logFilter(q: Pick<LogsQuery, "severity" | "search">): string | undefined {
	const parts: string[] = [];
	const severities = (q.severity ?? []).filter((s) => SEVERITY_PATTERN.test(s));
	if (severities.length === 1) parts.push(`severity == ${JSON.stringify(severities[0])}`);
	else if (severities.length > 1) parts.push(`severity in [${severities.map((s) => JSON.stringify(s)).join(", ")}]`);
	const search = q.search?.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, SEARCH_MAX);
	if (search) parts.push(`search == ${JSON.stringify(search)}`);
	return parts.length ? parts.join(" && ") : undefined;
}

function toServersError(error: unknown): RobloxServersError {
	if (error instanceof RobloxServersError) return error;
	if (error instanceof OpenCloudError) {
		// 400: Roblox refused the query (a filter, a page token); anything else is Roblox's side or the key's.
		return new RobloxServersError(error.message, error.status === 400 ? 400 : error.status === 429 ? 429 : 502);
	}
	return new RobloxServersError(`Roblox server management failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`, 502);
}

const clean = (text: string, max: number) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\p{Cf}]/gu, "").slice(0, max);

/** The pickers take the first usable field of `names` and add its name to `used` (left out of `fields`). */
function pickText(r: Record<string, unknown>, used: Set<string>, names: string[], max = MAX_TEXT): string | null {
	for (const name of names) {
		const v = r[name];
		if (typeof v === "string" && v.trim() !== "") {
			used.add(name);
			return clean(v, max);
		}
	}
	return null;
}

function pickNumber(r: Record<string, unknown>, used: Set<string>, names: string[]): number | null {
	for (const name of names) {
		const v = r[name];
		const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
		if (Number.isFinite(n)) {
			used.add(name);
			return n;
		}
	}
	return null;
}

/** A time sent as unix ms (number or numeric string), unix seconds, or an ISO string; null otherwise. */
function pickTime(r: Record<string, unknown>, used: Set<string>, names: string[]): string | null {
	for (const name of names) {
		const v = r[name];
		let ms: number | null = null;
		if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()))) {
			const n = Number(v);
			ms = n < 1e11 ? n * 1000 : n;
		} else if (typeof v === "string") {
			const parsed = Date.parse(v);
			if (Number.isFinite(parsed)) ms = parsed;
		}
		if (ms !== null && Number.isFinite(ms) && ms > 0 && ms < 8.64e15) {
			used.add(name);
			return new Date(ms).toISOString();
		}
	}
	return null;
}

/** The plain fields not already picked, nested objects one level deep as dotted names; bounded. */
function rest(r: Record<string, unknown>, used: Set<string>): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	let n = 0;
	const put = (name: string, v: unknown) => {
		if (n >= MAX_FIELDS) return;
		if (typeof v === "string") out[clean(name, 80)] = clean(v, MAX_FIELD_TEXT);
		else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[clean(name, 80)] = v;
		else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) out[clean(name, 80)] = clean(v.join(", "), MAX_FIELD_TEXT);
		else return;
		n++;
	};
	for (const [name, v] of Object.entries(r)) {
		if (used.has(name)) continue;
		if (typeof v === "object" && v !== null && !Array.isArray(v)) {
			for (const [inner, w] of Object.entries(v as Record<string, unknown>)) put(`${name}.${inner}`, w);
		} else put(name, v);
	}
	return out;
}

const LOG_TIME = ["messageTimestampMs", "messageTimestamp", "timestamp", "time", "createTime"];
const LOG_SEVERITY = ["severity", "logSeverity", "level"];
const LOG_MESSAGE = ["message", "messageText", "text", "content", "logMessage"];
const LOG_COUNT = ["count", "occurrences", "occurrenceCount", "repeatCount", "aggregatedCount"];
const LOG_STACK = ["stackTrace", "stack", "traceback"];
/** Every log carries these; the explorer already knows them from the server it asked about. */
const LOG_KNOWN = ["universeId", "placeId", "jobId", "placeVersion"];

export function readLog(r: Record<string, unknown>): GameServerLog {
	const used = new Set(LOG_KNOWN);
	const placeVersion = pickNumber(r, used, ["placeVersion"]);
	const count = pickNumber(r, used, LOG_COUNT);
	const log = {
		time: pickTime(r, used, LOG_TIME),
		severity: pickText(r, used, LOG_SEVERITY, 32),
		message: pickText(r, used, LOG_MESSAGE),
		count: count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null,
		stack: pickText(r, used, LOG_STACK),
		placeVersion: placeVersion !== null && Number.isSafeInteger(placeVersion) ? placeVersion : null,
	};
	return { ...log, fields: rest(r, used) };
}
