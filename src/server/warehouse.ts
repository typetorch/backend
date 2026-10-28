/**
 * The DuckDB side of the analytics server: today's live file, the loader (raw files -> DuckDB in big chunks), the
 * nightly export (each finished day -> Parquet, then rollups and pruning), queries over live + Parquet, and the row
 * deletions for Right to Erasure. One DuckDB instance (memory_limit ~400 MB, 1-2 threads, a spill folder), one
 * writer connection for jobs, and a small pool of read connections for queries.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { createTableSql, dataLayout, dayFiles, dayString, fieldsOf, pathLit, readJsonColumns, storedColumns, tableExpression, type DataLayout } from "../duckdb/layout.ts";
import { DataFolderLocked, isLockConflict } from "../duckdb/lock.ts";
import { runQuery } from "../queries/index.ts";
import { PROP_KEYS } from "../schema.ts";
import type { QueryContext } from "../queries/core.ts";
import { DAY_MS, duckdb, lit } from "../sql/dialect.ts";
import type { Filters } from "../sql/filters.ts";
import { DuckDbStore, readRows, type TableResolver } from "../store/duckdb.ts";
import { RawLog, type ReadyFile } from "./raw.ts";

/** The pooled store of a logical query: each statement's time goes to the metrics hook. */
class MeteredStore extends DuckDbStore {
	constructor(
		connection: DuckDBConnection,
		resolve: TableResolver,
		clock: () => number,
		private readonly onStatement?: (ms: number) => void,
	) {
		super(connection, resolve, clock);
	}

	override async sql(statement: string): Promise<Record<string, unknown>[]> {
		const started = performance.now();
		try {
			return await super.sql(statement);
		} finally {
			this.onStatement?.(performance.now() - started);
		}
	}
}

/** A many-readers / one-writer lock (the writer is the live-file swap). */
export class RwLock {
	private readers = 0;
	private writing = false;
	private waiting: { write: boolean; go: () => void }[] = [];

	private pump(): void {
		while (this.waiting.length) {
			const next = this.waiting[0];
			if (next.write ? this.writing || this.readers > 0 : this.writing) return;
			this.waiting.shift();
			if (next.write) this.writing = true;
			else this.readers++;
			next.go();
			if (next.write) return;
		}
	}

	private acquire(write: boolean): Promise<void> {
		return new Promise((go) => {
			this.waiting.push({ write, go });
			this.pump();
		});
	}

	async read<T>(job: () => Promise<T>): Promise<T> {
		await this.acquire(false);
		try {
			return await job();
		} finally {
			this.readers--;
			this.pump();
		}
	}

	async write<T>(job: () => Promise<T>): Promise<T> {
		await this.acquire(true);
		try {
			return await job();
		} finally {
			this.writing = false;
			this.pump();
		}
	}
}

/** Runs jobs one at a time. */
export class Mutex {
	private chain: Promise<unknown> = Promise.resolve();
	run<T>(job: () => Promise<T>): Promise<T> {
		const next = this.chain.then(job, job);
		this.chain = next.catch(() => {});
		return next;
	}
}

export interface WarehouseOptions {
	dataDir: string;
	memoryLimit: string;
	threads: number;
	/** Days of day files and of raw archives kept (0 = forever); a function is read at every prune (a runtime setting). */
	keepDays: number | (() => number);
	rawKeepDays: number | (() => number);
	compactMb: number;
	queryTimeoutSeconds: number;
	queryConcurrency: number;
	fsyncMs: number;
	clock?: () => number;
	log?: (line: string) => void;
	/** Server metrics (server/metrics.ts): every statement on a read connection with its time, every row the loader puts in. */
	hooks?: { statement?(ms: number): void; loaded?(rows: number): void };
}

export interface WarehouseStats {
	loadedFiles: number;
	loadedRows: number;
	lastLoadMs: number;
	lastLoadAt: number | null;
	lastNightlyAt: number | null;
	exportedDays: string[];
	compactions: number;
	erasedPids: number;
}

const TABLES = ["events", "recordings"] as const;

export class Warehouse {
	readonly layout: DataLayout;
	readonly raw: RawLog;
	readonly stats: WarehouseStats = { loadedFiles: 0, loadedRows: 0, lastLoadMs: 0, lastLoadAt: null, lastNightlyAt: null, exportedDays: [], compactions: 0, erasedPids: 0 };
	private readonly lock = new RwLock();
	private readonly jobs = new Mutex();
	private readonly free: DuckDBConnection[] = [];
	/** Every read connection, free or running a query (close() interrupts and closes them all). */
	private readonly pool = new Set<DuckDBConnection>();
	private readonly waiters: ((c: DuckDBConnection) => void)[] = [];
	private closing: Promise<void> | undefined;
	private erased = new Set<string>();
	/** Bumped whenever the live tables change (load, export, erasure): SQL snapshots older than it are stale. */
	private liveVersion = 0;
	private readonly snapshots = new Map<"events" | "recordings", { version: number; path: string }>();
	private snapshotSeq = 0;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;

