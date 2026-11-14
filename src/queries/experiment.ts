/**
 * Experiment results per variant. Per player (`exp` column) or per server (`sexp`). Every metric is compared with the
 * control variant and said in plain words ("B keeps more players: 95% sure").
 */
import { PROP_KEYS } from "../schema.ts";
import { assertSafeKey, DAY_MS, lit } from "../sql/dialect.ts";
import {
	ALPHA,
	bootstrapMeans,
	daysToReach,
	holm,
	minimumDetectableEffect,
	neededPlayers,
	sampleRatio,
	twoProportion,
	verdict,
	welch,
	type SampleRatioCheck,
	type TestResult,
} from "../stats.ts";
import { dayOf, defineQuery, eventsTable, intOption, iso, num, playerRows, ratio, round, SERVER_PURCHASE, str, where } from "./core.ts";

/** The group of servers that run no experiment pin (`sexp` = ""). */
export const SERVER_CONTROL = "(unpinned)";

export interface ExperimentOptions {
	/**
	 * Scope player: the experiment (a key of `exp`); without it, the query lists the experiments it finds.
	 * Scope server: the pinned artifact id to compare with unpinned servers; without it, every pin.
	 */
	experiment?: string;
	/**
	 * "player": variants from `exp` (default). "server": per-server A/B from `sexp` (the artifact id of a kernel
	 * experiment pin; servers without a pin are the "(unpinned)" group).
	 */
	scope: "player" | "server";
	/** The variant the others are compared with (default: "control", or "(unpinned)" for servers, else the first alphabetically). */
	control?: string;
	/** Most per-player values to pull for the bootstrap (beyond it: Welch's test from the aggregates). */
	maxValues: number;
	robuxKey: string;
	variantKey: string;
	/**
	 * The intended split (relative weights in the game's variant order, as the settings' `weights`) for the sample ratio
	 * check; without it, the game's even split.
	 */
	weights?: number[];
}

/** The most variants the framework allows (isVariantList). */
const VARIANTS_MAX = 16;

export interface VariantStats {
	variant: string;
	players: number;
	/** Players who played on 2 or more days in the range. */
	returned: { rate: number; count: number };
	payers: { rate: number; count: number };
	playtimeMinutes: number;
	robuxPerPlayer: number;
	sessionsPerPlayer: number;
}

export interface Comparison {
	variant: string;
	metric: "returned" | "payers" | "playtime" | "robux" | "sessions";
	control: number;
	value: number;
	diff: number;
	lift: number | null;
	sure: number;
	method: TestResult["method"];
	/** The plain sentence, e.g. "B keeps more players: 95% sure". */
	words: string;
	/** The test's own two-sided p-value. */
	pValue: number;
	/**
	 * Holm-corrected over the variants compared with the control for this metric (= pValue with one variant). `sure`
	 * and `words` use it, so three variants don't get three chances at a lucky "95% sure".
	 */
	pAdjusted: number;
	/**
	 * The smallest true difference (absolute, in the metric's unit) these group sizes find 80% of the time at 5%
	 * (Bonferroni over the variants); Infinity without players.
	 */
	mde: number;
	/** mde relative to the control's value; null when the control's value is 0. */
	mdeLift: number | null;
	/** Players each group needs for the observed difference to be found 80% of the time; null without a difference. */
	needed: { control: number; variant: number } | null;
	/**
	 * Days more at the range's traffic until both groups have `needed` (0: they have), or null when it can't be told
	 * (no difference, no traffic).
	 */
	days: number | null;
}

/** The assignment check of one experiment: the players each variant got against the split it should have. */
export interface AssignmentCheck {
	/**
	 * Players assigned at random per variant (from the `experiment` rows in the range; forced players left out), with
	 * the variant's position in the game's list (`vi` on the rows, framework 0.7.1+) when known. A variant the game
	 * declares but nobody got is listed with 0 players.
	 */
	variants: { variant: string; index: number | null; players: number }[];
	/** "game": in the game's variant order (every row carried `vi`); "names": by name (older frameworks). */
	order: "game" | "names";
	/** The number of variants the game declares (the rows' `variants`), when known. */
	variantCount: number | null;
	/** The split checked against: the given weights or an even split; null when there is nothing to check. */
	weights: number[] | null;
	weightsFrom: "settings" | "even" | null;
	/** The chi-square check; null when it can't be run (see `note`). */
	srm: SampleRatioCheck | null;
	/** Why the check didn't run, or what to keep in mind. */
	note?: string;
}

