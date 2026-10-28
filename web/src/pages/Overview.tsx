import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChangeChip } from "@/components/ChangeChip";
import { CompareToggle } from "@/components/CompareToggle";
import { DayBars, fillDays, fillSteps, type DayPoint } from "@/components/DayBars";
import { DeployMarksToggle, useDeployMarks, useOpenDeploy } from "@/components/DeployMarkers";
import { SavedQueryTile } from "@/components/SavedQueryView";
import { StorageCard } from "@/components/StorageCard";
import { Metric, PageHeader, QueryState, Section } from "@/components/common";
import { api } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { change } from "@/lib/benchmarks";
import { previousPeriod, useCompare } from "@/lib/compare";
import { describeRange } from "@/lib/filters";
import { fmtInt, fmtMinutes, fmtNum } from "@/lib/format";
import { bucketText } from "@/lib/perf";
import { useAnalytics, useFilters } from "@/lib/hooks";
import type { OverviewResult } from "@/lib/types";

const CHARTS: { key: "players" | "newPlayers" | "sessions" | "playtimeHours"; label: string; decimals?: number }[] = [
	{ key: "players", label: "Players" },
	{ key: "newPlayers", label: "New players" },
	{ key: "sessions", label: "Sessions" },
	{ key: "playtimeHours", label: "Playtime (hours)", decimals: 1 },
];

/** The stat tiles: label, value, and the number the change chip compares. */
const TILES: { label: string; value(d: OverviewResult): number; text(d: OverviewResult): string }[] = [
	{ label: "Players", value: (d) => d.players, text: (d) => fmtInt(d.players) },
	{ label: "New players", value: (d) => d.newPlayers, text: (d) => fmtInt(d.newPlayers) },
	{ label: "Returning", value: (d) => d.returningPlayers, text: (d) => fmtInt(d.returningPlayers) },
	{ label: "Sessions", value: (d) => d.sessions, text: (d) => fmtInt(d.sessions) },
	{ label: "Events", value: (d) => d.events, text: (d) => fmtInt(d.events) },
	{ label: "Playtime", value: (d) => d.playtimeHours, text: (d) => `${fmtNum(d.playtimeHours, 1)} h` },
	{ label: "Avg session", value: (d) => d.avgSessionMinutes, text: (d) => fmtMinutes(d.avgSessionMinutes) },
	{ label: "Playtime per player", value: (d) => d.playtimePerPlayerMinutes, text: (d) => fmtMinutes(d.playtimePerPlayerMinutes) },
];

const DAY_MS = 86_400_000;

/** One chart's bars: per step for windows of a day or less (the backend's buckets), else per day. */
export function overviewBars(data: OverviewResult, key: (typeof CHARTS)[number]["key"]): { points: DayPoint[]; per: string } {
	const step = data.bucketMs;
	if (step && step < DAY_MS && data.buckets) {
		const points = fillSteps(
			data.buckets.map((b) => ({ t: b.t, value: b[key] })),
			Date.parse(data.from),
			Date.parse(data.to),
			step,
		);
		return { points, per: `per ${bucketText(step)} (UTC), by the time a session started` };
	}
	return { points: fillDays(data.days.map((d) => ({ date: d.date, value: d[key] })), data.from, data.to), per: "per day (UTC), by the day a session started" };
}

export function Body({ data, previous, branch }: { data: OverviewResult; previous?: OverviewResult; branch?: string | undefined }) {
	// Deploy markers on every chart, on the bar (day or step) each release falls in; a click opens its deploy page.
	const deploys = useDeployMarks({ from: Date.parse(data.from), to: Date.parse(data.to) }, branch);
	const openDeploy = useOpenDeploy();
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
				{TILES.map((t) => (
					<Metric key={t.label} label={t.label} value={t.text(data)} delta={previous ? <ChangeChip change={change(t.value(data), t.value(previous))} against="the previous period" /> : undefined} />
				))}
			</div>
			{deploys.all.length ? (
				<div className="flex justify-end">
					<DeployMarksToggle {...deploys} />
				</div>
			) : null}
			<div className="grid gap-3 lg:grid-cols-2">
				{CHARTS.map((c) => {
					const { points, per } = overviewBars(data, c.key);
					const before = previous ? overviewBars(previous, c.key).points.map((p) => p.value) : undefined;
					return (
						<Section key={c.key} title={c.label} description={before ? `${per}; dashed: the previous period` : per}>
							<DayBars label={c.label} decimals={c.decimals} data={points} {...(before ? { previous: before } : {})} marks={deploys.marks} onMarkClick={openDeploy} />
						</Section>
					);
				})}
			</div>
		</>
	);
}

/** The saved queries pinned to the Overview (Query page); nothing when none are, or the backend has no saved queries. */
function PinnedQueries() {
	const list = useQuery({ queryKey: ["saved-queries"], queryFn: ({ signal }) => api.savedQueries(signal), retry: false, staleTime: 30_000 });
	const pinned = (list.data ?? []).filter((q) => q.pinned);
	if (!pinned.length) return null;
	return (
		<section aria-label="Pinned queries" className="grid gap-3 lg:grid-cols-2">
			{pinned.map((q) => (
				<SavedQueryTile key={q.id} query={q} />
			))}
		</section>
	);
}

export default function Overview() {
	const { state, apiFilters } = useFilters();
	const [compare] = useCompare();
	const period = useMemo(() => previousPeriod(state), [state]);
	const q = useAnalytics("overview");
	const prev = useAnalytics("overview", {}, { enabled: compare && period !== undefined, ...(period ? { filters: period.filters } : {}) });
	const branch = typeof apiFilters.branch === "string" ? apiFilters.branch : undefined;
	// The storage card is the server's disk: owners only (the backend refuses it to a viewer).
	const readOnly = isReadOnly(useAuth());
	return (
		<>
			<PageHeader
				title="Overview"
				description={`Players, sessions and playtime, ${describeRange(state)}. Session length = first to last event.`}
				actions={<CompareToggle disabled={!period} {...(!period ? { title: "Pick a start date to compare with the period before" } : {})} />}
			/>
			<QueryState query={q} loadingRows={6}>
				{(data) => <Body data={data} branch={branch} {...(compare && prev.data ? { previous: prev.data } : {})} />}
			</QueryState>
			<PinnedQueries />
			{readOnly ? null : <StorageCard />}
		</>
	);
}
