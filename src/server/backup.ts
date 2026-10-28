/**
 * Backups that are safe while the server runs (README "Backups and restore"). A backup is a folder:
 *
 *   fleet.sqlite        the SQLite file (fleet, identities, error logs, the audit log), by `VACUUM INTO` on its own
 *                       connection in a worker thread: one consistent snapshot, the server keeps writing meanwhile
 *   live.duckdb         today's rows, by DuckDB's `COPY FROM DATABASE` in one transaction
 *   events/, recordings/, rollups/   the Parquet day files, hard-linked (free on the same disk) or copied
 *   access.json, runtime-settings.json, devices.json, bless-keys.json, settings.json, instance.key, erasure/, audit/
 *   manifest.json       what is in it and what was left out
 *
 * The DuckDB part runs between the warehouse's jobs (Warehouse.betweenJobs): no load, nightly export, prune,
 * compaction or erasure runs while live.duckdb is copied and the day files are linked, so the two belong together. The
 * day files never change in place (a new version is written next to it and renamed over it), so a hard link is a
 * snapshot. Left out: raw/incoming (the last few seconds of accepted batches, loaded at the next tick: in the next
 * backup) and raw/archive (the loaded batches again, as gzip NDJSON; their rows are in live.duckdb and the day files).
 *
 * Local backups go to TYPETORCH_BACKUP_DIR (default <data>/backups) as typetorch-backup-<UTC time>/, built under a
 * `.partial-` name and renamed when complete; the newest TYPETORCH_BACKUP_KEEP are kept. The download is a tar of a
 * fresh backup built in <data>/backup-tmp and deleted once sent; it leaves out the two secrets of the folder (the alert
 * webhook URL in runtime-settings.json and instance.key), because a download is a response.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, link, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { PACKAGE } from "../version.ts";
import type { Warehouse } from "./warehouse.ts";

export const BACKUP_FORMAT = "typetorch-backup-v1";
const NAME = /^typetorch-backup-\d{8}T\d{6}Z(?:-\d{1,3})?$/;
const PARTIAL = ".partial-";
/** A download's folder in <data>/backup-tmp older than this is a leftover (the client went away mid-stream). */
const STAGING_MAX_AGE_MS = 6 * 3_600_000;
const STATE_FILES = ["access.json", "runtime-settings.json", "devices.json", "bless-keys.json", "settings.json", "instance.key"] as const;
const STATE_DIRS = ["erasure", "audit"] as const;
const DAY_DIRS = ["events", "recordings", "rollups"] as const;

export type BackupReason = "scheduled" | "manual" | "download";

export interface BackupManifest {
	format: typeof BACKUP_FORMAT;
	name: string;
	createdAt: string;
	version: string;
	reason: BackupReason;
	/** Seconds it took. */
	seconds: number;
	bytes: number;
	files: number;
	sqlite: boolean;
	duckdb: boolean;
	dayFiles: number;
	/** How the day files got there: hard links (same disk), copies, or none. */
	dayFilesBy: "link" | "copy" | "none";
	state: string[];
	leftOut: string[];
}

export interface BackupInfo {
	name: string;
	createdAt: string | null;
	reason: BackupReason | null;
	bytes: number | null;
	files: number | null;
	duckdb: boolean | null;
}

export interface BackupsOptions {
	dataDir: string;
	dir: string;
	keep: number;
	/** Hours between scheduled backups; 0 = none. */
	everyHours: number;
	fleetDb: string;
	/** The open warehouse, or undefined (the analytics part is off, or a deploy handover). */
	warehouse(): Warehouse | undefined;
	analyticsOn: boolean;
	/** Runs a statement on the server's own SQLite connection: `VACUUM INTO` when the worker thread can't start. */
	sqliteExec(sql: string): Promise<void>;
	clock?: () => number;
	log?: (line: string) => void;
}

/** 409: a backup is being made. 503: DuckDB isn't open (a deploy handover). */
export class BackupError extends Error {
	constructor(
		message: string,
		readonly status: 409 | 503 | 500,
	) {
		super(message);
	}
}

