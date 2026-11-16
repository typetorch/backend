/**
 * The Players tab (op `players`): who is in the server, dev or not by the kernel's rule, ping, account age and how their
 * client start went. "Logs" opens that player's client logs in the Logs tab. Each UserId is mapped to its pid (identity
 * rows), so the name links to the Players page with the hover card, and the analytics `players` query (all time) adds
 * the current session's length, the session count and the total playtime.
 */
import { useQueries } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { PlayerPageLink } from "@/components/PlayerLink";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fmtDuration, fmtInt, fmtMinutes, fmtTime } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { RemoteState } from "@/lib/remote-debug";
import type { PlayerSummary, RemotePlayer, RemotePlayers } from "@/lib/types";
import { MEMORY_ONLY, RemoteBar, Tone, useDebug, useFirstFetch } from "./shared";

/** How a player's client start went: ok, failed (with why), or no report yet. */
export function clientState(p: RemotePlayer): "ok" | "failed" | "waiting" {
	if (!p.client || p.client.ok === undefined) return "waiting";
	return p.client.ok ? "ok" : "failed";
}

const CLIENT_TONE = { ok: "bg-[var(--status-good)]", failed: "bg-[var(--status-critical)]", waiting: "bg-muted-foreground" } as const;

/** What the analytics know about a player in the server: their pid (when mapped) and their all-time summary. */
interface Known {
	pid?: string;
	stats?: PlayerSummary;
	/** Still asking (identity or analytics). */
	loading: boolean;
}

/** All time: the totals are over every row the warehouse keeps for the player, not the filter bar's range. */
const ALL_TIME = { from: "2000-01-01" };

/** Re-render each 30 s so the running session lengths move. */
function useNow(ms = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return now;
}

function sessionMs(k: Known | undefined, now: number): number | null {
	const start = k?.stats?.lastSessionStart ? Date.parse(k.stats.lastSessionStart) : Number.NaN;
	return Number.isFinite(start) ? Math.max(0, now - start) : null;
}

/** "–" once the answer is in and has nothing, "..." while asking. */
function missing(k: Known | undefined) {
	return <span className="text-muted-foreground">{k?.loading ? "..." : "–"}</span>;
}

function playerColumns(onLogs: (userId: number) => void, ready: boolean, known: (userId: number) => Known | undefined, now: number): DataColumn<RemotePlayer>[] {
	return [
		{
			id: "name",
			header: "Player",
			accessor: (p) => p.displayName ?? p.name,
			searchText: (p) => `${p.name} ${p.displayName ?? ""} ${known(p.userId)?.pid ?? ""}`,
			cell: (p) => {
				const pid = known(p.userId)?.pid;
				if (pid) return <PlayerPageLink row={{ pid, uid: p.userId, name: p.name, displayName: p.displayName }} />;
				return (
					<span className="flex flex-col" title="No pid is mapped to this UserId yet, so there is no Players page to open">
						<span className="font-medium">{p.displayName ?? p.name}</span>
						{p.displayName && p.displayName !== p.name ? <span className="text-xs text-muted-foreground">@{p.name}</span> : null}
					</span>
				);
			},
		},
		// Next to the name, so it is on screen on a phone without scrolling the table sideways.
		{
			id: "actions",
			header: "Logs",
			accessor: () => null,
			sortable: false,
			filter: false,
			searchable: false,
			hideable: false,
			cell: (p) => (
				<Button type="button" variant="ghost" size="xs" onClick={() => onLogs(p.userId)} disabled={!ready} aria-label={`Client logs of ${p.name}`}>
					<ScrollText aria-hidden />
					Logs
				</Button>
			),
		},
		{ id: "userId", header: "UserId", type: "text", accessor: (p) => String(p.userId), className: "font-mono text-xs" },
		{
			id: "dev",
			header: "Access",
			type: "enum",
			accessor: (p) => (p.dev ? (p.role ?? "dev") : "player"),
			cell: (p) => <span title={p.reason}>{p.dev ? (p.role ?? "dev") : "player"}</span>,
		},
		{ id: "ping", header: "Ping", hint: "ms", type: "number", firstSort: "desc", accessor: (p) => p.pingMs ?? null, cell: (p) => fmtInt(p.pingMs) },
		{ id: "accountAge", header: "Account age", hint: "days", type: "number", accessor: (p) => p.accountAge ?? null, cell: (p) => fmtInt(p.accountAge) },
		{
			id: "session",
			header: "Session",
			title: "How long the current session has run: since the first row of their latest session the warehouse has",
			type: "number",
			firstSort: "desc",
			accessor: (p) => sessionMs(known(p.userId), now),
			cell: (p) => {
				const k = known(p.userId);
				const ms = sessionMs(k, now);
				if (ms === null) return missing(k);
				return <span title={`Started ${fmtTime(k?.stats?.lastSessionStart)} UTC`}>{fmtDuration(ms)}</span>;
			},
			format: (_v, p) => {
				const ms = sessionMs(known(p.userId), now);
				return ms === null ? "" : fmtDuration(ms);
			},
		},
		{
			id: "sessions",
			header: "Sessions",
			title: "Sessions all time, this one included",
			type: "number",
			firstSort: "desc",
			accessor: (p) => known(p.userId)?.stats?.sessions ?? null,
			cell: (p) => {
				const k = known(p.userId);
				return k?.stats ? <span title={`First seen ${fmtTime(k.stats.firstSeen)} UTC`}>{fmtInt(k.stats.sessions)}</span> : missing(k);
			},
		},
		{
			id: "playtime",
			header: "Total playtime",
			title: "Playtime all time, this session included",
			type: "number",
			firstSort: "desc",
			accessor: (p) => known(p.userId)?.stats?.playtimeMinutes ?? null,
			cell: (p) => {
				const k = known(p.userId);
				return k?.stats ? fmtMinutes(k.stats.playtimeMinutes) : missing(k);
			},
			format: (_v, p) => fmtMinutes(known(p.userId)?.stats?.playtimeMinutes),
		},
		{
			id: "client",
			header: "Client start",
			type: "enum",
			order: ["failed", "waiting", "ok"],
			options: ["failed", "waiting", "ok"],
			accessor: (p) => clientState(p),
			cell: (p) => (
				<span title={p.client?.error ?? (p.client?.generation ? `generation ${p.client.generation}` : undefined)}>
					<Tone tone={CLIENT_TONE[clientState(p)]}>{clientState(p)}</Tone>
				</span>
			),
		},
	];
}

