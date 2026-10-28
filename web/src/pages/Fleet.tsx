import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { EmptyState, KeyValue, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { HealthBadge } from "@/components/HealthReasons";
import { api } from "@/lib/api";
import { fmtAgo, fmtDuration, fmtInt, fmtNum, fmtTime, plural, shortId } from "@/lib/format";
import { useParam } from "@/lib/hooks";
import type { FleetAlert, FleetReportResult, FleetReports, FleetServer, FleetServers, GoneServer, ServerBudget } from "@/lib/types";
// Plans/25: every JobId here links to its server page (/servers/<JobId>).
import { alertBundle } from "./server/history";
import { JobLink } from "./server/shared";

type StreamState = "connecting" | "live" | "retrying";

interface LiveEvent {
	at: number;
	type: string;
	text: string;
}

const LEVEL_TONE: Record<string, string> = {
	critical: "bg-[var(--status-critical)]",
	warning: "bg-[var(--status-warning)]",
	info: "bg-muted-foreground",
};

/** A colored dot plus its word (color never carries the meaning alone). */
function Status({ tone, children }: { tone?: string; children: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs">
			<span className={cn("size-2 rounded-full", tone ?? "bg-muted-foreground")} aria-hidden />
			{children}
		</span>
	);
}

function describe(type: string, data: Record<string, unknown>): string {
	if (type === "server") {
		const s = data.server as { job?: string; players?: number; health?: string } | undefined;
		return `server ${shortId(s?.job, 6)} ${String(data.change)} (${plural(s?.players ?? 0, "player")}, ${s?.health ?? "?"})`;
	}
	if (type === "alert") {
		const a = data.alert as FleetAlert | undefined;
		return `${a?.level ?? ""} alert ${a?.code ?? ""}: ${a?.message ?? ""}`;
	}
	if (type === "report") return `deploy #${String(data.seq)}: ${shortId(String(data.job), 6)} ${String(data.result)}`;
	if (type === "deploy") return `deploy #${String(data.seq)} started on ${String(data.branch)} (${String(data.artifact)})`;
	if (type === "alert_ack") return `alert ${String(data.id)} acknowledged`;
	return type;
}

/** Live updates over the SSE stream: refetches what changed and keeps a short log. */
function useFleetStream(branch: string): { state: StreamState; log: LiveEvent[] } {
	const client = useQueryClient();
	const [state, setState] = useState<StreamState>("connecting");
	const [log, setLog] = useState<LiveEvent[]>([]);
	useEffect(() => {
		const source = new EventSource(api.streamUrl(branch ? { branch } : {}));
		const push = (type: string, raw: string) => {
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				// keep the type
			}
			setLog((current) => [{ at: Date.now(), type, text: describe(type, data) }, ...current].slice(0, 50));
			if (type === "server") {
				void client.invalidateQueries({ queryKey: ["fleet", "servers"] });
				void client.invalidateQueries({ queryKey: ["fleet", "gone"] });
			}
			if (type === "alert" || type === "alert_ack") void client.invalidateQueries({ queryKey: ["fleet", "alerts"] });
			if (type === "report" || type === "deploy") void client.invalidateQueries({ queryKey: ["fleet", "report"] });
		};
		source.addEventListener("hello", () => setState("live"));
		for (const type of ["server", "alert", "alert_ack", "report", "deploy"]) source.addEventListener(type, (e) => push(type, (e as MessageEvent<string>).data));
		source.onerror = () => setState(source.readyState === EventSource.CLOSED ? "retrying" : "connecting");
		source.onopen = () => setState("live");
		return () => source.close();
	}, [branch, client]);
	return { state, log };
}

/**
 * Kernel 0.4.0 heartbeat `bu`, one short line: TypeTorch's DataStore reads and HTTP requests a minute against the
 * limits. Memory has its own column (kernel 0.4.2 rows: memMb); the tooltip still lists it.
 */
export function budgetText(b: ServerBudget | null | undefined): string {
	if (!b) return "–";
	const parts: string[] = [];
	if (b.ds) parts.push(`DS ${b.ds.r ?? 0}/${b.ds.lr ?? "?"}`);
	if (b.h) parts.push(`HTTP ${b.h.r ?? 0}/${b.h.l ?? "?"}`);
	return parts.length ? parts.join(" · ") : "–";
}