export class Backups {
	private busy = false;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	/** The last local backup's outcome (never a path outside the backup dir, never a secret). */
	last: { at: string; ok: boolean; reason: BackupReason; name?: string; error?: string } | undefined;

	constructor(private readonly o: BackupsOptions) {
		this.clock = o.clock ?? Date.now;
		this.log = o.log ?? (() => {});
		// A crash mid-backup leaves a `.partial-` folder, a download's folder; neither is a backup.
		for (const name of existsSync(o.dir) ? readdirSync(o.dir) : []) if (name.startsWith(PARTIAL)) rmSync(join(o.dir, name), { recursive: true, force: true });
		rmSync(this.staging, { recursive: true, force: true });
	}

	private get staging(): string {
		return join(this.o.dataDir, "backup-tmp");
	}

	get running(): boolean {
		return this.busy;
	}

	status(): { dir: string; keep: number; everyHours: number; running: boolean; last: Backups["last"] | null; next: string | null } {
		const newest = this.list()[0];
		const lastAt = newest?.createdAt ? Date.parse(newest.createdAt) : undefined;
		const next = this.o.everyHours > 0 ? new Date(lastAt !== undefined ? Math.max(this.clock(), lastAt + this.o.everyHours * 3_600_000) : this.clock()).toISOString() : null;
		return { dir: this.o.dir, keep: this.o.keep, everyHours: this.o.everyHours, running: this.busy, last: this.last ?? null, next };
	}

	/** The local backups, newest first (their manifests). */
	list(): BackupInfo[] {
		if (!existsSync(this.o.dir)) return [];
		return readdirSync(this.o.dir)
			.filter((n) => NAME.test(n))
			.sort()
			.reverse()
			.map((name) => {
				try {
					const m = JSON.parse(readFileSync(join(this.o.dir, name, "manifest.json"), "utf8")) as Partial<BackupManifest>;
					return { name, createdAt: m.createdAt ?? null, reason: m.reason ?? null, bytes: m.bytes ?? null, files: m.files ?? null, duckdb: m.duckdb ?? null };
				} catch {
					return { name, createdAt: null, reason: null, bytes: null, files: null, duckdb: null };
				}
			});
	}

	/** Whether a scheduled backup is due (none yet, or the newest is `everyHours` old). */
	due(): boolean {
		if (this.o.everyHours <= 0 || this.busy) return false;
		const newest = this.list().find((b) => b.createdAt);
		return !newest?.createdAt || this.clock() - Date.parse(newest.createdAt) >= this.o.everyHours * 3_600_000;
	}

	/** One local backup into the backup dir, then the oldest past `keep` go. */
	async runLocal(reason: Exclude<BackupReason, "download">): Promise<BackupManifest> {
		const result = await this.exclusive(async () => {
			mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
			const name = this.freshName(this.o.dir);
			const partial = join(this.o.dir, `${PARTIAL}${name}`);
			try {
				const manifest = await this.make(partial, name, reason);
				await rename(partial, join(this.o.dir, name));
				await this.prune();
				this.last = { at: manifest.createdAt, ok: true, reason, name };
				this.log(`backup: ${name} (${reason}, ${manifest.files} files, ${Math.round(manifest.bytes / 1048576)} MB, ${manifest.seconds} s)`);
				return manifest;
			} catch (error) {
				await rm(partial, { recursive: true, force: true }).catch(() => {});
				this.last = { at: new Date(this.clock()).toISOString(), ok: false, reason, error: shortError(error) };
				this.log(`backup failed (${reason}): ${shortError(error)}`);
				throw error;
			}
		});
		return result;
	}

