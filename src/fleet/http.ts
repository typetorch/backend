/**
 * Fleet API routes on Web Request/Response only (portable to a Cloudflare Worker). The host passes the auth checks
 * and the rate limiters.
 *
 *   POST /v1/fleet/heartbeat | report | alert | closing | deploy | mark     API key (game role)
 *   POST /v1/fleet/bundle                                           API key; kernel 0.5.3 debug bundle (<= 512 KB) -> 202 { ok, id }
 *   GET  /v1/fleet/servers?branch=&maxAge=                          admin token
 *   GET  /v1/fleet/servers?gone=1&branch=&limit=                    closed and lost servers, the most recently gone first
 *   GET  /v1/fleet/servers/<jobId>/metrics?since=<unix ms>         kernel 0.4.2: { points: [{ t, tps, tpsMin, physFps, memMb, luaMb, players }] };
 *                                                                   a since older than 2 h adds 5-minute rollups (`rolledUntil`)
 *   GET  /v1/fleet/servers/<jobId>/bundles                          { bundles: [summary] } newest first
 *   GET  /v1/fleet/bundles/<id>                                     { bundle: { ...summary, body } } (the web role: no body.playerLogs)
 *   GET  /v1/fleet/marks?since=&until=&branch=&kinds=&limit=        chart marks: releases, kernel publishes, backup refreshes
 *   GET  /v1/fleet/reports?seq=|artifact=|latest&branch=
 *   GET  /v1/fleet/alerts?since=&level=&unacked=&limit=
 *   POST /v1/fleet/alerts/<id>/ack   { by? }
 *   GET  /v1/fleet/stream?branch=&types=server,alert,...            Server-Sent Events
 */
import { BUNDLE_BODY_MAX, FleetInputError, JOB_ID_MAX, parseBundle, parseClosing, parseDeploy, parseHeartbeat, parseMark, parseReport, type AlertLevel, type DeployMessage, type FleetEvent, type FleetService, type HeartbeatMessage } from "./service.ts";

export const FLEET_BODY_LIMIT = 16 * 1024;

/**
 * Per-JobId limits per minute. The kernel sends at most 30 requests a minute in all (burst 10; Constants
 * FLEET_RATE_PER_MINUTE), so these never bite a healthy server. CLI alerts all come as j = "cli". Debug bundles
 * (kernel 0.5.3): one per trigger code a minute, 11 in a server's life at most, so a few a minute is plenty.
 */
export const FLEET_LIMITS = { heartbeat: 40, report: 40, alert: 40, closing: 10, deploy: 30, mark: 30, bundle: 6 } as const;

/** A route's body at most: 16 KB, a debug bundle 512 KB. */
const bodyLimit = (kind: keyof typeof FLEET_LIMITS) => (kind === "bundle" ? BUNDLE_BODY_MAX : FLEET_BODY_LIMIT);

/**
 * Never-seen JobIds (no servers row) accepted per minute, across all senders. Anyone with the ingest token (any code
 * in the universe that reads the settings record) could otherwise grow the servers table and the per-JobId limiters with
 * made-up JobIds. 2,000 covers a 1,250-server fleet (50k CCU) restarting within one minute. Known JobIds never count.
 */
export const FLEET_NEW_JOBS_PER_MINUTE = 2000;

export interface Limiter {
	take(key: string): boolean;
	retryAfter(key: string): number;
}

/** The new-JobId limit. `take` answers "ok", "refused" (429), or "flood" (429, and the first refusal of the window). */
export interface NewJobGate {
	readonly perMinute: number;
	readonly windowSeconds: number;
	take(job: string): "ok" | "refused" | "flood";
	/** Seconds until the window ends. */
	retryAfter(): number;
}

/**
 * Distinct never-seen JobIds per clock minute. Holds at most `perMinute` JobIds (cleared when the minute ends), so its
 * own memory is bounded whatever is sent; a JobId already let in this minute may keep going.
 */
export class NewJobLimiter implements NewJobGate {
	readonly windowSeconds = 60;
	private window = -1;
	private readonly admitted = new Set<string>();
	private refusedInWindow = 0;
	private readonly limit: () => number;

	/** `perMinute` may be a function (a runtime setting): read on every call. */
	constructor(
		perMinute: number | (() => number) = FLEET_NEW_JOBS_PER_MINUTE,
		private readonly clock: () => number = Date.now,
	) {
		this.limit = typeof perMinute === "function" ? perMinute : () => perMinute;
	}

