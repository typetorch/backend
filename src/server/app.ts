/**
 * The TypeTorch backend: analytics (DuckDB), the fleet API (SQLite), error logs, the event bus, the explorer, in one
 * process. Three roles (server/auth.ts): `game` (the API key) writes; `admin` (the admin token, or an owner's explorer
 * session) reads and manages; `web` (a Roblox viewer's explorer session) reads only.
 *
 *   game routes (API key)
 *   POST /v1/ingest                 gzip JSON { events, recordings, identities? } -> 202 after the raw write
 *   POST /v1/errors                 { j, errors: [{ fp, template, stack?, count, firstAt, lastAt, branch, build, realm, pids }] }
 *   POST /v1/identity               { identities: [{ pid, uid, t }] } (Basin games, via the fleet API's url)
 *   POST /v1/fleet/heartbeat | report | alert | closing | deploy | bundle   (fleet/http.ts; bundle: kernel 0.5.3 debug bundles)
 *
 *   admin routes (admin token as Bearer, or the explorer's session cookie); the `web` role gets the game-data reads (GET,
 *   plus the query and SQL POSTs), never a change (every other POST / PUT / PATCH is refused by method) and never the
 *   server's own configuration: the settings file, storage, the runtime settings, the access list, the debug audit
 *   POST /v1/query/<name>           { filters, options } -> { result }        GET /v1/queries
 *        (experiment-players and funnel-players get UserIds and cached Roblox names joined in, erased players left out)
 *   GET  /v1/rollups/<daily|players|player_days|edges>?from=&to=&pid=&limit=   (from / to: dates, or unix ms / ISO instants)
 *   POST /v1/sql                    { sql, limit? }: one read-only SELECT
 *   GET  /v1/storage                bytes and files per part of the data folder
 *   GET  /v1/settings               live dials from data/settings.json
 *   GET  /v1/identity?pid=|uid=     pid <-> UserId; POST /v1/identity/backfill
 *   GET  /v1/identity/resolve?pid=a,b|uid=1,2  pid <-> UserId in bulk (<= 100); admin, or the lookup token (its only route)
 *   GET  /v1/identity/<pid>/profile  the pid's UserId and its Roblox name, display name and avatar (server-side, cached)
 *   GET  /v1/place                  the game's name, live players and icon (TYPETORCH_UNIVERSE_ID, else the fleet's PlaceId; cached 60 s)
 *   GET  /v1/roblox/products        game pass / developer product names, prices and icons (?gamepass=1,2&product=3; <= 50 ids; cached 1 h)
 *   GET  /v1/roblox/servers/<job>/logs?severity=a,b&search=&order=asc&pageToken=&placeId=&placeVersion=
 *                                   the errors and warnings Roblox kept for one game server (Open Cloud server management;
 *                                   OPENCLOUD_API_KEY with universe:read and TYPETORCH_UNIVERSE_ID; the place and version
 *                                   come from the server's heartbeats, the query can name them; cached 20 s)
 *   GET  /v1/errors?window=..       error kinds with counts, players, sparkline;  GET /v1/errors/<fp>: one kind;
 *        GET /v1/errors/<fp>/players: the players who hit it (at most 200)
 *   GET  /v1/players/<pid>/errors?window=..  the error kinds one player hit (at most 200), most occurrences first
 *   GET  /v1/experiments/<key>/players?variant=&from=&to=|window=&limit=..  the players in one experiment (at most 200):
 *        variant, random or forced, assigned / first / last seen, UserId and Roblox name (experiment-players.ts)
 *   GET  /v1/experiments            the experiment overrides this server knows (data/settings.json: active, weights,
 *        variant per experiment; nothing else from the file), or none
 *   GET  /v1/live?topics=..         Server-Sent Events of the event bus (server/live.ts)
 *   GET  /v1/fleet/servers | servers/<job>/metrics | reports | alerts | stream;  POST /v1/fleet/alerts/<id>/ack
 *   GET  /v1/fleet/servers/<job>/bundles | bundles/<id>   debug bundles (the web role reads them without playerLogs)
 *   GET  /v1/fleet/servers/<job>;  POST .../watch | .../commands;  GET .../commands/<id>;  GET /v1/fleet/debug/audit
 *        remote debug (plans/25, fleet/remote-debug-http.ts; the game side: GET /v1/fleet/commands, POST /v1/fleet/results
 *        with the API key)
 *   GET  /v1/access, PUT /v1/access { seq, owners } (admin token only): the owners who may sign in with Roblox
 *   POST /v1/erasure                Roblox Right to Erasure webhook (signed), or { pid | pids } with the admin token
 *   GET  /v1/admin/settings         runtime settings (server/runtime-settings.ts): values, sources, bounds, audit; secrets as set/not set
 *   PATCH /v1/admin/settings        { key: value | null } (null = back to the environment), applied at once; lockout guards
 *   POST /v1/admin/settings/test-alert   one test alert through the current webhook (3 a minute)
 *   GET  /v1/admin/stats?window=1m|5m|15m|1h   server metrics (server/metrics.ts): requests, queries, inserts per second,
 *                                   latency percentiles, memory, CPU, per route group (the explorer's Backend stats page)
 *
 *   open
 *   GET  /healthz                   { ok }; with the admin token: loader lag, memory, counts, bus
 *   GET  /openapi.json | /docs | /llms.txt   the OpenAPI spec, Swagger UI over it, llms.txt (openapi.ts; the allow list's addresses)
 *   GET  /v1/auth/check             which role the credentials have and which parts run (no side effects); 401 says which logins are on;
 *                                   both carry `dashboard` (the typetorch.dev broker's origin) while that login is on
 *   POST /v1/auth/login | logout    explorer session by pasting the admin token
 *   GET  /v1/auth/roblox/start | callback   Sign in with Roblox (owners only)
 *   Sign in with typetorch.dev (TYPETORCH_CENTRAL_LOGIN=on, else 404; plans typetorch-dev-login):
 *   GET  /auth/typetorch/start | callback   the broker login (owners: admin on a blessed device, else web or refused)
 *   POST /auth/device { token }     the admin token once blesses this browser (device cookie)
 *   GET  /auth/bless/challenge, GET /auth/bless?challenge=&sig=   the CLI's link signed by the game's signing key
 *   GET  /api/typetorch/challenge/<token>   the origin challenge, only while a report is pending
 *   GET  /v1/admin/devices, DELETE /v1/admin/devices/<id>, GET|PUT /v1/access/keys (PUT: admin token only),
 *   POST /v1/central/report         owners only
 *   GET  /                          the built explorer (web/dist) and its files
 *
 * The explorer calls /api/<route> (its dev proxy's prefix); the backend takes that prefix off, so one build works both ways.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { EventBus } from "../bus.ts";
import { ErrorInputError, parseErrorBatch } from "../errors/parse.ts";
import { handleErrorReads, handlePlayerErrors, type PlayerIdentity } from "../errors/http.ts";
import { ExperimentPlayersInput, parseExperimentPlayers } from "./experiment-players.ts";
import type { ExperimentPlayersResult } from "../queries/experiment.ts";
import type { FunnelPlayersResult } from "../queries/funnel.ts";
import { ErrorQueueFull, ErrorStore } from "../errors/store.ts";
import { DAY_MS } from "../sql/dialect.ts";
import { rollupDays } from "../sql/filters.ts";
import { dataLayout, dayFiles, pathLit } from "../duckdb/layout.ts";
import { DataFolderLocked } from "../duckdb/lock.ts";
import { openSqlite } from "../fleet/db.ts";
import { IdentityStore, parseIdentities, parseUid, PID_PATTERN } from "../fleet/identity.ts";
import { FLEET_LIMITS, handleFleet, NewJobLimiter } from "../fleet/http.ts";
import { createNotifier, type Notifier } from "../fleet/notify.ts";
import { FleetService, type Alert } from "../fleet/service.ts";
import { RemoteDebugHub, type Caller } from "../fleet/remote-debug.ts";
import { handleRemoteDebug, isRemoteDebugPath } from "../fleet/remote-debug-http.ts";
import { RemoteDebugWaker } from "../fleet/remote-debug-wake.ts";
import { describeQueries, isQueryName, renderQuery } from "../queries/index.ts";
import { runtimeName, serve, type Served } from "../runtime.ts";
import { validateSettings } from "../settings.ts";
import { BatchShapeError, validateBatch } from "../validate.ts";
import { PACKAGE } from "../version.ts";
import { AccessError, AccessStore } from "./access.ts";
import { Auth, CSRF_HEADER, SESSION_COOKIE, Sessions, cookieMutationProblem, isHttps, type Principal, type SignedIn } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { logErasure, lookupPid, parseErasureBody, verifyRobloxSignature } from "./erasure.ts";
import { API_CSP, EXPLORER_CSP, FailureLimiter, RateLimiter, bearer, clearCookie, clientIp, json, readCapped, readCookie, setCookie, tokenIn, tooMany, withSecurityHeaders } from "./http.ts";
import { ipAllowed } from "./ipfilter.ts";
import { backfillIdentities } from "./identities.ts";
import { LiveHub } from "./live.ts";
import { meterSqlite, parseStatsWindow, ServerMetrics, STATS_WINDOWS } from "./metrics.ts";
import { DOCS_CSP, SWAGGER_INIT, llmsTxt, openApiSpec, swaggerPage } from "./openapi.ts";
import { OAuthError, RobloxOAuth } from "./roblox-oauth.ts";
import { CentralLogin } from "./central-login.ts";
import { CentralReporter, type ReportResult } from "./central-report.ts";
import { BlessKeys, DEVICE_COOKIE, DEVICE_LIFE_MS, DeviceStore, agentLabel } from "./devices.ts";
import { InstanceKey } from "./instance-key.ts";
import { RobloxPlace } from "./roblox-place.ts";
import { MAX_PRODUCT_IDS, parseIdList, RobloxProducts } from "./roblox-products.ts";
import { RobloxServers, RobloxServersError, SEARCH_MAX, SEVERITY_PATTERN } from "./roblox-servers.ts";
import { RobloxProfiles } from "./roblox-profiles.ts";
import { ENV_ONLY, RuntimeSettings, SETTINGS_BODY_MAX, SettingsError, type SettingsActor } from "./runtime-settings.ts";
import { SqlInputError, SqlSandbox } from "./sql.ts";
import { StaticSite } from "./static.ts";
import { measureStorage, type StorageReport } from "./storage.ts";
import type { BackendBus, BackendTopics } from "./topics.ts";
import { RawLogClosed } from "./raw.ts";
import { Warehouse } from "./warehouse.ts";

export interface AppOptions {
	clock?: () => number;
	log?: (line: string) => void;
	/** Don't start the loader / nightly / sweep timers (tests drive them). */
	manualJobs?: boolean;
	/** The fetch for outgoing calls: Open Cloud, the alert webhook, Roblox sign-in, Roblox profiles. */
	fetch?: typeof fetch;
	backend?: "bun" | "node";
	/** The server can't go on (it gave up waiting for the data folder): main.ts shuts down and exits 1. */
	onFatal?: (error: Error) => void;
	/** How often a server in handover tries to open DuckDB again, ms (default 1000). */
	handoverRetryMs?: number;
	/** The wait between origin report polls while the typetorch.dev challenge runs (tests pass a fast one). */
	reportSleep?: (ms: number) => Promise<void>;
}

/**
 * `ready`: everything runs. `handover`: another process (the previous container of a rolling deploy) still holds the data
 * folder's DuckDB files: the fleet, error logs, auth and the explorer work, analytics routes answer 503 + Retry-After, and
 * DuckDB is tried again every second. `failed`: gave up waiting (analytics stays 503; main.ts exits). `stopping`: stop()
 * ran (every request answers 503 + Retry-After while the running ones finish).
 */
export type ServerState = "ready" | "handover" | "failed" | "stopping";

export interface App {
	readonly port: number;
	readonly state: ServerState;
	/** The analytics warehouse; undefined when the part is off, or in handover until DuckDB is open. */
	readonly warehouse?: Warehouse;
	readonly fleet?: FleetService;
	/** The alert webhook sender (always there; it skips alerts while no webhook URL is set). */
	readonly notifier: Notifier;
	/** The runtime settings (the explorer's Settings page): current values over the environment's. */
	readonly settings: RuntimeSettings;
	readonly bus: BackendBus;
	readonly errors: ErrorStore;
	readonly access: AccessStore;
	readonly live: LiveHub;
	/** Server metrics (GET /v1/admin/stats): requests, queries, inserts, latency, memory. */
	readonly metrics: ServerMetrics;
	/** Plans/25: remote debug (watches, commands, answers in memory). Undefined without the fleet part. */
	readonly remoteDebug?: RemoteDebugHub;
	/** Plans/25 "Instant wake": the wake publisher (off without OPENCLOUD_API_KEY and TYPETORCH_UNIVERSE_ID). */
	readonly waker?: RemoteDebugWaker;
	/** Explorer sessions open right now. */
	sessionCount(): number;
	/** The explorer's session store (tests make sessions directly, e.g. a viewer's without Roblox in the loop). */
	readonly sessions: Sessions;
	/** Sign in with typetorch.dev (TYPETORCH_CENTRAL_LOGIN=on): this backend's fingerprint and the origin report. */
	readonly central?: { readonly fingerprint: string; report(): Promise<ReportResult>; readonly devices: DeviceStore };
	handle(req: Request, ip?: string): Promise<Response>;
	/** One loader tick. */
	load(): Promise<{ files: number; rows: number }>;
	nightly(): Promise<{ days: string[]; pruned: number; compacted: boolean }>;
	stop(): Promise<void>;
}

const LIVE_DIALS = ["flushSeconds", "recordShare", "techEvery", "experiments"] as const;
/** POST /v1/errors: smaller than ingest (a batch is a few hundred items at most). */
const ERRORS_MAX_BODY = 512 * 1024;
const ERRORS_MAX_INFLATE = 2 * 1024 * 1024;
/** The OAuth state cookie. */
/** The answer to the web role on a route that changes something or is for owners. */
const READ_ONLY = "read-only access: this needs the admin token or an owner's session";
/** The answer to the lookup token anywhere but GET /v1/identity/resolve. */
const LOOKUP_ONLY = "the lookup token only reaches GET /v1/identity/resolve";
/** GET /v1/identity/resolve: pids and UserIds per request, and requests per address per minute. */
const RESOLVE_MAX = 100;
const RESOLVE_PER_MINUTE = 60;
/**
 * The only non-GET routes the web role may call: the two read-only query routes (a POST body carries the filters / the
 * SELECT; nothing changes). Every other POST / PUT / PATCH / DELETE is refused to that role before any handler runs.
 */
