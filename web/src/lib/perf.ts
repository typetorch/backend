/**
 * The Performance page's data: the backend's perf-client / perf-server / perf-compare answers, chart marks
 * (GET /v1/fleet/marks) and the per-server metrics contract (GET /v1/fleet/servers/:jobId/metrics, from the
 * heartbeat-metrics backend), mirrored from backend/src/queries/perf.ts and src/fleet/service.ts (copied, not
 * imported), plus the pure helpers the page and its tests share.
 */
import type { FleetServer } from "./types";

// Answers ---------------------------------------------------------------------------------------------------------------

export type PerfGroupBy = "none" | "dev" | "input" | "screen" | "branch" | "art";
export type Percentile = "p10" | "p50" | "p90" | "p99";
export const PERCENTILES: Percentile[] = ["p10", "p50", "p90", "p99"];

/**
 * The percentile that shows a metric's worst case, the same for every metric: p90 / p99 are on the bad side (fps and TPS: the
 * 10th and the 1st percentile; memory and ping: the 90th and the 99th), so p99 is the most extreme either way. p10 is the plain
 * 10th percentile: for fps and TPS the same value as p90 (p99 is below it), for memory and ping the best case.
 */
export const WORST_PERCENTILE: Percentile = "p99";

/** A percentile's name for headers and chart titles: "p50", "p99 (worst)". */
export function percentileName(p: Percentile): string {
	return p === WORST_PERCENTILE ? `${p} (worst)` : p;
}

/** One metric over a group of samples. p10 is the plain 10th percentile; p90 / p99 are on the bad side (low for fps and tps, high for mem and ping). */
export interface PerfStat {
	p10: number | null;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	avg: number | null;
	n: number;
}

export interface PerfGroup {
	key: string;
	samples: number;
	sessions?: number;
	players?: number;
	servers?: number;
	seq: number | null;
	firstSeen: string | null;
	lastSeen: string | null;
	metrics: Record<string, PerfStat>;
}

export interface PerfPoint {
	t: number;
	key: string;
	samples: number;
	metrics: Record<string, PerfStat>;
	players?: number;
	servers?: number;
}

export interface PerfSeriesResult {
	side: "client" | "server";
	from: string;
	to: string;
	fromMs: number;
	toMs: number;
	bucketMs: number;
	by: PerfGroupBy;
	metrics: { key: string; higherIsBetter: boolean }[];
	overall: PerfGroup;
	groups: PerfGroup[];
	groupsTotal: number;
	series: PerfPoint[];
}

export interface ComparePeriod {
	key: string;
	from: string;
	to: string;
	client: { samples: number; sessions: number; players: number; metrics: Record<string, PerfStat> };
	server: { samples: number; servers: number; avgPlayers: number | null; metrics: Record<string, PerfStat> };
	seq?: number | null;
}

export interface PerfCompareResult {
	mode: "builds" | "around";
	at?: string;
	atMs?: number;
	windowMs?: number;
	clientMetrics: { key: string; higherIsBetter: boolean }[];
	serverMetrics: { key: string; higherIsBetter: boolean }[];
	periods: ComparePeriod[];
}

export type MarkKind = "deploy" | "rollback" | "promote" | "resign" | "kernel" | "backup";

/** A vertical mark on the charts: a release, a kernel publish or a backup refresh. */
export interface DeployMark {
	id: string;
	kind: MarkKind;
	at: number;
	time: string;
	branch: string | null;
	seq: number | null;
	artifact: string | null;
	channel: string | null;
	from: string | null;
	kernel: string | null;
	placeVersion: number | null;
	message: string | null;
	results?: Record<string, number>;
	inferred?: boolean;
}

/** One point of a server's own history (GET /v1/fleet/servers/:jobId/metrics, the heartbeat-metrics contract). */
export interface ServerMetricPoint {
	t: number;
	tps: number | null;
	tpsMin: number | null;
	physFps: number | null;
	memMb: number | null;
	luaMb: number | null;
	players: number | null;
}

/** A live server; the heartbeat-metrics fields (tps, tpsMin, physFps, memMb, luaMb) are on FleetServer, missing before kernel 0.4.2. */
export type PerfServer = FleetServer;

// Metrics -----------------------------------------------------------------------------------------------------------------

export interface MetricInfo {
	label: string;
	unit: string;
	higherIsBetter: boolean;
	digits: number;
	/** One line under the chart title. */
	about: string;
}

