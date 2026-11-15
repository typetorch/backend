/**
 * Plans/35 B: moving analytics history Basin -> this server and this server -> Basin, end to end against a fake Basin
 * (test/fake-basin.ts: the SQL API on DuckDB with Basin's limits, two streams). From Basin: every day matches, a big day
 * is read in time windows, exact duplicates (more copies than a page) are counted, erased players never land, a crash
 * mid-page resumes, 429 / 5xx are retried. To Basin: every day lands once (pages <= the byte cap), a crash between
 * `sending` and the 2xx waits for a decision (resend: nothing lost, the page twice; skip: once), verify with and
 * without Basin read settings, 429 / 5xx retried. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayNumber, dayString, fieldsOf } from "../src/duckdb/layout.ts";
import { startApp, type App, type AppOptions } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { dayStat } from "../src/server/export.ts";
import { cutWindows } from "../src/server/migrate-basin.ts";
import type { MigrateStatus } from "../src/server/migrate.ts";
import { BASIN_ACCOUNT, BASIN_BUCKET, fakeBasin, SEND_TOKEN, SQL_TOKEN, type FakeBasin } from "./fake-basin.ts";
import { DAY, NOW, generateFixture } from "./fixtures.ts";
import { ADMIN, API, asJson, bearer, post } from "./harness.ts";

const MIN = 60_000;
const TODAY = Math.floor(NOW / DAY);
const dayStart = TODAY * DAY;
const fx = generateFixture();
const within = (from: number, to: number) => ({ events: fx.events.filter((e) => e.t >= from && e.t < to), recordings: fx.recordings.filter((r) => r.t >= from && r.t < to) });
const contract = (t: "events" | "recordings") =>
	fieldsOf(t)
		.map((f) => `"${f.name}"`)
		.join(", ");
/** Short waits: backoff, Retry-After and polls take at most 5 ms here. */
const quickSleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((done, fail) => {
		if (signal.aborted) return fail(new Error("stopped"));
		const timer = setTimeout(done, Math.min(ms, 5));
		signal.addEventListener("abort", () => (clearTimeout(timer), fail(new Error("stopped"))), { once: true });
	});

interface Server {
	app: App;
	dir: string;
	clock: { now: number };
	call(path: string, init?: RequestInit): Promise<Response>;
}

const dirs: string[] = [];
const fresh = () => {
	const d = mkdtempSync(join(tmpdir(), "tt-migrate-basin-"));
	dirs.push(d);
	return d;
};

async function server(dir: string, clock: { now: number }, options: AppOptions = {}, env: Record<string, string> = {}): Promise<Server> {
	const config = loadConfig([], {
		TYPETORCH_API_KEY: API,
		TYPETORCH_ADMIN_TOKEN: ADMIN,
		TYPETORCH_DATA_DIR: dir,
		PORT: "0",
		TYPETORCH_MEMORY_LIMIT: "256MB",
		TYPETORCH_EXPLORER: "off",
		TYPETORCH_CENTRAL_LOGIN: "off",
		TYPETORCH_JOB_PER_MINUTE: "100000",
		TYPETORCH_IP_PER_MINUTE: "1000000",
		TYPETORCH_MAX_BODY: String(8 * 1024 * 1024),
		...env,
	});
	const app = await startApp(config, {
		clock: () => clock.now,
		manualJobs: true,
		log: process.env.MIGRATE_DEBUG ? (line) => console.log(`[${dir.slice(-6)}] ${line}`) : () => {},
		...options,
		migrate: { mergeRows: 500, pollMs: 5, queryWaitMs: 0, sleep: quickSleep, ...options.migrate },
	});
	return { app, dir, clock, call: (path, init = {}) => app.handle(new Request(`http://backend.test${path}`, init), "127.0.0.1") };
}

const send = (s: Server, body: unknown) => s.call("/v1/admin/migrate", { method: "POST", body: JSON.stringify(body), headers: { ...bearer(ADMIN), "content-type": "application/json" } });
const status = async (s: Server) => (await asJson(await s.call("/v1/admin/migrate", { headers: bearer(ADMIN) }))) as MigrateStatus;

