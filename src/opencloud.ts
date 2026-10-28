/**
 * The few Roblox Open Cloud calls this package makes (fetch only; the API key goes only into `x-api-key` and is never
 * logged or put in an error message). The game's analytics and fleet settings are written by the game's TypeTorch CLI
 * (the signed settings record, kernel 0.3.8; settings.ts), not here.
 *   - DataStore entries (v2): read `TypeTorchAnalytics` / `p/<UserId>` to map an erasure request's UserId to a pid.
 *     Scope universe-datastores.objects:read (and :delete to remove the link).
 *   - MessagingService (v2 `:publishMessage`, the CLI's call too): remote debug's instant wake (fleet/remote-debug-wake.ts).
 *     Scope universe-messaging-service:publish.
 *   - Server management (v1, beta): a game server's error / warning logs, read only (server/roblox-servers.ts).
 *     Scope universe:read.
 *   - Analytics Query API (v1): Creator Hub's acquisition numbers (impressions, play-through rate; server/roblox-analytics.ts).
 *     Scope universe.analytics:read.
 */
export const OPEN_CLOUD = "https://apis.roblox.com";

export class OpenCloudError extends Error {
	override name = "OpenCloudError";
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface OpenCloudOptions {
	apiKey: string;
	fetch?: typeof fetch;
	/** Base URL override (tests). */
	base?: string;
	timeoutMs?: number;
	/** Tries for a GET (429, 5xx or no answer; default 3). Writes are never retried. */
	attempts?: number;
}

async function call(options: OpenCloudOptions, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }> {
	if (!options.apiKey) throw new Error("an Open Cloud API key is required");
	const doFetch = options.fetch ?? fetch;
	const headers: Record<string, string> = { "x-api-key": options.apiKey };
	if (body !== undefined) headers["content-type"] = "application/json";
	let lastError: unknown;
	const attempts = method === "GET" ? Math.max(1, options.attempts ?? 3) : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await doFetch(`${options.base ?? OPEN_CLOUD}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
			});
			const text = await response.text();
			let parsed: unknown;
			try {
				parsed = text ? JSON.parse(text) : undefined;
			} catch {
				parsed = undefined;
			}
			// Retry only reads on 429/5xx (writes could apply twice).
			if (method === "GET" && attempt < attempts && (response.status === 429 || response.status >= 500)) {
				await new Promise((done) => setTimeout(done, 500 * attempt));
				continue;
			}
			return { status: response.status, body: parsed, text };
		} catch (error) {
			lastError = error;
			if (attempt >= attempts) break;
			await new Promise((done) => setTimeout(done, 500 * attempt));
		}
	}
	throw new OpenCloudError(`${method} ${path} failed: ${(lastError as Error)?.message ?? lastError}`, 0);
}

function fail(method: string, path: string, status: number, text: string, scope: string): never {
	const hint = status === 401 || status === 403 ? ` (the API key needs ${scope})` : "";
	throw new OpenCloudError(`${method} ${path} -> ${status}${hint}: ${text.replace(/\s+/g, " ").slice(0, 300)}`, status);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// DataStore entries (v2) ------------------------------------------------------------------------------------------------

function entryPath(universeId: number, dataStore: string, entry: string, scope?: string): string {
	const ds = encodeURIComponent(dataStore);
	const scopePart = scope ? `/scopes/${encodeURIComponent(scope)}` : "";
	return `/cloud/v2/universes/${universeId}/data-stores/${ds}${scopePart}/entries/${encodeURIComponent(entry)}`;
}

/** A DataStore entry's value, or undefined when it doesn't exist (404). */
export async function getDataStoreEntry(options: OpenCloudOptions & { universeId: number; dataStore: string; entry: string; scope?: string }): Promise<unknown> {
	const path = entryPath(options.universeId, options.dataStore, options.entry, options.scope);
	const response = await call(options, "GET", path);
	if (response.status === 404) return undefined;
	if (response.status < 200 || response.status >= 300) fail("GET", path, response.status, response.text, "universe-datastores.objects:read");
	return record(response.body).value;
}

/** Deletes a DataStore entry (404 counts as done). */
export async function deleteDataStoreEntry(options: OpenCloudOptions & { universeId: number; dataStore: string; entry: string; scope?: string }): Promise<void> {
	const path = entryPath(options.universeId, options.dataStore, options.entry, options.scope);
	const response = await call(options, "DELETE", path);
	if (response.status === 404) return;
	if (response.status < 200 || response.status >= 300) fail("DELETE", path, response.status, response.text, "universe-datastores.objects:delete");
}

/**
 * One page of a DataStore's entry ids, optionally only those starting with `prefix` (v2 `filter: id.startsWith`).
 * Scope universe-datastores.objects:list.
 */
export async function listDataStoreEntries(
	options: OpenCloudOptions & { universeId: number; dataStore: string; prefix?: string; pageToken?: string; maxPageSize?: number },
): Promise<{ ids: string[]; nextPageToken?: string }> {
	const params = new URLSearchParams({ maxPageSize: String(Math.min(256, Math.max(1, options.maxPageSize ?? 100))) });
	if (options.prefix) params.set("filter", `id.startsWith("${options.prefix.replace(/["\\]/g, "")}")`);
	if (options.pageToken) params.set("pageToken", options.pageToken);
	const path = `/cloud/v2/universes/${options.universeId}/data-stores/${encodeURIComponent(options.dataStore)}/entries?${params.toString()}`;
	const response = await call(options, "GET", path);
	if (response.status < 200 || response.status >= 300) fail("GET", path.split("?")[0], response.status, response.text, "universe-datastores.objects:list");
	const body = record(response.body);
	const entries = Array.isArray(body.dataStoreEntries) ? body.dataStoreEntries : [];
	const ids = entries
		.map((e) => {
			const r = record(e);
			if (typeof r.id === "string") return r.id;
			return typeof r.path === "string" ? decodeURIComponent(r.path.split("/entries/")[1] ?? "") : "";
		})
		.filter((id) => id !== "");
	const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
	return next ? { ids, nextPageToken: next } : { ids };
}

