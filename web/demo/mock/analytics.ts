/**
 * Analytics: the backend's real named queries (src/queries) on the demo engine, ad-hoc SQL and saved queries.
 *
 *   POST /v1/query/<name>          { filters, options } -> { result, ms }    (src/server/app.ts query())
 *   GET  /v1/queries               { queries: [{ name, summary, defaultDays }] }
 *   POST /v1/sql                   { sql, limit? } -> { columns, rows, truncated, ms }   read-only, one SELECT / WITH
 *   GET|POST /v1/saved-queries, GET|PATCH|DELETE /v1/saved-queries/<id>   (src/server/saved-queries.ts), kept in the demo state
 *
 * UserIds are never mapped to pids in the demo, so the identity steps of the real route (uid, names) add nothing.
 */
import { describeQueries, isQueryName, renderQuery, runQuery } from "../../../src/queries/index.ts";
import type { QueryContext } from "../../../src/queries/core.ts";
import { duckdb } from "../../../src/sql/dialect.ts";
import { blankLiterals, checkSqlText, SQL_MAX_ROWS, SqlInputError } from "../../../src/server/sql.ts";
import { parseSavedQuery, PINNED_MAX, SAVED_QUERIES_MAX, SavedQueryError } from "../../../src/server/saved-queries.ts";
import type { QueryInfo, SavedQuery, SqlResult } from "@/lib/types";
import { now } from "./data";
import { engine, type Row } from "./engine";
import { DEMO_OWNER } from "./rng";
import { fail, HttpError, json, route, type MockRequest } from "./router";
import { nextId, slice } from "./state";

/** The context the backend's queries render against: the demo's views, the demo clock. */
export function queryContext(): QueryContext {
	return { dialect: duckdb, table: (name) => name, now: now() };
}

/** Runs a named query like the backend's warehouse.query (the result before the route's post-processing). */
export async function runNamedQuery(name: string, filters?: object, options?: object): Promise<unknown> {
	const e = await engine();
	return runQuery(queryContext(), async (statements) => {
		const out: Record<string, Row[]> = {};
		for (const [key, statement] of Object.entries(statements)) out[key] = await e.sql(statement);
		return out;
	}, name, filters as never, options);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BODY_MAX = 64 * 1024;

route<{ result: unknown; ms: number }>("POST", "/v1/query/:name", async (req) => {
	const name = req.params.name as string;
	if (!isQueryName(name)) return fail(404, `unknown query ${JSON.stringify(name)}`);
	if (req.text.length > BODY_MAX) return fail(413, "body too large");
	if (req.text && req.body === undefined) return fail(400, "body is not JSON");
	const body = (isRecord(req.body) ? req.body : {}) as { filters?: object; options?: object };
	const options: Record<string, unknown> = { ...(isRecord(body.options) ? body.options : {}) };
	// The real route turns a UserId into a pid through the identity table; the demo maps none.
	if ((name === "timeline" || name === "player-graph" || name === "player-stats" || name === "events" || name === "feedback-list") && options.pid === undefined && options.uid !== undefined) {
		const uid = String(options.uid);
		if (!/^\d{1,16}$/.test(uid)) return fail(400, "uid must be a UserId (digits)");
		return fail(404, `no pid known for UserId ${uid}`);
	}
	delete options.uid;
	try {
		renderQuery(queryContext(), name, body.filters as never, options);
	} catch (error) {
		return fail(400, (error as Error).message);
	}
	const started = performance.now();
	try {
		let result = await runNamedQuery(name, body.filters, options);
		const asJson = result as { toJSON?: () => unknown };
		if (typeof asJson?.toJSON === "function") result = asJson.toJSON();
		if (name === "churn") {
			// Owners see each player's notification opt-in; without a UserId it is unknown (null).
			const found = result as { list: Record<string, unknown>[] };
			result = { ...found, list: found.list.map((p) => ({ ...p, optin: null })) };
		}
		return { result, ms: Math.round(performance.now() - started) };
	} catch (error) {
		const message = (error as Error).message ?? String(error);
		console.warn(`[demo] query ${name} failed: ${message}`);
		return fail(500, "query failed", { detail: message.slice(0, 300) });
	}
});

route<{ queries: QueryInfo[] }>("GET", "/v1/queries", () => ({ queries: describeQueries() }));

// Ad-hoc SQL ------------------------------------------------------------------------------------------------------------

/** A value as JSON the way the backend's sandbox answers it (src/server/sql.ts jsonValue). */
function jsonValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (value instanceof Uint8Array) {
		let bin = "";
		for (const b of value) bin += String.fromCharCode(b);
		return btoa(bin);
	}
	if (Array.isArray(value)) return value.map(jsonValue);
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, jsonValue(x)]));
	return String(value);
}

