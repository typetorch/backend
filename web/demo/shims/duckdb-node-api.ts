/** Browser stand-in for @duckdb/node-api (the backend's server-side DuckDB): the demo runs DuckDB-WASM instead (mock/engine.ts). */
export class DuckDBInstance {
	static create(): never {
		throw new Error("@duckdb/node-api is not available in the demo (browser build): use the demo engine");
	}
}
export const StatementType = { SELECT: 1 } as const;
export type DuckDBConnection = never;
