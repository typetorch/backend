/**
 * Turns the demo data pack into the files the demo serves under /data/ (web/demo/public/data/, gitignored):
 *
 *   events.csv.gz, recordings.csv.gz   the pack's Parquet as gzip CSV. DuckDB-WASM reads gzip CSV with its core build; Parquet
 *                                      and JSON are extensions it would download from extensions.duckdb.org at runtime, and
 *                                      the demo never talks to a third party (only the DuckDB bundle on jsDelivr).
 *   facts.json                         small precomputed facts (jobs, players, artifacts, deploy reports, error kinds, the
 *                                      event vocabulary), so the fleet / player / error mocks answer without loading DuckDB.
 *   manifest.json                      the files, their row counts and the pack's time span (the day shift is computed from it).
 *   maps-index.json, <sha256>.ttmp     the Maps page's geometry, copied (the index's "by" becomes the demo owner, UserId -1).
 *
 * Times stay as they are in the pack: the demo shifts them by whole days at runtime so the pack's last day is today (UTC).
 *
 *   bun demo/scripts/prepare-data.ts [--pack <dir>] [--out <dir>] [--force] [--optional]
 *
 * The pack comes from --pack, TYPETORCH_DEMO_DATA, web/demo/data/ or ../../.demo-data (next to the repo). Skipped when the
 * output is newer than the pack. Runs on Bun or Node (DuckDB's native API, from the backend's dependencies).
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_FIELDS, RECORDING_FIELDS } from "../../../src/schema.ts";
import { DEMO_OWNER_ACTOR } from "../mock/rng.ts";
import { recordingNames, scrubRecordingChunk } from "./scrub.ts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

export function findPack(explicit?: string): string | undefined {
	const candidates = [explicit, process.env.TYPETORCH_DEMO_DATA, join(WEB, "demo", "data"), resolve(WEB, "../../.demo-data")].filter((p): p is string => Boolean(p));
	return candidates.find((p) => existsSync(join(p, "events.parquet")));
}

const pack = findPack(flag("--pack"));
const out = resolve(flag("--out") ?? join(WEB, "demo", "public", "data"));
const force = args.includes("--force");
// --optional (the tests): no pack is not an error; the tests that need it skip.
const optional = args.includes("--optional");

if (!pack && optional) {
	console.log(existsSync(join(out, "manifest.json")) ? `demo data pack not found: using the prepared data in ${out}` : "demo data pack not found: the tests that need it will skip");
	process.exit(0);
}
if (!pack) {
	console.error("demo data pack not found: pass --pack <dir> or set TYPETORCH_DEMO_DATA (a folder with events.parquet, recordings.parquet, maps-index.json, *.ttmp)");
	process.exit(2);
}

const sources = readdirSync(pack).filter((f) => f === "events.parquet" || f === "recordings.parquet" || f === "maps-index.json" || /^[0-9a-f]{64}\.ttmp$/.test(f));
const newestSource = Math.max(...sources.map((f) => statSync(join(pack, f)).mtimeMs), statSync(fileURLToPath(import.meta.url)).mtimeMs, statSync(fileURLToPath(new URL("./scrub.ts", import.meta.url))).mtimeMs, statSync(fileURLToPath(new URL("../mock/rng.ts", import.meta.url))).mtimeMs);
const manifestPath = join(out, "manifest.json");
if (!force && existsSync(manifestPath) && statSync(manifestPath).mtimeMs > newestSource) {
	console.log(`demo data is up to date (${out})`);
	process.exit(0);
}
mkdirSync(out, { recursive: true });

/** NULL in the CSV (an empty field is an empty string: pid, sid and state are often ''). */
export const NULLSTR = "\\N";
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const db = await (await DuckDBInstance.create(":memory:")).connect();
const rows = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => (await db.runAndReadAll(sql)).getRowObjectsJson() as T[];
const started = Date.now();

