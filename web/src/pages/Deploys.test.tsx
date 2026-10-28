// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DayBars } from "@/components/DayBars";
import { setDeployMarksShown } from "@/components/DeployMarkers";
import { api, ApiError } from "@/lib/api";
import type { DeployDetail as Detail, DeployRecord } from "@/lib/deploys";
import type { DeployMark } from "@/lib/perf";
import type { ErrorList } from "@/lib/types";
import DeployDetailPage from "./DeployDetail";
import Deploys from "./Deploys";

beforeAll(() => {
	// recharts measures its container: give it a size, so the charts (and their markers) render in jsdom.
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	const rect = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		return this.classList?.contains("recharts-responsive-container") ? ({ width: 600, height: 160, top: 0, left: 0, right: 600, bottom: 160, x: 0, y: 0, toJSON() {} } as DOMRect) : rect.call(this);
	};
});
beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	setDeployMarksShown(true);
});

const H = 3_600_000;
const T = Date.UTC(2026, 9, 8, 12);

const record = (seq: number, over: Partial<DeployRecord> = {}): DeployRecord => ({
	seq,
	branch: "prod",
	artifact: `art-${seq}`,
	channel: "prod",
	kind: "deploy",
	inferred: false,
	from: null,
	message: null,
	startedBy: "alice",
	at: T - seq * H,
	startedAt: new Date(T - seq * H).toISOString(),
	reported: 3,
	ok: 3,
	failed: 0,
	stuck: 0,
	results: { swapped: 3 },
	errors: [],
	errorKinds: 0,
	firstReport: null,
	lastReport: null,
	outcome: "ok",
	frozen: false,
	...over,
});

