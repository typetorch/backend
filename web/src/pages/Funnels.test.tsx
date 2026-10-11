// @vitest-environment jsdom
/** The Funnels page: one funnel's steps, or two side by side with their headline numbers (?compare=). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FunnelPlayers, FunnelResult, PlaytimeFunnelResult } from "@/lib/types";
import Funnels, { fmtPlaytime } from "./Funnels";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const step = (n: number, label: string, reached: number, start: number, previous: number) => ({
	step: n,
	label,
	reached,
	ofStart: reached / start,
	fromPrevious: reached / previous,
	logged: reached,
	medianSecondsFromStart: n * 10,
});

const FUNNELS: Record<string, FunnelResult> = {
	v1_tutorial: { funnel: "v1_tutorial", players: 100, steps: [step(1, "joined", 100, 100, 100), step(2, "moved", 60, 100, 100), step(3, "done", 40, 100, 60)], biggestDrop: { step: 2, lost: 40, share: 0.4 } },
	v3_tutorial: { funnel: "v3_tutorial", players: 80, steps: [step(1, "joined", 80, 80, 80), step(2, "moved", 72, 80, 80), step(3, "done", 60, 80, 72)], biggestDrop: { step: 3, lost: 12, share: 0.1667 } },
};

const SECONDS = [30, 60, 180, 300, 600, 1800, 3600, 7200];
const LABELS = ["30s", "1m", "3m", "5m", "10m", "30m", "1h", "2h"];
function playtime(measure: "total" | "first", players: number, reached: number[]): PlaytimeFunnelResult {
	return {
		measure,
		players,
		sessionCapHours: 12,
		steps: SECONDS.map((seconds, i) => ({
			seconds,
			label: LABELS[i],
			reached: reached[i],
			ofTotal: reached[i] / players,
			fromPrevious: reached[i] / (i ? reached[i - 1] : players),
		})),
		biggestDrop: { seconds: 60, lost: reached[0] - reached[1], share: (reached[0] - reached[1]) / reached[0] },
	};
}
const PLAYTIME = {
	total: playtime("total", 200, [180, 120, 90, 70, 50, 30, 20, 10]),
	first: playtime("first", 50, [40, 25, 15, 10, 5, 3, 2, 1]),
};
let playtimeCalls: string[] = [];
let playerCalls: object[] = [];

function funnelPlayers(options: { funnel?: string; measure?: "total" | "first"; step: number; mode: "reached" | "dropped" }): FunnelPlayers {
	if (options.measure) {
		return {
			funnel: null,
			measure: options.measure,
			step: options.step,
			mode: options.mode,
			total: 1,
			more: 0,
			players: [{ pid: "pid-play", at: null, lastStep: null, lastStepAt: null, playtimeSeconds: 330, lastAt: "2026-10-09T11:30:00.000Z" }],
		};
	}
	return {
		funnel: options.funnel ?? null,
		measure: null,
		step: options.step,
		mode: options.mode,
		total: 250,
		more: 248,
		players: [
			{ pid: "pid-aaaa", at: "2026-10-09T11:00:00.000Z", lastStep: 3, lastStepAt: "2026-10-09T11:01:00.000Z", lastAt: "2026-10-09T11:30:00.000Z", uid: 4242, name: "Tester", displayName: "Test Player" },
			{ pid: "pid-bbbb", at: "2026-10-09T10:00:00.000Z", lastStep: 1, lastStepAt: "2026-10-09T10:00:00.000Z", lastAt: "2026-10-09T10:10:00.000Z" },
		],
	};
}

beforeEach(() => {
	playtimeCalls = [];
	playerCalls = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: { funnel?: string; measure?: "total" | "first" } = {}) => {
		if (name === "playtime-funnel") {
			playtimeCalls.push(options.measure ?? "total");
			return PLAYTIME[options.measure ?? "total"];
		}
		if (name === "funnel-players") {
			playerCalls.push(options);
			return funnelPlayers(options as never);
		}
		if (name !== "funnel") throw new Error(`unexpected query ${name}`);
		if (!options.funnel) return { funnel: null, funnels: [{ name: "v1_tutorial", players: 100, events: 200 }, { name: "v3_tutorial", players: 80, events: 210 }] };
		return FUNNELS[options.funnel];
	}) as typeof api.query);
});

function Where() {
	const { pathname, search } = useLocation();
	return <div data-testid="where">{`${pathname}${search}`}</div>;
}

function mount(query = "") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[`/funnels${query}`]}>
				<Routes>
					<Route path="/funnels" element={<Funnels />} />
					<Route path="/players" element={<div>Players page</div>} />
				</Routes>
				<Where />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}
const where = () => screen.getByTestId("where").textContent ?? "";

describe("Funnels", () => {
	it("shows one funnel without compare", async () => {
		mount();
		expect(await screen.findByText("v1_tutorial: 100 players started")).toBeTruthy();
		expect(screen.queryByText(/ vs /)).toBeNull();
		expect(screen.getByRole("combobox", { name: "Compare with" })).toBeTruthy();
	});

	it("compares two funnels side by side", async () => {
		mount("?funnel=v1_tutorial&compare=v3_tutorial");
		expect(await screen.findByText("v1_tutorial: 100 players started")).toBeTruthy();
		expect(await screen.findByText("v3_tutorial: 80 players started")).toBeTruthy();
		expect(await screen.findByText("v1_tutorial vs v3_tutorial")).toBeTruthy();
		// 40% vs 75% completed: 35 points more.
		await waitFor(() => expect(screen.getByText(/35 points more than/)).toBeTruthy());
		expect(screen.getByRole("button", { name: "Swap funnels" })).toBeTruthy();
	});

	it("ignores compare with itself", async () => {
		mount("?funnel=v1_tutorial&compare=v1_tutorial");
		expect(await screen.findByText("v1_tutorial: 100 players started")).toBeTruthy();
		expect(screen.queryByText(/ vs /)).toBeNull();
	});

	it("shows the built-in total playtime funnel: steps, share of all players and of the previous step", async () => {
		mount("?funnel=playtime:total");
		expect(await screen.findByText("Playtime: total: 200 players")).toBeTruthy();
		expect(screen.getByText("≥ 30s")).toBeTruthy();
		expect(screen.getByText("≥ 2h")).toBeTruthy();
		expect(screen.getByText("90% of all players")).toBeTruthy();
		expect(screen.getAllByText("66.7% from previous").length).toBe(2);
		expect(screen.queryByText(/median/)).toBeNull();
		expect(playtimeCalls).toEqual(["total"]);
	});

	it("falls back to the playtime funnel when no funnel is logged", async () => {
		vi.mocked(api.query).mockImplementation((async (name: string, _f: unknown, options: { measure?: "total" | "first" } = {}) =>
			name === "playtime-funnel" ? PLAYTIME[options.measure ?? "total"] : { funnel: null, funnels: [] }) as typeof api.query);
		mount();
		expect(await screen.findByText("Playtime: total: 200 players")).toBeTruthy();
	});

	it("compares first session with total playtime", async () => {
		mount("?funnel=playtime:first&compare=playtime:total");
		expect(await screen.findByText("Playtime: first session: 50 new players")).toBeTruthy();
		expect(await screen.findByText("Playtime: total: 200 players")).toBeTruthy();
		expect(await screen.findByText("Playtime: first session vs Playtime: total")).toBeTruthy();
		// 2% vs 5% reached 2 h: 3 points more.
		await waitFor(() => expect(screen.getByText(/3 points more than/)).toBeTruthy());
		expect(screen.getByText("80% of new players")).toBeTruthy();
		expect([...playtimeCalls].sort()).toEqual(["first", "total"]);
	});
});

describe("Funnels: the players at a step", () => {
	it("a click on a step opens who reached it (links to their page and Roblox profile); the toggle shows who dropped off there", async () => {
		mount("?funnel=v1_tutorial&range=7d");
		const row = await screen.findByRole("button", { name: "Open players at step 2 moved of v1_tutorial" });
		expect(row.getAttribute("tabindex")).toBe("0");
		fireEvent.click(row);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("v1_tutorial: step 2 (moved)")).toBeTruthy();
		const table = await within(dialog).findByRole("table", { name: "Players who reached this step" });
		const link = within(table).getByRole("link", { name: "Test Player (@Tester)" });
		expect(link.getAttribute("href")).toBe("/players?range=7d&pid=pid-aaaa");
		expect(within(table).getByRole("link", { name: /UserId 4242/ }).getAttribute("href")).toContain("4242");
		expect(within(table).getByText("not linked")).toBeTruthy();
		expect(within(dialog).getByText(/The 2 most recent, of 250/)).toBeTruthy();
		expect(playerCalls.at(-1)).toEqual({ funnel: "v1_tutorial", step: 2, mode: "reached" });
		expect(where()).toContain("stepFunnel=v1_tutorial&step=2");
		// Counts on the toggle come from the funnel: 60 reached, 100 - 60 dropped.
		expect(within(dialog).getByRole("radio", { name: "Reached (60)" })).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("radio", { name: "Dropped off here (40)" }));
		await waitFor(() => expect(playerCalls.at(-1)).toEqual({ funnel: "v1_tutorial", step: 2, mode: "dropped" }));
		expect(where()).toContain("stepMode=dropped");
		const dropped = await within(dialog).findByRole("table", { name: "Players who dropped off here" });
		expect(within(dropped).getByText("3. done")).toBeTruthy();
		expect(within(dropped).getByText("1. joined")).toBeTruthy();
		fireEvent.click(within(dropped).getByRole("link", { name: "pid-bbbb" }));
		expect(await screen.findByText("Players page")).toBeTruthy();
		expect(where()).toBe("/players?range=7d&pid=pid-bbbb");
	});

	it("Enter on a playtime step opens it with the threshold and shows each player's playtime", async () => {
		mount("?funnel=playtime:total");
		const row = await screen.findByRole("button", { name: "Open players at ≥ 1m of Playtime: total" });
		fireEvent.keyDown(row, { key: "Enter" });
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Playtime: total: ≥ 1m")).toBeTruthy();
		expect(await within(dialog).findByText("5m 30s")).toBeTruthy();
		expect(playerCalls.at(-1)).toEqual({ measure: "total", step: 60, mode: "reached" });
		// The first step: the drop-off is the base minus who reached it (200 - 180).
		fireEvent.keyDown(screen.getByRole("button", { name: "Open players at ≥ 30s of Playtime: total", hidden: true }), { key: " " });
		await waitFor(() => expect(playerCalls.at(-1)).toEqual({ measure: "total", step: 30, mode: "reached" }));
		expect(within(screen.getByRole("dialog")).getByRole("radio", { name: "Dropped off here (20)" })).toBeTruthy();
	});

	it("in the compare view, Space on the second funnel's step opens that funnel", async () => {
		mount("?funnel=v1_tutorial&compare=v3_tutorial");
		fireEvent.keyDown(await screen.findByRole("button", { name: "Open players at step 3 done of v3_tutorial" }), { key: " " });
		expect(await screen.findByText("v3_tutorial: step 3 (done)")).toBeTruthy();
		await waitFor(() => expect(playerCalls.at(-1)).toEqual({ funnel: "v3_tutorial", step: 3, mode: "reached" }));
		expect(screen.getByRole("button", { name: "Open players at step 3 done of v3_tutorial", hidden: true }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "Open players at step 3 done of v1_tutorial", hidden: true }).getAttribute("aria-pressed")).toBe("false");
	});

	it("a shared link opens the sheet on that funnel, step and mode; closing it clears them", async () => {
		mount("?funnel=v1_tutorial&compare=playtime:first&stepFunnel=playtime:first&step=180&stepMode=dropped");
		const dialog = await screen.findByRole("dialog");
		await waitFor(() => expect(playerCalls.at(-1)).toEqual({ measure: "first", step: 180, mode: "dropped" }));
		expect(within(dialog).getByRole("radio", { name: /Dropped off here/ }).getAttribute("aria-checked")).toBe("true");
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(where()).not.toContain("step");
	});

	it("formats playtime", () => {
		expect([fmtPlaytime(45), fmtPlaytime(60), fmtPlaytime(330), fmtPlaytime(3600), fmtPlaytime(3900)]).toEqual(["45s", "1m", "5m 30s", "1h", "1h 5m"]);
	});
});
