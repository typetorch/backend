/**
 * Error logs from game servers and clients: kinds with counts, a trend line, players affected, and a sample stack. A row
 * opens the kind in a side sheet (`?fp=` in the URL, so the link is shareable): where it happens, its stack, and the
 * players who hit it, each linking to their page.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "cn";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, JsonBlock, KeyValue, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { UserIdLink } from "@/components/Identity";
import { Sparkline } from "@/components/Sparkline";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api, type ErrorParams } from "@/lib/api";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtTime, plural, shortId } from "@/lib/format";
import { useParam } from "@/lib/hooks";
import type { ErrorDetail, ErrorKind, ErrorList, ErrorPlayer, ErrorPlayers } from "@/lib/types";

const WINDOWS = [
	{ value: "1h", label: "Last hour" },
	{ value: "6h", label: "Last 6 hours" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "30d", label: "Last 30 days" },
];
const ANY = "__any";

/** "Last 10 buckets of 5 min" for the tooltip under a trend line. */
export function bucketLabel(bucketSeconds: number): string {
	if (bucketSeconds % 86_400 === 0) return `${bucketSeconds / 86_400} d`;
	if (bucketSeconds % 3600 === 0) return `${bucketSeconds / 3600} h`;
	return `${bucketSeconds / 60} min`;
}

/** Refetches the error lists whenever the backend says errors came in (debounced), and reports whether the stream is up. */
function useErrorStream(): "connecting" | "live" | "retrying" {
	const client = useQueryClient();
	const [state, setState] = useState<"connecting" | "live" | "retrying">("connecting");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		const source = new EventSource(api.liveUrl(["error"]));
		source.addEventListener("hello", () => setState("live"));
		source.addEventListener("error", (event) => {
			// "error" is also EventSource's own failure event; only message events carry data.
			if (!(event as MessageEvent).data) return;
			clearTimeout(timer.current);
			timer.current = setTimeout(() => void client.invalidateQueries({ queryKey: ["errors"] }), 1500);
		});
		source.onopen = () => setState("live");
		source.onerror = () => setState(source.readyState === EventSource.CLOSED ? "retrying" : "connecting");
		return () => {
			clearTimeout(timer.current);
			source.close();
		};
	}, [client]);
	return state;
}

function Status({ tone, children }: { tone: string; children: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs">
			<span className={cn("size-2 rounded-full", tone)} aria-hidden />
			{children}
		</span>
	);
}

/** A text filter that commits on Enter or blur. */
function TextFilter({ value, onCommit, placeholder, label, className }: { value: string; onCommit(v: string): void; placeholder: string; label: string; className?: string }) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const commit = () => text.trim() !== value && onCommit(text.trim());
	return (
		<Input aria-label={label} placeholder={placeholder} className={cn("h-8 w-36", className)} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
	);
}

/**
 * The artifact filter's choices: the builds the backend saw errors from in the window (most recent first), plus the
 * current choice when the window no longer has it (a shared link), so the select never shows an empty value.
 */
export function artifactOptions(builds: { build: string }[] | undefined, current: string): string[] {
	const out = (builds ?? []).map((b) => b.build);
	if (current && !out.includes(current)) out.unshift(current);
	return out;
}

