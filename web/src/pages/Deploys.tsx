/**
 * The deploy history: every release of every branch (the fleet's deploys table, GET /v1/fleet/deploys), newest first, a
 * page at a time, with who started it and how it went (servers ok, failed, stuck; the most common deploy error). A row
 * opens its deploy page (/deploys/<seq>).
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { cn } from "cn";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { DEPLOY_OUTCOMES_ORDER, deployTitle, OUTCOME_STYLE, startedByText, type DeployRecord } from "@/lib/deploys";
import { fmtAgo, fmtInt, fmtTime } from "@/lib/format";
import { useParam } from "@/lib/hooks";

/** A colored dot plus its word (color never carries the meaning alone). */
export function OutcomeBadge({ outcome }: { outcome: DeployRecord["outcome"] }) {
	const style = OUTCOME_STYLE[outcome];
	return (
		<span className="inline-flex items-center gap-1.5 text-xs" title={style.help}>
			<span className={cn("size-2 rounded-full", style.tone)} aria-hidden />
			{style.label}
		</span>
	);
}

export const DEPLOY_COLUMNS: DataColumn<DeployRecord>[] = [
	{ id: "seq", header: "Deploy", type: "number", accessor: (d) => d.seq, cell: (d) => <span className="font-medium">#{d.seq}</span>, hideable: false },
	{ id: "at", header: "Started (UTC)", type: "date", accessor: (d) => d.at, cell: (d) => <span title={fmtAgo(d.at)}>{fmtTime(d.at)}</span>, className: "font-mono text-xs tabular-nums" },
	{ id: "branch", header: "Branch", type: "enum", accessor: (d) => d.branch },
	{ id: "kind", header: "Kind", type: "enum", accessor: (d) => d.kind, className: "text-xs" },
	{ id: "artifact", header: "Artifact", type: "text", accessor: (d) => d.artifact, className: "font-mono text-xs" },
	{ id: "by", header: "Started by", type: "enum", accessor: (d) => startedByText(d), className: "text-xs" },
	{
		id: "outcome",
		header: "Outcome",
		type: "enum",
		order: DEPLOY_OUTCOMES_ORDER,
		options: DEPLOY_OUTCOMES_ORDER,
		accessor: (d) => d.outcome,
		cell: (d) => <OutcomeBadge outcome={d.outcome} />,
		format: (_v, d) => OUTCOME_STYLE[d.outcome].label,
	},
	{ id: "ok", header: "OK", type: "number", accessor: (d) => d.ok, cell: (d) => fmtInt(d.ok), className: "tabular-nums", title: "Servers that swapped to it or booted on it" },
	{
		id: "failed",
		header: "Failed",
		type: "number",
		accessor: (d) => d.failed,
		cell: (d) => <span className={d.failed ? "text-[var(--status-critical)]" : "text-muted-foreground"}>{fmtInt(d.failed)}</span>,
		className: "tabular-nums",
		title: "Servers that failed or rolled back",
	},
	{ id: "stuck", header: "Stuck", type: "number", accessor: (d) => d.stuck, cell: (d) => fmtInt(d.stuck), className: "tabular-nums", title: "Servers with no report 3 minutes after the start" },
	{ id: "error", header: "Top error", type: "text", accessor: (d) => d.errors[0]?.error ?? null, className: "max-w-80 truncate text-xs" },
	{ id: "message", header: "Note", type: "text", accessor: (d) => d.message, defaultHidden: true, className: "max-w-80 truncate text-xs" },
	{ id: "from", header: "From build", type: "text", accessor: (d) => d.from, defaultHidden: true, className: "font-mono text-xs" },
	{ id: "reported", header: "Reported", type: "number", accessor: (d) => d.reported, defaultHidden: true },
];

export default function Deploys() {
	const navigate = useNavigate();
	const [branch, setBranch] = useParam("branch");
	const [text, setText] = useState(branch);
	useEffect(() => setText(branch), [branch]);
	const pages = useInfiniteQuery({
		queryKey: ["fleet", "deploys", branch],
		queryFn: ({ pageParam, signal }) => api.fleetDeploys({ ...(branch ? { branch } : {}), ...(pageParam !== undefined ? { before: pageParam } : {}), limit: 50 }, signal),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (last) => last.next ?? undefined,
		refetchInterval: 60_000,
	});
	const deploys = pages.data?.pages.flatMap((p) => p.deploys) ?? [];
	return (
		<>
			<PageHeader
				title="Deploys"
				description="Every release of the game, newest first: who started it, how many servers took it, failed or got stuck, and its deploy errors."
				actions={
					<Input
						aria-label="Branch"
						placeholder="any branch"
						className="h-8 w-36"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onBlur={() => setBranch(text.trim())}
						onKeyDown={(e) => e.key === "Enter" && setBranch(text.trim())}
					/>
				}
			/>
			<Section description="Open a row for its servers' reports, its alerts, and errors and performance before vs after it.">
				{pages.isPending ? (
					<LoadingBlock rows={6} />
				) : pages.isError ? (
					pages.error instanceof ApiError && pages.error.notFound ? (
						<EmptyState>This backend has no deploy history (the fleet part is off, or it is older).</EmptyState>
					) : (
						<ErrorState error={pages.error} title="Could not load the deploy history" />
					)
				) : (
					<div className="space-y-3">
						<DataTable
							id="deploys"
							label="Deploys"
							columns={DEPLOY_COLUMNS}
							data={deploys}
							rowId={(d) => String(d.seq)}
							maxHeight="40rem"
							onRowClick={(d) => void navigate(`/deploys/${d.seq}`)}
							rowActionLabel={(d) => `Open ${deployTitle(d)}`}
							empty={<EmptyState>No deploy yet{branch ? ` on ${branch}` : ""}. A release shows up when the CLI posts it or its first server reports it.</EmptyState>}
						/>
						{pages.hasNextPage ? (
							<div className="flex justify-center">
								<Button variant="outline" size="sm" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
									{pages.isFetchingNextPage ? "Loading..." : "Load older deploys"}
								</Button>
							</div>
						) : deploys.length ? (
							<p className="text-center text-xs text-muted-foreground">That is every deploy the history keeps.</p>
						) : null}
					</div>
				)}
			</Section>
		</>
	);
}