/** Below this TPS a server runs slow (a healthy one runs at 60). The dev menu's Server > Status and the backend's fleet/health.ts (the Health reasons) use the same line. */
export const LOW_TPS = 50;
/** Above this total memory (MB) a server is in trouble; the dev menu's "High memory" issue and the backend's fleet/health.ts use the same line. */
export const HIGH_MEMORY_MB = 3000;

const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** A TPS reading under LOW_TPS (unknown is not low). */
export const tpsLow = (v: number | null | undefined) => known(v) && v < LOW_TPS;
/** A memory reading over HIGH_MEMORY_MB (unknown is not high). */
export const memoryHigh = (v: number | null | undefined) => known(v) && v > HIGH_MEMORY_MB;

const tpsFixed = (v: number | null | undefined) => (known(v) ? v.toFixed(1) : "–");

/** The TPS cell's text: "59.8 / 52.0" (average / slowest second since the previous heartbeat), "–" when unknown. */
export function tpsText(s: FleetServer): string {
	if (!known(s.tps)) return "–";
	return known(s.tpsMin) ? `${tpsFixed(s.tps)} / ${tpsFixed(s.tpsMin)}` : tpsFixed(s.tps);
}

function perfTitle(s: FleetServer): string | undefined {
	if (!known(s.tps)) return "No TPS reading (kernel 0.4.2+ sends one with every heartbeat)";
	const parts = [`average ${tpsFixed(s.tps)}`, `slowest second ${tpsFixed(s.tpsMin)}`];
	if (known(s.physFps)) parts.push(`physics ${fmtNum(s.physFps, 0)} FPS`);
	return `Server TPS since the previous heartbeat: ${parts.join(", ")}${tpsLow(s.tps) ? ` (under ${LOW_TPS})` : ""}`;
}

function memoryTitle(s: FleetServer): string | undefined {
	if (!known(s.memMb)) return undefined;
	return `Total ${fmtNum(s.memMb, 0)} MB, Lua heap ${known(s.luaMb) ? `${fmtNum(s.luaMb, 1)} MB` : "?"}${memoryHigh(s.memMb) ? ` (over ${fmtInt(HIGH_MEMORY_MB)} MB)` : ""}`;
}

/** A number with a warning dot when it is out of range (colour never carries the meaning alone: the tooltip says why). */
function Reading({ warn, title, children }: { warn: boolean; title?: string; children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5 tabular-nums" title={title}>
			{warn ? <span className="size-2 shrink-0 rounded-full bg-[var(--status-warning)]" aria-hidden /> : null}
			<span className={cn(warn && "font-medium")}>{children}</span>
			{warn ? <span className="sr-only">(warning)</span> : null}
		</span>
	);
}

const CALLERS: Record<string, string> = { k: "kernel", d: "devtools", a: "analytics", g: "game", f: "framework" };

/** The full summary for the cell's tooltip. */
export function budgetTitle(b: ServerBudget | null | undefined): string | undefined {
	if (!b) return undefined;
	const lines = [
		`DataStore a minute: read ${b.ds?.r ?? 0}/${b.ds?.lr ?? "?"}, write ${b.ds?.w ?? 0}/${b.ds?.lw ?? "?"}${b.ds?.br !== undefined ? `, budget left ${b.ds.br} read / ${b.ds.bw ?? "?"} write` : ""}`,
		`MemoryStore units ${b.ms?.u ?? 0}/${b.ms?.l ?? "?"}, HTTP ${b.h?.r ?? 0}/${b.h?.l ?? "?"}, publishes ${b.mg?.p ?? 0}/${b.mg?.lp ?? "?"}`,
		`by ${Object.entries(b.by ?? {}).map(([k, v]) => `${CALLERS[k] ?? k} ${v}`).join(", ") || "-"}`,
	];
	if (b.mem) lines.push(`memory ${b.mem.t ?? "?"} MB, LuaHeap ${b.mem.h ?? "?"} MB`);
	return lines.join(" | ");
}