	private constructor(
		private readonly options: WarehouseOptions,
		private instance: DuckDBInstance,
		private writer: DuckDBConnection,
	) {
		this.layout = dataLayout(options.dataDir);
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
		this.raw = new RawLog(this.layout.rawIncoming, options.fsyncMs, this.clock);
	}

	/**
	 * Opens the data folder. Throws DataFolderLocked when another process holds it (nothing in the folder is touched then:
	 * the raw files stay the other process's until it lets go).
	 */
	static async open(options: WarehouseOptions): Promise<Warehouse> {
		const layout = dataLayout(options.dataDir);
		for (const dir of [layout.root, layout.events, layout.recordings, layout.rollups, layout.rawIncoming, layout.rawArchive, layout.tmp, layout.erasure]) mkdirSync(dir, { recursive: true });
		const instance = await DuckDBInstance.create(":memory:", {
			memory_limit: options.memoryLimit,
			threads: String(options.threads),
			temp_directory: layout.tmp.replace(/\\/g, "/"),
			preserve_insertion_order: "false",
		});
		let writer: DuckDBConnection | undefined;
		let warehouse: Warehouse | undefined;
		try {
			writer = await instance.connect();
			// The owner lock first: a server keeps it attached for its whole run, so no other process can slip in while
			// compaction has live.duckdb detached. Then live.duckdb (a server from before the owner lock holds only that).
			for (const [file, alias] of [
				[layout.lock, "folder_lock"],
				[layout.live, "live"],
			] as const) {
				try {
					await writer.run(`ATTACH ${pathLit(file)} AS ${alias}`);
				} catch (error) {
					if (isLockConflict(error)) throw new DataFolderLocked(file, (error as Error).message);
					throw error;
				}
			}
			// Only now, with the folder ours, are the raw files touched (RawLog makes the last run's open files ready).
			warehouse = new Warehouse(options, instance, writer);
			await warehouse.prepareLive();
			await warehouse.recover();
			return warehouse;
		} catch (error) {
			// Let go of everything, so a retry (or another process) can open the folder.
			if (warehouse) {
				await warehouse.raw.close().catch(() => {});
				warehouse.closeHandles();
			} else {
				try {
					writer?.closeSync();
				} catch {}
				instance.closeSync();
			}
			throw error;
		}
	}

	/** The live tables (live.duckdb is attached), the erased list and a fresh pool of read connections. */
	private async prepareLive(): Promise<void> {
		for (const table of TABLES) await this.writer.run(createTableSql(`live.${table}`, table));
		await this.writer.run("CREATE TABLE IF NOT EXISTS live.loaded_files (name VARCHAR PRIMARY KEY, loaded_at BIGINT)");
		await this.writer.run("CREATE TABLE IF NOT EXISTS live.erased (pid VARCHAR PRIMARY KEY, erased_at BIGINT, rewritten BOOLEAN)");
		await this.writer.run("CREATE TABLE IF NOT EXISTS live.exports (target VARCHAR PRIMARY KEY, tmp VARCHAR)");
		this.erased = new Set((await readRows(this.writer, "SELECT pid FROM live.erased")).map((r) => String(r.pid)));
		this.stats.erasedPids = this.erased.size;
		// Every read connection is free here (open, or compaction under the write lock).
		for (const c of this.pool) c.closeSync();
		this.pool.clear();
		this.free.length = 0;
		for (let i = 0; i < this.options.queryConcurrency; i++) {
			const c = await this.instance.connect();
			this.pool.add(c);
			this.free.push(c);
		}
	}

	/** Finishes what a crash interrupted: half-done exports, and raw files loaded but not archived. */
	private async recover(): Promise<void> {
		for (const row of await readRows(this.writer, "SELECT target, tmp FROM live.exports")) {
			const target = String(row.target);
			const tmp = String(row.tmp);
			if (existsSync(tmp)) renameSync(tmp, target);
			await this.writer.run(`DELETE FROM live.exports WHERE target = ${lit(target)}`);
			this.log(`recovered an interrupted export: ${target}`);
		}
		const loaded = new Set((await readRows(this.writer, "SELECT name FROM live.loaded_files")).map((r) => String(r.name)));
		const done = this.raw.ready().filter((f) => loaded.has(f.name));
		if (done.length) await this.archive(done);
		await this.writer.run("DELETE FROM live.loaded_files");
	}

