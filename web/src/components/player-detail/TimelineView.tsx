/**
 * The player detail's Timeline view: the node graph (all sessions, or one), then every session with its events (oldest
 * events first, newest session on top). "View graph" on a session shows that session's moves in the graph above.
 */
import { Workflow } from "lucide-react";
import { useRef } from "react";
import { EventTable } from "@/components/EventTable";
import { JoinData, joinDataOf } from "@/components/player-detail/JoinData";
import { FacetToggle, isFacet, LazyGraph, MomentsToggle, PathStrip, SparseNote } from "@/components/LazyGraph";
import { MermaidButton } from "@/components/MermaidButton";
import { EmptyState, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtInt, fmtMinutes, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { TimelineEvent, TimelineResult } from "@/lib/types";

const ALL_SESSIONS = "__all";

function Sessions({ data, onGraph }: { data: TimelineResult; onGraph(sid: string): void }) {
	const bySession = new Map<string, TimelineEvent[]>();
	for (const e of data.events) bySession.set(e.sid, [...(bySession.get(e.sid) ?? []), e]);
	return (
		<div className="space-y-3">
			{data.truncated ? <p className="text-xs text-muted-foreground">Showing the oldest {fmtInt(data.events.length)} events; narrow the date range to see later ones.</p> : null}
			{[...data.sessions].reverse().map((s) => (
				<section key={s.sid} aria-label={`Session ${fmtTime(s.start)}`} className="space-y-2 rounded-lg border p-3">
					<div className="flex flex-wrap items-start justify-between gap-2">
						<div className="min-w-0">
							<h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
								Session {fmtTime(s.start)}
								{s.firstSession ? <Badge>first session</Badge> : null}
							</h3>
							<p className="text-xs break-words text-muted-foreground">
								{fmtMinutes(s.minutes)} · {plural(s.events, "event")} · {s.dev ?? "unknown device"} · artifact {s.art} · sid {shortId(s.sid)}
							</p>
						</div>
						<Button variant="outline" size="sm" onClick={() => onGraph(s.sid)}>
							<Workflow />
							View graph
						</Button>
					</div>
					{(bySession.get(s.sid) ?? [])
						.filter((e) => e.kind === "session" && e.name === "join" && joinDataOf(e.props))
						.map((e) => (
							<JoinData key={`${e.t}|${e.name}`} jd={joinDataOf(e.props)} label={`Join data (${fmtTime(e.time)})`} />
						))}
					{bySession.get(s.sid)?.length ? (
						// One saved view for every session's table, kept off the URL (they would overwrite each other there).
						<EventTable id="player-events" label={`Events of session ${shortId(s.sid)}`} events={bySession.get(s.sid) ?? []} urlSync={false} maxHeight="24rem" />
					) : (
						<EmptyState>No events of this session in the list.</EmptyState>
					)}
				</section>
			))}
		</div>
	);
}

export function TimelineView({ pid }: { pid: string }) {
	const [facetParam, setFacet] = useParam("facet", "all");
	const [sid, setSid] = useParam("sid");
	const [momentsParam, setMoments] = useParam("moments");
	const facet = isFacet(facetParam) ? facetParam : "all";
	const moments = momentsParam === "1";
	const graphRef = useRef<HTMLDivElement>(null);
	const timeline = useAnalytics("timeline", { pid, limit: 2000 });
	const sessions = timeline.data?.sessions ?? [];
	const session = sessions.find((s) => s.sid === sid);
	const graph = useAnalytics("player-graph", { pid, facet, ...(sid ? { sid } : {}), ...(moments ? { moments: true } : {}) });
	const showSession = (next: string) => {
		setSid(next);
		graphRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
	};
	return (
		<div className="space-y-4">
			<div ref={graphRef} className="scroll-mt-28 space-y-2">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="min-w-0">
						<h3 className="text-sm font-medium">{session ? `Session ${fmtTime(session.start)}` : "Node graph, all sessions"}</h3>
						<p className="text-xs text-muted-foreground">
							{session ? `${fmtMinutes(session.minutes)}, ${plural(session.events, "event")}: the moves in order, and the time in each state.` : "States are nodes, moves are edges."}
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Select value={sid || ALL_SESSIONS} onValueChange={(v) => setSid(v === ALL_SESSIONS ? "" : v)}>
							<SelectTrigger size="sm" className="w-52" aria-label="Session">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_SESSIONS}>All sessions</SelectItem>
								{sid && !session ? <SelectItem value={sid}>session {shortId(sid)}</SelectItem> : null}
								{[...sessions].reverse().map((s) => (
									<SelectItem key={s.sid} value={s.sid}>
										{fmtTime(s.start).slice(5, 16)} ({fmtMinutes(s.minutes)})
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<FacetToggle value={facet} onChange={setFacet} />
						<MomentsToggle value={moments} onChange={(on) => setMoments(on ? "1" : "")} />
						{graph.data ? <MermaidButton graph={graph.data} /> : null}
					</div>
				</div>
				<QueryState
					query={graph}
					isEmpty={(g) => g.nodes.length === 0}
					empty={facet === "all" ? "No states logged for this player here." : `None of this player's states has a ${facet} part (try all).`}
				>
					{(g) => (
						<>
							<SparseNote graph={g} pid={pid} />
							<LazyGraph graph={g} />
							<PathStrip graph={g} />
						</>
					)}
				</QueryState>
			</div>
			<QueryState query={timeline} isEmpty={(t) => t.sessions.length === 0} empty="This player has no events in this range: widen the date range.">
				{(t) => <Sessions data={t} onGraph={showSession} />}
			</QueryState>
		</div>
	);
}
