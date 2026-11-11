/**
 * The Notifications page (plans/29 "Explorer page"): experience notifications, from the `notify` rows and the backend's
 * live sender. A header (the live status chip with the queue in a popover, dry run, range, kind, Send a test), four KPI
 * cards, and tabs (URL `?tab=`):
 *
 *   - Health: a status sentence, who can get notifications, opened and back-next-day per day, Needs attention.
 *   - Funnel: prompt shown -> subscribed -> sent -> opened -> played 1 min+ -> back next day, insights, sends per day,
 *     the opt-in prompt by spot (`notify-funnel`, `notify-optin`).
 *   - Inbox (owners): the newest sends of everyone with filters and a side panel, and the Player panel (`?player=`).
 *   - Subscribers (owners): the opt-in list (GET /v1/notify/users), CSV.
 *   - Kinds: per kind, its switch, by kind and day.
 *   - Queue & errors: the live queue, failures, planned and skipped by why, the history per hour (`notify-queue`).
 *   - Settings (owners who can edit): the runtime settings `notify.*`, a test send, the kinds' config record.
 *
 * The read-only `web` role sees the analytics only: the status, config, lists and controls are owner routes (403).
 * Only the time range applies (backend rows have no device, artifact or place), so the page has its own range picker.
 */
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Send } from "lucide-react";
import { useSearchParams } from "react-router";
import { ChangeChip } from "@/components/ChangeChip";
import { Metric, QueryState } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { change } from "@/lib/benchmarks";
import { describeRange, isoDate, RANGE_LABELS, type RangePreset } from "@/lib/filters";
import { fmtInt, fmtPct, fmtTime } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { Filters, NotifyHalt, NotifyStatus } from "@/lib/types";
import { attentionItems, NOTIFY_TABS, type NotifyTab } from "./notifications/attention";
import { FunnelTab } from "./notifications/FunnelTab";
import { HealthTab, healthSentence, StatusDot } from "./notifications/HealthTab";
import { InboxTab } from "./notifications/InboxTab";
import { KindsTab } from "./notifications/KindsTab";
import { QueueTab, RightNow } from "./notifications/QueueTab";
import { NOTIFY_STATUS_KEY, SettingsTab } from "./notifications/SettingsTab";
import { SubscribersTab, useOptinCounts } from "./notifications/SubscribersTab";

export { NOTIFY_STATUS_KEY, placeholdersOf, rowsToParams, type ParamRow } from "./notifications/SettingsTab";

const ALL_KINDS = "__all";
const DAY_MS = 86_400_000;
const OWNER_TABS: readonly NotifyTab[] = ["inbox", "subscribers", "settings"];
const TAB_LABELS: Record<NotifyTab, string> = { health: "Health", funnel: "Funnel", inbox: "Inbox", subscribers: "Subscribers", kinds: "Kinds", queue: "Queue & errors", settings: "Settings" };

