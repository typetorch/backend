/**
 * Backend settings from the environment and an optional env file (`--env-file <path>` or TYPETORCH_ENV_FILE; real
 * environment variables win). Values stay in this object and are never printed; only names are.
 *
 * Required: TYPETORCH_API_KEY (game servers write with it) and TYPETORCH_ADMIN_TOKEN (the CLI and the explorer read and
 * manage with it), 32+ characters each and different. Everything else is optional; the tuning knobs keep their defaults.
 * TYPETORCH_WEB_VIEWERS lists Roblox UserIds who get the read-only `web` role when they sign in with Roblox.
 * The names from before the rename (TT_ANALYTICS_*, TT_FLEET_*, TT_SERVER_PARTS, TYPETORCH_FLEET_*) are still read for
 * one release, each with a one-line warning that names the new one (`config.warnings`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FLEET_NEW_JOBS_PER_MINUTE } from "../fleet/http.ts";
import { applyLegacyEnv } from "../legacy-env.ts";
import { parseIpRules, type IpRule } from "./ipfilter.ts";

export type ServerPart = "analytics" | "fleet";

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/), for TYPETORCH_CLOUDFLARE=on;
 * TYPETORCH_CLOUDFLARE_IPS replaces the list. A range missing here only means that edge's address is taken as the client.
 */
export const CLOUDFLARE_IPS = [
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
] as const;

/** Shortest accepted API key and admin token. */
export const MIN_SECRET_LENGTH = 32;

