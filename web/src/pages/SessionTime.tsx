/**
 * Session time: the counterpart of Creator Hub's Performance > Session time "Explore" view, from our own events (query
 * session-time). Follows the filter bar's range; per bucket the average length of the sessions that ended in it (or
 * started), in total and per device class, playtime, playtime per player and sessions, with a summary vs the period
 * before, a length histogram and the bucket rows. Smoothing is a centered rolling average done here.
 */
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { EmptyState, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { change } from "@/lib/benchmarks";
import { fmtInt, fmtMinutes, fmtNum } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import { DEVICE_COLORS, groupLabel } from "@/lib/perf";
import type { Filters, SessionTimeBucket, SessionTimeResult, SessionTimeSummary } from "@/lib/types";

// Helpers ------------------------------------------------------------------------------------------------------------

/**
 * A centered rolling average over `window` points (odd; 1 or less = unchanged). Empty points (null) stay null and are
 * left out of their neighbours' averages, so gaps stay gaps.
 */
export function rollingAverage(values: readonly (number | null)[], window: number): (number | null)[] {
	if (window <= 1) return values.slice();
	const half = Math.floor(window / 2);
	return values.map((v, i) => {
		if (v === null) return null;
		let sum = 0;
		let n = 0;
		for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
			const x = values[j];
			if (x !== null) {
				sum += x;
				n += 1;
			}
		}
		return Math.round((sum / n) * 100) / 100;
	});
}

export type SessionMetric = "session" | "playtime" | "perPlayer" | "sessions";

export const METRICS: { key: SessionMetric; label: string; format(v: number): string; byDevice: boolean }[] = [
	{ key: "session", label: "Session time", format: (v) => fmtMinutes(v), byDevice: true },
	{ key: "playtime", label: "Playtime", format: (v) => fmtMinutes(v), byDevice: true },
	{ key: "perPlayer", label: "Playtime per player", format: (v) => fmtMinutes(v), byDevice: false },
	{ key: "sessions", label: "Sessions", format: (v) => fmtInt(v), byDevice: true },
];

/** One bucket's value for a metric: the total (weighted or Roblox-style for session time) or one device's. */
export function bucketValue(b: SessionTimeBucket, metric: SessionMetric, total: "weighted" | "roblox", dev?: string): number | null {
	if (dev !== undefined) {
		const d = b.byDevice[dev];
		if (metric === "session") return d?.avgMinutes ?? null;
		if (metric === "playtime") return b.sessions ? (d?.playtimeMinutes ?? 0) : null;
		if (metric === "sessions") return b.sessions ? (d?.sessions ?? 0) : null;
		return null;
	}
	if (metric === "session") return total === "roblox" ? b.robloxTotal : b.avgMinutes;
	if (metric === "playtime") return b.sessions ? b.playtimeMinutes : null;
	if (metric === "perPlayer") return b.playtimePerPlayer;
	return b.sessions ? b.sessions : null;
}

/** The chart rows: `total` and one key per device (d0, d1...: device names may not be CSS-safe), smoothed. */
export function chartRows(r: SessionTimeResult, metric: SessionMetric, total: "weighted" | "roblox", split: boolean, smooth: number) {
	const devs = split && METRICS.find((m) => m.key === metric)?.byDevice ? r.devices : [];
	const series: Record<string, (number | null)[]> = { total: rollingAverage(r.buckets.map((b) => bucketValue(b, metric, total)), smooth) };
	devs.forEach((d, i) => (series[`d${i}`] = rollingAverage(r.buckets.map((b) => bucketValue(b, metric, total, d)), smooth)));
	const rows = r.buckets.map((b, i) => ({ time: b.time, ...Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v[i]])) }));
	return { rows, devs };
}

