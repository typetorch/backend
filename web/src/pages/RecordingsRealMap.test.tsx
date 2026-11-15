// @vitest-environment jsdom
/**
 * The Recordings page on the real map: a map with an export (GET /v1/maps) draws through MapScene (mocked: jsdom has no
 * WebGL; the stub shows its props) with world-space layers; without one, the SVG silhouette. The Points / Heatmap and
 * 2D / 3D switches and the cell size live in the URL; a 2D click opens the cell's sessions; the replay draws its path,
 * position and camera cone on the real map; First actions links its example sessions to the replay.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { MapInfo, MapLayer, MapsView } from "@/lib/maps";
import { ttmp } from "@/lib/maps.fixture";
import type { FirstActionResult, Filters, RecordingLayersResult, RecordingReplayResult, RecordingSessionsResult } from "@/lib/types";
import Recordings from "./Recordings";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/components/maps/MapScene", () => ({
	default: (props: { geometry: { count: number } | null; mode: string; layers: MapLayer[]; label?: string; band?: [number, number] | null; onPick?: (p: { x: number; z: number }) => void }) => (
		<div
			data-testid="scene"
			aria-label={props.label}
			data-parts={props.geometry?.count ?? "none"}
			data-mode={props.mode}
			data-band={props.band ? props.band.join("..") : "all"}
			data-layers={props.layers.map((l) => l.id).join(",")}
			data-cells={JSON.stringify(props.layers.map((l) => l.cells ?? []))}
			data-points={props.layers.map((l) => l.points?.length ?? 0).join(",")}
			data-paths={props.layers.map((l) => (l.paths ?? []).map((p) => p.length).join("+")).join(",")}
			data-polygons={props.layers.map((l) => l.polygons?.length ?? 0).join(",")}
		>
			{props.onPick ? (
				<button type="button" onClick={() => props.onPick?.({ x: 806.5, z: 3 })}>
					pick
				</button>
			) : null}
		</div>
	),
}));

const sampling = { recorded: 3, used: 3, sampled: false, failed: 0, capped: false, eventsCapped: false };

const forest = (over: Partial<MapInfo> = {}): MapInfo => ({
	name: "forest",
	kind: "map",
	via: "name",
	path: "Workspace.Forest",
	parts: 2,
	meshes: 0,
	unions: 0,
	invisible: 0,
	bounds: { min: [780, -2, -20], max: [840, 30, 40] },
	hash: "f".repeat(64),
	bytes: 112,
	alternatives: [],
	offset: [0, 0, 0],
	alignment: { state: "unknown", samples: 0, inside: 0 },
	...over,
});

const viewWith = (maps: MapInfo[]): MapsView => ({
	configured: true,
	canExport: false,
	export: { state: "idle", step: "", startedAt: null, finishedAt: null, by: null, error: null },
	latest: null,
	placeVersion: { latest: null, source: null, exported: null, outOfDate: false },
	maps,
	names: [],
	overrides: {},
	history: [],
});

/** The query's own grid (4 studs) or, with `cell`, the real map's finer frame (same origin, no silhouette). */
function layersFor(options: Record<string, unknown>): RecordingLayersResult {
	const cell = (options.cell as number | undefined) ?? 4;
	const fine = options.cell !== undefined;
	const k = 4 / cell;
	const wanted = (options.layers as string[] | undefined) ?? [];
	const all = [
		{ id: "path", label: "Positions", source: "recording" as const, count: 40, sessions: 3, values: [], cells: [[1 * k, 1 * k, 40, 3.4] as [number, number, number, number]], cellsCut: 0, examples: ["s1"] },
		{ id: "ev:custom:down", label: "custom / down", source: "events" as const, count: 4, sessions: 0, values: [], cells: [[3, 3, 4] as [number, number, number]], ...(fine ? { cell: 4 } : {}), cellsCut: 0, examples: [] },
	];
	return {
		mapKey: "map",
		maps: [{ map: "Forest", samples: 900, sessions: 3, events: 4 }],
		map: "Forest",
		frame: { minX: 800, minZ: 0, maxX: 840, maxZ: 40, cell, cols: 40 / cell, rows: 40 / cell },
		background: fine ? [] : [[1, 1, 30]],
		layers: all.filter((l) => wanted.includes(l.id)),
		catalog: [{ kind: "custom", name: "down", count: 4 }],
		sampling,
		notes: [],
	};
}

const replay: RecordingReplayResult = {
	found: true,
	sid: "s1",
	pid: "p1",
	art: "abc",
	dev: "phone",
	why: "left",
	start: 1_000_000,
	duration: 3_000,
	gaps: 0,
	chunks: 1,
	samples: Array.from({ length: 30 }, (_, i) => [i * 100, 801 + i, 3 + i * 0.1, 10, 0, 0] as [number, number, number, number, number, number]),
	inputs: [],
	events: [],
	signals: [],
	maps: [{ t: 0, map: "Forest" }],
	map: "Forest",
	frame: { minX: 792, minZ: 0, maxX: 840, maxZ: 24, cell: 4, cols: 12, rows: 6 },
};

