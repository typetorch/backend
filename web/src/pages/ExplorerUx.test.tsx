// @vitest-environment jsdom
// Saved queries (Query page, Overview tiles), links between pages, and "vs previous period" (Overview, Errors, Performance).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CompareToggle } from "@/components/CompareToggle";
import { DataTable } from "@/components/data-table";
import { chartRows, chartShape } from "@/components/SavedQueryView";
import { SessionsView } from "@/components/player-detail/StatViews";
import type { PerfSeriesResult } from "@/lib/perf";
import type { FleetAlert, OverviewResult, PlayerStatsResult, SavedQuery } from "@/lib/types";
import { BuildLinks } from "./Errors";
import { ALERT_COLUMNS, alertErrorsHref } from "./Fleet";
import { Body } from "./Overview";
import { previousLine } from "./Performance";
import { isDirty } from "./Query";
import { errorHref } from "./server/ServerErrors";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const T = Date.UTC(2026, 9, 9, 12);
const JOB = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";

function Where() {
	const { pathname, search } = useLocation();
	return <p data-testid="where">{pathname + search}</p>;
}

function mount(node: ReactNode, at = "/") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[at]}>
				<Routes>
					<Route
						path="*"
						element={
							<>
								{node}
								<Where />
							</>
						}
					/>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("saved queries", () => {
	const saved: SavedQuery = { id: 3, name: "Top", sql: "SELECT 1", chart: "bar", pinned: false, createdBy: "admin token", createdAt: "", updatedBy: "admin token", updatedAt: "" };

	it("Save is on only when the editor differs from the saved query", () => {
		expect(isDirty(saved, "SELECT 1;", { name: "Top", chart: "bar", pinned: false })).toBe(false);
		expect(isDirty(saved, "SELECT 2", { name: "Top", chart: "bar", pinned: false })).toBe(true);
		expect(isDirty(saved, "SELECT 1", { name: "Top", chart: "line", pinned: false })).toBe(true);
		expect(isDirty(saved, "SELECT 1", { name: "Top", chart: "bar", pinned: true })).toBe(true);
		expect(isDirty(undefined, "SELECT 1", { name: "x", chart: null, pinned: false })).toBe(true);
	});

	it("a chart takes the first column as its axis and the number columns after it as series", () => {
		const result = {
			columns: [
				{ name: "day", type: "DATE" },
				{ name: "name", type: "VARCHAR" },
				{ name: "n", type: "BIGINT" },
				{ name: "avg", type: "DOUBLE" },
			],
			rows: [
				["2026-10-01", "a", 3, 1.5],
				["2026-10-02", "b", "4", null],
			],
		};
		const shape = chartShape(result);
		expect(shape).toEqual({ x: 0, series: [2, 3] });
		expect(chartRows(result, shape as { x: number; series: number[] })).toEqual([
			{ x: "2026-10-01", s2: 3, s3: 1.5 },
			{ x: "2026-10-02", s2: 4, s3: null },
		]);
		expect(chartShape({ columns: [{ name: "name", type: "VARCHAR" }], rows: [["a"]] })).toBeUndefined();
		expect(chartShape({ columns: result.columns, rows: [] })).toBeUndefined();
	});
});

