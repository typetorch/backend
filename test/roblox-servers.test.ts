/**
 * Roblox's server logs and restarts: GET /v1/roblox/servers/<job>/logs and GET /v1/roblox/restarts (Open Cloud server
 * management, through a fake fetch here), the heartbeat's `pv`, and the loose readers. All tokens and ids are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { logFilter, readLog, readRestart } from "../src/server/roblox-servers.ts";
import { ADMIN, API, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const UNIVERSE = 5_550_001;
const PLACE = 7_770_001;
const OPEN_CLOUD = "fake-open-cloud-key-for-tests";
const JOB = "0b5e6c1a-1111-4222-8333-444455556666";
const OLD_JOB = "0b5e6c1a-9999-4222-8333-444455556666";

type Call = { url: string; init?: RequestInit };

function fakeRoblox(calls: Call[], state: { status: number }) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url: String(input), ...(init ? { init } : {}) });
		if (state.status !== 200) return new Response(JSON.stringify({ title: "nope" }), { status: state.status });
		if (url.pathname === `/server-management/v1/universes/${UNIVERSE}/restarts`) {
			return Response.json({
				restartStatuses: {
					"r-old": { state: "COMPLETED", startTime: "2026-10-08T10:00:00Z", endTime: "2026-10-08T10:05:00Z", places: [PLACE], remaining: { servers: 0, players: 0 } },
					"r-new": { status: "IN_PROGRESS", startTime: "2026-10-09T11:00:00Z", phase: "DELAYING", remaining: { servers: 12, players: 40 } },
				},
			});
		}
		const logs = /^\/server-management\/v1\/universes\/(\d+)\/places\/(\d+)\/versions\/(\d+)\/game-servers\/([^/]+)\/logs$/.exec(url.pathname);
		if (logs) {
			const token = url.searchParams.get("pageToken");
			return Response.json({
				gameServerLogs: [
					{ messageTimestampMs: "1760011200000", universeId: String(UNIVERSE), placeId: String(PLACE), placeVersion: logs[3], jobId: logs[4], severity: "Error", message: `boom\u0000 ${token ?? "first"}`, count: 3, extra: { region: "eu" } },
					{ messageTimestampMs: 1760011100000, severity: "Warning", message: "slow" },
				],
				...(token ? {} : { nextPageToken: "page-2" }),
			});
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

describe("Roblox server logs and restarts", () => {
	let h: Harness;
	let off: Harness;
	const calls: Call[] = [];
	const state = { status: 200 };
	beforeAll(async () => {
		h = await harness({ TYPETORCH_UNIVERSE_ID: String(UNIVERSE), OPENCLOUD_API_KEY: OPEN_CLOUD }, { fetch: fakeRoblox(calls, state) });
		off = await harness({}, { fetch: fakeRoblox(calls, state) });
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: JOB, p: PLACE, pv: 412, n: 3 }))).status).toBe(202);
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: OLD_JOB, p: PLACE, n: 1 }))).status).toBe(202);
		for (let i = 0; i < 50 && !(await h.app.fleet?.placeOf(JOB))?.placeVersion; i++) await new Promise((r) => setTimeout(r, 10));
	});
	afterAll(async () => {
		await h.close();
		await off.close();
	});
	const get = (path: string, init: RequestInit = { headers: bearer(ADMIN) }) => h.call(path, init);

	test("the heartbeat's pv is kept and shown on the server", async () => {
		expect(await h.app.fleet?.placeOf(JOB)).toEqual({ placeId: PLACE, placeVersion: 412 });
		const servers = await asJson(await get("/v1/fleet/servers"));
		expect(servers.servers.find((s: { job: string }) => s.job === JOB).placeVersion).toBe(412);
		expect(await h.app.fleet?.placeOf(OLD_JOB)).toEqual({ placeId: PLACE, placeVersion: null });
	});

	test("read gate and parameter checks before Roblox is asked", async () => {
		const before = calls.length;
		expect((await get(`/v1/roblox/servers/${JOB}/logs`, {})).status).toBe(401);
		expect((await get(`/v1/roblox/servers/${JOB}/logs`, { headers: bearer(API) })).status).toBe(401);
		expect((await get(`/v1/roblox/restarts`, { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		for (const q of ["?nope=1", "?severity=Err or", "?severity=a,b,c,d,e,f,g,h,i", "?order=up", "?placeVersion=0", "?placeId=abc", "?search=" + "x".repeat(201), "?severity=a&severity=b"]) {
			const r = await get(`/v1/roblox/servers/${JOB}/logs${q}`);
			expect({ q, status: r.status }).toEqual({ q, status: 400 });
		}
		expect((await get("/v1/roblox/servers/bad%20job/logs")).status).toBe(400);
		expect((await get("/v1/roblox/restarts?x=1")).status).toBe(400);
		expect(calls.length).toBe(before);
	});

	test("logs: the place and version from the heartbeat, newest first, normalised; cached", async () => {
		const r = await asJson(await get(`/v1/roblox/servers/${JOB}/logs?severity=Error,Warning&search=boom`));
		expect(r).toMatchObject({ jobId: JOB, placeId: PLACE, placeVersion: 412, nextPageToken: "page-2", cached: false });
		expect(r.logs[0]).toEqual({ time: "2025-10-09T12:00:00.000Z", severity: "Error", message: "boom first", count: 3, stack: null, placeVersion: 412, fields: { "extra.region": "eu" } });
		expect(r.logs[1]).toMatchObject({ time: "2025-10-09T11:58:20.000Z", severity: "Warning", message: "slow", count: null });
		const asked = new URL(calls.at(-1)!.url);
		expect(asked.host).toBe("apis.roblox.com");
		expect(asked.pathname).toBe(`/server-management/v1/universes/${UNIVERSE}/places/${PLACE}/versions/412/game-servers/${JOB}/logs`);
		expect(asked.searchParams.get("filter")).toBe('severity in ["Error", "Warning"] && search == "boom"');
		expect(asked.searchParams.get("orderBy")).toBe("message_timestamp desc");
		expect((calls.at(-1)!.init?.headers as Record<string, string>)["x-api-key"]).toBe(OPEN_CLOUD);
		const n = calls.length;
		expect((await asJson(await get(`/v1/roblox/servers/${JOB}/logs?severity=Error,Warning&search=boom`))).cached).toBe(true);
		expect(calls.length).toBe(n);
		const next = await asJson(await get(`/v1/roblox/servers/${JOB}/logs?pageToken=page-2&order=asc`));
		expect(next.nextPageToken).toBeNull();
		expect(next.logs[0].message).toBe("boom page-2");
		expect(new URL(calls.at(-1)!.url).searchParams.get("orderBy")).toBe("message_timestamp");
	});

	test("logs: an older kernel's server needs placeVersion in the query", async () => {
		const missing = await get(`/v1/roblox/servers/${OLD_JOB}/logs`);
		expect(missing.status).toBe(409);
		expect(await asJson(missing)).toMatchObject({ placeId: PLACE, placeVersion: null });
		const r = await asJson(await get(`/v1/roblox/servers/${OLD_JOB}/logs?placeVersion=400`));
		expect(r).toMatchObject({ placeId: PLACE, placeVersion: 400 });
		// A server the fleet never heard of: both in the query.
		expect((await get(`/v1/roblox/servers/abc-unknown/logs?placeVersion=3`)).status).toBe(409);
		expect((await asJson(await get(`/v1/roblox/servers/abc-unknown/logs?placeVersion=3&placeId=99`))).placeId).toBe(99);
	});

	test("restarts: normalised, the latest first", async () => {
		const r = await asJson(await get("/v1/roblox/restarts"));
		expect(r.restarts.map((x: { id: string }) => x.id)).toEqual(["r-new", "r-old"]);
		expect(r.restarts[0]).toEqual({ id: "r-new", state: "IN_PROGRESS", startedAt: "2026-10-09T11:00:00.000Z", endedAt: null, fields: { phase: "DELAYING", "remaining.servers": 12, "remaining.players": 40 } });
		expect(r.restarts[1]).toMatchObject({ state: "COMPLETED", endedAt: "2026-10-08T10:05:00.000Z", fields: { places: String(PLACE) } });
	});

	test("Roblox refusing: 403 is a 502 naming the scope, 400 stays 400; never the key", async () => {
		h.setNow(h.now() + 60_000);
		state.status = 403;
		const r = await get("/v1/roblox/restarts");
		expect(r.status).toBe(502);
		const body = await r.text();
		expect(body).toContain("universe:read");
		expect(body).not.toContain(OPEN_CLOUD);
		state.status = 400;
		expect((await get(`/v1/roblox/servers/${JOB}/logs?search=zzz`)).status).toBe(400);
		state.status = 200;
		for (const line of h.logs) expect(line).not.toContain(OPEN_CLOUD);
	});

	test("without the key or the universe: 409, nothing asked", async () => {
		const before = calls.length;
		expect((await off.call("/v1/roblox/restarts", { headers: bearer(ADMIN) })).status).toBe(409);
		expect((await off.call(`/v1/roblox/servers/${JOB}/logs?placeVersion=1&placeId=2`, { headers: bearer(ADMIN) })).status).toBe(409);
		expect(calls.length).toBe(before);
	});
});

describe("loose readers", () => {
	test("filters: one severity is ==, quotes and control characters in the search are safe", () => {
		expect(logFilter({})).toBeUndefined();
		expect(logFilter({ severity: ["Error"] })).toBe('severity == "Error"');
		expect(logFilter({ search: 'a "b" \\ c\n' })).toBe('search == "a \\"b\\" \\\\ c"');
		expect(logFilter({ severity: ["bad word"] })).toBeUndefined();
	});

	test("a log: other time and message names, ISO times, junk dropped", () => {
		expect(readLog({ timestamp: "2026-10-09T12:00:00Z", level: "WARNING", text: "hi", occurrences: "7", stackTrace: "Script:1", nested: { deep: { x: 1 } } })).toEqual({
			time: "2026-10-09T12:00:00.000Z",
			severity: "WARNING",
			message: "hi",
			count: 7,
			stack: "Script:1",
			placeVersion: null,
			fields: {},
		});
		expect(readLog({ messageTimestampMs: "soon", message: 5 })).toMatchObject({ time: null, message: null, fields: { messageTimestampMs: "soon", message: 5 } });
	});

	test("a restart without known names keeps its fields", () => {
		expect(readRestart("x", { progress: 0.5, done: false })).toEqual({ id: "x", state: null, startedAt: null, endedAt: null, fields: { progress: 0.5, done: false } });
	});
});