// MessagingService (v2) -------------------------------------------------------------------------------------------------

/** MessagingService's message limit (bytes of the message text). */
export const MESSAGE_MAX_BYTES = 1024;

/**
 * Publishes one message to a MessagingService topic of the universe: `POST /cloud/v2/universes/{id}:publishMessage`
 * `{ topic, message }` (Roblox's Messaging usage guide; the TypeTorch CLI publishes deploys the same way). Scope
 * universe-messaging-service:publish. Not retried (a publish that went through twice would deliver twice). Throws
 * OpenCloudError (no key in it) on a refusal or a network error.
 */
export async function publishMessage(options: OpenCloudOptions & { universeId: number; topic: string; message: string }): Promise<void> {
	if (new TextEncoder().encode(options.message).length > MESSAGE_MAX_BYTES) throw new Error(`MessagingService messages are limited to ${MESSAGE_MAX_BYTES} bytes`);
	const path = `/cloud/v2/universes/${options.universeId}:publishMessage`;
	const response = await call(options, "POST", path, { topic: options.topic, message: options.message });
	if (response.status < 200 || response.status >= 300) fail("POST", path, response.status, response.text, "universe-messaging-service:publish");
}

// Server management (v1, beta) ------------------------------------------------------------------------------------------

/** The scope every server management read needs. */
export const SERVER_MANAGEMENT_READ_SCOPE = "universe:read";

/**
 * One page of a game server's logs (Roblox keeps its errors and warnings, about 3 minutes behind):
 * `GET /server-management/v1/universes/{u}/places/{p}/versions/{v}/game-servers/{jobId}/logs`. `filter` is CEL
 * (`severity`, `message_timestamp`, `search`), `orderBy` is `message_timestamp` or `log_severity` with an optional
 * " desc". Page size 1-100 (Roblox's default 25). The entries come back as Roblox sent them.
 */
export async function listGameServerLogs(
	options: OpenCloudOptions & { universeId: number; placeId: number; placeVersion: number; jobId: string; pageToken?: string; maxPageSize?: number; filter?: string; orderBy?: string },
): Promise<{ logs: Record<string, unknown>[]; nextPageToken?: string }> {
	const params = new URLSearchParams({ maxPageSize: String(Math.min(100, Math.max(1, options.maxPageSize ?? 50))) });
	if (options.pageToken) params.set("pageToken", options.pageToken);
	if (options.filter) params.set("filter", options.filter);
	if (options.orderBy) params.set("orderBy", options.orderBy);
	const base = `/server-management/v1/universes/${options.universeId}/places/${options.placeId}/versions/${options.placeVersion}/game-servers/${encodeURIComponent(options.jobId)}/logs`;
	const response = await call(options, "GET", `${base}?${params.toString()}`);
	if (response.status < 200 || response.status >= 300) fail("GET", base, response.status, response.text, SERVER_MANAGEMENT_READ_SCOPE);
	const body = record(response.body);
	const logs = (Array.isArray(body.gameServerLogs) ? body.gameServerLogs : []).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e));
	const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
	return next ? { logs, nextPageToken: next } : { logs };
}