/** Names the demo keeps for itself, and table functions that would read files (the backend allows only a few). */
const DEMO_INTERNAL = /\b_tt_\w*/i;
const TABLE_FUNCTION = /\b(read_\w+|glob|query_table|query|parquet_\w+|sniff_csv|duckdb_\w+|pragma_\w+|sqlite_\w+|iceberg_\w+|delta_scan)\s*\(/i;

export async function runSql(input: unknown, limit = 1000): Promise<SqlResult> {
	const sql = checkSqlText(input);
	const bare = blankLiterals(sql);
	if (DEMO_INTERNAL.test(bare)) throw new SqlInputError(`unknown table ${JSON.stringify(DEMO_INTERNAL.exec(bare)?.[0])}: query events, recordings or your own CTEs`);
	const fn = TABLE_FUNCTION.exec(bare)?.[1];
	if (fn) throw new SqlInputError(`table function ${fn}() is not allowed (allowed: range, generate_series, unnest, json_each, json_tree)`);
	const cap = Math.min(SQL_MAX_ROWS, Math.max(1, Math.floor(Number(limit) || 1000)));
	const e = await engine();
	const started = performance.now();
	const described = await e.sql(`DESCRIBE ${sql}`);
	const columns = described.map((d) => ({ name: String(d.column_name), type: String(d.column_type) }));
	const rows = await e.sql(`SELECT * FROM (${sql}) AS demo_query LIMIT ${cap + 1}`);
	return {
		columns,
		rows: rows.slice(0, cap).map((row) => {
			const values = Object.values(row);
			return columns.map((_, i) => jsonValue(values[i]));
		}),
		truncated: rows.length > cap,
		ms: Math.round(performance.now() - started),
	};
}

route<SqlResult>("POST", "/v1/sql", async (req) => {
	if (req.text.length > BODY_MAX) return fail(413, "body too large");
	if (req.text && req.body === undefined) return fail(400, "body is not JSON");
	const body = (isRecord(req.body) ? req.body : {}) as { sql?: unknown; limit?: unknown };
	try {
		return await runSql(body.sql, typeof body.limit === "number" ? body.limit : undefined);
	} catch (error) {
		const message = ((error as Error).message ?? String(error)).slice(0, 500);
		return fail(400, error instanceof SqlInputError ? message : `query failed: ${message}`);
	}
});

// Saved queries ---------------------------------------------------------------------------------------------------------

const SEEDED_AT = "2026-11-01T09:00:00.000Z";
const seed = (id: number, name: string, sql: string, chart: SavedQuery["chart"], pinned: boolean): SavedQuery => ({
	id,
	name,
	sql,
	chart,
	pinned,
	createdBy: DEMO_OWNER.name,
	createdAt: SEEDED_AT,
	updatedBy: DEMO_OWNER.name,
	updatedAt: SEEDED_AT,
});

export const savedQueries = slice<SavedQuery[]>("analytics.savedQueries", () => [
	seed(
		1,
		"Escapes and arrests per day",
		"SELECT CAST(epoch_ms(t) AS DATE) AS day,\n  COUNT(*) FILTER (WHERE name = 'escape') AS escapes,\n  COUNT(*) FILTER (WHERE name = 'arrest') AS arrests\nFROM events\nWHERE kind = 'custom' AND name IN ('escape', 'arrest')\nGROUP BY day\nORDER BY day",
		"line",
		true,
	),
	seed(
		2,
		"Top shop items",
		"SELECT json_extract_string(props, '$.item') AS item,\n  COUNT(*) AS buys,\n  SUM(TRY_CAST(json_extract_string(props, '$.price') AS INTEGER)) AS cash_spent\nFROM events\nWHERE kind = 'custom' AND name = 'shop_buy'\nGROUP BY item\nORDER BY buys DESC\nLIMIT 15",
		"bar",
		true,
	),
	seed(
		3,
		"Quests completed by type",
		"SELECT json_extract_string(props, '$.type') AS quest_type,\n  COUNT(*) AS completed,\n  COUNT(DISTINCT pid) AS players\nFROM events\nWHERE kind = 'custom' AND name = 'quest_complete'\nGROUP BY quest_type\nORDER BY completed DESC",
		"bar",
		false,
	),
	seed(
		4,
		"Team picks (last 7 days)",
		"SELECT lower(json_extract_string(props, '$.team')) AS team, COUNT(*) AS picks, COUNT(DISTINCT pid) AS players\nFROM events\nWHERE kind = 'custom' AND name = 'team_chosen'\n  AND t >= epoch_ms(current_date - INTERVAL 7 DAY)\nGROUP BY team\nORDER BY picks DESC",
		"table",
		false,
	),
]);

function byName(a: SavedQuery, b: SavedQuery): number {
	return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id;
}

function savedError(error: unknown): Response {
	if (error instanceof SavedQueryError) return fail(error.status, error.message);
	throw error;
}

function idOf(text: string): number | undefined {
	return /^[1-9]\d{0,9}$/.test(text) ? Number(text) : undefined;
}

function bodyOf(req: MockRequest): unknown {
	if (req.text.length > 64 * 1024) throw new HttpError(413, "body too large");
	if (!req.text) return null;
	if (req.body === undefined) throw new HttpError(400, "body is not JSON");
	return req.body;
}

function checkName(list: SavedQuery[], name: string, except?: number): void {
	if (list.some((q) => q.id !== except && q.name.toLowerCase() === name.toLowerCase())) throw new SavedQueryError(409, "a saved query with that name exists");
}

route<{ queries: SavedQuery[] }>("GET", "/v1/saved-queries", () => ({ queries: [...savedQueries.get()].sort(byName) }));

route<{ query: SavedQuery }>("POST", "/v1/saved-queries", (req) => {
	try {
		const input = parseSavedQuery(bodyOf(req), true);
		const list = savedQueries.get();
		if (list.length >= SAVED_QUERIES_MAX) throw new SavedQueryError(409, `at most ${SAVED_QUERIES_MAX} saved queries: delete one first`);
		if (input.pinned && list.filter((q) => q.pinned).length >= PINNED_MAX) throw new SavedQueryError(409, `at most ${PINNED_MAX} queries pinned to the Overview: unpin one first`);
		checkName(list, input.name as string);
		const at = new Date(now()).toISOString();
		const query: SavedQuery = {
			id: nextId("savedQuery", 5),
			name: input.name as string,
			sql: input.sql as string,
			chart: input.chart ?? null,
			pinned: input.pinned ?? false,
			createdBy: DEMO_OWNER.name,
			createdAt: at,
			updatedBy: DEMO_OWNER.name,
			updatedAt: at,
		};
		savedQueries.update((all) => void all.push(query));
		return json(201, { query });
	} catch (error) {
		return savedError(error);
	}
});

route<{ query: SavedQuery }>("GET", "/v1/saved-queries/:id", (req) => {
	const id = idOf(req.params.id as string);
	const found = id === undefined ? undefined : savedQueries.get().find((q) => q.id === id);
	return found ? { query: found } : fail(404, "no such saved query");
});

route<{ query: SavedQuery }>("PATCH", "/v1/saved-queries/:id", (req) => {
	const id = idOf(req.params.id as string);
	const list = savedQueries.get();
	const found = id === undefined ? undefined : list.find((q) => q.id === id);
	if (!found) return fail(404, "no such saved query");
	try {
		const patch = parseSavedQuery(bodyOf(req), false);
		if (patch.pinned && !found.pinned && list.filter((q) => q.pinned && q.id !== found.id).length >= PINNED_MAX)
			throw new SavedQueryError(409, `at most ${PINNED_MAX} queries pinned to the Overview: unpin one first`);
		if (patch.name !== undefined) checkName(list, patch.name, found.id);
		const next: SavedQuery = { ...found, ...patch, chart: patch.chart !== undefined ? patch.chart : found.chart, updatedBy: DEMO_OWNER.name, updatedAt: new Date(now()).toISOString() };
		savedQueries.update((all) => all.map((q) => (q.id === found.id ? next : q)));
		return { query: next };
	} catch (error) {
		return savedError(error);
	}
});

route<{ ok: boolean }>("DELETE", "/v1/saved-queries/:id", (req) => {
	const id = idOf(req.params.id as string);
	const list = savedQueries.get();
	if (id === undefined || !list.some((q) => q.id === id)) return fail(404, "no such saved query");
	savedQueries.set(list.filter((q) => q.id !== id));
	return { ok: true };
});