	/**
	 * A fresh backup as a tar stream (the download). Its folder is deleted once the stream ends or is cancelled. Leaves
	 * out the webhook URL and instance.key.
	 */
	async download(): Promise<{ name: string; manifest: BackupManifest; stream: ReadableStream<Uint8Array> }> {
		const { name, folder, manifest } = await this.exclusive(async () => {
			this.sweepStaging();
			mkdirSync(this.staging, { recursive: true, mode: 0o700 });
			const name = this.freshName(this.staging);
			const folder = join(this.staging, name);
			try {
				return { name, folder, manifest: await this.make(folder, name, "download") };
			} catch (error) {
				await rm(folder, { recursive: true, force: true }).catch(() => {});
				throw error;
			}
		});
		let cleaned = false;
		const cleanup = async () => {
			if (cleaned) return;
			cleaned = true;
			await rm(folder, { recursive: true, force: true }).catch(() => {});
		};
		return { name, manifest, stream: toStream(tarFolder(folder, name), cleanup) };
	}

	private async exclusive<T>(job: () => Promise<T>): Promise<T> {
		if (this.busy) throw new BackupError("a backup is being made: try again when it is done", 409);
		if (this.o.analyticsOn && !this.o.warehouse()) throw new BackupError("analytics is starting (deploy handover): try again in a few seconds", 503);
		this.busy = true;
		try {
			return await job();
		} finally {
			this.busy = false;
		}
	}

	private freshName(dir: string): string {
		const stamp = new Date(this.clock()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
		let name = `typetorch-backup-${stamp}`;
		for (let i = 2; existsSync(join(dir, name)) || existsSync(join(dir, `${PARTIAL}${name}`)); i++) name = `typetorch-backup-${stamp}-${i}`;
		return name;
	}

	/** Builds one backup folder at `target`. */
	private async make(target: string, name: string, reason: BackupReason): Promise<BackupManifest> {
		const started = performance.now();
		const createdAt = new Date(this.clock()).toISOString();
		await mkdir(target, { recursive: true, mode: 0o700 });
		const leftOut = ["raw/incoming (the last seconds of accepted batches; in the next backup)", "raw/archive (the loaded batches again; their rows are in live.duckdb and the day files)"];
		let duckdb = false;
		let dayFiles = 0;
		let dayFilesBy: BackupManifest["dayFilesBy"] = "none";
		// DuckDB first, between the warehouse's jobs: live.duckdb and the day files from the same moment.
		const w = this.o.warehouse();
		if (w) {
			await w.betweenJobs(async (copyLive) => {
				await copyLive(join(target, "live.duckdb"));
				duckdb = true;
				for (const dir of DAY_DIRS) {
					const linked = await linkTree(join(this.o.dataDir, dir), join(target, dir));
					dayFiles += linked.files;
					if (linked.files) dayFilesBy = dayFilesBy === "copy" || linked.copied ? "copy" : "link";
				}
			});
		} else leftOut.push("live.duckdb and the day files (the analytics part is off on this server)");
		// Then SQLite: one snapshot, off the event loop.
		let sqlite = false;
		if (this.o.fleetDb !== ":memory:" && existsSync(this.o.fleetDb)) {
			await this.vacuumInto(this.o.fleetDb, join(target, "fleet.sqlite"));
			sqlite = true;
		} else leftOut.push("fleet.sqlite (an in-memory database)");
		const state: string[] = [];
		for (const file of STATE_FILES) {
			const source = join(this.o.dataDir, file);
			if (!existsSync(source)) continue;
			if (reason === "download" && file === "instance.key") {
				leftOut.push("instance.key (a private key: copy it from the data volume, or add the project on typetorch.dev again)");
				continue;
			}
			if (reason === "download" && file === "runtime-settings.json") {
				await writeFile(join(target, file), withoutWebhook(readFileSync(source, "utf8")), { mode: 0o600 });
				leftOut.push("the alert webhook URL in runtime-settings.json (a secret: save it again on the Settings page after a restore)");
			} else await copyFile(source, join(target, file));
			state.push(file);
		}
		for (const dir of STATE_DIRS) {
			const copied = await linkTree(join(this.o.dataDir, dir), join(target, dir), true);
			if (copied.files) state.push(`${dir}/`);
		}
		const size = await sizeOfTree(target);
		const manifest: BackupManifest = {
			format: BACKUP_FORMAT,
			name,
			createdAt,
			version: PACKAGE.version,
			reason,
			seconds: Math.round((performance.now() - started) / 100) / 10,
			bytes: size.bytes,
			files: size.files + 1,
			sqlite,
			duckdb,
			dayFiles,
			dayFilesBy,
			state,
			leftOut,
		};
		writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`, { mode: 0o600 });
		return manifest;
	}

	/** `VACUUM INTO` on a worker thread's own connection; on the server's connection when no worker can start. */
	private async vacuumInto(source: string, target: string): Promise<void> {
		rmSync(target, { force: true });
		const url = new URL(`./sqlite-backup-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url);
		try {
			await new Promise<void>((done, fail) => {
				const worker = new Worker(url, { workerData: { source, target } });
				worker.once("message", (m: { ok: boolean; error?: string }) => (m.ok ? done() : fail(Object.assign(new Error(m.error ?? "VACUUM INTO failed"), { fromWorker: true }))));
				worker.once("error", fail);
				worker.once("exit", (code) => fail(new Error(`the backup worker exited (${code})`)));
			});
		} catch (error) {
			// SQLite's own error (disk full, ...) stands; a worker that couldn't run at all falls back.
			if ((error as { fromWorker?: boolean }).fromWorker) throw error;
			this.log(`backup: no worker thread for SQLite (${shortError(error)}); copying on the main connection`);
			rmSync(target, { force: true });
			await this.o.sqliteExec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
		}
	}