async function until(s: Server, states: string[], ms = 90_000): Promise<MigrateStatus> {
	const end = Date.now() + ms;
	for (;;) {
		const st = await status(s);
		if (states.includes(st.state)) return st;
		if (Date.now() > end) throw new Error(`still ${st.state} (${JSON.stringify(st.steps)}; ${st.error})`);
		await new Promise((done) => setTimeout(done, 25));
	}
}

async function ingest(s: Server, events: object[], recordings: object[] = []): Promise<void> {
	for (let i = 0; i < Math.max(events.length, recordings.length); i += 300) {
		const res = await s.call("/v1/ingest", post(API, { events: events.slice(i, i + 300), recordings: recordings.slice(i, i + 300) }));
		expect(res.status).toBe(202);
	}
	await s.app.load();
}

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("Basin read settings from the env (either name set); malformed ones are a warning, never echoed", () => {
	const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: fresh(), TYPETORCH_CENTRAL_LOGIN: "off" };
	expect(loadConfig([], { ...base, CLOUDFLARE_ACCOUNT_ID: BASIN_ACCOUNT, BASIN_BUCKET, BASIN_SQL_TOKEN: SQL_TOKEN }).basinRead).toEqual({ accountId: BASIN_ACCOUNT, bucket: BASIN_BUCKET, token: SQL_TOKEN, namespace: "typetorch" });
	expect(loadConfig([], { ...base, CLOUDFLARE_ACCOUNT_ID: BASIN_ACCOUNT, TT_BASIN_BUCKET: BASIN_BUCKET, TT_BASIN_SQL_TOKEN: SQL_TOKEN, TT_BASIN_NAMESPACE: "game_a" }).basinRead?.namespace).toBe("game_a");
	expect(loadConfig([], base).basinRead).toBeUndefined();
	const bad = loadConfig([], { ...base, CLOUDFLARE_ACCOUNT_ID: BASIN_ACCOUNT, BASIN_SQL_TOKEN: SQL_TOKEN });
	expect(bad.basinRead).toBeUndefined();
	expect(bad.warnings.join("\n")).toContain("BASIN_BUCKET");
	expect(bad.warnings.join("\n")).not.toContain(SQL_TOKEN);
});

test("cutWindows: a contiguous partition, a big bucket on its own", () => {
	const h = 3_600_000;
	expect(cutWindows([], 0, 24 * h, 100)).toEqual([[0, 24 * h]]);
	expect(cutWindows([{ start: 0, n: 60 }, { start: h, n: 60 }, { start: 5 * h, n: 500 }, { start: 6 * h, n: 10 }], 0, 24 * h, 100)).toEqual([
		[0, h],
		[h, 5 * h],
		[5 * h, 6 * h],
		[6 * h, 24 * h],
	]);
});

// From Basin -------------------------------------------------------------------------------------------------------------

