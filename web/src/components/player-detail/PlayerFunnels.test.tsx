// @vitest-environment jsdom
/** The player detail's Funnels row: a bar per funnel; hover, focus or tap lists the funnel's steps with the player's progress. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FunnelProgressResult } from "@/lib/types";
import { PlayerFunnels } from "./PlayerFunnels";

const PID = "pid-alpha-0001";
const progress: FunnelProgressResult = {
	funnels: [
		{
			name: "first_session",
			steps: [
				{ step: 1, label: "joined" },
				{ step: 2, label: "data_loaded" },
				{ step: 3, label: "spawned" },
			],
		},
	],
	progress: [
		{ pid: PID, funnel: "first_session", step: 2, label: "data_loaded", reached: 2, of: 3, share: 0.6667, reachedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
		{ pid: PID, funnel: "shop", step: 1, label: null, reached: 1, of: 2, share: 0.5 },
	],
};

let calls = 0;
beforeEach(() => {
	calls = 0;
	vi.spyOn(api, "query").mockImplementation((async (name: string) => {
		if (name !== "funnel-progress") throw new Error(`unexpected query ${name}`);
		calls += 1;
		return progress;
	}) as typeof api.query);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<PlayerFunnels pid={PID} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("PlayerFunnels", () => {
	it("hovering a funnel bar lists its steps, reached ones checked, the current one highlighted with when", async () => {
		mount();
		const bar = await screen.findByRole("progressbar", { name: /first_session/ });
		const trigger = bar.closest("button") as HTMLElement;
		fireEvent.mouseEnter(trigger);
		const list = within(await screen.findByRole("dialog")).getByRole("list", { name: "Steps of first_session" });
		expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1.joined", "2.data_loaded2 h ago", "3.spawned"]);
		expect(within(list).getAllByLabelText("reached")).toHaveLength(2);
		expect(within(list).getAllByLabelText("not reached")).toHaveLength(1);
		expect(within(list).getAllByRole("listitem")[1].getAttribute("aria-current")).toBe("step");
		fireEvent.mouseLeave(trigger);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// One query for the whole row, none per bar.
		expect(calls).toBe(1);
	});

	it("a tap or focus opens it too; a funnel without known steps says so", async () => {
		mount();
		const trigger = (await screen.findByRole("progressbar", { name: /shop/ })).closest("button") as HTMLElement;
		fireEvent.click(trigger);
		expect(within(await screen.findByRole("dialog")).getByText(/No step of it logged/)).toBeTruthy();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.focus((await screen.findByRole("progressbar", { name: /first_session/ })).closest("button") as HTMLElement);
		expect(await screen.findByRole("list", { name: "Steps of first_session" })).toBeTruthy();
	});
});
