/**
 * The fleet API: live game-server status, deploy outcomes and alerts, with near-zero query latency (SQLite, one row
 * per server, upserted). Game kernels post to it directly (not through the analytics engine), so it works even when a
 * game's code is broken. Works for Basin games too: run only this part of the server.
 *
 * Portable by design: no Node APIs here (storage through FleetDb, time through `clock`, outgoing webhooks through
 * `fetch`), so it can move to a Cloudflare Worker + D1 later. The timers that call `sweep()` live in the host.
 *
 * `k` in a heartbeat is a private server's access code: accepted, never stored, never returned.
 */
import { DEPLOY_RESULTS } from "../schema.ts";
import { toMs, type ServerInfo } from "../queries/fleet.ts";
import type { FleetDb, SqlValue } from "./db.ts";
import { healthReasons } from "./health.ts";
import type { Notifier } from "./notify.ts";

export const LOST_AFTER_MS = 90_000;
export const STUCK_AFTER_MS = 3 * 60_000;
/** Stop looking for stuck servers this long after a deploy started. */
export const STUCK_WINDOW_MS = 30 * 60_000;
export const KEEP_REPORTS_MS = 30 * 86_400_000;
export const KEEP_ALERTS_MS = 90 * 86_400_000;
/**
 * A closed or lost server's row stays this long (its offline history on the server page: the row, its alerts, reports,
 * debug bundles and metrics rollups), and at most GONE_SERVERS_MAX of them (the oldest gone first).
 */
export const KEEP_GONE_SERVERS_MS = 30 * 86_400_000;
/**
 * Gone rows at most: a 1,250-server fleet that restarts every few hours closes ~10,000 servers a day, so 50,000 is
 * about five days of a big fleet and the whole 30 days of a small one. Live rows never count.
 */
export const GONE_SERVERS_MAX = 50_000;
/** Kernel 0.4.2 metrics history: one point per heartbeat, kept this long per server (the sweep prunes older ones). */
export const KEEP_METRICS_MS = 2 * 3_600_000;
/** And at most this many points per server (heartbeats come every 30 s, sooner on changes; the oldest go first). */
export const METRICS_MAX_POINTS = 720;
/**
 * And at most this many points in all (the sweep drops the oldest past it): a 1,250-server fleet at 720 points each
 * fits, while made-up JobIds (up to TYPETORCH_NEW_JOBS_PER_MINUTE of them a minute) can't grow the table without end.
 */
export const METRICS_MAX_ROWS = 1_000_000;
/**
 * The metrics rollup: every finished 5-minute bucket of the raw points (server_metrics), one row per server and bucket
 * (averages; the slowest second and the most players), kept 30 days so a server's charts cover its whole life after
 * the raw points (2 hours) are gone.
 */
export const ROLLUP_MS = 5 * 60_000;
export const KEEP_ROLLUPS_MS = 30 * 86_400_000;
/**
 * And at most this many rollup rows in all (the oldest go first): 288 a day per server, so ~5 server-years. A big fleet
 * reaches it before 30 days; a made-up JobId adds at most a few rows (its raw points are capped the same way).
 */
export const ROLLUP_MAX_ROWS = 5_000_000;
/** Debug bundles (kernel 0.5.3, POST /v1/fleet/bundle): kept 30 days, at most BUNDLES_PER_JOB per JobId, BUNDLES_MAX_BYTES in all. */
export const KEEP_BUNDLES_MS = 30 * 86_400_000;
export const BUNDLES_PER_JOB = 20;
/** Counted as stored (gzipped) bytes: what the bundles take on disk. */
export const BUNDLES_MAX_BYTES = 500 * 1024 * 1024;
/** A bundle's JSON body at most (the kernel caps its own at ~200 KB); larger posts get 413. */
export const BUNDLE_BODY_MAX = 512 * 1024;
/** Kernel publishes and backup refreshes (the marks table) are rare and useful on long charts: kept a year. */
export const KEEP_MARKS_MS = 365 * 86_400_000;
/** GET marks reads at most this long a window. */
export const MARKS_MAX_WINDOW_MS = 366 * 86_400_000;
/** The marks table keeps at most this many (the newest), checked hourly with the other retention. */
export const MARKS_MAX_ROWS = 5000;

/** What a release did to a branch (the CLI's `k` on POST /v1/fleet/deploy; deploys known only from reports have none). */
export const DEPLOY_KINDS = ["deploy", "rollback", "promote", "resign"] as const;
export type DeployKind = (typeof DEPLOY_KINDS)[number];
/** Marks that aren't a branch release (POST /v1/fleet/mark): a kernel publish (or restore), a backup refresh. */
export const MARK_ONLY_KINDS = ["kernel", "backup"] as const;
export type MarkKind = DeployKind | (typeof MARK_ONLY_KINDS)[number];
export const MARK_KINDS: readonly MarkKind[] = [...DEPLOY_KINDS, ...MARK_ONLY_KINDS];

/**
 * A vertical mark on the explorer's time-series charts (Roblox's "published change"): every release of a branch (the
 * deploys table) and every kernel publish / backup refresh (the marks table), oldest first.
 */
export interface DeployMark {
	/** "deploy:<seq>" or "mark:<id>". */
	id: string;
	kind: MarkKind;
	/** When it happened (the CLI's time, else when the backend heard of it), unix ms. */
	at: number;
	time: string;
	branch: string | null;
	seq: number | null;
	artifact: string | null;
	channel: string | null;
	/** rollback / promote: the build the branch ran before. */
	from: string | null;
	/** kernel: the kernel version. */
	kernel: string | null;
	/** kernel / backup: the place version the publish made. */
	placeVersion: number | null;
	message: string | null;
	/** Releases: deploy reports so far, servers per result (each server's newest report). */
	results?: Record<string, number>;
	/** A release known only from its reports (no CLI post): its kind is a guess ("deploy"). */
	inferred?: boolean;
}

/** The kernel sends critical and warning; the CLI may also post info. */
export type AlertLevel = "critical" | "warning" | "info";
export const ALERT_LEVELS: readonly AlertLevel[] = ["critical", "warning", "info"];

export interface Alert {
	id: number;
	level: AlertLevel;
	code: string;
	message: string;
	job: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	kernel: string | null;
	/** "game" (a kernel), "cli" (e.g. auto_rollback), or "server" (server_lost, server_stuck, fleet_flood). */
	source: "game" | "cli" | "server";
	/** Extra data, e.g. { jobs: [...] } for server_lost / server_stuck. */
	details: Record<string, unknown> | null;
	createdAt: string;
	/** createdAt as unix ms (what the CLI reads). */
	at: number;
	acked: boolean;
	ackedAt: string | null;
	ackedBy: string | null;
}

/** One deploy report as stored (long names; the CLI also reads the kernel's short ones). */
export interface ReportItem {
	seq: number;
	branch: string | null;
	artifact: string | null;
	job: string;
	result: string;
	error: string | null;
	seconds: number | null;
	/** When the server sent it (unix ms; the kernel's `t`), else when it arrived. */
	at: number;
	generation: number | null;
	kernel: string | null;
	players: number | null;
}

export interface FleetReport {
	seq: number | null;
	branch: string | null;
	artifact: string | null;
	/** When the deploy started (POST /v1/fleet/deploy, else its first report). */
	startedAt: string | null;
	firstReport: string | null;
	lastReport: string | null;
	reported: number;
	results: { result: string; servers: number; players: number; medianSeconds: number | null; maxSeconds: number | null }[];
	errors: { error: string; servers: number; exampleJob: string }[];
	/** Live servers on the branch still below the seq (with or without a report). */
	behind: ServerInfo[];
	/** JobIds below the seq with no report, 3+ minutes after the deploy started. */
	stuck: string[];
	/** Every report for the seq, oldest first (a retried swap may report twice; `results` counts each server's newest). */
	reports: ReportItem[];
}

export type FleetEvent =
	| { type: "server"; change: "new" | "update" | "lost" | "closed" | "back"; server: ServerInfo }
	| { type: "report"; seq: number; job: string; result: string; branch: string | null }
	| { type: "deploy"; seq: number; branch: string | null; artifact: string | null; kind?: string | null }
	| { type: "mark"; mark: DeployMark }
	| { type: "alert"; alert: Alert }
	| { type: "alert_ack"; id: number }
	| { type: "bundle"; bundle: BundleSummary };

export class FleetInputError extends Error {
	override name = "FleetInputError";
}

// Input checks ------------------------------------------------------------------------------------------------------------

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FleetInputError("body must be a JSON object");
	return value as Body;
}

function text(b: Body, key: string, max: number, required = false): string | null {
	const v = b[key];
	if (v === undefined || v === null || v === "") {
		if (required) throw new FleetInputError(`${key} is required`);
		return null;
	}
	if (typeof v !== "string" || v.length > max || v.includes("\0")) throw new FleetInputError(`${key} must be a string of at most ${max} characters`);
	return v;
}

function number(b: Body, key: string, required = false): number | null {
	const v = b[key];
	if (v === undefined || v === null) {
		if (required) throw new FleetInputError(`${key} is required`);
		return null;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 9e15) throw new FleetInputError(`${key} must be a number`);
	return v;
}

function int(b: Body, key: string, required = false): number | null {
	const v = number(b, key, required);
	if (v !== null && !Number.isSafeInteger(v)) throw new FleetInputError(`${key} must be an integer`);
	return v;
}

/** The longest JobId accepted (Roblox JobIds are 36-character GUIDs). */
export const JOB_ID_MAX = 64;
const JOB = JOB_ID_MAX;

