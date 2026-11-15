/**
 * The demo engine on Node for tests: DuckDB's native API (from the backend's dependencies) over the same prepared files and
 * the same setup as DuckDB-WASM in the browser (engine.ts setupStatements, the JSON macro, the day shift, the clock view).
 * Native DuckDB has the ICU extension built in, so the session is pinned to UTC (the browser build has no ICU: UTC too).
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { now } from "../mock/data";
import { clockStatement, prepare, rewriteSql, setupStatements, syntheticSetup, type DemoEngine, type Row } from "../mock/engine";

/** Like the backend's plain(), applied to nested values too. */
function plain(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") return Number(value);
	if (typeof value !== "object") return value;
	if (value instanceof Date || value instanceof Uint8Array) return value;
	if (Array.isArray(value)) return value.map(plain);
	const v = value as { toDouble?: () => number };
	if (typeof v.toDouble === "function") return v.toDouble();
	if (Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, plain(x)]));
	return String(value);
}

export interface NodeEngine extends DemoEngine {
	close(): void;
}

/** Opens the engine over `dir` (the prepared /data folder; setDataReader must point at it already). */
export async function createNodeEngine(dir: string): Promise<NodeEngine> {
	const { manifest, shift, at } = await prepare();
	const instance = await DuckDBInstance.create(":memory:", { threads: "4" });
	const c = await instance.connect();
	await c.run("SET TimeZone = 'UTC'");
	await c.run(`SET file_search_path = '${dir.replace(/'/g, "''")}'`);
	for (const statement of setupStatements(manifest, shift, at)) await c.run(statement);
	await syntheticSetup(async (statement) => ((await c.runAndReadAll(statement)).getRowObjectsJS() as Row[]).map((row) => plain(row) as Row));
	let clockAt = at;
	let chain: Promise<unknown> = Promise.resolve();
	const run = async (statement: string): Promise<Row[]> => {
		const t = now();
		if (t !== clockAt) {
			await c.run(clockStatement(t));
			clockAt = t;
		}
		const reader = await c.runAndReadAll(rewriteSql(statement));
		return (reader.getRowObjectsJS() as Row[]).map((row) => plain(row) as Row);
	};
	return {
		sql(statement) {
			const job = chain.then(() => run(statement));
			chain = job.catch(() => undefined);
			return job;
		},
		close() {
			c.closeSync();
			instance.closeSync();
		},
	};
}
