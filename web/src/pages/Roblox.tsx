/**
 * The Roblox page, laid out like Creator Hub's experience overview, from our own events: benchmark cards (period over
 * period, against the 50th / 90th the user copies from Creator Hub), a realtime column, and 7-day moving averages
 * per join source.
 */
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { barMax, change, estimatePercentile, loadBenchmarks, saveBenchmarks, type Benchmark, type BenchmarkKey, type Benchmarks } from "@/lib/benchmarks";
import { isoDate } from "@/lib/filters";
import { fmtInt, fmtMinutes, fmtNum, fmtPct } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { BenchmarkPeriod, Filters, RealtimeResult, TrendValues } from "@/lib/types";

/** The filter bar's filters without its date range (these sections have their own). */
function useNoRange(): Filters {
	const { apiFilters } = useFilters();
	return useMemo(() => {
		const { from: _from, to: _to, ...rest } = apiFilters;
		return rest;
	}, [apiFilters]);
}

// Benchmark cards ----------------------------------------------------------------------------------------------------

/** Where a number can't match Creator Hub: a short badge on the card, and why (its tooltip). */
export interface Differs {
	label: "Estimate" | "Ours";
	why: string;
}

export interface CardSpec {
	key: BenchmarkKey;
	title: string;
	/** Value in the unit the user types benchmarks in (minutes, percent, Robux). */
	value(p: BenchmarkPeriod): number | null;
	format(v: number): string;
	unit: string;
	/** Creator Hub's definition, then how this card computes it. */
	info: string;
	differs?: Differs;
}

const pct = (r: { rate: number; of: number }) => (r.of > 0 ? r.rate * 100 : null);

const REVENUE_DIFFERS: Differs = {
	label: "Estimate",
	why: "Revenue here is what players paid in game purchases times 70% (Roblox keeps 30%). Creator Hub also counts passes bought outside the game, commissions and avatar item sales, which the game never sees.",
};

export const CARDS: CardSpec[] = [
	{
		key: "dau",
		title: "Daily active users",
		value: (p) => p.dau,
		format: (v) => fmtNum(v, 1),
		unit: "players",
		info: "Creator Hub: the distinct users who played on a day. Here the players who started a session that UTC day (a session running past midnight counts for its first day only), averaged over the period's days.",
	},
	{
		key: "mau",
		title: "Monthly active users",
		value: (p) => p.mau,
		format: (v) => fmtInt(v),
		unit: "players",
		info: "Creator Hub: the distinct users who played in the last 30 days. Here the distinct players with a session in the 30 UTC days ending on the period's last day (so the two periods' 30-day windows overlap).",
	},
	{
		key: "newUsers",
		title: "New users",
		value: (p) => p.newUsers,
		format: (v) => fmtInt(v),
		unit: "players",
		info: "Creator Hub: users who played the experience for the first time. Here the players whose first-ever session started in the period (the SDK marks a player's first join), summed over its days.",
	},
	{
		key: "sessionTime",
		title: "Average session time",
		value: (p) => p.avgSessionMinutes,
		format: (v) => fmtMinutes(v),
		unit: "minutes",
		info: "Creator Hub: total playtime divided by the number of sessions, each day. Here the same, per UTC day, averaged over the period's days. A session runs from its first to its last event and counts on the day it started.",
	},
	{
		key: "d1",
		title: "Day 1 retention",
		value: (p) => pct(p.d1Retention),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "Creator Hub: new users who played again the day after their first play date, by that date. Here the same: a new session must start the next UTC day (a first session running past midnight isn't a return), for the latest join days whose next day is over, averaged over those days.",
	},
	{
		key: "d7",
		title: "Day 7 retention",
		value: (p) => pct(p.d7Retention),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "Creator Hub: new users who played again on day 7 (the 8th day) after their first play date. Here the same rule as day 1, 7 days on, for the latest join days whose day 7 is over.",
	},
	{
		key: "d30",
		title: "Day 30 retention",
		value: (p) => pct(p.d30Retention),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "Creator Hub: new users who played again on day 30 after their first play date. Here the same rule as day 1, 30 days on, for the latest join days whose day 30 is over.",
	},
	{
		key: "payer",
		title: "Payer conversion",
		value: (p) => pct(p.payerConversion),
		format: (v) => `${fmtNum(v, 2)}%`,
		unit: "%",
		info: "Creator Hub: the share of daily active users who are also paying users. Here the same per UTC day, averaged over the period's days (not payers over the whole period).",
		differs: { label: "Estimate", why: "Only purchases the game server logs count: a pass bought on the website, outside the game, isn't seen." },
	},
	{
		key: "arppu",
		title: "ARPPU",
		value: (p) => p.arppu,
		format: (v) => `${fmtNum(v, 1)} R$`,
		unit: "Robux",
		info: "Creator Hub: average revenue per paying user. Here revenue / paying users per UTC day, averaged over the days with a payer.",
		differs: REVENUE_DIFFERS,
	},
	{
		key: "arpdau",
		title: "ARPDAU",
		value: (p) => p.arpdau,
		format: (v) => `${fmtNum(v, 2)} R$`,
		unit: "Robux",
		info: "Creator Hub: average revenue per daily active user. Here revenue / DAU per UTC day, averaged over the period's days.",
		differs: REVENUE_DIFFERS,
	},
	{
		key: "playtime",
		title: "Average playtime",
		value: (p) => p.avgPlaytimeMinutes,
		format: (v) => fmtMinutes(v),
		unit: "minutes",
		info: "Creator Hub: playtime per daily active user. Here all playtime of a UTC day divided by that day's players, averaged over the period's days.",
	},
	{
		key: "playThrough",
		title: "Play-through rate (after join)",
		value: (p) => pct(p.playThrough),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "Our version: the share of new players' first sessions (that are over) lasting at least 5 minutes.",
		differs: { label: "Ours", why: "Creator Hub's play-through rate starts at the home-page impression (seen, then played), which games can't see. Don't compare it with Creator Hub's benchmark." },
	},
];

