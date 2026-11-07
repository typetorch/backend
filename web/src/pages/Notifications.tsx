/**
 * The Notifications page (plans/29 "Explorer page"): experience notifications, from the `notify` rows and the backend's
 * live sender.
 *
 *   - Funnel per kind and day (the `notify-funnel` query): wants -> planned -> sent (dry runs and tests apart) -> opened ->
 *     played >= 1 min -> returned D1, with open and played rates, plus assisted returns (came back without opening).
 *   - Opt-in prompt (`notify-optin`): checks -> shown -> closed, and the answers the backend inferred from its sends.
 *   - Queue: live from GET /v1/notify/status (owners) and the sender's history (`notify-queue`): per hour, plans, skips.
 *   - Failures by HTTP status and code, and mutes.
 *   - Controls (owners): the runtime settings `notify.*` through PATCH /v1/admin/settings, a test send, the pushed config.
 *   - Player (owners): one player's consent, sends and intents from GET /v1/notify/user (`?player=`, `?by=`).
 *
 * The read-only `web` role sees the analytics only: the status, config and controls are owner routes (403 for viewers).
 * Only the time range of the filter bar applies (backend rows have no device, artifact or place).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { EmptyState, JsonBlock, KeyValue, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, ApiError } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { describeRange } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtPct, fmtTime, plural } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { NotifyFunnelCounts, NotifyFunnelResult, NotifyHalt, NotifyOptinResult, NotifyQueueFailure, NotifyQueueResult, NotifyStatus } from "@/lib/types";
import { PlayerPanel } from "./notifications/PlayerPanel";

export const NOTIFY_STATUS_KEY = ["notify-status"] as const;
const PICKED = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";
const ALL_KINDS = "__all";
const tick = (d: string) => d.slice(5);
const hourTick = (iso: string) => iso.slice(11, 16);

// Funnel ------------------------------------------------------------------------------------------------------------------

type KindRow = NotifyFunnelCounts & { kind: string };
type DayRow = NotifyFunnelCounts & { date: string; kind: string };

const rate = (id: string, header: string, get: (r: NotifyFunnelCounts) => number, title: string) =>
	({ id, header, type: "number", align: "right", title, accessor: (r: NotifyFunnelCounts) => get(r), cell: (r: NotifyFunnelCounts) => fmtPct(get(r)), format: (v: unknown) => fmtPct(v as number) }) as const;
const count = (id: keyof NotifyFunnelCounts, header: string, title?: string) =>
	({ id, header, type: "number", align: "right", ...(title ? { title } : {}), accessor: (r: NotifyFunnelCounts) => r[id], cell: (r: NotifyFunnelCounts) => fmtInt(r[id]) }) as const;

const STEP_COLUMNS: DataColumn<NotifyFunnelCounts>[] = [
	count("wants", "Wants", "want rows from game servers"),
	count("planned", "Planned"),
	count("sent", "Sent", "real sends: not dry runs, not tests"),
	count("dry", "Dry run", "planned and logged, never sent"),
	count("opened", "Opened"),
	rate("openRate", "Open rate", (r) => r.openRate, "opened / sent"),
	count("played", "Played 1 min+"),
	rate("playedRate", "Played rate", (r) => r.playedRate, "played at least a minute / opened"),
	count("returnedD1", "Returned D1", "players sent to on a day who played the next day"),
	count("assisted", "Assisted", "never opened it, came back within 24 h"),
	{ ...count("tests", "Tests"), defaultHidden: true },
	{ ...count("players", "Players"), defaultHidden: true },
];

const KIND_COLUMNS: DataColumn<KindRow>[] = [{ id: "kind", header: "Kind", accessor: (r) => r.kind, cell: (r) => <span className="font-mono">{r.kind || "(none)"}</span> }, ...(STEP_COLUMNS as DataColumn<KindRow>[])];
const DAY_COLUMNS: DataColumn<DayRow>[] = [
	{ id: "date", header: "Day", accessor: (r) => r.date, cell: (r) => <span className="tabular-nums">{r.date}</span> },
	{ id: "kind", header: "Kind", accessor: (r) => r.kind, type: "enum", cell: (r) => <span className="font-mono">{r.kind || "(none)"}</span> },
	...(STEP_COLUMNS as DataColumn<DayRow>[]),
];

const funnelChart: ChartConfig = { sent: { label: "Sent", color: "var(--chart-1)" }, opened: { label: "Opened", color: "var(--chart-2)" }, played: { label: "Played 1 min+", color: "var(--chart-3)" } };

function FunnelSection({ data }: { data: NotifyFunnelResult }) {
	const t = data.totals;
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
				<Metric label="Sent" value={fmtInt(t.sent)} sub={`${fmtInt(t.planned)} planned, ${fmtInt(t.wants)} wanted`} />
				<Metric label="Open rate" value={t.sent ? fmtPct(t.openRate) : "–"} sub={`${fmtInt(t.opened)} opened`} />
				<Metric label="Played 1 min+" value={t.opened ? fmtPct(t.playedRate) : "–"} sub={`${fmtInt(t.played)} of the opened`} />
				<Metric label="Returned D1" value={fmtInt(t.returnedD1)} sub={t.players ? `${fmtPct(t.returnRate)} of players sent to` : "no sends"} />
				<Metric label="Assisted returns" value={fmtInt(t.assisted)} sub="came back within 24 h without opening" />
				<Metric label="Dry run / tests" value={`${fmtInt(t.dry)} / ${fmtInt(t.tests)}`} sub="never counted as sent" tone="muted" />
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				<Section title="Funnel by kind" description="Wants, planned, sent, opened, played at least a minute, back the next day. Rates per kind.">
					<DataTable id="notify-kinds" label="Funnel by kind" columns={KIND_COLUMNS} data={data.kinds} rowId={(r) => r.kind} density="compact" maxHeight="22rem" />
				</Section>
				<Section title="Sent, opened, played" description="Per day (UTC), by the day of the send.">
					<ChartContainer config={funnelChart} className="aspect-auto h-56 w-full">
						<BarChart data={data.daily} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barCategoryGap={2}>
							<CartesianGrid vertical={false} />
							<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
							<YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
							<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
							<ChartLegend content={<ChartLegendContent />} />
							<Bar dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
							<Bar dataKey="opened" fill="var(--color-opened)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
							<Bar dataKey="played" fill="var(--color-played)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
						</BarChart>
					</ChartContainer>
				</Section>
			</div>
			<Section title="Funnel by kind and day" description="Each row is one kind on one day (UTC); opens, plays and returns belong to the day of the send.">
				<DataTable id="notify-days" label="Funnel by kind and day" columns={DAY_COLUMNS} data={data.days} rowId={(r) => `${r.date}|${r.kind}`} density="compact" maxHeight="24rem" />
			</Section>
		</>
	);
}

// Opt-in ------------------------------------------------------------------------------------------------------------------

type WhereRow = NotifyOptinResult["byWhere"][number];
const WHERE_COLUMNS: DataColumn<WhereRow>[] = [
	{ id: "where", header: "Where", accessor: (r) => r.where, cell: (r) => (r.where ? <span className="font-mono">{r.where}</span> : <span className="text-muted-foreground">(none)</span>) },
	{ id: "checks", header: "Checks", type: "number", align: "right", accessor: (r) => r.checks, cell: (r) => fmtInt(r.checks) },
	{ id: "canPrompt", header: "Can prompt", type: "number", align: "right", accessor: (r) => r.canPrompt, cell: (r) => fmtInt(r.canPrompt) },
	{ id: "errors", header: "Errors", type: "number", align: "right", accessor: (r) => r.errors, cell: (r) => fmtInt(r.errors) },
	{ id: "shown", header: "Shown", type: "number", align: "right", accessor: (r) => r.shown, cell: (r) => fmtInt(r.shown) },
	{ id: "shownRate", header: "Shown rate", type: "number", align: "right", title: "shown / checks", accessor: (r) => r.shownRate, cell: (r) => fmtPct(r.shownRate) },
	{ id: "closed", header: "Closed", type: "number", align: "right", accessor: (r) => r.closed, cell: (r) => fmtInt(r.closed) },
	{ id: "avgShownSecs", header: "Up for", hint: "s", type: "number", align: "right", accessor: (r) => r.avgShownSecs, cell: (r) => (r.avgShownSecs === null ? "–" : String(r.avgShownSecs)) },
];

function OptinSection({ data }: { data: NotifyOptinResult }) {
	const t = data.totals;
	return (
		<Section title="Opt-in prompt" description="The game's prompt: checked (can it show?), shown, closed. Roblox doesn't say what the player picked; the backend infers it from its sends.">
			<div className="space-y-3">
				<div className="grid grid-cols-2 gap-3 md:grid-cols-5">
					<Metric label="Checks" value={fmtInt(t.checks)} sub={`${fmtInt(t.canPrompt)} could prompt, ${fmtInt(t.errors)} errors`} />
					<Metric label="Shown" value={fmtInt(t.shown)} sub={t.checks ? `${fmtPct(t.shownRate)} of checks` : undefined} />
					<Metric label="Closed" value={fmtInt(t.closed)} sub={t.avgShownSecs === null ? undefined : `up ${t.avgShownSecs} s on average`} />
					<Metric label="Subscribed" value={fmtInt(t.subscribed)} sub="inferred from accepted sends" />
					<Metric label="Not subscribed" value={fmtInt(t.notSubscribed)} sub="inferred from refused sends" />
				</div>
				{data.byWhere.length ? (
					<DataTable id="notify-optin-where" label="Opt-in by where" columns={WHERE_COLUMNS} data={data.byWhere} rowId={(r) => r.where} density="compact" maxHeight="18rem" />
				) : (
					<EmptyState>No opt-in prompt rows in this range.</EmptyState>
				)}
			</div>
		</Section>
	);
}

// Queue and failures ------------------------------------------------------------------------------------------------------

const queueChart: ChartConfig = {
	planned: { label: "Planned", color: "var(--chart-4)" },
	sent: { label: "Sent", color: "var(--chart-1)" },
	dry: { label: "Dry run", color: "var(--chart-3)" },
	failed: { label: "Failed", color: "var(--chart-5)" },
	rateLimited: { label: "429", color: "var(--status-critical)" },
};

type WhyRow = { kind: string; why: string; n: number };
const whyColumns = (what: string): DataColumn<WhyRow>[] => [
	{ id: "kind", header: "Kind", accessor: (r) => r.kind, type: "enum", cell: (r) => <span className="font-mono">{r.kind || "(none)"}</span> },
	{ id: "why", header: "Why", accessor: (r) => r.why, type: "enum", cell: (r) => <span className="font-mono">{r.why || "(none)"}</span> },
	{ id: "n", header: what, type: "number", align: "right", accessor: (r) => r.n, cell: (r) => fmtInt(r.n) },
];
const PLANNED_COLUMNS = whyColumns("Planned");
const SKIPPED_COLUMNS = whyColumns("Skipped");

const FAILURE_COLUMNS: DataColumn<NotifyQueueFailure>[] = [
	{ id: "kind", header: "Kind", accessor: (r) => r.kind, type: "enum", cell: (r) => <span className="font-mono">{r.kind || "(none)"}</span> },
	{ id: "http", header: "HTTP", type: "number", align: "right", accessor: (r) => r.http, cell: (r) => (r.http === null ? "network" : String(r.http)) },
	{ id: "code", header: "Code", accessor: (r) => r.code, cell: (r) => <span className="font-mono">{r.code || "–"}</span> },
	{ id: "failures", header: "Failures", type: "number", align: "right", accessor: (r) => r.failures, cell: (r) => fmtInt(r.failures) },
	{ id: "final", header: "Final", type: "number", align: "right", title: "ended the send (no retry)", accessor: (r) => r.final, cell: (r) => fmtInt(r.final) },
	{ id: "sends", header: "Sends", type: "number", align: "right", accessor: (r) => r.sends, cell: (r) => fmtInt(r.sends) },
	{ id: "lastAt", header: "Last", accessor: (r) => r.lastAt, cell: (r) => (r.lastAt ? <span title={fmtTime(r.lastAt)}>{fmtAgo(r.lastAt)}</span> : "–") },
];

function LiveQueue({ status }: { status: NotifyStatus }) {
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Pending" value={fmtInt(status.queue.pending)} sub={`${fmtInt(status.queue.due1h)} due in the next hour`} />
				<Metric label="Sending" value={fmtInt(status.queue.sending)} />
				<Metric
					label="Rate"
					value={`${status.bucket.rate}/s`}
					sub={`${Math.floor(status.bucket.tokens)} tokens, ceiling ${status.rate}/s`}
					hint={status.bucket.last429At ? `last 429 ${fmtAgo(status.bucket.last429At)}` : "no 429 yet"}
				/>
				<Metric label="Last 24 h" value={fmtInt(status.sends24h.sent)} sub={`sent; ${fmtInt(status.sends24h.failed)} failed, ${fmtInt(status.sends24h.dry)} dry`} />
			</div>
			{status.outbox !== undefined || status.rowsDropped || status.presenceStaleHours !== undefined ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					{status.outbox !== undefined ? <KeyValue label="Outbox">{fmtInt(status.outbox)} rows waiting</KeyValue> : null}
					{status.rowsDropped ? <KeyValue label="Rows dropped">{fmtInt(status.rowsDropped)}</KeyValue> : null}
					{status.presenceStaleHours !== undefined ? <KeyValue label="Presence stale after">{fmtInt(status.presenceStaleHours)} h</KeyValue> : null}
				</div>
			) : null}
		</div>
	);
}

function QueueSection({ data, status }: { data: NotifyQueueResult; status: NotifyStatus | undefined }) {
	const t = data.totals;
	return (
		<Section
			title="Queue"
			description={status ? "Live from the backend's sender, then its history in this range (per hour, UTC)." : "The sender's history in this range (per hour, UTC). The live queue is for owners."}
		>
			<div className="space-y-3">
				{status ? <LiveQueue status={status} /> : null}
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					<KeyValue label="Planned">{fmtInt(t.planned)}</KeyValue>
					<KeyValue label="Sent">{fmtInt(t.sent)}</KeyValue>
					<KeyValue label="Dry run">{fmtInt(t.dry)}</KeyValue>
					<KeyValue label="Failed">{fmtInt(t.failed)}</KeyValue>
					<KeyValue label="429s">{fmtInt(t.rateLimited)}</KeyValue>
					<KeyValue label="Skipped">{fmtInt(t.skipped)}</KeyValue>
					{t.last429At ? <KeyValue label="Last 429">{fmtTime(t.last429At)}</KeyValue> : null}
				</div>
				<ChartContainer config={queueChart} className="aspect-auto h-52 w-full">
					<BarChart data={data.hours} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barCategoryGap={1}>
						<CartesianGrid vertical={false} />
						<XAxis dataKey="hour" tickLine={false} axisLine={false} tickMargin={6} minTickGap={32} tickFormatter={hourTick} />
						<YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
						<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => fmtTime(String(d))} />} />
						<ChartLegend content={<ChartLegendContent />} />
						<Bar dataKey="planned" fill="var(--color-planned)" maxBarSize={12} isAnimationActive={false} />
						<Bar dataKey="sent" stackId="out" fill="var(--color-sent)" maxBarSize={12} isAnimationActive={false} />
						<Bar dataKey="dry" stackId="out" fill="var(--color-dry)" maxBarSize={12} isAnimationActive={false} />
						<Bar dataKey="failed" fill="var(--color-failed)" maxBarSize={12} isAnimationActive={false} />
						<Bar dataKey="rateLimited" fill="var(--color-rateLimited)" maxBarSize={12} isAnimationActive={false} />
					</BarChart>
				</ChartContainer>
				<div className="grid gap-3 lg:grid-cols-2">
					<div className="min-w-0 space-y-1">
						<h3 className="text-sm font-medium">Planned, by why</h3>
						{data.planned.length ? (
							<DataTable id="notify-planned" label="Planned by kind and why" columns={PLANNED_COLUMNS} data={data.planned.map((r) => ({ kind: r.kind, why: r.why, n: r.planned }))} rowId={(r) => `${r.kind}|${r.why}`} density="compact" maxHeight="16rem" />
						) : (
							<EmptyState>Nothing planned in this range.</EmptyState>
						)}
					</div>
					<div className="min-w-0 space-y-1">
						<h3 className="text-sm font-medium">Skipped, by why</h3>
						{data.skipped.length ? (
							<DataTable id="notify-skipped" label="Skipped by kind and why" columns={SKIPPED_COLUMNS} data={data.skipped.map((r) => ({ kind: r.kind, why: r.why, n: r.skipped }))} rowId={(r) => `${r.kind}|${r.why}`} density="compact" maxHeight="16rem" />
						) : (
							<EmptyState>Nothing skipped in this range.</EmptyState>
						)}
					</div>
				</div>
			</div>
		</Section>
	);
}

function FailuresSection({ data, status }: { data: NotifyQueueResult; status: NotifyStatus | undefined }) {
	return (
		<Section
			title="Failures"
			description="Sends Roblox refused, by HTTP status and code. A player who isn't opted in is muted for 7 days."
			actions={status ? <Badge variant="outline">{plural(status.mutes, "muted player")}</Badge> : undefined}
		>
			{data.failures.length ? (
				<DataTable id="notify-failures" label="Failures by http and code" columns={FAILURE_COLUMNS} data={data.failures} rowId={(r) => `${r.kind}|${r.http}|${r.code}`} density="compact" maxHeight="18rem" />
			) : (
				<EmptyState>No failed sends in this range.</EmptyState>
			)}
		</Section>
	);
}

// Controls (owners) ---------------------------------------------------------------------------------------------------------

function OnOff({ label, value, disabled, onChange, on = "On", off = "Off" }: { label: string; value: boolean; disabled?: boolean; onChange(next: boolean): void; on?: string; off?: string }) {
	return (
		<ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={value ? "on" : "off"} disabled={disabled} onValueChange={(v) => v && onChange(v === "on")} aria-label={label}>
			<ToggleGroupItem value="on" className={PICKED}>
				{on}
			</ToggleGroupItem>
			<ToggleGroupItem value="off" className={PICKED}>
				{off}
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

/** "name=value" lines into params (empty lines skipped). Throws on a line without "=". */
export function parseParams(text: string): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const at = line.indexOf("=");
		if (at <= 0) throw new Error(`"${line}" is not name=value`);
		out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return Object.keys(out).length ? out : undefined;
}

