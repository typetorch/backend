/**
 * The player detail's Spending, Playtime and Sessions views: a few numbers, the line over the date range (or the same
 * numbers as a table), and the purchases or sessions themselves. All from one `player-stats` answer.
 */
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common";
import { ProductId } from "@/components/ProductId";
import { JobLink } from "@/pages/server/shared";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { fmtInt, fmtMinutes, fmtNum, fmtTime, shortId } from "@/lib/format";
import type { PlayerPurchase, PlayerSessionRow, PlayerStatsResult } from "@/lib/types";
import { SeriesView, ShowToggle, useBucketColumns, type Metric, type Show } from "./SeriesView";

const robux = (v: number) => `${fmtInt(v)} Robux`;
const ROBUX: Metric = { key: "robux", label: "Robux", format: robux, axis: (v) => fmtInt(v) };
const PURCHASES: Metric = { key: "purchases", label: "Purchases", format: (v) => fmtInt(v) };
const MINUTES: Metric = { key: "minutes", label: "Minutes played", format: (v) => fmtMinutes(v), axis: (v) => fmtNum(v, 0), decimals: true };
const SESSIONS: Metric = { key: "sessions", label: "Sessions", format: (v) => fmtInt(v) };
const SPENDING_COLUMNS = [ROBUX, PURCHASES];
const PLAYTIME_COLUMNS = [MINUTES, SESSIONS];
const SESSIONS_COLUMNS = [SESSIONS, MINUTES];

export interface ViewProps {
	stats: PlayerStatsResult;
	show: Show;
	onShow(next: Show): void;
}

/** A row of small numbers inside the container (bordered tiles, not cards). */
function Numbers({ items }: { items: [string, ReactNode][] }) {
	return (
		<dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
			{items.map(([label, value]) => (
				<div key={label} className="rounded-lg border px-3 py-2">
					<dt className="text-xs text-muted-foreground">{label}</dt>
					<dd className="text-base font-semibold tabular-nums">{value}</dd>
				</div>
			))}
		</dl>
	);
}

function Heading({ children, show, onShow }: { children: ReactNode; show?: Show; onShow?(next: Show): void }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<h3 className="text-sm font-medium">{children}</h3>
			{show && onShow ? <ShowToggle value={show} onChange={onShow} /> : null}
		</div>
	);
}

const per = (stats: PlayerStatsResult) => stats.window.bucket;

// Spending -------------------------------------------------------------------------------------------------------------

const PURCHASE_COLUMNS: DataColumn<PlayerPurchase>[] = [
	{ id: "time", header: "Time (UTC)", type: "date", accessor: (p) => p.t, cell: (p) => fmtTime(p.time), format: (_v, p) => fmtTime(p.time), className: "font-mono text-xs tabular-nums" },
	{ id: "product", header: "Product", type: "text", accessor: (p) => p.product, cell: (p) => <ProductId id={p.product} kind={p.kind} showName />, className: "max-w-[16rem] text-xs" },
	{ id: "price", header: "Price", type: "number", accessor: (p) => p.robux, cell: (p) => (p.robux === null ? "–" : robux(p.robux)), align: "right" },
	{ id: "where", header: "Where", type: "enum", accessor: (p) => p.where },
	{ id: "kind", header: "Kind", type: "enum", accessor: (p) => p.kind, defaultHidden: true },
	{ id: "sid", header: "Session", type: "text", accessor: (p) => p.sid, cell: (p) => shortId(p.sid), className: "font-mono text-xs", defaultHidden: true },
];

export function SpendingView({ stats, show, onShow }: ViewProps) {
	const t = stats.totals;
	const bucket = per(stats);
	const columns = useBucketColumns(bucket, SPENDING_COLUMNS);
	return (
		<div className="space-y-4">
			<Numbers
				items={[
					["Total spending", robux(t.robux)],
					["Purchases", fmtInt(t.purchases)],
					["Avg per purchase", t.purchases ? `${fmtNum(t.robux / t.purchases, 1)} Robux` : "–"],
					["Per day", `${fmtNum(t.robux / stats.window.days, 1)} Robux`],
				]}
			/>
			<Heading show={show} onShow={onShow}>
				Robux per {bucket}
			</Heading>
			<SeriesView id="player-spending" series={stats.series} bucket={bucket} metric={ROBUX} columns={columns} show={show} empty="No Robux spent in this range." />
			<Heading>Purchases</Heading>
			{stats.purchases.length ? (
				<>
					<DataTable id="player-purchases" label="Purchases" columns={PURCHASE_COLUMNS} data={stats.purchases} rowId={(p, i) => `${p.t}-${i}`} density="compact" maxHeight="24rem" />
					{stats.purchasesTruncated ? <p className="text-xs text-muted-foreground">Showing the newest {fmtInt(stats.purchases.length)} purchases.</p> : null}
				</>
			) : (
				<EmptyState>No purchases in this range.</EmptyState>
			)}
		</div>
	);
}