/**
 * How much of its tightest per-minute limit a server uses (0 to 1+): DataStore reads or HTTP requests against their
 * limits. The Budget column sorts by this; the cell shows the text.
 */
export function budgetPressure(b: ServerBudget | null | undefined): number | null {
	if (!b) return null;
	const shares = [b.ds?.lr ? (b.ds.r ?? 0) / b.ds.lr : null, b.h?.l ? (b.h.r ?? 0) / b.h.l : null].filter((v): v is number => v !== null);
	return shares.length ? Math.max(...shares) : null;
}

/** Last heartbeat as epoch ms: the timestamp, else now minus the age the server reported. */
const seenAt = (s: FleetServer) => s.lastSeen ?? (s.ageSeconds !== undefined ? Date.now() - s.ageSeconds * 1000 : null);

const seenText = (s: FleetServer) => (s.ageSeconds !== undefined ? `${s.ageSeconds}s ago` : fmtAgo(s.lastSeen));

/**
 * The live servers table. A column sorts, filters and exports by its accessor and shows its cell, so formatted cells
 * ("47 / 60", "59.8 / 52.0", "5 min ago") still sort by the number or the timestamp (rows without a value go last).
 * New columns go in this list, like TPS and Memory (kernel 0.4.2).
 */
export const SERVER_COLUMNS: DataColumn<FleetServer>[] = [
	{
		id: "job",
		header: "Job",
		accessor: (s) => s.job,
		cell: (s) => <JobLink job={s.job} />,
		className: "font-mono text-xs",
	},
	{ id: "type", header: "Type", type: "enum", accessor: (s) => s.serverType },
	{ id: "branch", header: "Branch", type: "enum", accessor: (s) => s.branch },
	{ id: "channel", header: "Channel", type: "enum", accessor: (s) => s.channel ?? null, defaultHidden: true },
	{
		id: "artifact",
		header: "Artifact",
		type: "enum",
		accessor: (s) => s.artifact,
		cell: (s) => (
			<>
				{s.artifact ?? "–"} {s.experiment ? <Badge variant="secondary">A/B pin</Badge> : null}
			</>
		),
		className: "font-mono text-xs",
	},
	{ id: "seq", header: "Seq", accessor: (s) => s.appliedSeq },
	{ id: "players", header: "Players", accessor: (s) => s.players, cell: (s) => `${fmtInt(s.players)} / ${fmtInt(s.maxPlayers)}` },
	{ id: "maxPlayers", header: "Max players", accessor: (s) => s.maxPlayers, defaultHidden: true },
	{
		id: "health",
		header: "Health",
		type: "enum",
		order: ["ok", "unverified", "degraded", "failed", "failing"],
		options: ["ok", "unverified", "degraded", "failed"],
		firstSort: "desc",
		accessor: (s) => s.health ?? "unknown",
		cell: (s) => <HealthBadge server={s} />,
	},
	// Kernel 0.4.2: TPS (average / slowest second since the previous heartbeat; sorts by the average, slowest first) and
	// memory; older kernels have none ("–", sorted last).
	{
		id: "tps",
		header: "TPS",
		hint: "avg / min",
		type: "number",
		firstSort: "asc",
		accessor: (s) => (known(s.tps) ? s.tps : null),
		cell: (s) => (
			<Reading warn={tpsLow(s.tps)} title={perfTitle(s)}>
				{tpsFixed(s.tps)}
				{known(s.tps) && known(s.tpsMin) ? <span className="text-muted-foreground"> / {tpsFixed(s.tpsMin)}</span> : null}
			</Reading>
		),
		format: (_v, s) => tpsText(s),
	},
	{
		id: "tpsMin",
		header: "TPS min",
		hint: "slowest s",
		type: "number",
		firstSort: "asc",
		defaultHidden: true,
		accessor: (s) => (known(s.tpsMin) ? s.tpsMin : null),
		cell: (s) => (
			<Reading warn={tpsLow(s.tpsMin)} title={perfTitle(s)}>
				{tpsFixed(s.tpsMin)}
			</Reading>
		),
	},
	{
		id: "physFps",
		header: "Physics",
		hint: "FPS",
		type: "number",
		firstSort: "asc",
		defaultHidden: true,
		accessor: (s) => (known(s.physFps) ? s.physFps : null),
		cell: (s) => fmtNum(s.physFps, 0),
		className: "tabular-nums",
	},
	{
		id: "memory",
		header: "Memory",
		hint: "MB",
		type: "number",
		accessor: (s) => (known(s.memMb) ? s.memMb : null),
		cell: (s) => (
			<Reading warn={memoryHigh(s.memMb)} title={memoryTitle(s)}>
				{fmtNum(s.memMb, 0)}
			</Reading>
		),
	},
	{
		id: "luaHeap",
		header: "Lua heap",
		hint: "MB",
		type: "number",
		defaultHidden: true,
		accessor: (s) => (known(s.luaMb) ? s.luaMb : null),
		cell: (s) => fmtNum(s.luaMb, 1),
		className: "tabular-nums",
	},
	{ id: "kernel", header: "Kernel", type: "enum", accessor: (s) => s.kernel, className: "text-xs" },
	{
		id: "budget",
		header: "Budget",
		title: "Sorts by the share of the tightest per-minute limit in use",
		accessor: (s) => budgetPressure(s.budget),
		cell: (s) => <span title={budgetTitle(s.budget)}>{budgetText(s.budget)}</span>,
		format: (_v, s) => budgetText(s.budget),
		exportValue: (s) => budgetText(s.budget),
		filter: false,
		className: "font-mono text-xs",
	},
	{ id: "startedAt", header: "Up since", type: "date", accessor: (s) => s.startedAt, cell: (s) => fmtAgo(s.startedAt), format: (_v, s) => fmtAgo(s.startedAt), className: "text-xs" },
	{ id: "seen", header: "Seen", type: "date", accessor: seenAt, cell: seenText, format: (_v, s) => seenText(s), className: "text-xs" },
	{ id: "placeId", header: "Place", type: "text", accessor: (s) => (s.placeId == null ? null : String(s.placeId)), defaultHidden: true },
	{ id: "generation", header: "Generation", accessor: (s) => s.generation, defaultHidden: true },
	{ id: "experiment", header: "A/B pin", type: "boolean", accessor: (s) => s.experiment ?? false, defaultHidden: true },
	{ id: "lastError", header: "Last error", accessor: (s) => s.lastError, defaultHidden: true, className: "max-w-80 truncate text-xs" },
];

