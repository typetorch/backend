// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { commandRegistry, readRecent } from "@/lib/commands";
import { reloadCollapsed } from "@/lib/nav-state";
import { ThemeProvider } from "@/lib/theme";
import type { AuthInfo } from "@/lib/types";

beforeEach(() => {
	localStorage.clear();
	reloadCollapsed();
	vi.spyOn(api, "health").mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof api.health>>);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function Where() {
	const { pathname, search } = useLocation();
	return <div data-testid="where">{`${pathname}${search}`}</div>;
}

const owner: AuthInfo = { ok: true, role: "admin", via: "cookie", user: { kind: "roblox", userId: 1001, name: "OwnerName" } };

function mount(path: string, auth: AuthInfo = owner) {
	return render(
		<ThemeProvider>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AuthProvider value={auth}>
					<MemoryRouter initialEntries={[path]}>
						<Routes>
							<Route element={<AppShell />}>
								<Route path="*" element={<Where />} />
							</Route>
						</Routes>
					</MemoryRouter>
				</AuthProvider>
			</QueryClientProvider>
		</ThemeProvider>,
	);
}

const where = () => screen.getByTestId("where").textContent;
const ctrlK = (target: Element | Window = window) => fireEvent.keyDown(target, { key: "k", ctrlKey: true });
const NAME = { name: "Search pages and commands" };
const queryPalette = () => screen.queryByRole("combobox", NAME);

describe("command palette", () => {
	it("opens with Ctrl+K, finds a page by a fuzzy query and goes there keeping the filters", async () => {
		mount("/fleet?range=7d&pid=abc");
		expect(queryPalette()).toBeNull();
		ctrlK();
		const input = await screen.findByRole("combobox", NAME);
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: "retnt" } });
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toBe("Retention");
		expect(options[0].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(where()).toBe("/retention?range=7d"));
		expect(queryPalette()).toBeNull();
		expect(readRecent()).toEqual(["nav:/retention"]);
	});

	it("opens with Cmd+K from inside an input, and Escape closes it", async () => {
		mount("/");
		const find = screen.getByLabelText("Find player (pid or UserId)");
		find.focus();
		fireEvent.keyDown(find, { key: "K", metaKey: true });
		const input = await screen.findByRole("combobox", NAME);
		fireEvent.keyDown(input, { key: "Escape" });
		await waitFor(() => expect(queryPalette()).toBeNull());
	});

	it("the header button opens it too; arrows move, Enter runs the picked command", async () => {
		mount("/players");
		fireEvent.click(screen.getByRole("button", { name: "Search commands" }));
		const input = await screen.findByRole("combobox", NAME);
		fireEvent.change(input, { target: { value: "last days" } });
		const titles = screen.getAllByRole("option").map((o) => o.textContent);
		expect(titles.slice(0, 3)).toEqual(expect.arrayContaining(["Last 7 days", "Last 30 days", "Last 90 days"]));
		fireEvent.keyDown(input, { key: "ArrowDown" });
		const second = screen.getAllByRole("option")[1];
		expect(second.getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(input, { key: "Enter" });
		const range = { "Last 7 days": "7d", "Last 30 days": "", "Last 90 days": "90d" }[second.textContent as string];
		await waitFor(() => expect(where()).toBe(range ? `/players?range=${range}` : "/players"));
	});

	it("a UserId offers Open player, which goes to the Players page's find", async () => {
		mount("/economy?range=1d");
		ctrlK();
		const input = await screen.findByRole("combobox", NAME);
		fireEvent.change(input, { target: { value: "987654321" } });
		const first = screen.getAllByRole("option")[0];
		expect(first.textContent).toBe("Open player 987654321");
		fireEvent.click(first);
		await waitFor(() => expect(where()).toBe("/players?range=1d&find=987654321"));
	});

	it("an empty query lists recent commands first; owner-only pages are hidden from the read-only role", async () => {
		localStorage.setItem("tt-explorer-recent-commands", JSON.stringify(["nav:/errors"]));
		mount("/", { ok: true, role: "web", via: "cookie", user: { kind: "roblox", userId: 2, name: "Viewer" } });
		ctrlK();
		await screen.findByRole("combobox", NAME);
		const recent = screen.getByRole("group", { name: "Recent" });
		expect(within(recent).getByRole("option").textContent).toBe("Errors");
		const pages = within(screen.getByRole("group", { name: "Pages" }))
			.getAllByRole("option")
			.map((o) => o.textContent);
		expect(pages).toContain("Players");
		expect(pages).not.toContain("Settings");
		expect(pages).not.toContain("Audit log");
	});

	it("lists the commands a page registers while it is there", async () => {
		mount("/");
		const off = commandRegistry.register([{ id: "test:page", title: "Page-only thing", group: "This page", run: vi.fn() }]);
		ctrlK();
		await screen.findByRole("combobox", NAME);
		expect(within(screen.getByRole("group", { name: "This page" })).getByRole("option").textContent).toBe("Page-only thing");
		act(() => off());
		expect(screen.queryByRole("group", { name: "This page" })).toBeNull();
	});
});
