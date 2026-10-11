/**
 * Experiments: per-variant numbers and how sure each difference is, and every experiment with its state and weights
 * (read-only, from the overrides the server knows). A row of the experiments list or of the variants table (click, or
 * Enter / Space) opens the players in it in a side sheet (`?assigned=<experiment>&assignedVariant=`, shareable), under
 * the filter bar's range and filters, each linking to their Players page.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { UserIdLink } from "@/components/Identity";
import { PlayerPageLink } from "@/components/PlayerLink";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { describeRange } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtNum, fmtPct, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { ExperimentOverride, ExperimentOverrides, ExperimentPlayer, ExperimentResult } from "@/lib/types";

type Results = Extract<ExperimentResult, { variants: unknown }>;
type Variant = Results["variants"][number];
type Comparison = Results["comparisons"][number];
type ListItem = Extract<ExperimentResult, { experiment: null }>["experiments"][number];

const METRICS: Record<string, string> = {
	returned: "came back (2+ days)",
	payers: "paid",
	playtime: "playtime per player",
	robux: "Robux per player",
	sessions: "sessions per player",
};

function fmtMetric(metric: string, value: number): string {
	if (metric === "returned" || metric === "payers") return fmtPct(value);
	if (metric === "playtime") return `${fmtNum(value, 1)} min`;
	return fmtNum(value);
}

/** A rate shown as "12.5% (30)": it sorts and filters by the rate, in percent. */
const rateColumn = (id: string, header: string, pick: (v: Variant) => { rate: number; count: number }): DataColumn<Variant> => ({
	id,
	header,
	accessor: (v) => pick(v).rate * 100,
	cell: (v) => (
		<>
			{fmtPct(pick(v).rate)} <span className="text-muted-foreground">({fmtInt(pick(v).count)})</span>
		</>
	),
	format: (_value, v) => `${fmtPct(pick(v).rate)} (${fmtInt(pick(v).count)})`,
});

const variantColumns = (control: string | null): DataColumn<Variant>[] => [
	{
		id: "variant",
		header: "Variant",
		accessor: (v) => v.variant,
		cell: (v) => (
			<>
				{v.variant} {v.variant === control ? <Badge variant="secondary">control</Badge> : null}
			</>
		),
		className: "font-medium",
	},
	{ id: "players", header: "Players", accessor: (v) => v.players, cell: (v) => fmtInt(v.players) },
	rateColumn("returned", "Came back", (v) => v.returned),
	rateColumn("payers", "Paid", (v) => v.payers),
	{ id: "playtime", header: "Playtime / player", hint: "min", accessor: (v) => v.playtimeMinutes, cell: (v) => `${fmtNum(v.playtimeMinutes, 1)} min` },
	{ id: "robux", header: "Robux / player", accessor: (v) => v.robuxPerPlayer, cell: (v) => fmtNum(v.robuxPerPlayer) },
	{ id: "sessions", header: "Sessions / player", accessor: (v) => v.sessionsPerPlayer, cell: (v) => fmtNum(v.sessionsPerPlayer) },
];

const COMPARISON_COLUMNS: DataColumn<Comparison>[] = [
	{ id: "words", header: "In words", accessor: (c) => c.words, className: "font-medium whitespace-normal" },
	{ id: "metric", header: "Metric", type: "enum", accessor: (c) => c.metric, format: (v) => METRICS[v as string] ?? String(v), cell: (c) => METRICS[c.metric] ?? c.metric, className: "text-muted-foreground" },
	{ id: "control", header: "Control", accessor: (c) => c.control, cell: (c) => fmtMetric(c.metric, c.control), format: (_v, c) => fmtMetric(c.metric, c.control) },
	{ id: "value", header: "Variant", accessor: (c) => c.value, cell: (c) => fmtMetric(c.metric, c.value), format: (_v, c) => fmtMetric(c.metric, c.value) },
	{
		id: "lift",
		header: "Lift",
		accessor: (c) => c.lift,
		cell: (c) => (c.lift === null ? "–" : `${c.lift > 0 ? "+" : ""}${fmtPct(c.lift)}`),
		format: (_v, c) => (c.lift === null ? "" : `${c.lift > 0 ? "+" : ""}${fmtPct(c.lift)}`),
	},
	{ id: "sure", header: "Sure", accessor: (c) => c.sure, cell: (c) => <span title={c.method}>{fmtPct(c.sure, 0)}</span>, format: (_v, c) => fmtPct(c.sure, 0) },
];

