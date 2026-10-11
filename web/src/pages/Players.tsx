import { ListPlus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { IdentityStatus } from "@/components/Identity";
import { PlayerDetail } from "@/components/player-detail/PlayerDetail";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { FunnelProgressBar } from "@/components/FunnelProgressBar";
import { FunnelStepList, FunnelStepsHeaderTip, HoverPopover, type FunnelStepName } from "@/components/FunnelSteps";
import { ToggleChip } from "@/components/ToggleChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtMinutes, plural, shortId } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { FunnelProgress, PlayerSummary } from "@/lib/types";

const PID = /^[A-Za-z0-9_-]{1,64}$/;

const UID = /^\d{1,16}$/;

/** A pid, or a UserId mapped to its most recently seen pid (undefined when the server doesn't know it). */
async function pidFor(text: string): Promise<string | undefined> {
	if (UID.test(text)) {
		const known = await api.identity({ uid: text }).catch(() => []);
		if (known.length) return known[0].pid;
	}
	return PID.test(text) && text.length >= 8 ? text : undefined;
}

function PlayerList({ selected, onPick, initial }: { selected: string; onPick(pid: string): void; initial: string }) {
	const [text, setText] = useState(initial);
	const [search, setSearch] = useState(initial);
	const [missing, setMissing] = useState("");
	useEffect(() => {
		setText(initial);
		setSearch(initial);
	}, [initial]);
	useEffect(() => {
		const timer = setTimeout(() => setSearch(text.trim()), 400);
		return () => clearTimeout(timer);
	}, [text]);
	const [topSpenders, setTopSpenders] = useState(false);
	const valid = search === "" || PID.test(search);
	// The server returns 100 players: top spenders asks it for the 100 who spent most, not the 100 most recent re-sorted.
	const q = useAnalytics("players", { limit: 100, ...(search ? { search } : {}), ...(topSpenders ? { sort: "robux" } : {}) }, { enabled: valid });
	const [funnels, setFunnels] = useFunnelColumns();
	const columns = useFunnelProgressColumns(q.data?.players, funnels);
	return (
		<Section
			title="Players"
			description={topSpenders ? "Most Robux spent first. Search by part of a pid, or by a UserId." : "Most recent first. Search by part of a pid, or by a UserId."}
			contentClassName="space-y-3"
		>
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
					<Input aria-label="Search pid or UserId" className="h-8 pl-8" placeholder="pid, part of one, or a UserId" value={text} onChange={(e) => setText(e.target.value)} />
				</div>
				{(PID.test(text.trim()) && text.trim().length >= 8) || UID.test(text.trim()) ? (
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							const pid = await pidFor(text.trim());
							if (pid) {
								setMissing("");
								onPick(pid);
							} else setMissing(text.trim());
						}}
					>
						Open
					</Button>
				) : null}
				<ToggleChip pressed={topSpenders} className="h-8" onClick={() => setTopSpenders((v) => !v)}>
					Top spenders
				</ToggleChip>
			</div>
			{!valid ? <p className="text-xs text-muted-foreground">A pid has only letters, digits, _ and -.</p> : null}
			{missing ? <p className="text-xs text-muted-foreground">No player found for UserId {missing}.</p> : null}
			<QueryState query={q} isEmpty={(d) => d.players.length === 0} empty={search ? "No pid matches." : "No players in this range."}>
				{(data) => (
					<DataTable
						id="players-list"
						label="Players"
						columns={columns}
						columnsMenu={<AddFunnelMenu chosen={funnels} onChange={setFunnels} />}
						data={data.players}
						rowId={(p) => p.pid}
						density="compact"
						onRowClick={(p) => onPick(p.pid)}
						isRowSelected={(p) => p.pid === selected}
						maxHeight="22rem"
					/>
				)}
			</QueryState>
		</Section>
	);
}

