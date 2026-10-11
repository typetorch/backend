// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { reloadCollapsed } from "@/lib/nav-state";
import { ThemeProvider } from "@/lib/theme";
import type { PlaceCardInfo } from "@/lib/types";

const PLACE: PlaceCardInfo = {
	configured: true,
	roblox: "ok",
	placeId: 7770001,
	universeId: 5550001,
	name: "Test Torch Game",
	playing: 1234,
	icon: "https://tr.rbxcdn.com/180DAY-icon/512/512/Image/Png/noFilter",
	url: "https://www.roblox.com/games/7770001",
};

let go: ((to: string) => void) | undefined;
function Page() {
	go = useNavigate();
	return <div>the page</div>;
}

beforeEach(() => {
	localStorage.clear();
	reloadCollapsed();
	document.title = "TypeTorch Backend";
	vi.spyOn(api, "health").mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof api.health>>);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(path = "/errors") {
	return render(
		<ThemeProvider>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AuthProvider value={{ ok: true, role: "admin", via: "cookie" }}>
					<MemoryRouter initialEntries={[path]}>
						<Routes>
							<Route element={<AppShell />}>
								<Route path="*" element={<Page />} />
							</Route>
						</Routes>
					</MemoryRouter>
				</AuthProvider>
			</QueryClientProvider>
		</ThemeProvider>,
	);
}

const card = () => screen.findByRole("link", { name: "Test Torch Game on Roblox (opens in a new tab)" });

describe("place card", () => {
	it("shows the icon, name and live players above Overview, linking to the game in a new tab", async () => {
		vi.spyOn(api, "place").mockResolvedValue(PLACE);
		mount();
		const link = await card();
		expect(link.getAttribute("href")).toBe("https://www.roblox.com/games/7770001");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(within(link).getByText("Test Torch Game")).toBeTruthy();
		expect(within(link).getByTestId("place-live").textContent).toContain("1,234 live");
		expect(link.querySelector("img")?.getAttribute("src")).toBe(PLACE.configured ? PLACE.icon : "");
		const overview = screen.getByRole("link", { name: "Overview" });
		expect(link.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// The phone header's icon-only version links to the same page.
		const icon = screen.getByRole("link", { name: "Test Torch Game, 1,234 live on Roblox (opens in a new tab)" });
		expect(icon.getAttribute("href")).toBe("https://www.roblox.com/games/7770001");
	});

	it("is hidden while no place is configured, and the tab title stays as it was", async () => {
		const place = vi.spyOn(api, "place").mockResolvedValue({ configured: false });
		mount();
		await waitFor(() => expect(place).toHaveBeenCalled());
		expect(screen.queryByRole("link", { name: /on Roblox/ })).toBeNull();
		expect(document.title).toBe("TypeTorch Backend");
	});

	it("Roblox unreachable: a placeholder icon, no count, the title unchanged", async () => {
		vi.spyOn(api, "place").mockResolvedValue({ ...(PLACE as Extract<PlaceCardInfo, { configured: true }>), roblox: "unavailable", name: null, playing: null, icon: null });
		mount();
		const links = await screen.findAllByRole("link", { name: "Your game on Roblox (opens in a new tab)" });
		expect(links).toHaveLength(2); // the card and the phone header's icon
		const link = links[0];
		for (const l of links) expect(l.querySelector("img")).toBeNull();
		expect(within(link).queryByTestId("place-live")).toBeNull();
		expect(document.title).toBe("TypeTorch Backend");
	});

	it("an icon off Roblox's CDN or a link off roblox.com is not used", async () => {
		vi.spyOn(api, "place").mockResolvedValue({ ...(PLACE as Extract<PlaceCardInfo, { configured: true }>), icon: "https://evil.example/x.png", url: "https://evil.example/games/1" });
		mount();
		await screen.findAllByText("Test Torch Game");
		expect(screen.queryByRole("link", { name: /on Roblox/ })).toBeNull();
		expect(document.querySelector('img[src^="https://evil"]')).toBeNull();
	});

	it("names the tab '<page> | <place>' and follows route changes", async () => {
		vi.spyOn(api, "place").mockResolvedValue(PLACE);
		mount("/errors");
		await waitFor(() => expect(document.title).toBe("Errors | Test Torch Game"));
		go?.("/fleet");
		await waitFor(() => expect(document.title).toBe("Fleet | Test Torch Game"));
	});
});
