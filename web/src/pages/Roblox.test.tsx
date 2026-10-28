// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import type { BenchmarkPeriod, BenchmarksResult, Filters, RealtimeResult, TrendsResult, TrendValues } from "@/lib/types";
import Roblox, { BENCHMARKED_CARDS, CALCULATION_NOTES, CARDS, periodLabel, retentionSub, TRENDS } from "./Roblox";

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
});

const rate = (count: number, of: number) => ({ rate: of ? count / of : 0, count, of });

function period(from: string, to: string, over: Partial<BenchmarkPeriod> = {}): BenchmarkPeriod {
	return {
		from,
		to,
		players: 40,
		newUsers: 12,
		dau: 10,
		mau: 150,
		sessions: 90,
		avgSessionMinutes: 12.5,
		avgPlaytimeMinutes: 25,
		d1Retention: { ...rate(3, 12), cohortFrom: "2026-10-01", cohortTo: "2026-10-07", history: "complete", dataFrom: "2026-08-01" },
		d7Retention: { ...rate(1, 10), cohortFrom: "2026-09-25", cohortTo: "2026-10-01", history: "complete", dataFrom: "2026-08-01" },
		d30Retention: { ...rate(2, 20), cohortFrom: "2026-09-02", cohortTo: "2026-09-08", history: "complete", dataFrom: "2026-08-01" },
		payerConversion: { rate: 0.05, count: 4, of: 70 },
		arppu: 70,
		arpdau: 3.5,
		robux: 400,
		revenue: 280,
		playThrough: { ...rate(6, 12), minutes: 5 },
		...over,
	};
}

const benchmarks: BenchmarksResult = {
	days: 7,
	creatorShare: 0.7,
	current: period("2026-10-02T00:00:00.000Z", "2026-10-09T00:00:00.000Z"),
	previous: period("2026-09-25T00:00:00.000Z", "2026-10-02T00:00:00.000Z", { avgSessionMinutes: 10 }),
};

const realtime: RealtimeResult = {
	hours: 24,
	current: { sessions: 30, avgSessionMinutes: 11, clientErrors: 2, errorsPerSession: 0.07, clientFps: 55, serverMemoryMb: 800 },
	previous: { sessions: 25, avgSessionMinutes: 10, clientErrors: 1, errorsPerSession: 0.04, clientFps: 50, serverMemoryMb: 700 },
	ccu: { now: 9, series: [{ hour: "2026-10-09T10:00:00.000Z", avg: 4, peak: 7 }], currentAvg: 4.3, previousAvg: 3, currentPeak: 7, previousPeak: 5 },
};

const values = (over: Partial<TrendValues> = {}): TrendValues => ({ newUsers: 2, dau: 10, sessionMinutes: 12, playtimeMinutes: 24, robux: 50, revenue: 35, d1: 0.3, ...over });
const trends: TrendsResult = {
	from: "2026-09-11T00:00:00.000Z",
	to: "2026-10-09T12:00:00.000Z",
	window: 7,
	creatorShare: 0.7,
	sources: ["direct"],
	days: [
		{ date: "2026-10-07", total: values(), bySource: { direct: values() } },
		{ date: "2026-10-08", total: values({ d1: 0.25 }), bySource: { direct: values({ d1: 0.25 }) } },
	],
};

function mount() {
	const calls: { name: string; filters: Filters; options: Record<string, unknown> }[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, filters: Filters = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, filters, options });
		if (name === "benchmarks") return benchmarks;
		if (name === "realtime") return realtime;
		if (name === "trends") return trends;
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	vi.spyOn(api, "robloxAcquisition").mockRejectedValue(new ApiError(409, "Roblox analytics are off", "/v1/roblox/analytics/acquisition"));
	vi.spyOn(api, "fleetServers").mockResolvedValue({ servers: [], players: 9 } as unknown as Awaited<ReturnType<typeof api.fleetServers>>);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/roblox"]}>
				<TooltipProvider>
					<Roblox />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return calls;
}

