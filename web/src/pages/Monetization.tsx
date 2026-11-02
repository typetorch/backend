/**
 * The Monetization page: revenue from the game's server-sent `purchase` rows (the `monetization` query). Revenue is
 * what the creator keeps (Robux paid x creatorShare, 0.7: Roblox keeps 30%), as on the Roblox page. Revenue,
 * purchases, payers and ARPDAU per day, revenue by product (names from Roblox through the ProductId card), payer
 * conversion, ARPPU, the repeat purchase rate, and how long new players take to buy for the first time. Who bought
 * what (the `monetization-players` query): a product row opens its buyers in a side sheet (URL `buyers=<kind>:<id>`),
 * and a chart bar opens that day's buyers (`buyersDay=YYYY-MM-DD`), and the top buyers of everything are listed below. The filter bar applies.
 */
import { DataTable, type DataColumn } from "@/components/data-table";
import { DayBars } from "@/components/DayBars";
import { EmptyState, Metric, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { UserIdLink } from "@/components/Identity";
import { PlayerPageLink } from "@/components/PlayerLink";
import { ProductId } from "@/components/ProductId";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { describeRange } from "@/lib/filters";
import { fmtAgo, fmtInt, fmtMinutes, fmtNum, fmtPct, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { MonetizationDay, MonetizationPlayer, MonetizationProduct, MonetizationResult } from "@/lib/types";

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
	{ id: "revenue", header: "Revenue", type: "number", align: "right", accessor: (p) => p.revenue, cell: (p) => fmtInt(p.revenue) },
	{ id: "robux", header: "Robux paid", type: "number", align: "right", accessor: (p) => p.robux, cell: (p) => fmtInt(p.robux) },
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

const when = (iso: string) => <span title={fmtTime(iso)}>{fmtAgo(iso)}</span>;

/** The buyers table's columns; `products` (distinct products bought) only for the top buyers of everything. */
function buyerColumns(all: boolean): DataColumn<MonetizationPlayer>[] {
	const columns: DataColumn<MonetizationPlayer>[] = [
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
			minWidth: 160,
		},
		{
			id: "uid",
			header: "UserId",
			accessor: (p) => p.uid ?? null,
			cell: (p) => (p.uid === undefined ? <span className="text-xs text-muted-foreground">not linked</span> : <UserIdLink uid={p.uid} className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline" />),
			exportValue: (p) => (p.uid !== undefined ? String(p.uid) : ""),
			defaultHidden: true,
		},
		{ id: "revenue", header: "Revenue", type: "number", align: "right", accessor: (p) => p.revenue, cell: (p) => fmtInt(p.revenue) },
		{ id: "robux", header: "Robux paid", type: "number", align: "right", accessor: (p) => p.robux, cell: (p) => fmtInt(p.robux) },
		{ id: "purchases", header: "Purchases", type: "number", align: "right", accessor: (p) => p.purchases, cell: (p) => fmtInt(p.purchases) },
	];
	if (all) columns.push({ id: "products", header: "Products", title: "Different products bought", type: "number", align: "right", accessor: (p) => p.products, cell: (p) => fmtInt(p.products) });
	columns.push(
		{ id: "firstAt", header: "First purchase", type: "date", accessor: (p) => p.firstAt, cell: (p) => when(p.firstAt), format: (_v, p) => fmtAgo(p.firstAt), className: "text-xs", defaultHidden: !all },
		{ id: "lastAt", header: "Last purchase", type: "date", accessor: (p) => p.lastAt, cell: (p) => when(p.lastAt), format: (_v, p) => fmtAgo(p.lastAt), className: "text-xs" },
	);
	return columns;
}

/** The buyers of one product (`kind` + `product`), or of anything when both are unset, under the filter bar; `day` narrows the range to that UTC day. */
function Buyers({ kind, product, day, label }: { kind?: string; product?: string; day?: string; label: string }) {
	const all = kind === undefined && product === undefined;
	const { apiFilters } = useFilters();
	const q = useAnalytics("monetization-players", all ? {} : { kind, product }, day ? { filters: { ...apiFilters, from: day, to: day } } : {});
	return (
		<QueryState query={q} loadingRows={4}>
			{(d) =>
				d.players.length ? (
					<div className="space-y-2">
						<DataTable id={day ? "monetization-day-buyers" : all ? "monetization-buyers" : "monetization-product-buyers"} label={label} columns={buyerColumns(all)} data={d.players} rowId={(p) => p.pid} density="compact" maxHeight={all ? "26rem" : undefined} />
						{d.more ? <p className="text-xs text-muted-foreground">{`The ${fmtInt(d.players.length)} biggest spenders, of ${fmtInt(d.total)}.`}</p> : null}
					</div>
				) : (
					<EmptyState>Nobody bought this in this range.</EmptyState>
				)
			}
		</QueryState>
	);
}

/** `buyers=<kind>:<id>` in the URL: the product whose buyers the side sheet shows. */
function splitBuyers(value: string): { kind: string; product: string } | null {
	const at = value.indexOf(":");
	return at > 0 && at < value.length - 1 ? { kind: value.slice(0, at), product: value.slice(at + 1) } : null;
}

/** `buyersDay=YYYY-MM-DD` in the URL: the UTC day whose buyers the side sheet shows. */
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The side sheet: a product's buyers (`buyers`) or one day's (`buyersDay`, from a chart bar). */
function BuyersSheet({ value, day, onClose }: { value: string; day: string; onClose(): void }) {
	const { state } = useFilters();
	const picked = splitBuyers(value);
	const pickedDay = !picked && isDay(day) ? day : null;
	const range = describeRange(state);
	return (
		<Sheet open={picked !== null || pickedDay !== null} onOpenChange={(o) => !o && onClose()}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl md:w-[48rem]">
				<div className="space-y-1 border-b p-4 pr-10">
					<SheetTitle>
						{picked ? (
							<span className="inline-flex items-center gap-2">
								Buyers of <ProductId id={picked.product} kind={picked.kind} showName />
							</span>
						) : pickedDay ? (
							`Buyers on ${pickedDay}`
						) : (
							"Buyers"
						)}
					</SheetTitle>
					<SheetDescription>
						{picked ? `${kindLabel(picked.kind)}, ${range}, under the page's filters. Biggest spenders first.` : "That UTC day, under the page's other filters. Biggest spenders first."}
					</SheetDescription>
				</div>
				<div className="p-4">
					{picked ? <Buyers kind={picked.kind} product={picked.product} label="Buyers of this product" /> : pickedDay ? <Buyers day={pickedDay} label={`Buyers on ${pickedDay}`} /> : null}
				</div>
			</SheetContent>
		</Sheet>
	);
}

const CHARTS: { key: keyof Omit<MonetizationDay, "date">; label: string; decimals?: number; description: string }[] = [
	{ key: "revenue", label: "Revenue", description: "Robux the creator keeps per day (UTC), after Roblox's cut." },
	{ key: "purchases", label: "Purchases", description: "Purchases per day." },
	{ key: "payers", label: "Payers", description: "Players who bought something that day." },
	{ key: "arpdau", label: "ARPDAU", decimals: 2, description: "Revenue per daily active user: the day's revenue over its active players." },
];

function Body({ data, onBuyers, onDay }: { data: MonetizationResult; onBuyers(value: string): void; onDay(day: string): void }) {
	const t = data.totals;
	const fp = data.firstPurchase;
	const cut = fmtPct(1 - data.creatorShare, 0);
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="Revenue" value={`${fmtInt(t.revenue)} R$`} sub={`${fmtInt(t.robux)} R$ paid, Roblox keeps ${cut}`} />
				<Metric label="Purchases" value={fmtInt(t.purchases)} sub={`${fmtNum(t.purchasesPerPayer)} per payer`} />
				<Metric label="Payers" value={fmtInt(t.payers)} sub={`of ${plural(t.activePlayers, "active player")}`} />
				<Metric label="Payer conversion" value={fmtPct(t.payerConversion, 2)} sub="payers / active players" />
				<Metric label="ARPPU" value={`${fmtNum(t.arppu, 1)} R$`} sub={`revenue per paying user, ${fmtNum(t.arpu)} R$ per active player`} />
				<Metric label="ARPDAU" value={`${fmtNum(t.arpdau, 2)} R$`} sub={`revenue per daily active user, over ${plural(t.playerDays, "player-day")}`} />
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
						<DayBars
							label={c.label}
							decimals={c.decimals}
							data={data.days.map((d) => ({ date: d.date, value: d[c.key] }))}
							onBarClick={(date) => onDay(date.slice(0, 10))}
							barClickHint="click: who bought"
						/>
					</Section>
				))}
			</div>
			<Section title="Revenue by product" description="Click a product to see who bought it. Hover or tap an id for its name, icon and price on Roblox.">
				<DataTable
					id="monetization-products"
					label="Revenue by product"
					columns={PRODUCT_COLUMNS}
					data={data.products}
					rowId={(p) => `${p.kind}:${p.product ?? ""}`}
					onRowClick={(p) => p.product !== null && onBuyers(`${p.kind}:${p.product}`)}
					density="compact"
					maxHeight="26rem"
				/>
			</Section>
			<Section title="Top buyers" description="Who spent the most in this range, on anything. A name opens the player.">
				<Buyers label="Top buyers" />
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
	const [buyers, setBuyers] = useParam("buyers");
	const [buyersDay, setBuyersDay] = useParam("buyersDay");
	return (
		<>
			<PageHeader title="Monetization" description={`Revenue from purchases, ${describeRange(state)}, after Roblox's cut. Server-sent purchases only, each counted once.`} />
			<QueryState query={q} loadingRows={6} isEmpty={(d) => d.totals.purchases === 0} empty={<MonetizationEmpty />}>
				{(data) => <Body data={data} onBuyers={setBuyers} onDay={setBuyersDay} />}
			</QueryState>
			<BuyersSheet
				value={buyers}
				day={buyersDay}
				onClose={() => {
					setBuyers("");
					setBuyersDay("");
				}}
			/>
		</>
	);
}
