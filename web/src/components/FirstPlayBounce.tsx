/**
 * First-play bounce: Creator Hub's "First play bounce rate (<60s Average Rate)" chart, split by device (Creator Hub
 * has no breakdown for it), from query first-play-bounce. Follows the filter bar's range; the headline is the mean of
 * the step rates (Creator Hub's "average over selected period"), with the pooled rate and each device's beside it.
 */
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { Metric, QueryState, Section } from "@/components/common";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { change } from "@/lib/benchmarks";
import { fmtInt, fmtPct } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import { DEVICE_COLORS, groupLabel } from "@/lib/perf";
import type { FirstPlayBounceResult } from "@/lib/types";

const BARS = ["30", "60", "120", "300"];

function barLabel(seconds: number): string {
	return seconds < 60 ? `${seconds}s` : `${seconds / 60} min`;
}

function stepLabel(iso: string, bucketMinutes: number, long = false): string {
	if (bucketMinutes >= 1440) return long ? iso.slice(0, 10) : iso.slice(5, 10);
	return long ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** Chart rows: `total` and d0, d1... per device (names may not be CSS-safe), as percentages; null for empty steps. */
export function bounceRows(r: FirstPlayBounceResult, split: boolean) {
	const devs = split ? r.devices : [];
	const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 1000) / 10);
	const rows = r.buckets.map((b) => ({ time: b.time, total: pct(b.rate), ...Object.fromEntries(devs.map((d, i) => [`d${i}`, pct(b.byDevice[d]?.rate)])) }));
	return { rows, devs };
}

function Chart({ r, split }: { r: FirstPlayBounceResult; split: boolean }) {
	const { rows, devs } = bounceRows(r, split);
	const config: ChartConfig = {
		total: { label: "All devices", color: "var(--chart-1)" },
		...Object.fromEntries(devs.map((d, i) => [`d${i}`, { label: groupLabel("dev", d), color: DEVICE_COLORS[d] ?? "var(--chart-8)" }])),
	};
	const counts = (time: string, key: string) => {
		const b = r.buckets.find((x) => x.time === time);
		const c = key === "total" ? b : b?.byDevice[devs[Number(key.slice(1))]];
		return c ? ` (${fmtInt(c.bounced)} of ${fmtInt(c.firstSessions)})` : "";
	};
	return (
		<ChartContainer config={config} className="aspect-auto h-72 w-full">
			<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={6} minTickGap={32} tickFormatter={(t: string) => stepLabel(t, r.bucketMinutes)} />
				<YAxis tickLine={false} axisLine={false} width={44} domain={[0, (max: number) => Math.min(100, Math.max(10, Math.ceil(max / 10) * 10))]} tickFormatter={(v: number) => `${v}%`} />
				<ChartTooltip
					content={
						<ChartTooltipContent
							labelFormatter={(_l, items) => stepLabel(String((items?.[0]?.payload as { time?: string } | undefined)?.time ?? ""), r.bucketMinutes, true)}
							formatter={(v, name, item) =>
								`${config[String(name)]?.label ?? name}: ${typeof v === "number" ? `${v}%` : "–"}${typeof v === "number" ? counts(String((item?.payload as { time?: string })?.time ?? ""), String(name)) : ""}`
							}
						/>
					}
				/>
				{devs.length ? <ChartLegend content={<ChartLegendContent />} /> : null}
				<Line dataKey="total" type="monotone" stroke="var(--color-total)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
				{devs.map((d, i) => (
					<Line key={d} dataKey={`d${i}`} type="monotone" stroke={`var(--color-d${i})`} strokeWidth={1.5} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
				))}
			</LineChart>
		</ChartContainer>
	);
}

function Tiles({ r }: { r: FirstPlayBounceResult }) {
	const s = r.summary;
	const p = r.previous;
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
			<Metric
				label={
					<span className="flex items-center gap-1">
						Average rate
						<InfoTip>The mean of the step rates over the range: Creator Hub's "average over selected period".</InfoTip>
					</span>
				}
				value={fmtPct(s.dailyMean)}
				delta={<ChangeChip change={change(s.dailyMean, p.dailyMean, true)} against="the period before" />}
			/>
			<Metric
				label={
					<span className="flex items-center gap-1">
						Pooled
						<InfoTip>All first sessions of the range together: bounced / first sessions ({fmtInt(s.running)} still running are not counted).</InfoTip>
					</span>
				}
				value={fmtPct(s.rate)}
				sub={`${fmtInt(s.bounced)} of ${fmtInt(s.firstSessions)}`}
				delta={<ChangeChip change={change(s.rate, p.rate, true)} against="the period before" />}
			/>
			{r.devices.map((d) => {
				const v = s.byDevice[d];
				return (
					<Metric
						key={d}
						label={groupLabel("dev", d)}
						value={fmtPct(v?.rate)}
						sub={v ? `${fmtInt(v.bounced)} of ${fmtInt(v.firstSessions)}` : undefined}
						delta={<ChangeChip change={change(v?.rate ?? null, p.byDevice[d]?.rate ?? null, true)} against="the period before" />}
					/>
				);
			})}
		</div>
	);
}

export function FirstPlayBounce() {
	const { apiFilters } = useFilters();
	const [barParam, setBar] = useParam("bounce", "60");
	const [splitParam, setSplit] = useParam("bounceSplit", "device");
	const bar = BARS.includes(barParam) ? Number(barParam) : 60;
	const split = splitParam !== "total";
	const options = useMemo(() => ({ bounceSeconds: bar }), [bar]);
	const q = useAnalytics("first-play-bounce", options, { filters: apiFilters, keepPrevious: true });
	return (
		<Section
			title={
				<span className="flex items-center gap-1.5">
					First play bounce rate (&lt;{barLabel(bar)})
					<InfoTip>
						The share of new players whose first session was shorter than {barLabel(bar)}, by the step their first session started in, split by device (Creator Hub
						doesn't offer that breakdown). Only first sessions that are over count (a leave row or 10 minutes without events); Studio play tests are left out. Lower
						is better.
					</InfoTip>
				</span>
			}
			description="New players who left their first session early, in total and per device."
			contentClassName="space-y-3"
		>
			<div className="flex flex-wrap items-center gap-2">
				<ToggleGroup type="single" size="sm" variant="outline" value={split ? "device" : "total"} onValueChange={(v) => v && setSplit(v)} aria-label="Split">
					<ToggleGroupItem value="total">Total only</ToggleGroupItem>
					<ToggleGroupItem value="device">By device</ToggleGroupItem>
				</ToggleGroup>
				<Select value={String(bar)} onValueChange={setBar}>
					<SelectTrigger size="sm" className="w-36" aria-label="Bounce bar">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{BARS.map((b) => (
							<SelectItem key={b} value={b}>
								Bounce: &lt;{barLabel(Number(b))}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<QueryState query={q} isEmpty={(r) => r.summary.firstSessions === 0} empty="No new players finished a first session in this range.">
				{(r) => (
					<>
						<Tiles r={r} />
						<Chart r={r} split={split} />
						{r.truncated ? <p className="text-xs text-muted-foreground">Too many sessions: part of the range may be missing. Pick a shorter range.</p> : null}
					</>
				)}
			</QueryState>
		</Section>
	);
}
