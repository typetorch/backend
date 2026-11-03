/**
 * The command palette's commands (Ctrl+K / Cmd+K; components/CommandPalette.tsx draws it). Pure: a command is data plus a
 * `run(ctx)`, the context is everything a command may touch (navigate, filters, theme, clipboard, sign out), so the
 * matching, the ordering and every built-in command are testable without a browser.
 *
 * Adding a command:
 *   - one the whole app has: add it to `builtinCommands` below;
 *   - one only a page has: `useRegisterCommands([...], deps)` in that page (it goes away when the page does).
 * A command that only some sessions may use: `when: (ctx) => ctx.role === "admin"` (nav items use `canSee`, like the sidebar).
 */
import { CalendarRange, FilterX, Link2, LogOut, Monitor, RefreshCw, SunMoon, UserSearch, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { DEFAULT_RANGE, FILTER_KEYS, RANGE_LABELS, RANGE_PRESETS, type FilterState } from "./filters";
import { canSee, NAV, NAV_GROUPS } from "./nav";
import type { Theme } from "./theme";
import type { AuthInfo } from "./types";

export interface CommandContext {
	pathname: string;
	/** The current query string ("?range=7d&pid=..." or ""). */
	search: string;
	role?: AuthInfo["role"];
	/** Signed in with the session cookie (so Sign out means something; a proxy's Bearer token can't sign out). */
	cookieSession: boolean;
	/** The current page shows the shared filter bar. */
	filtersOn: boolean;
	navigate(to: string): void;
	setFilters(patch: Partial<FilterState>): void;
	resetFilters(): void;
	theme: Theme;
	resolvedTheme: "light" | "dark";
	setTheme(theme: Theme): void;
	/** Fetch every shown answer again. */
	refresh(): void;
	/** The page's full address (for Copy link). */
	href: string;
	copy(text: string): Promise<void> | void;
	signOut(): Promise<void> | void;
}

export interface Command {
	/** Stable: the recent list remembers ids. */
	id: string;
	title: string;
	/** The heading it is listed under. */
	group: string;
	/** Other words that find it (matched a little weaker than the title). */
	keywords?: string[];
	/** A lucide icon on the left (pages use their sidebar icon). */
	icon?: LucideIcon;
	/** Keys shown on the right, e.g. ["Ctrl", "Enter"]. Display only: the page handles the keys itself. */
	shortcut?: string[];
	/** Shown only when this says so (role, page, state). */
	when?(ctx: CommandContext): boolean;
	run(ctx: CommandContext): void | Promise<void>;
}

/** The order groups are listed in on an empty query (unknown groups go after, page commands first of those). */
export const GROUP_ORDER = ["Recent", "Player", "This page", "Pages", "Date range", "Filters", "View", "Account"];

// ---------------------------------------------------------------- registry

export interface CommandRegistry {
	/** Adds commands; the returned function takes exactly these out again. */
	register(commands: readonly Command[]): () => void;
	list(): Command[];
	subscribe(listener: () => void): () => void;
}

export function createRegistry(): CommandRegistry {
	const sets = new Set<readonly Command[]>();
	const listeners = new Set<() => void>();
	let snapshot: Command[] = [];
	const changed = () => {
		snapshot = [...sets].flat();
		for (const l of listeners) l();
	};
	return {
		register(commands) {
			const entry = [...commands];
			sets.add(entry);
			changed();
			return () => {
				if (sets.delete(entry)) changed();
			};
		},
		list: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** The app's registry: pages add theirs with `useRegisterCommands`. */
export const commandRegistry = createRegistry();

/** A page's own commands while it is mounted. `deps` like useEffect's: re-registered when they change. */
export function useRegisterCommands(commands: readonly Command[], deps: readonly unknown[], registry: CommandRegistry = commandRegistry): void {
	useEffect(
		() => registry.register(commands),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[registry, ...deps],
	);
}

// ---------------------------------------------------------------- links

/** The shared filter parameters of `search` (page-only ones like pid dropped), as the sidebar links keep them. */
export function keptFilters(search: string): URLSearchParams {
	const current = new URLSearchParams(search);
	const kept = new URLSearchParams();
	for (const key of FILTER_KEYS) {
		const v = current.get(key);
		if (v) kept.set(key, v);
	}
	return kept;
}

/** `path` with the shared filters of `search`. */
export function withFilters(path: string, search: string, extra: Record<string, string> = {}): string {
	const params = keptFilters(search);
	for (const [k, v] of Object.entries(extra)) params.set(k, v);
	const text = params.toString();
	return text ? `${path}?${text}` : path;
}

// ---------------------------------------------------------------- find player

const UID = /^\d{1,16}$/;
const PID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Text that may be a player: a Roblox UserId (digits) or a pid (the Players page's shape, 8+ characters; with a digit or 16+
 * long, so plain words like "settings" stay page searches).
 */
export function looksLikePlayer(text: string): boolean {
	const t = text.trim();
	if (UID.test(t)) return true;
	return PID.test(t) && (/\d/.test(t) || t.length >= 16);
}

/** "Open player <text>" for text that looks like a player, else nothing. */
export function playerCommand(query: string): Command | undefined {
	const text = query.trim();
	if (!looksLikePlayer(text)) return undefined;
	return {
		id: "player:find",
		title: `Open player ${text}`,
		group: "Player",
		icon: UserSearch,
		run: (ctx) => ctx.navigate(withFilters("/players", ctx.search, { find: text })),
	};
}

// ---------------------------------------------------------------- built-ins

const groupOf = new Map(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.path, g.label ?? ""] as const)));

