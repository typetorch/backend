/**
 * Textures on the maps (plans/36 phase 5), the pure parts: TTMP version 1 and 2 decoding, the texture section, where a
 * Decal / Texture quad goes on its face, the tiling, grouping by image (one draw call per image), the MaterialVariant
 * per part, and the image loader's answers (200 / 202 / 404) and retries. No WebGL, every id made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttmp, textureSection } from "./maps.fixture";
import { decodeGeometry, FLAGS } from "./maps";
import { assetIdOf, decodeTextures, faceFrame, fetchImage, groupSurfaces, ImageLoader, partVariant, RETRY_MS, surfacePlacement, surfaceUv } from "./map-textures";

const TOGGLES = { decorative: false, markers: false };

/** A 4 x 2 x 6 block at (10, 1, -5), a mesh, a wedge, a ball. */
const PARTS = [
	{ pos: [10, 1, -5] as [number, number, number], size: [4, 2, 6] as [number, number, number] },
	{ pos: [0, 0, 0] as [number, number, number], size: [2, 2, 2] as [number, number, number], flags: FLAGS.mesh },
	{ pos: [0, 5, 0] as [number, number, number], size: [4, 2, 8] as [number, number, number], shape: 3 },
	{ pos: [0, 9, 0] as [number, number, number], size: [2, 2, 2] as [number, number, number], shape: 0 },
];

const SECTION = textureSection({
	surfaces: [
		{ part: 0, kind: 0, face: 5, image: "rbxassetid://111", transparency: 0.5, color: [255, 0, 0] },
		{ part: 0, kind: 1, face: 1, image: "rbxassetid://222", tile: [2, 3, 1, 0] },
		{ part: 1, kind: 0, face: 5, image: "rbxassetid://111" },
		{ part: 2, kind: 0, face: 1, image: "http://www.roblox.com/asset/?id=111" },
		{ part: 3, kind: 0, face: 1, image: "rbxassetid://333" },
		{ part: 0, kind: 0, face: 0, image: "rbxasset://textures/builtin.png" },
		{ part: 0, kind: 0, face: 3, image: "rbxassetid://444", transparency: 1 },
	],
	variants: [
		{ name: "Asphalt", colorMap: "rbxassetid://555", studsPerTile: 8 },
		{ name: "NoMap" },
	],
	variantParts: [
		[0, 0],
		[2, 1],
	],
});

describe("TTMP versions", () => {
	it("version 1: parts, no textures; version 2: the section after the records", () => {
		const v1 = decodeGeometry(ttmp(PARTS));
		expect(v1.count).toBe(4);
		expect(v1.textures).toBeNull();
		const v2 = decodeGeometry(ttmp(PARTS, SECTION));
		expect(v2.count).toBe(4);
		expect(Array.from(v2.position.subarray(0, 3))).toEqual([10, 1, -5]);
		const t = v2.textures;
		expect(t).not.toBeNull();
		// The built-in content surface has no asset id: left out.
		expect(t?.surfaces.map((s) => s.image)).toEqual(["111", "222", "111", "111", "333", "444"]);
		expect(t?.variants).toEqual([
			{ name: "Asphalt", image: "555", baseMaterial: 816, studsPerTile: 8 },
			{ name: "NoMap", image: null, baseMaterial: 816, studsPerTile: 4 },
		]);
		expect(Array.from(t?.variantOf ?? [])).toEqual([0, -1, 1, -1]);
	});

	it("a cut texture section is refused as a whole map; a bad one inside a good frame leaves the parts plain", () => {
		const good = ttmp(PARTS, SECTION);
		expect(() => decodeGeometry(good.subarray(0, good.byteLength - 1))).toThrow("cut short");
		const bad = SECTION.slice();
		bad[bad.byteLength - 2] = 9; // the last variant part's variant -> out of range
		const g = decodeGeometry(ttmp(PARTS, bad));
		expect(g.count).toBe(4);
		expect(g.textures).toBeNull();
		expect(() => decodeTextures(bad, 4)).toThrow("out of range");
		expect(() => decodeGeometry(Object.assign(ttmp(PARTS), { 4: 3 }))).toThrow("version 3");
	});

	it("asset ids from Content strings", () => {
		expect(assetIdOf("rbxassetid://123")).toBe("123");
		expect(assetIdOf("https://www.roblox.com/asset/?id=45")).toBe("45");
		expect(assetIdOf("rbxasset://textures/x.png")).toBeNull();
		expect(assetIdOf("https://evil.test/asset/?id=1")).toBeNull();
	});
});

