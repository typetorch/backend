// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import type { RobloxAcquisition as Acquisition } from "@/lib/types";
import { ACQUISITION_CARDS, ANALYTICS_SCOPE, RobloxAcquisition } from "./RobloxAcquisition";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const acquisition: Acquisition = {
	source: "roblox",
	days: 7,
	metrics: { playThroughHome: "RFYPlayThroughRate", qualifiedPlayThrough: "QualifiedEndToEndCVR", impressions: "UniqueUsersWithImpressions", qualifiedPlays: "QualifiedUniqueUsersWithPlaySessions" },
	current: { from: "2026-10-02T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z", daysWithData: 7, playThroughHome: 0.0169, qualifiedPlayThrough: 0.0123, impressions: 12345, qualifiedPlays: 210 },
	previous: { from: "2026-09-25T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z", daysWithData: 7, playThroughHome: 0.02, qualifiedPlayThrough: 0.01, impressions: 10000, qualifiedPlays: 100 },
	daily: [],
	sources: [
		{ source: "HomeRecommendations", label: "Home recommendations", impressions: 9000, qualifiedPlays: 180, rate: 0.02 },
		{ source: "Search", label: "Search", impressions: 3345, qualifiedPlays: 30, rate: 0.008969 },
	],
	fetchedAt: "2026-10-09T12:00:00.000Z",
	cached: false,
};

function mount(bench?: { p50: number; p90: number }) {
	const onSet = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RobloxAcquisition days={7} {...(bench ? { bench } : {})} onSet={onSet} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
	return onSet;
}

describe("RobloxAcquisition", () => {
	it("shows Roblox's play-through rate, impressions and plays with the source badge, against the typed benchmark", async () => {
		const spy = vi.spyOn(api, "robloxAcquisition").mockResolvedValue(acquisition);
		mount({ p50: 1.97, p90: 4.28 });
		expect(await screen.findByText("1.69%")).toBeTruthy();
		expect(spy).toHaveBeenCalledWith(7, expect.anything());
		expect(screen.getByText("Play-through rate (home recommendations)")).toBeTruthy();
		expect(screen.getByText("1.23%")).toBeTruthy();
		expect(screen.getByText("12,345")).toBeTruthy();
		expect(screen.getByText("210")).toBeTruthy();
		expect(screen.getAllByText("source: Roblox").length).toBe(ACQUISITION_CARDS.length + 1);
		expect(screen.getByText("50th 1.97 · 90th 4.28")).toBeTruthy();
		// The sources table: Roblox's display name and the period's plays per impression.
		expect(screen.getByText("Home recommendations")).toBeTruthy();
		expect(screen.getByText("0.90%")).toBeTruthy();
		expect(screen.getByText("Roblox's RFYPlayThroughRate")).toBeTruthy();
	});

	it("says how to turn it on when the backend answers 409, and shows other failures", async () => {
		vi.spyOn(api, "robloxAcquisition").mockRejectedValue(new ApiError(409, "Roblox analytics are off", "/v1/roblox/analytics/acquisition"));
		mount();
		expect(await screen.findByText(ANALYTICS_SCOPE)).toBeTruthy();
		cleanup();
		vi.spyOn(api, "robloxAcquisition").mockRejectedValue(new ApiError(502, "POST ... -> 403 (the API key needs universe.analytics:read)", "/v1/roblox/analytics/acquisition"));
		mount();
		expect(await screen.findByText("Roblox didn't answer")).toBeTruthy();
	});

	it("marks a period Roblox hasn't filled yet", async () => {
		vi.spyOn(api, "robloxAcquisition").mockResolvedValue({ ...acquisition, current: { ...acquisition.current, daysWithData: 5 } });
		mount();
		expect((await screen.findAllByText("5 of 7 days have data")).length).toBe(ACQUISITION_CARDS.length);
	});
});
