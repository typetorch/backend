/**
 * Backups on the Settings page (the backend README's "Backups and restore"): the schedule, the local backups the server
 * keeps, "Back up now", and "Download backup" (a tar of a fresh backup; the backend leaves the alert webhook URL and
 * instance.key out of it). Owners only, like the page.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download } from "lucide-react";
import { EmptyState, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtBytes, fmtInt, fmtTime, plural } from "@/lib/format";
import type { BackupInfo, BackupsStatus } from "@/lib/types";

export const BACKUPS_KEY = ["admin-backups"] as const;

const COLUMNS: DataColumn<BackupInfo>[] = [
	{ id: "at", header: "When", type: "date", accessor: (b) => b.createdAt, cell: (b) => (b.createdAt ? <span title={fmtTime(b.createdAt)}>{fmtAgo(b.createdAt)}</span> : "-"), className: "text-xs whitespace-nowrap" },
	{ id: "name", header: "Folder", accessor: (b) => b.name, cell: (b) => <span className="font-mono text-xs">{b.name}</span> },
	{ id: "reason", header: "Made", type: "enum", accessor: (b) => b.reason ?? "unknown" },
	{ id: "bytes", header: "Size", accessor: (b) => b.bytes, cell: (b) => fmtBytes(b.bytes), filter: false },
	{ id: "files", header: "Files", accessor: (b) => b.files, cell: (b) => fmtInt(b.files), defaultHidden: true },
	{ id: "duckdb", header: "DuckDB", type: "boolean", accessor: (b) => b.duckdb, defaultHidden: true },
];

/** Saves a Blob as a file (an object URL on a temporary link). */
export function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const failure = (error: Error) => (error instanceof ApiError && error.status === 429 ? "Two a minute at most: wait a moment." : error.message);

function Body({ s }: { s: BackupsStatus }) {
	const client = useQueryClient();
	const now = useMutation({
		mutationFn: () => api.backupNow(),
		onSuccess: (status) => client.setQueryData(BACKUPS_KEY, status),
	});
	const download = useMutation({
		mutationFn: () => api.downloadBackup(),
		onSuccess: ({ blob, name }) => saveBlob(blob, name),
	});
	const busy = s.running || now.isPending || download.isPending;
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">
				{s.everyHours > 0 ? `Every ${plural(s.everyHours, "hour")}, keeping the newest ${fmtInt(s.keep)}` : `No schedule (TYPETORCH_BACKUP_HOURS=0); keeping the newest ${fmtInt(s.keep)}`}, in <span className="font-mono text-foreground break-all">{s.dir}</span>.
				{s.next && s.everyHours > 0 ? ` Next ${fmtAgo(s.next)}.` : ""}
			</p>
			{s.last && !s.last.ok ? <p className="text-sm text-destructive">The last backup failed {fmtAgo(s.last.at)}: {s.last.error}</p> : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" onClick={() => now.mutate()} disabled={busy}>
					<Archive />
					{now.isPending ? "Backing up" : "Back up now"}
				</Button>
				<Button size="sm" onClick={() => download.mutate()} disabled={busy}>
					<Download />
					{download.isPending ? "Preparing download" : "Download backup"}
				</Button>
				{now.isError ? <span className="text-xs text-destructive">{failure(now.error)}</span> : null}
				{download.isError ? <span className="text-xs text-destructive">{failure(download.error)}</span> : null}
				{download.isSuccess ? <span className="text-xs">Saved {download.data.name}.</span> : null}
			</div>
			<p className="text-xs text-muted-foreground">The download is a tar of a fresh backup without the alert webhook URL and instance.key. For a big data folder, curl it instead (see the README).</p>
			<DataTable id="backups" label="Local backups" columns={COLUMNS} data={s.backups} rowId={(b) => b.name} defaultSort={[{ id: "at", desc: true }]} density="compact" maxHeight="none" empty={<EmptyState>No local backup yet.</EmptyState>} />
		</div>
	);
}

export function BackupCard() {
	const q = useQuery({ queryKey: BACKUPS_KEY, queryFn: ({ signal }) => api.backups(signal), refetchInterval: 60_000 });
	return (
		<Section title="Backups" description="SQLite, DuckDB and the day files, copied while the server runs.">
			<QueryState query={q} loadingRows={2}>
				{(s) => <Body s={s} />}
			</QueryState>
		</Section>
	);
}
