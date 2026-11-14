// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { RetentionResult } from "@/lib/types";
import Retention, { RETENTION_DAYS, retentionPct } from "./Retention";

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

	it("formats a share with 2 decimals, always both", () => {
		expect(retentionPct(0.0345)).toBe("3.45%");
		expect(retentionPct(0.01)).toBe("1.00%");
		expect(retentionPct(0)).toBe("0.00%");
	});
});
