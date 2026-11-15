/**
 * Demo handlers for the "fleet" domain: the fleet API (src/fleet/http.ts), remote debug (src/fleet/remote-debug-http.ts),
 * game-defined debug and the live map (src/fleet/live-debug-http.ts), the deploy history, Roblox's server logs and the
 * sidebar's place card (src/server/app.ts).
 *
 *   GET  /v1/fleet/servers?branch&maxAge | ?gone=1&branch&limit     live servers (+ heartbeat metrics) | recently gone
 *   GET  /v1/fleet/servers/<job>                                   one server of any age, its debug session and history
 *   GET  /v1/fleet/servers/<job>/metrics?since                     TPS / memory / players history
 *   GET  /v1/fleet/servers/<job>/bundles                           its debug bundles
 *   POST /v1/fleet/servers/<job>/watch                             the page watches it (409 closed / gone / unknown)
 *   POST /v1/fleet/servers/<job>/commands { op, args }             202 queued; GET .../commands/<id> the answer
 *   GET  /v1/fleet/servers/<job>/streams?since                     the game's declarations and stream frames
 *   GET  /v1/fleet/alerts?since&level&unacked&limit, POST /v1/fleet/alerts/<id>/ack
 *   GET  /v1/fleet/reports?latest&branch | ?seq | ?artifact
 *   GET  /v1/fleet/marks?since&until&branch&kinds&limit
 *   GET  /v1/fleet/deploys?branch&before&limit, GET /v1/fleet/deploys/<seq>
 *   GET  /v1/fleet/bundles/<id>
 *   POST /v1/fleet/live-map/watch, GET /v1/fleet/live-map, GET /v1/fleet/columns, GET /v1/fleet/debug/audit?limit
 *   SSE  /v1/fleet/stream?branch&types                             hello, server, alert, alert_ack, report, deploy
 *   GET  /v1/roblox/servers/<job>/logs?search&order&pageToken&placeId&placeVersion
 *   GET  /v1/place
 *
 * Everybody is an owner, so answers carry what the admin role sees (server addresses: documentation ranges).
 */
import type { DeployDetail, DeployPage } from "@/lib/deploys";
import type { DeployMark, PerfServer, ServerMetricPoint } from "@/lib/perf";
import type {
	BundleSummary,
	DebugAuditEntry,
	DebugBundle,
	FleetAlert,
	FleetReports,
	FleetServerDetail,
	FleetServers,
	GameColumn,
	GoneServer,
	LiveMapServer,
	PlaceCardInfo,
	RemoteCommand,
	RobloxServerLog,
	RobloxServerLogs,
	ServerStreams,
	WatchReply,
} from "@/lib/types";
import { now, PLACE_ID, UNIVERSE_ID } from "./data";
import {
	bundleById,
	bundleSummary,
	deployDetail,
	deployRecordOf,
	fleetReports,
	GAME_COLUMNS,
	GEO_STATUS,
	goneServer,
	KEEP_METRICS_MS,
	lastSeenOf,
	LOST_AFTER_MS,
	MARK_KINDS,
	marks,
	METRICS_MAX_POINTS,
	model,
	type Model,
	placeVersionOf,
	readingAt,
	ROLLUP_MS,
	serverInfo,
	swapsOf,
} from "./fleet-model";
import { auditLog, commandView, debugStatus, enqueue, liveMapWatchedUntil, watch, watchLiveMap } from "./fleet-remote";
import { framesFor, GAME_COMMANDS, GAME_STREAMS, livePlayersAt, loadWorld } from "./fleet-world";
import type { PackJob } from "./pack";
import { hashString, rng } from "./rng";
import { fail, HttpError, json, route, stream, type StreamSink } from "./router";
import { slice } from "./state";

// Inputs, as src/fleet/http.ts checks them ----------------------------------------------------------------------------

const JOB_ID_MAX = 64;
const JOB_PATTERN = /^[A-Za-z0-9_.:{}-]{1,64}$/;

function intParam(value: string | null, name: string): number | undefined {
	if (value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isSafeInteger(n)) throw new HttpError(400, `${name} must be an integer`);
	return n;
}

