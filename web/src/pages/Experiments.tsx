/**
 * Experiments: per-variant numbers and how sure each difference is (each variant against the control, Holm-corrected
 * over the variants), whether players landed where the split says (sample ratio check, a loud warning when not), what
 * the traffic can detect and how long until it can tell, and every experiment with its state and weights. Owners can
 * start, stop, re-split, settle or clear one: the split lives in the game's signed settings, so the page hands them the
 * exact `typetorch experiment ...` command (signed on their machine; the server never holds the keys). A row of the experiments list or of the variants table (click, or
 * Enter / Space) opens the players in it in a side sheet (`?assigned=<experiment>&assignedVariant=`, shareable), under
 * the filter bar's range and filters, each linking to their Players page.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { UserIdLink } from "@/components/Identity";
import { PlayerPageLink } from "@/components/PlayerLink";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { describeRange } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtNum, fmtPct, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { AssignmentCheck, ExperimentChangeRequest, ExperimentOverride, ExperimentOverrides, ExperimentPlayer, ExperimentResult, PreparedExperimentChange } from "@/lib/types";

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
	{
		id: "sure",
		header: "Sure",
		accessor: (c) => c.sure,
		cell: (c) => (
			<span title={`${c.method}${c.pValue !== undefined && c.pAdjusted !== undefined && c.pAdjusted !== c.pValue ? `; p ${fmtNum(c.pValue, 4)}, corrected ${fmtNum(c.pAdjusted, 4)}` : ""}`}>{fmtPct(c.sure, 0)}</span>
		),
		format: (_v, c) => fmtPct(c.sure, 0),
	},
	{
		id: "mde",
		header: "Can detect",
		title: "The smallest true difference these group sizes find 80% of the time (5%, corrected over the variants)",
		accessor: (c) => c.mdeLift ?? null,
		cell: (c) => mdeText(c),
		format: (_v, c) => mdeText(c),
	},
	{
		id: "days",
		header: "Time to tell",
		title: "At the range's traffic: days more until the observed difference would be sure (or now)",
		accessor: (c) => c.days ?? null,
		cell: (c) => daysText(c.days),
		format: (_v, c) => daysText(c.days),
	},
];

/** "±12% (±0.4 min)": the minimum detectable effect, relative when the control's value isn't 0. */
export function mdeText(c: Comparison): string {
	if (c.mde === undefined) return "–";
	if (c.mde === null || !Number.isFinite(c.mde)) return "no players";
	const absolute = `±${fmtMetric(c.metric, c.mde)}`;
	return c.mdeLift === null || c.mdeLift === undefined ? absolute : `±${fmtPct(c.mdeLift, 0)} (${absolute})`;
}

/** "now", "~3 days", "over a year" or "–". */
export function daysText(days: number | null | undefined): string {
	if (days === null || days === undefined) return "–";
	if (days === 0) return "now";
	if (days > 365) return "over a year";
	return days < 1 ? "under a day" : `~${fmtInt(Math.ceil(days))} days`;
}

/**
 * The sample ratio check: a loud warning when players didn't land where the split says (the numbers can't be trusted),
 * else one quiet line. Each variant's players against the share it should get.
 */
