// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	builtinCommands,
	createRegistry,
	fuzzyScore,
	looksLikePlayer,
	playerCommand,
	pushRecent,
	rankCommands,
	readRecent,
	RECENT_MAX,
	scoreCommand,
	withFilters,
	type Command,
	type CommandContext,
} from "./commands";

function context(patch: Partial<CommandContext> = {}): CommandContext {
	return {
		pathname: "/",
		search: "",
		role: "admin",
		cookieSession: true,
		filtersOn: true,
		navigate: vi.fn(),
		setFilters: vi.fn(),
		resetFilters: vi.fn(),
		refresh: vi.fn(),
		theme: "system",
		resolvedTheme: "light",
		setTheme: vi.fn(),
		href: "https://example.test/",
		copy: vi.fn(),
		signOut: vi.fn(),
		...patch,
	};
}

const titles = (groups: ReturnType<typeof rankCommands>) => groups.flatMap((g) => g.commands.map((c) => c.title));
const find = (id: string) => builtinCommands().find((c) => c.id === id) as Command;

beforeEach(() => localStorage.clear());

describe("fuzzy matching", () => {
	it("no match is null; a prefix beats a word start beats the middle beats a subsequence", () => {
		expect(fuzzyScore("xyz", "Players")).toBeNull();
		const prefix = fuzzyScore("ret", "Retention") as number;
		const word = fuzzyScore("ses", "First session") as number;
		const middle = fuzzyScore("ten", "Retention") as number;
		const subsequence = fuzzyScore("rtn", "Retention") as number;
		expect(prefix).toBeGreaterThan(word);
		expect(word).toBeGreaterThan(middle);
		expect(middle).toBeGreaterThan(subsequence);
		expect(subsequence).not.toBeNull();
	});

	it("is case-insensitive; every word of the query must match the title, keywords or group", () => {
		const cmd = { title: "Last 7 days", group: "Date range", keywords: ["7d"] };
		expect(scoreCommand(cmd, "LAST 7")).not.toBeNull();
		expect(scoreCommand(cmd, "date 7d")).not.toBeNull();
		expect(scoreCommand(cmd, "last zebra")).toBeNull();
		expect(scoreCommand(cmd, "")).toBe(0);
	});

	it("ranks the best page first", () => {
		const groups = rankCommands(builtinCommands(), "retent", context());
		expect(titles(groups)[0]).toBe("Retention");
		expect(titles(rankCommands(builtinCommands(), "fs", context()))[0]).toBe("First session");
		expect(titles(rankCommands(builtinCommands(), "90", context()))[0]).toBe("Last 90 days");
	});
});

describe("ranking and recent", () => {
	it("an empty query lists every group in order, recent ones first and not twice", () => {
		const groups = rankCommands(builtinCommands(), "", context(), ["nav:/fleet", "gone:old", "view:copy-link"]);
		expect(groups.map((g) => g.group)).toEqual(["Recent", "Pages", "Date range", "Filters", "View", "Account"]);
		expect(groups[0].commands.map((c) => c.id)).toEqual(["nav:/fleet", "view:copy-link"]);
		expect(groups[1].commands.some((c) => c.id === "nav:/fleet")).toBe(false);
	});

	it("remembers the last commands, newest first, once each, at most RECENT_MAX", () => {
		expect(readRecent()).toEqual([]);
		pushRecent("a");
		pushRecent("b");
		pushRecent("a");
		expect(readRecent()).toEqual(["a", "b"]);
		for (const id of ["c", "d", "e", "f", "g"]) pushRecent(id);
		expect(readRecent()).toHaveLength(RECENT_MAX);
		expect(readRecent()[0]).toBe("g");
		localStorage.setItem("tt-explorer-recent-commands", "{not json");
		expect(readRecent()).toEqual([]);
	});

	it("owner-only pages only for an owner session; filters only on pages with the filter bar; sign out only with a cookie", () => {
		const owner = titles(rankCommands(builtinCommands(), "", context()));
		expect(owner).toEqual(expect.arrayContaining(["Settings", "Backend stats", "Audit log", "Sign out", "Last 7 days", "Clear filters"]));
		const viewer = titles(rankCommands(builtinCommands(), "", context({ role: "web", cookieSession: true })));
		expect(viewer).not.toContain("Settings");
		expect(viewer).not.toContain("Audit log");
		expect(viewer).toContain("Players");
		const proxy = titles(rankCommands(builtinCommands(), "", context({ cookieSession: false, filtersOn: false })));
		expect(proxy).not.toContain("Sign out");
		expect(proxy).not.toContain("Last 7 days");
		expect(proxy).not.toContain("Clear filters");
	});
});

