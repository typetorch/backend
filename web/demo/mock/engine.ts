/**
 * The analytics engine behind /v1/query, /v1/sql and the pack helpers: DuckDB over the pack's two tables.
 *
 * In the browser it is DuckDB-WASM (engine-wasm.ts, loaded on the first analytics call; the bundle comes from jsDelivr).
 * Tests set a Node engine (demo/test/node-engine.ts) with setEngine(). Both run the same setup (setupStatements):
 *
 *   _tt_events, _tt_recordings   the pack's CSV with `t` (and `rt`) moved by whole days so the last day is today (UTC)
 *   events, recordings           views over them without the rows after "now" (the clock table, refreshed per statement)
 *                                plus synthetic rows the pack lacks: feedback answers (feedbackStatement) and the
 *                                notification rows (syntheticSetup -> notify-rows.ts)
 *   tt_json_extract_string(j, p) a SQL macro for DuckDB's json_extract_string (the JSON extension would be downloaded
 *                                from extensions.duckdb.org); rewriteSql() points every call at it
 *
 * Rows come back as plain JS (BIGINT and DECIMAL as numbers, lists as arrays, structs as objects), like the backend's
 * readRows.
 */
import { EVENT_FIELDS, RECORDING_FIELDS, duckdbType } from "../../../src/schema.ts";
import { loadSpan, manifest, now, shiftFor, type Manifest } from "./data";

export type Row = Record<string, unknown>;

export interface DemoEngine {
	/** Runs one SQL statement (DuckDB dialect) over the demo tables. */
	sql(statement: string): Promise<Row[]>;
}

// Status (the banner shows it while DuckDB loads) ------------------------------------------------------------------------

export type EngineState = { state: "idle" } | { state: "loading"; step: string } | { state: "ready"; ms: number } | { state: "failed"; error: string };

let status: EngineState = { state: "idle" };
const watchers = new Set<(s: EngineState) => void>();

export function engineStatus(): EngineState {
	return status;
}

export function onEngineStatus(fn: (s: EngineState) => void): () => void {
	watchers.add(fn);
	return () => watchers.delete(fn);
}

export function reportStatus(next: EngineState): void {
	status = next;
	for (const w of watchers) w(next);
}

// The engine in use -----------------------------------------------------------------------------------------------------

let current: Promise<DemoEngine> | undefined;

/** The engine (the first call loads DuckDB-WASM and the pack in the browser). */
export function engine(): Promise<DemoEngine> {
	if (!current) {
		const started = performance.now();
		reportStatus({ state: "loading", step: "Loading the analytics engine" });
		current = import("./engine-wasm")
			.then((m) => m.createWasmEngine((step) => reportStatus({ state: "loading", step })))
			.then((e) => {
				reportStatus({ state: "ready", ms: Math.round(performance.now() - started) });
				return e;
			})
			.catch((error: unknown) => {
				current = undefined;
				reportStatus({ state: "failed", error: error instanceof Error ? error.message : String(error) });
				throw error;
			});
	}
	return current;
}

/** Tests (or a custom build) put their own engine in. */
export function setEngine(e: DemoEngine | null): void {
	current = e ? Promise.resolve(e) : undefined;
	if (e) reportStatus({ state: "ready", ms: 0 });
}

/** Runs one statement on the engine. */
export async function sql(statement: string): Promise<Row[]> {
	return (await engine()).sql(statement);
}

// Shared setup ----------------------------------------------------------------------------------------------------------

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

const EVENT_COLUMNS: [string, string][] = [...EVENT_FIELDS.map((f): [string, string] => [f.name, duckdbType(f.type)]), ["rt", "BIGINT"]];
const RECORDING_COLUMNS: [string, string][] = RECORDING_FIELDS.map((f): [string, string] => [f.name, duckdbType(f.type)]);