/** "10-05 14:00" for buckets under a day, "2026-10-05" for days (UTC). */
function bucketLabel(iso: string, bucketMinutes: number, long = false): string {
	if (bucketMinutes >= 1440) return long ? iso.slice(0, 10) : iso.slice(5, 10);
	return long ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** "minute", "5 minutes", "hour", "day". */
export function stepLabel(minutes: number): string {
	if (minutes === 1) return "minute";
	if (minutes === 60) return "hour";
	if (minutes === 1440) return "day";
	return minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
}

/** The filter range's length, ms (a date-only `to` is inclusive); null when it can't be told. */
export function rangeSpan(filters: Filters, now = Date.now()): number | null {
	const from = filters.from === undefined ? null : typeof filters.from === "number" ? filters.from : Date.parse(filters.from);
	if (from === null || !Number.isFinite(from)) return null;
	let to = now;
	if (filters.to !== undefined) {
		to = typeof filters.to === "number" ? filters.to : Date.parse(filters.to) + (/^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? 86_400_000 : 0);
	}
	return Number.isFinite(to) && to > from ? to - from : null;
}

const BUCKETS = [
	{ value: "auto", label: "Auto step", minutes: 0 },
	{ value: "1", label: "1 minute", minutes: 1 },
	{ value: "5", label: "5 minutes", minutes: 5 },
	{ value: "15", label: "15 minutes", minutes: 15 },
	{ value: "60", label: "1 hour", minutes: 60 },
	{ value: "1440", label: "1 day", minutes: 1440 },
];
const SMOOTHING = ["off", "3", "5", "15"];
const MERGE = ["0", "2", "5", "10"];

// Page ---------------------------------------------------------------------------------------------------------------

function Tile({ label, info, value, current, previous, lowerIsBetter = false }: { label: string; info: string; value: string; current: number | null; previous: number | null; lowerIsBetter?: boolean }) {
	return (
		<Metric
			label={
				<span className="flex items-center gap-1">
					{label}
					<InfoTip>{info}</InfoTip>
				</span>
			}
			value={value}
			delta={<ChangeChip change={change(current, previous, lowerIsBetter)} against="the period before" />}
		/>
	);
}

function Tiles({ s, p }: { s: SessionTimeSummary; p: SessionTimeSummary }) {
	const min = (v: number | null) => (v === null ? "n/a" : fmtMinutes(v));
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
			<Tile label="Avg session time" info="Total length of the counted sessions / their number (weighted: busy buckets weigh more)." value={min(s.avgMinutes)} current={s.avgMinutes} previous={p.avgMinutes} />
			<Tile
				label="Roblox-style headline"
				info="The mean over the non-empty buckets of the Total line, Total being the mean of the device averages: our best guess at Creator Hub's minute-by-minute average over the period (pick 1-minute buckets to match it)."
				value={min(s.robloxHeadline)}
				current={s.robloxHeadline}
				previous={p.robloxHeadline}
			/>
			<Tile label="Median session" info="Half the counted sessions are shorter than this." value={min(s.medianMinutes)} current={s.medianMinutes} previous={p.medianMinutes} />
			<Tile label="Playtime" info="Total length of the counted sessions." value={min(s.playtimeMinutes)} current={s.playtimeMinutes} previous={p.playtimeMinutes} />
			<Tile label="Playtime per player" info="Playtime / distinct players among the counted sessions." value={min(s.playtimePerPlayer)} current={s.playtimePerPlayer} previous={p.playtimePerPlayer} />
			<Tile label="Sessions" info={`Sessions that are over and counted in the range (${fmtInt(s.running)} still running are not).`} value={fmtInt(s.sessions)} current={s.sessions} previous={p.sessions} />
		</div>
	);
}