/** The side sheet's URL state: `assigned` (the experiment) and `assignedVariant`, set together. */
function useAssigned(): { experiment: string; variant: string; open(experiment: string, variant?: string): void; setVariant(variant: string): void; close(): void } {
	const [params, setParams] = useSearchParams();
	const experiment = params.get("assigned") ?? "";
	const variant = params.get("assignedVariant") ?? "";
	const write = useCallback(
		(next: { experiment?: string; variant?: string }) =>
			setParams((current) => {
				const copy = new URLSearchParams(current);
				for (const [key, value] of [
					["assigned", next.experiment],
					["assignedVariant", next.variant],
				] as const) {
					if (value === undefined) continue;
					if (value) copy.set(key, value);
					else copy.delete(key);
				}
				return copy;
			}),
		[setParams],
	);
	return {
		experiment,
		variant,
		open: (e, v = "") => write({ experiment: e, variant: v }),
		setVariant: (v) => write({ variant: v }),
		close: () => write({ experiment: "", variant: "" }),
	};
}

function ResultsView({ data, onOpenVariant, selectedVariant }: { data: Results; onOpenVariant?: (variant: string) => void; selectedVariant?: string }) {
	const variants = useMemo(() => variantColumns(data.control), [data.control]);
	if (!data.variants.length) return <EmptyState>No player in this experiment in this range.</EmptyState>;
	return (
		<>
			<Section
				title={data.scope === "server" ? "Per server: pinned artifacts vs unpinned servers" : `Variants of ${data.experiment}`}
				description={`${data.control ? `Compared with the control variant "${data.control}".` : "No control variant."}${data.mixedPlayers ? ` ${plural(data.mixedPlayers, "player")} seen in more than one variant are left out.` : ""}${onOpenVariant ? " Open a variant for its players." : ""}`}
			>
				<DataTable
					id="experiment-variants"
					label="Variants"
					columns={variants}
					data={data.variants}
					rowId={(v) => v.variant}
					{...(onOpenVariant
						? {
								onRowClick: (v: Variant) => onOpenVariant(v.variant),
								rowActionLabel: (v: Variant) => `Open players in variant ${v.variant} of ${data.experiment}`,
								isRowSelected: (v: Variant) => selectedVariant === v.variant,
							}
						: {})}
				/>
			</Section>
			<Section title="How sure" description="Each variant against the control: two-proportion test for shares, bootstrap (or Welch) for averages.">
				{data.comparisons.length ? (
					<DataTable id="experiment-comparisons" label="Comparisons with the control" columns={COMPARISON_COLUMNS} data={data.comparisons} rowId={(c) => `${c.variant}-${c.metric}`} />
				) : (
					<p className="text-sm text-muted-foreground">Nothing to compare yet: it needs a control and at least one other variant with players.</p>
				)}
			</Section>
		</>
	);
}

// Experiments list: state and weights --------------------------------------------------------------------------------

export type ExperimentState = "running" | "settled" | "stopped";

/** What the page says about one experiment's split: its state, the shares per variant, and a plain note. */
export interface WeightView {
	state: ExperimentState;
	/** The variant everyone gets when settled. */
	settledOn?: string;
	/** Shares (0-1) per variant; empty when the backend doesn't know enough to say. */
	shares: { label: string; share: number }[];
	note: string;
}

/**
 * The split of one experiment, from its override (if the server knows one), the number of variants the game declares
 * (from the experiment rows) and the variant names seen. Override weights are in the game's order, which only the game
 * knows (the first is the control), so they are labelled by position; an even split can use the names.
 */
export function weightView(override: ExperimentOverride | undefined, source: ExperimentOverrides["source"] | undefined, variantCount: number | null, names: string[]): WeightView {
	const count = variantCount ?? (names.length || null);
	const positional = (i: number) => `variant ${i + 1}${i === 0 ? " (control)" : ""}`;
	const even = (why: string): WeightView => {
		if (!count) return { state: "running", shares: [], note: `${why} The backend doesn't know this experiment's variants, so it can't show the split.` };
		const labels = names.length === count ? [...names].sort() : Array.from({ length: count }, (_, i) => positional(i));
		return { state: "running", shares: labels.map((label) => ({ label, share: 1 / count })), note: `${why} The game splits players evenly over its ${count} variants.` };
	};
	if (!override) {
		const why =
			source === "unreadable"
				? "The server's settings file can't be read, so overrides are unknown."
				: "No override on this server: the game's default weights apply.";
		return even(why);
	}
	if (override.active === false) {
		return { state: "stopped", shares: [{ label: "variant 1 (control)", share: 1 }], note: "Stopped: everyone gets the first variant (the control), and events are not stamped." };
	}
	if (override.variant) {
		return { state: "settled", settledOn: override.variant, shares: [{ label: override.variant, share: 1 }], note: `Settled: everyone gets ${override.variant}.` };
	}
	const weights = override.weights;
	if (weights && weights.length) {
		const total = weights.reduce((s, w) => s + w, 0);
		if (count !== null && weights.length !== count) return even(`The override's ${weights.length} weights don't fit the ${count} variants, so the game ignores them.`);
		if (total > 0) return { state: "running", shares: weights.map((w, i) => ({ label: positional(i), share: w / total })), note: "Weights from the override, in the game's variant order." };
	}
	return even("The override sets no weights.");
}

