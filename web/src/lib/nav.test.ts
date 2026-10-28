import { describe, expect, it } from "vitest";
import mainSource from "../main.tsx?raw";
import { canSee, findNavItem, HIDDEN_ROUTES, NAV, NAV_GROUPS, visibleGroups, type NavGroup, type NavItem } from "./nav";

/**
 * The route paths in main.tsx, read from its source as text (importing main.tsx would render the app, and leaving the
 * table there keeps adding a route a one-line change). `:param` becomes a sample value.
 */
function routePaths(): string[] {
	const source = mainSource;
	const found = new Set<string>();
	for (const [, path] of source.matchAll(/\bpath:\s*"([^"]*)"/g)) {
		if (path === "/") continue; // the shell itself; its index route is "/"
		found.add(path === "*" ? "*" : `/${path.replace(/^\//, "")}`);
	}
	if (/\bindex:\s*true/.test(source)) found.add("/");
	return [...found];
}

const sample = (route: string) => route.replace(/:[A-Za-z0-9_]+/g, "x");

describe("routes and the sidebar agree", () => {
	const routes = routePaths();

	it("finds the routes in main.tsx", () => {
		expect(routes).toContain("/");
		expect(routes).toContain("/fleet");
		expect(routes).toContain("*");
	});

	it("gives every route a nav item, or hides it on purpose (HIDDEN_ROUTES in lib/nav.ts)", () => {
		const hidden = new Set(HIDDEN_ROUTES.map((h) => h.path));
		const orphans = routes.filter((r) => !hidden.has(r) && !findNavItem(sample(r)));
		expect(orphans, `routes with no nav item: add one to NAV_GROUPS (or an \`also\` prefix on its parent item, or HIDDEN_ROUTES with a reason)`).toEqual([]);
	});

	it("has a route for every nav item, and for every hidden route", () => {
		expect(NAV.filter((i) => !routes.includes(i.path)).map((i) => i.path), "nav items with no route in main.tsx").toEqual([]);
		expect(HIDDEN_ROUTES.filter((h) => !routes.includes(h.path)).map((h) => h.path), "stale HIDDEN_ROUTES entries").toEqual([]);
	});

	it("explains every hidden route", () => {
		for (const h of HIDDEN_ROUTES) expect(h.reason.length).toBeGreaterThan(3);
	});
});

describe("the nav config", () => {
	it("has unique group ids, paths and labels, and paths that start with a slash", () => {
		const unique = (values: string[]) => expect(new Set(values).size).toBe(values.length);
		unique(NAV_GROUPS.map((g) => g.id));
		unique(NAV.map((i) => i.path));
		unique(NAV.map((i) => i.label));
		for (const i of NAV) {
			expect(i.path.startsWith("/")).toBe(true);
			for (const prefix of i.also ?? []) expect(prefix.startsWith("/")).toBe(true);
		}
	});

	it("keeps every item in a group, and only the first group may go without a header", () => {
		for (const g of NAV_GROUPS) expect(g.items.length).toBeGreaterThan(0);
		expect(NAV_GROUPS.slice(1).every((g) => g.label)).toBe(true);
	});

	it("lists Roblox last under Players & gameplay, not under Observe & troubleshoot", () => {
		const labels = (id: string) => NAV_GROUPS.find((g) => g.id === id)?.items.map((i) => i.label) ?? [];
		expect(labels("players").at(-1)).toBe("Roblox");
		expect(labels("players").at(-2)).toBe("Experiments");
		expect(labels("observe")).not.toContain("Roblox");
		expect(findNavItem("/roblox")?.path).toBe("/roblox");
	});

	it("uses short labels and no emojis", () => {
		for (const text of [...NAV.map((i) => i.label), ...NAV_GROUPS.flatMap((g) => (g.label ? [g.label] : []))]) {
			expect(text.length).toBeLessThanOrEqual(26);
			expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
		}
	});
});

describe("findNavItem", () => {
	it("matches a page, its sub pages and the detail pages listed in `also`", () => {
		expect(findNavItem("/")?.label).toBe("Overview");
		expect(findNavItem("/players")?.label).toBe("Players");
		expect(findNavItem("/players/abc")?.label).toBe("Players");
		expect(findNavItem("/fleet")?.label).toBe("Fleet");
		expect(findNavItem("/servers/job-1")?.label).toBe("Fleet");
		expect(findNavItem("/deploys")?.label).toBe("Deploys");
		expect(findNavItem("/deploys/42")?.label).toBe("Deploys");
	});

	it("does not match by a bare string prefix, and '/' only matches itself", () => {
		expect(findNavItem("/fleets")).toBeUndefined();
		expect(findNavItem("/nope")).toBeUndefined();
		expect(findNavItem("/serversx/1")).toBeUndefined();
	});

	it("takes the longest prefix", () => {
		const items: NavItem[] = [
			{ label: "A", path: "/a", icon: NAV[0].icon },
			{ label: "B", path: "/b", icon: NAV[0].icon, also: ["/a/deep"] },
		];
		expect(findNavItem("/a/x", items)?.label).toBe("A");
		expect(findNavItem("/a/deep/1", items)?.label).toBe("B");
	});
});

describe("ownerOnly", () => {
	const icon = NAV[0].icon;
	const groups: NavGroup[] = [
		{ id: "open", items: [{ label: "Open", path: "/open", icon }] },
		{ id: "locked", label: "Locked", items: [{ label: "Secret", path: "/secret", icon, ownerOnly: true }] },
	];

	it("shows an owner-only item to an admin session only", () => {
		const secret = groups[1].items[0];
		expect(canSee(secret, { role: "admin" })).toBe(true);
		expect(canSee(secret, { role: "web" })).toBe(false);
		expect(canSee(secret, { role: "game" })).toBe(false);
		expect(canSee(secret, null)).toBe(false);
		expect(canSee(groups[0].items[0], null)).toBe(true);
	});

	it("drops a group with nothing left to show", () => {
		expect(visibleGroups({ role: "admin" }, groups).map((g) => g.id)).toEqual(["open", "locked"]);
		expect(visibleGroups({ role: "game" }, groups).map((g) => g.id)).toEqual(["open"]);
	});

	it("lets the real config show every page to an admin session", () => {
		expect(visibleGroups({ role: "admin" }).flatMap((g) => g.items)).toEqual(NAV);
	});
});