const WEB_POST_ALLOWED = /^\/v1\/(query\/[A-Za-z-]+|sql)$/;
const READ_METHODS = new Set(["GET", "HEAD"]);
const OAUTH_COOKIE = "tt_oauth";
const OAUTH_PATH = "/v1/auth/roblox";
/** Sign in with typetorch.dev: its routes and its short-lived state cookie (path-scoped like the Roblox one). */
const CENTRAL_PATH = "/auth/typetorch";
const CENTRAL_COOKIE = "tt_central";
const FLEET_GAME_ROUTES = new Set(Object.keys(FLEET_LIMITS));
/** POST /v1/errors per JobId per minute (the kernel sends at most 6). */
const ERROR_JOB_PER_MINUTE = 30;
/** How long an error sender (JobId) stays known after its last accepted batch. */
const ERROR_SENDER_TTL_MS = 3_600_000;
const ERROR_SENDERS_MAX = 50_000;
/** Wrong API keys per address inside the login window before wrong keys get 429. */
const GAME_KEY_MAX_FAILURES = 30;
/** Test alerts from the Settings page per minute (they reach a third-party webhook). */
const TEST_ALERTS_PER_MINUTE = 3;
/** GET /v1/identity/<pid>/profile per address per minute (the Roblox lookups behind it have their own global cap). */
const PROFILE_PER_MINUTE = 120;
/** Uncached Roblox names one error/experiment/funnel -> players read looks up in the background (the profile cache's caps still apply). */
const PLAYER_NAME_WARM = 8;
/** Handover: DuckDB is tried again this often, a warning is logged this often while waiting. */
const HANDOVER_RETRY_MS = 1000;
const HANDOVER_WARN_MS = 60_000;
/** Retry-After (s) on the 503s of a handover or a stop: the next server is up within seconds. */
const RETRY_AFTER_SECONDS = 5;
/** stop(): how long requests already running may take to finish, and a DuckDB job before it is interrupted. */
const STOP_DRAIN_MS = 5000;
const STOP_JOB_GRACE_MS = 3000;

