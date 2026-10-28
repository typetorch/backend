/**
 * The backend alert evaluator: once a minute it reads a few numbers from what the backend already has (the error
 * tables, the fleet's servers and deploys, the metrics rings, the data folder's disk), runs the rules (checks.ts) and
 * raises what fires through the fleet's alert store, so backend alerts show on the Fleet page, stream, go on the bus and
 * to the webhook like the kernel's (source "server").
 *
 * Cheap on purpose (a 1 GB VPS): every query uses an index and returns a handful of rows, only the rules that are on
 * run, the samples it keeps are bounded (one a minute for 6 hours), and a tick never overlaps the previous one. The disk
 * history is one row an hour in SQLite (30 days), so a restart doesn't lose it. Rules that need analytics are skipped
 * while analytics aren't running.
 *
 * Dedup and throttle: the same rule and subject (a finding's key) is raised once per `repeatMinutes` (checked against
 * the alerts table too, so a restart or a deploy's second server doesn't raise it again), and at most `perHour` backend
 * alerts go out per hour (the rest are counted).
 */
import { statfsSync } from "node:fs";
import type { FleetDb } from "../fleet/db.ts";
import type { AlertLevel } from "../fleet/service.ts";
import {
	check5xx,
	checkCcuDrop,
	checkDiskGrowth,
	checkDiskLow,
	checkErrorSpike,
	checkFleetSilent,
	checkIngestStopped,
	checkLatency,
	checkLoopLag,
	checkMemory,
	checkNewErrorKinds,
	type DeployInfo,
	type DiskNow,
	type DiskSample,
	type Finding,
	type KindWindow,
	type MinuteStat,
	type NewKind,
	type Sample,
	type Verdict,
} from "./checks.ts";
import { RULES, RULES_BY_ID, type BackendAlertSettings, type RuleId } from "./rules.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** How often the rules run. */
export const ALERT_TICK_MS = MINUTE;
/** Samples kept: the longest window a rule looks back (fleet silent: 4 h + the hour before it) plus slack. */
const SAMPLES_KEEP_MS = 6 * HOUR;
const DISK_KEEP_MS = 30 * 86_400_000;
/** Error kinds looked at per tick, at most. */
const KINDS_MAX = 20;
/** Findings raised per rule and tick, at most (the rest wait for the next tick, if they still fire). */
const FINDINGS_PER_TICK = 5;
const LOST_AFTER_MS = 90_000;
const DEDUP_MAX = 2000;

const SCHEMA = "CREATE TABLE IF NOT EXISTS backend_disk_samples (hour INTEGER PRIMARY KEY, used INTEGER NOT NULL, free INTEGER NOT NULL, total INTEGER NOT NULL);";

/** What the evaluator raises; the host stores it as a fleet alert (source "server"). */
export interface RaisedAlert {
	level: AlertLevel;
	code: string;
	message: string;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	details: Record<string, unknown>;
}

/** The metrics the health rules read (ServerMetrics.view() fits). */
export interface MetricsSource {
	minutes: { at: number; requests: number; status: { "5xx": number }; latency: { p99: number | null }; memory: { rssMb: number } | null; loopLagMs: number | null }[];
	totals: { rowsIn: number };
}

export interface EvaluatorOptions {
	/** The backend's SQLite (the error tables, and the fleet tables when the fleet runs). */
	db: FleetDb;
	/** Whether the fleet tables exist (the fleet part runs). */
	fleet: boolean;
	/** Whether analytics ingest is running right now (the warehouse is open). */
	analytics: () => boolean;
	metrics: () => MetricsSource;
	/** The data folder's disk; null where statfs isn't available. */
	disk: () => DiskNow | null;
	settings: () => BackendAlertSettings;
	raise: (alert: RaisedAlert) => Promise<unknown>;
	clock?: () => number;
	log?: (line: string) => void;
}

export type RuleState = "off" | "unavailable" | "waiting" | "ok" | "firing";

export interface RuleStatus {
	id: RuleId;
	state: RuleState;
	note: string;
	lastRaisedAt: string | null;
}

export interface EvaluatorStatus {
	on: boolean;
	tickSeconds: number;
	lastRunAt: string | null;
	/** The last tick's time, ms. */
	lastRunMs: number | null;
	raised: number;
	deduped: number;
	throttled: number;
	failed: number;
	rules: RuleStatus[];
}

