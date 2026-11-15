/**
 * Plans/35 A: moving to another server, end to end with two real servers in one process (two data folders, two ports):
 * the old one seeded with several days, live rows, late rows, fleet history, error logs, identities and erased pids; the
 * new one with its own rows of the cutover day. The job pulls everything through the export API; every day must match;
 * erased pids never land; an erasure on the new server during the move removes imported rows; re-running doesn't
 * duplicate; killing the job mid-page and restarting the new server resumes. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayNumber, dayString } from "../src/duckdb/layout.ts";
import { startApp, type App, type AppOptions } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { dayStat } from "../src/server/export.ts";
import type { MigrateStatus } from "../src/server/migrate.ts";
import { DAY, NOW, generateFixture } from "./fixtures.ts";
import { ADMIN, API, asJson, bearer, post } from "./harness.ts";

const MIN = 60_000;
const dayStart = Math.floor(NOW / DAY) * DAY;
const TODAY = Math.floor(NOW / DAY);
const fx = generateFixture();
const window = (from: number, to: number) => ({ events: fx.events.filter((e) => e.t >= from && e.t < to), recordings: fx.recordings.filter((r) => r.t >= from && r.t < to) });
// Four days on the old server: three finished (day files) and today (live rows), plus late rows of yesterday.
const seeded = window(dayStart - 3 * DAY, NOW - 30 * MIN);
const late = window(NOW - 30 * MIN, NOW).events.map((e) => ({ ...e, t: e.t - DAY }));
const pidsOn = (from: number, to: number) => new Set(seeded.events.filter((e) => e.pid && e.t >= from && e.t < to).map((e) => e.pid as string));
const multiDay = [...pidsOn(dayStart - 3 * DAY, dayStart - 2 * DAY)].filter((p) => pidsOn(dayStart - DAY, dayStart).has(p) && pidsOn(dayStart, NOW).has(p));
/** Erased on the old server before the move: never lands on the new one. */
const E1 = multiDay[0] as string;
/** Erased on the new server during the move: its imported rows go, and no later page brings them back. */
const E2 = multiDay[1] as string;
/** A player with an identity and errors, moved as is. */
const P3 = multiDay[2] as string;

interface Server {
	app: App;
	dir: string;
	base: string;
	clock: { now: number };
	call(path: string, init?: RequestInit): Promise<Response>;
}

async function server(dir: string, now: number, options: AppOptions = {}, clock = { now }): Promise<Server> {
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
	});
	const app = await startApp(config, {
		clock: () => clock.now,
		manualJobs: true,
		log: process.env.MIGRATE_DEBUG ? (line) => console.log(`[${dir.slice(-6)}] ${line}`) : () => {},
		...options,
		migrate: { pageSize: { events: 200, recordings: 2, fleet: 3 }, mergeRows: 500, pollMs: 20, queryWaitMs: 0, ...options.migrate },
	});
	return { app, dir, base: `http://127.0.0.1:${app.port}`, clock, call: (path, init = {}) => app.handle(new Request(`http://backend.test${path}`, init), "127.0.0.1") };
}

const send = (s: Server, method: string, path: string, body: unknown) => s.call(path, { method, body: JSON.stringify(body), headers: { ...bearer(ADMIN), "content-type": "application/json" } });

async function ingest(s: Server, events: object[], recordings: object[] = []): Promise<void> {
	for (let i = 0; i < Math.max(events.length, recordings.length); i += 300) {
		const res = await s.call("/v1/ingest", post(API, { events: events.slice(i, i + 300), recordings: recordings.slice(i, i + 300) }));
		expect(res.status).toBe(202);
	}
	await s.app.load();
}

async function status(s: Server): Promise<MigrateStatus> {
	return (await asJson(await s.call("/v1/admin/migrate", { headers: bearer(ADMIN) }))) as MigrateStatus;
}

async function until(s: Server, states: string[], ms = 60_000): Promise<MigrateStatus> {
	const end = Date.now() + ms;
	for (;;) {
		const st = await status(s);
		if (states.includes(st.state)) return st;
		if (Date.now() > end) throw new Error(`still ${st.state} (${JSON.stringify(st.steps)}; ${st.error})`);
		await new Promise((done) => setTimeout(done, 25));
	}
}

