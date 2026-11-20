import { useMemo, useState } from "react";
import { cn } from "cn";
import { ChartBarStacked } from "lucide-react";
import { DataTable, type DataColumn } from "@/components/data-table";
import { ExplainPanel, useExplain } from "@/components/ExplainPanel";
import { Button } from "@/components/ui/button";
import { PageHeader, QueryState, Section } from "@/components/common";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtInt, plural } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { RetentionForecast, RetentionResult } from "@/lib/types";
import { RetentionLtv } from "./RetentionLtv";

/** Today so far (UTC) as "14:20 of 24h". */
const elapsedText = (elapsed: number) => {
	const min = Math.round(elapsed * 24 * 60);
	return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} of 24h`;
};

/** The in-progress cell: so far, and the prediction for midnight UTC when the backend sent one. */
interface PartialCell {
	rate: number;
	kept: number;
	elapsed: number;
	forecast?: { rate: number; kept: number; how: RetentionForecast };
}

/** How the prediction was made, for the tooltip. */
const forecastHow = (how: RetentionForecast) =>
	how.method === "history"
		? `on the last ${how.lookbackDays} days, ${Math.round(how.arrived * 100)}% of returners were back by this time of day`
		: `scaled by the share of the day over (too little history for the time-of-day pattern)`;

/**
 * One heatmap cell: the share kept (blue, darker = more), "–" while that day isn't over.
 * The day in progress (today, UTC) shows the share back so far in orange: it can only go up until midnight UTC. Clicking
 * it switches every in-progress cell to the prediction for midnight (gray, "~"), and back.
 */
function Heat({
	rate,
	kept,
	partial,
	predicted,
	onToggle,
}: {
	rate: number | null;
	kept?: number | null;
	partial?: PartialCell;
	predicted?: boolean;
	onToggle?: () => void;
}) {
	if (rate === null && partial) {
		const f = partial.forecast;
		const show = predicted && f ? f : null;
		const shown = show ? show.rate : partial.rate;
		const alpha = 0.1 + Math.min(1, shown) * 0.8;
		const soFar = `${plural(partial.kept, "player")} back so far (${retentionPct(partial.rate)}), ${elapsedText(partial.elapsed)} (UTC) over.`;
		const title = f
			? show
				? `Predicted by midnight UTC: ~${retentionPct(f.rate)} (${plural(f.kept, "player")}); ${forecastHow(f.how)}. ${soFar} Click to show so far.`
				: `In progress: ${soFar} Can still go up until midnight UTC; predicted ~${retentionPct(f.rate)} (${plural(f.kept, "player")}), ${forecastHow(f.how)}. Click to show the prediction.`
			: `In progress: ${soFar} Can still go up until midnight UTC.`;
		const color = show ? "--heat-forecast" : "--heat-partial";
		return (
			<button
				type="button"
				onClick={f ? onToggle : undefined}
				disabled={!f}
				aria-pressed={f ? !!show : undefined}
				className={cn(
					"w-full rounded border border-dashed px-2 py-1.5 text-center text-xs tabular-nums",
					f ? "cursor-pointer" : "cursor-default",
					alpha > 0.5 ? "text-white" : "text-foreground",
				)}
				style={{ backgroundColor: `rgba(var(${color}), ${alpha.toFixed(2)})`, borderColor: `rgba(var(${color}), 0.9)` }}
				title={title}
			>
				{show ? "~" : ""}
				{retentionPct(shown)}
				<span className="ml-1 opacity-70">({show ? show.kept : partial.kept})</span>
			</button>
		);
	}
	if (rate === null) {
		return (
			<div className="px-2 py-1.5 text-center text-xs text-muted-foreground" title="this day isn't over yet">
				–
			</div>
		);
	}
	const alpha = 0.08 + Math.min(1, rate) * 0.82;
	return (
		<div
			className={cn("rounded px-2 py-1.5 text-center text-xs tabular-nums", alpha > 0.5 ? "text-white" : "text-foreground")}
			style={{ backgroundColor: `rgba(var(--heat), ${alpha.toFixed(2)})` }}
			title={kept !== undefined && kept !== null ? plural(kept, "player") : undefined}
		>
			{retentionPct(rate)}
			{kept !== undefined && kept !== null ? <span className="ml-1 opacity-70">({kept})</span> : null}
		</div>
	);
}

/** A share as a percent with 2 decimals, always both (the backend keeps 4 decimals of the share): "3.45%", "1.00%". */
export const retentionPct = (rate: number) => `${(rate * 100).toFixed(2)}%`;

/** A cohort, or the weighted average (pinned above the cohorts, outside sorting and filtering). */
interface Row {
	date: string;
	size: number;
	average?: boolean;
	rates: Record<string, number | null>;
	kept?: Record<string, number | null>;
	partial?: Record<string, number>;
	partialKept?: Record<string, number>;
	forecast?: Record<string, number>;
	forecastKept?: Record<string, number>;
}

const heatText = (rate: number | null, kept?: number | null) => (rate === null ? "" : `${retentionPct(rate)}${kept !== undefined && kept !== null ? ` (${kept})` : ""}`);

/** The in-progress cell of a row, if this offset is today. */
function partialOf(r: Row, d: number, elapsed: number, how?: RetentionForecast): PartialCell | undefined {
	const rate = r.partial?.[d];
	if (rate === undefined) return undefined;
	const f = r.forecast?.[d];
	return { rate, kept: r.partialKept?.[d] ?? 0, elapsed, ...(f !== undefined && how ? { forecast: { rate: f, kept: r.forecastKept?.[d] ?? 0, how } } : {}) };
}

/** One column per day. They sort and filter by the share in percent (42.1), not by the "42% (31)" text. */
function retentionColumns(days: number[], elapsed: number, view: { how?: RetentionForecast; predicted: boolean; toggle: () => void }): DataColumn<Row>[] {
	return [
		{
			id: "joined",
			header: "Joined (UTC)",
			type: "date",
			accessor: (r) => (r.average ? null : r.date),
			cell: (r) => (r.average ? "Weighted average" : r.date),
			format: (_v, r) => (r.average ? "Weighted average" : r.date),
			className: "tabular-nums",
		},
		{ id: "size", header: "New players", accessor: (r) => r.size, cell: (r) => fmtInt(r.size) },
		...days.map(
			(d): DataColumn<Row> => ({
				id: `day${d}`,
				header: `D${d}`,
				title: `Share of the cohort that played again exactly ${d} days after joining, in percent`,
				accessor: (r) => {
					const rate = r.rates[d];
					return rate === null || rate === undefined ? null : Math.round(rate * 10_000) / 100;
				},
				cell: (r) => {
					const partial = partialOf(r, d, elapsed, view.how);
					return (
						<Heat
							rate={r.rates[d] ?? null}
							{...(r.kept ? { kept: r.kept[d] } : {})}
							{...(partial ? { partial, predicted: view.predicted, onToggle: view.toggle } : {})}
						/>
					);
				},
				format: (_v, r) => {
					const partial = partialOf(r, d, elapsed, view.how);
					if (!partial || (r.rates[d] ?? null) !== null) return heatText(r.rates[d] ?? null, r.kept?.[d]);
					const f = partial.forecast;
					return `${heatText(partial.rate, partial.kept)} so far${f ? `, ~${heatText(f.rate, f.kept)} predicted` : ""}`;
				},
				align: "center",
				className: "p-0.5",
				minWidth: 60,
			}),
		),
	];
}

function Body({ data }: { data: RetentionResult }) {
	const total = data.cohorts.reduce((s, c) => s + c.size, 0);
	const elapsed = data.todayElapsed ?? 0;
	const [predicted, setPredicted] = useState(false);
	const columns = useMemo(
		() => retentionColumns(data.days, elapsed, { ...(data.forecast ? { how: data.forecast } : {}), predicted, toggle: () => setPredicted((v) => !v) }),
		[data.days, elapsed, data.forecast, predicted],
	);
	const rows = useMemo<Row[]>(
		() =>
			data.cohorts.map((c) => ({
				date: c.date,
				size: c.size,
				rates: c.kept,
				kept: c.keptPlayers,
				...(c.partial ? { partial: c.partial } : {}),
				...(c.partialPlayers ? { partialKept: c.partialPlayers } : {}),
				...(c.forecast ? { forecast: c.forecast } : {}),
				...(c.forecastPlayers ? { forecastKept: c.forecastPlayers } : {}),
			})),
		[data.cohorts],
	);
	const average = useMemo<Row[]>(() => [{ date: "", size: total, average: true, rates: data.average }], [data.average, total]);
	return (
		<Section
			className="min-w-0"
			title="Cohorts by join day"
			description={`${plural(data.cohorts.length, "cohort")}, ${plural(total, "new player")}. A cell = share of the cohort that played again exactly that many days after joining. Orange = today (UTC), so far (${elapsedText(elapsed)}); it can still go up and isn't in the average.${data.forecast ? " Click an orange cell to see the prediction for midnight UTC (gray, ~); click again for so far." : ""}`}
		>
			<DataTable
				id="retention-cohorts"
				label="Cohorts by join day"
				columns={columns}
				data={rows}
				rowId={(r) => r.date}
				pinnedRows={average}
				defaultSort={[{ id: "joined", desc: true }]}
			/>
		</Section>
	);
}