function timeParam(value: string | null): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value);
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new HttpError(400, "since and until must be unix ms or an ISO time");
	return ms;
}

function pathJob(job: string): string {
	if (!job || job.length > JOB_ID_MAX || job.includes("\0")) throw new HttpError(400, `the JobId must be 1-${JOB_ID_MAX} characters`);
	return job;
}

/** The remote debug routes' check (remote-debug-http.ts): "bad JobId". */
function debugJob(job: string): string {
	if (!JOB_PATTERN.test(job)) throw new HttpError(400, "bad JobId");
	return job;
}

const known = (m: Model, job: string): PackJob | undefined => m.p.job(job);

// Alerts and their acks --------------------------------------------------------------------------------------------------

/** Acks made in this browser (alert id -> when). */
const acks = slice<Record<string, number>>("fleet.alertAcks", () => ({}));

function alertsOf(m: Model): FleetAlert[] {
	const acked = acks.get();
	return m.alerts.map((a) => (acked[String(a.id)] ? { ...a, acked: true } : a));
}

// Servers --------------------------------------------------------------------------------------------------------------

function liveServers(m: Model, branch: string | undefined, maxAgeSeconds?: number) {
	const since = m.at - (maxAgeSeconds ?? LOST_AFTER_MS / 1000) * 1000;
	return m.live.filter((j) => (!branch || j.branch === branch) && lastSeenOf(j, m.at, true) >= since).map((j) => serverInfo(m, j));
}

route<FleetServers | { servers: GoneServer[] } | { servers: PerfServer[]; players: number }>("GET", "/v1/fleet/servers", async (req) => {
	const m = await model();
	const q = req.query;
	const branch = q.get("branch") || undefined;
	if (q.get("gone") === "1" || q.get("gone") === "true") {
		const limit = intParam(q.get("limit"), "limit");
		const n = Math.min(Math.max(1, limit ?? 200), 1000);
		return { servers: m.gone.filter((j) => !branch || j.branch === branch).slice(0, n).map((j) => goneServer(m, j)) };
	}
	const maxAge = intParam(q.get("maxAge"), "maxAge");
	const servers = liveServers(m, branch, maxAge);
	const art = new Map<string, { servers: number; players: number }>();
	const byHealth: Record<string, number> = {};
	for (const s of servers) {
		const key = s.artifact ?? "(unknown)";
		const a = art.get(key) ?? { servers: 0, players: 0 };
		a.servers++;
		a.players += s.players ?? 0;
		art.set(key, a);
		byHealth[s.health ?? "(unknown)"] = (byHealth[s.health ?? "(unknown)"] ?? 0) + 1;
	}
	return {
		servers,
		players: servers.reduce((sum, s) => sum + (s.players ?? 0), 0),
		byArtifact: [...art].map(([artifact, v]) => ({ artifact, ...v })).sort((a, b) => b.servers - a.servers),
		byHealth,
		geo: GEO_STATUS,
	} satisfies FleetServers;
});

function historyOf(m: Model, job: string, j: PackJob | undefined): NonNullable<FleetServerDetail["history"]> {
	const live = m.liveSet.has(job);
	return {
		alerts: alertsOf(m)
			.filter((a) => a.job === job)
			.sort((a, b) => b.id - a.id)
			.slice(0, 200),
		reports: [...(m.reportsByJob.get(job) ?? [])].reverse().slice(0, 200),
		bundles: m.bundles
			.filter((b) => b.job === job)
			.sort((a, b) => b.at - a.at)
			.map(bundleSummary),
		swaps: swapsOf(m, job),
		metrics: j ? { from: j.startedAt ?? j.firstAt, to: live ? lastSeenOf(j, m.at, true) : j.lastAt } : { from: null, to: null },
	};
}

