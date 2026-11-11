/**
 * The Funnel tab: from the opt-in prompt to a player back the next day (prompt shown -> subscribed -> sent -> opened ->
 * played 1 min+ -> back next day, each % of the step before), three insight cards, sends and opens per day, the funnel
 * totals and the opt-in prompt by spot.
 */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { EmptyState, Section, ShareBar } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtInt, fmtPct } from "@/lib/format";
import type { NotifyFunnelResult, NotifyOptinResult } from "@/lib/types";
import { StatStrip, tick } from "./shared";

export interface FunnelStep {
	label: string;
	n: number;
	/** n / the step before (null for the first step, or when the step before is 0). */
	rate: number | null;
}

/** The steps from the prompt to back in game. `optin` may be missing (its query failed): the prompt steps then go. */
export function funnelSteps(funnel: NotifyFunnelResult, optin: NotifyOptinResult | undefined): FunnelStep[] {
	const t = funnel.totals;
	const raw: [string, number][] = [
		...(optin
			? ([
					["Prompt shown", optin.totals.shown],
					["Subscribed", optin.totals.subscribed],
				] as [string, number][])
			: []),
		["Sent", t.sent],
		["Opened", t.opened],
		["Played 1 min+", t.played],
		["Back next day", t.returnedD1],
	];
	return raw.map(([label, n], i) => {
		const before = i ? (raw[i - 1]?.[1] ?? 0) : 0;
		return { label, n, rate: i && before > 0 ? n / before : null };
	});
}

function Steps({ steps }: { steps: FunnelStep[] }) {
	const max = Math.max(1, ...steps.map((s) => s.n));
	return (
		<ol className="grid grid-cols-3 gap-3 sm:grid-cols-6" aria-label="Notification funnel">
			{steps.map((s, i) => (
				<li key={s.label} className="flex min-w-0 flex-col justify-end gap-1">
					<div className="flex h-28 items-end">
						<div className="w-full rounded-t-md bg-[var(--chart-1)]" style={{ height: `${Math.max(4, (s.n / max) * 100)}%`, opacity: 1 - i * 0.1 }} />
					</div>
					<div className="text-lg font-semibold tabular-nums">{fmtInt(s.n)}</div>
					<div className="truncate text-xs text-muted-foreground" title={s.label}>
						{s.label}
					</div>
					<div className="text-xs font-medium tabular-nums">{s.rate === null ? (i ? "–" : " ") : fmtPct(s.rate, 0)}</div>
				</li>
			))}
		</ol>
	);
}

function Insight({ title, headline, detail }: { title: string; headline: string; detail: string }) {
	return (
		<Card className="gap-1 py-4">
			<CardContent className="space-y-1">
				<h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
				<p className="font-semibold">{headline}</p>
				<p className="text-xs text-muted-foreground">{detail}</p>
			</CardContent>
		</Card>
	);
}

type WhereRow = NotifyOptinResult["byWhere"][number];
const WHERE_COLUMNS: DataColumn<WhereRow>[] = [
	{ id: "where", header: "Spot", accessor: (r) => r.where, cell: (r) => (r.where ? <span className="font-mono">{r.where}</span> : <span className="text-muted-foreground">(none)</span>) },
	{ id: "checks", header: "Checks", type: "number", align: "right", accessor: (r) => r.checks, cell: (r) => fmtInt(r.checks) },
	{ id: "canPrompt", header: "Can prompt", type: "number", align: "right", accessor: (r) => r.canPrompt, cell: (r) => fmtInt(r.canPrompt), defaultHidden: true },
	{ id: "errors", header: "Errors", type: "number", align: "right", accessor: (r) => r.errors, cell: (r) => fmtInt(r.errors) },
	{ id: "shown", header: "Shown", type: "number", align: "right", accessor: (r) => r.shown, cell: (r) => fmtInt(r.shown) },
	{ id: "shownRate", header: "Shown rate", type: "number", align: "right", title: "shown / checks", accessor: (r) => r.shownRate, cell: (r) => fmtPct(r.shownRate) },
	{ id: "closed", header: "Closed", type: "number", align: "right", accessor: (r) => r.closed, cell: (r) => fmtInt(r.closed), defaultHidden: true },
	{ id: "avgShownSecs", header: "Up for", hint: "s", type: "number", align: "right", accessor: (r) => r.avgShownSecs, cell: (r) => (r.avgShownSecs === null ? "–" : String(r.avgShownSecs)) },
	{
		id: "subscribedRate",
		header: "Subscribed",
		type: "number",
		title: "players whose last prompt was here and whose sends came back subscribed / players shown it here",
		accessor: (r) => r.subscribedRate ?? null,
		format: (v) => (v === null ? "–" : fmtPct(v as number)),
		cell: (r) =>
			r.shownPlayers ? (
				<span className="flex min-w-28 items-center gap-2" title={`${fmtInt(r.subscribed ?? 0)} of ${fmtInt(r.shownPlayers)} players`}>
					<ShareBar share={r.subscribedRate ?? 0} className="w-16" />
					<span className="tabular-nums">{fmtPct(r.subscribedRate ?? 0, 0)}</span>
				</span>
			) : (
				<span className="text-muted-foreground">–</span>
			),
	},
];

const funnelChart: ChartConfig = { sent: { label: "Sent", color: "var(--chart-1)" }, opened: { label: "Opened", color: "var(--chart-2)" }, played: { label: "Played 1 min+", color: "var(--chart-3)" } };