/** The error kinds' columns; the trend's label names the bucket size of the window being shown. */
function kindColumns(bucketSeconds: number): DataColumn<ErrorKind>[] {
	return [
		{
			id: "error",
			header: "Error",
			accessor: (k) => k.template,
			searchText: (k) => k.topFrame ?? "",
			cell: (k) => (
				<>
					<div className="break-words font-mono text-xs">{k.template}</div>
					{k.topFrame ? <div className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">{k.topFrame}</div> : null}
				</>
			),
			className: "max-w-[28rem] whitespace-normal",
		},
		{
			id: "realm",
			header: "Where",
			type: "enum",
			options: ["server", "client"],
			accessor: (k) => k.realm,
			cell: (k) => <Badge variant={k.realm === "server" ? "secondary" : "outline"}>{k.realm}</Badge>,
		},
		{ id: "count", header: "Count", accessor: (k) => k.count, cell: (k) => fmtInt(k.count) },
		{ id: "players", header: "Players", accessor: (k) => k.players, cell: (k) => fmtInt(k.players) },
		{
			id: "trend",
			header: "Trend",
			title: "Sorts by the errors in the newest step",
			accessor: (k) => k.spark.at(-1) ?? 0,
			cell: (k) => <Sparkline values={k.spark} label={`errors per ${bucketLabel(bucketSeconds)}`} />,
			exportValue: (k) => k.spark.join(" "),
			filter: false,
			searchable: false,
		},
		{ id: "firstAt", header: "First seen", type: "date", accessor: (k) => k.firstAt, cell: (k) => <span title={fmtTime(k.firstAt)}>{fmtAgo(k.firstAt)}</span>, format: (_v, k) => fmtAgo(k.firstAt), className: "text-xs" },
		{ id: "lastAt", header: "Last seen", type: "date", accessor: (k) => k.lastAt, cell: (k) => <span title={fmtTime(k.lastAt)}>{fmtAgo(k.lastAt)}</span>, format: (_v, k) => fmtAgo(k.lastAt), className: "text-xs" },
		{ id: "total", header: "All time", title: "Every report of this kind, not only this window", accessor: (k) => k.total, cell: (k) => fmtInt(k.total), defaultHidden: true },
		{ id: "fp", header: "Fingerprint", accessor: (k) => k.fp, defaultHidden: true, className: "font-mono text-xs" },
	];
}

function Kinds({ data, selected, onSelect }: { data: ErrorList; selected: string; onSelect(fp: string): void }) {
	const columns = useMemo(() => kindColumns(data.window.bucketSeconds), [data.window.bucketSeconds]);
	if (!data.kinds.length) return <EmptyState>No errors in this window. (Game servers send them as they happen; a new kind shows up within a minute.)</EmptyState>;
	return (
		<DataTable
			id="errors-kinds"
			label="Error kinds"
			columns={columns}
			data={data.kinds}
			rowId={(k) => k.fp}
			// The server already sends the most frequent first; clearing the sort brings that order back.
			defaultSort={[{ id: "count", desc: true }]}
			onRowClick={(k) => onSelect(selected === k.fp ? "" : k.fp)}
			rowActionLabel={(k) => `Open error: ${k.template.slice(0, 120)}`}
			isRowSelected={(k) => selected === k.fp}
		/>
	);
}

function Breakdown({ title, rows }: { title: string; rows: { label: string; n: number }[] }) {
	if (!rows.length) return null;
	const total = rows.reduce((s, r) => s + r.n, 0) || 1;
	return (
		<div className="space-y-1">
			<div className="text-xs font-medium text-muted-foreground">{title}</div>
			<ul className="space-y-0.5 text-sm">
				{rows.map((r) => (
					<li key={r.label} className="flex items-baseline justify-between gap-3">
						<span className="truncate font-mono text-xs" title={r.label}>
							{r.label}
						</span>
						<span className="tabular-nums text-muted-foreground">
							{fmtInt(r.n)} <span className="text-xs">({Math.round((r.n / total) * 100)}%)</span>
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function SeriesBars({ detail }: { detail: ErrorDetail }) {
	const config: ChartConfig = { n: { label: "Errors", color: "var(--status-critical)" } };
	const daily = detail.window.bucketSeconds >= 86_400;
	const data = detail.series.map((p) => ({ t: p.t, n: p.n, label: daily ? p.t.slice(5, 10) : p.t.slice(5, 16).replace("T", " ") }));
	return (
		<ChartContainer config={config} className="aspect-auto h-40 w-full">
			<BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} barCategoryGap={1}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={32} />
				<YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
				<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(l) => String(l)} />} />
				<Bar dataKey="n" fill="var(--color-n)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
			</BarChart>
		</ChartContainer>
	);
}

/** A row of the players list: a player, or the occurrences on one side that named nobody. */
export type PlayerRow = ({ kind: "player" } & ErrorPlayer) | { kind: "none"; realm: string; count: number; firstAt: string; lastAt: string };

export function playerRows(data: ErrorPlayers): PlayerRow[] {
	return [...data.players.map((p): PlayerRow => ({ kind: "player", ...p })), ...data.withoutPlayer.map((w): PlayerRow => ({ kind: "none", ...w }))];
}

/** "Display (@name)", "@name", or the short pid when the server knows no name. */
export function playerLabel(p: ErrorPlayer): string {
	if (!p.name) return shortId(p.pid, 10);
	return p.displayName && p.displayName !== p.name ? `${p.displayName} (@${p.name})` : `@${p.name}`;
}

/** The Players page for one pid, keeping the explorer's shared filters that are in the URL. */
function PlayerPageLink({ row }: { row: ErrorPlayer }) {
	const { search } = useLocation();
	const current = new URLSearchParams(search);
	const params = new URLSearchParams();
	for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
	params.set("pid", row.pid);
	return (
		<Link to={{ pathname: "/players", search: `?${params.toString()}` }} className="font-medium underline-offset-2 hover:underline" title={`Open player ${row.pid}`}>
			{playerLabel(row)}
		</Link>
	);
}

const PLAYER_COLUMNS: DataColumn<PlayerRow>[] = [
	{
		id: "player",
		header: "Player",
		accessor: (r) => (r.kind === "player" ? (r.name ?? r.pid) : r.realm),
		searchText: (r) => (r.kind === "player" ? `${r.pid} ${r.displayName ?? ""} ${r.uid ?? ""}` : ""),
		cell: (r) =>
			r.kind === "player" ? (
				<div className="min-w-0">
					<PlayerPageLink row={r} />
					{r.name ? <div className="truncate font-mono text-[11px] text-muted-foreground">{shortId(r.pid, 10)}</div> : null}
				</div>
			) : (
				<div>
					<Badge variant="secondary">{r.realm}</Badge>
					<div className="mt-0.5 text-[11px] text-muted-foreground">{r.realm === "server" ? "no player named" : "no analytics id yet"}</div>
				</div>
			),
	},
	{
		id: "uid",
		header: "UserId",
		accessor: (r) => (r.kind === "player" ? (r.uid ?? null) : null),
		cell: (r) => {
			if (r.kind !== "player") return null;
			if (r.uid === undefined) return <span className="text-xs text-muted-foreground">not linked</span>;
			return <UserIdLink uid={r.uid} className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline" />;
		},
		exportValue: (r) => (r.kind === "player" && r.uid !== undefined ? String(r.uid) : ""),
	},
	{ id: "count", header: "Times", title: "Occurrences in the reports that named the player (a report is one minute of one server)", accessor: (r) => r.count, cell: (r) => fmtInt(r.count) },
	{ id: "days", header: "Days", title: "UTC days they hit it in the window", accessor: (r) => (r.kind === "player" ? r.days : null), cell: (r) => (r.kind === "player" ? fmtInt(r.days) : null), defaultHidden: true },
	{ id: "firstAt", header: "First seen", type: "date", accessor: (r) => r.firstAt, cell: (r) => <span title={fmtTime(r.firstAt)}>{fmtAgo(r.firstAt)}</span>, format: (_v, r) => fmtAgo(r.firstAt), className: "text-xs" },
	{ id: "lastAt", header: "Last seen", type: "date", accessor: (r) => r.lastAt, cell: (r) => <span title={fmtTime(r.lastAt)}>{fmtAgo(r.lastAt)}</span>, format: (_v, r) => fmtAgo(r.lastAt), className: "text-xs" },
	{ id: "side", header: "Side", accessor: (r) => (r.kind === "player" ? r.realms.join(", ") : r.realm), className: "text-xs", defaultHidden: true },
];

/** The players who hit one kind in the window, under the page's filters: most occurrences first, at most 200. */
function KindPlayers({ fp, params }: { fp: string; params: ErrorParams }) {
	const query = useQuery({ queryKey: ["errors", "players", fp, params], queryFn: ({ signal }) => api.errorPlayers(fp, params, signal), refetchInterval: 30_000 });
	return (
		<QueryState query={query} loadingRows={3}>
			{(d) => {
				const rows = playerRows(d);
				if (!rows.length) return <EmptyState>No players hit it in this window.</EmptyState>;
				return (
					<div className="space-y-2">
						<DataTable id="errors-players" label="Players who hit this error" columns={PLAYER_COLUMNS} data={rows} rowId={(r) => (r.kind === "player" ? `p:${r.pid}` : `none:${r.realm}`)} defaultSort={[{ id: "count", desc: true }]} />
						<p className="text-xs text-muted-foreground">
							{d.more ? `The ${fmtInt(d.players.length)} who hit it most, of ${fmtInt(d.total)} players. ` : ""}
							Times counts the occurrences in each minute's report that named the player, so players who hit it in the same minute on one server share that report.
						</p>
					</div>
				);
			}}
		</QueryState>
	);
}

function KindDetail({ fp, params }: { fp: string; params: ErrorParams }) {
	const query = useQuery({ queryKey: ["errors", "kind", fp, params], queryFn: ({ signal }) => api.errorKind(fp, params, signal), refetchInterval: 30_000 });
	return (
		<QueryState query={query} loadingRows={4}>
			{(d) => (
				<div className="space-y-4">
					<div className="break-words font-mono text-sm">{d.kind.template}</div>
					<div className="flex flex-wrap gap-x-6 gap-y-1">
						<KeyValue label="in this window">{plural(d.count, "time")}</KeyValue>
						<KeyValue label="players affected">{fmtInt(d.players)}</KeyValue>
						<KeyValue label="all time">{fmtInt(d.kind.total)}</KeyValue>
						<KeyValue label="first seen">{fmtTime(d.kind.firstAt)}</KeyValue>
						<KeyValue label="last seen">{fmtTime(d.kind.lastAt)}</KeyValue>
						<KeyValue label="fingerprint">
							<span className="font-mono text-xs">{d.kind.fp}</span>
						</KeyValue>
					</div>
					<SeriesBars detail={d} />
					<div className="space-y-1">
						<div className="text-xs font-medium text-muted-foreground">Players who hit it</div>
						<KindPlayers fp={fp} params={params} />
					</div>
					<div className="grid gap-4 md:grid-cols-3">
						<Breakdown title="By build" rows={d.byBuild.map((r) => ({ label: r.build, n: r.n }))} />
						<Breakdown title="By branch" rows={d.byBranch.map((r) => ({ label: r.branch, n: r.n }))} />
						<Breakdown title="By side" rows={d.byRealm.map((r) => ({ label: r.realm, n: r.n }))} />
					</div>
					<div className="space-y-1">
						<div className="text-xs font-medium text-muted-foreground">Sample stack (from the first report)</div>
						{d.kind.stack ? <JsonBlock value={d.kind.stack} className="max-h-72 whitespace-pre-wrap break-words" /> : <p className="text-sm text-muted-foreground">No stack was sent.</p>}
					</div>
					<p className="text-xs text-muted-foreground">Names and ids in the message were replaced by the game before it was sent; players are counted by their analytics id.</p>
				</div>
			)}
		</QueryState>
	);
}

export default function Errors() {
	const [window, setWindow] = useParam("window", "24h");
	const [realm, setRealm] = useParam("realm");
	const [branch, setBranch] = useParam("branch");
	const [build, setBuild] = useParam("build");
	const [q, setQ] = useParam("q");
	const [selected, setSelected] = useParam("fp");
	const params: ErrorParams = { window, ...(realm ? { realm } : {}), ...(branch ? { branch } : {}), ...(build ? { build } : {}), ...(q ? { q } : {}) };
	// The search only picks which kinds are listed; one kind's reads take the window and the other filters.
	const { q: _search, ...kindParams } = params;
	const list = useQuery({ queryKey: ["errors", "list", params], queryFn: ({ signal }) => api.errors({ ...params, limit: 200 }, signal), refetchInterval: 30_000 });
	const artifacts = artifactOptions(list.data?.builds, build);
	const stream = useErrorStream();
	const streamTone = stream === "live" ? "bg-[var(--status-good)]" : stream === "retrying" ? "bg-[var(--status-critical)]" : "bg-[var(--status-warning)]";
	return (
		<>
			<PageHeader
				title="Errors"
				description="Error logs from game servers and clients, grouped by kind. Names and ids are replaced in the game before they are sent."
				actions={
					<>
						<Select value={window} onValueChange={setWindow}>
							<SelectTrigger className="h-8 w-40" aria-label="Window">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{WINDOWS.map((w) => (
									<SelectItem key={w.value} value={w.value}>
										{w.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select value={realm || ANY} onValueChange={(v) => setRealm(v === ANY ? "" : v)}>
							<SelectTrigger className="h-8 w-40" aria-label="Server or client">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ANY}>Server + client</SelectItem>
								<SelectItem value="server">Server</SelectItem>
								<SelectItem value="client">Client</SelectItem>
							</SelectContent>
						</Select>
						<TextFilter value={branch} onCommit={setBranch} placeholder="any branch" label="Branch" />
						<Select value={build || ANY} onValueChange={(v) => setBuild(v === ANY ? "" : v)}>
							<SelectTrigger className="h-8 w-48 font-mono text-xs" aria-label="Artifact">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ANY}>Any artifact</SelectItem>
								{artifacts.map((a) => (
									<SelectItem key={a} value={a} className="font-mono text-xs">
										{a}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<TextFilter value={q} onCommit={setQ} placeholder="search text" label="Search" className="w-40" />
						<Status tone={streamTone}>{stream === "live" ? "live" : stream === "retrying" ? "stream lost, retrying" : "connecting"}</Status>
					</>
				}
			/>
			<QueryState query={list}>
				{(data) => (
					<>
						<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
							<Metric label="Errors" value={fmtInt(data.totals.count)} sub={`in the ${WINDOWS.find((w) => w.value === window)?.label.toLowerCase() ?? window}`} />
							<Metric label="Kinds" value={fmtInt(data.totals.kinds)} sub={data.more ? `${fmtInt(data.more)} more not shown` : undefined} />
							<Metric label="Players affected" value={fmtInt(data.totals.players)} sub="by days touched" />
							<Metric label="Trend step" value={bucketLabel(data.window.bucketSeconds)} sub={`${data.window.buckets} steps`} />
						</div>
						<Section title="Error kinds" description="Most frequent first. Open a row for its stack, where it happens and the players who hit it.">
							<Kinds data={data} selected={selected} onSelect={setSelected} />
						</Section>
					</>
				)}
			</QueryState>
			<Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected("")}>
				<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl md:w-[48rem]">
					<div className="space-y-1 border-b p-4 pr-10">
						<SheetTitle>Selected error</SheetTitle>
						<SheetDescription>{WINDOWS.find((w) => w.value === window)?.label ?? window}, under the page's filters.</SheetDescription>
					</div>
					<div className="p-4">{selected ? <KindDetail fp={selected} params={kindParams} /> : null}</div>
				</SheetContent>
			</Sheet>
		</>
	);
}

export type { ErrorKind };