route<FleetServerDetail>("GET", "/v1/fleet/servers/:job", async (req) => {
	const job = debugJob(req.params.job as string);
	const m = await model();
	const j = known(m, job);
	const history = historyOf(m, job, j);
	if (!j) return { server: null, state: "unknown", debug: debugStatus(job), history, geo: GEO_STATUS };
	if (m.liveSet.has(job)) return { server: { ...serverInfo(m, j), closedAt: null, lostAt: null, firstSeen: new Date(j.firstAt).toISOString() }, state: "live", debug: debugStatus(job), history, geo: GEO_STATUS };
	const gone = goneServer(m, j);
	return { server: gone, state: gone.state, debug: debugStatus(job), history, geo: GEO_STATUS };
});

route<{ bundles: BundleSummary[] }>("GET", "/v1/fleet/servers/:job/bundles", async (req) => {
	const job = pathJob(req.params.job as string);
	const m = await model();
	return { bundles: m.bundles.filter((b) => b.job === job).sort((a, b) => b.at - a.at).map(bundleSummary) };
});

/** One server's metrics: one point per heartbeat over the last 2 hours, 5-minute rollups before (src/fleet/service.ts metrics). */
export function metricPoints(m: Model, j: PackJob, since: number | undefined): { points: ServerMetricPoint[]; rolledUntil?: number } {
	const live = m.liveSet.has(j.job);
	const start = j.startedAt ?? j.firstAt;
	const end = live ? lastSeenOf(j, m.at, true) : j.lastAt;
	const degraded = j.job === m.degraded;
	const point = (t: number): ServerMetricPoint => {
		const r = readingAt(j, t, degraded);
		return { t, tps: r.tps, tpsMin: r.tpsMin, physFps: r.physFps, memMb: r.memMb, luaMb: r.luaMb, players: r.players };
	};
	const rawFrom = m.at - KEEP_METRICS_MS;
	const from = Math.max(since ?? 0, rawFrom);
	const raw: ServerMetricPoint[] = [];
	const phase = hashString(`fleet:hb:${j.job}`) % 60_000;
	for (let t = Math.floor((Math.max(from, start) - phase) / 60_000) * 60_000 + phase; t <= end; t += 60_000) if (t > from && t >= start) raw.push(point(t));
	const rawPoints = raw.slice(-METRICS_MAX_POINTS);
	if (since === undefined || since >= rawFrom) return { points: rawPoints };
	const cut = Math.floor(rawFrom / ROLLUP_MS) * ROLLUP_MS;
	const rolled: ServerMetricPoint[] = [];
	for (let t = Math.floor(Math.max(since, start) / ROLLUP_MS) * ROLLUP_MS; t < Math.min(cut, end); t += ROLLUP_MS) if (t > since - ROLLUP_MS) rolled.push({ ...point(t + ROLLUP_MS / 2), t });
	return { points: [...rolled, ...rawPoints], rolledUntil: cut };
}

route<{ points: ServerMetricPoint[]; rolledUntil?: number }>("GET", "/v1/fleet/servers/:job/metrics", async (req) => {
	const job = pathJob(req.params.job as string);
	const since = timeParam(req.query.get("since"));
	const m = await model();
	const j = known(m, job);
	if (!j) return { points: [] };
	return metricPoints(m, j, since);
});

// Remote debug ---------------------------------------------------------------------------------------------------------

route<WatchReply>("POST", "/v1/fleet/servers/:job/watch", async (req) => {
	const job = debugJob(req.params.job as string);
	const m = await model();
	const j = known(m, job);
	const state = !j ? "unknown" : m.liveSet.has(job) ? "live" : m.lost.has(job) ? "lost" : "closed";
	if (state === "closed" || state === "unknown") return fail(409, state === "closed" ? "this server closed" : "no heartbeat from this JobId", { state });
	return { job, ...watch(job) };
});

route<RemoteCommand>("POST", "/v1/fleet/servers/:job/commands", async (req) => {
	const job = debugJob(req.params.job as string);
	const m = await model();
	const j = known(m, job);
	if (!j || !m.liveSet.has(job)) throw new HttpError(409, "this server isn't watched: open its page (POST .../watch) first");
	return json(202, enqueue(m, j, req.body));
});

