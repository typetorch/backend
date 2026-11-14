/** The Maps page's helpers: the TTMP decoder (against a writer here), floors from walkable tops, event layers, heat colors. */
import { describe, expect, test } from "vitest";
import { decodeGeometry, detectFloors, eventLayers, FLAGS, halfHeight, heatColor, partsText, type MapPositionsResult } from "./maps";
import { ttmp } from "./maps.fixture";

describe("decodeGeometry", () => {
	test("reads every field into flat arrays", () => {
		const g = decodeGeometry(ttmp([{ pos: [1, 2, 3], size: [4, 5, 6], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], flags: FLAGS.mesh | FLAGS.invisible, shape: 3, t: 1 }]));
		expect(g.count).toBe(1);
		expect([...g.position]).toEqual([1, 2, 3]);
		expect([...g.size]).toEqual([4, 5, 6]);
		expect(g.rotation[1]).toBeCloseTo(Math.SQRT1_2, 6);
		expect([...g.color]).toEqual([10, 20, 30]);
		expect(g.transparency[0]).toBe(255);
		expect(g.material[0]).toBe(256);
		expect(g.shape[0]).toBe(3);
		expect(g.flags[0]).toBe(FLAGS.mesh | FLAGS.invisible);
	});

	test("refuses anything that isn't a whole TTMP", () => {
		expect(() => decodeGeometry(new Uint8Array(8))).toThrow("TTMP");
		const good = ttmp([{ pos: [0, 0, 0], size: [1, 1, 1] }]);
		expect(() => decodeGeometry(good.subarray(0, good.byteLength - 1))).toThrow("cut short");
	});

	test("half height follows the rotation (a part tipped on its side)", () => {
		const g = decodeGeometry(ttmp([{ pos: [0, 0, 0], size: [10, 2, 4], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }]));
		expect(halfHeight(g, 0)).toBeCloseTo(5, 4);
	});
});

describe("detectFloors", () => {
	test("two storeys of slabs make two floors with bands between them; walls and small parts don't count", () => {
		const g = decodeGeometry(
			ttmp([
				{ pos: [0, -0.5, 0], size: [100, 1, 100] },
				{ pos: [10, 0.2, 10], size: [20, 1, 20] },
				{ pos: [0, 15.5, 0], size: [60, 1, 60] },
				{ pos: [0, 8, 50], size: [100, 16, 1] },
				{ pos: [0, 30, 0], size: [2, 1, 2] },
				{ pos: [0, 40, 0], size: [100, 1, 100], flags: FLAGS.invisible },
			]),
		);
		const floors = detectFloors(g);
		expect(floors.map((f) => f.y)).toEqual([0, 16]);
		expect(floors[0]?.band).toEqual([-2, 14]);
		expect(floors[1]?.band).toEqual([14, 46]);
		expect(detectFloors(g, 100).map((f) => f.y)).toEqual([100, 116]);
	});
});

describe("layers", () => {
	const positions: MapPositionsResult = {
		mapKey: "map",
		cell: 2,
		names: [],
		truncated: false,
		cells: [
			{ map: "parking_garage", event: "custom:down", x: 1000, z: 998, y: 3, ylo: 3, n: 5 },
			{ map: "parking_garage", event: "custom:down", x: 1002, z: 998, y: 3, ylo: 3, n: 2 },
			{ map: "ParkingGarage", event: "custom:loot", x: 990, z: 990, y: 3, ylo: 2.5, n: 1 },
			{ map: "Mall", event: "custom:down", x: 0, z: 0, y: 3, ylo: 3, n: 50 },
		],
	};

	test("one layer per event on this map (any spelling of its name), busiest first", () => {
		const layers = eventLayers(positions, "Parking Garage");
		expect(layers.map((l) => [l.id, l.label, l.cells?.length, l.cellSize])).toEqual([
			["ev:custom:down", "down", 2, 2],
			["ev:custom:loot", "loot", 1, 2],
		]);
		expect(layers[1]?.cells?.[0]).toEqual({ x: 990, z: 990, y: 2.5, n: 1 });
		expect(layers[0]?.points?.[0]).toEqual({ x: 1001, y: 3, z: 999 });
		expect(layers[0]?.color).not.toBe(layers[1]?.color);
		expect(eventLayers(undefined, "Mall")).toEqual([]);
	});

	test("heat colors run cold to hot and clamp", () => {
		expect(heatColor(-1)).toEqual(heatColor(0));
		expect(heatColor(2)).toEqual(heatColor(1));
		expect(heatColor(1)[0]).toBeGreaterThan(heatColor(0)[0]);
	});

	test("parts text", () => {
		expect(partsText({ parts: 1038, meshes: 480, unions: 0, invisible: 3 })).toBe("1,038 parts (480 meshes, 3 invisible)");
		expect(partsText({ parts: 2, meshes: 0, unions: 0, invisible: 0 })).toBe("2 parts");
	});
});