/** The registered file names the setup reads (the engine registers /data/<file> under the same name). */
export function tableFiles(m: Manifest): { events: string; recordings: string } {
	return { events: m.tables.events.file, recordings: m.tables.recordings.file };
}

/**
 * The statements that build the demo tables from the registered CSV files. `shift` moves the pack's days onto today; the
 * clock table holds "now" (clockStatement keeps it current). `compression`: "none" for a file the server sent with
 * Content-Encoding: gzip (the browser unpacked it).
 */
export function setupStatements(m: Manifest, shift: number, at: number, compression: Partial<Record<"events" | "recordings", "gzip" | "none">> = {}): string[] {
	const read = (file: string, columns: [string, string][], table: "events" | "recordings") =>
		`read_csv(${quote(file)}, header = true, compression = '${compression[table] ?? "gzip"}', nullstr = ${quote(m.csv.nullstr)}, auto_detect = false, quote = '"', escape = '"', ` +
		`columns = {${columns.map(([n, t]) => `${quote(n)}: ${quote(t)}`).join(", ")}})`;
	const files = tableFiles(m);
	const shifted = (columns: [string, string][], shiftCols: string[]) =>
		columns.map(([n]) => (shiftCols.includes(n) ? `"${n}" + ${shift} AS "${n}"` : `"${n}"`)).join(", ");
	return [
		`CREATE OR REPLACE TABLE _tt_clock AS SELECT CAST(${Math.floor(at)} AS BIGINT) AS now_ms`,
		`CREATE OR REPLACE TABLE _tt_events AS SELECT ${shifted(EVENT_COLUMNS, ["t", "rt"])} FROM ${read(files.events, EVENT_COLUMNS, "events")}`,
		feedbackStatement(),
		`CREATE OR REPLACE TABLE _tt_recordings AS SELECT ${shifted(RECORDING_COLUMNS, ["t"])} FROM ${read(files.recordings, RECORDING_COLUMNS, "recordings")}`,
		`CREATE OR REPLACE VIEW events AS SELECT * FROM _tt_events WHERE t <= (SELECT now_ms FROM _tt_clock)`,
		`CREATE OR REPLACE VIEW recordings AS SELECT * FROM _tt_recordings WHERE t <= (SELECT now_ms FROM _tt_clock)`,
		...JSON_MACROS,
	];
}

/**
 * The setup that needs more than SQL: the synthetic notification rows (notify-rows.ts: the notify world's sends, opens,
 * skips and the opt-in prompt, placed in the pack players' real sessions). Every engine runs it right after
 * setupStatements, with `run` executing one statement on the connection being set up.
 */
export async function syntheticSetup(run: (statement: string) => Promise<Row[]>): Promise<void> {
	const { addNotifyRows } = await import("./notify-rows");
	await addNotifyRows(run);
}

/** What players write with a rating (1..5) in the demo's synthetic feedback: The Prison's words, no quotes or backslashes. */
const FEEDBACK_TEXTS: Record<number, string[]> = {
	1: ["Lost all my cash after a rejoin", "Got kicked right in the middle of an escape", "Tutorial is confusing, could not find the yard", "Guards spawn camp the cell block"],
	2: ["Guards are way too strong", "Lag spikes in the cafeteria every few minutes", "Got arrested right after spawning", "Lockpicks break too fast"],
	3: ["Its ok but escapes take too long", "Need more ways to earn cash as an inmate", "The guard team is always empty", "Fun with friends, boring alone"],
	4: ["Fun, add more cell blocks", "Nice update, shop prices feel fair now", "The new quests are good, more please", "Medic role is underrated"],
	5: ["Love the sewer escape route", "Best prison game, inmates vs guards is so fun", "Breaking out with friends never gets old", "The warden lockdown event was amazing"],
};

/**
 * The pack has feedback prompts (custom/feedback_prompted) but no answers, so the Feedback page would be empty: about 60%
 * of the prompts get a `feedback/submit` row 20-60 s later (a 5-star scale, half with text), the same player, session and
 * server, deterministic (hash of the prompt). Synthetic, like the notification world.
 */
