/**
 * Builds the demo data pack from a game's analytics data folder (a copy of a TypeTorch backend's data/): a sample of the
 * players over the last days, every pid / sid / job re-keyed with a one-time random salt (never stored, so the mapping
 * can't be undone), the real place and universe ids replaced by fake ones, launch data blanked, and a leak check that
 * refuses to write if any original id survives. Runs on Bun (DuckDB's native API from the backend's dependencies).
 *
 *   bun demo/scripts/build-pack.ts --source <data dir> --out <pack dir> --place <real place id> --universe <real universe id>
 *       [--from 2026-11-01] [--percent 25] [--fake-place 9876543210] [--fake-universe 1234567890]
 *
 * <data dir> holds events/*.parquet and recordings/*.parquet (the backend's day files). --place / --universe may repeat
 * (every id to scrub). The output is events.parquet and recordings.parquet; copy the maps export (maps/index.json as
 * maps-index.json and the <sha256>.ttmp files) next to them by hand, after replacing the ids and names in the index.
 * The pack never goes into git: point TYPETORCH_DEMO_DATA at it (or put it in web/demo/data/) and run `bun run demo:data`.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordingNames, scrubMessageText, scrubRecordingChunk } from "./scrub.ts";

const args = process.argv.slice(2);
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1] as string] : []));
const one = (name: string, fallback?: string) => all(name)[0] ?? fallback;

const source = one("--source");
const out = one("--out");
const places = all("--place");
const universes = all("--universe");
const FROM = one("--from", new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)) as string;
const PCT = Number(one("--percent", "25"));
const FAKE_PLACE = one("--fake-place", "9876543210") as string;
const FAKE_UNIVERSE = one("--fake-universe", "1234567890") as string;

if (!source || !out || !places.length || !universes.length) {
	console.error("usage: bun demo/scripts/build-pack.ts --source <data dir> --out <pack dir> --place <id> --universe <id> [--from YYYY-MM-DD] [--percent 25]");
	process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !(PCT > 0 && PCT <= 100)) {
	console.error("--from is YYYY-MM-DD and --percent 1-100");
	process.exit(2);
}
for (const id of [...places, ...universes, FAKE_PLACE, FAKE_UNIVERSE]) {
	if (!/^\d{1,20}$/.test(id)) {
		console.error(`not an id: ${id}`);
		process.exit(2);
	}
}
const src = resolve(source);
const dst = resolve(out);
if (!existsSync(join(src, "events"))) {
	console.error(`no events/ folder in ${src}`);
	process.exit(2);
}
mkdirSync(dst, { recursive: true });

// One-time salt: kept only in this process.
const salt = randomBytes(32).toString("hex");
const db = await (await DuckDBInstance.create(":memory:")).connect();
const run = async (sql: string) => (await db.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const glob = (table: string) => lit(join(src, table, "*.parquet").replace(/\\/g, "/"));

await run(`create macro rk(x) as case when x is null or x = '' or x = 'other' then x else md5(${lit(salt)} || x) end`);
await run(
	`create macro rkj(x) as case when x is null or x = '' then x else (select substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12) from (select md5(${lit(`${salt}j`)} || x) h)) end`,
);
await run(`create table ev as select * from read_parquet(${glob("events")}) where t >= epoch_ms(timestamp ${lit(FROM)})`);
await run(`create table keep as select distinct pid from ev where pid <> '' and (hash(pid || ${lit(salt)}) % 100) < ${PCT}`);
await run(`create table ev2 as select * from ev where pid = '' or pid in (select pid from keep)`);
await run(`create table out_ev as select v, t, kind, name, rk(pid) pid, rk(sid) sid, rkj(job) job, srv,
  case when place is null then null else ${FAKE_PLACE} end place, art, seq, branch, channel, dev, newp, state, exp, sexp, src,
  props, rt from ev2 order by t`);

const md5 = (x: string) => createHash("md5").update(x).digest("hex");
const rk = (x: string) => (x === "" || x === "other" ? x : md5(salt + x));
const rkj = (x: string) => {
	if (x === "") return x;
	const h = md5(`${salt}j${x}`);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const ids = [...places, ...universes];
const KEYS = ["follow", "ref", "party_pids", "j", "src_place", "src_game", "launch", "msg", "e", "err", "jd"];
await run(`alter table out_ev add column rid bigint`);
await run(`create sequence s1`);
await run(`update out_ev set rid = nextval('s1')`);
const candidates = await run(
	`select rid, props from out_ev where props is not null and (${KEYS.map((k) => `props like ${lit(`%"${k}"%`)}`).join(" or ")} or regexp_matches(props, '[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') or ${ids.map((id) => `props like ${lit(`%${id}%`)}`).join(" or ")})`,
);
const patched: [number, string][] = [];
for (const r of candidates) {
	const p = JSON.parse(String(r.props)) as Record<string, unknown>;
	if ("src_place" in p) p.src_place = Number(FAKE_PLACE);
	if ("src_game" in p) p.src_game = Number(FAKE_UNIVERSE);
	if ("launch" in p) p.launch = "";
	// Player names inside messages: character paths and the tutorial NPC named after the player (scrub.ts).
	for (const key of ["msg", "e", "err"]) if (typeof p[key] === "string") p[key] = scrubMessageText(p[key] as string);
	if ("jd" in p) {
		const isStr = typeof p.jd === "string";
		let jd: unknown = p.jd;
		try {
			if (isStr) jd = JSON.parse(p.jd as string);
		} catch {
			jd = null;
		}
		if (jd && typeof jd === "object") {
			const o = jd as Record<string, unknown>;
			if ("LaunchData" in o) o.LaunchData = "";
			if ("LaunchDataLen" in o) o.LaunchDataLen = 0;
			p.jd = isStr ? JSON.stringify(o) : o;
		} else p.jd = isStr ? "{}" : {};
	}
	let text = JSON.stringify(p);
	text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => rkj(m));
	text = text.replace(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g, (m) => rk(m));
	for (const id of places) text = text.replaceAll(id, FAKE_PLACE);
	for (const id of universes) text = text.replaceAll(id, FAKE_UNIVERSE);
	patched.push([Number(r.rid), text]);
}
await run(`create table pt (rid bigint, props varchar)`);
for (let i = 0; i < patched.length; i += 500) {
	const chunk = patched
		.slice(i, i + 500)
		.map(([id, p]) => `(${id}, ${lit(p)})`)
		.join(",");
	await run(`insert into pt values ${chunk}`);
}
await run(`update out_ev set props = pt.props from pt where out_ev.rid = pt.rid`);
await run(`alter table out_ev drop column rid`);
console.log("patched props rows:", patched.length);

await run(`create table out_rec as select v, t, rk(pid) pid, rk(sid) sid, rkj(job) job, art, chunk, codec, data, n
  from read_parquet(${glob("recordings")}) where t >= epoch_ms(timestamp ${lit(FROM)}) and pid in (select pid from keep) order by t`);

// The recordings' string tables: the tutorial NPC carries the player's display name (scrub.ts).
const recFixes: [string, number, string][] = [];
for (const r of await run(`select sid, chunk, data from out_rec`)) {
	const data = scrubRecordingChunk(String(r.data));
	if (data !== undefined) recFixes.push([String(r.sid), Number(r.chunk), data]);
}
await run(`create table rec_fix (sid varchar, chunk bigint, data varchar)`);
for (let i = 0; i < recFixes.length; i += 500) {
	const rows = recFixes
		.slice(i, i + 500)
		.map(([sid, chunk, data]) => `(${lit(sid)}, ${chunk}, ${lit(data)})`)
		.join(",");
	await run(`insert into rec_fix values ${rows}`);
}
await run(`update out_rec set data = rec_fix.data from rec_fix where out_rec.sid = rec_fix.sid and out_rec.chunk = rec_fix.chunk`);
console.log("scrubbed recording chunks:", recFixes.length);

// Leak gate: no original pid / sid / job (or follow / ref id) and no real place / universe id may appear in the output.
await run(`create table orig as select distinct x from (select pid x from ev2 union all select sid from ev2 union all select job from ev2
  union all select json_extract_string(props,'$.follow') from ev2 union all select json_extract_string(props,'$.ref') from ev2) where x is not null and length(x) >= 16`);
const leaks = await run(
	`select count(*) n from orig where x in (select pid from out_ev union all select sid from out_ev union all select job from out_ev union all select pid from out_rec union all select sid from out_rec union all select job from out_rec)`,
);
const tokLeaks = await run(
	`select count(*) n from (select unnest(regexp_extract_all(props, '[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')) tok from out_ev where props is not null) where tok in (select x from orig)`,
);
const placeLeak = await run(`select count(*) n from out_ev where ${ids.map((id) => `props like ${lit(`%${id}%`)}`).join(" or ")}`);
const nameLeaks = (await run(`select data from out_rec`)).flatMap((r) => recordingNames(String(r.data))).length;
console.log(JSON.stringify({ leaks, tokLeaks, placeLeak, nameLeaks }));
if (Number(leaks[0]?.n) || Number(tokLeaks[0]?.n) || Number(placeLeak[0]?.n) || nameLeaks) {
	console.error("LEAK: refusing to write");
	process.exit(2);
}
await run(`copy out_ev to ${lit(join(dst, "events.parquet"))} (format parquet, compression zstd, row_group_size 100000)`);
await run(`copy out_rec to ${lit(join(dst, "recordings.parquet"))} (format parquet, compression zstd, row_group_size 20000)`);
console.log(
	JSON.stringify(
		await run(
			`select (select count(*) from out_ev) events, (select count(distinct pid) from out_ev) players, (select count(*) from out_rec) rec_rows, (select count(distinct sid) from out_rec) rec_sessions, (select min(t) from out_ev) tmin, (select max(t) from out_ev) tmax`,
		),
	),
);
