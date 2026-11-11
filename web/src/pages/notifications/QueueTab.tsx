/**
 * The Queue & errors tab: the live queue (owners, GET /v1/notify/status), the sender's history in the range (the
 * `notify-queue` query: per hour, planned and skipped by why) and the failures by HTTP status and code. Also the
 * "Right now" numbers the header's status chip shows in its popover.
 */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { EmptyState, KeyValue, Metric, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtAgo, fmtInt, fmtTime, plural } from "@/lib/format";
import type { NotifyQueueFailure, NotifyQueueResult, NotifyStatus } from "@/lib/types";
import { hourTick } from "./shared";

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
	{ id: "http", header: "HTTP", type: "number", align: "right", accessor: (r) => r.http, cell: (r) => (r.http === null ? "network" : String(r.http)) },
	{ id: "code", header: "Code", accessor: (r) => r.code, cell: (r) => <span className="font-mono">{r.code || "–"}</span> },
	{ id: "kind", header: "Kind", accessor: (r) => r.kind, type: "enum", cell: (r) => <span className="font-mono">{r.kind || "(none)"}</span> },
	{ id: "failures", header: "Failures", type: "number", align: "right", accessor: (r) => r.failures, cell: (r) => fmtInt(r.failures) },
	{ id: "final", header: "Final", type: "number", align: "right", title: "ended the send (no retry)", accessor: (r) => r.final, cell: (r) => fmtInt(r.final) },
	{ id: "sends", header: "Sends", type: "number", align: "right", accessor: (r) => r.sends, cell: (r) => fmtInt(r.sends) },
	{ id: "lastAt", header: "Last", accessor: (r) => r.lastAt, cell: (r) => (r.lastAt ? <span title={fmtTime(r.lastAt)}>{fmtAgo(r.lastAt)}</span> : "–") },
];

/** The live numbers as label / value lines (the status chip's popover). */
export function RightNow({ status }: { status: NotifyStatus }) {
	const rows: [string, string][] = [
		["Pending", fmtInt(status.queue.pending)],
		["Due in the next hour", fmtInt(status.queue.due1h)],
		["Sending", fmtInt(status.queue.sending)],
		["Rate", `${status.bucket.rate}/s (ceiling ${status.rate}/s)`],
		["Last 24 h", `${fmtInt(status.sends24h.sent)} sent, ${fmtInt(status.sends24h.failed)} failed, ${fmtInt(status.sends24h.dry)} dry`],
		["Muted players", fmtInt(status.mutes)],
		...(status.outbox !== undefined ? [["Outbox", `${fmtInt(status.outbox)} rows waiting`] as [string, string]] : []),
		...(status.rowsDropped ? [["Rows dropped", fmtInt(status.rowsDropped)] as [string, string]] : []),
		...(status.presenceStaleHours !== undefined ? [["Presence stale after", `${fmtInt(status.presenceStaleHours)} h`] as [string, string]] : []),
		["Last 429", status.bucket.last429At ? fmtAgo(status.bucket.last429At) : "none yet"],
	];
	return (
		<dl className="space-y-1 text-sm" aria-label="Right now">
			{rows.map(([label, value]) => (
				<div key={label} className="flex items-baseline justify-between gap-4 border-b border-dashed py-0.5 last:border-0">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="font-medium tabular-nums">{value}</dd>
				</div>
			))}
		</dl>
	);
}

function LiveQueue({ status }: { status: NotifyStatus }) {
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Pending" value={fmtInt(status.queue.pending)} sub={`${fmtInt(status.queue.due1h)} due in the next hour`} />
				<Metric
					label="Sending"
					value={fmtInt(status.queue.sending)}
					sub={`${status.bucket.rate}/s now, ceiling ${status.rate}/s`}
					hint={`${Math.floor(status.bucket.tokens)} tokens; ${status.bucket.last429At ? `last 429 ${fmtAgo(status.bucket.last429At)}` : "no 429 yet"}`}
				/>
				<Metric label="Last 24 h" value={fmtInt(status.sends24h.sent)} sub={`sent; ${fmtInt(status.sends24h.failed)} failed, ${fmtInt(status.sends24h.dry)} dry`} />
				<Metric label="Muted players" value={fmtInt(status.mutes)} sub="a refused send mutes for 7 days" />
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

export function QueueTab({ data, status }: { data: NotifyQueueResult; status: NotifyStatus | undefined }) {
	const t = data.totals;
	return (
		<div className="space-y-4">
			{status ? <LiveQueue status={status} /> : null}
			<Section
				className="min-w-0"
				title="Failures"
				description="Sends Roblox refused in this range, by HTTP status and code. A player who isn't opted in is muted for 7 days."
				actions={status ? <Badge variant="outline">{plural(status.mutes, "muted player")}</Badge> : undefined}
			>
				{data.failures.length ? (
					<DataTable id="notify-failures" label="Failures by http and code" columns={FAILURE_COLUMNS} data={data.failures} rowId={(r) => `${r.kind}|${r.http}|${r.code}`} density="compact" maxHeight="18rem" />
				) : (
					<EmptyState>No failed sends in this range.</EmptyState>
				)}
			</Section>
			<div className="grid items-start gap-4 lg:grid-cols-2">
				<Section className="min-w-0" title="Planned, by why">
					{data.planned.length ? (
						<DataTable id="notify-planned" label="Planned by kind and why" columns={PLANNED_COLUMNS} data={data.planned.map((r) => ({ kind: r.kind, why: r.why, n: r.planned }))} rowId={(r) => `${r.kind}|${r.why}`} density="compact" maxHeight="16rem" />
					) : (
						<EmptyState>Nothing planned in this range.</EmptyState>
					)}
				</Section>
				<Section className="min-w-0" title="Skipped, by why">
					{data.skipped.length ? (
						<DataTable id="notify-skipped" label="Skipped by kind and why" columns={SKIPPED_COLUMNS} data={data.skipped.map((r) => ({ kind: r.kind, why: r.why, n: r.skipped }))} rowId={(r) => `${r.kind}|${r.why}`} density="compact" maxHeight="16rem" />
					) : (
						<EmptyState>Nothing skipped in this range.</EmptyState>
					)}
				</Section>
			</div>
			<Section title="Queue history" description="The sender's history in this range (per hour, UTC).">
				<div className="space-y-3">
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
				</div>
			</Section>
		</div>
	);
}
