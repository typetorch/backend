/**
 * Plans/35 A: the export API, so a new server can pull this one's history over HTTP (never a file copy). Read-only: it
 * never touches a file the server writes; it reads the day files and the live tables through the warehouse's read pool,
 * and SQLite through plain SELECTs. Admin role over a Bearer token only (the CLI, the migration job): never the web role,
 * never a browser session. One export request at a time (429 + Retry-After otherwise), 120 a minute.
 *
 *   GET /v1/admin/export/manifest                              every day with its rows and hash, the live rows, the SQLite
 *                                                              tables' sizes, the erased count
 *   GET /v1/admin/export/rows?table=&day=&page=&size=          gzip NDJSON in the stored row format (with rt)
 *   GET|POST /v1/admin/export/hash?table=&day=&exclude=a,b     { rows, hash } without those pids
 *   GET /v1/admin/export/fleet?table=&after=&size=             { rows, next } pages of the SQLite history
 *   GET /v1/admin/export/erased                                { pids }
 *
 * `hash` = the decimal string of bit_xor(hash(<every stored column>)) (DuckDB's UBIGINT): order-free, so the new server
 * computes the same number over its copy. Rows of erased players are left out of every answer.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { dayFiles, dayNumber, dayString, fieldsOf, pathLit, storedColumns } from "../duckdb/layout.ts";
import type { FleetDb } from "../fleet/db.ts";
import { DAY_MS, lit } from "../sql/dialect.ts";
import { readRows } from "../store/duckdb.ts";
import { json, RateLimiter, readCapped } from "./http.ts";
import type { Warehouse } from "./warehouse.ts";

export const EXPORT_TABLES = ["events", "recordings"] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];
/** The SQLite tables the export API pages through, in the order a migration imports them. */
export const FLEET_EXPORT_TABLES = ["deploys", "marks", "reports", "alerts", "server_metrics", "error_kinds", "error_counts", "error_jobs", "error_pids", "identities", "saved_queries", "audit_log"] as const;
export type FleetExportTable = (typeof FLEET_EXPORT_TABLES)[number];
/** Tables keyed by an integer (the cursor is that key or the rowid); the rest are WITHOUT ROWID and page by position. */
const POSITION_PAGED = new Set<FleetExportTable>(["error_counts", "error_jobs", "error_pids"]);
/** The primary key order of the position-paged tables. */
const ORDER_OF: Partial<Record<FleetExportTable, string>> = {
	error_counts: "fp, minute, branch, build, realm",
	error_jobs: "fp, job, realm, branch, build",
	error_pids: "fp, day, realm, branch, build, pid",
};
/** Tables holding pids: rows of erased players are left out. */
const PID_TABLES = new Set<FleetExportTable>(["error_pids", "identities"]);
export const ROWS_PAGE_MAX = 50_000;
export const FLEET_PAGE_MAX = 5_000;
export const EXCLUDE_MAX = 100_000;
export const EXPORT_PER_MINUTE = 120;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const PID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
/** The export's statements may scan a whole day file: longer than a query's timeout. */
const EXPORT_TIMEOUT_MS = 10 * 60_000;

export interface DayStat {
	day: string;
	rows: number;
	hash: string;
}

export interface ExportManifest {
	version: 1;
	server: { instance: string; now: number };
	tables: Record<ExportTable, DayStat[]>;
	live: { day: string | null; rows: number; lastRt: number | null };
	fleet: Record<string, { rows: number; maxId: number | null }>;
	erased: number;
}

const xor = (a: string, b: string): string => (BigInt(a) ^ BigInt(b)).toString();
const quoted = (table: ExportTable) =>
	storedColumns(table)
		.map((c) => `"${c}"`)
		.join(", ");
const notErased = "(pid IS NULL OR pid NOT IN (SELECT pid FROM live.erased))";
const excluding = (exclude: readonly string[]) => (exclude.length ? ` AND (pid IS NULL OR pid NOT IN (${exclude.map(lit).join(", ")}))` : "");

