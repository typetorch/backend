// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { Filters, QuitAutopsyResult, RecordingLayersResult, RecordingReplayResult, RecordingSessionsResult } from "@/lib/types";
import Recordings, { LayerControls, reasonLabel } from "./Recordings";
import { cone, frameAround, mapAtTime, markers, poseAt, shade, stateAtTime } from "./recordings/map";
import { ReplayPlayer } from "./recordings/ReplayPlayer";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const sampling = { recorded: 3, used: 3, sampled: false, failed: 0, capped: false, eventsCapped: false };

/** A 6 s session: 2 s in the lobby, then on Forest walking +x 1 stud per 100 ms. */
const replay: RecordingReplayResult = {
	found: true,
	sid: "s1",
	pid: "p1",
	art: "e4f5a6b-222222",
	dev: "phone",
	why: "left",
	start: 1_000_000,
	duration: 6_000,
	gaps: 0,
	chunks: 1,
	samples: [
		[0, 0, 3, 0, 0, 0],
		[1_000, 0, 3, 0, 0, 0],
		[2_000, 1000, 3, 1000, Math.PI / 2, 0],
		...Array.from({ length: 40 }, (_, i) => [2_100 + i * 100, 1001 + i, 3, 1000, Math.PI / 2, 0] as [number, number, number, number, number, number]),
	],
	inputs: [
		{ t: 0, type: "spawn" },
		{ t: 2_500, type: "key", code: 119 },
		{ t: 3_000, type: "button", target: "Shop/Buy" },
		{ t: 4_000, type: "screen_open", target: "Shop" },
	],
	events: [
		{ t: 0, kind: "session", name: "join", state: "zone:Lobby" },
		{ t: 2_000, kind: "zone", name: "enter", state: "zone:Arena" },
		{ t: 4_000, kind: "state", name: "screen", state: "zone:Arena|screen:Shop" },
		{ t: 5_000, kind: "custom", name: "down", state: "zone:Arena|screen:Shop" },
	],
	signals: [{ t: 3_000, kind: "repeated_clicks", amount: 3, target: "Shop/Buy" }],
	maps: [
		{ t: 0, map: "(lobby / unknown)" },
		{ t: 2_000, map: "Forest" },
	],
	map: "Forest",
	frame: { minX: 992, minZ: 992, maxX: 1048, maxZ: 1008, cell: 4, cols: 14, rows: 4 },
};

describe("replay helpers", () => {
	it("interpolates between samples, but not across a teleport", () => {
		const s = replay.samples ?? [];
		expect(poseAt(s, 2_150)).toMatchObject({ x: 1001.5, z: 1000 });
		expect(poseAt(s, 1_500)).toMatchObject({ x: 0, z: 0 });
		expect(poseAt(s, 99_000)).toMatchObject({ x: 1040 });
		expect(poseAt([], 0)).toBeNull();
	});
	it("the camera cone points along the yaw (0 = up on the map)", () => {
		const up = cone({ x: 0, z: 0, yaw: 0 }, 10, 0.0001);
		expect(up?.[1][0]).toBeCloseTo(0, 2);
		expect(up?.[1][1]).toBeCloseTo(-10, 2);
		const left = cone({ x: 0, z: 0, yaw: Math.PI / 2 }, 10, 0.0001);
		expect(left?.[1][0]).toBeCloseTo(-10, 2);
		expect(cone({ x: 0, z: 0, yaw: null })).toBeNull();
	});
	it("map and state at a moment; markers leave keys out", () => {
		expect(mapAtTime(replay.maps, 1_999)).toBe("(lobby / unknown)");
		expect(mapAtTime(replay.maps, 2_000)).toBe("Forest");
		expect(stateAtTime(replay, 4_500)).toEqual({ zone: "Arena", screen: "Shop" });
		expect(markers(replay).map((m) => m.label)).toEqual(["Spawned", "Button: Shop/Buy", "Pressed 3x: Shop/Buy", "Opened: Shop", "session / join", "custom / down"].sort((a, b) => {
			const t = (l: string) => ({ Spawned: 0, "session / join": 0, "Button: Shop/Buy": 3000, "Pressed 3x: Shop/Buy": 3000, "Opened: Shop": 4000, "custom / down": 5000 })[l] ?? 0;
			return t(a) - t(b);
		}));
	});
	it("shades and frames", () => {
		expect(shade(0, 10)).toBe(0);
		expect(shade(10, 10)).toBe(1);
		expect(shade(1, 100)).toBeGreaterThan(0.18);
		const f = frameAround([
			[0, 0],
			[100, 40],
		]);
		expect(f?.minX).toBeLessThanOrEqual(0);
		expect(f?.maxX).toBeGreaterThanOrEqual(100);
		expect(f?.cell).toBe(4);
		expect(frameAround([])).toBeNull();
	});
});

