/**
 * The real-map helpers: the draw rule (which parts each toggle shows, with HedgeMaze-like parts), the export for a
 * recordings map name, recording cells to world studs (heights from the cells, else the floor under them), and the
 * alignment check from recording samples (gnome's HedgeMaze: recordings frame x 636..1008, z -164..164).
 */
import { describe, expect, test } from "vitest";
import {
	alignmentOf,
	cellToWorld,
	countKinds,
	decodeGeometry,
	DEFAULT_TOGGLES,
	drawnCount,
	exportFor,
	FLAGS,
	floorUnder,
	isDrawn,
	partKind,
	recordingLayer,
	recordingSamples,
	worldToCell,
	type MapInfo,
} from "./maps";
import { ttmp } from "./maps.fixture";

const C = FLAGS.collide;
const INV = FLAGS.invisible;

/** A small HedgeMaze: the floor, invisible colliding walls, hedge meshes that don't collide, markers, a lamp. */
const hedgeMaze = () =>
	decodeGeometry(
		ttmp([
			{ pos: [800, -1, 0], size: [396, 2, 396], flags: C },
			{ pos: [700, 10, 0], size: [2, 20, 100], flags: C | INV, t: 1 },
			{ pos: [900, 9, 0], size: [2, 18, 100], flags: C | INV, t: 1 },
			{ pos: [720, 10, 70], size: [154, 20, 154], flags: FLAGS.mesh },
			{ pos: [880, 10, 70], size: [154, 20, 154], flags: FLAGS.mesh },
			{ pos: [800, 0, 0], size: [8, 0.05, 8], flags: INV, t: 1 },
			{ pos: [810, 0, 0], size: [8, 0.05, 8], flags: INV | FLAGS.mesh, t: 1 },
			{ pos: [790, 2, 5], size: [1, 4, 1], flags: 0 },
			{ pos: [790, 2, 9], size: [6, 6, 6], flags: FLAGS.union | C },
		]),
	);

describe("the draw rule", () => {
	test("kinds: what collides, small decoration, decorative meshes, markers", () => {
		expect(partKind(C)).toBe("collide");
		expect(partKind(C | INV)).toBe("collide");
		expect(partKind(C | FLAGS.mesh)).toBe("collide");
		expect(partKind(FLAGS.mesh)).toBe("decorMesh");
		expect(partKind(FLAGS.union)).toBe("decorMesh");
		expect(partKind(INV)).toBe("marker");
		expect(partKind(INV | FLAGS.mesh)).toBe("marker");
		expect(partKind(0)).toBe("decor");
		expect(partKind(FLAGS.truss)).toBe("decor");
	});

	test("by default: the floor, the invisible walls, a colliding union and the lamp; never the hedge meshes or markers", () => {
		const g = hedgeMaze();
		const drawn = (toggles = DEFAULT_TOGGLES) => [...g.flags].map((f, i) => (isDrawn(f, toggles) ? i : -1)).filter((i) => i >= 0);
		expect(drawn()).toEqual([0, 1, 2, 7, 8]);
		expect(drawn({ decorative: true, markers: false })).toEqual([0, 1, 2, 3, 4, 7, 8]);
		expect(drawn({ decorative: false, markers: true })).toEqual([0, 1, 2, 5, 6, 7, 8]);
		expect(drawnCount(g, { decorative: true, markers: true })).toBe(9);
		expect(countKinds(g)).toEqual({ collide: 4, collideInvisible: 2, decor: 1, decorMesh: 2, marker: 2 });
	});
});

const info = (over: Partial<MapInfo>): MapInfo => ({
	name: "HedgeMaze",
	kind: "map",
	via: "name",
	path: "ReplicatedStorage.assets.maps.HedgeMaze",
	parts: 581,
	meshes: 14,
	unions: 0,
	invisible: 546,
	bounds: { min: [641, -2, -157], max: [998, 58, 157] },
	hash: "a".repeat(64),
	bytes: 1,
	alternatives: [],
	offset: [0, 0, 0],
	alignment: { state: "unknown", samples: 0, inside: 0 },
	...over,
});

