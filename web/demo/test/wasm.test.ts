/**
 * The browser's engine on Node: DuckDB-WASM (the package's Node blocking build, the same .wasm the browser loads from
 * jsDelivr) with the same setup and SQL rewriting as engine-wasm.ts, against native DuckDB. Every named query answers on
 * WASM, with data where native has data, and with the same answer, except queries that order rows with equal timestamps
 * (the sequence / graph queries and the newest-rows lists): the two engines break those ties differently (threads), so
 * their counts move a little and rows with the same time can swap.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { QUERY_NAMES } from "../../../src/queries/index.ts";
import { now } from "../mock/data";
import { clockStatement, engine, plainValue, prepare, rewriteSql, setEngine, setupStatements, syntheticSetup, tableFiles, type DemoEngine, type Row } from "../mock/engine";
import { pack } from "../mock/pack";
import { DATA_DIR, describeWithPack, setupDemo, teardownDemo, testApi } from "./harness";

const require = createRequire(import.meta.url);

/** Event-order queries: equal timestamps are ordered differently by the two engines. */
const TIE_ORDER = new Set(["timeline", "player-graph", "flow", "confusion", "recording-replay", "quit-autopsy", "events", "player-events"]);

function round(v: unknown): unknown {
	if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toPrecision(6));
	if (Array.isArray(v)) return v.map(round);
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
	return v;
}

function hasData(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "number") return value > 0;
	if (value && typeof value === "object") return Object.values(value).some(hasData);
	return false;
}

interface BlockingConnection {
	query(sql: string): { toArray(): { toJSON(): unknown }[] };
}

async function createBlockingWasmEngine(): Promise<DemoEngine> {
	const entry = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
	const duckdb = require(entry);
	const dist = join(entry, "..");
	const bundles = {
		mvp: { mainModule: join(dist, "duckdb-mvp.wasm"), mainWorker: join(dist, "duckdb-node-mvp.worker.cjs") },
		eh: { mainModule: join(dist, "duckdb-eh.wasm"), mainWorker: join(dist, "duckdb-node-eh.worker.cjs") },
	};
	const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
	await db.instantiate(() => {});
	db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
	const conn = db.connect() as BlockingConnection;
	conn.query("SET autoinstall_known_extensions = false");
	conn.query("SET autoload_known_extensions = false");
	const { manifest, shift, at } = await prepare();
	const files = tableFiles(manifest);
	db.registerFileBuffer(files.events, new Uint8Array(readFileSync(join(DATA_DIR, files.events))));
	db.registerFileBuffer(files.recordings, new Uint8Array(readFileSync(join(DATA_DIR, files.recordings))));
	for (const statement of setupStatements(manifest, shift, at)) conn.query(statement);
	await syntheticSetup(async (statement) => conn.query(statement).toArray().map((r) => plainValue(r.toJSON()) as Row));
	let clockAt = at;
	return {
		async sql(statement) {
			if (now() !== clockAt) {
				conn.query(clockStatement(now()));
				clockAt = now();
			}
			return conn.query(rewriteSql(statement)).toArray().map((r) => plainValue(r.toJSON()) as Row);
		},
	};
}

describeWithPack("DuckDB-WASM answers like native DuckDB", () => {
	let native: DemoEngine;
	let wasm: DemoEngine;
	let options: Record<string, object> = {};

	beforeAll(async () => {
		await setupDemo({ engine: true });
		native = await engine();
		wasm = await createBlockingWasmEngine();
		const p = await pack();
		const pid = [...p.players].filter((x) => x.lastAt > p.now - 3 * 86_400_000).sort((a, b) => b.events - a.events)[0]?.pid as string;
		const sessions = (await testApi().raw("recording-sessions", { filters: {}, options: {} })).result as { sessions: { sid: string }[] };
		const names = ["join", "leave", "quest_complete", "shop_buy", "level_up", "death"];
		options = {
			"funnel-progress": { pids: [pid] },
			"funnel-players": { funnel: "first_session", step: 1 },
			timeline: { pid },
			"player-graph": { pid },
			"player-stats": { pid },
			"player-events": { pids: [pid], names },
			"player-summary": { pids: [pid], names },
			"experiment-players": { experiment: "one_tap_play" },
			"recording-replay": { sid: sessions.sessions[0]?.sid as string },
			"notify-player": { pid },
		};
	}, 300_000);
	afterAll(() => {
		setEngine(native);
		teardownDemo();
	});

	for (const name of QUERY_NAMES) {
		it(name, async () => {
			const body = { filters: {}, options: options[name] ?? {} };
			setEngine(native);
			const a = round((await testApi().raw(name, body)).result);
			setEngine(wasm);
			const b = round((await testApi().raw(name, body)).result);
			setEngine(native);
			expect(hasData(b), `${name}: data on WASM`).toBe(hasData(a));
			if (TIE_ORDER.has(name)) expect(Object.keys(b as object).sort()).toEqual(Object.keys(a as object).sort());
			else expect(b).toEqual(a);
		});
	}
});