function sub(spec: CardSpec, p: BenchmarkPeriod): string {
	switch (spec.key) {
		case "dau":
			return `${fmtInt(p.players)} players in the period`;
		case "mau":
			return `30 days to ${new Date(Date.parse(p.to) - 1).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
		case "newUsers":
			return `${fmtNum(p.newUsers / Math.max(1, Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000)), 1)} per day`;
		case "sessionTime":
			return `${fmtInt(p.sessions)} sessions`;
		case "playtime":
			return `${fmtNum(p.dau, 1)} daily active users`;
		case "d1":
			return `${fmtInt(p.d1Retention.count)} of ${fmtInt(p.d1Retention.of)} new players`;
		case "d7":
			return `${fmtInt(p.d7Retention.count)} of ${fmtInt(p.d7Retention.of)} new players`;
		case "d30":
			return `${fmtInt(p.d30Retention.count)} of ${fmtInt(p.d30Retention.of)} new players`;
		case "payer":
			return `${fmtInt(p.payerConversion.count)} payer-days of ${fmtInt(p.payerConversion.of)} player-days`;
		case "arppu":
			return `${fmtInt(p.revenue)} Robux revenue (${fmtInt(p.robux)} spent)`;
		case "arpdau":
			return `${fmtNum(p.dau, 1)} daily active users`;
		case "playThrough":
			return `${fmtInt(p.playThrough.count)} of ${fmtInt(p.playThrough.of)} first sessions`;
	}
}

function DiffersBadge({ differs }: { differs: Differs }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button type="button" aria-label={`${differs.label}: how it differs from Creator Hub`}>
					<Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
						{differs.label}
					</Badge>
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-72 text-xs leading-snug">{differs.why}</TooltipContent>
		</Tooltip>
	);
}

function BenchmarkBar({ value, bench, onSet }: { value: number | null; bench?: Benchmark; onSet(): void }) {
	if (value === null) return <div className="h-2 rounded-full bg-muted" />;
	const max = barMax(value, bench);
	const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
	const percentile = bench ? estimatePercentile(value, bench) : null;
	return (
		<div className="space-y-1">
			<div className="relative h-2 rounded-full bg-muted">
				<div className="absolute inset-y-0 left-0 rounded-full bg-[var(--chart-1)]" style={{ width: at(value) }} />
				{bench
					? [bench.p50, bench.p90].map((v, i) => (
							<div key={i} className="absolute -top-1 h-4 w-0.5 bg-foreground/70" style={{ left: at(v) }} title={`${i ? "90th" : "50th"} percentile: ${fmtNum(v)}`} />
						))
					: null}
			</div>
			{bench ? (
				<div className="flex justify-between text-[11px] text-muted-foreground">
					<span>
						50th {fmtNum(bench.p50)} · 90th {fmtNum(bench.p90)}
					</span>
					<span className="tabular-nums">{percentile === null ? "" : `est. ~${ordinal(percentile)} percentile`}</span>
				</div>
			) : (
				<button type="button" onClick={onSet} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
					set benchmarks
				</button>
			)}
		</div>
	);
}

function ordinal(n: number): string {
	const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${s}`;
}