function Servers({ data }: { data: FleetServers }) {
	return (
		<DataTable
			id="fleet-servers"
			label="Live servers"
			columns={SERVER_COLUMNS}
			data={data.servers}
			rowId={(s) => s.job}
			empty={<EmptyState>No live servers (a server shows up within 30 s of its first heartbeat, and leaves 90 s after its last).</EmptyState>}
		/>
	);
}

const FAILED = new Set(["failed", "rolled_back"]);

const RESULT_COLUMNS: DataColumn<FleetReportResult>[] = [
	{
		id: "result",
		header: "Result",
		type: "enum",
		accessor: (r) => r.result,
		cell: (r) => <Badge variant={FAILED.has(r.result) ? "destructive" : "secondary"}>{r.result}</Badge>,
	},
	{ id: "servers", header: "Servers", accessor: (r) => r.servers },
	{ id: "players", header: "Players", accessor: (r) => r.players },
	{ id: "median", header: "Median", hint: "s", accessor: (r) => r.medianSeconds, cell: (r) => (r.medianSeconds === null ? "–" : fmtNum(r.medianSeconds, 1)) },
	{ id: "max", header: "Slowest", hint: "s", accessor: (r) => r.maxSeconds, cell: (r) => (r.maxSeconds === null ? "–" : fmtNum(r.maxSeconds, 1)) },
];

const DEPLOY_ERROR_COLUMNS: DataColumn<FleetReports["errors"][number]>[] = [
	{ id: "error", header: "Error", accessor: (e) => e.error, className: "max-w-96 whitespace-normal text-[var(--status-critical)]" },
	{ id: "servers", header: "Servers", accessor: (e) => e.servers },
	{ id: "example", header: "Example", accessor: (e) => e.exampleJob, cell: (e) => <JobLink job={e.exampleJob} />, className: "font-mono text-xs" },
];

