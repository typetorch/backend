/**
 * The machine-readable docs: an OpenAPI 3.1 spec of every route (GET /openapi.json), a Swagger UI page over it (GET /docs,
 * its script GET /docs/swagger-init.js) and an llms.txt for LLM agents (GET /llms.txt). Nothing here reads data or
 * settings: the spec is built from the route table below, the query names and the fleet post kinds.
 *
 * A new route goes into ROUTES (test/openapi.test.ts fails when app.ts has a path literal the spec doesn't cover).
 */
import { FLEET_LIMITS } from "../fleet/http.ts";
import { QUERIES, QUERY_NAMES } from "../queries/index.ts";
import { PACKAGE } from "../version.ts";

/** Who may call a route: the roles of README "Routes and roles". */
type Role = "game" | "admin" | "web" | "lookup" | "open" | "adminToken";

type Schema = Record<string, unknown>;

interface Param {
	name: string;
	in?: "query" | "path";
	description: string;
	schema?: Schema;
	required?: boolean;
}

interface Route {
	method: "get" | "post" | "put" | "patch" | "delete";
	path: string;
	tag: string;
	roles: Role[];
	summary: string;
	description?: string;
	params?: Param[];
	/** A JSON body: its schema (a description in `description` is enough for the loose ones). */
	body?: Schema;
	/** The success answer, when it isn't a plain 200 JSON object. */
	ok?: { status: number; description: string; contentType?: string };
}

const str = (description?: string): Schema => ({ type: "string", ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: "integer", ...(description ? { description } : {}) });
const obj = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true });
const arr = (items: Schema, description?: string): Schema => ({ type: "array", items, ...(description ? { description } : {}) });

const q = (name: string, description: string, schema: Schema = str()): Param => ({ name, in: "query", description, schema });
const p = (name: string, description: string, schema: Schema = str()): Param => ({ name, in: "path", description, schema, required: true });

const TIME = "unix ms (or seconds) or an ISO time";
const WINDOW: Param[] = [
	q("window", "a number and m, h or d (30m, 24h, 7d); the default 24h; ignored when `from` is set"),
	q("from", `the window's start: ${TIME}`),
	q("to", `the window's end (default now): ${TIME}`),
	q("branch", 'one branch ("(unknown)" for rows without one)'),
	q("build", 'one build (artifact id; "(unknown)" for rows without one)'),
	q("realm", "server or client", { type: "string", enum: ["server", "client"] }),
];
const JOB = p("jobId", "a game server's JobId");

const QUERY_TABLE = QUERY_NAMES.map((name) => `- \`${name}\`: ${QUERIES[name].summary} (default ${QUERIES[name].defaultDays} days)`).join("\n");