describe("Basin -> this server", () => {
	let basin: FakeBasin;
	/** Four finished days in Basin, a few rows of today, exact duplicates (one row 250 times: more than a page). */
	const rows = within(dayStart - 4 * DAY, NOW - 30 * MIN);
	const copied = rows.events.find((e) => e.t >= dayStart - 2 * DAY && e.t < dayStart - DAY) as object;
	const pids = [...new Set(rows.events.filter((e) => e.pid && e.t < dayStart - 3 * DAY).map((e) => e.pid as string))];
	const ERASED = pids[0] as string;
	const start = (s: Server, extra: object = {}) => send(s, { action: "start", from: { kind: "basin", accountId: BASIN_ACCOUNT, bucket: BASIN_BUCKET, token: SQL_TOKEN, namespace: "typetorch" }, rowsPerSecond: 10_000_000, ...extra });
	const knobs = () => ({ endpoint: basin.url, pageRows: 200, windowRows: 600, settleMs: 0 });

	/** Basin's distinct rows of a day without `erased`, and their hash over the contract columns. */
	async function basinDay(table: "events" | "recordings", day: number, erased: string[]): Promise<{ rows: number; hash: string }> {
		const not = erased.length ? ` AND (pid IS NULL OR pid NOT IN (${erased.map((p) => `'${p}'`).join(", ")}))` : "";
		const r = (await basin.sql(`SELECT COUNT(*) AS n, CAST(COALESCE(bit_xor(hash(${contract(table)})), 0) AS VARCHAR) AS h FROM (SELECT DISTINCT * FROM typetorch.${table} WHERE t >= ${day * DAY} AND t < ${(day + 1) * DAY}${not}) x`))[0];
		return { rows: Number(r?.n), hash: String(r?.h) };
	}
	/** The same over this server's copy of the day (contract columns: rt is the import time). */
	async function hereDay(s: Server, table: "events" | "recordings", day: number): Promise<{ rows: number; hash: string }> {
		const w = s.app.warehouse!;
		const file = join(table === "events" ? w.layout.events : w.layout.recordings, `${dayString(day)}.parquet`).replace(/\\/g, "/");
		const r = (
			await w.sql(
				`SELECT COUNT(*) AS n, CAST(COALESCE(bit_xor(hash(${contract(table)})), 0) AS VARCHAR) AS h FROM (SELECT ${contract(table)} FROM read_parquet('${file}') WHERE pid IS NULL OR pid NOT IN (SELECT pid FROM live.erased) UNION ALL SELECT ${contract(table)} FROM live.${table} WHERE t >= ${day * DAY} AND t < ${(day + 1) * DAY}) x`,
			)
		)[0];
		return { rows: Number(r?.n), hash: String(r?.h) };
	}

	beforeAll(async () => {
		basin = await fakeBasin();
		await basin.insert("events", [...rows.events, ...Array.from({ length: 249 }, () => copied), ...rows.events.slice(0, 40)]);
		await basin.insert("recordings", rows.recordings);
	});
	afterAll(() => basin?.close());

	test("a full move: every day matches, a big day in windows, duplicates counted, erased players never land", async () => {
		const s = await server(fresh(), { now: NOW + 12 * MIN }, { migrate: { basin: knobs() } });
		try {
			expect((await send(s, { action: "start", from: { kind: "basin", accountId: "nope", bucket: BASIN_BUCKET, token: SQL_TOKEN } })).status).toBe(400);
			expect((await s.call("/v1/erasure", { method: "POST", body: JSON.stringify({ pid: ERASED }), headers: { ...bearer(ADMIN), "content-type": "application/json" } })).status).toBe(200);
			const started = await start(s);
			expect(started.status).toBe(200);
			const body = await asJson(started);
			expect(JSON.stringify(body)).not.toContain(SQL_TOKEN);
			expect(body).toMatchObject({ direction: "from-basin", source: { kind: "basin", bucket: BASIN_BUCKET, namespace: "typetorch" } });
			const st = await until(s, ["done", "failed"]);
			expect(st.error).toBeNull();
			expect(st.state).toBe("done");
			expect(st.steps.map((x) => x.state)).toEqual(Array(8).fill("done"));
			for (const name of ["erased", "identities", "fleet"]) expect(st.steps.find((x) => x.name === name)?.note).toStartWith("not applicable");
			expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
			expect(st.days.filter((d) => d.table === "events").map((d) => d.day)).toEqual([0, 1, 2, 3, 4].map((i) => dayString(TODAY - i)));
			// Every row of Basin is here once (duplicates collapsed), the erased player's nowhere.
			for (const i of [0, 1, 2, 3, 4]) {
				for (const table of ["events", "recordings"] as const) {
					if (table === "recordings" && !st.days.some((d) => d.table === table && d.day === dayString(TODAY - i))) continue;
					expect(await hereDay(s, table, TODAY - i)).toEqual(await basinDay(table, TODAY - i, [ERASED]));
				}
			}
			const dupDay = st.days.find((d) => d.table === "events" && d.day === dayString(TODAY - 2));
			expect(dupDay?.rowsSource).toBe(rows.events.filter((e) => e.t >= dayStart - 2 * DAY && e.t < dayStart - DAY).length + 249 + rows.events.slice(0, 40).filter((e) => e.t >= dayStart - 2 * DAY && e.t < dayStart - DAY).length);
			expect(dupDay?.note).toContain("rows not kept");
			const w = s.app.warehouse!;
			expect(Number((await w.sql(`SELECT COUNT(*) AS n FROM read_parquet('${join(w.layout.events, "*.parquet").replace(/\\/g, "/")}') WHERE pid = '${ERASED}'`))[0]?.n)).toBe(0);
			// rt: the import time, as for every row this server takes in.
			expect(Number((await w.sql(`SELECT COUNT(*) AS n FROM read_parquet('${join(w.layout.events, `${dayString(TODAY - 1)}.parquet`).replace(/\\/g, "/")}') WHERE rt IS NULL`))[0]?.n)).toBe(0);
			// Basin's rules held (the fake refuses the rest); the big days were read in windows, never by OFFSET.
			const pages = basin.queries.filter((q) => q.includes("ORDER BY t, h"));
			expect(pages.length).toBeGreaterThan(20);
			const spans = pages.map((q) => /WHERE t >= (\d+) AND t < (\d+)/.exec(q)).map((m) => Number(m?.[2]) - Number(m?.[1]));
			expect(spans.some((x) => x < DAY)).toBe(true);
			expect(basin.queries.some((q) => q.includes(`floor(t / ${3_600_000})`))).toBe(true);
			// 250 copies of one row (more than a page): counted in Basin, not read page after page.
			expect(basin.queries.some((q) => q.includes(") x WHERE h = '"))).toBe(true);
			for (const q of basin.queries) expect(Number(/LIMIT (\d+)\s*$/.exec(q)?.[1])).toBeLessThanOrEqual(10_000);
			// Rollups for the imported finished days.
			const daily = await w.sql(`SELECT COUNT(*) AS n FROM glob('${join(s.dir, "rollups", "daily", "*.parquet").replace(/\\/g, "/")}')`);
			expect(Number(daily[0]?.n)).toBe(4);
		} finally {
			await s.app.stop();
		}
	}, 120_000);

	test("a crash mid-page resumes at the last page; 429 / 5xx are retried; nothing doubles", async () => {
		const dir = fresh();
		const clock = { now: NOW + 12 * MIN };
		let pageCalls = 0;
		let hung!: () => void;
		const hungAt = new Promise<void>((done) => (hung = done));
		const cutting = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(init?.body ?? "").includes("ORDER BY t, h") && ++pageCalls === 6) {
				hung();
				return new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(new Error("aborted"))));
			}
			return fetch(input, init);
		}) as typeof fetch;
		const first = await server(dir, clock, { fetch: cutting, migrate: { basin: knobs() } });
		expect((await start(first)).status).toBe(200);
		await hungAt;
		expect((await status(first)).state).toBe("running");
		await first.app.stop();
		basin.failSql.push(429, 503, 500);
		const again = await server(dir, clock, { migrate: { basin: knobs() } });
		try {
			const st = await until(again, ["done", "failed"]);
			expect(st.error).toBeNull();
			expect(st.state).toBe("done");
			expect(basin.failSql).toEqual([]);
			expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
			for (const i of [0, 1, 2, 3, 4]) expect(await hereDay(again, "events", TODAY - i)).toEqual(await basinDay("events", TODAY - i, []));
		} finally {
			await again.app.stop();
		}
	}, 120_000);

	test("a refused token stops the job with a clear error, never the token", async () => {
		const s = await server(fresh(), { now: NOW + 12 * MIN }, { migrate: { basin: knobs() } });
		try {
			expect((await send(s, { action: "start", from: { kind: "basin", accountId: BASIN_ACCOUNT, bucket: BASIN_BUCKET, token: "wrong-token-but-long-enough-000000" } })).status).toBe(200);
			const st = await until(s, ["failed", "done"]);
			expect(st.state).toBe("failed");
			expect(st.error).toContain("refused the SQL token");
			expect(JSON.stringify(st)).not.toContain("wrong-token");
		} finally {
			await s.app.stop();
		}
	}, 60_000);
});