route<RemoteCommand>("GET", "/v1/fleet/servers/:job/commands/:id", async (req) => {
	const job = debugJob(req.params.job as string);
	const id = req.params.id as string;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(404, "no such command");
	const m = await model();
	const view = commandView(m, known(m, job), job, id);
	return view ?? fail(404, "no such command (or its answer was dropped: answers are kept 3 minutes)");
});

route<{ entries: DebugAuditEntry[] }>("GET", "/v1/fleet/debug/audit", (req) => {
	const limit = Number(req.query.get("limit") ?? "100");
	return { entries: auditLog(Number.isFinite(limit) ? limit : 100) };
});

// Game-defined debug and the live map (plans/34) --------------------------------------------------------------------------

route<ServerStreams>("GET", "/v1/fleet/servers/:job/streams", async (req) => {
	const job = debugJob(req.params.job as string);
	const raw = req.query.get("since");
	const since = raw === null || raw === "" ? undefined : Number(raw);
	if (since !== undefined && !Number.isFinite(since)) return fail(400, "since must be unix ms");
	const m = await model();
	const j = known(m, job);
	// Frames are kept only while someone watches a live server (the page's watch makes the kernel post them).
	if (!j || !m.liveSet.has(job)) return { declared: { streams: [], commands: [] }, frames: [] };
	const declared = { streams: GAME_STREAMS, commands: GAME_COMMANDS };
	if (!debugStatus(job).connected) return { declared, frames: [] };
	return { declared, frames: framesFor(m, await loadWorld(), j, since, now()) };
});

route<{ ok: true; until: number; wake: boolean }>("POST", "/v1/fleet/live-map/watch", () => {
	const w = watchLiveMap();
	return { ok: true, until: w.until, wake: w.wake };
});

route<{ servers: LiveMapServer[]; watchedUntil: number | null }>("GET", "/v1/fleet/live-map", async () => {
	const watchedUntil = liveMapWatchedUntil();
	if (watchedUntil === null) return { servers: [], watchedUntil };
	const m = await model();
	const w = await loadWorld();
	// One positions frame every 3 s per server (each on its own phase), the latest of the last 15 s.
	const at = now();
	const servers = m.live
		.filter((j) => (j.maxPlayers ?? 0) > 0)
		.map((j): LiveMapServer => {
			const phase = hashString(`fleet:lm:${j.job}`) % 3000;
			const t = Math.floor((at - phase) / 3000) * 3000 + phase;
			return { job: j.job, branch: j.branch, artifact: j.art, at: t, players: livePlayersAt(m, w, j, t) };
		});
	return { servers, watchedUntil };
});

route<{ columns: GameColumn[] }>("GET", "/v1/fleet/columns", async () => {
	const m = await model();
	return { columns: m.live.length ? GAME_COLUMNS : [] };
});

// Alerts, reports, marks, deploys, bundles -------------------------------------------------------------------------------

route<{ alerts: FleetAlert[] }>("GET", "/v1/fleet/alerts", async (req) => {
	const q = req.query;
	const level = q.get("level");
	if (level && !["critical", "warning", "info"].includes(level)) throw new HttpError(400, "level must be critical, warning or info");
	const since = timeParam(q.get("since")) ?? 0;
	const limit = Math.min(Math.max(1, intParam(q.get("limit"), "limit") ?? 200), 1000);
	const unacked = q.get("unacked") === "1" || q.get("unacked") === "true";
	const m = await model();
	const alerts = alertsOf(m)
		.filter((a) => a.at >= since && (!level || a.level === level) && (!unacked || !a.acked))
		.sort((a, b) => b.id - a.id)
		.slice(0, limit);
	return { alerts };
});

route<{ ok: true }>("POST", "/v1/fleet/alerts/:id/ack", async (req) => {
	const id = req.params.id as string;
	if (!/^\d+$/.test(id)) return fail(404, "not found");
	const m = await model();
	const alert = alertsOf(m).find((a) => String(a.id) === id);
	if (!alert || alert.acked) return fail(404, "no such unacknowledged alert");
	acks.update((a) => {
		a[id] = now();
	});
	for (const s of sinks) s.emit("alert_ack", { type: "alert_ack", id: alert.id }, alert.branch ?? null);
	return { ok: true };
});