/** Rows of `pid` anywhere on a server: day files and live rows, both tables. */
async function rowsOf(s: Server, pid: string): Promise<number> {
	const w = s.app.warehouse!;
	let n = 0;
	for (const table of ["events", "recordings"] as const) {
		const glob = join(table === "events" ? w.layout.events : w.layout.recordings, "*.parquet").replace(/\\/g, "/");
		const files = Number((await w.sql(`SELECT COUNT(*) AS n FROM glob('${glob}')`))[0]?.n ?? 0);
		if (files) n += Number((await w.sql(`SELECT COUNT(*) AS n FROM read_parquet('${glob}') WHERE pid = '${pid}'`))[0]?.n ?? 0);
		n += Number((await w.sql(`SELECT COUNT(*) AS n FROM live.${table} WHERE pid = '${pid}'`))[0]?.n ?? 0);
	}
	return n;
}

/** Starts a move; the old server's clock moves on 2 minutes first (its export limit is per minute; it stays quiet). */
const start = (s: Server, from: Server) => ((from.clock.now += 2 * MIN), send(s, "POST", "/v1/admin/migrate", { action: "start", from: { kind: "backend", url: from.base, token: ADMIN }, rowsPerSecond: 10_000_000 }));
const dirs: string[] = [];
const fresh = () => {
	const d = mkdtempSync(join(tmpdir(), "tt-migrate-"));
	dirs.push(d);
	return d;
};

let old: Server;

beforeAll(async () => {
	old = await server(fresh(), NOW - 30 * MIN);
	await ingest(old, seeded.events, seeded.recordings);
	// The nightly export: the three finished days become day files; today's rows stay live.
	await old.app.nightly();
	// Late rows of yesterday (live rows of a day that has a day file), received now.
	old.clock.now = NOW;
	await ingest(old, late);
	// Fleet history, error logs, identities, a saved query, a runtime setting.
	expect((await old.call("/v1/fleet/heartbeat", post(API, { j: "job-old-1", t: "public", b: "prod", c: "prod", a: "art-1", n: 3, m: 10, s: Math.floor(NOW / 1000) - 600, u: Math.floor(NOW / 1000), p: 1001, v: "0.3.2", q: 41, g: 1, h: "ok", sv: 2 }))).status).toBeLessThan(300);
	for (const seq of [40, 41]) expect((await old.call("/v1/fleet/deploy", post(API, { j: "cli", s: seq, b: "prod", a: `art-${seq}`, k: "deploy", by: "alice", t: NOW - 3600_000 + seq }))).status).toBe(202);
	expect((await old.call("/v1/identity", post(API, { identities: [{ pid: E2, uid: 2002, t: NOW }, { pid: P3, uid: 3003, t: NOW }, { pid: E1, uid: 1001, t: NOW }] }))).status).toBeLessThan(300);
	const errors = [{ fp: "fp-moved", template: "moved <player.user_id>", count: 4, firstAt: NOW - 5 * MIN, lastAt: NOW, branch: "prod", build: "art-41", realm: "server", pids: [P3, E2] }];
	expect((await old.call("/v1/errors", post(API, { v: 1, j: "job-old-1", errors }))).status).toBe(202);
	expect((await send(old, "POST", "/v1/saved-queries", { name: "Moved query", sql: "SELECT COUNT(*) AS n FROM events" })).status).toBeLessThan(300);
	expect((await send(old, "PATCH", "/v1/admin/settings", { ipPerMinute: 7000 })).status).toBe(200);
	// E1 asks for erasure on the old server (its day files are rewritten in the background; the export filters anyway).
	expect((await send(old, "POST", "/v1/erasure", { pid: E1 })).status).toBe(200);
	// The old server has been quiet for 11 minutes when the move starts.
	old.clock.now = NOW + 11 * MIN;
}, 60_000);

