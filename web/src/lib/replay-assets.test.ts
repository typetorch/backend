/**
 * The replay's images and clips from other branches' endpoints: GET /api/v1/images/<id> (200 PNG, 202 pending: retried,
 * 404 unknown) and GET /api/v1/anims/<id> (200 clip JSON, 404 until exported).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAnimClips, loadClip, parseClip } from "./anim-clips";
import { assetIdOf, clearAssetImages, loadAssetImage, PENDING_RETRIES } from "./asset-images";

afterEach(() => {
	clearAssetImages();
	clearAnimClips();
});

const png = () => new Response(new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" }), { status: 200 });

describe("asset images", () => {
	it("asset ids from Image / template strings; engine content has none", () => {
		expect(assetIdOf("rbxassetid://123")).toBe("123");
		expect(assetIdOf("http://www.roblox.com/asset/?id=456")).toBe("456");
		expect(assetIdOf("https://www.roblox.com/asset/?version=1&id=789")).toBe("789");
		expect(assetIdOf("42")).toBe("42");
		expect(assetIdOf("rbxasset://textures/ui/x.png")).toBeNull();
		expect(assetIdOf("rbxthumb://type=Asset&id=1&w=150&h=150")).toBeNull();
		expect(assetIdOf("")).toBeNull();
	});
	it("200: ready (an object URL), fetched once", async () => {
		const fetch = vi.fn(async () => png());
		const a = await loadAssetImage("1", { fetch });
		expect(a.state).toBe("ready");
		expect(await loadAssetImage("1", { fetch })).toBe(a);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/images/1");
	});
	it("202 then 200: retried until ready; 202 forever: pending; 404: missing", async () => {
		const answers = [202, 202, 200];
		const fetch = vi.fn(async () => {
			const status = answers.shift() ?? 200;
			return status === 200 ? png() : new Response(null, { status });
		});
		const wait = vi.fn(async () => undefined);
		expect((await loadAssetImage("2", { fetch, wait })).state).toBe("ready");
		expect(wait).toHaveBeenCalledTimes(2);
		const always = vi.fn(async () => new Response(null, { status: 202 }));
		expect((await loadAssetImage("3", { fetch: always, wait })).state).toBe("pending");
		expect(always).toHaveBeenCalledTimes(PENDING_RETRIES + 1);
		expect((await loadAssetImage("4", { fetch: async () => new Response("no", { status: 404 }) })).state).toBe("missing");
		expect((await loadAssetImage("5", { fetch: async () => Promise.reject(new Error("offline")) })).state).toBe("missing");
	});
});

describe("animation clips", () => {
	it("parses the endpoint's JSON, keeping only well-formed keyframes and joints", () => {
		const clip = parseClip({ id: "9", length: 1.5, looped: true, priority: 2, keyframes: [{ t: 1, poses: { Neck: [0, 0, 0, 1], Bad: [1, 2] } }, { t: 0, poses: {} }, { t: "x" }] }, "9");
		expect(clip).toEqual({ id: "9", length: 1.5, looped: true, priority: 2, keyframes: [{ t: 0, poses: {} }, { t: 1, poses: { Neck: [0, 0, 0, 1] } }] });
		expect(parseClip({ keyframes: "no" }, "9")).toBeNull();
		expect(parseClip(null, "9")).toBeNull();
	});
	it("200: the clip; 404: null, asked again only after a minute", async () => {
		const ok = vi.fn(async () => new Response(JSON.stringify({ id: "1", length: 1, looped: false, keyframes: [{ t: 0, poses: { Neck: [0, 0, 0, 1] } }] }), { status: 200 }));
		expect((await loadClip("1", { fetch: ok }))?.keyframes).toHaveLength(1);
		expect(ok.mock.calls[0]?.[0]).toBe("/api/v1/anims/1");
		let now = 0;
		const missing = vi.fn(async () => new Response("{}", { status: 404 }));
		expect(await loadClip("2", { fetch: missing, now: () => now })).toBeNull();
		expect(await loadClip("2", { fetch: missing, now: () => now })).toBeNull();
		expect(missing).toHaveBeenCalledTimes(1);
		now = 61_000;
		await loadClip("2", { fetch: missing, now: () => now });
		expect(missing).toHaveBeenCalledTimes(2);
	});
});
