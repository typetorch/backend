// @vitest-environment jsdom
/**
 * Plans/34 in the explorer: the Fleet page's game columns (hidden by default, from the Columns picker, remembered,
 * typed), the server page's Game tab (declared commands as game-defined buttons, answers as table / kv / JSON, the
 * streams' latest values) and Live map tab (dots, trails, markers, the map from the positions, hover, follow), and
 * /live (the fleet-wide watch, every server's players coloured per server). MapScene is mocked (jsdom has no WebGL;
 * the stub shows its props).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/data-table";
import { api } from "@/lib/api";
import type { MapInfo, MapLayer, MapsView } from "@/lib/maps";
import { ttmp } from "@/lib/maps.fixture";
import type { FleetServer, FleetServerDetail, GameColumn, RemoteCommand, ServerStreams } from "@/lib/types";
import { gameColumnId, gameColumns, serverColumns } from "./Fleet";
import LivePage, { liveDots } from "./Live";
import ServerPage from "./Server";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/components/maps/MapScene", () => ({
	default: (props: { mode: string; layers: MapLayer[]; label?: string; band?: [number, number] | null; onPick?: (p: { x: number; z: number }) => void; onHover?: (p: { x: number; z: number } | null, at: { left: number; top: number }) => void }) => (
		<div
			data-testid="scene"
			aria-label={props.label}
			data-mode={props.mode}
			data-band={props.band ? props.band.join("..") : "all"}
			data-layers={props.layers.map((l) => l.id).join(",")}
			data-colors={props.layers.map((l) => l.color).join(",")}
			data-paths={props.layers.map((l) => (l.paths ?? []).map((p) => p.length).join("+")).join(",")}
		>
			<button type="button" onClick={() => props.onPick?.({ x: 1101, z: 101 })}>
				pick
			</button>
			<button type="button" onClick={() => props.onHover?.({ x: 1100, z: 100 }, { left: 10, top: 10 })}>
				hover
			</button>
		</div>
	),
}));

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const JOB = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";
const NAME = "LivePlayerMarker";

const mapInfo = (name: string, kind: "map" | "lobby", min: [number, number, number], max: [number, number, number]): MapInfo => ({
	name,
	kind,
	via: kind === "lobby" ? "lobby" : "name",
	path: `Workspace.${name}`,
	parts: 1,
	meshes: 0,
	unions: 0,
	invisible: 0,
	bounds: { min, max },
	hash: name.padEnd(64, "0"),
	bytes: 48,
	alternatives: [],
	offset: [0, 0, 0],
	alignment: { state: "unknown", samples: 0, inside: 0 },
});
const MAPS = [mapInfo("Lobby", "lobby", [-100, 0, -100], [100, 50, 100]), mapInfo("HedgeMaze", "map", [1000, 0, 0], [1200, 30, 200])];
const view = (maps: MapInfo[]): MapsView => ({
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

function stubMapsFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			const url = String(input);
			if (url === "/api/v1/maps") return Response.json(view(MAPS));
			if (/\/geometry$/.test(url)) return new Response(ttmp([{ pos: [1100, -1, 100], size: [200, 2, 200] }]) as Uint8Array<ArrayBuffer>);
			return new Response("{}", { status: 404 });
		}),
	);
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("the Fleet page's game columns", () => {
	const declared: GameColumn[] = [
		{ n: "current_map", l: "Map", t: "string" },
		{ n: "in_round", l: "In round", t: "bool" },
		{ n: "round_no", l: "Round", t: "number" },
	];
	const row = (job: string, cv: FleetServer["cv"]): FleetServer => ({ job, serverType: "public", branch: "prod", artifact: "a1", players: 3, maxPlayers: 20, startedAt: null, appliedSeq: 1, generation: 1, health: "ok", lastError: null, kernel: "0.6.0", experiment: false, cv });
	const rows = [row("job-a", { current_map: "HedgeMaze", in_round: true, round_no: 12 }), row("job-b", { current_map: "Lobby", in_round: false, round_no: 3 }), row("job-c", null)];
	beforeEach(() => localStorage.clear());

	it("hidden by default, after the built-in columns, typed", () => {
		const cols = serverColumns(false, declared);
		expect(cols.slice(-3).map((c) => c.id)).toEqual(["cv.current_map", "cv.in_round", "cv.round_no"]);
		const game = gameColumns(declared);
		expect(game.every((c) => c.defaultHidden)).toBe(true);
		expect(game[1]?.format?.(true, rows[0] as FleetServer)).toBe("yes");
		expect(game[1]?.format?.(false, rows[0] as FleetServer)).toBe("no");
		expect(game[2]?.align).toBe("right");
		expect(game[2]?.accessor(rows[0] as FleetServer)).toBe(12);
		expect(game[0]?.accessor(rows[2] as FleetServer)).toBeNull();
		expect(serverColumns(true, declared).some((c) => c.id === "ip")).toBe(false);
	});

	it("turned on from the Columns picker, shown as yes / no and right-aligned numbers, and remembered", async () => {
		const cols = serverColumns(false, declared);
		const view1 = render(
			<MemoryRouter>
				<DataTable<FleetServer> id="fleet-servers" columns={cols} data={rows} rowId={(s) => s.job} />
			</MemoryRouter>,
		);
		expect(screen.queryByRole("columnheader", { name: /In round/ })).toBeNull();
		fireEvent.keyDown(screen.getByRole("button", { name: "Columns" }), { key: "ArrowDown" });
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "In round" }));
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Round" }));
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		const index = (name: string) => Array.from(document.querySelectorAll("thead th")).findIndex((th) => th.textContent?.startsWith(name));
		await waitFor(() => expect(index("In round")).toBeGreaterThan(-1));
		const cells = (name: string) => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[index(name)]);
		expect(cells("In round").map((td) => td?.textContent)).toEqual(["yes", "no", "–"]);
		expect(cells("Round")[0]?.className).toContain("text-right");
		// Remembered like the page's other column choices (localStorage, by column id).
		await waitFor(() => expect(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes("fleet-servers")) ?? "") ?? "").toContain(gameColumnId("in_round")));
		view1.unmount();
		render(
			<MemoryRouter>
				<DataTable<FleetServer> id="fleet-servers" columns={cols} data={rows} rowId={(s) => s.job} />
			</MemoryRouter>,
		);
		expect(screen.getByRole("columnheader", { name: /In round/ })).toBeTruthy();
	});
});

describe("the server page's Game and Live map tabs", () => {
	const row: FleetServer & { closedAt: string | null; lostAt: string | null } = {
		job: JOB,
		serverType: "public",
		branch: "prod",
		channel: "prod",
		artifact: "art-42",
		players: 2,
		maxPlayers: 20,
		startedAt: new Date(Date.now() - 3_600_000).toISOString(),
		lastSeen: new Date().toISOString(),
		appliedSeq: 7,
		generation: 2,
		health: "ok",
		lastError: null,
		kernel: "0.6.0",
		experiment: false,
		closedAt: null,
		lostAt: null,
	};
	const detail: FleetServerDetail = { server: row, state: "live", debug: { watched: true, connected: true, lastPollAt: Date.now() } };
	const t0 = 1_800_000_000_000;
	const streams: ServerStreams = {
		declared: {
			commands: [
				{ n: "round_state", l: "Round state", d: "The round's phase" },
				{ n: "teams", l: "Teams" },
				{ n: "raw", l: "Raw" },
			],
			streams: [
				{ n: "spawns", hz: 1, k: "points", l: "Spawns" },
				{ n: "score", hz: 2, k: "json", l: "Score" },
			],
		},
		frames: [
			{ t: t0, s: { positions: { players: [{ u: 101, n: NAME, x: 1090, y: 5, z: 100, st: "alive" }, { u: 102, n: "Lobbyist", x: 0, y: 5, z: 0, st: "alive" }, { u: 103, n: "Dead", st: "none" }] } } },
			{ t: t0 + 500, s: { positions: { players: [{ u: 101, n: NAME, x: 1100, y: 5, z: 100, st: "alive" }, { u: 102, n: "Lobbyist", x: 1, y: 5, z: 0, st: "alive" }, { u: 104, n: "Racer", x: 1150, y: 5, z: 150, st: "alive" }] } } },
			{ t: t0 + 1000, s: { "game.spawns": { points: [{ x: 1010, y: 1, z: 10, label: "Red base", color: "#ff0000" }] }, "game.score": { red: 3, blue: 1 } } },
		],
	};
	const answers: Record<string, unknown> = {
		"game.round_state": { kind: "table", columns: ["Phase", "Left"], rows: [["playing", 42]] },
		"game.teams": { kind: "kv", items: { red: 4, blue: 5 } },
		"game.raw": { anything: [1, 2] },
		status: { status: { placeVersion: 1 }, fleet: {} },
	};

	function mockApi() {
		vi.spyOn(api, "fleetServer").mockResolvedValue(detail);
		vi.spyOn(api, "watchServer").mockResolvedValue({ job: JOB, watched: true, connected: true });
		vi.spyOn(api, "serverMetrics").mockResolvedValue([]);
		vi.spyOn(api, "debugAudit").mockResolvedValue([]);
		const serverStreams = vi.spyOn(api, "serverStreams").mockResolvedValue(streams);
		let n = 0;
		const remoteCommand = vi.spyOn(api, "remoteCommand").mockImplementation(async (_job, op, args) => {
			n += 1;
			const command: RemoteCommand = { id: `c${n}`, op, state: "done", createdAt: 0, expiresAt: 0, doneAt: Date.now(), ms: 2, result: answers[op] ?? (args ? { echoed: args } : {}) };
			return command;
		});
		return { serverStreams, remoteCommand };
	}

	function mount(tab: string) {
		return render(
			<QueryClientProvider client={client()}>
				<MemoryRouter initialEntries={[`/servers/${JOB}?tab=${tab}`]}>
					<Routes>
						<Route path="/servers/:jobId" element={<ServerPage />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
	}

	beforeEach(() => {
		localStorage.clear();
		stubMapsFetch();
	});

	it("Game: declared commands as game-defined buttons, answers as a table, key-value pairs or JSON; the streams' latest values", async () => {
		const { serverStreams, remoteCommand } = mockApi();
		mount("game");
		await waitFor(() => expect(serverStreams).toHaveBeenCalledWith(JOB, undefined, expect.anything()));
		const round = await screen.findByTestId("game-command-round_state");
		expect(within(round).getByText("game-defined")).toBeTruthy();
		expect(within(round).getByText("The round's phase")).toBeTruthy();
		fireEvent.click(within(round).getByRole("button", { name: "Run" }));
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "game.round_state", undefined, expect.anything()));
		expect(await within(round).findByRole("columnheader", { name: "Phase" })).toBeTruthy();
		expect(within(round).getByText("42").className).toContain("text-right");

		const teams = screen.getByTestId("game-command-teams");
		fireEvent.change(within(teams).getByLabelText("Args for Teams"), { target: { value: "[1]" } });
		fireEvent.click(within(teams).getByRole("button", { name: "Run" }));
		expect(within(teams).getByRole("alert").textContent).toContain("JSON object");
		fireEvent.change(within(teams).getByLabelText("Args for Teams"), { target: { value: '{"side":"red"}' } });
		fireEvent.click(within(teams).getByRole("button", { name: "Run" }));
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "game.teams", { side: "red" }, expect.anything()));
		expect(await within(teams).findByText("blue")).toBeTruthy();

		const raw = screen.getByTestId("game-command-raw");
		fireEvent.click(within(raw).getByRole("button", { name: "Run" }));
		expect((await within(raw).findByText(/"anything"/)).tagName).toBe("PRE");

		// Streams: positions as a table, a points stream as a count, a JSON stream as JSON.
		expect(screen.getAllByText(NAME).length).toBeGreaterThan(0);
		expect(within(screen.getByTestId("game-stream-spawns")).getByText(/1 point: Red base/)).toBeTruthy();
		expect(within(screen.getByTestId("game-stream-score")).getByText(/"red": 3/)).toBeTruthy();
		// Nothing of it in localStorage.
		expect(JSON.stringify({ ...localStorage })).not.toContain(NAME);
	});

	it("Live map: the map most players are on, a dot and trail per player there, the points stream as markers, hover and follow", async () => {
		mockApi();
		mount("map");
		const scene = await screen.findByTestId("scene", {}, { timeout: 10_000 });
		const box = screen.getByTestId("live-map");
		// Two of three placed players are on HedgeMaze (by its bounds); the lobby has one.
		expect(box.dataset.map).toBe("HedgeMaze");
		const layers = () => (screen.getByTestId("scene").dataset.layers ?? "").split(",");
		await waitFor(() => expect(layers()).toEqual(expect.arrayContaining(["dot:101", "dot:104", "marker:game.spawns:0"])));
		expect(layers()).not.toContain("dot:102");
		expect(layers()).not.toContain("dot:103");
		expect(layers()).toContain("trail:101");
		expect(scene.getAttribute("aria-label")).toBe("Live map of this server");
		// The switcher counts players per map.
		const switcher = screen.getByRole("group", { name: "Map" });
		expect(within(switcher).getByRole("button", { name: /HedgeMaze\s*2/ })).toBeTruthy();
		expect(within(switcher).getByRole("button", { name: /Lobby\s*1/ })).toBeTruthy();
		// Hover: the nearest player's name.
		fireEvent.click(screen.getByRole("button", { name: "hover" }));
		expect(screen.getByRole("tooltip").textContent).toBe(NAME);
		// A 2D click on a dot follows that player: their map, the band cut over their feet.
		fireEvent.click(screen.getByRole("button", { name: "pick" }));
		await waitFor(() => expect(screen.getByTestId("live-map").dataset.followed).toBe("101"));
		expect(screen.getByTestId("live-map").dataset.band).not.toBe("all");
		expect(screen.getByRole("button", { name: "Following" })).toBeTruthy();
		// Switching map by hand stops following.
		fireEvent.click(within(switcher).getByRole("button", { name: /Lobby/ }));
		await waitFor(() => expect(screen.getByTestId("live-map").dataset.map).toBe("Lobby"));
		expect(screen.getByTestId("live-map").dataset.followed).toBe("");
		expect(layers()).toContain("dot:102");
	});

	it("polls the streams about every second with the newest frame's time", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { serverStreams } = mockApi();
			mount("status");
			await waitFor(() => expect(serverStreams).toHaveBeenCalledTimes(1));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1100);
			});
			await waitFor(() => expect(serverStreams.mock.calls.length).toBeGreaterThanOrEqual(2));
			expect(serverStreams.mock.calls[1]?.[1]).toBe(t0 + 1000);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("/live", () => {
	beforeEach(() => {
		localStorage.clear();
		stubMapsFetch();
	});

	it("holds the fleet-wide watch, polls the map, colours dots per server and lists each server's players", async () => {
		const watchLiveMap = vi.spyOn(api, "watchLiveMap").mockResolvedValue({ ok: true, until: Date.now() + 60_000, wake: true });
		const liveMap = vi.spyOn(api, "liveMap").mockResolvedValue({
			watchedUntil: Date.now() + 60_000,
			servers: [
				{ job: "job-aaaaaaaa-1", branch: "prod", artifact: "art-1", at: 1000, players: [{ u: 1, n: "Alpha", x: 1100, y: 5, z: 100, st: "alive" }, { u: 2, n: "Bravo", x: 1110, y: 5, z: 100, st: "alive" }] },
				{ job: "job-bbbbbbbb-2", branch: "dev", artifact: "art-2", at: 1000, players: [{ u: 3, n: "Charlie", x: 1120, y: 5, z: 120, st: "alive" }, { u: 4, n: "Ghost", st: "none" }] },
			],
		});
		render(
			<QueryClientProvider client={client()}>
				<MemoryRouter initialEntries={["/live"]}>
					<LivePage />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		await waitFor(() => expect(watchLiveMap).toHaveBeenCalled());
		await waitFor(() => expect(liveMap).toHaveBeenCalled());
		const scene = await screen.findByTestId("scene", {}, { timeout: 10_000 });
		await waitFor(() => expect(scene.dataset.layers).toBe("dot:job-aaaaaaaa-1:1,dot:job-aaaaaaaa-1:2,dot:job-bbbbbbbb-2:3"));
		const colors = (scene.dataset.colors ?? "").split(",");
		expect(colors[0]).toBe(colors[1]);
		const players = screen.getByRole("complementary", { name: "Players" });
		expect(within(players).getByText("Alpha")).toBeTruthy();
		expect(within(players).getByText("Charlie")).toBeTruthy();
		expect(within(players).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/servers/job-aaaaaaaa-1", "/servers/job-bbbbbbbb-2"]);
		expect(screen.getByText(/2 servers, 4 players/)).toBeTruthy();
	});

	it("moves each server's dots between its last two frames", () => {
		const servers = [
			{
				job: "j",
				branch: null,
				artifact: null,
				arrivedAt: 10_000,
				frames: [
					{ t: 0, s: { positions: { players: [{ u: 1, n: "A", x: 0, y: 0, z: 0, st: "alive" as const }] } } },
					{ t: 3000, s: { positions: { players: [{ u: 1, n: "A", x: 30, y: 0, z: 0, st: "alive" as const }] } } },
				],
			},
		];
		expect(liveDots(servers, 10_000)[0]?.x).toBeCloseTo(0);
		expect(liveDots(servers, 11_500)[0]?.x).toBeCloseTo(15);
		expect(liveDots(servers, 20_000)[0]?.x).toBeCloseTo(30);
	});
});