const ROUTES: Route[] = [
	// Open ------------------------------------------------------------------------------------------------------------
	{
		method: "get",
		path: "/healthz",
		tag: "meta",
		roles: ["open"],
		summary: "Health",
		description: "`{ ok }`; with the admin role also `state` (`ready`, `handover`, `failed`, `stopping`), memory, loader lag, row counts and the bus.",
	},
	{ method: "get", path: "/openapi.json", tag: "meta", roles: ["open"], summary: "This OpenAPI spec", description: "Served to the admin allow list's addresses (TYPETORCH_ADMIN_ALLOW_IPS), like the explorer." },
	{ method: "get", path: "/docs", tag: "meta", roles: ["open"], summary: "Swagger UI over this spec", ok: { status: 200, description: "an HTML page", contentType: "text/html" } },
	{ method: "get", path: "/docs/swagger-init.js", tag: "meta", roles: ["open"], summary: "The docs page's script", ok: { status: 200, description: "JavaScript", contentType: "text/javascript" } },
	{ method: "get", path: "/llms.txt", tag: "meta", roles: ["open"], summary: "What this server is, for LLM agents (llmstxt.org)", ok: { status: 200, description: "Markdown", contentType: "text/markdown" } },
	{
		method: "get",
		path: "/v1/auth/check",
		tag: "auth",
		roles: ["open"],
		summary: "Who am I",
		description:
			'`{ ok, role: "game" | "admin" | "web", via, user?, service, version, parts: { analytics, fleet }, dashboard?, untrustedOwner?, trustWithToken? }`; the lookup token gets `{ ok, role: "lookup", via, routes }`; `401 { login: { token, roblox, typetorch?, dashboard? } }` without valid credentials. Rate limited.',
	},
	{
		method: "post",
		path: "/v1/auth/login",
		tag: "auth",
		roles: ["open"],
		summary: "Explorer session from the admin token",
		description: "Sets the `tt_session` cookie. 404 while token login is off (runtime setting `tokenLogin`).",
		body: obj({ token: str("the admin token") }, ["token"]),
	},
	{ method: "post", path: "/v1/auth/logout", tag: "auth", roles: ["open"], summary: "End the explorer session" },
	{ method: "get", path: "/v1/auth/roblox/start", tag: "auth", roles: ["open"], summary: "Sign in with Roblox: start (redirect)", ok: { status: 302, description: "redirect to Roblox" } },
	{ method: "get", path: "/v1/auth/roblox/callback", tag: "auth", roles: ["open"], summary: "Sign in with Roblox: callback", ok: { status: 302, description: "redirect to the explorer" } },
	{
		method: "get",
		path: "/auth/typetorch/start",
		tag: "auth",
		roles: ["open"],
		summary: "Sign in with typetorch.dev: start",
		description: "404 while TYPETORCH_CENTRAL_LOGIN is off (so are the other /auth routes).",
		ok: { status: 302, description: "redirect to the dashboard" },
	},
	{ method: "get", path: "/auth/typetorch/callback", tag: "auth", roles: ["open"], summary: "Sign in with typetorch.dev: callback", ok: { status: 302, description: "redirect to the explorer" } },
	{
		method: "post",
		path: "/auth/device",
		tag: "auth",
		roles: ["open"],
		summary: "Trust this browser (device cookie)",
		description: "The admin token in the body and an `X-TypeTorch` header. `{ ok, blessed, upgraded? }`.",
		body: obj({ token: str("the admin token") }, ["token"]),
	},
	{ method: "get", path: "/auth/bless/challenge", tag: "auth", roles: ["open"], summary: "The CLI's signed trust link: challenge" },
	{ method: "get", path: "/auth/bless", tag: "auth", roles: ["open"], summary: "The CLI's signed trust link" },
	{
		method: "get",
		path: "/typetorch/challenge/{token}",
		tag: "auth",
		roles: ["open"],
		summary: "Origin challenge",
		description: "Only while an origin report is pending. Also reachable as /api/typetorch/challenge/<token>.",
		params: [p("token", "the challenge token")],
	},

	// Game (API key) ----------------------------------------------------------------------------------------------------
	{
		method: "post",
		path: "/v1/ingest",
		tag: "game",
		roles: ["game"],
		summary: "Analytics rows",
		description: "gzip JSON `{ events, recordings, identities? }` (README \"Row format\"). Appended to a raw file, then `202 { accepted, rejected }`.",
		body: obj({ events: arr(obj()), recordings: arr(obj()), identities: arr(obj()) }),
		ok: { status: 202, description: "`{ accepted, rejected }`" },
	},
	{
		method: "post",
		path: "/v1/errors",
		tag: "game",
		roles: ["game"],
		summary: "Error logs",
		body: obj({ j: str("JobId"), errors: arr(obj({ fp: str(), template: str(), stack: str(), count: int(), firstAt: int(), lastAt: int(), branch: str(), build: str(), realm: str(), pids: arr(str()) })) }),
	},
	{ method: "post", path: "/v1/identity", tag: "game", roles: ["game"], summary: "pid <-> UserId rows (Basin games)", body: obj({ identities: arr(obj({ pid: str(), uid: int(), t: int() })) }) },
	...Object.keys(FLEET_LIMITS).map(
		(kind): Route => ({
			method: "post",
			path: `/v1/fleet/${kind}`,
			tag: "game",
			roles: ["game"],
			summary: `Fleet ${kind}`,
			description:
				kind === "mark"
					? 'A chart mark from the CLI (`j` must be `"cli"`).'
					: kind === "bundle"
						? "A kernel debug bundle (512 KB at most, gzip allowed)."
						: `The kernel's ${kind} post (16 KB at most, gzip allowed). \`j\` is the JobId (or the \`x-tt-job\` header).`,
			body: obj({ j: str("the sender's JobId") }),
		}),
	),
	{ method: "get", path: "/v1/fleet/commands", tag: "game", roles: ["game"], summary: "Remote debug: a watched server's long-poll for commands" },
	{ method: "post", path: "/v1/fleet/results", tag: "game", roles: ["game"], summary: "Remote debug: command answers", body: obj({ j: str(), results: arr(obj()) }) },

	// Analytics -----------------------------------------------------------------------------------------------------------
	{ method: "get", path: "/v1/queries", tag: "analytics", roles: ["admin", "web"], summary: "The logical queries: name, summary, default range" },
	{
		method: "post",
		path: "/v1/query/{name}",
		tag: "analytics",
		roles: ["admin", "web"],
		summary: "Run a logical query",
		description: `\`{ result, ms }\`. \`filters\` and \`options\` per README "Queries"; \`options.uid\` stands in for \`pid\` on the per-player queries.\n\n${QUERY_TABLE}`,
		params: [p("name", "the query", { type: "string", enum: QUERY_NAMES })],
		body: obj({ filters: obj(), options: obj() }),
	},
	{
		method: "get",
		path: "/v1/rollups/{kind}",
		tag: "analytics",
		roles: ["admin", "web"],
		summary: "Nightly rollup tables",
		params: [
			p("kind", "the table", { type: "string", enum: ["daily", "players", "player_days", "edges"] }),
			q("from", `a date, or ${TIME} (widened to the days it touches)`),
			q("to", `a date, or ${TIME}`),
			q("pid", "one player (not for daily)"),
			q("limit", "rows, 1 to 10,000 (1,000)", int()),
		],
	},
	{
		method: "post",
		path: "/v1/sql",
		tag: "analytics",
		roles: ["admin", "web"],
		summary: "One read-only SELECT",
		description: "Runs in a sandbox over the warehouse's tables. 404 when TYPETORCH_SQL=0.",
		body: obj({ sql: str(), limit: int("rows at most") }, ["sql"]),
	},
	{
		method: "get",
		path: "/v1/experiments",
		tag: "analytics",
		roles: ["admin", "web"],
		summary: "Experiment overrides from data/settings.json",
		description: '`{ source: "settings-file" | "none" | "unreadable", experiments }`.',
	},
	{
		method: "get",
		path: "/v1/experiments/{key}/players",
		tag: "analytics",
		roles: ["admin", "web"],
		summary: "The players in one experiment",
		params: [p("key", "the experiment"), q("variant", "one variant"), q("limit", "at most 200", int()), q("from", TIME), q("to", TIME), q("window", "e.g. 7d")],
	},
	{ method: "get", path: "/v1/storage", tag: "analytics", roles: ["admin"], summary: "What the data folder holds" },
	{ method: "get", path: "/v1/settings", tag: "analytics", roles: ["admin"], summary: "Live dials from data/settings.json" },

	// Players and identities ----------------------------------------------------------------------------------------------
	{
		method: "get",
		path: "/v1/identity",
		tag: "players",
		roles: ["admin", "web"],
		summary: "pid <-> UserId",
		description: "`{ identities }` for `pid` or `uid`; without either `{ count, backfill }`.",
		params: [q("pid", "a pid"), q("uid", "a Roblox UserId")],
	},
	{ method: "post", path: "/v1/identity/backfill", tag: "players", roles: ["admin"], summary: "Identity backfill from the DataStore" },
	{
		method: "get",
		path: "/v1/identity/resolve",
		tag: "players",
		roles: ["admin", "lookup"],
		summary: "pid <-> UserId in bulk (the lookup token's only route)",
		description: "At most 100 ids. `{ byPid: [{ pid, uid | null }], byUid: [{ uid, pids }] }`. Ids only. 60 a minute per address.",
		params: [q("pid", "comma-separated pids (or repeat)"), q("uid", "comma-separated UserIds (or repeat)")],
	},
	{ method: "get", path: "/v1/identity/{pid}/profile", tag: "players", roles: ["admin", "web"], summary: "A pid's UserId, Roblox names and headshot", params: [p("pid", "a pid")] },
	{
		method: "post",
		path: "/v1/erasure",
		tag: "players",
		roles: ["admin"],
		summary: "Right to Erasure",
		description: "The Roblox webhook (signed by Roblox, no token), or the admin role erasing by pid.",
		body: obj(),
	},

	// Errors ----------------------------------------------------------------------------------------------------------------
	{
		method: "get",
		path: "/v1/errors",
		tag: "errors",
		roles: ["admin", "web"],
		summary: "Error kinds with counts",
		params: [...WINDOW, q("q", "search, at most 100 characters"), q("limit", "1 to 500 (100)", int()), q("bucket", "seconds, 60 to 86400", int())],
	},
	{ method: "get", path: "/v1/errors/{fp}", tag: "errors", roles: ["admin", "web"], summary: "One error kind", params: [p("fp", "the fingerprint"), ...WINDOW, q("bucket", "seconds, 60 to 86400", int())] },
	{ method: "get", path: "/v1/errors/{fp}/players", tag: "errors", roles: ["admin", "web"], summary: "The players who hit an error kind", params: [p("fp", "the fingerprint"), ...WINDOW, q("limit", "at most 200", int())] },
	{ method: "get", path: "/v1/players/{pid}/errors", tag: "errors", roles: ["admin", "web"], summary: "The error kinds one player hit", params: [p("pid", "a pid"), ...WINDOW, q("limit", "at most 200", int())] },

	// Fleet -----------------------------------------------------------------------------------------------------------------
	{
		method: "get",
		path: "/v1/fleet/servers",
		tag: "fleet",
		roles: ["admin", "web"],
		summary: "Live game servers (or gone ones)",
		params: [q("branch", "one branch"), q("maxAge", "seconds since the last heartbeat", int()), q("gone", "1: closed and lost servers instead"), q("limit", "with gone", int())],
	},
	{ method: "get", path: "/v1/fleet/servers/{jobId}", tag: "fleet", roles: ["admin", "web"], summary: "One server: heartbeats, debug state, offline history", params: [JOB] },
	{ method: "get", path: "/v1/fleet/servers/{jobId}/metrics", tag: "fleet", roles: ["admin", "web"], summary: "One server's TPS / memory / players history", params: [JOB, q("since", TIME)] },
	{ method: "get", path: "/v1/fleet/servers/{jobId}/bundles", tag: "fleet", roles: ["admin", "web"], summary: "One server's debug bundles", params: [JOB] },
	{ method: "get", path: "/v1/fleet/bundles/{id}", tag: "fleet", roles: ["admin", "web"], summary: "One debug bundle (the web role gets no playerLogs)", params: [p("id", "the bundle id")] },
	{
		method: "get",
		path: "/v1/fleet/deploys",
		tag: "fleet",
		roles: ["admin", "web"],
		summary: "Deploy history, newest first: { deploys, next }",
		params: [q("branch", "one branch"), q("before", "the page before this seq (the last page's next)", int()), q("limit", "rows (50, at most 100)", int())],
	},
	{ method: "get", path: "/v1/fleet/deploys/{seq}", tag: "fleet", roles: ["admin", "web"], summary: "One deploy: outcome, report, alerts, previous / next", params: [p("seq", "the deploy #seq", int())] },
	{ method: "get", path: "/v1/fleet/reports", tag: "fleet", roles: ["admin", "web"], summary: "Deploy reports", params: [q("seq", "a deploy #seq", int()), q("artifact", "an artifact id"), q("branch", "one branch")] },
	{
		method: "get",
		path: "/v1/fleet/alerts",
		tag: "fleet",
		roles: ["admin", "web"],
		summary: "Alerts",
		params: [q("since", TIME), q("level", "critical, warning or info", { type: "string", enum: ["critical", "warning", "info"] }), q("unacked", "1: unacknowledged only"), q("limit", "rows", int())],
	},
	{ method: "post", path: "/v1/fleet/alerts/{id}/ack", tag: "fleet", roles: ["admin"], summary: "Acknowledge an alert", params: [p("id", "the alert id", int())], body: obj({ by: str("who") }) },
	{
		method: "get",
		path: "/v1/fleet/marks",
		tag: "fleet",
		roles: ["admin", "web"],
		summary: "Chart marks: releases, kernel publishes, backup refreshes",
		params: [q("since", TIME), q("until", TIME), q("branch", "one branch"), q("kinds", "comma-separated kinds"), q("limit", "rows", int())],
	},
	{ method: "get", path: "/v1/fleet/stream", tag: "fleet", roles: ["admin", "web"], summary: "Server-Sent Events of fleet changes", ok: { status: 200, description: "an event stream", contentType: "text/event-stream" } },
	{ method: "post", path: "/v1/fleet/servers/{jobId}/watch", tag: "fleet", roles: ["admin"], summary: "Remote debug: watch a server", params: [JOB] },
	{ method: "post", path: "/v1/fleet/servers/{jobId}/commands", tag: "fleet", roles: ["admin"], summary: "Remote debug: queue a read-only command", params: [JOB], body: obj({ op: str(), args: obj() }, ["op"]) },
	{ method: "get", path: "/v1/fleet/servers/{jobId}/commands/{id}", tag: "fleet", roles: ["admin"], summary: "Remote debug: one command's answer", params: [JOB, p("id", "the command id")] },
	{ method: "get", path: "/v1/fleet/debug/audit", tag: "fleet", roles: ["admin"], summary: "Remote debug audit list" },

	// Roblox ------------------------------------------------------------------------------------------------------------------
	{ method: "get", path: "/v1/place", tag: "roblox", roles: ["admin", "web"], summary: "The game's name, live players and icon" },
	{
		method: "get",
		path: "/v1/roblox/products",
		tag: "roblox",
		roles: ["admin", "web"],
		summary: "Game pass and developer product names, prices and icons",
		params: [q("gamepass", "comma-separated ids"), q("product", "comma-separated ids")],
	},
	{
		method: "get",
		path: "/v1/roblox/servers/{jobId}/logs",
		tag: "roblox",
		roles: ["admin", "web"],
		summary: "Roblox's server logs for one JobId (Open Cloud)",
		params: [JOB, q("severity", "up to 8 comma-separated words"), q("search", "text"), q("order", "asc or desc", { type: "string", enum: ["asc", "desc"] }), q("pageToken", "the next page"), q("placeId", "when the fleet doesn't know it", int()), q("placeVersion", "when the fleet doesn't know it", int())],
	},

	// Live ----------------------------------------------------------------------------------------------------------------------
	{ method: "get", path: "/v1/live", tag: "live", roles: ["admin", "web"], summary: "Server-Sent Events of the event bus", ok: { status: 200, description: "an event stream", contentType: "text/event-stream" } },

	// Admin ---------------------------------------------------------------------------------------------------------------------
	{ method: "get", path: "/v1/admin/settings", tag: "admin", roles: ["admin"], summary: "Runtime settings: values, sources, bounds, audit list" },
	{ method: "patch", path: "/v1/admin/settings", tag: "admin", roles: ["admin"], summary: "Change runtime settings", description: "`{ key: value | null }` (null = back to the environment), applied at once, with lockout guards.", body: obj() },
	{ method: "post", path: "/v1/admin/settings/test-alert", tag: "admin", roles: ["admin"], summary: "Send one test alert through the saved webhook (3 a minute)" },
	{ method: "get", path: "/v1/admin/stats", tag: "admin", roles: ["admin"], summary: "The server's own metrics (the explorer's Backend stats page)", description: "Requests, DuckDB statements, rows in / loaded and SQLite reads / writes per second (the last 10 s), request latency p50 / p90 / p99, memory, CPU and event loop lag; per second for 2 min and per minute for 1 h; per route group over `window`; totals since start.", params: [q("window", "the route group table's window (default 5m)", { type: "string", enum: ["1m", "5m", "15m", "1h"] })] },
	{ method: "get", path: "/v1/access", tag: "admin", roles: ["admin"], summary: "The owner list" },
	{ method: "put", path: "/v1/access", tag: "admin", roles: ["adminToken"], summary: "Replace the owner list", body: obj({ seq: int(), owners: arr(int(), "UserIds") }, ["seq", "owners"]) },
	{ method: "get", path: "/v1/access/keys", tag: "admin", roles: ["admin"], summary: "The signing keys a trust link may use" },
	{ method: "put", path: "/v1/access/keys", tag: "admin", roles: ["adminToken"], summary: "Replace the trust link keys", body: obj({ keys: arr(str("base64 raw Ed25519 public key"), "4 at most") }, ["keys"]) },
	{ method: "get", path: "/v1/admin/devices", tag: "admin", roles: ["admin"], summary: "Trusted browsers" },
	{ method: "delete", path: "/v1/admin/devices/{id}", tag: "admin", roles: ["admin"], summary: "Revoke a trusted browser (ends its admin sessions)", params: [p("id", "16 hex characters")] },
	{ method: "post", path: "/v1/central/report", tag: "admin", roles: ["admin"], summary: "Send the origin report now" },
];