function feedbackStatement(): string {
	const h = (salt: string, at = "p") => `hash(${at}.sid || CAST(${at}.t AS VARCHAR) || '${salt}')`;
	// 1..5, weighted 12 / 10 / 15 / 28 / 35 %.
	const r = `(CASE WHEN ${h("r")} % 100 < 12 THEN 1 WHEN ${h("r")} % 100 < 22 THEN 2 WHEN ${h("r")} % 100 < 37 THEN 3 WHEN ${h("r")} % 100 < 65 THEN 4 ELSE 5 END)`;
	const texts = (rating: number) => `[${(FEEDBACK_TEXTS[rating] ?? []).map(quote).join(", ")}]`;
	const text = `CASE WHEN ${h("x", "q")} % 2 = 0 THEN '' ELSE list_extract(CASE q.r ${[1, 2, 3, 4, 5].map((n) => `WHEN ${n} THEN ${texts(n)}`).join(" ")} END, CAST(${h("i", "q")} % 4 AS BIGINT) + 1) END`;
	const offset = `CAST(20000 + ${h("o")} % 40000 AS BIGINT)`;
	const props =
		`'{"scale":"after_session","type":"stars","steps":5,"r":' || CAST(r AS VARCHAR) || ',"norm":' || CAST((r - 1) / 4.0 AS VARCHAR) || ` +
		`CASE WHEN text = '' THEN '' ELSE ',"text":"' || text || '","len":' || CAST(length(text) AS VARCHAR) END || ',"topic":"session_end"}'`;
	const override: Record<string, string> = { t: "t + off", rt: "CASE WHEN rt IS NULL THEN NULL ELSE rt + off END", kind: "'feedback'", name: "'submit'", props };
	const columns = EVENT_COLUMNS.map(([n]) => n);
	return (
		`INSERT INTO _tt_events (${columns.map((n) => `"${n}"`).join(", ")}) ` +
		`SELECT ${columns.map((n) => (override[n] ? `${override[n]} AS "${n}"` : `"${n}"`)).join(", ")} FROM (` +
		`SELECT q.*, ${text} AS text FROM (SELECT p.*, ${r} AS r, ${offset} AS off FROM _tt_events p ` +
		`WHERE p.kind = 'custom' AND p.name = 'feedback_prompted' AND p.sid IS NOT NULL AND ${h("keep")} % 100 < 60) q)`
	);
}

/**
 * json_extract_string(json, '$."key"') for flat JSON objects, in plain SQL: the value of the first `"key":` (a string,
 * unescaped, or a number / true / false as text), NULL when missing, null, or an object / array. The pack's props are flat
 * objects; the backend's queries only read top-level keys.
 */
export const JSON_MACROS = [
	`CREATE OR REPLACE MACRO _tt_json_key(p) AS coalesce(nullif(regexp_extract(p, '^\\$\\."(.*)"$', 1), ''), nullif(regexp_extract(p, '^\\$\\.([A-Za-z0-9_]+)$', 1), ''))`,
	`CREATE OR REPLACE MACRO _tt_json_raw(j, p) AS nullif(regexp_extract(j, '[{,]\\s*"' || regexp_replace(_tt_json_key(p), '([.\\-+*?()\\[\\]{}|^$\\\\])', '\\\\\\1', 'g') || '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[^,{}\\[\\]\\s]+)', 1), '')`,
	// Escapes: `\\` is parked as chr(1) first, so `\\n` stays a backslash and an n.
	`CREATE OR REPLACE MACRO _tt_json_unquote(v) AS CASE WHEN v IS NULL OR v = 'null' THEN NULL WHEN v[1] = '"' THEN ` +
		`replace(replace(replace(replace(replace(replace(replace(v[2:-2], '\\\\', chr(1)), '\\"', '"'), '\\/', '/'), '\\n', chr(10)), '\\t', chr(9)), '\\r', chr(13)), chr(1), '\\') ELSE v END`,
	`CREATE OR REPLACE MACRO tt_json_extract_string(j, p) AS _tt_json_unquote(_tt_json_raw(j, p))`,
];

