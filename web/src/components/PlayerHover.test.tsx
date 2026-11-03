// @vitest-environment jsdom
/** The player card on player links: opens after a short hover, asks for the profile only then, and shows avatar, names, UserId and pid. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserIdLink } from "@/components/Identity";
import { PlayerPageLink } from "@/components/PlayerLink";
import { api } from "@/lib/api";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function mount(node: React.ReactNode) {
	const profile = vi.spyOn(api, "playerProfile").mockResolvedValue({
		pid: "pid-1",
		linked: true,
		uid: 42,
		roblox: "ok",
		name: "vipfan",
		displayName: "VIP Fan",
		avatar: "https://tr.rbxcdn.com/head.png",
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>{node}</MemoryRouter>
		</QueryClientProvider>,
	);
	return profile;
}

const hover = (el: HTMLElement) => fireEvent.pointerEnter(el.parentElement as HTMLElement, { pointerType: "mouse" });

describe("PlayerHover", () => {
	it("a player link shows who it is after a short hover, and only asks then", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const profile = mount(<PlayerPageLink row={{ pid: "pid-1", name: "vipfan" }} />);
		const link = screen.getByRole("link", { name: "@vipfan" });
		expect(profile).not.toHaveBeenCalled();
		hover(link);
		expect(screen.queryByTestId("player-card")).toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(400));
		const card = await screen.findByTestId("player-card");
		expect(await within(card).findByText("VIP Fan")).toBeTruthy();
		expect(within(card).getByText("@vipfan")).toBeTruthy();
		expect(within(card).getByText("UserId 42")).toBeTruthy();
		expect(within(card).getByText("pid-1")).toBeTruthy();
		expect(card.querySelector("img")?.getAttribute("src")).toBe("https://tr.rbxcdn.com/head.png");
		expect(profile).toHaveBeenCalledTimes(1);
		// Leaving closes it.
		fireEvent.pointerLeave(link.parentElement as HTMLElement, { pointerType: "mouse" });
		await act(() => vi.advanceTimersByTimeAsync(200));
		expect(screen.queryByTestId("player-card")).toBeNull();
	});

	it("keyboard focus opens it; a UserId link with its pid has one too", async () => {
		mount(<UserIdLink uid={42} pid="pid-1" />);
		const link = screen.getByRole("link", { name: /UserId 42/ });
		fireEvent.focus(link);
		const card = await screen.findByTestId("player-card");
		expect(await within(card).findByText("@vipfan")).toBeTruthy();
	});
});
