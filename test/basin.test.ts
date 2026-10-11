/**
 * Basin: rendering checks, the SQL API client, and a semantic check that runs the Basin-dialect SQL on DuckDB
 * (json_get_* shimmed as macros, `typetorch.events` as a view) through a fake SQL API, expecting the same results as
 * the DuckDB dialect. Live Basin verification needs the user's Cloudflare account.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { QUERY_NAMES, type QueryName } from "../src/queries/index.ts";
import { BasinSqlError, BasinStore, parseBasinRows } from "../src/store/basin.ts";
import { DuckDbStore, readRows } from "../src/store/duckdb.ts";
import { NOW, fixtureDb, generateFixture } from "./fixtures.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-token-not-a-secret-123";

const OPTIONS: Partial<Record<QueryName, object>> = {
	timeline: { pid: "p0003" },
	"player-graph": { pid: "p0003", facet: "zone" },
	// A payer (two purchases in the default range), so the spending statements return rows.
	"player-stats": { pid: "p0015" },
	flow: { facet: "zone" },
	funnel: { funnel: "onboarding" },
	"funnel-progress": { pids: ["p0003", "p0015"] },
	experiment: { experiment: "onboarding" },
	"experiment-players": { experiment: "onboarding" },
	servers: { maxAgeSeconds: 150 },
	deployReport: { maxAgeSeconds: 150 },
	players: { search: "p00" },
	events: { kind: "zone", name: "enter", limit: 50 },
};

let instance: DuckDBInstance;
let connection: DuckDBConnection;
const requests: { url: string; auth: string | null; query: string }[] = [];

function fakeFetch(): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const query = JSON.parse(String(init?.body)).query as string;
		requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), query });
		try {
			const rows = await readRows(connection, query);
			return new Response(JSON.stringify({ success: true, errors: [], result: { rows } }), { status: 200 });
		} catch (error) {
			return new Response(JSON.stringify({ success: false, errors: [{ code: 40004, message: String(error) }] }), { status: 400 });
		}
	}) as typeof fetch;
}

function basinStore(fetchImpl = fakeFetch()) {
	return new BasinStore({ accountId: ACCOUNT, bucket: "typetorch-analytics", token: TOKEN, fetch: fetchImpl, clock: () => NOW });
}

beforeAll(async () => {
	({ instance, connection } = await fixtureDb(generateFixture()));
	await connection.run("CREATE SCHEMA typetorch");
	await connection.run("CREATE VIEW typetorch.events AS SELECT * FROM main.events");
	await connection.run("CREATE VIEW typetorch.recordings AS SELECT * FROM main.recordings");
	await connection.run(`CREATE MACRO json_get_str(j, k) AS json_extract_string(j, '$."' || k || '"')`);
	await connection.run(`CREATE MACRO json_get_float(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS DOUBLE)`);
	await connection.run(`CREATE MACRO json_get_int(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS BIGINT)`);
	// DataFusion's estimate, as DuckDB's exact percentile (the perf-* queries).
	await connection.run("CREATE MACRO approx_percentile_cont(x, p) AS quantile_cont(x, p)");
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

describe("Basin SQL rendering", () => {
	const store = basinStore();
	const all = QUERY_NAMES.flatMap((name) => Object.entries(store.render(name, {}, OPTIONS[name] as never).statements).map(([s, sql]) => ({ name, s, sql })));

	test.each(all.map((x) => [`${x.name}.${x.s}`, x.sql]))("%s: Basin-safe", (_label, sql) => {
		// Every statement has a LIMIT within Basin's 1..10000 (Basin silently applies 500 otherwise).
		const limit = /LIMIT (\d+)\s*$/.exec(sql);
		expect(limit).not.toBeNull();
		expect(Number(limit?.[1])).toBeLessThanOrEqual(10_000);
		// Tables are namespaced; no DuckDB-only syntax.
		expect(sql).toContain("typetorch.events");
		for (const banned of ["json_extract", "TRY_CAST", "regexp_extract", "epoch_ms", "read_parquet", "::", "FILTER (", "QUALIFY", " OFFSET ", "BY NAME", "arg_max", "list("]) {
			expect(sql).not.toContain(banned);
		}
	});

	test("JSON keys use json_get_*", () => {
		const sql = store.render("roblox").statements.numbers;
		expect(sql).toContain("COALESCE(json_get_float(props, 'robux'), CAST(json_get_int(props, 'robux') AS DOUBLE))");
		expect(store.render("overview", { variant: { experiment: "onboarding", variant: "short" } }).statements.totals).toContain("json_get_str(e.exp, 'onboarding') = 'short'");
	});
});

describe("Basin results equal DuckDB results (Basin SQL run on DuckDB through shims)", () => {
	test.each(QUERY_NAMES.map((n) => [n]))("%s", async (name) => {
		const duck = new DuckDbStore(connection, (n) => n, () => NOW);
		const expected = await duck.query(name, {}, OPTIONS[name] as never);
		const got = await basinStore().query(name, {}, OPTIONS[name] as never);
		expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(JSON.stringify(expected)));
	});

	test("one-session graph with moments and node details", async () => {
		const duck = new DuckDbStore(connection, (n) => n, () => NOW);
		const timeline = await duck.query("timeline", {}, { pid: "p0003" });
		const options = { pid: "p0003", sid: timeline.sessions[0].sid, facet: "zone", moments: true };
		const expected = await duck.query("player-graph", {}, options);
		expect(expected.path?.length).toBeGreaterThan(0);
		const got = await basinStore().query("player-graph", {}, options);
		expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(JSON.stringify(expected)));
		const sql = Object.values(basinStore().render("player-graph", {}, options).statements).join("\n");
		expect(sql).toContain("json_get_str(e.props, 'step')");
		expect(sql).not.toContain("json_extract");
	});

	test("requests carry the bearer token and hit the documented endpoint", () => {
		expect(requests.length).toBeGreaterThan(0);
		expect(requests[0].url).toBe(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT}/basin-sql/query/typetorch-analytics`);
		expect(requests[0].auth).toBe(`Bearer ${TOKEN}`);
	});
});

describe("Basin SQL API client", () => {
	test("parses rows as objects or arrays", () => {
		expect(parseBasinRows({ success: true, result: { rows: [{ a: 1 }] } })).toEqual([{ a: 1 }]);
		expect(parseBasinRows({ result: { schema: [{ name: "a" }, { name: "b" }], rows: [[1, "x"]] } })).toEqual([{ a: 1, b: "x" }]);
		expect(parseBasinRows({ result: { columns: ["a"], rows: [[2]] } })).toEqual([{ a: 2 }]);
		expect(parseBasinRows({})).toEqual([]);
	});

	test("errors carry the API's codes and never the token", async () => {
		const failing = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 40003, message: "Invalid SQL syntax" }] }), { status: 400 })) as unknown as typeof fetch;
		const error = await basinStore(failing)
			.sql("SELECT nope")
			.catch((e) => e);
		expect(error).toBeInstanceOf(BasinSqlError);
		expect(error.codes).toEqual([40003]);
		expect(error.message).toContain("Invalid SQL syntax");
		expect(error.message).not.toContain(TOKEN);
	});

	test("retries edge connection failures (80001)", async () => {
		let calls = 0;
		const flaky = (async () => {
			calls++;
			if (calls === 1) return new Response(JSON.stringify({ success: false, errors: [{ code: 80001, message: "edge" }] }), { status: 502 });
			return new Response(JSON.stringify({ success: true, result: { rows: [{ x: 1 }] } }), { status: 200 });
		}) as unknown as typeof fetch;
		expect(await basinStore(flaky).sql("SELECT 1 AS x FROM typetorch.events LIMIT 1")).toEqual([{ x: 1 }]);
		expect(calls).toBe(2);
	});

	test("config checks", () => {
		expect(() => new BasinStore({ accountId: "nope", bucket: "b", token: "t" })).toThrow("accountId");
		expect(() => new BasinStore({ accountId: ACCOUNT, bucket: "B_ad", token: "t" })).toThrow("bucket");
		expect(() => new BasinStore({ accountId: ACCOUNT, bucket: "ok-bucket", token: "t", namespace: "a.b" })).toThrow("namespace");
	});
});
