// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Filters, SessionTimeBucket, SessionTimeResult, SessionTimeSummary } from "@/lib/types";
import SessionTime, { bucketValue, chartRows, rangeSpan, rollingAverage, stepLabel } from "./SessionTime";

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

const summary = (over: Partial<SessionTimeSummary> = {}): SessionTimeSummary => ({
	sessions: 6,
	players: 5,
	avgMinutes: 15.67,
	medianMinutes: 10,
	robloxHeadline: 14.83,
	weightedMinuteMean: 13.4,
	playtimeMinutes: 94,
	playtimePerPlayer: 18.8,
	running: 1,
	...over,
});

const bucket = (t: number, over: Partial<SessionTimeBucket> = {}): SessionTimeBucket => ({
	t,
	time: new Date(t).toISOString(),
	sessions: 0,
	avgMinutes: null,
	robloxTotal: null,
	playtimeMinutes: 0,
	players: 0,
	playtimePerPlayer: null,
	byDevice: {},
	...over,
});

const H = Date.UTC(2026, 9, 5, 10);
const result: SessionTimeResult = {
	from: new Date(H).toISOString(),
	to: new Date(H + 3 * 3_600_000).toISOString(),
	bucketMinutes: 60,
	mergeGapMinutes: 0,
	by: "end",
	devices: ["phone", "desktop"],
	buckets: [
		bucket(H, {
			sessions: 5,
			avgMinutes: 16.8,
			robloxTotal: 19.67,
			playtimeMinutes: 84,
			players: 4,
			playtimePerPlayer: 21,
			byDevice: { desktop: { sessions: 2, avgMinutes: 34, playtimeMinutes: 68 }, phone: { sessions: 3, avgMinutes: 5.33, playtimeMinutes: 16 } },
		}),
		bucket(H + 3_600_000),
		bucket(H + 7_200_000, { sessions: 1, avgMinutes: 10, robloxTotal: 10, playtimeMinutes: 10, players: 1, playtimePerPlayer: 10, byDevice: { phone: { sessions: 1, avgMinutes: 10, playtimeMinutes: 10 } } }),
	],
	summary: summary(),
	previous: summary({ sessions: 1, avgMinutes: 20 }),
	histogram: [
		{ label: "<30s", fromSeconds: 0, toSeconds: 30, count: 0 },
		{ label: "1-3m", fromSeconds: 60, toSeconds: 180, count: 1 },
	],
	truncated: false,
};

function mount(path = "/session-time") {
	const calls: { name: string; filters: Filters; options: Record<string, unknown> }[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, filters: Filters = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, filters, options });
		if (name === "session-time") return result;
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<TooltipProvider>
					<SessionTime />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return calls;
}

describe("Session time page", () => {
	it("renders the tiles, the chart section and the step table; sends the url's options", async () => {
		const calls = mount("/session-time?range=1d&by=start&merge=5&bucket=60");
		expect(await screen.findByText("Roblox-style headline")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Session time" })).toBeTruthy();
		expect(screen.getByText("Session lengths")).toBeTruthy();
		expect(screen.getByText("Per step")).toBeTruthy();
		const opts = calls.find((c) => c.name === "session-time")?.options;
		expect(opts).toEqual({ by: "start", mergeGapMinutes: 5, bucketMinutes: 60 });
		expect(screen.getByText("Per hour, sessions counted when they started.")).toBeTruthy();
		// The table: non-empty steps only, newest first, a column per device.
		expect(screen.getAllByRole("row").length).toBe(3);
		expect(screen.getByText("34 min (2)")).toBeTruthy();
	}, 60_000);

	it("defaults: count by end, no merging, the auto step", async () => {
		const calls = mount();
		await screen.findByText("Roblox-style headline");
		expect(calls.find((c) => c.name === "session-time")?.options).toEqual({ by: "end", mergeGapMinutes: 0 });
	}, 60_000);
});

describe("helpers", () => {
	it("rollingAverage: centered, empty points stay gaps and are skipped", () => {
		expect(rollingAverage([1, 2, 3, 4, 5], 1)).toEqual([1, 2, 3, 4, 5]);
		expect(rollingAverage([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
		expect(rollingAverage([2, null, 4, 6], 3)).toEqual([2, null, 5, 5]);
		expect(rollingAverage([1, 2, 3, 4, 5], 5)).toEqual([2, 2.5, 3, 3.5, 4]);
		expect(rollingAverage([], 3)).toEqual([]);
	});

	it("bucketValue and chartRows: weighted vs Roblox-style total, devices, gaps", () => {
		const [b0, b1] = result.buckets;
		expect(bucketValue(b0, "session", "weighted")).toBe(16.8);
		expect(bucketValue(b0, "session", "roblox")).toBe(19.67);
		expect(bucketValue(b0, "session", "weighted", "desktop")).toBe(34);
		expect(bucketValue(b1, "session", "weighted")).toBeNull();
		expect(bucketValue(b1, "sessions", "weighted")).toBeNull();
		expect(bucketValue(result.buckets[2], "playtime", "weighted", "desktop")).toBe(0);
		const { rows, devs } = chartRows(result, "session", "roblox", true, 1);
		expect(devs).toEqual(["phone", "desktop"]);
		expect(rows[0]).toMatchObject({ total: 19.67, d0: 5.33, d1: 34 });
		expect(rows[1]).toMatchObject({ total: null, d0: null, d1: null });
		expect(chartRows(result, "perPlayer", "weighted", true, 1).devs).toEqual([]); // no per-device players
	});

	it("rangeSpan and stepLabel", () => {
		expect(rangeSpan({ from: "2026-10-01", to: "2026-10-02" })).toBe(2 * 86_400_000);
		expect(rangeSpan({ from: new Date(0).toISOString() }, 3_600_000)).toBe(3_600_000);
		expect(rangeSpan({})).toBeNull();
		expect(stepLabel(1)).toBe("minute");
		expect(stepLabel(5)).toBe("5 minutes");
		expect(stepLabel(1440)).toBe("day");
	});
});
