/**
 * Debug bundles (kernel 0.5.3): what a game server sent when something failed, so the owner can see what happened after
 * the server is gone. The list comes with the server (GET /v1/fleet/servers/<job> `history.bundles`); opening one
 * (?bundle=<id>, also from an alert's d.bundle) reads its body (GET /v1/fleet/bundles/<id>): a summary card, then
 * Players, Server log, Player logs (owners only: the backend leaves them out for the read-only role) and Deploy and swaps.
 *
 * A bundle's content comes from a game server and is never trusted: every value is shown as text (React text nodes and
 * JsonBlock's <pre>), never as HTML, and the tables keep nothing in localStorage or the URL.
 */
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { EmptyState, ErrorState, JsonBlock, KeyValue, LoadingBlock, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError } from "@/lib/api";
import { fmtBytes, fmtInt, fmtTime, shortId } from "@/lib/format";
import type { BundleSummary, DebugBundle } from "@/lib/types";
import { asList, asRecord, bundlePlayers, field, logEntries, plain, playerLogOwners, type BundlePlayer } from "./history";
import { LogTable, MEMORY_ONLY, Tone } from "./shared";

/** Owners only: the backend sends no playerLogs to the read-only role, and the tab isn't offered. */
export const PLAYER_LOGS_OWNERS_TEXT = "Player logs are for owners: this session is read-only.";

const LEVEL_TONE: Record<string, string> = {
	critical: "bg-[var(--status-critical)]",
	warning: "bg-[var(--status-warning)]",
	info: "bg-muted-foreground",
};

const BUNDLE_COLUMNS: DataColumn<BundleSummary>[] = [
	{ id: "at", header: "When (UTC)", type: "date", accessor: (b) => b.at, cell: (b) => fmtTime(b.at), className: "font-mono text-xs tabular-nums" },
	{ id: "code", header: "Trigger", type: "enum", accessor: (b) => b.code, className: "font-mono text-xs" },
	{
		id: "level",
		header: "Level",
		type: "enum",
		order: ["critical", "warning", "info"],
		accessor: (b) => b.level,
		cell: (b) => <Tone tone={LEVEL_TONE[b.level]}>{b.level}</Tone>,
	},
	{ id: "message", header: "Message", accessor: (b) => b.message, className: "max-w-96 whitespace-normal" },
	{ id: "stage", header: "Stage", type: "enum", accessor: (b) => b.stage ?? null, className: "text-xs" },
	{ id: "players", header: "Players", type: "number", accessor: (b) => b.players },
	{ id: "closing", header: "On close", type: "boolean", accessor: (b) => b.closing, defaultHidden: true },
	{ id: "size", header: "Size", type: "number", accessor: (b) => b.size, cell: (b) => fmtBytes(b.size), className: "text-xs tabular-nums" },
	{ id: "artifact", header: "Build", type: "enum", accessor: (b) => b.artifact, defaultHidden: true, className: "font-mono text-xs" },
];

/** The Debug bundles section: the server's bundles, and the open one under them. */
export function DebugBundles({ bundles, open, onOpen, readOnly }: { bundles: BundleSummary[]; open: string; onOpen: (id: string) => void; readOnly: boolean }) {
	return (
		<Section
			title="Debug bundles"
			description="What this server sent when something failed (kept 30 days, 20 per server). Its content comes from the game server and is shown as text."
		>
			<div className="space-y-4">
				<DataTable
					id="server-bundles"
					label="Debug bundles"
					columns={BUNDLE_COLUMNS}
					data={bundles}
					rowId={(b) => b.id}
					defaultSort={[{ id: "at", desc: true }]}
					onRowClick={(b) => onOpen(b.id)}
					rowActionLabel={(b) => `Open the ${b.code} bundle from ${fmtTime(b.at)}`}
					isRowSelected={(b) => b.id === open}
					maxHeight="20rem"
					density="compact"
					empty={<EmptyState>No debug bundles from this server (kernel 0.5.3+ sends one when something fails).</EmptyState>}
					{...MEMORY_ONLY}
				/>
				{open ? <BundleView key={open} id={open} readOnly={readOnly} onClose={() => onOpen("")} /> : null}
			</div>
		</Section>
	);
}

