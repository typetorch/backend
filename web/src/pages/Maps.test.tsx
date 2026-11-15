// @vitest-environment jsdom
/**
 * The Maps page: the export card (last export, out of date, the Export button for owners only, progress), the map
 * picker (each map's geometry fetched by name), 2D / 3D, the layer toggles, the cell size picker (the map-positions
 * query's `cell`), the floor buttons, and the alignment card. The three.js scene is mocked (jsdom has no WebGL): the
 * stub shows the props it got.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { FLAGS, type MapInfo, type MapPositionsResult, type MapsView } from "@/lib/maps";
import { ttmp } from "@/lib/maps.fixture";
import type { AuthInfo } from "@/lib/types";
import Maps from "./Maps";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/components/maps/MapScene", () => ({
	default: (props: { geometry: { count: number } | null; mode: string; layers: { id: string; cellSize?: number; cells?: unknown[]; points?: unknown[] }[]; band: [number, number] | null; offset: number[]; decorative?: boolean; markers?: boolean }) => (
		<div
			data-testid="scene"
			data-parts={props.geometry?.count ?? "none"}
			data-mode={props.mode}
			data-layers={props.layers.map((l) => l.id).join(",")}
			data-cells={props.layers.map((l) => l.cells?.length ?? 0).join(",")}
			data-points={props.layers.map((l) => l.points?.length ?? 0).join(",")}
			data-band={props.band ? props.band.join(",") : "all"}
			data-offset={props.offset.join(",")}
			data-decorative={String(Boolean(props.decorative))}
			data-markers={String(Boolean(props.markers))}
		/>
	),
}));

const OWNER = { ok: true, role: "admin", via: "cookie" } as AuthInfo;
const VIEWER = { ok: true, role: "web", via: "cookie" } as AuthInfo;

const map = (over: Partial<MapInfo>): MapInfo => ({
	name: "Mall",
	kind: "map",
	via: "name",
	path: "ReplicatedStorage.assets.maps.Mall",
	parts: 2,
	meshes: 1,
	unions: 0,
	invisible: 0,
	bounds: { min: [0, -1, 0], max: [100, 30, 100] },
	hash: "a".repeat(64),
	bytes: 112,
	alternatives: [],
	offset: [0, 0, 0],
	alignment: { state: "aligned", samples: 40, inside: 0.95 },
	...over,
});

const VIEW: MapsView = {
	configured: true,
	canExport: true,
	export: { state: "idle", step: "", startedAt: null, finishedAt: null, by: null, error: null },
	latest: { placeId: 1, universeId: 2, placeVersion: 3617, at: Date.now() - 3_600_000, by: "roblox user 1 (owner)", seconds: 7, parts: 5, bytes: 239_982, truncated: false, unmatched: ["none"], notes: [] },
	placeVersion: { latest: 3620, source: "roblox", exported: 3617, outOfDate: true },
	maps: [
		map({}),
		map({ name: "parking_garage", path: "ReplicatedStorage.assets.maps.ParkingGarage", hash: "b".repeat(64), parts: 3, alignment: { state: "off", samples: 30, inside: 0, suggestedOffset: [600, 0, 0] } }),
		map({ name: "(lobby)", kind: "lobby", via: "lobby", path: "Workspace", hash: "c".repeat(64), parts: 1 }),
	],
	names: [],
	overrides: {},
	history: [],
};

const POSITIONS = (cell: number): MapPositionsResult => ({
	mapKey: "map",
	cell,
	names: [],
	truncated: false,
	cells: [
		{ map: "Mall", event: "custom:down", x: 10, z: 10, y: 3, ylo: 3, n: 4 },
		{ map: "Mall", event: "custom:down", x: 12, z: 10, y: 3, ylo: 3, n: 1 },
		{ map: "Mall", event: "custom:loot", x: 50, z: 50, y: 3, ylo: 3, n: 2 },
	],
});

const GEOMETRY: Record<string, Uint8Array> = {
	Mall: ttmp([
		{ pos: [50, -0.5, 50], size: [100, 1, 100] },
		{ pos: [50, 15.5, 50], size: [100, 1, 100] },
	]),
	parking_garage: ttmp([
		{ pos: [0, 0, 0], size: [10, 1, 10] },
		{ pos: [0, 5, 0], size: [1, 10, 1], flags: FLAGS.mesh },
		{ pos: [0, 5, 0], size: [1, 1, 1] },
	]),
	"(lobby)": ttmp([{ pos: [0, 0, 0], size: [4, 1, 4] }]),
};

let calls: { url: string; method: string; body?: string }[] = [];
let view: MapsView = VIEW;

beforeEach(() => {
	calls = [];
	view = VIEW;
	recordings = NO_RECORDINGS;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
			const geo = /^\/api\/v1\/maps\/([^/]+)\/geometry\?v=2$/.exec(url);
			if (geo) return new Response(GEOMETRY[decodeURIComponent(geo[1] as string)] as Uint8Array<ArrayBuffer>);
			if (url === "/api/v1/maps") return Response.json(view);
			if (url === "/api/v1/maps/export") {
				view = { ...VIEW, export: { ...VIEW.export, state: "running", step: "queued on Roblox" } };
				return Response.json({ export: view.export, names: ["Mall"] }, { status: 202 });
			}
			if (url.endsWith("/override")) return Response.json({ override: { offset: [600, 0, 0], by: "x", at: 1 } });
			return new Response("{}", { status: 404 });
		}),
	);
	vi.spyOn(api, "query").mockImplementation(async (name, _filters, options) => (name === "recording-layers" ? (recordings as never) : (POSITIONS((options as { cell: number }).cell) as never)));
});

/** The recording-layers answer for the alignment from recordings (Mall's samples, inside its 0..100 box). */
const NO_RECORDINGS = { mapKey: "map", maps: [], map: null, frame: null, background: [], layers: [], catalog: [], sampling: {}, notes: [] };
let recordings: unknown = NO_RECORDINGS;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

