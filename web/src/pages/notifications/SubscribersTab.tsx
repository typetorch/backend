/**
 * The Subscribers tab (owners): who can get notifications, from GET /v1/notify/users. Roblox has no list of opted-in
 * players: the backend learns each one from Roblox's answer to a send. A state per chip (with its count), a search by
 * UserId or a cached name, keyset pages, and a CSV of the current filter.
 */
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { ToggleChip } from "@/components/ToggleChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtTime } from "@/lib/format";
import type { NotifyOptinState, NotifyOptinTotals, NotifyOptinUser } from "@/lib/types";
import { SubscriberBar } from "./shared";

export const SUBSCRIBERS_PAGE = 50;
export const NOTIFY_USERS_COUNTS_KEY = ["notify-users", "counts"] as const;

const STATES: { id: NotifyOptinState; label: string; count: (c: NotifyOptinTotals) => number }[] = [
	{ id: "subscribed", label: "Subscribed", count: (c) => c.subscribed },
	{ id: "not_subscribed", label: "Not subscribed", count: (c) => c.notSubscribed },
	{ id: "unknown", label: "Unknown", count: (c) => c.unknown },
	{ id: "muted", label: "Muted", count: (c) => c.muted },
];

/** The counts alone (the Health tab's bar, the KPI card): one tiny page of the default state. */
export function useOptinCounts(enabled: boolean) {
	return useQuery({ queryKey: NOTIFY_USERS_COUNTS_KEY, queryFn: ({ signal }) => api.notifyUsers({ limit: 1 }, signal).then((v) => v.counts), enabled, retry: false, staleTime: 15_000 });
}

function stateBadge(u: NotifyOptinUser) {
	if (u.muteUntil) return <Badge variant="secondary">muted</Badge>;
	if (u.optin === "subscribed") return <Badge>subscribed</Badge>;
	if (u.optin === "not_subscribed") return <Badge variant="destructive">not subscribed</Badge>;
	return <Badge variant="outline">unknown</Badge>;
}

function saveBlob(name: string, blob: Blob) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SubscribersTab() {
	const [, setParams] = useSearchParams();
	const [state, setState] = useState<NotifyOptinState>("subscribed");
	const [text, setText] = useState("");
	const [q, setQ] = useState("");
	// Keyset paging: the cursors of the pages before (the first page has none)
	const [cursors, setCursors] = useState<string[]>([]);
	const cursor = cursors[cursors.length - 1];
	const users = useQuery({
		queryKey: ["notify-users", state, q, cursor ?? ""],
		queryFn: ({ signal }) => api.notifyUsers({ state, limit: SUBSCRIBERS_PAGE, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) }, signal),
		placeholderData: keepPreviousData,
		retry: false,
	});
	const csv = useMutation({
		mutationFn: () => api.notifyUsersCsv({ state, ...(q ? { q } : {}) }),
		onSuccess: (r) => saveBlob(r.name, r.blob),
	});
	const pickState = (next: NotifyOptinState) => {
		setState(next);
		setCursors([]);
	};
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setQ(text.trim());
		setCursors([]);
	};
	const openPlayer = (uid: number) =>
		setParams((current) => {
			const copy = new URLSearchParams(current);
			copy.set("tab", "inbox");
			copy.set("player", String(uid));
			copy.set("by", "uid");
			return copy;
		});
	const columns: DataColumn<NotifyOptinUser>[] = [
		{
			id: "player",
			header: "Player",
			accessor: (r) => r.name ?? String(r.userId),
			cell: (r) => (
				<button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => openPlayer(r.userId)} title={r.displayName ? `${r.displayName} (UserId ${r.userId})` : `UserId ${r.userId}`}>
					{r.name ? <span>@{r.name}</span> : <span className="font-mono text-xs">{r.userId}</span>}
				</button>
			),
		},
		{ id: "userId", header: "UserId", accessor: (r) => r.userId, cell: (r) => <span className="font-mono text-xs">{r.userId}</span> },
		{ id: "state", header: "State", type: "enum", accessor: (r) => (r.muteUntil ? "muted" : (r.optin ?? "unknown")), cell: stateBadge },
		{
			id: "since",
			header: state === "muted" ? "Muted until" : "Since",
			type: "number",
			accessor: (r) => (state === "muted" ? r.muteUntil : r.optinAt),
			cell: (r) => {
				const at = state === "muted" ? r.muteUntil : r.optinAt;
				return at ? <span title={fmtTime(at)}>{fmtTime(at).slice(0, 10)}</span> : <span className="text-muted-foreground">–</span>;
			},
		},
		{
			id: "lastSeen",
			header: "Last seen",
			type: "number",
			accessor: (r) => r.lastSeen,
			cell: (r) => (r.online ? <Badge variant="outline">online</Badge> : r.lastSeen ? <span title={fmtTime(r.lastSeen)}>{fmtAgo(r.lastSeen)}</span> : <span className="text-muted-foreground">–</span>),
		},
		{ id: "sends", header: "Sent", type: "number", align: "right", title: "real sends kept (120 days), not tests", accessor: (r) => r.sends, cell: (r) => fmtInt(r.sends) },
		{ id: "opened", header: "Opened", type: "number", align: "right", accessor: (r) => r.opened, cell: (r) => fmtInt(r.opened) },
	];
	return (
		<Section title="Who can get notifications" description="Roblox has no list of opted-in players: the backend learns it from Roblox's answer to a send. Unknown = never sent to yet.">
			<QueryState query={users} loadingRows={6}>
				{(view) => (
					<div className="space-y-3">
						<SubscriberBar counts={view.counts} />
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex flex-wrap gap-1.5" role="group" aria-label="Opt-in state">
								{STATES.map((s) => (
									<ToggleChip key={s.id} pressed={state === s.id} onClick={() => pickState(s.id)}>
										{s.label} <span className="tabular-nums opacity-80">{fmtInt(s.count(view.counts))}</span>
									</ToggleChip>
								))}
							</div>
							<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
								<form className="relative min-w-0 flex-1 sm:w-56 sm:flex-none" onSubmit={submit} role="search" aria-label="Find a subscriber">
									<Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
									<Input aria-label="Find a subscriber" className="h-8 pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="UserId or @name" spellCheck={false} />
								</form>
								<Button type="button" variant="outline" size="sm" onClick={() => csv.mutate()} disabled={csv.isPending}>
									<Download />
									Export CSV
								</Button>
							</div>
						</div>
						{csv.isError ? <p className="text-sm text-destructive">{csv.error.message}</p> : null}
						{csv.data?.truncated ? <p className="text-xs text-muted-foreground">The CSV holds the first 10 000 rows.</p> : null}
						<DataTable id="notify-subscribers" label="Subscribers" columns={columns} data={view.users} rowId={(r) => String(r.userId)} density="compact" maxHeight="32rem" pageSize={SUBSCRIBERS_PAGE} search={false} urlSync={false} empty={q ? "No player matches in this state." : "No players in this state."} />
						<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
							<span>
								Page {cursors.length + 1}, {fmtInt(view.users.length)} shown of {fmtInt(STATES.find((s) => s.id === state)?.count(view.counts) ?? 0)}
								{q ? ` (search "${q}")` : ""}. Names come from the server's name cache.
							</span>
							<span className="flex gap-2">
								<Button type="button" variant="outline" size="sm" disabled={!cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))}>
									Previous
								</Button>
								<Button type="button" variant="outline" size="sm" disabled={!view.next} onClick={() => view.next && setCursors((c) => [...c, view.next as string])}>
									Next
								</Button>
							</span>
						</div>
					</div>
				)}
			</QueryState>
		</Section>
	);
}