/** One bundle: its summary card, then the tabs. */
export function BundleView({ id, readOnly, onClose }: { id: string; readOnly: boolean; onClose: () => void }) {
	const query = useQuery({ queryKey: ["fleet", "bundle", id], queryFn: ({ signal }) => api.debugBundle(id, signal), staleTime: Number.POSITIVE_INFINITY });
	const close = (
		<Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close the bundle">
			<X aria-hidden />
			Close
		</Button>
	);
	if (query.isPending) return <LoadingBlock rows={4} />;
	if (query.isError) {
		const gone = query.error instanceof ApiError && query.error.notFound;
		return (
			<div className="space-y-2">
				{gone ? <EmptyState>This bundle is gone (bundles are kept 30 days, 20 per server).</EmptyState> : <ErrorState error={query.error} title="Could not load this bundle" />}
				{close}
			</div>
		);
	}
	return <BundleBodyView bundle={query.data} readOnly={readOnly} close={close} />;
}

type BundleTab = "players" | "server-log" | "player-logs" | "deploy";

function BundleBodyView({ bundle, readOnly, close }: { bundle: DebugBundle; readOnly: boolean; close: ReactNode }) {
	const body = bundle.body ?? {};
	const failure = asRecord(body.failure);
	const players = useMemo(() => bundlePlayers(body.players), [body.players]);
	const ownersOnly = readOnly || bundle.playerLogsHidden === true;
	const [tab, setTab] = useState<BundleTab>("players");
	const tabs: { id: BundleTab; label: string }[] = [
		{ id: "players", label: `Players (${fmtInt(players.length)})` },
		{ id: "server-log", label: "Server log" },
		...(ownersOnly ? [] : [{ id: "player-logs" as const, label: "Player logs" }]),
		{ id: "deploy", label: "Deploy and swaps" },
	];
	const error = plain(failure.error) || bundle.error || "";
	const stage = plain(failure.stage) || bundle.stage || "";
	// Triggers within 3 s join one bundle (failure.triggers): its code can be start_failed while the alert says deploy_failed.
	const triggers = asList(failure.triggers)
		.map((t) => (typeof t === "string" ? t : plain(asRecord(t).code, 64) || plain(t, 120)))
		.filter(Boolean);
	return (
		<section aria-label={`Debug bundle ${bundle.id}`} className="space-y-4 rounded-lg border p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<Tone tone={LEVEL_TONE[bundle.level]}>{bundle.level}</Tone>
						<span className="font-mono text-sm">{bundle.code}</span>
						{bundle.closing ? <Badge variant="outline">sent on close</Badge> : null}
					</div>
					<p className="text-sm font-medium break-words whitespace-pre-wrap">{bundle.message || "(no message)"}</p>
				</div>
				{close}
			</div>
			<div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
				<KeyValue label="Stage">{stage || "–"}</KeyValue>
				{triggers.length ? <KeyValue label="Triggers">{triggers.join(", ")}</KeyValue> : null}
				<KeyValue label="Sent">{fmtTime(bundle.at)} UTC</KeyValue>
				<KeyValue label="Kernel">{bundle.kernel ?? "–"}</KeyValue>
				<KeyValue label="Branch">{bundle.branch ?? "–"}</KeyValue>
				<KeyValue label="Build">{bundle.artifact ?? "–"}</KeyValue>
				<KeyValue label="Seq">{bundle.seq ?? "–"}</KeyValue>
				<KeyValue label="Generation">{bundle.generation ?? "–"}</KeyValue>
				<KeyValue label="Size">{fmtBytes(bundle.size)}</KeyValue>
				<KeyValue label="Id">
					<span className="font-mono text-xs" title={bundle.id}>
						{shortId(bundle.id, 6)}
					</span>
				</KeyValue>
			</div>
			{error ? (
				<div className="space-y-1">
					<div className="text-xs font-medium text-muted-foreground">Error</div>
					<pre className="max-h-48 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words text-[var(--status-critical)]">{error}</pre>
				</div>
			) : null}
			{failure.report !== undefined ? (
				<details>
					<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Failure report</summary>
					<JsonBlock value={failure.report} className="mt-2" />
				</details>
			) : null}
			<Tabs value={tab} onValueChange={(v) => setTab(v as BundleTab)} className="gap-3">
				<div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
					<TabsList variant="line" className="w-max" aria-label="Bundle">
						{tabs.map((t) => (
							<TabsTrigger key={t.id} value={t.id}>
								{t.label}
							</TabsTrigger>
						))}
					</TabsList>
				</div>
				<TabsContent value="players">
					<PlayersTable players={players} />
				</TabsContent>
				<TabsContent value="server-log">
					<LogTable id="bundle-server-log" label="Server log" entries={logEntries(body.serverLog)} empty={<EmptyState>No server log in this bundle.</EmptyState>} />
				</TabsContent>
				{ownersOnly ? null : (
					<TabsContent value="player-logs">
						<PlayerLogs playerLogs={body.playerLogs} players={players} />
					</TabsContent>
				)}
				<TabsContent value="deploy">
					<DeployView deploy={body.deploy} fallback={body.fallback} />
				</TabsContent>
			</Tabs>
			{ownersOnly ? <p className="text-xs text-muted-foreground">{PLAYER_LOGS_OWNERS_TEXT}</p> : null}
			<details>
				<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Server, alerts and the raw bundle</summary>
				<div className="mt-2 space-y-2">
					<JsonBlock value={{ server: body.server ?? null, alerts: body.alerts ?? [] }} />
					<JsonBlock value={body} />
				</div>
			</details>
		</section>
	);
}