	get perMinute(): number {
		return this.limit();
	}

	take(job: string): "ok" | "refused" | "flood" {
		const window = Math.floor(this.clock() / (this.windowSeconds * 1000));
		if (window !== this.window) {
			this.window = window;
			this.admitted.clear();
			this.refusedInWindow = 0;
		}
		if (this.admitted.has(job)) return "ok";
		if (this.admitted.size < this.perMinute) {
			this.admitted.add(job);
			return "ok";
		}
		return ++this.refusedInWindow === 1 ? "flood" : "refused";
	}

	retryAfter(): number {
		return Math.max(1, Math.ceil(((this.window + 1) * this.windowSeconds * 1000 - this.clock()) / 1000));
	}

	/** New JobIds let in this window, and refusals (tests). */
	get stats(): { admitted: number; refused: number } {
		return { admitted: this.admitted.size, refused: this.refusedInWindow };
	}
}

export interface FleetHttpOptions {
	service: FleetService;
	/** The request carries the API key (game role). */
	isIngest(req: Request): boolean;
	/** The request is signed in (the admin role; the web role for GETs). The host refuses unauthorized mutating requests before this is asked. */
	isAdmin(req: Request): boolean;
	/** Where validated heartbeat / closing (topic heartbeat) and report / deploy-start (topic deploy) messages go. Default: straight into the service; the backend passes its bus. */
	accept?(topic: "heartbeat" | "deploy", message: HeartbeatMessage | DeployMessage): Promise<void>;
	limiters: Record<keyof typeof FLEET_LIMITS, Limiter>;
	/** Checked before `limiters` for JobIds without a servers row (not for the CLI's j = "cli"). */
	newJobs: NewJobGate;
	/** Turns off a long-lived connection's idle timeout (SSE). */
	keepOpen?(req: Request): void;
	/** Seconds between SSE keep-alive comments (default 15). */
	pingSeconds?: number;
	/** Plans/25: extra fields for a heartbeat's 202 reply (`rd: 1` while the explorer watches that JobId). */
	heartbeatReply?(job: string): Record<string, unknown> | undefined;
	/** A debug bundle's `playerLogs` go to owners (the admin role) only; the read-only web role gets the body without them. Default: nobody. */
	canReadPlayerLogs?(req: Request): boolean;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function timeParam(value: string | null): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value);
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new FleetInputError("since and until must be unix ms or an ISO time");
	return ms;
}

function intParam(value: string | null, name: string): number | undefined {
	if (value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isSafeInteger(n)) throw new FleetInputError(`${name} must be an integer`);
	return n;
}

/** The body as text, at most `limit` bytes (read in chunks: a larger body is refused without holding it all). */
async function readText(req: Request, limit: number): Promise<{ text: string; bytes: number }> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > limit) throw new BodyTooLarge();
	if (!req.body) return { text: "", bytes: 0 };
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > limit) {
			await reader.cancel().catch(() => {});
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	const all = new Uint8Array(bytes);
	let at = 0;
	for (const chunk of chunks) {
		all.set(chunk, at);
		at += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(all), bytes };
}

async function readJson(req: Request, limit = FLEET_BODY_LIMIT): Promise<unknown> {
	return (await readJsonSized(req, limit)).value;
}

async function readJsonSized(req: Request, limit: number): Promise<{ value: unknown; bytes: number }> {
	const { text, bytes } = await readText(req, limit);
	try {
		return { value: JSON.parse(text), bytes };
	} catch {
		throw new FleetInputError("body must be JSON");
	}
}

/** A JobId from the path, URL-decoded and checked. */
function pathJob(encoded: string): string {
	let job: string;
	try {
		job = decodeURIComponent(encoded);
	} catch {
		throw new FleetInputError("the JobId in the path is not valid URL encoding");
	}
	if (!job || job.length > JOB_ID_MAX || job.includes("\0")) throw new FleetInputError(`the JobId must be 1-${JOB_ID_MAX} characters`);
	return job;
}

class BodyTooLarge extends Error {}