const TAGS = [
	["meta", "This server and its docs"],
	["auth", "Sessions and sign-in"],
	["game", "Writes from game servers and the CLI (the API key)"],
	["analytics", "Queries over the warehouse (DuckDB or Basin)"],
	["players", "Identities and erasure"],
	["errors", "Error logs"],
	["fleet", "Live game servers, deploy reports, alerts, remote debug"],
	["roblox", "Lookups at Roblox, done by the server"],
	["live", "The event bus"],
	["admin", "Managing this server (owners)"],
] as const;

const ROLE_TEXT: Record<Role, string> = {
	open: "open",
	game: "game (API key)",
	admin: "admin (admin token or an owner's session)",
	web: "web (read-only viewer session)",
	lookup: "lookup token",
	adminToken: "the admin token only (not a session)",
};

function security(roles: Role[]): Record<string, string[]>[] {
	if (roles.includes("open")) return [];
	const out: Record<string, string[]>[] = [];
	if (roles.includes("game")) out.push({ apiKey: [] });
	if (roles.includes("admin") || roles.includes("adminToken")) out.push({ adminToken: [] });
	if (roles.includes("admin") || roles.includes("web")) out.push({ session: [] });
	if (roles.includes("lookup")) out.push({ lookupToken: [] });
	return out;
}