// Privacy: player names the pack's scrub missed (the tutorial NPC's name in the recordings' strings) are scrubbed
// again here (scrub.ts), and the output is checked, so no pack can serve them.
const files: Record<string, { file: string; rows: number; bytes: number; columns: string[] }> = {};
for (const [table, fields] of [
	["events", [...EVENT_FIELDS.map((f) => f.name), "rt"]],
	["recordings", RECORDING_FIELDS.map((f) => f.name)],
] as const) {
	const source = join(pack, `${table}.parquet`);
	if (!existsSync(source)) {
		console.error(`missing ${source}`);
		process.exit(2);
	}
	const file = `${table}.csv.gz`;
	let from = `read_parquet(${lit(source)})`;
	let cols = fields.map((c) => `"${c}"`).join(", ");
	const scrubDir = mkdtempSync(join(tmpdir(), "typetorch-demo-"));
	const scrubbed = join(scrubDir, "recordings-scrub.csv");
	if (table === "recordings") {
		const fixes: string[] = ["sid,chunk,data"];
		for (const r of await rows<{ sid: string; chunk: unknown; data: string }>(`SELECT sid, chunk, data FROM ${from}`)) {
			const data = scrubRecordingChunk(r.data);
			if (data !== undefined) fixes.push(`"${r.sid.replace(/"/g, '""')}",${Number(r.chunk)},${data}`);
		}
		writeFileSync(scrubbed, `${fixes.join("\n")}\n`);
		console.log(`recordings: scrubbed player names out of ${fixes.length - 1} chunks`);
		from = `${from} r LEFT JOIN read_csv(${lit(scrubbed)}, header = true, columns = {'sid': 'VARCHAR', 'chunk': 'BIGINT', 'data': 'VARCHAR'}) s USING (sid, chunk)`;
		cols = fields.map((c) => (c === "data" ? `COALESCE(s.data, r.data) AS data` : c === "sid" || c === "chunk" ? `"${c}"` : `r."${c}"`)).join(", ");
	}
	await db.run(`COPY (SELECT ${cols} FROM ${from} ORDER BY t) TO ${lit(join(out, file))} (FORMAT csv, HEADER true, COMPRESSION gzip, NULLSTR ${lit(NULLSTR)})`);
	if (table === "recordings") {
		rmSync(scrubDir, { recursive: true, force: true });
		// Nothing the scrub should have caught may be left in what the demo serves.
		const left = (await rows<{ data: string }>(`SELECT data FROM read_csv(${lit(join(out, file))}, header = true, compression = 'gzip', all_varchar = true, nullstr = ${lit(NULLSTR)})`)).flatMap((r) => recordingNames(r.data));
		if (left.length) {
			rmSync(join(out, file), { force: true });
			console.error(`recordings: ${left.length} player names survived the scrub (e.g. ${JSON.stringify(left[0])}); nothing written`);
			process.exit(1);
		}
	}
	// The round trip must keep every NULL and every empty string where they were.
	const check = (from: string) => `SELECT COUNT(*) AS n, ${fields.map((c) => `COUNT("${c}") AS "${c}_set", SUM(CASE WHEN CAST("${c}" AS VARCHAR) = '' THEN 1 ELSE 0 END) AS "${c}_empty"`).join(", ")} FROM ${from}`;
	const a = (await rows(check(`read_parquet(${lit(source)})`)))[0];
	const b = (await rows(check(`read_csv(${lit(join(out, file))}, header = true, compression = 'gzip', all_varchar = true, nullstr = ${lit(NULLSTR)})`)))[0];
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		console.error(`${table}: the CSV does not round-trip:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`);
		process.exit(1);
	}
	files[table] = { file, rows: Number(a?.n ?? 0), bytes: statSync(join(out, file)).size, columns: [...fields] };
}

const ev = `read_parquet(${lit(join(pack, "events.parquet"))})`;
const span = (await rows<{ first: string; last: string }>(`SELECT MIN(t) AS first, MAX(t) AS last FROM ${ev}`))[0];
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// Facts --------------------------------------------------------------------------------------------------------------
const jobs = await rows(`
	WITH hb AS (
		SELECT job, MAX(TRY_CAST(json_extract_string(props, '$.n') AS INTEGER)) AS max_players,
			arg_max(json_extract_string(props, '$.v'), t) AS kernel, arg_max(TRY_CAST(json_extract_string(props, '$.m') AS INTEGER), t) AS max_slots,
			MIN(TRY_CAST(json_extract_string(props, '$.s') AS BIGINT)) AS started_s
		FROM ${ev} WHERE kind = 'fleet' AND name = 'heartbeat' GROUP BY job)
	SELECT e.job, MAX(e.place) AS place, arg_max(e.art, e.t) AS art, arg_max(e.seq, e.t) AS seq, arg_max(e.branch, e.t) AS branch,
		arg_max(e.channel, e.t) AS channel, arg_max(e.srv, e.t) AS srv, MIN(e.t) AS "firstAt", MAX(e.t) AS "lastAt", COUNT(*) AS rows,
		COUNT(DISTINCT NULLIF(e.pid, '')) AS players, COUNT(DISTINCT NULLIF(e.sid, '')) AS sessions,
		ANY_VALUE(hb.max_players) AS "maxPlayers", ANY_VALUE(hb.max_slots) AS "maxSlots", ANY_VALUE(hb.kernel) AS kernel,
		ANY_VALUE(hb.started_s) * 1000 AS "startedAt",
		COUNT(*) FILTER (WHERE e.kind = 'tech' AND e.name = 'error') AS errors
	FROM ${ev} e LEFT JOIN hb USING (job) WHERE e.job IS NOT NULL AND e.job <> '' GROUP BY e.job ORDER BY "firstAt"`);

