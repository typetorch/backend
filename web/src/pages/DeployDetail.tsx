/**
 * One deploy (/deploys/<seq>, GET /v1/fleet/deploys/<seq>): who started it and how it went, its servers' reports while the
 * fleet keeps them (30 days; the counts stay on the history after that), the alerts that name its seq, and, where the
 * backend has them, the error logs and the key performance numbers over two equal windows before and after it.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link, useParams } from "react-router";
import { EmptyState, ErrorState, KeyValue, LoadingBlock, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { deployTitle, errorChanges, IMPACT_HOURS, impactWindows, startedByText, type DeployDetail as Detail, type DeployRecord, type ErrorChange } from "@/lib/deploys";
import { fmtAgo, fmtDuration, fmtInt, fmtTime } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import { OutcomeBadge } from "./Deploys";
import { ALERT_COLUMNS, Report } from "./Fleet";
import { CompareTable } from "./Performance";

const ERROR_LIMIT = 200;

/** "not on this backend" for a part that is off (404) or not ready (503), else the error. */
function Unavailable({ error, what }: { error: unknown; what: string }) {
	if (error instanceof ApiError && (error.notFound || error.status === 503)) return <EmptyState>{what} are not available on this backend.</EmptyState>;
	return <ErrorState error={error} title={`Could not load the ${what.toLowerCase()}`} />;
}

const SUMMARY_COLUMNS: DataColumn<{ result: string; servers: number }>[] = [
	{ id: "result", header: "Result", type: "enum", accessor: (r) => r.result, cell: (r) => <Badge variant={r.result === "failed" || r.result === "rolled_back" ? "destructive" : "secondary"}>{r.result}</Badge> },
	{ id: "servers", header: "Servers", type: "number", accessor: (r) => r.servers },
];

const KEPT_ERROR_COLUMNS: DataColumn<{ error: string; servers: number }>[] = [
	{ id: "error", header: "Error", accessor: (e) => e.error, className: "max-w-96 whitespace-normal text-[var(--status-critical)]" },
	{ id: "servers", header: "Servers", type: "number", accessor: (e) => e.servers },
];

/** A frozen release: the counts kept on the history (its per-server reports are gone). */
function KeptSummary({ deploy }: { deploy: DeployRecord }) {
	const results = Object.entries(deploy.results).map(([result, servers]) => ({ result, servers }));
	return (
		<div className="space-y-3">
			<p className="text-xs text-muted-foreground">The servers' own reports are kept 30 days; these counts were kept from them.</p>
			{results.length ? <DataTable id="deploy-kept-results" label="Deploy results" columns={SUMMARY_COLUMNS} data={results} rowId={(r) => r.result} /> : <EmptyState>No server reported this deploy.</EmptyState>}
			{deploy.errors.length ? <DataTable id="deploy-kept-errors" label="Deploy errors" columns={KEPT_ERROR_COLUMNS} data={deploy.errors} rowId={(e) => e.error} /> : null}
			{deploy.errorKinds > deploy.errors.length ? <p className="text-xs text-muted-foreground">{fmtInt(deploy.errorKinds - deploy.errors.length)} rarer errors not kept.</p> : null}
		</div>
	);
}

const CHANGE_COLUMNS: DataColumn<ErrorChange>[] = [
	{
		id: "template",
		header: "Error",
		accessor: (c) => c.template,
		cell: (c) => (
			<Link to={`/errors?fp=${encodeURIComponent(c.fp)}`} className="line-clamp-2 break-words font-mono text-xs underline-offset-2 hover:underline">
				{c.template}
			</Link>
		),
		className: "max-w-96 whitespace-normal",
	},
	{ id: "realm", header: "Side", type: "enum", accessor: (c) => c.realm, className: "text-xs" },
	{ id: "before", header: "Before", type: "number", accessor: (c) => c.before, cell: (c) => fmtInt(c.before), className: "tabular-nums" },
	{ id: "after", header: "After", type: "number", accessor: (c) => c.after, cell: (c) => fmtInt(c.after), className: "tabular-nums" },
	{ id: "isNew", header: "New", type: "boolean", accessor: (c) => c.isNew, cell: (c) => (c.isNew ? <Badge variant="destructive">new</Badge> : null), title: "Seen after the deploy and not in the window before it" },
];

