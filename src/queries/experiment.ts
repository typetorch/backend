/**
 * Experiment results per variant. Per player (`exp` column) or per server (`sexp`). Every metric is compared with the
 * control variant and said in plain words ("B keeps more players: 95% sure").
 */
import { PROP_KEYS } from "../schema.ts";
import { assertSafeKey, lit } from "../sql/dialect.ts";
import { bootstrapMeans, twoProportion, verdict, welch, type TestResult } from "../stats.ts";
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
}

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
		const base =
			`ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.kind AS kind, e.props AS props, e.src AS esrc, ${variantExpr} AS variant FROM ${table} e WHERE ${playerRows(f, ctx)}${serverPrefix}), ` +
			`pe AS (SELECT pid, sid, t, kind, props, esrc, variant FROM ev WHERE variant IS NOT NULL AND variant <> ''), ` +
			`pv AS (SELECT pid, MIN(variant) AS variant, COUNT(DISTINCT variant) AS nvar FROM pe GROUP BY pid), ` +
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
		if (o.maxValues > 0) statements.values = `WITH ${base} SELECT variant, playtime, robux, sessions FROM pp ${lim(o.maxValues)}`;
		return statements;
	},
	shape(rows, _ctx, _f, o) {
		if (rows.list) {
			return { experiment: null, experiments: rows.list.map((r) => ({
					experiment: str(r.experiment),
					variant: str(r.variant),
					players: num(r.players),
					forced: num(r.forced),
					variantCount: r.nvar === null || r.nvar === undefined ? null : num(r.nvar),
				})) };
		}
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
			for (const v of variants) {
				if (v.stats.variant === control) continue;
				const minPlayers = Math.min(base.stats.players, v.stats.players);
				const add = (metric: Comparison["metric"], test: TestResult) =>
					comparisons.push({
						variant: v.stats.variant,
						metric,
						control: round(test.a, 4),
						value: round(test.b, 4),
						diff: round(test.diff, 4),
						lift: test.lift === null ? null : round(test.lift, 4),
						sure: round(test.sure, 4),
						method: test.method,
						words: verdict(v.stats.variant, metric, test, minPlayers),
					});
				add("returned", twoProportion(base.stats.returned.count, base.stats.players, v.stats.returned.count, v.stats.players));
				add("payers", twoProportion(base.stats.payers.count, base.stats.players, v.stats.payers.count, v.stats.players));
				for (const [metric, key, scale] of [
					["playtime", "playtime", 60_000],
					["robux", "robux", 1],
					["sessions", "sessions", 1],
				] as const) {
					let test: TestResult;
					if (values) {
						test = bootstrapMeans(valuesOf(control as string, key).map((x) => x / scale), valuesOf(v.stats.variant, key).map((x) => x / scale));
					} else {
						const a = base.row;
						const b = v.row;
						test = welch(
							num(a[`${key}_mean`]) / scale,
							num(a[`${key}_var`]) / (scale * scale),
							base.stats.players,
							num(b[`${key}_mean`]) / scale,
							num(b[`${key}_var`]) / (scale * scale),
							v.stats.players,
						);
					}
					add(metric, test);
				}
			}
		}
		return {
			experiment: o.experiment ?? "(server)",
			scope: o.scope,
			control,
			variants: variants.map((v) => v.stats),
			comparisons,
			mixedPlayers: num(rows.mixed[0]?.mixed),
		};
	},
});

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
