/**
 * The command palette: Ctrl+K / Cmd+K anywhere (inputs too), or the "Search..." button in the header. Type to filter
 * (fuzzy), arrows and Enter to run, Escape to close; an empty query lists the recent commands first. The commands and the
 * matching live in lib/commands.ts; pages add their own with `useRegisterCommands`.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { signOut, useAuth } from "@/lib/auth";
import { builtinCommands, commandRegistry, playerCommand, pushRecent, rankCommands, readRecent, type Command, type CommandContext, type CommandGroup } from "@/lib/commands";
import { useFilters } from "@/lib/hooks";
import { findNavItem } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Ctrl+K or Cmd+K, nothing else held. */
export function isPaletteKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
	return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isPaletteKey(e)) return;
			e.preventDefault(); // the browser's own Ctrl+K (its search bar)
			setOpen((o) => !o);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const keys = isMac() ? "⌘K" : "Ctrl K";
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger asChild>
				<Button
					variant="outline"
					size="sm"
					aria-label="Search commands"
					aria-keyshortcuts="Control+K Meta+K"
					title={`Search pages and commands (${keys})`}
					className="h-7 shrink-0 gap-2 px-2 font-normal text-muted-foreground sm:w-36 sm:justify-start lg:w-44"
				>
					<Search />
					<span className="hidden flex-1 text-left text-xs sm:inline">Search…</span>
					<kbd className="hidden rounded border bg-muted px-1 font-sans text-[0.65rem] leading-4 lg:inline">{keys}</kbd>
				</Button>
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
				<Dialog.Content
					aria-describedby={undefined}
					className="fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
				>
					<Dialog.Title className="sr-only">Command palette</Dialog.Title>
					{open ? <PaletteBody close={() => setOpen(false)} /> : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function usePaletteContext(): CommandContext {
	const navigate = useNavigate();
	const { pathname, search, hash } = useLocation();
	const { set, reset } = useFilters();
	const { theme, resolved, setTheme } = useTheme();
	const auth = useAuth();
	const client = useQueryClient();
	return {
		pathname,
		search,
		role: auth?.role,
		cookieSession: auth?.via === "cookie",
		filtersOn: !findNavItem(pathname)?.noFilters,
		navigate: (to) => navigate(to),
		setFilters: set,
		resetFilters: reset,
		theme,
		resolvedTheme: resolved,
		setTheme,
		refresh: () => void client.invalidateQueries(),
		href: `${window.location.origin}${pathname}${search}${hash}`,
		copy: async (text) => {
			await navigator.clipboard?.writeText(text);
		},
		signOut: () => signOut(client),
	};
}

function PaletteBody({ close }: { close(): void }) {
	const ctx = usePaletteContext();
	const registered = useSyncExternalStore(commandRegistry.subscribe, commandRegistry.list, commandRegistry.list);
	const builtins = useMemo(builtinCommands, []);
	const [query, setQuery] = useState("");
	const [recent, setRecent] = useState(readRecent);
	const [active, setActive] = useState(0);
	const listId = useId();

	const groups = useMemo<CommandGroup[]>(() => {
		const ranked = rankCommands([...registered, ...builtins], query, ctx, recent);
		const player = playerCommand(query);
		if (!player) return ranked;
		const entry = { group: player.group, commands: [player] };
		// A UserId (digits) is a player for sure; a pid-like word goes first only when nothing else matches.
		return /^\s*\d+\s*$/.test(query) || ranked.length === 0 ? [entry, ...ranked] : [...ranked, entry];
		// ctx changes every render; what the list depends on is listed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [registered, builtins, query, recent, ctx.role, ctx.cookieSession, ctx.filtersOn, ctx.theme, ctx.pathname, ctx.search]);
	const flat = useMemo(() => groups.flatMap((g) => g.commands), [groups]);
	const current = Math.min(active, Math.max(flat.length - 1, 0));
	const optionId = (i: number) => `${listId}-o${i}`;

	useEffect(() => setActive(0), [query]);
	useEffect(() => {
		document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [current]);

	const run = (command: Command | undefined) => {
		if (!command) return;
		if (!command.id.startsWith("player:")) setRecent(pushRecent(command.id, recent));
		close();
		void Promise.resolve()
			.then(() => command.run(ctx))
			.catch(() => {
				// a failed clipboard write or sign-out: nothing to show here
			});
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!flat.length) return;
			const step = e.key === "ArrowDown" ? 1 : -1;
			setActive((current + step + flat.length) % flat.length);
		} else if (e.key === "Home" && flat.length) {
			e.preventDefault();
			setActive(0);
		} else if (e.key === "End" && flat.length) {
			e.preventDefault();
			setActive(flat.length - 1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			run(flat[current]);
		}
	};

	let index = -1;
	return (
		<>
			<div className="flex items-center gap-2 border-b px-3">
				<Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				<input
					autoFocus
					role="combobox"
					aria-expanded
					aria-controls={listId}
					aria-activedescendant={flat.length ? optionId(current) : undefined}
					aria-autocomplete="list"
					aria-label="Search pages and commands"
					placeholder="Search pages and commands, or a pid / UserId…"
					className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					spellCheck={false}
					autoComplete="off"
				/>
			</div>
			<div id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{flat.length === 0 ? <div className="px-3 py-6 text-center text-sm text-muted-foreground">No matching commands.</div> : null}
				{groups.map((g) => (
					<div key={g.group} role="group" aria-label={g.group} className="pb-1">
						<div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground" aria-hidden>
							{g.group}
						</div>
						{g.commands.map((c) => {
							index += 1;
							const i = index;
							const Icon = c.icon;
							return (
								<div
									key={`${g.group}:${c.id}`}
									id={optionId(i)}
									role="option"
									aria-selected={i === current}
									className={cn(
										"flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm select-none",
										i === current ? "bg-accent text-accent-foreground" : "text-foreground",
									)}
									onMouseMove={() => i !== current && setActive(i)}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => run(c)}
								>
									{Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />}
									<span className="min-w-0 flex-1 truncate">{c.title}</span>
									{c.shortcut?.length ? (
										<span className="flex shrink-0 gap-1" aria-hidden>
											{c.shortcut.map((k) => (
												<kbd key={k} className="rounded border bg-muted px-1 font-sans text-[0.65rem] leading-4 text-muted-foreground">
													{k}
												</kbd>
											))}
										</span>
									) : null}
								</div>
							);
						})}
					</div>
				))}
			</div>
			<div className="hidden items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground sm:flex">
				<span>↑↓ to move</span>
				<span>Enter to run</span>
				<span>Esc to close</span>
			</div>
		</>
	);
}
