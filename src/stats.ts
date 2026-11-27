/**
 * "How sure" for experiment results, in plain words. Proportions (kept, paid) use a two-proportion z-test; means
 * (playtime, Robux) use a bootstrap over the per-player values when they are available, else Welch's test with a
 * normal approximation from the per-variant mean and variance. "Sure" is 1 - the two-sided p-value: "95% sure"
 * means a difference this large would show up by chance about 1 time in 20 when the variants are really the same.
 */

/** erfc with |error| < 1.2e-7 (Numerical Recipes, Chebyshev fit). */
function erfc(x: number): number {
	const z = Math.abs(x);
	const t = 1 / (1 + 0.5 * z);
	const r =
		t *
		Math.exp(
			-z * z -
				1.26551223 +
				t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
		);
	return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
	return 0.5 * erfc(-z / Math.SQRT2);
}

export interface TestResult {
	/** Control value (rate or mean). */
	a: number;
	/** Variant value. */
	b: number;
	/** b - a */
	diff: number;
	/** (b - a) / a; null when a is 0. */
	lift: number | null;
	/** Two-sided p-value. */
	pValue: number;
	/** 1 - pValue, in [0, 1]. */
	sure: number;
	method: "two-proportion z-test" | "bootstrap" | "welch (normal approx.)";
}

function result(a: number, b: number, pValue: number, method: TestResult["method"]): TestResult {
	const p = Math.min(1, Math.max(0, pValue));
	return { a, b, diff: b - a, lift: a === 0 ? null : (b - a) / a, pValue: p, sure: 1 - p, method };
}

/** Two-proportion z-test (pooled). */
export function twoProportion(successA: number, nA: number, successB: number, nB: number): TestResult {
	const a = nA > 0 ? successA / nA : 0;
	const b = nB > 0 ? successB / nB : 0;
	if (nA === 0 || nB === 0) return result(a, b, 1, "two-proportion z-test");
	const pooled = (successA + successB) / (nA + nB);
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
	if (se === 0) return result(a, b, a === b ? 1 : 0, "two-proportion z-test");
	const z = (b - a) / se;
	return result(a, b, 2 * (1 - normalCdf(Math.abs(z))), "two-proportion z-test");
}

/** Welch's test for two means, normal approximation (fine for the sample sizes experiments need). */
export function welch(meanA: number, varA: number, nA: number, meanB: number, varB: number, nB: number): TestResult {
	if (nA < 2 || nB < 2) return result(meanA, meanB, 1, "welch (normal approx.)");
	const se = Math.sqrt(varA / nA + varB / nB);
	if (!(se > 0)) return result(meanA, meanB, meanA === meanB ? 1 : 0, "welch (normal approx.)");
	const z = (meanB - meanA) / se;
	return result(meanA, meanB, 2 * (1 - normalCdf(Math.abs(z))), "welch (normal approx.)");
}

/** A small seeded PRNG (mulberry32), so bootstrap results are repeatable. */
export function prng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function mean(values: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < values.length; i++) sum += values[i];
	return values.length ? sum / values.length : 0;
}

/** Bootstrap of the difference in means (B - A): how often a resample keeps the sign. */
export function bootstrapMeans(a: ArrayLike<number>, b: ArrayLike<number>, options: { iterations?: number; seed?: number } = {}): TestResult {
	const meanA = mean(a);
	const meanB = mean(b);
	if (a.length < 2 || b.length < 2) return result(meanA, meanB, 1, "bootstrap");
	// Keep the work bounded (about 40 million draws at most).
	const iterations = Math.max(200, Math.min(options.iterations ?? 2000, Math.floor(4e7 / (a.length + b.length))));
	const random = prng(options.seed ?? 1);
	const draw = (values: ArrayLike<number>) => {
		let sum = 0;
		const n = values.length;
		for (let i = 0; i < n; i++) sum += values[Math.floor(random() * n)];
		return sum / n;
	};
	let above = 0;
	let ties = 0;
	for (let i = 0; i < iterations; i++) {
		const d = draw(b) - draw(a);
		if (d > 0) above++;
		else if (d === 0) ties++;
	}
	const share = (above + ties / 2 + 0.5) / (iterations + 1);
	return result(meanA, meanB, 2 * Math.min(share, 1 - share), "bootstrap");
}

/** "95%" (floored; never 100%). */
export function percentSure(sure: number): string {
	return `${Math.min(99, Math.floor(sure * 100))}%`;
}

export interface MetricWords {
	/** e.g. "keeps more players" / "keeps fewer players". */
	more: string;
	less: string;
}

export const METRIC_WORDS: Record<string, MetricWords> = {
	returned: { more: "keeps more players", less: "keeps fewer players" },
	payers: { more: "gets more payers", less: "gets fewer payers" },
	playtime: { more: "plays longer", less: "plays shorter" },
	robux: { more: "earns more Robux", less: "earns less Robux" },
	sessions: { more: "brings players back more often", less: "brings players back less often" },
};

/** The plain sentence for one metric: "B keeps more players: 95% sure". */
export function verdict(variant: string, metric: string, test: TestResult, minPlayers: number): string {
	const words = METRIC_WORDS[metric] ?? { more: `has a higher ${metric}`, less: `has a lower ${metric}` };
	if (minPlayers < 30) return `Too few players to tell yet (${minPlayers} in the smallest group)`;
	if (test.diff === 0) return `No difference (${percentSure(test.sure)} sure)`;
	const phrase = test.diff > 0 ? words.more : words.less;
	if (test.sure >= 0.95) return `${variant} ${phrase}: ${percentSure(test.sure)} sure`;
	if (test.sure >= 0.8) return `${variant} looks like it ${phrase}: ${percentSure(test.sure)} sure, wait for more players`;
	return `No clear difference yet (${percentSure(test.sure)} sure)`;
}
