// @vitest-environment jsdom
/** The Funnels page: one funnel's steps, or two side by side with their headline numbers (?compare=). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FunnelResult, PlaytimeFunnelResult } from "@/lib/types";
import Funnels from "./Funnels";

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

beforeEach(() => {
	playtimeCalls = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: { funnel?: string; measure?: "total" | "first" } = {}) => {
		if (name === "playtime-funnel") {
			playtimeCalls.push(options.measure ?? "total");
			return PLAYTIME[options.measure ?? "total"];
		}
		if (name !== "funnel") throw new Error(`unexpected query ${name}`);
		if (!options.funnel) return { funnel: null, funnels: [{ name: "v1_tutorial", players: 100, events: 200 }, { name: "v3_tutorial", players: 80, events: 210 }] };
		return FUNNELS[options.funnel];
	}) as typeof api.query);
});

function mount(query = "") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[`/funnels${query}`]}>
				<Funnels />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

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