type ServerReport = NonNullable<FleetReports["reports"]>[number];

const REPORT_COLUMNS: DataColumn<ServerReport>[] = [
	{ id: "at", header: "When (UTC)", type: "date", accessor: (r) => r.at, cell: (r) => fmtTime(r.at), className: "font-mono text-xs tabular-nums" },
	{ id: "job", header: "Job", accessor: (r) => r.job, cell: (r) => <JobLink job={r.job} />, className: "font-mono text-xs" },
	{
		id: "result",
		header: "Result",
		type: "enum",
		accessor: (r) => r.result,
		cell: (r) => <Badge variant={FAILED.has(r.result) ? "destructive" : "secondary"}>{r.result}</Badge>,
	},
	{ id: "seconds", header: "Took", hint: "s", accessor: (r) => r.seconds, cell: (r) => (r.seconds === null ? "–" : fmtNum(r.seconds, 1)) },
	{ id: "kernel", header: "Kernel", type: "enum", accessor: (r) => r.kernel ?? null, className: "text-xs" },
	{ id: "error", header: "Error", accessor: (r) => r.error, className: "max-w-80 whitespace-normal text-xs" },
	{ id: "seq", header: "Deploy", accessor: (r) => r.seq, defaultHidden: true },
];

export function Report({ data }: { data: FleetReports }) {
	if (data.seq === null) return <EmptyState>No deploy reported yet.</EmptyState>;
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-x-6 gap-y-1">
				<KeyValue label="seq">#{data.seq}</KeyValue>
				<KeyValue label="branch">{data.branch ?? "–"}</KeyValue>
				<KeyValue label="artifact">{data.artifact ?? "–"}</KeyValue>
				<KeyValue label="started">{fmtTime(data.startedAt)}</KeyValue>
				<KeyValue label="servers reported">{fmtInt(data.reported)}</KeyValue>
			</div>
			{data.results.length ? <DataTable id="fleet-results" label="Deploy results" columns={RESULT_COLUMNS} data={data.results} rowId={(r) => r.result} maxHeight="20rem" /> : null}
			{data.errors.length ? <DataTable id="fleet-deploy-errors" label="Deploy errors" columns={DEPLOY_ERROR_COLUMNS} data={data.errors} rowId={(e) => e.error} maxHeight="20rem" /> : null}
			{data.reports?.length ? (
				<DataTable id="fleet-reports" label="Server reports" columns={REPORT_COLUMNS} data={data.reports} rowId={(r) => `${r.seq}-${r.job}-${r.at}`} defaultSort={[{ id: "at", desc: true }]} maxHeight="24rem" />
			) : null}
			<p className="text-xs text-muted-foreground">
				{data.behind.length ? `${data.behind.length} live server(s) still below #${data.seq}.` : "Every live server on the branch has it."}
				{data.stuck.length ? (
					<>
						{" "}
						Stuck (no report 3+ min after the deploy):{" "}
						{data.stuck.map((j, i) => (
							<span key={j}>
								{i > 0 ? ", " : ""}
								<JobLink job={j} />
							</span>
						))}
						.
					</>
				) : null}
			</p>
		</div>
	);
}