/** Every day from 1 to 30 (hide some under Columns). */
export const RETENTION_DAYS = Array.from({ length: 30 }, (_, i) => i + 1);

function PlayersBack() {
	const q = useAnalytics("retention", { days: RETENTION_DAYS });
	return (
		<QueryState query={q} isEmpty={(d) => d.cohorts.length === 0} empty="No new players joined in this range.">
			{(data) => <Body data={data} />}
		</QueryState>
	);
}

/** Two tabs over the same join-day cohorts: who came back (retention), and what they spent (revenue per cohort, LTV). */
export default function Retention() {
	const [tab, setTab] = useParam("view", "players");
	const [, explain] = useExplain();
	return (
		<>
			<PageHeader
				title="Retention"
				actions={
					<Button variant="outline" size="sm" onClick={() => explain("d1")} title="Which segments moved D1 against the period before, of the same length">
						<ChartBarStacked />
						Explain the D1 change
					</Button>
				}
				description="New players by the day they joined: how many came back on each day from 1 to 30 (D1 = the day after joining), and what they spent by D0 to D30. Today (UTC) shows the value so far in orange; later days show –. Hide days under Columns."
			/>
			<Tabs value={tab === "revenue" ? "revenue" : "players"} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="players">Players back</TabsTrigger>
					<TabsTrigger value="revenue">Revenue (LTV)</TabsTrigger>
				</TabsList>
				<TabsContent value="players" className="pt-2">
					<PlayersBack />
				</TabsContent>
				<TabsContent value="revenue" className="pt-2">
					<RetentionLtv />
				</TabsContent>
			</Tabs>
			<ExplainPanel />
		</>
	);
}