export function builtinCommands(): Command[] {
	const pages: Command[] = NAV.map((item) => ({
		id: `nav:${item.path}`,
		title: item.label,
		group: "Pages",
		icon: item.icon,
		keywords: ["go", "open", "page", item.path, groupOf.get(item.path) ?? ""].filter(Boolean),
		when: (ctx) => canSee(item, ctx.role ? { role: ctx.role } : null),
		run: (ctx) => ctx.navigate(withFilters(item.path, ctx.search)),
	}));
	const ranges: Command[] = RANGE_PRESETS.map((range) => ({
		id: `range:${range}`,
		title: RANGE_LABELS[range],
		group: "Date range",
		icon: CalendarRange,
		keywords: ["date", "range", "time", range, ...(range === DEFAULT_RANGE ? ["default"] : [])],
		when: (ctx) => ctx.filtersOn,
		run: (ctx) => ctx.setFilters({ range, from: undefined, to: undefined }),
	}));
	return [
		...pages,
		...ranges,
		{
			id: "filters:clear",
			title: "Clear filters",
			icon: FilterX,
			group: "Filters",
			keywords: ["reset", "branch", "build", "device", "players", "variant"],
			when: (ctx) => ctx.filtersOn,
			run: (ctx) => ctx.resetFilters(),
		},
		{
			id: "view:copy-link",
			title: "Copy link to this view",
			icon: Link2,
			group: "View",
			keywords: ["share", "url", "clipboard", "address"],
			run: (ctx) => ctx.copy(ctx.href),
		},
		{
			id: "view:refresh",
			title: "Refresh data",
			group: "View",
			icon: RefreshCw,
			keywords: ["reload", "fetch", "update"],
			run: (ctx) => ctx.refresh(),
		},
		{
			id: "view:theme-toggle",
			title: "Toggle theme",
			icon: SunMoon,
			group: "View",
			keywords: ["dark", "light", "mode", "appearance"],
			run: (ctx) => ctx.setTheme(ctx.resolvedTheme === "dark" ? "light" : "dark"),
		},
		{
			id: "view:theme-system",
			title: "Use the system theme",
			icon: Monitor,
			group: "View",
			keywords: ["theme", "auto", "dark", "light", "mode"],
			when: (ctx) => ctx.theme !== "system",
			run: (ctx) => ctx.setTheme("system"),
		},
		{
			id: "account:sign-out",
			title: "Sign out",
			icon: LogOut,
			group: "Account",
			keywords: ["log out", "logout", "session"],
			when: (ctx) => ctx.cookieSession,
			run: (ctx) => ctx.signOut(),
		},
	];
}