/** The data folder's disk through statfs (null when the runtime or the file system can't say). */
export function diskOf(path: string): DiskNow | null {
	try {
		const s = statfsSync(path);
		const total = Number(s.blocks) * Number(s.bsize);
		return total > 0 ? { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: total } : null;
	} catch {
		return null;
	}
}

export class BackendAlerts {
	private readonly o: EvaluatorOptions;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private readonly samples: Sample[] = [];
	private lastIngest: number | null = null;
	private lastRowsIn: number | undefined;
	private readonly lastRaised = new Map<string, number>();
	private readonly sentTimes: number[] = [];
	private readonly verdicts = new Map<RuleId, { state: RuleState; note: string }>();
	private readonly raisedAt = new Map<RuleId, number>();
	private diskSamples: DiskSample[] | undefined;
	private lastDiskHour = -1;
	private running: Promise<void> | undefined;
	private ready: Promise<void> | undefined;
	private lastRun: { at: number; ms: number } | undefined;
	readonly stats = { raised: 0, deduped: 0, throttled: 0, failed: 0 };

	constructor(options: EvaluatorOptions) {
		this.o = options;
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
	}

	/** One evaluation; a tick while the last one still runs returns that one. */
	tick(): Promise<void> {
		this.running ??= this.run().finally(() => (this.running = undefined));
		return this.running;
	}

	status(): EvaluatorStatus {
		const settings = this.o.settings();
		return {
			on: settings.on,
			tickSeconds: ALERT_TICK_MS / 1000,
			lastRunAt: this.lastRun ? new Date(this.lastRun.at).toISOString() : null,
			lastRunMs: this.lastRun ? this.lastRun.ms : null,
			...this.stats,
			rules: RULES.map((r) => {
				const at = this.raisedAt.get(r.id);
				const v = !settings.on || !settings.rules[r.id].on ? { state: "off" as const, note: !settings.on ? "backend alerts are off" : "off" } : (this.unavailable(r.id) ?? this.verdicts.get(r.id) ?? { state: "waiting" as const, note: "not run yet" });
				return { id: r.id, state: v.state, note: v.note, lastRaisedAt: at ? new Date(at).toISOString() : null };
			}),
		};
	}

	/** Why a rule can't run here, or undefined. */
	private unavailable(id: RuleId): { state: "unavailable"; note: string } | undefined {
		const def = RULES_BY_ID.get(id);
		if (def?.needs.includes("fleet") && !this.o.fleet) return { state: "unavailable", note: "needs the fleet part" };
		if (def?.needs.includes("analytics") && !this.o.analytics()) return { state: "unavailable", note: "analytics aren't running" };
		return undefined;
	}

