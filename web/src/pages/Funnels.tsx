/**
 * Funnels: a funnel's steps (logged funnel rows, or the built-in playtime funnels), or two side by side. A step (click,
 * or Enter / Space) opens the players who reached it, or dropped off there, in a side sheet
 * (`?stepFunnel=<funnel>&step=<step>&stepMode=dropped`, shareable), under the filter bar's range and filters.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeftRight, TriangleAlert, Users, X } from "lucide-react";
import { useCallback, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { UserIdLink } from "@/components/Identity";
import { PlayerPageLink } from "@/components/PlayerLink";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { describeRange } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtNum, fmtPct, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { FunnelPlayer, FunnelResult, PlaytimeFunnelResult } from "@/lib/types";

type Steps = Extract<FunnelResult, { steps: unknown }> & {
	/** Set on the built-in playtime funnels. */
	playtime?: { measure: PlaytimeFunnelResult["measure"]; capHours: number };
};
type Step = Steps["steps"][number] & {
	/** Playtime funnels: the step's threshold, seconds (the funnel-players query's step). */
	seconds?: number;
};

/** Built-in funnels, computed from session lengths (not from logged funnel rows). Logged funnel names can't hold ":". */
const VIRTUAL: { key: string; title: string; measure: PlaytimeFunnelResult["measure"] }[] = [
	{ key: "playtime:total", title: "Playtime: total", measure: "total" },
	{ key: "playtime:first", title: "Playtime: first session", measure: "first" },
];
const virtualOf = (name: string) => VIRTUAL.find((v) => v.key === name);

/** A playtime funnel in the shape of a logged funnel, so the step bars and the compare view take it as it is. */
function playtimeSteps(title: string, d: PlaytimeFunnelResult): Steps {
	const index = (seconds: number) => d.steps.findIndex((s) => s.seconds === seconds) + 1;
	return {
		funnel: title,
		players: d.players,
		steps: d.steps.map<Step>((s, i) => ({
			step: i + 1,
			seconds: s.seconds,
			label: `≥ ${s.label}`,
			reached: s.reached,
			ofStart: s.ofTotal,
			fromPrevious: s.fromPrevious,
			logged: s.reached,
			medianSecondsFromStart: null,
		})),
		biggestDrop: d.biggestDrop ? { step: index(d.biggestDrop.seconds), lost: d.biggestDrop.lost, share: d.biggestDrop.share } : null,
		playtime: { measure: d.measure, capHours: d.sessionCapHours },
	};
}

type AnyFunnel = FunnelResult | PlaytimeFunnelResult;

/** One funnel's query (a logged funnel or a built-in one) and a way to read its steps. */
function useFunnel(name: string) {
	const v = virtualOf(name);
	const logged = useAnalytics("funnel", { funnel: name }, { enabled: !v && name !== "" });
	const playtime = useAnalytics("playtime-funnel", { measure: v?.measure ?? "total" }, { enabled: !!v });
	const query = (v ? playtime : logged) as UseQueryResult<AnyFunnel, Error>;
	const toSteps = (d: AnyFunnel): Steps | null => {
		if (v) return playtimeSteps(v.title, d as PlaytimeFunnelResult);
		const f = d as FunnelResult;
		return f.funnel === null ? null : f;
	};
	return { query, toSteps, data: query.data ? toSteps(query.data) : null };
}

function playtimeDescription(p: NonNullable<Steps["playtime"]>): string {
	const length = `A session lasts from its first to its last event (one still running counts up to its latest event), at most ${p.capHours} h.`;
	return p.measure === "total"
		? `Players whose playtime in this range (their sessions added up) reached each step, of every player in the range (no playtime included). ${length}`
		: `New players whose first-ever session (in this range) lasted at least each step, of those new players. ${length}`;
}

/** The step's value in the URL and in the funnel-players query: the step index, or a playtime funnel's threshold. */
const stepValue = (s: Step) => s.seconds ?? s.step;

/** What a step row needs to open its players: the funnel's key (a logged name or a built-in key) and the open step. */
interface StepOpener {
	funnelKey: string;
	open(funnelKey: string, step: number): void;
	/** The step open in the sheet for this funnel, if any. */
	selected?: number;
}

