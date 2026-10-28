/**
 * A small per-day bar chart (one series; the card title names it). Days without data show as zero. Windows of a day or
 * less use the same chart per step (1 min, 5 min, 1 h): labels are "YYYY-MM-DD hh:mm" and the axis shows the time.
 * `previous` adds the period before as a dashed line, step by step (its first step over the first bar, and so on).
 */
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { MarkHoverCard, markerLines, type MarkHover } from "@/components/DeployMarkers";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { groupMarks, placeOnLabels } from "@/lib/deploys";
import type { DeployMark } from "@/lib/perf";

export interface DayPoint {
	date: string;
	value: number;
}

/** Every UTC day from `from` to `to` (YYYY-MM-DD or ISO), with the values found and 0 elsewhere (at most 400 days). */
export function fillDays(points: DayPoint[], from: string, to: string): DayPoint[] {
	const byDate = new Map(points.map((p) => [p.date, p.value]));
	const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
	const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 400 * 86_400_000) return points;
	const out: DayPoint[] = [];
	for (let t = start; t <= end; t += 86_400_000) {
		const date = new Date(t).toISOString().slice(0, 10);
		out.push({ date, value: byDate.get(date) ?? 0 });
	}
	return out;
}

/** Every step of [fromMs, toMs) (UTC, "YYYY-MM-DD hh:mm"), with the values found and 0 elsewhere (at most 400 steps). */
export function fillSteps(points: { t: number; value: number }[], fromMs: number, toMs: number, stepMs: number): DayPoint[] {
	const byT = new Map(points.map((p) => [p.t, p.value]));
	const label = (t: number) => {
		const iso = new Date(t).toISOString();
		return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	};
	if (!(stepMs > 0) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || (toMs - fromMs) / stepMs > 400) {
		return points.map((p) => ({ date: label(p.t), value: p.value }));
	}
	const out: DayPoint[] = [];
	for (let t = Math.floor(fromMs / stepMs) * stepMs; t < toMs; t += stepMs) out.push({ date: label(t), value: byT.get(t) ?? 0 });
	return out;
}

/** "10-05" for a day, "17:05" for a step inside a day. */
const tick = (d: string) => (d.length > 10 ? d.slice(11) : d.slice(5));

/** The bars' rows with the previous period's values by position (`prev`; null past its end). */
export function withPreviousBars(data: DayPoint[], previous: number[] | undefined): (DayPoint & { prev?: number | null })[] {
	return previous ? data.map((d, i) => ({ ...d, prev: previous[i] ?? null })) : data;
}

export function DayBars({
	data,
	label,
	decimals = 0,
	color = "var(--chart-1)",
	previous,
	previousLabel = "Previous period",
	marks = [],
	onMarkClick,
}: {
	data: DayPoint[];
	label: string;
	decimals?: number;
	color?: string;
	/** The period before, one value per step, drawn as a dashed line. */
	previous?: number[];
	previousLabel?: string;
	/** Deploy markers: each on the bar (day or step) it falls in. */
	marks?: DeployMark[];
	onMarkClick?(mark: DeployMark): void;
}) {
	const config: ChartConfig = { value: { label, color }, prev: { label: previousLabel, color: "var(--muted-foreground)" } };
	const rows = withPreviousBars(data, previous);
	const [hover, setHover] = useState<MarkHover | null>(null);
	const groups = useMemo(() => (marks.length ? groupMarks(marks, placeOnLabels(data.map((d) => d.date))) : []), [marks, data]);
	return (
		<div className="relative">
			<ChartContainer config={config} className="aspect-auto h-40 w-full">
				<BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} barCategoryGap={2}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
					<YAxis
						tickLine={false}
						axisLine={false}
						width={40}
						allowDecimals={decimals > 0}
						tickFormatter={(v: number) => (decimals ? v.toFixed(decimals) : String(v))}
					/>
					<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
					<Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
					{previous ? <Line dataKey="prev" type="monotone" stroke="var(--color-prev)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls={false} /> : null}
					{markerLines(groups, { onHover: setHover, ...(onMarkClick ? { onClick: onMarkClick } : {}) })}
				</BarChart>
			</ChartContainer>
			<MarkHoverCard hover={hover} {...(onMarkClick ? { clickHint: "Click: open the deploy" } : {})} />
		</div>
	);
}