export function SampleRatio({ check }: { check: AssignmentCheck }) {
	const srm = check.srm;
	const total = check.variants.reduce((s, v) => s + v.players, 0);
	const weightTotal = (check.weights ?? []).reduce((s, w) => s + w, 0);
	const rows = check.variants.map((v, i) => `${v.variant} ${fmtInt(v.players)} (${fmtPct(total ? v.players / total : 0, 1)}${check.weights && weightTotal ? `, should be ${fmtPct(check.weights[i] / weightTotal, 1)}` : ""})`);
	const split = check.weightsFrom === "settings" ? "the settings' weights" : "an even split";
	if (srm?.mismatch) {
		return (
			<Alert variant="destructive">
				<TriangleAlert />
				<AlertTitle>Sample ratio mismatch: don't trust these numbers</AlertTitle>
				<AlertDescription>
					<p>
						Players didn't land where {split} says: {rows.join(", ")}. Chi-square p = {srm.pValue < 0.0001 ? srm.pValue.toExponential(1) : fmtNum(srm.pValue, 4)} (a fair split
						gets this less than 1 time in 1000). Look for a variant that crashes or loses its events, a bug in when the game asks for the variant, bots, or a split changed in this range.
					</p>
					{check.note ? <p>{check.note}</p> : null}
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<p className="text-xs text-muted-foreground" data-testid="srm-line">
			{srm
				? `Split check: ${srm.enough ? `players per variant fit ${split} (p = ${fmtNum(srm.pValue, 3)})` : "too few players to check the split yet"}. ${rows.join(", ")}.`
				: `Split check: ${check.note ?? "not run."}`}
			{srm && check.note ? ` ${check.note}` : ""}
		</p>
	);
}

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
			{data.assignment ? <SampleRatio check={data.assignment} /> : null}
			<Section
				title="How sure"
				description={`Each variant against the control: two-proportion test for shares, bootstrap (or Welch) for averages.${
					data.variants.length > 2 ? ` With ${data.variants.length - 1} variants against the control, "sure" is Holm-corrected so more variants don't mean more lucky wins.` : ""
				}${data.forcedPlayers ? ` ${plural(data.forcedPlayers, "forced player")} left out (they didn't get a random variant).` : ""} Can detect and time to tell assume 80% power at the range's traffic.`}
			>
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
		cell: (p) => (p.uid === undefined ? <span className="text-xs text-muted-foreground">not linked</span> : <UserIdLink uid={p.uid} pid={p.pid} className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline" />),
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
	const override = overrides.data?.experiments[name];
	// The intended split for the sample ratio check: the override's weights while it runs on them.
	const weights = override && override.active !== false && !override.variant && override.weights?.length ? override.weights : undefined;
	const results = useAnalytics("experiment", { experiment: name, scope: "player", ...(weights ? { weights } : {}) }, { enabled: Boolean(name) });
	const owner = !isReadOnly(useAuth());
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
									<>
										<ResultsView data={data} onOpenVariant={(v) => assigned.open(data.experiment as string, v)} selectedVariant={assigned.experiment === data.experiment ? assigned.variant : undefined} />
										{owner ? <ExperimentControl key={data.experiment} experiment={data.experiment} variants={gameVariants(data)} override={override} /> : null}
									</>
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

/**
 * The experiment's variants for the controls: in the game's order when the rows carry it (`known`), else by name (then
 * weights are labelled by position: only the game knows its order).
 */
export function gameVariants(data: Results): { names: string[]; known: boolean } {
	const check = data.assignment;
	if (check && check.order === "game" && check.variants.every((v) => v.index !== null && !v.variant.startsWith("("))) return { names: check.variants.map((v) => v.variant), known: true };
	return { names: data.variants.map((v) => v.variant).sort(), known: false };
}

const ACTION_LABEL: Record<ExperimentChangeRequest["action"], string> = { start: "Start", stop: "Stop", split: "Change split", settle: "Settle", clear: "Clear" };

/** A command in a box with a copy button. */
function CommandBox({ label, command }: { label: string; command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="space-y-1">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="flex items-start gap-2">
				<pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted px-2 py-1.5 font-mono text-xs" aria-label={label}>
					{command}
				</pre>
				<Button
					size="sm"
					variant="outline"
					aria-label={`Copy: ${label}`}
					onClick={async () => {
						try {
							await navigator.clipboard?.writeText(command);
							setCopied(true);
						} catch {
							setCopied(false);
						}
					}}
				>
					<Copy /> {copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}

/**
 * Owners: start, stop, re-split, settle or clear the experiment. The split is in the game's signed settings and the
 * signing keys stay on the owners' machines, so this prepares the change (checked and audited by the server) and hands
 * over the exact command that applies it.
 */
export function ExperimentControl({ experiment, variants, override }: { experiment: string; variants: { names: string[]; known: boolean }; override?: ExperimentOverride }) {
	const count = variants.names.length;
	const [weights, setWeights] = useState<string[]>(() =>
		Array.from({ length: count }, (_, i) => String(override?.weights && override.weights.length === count ? override.weights[i] : 1)),
	);
	const [settleOn, setSettleOn] = useState(variants.names[0] ?? "");
	const prepare = useMutation({ mutationFn: (change: ExperimentChangeRequest) => api.experimentChange(experiment, change) });
	const label = (i: number) => (variants.known ? variants.names[i] : `variant ${i + 1}`) + (i === 0 ? " (control)" : "");
	const parsed = weights.map((w) => Number(w));
	const weightsOk = parsed.length > 0 && parsed.every((w) => Number.isFinite(w) && w >= 0) && parsed.some((w) => w > 0) && weights.every((w) => w.trim() !== "");
	const run = (change: ExperimentChangeRequest) => prepare.mutate(change);
	const listed = variants.known ? { variants: variants.names } : {};
	const prepared: PreparedExperimentChange | undefined = prepare.data;
	return (
		<Section
			title="Run it"
			description="Start, stop, change the split or settle on a winner. The split lives in the game's signed settings and only your keys sign them (they never reach this server), so this gives you the command to run in the game's folder; servers apply it within seconds, no deploy."
		>
			<div className="space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" onClick={() => run({ action: "start" })} disabled={prepare.isPending}>
						Start
					</Button>
					<Button size="sm" variant="outline" onClick={() => run({ action: "stop" })} disabled={prepare.isPending}>
						Stop
					</Button>
					<Button size="sm" variant="outline" onClick={() => run({ action: "clear" })} disabled={prepare.isPending}>
						Clear override
					</Button>
				</div>
				{count > 0 ? (
					<div className="space-y-2">
						<div className="text-sm font-medium">Split</div>
						<div className="flex flex-wrap items-end gap-3">
							{weights.map((w, i) => (
								<label key={i} className="space-y-1 text-xs">
									<span className="block text-muted-foreground">{label(i)}</span>
									<Input
										className="h-8 w-24"
										inputMode="decimal"
										aria-label={`Weight of ${label(i)}`}
										value={w}
										onChange={(e) => setWeights((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
									/>
								</label>
							))}
							<Button size="sm" onClick={() => run({ action: "split", weights: parsed, ...listed })} disabled={!weightsOk || prepare.isPending}>
								Change split
							</Button>
						</div>
						{variants.known ? null : (
							<p className="text-xs text-muted-foreground">These rows don't carry the game's variant order (framework 0.7.1+ adds it): weights go in the order the game lists its variants.</p>
						)}
					</div>
				) : null}
				{count > 0 ? (
					<div className="flex flex-wrap items-end gap-2">
						<label className="space-y-1 text-xs">
							<span className="block text-muted-foreground">Everyone gets</span>
							<Select value={settleOn} onValueChange={setSettleOn}>
								<SelectTrigger size="sm" className="w-44" aria-label="Variant to settle on">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{variants.names.map((n) => (
										<SelectItem key={n} value={n}>
											{n}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</label>
						<Button size="sm" variant="outline" onClick={() => run({ action: "settle", variant: settleOn, variants: variants.names })} disabled={!settleOn || prepare.isPending}>
							Settle
						</Button>
					</div>
				) : null}
				{prepare.isError ? <p className="text-sm text-destructive">{(prepare.error as Error).message}</p> : null}
				{prepared ? (
					<div className="space-y-2 rounded-lg border p-3" data-testid="prepared-change">
						<div className="text-sm font-medium">
							{ACTION_LABEL[prepared.action]} {prepared.experiment}: {prepared.effect}
						</div>
						<CommandBox label="Run in the game's folder" command={prepared.command} />
						<CommandBox label="See the change first (writes nothing)" command={prepared.dryRun} />
						{prepared.notes.map((n) => (
							<p key={n} className="text-xs text-muted-foreground">
								{n}
							</p>
						))}
					</div>
				) : null}
			</div>
		</Section>
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
