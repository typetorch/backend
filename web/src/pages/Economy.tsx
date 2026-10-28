/**
 * The Economy page: one in-game currency at a time from the game's `currency` rows (the `economy` query). Earned vs
 * spent per day, the running balance (the net added up over the range: games log flows, not balances), what players
 * earn per active player, and the top sources and sinks by reason. The filter bar applies; the currency picker lists
 * every currency in the range (default the busiest).
 */
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, Metric, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeRange } from "@/lib/filters";
import { fmtInt, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { EconomyFlow, EconomyResult } from "@/lib/types";

const tick = (d: string) => d.slice(5);

/** What to send when there are no currency rows: the framework's server-side call (inside the empty state). */
export function EconomyEmpty() {
	return (
		<>
			<p className="font-medium text-foreground">No currency events in this range.</p>
			<p className="pt-1">
				The game server logs them with <code className="font-mono text-foreground">analytics.currency(player, name, delta, reason)</code> (the
				framework's AnalyticsEngine): a positive delta when currency comes in, a negative one when it is spent, e.g.{" "}
				<code className="font-mono text-foreground">analytics.currency(player, "coins", 50, "round_reward")</code> and{" "}
				<code className="font-mono text-foreground">analytics.currency(player, "coins", -200, "shop")</code>. Server only: clients can't send them.
			</p>
		</>
	);
}

function flowColumns(what: "Source" | "Sink"): DataColumn<EconomyFlow>[] {
	return [
		{ id: "reason", header: what, accessor: (r) => r.reason, cell: (r) => (r.reason ? <span className="font-mono">{r.reason}</span> : <span className="text-muted-foreground">(no reason)</span>) },
		{ id: "amount", header: "Amount", type: "number", align: "right", accessor: (r) => r.amount, cell: (r) => fmtNum(r.amount) },
		{
			id: "share",
			header: "Share",
			type: "number",
			accessor: (r) => r.share,
			format: (v) => fmtPct(v as number),
			cell: (r) => (
				<div className="flex min-w-28 items-center gap-2">
					<ShareBar share={r.share} className="flex-1" />
					<span className="w-12 text-right tabular-nums">{fmtPct(r.share)}</span>
				</div>
			),
			minWidth: 140,
		},
		{ id: "rows", header: "Events", type: "number", align: "right", accessor: (r) => r.rows, cell: (r) => fmtInt(r.rows) },
		{ id: "players", header: "Players", type: "number", align: "right", accessor: (r) => r.players, cell: (r) => fmtInt(r.players) },
	];
}

const SOURCE_COLUMNS = flowColumns("Source");
const SINK_COLUMNS = flowColumns("Sink");

const flowConfig: ChartConfig = { earned: { label: "Earned", color: "var(--chart-2)" }, spent: { label: "Spent", color: "var(--chart-1)" } };
const balanceConfig: ChartConfig = { balance: { label: "Running balance", color: "var(--chart-1)" }, net: { label: "Net that day", color: "var(--chart-3)" } };
const perActiveConfig: ChartConfig = { earnedPerActive: { label: "Earned per active player", color: "var(--chart-2)" } };

function Body({ data }: { data: EconomyResult }) {
	const t = data.totals;
	const unit = data.currency ?? "";
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Earned" value={fmtNum(t.earned)} sub={`${plural(t.earners, "player")} earned ${unit}`} />
				<Metric label="Spent" value={fmtNum(t.spent)} sub={`${plural(t.spenders, "player")} spent ${unit}`} />
				<Metric label="Net" value={fmtNum(t.net)} sub={t.net >= 0 ? "more came in than went out" : "more went out than came in"} />
				<Metric
					label="Spent per earned"
					value={t.earned > 0 ? fmtPct(t.sinkRatio) : "–"}
					sub={t.earned > 0 ? (t.sinkRatio > 1 ? "draining" : "the rest piles up") : "nothing earned"}
				/>
				<Metric label="Earned per active player" value={fmtNum(t.earnedPerActive)} sub={`${plural(t.activePlayers, "active player")} in the range`} />
				<Metric label="Spent per active player" value={fmtNum(t.spentPerActive)} />
				<Metric label="Avg net per player" value={fmtNum(t.avgNetPerPlayer)} sub={`median ${fmtNum(t.medianNetPerPlayer)}, over ${plural(t.players, "player")} with ${unit}`} />
				<Metric label="Events" value={fmtInt(t.rows)} sub={`of ${unit}`} />
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				<Section title="Earned vs spent" description="Per day (UTC).">
					<ChartContainer config={flowConfig} className="aspect-auto h-56 w-full">
						<BarChart data={data.days} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barCategoryGap={2}>
							<CartesianGrid vertical={false} />
							<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
							<YAxis tickLine={false} axisLine={false} width={48} />
							<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
							<ChartLegend content={<ChartLegendContent />} />
							<Bar dataKey="earned" fill="var(--color-earned)" radius={[3, 3, 0, 0]} maxBarSize={20} isAnimationActive={false} />
							<Bar dataKey="spent" fill="var(--color-spent)" radius={[3, 3, 0, 0]} maxBarSize={20} isAnimationActive={false} />
						</BarChart>
					</ChartContainer>
				</Section>
				<Section title="Running balance" description="The net (earned - spent) added up from the start of the range: above zero, currency piles up in the game.">
					<ChartContainer config={balanceConfig} className="aspect-auto h-56 w-full">
						<LineChart data={data.days} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
							<CartesianGrid vertical={false} />
							<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
							<YAxis tickLine={false} axisLine={false} width={48} />
							<ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
							<ChartLegend content={<ChartLegendContent />} />
							<Line dataKey="balance" stroke="var(--color-balance)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
							<Line dataKey="net" stroke="var(--color-net)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
						</LineChart>
					</ChartContainer>
				</Section>
				<Section title="Earned per active player" description="Per day: what came in over the players with any event that day.">
					<ChartContainer config={perActiveConfig} className="aspect-auto h-48 w-full">
						<LineChart data={data.days} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
							<CartesianGrid vertical={false} />
							<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
							<YAxis tickLine={false} axisLine={false} width={48} />
							<ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
							<Line dataKey="earnedPerActive" stroke="var(--color-earnedPerActive)" strokeWidth={2} dot={false} isAnimationActive={false} />
						</LineChart>
					</ChartContainer>
				</Section>
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				<Section title="Top sources" description="Where it comes from: the reasons of positive deltas.">
					{data.sources.length ? (
						<DataTable id="economy-sources" label="Top sources" columns={SOURCE_COLUMNS} data={data.sources} rowId={(r) => r.reason} density="compact" maxHeight="22rem" />
					) : (
						<EmptyState>Nothing earned in this range.</EmptyState>
					)}
				</Section>
				<Section title="Top sinks" description="Where it goes: the reasons of negative deltas.">
					{data.sinks.length ? (
						<DataTable id="economy-sinks" label="Top sinks" columns={SINK_COLUMNS} data={data.sinks} rowId={(r) => r.reason} density="compact" maxHeight="22rem" />
					) : (
						<EmptyState>Nothing spent in this range.</EmptyState>
					)}
				</Section>
			</div>
		</>
	);
}

function CurrencyPicker({ data, value, onChange }: { data: EconomyResult | undefined; value: string; onChange(next: string): void }) {
	const names = data?.currencies.map((c) => c.currency) ?? [];
	const shown = value || data?.currency || "";
	// A currency from the URL with no rows in this range stays pickable.
	const items = shown && !names.includes(shown) ? [shown, ...names] : names;
	if (!items.length) return null;
	return (
		<Select value={shown} onValueChange={onChange}>
			<SelectTrigger size="sm" className="w-44" aria-label="Currency">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((name) => (
					<SelectItem key={name} value={name}>
						{name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export default function Economy() {
	const { state } = useFilters();
	const [currency, setCurrency] = useParam("currency");
	const q = useAnalytics("economy", currency ? { currency } : {});
	return (
		<>
			<PageHeader
				title="Economy"
				description={`Currency earned and spent, ${describeRange(state)}, from the game's currency events.`}
				actions={<CurrencyPicker data={q.data} value={currency} onChange={setCurrency} />}
			/>
			<QueryState query={q} loadingRows={6} isEmpty={(d) => d.currencies.length === 0} empty={<EconomyEmpty />}>
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