function operation(r: Route): Schema {
	const ok = r.ok ?? { status: 200, description: "OK" };
	const responses: Record<string, Schema> = {
		[String(ok.status)]: { description: ok.description, ...(ok.status >= 300 && ok.status < 400 ? {} : { content: { [ok.contentType ?? "application/json"]: { schema: ok.contentType ? str() : obj() } } }) },
		"400": { $ref: "#/components/responses/Error" },
	};
	if (!r.roles.includes("open")) {
		responses["401"] = { $ref: "#/components/responses/Error" };
		responses["403"] = { $ref: "#/components/responses/Error" };
	}
	responses["404"] = { $ref: "#/components/responses/Error" };
	responses["429"] = { $ref: "#/components/responses/Error" };
	const roles = `Roles: ${r.roles.map((role) => ROLE_TEXT[role]).join(", ")}.`;
	return {
		tags: [r.tag],
		summary: r.summary,
		operationId: `${r.method}${r.path.replace(/\{([^}]+)\}/g, "By_$1").replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))}`,
		description: r.description ? `${roles}\n\n${r.description}` : roles,
		"x-roles": r.roles,
		...(r.params ? { parameters: r.params.map((x) => ({ name: x.name, in: x.in ?? "query", description: x.description, required: x.required ?? false, schema: x.schema ?? str() })) } : {}),
		...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: r.body } } } } : {}),
		security: security(r.roles),
		responses,
	};
}

