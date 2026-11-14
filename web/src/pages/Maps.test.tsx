// @vitest-environment jsdom
/**
 * The Maps page: the export card (last export, out of date, the Export button for owners only, progress), the map
 * picker (each map's geometry fetched by name), 2D / 3D, the layer toggles, the cell size picker (the map-positions
 * query's `cell`), the floor buttons, and the alignment card. The three.js scene is mocked (jsdom has no WebGL): the
 * stub shows the props it got.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { FLAGS, type MapInfo, type MapPositionsResult, type MapsView } from "@/lib/maps";
import { ttmp } from "@/lib/maps.fixture";
import type { AuthInfo } from "@/lib/types";
import Maps from "./Maps";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/components/maps/MapScene", () => ({
	default: (props: { geometry: { count: number } | null; mode: string; layers: { id: string; cellSize?: number; cells?: unknown[]; points?: unknown[] }[]; band: [number, number] | null; offset: number[] }) => (
		<div
			data-testid="scene"
			data-parts={props.geometry?.count ?? "none"}
			data-mode={props.mode}
			data-layers={props.layers.map((l) => l.id).join(",")}
			data-cells={props.layers.map((l) => l.cells?.length ?? 0).join(",")}
			data-points={props.layers.map((l) => l.points?.length ?? 0).join(",")}
			data-band={props.band ? props.band.join(",") : "all"}
			data-offset={props.offset.join(",")}
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
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
			const geo = /^\/api\/v1\/maps\/([^/]+)\/geometry$/.exec(url);
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
	vi.spyOn(api, "query").mockImplementation(async (_name, _filters, options) => POSITIONS((options as { cell: number }).cell) as never);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function wrap(auth: AuthInfo) {
	return render(
		<MemoryRouter>
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
		expect(calls.some((c) => c.url === "/api/v1/maps/parking_garage/geometry")).toBe(true);
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
		expect(scene().dataset.mode).toBe("2d");
		expect(scene().dataset.cells).toBe("2,1");
		expect(scene().dataset.points).toBe("0,0");
		fireEvent.click(screen.getByRole("button", { name: /3D/ }));
		expect(scene().dataset.mode).toBe("3d");
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
});