export type ExperimentResult =
	| {
			experiment: null;
			/**
			 * Per experiment and variant, from the `experiment` rows: players, how many of them were forced, and the number of
			 * variants the game declares (the rows' `variants` prop; null on rows without it).
			 */
			experiments: { experiment: string; variant: string; players: number; forced: number; variantCount: number | null }[];
	  }
	| {
			experiment: string;
			scope: "player" | "server";
			control: string | null;
			variants: VariantStats[];
			comparisons: Comparison[];
			/** Players seen in more than one variant (left out of the numbers). */
			mixedPlayers: number;
			/** Players the settings forced into a variant (for everyone, or for them): left out of the numbers. Player scope. */
			forcedPlayers: number;
			/** The sample ratio check (player scope; null for servers). */
			assignment: AssignmentCheck | null;
			/** Days in the range (for the traffic behind `days`). */
			rangeDays: number;
	  };

export const experiment = defineQuery<ExperimentOptions, ExperimentResult>({
	name: "experiment",
	summary: "experiment results per variant with how sure each difference is; no experiment: the list",
	defaultDays: 30,
	options: (input = {}) => {
		const scope = input.scope ?? "player";
		if (scope !== "player" && scope !== "server") throw new Error('scope must be "player" or "server"');
		const out: ExperimentOptions = {
			scope,
			maxValues: intOption(input.maxValues, "maxValues", 20_000, 0, 200_000),
			robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
			variantKey: assertSafeKey(input.variantKey ?? PROP_KEYS.experimentVariant, "variantKey"),
		};
		if (input.experiment) out.experiment = assertSafeKey(input.experiment, "experiment");
		if (input.control) out.control = String(input.control).slice(0, 128);
		const given: unknown = input.weights;
		if (given !== undefined && given !== null && given !== "") {
			const raw = typeof given === "string" ? given.split(",").map((w) => Number(w)) : given;
			if (
				!Array.isArray(raw) ||
				raw.length < 1 ||
				raw.length > VARIANTS_MAX ||
				raw.some((w) => typeof w !== "number" || !Number.isFinite(w) || w < 0) ||
				!raw.some((w) => (w as number) > 0)
			) {
				throw new Error(`weights must be 1-${VARIANTS_MAX} numbers >= 0, at least one above 0`);
			}
			out.weights = raw as number[];
		}
		return out;
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const lim = d.limit;
		const table = eventsTable(ctx, f);
		if (!o.experiment && o.scope === "player") {
			return {
				list:
					`SELECT experiment, variant, COUNT(DISTINCT pid) AS players, COUNT(DISTINCT CASE WHEN forced = 'true' THEN pid END) AS forced, MAX(nvar) AS nvar FROM (SELECT e.name AS experiment, ${d.jsonText("e.props", o.variantKey)} AS variant, e.pid AS pid, ` +
					`${d.jsonText("e.props", "forced")} AS forced, ${d.jsonNumber("e.props", "variants")} AS nvar ` +
					`FROM ${table} e WHERE ${where(f, ctx)} AND e.kind = 'experiment') x GROUP BY experiment, variant ORDER BY experiment, variant ${lim(1000)}`,
			};
		}
		const variantExpr =
			o.scope === "server" ? `CASE WHEN e.sexp IS NULL OR e.sexp = '' THEN ${lit(SERVER_CONTROL)} ELSE e.sexp END` : d.jsonText("e.exp", o.experiment as string);
		const serverPrefix = o.scope === "server" && o.experiment ? ` AND (e.sexp IS NULL OR e.sexp = '' OR e.sexp = ${lit(o.experiment)})` : "";
		const player = o.scope === "player";
		// Player scope: players the settings forced (an `experiment` row with forced = true in the range) are not a random
		// sample of anything, so they are left out of the comparison and of the assignment check.
		const isAssign = player ? `e.kind = 'experiment' AND e.name = ${lit(o.experiment as string)}` : "";
		const forced = player
			? `fp AS (SELECT DISTINCT e.pid AS pid FROM ${table} e WHERE ${where(f, ctx)} AND ${isAssign} AND ${d.jsonText("e.props", "forced")} = 'true'), `
			: "";
		const base =
			forced +
			`ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.kind AS kind, e.props AS props, e.src AS esrc, ${variantExpr} AS variant FROM ${table} e WHERE ${playerRows(f, ctx)}${serverPrefix}), ` +
			`pe AS (SELECT pid, sid, t, kind, props, esrc, variant FROM ev WHERE variant IS NOT NULL AND variant <> ''), ` +
			(player
				? `pv AS (SELECT pe.pid AS pid, MIN(pe.variant) AS variant, COUNT(DISTINCT pe.variant) AS nvar FROM pe LEFT JOIN fp ON fp.pid = pe.pid WHERE fp.pid IS NULL GROUP BY pe.pid), `
				: `pv AS (SELECT pid, MIN(variant) AS variant, COUNT(DISTINCT variant) AS nvar FROM pe GROUP BY pid), `) +
			`s AS (SELECT sid, MIN(pid) AS pid, MAX(t) - MIN(t) AS len FROM pe GROUP BY sid), ` +
			`sp AS (SELECT pid, SUM(len) AS playtime, COUNT(*) AS sessions FROM s GROUP BY pid), ` +
			`dp AS (SELECT pid, COUNT(DISTINCT day) AS days FROM (SELECT pid, ${dayOf("t")} AS day FROM pe) dd GROUP BY pid), ` +
			`pu AS (SELECT pid, SUM(COALESCE(robux, 0)) AS robux FROM (SELECT pid, ${d.jsonNumber("props", o.robuxKey)} AS robux FROM pe WHERE kind = 'purchase' AND ${SERVER_PURCHASE}) q GROUP BY pid), ` +
			`pp AS (SELECT pv.pid AS pid, pv.variant AS variant, COALESCE(sp.playtime, 0) AS playtime, COALESCE(sp.sessions, 0) AS sessions, ` +
			`COALESCE(dp.days, 0) AS days, COALESCE(pu.robux, 0) AS robux, CASE WHEN pu.pid IS NULL THEN 0 ELSE 1 END AS payer ` +
			`FROM pv LEFT JOIN sp ON sp.pid = pv.pid LEFT JOIN dp ON dp.pid = pv.pid LEFT JOIN pu ON pu.pid = pv.pid WHERE pv.nvar = 1)`;
		const statements: Record<string, string> = {
			variants:
				`WITH ${base} SELECT variant, COUNT(*) AS players, SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS returned, SUM(payer) AS payers, ` +
				`AVG(playtime) AS playtime_mean, VAR_SAMP(playtime) AS playtime_var, AVG(robux) AS robux_mean, VAR_SAMP(robux) AS robux_var, ` +
				`AVG(sessions) AS sessions_mean, VAR_SAMP(sessions) AS sessions_var FROM pp GROUP BY variant ORDER BY variant ${lim(1000)}`,
			mixed: `WITH ${base} SELECT COUNT(*) AS mixed FROM pv WHERE nvar > 1 ${lim(1)}`,
		};
		if (player) {
			statements.forced = `WITH ${forced.slice(0, -2)} SELECT COUNT(*) AS forced FROM fp ${lim(1)}`;
			// Random assignments per variant: the `experiment` rows (one per session that got the variant), forced players out.
			statements.assign =
				`WITH ${forced}x AS (SELECT e.pid AS pid, ${d.jsonText("e.props", o.variantKey)} AS variant, ${d.jsonNumber("e.props", "vi")} AS vi, ` +
				`${d.jsonNumber("e.props", "variants")} AS nvar FROM ${table} e WHERE ${where(f, ctx)} AND ${isAssign} AND e.pid IS NOT NULL AND e.pid <> '') ` +
				`SELECT x.variant AS variant, MIN(x.vi) AS vi, MAX(x.vi) AS vimax, COUNT(*) AS nrows, COUNT(x.vi) AS nvi, MAX(x.nvar) AS nvar, COUNT(DISTINCT x.pid) AS players ` +
				`FROM x LEFT JOIN fp ON fp.pid = x.pid WHERE fp.pid IS NULL AND x.variant IS NOT NULL AND x.variant <> '' GROUP BY x.variant ORDER BY x.variant ${lim(1000)}`;
		}
		if (o.maxValues > 0) statements.values = `WITH ${base} SELECT variant, playtime, robux, sessions FROM pp ${lim(o.maxValues)}`;
		return statements;
	},
	shape(rows, _ctx, f, o) {
		if (rows.list) {
			return { experiment: null, experiments: rows.list.map((r) => ({
					experiment: str(r.experiment),
					variant: str(r.variant),
					players: num(r.players),
					forced: num(r.forced),
					variantCount: r.nvar === null || r.nvar === undefined ? null : num(r.nvar),
				})) };
		}
		const rangeDays = Math.max(0, (f.to - f.from) / DAY_MS);
		const variants = rows.variants.map((r) => ({
			row: r,
			stats: {
				variant: str(r.variant),
				players: num(r.players),
				returned: { rate: ratio(num(r.returned), num(r.players)), count: num(r.returned) },
				payers: { rate: ratio(num(r.payers), num(r.players)), count: num(r.payers) },
				playtimeMinutes: round(num(r.playtime_mean) / 60_000, 2),
				robuxPerPlayer: round(num(r.robux_mean), 2),
				sessionsPerPlayer: round(num(r.sessions_mean), 2),
			} satisfies VariantStats,
		}));
		const names = variants.map((v) => v.stats.variant);
		const control =
			o.control && names.includes(o.control) ? o.control : names.includes("control") ? "control" : names.includes(SERVER_CONTROL) ? SERVER_CONTROL : (names[0] ?? null);
		// Per-player values for the bootstrap, when we got all of them.
		const totalPlayers = variants.reduce((s, v) => s + v.stats.players, 0);
		const values = rows.values && rows.values.length === totalPlayers ? rows.values : undefined;
		const valuesOf = (variant: string, key: string) => (values ?? []).filter((r) => str(r.variant) === variant).map((r) => num(r[key]));
		const comparisons: Comparison[] = [];
		const base = variants.find((v) => v.stats.variant === control);
		if (base) {
			const others = variants.filter((v) => v.stats.variant !== control);
			// Planning (MDE, players needed) at a Bonferroni alpha: the conservative side of the Holm correction below.
			const alpha = ALPHA / Math.max(1, others.length);
			const tests: { v: (typeof variants)[number]; metric: Comparison["metric"]; test: TestResult; varA: number; varB: number }[] = [];
			for (const v of others) {
				const proportion = (metric: "returned" | "payers") => {
					const a = base.stats[metric];
					const b = v.stats[metric];
					tests.push({ v, metric, test: twoProportion(a.count, base.stats.players, b.count, v.stats.players), varA: a.rate * (1 - a.rate), varB: b.rate * (1 - b.rate) });
				};
				proportion("returned");
				proportion("payers");
				for (const [metric, key, scale] of [
					["playtime", "playtime", 60_000],
					["robux", "robux", 1],
					["sessions", "sessions", 1],
				] as const) {
					const a = base.row;
					const b = v.row;
					const varA = num(a[`${key}_var`]) / (scale * scale);
					const varB = num(b[`${key}_var`]) / (scale * scale);
					const test = values
						? bootstrapMeans(valuesOf(control as string, key).map((x) => x / scale), valuesOf(v.stats.variant, key).map((x) => x / scale))
						: welch(num(a[`${key}_mean`]) / scale, varA, base.stats.players, num(b[`${key}_mean`]) / scale, varB, v.stats.players);
					tests.push({ v, metric, test, varA, varB });
				}
			}
			// Holm over the variants, per metric.
			const adjusted = new Map<(typeof tests)[number], number>();
			for (const metric of new Set(tests.map((t) => t.metric))) {
				const family = tests.filter((t) => t.metric === metric);
				holm(family.map((t) => t.test.pValue)).forEach((p, i) => adjusted.set(family[i], p));
			}
			for (const t of tests) {
				const { v, metric, test } = t;
				const pAdjusted = adjusted.get(t) ?? test.pValue;
				const shown: TestResult = { ...test, pValue: pAdjusted, sure: 1 - pAdjusted };
				const nA = base.stats.players;
				const nB = v.stats.players;
				const mde = minimumDetectableEffect(t.varA, nA, t.varA, nB, alpha);
				const needed = neededPlayers(t.varA, t.varB, test.diff, nA > 0 ? nB / nA : 1, alpha);
				comparisons.push({
					variant: v.stats.variant,
					metric,
					control: round(test.a, 4),
					value: round(test.b, 4),
					diff: round(test.diff, 4),
					lift: test.lift === null ? null : round(test.lift, 4),
					sure: round(shown.sure, 4),
					method: test.method,
					words: verdict(v.stats.variant, metric, shown, Math.min(nA, nB)),
					pValue: round(test.pValue, 6),
					pAdjusted: round(pAdjusted, 6),
					mde: Number.isFinite(mde) ? round(mde, 4) : Infinity,
					mdeLift: test.a === 0 || !Number.isFinite(mde) ? null : round(mde / Math.abs(test.a), 4),
					needed: needed ? { control: needed.a, variant: needed.b } : null,
					days: pAdjusted < ALPHA ? 0 : (() => {
						const days = daysToReach(needed, { a: nA, b: nB }, rangeDays);
						return days === null ? null : round(days, 1);
					})(),
				});
			}
		}
		return {
			experiment: o.experiment ?? "(server)",
			scope: o.scope,
			control,
			variants: variants.map((v) => v.stats),
			comparisons,
			mixedPlayers: num(rows.mixed[0]?.mixed),
			forcedPlayers: rows.forced ? num(rows.forced[0]?.forced) : 0,
			assignment: rows.assign ? assignmentCheck(rows.assign, o.weights) : null,
			rangeDays: round(rangeDays, 2),
		};
	},
});

