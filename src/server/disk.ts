/**
 * The disk the data folder is on (README "Disk space"): how full it is, and a warning before it runs out. `diskUsage`
 * reads the file system's free and total bytes (statfs; null where it isn't supported). `DiskWatch` checks every so often
 * (app.ts: every 10 minutes and at start), keeps the last reading for `GET /v1/storage`, `GET /v1/admin/backups` and
 * `/healthz`, logs when the level changes, and raises one fleet alert (`disk_low`, warning or critical) when the free
 * space drops under the thresholds: one per level until it is acked or the disk has room again, never one a check.
 */
import * as fs from "node:fs";

export type DiskLevel = "ok" | "warning" | "critical";

export interface DiskUsage {
	freeBytes: number;
	totalBytes: number;
}

export interface DiskThresholds {
	/** Free space, percent of the disk, under which the level is "warning" (0 = never). */
	warnFreePercent: number;
	/** Under which it is "critical" (0 = never). */
	criticalFreePercent: number;
}

export interface DiskStatus extends DiskUsage {
	/** Free space as a percent of the disk, one decimal. */
	freePercent: number;
	level: DiskLevel;
	warnFreePercent: number;
	criticalFreePercent: number;
	/** When it was measured. */
	at: string;
}

/** Free and total bytes of the file system holding `path`; null where statfs isn't available. */
export function diskUsage(path: string): DiskUsage | null {
	try {
		const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; blocks: number; bsize: number } }).statfsSync;
		if (!statfs) return null;
		const s = statfs(path);
		return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
	} catch {
		return null;
	}
}

export function freePercent(usage: DiskUsage): number {
	return usage.totalBytes > 0 ? Math.round((usage.freeBytes / usage.totalBytes) * 1000) / 10 : 100;
}

/** The level for a reading: critical under `criticalFreePercent` free, warning under `warnFreePercent`, else ok. */
export function diskLevel(usage: DiskUsage, t: DiskThresholds): DiskLevel {
	const free = freePercent(usage);
	if (t.criticalFreePercent > 0 && free < t.criticalFreePercent) return "critical";
	if (t.warnFreePercent > 0 && free < t.warnFreePercent) return "warning";
	return "ok";
}

export function diskStatus(usage: DiskUsage, t: DiskThresholds, at: number): DiskStatus {
	return { ...usage, freePercent: freePercent(usage), level: diskLevel(usage, t), warnFreePercent: t.warnFreePercent, criticalFreePercent: t.criticalFreePercent, at: new Date(at).toISOString() };
}

export interface DiskAlert {
	level: Exclude<DiskLevel, "ok">;
	freeBytes: number;
	totalBytes: number;
	freePercent: number;
	threshold: number;
}

export interface DiskWatchOptions {
	path: string;
	thresholds: DiskThresholds;
	/** Reads the disk (tests pass a fake). */
	usage?: (path: string) => DiskUsage | null;
	/** Raises the fleet alert; absent without the fleet part (the level still shows in the explorer). */
	alert?: (alert: DiskAlert) => Promise<unknown> | unknown;
	clock?: () => number;
	log?: (line: string) => void;
}

const RANK: Record<DiskLevel, number> = { ok: 0, warning: 1, critical: 2 };

export class DiskWatch {
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private readonly usage: (path: string) => DiskUsage | null;
	private current: DiskStatus | null = null;
	/** The level the last alert was raised at; back to "ok" once the disk has room again, so a new drop alerts again. */
	private alerted: DiskLevel = "ok";

	constructor(private readonly o: DiskWatchOptions) {
		this.clock = o.clock ?? Date.now;
		this.log = o.log ?? (() => {});
		this.usage = o.usage ?? diskUsage;
	}

	/** The last reading (null before the first check, or where the disk can't be measured). */
	get status(): DiskStatus | null {
		return this.current;
	}

	/** One check: measures, logs a change of level, raises the alert when the level got worse. Never throws. */
	async check(): Promise<DiskStatus | null> {
		const usage = this.usage(this.o.path);
		if (!usage) return (this.current = null);
		const was = this.current?.level ?? "ok";
		const status = diskStatus(usage, this.o.thresholds, this.clock());
		this.current = status;
		const gb = (b: number) => `${Math.round(b / 1073741824 * 10) / 10} GB`;
		if (status.level !== was) this.log(`disk: ${status.level === "ok" ? "room again" : status.level}: ${gb(status.freeBytes)} of ${gb(status.totalBytes)} free (${status.freePercent}%)`);
		if (status.level === "ok") this.alerted = "ok";
		else if (RANK[status.level] > RANK[this.alerted]) {
			this.alerted = status.level;
			try {
				await this.o.alert?.({ level: status.level, freeBytes: status.freeBytes, totalBytes: status.totalBytes, freePercent: status.freePercent, threshold: status.level === "critical" ? this.o.thresholds.criticalFreePercent : this.o.thresholds.warnFreePercent });
			} catch (error) {
				this.log(`disk: could not raise the alert (${(error as Error).message.slice(0, 120)})`);
			}
		}
		return status;
	}
}