export interface DocsOptions {
	/** The server's public origin (TYPETORCH_PUBLIC_URL); without it the spec's server is relative. */
	publicUrl?: string;
	/** "/api" when the request came through the explorer's prefix. */
	prefix?: string;
}

export function openApiSpec(o: DocsOptions = {}): Schema {
	const paths: Record<string, Record<string, Schema>> = {};
	for (const r of ROUTES) (paths[r.path] ??= {})[r.method] = operation(r);
	return {
		openapi: "3.1.0",
		info: {
			title: "TypeTorch backend",
			version: PACKAGE.version,
			summary: "Fleet status, analytics, error logs, an event bus and the web explorer for a TypeTorch game.",
			description:
				"One server for everything a TypeTorch game needs from the outside. Game servers write with the API key (`TYPETORCH_API_KEY`); the CLI and the explorer read and manage with the admin token (`TYPETORCH_ADMIN_TOKEN`); Roblox viewers get a read-only web session; `TYPETORCH_LOOKUP_TOKEN` reaches `GET /v1/identity/resolve` only. " +
				"Every route under /v1 is also reachable as /api/v1/... (the explorer's prefix). The full reference is the README: https://github.com/typetorch/backend#readme",
			license: { name: "MIT", identifier: "MIT" },
		},
		externalDocs: { description: "TypeTorch docs", url: "https://github.com/typetorch/docs" },
		servers: [{ url: `${o.publicUrl ?? ""}${o.prefix ?? ""}` || "/" }],
		tags: TAGS.map(([name, description]) => ({ name, description })),
		paths,
		components: {
			securitySchemes: {
				apiKey: { type: "http", scheme: "bearer", description: "The game API key (TYPETORCH_API_KEY, or the previous key): writes only." },
				adminToken: { type: "http", scheme: "bearer", description: "The admin token (TYPETORCH_ADMIN_TOKEN): reads and manages everything." },
				lookupToken: { type: "http", scheme: "bearer", description: "TYPETORCH_LOOKUP_TOKEN: GET /v1/identity/resolve only (for scripts and LLM agents)." },
				session: { type: "apiKey", in: "cookie", name: "tt_session", description: "An explorer session (admin for owners, web for viewers). A mutation from a cookie needs a same-origin request." },
			},
			responses: {
				Error: { description: "An error", content: { "application/json": { schema: obj({ error: str() }, ["error"]) } } },
			},
		},
	};
}

