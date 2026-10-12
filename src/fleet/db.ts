/**
 * The fleet API's storage: SQLite through a tiny async interface, so the same service code can later run on a
 * Cloudflare Worker with D1 (also SQLite, async-only). Here: `bun:sqlite` under Bun, `node:sqlite` under Node 22.5+,
 * both in WAL mode.
 */
/** Uint8Array: a BLOB (the debug bundles' gzipped bodies). */
export type SqlValue = string | number | null | Uint8Array;

export interface FleetDb {
	exec(sql: string): Promise<void>;
	run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastId: number }>;
	all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
	first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
	/**
	 * Runs `fn` synchronously inside one transaction (COMMIT, or ROLLBACK when it throws). Nothing else can run statements
	 * in between, and many small writes cost one commit instead of one each.
	 */
	transaction<T>(fn: (tx: SyncTx) => T): Promise<T>;
	close(): Promise<void>;
}

/** The synchronous statements a transaction body may run. */
export interface SyncTx {
	run(sql: string, params?: SqlValue[]): { changes: number; lastId: number };
	all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T[];
	first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T | undefined;
}

interface SyncStatement {
	all(...params: SqlValue[]): unknown[];
	get(...params: SqlValue[]): unknown;
	run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	/** bun:sqlite: frees the statement (a database with live statements closes only lazily). */
	finalize?(): void;
}

interface SyncDatabase {
	exec(sql: string): void;
	prepare(sql: string): SyncStatement;
	close(): void;
}

/** Wraps a synchronous SQLite handle (bun:sqlite Database or node:sqlite DatabaseSync) with cached statements. */
export function wrapSync(db: SyncDatabase): FleetDb {
	const cache = new Map<string, SyncStatement>();
	const statement = (sql: string) => {
		let s = cache.get(sql);
		if (!s) {
			s = db.prepare(sql);
			cache.set(sql, s);
		}
		return s;
	};
	return {
		async exec(sql) {
			db.exec(sql);
		},
		async run(sql, params = []) {
			const r = statement(sql).run(...params);
			return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
		},
		async all<T>(sql: string, params: SqlValue[] = []) {
			return statement(sql).all(...params) as T[];
		},
		async first<T>(sql: string, params: SqlValue[] = []) {
			return (statement(sql).get(...params) ?? undefined) as T | undefined;
		},
		async transaction<T>(fn: (tx: SyncTx) => T): Promise<T> {
			const tx: SyncTx = {
				run: (sql, params = []) => {
					const r = statement(sql).run(...params);
					return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
				},
				all: <R>(sql: string, params: SqlValue[] = []) => statement(sql).all(...params) as R[],
				first: <R>(sql: string, params: SqlValue[] = []) => (statement(sql).get(...params) ?? undefined) as R | undefined,
			};
			db.exec("BEGIN IMMEDIATE");
			try {
				const out = fn(tx);
				db.exec("COMMIT");
				return out;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				throw error;
			}
		},
		async close() {
			for (const s of cache.values()) s.finalize?.();
			cache.clear();
			// Fold the write-ahead log back into the database and empty it, so a stopped server leaves a small file.
			try {
				db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
			} catch {}
			db.close();
		},
	};
}

/** Opens (creates) a SQLite file in WAL mode. ":memory:" works for tests. */
export async function openSqlite(path: string): Promise<FleetDb> {
	let db: SyncDatabase;
	if (typeof process.versions.bun === "string") {
		const name = "bun:sqlite";
		const { Database } = (await import(name)) as { Database: new (path: string, options?: object) => SyncDatabase };
		db = new Database(path, { create: true });
	} else {
		const name = "node:sqlite";
		let mod: { DatabaseSync: new (path: string) => SyncDatabase };
		try {
			mod = (await import(name)) as typeof mod;
		} catch {
			throw new Error(`the fleet API needs node:sqlite (Node 22.5+; this is ${process.version}) or Bun`);
		}
		db = new mod.DatabaseSync(path);
	}
	// WAL: every heartbeat is a write. SQLite only checkpoints at 1000 pages (~4 MB) by default and then keeps the WAL file
	// at that size, so a tiny fleet showed ~4 MB on disk. Checkpoint at ~1 MB and truncate the WAL back to 1 MB after.
	db.exec(
		"PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF; " +
			"PRAGMA wal_autocheckpoint = 256; PRAGMA journal_size_limit = 1048576;",
	);
	// A WAL left large by an older server (or a crash): fold it in now.
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
	} catch {}
	return wrapSync(db);
}
