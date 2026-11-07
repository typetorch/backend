/**
 * The Notifications page's Player panel (owners): one player's notifications from GET /v1/notify/user. Search by a UserId,
 * a pid or a username / display name the server's name cache knows; the search lives in the URL (`player`, and `by` when
 * it isn't guessed) so a link can open it (the player detail links here with `?player=<pid>&by=pid`).
 *
 * Shows who it is, the consent the backend learned (opt-in, mute, the kinds the player switched off in the game, the
 * game's prompt rows and the inferred answers), every
 * send with its opens and plays, and the intents (pending and past).
 */
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { EmptyState, KeyValue, LoadingBlock, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { UserIdLink } from "@/components/Identity";
import { JoinData } from "@/components/player-detail/JoinData";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtTime, shortId } from "@/lib/format";
import type { NotifyUserEvent, NotifyUserIntent, NotifyUserLookup, NotifyUserSend, NotifyUserView } from "@/lib/types";

export type LookupBy = "auto" | "uid" | "pid" | "name";
const BY_LABELS: Record<LookupBy, string> = { auto: "Guess", uid: "UserId", pid: "pid", name: "Name" };
const isBy = (v: string | null): v is LookupBy => v === "auto" || v === "uid" || v === "pid" || v === "name";

/**
 * What to ask the server: digits are a UserId; a value with "-" or longer than 20 characters (a Roblox username's limit)
 * is a pid; anything else a username or display name. `by` overrides the guess. Null when the value can't be one.
 */
export function playerLookup(value: string, by: LookupBy = "auto"): NotifyUserLookup | null {
	const v = value.trim();
	if (!v) return null;
	const kind = by !== "auto" ? by : /^\d{1,19}$/.test(v) ? "uid" : v.includes("-") || v.length > 20 ? "pid" : "name";
	if (kind === "uid") return /^\d{1,19}$/.test(v) ? { uid: v } : null;
	if (kind === "pid") return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? { pid: v } : null;
	return /^[A-Za-z0-9_ .-]{1,64}$/.test(v) ? { name: v } : null;
}

const when = (ms: number | null | undefined) => (ms ? <span title={fmtTime(ms)}>{fmtTime(ms)}</span> : <span className="text-muted-foreground">–</span>);
const mono = (text: string | null | undefined) => (text ? <span className="font-mono">{text}</span> : <span className="text-muted-foreground">–</span>);

const SEND_TONE: Record<NotifyUserSend["status"], "default" | "secondary" | "destructive" | "outline"> = {
	sent: "default",
	dry: "secondary",
	planned: "outline",
	sending: "outline",
	failed: "destructive",
	cancelled: "secondary",
};

export const SEND_COLUMNS: DataColumn<NotifyUserSend>[] = [
	{
		id: "kind",
		header: "Kind",
		type: "enum",
		accessor: (r) => r.kind,
		cell: (r) => (
			<span className="font-mono">
				{r.kind}
				{r.test ? (
					<Badge variant="outline" className="ml-2 font-sans">
						test
					</Badge>
				) : null}
			</span>
		),
	},
	{ id: "plannedAt", header: "Planned", type: "number", accessor: (r) => r.plannedAt, cell: (r) => when(r.plannedAt), format: (v) => fmtTime(v as number | null) },
	{ id: "sentAt", header: "Sent", type: "number", accessor: (r) => r.sentAt, cell: (r) => when(r.sentAt), format: (v) => fmtTime(v as number | null) },
	{
		id: "status",
		header: "Status",
		type: "enum",
		accessor: (r) => r.status,
		cell: (r) => (
			<span className="flex flex-wrap items-center gap-1">
				<Badge variant={SEND_TONE[r.status]}>{r.status}</Badge>
				{r.http || r.code ? <span className="font-mono text-xs text-muted-foreground">{[r.http, r.code].filter(Boolean).join(" ")}</span> : null}
				{r.try > 1 ? <span className="text-xs text-muted-foreground">try {r.try}</span> : null}
			</span>
		),
	},
	{ id: "openedAt", header: "Opened", type: "number", accessor: (r) => r.openedAt, cell: (r) => when(r.openedAt), format: (v) => fmtTime(v as number | null) },
	{ id: "playedSecs", header: "Played", hint: "s", type: "number", align: "right", accessor: (r) => r.playedSecs, cell: (r) => (r.playedSecs === null ? "–" : fmtInt(r.playedSecs)) },
	{ id: "category", header: "Category", accessor: (r) => r.category, cell: (r) => mono(r.category), defaultHidden: true },
	{ id: "nid", header: "nid", accessor: (r) => r.nid, cell: (r) => mono(r.nid), defaultHidden: true },
];

