// @vitest-environment jsdom
// The server page's offline history: a lost or gone server's Offline badge, Timeline, Debug bundles and whole-life
// charts; a bundle's summary card and tabs (as text, never HTML); the read-only role without player logs; the alerts
// table's link to a bundle.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/data-table";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AuthInfo, DebugBundle, FleetAlert, FleetServer, FleetServerDetail, ServerHistory } from "@/lib/types";
import { ALERT_COLUMNS } from "./Fleet";
import ServerPage, { GONE_TEXT } from "./Server";
import { PLAYER_LOGS_OWNERS_TEXT } from "./server/Bundles";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const JOB = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";
const BUNDLE = "00112233445566778899aabbccddeeff";
const at = (iso: string) => new Date(iso).getTime();

const row: FleetServer & { closedAt: string | null; lostAt: string | null } = {
	job: JOB,
	serverType: "public",
	branch: "prod",
	artifact: "art-42",
	players: 3,
	maxPlayers: 20,
	startedAt: "2026-10-09T08:00:00.000Z",
	lastSeen: "2026-10-09T09:58:30.000Z",
	appliedSeq: 7,
	generation: 2,
	health: "failed",
	lastError: "boom",
	kernel: "0.5.3",
	experiment: false,
	closedAt: null,
	lostAt: "2026-10-09T10:00:00.000Z",
};

const summary = {
	id: BUNDLE,
	job: JOB,
	code: "deploy_failed",
	level: "critical" as const,
	message: "generation 3 failed to start",
	closing: false,
	at: at("2026-10-09T09:30:00Z"),
	time: "2026-10-09T09:30:00.000Z",
	kernel: "0.5.3",
	branch: "prod",
	artifact: "art-42",
	seq: 7,
	generation: 3,
	players: 2,
	size: 4096,
	stage: "start",
	error: "Round.luau:42: attempt to index nil",
};

const history: ServerHistory = {
	alerts: [{ id: 9, at: at("2026-10-09T09:29:57Z"), level: "critical", code: "deploy_failed", message: "start failed", job: JOB, acked: false, details: { stage: "start", bundle: BUNDLE } }],
	reports: [{ seq: 7, branch: "prod", artifact: "art-42", job: JOB, result: "failed", error: "boom", seconds: 2, at: at("2026-10-09T09:29:00Z") }],
	bundles: [summary],
	swaps: [{ at: at("2026-10-09T08:00:10Z"), name: "g1", artifact: "art-41", branch: "prod", reason: "boot", loadSeconds: 1.5, swapSeconds: 0.2, bundle: BUNDLE }],
	metrics: { from: at("2026-10-09T08:00:30Z"), to: at("2026-10-09T09:58:30Z") },
};

const lost: FleetServerDetail = { server: row, state: "lost", debug: { watched: false, connected: false }, history };

const bundle: DebugBundle = {
	...summary,
	body: {
		failure: { stage: "start", error: "Round.luau:42: attempt to index nil", report: { r: "failed" }, triggers: [{ code: "start_failed" }, { code: "deploy_failed" }] },
		server: { placeVersion: 77 },
		deploy: { appliedSeq: 7, failing: true, pending: false, history: [{ name: "g1", artifactId: "art-41", branch: "prod", at: "2026-10-09T08:00:10Z", reason: "boot", loadSeconds: 1.5, swapSeconds: 0.2 }], reports: [], refusals: [{ reason: "unsigned" }] },
		fallback: { active: true, moved: 2 },
		players: [
			{ u: 101, n: "PlayerOne", joinedAt: 1_760_000_000, ping: 80 },
			{ u: 102, n: "PlayerTwo", joinedAt: 1_760_000_100, leftAt: 1_760_000_200 },
		],
		serverLog: [{ i: 1, t: 1_760_000_000, kind: "error", text: "<b>not bold</b> server line" }],
		playerLogs: { "101": [{ t: 1_760_000_000, kind: "warning", text: "client line of one" }] },
	},
};