describe("surfaces on faces", () => {
	const g = decodeGeometry(ttmp(PARTS, SECTION));

	it("a block's Front face: centred on -Z, facing -Z, the image upright, its size in studs", () => {
		const p = surfacePlacement(g, 0, 5, 0);
		expect(p).not.toBeNull();
		if (!p) return;
		expect(p.width).toBeCloseTo(4);
		expect(p.height).toBeCloseTo(2);
		const m = p.matrix;
		// u = -X * 4, v = +Y * 2, n = -Z, position = the face centre lifted along n.
		expect([m[0], m[1], m[2]].map((x) => Math.round(x as number))).toEqual([-4, 0, 0]);
		expect([m[4], m[5], m[6]].map((x) => Math.round(x as number))).toEqual([0, 2, 0]);
		expect([m[8], m[9], m[10]].map((x) => Math.round(x as number))).toEqual([0, 0, -1]);
		expect(m[12]).toBeCloseTo(10);
		expect(m[13]).toBeCloseTo(1);
		expect(m[14]).toBeLessThan(-8);
		expect(m[14]).toBeGreaterThan(-8.1);
	});

	it("every block face points out of the part (u x v = the outward normal)", () => {
		const outward = [
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
			[-1, 0, 0],
			[0, -1, 0],
			[0, 0, -1],
		];
		for (let face = 0; face < 6; face++) {
			const f = faceFrame(1, face);
			expect(f).not.toBeNull();
			if (!f) continue;
			const n = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]];
			expect(n.map((x) => x + 0)).toEqual(outward[face]);
			// the centre is on the face's side
			expect(f.c.map((x) => Math.sign(x) + 0)).toEqual(outward[face]);
		}
	});

	it("shapes: a wedge's Top is its slope, its triangles and a ball's faces are skipped", () => {
		expect(faceFrame(3, 1)?.v).toEqual([0, -1, -1]);
		expect(faceFrame(3, 0)).toBeNull();
		expect(faceFrame(3, 5)).toBeNull();
		expect(faceFrame(0, 1)).toBeNull();
		expect(faceFrame(2, 1)).toBeNull();
		expect(faceFrame(4, 4)).not.toBeNull();
		const slope = surfacePlacement(g, 2, 1);
		expect(slope?.width).toBeCloseTo(4);
		expect(slope?.height).toBeCloseTo(Math.hypot(2, 8));
	});

	it("tiling: a Decal stretches once; a Texture repeats every StudsPerTile from its offset", () => {
		expect(surfaceUv({ kind: 0, tile: [0, 0, 0, 0] }, 4, 6)).toEqual([1, 1, 0, 0]);
		expect(surfaceUv({ kind: 1, tile: [2, 3, 1, 0] }, 4, 6)).toEqual([2, 2, 0.5, 0]);
		// No StudsPerTile: once over the face.
		expect(surfaceUv({ kind: 1, tile: [0, 0, 0, 0] }, 4, 6)).toEqual([1, 1, 0, 0]);
		expect(surfaceUv({ kind: 1, tile: [0.02, 0.02, 0, 0] }, 400, 400)[0]).toBe(1024);
	});

	it("grouping: one group per image; meshes only when drawn, invisible surfaces and odd faces left out", () => {
		const groups = groupSurfaces(g, g.textures as NonNullable<typeof g.textures>, TOGGLES);
		const byImage = Object.fromEntries(groups.map((x) => [x.image, x.count]));
		// 111: the block's front + the wedge's slope (the mesh is off by default); 222 the block's top; 333 on a ball: none; 444 transparent: none.
		expect(byImage).toEqual({ "111": 2, "222": 1 });
		const g111 = groups.find((x) => x.image === "111");
		expect(g111?.matrices.length).toBe(32);
		expect(Array.from(g111?.tint.subarray(0, 4) ?? []).map((x) => Math.round(x * 100) / 100)).toEqual([1, 0, 0, 0.5]);
		expect(Array.from(groups.find((x) => x.image === "222")?.uv ?? [])).toEqual([2, 2, 0.5, 0]);
		const withMeshes = groupSurfaces(g, g.textures as NonNullable<typeof g.textures>, { decorative: true, markers: false });
		expect(withMeshes.find((x) => x.image === "111")?.count).toBe(3);
	});

	it("a part's variant: only with a color map", () => {
		expect(partVariant(g.textures, 0)).toBe(0);
		expect(partVariant(g.textures, 2)).toBe(-1);
		expect(partVariant(g.textures, 1)).toBe(-1);
		expect(partVariant(null, 0)).toBe(-1);
	});
});

describe("loading images", () => {
	const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
	const answer = (status: number) => (status === 200 ? new Response(png, { status, headers: { "content-type": "image/png" } }) : Response.json({ state: status === 202 ? "pending" : "blocked" }, { status }));

	it("200 is ready, 202 / 429 / 5xx / no answer pending, 404 none", async () => {
		expect((await fetchImage("1", async () => answer(200))).state).toBe("ready");
		expect(await fetchImage("1", async () => answer(202))).toEqual({ state: "pending" });
		expect(await fetchImage("1", async () => answer(503))).toEqual({ state: "pending" });
		expect(await fetchImage("1", async () => answer(404))).toEqual({ state: "none" });
		expect(
			await fetchImage("1", async () => {
				throw new TypeError("offline");
			}),
		).toEqual({ state: "pending" });
		const urls: string[] = [];
		await fetchImage("77", async (url) => {
			urls.push(String(url));
			return answer(404);
		});
		expect(urls).toEqual(["/api/v1/images/77"]);
	});

	describe("the loader", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("asks once per id, retries a pending one with a backoff, drops a missing one, stops on dispose", async () => {
			const calls: string[] = [];
			const states: Record<string, number[]> = { "10": [202, 200], "20": [404], "30": [202, 202, 202, 202, 202, 202, 202, 202] };
			const ready: string[] = [];
			const loader = new ImageLoader(
				(id) => ready.push(id),
				async (url) => {
					const id = String(url).split("/").pop() as string;
					calls.push(id);
					return answer(states[id]?.shift() ?? 404);
				},
			);
			loader.want(["10", "20", "30", "10", "not-an-id"]);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.sort()).toEqual(["10", "20", "30"]);
			expect(ready).toEqual([]);
			await vi.advanceTimersByTimeAsync((RETRY_MS[0] as number) + 10);
			expect(ready).toEqual(["10"]);
			expect(calls.filter((c) => c === "20").length).toBe(1);
			// 30 stays pending: tried once per backoff step, then given up.
			await vi.advanceTimersByTimeAsync(RETRY_MS.reduce((a, b) => a + b, 0) + 1000);
			expect(calls.filter((c) => c === "30").length).toBe(RETRY_MS.length + 1);
			loader.dispose();
			loader.want(["40"]);
			await vi.advanceTimersByTimeAsync(1000);
			expect(calls).not.toContain("40");
		});
	});
});