export interface ServerConfig {
	dataDir: string;
	host: string;
	port: number;
	/** Which parts run: the DuckDB analytics API, the SQLite fleet API, or both (default). Error logs are always on. */
	parts: Set<ServerPart>;
	/** The API key game servers write with, then the previous one while it is rotated (accepted too). */
	apiKeys: string[];
	/** The admin token: reads and manages (the CLI, the explorer's token login). */
	adminToken: string;
	/**
	 * The lookup token (TYPETORCH_LOOKUP_TOKEN): reaches GET /v1/identity/resolve (pid <-> UserId) and nothing else, for
	 * scripts and LLM agents that must not hold the admin token. Undefined = that route takes the admin role only.
	 */
	lookupToken?: string;
	/** Roblox UserIds who may sign in with Roblox as read-only viewers (TYPETORCH_WEB_VIEWERS; the Settings page can add more). */
	webViewers: number[];
	/** Only these addresses may reach admin routes and the login (everything else gets 404). Undefined = any. */
	adminAllowIps?: IpRule[];
	/** Explorer login with the admin token (TYPETORCH_TOKEN_LOGIN=off hides and refuses it). */
	tokenLogin: boolean;
	/** Sign in with Roblox: the OAuth app's client id and secret. Both set = on. */
	robloxOAuth?: { clientId: string; clientSecret: string };
	/**
	 * Sign in with typetorch.dev (on by default; TYPETORCH_CENTRAL_LOGIN=off turns it off): the broker's origin, the
	 * role of an owner on a device that was never blessed, optional pinned key ids, optional pins of TypeTorch's Roblox
	 * client id and Roblox's discovery document (else read from <issuer>/.well-known/typetorch-login), and the label the
	 * origin report sends. Needs TYPETORCH_PUBLIC_URL over https (or http on loopback); without it the login stays off.
	 */
	centralLogin?: CentralLoginConfig;
	/** The public https URL of this backend (no trailing slash): OAuth redirect, Secure cookies, origin checks. */
	publicUrl?: string;
	/** Proxies in front whose X-Forwarded-For hops are trusted (0 = none: the TCP peer is the client). */
	trustProxy: number;
	/** TYPETORCH_TRUSTED_PROXIES: X-Forwarded-For is only read from these peers (undefined = from any peer). */
	trustedProxies?: IpRule[];
	/** TYPETORCH_CLOUDFLARE=on: Cloudflare's edge ranges, whose CF-Connecting-IP header names the client. */
	cloudflareIps?: IpRule[];
	/** The built explorer (web/dist) served at /; undefined = not served. */
	webDir?: string;
	/** Explorer sessions: idle and absolute lifetimes, ms. */
	sessionIdleMs: number;
	sessionMaxMs: number;
	/** Failed logins per IP before a 429 and the window they count in, ms. */
	loginMaxFailures: number;
	loginWindowMs: number;
	/** Concurrent GET /v1/live streams. */
	liveMaxClients: number;
	/** Bus: messages (and bytes) a queued subscriber may hold before it drops. */
	busMaxQueue: number;
	busMaxBytes: number;
	/** Error logs: days of per-minute counts kept, and the most error kinds stored. */
	errorKeepDays: number;
	errorMaxKinds: number;
	/** POST /v1/errors per address per minute (game servers share egress addresses, so it is generous). */
	errorsIpPerMinute: number;
	/** New error count and player rows per UTC day; past it new rows are dropped and counted (/healthz). */
	errorRowsPerDay: number;
	/** Days of audit log entries kept (server/audit.ts). */
	auditKeepDays: number;
	/** Local backups (server/backup.ts): where they go, how many are kept, hours between them (0 = no schedule). */
	backupDir: string;
	backupKeep: number;
	backupHours: number;
	/** Disk space (server/disk.ts): free percent under which the explorer warns and a `disk_low` alert is raised (0 = never). */
	diskWarnFreePercent: number;
	diskCriticalFreePercent: number;
	/** Gzip body cap and inflated cap, bytes. */
	maxBodyBytes: number;
	maxInflateBytes: number;
	ipPerMinute: number;
	jobPerMinute: number;
	// DuckDB
	memoryLimit: string;
	threads: number;
	loadSeconds: number;
	/** Days of day files to keep (0 = forever). */
	keepDays: number;
	rawKeepDays: number;
	/** Compact live.duckdb after the nightly export when it is bigger than this. */
	compactMb: number;
	queryTimeoutSeconds: number;
	queryConcurrency: number;
	fsyncMs: number;
	/** POST /v1/sql: read-only ad-hoc SQL for the admin token (on by default). */
	sql: boolean;
	/** memory_limit of the separate DuckDB instance that runs ad-hoc SQL. */
	sqlMemoryLimit: string;
	/**
	 * Rolling deploys: seconds to wait for the previous server to let go of the data folder's DuckDB files (meanwhile the
	 * fleet and error logs work and analytics answers 503) before giving up with an error.
	 */
	handoverSeconds: number;
	// Right to Erasure
	webhookSecret?: string;
	openCloudKey?: string;
	universeId?: number;
	erasureDeleteLink: boolean;
	/**
	 * Plans/25 "Instant wake": OPENCLOUD_API_KEY (needs universe-messaging-service:publish on the universe).
	 * With TYPETORCH_UNIVERSE_ID, a watch that starts on a server that isn't polling publishes a wake message. Env-only,
	 * never logged or returned.
	 */
	messagingKey?: string;
	// SQLite (fleet, identities, error logs, owners)
	fleetDb: string;
	alertWebhookUrl?: string;
	alertWebhookFormat?: "discord" | "slack" | "json";
	alertWebhookLevels: Set<"critical" | "warning" | "info">;
	/** Never-seen JobIds the fleet API accepts per minute (429 and one fleet_flood alert past it). */
	fleetNewJobsPerMinute: number;
	/** TYPETORCH_RUNTIME_SETTINGS (default on): values saved from the explorer's Settings page override the env; off = ignored. */
	runtimeSettings: boolean;
	/** Names (never values) of the variables that were set, so the Settings page can say "env" vs "default". */
	envSet: ReadonlySet<string>;
	/** One line per old variable name that was read: "OLD is deprecated: use NEW". Never holds a value. */
	warnings: string[];
}

export type CentralUnblessed = "admin" | "web" | "refuse";

export interface CentralLoginConfig {
	issuer: string;
	/** What an owner gets on a browser that was never blessed: admin (the default), web (read-only) or refused. */
	unblessed: CentralUnblessed;
	kids?: string[];
	/** TYPETORCH_ROBLOX_BROKER_CLIENT_ID: a pin; the broker's published value must equal it. */
	robloxClientId?: string;
	/** TYPETORCH_ROBLOX_BROKER_DISCOVERY: a pin; the broker's published value must equal it. */
	robloxDiscoveryUrl?: string;
	label: string;
}

