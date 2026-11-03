/**
 * The shared filter bar's state. It lives in the URL (?range=7d&branch=dev...), so a view can be bookmarked or
 * shared, and turns into the analytics server's `filters` object. Days are UTC, like the server's. The hour presets
 * (1h, 6h) send an exact instant (ISO, on a whole minute so the query cache holds still within a minute); the day
 * presets and custom ranges send dates, as before.
 */
import { DEVICES, type Device, type Filters } from "./types";

export const RANGE_PRESETS = ["1h", "6h", "1d", "7d", "30d", "90d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number] | "custom";
export const DEFAULT_RANGE: RangePreset = "30d";
/** What the filter bar (and the command palette) calls each range. */
export const RANGE_LABELS: Record<RangePreset, string> = {
	"1h": "Last 1 hour",
	"6h": "Last 6 hours",
	"1d": "Today",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
	custom: "Custom",
};

/** The presets that count hours back from now (the rest are days, today included). */
export const HOUR_PRESETS: Partial<Record<RangePreset, number>> = { "1h": 1, "6h": 6 };

export interface FilterState {
	range: RangePreset;
	/** YYYY-MM-DD, for range = custom. */
	from?: string;
	/** YYYY-MM-DD, inclusive, for range = custom. */
	to?: string;
	branch?: string;
	art?: string;
	dev?: Device;
	players?: "new" | "returning";
	/** Experiment and variant (both needed). */
	exp?: string;
	variant?: string;
}

/** The URL parameters the filter bar owns; pages keep their own (pid, funnel, ...) alongside. */
export const FILTER_KEYS = ["range", "from", "to", "branch", "art", "dev", "players", "exp", "variant"] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * A chart's time step for a window, as the backend picks it (queries/core.ts windowBucketMs): up to an hour -> 1 min,
 * up to 6 hours -> 5 min, up to a day -> 1 hour, longer -> 1 day.
 */
export function windowBucketMs(spanMs: number): number {
	if (spanMs <= 65 * MINUTE_MS) return MINUTE_MS;
	if (spanMs <= 6.5 * HOUR_MS) return 5 * MINUTE_MS;
	if (spanMs <= 26 * HOUR_MS) return HOUR_MS;
	return DAY_MS;
}

export function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function readFilters(params: URLSearchParams): FilterState {
	const get = (key: string) => {
		const v = params.get(key)?.trim();
		return v ? v : undefined;
	};
	const rawRange = get("range");
	const range: RangePreset = rawRange === "custom" || (RANGE_PRESETS as readonly string[]).includes(rawRange ?? "") ? (rawRange as RangePreset) : DEFAULT_RANGE;
	const state: FilterState = { range };
	const from = get("from");
	const to = get("to");
	if (range === "custom") {
		if (from && DATE.test(from)) state.from = from;
		if (to && DATE.test(to)) state.to = to;
	}
	for (const key of ["branch", "art", "exp", "variant"] as const) {
		const v = get(key);
		if (v) state[key] = v;
	}
	const dev = get("dev");
	if (dev && (DEVICES as string[]).includes(dev)) state.dev = dev as Device;
	const players = get("players");
	if (players === "new" || players === "returning") state.players = players;
	return state;
}

/** A copy of `params` with the filter keys replaced by `state` (other keys kept; defaults left out). */
export function writeFilters(state: FilterState, params: URLSearchParams): URLSearchParams {
	const next = new URLSearchParams(params);
	for (const key of FILTER_KEYS) next.delete(key);
	if (state.range !== DEFAULT_RANGE) next.set("range", state.range);
	if (state.range === "custom") {
		if (state.from) next.set("from", state.from);
		if (state.to) next.set("to", state.to);
	}
	for (const key of ["branch", "art", "dev", "players", "exp", "variant"] as const) {
		const v = state[key];
		if (v) next.set(key, v);
	}
	return next;
}

/**
 * The server's filters. Presets end now: "7d" = today and the 6 days before (UTC); "1h" = the hour before now (from the
 * whole minute, so up to 61 minutes), as an ISO instant.
 */
export function toApiFilters(state: FilterState, now = Date.now()): Filters {
	const filters: Filters = {};
	const hours = HOUR_PRESETS[state.range];
	if (state.range === "custom") {
		if (state.from) filters.from = state.from;
		if (state.to) filters.to = state.to;
	} else if (hours) {
		filters.from = new Date(Math.floor(now / MINUTE_MS) * MINUTE_MS - hours * HOUR_MS).toISOString();
	} else {
		const days = Number.parseInt(state.range, 10);
		filters.from = isoDate(now - (days - 1) * DAY_MS);
	}
	if (state.branch) filters.branch = state.branch;
	if (state.art) filters.art = state.art;
	if (state.dev) filters.dev = state.dev;
	if (state.players) filters.players = state.players;
	if (state.exp && state.variant) filters.variant = { experiment: state.exp, variant: state.variant };
	return filters;
}

/** Only the date range (for lookups that feed the filter bar itself). */
export function rangeOnly(filters: Filters): Filters {
	return { ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) };
}

export function describeRange(state: FilterState): string {
	switch (state.range) {
		case "1h":
			return "the last 1 hour";
		case "6h":
			return "the last 6 hours";
		case "1d":
			return "today (UTC)";
		case "custom":
			return `${state.from ?? "start"} to ${state.to ?? "now"} (UTC)`;
		default:
			return `last ${Number.parseInt(state.range, 10)} days (UTC)`;
	}
}

/** How many filters besides the range are set. */
export function activeFilterCount(state: FilterState): number {
	return (["branch", "art", "dev", "players"] as const).filter((k) => state[k]).length + (state.exp && state.variant ? 1 : 0);
}
