// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarNav } from "@/components/SidebarNav";
import { AuthProvider } from "@/lib/auth";
import { NAV, NAV_GROUPS } from "@/lib/nav";
import { NAV_STATE_KEY, reloadCollapsed } from "@/lib/nav-state";
import type { AuthInfo } from "@/lib/types";

const admin: AuthInfo = { ok: true, role: "admin", via: "cookie", user: { kind: "token" } };

beforeEach(() => {
	localStorage.clear();
	reloadCollapsed();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(path = "/", props: { search?: string; onNavigate?: () => void; auth?: AuthInfo | null } = {}) {
	const { auth = admin, ...rest } = props;
	const nav = (
		<MemoryRouter initialEntries={[path]}>
			<SidebarNav {...rest} />
		</MemoryRouter>
	);
	return render(auth ? <AuthProvider value={auth}>{nav}</AuthProvider> : nav);
}

const stored = () => JSON.parse(localStorage.getItem(NAV_STATE_KEY) ?? "{}") as Record<string, boolean>;
const header = (name: string) => screen.getByRole("button", { name });

describe("sidebar", () => {
	it("lists every page under its group, with the small headers", () => {
		mount("/");
		for (const item of NAV) expect(screen.getByRole("link", { name: item.label }).getAttribute("href")).toMatch(new RegExp(`^${item.path}`));
		for (const group of NAV_GROUPS) {
			if (group.label) expect(header(group.label).getAttribute("aria-expanded")).toBe("true");
		}
		// The top group has no header and so nothing to close.
		expect(screen.getAllByRole("button")).toHaveLength(NAV_GROUPS.filter((g) => g.label).length);
	});

	it("marks the open page, and keeps a detail page's parent marked", () => {
		mount("/players");
		expect(screen.getByRole("link", { name: "Players" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page")).toHaveLength(1);
		cleanup();
		mount("/servers/job-7");
		expect(screen.getByRole("link", { name: "Fleet" }).getAttribute("aria-current")).toBe("page");
		cleanup();
		mount("/");
		expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("link", { name: "Players" }).getAttribute("aria-current")).toBeNull();
	});

	it("keeps the filter parameters on the links", () => {
		mount("/", { search: "?range=7d&branch=main" });
		expect(screen.getByRole("link", { name: "Errors" }).getAttribute("href")).toBe("/errors?range=7d&branch=main");
	});

	it("closes and opens a group, and remembers it", () => {
		mount("/");
		fireEvent.click(header("Players & gameplay"));
		expect(header("Players & gameplay").getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("link", { name: "Funnels" })).toBeNull();
		// The other groups are untouched.
		expect(screen.getByRole("link", { name: "Fleet" })).toBeTruthy();
		expect(stored()).toEqual({ players: true });
		// A fresh page view starts closed.
		cleanup();
		reloadCollapsed();
		mount("/");
		expect(screen.queryByRole("link", { name: "Funnels" })).toBeNull();
		fireEvent.click(header("Players & gameplay"));
		expect(screen.getByRole("link", { name: "Funnels" })).toBeTruthy();
		expect(stored()).toEqual({});
	});

	it("opens the group of the page you land on, but lets you close it after", () => {
		localStorage.setItem(NAV_STATE_KEY, JSON.stringify({ observe: true, data: true }));
		reloadCollapsed();
		mount("/errors");
		expect(header("Observe & troubleshoot").getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("link", { name: "Errors" })).toBeTruthy();
		// Other closed groups stay closed.
		expect(header("Data").getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(header("Observe & troubleshoot"));
		expect(header("Observe & troubleshoot").getAttribute("aria-expanded")).toBe("false");
		expect(stored()).toEqual({ observe: true, data: true });
	});

	it("shares the state between two sidebars (the desktop one and the drawer)", () => {
		render(
			<MemoryRouter>
				<SidebarNav />
				<SidebarNav />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getAllByRole("button", { name: "Data" })[0]);
		for (const button of screen.getAllByRole("button", { name: "Data" })) expect(button.getAttribute("aria-expanded")).toBe("false");
	});

	it("still works when storage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		reloadCollapsed();
		mount("/");
		expect(screen.getByRole("link", { name: "Funnels" })).toBeTruthy();
		fireEvent.click(header("Players & gameplay"));
		expect(screen.queryByRole("link", { name: "Funnels" })).toBeNull();
		fireEvent.click(header("Players & gameplay"));
		expect(screen.getByRole("link", { name: "Funnels" })).toBeTruthy();
	});

	it("ignores a damaged saved state", () => {
		for (const bad of ["not json", "[1,2]", '"x"', '{"players":"yes"}']) {
			localStorage.setItem(NAV_STATE_KEY, bad);
			reloadCollapsed();
			mount("/");
			expect(screen.getByRole("link", { name: "Funnels" })).toBeTruthy();
			cleanup();
		}
	});

	it("tells the page when a link was clicked (the drawer closes with it)", () => {
		const onNavigate = vi.fn();
		mount("/", { onNavigate });
		fireEvent.click(screen.getByRole("link", { name: "Events" }));
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});

	it("shows an owner-only page to an admin session and hides it otherwise", () => {
		mount("/");
		expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
		cleanup();
		mount("/", { auth: { ...admin, role: "game" } });
		expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Backend stats" })).toBeNull();
		// Its group goes with it.
		expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
		expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").length).toBe(NAV.filter((i) => !i.ownerOnly).length);
	});
});