	// Loader ----------------------------------------------------------------------------------------------------------

	/** Rotates the raw files and loads every ready file into the live tables. */
	load(maxBytes = 256 * 1024 * 1024): Promise<{ files: number; rows: number }> {
		return this.jobs.run(async () => {
			const started = performance.now();
			await this.raw.rotate();
			let files = 0;
			let rows = 0;
			const ready = this.raw.ready();
			for (const table of TABLES) {
				let batch: ReadyFile[] = [];
				let bytes = 0;
				const flush = async () => {
					if (!batch.length) return;
					rows += await this.loadBatch(table, batch);
					files += batch.length;
					batch = [];
					bytes = 0;
				};
				for (const file of ready.filter((f) => f.table === table)) {
					if (file.bytes === 0) {
						unlinkSync(file.path);
						continue;
					}
					batch.push(file);
					bytes += file.bytes;
					if (bytes >= maxBytes) await flush();
				}
				await flush();
			}
			this.stats.loadedFiles += files;
			this.stats.loadedRows += rows;
			this.options.hooks?.loaded?.(rows);
			if (rows) this.liveVersion++;
			this.stats.lastLoadMs = Math.round(performance.now() - started);
			this.stats.lastLoadAt = this.clock();
			return { files, rows };
		});
	}

	private async loadBatch(table: "events" | "recordings", files: ReadyFile[]): Promise<number> {
		const cols = storedColumns(table)
			.map((c) => `"${c}"`)
			.join(", ");
		const list = files.map((f) => pathLit(f.path)).join(", ");
		await this.writer.run("BEGIN TRANSACTION");
		let rows = 0;
		try {
			const result = await this.writer.run(
				`INSERT INTO live.${table} (${cols}) SELECT ${cols} FROM read_json([${list}], format = 'newline_delimited', columns = ${readJsonColumns(table)}) r ` +
					`WHERE r.pid IS NULL OR NOT EXISTS (SELECT 1 FROM live.erased x WHERE x.pid = r.pid)`,
			);
			rows = result.rowsChanged;
			await this.writer.run(`INSERT INTO live.loaded_files VALUES ${files.map((f) => `(${lit(f.name)}, ${this.clock()})`).join(", ")}`);
			await this.writer.run("COMMIT");
		} catch (error) {
			await this.writer.run("ROLLBACK").catch(() => {});
			throw error;
		}
		await this.archive(files);
		await this.writer.run(`DELETE FROM live.loaded_files WHERE name IN (${files.map((f) => lit(f.name)).join(", ")})`);
		return rows;
	}

	/** Gzips loaded raw files into raw/archive/YYYY-MM-DD/ (dropping erased players' lines), then deletes them. */
	private async archive(files: ReadyFile[]): Promise<void> {
		for (const file of files) {
			const dir = join(this.layout.rawArchive, dayString(Math.floor(file.started / DAY_MS)));
			mkdirSync(dir, { recursive: true });
			const dest = join(dir, `${file.name}.gz`);
			if (this.erased.size) {
				await pipeline(Readable.from(filterLines(createReadStream(file.path), this.erased)), createGzip(), createWriteStream(dest));
			} else {
				await pipeline(createReadStream(file.path), createGzip(), createWriteStream(dest));
			}
			unlinkSync(file.path);
		}
	}

	// Nightly ---------------------------------------------------------------------------------------------------------

	/** Exports every finished day still in the live file to Parquet, builds its rollups, prunes, and compacts. */
	nightly(): Promise<{ days: string[]; pruned: number; compacted: boolean }> {
		return this.jobs.run(async () => {
			const now = this.clock();
			const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
			const dayRows = await readRows(
				this.writer,
				`SELECT DISTINCT CAST(floor(t / 86400000.0) AS BIGINT) AS day FROM (SELECT t FROM live.events WHERE t < ${todayStart} UNION ALL SELECT t FROM live.recordings WHERE t < ${todayStart}) x ORDER BY day`,
			);
			const days: string[] = [];
			for (const row of dayRows) {
				const day = Number(row.day);
				await this.exportDay(day);
				await this.rollupDay(day);
				days.push(dayString(day));
			}
			if (days.length) await this.rebuildPlayers();
			const pruned = this.prune(now);
			let compacted = false;
			if (existsSync(this.layout.live) && statSync(this.layout.live).size > this.options.compactMb * 1024 * 1024) {
				await this.compact();
				compacted = true;
			}
			this.stats.lastNightlyAt = now;
			this.stats.exportedDays = days;
			if (days.length || pruned || compacted) this.log(`nightly: exported ${days.join(", ") || "nothing"}, pruned ${pruned} files${compacted ? ", compacted live.duckdb" : ""}`);
			return { days, pruned, compacted };
		});
	}

