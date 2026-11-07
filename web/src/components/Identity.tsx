/** pid <-> UserId bits: the profile link, the backfill button, and the top bar's player finder. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, UserSearch } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { PlayerHover } from "@/components/PlayerHover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtInt } from "@/lib/format";

export const profileUrl = (uid: number) => `https://www.roblox.com/users/${uid}/profile`;

/** "UserId 123" linking to the Roblox profile (opens a new tab); with the `pid`, hovering it shows who it is. */
export function UserIdLink({ uid, pid, className }: { uid: number; pid?: string; className?: string }) {
	const link = (
		<a
			href={profileUrl(uid)}
			target="_blank"
			rel="noreferrer noopener"
			aria-label={`UserId ${uid} (Roblox profile)`}
			className={className ?? "inline-flex items-center gap-1 underline-offset-2 hover:underline"}
			title={pid ? undefined : "Roblox profile"}
		>
			<span className="tabular-nums">{uid}</span>
			<ExternalLink className="size-3" />
		</a>
	);
	return pid ? (
		<PlayerHover pid={pid} uid={uid}>
			{link}
		</PlayerHover>
	) : (
		link
	);
}

/** A backfill from the game's DataStore links, when the server can read them (nothing otherwise). */
export function IdentityStatus() {
	const client = useQueryClient();
	const summary = useQuery({ queryKey: ["identity", "summary"], queryFn: ({ signal }) => api.identitySummary(signal), retry: false });
	const [progress, setProgress] = useState<{ added: number; scanned: number } | null>(null);
	const backfill = useMutation({
		mutationFn: async () => {
			let total = { added: 0, scanned: 0 };
			let token: string | undefined;
			do {
				const r = await api.backfillIdentities(token);
				total = { added: total.added + r.added, scanned: total.scanned + r.scanned };
				setProgress(total);
				token = r.nextPageToken;
			} while (token);
			return total;
		},
		onSettled: () => {
			void client.invalidateQueries({ queryKey: ["identity"] });
			void client.invalidateQueries({ queryKey: ["query", "players"] });
		},
	});
	if (summary.isError || !summary.data) return null;
	const canBackfill = summary.data.backfill;
	if (!canBackfill && backfill.isIdle) return null;
	return (
		<div className="space-y-1.5 text-xs text-muted-foreground">
			{canBackfill ? (
				<Button variant="outline" size="xs" onClick={() => backfill.mutate()} disabled={backfill.isPending}>
					{backfill.isPending ? `Backfilling... ${progress ? `${progress.added} added of ${progress.scanned}` : ""}` : "Backfill identities"}
				</Button>
			) : null}
			{backfill.isSuccess ? <p>Backfill done: {fmtInt(backfill.data.added)} added, {fmtInt(backfill.data.scanned)} links read.</p> : null}
			{backfill.isError ? <p className="text-[var(--status-critical)]">{backfill.error.message}</p> : null}
		</div>
	);
}

/** The top bar's "Find player": a pid, part of one, or a UserId; opens the Players page with it. */
export function FindPlayer() {
	const navigate = useNavigate();
	const { search } = useLocation();
	const [text, setText] = useState("");
	const go = () => {
		const value = text.trim();
		if (!value) return;
		const current = new URLSearchParams(search);
		const params = new URLSearchParams();
		for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
		params.set("find", value);
		navigate({ pathname: "/players", search: `?${params.toString()}` });
		setText("");
	};
	return (
		<form
			className="relative hidden sm:block"
			onSubmit={(e) => {
				e.preventDefault();
				go();
			}}
		>
			<UserSearch className="pointer-events-none absolute top-1.5 left-2 size-4 text-muted-foreground" />
			<Input aria-label="Find player (pid or UserId)" placeholder="Find player" className="h-7 w-40 pl-7 text-xs" value={text} onChange={(e) => setText(e.target.value)} />
		</form>
	);
}