	private async prune(): Promise<void> {
		for (const old of this.list().slice(this.o.keep)) await rm(join(this.o.dir, old.name), { recursive: true, force: true });
	}

	/** Download folders a client never finished reading. */
	private sweepStaging(): void {
		if (!existsSync(this.staging)) return;
		for (const name of readdirSync(this.staging)) {
			const path = join(this.staging, name);
			try {
				if (this.clock() - statSync(path).mtimeMs > STAGING_MAX_AGE_MS) rmSync(path, { recursive: true, force: true });
			} catch {}
		}
	}
}

function shortError(error: unknown): string {
	return ((error as Error)?.message ?? String(error)).replace(/\s+/g, " ").slice(0, 200);
}

/** runtime-settings.json without the webhook URL (the download leaves the secret out). */
function withoutWebhook(text: string): string {
	try {
		const parsed = JSON.parse(text) as { values?: Record<string, unknown> };
		if (parsed.values && typeof parsed.values === "object") delete parsed.values.alertWebhookUrl;
		return `${JSON.stringify(parsed, null, "\t")}\n`;
	} catch {
		return "{}\n";
	}
}

/**
 * Hard-links every file under `source` into `dest` (copies when linking fails: another disk, or `copy`). Leaves out
 * `.tmp` files (a write in progress). Async, file by file, so the event loop keeps going.
 */
async function linkTree(source: string, dest: string, copy = false): Promise<{ files: number; copied: boolean }> {
	if (!existsSync(source)) return { files: 0, copied: false };
	let files = 0;
	let copied = copy;
	const walk = async (from: string, to: string) => {
		await mkdir(to, { recursive: true, mode: 0o700 });
		for (const entry of await readdir(from, { withFileTypes: true })) {
			const a = join(from, entry.name);
			const b = join(to, entry.name);
			if (entry.isDirectory()) await walk(a, b);
			else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
				if (copied) await copyFile(a, b);
				else {
					try {
						await link(a, b);
					} catch {
						copied = true;
						await copyFile(a, b);
					}
				}
				files++;
			}
		}
	};
	await walk(source, dest);
	return { files, copied };
}

async function sizeOfTree(root: string): Promise<{ bytes: number; files: number }> {
	let bytes = 0;
	let files = 0;
	for await (const file of walkFiles(root)) {
		bytes += file.size;
		files++;
	}
	return { bytes, files };
}