/** A number sent as a number or a numeric string (`sv`, `x`); anything else is null. */
function loose(b: Body, key: string): number | null {
	const v = b[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
}

// Parsing (the HTTP edge validates; the store only commits what passed) ----------------------------------------------------

/** A heartbeat after validation: the kernel's short keys turned into long names, times in ms. `k` (an access code) is gone. */
export interface ParsedHeartbeat {
	job: string;
	serverType: string | null;
	branch: string | null;
	channel: string | null;
	artifact: string | null;
	players: number | null;
	maxPlayers: number | null;
	startedAt: number | null;
	lastWrite: number | null;
	placeId: number | null;
	experiment: 0 | 1;
	kernel: string | null;
	appliedSeq: number | null;
	generation: number | null;
	health: string | null;
	lastError: string | null;
	serverVersion: number | null;
	sentAt: number | null;
	/** Kernel 0.4.0: the budget summary (`bu`) as JSON text, or null (missing or not a small object of numbers). */
	budget: string | null;
	/** Kernel 0.4.2 (`pf`): server TPS averaged since the last heartbeat, its slowest second, the physics FPS. */
	tps: number | null;
	tpsMin: number | null;
	physFps: number | null;
	/** Kernel 0.4.0 (`bu.mem`): total memory and the Lua heap, MB. */
	memMb: number | null;
	luaMb: number | null;
}

/** One point of a server's metrics history (`GET /v1/fleet/servers/<job>/metrics`); t = when it arrived (unix ms). */
export interface MetricPoint {
	t: number;
	tps: number | null;
	tpsMin: number | null;
	physFps: number | null;
	memMb: number | null;
	luaMb: number | null;
	players: number | null;
}

export interface ParsedReport {
	seq: number;
	job: string;
	result: string;
	branch: string | null;
	artifact: string | null;
	error: string | null;
	seconds: number | null;
	t: number | null;
	generation: number | null;
	kernel: string | null;
	players: number | null;
}

export interface ParsedDeploy {
	seq: number;
	branch: string;
	artifact: string | null;
	channel: string | null;
	t: number | null;
	/** What the release did (`k`); null from older CLIs. */
	kind: DeployKind | null;
	/** The build the branch ran before (`fr`). */
	from: string | null;
	/** The release note (`m`). */
	message: string | null;
}

/** A kernel publish or backup refresh from the CLI (POST /v1/fleet/mark). */
export interface ParsedMark {
	kind: (typeof MARK_ONLY_KINDS)[number];
	branch: string | null;
	seq: number | null;
	artifact: string | null;
	channel: string | null;
	kernel: string | null;
	placeVersion: number | null;
	message: string | null;
	t: number | null;
}

/** What goes on the bus' `heartbeat` topic. */
export type HeartbeatMessage = { kind: "heartbeat"; heartbeat: ParsedHeartbeat } | { kind: "closing"; job: string; heartbeat?: ParsedHeartbeat };
/** What goes on the bus' `deploy` topic. */
export type DeployMessage = { kind: "report"; report: ParsedReport } | { kind: "start"; deploy: ParsedDeploy } | { kind: "mark"; mark: ParsedMark };
export type FleetMessage = HeartbeatMessage | DeployMessage;

/**
 * The kernel's fleet status plus j = JobId (kernel src/server/Fleet.luau): { t = server type, b, c?, a?, n, m, s = start
 * (unix s), u = now (unix s), p, x = 1?, v, q, g, h, e?, sv = 2 }, plus bu? (0.4.0, the budget summary) and pf? (0.4.2,
 * TPS: parseMetrics). `k` (an access code) is ignored. The JobId may also come in the X-TT-Job header. Throws
 * FleetInputError.
 */
export function parseHeartbeat(raw: unknown, jobHeader?: string | null): ParsedHeartbeat {
	const b = asBody(raw);
	const job = text(b, "j", JOB) ?? (jobHeader ? text({ j: jobHeader }, "j", JOB) : null);
	if (!job) throw new FleetInputError("j (the JobId) is required");
	// `t` is the server type (a string); a number there is taken as the send time.
	return {
		job,
		serverType: typeof b.t === "string" ? text(b, "t", 16) : null,
		branch: text(b, "b", 64),
		channel: text(b, "c", 16),
		artifact: text(b, "a", 64),
		players: int(b, "n"),
		maxPlayers: int(b, "m"),
		startedAt: toMs(int(b, "s")),
		lastWrite: toMs(int(b, "u")),
		placeId: int(b, "p"),
		experiment: loose(b, "x") === 1 ? 1 : 0,
		kernel: text(b, "v", 32),
		appliedSeq: int(b, "q"),
		generation: int(b, "g"),
		health: text(b, "h", 16),
		lastError: text(b, "e", 500),
		serverVersion: loose(b, "sv"),
		sentAt: typeof b.t === "number" ? toMs(int(b, "t")) : null,
		budget: parseBudget(b.bu),
		...parseMetrics(b.pf, b.bu),
	};
}

/** The highest TPS / physics FPS kept (servers run at 60, physics up to 240); anything above is not a reading. */
export const METRIC_RATE_MAX = 1000;
/** The highest memory reading kept, MB. */
export const METRIC_MEMORY_MAX = 1_000_000;

/** A finite number in [0, max], else null. */
function reading(value: unknown, max: number): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function fields(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Kernel 0.4.2: the heartbeat's `pf` = { a = TPS average since the last heartbeat, m = its slowest second, p = physics
 * FPS } and the memory 0.4.0 already sends in the budget summary, `bu.mem` = { t = total MB, h = Lua heap MB }. Each
 * value on its own: a missing or malformed one is null (never a reason to refuse the heartbeat).
 */
export function parseMetrics(pf: unknown, bu: unknown): Pick<ParsedHeartbeat, "tps" | "tpsMin" | "physFps" | "memMb" | "luaMb"> {
	const p = fields(pf);
	const mem = fields(fields(bu).mem);
	return {
		tps: reading(p.a, METRIC_RATE_MAX),
		tpsMin: reading(p.m, METRIC_RATE_MAX),
		physFps: reading(p.p, METRIC_RATE_MAX),
		memMb: reading(mem.t, METRIC_MEMORY_MAX),
		luaMb: reading(mem.h, METRIC_MEMORY_MAX),
	};
}

/** The longest budget summary kept (JSON characters). */
export const BUDGET_MAX = 1024;
const BUDGET_KEY = /^[A-Za-z0-9_]{1,16}$/;

/**
 * Kernel 0.4.0 (problem 25): the heartbeat's `bu`, the server's requests per minute next to Roblox's limits:
 * { p, ds: { r, w, l, x, lr, lw, br?, bw? }, ms: { u, l }, h: { r, l }, mg: { p, lp, s, ls }, by: { k, d, a, g, f },
 * mem: { t?, h? } }. Kept as JSON text when it is an object of finite numbers (one level of nested objects), short keys,
 * at most BUDGET_MAX characters; anything else is ignored (null), never a reason to refuse the heartbeat.
 */
export function parseBudget(value: unknown): string | null {
	const clean = (input: unknown, depth: number): Record<string, unknown> | null => {
		if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
		const entries = Object.entries(input as Record<string, unknown>);
		if (entries.length > 16) return null;
		const out: Record<string, unknown> = {};
		for (const [key, inner] of entries) {
			if (!BUDGET_KEY.test(key)) return null;
			if (typeof inner === "number") {
				if (!Number.isFinite(inner) || Math.abs(inner) > 1e12) return null;
				out[key] = inner;
			} else if (depth === 0 && typeof inner === "object" && inner !== null) {
				const nested = clean(inner, 1);
				if (!nested) return null;
				out[key] = nested;
			} else if (inner !== null && inner !== undefined) {
				return null;
			}
		}
		return out;
	};
	const budget = clean(value, 0);
	if (!budget) return null;
	const text = JSON.stringify(budget);
	return text.length <= BUDGET_MAX ? text : null;
}

/** The server is shutting down: the heartbeat body plus `closing = true` (BindToClose); `{ j, t }` alone works too. */
export function parseClosing(raw: unknown, jobHeader?: string | null): { job: string; heartbeat?: ParsedHeartbeat } {
	const b = asBody(raw);
	const job = text(b, "j", JOB) ?? (jobHeader ? text({ j: jobHeader }, "j", JOB) : null);
	if (!job) throw new FleetInputError("j (the JobId) is required");
	return Object.keys(b).some((k) => !["j", "t", "closing"].includes(k)) ? { job, heartbeat: parseHeartbeat(b, jobHeader) } : { job };
}

/** `{s,b,a,j,r,e?,d?,t,g,k,p}` (k here is the kernel version). */
export function parseReport(raw: unknown): ParsedReport {
	const b = asBody(raw);
	const seq = int(b, "s", true) as number;
	const job = text(b, "j", JOB, true) as string;
	const result = text(b, "r", 32, true) as string;
	if (!(DEPLOY_RESULTS as readonly string[]).includes(result)) throw new FleetInputError(`r must be one of ${DEPLOY_RESULTS.join(", ")}`);
	return {
		seq,
		job,
		result,
		branch: text(b, "b", 64),
		artifact: text(b, "a", 64),
		error: text(b, "e", 500),
		seconds: number(b, "d"),
		t: int(b, "t"),
		generation: int(b, "g"),
		kernel: text(b, "k", 32),
		players: int(b, "p"),
	};
}

/**
 * `{s, b, a, ch, t, k?, fr?, m?}` from the CLI when a deploy starts: gives stuck detection a start time and the charts a
 * mark. `k`: deploy | rollback | promote | resign; `fr`: the build before; `m`: the release note; `t`: unix ms or s.
 */
export function parseDeploy(raw: unknown): ParsedDeploy {
	const b = asBody(raw);
	const kind = text(b, "k", 16);
	if (kind !== null && !(DEPLOY_KINDS as readonly string[]).includes(kind)) throw new FleetInputError(`k must be one of ${DEPLOY_KINDS.join(", ")}`);
	return {
		seq: int(b, "s", true) as number,
		branch: text(b, "b", 64, true) as string,
		artifact: text(b, "a", 64),
		channel: text(b, "ch", 16),
		t: int(b, "t"),
		kind: kind as DeployKind | null,
		from: text(b, "fr", 64),
		message: text(b, "m", 200),
	};
}

/**
 * `{k, b?, s?, a?, ch?, v?, pv?, m?, t?}` from the CLI: `k` = kernel (a kernel publish or restore: `v` the kernel version,
 * `pv` the place version) or backup (a backup refresh: the build `b`/`s`/`a` that became the place's backup, `pv`).
 */
export function parseMark(raw: unknown): ParsedMark {
	const b = asBody(raw);
	const kind = text(b, "k", 16, true) as string;
	if (!(MARK_ONLY_KINDS as readonly string[]).includes(kind)) throw new FleetInputError(`k must be one of ${MARK_ONLY_KINDS.join(", ")} (releases go to /v1/fleet/deploy)`);
	return {
		kind: kind as ParsedMark["kind"],
		branch: text(b, "b", 64),
		seq: int(b, "s"),
		artifact: text(b, "a", 64),
		channel: text(b, "ch", 16),
		kernel: text(b, "v", 32),
		placeVersion: int(b, "pv"),
		message: text(b, "m", 200),
		t: int(b, "t"),
	};
}

/** A sender's time (unix s or ms) as ms, or `now` when missing or more than a day away from it (a wrong clock). */
export function markTime(t: number | null, now: number): number {
	const ms = toMs(t);
	return ms !== null && Math.abs(ms - now) <= 86_400_000 ? ms : now;
}

export type NewAlert = Omit<Alert, "id" | "createdAt" | "at" | "acked" | "ackedAt" | "ackedBy" | "details"> & { t?: number | null; details: Record<string, unknown> | null };

/** `{level, code, message, j, b, a, s, t, g, k}` from a kernel (source game) or the CLI (source cli, e.g. auto_rollback). */
export function parseAlert(raw: unknown, source: "game" | "cli" = "game"): NewAlert {
	const b = asBody(raw);
	const level = text(b, "level", 16, true);
	if (!(ALERT_LEVELS as readonly string[]).includes(level ?? "")) throw new FleetInputError("level must be critical, warning or info");
	const code = text(b, "code", 64, true) as string;
	if (!/^[a-z0-9_.-]+$/.test(code)) throw new FleetInputError("code must be lowercase letters, digits, _ . -");
	// The CLI posts with j = "cli" (cli/src/fleet.ts alertBody); auto_rollback only ever comes from the CLI.
	const fromCli = source === "cli" || code === "auto_rollback" || b.j === "cli";
	return {
		level: level as AlertLevel,
		code,
		message: text(b, "message", 500, true) as string,
		job: b.j === "cli" ? null : text(b, "j", JOB),
		branch: text(b, "b", 64),
		artifact: text(b, "a", 64),
		seq: int(b, "s"),
		t: int(b, "t"),
		generation: int(b, "g"),
		kernel: text(b, "k", 32),
		source: fromCli ? "cli" : "game",
		details: parseAlertDetails(b.d),
	};
}

/** An alert's `d` at most: this many keys, and this many bytes as JSON. */
export const ALERT_DETAILS_MAX_KEYS = 16;
export const ALERT_DETAILS_MAX_BYTES = 4096;
/** And each string value at most this many bytes (UTF-8). */
export const ALERT_DETAIL_TEXT_MAX = 1000;
const DETAIL_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const utf8 = new TextEncoder();

/**
 * Kernel 0.5.2: an alert's `d`, a FLAT object of strings, numbers and booleans (deploy_failed: { stage, error,
 * attempts, reason, kind, loadSeconds, swapSeconds, transient, rollbackTo }; from 0.5.3 `bundle`, the id of the debug
 * bundle that follows). Kept when it is a plain object of at most ALERT_DETAILS_MAX_KEYS such values (strings at most
 * ALERT_DETAIL_TEXT_MAX bytes) and at most ALERT_DETAILS_MAX_BYTES of JSON; anything else is null, never a 400 (the
 * alert itself matters more than its details).
 */
export function parseAlertDetails(value: unknown): Record<string, string | number | boolean> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
	const entries = Object.entries(value as Record<string, unknown>);
	if (!entries.length || entries.length > ALERT_DETAILS_MAX_KEYS) return null;
	const out: Record<string, string | number | boolean> = {};
	for (const [key, inner] of entries) {
		if (!DETAIL_KEY.test(key)) return null;
		if (typeof inner === "string") {
			if (inner.includes("\0") || utf8.encode(inner).length > ALERT_DETAIL_TEXT_MAX) return null;
		} else if (typeof inner === "number") {
			if (!Number.isFinite(inner)) return null;
		} else if (typeof inner !== "boolean") return null;
		out[key] = inner;
	}
	return utf8.encode(JSON.stringify(out)).length <= ALERT_DETAILS_MAX_BYTES ? out : null;
}

