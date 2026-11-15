/**
 * The DuckDB server's data folder, shared by the server and by a local read-only store over a copy of it:
 *
 *   data/live.duckdb                    today's rows (tables events, recordings, loaded_files), small
 *   data/lock.duckdb                    empty; held (attached) by the one server that owns this folder, for its whole run
 *   data/events/YYYY-MM-DD.parquet      one file per finished day (zstd), written each night
 *   data/recordings/YYYY-MM-DD.parquet
 *   data/rollups/daily/YYYY-MM-DD.parquet, data/rollups/edges/YYYY-MM-DD.parquet, data/rollups/players.parquet
 *   data/raw/incoming/*.ndjson          accepted batches, appended before the 202 (".open" while written)
 *   data/raw/archive/YYYY-MM-DD/*.ndjson.gz   loaded raw files, kept N days (backups, re-loading)
 *   data/tmp/                           DuckDB spill folder
 *   data/settings.json                  live dials served by GET /v1/settings
 *   data/erasure/                       erasure log and queue
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EVENT_FIELDS, RECORDING_FIELDS, duckdbType, type FieldSpec } from "../schema.ts";
import { DAY_MS, lit } from "../sql/dialect.ts";

export interface DataLayout {
	root: string;
	live: string;
	/** The owner lock: the server keeps it attached while it runs (live.duckdb is detached for a moment by compaction). */
	lock: string;
	events: string;
	recordings: string;
	rollups: string;
	rawIncoming: string;
	rawArchive: string;
	tmp: string;
	settings: string;
	erasure: string;
}

export function dataLayout(root: string): DataLayout {
	return {
		root,
		live: join(root, "live.duckdb"),
		lock: join(root, "lock.duckdb"),
		events: join(root, "events"),
		recordings: join(root, "recordings"),
		rollups: join(root, "rollups"),
		rawIncoming: join(root, "raw", "incoming"),
		rawArchive: join(root, "raw", "archive"),
		tmp: join(root, "tmp"),
		settings: join(root, "settings.json"),
		erasure: join(root, "erasure"),
	};
}

/** Server-side columns on top of the contract: `rt`, when the server received the row (ms). */
export const SERVER_COLUMNS = [{ name: "rt", type: "BIGINT" }] as const;

export function fieldsOf(table: "events" | "recordings"): readonly FieldSpec[] {
	return table === "events" ? EVENT_FIELDS : RECORDING_FIELDS;
}

/** Column names stored by the server (contract fields + rt). */
export function storedColumns(table: "events" | "recordings"): string[] {
	return [...fieldsOf(table).map((f) => f.name), ...SERVER_COLUMNS.map((c) => c.name)];
}

/** A stored column's DuckDB type (contract fields and rt). */
export function storedType(kind: "events" | "recordings", column: string): string {
	const field = fieldsOf(kind).find((f) => f.name === column);
	if (field) return duckdbType(field.type);
	const server = SERVER_COLUMNS.find((c) => c.name === column);
	if (!server) throw new Error(`no stored column ${column}`);
	return server.type;
}

/** `CREATE TABLE` for a stored table. */
export function createTableSql(table: string, kind: "events" | "recordings"): string {
	const cols = [...fieldsOf(kind).map((f) => `"${f.name}" ${duckdbType(f.type)}`), ...SERVER_COLUMNS.map((c) => `"${c.name}" ${c.type}`)];
	return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(", ")})`;
}

/** The `columns={...}` struct for read_json over raw NDJSON files. */
export function readJsonColumns(kind: "events" | "recordings"): string {
	const cols = [...fieldsOf(kind).map((f) => `${f.name}: '${duckdbType(f.type)}'`), ...SERVER_COLUMNS.map((c) => `${c.name}: '${c.type}'`)];
	return `{${cols.join(", ")}}`;
}

export function dayString(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function dayNumber(date: string): number {
	return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.parquet$/;

/** The day Parquet files in a folder, oldest first: [{ day, date, path }]. */
export function dayFiles(dir: string): { day: number; date: string; path: string }[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((name) => DAY_FILE.exec(name))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => ({ day: dayNumber(m[1]), date: m[1], path: join(dir, m[0]) }))
		.sort((a, b) => a.day - b.day);
}

/** A path as a DuckDB string literal (forward slashes work on every OS). */
export function pathLit(path: string): string {
	return lit(path.replace(/\\/g, "/"));
}

/**
 * The table expression a query reads for [from, to): today's live table plus the day files that can hold rows in the
 * range (a file per UTC day; late rows of a day are merged into its file at night).
 */
export function tableExpression(layout: DataLayout, kind: "events" | "recordings", from: number, to: number, liveSchema: string | null): string {
	const cols = storedColumns(kind)
		.map((c) => `"${c}"`)
		.join(", ");
	const first = Math.floor(from / DAY_MS);
	const last = Math.floor((to - 1) / DAY_MS);
	const files = dayFiles(kind === "events" ? layout.events : layout.recordings).filter((f) => f.day >= first && f.day <= last);
	const parts: string[] = [];
	if (liveSchema) parts.push(`SELECT ${cols} FROM ${liveSchema}.${kind}`);
	if (files.length) parts.push(`SELECT ${cols} FROM read_parquet([${files.map((f) => pathLit(f.path)).join(", ")}])`);
	if (parts.length === 0) {
		const typed = [...fieldsOf(kind).map((f) => `CAST(NULL AS ${duckdbType(f.type)}) AS "${f.name}"`), ...SERVER_COLUMNS.map((c) => `CAST(NULL AS ${c.type}) AS "${c.name}"`)];
		parts.push(`SELECT ${typed.join(", ")} WHERE FALSE`);
	}
	return `(${parts.join(" UNION ALL ")})`;
}
