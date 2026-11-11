/**
 * The Inbox tab (owners): the newest sends of everyone (GET /v1/notify/recent, live every 15 s) as a feed with filter
 * chips and a search, a side panel for the picked send (its player's consent, this send's request / answer and join
 * data, earlier sends, intents) and the full player view (the Player panel, `?player=`) under it.
 */
import { useQuery } from "@tanstack/react-query";
import { Search, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import { EmptyState, KeyValue, LoadingBlock, QueryState, Section } from "@/components/common";
import { JoinData } from "@/components/player-detail/JoinData";
import { ToggleChip } from "@/components/ToggleChip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtTime, plural } from "@/lib/format";
import type { NotifyRecentSend, NotifyStatus, NotifyUserSend, NotifyUserView } from "@/lib/types";
import { PlayerPanel, SendDetail, Who } from "./PlayerPanel";
import { fillText, initials } from "./shared";

export const RECENT_LIMIT = 200;

export type SendFilter = "all" | "opened" | "unopened" | "failed" | "queued" | "dry" | "test";
const SEND_FILTERS: [SendFilter, string][] = [
	["all", "All"],
	["opened", "Opened"],
	["unopened", "Not opened"],
	["failed", "Failed"],
	["queued", "Queued"],
	["dry", "Dry run"],
	["test", "Test"],
];
type ConsentFilter = "subscribed" | "not_subscribed" | null;

export function sendMatches(s: Pick<NotifyUserSend, "status" | "openedAt" | "test">, f: SendFilter): boolean {
	switch (f) {
		case "opened":
			return s.openedAt !== null;
		case "unopened":
			return s.status === "sent" && s.openedAt === null;
		case "failed":
			return s.status === "failed" || s.status === "cancelled";
		case "queued":
			return s.status === "planned" || s.status === "sending";
		case "dry":
			return s.status === "dry";
		case "test":
			return s.test;
		default:
			return true;
	}
}

/** What the feed shows for a send: opened beats its status; planned / sending read as queued. */
export function sendLabel(s: Pick<NotifyUserSend, "status" | "openedAt">): { text: string; tone: "default" | "secondary" | "destructive" | "outline" } {
	if (s.openedAt !== null) return { text: "opened", tone: "default" };
	if (s.status === "failed") return { text: "failed", tone: "destructive" };
	if (s.status === "cancelled") return { text: "cancelled", tone: "secondary" };
	if (s.status === "planned" || s.status === "sending") return { text: "queued", tone: "outline" };
	if (s.status === "dry") return { text: "dry run", tone: "secondary" };
	return { text: "sent", tone: "outline" };
}

const who = (s: NotifyRecentSend) => (s.name ? `@${s.name}` : `UserId ${s.userId}`);

function Feed({ sends, texts, selected, onSelect }: { sends: NotifyRecentSend[]; texts: Map<string, string | undefined>; selected: string | null; onSelect(nid: string): void }) {
	return (
		<ul className="max-h-[36rem] divide-y overflow-y-auto rounded-lg border" aria-label="Recent notifications">
			{sends.map((s) => {
				const label = sendLabel(s);
				const text = fillText(texts.get(s.kind), s.params);
				const at = s.sentAt ?? s.plannedAt;
				return (
					<li key={s.nid}>
						<button
							type="button"
							aria-label={`${who(s)} ${s.kind} ${label.text}`}
							aria-pressed={s.nid === selected}
							onClick={() => onSelect(s.nid)}
							className={cn("flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none", s.nid === selected && "bg-muted")}
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground" aria-hidden>
								{initials(s.name, s.userId)}
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex flex-wrap items-baseline gap-x-1.5">
									<span className={cn("font-medium", !s.name && "font-mono text-xs")}>{s.name ? `@${s.name}` : s.userId}</span>
									<span className="font-mono text-xs text-muted-foreground">{s.kind}</span>
									{s.test ? (
										<Badge variant="outline" className="h-4 px-1.5 text-[10px]">
											test
										</Badge>
									) : null}
								</span>
								{text ? <span className="block truncate text-xs text-muted-foreground">{text}</span> : null}
							</span>
							<span className="flex shrink-0 flex-col items-end gap-0.5">
								<Badge variant={label.tone}>{label.text}</Badge>
								{at ? (
									<span className="text-[11px] text-muted-foreground tabular-nums" title={fmtTime(at)}>
										{fmtAgo(at)}
									</span>
								) : null}
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** The picked send and its player, from GET /v1/notify/user (the same view as the full player panel, cut down). */
function SidePanel({ send, onOpenPlayer }: { send: NotifyRecentSend; onOpenPlayer(uid: number): void }) {
	const q = useQuery({ queryKey: ["notify-user", { uid: String(send.userId) }], queryFn: ({ signal }) => api.notifyUser({ uid: String(send.userId) }, signal), retry: false });
	return (
		<div className="space-y-3 rounded-lg border p-3" role="region" aria-label="Selected send">
			{q.isPending ? (
				<LoadingBlock rows={4} />
			) : q.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not load this player</AlertTitle>
					<AlertDescription>
						<p className="break-words">{q.error.message}</p>
					</AlertDescription>
				</Alert>
			) : (
				<SideDetail view={q.data} send={send} />
			)}
			<Button type="button" variant="outline" size="sm" className="w-full" onClick={() => onOpenPlayer(send.userId)}>
				<UserRound />
				Open full player view
			</Button>
		</div>
	);
}

function SideDetail({ view, send }: { view: NotifyUserView; send: NotifyRecentSend }) {
	const s = view.state;
	const full = view.sends.find((x) => x.nid === send.nid) ?? send;
	const open = view.events?.opens?.find((o) => o.nid === send.nid);
	const earlier = view.sends.filter((x) => x.nid !== send.nid).slice(0, 5);
	const pending = view.intents.filter((i) => i.status === "pending").slice(0, 5);
	return (
		<div className="space-y-3">
			<div className="space-y-0.5">
				<Who view={view} />
				<p className="text-xs text-muted-foreground">
					UserId {view.userId}
					{s ? ` · ${s.online ? "online" : "offline"}` : ""}
					{s?.lastSeen ? ` · seen ${fmtAgo(s.lastSeen)}` : ""}
				</p>
			</div>
			<div className="flex flex-wrap gap-1.5" aria-label="Consent">
				{s?.optin === "subscribed" ? (
					<Badge>Subscribed{s.optinAt ? ` since ${fmtTime(s.optinAt).slice(0, 10)}` : ""}</Badge>
				) : s?.optin === "not_subscribed" ? (
					<Badge variant="destructive">Not subscribed</Badge>
				) : (
					<Badge variant="outline">Opt-in unknown</Badge>
				)}
				{s?.muted && s.muteUntil ? <Badge variant="secondary">muted until {fmtTime(s.muteUntil).slice(0, 10)}</Badge> : null}
				{s?.unopened ? <Badge variant="secondary">{plural(s.unopened, "unopened")}</Badge> : null}
				{view.prefs?.off.map((k) => (
					<Badge key={k} variant="secondary">
						{k} off in game
					</Badge>
				))}
			</div>
			<div className="space-y-1">
				<h3 className="text-sm font-medium">This send</h3>
				<KeyValue label="Kind">
					<span className="font-mono">{full.kind}</span>
					{full.template ? <span className="font-mono text-muted-foreground"> · {full.template}</span> : null}
				</KeyValue>
				<KeyValue label="Sent">{full.sentAt ? fmtTime(full.sentAt) : `not yet (${full.status})`}</KeyValue>
				<KeyValue label="Opened">{full.openedAt ? `${fmtTime(full.openedAt)}${full.playedSecs !== null ? `, played ${fmtInt(Math.round(full.playedSecs / 60))} min` : ""}` : "no"}</KeyValue>
				<KeyValue label="nid">
					<span className="font-mono text-xs">{full.nid}</span>
				</KeyValue>
				<details className="rounded-md border">
					<summary className="cursor-pointer px-3 py-1.5 text-xs font-medium">Request, answer and join data</summary>
					<div className="space-y-2 p-2">
						<SendDetail send={full} />
						{open?.jd ? <JoinData jd={open.jd} label="Join data of the opening session" /> : null}
					</div>
				</details>
			</div>
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Earlier</h3>
				{earlier.length ? (
					<ul className="space-y-0.5 text-xs">
						{earlier.map((e) => (
							<li key={e.nid} className="flex justify-between gap-2">
								<span className="font-mono">{e.kind}</span>
								<span className="text-muted-foreground">
									{fmtTime(e.sentAt ?? e.plannedAt).slice(0, 10)} · {sendLabel(e).text}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">No other sends.</p>
				)}
			</div>
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Intents</h3>
				{pending.length ? (
					<ul className="space-y-0.5 text-xs">
						{pending.map((i) => (
							<li key={`${i.kind}|${i.key}`} className="flex justify-between gap-2">
								<span className="font-mono">
									{i.kind}
									{i.key ? ` · ${i.key}` : ""}
								</span>
								<span className="text-muted-foreground">{i.planned ? "planned" : i.at ? `from ${fmtTime(i.at)}` : "pending"}</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">Nothing pending.</p>
				)}
			</div>
		</div>
	);
}

export function InboxTab({ kind, status }: { kind: string; status: NotifyStatus | undefined }) {
	const [, setParams] = useSearchParams();
	const [filter, setFilter] = useState<SendFilter>("all");
	const [consent, setConsent] = useState<ConsentFilter>(null);
	const [text, setText] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const q = useQuery({ queryKey: ["notify-recent", kind], queryFn: ({ signal }) => api.notifyRecent({ limit: RECENT_LIMIT, ...(kind ? { kind } : {}) }, signal), refetchInterval: 15_000, retry: false });
	const texts = useMemo(() => new Map((status?.kinds ?? []).map((k) => [k.kind, k.text])), [status]);
	const openPlayer = (uid: number) => {
		setParams((current) => {
			const copy = new URLSearchParams(current);
			copy.set("player", String(uid));
			copy.set("by", "uid");
			return copy;
		});
		requestAnimationFrame(() => document.getElementById("notify-player-panel")?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
	};
	const needle = text.trim().toLowerCase().replace(/^@/, "");
	const shown = (q.data?.sends ?? []).filter(
		(s) =>
			sendMatches(s, filter) &&
			(consent === null || s.optin === consent) &&
			(!needle || String(s.userId).includes(needle) || s.nid.toLowerCase().includes(needle) || (s.name ?? "").toLowerCase().includes(needle) || (s.displayName ?? "").toLowerCase().includes(needle)),
	);
	const pick = shown.find((s) => s.nid === selected) ?? (q.data?.sends ?? []).find((s) => s.nid === selected);
	return (
		<div className="space-y-4">
			<Section
				title="Inbox"
				description={`The newest ${RECENT_LIMIT} sends of everyone${kind ? ` (kind ${kind})` : ""}, live (every 15 s). Pick one to see its player and Roblox's answer.`}
				actions={q.data ? <Badge variant="outline">{plural(q.data.sends.length, "send")}</Badge> : undefined}
			>
				<div className="space-y-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter sends">
							{SEND_FILTERS.map(([id, label]) => (
								<ToggleChip key={id} pressed={filter === id} onClick={() => setFilter(id)}>
									{label}
								</ToggleChip>
							))}
							<span className="px-1 text-muted-foreground" aria-hidden>
								|
							</span>
							<ToggleChip pressed={consent === "subscribed"} onClick={() => setConsent((c) => (c === "subscribed" ? null : "subscribed"))}>
								Subscribers
							</ToggleChip>
							<ToggleChip pressed={consent === "not_subscribed"} onClick={() => setConsent((c) => (c === "not_subscribed" ? null : "not_subscribed"))}>
								Not subscribed
							</ToggleChip>
						</div>
						<div className="relative w-full sm:w-64">
							<Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
							<Input aria-label="Search sends" className="h-8 pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Player, UserId or nid" spellCheck={false} />
						</div>
					</div>
					<QueryState query={q} loadingRows={4} isEmpty={(d) => d.sends.length === 0} empty="Nothing planned or sent yet.">
						{() => (
							<div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
								<div className="min-w-0 space-y-2">
									{shown.length ? (
										<Feed sends={shown} texts={texts} selected={pick?.nid ?? null} onSelect={(nid) => setSelected((s) => (s === nid ? null : nid))} />
									) : (
										<EmptyState>No send matches.</EmptyState>
									)}
									{/^\d{1,19}$/.test(needle) && !shown.length ? (
										<Button type="button" variant="outline" size="sm" onClick={() => openPlayer(Number(needle))}>
											<UserRound />
											Open player {needle}
										</Button>
									) : null}
								</div>
								{pick ? <SidePanel key={pick.nid} send={pick} onOpenPlayer={openPlayer} /> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Pick a send to see its player, the request and Roblox's answer.</p>}
							</div>
						)}
					</QueryState>
				</div>
			</Section>
			<PlayerPanel />
		</div>
	);
}