export const METRICS: Record<string, MetricInfo> = {
	fps: { label: "Frame rate", unit: "fps", higherIsBetter: true, digits: 0, about: "Client frames per second (tech/client, every techEvery s per player)." },
	mem: { label: "Memory", unit: "MB", higherIsBetter: false, digits: 0, about: "Memory in MB, as the engine reports it (10 MB steps)." },
	ping: { label: "Ping", unit: "ms", higherIsBetter: false, digits: 0, about: "Round trip to the server in ms." },
	tps: { label: "Server TPS", unit: "/s", higherIsBetter: true, digits: 1, about: "Heartbeat steps a second on the server (60 when it keeps up)." },
	physFps: { label: "Physics FPS", unit: "fps", higherIsBetter: true, digits: 1, about: "Physics steps a second on the server." },
	players: { label: "Players", unit: "", higherIsBetter: true, digits: 0, about: "Players on the servers that report, summed." },
};

export const CLIENT_METRIC_KEYS = ["fps", "mem", "ping"] as const;
export const SERVER_METRIC_KEYS = ["tps", "physFps", "mem"] as const;

export function fmtMetric(key: string, value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "–";
	const info = METRICS[key];
	const digits = info?.digits ?? 1;
	const text = new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
	return info?.unit ? `${text} ${info.unit}`.replace(" /s", "/s") : text;
}

export const PERCENTILE_HELP: Record<Percentile, string> = {
	p10: "10% of samples are this low or lower (the low end: for fps and TPS the same as p90, for memory and ping the best case)",
	p50: "the median sample",
	p90: "90% of samples are this good or better",
	p99: "99% of samples are this good or better (the worst case)",
};

// Groups ------------------------------------------------------------------------------------------------------------------

export const GROUP_BY_LABELS: Record<PerfGroupBy, string> = {
	none: "Everything",
	dev: "Device class",
	input: "Input",
	screen: "Screen size",
	branch: "Branch",
	art: "Build",
};
export const CLIENT_GROUPS: PerfGroupBy[] = ["none", "dev", "input", "screen", "branch", "art"];
export const SERVER_GROUPS: PerfGroupBy[] = ["none", "branch", "art"];

const KEY_LABELS: Partial<Record<PerfGroupBy, Record<string, string>>> = {
	dev: { desktop: "Desktop", phone: "Phone", tablet: "Tablet", console: "Console", vr: "VR", unknown: "Unknown" },
	input: { kbm: "Keyboard and mouse", touch: "Touch", gamepad: "Gamepad", vr: "VR", unknown: "Unknown" },
	screen: { "<400": "Under 400 pt", "400-599": "400-599 pt", "600-799": "600-799 pt", "800-1079": "800-1079 pt", "1080+": "1080 pt and up", unknown: "Unknown" },
};

/** A group's name for people: "Phone", "Under 400 pt" (the viewport's short side), "e4f5a6b #42". */
export function groupLabel(by: PerfGroupBy, key: string, seq?: number | null): string {
	if (by === "none") return "All";
	if (by === "art") return seq ? `${key} #${seq}` : key;
	return KEY_LABELS[by]?.[key] ?? key;
}

/** A color per series slot (chart-1..8), in order. */
export const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)"];

// Series -> chart rows ----------------------------------------------------------------------------------------------------

export interface ChartSeries {
	/** A CSS-safe id ("s0", "s1"...): group keys can hold "<", "+" or dots. */
	id: string;
	key: string;
	label: string;
	color: string;
	/** Drawn dashed (the previous period, under "vs previous period"). */
	dashed?: boolean;
}

export type ChartRow = { t: number } & Record<string, number | null>;

/** Every bucket from the start to the end, so gaps show as breaks in the line. At most 400 (the backend's own bound). */
export function bucketTimes(fromMs: number, toMs: number, bucketMs: number): number[] {
	const out: number[] = [];
	if (!(bucketMs > 0)) return out;
	for (let t = Math.floor(fromMs / bucketMs) * bucketMs; t < toMs && out.length < 400; t += bucketMs) out.push(t);
	return out;
}

/** The kept groups as chart series, busiest first. */
export function seriesOf(result: Pick<PerfSeriesResult, "by" | "groups">): ChartSeries[] {
	return result.groups.map((g, i) => ({ id: `s${i}`, key: g.key, label: groupLabel(result.by, g.key, g.seq), color: SERIES_COLORS[i % SERIES_COLORS.length] }));
}

