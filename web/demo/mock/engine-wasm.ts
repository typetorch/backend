/**
 * DuckDB-WASM in the browser (loaded by engine.ts on the first analytics call). The bundle (worker + .wasm, ~35 MB) comes
 * from jsDelivr: too big for a Workers static asset (25 MiB). The pack's CSV files come from the site's own /data/.
 *
 * Nothing else leaves the browser: autoloading extensions is switched off (DuckDB-WASM would fetch them from
 * extensions.duckdb.org; the site's Content-Security-Policy blocks that too), so the tables are read with the core CSV
 * reader and JSON goes through the demo's macro (engine.ts). Without the ICU extension DuckDB works in UTC, like the backend.
 */
import * as duckdb from "@duckdb/duckdb-wasm";
import { now, readData } from "./data";
import { clockStatement, plainValue, prepare, rewriteSql, setupStatements, syntheticSetup, tableFiles, type DemoEngine, type Row } from "./engine";

/** The files are gzip; a server that sent them with Content-Encoding: gzip (Vite's preview does) had the browser unpack them. */
const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b;

/**
 * Plain CSV bytes. DuckDB-WASM's own gzip CSV reading fails on these files ("CSV Parser state machine reached an invalid
 * state", seen on demo.typetorch.dev, which serves them as stored), so a still-packed file is unpacked here first.
 */
async function plain(bytes: Uint8Array): Promise<Uint8Array> {
	if (!isGzip(bytes)) return bytes;
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

export async function createWasmEngine(step: (text: string) => void): Promise<DemoEngine> {
	step("Loading DuckDB-WASM from jsDelivr");
	const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
	if (!bundle.mainWorker) throw new Error("no DuckDB-WASM worker for this browser");
	// A cross-origin worker can't start from its URL: a same-origin blob that imports it.
	const workerUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: "text/javascript" }));
	const worker = new Worker(workerUrl);
	const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
	try {
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
	} finally {
		URL.revokeObjectURL(workerUrl);
	}
	await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
	const conn = await db.connect();
	await conn.query("SET autoinstall_known_extensions = false");
	await conn.query("SET autoload_known_extensions = false");

	const { manifest, shift, at } = await prepare();
	const files = tableFiles(manifest);
	step(`Downloading the sample data (${mb(manifest.tables.events.bytes + manifest.tables.recordings.bytes)})`);
	const [events, recordings] = await Promise.all([readData(files.events).then(plain), readData(files.recordings).then(plain)]);
	await db.registerFileBuffer(files.events, events);
	await db.registerFileBuffer(files.recordings, recordings);
	step(`Loading ${manifest.tables.events.rows.toLocaleString("en-US")} events into DuckDB`);
	const compression = { events: "none", recordings: "none" } as const;
	for (const statement of setupStatements(manifest, shift, at, compression)) await conn.query(statement);
	step("Adding the demo's notification rows");
	await syntheticSetup(async (statement) => (await conn.query(statement)).toArray().map((r) => plainValue((r as { toJSON(): unknown }).toJSON()) as Row));
	await db.dropFile(files.events);
	await db.dropFile(files.recordings);
	// Plain SQL only from here: no files, no network, no settings changes.
	await conn.query("SET enable_external_access = false");
	await conn.query("SET lock_configuration = true");

	let clockAt = at;
	let chain: Promise<unknown> = Promise.resolve();
	const run = async (statement: string): Promise<Row[]> => {
		const t = now();
		if (Math.abs(t - clockAt) >= 5_000) {
			await conn.query(clockStatement(t));
			clockAt = t;
		}
		const table = await conn.query(rewriteSql(statement));
		return table.toArray().map((r) => plainValue((r as { toJSON(): unknown }).toJSON()) as Row);
	};
	return {
		// One statement at a time on the one connection.
		sql(statement) {
			const job = chain.then(() => run(statement));
			chain = job.catch(() => undefined);
			return job;
		},
	};
}