/** The Swagger UI page: the bundle and its CSS from jsDelivr, pinned with SRI; the init script from this origin. */
const SWAGGER_VERSION = "5.32.15";
const SWAGGER_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}`;
const SWAGGER_JS_SRI = "sha384-m7zaGj7MPzU+G4lz2eyy73GxK9bbRDr9bB2CSdj8wodg2wu/Wnt6wsoLP3JD+RS9";
const SWAGGER_CSS_SRI = "sha384-fgyWYkUAamzuI8mJFu/xpRP0JWCJRwkwUwsYDoOYVHUJ8NQE5cENn8ib3ppwFFSX";

/** The docs page's CSP: the explorer's, plus jsDelivr for the pinned Swagger UI files. */
export const DOCS_CSP =
	"default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function swaggerPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TypeTorch backend API</title>
<link rel="stylesheet" href="${SWAGGER_BASE}/swagger-ui.css" integrity="${SWAGGER_CSS_SRI}" crossorigin="anonymous">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER_BASE}/swagger-ui-bundle.js" integrity="${SWAGGER_JS_SRI}" crossorigin="anonymous"></script>
<script src="docs/swagger-init.js"></script>
</body>
</html>
`;
}

/** Relative to the page, so /docs and /api/docs both load their own spec. Same-origin requests carry the session cookie. */
export const SWAGGER_INIT = `window.ui = SwaggerUIBundle({ url: "openapi.json", dom_id: "#swagger-ui", deepLinking: true, persistAuthorization: false, withCredentials: true });\n`;