	private async run(): Promise<void> {
		const started = performance.now();
		const now = this.clock();
		const settings = this.o.settings();
		this.ready ??= this.o.db.exec(SCHEMA);
		await this.ready;
		const on = (id: RuleId) => settings.on && settings.rules[id].on && !this.unavailable(id);
		const q = (id: RuleId) => settings.rules[id].params as never;

		// What every tick keeps: one sample (cheap: two indexed reads), so the windows are there when a rule is turned on.
		const metrics = this.o.metrics();
		const sample = await this.sample(now, metrics.totals.rowsIn);
		const runs: [RuleId, () => Promise<Verdict> | Verdict][] = [];
		const minutes = (): MinuteStat[] => metrics.minutes.map((m) => ({ at: m.at, requests: m.requests, errors5xx: m.status["5xx"], p99: m.latency.p99, rssMb: m.memory?.rssMb ?? null, loopLagMs: m.loopLagMs }));
		const tickMs = ALERT_TICK_MS;

		runs.push(["errorSpike", async () => checkErrorSpike(await this.kindWindows(now, q("errorSpike")), q("errorSpike"))]);
		runs.push([
			"errorNewAfterDeploy",
			async () => {
				const deploy = await this.latestDeploy();
				return checkNewErrorKinds(deploy, deploy ? await this.newKinds(deploy, now, q("errorNewAfterDeploy")) : [], now, q("errorNewAfterDeploy"));
			},
		]);
		runs.push(["ccuDrop", () => checkCcuDrop(this.samples, now, q("ccuDrop"), tickMs)]);
		runs.push(["fleetSilent", () => checkFleetSilent(this.samples, sample.lastHeartbeat, this.o.analytics() ? this.lastIngest : undefined, now, q("fleetSilent"))]);
		runs.push(["ingestStopped", () => checkIngestStopped(this.samples, now, q("ingestStopped"), tickMs)]);
		runs.push(["backendLatency", () => checkLatency(minutes(), now, q("backendLatency"))]);
		runs.push(["backendMemory", () => checkMemory(minutes(), now, q("backendMemory"))]);
		runs.push(["backendLoopLag", () => checkLoopLag(minutes(), now, q("backendLoopLag"))]);
		runs.push(["backend5xx", () => check5xx(minutes(), now, q("backend5xx"))]);
		const disk = this.o.disk();
		await this.recordDisk(disk, now);
		runs.push(["diskLow", () => checkDiskLow(disk, q("diskLow"))]);
		runs.push(["diskGrowth", async () => checkDiskGrowth(await this.diskHistory(now), disk, now, q("diskGrowth"))]);

		for (const [id, check] of runs) {
			if (!on(id)) {
				this.verdicts.delete(id);
				continue;
			}
			let verdict: Verdict;
			try {
				verdict = await check();
			} catch (error) {
				this.log(`backend alert ${id} failed: ${(error as Error).message}`);
				this.verdicts.set(id, { state: "waiting", note: "the check failed (see the log)" });
				continue;
			}
			this.verdicts.set(id, { state: verdict.state, note: verdict.note });
			if (verdict.state === "firing") for (const f of verdict.findings.slice(0, FINDINGS_PER_TICK)) await this.raise(id, f, settings, now);
		}
		this.lastRun = { at: now, ms: Math.round((performance.now() - started) * 100) / 100 };
	}

	/** Takes this tick's sample and keeps the last SAMPLES_KEEP_MS. */
	private async sample(now: number, rowsIn: number): Promise<{ lastHeartbeat: number | null }> {
		let servers = 0;
		let players = 0;
		let lastHeartbeat: number | null = null;
		if (this.o.fleet) {
			const open = await this.o.db.first<{ servers: number; players: number | null }>(
				"SELECT COUNT(*) AS servers, SUM(players) AS players FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ?",
				[now - LOST_AFTER_MS],
			);
			servers = Number(open?.servers ?? 0);
			players = Number(open?.players ?? 0);
			const last = await this.o.db.first<{ t: number | null }>("SELECT MAX(last_seen) AS t FROM servers");
			lastHeartbeat = last?.t ?? null;
		}
		if (this.lastRowsIn !== undefined && rowsIn > this.lastRowsIn) this.lastIngest = now;
		this.lastRowsIn = rowsIn;
		this.samples.push({ t: now, servers, players, rowsIn });
		while (this.samples.length && (this.samples[0] as Sample).t < now - SAMPLES_KEEP_MS) this.samples.shift();
		return { lastHeartbeat };
	}

	/** The loudest kinds of the last `minutes` (at least minCount), with their count in the hours before. */
	private async kindWindows(now: number, p: { minutes: number; minCount: number; baselineHours: number }): Promise<KindWindow[]> {
		const nowMinute = Math.floor(now / MINUTE);
		const from = nowMinute - p.minutes + 1;
		const rows = await this.o.db.all<{ fp: string; n: number; template: string }>(
			"SELECT c.fp, SUM(c.n) AS n, k.template FROM error_counts c JOIN error_kinds k ON k.fp = c.fp WHERE c.minute >= ? GROUP BY c.fp HAVING SUM(c.n) >= ? ORDER BY n DESC LIMIT ?",
			[from, p.minCount, KINDS_MAX],
		);
		const out: KindWindow[] = [];
		for (const r of rows) {
			const base = await this.o.db.first<{ n: number | null }>("SELECT SUM(n) AS n FROM error_counts WHERE fp = ? AND minute >= ? AND minute < ?", [r.fp, from - p.baselineHours * 60, from]);
			out.push({ fp: r.fp, template: r.template, recent: Number(r.n), baseline: Number(base?.n ?? 0) });
		}
		return out;
	}

	private async latestDeploy(): Promise<DeployInfo | null> {
		const d = await this.o.db.first<{ seq: number; branch: string | null; artifact: string | null; received: number }>("SELECT seq, branch, artifact, received FROM deploys ORDER BY received DESC LIMIT 1");
		return d ? { seq: d.seq, branch: d.branch, artifact: d.artifact, at: d.received } : null;
	}

