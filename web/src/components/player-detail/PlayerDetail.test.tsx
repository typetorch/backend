// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { GraphData, PlayerProfile, PlayerStatsResult, PlayersResult, TimelineResult } from "@/lib/types";
import Players from "@/pages/Players";
import { bucketLabel } from "./SeriesView";

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
	localStorage.clear();
});

const ALPHA = "pid-alpha-0001";
const BETA = "pid-beta-00002";
const GAMMA = "pid-gamma-0003";
const DELTA = "pid-delta-0004";

const players: PlayersResult = {
	players: [
		{ pid: ALPHA, firstSeen: "2026-10-03T10:00:00.000Z", lastSeen: "2026-10-08T10:20:00.000Z", sessions: 2, events: 12, playtimeMinutes: 15, newInRange: false, uid: 31337 },
		{ pid: BETA, firstSeen: "2026-10-04T10:00:00.000Z", lastSeen: "2026-10-04T10:05:00.000Z", sessions: 1, events: 3, playtimeMinutes: 5, newInRange: true },
	],
};

const days = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
function statsFor(pid: string, empty = false): PlayerStatsResult {
	return {
		pid,
		window: { from: "2026-10-03T00:00:00.000Z", to: "2026-10-09T12:00:00.000Z", bucket: "day", bucketMs: 86_400_000, days: 7, clamped: false },
		totals: empty
			? { sessions: 0, events: 0, playtimeMinutes: 0, avgSessionMinutes: 0, medianSessionMinutes: 0, playtimePerDayMinutes: 0, activeDays: 0, robux: 0, purchases: 0, firstSeen: null, lastSeen: null }
			: {
					sessions: 2,
					events: 12,
					playtimeMinutes: 15,
					avgSessionMinutes: 7.5,
					medianSessionMinutes: 7.5,
					playtimePerDayMinutes: 2.1,
					activeDays: 2,
					robux: 99,
					purchases: 1,
					firstSeen: "2026-10-03T10:00:00.000Z",
					lastSeen: "2026-10-08T10:20:00.000Z",
				},
		series: days.map((d) => ({
			start: `${d}T00:00:00.000Z`,
			sessions: !empty && (d === "2026-10-03" || d === "2026-10-08") ? 1 : 0,
			minutes: empty ? 0 : d === "2026-10-03" ? 10 : d === "2026-10-08" ? 5 : 0,
			robux: !empty && d === "2026-10-08" ? 99 : 0,
			purchases: !empty && d === "2026-10-08" ? 1 : 0,
		})),
		sessions: empty
			? []
			: [
					{ sid: "sid-two", start: "2026-10-08T10:15:00.000Z", end: "2026-10-08T10:20:00.000Z", minutes: 5, events: 4, firstSession: false, dev: "phone", art: "a1b2c3d-000002" },
					{ sid: "sid-one", start: "2026-10-03T10:00:00.000Z", end: "2026-10-03T10:10:00.000Z", minutes: 10, events: 8, firstSession: true, dev: "phone", art: "a1b2c3d-000001" },
				],
		sessionsTruncated: false,
		purchases: empty ? [] : [{ time: "2026-10-08T10:16:00.000Z", t: Date.parse("2026-10-08T10:16:00.000Z"), kind: "product", product: "1234", robux: 99, where: "shop", sid: "sid-two" }],
		purchasesTruncated: false,
	};
}

const timeline: TimelineResult = {
	pid: ALPHA,
	uid: 31337,
	sessions: [{ sid: "sid-one", start: "2026-10-03T10:00:00.000Z", end: "2026-10-03T10:10:00.000Z", minutes: 10, events: 1, firstSession: true, art: "a1b2c3d-000001", dev: "phone" }],
	events: [{ time: "2026-10-03T10:00:00.000Z", t: Date.parse("2026-10-03T10:00:00.000Z"), kind: "session", name: "join", sid: "sid-one", state: "zone:Lobby", art: "a1b2c3d-000001", src: "server", props: { from: "direct" } }],
	truncated: false,
};
const graph: GraphData = { kind: "player", facet: "all", pid: ALPHA, nodes: [], edges: [], hiddenEdges: 0 };

const profiles: Record<string, PlayerProfile | Error> = {
	[ALPHA]: { pid: ALPHA, linked: true, uid: 31337, roblox: "ok", cached: false, name: "builder_alpha", displayName: "Builder Alpha", avatar: "https://tr.rbxcdn.com/alpha/150/150/AvatarHeadshot/Png/noFilter" },
	[BETA]: { pid: BETA, linked: false },
	[GAMMA]: new ApiError(500, "internal error", `/v1/identity/${GAMMA}/profile`),
	[DELTA]: { pid: DELTA, linked: true, uid: 4242, roblox: "unavailable", cached: false, name: null, displayName: null, avatar: null },
};

