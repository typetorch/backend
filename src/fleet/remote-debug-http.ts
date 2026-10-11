/**
 * Plans/25 remote debug routes (the hub is remote-debug.ts). The host (app.ts) decides who is calling; this file only
 * routes, checks inputs and applies the limits. Other /v1/fleet/servers/<job>/... routes (the TPS and memory history,
 * `/metrics`, from the heartbeat-metrics work) are not claimed here: isRemoteDebugPath leaves them to the fleet routes.
 *
 *   game (API key, JobId in X-TT-Job or ?j=)
 *   GET  /v1/fleet/commands?wait=0-8                  -> { watch, commands: [{ id, op, args, by, exp }] }
 *   POST /v1/fleet/results  { j, results: [...] }     -> 202 { accepted, ignored }
 *
 *   admin (the admin token or an explorer session; GET /v1/fleet/servers/<job> also for the read-only web role)
 *   GET  /v1/fleet/servers/<job>                      -> { server, state, debug, history }   (state: live, closed, lost,
 *                                                        gone (no row, but alerts, reports, bundles or metrics name it) or
 *                                                        unknown; history: its alerts, deploy reports, debug bundles, swaps
 *                                                        and the time range its metrics cover)
 *   POST /v1/fleet/servers/<job>/watch                -> { job, ...debug, wake }   (wake: a wake message went out lately
 *                                                        for this job: "Waking server..."; remote-debug-wake.ts)
 *   POST /v1/fleet/servers/<job>/commands { op, args } -> 202 { id, op, state, expiresAt }
 *   GET  /v1/fleet/servers/<job>/commands/<id>        -> the command and, once answered, its result
 *   GET  /v1/fleet/debug/audit?limit=                 -> { entries }
 */
import type { FleetService } from "./service.ts";
import { JOB_ID_MAX } from "./service.ts";
import { RemoteDebugInputError, type Caller, type RemoteDebugHub } from "./remote-debug.ts";
import type { RemoteDebugWaker } from "./remote-debug-wake.ts";

/** POST /v1/fleet/results at most (each result is at most 256 KB of JSON text; the kernel sends 200 KB at most). */
export const RESULTS_BODY_MAX = 512 * 1024;
/** POST .../commands at most. */
const COMMAND_BODY_MAX = 32 * 1024;
const JOB_PATTERN = /^[A-Za-z0-9_.:{}-]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The server page's routes: /v1/fleet/servers/<job>, .../watch, .../commands, .../commands/<id> (nothing else). */
const SERVER_ROUTE = /^\/v1\/fleet\/servers\/([^/]+)(?:\/(watch|commands)(?:\/([^/]+))?)?$/;

export interface Limiter {
	take(key: string): boolean;
	retryAfter(key: string): number;
}

export interface RemoteDebugLimiters {
	/** Kernel polls per JobId a minute. */
	poll: Limiter;
	/** Kernel result posts per JobId a minute. */
	results: Limiter;
	/** Commands per explorer user a minute. */
	userCommands: Limiter;
	/** Commands per JobId a minute. */
	jobCommands: Limiter;
	/** Watches per explorer user a minute. */
	watches: Limiter;
}