/** Every file under `root`, sorted, with its path relative to it ("/" separated). */
async function* walkFiles(root: string): AsyncGenerator<{ path: string; rel: string; size: number; mtimeMs: number }> {
	const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			for await (const inner of walkFiles(path)) yield { ...inner, rel: `${entry.name}/${inner.rel}` };
		} else if (entry.isFile()) {
			const s = await stat(path);
			yield { path, rel: entry.name, size: s.size, mtimeMs: s.mtimeMs };
		}
	}
}

// Tar (ustar) -------------------------------------------------------------------------------------------------------

const BLOCK = 512;

/** A ustar header. Names up to 255 bytes (split into prefix and name at a "/"); sizes past 8 GiB in base-256. */
export function tarHeader(name: string, size: number, mtimeMs: number, type: "file" | "dir"): Uint8Array {
	const h = new Uint8Array(BLOCK);
	const bytes = Buffer.from(name, "utf8");
	let base = bytes;
	let prefix = Buffer.alloc(0);
	if (bytes.length > 100) {
		let cut = -1;
		for (let i = Math.min(bytes.length - 1, 155); i > 0; i--) {
			if (bytes[i] === 0x2f && bytes.length - i - 1 <= 100) {
				cut = i;
				break;
			}
		}
		if (cut < 0) throw new Error(`a name in the backup is too long for tar: ${name.slice(0, 80)}...`);
		prefix = bytes.subarray(0, cut);
		base = bytes.subarray(cut + 1);
	}
	const put = (offset: number, value: Uint8Array | string) => h.set(typeof value === "string" ? Buffer.from(value, "ascii") : value, offset);
	const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
	put(0, base);
	put(100, octal(type === "dir" ? 0o700 : 0o600, 8));
	put(108, octal(1000, 8));
	put(116, octal(1000, 8));
	if (size < 8 ** 11) put(124, octal(size, 12));
	else {
		h[124] = 0x80;
		let rest = BigInt(size);
		for (let i = 135; i > 124; i--) {
			h[i] = Number(rest & 0xffn);
			rest >>= 8n;
		}
	}
	put(136, octal(Math.floor(mtimeMs / 1000), 12));
	put(148, "        ");
	put(156, type === "dir" ? "5" : "0");
	put(257, "ustar\0");
	put(263, "00");
	put(265, "typetorch");
	put(297, "typetorch");
	put(345, prefix);
	let sum = 0;
	for (const b of h) sum += b;
	put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
	return h;
}

/** The tar of a folder, entries under `top/`. */
export async function* tarFolder(root: string, top: string): AsyncGenerator<Uint8Array> {
	const dirs = new Set<string>();
	yield tarHeader(`${top}/`, 0, Date.now(), "dir");
	for await (const file of walkFiles(root)) {
		const parts = file.rel.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (dirs.has(dir)) continue;
			dirs.add(dir);
			yield tarHeader(`${top}/${dir}/`, 0, file.mtimeMs, "dir");
		}
		yield tarHeader(`${top}/${file.rel}`, file.size, file.mtimeMs, "file");
		let sent = 0;
		if (file.size > 0) {
			for await (const chunk of createReadStream(file.path, { start: 0, end: file.size - 1, highWaterMark: 256 * 1024 })) {
				const piece = chunk as Buffer;
				sent += piece.length;
				yield piece;
			}
		}
		// A file that came up short (it can't here: the folder is ours) still keeps the tar's framing.
		if (sent < file.size) yield new Uint8Array(file.size - sent);
		const pad = (BLOCK - (file.size % BLOCK)) % BLOCK;
		if (pad) yield new Uint8Array(pad);
	}
	yield new Uint8Array(BLOCK * 2);
}

/** A web stream over an async generator; `done` runs once it ends, fails or is cancelled. */
function toStream(source: AsyncGenerator<Uint8Array>, done: () => Promise<void>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await source.next();
				if (next.done) {
					controller.close();
					await done();
				} else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
				await done();
			}
		},
		async cancel() {
			await source.return(undefined).catch(() => {});
			await done();
		},
	});
}

/** For tests: the relative paths (with "/") of a backup folder's files. */
export function backupFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else out.push(relative(root, path).split(sep).join("/"));
		}
	};
	walk(root);
	return out.sort();
}