	private async exportDay(day: number): Promise<void> {
		const date = dayString(day);
		const where = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		for (const table of TABLES) {
			const count = Number((await readRows(this.writer, `SELECT COUNT(*) AS n FROM live.${table} WHERE ${where}`))[0].n);
			if (count === 0) continue;
			const cols = storedColumns(table)
				.map((c) => `"${c}"`)
				.join(", ");
			const target = join(table === "events" ? this.layout.events : this.layout.recordings, `${date}.parquet`);
			const tmp = `${target}.tmp`;
			const source = existsSync(target)
				? `SELECT ${cols} FROM read_parquet(${pathLit(target)}) UNION ALL SELECT ${cols} FROM live.${table} WHERE ${where}`
				: `SELECT ${cols} FROM live.${table} WHERE ${where}`;
			// Delivery is at least once (a hot swap during a request resends its rows): exact duplicates collapse here,
			// keeping the first receive time.
			const contract = fieldsOf(table)
				.map((field) => `"${field.name}"`)
				.join(", ");
			await this.writer.run(
				`COPY (SELECT ${contract}, MIN(rt) AS rt FROM (${source}) x GROUP BY ALL ORDER BY pid, t) TO ${pathLit(tmp)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`,
			);
			// The rows leave the live file and the export is recorded in one transaction; a crash after it is finished
			// by recover() (rename tmp -> target), so no row is lost or written twice.
			await this.writer.run("BEGIN TRANSACTION");
			await this.writer.run(`DELETE FROM live.${table} WHERE ${where}`);
			await this.writer.run(`INSERT INTO live.exports VALUES (${lit(target)}, ${lit(tmp)})`);
			await this.writer.run("COMMIT");
			this.liveVersion++;
			renameSync(tmp, target);
			await this.writer.run(`DELETE FROM live.exports WHERE target = ${lit(target)}`);
		}
	}

