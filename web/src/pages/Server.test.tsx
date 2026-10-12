// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FleetServer, FleetServerDetail, HealthReason, RemoteCommand, RemoteOp } from "@/lib/types";
import ServerPage, { CONNECTING_TEXT, WAKING_TEXT } from "./Server";

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
/** A player name that must stay in the page's memory: never localStorage, the URL or the query cache. */
const MARKER = "MarkerPlayer7c1f";

const row: FleetServer & { closedAt: string | null; lostAt: string | null } = {
	job: JOB,
	serverType: "public",
	branch: "prod",
	channel: "prod",
	artifact: "art-42",
	players: 3,
	maxPlayers: 20,
	startedAt: new Date(Date.now() - 3_600_000).toISOString(),
	lastSeen: new Date().toISOString(),
	appliedSeq: 7,
	generation: 2,
	health: "ok",
	lastError: null,
	kernel: "0.5.0",
	experiment: false,
	closedAt: null,
	lostAt: null,
};

const detail = (over: Partial<FleetServerDetail> = {}): FleetServerDetail => ({ server: row, state: "live", debug: { watched: true, connected: true, lastPollAt: Date.now() }, ...over });

const answers: Partial<Record<RemoteOp, unknown>> = {
	status: { status: { placeVersion: 4321, uptime: 3600, players: 3, maxPlayers: 20, kernelVersion: "0.5.0", memoryMb: 812, luaHeapKb: 20480, health: { state: "ok" } }, fleet: {} },
	players: { players: [{ userId: 777001, name: MARKER, displayName: "Marker", dev: false, pingMs: 80, accountAge: 120, client: { ok: true, generation: "g2" } }], max: 20 },
	"player.logs": { userId: 777001, name: MARKER, entries: [{ i: 1, t: 1_760_000_000, kind: "warning", text: `client says hi from ${MARKER}` }] },
	logs: { entries: [{ i: 41, t: 1_760_000_000, kind: "output", text: "server line 41" }], last: 41 },
	// One reply per query: the roots, or the Inventory table.
	state: (args: { queries: { root: string }[] }) =>
		args.queries.map((q) =>
			q.root === ""
				? { type: "roots", preview: "", size: 1, matched: 1, page: 0, pages: 1, hasMore: false, entries: [{ key: "Inventory", seg: "Inventory", type: "module", preview: "{2}", expandable: true }] }
				: { type: "table", preview: "{2}", size: 2, matched: 2, page: 0, pages: 1, hasMore: false, entries: [{ key: "capacity", seg: "scapacity", type: "number", preview: "40", expandable: false }, { key: "items", seg: "sitems", type: "table", preview: "{3}", expandable: true }] },
		),
	"dex.children": (args: { nodes: { id: number }[] }) =>
		args.nodes.map((n) => ({ id: n.id, offset: 0, total: n.id === 0 ? 2 : 0, rows: n.id === 0 ? [{ id: 1, name: "Workspace", className: "Workspace", childCount: 3, parent: 0 }, { id: 2, name: "Lighting", className: "Lighting", childCount: 0, parent: 0 }] : [] })),
	"dex.props": (args: { id: number }) => ({ id: args.id, name: "Workspace", className: "Workspace", path: "game.Workspace", props: [{ name: "Gravity", category: "Physics", kind: "number", text: "196.2" }], attrs: [], tags: [] }),
};

function mockApi(d: FleetServerDetail = detail(), watchConnected = true, wake?: boolean) {
	const fleetServer = vi.spyOn(api, "fleetServer").mockResolvedValue(d);
	const watchServer = vi.spyOn(api, "watchServer").mockResolvedValue({ job: JOB, watched: true, connected: watchConnected, ...(wake !== undefined ? { wake } : {}) });
	vi.spyOn(api, "serverMetrics").mockResolvedValue([
		{ t: Date.now() - 60_000, tps: 59.9, tpsMin: 55, physFps: 60, memMb: 800, luaMb: 120, players: 3 },
		{ t: Date.now(), tps: 58.2, tpsMin: 50, physFps: 60, memMb: 812, luaMb: 121, players: 3 },
	]);
	vi.spyOn(api, "debugAudit").mockResolvedValue([]);
	let n = 0;
	const remoteCommand = vi.spyOn(api, "remoteCommand").mockImplementation(async (_job, op, args) => {
		n += 1;
		const answer = answers[op];
		const result = typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : (answer ?? {});
		const command: RemoteCommand = { id: `c${n}`, op, state: "done", createdAt: 0, expiresAt: 0, doneAt: Date.now(), ms: 3, result };
		return command;
	});
	return { fleetServer, watchServer, remoteCommand };
}

