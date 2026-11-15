/**
 * A fake Cloudflare Basin for the migration tests (plans/35 B), on a local port: the SQL API runs the incoming SQL on a
 * DuckDB holding the "Basin" rows (`typetorch.events` / `.recordings`, the contract columns, no rt), refusing what Basin
 * refuses (no LIMIT or one over 10,000, OFFSET, UNNEST); the two streams take JSON arrays (at most 5 MB, the send token)
 * and add their rows. Failures can be queued per endpoint; posted rows can be held back (Basin's roll delay). Every
 * token is made up.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { fieldsOf } from "../src/duckdb/layout.ts";
import { duckdbType } from "../src/schema.ts";
import { readRows } from "../src/store/duckdb.ts";

export const BASIN_ACCOUNT = "0123456789abcdef0123456789abcdef";
export const BASIN_BUCKET = "typetorch-analytics";
export const SQL_TOKEN = "fake-basin-sql-token-not-a-secret-0123";
export const SEND_TOKEN = "fake-basin-send-token-not-a-secret-0123";
const MAX_POST = 5 * 1024 * 1024;

type Table = "events" | "recordings";

export interface FakeBasin {
	/** The SQL API's base URL (the migration's `basin.endpoint`). */
	url: string;
	streams: { events: string; recordings: string };
	/** Every SQL statement, in order (refused ones too). */
	queries: string[];
	/** Every POST that reached a stream: its table, rows, bytes, the answer. */
	posts: { table: Table; rows: number; bytes: number; status: number }[];
	/** Answers to give before the next SQL calls run (e.g. [429, 503]). */
	failSql: number[];
	/** Answers to give before the next stream POSTs are taken. */
	failStream: number[];
	/** While true, posted rows wait in `held` (not readable yet). */
	hold: boolean;
	held: number;
	release(): Promise<void>;
	/** Called on every SQL statement (before it runs). */
	onQuery?: (sql: string) => void | Promise<void>;
	insert(table: Table, rows: object[]): Promise<void>;
	sql(statement: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

export async function fakeBasin(): Promise<FakeBasin> {
	const instance = await DuckDBInstance.create(":memory:", { threads: "2" });
	const c: DuckDBConnection = await instance.connect();
	await c.run("CREATE SCHEMA typetorch");
	for (const t of ["events", "recordings"] as const) {
		await c.run(`CREATE TABLE typetorch.${t} (${fieldsOf(t).map((f) => `"${f.name}" ${duckdbType(f.type)}`).join(", ")})`);
	}
	const held: { table: Table; rows: object[] }[] = [];
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(job: () => Promise<T>): Promise<T> => {
		const next = chain.then(job, job);
		chain = next.catch(() => {});
		return next;
	};

	async function insert(table: Table, rows: object[]): Promise<void> {
		if (!rows.length) return;
		const fields = fieldsOf(table);
		const appender = await c.createAppender(table, "typetorch");
		for (const row of rows as Record<string, unknown>[]) {
			for (const f of fields) {
				const v = row[f.name];
				if (v === undefined || v === null) appender.appendNull();
				else if (f.type === "int32") appender.appendInteger(v as number);
				else if (f.type === "int64") appender.appendBigInt(BigInt(v as number));
				else if (f.type === "bool") appender.appendBoolean(v as boolean);
				else appender.appendVarchar(v as string);
			}
			appender.endRow();
		}
		appender.closeSync();
	}

	const fake: FakeBasin = {
		url: "",
		streams: { events: "", recordings: "" },
		queries: [],
		posts: [],
		failSql: [],
		failStream: [],
		hold: false,
		held: 0,
		release: () =>
			serial(async () => {
				for (const h of held.splice(0)) await insert(h.table, h.rows);
				fake.held = 0;
			}),
		insert: (table, rows) => serial(() => insert(table, rows)),
		sql: (statement) => serial(() => readRows(c, statement)),
		close: async () => {
			server.stop(true);
			c.closeSync();
			instance.closeSync();
		},
	};

	const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const auth = req.headers.get("authorization");
			const stream = /^\/streams\/(events|recordings)$/.exec(path);
			if (stream && req.method === "POST") {
				const table = stream[1] as Table;
				if (auth !== `Bearer ${SEND_TOKEN}`) return answer(401, { error: "bad token" });
				const text = await req.text();
				const bytes = Buffer.byteLength(text);
				const fail = fake.failStream.shift();
				if (fail) {
					fake.posts.push({ table, rows: 0, bytes, status: fail });
					return answer(fail, { error: "fake failure" });
				}
				if (bytes > MAX_POST) {
					fake.posts.push({ table, rows: 0, bytes, status: 413 });
					return answer(413, { error: "over 5 MB" });
				}
				let rows: unknown;
				try {
					rows = JSON.parse(text);
				} catch {
					return answer(400, { error: "not JSON" });
				}
				if (!Array.isArray(rows)) return answer(400, { error: "not an array" });
				fake.posts.push({ table, rows: rows.length, bytes, status: 200 });
				if (fake.hold) {
					held.push({ table, rows: rows as object[] });
					fake.held += rows.length;
				} else await fake.insert(table, rows as object[]);
				return answer(200, { success: true });
			}
			const sql = /^\/api\/v1\/accounts\/([a-f0-9]{32})\/basin-sql\/query\/([a-z0-9-]+)$/.exec(path);
			if (sql && req.method === "POST") {
				if (sql[1] !== BASIN_ACCOUNT || sql[2] !== BASIN_BUCKET) return answer(404, { success: false, errors: [{ code: 10000, message: "no such bucket" }] });
				if (auth !== `Bearer ${SQL_TOKEN}`) return answer(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
				const query = String(((await req.json()) as { query?: unknown }).query ?? "");
				fake.queries.push(query);
				await fake.onQuery?.(query);
				const fail = fake.failSql.shift();
				if (fail) return answer(fail, { success: false, errors: [{ code: fail === 429 ? 10429 : 80001, message: "fake failure" }] });
				const limit = /LIMIT (\d+)\s*$/.exec(query);
				if (!limit || Number(limit[1]) > 10_000) return answer(400, { success: false, errors: [{ code: 40004, message: "every query needs LIMIT <= 10000" }] });
				if (/\bOFFSET\b/i.test(query)) return answer(400, { success: false, errors: [{ code: 40004, message: "OFFSET is not supported" }] });
				if (/\bUNNEST\b/i.test(query)) return answer(400, { success: false, errors: [{ code: 40004, message: "UNNEST is not supported" }] });
				try {
					return answer(200, { success: true, errors: [], result: { rows: await fake.sql(query) } });
				} catch (error) {
					return answer(400, { success: false, errors: [{ code: 40004, message: String(error) }] });
				}
			}
			return answer(404, { error: "not found" });
		},
	});
	fake.url = `http://127.0.0.1:${server.port}`;
	fake.streams = { events: `${fake.url}/streams/events`, recordings: `${fake.url}/streams/recordings` };
	return fake;
}
