// @vitest-environment jsdom
/** The Economy page: totals, the sources and sinks tables, the currency from the URL, and the empty state saying what to send. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { EconomyResult } from "@/lib/types";
import Economy from "./Economy";

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
	localStorage.clear();
});

const flow = (reason: string, amount: number, share: number) => ({ reason, amount, rows: 2, players: 2, share });
const day = (date: string, earned: number, spent: number, balance: number) => ({ date, earned, spent, net: earned - spent, balance, players: 2, activePlayers: 3, earnedPerActive: earned / 3 });

const coins: EconomyResult = {
	from: "2026-10-03T00:00:00.000Z",
	to: "2026-10-05T00:00:00.000Z",
	currency: "coins",
	currencies: [
		{ currency: "coins", rows: 7, earned: 260, spent: 240, players: 2 },
		{ currency: "gems", rows: 2, earned: 5, spent: 0, players: 1 },
	],
	totals: {
		earned: 1260,
		spent: 240,
		net: 1020,
		rows: 7,
		players: 2,
		earners: 2,
		spenders: 2,
		activePlayers: 3,
		earnedPerActive: 86.67,
		spentPerActive: 80,
		avgNetPerPlayer: 5,
		medianNetPerPlayer: 5,
		sinkRatio: 0.1905,
	},
	days: [day("2026-10-03", 250, 30, 220), day("2026-10-04", 10, 210, 20)],
	sources: [flow("round_reward", 200, 0.7692), flow("", 50, 0.1923)],
	sinks: [flow("shop", 230, 0.9583)],
};

function mount(url = "/economy", result: EconomyResult = coins) {
	const calls: Record<string, unknown>[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
		if (name !== "economy") throw new Error(`unexpected query ${name}`);
		calls.push(options);
		return result;
	}) as typeof api.query);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>
				<Economy />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return calls;
}

describe("Economy page", () => {
	it("shows the totals and the busiest currency in the picker", async () => {
		const calls = mount();
		expect(await screen.findByText("1,260")).toBeTruthy();
		expect(screen.getByText("Spent per earned")).toBeTruthy();
		expect(screen.getByText("19.1%")).toBeTruthy();
		expect(within(screen.getByRole("combobox", { name: "Currency" })).getByText("coins")).toBeTruthy();
		expect(calls[0]).toEqual({});
	});

	it("lists the top sources and sinks with their shares; a row without a reason says so", async () => {
		mount();
		const sources = await screen.findByRole("table", { name: "Top sources" });
		expect(within(sources).getByText("round_reward")).toBeTruthy();
		expect(within(sources).getByText("76.9%")).toBeTruthy();
		expect(within(sources).getByText("(no reason)")).toBeTruthy();
		const sinks = screen.getByRole("table", { name: "Top sinks" });
		expect(within(sinks).getByText("shop")).toBeTruthy();
		expect(within(sinks).getByText("230")).toBeTruthy();
	});

	it("asks for the currency in the URL", async () => {
		const calls = mount("/economy?currency=gems", { ...coins, currency: "gems" });
		await screen.findByText("1,260");
		expect(calls[0]).toEqual({ currency: "gems" });
		expect(within(screen.getByRole("combobox", { name: "Currency" })).getByText("gems")).toBeTruthy();
	});

	it("without currency events: says what the game should send, and no picker", async () => {
		mount("/economy", { ...coins, currency: null, currencies: [], days: [], sources: [], sinks: [] });
		expect(await screen.findByText("No currency events in this range.")).toBeTruthy();
		expect(screen.getByText("analytics.currency(player, name, delta, reason)")).toBeTruthy();
		expect(screen.queryByRole("combobox", { name: "Currency" })).toBeNull();
	});
});