const INTENT_ORDER = ["pending", "sent", "failed", "dropped", "expired", "superseded"] as const;
const INTENT_COLUMNS: DataColumn<NotifyUserIntent>[] = [
	{ id: "kind", header: "Kind", type: "enum", accessor: (r) => r.kind, cell: (r) => mono(r.kind) },
	{ id: "key", header: "Key", accessor: (r) => r.key, cell: (r) => mono(r.key) },
	{
		id: "status",
		header: "Status",
		type: "enum",
		order: INTENT_ORDER,
		accessor: (r) => r.status,
		cell: (r) => (
			<span className="flex flex-wrap items-center gap-1">
				<Badge variant={r.status === "pending" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
				{r.planned ? <span className="text-xs text-muted-foreground">planned</span> : null}
			</span>
		),
	},
	{ id: "at", header: "At", type: "number", accessor: (r) => r.at, cell: (r) => when(r.at), format: (v) => fmtTime(v as number | null) },
	{ id: "until", header: "Until", type: "number", accessor: (r) => r.until, cell: (r) => when(r.until), format: (v) => fmtTime(v as number | null) },
	{ id: "updated", header: "Updated", type: "number", accessor: (r) => r.updated, cell: (r) => when(r.updated), format: (v) => fmtTime(v as number | null), defaultHidden: true },
	{
		id: "params",
		header: "Params",
		accessor: (r) => (r.params ? Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ") : ""),
		cell: (r) => (r.params ? <span className="font-mono text-xs break-all whitespace-normal">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")}</span> : "–"),
	},
];

const EVENT_LABELS: Record<NotifyUserEvent["name"], string> = {
	optin_check: "prompt check",
	optin_shown: "prompt shown",
	optin_closed: "prompt closed",
	optin_inferred: "inferred",
	open: "opened",
	open_bad: "bad open",
	played: "played",
};

const CONSENT_COLUMNS: DataColumn<NotifyUserEvent>[] = [
	{ id: "at", header: "At", accessor: (r) => r.at, cell: (r) => <span className="font-mono text-xs">{fmtTime(r.at)}</span>, format: (v) => fmtTime(v as string) },
	{ id: "name", header: "Row", type: "enum", accessor: (r) => EVENT_LABELS[r.name] ?? r.name },
	{ id: "where", header: "Where", accessor: (r) => r.where, cell: (r) => mono(r.where) },
	{
		id: "result",
		header: "Result",
		accessor: (r) => r.state ?? r.can ?? "",
		cell: (r) =>
			r.name === "optin_inferred" ? (
				<Badge variant={r.state === "subscribed" ? "default" : "secondary"}>{r.state === "not_subscribed" ? "not subscribed" : (r.state ?? "–")}</Badge>
			) : r.can ? (
				<span>{r.can === "true" ? "can prompt" : "can't prompt"}</span>
			) : (
				<span className="text-muted-foreground">–</span>
			),
	},
	{ id: "secs", header: "Up for", hint: "s", type: "number", align: "right", accessor: (r) => r.secs, cell: (r) => (r.secs === null ? "–" : String(r.secs)) },
	{ id: "err", header: "Error", accessor: (r) => r.err, cell: (r) => (r.err ? <span className="font-mono text-xs break-all whitespace-normal text-destructive">{r.err}</span> : "–") },
	{ id: "pid", header: "pid", accessor: (r) => r.pid, cell: (r) => <span className="font-mono text-xs">{shortId(r.pid, 6)}</span>, defaultHidden: true },
];

function Consent({ view }: { view: NotifyUserView }) {
	const s = view.state;
	const rows = (view.events?.rows ?? []).filter((r) => r.name.startsWith("optin_"));
	return (
		<div className="space-y-2">
			<h3 className="text-sm font-medium">Consent</h3>
			<KeyValue label="Switched off">
				{view.prefs?.off.length ? (
					<span className="inline-flex flex-wrap gap-1" aria-label="Kinds switched off">
						{view.prefs.off.map((k) => (
							<Badge key={k} variant="outline" className="font-mono">
								{k}
							</Badge>
						))}
						<span className="text-muted-foreground">set {fmtAgo(view.prefs.updated)}</span>
					</span>
				) : view.prefs ? (
					<span>none (set {fmtAgo(view.prefs.updated)})</span>
				) : (
					<span className="text-muted-foreground">never set</span>
				)}
			</KeyValue>
			{s ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					<KeyValue label="Opt-in">
						{s.optin ? <Badge variant={s.optin === "subscribed" ? "default" : "secondary"}>{s.optin === "subscribed" ? "subscribed" : "not subscribed"}</Badge> : "unknown"}
						{s.optinAt ? <span className="ml-1 text-muted-foreground">learned {fmtAgo(s.optinAt)}</span> : null}
					</KeyValue>
					<KeyValue label="Muted">{s.muted && s.muteUntil ? `until ${fmtTime(s.muteUntil)}` : "no"}</KeyValue>
					<KeyValue label="Online">{s.online ? "yes" : "no"}</KeyValue>
					{s.lastSeen ? <KeyValue label="Last seen">{fmtTime(s.lastSeen)}</KeyValue> : null}
					<KeyValue label="Unopened">{fmtInt(s.unopened)}</KeyValue>
					{s.backoffAt ? <KeyValue label="Backoff since">{fmtTime(s.backoffAt)}</KeyValue> : null}
					{s.cappedUntil ? <KeyValue label="Capped until">{fmtTime(s.cappedUntil)}</KeyValue> : null}
					{s.nextCheck ? <KeyValue label="Next check">{fmtTime(s.nextCheck)}</KeyValue> : null}
					{s.busy ? <KeyValue label="Busy">{s.busy}</KeyValue> : null}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">The sender has no state for this player yet.</p>
			)}
			{rows.length ? (
				<DataTable id="notify-player-consent" label="Prompt and consent rows" columns={CONSENT_COLUMNS} data={rows} rowId={(r) => `${r.t}|${r.pid}|${r.name}|${r.nid ?? ""}`} density="compact" maxHeight="16rem" />
			) : view.events ? (
				<EmptyState>No prompt or consent rows for this player.</EmptyState>
			) : null}
		</div>
	);
}

/** Plans/30: next to each opened send, the opening session's raw join data (the join row carrying the send's nid). */
function Opens({ view }: { view: NotifyUserView }) {
	const byNid = new Map((view.events?.opens ?? []).map((o) => [o.nid, o]));
	const opened = view.sends.filter((s) => s.openedAt !== null && byNid.has(s.nid));
	if (!opened.length) return null;
	return (
		<div className="space-y-1" role="region" aria-label="Opening sessions">
			<h3 className="text-sm font-medium">Opening sessions ({fmtInt(opened.length)})</h3>
			<p className="text-xs text-muted-foreground">What Roblox handed the session each opened notification started (its join row's raw join data).</p>
			<ul className="space-y-2">
				{opened.map((s) => {
					const o = byNid.get(s.nid);
					return (
						<li key={s.nid} className="space-y-1">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
								<span className="font-medium">{s.kind}</span>
								<span className="font-mono text-muted-foreground">{s.nid}</span>
								<span className="text-muted-foreground">opened {when(s.openedAt)}</span>
							</div>
							{o?.jd ? <JoinData jd={o.jd} label="Join data" /> : <p className="text-xs text-muted-foreground">No join data stored for that session.</p>}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export function PlayerView({ view, onPick }: { view: NotifyUserView; onPick(uid: number): void }) {
	const pending = view.intents.filter((i) => i.status === "pending").length;
	return (
		<div className="space-y-4" aria-label="Player notifications" role="region">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span className="font-medium">{view.displayName ?? view.name ?? `UserId ${view.userId}`}</span>
				{view.name ? <span className="text-sm text-muted-foreground">@{view.name}</span> : null}
				<UserIdLink uid={view.userId} className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline" />
				{!view.known ? <Badge variant="outline">no notify rows yet</Badge> : null}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				<KeyValue label={view.pids.length === 1 ? "pid" : "pids"}>
					{view.pids.length ? <span className="font-mono text-xs break-all">{view.pids.join(", ")}</span> : <span className="text-muted-foreground">none known</span>}
				</KeyValue>
				{view.otherMatches?.length ? (
					<KeyValue label="Also named so">
						<span className="flex flex-wrap gap-2">
							{view.otherMatches.map((uid) => (
								<button key={uid} type="button" className="font-mono text-xs underline underline-offset-2" onClick={() => onPick(uid)}>
									{uid}
								</button>
							))}
						</span>
					</KeyValue>
				) : null}
			</div>
			<Consent view={view} />
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Notifications ({fmtInt(view.sends.length)})</h3>
				{view.sends.length ? (
					<DataTable id="notify-player-sends" label="Past notifications" columns={SEND_COLUMNS} data={view.sends} rowId={(r) => r.nid} density="compact" maxHeight="20rem" />
				) : (
					<EmptyState>Nothing planned or sent to this player.</EmptyState>
				)}
			</div>
			<Opens view={view} />
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Intents ({fmtInt(pending)} pending)</h3>
				{view.intents.length ? (
					<DataTable id="notify-player-intents" label="Intents" columns={INTENT_COLUMNS} data={view.intents} rowId={(r) => `${r.kind}|${r.key}|${r.at ?? ""}`} density="compact" maxHeight="16rem" />
				) : (
					<EmptyState>No intents for this player.</EmptyState>
				)}
			</div>
			{view.eventsError ? <p className="text-sm text-muted-foreground">Event rows unavailable: {view.eventsError}</p> : null}
			{view.events?.more ? <p className="text-xs text-muted-foreground">Showing the newest event rows only.</p> : null}
		</div>
	);
}

export function PlayerPanel() {
	const [params, setParams] = useSearchParams();
	const player = params.get("player") ?? "";
	const by: LookupBy = isBy(params.get("by")) ? (params.get("by") as LookupBy) : "auto";
	const [text, setText] = useState(player);
	const [pickBy, setPickBy] = useState<LookupBy>(by);
	const [problem, setProblem] = useState<string | null>(null);
	const lookup = playerLookup(player, by);
	const q = useQuery({ queryKey: ["notify-user", lookup], queryFn: ({ signal }) => api.notifyUser(lookup as NotifyUserLookup, signal), enabled: lookup !== null, retry: false });
	const open = (value: string, nextBy: LookupBy) =>
		setParams((current) => {
			const copy = new URLSearchParams(current);
			if (value) copy.set("player", value);
			else copy.delete("player");
			if (value && nextBy !== "auto") copy.set("by", nextBy);
			else copy.delete("by");
			return copy;
		});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setProblem(null);
		const v = text.trim();
		if (v && !playerLookup(v, pickBy)) return setProblem(pickBy === "uid" ? "A UserId is digits only." : "Letters, digits, _ and - only (names may also have spaces and dots).");
		// The same player again: the URL doesn't change, so ask the server again (Find = refresh)
		if (v === player && pickBy === by && lookup) void q.refetch();
		else open(v, pickBy);
	};
	const pick = (uid: number) => {
		setText(String(uid));
		setPickBy("uid");
		open(String(uid), "uid");
	};
	return (
		<div id="notify-player-panel" className="scroll-mt-4">
		<Section className="min-w-0" title="Player" description="One player's notifications: consent, every send with its opens and plays, the intents. Find them by UserId, pid or a name the server has seen.">
			<div className="space-y-3">
				<form className="flex flex-wrap items-center gap-2" onSubmit={submit} aria-label="Find a player" role="search">
					<Input aria-label="Player" className="h-8 w-full min-w-0 sm:w-72" value={text} onChange={(e) => setText(e.target.value)} placeholder="UserId, pid or username" spellCheck={false} />
					<Select value={pickBy} onValueChange={(v) => setPickBy(v as LookupBy)}>
						<SelectTrigger size="sm" className="w-28" aria-label="Search by">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(BY_LABELS) as LookupBy[]).map((k) => (
								<SelectItem key={k} value={k}>
									{BY_LABELS[k]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button type="submit" size="sm" variant="outline">
						<Search />
						Find
					</Button>
				</form>
				{problem ? <p className="text-sm text-destructive">{problem}</p> : null}
				{!player ? null : !lookup ? (
					<p className="text-sm text-destructive">That is not a UserId, pid or name.</p>
				) : q.isPending ? (
					<LoadingBlock rows={3} />
				) : q.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Could not load this player</AlertTitle>
						<AlertDescription>
							<p className="break-words">{q.error.message}</p>
						</AlertDescription>
					</Alert>
				) : (
					<PlayerView view={q.data} onPick={pick} />
				)}
			</div>
		</Section>
		</div>
	);
}
