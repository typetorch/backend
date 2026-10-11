// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { EventTable, type ListedEvent } from "./EventTable";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const event = (over: Partial<ListedEvent>): ListedEvent => ({ time: "2026-10-09T12:00:00Z", t: Date.parse("2026-10-09T12:00:00Z"), kind: "custom", name: "x", state: null, src: "server", props: {}, ...over });
const events: ListedEvent[] = [
	event({ name: "late", time: "2026-10-09T12:00:30Z", t: Date.parse("2026-10-09T12:00:30Z"), props: { score: 10 } }),
	event({ name: "early", time: "2026-10-09T11:00:00Z", t: Date.parse("2026-10-09T11:00:00Z"), kind: "funnel", src: "client", state: "zone:Lobby" }),
	event({ name: "middle", time: "2026-10-09T11:30:00Z", t: Date.parse("2026-10-09T11:30:00Z") }),
];

const names = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[2]?.textContent);

describe("EventTable", () => {
	it("a purchase row's product id opens what it is (game pass name, price); other rows' props stay plain", async () => {
		const spy = vi.spyOn(api, "robloxProducts").mockResolvedValue([{ type: "gamepass", id: 555, status: "ok", name: "Double Jump", price: 75, forSale: true, icon: null }]);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter>
					<EventTable id="t" events={[event({ kind: "purchase", name: "gamepass", props: { product: 555, robux: 75 } }), event({ kind: "custom", name: "x", props: { product: 9 } })]} />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const button = await screen.findByRole("button", { name: "Game pass 555: Double Jump" });
		expect(button.textContent).toContain("555");
		act(() => button.focus());
		expect((await screen.findByTestId("product-card")).textContent).toContain("75 Robux");
		expect(spy).toHaveBeenCalledWith({ gamepass: [555], product: [] });
		expect(screen.queryByRole("button", { name: /9/ })).toBeNull();
		vi.restoreAllMocks();
	});

	it("shows time, kind, name, side, state and compact props, with '–' for empty props", () => {
		render(
			<MemoryRouter>
				<EventTable id="t" events={events} dateToo />
			</MemoryRouter>,
		);
		expect(screen.getByText("2026-10-09 12:00:30")).toBeTruthy();
		expect(screen.getByText('{"score":10}')).toBeTruthy();
		expect(screen.getByText("zone:Lobby")).toBeTruthy();
		expect(names()).toEqual(["late", "early", "middle"]);
	});

	it("shows only the time of day without dateToo, and sorts by the timestamp", () => {
		render(
			<MemoryRouter>
				<EventTable id="t" events={events} />
			</MemoryRouter>,
		);
		expect(screen.getByText("12:00:30")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /^Time/ })); // newest first
		expect(names()).toEqual(["late", "middle", "early"]);
		fireEvent.click(screen.getByRole("button", { name: /^Time/ })); // oldest first
		expect(names()).toEqual(["early", "middle", "late"]);
	});

	it("takes extra columns after the standard ones", () => {
		render(
			<MemoryRouter>
				<EventTable id="t" events={events} extra={[{ id: "len", header: "Name length", accessor: (e) => e.name.length }]} />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^Name length/ })); // longest first
		expect(names()).toEqual(["middle", "early", "late"]);
	});
});
