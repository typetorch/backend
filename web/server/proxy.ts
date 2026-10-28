/**
 * The local proxy between the explorer and the backend, for `vite dev` and `vite preview` (the backend serves the built
 * explorer itself at /; this is for working on the explorer).
 *
 * The browser calls `/api/...`; this forwards to the backend and adds the admin token, read from the game repo's .env
 * (`--game <repo>`; TYPETORCH_ENV_FILE names another file; a TYPETORCH_ADMIN_TOKEN in the environment wins). The backend's
 * URL is the game's typetorch.json `backend.url` (else the old `fleet.url`), or TYPETORCH_BACKEND_URL / `--url`, else
 * http://127.0.0.1:8787. The token never reaches the browser. Because any page open in the same browser could also send
 * requests to localhost, a guard runs first: only the endpoints the explorer uses, only from the explorer's own origin,
 * JSON bodies only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin, ProxyOptions } from "vite";

export interface AnalyticsTarget {
	/** Base URL of the backend, e.g. http://127.0.0.1:8787 */
	url: string;
	token?: string;
	/** Where the settings came from (for the startup line; never the token itself). */
	source: string;
}

/** KEY=value lines (comments, quotes and `export` allowed), like the backend reads them. */
export function parseEnvFile(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The admin token goes only to https URLs, or to this machine. */
export function assertSafeTarget(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`the backend URL ${JSON.stringify(url)} is not a URL`);
	}
	if (parsed.username || parsed.password) throw new Error("the backend URL must not hold credentials");
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname))) {
		throw new Error(`refusing to send the admin token over plain http to ${parsed.host}: use https, or a backend on this machine`);
	}
}

/**
 * The backend to talk to and the admin token for it. Inputs (all optional): TYPETORCH_GAME_DIR (the game repo, set by
 * `--game`), TYPETORCH_ENV_FILE, TYPETORCH_ADMIN_TOKEN, TYPETORCH_BACKEND_URL. Real environment variables win over files.
 */
export function resolveTarget(env: Record<string, string | undefined>, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): AnalyticsTarget {
	const read = (path: string): string | undefined => {
		try {
			return readFile(path);
		} catch {
			return undefined;
		}
	};
	const gameDir = env.TYPETORCH_GAME_DIR ? resolve(env.TYPETORCH_GAME_DIR) : undefined;
	const envFile = env.TYPETORCH_ENV_FILE ? resolve(env.TYPETORCH_ENV_FILE) : gameDir ? join(gameDir, ".env") : undefined;
	const fileText = envFile ? read(envFile) : undefined;
	const fromFile = fileText !== undefined ? parseEnvFile(fileText) : {};
	let config: { backend?: { url?: unknown }; fleet?: { url?: unknown } } = {};
	const configPath = gameDir ? join(gameDir, "typetorch.json") : undefined;
	const configText = configPath ? read(configPath) : undefined;
	if (configText !== undefined) {
		try {
			config = JSON.parse(configText);
		} catch {
			// a broken typetorch.json is the CLI's to report
		}
	}
	const fromConfig = [config.backend?.url, config.fleet?.url].find((u): u is string => typeof u === "string" && u !== "");
	const url = (env.TYPETORCH_BACKEND_URL || fromConfig || "http://127.0.0.1:8787").replace(/\/+$/, "");
	const token = env.TYPETORCH_ADMIN_TOKEN || fromFile.TYPETORCH_ADMIN_TOKEN;
	const parts: string[] = [];
	if (env.TYPETORCH_BACKEND_URL) parts.push("url from the environment");
	else if (fromConfig) parts.push("url from typetorch.json");
	else parts.push("default url");
	parts.push(env.TYPETORCH_ADMIN_TOKEN ? "token from the environment" : fromFile.TYPETORCH_ADMIN_TOKEN ? `token from ${envFile}` : envFile ? `no token in ${envFile}` : "no token");
	return { url, ...(token ? { token } : {}), source: parts.join(", ") };
}