function ErrorsAround({ windows, branch }: { windows: NonNullable<ReturnType<typeof impactWindows>>; branch: string | null }) {
	const params = (w: { from: number; to: number }) => ({ from: w.from, to: w.to, limit: ERROR_LIMIT, ...(branch ? { branch } : {}) });
	const before = useQuery({ queryKey: ["errors", "list", "deploy", params(windows.before)], queryFn: ({ signal }) => api.errors(params(windows.before), signal), retry: false });
	const after = useQuery({ queryKey: ["errors", "list", "deploy", params(windows.after)], queryFn: ({ signal }) => api.errors(params(windows.after), signal), retry: false });
	if (before.isPending || after.isPending) return <LoadingBlock rows={3} />;
	if (before.isError || after.isError) return <Unavailable error={before.error ?? after.error} what="Error logs" />;
	const changes = errorChanges(before.data, after.data);
	const fresh = changes.filter((c) => c.isNew).length;
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Errors before" value={fmtInt(before.data.totals.count)} sub={`${fmtInt(before.data.totals.kinds)} kinds`} />
				<Metric label="Errors after" value={fmtInt(after.data.totals.count)} sub={`${fmtInt(after.data.totals.kinds)} kinds`} />
				<Metric label="New kinds after" value={fmtInt(fresh)} />
				<Metric label="Players affected after" value={fmtInt(after.data.totals.players)} sub={`${fmtInt(before.data.totals.players)} before`} />
			</div>
			<DataTable id="deploy-error-changes" label="Error kinds before vs after" columns={CHANGE_COLUMNS} data={changes} rowId={(c) => c.fp} maxHeight="28rem" empty={<EmptyState>No errors in either window.</EmptyState>} />
		</div>
	);
}

function PerfAround({ at, hours, branch }: { at: number; hours: number; branch: string | null }) {
	const q = useAnalytics("perf-compare", { mode: "around", at, hours }, { filters: branch ? { branch } : {} });
	if (q.isPending) return <LoadingBlock rows={4} />;
	if (q.isError) return <Unavailable error={q.error} what="Performance numbers" />;
	return <CompareTable result={q.data} />;
}