export interface RemoteDebugHttpOptions {
	hub: RemoteDebugHub;
	fleet: FleetService;
	/** The request carries the API key. */
	isGame(req: Request): boolean;
	/** The answer for a game route without the API key (401, counted per address). */
	badGameKey(req: Request): Response;
	/**
	 * The signed-in gate: the caller, or the answer to send (401/403/404/429). `read` (one server's view) lets the
	 * read-only web role in; `manage` (a watch, a command, a command's answer, the audit with its addresses) is for admins.
	 */
	admin(req: Request, need: "read" | "manage"): { caller: Caller } | { response: Response };
	limiters: RemoteDebugLimiters;
	/** Plans/25 "Instant wake": publishes a wake when a watch starts on a job that isn't polling (none: heartbeats only). */
	waker?: Pick<RemoteDebugWaker, "wake" | "waking">;
	/** Reads a body up to `max` bytes (undefined = over). */
	readCapped(req: Request, max: number): Promise<Uint8Array | null | undefined>;
	/** Turns off the idle timeout of a held request (the kernel's long-poll). */
	keepOpen?(req: Request): void;
	ip: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

const tooMany = (seconds: number, what = "rate limited") => json(429, { error: what }, { "retry-after": String(Math.max(1, seconds)) });

function jobOf(req: Request, url: URL): string | undefined {
	const job = req.headers.get("x-tt-job") ?? url.searchParams.get("j") ?? "";
	return job.length > 0 && job.length <= JOB_ID_MAX && JOB_PATTERN.test(job) ? job : undefined;
}

async function readJson(req: Request, o: RemoteDebugHttpOptions, max: number): Promise<unknown | Response> {
	const raw = await o.readCapped(req, max);
	if (!raw) return json(413, { error: `body over ${max} bytes` });
	try {
		return raw.length ? JSON.parse(Buffer.from(raw).toString("utf8")) : {};
	} catch {
		return json(400, { error: "body is not JSON" });
	}
}

/** Whether `path` is one of these routes (the host routes them here before the other fleet routes). */
export function isRemoteDebugPath(path: string): boolean {
	return path === "/v1/fleet/commands" || path === "/v1/fleet/results" || path === "/v1/fleet/debug/audit" || SERVER_ROUTE.test(path);
}

export async function handleRemoteDebug(req: Request, url: URL, path: string, o: RemoteDebugHttpOptions): Promise<Response> {
	const method = req.method;
	try {
		// Game routes -------------------------------------------------------------------------------------------------------
		if (path === "/v1/fleet/commands" || path === "/v1/fleet/results") {
			if (!o.isGame(req)) return o.badGameKey(req);
			const job = jobOf(req, url);
			if (path === "/v1/fleet/commands") {
				if (method !== "GET") return json(405, { error: "GET only" });
				if (!job) return json(400, { error: "the JobId is required (X-TT-Job or ?j=), at most 64 characters" });
				// Only servers the fleet knows (a heartbeat came) can have commands; others get nothing and leave no trace (not
				// even a limiter bucket: made-up JobIds can't grow the per-JobId limiter, like the fleet's new-JobId gate).
				if (!(await o.fleet.knows(job))) return json(200, { watch: false, commands: [] });
				if (!o.limiters.poll.take(job)) return tooMany(o.limiters.poll.retryAfter(job));
				const wait = Number(url.searchParams.get("wait") ?? "0");
				o.keepOpen?.(req);
				return json(200, await o.hub.poll(job, Number.isFinite(wait) ? wait : 0, req.signal));
			}
			if (method !== "POST") return json(405, { error: "POST only" });
			const body = await readJson(req, o, RESULTS_BODY_MAX);
			if (body instanceof Response) return body;
			const b = (typeof body === "object" && body !== null ? body : {}) as { j?: unknown; results?: unknown };
			const bodyJob = typeof b.j === "string" && JOB_PATTERN.test(b.j) ? b.j : job;
			if (!bodyJob) return json(400, { error: "j (the JobId) is required" });
			// A JobId with no command out answers nothing useful: ignored before the per-JobId limiter (no bucket for it).
			if (!o.hub.awaiting(bodyJob)) return json(202, { accepted: 0, ignored: Array.isArray(b.results) ? Math.min(b.results.length, 32) : 0 });
			if (!o.limiters.results.take(bodyJob)) return tooMany(o.limiters.results.retryAfter(bodyJob));
			return json(202, o.hub.complete(bodyJob, b.results));
		}

		// Admin routes ------------------------------------------------------------------------------------------------------
		const m = SERVER_ROUTE.exec(path);
		const gate = o.admin(req, method === "GET" && m && !m[2] ? "read" : "manage");
		if ("response" in gate) return gate.response;
		const caller = gate.caller;
		const who = caller.kind === "roblox" ? `roblox:${caller.userId}` : "token";
		if (path === "/v1/fleet/debug/audit") {
			if (method !== "GET") return json(405, { error: "GET only" });
			const limit = Number(url.searchParams.get("limit") ?? "100");
			return json(200, { entries: o.hub.auditLog(Number.isFinite(limit) ? limit : 100) });
		}
		if (!m) return json(404, { error: "not found" });
		let job: string;
		try {
			job = decodeURIComponent(m[1]);
		} catch {
			return json(400, { error: "bad JobId" });
		}
		if (!JOB_PATTERN.test(job)) return json(400, { error: "bad JobId" });
		const part = m[2];
		if (!part) {
			if (method !== "GET") return json(405, { error: "GET only" });
			return json(200, { ...(await o.fleet.server(job)), debug: o.hub.status(job) });
		}
		if (part === "watch") {
			if (method !== "POST" || m[3]) return json(405, { error: "POST only" });
			if (!o.limiters.watches.take(who)) return tooMany(o.limiters.watches.retryAfter(who));
			const { state } = await o.fleet.server(job);
			// A closed, gone or unknown server has nothing to debug: no watch, so its (missing) heartbeats get no rd.
			if (state === "closed" || state === "gone" || state === "unknown")
				return json(409, { error: state === "closed" ? "this server closed" : state === "gone" ? "this server is gone" : "no heartbeat from this JobId", state });
			const before = o.hub.status(job);
			const status = o.hub.watch(job, caller);
			// Instant wake: a watch that starts (new, or after it lapsed) on a server that isn't polling publishes one wake
			// message (rate-limited, in the background; a failure never touches the watch). The page's 20 s repeats don't.
			if (o.waker && !before.watched && !status.connected) o.waker.wake(job);
			return json(200, { job, ...status, wake: !status.connected && (o.waker?.waking(job) ?? false) });
		}
		// commands
		if (m[3]) {
			if (method !== "GET") return json(405, { error: "GET only" });
			if (!ID_PATTERN.test(m[3])) return json(404, { error: "no such command" });
			const view = o.hub.get(m[3], caller, job);
			return view ? json(200, view) : json(404, { error: "no such command (or its answer was dropped: answers are kept 3 minutes)" });
		}
		if (method !== "POST") return json(405, { error: "POST only" });
		const body = await readJson(req, o, COMMAND_BODY_MAX);
		if (body instanceof Response) return body;
		const b = (typeof body === "object" && body !== null ? body : {}) as { op?: unknown; args?: unknown };
		if (!o.limiters.userCommands.take(who)) return tooMany(o.limiters.userCommands.retryAfter(who), "rate limited: too many commands from you this minute");
		if (!o.limiters.jobCommands.take(job)) return tooMany(o.limiters.jobCommands.retryAfter(job), "rate limited: too many commands to this server this minute");
		const queued = o.hub.enqueue(job, b.op, b.args, caller, o.ip);
		if (queued === "not_watched") return json(409, { error: "this server isn't watched: open its page (POST .../watch) first" });
		if (queued === "busy") return tooMany(2, "this server already has 8 commands waiting");
		return json(202, queued);
	} catch (error) {
		if (error instanceof RemoteDebugInputError) return json(400, { error: error.message });
		throw error;
	}
}
