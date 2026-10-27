// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { BackendStats, LatencySummary, StatsBucket } from "@/lib/types";
import BackendStatsPage, { ROUTE_LABELS, timeline } from "./BackendStats";

beforeAll(() => {
	// recharts measures its container: give it a size, so the charts render in jsdom.
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	const rect = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		return this.classList?.contains("recharts-responsive-container") ? ({ width: 600, height: 192, top: 0, left: 0, right: 600, bottom: 192, x: 0, y: 0, toJSON() {} } as DOMRect) : rect.call(this);
	};
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 9, 27, 12, 0, 30, 500);
const latency = (p50: number, count = 10): LatencySummary => ({ count, p50, p90: p50 * 2, p99: p50 * 4, max: p50 * 5, avg: p50 * 1.2 });
const none: LatencySummary = { count: 0, p50: null, p90: null, p99: null, max: null, avg: null };

const bucket = (at: number, requests: number): StatsBucket => ({
	at,
	requests,
	status: { "2xx": requests - 1, "3xx": 0, "4xx": 0, "5xx": 1 },
	latency: latency(3, requests),
	duckdb: { queries: 4, latency: latency(20, 4), rowsLoaded: 600 },
	sqlite: { reads: 2, writes: 1 },
	ingest: { rows: 50, bytes: 4000 },
	memory: { rssMb: 310.5, heapMb: 80, heapTotalMb: 120, externalMb: 12 },
	cpuPercent: 12.5,
	loopLagMs: 1.5,
});

const view: BackendStats = {
	now: NOW,
	uptimeSeconds: 3725,
	state: "ready",
	version: "0.1.0",
	runtime: "bun 1.4.4",
	rates: { seconds: 10, requests: 42.5, errors: 0.2, duckQueries: 7, rowsIn: 1250, rowsLoaded: 900, sqliteReads: 3, sqliteWrites: 1.5 },
	sample: { rssMb: 310.5, heapMb: 80, heapTotalMb: 120, externalMb: 12, cpuPercent: 12.5, loopLagMs: 1.5 },
	latency: { recent: latency(3.2, 425), window: latency(4, 12_000) },
	duckdb: { recent: latency(18), window: latency(22) },
	totals: { requests: 123_456, errors: 7, duckQueries: 9876, rowsIn: 5_000_000, bytesIn: 250_000_000, rowsLoaded: 4_999_000, sqliteReads: 30_000, sqliteWrites: 20_000, since: NOW - 3725 * 1000 },
	seconds: [bucket(Math.floor(NOW / 1000) * 1000 - 1000, 40), bucket(Math.floor(NOW / 1000) * 1000 - 2000, 45)],
	minutes: [bucket(Math.floor(NOW / 60_000) * 60_000, 2400)],
	window: "5m",
	routes: [
		{ group: "ingest", requests: 9000, errors: 0, latency: latency(2.5, 9000) },
		{ group: "query", requests: 300, errors: 2, latency: latency(40, 300) },
		{ group: "stream", requests: 3, errors: 0, latency: none },
	],
};

function mount(data: BackendStats = view) {
	const spy = vi.spyOn(api, "backendStats").mockResolvedValue(data);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/backend"]}>
				<BackendStatsPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return spy;
}

describe("timeline", () => {
	it("fills every second of the last 2 minutes, oldest first, leaving the running second out; counters read per second, missing ones are quiet", () => {
		const rows = timeline(view, "seconds");
		expect(rows.length).toBe(120);
		const lastWhole = Math.floor(NOW / 1000) * 1000 - 1000;
		expect(rows[119].t).toBe(lastWhole);
		expect(rows[0].t).toBe(lastWhole - 119 * 1000);
		// The last whole second's bucket is the last row: its counts as they are.
		expect(rows[119]).toMatchObject({ requests: 40, errors: 1, duckQueries: 4, rowsIn: 50, rowsLoaded: 600, p50: 3, p99: 12, rss: 310.5, cpu: 12.5, lag: 1.5 });
		// A second nothing happened in: zero counts, no samples.
		expect(rows[0]).toMatchObject({ requests: 0, errors: 0, rowsIn: 0, p50: null, rss: null, cpu: null });
	});

	it("per minute: the last hour including the running minute, counters divided by 60", () => {
		const rows = timeline(view, "minutes");
		expect(rows.length).toBe(60);
		expect(rows[59].t).toBe(Math.floor(NOW / 60_000) * 60_000);
		expect(rows[59].requests).toBe(40);
		expect(rows[59].rowsLoaded).toBe(10);
		expect(rows[58].requests).toBe(0);
	});
});

