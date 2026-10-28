/**
 * A Basin store over a DuckDB connection, as in basin.test.ts: `typetorch.*` views, json_get_* as macros and a fake SQL
 * API, so a query's Basin-dialect SQL can be checked against its DuckDB result on hand-made rows.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { BasinStore } from "../src/store/basin.ts";
import { readRows } from "../src/store/duckdb.ts";

export async function basinOver(connection: DuckDBConnection, now: number): Promise<BasinStore> {
	await connection.run("CREATE SCHEMA typetorch");
	await connection.run("CREATE VIEW typetorch.events AS SELECT * FROM main.events");
	await connection.run("CREATE VIEW typetorch.recordings AS SELECT * FROM main.recordings");
	// Basin's json_get_str skips numbers (the reason queries read numeric ids through json_get_int too).
	await connection.run(`CREATE MACRO json_get_str(j, k) AS CASE WHEN json_type(j, '$."' || k || '"') = 'VARCHAR' THEN json_extract_string(j, '$."' || k || '"') END`);
	await connection.run(`CREATE MACRO json_get_float(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS DOUBLE)`);
	await connection.run(`CREATE MACRO json_get_int(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS BIGINT)`);
	await connection.run("CREATE MACRO approx_percentile_cont(x, p) AS quantile_cont(x, p)");
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		const query = JSON.parse(String(init?.body)).query as string;
		try {
			return new Response(JSON.stringify({ success: true, errors: [], result: { rows: await readRows(connection, query) } }), { status: 200 });
		} catch (error) {
			return new Response(JSON.stringify({ success: false, errors: [{ code: 40004, message: String(error) }] }), { status: 400 });
		}
	}) as typeof fetch;
	return new BasinStore({ accountId: "0123456789abcdef0123456789abcdef", bucket: "typetorch-analytics", token: "test-token-not-a-secret-123", fetch: fetchImpl, clock: () => now });
}
