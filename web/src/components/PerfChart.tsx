/**
 * A time-series line chart with deploy marks, like Creator Hub's "published change" lines: one vertical mark per
 * release, rollback, kernel publish and backup refresh (the shared DeployMarkers). Hovering a mark shows what it was;
 * clicking (or tapping, or Enter on it) calls `onMarkClick` (the Performance page filters to that build and selects the mark).
 */
import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { MarkHoverCard, markerLines, type MarkHover } from "@/components/DeployMarkers";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { groupMarks } from "@/lib/deploys";
import { timeTick, type ChartRow, type ChartSeries, type DeployMark } from "@/lib/perf";

export interface PerfChartProps {
	/** For screen readers: what the chart shows. */
	label: string;
	rows: ChartRow[];
	series: ChartSeries[];
	fromMs: number;
	toMs: number;
	format(value: number): string;
	marks?: DeployMark[];
	selectedMark?: string | null;
	onMarkClick?(mark: DeployMark): void;
	/** Tailwind height class (default h-56). */
	heightClass?: string;
	/** Show the legend (several series). */
	legend?: boolean;
}

export function PerfChart({ label, rows, series, fromMs, toMs, format, marks = [], selectedMark, onMarkClick, heightClass = "h-56", legend = false }: PerfChartProps) {
	const [hover, setHover] = useState<MarkHover | null>(null);
	const config: ChartConfig = Object.fromEntries(series.map((s) => [s.id, { label: s.label, color: s.color }]));
	const span = toMs - fromMs;
	const visible = marks.filter((m) => m.at >= fromMs && m.at <= toMs);
	const hovered = hover?.marks[hover.marks.length - 1];
	return (
		<div className="relative" role="figure" aria-label={label}>
			<ChartContainer config={config} className={`aspect-auto w-full ${heightClass}`}>
				<LineChart data={rows} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="t"
						type="number"
						scale="time"
						domain={[fromMs, toMs]}
						allowDataOverflow
						tickLine={false}
						axisLine={false}
						tickMargin={6}
						minTickGap={36}
						tickFormatter={(t: number) => timeTick(t, span)}
					/>
					<YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => format(v)} />
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => {
									const t = payload?.[0]?.payload?.t;
									return typeof t === "number" ? `${new Date(t).toISOString().replace("T", " ").slice(0, 16)} UTC` : "";
								}}
								formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? format(v) : "–"}`}
							/>
						}
					/>
					{legend && series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
					{series.map((s) => (
						<Line
							key={s.id}
							dataKey={s.id}
							name={s.id}
							stroke={`var(--color-${s.id})`}
							strokeWidth={s.dashed ? 1.5 : 2}
							{...(s.dashed ? { strokeDasharray: "4 3" } : {})}
							dot={false}
							isAnimationActive={false}
							connectNulls={false}
						/>
					))}
					{markerLines(
						groupMarks(visible, (m) => m.at),
						{ selected: selectedMark ?? null, onHover: setHover, ...(onMarkClick ? { onClick: onMarkClick } : {}) },
					)}
				</LineChart>
			</ChartContainer>
			<MarkHoverCard hover={hover} {...(onMarkClick && hovered ? { clickHint: `Click: ${hovered.artifact ? "filter to this build" : "select"}` } : {})} />
		</div>
	);
}
