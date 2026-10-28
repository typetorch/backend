/**
 * The error kinds a server reported to the error log (GET /v1/servers/<job>/errors, kept 30 days): each opens the kind on
 * the Errors page, and its build's errors are one link away. Unlike the debug Errors tab (a live server's own memory),
 * this reads the backend's store, so it works for a gone server too.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { EmptyState, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtInt, fmtTime } from "@/lib/format";
import type { ServerErrors as ServerErrorList } from "@/lib/types";

/** The window asked for: the error log's keep window, so a server's whole life is in it. */
export const SERVER_ERRORS_WINDOW = "30d";

type Row = ServerErrorList["errors"][number];

export function errorHref(fp: string): string {
	return `/errors?${new URLSearchParams({ fp, window: SERVER_ERRORS_WINDOW }).toString()}`;
}

const COLUMNS: DataColumn<Row>[] = [
	{
		id: "error",
		header: "Error",
		accessor: (e) => e.template,
		searchText: (e) => e.topFrame ?? "",
		cell: (e) => (
			<Link to={errorHref(e.fp)} className="block underline-offset-2 hover:underline" title="Open this error on the Errors page">
				<span className="break-words font-mono text-xs">{e.template}</span>
				{e.topFrame ? <span className="mt-0.5 block break-words font-mono text-[11px] text-muted-foreground">{e.topFrame}</span> : null}
			</Link>
		),
		className: "max-w-[28rem] whitespace-normal",
	},
	{ id: "side", header: "Side", type: "enum", accessor: (e) => e.realms.join(", "), cell: (e) => e.realms.map((r) => <Badge key={r} variant={r === "server" ? "secondary" : "outline"}>{r}</Badge>) },
	{ id: "count", header: "Count", type: "number", title: "Occurrences this server reported", accessor: (e) => e.count, cell: (e) => fmtInt(e.count) },
	{ id: "lastAt", header: "Last seen", type: "date", accessor: (e) => e.lastAt, cell: (e) => <span title={fmtTime(e.lastAt)}>{fmtAgo(e.lastAt)}</span>, format: (_v, e) => fmtAgo(e.lastAt), className: "text-xs" },
	{ id: "total", header: "All servers", type: "number", title: "Every report of this kind, from every server", accessor: (e) => e.total, cell: (e) => fmtInt(e.total), defaultHidden: true },
];

export function ServerErrors({ job, build, branch }: { job: string; build?: string | null; branch?: string | null }) {
	const query = useQuery({ queryKey: ["errors", "server", job], queryFn: ({ signal }) => api.serverErrors(job, { window: SERVER_ERRORS_WINDOW }, signal), retry: false, refetchInterval: 60_000 });
	// An older backend has no such route: say nothing rather than an error box.
	if (query.error instanceof ApiError && query.error.notFound) return null;
	const buildHref = build ? `/errors?${new URLSearchParams({ build, ...(branch ? { branch } : {}), window: SERVER_ERRORS_WINDOW }).toString()}` : undefined;
	return (
		<Section
			title="Errors it reported"
			description="From the error log (kept 30 days), most frequent first. Open one for its stack and the players who hit it."
			actions={
				buildHref ? (
					<Link to={buildHref} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
						All errors from build {build}
					</Link>
				) : undefined
			}
		>
			<QueryState query={query} loadingRows={3}>
				{(d) =>
					d.errors.length ? (
						<div className="space-y-2">
							<DataTable id="server-errors" label="Errors this server reported" columns={COLUMNS} data={d.errors} rowId={(e) => e.fp} defaultSort={[{ id: "count", desc: true }]} maxHeight="24rem" urlSync={false} />
							{d.more ? <p className="text-xs text-muted-foreground">The {fmtInt(d.errors.length)} most frequent of {fmtInt(d.total)} kinds.</p> : null}
						</div>
					) : (
						<EmptyState>This server reported no errors in the last 30 days.</EmptyState>
					)
				}
			</QueryState>
		</Section>
	);
}