// Playtime -------------------------------------------------------------------------------------------------------------

export function PlaytimeView({ stats, show, onShow }: ViewProps) {
	const t = stats.totals;
	const bucket = per(stats);
	const columns = useBucketColumns(bucket, PLAYTIME_COLUMNS);
	return (
		<div className="space-y-4">
			<Numbers
				items={[
					["Total playtime", fmtMinutes(t.playtimeMinutes)],
					["Avg per day", fmtMinutes(t.playtimePerDayMinutes)],
					["Per active day", t.activeDays ? fmtMinutes(t.playtimeMinutes / t.activeDays) : "–"],
					["Active days", `${fmtInt(t.activeDays)} of ${fmtInt(stats.window.days)}`],
				]}
			/>
			<Heading show={show} onShow={onShow}>
				Minutes played per {bucket}
			</Heading>
			<SeriesView id="player-playtime" series={stats.series} bucket={bucket} metric={MINUTES} columns={columns} show={show} empty="No playtime in this range: widen the date range." />
		</div>
	);
}

// Sessions -------------------------------------------------------------------------------------------------------------

const SESSION_COLUMNS: DataColumn<PlayerSessionRow>[] = [
	{ id: "start", header: "Started (UTC)", type: "date", accessor: (s) => s.start, cell: (s) => fmtTime(s.start), format: (_v, s) => fmtTime(s.start), className: "font-mono text-xs tabular-nums" },
	{ id: "length", header: "Length", type: "number", accessor: (s) => s.minutes, cell: (s) => fmtMinutes(s.minutes), format: (_v, s) => fmtMinutes(s.minutes), hint: "minutes", align: "right" },
	{ id: "events", header: "Events", type: "number", accessor: (s) => s.events, cell: (s) => fmtInt(s.events), align: "right" },
	{ id: "dev", header: "Device", type: "enum", accessor: (s) => s.dev },
	{ id: "first", header: "First", type: "boolean", accessor: (s) => s.firstSession, cell: (s) => (s.firstSession ? <Badge variant="secondary">first session</Badge> : null) },
	{
		id: "server",
		header: "Server",
		type: "text",
		title: "The game server it ran on: opens its page (its heartbeats, the errors it reported)",
		accessor: (s) => s.job ?? null,
		// The row opens the session's timeline; the link opens the server instead.
		cell: (s) => (s.job ? <span onClick={(e) => e.stopPropagation()}><JobLink job={s.job} /></span> : "–"),
		className: "font-mono text-xs",
	},
	{ id: "art", header: "Artifact", type: "text", accessor: (s) => s.art, className: "font-mono text-xs", defaultHidden: true },
	{ id: "sid", header: "sid", type: "text", accessor: (s) => s.sid, cell: (s) => shortId(s.sid), className: "font-mono text-xs", defaultHidden: true },
];

export function SessionsView({ stats, show, onShow, onSession }: ViewProps & { onSession(sid: string): void }) {
	const t = stats.totals;
	const bucket = per(stats);
	const columns = useBucketColumns(bucket, SESSIONS_COLUMNS);
	return (
		<div className="space-y-4">
			<Numbers
				items={[
					["Sessions", fmtInt(t.sessions)],
					["Avg length", fmtMinutes(t.avgSessionMinutes)],
					["Median length", fmtMinutes(t.medianSessionMinutes)],
					["Events", fmtInt(t.events)],
				]}
			/>
			<Heading show={show} onShow={onShow}>
				Sessions per {bucket}
			</Heading>
			<SeriesView id="player-sessions-per" series={stats.series} bucket={bucket} metric={SESSIONS} columns={columns} show={show} empty="No sessions in this range: widen the date range." />
			<Heading>Each session</Heading>
			{stats.sessions.length ? (
				<>
					<DataTable
						id="player-sessions"
						label="Sessions"
						columns={SESSION_COLUMNS}
						data={stats.sessions}
						rowId={(s) => s.sid}
						density="compact"
						maxHeight="24rem"
						onRowClick={(s) => onSession(s.sid)}
					/>
					<p className="text-xs text-muted-foreground">
						{stats.sessionsTruncated ? `Showing the newest ${fmtInt(stats.sessions.length)} sessions. ` : ""}Click a session for its events and graph.
					</p>
				</>
			) : (
				<EmptyState>No sessions in this range.</EmptyState>
			)}
		</div>
	);
}
