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
import { NAME_MAX as SAVED_QUERY_NAME_MAX, PINNED_MAX, SAVED_QUERIES_MAX, SAVED_QUERY_CHARTS, WRITES_PER_MINUTE as SAVED_QUERY_WRITES } from "./saved-queries.ts";

/** Who may call a route: the roles of README "Routes and roles". */
type Role = "game" | "admin" | "web" | "lookup" | "open" | "adminToken" | "support" | "mobile";

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
	/** The success answer's JSON schema, when it is documented (default: any object). */
	response?: Schema;
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
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, description?: string): Schema => ({ type: [type, "null"], ...(description ? { description } : {}) });

/** The fleet's server shapes (fleet/service.ts serverInfo): the fields documented here, the rest stay open. */
const SCHEMAS: Record<string, Schema> = {
	MobileToken: {
		type: "object",
		description: "A new mobile app token: keep `token` in the phone's secure store; refresh it when fewer than 15 days remain.",
		required: ["token", "id", "expiresAt", "role", "user"],
		properties: {
			token: str("ttm_<id>_<secret>: the Bearer for every /v1 read and manage route of its role"),
			id: str("10 characters [0-9a-z]"),
			expiresAt: str("ISO time"),
			role: { type: "string", enum: ["admin", "web"] },
			user: obj({ kind: { type: "string", enum: ["token", "roblox"] }, userId: int(), name: str(), login: str("typetorch.dev when that login made it") }, ["kind"]),
		},
	},
	ServerLocation: {
		type: "object",
		description: "Where a server's latest address is, from the backend's offline IP database (city level at best). Credit the source GeoStatus names (DB-IP Lite: CC BY 4.0).",
		properties: {
			country: nullable("string", "ISO 3166-1 alpha-2"),
			countryName: nullable("string"),
			region: nullable("string", "the first subdivision (state, province)"),
			city: nullable("string"),
			lat: nullable("number"),
			lon: nullable("number"),
			asn: nullable("integer", "the autonomous system (with an ASN database)"),
			org: nullable("string", "the autonomous system's organization"),
		},
	},
	GeoStatus: {
		type: "object",
		description: "Whether locations can be shown: ready (a database is loaded), missing (on, no database yet), off (TYPETORCH_GEOIP=off); the source and the attribution its licence asks for.",
		properties: {
			state: { type: "string", enum: ["ready", "missing", "off"] },
			source: nullable("string"),
			attribution: nullable("string"),
			attributionUrl: nullable("string"),
			built: nullable("string", "ISO time the database was built"),
		},
		required: ["state"],
	},
	FleetServer: {
		type: "object",
		additionalProperties: true,
		description: "One game server (more fields than listed: branch, artifact, players, health, TPS, memory, budget, reasons...).",
		properties: {
			job: str("the JobId"),
			ip: nullable("string", "admin role only: the public address its heartbeats come from (latest; resolved through the trusted proxies / Cloudflare)"),
			firstIp: nullable("string", "admin role only: the first address it was seen from"),
			ipChangedAt: nullable("string", "ISO time the address last changed (null: never)"),
			location: { oneOf: [ref("ServerLocation"), { type: "null" }], description: "every signed-in role; null while unknown" },
			cv: { type: ["object", "null"], description: "plans/34: the game's custom column values (name -> string, number, bool or null); null when it declares none" },
		},
	},
};
const SAVED_ID = p("id", "the saved query's id", int());
const SAVED_QUERY_BODY = (required: string[]): Schema =>
	obj({ name: str(`1 to ${SAVED_QUERY_NAME_MAX} characters`), sql: str("one SELECT or WITH"), chart: { type: ["string", "null"], enum: [...SAVED_QUERY_CHARTS, null] }, pinned: { type: "boolean" } }, required);

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
			'`{ ok, role: "game" | "admin" | "web", via, user?, mobile?: { id, expiresAt }, service, version, parts: { analytics, fleet }, game: { universeId, label }, dashboard?, untrustedOwner?, trustWithToken? }`; the lookup token gets `{ ok, role: "lookup", via, routes }`; `401 { login: { token, roblox, typetorch?, dashboard? }, game: { universeId, label }, mobileLogin }` without valid credentials (`game.universeId`: TYPETORCH_UNIVERSE_ID or null; `mobileLogin`: the app\'s browser sign-in is on). Rate limited.',
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
	{
		method: "get",
		path: "/auth/mobile/start",
		tag: "auth",
		roles: ["open"],
		summary: "Mobile app sign-in: start (in the phone's browser)",
		description:
			"Keeps the app's request under a 10-minute HttpOnly cookie and redirects to this backend's browser login (typetorch.dev when on, else Sign in with Roblox). `redirect_uri` must be `typetorch://...` (Expo Go's `exp://` / `exps://` only on a host TYPETORCH_MOBILE_DEV_REDIRECTS allows: `on` = loopback and private-network addresses, else the listed host[:port]; such a sign-in gets the web role at most; no fragment); a bad request gets an HTML page, never a redirect. Rate limited per address, with the login lockout. After the login: the consent page.",
		params: [
			q("redirect_uri", "typetorch://... (where the code goes)"),
			q("state", "the app's state, 1 to 512 printable characters; sent back as is"),
			q("code_challenge", "PKCE: base64url SHA-256 of the verifier (43 characters)"),
			q("code_challenge_method", "S256", { type: "string", enum: ["S256"] }),
			q("device", "the device's name for the list (64 characters at most)"),
		],
		ok: { status: 302, description: "redirect to the browser login" },
	},
	{
		method: "get",
		path: "/auth/mobile/consent",
		tag: "auth",
		roles: ["open"],
		summary: "Mobile app sign-in: the consent page",
		description: "Who, which role, where the code goes (the redirect's host); the device name only as the app's own claim. `Referrer-Policy: same-origin`. Rate limited per address, with the login lockout.",
		ok: { status: 200, description: "an HTML page", contentType: "text/html" },
	},
	{
		method: "post",
		path: "/auth/mobile/consent",
		tag: "auth",
		roles: ["open"],
		summary: "Mobile app sign-in: Continue or Cancel (the page's form)",
		description: "Form fields `form` (the page's token; a wrong one counts toward the lockout) and `decision` (`allow` / `deny`), same origin (`Origin: null` is accepted: the form token and the SameSite=Lax cookie stop cross-site posts). Continue: `303` to `redirect_uri?code=<one-time, 60 s>&state=`; Cancel: `redirect_uri?error=access_denied&state=`. A failed or refused login sends `?error=<code>&state=` too.",
		ok: { status: 303, description: "redirect to the app" },
	},
	{
		method: "post",
		path: "/v1/auth/mobile/token",
		tag: "auth",
		roles: ["open"],
		summary: "Mobile app token from a sign-in code, or from the admin token",
		description:
			"`{ code, code_verifier }` (single-use code, PKCE S256) or the admin token as Bearer with `{ device }`. Answers `{ token, id, expiresAt, role, user }`; the token is shown only here. `400 { error: \"invalid_grant\" }` for a spent, expired or unknown code or a wrong verifier (counted toward the lockout).",
		body: obj({ code: str("the code from the redirect"), code_verifier: str("the PKCE verifier (43 to 128 characters)"), device: str("the device's name (admin token path)") }),
		response: ref("MobileToken"),
	},
	{
		method: "post",
		path: "/v1/auth/mobile/refresh",
		tag: "auth",
		roles: ["mobile"],
		summary: "A new mobile app token with a fresh expiry (the old one is revoked)",
		description:
			"`409 { code: \"mobile_refresh_in_progress\" }` while another refresh of the same token runs (only one new token is made); `403 { code: \"mobile_signin_too_old\" }` once the sign-in is TYPETORCH_MOBILE_TOKEN_MAX_DAYS old (no token outlives it: sign in again). A refreshed token presented again more than 10 s after its refresh revokes every token of its sign-in.",
		response: ref("MobileToken"),
	},
	{ method: "post", path: "/v1/auth/mobile/logout", tag: "auth", roles: ["mobile"], summary: "Revoke the calling mobile app token" },
	{
		method: "get",
		path: "/v1/auth/mobile/tokens",
		tag: "auth",
		roles: ["admin", "web"],
		summary: "Mobile app tokens (admins: all; the web role: its own)",
		description: "`{ tokens: [{ id, device, user, role, createdAt, expiresAt, lastUsedAt, revokedAt?, revokeReason?, current? }], lifetimeDays }`; no hash, no secret.",
		params: [q("all", "1: also revoked and expired tokens (kept 30 days)")],
	},
	{
		method: "post",
		path: "/v1/auth/mobile/tokens/revoke-all",
		tag: "auth",
		roles: ["admin"],
		summary: "Revoke every mobile app token (every phone signs out)",
		description: "`{ ok, revoked, tokens, lifetimeDays }`. Audited (`mobile.token.revoke-all`). Rotating the admin token ends only the tokens made with it; this ends the Roblox users' too.",
	},
	{
		method: "get",
		path: "/v1/mobile/live",
		tag: "auth",
		roles: ["mobile"],
		summary: "The game's live numbers for the mobile app's live watch and widgets",
		description:
			"`{ at, game: { name, universeId, iconUrl }, ccu, servers, delta, peakToday, series: [{ t, ccu }], lastHour: { at, avgSessionSeconds, medianSessionSeconds, sessionsEnded, playtimeHours } | null, metrics? }`. `ccu` and `servers`: the live fleet (GET /v1/fleet/servers' count); `delta`: vs about 5 minutes ago (null when unknown); `series`: one point a minute (5-minute rollup points before this server's start); `lastHour`: cached up to 5 minutes, null without analytics; `game.iconUrl`: the game's 256x256 icon on *.rbxcdn.com (kept 6 hours), null when unknown. " +
			"`metrics` only when `metrics=` is sent: `{ <id>: { value, prev, unit, label } | null }` in the order asked, `prev` the window right before (null when unknown), `unit` one of count, ratio (0..1), robux, seconds, hours. Ids: `ccu`, `servers`, `peakToday` (the fields above; `ccu`'s prev 5 minutes ago), `dau` / `wau` / `mau` (unique players, last 24 h / 7 d / 30 d), `new:<w>` (new players), `d1` / `d7` (retention of the latest complete join-day cohort; prev: the cohort the day before), `session:<w>` (mean length of the sessions that ended, seconds), `playtime:<w>` (time played, running sessions included, hours), `sessions:<w>` (sessions that ended), `revenue:<w>` (Robux players paid), `payers:<w>` (unique payers); windows `<n>h` (1..72) or `<n>d` (1..90). Unknown or invalid ids, and ids past the 12th, answer null (never a 400). Each number is cached 5 minutes (`mau`, `d7` 15). Aggregates only. 20 a minute per token.",
		params: [
			q("minutes", "the series' length, 1 to 360 (default 30)", { type: "integer", minimum: 1, maximum: 360 }),
			q("metrics", "widget stats, comma-separated ids (at most 12 answered, 1,000 characters at most): ccu, servers, peakToday, dau, wau, mau, d1, d7, new:<w>, session:<w>, playtime:<w>, sessions:<w>, revenue:<w>, payers:<w>; <w> is <n>h (1..72) or <n>d (1..90)"),
		],
	},
	{
		method: "post",
		path: "/v1/mobile/push",
		tag: "auth",
		roles: ["mobile"],
		summary: "Register this phone for push (one registration per mobile app token; a second call replaces it)",
		description: "`{ ok, milestones }`. Logout, revoke, revoke all and expiry remove it; a refresh moves it to the new token. The push token is never returned.",
		body: obj({ token: str("ExponentPushToken[...]"), milestones: { type: "boolean", description: "CCU milestone pushes on or off" } }, ["token", "milestones"]),
	},
	{ method: "delete", path: "/v1/mobile/push", tag: "auth", roles: ["mobile"], summary: "Remove this mobile app token's push registration" },
	{
		method: "post",
		path: "/v1/mobile/push/test",
		tag: "auth",
		roles: ["mobile"],
		summary: "Send one test push to this mobile app token's registration",
		description: '`{ ok, ticket: { status, error? } }` (Expo\'s ticket); `409 { error: "not_registered" }` without a registration; `502` when the push service can\'t be reached. 1 per 10 s per token.',
	},
	{ method: "delete", path: "/v1/auth/mobile/tokens/{id}", tag: "auth", roles: ["admin", "web"], summary: "Revoke a mobile app token (admins: any; the web role: its own)", params: [p("id", "10 characters [0-9a-z]")] },
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
		description: "gzip JSON `{ events, recordings, identities? }` (README \"Row format\"). Appended to a raw file, then `202 { accepted, rejected }`. While the backend is behind (raw backlog over `busyBytes`, more than `busyRequests` in flight): `503 { error: \"busy: ...\", busy: true }` with `Retry-After` 10-30 s, before the body is read.",
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
	{
		method: "post",
		path: "/v1/notify/intents",
		tag: "notify",
		roles: ["game"],
		summary: "Notification intents (want / drop / presence)",
		description: "`{ v: 1, items }`, at most 200 items and 256 KB. Answers `{ ok, accepted, rejected: [{ i, why }], stale }`; an item with an older `rev` is accepted and counted as stale.",
		body: obj({ v: int("1"), items: arr(obj({ op: str("want | drop | presence"), u: int("UserId"), k: str("kind"), key: str(), at: int("unix seconds"), until: int("unix seconds"), params: obj(), data: str(), template: str(), rev: int(), online: { type: "boolean" } })) }, ["v", "items"]),
	},
	{ method: "post", path: "/v1/notify/opened", tag: "notify", roles: ["game"], summary: "A verified notification open: first | repeat | unknown", body: obj({ nid: str(), u: int("UserId") }, ["nid", "u"]) },
	{ method: "post", path: "/v1/notify/played", tag: "notify", roles: ["game"], summary: "The session length after a notification open", body: obj({ nid: str(), u: int("UserId"), secs: int() }, ["nid", "u", "secs"]) },
	{ method: "get", path: "/v1/notify/config", tag: "notify", roles: ["admin"], summary: "The pushed notifications config: `{ config, updatedAt, by }`" },
	{ method: "put", path: "/v1/notify/config", tag: "notify", roles: ["admin"], summary: "Push the notifications config (typetorch.json `notifications`; validated, audited)", body: obj() },
	{ method: "get", path: "/v1/notify/status", tag: "notify", roles: ["admin"], summary: "Switches, kinds (with `halted`), the queue, the send rate, the last day's sends; never a key" },
	{
		method: "get",
		path: "/v1/notify/user",
		tag: "notify",
		roles: ["admin"],
		summary: "One player's notifications: consent (prompt rows, inferred state and when, mute), sends with opens and plays, intents",
		params: [q("uid", "a Roblox UserId"), q("pid", "a pid"), q("name", "a username or display name already in the name cache")],
	},
	{
		method: "get",
		path: "/v1/notify/recent",
		tag: "notify",
		roles: ["admin"],
		summary: "The newest sends of everyone, newest first (default 100, at most 500), with the cached username / display name",
		params: [q("limit", "1..500, default 100"), q("kind", "only this kind")],
	},
	{ method: "get", path: "/v1/admin/keys", tag: "admin", roles: ["admin"], summary: "Named API keys (plans/31): id, name, role, scopes, dates; built-in env tokens too; never a secret or hash", params: [q("all", "1 = include revoked keys")] },
	{ method: "post", path: "/v1/admin/keys", tag: "admin", roles: ["admin"], summary: "Create a named API key: `201 { id, key, name, role, scopes, createdAt, expiresAt }` (the key only here, once)", body: obj({ name: str(), role: str("game | lookup | support | analyst | admin"), expiresDays: int("1..3650") }, ["name", "role"]) },
	{ method: "delete", path: "/v1/admin/keys/{id}", tag: "admin", roles: ["admin"], summary: "Revoke a named API key (built-in ids answer 400)", params: [p("id", "the key id")] },
	{
		method: "get",
		path: "/v1/notify/users",
		tag: "notify",
		roles: ["admin"],
		summary:
			"The opt-in list (learned from Roblox's answer to a send): `{ counts: { subscribed, notSubscribed, unknown, muted, newThisWeek }, users: [{ userId, name, displayName, optin, optinAt, lastSeen, online, muteUntil, sends, opened }], next }`, or text/csv with format=csv (at most 10 000 rows)",
		params: [q("state", "subscribed (default) | not_subscribed | unknown | muted"), q("q", "a UserId or a cached username / display name"), q("limit", "1..200, default 50"), q("cursor", "the last page's next"), q("format", "csv")],
	},
	{ method: "put", path: "/v1/notify/keys", tag: "notify", roles: ["admin"], summary: "The launch-data signing keys `{ current, previous?, since }` (never returned or logged)", body: obj({ current: str(), previous: str(), since: int("unix seconds") }, ["current", "since"]) },
	{ method: "post", path: "/v1/notify/test", tag: "notify", roles: ["admin"], summary: "One send of a kind now, bypassing the caps (marked test): `{ nid, status }`", body: obj({ userId: int(), kind: str(), params: obj(), data: str() }, ["userId", "kind"]) },
	{ method: "post", path: "/v1/notify/send", tag: "notify", roles: ["admin"], summary: "A one-off send (kind custom; respects the mute and the day cap): `{ nid, status }` or `{ skipped }`", body: obj({ userId: int(), template: str(), params: obj(), data: str() }, ["userId", "template"]) },
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
	{
		method: "post",
		path: "/v1/fleet/streams",
		tag: "game",
		roles: ["game"],
		summary: "Plans/34: a watched server's stream samples (positions, game streams), memory only",
		description: "`{ j, frames: [{ t, s }] }`, at most 64 KB and 32 frames, each value at most 16 KB -> `{ ok, watch, lm, dropped? }`.",
		body: obj({ j: str(), frames: arr(obj({ t: int("unix ms"), s: obj() })) }, ["frames"]),
		response: obj({ ok: { type: "boolean" }, watch: { type: "boolean" }, lm: { type: "boolean" } }),
	},

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
		path: "/v1/saved-queries",
		tag: "analytics",
		roles: ["admin", "web"],
		summary: "Saved queries",
		description: "`{ queries: [{ id, name, sql, chart, pinned, createdBy, createdAt, updatedBy, updatedAt }] }` by name. Run one with `POST /v1/sql` (its SQL); `pinned` ones are the Overview's tiles.",
	},
	{
		method: "post",
		path: "/v1/saved-queries",
		tag: "analytics",
		roles: ["admin"],
		summary: "Save a query",
		description: `Checked like \`POST /v1/sql\`'s text (one SELECT / WITH), never run. At most ${SAVED_QUERIES_MAX} queries and ${PINNED_MAX} pinned; names unique ignoring case (409); ${SAVED_QUERY_WRITES} changes a minute per address.`,
		body: SAVED_QUERY_BODY(["name", "sql"]),
		ok: { status: 201, description: "`{ query }`" },
	},
	{ method: "get", path: "/v1/live-events", tag: "analytics", roles: ["admin", "web"], summary: "Scheduled live events with their status and sync state against the signed settings record, the schedule servers should hold (`game[\"tt.events\"]`) and the CLI commands that sign it", params: [q("refresh", "1 = read the signed record again (at most every 10 s)")] },
	{ method: "post", path: "/v1/live-events", tag: "analytics", roles: ["admin"], summary: "Schedule a live event: `201 { event, commands }`; the owner signs the new schedule with the CLI (the backend can't sign)", body: obj({ name: str("1-80 characters"), values: { type: "object", description: 'game keys -> JSON values, 1-8 keys: { "cash.multiplier": 2 }' }, start: str("unix ms or ISO time with a zone"), end: str("unix ms or ISO time with a zone"), note: str() }, ["name", "values", "start", "end"]) },
	{ method: "post", path: "/v1/live-events/{id}/cancel", tag: "analytics", roles: ["admin"], summary: "Cancel a scheduled or live event (servers drop it once the owner signs the new schedule)", params: [p("id", "ev_ + 10 characters")] },
	{ method: "get", path: "/v1/live-events/{id}/lift", tag: "analytics", roles: ["admin", "web"], summary: "An event's lift report: the event window against the same weekdays and hours of earlier weeks, the days after it (pull-forward), and a plain verdict", params: [p("id", "ev_ + 10 characters"), q("weeks", "baseline weeks, 1-8 (default 3)"), q("afterDays", "days after the event, 0-7 (default 3)")] },
	{ method: "get", path: "/v1/saved-queries/{id}", tag: "analytics", roles: ["admin", "web"], summary: "One saved query", params: [SAVED_ID] },
	{ method: "patch", path: "/v1/saved-queries/{id}", tag: "analytics", roles: ["admin"], summary: "Change a saved query (the fields given)", params: [SAVED_ID], body: SAVED_QUERY_BODY([]) },
	{ method: "delete", path: "/v1/saved-queries/{id}", tag: "analytics", roles: ["admin"], summary: "Delete a saved query", params: [SAVED_ID] },
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
	{
		method: "post",
		path: "/v1/experiments/{key}/change",
		tag: "analytics",
		roles: ["admin"],
		summary: "Prepare an experiment change: the signed CLI command that applies it",
		description:
			"`{ action: start | stop | split | settle | clear, weights?, variant?, variants? }` -> `{ command, dryRun, effect, notes }`. Audited. Applies nothing: the split lives in the game's signed settings, which only the owners' keys sign (`typetorch experiment ...`).",
		params: [p("key", "the experiment")],
		body: obj(),
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
	{
		method: "get",
		path: "/v1/players/by-uid/{uid}/events",
		tag: "players",
		roles: ["admin", "support"],
		summary: "One player's support rows (players:read): the allow-listed event names, newest first",
		description: "`{ uid, known, pids, rows: [{ t, name, kind, pid, job, props }], more }`; pids from identities; names outside `players.supportEvents` answer 403 `{ error: event_not_allowed, name }` unless admin. Audited (never the UserId).",
		params: [p("uid", "a Roblox UserId"), q("names", "comma list of event names (default: the allow-list)"), q("since", "unix ms (default: 30 days ago)", int()), q("before", "unix ms (default: now)", int()), q("limit", "1 to 100 (50)", int())],
	},
	{
		method: "get",
		path: "/v1/players/by-uid/{uid}/summary",
		tag: "players",
		roles: ["admin", "support"],
		summary: "One player's support summary (players:read): counts per allow-listed name, ac_flag by category, sessions, last seen",
		params: [p("uid", "a Roblox UserId"), q("since", "unix ms (default: 30 days ago)", int())],
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
		params: [...WINDOW, q("q", "search, at most 100 characters"), q("limit", "1 to 500 (100)", int()), q("sort", "count, lastAt, firstAt, total or realm; - in front for largest first (default -count)"), q("bucket", "seconds, 60 to 86400", int())],
	},
	{ method: "get", path: "/v1/errors/drop-rules", tag: "errors", roles: ["admin", "web"], summary: "Error drop rules: the saved expressions, drops per rule since the server started, parse errors" },
	{
		method: "post",
		path: "/v1/errors/drop-rules/preview",
		tag: "errors",
		roles: ["admin"],
		summary: "Whether a drop expression parses, and which stored error kinds it would have dropped",
		description: "`{ expr, days? }` (days 1-90, default 7). Rules are saved through PATCH /v1/admin/settings `errorDropRules`.",
		body: obj(),
	},
	{ method: "get", path: "/v1/errors/{fp}", tag: "errors", roles: ["admin", "web"], summary: "One error kind", params: [p("fp", "the fingerprint"), ...WINDOW, q("bucket", "seconds, 60 to 86400", int())] },
	{ method: "get", path: "/v1/errors/{fp}/players", tag: "errors", roles: ["admin", "web"], summary: "The players who hit an error kind", params: [p("fp", "the fingerprint"), ...WINDOW, q("limit", "at most 200", int())] },
	{ method: "get", path: "/v1/players/{pid}/errors", tag: "errors", roles: ["admin", "web"], summary: "The error kinds one player hit", params: [p("pid", "a pid"), ...WINDOW, q("limit", "at most 200", int())] },
	{ method: "get", path: "/v1/servers/{jobId}/errors", tag: "errors", roles: ["admin", "web"], summary: "The error kinds one game server reported", params: [JOB, ...WINDOW, q("limit", "at most 200", int())] },

	// Fleet -----------------------------------------------------------------------------------------------------------------
	{
		method: "get",
		path: "/v1/fleet/servers",
		tag: "fleet",
		roles: ["admin", "web"],
		summary: "Live game servers (or gone ones)",
		description: "`{ servers, players, byArtifact, byHealth, geo }` (gone=1: `{ servers }`). Each server's `location` goes to every signed-in role; its addresses (`ip`, `firstIp`) to the admin role only.",
		params: [q("branch", "one branch"), q("maxAge", "seconds since the last heartbeat", int()), q("gone", "1: closed and lost servers instead"), q("limit", "with gone", int())],
		response: obj({ servers: arr(ref("FleetServer")), players: int(), geo: ref("GeoStatus") }),
	},
	{
		method: "get",
		path: "/v1/fleet/servers/{jobId}",
		tag: "fleet",
		roles: ["admin", "web"],
		summary: "One server: heartbeats, debug state, offline history",
		description: "`{ server, state, history, debug, geo }`; the web role gets the server without `ip` / `firstIp`.",
		params: [JOB],
		response: obj({ server: { oneOf: [ref("FleetServer"), { type: "null" }] }, state: str("live, closed, lost, gone or unknown"), history: obj(), debug: obj(), geo: ref("GeoStatus") }),
	},
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
	{ method: "get", path: "/v1/fleet/reports", tag: "fleet", roles: ["admin", "web"], summary: "Deploy reports", description: "`behind` lists live servers (FleetServer); the web role gets them without `ip` / `firstIp`.", params: [q("seq", "a deploy #seq", int()), q("artifact", "an artifact id"), q("branch", "one branch")] },
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
	{ method: "get", path: "/v1/fleet/stream", tag: "fleet", roles: ["admin", "web"], summary: "Server-Sent Events of fleet changes", description: "A `server` event carries a FleetServer; the web role gets it without `ip` / `firstIp`.", ok: { status: 200, description: "an event stream", contentType: "text/event-stream" } },
	{ method: "post", path: "/v1/fleet/servers/{jobId}/watch", tag: "fleet", roles: ["admin"], summary: "Remote debug: watch a server", params: [JOB] },
	{ method: "post", path: "/v1/fleet/servers/{jobId}/commands", tag: "fleet", roles: ["admin"], summary: "Remote debug: queue a read-only command", params: [JOB], body: obj({ op: str(), args: obj() }, ["op"]) },
	{ method: "get", path: "/v1/fleet/servers/{jobId}/commands/{id}", tag: "fleet", roles: ["admin"], summary: "Remote debug: one command's answer", params: [JOB, p("id", "the command id")] },
	{ method: "get", path: "/v1/fleet/debug/audit", tag: "fleet", roles: ["admin"], summary: "Remote debug audit list" },
	{
		method: "get",
		path: "/v1/fleet/servers/{jobId}/streams",
		tag: "fleet",
		roles: ["admin"],
		summary: "Plans/34: one server's declared streams and commands, and its stream frames (the last 120 s, memory only)",
		params: [JOB, q("since", "frames after this sample time, unix ms", int())],
		response: obj({ declared: obj({ streams: arr(obj()), commands: arr(obj()) }), frames: arr(obj({ t: int(), s: obj() })) }),
	},
	{ method: "post", path: "/v1/fleet/live-map/watch", tag: "fleet", roles: ["admin"], summary: "Plans/34: the live map is open (repeat every 20 s; lapses after 60 s)", response: obj({ ok: { type: "boolean" }, until: int(), wake: { type: "boolean" } }) },
	{ method: "get", path: "/v1/fleet/live-map", tag: "fleet", roles: ["admin"], summary: "Plans/34: every live server's latest player positions", response: obj({ servers: arr(obj({ job: str(), branch: str(), artifact: str(), at: int(), players: arr(obj()) })) }) },
	{ method: "get", path: "/v1/fleet/columns", tag: "fleet", roles: ["admin", "web"], summary: "Plans/34: the game's custom fleet columns (the live servers' declarations)", response: obj({ columns: arr(obj({ n: str(), l: str(), t: str("string, number or bool") })) }) },

	// Roblox ------------------------------------------------------------------------------------------------------------------
	// Maps (plans/33) ------------------------------------------------------------------------------------------------------
	{
		method: "get",
		path: "/v1/maps",
		tag: "maps",
		roles: ["admin", "web"],
		summary: "Exported maps: bounds, part counts, place version, alignment, the export's state, out of date",
	},
	{
		method: "post",
		path: "/v1/maps/export",
		tag: "maps",
		roles: ["admin"],
		summary: "Export the maps' geometry (a read-only Luau Execution task; one at a time)",
		description: "Map names come from the events' `map` prop; `names` adds more. Needs OPENCLOUD_API_KEY (universe.place.luau-execution-session:read and :write) and TYPETORCH_UNIVERSE_ID.",
		body: obj({ names: arr(str(), "extra map names (at most 50)") }),
		ok: { status: 202, description: "the export started" },
	},
	{
		method: "get",
		path: "/v1/maps/{name}/geometry",
		tag: "maps",
		roles: ["admin", "web"],
		summary: "One map's geometry (binary TTMP, README \"Maps\"), with an ETag",
		params: [p("name", "the map name as the events spell it (case and punctuation ignored), or (lobby)"), q("v", "2: TTMP version 2 with the texture section (Decals, Textures, MaterialVariants) when the map has one; absent: version 1")],
		ok: { status: 200, description: "the map's parts", contentType: "application/octet-stream" },
	},
	{
		method: "put",
		path: "/v1/maps/{name}/override",
		tag: "maps",
		roles: ["admin"],
		summary: "A map's manual override: the model path and/or an offset",
		params: [p("name", "the map name")],
		body: obj({ path: str("an instance path, e.g. ReplicatedStorage.assets.maps.Mall"), offset: arr({ type: "number" }, "[x, y, z] studs") }),
	},
	{ method: "delete", path: "/v1/maps/{name}/override", tag: "maps", roles: ["admin"], summary: "Remove a map's override", params: [p("name", "the map name")] },
	// Images and animation clips (plans/36) -------------------------------------------------------------------------------
	{ method: "get", path: "/v1/images", tag: "maps", roles: ["admin", "web"], summary: "The image store's numbers: stored, blocked, failed, queued, downloading, backoff" },
	{
		method: "get",
		path: "/v1/images/{assetId}",
		tag: "maps",
		roles: ["admin", "web"],
		summary: "A Roblox image (from the public thumbnails API, stored once): 200 the PNG / WebP, 202 { state: pending } while it resolves, 404 { state: blocked | error | unknown }",
		params: [p("assetId", "the image's asset id (digits)")],
		ok: { status: 200, description: "the image, cached a year (immutable)", contentType: "image/png" },
	},
	{ method: "get", path: "/v1/anims", tag: "maps", roles: ["admin", "web"], summary: "The animation clip store: seen, exported, failed, waiting, the last pass, the default R6 ids" },
	{
		method: "get",
		path: "/v1/anims/{animationId}",
		tag: "maps",
		roles: ["admin", "web"],
		summary: "An animation clip: { id, length, looped, priority, rig, keyframes: [{ t, poses: { name: [qx, qy, qz, qw] } }], joints }; 404 { state: pending | failed } until exported",
		params: [p("animationId", "the animation's asset id, or a url-encoded rbxassetid://<id>")],
	},
	{
		method: "post",
		path: "/v1/anims/export",
		tag: "maps",
		roles: ["admin"],
		summary: "Run the animation pass (a read-only Luau Execution task loading the noted animation ids with KeyframeSequenceProvider)",
		description: "Also runs after every successful map export. Needs OPENCLOUD_API_KEY (universe.place.luau-execution-session:read and :write) and TYPETORCH_UNIVERSE_ID.",
		ok: { status: 202, description: "the pass started (200 { pass: null } when nothing waits)" },
	},

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

	{
		method: "get",
		path: "/v1/roblox/analytics/acquisition",
		tag: "roblox",
		roles: ["admin", "web"],
		summary: "Roblox's play-through rate, impressions and qualified plays (Open Cloud Analytics Query API)",
		params: [q("days", "7, 14 or 28 (default 7)", int())],
	},
	{
		method: "get",
		path: "/v1/roblox/demographics",
		tag: "roblox",
		roles: ["admin", "web"],
		summary: "Creator Hub's Demographics: daily active users per age group, gender, locale, country, platform and OS (Open Cloud Analytics Query API)",
		params: [q("from", "unix ms or ISO (default 28 days before to)"), q("to", "unix ms or ISO (default now)"), q("dev", "devices, comma-separated: Roblox's Platform"), q("players", "new or returning: Roblox's IsNewUser"), q("country", "ISO country codes, comma-separated: Roblox's Country (matched on the code or the English name)")],
	},

	// Live ----------------------------------------------------------------------------------------------------------------------
	{ method: "get", path: "/v1/live", tag: "live", roles: ["admin", "web"], summary: "Server-Sent Events of the event bus", ok: { status: 200, description: "an event stream", contentType: "text/event-stream" } },

	// Admin ---------------------------------------------------------------------------------------------------------------------
	{ method: "get", path: "/v1/admin/settings", tag: "admin", roles: ["admin"], summary: "Runtime settings: values, sources, bounds, audit list" },
	{ method: "patch", path: "/v1/admin/settings", tag: "admin", roles: ["admin"], summary: "Change runtime settings", description: "`{ key: value | null }` (null = back to the environment), applied at once, with lockout guards.", body: obj() },
	{ method: "post", path: "/v1/admin/settings/test-alert", tag: "admin", roles: ["admin"], summary: "Send one test alert through the saved webhook (3 a minute)" },
	{ method: "get", path: "/v1/admin/alert-rules", tag: "admin", roles: ["admin"], summary: "Backend alert rules: the state of each (ok, waiting, firing, off, unavailable), the last run, raised / deduped / throttled", description: "The rules themselves (on/off, level, thresholds) are the `backendAlerts` runtime setting. 404 without the fleet part." },
	{
		method: "get",
		path: "/v1/admin/audit",
		tag: "admin",
		roles: ["admin"],
		summary: "The audit log: who did what on the admin side, newest first",
		description: "Sign-ins (success and failure), sign-outs, lockouts, settings changes (old and new values; secrets as set / not set), owner and viewer changes, trusted browsers, alert acks, erasure, the identity backfill, backups, remote debug, release starts. `next` is the `before` of the next page.",
		params: [
			q("actor", "exactly as listed (`admin token`, `roblox user <id> (<name>)`, ...)"),
			q("action", "an action, or a prefix ending in `*` (`settings.*`)"),
			q("outcome", "ok, failed or refused", { type: "string", enum: ["ok", "failed", "refused"] }),
			q("since", TIME),
			q("until", TIME),
			q("before", "an entry id: the page before it", int()),
			q("limit", "1 to 500 (default 100)", int()),
			q("facets", "1 adds the actors and actions there are entries for"),
		],
	},
	{ method: "get", path: "/v1/admin/backups", tag: "admin", roles: ["admin"], summary: "Backups: the schedule, the last outcome and the local backups" },
	{ method: "post", path: "/v1/admin/backups", tag: "admin", roles: ["admin"], summary: "Make a local backup now (2 a minute)" },
	{
		method: "post",
		path: "/v1/admin/backups/download",
		tag: "admin",
		roles: ["admin"],
		summary: "Download a fresh backup as a tar (without the webhook URL and instance.key)",
		ok: { status: 200, description: "a tar stream", contentType: "application/x-tar" },
	},
	{ method: "get", path: "/v1/admin/stats", tag: "admin", roles: ["admin"], summary: "The server's own metrics (the explorer's Backend stats page)", description: "Requests, DuckDB statements, rows in / loaded and SQLite reads / writes per second (the last 10 s), request latency p50 / p90 / p99, memory, CPU and event loop lag; per second for 2 min and per minute for 1 h; per route group over `window`; totals since start; `ingest` { busy, inflight, lastBusyAt } (the busy 503s since start, ingest requests in flight).", params: [q("window", "the route group table's window (default 5m)", { type: "string", enum: ["1m", "5m", "15m", "1h"] })] },
	// Plans/35 A: the export API (the admin token as a Bearer only) and the migration job.
	{ method: "get", path: "/v1/admin/export/manifest", tag: "admin", roles: ["adminToken"], summary: "Export: every day with its rows and hash, the live rows, the SQLite tables' sizes, the erased count", description: "`{ version: 1, server: { instance, now }, tables: { events: [{ day, rows, hash }], recordings: [...] }, live: { day, rows, lastRt }, fleet: { <table>: { rows, maxId } }, erased }`; `hash` = the decimal string of `bit_xor(hash(<every stored column>))`. One export request at a time (429), 120 a minute." },
	{
		method: "get",
		path: "/v1/admin/export/rows",
		tag: "admin",
		roles: ["adminToken"],
		summary: "Export: one page of a day's rows (gzip NDJSON, the stored row format with rt)",
		description: "Headers `x-typetorch-rows`, `x-typetorch-pages`, and `x-typetorch-last-page: 1` on the last page. The day file first in its order, then the day's live rows ordered by every column.",
		params: [q("table", "events or recordings", { type: "string", enum: ["events", "recordings"] }), q("day", "YYYY-MM-DD (UTC)"), q("page", "from 0", int()), q("size", "rows a page, 1 to 50000", int())],
		ok: { status: 200, description: "gzip NDJSON", contentType: "application/x-ndjson" },
	},
	{ method: "get", path: "/v1/admin/export/hash", tag: "admin", roles: ["adminToken"], summary: "Export: rows and hash of one day without some pids", params: [q("table", "events or recordings", { type: "string", enum: ["events", "recordings"] }), q("day", "YYYY-MM-DD (UTC)"), q("exclude", "pids, comma separated")], response: obj({ rows: int(), hash: str() }) },
	{ method: "post", path: "/v1/admin/export/hash", tag: "admin", roles: ["adminToken"], summary: "Export: rows and hash of one day without some pids (a long list)", params: [q("table", "events or recordings", { type: "string", enum: ["events", "recordings"] }), q("day", "YYYY-MM-DD (UTC)")], body: obj({ exclude: arr(str(), "pids (at most 100,000)") }), response: obj({ rows: int(), hash: str() }) },
	{ method: "get", path: "/v1/admin/export/fleet", tag: "admin", roles: ["adminToken"], summary: "Export: a page of one SQLite table", params: [q("table", "deploys, marks, reports, alerts, server_metrics, error_kinds, error_counts, error_jobs, error_pids, identities, saved_queries, audit_log"), q("after", "the cursor (0 first)", int()), q("size", "1 to 5000", int())], response: obj({ rows: arr(obj()), next: nullable("integer") }) },
	{ method: "get", path: "/v1/admin/export/erased", tag: "admin", roles: ["adminToken"], summary: "Export: the erased pids", response: obj({ pids: arr(str()) }) },
	{ method: "get", path: "/v1/admin/migrate", tag: "admin", roles: ["admin"], summary: "The migration job's status: state, steps, the per-day report" },
	{
		method: "post",
		path: "/v1/admin/migrate",
		tag: "admin",
		roles: ["admin"],
		summary: "Start, pause, resume, cancel or resolve a move of analytics history (another server or Basin to here, here to Basin)",
		description:
			'`{ action: "start", from: { kind: "backend", url, token }, rowsPerSecond? }` (an old server and its admin token), `{ action: "start", from: { kind: "basin", accountId, bucket, token, namespace? } }` (Basin\'s tables through the Basin SQL API, the SQL token), `{ action: "start", to: { kind: "basin", events, recordings, token } }` (this server\'s history into Basin\'s streams, the send token). Tokens are sealed with instance.key, never echoed, logged or audited. `{ action: "pause" | "resume" | "cancel" }`; `{ action: "resolve", page, choice: "resend" | "skip" }` answers a page cut off mid-send to Basin (`needs_decision`; 409 otherwise). Answers the status.',
		body: obj({ action: { type: "string", enum: ["start", "pause", "resume", "cancel", "resolve", "status"] }, from: obj(), to: obj(), rowsPerSecond: int(), page: str("resolve: the page id the status names"), choice: { type: "string", enum: ["resend", "skip"] } }, ["action"]),
	},
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
	["maps", "Exported map geometry for the 2D and 3D maps (plans/33)"],
	["notify", "Experience notifications (plans/29): intents from game servers, the queue and sends for owners"],
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
	support: "a named key with players:read (support or admin role)",
	mobile: "a mobile app token only (ttm_...)",
};