// Debug bundles (kernel 0.5.3) --------------------------------------------------------------------------------------------

/** What a bundle's `code` may be: an alert code, start_failed, health_rollback, players_moved, closing, manual. */
const BUNDLE_CODE = /^[a-z0-9_.-]{1,64}$/;
/** Bundle ids are made by the kernel: 32 lowercase hex characters. */
export const BUNDLE_ID = /^[0-9a-f]{32}$/;
/** The bundle sections that must be objects, and the ones that must be arrays, when present (their insides are opaque). */
const BUNDLE_OBJECTS = ["failure", "server", "deploy", "fallback", "playerLogs"] as const;
const BUNDLE_ARRAYS = ["alerts", "players", "serverLog"] as const;

/** A debug bundle's summary: the top-level fields, never its sections (GET .../bundles, the server page's list). */
export interface BundleSummary {
	id: string;
	job: string;
	/** What made the kernel send it: an alert code, start_failed, health_rollback, players_moved, closing, manual. */
	code: string;
	level: AlertLevel;
	message: string;
	/** Sent from BindToClose (after a failure in the server's last 10 minutes). */
	closing: boolean;
	/** When the kernel made it (its `t`), else when it arrived, unix ms. */
	at: number;
	time: string;
	kernel: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	/** Players in the bundle (`players` entries). */
	players: number;
	/** The posted JSON, bytes. */
	size: number;
	/** `failure.stage` and `failure.error`, clipped (the list and the timeline show them without reading the body). */
	stage: string | null;
	error: string | null;
}

/** One generation start from a bundle's `deploy.history` (the timeline's swaps; the kernel keeps the last 30). */
export interface BundleSwap {
	/** unix ms (the history entry's ISO `at`). */
	at: number;
	name: string | null;
	artifact: string | null;
	branch: string | null;
	/** Why it started: boot, deploy, rollback, ... */
	reason: string | null;
	loadSeconds: number | null;
	swapSeconds: number | null;
	/** The bundle it came from. */
	bundle: string;
}

/** A bundle after validation: the summary fields, the swaps, and the body as JSON text (stored gzipped). */
export interface ParsedBundle {
	id: string;
	job: string;
	code: string;
	level: AlertLevel;
	message: string;
	closing: boolean;
	t: number | null;
	kernel: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	players: number;
	stage: string | null;
	error: string | null;
	swaps: Omit<BundleSwap, "bundle">[];
	body: string;
	size: number;
}

const clip = (v: unknown, max: number): string | null => (typeof v === "string" && v !== "" ? v.replaceAll("\0", "").slice(0, max) : null);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * POST /v1/fleet/bundle (kernel 0.5.3): `{ v: 1, id, j, t, k, b, a, s, g, code, level, message, closing, failure, server,
 * deploy, fallback, alerts, players, serverLog, playerLogs }`. Only the top-level summary fields are read; every section
 * is opaque JSON (checked to be an object or an array, never trusted, never run: the explorer shows it as text).
 * `size` is the posted JSON's length in bytes (the HTTP edge refuses more than BUNDLE_BODY_MAX). Throws FleetInputError.
 */
export function parseBundle(raw: unknown, size?: number): ParsedBundle {
	const b = asBody(raw);
	if (b.v !== 1) throw new FleetInputError("v must be 1 (the bundle format)");
	const id = typeof b.id === "string" && BUNDLE_ID.test(b.id) ? b.id : null;
	if (!id) throw new FleetInputError("id must be 32 lowercase hex characters");
	const job = text(b, "j", JOB, true) as string;
	const code = text(b, "code", 64, true) as string;
	if (!BUNDLE_CODE.test(code)) throw new FleetInputError("code must be lowercase letters, digits, _ . -");
	const level = text(b, "level", 16, true);
	if (!(ALERT_LEVELS as readonly string[]).includes(level ?? "")) throw new FleetInputError("level must be critical, warning or info");
	if (b.closing !== undefined && b.closing !== null && typeof b.closing !== "boolean") throw new FleetInputError("closing must be true or false");
	for (const key of BUNDLE_OBJECTS) {
		const v = b[key];
		if (v !== undefined && v !== null && (typeof v !== "object" || Array.isArray(v))) throw new FleetInputError(`${key} must be an object`);
	}
	for (const key of BUNDLE_ARRAYS) {
		const v = b[key];
		if (v !== undefined && v !== null && !Array.isArray(v)) throw new FleetInputError(`${key} must be an array`);
	}
	const failure = fields(b.failure);
	const body = JSON.stringify(b);
	return {
		id,
		job,
		code,
		level: level as AlertLevel,
		message: text(b, "message", 2000) ?? "",
		closing: b.closing === true,
		t: int(b, "t"),
		kernel: text(b, "k", 32),
		branch: text(b, "b", 64),
		artifact: text(b, "a", 64),
		seq: int(b, "s"),
		generation: int(b, "g"),
		players: Array.isArray(b.players) ? b.players.length : 0,
		stage: clip(failure.stage, 64),
		error: clip(failure.error, 500),
		swaps: bundleSwaps(fields(b.deploy).history),
		body,
		size: size ?? utf8.encode(body).length,
	};
}

/** The generation starts in a bundle's `deploy.history` ({ name, artifactId, branch, at (ISO), reason, loadSeconds, swapSeconds }), at most 30. */
function bundleSwaps(history: unknown): Omit<BundleSwap, "bundle">[] {
	if (!Array.isArray(history)) return [];
	const out: Omit<BundleSwap, "bundle">[] = [];
	for (const entry of history.slice(-30)) {
		const e = fields(entry);
		const at = typeof e.at === "string" ? Date.parse(e.at) : typeof e.at === "number" ? toMs(e.at) : null;
		if (at === null || !Number.isFinite(at)) continue;
		out.push({ at, name: clip(e.name, 64), artifact: clip(e.artifactId, 64), branch: clip(e.branch, 64), reason: clip(e.reason, 32), loadSeconds: finite(e.loadSeconds), swapSeconds: finite(e.swapSeconds) });
	}
	return out;
}

// Rows -> API shapes ------------------------------------------------------------------------------------------------------

interface ServerRow {
	job: string;
	server_type: string | null;
	branch: string | null;
	channel: string | null;
	artifact: string | null;
	players: number | null;
	max_players: number | null;
	started_at: number | null;
	last_write: number | null;
	place_id: number | null;
	experiment: number | null;
	kernel: string | null;
	applied_seq: number | null;
	generation: number | null;
	health: string | null;
	last_error: string | null;
	server_version: number | null;
	budget: string | null;
	tps: number | null;
	tps_min: number | null;
	phys_fps: number | null;
	mem_mb: number | null;
	lua_mb: number | null;
	first_seen: number;
	last_seen: number;
	closed_at: number | null;
	lost_at: number | null;
}

/** Columns read for servers. The access code is not among them because it is never stored. */
const SERVER_COLUMNS =
	"job, server_type, branch, channel, artifact, players, max_players, started_at, last_write, place_id, experiment, kernel, applied_seq, generation, health, last_error, server_version, budget, tps, tps_min, phys_fps, mem_mb, lua_mb, first_seen, last_seen, closed_at, lost_at";