/** The player list: pid with its UserId under it, then when, how often, how long and how much Robux. Sorts by the numbers, not the text. */
const PLAYER_COLUMNS: DataColumn<PlayerSummary>[] = [
	{
		id: "pid",
		header: "Player",
		accessor: (p) => p.pid,
		searchText: (p) => (p.uid !== undefined ? `UserId ${p.uid}` : ""),
		cell: (p) => (
			<>
				<div className="flex items-center gap-2">
					<span className="font-mono" title={p.pid}>
						{shortId(p.pid, 10)}
					</span>
					{p.newInRange ? <Badge variant="secondary">new</Badge> : null}
				</div>
				{p.uid !== undefined ? <div className="text-muted-foreground tabular-nums">UserId {p.uid}</div> : null}
			</>
		),
	},
	{ id: "lastSeen", header: "Seen", type: "date", accessor: (p) => p.lastSeen, cell: (p) => fmtAgo(p.lastSeen), format: (_v, p) => fmtAgo(p.lastSeen) },
	{ id: "sessions", header: "Sessions", accessor: (p) => p.sessions, cell: (p) => fmtInt(p.sessions) },
	{ id: "playtime", header: "Playtime", accessor: (p) => p.playtimeMinutes, cell: (p) => fmtMinutes(p.playtimeMinutes), format: (_v, p) => fmtMinutes(p.playtimeMinutes) },
	{ id: "robux", header: "Robux spent", type: "number", align: "right", accessor: (p) => p.robux ?? 0, cell: (p) => fmtInt(p.robux ?? 0) },
	{ id: "events", header: "Events", accessor: (p) => p.events, defaultHidden: true },
	{ id: "firstSeen", header: "First seen", type: "date", accessor: (p) => p.firstSeen, defaultHidden: true },
	{ id: "new", header: "New", type: "boolean", accessor: (p) => p.newInRange, defaultHidden: true },
	{ id: "uid", header: "UserId", type: "text", accessor: (p) => (p.uid === undefined ? null : String(p.uid)), defaultHidden: true },
];

/** The funnel columns the user added (Columns > Add funnel), in the URL as `funnels=a,b` so a link keeps them. */
function useFunnelColumns(): [string[], (next: string[]) => void] {
	const [value, setValue] = useParam("funnels");
	const list = useMemo(() => [...new Set(value.split(",").filter(Boolean))], [value]);
	return [list, (next) => setValue(next.join(","))];
}

/** The player columns plus one progress column per chosen funnel, filled from one `funnel-progress` answer for the listed players. */
function useFunnelProgressColumns(players: readonly PlayerSummary[] | undefined, funnels: string[]): DataColumn<PlayerSummary>[] {
	const pids = useMemo(() => (players ?? []).map((p) => p.pid), [players]);
	const progress = useAnalytics("funnel-progress", { ...(funnels.length === 1 ? { funnel: funnels[0] } : {}), pids }, { enabled: funnels.length > 0 && pids.length > 0 });
	const loading = progress.isPending;
	const failed = progress.isError;
	const byKey = useMemo(() => new Map((progress.data?.progress ?? []).map((p) => [`${p.pid}\n${p.funnel}`, p])), [progress.data]);
	// Each funnel's step names come with the same answer (no query per cell).
	const stepsOf = useMemo(() => new Map((progress.data?.funnels ?? []).map((f) => [f.name, f.steps])), [progress.data]);
	return useMemo(() => {
		if (!funnels.length) return PLAYER_COLUMNS;
		return [...PLAYER_COLUMNS, ...funnels.map((name) => funnelColumn(name, (pid) => byKey.get(`${pid}\n${name}`), loading, failed, stepsOf.get(name)))];
	}, [funnels, byKey, stepsOf, loading, failed]);
}

function funnelColumn(name: string, find: (pid: string) => FunnelProgress | undefined, loading: boolean, failed: boolean, steps: FunnelStepName[] | undefined): DataColumn<PlayerSummary> {
	const percent = (p: PlayerSummary) => {
		const f = find(p.pid);
		return f ? Math.round(f.share * 1000) / 10 : null;
	};
	return {
		id: `funnel:${name}`,
		header: name,
		hint: "funnel",
		title: `Progress in the ${name} funnel: the furthest step each player logged, as a share of the funnel's steps in this range${steps?.length ? `. Steps: ${steps.map((s) => `${s.step}. ${s.label ?? "(no name)"}`).join(", ")}` : ""}`,
		headerExtra: loading || failed ? undefined : <FunnelStepsHeaderTip funnel={name} steps={steps} />,
		type: "number",
		accessor: percent,
		format: (v) => (v === null || v === undefined ? "not started" : `${String(v)}%`),
		exportValue: percent,
		cell: (p) =>
			loading ? (
				<Skeleton className="h-5 w-full min-w-24" />
			) : failed ? (
				<span className="text-muted-foreground">–</span>
			) : (
				<HoverPopover className="block w-full" trigger={<FunnelProgressBar progress={find(p.pid)} />}>
					<FunnelStepList funnel={name} steps={steps} progress={find(p.pid) ?? null} />
				</HoverPopover>
			),
		hideable: false,
		searchable: false,
		minWidth: 140,
	};
}