/**
 * The backend's own calls (dialect jsonText / jsonNumber): a column and a constant `$."key"` (assertSafeKey: letters,
 * digits, `_`, `-`, `.`). The regex costs about 1 µs a row, and some queries read the same key several times over every
 * row (the experiment query reads `exp` once per CTE that uses it: tens of seconds on native DuckDB, minutes in WASM).
 * So: a plain substring test first (most rows don't have most keys), and a string value of a row without backslashes
 * (nothing to unescape, and no `"key":"` can hide inside a string) cut out with split_part; anything else goes through
 * the macro's regex. Same answers as the macro.
 */
const CONSTANT_JSON_CALL = /\bjson_extract_string\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*,\s*'\$\."([A-Za-z0-9_.-]{1,64})"'\s*\)/gi;

/** The macro's pattern (_tt_json_raw) for one key. */
function jsonKeyPattern(key: string): string {
	return `[{,]\\s*"${key.replace(/[.\-]/g, (c) => `\\${c}`)}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[^,{}\\[\\]\\s]+)`;
}

/** Points the JSON calls of a statement at the demo's macro (DuckDB-WASM has no JSON extension here). */
export function rewriteSql(statement: string): string {
	return statement
		.replace(CONSTANT_JSON_CALL, (_, column: string, key: string) => {
			const k = (tail: string) => quote(`"${key}"${tail}`);
			return (
				`(CASE WHEN ${column} IS NULL OR NOT contains(${column}, ${k("")}) THEN NULL ` +
				`WHEN NOT contains(${column}, '\\') AND strpos(${column}, ${k(':"')}) > 0 AND strpos(${column}, ${k(':"')}) = strpos(${column}, ${k(":")}) ` +
				`THEN split_part(split_part(${column}, ${k(':"')}, 2), '"', 1) ` +
				`ELSE _tt_json_unquote(nullif(regexp_extract(${column}, ${quote(jsonKeyPattern(key))}, 1), '')) END)`
			);
		})
		.replace(/\bjson_extract_string\s*\(/gi, "tt_json_extract_string(");
}

/** "now" for the views: updated when the clock moved since the last statement (cheap: one row). */
export function clockStatement(at: number): string {
	return `UPDATE _tt_clock SET now_ms = ${Math.floor(at)}`;
}

/** Loads the manifest and works out the shift for the current clock. */
export async function prepare(): Promise<{ manifest: Manifest; shift: number; at: number }> {
	const m = await manifest();
	await loadSpan();
	const at = now();
	return { manifest: m, shift: shiftFor(m.lastT, at), at };
}

// Values ----------------------------------------------------------------------------------------------------------------

/** A DuckDB-WASM (Arrow) value as plain JS: bigint -> number, Arrow vectors -> arrays, struct rows -> objects. */
export function plainValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") return Number(value);
	if (typeof value !== "object") return value;
	if (value instanceof Date) return value.getTime();
	if (Array.isArray(value)) return value.map(plainValue);
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number | bigint>, plainValue);
	const v = value as { toArray?: () => unknown; toJSON?: () => unknown; get?: unknown; length?: unknown; [Symbol.iterator]?: unknown };
	// An Arrow Vector (LIST): iterable with get/length.
	if (typeof v.toArray === "function" && typeof v.get === "function" && typeof v.length === "number") return Array.from(v as unknown as Iterable<unknown>, plainValue);
	if (typeof v.toJSON === "function") {
		const j = v.toJSON();
		if (j !== value) return plainValue(j);
	}
	const out: Row = {};
	for (const [k, x] of Object.entries(value as Row)) out[k] = plainValue(x);
	return out;
}
