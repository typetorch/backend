/**
 * Product tooltips: GET /v1/roblox/products (the server asks Roblox's public APIs, through a fake fetch here) and the
 * RobloxProducts cache. Roles, id validation, batching, caching, failures, timeouts and no secret anywhere.
 * All tokens and ids are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	parseIdList,
	ROBLOX_DEV_PRODUCT_ICONS_URL,
	ROBLOX_DEV_PRODUCT_INFO_URL,
	ROBLOX_GAME_PASS_ICONS_URL,
	ROBLOX_GAME_PASS_INFO_URL,
	RobloxProducts,
} from "../src/server/roblox-products.ts";
import { ADMIN, API, asJson, bearer, harness, type Harness } from "./harness.ts";

const PASS = 9_100_001;
const PASS_MISSING = 9_100_404;
const PRODUCT = 1_118_524_989;
const PRODUCT_TARGET = 5_051_955;
const OPEN_CLOUD = "fake-open-cloud-key-for-tests";

type Call = { url: string; init?: RequestInit };

/** A fake Roblox: one game pass, one developer product; `state.down` makes every call fail. */
function fakeRoblox(calls: Call[], state: { down: boolean; price: number }) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, ...(init ? { init } : {}) });
		if (state.down) return new Response("upstream down", { status: 503 });
		if (url === `${ROBLOX_GAME_PASS_INFO_URL}${PASS}/product-info`) {
			return Response.json({ TargetId: PASS, ProductType: "Game Pass", Name: "VIP\u0000 Pass", PriceInRobux: state.price, IsForSale: true });
		}
		if (url.startsWith(ROBLOX_GAME_PASS_INFO_URL)) return new Response('"game pass not found"', { status: 404 });
		if (url === `${ROBLOX_DEV_PRODUCT_INFO_URL}${PRODUCT}/details`) {
			return Response.json({ TargetId: PRODUCT_TARGET, ProductId: PRODUCT, ProductType: "Developer Product", Name: "100 Coins", PriceInRobux: 25, IsForSale: true });
		}
		if (url.startsWith(ROBLOX_DEV_PRODUCT_INFO_URL)) return Response.json({ errorCode: "InvalidProductId" }, { status: 404 });
		if (url.startsWith(`${ROBLOX_GAME_PASS_ICONS_URL}?`)) {
			const ids = new URL(url).searchParams.get("gamePassIds")?.split(",").map(Number) ?? [];
			return Response.json({ data: ids.map((id) => ({ targetId: id, state: "Completed", imageUrl: `https://tr.rbxcdn.com/180DAY-pass-${id}/150/150/Image/Png/noFilter` })) });
		}
		if (url.startsWith(`${ROBLOX_DEV_PRODUCT_ICONS_URL}?`)) {
			const ids = new URL(url).searchParams.get("developerProductIds")?.split(",").map(Number) ?? [];
			return Response.json({ data: ids.map((id) => ({ targetId: id, state: "Completed", imageUrl: `https://tr.rbxcdn.com/180DAY-product-${id}/150/150/Image/Png/noFilter` })) });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

describe("GET /v1/roblox/products", () => {
	let h: Harness;
	const calls: Call[] = [];
	const state = { down: false, price: 199 };
	beforeAll(async () => {
		h = await harness({ TYPETORCH_UNIVERSE_ID: "5550001", OPENCLOUD_API_KEY: OPEN_CLOUD }, { fetch: fakeRoblox(calls, state) });
	});
	afterAll(() => h.close());
	const products = (query: string, init: RequestInit & { ip?: string } = { headers: bearer(ADMIN) }) => h.call(`/v1/roblox/products${query}`, init);

	test("read gate: no credentials and the API key get 401; GET only; the /api prefix works", async () => {
		expect((await products(`?gamepass=${PASS}`, {})).status).toBe(401);
		expect((await products(`?gamepass=${PASS}`, { headers: bearer(API) })).status).toBe(401);
		expect((await products(`?gamepass=${PASS}`, { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		expect(calls).toHaveLength(0);
		expect((await h.call(`/api/v1/roblox/products?product=31337`, { headers: bearer(ADMIN) })).status).toBe(200);
	});

	test("ids are checked before Roblox is asked", async () => {
		const before = calls.length;
		const tooMany = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
		for (const q of ["", "?gamepass=", "?gamepass=0", "?gamepass=-1", "?gamepass=1.5", "?gamepass=abc", "?product=1,,2", "?product=01", "?gamepass=99999999999999999999", "?gamepass=1&gamepass=2", "?asset=1", `?gamepass=${tooMany}`, `?gamepass=1,2,3&product=${Array.from({ length: 48 }, (_, i) => i + 10).join(",")}`]) {
			const r = await products(q);
			expect({ q, status: r.status }).toEqual({ q, status: 400 });
		}
		expect(calls.length).toBe(before);
	});

	test("a batch: game pass and developer product with name, price and icon; unknown ids degrade to the id", async () => {
		const before = calls.length;
		const r = await asJson(await products(`?gamepass=${PASS_MISSING},${PASS},${PASS}&product=${PRODUCT},777`));
		expect(r.items).toEqual([
			{ type: "gamepass", id: PASS_MISSING, status: "not_found", name: null, price: null, forSale: null, icon: null },
			{ type: "gamepass", id: PASS, status: "ok", name: "VIP Pass", price: 199, forSale: true, icon: `https://tr.rbxcdn.com/180DAY-pass-${PASS}/150/150/Image/Png/noFilter` },
			{ type: "product", id: PRODUCT, status: "ok", name: "100 Coins", price: 25, forSale: true, icon: `https://tr.rbxcdn.com/180DAY-product-${PRODUCT_TARGET}/150/150/Image/Png/noFilter` },
			{ type: "product", id: 777, status: "not_found", name: null, price: null, forSale: null, icon: null },
		]);
		// One thumbnails call per type for the whole batch; the developer product icon goes by its TargetId.
		const asked = calls.slice(before);
		expect(asked.filter((c) => c.url.startsWith(ROBLOX_GAME_PASS_ICONS_URL)).length).toBe(1);
		expect(asked.filter((c) => c.url.startsWith(ROBLOX_DEV_PRODUCT_ICONS_URL)).length).toBe(1);
		expect(asked.some((c) => c.url.includes(`developerProductIds=${PRODUCT_TARGET}`))).toBe(true);
	});

	test("cached for an hour, then asked again", async () => {
		const asked = calls.length;
		state.price = 249;
		expect((await asJson(await products(`?gamepass=${PASS}&product=${PRODUCT}`))).items[0].price).toBe(199);
		expect(calls.length).toBe(asked);
		h.setNow(h.now() + 61 * 60_000);
		expect((await asJson(await products(`?gamepass=${PASS}`))).items[0].price).toBe(249);
	});

	test("Roblox down: the older good answer is kept; an unknown item comes back unavailable", async () => {
		state.down = true;
		h.setNow(h.now() + 61 * 60_000);
		const r = await asJson(await products(`?gamepass=${PASS}&product=4242`));
		expect(r.items[0]).toMatchObject({ id: PASS, status: "ok", name: "VIP Pass", price: 249 });
		expect(r.items[1]).toEqual({ type: "product", id: 4242, status: "unavailable", name: null, price: null, forSale: null, icon: null });
		state.down = false;
	});

	test("public endpoints only: fixed hosts, no credentials or Open Cloud key sent, redirects refused; no secret in logs", async () => {
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) {
			expect(["apis.roblox.com", "thumbnails.roblox.com"]).toContain(new URL(c.url).host);
			expect(c.init?.redirect).toBe("error");
			expect(JSON.stringify(c.init?.headers ?? {})).not.toContain(OPEN_CLOUD);
			expect(c.url).not.toContain(OPEN_CLOUD);
			expect(JSON.stringify(c.init?.headers ?? {}).toLowerCase()).not.toContain("x-api-key");
		}
		const body = await (await products(`?gamepass=${PASS}&product=${PRODUCT}`)).text();
		expect(body).not.toContain(OPEN_CLOUD);
		expect(h.logs.join("\n")).not.toContain(OPEN_CLOUD);
	});
});

describe("RobloxProducts", () => {
	test("ids and counts are checked", async () => {
		const p = new RobloxProducts({ fetch: (async () => Response.json({})) as unknown as typeof fetch });
		for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) await expect(p.get({ gamepass: [bad], product: [] })).rejects.toThrow();
		await expect(p.get({ gamepass: Array.from({ length: 51 }, (_, i) => i + 1), product: [] })).rejects.toThrow();
		expect(parseIdList("1,2,3")).toEqual([1, 2, 3]);
		expect(parseIdList(null)).toEqual([]);
		for (const bad of ["", "1,", "a", "0", "1e3", "１"]) expect(parseIdList(bad)).toBeUndefined();
	});

	test("a hung Roblox times out to unavailable", async () => {
		const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const r = await new RobloxProducts({ fetch: hang, timeoutMs: 30 }).get({ gamepass: [9], product: [] });
		expect(r).toEqual([{ type: "gamepass", id: 9, status: "unavailable", name: null, price: null, forSale: null, icon: null }]);
	});

	test("an icon off Roblox's CDN, an answer about another id, a bad price and an oversized body are dropped", async () => {
		const f = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/game-passes/9/")) return Response.json({ TargetId: 9, Name: "Nine", PriceInRobux: -5 });
			if (url.includes("/developer-products/8/")) return Response.json({ TargetId: 1, ProductId: 99, Name: "Wrong" });
			if (url.includes("/developer-products/7/")) return new Response("x".repeat(100_000), { status: 200 });
			return Response.json({ data: [{ targetId: 9, state: "Completed", imageUrl: "https://evil.example/icon.png" }] });
		}) as typeof fetch;
		const [nine, eight, seven] = await new RobloxProducts({ fetch: f }).get({ gamepass: [9], product: [8, 7] });
		expect(nine).toEqual({ type: "gamepass", id: 9, status: "ok", name: "Nine", price: null, forSale: null, icon: null });
		expect(eight?.status).toBe("unavailable");
		expect(seven?.status).toBe("unavailable");
	});

	test("concurrent callers share one lookup", async () => {
		let n = 0;
		const f = (async (input: string | URL | Request) => {
			n++;
			return String(input).includes("thumbnails") ? Response.json({ data: [] }) : Response.json({ TargetId: 3, Name: "Three", PriceInRobux: 5 });
		}) as typeof fetch;
		const p = new RobloxProducts({ fetch: f });
		await Promise.all([p.get({ gamepass: [3], product: [] }), p.get({ gamepass: [3], product: [] }), p.get({ gamepass: [3], product: [] })]);
		expect(n).toBe(2);
	});

	test("calls past the cap answer unavailable and are not cached", async () => {
		let n = 0;
		let now = 1_000_000;
		const f = (async (input: string | URL | Request) => {
			n++;
			const id = Number(/game-passes\/(\d+)\//.exec(String(input))?.[1]);
			return String(input).includes("thumbnails") ? Response.json({ data: [] }) : Response.json({ TargetId: id, Name: `P${id}`, PriceInRobux: 1 });
		}) as typeof fetch;
		const p = new RobloxProducts({ fetch: f, perMinute: 3, clock: () => now });
		const first = await p.get({ gamepass: [1, 2, 3, 4], product: [] });
		expect(first.map((i) => i.status)).toEqual(["ok", "ok", "ok", "unavailable"]);
		expect(p.peek("gamepass", 4)).toBeUndefined();
		now += 60_000;
		expect((await p.get({ gamepass: [4], product: [] }))[0]?.name).toBe("P4");
		expect(n).toBeLessThanOrEqual(5);
	});
});
