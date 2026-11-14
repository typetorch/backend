/**
 * The Retention page's Revenue tab: revenue per join-day cohort (the `ltv` query). Per cohort, what its players spent
 * from their join day through D0, D1, D3, D7, D14 and D30, per player of the cohort (creator revenue after Roblox's cut,
 * or Robux paid), or the share who had paid. The filter bar applies, so a join source or country filter shows whether
 * one campaign's players paid back. Days not started show "–"; the day in progress (today, UTC) is orange and isn't in
 * the weighted average.
 */
import { useMemo } from "react";
import { cn } from "cn";
import { DataTable, type DataColumn } from "@/components/data-table";
import { QueryState, Section } from "@/components/common";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtInt, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { LtvCell, LtvResult } from "@/lib/types";

export const LTV_DAYS = [0, 1, 3, 7, 14, 30];

export type LtvMetric = "revenue" | "robux" | "payers";
export const LTV_METRICS: Record<LtvMetric, { label: string; title: string }> = {
	revenue: { label: "Revenue per player", title: "What the creator kept per new player of the cohort (after Roblox's cut), from the join day through this day" },
	robux: { label: "Robux paid per player", title: "Robux the cohort paid per new player (before Roblox's cut), from the join day through this day" },
	payers: { label: "Payer share", title: "Share of the cohort who had bought something by this day" },
};

/** The picked number of a cell. */
export function ltvValue(c: LtvCell, metric: LtvMetric): number {
	return metric === "revenue" ? c.revenuePerPlayer : metric === "robux" ? c.robuxPerPlayer : c.payerShare;
}

const perPlayer = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A cell's text: "12.30 R$" per player (always 2 decimals, so a column lines up), or "8.3% (5)" payers. */
export function ltvText(c: LtvCell, metric: LtvMetric): string {
	return metric === "payers" ? `${fmtPct(c.payerShare, 1)} (${fmtInt(c.payers)})` : `${perPlayer.format(ltvValue(c, metric))} R$`;
}

function LtvHeat({ cell, metric, max, elapsed }: { cell: LtvCell | null | undefined; metric: LtvMetric; max: number; elapsed: number }) {
	if (!cell) {
		return (
			<div className="px-2 py-1.5 text-center text-xs text-muted-foreground" title="this day hasn't started yet">
				–
			</div>
		);
	}
	const share = max > 0 ? Math.min(1, ltvValue(cell, metric) / max) : 0;
	const detail = `${fmtInt(cell.robux)} R$ paid in total, ${plural(cell.payers, "payer")}`;
	if (cell.partial) {
		const alpha = 0.1 + share * 0.8;
		return (
			<div
				className={cn("rounded border border-dashed px-2 py-1.5 text-center text-xs tabular-nums", alpha > 0.5 ? "text-white" : "text-foreground")}
				style={{ backgroundColor: `rgba(var(--heat-partial), ${alpha.toFixed(2)})`, borderColor: "rgba(var(--heat-partial), 0.9)" }}
				title={`In progress: today (UTC) so far, ${Math.round(elapsed * 100)}% of the day over. ${detail}. Can still go up until midnight UTC.`}
			>
				{ltvText(cell, metric)}
			</div>
		);
	}
	const alpha = 0.08 + share * 0.82;
	return (
		<div
			className={cn("rounded px-2 py-1.5 text-center text-xs tabular-nums", alpha > 0.5 ? "text-white" : "text-foreground")}
			style={{ backgroundColor: `rgba(var(--heat), ${alpha.toFixed(2)})` }}
			title={detail}
		>
			{ltvText(cell, metric)}
		</div>
	);
}

interface Row {
	date: string;
	size: number;
	average?: boolean;
	days: Record<string, LtvCell | null>;
}

function ltvColumns(days: number[], metric: LtvMetric, max: number, elapsed: number): DataColumn<Row>[] {
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
				id: `d${d}`,
				header: `D${d}`,
				title: `${LTV_METRICS[metric].title} (D${d}${d === 0 ? " = the join day" : ""})`,
				accessor: (r) => {
					const c = r.days[d];
					return c ? (metric === "payers" ? Math.round(c.payerShare * 10_000) / 100 : ltvValue(c, metric)) : null;
				},
				cell: (r) => <LtvHeat cell={r.days[d]} metric={metric} max={max} elapsed={elapsed} />,
				format: (_v, r) => {
					const c = r.days[d];
					return c ? `${ltvText(c, metric)}${c.partial ? " so far" : ""}` : "";
				},
				align: "center",
				className: "p-0.5",
				minWidth: 80,
			}),
		),
	];
}

export function LtvBody({ data, metric }: { data: LtvResult; metric: LtvMetric }) {
	const total = data.cohorts.reduce((s, c) => s + c.size, 0);
	const max = useMemo(() => {
		let m = 0;
		for (const c of data.cohorts) for (const cell of Object.values(c.days)) if (cell) m = Math.max(m, ltvValue(cell, metric));
		return m;
	}, [data.cohorts, metric]);
	const elapsed = data.todayElapsed ?? 0;
	const columns = useMemo(() => ltvColumns(data.days, metric, max, elapsed), [data.days, metric, max, elapsed]);
	const rows = useMemo<Row[]>(() => data.cohorts.map((c) => ({ date: c.date, size: c.size, days: c.days })), [data.cohorts]);
	const average = useMemo<Row[]>(() => [{ date: "", size: total, average: true, days: data.average }], [data.average, total]);
	const cut = `${Math.round((1 - data.creatorShare) * 100)}%`;
	return (
		<Section
			className="min-w-0"
			title="Revenue per cohort (LTV)"
			description={`${plural(data.cohorts.length, "cohort")}, ${plural(total, "new player")}. A cell = what the cohort spent from its join day (D0) through that day, per new player (revenue: after Roblox's ${cut}). Orange = today (UTC), so far; it can still go up and isn't in the average. – = not started. The filter bar applies: pick a join source or country to see whether those players paid back.`}
		>
			<DataTable
				id="retention-ltv"
				label="Revenue per cohort"
				columns={columns}
				data={rows}
				rowId={(r) => r.date}
				pinnedRows={average}
				defaultSort={[{ id: "joined", desc: true }]}
			/>
		</Section>
	);
}

export function RetentionLtv() {
	const [metric, setMetric] = useParam("ltv", "revenue");
	const m: LtvMetric = metric in LTV_METRICS ? (metric as LtvMetric) : "revenue";
	const q = useAnalytics("ltv", { days: LTV_DAYS });
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">Show</span>
				<Select value={m} onValueChange={setMetric}>
					<SelectTrigger size="sm" className="w-48" aria-label="LTV number">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(Object.keys(LTV_METRICS) as LtvMetric[]).map((k) => (
							<SelectItem key={k} value={k}>
								{LTV_METRICS[k].label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<QueryState query={q} isEmpty={(d) => d.cohorts.length === 0} empty="No new players joined in this range.">
				{(data) => <LtvBody data={data} metric={m} />}
			</QueryState>
		</div>
	);
}