/** The backend endpoints the explorer may reach through the proxy (paths without /api). Everything else is refused. */
export const ALLOWED_ROUTES: { method: "GET" | "POST"; path: RegExp }[] = [
	{ method: "GET", path: /^\/healthz$/ },
	// Who am I: the proxy's token makes the answer "admin", so the explorer skips its login page.
	{ method: "GET", path: /^\/v1\/auth\/check$/ },
	{ method: "GET", path: /^\/v1\/errors(\/[A-Za-z0-9_.:-]{1,64})?$/ },
	// The server page's error kinds, and the saved queries (read only through the proxy, like the Settings page: save,
	// edit and delete them on the backend's own explorer).
	{ method: "GET", path: /^\/v1\/servers\/[A-Za-z0-9_.:{}%-]{1,200}\/errors$/ },
	{ method: "GET", path: /^\/v1\/saved-queries(\/[1-9][0-9]{0,9})?$/ },
	{ method: "GET", path: /^\/v1\/live$/ },
	{ method: "GET", path: /^\/v1\/queries$/ },
	{ method: "GET", path: /^\/v1\/storage$/ },
	{ method: "GET", path: /^\/v1\/identity$/ },
	// The player detail's profile card: the pid's UserId and its Roblox name and avatar (the backend asks Roblox).
	{ method: "GET", path: /^\/v1\/identity\/[A-Za-z0-9_-]{1,64}\/profile$/ },
	// Fills pid <-> UserId from the game's DataStore links (the server's own Open Cloud key); writes nothing else.
	{ method: "POST", path: /^\/v1\/identity\/backfill$/ },
	{ method: "POST", path: /^\/v1\/query\/[A-Za-z-]{1,64}$/ },
	{ method: "POST", path: /^\/v1\/sql$/ },
	{ method: "GET", path: /^\/v1\/rollups\/(daily|players|player_days|edges)$/ },
	{ method: "GET", path: /^\/v1\/fleet\/(servers|reports|alerts|stream)$/ },
	// The Performance page: chart marks, and one server's TPS / memory history (the heartbeat metrics update).
	{ method: "GET", path: /^\/v1\/fleet\/marks$/ },
	{ method: "GET", path: /^\/v1\/fleet\/servers\/[A-Za-z0-9_.:{}%-]{1,200}\/metrics$/ },
	// Plans/25, the server page: one server (its metrics: the rule above), remote debug. The POSTs only ask for read-only
	// answers (v1 has no op that changes the game server); the backend audits each command.
	{ method: "GET", path: /^\/v1\/fleet\/servers\/[A-Za-z0-9_.:{}%-]{1,200}$/ },
	{ method: "POST", path: /^\/v1\/fleet\/servers\/[A-Za-z0-9_.:{}%-]{1,200}\/(watch|commands)$/ },
	{ method: "GET", path: /^\/v1\/fleet\/servers\/[A-Za-z0-9_.:{}%-]{1,200}\/commands\/[A-Za-z0-9_-]{1,64}$/ },
	{ method: "GET", path: /^\/v1\/fleet\/debug\/audit$/ },
	// The Settings page can read through the proxy (the webhook URL is never in the answer). Saving and the test alert are
	// not forwarded: change settings on the backend's own explorer, signed in.
	{ method: "GET", path: /^\/v1\/admin\/settings$/ },
	// The Backend stats page: the server's own metrics (counts and timings, no secrets).
	{ method: "GET", path: /^\/v1\/admin\/stats$/ },
];

export interface GuardInput {
	method: string;
	/** The path after /api, with or without a query string. */
	url: string;
	headers: Record<string, string | string[] | undefined>;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

const header = (headers: GuardInput["headers"], name: string): string | undefined => {
	const v = headers[name];
	return Array.isArray(v) ? v[0] : v;
};

/** Decides whether a browser request may go through the proxy. */
export function guardRequest(req: GuardInput, hasToken: boolean): GuardResult {
	const path = req.url.split("?")[0] ?? "";
	// No walking out of an allowed route.
	if (path.split("/").some((segment) => segment === ".." || segment === ".")) return { ok: false, status: 403, error: "bad path" };
	const method = req.method.toUpperCase();
	if (!ALLOWED_ROUTES.some((r) => r.method === method && r.path.test(path)))
		return { ok: false, status: 403, error: `the explorer proxy does not forward ${method} ${path}` };
	// Only the explorer's own pages: browsers mark every request with Sec-Fetch-Site, and cross-origin ones with Origin.
	const site = header(req.headers, "sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return { ok: false, status: 403, error: "cross-site requests are refused" };
	const origin = header(req.headers, "origin");
	const host = header(req.headers, "host");
	if (origin) {
		let originHost = "";
		try {
			originHost = new URL(origin).host;
		} catch {
			// "null" or garbage
		}
		if (!host || originHost !== host) return { ok: false, status: 403, error: "cross-origin requests are refused" };
	}
	// A JSON content type makes a cross-origin POST need a CORS preflight, which this server never grants.
	if (method === "POST" && !/^application\/json\b/i.test(header(req.headers, "content-type") ?? ""))
		return { ok: false, status: 415, error: "POST bodies must be application/json" };
	if (!hasToken)
		return { ok: false, status: 503, error: "no admin token: start the explorer with --game <the game repo> (its .env holds TYPETORCH_ADMIN_TOKEN)" };
	return { ok: true };
}

/** The Vite `proxy` entry and the guard plugin for a target. */
export function analyticsProxy(target: AnalyticsTarget): { proxy: Record<string, ProxyOptions>; plugin: Plugin } {
	const guard = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const result = guardRequest({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers }, Boolean(target.token));
		if (result.ok) return next();
		res.statusCode = result.status;
		res.setHeader("content-type", "application/json");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify({ error: result.error }));
	};
	const proxy: Record<string, ProxyOptions> = {
		"/api": {
			target: target.url,
			changeOrigin: true,
			rewrite: (path) => path.replace(/^\/api/, ""),
			configure(server) {
				server.on("proxyReq", (proxyReq) => {
					proxyReq.removeHeader("cookie");
					proxyReq.removeHeader("origin");
					proxyReq.removeHeader("referer");
					if (target.token) proxyReq.setHeader("authorization", `Bearer ${target.token}`);
				});
			},
		},
	};
	const plugin: Plugin = {
		name: "typetorch-analytics-proxy-guard",
		configureServer(server) {
			server.middlewares.use("/api", guard);
		},
		configurePreviewServer(server) {
			server.middlewares.use("/api", guard);
		},
	};
	return { proxy, plugin };
}
