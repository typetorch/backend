/**
 * Roblox's acquisition numbers: GET /v1/roblox/analytics/acquisition (Open Cloud Analytics Query API through a fake
 * fetch here: one metric answers 202 and is polled). All tokens and ids are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { queryAnalyticsMetric } from "../src/opencloud.ts";
import { METRICS, RobloxAnalytics, RobloxAnalyticsError } from "../src/server/roblox-analytics.ts";
import { ADMIN, API, asJson, bearer, harness, T0, type Harness } from "./harness.ts";

const UNIVERSE = 5_550_001;
const OPEN_CLOUD = "fake-open-cloud-key-for-tests";
const DAY = 86_400_000;
/** T0 is 2026-10-09 12:00 UTC: the window is the 14 days ending 2026-10-09 00:00. */
const END = Math.floor(T0 / DAY) * DAY;
const day = (i: number) => new Date(END - (14 - i) * DAY).toISOString();

type Call = { method: string; url: string; body?: Record<string, any>; headers: Record<string, string> };

function fakeRoblox(calls: Call[], state: { status: number; polls: number }) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method: init?.method ?? "GET", url: String(input), body, headers: init?.headers as Record<string, string> });
		if (state.status !== 200) return new Response(JSON.stringify({ code: 2001, message: "nope" }), { status: state.status });
		const op = /^\/analytics-query-api\/v1\/universes\/(\d+)\/operations\/metrics\/(\w+)$/.exec(url.pathname);
		if (op) {
			state.polls++;
			return Response.json(state.polls < 2 ? { path: `v1/universes/${op[1]}/operations/metrics/${op[2]}`, done: false } : { path: url.pathname, done: true, response: { values: series("QualifiedEndToEndCVR") } });
		}
		if (url.pathname !== `/analytics-query-api/v1/universes/${UNIVERSE}/metrics` || init?.method !== "POST") return new Response("{}", { status: 404 });
		if (body.metric === "QualifiedEndToEndCVR") return Response.json({ path: `v1/universes/${UNIVERSE}/operations/metrics/op1`, done: false, metadata: {} }, { status: 202 });
		return Response.json({ path: "x", done: true, response: { values: series(body.metric, body.breakdown) } });
	}) as typeof fetch;
}

/** 14 days of made-up numbers. Day i (0-13): home PTR in percent, qualified PTR as a fraction, counts; day 13 missing. */
function series(metric: string, breakdown?: string[]) {
	const days = [...Array(13).keys()];
	const point = (i: number, value: number) => ({ time: day(i), value, status: "Valid" });
	if (breakdown?.[0] === "AcquisitionSource") {
		const k = metric === METRICS.impressions ? 100 : 2;
		return [
			{ breakdowns: [{ dimension: "AcquisitionSource", value: "HomeRecommendations", displayValue: "Home recommendations" }], dataPoints: days.map((i) => point(i, k * 2)) },
			{ breakdowns: [{ dimension: "AcquisitionSource", value: "Search" }], dataPoints: days.map((i) => point(i, k)) },
		];
	}
	switch (metric) {
		case METRICS.playThroughHome:
			return [{ breakdowns: [], dataPoints: days.map((i) => point(i, i < 7 ? 1.5 : 2.0)) }];
		case METRICS.qualifiedPlayThrough:
			return [{ breakdowns: [], dataPoints: days.map((i) => point(i, i < 7 ? 0.02 : 0.03)) }];
		case METRICS.impressions:
			return [{ breakdowns: [], dataPoints: [...days.map((i) => point(i, 300)), { time: "soon", value: 1 }, { time: day(6), value: "junk" }] }];
		case METRICS.qualifiedPlays:
			return [{ breakdowns: [], dataPoints: days.map((i) => point(i, 6)) }];
	}
	return [];
}

