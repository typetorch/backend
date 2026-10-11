/**
 * The player detail's Errors view: the error kinds this player hit under the page's range, branch and artifact (and a
 * side choice of its own, `realm` in the URL), most occurrences first. Each kind links to the Errors page with `?fp=`,
 * which opens that kind's side sheet, keeping the shared filters.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ErrorParams } from "@/lib/api";
import { api } from "@/lib/api";
import { FILTER_KEYS, type FilterState } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtTime } from "@/lib/format";
import { useFilters, useParam } from "@/lib/hooks";
import type { Filters, PlayerErrorKind } from "@/lib/types";

const DAY_MS = 86_400_000;
const ANY = "__any";

/** The error reads' window for the shared filters: from / to in unix ms (a `to` date is inclusive), branch and artifact. */
export function errorParamsFor(filters: Filters, realm: string): ErrorParams {
	const params: ErrorParams = {};
	const from = filters.from ? Date.parse(filters.from) : Number.NaN;
	if (Number.isFinite(from)) params.from = from;
	else params.window = "30d";
	const to = filters.to ? Date.parse(filters.to) : Number.NaN;
	if (Number.isFinite(to)) params.to = filters.to && filters.to.length === 10 ? to + DAY_MS : to;
	if (typeof filters.branch === "string" && filters.branch) params.branch = filters.branch;
	if (typeof filters.art === "string" && filters.art) params.build = filters.art;
	if (realm) params.realm = realm;
	return params;
}

/** The Errors page's own window choice closest to the shared range (that page offers 1h to 30d). */
function errorsWindow(state: FilterState): string {
	switch (state.range) {
		case "1h":
		case "6h":
		case "7d":
			return state.range;
		case "1d":
			return "24h";
		default:
			return "30d";
	}
}

/** /errors?fp=..., with the shared filters in the URL and the Errors page's own window, branch, artifact and side. */
export function errorsPageSearch(fp: string, current: URLSearchParams, state: FilterState, realm: string): string {
	const params = new URLSearchParams();
	for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
	params.set("window", errorsWindow(state));
	if (state.branch) params.set("branch", state.branch);
	if (state.art) params.set("build", state.art);
	if (realm) params.set("realm", realm);
	params.set("fp", fp);
	return `?${params.toString()}`;
}

function ErrorLink({ kind, realm }: { kind: PlayerErrorKind; realm: string }) {
	const { search } = useLocation();
	const { state } = useFilters();
	return (
		<Link
			to={{ pathname: "/errors", search: errorsPageSearch(kind.fp, new URLSearchParams(search), state, realm) }}
			className="break-words font-mono text-xs underline-offset-2 hover:underline"
			title="Open this error on the Errors page"
		>
			{kind.template}
		</Link>
	);
}

function columns(realm: string): DataColumn<PlayerErrorKind>[] {
	return [
		{
			id: "error",
			header: "Error",
			accessor: (k) => k.template,
			searchText: (k) => `${k.topFrame ?? ""} ${k.fp}`,
			cell: (k) => (
				<>
					<ErrorLink kind={k} realm={realm} />
					{k.topFrame ? <div className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">{k.topFrame}</div> : null}
				</>
			),
			className: "max-w-[28rem] whitespace-normal",
		},
		{
			id: "side",
			header: "Where",
			accessor: (k) => k.realms.join(", "),
			cell: (k) => (
				<div className="flex flex-wrap gap-1">
					{k.realms.map((r) => (
						<Badge key={r} variant={r === "server" ? "secondary" : "outline"}>
							{r}
						</Badge>
					))}
				</div>
			),
		},
		{ id: "count", header: "Times", title: "Occurrences in the reports that named this player (a report is one minute of one server)", accessor: (k) => k.count, cell: (k) => fmtInt(k.count) },
		{ id: "days", header: "Days", title: "UTC days they hit it in the window", accessor: (k) => k.days, cell: (k) => fmtInt(k.days), defaultHidden: true },
		{ id: "firstAt", header: "First seen", type: "date", accessor: (k) => k.firstAt, cell: (k) => <span title={fmtTime(k.firstAt)}>{fmtAgo(k.firstAt)}</span>, format: (_v, k) => fmtAgo(k.firstAt), className: "text-xs" },
		{ id: "lastAt", header: "Last seen", type: "date", accessor: (k) => k.lastAt, cell: (k) => <span title={fmtTime(k.lastAt)}>{fmtAgo(k.lastAt)}</span>, format: (_v, k) => fmtAgo(k.lastAt), className: "text-xs" },
		{ id: "total", header: "All time", title: "Every report of this kind, every player, not only this window", accessor: (k) => k.total, cell: (k) => fmtInt(k.total) },
		{ id: "fp", header: "Fingerprint", accessor: (k) => k.fp, defaultHidden: true, className: "font-mono text-xs" },
	];
}

export function ErrorsView({ pid }: { pid: string }) {
	const { apiFilters } = useFilters();
	const [realm, setRealm] = useParam("realm");
	const side = realm === "server" || realm === "client" ? realm : "";
	const params = errorParamsFor(apiFilters, side);
	const query = useQuery({ queryKey: ["errors", "player", pid, params], queryFn: ({ signal }) => api.playerErrors(pid, params, signal), refetchInterval: 30_000 });
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">Error kinds this player hit, most often first.</p>
				<Select value={side || ANY} onValueChange={(v) => setRealm(v === ANY ? "" : v)}>
					<SelectTrigger className="h-8 w-40" aria-label="Server or client">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ANY}>Server + client</SelectItem>
						<SelectItem value="server">Server</SelectItem>
						<SelectItem value="client">Client</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<QueryState query={query} loadingRows={3}>
				{(d) => {
					if (!d.errors.length) return <EmptyState>No errors from this player in this range.</EmptyState>;
					return (
						<div className="space-y-2">
							<DataTable id="player-errors" label="Errors this player hit" columns={columns(side)} data={d.errors} rowId={(k) => k.fp} defaultSort={[{ id: "count", desc: true }]} maxHeight="28rem" />
							<p className="text-xs text-muted-foreground">
								{d.more ? `The ${fmtInt(d.errors.length)} kinds they hit most, of ${fmtInt(d.total)}. ` : ""}
								Times counts the occurrences in each minute's report that named the player, so players who hit it in the same minute on one server share that report. Error logs go back as far as the server keeps them (30 days by default).
							</p>
						</div>
					);
				}}
			</QueryState>
		</div>
	);
}