/**
 * The sample ratio check from the `assign` rows (per variant: players, the variant's `vi` and the declared count). The
 * game's order is known when every row carried `vi` and each variant had one position; else the variants are listed by
 * name and only an even split can be checked (uneven weights are in the game's order, which isn't known then).
 */
export function assignmentCheck(rows: Record<string, unknown>[], weights: number[] | undefined): AssignmentCheck {
	const seen = rows.map((r) => ({
		variant: str(r.variant),
		vi: r.vi === null || r.vi === undefined ? null : num(r.vi),
		vimax: r.vimax === null || r.vimax === undefined ? null : num(r.vimax),
		withIndex: num(r.nvi) === num(r.nrows),
		players: num(r.players),
		nvar: r.nvar === null || r.nvar === undefined ? null : num(r.nvar),
	}));
	const declared = seen.reduce<number | null>((m, r) => (r.nvar === null ? m : Math.max(m ?? 0, r.nvar)), null);
	const count = Math.max(declared ?? 0, seen.length);
	const indices = seen.map((r) => r.vi);
	const gameOrder =
		seen.length > 0 &&
		seen.every((r) => r.withIndex && r.vi !== null && r.vi === r.vimax && r.vi >= 1 && r.vi <= count && r.vi % 1 === 0) &&
		new Set(indices).size === seen.length;
	let list: AssignmentCheck["variants"];
	if (gameOrder) {
		list = Array.from({ length: count }, (_, i) => {
			const found = seen.find((r) => r.vi === i + 1);
			return { variant: found ? found.variant : `(variant ${i + 1})`, index: i + 1, players: found ? found.players : 0 };
		});
	} else {
		list = seen.map((r) => ({ variant: r.variant, index: null, players: r.players }));
		for (let i = seen.length; i < count; i++) list.push({ variant: `(unseen ${i - seen.length + 1})`, index: null, players: 0 });
	}
	const order = gameOrder ? "game" : "names";
	const out = (rest: Pick<AssignmentCheck, "weights" | "weightsFrom" | "srm"> & { note?: string }): AssignmentCheck => ({
		variants: list,
		order,
		variantCount: declared,
		...rest,
	});
	if (list.length < 2) return out({ weights: null, weightsFrom: null, srm: null, note: "Needs players in at least two variants." });
	const even = !weights || weights.every((w) => w === weights[0]);
	if (!even && weights.length !== list.length) {
		return out({ weights: null, weightsFrom: null, srm: null, note: `The settings' ${weights.length} weights don't fit the ${list.length} variants (the game ignores them and splits evenly).` });
	}
	if (!even && !gameOrder) {
		return out({
			weights: null,
			weightsFrom: null,
			srm: null,
			note: "Uneven weights are in the game's variant order, which these rows don't carry (framework 0.7.1+ adds it): the split can't be checked.",
		});
	}
	const used = even ? list.map(() => 1) : (weights as number[]);
	const srm = sampleRatio(
		list.map((v) => v.players),
		used,
	);
	return out({
		weights: used,
		weightsFrom: even && !weights ? "even" : "settings",
		srm,
		...(srm.mismatch ? { note: "If the split changed in this range, pick a range after the change: players assigned under the old split count against the new one." } : {}),
	});
}