function Probe() {
	const location = useLocation();
	return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function mount(path = `/servers/${JOB}`) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={client}>
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
		</QueryClientProvider>,
	);
	return { client, view };
}

describe("the server page", () => {
	it("watches a live server, fetches the kernel status on first view and shows the place version and the last hour's charts", async () => {
		const { watchServer, remoteCommand } = mockApi();
		mount();
		expect(await screen.findByText("Server 0b5c7d…789abc")).toBeTruthy();
		await waitFor(() => expect(watchServer).toHaveBeenCalledWith(JOB, expect.anything()));
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "status", undefined, expect.anything()));
		expect((await screen.findAllByText("4321")).length).toBeGreaterThan(0);
		expect(screen.getByText(/^Connected/)).toBeTruthy();
		expect(await screen.findByLabelText("Server TPS over the last 60 minutes")).toBeTruthy();
		expect(screen.getByLabelText("Memory over the last 60 minutes")).toBeTruthy();
		// Only the status op ran: the other tabs fetch when they are first opened.
		expect(remoteCommand.mock.calls.map((c) => c[1])).toEqual(["status"]);
	});

	it("waits for the server's first poll before any fetch, and says so", async () => {
		const { remoteCommand } = mockApi(detail({ debug: { watched: true, connected: false } }), false);
		mount();
		expect(await screen.findByText(CONNECTING_TEXT)).toBeTruthy();
		const buttons = screen.getAllByRole("button", { name: "Fetch" }) as HTMLButtonElement[];
		expect(buttons.length).toBeGreaterThan(3);
		for (const button of buttons) {
			expect(button.disabled).toBe(true);
			expect(button.title).toBe(CONNECTING_TEXT);
		}
		expect(remoteCommand).not.toHaveBeenCalled();
	});

	it("says Waking server... while a wake is on its way, re-reads the server every second, and connects as soon as it polls", async () => {
		const { fleetServer, remoteCommand } = mockApi(detail({ debug: { watched: true, connected: false } }), false, true);
		mount();
		expect(await screen.findByText(WAKING_TEXT)).toBeTruthy();
		expect(screen.queryByText(CONNECTING_TEXT)).toBeNull();
		for (const button of screen.getAllByRole("button", { name: "Fetch" }) as HTMLButtonElement[]) {
			expect(button.disabled).toBe(true);
			expect(button.title).toBe(WAKING_TEXT);
		}
		expect(remoteCommand).not.toHaveBeenCalled();
		// The woken server polls: the next read (a second later, not five) says connected and the first fetch runs.
		const calls = fleetServer.mock.calls.length;
		fleetServer.mockResolvedValue(detail());
		await waitFor(() => expect(screen.getByText(/^Connected/)).toBeTruthy(), { timeout: 2500 });
		expect(fleetServer.mock.calls.length).toBeGreaterThan(calls);
		expect(screen.queryByText(WAKING_TEXT)).toBeNull();
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "status", undefined, expect.anything()));
	});

	it("without a wake (no messaging key, or an older backend) it keeps the heartbeat text", async () => {
		mockApi(detail({ debug: { watched: true, connected: false } }), false, false);
		mount();
		expect(await screen.findByText(CONNECTING_TEXT)).toBeTruthy();
		expect(screen.queryByText(WAKING_TEXT)).toBeNull();
	});

	it("a closed server: no watch, no debug tabs, its whole life and when it closed", async () => {
		const closedAt = "2026-10-09T10:00:00.000Z";
		const { watchServer, remoteCommand } = mockApi(detail({ state: "closed", server: { ...row, closedAt }, debug: { watched: false, connected: false } }));
		mount();
		expect(await screen.findByText(/This server closed at 2026-10-09 10:00:00 UTC: nothing to debug/)).toBeTruthy();
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(await screen.findByLabelText("Server TPS over its whole life")).toBeTruthy();
		expect(screen.getByText("Offline")).toBeTruthy();
		expect(screen.getByText("closed at 2026-10-09 10:00:00 UTC")).toBeTruthy();
		expect(watchServer).not.toHaveBeenCalled();
		expect(remoteCommand).not.toHaveBeenCalled();
	});

	it("lists why a degraded server needs a look: each signal, its reading and its line, and the last error", async () => {
		const reasons: HealthReason[] = [
			{ signal: "health", label: "Kernel health", value: "degraded", threshold: "ok", unit: null, op: "!=" },
			{ signal: "tps", label: "TPS", value: 42.5, threshold: 50, unit: "TPS", op: "<" },
		];
		mockApi(detail({ server: { ...row, health: "degraded", lastError: "boom at Round:42", reasons } }));
		mount();
		const list = await screen.findByRole("region", { name: "Why this server needs a look" });
		expect(list.textContent).toContain("Why it is degraded");
		expect(within(list).getByText("Kernel health degraded")).toBeTruthy();
		expect(within(list).getByText("TPS 42.5, under 50")).toBeTruthy();
		expect(within(list).getByText("Last error: boom at Round:42")).toBeTruthy();
	});

	it("a healthy server has no reasons list", async () => {
		mockApi(detail({ server: { ...row, reasons: [] } }));
		mount();
		expect(await screen.findByText("Server 0b5c7d…789abc")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Why this server needs a look" })).toBeNull();
	});

	it("an unknown JobId says there is nothing to debug", async () => {
		const { watchServer } = mockApi({ server: null, state: "unknown", debug: { watched: false, connected: false } });
		mount();
		expect(await screen.findByText("No heartbeat from this JobId")).toBeTruthy();
		expect(watchServer).not.toHaveBeenCalled();
	});

	it("Players -> Logs reads that player's client log; answers stay out of localStorage, the URL and the query cache", async () => {
		const { remoteCommand } = mockApi();
		const { client } = mount(`/servers/${JOB}?tab=players`);
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "players", undefined, expect.anything()));
		expect(await screen.findByText("Marker")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: `Client logs of ${MARKER}` }));
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "player.logs", { userId: 777001 }, expect.anything()));
		expect(await screen.findByText(`client says hi from ${MARKER}`)).toBeTruthy();
		expect(screen.getByTestId("location").textContent).toBe(`/servers/${JOB}?tab=logs`);
		// Straight to the player's log: the server log (fetched on its own first view) was not fetched on the way.
		// (status runs once on connect, whatever the tab: the header's place version)
		expect(remoteCommand.mock.calls.map((c) => c[1]).sort()).toEqual(["player.logs", "players", "status"]);
		for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i) as string)).not.toContain(MARKER);
		expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(MARKER);
	});

	it("the Logs tab fetches the server's newest lines, then only newer ones", async () => {
		const { remoteCommand } = mockApi();
		mount(`/servers/${JOB}?tab=logs`);
		expect(await screen.findByText("server line 41")).toBeTruthy();
		expect(remoteCommand).toHaveBeenCalledWith(JOB, "logs", { limit: 200 }, expect.anything());
		fireEvent.click(screen.getByRole("button", { name: "Fetch newer" }));
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "logs", { since: 41, limit: 500 }, expect.anything()));
	});

	it("State: the roots, then a click opens a module's table, and the breadcrumb goes back", async () => {
		const { remoteCommand } = mockApi();
		mount(`/servers/${JOB}?tab=state`);
		const root = await screen.findByText("Inventory");
		expect(remoteCommand).toHaveBeenCalledWith(JOB, "state", { queries: [{ root: "", path: [], page: 0 }] }, expect.anything());
		fireEvent.click(root);
		expect(await screen.findByText("capacity")).toBeTruthy();
		expect(remoteCommand).toHaveBeenCalledWith(JOB, "state", { queries: [{ root: "Inventory", path: [], page: 0 }] }, expect.anything());
		// A key that isn't a table doesn't open; a filter goes to the server.
		const before = remoteCommand.mock.calls.length;
		fireEvent.click(screen.getByText("capacity"));
		expect(remoteCommand.mock.calls.length).toBe(before);
		fireEvent.change(screen.getByLabelText("Filter keys"), { target: { value: "item" } });
		fireEvent.click(screen.getByRole("button", { name: "Filter" }));
		await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith(JOB, "state", { queries: [{ root: "Inventory", path: [], page: 0, filter: "item" }] }, expect.anything()));
		fireEvent.click(within(screen.getByRole("navigation", { name: "State path" })).getByRole("button", { name: "Roots" }));
		await waitFor(() => expect(remoteCommand.mock.calls.filter((c) => c[1] === "state" && JSON.stringify(c[2]).includes('"root":""')).length).toBe(2));
	});

	it("Dex: game's children on first view, properties of the selected instance", async () => {
		const { remoteCommand } = mockApi();
		mount(`/servers/${JOB}?tab=dex`);
		const workspace = await screen.findByRole("button", { name: "Workspace (Workspace, 3 children)" });
		expect(remoteCommand).toHaveBeenCalledWith(JOB, "dex.children", { nodes: [{ id: 0, offset: 0, limit: 200 }] }, expect.anything());
		fireEvent.click(workspace);
		expect(await screen.findByText("196.2")).toBeTruthy();
		expect(remoteCommand).toHaveBeenCalledWith(JOB, "dex.props", { id: 1 }, expect.anything());
		// Nothing that writes exists on the page.
		for (const word of [/^Set$/, /^Rename$/, /^Destroy$/, /^Delete$/, /^Kick$/]) expect(screen.queryByRole("button", { name: word })).toBeNull();
	});
});