/** One row per bucket: `{ t, s0, s1, ... }` with the metric's percentile per group (null: no samples). */
export function pivot(result: PerfSeriesResult, metric: string, percentile: Percentile | "players"): ChartRow[] {
	const series = seriesOf(result);
	const idOf = new Map(series.map((s) => [s.key, s.id]));
	const byTime = new Map<number, ChartRow>();
	for (const t of bucketTimes(result.fromMs, result.toMs, result.bucketMs)) byTime.set(t, { t, ...Object.fromEntries(series.map((s) => [s.id, null])) } as ChartRow);
	for (const p of result.series) {
		const id = idOf.get(p.key);
		if (!id) continue;
		const row = byTime.get(p.t) ?? ({ t: p.t, ...Object.fromEntries(series.map((s) => [s.id, null])) } as ChartRow);
		row[id] = percentile === "players" ? (p.players ?? null) : (p.metrics[metric]?.[percentile] ?? null);
		byTime.set(p.t, row);
	}
	return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** "15 min", "2 h", "1 d". */
export function bucketText(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
	return `${Math.round(minutes / 1440)} d`;
}

/** Axis ticks: "10-09 14:00" for short ranges, "10-09" for long ones (UTC, like the rest of the explorer). */
export function timeTick(t: number, spanMs: number): string {
	const iso = new Date(t).toISOString();
	return spanMs <= 3 * 86_400_000 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(5, 10);
}

// Marks -------------------------------------------------------------------------------------------------------------------

export const MARK_KINDS: MarkKind[] = ["deploy", "rollback", "promote", "resign", "kernel", "backup"];

export const MARK_STYLE: Record<MarkKind, { label: string; color: string; dash?: string }> = {
	deploy: { label: "Deploy", color: "var(--chart-1)" },
	promote: { label: "Promote", color: "var(--chart-7)" },
	resign: { label: "Re-sign", color: "var(--muted-foreground)", dash: "2 3" },
	rollback: { label: "Rollback", color: "var(--status-critical)" },
	kernel: { label: "Kernel publish", color: "var(--chart-4)", dash: "6 3" },
	backup: { label: "Backup refresh", color: "var(--chart-3)", dash: "2 3" },
};

/** "Deploy #42 prod e4f5a6b", "Kernel publish 0.4.0", "Backup refresh #41 a1b2c3d". */
export function markTitle(m: DeployMark): string {
	const style = MARK_STYLE[m.kind];
	if (m.kind === "kernel") return `${style.label}${m.kernel ? ` ${m.kernel}` : ""}`;
	return [style.label, m.seq !== null ? `#${m.seq}` : null, m.branch, m.artifact].filter(Boolean).join(" ");
}

/** The detail lines for a mark's hover card and the selected-mark bar. */
export function markDetails(m: DeployMark): string[] {
	const lines = [new Date(m.at).toISOString().replace("T", " ").slice(0, 19) + " UTC"];
	if (m.from) lines.push(`from ${m.from}`);
	if (m.placeVersion !== null) lines.push(`place version ${m.placeVersion}`);
	if (m.results && Object.keys(m.results).length) lines.push(Object.entries(m.results).map(([r, n]) => `${n} ${r.replace("_", " ")}`).join(", "));
	if (m.inferred) lines.push("known from server reports only");
	if (m.message) lines.push(m.message);
	return lines;
}

/** Marks inside [from, to). */
export function marksIn(marks: DeployMark[], fromMs: number, toMs: number): DeployMark[] {
	return marks.filter((m) => m.at >= fromMs && m.at < toMs);
}

// Comparing ---------------------------------------------------------------------------------------------------------------

/** The relative change from `base` to `value` and whether it is better (null when either is missing or base is 0). */
export function delta(base: number | null | undefined, value: number | null | undefined, higherIsBetter: boolean): { pct: number; better: boolean | null } | null {
	if (base === null || base === undefined || value === null || value === undefined || base === 0) return null;
	const pct = ((value - base) / Math.abs(base)) * 100;
	const better = Math.abs(pct) < 0.5 ? null : higherIsBetter ? value > base : value < base;
	return { pct, better };
}

export function fmtDelta(d: ReturnType<typeof delta>): string {
	if (!d) return "–";
	const rounded = Math.round(d.pct * 10) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** Window lengths offered for before vs after. */
export const AROUND_HOURS = [1, 6, 24, 72, 168];

// The filter range in ms -----------------------------------------------------------------------------------------------------

/** The filters' time range in ms (as the backend resolves it: a date `from` is 00:00 UTC, a date `to` includes that day). */
export function rangeMs(filters: { from?: string; to?: string }, now = Date.now(), defaultDays = 7): { from: number; to: number } {
	const parse = (v: string, end: boolean) => {
		if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00Z`) + (end ? 86_400_000 : 0);
		return Date.parse(v);
	};
	const to = filters.to ? parse(filters.to, true) : now;
	const from = filters.from ? parse(filters.from, false) : to - defaultDays * 86_400_000;
	return { from, to };
}