function BenchmarkCard({ spec, current, previous, bench, days, onSet }: { spec: CardSpec; current: BenchmarkPeriod; previous: BenchmarkPeriod; bench?: Benchmark; days: number; onSet(): void }) {
	const value = spec.value(current);
	return (
		<Card className="gap-2 py-4">
			<CardContent className="space-y-2">
				<div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					{spec.title}
					<InfoTip>{spec.info}</InfoTip>
					{spec.differs ? <DiffersBadge differs={spec.differs} /> : null}
				</div>
				<div className="flex items-baseline gap-2">
					<span className={value === null ? "text-2xl font-semibold text-muted-foreground" : "text-2xl font-semibold tracking-tight tabular-nums"}>{value === null ? "n/a" : spec.format(value)}</span>
					<ChangeChip change={change(value, spec.value(previous))} against={`the ${days} days before`} />
				</div>
				<div className="text-xs text-muted-foreground tabular-nums">{sub(spec, current)}</div>
				<BenchmarkBar value={value} {...(bench ? { bench } : {})} onSet={onSet} />
			</CardContent>
		</Card>
	);
}

function BenchmarkEditor({ value, onSave, onClose }: { value: Benchmarks; onSave(b: Benchmarks): void; onClose(): void }) {
	const [draft, setDraft] = useState<Record<string, { p50: string; p90: string }>>(() =>
		Object.fromEntries(CARDS.map((c) => [c.key, { p50: value[c.key]?.p50?.toString() ?? "", p90: value[c.key]?.p90?.toString() ?? "" }])),
	);
	const save = () => {
		const out: Benchmarks = {};
		for (const c of CARDS) {
			const p50 = Number.parseFloat(draft[c.key]?.p50 ?? "");
			const p90 = Number.parseFloat(draft[c.key]?.p90 ?? "");
			if (Number.isFinite(p50) && Number.isFinite(p90) && p50 > 0 && p90 > 0) out[c.key] = { p50, p90 };
		}
		onSave(out);
		onClose();
	};
	return (
		<div className="space-y-3">
			<div>
				<div className="text-sm font-medium">Benchmarks</div>
				<p className="text-xs text-muted-foreground">Copy the 50th and 90th percentile from your Creator Hub overview. Kept in this browser only.</p>
			</div>
			<div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-x-2 gap-y-1.5 text-xs">
				<span />
				<span className="text-muted-foreground">50th</span>
				<span className="text-muted-foreground">90th</span>
				{CARDS.map((c) => (
					<div key={c.key} className="contents">
						<span>
							{c.title} <span className="text-muted-foreground">({c.unit})</span>
						</span>
						{(["p50", "p90"] as const).map((k) => (
							<Input
								key={k}
								aria-label={`${c.title} ${k === "p50" ? "50th" : "90th"} percentile`}
								inputMode="decimal"
								className="h-7 text-xs"
								value={draft[c.key]?.[k] ?? ""}
								onChange={(e) => setDraft((d) => ({ ...d, [c.key]: { ...(d[c.key] ?? { p50: "", p90: "" }), [k]: e.target.value } }))}
							/>
						))}
					</div>
				))}
			</div>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={() => setDraft(Object.fromEntries(CARDS.map((c) => [c.key, { p50: "", p90: "" }])))}>
					Clear
				</Button>
				<Button size="sm" onClick={save}>
					Save
				</Button>
			</div>
		</div>
	);
}

