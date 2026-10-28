/**
 * The Query page: a named query with JSON options, or read-only SQL. SQL can be saved (server-side, for everyone signed
 * in): pick one to load and run it (`?saved=<id>`), and owners save, rename, chart, pin to the Overview and delete them.
 * The read-only web role lists and runs saved queries; its own edits stay in the page.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, Play, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorState, JsonBlock, PageHeader, Section } from "@/components/common";
import { ResultChart, ResultTable, sqlColumns } from "@/components/SavedQueryView";
import { ToggleChip } from "@/components/ToggleChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { fmtInt, fmtTime } from "@/lib/format";
import { useFilters, useParam } from "@/lib/hooks";
import { SAVED_QUERY_CHARTS, type SavedQuery, type SavedQueryChart, type SqlResult } from "@/lib/types";

export { sqlColumns };

/** Ctrl/Cmd+Enter runs. */
const runKey = (run: () => void) => (e: React.KeyboardEvent) => {
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		run();
	}
};

function parseJson(text: string, what: string): object {
	if (!text.trim()) return {};
	try {
		const value = JSON.parse(text) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value;
	} catch (error) {
		throw new Error(`${what} is not a JSON object: ${(error as Error).message}`);
	}
}

function NamedQuery() {
	const { apiFilters } = useFilters();
	const list = useQuery({ queryKey: ["queries"], queryFn: ({ signal }) => api.queries(signal), staleTime: Infinity });
	const [name, setName] = useParam("q", "overview");
	const [filters, setFilters] = useState(() => JSON.stringify(apiFilters, null, 2));
	const [options, setOptions] = useState("{}");
	useEffect(() => setFilters(JSON.stringify(apiFilters, null, 2)), [apiFilters]);
	const run = useMutation({ mutationFn: () => api.raw(name, { filters: parseJson(filters, "filters"), options: parseJson(options, "options") }) });
	const info = list.data?.find((q) => q.name === name);
	const go = () => run.mutate();
	return (
		<div className="space-y-4">
			<Section
				title="Named query"
				description={info ? `${info.summary} (default range ${info.defaultDays} days)` : "POST /v1/query/<name> with { filters, options }"}
				actions={
					<Button size="sm" onClick={go} disabled={run.isPending}>
						<Play />
						Run
					</Button>
				}
				contentClassName="space-y-3"
			>
				<Select value={name} onValueChange={setName}>
					<SelectTrigger size="sm" className="w-56" aria-label="Query">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(list.data ?? [{ name, summary: "", defaultDays: 0 }]).map((q) => (
							<SelectItem key={q.name} value={q.name}>
								{q.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="grid gap-3 lg:grid-cols-2">
					<Label className="flex-col items-stretch gap-1 text-xs text-muted-foreground">
						filters (from the filter bar; edit freely)
						<Textarea
							className="h-40 font-mono text-xs"
							value={filters}
							onChange={(e) => setFilters(e.target.value)}
							onKeyDown={runKey(go)}
							spellCheck={false}
						/>
					</Label>
					<Label className="flex-col items-stretch gap-1 text-xs text-muted-foreground">
						options, e.g. {`{ "pid": "..." }`} or {`{ "facet": "zone" }`}
						<Textarea
							className="h-40 font-mono text-xs"
							value={options}
							onChange={(e) => setOptions(e.target.value)}
							onKeyDown={runKey(go)}
							spellCheck={false}
						/>
					</Label>
				</div>
			</Section>
			{run.isError ? <ErrorState error={run.error} title="Query failed" /> : null}
			{run.data ? (
				<Section title="Result" description={`${run.data.ms} ms on the server`}>
					<JsonBlock value={run.data.result} />
				</Section>
			) : null}
		</div>
	);
}

const SAMPLE = `SELECT kind, name, COUNT(*) AS n, COUNT(DISTINCT pid) AS players
FROM events
WHERE t >= epoch_ms(now() - INTERVAL 7 DAY)
GROUP BY kind, name
ORDER BY n DESC`;

const CHART_LABELS: Record<SavedQueryChart, string> = { table: "Table", bar: "Bar chart", line: "Line chart" };
const NEW = "__new";

function SqlResultView({ data, chart }: { data: SqlResult; chart: SavedQueryChart | null }) {
	return (
		<Section
			title={`${fmtInt(data.rows.length)} row${data.rows.length === 1 ? "" : "s"}${data.truncated ? " (more exist: raise the limit or narrow the query)" : ""}`}
			description={`${data.ms} ms on the server`}
			contentClassName="space-y-4"
		>
			{chart && chart !== "table" ? <ResultChart result={data} chart={chart} /> : null}
			<ResultTable result={data} id="query-sql" />
		</Section>
	);
}

/** The form state of the saved-query bar: what would be saved. */
interface Draft {
	name: string;
	chart: SavedQueryChart | null;
	pinned: boolean;
}

const draftOf = (q: SavedQuery | undefined): Draft => ({ name: q?.name ?? "", chart: q?.chart ?? null, pinned: q?.pinned ?? false });

/** Whether the editor differs from the saved query (the Save button's state). */
export function isDirty(saved: SavedQuery | undefined, sql: string, draft: Draft): boolean {
	if (!saved) return true;
	return saved.sql.trim() !== sql.trim().replace(/;\s*$/, "").trimEnd() || saved.name !== draft.name.trim() || saved.chart !== draft.chart || saved.pinned !== draft.pinned;
}

function SavedBar({
	list,
	selected,
	onPick,
	draft,
	setDraft,
	sql,
	readOnly,
}: {
	list: SavedQuery[] | undefined;
	selected: SavedQuery | undefined;
	onPick(id: string): void;
	draft: Draft;
	setDraft(d: Draft): void;
	sql: string;
	readOnly: boolean;
}) {
	const client = useQueryClient();
	const [confirmDelete, setConfirmDelete] = useState(false);
	useEffect(() => setConfirmDelete(false), [selected?.id]);
	const done = (q?: SavedQuery) => {
		void client.invalidateQueries({ queryKey: ["saved-queries"] });
		if (q) onPick(String(q.id));
	};
	const fields = { name: draft.name.trim(), sql, chart: draft.chart, pinned: draft.pinned };
	const save = useMutation({ mutationFn: () => (selected ? api.updateSavedQuery(selected.id, fields) : api.createSavedQuery(fields)), onSuccess: (q) => done(q) });
	const saveNew = useMutation({ mutationFn: () => api.createSavedQuery(fields), onSuccess: (q) => done(q) });
	const remove = useMutation({
		mutationFn: () => api.deleteSavedQuery((selected as SavedQuery).id),
		onSuccess: () => {
			onPick("");
			done();
		},
	});
	const failed = save.error ?? saveNew.error ?? remove.error;
	const busy = save.isPending || saveNew.isPending || remove.isPending;
	const named = draft.name.trim().length > 0;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<Select value={selected ? String(selected.id) : NEW} onValueChange={(v) => onPick(v === NEW ? "" : v)}>
					<SelectTrigger size="sm" className="w-56" aria-label="Saved query">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NEW}>{readOnly ? "Saved queries..." : "New query"}</SelectItem>
						{(list ?? []).map((q) => (
							<SelectItem key={q.id} value={String(q.id)}>
								{q.name}
								{q.pinned ? " (pinned)" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={draft.chart ?? "table"} onValueChange={(v) => setDraft({ ...draft, chart: v === "table" ? null : (v as SavedQueryChart) })}>
					<SelectTrigger size="sm" className="w-36" aria-label="Show as">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{SAVED_QUERY_CHARTS.map((c) => (
							<SelectItem key={c} value={c}>
								{CHART_LABELS[c]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{readOnly ? null : (
					<>
						<Input aria-label="Name" placeholder="Name to save it under" className="h-8 w-56" maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
						<ToggleChip pressed={draft.pinned} onClick={() => setDraft({ ...draft, pinned: !draft.pinned })} title="Show it as a tile on the Overview">
							<Pin data-icon="inline-start" />
							Pin to Overview
						</ToggleChip>
						<Button size="sm" variant="outline" disabled={busy || !named || !isDirty(selected, sql, draft)} onClick={() => save.mutate()}>
							<Save />
							{selected ? "Save" : "Save query"}
						</Button>
						{selected ? (
							<>
								<Button size="sm" variant="outline" disabled={busy || !named || draft.name.trim().toLowerCase() === selected.name.toLowerCase()} onClick={() => saveNew.mutate()} title="Save a copy under the new name">
									Save as new
								</Button>
								<Button size="sm" variant={confirmDelete ? "destructive" : "ghost"} disabled={busy} onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}>
									<Trash2 />
									{confirmDelete ? "Delete for everyone?" : "Delete"}
								</Button>
							</>
						) : null}
					</>
				)}
			</div>
			{selected ? (
				<p className="text-xs text-muted-foreground">
					Saved by {selected.createdBy} {fmtTime(selected.createdAt)}
					{selected.updatedAt !== selected.createdAt ? `, changed by ${selected.updatedBy} ${fmtTime(selected.updatedAt)}` : ""}.{readOnly ? " Read-only: your edits stay on this page." : ""}
				</p>
			) : null}
			{failed ? <ErrorState error={failed} title="Could not save" /> : null}
		</div>
	);
}

function AdHocSql() {
	const readOnly = isReadOnly(useAuth());
	const [savedParam, setSaved] = useParam("saved");
	const list = useQuery({ queryKey: ["saved-queries"], queryFn: ({ signal }) => api.savedQueries(signal), retry: false, staleTime: 30_000 });
	const selected = list.data?.find((q) => String(q.id) === savedParam);
	const [sql, setSql] = useState(SAMPLE);
	const [draft, setDraft] = useState<Draft>(draftOf(undefined));
	const [limit, setLimit] = useState(1000);
	const run = useMutation({ mutationFn: (text: string) => api.sql(text, limit) });
	const go = () => run.mutate(sql);
	// Picking a saved query (or opening its link) loads it into the editor and runs it, once per pick.
	const loaded = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!selected || loaded.current === selected.id) return;
		loaded.current = selected.id;
		setSql(selected.sql);
		setDraft(draftOf(selected));
		run.mutate(selected.sql);
	}, [selected, run]);
	const pick = (id: string) => {
		if (!id) {
			loaded.current = undefined;
			setDraft(draftOf(undefined));
		}
		setSaved(id);
	};
	return (
		<div className="space-y-4">
			<Section
				title="SQL (read-only)"
				description="One SELECT or WITH over the views events and recordings (DuckDB SQL; t is unix ms; props and exp are JSON text). Fleet rows show no props."
				actions={
					<>
						<Label className="text-xs text-muted-foreground">
							Limit
							<Input
								type="number"
								min={1}
								max={10000}
								className="h-8 w-24"
								value={limit}
								onChange={(e) => setLimit(Math.min(10_000, Math.max(1, Number(e.target.value) || 1000)))}
							/>
						</Label>
						<Button size="sm" onClick={go} disabled={run.isPending}>
							<Play />
							Run
						</Button>
					</>
				}
			>
				<div className="mb-3">
					<SavedBar list={list.data} selected={selected} onPick={pick} draft={draft} setDraft={setDraft} sql={sql} readOnly={readOnly} />
				</div>
				<Textarea
					className="h-48 font-mono text-xs"
					value={sql}
					onChange={(e) => setSql(e.target.value)}
					onKeyDown={runKey(go)}
					spellCheck={false}
					aria-label="SQL"
				/>
				<p className="mt-2 text-xs text-muted-foreground">
					Ctrl+Enter runs. Columns: t, kind, name, pid, sid, job, srv, place, art, seq, branch, channel, dev, newp, state, exp, sexp, src, props, rt.
				</p>
			</Section>
			{run.isError ? <ErrorState error={run.error} title="Query failed" /> : null}
			{run.data ? <SqlResultView data={run.data} chart={draft.chart} /> : null}
		</div>
	);
}

export default function Query() {
	const [tab, setTab] = useParam("tab", "named");
	return (
		<>
			<PageHeader title="Query" description="Run any named query with JSON options, or read-only SQL, and see the raw answer." />
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="named">Named query</TabsTrigger>
					<TabsTrigger value="sql">SQL</TabsTrigger>
				</TabsList>
				<TabsContent value="named" className="pt-2">
					<NamedQuery />
				</TabsContent>
				<TabsContent value="sql" className="pt-2">
					<AdHocSql />
				</TabsContent>
			</Tabs>
		</>
	);
}