describe("Roblox acquisition analytics", () => {
	let h: Harness;
	let off: Harness;
	const calls: Call[] = [];
	const state = { status: 200, polls: 0 };
	beforeAll(async () => {
		h = await harness({ TYPETORCH_UNIVERSE_ID: String(UNIVERSE), OPENCLOUD_API_KEY: OPEN_CLOUD }, { fetch: fakeRoblox(calls, state) });
		off = await harness({}, { fetch: fakeRoblox(calls, state) });
	});
	afterAll(async () => {
		await h.close();
		await off.close();
	});
	const get = (path: string, init: RequestInit = { headers: bearer(ADMIN) }) => h.call(path, init);

	test("read gate and parameter checks before Roblox is asked", async () => {
		const before = calls.length;
		expect((await get("/v1/roblox/analytics/acquisition", {})).status).toBe(401);
		expect((await get("/v1/roblox/analytics/acquisition", { headers: bearer(API) })).status).toBe(401);
		expect((await get("/v1/roblox/analytics/acquisition", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		for (const q of ["?nope=1", "?days=8", "?days=7&days=14", "?days=07", "?days=-7"]) {
			const r = await get(`/v1/roblox/analytics/acquisition${q}`);
			expect({ q, status: r.status }).toEqual({ q, status: 400 });
		}
		expect(calls.length).toBe(before);
	});

	test("7 days: six one-day queries over 14 days, a slow one polled, periods and sources computed; cached", async () => {
		const r = await asJson(await get("/v1/roblox/analytics/acquisition?days=7"));
		expect(r).toMatchObject({ source: "roblox", days: 7, cached: false, metrics: METRICS });
		expect(r.current).toEqual({ from: day(7), to: day(14), daysWithData: 6, playThroughHome: 0.02, qualifiedPlayThrough: 0.03, impressions: 1800, qualifiedPlays: 36 });
		expect(r.previous).toEqual({ from: day(0), to: day(7), daysWithData: 7, playThroughHome: 0.015, qualifiedPlayThrough: 0.02, impressions: 2100, qualifiedPlays: 42 });
		expect(r.daily).toHaveLength(14);
		expect(r.daily[0]).toEqual({ day: day(0).slice(0, 10), playThroughHome: 0.015, qualifiedPlayThrough: 0.02, impressions: 300, qualifiedPlays: 6 });
		expect(r.daily[13]).toEqual({ day: day(13).slice(0, 10), playThroughHome: null, qualifiedPlayThrough: null, impressions: null, qualifiedPlays: null });
		expect(r.sources).toEqual([
			{ source: "HomeRecommendations", label: "Home recommendations", impressions: 1200, qualifiedPlays: 24, rate: 0.02 },
			{ source: "Search", label: "Search", impressions: 600, qualifiedPlays: 12, rate: 0.02 },
		]);
		expect(r.fetchedAt).toBe(new Date(T0).toISOString());
		const posts = calls.filter((c) => c.method === "POST");
		expect(posts).toHaveLength(6);
		for (const c of posts) {
			const url = new URL(c.url);
			expect(url.host).toBe("apis.roblox.com");
			expect(url.pathname).toBe(`/analytics-query-api/v1/universes/${UNIVERSE}/metrics`);
			expect(c.headers["x-api-key"]).toBe(OPEN_CLOUD);
			expect(c.body).toMatchObject({ granularity: "OneDay", startTime: day(0), endTime: day(14) });
		}
		expect(posts.map((c) => [c.body?.metric, c.body?.breakdown ?? null])).toEqual([
			[METRICS.playThroughHome, null],
			[METRICS.qualifiedPlayThrough, null],
			[METRICS.impressions, null],
			[METRICS.qualifiedPlays, null],
			[METRICS.impressions, ["AcquisitionSource"]],
			[METRICS.qualifiedPlays, ["AcquisitionSource"]],
		]);
		const polls = calls.filter((c) => c.method === "GET");
		expect(polls).toHaveLength(2);
		expect(new URL(polls[0]!.url).pathname).toBe(`/analytics-query-api/v1/universes/${UNIVERSE}/operations/metrics/op1`);
		expect(polls[0]!.headers["x-api-key"]).toBe(OPEN_CLOUD);
		const n = calls.length;
		expect((await asJson(await get("/v1/roblox/analytics/acquisition"))).cached).toBe(true);
		expect(calls.length).toBe(n);
	}, 20_000);

	test("Roblox refusing: 403 is a 502 naming the scope, 400 stays 400; never the key", async () => {
		h.setNow(h.now() + 60_000);
		state.status = 403;
		const r = await get("/v1/roblox/analytics/acquisition?days=14");
		expect(r.status).toBe(502);
		const body = await r.text();
		expect(body).toContain("universe.analytics:read");
		expect(body).not.toContain(OPEN_CLOUD);
		state.status = 400;
		expect((await get("/v1/roblox/analytics/acquisition?days=28")).status).toBe(400);
		state.status = 200;
		// The 7-day answer is still cached (an hour), the refusals weren't.
		expect((await asJson(await get("/v1/roblox/analytics/acquisition?days=7"))).cached).toBe(true);
		for (const line of h.logs) expect(line).not.toContain(OPEN_CLOUD);
	});

	test("without the key or the universe: 409, nothing asked", async () => {
		const before = calls.length;
		expect((await off.call("/v1/roblox/analytics/acquisition", { headers: bearer(ADMIN) })).status).toBe(409);
		expect(await asJson(await off.call("/v1/roblox/analytics/acquisition", { headers: bearer(ADMIN) }))).toEqual({ error: expect.stringContaining("universe.analytics:read") });
		expect(calls.length).toBe(before);
	});
});

describe("the fetcher alone", () => {
	test("the query budget: past perMinute an older answer is served, else 429", async () => {
		let now = T0;
		let asked = 0;
		const fetchOk = (async (_input: string | URL | Request, init?: RequestInit) => {
			asked++;
			const body = JSON.parse(String(init?.body));
			return Response.json({ done: true, response: { values: series(body.metric, body.breakdown) } });
		}) as typeof fetch;
		const a = new RobloxAnalytics({ apiKey: "k", universeId: UNIVERSE, fetch: fetchOk, clock: () => now, perMinute: 6, ttlMs: 1000 });
		expect((await a.acquisition(7)).cached).toBe(false);
		expect(asked).toBe(6);
		now += 2000; // the answer expired, the minute hasn't
		expect((await a.acquisition(7)).cached).toBe(true);
		expect(asked).toBe(6);
		await expect(a.acquisition(14)).rejects.toMatchObject({ status: 429 } satisfies Partial<RobloxAnalyticsError>);
		await expect(a.acquisition(9)).rejects.toMatchObject({ status: 400 });
		await expect(new RobloxAnalytics({}).acquisition(7)).rejects.toMatchObject({ status: 409 });
	});

	test("a query that never finishes is a 504; a failed operation and a missing path are 502s", async () => {
		const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
		const base = { apiKey: "k", universeId: UNIVERSE, sleep: async () => {}, query: { metric: "DailyActiveUsers", granularity: "OneDay", startTime: day(0), endTime: day(1) } } as const;
		await expect(queryAnalyticsMetric({ ...base, fetch: answer({ done: false, path: `v1/universes/${UNIVERSE}/operations/metrics/slow` }), maxPolls: 3 })).rejects.toMatchObject({ status: 504 });
		await expect(queryAnalyticsMetric({ ...base, fetch: answer({ done: false, path: "../../etc" }) })).rejects.toMatchObject({ status: 502 });
		await expect(queryAnalyticsMetric({ ...base, fetch: answer({ done: true, error: { code: 2001, message: "bad metric" } }) })).rejects.toThrow("bad metric");
		expect(await queryAnalyticsMetric({ ...base, fetch: answer({ done: true, response: { values: [{ breakdowns: [{ dimension: "Platform" }], dataPoints: [{ time: day(0), value: "7" }] }] } }) })).toEqual([{ breakdowns: [], dataPoints: [{ time: day(0), value: 7 }] }]);
	});
});
