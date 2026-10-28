/**
 * A worker thread for server/backup.ts: copies the SQLite file with `VACUUM INTO` on its own connection, so a big file
 * never holds the server's event loop. In WAL mode that connection reads one consistent snapshot while the server keeps
 * writing. Gets `{ source, target }`, answers `{ ok: true }` or `{ ok: false, error }`.
 */
import { parentPort, workerData } from "node:worker_threads";

interface SyncDb {
	exec(sql: string): void;
	close(): void;
}

const { source, target } = workerData as { source: string; target: string };

async function open(path: string): Promise<SyncDb> {
	if (typeof process.versions.bun === "string") {
		const name = "bun:sqlite";
		const { Database } = (await import(name)) as { Database: new (path: string, options?: object) => SyncDb };
		return new Database(path);
	}
	const name = "node:sqlite";
	const { DatabaseSync } = (await import(name)) as { DatabaseSync: new (path: string) => SyncDb };
	return new DatabaseSync(path);
}

try {
	const db = await open(source);
	try {
		db.exec("PRAGMA busy_timeout = 10000;");
		db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
	} finally {
		db.close();
	}
	parentPort?.postMessage({ ok: true });
} catch (error) {
	parentPort?.postMessage({ ok: false, error: ((error as Error).message ?? String(error)).slice(0, 300) });
}