function StepBars({ data, opener }: { data: Steps; opener?: StepOpener }) {
	const drop = data.biggestDrop;
	const p = data.playtime;
	const base = p ? (p.measure === "first" ? "of new players" : "of all players") : "of start";
	return (
		<Section
			title={p ? `${data.funnel}: ${plural(data.players, p.measure === "first" ? "new player" : "player")}` : `${data.funnel}: ${plural(data.players, "player")} started`}
			description={p ? playtimeDescription(p) : "Reached = players whose furthest step is at least this one. Time = median from their first step."}
		>
			<div className="space-y-3">
				{data.steps.map((s: Step) => {
					const isDrop = drop?.step === s.step;
					const value = stepValue(s);
					const selected = opener?.selected === value;
					const act = opener
						? {
								role: "button",
								tabIndex: 0,
								"aria-label": `Open players at ${p ? "" : `step ${s.step} `}${s.label ?? ""} of ${data.funnel}`.replace(/\s+/g, " ").trim(),
								"aria-pressed": selected,
								onClick: () => opener.open(opener.funnelKey, value),
								onKeyDown: (e: KeyboardEvent) => {
									if (e.key !== "Enter" && e.key !== " ") return;
									e.preventDefault();
									opener.open(opener.funnelKey, value);
								},
							}
						: {};
					return (
						<div
							key={s.step}
							{...act}
							className={cn(
								"rounded-lg border p-3",
								isDrop && "border-[var(--status-critical)]",
								opener && "cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
								selected && "bg-muted/60 ring-1 ring-primary",
							)}
						>
							<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
								<div className="font-medium">
									{p ? null : <span className="text-muted-foreground">Step {s.step}</span>} {s.label ?? ""}
								</div>
								<div className="flex flex-wrap gap-4 text-xs text-muted-foreground tabular-nums">
									<span>
										<span className="font-medium text-foreground">{fmtInt(s.reached)}</span> reached
									</span>
									<span>
										{fmtPct(s.ofStart)} {base}
									</span>
									<span>{fmtPct(s.fromPrevious)} from previous</span>
									{p ? null : <span>{s.medianSecondsFromStart === null ? "–" : `${fmtNum(s.medianSecondsFromStart, 1)} s`} median</span>}
								</div>
							</div>
							<ShareBar share={s.ofStart} className="mt-2" tone={isDrop ? "alert" : "default"} />
							{isDrop && drop ? (
								<div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[var(--status-critical)]">
									<TriangleAlert className="size-3.5" />
									Biggest drop: {plural(drop.lost, "player")} ({fmtPct(drop.share)}) stopped before {p ? "reaching this" : "this step"}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
			{!drop && data.steps.length > 0 ? <p className="mt-3 text-xs text-muted-foreground">No drop between steps yet.</p> : null}
			{opener && data.steps.length > 0 ? (
				<p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
					<Users className="size-3.5" />
					Open a step for the players who reached it or dropped off there.
				</p>
			) : null}
		</Section>
	);
}

/** The last step's share of start: how many of the players who started got all the way through. */
const completion = (d: Steps) => d.steps.at(-1)?.ofStart ?? 0;

/** Two funnels' headline numbers next to each other, the second's difference from the first in points. */
function CompareSummary({ a, b }: { a: Steps; b: Steps }) {
	const delta = (completion(b) - completion(a)) * 100;
	const row = (d: Steps) => (
		<tr key={d.funnel} className="border-t">
			<td className="py-1.5 pr-4 font-medium">{d.funnel}</td>
			<td className="py-1.5 pr-4 text-right tabular-nums">{fmtInt(d.players)}</td>
			<td className="py-1.5 pr-4 text-right tabular-nums">{d.steps.length}</td>
			<td className="py-1.5 pr-4 text-right tabular-nums">{fmtPct(completion(d))}</td>
			<td className="py-1.5 text-muted-foreground">
				{d.biggestDrop ? `${d.playtime ? "" : `step ${d.biggestDrop.step} `}(${d.steps.find((s) => s.step === d.biggestDrop?.step)?.label ?? "?"}): ${fmtPct(d.biggestDrop.share)} lost` : "none"}
			</td>
		</tr>
	);
	return (
		<Section title={`${a.funnel} vs ${b.funnel}`} description="Completed = share of the players who started (playtime funnels: of their base) that reached the funnel's last step.">
			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead className="text-xs text-muted-foreground">
						<tr>
							<th className="pb-1.5 pr-4 text-left font-medium">Funnel</th>
							<th className="pb-1.5 pr-4 text-right font-medium">Started</th>
							<th className="pb-1.5 pr-4 text-right font-medium">Steps</th>
							<th className="pb-1.5 pr-4 text-right font-medium">Completed</th>
							<th className="pb-1.5 text-left font-medium">Biggest drop</th>
						</tr>
					</thead>
					<tbody>{[row(a), row(b)]}</tbody>
				</table>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">
				{b.funnel} completes{" "}
				<span className={cn("font-medium", delta > 0 ? "text-[var(--status-good)]" : delta < 0 ? "text-[var(--status-critical)]" : "text-foreground")}>
					{delta === 0 ? "the same as" : `${fmtNum(Math.abs(delta), 1)} points ${delta > 0 ? "more" : "less"} than`}
				</span>{" "}
				{a.funnel}.
			</p>
		</Section>
	);
}

function FunnelSteps({ funnel, opener }: { funnel: ReturnType<typeof useFunnel>; opener?: StepOpener }) {
	const isEmpty = (d: AnyFunnel) => {
		const steps = funnel.toSteps(d);
		return !steps || steps.players === 0 || steps.steps.length === 0;
	};
	return (
		<QueryState query={funnel.query} isEmpty={isEmpty} empty="Nobody reached a step of this funnel in this range.">
			{(data) => {
				const steps = funnel.toSteps(data);
				return steps ? <StepBars data={steps} opener={opener} /> : null;
			}}
		</QueryState>
	);
}

/** Two funnels side by side: the headline numbers, then each funnel's steps in its own column. */
/** A funnel's opener for its step rows (the open step only when the sheet shows this funnel). */
function openerFor(funnelKey: string, at: StepPlayersState): StepOpener {
	return { funnelKey, open: at.open, ...(at.funnel === funnelKey && at.step !== null ? { selected: at.step } : {}) };
}

function FunnelCompare({ a, b, at }: { a: string; b: string; at: StepPlayersState }) {
	const fa = useFunnel(a);
	const fb = useFunnel(b);
	const da = fa.data;
	const db = fb.data;
	return (
		<div className="space-y-4">
			{da && db && da.players && db.players && da.steps.length && db.steps.length ? <CompareSummary a={da} b={db} /> : null}
			<div className="grid items-start gap-4 lg:grid-cols-2">
				<div className="min-w-0">
					<FunnelSteps funnel={fa} opener={openerFor(a, at)} />
				</div>
				<div className="min-w-0">
					<FunnelSteps funnel={fb} opener={openerFor(b, at)} />
				</div>
			</div>
		</div>
	);
}

function FunnelDetail({ name, at }: { name: string; at: StepPlayersState }) {
	return <FunnelSteps funnel={useFunnel(name)} opener={openerFor(name, at)} />;
}

// The players at one step (side sheet) ---------------------------------------------------------------------------------

type Mode = "reached" | "dropped";

interface StepPlayersState {
	funnel: string;
	step: number | null;
	mode: Mode;
	open(funnel: string, step: number): void;
	setMode(mode: Mode): void;
	close(): void;
}

/** The side sheet's URL state: `stepFunnel` (the funnel key), `step` and `stepMode` (dropped; reached when absent). */
function useStepPlayers(): StepPlayersState {
	const [params, setParams] = useSearchParams();
	const funnel = params.get("stepFunnel") ?? "";
	const raw = params.get("step") ?? "";
	const step = /^-?\d{1,10}$/.test(raw) ? Number(raw) : null;
	const mode: Mode = params.get("stepMode") === "dropped" ? "dropped" : "reached";
	const write = useCallback(
		(next: Record<string, string>) =>
			setParams((current) => {
				const copy = new URLSearchParams(current);
				for (const [key, value] of Object.entries(next)) {
					if (value) copy.set(key, value);
					else copy.delete(key);
				}
				return copy;
			}),
		[setParams],
	);
	return {
		funnel,
		step,
		mode,
		// Opening another step keeps the mode (reached / dropped) the sheet was in.
		open: (f, s) => write({ stepFunnel: f, step: String(s) }),
		setMode: (m) => write({ stepMode: m === "dropped" ? "dropped" : "" }),
		close: () => write({ stepFunnel: "", step: "", stepMode: "" }),
	};
}

/** "1h 5m", "12m 30s", "45s". */
export function fmtPlaytime(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	if (h) return m ? `${h}h ${m}m` : `${h}h`;
	if (m) return r ? `${m}m ${r}s` : `${m}m`;
	return `${r}s`;
}

const when = (iso: string | null) => (iso ? <span title={fmtTime(iso)}>{fmtAgo(iso)}</span> : <span className="text-muted-foreground">–</span>);
const whenText = (iso: string | null) => (iso ? fmtAgo(iso) : "");

function playerColumns(kind: "logged" | "playtime", mode: Mode, labelOf: (step: number) => string): DataColumn<FunnelPlayer>[] {
	const stepText = (p: FunnelPlayer) => (p.lastStep === null ? "" : labelOf(p.lastStep));
	const columns: DataColumn<FunnelPlayer>[] = [
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
	];
	if (kind === "playtime") {
		columns.push({
			id: "playtime",
			header: "Playtime",
			accessor: (p) => p.playtimeSeconds ?? 0,
			cell: (p) => fmtPlaytime(p.playtimeSeconds ?? 0),
			format: (_v, p) => fmtPlaytime(p.playtimeSeconds ?? 0),
			className: "tabular-nums",
		});
	} else if (mode === "reached") {
		columns.push(
			{ id: "at", header: "Reached", title: "When they first logged this step or a later one", type: "date", accessor: (p) => p.at, cell: (p) => when(p.at), format: (_v, p) => whenText(p.at), className: "text-xs" },
			{ id: "lastStep", header: "Furthest step", accessor: (p) => p.lastStep, cell: (p) => stepText(p) || "–", format: (_v, p) => stepText(p), className: "text-xs", defaultHidden: true },
		);
	} else {
		columns.push(
			{ id: "lastStep", header: "Last step", accessor: (p) => p.lastStep, cell: (p) => stepText(p) || "–", format: (_v, p) => stepText(p), className: "text-xs" },
			{ id: "at", header: "At", title: "When they first logged their last step", type: "date", accessor: (p) => p.at, cell: (p) => when(p.at), format: (_v, p) => whenText(p.at), className: "text-xs" },
		);
	}
	columns.push({ id: "lastAt", header: "Last seen", type: "date", accessor: (p) => p.lastAt, cell: (p) => when(p.lastAt), format: (_v, p) => whenText(p.lastAt), className: "text-xs" });
	return columns;
}

/** The players at one step of one funnel (reached, or dropped off there), under the filter bar's range and filters. */
function StepPlayers({ funnelKey, step, mode, onMode }: { funnelKey: string; step: number; mode: Mode; onMode(mode: Mode): void }) {
	const v = virtualOf(funnelKey);
	const funnel = useFunnel(funnelKey);
	const players = useAnalytics("funnel-players", v ? { measure: v.measure, step, mode } : { funnel: funnelKey, step, mode });
	const steps: Step[] = funnel.data?.steps ?? [];
	const index = steps.findIndex((s) => stepValue(s) === step);
	const labelOf = (n: number) => {
		const s = steps.find((x) => x.step === n);
		return s?.label ? `${n}. ${s.label}` : `Step ${n}`;
	};
	// Counts from the funnel's own numbers: reached, and the step before minus this one (the base, for a playtime funnel's first step).
	const before = index > 0 ? steps[index - 1].reached : index === 0 && v && funnel.data ? funnel.data.players : null;
	const reachedCount = index >= 0 ? steps[index].reached : null;
	return (
		<div className="space-y-3">
			<ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(m) => m && onMode(m as Mode)} aria-label="Which players" className="flex-wrap">
				<ToggleGroupItem value="reached" className="px-2.5 text-xs">
					Reached{reachedCount !== null ? ` (${fmtInt(reachedCount)})` : ""}
				</ToggleGroupItem>
				<ToggleGroupItem value="dropped" className="px-2.5 text-xs">
					Dropped off here{before !== null && reachedCount !== null ? ` (${fmtInt(before - reachedCount)})` : ""}
				</ToggleGroupItem>
			</ToggleGroup>
			<QueryState query={players} loadingRows={3}>
				{(d) =>
					d.players.length ? (
						<>
							<DataTable
								id="funnel-players"
								label={mode === "reached" ? "Players who reached this step" : "Players who dropped off here"}
								columns={playerColumns(v ? "playtime" : "logged", mode, labelOf)}
								data={d.players}
								rowId={(p) => p.pid}
								defaultSort={[{ id: v ? "lastAt" : "at", desc: true }]}
							/>
							<p className="text-xs text-muted-foreground">
								{d.more ? `The ${fmtInt(d.players.length)} most recent, of ${fmtInt(d.total)}. ` : ""}
								{v
									? mode === "reached"
										? "Players whose playtime reached this step."
										: "Players whose playtime reached the step before (for the first step: any playtime) but not this one."
									: mode === "reached"
										? "Players whose furthest step is at least this one."
										: "Players who reached the step before but not this one."}
							</p>
						</>
					) : (
						<EmptyState>
							{mode === "reached" ? "Nobody reached this step in this range." : index === 0 && !v ? "Nobody drops off at the first step: every starter logged it." : "Nobody dropped off here in this range."}
						</EmptyState>
					)
				}
			</QueryState>
		</div>
	);
}

/** The sheet's title: the step's label from the funnel's own data (already loaded), else its value. */
function stepTitle(funnelKey: string, step: number, data: Steps | null): string {
	const s = data?.steps.find((x: Step) => stepValue(x) === step);
	const v = virtualOf(funnelKey);
	if (v) return `${v.title}: ${s?.label ?? `≥ ${fmtPlaytime(step)}`}`;
	return `${funnelKey}: step ${step}${s?.label ? ` (${s.label})` : ""}`;
}

function StepSheet({ at }: { at: StepPlayersState }) {
	const { state } = useFilters();
	const range = describeRange(state);
	const funnel = useFunnel(at.funnel);
	const open = Boolean(at.funnel) && at.step !== null;
	return (
		<Sheet open={open} onOpenChange={(o) => !o && at.close()}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl md:w-[48rem]">
				<div className="space-y-1 border-b p-4 pr-10">
					<SheetTitle>{open ? stepTitle(at.funnel, at.step as number, funnel.data) : "Players"}</SheetTitle>
					<SheetDescription>{`${range.charAt(0).toUpperCase()}${range.slice(1)}, under the page's filters.`}</SheetDescription>
				</div>
				<div className="p-4">{open ? <StepPlayers funnelKey={at.funnel} step={at.step as number} mode={at.mode} onMode={at.setMode} /> : null}</div>
			</SheetContent>
		</Sheet>
	);
}

export default function Funnels() {
	const list = useAnalytics("funnel", {});
	const [picked, setPicked] = useParam("funnel");
	const [compare, setCompare] = useParam("compare");
	const [, setParams] = useSearchParams();
	const at = useStepPlayers();
	// One navigation for both keys (two setters in a row would each start from the same URL).
	const swap = (a: string, b: string) =>
		setParams((current) => {
			const copy = new URLSearchParams(current);
			copy.set("funnel", a);
			copy.set("compare", b);
			return copy;
		});
	const funnels = list.data && list.data.funnel === null ? list.data.funnels : [];
	// The first logged funnel, else (none logged in the range) the built-in total playtime.
	const name = picked || funnels[0]?.name || VIRTUAL[0].key;
	const other = compare && compare !== name ? compare : "";
	const options = (exclude: string) => [
		...funnels
			.filter((f) => f.name !== exclude)
			.map((f) => (
				<SelectItem key={f.name} value={f.name}>
					{f.name} ({plural(f.players, "player")})
				</SelectItem>
			)),
		...VIRTUAL.filter((v) => v.key !== exclude).map((v) => (
			<SelectItem key={v.key} value={v.key}>
				{v.title}
			</SelectItem>
		)),
	];
	const body = other ? <FunnelCompare a={name} b={other} at={at} /> : <FunnelDetail name={name} at={at} />;
	return (
		<>
			<PageHeader
				title="Funnels"
				description="Step-by-step funnels the game logs (funnel rows: step index i, step name), and the built-in playtime funnels."
				actions={
					list.isPending ? null : (
						<div className="flex flex-wrap items-center gap-2">
							<Select value={name} onValueChange={setPicked}>
								<SelectTrigger size="sm" className="w-56" aria-label="Funnel">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>{options("")}</SelectContent>
							</Select>
							<Select value={other} onValueChange={setCompare}>
								<SelectTrigger size="sm" className="w-56" aria-label="Compare with">
									<ArrowLeftRight className="size-3.5 text-muted-foreground" />
									<SelectValue placeholder="Compare with…" />
								</SelectTrigger>
								<SelectContent>{options(name)}</SelectContent>
							</Select>
							{other ? (
								<>
									<Button size="sm" variant="ghost" aria-label="Swap funnels" title="Swap" onClick={() => swap(other, name)}>
										<ArrowLeftRight />
									</Button>
									<Button size="sm" variant="ghost" aria-label="Stop comparing" title="Stop comparing" onClick={() => setCompare("")}>
										<X />
									</Button>
								</>
							) : null}
						</div>
					)
				}
			/>
			{/* A picked built-in funnel doesn't wait for the list of logged funnels; anything else does. */}
			{picked && virtualOf(picked) && (!other || virtualOf(other)) ? body : <QueryState query={list}>{() => body}</QueryState>}
			<StepSheet at={at} />
		</>
	);
}
