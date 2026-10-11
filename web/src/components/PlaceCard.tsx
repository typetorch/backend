/**
 * The game's place card at the top of the sidebar: its icon, name and live player count (GET /v1/place, asked from Roblox
 * by the backend), the whole card a link to the game on roblox.com in a new tab. Hidden while the backend knows no place;
 * a placeholder icon and no count while Roblox doesn't answer. `PlaceIconLink` is the icon-only version (the phone header).
 * `usePageTitle` names the browser tab "<page> | <place name>".
 */
import { useQuery } from "@tanstack/react-query";
import { Gamepad2 } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "cn";
import { api } from "@/lib/api";
import { fmtInt } from "@/lib/format";
import type { PlaceCardInfo } from "@/lib/types";

type Place = Extract<PlaceCardInfo, { configured: true }>;

/** Only a link to the game page on www.roblox.com (the backend builds it; checked again here). */
function gameUrl(place: Place): string | undefined {
	return place.url && /^https:\/\/www\.roblox\.com\/games\/\d{1,20}$/.test(place.url) ? place.url : undefined;
}

/** Only an https icon on Roblox's CDN (what the CSP allows). */
function iconUrl(place: Place): string | undefined {
	if (!place.icon) return undefined;
	try {
		const u = new URL(place.icon);
		return u.protocol === "https:" && u.hostname.endsWith(".rbxcdn.com") ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** The place, or undefined while loading, failed or not configured. Refreshed every minute (the backend caches 60 s). */
export function usePlace(): Place | undefined {
	const q = useQuery({ queryKey: ["place"], queryFn: ({ signal }) => api.place(signal), refetchInterval: 60_000, staleTime: 30_000, retry: false });
	return q.data?.configured ? q.data : undefined;
}

function PlaceIcon({ place, className }: { place: Place; className?: string }) {
	const src = iconUrl(place);
	return src ? (
		<img src={src} alt="" className={cn("shrink-0 rounded-md bg-muted object-cover", className)} referrerPolicy="no-referrer" />
	) : (
		<span className={cn("grid shrink-0 place-items-center rounded-md bg-muted text-muted-foreground", className)} aria-hidden>
			<Gamepad2 className="size-1/2" />
		</span>
	);
}

function Wrapper({ place, className, label, children }: { place: Place; className: string; label: string; children: ReactNode }) {
	const href = gameUrl(place);
	return href ? (
		<a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} className={className}>
			{children}
		</a>
	) : (
		<div className={className} title={place.name ?? undefined}>
			{children}
		</div>
	);
}

export function PlaceCard() {
	const place = usePlace();
	if (!place) return null;
	const name = place.name ?? "Your game";
	return (
		<Wrapper
			place={place}
			label={`${name} on Roblox (opens in a new tab)`}
			className="flex items-center gap-3 rounded-lg border border-sidebar-border bg-sidebar-foreground/[0.03] p-2 outline-none transition-colors hover:bg-sidebar-foreground/5 focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
		>
			<PlaceIcon place={place} className="size-14" />
			<span className="flex min-w-0 flex-col gap-1">
				<span className="line-clamp-2 text-sm font-medium leading-tight text-sidebar-foreground">{name}</span>
				{place.playing !== null ? (
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="place-live">
						<span className="size-1.5 shrink-0 rounded-full bg-[var(--status-good)]" aria-hidden />
						{fmtInt(place.playing)} live
					</span>
				) : null}
			</span>
		</Wrapper>
	);
}

/** The icon-only card (the phone header, where the sidebar is a drawer). */
export function PlaceIconLink({ className }: { className?: string }) {
	const place = usePlace();
	if (!place) return null;
	const name = place.name ?? "Your game";
	const live = place.playing !== null ? `, ${fmtInt(place.playing)} live` : "";
	return (
		<Wrapper place={place} label={`${name}${live} on Roblox (opens in a new tab)`} className={cn("shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60", className)}>
			<PlaceIcon place={place} className="size-7" />
		</Wrapper>
	);
}

/** The browser tab: "<page> | <place name>" once the place is known; the page's own title otherwise. */
export function usePageTitle(page: string | undefined): void {
	const place = usePlace();
	const name = place?.name;
	useEffect(() => {
		if (!name) return;
		const before = document.title;
		document.title = page ? `${page} | ${name}` : name;
		return () => {
			document.title = before;
		};
	}, [page, name]);
}
