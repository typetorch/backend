/**
 * The Roblox page's acquisition section, from Roblox itself (GET /v1/roblox/analytics/acquisition: Open Cloud's
 * Analytics Query API, read by the backend with OPENCLOUD_API_KEY). The play-through rate starts at the Home impression,
 * which a game can't see, so these are the only Creator Hub numbers here that come from Roblox rather than our events.
 * Without the key's `universe.analytics:read` scope the backend answers 409 and the section says how to turn it on.
 */
import { useQuery } from "@tanstack/react-query";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { EmptyState, ErrorState, LoadingBlock, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { barMax, change, estimatePercentile, type Benchmark } from "@/lib/benchmarks";
import { fmtInt, fmtNum, fmtPct } from "@/lib/format";
import type { RobloxAcquisition as Acquisition, RobloxAcquisitionPeriod } from "@/lib/types";

export const ANALYTICS_SCOPE = "universe.analytics:read";

interface Spec {
	key: "playThroughHome" | "qualifiedPlayThrough" | "impressions" | "qualifiedPlays";
	title: string;
	value(p: RobloxAcquisitionPeriod): number | null;
	format(v: number): string;
	info: string;
}

const pct = (v: number | null) => (v === null ? null : v * 100);

export const ACQUISITION_CARDS: Spec[] = [
	{
		key: "playThroughHome",
		title: "Play-through rate (home recommendations)",
		value: (p) => pct(p.playThroughHome),
		format: (v) => `${fmtNum(v, 2)}%`,
		info: "Roblox's RFYPlayThroughRate: the share of users shown the game in Home's recommendations who went on to play, per day, averaged over the period's days (Creator Hub's PTR chart). Compare it with the 50th / 90th you read on Creator Hub.",
	},
	{
		key: "qualifiedPlayThrough",
		title: "Qualified play-through rate",
		value: (p) => pct(p.qualifiedPlayThrough),
		format: (v) => `${fmtNum(v, 2)}%`,
		info: "Roblox's QualifiedEndToEndCVR: the share of users with an impression, from every source, who went on to a qualified play (intentional engagement, not a bounce), per day, averaged over the period's days.",
	},
	{
		key: "impressions",
		title: "Users with impressions",
		value: (p) => p.impressions,
		format: (v) => fmtInt(v),
		info: "Roblox's UniqueUsersWithImpressions: users who saw the game's tile on Home, Search, Charts or elsewhere, unique per day, summed over the period's days.",
	},
	{
		key: "qualifiedPlays",
		title: "Users with qualified plays",
		value: (p) => p.qualifiedPlays,
		format: (v) => fmtInt(v),
		info: "Roblox's QualifiedUniqueUsersWithPlaySessions: users with a qualified play after an impression, unique per day, summed over the period's days.",
	},
];

function SourceBadge() {
	return (
		<Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
			source: Roblox
		</Badge>
	);
}

function Bar({ value, bench, onSet }: { value: number | null; bench?: Benchmark; onSet(): void }) {
	if (value === null) return <div className="h-2 rounded-full bg-muted" />;
	const max = barMax(value, bench);
	const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
	const percentile = bench ? estimatePercentile(value, bench) : null;
	return (
		<div className="space-y-1">
			<div className="relative h-2 rounded-full bg-muted">
				<div className="absolute inset-y-0 left-0 rounded-full bg-[var(--chart-1)]" style={{ width: at(value) }} />
				{bench ? [bench.p50, bench.p90].map((v, i) => <div key={i} className="absolute -top-1 h-4 w-0.5 bg-foreground/70" style={{ left: at(v) }} title={`${i ? "90th" : "50th"} percentile: ${fmtNum(v)}`} />) : null}
			</div>
			{bench ? (
				<div className="flex justify-between text-[11px] text-muted-foreground">
					<span>
						50th {fmtNum(bench.p50)} · 90th {fmtNum(bench.p90)}
					</span>
					<span className="tabular-nums">{percentile === null ? "" : `est. ~${percentile}th percentile`}</span>
				</div>
			) : (
				<button type="button" onClick={onSet} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
					set benchmarks
				</button>
			)}
		</div>
	);
}

function AcquisitionCard({ spec, r, bench, onSet }: { spec: Spec; r: Acquisition; bench?: Benchmark; onSet(): void }) {
	const value = spec.value(r.current);
	const missing = r.current.daysWithData < r.days ? `${r.current.daysWithData} of ${r.days} days have data` : null;
	return (
		<Card className="gap-2 py-4">
			<CardContent className="space-y-2">
				<div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					{spec.title}
					<InfoTip>{spec.info}</InfoTip>
					<SourceBadge />
				</div>
				<div className="flex items-baseline gap-2">
					<span className={value === null ? "text-2xl font-semibold text-muted-foreground" : "text-2xl font-semibold tracking-tight tabular-nums"}>{value === null ? "n/a" : spec.format(value)}</span>
					<ChangeChip change={change(value, spec.value(r.previous))} against={`the ${r.days} days before`} />
				</div>
				{spec.key === "playThroughHome" ? <Bar value={value} {...(bench ? { bench } : {})} onSet={onSet} /> : null}
				<p className="text-[11px] text-muted-foreground">{missing ?? `Roblox's ${r.metrics[spec.key]}`}</p>
			</CardContent>
		</Card>
	);
}

/**
 * `days` is the page's period (7, 14 or 28); `bench` the 50th / 90th the user typed for the play-through rate (Creator
 * Hub's benchmark, in percent), `onSet` opens the editor.
 */
export function RobloxAcquisition({ days, bench, onSet }: { days: number; bench?: Benchmark; onSet(): void }) {
	const q = useQuery({ queryKey: ["roblox", "acquisition", days], queryFn: ({ signal }) => api.robloxAcquisition(days, signal), staleTime: 300_000, retry: false });
	const off = q.error instanceof ApiError && q.error.status === 409;
	return (
		<Section
			title={
				<span className="flex items-center gap-1.5">
					Acquisition, from Roblox
					<SourceBadge />
				</span>
			}
			description={`Creator Hub's play-through rate and its parts, read from Roblox's Analytics Query API (the game can't see impressions): the last ${days} full UTC days against the ${days} days before. The filter bar doesn't apply. Cached an hour.`}
			contentClassName="space-y-3"
		>
			{q.isPending ? (
				<LoadingBlock rows={2} />
			) : off ? (
				<EmptyState>
					Off: give <code>OPENCLOUD_API_KEY</code> the <code>{ANALYTICS_SCOPE}</code> scope (API system universe-analytics) on the game and set <code>TYPETORCH_UNIVERSE_ID</code>, then restart the backend.
				</EmptyState>
			) : q.isError ? (
				<ErrorState error={q.error} title="Roblox didn't answer" />
			) : (
				<Body r={q.data} {...(bench ? { bench } : {})} onSet={onSet} />
			)}
		</Section>
	);
}

function Body({ r, bench, onSet }: { r: Acquisition; bench?: Benchmark; onSet(): void }) {
	if (r.current.daysWithData === 0 && r.previous.daysWithData === 0) return <EmptyState>Roblox has no acquisition data for the last {2 * r.days} days.</EmptyState>;
	return (
		<>
			<div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
				{ACQUISITION_CARDS.map((spec) => (
					<AcquisitionCard key={spec.key} spec={spec} r={r} {...(bench ? { bench } : {})} onSet={onSet} />
				))}
			</div>
			{r.sources.length ? (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Source</TableHead>
							<TableHead className="text-right">Users with impressions</TableHead>
							<TableHead className="text-right">Users with qualified plays</TableHead>
							<TableHead className="text-right">Qualified plays per impression</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{r.sources.map((s) => (
							<TableRow key={s.source}>
								<TableCell>{s.label}</TableCell>
								<TableCell className="text-right tabular-nums">{fmtInt(s.impressions)}</TableCell>
								<TableCell className="text-right tabular-nums">{fmtInt(s.qualifiedPlays)}</TableCell>
								<TableCell className="text-right tabular-nums">{fmtPct(s.rate, 2)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : null}
			<p className="text-xs text-muted-foreground">
				Rates are the mean of Roblox's daily values; counts are unique users per day, summed. The per-source rate is plays over impressions for the period, not Roblox's own chart. Genre benchmarks aren't in the API: type Creator Hub's 50th / 90th under Set benchmarks (play-through rate, from Roblox). Fetched {new Date(r.fetchedAt).toLocaleString("en-US", { timeZone: "UTC", hour12: false })} UTC.
			</p>
		</>
	);
}