describe("registry", () => {
	it("adds and removes exactly what was registered, telling subscribers", () => {
		const registry = createRegistry();
		const listener = vi.fn();
		registry.subscribe(listener);
		const a: Command = { id: "a", title: "A", group: "This page", run: vi.fn() };
		const b: Command = { id: "b", title: "B", group: "This page", run: vi.fn() };
		const offA = registry.register([a]);
		const offB = registry.register([b]);
		expect(registry.list().map((c) => c.id)).toEqual(["a", "b"]);
		offA();
		offA();
		expect(registry.list().map((c) => c.id)).toEqual(["b"]);
		offB();
		expect(registry.list()).toEqual([]);
		expect(listener).toHaveBeenCalledTimes(4);
	});

	it("page commands are listed before the pages on an empty query", () => {
		const page: Command = { id: "p", title: "Copy this player's pid", group: "This page", run: vi.fn() };
		expect(rankCommands([page, ...builtinCommands()], "", context()).map((g) => g.group)[0]).toBe("This page");
	});
});

describe("commands", () => {
	it("pages keep the shared filters and drop page-only parameters", () => {
		const ctx = context({ search: "?range=7d&branch=dev&pid=abc123&sid=9" });
		find("nav:/retention").run(ctx);
		expect(ctx.navigate).toHaveBeenCalledWith("/retention?range=7d&branch=dev");
		expect(withFilters("/", "")).toBe("/");
	});

	it("date ranges, clear filters, theme, copy link, refresh and sign out call the context", () => {
		const ctx = context({ resolvedTheme: "dark", href: "https://example.test/players?range=7d" });
		find("range:7d").run(ctx);
		expect(ctx.setFilters).toHaveBeenCalledWith({ range: "7d", from: undefined, to: undefined });
		find("filters:clear").run(ctx);
		expect(ctx.resetFilters).toHaveBeenCalled();
		find("view:theme-toggle").run(ctx);
		expect(ctx.setTheme).toHaveBeenCalledWith("light");
		find("view:copy-link").run(ctx);
		expect(ctx.copy).toHaveBeenCalledWith("https://example.test/players?range=7d");
		find("view:refresh").run(ctx);
		expect(ctx.refresh).toHaveBeenCalled();
		find("account:sign-out").run(ctx);
		expect(ctx.signOut).toHaveBeenCalled();
	});

	it("offers a player for a UserId or a pid-like text, not for words", () => {
		expect(looksLikePlayer("123456")).toBe(true);
		expect(looksLikePlayer("a1B2c3D4e5")).toBe(true);
		expect(looksLikePlayer("settings")).toBe(false);
		expect(looksLikePlayer("abc")).toBe(false);
		expect(looksLikePlayer("has space 123")).toBe(false);
		expect(playerCommand("ret")).toBeUndefined();
		const cmd = playerCommand(" 123456 ") as Command;
		expect(cmd.title).toBe("Open player 123456");
		const ctx = context({ search: "?range=1d&pid=old" });
		cmd.run(ctx);
		expect(ctx.navigate).toHaveBeenCalledWith("/players?range=1d&find=123456");
	});
});
