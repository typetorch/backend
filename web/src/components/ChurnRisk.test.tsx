// @vitest-environment jsdom
/**
 * Churn risk on the Players page: the bucket tiles (counts, shares, payers), the picked bucket's list (in the URL as
 * `risk`), the opt-in column for owners, the last-90-days filters, and the Risk column in the players list.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { ChurnResult, PlayersResult } from "@/lib/types";
import Players from "@/pages/Players";
import { churnFilters, ChurnRisk } from "./ChurnRisk";

vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});

const player = (pid: string, bucket: ChurnResult["list"][number]["bucket"], extra: object = {}) => ({
	pid,
	bucket,
	firstPlayed: "2026-09-01",
	lastPlayed: "2026-11-11",
	daysSince: 4,
	usualGap: 1,
	playDays: 20,
	recentDays: 3,
	priorDays: 10,
	...extra,
});

const result = (bucket: ChurnResult["bucket"], list: ChurnResult["list"]): ChurnResult => ({
	from: "",
	to: "",
	asOf: "2026-11-15",
	players: 100,
	buckets: [
		{ bucket: "active", players: 60, share: 0.6 },
		{ bucket: "at_risk", players: 20, share: 0.2 },
		{ bucket: "lapsing", players: 15, share: 0.15 },
		{ bucket: "churned", players: 5, share: 0.05 },
	],
	payers: { active: 9, at_risk: 3, lapsing: 0, churned: 1 },
	bucket,
	list,
	total: list.length,
	more: 0,
});

function Where() {
	return <output data-testid="search">{useLocation().search}</output>;
}

function mount(node: React.ReactNode, url = "/players") {
	const calls: { name: string; filters: Record<string, unknown>; options: Record<string, unknown> }[] = [];
	vi.spyOn(api, "identitySummary").mockResolvedValue({ count: 0, backfill: false });
	vi.spyOn(api, "identity").mockResolvedValue([]);
	vi.spyOn(api, "query").mockImplementation((async (name: string, filters: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, filters, options });
		if (name === "churn") {
			if (Array.isArray(options.pids)) return result(null, [player("pid-alpha-0001", "lapsing")]);
			return options.bucket === "churned"
				? result("churned", [player("pid-gone-0009", "churned", { daysSince: 40 })])
				: result("at_risk", [player("pid-late-0001", "at_risk", { uid: 1001, name: "late_one", optin: "subscribed" }), player("pid-late-0002", "at_risk", { optin: null })]);
		}
		if (name === "players") {
			const players: PlayersResult = {
				players: [{ pid: "pid-alpha-0001", firstSeen: "2026-11-01T00:00:00.000Z", lastSeen: "2026-11-11T00:00:00.000Z", sessions: 3, events: 30, playtimeMinutes: 40, newInRange: false, robux: 0 }],
			};
			return players;
		}
		throw new Error(`unexpected ${name}`);
	}) as typeof api.query);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={[url]}>
				<TooltipProvider>
					{node}
					<Where />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return calls;
}

describe("churn risk", () => {
	it("the last 90 days, the filter bar's other filters kept", () => {
		expect(churnFilters({ from: "2026-11-14", to: "2026-11-15", country: "US" }, Date.UTC(2026, 10, 15, 12))).toEqual({ country: "US", from: "2026-08-18" });
	});

	it("tiles with counts, shares and payers; the at-risk list with the opt-in for owners; a tile picks the bucket", async () => {
		const onPick = vi.fn();
		const calls = mount(<ChurnRisk onPick={onPick} />, "/players?country=BR");
		const table = await screen.findByRole("table", { name: "Churn risk players" });
		expect(calls[0]).toMatchObject({ name: "churn", options: { bucket: "at_risk", limit: 500 } });
		expect(calls[0]?.filters).toMatchObject({ country: "BR" });
		const tiles = screen.getByRole("group", { name: "Churn risk buckets" });
		expect(within(tiles).getByRole("button", { name: /At risk/ }).getAttribute("aria-pressed")).toBe("true");
		expect(within(tiles).getByText("20% of players, 3 payers")).toBeTruthy();
		expect(within(table).getByText("@late_one")).toBeTruthy();
		expect(within(table).getByText("Subscribed")).toBeTruthy();
		expect(within(table).getByText("Unknown")).toBeTruthy();
		expect(screen.getByText(/1 of them is subscribed to notifications/)).toBeTruthy();
		fireEvent.click(within(table).getByText("@late_one"));
		expect(onPick).toHaveBeenCalledWith("pid-late-0001");

		fireEvent.click(within(tiles).getByRole("button", { name: /Churned/ }));
		await waitFor(() => expect(screen.getByTestId("search").textContent).toContain("risk=churned"));
		// The churned player (40 days away) replaces the at-risk list.
		await waitFor(() => expect(within(screen.getByRole("table", { name: "Churn risk players" })).getByText("40")).toBeTruthy());
		expect(screen.queryByText("@late_one")).toBeNull();
		// No opt-in on the rows (the web role, or nobody known): no Notifications column.
		expect(screen.queryByText("Notifications")).toBeNull();
	});

	it("the Players list gets a Risk column from one lookup of the listed pids", async () => {
		const calls = mount(<Players />);
		const list = await screen.findByRole("table", { name: "Players" });
		await waitFor(() => expect(within(list).getByText("Lapsing")).toBeTruthy());
		expect(within(list).getByText("Risk")).toBeTruthy();
		expect(calls.find((c) => c.name === "churn" && Array.isArray(c.options.pids))?.options.pids).toEqual(["pid-alpha-0001"]);
	});
});
