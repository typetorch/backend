/**
 * A player link (pid, UserId or name) that says who it is, like the product ids: hovering or focusing it opens a small
 * card with the Roblox headshot, display name, username, UserId and pid (GET /v1/identity/<pid>/profile, the same
 * cached answer as the player detail's). The lookup only runs once a card opens, after a short hover, so passing over a
 * table doesn't ask for every row. The link itself still works as before.
 */
import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { PlayerProfile } from "@/lib/types";

/** Hover this long before the card opens (and the lookup runs). */
const OPEN_MS = 300;
/** Leaving the link for the card (or back) within this keeps it open. */
const CLOSE_MS = 150;

export interface PlayerHoverProps {
	pid: string;
	/** What the row already knows, shown until the lookup answers. */
	uid?: number;
	name?: string;
	displayName?: string;
	children: ReactNode;
}

export function PlayerHover({ pid, uid, name, displayName, children }: PlayerHoverProps) {
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const later = (next: boolean, ms: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(next), ms);
	};
	const enter = (e: { pointerType: string }) => e.pointerType === "mouse" && later(true, open ? 0 : OPEN_MS);
	const leave = (e: { pointerType: string }) => e.pointerType === "mouse" && later(false, CLOSE_MS);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<span
					className="inline-flex max-w-full min-w-0"
					onPointerEnter={enter}
					onPointerLeave={leave}
					onFocus={() => later(true, 0)}
					onBlur={() => later(false, 0)}
					onKeyDown={(e) => {
						if (e.key === "Escape") later(false, 0);
					}}
				>
					{children}
				</span>
			</PopoverAnchor>
			<PopoverContent
				side="top"
				align="start"
				className="w-72 p-2.5"
				data-testid="player-card"
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				onPointerEnter={enter}
				onPointerLeave={leave}
				// The card is portalled, but React still bubbles its clicks to the table row under the link.
				onClick={(e) => e.stopPropagation()}
			>
				<PlayerCard pid={pid} known={{ uid, name, displayName }} />
			</PopoverContent>
		</Popover>
	);
}

function PlayerCard({ pid, known }: { pid: string; known: { uid?: number; name?: string; displayName?: string } }) {
	const q = useQuery({ queryKey: ["player-profile", pid], queryFn: ({ signal }) => api.playerProfile(pid, signal), retry: false, staleTime: 5 * 60_000 });
	const p: PlayerProfile | undefined = q.data;
	const uid = p?.linked ? p.uid : known.uid;
	const name = p?.name ?? known.name;
	const displayName = p?.displayName ?? known.displayName;
	const note = q.isPending
		? "Asking Roblox..."
		: q.isError
			? "Profile unavailable."
			: !p?.linked && uid === undefined
				? "No UserId known for this pid."
				: p?.roblox === "unavailable"
					? "Roblox didn't answer."
					: p?.roblox === "not-found"
						? "Not found on Roblox."
						: null;
	return (
		<div className="flex items-start gap-2.5">
			{p?.avatar ? (
				<img src={p.avatar} alt="" className="size-12 shrink-0 rounded-full border bg-muted object-cover" referrerPolicy="no-referrer" />
			) : (
				<span className="grid size-12 shrink-0 place-items-center rounded-full border bg-muted text-muted-foreground" aria-hidden>
					<UserRound className="size-5" />
				</span>
			)}
			<dl className="flex min-w-0 flex-col gap-0.5 text-xs">
				<dt className="sr-only">Name</dt>
				<dd className="truncate text-sm font-medium leading-tight">{displayName ?? name ?? "Unknown player"}</dd>
				{name ? (
					<>
						<dt className="sr-only">Username</dt>
						<dd className="truncate text-muted-foreground">@{name}</dd>
					</>
				) : null}
				<dt className="sr-only">UserId</dt>
				<dd className="tabular-nums">{uid !== undefined ? `UserId ${uid}` : <span className="text-muted-foreground">UserId not linked</span>}</dd>
				<dt className="sr-only">pid</dt>
				<dd className="break-all font-mono text-[11px] text-muted-foreground">{pid}</dd>
				{note ? <dd className="text-muted-foreground">{note}</dd> : null}
			</dl>
		</div>
	);
}
