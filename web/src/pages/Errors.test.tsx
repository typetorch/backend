// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sparkPaths } from "@/components/Sparkline";
import { api } from "@/lib/api";
import type { ErrorDetail, ErrorList, ErrorPlayers } from "@/lib/types";
import Errors, { artifactOptions, bucketLabel, playerLabel } from "./Errors";

beforeAll(() => {
	// recharts measures its container.
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

const window24 = { from: "2026-10-08T12:00:00.000Z", to: "2026-10-09T12:00:00.000Z", bucketSeconds: 1800, buckets: 48 };
const list: ErrorList = {
	window: window24,
	kinds: [
		{
			fp: "fp-boom",
			template: "Script <player.name> failed: attempt to index nil",
			topFrame: "Workspace.Game.Round:42",
			realm: "server",
			count: 12,
			players: 4,
			firstAt: "2026-10-09T11:57:00.000Z",
			lastAt: "2026-10-09T11:59:00.000Z",
			total: 12,
			spark: [0, 4, 6, 2],
		},
		{ fp: "fp-two", template: "HTTP 429 from <url>", topFrame: null, realm: "client", count: 1, players: 0, firstAt: "2026-10-09T10:00:00.000Z", lastAt: "2026-10-09T10:00:00.000Z", total: 1, spark: [1] },
	],
	totals: { count: 13, kinds: 2, players: 4 },
	more: 0,
};
const detail: ErrorDetail = {
	kind: { fp: "fp-boom", template: list.kinds[0]!.template, stack: "Workspace.Game.Round:42\nWorkspace.Game.Main:7", realm: "server", firstAt: list.kinds[0]!.firstAt, lastAt: list.kinds[0]!.lastAt, total: 12 },
	window: window24,
	count: 12,
	players: 4,
	series: [
		{ t: "2026-10-09T11:00:00.000Z", n: 4 },
		{ t: "2026-10-09T11:30:00.000Z", n: 8 },
	],
	byBuild: [
		{ build: "a1b2c3d-000042", n: 10 },
		{ build: "b2-000043", n: 2 },
	],
	byBranch: [{ branch: "prod", n: 12 }],
	byRealm: [{ realm: "server", n: 12 }],
};

const players: ErrorPlayers = {
	fp: "fp-boom",
	window: { from: window24.from, to: window24.to },
	players: [
		{ pid: "pid-aaaa", uid: 4242, name: "Tester", displayName: "Test Player", count: 10, days: 1, firstAt: "2026-10-09T11:57:00.000Z", lastAt: "2026-10-09T11:58:00.000Z", realms: ["server"] },
		{ pid: "pid-bbbb", count: 2, days: 1, firstAt: "2026-10-09T11:59:00.000Z", lastAt: "2026-10-09T11:59:00.000Z", realms: ["client"] },
	],
	total: 2,
	more: 0,
	withoutPlayer: [{ realm: "server", count: 3, firstAt: "2026-10-09T11:00:00.000Z", lastAt: "2026-10-09T11:00:59.999Z" }],
};

/** Where the router is (the Players page stand-in shows its search). */
function PlayersStandIn() {
	const { search } = useLocation();
	return <div>Players page {search}</div>;
}

function mount(path = "/errors") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/errors" element={<Errors />} />
					<Route path="/players" element={<PlayersStandIn />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("Errors page", () => {
	it("lists kinds with counts, players, side and when; a click shows the sample stack and where it happens", async () => {
		const errors = vi.spyOn(api, "errors").mockResolvedValue(list);
		const kind = vi.spyOn(api, "errorKind").mockResolvedValue(detail);
		vi.spyOn(api, "errorPlayers").mockResolvedValue(players);
		mount();
		expect(await screen.findByText("Script <player.name> failed: attempt to index nil")).toBeTruthy();
		expect(screen.getByText("Workspace.Game.Round:42")).toBeTruthy();
		expect(screen.getByText("HTTP 429 from <url>")).toBeTruthy();
		const row = screen.getByText("Script <player.name> failed: attempt to index nil").closest("tr") as HTMLElement;
		expect(within(row).getByText("server")).toBeTruthy();
		expect(within(row).getByText("12")).toBeTruthy();
		expect(within(row).getByText("4")).toBeTruthy();
		expect(within(row).getByRole("img", { name: /errors per 30 min, peak 6/ })).toBeTruthy();
		// The window and totals come from the backend's answer.
		expect(screen.getByText("13")).toBeTruthy();
		expect(errors).toHaveBeenCalledWith(expect.objectContaining({ window: "24h", limit: 200 }), expect.anything());
		fireEvent.click(row);
		expect(await screen.findByText("Sample stack (from the first report)")).toBeTruthy();
		await waitFor(() => expect(document.body.textContent).toContain("Workspace.Game.Main:7"));
		expect(screen.getByText("a1b2c3d-000042")).toBeTruthy();
		expect(screen.getByText("By build")).toBeTruthy();
		expect(kind).toHaveBeenCalledWith("fp-boom", expect.objectContaining({ window: "24h" }), expect.anything());
	});

	it("Enter or Space on a focused row opens the error and its players; a player links to their page", async () => {
		vi.spyOn(api, "errors").mockResolvedValue(list);
		vi.spyOn(api, "errorKind").mockResolvedValue(detail);
		const who = vi.spyOn(api, "errorPlayers").mockResolvedValue(players);
		mount("/errors?range=7d");
		const row = (await screen.findByText("Script <player.name> failed: attempt to index nil")).closest("tr") as HTMLElement;
		expect(row.getAttribute("tabindex")).toBe("0");
		expect(row.getAttribute("aria-label")).toBe("Open error: Script <player.name> failed: attempt to index nil");
		row.focus();
		fireEvent.keyDown(row, { key: "Enter" });
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Selected error")).toBeTruthy();
		const table = await within(dialog).findByRole("table", { name: "Players who hit this error" });
		// Named player first: the Roblox names, the UserId, the count; an unlinked one by pid; then the server row.
		const link = within(table).getByRole("link", { name: "Test Player (@Tester)" });
		expect(link.getAttribute("href")).toBe("/players?range=7d&pid=pid-aaaa");
		expect(within(table).getByRole("link", { name: /UserId 4242/ }).getAttribute("href")).toBe("https://www.roblox.com/users/4242/profile");
		expect(within(table).getByRole("link", { name: "pid-bbbb" }).getAttribute("href")).toBe("/players?range=7d&pid=pid-bbbb");
		expect(within(table).getByText("not linked")).toBeTruthy();
		expect(within(table).getByText("no player named")).toBeTruthy();
		const serverRow = within(table).getByText("no player named").closest("tr") as HTMLElement;
		expect(within(serverRow).queryByRole("link")).toBeNull();
		expect(within(serverRow).getByText("3")).toBeTruthy();
		expect(who).toHaveBeenCalledWith("fp-boom", expect.objectContaining({ window: "24h" }), expect.anything());
		// Following the link opens the player's page.
		fireEvent.click(link);
		expect(await screen.findByText("Players page ?range=7d&pid=pid-aaaa")).toBeTruthy();
	});

	it("Space opens it too, and a shared link (?fp=) opens it with the page's filters (the search only picks kinds)", async () => {
		vi.spyOn(api, "errors").mockResolvedValue(list);
		const kind = vi.spyOn(api, "errorKind").mockResolvedValue(detail);
		const who = vi.spyOn(api, "errorPlayers").mockResolvedValue({ ...players, players: [], withoutPlayer: [], total: 0 });
		mount("/errors?window=7d&realm=client&branch=dev&build=b2-000043&q=boom&fp=fp-boom");
		const dialog = await screen.findByRole("dialog");
		expect(await within(dialog).findByText("No players hit it in this window.")).toBeTruthy();
		const filters = { window: "7d", realm: "client", branch: "dev", build: "b2-000043" };
		expect(who).toHaveBeenCalledWith("fp-boom", filters, expect.anything());
		expect(kind).toHaveBeenCalledWith("fp-boom", filters, expect.anything());
		cleanup();
		mount();
		const row = (await screen.findByText("HTTP 429 from <url>")).closest("tr") as HTMLElement;
		fireEvent.keyDown(row, { key: " " });
		expect(await screen.findByRole("dialog")).toBeTruthy();
		await waitFor(() => expect(who).toHaveBeenLastCalledWith("fp-two", { window: "24h" }, expect.anything()));
	});

	it("filters by artifact from the URL, together with the other filters, and shows the choice", async () => {
		const errors = vi.spyOn(api, "errors").mockResolvedValue({ ...list, builds: [{ build: "b2-000043", n: 2, lastAt: "2026-10-09T11:59:00.000Z" }, { build: "a1b2c3d-000042", n: 11, lastAt: "2026-10-09T11:58:00.000Z" }] });
		mount("/errors?build=a1b2c3d-000042&realm=server&window=6h");
		expect(await screen.findByText("Script <player.name> failed: attempt to index nil")).toBeTruthy();
		expect(errors).toHaveBeenCalledWith(expect.objectContaining({ window: "6h", realm: "server", build: "a1b2c3d-000042", limit: 200 }), expect.anything());
		expect(screen.getByRole("combobox", { name: "Artifact" }).textContent).toContain("a1b2c3d-000042");
	});

	it("without an artifact chosen the select says any and the request has no build", async () => {
		const errors = vi.spyOn(api, "errors").mockResolvedValue(list);
		mount();
		expect(await screen.findByText("HTTP 429 from <url>")).toBeTruthy();
		expect(errors.mock.calls[0]![0]).not.toHaveProperty("build");
		expect(screen.getByRole("combobox", { name: "Artifact" }).textContent).toContain("Any artifact");
	});

	it("says so when there are no errors", async () => {
		vi.spyOn(api, "errors").mockResolvedValue({ ...list, kinds: [], totals: { count: 0, kinds: 0, players: 0 } });
		mount();
		expect(await screen.findByText(/No errors in this window/)).toBeTruthy();
	});

	it("names a failure of the backend", async () => {
		vi.spyOn(api, "errors").mockRejectedValue(new Error("the backend is not answering"));
		mount();
		expect(await screen.findByText("the backend is not answering")).toBeTruthy();
	});
});

describe("player labels", () => {
	it("display name and username, the username alone, or the short pid", () => {
		const base = players.players[0]!;
		expect(playerLabel(base)).toBe("Test Player (@Tester)");
		expect(playerLabel({ ...base, displayName: "Tester" })).toBe("@Tester");
		expect(playerLabel({ ...base, name: undefined, pid: "abcdefghijklmnopqrstuvwxyz" })).toBe("abcdefghij…qrstuvwxyz");
	});
});

describe("artifact options", () => {
	it("keeps the backend's order (most recent first) and adds a chosen artifact the window no longer has", () => {
		const builds = [{ build: "new" }, { build: "old" }];
		expect(artifactOptions(builds, "")).toEqual(["new", "old"]);
		expect(artifactOptions(builds, "old")).toEqual(["new", "old"]);
		expect(artifactOptions(builds, "gone")).toEqual(["gone", "new", "old"]);
		expect(artifactOptions(undefined, "")).toEqual([]);
	});
});

describe("trend lines", () => {
	it("draws a line and an area scaled to the peak", () => {
		const { line, area, max } = sparkPaths([0, 5, 10], 100, 20);
		expect(max).toBe(10);
		expect(line).toBe("M0 18 L50 10 L100 2");
		expect(area).toBe("M0 18 L50 10 L100 2 L100 18 L0 18 Z");
	});

	it("handles nothing, one point and all zeros", () => {
		expect(sparkPaths([], 100, 20)).toEqual({ line: "", area: "", max: 0 });
		expect(sparkPaths([3], 100, 20).line).toBe("M0 2");
		expect(sparkPaths([0, 0], 100, 20).line).toBe("M0 18 L100 18");
	});

	it("names the bucket size", () => {
		expect(bucketLabel(60)).toBe("1 min");
		expect(bucketLabel(1800)).toBe("30 min");
		expect(bucketLabel(7200)).toBe("2 h");
		expect(bucketLabel(86_400)).toBe("1 d");
	});
});