route<FleetReports>("GET", "/v1/fleet/reports", async (req) => {
	const q = req.query;
	const seq = intParam(q.get("seq"), "seq");
	const m = await model();
	return fleetReports(m, { ...(seq !== undefined ? { seq } : {}), ...(q.get("artifact") ? { artifact: q.get("artifact") as string } : {}), ...(q.get("branch") ? { branch: q.get("branch") as string } : {}) });
});

route<{ marks: DeployMark[] }>("GET", "/v1/fleet/marks", async (req) => {
	const q = req.query;
	const m = await model();
	const until = timeParam(q.get("until")) ?? m.at + 60_000;
	const since = timeParam(q.get("since")) ?? until - 30 * 86_400_000;
	if (since >= until) throw new HttpError(400, "since must be before until");
	if (until - since > 366 * 86_400_000) throw new HttpError(400, "marks: at most a 366-day window");
	const limit = Math.min(Math.max(1, intParam(q.get("limit"), "limit") ?? 500), 2000);
	const kinds = (q.get("kinds") ?? "").split(",").filter(Boolean);
	for (const kind of kinds) if (!(MARK_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kinds must be of ${MARK_KINDS.join(", ")}`);
	const out = marks(m, { since, until, ...(q.get("branch") ? { branch: q.get("branch") as string } : {}), ...(kinds.length ? { kinds: new Set(kinds) } : {}) });
	return { marks: out.length > limit ? out.slice(out.length - limit) : out };
});

route<DeployPage>("GET", "/v1/fleet/deploys", async (req) => {
	const q = req.query;
	const before = intParam(q.get("before"), "before");
	const limit = Math.min(Math.max(1, intParam(q.get("limit"), "limit") ?? 50), 100);
	const branch = q.get("branch");
	if (branch && branch.length > 64) throw new HttpError(400, "branch must be at most 64 characters");
	const m = await model();
	const rows = [...m.deploys].reverse().filter((d) => (before === undefined || d.seq < before) && (!branch || d.branch === branch));
	const page = rows.slice(0, limit);
	return { deploys: page.map((d) => deployRecordOf(m, d)), next: rows.length > limit ? (page[page.length - 1]?.seq ?? null) : null };
});

route<DeployDetail>("GET", "/v1/fleet/deploys/:seq", async (req) => {
	const raw = req.params.seq as string;
	if (!/^\d{1,15}$/.test(raw)) return fail(404, "not found");
	const m = await model();
	const found = deployDetail(m, Number(raw), alertsOf(m));
	return found ?? fail(404, "no such deploy (the history keeps releases for the deployKeepDays setting)");
});

route<{ bundle: DebugBundle }>("GET", "/v1/fleet/bundles/:id", async (req) => {
	const m = await model();
	const found = bundleById(m, req.params.id as string);
	return found ? { bundle: found } : fail(404, "no such bundle (bundles are kept 30 days, 20 per server)");
});

// The event stream ---------------------------------------------------------------------------------------------------------

interface Listener {
	emit(event: string, data: unknown, branch: string | null): void;
}

const sinks = new Set<Listener>();
/** How often the stream looks at the fleet (the backend pushes changes as heartbeats arrive, about once a minute per server). */
const STREAM_TICK_MS = 8_000;

stream("/v1/fleet/stream", (req, sink: StreamSink) => {
	const branch = req.query.get("branch") || null;
	const types = new Set((req.query.get("types") ?? "").split(",").filter(Boolean));
	const listener: Listener = {
		emit(event, data, b) {
			if (types.size && !types.has(event)) return;
			if (branch && event !== "alert_ack" && b !== branch) return;
			sink.send(event, data);
		},
	};
	sink.send("hello", { at: new Date(now()).toISOString() });
	sinks.add(listener);
	let held: Map<string, { players: number | null; lastSeen: string | null | undefined; branch: string | null }> | undefined;
	let lastAt = now();
	let stopped = false;
	const tick = async () => {
		const m = await model();
		if (stopped) return;
		const at = now();
		const current = new Map(m.live.map((j) => [j.job, serverInfo(m, j)]));
		if (held) {
			for (const [job, s] of current) {
				const before = held.get(job);
				if (!before) listener.emit("server", { type: "server", change: "new", server: s }, s.branch);
				else if (before.lastSeen !== s.lastSeen && before.players !== s.players) listener.emit("server", { type: "server", change: "update", server: s }, s.branch);
			}
			for (const [job, before] of held) {
				if (current.has(job)) continue;
				const j = m.p.job(job);
				if (j) listener.emit("server", { type: "server", change: m.lost.has(job) ? "lost" : "closed", server: goneServer(m, j) }, before.branch);
			}
			for (const a of alertsOf(m)) if (a.at > lastAt && a.at <= at) listener.emit("alert", { type: "alert", alert: a }, a.branch ?? null);
			for (const d of m.deploys) {
				if (d.at > lastAt && d.at <= at) listener.emit("deploy", { type: "deploy", seq: d.seq, branch: d.branch, artifact: d.artifact, kind: d.kind }, d.branch);
				for (const r of d.reports) if (r.at > lastAt && r.at <= at) listener.emit("report", { type: "report", seq: r.seq, job: r.job, result: r.result, branch: r.branch }, r.branch);
			}
		}
		held = new Map([...current].map(([job, s]) => [job, { players: s.players, lastSeen: s.lastSeen, branch: s.branch }]));
		lastAt = at;
	};
	void tick().catch(() => {});
	const timer = setInterval(() => void tick().catch(() => {}), STREAM_TICK_MS);
	return () => {
		stopped = true;
		clearInterval(timer);
		sinks.delete(listener);
	};
});

// Roblox's own server logs (GET /v1/roblox/servers/<job>/logs, src/server/app.ts serverLogs) ----------------------------------

const ROBLOX_LOG_PAGE = 50;
const SEARCH_MAX = 200;

/** The errors and warnings Roblox kept for a server: its game's server errors over its life, newest first. */
function robloxLogs(m: Model, j: PackJob | undefined, job: string, placeVersion: number): RobloxServerLog[] {
	const start = j ? (j.startedAt ?? j.firstAt) : m.at - 3_600_000;
	const end = j ? (m.liveSet.has(job) ? m.at : j.lastAt) : m.at - 600_000;
	const serverErrors = m.p.errors.filter((e) => e.src === "server" && (!j?.art || e.arts.includes(j.art) || e.n >= 3));
	const extra = [
		{ severity: "Warning", message: "Infinite yield possible on 'Workspace.Prison.CellBlockA:WaitForChild(\"AlarmBell\")'", stack: "Script 'ServerScriptService.Prison.LockdownService', Line 31" },
		{ severity: "Warning", message: "DataStoreService: Request was throttled, but throttled request queue was full. Data request was dropped. Try sending fewer requests. Key = players__prod", stack: null },
		{ severity: "Warning", message: "Sit : This Seat is occupied", stack: null },
		{ severity: "Error", message: "ServerScriptService.Prison.ShopService:142: attempt to compare nil < number", stack: "Script 'ServerScriptService.Prison.ShopService', Line 142 - function buy\nScript 'ServerScriptService.Prison.ShopService', Line 88" },
	];
	const out: RobloxServerLog[] = [];
	const hours = Math.max(0.2, (end - start) / 3_600_000);
	const count = Math.min(240, Math.round(hours * 5) + 3);
	for (let i = 0; i < count; i++) {
		const r = rng(`fleet:rblog:${job}:${i}`);
		const t = Math.round(start + ((i + r.next()) / count) * (end - start));
		const pickError = serverErrors.length && r.chance(0.55);
		const e = pickError ? r.pick(serverErrors) : undefined;
		const x = e ? undefined : r.pick(extra);
		const message = e ? (e.msg.split("\n")[0] as string) : (x?.message ?? "");
		const severity = e ? (/^(Sit|Infinite yield)/.test(message) ? "Warning" : "Error") : (x?.severity ?? "Warning");
		out.push({ time: new Date(t).toISOString(), severity, message, count: r.chance(0.3) ? r.int(2, 9) : null, stack: e ? (e.msg.includes("\n") ? e.msg.split("\n").slice(1).join("\n").trim() || null : null) : (x?.stack ?? null), placeVersion, fields: { source: "Server", jobId: job } });
	}
	return out.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
}

route<RobloxServerLogs>("GET", "/v1/roblox/servers/:job/logs", async (req) => {
	const job = req.params.job as string;
	const q = req.query;
	const allowed = new Set(["severity", "search", "order", "pageToken", "placeId", "placeVersion"]);
	for (const key of q.keys()) {
		if (!allowed.has(key)) return fail(400, `unknown parameter ${JSON.stringify(key.slice(0, 40))}`);
		if (q.getAll(key).length > 1) return fail(400, `one ${key}`);
	}
	if (!/^[A-Za-z0-9-]{1,64}$/.test(job)) return fail(400, "bad JobId");
	const severity = (q.get("severity") ?? "").split(",").filter((s) => s !== "");
	if (severity.length > 8 || !severity.every((s) => /^[A-Za-z_]{1,32}$/.test(s))) return fail(400, "severity: up to 8 comma-separated words");
	const search = q.get("search") ?? "";
	if (search.length > SEARCH_MAX) return fail(400, `search: at most ${SEARCH_MAX} characters`);
	const order = q.get("order");
	if (order !== null && order !== "asc" && order !== "desc") return fail(400, "order: asc or desc");
	const pageToken = q.get("pageToken") ?? "";
	if (pageToken.length > 2048 || /[^\x21-\x7e]/.test(pageToken)) return fail(400, "bad pageToken");
	const asId = (name: string): number | undefined | null => {
		const raw = q.get(name);
		if (raw === null) return undefined;
		return /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
	};
	const askedPlace = asId("placeId");
	const askedVersion = asId("placeVersion");
	if (askedPlace === null || askedVersion === null) return fail(400, "placeId and placeVersion are positive integers");
	const m = await model();
	const j = known(m, job);
	const placeId = askedPlace ?? (j ? (j.place ?? PLACE_ID) : undefined);
	const placeVersion = askedVersion ?? (j ? placeVersionOf(m, j) : undefined);
	if (!placeId || !placeVersion) {
		return fail(409, "the server's place version isn't known (its kernel doesn't send `pv` yet): pass placeVersion (and placeId) in the query", { placeId: placeId ?? null, placeVersion: placeVersion ?? null });
	}
	let logs = robloxLogs(m, j, job, placeVersion);
	if (severity.length) logs = logs.filter((l) => severity.some((s) => s.toLowerCase() === (l.severity ?? "").toLowerCase()));
	if (search) logs = logs.filter((l) => (l.message ?? "").toLowerCase().includes(search.toLowerCase()));
	if (order === "asc") logs.reverse();
	const offset = /^p\d{1,6}$/.test(pageToken) ? Number(pageToken.slice(1)) : 0;
	const page = logs.slice(offset, offset + ROBLOX_LOG_PAGE);
	return { jobId: job, placeId, placeVersion, logs: page, nextPageToken: offset + ROBLOX_LOG_PAGE < logs.length ? `p${offset + ROBLOX_LOG_PAGE}` : null, cached: false };
});

// The sidebar's place card (GET /v1/place) ---------------------------------------------------------------------------------

route<PlaceCardInfo>("GET", "/v1/place", async () => {
	const m = await model();
	const playing = m.live.reduce((n, j) => n + (serverInfo(m, j).players ?? 0), 0);
	// No icon and no roblox.com link: the demo's place id is made up, and nothing loads from Roblox.
	return { configured: true, roblox: "ok", cached: true, placeId: PLACE_ID, universeId: UNIVERSE_ID, name: "The Prison", playing, icon: null, url: null };
});