/** The broker's default origin. */
export const CENTRAL_LOGIN_ISSUER = "https://dash.typetorch.dev";
/** A Roblox OAuth client id (public): the broker's, the `aud` of the Roblox ID tokens it passes on. */
export const ROBLOX_CLIENT_ID_PATTERN = /^[\w.-]{1,128}$/;

/** A discovery document URL: https, plain http only on loopback, no userinfo. Returns the normalized URL or undefined. */
export function discoveryUrlOf(value: string): string | undefined {
	if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return undefined;
	}
	const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
	if (u.username || u.password || !(u.protocol === "https:" || (loopback && u.protocol === "http:"))) return undefined;
	return u.toString();
}

/** An http(s) origin: https anywhere, plain http only on loopback. Returns `scheme://host[:port]` or undefined. */
export function originOf(value: string, allowLoopbackHttp = true): string | undefined {
	if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return undefined;
	}
	if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return undefined;
	const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
	if (u.protocol !== "https:" && !(allowLoopbackHttp && loopback && u.protocol === "http:")) return undefined;
	return `${u.protocol}//${u.host}`;
}

export function parseDotEnv(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2];
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) value = value.slice(1, value.lastIndexOf(quote));
		else value = value.replace(/\s+#.*$/, "").trim();
		values[match[1]] = value;
	}
	return values;
}

function num(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
	return n;
}

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];

function flag(env: Record<string, string | undefined>, name: string, fallback = false): boolean {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const v = raw.toLowerCase();
	if (TRUE.includes(v)) return true;
	if (FALSE.includes(v)) return false;
	throw new Error(`${name} is on or off (1/0, true/false, yes/no, on/off)`);
}