function Impact({ deploy }: { deploy: DeployRecord }) {
	const [hoursParam, setHours] = useParam("hours", "24");
	const hours = IMPACT_HOURS.includes(Number(hoursParam)) ? Number(hoursParam) : 24;
	const windows = impactWindows(deploy.at, hours, Date.now());
	return (
		<Section
			title="Before vs after"
			description={
				windows
					? `Two equal windows of ${fmtDuration(windows.ms)} on each side of the deploy${deploy.branch ? `, branch ${deploy.branch} only` : ""}.`
					: "Wait at least 5 minutes after the deploy to compare."
			}
			actions={
				<Select value={String(hours)} onValueChange={setHours}>
					<SelectTrigger size="sm" className="w-32" aria-label="Window">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{IMPACT_HOURS.map((h) => (
							<SelectItem key={h} value={String(h)}>
								{h < 24 ? `${h} h` : `${h / 24} d`} each
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
		>
			{windows ? (
				<div className="space-y-6">
					<div className="space-y-2">
						<h3 className="text-sm font-medium">Errors</h3>
						<ErrorsAround windows={windows} branch={deploy.branch} />
					</div>
					<div className="space-y-2">
						<h3 className="text-sm font-medium">Performance</h3>
						<PerfAround at={deploy.at} hours={hours} branch={deploy.branch} />
					</div>
				</div>
			) : (
				<EmptyState>Too soon after the deploy to compare.</EmptyState>
			)}
		</Section>
	);
}

function Body({ data }: { data: Detail }) {
	const d = data.deploy;
	return (
		<>
			<PageHeader
				title={deployTitle(d)}
				description={`${d.artifact ?? "unknown build"}, started ${fmtAgo(d.at)} by ${startedByText(d)}.`}
				actions={
					<>
						<Button asChild variant="outline" size="sm">
							<Link to="/deploys">All deploys</Link>
						</Button>
						{data.previous ? (
							<Button asChild variant="outline" size="sm" title={`The deploy before on ${d.branch ?? "this branch"}`}>
								<Link to={`/deploys/${data.previous.seq}`}>
									<ChevronLeft />#{data.previous.seq}
								</Link>
							</Button>
						) : null}
						{data.next ? (
							<Button asChild variant="outline" size="sm" title={`The deploy after on ${d.branch ?? "this branch"}`}>
								<Link to={`/deploys/${data.next.seq}`}>
									#{data.next.seq}
									<ChevronRight />
								</Link>
							</Button>
						) : null}
					</>
				}
			/>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Outcome" value={<OutcomeBadge outcome={d.outcome} />} sub={`${fmtInt(d.reported)} servers reported`} />
				<Metric label="OK" value={fmtInt(d.ok)} sub="swapped or booted on it" />
				<Metric label="Failed" value={fmtInt(d.failed)} sub="failed or rolled back" />
				<Metric label="Stuck" value={fmtInt(d.stuck)} sub="no report after 3 minutes" />
			</div>
			<Section title="Release">
				<div className="flex flex-wrap gap-x-6 gap-y-1">
					<KeyValue label="started">{fmtTime(d.at)}</KeyValue>
					<KeyValue label="started by">{startedByText(d)}</KeyValue>
					<KeyValue label="kind">{d.kind}</KeyValue>
					<KeyValue label="branch">{d.branch ?? "–"}</KeyValue>
					<KeyValue label="channel">{d.channel ?? "–"}</KeyValue>
					<KeyValue label="artifact">
						<span className="font-mono text-xs">{d.artifact ?? "–"}</span>
					</KeyValue>
					{d.from ? (
						<KeyValue label="build before">
							<span className="font-mono text-xs">{d.from}</span>
						</KeyValue>
					) : null}
					<KeyValue label="first report">{fmtTime(d.firstReport)}</KeyValue>
					<KeyValue label="last report">{fmtTime(d.lastReport)}</KeyValue>
					{d.message ? <KeyValue label="note">{d.message}</KeyValue> : null}
				</div>
			</Section>
			<Section title="Server reports">{data.report ? <Report data={data.report} /> : <KeptSummary deploy={d} />}</Section>
			<Section title="Alerts" description="Alerts that name this deploy (failed swaps, stuck servers, automatic rollbacks).">
				<DataTable id="deploy-alerts" label="Alerts" columns={ALERT_COLUMNS} data={data.alerts} rowId={(a) => String(a.id)} defaultSort={[{ id: "at", desc: true }]} maxHeight="24rem" empty={<EmptyState>No alert names this deploy.</EmptyState>} />
			</Section>
			<Impact deploy={d} />
		</>
	);
}

export default function DeployDetailPage() {
	const { seq: seqParam } = useParams();
	const seq = Number(seqParam);
	const valid = Number.isSafeInteger(seq) && seq >= 0;
	const query = useQuery({ queryKey: ["fleet", "deploy", seq], queryFn: ({ signal }) => api.fleetDeploy(seq, signal), enabled: valid, retry: false, refetchInterval: 30_000 });
	if (!valid) return <EmptyState>No such deploy: the address needs a deploy number (/deploys/42).</EmptyState>;
	if (query.isError && query.error instanceof ApiError && query.error.notFound)
		return (
			<EmptyState>
				Deploy #{seq} is not in the history (it is older than the history keeps, or never reached this backend). <Link to="/deploys">All deploys</Link>
			</EmptyState>
		);
	return <QueryState query={query}>{(data) => <Body data={data} />}</QueryState>;
}
