/**
 * Creator-Hub-style benchmark cards: period-over-period change, and the user's own benchmark values (the 50th and
 * 90th percentile they read on their Creator Hub page; we have no genre data), kept in localStorage.
 */

/**
 * One per card that Creator Hub has a counterpart for. `sessionTime` is Creator Hub's "Average session time" (the
 * benchmarked engagement KPI); `playtime` is its "Average playtime" (per DAU). Creator Hub benchmarks only some of
 * these; the others take a 50th / 90th too if the user has one from elsewhere. Our own metrics (the qualified first
 * sessions card) take none: a Roblox percentile means nothing for a number Roblox doesn't compute.
 */
export type BenchmarkKey = "dau" | "mau" | "newUsers" | "sessionTime" | "playtime" | "d1" | "d7" | "d30" | "payer" | "arppu" | "arpdau";
export const BENCHMARK_KEYS: readonly BenchmarkKey[] = ["dau", "mau", "newUsers", "sessionTime", "playtime", "d1", "d7", "d30", "payer", "arppu", "arpdau"];

export interface Benchmark {
	p50: number;
	p90: number;
}

export type Benchmarks = Partial<Record<BenchmarkKey, Benchmark>>;

const STORAGE_KEY = "tt-explorer-benchmarks";

export function loadBenchmarks(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Benchmarks {
	try {
		const raw = storage?.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: Benchmarks = {};
		for (const [key, value] of Object.entries(parsed)) {
			const v = value as Partial<Benchmark> | null;
			// Keys of cards that no longer take a benchmark (an older "playThrough") are dropped.
			if (!BENCHMARK_KEYS.includes(key as BenchmarkKey)) continue;
			if (v && Number.isFinite(v.p50) && Number.isFinite(v.p90)) out[key as BenchmarkKey] = { p50: Number(v.p50), p90: Number(v.p90) };
		}
		return out;
	} catch {
		return {};
	}
}

export function saveBenchmarks(benchmarks: Benchmarks, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): boolean {
	try {
		storage?.setItem(STORAGE_KEY, JSON.stringify(benchmarks));
		return true;
	} catch {
		return false;
	}
}

/**
 * Where a value sits, estimated from the 50th and 90th percentile alone (straight lines: 0 -> 0th, p50 -> 50th,
 * p90 -> 90th, then on to 99th at p90 + (p90 - p50) / 2... capped). An estimate, not real percentile data.
 */
export function estimatePercentile(value: number, b: Benchmark, lowerIsBetter = false): number | null {
	if (!Number.isFinite(value) || !(b.p50 > 0) || !(b.p90 > 0) || b.p50 === b.p90) return null;
	if (lowerIsBetter) {
		// Lower is better: p50 > p90 in value; mirror the scale.
		if (b.p90 >= b.p50) return null;
		if (value >= b.p50) return Math.max(1, Math.round(50 * (b.p50 / value)));
		if (value >= b.p90) return Math.round(50 + (40 * (b.p50 - value)) / (b.p50 - b.p90));
		return Math.min(99, Math.round(90 + (10 * (b.p90 - value)) / (b.p50 - b.p90)));
	}
	if (b.p90 <= b.p50) return null;
	if (value <= b.p50) return Math.max(0, Math.round((50 * value) / b.p50));
	if (value <= b.p90) return Math.round(50 + (40 * (value - b.p50)) / (b.p90 - b.p50));
	return Math.min(99, Math.round(90 + (10 * (value - b.p90)) / ((b.p90 - b.p50) / 2)));
}

export interface Change {
	/** Relative change, e.g. 0.12 = +12% (null without a previous value). */
	relative: number | null;
	direction: "up" | "down" | "flat";
	/** The change is an improvement (up for most metrics, down when lower is better). */
	good: boolean | null;
}

/** Period-over-period change of a value. */
export function change(current: number | null | undefined, previous: number | null | undefined, lowerIsBetter = false): Change {
	if (current === null || current === undefined || previous === null || previous === undefined || !Number.isFinite(current) || !Number.isFinite(previous)) {
		return { relative: null, direction: "flat", good: null };
	}
	if (previous === 0) return { relative: null, direction: current > 0 ? "up" : "flat", good: current > 0 ? !lowerIsBetter : null };
	const relative = (current - previous) / Math.abs(previous);
	if (Math.abs(relative) < 0.005) return { relative: 0, direction: "flat", good: null };
	const direction = relative > 0 ? "up" : "down";
	return { relative, direction, good: direction === "up" ? !lowerIsBetter : lowerIsBetter };
}

/** The bar's scale: a little past the largest of the value and the 90th. */
export function barMax(value: number, b?: Benchmark): number {
	return Math.max(value, b ? Math.max(b.p50, b.p90) : 0) * 1.2 || 1;
}
