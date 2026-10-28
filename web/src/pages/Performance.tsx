/**
 * Performance: how the game runs on players' devices (frame rate, memory, ping) and on the servers (TPS, memory,
 * players), over time, by device class / input / screen size / branch / build, with p10, p50, p90 and p99 (p90 and p99 on the
 * bad side; p99 is marked as the worst case).
 * Every chart carries deploy marks (releases, rollbacks, kernel publishes, backup refreshes); clicking one filters to its
 * build. Builds can be compared side by side, or before vs after a mark over two equal windows. "vs previous period" adds
 * change chips per metric and, without a grouping, the previous period as a dashed line on each chart.
 *
 * Every table is the shared DataTable (sort, filter, columns, CSV); a number column sorts by its raw value.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import { DataTable, type DataColumn } from "@/components/data-table";
import { ChangeChip } from "@/components/ChangeChip";
import { CompareToggle } from "@/components/CompareToggle";
import { PerfChart } from "@/components/PerfChart";
import { PerfFlag } from "@/components/PerfFlag";
import { ToggleChip } from "@/components/ToggleChip";
import { EmptyState, ErrorState, LoadingBlock, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, ApiError } from "@/lib/api";
import { change } from "@/lib/benchmarks";
import { previousPeriod, useCompare, withPrevious, type PreviousPeriod } from "@/lib/compare";
import { describeRange, windowBucketMs } from "@/lib/filters";
import { fmtInt, shortId } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import {
	AROUND_HOURS,
	bucketText,
	CLIENT_GROUPS,
	CLIENT_METRIC_KEYS,
	delta,
	fmtDelta,
	fmtMetric,
	GROUP_BY_LABELS,
	groupLabel,
	MARK_KINDS,
	MARK_STYLE,
	markDetails,
	markTitle,
	METRICS,
	PERCENTILE_HELP,
	PERCENTILES,
	percentileName,
	pivot,
	rangeMs,
	SERIES_COLORS,
	SERVER_GROUPS,
	SERVER_METRIC_KEYS,
	seriesOf,
	type ChartRow,
	type ChartSeries,
	type ComparePeriod,
	type DeployMark,
	type Percentile,
	type PerfCompareResult,
	type PerfGroup,
	type PerfGroupBy,
	type PerfSeriesResult,
	type PerfServer,
	type ServerMetricPoint,
} from "@/lib/perf";
import { absoluteFlag, REGRESSION_PCT, regression, thresholdText, type Flag, type Regression } from "@/lib/perf-thresholds";
import type { Filters } from "@/lib/types";

// URL state -------------------------------------------------------------------------------------------------------------

/** Several URL parameters in one update (separate setSearchParams calls in one event overwrite each other). */
function useUrlPatch(): (patch: Record<string, string | null>) => void {
	const [, setParams] = useSearchParams();
	return useCallback(
		(patch) =>
			setParams((current) => {
				const next = new URLSearchParams(current);
				for (const [key, value] of Object.entries(patch)) {
					if (value === null || value === "") next.delete(key);
					else next.set(key, value);
				}
				return next;
			}),
		[setParams],
	);
}

// Marks -----------------------------------------------------------------------------------------------------------------

/** The filters' range for the marks read, `to` rounded up to the minute so the cache key holds still. */
function useRange(filters: Filters): { from: number; to: number } {
	return useMemo(() => {
		const now = Math.ceil(Date.now() / 60_000) * 60_000;
		return rangeMs({ ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) }, now);
	}, [filters.from, filters.to]);
}

function useMarks(range: { from: number; to: number }, branch: string | undefined) {
	return useQuery({
		queryKey: ["fleet", "marks", range.from, range.to, branch ?? ""],
		queryFn: ({ signal }) => api.fleetMarks({ since: range.from, until: range.to, ...(branch ? { branch } : {}), limit: 1000 }, signal),
		retry: false,
	});
}

function MarkLegend({ marks, error, shown, onToggle }: { marks: DeployMark[]; error: unknown; shown: boolean; onToggle(): void }) {
	const counts = MARK_KINDS.map((kind) => ({ kind, n: marks.filter((m) => m.kind === kind).length })).filter((c) => c.n > 0);
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<span className="font-medium text-foreground">Marks</span>
			{error ? (
				<span>{error instanceof ApiError && error.notFound ? "not on this backend (the fleet part is off, or it is older)" : "couldn't load"}</span>
			) : counts.length ? (
				counts.map((c) => (
					<span key={c.kind} className="inline-flex items-center gap-1.5">
						<span className="inline-block h-3 w-0.5" style={{ background: MARK_STYLE[c.kind].color }} aria-hidden />
						{c.n} {MARK_STYLE[c.kind].label.toLowerCase()}
						{c.n === 1 ? "" : "s"}
					</span>
				))
			) : (
				<span>none in this range</span>
			)}
			{marks.length ? (
				<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onToggle}>
					{shown ? "Hide marks" : "Show marks"}
				</Button>
			) : null}
		</div>
	);
}

