import { useMemo } from "react";
import { cn } from "cn";
import { DataTable, type DataColumn } from "@/components/data-table";
import { PageHeader, QueryState, Section } from "@/components/common";
import { fmtInt, plural } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { RetentionResult } from "@/lib/types";

/** Today so far (UTC) as "14:20 of 24h". */
const elapsedText = (elapsed: number) => {
	const min = Math.round(elapsed * 24 * 60);
	return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} of 24h`;
};

/**
 * One heatmap cell: the share kept (blue, darker = more), "–" while that day isn't over.
 * The day in progress (today, UTC) shows the share back so far in orange: it can only go up until midnight UTC.
 */
function Heat({ rate, kept, partial }: { rate: number | null; kept?: number | null; partial?: { rate: number; kept: number; elapsed: number } }) {
	if (rate === null && partial) {
		const alpha = 0.1 + Math.min(1, partial.rate) * 0.8;
		return (
			<div
				className={cn(
					"rounded border border-dashed px-2 py-1.5 text-center text-xs tabular-nums",
					alpha > 0.5 ? "text-white" : "text-foreground",
				)}
				style={{ backgroundColor: `rgba(var(--heat-partial), ${alpha.toFixed(2)})`, borderColor: "rgba(var(--heat-partial), 0.9)" }}
				title={`In progress: ${plural(partial.kept, "player")} back so far, ${elapsedText(partial.elapsed)} (UTC) over. Can still go up until midnight UTC.`}
			>
				{retentionPct(partial.rate)}
				<span className="ml-1 opacity-70">({partial.kept})</span>
			</div>
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
}

const heatText = (rate: number | null, kept?: number | null) => (rate === null ? "" : `${retentionPct(rate)}${kept !== undefined && kept !== null ? ` (${kept})` : ""}`);

/** The in-progress cell of a row, if this offset is today. */
function partialOf(r: Row, d: number, elapsed: number) {
	const rate = r.partial?.[d];
	return rate === undefined ? undefined : { rate, kept: r.partialKept?.[d] ?? 0, elapsed };
}

/** One column per day. They sort and filter by the share in percent (42.1), not by the "42% (31)" text. */
function retentionColumns(days: number[], elapsed: number): DataColumn<Row>[] {
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
					const partial = partialOf(r, d, elapsed);
					return <Heat rate={r.rates[d] ?? null} {...(r.kept ? { kept: r.kept[d] } : {})} {...(partial ? { partial } : {})} />;
				},
				format: (_v, r) => {
					const partial = partialOf(r, d, elapsed);
					return partial && (r.rates[d] ?? null) === null ? `${heatText(partial.rate, partial.kept)} so far` : heatText(r.rates[d] ?? null, r.kept?.[d]);
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
	const columns = useMemo(() => retentionColumns(data.days, elapsed), [data.days, elapsed]);
	const rows = useMemo<Row[]>(
		() =>
			data.cohorts.map((c) => ({
				date: c.date,
				size: c.size,
				rates: c.kept,
				kept: c.keptPlayers,
				...(c.partial ? { partial: c.partial } : {}),
				...(c.partialPlayers ? { partialKept: c.partialPlayers } : {}),
			})),
		[data.cohorts],
	);
	const average = useMemo<Row[]>(() => [{ date: "", size: total, average: true, rates: data.average }], [data.average, total]);
	return (
		<Section
			className="min-w-0"
			title="Cohorts by join day"
			description={`${plural(data.cohorts.length, "cohort")}, ${plural(total, "new player")}. A cell = share of the cohort that played again exactly that many days after joining. Orange = today (UTC), so far (${elapsedText(elapsed)}); it can still go up and isn't in the average.`}
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

export default function Retention() {
	const q = useAnalytics("retention", { days: RETENTION_DAYS });
	return (
		<>
			<PageHeader
				title="Retention"
				description="New players by the day they joined, and how many came back on each day from 1 to 30 (D1 = the day after joining). Today (UTC) shows the share back so far in orange; later days show –. Hide days under Columns."
			/>
			<QueryState query={q} isEmpty={(d) => d.cohorts.length === 0} empty="No new players joined in this range.">
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
