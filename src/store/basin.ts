/**
 * Basin store: the logical queries as Basin SQL, sent to Cloudflare's SQL API.
 *
 *   POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{account_id}/basin-sql/query/{bucket}
 *   Authorization: Bearer <token>   (Basin SQL read + Basin Catalog read + R2 storage; e.g. the R2 Admin token)
 *   { "query": "SELECT ..." }
 *
 * Documented at developers.cloudflare.com/basin-sql/query-data (2026-10-05). The response body isn't documented in
 * detail; this parser accepts `result.rows` as objects, or as arrays next to `result.schema`/`result.columns` names.
 * NOT verified against a live account yet (needs the user's Cloudflare account): check `parseBasinRows` first if
 * results come back empty.
 */
import type { Row, TableName } from "../queries/core.ts";
import { basin } from "../sql/dialect.ts";
import { BASIN_DEFAULTS } from "../basin/schema.ts";
import { SqlStore } from "./sql-store.ts";

export const BASIN_SQL_API = "https://api.sql.cloudflarestorage.com";

export interface BasinStoreConfig {
	accountId: string;
	/** The R2 bucket that holds the Basin Catalog (the SQL API path takes the bucket name). */
	bucket: string;
	/** API token with Basin SQL read, Basin Catalog read and R2 storage permissions. Never logged. */
	token: string;
	namespace?: string;
	eventsTable?: string;
	recordingsTable?: string;
	/** Base URL override (tests). */
	endpoint?: string;
	fetch?: typeof fetch;
	/** Statements of one query run in parallel (default 4). */
	concurrency?: number;
	timeoutMs?: number;
	clock?: () => number;
}

export class BasinSqlError extends Error {
	override name = "BasinSqlError";
	constructor(
		message: string,
		readonly status: number,
		readonly codes: number[],
	) {
		super(message);
	}
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A Cloudflare account id and an R2 bucket name, as the SQL API path takes them. */
export const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
export const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** A Basin namespace or table name. */
export const BASIN_IDENT = IDENT;

/** The SQL API's query URL for an account and bucket. */
export function basinQueryUrl(accountId: string, bucket: string, endpoint = BASIN_SQL_API): string {
	return `${endpoint}/api/v1/accounts/${accountId}/basin-sql/query/${bucket}`;
}

function ident(value: string, what: string): string {
	if (!IDENT.test(value)) throw new Error(`${what} must be a plain identifier (letters, digits, _)`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rows from a Basin SQL API response body (see the module note). */
export function parseBasinRows(body: unknown): Row[] {
	const result = isRecord(body) && isRecord(body.result) ? body.result : body;
	if (!isRecord(result)) return [];
	const rows = result.rows ?? result.data;
	if (!Array.isArray(rows)) return [];
	if (rows.every(isRecord)) return rows as Row[];
	const schema = (result.schema ?? result.columns ?? result.meta) as unknown;
	const names = Array.isArray(schema) ? schema.map((c) => (isRecord(c) ? String(c.name ?? c.column_name ?? "") : String(c))) : [];
	return rows.map((r) => {
		const row: Row = {};
		if (Array.isArray(r)) r.forEach((value, i) => (row[names[i] ?? `c${i}`] = value));
		return row;
	});
}

/** The error message and codes of a failed Basin SQL API answer. */
export function basinErrorOf(body: unknown, text: string): { message: string; codes: number[] } {
	const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
	const parts = errors.map((e) => (isRecord(e) ? `${e.code ?? ""} ${e.message ?? ""}`.trim() : String(e))).filter(Boolean);
	const codes = errors.map((e) => (isRecord(e) ? Number(e.code) : Number.NaN)).filter(Number.isFinite);
	return { message: parts.join("; ") || text.slice(0, 500), codes };
}

export class BasinStore extends SqlStore {
	readonly backend = "basin" as const;
	readonly dialect = basin;
	private readonly tables: Record<TableName, string>;
	private readonly url: string;

	constructor(private readonly config: BasinStoreConfig) {
		super(config.clock);
		if (!ACCOUNT_ID.test(config.accountId)) throw new Error("accountId must be a Cloudflare account id (32 hex characters)");
		if (!BUCKET_NAME.test(config.bucket)) throw new Error("bucket must be an R2 bucket name");
		if (!config.token) throw new Error("a Basin SQL API token is required");
		const ns = ident(config.namespace ?? BASIN_DEFAULTS.namespace, "namespace");
		this.tables = {
			events: `${ns}.${ident(config.eventsTable ?? BASIN_DEFAULTS.eventsTable, "eventsTable")}`,
			recordings: `${ns}.${ident(config.recordingsTable ?? BASIN_DEFAULTS.recordingsTable, "recordingsTable")}`,
		};
		this.url = basinQueryUrl(config.accountId, config.bucket, config.endpoint);
		this.concurrency = config.concurrency ?? 4;
	}

	protected table(name: TableName): string {
		return this.tables[name];
	}

	async sql(statement: string): Promise<Row[]> {
		const doFetch = this.config.fetch ?? fetch;
		let lastError: unknown;
		for (let attempt = 1; attempt <= 3; attempt++) {
			let response: Response;
			try {
				response = await doFetch(this.url, {
					method: "POST",
					headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
					body: JSON.stringify({ query: statement }),
					signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
				});
			} catch (error) {
				lastError = error;
				continue;
			}
			const text = await response.text();
			let body: unknown;
			try {
				body = text ? JSON.parse(text) : undefined;
			} catch {
				body = undefined;
			}
			const failed = !response.ok || (isRecord(body) && body.success === false);
			if (!failed) return parseBasinRows(body);
			const { message, codes } = basinErrorOf(body, text);
			// 80001: edge connection failure (retry); 502/503/429 likewise.
			if ((codes.includes(80001) || [429, 502, 503, 504].includes(response.status)) && attempt < 3) {
				lastError = new BasinSqlError(message, response.status, codes);
				await new Promise((done) => setTimeout(done, 500 * attempt));
				continue;
			}
			throw new BasinSqlError(`Basin SQL ${response.status}: ${message}`, response.status, codes);
		}
		throw lastError instanceof Error ? lastError : new Error(`Basin SQL request failed: ${String(lastError)}`);
	}

	async close(): Promise<void> {}
}
