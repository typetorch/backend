/**
 * The deploy history (GET /v1/fleet/deploys, GET /v1/fleet/deploys/<seq>), mirrored from backend/src/fleet/deploys.ts
 * (copied, not imported), and the pure helpers the Deploys pages, the chart markers and their tests share.
 */
import type { DeployMark } from "./perf";
import type { ErrorKind, ErrorList, FleetAlert, FleetReports } from "./types";

// Answers ---------------------------------------------------------------------------------------------------------------

export type DeployOutcome = "pending" | "ok" | "partial" | "failed" | "stuck" | "no_reports";
/** Worst first (the outcome column's sort and filter order). */
export const DEPLOY_OUTCOMES_ORDER: DeployOutcome[] = ["failed", "partial", "stuck", "pending", "no_reports", "ok"];

export interface DeployRecord {
	seq: number;
	branch: string | null;
	artifact: string | null;
	channel: string | null;
	kind: string;
	/** Known only from its servers' reports (no CLI post). */
	inferred: boolean;
	from: string | null;
	message: string | null;
	startedBy: string | null;
	at: number;
	startedAt: string;
	reported: number;
	ok: number;
	failed: number;
	stuck: number;
	results: Record<string, number>;
	errors: { error: string; servers: number }[];
	errorKinds: number;
	firstReport: string | null;
	lastReport: string | null;
	outcome: DeployOutcome;
	/** The counts were kept on the row once the reports were about to go (no per-server report any more). */
	frozen: boolean;
}

export interface DeployPage {
	deploys: DeployRecord[];
	/** The cursor for the page after (`before`), null at the end. */
	next: number | null;
}

export interface DeployNeighbor {
	seq: number;
	kind: string;
	artifact: string | null;
	at: number;
}

export interface DeployDetail {
	deploy: DeployRecord;
	report: FleetReports | null;
	alerts: FleetAlert[];
	previous: DeployNeighbor | null;
	next: DeployNeighbor | null;
}

// Words and tones -------------------------------------------------------------------------------------------------------

export const OUTCOME_STYLE: Record<DeployOutcome, { label: string; tone: string; help: string }> = {
	pending: { label: "Pending", tone: "bg-[var(--status-warning)]", help: "No server reported yet; the stuck check is still running." },
	ok: { label: "OK", tone: "bg-[var(--status-good)]", help: "Every server that reported runs it." },
	partial: { label: "Partly failed", tone: "bg-[var(--status-warning)]", help: "Some servers failed or rolled back, others run it." },
	failed: { label: "Failed", tone: "bg-[var(--status-critical)]", help: "Every server that reported failed or rolled back." },
	stuck: { label: "Stuck", tone: "bg-[var(--status-warning)]", help: "Servers sent no report 3 minutes after the start." },
	no_reports: { label: "No reports", tone: "bg-muted-foreground", help: "No server reported it (or its reports were gone before the history kept them)." },
};

/** "auto_rollback", "alice", "CLI", or "server reports" when only the servers told the backend. */
export function startedByText(d: Pick<DeployRecord, "startedBy" | "inferred">): string {
	return d.startedBy ?? (d.inferred ? "server reports" : "CLI");
}

/** "Deploy #42 prod", "Rollback #43 prod". */
export function deployTitle(d: Pick<DeployRecord, "kind" | "seq" | "branch">): string {
	const kind = d.kind === "resign" ? "Re-sign" : `${d.kind.slice(0, 1).toUpperCase()}${d.kind.slice(1)}`;
	return [kind, `#${d.seq}`, d.branch].filter(Boolean).join(" ");
}

/** The seq a release mark opens on the deploy page (kernel and backup marks open nothing). */
export function markDeploySeq(m: Pick<DeployMark, "id" | "seq">): number | null {
	return m.id.startsWith("deploy:") && m.seq !== null ? m.seq : null;
}

/** The short label on a chart marker: "#42 prod", "kernel 0.4.0". */
export function markLabel(m: Pick<DeployMark, "kind" | "seq" | "branch" | "kernel">): string {
	if (m.kind === "kernel") return `kernel${m.kernel ? ` ${m.kernel}` : ""}`;
	return [m.seq !== null ? `#${m.seq}` : m.kind, m.branch].filter(Boolean).join(" ");
}

