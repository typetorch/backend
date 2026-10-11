// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/components/LoginPage";
import { api } from "@/lib/api";
import { AuthProvider, dashboardUrl, loginOptionsOf } from "@/lib/auth";
import { reloadCollapsed } from "@/lib/nav-state";
import { ThemeProvider } from "@/lib/theme";
import type { AuthInfo } from "@/lib/types";

const DASH = "https://dash.typetorch.dev";

beforeEach(() => {
	localStorage.clear();
	reloadCollapsed();
	vi.spyOn(api, "health").mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof api.health>>);
	vi.spyOn(api, "place").mockResolvedValue({ configured: false });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(auth: AuthInfo) {
	return render(
		<ThemeProvider>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AuthProvider value={auth}>
					<MemoryRouter initialEntries={["/fleet"]}>
						<Routes>
							<Route element={<AppShell />}>
								<Route path="*" element={<div>the page</div>} />
							</Route>
						</Routes>
					</MemoryRouter>
				</AuthProvider>
			</QueryClientProvider>
		</ThemeProvider>,
	);
}

describe("TypeTorch Dashboard link", () => {
	it("shows in the sidebar below Settings when the backend names the dashboard, in a new tab without referrer", () => {
		mount({ ok: true, role: "admin", via: "cookie", dashboard: DASH });
		const links = screen.getAllByRole("link", { name: "TypeTorch Dashboard" });
		expect(links).toHaveLength(1);
		const link = links[0];
		expect(link.getAttribute("href")).toBe(DASH);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		const settings = screen.getByRole("link", { name: "Settings" });
		expect(settings.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("is hidden while Sign in with typetorch.dev is off (no dashboard in the auth check)", () => {
		mount({ ok: true, role: "admin", via: "cookie" });
		expect(screen.queryByRole("link", { name: "TypeTorch Dashboard" })).toBeNull();
	});

	it("shows on the sign-in page next to Sign in with typetorch.dev, only while that login is on", () => {
		render(<LoginPage options={loginOptionsOf({ login: { token: true, roblox: false, typetorch: true, dashboard: DASH } })} onSignedIn={() => {}} />);
		const link = screen.getByRole("link", { name: /typetorch dashboard/i });
		expect(link.getAttribute("href")).toBe(DASH);
		expect(link.getAttribute("rel")).toBe("noopener");
		expect(screen.getByRole("link", { name: /sign in with typetorch\.dev/i })).toBeTruthy();
		cleanup();
		render(<LoginPage options={loginOptionsOf({ login: { token: true, roblox: false, dashboard: DASH } })} onSignedIn={() => {}} />);
		expect(screen.queryByRole("link", { name: /typetorch dashboard/i })).toBeNull();
	});

	it("takes only a plain https origin (http on loopback)", () => {
		expect(dashboardUrl(DASH)).toBe(DASH);
		expect(dashboardUrl(`${DASH}/`)).toBe(DASH);
		expect(dashboardUrl("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
		for (const bad of ["http://dash.typetorch.dev", "javascript:alert(1)", `${DASH}/path`, "https://u:p@dash.typetorch.dev", "", 42, undefined]) {
			expect(dashboardUrl(bad)).toBeUndefined();
		}
	});
});