const artifacts = await rows(`
	SELECT art, MAX(seq) AS seq, arg_max(branch, t) AS branch, MIN(t) AS "firstAt", MAX(t) AS "lastAt", COUNT(DISTINCT job) AS jobs,
		COUNT(DISTINCT NULLIF(pid, '')) AS players
	FROM ${ev} WHERE art IS NOT NULL AND art <> '' GROUP BY art ORDER BY "firstAt"`);

const players = await rows(`
	WITH j AS (SELECT pid, arg_min(json_extract_string(props, '$.country'), t) AS country, arg_min(json_extract_string(props, '$.age'), t) AS age,
			BOOL_OR(TRY_CAST(json_extract_string(props, '$.prem') AS BOOLEAN)) AS premium
		FROM ${ev} WHERE kind = 'session' AND name = 'join' AND pid <> '' GROUP BY pid),
	tm AS (SELECT pid, mode(json_extract_string(props, '$.team')) AS team, MAX(TRY_CAST(json_extract_string(props, '$.level') AS INTEGER)) AS level
		FROM ${ev} WHERE pid <> '' AND json_extract_string(props, '$.team') IS NOT NULL GROUP BY pid)
	SELECT e.pid, MIN(e.t) AS "firstAt", MAX(e.t) AS "lastAt", COUNT(DISTINCT e.sid) AS sessions, COUNT(*) AS events,
		mode(NULLIF(e.dev, 'unknown')) AS dev, BOOL_OR(e.newp) AS "newInWindow", ANY_VALUE(j.country) AS country, ANY_VALUE(j.age) AS age,
		ANY_VALUE(j.premium) AS premium, ANY_VALUE(tm.team) AS team, ANY_VALUE(tm.level) AS level,
		COUNT(*) FILTER (WHERE e.kind = 'tech' AND e.name = 'error') AS errors,
		COUNT(*) FILTER (WHERE e.kind = 'purchase') AS purchases
	FROM ${ev} e LEFT JOIN j USING (pid) LEFT JOIN tm USING (pid) WHERE e.pid IS NOT NULL AND e.pid <> '' GROUP BY e.pid ORDER BY "firstAt"`);

const deployReports = await rows(`SELECT t, job, art, seq, branch, srv, props FROM ${ev} WHERE kind = 'fleet' AND name = 'deploy_report' ORDER BY t`);

const errors = await rows(`
	SELECT json_extract_string(props, '$.msg') AS msg, src, COUNT(*) AS n, SUM(COALESCE(TRY_CAST(json_extract_string(props, '$.n') AS INTEGER), 1)) AS total,
		COUNT(DISTINCT NULLIF(pid, '')) AS players, COUNT(DISTINCT job) AS servers, MIN(t) AS "firstAt", MAX(t) AS "lastAt",
		list(DISTINCT art ORDER BY art) AS arts, list(DISTINCT branch ORDER BY branch) AS branches, mode(NULLIF(dev, 'unknown')) AS dev
	FROM ${ev} WHERE kind = 'tech' AND name = 'error' AND json_extract_string(props, '$.msg') IS NOT NULL
	GROUP BY ALL ORDER BY n DESC LIMIT 400`);