describe("links between pages", () => {
	it("an error kind's build opens the Errors page filtered to it, and Performance with its deploy marks", () => {
		mount(<BuildLinks build="a1b2c3d-000042" window="7d" />);
		expect(screen.getByRole("link", { name: "a1b2c3d-000042" }).getAttribute("href")).toBe("/errors?build=a1b2c3d-000042&window=7d");
		expect(screen.getByRole("link", { name: "perf" }).getAttribute("href")).toBe("/performance?art=a1b2c3d-000042");
		cleanup();
		mount(<BuildLinks build="(unknown)" window="24h" />);
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("a Fleet alert links to the errors of its build, over a window that reaches it; a server's page lists its errors", () => {
		const alert: FleetAlert = { id: 1, at: T - 2 * 86_400_000, level: "critical", code: "deploy_failed", message: "boom", branch: "prod", artifact: "art-9", job: JOB, acked: false };
		expect(alertErrorsHref(alert, T)).toBe("/errors?build=art-9&branch=prod&window=7d");
		expect(alertErrorsHref({ ...alert, at: T - 1000 }, T)).toBe("/errors?build=art-9&branch=prod");
		expect(alertErrorsHref({ ...alert, artifact: null }, T)).toBeUndefined();
		mount(<DataTable<FleetAlert> id="fleet-alerts" columns={ALERT_COLUMNS} data={[{ ...alert, at: Date.now() }]} rowId={(a) => String(a.id)} />);
		expect(screen.getByRole("link", { name: "Errors" }).getAttribute("href")).toBe("/errors?build=art-9&branch=prod");
		expect(errorHref("fp-1")).toBe("/errors?fp=fp-1&window=30d");
	});

	it("a player's session links to the server it ran on", () => {
		const stats = {
			pid: "p1",
			window: { from: "", to: "", days: 1, bucket: "day", clamped: false },
			totals: { sessions: 1, avgSessionMinutes: 5, medianSessionMinutes: 5, events: 3 },
			series: [],
			sessions: [{ sid: "s1", start: "2026-10-09T11:00:00Z", end: "2026-10-09T11:05:00Z", minutes: 5, events: 3, firstSession: false, dev: "phone", art: "art-9", job: JOB }],
			sessionsTruncated: false,
			purchases: [],
			purchasesTruncated: false,
		} as unknown as PlayerStatsResult;
		let opened = "";
		mount(<SessionsView stats={stats} show="table" onShow={() => {}} onSession={(sid) => (opened = sid)} />);
		fireEvent.click(screen.getByRole("link", { name: "0b5c7d…789abc" }));
		expect(screen.getByTestId("where").textContent).toBe(`/servers/${JOB}`);
		expect(opened).toBe("");
	});
});

describe("vs previous period", () => {
	it("the toggle keeps its state in the URL", () => {
		mount(<CompareToggle />, "/?range=7d");
		const chip = screen.getByRole("button", { name: /vs previous period/ });
		expect(chip.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(chip);
		expect(screen.getByTestId("where").textContent).toBe("/?range=7d&vs=prev");
		expect(screen.getByRole("button", { name: /vs previous period/ }).getAttribute("aria-pressed")).toBe("true");
	});

	it("the Overview's tiles carry change chips against the previous period", () => {
		const data: OverviewResult = {
			from: "2026-10-08",
			to: "2026-10-09",
			players: 120,
			newPlayers: 10,
			returningPlayers: 110,
			sessions: 200,
			events: 4000,
			playtimeHours: 50,
			avgSessionMinutes: 15,
			playtimePerPlayerMinutes: 25,
			days: [],
		};
		mount(<Body data={data} previous={{ ...data, players: 100, newPlayers: 20 }} />);
		expect(screen.getByText("+20%")).toBeTruthy();
		expect(screen.getByText("-50%")).toBeTruthy();
		expect(screen.getAllByTitle("vs the previous period").length).toBe(8);
	});

	it("Performance: a dashed previous line on ungrouped charts, shifted onto the current axis; none when grouped", () => {
		const result = (t0: number, value: number): PerfSeriesResult =>
			({
				side: "client",
				by: "none",
				fromMs: t0,
				toMs: t0 + 2 * 3_600_000,
				bucketMs: 3_600_000,
				groups: [{ key: "all", samples: 1, seq: null, firstSeen: null, lastSeen: null, metrics: {} }],
				groupsTotal: 1,
				overall: { key: "all", samples: 1, seq: null, firstSeen: null, lastSeen: null, metrics: {} },
				series: [{ t: t0, key: "all", n: 1, metrics: { fps: { p10: value, p50: value, p90: value, p99: value, avg: value, n: 1 } } }],
			}) as unknown as PerfSeriesResult;
		const now = result(T, 60);
		const before = result(T - 2 * 3_600_000, 40);
		const rows = [{ t: T, s0: 60 }];
		const line = previousLine(now, { result: before, shiftMs: 2 * 3_600_000 }, rows, "fps", "p50");
		expect(line?.series.map((s) => [s.id, s.dashed ?? false])).toEqual([
			["s0", false],
			["prev", true],
		]);
		expect(line?.rows[0]).toMatchObject({ t: T, s0: 60, prev: 40 });
		expect(previousLine({ ...now, by: "dev" } as PerfSeriesResult, { result: before, shiftMs: 1 }, rows, "fps", "p50")).toBeUndefined();
		expect(previousLine(now, undefined, rows, "fps", "p50")).toBeUndefined();
	});
});