let location = "";
function Where() {
	const l = useLocation();
	location = l.search;
	return null;
}

function wrap(auth: AuthInfo, path = "/maps") {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Where />
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AuthProvider value={auth}>
					<Maps />
				</AuthProvider>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

const scene = () => screen.getByTestId("scene");

describe("the Maps page", () => {
	test("the export card: last export, out of date, unmatched names; owners export and see progress", async () => {
		wrap(OWNER);
		await waitFor(() => expect(screen.getByText(/place version 3617/)).toBeTruthy(), { timeout: 8000 });
		expect(screen.getByText(/Out of date: Roblox has place version 3620/)).toBeTruthy();
		expect(screen.getByText(/No model found for: none/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Export again/ }));
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("queued on Roblox"), { timeout: 8000 });
		expect(calls.some((c) => c.url === "/api/v1/maps/export" && c.method === "POST")).toBe(true);
		expect((screen.getByRole("button", { name: /Exporting/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	test("viewers see the maps but no Export button and no override form", async () => {
		view = { ...VIEW, canExport: false };
		wrap(VIEWER);
		await waitFor(() => expect(screen.getByText(/place version 3617/)).toBeTruthy(), { timeout: 8000 });
		expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		expect(screen.queryByLabelText("Model path")).toBeNull();
	});

	test("the map picker fetches each map's geometry by name; the lobby has no layers", async () => {
		wrap(OWNER);
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		fireEvent.click(screen.getByRole("button", { name: /parking_garage/ }));
		await waitFor(() => expect(scene().dataset.parts).toBe("3"), { timeout: 8000 });
		expect(calls.some((c) => c.url === "/api/v1/maps/parking_garage/geometry?v=2")).toBe(true);
		expect(screen.getByText(/Not aligned/)).toBeTruthy();
		expect(screen.getByText(/Suggested offset: 600, 0, 0/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Use this offset" }));
		await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/maps/parking_garage/override" && c.method === "PUT" && c.body === '{"offset":[600,0,0]}')).toBe(true), { timeout: 8000 });
		fireEvent.click(screen.getByRole("button", { name: "Lobby" }));
		await waitFor(() => expect(scene().dataset.parts).toBe("1"), { timeout: 8000 });
		expect(screen.queryByRole("group", { name: "Layers" })).toBeNull();
	});

	test("2D / 3D, the layer toggles, dots or heat cells", async () => {
		wrap(OWNER);
		await waitFor(() => expect(scene().dataset.layers).toBe("ev:custom:down,ev:custom:loot"), { timeout: 8000 });
		// 3D by default (user 2026-11-15); 2D on the switch
		expect(scene().dataset.mode).toBe("3d");
		expect(scene().dataset.cells).toBe("2,1");
		expect(scene().dataset.points).toBe("0,0");
		fireEvent.click(screen.getByRole("button", { name: /2D/ }));
		expect(scene().dataset.mode).toBe("2d");
		expect(location).toContain("mode=2d");
		fireEvent.click(screen.getByRole("button", { name: /3D/ }));
		expect(scene().dataset.mode).toBe("3d");
		expect(location).not.toContain("mode=");
		fireEvent.click(screen.getByRole("button", { name: /down \(5\)/ }));
		expect(scene().dataset.layers).toBe("ev:custom:loot");
		fireEvent.click(screen.getByRole("button", { name: /down \(5\)/ }));
		expect(scene().dataset.layers).toBe("ev:custom:down,ev:custom:loot");
		fireEvent.click(screen.getByRole("button", { name: "Dots" }));
		expect(scene().dataset.cells).toBe("0,0");
		expect(scene().dataset.points).toBe("2,1");
	});

	test("the cell size picker asks map-positions for 0.5, 1 or 2 stud cells", async () => {
		wrap(OWNER);
		await waitFor(() => expect(scene().dataset.layers).toContain("ev:custom:down"), { timeout: 8000 });
		const cells = () => (api.query as unknown as { mock: { calls: [string, unknown, { cell: number; map: string }][] } }).mock.calls.map((c) => [c[0], c[2].cell, c[2].map]);
		expect(cells()).toContainEqual(["map-positions", 1, "Mall"]);
		fireEvent.click(screen.getByRole("button", { name: "0.5 studs" }));
		await waitFor(() => expect(cells()).toContainEqual(["map-positions", 0.5, "Mall"]), { timeout: 8000 });
		fireEvent.click(screen.getByRole("button", { name: "2 studs" }));
		await waitFor(() => expect(cells()).toContainEqual(["map-positions", 2, "Mall"]), { timeout: 8000 });
		expect((screen.getByRole("button", { name: "2 studs" }) as HTMLElement).getAttribute("aria-pressed")).toBe("true");
	});

	test("floors from the geometry set the Y band; All clears it", async () => {
		wrap(OWNER);
		await waitFor(() => expect(screen.getByRole("button", { name: "Floor 2" })).toBeTruthy(), { timeout: 8000 });
		fireEvent.click(screen.getByRole("button", { name: "Floor 1" }));
		expect(scene().dataset.band).toBe("-2,14");
		fireEvent.click(screen.getByRole("button", { name: "Floor 2" }));
		expect(scene().dataset.band).toBe("14,46");
		fireEvent.click(screen.getByRole("button", { name: "All" }));
		expect(scene().dataset.band).toBe("all");
	});

	test("by default only the collision geometry: the toggles add decorative meshes and markers, explained in a line", async () => {
		wrap(OWNER);
		await waitFor(() => expect(scene().dataset.parts).toBe("2"), { timeout: 8000 });
		expect(scene().dataset.decorative).toBe("false");
		expect(scene().dataset.markers).toBe("false");
		expect(screen.getByTestId("draw-rule").textContent).toMatch(/every part that collides/);
		fireEvent.click(screen.getByRole("checkbox", { name: /Decorative meshes/ }));
		expect(scene().dataset.decorative).toBe("true");
		fireEvent.click(screen.getByRole("checkbox", { name: /Markers and triggers/ }));
		expect(scene().dataset.markers).toBe("true");
		expect(location).toContain("decor=1");
		expect(location).toContain("markers=1");
	});

	test("the view lives in the URL and survives a map switch; a band range that doesn't fit the new map resets", async () => {
		wrap(OWNER, "/maps?mode=3d&cell=2&draw=points&decor=1&hide=ev:custom:loot&band=10..20");
		await waitFor(() => expect(scene().dataset.layers).toBe("ev:custom:down"), { timeout: 8000 });
		expect(scene().dataset.mode).toBe("3d");
		expect(scene().dataset.decorative).toBe("true");
		expect(scene().dataset.band).toBe("10,20");
		expect(scene().dataset.cells).toBe("0");
		expect(scene().dataset.points).toBe("2");
		expect((screen.getByRole("button", { name: "2 studs" }) as HTMLElement).getAttribute("aria-pressed")).toBe("true");
		// parking_garage's heights are -1..30 too: the range fits and stays.
		fireEvent.click(screen.getByRole("button", { name: /parking_garage/ }));
		await waitFor(() => expect(scene().dataset.parts).toBe("3"), { timeout: 8000 });
		expect(location).toContain("map=parking_garage");
		expect(scene().dataset.mode).toBe("3d");
		expect(scene().dataset.decorative).toBe("true");
		expect(scene().dataset.band).toBe("10,20");
		expect((screen.getByRole("button", { name: "2 studs" }) as HTMLElement).getAttribute("aria-pressed")).toBe("true");
		expect(location).toContain("hide=ev%3Acustom%3Aloot");
		// The lobby (-1..30 too) keeps it; a map whose heights don't hold the range drops it.
		cleanup();
		view = { ...VIEW, maps: [...VIEW.maps, map({ name: "Low", hash: "d".repeat(64), bounds: { min: [0, -1, 0], max: [10, 5, 10] } })] };
		GEOMETRY.Low = ttmp([{ pos: [0, 0, 0], size: [4, 1, 4] }]);
		wrap(OWNER, "/maps?mode=2d&band=10..20&map=Low");
		await waitFor(() => expect(scene().dataset.parts).toBe("1"), { timeout: 8000 });
		await waitFor(() => expect(location).not.toContain("band="), { timeout: 8000 });
		expect(scene().dataset.band).toBe("all");
		expect(location).toContain("mode=2d");
	});

	test("a floor choice carries to the next map's floor of the same number", async () => {
		wrap(OWNER, "/maps?band=f2");
		await waitFor(() => expect(scene().dataset.band).toBe("14,46"), { timeout: 8000 });
		expect((screen.getByRole("button", { name: "Floor 2" }) as HTMLElement).getAttribute("aria-pressed")).toBe("true");
		// parking_garage has one floor: every height, and the choice stays in the URL for the next map.
		fireEvent.click(screen.getByRole("button", { name: /parking_garage/ }));
		await waitFor(() => expect(scene().dataset.parts).toBe("3"), { timeout: 8000 });
		expect(scene().dataset.band).toBe("all");
		expect(location).toContain("band=f2");
	});

	test("no positioned events: the alignment comes from the recordings' positions on that map", async () => {
		view = { ...VIEW, maps: [map({ name: "HedgeMaze", bounds: { min: [641, -2, -157], max: [998, 58, 157] }, alignment: { state: "unknown", samples: 0, inside: 0 } })], names: [{ name: "hedgemaze", events: 9081 }] };
		GEOMETRY.HedgeMaze = ttmp([{ pos: [800, -1, 0], size: [396, 2, 396] }]);
		const background: [number, number, number][] = [];
		for (let c = 0; c < 93; c += 4) for (let r = 0; r < 82; r += 4) background.push([c, r, 3]);
		recordings = { mapKey: "map", maps: [{ map: "hedgemaze", samples: 46268, sessions: 159, events: 0 }], map: "hedgemaze", frame: { minX: 636, minZ: -164, maxX: 1008, maxZ: 164, cell: 4, cols: 93, rows: 82 }, background, layers: [], catalog: [], sampling: {}, notes: [] };
		wrap(OWNER);
		await waitFor(() => expect(screen.getByText("Aligned with where players are")).toBeTruthy(), { timeout: 8000 });
		expect(screen.getByTestId("alignment-source").textContent).toMatch(/recorded positions on this map \(recordings/);
		const asked = (api.query as unknown as { mock: { calls: [string, unknown, { map?: string; layers?: string[] }][] } }).mock.calls.filter((c) => c[0] === "recording-layers");
		expect(asked[0]?.[2]).toEqual({ map: "hedgemaze", layers: [] });
	});

	test("recordings never in the map's zone (a tutorial area while the server ran it): no offset suggested from them", async () => {
		// 2026-11-15, gnome: every round map's samples were newcomers in the TutorialYard (x -4500), and Use this offset moved the maps there
		view = { ...VIEW, maps: [map({ name: "HedgeMaze", bounds: { min: [641, -2, -157], max: [998, 58, 157] }, alignment: { state: "unknown", samples: 0, inside: 0 } })], names: [{ name: "hedgemaze", events: 9081 }] };
		GEOMETRY.HedgeMaze = ttmp([{ pos: [800, -1, 0], size: [396, 2, 396] }]);
		const background: [number, number, number][] = [];
		for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) background.push([c, r, 50]);
		recordings = { mapKey: "map", maps: [{ map: "hedgemaze", samples: 800, confirmed: 0, sessions: 40, events: 0 }], zoned: 5000, map: "hedgemaze", frame: { minX: -4600, minZ: -100, maxX: -4408, maxZ: 92, cell: 48, cols: 4, rows: 4 }, background, layers: [], catalog: [], sampling: {}, notes: [] };
		wrap(OWNER);
		await waitFor(() => expect(screen.getByTestId("alignment-unconfirmed")).toBeTruthy(), { timeout: 8000 });
		expect(screen.queryByRole("button", { name: "Use this offset" })).toBeNull();
	});
});
