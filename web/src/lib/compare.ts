/**
 * "vs previous period": the filter bar's range shifted back by its own length, for the stat tiles' change chips and a
 * dashed previous-period line on the main charts (Overview, Errors, Performance). On or off lives in the URL (`vs=prev`),
 * next to the filters, so a compared view can be shared like any other.
 *
 * The previous period ends at the same point in its last day as the current one does now: "7 days" (today and the 6
 * before, today not over yet) is compared with the 7 days before up to the same time of day, so a half-finished today
 * isn't held against a whole day.
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { HOUR_PRESETS, isoDate, toApiFilters, type FilterState } from "./filters";
import type { Filters } from "./types";

export const COMPARE_PARAM = "vs";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The previous period's filters and how far back it is (add `shiftMs` to a previous time to put it on the current axis). */
export interface PreviousPeriod {
	filters: Filters;
	shiftMs: number;
}

const minute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * The period before the filter bar's range, of the same length, under the same other filters. Undefined when the range
 * has no start to measure from (a custom range without a start date).
 */
export function previousPeriod(state: FilterState, now = Date.now()): PreviousPeriod | undefined {
	const current = toApiFilters(state, now);
	const { from: _from, to: _to, ...rest } = current;
	const hours = HOUR_PRESETS[state.range];
	let from: string;
	let to: string;
	let shiftMs: number;
	if (hours) {
		shiftMs = hours * HOUR_MS;
		const start = minute(now) - shiftMs;
		from = new Date(start - shiftMs).toISOString();
		to = new Date(start).toISOString();
	} else if (state.range !== "custom") {
		const days = Number.parseInt(state.range, 10);
		shiftMs = days * DAY_MS;
		from = isoDate(now - (2 * days - 1) * DAY_MS);
		to = new Date(minute(now) - shiftMs).toISOString();
	} else {
		if (!state.from) return undefined;
		const start = dayStart(state.from);
		if (!Number.isFinite(start)) return undefined;
		if (state.to) {
			// Whole days, both ends inclusive.
			const end = dayStart(state.to);
			if (!Number.isFinite(end) || end < start) return undefined;
			shiftMs = end - start + DAY_MS;
			from = isoDate(start - shiftMs);
			to = isoDate(start - DAY_MS);
		} else {
			// From a date to now: the same days before it, up to the same time of day.
			const days = Math.max(1, Math.floor((now - start) / DAY_MS) + 1);
			shiftMs = days * DAY_MS;
			from = isoDate(start - shiftMs);
			to = new Date(minute(now) - shiftMs).toISOString();
		}
	}
	return { filters: { ...rest, from, to }, shiftMs };
}

/** The Errors page's previous window: the same length, ending where the current one starts (unix ms). */
export function previousWindow(window: { from: string; to: string }): { from: number; to: number } | undefined {
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return undefined;
	return { from: from - (to - from), to: from };
}

/**
 * Chart rows with a previous period's values next to the current ones: `prev[fromKey]` at `t - shiftMs` becomes
 * `toKey` at `t` (null where the previous period has no bucket there).
 */
export function withPrevious<R extends { t: number }>(rows: R[], previous: { t: number; [key: string]: number | null }[], shiftMs: number, fromKey: string, toKey: string): (R & Record<string, number | null>)[] {
	const byT = new Map(previous.map((p) => [p.t + shiftMs, p[fromKey] ?? null]));
	return rows.map((r) => ({ ...r, [toKey]: byT.get(r.t) ?? null }));
}

/** The toggle's state in the URL (`vs=prev`). */
export function useCompare(): [boolean, (on: boolean) => void] {
	const [params, setParams] = useSearchParams();
	const on = params.get(COMPARE_PARAM) === "prev";
	const set = useCallback(
		(next: boolean) =>
			setParams((current) => {
				const copy = new URLSearchParams(current);
				if (next) copy.set(COMPARE_PARAM, "prev");
				else copy.delete(COMPARE_PARAM);
				return copy;
			}),
		[setParams],
	);
	return [on, set];
}
