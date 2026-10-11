import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeftRight, TriangleAlert, X } from "lucide-react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import { PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtInt, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { FunnelResult, PlaytimeFunnelResult } from "@/lib/types";

type Steps = Extract<FunnelResult, { steps: unknown }> & {
	/** Set on the built-in playtime funnels. */
	playtime?: { measure: PlaytimeFunnelResult["measure"]; capHours: number };
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
		steps: d.steps.map((s, i) => ({
			step: i + 1,
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

function StepBars({ data }: { data: Steps }) {
	const drop = data.biggestDrop;
	const p = data.playtime;
	const base = p ? (p.measure === "first" ? "of new players" : "of all players") : "of start";
	return (
		<Section
			title={p ? `${data.funnel}: ${plural(data.players, p.measure === "first" ? "new player" : "player")}` : `${data.funnel}: ${plural(data.players, "player")} started`}
			description={p ? playtimeDescription(p) : "Reached = players whose furthest step is at least this one. Time = median from their first step."}
		>
			<div className="space-y-3">
				{data.steps.map((s) => {
					const isDrop = drop?.step === s.step;
					return (
						<div key={s.step} className={cn("rounded-lg border p-3", isDrop && "border-[var(--status-critical)]")}>
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

function FunnelSteps({ funnel }: { funnel: ReturnType<typeof useFunnel> }) {
	const isEmpty = (d: AnyFunnel) => {
		const steps = funnel.toSteps(d);
		return !steps || steps.players === 0 || steps.steps.length === 0;
	};
	return (
		<QueryState query={funnel.query} isEmpty={isEmpty} empty="Nobody reached a step of this funnel in this range.">
			{(data) => {
				const steps = funnel.toSteps(data);
				return steps ? <StepBars data={steps} /> : null;
			}}
		</QueryState>
	);
}

/** Two funnels side by side: the headline numbers, then each funnel's steps in its own column. */
function FunnelCompare({ a, b }: { a: string; b: string }) {
	const fa = useFunnel(a);
	const fb = useFunnel(b);
	const da = fa.data;
	const db = fb.data;
	return (
		<div className="space-y-4">
			{da && db && da.players && db.players && da.steps.length && db.steps.length ? <CompareSummary a={da} b={db} /> : null}
			<div className="grid items-start gap-4 lg:grid-cols-2">
				<div className="min-w-0">
					<FunnelSteps funnel={fa} />
				</div>
				<div className="min-w-0">
					<FunnelSteps funnel={fb} />
				</div>
			</div>
		</div>
	);
}

function FunnelDetail({ name }: { name: string }) {
	return <FunnelSteps funnel={useFunnel(name)} />;
}

export default function Funnels() {
	const list = useAnalytics("funnel", {});
	const [picked, setPicked] = useParam("funnel");
	const [compare, setCompare] = useParam("compare");
	const [, setParams] = useSearchParams();
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
	const body = other ? <FunnelCompare a={name} b={other} /> : <FunnelDetail name={name} />;
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
		</>
	);
}