function secret(env: Record<string, string | undefined>, name: string, required: boolean): string | undefined {
	const raw = env[name];
	if (!raw) {
		if (required) throw new Error(`${name} is required: a random value of ${MIN_SECRET_LENGTH}+ characters (e.g. openssl rand -hex 32)`);
		return undefined;
	}
	if (raw.length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters (use a random value, e.g. openssl rand -hex 32)`);
	return raw;
}

/** Roblox UserIds the way lists of them arrive: a comma / whitespace separated string, or an array of numbers or digit strings. Sorted, no duplicates. */
export function parseUserIds(raw: string | readonly unknown[], max = 200): number[] {
	const parts = typeof raw === "string" ? raw.split(/[\s,]+/) : raw;
	const out: number[] = [];
	for (const part of parts) {
		if (typeof part === "string" && part.trim() === "") continue;
		const n = typeof part === "string" && /^\d{1,16}$/.test(part.trim()) ? Number(part.trim()) : part;
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new Error("entries are Roblox UserIds (positive whole numbers)");
		if (!out.includes(n)) out.push(n);
	}
	if (out.length > max) throw new Error(`at most ${max} UserIds`);
	return out.sort((a, b) => a - b);
}

/** An https URL that parses (the alert webhook; the value is never put in an error). */
export function isHttpsUrl(value: string): boolean {
	if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
	try {
		const u = new URL(value);
		return u.protocol === "https:" && u.hostname !== "";
	} catch {
		return false;
	}
}

/** Reads the config. `realEnv` defaults to process.env; an env file (if any) sits under it. */
export function loadConfig(argv: string[] = process.argv.slice(2), realEnv: Record<string, string | undefined> = process.env): ServerConfig {
	const at = argv.indexOf("--env-file");
	const nonEmpty = Object.fromEntries(Object.entries(realEnv).filter(([, v]) => v !== undefined && v !== ""));
	const first = applyLegacyEnv(nonEmpty);
	const envFile = at >= 0 ? argv[at + 1] : first.env.TYPETORCH_ENV_FILE;
	const fileEnv = envFile ? parseDotEnv(readFileSync(resolve(envFile), "utf8")) : {};
	const fromFile = applyLegacyEnv(fileEnv);
	// The real environment wins over the file; legacy names in the file lose to new names anywhere.
	const merged = { ...fromFile.env, ...first.env };
	const warnings = [...first.warnings, ...fromFile.warnings.map((w) => `${w} (in the env file)`)];

	// TT_ANALYTICS_INGEST_TOKENS was a comma-separated list: every entry stays accepted.
	const legacyList = (nonEmpty.TT_ANALYTICS_INGEST_TOKENS ?? fileEnv.TT_ANALYTICS_INGEST_TOKENS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	if (legacyList.length) {
		if (merged.TYPETORCH_API_KEY) warnings.push("TT_ANALYTICS_INGEST_TOKENS is ignored because TYPETORCH_API_KEY is set; remove it");
		else {
			warnings.push("TT_ANALYTICS_INGEST_TOKENS is deprecated: use TYPETORCH_API_KEY (and TYPETORCH_API_KEY_PREVIOUS while rotating)");
			merged.TYPETORCH_API_KEY = legacyList[0];
			if (legacyList[1] && !merged.TYPETORCH_API_KEY_PREVIOUS) merged.TYPETORCH_API_KEY_PREVIOUS = legacyList[1];
		}
	}
	const env = merged;

	const apiKey = secret(env, "TYPETORCH_API_KEY", true) as string;
	const previous = secret(env, "TYPETORCH_API_KEY_PREVIOUS", false);
	const adminToken = secret(env, "TYPETORCH_ADMIN_TOKEN", true) as string;
	if (apiKey === adminToken) throw new Error("TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN must be different values (the API key lives in game servers; the admin token must not)");
	if (previous && previous === adminToken) throw new Error("TYPETORCH_API_KEY_PREVIOUS must differ from TYPETORCH_ADMIN_TOKEN");
	// Further keys of an old comma list stay accepted for the release the old names are read.
	const apiKeys = [apiKey, ...(previous ? [previous] : []), ...legacyList.slice(2)].filter((k, i, all) => all.indexOf(k) === i);
	for (const key of apiKeys) {
		if (key.length < MIN_SECRET_LENGTH) throw new Error(`each TT_ANALYTICS_INGEST_TOKENS entry must be at least ${MIN_SECRET_LENGTH} characters`);
		if (key === adminToken) throw new Error("an API key equals TYPETORCH_ADMIN_TOKEN; they must be different values");
	}
	const lookupToken = secret(env, "TYPETORCH_LOOKUP_TOKEN", false);
	if (lookupToken && (lookupToken === adminToken || apiKeys.includes(lookupToken))) throw new Error("TYPETORCH_LOOKUP_TOKEN must differ from TYPETORCH_ADMIN_TOKEN and every API key");
	let webViewers: number[];
	try {
		webViewers = parseUserIds(env.TYPETORCH_WEB_VIEWERS ?? "");
	} catch (error) {
		throw new Error(`TYPETORCH_WEB_VIEWERS: ${(error as Error).message}`);
	}

	const dataDir = resolve(env.TYPETORCH_DATA_DIR ?? "data");
	const parts = new Set<ServerPart>(
		(env.TYPETORCH_PARTS ?? "analytics,fleet")
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean) as ServerPart[],
	);
	for (const p of parts) if (p !== "analytics" && p !== "fleet") throw new Error('TYPETORCH_PARTS lists "analytics" and/or "fleet"');
	if (parts.size === 0) throw new Error("TYPETORCH_PARTS is empty");
	const universe = env.TYPETORCH_UNIVERSE_ID;
	if (env.TYPETORCH_ALERT_WEBHOOK_URL && !isHttpsUrl(env.TYPETORCH_ALERT_WEBHOOK_URL)) throw new Error("TYPETORCH_ALERT_WEBHOOK_URL must be an https:// URL");
	const format = env.TYPETORCH_ALERT_WEBHOOK_FORMAT;
	if (format && !["discord", "slack", "json"].includes(format)) throw new Error("TYPETORCH_ALERT_WEBHOOK_FORMAT is discord, slack or json");
	const levels = new Set(
		(env.TYPETORCH_ALERT_WEBHOOK_LEVELS ?? "critical")
			.split(",")
			.map((l) => l.trim())
			.filter(Boolean),
	) as Set<"critical" | "warning" | "info">;

	// TYPETORCH_TRUST_PROXY: on/off, or the number of proxy hops in front (Coolify's Traefik = 1).
	const trustRaw = env.TYPETORCH_TRUST_PROXY;
	let trustProxy = 0;
	if (trustRaw !== undefined && trustRaw !== "") {
		if (/^\d{1,2}$/.test(trustRaw)) trustProxy = Number(trustRaw);
		else trustProxy = flag(env, "TYPETORCH_TRUST_PROXY") ? 1 : 0;
	}

	let publicUrl: string | undefined;
	if (env.TYPETORCH_PUBLIC_URL) {
		let u: URL;
		try {
			u = new URL(env.TYPETORCH_PUBLIC_URL);
		} catch {
			throw new Error("TYPETORCH_PUBLIC_URL must be a URL, e.g. https://backend.example.com");
		}
		if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("TYPETORCH_PUBLIC_URL must start with https:// (http:// is for local runs)");
		if (u.username || u.password) throw new Error("TYPETORCH_PUBLIC_URL must not hold credentials");
		publicUrl = `${u.protocol}//${u.host}`;
	}

	let trustedProxies: IpRule[] | undefined;
	if (env.TYPETORCH_TRUSTED_PROXIES) {
		try {
			trustedProxies = parseIpRules(env.TYPETORCH_TRUSTED_PROXIES);
		} catch (error) {
			throw new Error(`TYPETORCH_TRUSTED_PROXIES: ${(error as Error).message}`);
		}
		if (!trustedProxies.length) trustedProxies = undefined;
	}
	let cloudflareIps: IpRule[] | undefined;
	if (flag(env, "TYPETORCH_CLOUDFLARE")) {
		try {
			cloudflareIps = parseIpRules(env.TYPETORCH_CLOUDFLARE_IPS ?? CLOUDFLARE_IPS.join(","));
		} catch (error) {
			throw new Error(`TYPETORCH_CLOUDFLARE_IPS: ${(error as Error).message}`);
		}
	}
	const host = env.HOST ?? "127.0.0.1";
	if (trustProxy > 0 && !trustedProxies && !["127.0.0.1", "::1", "localhost"].includes(host)) {
		warnings.push(
			`TYPETORCH_TRUST_PROXY is on and HOST=${host}: only the proxy may reach port ${env.PORT ?? 8787} (no published port, no Coolify "Ports Mappings"), or any client can choose its address; TYPETORCH_TRUSTED_PROXIES=<the proxy's addresses> enforces it`,
		);
	}
	if (env.TYPETORCH_API_KEY_PREVIOUS) warnings.push("TYPETORCH_API_KEY_PREVIOUS is set: the old API key still works; remove it once every game server uses TYPETORCH_API_KEY");

	let adminAllowIps: IpRule[] | undefined;
	if (env.TYPETORCH_ADMIN_ALLOW_IPS) {
		try {
			adminAllowIps = parseIpRules(env.TYPETORCH_ADMIN_ALLOW_IPS);
		} catch (error) {
			throw new Error(`TYPETORCH_ADMIN_ALLOW_IPS: ${(error as Error).message}`);
		}
		if (!adminAllowIps.length) adminAllowIps = undefined;
	}

	const oauthId = env.ROBLOX_OAUTH_CLIENT_ID;
	const oauthSecret = env.ROBLOX_OAUTH_CLIENT_SECRET;
	if (Boolean(oauthId) !== Boolean(oauthSecret)) warnings.push("Sign in with Roblox is off: ROBLOX_OAUTH_CLIENT_ID and ROBLOX_OAUTH_CLIENT_SECRET must both be set");
	if (oauthId && oauthSecret && !publicUrl) warnings.push("Sign in with Roblox is off: set TYPETORCH_PUBLIC_URL (the redirect is <public url>/v1/auth/roblox/callback)");
	const robloxOAuth = oauthId && oauthSecret && publicUrl ? { clientId: oauthId, clientSecret: oauthSecret } : undefined;

	// Sign in with typetorch.dev: on by default (TYPETORCH_CENTRAL_LOGIN=off turns it off). It only actually turns on with
	// an https public URL (http on loopback); otherwise it stays off with a warning and the backend starts as usual.
	let centralLogin: CentralLoginConfig | undefined;
	if (flag(env, "TYPETORCH_CENTRAL_LOGIN", true)) {
		const issuer = originOf(env.TYPETORCH_CENTRAL_LOGIN_ISSUER ?? CENTRAL_LOGIN_ISSUER);
		if (!issuer) throw new Error("TYPETORCH_CENTRAL_LOGIN_ISSUER must be an origin: https://host[:port] (plain http only for localhost / 127.0.0.1), no path");
		// admin (default): an owner gets admin on any browser; web / refuse require a blessed (trusted) browser for admin.
		const unblessed = (env.TYPETORCH_CENTRAL_LOGIN_UNBLESSED || "admin").trim().toLowerCase();
		if (unblessed !== "admin" && unblessed !== "web" && unblessed !== "refuse") throw new Error("TYPETORCH_CENTRAL_LOGIN_UNBLESSED is admin, web or refuse");
		const kids = (env.TYPETORCH_CENTRAL_LOGIN_KIDS ?? "")
			.split(",")
			.map((k) => k.trim())
			.filter(Boolean);
		if (kids.some((k) => !/^[\w.-]{1,128}$/.test(k))) throw new Error("TYPETORCH_CENTRAL_LOGIN_KIDS lists key ids (letters, digits, . _ -), comma separated");
		// Optional pins: by default both come from <issuer>/.well-known/typetorch-login.
		const clientId = env.TYPETORCH_ROBLOX_BROKER_CLIENT_ID || undefined;
		if (clientId && !ROBLOX_CLIENT_ID_PATTERN.test(clientId)) throw new Error("TYPETORCH_ROBLOX_BROKER_CLIENT_ID must be a Roblox OAuth client id");
		let discovery: string | undefined;
		if (env.TYPETORCH_ROBLOX_BROKER_DISCOVERY) {
			discovery = discoveryUrlOf(env.TYPETORCH_ROBLOX_BROKER_DISCOVERY);
			const loopbackIssuer = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(issuer).hostname);
			if (!discovery || (!loopbackIssuer && !discovery.startsWith("https:"))) throw new Error("TYPETORCH_ROBLOX_BROKER_DISCOVERY must be an https URL (plain http only for localhost / 127.0.0.1, with a local issuer)");
		}
		const label = (env.TYPETORCH_CENTRAL_LOGIN_LABEL ?? (publicUrl ? new URL(publicUrl).host : "")).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64);
		if (!publicUrl) warnings.push("Sign in with typetorch.dev is off: set TYPETORCH_PUBLIC_URL (the callback is <public url>/auth/typetorch/callback)");
		else if (!originOf(publicUrl)) warnings.push("Sign in with typetorch.dev is off: TYPETORCH_PUBLIC_URL must be https (plain http only for localhost / 127.0.0.1)");
		else centralLogin = { issuer, unblessed: unblessed as CentralUnblessed, label: label || "TypeTorch backend", ...(kids.length ? { kids } : {}), ...(clientId ? { robloxClientId: clientId } : {}), ...(discovery ? { robloxDiscoveryUrl: discovery } : {}) };
	}

	// The explorer: TYPETORCH_WEB_DIR, else web/dist next to src/ (or dist/) when it has been built.
	let webDir: string | undefined;
	if (flag(env, "TYPETORCH_EXPLORER", true)) {
		const dir = resolve(env.TYPETORCH_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)));
		if (existsSync(resolve(dir, "index.html"))) webDir = dir;
	}

	const config: ServerConfig = {
		dataDir,
		host,
		port: num(env, "PORT", 8787, 0, 65535),
		parts,
		apiKeys,
		adminToken,
		...(lookupToken ? { lookupToken } : {}),
		webViewers,
		tokenLogin: flag(env, "TYPETORCH_TOKEN_LOGIN", true),
		trustProxy,
		sessionIdleMs: num(env, "TYPETORCH_SESSION_IDLE_HOURS", 12, 0.01, 24 * 30) * 3_600_000,
		sessionMaxMs: num(env, "TYPETORCH_SESSION_MAX_DAYS", 7, 0.01, 90) * 86_400_000,
		loginMaxFailures: num(env, "TYPETORCH_LOGIN_MAX_FAILURES", 5, 1, 1000),
		loginWindowMs: num(env, "TYPETORCH_LOGIN_WINDOW_MINUTES", 15, 0.01, 24 * 60) * 60_000,
		liveMaxClients: num(env, "TYPETORCH_LIVE_MAX_CLIENTS", 20, 1, 1000),
		busMaxQueue: num(env, "TYPETORCH_BUS_MAX_QUEUE", 1000, 1, 1_000_000),
		busMaxBytes: num(env, "TYPETORCH_BUS_MAX_BYTES", 8 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
		errorKeepDays: num(env, "TYPETORCH_ERROR_KEEP_DAYS", 30, 1, 3650),
		errorMaxKinds: num(env, "TYPETORCH_ERROR_MAX_KINDS", 5000, 10, 1_000_000),
		errorsIpPerMinute: num(env, "TYPETORCH_ERRORS_IP_PER_MINUTE", 1200, 1, 1_000_000),
		errorRowsPerDay: num(env, "TYPETORCH_ERROR_ROWS_PER_DAY", 2_000_000, 1000, 1_000_000_000),
		auditKeepDays: num(env, "TYPETORCH_AUDIT_KEEP_DAYS", 365, 1, 36_500),
		backupDir: resolve(env.TYPETORCH_BACKUP_DIR ?? resolve(dataDir, "backups")),
		backupKeep: num(env, "TYPETORCH_BACKUP_KEEP", 3, 1, 100),
		backupHours: num(env, "TYPETORCH_BACKUP_HOURS", 24, 0, 24 * 365),
		diskWarnFreePercent: num(env, "TYPETORCH_DISK_WARN_PERCENT", 15, 0, 99),
		diskCriticalFreePercent: num(env, "TYPETORCH_DISK_CRITICAL_PERCENT", 5, 0, 99),
		maxBodyBytes: num(env, "TYPETORCH_MAX_BODY", 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
		maxInflateBytes: num(env, "TYPETORCH_MAX_INFLATE", 16 * 1024 * 1024, 1024, 256 * 1024 * 1024),
		ipPerMinute: num(env, "TYPETORCH_IP_PER_MINUTE", 6000, 1, 1_000_000),
		jobPerMinute: num(env, "TYPETORCH_JOB_PER_MINUTE", 60, 1, 100_000),
		memoryLimit: env.TYPETORCH_MEMORY_LIMIT ?? "400MB",
		threads: num(env, "TYPETORCH_THREADS", 2, 1, 64),
		loadSeconds: num(env, "TYPETORCH_LOAD_SECONDS", 5, 0.2, 3600),
		keepDays: num(env, "TYPETORCH_KEEP_DAYS", 400, 0, 100_000),
		rawKeepDays: num(env, "TYPETORCH_RAW_KEEP_DAYS", 14, 0, 100_000),
		compactMb: num(env, "TYPETORCH_COMPACT_MB", 256, 1, 1_000_000),
		queryTimeoutSeconds: num(env, "TYPETORCH_QUERY_TIMEOUT", 60, 1, 3600),
		queryConcurrency: num(env, "TYPETORCH_QUERY_CONCURRENCY", 2, 1, 16),
		fsyncMs: num(env, "TYPETORCH_FSYNC_MS", 1000, 0, 60_000),
		sql: flag(env, "TYPETORCH_SQL", true),
		sqlMemoryLimit: env.TYPETORCH_SQL_MEMORY ?? "256MB",
		handoverSeconds: num(env, "TYPETORCH_HANDOVER_SECONDS", 600, 1, 86_400),
		erasureDeleteLink: flag(env, "TYPETORCH_ERASURE_DELETE_LINK"),
		fleetDb: resolve(env.TYPETORCH_SQLITE ?? resolve(dataDir, "fleet.sqlite")),
		alertWebhookLevels: levels,
		fleetNewJobsPerMinute: num(env, "TYPETORCH_NEW_JOBS_PER_MINUTE", FLEET_NEW_JOBS_PER_MINUTE, 1, 1_000_000),
		runtimeSettings: flag(env, "TYPETORCH_RUNTIME_SETTINGS", true),
		envSet: new Set(Object.keys(env).filter((name) => env[name] !== undefined && env[name] !== "")),
		warnings,
	};
	if (adminAllowIps) config.adminAllowIps = adminAllowIps;
	if (trustedProxies) config.trustedProxies = trustedProxies;
	if (cloudflareIps) config.cloudflareIps = cloudflareIps;
	if (robloxOAuth) config.robloxOAuth = robloxOAuth;
	if (publicUrl) config.publicUrl = publicUrl;
	if (centralLogin) config.centralLogin = centralLogin;
	if (webDir) config.webDir = webDir;
	if (env.ROBLOX_WEBHOOK_SECRET) config.webhookSecret = env.ROBLOX_WEBHOOK_SECRET;
	if (env.OPENCLOUD_API_KEY) config.openCloudKey = env.OPENCLOUD_API_KEY;
	// The instant wake (plans/25) publishes with OPENCLOUD_API_KEY (it needs universe-messaging-service:publish).
	const messagingKey = env.OPENCLOUD_API_KEY;
	if (messagingKey) {
		// Never put the value in an error or a warning.
		if (apiKeys.includes(messagingKey) || messagingKey === adminToken) throw new Error("OPENCLOUD_API_KEY must be an Open Cloud API key, not TYPETORCH_API_KEY or TYPETORCH_ADMIN_TOKEN");
		// It also serves the erasure path, so a value that doesn't look like a key only turns the wake off.
		if (/^[\x21-\x7e]{16,4096}$/.test(messagingKey)) config.messagingKey = messagingKey;
		else warnings.push("OPENCLOUD_API_KEY doesn't look like an Open Cloud API key (16-4096 printable characters, no spaces): remote debug wake is off");
	}
	if (universe) {
		const u = Number(universe);
		if (!Number.isSafeInteger(u) || u <= 0) throw new Error("TYPETORCH_UNIVERSE_ID must be a positive integer");
		config.universeId = u;
	}
	if (env.TYPETORCH_ALERT_WEBHOOK_URL) config.alertWebhookUrl = env.TYPETORCH_ALERT_WEBHOOK_URL;
	if (format) config.alertWebhookFormat = format as "discord" | "slack" | "json";
	return config;
}

/** What's configured, by name only (for the startup line). */
export function describeConfig(config: ServerConfig): string {
	const yes = (v: unknown) => (v ? "set" : "not set");
	return [
		`parts=${[...config.parts].join("+")}`,
		`data=${config.dataDir}`,
		`api keys=${config.apiKeys.length}`,
		`lookup token=${yes(config.lookupToken)}`,
		`explorer=${config.webDir ? "served at /" : "not served"}`,
		`token login=${config.tokenLogin ? "on" : "off"}`,
		`web viewers=${config.webViewers.length}`,
		`roblox sign-in=${config.robloxOAuth ? "on" : "off"}`,
		`typetorch.dev login=${config.centralLogin ? `on (issuer ${config.centralLogin.issuer}, unblessed owners: ${config.centralLogin.unblessed}${config.centralLogin.unblessed === "admin" ? " (typetorch.dev logins grant owners admin without device trust)" : ""}${config.centralLogin.kids ? `, ${config.centralLogin.kids.length} pinned kid(s)` : ""}${config.centralLogin.robloxClientId || config.centralLogin.robloxDiscoveryUrl ? ", Roblox settings pinned" : ", Roblox settings from the broker"})` : "off"}`,
		`admin allow list=${config.adminAllowIps ? `${config.adminAllowIps.length} rule(s)` : "off"}`,
		`trust proxy=${config.trustProxy || "off"}${config.trustedProxies ? ` (from ${config.trustedProxies.length} proxy rule(s))` : ""}`,
		`cloudflare=${config.cloudflareIps ? "on" : "off"}`,
		`public url=${config.publicUrl ?? "not set"}`,
		`erasure webhook secret=${yes(config.webhookSecret)}`,
		`open cloud key=${yes(config.openCloudKey)}`,
		`messaging key=${yes(config.messagingKey)}`,
		`alert webhook=${yes(config.alertWebhookUrl)}`,
		`duckdb memory_limit=${config.memoryLimit} threads=${config.threads}`,
		`ad-hoc sql=${config.sql ? `on (memory_limit=${config.sqlMemoryLimit})` : "off"}`,
		`backups=${config.backupHours ? `every ${config.backupHours} h, keep ${config.backupKeep}` : "manual only"}`,
		`disk warning=${config.diskWarnFreePercent ? `under ${config.diskWarnFreePercent}% free (critical under ${config.diskCriticalFreePercent}%)` : "off"}`,
	].join(", ");
}
