/**
 * A live event's lift report: the event window against a fair baseline, plus the days after it (pull-forward).
 *
 * Windows (planLiftWindows):
 *   - event: [start, end), cut at now while it runs;
 *   - after: [end, end + afterDays), cut at now (the pull-forward check: did players just play earlier?);
 *   - baselines: the same weekdays and hours `step` earlier, for `weeks` weeks (default 3). `step` is a whole number of
 *     weeks covering the event and its after window, so a baseline never overlaps the event or another baseline. A
 *     candidate week that overlaps another (not cancelled) live event is skipped, and an earlier one taken (up to
 *     weeks + SKIP_MAX candidates); a week with no players at all (before the game had data) is dropped after the query.
 *
 * Metrics per window (metricsOf): players, playtime per player, sessions per player, Robux per player and payer
 * conversion (monetization's convention: payers / active players), new players; plus total playtime and Robux for the
 * net check.
 *
 * The math (liftOf), for one metric: baseline = the mean of the baseline weeks; lift = event / baseline - 1. The
 * spread is how much a normal week moves: each baseline week against the mean of the OTHER weeks (leave-one-out),
 * min to max. A lift above the spread's max is "up", below its min "down", inside it "flat" (no clear change); fewer
 * than 2 baseline weeks or a zero baseline: "unknown". Plain and hand-checkable, not a significance test: with 3 weeks
 * the band is the range of 3 numbers.
 *
 * The after window gets the same treatment; a "down" there on playtime or players is a dip after the event, i.e. part
 * of the gain was pulled forward. `net` adds the event and after windows for the totals (playtime, Robux, sessions,
 * new players): the change over both, which is what's left after any pull-forward.
 */
import type { LiftWindow, LiftWindowMetrics } from "../queries/live-event-lift.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Extra earlier weeks tried when candidate weeks overlap other events. */
export const SKIP_MAX = 4;
export const WEEKS_DEFAULT = 3;
export const WEEKS_MAX = 8;
export const AFTER_DAYS_DEFAULT = 3;
export const AFTER_DAYS_MAX = 7;

export interface LiftPlan {
	/** The windows to query, in this order: event, after (when any), then each baseline's event and after window. */
	windows: LiftWindow[];
	event: LiftWindow;
	after: LiftWindow | null;
	/** Weeks back of each baseline (1 = one step back), with their windows. */
	baselines: { weeksBack: number; event: LiftWindow; after: LiftWindow | null }[];
	skipped: { weeksBack: number; reason: string }[];
	/** The event isn't over yet (the window is cut at now). */
	partial: boolean;
	/** The after window isn't over yet (cut at now), or hasn't started. */
	afterPartial: boolean;
	stepDays: number;
	afterDays: number;
}

/** Plans the windows of an event's report. `others`: other events' windows (not cancelled) a baseline must not overlap. */
export function planLiftWindows(event: { start: number; end: number }, now: number, options: { weeks?: number; afterDays?: number }, others: LiftWindow[] = []): LiftPlan {
	const weeks = options.weeks ?? WEEKS_DEFAULT;
	const afterDays = options.afterDays ?? AFTER_DAYS_DEFAULT;
	if (event.end <= event.start) throw new Error("the event never ran (cancelled before its start)");
	if (now <= event.start) throw new Error("the event hasn't started: no report yet");
	const end = Math.min(event.end, now);
	const length = end - event.start;
	const afterMs = afterDays * DAY;
	const afterEnd = Math.min(event.end + afterMs, now);
	const after = afterMs > 0 && afterEnd > event.end ? { from: event.end, to: afterEnd } : null;
	// One step covers the whole event and its full after window, so shifted copies never overlap the original.
	const step = Math.max(1, Math.ceil((event.end - event.start + afterMs) / WEEK)) * WEEK;
	const baselines: LiftPlan["baselines"] = [];
	const skipped: LiftPlan["skipped"] = [];
	for (let back = 1; back <= weeks + SKIP_MAX && baselines.length < weeks; back++) {
		const shift = back * step;
		const ev = { from: event.start - shift, to: end - shift };
		const af = after ? { from: after.from - shift, to: after.to - shift } : null;
		const span = { from: ev.from, to: (af ?? ev).to };
		const clash = others.find((o) => o.from < span.to && span.from < o.to);
		if (clash) {
			skipped.push({ weeksBack: back, reason: `another live event ran then (${new Date(clash.from).toISOString().slice(0, 16)}Z)` });
			continue;
		}
		baselines.push({ weeksBack: back, event: ev, after: af });
	}
	const windows: LiftWindow[] = [{ from: event.start, to: end }];
	if (after) windows.push(after);
	for (const b of baselines) {
		windows.push(b.event);
		if (b.after) windows.push(b.after);
	}
	return {
		windows,
		event: { from: event.start, to: end },
		after,
		baselines,
		skipped,
		partial: end < event.end,
		afterPartial: after === null ? afterMs > 0 : after.to < event.end + afterMs,
		stepDays: step / DAY,
		afterDays,
	};
}

