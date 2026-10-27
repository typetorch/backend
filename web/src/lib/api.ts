/**
 * The backend's API under `/api` (the backend takes the prefix off itself; the dev proxy forwards it and adds the admin
 * token). In the browser the session cookie does the authentication: requests that change something carry the
 * X-TypeTorch header the backend wants with a cookie. Every call answers parsed JSON or throws an ApiError carrying the
 * server's own message.
 */
import type {
	AuthInfo,
	BackendStats,
	BackfillResult,
	BlessedDevice,
	DebugAuditEntry,
	ErrorDetail,
	ErrorList,
	ErrorPlayers,
	PlayerErrors,
	ExperimentOverrides,
	ExperimentPlayers,
	Filters,
	FleetAlert,
	FleetReports,
	FleetServerDetail,
	FleetServers,
	Health,
	Identity,
	PlaceCardInfo,
	RobloxProductInfo,
	PlayerProfile,
	QueryInfo,
	QueryName,
	QueryResults,
	RemoteCommand,
	RemoteOp,
	SettingsView,
	SqlResult,
	StatsWindow,
	StorageReport,
	TestAlertResult,
	WatchReply,
} from "./types";
import type { DeployMark, PerfServer, ServerMetricPoint } from "./perf";

/** The header the backend wants on cookie-authenticated requests that change something. */
export const CSRF_HEADER = "x-typetorch";

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly status: number,
		message: string,
		readonly path: string,
		/** The parsed JSON body of the answer, when it had one (a 401 from the auth check says which logins are on). */
		readonly body?: unknown,
	) {
		super(message);
	}

	/** Not signed in (or the session ended). */
	get unauthorized(): boolean {
		return this.status === 401;
	}

	/** The endpoint doesn't exist on this server (an older server version, or the part is off). */
	get notFound(): boolean {
		return this.status === 404;
	}
}

export interface ApiOptions {
	/** Base path or URL (default "/api"). */
	base?: string;
	fetch?: typeof fetch;
}

/** The filters and options of GET /v1/experiments/<key>/players as URL parameters (lists repeat; the variant filter as inExperiment + inVariant). */
export function experimentPlayerQuery(filters: Filters, options: { variant?: string; limit?: number } = {}): string {
	const params = new URLSearchParams();
	const f = cleanFilters(filters);
	for (const [key, value] of Object.entries(f)) {
		if (key === "variant") {
			const v = value as NonNullable<Filters["variant"]>;
			params.set("inExperiment", v.experiment);
			for (const one of Array.isArray(v.variant) ? v.variant : [v.variant]) params.append("inVariant", one);
		} else if (Array.isArray(value)) for (const one of value) params.append(key, String(one));
		else params.set(key, String(value));
	}
	if (options.variant) params.set("variant", options.variant);
	if (options.limit !== undefined) params.set("limit", String(options.limit));
	const text = params.toString();
	return text ? `?${text}` : "";
}

/** Drops empty values so the server sees only the filters that are set (and cache keys stay stable). */
export function cleanFilters(filters: Filters): Filters {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(filters)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (key === "variant") {
			const v = value as Filters["variant"];
			if (!v?.experiment || !v.variant || (Array.isArray(v.variant) && !v.variant.length)) continue;
		}
		out[key] = value;
	}
	return out as Filters;
}