// Analytics Query API (v1) ---------------------------------------------------------------------------------------------

/** The scope every analytics query needs (API system `universe-analytics`). */
export const ANALYTICS_READ_SCOPE = "universe.analytics:read";

export interface AnalyticsQuery {
	/** A metric id from create.roblox.com/docs/cloud/guides/analytics/metrics (e.g. `DailyActiveUsers`). */
	metric: string;
	granularity: "OneMinute" | "HalfHour" | "OneHour" | "OneDay" | "OneWeek" | "OneMonth" | "None";
	/** RFC 3339; the start inclusive, the end exclusive. Buckets are UTC days. */
	startTime: string;
	endTime: string;
	breakdown?: string[];
	filter?: { dimension: string; values: string[]; operation: string }[];
	limit?: number;
}

export interface AnalyticsSeries {
	breakdowns: { dimension: string; value: string; displayValue?: string }[];
	dataPoints: { time: string; value: number | null; status?: string }[];
}

/**
 * One metric over a date range: `POST /analytics-query-api/v1/universes/{u}/metrics`. Small queries answer at once;
 * larger ones come back 202 `{ done: false, path }` and are polled on `GET /analytics-query-api/{path}` until `done`
 * (`pollMs` apart, at most `maxPolls` times). The series come back as Roblox sent them, lightly checked: a data point
 * whose value isn't a finite number is kept with `value: null`. Roblox allows 30 queries a minute per key owner.
 */
export async function queryAnalyticsMetric(
	options: OpenCloudOptions & { universeId: number; query: AnalyticsQuery; pollMs?: number; maxPolls?: number; sleep?: (ms: number) => Promise<void> },
): Promise<AnalyticsSeries[]> {
	const path = `/analytics-query-api/v1/universes/${options.universeId}/metrics`;
	let response = await call(options, "POST", path, options.query);
	if (response.status < 200 || response.status >= 300) fail("POST", path, response.status, response.text, ANALYTICS_READ_SCOPE);
	let body = record(response.body);
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	for (let polls = 0; body.done !== true; polls++) {
		if (polls >= (options.maxPolls ?? 20)) throw new OpenCloudError(`POST ${path} -> the query didn't finish in time`, 504);
		const operation = typeof body.path === "string" ? body.path.replace(/^\/+/, "") : "";
		if (!/^v1\/universes\/\d+\/operations\/[A-Za-z0-9_/-]+$/.test(operation)) throw new OpenCloudError(`POST ${path} -> no operation path to poll`, 502);
		await sleep(options.pollMs ?? 1000);
		response = await call(options, "GET", `/analytics-query-api/${operation}`);
		if (response.status < 200 || response.status >= 300) fail("GET", `/analytics-query-api/${operation}`, response.status, response.text, ANALYTICS_READ_SCOPE);
		body = record(response.body);
	}
	const error = record(body.error);
	if (typeof error.message === "string" || typeof error.code === "number") {
		throw new OpenCloudError(`POST ${path} -> query failed (${String(error.code ?? "")}): ${String(error.message ?? "").replace(/\s+/g, " ").slice(0, 300)}`, 502);
	}
	const values = record(body.response).values;
	return (Array.isArray(values) ? values : []).map((series) => {
		const s = record(series);
		const breakdowns = (Array.isArray(s.breakdowns) ? s.breakdowns : [])
			.map(record)
			.filter((b) => typeof b.dimension === "string" && typeof b.value === "string")
			.map((b) => ({ dimension: b.dimension as string, value: b.value as string, ...(typeof b.displayValue === "string" ? { displayValue: b.displayValue } : {}) }));
		const dataPoints = (Array.isArray(s.dataPoints) ? s.dataPoints : [])
			.map(record)
			.filter((p) => typeof p.time === "string" && Number.isFinite(Date.parse(p.time)))
			.map((p) => {
				const n = typeof p.value === "number" ? p.value : typeof p.value === "string" && p.value.trim() !== "" ? Number(p.value) : Number.NaN;
				return { time: p.time as string, value: Number.isFinite(n) ? n : null, ...(typeof p.status === "string" ? { status: p.status } : {}) };
			});
		return { breakdowns, dataPoints };
	});
}