function TrendChart({ r, metric, total, split, smooth }: { r: SessionTimeResult; metric: SessionMetric; total: "weighted" | "roblox"; split: boolean; smooth: number }) {
	const spec = METRICS.find((m) => m.key === metric) ?? METRICS[0];
	const { rows, devs } = chartRows(r, metric, total, split, smooth);
	const config: ChartConfig = {
		total: { label: metric === "session" ? (total === "roblox" ? "Total (avg of devices)" : "Total (weighted)") : "Total", color: "var(--foreground)" },
		...Object.fromEntries(devs.map((d, i) => [`d${i}`, { label: groupLabel("dev", d), color: DEVICE_COLORS[d] ?? "var(--chart-8)" }])),
	};
	return (
		<ChartContainer config={config} className="aspect-auto h-72 w-full">
			<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={6} minTickGap={32} tickFormatter={(t: string) => bucketLabel(t, r.bucketMinutes)} />
				<YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtNum(v, metric === "sessions" ? 0 : 1)} />
				<ChartTooltip
					content={
						<ChartTooltipContent
							labelFormatter={(_l, items) => bucketLabel(String((items?.[0]?.payload as { time?: string } | undefined)?.time ?? ""), r.bucketMinutes, true)}
							formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? spec.format(v) : "–"}`}
						/>
					}
				/>
				{devs.length ? <ChartLegend content={<ChartLegendContent />} /> : null}
				<Line dataKey="total" stroke="var(--color-total)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
				{devs.map((d, i) => (
					<Line key={d} dataKey={`d${i}`} stroke={`var(--color-d${i})`} strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
				))}
			</LineChart>
		</ChartContainer>
	);
}

function Histogram({ r }: { r: SessionTimeResult }) {
	const config: ChartConfig = { count: { label: "Sessions", color: "var(--chart-1)" } };
	return (
		<ChartContainer config={config} className="aspect-auto h-56 w-full">
			<BarChart data={r.histogram} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} interval={0} fontSize={11} />
				<YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
				<ChartTooltip content={<ChartTooltipContent />} />
				<Bar dataKey="count" fill="var(--color-count)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
			</BarChart>
		</ChartContainer>
	);
}

function BucketTable({ r }: { r: SessionTimeResult }) {
	const rows = r.buckets.filter((b) => b.sessions > 0).reverse();
	if (!rows.length) return <EmptyState>No sessions ended in this range.</EmptyState>;
	return (
		<div className="max-h-96 overflow-auto rounded-md border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Time</TableHead>
						<TableHead className="text-right">Sessions</TableHead>
						<TableHead className="text-right">Avg</TableHead>
						<TableHead className="text-right">Roblox-style</TableHead>
						{r.devices.map((d) => (
							<TableHead key={d} className="text-right">
								{groupLabel("dev", d)}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((b) => (
						<TableRow key={b.t}>
							<TableCell className="whitespace-nowrap">{bucketLabel(b.time, r.bucketMinutes, true)}</TableCell>
							<TableCell className="text-right tabular-nums">{fmtInt(b.sessions)}</TableCell>
							<TableCell className="text-right tabular-nums">{b.avgMinutes === null ? "–" : fmtMinutes(b.avgMinutes)}</TableCell>
							<TableCell className="text-right tabular-nums">{b.robloxTotal === null ? "–" : fmtMinutes(b.robloxTotal)}</TableCell>
							{r.devices.map((d) => {
								const v = b.byDevice[d];
								return (
									<TableCell key={d} className="text-right tabular-nums">
										{v?.avgMinutes == null ? "–" : `${fmtMinutes(v.avgMinutes)} (${fmtInt(v.sessions)})`}
									</TableCell>
								);
							})}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function Control({ label, value, onChange, options, width = "w-32" }: { label: string; value: string; onChange(v: string): void; options: { value: string; label: string; disabled?: boolean }[]; width?: string }) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger size="sm" className={width} aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value} disabled={o.disabled}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export default function SessionTime() {
	const { apiFilters } = useFilters();
	const [metricParam, setMetric] = useParam("metric", "session");
	const [splitParam, setSplit] = useParam("split", "total");
	const [totalParam, setTotal] = useParam("total", "weighted");
	const [bucket, setBucket] = useParam("bucket", "auto");
	const [smoothParam, setSmooth] = useParam("smooth", "off");
	const [byParam, setBy] = useParam("by", "end");
	const [mergeParam, setMerge] = useParam("merge", "0");
	const metric = (METRICS.some((m) => m.key === metricParam) ? metricParam : "session") as SessionMetric;
	const split = splitParam === "device";
	const total = totalParam === "roblox" ? "roblox" : "weighted";
	const by = byParam === "start" ? "start" : "end";
	const merge = MERGE.includes(mergeParam) ? Number(mergeParam) : 0;
	const smooth = SMOOTHING.includes(smoothParam) && smoothParam !== "off" ? Number(smoothParam) : 1;
	const span = rangeSpan(apiFilters);
	const bucketOptions = BUCKETS.map((b) => ({ value: b.value, label: b.label, disabled: b.minutes > 0 && span !== null && span / (b.minutes * 60_000) > 2000 }));
	const chosen = BUCKETS.find((b) => b.value === bucket && b.minutes > 0 && !bucketOptions.find((o) => o.value === b.value)?.disabled);
	const options = useMemo(() => ({ by, mergeGapMinutes: merge, ...(chosen ? { bucketMinutes: chosen.minutes } : {}) }), [by, merge, chosen]);
	const q = useAnalytics("session-time", options, { filters: apiFilters, keepPrevious: true });
	const spec = METRICS.find((m) => m.key === metric) ?? METRICS[0];
	return (
		<>
			<PageHeader
				title="Session time"
				description="Creator Hub's Session time Explore view, from our own events: how long sessions last, per time step, in total and by device. Follows the filter bar's range."
			/>
			<div className="space-y-6">
				<QueryState query={q} loadingRows={4}>{(r) => <Tiles s={r.summary} p={r.previous} />}</QueryState>
				<Section
					title={
						<span className="flex items-center gap-1.5">
							{spec.label}
							<InfoTip>
								A session is one visit (first to last event; Studio play tests left out). It is over with a leave row or after 10 minutes without events, and only
								sessions that are over count. By end (Creator Hub's way) a session counts in the step where it ended, with its full length, even if it started earlier;
								by start, where it started. Total (weighted) = all sessions of the step together; Roblox-style = the mean of the device averages (unknown devices left
								out). Merge rejoins joins a player's sessions closer than that (rejoins, teleports). Roblox doesn't publish how its Total line or its smoothing is
								computed, so neither choice is guaranteed to match it; smoothing here is a centered rolling average that skips empty steps.
							</InfoTip>
						</span>
					}
					description={`Per ${q.data ? stepLabel(q.data.bucketMinutes) : "step"}, sessions counted ${by === "end" ? "when they ended" : "when they started"}.`}
					contentClassName="space-y-3"
				>
					<div className="flex flex-col gap-2">
						<Tabs value={metric} onValueChange={setMetric}>
							<TabsList className="flex-wrap">
								{METRICS.map((m) => (
									<TabsTrigger key={m.key} value={m.key}>
										{m.label}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
						<div className="flex flex-wrap items-center gap-2">
							<ToggleGroup type="single" size="sm" variant="outline" value={split ? "device" : "total"} onValueChange={(v) => v && setSplit(v)} aria-label="Split">
								<ToggleGroupItem value="total">Total only</ToggleGroupItem>
								<ToggleGroupItem value="device" disabled={!spec.byDevice}>
									By device
								</ToggleGroupItem>
							</ToggleGroup>
							{metric === "session" ? (
								<Control
									label="Total"
									value={total}
									onChange={setTotal}
									width="w-48"
									options={[
										{ value: "weighted", label: "Total: weighted" },
										{ value: "roblox", label: "Total: avg of devices" },
									]}
								/>
							) : null}
							<Control label="Step" value={chosen ? chosen.value : "auto"} onChange={setBucket} options={bucketOptions} />
							<Control
								label="Smoothing"
								value={smooth > 1 ? String(smooth) : "off"}
								onChange={setSmooth}
								options={SMOOTHING.map((s) => ({ value: s, label: s === "off" ? "No smoothing" : `Smooth: ${s} steps` }))}
								width="w-40"
							/>
							<Control
								label="Count by"
								value={by}
								onChange={setBy}
								options={[
									{ value: "end", label: "Count by end" },
									{ value: "start", label: "Count by start" },
								]}
								width="w-36"
							/>
							<Control
								label="Merge rejoins"
								value={String(merge)}
								onChange={setMerge}
								options={MERGE.map((m) => ({ value: m, label: m === "0" ? "No merging" : `Merge rejoins < ${m} min` }))}
								width="w-48"
							/>
						</div>
					</div>
					<QueryState query={q} isEmpty={(r) => r.summary.sessions === 0} empty="No sessions ended in this range.">
						{(r) => (
							<>
								<TrendChart r={r} metric={metric} total={total} split={split} smooth={smooth} />
								{r.truncated ? <p className="text-xs text-muted-foreground">Too many sessions: the oldest part of the range may be missing. Pick a shorter range.</p> : null}
							</>
						)}
					</QueryState>
				</Section>
				<div className="grid gap-6 lg:grid-cols-2">
					<Section title="Session lengths" description="Sessions counted in the range, by length.">
						<QueryState query={q} isEmpty={(r) => r.summary.sessions === 0} empty="No sessions ended in this range.">
							{(r) => <Histogram r={r} />}
						</QueryState>
					</Section>
					<Section title="Per step" description="Newest first: sessions, the weighted and Roblox-style averages, and each device's average (sessions).">
						<QueryState query={q}>{(r) => <BucketTable r={r} />}</QueryState>
					</Section>
				</div>
			</div>
		</>
	);
}