/** Most players one experiment -> players read lists (the route's cap). */
export const EXPERIMENT_PLAYERS_MAX = 200;

export interface ExperimentPlayersOptions {
	/** The experiment (a key of `exp`, the `name` of its `experiment` rows). */
	experiment: string;
	/** Only this variant (the counts per variant still cover every variant). */
	variant?: string;
	/** Most rows listed, most recently seen first (1-200, default 200). */
	limit: number;
	variantKey: string;
}

/** One player in one variant of the experiment, in the window. */
export interface ExperimentPlayer {
	pid: string;
	variant: string;
	/**
	 * How they got it, from the window's `experiment` rows: "random" (the hash of their pid, with the weights), "forced"
	 * (the settings forced the variant: for everyone, or for this player), or "unknown" when the window holds no
	 * `experiment` row for them (only their stamped events: the assignment came before the window).
	 */
	how: "random" | "forced" | "unknown";
	/** First `experiment` row with this variant in the window (ISO), or null (see `how`). */
	assignedAt: string | null;
	/** First and last of their rows stamped with (or assigning) this variant in the window (ISO). */
	firstAt: string;
	lastAt: string;
	/** Their rows in the window with this variant. */
	events: number;
	/** The player was seen in more than one variant of it in the window (one row per variant). */
	mixed: boolean;
	/** Joined in by the server route: the UserId (identity table) and Roblox names (profile cache), when known. */
	uid?: number;
	name?: string;
	displayName?: string;
}

