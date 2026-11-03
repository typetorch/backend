// @vitest-environment jsdom
/** The Monetization page: the revenue numbers, products named through the Roblox lookup, who bought what (top buyers, a product's buyers), first purchase by session, and the empty state. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { MonetizationPlayer, MonetizationPurchase, MonetizationResult } from "@/lib/types";
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
	creatorShare: 0.7,
	totals: {
		robux: 12_797,
		revenue: 8957.9,
		purchases: 4,
		payers: 3,
		activePlayers: 4,
		playerDays: 6,
		payerConversion: 0.75,
		arppu: 2985.97,
		arpdau: 1492.9833,
		arpu: 2239.48,
		repeatPayers: 1,
		repeatRate: 0.3333,
		purchasesPerPayer: 1.33,
	},
	days: [
		{ date: "2026-10-03", robux: 99, revenue: 69.3, purchases: 1, payers: 1, activePlayers: 3, arpdau: 23.1 },
		{ date: "2026-10-04", robux: 698, revenue: 488.6, purchases: 3, payers: 3, activePlayers: 3, arpdau: 162.8667 },
	],
	products: [
		{ kind: "gamepass", product: "77", robux: 400, revenue: 280, purchases: 1, payers: 1, share: 0.5019 },
		{ kind: "product", product: "1234", robux: 198, revenue: 138.6, purchases: 2, payers: 2, share: 0.2484 },
		{ kind: "product", product: null, robux: 10, revenue: 7, purchases: 1, payers: 1, share: 0.0125 },
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

const buyer = (pid: string, robux: number, extra: Partial<MonetizationPlayer> = {}): MonetizationPlayer => ({
	pid,
	purchases: 1,
	robux,
	revenue: robux * 0.7,
	products: 1,
	firstAt: "2026-10-03T10:00:00.000Z",
	lastAt: "2026-10-04T10:00:00.000Z",
	...extra,
});

function mount(answer: MonetizationResult = result, url = "/monetization") {
	const query = vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: { kind?: string; product?: string }) => {
		if (name === "monetization") return answer;
		if (name === "monetization-players") {
			const players: MonetizationPlayer[] = options.product
				? [buyer("pid-vip", 400, { uid: 42, name: "vipfan", displayName: "VIP Fan" })]
				: [buyer("pid-whale", 598, { name: "whale", products: 2, purchases: 3 }), buyer("pid-small", 99)];
			return { kind: options.kind ?? null, product: options.product ?? null, creatorShare: 0.7, total: players.length, more: 0, players };
		}
		if (name === "monetization-purchases") {
			const purchases: MonetizationPurchase[] = [
				{ pid: "pid-whale", sid: "s1", at: "2026-10-04T12:00:00.000Z", kind: "gamepass", product: "77", robux: 400, revenue: 280, where: "shop", name: "whale" },
				{ pid: "pid-small", sid: "s2", at: "2026-10-03T10:00:00.000Z", kind: "product", product: "1234", robux: 99, revenue: 69.3, where: null },
			];
			return { creatorShare: 0.7, total: 3, more: 1, purchases };
		}
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const products = vi.spyOn(api, "robloxProducts").mockResolvedValue([
		{ type: "gamepass", id: 77, status: "ok", name: "VIP", price: 400, forSale: true, icon: null },
		{ type: "product", id: 1234, status: "ok", name: "100 Coins", price: 99, forSale: true, icon: null },
	]);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>
				<Monetization />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return Object.assign(products, { query });
}

describe("Monetization page", () => {
	it("shows revenue after Roblox's cut, conversion, ARPPU, ARPDAU, repeat rate and time to first purchase", async () => {
		mount();
		expect(await screen.findByText("8,958 R$")).toBeTruthy();
		expect(screen.getByText("12,797 R$ paid, Roblox keeps 30%")).toBeTruthy();
		expect(screen.getByText("75%")).toBeTruthy();
		expect(screen.getByText("2,986 R$")).toBeTruthy();
		expect(screen.getByText("1,492.98 R$")).toBeTruthy();
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

	it("top buyers: who spent the most, linking to their player page", async () => {
		mount();
		const table = await screen.findByRole("table", { name: "Top buyers" });
		const link = await within(table).findByRole("link", { name: "@whale" });
		expect(link.getAttribute("href")).toContain("pid=pid-whale");
		expect(within(table).getByText("pid-small")).toBeTruthy();
	});

	it("latest purchases: who bought what and where, newest first", async () => {
		mount();
		const table = await screen.findByRole("table", { name: "Latest purchases" });
		const rows = within(table).getAllByRole("row").slice(1);
		expect(within(rows[0]).getByRole("link", { name: "@whale" }).getAttribute("href")).toContain("pid=pid-whale");
		await waitFor(() => expect(within(rows[0]).getByText("VIP")).toBeTruthy());
		expect(within(rows[0]).getByText("shop")).toBeTruthy();
		expect(within(rows[0]).getByText("400")).toBeTruthy();
		expect(within(rows[1]).getByText("100 Coins")).toBeTruthy();
		expect(screen.getByText("The latest 2, of 3.")).toBeTruthy();
	});

	it("the buyers sheet's close button closes it", async () => {
		mount(result, "/monetization?buyers=gamepass:77");
		await screen.findByRole("table", { name: "Buyers of this product" });
		fireEvent.click(screen.getByRole("button", { name: /close/i }));
		await waitFor(() => expect(screen.queryByRole("table", { name: "Buyers of this product" })).toBeNull());
	});

	it("a product row opens its buyers", async () => {
		const { query } = mount();
		const table = await screen.findByRole("table", { name: "Revenue by product" });
		const vip = await within(table).findByText("VIP");
		fireEvent.click(vip.closest("tr") as HTMLElement);
		const sheet = await screen.findByRole("table", { name: "Buyers of this product" });
		expect(await within(sheet).findByRole("link", { name: "VIP Fan (@vipfan)" })).toBeTruthy();
		expect(query.mock.calls.some(([name, , options]) => name === "monetization-players" && (options as { product?: string }).product === "77" && (options as { kind?: string }).kind === "gamepass")).toBe(true);
	});

	it("a day (a chart bar, buyersDay in the URL) opens that day's buyers", async () => {
		const { query } = mount(result, "/monetization?buyersDay=2026-10-04");
		const sheet = await screen.findByRole("table", { name: "Buyers on 2026-10-04" });
		expect(await within(sheet).findByRole("link", { name: "@whale" })).toBeTruthy();
		const call = query.mock.calls.find(([name, filters]) => name === "monetization-players" && (filters as { from?: string }).from === "2026-10-04");
		expect(call?.[1]).toMatchObject({ from: "2026-10-04", to: "2026-10-04" });
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
