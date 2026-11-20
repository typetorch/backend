// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { LtvResult, RetentionResult } from "@/lib/types";
import Retention, { RETENTION_DAYS, retentionPct } from "./Retention";
import { LTV_DAYS, ltvText } from "./RetentionLtv";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Retention page", () => {
	it("asks for every day from 1 to 30 and shows a column for each (D2, D4, D5 too)", async () => {
		const days = Array.from({ length: 30 }, (_, i) => i + 1);
		const cell = (v: number | null) => Object.fromEntries(days.map((d) => [String(d), v]));
		const result: RetentionResult = {
			from: "2026-11-10T00:00:00.000Z",
			to: "2026-11-14T00:00:00.000Z",
			days,
			cohorts: [{ date: "2026-11-11", size: 480, kept: { ...cell(null), "1": 10 / 480, "2": 5 / 480 }, keptPlayers: { ...cell(null), "1": 10, "2": 5 } }],
			average: { ...cell(null), "1": 10 / 480, "2": 5 / 480 },
		};
		const calls: Record<string, unknown>[] = [];
		vi.spyOn(api, "query").mockImplementation((async (_name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
			calls.push(options);
			return result;
		}) as typeof api.query);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter>
					<TooltipProvider>
						<Retention />
					</TooltipProvider>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		expect(RETENTION_DAYS).toEqual(days);
		for (const h of ["D1", "D2", "D4", "D5", "D30"]) expect(await screen.findByText(h)).toBeTruthy();
		expect(calls[0]?.days).toEqual(days);
		expect(screen.getByText("(5)")).toBeTruthy();
		// 2 decimals: 10 / 480 = 2.08%, 5 / 480 = 1.04% (the cohort row and the weighted average).
		expect(screen.getAllByText("2.08%").length).toBe(2);
		expect(screen.getAllByText("1.04%").length).toBe(2);
	});

	it("in-progress cells: orange so far, a click switches to the gray prediction for midnight UTC and back", async () => {
		const result: RetentionResult = {
			from: "2026-11-10T00:00:00.000Z",
			to: "2026-11-19T12:37:00.000Z",
			days: [1],
			cohorts: [{ date: "2026-11-18", size: 1307, kept: { "1": null }, keptPlayers: { "1": null }, partial: { "1": 0.0321 }, partialPlayers: { "1": 42 }, forecast: { "1": 0.0505 }, forecastPlayers: { "1": 66 } }],
			todayElapsed: 0.526,
			average: { "1": null },
			forecast: { method: "history", arrived: 0.6364, samples: 900, lookbackDays: 28 },
		};
		vi.spyOn(api, "query").mockImplementation((async () => result) as typeof api.query);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter>
					<TooltipProvider>
						<Retention />
					</TooltipProvider>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const cell = (await screen.findByText("3.21%")).closest("button") as HTMLButtonElement;
		expect(cell.getAttribute("aria-pressed")).toBe("false");
		expect(cell.title).toContain("42 players back so far");
		expect(cell.title).toContain("predicted ~5.05% (66 players)");
		expect(cell.title).toContain("64% of returners were back by this time of day");
		cell.click();
		expect(await screen.findByText("~5.05%")).toBeTruthy();
		expect(cell.getAttribute("aria-pressed")).toBe("true");
		expect(cell.textContent).toContain("~");
		expect(cell.textContent).toContain("(66)");
		expect(cell.title).toContain("Predicted by midnight UTC: ~5.05%");
		cell.click();
		expect(await screen.findByText("3.21%")).toBeTruthy();
	});

	it("formats a share with 2 decimals, always both", () => {
		expect(retentionPct(0.0345)).toBe("3.45%");
		expect(retentionPct(0.01)).toBe("1.00%");
		expect(retentionPct(0)).toBe("0.00%");
	});
});

describe("Revenue (LTV) tab", () => {
	const cell = (robux: number, size: number, payers: number, partial = false) => ({
		robux,
		robuxPerPlayer: Math.round((robux / size) * 100) / 100,
		revenuePerPlayer: Math.round((robux / size) * 0.7 * 100) / 100,
		payers,
		payerShare: Math.round((payers / size) * 10_000) / 10_000,
		...(partial ? { partial: true as const } : {}),
	});
	const ltv: LtvResult = {
		from: "2026-11-01T00:00:00.000Z",
		to: "2026-11-15T12:00:00.000Z",
		days: LTV_DAYS,
		creatorShare: 0.7,
		todayElapsed: 0.5,
		cohorts: [
			{ date: "2026-11-01", size: 4, days: { "0": cell(100, 4, 1), "1": cell(300, 4, 2), "3": cell(300, 4, 2), "7": cell(400, 4, 3), "14": cell(500, 4, 3, true), "30": null } },
			{ date: "2026-11-14", size: 2, days: { "0": cell(10, 2, 1), "1": cell(30, 2, 1, true), "3": null, "7": null, "14": null, "30": null } },
		],
		average: { "0": { ...cell(110, 6, 2), players: 6 }, "1": { ...cell(300, 4, 2), players: 4 }, "3": { ...cell(300, 4, 2), players: 4 }, "7": { ...cell(400, 4, 3), players: 4 }, "14": null, "30": null },
	};

	function mount(url: string) {
		const calls: { name: string; options: Record<string, unknown> }[] = [];
		vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
			calls.push({ name, options });
			if (name === "ltv") return ltv;
			throw new Error(`unexpected ${name}`);
		}) as typeof api.query);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter initialEntries={[url]}>
					<TooltipProvider>
						<Retention />
					</TooltipProvider>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		return calls;
	}

	it("asks for D0-D30; revenue per player by default, the day in progress orange, not started –, the weighted average pinned", async () => {
		const calls = mount("/retention?view=revenue");
		const table = await screen.findByRole("table", { name: "Revenue per cohort" });
		expect(calls.map((c) => c.name)).toEqual(["ltv"]);
		expect(calls[0]?.options.days).toEqual([0, 1, 3, 7, 14, 30]);
		for (const h of ["D0", "D1", "D3", "D7", "D14", "D30"]) expect(within(table).getByText(h)).toBeTruthy();
		expect(within(table).getByText("Weighted average")).toBeTruthy();
		// 300 R$ / 4 players x 0.7 = 52.50 (the cohort's D1 and D3, the average's D1 and D3).
		expect(within(table).getAllByText("52.50 R$").length).toBe(4);
		// 110 / 6 x 0.7 = 12.83 (the average's D0).
		expect(within(table).getByText("12.83 R$")).toBeTruthy();
		const partial = within(table).getByText("10.50 R$");
		expect(partial.getAttribute("title")).toContain("In progress");
		expect(within(table).getAllByText("–").length).toBeGreaterThan(0);
	});

	it("Robux paid per player and payer share from the picker's URL value", async () => {
		mount("/retention?view=revenue&ltv=payers");
		const table = await screen.findByRole("table", { name: "Revenue per cohort" });
		expect(within(table).getAllByText("50% (2)").length).toBeGreaterThan(0);
		expect(ltvText(cell(300, 4, 2), "robux")).toBe("75.00 R$");
		expect(ltvText(cell(300, 4, 2), "payers")).toBe("50% (2)");
	});
});