export interface ExperimentPlayersResult {
	experiment: string;
	variant: string | null;
	/** Players per variant in the window (every variant, whatever `variant` is), and how many of them were forced. */
	variants: { variant: string; players: number; forced: number }[];
	/** Rows (player + variant) matching `variant`; `more` of them are not listed. */
	total: number;
	more: number;
	players: ExperimentPlayer[];
}

/**
 * The players in one experiment (Experiments page side panel): per player and variant, how they got it, when it was
 * assigned, and their first and last stamped row in the window. Players come from the `experiment` rows (kind
 * `experiment`, name = the experiment, props.variant, props.forced) and from every row whose `exp` names the
 * experiment, so a player assigned before the window still shows (how "unknown"). Most recently seen first.
 */
export const experimentPlayers = defineQuery<ExperimentPlayersOptions, ExperimentPlayersResult>({
	name: "experiment-players",
	summary: "the players in one experiment: variant, random or forced, assigned / first / last seen (at most 200)",
	defaultDays: 30,
	options: (input = {}) => {
		if (!input.experiment) throw new Error("experiment is required");
		const out: ExperimentPlayersOptions = {
			experiment: assertSafeKey(String(input.experiment), "experiment"),
			limit: intOption(input.limit, "limit", EXPERIMENT_PLAYERS_MAX, 1, EXPERIMENT_PLAYERS_MAX),
			variantKey: assertSafeKey(input.variantKey ?? PROP_KEYS.experimentVariant, "variantKey"),
		};
		if (input.variant !== undefined && input.variant !== "") {
			const v = input.variant;
			if (typeof v !== "string" || v.length > 64 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error("variant must be text of at most 64 characters");
			out.variant = v;
		}
		return out;
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const table = eventsTable(ctx, f);
		const key = lit(o.experiment);
		const isAssign = `(e.kind = 'experiment' AND e.name = ${key})`;
		const stamped = d.jsonText("e.exp", o.experiment);
		const base =
			`x AS (SELECT e.pid AS pid, e.t AS t, CASE WHEN ${isAssign} THEN ${d.jsonText("e.props", o.variantKey)} ELSE ${stamped} END AS variant, ` +
			`CASE WHEN ${isAssign} THEN 1 ELSE 0 END AS assigned, CASE WHEN ${isAssign} AND ${d.jsonText("e.props", "forced")} = 'true' THEN 1 ELSE 0 END AS forced ` +
			`FROM ${table} e WHERE ${where(f, ctx)} AND e.pid IS NOT NULL AND e.pid <> '' AND (${isAssign} OR ${stamped} IS NOT NULL)), ` +
			`pv AS (SELECT pid, variant, MIN(CASE WHEN assigned = 1 THEN t END) AS assigned_t, SUM(assigned) AS assignments, MAX(forced) AS forced, ` +
			`MIN(t) AS first_t, MAX(t) AS last_t, COUNT(*) AS events FROM x WHERE variant IS NOT NULL AND variant <> '' GROUP BY pid, variant), ` +
			`pm AS (SELECT pid, COUNT(*) AS nvar FROM pv GROUP BY pid)`;
		const only = o.variant !== undefined ? ` WHERE pv.variant = ${lit(o.variant)}` : "";
		return {
			players:
				`WITH ${base} SELECT pv.pid AS pid, pv.variant AS variant, pv.assigned_t AS assigned_t, pv.assignments AS assignments, pv.forced AS forced, ` +
				`pv.first_t AS first_t, pv.last_t AS last_t, pv.events AS events, pm.nvar AS nvar FROM pv JOIN pm ON pm.pid = pv.pid${only} ` +
				`ORDER BY pv.last_t DESC, pv.pid, pv.variant ${d.limit(o.limit)}`,
			total: `WITH ${base} SELECT COUNT(*) AS total FROM pv${only} ${d.limit(1)}`,
			variants: `WITH ${base} SELECT variant, COUNT(*) AS players, SUM(forced) AS forced FROM pv GROUP BY variant ORDER BY variant ${d.limit(1000)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const players = rows.players.map(
			(r): ExperimentPlayer => ({
				pid: str(r.pid),
				variant: str(r.variant),
				how: num(r.forced) > 0 ? "forced" : num(r.assignments) > 0 ? "random" : "unknown",
				assignedAt: r.assigned_t === null || r.assigned_t === undefined ? null : iso(num(r.assigned_t)),
				firstAt: iso(num(r.first_t)),
				lastAt: iso(num(r.last_t)),
				events: num(r.events),
				mixed: num(r.nvar) > 1,
			}),
		);
		const total = num(rows.total[0]?.total);
		return {
			experiment: o.experiment,
			variant: o.variant ?? null,
			variants: rows.variants.map((r) => ({ variant: str(r.variant), players: num(r.players), forced: num(r.forced) })),
			total,
			more: Math.max(0, total - players.length),
			players,
		};
	},
});