// Realtime -----------------------------------------------------------------------------------------------------------

function Sparkline({ series }: { series: RealtimeResult["ccu"]["series"] }) {
	const config: ChartConfig = {
		peak: { label: "Peak concurrent users", color: "var(--chart-1)" },
		avg: { label: "Hourly average", color: "var(--chart-2)" },
	};
	return (
		<ChartContainer config={config} className="aspect-auto h-16 w-full">
			<LineChart data={series} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
				<ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => `${String(p?.[0]?.payload?.hour ?? "").replace("T", " ").slice(0, 16)} UTC`} />} />
				<Line dataKey="peak" stroke="var(--color-peak)" strokeWidth={2} dot={false} isAnimationActive={false} />
				<Line dataKey="avg" stroke="var(--color-avg)" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
			</LineChart>
		</ChartContainer>
	);
}

function RealtimeRow({ label, info, value, current, previous, lowerIsBetter = false }: { label: string; info: string; value: string; current: number | null; previous: number | null; lowerIsBetter?: boolean }) {
	return (
		<div className="flex items-center justify-between gap-2 border-t py-2.5 text-sm">
			<div className="flex items-center gap-1.5 text-muted-foreground">
				{label}
				<InfoTip>{info}</InfoTip>
			</div>
			<div className="flex items-center gap-2">
				<span className="font-semibold tabular-nums">{value}</span>
				<ChangeChip change={change(current, previous, lowerIsBetter)} against="the 24 h before" />
			</div>
		</div>
	);
}

function Realtime({ filters }: { filters: Filters }) {
	const q = useAnalytics("realtime", { hours: 24, ccuDays: 7 }, { filters });
	const live = useQuery({ queryKey: ["fleet", "servers", filters.branch ?? ""], queryFn: ({ signal }) => api.fleetServers(typeof filters.branch === "string" ? filters.branch : undefined, signal), refetchInterval: 30_000 });
	return (
		<Section title="Realtime" description="Last 24 hours vs the 24 before.">
			<QueryState query={q} loadingRows={5}>
				{(r) => {
					const now = live.data?.players ?? r.ccu.now;
					const hasCcu = r.ccu.series.some((p) => p.peak > 0);
					return (
						<div>
							<div className="flex items-center justify-between gap-2">
								<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
									Concurrent users
									<InfoTip>
										Players on live servers now (fleet API). The line is each UTC hour's peak minute over 7 days, as Creator Hub's peak concurrent players (dashed: the hourly
										average), from the servers' heartbeats: players per minute, summed over servers. Studio play tests don't count.
									</InfoTip>
									<DiffersBadge differs={{ label: "Estimate", why: "From heartbeats about once a minute per server: a player who stays under a minute, or a server that stops sending, can be missed. Creator Hub counts every connection." }} />
								</div>
								<ChangeChip change={change(r.ccu.currentPeak, r.ccu.previousPeak)} against="the 24 h before (peak)" />
							</div>
							<div className="text-3xl font-semibold tabular-nums">{fmtInt(now)}</div>
							{hasCcu ? <Sparkline series={r.ccu.series} /> : <p className="py-3 text-xs text-muted-foreground">No heartbeats with players in 7 days.</p>}
							<RealtimeRow
								label="Peak concurrent users"
								info="The highest minute of the last 24 h (Creator Hub's peak concurrent players), from the servers' heartbeats."
								value={fmtInt(r.ccu.currentPeak)}
								current={r.ccu.currentPeak}
								previous={r.ccu.previousPeak}
							/>
							<RealtimeRow
								label="Average concurrent users"
								info="The mean of the last 24 h's per-minute player counts (Creator Hub's average concurrent players); minutes without a heartbeat count as 0."
								value={fmtNum(r.ccu.currentAvg, 1)}
								current={r.ccu.currentAvg}
								previous={r.ccu.previousAvg}
							/>
							<RealtimeRow
								label="Session time"
								info="Average length of the sessions that started in the window and are over (first to last event; Studio play tests left out)."
								value={r.current.avgSessionMinutes === null ? "n/a" : fmtMinutes(r.current.avgSessionMinutes)}
								current={r.current.avgSessionMinutes}
								previous={r.previous.avgSessionMinutes}
							/>
							<RealtimeRow
								label="Client error rate"
								info="Script errors clients reported (tech/error) per session. Games can't see crashes, so this is errors, not crashes."
								value={r.current.errorsPerSession === null ? "n/a" : `${fmtNum(r.current.errorsPerSession, 2)} / session`}
								current={r.current.errorsPerSession}
								previous={r.previous.errorsPerSession}
								lowerIsBetter
							/>
							<RealtimeRow
								label="Client frame rate"
								info="Average of the fps clients report every minute (tech/client)."
								value={r.current.clientFps === null ? "n/a" : `${fmtNum(r.current.clientFps, 0)} fps`}
								current={r.current.clientFps}
								previous={r.previous.clientFps}
							/>
							<RealtimeRow
								label="Server memory"
								info="Average of the memory servers report every minute (tech/server, MB)."
								value={r.current.serverMemoryMb === null ? "n/a" : `${fmtInt(r.current.serverMemoryMb)} MB`}
								current={r.current.serverMemoryMb}
								previous={r.previous.serverMemoryMb}
								lowerIsBetter
							/>
							<p className="pt-1 text-[11px] text-muted-foreground">{fmtInt(r.current.sessions)} sessions in the last 24 h.</p>
						</div>
					);
				}}
			</QueryState>
		</Section>
	);
}

