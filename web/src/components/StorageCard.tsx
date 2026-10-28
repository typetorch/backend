/** What the analytics server keeps on disk (GET /v1/storage), refreshed every 30 s. */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { DiskWarning } from "@/components/DiskWarning";
import { KeyValue, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { api } from "@/lib/api";
import { change } from "@/lib/benchmarks";
import { fmtAgo, fmtBytes, fmtInt, fmtPct } from "@/lib/format";
import type { StoragePart, StorageReport } from "@/lib/types";

/** Each part keeps its color (fixed categorical order). */
const PART_COLORS: Record<string, string> = {
	live: "var(--chart-1)",
	events: "var(--chart-2)",
	recordings: "var(--chart-3)",
	rawArchive: "var(--chart-4)",
	rawIncoming: "var(--chart-5)",
	rollups: "var(--chart-6)",
	fleet: "var(--chart-7)",
	sql: "var(--chart-8)",
	tmp: "var(--muted-foreground)",
};

/** The parts of the disk use: a color dot and the name, then size, share and files. Sorts by the numbers, not the "1.2 MB" text. */
function partColumns(total: number): DataColumn<StoragePart>[] {
	const color = (p: StoragePart) => PART_COLORS[p.key] ?? "var(--muted-foreground)";
	return [
		{
			id: "part",
			header: "Part",
			accessor: (p) => p.label,
			cell: (p) => (
				<span className="inline-flex items-center gap-1.5">
					<span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color(p) }} aria-hidden />
					{p.label}
				</span>
			),
		},
		{ id: "bytes", header: "Size", accessor: (p) => p.bytes, cell: (p) => fmtBytes(p.bytes), format: (_v, p) => fmtBytes(p.bytes), filter: false },
		{ id: "share", header: "Share", accessor: (p) => (total ? p.bytes / total : 0), cell: (p) => fmtPct(total ? p.bytes / total : 0), format: (v) => fmtPct(v as number), filter: false },
		{ id: "files", header: "Files", accessor: (p) => p.files, cell: (p) => fmtInt(p.files) },
		{ id: "days", header: "Days", accessor: (p) => p.days ?? null, defaultHidden: true },
		{ id: "oldest", header: "Oldest", type: "date", accessor: (p) => p.oldest ?? null, defaultHidden: true },
		{ id: "newest", header: "Newest", type: "date", accessor: (p) => p.newest ?? null, defaultHidden: true },
	];
}

function Breakdown({ parts, total }: { parts: StoragePart[]; total: number }) {
	const shown = useMemo(() => parts.filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes), [parts]);
	const columns = useMemo(() => partColumns(total), [total]);
	if (!total) return null;
	return (
		<div className="space-y-2">
			<div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label="Disk use by part">
				{shown.map((p) => (
					<div key={p.key} style={{ width: `${(p.bytes / total) * 100}%`, backgroundColor: PART_COLORS[p.key] ?? "var(--muted-foreground)" }} title={`${p.label}: ${fmtBytes(p.bytes)}`} />
				))}
			</div>
			<DataTable id="storage-parts" label="Disk use by part" columns={columns} data={shown} rowId={(p) => p.key} density="compact" maxHeight="none" />
		</div>
	);
}

function Body({ r }: { r: StorageReport }) {
	const part = (key: string) => r.parts.find((p) => p.key === key);
	const live = part("live");
	const events = part("events");
	const recordings = part("recordings");
	const history = (events?.bytes ?? 0) + (recordings?.bytes ?? 0);
	const g = r.growth;
	return (
		<div className="space-y-4">
			<DiskWarning disk={r.disk} quiet />
			<div className="flex flex-wrap gap-x-8 gap-y-2">
				<div>
					<div className="text-xs text-muted-foreground">On disk</div>
					<div className="text-2xl font-semibold tabular-nums">{fmtBytes(r.totalBytes)}</div>
				</div>
				<div>
					<div className="text-xs text-muted-foreground">DuckDB live (today)</div>
					<div className="text-2xl font-semibold tabular-nums">{fmtBytes(live?.bytes)}</div>
				</div>
				<div>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						Parquet history
						<InfoTip>One file per finished UTC day (events and recordings), written each night.</InfoTip>
					</div>
					<div className="text-2xl font-semibold tabular-nums">{fmtBytes(history)}</div>
					<div className="text-xs text-muted-foreground">
						{events?.days ? `${fmtInt(events.days)} day${events.days === 1 ? "" : "s"}, ${events.oldest} to ${events.newest}` : "no finished day yet"}
					</div>
				</div>
				{r.disk ? (
					<div>
						<div className="text-xs text-muted-foreground">Disk free</div>
						<div className={`text-2xl font-semibold tabular-nums${r.disk.level === "ok" ? "" : " text-destructive"}`}>{fmtBytes(r.disk.freeBytes)}</div>
						<div className="text-xs text-muted-foreground">
							of {fmtBytes(r.disk.totalBytes)} ({fmtPct(r.disk.freePercent / 100)})
						</div>
					</div>
				) : null}
			</div>
			<Breakdown parts={r.parts} total={r.totalBytes} />
			<div className="flex flex-wrap gap-x-6 gap-y-1">
				{r.rows ? (
					<>
						<KeyValue label="live rows">{fmtInt(r.rows.liveEvents + r.rows.liveRecordings)}</KeyValue>
						<KeyValue label="Parquet events">{fmtInt(r.rows.parquetEvents)}</KeyValue>
						<KeyValue label="Parquet recording chunks">{fmtInt(r.rows.parquetRecordings)}</KeyValue>
					</>
				) : null}
				{g ? (
					<div className="flex items-center gap-1.5 text-sm">
						<span className="text-muted-foreground">today's raw batches</span>
						<span className="font-medium tabular-nums">{fmtBytes(g.todayBytes)}</span>
						<span className="text-muted-foreground">{g.avgPerDayBytes === null ? "(no earlier day yet)" : `vs ${fmtBytes(g.avgPerDayBytes)} a day before`}</span>
						{g.avgPerDayBytes !== null ? <ChangeChip change={change(g.todayBytes, g.avgPerDayBytes, true)} against="the 7-day average (today isn't over)" /> : null}
						<InfoTip>The gzip NDJSON archive of accepted batches per UTC day: today so far against the average of up to 7 days before.</InfoTip>
					</div>
				) : null}
			</div>
			<p className="text-[11px] text-muted-foreground">Measured {fmtAgo(r.at)}; the server measures at most every {r.cacheSeconds} s.</p>
		</div>
	);
}

export function StorageCard() {
	const q = useQuery({ queryKey: ["storage"], queryFn: ({ signal }) => api.storage(signal), refetchInterval: 30_000 });
	return (
		<Section title="Storage" description="What the analytics server keeps on disk. Not filtered.">
			<QueryState query={q} loadingRows={3}>
				{(r) => <Body r={r} />}
			</QueryState>
		</Section>
	);
}