function security(roles: Role[]): Record<string, string[]>[] {
	if (roles.includes("open")) return [];
	const out: Record<string, string[]>[] = [];
	if (roles.includes("game")) out.push({ apiKey: [] });
	if (roles.includes("admin") || roles.includes("adminToken")) out.push({ adminToken: [] });
	if (roles.includes("admin") || roles.includes("web")) out.push({ session: [] });
	if (roles.includes("admin") || roles.includes("web") || roles.includes("mobile")) out.push({ mobileToken: [] });
	if (roles.includes("lookup")) out.push({ lookupToken: [] });
	if (roles.includes("support")) out.push({ namedKey: [] });
	return out;
}

function operation(r: Route): Schema {
	const ok = r.ok ?? { status: 200, description: "OK" };
	const responses: Record<string, Schema> = {
		[String(ok.status)]: { description: ok.description, ...(ok.status >= 300 && ok.status < 400 ? {} : { content: { [ok.contentType ?? "application/json"]: { schema: ok.contentType ? str() : (r.response ?? obj()) } } }) },
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
				namedKey: { type: "http", scheme: "bearer", description: "A named API key `ttk_<id>_<secret>` (plans/31; POST /v1/admin/keys): a role (game, lookup, support, analyst, admin) and its scopes; a route outside them answers 403 { error: forbidden, need }." },
				mobileToken: {
					type: "http",
					scheme: "bearer",
					description: "A mobile app token (`ttm_<id>_<secret>`, 30 to 90 days): the admin or web role of the sign-in that made it, re-checked on every request. Never reaches the admin-token-only routes.",
				},
				session: { type: "apiKey", in: "cookie", name: "tt_session", description: "An explorer session (admin for owners, web for viewers). A mutation from a cookie needs a same-origin request." },
			},
			schemas: SCHEMAS,
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