function MarkBar({ mark, filtered, onFilter, onCompare, onClear }: { mark: DeployMark; filtered: boolean; onFilter(): void; onCompare(): void; onClear(): void }) {
	return (
		<Card className="gap-1 border-l-4 py-3" style={{ borderLeftColor: MARK_STYLE[mark.kind].color }}>
			<CardContent className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-0.5">
					<div className="text-sm font-medium">{markTitle(mark)}</div>
					<div className="text-xs text-muted-foreground">{markDetails(mark).join(" · ")}</div>
				</div>
				<div className="flex flex-wrap gap-2">
					{mark.artifact ? (
						<Button size="sm" variant={filtered ? "secondary" : "default"} onClick={onFilter} disabled={filtered}>
							{filtered ? "Filtered to this build" : "Filter to this build"}
						</Button>
					) : null}
					<Button size="sm" variant="outline" onClick={onCompare}>
						Before vs after
					</Button>
					<Button size="sm" variant="ghost" onClick={onClear}>
						Clear
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

// Tables ----------------------------------------------------------------------------------------------------------------

/** A count column: sorts by the number, shows it grouped. */
function countColumn<T>(id: string, header: string, value: (row: T) => number | null | undefined, extra: Partial<DataColumn<T>> = {}): DataColumn<T> {
	return { id, header, type: "number", accessor: (r) => value(r) ?? null, cell: (r) => fmtInt(value(r)), format: (v) => fmtInt(v as number | null), ...extra };
}

/**
 * A metric column ("Frame rate p90", "Frame rate p99 (worst)"): sorts by the raw value, shows it with its unit. `flag` marks a
 * cell orange or red when it is a possible problem (lib/perf-thresholds.ts); the tooltip says why.
 */
function metricColumn<T>(
	id: string,
	header: string,
	key: string,
	value: (row: T) => number | null | undefined,
	extra: Partial<DataColumn<T>> = {},
	flag?: (row: T) => Flag | null,
): DataColumn<T> {
	return {
		id,
		header,
		type: "number",
		accessor: (r) => value(r) ?? null,
		cell: (r) => {
			const text = fmtMetric(key, value(r));
			const f = flag?.(r);
			return f ? <PerfFlag flag={f}>{text}</PerfFlag> : text;
		},
		format: (v) => fmtMetric(key, v as number | null),
		className: "whitespace-nowrap",
		...extra,
	};
}

/** A group with its name for people (the "All" row is pinned on top when there are groups). */
type GroupRow = PerfGroup & { label: string };

export function groupColumns(side: "client" | "server", by: PerfGroupBy, metricKeys: readonly string[]): DataColumn<GroupRow>[] {
	return [
		{ id: "group", header: GROUP_BY_LABELS[by], type: by === "none" ? "text" : "enum", accessor: (g) => g.label, className: "whitespace-nowrap" },
		countColumn<GroupRow>("samples", "Samples", (g) => g.samples),
		...(side === "client"
			? [countColumn<GroupRow>("sessions", "Sessions", (g) => g.sessions), countColumn<GroupRow>("players", "Players", (g) => g.players)]
			: [countColumn<GroupRow>("servers", "Servers", (g) => g.servers)]),
		{ id: "seq", header: "Seq", type: "number", accessor: (g) => g.seq, title: "The highest deploy seq seen in the group", defaultHidden: true },
		...metricKeys.flatMap((k) => {
			const label = side === "server" && k === "mem" ? "Server memory" : (METRICS[k]?.label ?? k);
			return [
				...PERCENTILES.map((p) => {
					const lines = thresholdText(side, k, p);
					return metricColumn<GroupRow>(
						`${k}-${p}`,
						`${label} ${percentileName(p)}`,
						k,
						(g) => g.metrics[k]?.[p],
						{ title: lines ? `${PERCENTILE_HELP[p]}; ${lines}` : PERCENTILE_HELP[p] },
						(g) => absoluteFlag(side, k, p, g.metrics[k]?.[p], g.metrics[k]?.n),
					);
				}),
				metricColumn<GroupRow>(`${k}-avg`, `${label} avg`, k, (g) => g.metrics[k]?.avg, { defaultHidden: true }),
			];
		}),
		{ id: "lastSeen", header: "Last sample", type: "date", accessor: (g) => g.lastSeen, defaultHidden: true, className: "text-xs" },
	];
}

function GroupTable({ result, metricKeys }: { result: PerfSeriesResult; metricKeys: readonly string[] }) {
	const columns = useMemo(() => groupColumns(result.side, result.by, metricKeys), [result.side, result.by, metricKeys]);
	const overall: GroupRow = { ...result.overall, label: "All" };
	const groups: GroupRow[] = result.groups.map((g) => ({ ...g, label: groupLabel(result.by, g.key, g.seq) }));
	const grouped = result.by !== "none";
	return (
		<DataTable
			id={`perf-${result.side}-groups`}
			label={result.side === "client" ? "Client groups" : "Server groups"}
			columns={columns}
			data={grouped ? groups : [overall]}
			{...(grouped ? { pinnedRows: [overall] } : {})}
			rowId={(g) => g.key}
			maxHeight="28rem"
		/>
	);
}

// Charts ----------------------------------------------------------------------------------------------------------------

interface MarkProps {
	marks: DeployMark[];
	selectedMark: string | null;
	onMark(mark: DeployMark): void;
}

function MetricCard({ title, about, children }: { title: string; about: string; children: React.ReactNode }) {
	return (
		<Card className="gap-2 py-4">
			<CardContent className="space-y-2">
				<div>
					<div className="text-sm font-medium">{title}</div>
					<div className="text-xs text-muted-foreground">{about}</div>
				</div>
				{children}
			</CardContent>
		</Card>
	);
}

/** The previous period's answer and how far back it is. */
interface PreviousSeries {
	result: PerfSeriesResult;
	shiftMs: number;
}

/** The previous period as a dashed series next to the one line of an ungrouped chart (none when the chart is grouped). */
export function previousLine(result: PerfSeriesResult, previous: PreviousSeries | undefined, rows: ChartRow[], metric: string, pct: Percentile | "players"): { rows: ChartRow[]; series: ChartSeries[] } | undefined {
	const current = seriesOf(result);
	const before = previous ? seriesOf(previous.result) : [];
	if (!previous || result.by !== "none" || current.length !== 1 || before.length !== 1) return undefined;
	return {
		rows: withPrevious(rows, pivot(previous.result, metric, pct), previous.shiftMs, (before[0] as ChartSeries).id, "prev") as ChartRow[],
		series: [...current, { id: "prev", key: "prev", label: "Previous period", color: "var(--muted-foreground)", dashed: true }],
	};
}

/** The overall picked percentile of each metric with its change against the previous period. */
function PeriodTiles({ result, previous, metricKeys, pct }: { result: PerfSeriesResult; previous: PerfSeriesResult; metricKeys: readonly string[]; pct: Percentile }) {
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
			{metricKeys.map((k) => {
				const now = result.overall.metrics[k]?.[pct] ?? null;
				const then = previous.overall.metrics[k]?.[pct] ?? null;
				return (
					<Metric
						key={k}
						label={`${result.side === "server" && k === "mem" ? "Server memory" : (METRICS[k]?.label ?? k)}, ${percentileName(pct)}`}
						value={fmtMetric(k, now)}
						sub={`before: ${fmtMetric(k, then)}`}
						delta={<ChangeChip change={change(now, then, !(METRICS[k]?.higherIsBetter ?? true))} against="the previous period" />}
					/>
				);
			})}
		</div>
	);
}

function SeriesCharts({ result, metricKeys, pct, players, previous, ...marks }: { result: PerfSeriesResult; metricKeys: readonly string[]; pct: Percentile; players?: boolean; previous?: PreviousSeries } & MarkProps) {
	const plain = seriesOf(result);
	const charts: { key: string; title: string; about: string; rows: ChartRow[]; series: ChartSeries[] }[] = metricKeys.map((k) => {
		const rows = pivot(result, k, pct);
		const withBefore = previousLine(result, previous, rows, k, pct);
		return {
			key: k,
			title: `${METRICS[k]?.label ?? k}, ${percentileName(pct)}`,
			about: `${METRICS[k]?.about ?? ""} Line: ${PERCENTILE_HELP[pct]}.${withBefore ? " Dashed: the previous period." : ""}`,
			rows: withBefore?.rows ?? rows,
			series: withBefore?.series ?? plain,
		};
	});
	if (players) {
		const rows = pivot(result, "", "players");
		const withBefore = previousLine(result, previous, rows, "", "players");
		charts.push({ key: "players", title: "Players", about: METRICS.players.about, rows: withBefore?.rows ?? rows, series: withBefore?.series ?? plain });
	}
	return (
		<div className="grid gap-3 lg:grid-cols-3">
			{charts.map((c) => (
				<MetricCard key={c.key} title={c.title} about={c.about}>
					<PerfChart
						label={`${c.title} over time`}
						rows={c.rows}
						series={c.series}
						fromMs={result.fromMs}
						toMs={result.toMs}
						format={(v) => fmtMetric(c.key, v)}
						marks={marks.marks}
						selectedMark={marks.selectedMark}
						onMarkClick={marks.onMark}
						legend
					/>
				</MetricCard>
			))}
		</div>
	);
}

/** The chart steps (minutes) a user may pick instead of the window's own; offered when the window holds 2 to 400 of them. */
export const STEP_MINUTES = [1, 5, 15, 60, 360, 1440];

export function stepChoices(spanMs: number): number[] {
	return STEP_MINUTES.filter((m) => m * 60_000 * 2 <= spanMs && spanMs / (m * 60_000) <= 400);
}

/** The series options: grouping, and the picked step (none = the backend's step for the window). */
function seriesOptions(by: PerfGroupBy, stepMinutes: number | undefined) {
	return { by, maxGroups: 8, ...(stepMinutes ? { bucketMinutes: stepMinutes } : {}) };
}

interface SectionProps extends MarkProps {
	by: PerfGroupBy;
	pct: Percentile;
	filters: Filters;
	stepMinutes: number | undefined;
	/** Under "vs previous period": the period before. */
	period?: PreviousPeriod;
}

/** The section's answer for the previous period (only while comparing). */
function usePrevious(name: "perf-client" | "perf-server", options: object, period: PreviousPeriod | undefined): PreviousSeries | undefined {
	const q = useAnalytics(name, options, { enabled: period !== undefined, ...(period ? { filters: period.filters } : {}) });
	return period && q.data ? { result: q.data, shiftMs: period.shiftMs } : undefined;
}

function ClientSection({ by, pct, filters, stepMinutes, period, ...marks }: SectionProps) {
	const q = useAnalytics("perf-client", seriesOptions(by, stepMinutes), { filters });
	const previous = usePrevious("perf-client", seriesOptions(by, stepMinutes), period);
	return (
		<Section
			title="Players' devices"
			description={q.data ? `Frame rate, memory and ping from tech/client, per ${bucketText(q.data.bucketMs)}, by ${GROUP_BY_LABELS[by].toLowerCase()}.` : "Frame rate, memory and ping from tech/client."}
			contentClassName="space-y-3"
		>
			<QueryState
				query={q}
				loadingRows={6}
				isEmpty={(r) => r.overall.samples === 0}
				empty="No client samples in this range. Clients send tech/client every techEvery seconds (60 by default) while the AnalyticsEngine runs."
			>
				{(r) => (
					<>
						{previous ? <PeriodTiles result={r} previous={previous.result} metricKeys={CLIENT_METRIC_KEYS} pct={pct} /> : null}
						<SeriesCharts result={r} metricKeys={CLIENT_METRIC_KEYS} pct={pct} {...(previous ? { previous } : {})} {...marks} />
						{r.groupsTotal > r.groups.length ? <p className="text-xs text-muted-foreground">The {r.groups.length} busiest of {r.groupsTotal} groups are shown.</p> : null}
						<GroupTable result={r} metricKeys={CLIENT_METRIC_KEYS} />
					</>
				)}
			</QueryState>
		</Section>
	);
}

function ServerSection({ by, pct, filters, stepMinutes, period, ...marks }: SectionProps) {
	const serverBy = SERVER_GROUPS.includes(by) ? by : "none";
	const q = useAnalytics("perf-server", seriesOptions(serverBy, stepMinutes), { filters });
	const previous = usePrevious("perf-server", seriesOptions(serverBy, stepMinutes), period);
	const note = serverBy !== by ? ` Servers have no ${GROUP_BY_LABELS[by].toLowerCase()}: shown for everything.` : "";
	return (
		<Section
			title="Servers"
			description={`TPS (the Heartbeat rate), physics FPS, memory and players from tech/server${q.data ? `, per ${bucketText(q.data.bucketMs)}` : ""}. Device, player and experiment filters don't apply to servers.${note}`}
			contentClassName="space-y-3"
		>
			<QueryState query={q} loadingRows={6} isEmpty={(r) => r.overall.samples === 0} empty="No server samples in this range (tech/server, every techEvery seconds per server).">
				{(r) => (
					<>
						{previous ? <PeriodTiles result={r} previous={previous.result} metricKeys={SERVER_METRIC_KEYS} pct={pct} /> : null}
						<SeriesCharts result={r} metricKeys={["tps", "mem"]} pct={pct} players {...(previous ? { previous } : {})} {...marks} />
						<GroupTable result={r} metricKeys={SERVER_METRIC_KEYS} />
					</>
				)}
			</QueryState>
		</Section>
	);
}

// Live servers (the heartbeat-metrics contract) -----------------------------------------------------------------------------

/** Unix seconds or ms -> ms. */
const ms = (t: number) => (t < 1e11 ? t * 1000 : t);

export function historyRows(points: ServerMetricPoint[]): { rows: ChartRow[]; fromMs: number; toMs: number } {
	const rows = points
		.map((p) => ({ t: ms(p.t), tps: p.tps, tpsMin: p.tpsMin, physFps: p.physFps, memMb: p.memMb, luaMb: p.luaMb, players: p.players }) as ChartRow)
		.sort((a, b) => a.t - b.t);
	return { rows, fromMs: rows[0]?.t ?? 0, toMs: (rows.at(-1)?.t ?? 0) + 1 };
}

function ServerHistory({ job, since, ...marks }: { job: string; since: number } & MarkProps) {
	const q = useQuery({ queryKey: ["fleet", "server-metrics", job, since], queryFn: ({ signal }) => api.serverMetrics(job, since, signal), retry: false });
	if (q.isPending) return <LoadingBlock rows={3} />;
	if (q.isError) {
		return q.error instanceof ApiError && q.error.notFound ? (
			<EmptyState>This backend keeps no per-server history yet (update it: the history came with kernel 0.4.2's heartbeat metrics).</EmptyState>
		) : (
			<ErrorState error={q.error} />
		);
	}
	if (!q.data.length) return <EmptyState>No history for this server in this range.</EmptyState>;
	const { rows, fromMs, toMs } = historyRows(q.data);
	const charts = [
		{ title: "TPS", about: "The Heartbeat rate and the slowest step in each heartbeat.", key: "tps", series: [{ id: "tps", key: "tps", label: "TPS" }, { id: "tpsMin", key: "tpsMin", label: "TPS (min)" }] },
		{ title: "Memory", about: "Total and Lua heap, MB.", key: "mem", series: [{ id: "memMb", key: "memMb", label: "Memory" }, { id: "luaMb", key: "luaMb", label: "Lua heap" }] },
		{ title: "Players", about: "Players on this server.", key: "players", series: [{ id: "players", key: "players", label: "Players" }] },
	];
	return (
		<div className="grid gap-3 lg:grid-cols-3">
			{charts.map((c) => (
				<MetricCard key={c.title} title={c.title} about={c.about}>
					<PerfChart
						label={`${c.title} of server ${shortId(job, 6)}`}
						rows={rows}
						series={c.series.map((s, i) => ({ ...s, color: SERIES_COLORS[i] as string }))}
						fromMs={fromMs}
						toMs={toMs}
						format={(v) => fmtMetric(c.key, v)}
						marks={marks.marks}
						selectedMark={marks.selectedMark}
						onMarkClick={marks.onMark}
						legend
					/>
				</MetricCard>
			))}
		</div>
	);
}

/** The live servers' columns; the last one opens a server's history (`job` is the open one). */
export function liveServerColumns(job: string, setJob: (job: string) => void): DataColumn<PerfServer>[] {
	return [
		{ id: "job", header: "Server", type: "text", accessor: (s) => s.job, cell: (s) => <span title={s.job}>{shortId(s.job, 6)}</span>, className: "font-mono text-xs" },
		{ id: "branch", header: "Branch", type: "enum", accessor: (s) => s.branch },
		{
			id: "build",
			header: "Build",
			type: "enum",
			accessor: (s) => s.artifact,
			cell: (s) => `${s.artifact ?? "–"}${s.appliedSeq ? ` #${s.appliedSeq}` : ""}`,
			className: "font-mono text-xs whitespace-nowrap",
		},
		countColumn<PerfServer>("players", "Players", (s) => s.players),
		metricColumn<PerfServer>("tps", "TPS", "tps", (s) => s.tps, {}, (s) => absoluteFlag("server", "tps", null, s.tps)),
		metricColumn<PerfServer>("tpsMin", "TPS min", "tps", (s) => s.tpsMin, { title: "The slowest step in the last heartbeat window" }),
		metricColumn<PerfServer>("physFps", "Physics FPS", "physFps", (s) => s.physFps, {}, (s) => absoluteFlag("server", "physFps", null, s.physFps)),
		metricColumn<PerfServer>("memMb", "Memory", "mem", (s) => s.memMb, {}, (s) => absoluteFlag("server", "mem", null, s.memMb)),
		metricColumn<PerfServer>("luaMb", "Lua heap", "mem", (s) => s.luaMb),
		{
			id: "history",
			header: "History",
			accessor: () => null,
			cell: (s) => (
				<ToggleChip pressed={s.job === job} onClick={() => setJob(s.job === job ? "" : s.job)}>
					History
				</ToggleChip>
			),
			sortable: false,
			filter: false,
			searchable: false,
			hideable: false,
			align: "right",
			exportValue: () => null,
		},
	];
}

function LiveServers({ branch, since, ...marks }: { branch: string | undefined; since: number } & MarkProps) {
	const [job, setJob] = useParam("job");
	const q = useQuery({ queryKey: ["fleet", "perf-servers", branch ?? ""], queryFn: ({ signal }) => api.perfServers(branch, signal), refetchInterval: 30_000, retry: false });
	const columns = useMemo(() => liveServerColumns(job, setJob), [job, setJob]);
	return (
		<Section title="Live servers" description="Each server's latest TPS and memory from its heartbeat; pick one for its history." contentClassName="space-y-3">
			<QueryState query={q} isEmpty={(d) => d.servers.length === 0} empty="No live servers right now.">
				{(d) => {
					const hasMetrics = d.servers.some((s) => typeof s.tps === "number" || typeof s.memMb === "number");
					return (
						<>
							{!hasMetrics ? <p className="text-xs text-muted-foreground">These heartbeats carry no TPS or memory yet (kernel 0.4.2 sends them).</p> : null}
							<DataTable
								id="perf-live-servers"
								label="Live servers"
								columns={columns}
								data={d.servers}
								rowId={(s) => s.job}
								isRowSelected={(s) => s.job === job}
								maxHeight="24rem"
							/>
						</>
					);
				}}
			</QueryState>
			{job ? <ServerHistory job={job} since={since} {...marks} /> : null}
		</Section>
	);
}

// Compare -----------------------------------------------------------------------------------------------------------------

const COMPARE_ROWS: { side: "client" | "server"; key: string }[] = [
	...CLIENT_METRIC_KEYS.map((key) => ({ side: "client" as const, key })),
	...SERVER_METRIC_KEYS.map((key) => ({ side: "server" as const, key })),
];

function periodLabel(result: PerfCompareResult, p: ComparePeriod): string {
	if (result.mode === "around") {
		const hours = Math.round((result.windowMs ?? 0) / 3_600_000);
		return `${p.key === "before" ? "Before" : "After"} (${hours ? `${hours} h` : `${Math.round((result.windowMs ?? 0) / 60_000)} min`})`;
	}
	return groupLabel("art", p.key, p.seq);
}

/** One row of the compare table: a metric at a percentile (or a sample count) per period, and the change. */
interface CompareRow {
	id: string;
	label: string;
	/** The metric key for formatting, or "samples". */
	key: string;
	values: (number | null)[];
	change: ReturnType<typeof delta>;
	/** Samples behind each period's number (the metric's `n`); empty for the sample-count rows. */
	counts: number[];
	/** Per period: an absolute problem flag (lib/perf-thresholds.ts), or null. */
	flags: (Flag | null)[];
	/** What the change says (too few samples, worse, better), or null. */
	regression: Regression | null;
}

/**
 * Which of two periods the change is measured from and to: before -> after, and the older build -> the newer one (lower seq
 * first; the backend lists builds newest first, so without seqs the second column is the base). Null unless there are two.
 */
export function changeOrder(result: PerfCompareResult): [base: number, value: number] | null {
	const [a, b] = result.periods;
	if (!a || !b || result.periods.length !== 2) return null;
	if (result.mode === "around") return a.key === "after" ? [1, 0] : [0, 1];
	if (typeof a.seq === "number" && typeof b.seq === "number" && a.seq !== b.seq) return a.seq < b.seq ? [0, 1] : [1, 0];
	return [1, 0];
}

export function compareRows(result: PerfCompareResult): { pinned: CompareRow[]; rows: CompareRow[] } {
	const periods = result.periods;
	const order = changeOrder(result);
	const info = (side: "client" | "server", key: string) => (side === "client" ? result.clientMetrics : result.serverMetrics).find((m) => m.key === key);
	const pinned: CompareRow[] = [
		{ id: "client-samples", label: "Client samples", key: "samples", values: periods.map((p) => p.client.samples), change: null, counts: [], flags: [], regression: null },
		{ id: "server-samples", label: "Server samples", key: "samples", values: periods.map((p) => p.server.samples), change: null, counts: [], flags: [], regression: null },
	];
	const rows = COMPARE_ROWS.flatMap(({ side, key }) =>
		PERCENTILES.map((pct): CompareRow => {
			const values = periods.map((p) => p[side].metrics[key]?.[pct] ?? null);
			const counts = periods.map((p) => p[side].metrics[key]?.n ?? 0);
			const higher = info(side, key)?.higherIsBetter ?? true;
			return {
				id: `${side}-${key}-${pct}`,
				label: `${side === "server" && key === "mem" ? "Server memory" : (METRICS[key]?.label ?? key)} ${percentileName(pct)}`,
				key,
				values,
				change: order ? delta(values[order[0]], values[order[1]], higher) : null,
				counts,
				flags: values.map((v, i) => absoluteFlag(side, key, pct, v, counts[i])),
				regression: order ? regression(values[order[0]], values[order[1]], higher, counts[order[0]] ?? 0, counts[order[1]] ?? 0) : null,
			};
		}),
	);
	return { pinned, rows };
}

function compareColumns(result: PerfCompareResult): DataColumn<CompareRow>[] {
	const fmt = (row: CompareRow, v: number | null | undefined) => (row.key === "samples" ? fmtInt(v) : fmtMetric(row.key, v));
	const columns: DataColumn<CompareRow>[] = [
		{ id: "metric", header: "Metric", type: "text", accessor: (r) => r.label, className: "whitespace-nowrap", hideable: false },
		...result.periods.map(
			(p, i): DataColumn<CompareRow> => ({
				id: `period-${i}`,
				header: periodLabel(result, p),
				type: "number",
				accessor: (r) => r.values[i] ?? null,
				cell: (r) => {
					const text = fmt(r, r.values[i]);
					const flag = r.flags[i];
					return flag ? <PerfFlag flag={flag}>{text}</PerfFlag> : text;
				},
				format: (v, r) => fmt(r, v as number | null),
				className: "whitespace-nowrap",
				headerClassName: "whitespace-nowrap",
				filter: false,
			}),
		),
	];
	const order = changeOrder(result);
	if (order) {
		const [base, value] = order.map((i) => result.periods[i] as ComparePeriod);
		columns.push({
			id: "change",
			header: "Change",
			type: "number",
			hint: result.mode === "around" ? "after vs before" : "newer vs older",
			title: `${periodLabel(result, value as ComparePeriod)} against ${periodLabel(result, base as ComparePeriod)}; orange is worse by over ${REGRESSION_PCT.warning}%, red by over ${REGRESSION_PCT.critical}%, green is better`,
			accessor: (r) => (r.change ? Math.round(r.change.pct * 10) / 10 : null),
			cell: (r) => {
				if (r.key === "samples") return "";
				const reg = r.regression;
				const text = fmtDelta(r.change);
				const word = r.change && r.change.better !== null ? <span className="ml-1 text-xs">{r.change.better ? "better" : "worse"}</span> : null;
				if (reg?.kind === "few") {
					return (
						<span className="text-muted-foreground" title={reg.why}>
							{text}
							<span className="ml-1 text-xs">few samples</span>
						</span>
					);
				}
				if (reg?.kind === "worse" && reg.level) {
					return (
						<PerfFlag flag={{ level: reg.level, why: reg.why }}>
							{text}
							{word}
						</PerfFlag>
					);
				}
				return (
					<span className={cn(reg?.kind === "better" && "text-[var(--status-good)]")} title={reg?.why}>
						{text}
						{word}
					</span>
				);
			},
			format: (_v, r) => fmtDelta(r.change),
			filter: false,
		});
	}
	return columns;
}

export function CompareTable({ result }: { result: PerfCompareResult }) {
	const columns = useMemo(() => compareColumns(result), [result]);
	const { pinned, rows } = useMemo(() => compareRows(result), [result]);
	return (
		<DataTable
			id={`perf-compare-${result.mode}`}
			label={result.mode === "around" ? "Before vs after" : "Builds side by side"}
			columns={columns}
			data={rows}
			pinnedRows={pinned}
			rowId={(r) => r.id}
			search={false}
			pageSize={100}
		/>
	);
}

function CompareSection({ filters, marks, seqOf }: { filters: Filters; marks: DeployMark[]; seqOf: Map<string, number> }) {
	const [mode, setMode] = useParam("cmode", "builds");
	const [picked, setPicked] = useParam("cmp");
	const [aroundId, setAround] = useParam("around");
	const [hoursParam, setHours] = useParam("hours", "24");
	const hours = AROUND_HOURS.includes(Number(hoursParam)) ? Number(hoursParam) : 24;
	const arts = picked ? picked.split(",").filter(Boolean).slice(0, 6) : [];
	const values = useAnalytics("values", {}, { filters: { ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) } });
	const now = Date.now();
	const candidates = [...marks].filter((m) => m.at < now - 5 * 60_000).reverse();
	const around = marks.find((m) => m.id === aroundId) ?? (mode === "around" ? candidates[0] : undefined);
	const aroundFilters: Filters = { ...filters, ...(around?.branch && around.kind !== "kernel" && around.kind !== "backup" ? { branch: around.branch } : {}) };
	const q = useAnalytics(
		"perf-compare",
		mode === "around" ? { mode: "around", at: around?.at, hours } : { mode: "builds", ...(arts.length ? { arts } : {}) },
		{ filters: mode === "around" ? aroundFilters : filters, enabled: mode !== "around" || around !== undefined },
	);
	// A build's seq for its button: from the marks in range, else from the comparison (a build deployed before the range).
	const seqs = new Map(seqOf);
	if (q.data?.mode === "builds") for (const p of q.data.periods) if (typeof p.seq === "number" && !seqs.has(p.key)) seqs.set(p.key, p.seq);
	const toggle = (art: string) => {
		const next = arts.includes(art) ? arts.filter((a) => a !== art) : [...arts, art].slice(-6);
		setPicked(next.join(","));
	};
	return (
		<Section
			title="Compare"
			description="Builds side by side over the range, or before vs after a mark over two windows of the same length."
			contentClassName="space-y-3"
			actions={
				<Tabs value={mode === "around" ? "around" : "builds"} onValueChange={setMode}>
					<TabsList>
						<TabsTrigger value="builds">Builds</TabsTrigger>
						<TabsTrigger value="around">Before vs after</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			<div id="compare" className="scroll-mt-16" />
			{mode === "around" ? (
				<div className="flex flex-wrap items-center gap-2">
					<Select value={around?.id ?? ""} onValueChange={setAround}>
						<SelectTrigger size="sm" className="w-72 max-w-full" aria-label="Mark">
							<SelectValue placeholder="Pick a mark" />
						</SelectTrigger>
						<SelectContent>
							{candidates.slice(0, 100).map((m) => (
								<SelectItem key={m.id} value={m.id}>
									{markTitle(m)} · {m.time.slice(5, 16).replace("T", " ")}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={String(hours)} onValueChange={setHours}>
						<SelectTrigger size="sm" className="w-36" aria-label="Window">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{AROUND_HOURS.map((h) => (
								<SelectItem key={h} value={String(h)}>
									{h < 24 ? `${h} h each side` : `${h / 24} d each side`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{around?.branch && around.kind !== "kernel" && around.kind !== "backup" ? <span className="text-xs text-muted-foreground">Branch {around.branch} only.</span> : null}
				</div>
			) : (
				<div className="flex flex-wrap gap-1.5" role="group" aria-label="Builds to compare">
					{(values.data?.art ?? []).slice(0, 16).map((a) => (
						<ToggleChip key={a.value} pressed={arts.includes(a.value)} className="font-mono text-xs" onClick={() => toggle(a.value)}>
							{groupLabel("art", a.value, seqs.get(a.value))}
						</ToggleChip>
					))}
					{arts.length ? (
						<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPicked("")}>
							Busiest builds
						</Button>
					) : (
						<span className="self-center text-xs text-muted-foreground">Showing the busiest builds; pick up to 6.</span>
					)}
				</div>
			)}
			{mode === "around" && !around ? (
				<EmptyState>No marks in this range to compare around.</EmptyState>
			) : (
				<QueryState query={q} loadingRows={5} isEmpty={(r) => r.periods.every((p) => p.client.samples === 0 && p.server.samples === 0)} empty="No samples to compare.">
					{(r) => <CompareTable result={r} />}
				</QueryState>
			)}
		</Section>
	);
}

// The page ----------------------------------------------------------------------------------------------------------------

export default function Performance() {
	const { state, apiFilters } = useFilters();
	const patch = useUrlPatch();
	const [byParam, setBy] = useParam("by", "none");
	const by = (CLIENT_GROUPS as string[]).includes(byParam) ? (byParam as PerfGroupBy) : "none";
	const [pctParam, setPct] = useParam("pct", "p50");
	const pct = (PERCENTILES as string[]).includes(pctParam) ? (pctParam as Percentile) : "p50";
	const [markId] = useParam("mark");
	const [marksShown] = useParam("marks", "on");
	const range = useRange(apiFilters);
	const span = range.to - range.from;
	const steps = stepChoices(span);
	const [stepParam, setStep] = useParam("step", "auto");
	const stepMinutes = steps.includes(Number(stepParam)) ? Number(stepParam) : undefined;
	const branch = typeof apiFilters.branch === "string" ? apiFilters.branch : undefined;
	const marksQ = useMarks(range, branch);
	const allMarks = marksQ.data ?? [];
	const marks = marksShown === "off" ? [] : allMarks;
	const selected = allMarks.find((m) => m.id === markId);
	const seqOf = useMemo(() => new Map(allMarks.filter((m) => m.artifact && m.seq !== null && m.kind !== "backup").map((m) => [m.artifact as string, m.seq as number])), [allMarks]);
	const onMark = useCallback((m: DeployMark) => patch({ mark: m.id, ...(m.artifact && m.kind !== "kernel" ? { art: m.artifact } : {}) }), [patch]);
	const markProps: MarkProps = { marks, selectedMark: selected?.id ?? null, onMark };
	const [compare] = useCompare();
	const before = useMemo(() => previousPeriod(state), [state]);
	const period = compare ? before : undefined;
	return (
		<>
			<PageHeader
				title="Performance"
				description={`Frame rate, memory and ping on players' devices, and TPS and memory on the servers, ${describeRange(state)}. p90 and p99 are on the bad side: p90 is the value 90% of samples reach or beat, p99 (marked worst) the value 99% do. p10 is the low end: 10% of samples are at or below it.`}
				actions={
					<>
						<Select value={by} onValueChange={setBy}>
							<SelectTrigger size="sm" className="w-40" aria-label="Group by">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CLIENT_GROUPS.map((g) => (
									<SelectItem key={g} value={g}>
										By {GROUP_BY_LABELS[g].toLowerCase()}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select value={stepMinutes ? String(stepMinutes) : "auto"} onValueChange={setStep}>
							<SelectTrigger size="sm" className="w-40" aria-label="Chart step">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">Step: auto ({bucketText(windowBucketMs(span))})</SelectItem>
								{steps.map((m) => (
									<SelectItem key={m} value={String(m)}>
										Step: {bucketText(m * 60_000)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<CompareToggle disabled={!before} />
						<ToggleGroup type="single" variant="outline" size="sm" value={pct} onValueChange={(v) => v && setPct(v)} aria-label="Percentile">
							{PERCENTILES.map((p) => (
								<ToggleGroupItem key={p} value={p} className="px-2.5 text-xs" title={PERCENTILE_HELP[p]}>
									{p}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</>
				}
			/>
			<MarkLegend marks={allMarks} error={marksQ.error} shown={marksShown !== "off"} onToggle={() => patch({ marks: marksShown === "off" ? null : "off" })} />
			{selected ? (
				<MarkBar
					mark={selected}
					filtered={!!selected.artifact && apiFilters.art === selected.artifact}
					onFilter={() => patch({ art: selected.artifact })}
					onCompare={() => {
						patch({ cmode: "around", around: selected.id });
						document.getElementById("compare")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
					}}
					onClear={() => patch({ mark: null, ...(apiFilters.art === selected.artifact ? { art: null } : {}) })}
				/>
			) : null}
			<ClientSection by={by} pct={pct} filters={apiFilters} stepMinutes={stepMinutes} {...(period ? { period } : {})} {...markProps} />
			<ServerSection by={by} pct={pct} filters={apiFilters} stepMinutes={stepMinutes} {...(period ? { period } : {})} {...markProps} />
			<LiveServers branch={branch} since={range.from} {...markProps} />
			<CompareSection filters={apiFilters} marks={allMarks} seqOf={seqOf} />
		</>
	);
}
