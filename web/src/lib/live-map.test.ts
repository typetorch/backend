/** Plans/34: the live map's data path (lib/live-map.ts): the map from a position, interpolation, trails, layers. */
import { describe, expect, it } from "vitest";
import { colorFor, latestValue, liveLayers, mapCounts, mapForPosition, mergeFrames, nearestDot, playersAt, pointLayers, renderTime, trails, TRAIL_MS } from "./live-map";
import type { MapInfo } from "./maps";
import type { LivePlayer, StreamFrame } from "./types";

const map = (name: string, kind: "map" | "lobby", min: [number, number, number], max: [number, number, number], offset: [number, number, number] = [0, 0, 0]): MapInfo => ({
	name,
	kind,
	via: kind === "lobby" ? "lobby" : "name",
	path: `Workspace.${name}`,
	parts: 1,
	meshes: 0,
	unions: 0,
	invisible: 0,
	bounds: { min, max },
	hash: name,
	bytes: 1,
	alternatives: [],
	offset,
	alignment: { state: "unknown", samples: 0, inside: 0 },
});

const LOBBY = map("Lobby", "lobby", [-100, 0, -100], [100, 50, 100]);
const MAZE = map("HedgeMaze", "map", [1000, 0, 0], [1200, 30, 200]);
const INNER = map("Inner", "map", [1050, 0, 50], [1100, 30, 100]);
const SHIFTED = map("Shifted", "map", [0, 0, 0], [50, 10, 50], [3000, 0, 0]);
const MAPS = [LOBBY, MAZE, INNER, SHIFTED];

const frame = (t: number, players: LivePlayer[]): StreamFrame => ({ t, s: { positions: { players } } });
const at = (u: number, x: number, z: number, extra: Partial<LivePlayer> = {}): LivePlayer => ({ u, n: `P${u}`, x, y: 5, z, st: "alive", ...extra });

describe("which map a position is on", () => {
	it("a round map's bounds plus 8 studs, the smallest that fits, the offset applied; else the lobby", () => {
		expect(mapForPosition(MAPS, 1150, 150)?.name).toBe("HedgeMaze");
		expect(mapForPosition(MAPS, 1206, 150)?.name).toBe("HedgeMaze");
		expect(mapForPosition(MAPS, 1075, 75)?.name).toBe("Inner");
		expect(mapForPosition(MAPS, 3025, 25)?.name).toBe("Shifted");
		expect(mapForPosition(MAPS, 25, 25)?.name).toBe("Lobby");
		expect(mapForPosition(MAPS, 99_999, 0)?.name).toBe("Lobby");
		expect(mapForPosition([MAZE], 0, 0)).toBeNull();
	});

	it("the map most players are on", () => {
		const { counts, top } = mapCounts(MAPS, [
			{ x: 1150, z: 150 },
			{ x: 1160, z: 150 },
			{ x: 0, z: 0 },
		]);
		expect(top).toBe("HedgeMaze");
		expect(counts.get("Lobby")).toBe(1);
	});
});

