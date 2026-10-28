/**
 * A time-series line chart with deploy marks, like Creator Hub's "published change" lines: one vertical mark per
 * release, rollback, kernel publish and backup refresh. Hovering a mark shows what it was; clicking (or tapping, or
 * Enter on it) calls `onMarkClick` (the Performance page filters to that build and selects the mark).
 */
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { MARK_STYLE, markDetails, markTitle, timeTick, type ChartRow, type ChartSeries, type DeployMark } from "@/lib/perf";

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

interface Hover {
	mark: DeployMark;
	x: number;
}

/** A mark: a wide invisible hit line, the visible line and a small flag on top. */
function MarkShape(props: {
	x1?: number;
	y1?: number;
	x2?: number;
	y2?: number;
	mark: DeployMark;
	selected: boolean;
	onHover(hover: Hover | null): void;
	onClick?(mark: DeployMark): void;
}) {
	const { x1, y1, x2, y2, mark, selected, onHover, onClick } = props;
	if (![x1, y1, x2, y2].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
	const style = MARK_STYLE[mark.kind];
	const top = Math.min(y1 as number, y2 as number);
	const x = x1 as number;
	const activate = () => onClick?.(mark);
	return (
		<g
			className="cursor-pointer outline-none"
			role="button"
			tabIndex={0}
			aria-label={`${markTitle(mark)}, ${markDetails(mark)[0]}`}
			data-mark={mark.id}
			onMouseEnter={() => onHover({ mark, x })}
			onMouseLeave={() => onHover(null)}
			onFocus={() => onHover({ mark, x })}
			onBlur={() => onHover(null)}
			onClick={activate}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					activate();
				}
			}}
		>
			<line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
			<line x1={x1} y1={y1} x2={x2} y2={y2} stroke={style.color} strokeWidth={selected ? 2.5 : 1.25} strokeDasharray={style.dash} strokeOpacity={selected ? 1 : 0.85} />
			<path d={`M${x - 4},${top - 9} L${x + 4},${top - 9} L${x},${top - 3} Z`} fill={style.color} />
		</g>
	);
}

export function PerfChart({ label, rows, series, fromMs, toMs, format, marks = [], selectedMark, onMarkClick, heightClass = "h-56", legend = false }: PerfChartProps) {
	const [hover, setHover] = useState<Hover | null>(null);
	const config: ChartConfig = Object.fromEntries(series.map((s) => [s.id, { label: s.label, color: s.color }]));
	const span = toMs - fromMs;
	const visible = marks.filter((m) => m.at >= fromMs && m.at <= toMs);
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
					{visible.map((m) => (
						<ReferenceLine
							key={m.id}
							x={m.at}
							ifOverflow="discard"
							shape={(p: { x1?: number; y1?: number; x2?: number; y2?: number }) => (
								<MarkShape {...p} mark={m} selected={m.id === selectedMark} onHover={setHover} {...(onMarkClick ? { onClick: onMarkClick } : {})} />
							)}
						/>
					))}
				</LineChart>
			</ChartContainer>
			{hover ? (
				<div
					className="pointer-events-none absolute top-0 z-10 max-w-64 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
					style={{ left: Math.max(90, hover.x) }}
				>
					<div className="font-medium">{markTitle(hover.mark)}</div>
					{markDetails(hover.mark).map((line) => (
						<div key={line} className="text-muted-foreground">
							{line}
						</div>
					))}
					{onMarkClick ? <div className="pt-0.5 text-muted-foreground">Click: {hover.mark.artifact ? "filter to this build" : "select"}</div> : null}
				</div>
			) : null}
		</div>
	);
}