/** Answers a fleet request, or returns undefined when the path isn't a fleet route. */
export async function handleFleet(req: Request, url: URL, o: FleetHttpOptions, ip = ""): Promise<Response | undefined> {
	if (!url.pathname.startsWith("/v1/fleet/")) return undefined;
	const route = url.pathname.slice("/v1/fleet/".length);
	try {
		if (req.method === "POST" && Object.hasOwn(FLEET_LIMITS, route)) {
			if (!o.isIngest(req)) return json(401, { error: "ingest token required" });
			const kind = route as keyof typeof FLEET_LIMITS;
			const { value: body, bytes } = await readJsonSized(req, bodyLimit(kind));
			const job = typeof (body as { j?: unknown })?.j === "string" ? (body as { j: string }).j : (req.headers.get("x-tt-job") ?? "");
			// Checked here, before any limiter keeps the key (the service checks the same per route).
			if (job.length > JOB_ID_MAX || job.includes("\0")) throw new FleetInputError(`j must be a string of at most ${JOB_ID_MAX} characters`);
			// Marks come from the CLI only: one limiter key ("cli") bounds them all (a game server never sends one).
			if (kind === "mark" && job !== "cli") throw new FleetInputError('marks come from the CLI: j must be "cli"');
			const key = job || `ip:${ip}`;
			if (job && job !== "cli" && !(await o.service.knows(job))) {
				const verdict = o.newJobs.take(job);
				if (verdict !== "ok") {
					if (verdict === "flood") {
						try {
							await o.service.flood({ limit: o.newJobs.perMinute, windowSeconds: o.newJobs.windowSeconds, example: job });
						} catch {}
					}
					return json(429, { error: "rate limited: too many new JobIds this minute" }, { "retry-after": String(o.newJobs.retryAfter()) });
				}
			}
			if (!o.limiters[kind].take(key)) return json(429, { error: "rate limited" }, { "retry-after": String(o.limiters[kind].retryAfter(key)) });
			const header = req.headers.get("x-tt-job");
			const accept = o.accept ?? ((_topic, message) => o.service.apply(message));
			// Validated here, committed by whoever subscribes (the fleet store; the others only watch).
			if (kind === "heartbeat") {
				const heartbeat = parseHeartbeat(body, header);
				await accept("heartbeat", { kind: "heartbeat", heartbeat });
				return json(202, { ok: true, ...(o.heartbeatReply?.(heartbeat.job) ?? {}) });
			}
			if (kind === "report") await accept("deploy", { kind: "report", report: parseReport(body) });
			else if (kind === "closing") await accept("heartbeat", { kind: "closing", ...parseClosing(body, header) });
			else if (kind === "deploy") await accept("deploy", { kind: "start", deploy: parseDeploy(body) });
			else if (kind === "mark") await accept("deploy", { kind: "mark", mark: parseMark(body) });
			else if (kind === "bundle") {
				// Straight into the store (like alerts): a repeat id is accepted again and stores nothing.
				const stored = await o.service.addBundle(parseBundle(body, bytes));
				return json(202, { ok: true, id: stored.id, ...(stored.duplicate ? { duplicate: true } : {}) });
			} else {
				const alert = await o.service.alert(body);
				return json(202, { ok: true, id: alert.id });
			}
			return json(202, { ok: true });
		}
		if (!o.isAdmin(req)) return json(401, { error: "admin token required" });
		const ack = /^alerts\/(\d+)\/ack$/.exec(route);
		if (req.method === "POST" && ack) {
			const body = (await readJson(req).catch(() => ({}))) as { by?: unknown };
			const ok = await o.service.ack(Number(ack[1]), typeof body?.by === "string" ? body.by : undefined);
			return json(ok ? 200 : 404, ok ? { ok: true } : { error: "no such unacknowledged alert" });
		}
		if (req.method !== "GET") return json(405, { error: "method not allowed" });
		const q = url.searchParams;
		if (route === "servers" && (q.get("gone") === "1" || q.get("gone") === "true")) {
			const limit = intParam(q.get("limit"), "limit");
			return json(200, await o.service.goneServers({ ...(q.get("branch") ? { branch: q.get("branch") as string } : {}), ...(limit !== undefined ? { limit } : {}) }));
		}
		if (route === "servers") {
			const maxAge = intParam(q.get("maxAge"), "maxAge");
			return json(200, await o.service.servers({ ...(q.get("branch") ? { branch: q.get("branch") as string } : {}), ...(maxAge !== undefined ? { maxAgeSeconds: maxAge } : {}) }));
		}
		// Kernel 0.4.2: one server's TPS / memory / players history, oldest first (the explorer's /servers/<JobId> graphs).
		const metrics = /^servers\/([^/]+)\/metrics$/.exec(route);
		if (metrics) {
			const job = pathJob(metrics[1]);
			const since = timeParam(q.get("since"));
			return json(200, await o.service.metrics(job, since !== undefined ? { since } : {}));
		}
		// Kernel 0.5.3 debug bundles: one server's list (summaries), and one bundle with its body.
		const bundles = /^servers\/([^/]+)\/bundles$/.exec(route);
		if (bundles) return json(200, { bundles: await o.service.bundles(pathJob(bundles[1])) });
		const bundle = /^bundles\/([^/]+)$/.exec(route);
		if (bundle) {
			const found = await o.service.bundleById(bundle[1], { playerLogs: o.canReadPlayerLogs?.(req) ?? false });
			return found ? json(200, { bundle: found }) : json(404, { error: "no such bundle (bundles are kept 30 days, 20 per server)" });
		}
		if (route === "reports") {
			const seq = intParam(q.get("seq"), "seq");
			return json(
				200,
				await o.service.reports({
					...(seq !== undefined ? { seq } : {}),
					...(q.get("artifact") ? { artifact: q.get("artifact") as string } : {}),
					...(q.get("branch") ? { branch: q.get("branch") as string } : {}),
				}),
			);
		}
		if (route === "alerts") {
			const level = q.get("level");
			if (level && !["critical", "warning", "info"].includes(level)) throw new FleetInputError("level must be critical, warning or info");
			const since = timeParam(q.get("since"));
			const limit = intParam(q.get("limit"), "limit");
			return json(200, {
				alerts: await o.service.alerts({
					...(since !== undefined ? { since } : {}),
					...(level ? { level: level as AlertLevel } : {}),
					unacked: q.get("unacked") === "1" || q.get("unacked") === "true",
					...(limit !== undefined ? { limit } : {}),
				}),
			});
		}
		if (route === "marks") {
			const since = timeParam(q.get("since"));
			const until = timeParam(q.get("until"));
			const limit = intParam(q.get("limit"), "limit");
			const kinds = (q.get("kinds") ?? "").split(",").filter(Boolean);
			return json(200, {
				marks: await o.service.marks({
					...(since !== undefined ? { since } : {}),
					...(until !== undefined ? { until } : {}),
					...(q.get("branch") ? { branch: q.get("branch") as string } : {}),
					...(kinds.length ? { kinds } : {}),
					...(limit !== undefined ? { limit } : {}),
				}),
			});
		}
		if (route === "stream") return stream(req, url, o);
		return json(404, { error: "not found" });
	} catch (error) {
		if (error instanceof BodyTooLarge) return json(413, { error: "body too large" });
		if (error instanceof FleetInputError) return json(400, { error: error.message });
		throw error;
	}
}