// To Basin ---------------------------------------------------------------------------------------------------------------

const READ_ENV = { CLOUDFLARE_ACCOUNT_ID: BASIN_ACCOUNT, BASIN_BUCKET, BASIN_SQL_TOKEN: SQL_TOKEN };
const toBasin = (s: Server, b: FakeBasin, extra: object = {}) => send(s, { action: "start", to: { kind: "basin", events: b.streams.events, recordings: b.streams.recordings, token: SEND_TOKEN }, rowsPerSecond: 10_000_000, ...extra });

/** A server with two finished days (day files), late rows of yesterday and today's live rows; quiet since NOW. */
async function seededVps(dir: string, options: { big?: boolean } = {}): Promise<{ clock: { now: number }; erased: string }> {
	const clock = { now: NOW - 30 * MIN };
	const s = await server(dir, clock);
	try {
		const seeded = within(dayStart - 2 * DAY, NOW - 30 * MIN);
		await ingest(s, seeded.events, seeded.recordings);
		await s.app.nightly();
		clock.now = NOW;
		await ingest(s, within(NOW - 30 * MIN, NOW).events.map((e) => ({ ...e, t: e.t - DAY })));
		if (options.big) {
			// About 6 MB of recording chunks on yesterday: more than one POST of 4 MB.
			const base = seeded.recordings[0] ?? { v: 1, t: 0, pid: "pBig", sid: "sBig", job: "job-big", art: "art-1", chunk: 0, codec: "tt-rec-1", data: "", n: 1 };
			const big = Array.from({ length: 100 }, (_, i) => ({ ...base, pid: "pBig", sid: "sBig", t: dayStart - DAY + 3_600_000 + i, chunk: i, data: "A".repeat(60_000) }));
			for (let i = 0; i < big.length; i += 20) await ingest(s, [], big.slice(i, i + 20));
		}
		const erased = [...new Set(seeded.events.filter((e) => e.pid).map((e) => e.pid as string))][1] as string;
		expect((await s.call("/v1/erasure", { method: "POST", body: JSON.stringify({ pid: erased }), headers: { ...bearer(ADMIN), "content-type": "application/json" } })).status).toBe(200);
		return { clock, erased };
	} finally {
		await s.app.stop();
	}
}