export const LIFT_METRICS = [
	{ key: "players", label: "players", kind: "count" },
	{ key: "playtimePerPlayer", label: "playtime per player", kind: "minutes" },
	{ key: "sessionsPerPlayer", label: "sessions per player", kind: "ratio" },
	{ key: "robuxPerPlayer", label: "Robux per player", kind: "robux" },
	{ key: "payerConversion", label: "payer conversion", kind: "share" },
	{ key: "newPlayers", label: "new players", kind: "count" },
] as const;
export type LiftMetricKey = (typeof LIFT_METRICS)[number]["key"];

/** The totals the net check adds up over the event and after windows. */
export const NET_METRICS = [
	{ key: "playtimeMinutes", label: "playtime" },
	{ key: "robux", label: "Robux" },
	{ key: "sessions", label: "sessions" },
	{ key: "newPlayers", label: "new players" },
] as const;
export type NetMetricKey = (typeof NET_METRICS)[number]["key"];

/** A window's metrics (null when it had no players: a per-player number has no base). */
export function metricsOf(m: LiftWindowMetrics): Record<LiftMetricKey, number | null> {
	const per = (value: number) => (m.players > 0 ? value / m.players : null);
	return {
		players: m.players,
		playtimePerPlayer: per(m.playtimeMinutes),
		sessionsPerPlayer: per(m.sessions),
		robuxPerPlayer: per(m.robux),
		payerConversion: per(m.payers),
		newPlayers: m.newPlayers,
	};
}

export type Direction = "up" | "down" | "flat" | "unknown";