let queried: string[] = [];
beforeEach(() => {
	queried = [];
	vi.spyOn(api, "identitySummary").mockResolvedValue({ count: 1, backfill: false });
	vi.spyOn(api, "identity").mockResolvedValue([]);
	vi.spyOn(api, "robloxProducts").mockImplementation(async (ids) =>
		(ids.product ?? []).map((id) => ({ type: "product" as const, id, status: "ok" as const, name: `Coins pack ${id}`, price: 99, forSale: true, icon: null })),
	);
	vi.spyOn(api, "playerProfile").mockImplementation(async (pid: string) => {
		const p = profiles[pid];
		if (p instanceof Error) throw p;
		return p ?? { pid, linked: false };
	});
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: { pid?: string } = {}) => {
		queried.push(name);
		if (name === "players") return players;
		if (name === "player-stats") return statsFor(options.pid ?? "", options.pid === BETA);
		if (name === "timeline") return timeline;
		if (name === "player-graph") return graph;
		if (name === "funnel-progress") return { funnels: [], progress: [] };
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
});

let location = "";
function Where() {
	const l = useLocation();
	location = l.search;
	return null;
}

function mount(search = "") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[`/players${search}`]}>
				<Players />
				<Where />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const detail = () => screen.findByRole("region", { name: "Player detail" });
const viewButton = (region: HTMLElement, name: string) => within(within(region).getByRole("navigation", { name: "Player views" })).getByRole("button", { name });

