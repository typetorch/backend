/**
 * Roblox logs: the errors and warnings Roblox itself kept for this game server (Open Cloud server management, through
 * the backend: GET /v1/roblox/servers/<job>/logs). Unlike the Logs tab they need no debug session, so they show for a
 * live server and for one that is gone. Roblox files them under the server's place version: the backend knows it from
 * the heartbeat (`pv`); for an older kernel the page asks for it.
 *
 * The entries come from Roblox (and from the game's own messages): every value is shown as text, never as HTML.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { EmptyState, ErrorState, LoadingBlock, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { fmtInt, fmtTime } from "@/lib/format";
import type { RobloxServerLog } from "@/lib/types";
import { MEMORY_ONLY, Tone } from "./shared";

export const ROBLOX_LOGS_OFF_TEXT = "Roblox's server logs need OPENCLOUD_API_KEY (with universe:read on the game) and TYPETORCH_UNIVERSE_ID on the backend.";
export const ROBLOX_LOGS_DESCRIPTION = "Errors and warnings Roblox kept for this server, newest first (about 3 minutes behind; Roblox folds repeats into a count).";

/** Roblox spells severities its own way: anything with "err" is an error, "warn" a warning. */
export function severityTone(severity: string | null): string {
	const s = (severity ?? "").toLowerCase();
	if (s.includes("err") || s.includes("crit") || s.includes("fatal")) return "bg-[var(--status-critical)]";
	if (s.includes("warn")) return "bg-[var(--status-warning)]";
	return "bg-muted-foreground";
}

/** The other fields Roblox sent, as one line of text. */
export function fieldsText(fields: Record<string, string | number | boolean>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join("  ");
}

type Row = RobloxServerLog & { n: number };

const COLUMNS: DataColumn<Row>[] = [
	{ id: "time", header: "When (UTC)", type: "date", accessor: (e) => e.time, cell: (e) => (e.time ? fmtTime(e.time) : "–"), className: "font-mono text-xs tabular-nums whitespace-nowrap" },
	{ id: "severity", header: "Severity", type: "enum", accessor: (e) => e.severity ?? "unknown", cell: (e) => <Tone tone={severityTone(e.severity)}>{e.severity ?? "unknown"}</Tone> },
	{ id: "count", header: "Count", type: "number", accessor: (e) => e.count, cell: (e) => (e.count === null ? "–" : fmtInt(e.count)), className: "tabular-nums" },
	{ id: "message", header: "Message", accessor: (e) => e.message, className: "min-w-64 max-w-[48rem] font-mono text-xs whitespace-pre-wrap break-words" },
	{ id: "stack", header: "Stack", accessor: (e) => e.stack, defaultHidden: true, className: "max-w-[32rem] font-mono text-xs whitespace-pre-wrap break-words" },
	{ id: "fields", header: "Other fields", accessor: (e) => fieldsText(e.fields) || null, defaultHidden: true, className: "max-w-[32rem] font-mono text-xs break-words" },
];

/** A 409 that names the missing place version (an older kernel), as opposed to the backend not being set up. */
export function needsVersion(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && typeof error.body === "object" && error.body !== null && "placeVersion" in error.body;
}

/** The fleet knows the place, only the version is missing (else a version alone won't do). */
function versionOnly(error: unknown): boolean {
	return error instanceof ApiError && typeof (error.body as { placeId?: unknown } | undefined)?.placeId === "number";
}