	/** Rollups for one finished day: per artifact/branch/device/new/variant numbers, per-player numbers, graph edges. */
	private async rollupDay(day: number): Promise<void> {
		const date = dayString(day);
		const events = join(this.layout.events, `${date}.parquet`);
		if (!existsSync(events)) return;
		const src = `read_parquet(${pathLit(events)})`;
		const robux = duckdb.jsonNumber("props", PROP_KEYS.purchaseRobux);
		const step = duckdb.jsonNumber("props", PROP_KEYS.funnelStep);
		const sessions =
			`s AS (SELECT sid, MIN(pid) AS pid, MIN(t) AS t0, MAX(t) AS t1, MIN(art) AS art, MIN(branch) AS branch, MIN(dev) AS dev, MIN(exp) AS exp, ` +
			`MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew FROM ${src} WHERE pid IS NOT NULL AND pid <> '' AND sid IS NOT NULL AND sid <> '' GROUP BY sid)`;
		// Revenue counts server-sent purchase rows only: older engines let a client send `purchase` events (src = client),
		// which would inflate Robux numbers; ingest refuses them now, but older stored rows may hold some (queries/core.ts
		// SERVER_PURCHASE applies the same rule to the live queries).
		const purchases = `pu AS (SELECT sid, COUNT(*) AS purchases, SUM(COALESCE(${robux}, 0)) AS robux FROM ${src} WHERE kind = 'purchase' AND (src IS NULL OR src <> 'client') GROUP BY sid)`;
		const out = (dir: string) => {
			const folder = join(this.layout.rollups, dir);
			mkdirSync(folder, { recursive: true });
			return join(folder, `${date}.parquet`);
		};
		const write = async (target: string, select: string) => {
			await this.writer.run(`COPY (${select}) TO ${pathLit(`${target}.tmp`)} (FORMAT parquet, COMPRESSION zstd)`);
			renameSync(`${target}.tmp`, target);
		};
		await write(
			out("daily"),
			`WITH ${sessions}, ${purchases} SELECT DATE '${date}' AS day, s.art AS art, s.branch AS branch, s.dev AS dev, s.isnew = 1 AS newp, s.exp AS exp, ` +
				`COUNT(DISTINCT s.pid) AS players, COUNT(*) AS sessions, SUM(s.t1 - s.t0) AS playtime_ms, COALESCE(SUM(pu.purchases), 0) AS purchases, ` +
				`COALESCE(SUM(pu.robux), 0) AS robux FROM s LEFT JOIN pu ON pu.sid = s.sid GROUP BY ALL`,
		);
		await write(
			out("player_days"),
			`WITH ${sessions}, ${purchases}, ob AS (SELECT pid, MAX(CAST(${step} AS BIGINT)) AS step FROM ${src} WHERE kind = 'funnel' AND name = 'onboarding' GROUP BY pid) ` +
				`SELECT s.pid AS pid, DATE '${date}' AS day, MIN(s.t0) AS first_t, MAX(s.t1) AS last_t, COUNT(*) AS sessions, SUM(s.t1 - s.t0) AS playtime_ms, ` +
				`COALESCE(SUM(pu.robux), 0) AS robux, COALESCE(SUM(pu.purchases), 0) AS purchases, MAX(ob.step) AS onboarding_step, ` +
				`arg_min(s.art, s.t0) AS first_art, arg_min(s.dev, s.t0) AS first_dev, MAX(s.isnew) = 1 AS new_player ` +
				`FROM s LEFT JOIN pu ON pu.sid = s.sid LEFT JOIN ob ON ob.pid = s.pid GROUP BY s.pid`,
		);
		await write(
			out("edges"),
			`WITH ev AS (SELECT pid, sid, t, NULLIF(state, '') AS st FROM ${src} WHERE pid IS NOT NULL AND pid <> '' AND sid IS NOT NULL AND sid <> ''), ` +
				`se AS (SELECT sid, MIN(pid) AS pid, MAX(t) AS end_t FROM ev GROUP BY sid), ` +
				`x AS (SELECT sid, t, st, LAG(st) OVER (PARTITION BY sid ORDER BY t) AS prev FROM ev WHERE st IS NOT NULL), ` +
				`v AS (SELECT sid, t AS enter_t, st FROM x WHERE prev IS NULL OR prev <> st), ` +
				`w AS (SELECT sid, st, enter_t, LEAD(st) OVER (PARTITION BY sid ORDER BY enter_t) AS nxt, LEAD(enter_t) OVER (PARTITION BY sid ORDER BY enter_t) AS nxt_t, ` +
				`ROW_NUMBER() OVER (PARTITION BY sid ORDER BY enter_t) AS rn FROM v), ` +
				`m AS (SELECT sid, '(start)' AS src, st AS dst, CAST(0 AS BIGINT) AS dwell FROM w WHERE rn = 1 UNION ALL SELECT sid, st, nxt, nxt_t - enter_t FROM w WHERE nxt IS NOT NULL ` +
				`UNION ALL SELECT w.sid, w.st, '(left)', se.end_t - w.enter_t FROM w JOIN se ON se.sid = w.sid WHERE w.nxt IS NULL) ` +
				`SELECT se.pid AS pid, DATE '${date}' AS day, m.src AS src, m.dst AS dst, COUNT(*) AS n, SUM(m.dwell) AS dwell_ms FROM m JOIN se ON se.sid = m.sid GROUP BY ALL`,
		);
	}

	/** players.parquet: one row per player, rebuilt from every player-day file (idempotent). */
	private async rebuildPlayers(): Promise<void> {
		const files = dayFiles(join(this.layout.rollups, "player_days"));
		if (!files.length) return;
		const target = join(this.layout.rollups, "players.parquet");
		await this.writer.run(
			`COPY (SELECT pid, MIN(first_t) AS first_t, MAX(last_t) AS last_t, COUNT(*) AS days, SUM(sessions) AS sessions, SUM(playtime_ms) AS playtime_ms, ` +
				`SUM(robux) AS robux, SUM(purchases) AS purchases, MAX(onboarding_step) AS onboarding_step, arg_min(first_art, first_t) AS first_art, ` +
				`arg_min(first_dev, first_t) AS first_dev FROM read_parquet([${files.map((f) => pathLit(f.path)).join(", ")}]) GROUP BY pid ORDER BY pid) ` +
				`TO ${pathLit(`${target}.tmp`)} (FORMAT parquet, COMPRESSION zstd)`,
		);
		renameSync(`${target}.tmp`, target);
	}