function mockApi(d: FleetServerDetail, b: DebugBundle = bundle) {
	vi.spyOn(api, "fleetServer").mockResolvedValue(d);
	const watchServer = vi.spyOn(api, "watchServer").mockResolvedValue({ job: JOB, watched: true, connected: true });
	const metrics = vi.spyOn(api, "serverMetrics").mockResolvedValue([
		{ t: at("2026-10-09T08:00:00Z"), tps: 60, tpsMin: 55, physFps: 60, memMb: 800, luaMb: 120, players: 3 },
		{ t: at("2026-10-09T09:55:00Z"), tps: 40, tpsMin: 20, physFps: 60, memMb: 900, luaMb: 130, players: 2 },
	]);
	const debugBundle = vi.spyOn(api, "debugBundle").mockResolvedValue(b);
	vi.spyOn(api, "remoteCommand").mockRejectedValue(new Error("no commands in these tests"));
	return { watchServer, metrics, debugBundle };
}

function Probe() {
	const location = useLocation();
	return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function mount(path = `/servers/${JOB}`, auth: AuthInfo | null = null) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<AuthProvider value={auth}>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route
							path="/servers/:jobId"
							element={
								<>
									<ServerPage />
									<Probe />
								</>
							}
						/>
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		</QueryClientProvider>,
	);
}

const tab = (name: RegExp) => fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });

describe("a server that isn't live", () => {
	it("a lost server: Offline badge, how long it ran, the Timeline, its bundles and charts over its whole life", async () => {
		const { watchServer, metrics } = mockApi(lost);
		mount();
		expect(await screen.findByText("lost at 2026-10-09 10:00:00 UTC")).toBeTruthy();
		expect(screen.getByText("Offline")).toBeTruthy();
		expect(screen.getByText("Ran for")).toBeTruthy();
		expect(screen.getByText("2h 00m")).toBeTruthy();
		const timeline = screen.getByRole("list", { name: "Timeline" });
		const items = within(timeline).getAllByRole("listitem").map((li) => li.textContent ?? "");
		expect(items).toHaveLength(5);
		expect(items[0]).toContain("Server lost");
		expect(items[1]).toContain("critical alert deploy_failed");
		expect(items[2]).toContain("Deploy #7: failed");
		expect(items[3]).toContain("Generation g1 started (boot)");
		expect(items[4]).toContain("Server started");
		expect(screen.getByRole("table", { name: "Debug bundles" })).toBeTruthy();
		expect(await screen.findByLabelText("Server TPS over its whole life")).toBeTruthy();
		// The whole life: from where its metrics start.
		expect(metrics).toHaveBeenCalledWith(JOB, history.metrics.from, expect.anything());
		expect(watchServer).not.toHaveBeenCalled();
	});

	it("a gone server (no row left): says so, keeps the Timeline and the bundles", async () => {
		mockApi({ server: null, state: "gone", debug: { watched: false, connected: false }, history });
		mount();
		expect(await screen.findByText(GONE_TEXT)).toBeTruthy();
		expect(screen.getByText("gone")).toBeTruthy();
		expect(within(screen.getByRole("list", { name: "Timeline" })).getAllByRole("listitem")).toHaveLength(3);
		expect(screen.getByRole("table", { name: "Debug bundles" })).toBeTruthy();
	});

	it("the Timeline's alert opens its bundle (?bundle=<id>)", async () => {
		const { debugBundle } = mockApi(lost);
		mount();
		const alert = (await screen.findByText("critical alert deploy_failed")).closest("li") as HTMLElement;
		fireEvent.click(within(alert).getByRole("button", { name: "Open bundle" }));
		await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/servers/${JOB}?bundle=${BUNDLE}`));
		await waitFor(() => expect(debugBundle).toHaveBeenCalledWith(BUNDLE, expect.anything()));
		expect(await screen.findByRole("region", { name: `Debug bundle ${BUNDLE}` })).toBeTruthy();
	});
});

describe("a debug bundle", () => {
	it("an owner: summary card, Players, Server log as text, Player logs, Deploy and swaps; Close", async () => {
		mockApi(lost);
		mount(`/servers/${JOB}?bundle=${BUNDLE}`);
		const card = await screen.findByRole("region", { name: `Debug bundle ${BUNDLE}` });
		expect(within(card).getByText("generation 3 failed to start")).toBeTruthy();
		expect(within(card).getByText("Round.luau:42: attempt to index nil")).toBeTruthy();
		expect(within(card).getByText("start")).toBeTruthy();
		expect(within(card).getByText("start_failed, deploy_failed")).toBeTruthy();
		expect(within(card).getByText("PlayerOne")).toBeTruthy();
		tab(/^Server log/);
		// The kernel's text stays text: no element is made from it.
		expect(await within(card).findByText("<b>not bold</b> server line")).toBeTruthy();
		expect(card.querySelector("b")).toBeNull();
		tab(/^Player logs/);
		expect(await within(card).findByText("client line of one")).toBeTruthy();
		tab(/^Deploy and swaps/);
		expect(await within(card).findByText("Generation history")).toBeTruthy();
		expect(within(card).getByText("art-41")).toBeTruthy();
		expect(within(card).getAllByText(/unsigned/).length).toBeGreaterThan(0);
		expect(within(card).getAllByText(/"moved": 2/).length).toBeGreaterThan(0);
		fireEvent.click(within(card).getByRole("button", { name: "Close the bundle" }));
		await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/servers/${JOB}`));
		expect(screen.queryByRole("region", { name: `Debug bundle ${BUNDLE}` })).toBeNull();
	});

	it("the read-only role: no Player logs tab (the backend sends none), and says why", async () => {
		const { playerLogs: _, ...rest } = bundle.body;
		mockApi(lost, { ...bundle, body: rest, playerLogsHidden: true });
		mount(`/servers/${JOB}?bundle=${BUNDLE}`, { ok: true, role: "web", via: "cookie" });
		const card = await screen.findByRole("region", { name: `Debug bundle ${BUNDLE}` });
		expect(within(card).queryByRole("tab", { name: /^Player logs/ })).toBeNull();
		expect(within(card).getByRole("tab", { name: /^Server log/ })).toBeTruthy();
		expect(within(card).getByText(PLAYER_LOGS_OWNERS_TEXT)).toBeTruthy();
	});

	it("shows on a live server's page too", async () => {
		mockApi({ ...lost, server: { ...row, lostAt: null, lastSeen: new Date().toISOString(), health: "ok" }, state: "live", debug: { watched: true, connected: false } });
		mount();
		expect(await screen.findByRole("table", { name: "Debug bundles" })).toBeTruthy();
		expect(screen.queryByText("Offline")).toBeNull();
		expect(screen.getByText("Up")).toBeTruthy();
	});

	it("an id that isn't a bundle id is ignored", async () => {
		const { debugBundle } = mockApi(lost);
		mount(`/servers/${JOB}?bundle=..%2Fadmin`);
		expect(await screen.findByRole("table", { name: "Debug bundles" })).toBeTruthy();
		expect(debugBundle).not.toHaveBeenCalled();
	});
});

describe("the alerts table", () => {
	it("links an alert's job to its page, and an alert with d.bundle to that bundle", () => {
		const alerts: FleetAlert[] = [
			{ id: 1, at: Date.now(), level: "critical", code: "deploy_failed", message: "m", job: JOB, acked: false, details: { bundle: BUNDLE } },
			{ id: 2, at: Date.now() - 1000, level: "warning", code: "slow", message: "m", job: JOB, acked: false, details: null },
		];
		render(
			<MemoryRouter>
				<DataTable<FleetAlert> id="fleet-alerts" columns={ALERT_COLUMNS} data={alerts} rowId={(a) => String(a.id)} />
			</MemoryRouter>,
		);
		const bundles = screen.getAllByRole("link", { name: "Open bundle" });
		expect(bundles).toHaveLength(1);
		expect(bundles[0].getAttribute("href")).toBe(`/servers/${JOB}?bundle=${BUNDLE}`);
		expect(screen.getAllByRole("link", { name: "0b5c7d…789abc" }).map((l) => l.getAttribute("href"))).toEqual([`/servers/${JOB}`, `/servers/${JOB}`]);
	});
});