export function llmsTxt(o: DocsOptions = {}): string {
	const base = `${o.publicUrl ?? ""}${o.prefix ?? ""}`;
	return `# TypeTorch backend

> The self-hosted server behind a TypeTorch game (roblox-ts live updates for Roblox): live game-server status (the fleet API on SQLite), analytics (DuckDB on this server, or Cloudflare Basin), error logs, an in-process event bus with a live stream, remote debug of live servers, and the web explorer at /. This is version ${PACKAGE.version}.

Key facts for agents:
- The API is described by the OpenAPI spec below; read it instead of crawling the docs. Every /v1 route is also served as /api/v1/....
- Credentials are Bearer headers: the game API key writes only (game servers), the admin token reads and manages everything, the lookup token reaches \`GET /v1/identity/resolve\` only. An agent that only needs pid <-> UserId should get the lookup token, never the admin token.
- Never handle or ask for these secrets in chat; the operator sets them. Ask the operator to run any request that changes the server (settings, access, erasure, remote debug commands).
- For analytics, \`GET /v1/queries\` lists the logical queries and \`POST /v1/query/<name>\` runs one (\`{ filters, options }\`); \`POST /v1/sql\` runs one read-only SELECT.
- Privacy: the pid <-> UserId link joins a player's play history to their Roblox account. Don't paste resolved UserIds next to play history into chats, tickets or third-party tools.

## This server

- [OpenAPI spec](${base}/openapi.json): every route, its role and parameters (OpenAPI 3.1, JSON)
- [API docs](${base}/docs): Swagger UI over the spec
- [Health](${base}/healthz): \`{ ok }\`

## Docs

- [Backend README](https://github.com/typetorch/backend#readme): settings, security, routes and roles, the queries, the row format, deploying on Coolify or a VPS
- [Live servers and alerts guide](https://github.com/typetorch/docs/blob/main/guides/fleet-and-alerts.md): the fleet API from the game's side
- [Analytics guide](https://github.com/typetorch/docs/blob/main/guides/analytics.md): AnalyticsEngine, the event format, experiments, queries
- [TypeTorch docs](https://github.com/typetorch/docs): the framework, CLI, kernel and Studio workflow; its own [llms.txt](https://raw.githubusercontent.com/typetorch/docs/main/llms.txt)

## Optional

- [Source code](https://github.com/typetorch/backend): this server (MIT)
- [CLI](https://github.com/typetorch/cli): \`typetorch backend setup | run | bless\`, \`typetorch servers | report | alerts\`
`;
}