/** Kernel 0.4.0 and 0.4.2 columns, added to fleet files made before them (name, type). */
const ADDED_SERVER_COLUMNS: [string, string][] = [
	["budget", "TEXT"],
	["tps", "REAL"],
	["tps_min", "REAL"],
	["phys_fps", "REAL"],
	["mem_mb", "REAL"],
	["lua_mb", "REAL"],
];

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function serverInfo(r: ServerRow, now: number): ServerInfo {
	return {
		job: r.job,
		serverType: r.server_type,
		lastSeen: new Date(r.last_seen).toISOString(),
		ageSeconds: Math.max(0, Math.round((now - r.last_seen) / 1000)),
		branch: r.branch,
		channel: r.channel,
		artifact: r.artifact,
		players: r.players,
		maxPlayers: r.max_players,
		startedAt: iso(r.started_at),
		lastWrite: iso(r.last_write),
		placeId: r.place_id,
		experiment: r.experiment === 1,
		kernel: r.kernel,
		appliedSeq: r.applied_seq,
		generation: r.generation,
		health: r.health,
		lastError: r.last_error,
		serverVersion: r.server_version,
		budget: budgetOf(r.budget),
		tps: r.tps ?? null,
		tpsMin: r.tps_min ?? null,
		physFps: r.phys_fps ?? null,
		memMb: r.mem_mb ?? null,
		luaMb: r.lua_mb ?? null,
		reasons: healthReasons({ health: r.health, tps: r.tps ?? null, memMb: r.mem_mb ?? null, lastSeen: r.last_seen, closed: r.closed_at !== null && r.closed_at !== undefined }, now),
	};
}

/** The stored budget summary (JSON text) as an object, or null. */
function budgetOf(text: string | null | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Plans/25: what the server page shows for a JobId of any age. "gone": no servers row (past KEEP_GONE_SERVERS_MS or
 * GONE_SERVERS_MAX) but alerts, deploy reports, debug bundles or metrics rollups still mention the JobId.
 */
export type ServerState = "live" | "closed" | "lost" | "gone" | "unknown";

/** The time range a server's metrics cover (raw points and 5-minute rollups), unix ms; nulls when it has none. */
export interface MetricsRange {
	from: number | null;
	to: number | null;
}

/**
 * A server's offline history (GET /v1/fleet/servers/<job>): what the fleet still holds about the JobId after the server
 * is gone, newest first. Also for live servers (the page's Debug bundles and Timeline).
 */
export interface ServerHistory {
	/** Alerts with this JobId (at most 200). */
	alerts: Alert[];
	/** Its deploy reports (at most 200). */
	reports: ReportItem[];
	/** Its debug bundles' summaries (at most BUNDLES_PER_JOB are kept). */
	bundles: BundleSummary[];
	/** Generation starts from its bundles' deploy history, one per (at, name). */
	swaps: BundleSwap[];
	metrics: MetricsRange;
}

/** A gone server in the Fleet page's "Recently gone" list (GET /v1/fleet/servers?gone=1). */
export type GoneServer = ServerInfo & { closedAt: string | null; lostAt: string | null; state: "closed" | "lost"; firstSeen: string };

interface AlertRow {
	id: number;
	level: AlertLevel;
	code: string;
	message: string;
	job: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	kernel: string | null;
	source: Alert["source"];
	details: string | null;
	created: number;
	acked_at: number | null;
	acked_by: string | null;
}

function alertOf(r: AlertRow): Alert {
	let details: Record<string, unknown> | null = null;
	if (r.details) {
		try {
			details = JSON.parse(r.details);
		} catch {}
	}
	return {
		id: r.id,
		level: r.level,
		code: r.code,
		message: r.message,
		job: r.job,
		branch: r.branch,
		artifact: r.artifact,
		seq: r.seq,
		generation: r.generation,
		kernel: r.kernel,
		source: r.source,
		details,
		createdAt: new Date(r.created).toISOString(),
		at: r.created,
		acked: r.acked_at !== null,
		ackedAt: iso(r.acked_at),
		ackedBy: r.acked_by,
	};
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
	job TEXT PRIMARY KEY, server_type TEXT, branch TEXT, channel TEXT, artifact TEXT, players INTEGER, max_players INTEGER, started_at INTEGER,
	last_write INTEGER, place_id INTEGER, experiment INTEGER, kernel TEXT, applied_seq INTEGER, generation INTEGER, health TEXT,
	last_error TEXT, server_version INTEGER, sent_at INTEGER, budget TEXT, tps REAL, tps_min REAL, phys_fps REAL, mem_mb REAL, lua_mb REAL,
	first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, closed_at INTEGER, lost_at INTEGER);
CREATE INDEX IF NOT EXISTS servers_branch ON servers (branch, last_seen);
CREATE INDEX IF NOT EXISTS servers_seen ON servers (last_seen);
CREATE INDEX IF NOT EXISTS servers_open ON servers (last_seen) WHERE closed_at IS NULL AND lost_at IS NULL;
CREATE INDEX IF NOT EXISTS servers_gone ON servers (COALESCE(closed_at, lost_at)) WHERE closed_at IS NOT NULL OR lost_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS server_metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, t INTEGER NOT NULL, tps REAL, tps_min REAL, phys_fps REAL, mem_mb REAL, lua_mb REAL,
	players INTEGER);
CREATE INDEX IF NOT EXISTS server_metrics_job ON server_metrics (job, id);
CREATE INDEX IF NOT EXISTS server_metrics_t ON server_metrics (t);
CREATE TABLE IF NOT EXISTS server_metrics_5m (
	id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, tps REAL, tps_min REAL, phys_fps REAL,
	mem_mb REAL, lua_mb REAL, players INTEGER, UNIQUE (job, t));
CREATE INDEX IF NOT EXISTS server_metrics_5m_t ON server_metrics_5m (t);
CREATE TABLE IF NOT EXISTS bundles (
	id TEXT PRIMARY KEY, job TEXT NOT NULL, code TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, closing INTEGER NOT NULL, at INTEGER NOT NULL,
	kernel TEXT, branch TEXT, artifact TEXT, seq INTEGER, generation INTEGER, players INTEGER NOT NULL, size INTEGER NOT NULL, stage TEXT, error TEXT,
	swaps TEXT, stored INTEGER NOT NULL, received INTEGER NOT NULL, body BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS bundles_job ON bundles (job, received);
CREATE INDEX IF NOT EXISTS bundles_received ON bundles (received);
CREATE TABLE IF NOT EXISTS reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, branch TEXT, artifact TEXT, job TEXT NOT NULL, result TEXT NOT NULL,
	error TEXT, seconds REAL, t INTEGER, generation INTEGER, kernel TEXT, players INTEGER, received INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reports_seq ON reports (seq, job);
CREATE INDEX IF NOT EXISTS reports_artifact ON reports (artifact);
CREATE INDEX IF NOT EXISTS reports_received ON reports (received);
CREATE INDEX IF NOT EXISTS reports_job ON reports (job, id);
CREATE TABLE IF NOT EXISTS alerts (
	id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, job TEXT, branch TEXT,
	artifact TEXT, seq INTEGER, t INTEGER, generation INTEGER, kernel TEXT, source TEXT NOT NULL, details TEXT, created INTEGER NOT NULL,
	acked_at INTEGER, acked_by TEXT);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created);
CREATE INDEX IF NOT EXISTS alerts_job ON alerts (job, id);
CREATE TABLE IF NOT EXISTS deploys (
	seq INTEGER PRIMARY KEY, branch TEXT, artifact TEXT, channel TEXT, t INTEGER, received INTEGER NOT NULL, stuck_at INTEGER);
