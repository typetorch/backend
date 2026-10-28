/**
 * The explorer's left sidebar, from one list: groups of items. The sidebar (components/SidebarNav.tsx), the mobile drawer
 * and the page title in the header all read this and nothing else.
 *
 * Adding a page = one line in the group it belongs to (and its route in main.tsx; nav.test.ts fails when the two disagree).
 *
 * Where the pages other branches add go:
 *   - Fleet server pages (/servers/:jobId): not nav items. They already light up Fleet through its `also: ["/servers"]`,
 *     so just add the route in main.tsx. Another detail page under a nav item: add its path prefix to that item's `also`.
 *   - A page that is deliberately in no menu: add it to HIDDEN_ROUTES below, with the reason.
 * A new group is one more object in NAV_GROUPS (a stable `id`: the open / closed state is remembered per id).
 */
import {
	Activity,
	Bug,
	CalendarRange,
	Compass,
	Cpu,
	FlaskConical,
	Gamepad2,
	Gauge,
	LayoutDashboard,
	ListFilter,
	ScrollText,
	Server,
	Settings,
	Terminal,
	Users,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import type { AuthInfo } from "./types";

export interface NavItem {
	/** One or two words. Also the page title in the header. */
	label: string;
	/** The route: "/" or "/something". */
	path: string;
	/** A lucide-react icon (the icon set the app already uses). */
	icon: LucideIcon;
	/** Pages under these path prefixes that are not nav items themselves (a detail page) keep this item lit and use its title. */
	also?: string[];
	/** The page doesn't use the shared filters (Fleet is live, Query has its own): the header leaves the filter bar out. */
	noFilters?: boolean;
	/**
	 * Only for an owner / admin session (a Roblox owner or the admin token): hidden from the read-only `web` role (a Roblox
	 * viewer). Only a convenience: the backend enforces access either way.
	 */
	ownerOnly?: boolean;
}

export interface NavGroup {
	/** Stable id: where the open / closed state is remembered. Never rename one. */
	id: string;
	/** The small muted header. A group without one is always open and has no header (the top of the list). */
	label?: string;
	items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
	{
		id: "overview",
		items: [{ label: "Overview", path: "/", icon: LayoutDashboard }],
	},
	{
		id: "players",
		label: "Players & gameplay",
		items: [
			{ label: "Players", path: "/players", icon: Users },
			{ label: "Events", path: "/events", icon: Activity },
			{ label: "Funnels", path: "/funnels", icon: ListFilter },
			{ label: "Flow", path: "/flow", icon: Workflow },
			{ label: "Retention", path: "/retention", icon: CalendarRange },
			{ label: "First session", path: "/first-session", icon: Compass },
			{ label: "Experiments", path: "/experiments", icon: FlaskConical },
			{ label: "Roblox", path: "/roblox", icon: Gamepad2 },
		],
	},
	{
		id: "observe",
		label: "Observe & troubleshoot",
		items: [
			{ label: "Fleet", path: "/fleet", icon: Server, noFilters: true, also: ["/servers"] },
			{ label: "Errors", path: "/errors", icon: Bug, noFilters: true },
			{ label: "Performance", path: "/performance", icon: Gauge },
		],
	},
	{
		id: "data",
		label: "Data",
		items: [{ label: "Query", path: "/query", icon: Terminal }],
	},
	{
		id: "admin",
		label: "Admin",
		items: [
			{ label: "Settings", path: "/settings", icon: Settings, noFilters: true, ownerOnly: true },
			{ label: "Backend stats", path: "/backend", icon: Cpu, noFilters: true, ownerOnly: true },
			{ label: "Audit log", path: "/audit", icon: ScrollText, noFilters: true, ownerOnly: true },
		],
	},
];

/** Routes (main.tsx) that are in no menu on purpose, with why. Everything else needs a nav item or an `also` prefix. */
export const HIDDEN_ROUTES: { path: string; reason: string }[] = [{ path: "*", reason: "the not-found page" }];

/** Every item in menu order. */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

function under(pathname: string, prefix: string): boolean {
	return prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The item a page belongs to: the longest matching `path` / `also` prefix ("/" only matches itself). */
export function findNavItem(pathname: string, items: readonly NavItem[] = NAV): NavItem | undefined {
	let best: NavItem | undefined;
	let bestLength = -1;
	for (const item of items) {
		for (const prefix of [item.path, ...(item.also ?? [])]) {
			if (under(pathname, prefix) && prefix.length > bestLength) {
				best = item;
				bestLength = prefix.length;
			}
		}
	}
	return best;
}

/** May this session see the item? (See `ownerOnly`.) */
export function canSee(item: NavItem, auth: Pick<AuthInfo, "role"> | null | undefined): boolean {
	return !item.ownerOnly || auth?.role === "admin";
}

/** The groups this session may see; a group with nothing left to show goes away. */
export function visibleGroups(auth: Pick<AuthInfo, "role"> | null | undefined, groups: readonly NavGroup[] = NAV_GROUPS): NavGroup[] {
	return groups.map((g) => ({ ...g, items: g.items.filter((i) => canSee(i, auth)) })).filter((g) => g.items.length > 0);
}