	/** Deletes day files older than keepDays and raw archives older than rawKeepDays. Returns files removed. */
	private prune(now: number): number {
		const today = Math.floor(now / DAY_MS);
		const read = (v: number | (() => number)) => (typeof v === "function" ? v() : v);
		const keepDays = read(this.options.keepDays);
		const rawKeepDays = read(this.options.rawKeepDays);
		let removed = 0;
		if (keepDays > 0) {
			const dirs = [this.layout.events, this.layout.recordings, ...["daily", "player_days", "edges"].map((d) => join(this.layout.rollups, d))];
			for (const dir of dirs) {
				for (const file of dayFiles(dir)) {
					if (file.day < today - keepDays) {
						unlinkSync(file.path);
						removed++;
					}
				}
			}
		}
		if (rawKeepDays > 0 && existsSync(this.layout.rawArchive)) {
			for (const name of readdirSync(this.layout.rawArchive)) {
				const day = Math.floor(Date.parse(`${name}T00:00:00Z`) / DAY_MS);
				if (Number.isFinite(day) && day < today - rawKeepDays) {
					rmSync(join(this.layout.rawArchive, name), { recursive: true, force: true });
					removed++;
				}
			}
		}
		return removed;
	}

	/**
	 * Rewrites live.duckdb into a fresh file (DuckDB doesn't reliably give space back after deletes). live.duckdb is
	 * detached for a moment; the owner lock (lock.duckdb) stays attached, so no other process can take the folder then.
	 */
	compact(): Promise<void> {
		return this.lock.write(async () => {
			const next = join(this.layout.root, "live-next.duckdb");
			rmSync(next, { force: true });
			rmSync(`${next}.wal`, { force: true });
			await this.writer.run(`ATTACH ${pathLit(next)} AS nxt`);
			for (const table of ["events", "recordings", "loaded_files", "erased", "exports"]) {
				await this.writer.run(`CREATE TABLE nxt.${table} AS SELECT * FROM live.${table}`);
			}
			await this.writer.run("DETACH nxt");
			await this.writer.run("DETACH live");
			const old = join(this.layout.root, "live-old.duckdb");
			renameSync(this.layout.live, old);
			rmSync(`${this.layout.live}.wal`, { force: true });
			renameSync(next, this.layout.live);
			rmSync(old, { force: true });
			await this.writer.run(`ATTACH ${pathLit(this.layout.live)} AS live`);
			await this.prepareLive();
			this.stats.compactions++;
		});
	}

	/**
	 * Runs `fn` between jobs (server/backup.ts): no load, nightly export, prune, compaction or erasure runs meanwhile, so
	 * live.duckdb and the day files `fn` sees belong together. `copyLive(file)` writes a copy of the live database to
	 * `file` in one transaction (DuckDB's COPY FROM DATABASE), safe while queries run.
	 */
	betweenJobs<T>(fn: (copyLive: (file: string) => Promise<void>) => Promise<T>): Promise<T> {
		return this.jobs.run(() =>
			fn(async (file) => {
				rmSync(file, { force: true });
				rmSync(`${file}.wal`, { force: true });
				await this.writer.run(`ATTACH ${pathLit(file)} AS backup_copy`);
				try {
					await this.writer.run("COPY FROM DATABASE live TO backup_copy");
				} finally {
					await this.writer.run("DETACH backup_copy");
				}
			}),
		);
	}

	// Queries ---------------------------------------------------------------------------------------------------------

	private async connection(): Promise<DuckDBConnection> {
		const c = this.free.pop();
		if (c) return c;
		return new Promise((done) => this.waiters.push(done));
	}