/** The day file of `day` (null when there is none). */
export function dayFilePath(w: Warehouse, table: ExportTable, day: number): string | null {
	const path = join(table === "events" ? w.layout.events : w.layout.recordings, `${dayString(day)}.parquet`);
	return existsSync(path) ? path : null;
}

/** Rows and hash of one source over `where`. */
async function statOf(c: DuckDBConnection, table: ExportTable, from: string, where: string): Promise<{ rows: number; hash: string }> {
	const row = (await readRows(c, `SELECT COUNT(*) AS n, CAST(COALESCE(bit_xor(hash(${quoted(table)})), 0) AS VARCHAR) AS h FROM ${from} WHERE ${where}`))[0];
	return { rows: Number(row?.n ?? 0), hash: String(row?.h ?? "0") };
}

/**
 * Rows and hash of one day as this server holds it (the day file and the live rows of that day), without erased players
 * and without `exclude`. The migration verifies with it on both sides.
 */
export async function dayStat(w: Warehouse, table: ExportTable, day: number, exclude: readonly string[] = []): Promise<{ rows: number; hash: string }> {
	return w.read(async (c) => {
		const file = dayFilePath(w, table, day);
		const inDay = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		const live = await statOf(c, table, `live.${table}`, `${inDay} AND ${notErased}${excluding(exclude)}`);
		if (!file) return live;
		const fromFile = await statOf(c, table, `read_parquet(${pathLit(file)})`, `${notErased}${excluding(exclude)}`);
		return { rows: live.rows + fromFile.rows, hash: xor(live.hash, fromFile.hash) };
	}, EXPORT_TIMEOUT_MS);
}

/** The rows of `table` of `day` that are not in this server's copy of the day (contract columns, so a duplicate's receive time doesn't count). */
export async function missingRows(w: Warehouse, table: ExportTable, day: number, pageFiles: string | string[], readColumns: string, contract: string): Promise<number> {
	const list = (Array.isArray(pageFiles) ? pageFiles : [pageFiles]).filter((f) => existsSync(f) && statSync(f).size > 0);
	if (!list.length) return 0;
	return w.read(async (c) => {
		const file = dayFilePath(w, table, day);
		const inDay = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		const here = [`SELECT ${contract} FROM live.${table} WHERE ${inDay}`, ...(file ? [`SELECT ${contract} FROM read_parquet(${pathLit(file)})`] : [])].join(" UNION ALL ");
		const rows = await readRows(
			c,
			`SELECT COUNT(*) AS n FROM (SELECT ${contract} FROM read_json([${list.map(pathLit).join(", ")}], format = 'newline_delimited', columns = ${readColumns}) r WHERE ${inDay} AND ${notErased} EXCEPT SELECT * FROM (${here}))`,
		);
		return Number(rows[0]?.n ?? 0);
	}, EXPORT_TIMEOUT_MS);
}

/**
 * Plans/35 B (to Basin): a stable copy of one day as this server holds it (the day file and the day's live rows, without
 * erased players; with `newerThan`, only rows received after it), exact duplicates collapsed as the nightly export does,
 * sorted by every column, written to `out` (a temp file, renamed). The same rows always give the same file in the same
 * order, so a page (a range of its row numbers) can be rebuilt after a crash. Returns its rows, hash and newest `rt`.
 */