/** Columns > Add funnel: a checklist of the funnels in the range; a tick adds a progress column, another tick removes it. */
function AddFunnelMenu({ chosen, onChange }: { chosen: string[]; onChange(next: string[]): void }) {
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<ListPlus className="size-4 text-muted-foreground" />
				Add funnel
				{chosen.length ? <span className="ml-auto text-xs text-muted-foreground tabular-nums">{chosen.length}</span> : null}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
				<FunnelChoices chosen={chosen} onChange={onChange} />
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

function FunnelChoices({ chosen, onChange }: { chosen: string[]; onChange(next: string[]): void }) {
	const list = useAnalytics("funnel", {});
	const found = list.data && list.data.funnel === null ? list.data.funnels : [];
	// A chosen funnel with no rows in this range stays in the list, so it can still be removed.
	const names = [...found.map((f) => f.name), ...chosen.filter((c) => !found.some((f) => f.name === c))];
	if (list.isPending) return <DropdownMenuItem disabled>Loading funnels</DropdownMenuItem>;
	if (list.isError) return <DropdownMenuItem disabled>Couldn't load the funnels</DropdownMenuItem>;
	if (!names.length) return <DropdownMenuItem disabled>No funnels in this range</DropdownMenuItem>;
	return (
		<>
			{names.map((name) => {
				const players = found.find((f) => f.name === name)?.players;
				return (
					<DropdownMenuCheckboxItem
						key={name}
						checked={chosen.includes(name)}
						onCheckedChange={(on) => onChange(on === true ? [...chosen, name] : chosen.filter((c) => c !== name))}
						onSelect={(e) => e.preventDefault()}
					>
						<span className="truncate">{name}</span>
						{players !== undefined ? <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">{plural(players, "player")}</span> : null}
					</DropdownMenuCheckboxItem>
				);
			})}
			{chosen.length ? (
				<DropdownMenuItem
					onSelect={(e) => {
						e.preventDefault();
						onChange([]);
					}}
				>
					Remove all funnel columns
				</DropdownMenuItem>
			) : null}
		</>
	);
}

export default function Players() {
	const [params, setParams] = useSearchParams();
	const pid = params.get("pid") ?? "";
	const find = params.get("find") ?? "";
	// Another player: their own sessions, so the session pick goes.
	const setPid = (next: string) =>
		setParams((current) => {
			const copy = new URLSearchParams(current);
			copy.set("pid", next);
			copy.delete("sid");
			copy.delete("find");
			return copy;
		});
	// A pick in the list: the detail container is under the list, so bring it into view (phones especially).
	const detailRef = useRef<HTMLDivElement>(null);
	const pick = (next: string) => {
		setPid(next);
		setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
	};
	// The top bar's "Find player": open the player when the text is a pid or a known UserId, else search for it.
	useEffect(() => {
		if (!find) return;
		let live = true;
		void pidFor(find).then((found) => {
			if (live && found) setPid(found);
		});
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [find]);
	return (
		<>
			<PageHeader title="Players" description="Find a player by pid (random ids, never a UserId) or UserId, then read their spending, playtime, sessions and timeline." />
			<div className="space-y-4">
				<div>
					<PlayerList selected={pid} onPick={pick} initial={find} />
					<div className="px-1 pt-2">
						<IdentityStatus />
					</div>
				</div>
				<div ref={detailRef} className="scroll-mt-36">
					{pid && PID.test(pid) ? <PlayerDetail pid={pid} /> : <EmptyState>Pick a player in the list.</EmptyState>}
				</div>
			</div>
		</>
	);
}