	private release(c: DuckDBConnection): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(c);
		else this.free.push(c);
	}

	/** A query context over live + Parquet (for rendering). */
	context(): QueryContext {
		return { dialect: duckdb, table: (name, from, to) => tableExpression(this.layout, name, from, to, "live"), now: this.clock() };
	}

	/** Runs a logical query on a pooled connection, interrupted after queryTimeoutSeconds. */
	query(name: string, filters?: Filters, options?: object): Promise<unknown> {
		return this.lock.read(async () => {
			const c = await this.connection();
			const timer = setTimeout(() => c.interrupt(), this.options.queryTimeoutSeconds * 1000);
			try {
				const store = new MeteredStore(c, (n, from, to) => tableExpression(this.layout, n, from, to, "live"), this.clock, this.options.hooks?.statement);
				return await runQuery(this.context(), (s) => store.runStatements(s), name, filters, options);
			} finally {
				clearTimeout(timer);
				this.release(c);
			}
		});
	}

	/** Raw SQL on a pooled connection (rollup reads, tests). */
	sql(statement: string): Promise<Record<string, unknown>[]> {
		return this.lock.read(async () => {
			const c = await this.connection();
			const timer = setTimeout(() => c.interrupt(), this.options.queryTimeoutSeconds * 1000);
			const started = performance.now();
			try {
				return await readRows(c, statement);
			} finally {
				clearTimeout(timer);
				this.release(c);
				this.options.hooks?.statement?.(performance.now() - started);
			}
		});
	}

	/** Rows in the live tables (stats). */
	async liveRows(): Promise<{ events: number; recordings: number }> {
		const rows = await this.sql("SELECT (SELECT COUNT(*) FROM live.events) AS events, (SELECT COUNT(*) FROM live.recordings) AS recordings");
		return { events: Number(rows[0].events), recordings: Number(rows[0].recordings) };
	}

	/**
	 * Parquet copies of today's live tables for the SQL sandbox (data/sql/live-<table>-*.parquet). A copy is reused until
	 * the live tables change; older copies are deleted (best effort: Windows keeps a file a running query reads).
	 */
	snapshotLive(tables: ("events" | "recordings")[]): Promise<Partial<Record<"events" | "recordings", string>>> {
		return this.lock.read(async () => {
			const dir = join(this.layout.root, "sql");
			mkdirSync(dir, { recursive: true });
			const out: Partial<Record<"events" | "recordings", string>> = {};
			for (const table of tables) {
				const current = this.snapshots.get(table);
				if (current && current.version === this.liveVersion && existsSync(current.path)) {
					out[table] = current.path;
					continue;
				}
				const version = this.liveVersion;
				const path = join(dir, `live-${table}-${Date.now()}-${++this.snapshotSeq}.parquet`);
				const c = await this.connection();
				try {
					await c.run(`COPY (SELECT * FROM live.${table}) TO ${pathLit(path)} (FORMAT parquet, COMPRESSION zstd)`);
				} finally {
					this.release(c);
				}
				this.snapshots.set(table, { version, path });
				out[table] = path;
			}
			const keep = new Set([...this.snapshots.values()].map((s) => s.path));
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (!/^live-.*\.parquet$/.test(name) || keep.has(path)) continue;
				try {
					rmSync(path, { force: true });
				} catch {
					// still open in a running query (Windows); the next snapshot tries again
				}
			}
			return out;
		});
	}

	// Right to Erasure ------------------------------------------------------------------------------------------------

	isErased(pid: string): boolean {
		return this.erased.has(pid);
	}

	/**
	 * Deletes players' rows: at once from the live tables (and from every later load: erased pids are filtered), then
	 * in the background from the day files, rollups and raw archives (`rewriteErased`).
	 */
	erase(pids: string[]): Promise<{ liveRows: number }> {
		return this.jobs.run(async () => {
			const clean = [...new Set(pids)].filter((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p));
			if (!clean.length) return { liveRows: 0 };
			const list = clean.map(lit).join(", ");
			await this.writer.run(`INSERT OR IGNORE INTO live.erased VALUES ${clean.map((p) => `(${lit(p)}, ${this.clock()}, FALSE)`).join(", ")}`);
			let liveRows = 0;
			for (const table of TABLES) liveRows += (await this.writer.run(`DELETE FROM live.${table} WHERE pid IN (${list})`)).rowsChanged;
			for (const p of clean) this.erased.add(p);
			this.liveVersion++;
			// SQL snapshots of the live tables still hold their rows: drop them now (best effort, see snapshotLive).
			const sqlDir = join(this.layout.root, "sql");
			for (const name of existsSync(sqlDir) ? readdirSync(sqlDir) : []) {
				if (!/^live-.*\.parquet$/.test(name)) continue;
				try {
					rmSync(join(sqlDir, name), { force: true });
				} catch {
					// still open in a running query (Windows); the next snapshot deletes it
				}
			}
			this.snapshots.clear();
			this.stats.erasedPids = this.erased.size;
			return { liveRows };
		});
	}

	/** Removes erased players from day files, rollups and raw archives. Returns files rewritten. */
	rewriteErased(): Promise<{ pids: number; files: number }> {
		return this.jobs.run(async () => {
			const pending = (await readRows(this.writer, "SELECT pid FROM live.erased WHERE NOT rewritten")).map((r) => String(r.pid));
			if (!pending.length) return { pids: 0, files: 0 };
			const set = new Set(pending);
			const list = pending.map(lit).join(", ");
			let files = 0;
			const parquet = [
				...dayFiles(this.layout.events),
				...dayFiles(this.layout.recordings),
				...dayFiles(join(this.layout.rollups, "player_days")),
				...dayFiles(join(this.layout.rollups, "edges")),
			].map((f) => f.path);
			const players = join(this.layout.rollups, "players.parquet");
			if (existsSync(players)) parquet.push(players);
			for (const file of parquet) {
				const hit = Number((await readRows(this.writer, `SELECT COUNT(*) AS n FROM read_parquet(${pathLit(file)}) WHERE pid IN (${list})`))[0].n);
				if (!hit) continue;
				await this.writer.run(
					`COPY (SELECT * FROM read_parquet(${pathLit(file)}) WHERE pid IS NULL OR pid NOT IN (${list})) TO ${pathLit(`${file}.tmp`)} (FORMAT parquet, COMPRESSION zstd)`,
				);
				renameSync(`${file}.tmp`, file);
				files++;
			}
			if (existsSync(this.layout.rawArchive)) {
				for (const day of readdirSync(this.layout.rawArchive)) {
					const dir = join(this.layout.rawArchive, day);
					for (const name of readdirSync(dir)) {
						if (name.endsWith(".gz") && (await rewriteGzip(join(dir, name), set))) files++;
					}
				}
			}
			await this.writer.run(`UPDATE live.erased SET rewritten = TRUE WHERE pid IN (${list})`);
			return { pids: pending.length, files };
		});
	}

	/**
	 * Closes for good, promptly (a deploy hands the folder to the next server): the raw files are synced and made ready
	 * (the next start loads them), a running job gets `graceMs` and is then interrupted (every job is safe to cut: the next
	 * start redoes or finishes it, see recover()), running queries are interrupted, then CHECKPOINT and close, which lets
	 * go of live.duckdb and the owner lock. A second call waits for the first.
	 */
	close(graceMs = 3000): Promise<void> {
		this.closing ??= this.closeNow(graceMs);
		return this.closing;
	}

	private async closeNow(graceMs: number): Promise<void> {
		await this.raw.close();
		const jobDone = this.jobs.run(async () => {});
		if (!(await settlesWithin(jobDone, graceMs))) {
			this.log(`closing: interrupting the running job after ${graceMs / 1000} s (the next start redoes or finishes it)`);
			// A job runs many statements (and some file work between them): interrupt until it gives up, for a while.
			const deadline = Date.now() + graceMs;
			for (;;) {
				this.writer.interrupt();
				if ((await settlesWithin(jobDone, 100)) || Date.now() >= deadline) break;
			}
		}
		// Queries in flight: interrupted, then waited for (the write side of the lock waits for every reader).
		for (const c of this.pool) c.interrupt();
		await settlesWithin(this.lock.write(async () => {}), graceMs);
		// CHECKPOINT alone would fold only the default (in-memory) database: name the file.
		await this.writer.run("CHECKPOINT live").catch(() => {});
		this.closeHandles();
	}

	/** Closes every DuckDB handle (the files' locks go with the instance). */
	private closeHandles(): void {
		for (const c of this.pool) {
			try {
				c.closeSync();
			} catch {}
		}
		this.pool.clear();
		this.free.length = 0;
		try {
			this.writer.closeSync();
		} catch {}
		this.instance.closeSync();
	}
}