export function PlayersTab({ active, players, onLogs }: { active: boolean; players: RemoteState<RemotePlayers> & { run: () => Promise<unknown> }; onLogs: (userId: number) => void }) {
	const { ready } = useDebug();
	const run = players.run;
	useFirstFetch(active && ready, run);
	const list = useMemo(() => players.data?.players ?? [], [players.data]);
	const known = useKnown(list);
	const now = useNow();
	const columns = useMemo(() => playerColumns(onLogs, ready, known, now), [onLogs, ready, known, now]);
	return (
		<div className="space-y-3">
			<RemoteBar state={players} onFetch={() => void run()}>
				{players.data ? (
					<span className="text-xs text-muted-foreground tabular-nums">
						{fmtInt(list.length)} / {fmtInt(players.data.max)} players
					</span>
				) : null}
			</RemoteBar>
			{players.data ? (
				<DataTable
					id="server-players"
					label="Players in this server"
					columns={columns}
					data={list}
					rowId={(p) => String(p.userId)}
					defaultSort={[{ id: "name", desc: false }]}
					empty={<EmptyState>Nobody is in this server.</EmptyState>}
					{...MEMORY_ONLY}
				/>
			) : null}
		</div>
	);
}

/** UserId -> pid (most recently seen first, one cached lookup per UserId), then one all-time `players` query for them. */
function useKnown(list: readonly RemotePlayer[]): (userId: number) => Known | undefined {
	const ids = useQueries({
		queries: list.map((p) => ({
			queryKey: ["identity-uid", p.userId],
			queryFn: ({ signal }: { signal: AbortSignal }) => api.identity({ uid: p.userId }, signal),
			staleTime: 10 * 60_000,
			retry: false,
		})),
	});
	const pidOf = new Map<number, string>();
	list.forEach((p, i) => {
		const pid = ids[i]?.data?.[0]?.pid;
		if (pid) pidOf.set(p.userId, pid);
	});
	const idsPending = ids.some((q) => q.isPending);
	const pids = [...new Set(pidOf.values())].sort();
	const stats = useAnalytics("players", { pids, limit: Math.max(1, pids.length) }, { enabled: pids.length > 0, filters: ALL_TIME, keepPrevious: true });
	const byPid = useMemo(() => new Map((stats.data?.players ?? []).map((s) => [s.pid, s])), [stats.data]);
	const statsPending = pids.length > 0 && stats.isPending;
	const mapKey = [...pidOf].map(([u, p]) => `${u}:${p}`).join(",");
	// pidOf is rebuilt each render; mapKey stands for its contents.
	return useMemo(() => {
		const map = new Map(mapKey ? mapKey.split(",").map((e) => e.split(":") as [string, string]) : []);
		return (userId: number) => {
			const pid = map.get(String(userId));
			return { pid, stats: pid ? byPid.get(pid) : undefined, loading: idsPending || statsPending };
		};
	}, [mapKey, byPid, idsPending, statsPending]);
}