describe("Backend stats page", () => {
	it("shows the live tiles, the charts, the route table and the totals", async () => {
		const spy = mount();
		const tiles = await screen.findByTestId("stats-tiles");
		expect(spy).toHaveBeenCalledWith("5m", expect.anything());
		expect(within(tiles).getByText("Requests / s")).toBeTruthy();
		expect(within(tiles).getByText("42.5")).toBeTruthy();
		expect(within(tiles).getByText("0.2 errors / s (5xx)")).toBeTruthy();
		expect(within(tiles).getByText("Queries / s")).toBeTruthy();
		expect(within(tiles).getByText("7")).toBeTruthy();
		expect(within(tiles).getByText("Inserts / s")).toBeTruthy();
		expect(within(tiles).getByText("1,250")).toBeTruthy();
		expect(within(tiles).getByText("3.2 ms")).toBeTruthy();
		expect(within(tiles).getByText("p90 6.4 ms · p99 12.8 ms")).toBeTruthy();
		expect(within(tiles).getByText("310.5 MB")).toBeTruthy();
		expect(within(tiles).getByText("12.5%")).toBeTruthy();
		expect(within(tiles).getByText("1h 02m")).toBeTruthy();
		expect(within(tiles).getByText("bun 1.4.4 · v0.1.0")).toBeTruthy();
		for (const name of ["Requests per second", "Queries and inserts per second", "Request latency", "DuckDB statement latency", "Memory", "CPU and event loop lag"]) {
			expect(screen.getByRole("figure", { name })).toBeTruthy();
		}
		const table = screen.getByRole("table", { name: "Requests by route group" });
		const rows = within(table).getAllByRole("row").slice(1);
		expect(rows.length).toBe(3);
		// Busiest first; streams have no latency.
		expect(within(rows[0]).getByText(ROUTE_LABELS.ingest)).toBeTruthy();
		expect(within(rows[0]).getByText("9,000")).toBeTruthy();
		expect(within(rows[1]).getByText(ROUTE_LABELS.query)).toBeTruthy();
		expect(within(rows[1]).getByText("160 ms")).toBeTruthy();
		expect(within(rows[2]).getByText(ROUTE_LABELS.stream)).toBeTruthy();
		expect(within(rows[2]).getAllByText("–").length).toBeGreaterThanOrEqual(5);
		expect(screen.getByText("123,456")).toBeTruthy();
		expect(screen.getByText("238 MB")).toBeTruthy();
	});

	it("the window toggle asks the backend for that window; Live pauses the polling", async () => {
		const spy = mount();
		await screen.findByTestId("stats-tiles");
		fireEvent.click(screen.getByRole("radio", { name: "1 hour" }));
		await waitFor(() => expect(spy).toHaveBeenCalledWith("1h", expect.anything()));
		const live = screen.getByRole("button", { name: /live/i });
		expect(live.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(live);
		expect(screen.getByRole("button", { name: /paused/i }).getAttribute("aria-pressed")).toBe("false");
	});

	it("shows the server's error when the stats can't load", async () => {
		vi.spyOn(api, "backendStats").mockRejectedValue(new ApiError(403, "read-only access: this needs the admin token or an owner's session", "/v1/admin/stats"));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/backend"]}>
					<BackendStatsPage />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		expect(await screen.findByText(/read-only access/)).toBeTruthy();
	});
});