export interface Lift {
	value: number | null;
	/** The mean of the baseline weeks. */
	baseline: number | null;
	/** value / baseline - 1 (null without a baseline). */
	lift: number | null;
	/** How much a normal week moved (leave-one-out, min to max); null with fewer than 2 weeks. */
	spread: { min: number; max: number } | null;
	/** Each baseline week's value, in weeksBack order. */
	weeks: (number | null)[];
	direction: Direction;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** The lift of one metric: the event value against the baseline weeks' values. */
export function liftOf(value: number | null, weeks: (number | null)[]): Lift {
	const known = weeks.filter((v): v is number => v !== null && Number.isFinite(v));
	const baseline = known.length ? mean(known) : null;
	const lift = value !== null && baseline !== null && baseline > 0 ? value / baseline - 1 : null;
	let spread: Lift["spread"] = null;
	if (known.length >= 2) {
		const deviations: number[] = [];
		for (let i = 0; i < known.length; i++) {
			const rest = mean(known.filter((_, j) => j !== i));
			if (rest > 0) deviations.push((known[i] as number) / rest - 1);
		}
		if (deviations.length >= 2) spread = { min: Math.min(...deviations), max: Math.max(...deviations) };
	}
	let direction: Direction = "unknown";
	if (lift !== null && spread) direction = lift > spread.max ? "up" : lift < spread.min ? "down" : "flat";
	return { value, baseline, lift, spread, weeks, direction };
}

export interface LiftReport {
	plan: LiftPlan;
	/** The baseline weeks used (the ones with players). */
	weeksUsed: number[];
	/** Weeks dropped for having no players (no data then). */
	weeksEmpty: number[];
	event: Record<LiftMetricKey, Lift>;
	after: Record<LiftMetricKey, Lift> | null;
	net: Record<NetMetricKey, Lift> | null;
	/** The raw window numbers: event, after, and per baseline week. */
	raw: { event: LiftWindowMetrics; after: LiftWindowMetrics | null; baselines: { weeksBack: number; event: LiftWindowMetrics; after: LiftWindowMetrics | null }[] };
	/** Did the event raise anything, and was it pulled forward: one or two plain sentences. */
	verdict: string;
	/** "up" / "down": a clear change in playtime per player or Robux per player; "flat"; "unknown" (too little baseline). */
	headline: Direction;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const band = (s: { min: number; max: number }) => `baseline range ${pct(s.min)} to ${pct(s.max)}`;

function describe(label: string, l: Lift): string {
	return `${pct(l.lift as number)} ${label} (${l.spread ? band(l.spread) : "no baseline range"})`;
}

/** Builds the report from the plan and the query's windows (in plan.windows order). */
export function buildLiftReport(plan: LiftPlan, windows: LiftWindowMetrics[]): LiftReport {
	let i = 0;
	const take = () => windows[i++] as LiftWindowMetrics;
	const eventRaw = take();
	const afterRaw = plan.after ? take() : null;
	const baselinesRaw = plan.baselines.map((b) => ({ weeksBack: b.weeksBack, event: take(), after: b.after ? take() : null }));
	const used = baselinesRaw.filter((b) => b.event.players > 0);
	const weeksEmpty = baselinesRaw.filter((b) => b.event.players === 0).map((b) => b.weeksBack);

	const metricsLift = (raw: LiftWindowMetrics, pick: (b: (typeof used)[number]) => LiftWindowMetrics | null) => {
		const value = metricsOf(raw);
		const weeks = used.map((b) => {
			const w = pick(b);
			return w ? metricsOf(w) : null;
		});
		return Object.fromEntries(LIFT_METRICS.map((m) => [m.key, liftOf(value[m.key], weeks.map((w) => (w ? w[m.key] : null)))])) as Record<LiftMetricKey, Lift>;
	};
	const event = metricsLift(eventRaw, (b) => b.event);
	const after = afterRaw ? metricsLift(afterRaw, (b) => b.after) : null;
	const net = afterRaw
		? (Object.fromEntries(
				NET_METRICS.map((m) => [
					m.key,
					liftOf(
						eventRaw[m.key] + afterRaw[m.key],
						used.map((b) => b.event[m.key] + (b.after ? b.after[m.key] : 0)),
					),
				]),
			) as Record<NetMetricKey, Lift>)
		: null;

	// The verdict: what moved clearly during the event, then the days after.
	const parts: string[] = [];
	if (used.length < 2) {
		parts.push(`Not enough baseline: ${used.length} earlier week${used.length === 1 ? "" : "s"} with players (2 or more are needed for a range).`);
	} else {
		const clear = LIFT_METRICS.filter((m) => event[m.key].direction === "up" || event[m.key].direction === "down");
		if (clear.length) parts.push(`${clear.map((m) => describe(m.label, event[m.key])).join(", ")}${plan.partial ? " so far" : ""}.`);
		else {
			const p = event.playtimePerPlayer;
			parts.push(`No clear change${plan.partial ? " so far" : ""}: every metric is within its baseline range${p.lift !== null && p.spread ? ` (playtime per player ${pct(p.lift)}, ${band(p.spread)})` : ""}.`);
		}
		if (after) {
			const dips = (["playtimePerPlayer", "players", "robuxPerPlayer"] as const).filter((k) => after[k].direction === "down");
			const span = `the ${plan.afterDays} day${plan.afterDays === 1 ? "" : "s"} after${plan.afterPartial ? " (so far)" : ""}`;
			if (dips.length) {
				const playtime = net?.playtimeMinutes;
				parts.push(
					`Dip after: ${dips.map((k) => describe(LIFT_METRICS.find((m) => m.key === k)?.label ?? k, after[k])).join(", ")} ${span}: part of it was pulled forward` +
						(playtime && playtime.lift !== null ? `; net over the event and ${span}: ${pct(playtime.lift)} playtime` : "") +
						".",
				);
			} else parts.push(`No dip ${span}.`);
		} else if (plan.afterDays > 0) parts.push("The days after haven't started yet.");
	}
	const p = event.playtimePerPlayer.direction;
	const r = event.robuxPerPlayer.direction;
	const headline: Direction = p === "up" || r === "up" ? "up" : p === "down" || r === "down" ? "down" : p === "unknown" && r === "unknown" ? "unknown" : "flat";
	return {
		plan,
		weeksUsed: used.map((b) => b.weeksBack),
		weeksEmpty,
		event,
		after,
		net,
		raw: { event: eventRaw, after: afterRaw, baselines: baselinesRaw },
		verdict: parts.join(" "),
		headline,
	};
}