export async function snapshotDay(w: Warehouse, table: ExportTable, day: number, out: string, newerThan?: number): Promise<{ rows: number; hash: string; maxRt: number | null }> {
	return w.read(async (c) => {
		const file = dayFilePath(w, table, day);
		const inDay = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		const newer = newerThan === undefined ? "" : ` AND rt > ${Math.floor(newerThan)}`;
		const parts = [`SELECT ${quoted(table)} FROM live.${table} WHERE ${inDay} AND ${notErased}${newer}`];
		if (file) parts.push(`SELECT ${quoted(table)} FROM read_parquet(${pathLit(file)}) WHERE ${notErased}${newer}`);
		const contract = fieldsOf(table)
			.map((f) => `"${f.name}"`)
			.join(", ");
		const tmp = `${out}.tmp`;
		rmSync(tmp, { force: true });
		await c.run(`COPY (SELECT ${contract}, MIN(rt) AS rt FROM (${parts.join(" UNION ALL ")}) x GROUP BY ALL ORDER BY ALL) TO ${pathLit(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
		const row = (await readRows(c, `SELECT COUNT(*) AS n, CAST(COALESCE(bit_xor(hash(${quoted(table)})), 0) AS VARCHAR) AS h, MAX(rt) AS rt FROM read_parquet(${pathLit(tmp)})`))[0];
		renameSync(tmp, out);
		return { rows: Number(row?.n ?? 0), hash: String(row?.h ?? "0"), maxRt: row?.rt === null || row?.rt === undefined ? null : Number(row.rt) };
	}, EXPORT_TIMEOUT_MS);
}

/** Rows of a snapshot (snapshotDay) from row `from`, at most `count`, in its order, as plain objects of the stored columns. */
export async function snapshotRows(w: Warehouse, table: ExportTable, path: string, from: number, count: number): Promise<Record<string, unknown>[]> {
	return w.read(
		(c) => readRows(c, `SELECT ${quoted(table)} FROM read_parquet(${pathLit(path)}, file_row_number = true) WHERE file_row_number >= ${Math.floor(from)} AND file_row_number < ${Math.floor(from + count)} ORDER BY file_row_number`),
		EXPORT_TIMEOUT_MS,
	);
}

/** Rows and hash of a snapshot file (a check that a rebuilt snapshot holds the same rows). */
export async function snapshotStat(w: Warehouse, table: ExportTable, path: string): Promise<{ rows: number; hash: string }> {
	return w.read((c) => statOf(c, table, `read_parquet(${pathLit(path)})`, "TRUE"), EXPORT_TIMEOUT_MS);
}

/** Rows of a day (day file and live rows, without erased players) received after `newerThan` (rt). */
export async function newerRows(w: Warehouse, table: ExportTable, day: number, newerThan: number): Promise<number> {
	return w.read(async (c) => {
		const file = dayFilePath(w, table, day);
		const inDay = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		const where = `${notErased} AND rt > ${Math.floor(newerThan)}`;
		let n = (await statOf(c, table, `live.${table}`, `${inDay} AND ${where}`)).rows;
		if (file) n += (await statOf(c, table, `read_parquet(${pathLit(file)})`, where)).rows;
		return n;
	}, EXPORT_TIMEOUT_MS);
}

/** The newest receive time (`rt`) of this server's rows: the live tables and the day files of the last two days. */
export async function newestRt(w: Warehouse, now: number): Promise<number | null> {
	return w.read(async (c) => {
		let newest: number | null = null;
		const today = Math.floor(now / DAY_MS);
		for (const table of EXPORT_TABLES) {
			const sources = [`SELECT MAX(rt) AS rt FROM live.${table}`];
			for (const day of [today, today - 1]) {
				const file = dayFilePath(w, table, day);
				if (file) sources.push(`SELECT MAX(rt) AS rt FROM read_parquet(${pathLit(file)})`);
			}
			const row = (await readRows(c, `SELECT MAX(rt) AS rt FROM (${sources.join(" UNION ALL ")}) x`))[0];
			if (row?.rt !== null && row?.rt !== undefined) newest = Math.max(newest ?? 0, Number(row.rt));
		}
		return newest;
	}, EXPORT_TIMEOUT_MS);
}

/** The days this server holds rows of (day files and live rows), with an estimate of their rows (before dedupe). */
export async function localDays(w: Warehouse, table: ExportTable): Promise<{ day: number; rows: number }[]> {
	return w.read(async (c) => {
		const days = new Map<number, number>();
		for (const file of dayFiles(table === "events" ? w.layout.events : w.layout.recordings)) {
			const n = Number((await readRows(c, `SELECT COUNT(*) AS n FROM read_parquet(${pathLit(file.path)})`))[0]?.n ?? 0);
			if (n) days.set(file.day, n);
		}
		for (const row of await readRows(c, `SELECT CAST(floor(t / ${DAY_MS}.0) AS BIGINT) AS day, COUNT(*) AS n FROM live.${table} WHERE ${notErased} GROUP BY ALL`)) {
			days.set(Number(row.day), (days.get(Number(row.day)) ?? 0) + Number(row.n));
		}
		return [...days.entries()].map(([day, rows]) => ({ day, rows })).sort((a, b) => a.day - b.day);
	}, EXPORT_TIMEOUT_MS);
}

export interface ExportOptions {
	warehouse: () => Warehouse | undefined;
	/** Whether the analytics part runs here (else the day routes answer 404). */
	analytics: boolean;
	sqlite: FleetDb;
	clock: () => number;
	/** This server's name in the manifest (the instance key's fingerprint, else a per-process id). */
	instance: () => string;
	/** Turns the idle timeout off for this request (a manifest over a big history takes a while). */
	keepOpen?: (req: Request) => void;
	log?: (line: string) => void;
}

/** The export API (see the file's comment). */
export class ExportApi {
	private busy = false;
	private readonly limiter: RateLimiter;
	/** Rows and hash of each day file, while it is unchanged (path, size, mtime) and no player was erased since. */
	private readonly fileStats = new Map<string, { key: string; rows: number; hash: string }>();
	/** The sorted copy of one day's live rows, while the live tables are unchanged. */
	private liveCache: { table: ExportTable; day: number; version: number; erased: number; path: string; rows: number } | undefined;
	private seq = 0;

	constructor(private readonly o: ExportOptions) {
		this.limiter = new RateLimiter(EXPORT_PER_MINUTE, o.clock);
	}

	/** The working folder (its own; never a file the server writes): sorted live copies and pages on their way out. */
	private dir(w: Warehouse): string {
		const dir = join(w.layout.root, "export");
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	async handle(req: Request, path: string, url: URL): Promise<Response> {
		const route = path.slice("/v1/admin/export/".length);
		const known = ["manifest", "rows", "hash", "fleet", "erased"];
		if (!known.includes(route)) return json(404, { error: "not found", routes: known.map((r) => `/v1/admin/export/${r}`) });
		if (req.method !== "GET" && !(route === "hash" && req.method === "POST")) return json(405, { error: route === "hash" ? "GET or POST only" : "GET only" });
		if (!this.limiter.take("export")) return json(429, { error: "rate limited: 120 export requests a minute" }, { "retry-after": String(this.limiter.retryAfter("export")) });
		if (this.busy) return json(429, { error: "one export request at a time: try again in a moment" }, { "retry-after": "2" });
		this.busy = true;
		try {
			this.o.keepOpen?.(req);
			if (route === "fleet") return await this.fleet(url);
			if (route === "erased") return json(200, { pids: this.o.warehouse()?.erasedPids() ?? [] });
			if (!this.o.analytics) return json(404, { error: "the analytics part is off on this server" });
			const w = this.o.warehouse();
			if (!w) return json(503, { error: "analytics is starting (deploy handover): try again in a few seconds" }, { "retry-after": "5" });
			if (route === "manifest") return json(200, await this.manifest(w));
			if (route === "rows") return await this.rows(w, url);
			return await this.hash(w, req, url);
		} finally {
			this.busy = false;
		}
	}

	/** GET /v1/admin/export/manifest. */
	async manifest(w: Warehouse): Promise<ExportManifest> {
		const erasedCount = w.erasedPids().length;
		const tables = {} as Record<ExportTable, DayStat[]>;
		let liveRows = 0;
		let lastRt: number | null = null;
		let liveDay: number | null = null;
		for (const table of EXPORT_TABLES) {
			const days = new Map<number, { rows: number; hash: string }>();
			for (const file of dayFiles(table === "events" ? w.layout.events : w.layout.recordings)) {
				const st = statSync(file.path);
				const key = `${st.size}:${st.mtimeMs}:${erasedCount}`;
				let cached = this.fileStats.get(file.path);
				if (cached?.key !== key) {
					const s = await w.read((c) => statOf(c, table, `read_parquet(${pathLit(file.path)})`, notErased), EXPORT_TIMEOUT_MS);
					cached = { key, ...s };
					this.fileStats.set(file.path, cached);
				}
				if (cached.rows) days.set(file.day, { rows: cached.rows, hash: cached.hash });
			}
			const live = await w.read(
				(c) =>
					readRows(
						c,
						`SELECT CAST(floor(t / ${DAY_MS}.0) AS BIGINT) AS day, COUNT(*) AS n, CAST(COALESCE(bit_xor(hash(${quoted(table)})), 0) AS VARCHAR) AS h, MAX(rt) AS rt FROM live.${table} WHERE ${notErased} GROUP BY ALL`,
					),
				EXPORT_TIMEOUT_MS,
			);
			for (const row of live) {
				const day = Number(row.day);
				const rows = Number(row.n);
				liveRows += rows;
				if (row.rt !== null && row.rt !== undefined) lastRt = Math.max(lastRt ?? 0, Number(row.rt));
				liveDay = Math.max(liveDay ?? day, day);
				const had = days.get(day);
				days.set(day, had ? { rows: had.rows + rows, hash: xor(had.hash, String(row.h)) } : { rows, hash: String(row.h) });
			}
			tables[table] = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([day, s]) => ({ day: dayString(day), rows: s.rows, hash: s.hash }));
		}
		// Day files that are gone (pruned) leave the cache.
		for (const path of this.fileStats.keys()) if (!existsSync(path)) this.fileStats.delete(path);
		return {
			version: 1,
			server: { instance: this.o.instance(), now: this.o.clock() },
			tables,
			live: { day: liveDay === null ? null : dayString(liveDay), rows: liveRows, lastRt },
			fleet: await this.fleetSizes(),
			erased: erasedCount,
		};
	}

	private async fleetSizes(): Promise<Record<string, { rows: number; maxId: number | null }>> {
		const out: Record<string, { rows: number; maxId: number | null }> = {};
		for (const table of FLEET_EXPORT_TABLES) {
			if (!(await this.hasTable(table))) continue;
			const row = await this.o.sqlite.first<{ n: number; m: number | null }>(POSITION_PAGED.has(table) ? `SELECT COUNT(*) AS n, NULL AS m FROM ${table}` : `SELECT COUNT(*) AS n, MAX(rowid) AS m FROM ${table}`);
			out[table] = { rows: Number(row?.n ?? 0), maxId: row?.m === null || row?.m === undefined ? null : Number(row.m) };
		}
		return out;
	}

	private async hasTable(table: string): Promise<boolean> {
		return (await this.o.sqlite.first("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [table])) !== undefined;
	}

	/** table + day from the query, or the answer. */
	private dayParams(url: URL): { table: ExportTable; day: number } | Response {
		const table = url.searchParams.get("table") ?? "";
		const day = url.searchParams.get("day") ?? "";
		if (!(EXPORT_TABLES as readonly string[]).includes(table)) return json(400, { error: "table is events or recordings" });
		if (!DAY_TEXT.test(day) || !Number.isFinite(dayNumber(day))) return json(400, { error: "day is YYYY-MM-DD (UTC)" });
		return { table: table as ExportTable, day: dayNumber(day) };
	}

	/**
	 * GET /v1/admin/export/rows: page `page` of the day, `size` rows a page. The day file comes first, in its own order
	 * (a page is a range of its row numbers: stable, since day files are immutable), then the day's live rows ordered by
	 * every column (a sorted copy, made once per change of the live tables).
	 */
	private async rows(w: Warehouse, url: URL): Promise<Response> {
		const params = this.dayParams(url);
		if (params instanceof Response) return params;
		const page = Number(url.searchParams.get("page") ?? "0");
		const size = Number(url.searchParams.get("size") ?? String(ROWS_PAGE_MAX));
		if (!Number.isSafeInteger(page) || page < 0 || page > 10_000_000) return json(400, { error: "page is a whole number from 0" });
		if (!Number.isSafeInteger(size) || size < 1 || size > ROWS_PAGE_MAX) return json(400, { error: `size is 1 to ${ROWS_PAGE_MAX}` });
		const { table, day } = params;
		const cols = quoted(table);
		const file = dayFilePath(w, table, day);
		const fileRows = file ? Number((await w.read((c) => readRows(c, `SELECT COUNT(*) AS n FROM read_parquet(${pathLit(file)})`), EXPORT_TIMEOUT_MS))[0]?.n ?? 0) : 0;
		const filePages = Math.ceil(fileRows / size);
		// The live part: counted for a page of the day file (cheap), sorted into a copy only when a page falls in it.
		const inDay = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		const live =
			page < filePages
				? { path: null, rows: Number((await w.read((c) => readRows(c, `SELECT COUNT(*) AS n FROM live.${table} WHERE ${inDay} AND ${notErased}`), EXPORT_TIMEOUT_MS))[0]?.n ?? 0) }
				: await this.liveSorted(w, table, day);
		const pages = filePages + Math.ceil(live.rows / size);
		const out = join(this.dir(w), `page-${Date.now()}-${++this.seq}.ndjson`);
		let sent = 0;
		if (page < filePages && file) {
			const from = page * size;
			sent = (
				await w.read(
					(c) =>
						c.run(
							`COPY (SELECT ${cols} FROM read_parquet(${pathLit(file)}, file_row_number = true) WHERE file_row_number >= ${from} AND file_row_number < ${from + size} AND ${notErased} ORDER BY file_row_number) TO ${pathLit(out)} (FORMAT json)`,
						),
					EXPORT_TIMEOUT_MS,
				)
			).rowsChanged;
		} else if (page < pages && live.path) {
			const from = (page - filePages) * size;
			sent = (
				await w.read(
					(c) =>
						c.run(
							`COPY (SELECT ${cols} FROM read_parquet(${pathLit(live.path as string)}, file_row_number = true) WHERE file_row_number >= ${from} AND file_row_number < ${from + size} ORDER BY file_row_number) TO ${pathLit(out)} (FORMAT json)`,
						),
					EXPORT_TIMEOUT_MS,
				)
			).rowsChanged;
		}
		const headers: Record<string, string> = {
			"content-type": "application/x-ndjson",
			"content-encoding": "gzip",
			"cache-control": "no-store",
			"x-typetorch-rows": String(sent),
			"x-typetorch-pages": String(pages),
		};
		if (page >= pages - 1) headers["x-typetorch-last-page"] = "1";
		if (!existsSync(out)) {
			const empty = Readable.from([]).pipe(createGzip());
			return new Response(Readable.toWeb(empty) as ReadableStream, { status: 200, headers });
		}
		const stream = createReadStream(out).pipe(createGzip());
		const cleanup = () => rmSync(out, { force: true });
		stream.once("end", cleanup);
		stream.once("error", cleanup);
		stream.once("close", cleanup);
		return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
	}

	/** The day's live rows, sorted by every column, as a Parquet file in the export folder (reused while nothing changed). */
	private async liveSorted(w: Warehouse, table: ExportTable, day: number): Promise<{ path: string | null; rows: number }> {
		const erased = w.erasedPids().length;
		const c = this.liveCache;
		if (c && c.table === table && c.day === day && c.version === w.version && c.erased === erased && existsSync(c.path)) return { path: c.path, rows: c.rows };
		const dir = this.dir(w);
		// Older sorted copies go (best effort: Windows keeps a file a running read holds).
		for (const name of readdirSync(dir)) {
			if (!name.startsWith("live-")) continue;
			try {
				rmSync(join(dir, name), { force: true });
			} catch {}
		}
		this.liveCache = undefined;
		const version = w.version;
		const path = join(dir, `live-${table}-${day}-${Date.now()}-${++this.seq}.parquet`);
		const inDay = `t >= ${day * DAY_MS} AND t < ${(day + 1) * DAY_MS}`;
		const rows = (
			await w.read((conn) => conn.run(`COPY (SELECT ${quoted(table)} FROM live.${table} WHERE ${inDay} AND ${notErased} ORDER BY ALL) TO ${pathLit(path)} (FORMAT parquet, COMPRESSION zstd)`), EXPORT_TIMEOUT_MS)
		).rowsChanged;
		if (!rows) {
			rmSync(path, { force: true });
			return { path: null, rows: 0 };
		}
		this.liveCache = { table, day, version, erased, path, rows };
		return { path, rows };
	}

	/** GET (exclude=a,b) or POST ({ exclude: [...] }) /v1/admin/export/hash. */
	private async hash(w: Warehouse, req: Request, url: URL): Promise<Response> {
		const params = this.dayParams(url);
		if (params instanceof Response) return params;
		let exclude: unknown[] = [];
		if (req.method === "POST") {
			const body = await readCapped(req, 8 * 1024 * 1024);
			if (!body) return json(413, { error: "body over 8 MB" });
			let parsed: unknown;
			try {
				parsed = JSON.parse(Buffer.from(body).toString("utf8"));
			} catch {
				return json(400, { error: "body is not JSON" });
			}
			const list = (parsed as { exclude?: unknown } | null)?.exclude;
			if (list !== undefined && !Array.isArray(list)) return json(400, { error: "exclude is a list of pids" });
			exclude = list ?? [];
		} else {
			const text = url.searchParams.get("exclude") ?? "";
			exclude = text ? text.split(",") : [];
		}
		if (exclude.length > EXCLUDE_MAX) return json(400, { error: `exclude holds at most ${EXCLUDE_MAX} pids` });
		if (!exclude.every((p): p is string => typeof p === "string" && PID_TEXT.test(p))) return json(400, { error: "exclude holds pids (1-64 of A-Z a-z 0-9 _ -)" });
		return json(200, await dayStat(w, params.table, params.day, [...new Set(exclude as string[])]));
	}

	/** GET /v1/admin/export/fleet: a page of one SQLite table after a cursor (the integer key / rowid, or a position). */
	private async fleet(url: URL): Promise<Response> {
		const table = url.searchParams.get("table") ?? "";
		if (!(FLEET_EXPORT_TABLES as readonly string[]).includes(table)) return json(400, { error: `table is one of ${FLEET_EXPORT_TABLES.join(", ")}` });
		const t = table as FleetExportTable;
		const after = Number(url.searchParams.get("after") ?? "0");
		const size = Number(url.searchParams.get("size") ?? "1000");
		if (!Number.isSafeInteger(after) || after < 0) return json(400, { error: "after is a whole number from 0" });
		if (!Number.isSafeInteger(size) || size < 1 || size > FLEET_PAGE_MAX) return json(400, { error: `size is 1 to ${FLEET_PAGE_MAX}` });
		if (!(await this.hasTable(t))) return json(200, { rows: [], next: null });
		let rows: Record<string, unknown>[];
		let next: number | null;
		if (POSITION_PAGED.has(t)) {
			rows = await this.o.sqlite.all(`SELECT * FROM ${t} ORDER BY ${ORDER_OF[t]} LIMIT ? OFFSET ?`, [size, after]);
			next = rows.length < size ? null : after + rows.length;
		} else {
			rows = await this.o.sqlite.all(`SELECT rowid AS export_rowid__, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, size]);
			const last = rows.at(-1)?.export_rowid__;
			next = rows.length < size || last === undefined ? null : Number(last);
			for (const row of rows) delete row.export_rowid__;
		}
		if (PID_TABLES.has(t)) {
			const w = this.o.warehouse();
			if (w) rows = rows.filter((r) => typeof r.pid !== "string" || !w.isErased(r.pid));
		}
		// A BLOB never leaves (none of these tables has one; kept as a guard).
		for (const row of rows) for (const [k, v] of Object.entries(row)) if (v instanceof Uint8Array) row[k] = null;
		return json(200, { rows, next });
	}
}