const eventNames = await rows(`SELECT kind, name, COUNT(*) AS n, COUNT(DISTINCT NULLIF(pid, '')) AS players FROM ${ev} GROUP BY ALL ORDER BY n DESC`);
const PROP_KEYS = ["team", "item", "quest", "weapon", "cause", "job", "type", "reason", "ui", "source", "variant", "step", "why", "from", "to", "country", "age"];
const props: Record<string, { value: string; n: number }[]> = {};
for (const key of PROP_KEYS) {
	props[key] = (
		await rows<{ value: string; n: unknown }>(
			`SELECT json_extract_string(props, ${lit(`$."${key}"`)}) AS value, COUNT(*) AS n FROM ${ev} WHERE kind NOT IN ('fleet', 'tech') GROUP BY 1 HAVING value IS NOT NULL AND value <> '' ORDER BY n DESC LIMIT 60`,
		)
	).map((r) => ({ value: r.value, n: Number(r.n) }));
}
const states = await rows(`SELECT state, COUNT(*) AS n FROM ${ev} WHERE state IS NOT NULL AND state <> '' GROUP BY 1 ORDER BY n DESC LIMIT 80`);
const experiments = await rows(`
	SELECT name AS experiment, json_extract_string(props, '$.variant') AS variant, COUNT(DISTINCT pid) AS players, MIN(t) AS "firstAt", MAX(t) AS "lastAt"
	FROM ${ev} WHERE kind = 'experiment' GROUP BY ALL ORDER BY experiment, variant`);
const recordings = await rows(`SELECT COUNT(DISTINCT sid) AS sessions, COUNT(DISTINCT pid) AS players, COUNT(*) AS chunks FROM read_parquet(${lit(join(pack, "recordings.parquet"))})`);

const numeric = (list: Record<string, unknown>[], keys: string[]) => list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, keys.includes(k) ? num(v) : v])));
const facts = {
	format: 1,
	meta: {
		placeId: 9876543210,
		universeId: 1234567890,
		firstT: Number(span?.first),
		lastT: Number(span?.last),
		events: files.events?.rows ?? 0,
		players: players.length,
		recordings: numeric(recordings, ["sessions", "players", "chunks"])[0],
	},
	jobs: numeric(jobs, ["place", "seq", "firstAt", "lastAt", "rows", "players", "sessions", "maxPlayers", "maxSlots", "startedAt", "errors"]),
	artifacts: numeric(artifacts, ["seq", "firstAt", "lastAt", "jobs", "players"]),
	players: numeric(players, ["firstAt", "lastAt", "sessions", "events", "level", "errors", "purchases"]),
	deployReports: numeric(deployReports, ["t", "seq"]),
	errors: numeric(errors, ["n", "total", "players", "servers", "firstAt", "lastAt"]),
	vocabulary: { events: numeric(eventNames, ["n", "players"]), props, states: numeric(states, ["n"]) },
	experiments: numeric(experiments, ["players", "firstAt", "lastAt"]),
};
writeFileSync(join(out, "facts.json"), JSON.stringify(facts));

// Maps ---------------------------------------------------------------------------------------------------------------
const maps: string[] = [];
for (const f of sources) {
	if (f === "maps-index.json") {
		// Whoever exported the map ("by": "roblox user <id> (<name>)") becomes the demo owner, whose UserId can't be a real
		// account's.
		const text = readFileSync(join(pack, f), "utf8").replace(/roblox user -?\d+ \([^)"]*\)/g, DEMO_OWNER_ACTOR);
		if (/roblox user (?!-1 )/.test(text)) throw new Error("maps-index.json: an exporter's UserId survived the rewrite");
		writeFileSync(join(out, f), text);
	} else if (f.endsWith(".ttmp")) {
		copyFileSync(join(pack, f), join(out, f));
		maps.push(f);
	}
}

// The explorer's favicons, for the demo's own index.html.
const publicDir = dirname(out);
for (const f of ["favicon.ico", "favicon.svg", "apple-touch-icon.png"]) if (existsSync(join(WEB, "public", f))) copyFileSync(join(WEB, "public", f), join(publicDir, f));

const manifest = {
	format: 1,
	firstT: facts.meta.firstT,
	lastT: facts.meta.lastT,
	tables: files,
	csv: { nullstr: NULLSTR },
	facts: { file: "facts.json", bytes: statSync(join(out, "facts.json")).size },
	maps: { index: existsSync(join(out, "maps-index.json")) ? "maps-index.json" : null, files: maps },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
console.log(
	`demo data ready in ${out} (${((Date.now() - started) / 1000).toFixed(1)} s): events ${files.events?.rows} rows ${mb(files.events?.bytes ?? 0)}, recordings ${files.recordings?.rows} rows ${mb(files.recordings?.bytes ?? 0)}, facts ${mb(manifest.facts.bytes)}`,
);