describe("moving between frames", () => {
	const frames = [frame(1000, [at(1, 0, 0, { yaw: 3 }), at(2, 50, 50)]), frame(1500, [at(1, 10, 20, { yaw: -3 }), at(3, 7, 7)])];

	it("interpolates between the frame before and after, the angle the short way round", () => {
		const mid = playersAt(frames, 1250);
		const p1 = mid.find((p) => p.u === 1);
		expect(p1?.x).toBeCloseTo(5);
		expect(p1?.z).toBeCloseTo(10);
		// 3 -> -3 rad goes through pi, not through 0.
		expect(Math.abs(p1?.yaw ?? 0)).toBeGreaterThan(3);
		// Gone in the next frame: not drawn; new in it: at its own spot.
		expect(mid.map((p) => p.u).sort()).toEqual([1, 3]);
		expect(mid.find((p) => p.u === 3)).toMatchObject({ x: 7, z: 7 });
	});

	it("before the first frame the first, past the newest the newest", () => {
		expect(playersAt(frames, 0).find((p) => p.u === 2)).toMatchObject({ x: 50 });
		expect(playersAt(frames, 9999).find((p) => p.u === 1)).toMatchObject({ x: 10, z: 20 });
		expect(playersAt([], 0)).toEqual([]);
	});

	it("draws a delay behind the newest frame, moving on with time, never past it", () => {
		expect(renderTime(5000, 0, 1000)).toBe(4000);
		expect(renderTime(5000, 400, 1000)).toBe(4400);
		expect(renderTime(5000, 3000, 1000)).toBe(5000);
	});

	it("a player without a character keeps no position", () => {
		const none = playersAt([frame(0, [at(1, 0, 0)]), frame(500, [{ u: 1, n: "P1", st: "none" }])], 400);
		expect(none[0]?.st).toBe("none");
	});
});

describe("trails", () => {
	it("the last 20 s up to now, split at a teleport", () => {
		const frames = [frame(0, [at(1, 0, 0)]), frame(TRAIL_MS + 1000, [at(1, 1, 0)]), frame(TRAIL_MS + 1500, [at(1, 2, 0)]), frame(TRAIL_MS + 2000, [at(1, 500, 0)])];
		const now = playersAt(frames, TRAIL_MS + 2500);
		const t = trails(frames, TRAIL_MS + 2500, now).get(1) ?? [];
		// The frame at 0 is older than 20 s; the jump to 500 starts a new piece (with the current point: 2 points).
		expect(t.map((p) => p.map((q) => q.x))).toEqual([[1, 2], [500, 500]]);
	});
});

describe("layers", () => {
	it("trails under the dots, the followed one bigger, then markers", () => {
		const dots = [
			{ key: "1", name: "A", x: 0, y: 0, z: 0, color: "#111111", trail: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]] },
			{ key: "2", name: "B", x: 5, y: 0, z: 5, color: "#222222" },
		];
		const layers = liveLayers(dots, [{ id: "marker:x", label: "M", color: "#fff", points: [] }], "2");
		expect(layers.map((l) => l.id)).toEqual(["trail:1", "dot:1", "dot:2", "marker:x"]);
		expect(layers.find((l) => l.id === "dot:2")?.pointSize).toBeGreaterThan(layers.find((l) => l.id === "dot:1")?.pointSize ?? 0);
		expect(nearestDot(dots, 4, 4)?.name).toBe("B");
		expect(nearestDot(dots, 100, 100)).toBeNull();
	});

	it("a points stream: a layer per color, bad points left out", () => {
		const layers = pointLayers("game.spawns", "Spawns", { points: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6, color: "#ff0000" }, { x: "no" }] }, "#00ff00");
		expect(layers.map((l) => [l.color, l.points?.length])).toEqual([
			["#00ff00", 1],
			["#ff0000", 1],
		]);
		expect(pointLayers("game.x", "X", { nope: 1 }, "#000")).toEqual([]);
	});

	it("colors are stable per key", () => {
		expect(colorFor(42)).toBe(colorFor("42"));
	});
});

describe("frames", () => {
	it("merged by time, the last 120 s kept, the latest value of a stream found", () => {
		const held = [frame(0, []), { t: 1000, s: { "game.score": 1 } }];
		const merged = mergeFrames(held, [{ t: 1000, s: { "game.other": 2 } }, frame(200_000, [])]);
		expect(merged.map((f) => f.t)).toEqual([200_000]);
		const kept = mergeFrames(held, [{ t: 1000, s: { "game.other": 2 } }]);
		expect(kept[1]?.s).toEqual({ "game.score": 1, "game.other": 2 });
		expect(latestValue(kept, "game.score")).toEqual({ t: 1000, value: 1 });
		expect(latestValue(kept, "nope")).toBeUndefined();
	});
});