const unixTime = (s: number | undefined) => (s === undefined ? "–" : fmtTime(s * 1000).slice(11) + " UTC");

const PLAYER_COLUMNS: DataColumn<BundlePlayer>[] = [
	{ id: "name", header: "Player", accessor: (p) => p.name || null },
	{ id: "userId", header: "UserId", type: "text", accessor: (p) => p.userId, className: "font-mono text-xs" },
	{ id: "joinedAt", header: "Joined", type: "number", accessor: (p) => p.joinedAt ?? null, cell: (p) => unixTime(p.joinedAt), className: "font-mono text-xs" },
	{ id: "leftAt", header: "Left", type: "number", accessor: (p) => p.leftAt ?? null, cell: (p) => (p.leftAt === undefined ? "still in" : unixTime(p.leftAt)), className: "font-mono text-xs" },
	{ id: "ping", header: "Ping", hint: "ms", type: "number", accessor: (p) => p.ping ?? null },
	{ id: "client", header: "Client", accessor: (p) => p.client || null, className: "max-w-96 font-mono text-xs whitespace-pre-wrap break-words" },
];

function PlayersTable({ players }: { players: BundlePlayer[] }) {
	return (
		<DataTable
			id="bundle-players"
			label="Players in the bundle"
			columns={PLAYER_COLUMNS}
			data={players}
			rowId={(p, i) => `${p.userId}-${i}`}
			density="compact"
			empty={<EmptyState>Nobody was in the server.</EmptyState>}
			{...MEMORY_ONLY}
		/>
	);
}