/** Basin's rows of a day (all copies) and distinct rows. */
async function inBasin(b: FakeBasin, table: "events" | "recordings", day: number): Promise<{ rows: number; distinct: number }> {
	const where = `t >= ${day * DAY} AND t < ${(day + 1) * DAY}`;
	const r = (await b.sql(`SELECT (SELECT COUNT(*) FROM typetorch.${table} WHERE ${where}) AS n, (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM typetorch.${table} WHERE ${where}) x) AS d`))[0];
	return { rows: Number(r?.n), distinct: Number(r?.d) };
}

describe("this server -> Basin", () => {
	const dir = fresh();
	let seed: { clock: { now: number }; erased: string };
	beforeAll(async () => {
		seed = await seededVps(dir, { big: true });
	}, 120_000);

	test("a full move: every day lands once, POSTs under 4 MB, the game's own rows today are a superset, verify waits for the roll delay", async () => {
		const b = await fakeBasin();
		// The game already sends today's rows to Basin itself (the sink was switched first).
		const own = fx.events.filter((e) => e.t >= NOW - 30 * MIN && e.t < NOW).slice(0, 25).map((e) => ({ ...e, pid: "pGameOwn", t: NOW + MIN }));
		await b.insert("events", own);
		// Basin's roll delay: what the job posts is readable only from the second check of the verify step on.
		b.hold = true;
		let counts = 0;
		b.onQuery = async (q) => {
			if (!q.includes("GROUP BY CAST(floor(t / 86400000)")) return;
			counts++;
			// The game sends 5 more rows of today while the move runs (after the job counted Basin's rows before it).
			if (counts === 3) await b.insert("events", own.slice(0, 5).map((e) => ({ ...e, t: NOW + 2 * MIN })));
			if (counts === 5) await b.release();
		};
		seed.clock.now = NOW + 11 * MIN;
		const s = await server(dir, seed.clock, { migrate: { basin: { endpoint: b.url, rollPollMs: 5 } } }, READ_ENV);
		try {
			const before = await Promise.all([1, 2].map((i) => dayStat(s.app.warehouse!, "events", TODAY - i)));
			expect((await send(s, { action: "start", to: { kind: "basin", events: "http://example.com/x", recordings: b.streams.recordings, token: SEND_TOKEN } })).status).toBe(400);
			expect((await send(s, { action: "resolve", page: "x", choice: "skip" })).status).toBe(409);
			const started = await toBasin(s, b);
			expect(started.status).toBe(200);
			const body = await asJson(started);
			expect(JSON.stringify(body)).not.toContain(SEND_TOKEN);
			expect(body).toMatchObject({ direction: "to-basin", source: { kind: "local" }, target: { kind: "basin", events: b.streams.events, recordings: b.streams.recordings } });
			const st = await until(s, ["done", "failed", "needs_decision"]);
			expect(st.error).toBeNull();
			expect(st.state).toBe("done");
			expect(counts).toBeGreaterThanOrEqual(6);
			expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
			expect(st.days.find((d) => d.table === "events" && d.day === dayString(TODAY))?.note).toContain("superset: 5 more rows");
			for (const name of ["erased", "identities", "fleet", "rollups"]) expect(st.steps.find((x) => x.name === name)?.note).toStartWith("not applicable");
			// Each day once, without the erased player; this server keeps everything.
			const w = s.app.warehouse!;
			for (const i of [1, 2]) {
				for (const table of ["events", "recordings"] as const) {
					const here = await dayStat(w, table, TODAY - i);
					const there = await inBasin(b, table, TODAY - i);
					expect(there).toEqual({ rows: here.rows, distinct: here.rows });
				}
			}
			expect((await inBasin(b, "events", TODAY)).rows).toBe((await dayStat(w, "events", TODAY)).rows + 30);
			expect(Number((await b.sql(`SELECT COUNT(*) AS n FROM typetorch.events WHERE pid = '${seed.erased}'`))[0]?.n)).toBe(0);
			expect(await Promise.all([1, 2].map((i) => dayStat(w, "events", TODAY - i)))).toEqual(before);
			// The byte cap: every POST under 4 MB; the 6 MB recordings day took more than one.
			expect(b.posts.every((p) => p.status === 200 && p.bytes <= 4 * 1024 * 1024)).toBe(true);
			expect(b.posts.filter((p) => p.table === "recordings").length).toBeGreaterThanOrEqual(2);
			expect(b.posts.some((p) => p.bytes > 3 * 1024 * 1024)).toBe(true);
		} finally {
			await s.app.stop();
			await b.close();
		}
	}, 120_000);
});