function mount(path: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/deploys" element={<Deploys />} />
					<Route path="/deploys/:seq" element={<DeployDetailPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("the Deploys page", () => {
	it("lists deploys newest first with who and how it went, and loads older pages", async () => {
		const spy = vi
			.spyOn(api, "fleetDeploys")
			.mockResolvedValueOnce({ deploys: [record(3, { outcome: "partial", failed: 1, ok: 2, errors: [{ error: "attempt to index nil", servers: 1 }] }), record(2, { startedBy: null, inferred: true })], next: 2 })
			.mockResolvedValueOnce({ deploys: [record(1, { kind: "rollback", startedBy: "auto_rollback" })], next: null });
		mount("/deploys");
		expect(await screen.findByText("#3")).toBeTruthy();
		expect(screen.getByText("Partly failed")).toBeTruthy();
		expect(screen.getByText("attempt to index nil")).toBeTruthy();
		expect(screen.getByText("server reports")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Load older deploys" }));
		expect(await screen.findByText("auto_rollback")).toBeTruthy();
		expect(spy.mock.calls[1]?.[0]).toMatchObject({ before: 2 });
		expect(screen.getByText("That is every deploy the history keeps.")).toBeTruthy();
	});

	it("says so when the backend has no history", async () => {
		vi.spyOn(api, "fleetDeploys").mockRejectedValue(new ApiError(404, "not found", "/v1/fleet/deploys"));
		mount("/deploys");
		expect(await screen.findByText(/no deploy history/)).toBeTruthy();
	});
});

describe("one deploy", () => {
	const errors = (kinds: [string, number][]): ErrorList => ({
		window: { from: "", to: "", bucketSeconds: 60, buckets: 1 },
		kinds: kinds.map(([fp, count]) => ({ fp, template: `error ${fp}`, topFrame: null, realm: "server", count, players: 1, firstAt: "", lastAt: "", total: count, spark: [] })),
		totals: { count: kinds.reduce((n, [, c]) => n + c, 0), kinds: kinds.length, players: 1 },
		more: 0,
	});

	it("shows the outcome, the report, the alerts, neighbors and errors before vs after", async () => {
		const detail: Detail = {
			deploy: record(5, { at: T - 48 * H, outcome: "failed", ok: 0, failed: 2, results: { failed: 2 } }),
			report: { seq: 5, branch: "prod", artifact: "art-5", startedAt: null, reported: 2, results: [{ result: "failed", servers: 2, players: 4, medianSeconds: 1, maxSeconds: 2 }], errors: [{ error: "boom", servers: 2, exampleJob: "job-1" }], behind: [], stuck: [], reports: [] },
			alerts: [{ id: 1, at: T - 47 * H, level: "critical", code: "deploy_failed", message: "boom on job-1", acked: false, seq: 5 }],
			previous: { seq: 4, kind: "deploy", artifact: "art-4", at: T - 50 * H },
			next: null,
		};
		vi.spyOn(api, "fleetDeploy").mockResolvedValue(detail);
		const errorsSpy = vi.spyOn(api, "errors").mockImplementation(async (params) => (params?.to === detail.deploy.at ? errors([["a", 4]]) : errors([["a", 2], ["b", 7]])));
		vi.spyOn(api, "query").mockRejectedValue(new ApiError(503, "analytics not ready", "/v1/query/perf-compare"));
		vi.spyOn(Date, "now").mockReturnValue(T);
		mount("/deploys/5");
		expect(await screen.findByRole("heading", { name: "Deploy #5 prod" })).toBeTruthy();
		expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
		expect(screen.getByText("boom")).toBeTruthy();
		expect(screen.getByText("deploy_failed")).toBeTruthy();
		expect(screen.getByRole("link", { name: /#4/ }).getAttribute("href")).toBe("/deploys/4");
		// Errors in the 24 hours before and after, branch prod only; b is new.
		expect(await screen.findByText("error b")).toBeTruthy();
		expect(screen.getByText("new")).toBeTruthy();
		const windows = errorsSpy.mock.calls.map((c) => c[0]);
		expect(windows).toEqual(expect.arrayContaining([expect.objectContaining({ from: T - 72 * H, to: T - 48 * H, branch: "prod" }), expect.objectContaining({ from: T - 48 * H, to: T - 24 * H })]));
		// No analytics: said plainly.
		expect(await screen.findByText(/Performance numbers are not available/)).toBeTruthy();
	});

	it("a frozen deploy shows the counts the history kept", async () => {
		vi.spyOn(api, "fleetDeploy").mockResolvedValue({ deploy: record(6, { frozen: true, errors: [{ error: "old error", servers: 1 }], errorKinds: 3 }), report: null, alerts: [], previous: null, next: null });
		vi.spyOn(api, "errors").mockResolvedValue(errors([]));
		vi.spyOn(api, "query").mockRejectedValue(new ApiError(404, "no", "/v1/query/perf-compare"));
		mount("/deploys/6");
		expect(await screen.findByText(/these counts were kept/)).toBeTruthy();
		expect(screen.getByText("old error")).toBeTruthy();
		expect(screen.getByText("2 rarer errors not kept.")).toBeTruthy();
	});

	it("an unknown deploy says so", async () => {
		vi.spyOn(api, "fleetDeploy").mockRejectedValue(new ApiError(404, "no such deploy", "/v1/fleet/deploys/99"));
		mount("/deploys/99");
		expect(await screen.findByText(/is not in the history/)).toBeTruthy();
	});
});

describe("deploy markers on bars", () => {
	const marks: DeployMark[] = [
		{ id: "deploy:42", kind: "deploy", at: Date.UTC(2026, 9, 8, 10), time: "", branch: "prod", seq: 42, artifact: "art-42", channel: null, from: null, kernel: null, placeVersion: null, message: null },
		{ id: "deploy:43", kind: "rollback", at: Date.UTC(2026, 9, 8, 11), time: "", branch: "prod", seq: 43, artifact: "art-41", channel: null, from: "art-42", kernel: null, placeVersion: null, message: null },
	];
	const data = [
		{ date: "2026-10-07", value: 3 },
		{ date: "2026-10-08", value: 5 },
	];

	it("one line per bar with its marks, labelled, hover shows each, click opens", async () => {
		const onClick = vi.fn();
		render(<DayBars data={data} label="Players" marks={marks} onMarkClick={onClick} />);
		const line = await screen.findByRole("button", { name: /^Deploy #42 prod art-42.*; Rollback #43 prod/ });
		expect(screen.getByText("#43 prod +1")).toBeTruthy();
		fireEvent.mouseEnter(line);
		expect(screen.getByRole("status").textContent).toContain("Rollback #43 prod art-41");
		expect(screen.getByRole("status").textContent).toContain("Deploy #42 prod art-42");
		fireEvent.click(line);
		expect(onClick).toHaveBeenCalledWith(marks[1]);
	});

	it("the shared switch hides them on every chart", async () => {
		const { useDeployMarks, DeployMarksToggle } = await import("@/components/DeployMarkers");
		vi.spyOn(api, "fleetMarks").mockResolvedValue(marks);
		function Chart() {
			const deploys = useDeployMarks({ from: Date.UTC(2026, 9, 7), to: Date.UTC(2026, 9, 9) });
			return (
				<>
					<DeployMarksToggle {...deploys} />
					<DayBars data={data} label="Players" marks={deploys.marks} />
				</>
			);
		}
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<Chart />
			</QueryClientProvider>,
		);
		const toggle = await screen.findByRole("button", { name: "Deploys (2)" });
		expect(document.querySelectorAll("[data-mark]").length).toBe(1);
		fireEvent.click(toggle);
		await waitFor(() => expect(document.querySelectorAll("[data-mark]").length).toBe(0));
		expect(localStorage.getItem("tt-explorer-deploy-marks")).toBe("off");
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
	});
});