// 7-day moving averages ---------------------------------------------------------------------------------------------

type TrendKey = "d1" | "newUsers" | "sessionMinutes" | "playtimeMinutes" | "dau" | "revenue";

export const TRENDS: { key: TrendKey; label: string; format(v: number): string }[] = [
	{ key: "d1", label: "D1 retention", format: (v) => fmtPct(v) },
	{ key: "newUsers", label: "New users", format: (v) => fmtNum(v, 1) },
	{ key: "sessionMinutes", label: "Average session time", format: (v) => fmtMinutes(v) },
	{ key: "playtimeMinutes", label: "Average playtime", format: (v) => fmtMinutes(v) },
	{ key: "dau", label: "Daily active users", format: (v) => fmtNum(v, 1) },
	{ key: "revenue", label: "Daily revenue (est., Robux)", format: (v) => fmtNum(v, 0) },
];

/** Each join source keeps its color whatever the filters (the order of the categorical palette). */
const SOURCE_COLORS: Record<string, string> = {
	direct: "var(--chart-1)",
	teleport: "var(--chart-2)",
	teleport_game: "var(--chart-3)",
	referral: "var(--chart-4)",
	share: "var(--chart-5)",
	follow: "var(--chart-6)",
	unknown: "var(--chart-7)",
	other: "var(--chart-8)",
};

const JOIN_SOURCES_DIFFER =
	"The join sources are the game's own (direct, teleport, link, followed a friend). Creator Hub splits by discovery surface (Home recommendations, Search, Friends, Teleport from another game, ads...), which games can't see: those all count as direct here.";

const SOURCE_LABELS: Record<string, string> = {
	direct: "Direct",
	teleport: "Teleport (same game)",
	teleport_game: "From another game",
	referral: "Referral link",
	share: "Share link",
	follow: "Followed a friend",
	unknown: "Unknown",
	other: "Other",
};

