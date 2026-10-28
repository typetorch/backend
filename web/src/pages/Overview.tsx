import { DayBars, fillDays, fillSteps, type DayPoint } from "@/components/DayBars";
import { DeployMarksToggle, useDeployMarks, useOpenDeploy } from "@/components/DeployMarkers";
import { StorageCard } from "@/components/StorageCard";
import { Metric, PageHeader, QueryState, Section } from "@/components/common";
import { isReadOnly, useAuth } from "@/lib/auth";
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

function Body({ data, branch }: { data: OverviewResult; branch: string | undefined }) {
	// Deploy markers on every chart, on the bar (day or step) each release falls in; a click opens its deploy page.
	const deploys = useDeployMarks({ from: Date.parse(data.from), to: Date.parse(data.to) }, branch);
	const openDeploy = useOpenDeploy();
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
				<Metric label="Players" value={fmtInt(data.players)} />
				<Metric label="New players" value={fmtInt(data.newPlayers)} />
				<Metric label="Returning" value={fmtInt(data.returningPlayers)} />
				<Metric label="Sessions" value={fmtInt(data.sessions)} />
				<Metric label="Events" value={fmtInt(data.events)} />
				<Metric label="Playtime" value={`${fmtNum(data.playtimeHours, 1)} h`} />
				<Metric label="Avg session" value={fmtMinutes(data.avgSessionMinutes)} />
				<Metric label="Playtime per player" value={fmtMinutes(data.playtimePerPlayerMinutes)} />
			</div>
			{deploys.all.length ? (
				<div className="flex justify-end">
					<DeployMarksToggle {...deploys} />
				</div>
			) : null}
			<div className="grid gap-3 lg:grid-cols-2">
				{CHARTS.map((c) => {
					const { points, per } = overviewBars(data, c.key);
					return (
						<Section key={c.key} title={c.label} description={per}>
							<DayBars label={c.label} decimals={c.decimals} data={points} marks={deploys.marks} onMarkClick={openDeploy} />
						</Section>
					);
				})}
			</div>
		</>
	);
}

export default function Overview() {
	const { state, apiFilters } = useFilters();
	const q = useAnalytics("overview");
	const branch = typeof apiFilters.branch === "string" ? apiFilters.branch : undefined;
	// The storage card is the server's disk: owners only (the backend refuses it to a viewer).
	const readOnly = isReadOnly(useAuth());
	return (
		<>
			<PageHeader title="Overview" description={`Players, sessions and playtime, ${describeRange(state)}. Session length = first to last event.`} />
			<QueryState query={q} loadingRows={6}>
				{(data) => <Body data={data} branch={branch} />}
			</QueryState>
			{readOnly ? null : <StorageCard />}
		</>
	);
}
