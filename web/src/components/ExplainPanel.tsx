/**
 * "Explain this change": a side panel that breaks a metric's change (the filter bar's range vs the period before, as the
 * "vs previous period" chips compare) down by segment with the `explain` query. A plain-language headline first, then
 * per dimension a diverging chart of each segment's rate and mix effects and a table of both periods. A segment's
 * name drills in: that segment split by the other dimensions (one level). The panel's metric lives in the URL
 * (`explain=d1`), so an explained view can be shared.
 */
import { ArrowLeft, ChartBarStacked } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { cn } from "cn";
import { EmptyState, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { previousPeriod } from "@/lib/compare";
import {
	DIMENSION_LABELS,
	EXPLAIN_METRIC_LABELS,
	EXPLAIN_METRICS,
	explainHeadline,
	fmtMetric,
	fmtSigned,
	rankDimensions,
	segmentName,
	segmentPhrase,
} from "@/lib/explain";
import { describeRange } from "@/lib/filters";
import { fmtInt, fmtPct, fmtTime } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { ExplainDimension, ExplainMetric, ExplainResult, ExplainSegment, ExplainWithin } from "@/lib/types";

export const EXPLAIN_PARAM = "explain";

/** The open panel's metric (from the URL) and a setter ("" closes it). */
export function useExplain(): [ExplainMetric | "", (metric: ExplainMetric | "") => void] {
	const [value, set] = useParam(EXPLAIN_PARAM);
	const metric = (EXPLAIN_METRICS as string[]).includes(value) ? (value as ExplainMetric) : "";
	return [metric, set as (metric: ExplainMetric | "") => void];
}

/** The small "Explain" button next to a tile's change chip. */
export function ExplainButton({ metric, label }: { metric: ExplainMetric; label: string }) {
	const [, open] = useExplain();
	return (
		<Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px] text-muted-foreground" onClick={() => open(metric)} aria-label={`Explain this change: ${label}`} title="Which segments caused this change">
			<ChartBarStacked />
			Why?
		</Button>
	);
}

const chartConfig = {
	rate: { label: "Rate (the segment itself)", color: "var(--chart-1)" },
	mix: { label: "Mix (its share of players)", color: "var(--chart-2)" },
	change: { label: "Change", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** Axis ticks: points for shares, else the plain number. */
const tick = (unit: ExplainResult["unit"]) => (v: number) => (unit === "share" ? `${(v * 100).toFixed(Math.abs(v) < 0.01 ? 1 : 0)}` : Math.abs(v) >= 100 ? fmtInt(v) : String(Math.round(v * 100) / 100));

function ContributionChart({ data, dimension }: { data: ExplainResult; dimension: ExplainResult["dimensions"][number] }) {
	const rows = dimension.segments.map((s) => ({ name: segmentName(dimension.dimension, s), rate: s.rate, mix: s.mix, change: s.contribution }));
	const keys = data.kind === "count" ? (["change"] as const) : (["rate", "mix"] as const);
	return (
		<ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height: 48 + rows.length * 30 }}>
			<BarChart data={rows} layout="vertical" stackOffset="sign" margin={{ top: 4, right: 12, bottom: 0, left: 4 }} barCategoryGap={6}>
				<CartesianGrid horizontal={false} />
				<XAxis type="number" tickLine={false} axisLine={false} tickFormatter={tick(data.unit)} />
				<YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={130} tick={{ fontSize: 11 }} />
				<ReferenceLine x={0} stroke="var(--border)" />
				<ChartTooltip cursor={{ fillOpacity: 0.3 }} content={<ChartTooltipContent formatter={(v, name) => `${chartConfig[name as keyof typeof chartConfig]?.label ?? name}: ${typeof v === "number" ? fmtSigned(data.unit, v) : "–"}`} />} />
				{keys.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
				{keys.map((k) => (
					<Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} maxBarSize={18} isAnimationActive={false} />
				))}
			</BarChart>
		</ChartContainer>
	);
}

