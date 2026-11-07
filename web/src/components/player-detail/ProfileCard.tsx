/**
 * The top of the player detail: the Roblox headshot, display name and username (looked up by the backend), the UserId and
 * the pid, then first / last seen, sessions, spending and playtime per day over the page's date range. Without a UserId it
 * says "not linked"; when Roblox doesn't answer it still shows the UserId.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import { Bell, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { UserIdLink } from "@/components/Identity";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { isReadOnly, useAuth } from "@/lib/auth";
import { fmtInt, fmtMinutes, fmtTime } from "@/lib/format";
import type { PlayerProfile, PlayerStatsResult } from "@/lib/types";

function Avatar({ url, name }: { url: string | null | undefined; name: string }) {
	if (url) return <img src={url} alt={`${name}, Roblox avatar`} className="size-16 shrink-0 rounded-full border bg-muted object-cover" referrerPolicy="no-referrer" loading="lazy" />;
	return (
		<div className="flex size-16 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground" aria-hidden>
			<UserRound className="size-7" />
		</div>
	);
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
	return (
		<div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-sm font-medium tabular-nums">{children}</dd>
		</div>
	);
}

/** What the card says about the Roblox lookup, in a few words. */
function lookupNote(profile: UseQueryResult<PlayerProfile, Error>): ReactNode {
	if (profile.isError) return <Badge variant="outline">profile unavailable</Badge>;
	const p = profile.data;
	if (!p) return null;
	if (!p.linked) return <Badge variant="secondary">not linked</Badge>;
	if (p.roblox === "unavailable") return <Badge variant="outline">Roblox didn't answer</Badge>;
	if (p.roblox === "not-found") return <Badge variant="outline">not found on Roblox</Badge>;
	return null;
}

export function ProfileCard({
	pid,
	profile,
	stats,
	statsLoading,
	range,
}: {
	pid: string;
	profile: UseQueryResult<PlayerProfile, Error>;
	stats: PlayerStatsResult | undefined;
	statsLoading: boolean;
	/** The page's date range in words ("last 30 days (UTC)"). */
	range: string;
}) {
	const p = profile.data;
	const uid = p?.linked ? p.uid : undefined;
	const title = p?.displayName ?? p?.name ?? (uid !== undefined ? `UserId ${uid}` : "Player");
	const t = stats?.totals;
	// The player's notifications (consent, sends, intents) are an owner route: the read-only role doesn't get the link.
	const owner = !isReadOnly(useAuth());
	const value = (v: ReactNode) => (statsLoading ? <Skeleton className="mt-1 h-4 w-16" /> : v);
	return (
		<div className="space-y-4">
			<div className="flex items-start gap-4">
				{profile.isPending ? <Skeleton className="size-16 shrink-0 rounded-full" /> : <Avatar url={p?.avatar} name={title} />}
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						{profile.isPending ? <Skeleton className="h-6 w-40" /> : <h2 className="text-lg leading-tight font-semibold tracking-tight break-words">{title}</h2>}
						{lookupNote(profile)}
					</div>
					{p?.name ? <p className="text-sm text-muted-foreground">@{p.name}</p> : null}
					{owner ? (
						<Link to={`/notifications?player=${encodeURIComponent(pid)}&by=pid`} className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline">
							<Bell className="size-3" />
							Notifications
						</Link>
					) : null}
					<p className="text-xs text-muted-foreground">Date range: {range}</p>
				</div>
			</div>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 xl:grid-cols-8">
				<Field label="UserId">
					{uid !== undefined ? (
						<UserIdLink uid={uid} className="inline-flex items-center gap-1 underline-offset-2 hover:underline" />
					) : profile.isPending ? (
						<Skeleton className="mt-1 h-4 w-20" />
					) : (
						<span className="font-normal text-muted-foreground">not linked</span>
					)}
				</Field>
				<Field label="pid" wide>
					<span className="font-mono text-xs break-all">{pid}</span>
				</Field>
				<Field label="First seen">{value(<span className="font-mono text-xs">{fmtTime(t?.firstSeen)}</span>)}</Field>
				<Field label="Last seen">{value(<span className="font-mono text-xs">{fmtTime(t?.lastSeen)}</span>)}</Field>
				<Field label="Sessions">{value(fmtInt(t?.sessions))}</Field>
				<Field label="Total spending">{value(`${fmtInt(t?.robux)} Robux`)}</Field>
				<Field label="Avg playtime / day">{value(fmtMinutes(t?.playtimePerDayMinutes))}</Field>
			</dl>
		</div>
	);
}
