/**
 * What the server keeps on disk (`GET /v1/storage`, admin): bytes and files per part of the data folder, row counts,
 * how much today added (raw archive, gzip NDJSON) against the days before, and the disk's free space.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dayFiles, pathLit, type DataLayout } from "../duckdb/layout.ts";
import { diskStatus, diskUsage, type DiskStatus, type DiskThresholds, type DiskUsage } from "./disk.ts";

export interface StoragePart {
	key: "live" | "events" | "recordings" | "rawIncoming" | "rawArchive" | "rollups" | "fleet" | "sql" | "tmp";
	label: string;
	bytes: number;
	files: number;
	/** Day files: the oldest and newest day (YYYY-MM-DD). */
	oldest?: string;
	newest?: string;
	days?: number;
}

export interface StorageReport {
	/** When this was measured (it's cached for cacheSeconds). */
	at: string;
	cacheSeconds: number;
	totalBytes: number;
	parts: StoragePart[];
	rows: { liveEvents: number; liveRecordings: number; parquetEvents: number; parquetRecordings: number } | null;
	/** Raw archive (gzip NDJSON) per day: today so far vs the average of the 7 days before (null without history). */
	growth: { todayBytes: number; avgPerDayBytes: number | null; days: { date: string; bytes: number }[] } | null;
	/** The disk the data folder is on, with its level (server/disk.ts); null where it can't be measured. */
	disk: DiskStatus | null;
}

interface Size {
	bytes: number;
	files: number;
}

/** Bytes and files under a path (a file or a folder, recursively); 0 when it doesn't exist. */
export function sizeOf(path: string): Size {
	if (!existsSync(path)) return { bytes: 0, files: 0 };
	const stat = statSync(path);
	if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
	let bytes = 0;
	let files = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = sizeOf(join(path, entry.name));
		bytes += child.bytes;
		files += child.files;
	}
	return { bytes, files };
}

function sum(...sizes: Size[]): Size {
	return sizes.reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), { bytes: 0, files: 0 });
}

function dayPart(key: "events" | "recordings", label: string, dir: string): StoragePart {
	const files = dayFiles(dir);
	const size = sum(...files.map((f) => sizeOf(f.path)));
	const part: StoragePart = { key, label, ...size, days: files.length };
	if (files.length) {
		part.oldest = files[0].date;
		part.newest = files[files.length - 1].date;
	}
	return part;
}

export interface MeasureOptions {
	layout: DataLayout;
	fleetDb?: string;
	/** Runs SQL on the warehouse (row counts); absent on a fleet-only server. */
	sql?: (statement: string) => Promise<Record<string, unknown>[]>;
	liveRows?: () => Promise<{ events: number; recordings: number }>;
	clock: () => number;
	cacheSeconds: number;
	/** The warning thresholds for the disk (server/disk.ts); without them the level is always "ok". */
	diskThresholds?: DiskThresholds;
	/** Reads the disk (tests pass a fake). */
	diskUsage?: (path: string) => DiskUsage | null;
}

/** Measures the data folder. Everything is best effort: a part that can't be read counts as empty. */
export async function measureStorage(o: MeasureOptions): Promise<StorageReport> {
	const l = o.layout;
	const parts: StoragePart[] = [];
	if (o.sql) {
		parts.push({ key: "live", label: "DuckDB live (today)", ...sum(sizeOf(l.live), sizeOf(`${l.live}.wal`), sizeOf(l.lock)) });
		parts.push(dayPart("events", "Parquet events", l.events));
		parts.push(dayPart("recordings", "Parquet recordings", l.recordings));
		parts.push({ key: "rawIncoming", label: "Raw incoming", ...sizeOf(l.rawIncoming) });
		parts.push({ key: "rawArchive", label: "Raw archive", ...sizeOf(l.rawArchive) });
		parts.push({ key: "rollups", label: "Rollups", ...sizeOf(l.rollups) });
		parts.push({ key: "sql", label: "SQL sandbox", ...sizeOf(join(l.root, "sql")) });
		parts.push({ key: "tmp", label: "DuckDB spill", ...sizeOf(l.tmp) });
	}
	if (o.fleetDb) parts.push({ key: "fleet", label: "Fleet SQLite", ...sum(sizeOf(o.fleetDb), sizeOf(`${o.fleetDb}-wal`), sizeOf(`${o.fleetDb}-shm`)) });

	let rows: StorageReport["rows"] = null;
	if (o.sql && o.liveRows) {
		const live = await o.liveRows().catch(() => ({ events: 0, recordings: 0 }));
		const parquetRows = async (dir: string) => {
			const files = dayFiles(dir);
			if (!files.length) return 0;
			const r = await o.sql?.(`SELECT SUM(num_rows) AS n FROM parquet_file_metadata([${files.map((f) => pathLit(f.path)).join(", ")}])`).catch(() => []);
			return Number(r?.[0]?.n ?? 0);
		};
		rows = { liveEvents: live.events, liveRecordings: live.recordings, parquetEvents: await parquetRows(l.events), parquetRecordings: await parquetRows(l.recordings) };
	}

	let growth: StorageReport["growth"] = null;
	if (o.sql && existsSync(l.rawArchive)) {
		const today = new Date(o.clock()).toISOString().slice(0, 10);
		const days = readdirSync(l.rawArchive)
			.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
			.sort()
			.map((date) => ({ date, bytes: sizeOf(join(l.rawArchive, date)).bytes }));
		const before = days.filter((d) => d.date < today).slice(-7);
		growth = {
			// Today's batches still waiting in raw/incoming are today's too.
			todayBytes: (days.find((d) => d.date === today)?.bytes ?? 0) + sizeOf(l.rawIncoming).bytes,
			avgPerDayBytes: before.length ? Math.round(before.reduce((s, d) => s + d.bytes, 0) / before.length) : null,
			days: days.slice(-8),
		};
	}

	const usage = (o.diskUsage ?? diskUsage)(l.root);
	const disk = usage ? diskStatus(usage, o.diskThresholds ?? { warnFreePercent: 0, criticalFreePercent: 0 }, o.clock()) : null;

	return {
		at: new Date(o.clock()).toISOString(),
		cacheSeconds: o.cacheSeconds,
		totalBytes: parts.reduce((s, p) => s + p.bytes, 0),
		parts,
		rows,
		growth,
		disk,
	};
}
