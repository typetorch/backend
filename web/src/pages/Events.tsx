import { useMemo } from "react";
import { Link, useLocation } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EventTable } from "@/components/EventTable";
import { PlayerHover } from "@/components/PlayerHover";
import { EmptyState, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtInt, fmtPct, shortId } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { EventRow, TopEventsResult } from "@/lib/types";

const ALL = "all";

type EventName = TopEventsResult["events"][number];

/** A link to a player's page that keeps the filters. */
function PlayerLink({ pid }: { pid: string }) {
	const { search } = useLocation();
	const params = new URLSearchParams();
	const current = new URLSearchParams(search);
	for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
	params.set("pid", pid);
	return (
		<PlayerHover pid={pid}>
			<Link to={{ pathname: "/players", search: `?${params.toString()}` }} className="font-mono text-xs underline-offset-2 hover:underline">
				{shortId(pid)}
			</Link>
		</PlayerHover>
	);
}

/** Columns after the standard event ones: who, where from, which build and server. */
const ROW_COLUMNS: DataColumn<EventRow>[] = [
	{ id: "pid", header: "Player", accessor: (e) => e.pid, cell: (e) => (e.pid ? <PlayerLink pid={e.pid} /> : <span className="text-xs text-muted-foreground">server row</span>) },
	{ id: "branch", header: "Branch", type: "enum", accessor: (e) => e.branch, className: "text-xs" },
	{ id: "dev", header: "Device", type: "enum", accessor: (e) => e.dev, className: "text-xs" },
	{ id: "art", header: "Artifact", type: "enum", accessor: (e) => e.art, className: "font-mono text-xs" },
	{ id: "job", header: "Job", accessor: (e) => e.job, cell: (e) => <span title={e.job}>{shortId(e.job, 6)}</span>, className: "font-mono text-xs" },
];

function RecentRows({ kind, name, pid, onClearPid }: { kind?: string; name?: string; pid?: string; onClearPid(): void }) {
	const q = useAnalytics("events", { ...(kind ? { kind } : {}), ...(name ? { name } : {}), ...(pid ? { pid } : {}), limit: 100 });
	const what = kind && name ? `${kind} / ${name} rows` : "rows";
	return (
		<Section
			title={pid ? <>Newest {what} of player <span className="font-mono text-sm">{shortId(pid)}</span></> : `Newest ${what}`}
			actions={
				pid ? (
					<Button variant="ghost" size="sm" onClick={onClearPid}>
						all players
					</Button>
				) : null
			}
			description="Up to 100, newest first. Fleet rows never show props (they can hold a private server's access code)."
		>
			<QueryState query={q} isEmpty={(d) => d.events.length === 0} empty="No rows of this event in this range.">
				{(data) => <EventTable id="events-rows" label="Newest event rows" events={data.events} dateToo extra={ROW_COLUMNS} />}
			</QueryState>
		</Section>
	);
}

/** The event-name table: the share bar is scaled to the busiest name shown. */
function nameColumns(max: number): DataColumn<EventName>[] {
	return [
		{ id: "kind", header: "Kind", type: "enum", accessor: (e) => e.kind, cell: (e) => <Badge variant="outline">{e.kind}</Badge> },
		{ id: "name", header: "Event", accessor: (e) => e.name },
		{ id: "count", header: "Count", accessor: (e) => e.count, cell: (e) => fmtInt(e.count) },
		{
			id: "share",
			header: "Share",
			title: "Of the busiest event shown",
			accessor: (e) => e.count / max,
			format: (v) => fmtPct(v as number),
			cell: (e) => <ShareBar share={e.count / max} className="w-24" />,
			filter: false,
			align: "left",
			minWidth: 120,
		},
		{ id: "players", header: "Players", title: "Distinct pids; server rows have none", accessor: (e) => e.players, cell: (e) => fmtInt(e.players) },
	];
}

export default function Events() {
	const top = useAnalytics("top-events", { limit: 500 });
	const [kindFilter, setKindFilter] = useParam("kind", ALL);
	const [picked, setPicked] = useParam("event");
	const [pid, setPid] = useParam("pid");
	const events = useMemo(() => top.data?.events ?? [], [top.data]);
	const kinds = [...new Set(events.map((e) => e.kind))].sort();
	const shown = useMemo(() => (kindFilter === ALL ? events : events.filter((e) => e.kind === kindFilter)), [events, kindFilter]);
	const max = Math.max(1, ...shown.map((e) => e.count));
	const columns = useMemo(() => nameColumns(max), [max]);
	const at = picked.indexOf("/");
	const pick = at > 0 ? { kind: picked.slice(0, at), name: picked.slice(at + 1) } : null;
	return (
		<>
			<PageHeader title="Events" description="The most logged event names per kind; pick one to see its newest rows." />
			<QueryState query={top} isEmpty={(d) => d.events.length === 0} empty="No events in this range.">
				{() => (
					<div className="flex flex-col gap-4 xl:flex-row xl:items-start">
						<Section
							className="xl:w-[480px] xl:shrink-0"
							title={`${fmtInt(events.length)} event names`}
							actions={
								<ToggleGroup type="single" variant="outline" size="sm" value={kindFilter} onValueChange={(v) => v && setKindFilter(v)} className="flex-wrap">
									<ToggleGroupItem value={ALL} className="px-2 text-xs">
										all
									</ToggleGroupItem>
									{kinds.map((k) => (
										<ToggleGroupItem key={k} value={k} className="px-2 text-xs">
											{k}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							}
						>
							<DataTable
								id="events-names"
								label="Event names"
								columns={columns}
								data={shown}
								rowId={(e) => `${e.kind}/${e.name}`}
								onRowClick={(e) => setPicked(`${e.kind}/${e.name}`)}
								isRowSelected={(e) => picked === `${e.kind}/${e.name}`}
								empty={<EmptyState>No events of this kind.</EmptyState>}
							/>
						</Section>
						<div className="min-w-0 flex-1">
							{pick || pid ? (
								<RecentRows {...(pick ?? {})} {...(pid ? { pid } : {})} onClearPid={() => setPid("")} />
							) : (
								<EmptyState>Pick an event on the left.</EmptyState>
							)}
						</div>
					</div>
				)}
			</QueryState>
		</>
	);
}