export async function startApp(config: ServerConfig, options: AppOptions = {}): Promise<App> {
	const clock = options.clock ?? Date.now;
	const log = options.log ?? ((line: string) => console.log(`[backend] ${line}`));

	// Runtime settings: the environment's values unless the Settings page saved others. Read live everywhere below.
	const runtime = RuntimeSettings.fromConfig(config, { clock, log });

	// One bus for the whole process. Stores that answer for their data are awaited subscribers; the rest are queued.
	const bus: BackendBus = new EventBus<BackendTopics>({ maxQueue: config.busMaxQueue, maxBytes: config.busMaxBytes, log });
	// Server metrics: every request, DuckDB statement, SQLite statement and accepted row is counted (the Backend stats page).
	const metrics = new ServerMetrics({ clock });

	const openWarehouse = () =>
		Warehouse.open({
			dataDir: config.dataDir,
			memoryLimit: config.memoryLimit,
			threads: config.threads,
			keepDays: () => runtime.get("keepDays"),
			rawKeepDays: () => runtime.get("rawKeepDays"),
			compactMb: config.compactMb,
			queryTimeoutSeconds: config.queryTimeoutSeconds,
			queryConcurrency: config.queryConcurrency,
			fsyncMs: config.fsyncMs,
			clock,
			log,
			hooks: { statement: (ms) => metrics.duckQuery(ms), loaded: (rows) => metrics.rowsLoaded(rows) },
		});
	// DuckDB first. Held by another process (a rolling deploy's previous container): start in handover instead of failing,
	// and take it over once it lets go (see "Rolling deploys" below). Any other error stops the start as before.
	let warehouse: Warehouse | undefined;
	let analytics: "off" | "ready" | "handover" | "failed" = config.parts.has("analytics") ? "ready" : "off";
	let lockedAtStart: DataFolderLocked | undefined;
	if (config.parts.has("analytics")) {
		try {
			warehouse = await openWarehouse();
		} catch (error) {
			if (!(error instanceof DataFolderLocked)) throw error;
			analytics = "handover";
			lockedAtStart = error;
		}
	}
	/** The handover's clock (real time, not `clock`: it paces real retries), its retry timer and the attempt running. */
	const handover: { since: number; lastWarn: number; timer?: ReturnType<typeof setTimeout>; attempt?: Promise<void> } = { since: Date.now(), lastWarn: Date.now() };
	let stopping = false;
	const serverState = (): ServerState => (stopping ? "stopping" : analytics === "handover" || analytics === "failed" ? analytics : "ready");
	// The alert webhook: URL, format and levels are read for every alert, so a saved change applies to the next one.
	const notifier = createNotifier({
		url: () => runtime.get("alertWebhookUrl") || undefined,
		format: () => {
			const format = runtime.get("alertWebhookFormat");
			return format === "auto" ? undefined : format;
		},
		levels: () => new Set(runtime.get("alertWebhookLevels")),
		clock,
		log,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	// One SQLite file for the fleet tables, pid <-> UserId and the error logs.
	const sqlite = meterSqlite(await openSqlite(config.fleetDb), metrics);
	const identities = await IdentityStore.open(sqlite);
	const errors = await ErrorStore.open(sqlite, {
		clock,
		keepDays: () => runtime.get("errorKeepDays"),
		maxKinds: () => runtime.get("errorMaxKinds"),
		rowsPerDay: () => runtime.get("errorRowsPerDay"),
	});
	const fleet = config.parts.has("fleet") ? await FleetService.open({ db: sqlite, clock, log, publishAlert: (alert) => bus.publish("alert", alert), deployKeepDays: () => runtime.get("deployKeepDays") }) : undefined;
	const access = AccessStore.at(config.dataDir, clock);
	// Plans/25: remote debug. Answers stay in this process's memory; only the audit (no answers) goes to disk.
	const remoteDebug = fleet ? new RemoteDebugHub({ clock, log, auditDir: join(config.dataDir, "audit") }) : undefined;
	// Plans/25 "Instant wake": with OPENCLOUD_API_KEY and TYPETORCH_UNIVERSE_ID, a watch that starts on a server
	// that isn't polling publishes a wake (Open Cloud Messaging); without them, the heartbeat reply alone wakes it.
	const waker = remoteDebug
		? new RemoteDebugWaker({
				...(config.messagingKey ? { apiKey: config.messagingKey } : {}),
				...(config.universeId ? { universeId: config.universeId } : {}),
				...(options.fetch ? { fetch: options.fetch } : {}),
				clock,
				log,
			})
		: undefined;

	// Subscribers ------------------------------------------------------------------------------------------------------
	// The DuckDB writer: appends the batch to the raw file before the 202 (a 202 means "on disk"). Subscribed once the
	// warehouse is open: at start, or when a handover ends.
	function attachWarehouse(w: Warehouse): void {
		warehouse = w;
		analytics = "ready";
		bus.subscribe(
			"duckdb-writer",
			["events"],
			async (_topic, m) => {
				if (m.events.length) await w.raw.append("events", m.events.map((r) => `${JSON.stringify({ ...r, rt: m.rt })}\n`).join(""));
				if (m.recordings.length) await w.raw.append("recordings", m.recordings.map((r) => `${JSON.stringify({ ...r, rt: m.rt })}\n`).join(""));
			},
			{ mode: "await" },
		);
	}
	if (warehouse) attachWarehouse(warehouse);
	if (fleet) bus.subscribe("fleet-store", ["heartbeat", "deploy"], (_topic, m) => fleet.apply(m), { mode: "await" });
	bus.subscribe("error-store", ["error"], async (_topic, m) => void (await errors.record(m, { ip: m.ip ?? "" })), { mode: "await" });
	// The webhook is slow and remote: queued, so a stuck Discord never holds a heartbeat up. Always subscribed: the
	// notifier skips alerts while no webhook is set, and one saved on the Settings page applies at once.
	bus.subscribe("alert-notifier", ["alert"], (_topic, alert) => notifier.notify(alert), { mode: "queue", maxQueue: 200 });
	const live = new LiveHub(bus, { maxClients: config.liveMaxClients, clock });
	live.start();

	// Auth -------------------------------------------------------------------------------------------------------------
	const sessions = new Sessions({ adminToken: config.adminToken, idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs, clock });
	const auth = new Auth({
		adminToken: config.adminToken,
		apiKeys: config.apiKeys,
		...(config.lookupToken ? { lookupToken: config.lookupToken } : {}),
		sessions,
		isOwner: (id) => access.isOwner(id),
		isViewer: (id) => runtime.isViewer(id),
	});
	/** Ends the Roblox sessions whose user no longer holds the role they signed in with (an owner removed, a viewer removed). */
	const endStaleRobloxSessions = () => sessions.endWhere((s) => s.user.kind === "roblox" && !auth.robloxStillHolds(s.user.userId, s.role));
	const proxyOpts = { trustProxy: config.trustProxy, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}) };
	const proxyTrust = { hops: config.trustProxy, ...(config.trustedProxies ? { proxies: config.trustedProxies } : {}), ...(config.cloudflareIps ? { cloudflare: config.cloudflareIps } : {}) };
	const authFailures = new FailureLimiter(config.loginMaxFailures, config.loginWindowMs, clock);
	// Wrong API keys per address (game routes). Only wrong keys are refused past it, so a real game server behind the same
	// egress address is never blocked.
	const gameKeyFailures = new FailureLimiter(GAME_KEY_MAX_FAILURES, config.loginWindowMs, clock);
	const checkLimiter = new RateLimiter(120, clock);
	const oauthLimiter = new RateLimiter(20, clock);
	const oauth = config.robloxOAuth && config.publicUrl
		? new RobloxOAuth({ clientId: config.robloxOAuth.clientId, clientSecret: config.robloxOAuth.clientSecret, redirectUri: `${config.publicUrl}/v1/auth/roblox/callback`, clock, ...(options.fetch ? { fetch: options.fetch } : {}) })
		: undefined;
	// Sign in with typetorch.dev (off unless TYPETORCH_CENTRAL_LOGIN=on): the instance key, the login, the origin report,
	// blessed devices and the signing keys a blessing link may use. Off: none of it exists and its routes answer 404.
	const central = (() => {
		const c = config.centralLogin;
		if (!c || !config.publicUrl) return undefined;
		const { key, created } = InstanceKey.loadOrCreate(config.dataDir);
		if (created) log(`typetorch.dev login: made the instance key in ${join(config.dataDir, "instance.key")} (fingerprint ${key.fingerprint})`);
		return {
			config: c,
			key,
			login: new CentralLogin({
				issuer: c.issuer,
				fingerprint: key.fingerprint,
				redirectUri: `${config.publicUrl}${CENTRAL_PATH}/callback`,
				...(c.robloxClientId ? { robloxClientId: c.robloxClientId } : {}),
				...(c.robloxDiscoveryUrl ? { robloxDiscoveryUrl: c.robloxDiscoveryUrl } : {}),
				log,
				...(c.kids ? { pinnedKids: c.kids } : {}),
				...(options.fetch ? { fetch: options.fetch } : {}),
				clock,
			}),
			reporter: new CentralReporter({ issuer: c.issuer, key, origin: config.publicUrl, label: c.label, clock, log, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.reportSleep ? { sleep: options.reportSleep } : {}) }),
			devices: DeviceStore.at(config.dataDir, clock),
			blessKeys: BlessKeys.at(config.dataDir, clock),
		};
	})();
	const adminTokenHash = Sessions.hashToken(config.adminToken);
	/** The origin challenge, served to the broker (any address): per address per minute. */
	const challengeLimiter = new RateLimiter(60, clock);
	const site = config.webDir ? new StaticSite(config.webDir) : undefined;
	// The allow list is a runtime setting: read on every request.
	const adminIpOk = (ip: string) => {
		const rules = runtime.adminAllowRules();
		return !rules || ipAllowed(rules, ip);
	};

	const ipLimiter = new RateLimiter(() => runtime.get("ipPerMinute"), clock);
	const jobLimiter = new RateLimiter(() => runtime.get("jobPerMinute"), clock);
	const errorJobLimiter = new RateLimiter(ERROR_JOB_PER_MINUTE, clock);
	const errorIpLimiter = new RateLimiter(() => runtime.get("errorsIpPerMinute"), clock);
	// Never-seen error senders (JobIds) per minute, like the fleet's gate (its own count, so one can't starve the other).
	const newErrorJobs = new NewJobLimiter(() => runtime.get("fleetNewJobsPerMinute"), clock);
	const errorSenders = new Map<string, number>();
	const fleetLimiters = Object.fromEntries(Object.entries(FLEET_LIMITS).map(([k, n]) => [k, new RateLimiter(n, clock)])) as Record<keyof typeof FLEET_LIMITS, RateLimiter>;
	const newFleetJobs = new NewJobLimiter(() => runtime.get("fleetNewJobsPerMinute"), clock);
	const testAlertLimiter = new RateLimiter(TEST_ALERTS_PER_MINUTE, clock);
	const profileLimiter = new RateLimiter(PROFILE_PER_MINUTE, clock);
	const resolveLimiter = new RateLimiter(RESOLVE_PER_MINUTE, clock);
	// Roblox names and avatars for the player detail: fixed Roblox hosts, cached in memory, capped (server/roblox-profiles.ts).
	const robloxProfiles = new RobloxProfiles({ clock, ...(options.fetch ? { fetch: options.fetch } : {}) });
	// The sidebar's place card: name, live players and icon (server/roblox-place.ts: fixed hosts, no credentials, 60 s cache).
	const robloxPlace = new RobloxPlace({ clock, ...(options.fetch ? { fetch: options.fetch } : {}) });
	const placeLimiter = new RateLimiter(PROFILE_PER_MINUTE, clock);
	// Product tooltips: names, prices and icons of game passes and developer products (server/roblox-products.ts: fixed
	// hosts, no credentials, 1 h cache, a cap on Roblox calls), and a per-IP cap on the requests.
	const robloxProducts = new RobloxProducts({ clock, ...(options.fetch ? { fetch: options.fetch } : {}) });
	const productsLimiter = new RateLimiter(PROFILE_PER_MINUTE, clock);
	// Roblox's logs for one game server (server/roblox-servers.ts: Open Cloud with OPENCLOUD_API_KEY, short caches, a cap
	// under Roblox's 100 calls a minute), and a per-IP cap on the requests.
	const robloxServers = new RobloxServers({
		...(config.openCloudKey ? { apiKey: config.openCloudKey } : {}),
		...(config.universeId ? { universeId: config.universeId } : {}),
		clock,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	const serversLimiter = new RateLimiter(PROFILE_PER_MINUTE, clock);
	// Plans/25 remote debug: the kernel's polls and result posts per JobId, the explorer's commands and watches.
	const debugLimiters = {
		poll: new RateLimiter(90, clock),
		results: new RateLimiter(120, clock),
		userCommands: new RateLimiter(30, clock),
		jobCommands: new RateLimiter(60, clock),
		watches: new RateLimiter(30, clock),
	};
	const keepOpen = new WeakMap<Request, () => void>();

	let settingsCache: { mtime: number; value: Record<string, unknown> } | undefined;
	function liveDials(): Record<string, unknown> {
		const file = join(config.dataDir, "settings.json");
		if (!existsSync(file)) return {};
		const mtime = statSync(file).mtimeMs;
		if (settingsCache?.mtime === mtime) return settingsCache.value;
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const picked = Object.fromEntries(LIVE_DIALS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
		// Same checks as writeSettings (a dummy endpoint stands in for the fields that don't apply here).
		const checked = validateSettings({ backend: "duckdb", events: "https://dials.invalid", ...picked }) as unknown as Record<string, unknown>;
		const value = Object.fromEntries(LIVE_DIALS.filter((k) => checked[k] !== undefined).map((k) => [k, checked[k]]));
		settingsCache = { mtime, value };
		return value;
	}

	/** A gzip-or-plain JSON body within the caps, or the response to send. */
	async function readJsonBody(req: Request, maxBody: number, maxInflate: number): Promise<{ value: unknown; bytes: number } | Response> {
		const body = await readCapped(req, maxBody);
		if (!body) return json(413, { error: `body over ${maxBody} bytes` });
		let bytes: Uint8Array = body;
		if (req.headers.get("content-encoding") === "gzip" || (body[0] === 0x1f && body[1] === 0x8b)) {
			try {
				bytes = gunzipSync(body, { maxOutputLength: maxInflate });
			} catch (error) {
				if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || (error as Error).name === "RangeError") return json(413, { error: `inflated body over ${maxInflate} bytes` });
				return json(400, { error: "body is not valid gzip" });
			}
			if (bytes.length > maxInflate) return json(413, { error: `inflated body over ${maxInflate} bytes` });
		}
		try {
			return { value: JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")), bytes: bytes.length };
		} catch {
			return json(400, { error: "body is not JSON" });
		}
	}

	// Analytics availability ----------------------------------------------------------------------------------------------

	const analyticsOff = () => json(404, { error: "the analytics part is off on this server" });
	/** 503 + Retry-After while DuckDB isn't open: a handover (the previous server still holds it), or a failed start. */
	function analyticsUnavailable(): Response {
		if (analytics === "failed") return json(503, { error: "analytics is unavailable: the server could not open its database (see the server log)" }, { "retry-after": "60" });
		return json(503, { error: "analytics is starting (deploy handover): try again in a few seconds" }, { "retry-after": String(RETRY_AFTER_SECONDS) });
	}
	/** The open warehouse, or the answer: 404 when the analytics part is off, 503 while DuckDB isn't open. */
	function analyticsOr(): Warehouse | Response {
		if (!config.parts.has("analytics")) return analyticsOff();
		return warehouse ?? analyticsUnavailable();
	}
	/** Every request once stop() ran (the senders retry; the next server takes them). */
	const restarting = () => json(503, { error: "the server is restarting: try again in a few seconds" }, { "retry-after": String(RETRY_AFTER_SECONDS) });

	// Game routes -------------------------------------------------------------------------------------------------------

	async function ingest(req: Request, ip: string): Promise<Response> {
		if (!config.parts.has("analytics")) return analyticsOff();
		if (!auth.hasGameKey(req)) return badGameKey(req, ip, "ingest");
		if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
		// In a handover the batch isn't read: the sender keeps it and sends it again (analytics: backoff from 5 s).
		const warehouse = analyticsOr();
		if (warehouse instanceof Response) return warehouse;
		const read = await readJsonBody(req, config.maxBodyBytes, config.maxInflateBytes);
		if (read instanceof Response) return read;
		const parsed = read.value;
		let batch;
		try {
			batch = validateBatch(parsed);
		} catch (error) {
			if (error instanceof BatchShapeError) return json(400, { error: error.message });
			throw error;
		}
		const job = batch.events[0]?.job ?? batch.recordings[0]?.job;
		if (job && !jobLimiter.take(`job:${job}`)) return tooMany(jobLimiter.retryAfter(`job:${job}`));
		// Identity rows (pid -> UserId) go to the identity table, never into the events.
		const who = parseIdentities(isRecordLike(parsed) ? parsed.identities : undefined, clock());
		const known = who.rows.filter((r) => !warehouse.isErased(r.pid));
		if (known.length) await identities.upsert(known);
		// The writer (awaited) puts the rows in the raw file; the live view and others get the same message.
		try {
			await bus.publish("events", { events: batch.events, recordings: batch.recordings, rejected: batch.rejected, rt: clock() }, read.bytes);
		} catch (error) {
			// Stopping: the raw files are closed (the next server owns them); the sender sends the batch again.
			if (error instanceof RawLogClosed) return restarting();
			throw error;
		}
		metrics.rowsIn(batch.events.length + batch.recordings.length, read.bytes);
		return json(202, {
			accepted: batch.events.length + batch.recordings.length,
			rejected: batch.rejected,
			...(batch.errors.length ? { errors: batch.errors } : {}),
			...(who.rows.length || who.rejected ? { identities: known.length, identitiesRejected: who.rejected } : {}),
		});
	}

	/** A JobId seen by POST /v1/errors (or the fleet) lately: it skips the never-seen gate. */
	async function knownErrorSender(job: string): Promise<boolean> {
		const seen = errorSenders.get(job);
		if (seen !== undefined && clock() - seen < ERROR_SENDER_TTL_MS) return true;
		return fleet ? fleet.knows(job) : false;
	}
	function rememberErrorSender(job: string): void {
		errorSenders.delete(job);
		errorSenders.set(job, clock());
		while (errorSenders.size > ERROR_SENDERS_MAX) errorSenders.delete(errorSenders.keys().next().value as string);
	}

	/**
	 * POST /v1/errors (API key): error logs, templated and fingerprinted by the game. Limits: per address, per JobId (`j`,
	 * required), never-seen JobIds per minute, and the store's queue (429 when full); the store bounds the rest.
	 */
	async function postErrors(req: Request, ip: string): Promise<Response> {
		if (!auth.hasGameKey(req)) return badGameKey(req, ip, "error log");
		if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
		if (!errorIpLimiter.take(ip)) return tooMany(errorIpLimiter.retryAfter(ip));
		if (errors.full) return tooMany(1);
		const read = await readJsonBody(req, Math.min(config.maxBodyBytes, ERRORS_MAX_BODY), Math.min(config.maxInflateBytes, ERRORS_MAX_INFLATE));
		if (read instanceof Response) return read;
		const at = clock();
		let batch;
		try {
			batch = parseErrorBatch(read.value, at, req.headers.get("x-tt-job"));
		} catch (error) {
			if (error instanceof ErrorInputError) return json(400, { error: error.message });
			throw error;
		}
		const job = batch.job;
		if (!(await knownErrorSender(job))) {
			const verdict = newErrorJobs.take(job);
			if (verdict !== "ok") {
				if (verdict === "flood") log(`error logs: more than ${newErrorJobs.perMinute} new JobIds this minute; refusing new ones until it ends`);
				return json(429, { error: "rate limited: too many new JobIds this minute" }, { "retry-after": String(newErrorJobs.retryAfter()) });
			}
		}
		if (!errorJobLimiter.take(`job:${job}`)) return tooMany(errorJobLimiter.retryAfter(`job:${job}`));
		rememberErrorSender(job);
		if (batch.items.length) {
			if (errors.full) return tooMany(1);
			try {
				await bus.publish("error", { ...batch, at, ip }, read.bytes);
			} catch (error) {
				if (error instanceof ErrorQueueFull) return tooMany(1);
				throw error;
			}
		}
		return json(202, { accepted: batch.items.length, rejected: batch.rejected, ...(batch.errors.length ? { errors: batch.errors } : {}) });
	}

	/** POST /v1/identity (API key): identity rows from Basin games (the framework posts them to the fleet API). */
	async function postIdentity(req: Request, ip: string): Promise<Response> {
		if (!auth.hasGameKey(req)) return badGameKey(req, ip, "identity");
		if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
		// The erased list lives in DuckDB: without it an erased player's link could come back, so this waits for a handover.
		if (config.parts.has("analytics") && !warehouse) return analyticsUnavailable();
		const raw = await readCapped(req, 256 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: unknown;
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8"));
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		const list = isRecordLike(body) && Array.isArray(body.identities) ? body.identities : body;
		const who = parseIdentities(list, clock());
		const known = who.rows.filter((r) => !warehouse?.isErased(r.pid));
		if (known.length) await identities.upsert(known);
		return json(202, { accepted: known.length, rejected: who.rejected });
	}

	// Admin routes ------------------------------------------------------------------------------------------------------

	/** GET /v1/identity (admin): ?pid= or ?uid=, or the count and whether a backfill can run. */
	async function getIdentity(url: URL): Promise<Response> {
		const pid = url.searchParams.get("pid");
		const uidText = url.searchParams.get("uid");
		if (pid) {
			if (!PID_PATTERN.test(pid)) return json(400, { error: "bad pid" });
			const found = await identities.byPid(pid);
			return json(200, { identities: found ? [found] : [] });
		}
		if (uidText) {
			const uid = parseUid(uidText);
			if (uid === undefined) return json(400, { error: "uid must be a UserId (digits)" });
			return json(200, { identities: await identities.byUid(uid) });
		}
		return json(200, { count: await identities.count(), backfill: Boolean(config.openCloudKey && config.universeId) });
	}

	/**
	 * GET /v1/identity/resolve?pid=a,b&uid=1,2 (admin, or the lookup token): pid -> UserId and UserId -> pids in bulk, for
	 * scripts and LLM agents. Ids only: no names, avatars or play history. Erased pids are unknown. Admin only among the
	 * signed-in roles (the web role is refused, per the privacy check). Each call is logged with counts, never the ids.
	 */
	async function resolveIdentity(req: Request, url: URL, ip: string): Promise<Response> {
		if (!adminIpOk(ip)) return notFound();
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		let caller = "lookup token";
		if (!auth.hasLookupBearer(req)) {
			const gate = adminGate(req, ip);
			if ("response" in gate) return gate.response;
			const user = gate.principal.user;
			caller = user.kind === "roblox" ? `owner ${user.userId}` : "admin token";
		}
		if (req.method !== "GET") return json(405, { error: "GET only" });
		if (!resolveLimiter.take(ip)) return tooMany(resolveLimiter.retryAfter(ip));
		const list = (name: string) => [...new Set(url.searchParams.getAll(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))];
		const pids = list("pid");
		const uidTexts = list("uid");
		if (!pids.length && !uidTexts.length) return json(400, { error: "give pid=<pid>[,<pid>...] and/or uid=<UserId>[,<UserId>...]" });
		if (pids.length + uidTexts.length > RESOLVE_MAX) return json(400, { error: `at most ${RESOLVE_MAX} pids and UserIds in one request` });
		const badPid = pids.find((p) => !PID_PATTERN.test(p));
		if (badPid !== undefined) return json(400, { error: "bad pid" });
		const uids: number[] = [];
		for (const text of uidTexts) {
			const uid = parseUid(text);
			if (uid === undefined) return json(400, { error: "uid must be a UserId (digits)" });
			if (!uids.includes(uid)) uids.push(uid);
		}
		const erased = (pid: string) => warehouse?.isErased(pid) === true;
		const known = await identities.uids(pids.filter((p) => !erased(p)));
		const byPid = pids.map((pid) => ({ pid, uid: known.get(pid) ?? null }));
		const byUid: { uid: number; pids: string[] }[] = [];
		for (const uid of uids) byUid.push({ uid, pids: (await identities.byUid(uid)).map((i) => i.pid).filter((p) => !erased(p)) });
		log(`identity resolve: ${pids.length} pid(s), ${uids.length} UserId(s) by ${caller} from ${ip}`);
		return json(200, { byPid, byUid });
	}

	/**
	 * GET /v1/identity/<pid>/profile (admin): the pid's UserId and its Roblox username, display name and avatar headshot,
	 * looked up by the server (RobloxProfiles: fixed hosts, timeouts, cached). `linked: false` when no UserId is known;
	 * `roblox` says how the lookup went, and the UserId is there even when Roblox didn't answer.
	 */
	async function playerProfile(pid: string, ip: string): Promise<Response> {
		if (!PID_PATTERN.test(pid)) return json(400, { error: "bad pid" });
		if (!profileLimiter.take(ip)) return tooMany(profileLimiter.retryAfter(ip));
		const found = await identities.byPid(pid);
		if (!found) return json(200, { pid, linked: false });
		const { profile, status, cached } = await robloxProfiles.get(found.uid);
		return json(200, { pid, linked: true, uid: found.uid, roblox: status, cached, name: profile.name, displayName: profile.displayName, avatar: profile.avatar });
	}

	/**
	 * The error -> players and experiment -> players lists' identities: UserIds from the identity table, Roblox names from the profile cache only (a
	 * few uncached ones are looked up in the background, bounded by RobloxProfiles' own caps, so the next refresh has
	 * them), and erased pids as null (left out).
	 */
	async function playerIdentities(pids: string[]): Promise<Map<string, PlayerIdentity | null>> {
		const out = new Map<string, PlayerIdentity | null>();
		const uids = await identities.uids(pids);
		let warm = PLAYER_NAME_WARM;
		for (const pid of pids) {
			if (warehouse?.isErased(pid)) {
				out.set(pid, null);
				continue;
			}
			const uid = uids.get(pid);
			if (uid === undefined) continue;
			const cached = robloxProfiles.peek(uid);
			if (!cached?.fresh && warm-- > 0) void robloxProfiles.get(uid).catch(() => undefined);
			const profile = cached?.profile;
			out.set(pid, { uid, ...(profile?.name ? { name: profile.name } : {}), ...(profile?.displayName ? { displayName: profile.displayName } : {}) });
		}
		return out;
	}

	/**
	 * GET /v1/place (every signed-in role): the game's name, live players and icon for the sidebar card. The game is
	 * TYPETORCH_UNIVERSE_ID, else the PlaceId of the server heard from last; neither: `{ configured: false }`.
	 */
	async function placeCard(ip: string): Promise<Response> {
		if (!placeLimiter.take(ip)) return tooMany(placeLimiter.retryAfter(ip));
		const fleetPlace = fleet ? await fleet.latestPlaceId() : null;
		if (!config.universeId && !fleetPlace) return json(200, { configured: false });
		const { place, status, cached } = await robloxPlace.get(config.universeId ? { universeId: config.universeId } : { placeId: fleetPlace as number });
		const placeId = place.placeId ?? fleetPlace;
		return json(200, { configured: true, roblox: status, cached, ...place, placeId, url: placeId ? `https://www.roblox.com/games/${placeId}` : null });
	}

	/**
	 * GET /v1/roblox/products?gamepass=1,2&product=3 (every signed-in role): each game pass and developer product's name,
	 * Robux price and icon, for the explorer's product tooltips. Ids are positive integers, at most MAX_PRODUCT_IDS in all.
	 * An item Roblox doesn't know or doesn't answer for comes back with its id, its status and no name.
	 */
	async function productInfo(url: URL, ip: string): Promise<Response> {
		for (const key of url.searchParams.keys()) {
			if (key !== "gamepass" && key !== "product") return json(400, { error: "only gamepass and product ids" });
		}
		if (url.searchParams.getAll("gamepass").length > 1 || url.searchParams.getAll("product").length > 1) return json(400, { error: "one gamepass and one product list" });
		const gamepass = parseIdList(url.searchParams.get("gamepass"));
		const product = parseIdList(url.searchParams.get("product"));
		if (!gamepass || !product) return json(400, { error: "ids must be comma-separated positive integers" });
		if (!gamepass.length && !product.length) return json(400, { error: "no ids: ?gamepass=1,2&product=3" });
		if (gamepass.length + product.length > MAX_PRODUCT_IDS) return json(400, { error: `at most ${MAX_PRODUCT_IDS} ids` });
		if (!productsLimiter.take(ip)) return tooMany(productsLimiter.retryAfter(ip));
		return json(200, { items: await robloxProducts.get({ gamepass, product }) });
	}

	/**
	 * GET /v1/roblox/servers/<job>/logs (every signed-in role): one page of the errors and warnings Roblox kept for a game
	 * server. Roblox files them under the server's place and place version: the fleet's row has both (heartbeat `p` /
	 * `pv`), `placeId` / `placeVersion` in the query name them for a server the fleet doesn't know or an older kernel.
	 */
	async function serverLogs(job: string, url: URL, ip: string): Promise<Response> {
		const allowed = new Set(["severity", "search", "order", "pageToken", "placeId", "placeVersion"]);
		for (const key of url.searchParams.keys()) {
			if (!allowed.has(key)) return json(400, { error: `unknown parameter ${JSON.stringify(key.slice(0, 40))}` });
			if (url.searchParams.getAll(key).length > 1) return json(400, { error: `one ${key}` });
		}
		if (!/^[A-Za-z0-9-]{1,64}$/.test(job)) return json(400, { error: "bad JobId" });
		const severity = (url.searchParams.get("severity") ?? "").split(",").filter((s) => s !== "");
		if (severity.length > 8 || !severity.every((s) => SEVERITY_PATTERN.test(s))) return json(400, { error: "severity: up to 8 comma-separated words" });
		const search = url.searchParams.get("search") ?? "";
		if (search.length > SEARCH_MAX) return json(400, { error: `search: at most ${SEARCH_MAX} characters` });
		const order = url.searchParams.get("order");
		if (order !== null && order !== "asc" && order !== "desc") return json(400, { error: "order: asc or desc" });
		const pageToken = url.searchParams.get("pageToken") ?? "";
		if (pageToken.length > 2048 || /[^\x21-\x7e]/.test(pageToken)) return json(400, { error: "bad pageToken" });
		const asId = (name: string): number | undefined | null => {
			const raw = url.searchParams.get(name);
			if (raw === null) return undefined;
			return /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
		};
		const askedPlace = asId("placeId");
		const askedVersion = asId("placeVersion");
		if (askedPlace === null || askedVersion === null) return json(400, { error: "placeId and placeVersion are positive integers" });
		if (!robloxServers.configured) return json(409, { error: "Roblox server management is off: set OPENCLOUD_API_KEY (scope universe:read) and TYPETORCH_UNIVERSE_ID" });
		const known = fleet ? await fleet.placeOf(job) : null;
		const placeId = askedPlace ?? known?.placeId ?? undefined;
		const placeVersion = askedVersion ?? known?.placeVersion ?? undefined;
		if (!placeId || !placeVersion) {
			return json(409, {
				error: "the server's place version isn't known (its kernel doesn't send `pv` yet): pass placeVersion (and placeId) in the query",
				placeId: placeId ?? null,
				placeVersion: placeVersion ?? null,
			});
		}
		if (!serversLimiter.take(ip)) return tooMany(serversLimiter.retryAfter(ip));
		try {
			const page = await robloxServers.logs({ jobId: job, placeId, placeVersion, severity, search, ascending: order === "asc", ...(pageToken ? { pageToken } : {}) });
			return json(200, { jobId: job, placeId, placeVersion, ...page });
		} catch (error) {
			return robloxServersFailure(error);
		}
	}

	function robloxServersFailure(error: unknown): Response {
		if (error instanceof RobloxServersError) return error.status === 429 ? tooMany(60) : json(error.status, { error: error.message });
		return json(502, { error: "Roblox server management failed" });
	}

	/** POST /v1/identity/backfill (admin): pid <-> UserId for players who joined before identity rows existed. */
	async function backfill(req: Request): Promise<Response> {
		if (!config.openCloudKey || !config.universeId) {
			return json(409, { error: "no DataStore access: set OPENCLOUD_API_KEY (universe-datastores.objects:list and :read) and TYPETORCH_UNIVERSE_ID" });
		}
		const raw = await readCapped(req, 16 * 1024);
		let body: { pageToken?: unknown; maxEntries?: unknown } = {};
		try {
			body = raw && raw.length ? JSON.parse(Buffer.from(raw).toString("utf8")) : {};
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		try {
			const result = await backfillIdentities({
				apiKey: config.openCloudKey,
				universeId: config.universeId,
				store: identities,
				clock,
				...(typeof body.pageToken === "string" ? { pageToken: body.pageToken } : {}),
				...(typeof body.maxEntries === "number" ? { maxEntries: body.maxEntries } : {}),
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
			return json(200, result);
		} catch (error) {
			return json(502, { error: `backfill failed: ${((error as Error).message ?? String(error)).slice(0, 300)}` });
		}
	}

	async function query(req: Request, name: string): Promise<Response> {
		const warehouse = analyticsOr();
		if (warehouse instanceof Response) return warehouse;
		if (!isQueryName(name)) return json(404, { error: `unknown query ${JSON.stringify(name)}` });
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: { filters?: object; options?: object } = {};
		if (raw.length) {
			try {
				body = JSON.parse(Buffer.from(raw).toString("utf8"));
			} catch {
				return json(400, { error: "body is not JSON" });
			}
		}
		// pid <-> UserId from the identity table: a UserId instead of a pid, or a UserId as a players search.
		const queryOptions: Record<string, unknown> = { ...(isRecordLike(body.options) ? body.options : {}) };
		if ((name === "timeline" || name === "player-graph" || name === "player-stats" || name === "events") && queryOptions.pid === undefined && queryOptions.uid !== undefined) {
			const uid = parseUid(queryOptions.uid);
			if (uid === undefined) return json(400, { error: "uid must be a UserId (digits)" });
			const known = await identities.byUid(uid);
			if (!known.length) return json(404, { error: `no pid known for UserId ${uid}` });
			queryOptions.pid = known[0].pid;
		}
		delete queryOptions.uid;
		if (name === "players" && typeof queryOptions.search === "string" && /^\d{1,16}$/.test(queryOptions.search)) {
			const known = await identities.byUid(Number(queryOptions.search));
			const given = Array.isArray(queryOptions.pids) ? (queryOptions.pids as unknown[]) : [];
			if (known.length) queryOptions.pids = [...given, ...known.map((k) => k.pid)].slice(0, 50);
		}
		try {
			renderQuery(warehouse.context(), name, body.filters, queryOptions); // input errors -> 400
		} catch (error) {
			return json(400, { error: (error as Error).message });
		}
		try {
			const started = performance.now();
			let result = await warehouse.query(name, body.filters, queryOptions);
			// A Graph answers through its toJSON; as plain data it can carry the uid too.
			const asJson = result as { toJSON?: () => unknown };
			if (typeof asJson.toJSON === "function") result = asJson.toJSON();
			if (name === "players") {
				const players = (result as { players: { pid: string; uid?: number }[] }).players;
				const uids = await identities.uids(players.map((p) => p.pid));
				for (const p of players) {
					const uid = uids.get(p.pid);
					if (uid !== undefined) p.uid = uid;
				}
			}
			if (name === "experiment-players" || name === "funnel-players") result = await withPlayerIdentities(result as ExperimentPlayersResult | FunnelPlayersResult);
			if (name === "timeline" || name === "player-graph" || name === "player-stats") {
				const r = result as { pid?: string; uid?: number };
				const found = r.pid ? await identities.byPid(r.pid) : undefined;
				if (found) r.uid = found.uid;
			}
			return json(200, { result, ms: Math.round(performance.now() - started) });
		} catch (error) {
			const message = (error as Error).message ?? String(error);
			if (/interrupt/i.test(message)) return json(504, { error: `query took longer than ${config.queryTimeoutSeconds} s` });
			log(`query ${name} failed: ${message.slice(0, 300)}`);
			return json(500, { error: "query failed", detail: message.slice(0, 300) });
		}
	}

	/** An experiment / funnel -> players list with UserIds and Roblox names joined in and erased players left out (as the error list). */
	async function withPlayerIdentities<R extends { total: number; players: { pid: string }[] }>(found: R): Promise<R> {
		const who = await playerIdentities([...new Set(found.players.map((p) => p.pid))]);
		const shown = found.players.filter((p) => who.get(p.pid) !== null);
		const erased = found.players.length - shown.length;
		return {
			...found,
			total: Math.max(0, found.total - erased),
			players: shown.map((p) => {
				const id = who.get(p.pid);
				return { ...p, ...(id?.uid !== undefined ? { uid: id.uid } : {}), ...(id?.name ? { name: id.name } : {}), ...(id?.displayName ? { displayName: id.displayName } : {}) };
			}),
		};
	}

	/**
	 * GET /v1/experiments (every signed-in reader, like the Experiments page): only the `experiments` overrides of the
	 * settings file (active, weights, variant), never the file's other fields. The live record is the game's signed
	 * settings in its DataStore; this server only knows the copy in data/settings.json, so `source` says which.
	 */
	function experimentOverrides(): Response {
		let dials: Record<string, unknown>;
		try {
			dials = liveDials();
		} catch {
			return json(200, { source: "unreadable", experiments: {} });
		}
		const found = dials.experiments as Record<string, { active?: boolean; weights?: number[]; variant?: string }> | undefined;
		if (!found) return json(200, { source: "none", experiments: {} });
		const experiments = Object.fromEntries(
			Object.entries(found).map(([name, e]) => [
				name,
				{ ...(e.active !== undefined ? { active: e.active } : {}), ...(e.weights ? { weights: e.weights } : {}), ...(e.variant !== undefined ? { variant: e.variant } : {}) },
			]),
		);
		return json(200, { source: "settings-file", experiments });
	}

	/** GET /v1/experiments/<key>/players (every signed-in reader, like the Experiments page's queries). */
	async function experimentPlayersRead(path: string, url: URL): Promise<Response> {
		const warehouse = analyticsOr();
		if (warehouse instanceof Response) return warehouse;
		let input: ReturnType<typeof parseExperimentPlayers>;
		try {
			input = parseExperimentPlayers(path, url.searchParams, clock());
			renderQuery(warehouse.context(), "experiment-players", input.filters, input.options); // input errors -> 400
		} catch (error) {
			if (error instanceof ExperimentPlayersInput && error.message === "not found") return json(404, { error: "not found" });
			return json(400, { error: (error as Error).message.slice(0, 300) });
		}
		try {
			const found = (await warehouse.query("experiment-players", input.filters, input.options)) as ExperimentPlayersResult;
			return json(200, await withPlayerIdentities(found));
		} catch (error) {
			const message = (error as Error).message ?? String(error);
			if (/interrupt/i.test(message)) return json(504, { error: `query took longer than ${config.queryTimeoutSeconds} s` });
			log(`experiment players failed: ${message.slice(0, 300)}`);
			return json(500, { error: "query failed" });
		}
	}

	const STORAGE_CACHE_SECONDS = 30;
	let storageCache: { at: number; report: Promise<StorageReport> } | undefined;

	/** The storage report, measured at most every 30 s (the explorer polls it). */
	function storage(): Promise<StorageReport> {
		const now = clock();
		if (storageCache && now - storageCache.at < STORAGE_CACHE_SECONDS * 1000) return storageCache.report;
		const w = warehouse;
		const report = measureStorage({
			layout: w?.layout ?? dataLayout(config.dataDir),
			...(fleet ? { fleetDb: config.fleetDb } : {}),
			...(w ? { sql: (s: string) => w.sql(s), liveRows: () => w.liveRows() } : {}),
			clock,
			cacheSeconds: STORAGE_CACHE_SECONDS,
		});
		storageCache = { at: now, report };
		report.catch(() => (storageCache = undefined));
		return report;
	}

	let sandbox: Promise<SqlSandbox> | undefined;

	async function adhocSql(req: Request): Promise<Response> {
		const warehouse = analyticsOr();
		if (warehouse instanceof Response) return warehouse;
		if (!config.sql) return json(404, { error: "ad-hoc SQL is off on this server (TYPETORCH_SQL=0)" });
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: { sql?: unknown; limit?: unknown };
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8") || "{}");
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		const w = warehouse;
		sandbox ??= SqlSandbox.open({
			layout: w.layout,
			memoryLimit: config.sqlMemoryLimit,
			timeoutSeconds: config.queryTimeoutSeconds,
			snapshot: (tables) => w.snapshotLive(tables),
		});
		let box: SqlSandbox;
		try {
			box = await sandbox;
		} catch (error) {
			sandbox = undefined;
			log(`sql sandbox failed to open: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
			return json(500, { error: "the SQL sandbox failed to open" });
		}
		const started = performance.now();
		try {
			const result = await box.run(body.sql, typeof body.limit === "number" ? body.limit : undefined);
			return json(200, { ...result, ms: Math.round(performance.now() - started) });
		} catch (error) {
			const message = ((error as Error).message ?? String(error)).slice(0, 500);
			if (/interrupt/i.test(message)) return json(504, { error: `query took longer than ${config.queryTimeoutSeconds} s` });
			// Parser, binder and permission errors are the query's own; answer them as input errors.
			return json(400, { error: error instanceof SqlInputError ? message : `query failed: ${message}` });
		}
	}

	async function rollups(url: URL, kind: string): Promise<Response> {
		const warehouse = analyticsOr();
		if (warehouse instanceof Response) return warehouse;
		const q = url.searchParams;
		const limit = Math.min(10_000, Math.max(1, Number(q.get("limit") ?? 1000) || 1000));
		const pid = q.get("pid");
		if (pid && !/^[A-Za-z0-9_-]{1,64}$/.test(pid)) return json(400, { error: "bad pid" });
		const dir = join(warehouse.layout.rollups, kind === "players" ? "" : kind);
		let source: string;
		if (kind === "players") {
			const file = join(warehouse.layout.rollups, "players.parquet");
			if (!existsSync(file)) return json(200, { rows: [] });
			source = `read_parquet(${pathLit(file)})`;
		} else {
			// Dates (inclusive) or exact instants (unix ms or ISO; widened to the days they touch).
			let days: { first: number; last: number };
			try {
				days = rollupDays(q.get("from"), q.get("to"));
			} catch (error) {
				return json(400, { error: (error as Error).message.slice(0, 200) });
			}
			const files = dayFiles(dir).filter((f) => f.day >= days.first && f.day <= days.last);
			if (!files.length) return json(200, { rows: [] });
			source = `read_parquet([${files.map((f) => pathLit(f.path)).join(", ")}])`;
		}
		const where = pid && kind !== "daily" ? ` WHERE pid = '${pid}'` : "";
		const rows = await warehouse.sql(`SELECT * FROM ${source}${where} LIMIT ${limit}`);
		return json(200, { rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]))) });
	}

	/** POST /v1/erasure: the Roblox webhook (signed), or the admin token / an admin session erasing by pid. */
	async function erasure(req: Request, ip: string): Promise<Response> {
		if (!config.parts.has("analytics")) return analyticsOff();
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		const text = Buffer.from(raw).toString("utf8");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		const principal = adminIpOk(ip) ? auth.principal(req) : undefined;
		if (principal?.role === "web") return json(403, { error: READ_ONLY });
		if (principal?.role === "admin") {
			if (principal.via === "cookie") {
				const problem = cookieMutationProblem(req, proxyOpts);
				if (problem) return json(403, { error: problem });
			}
			const w = analyticsOr();
			if (w instanceof Response) return w;
			const b = body as { pid?: unknown; pids?: unknown };
			const pids = (Array.isArray(b.pids) ? b.pids : [b.pid]).filter((p): p is string => typeof p === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p));
			if (!pids.length) return json(400, { error: "give pid or pids" });
			const { liveRows } = await w.erase(pids);
			await identities.deletePids(pids);
			await errors.erasePids(pids);
			void w.rewriteErased().catch((e) => log(`erasure rewrite failed: ${(e as Error).message}`));
			logErasure(w.layout.erasure, { source: "admin", pids: pids.length, liveRows });
			return json(200, { erased: pids.length, liveRows, files: "rewriting in the background" });
		}
		if (!config.webhookSecret) return json(401, { error: "erasure webhook secret not configured" });
		const check = verifyRobloxSignature(req.headers.get("roblox-signature"), text, config.webhookSecret, clock());
		if (!check.ok) return json(401, { error: check.reason });
		const request = parseErasureBody(body);
		if (request.eventType === "SampleNotification") return json(200, { ok: true, sample: true });
		if (request.eventType !== "RightToErasureRequest") return json(200, { ok: true, ignored: request.eventType });
		// A handover: 503, and Roblox sends the notification again.
		const w = analyticsOr();
		if (w instanceof Response) return w;
		if (config.universeId && request.gameIds.length && !request.gameIds.includes(config.universeId)) {
			logErasure(w.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "another game" });
			return json(200, { ok: true, ignored: "another game" });
		}
		if (!request.userId) return json(400, { error: "no UserId in the payload" });
		// UserId -> pids: the identity table first, then the DataStore link (which also deletes it when configured).
		const pids = (await identities.byUid(request.userId)).map((i) => i.pid);
		if (config.openCloudKey && config.universeId) {
			try {
				const linked = await lookupPid({ apiKey: config.openCloudKey, universeId: config.universeId, deleteLink: config.erasureDeleteLink, ...(options.fetch ? { fetch: options.fetch } : {}) }, request.userId);
				if (linked && !pids.includes(linked)) pids.push(linked);
			} catch (error) {
				if (!pids.length) {
					logErasure(w.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: `lookup failed: ${(error as Error).message.slice(0, 200)}` });
					return json(502, { error: "pid lookup failed; Roblox will retry" });
				}
			}
		} else if (!pids.length) {
			logErasure(w.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "no identity row and no Open Cloud key for the DataStore lookup" });
			return json(202, { ok: true, pending: "no pid known for this UserId: configure OPENCLOUD_API_KEY and TYPETORCH_UNIVERSE_ID, or erase by pid with the admin token" });
		}
		if (!pids.length) {
			logErasure(w.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "no pid link (already anonymous)" });
			return json(200, { ok: true, erased: 0 });
		}
		const { liveRows } = await w.erase(pids);
		// The rows first, then the link between the UserId and its pids.
		await identities.deleteUid(request.userId);
		await identities.deletePids(pids);
		await errors.erasePids(pids);
		void w.rewriteErased().catch((e) => log(`erasure rewrite failed: ${(e as Error).message}`));
		logErasure(w.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "erased", pids: pids.length, liveRows });
		return json(200, { ok: true, erased: pids.length });
	}

	/**
	 * GET /healthz: { ok } for everyone (the container health check); the full view for the admin token. A Bearer header
	 * counts toward the same lockout as the login, and a blocked address gets the plain answer without its token being
	 * looked at, so this is no token oracle.
	 */
	async function health(req: Request, ip: string): Promise<Response> {
		const plain = () => json(200, { ok: true });
		if (!adminIpOk(ip)) return plain();
		const given = bearer(req) !== undefined;
		if (given && authFailures.blocked(ip)) return plain();
		const principal = auth.principal(req);
		if (!principal && given && !auth.hasLookupBearer(req)) failedAuth(ip, "health check token");
		if (principal?.role !== "admin") return plain();
		const memory = process.memoryUsage();
		const out: Record<string, unknown> = {
			ok: true,
			// ready | handover | failed | stopping (ServerState): only the admin view says it.
			state: serverState(),
			version: PACKAGE.version,
			runtime: runtimeName(),
			uptimeSeconds: Math.round(process.uptime()),
			rssMb: Math.round(memory.rss / 1048576),
			heapMb: Math.round(memory.heapUsed / 1048576),
		};
		if (warehouse) {
			const oldest = warehouse.raw.oldestPending();
			out.analytics = {
				...warehouse.stats,
				loaderLagSeconds: oldest === undefined ? 0 : Math.round((clock() - oldest) / 100) / 10,
				pendingBytes: warehouse.raw.pendingBytes(),
				live: await warehouse.liveRows(),
			};
		} else if (analytics === "handover" || analytics === "failed") {
			out.analytics = { state: analytics, waitingSeconds: Math.round((Date.now() - handover.since) / 1000), giveUpSeconds: config.handoverSeconds };
		}
		if (fleet) out.fleet = { ...(await fleet.counts()), streams: fleet.subscribers, ...(notifier.configured ? { webhook: notifier.stats } : {}) };
		// Plans/25: counters and what is held in memory (never an answer).
		if (remoteDebug) out.remoteDebug = { ...remoteDebug.stats, ...remoteDebug.memory, ...(waker?.enabled ? { wake: waker.stats } : { wake: "off" }) };
		// The bus: per subscriber what was handled, what is waiting and what was dropped (full queue).
		out.bus = bus.stats();
		out.live = live.stats;
		out.errors = errors.stats;
		out.sessions = sessions.size;
		if (central) {
			const last = central.reporter.last;
			out.central = {
				fingerprint: central.key.fingerprint,
				issuer: central.config.issuer,
				report: last ? { at: new Date(last.at).toISOString(), result: last.result, ...(last.status !== undefined ? { status: last.status } : {}) } : "not yet",
				devices: central.devices.size,
				blessKeys: central.blessKeys.size,
			};
		}
		return json(200, out);
	}

	// Auth routes -------------------------------------------------------------------------------------------------------

	// `dashboard`: the typetorch.dev broker's origin (public, the same issuer the login redirects to), for the explorer's
	// "TypeTorch Dashboard" link. Only while Sign in with typetorch.dev is on.
	const dashboard = () => (central ? { dashboard: central.config.issuer } : {});
	const loginOptions = () => ({ token: runtime.get("tokenLogin"), roblox: Boolean(oauth), ...(central ? { typetorch: true, ...dashboard() } : {}) });
	const secureCookie = (req: Request) => isHttps(req, proxyOpts);
	const notFound = () => json(404, { error: "not found" });
	const blockedResponse = (ip: string): Response | undefined => {
		const wait = authFailures.blocked(ip);
		return wait ? tooMany(wait) : undefined;
	};
	/** A game route without the API key: 401, counted per address when a (wrong) key was sent; 429 past the limit. */
	function badGameKey(req: Request, ip: string, what: string): Response {
		if (bearer(req) === undefined) return json(401, { error: "API key required" });
		const wait = gameKeyFailures.blocked(ip);
		if (wait) return tooMany(wait);
		const first = gameKeyFailures.count(ip) === 0;
		gameKeyFailures.fail(ip);
		if (first) log(`${what}: wrong API key from ${ip}`);
		if (gameKeyFailures.blocked(ip)) log(`${ip}: wrong API keys are refused for ${Math.ceil(config.loginWindowMs / 60_000)} min after ${GAME_KEY_MAX_FAILURES} tries`);
		return json(401, { error: "API key required" });
	}
	function failedAuth(ip: string, what: string): void {
		authFailures.fail(ip);
		log(`${what} failed from ${ip}`);
		if (authFailures.blocked(ip)) log(`${ip} is blocked for ${Math.ceil(config.loginWindowMs / 60_000)} min after ${config.loginMaxFailures} failed attempts`);
	}
	function sessionCookie(req: Request, value: string): string {
		return setCookie(SESSION_COOKIE, value, { secure: secureCookie(req), sameSite: "Strict", maxAgeSeconds: config.sessionMaxMs / 1000 });
	}
	const describeUser = (p: Principal) => ("user" in p ? p.user : undefined);

	/** GET /v1/auth/check: which role these credentials have. No side effects (a rejected Bearer only counts toward the limit). */
	function authCheck(req: Request, ip: string): Response {
		const gameOnly = auth.hasGameKey(req);
		// Behind the allow list the admin side doesn't exist for other addresses; a game key may still check itself.
		if (!adminIpOk(ip) && !gameOnly) return notFound();
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		if (!checkLimiter.take(ip)) return tooMany(checkLimiter.retryAfter(ip));
		if (auth.hasLookupBearer(req)) return json(200, { ok: true, role: "lookup", via: "bearer", routes: ["GET /v1/identity/resolve"], service: "typetorch-backend", version: PACKAGE.version });
		const principal = auth.principal(req);
		if (principal && (principal.role === "game" || adminIpOk(ip))) {
			const user = describeUser(principal);
			// `parts`: what this server runs, so `typetorch fleet setup` / `settings set analytics` can refuse a game key for a
			// part that is off (a game key writes to every part that runs; the admin token reads them).
			const parts = { analytics: config.parts.has("analytics"), fleet: config.parts.has("fleet") };
			return json(200, { ok: true, role: principal.role, via: principal.via, ...(user ? { user } : {}), service: "typetorch-backend", version: PACKAGE.version, parts, ...dashboard(), ...untrustedOwner(principal) });
		}
		if (bearer(req) !== undefined) failedAuth(ip, "token check");
		return json(401, { error: "sign in required", login: loginOptions() });
	}

	/**
	 * `untrustedOwner`: this read-only session is a listed owner's, signed in with typetorch.dev on a browser that was never
	 * blessed, so the explorer can say why and offer "Trust this browser". Never for a viewer, and never while blessing is
	 * not required (TYPETORCH_CENTRAL_LOGIN_UNBLESSED=admin). `trustWithToken`: whether
	 * POST /auth/device takes the admin token here (the token login is on); otherwise `typetorch backend bless`. Nothing is
	 * granted by the flag itself: blessing this browser (either way) upgrades this session to admin in place.
	 */
	function untrustedOwner(principal: Principal): { untrustedOwner?: true; trustWithToken?: boolean } {
		if (!central || central.config.unblessed === "admin" || principal.role !== "web" || principal.via !== "cookie") return {};
		const user = principal.user;
		if (user.kind !== "roblox" || user.login !== "typetorch.dev" || auth.roleOfRobloxUser(user.userId) !== "admin") return {};
		return { untrustedOwner: true, trustWithToken: runtime.get("tokenLogin") };
	}

	async function login(req: Request, ip: string): Promise<Response> {
		if (!adminIpOk(ip)) return notFound();
		if (!runtime.get("tokenLogin")) return json(404, { error: "token login is off on this server" });
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		const problem = cookieMutationProblem(req, proxyOpts);
		if (problem) return json(403, { error: problem });
		if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json(415, { error: "send JSON: { token }" });
		const raw = await readCapped(req, 4096);
		let token: unknown;
		try {
			token = raw ? (JSON.parse(Buffer.from(raw).toString("utf8")) as { token?: unknown }).token : undefined;
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		if (typeof token !== "string" || !tokenIn(token, [config.adminToken])) {
			failedAuth(ip, "admin login");
			return json(401, { error: "wrong token" });
		}
		authFailures.reset(ip);
		const id = sessions.create({ kind: "token" });
		return json(200, { ok: true, role: "admin", via: "cookie", user: { kind: "token" } }, { "set-cookie": sessionCookie(req, id) });
	}

	function logout(req: Request): Response {
		const cookie = readCookie(req, SESSION_COOKIE);
		if (cookie && sessions.get(cookie)) {
			const problem = cookieMutationProblem(req, proxyOpts);
			if (problem) return json(403, { error: problem });
			sessions.destroy(cookie);
		}
		return json(200, { ok: true }, { "set-cookie": clearCookie(SESSION_COOKIE, { secure: secureCookie(req), sameSite: "Strict" }) });
	}

	const redirect = (location: string, cookies: string[] = []): Response => {
		const headers = new Headers({ location, "cache-control": "no-store" });
		for (const c of cookies) headers.append("set-cookie", c);
		return new Response(null, { status: 302, headers });
	};

	async function robloxStart(req: Request, ip: string): Promise<Response> {
		if (!oauth) return json(404, { error: "Sign in with Roblox is off on this server" });
		if (!adminIpOk(ip)) return notFound();
		if (!oauthLimiter.take(`start:${ip}`)) return tooMany(oauthLimiter.retryAfter(`start:${ip}`));
		try {
			const { url, state } = await oauth.start(ip);
			const cookie = setCookie(OAUTH_COOKIE, state, { secure: secureCookie(req), sameSite: "Lax", maxAgeSeconds: 600, path: OAUTH_PATH });
			return redirect(url, [cookie]);
		} catch (error) {
			log(`roblox sign-in could not start: ${error instanceof OAuthError ? error.detail : "unexpected error"}`);
			return redirect("/?login_error=failed");
		}
	}

	async function robloxCallback(req: Request, url: URL, ip: string): Promise<Response> {
		if (!oauth) return json(404, { error: "Sign in with Roblox is off on this server" });
		if (!adminIpOk(ip)) return notFound();
		if (!oauthLimiter.take(`callback:${ip}`)) return tooMany(oauthLimiter.retryAfter(`callback:${ip}`));
		const clear = clearCookie(OAUTH_COOKIE, { secure: secureCookie(req), sameSite: "Lax", path: OAUTH_PATH });
		try {
			const who = await oauth.complete(
				{ code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") },
				readCookie(req, OAUTH_COOKIE),
			);
			const role = auth.roleOfRobloxUser(who.userId);
			if (!role) {
				log(`roblox sign-in refused from ${ip}: user ${who.userId} is not an owner or a viewer`);
				return redirect("/?login_error=not_owner", [clear]);
			}
			const id = sessions.create({ kind: "roblox", userId: who.userId, name: who.name, ...(who.displayName ? { displayName: who.displayName } : {}), ...(who.avatar ? { avatar: who.avatar } : {}) }, role);
			return redirect("/", [clear, sessionCookie(req, id)]);
		} catch (error) {
			if (error instanceof OAuthError) {
				log(`roblox sign-in failed from ${ip}: ${error.code}: ${error.detail}`);
				return redirect(`/?login_error=${error.code}`, [clear]);
			}
			log(`roblox sign-in failed from ${ip}: unexpected error`);
			return redirect("/?login_error=failed", [clear]);
		}
	}

	// Sign in with typetorch.dev -----------------------------------------------------------------------------------------

	const centralOff = () => json(404, { error: "Sign in with typetorch.dev is off on this server" });
	function deviceCookie(req: Request, value: string): string {
		return setCookie(DEVICE_COOKIE, value, { secure: secureCookie(req), sameSite: "Lax", maxAgeSeconds: DEVICE_LIFE_MS / 1000 });
	}

	/** GET /auth/typetorch/start: state, nonce and a PKCE verifier, then off to typetorch.dev's /authorize. */
	function centralStart(req: Request, ip: string): Response {
		if (!central) return centralOff();
		if (!adminIpOk(ip)) return notFound();
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		if (!oauthLimiter.take(`central-start:${ip}`)) return tooMany(oauthLimiter.retryAfter(`central-start:${ip}`));
		const { url, state } = central.login.start(ip);
		const cookie = setCookie(CENTRAL_COOKIE, state, { secure: secureCookie(req), sameSite: "Lax", maxAgeSeconds: 600, path: CENTRAL_PATH });
		return redirect(url, [cookie]);
	}

	/**
	 * GET /auth/typetorch/callback: redeem the code, check the broker's assertion and Roblox's ID token, then the role from
	 * this backend's own lists (the per-game sign-in's code path). An owner gets admin on a blessed device; on any other
	 * device what TYPETORCH_CENTRAL_LOGIN_UNBLESSED says (admin, the default; web; or refused). A fresh session every time.
	 */
	async function centralCallback(req: Request, url: URL, ip: string): Promise<Response> {
		if (!central) return centralOff();
		if (!adminIpOk(ip)) return notFound();
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		if (!oauthLimiter.take(`central-callback:${ip}`)) return tooMany(oauthLimiter.retryAfter(`central-callback:${ip}`));
		const clear = clearCookie(CENTRAL_COOKIE, { secure: secureCookie(req), sameSite: "Lax", path: CENTRAL_PATH });
		let who;
		try {
			who = await central.login.complete({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") }, readCookie(req, CENTRAL_COOKIE));
		} catch (error) {
			const code = error instanceof OAuthError ? error.code : "failed";
			failedAuth(ip, `typetorch.dev login (${error instanceof OAuthError ? `${error.code}: ${error.detail}` : "unexpected error"})`);
			return redirect(`/?login_error=${code}`, [clear]);
		}
		const listed = auth.roleOfRobloxUser(who.userId);
		if (!listed) {
			failedAuth(ip, `typetorch.dev login (user ${who.userId} is not an owner or a viewer)`);
			return redirect("/?login_error=not_owner", [clear]);
		}
		let role = listed;
		const cookies = [clear];
		let rotated: string | undefined;
		if (listed === "admin") {
			rotated = central.devices.use(readCookie(req, DEVICE_COOKIE), adminTokenHash);
			if (rotated) cookies.push(deviceCookie(req, rotated));
			else if (central.config.unblessed === "admin") {
				// TYPETORCH_CENTRAL_LOGIN_UNBLESSED=admin (the default): no device trust required; the owner list, both
				// signatures and the allow list already passed. The session is not tied to a device.
			} else if (central.config.unblessed === "refuse") {
				log(`login: typetorch.dev refused owner ${who.userId} from ${ip}: this device was never blessed (TYPETORCH_CENTRAL_LOGIN_UNBLESSED=refuse)`);
				return redirect("/?login_error=not_blessed", [clear]);
			} else role = "web";
		}
		// Never reuse a session id from before the login.
		sessions.destroy(readCookie(req, SESSION_COOKIE));
		authFailures.reset(ip);
		const deviceId = role === "admin" && rotated ? rotated.slice(0, rotated.indexOf(".")) : undefined;
		const id = sessions.create({ kind: "roblox", userId: who.userId, name: who.name, ...(who.displayName ? { displayName: who.displayName } : {}), ...(who.avatar ? { avatar: who.avatar } : {}), login: "typetorch.dev" }, role, undefined, deviceId);
		log(`login: typetorch.dev user ${who.userId} role ${role}${listed === "admin" ? (rotated ? " (blessed device)" : role === "admin" ? " (unblessed device, TYPETORCH_CENTRAL_LOGIN_UNBLESSED=admin)" : " (owner on a device that was never blessed: read-only)") : ""} from ${ip}`);
		return redirect("/", [...cookies, sessionCookie(req, id)]);
	}

	/**
	 * After a bless succeeds in a browser: when that same browser (its own session cookie) holds an owner's read-only
	 * typetorch.dev session, upgrade it to admin as a fresh login would. The bless proved the admin token or the game's
	 * signing key; the owner list is checked now. The old session id ends and a new one is issued (no fixation). Viewers,
	 * token and per-game Roblox sessions, and sessions of other browsers are never touched. Returns the new session cookie.
	 */
	function upgradeBlessedSession(req: Request, deviceValue: string, ip: string): string | undefined {
		const found = auth.cookieSession(req);
		if (!found) return undefined;
		const { session, cookie } = found;
		const user = session.user;
		if (session.role !== "web" || user.kind !== "roblox" || user.login !== "typetorch.dev") return undefined;
		if (auth.roleOfRobloxUser(user.userId) !== "admin") return undefined;
		const deviceId = deviceValue.slice(0, deviceValue.indexOf("."));
		sessions.destroy(cookie);
		const id = sessions.create(user, "admin", undefined, deviceId);
		log(`login: typetorch.dev user ${user.userId} upgraded to admin by blessing this browser from ${ip}`);
		return sessionCookie(req, id);
	}

	/** POST /auth/device { token }: the admin token once on this browser blesses it (sets the device cookie). */
	async function blessWithToken(req: Request, ip: string): Promise<Response> {
		if (!central) return centralOff();
		if (!adminIpOk(ip)) return notFound();
		// The browser takes the admin token only while the token login is on; otherwise `typetorch backend bless`.
		if (!runtime.get("tokenLogin")) return json(404, { error: "the token login is off on this server: bless this browser with `typetorch backend bless`" });
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		const problem = cookieMutationProblem(req, proxyOpts);
		if (problem) return json(403, { error: problem });
		if (!oauthLimiter.take(`device:${ip}`)) return tooMany(oauthLimiter.retryAfter(`device:${ip}`));
		if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json(415, { error: "send JSON: { token }" });
		const raw = await readCapped(req, 4096);
		let token: unknown;
		try {
			token = raw ? (JSON.parse(Buffer.from(raw).toString("utf8")) as { token?: unknown }).token : undefined;
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		if (typeof token !== "string" || !tokenIn(token, [config.adminToken])) {
			failedAuth(ip, "device blessing (admin token)");
			return json(401, { error: "wrong token" });
		}
		authFailures.reset(ip);
		const agent = agentLabel(req.headers.get("user-agent"));
		const value = central.devices.bless("admin token", { tokenHash: adminTokenHash, ...(agent ? { agent } : {}) });
		log(`device blessed with the admin token from ${ip}`);
		const upgraded = upgradeBlessedSession(req, value, ip);
		const res = json(200, { ok: true, blessed: true, ...(upgraded ? { upgraded: true } : {}) }, { "set-cookie": deviceCookie(req, value) });
		if (upgraded) res.headers.append("set-cookie", upgraded);
		return res;
	}

	/** GET /auth/bless/challenge: a one-time challenge for `typetorch backend bless` to sign with the game's signing key. */
	function blessChallenge(ip: string): Response {
		if (!central) return centralOff();
		if (!adminIpOk(ip)) return notFound();
		if (!central.blessKeys.size) return json(404, { error: "no signing keys are known here: the CLI sends them with PUT /v1/access/keys" });
		if (!oauthLimiter.take(`bless:${ip}`)) return tooMany(oauthLimiter.retryAfter(`bless:${ip}`));
		return json(200, { challenge: central.blessKeys.challenge(), fingerprint: central.key.fingerprint, expires_in: 300 });
	}

	/** GET /auth/bless?challenge=&sig=: the CLI's signed link, opened in the browser to bless; single use. */
	function blessWithLink(req: Request, url: URL, ip: string): Response {
		if (!central) return centralOff();
		if (!adminIpOk(ip)) return notFound();
		const blocked = blockedResponse(ip);
		if (blocked) return blocked;
		if (!oauthLimiter.take(`bless:${ip}`)) return tooMany(oauthLimiter.retryAfter(`bless:${ip}`));
		const ok = central.blessKeys.check(central.key.fingerprint, url.searchParams.get("challenge") ?? "", url.searchParams.get("sig") ?? "");
		if (!ok) {
			failedAuth(ip, "device blessing (signed link)");
			return redirect("/?login_error=bless");
		}
		const agent = agentLabel(req.headers.get("user-agent"));
		const value = central.devices.bless("signing key", agent ? { agent } : {});
		log(`device blessed with a signed link from ${ip}`);
		const upgraded = upgradeBlessedSession(req, value, ip);
		return redirect("/?blessed=1", [deviceCookie(req, value), ...(upgraded ? [upgraded] : [])]);
	}

	/** GET /api/typetorch/challenge/<token>: the origin challenge, answered only while a report is pending. */
	function originChallenge(token: string, ip: string): Response {
		if (!central || token.length > 128) return notFound();
		if (!challengeLimiter.take(ip)) return tooMany(challengeLimiter.retryAfter(ip));
		const answer = central.reporter.challengeAnswer(token);
		if (!answer) return notFound();
		return new Response(answer, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
	}

	/** PUT /v1/access/keys { keys } (the admin token only): the signing keys a blessing link may be signed with. */
	async function putBlessKeys(req: Request, principal: Principal): Promise<Response> {
		if (!central) return centralOff();
		if (principal.via !== "bearer") return json(403, { error: "the signing keys are set with the admin token (the CLI), not from the explorer" });
		const raw = await readCapped(req, 8 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: { keys?: unknown };
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8")) as { keys?: unknown };
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		try {
			const keys = central.blessKeys.put(body?.keys);
			log(`signing keys for device blessing updated: ${keys.length} key(s)`);
			return json(200, { keys });
		} catch (error) {
			return json(400, { error: (error as Error).message });
		}
	}

	/** PUT /v1/access (the admin token only: the CLI sends the signed access list's owners). */
	async function putAccess(req: Request, principal: Principal): Promise<Response> {
		if (principal.via !== "bearer") return json(403, { error: "the owner list is set with the admin token (the CLI), not from the explorer" });
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: unknown;
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8"));
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		try {
			const result = access.put(body);
			// Owners who were removed (or never were) lose their admin sessions at once (a viewer's web session stays).
			const ended = endStaleRobloxSessions();
			if (result.changed) log(`owner list updated to seq ${result.record.seq}: ${result.record.owners.length} owner(s)${ended ? `, ${ended} session(s) ended` : ""}`);
			return json(200, { ...result.record, changed: result.changed, sessionsEnded: ended });
		} catch (error) {
			if (error instanceof AccessError) return json(error.status, { error: error.message, ...(error.seq !== undefined ? { seq: error.seq } : {}) });
			throw error;
		}
	}

	// Runtime settings (the explorer's Settings page) -------------------------------------------------------------------

	/** Who is changing settings, for the audit list and the log: never a token; a Roblox name made safe. */
	function actorOf(principal: Principal & { role: "admin" }): SettingsActor {
		if (principal.via === "bearer") return { who: "admin token", via: "bearer" };
		if (principal.user.kind === "roblox") {
			// The username (Roblox allows letters, digits and _); the "Roblox user <id>" stand-in adds nothing.
			const raw = principal.user.name;
			const name = /^Roblox user \d+$/.test(raw) ? "" : raw.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
			return { who: `roblox user ${principal.user.userId}${name ? ` (${name})` : ""}`, via: "session" };
		}
		return { who: "admin token", via: "session" };
	}
	const isRobloxSession = (p: Principal & { role: "admin" }) => p.via === "cookie" && p.user.kind === "roblox";

	/** GET /v1/admin/settings: every editable setting (secrets as set / not set), the env-only names, the audit list. */
	function settingsView(ip: string, principal: Principal & { role: "admin" }): Record<string, unknown> {
		return {
			enabled: runtime.enabled,
			settings: runtime.view(),
			envOnly: [...ENV_ONLY],
			audit: runtime.audit(),
			// For the page's guards: the caller's address as this server sees it, and whether Roblox sign-in is usable.
			you: { ip, roblox: isRobloxSession(principal) },
			robloxSignIn: Boolean(oauth),
			// Read-only line on the Settings page: whether Sign in with typetorch.dev is on (set in the environment only).
			centralLogin: central ? { on: true, issuer: central.config.issuer, fingerprint: central.key.fingerprint, unblessed: central.config.unblessed, blessKeys: central.blessKeys.size } : { on: false },
		};
	}

	/** PATCH /v1/admin/settings { key: value | null }: checked, guarded, saved, applied at once. */
	async function patchSettings(req: Request, ip: string, principal: Principal & { role: "admin" }): Promise<Response> {
		if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json(415, { error: "send JSON: { key: value, ... }" });
		const raw = await readCapped(req, SETTINGS_BODY_MAX);
		if (!raw) return json(413, { error: "body too large" });
		let body: unknown;
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8"));
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		try {
			const result = runtime.patch(body, { ...actorOf(principal), ip, robloxSession: isRobloxSession(principal), robloxSignIn: Boolean(oauth) });
			// The token login turned off: browser sessions made with the token end too (the caller's is a Roblox session).
			// Viewers taken off the list lose their sessions at once.
			const sessionsEnded = (result.tokenLoginTurnedOff ? sessions.endWhere((s) => s.user.kind === "token") : 0) + (result.changed.includes("webViewers") ? endStaleRobloxSessions() : 0);
			return json(200, { ...settingsView(ip, principal), changed: result.changed, ...(sessionsEnded ? { sessionsEnded } : {}) });
		} catch (error) {
			if (error instanceof SettingsError) return json(error.status, { error: error.message, ...(error.key ? { key: error.key } : {}), ...(error.guard ? { guard: error.guard } : {}) });
			throw error;
		}
	}

	/** POST /v1/admin/settings/test-alert: one info alert through the current webhook. Answers a status, never the URL. */
	async function testAlert(principal: Principal & { role: "admin" }): Promise<Response> {
		if (!testAlertLimiter.take("test-alert")) return tooMany(testAlertLimiter.retryAfter("test-alert"));
		if (!notifier.configured) return json(409, { ok: false, error: "no alert webhook is set: save one first" });
		const actor = actorOf(principal);
		const at = clock();
		const alert: Alert = {
			id: 0,
			level: "info",
			code: "test_alert",
			message: "Test alert from the TypeTorch backend's Settings page: the webhook works.",
			job: null,
			branch: null,
			artifact: null,
			seq: null,
			generation: null,
			kernel: null,
			source: "server",
			details: null,
			createdAt: new Date(at).toISOString(),
			at,
			acked: false,
			ackedAt: null,
			ackedBy: null,
		};
		const result = await notifier.test(alert);
		runtime.recordTest(actor, result.ok ? `sent (HTTP ${result.status})` : `failed: ${result.error}`);
		return json(result.ok ? 200 : 502, result);
	}

	// Routing -----------------------------------------------------------------------------------------------------------

	/**
	 * The signed-in gate: allow list, failure limit, credentials (the admin or the web role), and the cookie's extra checks.
	 * Returns the principal or the answer.
	 */
	function readGate(req: Request, ip: string): { principal: SignedIn } | { response: Response } {
		if (!adminIpOk(ip)) return { response: notFound() };
		const blocked = blockedResponse(ip);
		if (blocked) return { response: blocked };
		// The lookup token is a right token for one route: refused here without counting as a failed login.
		if (auth.hasLookupBearer(req)) return { response: json(403, { error: LOOKUP_ONLY }) };
		const principal = auth.principal(req);
		if (!principal) {
			if (bearer(req) !== undefined) failedAuth(ip, "admin request");
			return { response: json(401, { error: "admin token required" }) };
		}
		if (principal.role === "game") return { response: json(401, { error: "admin token required (the API key can write, not read)" }) };
		if (principal.via === "cookie") {
			const problem = cookieMutationProblem(req, proxyOpts);
			if (problem) return { response: json(403, { error: problem }) };
		}
		// The web role reads: GET / HEAD, or one of the two read-only query POSTs. Decided here, by method, so no handler
		// has to remember it; the admin-only reads (the settings, storage, the debug audit) go through adminGate instead.
		if (principal.role === "web" && !READ_METHODS.has(req.method) && !WEB_POST_ALLOWED.test(routePath(req))) return { response: json(403, { error: READ_ONLY }) };
		return { principal };
	}

	/** The route of a request, with the explorer's /api prefix taken off (as `handle` does). */
	function routePath(req: Request): string {
		const path = new URL(req.url).pathname;
		return path.startsWith("/api/") ? path.slice(4) : path;
	}

	/** The admin gate: readGate, and the web role is refused (403): the route changes something, or is for owners. */
	function adminGate(req: Request, ip: string): { principal: Principal & { role: "admin" } } | { response: Response } {
		const gate = readGate(req, ip);
		if ("response" in gate) return gate;
		return gate.principal.role === "admin" ? { principal: gate.principal as Principal & { role: "admin" } } : { response: json(403, { error: READ_ONLY }) };
	}

	/** GET /openapi.json, /docs (+ its script), /llms.txt. Absolute links when TYPETORCH_PUBLIC_URL is set. */
	function docs(req: Request, path: string): Response {
		const o = { ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}), prefix: routePath(req) === new URL(req.url).pathname ? "" : "/api" };
		const text = (body: string, type: string, csp?: string) =>
			new Response(body, { status: 200, headers: { "content-type": type, "cache-control": "no-cache", ...(csp ? { "content-security-policy": csp } : {}) } });
		if (path === "/openapi.json") return json(200, openApiSpec(o), { "cache-control": "no-cache" });
		if (path === "/docs") return text(swaggerPage(), "text/html; charset=utf-8", DOCS_CSP);
		if (path === "/docs/swagger-init.js") return text(SWAGGER_INIT, "text/javascript; charset=utf-8");
		return text(llmsTxt(o), "text/markdown; charset=utf-8");
	}

	async function route(req: Request, url: URL, path: string, ip: string): Promise<Response> {
		const method = req.method;
		if (method === "OPTIONS") return json(405, { error: "no CORS here: use the same origin or a Bearer token" });
		if (path === "/healthz" && method === "GET") return health(req, ip);
		// The machine-readable docs (openapi.ts), for the allow list's addresses like the explorer.
		if (path === "/openapi.json" || path === "/docs" || path === "/docs/swagger-init.js" || path === "/llms.txt") {
			if (!adminIpOk(ip)) return notFound();
			if (method !== "GET" && method !== "HEAD") return json(405, { error: "GET only" });
			return docs(req, path);
		}

		// Open: who am I, log in and out, Sign in with Roblox.
		if (path === "/v1/auth/check") return method === "GET" ? authCheck(req, ip) : json(405, { error: "GET only" });
		if (path === "/v1/auth/login") return method === "POST" ? login(req, ip) : json(405, { error: "POST only" });
		if (path === "/v1/auth/logout") return method === "POST" ? logout(req) : json(405, { error: "POST only" });
		if (path === "/v1/auth/roblox/start") return method === "GET" ? robloxStart(req, ip) : json(405, { error: "GET only" });
		if (path === "/v1/auth/roblox/callback") return method === "GET" ? robloxCallback(req, url, ip) : json(405, { error: "GET only" });
		// Sign in with typetorch.dev, blessing a device, the origin challenge (404 while TYPETORCH_CENTRAL_LOGIN is off).
		if (path === `${CENTRAL_PATH}/start`) return method === "GET" ? centralStart(req, ip) : json(405, { error: "GET only" });
		if (path === `${CENTRAL_PATH}/callback`) return method === "GET" ? centralCallback(req, url, ip) : json(405, { error: "GET only" });
		if (path === "/auth/device") return method === "POST" ? blessWithToken(req, ip) : json(405, { error: "POST only" });
		if (path === "/auth/bless/challenge") return method === "GET" ? blessChallenge(ip) : json(405, { error: "GET only" });
		if (path === "/auth/bless") return method === "GET" ? blessWithLink(req, url, ip) : json(405, { error: "GET only" });
		if (path.startsWith("/typetorch/challenge/")) return method === "GET" ? originChallenge(path.slice("/typetorch/challenge/".length), ip) : json(405, { error: "GET only" });

		// Game routes (API key).
		if (path === "/v1/ingest") return method === "POST" ? ingest(req, ip) : json(405, { error: "POST only" });
		if (path === "/v1/errors" && method === "POST") return postErrors(req, ip);
		if (path === "/v1/identity" && method === "POST") return postIdentity(req, ip);
		if (path.startsWith("/v1/fleet/") && isRemoteDebugPath(path)) {
			if (!fleet || !remoteDebug) return json(404, { error: "the fleet part is off on this server" });
			return handleRemoteDebug(req, url, path, {
				hub: remoteDebug,
				fleet,
				isGame: (r) => auth.hasGameKey(r),
				badGameKey: (r) => badGameKey(r, ip, "remote debug"),
				admin: (r, need) => {
					const gate = need === "read" ? readGate(r, ip) : adminGate(r, ip);
					if ("response" in gate) return gate;
					const user = gate.principal.user;
					const caller: Caller = user.kind === "roblox" ? { kind: "roblox", userId: user.userId } : { kind: "token" };
					return { caller };
				},
				limiters: debugLimiters,
				...(waker?.enabled ? { waker } : {}),
				readCapped,
				keepOpen: (r) => keepOpen.get(r)?.(),
				ip,
			});
		}
		if (path.startsWith("/v1/fleet/")) {
			if (!fleet) return json(404, { error: "the fleet part is off on this server" });
			const gameWrite = method === "POST" && FLEET_GAME_ROUTES.has(path.slice("/v1/fleet/".length));
			let gate: ReturnType<typeof readGate> | undefined;
			if (!gameWrite) {
				// Reads (the lists, the streams) for every signed-in role; the alert ack for admins.
				gate = method === "GET" ? readGate(req, ip) : adminGate(req, ip);
				if ("response" in gate) return gate.response;
			} else if (!auth.hasGameKey(req)) return badGameKey(req, ip, "fleet");
			// Event streams are capped like /v1/live (each holds a connection and a listener).
			if (path === "/v1/fleet/stream" && method === "GET" && fleet.subscribers >= config.liveMaxClients) {
				return json(429, { error: "too many fleet streams open" }, { "retry-after": "10" });
			}
			// Per-JobId limits and a cap on never-seen JobIds, no per-IP limit: many game servers can share one egress IP.
			return (
				(await handleFleet(
					req,
					url,
					{
						service: fleet,
						isAdmin: () => gate !== undefined,
						isIngest: (r) => auth.hasGameKey(r),
						limiters: fleetLimiters,
						newJobs: newFleetJobs,
						keepOpen: (r) => keepOpen.get(r)?.(),
						accept: (topic, message) => bus.publish(topic, message as never),
						// Plans/25: a watched JobId's heartbeat reply wakes its kernel's debug poll.
						heartbeatReply: (job) => remoteDebug?.heartbeatReply(job),
						// A debug bundle's player logs (what each client logged) are for owners: the web role reads the rest.
						canReadPlayerLogs: () => gate !== undefined && "principal" in gate && gate.principal.role === "admin",
					},
					ip,
				)) ?? json(404, { error: "not found" })
			);
		}
		if (path === "/v1/erasure") return method === "POST" ? erasure(req, ip) : json(405, { error: "POST only" });
		// pid <-> UserId for the admin role and the lookup token (which reaches nothing else; readGate refuses it).
		if (path === "/v1/identity/resolve") return resolveIdentity(req, url, ip);

		// Everything else under /v1 reads (every signed-in role) or manages (admin only; `manage` answers 403 to the web role).
		if (path.startsWith("/v1/")) {
			const gate = readGate(req, ip);
			if ("response" in gate) return gate.response;
			const manage = (): (Principal & { role: "admin" }) | Response => (gate.principal.role === "admin" ? (gate.principal as Principal & { role: "admin" }) : json(403, { error: READ_ONLY }));
			// The server's own settings file and its disk: owners only (a viewer sees game data, never the server's configuration).
			if (path === "/v1/settings" && method === "GET") {
				const admin = manage();
				return admin instanceof Response ? admin : json(200, liveDials());
			}
			if (path === "/v1/queries" && method === "GET") return json(200, { queries: describeQueries() });
			if (path === "/v1/sql") return method === "POST" ? adhocSql(req) : json(405, { error: "POST only" });
			if (path === "/v1/storage" && method === "GET") {
				const admin = manage();
				if (admin instanceof Response) return admin;
				if (config.parts.has("analytics") && !warehouse) return analyticsUnavailable();
				return json(200, await storage());
			}
			if (path === "/v1/identity" && method === "GET") return getIdentity(url);
			if (path === "/v1/identity/backfill") {
				if (method !== "POST") return json(405, { error: "POST only" });
				const admin = manage();
				return admin instanceof Response ? admin : backfill(req);
			}
			const profile = /^\/v1\/identity\/([^/]+)\/profile$/.exec(path);
			if (profile) return method === "GET" ? playerProfile(profile[1], ip) : json(405, { error: "GET only" });
			if (path === "/v1/place") return method === "GET" ? placeCard(ip) : json(405, { error: "GET only" });
			if (path === "/v1/roblox/products") return method === "GET" ? productInfo(url, ip) : json(405, { error: "GET only" });
			const logs = /^\/v1\/roblox\/servers\/([^/]+)\/logs$/.exec(path);
			if (logs) return method === "GET" ? serverLogs(logs[1] as string, url, ip) : json(405, { error: "GET only" });
			if (path === "/v1/experiments") return method === "GET" ? experimentOverrides() : json(405, { error: "GET only" });
			if (path.startsWith("/v1/experiments/")) return method === "GET" ? experimentPlayersRead(path, url) : json(405, { error: "GET only" });
			const playerErrors = /^\/v1\/players\/([^/]+)\/errors$/.exec(path);
			if (playerErrors) {
				if (method !== "GET") return json(405, { error: "GET only" });
				const pid = playerErrors[1] as string;
				if (!PID_PATTERN.test(pid)) return json(400, { error: "bad pid" });
				if (warehouse?.isErased(pid)) return json(404, { error: "no such player" });
				return handlePlayerErrors(errors, pid, url, { now: clock(), keepDays: runtime.get("errorKeepDays") });
			}
			if ((path === "/v1/errors" || path.startsWith("/v1/errors/")) && method === "GET") return handleErrorReads(errors, url, { now: clock(), keepDays: runtime.get("errorKeepDays"), identify: playerIdentities });
			if (path === "/v1/admin/settings") {
				if (method !== "GET" && method !== "PATCH") return json(405, { error: "GET or PATCH only" });
				const admin = manage();
				if (admin instanceof Response) return admin;
				return method === "GET" ? json(200, settingsView(ip, admin)) : patchSettings(req, ip, admin);
			}
			if (path === "/v1/admin/stats") {
				if (method !== "GET") return json(405, { error: "GET only" });
				const admin = manage();
				if (admin instanceof Response) return admin;
				const window = parseStatsWindow(url.searchParams.get("window"));
				if (!window) return json(400, { error: `window must be one of ${STATS_WINDOWS.join(", ")}` });
				return json(200, { ...metrics.view(window), state: serverState(), version: PACKAGE.version, runtime: runtimeName() });
			}
			if (path === "/v1/admin/settings/test-alert") {
				if (method !== "POST") return json(405, { error: "POST only" });
				const admin = manage();
				return admin instanceof Response ? admin : testAlert(admin);
			}
			if (path === "/v1/live" && method === "GET") return live.connect(req, url, () => keepOpen.get(req)?.());
			// Sign in with typetorch.dev: blessed devices (list, revoke), the blessing keys, a report now. Owners only.
			if (path === "/v1/admin/devices" || path.startsWith("/v1/admin/devices/")) {
				const admin = manage();
				if (admin instanceof Response) return admin;
				if (!central) return centralOff();
				if (path === "/v1/admin/devices") {
					if (method !== "GET") return json(405, { error: "GET only" });
					return json(200, { devices: central.devices.list(central.devices.idOf(readCookie(req, DEVICE_COOKIE), adminTokenHash)) });
				}
				if (method !== "DELETE") return json(405, { error: "DELETE only" });
				const id = path.slice("/v1/admin/devices/".length);
				if (!/^[0-9a-f]{16}$/.test(id)) return json(400, { error: "bad device id" });
				if (!central.devices.revoke(id)) return json(404, { error: "no such device" });
				// The admin sessions that device opened end with it.
				const ended = sessions.endWhere((s) => s.device === id);
				log(`device ${id} revoked by ${actorOf(admin).who}${ended ? `; ${ended} session(s) ended` : ""}`);
				return json(200, { ok: true, sessionsEnded: ended, devices: central.devices.list(central.devices.idOf(readCookie(req, DEVICE_COOKIE), adminTokenHash)) });
			}
			if (path === "/v1/access/keys") {
				if (method !== "GET" && method !== "PUT") return json(405, { error: "GET or PUT only" });
				const admin = manage();
				if (admin instanceof Response) return admin;
				if (!central) return centralOff();
				return method === "GET" ? json(200, { keys: central.blessKeys.list() }) : putBlessKeys(req, admin);
			}
			if (path === "/v1/central/report") {
				if (method !== "POST") return json(405, { error: "POST only" });
				const admin = manage();
				if (admin instanceof Response) return admin;
				if (!central) return centralOff();
				const result = await central.reporter.report();
				return json(result === "ok" ? 200 : 502, { ok: result === "ok", fingerprint: central.key.fingerprint });
			}
			if (path === "/v1/access") {
				if (method !== "GET" && method !== "PUT") return json(405, { error: "GET or PUT only" });
				const admin = manage();
				if (admin instanceof Response) return admin;
				return method === "GET" ? json(200, access.get()) : putAccess(req, admin);
			}
			const q = /^\/v1\/query\/([A-Za-z-]+)$/.exec(path);
			if (q) return method === "POST" ? query(req, q[1]) : json(405, { error: "POST only" });
			const r = /^\/v1\/rollups\/(daily|players|edges|player_days)$/.exec(path);
			if (r && method === "GET") return rollups(url, r[1]);
			return notFound();
		}

		// The explorer (open to the allow list's addresses; its data still needs a signed-in role).
		if (site && adminIpOk(ip)) {
			const page = await site.serve(method, path);
			if (page) return page;
		}
		return notFound();
	}

	/** Requests running now (a stream counts until its Response is returned): stop() lets them finish. */
	let inflight = 0;

	async function handle(req: Request, peer = ""): Promise<Response> {
		const original = new URL(req.url);
		const ip = clientIp(req, peer, proxyTrust);
		// The explorer's base path is /api (its dev proxy strips it); take it off here too.
		let path = original.pathname;
		let url = original;
		if (path.startsWith("/api/")) {
			path = path.slice(4);
			url = new URL(original);
			url.pathname = path;
		}
		let response: Response;
		const started = performance.now();
		if (stopping) {
			// Stopping: nothing new starts (the next server takes it; the senders retry on 503).
			response = restarting();
		} else {
			inflight++;
			try {
				response = await route(req, url, path, ip);
			} catch (error) {
				log(`${req.method} ${path} failed: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
				response = json(500, { error: "internal error" });
			} finally {
				inflight--;
			}
		}
		metrics.request(req.method, path, response.status, performance.now() - started);
		const html = (response.headers.get("content-type") ?? "").startsWith("text/html");
		return withSecurityHeaders(response, { https: isHttps(req, proxyOpts), csp: html ? EXPLORER_CSP : API_CSP });
	}

	const served: Served = await serve({
		hostname: config.host,
		port: config.port,
		// Twice the ingest cap, so a body a bit over it gets a clear 413 from readCapped instead of a reset connection.
		maxRequestBodySize: config.maxBodyBytes * 2 + 64 * 1024,
		...(options.backend ? { backend: options.backend } : {}),
		fetch: (req, ctx) => {
			keepOpen.set(req, () => ctx.timeout(0));
			return handle(req, ctx.ip);
		},
		error: () => withSecurityHeaders(json(500, { error: "internal error" }), { https: false, csp: API_CSP }),
	});

	// Jobs: the loader every loadSeconds, the nightly export when the UTC day changes (and every 6 h for late rows), the
	// fleet sweep every 10 s, the erasure rewrite after each erasure and at start, the error-log prune hourly.
	const timers: ReturnType<typeof setInterval>[] = [];
	/** The warehouse's jobs: at start, or when a handover ends. */
	function startWarehouseJobs(w: Warehouse): void {
		let loading = false;
		let lastNightlyDay = -1;
		let lastNightlyAt = 0;
		const jobs = [
			setInterval(() => {
				if (loading) return;
				loading = true;
				w.load()
					.catch((e) => log(`loader failed: ${(e as Error).message}`))
					.finally(() => (loading = false));
			}, config.loadSeconds * 1000),
		];
		const nightlyCheck = () => {
			const now = clock();
			const day = Math.floor(now / DAY_MS);
			if (day === lastNightlyDay && now - lastNightlyAt < 6 * 3_600_000) return;
			// Five minutes past midnight, so the day's last batches are in.
			if (now - day * DAY_MS < 5 * 60_000 && lastNightlyDay !== -1) return;
			lastNightlyDay = day;
			lastNightlyAt = now;
			w.nightly().catch((e) => log(`nightly failed: ${(e as Error).message}`));
		};
		jobs.push(setInterval(nightlyCheck, 60_000));
		for (const t of jobs) t.unref?.();
		timers.push(...jobs);
		nightlyCheck();
		void w.rewriteErased().catch((e) => log(`erasure rewrite failed: ${(e as Error).message}`));
	}
	// The metrics sampler (memory, CPU, event loop lag) once a second; one reading now so the page never starts empty.
	metrics.sample();
	if (!options.manualJobs) {
		if (warehouse) startWarehouseJobs(warehouse);
		const jobs = [setInterval(() => void errors.prune().catch((e) => log(`error log prune failed: ${(e as Error).message}`)), 10 * 60_000), setInterval(() => metrics.sample(), 1000)];
		if (fleet) jobs.push(setInterval(() => void fleet.sweep().catch((e) => log(`fleet sweep failed: ${(e as Error).message}`)), 10_000));
		for (const t of jobs) t.unref?.();
		timers.push(...jobs);
	}
	// Sign in with typetorch.dev: the origin report right after the start (never awaited: the start never waits on
	// typetorch.dev), then daily; after a failure again in 10 minutes. POST /v1/central/report sends one now.
	let reportTimer: ReturnType<typeof setTimeout> | undefined;
	if (central && !options.manualJobs) {
		const next = (ms: number) => {
			if (stopping) return;
			reportTimer = setTimeout(() => void central.reporter.report().then((result) => next(result === "ok" ? 86_400_000 : 10 * 60_000)), ms);
			reportTimer.unref?.();
		};
		next(0);
	}

	// Rolling deploys ---------------------------------------------------------------------------------------------------
	// Coolify starts the new container while the old one still runs, both on the same volume, and DuckDB allows one process
	// per file. So a server that finds the files held starts anyway (handover: /healthz is 200, so the rolling update goes
	// on and stops the old container; fleet, error logs and auth work; analytics answers 503 + Retry-After) and opens
	// DuckDB as soon as the old one has let go (it closes on SIGTERM within seconds), then runs as usual.
	const retryMs = options.handoverRetryMs ?? HANDOVER_RETRY_MS;
	const scheduleHandover = () => {
		if (stopping) return;
		handover.timer = setTimeout(() => {
			handover.timer = undefined;
			handover.attempt = tryHandover()
				.catch((error) => giveUp(error instanceof Error ? error : new Error(String(error))))
				.finally(() => (handover.attempt = undefined));
		}, retryMs);
	};
	const giveUp = (error: Error) => {
		analytics = "failed";
		log(`error: ${error.message}`);
		options.onFatal?.(error);
	};
	async function tryHandover(): Promise<void> {
		let opened: Warehouse;
		try {
			opened = await openWarehouse();
		} catch (error) {
			if (stopping) return;
			const waited = Date.now() - handover.since;
			if (!(error instanceof DataFolderLocked)) return giveUp(new Error(`analytics could not open its data folder: ${((error as Error).message ?? String(error)).slice(0, 300)}`));
			if (waited >= config.handoverSeconds * 1000) {
				return giveUp(
					new Error(
						`gave up after ${Math.round(waited / 1000)} s waiting for ${error.file}: another process still holds it. Only one server may use a data folder: stop the other container or process using ${config.dataDir}, then restart this one (TYPETORCH_HANDOVER_SECONDS sets the wait)`,
					),
				);
			}
			if (Date.now() - handover.lastWarn >= HANDOVER_WARN_MS) {
				handover.lastWarn = Date.now();
				log(`warning: handover: still waiting for ${error.file} after ${Math.round(waited / 1000)} s (another process holds it); giving up after ${config.handoverSeconds} s`);
			}
			scheduleHandover();
			return;
		}
		if (stopping) {
			await opened.close();
			return;
		}
		attachWarehouse(opened);
		if (!options.manualJobs) startWarehouseJobs(opened);
		log(`handover: DuckDB is open after ${((Date.now() - handover.since) / 1000).toFixed(1)} s; analytics is on`);
		// The previous server is gone now; what it saved while both ran (the Settings page, the owner list) applies here too.
		const changed = runtime.reload();
		const listsChanged = access.reload() || changed.includes("webViewers");
		const ended = (listsChanged ? endStaleRobloxSessions() : 0) + (changed.includes("tokenLogin") && !runtime.get("tokenLogin") ? sessions.endWhere((s) => s.user.kind === "token") : 0);
		if (changed.length || ended) log(`handover: picked up what the previous server saved meanwhile${changed.length ? ` (settings: ${changed.join(", ")})` : ""}${ended ? `; ${ended} session(s) ended` : ""}`);
	}
	if (lockedAtStart) {
		// DuckDB's own words name the other process where it can ("Conflicting lock is held in ... (PID n)").
		const detail = lockedAtStart.detail.replace(/\s+/g, " ").slice(0, 300);
		log(
			`handover: ${lockedAtStart.file} is held by another process (the previous container of a rolling deploy?): the fleet, error logs and sign-in work now, analytics answers 503 until it lets go; trying every ${retryMs / 1000} s for up to ${config.handoverSeconds} s (${detail})`,
		);
		scheduleHandover();
	}
	// Plans/25 "Instant wake": one line at the start saying whether it is on (names only, never the key).
	if (waker) log(waker.describe());

	let stopped: Promise<void> | undefined;
	/**
	 * Stops promptly, so a deploy hands the data folder over within seconds: new requests get 503 + Retry-After, the
	 * running ones get up to STOP_DRAIN_MS, then the server closes; queued subscribers get a moment; the raw files are
	 * synced (the next server loads them), a running DuckDB job is interrupted after STOP_JOB_GRACE_MS, DuckDB is
	 * checkpointed and closed (its file locks go with it), then SQLite (WAL checkpoint).
	 */
	async function stopNow(): Promise<void> {
		stopping = true;
		if (handover.timer) clearTimeout(handover.timer);
		for (const t of timers) clearInterval(t);
		if (reportTimer) clearTimeout(reportTimer);
		live.stop();
		remoteDebug?.stop();
		const drainUntil = Date.now() + STOP_DRAIN_MS;
		while (inflight > 0 && Date.now() < drainUntil) await new Promise((done) => setTimeout(done, 20));
		await served.stop();
		// A handover attempt that is opening DuckDB right now closes what it opened (it sees `stopping`).
		await handover.attempt;
		// Queued subscribers get a moment to finish (a stuck webhook must not hold the shutdown).
		await bus.idle(2000);
		if (sandbox) await (await sandbox.catch(() => undefined))?.close();
		if (warehouse) await warehouse.close(STOP_JOB_GRACE_MS);
		// Alerts already handed to the webhook (each send has its own 5 s timeout), and wake publishes on their way.
		await Promise.race([Promise.all([notifier.flush(), waker?.idle()]), new Promise((done) => setTimeout(done, 2000))]);
		if (fleet) await fleet.close();
		else await sqlite.close();
	}

	return {
		port: served.port,
		get state() {
			return serverState();
		},
		get warehouse() {
			return warehouse;
		},
		...(fleet ? { fleet } : {}),
		notifier,
		settings: runtime,
		...(remoteDebug ? { remoteDebug } : {}),
		...(waker ? { waker } : {}),
		bus,
		errors,
		access,
		live,
		metrics,
		...(central ? { central: { fingerprint: central.key.fingerprint, report: () => central.reporter.report(), devices: central.devices } } : {}),
		sessionCount: () => sessions.size,
		sessions,
		handle,
		load: () => (warehouse ? warehouse.load() : Promise.resolve({ files: 0, rows: 0 })),
		nightly: () => (warehouse ? warehouse.nightly() : Promise.resolve({ days: [], pruned: 0, compacted: false })),
		stop() {
			stopped ??= stopNow();
			return stopped;
		},
	};
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Kept for callers that import the header name.
export { CSRF_HEADER };