export function createApi(options: ApiOptions = {}) {
	const base = (options.base ?? "/api").replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

	async function request<T>(path: string, init?: RequestInit): Promise<T> {
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {
				...init,
				credentials: "same-origin",
				headers: {
					accept: "application/json",
					...(init?.body ? { "content-type": "application/json" } : {}),
					...(init?.method && init.method !== "GET" ? { [CSRF_HEADER]: "1" } : {}),
					...init?.headers,
				},
			});
		} catch (error) {
			throw new ApiError(0, `cannot reach the backend: ${(error as Error).message}`, path);
		}
		const text = await response.text();
		let body: unknown = undefined;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			// a proxy error page, not JSON
		}
		if (!response.ok) {
			const b = body as { error?: string; detail?: string } | undefined;
			const message = b?.error
				? b.detail
					? `${b.error}: ${b.detail}`
					: b.error
				: response.status === 502 || response.status === 504
					? "the backend is not answering"
					: `HTTP ${response.status}`;
			throw new ApiError(response.status, message, path, body);
		}
		if (body === undefined) throw new ApiError(response.status, "the answer is not JSON", path);
		return body as T;
	}

	const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
		request<T>(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
	const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : undefined);
	const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
		const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
		return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, v === true ? "1" : String(v)])).toString()}` : "";
	};

	return {
		/** A named query: POST /v1/query/<name> { filters, options } -> result. */
		async query<N extends QueryName>(name: N, filters: Filters = {}, queryOptions: object = {}, signal?: AbortSignal): Promise<QueryResults[N]> {
			const answer = await post<{ result: QueryResults[N]; ms: number }>(
				`/v1/query/${encodeURIComponent(name)}`,
				{ filters: cleanFilters(filters), options: queryOptions },
				signal,
			);
			return answer.result;
		},
		/** The raw answer of any named query (the Query page). */
		raw(name: string, body: unknown, signal?: AbortSignal): Promise<{ result: unknown; ms: number }> {
			return post(`/v1/query/${encodeURIComponent(name)}`, body, signal);
		},
		queries: (signal?: AbortSignal) => get<{ queries: QueryInfo[] }>("/v1/queries", signal).then((r) => r.queries),
		sql: (sql: string, limit?: number, signal?: AbortSignal) => post<SqlResult>("/v1/sql", { sql, ...(limit ? { limit } : {}) }, signal),
		health: (signal?: AbortSignal) => get<Health>("/healthz", signal),
		/** Who is signed in; a 401 (ApiError.body.login) says which logins this backend offers. */
		authCheck: (signal?: AbortSignal) => get<AuthInfo>("/v1/auth/check", signal),
		login: (token: string, signal?: AbortSignal) => post<AuthInfo>("/v1/auth/login", { token }, signal),
		logout: (signal?: AbortSignal) => post<{ ok: boolean }>("/v1/auth/logout", {}, signal),
		/** Error kinds seen in a window (see backend README "Error logs"). */
		errors: (params: ErrorParams = {}, signal?: AbortSignal) => get<ErrorList>(`/v1/errors${qs({ ...params })}`, signal),
		errorKind: (fp: string, params: ErrorParams = {}, signal?: AbortSignal) => get<ErrorDetail>(`/v1/errors/${encodeURIComponent(fp)}${qs({ ...params })}`, signal),
		/** The players who hit one kind (at most 200), under the same window and filters. */
		errorPlayers: (fp: string, params: ErrorParams = {}, signal?: AbortSignal) => get<ErrorPlayers>(`/v1/errors/${encodeURIComponent(fp)}/players${qs({ ...params })}`, signal),
		/** The error kinds one player hit (most occurrences first, at most 200). */
		playerErrors: (pid: string, params: ErrorParams = {}, signal?: AbortSignal) => get<PlayerErrors>(`/v1/players/${encodeURIComponent(pid)}/errors${qs({ ...params })}`, signal),
		/** The experiment overrides the server knows (weights, active, forced variant; read-only). */
		experimentOverrides: (signal?: AbortSignal) => get<ExperimentOverrides>("/v1/experiments", signal),
		/** The players in one experiment (at most 200; one variant or all), under the filter bar's range and filters. */
		experimentPlayers: (experiment: string, filters: Filters = {}, options: { variant?: string; limit?: number } = {}, signal?: AbortSignal) =>
			get<ExperimentPlayers>(`/v1/experiments/${encodeURIComponent(experiment)}/players${experimentPlayerQuery(filters, options)}`, signal),
		/** The live SSE stream's URL (EventSource sends the session cookie; the dev proxy adds the token). */
		liveUrl: (topics: string[] = []) => `${base}/v1/live${qs({ topics: topics.join(",") })}`,
		/** What the server keeps on disk (measured at most every 30 s). */
		storage: (signal?: AbortSignal) => get<StorageReport>("/v1/storage", signal),
		/** pid <-> UserId: the identities of a pid or a UserId (most recently seen first). */
		identity: (who: { pid: string } | { uid: number | string }, signal?: AbortSignal) =>
			get<{ identities: Identity[] }>(`/v1/identity${qs("pid" in who ? { pid: who.pid } : { uid: String(who.uid) })}`, signal).then((r) => r.identities),
		/** How many pids are mapped, and whether the server can backfill older ones from the DataStore. */
		identitySummary: (signal?: AbortSignal) => get<{ count: number; backfill: boolean }>("/v1/identity", signal),
		backfillIdentities: (pageToken?: string, signal?: AbortSignal) => post<BackfillResult>("/v1/identity/backfill", pageToken ? { pageToken } : {}, signal),
		/** A pid's UserId and its Roblox name, display name and headshot (the backend asks Roblox and caches the answer). */
		playerProfile: (pid: string, signal?: AbortSignal) => get<PlayerProfile>(`/v1/identity/${encodeURIComponent(pid)}/profile`, signal),
		/** The game's name, live players and icon for the sidebar card. */
		place: (signal?: AbortSignal) => get<PlaceCardInfo>("/v1/place", signal),
		/** Game pass and developer product names, prices and icons (at most 50 ids in all; the backend asks Roblox). */
		robloxProducts: (ids: { gamepass?: number[]; product?: number[] }, signal?: AbortSignal) =>
			get<{ items: RobloxProductInfo[] }>(`/v1/roblox/products${qs({ gamepass: ids.gamepass?.join(","), product: ids.product?.join(",") })}`, signal).then((r) => r.items),
		fleetServers: (branch?: string, signal?: AbortSignal) => get<FleetServers>(`/v1/fleet/servers${qs({ branch })}`, signal),
		fleetAlerts: (params: { since?: number; level?: string; unacked?: boolean; limit?: number } = {}, signal?: AbortSignal) =>
			get<{ alerts: FleetAlert[] }>(`/v1/fleet/alerts${qs(params)}`, signal).then((r) => r.alerts),
		fleetReport: (params: { seq?: number; artifact?: string; branch?: string } = {}, signal?: AbortSignal) =>
			get<FleetReports>(
				`/v1/fleet/reports${params.seq || params.artifact ? qs(params) : `?latest${params.branch ? `&branch=${encodeURIComponent(params.branch)}` : ""}`}`,
				signal,
			),
		/** Runtime settings: values, sources, bounds and the audit list (the webhook only as set / not set). */
		settings: (signal?: AbortSignal) => get<SettingsView>("/v1/admin/settings", signal),
		/** Saves a partial change: { key: value }, or { key: null } to go back to the environment. Answers the new view. */
		saveSettings: (changes: Record<string, unknown>, signal?: AbortSignal) =>
			request<SettingsView>("/v1/admin/settings", { method: "PATCH", body: JSON.stringify(changes), ...(signal ? { signal } : {}) }),
		/** One test alert through the saved webhook (the backend allows 3 a minute). */
		testAlert: (signal?: AbortSignal) => post<TestAlertResult>("/v1/admin/settings/test-alert", {}, signal),
		/** The server's own metrics (the Backend stats page): rates, latency, memory, per route group over `window`. */
		backendStats: (window: StatsWindow, signal?: AbortSignal) => get<BackendStats>(`/v1/admin/stats${qs({ window })}`, signal),
		/** Sign in with typetorch.dev: the browsers trusted for full admin (owners only). */
		devices: (signal?: AbortSignal) => get<{ devices: BlessedDevice[] }>("/v1/admin/devices", signal).then((r) => r.devices),
		revokeDevice: (id: string, signal?: AbortSignal) =>
			request<{ ok: boolean; devices: BlessedDevice[] }>(`/v1/admin/devices/${encodeURIComponent(id)}`, { method: "DELETE", ...(signal ? { signal } : {}) }).then((r) => r.devices),
		/**
		 * Trusts this browser for full admin through typetorch.dev: the admin token once (sets the device cookie). `upgraded`: this
		 * browser's read-only owner session became admin in place (re-check auth).
		 */
		blessDevice: (token: string, signal?: AbortSignal) => post<{ ok: boolean; blessed: boolean; upgraded?: boolean }>("/auth/device", { token }, signal),
		/** Chart marks: releases, kernel publishes and backup refreshes in a window, oldest first (GET /v1/fleet/marks). */
		fleetMarks: (params: { since?: number; until?: number; branch?: string; kinds?: string; limit?: number } = {}, signal?: AbortSignal) =>
			get<{ marks: DeployMark[] }>(`/v1/fleet/marks${qs(params)}`, signal).then((r) => r.marks),
		/** Live servers with the heartbeat-metrics fields when the backend has them (tps, memMb...). */
		perfServers: (branch?: string, signal?: AbortSignal) => get<{ servers: PerfServer[]; players: number }>(`/v1/fleet/servers${qs({ branch })}`, signal),
		/** One server's TPS / memory history (the heartbeat-metrics contract; 404 on backends before it). */
		serverMetrics: (job: string, since?: number, signal?: AbortSignal) =>
			get<{ points: ServerMetricPoint[] }>(`/v1/fleet/servers/${encodeURIComponent(job)}/metrics${qs({ since })}`, signal).then((r) => r.points),
		/** Plans/25: one server by JobId (any age), its state and its remote debug session. */
		fleetServer: (job: string, signal?: AbortSignal) => get<FleetServerDetail>(`/v1/fleet/servers/${encodeURIComponent(job)}`, signal),
		/** The server page is open: the server polls for commands from its next heartbeat on, or at once when the backend can wake it (lapses after 60 s). */
		watchServer: (job: string, signal?: AbortSignal) => post<WatchReply>(`/v1/fleet/servers/${encodeURIComponent(job)}/watch`, {}, signal),
		/** Queues one read-only op; the answer comes back through remoteResult. */
		remoteCommand: (job: string, op: RemoteOp, args?: Record<string, unknown>, signal?: AbortSignal) =>
			post<RemoteCommand>(`/v1/fleet/servers/${encodeURIComponent(job)}/commands`, { op, ...(args ? { args } : {}) }, signal),
		/** A queued command's state and, once answered, its result (only for whoever queued it; answers are kept 3 minutes). */
		remoteResult: (job: string, id: string, signal?: AbortSignal) => get<RemoteCommand>(`/v1/fleet/servers/${encodeURIComponent(job)}/commands/${encodeURIComponent(id)}`, signal),
		/** The remote debug audit: the last queued commands, newest first (who, op, job, an args summary; never an answer). */
		debugAudit: (limit = 100, signal?: AbortSignal) => get<{ entries: DebugAuditEntry[] }>(`/v1/fleet/debug/audit${qs({ limit })}`, signal).then((r) => r.entries),
		/** The SSE stream's URL (EventSource can't set headers; the proxy adds the token). */
		streamUrl: (params: { branch?: string; types?: string } = {}) => `${base}/v1/fleet/stream${qs(params)}`,
	};
}

/** Window and filters of the error log reads. `window` is a number and m, h or d (30m, 24h, 7d). */
export interface ErrorParams {
	window?: string;
	from?: number;
	to?: number;
	branch?: string;
	build?: string;
	realm?: string;
	q?: string;
	limit?: number;
	bucket?: number;
}

export type Api = ReturnType<typeof createApi>;

export const api = createApi();
