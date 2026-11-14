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

// Trustworthy results: sample ratio mismatch, more than two variants, sample size -------------------------------------

/** The standard normal quantile (inverse CDF), |relative error| < 1.2e-9 (Acklam's rational approximation). */
export function normalQuantile(p: number): number {
	if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : Number.NaN;
	const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
	const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
	const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
	const low = 0.02425;
	if (p < low) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	}
	if (p > 1 - low) return -normalQuantile(1 - p);
	const q = p - 0.5;
	const r = q * q;
	return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7, n = 9; ~15 digits). */
function logGamma(x: number): number {
	const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	const z = x - 1;
	let sum = g[0];
	for (let i = 1; i < 9; i++) sum += g[i] / (z + i);
	const t = z + 7.5;
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** The regularized upper incomplete gamma Q(a, x) = Γ(a, x) / Γ(a) (series below a + 1, continued fraction above). */
export function gammaQ(a: number, x: number): number {
	if (x <= 0) return 1;
	const lead = -x + a * Math.log(x) - logGamma(a);
	if (x < a + 1) {
		let term = 1 / a;
		let sum = term;
		for (let n = 1; n < 1000; n++) {
			term *= x / (a + n);
			sum += term;
			if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
		}
		return Math.max(0, 1 - sum * Math.exp(lead));
	}
	// Lentz's method for the continued fraction.
	const tiny = 1e-300;
	let b = x + 1 - a;
	let c = 1 / tiny;
	let d = 1 / b;
	let h = d;
	for (let i = 1; i < 1000; i++) {
		const an = -i * (i - a);
		b += 2;
		d = an * d + b;
		if (Math.abs(d) < tiny) d = tiny;
		c = b + an / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		const delta = d * c;
		h *= delta;
		if (Math.abs(delta - 1) < 1e-15) break;
	}
	return Math.min(1, Math.exp(lead) * h);
}

/** P(X >= x) for a chi-square variable with `df` degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
	if (!(df > 0)) return Number.NaN;
	return gammaQ(df / 2, x / 2);
}

/** Below this p-value the assignment counts don't fit the intended split (the usual SRM threshold). */
export const SRM_THRESHOLD = 0.001;
/** The chi-square test is only trusted when every group expects at least this many players. */
export const SRM_MIN_EXPECTED = 5;

export interface SampleRatioCheck {
	/** Players expected per group under the intended split (same order as the counts). */
	expected: number[];
	chi2: number;
	df: number;
	pValue: number;
	/** True when the test can be trusted (enough players: every group expects >= SRM_MIN_EXPECTED). */
	enough: boolean;
	/** The counts don't fit the split (p < SRM_THRESHOLD, with enough players): the results can't be trusted. */
	mismatch: boolean;
}

/**
 * Sample ratio mismatch: a chi-square goodness-of-fit test of the assignment counts against the intended split
 * (relative weights, same order). A mismatch means players didn't land where the split says (a bug in assignment, a
 * variant that crashes or loses its events, bots, a split changed in the range), so its numbers are not comparable.
 */
export function sampleRatio(counts: number[], weights: number[]): SampleRatioCheck {
	if (counts.length !== weights.length || counts.length < 2) throw new Error("sampleRatio needs one weight per count and 2+ groups");
	const total = counts.reduce((s, n) => s + n, 0);
	const weightTotal = weights.reduce((s, w) => s + w, 0);
	const expected = weights.map((w) => (weightTotal > 0 ? (total * w) / weightTotal : 0));
	let chi2 = 0;
	let df = -1;
	let impossible = false;
	for (let i = 0; i < counts.length; i++) {
		if (expected[i] > 0) {
			chi2 += (counts[i] - expected[i]) ** 2 / expected[i];
			df++;
		} else if (counts[i] > 0) impossible = true; // players in a group that should get none
	}
	const pValue = impossible ? 0 : df > 0 ? chiSquareSf(chi2, df) : 1;
	const enough = total > 0 && expected.every((e, i) => e >= SRM_MIN_EXPECTED || weights[i] === 0);
	return { expected, chi2: impossible ? Infinity : chi2, df: Math.max(df, 0), pValue, enough, mismatch: enough && pValue < SRM_THRESHOLD };
}

/** Holm-Bonferroni adjusted p-values (same order as given): controls the family-wise error over several comparisons. */
export function holm(pValues: number[]): number[] {
	const m = pValues.length;
	const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
	const adjusted = new Array<number>(m);
	let running = 0;
	order.forEach(({ p, i }, rank) => {
		running = Math.max(running, Math.min(1, (m - rank) * p));
		adjusted[i] = running;
	});
	return adjusted;
}

/** Defaults for power: a two-sided test at 5% with 80% power. */
export const ALPHA = 0.05;
export const POWER = 0.8;

/**
 * The minimum detectable effect (absolute difference) with these group sizes and per-player variances: the smallest
 * true difference a two-sided test at `alpha` finds with probability `power`. Infinity without players.
 */
export function minimumDetectableEffect(varA: number, nA: number, varB: number, nB: number, alpha = ALPHA, power = POWER): number {
	if (nA < 1 || nB < 1) return Infinity;
	return (normalQuantile(1 - alpha / 2) + normalQuantile(power)) * Math.sqrt(varA / nA + varB / nB);
}

/**
 * Players needed in each group to detect a difference of `diff` (absolute) with these per-player variances, keeping
 * the groups' current ratio (`ratio` = nB / nA). Null when the difference is 0.
 */
export function neededPlayers(varA: number, varB: number, diff: number, ratio = 1, alpha = ALPHA, power = POWER): { a: number; b: number } | null {
	if (diff === 0 || !Number.isFinite(diff) || !(ratio > 0)) return null;
	const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
	const a = Math.ceil((z * z * (varA + varB / ratio)) / (diff * diff));
	return { a, b: Math.ceil(a * ratio) };
}

/**
 * Days until the groups reach `needed` at the range's traffic (players per group per day), or 0 when they already have,
 * or null when it can't be told (no traffic, or no difference to find).
 */
export function daysToReach(needed: { a: number; b: number } | null, have: { a: number; b: number }, rangeDays: number): number | null {
	if (!needed || !(rangeDays > 0)) return null;
	if (have.a >= needed.a && have.b >= needed.b) return 0;
	const rateA = have.a / rangeDays;
	const rateB = have.b / rangeDays;
	if (!(rateA > 0) || !(rateB > 0)) return null;
	return Math.max((needed.a - have.a) / rateA, (needed.b - have.b) / rateB, 0);
}
