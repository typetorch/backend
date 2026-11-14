/**
 * The two SQL dialects the logical queries render to. The queries are written in the subset both engines share
 * (CTEs, joins, window functions, CASE, COUNT(DISTINCT), split_part, integer ms timestamps); only the few things
 * that differ go through a Dialect:
 *   - reading a key from a JSON string column (DuckDB's json extension vs Basin's json_get_* functions);
 *   - the row limit (Basin applies LIMIT 500 when none is given and refuses more than 10,000);
 *   - percentiles (DuckDB's exact quantile_cont; Basin's approx_percentile_cont, a t-digest estimate).
 * Times stay int64 unix ms on both sides; days are `floor(t / 86400000)` (UTC), so no date function is needed.
 */

export type DialectName = "duckdb" | "basin";

export interface Dialect {
	readonly name: DialectName;
	/** The largest LIMIT the engine accepts (Infinity when unbounded). */
	readonly maxRows: number;
	/** A key of a JSON-object string column as text (NULL when missing). */
	jsonText(column: string, key: string): string;
	/** A key of a JSON-object string column as DOUBLE (NULL when missing or not a number). */
	jsonNumber(column: string, key: string): string;
	/** A key of a JSON-object string column as BOOLEAN (NULL when missing or not a JSON boolean). */
	jsonBool(column: string, key: string): string;
	/** The LIMIT clause that ends a statement: `rows` capped at maxRows. */
	limit(rows: number): string;
	/** The `p` (0-1) percentile of a numeric expression over a group, NULLs ignored (an aggregate). */
	percentile(expr: string, p: number): string;
}

/** A percentile as a SQL literal: 0 < p < 1, at most 4 decimals. */
function fraction(p: number): string {
	if (!(p > 0 && p < 1) || Math.round(p * 10_000) !== p * 10_000) throw new Error(`a percentile must be between 0 and 1 with at most 4 decimals, got ${p}`);
	return String(p);
}

/** Keys and names that go inside a JSON path or a SQL string: letters, digits, `_`, `-`, `.`, at most 64. */
export const SAFE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertSafeKey(key: string, what = "key"): string {
	if (!SAFE_KEY.test(key)) throw new Error(`${what} must be 1-64 characters of letters, digits, "_", "-" or "." (got ${JSON.stringify(key)})`);
	return key;
}

/** A SQL string literal (standard quoting: ' doubled; backslashes are plain in both engines). */
export function lit(value: string): string {
	if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("control characters are not allowed in SQL literals");
	return `'${value.replace(/'/g, "''")}'`;
}

/** An integer literal (refuses anything that isn't a safe integer). */
export function int(value: number): string {
	if (!Number.isSafeInteger(value)) throw new Error(`expected an integer, got ${value}`);
	return String(value);
}

export const duckdb: Dialect = {
	name: "duckdb",
	maxRows: Number.POSITIVE_INFINITY,
	jsonText(column, key) {
		return `json_extract_string(${column}, ${lit(`$."${assertSafeKey(key)}"`)})`;
	},
	jsonNumber(column, key) {
		return `TRY_CAST(json_extract_string(${column}, ${lit(`$."${assertSafeKey(key)}"`)}) AS DOUBLE)`;
	},
	jsonBool(column, key) {
		// json_extract_string gives a JSON boolean as 'true' / 'false'.
		const v = `json_extract_string(${column}, ${lit(`$."${assertSafeKey(key)}"`)})`;
		return `(CASE ${v} WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE END)`;
	},
	limit(rows) {
		return `LIMIT ${int(Math.max(1, Math.floor(rows)))}`;
	},
	percentile(expr, p) {
		return `quantile_cont(${expr}, ${fraction(p)})`;
	},
};

/** Basin SQL (developers.cloudflare.com/basin-sql/sql-reference). */
export const basin: Dialect = {
	name: "basin",
	maxRows: 10_000,
	jsonText(column, key) {
		return `json_get_str(${column}, ${lit(assertSafeKey(key))})`;
	},
	jsonNumber(column, key) {
		// json_get_float may skip integer JSON numbers; fall back to json_get_int.
		const k = lit(assertSafeKey(key));
		return `COALESCE(json_get_float(${column}, ${k}), CAST(json_get_int(${column}, ${k}) AS DOUBLE))`;
	},
	jsonBool(column, key) {
		// json_get_str gives NULL for a JSON boolean (it reads strings only). Not checked on a live account.
		return `json_get_bool(${column}, ${lit(assertSafeKey(key))})`;
	},
	limit(rows) {
		return `LIMIT ${int(Math.min(10_000, Math.max(1, Math.floor(rows))))}`;
	},
	percentile(expr, p) {
		// DataFusion's estimate (t-digest): close to exact on the small groups these queries make. Not checked on a live account.
		return `approx_percentile_cont(${expr}, ${fraction(p)})`;
	},
};

export const DIALECTS: Record<DialectName, Dialect> = { duckdb, basin };

/** The UTC day number of an int64 ms column (days since 1970-01-01). */
export function dayOf(column: string): string {
	return `CAST(floor(${column} / 86400000.0) AS BIGINT)`;
}

export const DAY_MS = 86_400_000;