CREATE INDEX IF NOT EXISTS deploys_received ON deploys (received);
CREATE TABLE IF NOT EXISTS marks (
	id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, branch TEXT, seq INTEGER, artifact TEXT, channel TEXT, kernel TEXT,
	place_version INTEGER, message TEXT, at INTEGER NOT NULL, received INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS marks_at ON marks (at);
`;

/** Deploys columns added after a fleet file was first made (the release kinds for the chart marks). */
const ADDED_DEPLOY_COLUMNS: [string, string][] = [
	["kind", "TEXT"],
	["from_artifact", "TEXT"],
	["message", "TEXT"],
];

/**
 * Adds the columns a fleet file made by an older version lacks. Two servers can open the same file at the same moment
 * (a rolling deploy's handover), so a column the other one added in between ("duplicate column name") is fine.
 */
async function addColumns(db: FleetDb, table: string, columns: [string, string][]): Promise<void> {
	const have = new Set((await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name));
	for (const [name, type] of columns) {
		if (have.has(name)) continue;
		try {
			await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
		} catch (error) {
			if (!/duplicate column name/i.test(String((error as Error)?.message ?? error))) throw error;
		}
	}
}

export interface FleetServiceOptions {
	db: FleetDb;
	clock?: () => number;
	/** Standalone use: notified directly. In the backend the notifier subscribes to the bus instead. */
	notifier?: Notifier;
	/** Called with each stored alert (the backend publishes it on the bus' `alert` topic). */
	publishAlert?: (alert: Alert) => Promise<void> | void;
	log?: (line: string) => void;
	/** The metrics history's total cap (default METRICS_MAX_ROWS; tests use a small one). */
	metricsMaxRows?: number;
	/** The rollups' total cap (default ROLLUP_MAX_ROWS). */
	rollupMaxRows?: number;
	/** Gone servers kept at most (default GONE_SERVERS_MAX). */
	goneServersMax?: number;
	/** Debug bundles' stored bytes at most (default BUNDLES_MAX_BYTES). */
	bundlesMaxBytes?: number;
}

/** gzip / gunzip through the web's CompressionStream (Bun, Node 18+, Workers: no Node APIs here). */
async function gzip(text: string): Promise<Uint8Array> {
	return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
	return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

interface BundleRow {
	id: string;
	job: string;
	code: string;
	level: AlertLevel;
	message: string;
	closing: number;
	at: number;
	kernel: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	players: number;
	size: number;
	stage: string | null;
	error: string | null;
}

const BUNDLE_COLUMNS = "id, job, code, level, message, closing, at, kernel, branch, artifact, seq, generation, players, size, stage, error";

function bundleOf(r: BundleRow): BundleSummary {
	return {
		id: r.id,
		job: r.job,
		code: r.code,
		level: r.level,
		message: r.message,
		closing: r.closing === 1,
		at: r.at,
		time: new Date(r.at).toISOString(),
		kernel: r.kernel,
		branch: r.branch,
		artifact: r.artifact,
		seq: r.seq,
		generation: r.generation,
		players: r.players,
		size: r.size,
		stage: r.stage,
		error: r.error,
	};
}

type MetricRow = { t: number; tps: number | null; tps_min: number | null; phys_fps: number | null; mem_mb: number | null; lua_mb: number | null; players: number | null };
const pointOf = (r: MetricRow): MetricPoint => ({ t: r.t, tps: r.tps, tpsMin: r.tps_min, physFps: r.phys_fps, memMb: r.mem_mb, luaMb: r.lua_mb, players: r.players });

export class FleetService {
	private readonly db: FleetDb;
	private readonly clock: () => number;
	private readonly listeners = new Set<(event: FleetEvent) => void>();
	private lastRetention = 0;
	/** The metrics rollup's progress: buckets before this (unix ms) are rolled up (read from the table on the first sweep). */
	private rolledUntil: number | undefined;

	private constructor(private readonly options: FleetServiceOptions) {
		this.db = options.db;
		this.clock = options.clock ?? Date.now;
	}

	static async open(options: FleetServiceOptions): Promise<FleetService> {
		const service = new FleetService(options);
		await options.db.exec(SCHEMA);
		// Kernel 0.4.0 (the budget summary) and 0.4.2 (TPS, memory): columns added to files made before them.
		await addColumns(options.db, "servers", ADDED_SERVER_COLUMNS);
		// Release kinds for the deploy marks, to deploys tables made before them.
		await addColumns(options.db, "deploys", ADDED_DEPLOY_COLUMNS);
		return service;
	}

	// Events (Server-Sent Events) ---------------------------------------------------------------------------------------

	subscribe(listener: (event: FleetEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get subscribers(): number {
		return this.listeners.size;
	}

	private emit(event: FleetEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {}
		}
	}

	// Ingest (the bus' fleet-store subscriber; the CLI's deploy and auto_rollback come the same way) -----------------------

	/** Commits a validated message from the bus' `heartbeat` or `deploy` topic. */
	async apply(message: FleetMessage): Promise<void> {
		if (message.kind === "heartbeat") await this.applyHeartbeat(message.heartbeat);
		else if (message.kind === "closing") await this.applyClosing(message.job, message.heartbeat);
		else if (message.kind === "report") await this.applyReport(message.report);
		else if (message.kind === "mark") await this.applyMark(message.mark);
		else await this.applyDeploy(message.deploy);
	}

	/** Validate and commit in one call (tests, embedding). */
	heartbeat(raw: unknown, jobHeader?: string | null): Promise<void> {
		return this.applyHeartbeat(parseHeartbeat(raw, jobHeader));
	}

	async applyHeartbeat(p: ParsedHeartbeat): Promise<void> {
		const now = this.clock();
		const row: SqlValue[] = [p.job, p.serverType, p.branch, p.channel, p.artifact, p.players, p.maxPlayers, p.startedAt, p.lastWrite, p.placeId, p.experiment, p.kernel, p.appliedSeq, p.generation, p.health, p.lastError, p.serverVersion, p.sentAt, p.budget, p.tps, p.tpsMin, p.physFps, p.memMb, p.luaMb, now, now];
		const job = p.job;
		const before = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		// One commit: the row, the history point (kernel 0.4.2: one per heartbeat) and the per-server cap on points.
		await this.db.transaction((tx) => {
			tx.run(
				`INSERT INTO servers (job, server_type, branch, channel, artifact, players, max_players, started_at, last_write, place_id, experiment, kernel, applied_seq, generation, health, last_error, server_version, sent_at, budget, tps, tps_min, phys_fps, mem_mb, lua_mb, first_seen, last_seen) ` +
					`VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job) DO UPDATE SET server_type = excluded.server_type, branch = excluded.branch, channel = excluded.channel, ` +
					`artifact = excluded.artifact, players = excluded.players, max_players = excluded.max_players, started_at = excluded.started_at, ` +
					`last_write = excluded.last_write, place_id = excluded.place_id, experiment = excluded.experiment, kernel = excluded.kernel, ` +
					`applied_seq = excluded.applied_seq, generation = excluded.generation, health = excluded.health, last_error = excluded.last_error, ` +
					`server_version = excluded.server_version, sent_at = excluded.sent_at, budget = excluded.budget, tps = excluded.tps, tps_min = excluded.tps_min, ` +
					`phys_fps = excluded.phys_fps, mem_mb = excluded.mem_mb, lua_mb = excluded.lua_mb, last_seen = excluded.last_seen, closed_at = NULL, lost_at = NULL`,
				row,
			);
			tx.run("INSERT INTO server_metrics (job, t, tps, tps_min, phys_fps, mem_mb, lua_mb, players) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [job, now, p.tps, p.tpsMin, p.physFps, p.memMb, p.luaMb, p.players]);
			tx.run("DELETE FROM server_metrics WHERE job = ? AND id <= (SELECT id FROM server_metrics WHERE job = ? ORDER BY id DESC LIMIT 1 OFFSET ?)", [job, job, METRICS_MAX_POINTS]);
		});
		if (!this.listeners.size) return;
		const after = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		if (!after) return;
		let change: "new" | "update" | "back" | undefined;
		if (!before || before.closed_at !== null) change = "new";
		else if (before.lost_at !== null) change = "back";
		else {
			const keys: (keyof ServerRow)[] = ["branch", "artifact", "players", "applied_seq", "generation", "health", "last_error", "kernel", "experiment"];
			if (keys.some((k) => before[k] !== after[k])) change = "update";
		}
		if (change) this.emit({ type: "server", change, server: serverInfo(after, now) });
	}

	report(raw: unknown): Promise<void> {
		return this.applyReport(parseReport(raw));
	}

	async applyReport(r: ParsedReport): Promise<void> {
		const now = this.clock();
		await this.db.run(
			"INSERT INTO reports (seq, branch, artifact, job, result, error, seconds, t, generation, kernel, players, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[r.seq, r.branch, r.artifact, r.job, r.result, r.error, r.seconds, r.t, r.generation, r.kernel, r.players, now],
		);
		// A report also tells us a deploy happened (the CLI's POST /v1/fleet/deploy may not have come).
		await this.db.run("INSERT OR IGNORE INTO deploys (seq, branch, artifact, channel, t, received) VALUES (?, ?, ?, NULL, NULL, ?)", [r.seq, r.branch, r.artifact, now]);
		this.emit({ type: "report", seq: r.seq, job: r.job, result: r.result, branch: r.branch });
	}

	deploy(raw: unknown): Promise<void> {
		return this.applyDeploy(parseDeploy(raw));
	}

	async applyDeploy(d: ParsedDeploy): Promise<void> {
		const now = this.clock();
		// `t` is stored as ms (the CLI's clock; replaced by now when a day or more off).
		const t = d.t === null ? null : markTime(d.t, now);
		await this.db.run(
			"INSERT INTO deploys (seq, branch, artifact, channel, t, received, kind, from_artifact, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(seq) DO UPDATE SET branch = excluded.branch, " +
				"artifact = COALESCE(excluded.artifact, deploys.artifact), channel = excluded.channel, t = excluded.t, received = MIN(deploys.received, excluded.received), " +
				"kind = COALESCE(excluded.kind, deploys.kind), from_artifact = COALESCE(excluded.from_artifact, deploys.from_artifact), message = COALESCE(excluded.message, deploys.message)",
			[d.seq, d.branch, d.artifact, d.channel, t, now, d.kind, d.from, d.message],
		);
		this.emit({ type: "deploy", seq: d.seq, branch: d.branch, artifact: d.artifact, kind: d.kind });
	}

	mark(raw: unknown): Promise<DeployMark> {
		return this.applyMark(parseMark(raw));
	}

	/** A kernel publish or backup refresh: stored in marks, sent on the SSE stream. */
	async applyMark(m: ParsedMark): Promise<DeployMark> {
		const now = this.clock();
		const at = markTime(m.t, now);
		const { lastId } = await this.db.run(
			"INSERT INTO marks (kind, branch, seq, artifact, channel, kernel, place_version, message, at, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[m.kind, m.branch, m.seq, m.artifact, m.channel, m.kernel, m.placeVersion, m.message, at, now],
		);
		const mark: DeployMark = {
			id: `mark:${lastId}`,
			kind: m.kind,
			at,
			time: new Date(at).toISOString(),
			branch: m.branch,
			seq: m.seq,
			artifact: m.artifact,
			channel: m.channel,
			from: null,
			kernel: m.kernel,
			placeVersion: m.placeVersion,
			message: m.message,
		};
		this.emit({ type: "mark", mark });
		return mark;
	}

	/**
	 * Chart marks in [since, until): releases (the deploys table, with each one's report results) and kernel / backup
	 * marks, oldest first; the newest `limit` when there are more. With `branch`, releases of other branches are left
	 * out (kernel and backup marks are place-wide and always kept).
	 */
	async marks(options: { since?: number; until?: number; branch?: string; kinds?: readonly string[]; limit?: number } = {}): Promise<DeployMark[]> {
		const now = this.clock();
		const until = options.until ?? now + 60_000;
		const since = options.since ?? until - 30 * 86_400_000;
		if (since >= until) throw new FleetInputError("since must be before until");
		if (until - since > MARKS_MAX_WINDOW_MS) throw new FleetInputError("marks: at most a 366-day window");
		const limit = Math.min(Math.max(1, options.limit ?? 500), 2000);
		for (const kind of options.kinds ?? []) if (!(MARK_KINDS as readonly string[]).includes(kind)) throw new FleetInputError(`kinds must be of ${MARK_KINDS.join(", ")}`);
		const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
		const want = (kind: string) => !kinds || kinds.has(kind);
		const out: DeployMark[] = [];
		if (DEPLOY_KINDS.some(want)) {
			// `t` is the CLI's time (ms; older rows may hold seconds), else the first report's arrival.
			const rows = await this.db.all<{ seq: number; branch: string | null; artifact: string | null; channel: string | null; t: number | null; received: number; kind: string | null; from_artifact: string | null; message: string | null }>(
				"SELECT seq, branch, artifact, channel, t, received, kind, from_artifact, message FROM deploys WHERE received >= ? AND received < ?" +
					(options.branch ? " AND branch = ?" : "") +
					" ORDER BY received DESC LIMIT 5000",
				[since - 86_400_000, until + 86_400_000, ...(options.branch ? [options.branch] : [])],
			);
			const kept = rows.map((r) => ({ r, at: toMs(r.t) ?? r.received })).filter(({ r, at }) => at >= since && at < until && want(r.kind ?? "deploy"));
			const results = new Map<number, Record<string, number>>();
			const seqs = kept.map(({ r }) => r.seq);
			for (let i = 0; i < seqs.length; i += 500) {
				const chunk = seqs.slice(i, i + 500);
				const counts = await this.db.all<{ seq: number; result: string; servers: number }>(
					`SELECT r.seq AS seq, r.result AS result, COUNT(*) AS servers FROM reports r JOIN (SELECT seq, job, MAX(id) AS id FROM reports WHERE seq IN (${chunk.map(() => "?").join(", ")}) GROUP BY seq, job) l ON l.id = r.id GROUP BY r.seq, r.result`,
					chunk,
				);
				for (const c of counts) results.set(c.seq, { ...results.get(c.seq), [c.result]: c.servers });
			}
			for (const { r, at } of kept) {
				out.push({
					id: `deploy:${r.seq}`,
					kind: (r.kind as DeployKind | null) ?? "deploy",
					at,
					time: new Date(at).toISOString(),
					branch: r.branch,
					seq: r.seq,
					artifact: r.artifact,
					channel: r.channel,
					from: r.from_artifact,
					kernel: null,
					placeVersion: null,
					message: r.message,
					results: results.get(r.seq) ?? {},
					...(r.kind === null ? { inferred: true } : {}),
				});
			}
		}
		const markKinds = MARK_ONLY_KINDS.filter(want);
		if (markKinds.length) {
			const rows = await this.db.all<{ id: number; kind: string; branch: string | null; seq: number | null; artifact: string | null; channel: string | null; kernel: string | null; place_version: number | null; message: string | null; at: number }>(
				`SELECT id, kind, branch, seq, artifact, channel, kernel, place_version, message, at FROM marks WHERE at >= ? AND at < ? AND kind IN (${markKinds.map(() => "?").join(", ")}) ORDER BY at DESC LIMIT 5000`,
				[since, until, ...markKinds],
			);
			for (const r of rows) {
				out.push({
					id: `mark:${r.id}`,
					kind: r.kind as MarkKind,
					at: r.at,
					time: new Date(r.at).toISOString(),
					branch: r.branch,
					seq: r.seq,
					artifact: r.artifact,
					channel: r.channel,
					from: null,
					kernel: r.kernel,
					placeVersion: r.place_version,
					message: r.message,
				});
			}
		}
		out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id, "en", { numeric: true }));
		return out.length > limit ? out.slice(out.length - limit) : out;
	}

	closing(raw: unknown, jobHeader?: string | null): Promise<void> {
		const c = parseClosing(raw, jobHeader);
		return this.applyClosing(c.job, c.heartbeat);
	}

	/** The server is shutting down (no "server lost" alert for it). */
	async applyClosing(job: string, heartbeat?: ParsedHeartbeat): Promise<void> {
		if (heartbeat) await this.applyHeartbeat(heartbeat);
		const now = this.clock();
		await this.db.run("UPDATE servers SET closed_at = ?, last_seen = ? WHERE job = ?", [now, now, job]);
		const row = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		if (row) this.emit({ type: "server", change: "closed", server: serverInfo(row, now) });
	}

	/** Validates and stores an alert; stored alerts go to the SSE stream, the notifier and the bus' `alert` topic. */
	async alert(raw: unknown, source: "game" | "cli" = "game"): Promise<Alert> {
		return this.addAlert(parseAlert(raw, source));
	}

	/**
	 * Kernel 0.5.3: stores a debug bundle (the body gzipped, the summary in columns). A repeat id stores nothing
	 * (`duplicate`): the kernel may send one again when its first try timed out.
	 */
	async bundle(raw: unknown, size?: number): Promise<{ id: string; duplicate: boolean }> {
		return this.addBundle(parseBundle(raw, size));
	}

	async addBundle(p: ParsedBundle): Promise<{ id: string; duplicate: boolean }> {
		if (await this.db.first<{ x: number }>("SELECT 1 AS x FROM bundles WHERE id = ?", [p.id])) return { id: p.id, duplicate: true };
		const now = this.clock();
		const at = markTime(p.t, now);
		const body = await gzip(p.body);
		const inserted = await this.db.transaction((tx) => {
			const { changes } = tx.run(
				"INSERT OR IGNORE INTO bundles (id, job, code, level, message, closing, at, kernel, branch, artifact, seq, generation, players, size, stage, error, swaps, stored, received, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[p.id, p.job, p.code, p.level, p.message, p.closing ? 1 : 0, at, p.kernel, p.branch, p.artifact, p.seq, p.generation, p.players, p.size, p.stage, p.error, p.swaps.length ? JSON.stringify(p.swaps) : null, body.length, now, body],
			);
			// At most BUNDLES_PER_JOB per JobId (the kernel sends 11 in a server's life at most; this bounds a made-up one).
			if (changes) tx.run("DELETE FROM bundles WHERE job = ? AND id NOT IN (SELECT id FROM bundles WHERE job = ? ORDER BY received DESC, at DESC LIMIT ?)", [p.job, p.job, BUNDLES_PER_JOB]);
			return changes > 0;
		});
		if (!inserted) return { id: p.id, duplicate: true };
		const row = await this.db.first<BundleRow>(`SELECT ${BUNDLE_COLUMNS} FROM bundles WHERE id = ?`, [p.id]);
		if (row) this.emit({ type: "bundle", bundle: bundleOf(row) });
		return { id: p.id, duplicate: false };
	}

	/** A JobId's debug bundles, newest first (summaries only). */
	async bundles(job: string): Promise<BundleSummary[]> {
		return (await this.db.all<BundleRow>(`SELECT ${BUNDLE_COLUMNS} FROM bundles WHERE job = ? ORDER BY at DESC, received DESC LIMIT ?`, [job, BUNDLES_PER_JOB * 2])).map(bundleOf);
	}

	/**
	 * One debug bundle: the summary and the posted JSON as `body`. Without `playerLogs` (the read-only web role) the
	 * body comes without `playerLogs` (what each player's client logged is for owners) and says so (`playerLogsHidden`).
	 */
	async bundleById(id: string, options: { playerLogs: boolean }): Promise<(BundleSummary & { body: Record<string, unknown>; playerLogsHidden?: true }) | null> {
		if (!BUNDLE_ID.test(id)) return null;
		const row = await this.db.first<BundleRow & { body: Uint8Array }>(`SELECT ${BUNDLE_COLUMNS}, body FROM bundles WHERE id = ?`, [id]);
		if (!row) return null;
		let body: Record<string, unknown> = {};
		try {
			const value = JSON.parse(await gunzip(row.body));
			if (typeof value === "object" && value !== null && !Array.isArray(value)) body = value;
		} catch {}
		if (!options.playerLogs) {
			const hidden = "playerLogs" in body;
			delete body.playerLogs;
			return { ...bundleOf(row), body, ...(hidden ? { playerLogsHidden: true as const } : {}) };
		}
		return { ...bundleOf(row), body };
	}

	/** Whether a servers row exists for this JobId (live, closed or lost; rows go KEEP_GONE_SERVERS_MS after a server is gone). */
	async knows(job: string): Promise<boolean> {
		return (await this.db.first<{ x: number }>("SELECT 1 AS x FROM servers WHERE job = ?", [job])) !== undefined;
	}

	/**
	 * `fleet_flood` (critical, source server): the host's new-JobId limit refused a never-seen JobId. The host raises
	 * it once per limiter window; `example` is the first refused JobId.
	 */
	async flood(info: { limit: number; windowSeconds: number; example: string }): Promise<Alert> {
		return this.addAlert({
			level: "critical",
			code: "fleet_flood",
			message:
				`over ${info.limit} never-seen JobIds in ${info.windowSeconds} s: more new ones get 429 until the window ends; known servers are not limited. ` +
				"Either a fleet this large restarted at once, or something with the ingest token is sending made-up JobIds",
			job: null,
			branch: null,
			artifact: null,
			seq: null,
			generation: null,
			kernel: null,
			source: "server",
			details: { limit: info.limit, windowSeconds: info.windowSeconds, example: info.example.slice(0, JOB) },
		});
	}

	private async addAlert(a: NewAlert): Promise<Alert> {
		const now = this.clock();
		const { lastId } = await this.db.run(
			"INSERT INTO alerts (level, code, message, job, branch, artifact, seq, t, generation, kernel, source, details, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[a.level, a.code, a.message, a.job, a.branch, a.artifact, a.seq, a.t ?? null, a.generation, a.kernel, a.source, a.details ? JSON.stringify(a.details) : null, now],
		);
		const alert = alertOf((await this.db.first<AlertRow>("SELECT * FROM alerts WHERE id = ?", [lastId])) as AlertRow);
		this.emit({ type: "alert", alert });
		this.options.notifier?.notify(alert);
		await this.options.publishAlert?.(alert);
		return alert;
	}

	// Reads (admin) -----------------------------------------------------------------------------------------------------

	async servers(options: { branch?: string; maxAgeSeconds?: number } = {}): Promise<{ servers: ServerInfo[]; players: number; byArtifact: { artifact: string; servers: number; players: number }[]; byHealth: Record<string, number> }> {
		const now = this.clock();
		const since = now - (options.maxAgeSeconds ?? LOST_AFTER_MS / 1000) * 1000;
		const params: SqlValue[] = [since];
		let sql = `SELECT ${SERVER_COLUMNS} FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ?`;
		if (options.branch) {
			sql += " AND branch = ?";
			params.push(options.branch);
		}
		const rows = await this.db.all<ServerRow>(`${sql} ORDER BY last_seen DESC, job`, params);
		const servers = rows.map((r) => serverInfo(r, now));
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
		};
	}

	/** The PlaceId of the server heard from last (open or not), or null while no heartbeat carried one. */
	async latestPlaceId(): Promise<number | null> {
		const rows = await this.db.all<{ place_id: number | null }>("SELECT place_id FROM servers WHERE place_id IS NOT NULL AND place_id > 0 ORDER BY last_seen DESC LIMIT 1");
		const id = rows[0]?.place_id;
		return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
	}

	/**
	 * Kernel 0.4.2: a server's metrics history (one point per heartbeat, the last KEEP_METRICS_MS, at most
	 * METRICS_MAX_POINTS), oldest first; `since` (unix ms) keeps only later points. An unknown JobId has no points.
	 * A `since` older than the raw window adds the 5-minute rollups (KEEP_ROLLUPS_MS) up to the bucket the raw window
	 * starts in: `rolledUntil` says where (points before it are one per ROLLUP_MS bucket, at the bucket's start).
	 */
	async metrics(job: string, options: { since?: number } = {}): Promise<{ points: MetricPoint[]; rolledUntil?: number }> {
		const rawFrom = this.clock() - KEEP_METRICS_MS;
		const from = Math.max(options.since ?? 0, rawFrom);
		const rows = await this.db.all<MetricRow>("SELECT t, tps, tps_min, phys_fps, mem_mb, lua_mb, players FROM server_metrics WHERE job = ? AND t > ? ORDER BY id", [job, from]);
		if (options.since === undefined || options.since >= rawFrom) return { points: rows.map(pointOf) };
		// The bucket the raw window starts in is left to the raw points (a rollup of it would overlap them).
		const cut = Math.floor(rawFrom / ROLLUP_MS) * ROLLUP_MS;
		const rolled = await this.db.all<MetricRow>("SELECT t, tps, tps_min, phys_fps, mem_mb, lua_mb, players FROM server_metrics_5m WHERE job = ? AND t > ? AND t < ? ORDER BY t", [job, options.since - ROLLUP_MS, cut]);
		return { points: [...rolled.map(pointOf), ...rows.map(pointOf)], rolledUntil: cut };
	}

	/**
	 * Plans/25 (the server page): one server by JobId, whatever its age, its state and its history (alerts, deploy
	 * reports, debug bundles, swaps, the metrics' time range). Without a servers row (gone past KEEP_GONE_SERVERS_MS or
	 * GONE_SERVERS_MAX) the state is "gone" while any of that still mentions the JobId, else "unknown".
	 */
	async server(job: string): Promise<{ server: (ServerInfo & { closedAt: string | null; lostAt: string | null; firstSeen: string }) | null; state: ServerState; history: ServerHistory }> {
		const now = this.clock();
		const row = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		const history = await this.history(job);
		if (!row) {
			const any = history.alerts.length || history.reports.length || history.bundles.length || history.metrics.from !== null;
			return { server: null, state: any ? "gone" : "unknown", history };
		}
		const state: ServerState = row.closed_at !== null ? "closed" : row.lost_at !== null || now - row.last_seen > LOST_AFTER_MS ? "lost" : "live";
		return { server: { ...serverInfo(row, now), closedAt: iso(row.closed_at), lostAt: iso(row.lost_at), firstSeen: new Date(row.first_seen).toISOString() }, state, history };
	}

	/** What the fleet holds about a JobId, newest first (the server page's Timeline, Debug bundles and charts). */
	async history(job: string): Promise<ServerHistory> {
		const alerts = (await this.db.all<AlertRow>("SELECT * FROM alerts WHERE job = ? ORDER BY id DESC LIMIT 200", [job])).map(alertOf);
		const reports = await this.db.all<{ seq: number; branch: string | null; artifact: string | null; job: string; result: string; error: string | null; seconds: number | null; t: number | null; received: number; generation: number | null; kernel: string | null; players: number | null }>(
			"SELECT seq, branch, artifact, job, result, error, seconds, t, received, generation, kernel, players FROM reports WHERE job = ? ORDER BY id DESC LIMIT 200",
			[job],
		);
		const bundleRows = await this.db.all<BundleRow & { swaps: string | null }>(`SELECT ${BUNDLE_COLUMNS}, swaps FROM bundles WHERE job = ? ORDER BY at DESC, received DESC LIMIT ?`, [job, BUNDLES_PER_JOB * 2]);
		// Each bundle carries the server's whole generation history so far: one swap per (at, name), from the newest bundle.
		const swaps = new Map<string, BundleSwap>();
		for (const r of bundleRows) {
			let list: Omit<BundleSwap, "bundle">[] = [];
			try {
				list = r.swaps ? JSON.parse(r.swaps) : [];
			} catch {}
			for (const swap of Array.isArray(list) ? list : []) {
				const key = `${swap.at}\u0000${swap.name ?? ""}`;
				if (!swaps.has(key)) swaps.set(key, { ...swap, bundle: r.id });
			}
		}
		const raw = await this.db.first<{ lo: number | null; hi: number | null }>("SELECT MIN(t) AS lo, MAX(t) AS hi FROM server_metrics WHERE job = ?", [job]);
		const rolled = await this.db.first<{ lo: number | null; hi: number | null }>("SELECT MIN(t) AS lo, MAX(t) AS hi FROM server_metrics_5m WHERE job = ?", [job]);
		const los = [raw?.lo, rolled?.lo].filter((v): v is number => typeof v === "number");
		const his = [raw?.hi, rolled?.hi === null || rolled?.hi === undefined ? null : rolled.hi + ROLLUP_MS].filter((v): v is number => typeof v === "number");
		return {
			alerts,
			reports: reports.map((r) => ({ seq: r.seq, branch: r.branch, artifact: r.artifact, job: r.job, result: r.result, error: r.error, seconds: r.seconds, at: toMs(r.t) ?? r.received, generation: r.generation, kernel: r.kernel, players: r.players })),
			bundles: bundleRows.map(bundleOf),
			swaps: [...swaps.values()].sort((a, b) => b.at - a.at),
			metrics: { from: los.length ? Math.min(...los) : null, to: his.length ? Math.max(...his) : null },
		};
	}

	/** Closed and lost servers, the most recently gone first (the Fleet page's "Recently gone"). */
	async goneServers(options: { branch?: string; limit?: number } = {}): Promise<{ servers: GoneServer[] }> {
		const now = this.clock();
		const params: SqlValue[] = [];
		let sql = `SELECT ${SERVER_COLUMNS} FROM servers WHERE (closed_at IS NOT NULL OR lost_at IS NOT NULL)`;
		if (options.branch) {
			sql += " AND branch = ?";
			params.push(options.branch);
		}
		params.push(Math.min(Math.max(1, options.limit ?? 200), 1000));
		const rows = await this.db.all<ServerRow>(`${sql} ORDER BY COALESCE(closed_at, lost_at) DESC LIMIT ?`, params);
		return {
			servers: rows.map((r) => ({
				...serverInfo(r, now),
				closedAt: iso(r.closed_at),
				lostAt: iso(r.lost_at),
				state: r.closed_at !== null ? "closed" : "lost",
				firstSeen: new Date(r.first_seen).toISOString(),
			})),
		};
	}

	async reports(options: { seq?: number; artifact?: string; latest?: boolean; branch?: string } = {}): Promise<FleetReport> {
		const now = this.clock();
		let seq: number | null = options.seq ?? null;
		if (seq === null && options.artifact) {
			seq = (await this.db.first<{ s: number | null }>("SELECT MAX(seq) AS s FROM (SELECT seq FROM reports WHERE artifact = ? UNION ALL SELECT seq FROM deploys WHERE artifact = ?)", [options.artifact, options.artifact]))?.s ?? null;
		}
		if (seq === null) {
			const branch = options.branch ?? null;
			seq =
				(await this.db.first<{ s: number | null }>("SELECT MAX(seq) AS s FROM (SELECT seq, branch FROM reports UNION ALL SELECT seq, branch FROM deploys) WHERE ? IS NULL OR branch = ?", [branch, branch]))?.s ?? null;
		}
		const empty: FleetReport = { seq, branch: options.branch ?? null, artifact: null, startedAt: null, firstReport: null, lastReport: null, reported: 0, results: [], errors: [], behind: [], stuck: [], reports: [] };
		if (seq === null) return empty;
		const deploy = await this.db.first<{ branch: string | null; artifact: string | null; received: number }>("SELECT branch, artifact, received FROM deploys WHERE seq = ?", [seq]);
		const latest = await this.db.all<{ job: string; result: string; error: string | null; seconds: number | null; players: number | null; received: number; branch: string | null; artifact: string | null }>(
			"SELECT r.job, r.result, r.error, r.seconds, r.players, r.received, r.branch, r.artifact FROM reports r JOIN (SELECT job, MAX(id) AS id FROM reports WHERE seq = ? GROUP BY job) l ON l.id = r.id",
			[seq],
		);
		const branch = options.branch ?? deploy?.branch ?? latest.find((r) => r.branch)?.branch ?? null;
		const all = await this.db.all<{ seq: number; branch: string | null; artifact: string | null; job: string; result: string; error: string | null; seconds: number | null; t: number | null; received: number; generation: number | null; kernel: string | null; players: number | null }>(
			"SELECT seq, branch, artifact, job, result, error, seconds, t, received, generation, kernel, players FROM reports WHERE seq = ? ORDER BY id",
			[seq],
		);
		const groups = new Map<string, { servers: number; players: number; seconds: number[] }>();
		const errors = new Map<string, { servers: number; exampleJob: string }>();
		for (const r of latest) {
			const g = groups.get(r.result) ?? { servers: 0, players: 0, seconds: [] };
			g.servers++;
			g.players += r.players ?? 0;
			if (r.seconds !== null) g.seconds.push(r.seconds);
			groups.set(r.result, g);
			if (r.error) {
				const e = errors.get(r.error) ?? { servers: 0, exampleJob: r.job };
				e.servers++;
				errors.set(r.error, e);
			}
		}
		const order = (r: string) => {
			const i = (DEPLOY_RESULTS as readonly string[]).indexOf(r);
			return i < 0 ? 99 : i;
		};
		const params: SqlValue[] = [now - LOST_AFTER_MS, seq];
		let sql = `SELECT ${SERVER_COLUMNS} FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ? AND (applied_seq IS NULL OR applied_seq < ?)`;
		if (branch) {
			sql += " AND branch = ?";
			params.push(branch);
		}
		const behindRows = await this.db.all<ServerRow>(`${sql} ORDER BY job`, params);
		const reported = new Set(latest.map((r) => r.job));
		const started = deploy?.received ?? (latest.length ? Math.min(...latest.map((r) => r.received)) : null);
		const stuck = started !== null && now - started >= STUCK_AFTER_MS ? behindRows.filter((r) => !reported.has(r.job)).map((r) => r.job) : [];
		const times = latest.map((r) => r.received);
		const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
		return {
			seq,
			branch,
			artifact: deploy?.artifact ?? latest.find((r) => r.artifact)?.artifact ?? null,
			startedAt: iso(started),
			firstReport: times.length ? iso(Math.min(...times)) : null,
			lastReport: times.length ? iso(Math.max(...times)) : null,
			reported: latest.length,
			results: [...groups]
				.map(([result, g]) => ({ result, servers: g.servers, players: g.players, medianSeconds: round1(median(g.seconds)), maxSeconds: round1(g.seconds.length ? Math.max(...g.seconds) : null) }))
				.sort((a, b) => order(a.result) - order(b.result)),
			errors: [...errors].map(([error, e]) => ({ error, ...e })).sort((a, b) => b.servers - a.servers),
			behind: behindRows.map((r) => serverInfo(r, now)),
			stuck,
			reports: all.map((r) => ({
				seq: r.seq,
				branch: r.branch,
				artifact: r.artifact,
				job: r.job,
				result: r.result,
				error: r.error,
				seconds: r.seconds,
				at: toMs(r.t) ?? r.received,
				generation: r.generation,
				kernel: r.kernel,
				players: r.players,
			})),
		};
	}

	async alerts(options: { since?: number; level?: AlertLevel; unacked?: boolean; limit?: number } = {}): Promise<Alert[]> {
		const where: string[] = ["created >= ?"];
		const params: SqlValue[] = [options.since ?? 0];
		if (options.level) {
			where.push("level = ?");
			params.push(options.level);
		}
		if (options.unacked) where.push("acked_at IS NULL");
		params.push(Math.min(Math.max(1, options.limit ?? 200), 1000));
		return (await this.db.all<AlertRow>(`SELECT * FROM alerts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, params)).map(alertOf);
	}

	async ack(id: number, by?: string): Promise<boolean> {
		const { changes } = await this.db.run("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL", [this.clock(), by ? by.slice(0, 64) : null, id]);
		if (changes) this.emit({ type: "alert_ack", id });
		return changes > 0;
	}

	// Server-side alerts and upkeep (the host calls this every ~10 s) ---------------------------------------------------

	async sweep(): Promise<{ lost: number; stuck: number }> {
		const now = this.clock();
		// server_lost: no heartbeat for 90 s and no closing message.
		const lostRows = await this.db.all<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen < ?`, [now - LOST_AFTER_MS]);
		const groups = new Map<string, ServerRow[]>();
		for (const r of lostRows) {
			// Only if still unmarked: during a deploy's handover two servers sweep the same file, and one alert is enough.
			const marked = await this.db.run("UPDATE servers SET lost_at = ? WHERE job = ? AND lost_at IS NULL AND closed_at IS NULL", [now, r.job]);
			if (!marked.changes) continue;
			this.emit({ type: "server", change: "lost", server: serverInfo({ ...r, lost_at: now }, now) });
			const key = `${r.branch ?? ""}\u0000${r.artifact ?? ""}`;
			groups.set(key, [...(groups.get(key) ?? []), r]);
		}
		for (const rows of groups.values()) {
			const { branch, artifact } = rows[0];
			const n = rows.length;
			await this.addAlert({
				level: n >= 3 ? "critical" : "warning",
				code: "server_lost",
				message: `${n} server${n === 1 ? "" : "s"}${branch ? ` on ${branch}` : ""} stopped sending heartbeats for 90 s without closing`,
				job: n === 1 ? rows[0].job : null,
				branch,
				artifact,
				seq: null,
				generation: null,
				kernel: null,
				source: "server",
				details: { jobs: rows.slice(0, 50).map((r) => r.job), count: n },
			});
		}
		// server_stuck: 3+ minutes after a deploy started, live servers still below its seq and with no report for it.
		let stuck = 0;
		const deploys = await this.db.all<{ seq: number; branch: string | null; artifact: string | null; received: number }>(
			"SELECT seq, branch, artifact, received FROM deploys WHERE stuck_at IS NULL AND received <= ? AND received >= ?",
			[now - STUCK_AFTER_MS, now - STUCK_WINDOW_MS],
		);
		for (const d of deploys) {
			if (!d.branch) continue;
			const rows = await this.db.all<{ job: string }>(
				"SELECT s.job FROM servers s WHERE s.closed_at IS NULL AND s.lost_at IS NULL AND s.last_seen >= ? AND s.branch = ? AND (s.applied_seq IS NULL OR s.applied_seq < ?) " +
					"AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.seq = ? AND r.job = s.job) ORDER BY s.job",
				[now - LOST_AFTER_MS, d.branch, d.seq, d.seq],
			);
			if (!rows.length) continue;
			if (!(await this.db.run("UPDATE deploys SET stuck_at = ? WHERE seq = ? AND stuck_at IS NULL", [now, d.seq])).changes) continue;
			stuck += rows.length;
			await this.addAlert({
				level: "warning",
				code: "server_stuck",
				message: `${rows.length} server${rows.length === 1 ? " is" : "s are"} still below seq ${d.seq} on ${d.branch} with no deploy report after 3 minutes`,
				job: rows.length === 1 ? rows[0].job : null,
				branch: d.branch,
				artifact: d.artifact,
				seq: d.seq,
				generation: null,
				kernel: null,
				source: "server",
				details: { jobs: rows.slice(0, 100).map((r) => r.job), count: rows.length },
			});
		}
		// The 5-minute rollup of the raw points, before they go (every sweep; a bucket is rolled once it has ended).
		await this.rollup(now);
		// Kernel 0.4.2: metrics history older than KEEP_METRICS_MS (every sweep: the index on t keeps it cheap).
		await this.db.run("DELETE FROM server_metrics WHERE t <= ?", [now - KEEP_METRICS_MS]);
		// And the total cap: ids only grow, so the rows at or below MAX(id) - cap are the oldest (both lookups use the key).
		const cap = this.options.metricsMaxRows ?? METRICS_MAX_ROWS;
		const top = await this.db.first<{ id: number | null }>("SELECT MAX(id) AS id FROM server_metrics");
		if (top?.id && top.id > cap) await this.db.run("DELETE FROM server_metrics WHERE id <= ?", [top.id - cap]);
		if (now - this.lastRetention > 3_600_000) {
			this.lastRetention = now;
			await this.db.run("DELETE FROM reports WHERE received < ?", [now - KEEP_REPORTS_MS]);
			await this.db.run("DELETE FROM alerts WHERE created < ?", [now - KEEP_ALERTS_MS]);
			await this.db.run("DELETE FROM deploys WHERE received < ?", [now - KEEP_ALERTS_MS]);
			await this.db.run("DELETE FROM marks WHERE received < ?", [now - KEEP_MARKS_MS]);
			// And at most MARKS_MAX_ROWS (the newest): marks come from the CLI at 30 a minute at most, so a leaked game key
			// can add a few thousand an hour, never an unbounded table.
			await this.db.run("DELETE FROM marks WHERE id <= (SELECT MAX(id) FROM marks) - ?", [MARKS_MAX_ROWS]);
			await this.db.run("DELETE FROM servers WHERE (closed_at IS NOT NULL AND closed_at < ?) OR (lost_at IS NOT NULL AND lost_at < ?)", [now - KEEP_GONE_SERVERS_MS, now - KEEP_GONE_SERVERS_MS]);
			// And at most GONE_SERVERS_MAX gone rows, the most recently gone kept (live rows never count).
			await this.db.run(
				"DELETE FROM servers WHERE job IN (SELECT job FROM servers WHERE closed_at IS NOT NULL OR lost_at IS NOT NULL ORDER BY COALESCE(closed_at, lost_at) DESC LIMIT -1 OFFSET ?)",
				[this.options.goneServersMax ?? GONE_SERVERS_MAX],
			);
			// The rollups: 30 days, and the total cap (ids only grow, as for the raw points; an upsert keeps a row's id).
			await this.db.run("DELETE FROM server_metrics_5m WHERE t < ?", [now - KEEP_ROLLUPS_MS]);
			const rollupCap = this.options.rollupMaxRows ?? ROLLUP_MAX_ROWS;
			const topRollup = await this.db.first<{ id: number | null }>("SELECT MAX(id) AS id FROM server_metrics_5m");
			if (topRollup?.id && topRollup.id > rollupCap) await this.db.run("DELETE FROM server_metrics_5m WHERE id <= ?", [topRollup.id - rollupCap]);
			await this.pruneBundles(now);
		}
		return { lost: [...groups.values()].reduce((n, rows) => n + rows.length, 0), stuck };
	}

	/**
	 * Debug bundle retention (hourly): KEEP_BUNDLES_MS, at most BUNDLES_PER_JOB per JobId (also checked on every insert),
	 * and at most bundlesMaxBytes stored in all; the oldest go first.
	 */
	async pruneBundles(now = this.clock()): Promise<void> {
		await this.db.run("DELETE FROM bundles WHERE received < ?", [now - KEEP_BUNDLES_MS]);
		await this.db.run("DELETE FROM bundles WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY job ORDER BY received DESC, at DESC) AS n FROM bundles) WHERE n > ?)", [BUNDLES_PER_JOB]);
		await this.db.run("DELETE FROM bundles WHERE id IN (SELECT id FROM (SELECT id, SUM(stored) OVER (ORDER BY received DESC, id DESC) AS total FROM bundles) WHERE total > ?)", [
			this.options.bundlesMaxBytes ?? BUNDLES_MAX_BYTES,
		]);
	}

	/**
	 * Rolls the raw points of every bucket that ended since the last call into server_metrics_5m (one row per JobId and
	 * bucket: averages, the slowest second, the most players). A point's t is when it arrived, so an ended bucket gets no
	 * more points. Idempotent (an upsert per bucket): two servers sharing the file in a handover write the same rows.
	 * After a restart it goes on from the newest rollup, but never from before the raw window (a bucket partly pruned
	 * would overwrite a whole one with less).
	 */
	async rollup(now = this.clock()): Promise<void> {
		const until = Math.floor(now / ROLLUP_MS) * ROLLUP_MS;
		if (this.rolledUntil === undefined) {
			const top = await this.db.first<{ t: number | null }>("SELECT MAX(t) AS t FROM server_metrics_5m");
			const floor = Math.ceil((now - KEEP_METRICS_MS) / ROLLUP_MS) * ROLLUP_MS;
			this.rolledUntil = Math.max(top?.t != null ? top.t + ROLLUP_MS : 0, floor);
		}
		if (until <= this.rolledUntil) return;
		await this.db.run(
			"INSERT INTO server_metrics_5m (job, t, n, tps, tps_min, phys_fps, mem_mb, lua_mb, players) " +
				`SELECT job, (t / ${ROLLUP_MS}) * ${ROLLUP_MS} AS bucket, COUNT(*), AVG(tps), MIN(tps_min), AVG(phys_fps), AVG(mem_mb), AVG(lua_mb), MAX(players) FROM server_metrics WHERE t >= ? AND t < ? GROUP BY job, bucket ` +
				"ON CONFLICT(job, t) DO UPDATE SET n = excluded.n, tps = excluded.tps, tps_min = excluded.tps_min, phys_fps = excluded.phys_fps, mem_mb = excluded.mem_mb, lua_mb = excluded.lua_mb, players = excluded.players",
			[this.rolledUntil, until],
		);
		this.rolledUntil = until;
	}

	async counts(): Promise<{ servers: number; reports: number; alerts: number; unacked: number }> {
		const now = this.clock();
		const r = await this.db.first<{ servers: number; reports: number; alerts: number; unacked: number }>(
			"SELECT (SELECT COUNT(*) FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ?) AS servers, (SELECT COUNT(*) FROM reports) AS reports, " +
				"(SELECT COUNT(*) FROM alerts) AS alerts, (SELECT COUNT(*) FROM alerts WHERE acked_at IS NULL) AS unacked",
			[now - LOST_AFTER_MS],
		);
		return r ?? { servers: 0, reports: 0, alerts: 0, unacked: 0 };
	}

	async close(): Promise<void> {
		this.listeners.clear();
		await this.db.close();
	}
}