function Trends({ filters }: { filters: Filters }) {
	const [metric, setMetric] = useParam("trend", "d1");
	const [range, setRange] = useParam("trendDays", "28");
	const days = Number.parseInt(range, 10) || 28;
	// The last `days` full UTC days: the query leaves today out (it isn't over).
	const from = isoDate(Date.now() - days * 86_400_000);
	const q = useAnalytics("trends", { window: 7 }, { filters: { ...filters, from } });
	const spec = TRENDS.find((t) => t.key === metric) ?? TRENDS[0];
	return (
		<Section
			title={
				<span className="flex items-center gap-1.5">
					Snapshot of 7-day moving averages
					<DiffersBadge differs={{ label: "Ours", why: JOIN_SOURCES_DIFFER }} />
				</span>
			}
			description="Per full UTC day, total and per join source (where the player's first session that day came from). Counts are averaged over the 7 days; ratios are the mean of the 7 daily values."
			actions={
				<Select value={String(days)} onValueChange={setRange}>
					<SelectTrigger size="sm" className="w-32" aria-label="Date range">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{[14, 28, 56, 90].map((d) => (
							<SelectItem key={d} value={String(d)}>
								Last {d} days
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			contentClassName="space-y-3"
		>
			<Tabs value={spec.key} onValueChange={setMetric}>
				<TabsList className="flex-wrap">
					{TRENDS.map((t) => (
						<TabsTrigger key={t.key} value={t.key}>
							{t.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<QueryState query={q} isEmpty={(r) => r.days.every((d) => d.total.dau === 0)} empty="No players in this range yet.">
				{(r) => {
					const pick = (v: TrendValues | undefined) => (v ? v[spec.key] : null);
					const rows = r.days.map((d) => ({ date: d.date, total: pick(d.total), ...Object.fromEntries(r.sources.map((s) => [s, pick(d.bySource[s])])) }));
					if (!rows.some((row) => typeof row.total === "number" && row.total > 0)) {
						return (
							<EmptyState>
								{spec.key === "d1"
									? "No D1 values yet: a join day counts once the day after it is over."
									: `No ${spec.label.toLowerCase()} in this range yet.`}
							</EmptyState>
						);
					}
					const config: ChartConfig = {
						total: { label: "Total", color: "var(--foreground)" },
						...Object.fromEntries(r.sources.map((s) => [s, { label: SOURCE_LABELS[s] ?? s, color: SOURCE_COLORS[s] ?? "var(--chart-8)" }])),
					};
					return (
						<ChartContainer config={config} className="aspect-auto h-72 w-full">
							<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
								<CartesianGrid vertical={false} />
								<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={28} tickFormatter={(d: string) => d.slice(5)} />
								<YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => spec.format(v)} />
								<ChartTooltip content={<ChartTooltipContent formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? spec.format(v) : "–"}`} />} />
								<ChartLegend content={<ChartLegendContent />} />
								<Line dataKey="total" stroke="var(--color-total)" strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />
								{r.sources.map((s) => (
									<Line key={s} dataKey={s} stroke={`var(--color-${s})`} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
								))}
							</LineChart>
						</ChartContainer>
					);
				}}
			</QueryState>
		</Section>
	);
}

// How these are calculated --------------------------------------------------------------------------------------------

/** The rules the page's numbers follow (Creator Hub's definitions, create.roblox.com/docs/production/analytics). */
export const CALCULATION_NOTES: { title: string; text: string }[] = [
	{ title: "Days", text: "UTC, midnight to midnight, as Creator Hub's daily numbers. Only full days count: the cards and charts end yesterday, since today isn't over." },
	{ title: "Sessions", text: "One session per join, from its first to its last event, with no minimum length. It counts on the day it started, so a player active past midnight is a daily active user of the first day only." },
	{ title: "Who counts", text: "Players on public, private and reserved servers. Studio play tests don't count (Creator Hub only sees published games)." },
	{ title: "Active users", text: "Daily active users are the distinct players who started a session that UTC day, averaged over the period. Monthly active users are the distinct players of the 30 days ending on the period's last day." },
	{ title: "New users and retention", text: "A new user is a player's first-ever session. Day 1 / 7 / 30 retention is by first play date: the share of that day's new users who start a new session exactly 1 / 7 / 30 days later, over the latest join days whose day N is over." },
	{ title: "Averages", text: "A card is the average of its daily values over the period: average session time and playtime per DAU, payer conversion, ARPPU and ARPDAU are computed each day, then averaged, as Creator Hub's 7-day averages." },
	{ title: "Revenue", text: "Robux players paid in purchases the game server logged, times 70% (Roblox keeps 30% of developer product and pass sales). An estimate: Creator Hub also counts sales outside the game." },
	{ title: "Concurrent users", text: "Players per minute from the servers' heartbeats, summed over servers (Studio left out): the peak minute and the average of the minutes, per hour and over the last 24 h. An estimate: a heartbeat is about once a minute." },
	{ title: "Data delay", text: "None here: events arrive within seconds. Creator Hub's daily numbers settle a day or more after the day ends, and its last days can be marked as estimates." },
];

function HowCalculated() {
	return (
		<Section title="How these are calculated" description="The rules this page follows to match Creator Hub. Cards marked Estimate or Ours can't match exactly; hover the mark for why.">
			<dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
				{CALCULATION_NOTES.map((n) => (
					<div key={n.title}>
						<dt className="font-medium">{n.title}</dt>
						<dd className="text-muted-foreground">{n.text}</dd>
					</div>
				))}
			</dl>
		</Section>
	);
}

/** "Oct 1 - Oct 7 (UTC)" for a period's [from, to). */
export function periodLabel(p: { from: string; to: string }): string {
	const fmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	return `${fmt(Date.parse(p.from))} - ${fmt(Date.parse(p.to) - 1)} (UTC)`;
}

// The page ------------------------------------------------------------------------------------------------------------

export default function Roblox() {
	const filters = useNoRange();
	const [period, setPeriod] = useParam("period", "7");
	const days = [7, 14, 28].includes(Number(period)) ? Number(period) : 7;
	const [bench, setBench] = useState<Benchmarks>(() => loadBenchmarks());
	const [editing, setEditing] = useState(false);
	const q = useAnalytics("benchmarks", { days }, { filters });
	const save = (next: Benchmarks) => {
		setBench(next);
		saveBenchmarks(next);
	};
	return (
		<>
			<PageHeader
				title="Roblox overview"
				description={`Creator Hub's overview, from your own events and computed the way Creator Hub defines it: the last ${days} full UTC days against the ${days} days before. The filter bar's branch, artifact, device, players and variant apply; its date range doesn't.`}
				actions={
					<>
						<ToggleGroup type="single" variant="outline" size="sm" value={String(days)} onValueChange={(v) => v && setPeriod(v)} aria-label="Period">
							{[7, 14, 28].map((d) => (
								<ToggleGroupItem key={d} value={String(d)} className="px-2.5 text-xs">
									{d} days
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						<Popover open={editing} onOpenChange={setEditing}>
							<PopoverTrigger asChild>
								<Button variant="outline" size="sm">
									<SlidersHorizontal />
									Set benchmarks
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-[26rem]">
								<BenchmarkEditor value={bench} onSave={save} onClose={() => setEditing(false)} />
							</PopoverContent>
						</Popover>
					</>
				}
			/>
			<div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
				<div className="space-y-4">
					<QueryState query={q} loadingRows={4}>
						{(r) =>
							r.current.players === 0 && r.previous.players === 0 ? (
								<EmptyState>No players in the last {2 * days} days.</EmptyState>
							) : (
								<div className="space-y-2">
									<p className="text-xs text-muted-foreground tabular-nums">
										{periodLabel(r.current)} vs {periodLabel(r.previous)}
									</p>
									<div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
										{CARDS.map((spec) => (
											<BenchmarkCard
												key={spec.key}
												spec={spec}
												current={r.current}
												previous={r.previous}
												days={days}
												{...(bench[spec.key] ? { bench: bench[spec.key] } : {})}
												onSet={() => setEditing(true)}
											/>
										))}
									</div>
								</div>
							)
						}
					</QueryState>
					<p className="text-xs text-muted-foreground">
						No genre benchmarks here: the percentile marker is estimated from the 50th and 90th you type in, by straight lines between them.
					</p>
				</div>
				<Realtime filters={filters} />
			</div>
			<Trends filters={filters} />
			<HowCalculated />
		</>
	);
}
