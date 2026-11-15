// @vitest-environment jsdom
/**
 * plans/36 on the Recordings page: an extended session opens in the Player view (cam=map / cam=player in the URL) with
 * the recorded UI, click / tap rings, captions, AFK, the FPS strip, the people on screen and their animations, and
 * picks (a UI node's properties, an entity's); a session without extended data opens on the map and can switch to the
 * Player view; the sessions list badges extended sessions. PlayerScene and MapScene are mocked (jsdom has no WebGL).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { clearAnimClips } from "@/lib/anim-clips";
import { clearAssetImages } from "@/lib/asset-images";
import type { Filters, RecordingReplayResult, RecordingSessionsResult } from "@/lib/types";
import Recordings from "./Recordings";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/components/maps/MapScene", () => ({ default: (props: { label?: string }) => <div data-testid="scene" aria-label={props.label} /> }));
vi.mock("@/components/maps/PlayerScene", () => ({
	default: (props: { camera: string; t: number; clips?: ReadonlyMap<string, unknown>; onPick?: (e: number | null) => void }) => (
		<div data-testid="player-scene" data-camera={props.camera} data-t={props.t} data-clips={[...(props.clips?.entries() ?? [])].map(([id, c]) => `${id}:${c ? "yes" : "no"}`).join(",")}>
			<button type="button" onClick={() => props.onPick?.(1)}>
				pick zombie
			</button>
		</div>
	),
}));

const extended: RecordingReplayResult = {
	found: true,
	sid: "x1",
	pid: "p1",
	art: "abc",
	dev: "desktop",
	why: "window",
	start: 1_000_000,
	duration: 10_000,
	gaps: 0,
	chunks: 1,
	samples: Array.from({ length: 101 }, (_, i) => [i * 100, i, 3, 0, 0, 0, 0, i, 8, 10] as [number, number, number, number, number, number, number, number, number, number]),
	inputs: [
		{ t: 1_000, type: "click", x: 0.5, y: 0.5, processed: true },
		{ t: 1_100, type: "button", target: "HUD/Play" },
	],
	events: [],
	signals: [],
	maps: [{ t: 0, map: "Forest" }],
	map: "Forest",
	frame: null,
	fps: [[0, 60]],
	extended: {
		chunks: 1,
		gaps: 0,
		skipped: 0,
		view: [
			[0, 1000, 500, 36, 80, 60],
			[1_000, 1000, 500, 36, 80, 24],
		],
		afk: [[6_000, 8_000]],
		rigs: [{ t: 0, e: 1, rig: "R6", joints: ["RootJoint"] }],
		poses: [],
		entities: [{ e: 1, kind: "zombie", humanoid: true, player: false, size: [4, 5, 1], from: 0, to: null, moves: [[0, 5, 3, 5, 0]] }],
		anims: [{ e: 1, track: 1, id: "rbxassetid://123", from: 0, to: null, looped: true, time: 0, adjust: [[0, 1, 1]] }],
		ui: [
			{ i: 0, cls: 0, from: 0, to: null, parent: null, f: { order: 0, rect: [0, 0, 1000, 464] } },
			{ i: 1, cls: 2, from: 0, to: null, parent: 0, f: { rect: [10, 10, 200, 40], order: 1, text: "Coins: 10", textStyle: { color: "#ffffff", transparency: 0, size: 20, family: "", weight: 400, xAlign: 1, yAlign: 1, scaled: false, wrapped: false, rich: false, strokeTransparency: 1, strokeColor: "#000000" } } },
		],
	},
};

const plain: RecordingReplayResult = { ...extended, sid: "p2", extended: null, samples: extended.samples?.map((s) => s.slice(0, 6) as never) };

const sessions: RecordingSessionsResult = {
	total: 2,
	sessions: [
		{ sid: "x1", pid: "p1", art: "abc", dev: "desktop", why: "window", start: 1_000_000, seconds: 10, samples: 101, inputs: 2, maps: ["Forest"], signals: { idle: 0, camera_spin: 0, repeated_clicks: 0 }, extended: true },
		{ sid: "p2", pid: "p2", art: "abc", dev: "phone", why: "left", start: 1_000_000, seconds: 10, samples: 101, inputs: 2, maps: ["Forest"], signals: { idle: 0, camera_spin: 0, repeated_clicks: 0 } },
	],
	sampling: { recorded: 2, used: 2, sampled: false, failed: 0, capped: false, eventsCapped: false },
};

let location = "";
function Where() {
	location = useLocation().search;
	return null;
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			const url = String(input);
			if (url === "/api/v1/maps") return Response.json({ configured: true, canExport: false, export: { state: "idle", step: "", startedAt: null, finishedAt: null, by: null, error: null }, latest: null, placeVersion: { latest: null, source: null, exported: null, outOfDate: false }, maps: [], names: [], overrides: {}, history: [] });
			if (url === "/api/v1/anims/123") return Response.json({ id: "123", length: 1, looped: true, keyframes: [{ t: 0, poses: { Torso: [0, 0, 0, 1] } }] });
			return new Response("{}", { status: 404 });
		}),
	);
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: Filters = {}, options: Record<string, unknown> = {}) => {
		if (name === "recording-sessions") return sessions;
		if (name === "recording-replay") return options.sid === "x1" ? extended : plain;
		if (name === "recording-layers") return { map: "Forest", maps: [], frame: null, background: [], layers: [], catalog: [], sampling: sessions.sampling, notes: [] };
		throw new Error(`unexpected ${name}`);
	}) as typeof api.query);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearAssetImages();
	clearAnimClips();
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

describe("extended replays (plans/36)", () => {
	it("the sessions list badges extended sessions", async () => {
		mount("/recordings?tab=replay");
		const row = (await screen.findByText("Extended")).closest("tr") as HTMLElement;
		expect(within(row).getByRole("button", { name: "Replay x1" })).toBeTruthy();
		expect(screen.getAllByText("Extended")).toHaveLength(1);
	});

	it("an extended session opens in the Player view: viewport aspect, FOV, the UI, the people, picks", async () => {
		mount("/recordings?tab=replay&sid=x1");
		const viewport = await screen.findByTestId("player-viewport");
		expect(viewport.dataset.aspect).toBe("2.000");
		expect((await screen.findByTestId("player-scene")).dataset.camera).toBe("player");
		expect(screen.getByText(/1000x500 px, FOV 80/)).toBeTruthy();
		// the clip for the zombie's animation arrives
		await waitFor(() => expect(screen.getByTestId("player-scene").dataset.clips).toBe("123:yes"));
		expect(within(screen.getByTestId("player-entities")).getByText(/playing 123/)).toBeTruthy();
		// the recorded UI, and its properties on a click
		fireEvent.click(screen.getByText("Coins: 10"));
		expect(await screen.findByTestId("ui-properties")).toBeTruthy();
		// an entity pick from the scene
		fireEvent.click(screen.getByRole("button", { name: "pick zombie" }));
		const props = await screen.findByTestId("entity-properties");
		expect(within(props).getByText("zombie")).toBeTruthy();
		expect(within(props).getByText(/rbxassetid:\/\/123/)).toBeTruthy();
		// the strips: AFK, captions, fps (from View records)
		expect(screen.getAllByTestId("replay-afk")).toHaveLength(1);
		expect(within(screen.getByTestId("replay-captions")).getByText("Button: HUD/Play")).toBeTruthy();
		expect(screen.getByTestId("replay-fps")).toBeTruthy();
		expect(screen.getByText("60 fps")).toBeTruthy();
	});

	it("the scrubber: tap rings and captions over the Player view, AFK, the free camera; cam=map in the URL", async () => {
		mount("/recordings?tab=replay&sid=x1");
		await screen.findByTestId("player-scene");
		fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "1200" } });
		expect(screen.getAllByTestId("tap-ring")).toHaveLength(1);
		expect(screen.getByTestId("player-caption").textContent).toBe("Button: HUD/Play");
		expect(screen.getByText("24 fps")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "7000" } });
		expect(screen.getByText(/AFK: extended streams paused/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Free camera" }));
		expect(screen.getByTestId("player-scene").dataset.camera).toBe("orbit");
		fireEvent.click(within(screen.getByRole("group", { name: "Replay view" })).getByRole("button", { name: "Map" }));
		await waitFor(() => expect(location).toContain("cam=map"));
		expect(screen.queryByTestId("player-view")).toBeNull();
	});

	it("a session without extended data opens on the map; the Player view works from today's data", async () => {
		mount("/recordings?tab=replay&sid=p2");
		await screen.findByTestId("replay-clock");
		expect(screen.queryByTestId("player-view")).toBeNull();
		fireEvent.click(within(screen.getByRole("group", { name: "Replay view" })).getByRole("button", { name: "Player view" }));
		await waitFor(() => expect(location).toContain("cam=player"));
		expect((await screen.findByTestId("player-scene")).dataset.camera).toBe("player");
		expect(screen.getByText(/FOV 70 \(assumed: no extended data\)/)).toBeTruthy();
		expect(screen.queryByTestId("ui-overlay")).toBeNull();
	});
});
