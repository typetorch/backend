/** React hooks: the URL-backed filters and cached analytics queries (TanStack Query). */
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { api } from "./api";
import { readFilters, toApiFilters, writeFilters, type FilterState } from "./filters";
import type { Filters, QueryName, QueryResults } from "./types";

export function useFilters() {
	const [params, setParams] = useSearchParams();
	const state = useMemo(() => readFilters(params), [params]);
	// Recomputed when the state changes (and so at most once per URL change): presets end "now".
	const apiFilters = useMemo(() => toApiFilters(state), [state]);
	const set = useCallback(
		(patch: Partial<FilterState>) => setParams((current) => writeFilters({ ...readFilters(current), ...patch }, current), { replace: false }),
		[setParams],
	);
	const reset = useCallback(() => setParams((current) => writeFilters({ range: readFilters(current).range }, current)), [setParams]);
	return { state, apiFilters, set, reset };
}

/** One page-level URL parameter (pid, funnel, facet, ...), kept next to the filters. */
export function useParam(key: string, fallback = ""): [string, (value: string) => void] {
	const [params, setParams] = useSearchParams();
	const value = params.get(key) ?? fallback;
	const set = useCallback(
		(next: string) =>
			setParams((current) => {
				const copy = new URLSearchParams(current);
				if (next && next !== fallback) copy.set(key, next);
				else copy.delete(key);
				return copy;
			}),
		[key, fallback, setParams],
	);
	return [value, set];
}

export interface AnalyticsOptions {
	enabled?: boolean;
	/** Use these filters instead of the filter bar's. */
	filters?: Filters;
	/** Keep showing the last answer while new options load (a re-sort), instead of a loading state. */
	keepPrevious?: boolean;
}

/** A named query with the filter bar's filters (or `opts.filters`), cached by name + filters + options. */
export function useAnalytics<N extends QueryName>(name: N, options: object = {}, opts: AnalyticsOptions = {}): UseQueryResult<QueryResults[N], Error> {
	const { apiFilters } = useFilters();
	const filters = opts.filters ?? apiFilters;
	return useQuery({
		queryKey: ["query", name, filters, options],
		queryFn: ({ signal }) => api.query(name, filters, options, signal),
		enabled: opts.enabled ?? true,
		placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
	});
}
