/**
 * Backend stats: what the backend process itself is doing, like Roblox's Performance tab for a game server. Requests,
 * DuckDB queries, rows in (ingest) and rows loaded, SQLite statements per second; request latency at p50 / p90 / p99;
 * memory, CPU and event loop lag; each over the last 2 minutes (per second) or the last hour (per minute); and a table
 * per route group over a picked window. The page polls GET /v1/admin/stats every 2 s while Live is on. Owners only.
 */
import { useQuery } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, ErrorState, KeyValue, LoadingBlock, Metric, PageHeader, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { fmtBytes, fmtDuration, fmtInt, fmtNum, fmtTime } from "@/lib/format";
import type { BackendStats, RouteGroup, RouteStats, StatsBucket, StatsWindow } from "@/lib/types";

export const BACKEND_STATS_KEY = ["backend-stats"] as const;
const POLL_MS = 2000;

const WINDOWS: { id: StatsWindow; label: string }[] = [
	{ id: "1m", label: "1 min" },
	{ id: "5m", label: "5 min" },
	{ id: "15m", label: "15 min" },
	{ id: "1h", label: "1 hour" },
];

/** The charts: the last 2 minutes second by second, or the last hour minute by minute. */
type History = "seconds" | "minutes";
const HISTORIES: { id: History; label: string; title: string }[] = [
	{ id: "seconds", label: "Last 2 min", title: "The last 2 minutes, per second" },
	{ id: "minutes", label: "Last 60 min", title: "The last hour, per minute" },
];

export const ROUTE_LABELS: Record<RouteGroup, string> = {
	ingest: "Ingest (events, identities)",
	"errors-in": "Error logs in",
	"fleet-in": "Fleet posts (heartbeats, reports)",
	"long-poll": "Remote debug long-poll",
	stream: "Event streams (SSE)",
	query: "Queries",
	sql: "SQL sandbox",
	rollups: "Rollups",
	errors: "Errors, experiments, players",
	fleet: "Fleet reads",
	roblox: "Roblox lookups, identity",
	auth: "Sign-in",
	admin: "Admin (settings, storage, stats)",
	health: "Health check",
	explorer: "Explorer files",
	other: "Other",
};

const ms = (v: number | null | undefined): string => (v === null || v === undefined ? "–" : `${fmtNum(v, v < 10 ? 2 : v < 100 ? 1 : 0)} ms`);
const perSecond = (v: number | null | undefined): string => (v === null || v === undefined ? "–" : fmtNum(v, v < 10 ? 2 : v < 100 ? 1 : 0));
const mb = (v: number | null | undefined): string => (v === null || v === undefined ? "–" : `${fmtNum(v, v < 1000 ? 1 : 0)} MB`);

/** One chart row: `t` and one value per series (null = no sample). */
export interface StatsRow {
	t: number;
	[series: string]: number | null;
}

/**
 * A full timeline of the history (every second or minute, oldest first), counters divided by the bucket's span so both
 * histories read per second; a missing bucket is a quiet one (0), its samples unknown (null).
 */
export function timeline(stats: Pick<BackendStats, "now" | "seconds" | "minutes">, history: History): StatsRow[] {
	const span = history === "seconds" ? 1000 : 60_000;
	const count = history === "seconds" ? 120 : 60;
	const buckets = new Map((history === "seconds" ? stats.seconds : stats.minutes).map((b) => [b.at, b]));
	// The second running now is left out (it would read low); the minute running now is in (the hour's last point).
	const end = history === "seconds" ? Math.floor(stats.now / span) * span - span : Math.floor(stats.now / span) * span;
	const rows: StatsRow[] = [];
	for (let i = count - 1; i >= 0; i--) {
		const at = end - i * span;
		const b: StatsBucket | undefined = buckets.get(at);
		const rate = (n: number) => Math.round((n / (span / 1000)) * 100) / 100;
		rows.push({
			t: at,
			requests: rate(b?.requests ?? 0),
			errors: rate(b?.status["5xx"] ?? 0),
			duckQueries: rate(b?.duckdb.queries ?? 0),
			rowsIn: rate(b?.ingest.rows ?? 0),
			rowsLoaded: rate(b?.duckdb.rowsLoaded ?? 0),
			sqliteReads: rate(b?.sqlite.reads ?? 0),
			sqliteWrites: rate(b?.sqlite.writes ?? 0),
			p50: b?.latency.p50 ?? null,
			p90: b?.latency.p90 ?? null,
			p99: b?.latency.p99 ?? null,
			duckP50: b?.duckdb.latency.p50 ?? null,
			duckP99: b?.duckdb.latency.p99 ?? null,
			rss: b?.memory?.rssMb ?? null,
			heap: b?.memory?.heapMb ?? null,
			external: b?.memory?.externalMb ?? null,
			cpu: b?.cpuPercent ?? null,
			lag: b?.loopLagMs ?? null,
		});
	}
	return rows;
}