export const ALERT_COLUMNS: DataColumn<FleetAlert>[] = [
	{ id: "at", header: "When (UTC)", type: "date", accessor: (a) => a.at, cell: (a) => fmtTime(a.at), className: "font-mono text-xs tabular-nums" },
	{
		id: "level",
		header: "Level",
		type: "enum",
		order: ["critical", "warning", "info"],
		options: ["critical", "warning", "info"],
		accessor: (a) => a.level,
		cell: (a) => <Status tone={LEVEL_TONE[a.level]}>{a.level}</Status>,
	},
	{ id: "code", header: "Code", type: "enum", accessor: (a) => a.code, className: "font-mono text-xs" },
	{ id: "message", header: "Message", accessor: (a) => a.message, className: "max-w-96 whitespace-normal" },
	{
		id: "where",
		header: "Where",
		accessor: (a) => [a.branch, a.artifact, a.seq ? `#${a.seq}` : null].filter(Boolean).join(" · "),
		className: "text-xs text-muted-foreground",
	},
	{
		id: "job",
		header: "Job",
		accessor: (a) => a.job ?? null,
		// The CLI's alerts say j = "cli": not a server.
		cell: (a) => (a.job && a.job !== "cli" ? <JobLink job={a.job} /> : (a.job ?? "–")),
		className: "font-mono text-xs",
	},
	// Kernel 0.5.3: an alert followed by a debug bundle (d.bundle) opens it on the server's page.
	{
		id: "bundle",
		header: "Bundle",
		type: "boolean",
		accessor: (a) => alertBundle(a.details) !== undefined,
		cell: (a) => {
			const bundle = alertBundle(a.details);
			return a.job && a.job !== "cli" && bundle ? (
				<Link to={`/servers/${encodeURIComponent(a.job)}?bundle=${bundle}`} className="text-xs underline-offset-2 hover:underline">
					Open bundle
				</Link>
			) : null;
		},
		format: (_v, a) => (alertBundle(a.details) ? "bundle" : ""),
	},
	{ id: "branch", header: "Branch", type: "enum", accessor: (a) => a.branch ?? null, defaultHidden: true },
	{ id: "source", header: "Source", type: "enum", accessor: (a) => a.source ?? null, defaultHidden: true },
	{ id: "acked", header: "Acked", type: "boolean", accessor: (a) => a.acked, className: "text-xs" },
];