function SegmentTable({ data, dimension, onDrill }: { data: ExplainResult; dimension: ExplainResult["dimensions"][number]; onDrill?: ((w: ExplainWithin) => void) | undefined }) {
	const ratio = data.kind === "ratio";
	const value = (v: number | null) => fmtMetric(data.unit, v);
	return (
		<Table aria-label={`${DIMENSION_LABELS[dimension.dimension]} segments`}>
			<TableHeader>
				<TableRow>
					<TableHead>{DIMENSION_LABELS[dimension.dimension]}</TableHead>
					<TableHead className="text-right">Players</TableHead>
					<TableHead className="text-right">Before</TableHead>
					<TableHead className="text-right">Now</TableHead>
					{ratio ? <TableHead className="text-right">Rate</TableHead> : null}
					{ratio ? <TableHead className="text-right">Mix</TableHead> : null}
					<TableHead className="text-right">Contribution</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{dimension.segments.map((s: ExplainSegment) => {
					const name = segmentName(dimension.dimension, s);
					const canDrill = onDrill && !s.other;
					return (
						<TableRow key={s.other ? "\u0000other" : (s.value ?? "\u0000null")} data-segment={name}>
							<TableCell className="max-w-48">
								<div className="flex items-center gap-1.5">
									{canDrill ? (
										<button
											type="button"
											className={cn("truncate text-left underline-offset-2 hover:underline", s.value === null && "text-muted-foreground")}
											onClick={() => onDrill({ dimension: dimension.dimension, value: s.value })}
											title={`Split ${segmentPhrase(dimension.dimension, s)} by the other dimensions`}
										>
											{name}
										</button>
									) : (
										<span className={cn("truncate", (s.other || s.value === null) && "text-muted-foreground")}>{name}</span>
									)}
									{s.small ? (
										<Badge variant="outline" className="h-4 px-1 text-[10px] font-normal text-muted-foreground" title={`Fewer than ${data.minPlayers} players in one of the periods: don't trust this row much`}>
											few players
										</Badge>
									) : null}
								</div>
							</TableCell>
							<TableCell className="text-right tabular-nums text-muted-foreground">
								{fmtInt(s.baseline.players)} → {fmtInt(s.current.players)}
								{ratio ? <div className="text-[10px]">{`${fmtPct(s.baseline.share, 0)} → ${fmtPct(s.current.share, 0)}`}</div> : null}
							</TableCell>
							<TableCell className="text-right tabular-nums">{value(s.baseline.value)}</TableCell>
							<TableCell className="text-right tabular-nums">{value(s.current.value)}</TableCell>
							{ratio ? <TableCell className="text-right tabular-nums">{fmtSigned(data.unit, s.rate)}</TableCell> : null}
							{ratio ? <TableCell className="text-right tabular-nums">{fmtSigned(data.unit, s.mix)}</TableCell> : null}
							<TableCell className="text-right tabular-nums">
								{fmtSigned(data.unit, s.contribution)}
								{s.shareOfChange !== null ? <div className="text-[10px] text-muted-foreground">{fmtPct(s.shareOfChange, 0)} of the change</div> : null}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

/** The answer: headline, both periods, then one dimension's chart and table (the most telling dimension first). */
export function ExplainView({ data, onDrill }: { data: ExplainResult; onDrill?: (w: ExplainWithin) => void }) {
	const ranked = useMemo(() => rankDimensions(data), [data]);
	const [picked, setPicked] = useState<ExplainDimension | undefined>(undefined);
	const dimension = ranked.find((d) => d.dimension === picked) ?? ranked[0];
	if (!dimension) return <EmptyState>No segments.</EmptyState>;
	return (
		<div className="space-y-4">
			<p className="text-sm font-medium leading-snug" data-testid="explain-headline">
				{explainHeadline(data)}
			</p>
			<div className="grid grid-cols-2 gap-2 text-xs">
				{(["baseline", "current"] as const).map((w) => (
					<div key={w} className="rounded-md border px-3 py-2">
						<div className="text-muted-foreground">{w === "baseline" ? "Before" : "Now"}</div>
						<div className="text-lg font-semibold tabular-nums">{fmtMetric(data.unit, data[w].value)}</div>
						<div className="text-muted-foreground tabular-nums">
							{fmtTime(data[w].from).slice(0, 16)} – {fmtTime(data[w].to).slice(0, 16)} UTC · {fmtInt(data[w].players)} players
						</div>
					</div>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground">Split by</span>
				<Select value={dimension.dimension} onValueChange={(v) => setPicked(v as ExplainDimension)}>
					<SelectTrigger size="sm" className="w-44" aria-label="Dimension">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{ranked.map((d) => (
							<SelectItem key={d.dimension} value={d.dimension}>
								{DIMENSION_LABELS[d.dimension]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<span className="text-xs text-muted-foreground">
					{data.kind === "ratio"
						? "Rate: the segment itself got better or worse. Mix: its share of players changed (a bigger share only helps when it is above average)."
						: "Each segment's own change; they add up to the total."}
				</span>
			</div>
			<ContributionChart data={data} dimension={dimension} />
			<SegmentTable data={data} dimension={dimension} onDrill={onDrill} />
		</div>
	);
}

export function ExplainPanel() {
	const [metric, setMetric] = useExplain();
	const { state } = useFilters();
	const period = useMemo(() => previousPeriod(state), [state]);
	const [within, setWithin] = useState<ExplainWithin | null>(null);
	useEffect(() => setWithin(null), [metric]);
	const open = metric !== "";
	const options = { metric: metric || "players", ...(period ? { baseline: { from: period.filters.from, to: period.filters.to } } : {}), ...(within ? { within } : {}) };
	const q = useAnalytics("explain", options, { enabled: open && period !== undefined });
	return (
		<Sheet open={open} onOpenChange={(o) => !o && setMetric("")}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl md:w-[52rem]">
				<div className="space-y-4 p-4">
					<div className="space-y-1 pr-8">
						<SheetTitle>Explain this change</SheetTitle>
						<SheetDescription>
							{`${describeRange(state).replace(/^./, (c) => c.toUpperCase())} against the period before, of the same length, under the filter bar's filters.`}
						</SheetDescription>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Select value={metric || "players"} onValueChange={(v) => setMetric(v as ExplainMetric)}>
							<SelectTrigger size="sm" className="w-52" aria-label="Metric">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{EXPLAIN_METRICS.map((m) => (
									<SelectItem key={m} value={m}>
										{EXPLAIN_METRIC_LABELS[m]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{within ? (
							<Button variant="outline" size="sm" onClick={() => setWithin(null)}>
								<ArrowLeft />
								All players
							</Button>
						) : null}
						{within ? (
							<span className="text-xs text-muted-foreground">
								Only {segmentPhrase(within.dimension, { value: within.value })} ({DIMENSION_LABELS[within.dimension]}), split by the other dimensions.
							</span>
						) : null}
					</div>
					{period === undefined ? (
						<EmptyState>Pick a start date in the filter bar: there is no period before to compare with.</EmptyState>
					) : (
						<QueryState query={q} loadingRows={6}>
							{(data) => <ExplainView key={`${data.metric}:${within?.dimension ?? ""}:${within?.value ?? ""}`} data={data} {...(within ? {} : { onDrill: setWithin })} />}
						</QueryState>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