describe("the replay player", () => {
	it("the scrubber and the timeline marks move the dot and the clock", () => {
		render(<ReplayPlayer replay={replay} />);
		expect(screen.getByTestId("replay-clock").textContent).toBe("0:00.0 / 0:06.0");
		expect(screen.getByText(/Lobby \/ no map/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "3000" } });
		expect(screen.getByTestId("replay-clock").textContent).toContain("0:03.0");
		expect(screen.getByTestId("replay-dot").getAttribute("data-x")).toBe("1010.0");
		expect(screen.getByTestId("replay-cone")).toBeTruthy();
		expect(screen.getByText(/Forest · zone Arena/)).toBeTruthy();
		expect(within(screen.getByTestId("replay-recent")).getByText("Button: Shop/Buy")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "0:05.0 custom / down" }));
		expect(screen.getByTestId("replay-clock").textContent).toContain("0:05.0");
		expect(screen.getByText(/screen Shop/)).toBeTruthy();
		expect(screen.getByText("Ended: the player left")).toBeTruthy();
	});

	it("plays at the chosen speed and stops at the end", () => {
		vi.useFakeTimers();
		render(<ReplayPlayer replay={replay} />);
		fireEvent.click(screen.getByRole("button", { name: "2x" }));
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(screen.getByTestId("replay-clock").textContent).toContain("0:02.0");
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(screen.getByTestId("replay-clock").textContent).toContain("0:02.0");
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		act(() => {
			vi.advanceTimersByTime(10_000);
		});
		expect(screen.getByTestId("replay-clock").textContent).toBe("0:06.0 / 0:06.0");
		expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
	});
});

const layers: RecordingLayersResult = {
	mapKey: "map",
	maps: [
		{ map: "Forest", samples: 900, sessions: 3, events: 4 },
		{ map: "(lobby / unknown)", samples: 300, sessions: 3, events: 0 },
	],
	map: "Forest",
	frame: { minX: 0, minZ: 0, maxX: 40, maxZ: 40, cell: 4, cols: 10, rows: 10 },
	background: [
		[1, 1, 30],
		[2, 1, 10],
	],
	layers: [
		{ id: "path", label: "Positions", source: "recording", count: 40, sessions: 3, values: [], cells: [[1, 1, 40]], cellsCut: 0, examples: ["s1"] },
		{ id: "button", label: "Button presses", source: "recording", count: 5, sessions: 2, values: [{ value: "Shop/Buy", count: 4 }, { value: "HUD/Play", count: 1 }], cells: [[2, 1, 5]], cellsCut: 0, examples: ["s1"] },
		{ id: "ev:custom:down", label: "custom / down", source: "events", count: 4, sessions: 0, values: [], cells: [[3, 3, 4]], cellsCut: 0, examples: [] },
	],
	catalog: [{ kind: "custom", name: "down", count: 4 }],
	sampling,
	notes: [],
};