/** One row of the experiments list: an experiment, its variants and the players with an assignment row in the range. */
export interface ExperimentRow {
	experiment: string;
	variants: string[];
	players: number;
	forced: number;
	variantCount: number | null;
	weights: WeightView;
}

export function experimentRows(list: ListItem[], overrides?: ExperimentOverrides): ExperimentRow[] {
	const by = new Map<string, Omit<ExperimentRow, "weights">>();
	for (const e of list) {
		const row = by.get(e.experiment) ?? { experiment: e.experiment, variants: [], players: 0, forced: 0, variantCount: null };
		if (e.variant && !row.variants.includes(e.variant)) row.variants.push(e.variant);
		row.players += e.players;
		row.forced += e.forced ?? 0;
		if (typeof e.variantCount === "number") row.variantCount = Math.max(row.variantCount ?? 0, e.variantCount);
		by.set(e.experiment, row);
	}
	return [...by.values()].map((r) => ({ ...r, weights: weightView(overrides?.experiments[r.experiment], overrides?.source, r.variantCount, r.variants) }));
}

const STATE_BADGE: Record<ExperimentState, "outline" | "secondary" | "default"> = { running: "outline", settled: "default", stopped: "secondary" };

/** Shares as a short list with a small bar each. */
function Weights({ view }: { view: WeightView }) {
	if (!view.shares.length) return <span className="text-xs text-muted-foreground">unknown</span>;
	return (
		<ul className="min-w-40 space-y-1" title={view.note}>
			{view.shares.map((s) => (
				<li key={s.label} className="text-xs">
					<div className="flex items-baseline justify-between gap-2">
						<span className="truncate">{s.label}</span>
						<span className="tabular-nums text-muted-foreground">{fmtPct(s.share, 0)}</span>
					</div>
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${s.label}: ${fmtPct(s.share, 0)}`}>
						<div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(s.share * 100)}%` }} />
					</div>
				</li>
			))}
		</ul>
	);
}

const EXPERIMENT_COLUMNS: DataColumn<ExperimentRow>[] = [
	{ id: "experiment", header: "Experiment", accessor: (e) => e.experiment, className: "font-medium" },
	{
		id: "state",
		header: "State",
		type: "enum",
		accessor: (e) => e.weights.state,
		cell: (e) => (
			<Badge variant={STATE_BADGE[e.weights.state]} title={e.weights.note}>
				{e.weights.state === "settled" ? `settled on ${e.weights.settledOn}` : e.weights.state}
			</Badge>
		),
	},
	{
		id: "weights",
		header: "Weights",
		accessor: (e) => e.weights.shares.map((s) => `${s.label} ${fmtPct(s.share, 0)}`).join(", "),
		cell: (e) => (
			<div className="space-y-1">
				<Weights view={e.weights} />
				<div className="max-w-56 whitespace-normal text-[11px] text-muted-foreground">{e.weights.note}</div>
			</div>
		),
		searchable: false,
	},
	{ id: "variants", header: "Variants seen", accessor: (e) => e.variants.join(", "), className: "text-muted-foreground" },
	{ id: "players", header: "Assigned", title: "Players with an assignment row in the range, per variant (a player in two variants counts twice)", accessor: (e) => e.players, cell: (e) => fmtInt(e.players) },
	{ id: "forced", header: "Forced", title: "Players whose variant the settings forced, in the range", accessor: (e) => e.forced, cell: (e) => fmtInt(e.forced) },
];

// The players in one experiment (side sheet) -------------------------------------------------------------------------

const HOW: Record<ExperimentPlayer["how"], { label: string; title: string; variant: "secondary" | "outline" | "default" }> = {
	random: { label: "random", title: "Assigned by the hash of their analytics id (and the weights)", variant: "outline" },
	forced: { label: "forced", title: "The settings forced the variant (for everyone, or for this player)", variant: "default" },
	unknown: { label: "before range", title: "Assigned before the range: only their stamped events are in it", variant: "secondary" },
};

