/**
 * Plans/34 routes (the hub is live-debug.ts). The host (app.ts) decides who is calling; this file routes, checks inputs
 * and applies the limits.
 *
 *   game (API key, the JobId in the body's `j` or X-TT-Job)
 *   POST /v1/fleet/streams  { j, frames: [{ t, s }] }       -> 200 { ok, watch, lm }  (<= 64 KB; each value <= 16 KB)
 *
 *   admin (the admin token or an owner's session: frames hold player names, UserIds and positions)
 *   GET  /v1/fleet/servers/<job>/streams?since=<t>         -> { declared: { streams, commands }, frames }
 *   POST /v1/fleet/live-map/watch                           -> { ok, until, wake }  (the /live page, every 20 s)
 *   GET  /v1/fleet/live-map                                 -> { servers: [{ job, branch, artifact, at, players }], watchedUntil }
 *
 *   every signed-in role
 *   GET  /v1/fleet/columns                                  -> { columns: [{ n, l?, t? }] }  (the Fleet page's game columns)
 */
import type { Caller } from "./remote-debug.ts";
import { JOB_ID_MAX, type FleetService } from "./service.ts";
import { LiveDebugInputError, STREAMS_BODY_MAX, type LiveDebugHub } from "./live-debug.ts";

/** Stream posts per JobId a minute: the kernel posts once a second while watched (60), every 3 s for the live map. */
export const STREAM_POSTS_PER_MINUTE = 90;

const JOB_PATTERN = /^[A-Za-z0-9_.:{}-]{1,64}$/;
const STREAMS_ROUTE = /^\/v1\/fleet\/servers\/([^/]+)\/streams$/;

export interface Limiter {
	take(key: string): boolean;
	retryAfter(key: string): number;
}

export interface LiveDebugHttpOptions {
	hub: LiveDebugHub;
	fleet: FleetService;
	isGame(req: Request): boolean;
	badGameKey(req: Request): Response;
	/** Like remote-debug-http.ts: `read` lets the read-only web role in, `manage` is for admins. */
	admin(req: Request, need: "read" | "manage"): { caller: Caller } | { response: Response };
	limiters: {
		/** Stream posts per JobId a minute. */
		streams: Limiter;
		/** Live map watches per explorer user a minute. */
		watches: Limiter;
	};
	readCapped(req: Request, max: number): Promise<Uint8Array | null | undefined>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

const tooMany = (seconds: number) => json(429, { error: "rate limited" }, { "retry-after": String(Math.max(1, seconds)) });

export function isLiveDebugPath(path: string): boolean {
	return path === "/v1/fleet/streams" || path === "/v1/fleet/live-map" || path === "/v1/fleet/live-map/watch" || path === "/v1/fleet/columns" || STREAMS_ROUTE.test(path);
}

export async function handleLiveDebug(req: Request, url: URL, path: string, o: LiveDebugHttpOptions): Promise<Response> {
	const method = req.method;
	try {
		if (path === "/v1/fleet/streams") {
			if (!o.isGame(req)) return o.badGameKey(req);
			if (method !== "POST") return json(405, { error: "POST only" });
			const raw = await o.readCapped(req, STREAMS_BODY_MAX);
			if (!raw) return json(413, { error: `body over ${STREAMS_BODY_MAX} bytes` });
			let body: unknown;
			try {
				body = JSON.parse(Buffer.from(raw).toString("utf8"));
			} catch {
				return json(400, { error: "body is not JSON" });
			}
			const b = typeof body === "object" && body !== null ? (body as { j?: unknown }) : {};
			const job = typeof b.j === "string" ? b.j : (req.headers.get("x-tt-job") ?? "");
			if (!job || job.length > JOB_ID_MAX || !JOB_PATTERN.test(job)) return json(400, { error: "j (the JobId) is required, at most 64 characters" });
			// A JobId the fleet doesn't know (no heartbeat) keeps nothing and gets no limiter bucket: told to stop.
			if (!(await o.fleet.knows(job))) return json(200, { ok: true, watch: false, lm: false });
			if (!o.limiters.streams.take(job)) return tooMany(o.limiters.streams.retryAfter(job));
			const result = o.hub.ingest(job, body);
			return json(200, { ok: true, watch: result.watch, lm: result.lm, ...(result.dropped ? { dropped: result.dropped } : {}) });
		}

		if (path === "/v1/fleet/columns") {
			const gate = o.admin(req, "read");
			if ("response" in gate) return gate.response;
			if (method !== "GET") return json(405, { error: "GET only" });
			const live = await o.fleet.servers();
			return json(200, { columns: o.hub.columns(live.servers.map((s) => s.job)) });
		}

		const gate = o.admin(req, "manage");
		if ("response" in gate) return gate.response;
		const caller = gate.caller;
		const who = caller.kind === "roblox" ? `roblox:${caller.userId}` : "token";

		if (path === "/v1/fleet/live-map/watch") {
			if (method !== "POST") return json(405, { error: "POST only" });
			if (!o.limiters.watches.take(who)) return tooMany(o.limiters.watches.retryAfter(who));
			const watch = o.hub.watchLiveMap();
			return json(200, { ok: true, until: watch.until, wake: watch.wake === "sent" });
		}
		if (path === "/v1/fleet/live-map") {
			if (method !== "GET") return json(405, { error: "GET only" });
			const latest = o.hub.latestPositions();
			const live = latest.size ? await o.fleet.servers() : { servers: [] };
			const servers = live.servers
				.filter((s) => latest.has(s.job))
				.map((s) => {
					const frame = latest.get(s.job) as { at: number; players: unknown[] };
					return { job: s.job, branch: s.branch, artifact: s.artifact, at: frame.at, players: frame.players };
				});
			return json(200, { servers, watchedUntil: o.hub.liveMapWatchedUntil });
		}

		const m = STREAMS_ROUTE.exec(path);
		if (!m) return json(404, { error: "not found" });
		if (method !== "GET") return json(405, { error: "GET only" });
		let job: string;
		try {
			job = decodeURIComponent(m[1] as string);
		} catch {
			return json(400, { error: "bad JobId" });
		}
		if (!JOB_PATTERN.test(job)) return json(400, { error: "bad JobId" });
		const sinceRaw = url.searchParams.get("since");
		const since = sinceRaw === null || sinceRaw === "" ? undefined : Number(sinceRaw);
		if (since !== undefined && !Number.isFinite(since)) return json(400, { error: "since must be unix ms" });
		const declared = o.hub.declarations(job);
		return json(200, { declared: { streams: declared?.st ?? [], commands: declared?.cmd ?? [] }, frames: o.hub.frames(job, since) });
	} catch (error) {
		if (error instanceof LiveDebugInputError) return json(400, { error: error.message });
		throw error;
	}
}