describe("layer controls", () => {
	it("toggles layers (recording and positioned), values and a split key", () => {
		const onToggle = vi.fn();
		const onValues = vi.fn();
		const onSplit = vi.fn();
		render(<LayerControls data={layers} active={["path", "button", "ev:custom:down"]} onToggle={onToggle} values={{ button: ["Shop/Buy"] }} onValues={onValues} split={{}} onSplit={onSplit} />);
		const group = screen.getByRole("group", { name: "Layers" });
		expect(within(group).getByRole("button", { name: /Positions/ }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(group).getByRole("button", { name: /Quits/ }));
		expect(onToggle).toHaveBeenCalledWith("quit");
		fireEvent.click(within(group).getByRole("button", { name: /down \(custom\)/ }));
		expect(onToggle).toHaveBeenCalledWith("ev:custom:down");
		const values = screen.getByTestId("values-button");
		expect(within(values).getByRole("button", { name: /Shop\/Buy/ }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(values).getByRole("button", { name: /HUD\/Play/ }));
		expect(onValues).toHaveBeenCalledWith("button", ["Shop/Buy", "HUD/Play"]);
		fireEvent.click(within(values).getByText("show all"));
		expect(onValues).toHaveBeenCalledWith("button", []);
		const split = screen.getByLabelText("Split down (custom) by a prop");
		fireEvent.change(split, { target: { value: "cause" } });
		fireEvent.keyDown(split, { key: "Enter" });
		expect(onSplit).toHaveBeenCalledWith("ev:custom:down", "cause");
	});
});

const sessions: RecordingSessionsResult = {
	total: 1,
	sessions: [{ sid: "s1", pid: "p1", art: "e4f5a6b-222222", dev: "phone", why: "left", start: 1_000_000, seconds: 6, samples: 43, inputs: 4, maps: ["Forest"], signals: { idle: 0, camera_spin: 0, repeated_clicks: 1 } }],
	sampling,
};

const autopsy: QuitAutopsyResult = {
	windowSeconds: 10,
	left: 2,
	stayed: 4,
	byWhy: [
		{ why: "window", sessions: 4 },
		{ why: "left", sessions: 2 },
	],
	rows: [
		{ reason: "idle", left: 2, leftShare: 1, stayed: 1, stayedShare: 0.25, lift: 4, examples: ["s1", "s2"] },
		{ reason: "screen", left: 1, leftShare: 0.5, stayed: 0, stayedShare: 0, lift: null, examples: ["s1"] },
		{ reason: "screen", value: "Shop", left: 1, leftShare: 0.5, stayed: 0, stayedShare: 0, lift: null, examples: ["s1"] },
	],
	sampling,
};

function mockApi() {
	const calls: { name: string; options: Record<string, unknown> }[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: Filters = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, options });
		if (name === "recording-layers") return { ...layers, layers: layers.layers.filter((l) => ((options.layers as string[] | undefined) ?? []).includes(l.id)) };
		if (name === "recording-sessions") return sessions;
		if (name === "recording-replay") return replay;
		if (name === "quit-autopsy") return autopsy;
		throw new Error(`unexpected ${name}`);
	}) as typeof api.query);
	return calls;
}

function mount(path: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Recordings />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("Recordings page", { timeout: 20_000 }, () => {
	it("map layers: toggling a layer asks for it; a cell click lists its sessions; a replay opens", async () => {
		const calls = mockApi();
		mount("/recordings?layers=path");
		await screen.findByRole("img", { name: "Map Forest" });
		expect(calls[0]).toMatchObject({ name: "recording-layers", options: { layers: ["path"] } });
		fireEvent.click(within(screen.getByRole("group", { name: "Layers" })).getByRole("button", { name: /Button presses/ }));
		await waitFor(() => expect(calls.some((c) => c.name === "recording-layers" && (c.options.layers as string[]).join() === "path,button")).toBe(true));
		await screen.findByTestId("values-button");
		const svg = screen.getByRole("img", { name: "Map Forest" });
		svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
		fireEvent.click(svg, { clientX: 25, clientY: 15 });
		await waitFor(() => expect(calls.some((c) => c.name === "recording-sessions")).toBe(true));
		expect(calls.find((c) => c.name === "recording-sessions")?.options).toMatchObject({ map: "Forest", box: [8, 4, 12, 8], layer: "button" });
		fireEvent.click(await screen.findByRole("button", { name: "Replay s1" }));
		await screen.findByTestId("replay-clock");
		expect(calls.some((c) => c.name === "recording-replay" && c.options.sid === "s1")).toBe(true);
	});

	it("replay tab: the First session page's signal link filters the session list", async () => {
		const calls = mockApi();
		mount("/recordings?tab=replay&signal=repeated_clicks&target=Shop%2FBuy");
		await screen.findByRole("button", { name: "Replay s1" });
		expect(calls.find((c) => c.name === "recording-sessions")?.options).toMatchObject({ signal: "repeated_clicks", target: "Shop/Buy" });
		expect(screen.getByText(/repeated clicks on Shop\/Buy/)).toBeTruthy();
	});

	it("quit autopsy: reasons with lift, per-screen rows, examples open the replay", async () => {
		const calls = mockApi();
		mount("/recordings?tab=autopsy");
		const table = await screen.findByRole("table", { name: "Reason" });
		expect(within(table).getByText("Idle (no input, not moving)")).toBeTruthy();
		expect(within(table).getByText(/^4(\.0)?x$/)).toBeTruthy();
		expect(within(screen.getByRole("table", { name: "Screen" })).getByText("Shop")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "20 s" }));
		await waitFor(() => expect(calls.some((c) => c.name === "quit-autopsy" && c.options.windowSeconds === 20)).toBe(true));
		fireEvent.click(within(screen.getByRole("table", { name: "Screen" })).getByRole("button", { name: "Replay s1" }));
		await screen.findByTestId("replay-clock");
	});

	it("reason labels", () => {
		expect(reasonLabel({ reason: "dead_clicks" })).toBe("Presses that changed nothing");
		expect(reasonLabel({ reason: "tutorial", value: "tutorial step 2" })).toBe("tutorial step 2");
	});
});