describe("this server -> Basin, cut off mid-send", () => {
	const dir = fresh();
	let seed: { clock: { now: number }; erased: string };
	const knobs = (b: FakeBasin) => ({ endpoint: b.url, rollPollMs: 5, sendRows: 100 });
	beforeAll(async () => {
		seed = await seededVps(dir);
		seed.clock.now = NOW + 11 * MIN;
	}, 120_000);

	/** Starts a move whose 2nd POST of yesterday's events reaches Basin, then the server dies before the answer. */
	async function crash(b: FakeBasin): Promise<void> {
		let yesterday = 0;
		let hung!: () => void;
		const hungAt = new Promise<void>((done) => (hung = done));
		const cutting = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === b.streams.events && (JSON.parse(String(init?.body))[0]?.t ?? 0) < dayStart && ++yesterday === 2) {
				await fetch(input, { ...init, signal: null });
				hung();
				return new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(new Error("aborted"))));
			}
			return fetch(input, init);
		}) as typeof fetch;
		const first = await server(dir, seed.clock, { fetch: cutting, migrate: { basin: knobs(b) } }, READ_ENV);
		expect((await toBasin(first, b)).status).toBe(200);
		await hungAt;
		await first.app.stop();
	}

	test("resend: the page twice in Basin (reported as duplicates), nothing lost", async () => {
		const b = await fakeBasin();
		await crash(b);
		const s = await server(dir, seed.clock, { migrate: { basin: knobs(b) } }, READ_ENV);
		try {
			const waiting = await until(s, ["needs_decision", "done", "failed"]);
			expect(waiting.state).toBe("needs_decision");
			expect(waiting.decision).toMatchObject({ table: "events", day: dayString(TODAY - 1), rows: 100 });
			expect(waiting.decision?.page).toStartWith(`events:${dayString(TODAY - 1)}:0:`);
			expect((await send(s, { action: "resume" })).status).toBe(409);
			expect((await send(s, { action: "resolve", page: "events:nope", choice: "resend" })).status).toBe(400);
			expect((await send(s, { action: "resolve", page: waiting.decision?.page, choice: "maybe" })).status).toBe(400);
			const resolved = await send(s, { action: "resolve", page: waiting.decision?.page, choice: "resend" });
			expect(resolved.status).toBe(200);
			const st = await until(s, ["done", "failed", "needs_decision"]);
			expect(st.error).toBeNull();
			expect(st.state).toBe("done");
			const day = st.days.find((d) => d.table === "events" && d.day === dayString(TODAY - 1));
			expect(day?.state).toBe("duplicates");
			expect((day?.rowsTarget ?? 0) - (day?.rowsSource ?? 0)).toBe(100);
			expect(day?.note).toContain("resent");
			expect(st.days.filter((d) => d.state !== "match" && d !== day && !(d.table === day?.table && d.day === day?.day))).toEqual([]);
			const here = await dayStat(s.app.warehouse!, "events", TODAY - 1);
			expect(await inBasin(b, "events", TODAY - 1)).toEqual({ rows: here.rows + 100, distinct: here.rows });
		} finally {
			await s.app.stop();
			await b.close();
		}
	}, 120_000);

	test("skip: the page Basin had anyway is there once; every day matches", async () => {
		const b = await fakeBasin();
		await crash(b);
		const s = await server(dir, seed.clock, { migrate: { basin: knobs(b) } }, READ_ENV);
		try {
			const waiting = await until(s, ["needs_decision", "done", "failed"]);
			expect(waiting.state).toBe("needs_decision");
			expect((await send(s, { action: "resolve", page: waiting.decision?.page, choice: "skip" })).status).toBe(200);
			const st = await until(s, ["done", "failed", "needs_decision"]);
			expect(st.state).toBe("done");
			expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
			expect(st.days.find((d) => d.table === "events" && d.day === dayString(TODAY - 1))?.note).toContain("skipped");
			const here = await dayStat(s.app.warehouse!, "events", TODAY - 1);
			expect(await inBasin(b, "events", TODAY - 1)).toEqual({ rows: here.rows, distinct: here.rows });
		} finally {
			await s.app.stop();
			await b.close();
		}
	}, 120_000);

	test("without Basin read settings the days end sent; 429 / 5xx on the stream are retried without doubling", async () => {
		const b = await fakeBasin();
		b.failStream.push(503, 429, 500);
		const s = await server(dir, seed.clock, { migrate: { basin: knobs(b) } });
		try {
			expect((await toBasin(s, b)).status).toBe(200);
			const st = await until(s, ["done", "failed", "needs_decision"]);
			expect(st.error).toBeNull();
			expect(st.state).toBe("done");
			expect(b.failStream).toEqual([]);
			expect(new Set(st.days.map((d) => d.state))).toEqual(new Set(["sent"]));
			expect(st.steps.find((x) => x.name === "verify")?.note).toContain("not checked in Basin");
			for (const i of [0, 1, 2]) {
				const here = await dayStat(s.app.warehouse!, "events", TODAY - i);
				expect(await inBasin(b, "events", TODAY - i)).toEqual({ rows: here.rows, distinct: here.rows });
			}
			expect(b.queries).toEqual([]);
		} finally {
			await s.app.stop();
			await b.close();
		}
	}, 120_000);
});
