// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductId } from "@/components/ProductId";
import { api } from "@/lib/api";
import { createProductLoader, parseProductId, productTypeOf } from "@/lib/products";
import type { RobloxProductInfo } from "@/lib/types";

const PASS: RobloxProductInfo = { type: "gamepass", id: 9100001, status: "ok", name: "VIP Pass", price: 199, forSale: true, icon: "https://tr.rbxcdn.com/180DAY-pass/150/150/Image/Png/noFilter" };
const PRODUCT: RobloxProductInfo = { type: "product", id: 1118524989, status: "ok", name: "100 Coins", price: 25, forSale: true, icon: "https://evil.example/icon.png" };

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	spy = vi.spyOn(api, "robloxProducts").mockImplementation(async (ids) => [PASS, PRODUCT].filter((p) => (ids[p.type] ?? []).includes(p.id)));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(ui: React.ReactNode) {
	return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

describe("ProductId", () => {
	it("keeps the raw id visible, shows the name beside it, and asks every id on screen in one request", async () => {
		mount(
			<div>
				<ProductId id={9100001} kind="gamepass" showName />
				<ProductId id="1118524989" kind="product" showName />
				<ProductId id={9100001} kind="gamepass" />
			</div>,
		);
		expect(screen.getAllByText("9100001")).toHaveLength(2);
		expect(screen.getByText("1118524989")).toBeTruthy();
		expect(await screen.findByText("VIP Pass")).toBeTruthy();
		expect(await screen.findByText("100 Coins")).toBeTruthy();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toEqual({ gamepass: [9100001], product: [1118524989] });
	});

	it("keyboard focus opens the card with icon, name, type and price; Escape and blur close it", async () => {
		mount(<ProductId id={9100001} kind="gamepass" />);
		const button = await screen.findByRole("button", { name: "Game pass 9100001: VIP Pass" });
		act(() => button.focus());
		const card = await screen.findByTestId("product-card");
		expect(card.textContent).toContain("VIP Pass");
		expect(card.textContent).toContain("Game pass");
		expect(card.textContent).toContain("199 Robux");
		expect(card.querySelector("img")?.getAttribute("src")).toBe(PASS.icon);
		expect(document.activeElement).toBe(button);
		fireEvent.keyDown(button, { key: "Escape" });
		await waitFor(() => expect(screen.queryByTestId("product-card")).toBeNull());
		act(() => button.blur());
		act(() => button.focus());
		await screen.findByTestId("product-card");
		act(() => button.blur());
		await waitFor(() => expect(screen.queryByTestId("product-card")).toBeNull());
	});

	it("a tap toggles the card; an icon off Roblox's CDN is not shown", async () => {
		mount(<ProductId id={1118524989} kind="product" />);
		const button = await screen.findByRole("button", { name: "Developer product 1118524989: 100 Coins" });
		fireEvent.pointerDown(button, { pointerType: "touch" });
		fireEvent.click(button);
		const card = await screen.findByTestId("product-card");
		expect(card.textContent).toContain("Developer product");
		expect(card.textContent).toContain("25 Robux");
		expect(card.querySelector("img")).toBeNull();
		fireEvent.pointerDown(button, { pointerType: "touch" });
		fireEvent.click(button);
		await waitFor(() => expect(screen.queryByTestId("product-card")).toBeNull());
	});

	it("a failed lookup or an unknown kind degrades to just the id", async () => {
		spy.mockRejectedValue(new Error("down"));
		mount(
			<div>
				<ProductId id={4242} kind="product" showName />
				<ProductId id={77} kind="subscription" />
				<ProductId id={null} kind="product" />
			</div>,
		);
		const button = await screen.findByRole("button", { name: "Developer product 4242" });
		act(() => button.focus());
		await waitFor(() => expect(screen.getByTestId("product-card").textContent).toContain("Roblox didn't answer."));
		expect(screen.getByText("77").tagName).toBe("SPAN");
		expect(screen.queryByRole("button", { name: /77/ })).toBeNull();
		expect(screen.getByText("–")).toBeTruthy();
	});
});

describe("lib/products", () => {
	it("kinds and ids", () => {
		expect(productTypeOf("gamepass")).toBe("gamepass");
		expect(productTypeOf("Game_Pass")).toBe("gamepass");
		expect(productTypeOf("product")).toBe("product");
		expect(productTypeOf("subscription")).toBeUndefined();
		expect(parseProductId("123")).toBe(123);
		for (const bad of ["0", "-1", "1.5", "abc", 0, -3, 1.5, null, "99999999999999999999"]) expect(parseProductId(bad)).toBeUndefined();
	});

	it("the loader batches 50 ids a request", async () => {
		const asked: number[] = [];
		const load = createProductLoader(async (ids) => {
			asked.push(ids.gamepass.length + ids.product.length);
			return [];
		});
		const all = await Promise.all(Array.from({ length: 120 }, (_, i) => load(i % 2 ? "gamepass" : "product", i + 1)));
		expect(asked).toEqual([50, 50, 20]);
		expect(all.every((a) => a.status === "unavailable" && a.name === null)).toBe(true);
	});
});