describe("names and cells", () => {
	test("the export for a recordings map name: no case or punctuation; no map = the lobby", () => {
		const maps = [info({}), info({ name: "parking_garage" }), info({ name: "(lobby)", kind: "lobby", via: "lobby" })];
		expect(exportFor(maps, "hedgemaze")?.name).toBe("HedgeMaze");
		expect(exportFor(maps, "ParkingGarage")?.name).toBe("parking_garage");
		expect(exportFor(maps, "(lobby / unknown)")?.name).toBe("(lobby)");
		expect(exportFor(maps, "Mall")).toBeNull();
		expect(exportFor(maps, null)).toBeNull();
		expect(exportFor(undefined, "HedgeMaze")).toBeNull();
	});

	test("cell index <-> world studs from the frame's minX / minZ and cell size", () => {
		const frame = { minX: 636, minZ: -164, cell: 2, cols: 186, rows: 164 };
		expect(cellToWorld(frame, 0, 0)).toEqual({ x: 636, z: -164 });
		expect(cellToWorld(frame, 10, 3)).toEqual({ x: 656, z: -158 });
		// A layer at its own (coarser) cell, same origin.
		expect(cellToWorld(frame, 10, 3, 4)).toEqual({ x: 676, z: -152 });
		expect(worldToCell(frame, 657.9, -156.1)).toEqual([10, 3]);
		expect(worldToCell(frame, 600, 0)).toBeNull();
		expect(worldToCell(frame, 636 + 186 * 2, 0)).toBeNull();
	});

	test("a recording layer in the world: the cells' own heights, else the floor under the cell (+ the root height)", () => {
		const g = hedgeMaze();
		const frame = { minX: 636, minZ: -164, cell: 2 };
		const layer = recordingLayer(
			{ id: "path", label: "Positions", color: "#3b82f6", cells: [[82, 82, 5, 3.2], [82, 83, 1]] },
			frame,
			(x, z) => floorUnder(g, x, z),
		);
		expect(layer.cellSize).toBe(2);
		expect(layer.cells).toEqual([
			{ x: 800, z: 0, y: 3.2, n: 5 },
			// No height in the cell: the floor slab's top (0) + 3.
			{ x: 800, z: 2, y: 3, n: 1 },
		]);
		expect(layer.points?.[0]).toEqual({ x: 801, y: 3.2, z: 1 });
		// Positioned events at 4-stud cells on a 2-stud frame.
		const events = recordingLayer({ id: "ev:custom:down", label: "down", color: "#f00", cells: [[41, 41, 2]], cell: 4 }, frame);
		expect(events.cells).toEqual([{ x: 800, z: 0, y: null, n: 2 }]);
		expect(events.cellSize).toBe(4);
	});

	test("the floor under a spot: the lowest colliding top there (walls are taller), none off the map", () => {
		const g = hedgeMaze();
		expect(floorUnder(g, 800, 0)).toBeCloseTo(0, 5);
		expect(floorUnder(g, 700, 0)).toBeCloseTo(0, 5);
		expect(floorUnder(g, 700, 0, [0, 0, 0], [5, 30])).toBeCloseTo(20, 5);
		expect(floorUnder(g, 5000, 0)).toBeNull();
		expect(floorUnder(g, 1800, 0, [1000, 2, 0])).toBeCloseTo(2, 5);
	});
});

describe("alignment from recording samples", () => {
	test("gnome's HedgeMaze recordings (frame x 636..1008, z -164..164) are aligned with its export", () => {
		const frame = { minX: 636, minZ: -164, cell: 4 };
		// Samples over the whole recordings frame (93 x 82 cells), denser in the middle.
		const cells: [number, number, number][] = [];
		for (let c = 0; c < 93; c++) for (let r = 0; r < 82; r++) cells.push([c, r, c > 5 && c < 85 && r > 4 && r < 78 ? 20 : 1]);
		const a = alignmentOf(info({}).bounds, recordingSamples(frame, cells));
		expect(a.state).toBe("aligned");
		expect(a.inside).toBeGreaterThan(0.95);
		expect(a.samples).toBe(cells.reduce((s, c) => s + c[2], 0));
	});

	test("samples elsewhere: off, with the offset that moves the map onto them; too few: unknown", () => {
		const samples = [{ x: 1500, z: 0, n: 30 }];
		const a = alignmentOf(info({}).bounds, samples);
		expect(a.state).toBe("off");
		expect(a.suggestedOffset).toEqual([1500 - 819.5, 0, 0]);
		// With the suggested offset applied, the samples sit inside.
		expect(alignmentOf(info({}).bounds, samples, a.suggestedOffset).state).toBe("aligned");
		expect(alignmentOf(info({}).bounds, [{ x: 800, z: 0, n: 3 }]).state).toBe("unknown");
		expect(alignmentOf(null, samples).state).toBe("unknown");
	});

	test("partly inside: partial", () => {
		expect(alignmentOf(info({}).bounds, [{ x: 800, z: 0, n: 30 }, { x: 5000, z: 0, n: 70 }])).toMatchObject({ state: "partial", inside: 0.3 });
	});
});