function stream(req: Request, url: URL, o: FleetHttpOptions): Response {
	const branch = url.searchParams.get("branch");
	const types = new Set((url.searchParams.get("types") ?? "").split(",").filter(Boolean));
	const encoder = new TextEncoder();
	let unsubscribe = () => {};
	let ping: ReturnType<typeof setInterval> | undefined;
	o.keepOpen?.(req);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					unsubscribe();
				}
			};
			send("hello", { at: new Date().toISOString() });
			unsubscribe = o.service.subscribe((event: FleetEvent) => {
				if (types.size && !types.has(event.type)) return;
				if (branch) {
					// Place-wide marks (kernel, backup) pass every branch filter.
					const b =
						event.type === "server"
							? event.server.branch
							: event.type === "alert"
								? event.alert.branch
								: event.type === "alert_ack"
									? branch
									: event.type === "mark"
										? event.mark.kind === "kernel" || event.mark.kind === "backup"
											? branch
											: event.mark.branch
										: event.type === "bundle"
											? event.bundle.branch
											: event.branch;
					if (b !== branch) return;
				}
				send(event.type, event);
			});
			ping = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					unsubscribe();
				}
			}, (o.pingSeconds ?? 15) * 1000);
			req.signal.addEventListener("abort", () => {
				unsubscribe();
				if (ping) clearInterval(ping);
				try {
					controller.close();
				} catch {}
			});
		},
		cancel() {
			unsubscribe();
			if (ping) clearInterval(ping);
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
}