interface Series {
	id: string;
	label: string;
	color: string;
}

function StatsChart({ label, rows, series, format, history }: { label: string; rows: StatsRow[]; series: Series[]; format(v: number): string; history: History }) {
	const config: ChartConfig = Object.fromEntries(series.map((s) => [s.id, { label: s.label, color: s.color }]));
	const tick = (t: number) => {
		const iso = new Date(t).toISOString();
		return history === "seconds" ? iso.slice(11, 19) : iso.slice(11, 16);
	};
	return (
		<div role="figure" aria-label={label}>
			<ChartContainer config={config} className="aspect-auto h-48 w-full">
				<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={6} minTickGap={40} tickFormatter={tick} />
					<YAxis tickLine={false} axisLine={false} width={56} allowDecimals tickFormatter={(v: number) => format(v)} />
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => {
									const t = payload?.[0]?.payload?.t;
									return typeof t === "number" ? `${new Date(t).toISOString().replace("T", " ").slice(0, 19)} UTC` : "";
								}}
								formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? format(v) : "–"}`}
							/>
						}
					/>
					{series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
					{series.map((s) => (
						<Line key={s.id} dataKey={s.id} name={s.id} stroke={`var(--color-${s.id})`} strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls={false} />
					))}
				</LineChart>
			</ChartContainer>
		</div>
	);
}

const ROUTE_COLUMNS: DataColumn<RouteStats>[] = [
	{ id: "group", header: "Route group", accessor: (r) => ROUTE_LABELS[r.group] ?? r.group, type: "text", cell: (r) => <span title={r.group}>{ROUTE_LABELS[r.group] ?? r.group}</span>, hideable: false },
	{ id: "requests", header: "Requests", accessor: (r) => r.requests, type: "number", cell: (r) => fmtInt(r.requests), className: "text-right tabular-nums" },
	{
		id: "errors",
		header: "5xx",
		accessor: (r) => r.errors,
		type: "number",
		cell: (r) => <span className={r.errors ? "text-[var(--status-critical)]" : "text-muted-foreground"}>{fmtInt(r.errors)}</span>,
		className: "text-right tabular-nums",
	},
	{ id: "p50", header: "p50", accessor: (r) => r.latency.p50, type: "number", cell: (r) => ms(r.latency.p50), className: "text-right tabular-nums" },
	{ id: "p90", header: "p90", accessor: (r) => r.latency.p90, type: "number", cell: (r) => ms(r.latency.p90), className: "text-right tabular-nums" },
	{ id: "p99", header: "p99", accessor: (r) => r.latency.p99, type: "number", cell: (r) => ms(r.latency.p99), className: "text-right tabular-nums" },
	{ id: "max", header: "Max", accessor: (r) => r.latency.max, type: "number", cell: (r) => ms(r.latency.max), className: "text-right tabular-nums" },
	{ id: "avg", header: "Avg", accessor: (r) => r.latency.avg, type: "number", cell: (r) => ms(r.latency.avg), className: "text-right tabular-nums" },
];

const C = (i: number) => `var(--chart-${i})`;

export default function BackendStatsPage() {
	const [window, setWindow] = useState<StatsWindow>("5m");
	const [history, setHistory] = useState<History>("seconds");
	const [live, setLive] = useState(true);
	const stats = useQuery({
		queryKey: [...BACKEND_STATS_KEY, window],
		queryFn: ({ signal }) => api.backendStats(window, signal),
		refetchInterval: live ? POLL_MS : false,
		staleTime: 0,
		placeholderData: (previous) => previous,
	});
	const data = stats.data;
	const rows = useMemo(() => (data ? timeline(data, history) : []), [data, history]);
	const historyTitle = HISTORIES.find((h) => h.id === history)?.title ?? "";

	return (
		<div className="space-y-4">
			<PageHeader
				title="Backend stats"
				description="What this backend process is doing: requests, queries and inserts per second, latency, memory and CPU."
				actions={
					<>
						<ToggleGroup type="single" variant="outline" size="sm" value={history} onValueChange={(v) => v && setHistory(v as History)} aria-label="History">
							{HISTORIES.map((h) => (
								<ToggleGroupItem key={h.id} value={h.id} className="px-2.5 text-xs" title={h.title}>
									{h.label}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						<Button variant={live ? "default" : "outline"} size="sm" onClick={() => setLive((v) => !v)} aria-pressed={live} title={live ? "Updating every 2 seconds. Click to pause." : "Paused. Click to update every 2 seconds."}>
							{live ? <Pause /> : <Play />}
							{live ? "Live" : "Paused"}
						</Button>
					</>
				}
			/>
			{stats.isError && !data ? <ErrorState error={stats.error} /> : null}
			{!data && !stats.isError ? <LoadingBlock rows={6} /> : null}
			{data ? (
				<>
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="stats-tiles">
						<Metric label="Requests / s" value={perSecond(data.rates.requests)} sub={`${perSecond(data.rates.errors)} errors / s (5xx)`} hint={`Last ${data.rates.seconds} s`} />
						<Metric label="Queries / s" value={perSecond(data.rates.duckQueries)} sub={`DuckDB statements · SQLite reads ${perSecond(data.rates.sqliteReads)} / s`} hint={`DuckDB p50 ${ms(data.duckdb.recent.p50)}, p99 ${ms(data.duckdb.recent.p99)}`} />
						<Metric label="Inserts / s" value={perSecond(data.rates.rowsIn)} sub={`rows accepted · loaded ${perSecond(data.rates.rowsLoaded)} / s`} hint={`SQLite writes ${perSecond(data.rates.sqliteWrites)} / s`} />
						<Metric label="Latency p50" value={ms(data.latency.recent.p50)} sub={`p90 ${ms(data.latency.recent.p90)} · p99 ${ms(data.latency.recent.p99)}`} hint={`Max ${ms(data.latency.recent.max)}, ${fmtInt(data.latency.recent.count)} requests`} />
						<Metric label="Memory" value={mb(data.sample?.rssMb)} sub={`heap ${mb(data.sample?.heapMb)} of ${mb(data.sample?.heapTotalMb)}`} hint={`Native, buffers ${mb(data.sample?.externalMb)} (RSS is the process)`} />
						<Metric label="CPU" value={data.sample ? `${fmtNum(data.sample.cpuPercent, 1)}%` : "–"} sub={`event loop lag ${ms(data.sample?.loopLagMs)}`} hint="100% = one core busy" />
						<Metric label="Uptime" value={fmtDuration(data.uptimeSeconds * 1000)} sub={`${data.runtime} · v${data.version}`} hint={data.state === "ready" ? "Ready" : `State: ${data.state}`} tone={data.state === "ready" ? undefined : "muted"} />
					</div>

					<div className="grid gap-4 lg:grid-cols-2">
						<Section title="Requests per second" description={historyTitle}>
							<StatsChart label="Requests per second" history={history} rows={rows} format={perSecond} series={[{ id: "requests", label: "Requests / s", color: C(1) }, { id: "errors", label: "5xx / s", color: C(5) }]} />
						</Section>
						<Section title="Queries and inserts per second" description={historyTitle}>
							<StatsChart
								label="Queries and inserts per second"
								history={history}
								rows={rows}
								format={perSecond}
								series={[
									{ id: "duckQueries", label: "DuckDB queries / s", color: C(1) },
									{ id: "rowsIn", label: "Rows in / s", color: C(2) },
									{ id: "rowsLoaded", label: "Rows loaded / s", color: C(3) },
									{ id: "sqliteReads", label: "SQLite reads / s", color: C(4) },
									{ id: "sqliteWrites", label: "SQLite writes / s", color: C(6) },
								]}
							/>
						</Section>
						<Section title="Request latency" description={`${historyTitle}. Streams and long-polls are left out.`}>
							<StatsChart label="Request latency" history={history} rows={rows} format={ms} series={[{ id: "p50", label: "p50", color: C(1) }, { id: "p90", label: "p90", color: C(3) }, { id: "p99", label: "p99", color: C(5) }]} />
						</Section>
						<Section title="DuckDB statement latency" description={historyTitle}>
							<StatsChart label="DuckDB statement latency" history={history} rows={rows} format={ms} series={[{ id: "duckP50", label: "p50", color: C(1) }, { id: "duckP99", label: "p99", color: C(5) }]} />
						</Section>
						<Section title="Memory" description={`${historyTitle}. RSS is the whole process; the heap is JavaScript's.`}>
							<StatsChart label="Memory" history={history} rows={rows} format={mb} series={[{ id: "rss", label: "RSS", color: C(1) }, { id: "heap", label: "Heap used", color: C(2) }, { id: "external", label: "Native, buffers", color: C(4) }]} />
						</Section>
						<Section title="CPU and event loop lag" description={`${historyTitle}. Lag: how late the once-a-second tick came (the worst in the bucket).`}>
							<StatsChart label="CPU and event loop lag" history={history} rows={rows} format={(v) => fmtNum(v, 1)} series={[{ id: "cpu", label: "CPU %", color: C(1) }, { id: "lag", label: "Loop lag ms", color: C(5) }]} />
						</Section>
					</div>

					<Section
						title="By route group"
						description={`Requests and latency per kind of route over the last ${WINDOWS.find((w) => w.id === window)?.label ?? window}. Overall: p50 ${ms(data.latency.window.p50)}, p99 ${ms(data.latency.window.p99)} over ${fmtInt(data.latency.window.count)} requests.`}
						actions={
							<ToggleGroup type="single" variant="outline" size="sm" value={window} onValueChange={(v) => v && setWindow(v as StatsWindow)} aria-label="Window">
								{WINDOWS.map((w) => (
									<ToggleGroupItem key={w.id} value={w.id} className="px-2.5 text-xs">
										{w.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						}
					>
						{data.routes.length ? (
							<DataTable id="backend-routes" label="Requests by route group" columns={ROUTE_COLUMNS} data={data.routes} rowId={(r) => r.group} defaultSort={[{ id: "requests", desc: true }]} search={false} pageSize={20} />
						) : (
							<EmptyState>No requests in this window yet.</EmptyState>
						)}
					</Section>

					<Section title="Since start" description={`Counting from ${fmtTime(data.totals.since)} UTC.`}>
						<div className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
							<KeyValue label="Requests">{fmtInt(data.totals.requests)}</KeyValue>
							<KeyValue label="5xx">{fmtInt(data.totals.errors)}</KeyValue>
							<KeyValue label="DuckDB queries">{fmtInt(data.totals.duckQueries)}</KeyValue>
							<KeyValue label="Rows in">{fmtInt(data.totals.rowsIn)}</KeyValue>
							<KeyValue label="Bytes in">{fmtBytes(data.totals.bytesIn)}</KeyValue>
							<KeyValue label="Rows loaded">{fmtInt(data.totals.rowsLoaded)}</KeyValue>
							<KeyValue label="SQLite reads">{fmtInt(data.totals.sqliteReads)}</KeyValue>
							<KeyValue label="SQLite writes">{fmtInt(data.totals.sqliteWrites)}</KeyValue>
						</div>
					</Section>
				</>
			) : null}
		</div>
	);
}