const sessions: RecordingSessionsResult = {
	total: 1,
	sessions: [{ sid: "s1", pid: "p1", art: "abc", dev: "phone", why: "left", start: 1_000_000, seconds: 3, samples: 30, inputs: 0, maps: ["Forest"], signals: { idle: 0, camera_spin: 0, repeated_clicks: 0 } }],
	sampling,
};

const first: FirstActionResult = {
	sessions: 3,
	stats: [{ action: "move", sessions: 3, reached: 2, share: 0.67, median: 2, p25: 1, p75: 3, histogram: [], examples: { slowest: ["slow1"], never: ["still1"] } }],
	byDevice: [],
	byBuild: [],
	sampling,
};

let maps: MapInfo[] = [];
let calls: { name: string; options: Record<string, unknown> }[] = [];
let location = "";

function Where() {
	location = useLocation().search;
	return null;
}

beforeEach(() => {
	maps = [forest()];
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			const url = String(input);
			if (url === "/api/v1/maps") return Response.json(viewWith(maps));
			if (/\/geometry$/.test(url)) return new Response(ttmp([{ pos: [810, -1, 10], size: [60, 2, 60] }, { pos: [800, 10, 10], size: [2, 20, 60], flags: 12, t: 1 }]) as Uint8Array<ArrayBuffer>);
			return new Response("{}", { status: 404 });
		}),
	);
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: Filters = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, options });
		if (name === "recording-layers") return layersFor(options);
		if (name === "recording-sessions") return sessions;
		if (name === "recording-replay") return replay;
		if (name === "first-action") return first;
		throw new Error(`unexpected ${name}`);
	}) as typeof api.query);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function mount(path: string) {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={[path]}>
				<Where />
				<Recordings />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const scene = () => screen.getByTestId("scene");
const lastLayers = () => [...calls].reverse().find((c) => c.name === "recording-layers")?.options;

describe("Recordings on the real map", () => {
	it("a map with an export draws through MapScene, cells in world studs at their recorded height", async () => {
		mount("/recordings?layers=path,ev:custom:down");
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		expect(screen.queryByRole("img", { name: "Map Forest" })).toBeNull();
		expect(screen.getByTestId("real-map").dataset.map).toBe("forest");
		expect(lastLayers()).toMatchObject({ cell: 2, background: false });
		expect(lastLayers()).not.toHaveProperty("map");
		expect(scene().dataset.layers).toBe("path,ev:custom:down");
		const cells = JSON.parse(scene().dataset.cells as string) as { x: number; z: number; y: number | null; n: number }[][];
		// path: cell [2, 2] of a 2-stud frame at (800, 0) = (804, 4), its recorded height; the event at its own 4-stud cell,
		// on the floor slab under it (top 0) + 3.
		expect(cells[0]).toEqual([{ x: 804, z: 4, y: 3.4, n: 40 }]);
		expect(cells[1]).toEqual([{ x: 812, z: 12, y: 3, n: 4 }]);
		expect(screen.getByText(/positioned events stay in the 4-stud cells/)).toBeTruthy();
	});

	it("Points / Heatmap and 2D / 3D switch the scene and stay in the URL; the cell picker asks for its size", async () => {
		mount("/recordings?layers=path");
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		expect(scene().dataset.mode).toBe("3d");
		expect(scene().dataset.points).toBe("0");
		fireEvent.click(within(screen.getByRole("group", { name: "Draw as" })).getByRole("button", { name: "Points" }));
		await waitFor(() => expect(scene().dataset.points).toBe("1"));
		expect(JSON.parse(scene().dataset.cells as string)).toEqual([[]]);
		expect(location).toContain("draw=points");
		fireEvent.click(screen.getByRole("button", { name: /2D/ }));
		await waitFor(() => expect(scene().dataset.mode).toBe("2d"));
		expect(location).toContain("mode=2d");
		fireEvent.click(screen.getByRole("button", { name: "1 stud" }));
		await waitFor(() => expect(lastLayers()).toMatchObject({ cell: 1 }));
		expect(location).toContain("cell=1");
		await waitFor(() => expect(scene().dataset.points).toBe("1"), { timeout: 8000 });
	});

	it("a 2D click on the real map opens that cell's sessions; the replay plays on the real map", async () => {
		mount("/recordings?layers=path");
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		fireEvent.click(screen.getByRole("button", { name: "pick" }));
		await waitFor(() => expect(calls.some((c) => c.name === "recording-sessions")).toBe(true));
		// (806.5, 3) on the 2-stud frame at (800, 0): column 3, row 1 = x 806..808, z 2..4.
		expect(calls.find((c) => c.name === "recording-sessions")?.options).toMatchObject({ map: "Forest", box: [806, 2, 808, 4], layer: "path" });
		await waitFor(() => expect(scene().dataset.layers).toBe("path,selected"));
		fireEvent.click(await screen.findByRole("button", { name: "Replay s1" }));
		await screen.findByTestId("replay-clock");
		await waitFor(() => expect(scene().dataset.layers).toBe("replay-all,replay-passed,replay-cone,replay-dot"), { timeout: 8000 });
		expect(scene().getAttribute("aria-label")).toBe("Replay on Forest");
		expect(scene().dataset.paths).toBe("30,1,,");
		expect(scene().dataset.polygons).toBe("0,0,1,0");
		fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "1000" } });
		expect(scene().dataset.paths).toBe("30,11,,");
		// The replay keeps the page's 2D / 3D.
		fireEvent.click(screen.getByRole("button", { name: /3D/ }));
		expect(scene().dataset.mode).toBe("3d");
	});

	it("the height band: the layers default to every height, the slider and floors cut it; a replay follows the player", async () => {
		mount("/recordings?layers=path");
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		expect(scene().dataset.band).toBe("all");
		expect(screen.queryByRole("button", { name: "Follow player" })).toBeNull();
		fireEvent.change(screen.getByLabelText("Band top"), { target: { value: "12" } });
		await waitFor(() => expect(scene().dataset.band).toBe("-2..12"));
		expect(location).toContain("band=-2..12");
		fireEvent.click(within(screen.getByRole("group", { name: "Floors" })).getByRole("button", { name: "All" }));
		await waitFor(() => expect(scene().dataset.band).toBe("all"));
		expect(location).not.toContain("band=");

		// The replay: Follow player by default (feet = the lowest root height of the last 1.5 s - 3, cut 9 studs above).
		fireEvent.click(screen.getByRole("button", { name: "pick" }));
		fireEvent.click(await screen.findByRole("button", { name: "Replay s1" }));
		await screen.findByTestId("replay-clock");
		await waitFor(() => expect(scene().dataset.layers).toBe("replay-all,replay-passed,replay-cone,replay-dot"), { timeout: 8000 });
		expect(screen.getByRole("button", { name: "Follow player" }).getAttribute("aria-pressed")).toBe("true");
		expect(scene().dataset.band).toBe("-2..9");
		fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "2900" } });
		// Samples 14..29 (t 1400..2900): lowest root 4.4, feet 1.4 -> 1.
		await waitFor(() => expect(scene().dataset.band).toBe("-2..10"));
		// All, said out loud in a replay.
		fireEvent.click(within(screen.getByRole("group", { name: "Floors" })).getByRole("button", { name: "All" }));
		await waitFor(() => expect(scene().dataset.band).toBe("all"));
		expect(location).toContain("band=all");
		fireEvent.click(screen.getByRole("button", { name: "Follow player" }));
		await waitFor(() => expect(scene().dataset.band).toBe("-2..10"));
		expect(location).not.toContain("band=");
	});

	it("a picked cell is dropped when the cell size changes (its column and row belong to the old grid)", async () => {
		mount("/recordings?layers=path");
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		fireEvent.click(screen.getByRole("button", { name: "pick" }));
		await waitFor(() => expect(scene().dataset.layers).toBe("path,selected"));
		fireEvent.click(screen.getByRole("button", { name: "1 stud" }));
		await waitFor(() => expect(lastLayers()).toMatchObject({ cell: 1 }));
		await waitFor(() => expect(scene().dataset.layers).toBe("path"), { timeout: 8000 });
		expect(screen.queryByText(/Sessions in this cell/)).toBeNull();
	});

	it("no export of the map: the SVG silhouette at the query's own grid, no 2D / 3D switch", async () => {
		maps = [forest({ name: "Mall" })];
		mount("/recordings?layers=path");
		await screen.findByRole("img", { name: "Map Forest" });
		expect(screen.queryByTestId("scene")).toBeNull();
		expect(lastLayers()).not.toHaveProperty("cell");
		expect(screen.queryByRole("button", { name: /3D/ })).toBeNull();
		expect(screen.getByText(/Cells of 4 studs \(no map export/)).toBeTruthy();
		fireEvent.click(within(screen.getByRole("group", { name: "Draw as" })).getByRole("button", { name: "Points" }));
		await waitFor(() => expect(location).toContain("draw=points"));
		expect(screen.getByRole("img", { name: "Map Forest" }).querySelector("circle")).toBeTruthy();
	});

	it("the maps list failing (no maps feature, no access) falls back to the SVG", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 })));
		mount("/recordings?layers=path");
		await screen.findByRole("img", { name: "Map Forest" });
		expect(screen.queryByTestId("scene")).toBeNull();
	});

	it("First actions links its example sessions (slowest, never) to the replay", async () => {
		mount("/recordings?tab=first");
		fireEvent.click(await screen.findByRole("button", { name: "Replay still1" }));
		await screen.findByTestId("replay-clock");
		expect(location).toContain("sid=still1");
		expect(calls.some((c) => c.name === "recording-replay" && c.options.sid === "still1")).toBe(true);
		expect(screen.getByRole("button", { name: /3D/ })).toBeTruthy();
	});
});
