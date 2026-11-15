/** The map view in the URL (lib/map-view.ts): read, write, and the Y band across maps. */
import { describe, expect, test } from "vitest";
import { bandFits, followBand, mapViewPatch, readBand, readMapView, resolveBand } from "./map-view";

const floors = [
	{ y: 0, band: [-2, 14] as [number, number], area: 1000 },
	{ y: 16, band: [14, 46] as [number, number], area: 900 },
];

describe("the map view in the URL", () => {
	test("defaults: 2D, heat, the page's cell, every height, no decorative meshes or markers", () => {
		expect(readMapView(new URLSearchParams(""))).toEqual({ mode: "2d", draw: "heat", cell: null, band: { kind: "all" }, decorative: false, markers: false, hidden: [] });
	});

	test("reads every key; the Recordings page's old view=dots is points; bad values fall back", () => {
		const s = readMapView(new URLSearchParams("mode=3d&draw=points&cell=0.5&band=f2&decor=1&markers=1&hide=ev:custom:down,ev:custom:loot"));
		expect(s).toEqual({ mode: "3d", draw: "points", cell: 0.5, band: { kind: "floor", index: 1 }, decorative: true, markers: true, hidden: ["ev:custom:down", "ev:custom:loot"] });
		expect(readMapView(new URLSearchParams("view=dots")).draw).toBe("points");
		expect(readMapView(new URLSearchParams("cell=3&mode=4d")).cell).toBeNull();
		expect(readBand("10..40")).toEqual({ kind: "range", lo: 10, hi: 40 });
		expect(readBand("-2.5..14")).toEqual({ kind: "range", lo: -2.5, hi: 14 });
		expect(readBand("40..10")).toEqual({ kind: "all" });
		expect(readBand("f0")).toEqual({ kind: "all" });
		expect(readBand("junk")).toEqual({ kind: "all" });
	});

	test("writes only what differs from the default, and round-trips", () => {
		expect(mapViewPatch({ mode: "2d", draw: "heat", cell: null, band: { kind: "all" }, decorative: false, markers: false, hidden: [] })).toEqual({
			mode: null,
			draw: null,
			view: null,
			cell: null,
			band: null,
			decor: null,
			markers: null,
			hide: null,
		});
		const patch = mapViewPatch({ mode: "3d", draw: "points", cell: 2, band: { kind: "range", lo: 3, hi: 9 }, decorative: true, hidden: ["a"] });
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(patch)) if (v) params.set(k, v);
		expect(readMapView(params)).toMatchObject({ mode: "3d", draw: "points", cell: 2, band: { kind: "range", lo: 3, hi: 9 }, decorative: true, hidden: ["a"] });
	});

	test("the band on a map: its own floor N, a free range only when it fits, else all", () => {
		expect(resolveBand({ kind: "all" }, floors, -2, 60)).toBeNull();
		expect(resolveBand({ kind: "floor", index: 1 }, floors, -2, 60)).toEqual([14, 46]);
		// One floor (or the geometry still loading): every height.
		expect(resolveBand({ kind: "floor", index: 1 }, floors.slice(0, 1), -2, 60)).toBeNull();
		expect(resolveBand({ kind: "floor", index: 4 }, floors, -2, 60)).toBeNull();
		expect(resolveBand({ kind: "range", lo: 0, hi: 30 }, floors, -2, 60)).toEqual([0, 30]);
		expect(resolveBand({ kind: "range", lo: 0, hi: 90 }, floors, -2, 60)).toBeNull();
		expect(bandFits({ lo: 0, hi: 30 }, -21, 26)).toBe(false);
	});

	test("following the player: band=player, the map's bottom to 9 studs over their feet; unknown feet = all", () => {
		expect(readBand("player")).toEqual({ kind: "player" });
		expect(mapViewPatch({ band: { kind: "player" } }).band).toBe("player");
		expect(followBand(16, -2)).toEqual([-2, 25]);
		expect(followBand(-10, -2)).toEqual([-11, -1]);
		expect(resolveBand({ kind: "player" }, floors, -2, 60, 16)).toEqual([-2, 25]);
		expect(resolveBand({ kind: "player" }, floors, -2, 60, null)).toBeNull();
		expect(resolveBand({ kind: "player" }, floors, -2, 60)).toBeNull();
	});
});