function TestSend({ kinds }: { kinds: string[] }) {
	const [userId, setUserId] = useState("");
	const [kind, setKind] = useState("");
	const [params, setParams] = useState("");
	const [data, setData] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const send = useMutation({ mutationFn: (input: Parameters<typeof api.notifyTest>[0]) => api.notifyTest(input) });
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setProblem(null);
		const id = Number(userId.trim());
		if (!Number.isSafeInteger(id) || id <= 0) return setProblem("UserId must be a positive whole number.");
		const k = kind || kinds[0] || "";
		if (!k) return setProblem("Pick a kind.");
		let p: Record<string, string> | undefined;
		try {
			p = parseParams(params);
		} catch (error) {
			return setProblem((error as Error).message);
		}
		send.mutate({ userId: id, kind: k, ...(p ? { params: p } : {}), ...(data.trim() ? { data: data.trim() } : {}) });
	};
	return (
		<form className="space-y-3" onSubmit={submit} aria-label="Send a test">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="notify-test-user">UserId</Label>
					<Input id="notify-test-user" inputMode="numeric" className="h-8 tabular-nums" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="123456789" />
				</div>
				<div className="space-y-1">
					<Label htmlFor="notify-test-kind">Kind</Label>
					<Select value={kind || kinds[0] || ""} onValueChange={setKind}>
						<SelectTrigger id="notify-test-kind" size="sm" className="w-full" aria-label="Test kind">
							<SelectValue placeholder="No kinds pushed" />
						</SelectTrigger>
						<SelectContent>
							{kinds.map((k) => (
								<SelectItem key={k} value={k}>
									{k}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1">
					<Label htmlFor="notify-test-params">Params</Label>
					<Textarea id="notify-test-params" rows={2} className="font-mono text-xs" spellCheck={false} placeholder="name=value, one per line" value={params} onChange={(e) => setParams(e.target.value)} />
				</div>
				<div className="space-y-1">
					<Label htmlFor="notify-test-data">Launch data</Label>
					<Input id="notify-test-data" className="h-8 font-mono text-xs" maxLength={64} value={data} onChange={(e) => setData(e.target.value)} placeholder="optional, up to 64 bytes" />
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" size="sm" disabled={send.isPending || !kinds.length}>
					<Send />
					Send a test
				</Button>
				<span className="text-xs text-muted-foreground">Goes out now, outside the caps, marked test. In dry run it is only logged.</span>
			</div>
			{problem ? <p className="text-sm text-destructive">{problem}</p> : null}
			{send.isError ? <p className="text-sm text-destructive">{send.error.message}</p> : null}
			{send.data ? (
				<p role="status" className="text-sm">
					Test <span className="font-mono">{send.data.nid}</span>: {send.data.status}
				</p>
			) : null}
		</form>
	);
}

function ConfigView() {
	const [open, setOpen] = useState(false);
	const q = useQuery({ queryKey: ["notify-config"], queryFn: ({ signal }) => api.notifyConfig(signal), enabled: open });
	return (
		<div className="space-y-2">
			<Button type="button" variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
				{open ? "Hide the pushed config" : "Show the pushed config"}
			</Button>
			{open ? (
				<QueryState query={q} loadingRows={2}>
					{(view) =>
						view.config ? (
							<div className="space-y-1">
								<p className="text-xs text-muted-foreground">
									Pushed {view.updatedAt ? fmtAgo(view.updatedAt) : "at an unknown time"}
									{view.by ? ` by ${view.by}` : ""}. Change it with <code className="font-mono">typetorch notify push</code>.
								</p>
								<JsonBlock value={view.config} />
							</div>
						) : (
							<EmptyState>No config pushed yet: run <code className="font-mono">typetorch notify push</code>.</EmptyState>
						)
					}
				</QueryState>
			) : null}
		</div>
	);
}

function Controls({ status }: { status: NotifyStatus }) {
	const client = useQueryClient();
	const [rate, setRate] = useState(String(status.rate));
	const [notice, setNotice] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (changes: Record<string, unknown>) => api.saveSettings(changes),
		onSuccess: () => setNotice("Saved; in effect now."),
		onSettled: () => void client.invalidateQueries({ queryKey: NOTIFY_STATUS_KEY }),
	});
	const set = (key: string, value: unknown) => {
		setNotice(null);
		save.mutate({ [key]: value });
	};
	const rateNumber = Number(rate);
	const rateOk = Number.isFinite(rateNumber) && rateNumber >= 1 && rateNumber <= 4000;
	const busy = save.isPending;
	return (
		<Section title="Controls" description="Runtime settings (audited, no redeploy). Dry run plans and logs every send without posting it to Roblox.">
			<div className="space-y-4">
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<div className="space-y-1">
						<Label>Sending</Label>
						<OnOff label="Sending" value={status.enabled} disabled={busy} onChange={(v) => set("notify.enabled", v)} on="On" off="Paused" />
					</div>
					<div className="space-y-1">
						<Label>Dry run</Label>
						<OnOff label="Dry run" value={status.dryRun} disabled={busy} onChange={(v) => set("notify.dryRun", v)} />
					</div>
					<div className="space-y-1">
						<Label>Day clock</Label>
						<ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={status.clock} disabled={busy} onValueChange={(v) => v && set("notify.clock", v)} aria-label="Day clock">
							<ToggleGroupItem value="rolling24" className={PICKED}>
								Rolling 24 h
							</ToggleGroupItem>
							<ToggleGroupItem value="utc_day" className={PICKED}>
								UTC day
							</ToggleGroupItem>
						</ToggleGroup>
					</div>
					<form
						className="space-y-1"
						onSubmit={(e) => {
							e.preventDefault();
							if (rateOk) set("notify.rate", Math.round(rateNumber));
						}}
					>
						<Label htmlFor="notify-rate">Rate ceiling (sends / s)</Label>
						<div className="flex gap-2">
							<Input id="notify-rate" inputMode="numeric" className="h-8 w-24 tabular-nums" aria-invalid={rateOk ? undefined : true} value={rate} onChange={(e) => setRate(e.target.value)} />
							<Button type="submit" size="sm" variant="outline" disabled={busy || !rateOk || Math.round(rateNumber) === status.rate}>
								Save
							</Button>
						</div>
					</form>
				</div>
				<div className="flex flex-wrap gap-2 text-xs">
					<Badge variant={status.configured.universe && status.configured.apiKey ? "outline" : "destructive"}>
						{status.configured.universe && status.configured.apiKey ? "Open Cloud configured" : `Missing ${[!status.configured.universe && "universe", !status.configured.apiKey && "API key"].filter(Boolean).join(" and ")}`}
					</Badge>
					<Badge variant={status.keys.current ? "outline" : "destructive"}>{status.keys.current ? `Signing key set${status.keys.previous ? " (+ previous)" : ""}` : "No signing key"}</Badge>
					<Badge variant={status.config ? "outline" : "destructive"}>{status.config ? "Config pushed" : "No config pushed"}</Badge>
				</div>
				{save.isError ? <p className="text-sm text-destructive">{save.error.message}</p> : null}
				{notice ? (
					<p role="status" className="text-sm text-muted-foreground">
						{notice}
					</p>
				) : null}
				<div className="space-y-1">
					<h3 className="text-sm font-medium">Kinds</h3>
					{status.kinds.length ? (
						<div className="overflow-x-auto rounded-lg border">
							<table className="w-full min-w-[28rem] text-sm">
								<thead className="text-xs text-muted-foreground">
									<tr className="border-b">
										<th className="px-3 py-2 text-left font-medium">Kind</th>
										<th className="px-3 py-2 text-left font-medium">Template</th>
										<th className="px-3 py-2 text-right font-medium">Pending</th>
										<th className="px-3 py-2 text-left font-medium">Sending</th>
									</tr>
								</thead>
								<tbody>
									{status.kinds.map((k) => (
										<tr key={k.kind} className="border-b last:border-0">
											<td className="px-3 py-2 font-mono">
												{k.kind}
												{k.halted ? (
													<Badge variant="destructive" className="ml-2">
														stopped
													</Badge>
												) : null}
												{k.text ? <p className="mt-0.5 font-sans text-xs whitespace-normal break-words text-muted-foreground">{k.text}</p> : null}
											</td>
											<td className="px-3 py-2">{k.template ? "set" : <span className="text-muted-foreground">none (never sent)</span>}</td>
											<td className="px-3 py-2 text-right tabular-nums">{fmtInt(k.pending)}</td>
											<td className="px-3 py-2">
												<OnOff label={`Kind ${k.kind}`} value={k.enabled} disabled={busy} onChange={(v) => set(`notify.kinds.${k.kind}.enabled`, v)} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<EmptyState>No kinds yet: push the game's notifications config with typetorch notify push.</EmptyState>
					)}
				</div>
				<div className="space-y-1">
					<h3 className="text-sm font-medium">Send a test</h3>
					<TestSend kinds={status.kinds.map((k) => k.kind)} />
				</div>
				<ConfigView />
			</div>
		</Section>
	);
}

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
						<p>
							Kind {h.kind} stopped: its template (message id) does not exist on Roblox. Fix the template, push the config, then turn the kind back on.
						</p>
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
			<SelectTrigger size="sm" className="w-44" aria-label="Kind">
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

export default function Notifications() {
	const { state } = useFilters();
	const readOnly = isReadOnly(useAuth());
	const [kind, setKind] = useParam("kind");
	const options = kind ? { kind } : {};
	const funnel = useAnalytics("notify-funnel", options);
	const optin = useAnalytics("notify-optin");
	const queue = useAnalytics("notify-queue", options);
	const status = useQuery({ queryKey: NOTIFY_STATUS_KEY, queryFn: ({ signal }) => api.notifyStatus(signal), enabled: !readOnly, refetchInterval: 15_000, retry: false });
	const live = status.data;
	// A viewer (or an owner whose browser isn't trusted yet) gets 403: the analytics still show.
	const forbidden = status.error instanceof ApiError && (status.error.status === 403 || status.error.status === 401);
	const kinds = [...new Set([...(live?.kinds.map((k) => k.kind) ?? []), ...(funnel.data?.kinds.map((k) => k.kind).filter(Boolean) ?? [])])].sort();
	return (
		<div className="space-y-4">
			<PageHeader
				title="Notifications"
				description={`Experience notifications, ${describeRange(state)}: what was sent, opened and played, the opt-in prompt and the sender.`}
				actions={<KindPicker kinds={kinds} value={kind} onChange={setKind} />}
			/>
			{live ? <HaltedBanner status={live} /> : null}
			{live && (!live.enabled || live.dryRun) ? (
				<Alert>
					<CircleAlert />
					<AlertTitle>{!live.enabled ? "Sending is paused" : "Dry run"}</AlertTitle>
					<AlertDescription>{!live.enabled ? "Nothing is planned or sent until it is turned back on." : "Sends are planned and logged, never posted to Roblox."}</AlertDescription>
				</Alert>
			) : null}
			<QueryState query={funnel} loadingRows={6} isEmpty={(d) => d.kinds.length === 0} empty="No notification rows in this range. The game asks for notifications with TypeTorch.notifications().want(...).">
				{(data) => <FunnelSection data={data} />}
			</QueryState>
			<QueryState query={optin} loadingRows={3}>
				{(data) => <OptinSection data={data} />}
			</QueryState>
			<QueryState query={queue} loadingRows={4}>
				{(data) => (
					<>
						<QueueSection data={data} status={live} />
						<FailuresSection data={data} status={live} />
					</>
				)}
			</QueryState>
			{readOnly || forbidden ? (
				<p className="text-sm text-muted-foreground">The live queue and the controls are for owners.</p>
			) : status.isError ? (
				<Section title="Controls">
					<QueryState query={status}>{() => null}</QueryState>
				</Section>
			) : live ? (
				<Controls status={live} />
			) : null}
			{readOnly || forbidden ? null : <PlayerPanel />}
		</div>
	);
}