describe("Players page: the player detail container", () => {
	it("appears under the list when a player is picked, with the Roblox profile and the range's numbers", async () => {
		mount();
		expect(await screen.findByText("Pick a player in the list.")).toBeTruthy();
		fireEvent.click((await screen.findByText(ALPHA)).closest("tr") as HTMLElement);
		const region = await detail();
		expect(location).toContain(`pid=${ALPHA}`);
		expect(await within(region).findByRole("heading", { name: "Builder Alpha" })).toBeTruthy();
		expect(within(region).getByText("@builder_alpha")).toBeTruthy();
		const avatar = within(region).getByRole("img", { name: "Builder Alpha, Roblox avatar" }) as HTMLImageElement;
		expect(avatar.src).toBe("https://tr.rbxcdn.com/alpha/150/150/AvatarHeadshot/Png/noFilter");
		expect(avatar.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(within(region).getByRole("link", { name: /UserId 31337/ }).getAttribute("href")).toBe("https://www.roblox.com/users/31337/profile");
		expect(within(region).getByText(ALPHA)).toBeTruthy();
		expect(await within(region).findAllByText("99 Robux")).not.toHaveLength(0);
		expect(within(region).getByText("2.1 min")).toBeTruthy();
		expect(within(region).getByText("2026-10-03 10:00:00")).toBeTruthy();
		expect(api.playerProfile).toHaveBeenCalledWith(ALPHA, expect.anything());
	});

	it("switches views with the buttons: Spending, Playtime, Sessions, Timeline (the timeline loads only there)", async () => {
		mount(`?pid=${ALPHA}`);
		const region = await detail();
		// Spending first: the line, and the purchases with product, price and place.
		expect(viewButton(region, "Spending").getAttribute("aria-pressed")).toBe("true");
		expect(await within(region).findByRole("img", { name: "Robux per day, line chart" })).toBeTruthy();
		const purchases = within(region).getByRole("table", { name: "Purchases" });
		expect(within(purchases).getByText("1234")).toBeTruthy();
		// The product id says what it is: its name beside it, and a card on focus.
		expect(await within(purchases).findByText("Coins pack 1234")).toBeTruthy();
		expect(within(purchases).getByRole("button", { name: "Developer product 1234: Coins pack 1234" })).toBeTruthy();
		expect(within(purchases).getByText("shop")).toBeTruthy();
		expect(queried).not.toContain("timeline");

		fireEvent.click(viewButton(region, "Playtime"));
		expect(await within(region).findByRole("img", { name: "Minutes played per day, line chart" })).toBeTruthy();
		expect(within(region).getByText("Avg per day")).toBeTruthy();
		expect(within(region).getByText("2 of 7")).toBeTruthy();
		expect(location).toContain("view=playtime");

		fireEvent.click(viewButton(region, "Sessions"));
		expect(await within(region).findByRole("img", { name: "Sessions per day, line chart" })).toBeTruthy();
		expect(within(region).getByText("Median length")).toBeTruthy();
		const sessions = within(region).getByRole("table", { name: "Sessions" });
		expect(within(sessions).getByText("2026-10-08 10:15:00")).toBeTruthy();
		expect(within(sessions).getByText("first session")).toBeTruthy();

		fireEvent.click(viewButton(region, "Timeline"));
		expect(await within(region).findByRole("region", { name: "Session 2026-10-03 10:00:00" })).toBeTruthy();
		expect(queried).toContain("timeline");
		expect(within(region).getByRole("button", { name: /View graph/ })).toBeTruthy();
		expect(viewButton(region, "Timeline").getAttribute("aria-pressed")).toBe("true");
	});

	it("a session row opens the Timeline view on that session", async () => {
		mount(`?pid=${ALPHA}&view=sessions`);
		const region = await detail();
		const sessions = await within(region).findByRole("table", { name: "Sessions" });
		fireEvent.click(within(sessions).getByText("2026-10-03 10:00:00").closest("tr") as HTMLElement);
		await waitFor(() => expect(location).toContain("view=timeline"));
		expect(location).toContain("sid=sid-one");
	});

	it("Table shows the same numbers in the shared table, per day; Chart goes back", async () => {
		mount(`?pid=${ALPHA}`);
		const region = await detail();
		await within(region).findByRole("img", { name: "Robux per day, line chart" });
		fireEvent.click(within(region).getByRole("radio", { name: "Table" }));
		const table = await within(region).findByRole("table", { name: "Robux per day" });
		expect(within(region).queryByRole("img", { name: "Robux per day, line chart" })).toBeNull();
		expect(location).toContain("show=table");
		const row = within(table).getByText("2026-10-08").closest("tr") as HTMLElement;
		expect(within(row).getByText("99 Robux")).toBeTruthy();
		expect(within(row).getByText("1")).toBeTruthy();
		// The choice holds across views.
		fireEvent.click(viewButton(region, "Playtime"));
		expect(await within(region).findByRole("table", { name: "Minutes played per day" })).toBeTruthy();
		fireEvent.click(within(region).getByRole("radio", { name: "Chart" }));
		expect(await within(region).findByRole("img", { name: "Minutes played per day, line chart" })).toBeTruthy();
	});

	it("a pid without a UserId says not linked, without an avatar; empty numbers say so", async () => {
		mount(`?pid=${BETA}`);
		const region = await detail();
		expect(await within(region).findByText("not linked", { selector: "[data-slot=badge]" })).toBeTruthy();
		expect(within(region).queryByRole("img", { name: /Roblox avatar/ })).toBeNull();
		expect(within(region).queryByRole("link", { name: /UserId/ })).toBeNull();
		expect(await within(region).findByText("No Robux spent in this range.")).toBeTruthy();
		expect(within(region).getByText("No purchases in this range.")).toBeTruthy();
	});

	it("when the profile lookup fails the card still shows the pid and the numbers; when Roblox doesn't answer, the UserId", async () => {
		mount(`?pid=${GAMMA}`);
		let region = await detail();
		expect(await within(region).findByText("profile unavailable")).toBeTruthy();
		expect(within(region).getByText(GAMMA)).toBeTruthy();
		expect(await within(region).findAllByText("99 Robux")).not.toHaveLength(0);
		cleanup();
		mount(`?pid=${DELTA}`);
		region = await detail();
		expect(await within(region).findByText("Roblox didn't answer")).toBeTruthy();
		expect(within(region).getByRole("heading", { name: "UserId 4242" })).toBeTruthy();
		expect(within(region).getByRole("link", { name: /UserId 4242/ })).toBeTruthy();
	});
});

describe("short ranges (the hour presets)", () => {
	it("say per 5 minutes in the heading, the table and the chart", async () => {
		vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: { pid?: string } = {}) => {
			if (name === "players") return players;
			if (name === "player-stats") {
				const base = statsFor(options.pid ?? "");
				const from = Date.parse("2026-10-09T06:00:00.000Z");
				return {
					...base,
					window: { ...base.window, from: new Date(from).toISOString(), bucket: "5 minutes", bucketMs: 300_000, days: 1 },
					series: Array.from({ length: 72 }, (_, i) => ({ start: new Date(from + i * 300_000).toISOString(), sessions: i === 3 ? 1 : 0, minutes: i === 3 ? 5 : 0, robux: i === 4 ? 99 : 0, purchases: i === 4 ? 1 : 0 })),
				};
			}
			throw new Error(`unexpected query ${name}`);
		}) as typeof api.query);
		mount(`?pid=${ALPHA}&range=6h&show=table`);
		const region = await detail();
		expect(await within(region).findByRole("heading", { name: "Robux per 5 minutes" })).toBeTruthy();
		const table = within(region).getByRole("table", { name: "Robux per 5 minutes" });
		expect(within(table).getByText("Time (UTC)")).toBeTruthy();
		expect(within(within(table).getByText("2026-10-09 06:20").closest("tr") as HTMLElement).getByText("99 Robux")).toBeTruthy();
	});
});

describe("bucketLabel", () => {
	it("days and hours in UTC", () => {
		expect(bucketLabel("2026-10-08T00:00:00.000Z", "day")).toBe("2026-10-08");
		expect(bucketLabel("2026-10-08T14:00:00.000Z", "hour")).toBe("2026-10-08 14:00");
		expect(bucketLabel("2026-10-08T14:05:00.000Z", "5 minutes")).toBe("2026-10-08 14:05");
	});
});