/** How long a gone server ran: start to close or loss. */
function ranFor(s: GoneServer): number | null {
	const start = s.startedAt ? new Date(s.startedAt).getTime() : Number.NaN;
	const end = new Date(s.closedAt ?? s.lostAt ?? s.lastSeen ?? "").getTime();
	return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

const goneAt = (s: GoneServer) => s.closedAt ?? s.lostAt ?? null;

export const GONE_COLUMNS: DataColumn<GoneServer>[] = [
	{ id: "job", header: "Job", accessor: (s) => s.job, cell: (s) => <JobLink job={s.job} />, className: "font-mono text-xs" },
	{ id: "state", header: "Ended", type: "enum", options: ["closed", "lost"], accessor: (s) => s.state },
	{ id: "goneAt", header: "When (UTC)", type: "date", accessor: goneAt, cell: (s) => fmtTime(goneAt(s)), className: "font-mono text-xs tabular-nums" },
	{ id: "ranFor", header: "Ran for", type: "number", accessor: ranFor, cell: (s) => (ranFor(s) === null ? "–" : fmtDuration(ranFor(s) as number)), className: "tabular-nums" },
	{ id: "branch", header: "Branch", type: "enum", accessor: (s) => s.branch },
	{ id: "artifact", header: "Artifact", type: "enum", accessor: (s) => s.artifact, className: "font-mono text-xs" },
	{ id: "health", header: "Last health", type: "enum", accessor: (s) => s.health ?? "unknown", className: "text-xs" },
	{ id: "players", header: "Players", accessor: (s) => s.players, defaultHidden: true },
	{ id: "kernel", header: "Kernel", type: "enum", accessor: (s) => s.kernel, className: "text-xs" },
	{ id: "lastError", header: "Last error", accessor: (s) => s.lastError, defaultHidden: true, className: "max-w-80 truncate text-xs" },
];

/** Plans/25 offline history: servers that closed or were lost (kept 30 days), so their pages stay reachable. */
function RecentlyGone({ servers }: { servers: GoneServer[] }) {
	return (
		<DataTable
			id="fleet-gone"
			label="Recently gone servers"
			columns={GONE_COLUMNS}
			data={servers}
			rowId={(s) => s.job}
			defaultSort={[{ id: "goneAt", desc: true }]}
			maxHeight="24rem"
			empty={<EmptyState>No server closed or was lost in the last 30 days.</EmptyState>}
		/>
	);
}

function Alerts({ alerts }: { alerts: FleetAlert[] }) {
	return (
		<DataTable
			id="fleet-alerts"
			label="Alerts"
			columns={ALERT_COLUMNS}
			data={alerts}
			rowId={(a) => String(a.id)}
			defaultSort={[{ id: "at", desc: true }]}
			empty={<EmptyState>No alerts.</EmptyState>}
		/>
	);
}

export default function Fleet() {
	const [branch, setBranch] = useParam("branch");
	const [text, setText] = useState(branch);
	useEffect(() => setText(branch), [branch]);
	const servers = useQuery({
		queryKey: ["fleet", "servers", branch],
		queryFn: ({ signal }) => api.fleetServers(branch || undefined, signal),
		refetchInterval: 30_000,
	});
	const report = useQuery({ queryKey: ["fleet", "report", branch], queryFn: ({ signal }) => api.fleetReport(branch ? { branch } : {}, signal) });
	const alerts = useQuery({ queryKey: ["fleet", "alerts"], queryFn: ({ signal }) => api.fleetAlerts({ limit: 100 }, signal) });
	const gone = useQuery({ queryKey: ["fleet", "gone", branch], queryFn: ({ signal }) => api.fleetGoneServers(branch || undefined, signal) });
	const stream = useFleetStream(branch);
	const streamTone =
		stream.state === "live" ? "bg-[var(--status-good)]" : stream.state === "retrying" ? "bg-[var(--status-critical)]" : "bg-[var(--status-warning)]";
	return (
		<>
			<PageHeader
				title="Fleet"
				description="Live game servers, the latest deploy and alerts, from the fleet API (updates over its event stream)."
				actions={
					<>
						<Input
							aria-label="Branch"
							placeholder="any branch"
							className="h-8 w-36"
							value={text}
							onChange={(e) => setText(e.target.value)}
							onBlur={() => setBranch(text.trim())}
							onKeyDown={(e) => e.key === "Enter" && setBranch(text.trim())}
						/>
						<Status tone={streamTone}>{stream.state === "live" ? "live" : stream.state === "retrying" ? "stream lost, retrying" : "connecting"}</Status>
					</>
				}
			/>
			<QueryState query={servers}>
				{(data) => (
					<>
						<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
							<Metric label="Live servers" value={fmtInt(data.servers.length)} />
							<Metric label="Players" value={fmtInt(data.players)} />
							<Metric
								label="Artifacts running"
								value={fmtInt(data.byArtifact.length)}
								sub={data.byArtifact.map((a) => `${a.artifact} (${a.servers})`).join(", ") || "none"}
							/>
							<Metric
								label="Health"
								value={
									Object.entries(data.byHealth)
										.map(([h, n]) => `${n} ${h}`)
										.join(", ") || "–"
								}
							/>
						</div>
						<Section title="Servers">
							<Servers data={data} />
						</Section>
					</>
				)}
			</QueryState>
			<div className="grid gap-4 xl:grid-cols-2">
				<Section
					title="Latest deploy"
					className="min-w-0"
					actions={
						<Link to="/deploys" className="text-xs underline-offset-2 hover:underline">
							All deploys
						</Link>
					}
				>
					<QueryState query={report}>{(data) => <Report data={data} />}</QueryState>
				</Section>
				<Section title="Live events" description="Changes pushed by the server since this page opened." className="min-w-0">
					{stream.log.length ? (
						<ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
							{stream.log.map((e, i) => (
								<li key={`${e.at}-${i}`} className="flex gap-2">
									<span className="font-mono text-muted-foreground tabular-nums">{fmtTime(e.at).slice(11)}</span>
									<span>{e.text}</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">Nothing yet. Server joins, leaves, deploy reports and alerts show up here as they happen.</p>
					)}
				</Section>
			</div>
			<Section title="Alerts" description="Newest first (kept 90 days). An alert with a debug bundle opens it on its server's page.">
				<QueryState query={alerts}>{(data) => <Alerts alerts={data} />}</QueryState>
			</Section>
			<Section title="Recently gone" description="Servers that closed or stopped sending heartbeats, the most recent first (kept 30 days): their pages show what happened.">
				<QueryState query={gone}>{(data) => <RecentlyGone servers={data} />}</QueryState>
			</Section>
		</>
	);
}