function HaltedBanner({ status }: { status: NotifyStatus }) {
	const all = status.haltedAll ?? status.halted.find((h) => !h.kind) ?? null;
	const kinds = status.halted.filter((h): h is Extract<NotifyHalt, { why: "bad_template" }> => typeof h.kind === "string" && h.kind !== "");
	const templates = status.haltedTemplates ?? [];
	if (!all && !kinds.length && !templates.length) return null;
	return (
		<div className="space-y-2">
			{all ? (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>Every send stopped</AlertTitle>
					<AlertDescription>
						<p>
							Notifications stopped: Roblox refused the Open Cloud key (401 / 403). Check OPENCLOUD_NOTIFY_KEY's scope (user-notifications) and universe, then turn notifications back
							on.
						</p>
						<p className="text-xs">Since {fmtTime(all.at)}.</p>
					</AlertDescription>
				</Alert>
			) : null}
			{templates.length ? (
				<Alert>
					<CircleAlert />
					<AlertTitle>Templates stopped</AlertTitle>
					<AlertDescription>
						<p>Roblox says these game-supplied templates (message ids) don't exist; sends that use them are dropped.</p>
						<ul className="list-disc pl-4">
							{templates.map((t) => (
								<li key={t.template}>
									<span className="font-mono break-all">{t.template}</span> <span className="text-xs">since {fmtTime(t.at)}</span>
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}
			{kinds.map((h) => (
				<Alert key={h.kind} variant="destructive">
					<CircleAlert />
					<AlertTitle>Kind {h.kind} stopped</AlertTitle>
					<AlertDescription>
						<p>Kind {h.kind} stopped: its template (message id) does not exist on Roblox. Fix the template, push the config, then turn the kind back on.</p>
						<p className="text-xs">Since {fmtTime(h.at)}. Its pending sends wait until then.</p>
					</AlertDescription>
				</Alert>
			))}
		</div>
	);
}

function KindPicker({ kinds, value, onChange }: { kinds: string[]; value: string; onChange(next: string): void }) {
	const items = value && !kinds.includes(value) ? [value, ...kinds] : kinds;
	if (!items.length) return null;
	return (
		<Select value={value || ALL_KINDS} onValueChange={(v) => onChange(v === ALL_KINDS ? "" : v)}>
			<SelectTrigger size="sm" className="w-40" aria-label="Kind">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL_KINDS}>All kinds</SelectItem>
				{items.map((k) => (
					<SelectItem key={k} value={k}>
						{k}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** The range alone (the shell's filter bar is off here: only the range applies to notify rows). */
function RangePicker() {
	const { state, set } = useFilters();
	const today = isoDate(Date.now());
	return (
		<>
			<Select
				value={state.range}
				onValueChange={(v) => {
					const next = v as RangePreset;
					if (next === "custom") set({ range: "custom", from: state.from ?? isoDate(Date.now() - 29 * DAY_MS), to: state.to ?? today });
					else set({ range: next });
				}}
			>
				<SelectTrigger size="sm" className="w-36" aria-label="Date range">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => (
						<SelectItem key={r} value={r}>
							{RANGE_LABELS[r]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{state.range === "custom" ? (
				<span className="flex items-center gap-1">
					<Input type="date" aria-label="From (UTC)" className="h-8 w-36" value={state.from ?? ""} max={state.to ?? today} onChange={(e) => set({ from: e.target.value || undefined })} />
					<span className="text-xs text-muted-foreground">to</span>
					<Input type="date" aria-label="To (UTC, inclusive)" className="h-8 w-36" value={state.to ?? ""} min={state.from} onChange={(e) => set({ to: e.target.value || undefined })} />
				</span>
			) : null}
		</>
	);
}

/** "Sending · 5/s" (or Paused / Stopped), opening the live queue in a popover. */
function StatusChip({ status, onQueue }: { status: NotifyStatus; onQueue(): void }) {
	const level = healthSentence(status, undefined).level;
	const text = status.haltedAll ? "Stopped" : !status.enabled ? "Paused" : `Sending · ${status.bucket.rate}/s`;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" size="sm" aria-label={`${text}: right now`}>
					<StatusDot level={level} />
					{text}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<div className="text-sm font-medium">Right now</div>
				<RightNow status={status} />
				<Button type="button" variant="ghost" size="sm" className="self-start" onClick={onQueue}>
					Queue & errors
				</Button>
			</PopoverContent>
		</Popover>
	);
}

/** The same span right before the range, for the Sent card's change (day presets only). */
function priorRange(range: RangePreset, now = Date.now()): Filters | null {
	if (range === "custom" || range === "1h" || range === "6h") return null;
	const days = Number.parseInt(range, 10);
	if (!Number.isFinite(days)) return null;
	return { from: isoDate(now - (2 * days - 1) * DAY_MS), to: isoDate(now - days * DAY_MS) };
}

export default function Notifications() {
	const { state } = useFilters();
	const [params, setParams] = useSearchParams();
	const readOnly = isReadOnly(useAuth());
	const [kind, setKind] = useParam("kind");
	const options = kind ? { kind } : {};
	const funnel = useAnalytics("notify-funnel", options);
	const prior = priorRange(state.range);
	const before = useAnalytics("notify-funnel", options, { enabled: prior !== null, ...(prior ? { filters: prior } : {}) });
	const optin = useAnalytics("notify-optin");
	const queue = useAnalytics("notify-queue", options);
	const status = useQuery({ queryKey: NOTIFY_STATUS_KEY, queryFn: ({ signal }) => api.notifyStatus(signal), enabled: !readOnly, refetchInterval: 15_000, retry: false });
	const live = status.data;
	// A viewer (or an owner whose browser isn't trusted yet) gets 403: the analytics still show.
	const forbidden = status.error instanceof ApiError && (status.error.status === 403 || status.error.status === 401);
	const owner = !readOnly && !forbidden;
	const counts = useOptinCounts(owner);
	const kinds = [...new Set([...(live?.kinds.map((k) => k.kind) ?? []), ...(funnel.data?.kinds.map((k) => k.kind).filter(Boolean) ?? [])])].sort();

	const rawTab = params.get("tab") as NotifyTab | null;
	const fallback: NotifyTab = params.get("player") && owner ? "inbox" : "health";
	const visible = NOTIFY_TABS.filter((t) => owner || !OWNER_TABS.includes(t));
	const tab: NotifyTab = rawTab && visible.includes(rawTab) && (rawTab !== "settings" || owner) ? rawTab : fallback;
	const goTab = (next: NotifyTab) =>
		setParams((current) => {
			const copy = new URLSearchParams(current);
			if (next === "health") copy.delete("tab");
			else copy.set("tab", next);
			return copy;
		});

	const items = attentionItems({ status: live, queue: queue.data, optin: optin.data });
	const queueIssues = items.filter((i) => i.tab === "queue").length;
	const t = funnel.data?.totals;
	const today = funnel.data?.daily.find((d) => d.date === isoDate(Date.now()))?.sent ?? 0;
	const optinCounts = owner ? counts.data : undefined;

	return (
		<div className="mx-auto w-full max-w-[1480px] space-y-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
					<p className="text-sm text-muted-foreground">Experience notifications, {describeRange(state)}: what was sent, opened and played, who can get them and the sender.</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{live ? <StatusChip status={live} onQueue={() => goTab("queue")} /> : null}
					{live ? <Badge variant={live.dryRun ? "secondary" : "outline"}>{live.dryRun ? "Dry run on" : "Dry run off"}</Badge> : null}
					<RangePicker />
					<KindPicker kinds={kinds} value={kind} onChange={setKind} />
					{owner && live ? (
						<Button type="button" size="sm" onClick={() => goTab("settings")}>
							<Send />
							Send a test
						</Button>
					) : null}
				</div>
			</div>
			{live ? <HaltedBanner status={live} /> : null}
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Metric
					label="Subscribers (known)"
					value={optinCounts ? fmtInt(optinCounts.subscribed) : optin.data ? fmtInt(optin.data.totals.subscribed) : "–"}
					sub={optinCounts ? `+${fmtInt(optinCounts.newThisWeek)} this week` : "learned from sends in this range"}
				/>
				<Metric
					label="Sent"
					value={t ? fmtInt(t.sent) : "–"}
					delta={t && before.data && prior ? <ChangeChip change={change(t.sent, before.data.totals.sent)} against={`the ${Number.parseInt(state.range, 10)} days before`} /> : undefined}
					sub={`${fmtInt(today)} today${t?.tests ? `, +${fmtInt(t.tests)} test` : ""}`}
				/>
				<Metric label="Opened" value={t?.sent ? fmtPct(t.openRate) : "–"} sub={t ? `${fmtInt(t.opened)} opens, ${t.opened ? fmtPct(t.playedRate, 0) : "–"} played 1 min+` : undefined} />
				<Metric label="Came back next day" value={t?.players ? fmtPct(t.returnRate) : "–"} sub={t ? `+${fmtInt(t.assisted)} assisted (back without opening)` : undefined} />
			</div>
			<Tabs value={tab} onValueChange={(v) => goTab(v as NotifyTab)}>
				<div className="-mx-1 overflow-x-auto px-1 pb-1">
					<TabsList aria-label="Notifications sections">
						{visible.map((id) => (
							<TabsTrigger key={id} value={id} className="flex-none px-2.5">
								{TAB_LABELS[id]}
								{id === "queue" && queueIssues ? (
									<Badge variant="secondary" className="h-4 px-1.5 text-[10px]" aria-label={`${queueIssues} open issues`}>
										{queueIssues}
									</Badge>
								) : null}
							</TabsTrigger>
						))}
					</TabsList>
				</div>
				<TabsContent value="health" className="mt-2 space-y-4">
					<HealthTab
						status={live}
						funnel={funnel.data}
						counts={optinCounts ?? (optin.data ? { subscribed: optin.data.totals.subscribed, notSubscribed: optin.data.totals.notSubscribed, unknown: 0 } : undefined)}
						{...(optinCounts ? {} : { countsNote: "Answers learned in this range; the full list is for owners." })}
						items={items}
						goTab={goTab}
						ownerOnly={owner}
					/>
					{owner ? null : <p className="text-sm text-muted-foreground">The live queue and the controls are for owners.</p>}
				</TabsContent>
				<TabsContent value="funnel" className="mt-2">
					<QueryState query={funnel} loadingRows={6} isEmpty={(d) => d.kinds.length === 0} empty="No notification rows in this range. The game asks for notifications with TypeTorch.notifications().want(...).">
						{(data) => <FunnelTab funnel={data} optin={optin.data} />}
					</QueryState>
				</TabsContent>
				{owner ? (
					<TabsContent value="inbox" className="mt-2">
						<InboxTab kind={kind} status={live} />
					</TabsContent>
				) : null}
				{owner ? (
					<TabsContent value="subscribers" className="mt-2">
						<SubscribersTab />
					</TabsContent>
				) : null}
				<TabsContent value="kinds" className="mt-2">
					<QueryState query={funnel} loadingRows={6}>
						{(data) => <KindsTab funnel={data} queue={queue.data} status={live} canEdit={owner && Boolean(live)} />}
					</QueryState>
				</TabsContent>
				<TabsContent value="queue" className="mt-2">
					<QueryState query={queue} loadingRows={4}>
						{(data) => <QueueTab data={data} status={live} />}
					</QueryState>
				</TabsContent>
				{owner ? (
					<TabsContent value="settings" className="mt-2">
						{status.isError ? <QueryState query={status}>{() => null}</QueryState> : live ? <SettingsTab status={live} /> : <QueryState query={status} loadingRows={4}>{() => null}</QueryState>}
					</TabsContent>
				) : null}
			</Tabs>
		</div>
	);
}