export function FunnelTab({ funnel, optin }: { funnel: NotifyFunnelResult; optin: NotifyOptinResult | undefined }) {
	const steps = funnelSteps(funnel, optin);
	const t = funnel.totals;
	// Insights: the step that keeps the smallest share, the kind opened most, the prompt spot that converts best
	const drops = steps.filter((s) => s.rate !== null);
	const worst = drops.reduce<FunnelStep | null>((a, s) => (a === null || (s.rate ?? 1) < (a.rate ?? 1) ? s : a), null);
	const worstBefore = worst ? steps[steps.indexOf(worst) - 1] : undefined;
	const kinds = funnel.kinds.filter((k) => k.sent > 0).sort((a, b) => b.openRate - a.openRate);
	const spots = (optin?.byWhere ?? []).filter((w) => (w.shownPlayers ?? 0) > 0).sort((a, b) => (b.subscribedRate ?? 0) - (a.subscribedRate ?? 0));
	return (
		<div className="space-y-4">
			<Section title="From prompt to back in game" description="Each % is of the step before. Subscribed is learned from Roblox's answer to a send; Sent counts sends, not players.">
				<Steps steps={steps} />
			</Section>
			<div className="grid gap-3 md:grid-cols-3">
				<Insight
					title="Biggest drop"
					headline={worst && worstBefore ? `${worstBefore.label} to ${worst.label.toLowerCase()}` : "Not enough data"}
					detail={worst && worst.rate !== null ? `${fmtPct(1 - worst.rate, 0)} don't make it to the next step.` : "Needs at least one step with rows."}
				/>
				<Insight
					title="Best kind"
					headline={kinds[0] ? `${kinds[0].kind}: ${fmtPct(kinds[0].openRate, 0)} opened` : "No sends yet"}
					detail={kinds.length > 1 ? kinds.slice(1, 4).map((k) => `${k.kind} ${fmtPct(k.openRate, 0)}`).join(", ") : "Only one kind sent in this range."}
				/>
				<Insight
					title="Best prompt spot"
					headline={spots[0] ? `${spots[0].where || "(none)"}: ${fmtPct(spots[0].subscribedRate ?? 0, 0)} subscribed` : "No prompt answers yet"}
					detail={spots.length > 1 ? spots.slice(1, 4).map((w) => `${w.where || "(none)"} ${fmtPct(w.subscribedRate ?? 0, 0)}`).join(", ") : "Answers come from Roblox's reply to a send."}
				/>
			</div>
			<StatStrip
				label="Funnel totals"
				items={[
					{ label: "Wants", value: fmtInt(t.wants), sub: `${fmtInt(t.planned)} planned` },
					{ label: "Sent", value: fmtInt(t.sent), sub: `${fmtInt(t.players)} players` },
					{ label: "Open rate", value: t.sent ? fmtPct(t.openRate) : "–", sub: `${fmtInt(t.opened)} opened` },
					{ label: "Played 1 min+", value: t.opened ? fmtPct(t.playedRate) : "–", sub: `${fmtInt(t.played)} of the opened` },
					{ label: "Assisted returns", value: fmtInt(t.assisted), sub: "came back within 24 h without opening" },
					{ label: "Dry run / test sends", value: `${fmtInt(t.dry)} / ${fmtInt(t.tests)}`, sub: "test sends reach Roblox; neither counts in Sent" },
				]}
			/>
			<div className="grid items-start gap-4 xl:grid-cols-2">
				<Section className="min-w-0" title="Sends and opens" description="Per day (UTC, by the day of the send).">
					<ChartContainer config={funnelChart} className="aspect-auto h-56 w-full">
						<BarChart data={funnel.daily} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barCategoryGap={2}>
							<CartesianGrid vertical={false} />
							<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
							<YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
							<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
							<ChartLegend content={<ChartLegendContent />} />
							<Bar dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
							<Bar dataKey="opened" fill="var(--color-opened)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
							<Bar dataKey="played" fill="var(--color-played)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
						</BarChart>
					</ChartContainer>
				</Section>
				<Section className="min-w-0" title="Opt-in prompt by spot" description="Checked, shown, and how many players shown it there turned out subscribed. Roblox doesn't say what the player picked; the backend infers it from its sends.">
					{optin ? (
						<div className="space-y-2">
							{optin.byWhere.length ? (
								<DataTable id="notify-optin-where" label="Opt-in by where" columns={WHERE_COLUMNS} data={optin.byWhere} rowId={(r) => r.where} density="compact" maxHeight="18rem" />
							) : (
								<EmptyState>No opt-in prompt rows in this range.</EmptyState>
							)}
							<p className="text-xs text-muted-foreground">
								{fmtInt(optin.totals.checks)} checks, {fmtInt(optin.totals.canPrompt)} could prompt, {fmtInt(optin.totals.errors)} errors; {fmtInt(optin.totals.closed)} closed
								{optin.totals.avgShownSecs === null ? "" : `, up ${optin.totals.avgShownSecs} s on average`}. Inferred: {fmtInt(optin.totals.subscribed)} subscribed, {fmtInt(optin.totals.notSubscribed)} not.
							</p>
						</div>
					) : (
						<EmptyState>The opt-in rows didn't load.</EmptyState>
					)}
				</Section>
			</div>
		</div>
	);
}