export function RobloxLogs({ job, placeVersion }: { job: string; placeVersion?: number | null }) {
	const [search, setSearch] = useState("");
	const [searchText, setSearchText] = useState("");
	const [order, setOrder] = useState<"desc" | "asc">("desc");
	// Typed by the owner when the backend doesn't know the server's place version.
	const [version, setVersion] = useState<number | undefined>();
	const [versionText, setVersionText] = useState("");
	// Typed, else what the page knows (the heartbeat's, or the remote debug status' on a live server); the backend falls
	// back to the heartbeat's when none is sent.
	const asked = version ?? placeVersion ?? undefined;
	const logs = useInfiniteQuery({
		queryKey: ["roblox", "logs", job, search, order, asked ?? null],
		queryFn: ({ pageParam, signal }) =>
			api.robloxServerLogs(
				job,
				{ ...(search ? { search } : {}), ...(order === "asc" ? { order } : {}), ...(pageParam ? { pageToken: pageParam } : {}), ...(asked ? { placeVersion: asked } : {}) },
				signal,
			),
		initialPageParam: "",
		getNextPageParam: (last) => last.nextPageToken ?? undefined,
		retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
		staleTime: 20_000,
	});
	const onSearch = (e: FormEvent) => {
		e.preventDefault();
		setSearch(searchText.trim());
	};
	const onVersion = (e: FormEvent) => {
		e.preventDefault();
		const n = Number(versionText);
		if (Number.isSafeInteger(n) && n > 0) setVersion(n);
	};
	const rows: Row[] = (logs.data?.pages ?? []).flatMap((p) => p.logs).map((e, n) => ({ ...e, n }));
	const first = logs.data?.pages[0];
	const off = logs.error instanceof ApiError && logs.error.status === 409 && !needsVersion(logs.error);
	return (
		<Section
			title="Roblox logs"
			description={ROBLOX_LOGS_DESCRIPTION}
			actions={
				off ? null : (
					<form onSubmit={onSearch} className="flex items-center gap-2" role="search">
						<Input aria-label="Search Roblox logs" placeholder="search (Enter)" className="h-8 w-48" value={searchText} maxLength={200} onChange={(e) => setSearchText(e.target.value)} />
						<Button type="button" variant="outline" size="sm" onClick={() => setOrder((o) => (o === "desc" ? "asc" : "desc"))} title="Change the order Roblox sends them in">
							{order === "desc" ? "Newest first" : "Oldest first"}
						</Button>
					</form>
				)
			}
		>
			{logs.isPending ? (
				<LoadingBlock rows={3} />
			) : off ? (
				<EmptyState>{ROBLOX_LOGS_OFF_TEXT}</EmptyState>
			) : needsVersion(logs.error) ? (
				<form onSubmit={onVersion} className="space-y-2 text-sm">
					<p className="text-muted-foreground">
						{versionOnly(logs.error)
							? "Roblox files a server's logs under its place version, and this server's kernel doesn't report it. Which place version did it run?"
							: "The fleet no longer knows this server's place, so Roblox's logs can't be asked for."}
					</p>
					<div className={versionOnly(logs.error) ? "flex items-center gap-2" : "hidden"}>
						<Input aria-label="Place version" inputMode="numeric" className="h-8 w-32" value={versionText} onChange={(e) => setVersionText(e.target.value.replace(/\D/g, ""))} />
						<Button type="submit" size="sm" disabled={!versionText}>
							Show logs
						</Button>
					</div>
				</form>
			) : logs.isError ? (
				<ErrorState error={logs.error} title="Could not load Roblox's logs" />
			) : (
				<div className="space-y-2">
					<DataTable
						id="roblox-logs"
						label="Roblox logs"
						columns={COLUMNS}
						data={rows}
						rowId={(e) => String(e.n)}
						pageSize={100}
						density="compact"
						maxHeight="32rem"
						empty={<EmptyState>{search ? "No log matches this search." : "Roblox has no errors or warnings for this server."}</EmptyState>}
						{...MEMORY_ONLY}
					/>
					<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
						<span>
							{fmtInt(rows.length)} loaded{first ? `, place version ${first.placeVersion}` : ""}
							{search ? `, matching "${search}"` : ""}
						</span>
						{logs.hasNextPage ? (
							<Button variant="outline" size="sm" onClick={() => logs.fetchNextPage()} disabled={logs.isFetchingNextPage}>
								{logs.isFetchingNextPage ? "Loading..." : "Load more"}
							</Button>
						) : null}
					</div>
				</div>
			)}
		</Section>
	);
}
