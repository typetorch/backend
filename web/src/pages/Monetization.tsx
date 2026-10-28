/**
 * The Monetization page: revenue from the game's server-sent `purchase` rows (the `monetization` query). Robux,
 * purchases, payers and ARPDAU per day, revenue by product (names from Roblox through the ProductId card), payer
 * conversion, ARPPU, the repeat purchase rate, and how long new players take to buy for the first time. The filter
 * bar applies.
 */
import { DataTable, type DataColumn } from "@/components/data-table";
import { DayBars } from "@/components/DayBars";
import { Metric, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { ProductId } from "@/components/ProductId";
import { describeRange } from "@/lib/filters";
import { fmtInt, fmtMinutes, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useFilters } from "@/lib/hooks";
import type { MonetizationDay, MonetizationProduct, MonetizationResult } from "@/lib/types";

/** What to send when there are no purchase rows: the framework's server-side call (inside the empty state). */
export function MonetizationEmpty() {
	return (
		<>
			<p className="font-medium text-foreground">No purchases in this range.</p>
			<p className="pt-1">
				The game server logs them with <code className="font-mono text-foreground">analytics.purchase(player, {"{ product, robux, where?, kind? }"})</code>{" "}
				(the framework's AnalyticsEngine) once the purchase is granted: in ProcessReceipt for developer products, e.g.{" "}
				<code className="font-mono text-foreground">analytics.purchase(player, {'{ product: 1234, robux: 99, where: "shop" }'})</code>, and with{" "}
				<code className="font-mono text-foreground">kind: "gamepass"</code> after a game pass prompt finishes with a purchase. Server only: clients
				can't send them.
			</p>
		</>
	);
}

const kindLabel = (kind: string) => (kind === "gamepass" ? "Game pass" : kind === "product" ? "Developer product" : kind);

const PRODUCT_COLUMNS: DataColumn<MonetizationProduct>[] = [
	{
		id: "product",
		header: "Product",
		accessor: (p) => p.product,
		cell: (p) => <ProductId id={p.product} kind={p.kind} showName />,
		minWidth: 160,
	},
	{ id: "kind", header: "Kind", type: "enum", accessor: (p) => p.kind, format: (v) => kindLabel(String(v)), cell: (p) => kindLabel(p.kind) },
	{ id: "robux", header: "Robux", type: "number", align: "right", accessor: (p) => p.robux, cell: (p) => fmtInt(p.robux) },
	{
		id: "share",
		header: "Share",
		type: "number",
		accessor: (p) => p.share,
		format: (v) => fmtPct(v as number),
		cell: (p) => (
			<div className="flex min-w-28 items-center gap-2">
				<ShareBar share={p.share} className="flex-1" />
				<span className="w-12 text-right tabular-nums">{fmtPct(p.share)}</span>
			</div>
		),
		minWidth: 140,
	},
	{ id: "purchases", header: "Purchases", type: "number", align: "right", accessor: (p) => p.purchases, cell: (p) => fmtInt(p.purchases) },
	{ id: "payers", header: "Payers", type: "number", align: "right", accessor: (p) => p.payers, cell: (p) => fmtInt(p.payers) },
];

const CHARTS: { key: keyof Omit<MonetizationDay, "date">; label: string; decimals?: number; description: string }[] = [
	{ key: "robux", label: "Robux", description: "Revenue per day (UTC)." },
	{ key: "purchases", label: "Purchases", description: "Purchases per day." },
	{ key: "payers", label: "Payers", description: "Players who bought something that day." },
	{ key: "arpdau", label: "ARPDAU", decimals: 2, description: "Robux per daily active user: the day's Robux over its active players." },
];

function Body({ data }: { data: MonetizationResult }) {
	const t = data.totals;
	const fp = data.firstPurchase;
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Revenue" value={`${fmtInt(t.robux)} R$`} sub={`${fmtNum(t.arpu)} R$ per active player`} />
				<Metric label="Purchases" value={fmtInt(t.purchases)} sub={`${fmtNum(t.purchasesPerPayer)} per payer`} />
				<Metric label="Payers" value={fmtInt(t.payers)} sub={`of ${plural(t.activePlayers, "active player")}`} />
				<Metric label="Payer conversion" value={fmtPct(t.payerConversion, 2)} sub="payers / active players" />
				<Metric label="ARPPU" value={`${fmtNum(t.arppu, 1)} R$`} sub="Robux per paying user" />
				<Metric label="ARPDAU" value={`${fmtNum(t.arpdau, 2)} R$`} sub={`Robux per daily active user, over ${plural(t.playerDays, "player-day")}`} />
				<Metric label="Repeat purchase rate" value={fmtPct(t.repeatRate)} sub={`${plural(t.repeatPayers, "payer")} bought 2+ times`} />
				<Metric
					label="Time to first purchase"
					value={fmtMinutes(fp.medianMinutes)}
					sub={fp.payers ? `median, ${plural(fp.payers, "new player")} (avg ${fmtMinutes(fp.avgMinutes)})` : "no new player bought yet"}
				/>
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				{CHARTS.map((c) => (
					<Section key={c.key} title={c.label} description={c.description}>
						<DayBars label={c.label} decimals={c.decimals} data={data.days.map((d) => ({ date: d.date, value: d[c.key] }))} />
					</Section>
				))}
			</div>
			<Section title="Revenue by product" description="Hover or tap an id for its name, icon and price on Roblox.">
				<DataTable id="monetization-products" label="Revenue by product" columns={PRODUCT_COLUMNS} data={data.products} rowId={(p) => `${p.kind}:${p.product ?? ""}`} density="compact" maxHeight="26rem" />
			</Section>
			<Section
				title="First purchase"
				description={`New players (first session in the range) who bought after joining: ${fmtInt(fp.payers)} of ${fmtInt(fp.newPlayers)} (${fmtPct(fp.conversion)}). Which of their sessions it was in:`}
			>
				<div className="space-y-2">
					{fp.bySession.map((b) => (
						<div key={b.session} className="grid grid-cols-[6rem_1fr_6rem] items-center gap-3 text-sm">
							<span className="text-muted-foreground">Session {b.session}</span>
							<ShareBar share={b.share} />
							<span className="text-right tabular-nums">
								{fmtInt(b.payers)} <span className="text-muted-foreground">({fmtPct(b.share)})</span>
							</span>
						</div>
					))}
				</div>
			</Section>
		</>
	);
}

export default function Monetization() {
	const { state } = useFilters();
	const q = useAnalytics("monetization");
	return (
		<>
			<PageHeader title="Monetization" description={`Robux from purchases, ${describeRange(state)}. Server-sent purchases only, each counted once.`} />
			<QueryState query={q} loadingRows={6} isEmpty={(d) => d.totals.purchases === 0} empty={<MonetizationEmpty />}>
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