/** Whether `promise` settles (either way) within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		new Promise<boolean>((done) => (timer = setTimeout(() => done(false), ms))),
	]);
	clearTimeout(timer);
	return settled;
}

const PID_FIELD = /"pid":"([^"\\]*)"/;

/** Lines of an NDJSON stream without erased players' rows. */
async function* filterLines(input: NodeJS.ReadableStream, erased: Set<string>): AsyncGenerator<string> {
	const lines = createInterface({ input, crlfDelay: Infinity });
	for await (const line of lines) {
		const pid = PID_FIELD.exec(line)?.[1];
		if (pid !== undefined && erased.has(pid)) continue;
		yield `${line}\n`;
	}
}

/** Rewrites a .ndjson.gz without erased players' lines; returns true when something was removed. */
async function rewriteGzip(path: string, erased: Set<string>): Promise<boolean> {
	let hit = false;
	const file = createReadStream(path);
	const lines = createInterface({ input: file.pipe(createGunzip()), crlfDelay: Infinity });
	for await (const line of lines) {
		const pid = PID_FIELD.exec(line)?.[1];
		if (pid !== undefined && erased.has(pid)) {
			hit = true;
			break;
		}
	}
	lines.close();
	// Windows can't rename over a file that is still open.
	await new Promise<void>((done) => {
		if (file.closed) return done();
		file.once("close", () => done());
		file.destroy();
	});
	if (!hit) return false;
	const tmp = `${path}.tmp`;
	await pipeline(Readable.from(filterLines(createReadStream(path).pipe(createGunzip()), erased)), createGzip(), createWriteStream(tmp));
	mkdirSync(dirname(path), { recursive: true });
	renameSync(tmp, path);
	return true;
}