// ---------------------------------------------------------------- matching

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/&(]/.test(text[i - 1]);

/**
 * How well `query` (one word) matches `text`: null for no match, higher is better. A substring wins (more at the start
 * or a word start); else the letters in order (a subsequence), with points for runs and word starts and a cost per gap.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = query.trim().toLowerCase();
	const t = text.toLowerCase();
	if (!q) return 0;
	const at = t.indexOf(q);
	if (at >= 0) {
		let score = 1000 - at;
		if (at === 0) score += 300;
		else if (isBoundary(t, at)) score += 200;
		if (q.length === t.length) score += 100;
		return score;
	}
	let score = 0;
	let from = 0;
	let prev = -2;
	for (const ch of q) {
		const i = t.indexOf(ch, from);
		if (i < 0) return null;
		score += 10;
		if (i === prev + 1) score += 15;
		if (isBoundary(t, i)) score += 20;
		if (prev >= 0) score -= Math.min(i - prev - 1, 10);
		prev = i;
		from = i + 1;
	}
	return score;
}

/** A command against the whole query: every word must match the title, the keywords or the group. Null = no match. */
export function scoreCommand(command: Pick<Command, "title" | "keywords" | "group">, query: string): number | null {
	const words = query.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return 0;
	const other = [...(command.keywords ?? []), command.group].join(" ");
	let total = 0;
	for (const word of words) {
		const title = fuzzyScore(word, command.title);
		const rest = fuzzyScore(word, other);
		const best = Math.max(title ?? -Infinity, rest === null ? -Infinity : rest * 0.6);
		if (best === -Infinity) return null;
		total += best;
	}
	return total;
}

export interface CommandGroup {
	group: string;
	commands: Command[];
}

function byGroupOrder(a: string, b: string): number {
	const ia = GROUP_ORDER.indexOf(a);
	const ib = GROUP_ORDER.indexOf(b);
	return (ia < 0 ? GROUP_ORDER.length : ia) - (ib < 0 ? GROUP_ORDER.length : ib);
}

/**
 * What the palette lists: the commands `when` allows, grouped. An empty query: the recent ones first (most recent on top),
 * then every group in GROUP_ORDER. A query: the matches best first, groups in the order of their best match.
 */
export function rankCommands(commands: readonly Command[], query: string, ctx: CommandContext, recent: readonly string[] = []): CommandGroup[] {
	const visible = commands.filter((c) => !c.when || c.when(ctx));
	const groups = new Map<string, Command[]>();
	const add = (group: string, c: Command) => {
		const list = groups.get(group);
		if (list) list.push(c);
		else groups.set(group, [c]);
	};
	if (!query.trim()) {
		const byId = new Map(visible.map((c) => [c.id, c]));
		const recentCommands = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c);
		const taken = new Set(recentCommands.map((c) => c.id));
		for (const c of recentCommands) add("Recent", c);
		const rest = visible.filter((c) => !taken.has(c.id));
		const order = [...new Set(rest.map((c) => c.group))].sort(byGroupOrder);
		for (const g of order) for (const c of rest) if (c.group === g) add(g, c);
		return [...groups].map(([group, list]) => ({ group, commands: list }));
	}
	const scored = visible
		.map((c, i) => ({ c, i, score: scoreCommand(c, query) }))
		.filter((s): s is { c: Command; i: number; score: number } => s.score !== null)
		.sort((a, b) => b.score - a.score || a.i - b.i);
	for (const { c } of scored) add(c.group, c);
	return [...groups].map(([group, list]) => ({ group, commands: list }));
}

// ---------------------------------------------------------------- recent

const RECENT_KEY = "tt-explorer-recent-commands";
export const RECENT_MAX = 5;

export function readRecent(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v.length <= 200).slice(0, RECENT_MAX) : [];
	} catch {
		return [];
	}
}

/** Puts `id` on top of the recent list (once, at most RECENT_MAX kept) and returns the new list. */
export function pushRecent(id: string, list: readonly string[] = readRecent()): string[] {
	const next = [id, ...list.filter((v) => v !== id)].slice(0, RECENT_MAX);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// private mode: not remembered
	}
	return next;
}