	/** Kinds first seen after the deploy (and seen since), loudest first; nothing once the window is long over. */
	private async newKinds(deploy: DeployInfo, now: number, p: { minutes: number }): Promise<NewKind[]> {
		if (now > deploy.at + p.minutes * MINUTE + 6 * HOUR) return [];
		const rows = await this.o.db.all<{ fp: string; template: string; first_at: number; total: number }>(
			"SELECT fp, template, first_at, total FROM error_kinds WHERE last_at >= ? AND first_at >= ? AND first_at <= ? ORDER BY total DESC LIMIT ?",
			[deploy.at, deploy.at, deploy.at + p.minutes * MINUTE, KINDS_MAX],
		);
		return rows.map((r) => ({ fp: r.fp, template: r.template, firstAt: r.first_at, total: r.total }));
	}

	/** One disk row an hour (and 30 days of them). */
	private async recordDisk(disk: DiskNow | null, now: number): Promise<void> {
		const hour = Math.floor(now / HOUR);
		if (!disk || hour === this.lastDiskHour) return;
		this.lastDiskHour = hour;
		await this.o.db.run("INSERT OR REPLACE INTO backend_disk_samples (hour, used, free, total) VALUES (?, ?, ?, ?)", [hour, disk.totalBytes - disk.freeBytes, disk.freeBytes, disk.totalBytes]);
		await this.o.db.run("DELETE FROM backend_disk_samples WHERE hour < ?", [Math.floor((now - DISK_KEEP_MS) / HOUR)]);
		this.diskSamples = undefined;
	}

	private async diskHistory(now: number): Promise<DiskSample[]> {
		this.diskSamples ??= (await this.o.db.all<{ hour: number; used: number; free: number }>("SELECT hour, used, free FROM backend_disk_samples WHERE hour >= ? ORDER BY hour", [Math.floor((now - 8 * 86_400_000) / HOUR)])).map((r) => ({
			t: r.hour * HOUR,
			usedBytes: r.used,
			freeBytes: r.free,
		}));
		return this.diskSamples;
	}

	private async raise(id: RuleId, f: Finding, settings: BackendAlertSettings, now: number): Promise<void> {
		const def = RULES_BY_ID.get(id);
		if (!def) return;
		const dedupKey = `${def.code}\u0000${f.key}`;
		const repeatMs = settings.repeatMinutes * MINUTE;
		if (now - (this.lastRaised.get(dedupKey) ?? -Infinity) < repeatMs) {
			this.stats.deduped++;
			return;
		}
		// Raised by this server before its restart, or by the other one during a deploy's handover.
		if (this.o.fleet) {
			const seen = await this.o.db.first<{ created: number }>("SELECT created FROM alerts WHERE created >= ? AND code = ? AND json_extract(details, '$.key') IS ? ORDER BY created DESC LIMIT 1", [now - repeatMs, def.code, f.key]);
			if (seen) {
				this.remember(dedupKey, seen.created, now, repeatMs);
				this.stats.deduped++;
				return;
			}
		}
		while (this.sentTimes.length && now - (this.sentTimes[0] as number) >= HOUR) this.sentTimes.shift();
		if (this.sentTimes.length >= settings.perHour) {
			this.stats.throttled++;
			return;
		}
		this.sentTimes.push(now);
		this.remember(dedupKey, now, now, repeatMs);
		this.raisedAt.set(id, now);
		try {
			await this.o.raise({
				level: settings.rules[id].level,
				code: def.code,
				message: f.message,
				branch: f.branch ?? null,
				artifact: f.artifact ?? null,
				seq: f.seq ?? null,
				details: { rule: id, key: f.key, ...f.details },
			});
			this.stats.raised++;
		} catch (error) {
			this.stats.failed++;
			this.log(`backend alert ${id} could not be stored: ${(error as Error).message}`);
		}
	}

	private remember(key: string, at: number, now: number, repeatMs: number): void {
		this.lastRaised.set(key, at);
		if (this.lastRaised.size > DEDUP_MAX) for (const [k, t] of this.lastRaised) if (now - t >= repeatMs || this.lastRaised.size > DEDUP_MAX) this.lastRaised.delete(k);
	}
}
