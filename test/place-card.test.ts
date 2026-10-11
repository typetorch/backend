/**
 * The sidebar's place card: GET /v1/place (the server asks Roblox's public APIs, through a fake fetch here) and the
 * RobloxPlace cache. Roles, no place configured, the fleet's PlaceId, caching, id validation, failures and timeouts.
 * All tokens and ids are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ROBLOX_GAMES_URL, ROBLOX_GAME_ICONS_URL, ROBLOX_PLACE_UNIVERSE_URL, RobloxPlace } from "../src/server/roblox-place.ts";
import { ADMIN, API, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const UNIVERSE = 5_550_001;
const PLACE = 7_770_001;

/** A fake Roblox for one game; `state.down` makes every call fail; every URL and init asked is recorded. */
function fakeRoblox(calls: { url: string; init?: RequestInit }[], state: { down: boolean; playing: number }) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, ...(init ? { init } : {}) });
		if (state.down) return new Response("upstream down", { status: 503 });
		if (url === `${ROBLOX_PLACE_UNIVERSE_URL}${PLACE}/universe`) return Response.json({ universeId: UNIVERSE });
		if (url.startsWith(ROBLOX_GAMES_URL)) {
			return Response.json({ data: [{ id: UNIVERSE, rootPlaceId: PLACE, name: "Test\u0000 Torch Game", playing: state.playing, visits: 1 }] });
		}
		if (url.startsWith(ROBLOX_GAME_ICONS_URL)) {
			return Response.json({ data: [{ targetId: UNIVERSE, state: "Completed", imageUrl: "https://tr.rbxcdn.com/180DAY-icon/512/512/Image/Png/noFilter" }] });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

describe("GET /v1/place", () => {
	test("no universe and no heartbeat with a PlaceId: configured false, Roblox never called", async () => {
		const calls: { url: string }[] = [];
		const h = await harness({}, { fetch: fakeRoblox(calls, { down: false, playing: 1 }) });
		try {
			expect(await asJson(await h.call("/v1/place", { headers: bearer(ADMIN) }))).toEqual({ configured: false });
			expect(calls).toHaveLength(0);
		} finally {
			await h.close();
		}
	});

	describe("with TYPETORCH_UNIVERSE_ID", () => {
		let h: Harness;
		const calls: { url: string; init?: RequestInit }[] = [];
		const state = { down: false, playing: 42 };
		beforeAll(async () => {
			h = await harness({ TYPETORCH_UNIVERSE_ID: String(UNIVERSE), OPENCLOUD_API_KEY: "fake-open-cloud-key-for-tests" }, { fetch: fakeRoblox(calls, state) });
		});
		afterAll(() => h.close());
		const place = (init: RequestInit & { ip?: string } = { headers: bearer(ADMIN) }) => h.call("/v1/place", init);

		test("read gate: no credentials and the API key get 401; GET only; the /api prefix works", async () => {
			expect((await place({})).status).toBe(401);
			expect((await place({ headers: bearer(API) })).status).toBe(401);
			expect((await place({ method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
			expect((await h.call("/api/v1/place", { headers: bearer(ADMIN) })).status).toBe(200);
		});

		test("name, players, icon, root place and its link; cached for 60 s, then asked again", async () => {
			const first = await asJson(await place());
			expect(first).toMatchObject({ configured: true, universeId: UNIVERSE, placeId: PLACE, name: "Test Torch Game", playing: 42, roblox: "ok", url: `https://www.roblox.com/games/${PLACE}` });
			expect(first.icon).toBe("https://tr.rbxcdn.com/180DAY-icon/512/512/Image/Png/noFilter");
			const asked = calls.length;
			state.playing = 50;
			expect(await asJson(await place())).toMatchObject({ playing: 42, cached: true });
			expect(calls.length).toBe(asked);
			h.setNow(h.now() + 61_000);
			expect(await asJson(await place())).toMatchObject({ playing: 50, cached: false });
		});

		test("public endpoints only: no credentials or Open Cloud key sent, redirects refused, fixed hosts", async () => {
			for (const c of calls) {
				expect(["apis.roblox.com", "games.roblox.com", "thumbnails.roblox.com"]).toContain(new URL(c.url).host);
				expect(c.init?.redirect).toBe("error");
				expect(JSON.stringify(c.init?.headers ?? {})).not.toContain("fake-open-cloud-key");
				expect(c.url).not.toContain("fake-open-cloud-key");
			}
		});

		test("Roblox down: the older good answer is kept", async () => {
			state.down = true;
			h.setNow(h.now() + 61_000);
			expect(await asJson(await place())).toMatchObject({ configured: true, name: "Test Torch Game", playing: 50, cached: true });
			state.down = false;
		});
	});

	test("the fleet's PlaceId: resolved to its universe; Roblox down from the start gives a card with no count", async () => {
		const calls: { url: string }[] = [];
		const state = { down: true, playing: 3 };
		const h = await harness({}, { fetch: fakeRoblox(calls, state) });
		try {
			expect((await h.call("/v1/fleet/heartbeat", post(API, { j: "job-place", p: PLACE, n: 3 }))).status).toBe(202);
			const down = await asJson(await h.call("/v1/place", { headers: bearer(ADMIN) }));
			expect(down).toMatchObject({ configured: true, roblox: "unavailable", placeId: PLACE, name: null, playing: null, icon: null, url: `https://www.roblox.com/games/${PLACE}` });
			state.down = false;
			h.setNow(h.now() + 61_000);
			expect(await asJson(await h.call("/v1/place", { headers: bearer(ADMIN) }))).toMatchObject({ roblox: "ok", universeId: UNIVERSE, placeId: PLACE, playing: 3 });
			expect(calls.some((c) => c.url === `${ROBLOX_PLACE_UNIVERSE_URL}${PLACE}/universe`)).toBe(true);
		} finally {
			await h.close();
		}
	});
});

describe("RobloxPlace", () => {
	test("ids are checked", async () => {
		const p = new RobloxPlace({ fetch: (async () => Response.json({})) as unknown as typeof fetch });
		for (const bad of [{}, { universeId: 0 }, { universeId: -1 }, { universeId: 1.5 }, { placeId: Number.MAX_SAFE_INTEGER + 2 }, { universeId: Number.NaN }]) {
			await expect(p.get(bad)).rejects.toThrow();
		}
	});

	test("a hung Roblox times out to unavailable", async () => {
		const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const r = await new RobloxPlace({ fetch: hang, timeoutMs: 30 }).get({ universeId: 9 });
		expect(r).toEqual({ place: { placeId: null, universeId: 9, name: null, playing: null, icon: null }, status: "unavailable", cached: false });
	});

	test("an icon off Roblox's CDN, a bad count and an oversized body are dropped", async () => {
		const f = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith(ROBLOX_GAMES_URL)) return Response.json({ data: [{ id: 9, name: "Nine", playing: -4, rootPlaceId: "x" }] });
			return Response.json({ data: [{ targetId: 9, state: "Completed", imageUrl: "https://evil.example/icon.png" }] });
		}) as typeof fetch;
		expect(await new RobloxPlace({ fetch: f }).get({ universeId: 9 })).toMatchObject({ status: "partial", place: { name: "Nine", playing: null, icon: null, placeId: null } });
		const big = (async () => new Response("x".repeat(200_000), { status: 200 })) as unknown as typeof fetch;
		expect((await new RobloxPlace({ fetch: big }).get({ universeId: 9 })).status).toBe("unavailable");
	});

	test("concurrent callers share one lookup", async () => {
		let n = 0;
		const f = (async () => {
			n++;
			return Response.json({ data: [] });
		}) as unknown as typeof fetch;
		const p = new RobloxPlace({ fetch: f });
		await Promise.all([p.get({ universeId: 3 }), p.get({ universeId: 3 }), p.get({ universeId: 3 })]);
		expect(n).toBe(2);
	});
});
