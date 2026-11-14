import { Link, useLocation } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { withFilters } from "@/lib/commands";
import { Metric, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { ConfusionResult } from "@/lib/types";

type Idle = NonNullable<ConfusionResult["recordings"]["idle"]>[number];
type Spin = NonNullable<ConfusionResult["recordings"]["cameraSpin"]>[number];
type Clicks = NonNullable<ConfusionResult["recordings"]["repeatedClicks"]>[number];

/** A 0-1 share as a bar and a percentage; it sorts by the share. */
function shareColumn<T>(id: string, header: string, get: (row: T) => number): DataColumn<T> {
	return {
		id,
		header,
		accessor: get,
		format: (value) => fmtPct(value as number),
		cell: (row) => (
			<div className="flex items-center justify-end gap-2">
				<ShareBar share={get(row)} className="w-20" tone={get(row) >= 0.5 ? "alert" : "default"} />
				<span className="w-12 text-right">{fmtPct(get(row))}</span>
			</div>
		),
		filter: false,
	};
}

const count = <T,>(id: string, header: string, get: (row: T) => number, defaultHidden = false): DataColumn<T> => ({
	id,
	header,
	accessor: get,
	cell: (row) => fmtInt(get(row)),
	defaultHidden,
});

const EARLY_LEAVE: DataColumn<ConfusionResult["earlyLeave"][number]>[] = [
	{ id: "zone", header: "Zone", accessor: (r) => r.zone, className: "whitespace-normal" },
	count("sessions", "Sessions", (r) => r.sessions),
	count("early", "Early", (r) => r.early),
	shareColumn("share", "Share", (r) => r.share),
];

const SCREEN_LOOPS: DataColumn<ConfusionResult["screenLoops"][number]>[] = [
	{ id: "screen", header: "Screen", accessor: (r) => r.screen, className: "whitespace-normal" },
	count("sessions", "Sessions", (r) => r.sessions),
	count("opens", "Opens", (r) => r.opens),
	count("loopSessions", "Looped sessions", (r) => r.loopSessions, true),
	shareColumn("share", "Looped", (r) => r.share),
];

const BACK_AND_FORTH: DataColumn<ConfusionResult["backAndForth"][number]>[] = [
	{ id: "zones", header: "Zones", accessor: (r) => `${r.a} / ${r.b}`, className: "whitespace-normal" },
	count("sessions", "Sessions", (r) => r.sessions),
	count("flagged", "Flagged sessions", (r) => r.flagged, true),
	shareColumn("share", "Flagged", (r) => r.share),
];

/** Opens the Recordings page's session list for one signal (keeping the filters), to replay the sessions behind it. */
export function ReplayLink({ signal, zone, target }: { signal: "idle" | "camera_spin" | "repeated_clicks"; zone?: string; target?: string }) {
	const { search } = useLocation();
	const extra: Record<string, string> = { tab: "replay", signal };
	if (zone && zone !== "(unknown)") extra.zone = zone;
	if (target && target !== "(unknown)") extra.target = target;
	return (
		<Link to={withFilters("/recordings", search, extra)} className="text-xs underline">
			Replays
		</Link>
	);
}

const replayColumn = <T,>(get: (row: T) => { signal: "idle" | "camera_spin" | "repeated_clicks"; zone?: string; target?: string }): DataColumn<T> => ({
	id: "replay",
	header: "Replay",
	accessor: () => "",
	cell: (row) => <ReplayLink {...get(row)} />,
	filter: false,
});

const IDLE: DataColumn<Idle>[] = [
	{ id: "zone", header: "Idle in zone", accessor: (r) => r.zone, className: "whitespace-normal" },
	count("count", "Times", (r) => r.count),
	{ id: "avg", header: "Avg", hint: "s", accessor: (r) => r.avgSeconds, cell: (r) => `${fmtNum(r.avgSeconds, 1)} s` },
	replayColumn((r) => ({ signal: "idle", zone: r.zone })),
];

const CAMERA_SPIN: DataColumn<Spin>[] = [
	{ id: "zone", header: "Camera spins in zone", accessor: (r) => r.zone, className: "whitespace-normal" },
	count("count", "Times", (r) => r.count),
	replayColumn((r) => ({ signal: "camera_spin", zone: r.zone })),
];

const REPEATED_CLICKS: DataColumn<Clicks>[] = [
	{ id: "button", header: "Button pressed again and again", accessor: (r) => r.button, className: "font-mono text-xs whitespace-normal" },
	count("count", "Times", (r) => r.count),
	{ id: "avgPresses", header: "Avg presses", accessor: (r) => r.avgPresses, cell: (r) => fmtNum(r.avgPresses, 1) },
	replayColumn((r) => ({ signal: "repeated_clicks", target: r.button })),
];

function SignalTable<T>({ id, rows, columns, empty }: { id: string; rows: readonly T[]; columns: DataColumn<T>[]; empty: string }) {
	return <DataTable id={`first-session-${id}`} label={id.replace(/-/g, " ")} columns={columns} data={rows} empty={<p className="text-sm text-muted-foreground">{empty}</p>} />;
}

function Body({ data }: { data: ConfusionResult }) {
	const rec = data.recordings;
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="First sessions" value={fmtInt(data.firstSessions)} />
				<Metric label="Players" value={fmtInt(data.players)} />
				<Metric
					label="Recorded sessions"
					value={rec.available ? fmtInt(rec.sessions ?? 0) : "none"}
					tone={rec.available ? undefined : "muted"}
					sub={rec.available ? `${fmtInt(rec.failedSessions ?? 0)} failed to decode` : rec.reason}
				/>
				<Metric label="Early leaves" value={fmtInt(data.earlyLeave.reduce((s, z) => s + z.early, 0))} sub="first sessions under 2 min" />
			</div>
			<div className="grid gap-4 xl:grid-cols-2">
				<Section className="min-w-0" title="Early leaves by zone" description="Zone the first session ended in; early = under 2 minutes.">
					<SignalTable id="early-leave" rows={data.earlyLeave} columns={EARLY_LEAVE} empty="No finished first session in this range." />
				</Section>
				<Section className="min-w-0" title="Screen loops" description="Screens opened 3+ times in one first session.">
					<SignalTable id="screen-loops" rows={data.screenLoops} columns={SCREEN_LOOPS} empty="No screens opened in first sessions." />
				</Section>
				<Section className="min-w-0" title="Back and forth" description="Two zones walked between 3+ times in one first session.">
					<SignalTable id="back-and-forth" rows={data.backAndForth} columns={BACK_AND_FORTH} empty="No zone changes in first sessions." />
				</Section>
				<Section className="min-w-0" title="From recordings" description="Idle 10 s+, camera spins (360 degrees in 6 s, not moving), 3 presses of one button in 2 s.">
					{rec.available ? (
						<div className="space-y-4">
							<SignalTable id="idle" rows={rec.idle ?? []} columns={IDLE} empty="No idle spots." />
							<SignalTable id="camera-spin" rows={rec.cameraSpin ?? []} columns={CAMERA_SPIN} empty="No camera spins." />
							<SignalTable id="repeated-clicks" rows={rec.repeatedClicks ?? []} columns={REPEATED_CLICKS} empty="No repeated clicks." />
						</div>
					) : (
						<p className="text-sm text-muted-foreground">No recordings: {rec.reason ?? "none in this range"}.</p>
					)}
				</Section>
			</div>
		</>
	);
}

export default function FirstSession() {
	const q = useAnalytics("confusion");
	const location = useLocation();
	return (
		<>
			<PageHeader
				title="First session"
				description="Signs that new players got lost in their first session, per zone and button."
				actions={
					<Link to={withFilters("/recordings", location.search)} className="text-sm underline">
						Maps, replays and quit autopsy
					</Link>
				}
			/>
			<QueryState query={q} isEmpty={(d) => d.firstSessions === 0} empty="No first sessions in this range.">
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