function PlayerLogs({ playerLogs, players }: { playerLogs: unknown; players: BundlePlayer[] }) {
	const owners = useMemo(() => playerLogOwners(playerLogs, players), [playerLogs, players]);
	const [userId, setUserId] = useState(owners[0]?.userId ?? "");
	if (!owners.length) return <EmptyState>No player logs in this bundle.</EmptyState>;
	const current = owners.find((o) => o.userId === userId) ?? owners[0];
	return (
		<div className="space-y-3">
			<Select value={current.userId} onValueChange={setUserId}>
				<SelectTrigger size="sm" className="w-64 max-w-full" aria-label="Player">
					<SelectValue placeholder="Pick a player" />
				</SelectTrigger>
				<SelectContent>
					{owners.map((o) => (
						<SelectItem key={o.userId} value={o.userId}>
							{o.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<LogTable
				key={current.userId}
				id="bundle-player-log"
				label={`Client log of ${current.label}`}
				entries={logEntries(asRecord(playerLogs)[current.userId])}
				empty={<EmptyState>No lines from this client.</EmptyState>}
			/>
		</div>
	);
}

const yesNo = (v: unknown) => (v === true ? "yes" : v === false ? "no" : v === undefined || v === null ? "–" : plain(v, 200));

interface HistoryRow {
	i: number;
	at: string;
	name: string;
	artifact: string;
	branch: string;
	reason: string;
	load: string;
	swap: string;
}

const HISTORY_COLUMNS: DataColumn<HistoryRow>[] = [
	{ id: "at", header: "When", accessor: (r) => r.at, className: "font-mono text-xs" },
	{ id: "name", header: "Generation", accessor: (r) => r.name, className: "font-mono text-xs" },
	{ id: "artifact", header: "Build", accessor: (r) => r.artifact, className: "font-mono text-xs" },
	{ id: "branch", header: "Branch", accessor: (r) => r.branch },
	{ id: "reason", header: "Why", accessor: (r) => r.reason },
	{ id: "load", header: "Load", hint: "s", accessor: (r) => r.load, className: "tabular-nums" },
	{ id: "swap", header: "Swap", hint: "s", accessor: (r) => r.swap, className: "tabular-nums" },
];

/** Deploy and swaps: the kernel's deploy state, its generation history, swap reports, refusals and Fallback. */
function DeployView({ deploy, fallback }: { deploy: unknown; fallback: unknown }) {
	const history = asList(field(deploy, "history")).map((raw, i): HistoryRow => {
		const e = asRecord(raw);
		return { i, at: plain(e.at, 40), name: plain(e.name, 64), artifact: plain(e.artifactId, 64), branch: plain(e.branch, 64), reason: plain(e.reason, 32), load: plain(e.loadSeconds, 16), swap: plain(e.swapSeconds, 16) };
	});
	const refusals = asList(field(deploy, "refusals"));
	const reports = asList(field(deploy, "reports"));
	if (deploy === undefined && fallback === undefined) return <EmptyState>No deploy state in this bundle.</EmptyState>;
	return (
		<div className="space-y-4">
			<div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
				<KeyValue label="Applied seq">{plain(field(deploy, "appliedSeq"), 32) || "–"}</KeyValue>
				<KeyValue label="Failing">{yesNo(field(deploy, "failing"))}</KeyValue>
				<KeyValue label="Pending">{yesNo(field(deploy, "pending"))}</KeyValue>
				<KeyValue label="Wanted">{yesNo(field(deploy, "wanted"))}</KeyValue>
				<KeyValue label="Busy">{yesNo(field(deploy, "busy"))}</KeyValue>
				<KeyValue label="Restoring">{yesNo(field(deploy, "restoring"))}</KeyValue>
			</div>
			<section className="space-y-2">
				<h3 className="text-sm font-medium">Generation history</h3>
				<DataTable
					id="bundle-history"
					label="Generation history"
					columns={HISTORY_COLUMNS}
					data={history}
					rowId={(r) => String(r.i)}
					density="compact"
					empty={<EmptyState>No generation history.</EmptyState>}
					{...MEMORY_ONLY}
				/>
			</section>
			{field(deploy, "failedHere") !== undefined ? (
				<section className="space-y-2">
					<h3 className="text-sm font-medium">Failed here</h3>
					<JsonBlock value={field(deploy, "failedHere")} />
				</section>
			) : null}
			<section className="space-y-2">
				<h3 className="text-sm font-medium">Swap reports ({fmtInt(reports.length)})</h3>
				{reports.length ? <JsonBlock value={reports} /> : <p className="text-sm text-muted-foreground">None.</p>}
			</section>
			<section className="space-y-2">
				<h3 className="text-sm font-medium">Refusals ({fmtInt(refusals.length)})</h3>
				{refusals.length ? <JsonBlock value={refusals} /> : <p className="text-sm text-muted-foreground">None.</p>}
			</section>
			{field(deploy, "heads") !== undefined ? (
				<details>
					<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Heads</summary>
					<JsonBlock value={field(deploy, "heads")} className="mt-2" />
				</details>
			) : null}
			<section className="space-y-2">
				<h3 className="text-sm font-medium">Fallback</h3>
				{fallback !== undefined && fallback !== null ? <JsonBlock value={fallback} /> : <p className="text-sm text-muted-foreground">No Fallback state.</p>}
			</section>
		</div>
	);
}