const ASSIGNED_COLUMNS: DataColumn<ExperimentPlayer>[] = [
	{
		id: "player",
		header: "Player",
		accessor: (p) => p.name ?? p.pid,
		searchText: (p) => `${p.pid} ${p.displayName ?? ""} ${p.uid ?? ""}`,
		cell: (p) => (
			<div className="min-w-0">
				<PlayerPageLink row={p} />
				{p.name ? <div className="truncate font-mono text-[11px] text-muted-foreground">{shortId(p.pid, 10)}</div> : null}
			</div>
		),
	},
	{
		id: "uid",
		header: "UserId",
		accessor: (p) => p.uid ?? null,
		cell: (p) => (p.uid === undefined ? <span className="text-xs text-muted-foreground">not linked</span> : <UserIdLink uid={p.uid} className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline" />),
		exportValue: (p) => (p.uid !== undefined ? String(p.uid) : ""),
	},
	{
		id: "variant",
		header: "Variant",
		type: "enum",
		accessor: (p) => p.variant,
		cell: (p) => (
			<span className="inline-flex flex-wrap items-center gap-1">
				{p.variant}
				{p.mixed ? (
					<Badge variant="secondary" title="Seen in more than one variant in the range">
						mixed
					</Badge>
				) : null}
			</span>
		),
	},
	{
		id: "how",
		header: "How",
		type: "enum",
		accessor: (p) => HOW[p.how].label,
		cell: (p) => (
			<Badge variant={HOW[p.how].variant} title={HOW[p.how].title}>
				{HOW[p.how].label}
			</Badge>
		),
	},
	{
		id: "assignedAt",
		header: "Assigned",
		type: "date",
		accessor: (p) => p.assignedAt ?? p.firstAt,
		cell: (p) => <span title={fmtTime(p.assignedAt ?? p.firstAt)}>{p.assignedAt ? fmtAgo(p.assignedAt) : `seen ${fmtAgo(p.firstAt)}`}</span>,
		format: (_v, p) => (p.assignedAt ? fmtAgo(p.assignedAt) : `seen ${fmtAgo(p.firstAt)}`),
		className: "text-xs",
	},
	{ id: "lastAt", header: "Last seen", type: "date", accessor: (p) => p.lastAt, cell: (p) => <span title={fmtTime(p.lastAt)}>{fmtAgo(p.lastAt)}</span>, format: (_v, p) => fmtAgo(p.lastAt), className: "text-xs" },
	{ id: "firstAt", header: "First seen", type: "date", accessor: (p) => p.firstAt, cell: (p) => <span title={fmtTime(p.firstAt)}>{fmtAgo(p.firstAt)}</span>, format: (_v, p) => fmtAgo(p.firstAt), className: "text-xs", defaultHidden: true },
	{ id: "events", header: "Events", title: "Their events in the range stamped with this variant", accessor: (p) => p.events, cell: (p) => fmtInt(p.events), defaultHidden: true },
];

const ALL = "__all";

/** The players in one experiment (one variant or all), under the filter bar's range and filters: at most 200, most recently seen first. */
function AssignedPlayers({ experiment, variant, onVariant }: { experiment: string; variant: string; onVariant(variant: string): void }) {
	const { apiFilters } = useFilters();
	const query = useQuery({
		queryKey: ["experiment-players", experiment, apiFilters, variant],
		queryFn: ({ signal }) => api.experimentPlayers(experiment, apiFilters, variant ? { variant } : {}, signal),
	});
	return (
		<QueryState query={query} loadingRows={3}>
			{(d) => (
				<div className="space-y-3">
					{d.variants.length ? (
						<ToggleGroup type="single" variant="outline" size="sm" value={variant || ALL} onValueChange={(v) => v && onVariant(v === ALL ? "" : v)} aria-label="Variant" className="flex-wrap">
							<ToggleGroupItem value={ALL} className="px-2.5 text-xs">
								all ({fmtInt(d.variants.reduce((s, v) => s + v.players, 0))})
							</ToggleGroupItem>
							{d.variants.map((v) => (
								<ToggleGroupItem key={v.variant} value={v.variant} className="px-2.5 text-xs" title={v.forced ? `${plural(v.forced, "player")} forced` : undefined}>
									{v.variant} ({fmtInt(v.players)})
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					) : null}
					{d.players.length ? (
						<>
							<DataTable id="experiment-players" label={`Players in ${experiment}`} columns={ASSIGNED_COLUMNS} data={d.players} rowId={(p) => `${p.pid}:${p.variant}`} defaultSort={[{ id: "lastAt", desc: true }]} />
							<p className="text-xs text-muted-foreground">
								{d.more ? `The ${fmtInt(d.players.length)} most recently seen, of ${fmtInt(d.total)}. ` : ""}
								How comes from the assignment rows in the range: random, forced by the settings, or before the range when only their stamped events are in it.
							</p>
						</>
					) : (
						<EmptyState>{variant ? `No player in variant ${variant} in this range.` : "No player in this experiment in this range."}</EmptyState>
					)}
				</div>
			)}
		</QueryState>
	);
}

function PlayerScope() {
	const list = useAnalytics("experiment", {});
	const overrides = useQuery({ queryKey: ["experiment-overrides"], queryFn: ({ signal }) => api.experimentOverrides(signal), retry: false });
	const [picked, setPicked] = useParam("experiment");
	const assigned = useAssigned();
	const { state } = useFilters();
	const names = list.data && list.data.experiment === null ? [...new Set(list.data.experiments.map((e) => e.experiment))] : [];
	const name = picked || names[0] || "";
	const results = useAnalytics("experiment", { experiment: name, scope: "player" }, { enabled: Boolean(name) });
	const rows = useMemo(() => (list.data && list.data.experiment === null ? experimentRows(list.data.experiments, overrides.data) : []), [list.data, overrides.data]);
	const range = describeRange(state);
	return (
		<>
			<QueryState query={list} isEmpty={(d) => d.experiment === null && d.experiments.length === 0} empty="No experiment rows in this range.">
				{() => (
					<>
						<div className="flex items-center gap-2">
							<span className="text-sm text-muted-foreground">Experiment</span>
							<Select value={name} onValueChange={setPicked}>
								<SelectTrigger size="sm" className="w-56" aria-label="Experiment">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{names.map((n) => (
										<SelectItem key={n} value={n}>
											{n}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<QueryState query={results}>
							{(data) =>
								data.experiment === null ? null : (
									<ResultsView data={data} onOpenVariant={(v) => assigned.open(data.experiment as string, v)} selectedVariant={assigned.experiment === data.experiment ? assigned.variant : undefined} />
								)
							}
						</QueryState>
						<Section
							title="Experiments"
							description={`Every experiment with assignment rows in this range, its state and weights. Open one for the players in it. ${
								overrides.data?.source === "settings-file"
									? "States and weights come from this server's copy of the settings (data/settings.json)."
									: "This server holds no copy of the game's settings, so the overrides in the game's signed settings are not shown here."
							}`}
						>
							<DataTable
								id="experiments-list"
								label="Experiments"
								columns={EXPERIMENT_COLUMNS}
								data={rows}
								rowId={(e) => e.experiment}
								onRowClick={(e) => (assigned.experiment === e.experiment && !assigned.variant ? assigned.close() : assigned.open(e.experiment))}
								rowActionLabel={(e) => `Open players in experiment ${e.experiment}`}
								isRowSelected={(e) => assigned.experiment === e.experiment}
							/>
						</Section>
					</>
				)}
			</QueryState>
			<Sheet open={Boolean(assigned.experiment)} onOpenChange={(open) => !open && assigned.close()}>
				<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl md:w-[48rem]">
					<div className="space-y-1 border-b p-4 pr-10">
						<SheetTitle>Players in {assigned.experiment}</SheetTitle>
						<SheetDescription>{`${range.charAt(0).toUpperCase()}${range.slice(1)}, under the page's filters.`}</SheetDescription>
					</div>
					<div className="p-4">{assigned.experiment ? <AssignedPlayers experiment={assigned.experiment} variant={assigned.variant} onVariant={assigned.setVariant} /> : null}</div>
				</SheetContent>
			</Sheet>
		</>
	);
}

function ServerScope() {
	const results = useAnalytics("experiment", { scope: "server" });
	return <QueryState query={results}>{(data) => (data.experiment === null ? null : <ResultsView data={data} />)}</QueryState>;
}

export default function Experiments() {
	const [scope, setScope] = useParam("scope", "player");
	return (
		<>
			<PageHeader
				title="Experiments"
				description="Per-variant numbers and how sure each difference is. Per player: the variant in each row's exp. Per server: kernel A/B pins."
				actions={
					<ToggleGroup type="single" variant="outline" size="sm" value={scope} onValueChange={(v) => v && setScope(v)}>
						<ToggleGroupItem value="player" className="px-2.5 text-xs">
							per player
						</ToggleGroupItem>
						<ToggleGroupItem value="server" className="px-2.5 text-xs">
							per server
						</ToggleGroupItem>
					</ToggleGroup>
				}
			/>
			{scope === "server" ? <ServerScope /> : <PlayerScope />}
		</>
	);
}
