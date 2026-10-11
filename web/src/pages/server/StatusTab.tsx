/**
 * The Status tab: TPS, memory and players over the last hour (the fleet metrics history, GET .../metrics, kernel 0.4.2
 * heartbeats) and the kernel's status() on request (op `status`, what the dev menu's Server > Status shows).
 */
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, JsonBlock, KeyValue, LoadingBlock } from "@/components/common";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { api, ApiError } from "@/lib/api";
import { fmtDuration, fmtInt, fmtNum, fmtTime } from "@/lib/format";
import type { RemoteState } from "@/lib/remote-debug";
import type { ServerMetricPoint } from "@/lib/perf";
import type { RemoteStatus } from "@/lib/types";
import { RemoteBar } from "./shared";

/** The charts' window. */
export const CHART_MINUTES = 60;

/** A round step (1, 2, 2.5 or 5 times a power of ten) at least `x`. */
function niceStep(x: number): number {
	if (!(x > 0)) return 1;
	const power = 10 ** Math.floor(Math.log10(x));
	const f = x / power;
	return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

/** The y axis: 0 to a round top (at least `floor`) in four equal steps, e.g. 0 15 30 45 60 or 0 250 500 750 1,000. */
export function valueTicks(max: number, floor = 0): number[] {
	const top = floor > 0 && max <= floor ? floor : niceStep(Math.max(max, 0) / 4) * 4;
	return [0, 1, 2, 3, 4].map((i) => (top * i) / 4);
}

/** The x axis: about four evenly spaced times between the first and the last point. */
export function timeTicks(first: number, last: number, count = 4): number[] {
	if (!(last > first)) return [first];
	return Array.from({ length: count }, (_, i) => Math.round(first + ((last - first) * i) / (count - 1)));
}

/** "10:32", or "10:32:05" when the window is under five minutes (so ticks don't repeat), "10-08 10:32" over most of a day. */
const timeLabel = (span: number) => (t: number) => (span > 20 * 3_600_000 ? fmtTime(t).slice(5, 16) : fmtTime(t).slice(11, span < 5 * 60_000 ? 19 : 16));

interface SeriesSpec {
	key: keyof ServerMetricPoint;
	label: string;
	color: string;
}

/** One small line chart: one axis, one unit; a legend when it has two series (one series: the title names it). */
function MetricChart({
	title,
	unit,
	points,
	series,
	digits,
	minMax,
	windowText,
}: {
	title: string;
	unit: string;
	points: ServerMetricPoint[];
	series: SeriesSpec[];
	digits: number;
	minMax?: number;
	/** The chart's window in words ("the last 60 minutes", "its whole life"). */
	windowText: string;
}) {
	const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
	const values = points.flatMap((p) => series.map((s) => p[s.key])).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
	const last = points.length ? points[points.length - 1] : undefined;
	const first = points.length ? points[0].t : 0;
	const xTicks = timeTicks(first, last?.t ?? first);
	const yTicks = valueTicks(values.length ? Math.max(...values) : 0, minMax);
	return (
		<figure className="min-w-0 space-y-1" aria-label={`${title} over ${windowText}`}>
			<figcaption className="flex items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">{title}</span>
				<span className="text-xs text-muted-foreground tabular-nums">
					{last && typeof last[series[0].key] === "number" ? `now ${fmtNum(last[series[0].key] as number, digits)} ${unit}` : unit}
				</span>
			</figcaption>
			{values.length ? (
				<ChartContainer config={config} className="aspect-auto h-40 w-full">
					<LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="t"
							type="number"
							scale="time"
							domain={["dataMin", "dataMax"]}
							ticks={xTicks}
							tickLine={false}
							axisLine={false}
							tickMargin={6}
							tickFormatter={timeLabel((last?.t ?? first) - first)}
						/>
						<YAxis tickLine={false} axisLine={false} width={44} domain={[0, yTicks[4]]} ticks={yTicks} interval={0} tickFormatter={(v: number) => fmtNum(v, 1)} />

						<ChartTooltip
							content={
								<ChartTooltipContent
									labelFormatter={(_, p) => `${fmtTime(Number(p?.[0]?.payload?.t)).slice((last?.t ?? first) - first > 20 * 3_600_000 ? 5 : 11, 19)} UTC`}
									formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? `${fmtNum(v, digits)} ${unit}` : "–"}`}
								/>
							}
						/>
						{/* In the series' own order (Recharts sorts by name otherwise). */}
						{series.length > 1 ? <ChartLegend itemSorter={null} content={<ChartLegendContent />} /> : null}
						{series.map((s) => (
							<Line key={s.key} dataKey={s.key} stroke={`var(--color-${s.key})`} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
						))}
					</LineChart>
				</ChartContainer>
			) : (
				<p className="flex h-40 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-muted-foreground">No readings in this window.</p>
			)}
		</figure>
	);
}

/**
 * TPS, memory and players over the last hour, from the fleet metrics; with `since` (a server that isn't live: where its
 * metrics start) over its whole life, older parts from the backend's 5-minute rollups (kept 30 days).
 */
export function ServerCharts({ job, live, since }: { job: string; live: boolean; since?: number }) {
	const metrics = useQuery({
		queryKey: ["fleet", "server-metrics", job, since ?? "last-hour"],
		queryFn: ({ signal }) => api.serverMetrics(job, since ?? Date.now() - CHART_MINUTES * 60_000, signal),
		refetchInterval: live ? 30_000 : false,
	});
	const windowText = since !== undefined ? "its whole life" : `the last ${CHART_MINUTES} minutes`;
	if (metrics.isPending) return <LoadingBlock rows={3} />;
	if (metrics.isError) {
		if (metrics.error instanceof ApiError && metrics.error.notFound)
			return <EmptyState>This backend has no TPS and memory history yet (the fleet metrics route; kernel 0.4.2+ heartbeats fill it).</EmptyState>;
		return <ErrorState error={metrics.error} title="Could not load the TPS and memory history" />;
	}
	const points = metrics.data;
	if (!points.length)
		return <EmptyState>{since !== undefined ? "No TPS or memory readings kept for this server (rollups are kept 30 days)." : "No TPS or memory readings in the last hour (kernel 0.4.2+ sends them with every heartbeat)."}</EmptyState>;
	return (
		<div className="grid gap-4 md:grid-cols-3">
			<MetricChart
				windowText={windowText}
				title="Server TPS"
				unit="TPS"
				digits={1}
				minMax={60}
				points={points}
				series={[
					{ key: "tps", label: "Average", color: "var(--chart-1)" },
					{ key: "tpsMin", label: "Slowest second", color: "var(--chart-2)" },
				]}
			/>
			<MetricChart
				windowText={windowText}
				title="Memory"
				unit="MB"
				digits={0}
				points={points}
				series={[
					{ key: "memMb", label: "Total", color: "var(--chart-1)" },
					{ key: "luaMb", label: "Lua heap", color: "var(--chart-2)" },
				]}
			/>
			<MetricChart windowText={windowText} title="Players" unit="players" digits={0} minMax={4} points={points} series={[{ key: "players", label: "Players", color: "var(--chart-1)" }]} />
		</div>
	);
}

const yesNo = (v: boolean | undefined) => (v === undefined ? "–" : v ? "yes" : "no");

/** The kernel's status(), the facts the dev menu leads with; the whole answer under "Raw answer". */
export function StatusFacts({ data }: { data: RemoteStatus }) {
	const s = data.status ?? {};
	const g = s.generation;
	const rd = s.remoteDebug;
	const artifact = g?.artifact as { artifactId?: string; id?: string } | undefined;
	return (
		<div className="space-y-3">
			<div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
				<KeyValue label="Place version">{s.placeVersion ?? "–"}</KeyValue>
				<KeyValue label="Server up">{s.uptime !== undefined ? fmtDuration(s.uptime * 1000) : "–"}</KeyValue>
				<KeyValue label="Players">
					{fmtInt(s.players)} / {fmtInt(s.maxPlayers)}
				</KeyValue>
				<KeyValue label="Generation">{g ? `${g.name ?? "?"} #${g.number ?? "?"}${g.uptime !== undefined ? `, up ${fmtDuration(g.uptime * 1000)}` : ""}` : "nothing runs"}</KeyValue>
				<KeyValue label="Build">{artifact?.artifactId ?? artifact?.id ?? "–"}</KeyValue>
				<KeyValue label="Kernel">{`${s.kernelVersion ?? "?"}${s.kernelBuild ? ` (${s.kernelBuild})` : ""}`}</KeyValue>
				<KeyValue label="Memory">{s.memoryMb !== undefined ? `${fmtNum(s.memoryMb, 0)} MB` : "–"}</KeyValue>
				<KeyValue label="Lua heap">{s.luaHeapKb !== undefined ? `${fmtNum(s.luaHeapKb / 1024, 1)} MB` : "–"}</KeyValue>
				<KeyValue label="Health">{s.health?.state ?? "–"}</KeyValue>
				<KeyValue label="Branch">{`${s.branch ?? "–"}${s.channel ? ` (${s.channel})` : ""}`}</KeyValue>
				<KeyValue label="Rules">{s.rules ?? "–"}</KeyValue>
				<KeyValue label="Signed only">{yesNo(s.signedOnly)}</KeyValue>
				<KeyValue label="Pinned">{yesNo(s.pinned)}</KeyValue>
				<KeyValue label="Applied seq">{s.appliedSeq ?? "–"}</KeyValue>
				<KeyValue label="Remote debug">
					{rd ? `${rd.state ?? "?"}: ${fmtInt(rd.commands)} commands, ${fmtInt(rd.refused)} refused${rd.redacted ? `, ${fmtInt(rd.redacted)} redacted` : ""}` : "–"}
				</KeyValue>
			</div>
			<details className="group">
				<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Raw answer</summary>
				<JsonBlock value={data} className="mt-2" />
			</details>
		</div>
	);
}

/** `status` is the page's: it is fetched once as soon as the server polls (the header shows its place version). */
// The charts render only while the tab shows (a chart in a hidden panel has no size and warns on every resize).
export function StatusTab({ active, job, live, status }: { active: boolean; job: string; live: boolean; status: RemoteState<RemoteStatus> & { run: () => Promise<unknown> } }) {
	const run = status.run;
	return (
		<div className="space-y-6">
			<section className="space-y-2">
				<h2 className="text-sm font-medium">Last {CHART_MINUTES} minutes</h2>
				{active ? <ServerCharts job={job} live={live} /> : null}
			</section>
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Kernel status</h2>
				<RemoteBar state={status} onFetch={() => void run()} />
				{status.data ? <StatusFacts data={status.data} /> : null}
			</section>
		</div>
	);
}
