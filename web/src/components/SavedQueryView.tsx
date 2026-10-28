/**
 * A SQL answer as a table or a small chart: the Query page's result and the Overview's pinned saved-query tiles. A chart
 * takes the first column as the x axis and the number columns after it as its series (at most four).
 */
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, LoadingBlock, Section } from "@/components/common";
import { DataTable, typeFromSql, type DataColumn } from "@/components/data-table";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { api } from "@/lib/api";
import { fmtInt } from "@/lib/format";
import type { SavedQuery, SavedQueryChart, SqlResult } from "@/lib/types";

/** Rows a pinned tile asks for (the Query page takes its own limit). */
export const TILE_ROWS = 200;
const SERIES_MAX = 4;
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** One column per result column. Ids are the column names (made unique), so a sort or filter on `n` carries to the next query that has an `n`. */
export function sqlColumns(columns: SqlResult["columns"]): DataColumn<unknown[]>[] {
	const used = new Map<string, number>();
	return columns.map((c, i) => {
		const seen = used.get(c.name) ?? 0;
		used.set(c.name, seen + 1);
		const mapped = typeFromSql(c.type);
		// t is unix ms in every table here: sort and filter it as a time, but show and export the number as it is.
		const isTime = c.name === "t" && mapped === "number";
		return {
			id: seen ? `${c.name}_${seen + 1}` : c.name,
			header: c.name,
			hint: c.type,
			title: c.type,
			...(isTime ? { type: "date" as const, exportValue: (row: unknown[]) => row[i] } : mapped ? { type: mapped } : {}),
			accessor: (row: unknown[]) => row[i],
			cell: (row: unknown[]) => {
				const text = cell(row[i]);
				return <span title={text}>{text}</span>;
			},
			format: (value: unknown) => cell(value),
			// Numbers get a range, times a "last 24 hours" choice, text a "contains" box.
			filter: mapped || isTime ? undefined : "text",
			className: mapped === "number" ? "font-mono text-xs" : "max-w-96 truncate font-mono text-xs",
		} satisfies DataColumn<unknown[]>;
	});
}

/** What a chart can draw from an answer: the x column and the number columns after it; none when there is nothing to plot. */
export function chartShape(result: Pick<SqlResult, "columns" | "rows">): { x: number; series: number[] } | undefined {
	if (result.columns.length < 2 || !result.rows.length) return undefined;
	const series: number[] = [];
	for (let i = 1; i < result.columns.length && series.length < SERIES_MAX; i++) {
		const numeric = typeFromSql(result.columns[i]?.type ?? "") === "number" || result.rows.every((r) => r[i] === null || typeof r[i] === "number" || (typeof r[i] === "string" && r[i] !== "" && Number.isFinite(Number(r[i]))));
		if (numeric) series.push(i);
	}
	return series.length ? { x: 0, series } : undefined;
}

/** The chart's rows: `x` as text, each series as a number (null when it isn't one). */
export function chartRows(result: Pick<SqlResult, "columns" | "rows">, shape: { x: number; series: number[] }): Record<string, string | number | null>[] {
	return result.rows.map((r) => {
		const row: Record<string, string | number | null> = { x: cell(r[shape.x]) };
		for (const i of shape.series) {
			const n = r[i] === null || r[i] === undefined ? Number.NaN : Number(r[i]);
			row[`s${i}`] = Number.isFinite(n) ? n : null;
		}
		return row;
	});
}

export function ResultChart({ result, chart, heightClass = "h-48" }: { result: SqlResult; chart: Exclude<SavedQueryChart, "table">; heightClass?: string }) {
	const shape = chartShape(result);
	const rows = useMemo(() => (shape ? chartRows(result, shape) : []), [result, shape]);
	if (!shape) return <EmptyState>Nothing to chart: a chart needs a first column for the axis and at least one number column after it.</EmptyState>;
	const config: ChartConfig = Object.fromEntries(shape.series.map((i, k) => [`s${i}`, { label: result.columns[i]?.name ?? `s${i}`, color: COLORS[k] as string }]));
	const axes = (
		<>
			<CartesianGrid vertical={false} />
			<XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} />
			<YAxis tickLine={false} axisLine={false} width={48} />
			<ChartTooltip content={<ChartTooltipContent />} />
			{shape.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
		</>
	);
	return (
		<div role="figure" aria-label={`Chart of ${result.columns.map((c) => c.name).join(", ")}`}>
			<ChartContainer config={config} className={`aspect-auto w-full ${heightClass}`}>
				{chart === "bar" ? (
					<BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
						{axes}
						{shape.series.map((i) => (
							<Bar key={i} dataKey={`s${i}`} fill={`var(--color-s${i})`} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
						))}
					</BarChart>
				) : (
					<LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
						{axes}
						{shape.series.map((i) => (
							<Line key={i} dataKey={`s${i}`} stroke={`var(--color-s${i})`} strokeWidth={2} dot={false} isAnimationActive={false} />
						))}
					</LineChart>
				)}
			</ChartContainer>
		</div>
	);
}

export function ResultTable({ result, id, maxHeight = "60vh", pageSize = 100, urlSync = true }: { result: SqlResult; id: string; maxHeight?: string; pageSize?: number; urlSync?: boolean }) {
	const columns = useMemo(() => sqlColumns(result.columns), [result.columns]);
	const names = result.columns.map((c) => c.name);
	return (
		<DataTable
			id={id}
			label="SQL result"
			columns={columns}
			data={result.rows}
			pageSize={pageSize}
			urlSync={urlSync}
			maxHeight={maxHeight}
			search
			rowJson={(row) => Object.fromEntries(names.map((name, i) => [name, row[i]]))}
			empty={<p className="text-sm text-muted-foreground">The query returned no rows.</p>}
		/>
	);
}

/** One pinned saved query on the Overview: its answer as its chart (or a table), and a link to it on the Query page. */
export function SavedQueryTile({ query }: { query: SavedQuery }) {
	const run = useQuery({
		queryKey: ["saved-query-run", query.id, query.sql],
		queryFn: ({ signal }) => api.sql(query.sql, TILE_ROWS, signal),
		staleTime: 60_000,
		retry: false,
	});
	const chart = query.chart && query.chart !== "table" ? query.chart : undefined;
	return (
		<Section
			title={query.name}
			description={run.data ? `${fmtInt(run.data.rows.length)} row${run.data.rows.length === 1 ? "" : "s"}${run.data.truncated ? " (more exist)" : ""}, its own range (not the filter bar's)` : "Saved query"}
			actions={
				<Link to={`/query?tab=sql&saved=${query.id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline" title="Open it on the Query page">
					Open
					<ExternalLink className="size-3" />
				</Link>
			}
			className="min-w-0"
		>
			{run.isPending ? (
				<LoadingBlock rows={3} />
			) : run.isError ? (
				<ErrorState error={run.error} title="This query failed" />
			) : chart ? (
				<ResultChart result={run.data} chart={chart} heightClass="h-40" />
			) : (
				<ResultTable result={run.data} id={`saved-tile-${query.id}`} maxHeight="16rem" pageSize={25} urlSync={false} />
			)}
		</Section>
	);
}
