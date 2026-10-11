// @vitest-environment jsdom
/** Funnel progress columns on the Players list: Columns > Add funnel adds one per funnel, kept in the URL, filled from one funnel-progress answer. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FunnelProgressResult, PlayersResult } from "@/lib/types";
import Players from "./Players";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});

const base = { firstSeen: "2026-10-03T10:00:00.000Z", lastSeen: "2026-10-08T10:00:00.000Z", sessions: 1, events: 3, playtimeMinutes: 5, newInRange: false, robux: 0 };
const players: PlayersResult = { players: [{ ...base, pid: "pid-alpha-0001" }, { ...base, pid: "pid-bravo-0002" }] };
const progress: FunnelProgressResult = {
	funnels: [
		{
			name: "v1_tutorial",
			steps: [
				{ step: 1, label: "joined" },
				{ step: 2, label: "moved" },
				{ step: 3, label: "first_fight" },
				{ step: 4, label: "done" },
			],
		},
	],
	progress: [
		{ pid: "pid-alpha-0001", funnel: "v1_tutorial", step: 3, label: "first_fight", reached: 3, of: 4, share: 0.75, reachedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
		{ pid: "pid-alpha-0001", funnel: "v3_tutorial", step: 4, label: "done", reached: 4, of: 4, share: 1 },
		{ pid: "pid-bravo-0002", funnel: "v1_tutorial", step: 1, label: "joined", reached: 1, of: 4, share: 0.25 },
	],
};

let progressCalls: Record<string, unknown>[] = [];
beforeEach(() => {
	progressCalls = [];
	vi.spyOn(api, "identitySummary").mockResolvedValue({ count: 0, backfill: false });
	vi.spyOn(api, "identity").mockResolvedValue([]);
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
		if (name === "players") return players;
		if (name === "funnel") return { funnel: null, funnels: [{ name: "v1_tutorial", players: 40, events: 90 }, { name: "v3_tutorial", players: 30, events: 70 }] };
		if (name === "funnel-progress") {
			progressCalls.push(options);
			return progress;
		}
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
});

let search = "";
function Where() {
	search = useLocation().search;
	return null;
}

function mount(query = "") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[`/players${query}`]}>
				<Players />
				<Where />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const rowOf = (pid: string) => document.querySelector(`[title='${pid}']`)?.closest("tr") as HTMLElement;

describe("Players list: funnel columns", () => {
	it("Columns > Add funnel adds a progress column per funnel, side by side", async () => {
		mount();
		await screen.findByRole("table", { name: "Players" });
		expect(progressCalls).toEqual([]);
		fireEvent.keyDown(screen.getByRole("button", { name: /Columns/ }), { key: "ArrowDown" });
		fireEvent.keyDown(await screen.findByRole("menuitem", { name: /Add funnel/ }), { key: "ArrowRight" });
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /v1_tutorial/ }));
		await waitFor(() => expect(search).toContain("funnels=v1_tutorial"));
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /v3_tutorial/ }));
		await waitFor(() => expect(decodeURIComponent(search)).toContain("funnels=v1_tutorial,v3_tutorial"));
		await waitFor(() => expect(progressCalls.at(-1)).toEqual({ pids: ["pid-alpha-0001", "pid-bravo-0002"] }));
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		await waitFor(() => expect(within(rowOf("pid-alpha-0001")).getAllByRole("progressbar")).toHaveLength(2));
	});

	it("shows each player's progress as a bar with the percentage, and 'not started' without rows", async () => {
		mount("?funnels=v1_tutorial,v3_tutorial");
		const t = await screen.findByRole("table", { name: "Players" });
		expect(within(t).getByRole("columnheader", { name: /v1_tutorial/ })).toBeTruthy();
		expect(within(t).getByRole("columnheader", { name: /v3_tutorial/ })).toBeTruthy();
		await waitFor(() => expect(within(rowOf("pid-alpha-0001")).getByRole("progressbar", { name: /v1_tutorial/ }).textContent).toBe("75%"));
		expect(within(rowOf("pid-alpha-0001")).getByRole("progressbar", { name: /v3_tutorial/ }).textContent).toBe("100%");
		expect(within(rowOf("pid-bravo-0002")).getByRole("progressbar", { name: /v1_tutorial/ }).getAttribute("title")).toBe("Step 1 of 4: joined");
		expect(within(rowOf("pid-bravo-0002")).getByText("not started")).toBeTruthy();
	});

	it("asks for the one funnel when there is one column", async () => {
		mount("?funnels=v1_tutorial");
		await screen.findByRole("table", { name: "Players" });
		await waitFor(() => expect(progressCalls.at(-1)).toEqual({ funnel: "v1_tutorial", pids: ["pid-alpha-0001", "pid-bravo-0002"] }));
	});
});

describe("Players list: a funnel's step names", () => {
	const stepsIn = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => li.textContent);

	it("hovering a progress cell lists the steps, the reached ones checked and the furthest one highlighted with when", async () => {
		mount("?funnels=v1_tutorial");
		await waitFor(() => expect(within(rowOf("pid-alpha-0001")).getByRole("progressbar", { name: /v1_tutorial/ }).textContent).toBe("75%"));
		const cell = within(rowOf("pid-alpha-0001")).getByRole("progressbar", { name: /v1_tutorial/ }).closest("button") as HTMLElement;
		fireEvent.mouseEnter(cell);
		const dialog = await screen.findByRole("dialog");
		const list = within(dialog).getByRole("list", { name: "Steps of v1_tutorial" });
		expect(stepsIn(list)).toEqual(["1.joined", "2.moved", "3.first_fight3 h ago", "4.done"]);
		expect(within(list).getAllByLabelText("reached")).toHaveLength(3);
		expect(within(list).getAllByLabelText("not reached")).toHaveLength(1);
		const current = within(list).getAllByRole("listitem")[2];
		expect(current.getAttribute("aria-current")).toBe("step");
		fireEvent.mouseLeave(cell);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// The row still opens the player only from outside the cell: a tap on the cell opens the steps, not the player.
		fireEvent.click(cell);
		expect(await screen.findByRole("dialog")).toBeTruthy();
		expect(search).not.toContain("pid=");
	});

	it("focus opens it too; a player who never started it is told so; a funnel without known steps says that", async () => {
		mount("?funnels=v1_tutorial,v3_tutorial");
		const cell = (await within(await screen.findByRole("table", { name: "Players" })).findByText("not started")).closest("button") as HTMLElement;
		fireEvent.focus(cell);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("v3_tutorial")).toBeTruthy();
		expect(within(dialog).getByText("Not started in this range.")).toBeTruthy();
		expect(within(dialog).getByText(/No step of it logged/)).toBeTruthy();
		fireEvent.blur(cell);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("a player who never started a funnel with known steps gets them all unchecked", async () => {
		vi.mocked(api.query).mockImplementation((async (name: string) => {
			if (name === "players") return players;
			if (name === "funnel-progress") return { ...progress, progress: progress.progress.filter((p) => p.pid !== "pid-bravo-0002") };
			return { funnel: null, funnels: [] };
		}) as typeof api.query);
		mount("?funnels=v1_tutorial");
		await waitFor(() => expect(within(rowOf("pid-bravo-0002")).getByText("not started")).toBeTruthy());
		fireEvent.mouseEnter(within(rowOf("pid-bravo-0002")).getByText("not started").closest("button") as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getAllByLabelText("not reached")).toHaveLength(4);
		expect(within(dialog).queryByLabelText("reached")).toBeNull();
	});

	it("the column header lists the step names", async () => {
		mount("?funnels=v1_tutorial");
		const t = await screen.findByRole("table", { name: "Players" });
		const tip = await within(t).findByRole("button", { name: "Steps of v1_tutorial" });
		expect(within(t).getByRole("columnheader", { name: /v1_tutorial/ }).getAttribute("title")).toContain("Steps: 1. joined, 2. moved, 3. first_fight, 4. done");
		fireEvent.mouseEnter(tip);
		const list = within(await screen.findByRole("dialog")).getByRole("list", { name: "Steps of v1_tutorial" });
		expect(stepsIn(list)).toEqual(["1.joined", "2.moved", "3.first_fight", "4.done"]);
		expect(within(list).queryByLabelText("reached")).toBeNull();
	});
});
