/**
 * The frame: the sidebar on the left (a drawer behind a menu button on a phone; its pages come from lib/nav.ts), the header
 * (page title, server status, theme) and the shared filter bar on top.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LayoutDashboard, LogOut, Menu, Monitor, Moon, Sun } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { cn } from "cn";
import { FilterBar } from "@/components/FilterBar";
import { FindPlayer } from "@/components/Identity";
import { PlaceCard, PlaceIconLink, usePageTitle } from "@/components/PlaceCard";
import { SidebarNav } from "@/components/SidebarNav";
import { UntrustedBrowserBanner } from "@/components/UntrustedBrowserBanner";
import { LoadingBlock } from "@/components/common";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { api, ApiError } from "@/lib/api";
import { dashboardUrl, isReadOnly, userLabel, useAuth } from "@/lib/auth";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtInt } from "@/lib/format";
import { findNavItem } from "@/lib/nav";
import { useTheme, type Theme } from "@/lib/theme";

/** Links keep the filter parameters (and drop page-only ones like pid). */
function useFilterSearch(): string {
	const { search } = useLocation();
	const params = new URLSearchParams(search);
	const kept = new URLSearchParams();
	for (const key of FILTER_KEYS) {
		const v = params.get(key);
		if (v) kept.set(key, v);
	}
	const text = kept.toString();
	return text ? `?${text}` : "";
}

function ServerStatus() {
	const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => api.health(signal), refetchInterval: 30_000, retry: false });
	let tone = "bg-muted-foreground";
	let text = "connecting";
	let title = "";
	if (health.isError) {
		tone = "bg-[var(--status-critical)]";
		const e = health.error;
		text =
			e instanceof ApiError && e.status === 503
				? "no admin token"
				: e instanceof ApiError && (e.status === 502 || e.status === 504 || e.status === 0)
					? "server down"
					: "error";
		title = e.message;
	} else if (health.data) {
		tone = "bg-[var(--status-good)]";
		const live = health.data.analytics?.live;
		text = live ? `connected · ${fmtInt(live.events)} live rows` : "connected";
		title = [health.data.runtime, health.data.rssMb ? `${health.data.rssMb} MB` : ""].filter(Boolean).join(", ");
	}
	return (
		<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" title={title}>
			<span className={cn("size-2 shrink-0 rounded-full", tone)} aria-hidden />
			<span className="truncate">{text}</span>
		</div>
	);
}

/** Who is signed in (Roblox name and avatar, or the admin token) and the Sign out button: the foot of the sidebar. */
function UserMenu() {
	const auth = useAuth();
	const client = useQueryClient();
	if (!auth) return null;
	const user = auth.user;
	const label = userLabel(user, auth.via);
	const readOnly = isReadOnly(auth);
	const out = async () => {
		try {
			await api.logout();
		} finally {
			client.clear();
			window.location.assign("/");
		}
	};
	return (
		<div className="flex items-center gap-2.5 px-1 text-sm" title={user?.kind === "roblox" ? `Roblox user ${user.userId}` : undefined}>
			{user?.kind === "roblox" && user.avatar ? (
				<img src={user.avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted" referrerPolicy="no-referrer" />
			) : (
				<span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase text-foreground" aria-hidden>
					{label.slice(0, 1)}
				</span>
			)}
			<span className="min-w-0 flex-1 truncate">
				{label}
				{readOnly ? <span className="ml-1.5 text-xs text-muted-foreground">read-only</span> : null}
			</span>
			{auth.via === "cookie" ? (
				<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label="Sign out" title="Sign out" onClick={() => void out()}>
					<LogOut />
				</Button>
			) : null}
		</div>
	);
}

/**
 * The TypeTorch Dashboard (typetorch.dev), when the backend has Sign in with typetorch.dev on: the last sidebar item, below
 * Settings, in a new tab.
 */
function DashboardLink({ onNavigate }: { onNavigate?: () => void }) {
	const href = dashboardUrl(useAuth()?.dashboard);
	if (!href) return null;
	return (
		<div className="mt-2 border-t border-sidebar-border pt-2">
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				onClick={onNavigate}
				className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/75 outline-none transition-colors hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
			>
				<LayoutDashboard className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				<span className="min-w-0 flex-1 truncate">TypeTorch Dashboard</span>
				<ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
			</a>
		</div>
	);
}

function ThemeToggle() {
	const { theme, resolved, setTheme } = useTheme();
	const Icon = theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label="Theme">
					<Icon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
					<DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** What the desktop sidebar and the phone drawer both show: the name, the pages, who is signed in. */
function SidebarPanel({ search, onNavigate }: { search: string; onNavigate?: () => void }) {
	return (
		<div className="flex h-full min-h-0 flex-col text-sidebar-foreground">
			<div className="flex items-center gap-3 px-5 pt-5 pb-4">
				<img src="/favicon.svg" alt="" className="size-8 shrink-0" />
				<div className="min-w-0">
					<div className="text-sm font-semibold">TypeTorch</div>
					<div className="text-xs text-muted-foreground">Backend explorer</div>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				<div className="mb-3">
					<PlaceCard />
				</div>
				<SidebarNav search={search} onNavigate={onNavigate} />
				<DashboardLink onNavigate={onNavigate} />
			</div>
			<div className="border-t border-sidebar-border px-4 py-3">
				<UserMenu />
			</div>
		</div>
	);
}

/** The phone's sidebar: a drawer behind the menu button. It closes on a page click, on a route change and when the screen grows. */
function MobileMenu({ search }: { search: string }) {
	const [open, setOpen] = useState(false);
	const { pathname } = useLocation();
	useEffect(() => setOpen(false), [pathname]);
	useEffect(() => {
		const wide = window.matchMedia?.("(min-width: 768px)");
		if (!wide) return;
		const onChange = () => wide.matches && setOpen(false);
		wide.addEventListener("change", onChange);
		return () => wide.removeEventListener("change", onChange);
	}, []);
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button variant="ghost" size="icon-sm" className="-ml-1.5 md:hidden" aria-label="Open menu">
					<Menu />
				</Button>
			</SheetTrigger>
			<SheetContent side="left" className="bg-sidebar md:hidden">
				<SheetTitle className="sr-only">Menu</SheetTitle>
				<SheetDescription className="sr-only">The explorer's pages</SheetDescription>
				<SidebarPanel search={search} onNavigate={() => setOpen(false)} />
			</SheetContent>
		</Sheet>
	);
}

export function AppShell() {
	const search = useFilterSearch();
	const { pathname } = useLocation();
	const current = findNavItem(pathname);
	usePageTitle(current?.label);
	return (
		<div className="flex min-h-svh">
			<aside className="sticky top-0 hidden h-svh w-60 shrink-0 border-r bg-sidebar md:block">
				<SidebarPanel search={search} />
			</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
					<div className="flex items-center justify-between gap-3 px-4 py-2">
						<div className="flex min-w-0 items-center gap-2">
							<MobileMenu search={search} />
							<PlaceIconLink className="md:hidden" />
							<div className="truncate text-sm font-medium">{current?.label}</div>
						</div>
						<div className="flex min-w-0 shrink items-center gap-3">
							<FindPlayer />
							<ServerStatus />
							<ThemeToggle />
						</div>
					</div>
					{current?.noFilters ? null : (
						<div className="border-t px-4 py-2">
							<FilterBar />
						</div>
					)}
				</header>
				<main className="flex-1 space-y-4 p-4">
					<UntrustedBrowserBanner />
					<Suspense fallback={<LoadingBlock rows={6} />}>
						<Outlet />
					</Suspense>
				</main>
			</div>
		</div>
	);
}
