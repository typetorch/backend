// @vitest-environment jsdom
/** The Monetization page: the revenue numbers, products named through the Roblox lookup, first purchase by session, and the empty state. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { MonetizationResult } from "@/lib/types";
import Monetization from "./Monetization";

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

const result: MonetizationResult = {
	from: "2026-10-03T00:00:00.000Z",
	to: "2026-10-05T00:00:00.000Z",
	totals: {
		robux: 12_797,
		purchases: 4,
		payers: 3,
		activePlayers: 4,
		playerDays: 6,
		payerConversion: 0.75,
		arppu: 265.67,
		arpdau: 132.8333,
		arpu: 199.25,
		repeatPayers: 1,
		repeatRate: 0.3333,
		purchasesPerPayer: 1.33,
	},
	days: [
		{ date: "2026-10-03", robux: 99, purchases: 1, payers: 1, activePlayers: 3, arpdau: 33 },
		{ date: "2026-10-04", robux: 698, purchases: 3, payers: 3, activePlayers: 3, arpdau: 232.6667 },
	],
	products: [
		{ kind: "gamepass", product: "77", robux: 400, purchases: 1, payers: 1, share: 0.5019 },
		{ kind: "product", product: "1234", robux: 198, purchases: 2, payers: 2, share: 0.2484 },
		{ kind: "product", product: null, robux: 10, purchases: 1, payers: 1, share: 0.0125 },
	],
	firstPurchase: {
		newPlayers: 3,
		payers: 2,
		conversion: 0.6667,
		medianMinutes: 847.5,
		avgMinutes: 847.5,
		bySession: [
			{ session: "1", payers: 1, share: 0.5 },
			{ session: "2", payers: 0, share: 0 },
			{ session: "3", payers: 1, share: 0.5 },
			{ session: "4-5", payers: 0, share: 0 },
			{ session: "6-10", payers: 0, share: 0 },
			{ session: "11+", payers: 0, share: 0 },
		],
	},
};

function mount(answer: MonetizationResult = result) {
	vi.spyOn(api, "query").mockImplementation((async (name: string) => {
		if (name !== "monetization") throw new Error(`unexpected query ${name}`);
		return answer;
	}) as typeof api.query);
	const products = vi.spyOn(api, "robloxProducts").mockResolvedValue([
		{ type: "gamepass", id: 77, status: "ok", name: "VIP", price: 400, forSale: true, icon: null },
		{ type: "product", id: 1234, status: "ok", name: "100 Coins", price: 99, forSale: true, icon: null },
	]);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/monetization"]}>
				<Monetization />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return products;
}

describe("Monetization page", () => {
	it("shows revenue, conversion, ARPPU, ARPDAU, repeat rate and time to first purchase", async () => {
		mount();
		expect(await screen.findByText("12,797 R$")).toBeTruthy();
		expect(screen.getByText("75%")).toBeTruthy();
		expect(screen.getByText("265.7 R$")).toBeTruthy();
		expect(screen.getByText("132.83 R$")).toBeTruthy();
		expect(screen.getByText("33.3%")).toBeTruthy();
		// 847.5 minutes, median.
		expect(screen.getByText("14.1 h")).toBeTruthy();
	});

	it("names the products through the Roblox lookup, in one request", async () => {
		const products = mount();
		const table = await screen.findByRole("table", { name: "Revenue by product" });
		await waitFor(() => expect(within(table).getByText("VIP")).toBeTruthy());
		expect(within(table).getByText("100 Coins")).toBeTruthy();
		expect(within(table).getByText("Game pass")).toBeTruthy();
		expect(products).toHaveBeenCalledTimes(1);
		expect(products.mock.calls[0][0]).toEqual({ gamepass: [77], product: [1234] });
	});

	it("first purchase by session number", async () => {
		mount();
		expect(await screen.findByText(/2 of 3 \(66.7%\)/)).toBeTruthy();
		expect(screen.getByText("Session 3")).toBeTruthy();
		expect(screen.getByText("Session 11+")).toBeTruthy();
	});

	it("without purchases: says what the game should send", async () => {
		mount({ ...result, totals: { ...result.totals, robux: 0, purchases: 0, payers: 0 }, products: [] });
		expect(await screen.findByText("No purchases in this range.")).toBeTruthy();
		expect(screen.getByText(/analytics\.purchase\(player, \{ product, robux, where\?, kind\? \}\)/)).toBeTruthy();
	});
});