// Markers on category (bar) charts ----------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A bar label's start time: "2026-10-08" (a UTC day) or "2026-10-08 14:05" (a step); NaN otherwise. */
export function labelTime(label: string): number {
	if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return Date.parse(`${label}T00:00:00Z`);
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(label)) return Date.parse(`${label.replace(" ", "T")}:00Z`);
	return Number.NaN;
}

/**
 * The bar a moment falls in: `starts` are the bars' start times, oldest first; each bar runs to the next one's start, the
 * last as long as the one before it (a day when there is one). -1 outside them all.
 */
export function bucketIndex(at: number, starts: readonly number[]): number {
	if (!starts.length || !(at >= starts[0])) return -1;
	const last = starts[starts.length - 1];
	const step = starts.length > 1 ? last - starts[starts.length - 2] : DAY_MS;
	if (at >= last + step) return -1;
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (starts[mid] <= at) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Marks that land on the same spot (one bar, or one x on a time axis): one line, every mark in its hover card. */
export interface MarkGroup {
	x: number | string;
	marks: DeployMark[];
}

/** Groups marks by where they go (`place` answers undefined for a mark off the chart), in the marks' order. */
export function groupMarks(marks: readonly DeployMark[], place: (m: DeployMark) => number | string | undefined): MarkGroup[] {
	const groups = new Map<number | string, DeployMark[]>();
	for (const m of marks) {
		const x = place(m);
		if (x === undefined) continue;
		groups.set(x, [...(groups.get(x) ?? []), m]);
	}
	return [...groups].map(([x, ms]) => ({ x, marks: ms }));
}

/** Places marks on bars labelled like DayBars / the error series ("YYYY-MM-DD" or "YYYY-MM-DD hh:mm"). */
export function placeOnLabels(labels: readonly string[]): (m: DeployMark) => string | undefined {
	const starts = labels.map(labelTime);
	const ok = starts.every(Number.isFinite);
	return (m) => {
		if (!ok) return undefined;
		const i = bucketIndex(m.at, starts);
		return i < 0 ? undefined : labels[i];
	};
}

// Before vs after -------------------------------------------------------------------------------------------------------

/** Window lengths offered on the deploy page (hours). */
export const IMPACT_HOURS = [1, 6, 24, 72];
/** Less than this since the deploy: nothing to compare yet. */
export const IMPACT_MIN_MS = 5 * 60_000;

/** Two equal windows around a deploy: `hours` long, shortened to the time since it when that is less; null under 5 minutes. */
export function impactWindows(at: number, hours: number, now: number): { before: { from: number; to: number }; after: { from: number; to: number }; ms: number } | null {
	const ms = Math.min(hours * 3_600_000, Math.floor((now - at) / 60_000) * 60_000);
	if (ms < IMPACT_MIN_MS) return null;
	return { before: { from: at - ms, to: at }, after: { from: at, to: at + ms }, ms };
}

export interface ErrorChange {
	fp: string;
	template: string;
	realm: string;
	before: number;
	after: number;
	/** Seen after the deploy and not in the window before it. */
	isNew: boolean;
}

/** Error kinds in either window with their counts before and after, new ones first, then by the count after. */
export function errorChanges(before: ErrorList, after: ErrorList): ErrorChange[] {
	const byFp = new Map<string, ErrorChange>();
	const add = (k: ErrorKind, side: "before" | "after") => {
		const row = byFp.get(k.fp) ?? { fp: k.fp, template: k.template, realm: k.realm, before: 0, after: 0, isNew: false };
		row[side] += k.count;
		byFp.set(k.fp, row);
	};
	for (const k of before.kinds) add(k, "before");
	for (const k of after.kinds) add(k, "after");
	// A kind past the before list's limit may have happened before too: "new" only when that list is complete.
	const complete = !before.more;
	const rows = [...byFp.values()].map((r) => ({ ...r, isNew: complete && r.after > 0 && r.before === 0 }));
	return rows.sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.after - a.after || b.before - a.before || a.fp.localeCompare(b.fp));
}