afterAll(async () => {
	await old?.app.stop();
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("moving to another server", () => {
	let next: Server;
	let erasedDuring = false;

	beforeAll(async () => {
		next = await server(fresh(), NOW + 12 * MIN, {
			migrate: {
				// An erasure reaches the new server while the move runs (after the first day is in).
				onPage: async (table, day, page) => {
					if (erasedDuring || table !== "events" || day !== dayString(TODAY - 2) || page !== 0) return;
					erasedDuring = true;
					expect((await send(next, "POST", "/v1/erasure", { pid: E2 })).status).toBe(200);
				},
			},
		});
		// The game switched over: the new server already has rows of its own today (the cutover day).
		const own = seeded.events.slice(0, 50).map((e, i) => ({ ...e, t: NOW + 6 * MIN + i, pid: "pNewOnly", sid: "sNewOnly" }));
		await ingest(next, own);
		expect((await next.call("/v1/fleet/deploy", post(API, { j: "cli", s: 42, b: "prod", a: "art-42", k: "deploy", by: "bob", t: NOW + 5 * MIN }))).status).toBe(202);
	}, 60_000);
	afterAll(() => next?.app.stop());

	test("every day matches; the cutover day is a superset; the steps are done", async () => {
		const started = await start(next, old);
		expect(started.status).toBe(200);
		const body = await asJson(started);
		expect(JSON.stringify(body)).not.toContain(ADMIN);
		expect(body).toMatchObject({ direction: "from-backend", source: { kind: "backend", url: old.base } });
		// One job at a time.
		expect((await start(next, old)).status).toBe(409);
		const st = await until(next, ["done", "failed"]);
		expect(st.error).toBeNull();
		expect(st.state).toBe("done");
		expect(st.steps.map((s) => [s.name, s.state])).toEqual(["erased", "identities", "fleet", "events", "recordings", "live", "rollups", "verify"].map((n) => [n, "done"]));
		const days = st.days.filter((d) => d.table === "events").map((d) => d.day);
		expect(days).toEqual([0, 1, 2, 3].map((i) => dayString(TODAY - i)));
		expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
		const today = st.days.find((d) => d.table === "events" && d.day === dayString(TODAY));
		expect(today?.note).toBe("superset: 50 rows only on this server");
		expect(erasedDuring).toBe(true);
		expect(st.rowsDone).toBe(st.rowsTotal);
	}, 120_000);

	test("the rows: the same per day as the old server (minus erased players), erased pids nowhere", async () => {
		await next.app.warehouse!.rewriteErased();
		expect(await rowsOf(next, E1)).toBe(0);
		expect(await rowsOf(next, E2)).toBe(0);
		expect(await rowsOf(old, E2)).toBeGreaterThan(0);
		expect(await rowsOf(next, P3)).toBe(await rowsOf(old, P3));
		for (const i of [1, 2, 3]) {
			const day = TODAY - i;
			for (const table of ["events", "recordings"] as const) {
				const there = await dayStat(old.app.warehouse!, table, day, [E2]);
				expect(await dayStat(next.app.warehouse!, table, day)).toEqual(there);
			}
		}
		// Rollups were rebuilt from the imported day files (finished days only).
		for (const i of [1, 2, 3]) expect(existsSync(join(next.dir, "rollups", "daily", `${dayString(TODAY - i)}.parquet`))).toBe(true);
		// Nothing went through live.duckdb: the new server's live rows are its own.
		expect(Number((await next.app.warehouse!.sql("SELECT COUNT(*) AS n FROM live.events"))[0]?.n)).toBe(50);
	}, 120_000);

	test("the SQLite history: identities (not the erased), deploys (its own kept), errors, saved queries, a runtime setting", async () => {
		const who = async (pid: string) => asJson(await next.call(`/v1/identity?pid=${pid}`, { headers: bearer(ADMIN) }));
		expect(JSON.stringify(await who(P3))).toContain("3003");
		expect(JSON.stringify(await who(E2))).not.toContain("2002");
		expect(JSON.stringify(await who(E1))).not.toContain("1001");
		const manifest = await asJson(await next.call("/v1/admin/export/manifest", { headers: bearer(ADMIN) }));
		expect(manifest.fleet.deploys.rows).toBe(3);
		expect(manifest.fleet.error_kinds.rows).toBe(1);
		expect(manifest.fleet.saved_queries.rows).toBe(1);
		const settings = await asJson(await next.call("/v1/admin/settings", { headers: bearer(ADMIN) }));
		expect((settings.settings as { key: string; value: unknown; source: string }[]).find((s) => s.key === "ipPerMinute")).toMatchObject({ value: 7000, source: "dashboard" });
		const st = await status(next);
		expect(st.steps.find((s) => s.name === "fleet")?.note).toContain("ipPerMinute");
	}, 120_000);

	test("running it again from the same server duplicates nothing", async () => {
		const before = await asJson(await next.call("/v1/admin/export/manifest", { headers: bearer(ADMIN) }));
		expect((await start(next, old)).status).toBe(200);
		const st = await until(next, ["done", "failed"]);
		expect(st.error).toBeNull();
		expect(st.state).toBe("done");
		expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
		const after = await asJson(await next.call("/v1/admin/export/manifest", { headers: bearer(ADMIN) }));
		expect(after.tables).toEqual(before.tables);
		// The only new row: this server's own audit entry of the second start (the old server's hash reads aren't audited).
		expect(after.fleet).toEqual({ ...before.fleet, audit_log: { rows: before.fleet.audit_log.rows + 1, maxId: before.fleet.audit_log.maxId + 1 } });
	}, 120_000);

	test("the audit log has the start without the token; the status never holds it", async () => {
		const audit = await asJson(await next.call("/v1/admin/audit?action=migrate.start", { headers: bearer(ADMIN) }));
		expect(JSON.stringify(audit)).toContain("migrate.start");
		expect(JSON.stringify(audit)).not.toContain(ADMIN);
		expect(JSON.stringify(await status(next))).not.toContain(ADMIN);
	}, 120_000);
});

describe("a move cut off mid-page", () => {
	test("killing the job mid-page and restarting the new server resumes at the last page; nothing is doubled", async () => {
		const dir = fresh();
		const clock = { now: NOW + 12 * MIN };
		let hang = true;
		let hung!: () => void;
		const hungAt = new Promise<void>((done) => (hung = done));
		const cutting = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (hang && url.includes("/v1/admin/export/rows") && url.includes("table=events") && url.includes("page=2&")) {
				hang = false;
				hung();
				return new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(new Error("aborted"))));
			}
			return fetch(input, init);
		}) as typeof fetch;
		const first = await server(dir, clock.now, { fetch: cutting }, clock);
		expect((await start(first, old)).status).toBe(200);
		await hungAt;
		const mid = await status(first);
		expect(mid.state).toBe("running");
		await first.app.stop();
		// The new server comes back (a redeploy): the job goes on by itself from SQLite.
		const again = await server(dir, clock.now, {}, clock);
		try {
			const st = await until(again, ["done", "failed"]);
			expect(st.error).toBeNull();
			expect(st.state).toBe("done");
			expect(st.days.filter((d) => d.state !== "match")).toEqual([]);
			for (const d of st.days) if (d.day !== dayString(TODAY)) expect(d.rowsTarget).toBe(d.rowsSource);
			for (const i of [0, 1, 2, 3]) {
				const day = TODAY - i;
				expect(await dayStat(again.app.warehouse!, "events", day)).toEqual(await dayStat(old.app.warehouse!, "events", day));
			}
		} finally {
			await again.app.stop();
		}
	}, 120_000);

	test("pause, resume and cancel", async () => {
		const dir = fresh();
		let gate!: () => void;
		const held = new Promise<void>((done) => (gate = done));
		const s = await server(dir, NOW + 12 * MIN, { migrate: { onPage: async () => held } });
		try {
			expect((await start(s, old)).status).toBe(200);
			await until(s, ["running"]);
			const pausing = send(s, "POST", "/v1/admin/migrate", { action: "pause" });
			gate();
			const paused = await asJson(await pausing);
			expect(paused.state).toBe("paused");
			expect((await send(s, "POST", "/v1/admin/migrate", { action: "pause" })).status).toBe(409);
			expect((await asJson(await send(s, "POST", "/v1/admin/migrate", { action: "resume" }))).state).toBe("running");
			const cancelled = await asJson(await send(s, "POST", "/v1/admin/migrate", { action: "cancel" }));
			expect(cancelled.state).toBe("cancelled");
			expect(existsSync(join(dir, "migrate"))).toBe(false);
			expect((await send(s, "POST", "/v1/admin/migrate", { action: "resume" })).status).toBe(409);
		} finally {
			await s.app.stop();
		}
	}, 120_000);
});
