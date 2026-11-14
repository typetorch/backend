/**
 * Churn risk on the Players page (the `churn` query): how many players are active, at risk, lapsing or churned, as of
 * today over the last 90 days (the filter bar's other filters choose the players), and the list of one bucket with the
 * numbers behind each player's risk. For owners each player carries their notification opt-in, so the at-risk players
 * a win-back notification can reach stand out; Export gives their UserIds. The rule is in the README ("Churn risk").
 */
import { useMemo } from "react";
import { cn } from "cn";
import { DataTable, type DataColumn } from "@/components/data-table";
import { PlayerHover } from "@/components/PlayerHover";
import { QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { fmtInt, fmtPct, plural, shortId } from "@/lib/format";
import { isoDate } from "@/lib/filters";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { ChurnBucket, ChurnPlayer, ChurnResult, Filters } from "@/lib/types";

export const CHURN_LABELS: Record<ChurnBucket, { label: string; tone: string; hint: string }> = {
	active: { label: "Active", tone: "var(--status-good)", hint: "playing on their usual rhythm" },
	at_risk: { label: "At risk", tone: "var(--status-warning)", hint: "late for their usual gap between play days, or playing half as often as the two weeks before" },
	lapsing: { label: "Lapsing", tone: "var(--status-serious)", hint: "away 14+ days, or over 3x their usual gap" },
	churned: { label: "Churned", tone: "var(--status-critical)", hint: "away 28+ days" },
};
const BUCKETS = Object.keys(CHURN_LABELS) as ChurnBucket[];

/** Churn is measured over the last 90 days to today, whatever the range (a 1-day range can't say who lapsed). */
export const CHURN_DAYS = 90;

/** The filter bar's filters with the range replaced by the last 90 days. */
export function churnFilters(filters: Filters, now = Date.now()): Filters {
	const { from: _from, to: _to, ...rest } = filters;
	return { ...rest, from: isoDate(now - (CHURN_DAYS - 1) * 86_400_000) };
}

export function ChurnBadge({ bucket }: { bucket: ChurnBucket }) {
	const b = CHURN_LABELS[bucket];
	return (
		<Badge variant="outline" className="gap-1.5 font-normal" title={b.hint}>
			<span className="size-2 rounded-full" style={{ backgroundColor: b.tone }} />
			{b.label}
		</Badge>
	);
}

const OPTIN: Record<string, string> = { subscribed: "Subscribed", not_subscribed: "Not subscribed" };

function churnColumns(withOptin: boolean): DataColumn<ChurnPlayer>[] {
	return [
		{
			id: "pid",
			header: "Player",
			accessor: (p) => p.pid,
			searchText: (p) => [p.uid !== undefined ? `UserId ${p.uid}` : "", p.name ?? "", p.displayName ?? ""].join(" "),
			cell: (p) => (
				<>
					<PlayerHover pid={p.pid} uid={p.uid}>
						<span className="font-mono">{shortId(p.pid, 10)}</span>
					</PlayerHover>
					{p.name ? <div className="text-muted-foreground">@{p.name}</div> : p.uid !== undefined ? <div className="text-muted-foreground tabular-nums">UserId {p.uid}</div> : null}
				</>
			),
		},
		{ id: "bucket", header: "Risk", accessor: (p) => CHURN_LABELS[p.bucket].label, cell: (p) => <ChurnBadge bucket={p.bucket} /> },
		{ id: "lastPlayed", header: "Last played", type: "date", accessor: (p) => p.lastPlayed, className: "tabular-nums" },
		{ id: "daysSince", header: "Days away", title: "Days since the last play day (UTC)", accessor: (p) => p.daysSince, cell: (p) => fmtInt(p.daysSince) },
		{
			id: "usualGap",
			header: "Usual gap",
			title: "The median days between their play days (one play day: none)",
			accessor: (p) => p.usualGap,
			cell: (p) => (p.usualGap === null ? "–" : plural(p.usualGap, "day")),
			format: (_v, p) => (p.usualGap === null ? "" : String(p.usualGap)),
		},
		{ id: "playDays", header: "Play days", title: "Days with a session in the last 90 days", accessor: (p) => p.playDays, cell: (p) => fmtInt(p.playDays) },
		{
			id: "trend",
			header: "Last 14 d / before",
			title: "Play days in the last 14 days, and in the 14 days before",
			accessor: (p) => p.recentDays - p.priorDays,
			cell: (p) => (
				<span className={cn("tabular-nums", p.priorDays >= 3 && p.recentDays * 2 <= p.priorDays && "text-[var(--status-serious)]")}>
					{p.recentDays} / {p.priorDays}
				</span>
			),
			format: (_v, p) => `${p.recentDays} / ${p.priorDays}`,
		},
		...(withOptin
			? [
					{
						id: "optin",
						header: "Notifications",
						title: "The notification opt-in the backend learned from Roblox's replies to sends (owners only)",
						accessor: (p: ChurnPlayer) => (p.optin ? (OPTIN[p.optin] ?? p.optin) : "Unknown"),
						cell: (p: ChurnPlayer) => (p.optin === "subscribed" ? <Badge variant="secondary">Subscribed</Badge> : <span className="text-muted-foreground">{p.optin ? (OPTIN[p.optin] ?? p.optin) : "Unknown"}</span>),
					} satisfies DataColumn<ChurnPlayer>,
				]
			: []),
		{ id: "uid", header: "UserId", type: "text", accessor: (p) => (p.uid === undefined ? null : String(p.uid)), defaultHidden: true },
		{ id: "firstPlayed", header: "First played", type: "date", accessor: (p) => p.firstPlayed, defaultHidden: true },
	];
}

/** The four bucket tiles; the picked one is outlined. */
function BucketTiles({ data, picked, onPick }: { data: ChurnResult; picked: ChurnBucket; onPick(b: ChurnBucket): void }) {
	return (
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Churn risk buckets">
			{BUCKETS.map((b) => {
				const row = data.buckets.find((x) => x.bucket === b);
				const payers = data.payers[b] ?? 0;
				return (
					<button
						key={b}
						type="button"
						aria-pressed={b === picked}
						onClick={() => onPick(b)}
						title={CHURN_LABELS[b].hint}
						className={cn("rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/60", b === picked ? "border-primary ring-1 ring-primary" : "border-border")}
					>
						<div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
							<span className="size-2 rounded-full" style={{ backgroundColor: CHURN_LABELS[b].tone }} />
							{CHURN_LABELS[b].label}
						</div>
						<div className="text-xl font-semibold tabular-nums">{fmtInt(row?.players ?? 0)}</div>
						<div className="text-xs text-muted-foreground tabular-nums">
							{fmtPct(row?.share ?? 0, 1)} of players{payers ? `, ${plural(payers, "payer")}` : ""}
						</div>
					</button>
				);
			})}
		</div>
	);
}

export function ChurnRisk({ onPick }: { onPick(pid: string): void }) {
	const { apiFilters } = useFilters();
	const [raw, setBucket] = useParam("risk", "at_risk");
	const bucket: ChurnBucket = raw in CHURN_LABELS ? (raw as ChurnBucket) : "at_risk";
	const filters = useMemo(() => churnFilters(apiFilters), [apiFilters]);
	const q = useAnalytics("churn", { bucket, limit: 500 }, { filters, keepPrevious: true });
	const withOptin = Boolean(q.data?.list.some((p) => "optin" in p));
	const columns = useMemo(() => churnColumns(withOptin), [withOptin]);
	return (
		<Section
			title="Churn risk"
			description={`Each player's last play day against their own usual gap between play days, as of today over the last ${CHURN_DAYS} days (the filter bar's other filters pick the players). Pick a bucket to list its players, the most play days first.`}
			contentClassName="space-y-3"
		>
			<QueryState query={q} isEmpty={(d) => d.players === 0} empty="No players in the last 90 days.">
				{(data) => (
					<>
						<BucketTiles data={data} picked={bucket} onPick={setBucket} />
						<p className="text-xs text-muted-foreground">
							{CHURN_LABELS[bucket].label}: {CHURN_LABELS[bucket].hint}.{" "}
							{data.more > 0 ? `The first ${fmtInt(data.list.length)} of ${fmtInt(data.total)}.` : `${plural(data.total, "player")}.`}
							{withOptin && bucket !== "active" ? ` ${plural(data.list.filter((p) => p.optin === "subscribed").length, "of them is", "of them are")} subscribed to notifications (a win-back send can reach them).` : ""}
						</p>
						<DataTable id="players-churn" label="Churn risk players" columns={columns} data={data.list} rowId={(p) => p.pid} density="compact" onRowClick={(p) => onPick(p.pid)} maxHeight="22rem" />
					</>
				)}
			</QueryState>
		</Section>
	);
}