describe("Roblox page", () => {
	it("shows Creator Hub's KPIs with session time first, and marks the ones that can't match", async () => {
		mount();
		expect(await screen.findByText("280 Robux revenue (400 spent)")).toBeTruthy();
		// The cards' first title, then the trends tab of the same name.
		expect(screen.getAllByText("Average session time").length).toBe(2);
		for (const title of ["Daily active users", "Monthly active users", "New users", "Day 1 retention", "Day 7 retention", "Day 30 retention", "Payer conversion", "ARPPU", "ARPDAU", "Average playtime", "Qualified first sessions"]) {
			expect(screen.getAllByText(title).length).toBeGreaterThan(0);
		}
		expect(screen.getByText("12.5 min")).toBeTruthy();
		expect(screen.getByText("150")).toBeTruthy(); // MAU
		expect(screen.getByText("30 days to Oct 8")).toBeTruthy();
		expect(screen.getByText("2 of 20 new players")).toBeTruthy(); // D30
		expect(screen.getByText("1.7 per day")).toBeTruthy(); // 12 new users over 7 days
		// Concurrent users: the peak and the average of the last 24 h, next to the live count.
		expect(screen.getByText("Peak concurrent users")).toBeTruthy();
		expect(screen.getByText("Average concurrent users")).toBeTruthy();
		expect(screen.getByText("4.3")).toBeTruthy();
		expect(screen.getByText(`${periodLabel(benchmarks.current)} vs ${periodLabel(benchmarks.previous)}`)).toBeTruthy();
		// Estimates (new users and the three retention cards: the SDK's first visit; revenue, payers, CCU) and our own numbers
		// (qualified first sessions, join sources) carry a mark with the reason.
		expect(document.querySelectorAll('button[aria-label^="Estimate: how it differs"]').length).toBe(8);
		expect(document.querySelectorAll('button[aria-label^="Ours: how it differs"]').length).toBe(2);
		expect(screen.getByText("6 of 12 first sessions, 5 min or longer")).toBeTruthy();
	}, 60_000);

	it("our qualified first sessions card takes no Roblox benchmark, and D30 says when the history is too short", async () => {
		localStorage.setItem("tt-explorer-benchmarks", JSON.stringify({ d1: { p50: 20, p90: 35 }, playThrough: { p50: 10, p90: 20 } }));
		try {
			benchmarks.current.d30Retention = { rate: 0, count: 0, of: 0, cohortFrom: "2026-09-02", cohortTo: "2026-09-08", history: "none", dataFrom: "2026-09-20" };
			benchmarks.current.d7Retention = { rate: 0.1, count: 1, of: 10, cohortFrom: "2026-09-25", cohortTo: "2026-10-01", history: "partial", dataFrom: "2026-09-27" };
			mount();
			const card = (await screen.findByText("Qualified first sessions")).closest("[data-slot=card]") as HTMLElement;
			// No bar, no percentile, no "set benchmarks" link on our own metric, even with an old saved benchmark for it.
			expect(within(card).queryByText(/percentile/)).toBeNull();
			expect(within(card).queryByText("set benchmarks")).toBeNull();
			expect(BENCHMARKED_CARDS.some((c) => c.id === "qualifiedFirstSessions")).toBe(false);
			expect(BENCHMARKED_CARDS.length).toBe(CARDS.length - 1);
			// The D1 card does compare against the typed 50th / 90th.
			const d1 = screen.getByText("Day 1 retention").closest("[data-slot=card]") as HTMLElement;
			expect(within(d1).getByText(/percentile/)).toBeTruthy();
			// D30: the cohorts are older than the events.
			expect(screen.getByText("not enough history: cohorts Sep 2 - Sep 8, events start Sep 20")).toBeTruthy();
			expect(screen.getByText("1 of 10 new players (cohorts from Sep 27: events start then)")).toBeTruthy();
		} finally {
			localStorage.removeItem("tt-explorer-benchmarks");
			benchmarks.current = period("2026-10-02T00:00:00.000Z", "2026-10-09T00:00:00.000Z");
		}
	});

	it("explains how the numbers are calculated", async () => {
		mount();
		const section = (await screen.findByText("How these are calculated")).closest("[data-slot=card]") as HTMLElement;
		expect(section).toBeTruthy();
		for (const n of CALCULATION_NOTES) expect(within(section).getByText(n.title)).toBeTruthy();
		expect(within(section).getByText(/UTC, midnight to midnight/)).toBeTruthy();
		expect(within(section).getByText(/Studio play tests don't count/)).toBeTruthy();
		expect(within(section).getByText(/Monthly active users are the distinct players of the 30 days/)).toBeTruthy();
		expect(within(section).getByText(/Day 1 \/ 7 \/ 30 retention is by first play date/)).toBeTruthy();
	});

	it("asks for full UTC days: 7-day benchmarks, and trends from 28 days back", async () => {
		const calls = mount();
		await screen.findByText("Average session time");
		expect(calls.find((c) => c.name === "benchmarks")?.options).toEqual({ days: 7 });
		const t = calls.find((c) => c.name === "trends");
		expect(t?.options).toEqual({ window: 7 });
		const from = String(t?.filters.from);
		const daysBack = Math.round((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
		expect(daysBack).toBeGreaterThanOrEqual(28);
		expect(daysBack).toBeLessThanOrEqual(29);
	});
});

describe("definitions", () => {
	it("every card explains Creator Hub's definition, and every mark says why it differs", () => {
		expect(CARDS.map((c) => c.id)).toEqual(["dau", "mau", "newUsers", "sessionTime", "d1", "d7", "d30", "payer", "arppu", "arpdau", "playtime", "qualifiedFirstSessions"]);
		for (const c of CARDS) {
			expect(c.info.length).toBeGreaterThan(20);
			if (c.differs) expect(c.differs.why.length).toBeGreaterThan(20);
		}
		expect(CARDS.find((c) => c.id === "qualifiedFirstSessions")?.differs?.label).toBe("Ours");
		for (const id of ["newUsers", "d1", "d7", "d30"]) expect(CARDS.find((c) => c.id === id)?.differs?.label).toBe("Estimate");
		expect(TRENDS.map((t) => t.key)).toContain("sessionMinutes");
	});

	it("a retention line says when the history is missing or partial", () => {
		const base = { rate: 0, count: 0, of: 0, cohortFrom: "2026-09-21", cohortTo: "2026-09-27" };
		expect(retentionSub({ ...base, history: "none", dataFrom: "2026-10-10" })).toBe("not enough history: cohorts Sep 21 - Sep 27, events start Oct 10");
		expect(retentionSub({ ...base, history: "none", dataFrom: null })).toBe("not enough history: cohorts Sep 21 - Sep 27, no events yet");
		expect(retentionSub({ ...base, count: 3, of: 40, history: "partial", dataFrom: "2026-09-24" })).toBe("3 of 40 new players (cohorts from Sep 24: events start then)");
		expect(retentionSub({ ...base, count: 3, of: 40, history: "complete", dataFrom: "2026-09-01" })).toBe("3 of 40 new players");
	});

	it("period labels are UTC days, the end exclusive", () => {
		expect(periodLabel({ from: "2026-10-02T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z" })).toBe("Oct 2 - Oct 8 (UTC)");
	});
});
