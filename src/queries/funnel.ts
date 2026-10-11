/** Funnels (e.g. onboarding steps) and one player's timeline. */
import { PROP_KEYS } from "../schema.ts";
import { assertSafeKey, lit } from "../sql/dialect.ts";
import { checkPid, defineQuery, eventsTable, int, intOption, iso, num, numOrNull, playerRows, ratio, round, str, strOrNull, where } from "./core.ts";

// funnel ------------------------------------------------------------------------------------------------------------------

export interface FunnelOptions {
	/** The funnel (the `name` of its funnel rows). Without it, the query lists the funnels it finds. */
	funnel?: string;
	stepKey: string;
	labelKey: string;
}

export interface FunnelStep {
	step: number;
	label: string | null;
	/** Players who got at least this far (their highest step >= this one). */
	reached: number;
	/** Share of the players who started the funnel. */
	ofStart: number;
	/** Share of the players who reached the step before. */
	fromPrevious: number;
	/** Players who logged exactly this step. */
	logged: number;
	/** Median time from the player's first funnel step to this one. */
	medianSecondsFromStart: number | null;
}

export type FunnelResult =
	| { funnel: null; funnels: { name: string; players: number; events: number }[] }
	| { funnel: string; players: number; steps: FunnelStep[]; biggestDrop: { step: number; lost: number; share: number } | null };

export const funnel = defineQuery<FunnelOptions, FunnelResult>({
	name: "funnel",
	summary: "a funnel step by step (players reaching each step, drop-off, time from the start); no funnel: the list",
	defaultDays: 30,
	options: (input = {}) => {
		const out: FunnelOptions = {
			stepKey: assertSafeKey(input.stepKey ?? PROP_KEYS.funnelStep, "stepKey"),
			labelKey: assertSafeKey(input.labelKey ?? PROP_KEYS.funnelLabel, "labelKey"),
		};
		if (input.funnel !== undefined && input.funnel !== "") out.funnel = assertSafeKey(input.funnel, "funnel");
		return out;
	},
	statements(ctx, f, o): Record<string, string> {
		const lim = ctx.dialect.limit;
		const table = eventsTable(ctx, f);
		if (!o.funnel) {
			return {
				list:
					`SELECT e.name AS name, COUNT(DISTINCT e.pid) AS players, COUNT(*) AS events FROM ${table} e ` +
					`WHERE ${where(f, ctx)} AND e.kind = 'funnel' GROUP BY e.name ORDER BY players DESC, name ${lim(1000)}`,
			};
		}
		const d = ctx.dialect;
		const base =
			`f AS (SELECT e.pid AS pid, e.t AS t, CAST(${d.jsonNumber("e.props", o.stepKey)} AS BIGINT) AS step, ${d.jsonText("e.props", o.labelKey)} AS label ` +
			`FROM ${table} e WHERE ${where(f, ctx)} AND e.kind = 'funnel' AND e.name = ${lit(o.funnel)} AND e.pid IS NOT NULL AND e.pid <> ''), ` +
			`f2 AS (SELECT pid, step, MIN(t) AS t FROM f WHERE step IS NOT NULL GROUP BY pid, step), ` +
			`pm AS (SELECT pid, MAX(step) AS maxstep, MIN(t) AS t0 FROM f2 GROUP BY pid)`;
		return {
			steps: `WITH ${base} SELECT f2.step AS step, COUNT(*) AS logged, MEDIAN(f2.t - pm.t0) AS median_ms FROM f2 JOIN pm ON pm.pid = f2.pid GROUP BY f2.step ORDER BY step ${lim(1000)}`,
			reached: `WITH ${base} SELECT st.step AS step, COUNT(*) AS reached FROM (SELECT DISTINCT step FROM f2) st JOIN pm ON pm.maxstep >= st.step GROUP BY st.step ORDER BY step ${lim(1000)}`,
			labels: `WITH ${base} SELECT step, label, COUNT(*) AS n FROM f WHERE step IS NOT NULL AND label IS NOT NULL GROUP BY step, label ORDER BY step, n DESC ${lim(10_000)}`,
			players: `WITH ${base} SELECT COUNT(*) AS players FROM pm ${lim(1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		if (!o.funnel) {
			return { funnel: null, funnels: rows.list.map((r) => ({ name: str(r.name), players: num(r.players), events: num(r.events) })) };
		}
		const labels = new Map<number, string>();
		for (const r of rows.labels) if (!labels.has(num(r.step))) labels.set(num(r.step), str(r.label));
		const logged = new Map(rows.steps.map((r) => [num(r.step), r]));
		const players = num(rows.players[0]?.players);
		let previous = players;
		let biggestDrop: { step: number; lost: number; share: number } | null = null;
		const steps: FunnelStep[] = rows.reached.map((r) => {
			const step = num(r.step);
			const reached = num(r.reached);
			const lost = previous - reached;
			if (lost > 0 && (!biggestDrop || lost > biggestDrop.lost)) biggestDrop = { step, lost, share: ratio(lost, previous) };
			const median = numOrNull(logged.get(step)?.median_ms);
			const out: FunnelStep = {
				step,
				label: labels.get(step) ?? null,
				reached,
				ofStart: ratio(reached, players),
				fromPrevious: ratio(reached, previous),
				logged: num(logged.get(step)?.logged),
				medianSecondsFromStart: median === null ? null : round(median / 1000, 1),
			};
			previous = reached;
			return out;
		});
		return { funnel: o.funnel, players, steps, biggestDrop };
	},
});

// timeline --------------------------------------------------------------------------------------------------------------

export interface TimelineOptions {
	pid: string;
	/** Most events to return (oldest first). Default 2000. */
	limit: number;
}

export interface TimelineEvent {
	time: string;
	t: number;
	kind: string;
	name: string;
	sid: string;
	state: string | null;
	art: string;
	src: string | null;
	props: unknown;
}

export interface TimelineResult {
	pid: string;
	sessions: { sid: string; start: string; end: string; minutes: number; events: number; firstSession: boolean; art: string; dev: string | null }[];
	events: TimelineEvent[];
	/** More events exist than `limit`. */
	truncated: boolean;
}

export const timeline = defineQuery<TimelineOptions, TimelineResult>({
	name: "timeline",
	summary: "one player's sessions and events, oldest first (by pid)",
	defaultDays: 90,
	options: (input = {}) => ({ pid: checkPid(input.pid), limit: intOption(input.limit, "limit", 2000, 1, 10_000) }),
	statements(ctx, f, o) {
		const table = eventsTable(ctx, f);
		const cond = `${where(f, ctx)} AND e.pid = ${lit(o.pid)}`;
		return {
			events:
				`SELECT e.t AS t, e.kind AS kind, e.name AS name, e.sid AS sid, e.state AS state, e.art AS art, e.src AS src, e.props AS props ` +
				`FROM ${table} e WHERE ${cond} ORDER BY e.t ${ctx.dialect.limit(o.limit + 1)}`,
			sessions:
				`SELECT e.sid AS sid, MIN(e.t) AS t0, MAX(e.t) AS t1, COUNT(*) AS events, MAX(CASE WHEN e.newp THEN 1 ELSE 0 END) AS isnew, ` +
				`MIN(e.art) AS art, MIN(e.dev) AS dev FROM ${table} e WHERE ${cond} GROUP BY e.sid ORDER BY t0 ${ctx.dialect.limit(10_000)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const events = rows.events.slice(0, o.limit).map<TimelineEvent>((r) => {
			let props: unknown = null;
			if (typeof r.props === "string" && r.props) {
				try {
					props = JSON.parse(r.props);
				} catch {
					props = r.props;
				}
			}
			return { time: iso(num(r.t)), t: num(r.t), kind: str(r.kind), name: str(r.name), sid: str(r.sid), state: strOrNull(r.state), art: str(r.art), src: strOrNull(r.src), props };
		});
		return {
			pid: o.pid,
			sessions: rows.sessions.map((r) => ({
				sid: str(r.sid),
				start: iso(num(r.t0)),
				end: iso(num(r.t1)),
				minutes: round((num(r.t1) - num(r.t0)) / 60_000, 1),
				events: num(r.events),
				firstSession: num(r.isnew) === 1,
				art: str(r.art),
				dev: strOrNull(r.dev),
			})),
			events,
			truncated: rows.events.length > o.limit,
		};
	},
});

// funnel-progress ---------------------------------------------------------------------------------------------------------

export interface FunnelProgressOptions {
	/** Only this funnel; without it, every funnel the players logged. */
	funnel?: string;
	/** The players to report (at most 500). */
	pids: string[];
	stepKey: string;
	labelKey: string;
}

export interface FunnelProgress {
	pid: string;
	funnel: string;
	/** The furthest step the player logged. */
	step: number;
	label: string | null;
	/** That step's place among the funnel's steps (1-based) and how many steps the funnel has in the range. */
	reached: number;
	of: number;
	/** reached / of, 0-1. */
	share: number;
	/** When they first logged that furthest step (ISO). */
	reachedAt?: string;
}

export interface FunnelProgressResult {
	/** Each funnel's steps (every step anyone logged in the range), in order. */
	funnels: { name: string; steps: { step: number; label: string | null }[] }[];
	/** One row per player and funnel they started; a player missing for a funnel never logged a step of it. */
	progress: FunnelProgress[];
}

export const funnelProgress = defineQuery<FunnelProgressOptions, FunnelProgressResult>({
	name: "funnel-progress",
	summary: "how far given players (pids, at most 500) got in each funnel (or one): furthest step and share of the funnel's steps",
	defaultDays: 30,
	options: (input = {}) => {
		if (!Array.isArray(input.pids) || input.pids.length === 0 || input.pids.length > 500) throw new Error("pids must be a list of 1 to 500 pids");
		const out: FunnelProgressOptions = {
			pids: [...new Set(input.pids.map((p) => checkPid(p)))],
			stepKey: assertSafeKey(input.stepKey ?? PROP_KEYS.funnelStep, "stepKey"),
			labelKey: assertSafeKey(input.labelKey ?? PROP_KEYS.funnelLabel, "labelKey"),
		};
		if (input.funnel !== undefined && input.funnel !== "") out.funnel = assertSafeKey(input.funnel, "funnel");
		return out;
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const lim = d.limit;
		const table = eventsTable(ctx, f);
		const base =
			`f AS (SELECT e.name AS name, e.pid AS pid, e.t AS t, CAST(${d.jsonNumber("e.props", o.stepKey)} AS BIGINT) AS step, ${d.jsonText("e.props", o.labelKey)} AS label ` +
			`FROM ${table} e WHERE ${where(f, ctx)} AND e.kind = 'funnel'${o.funnel ? ` AND e.name = ${lit(o.funnel)}` : ""} AND e.pid IS NOT NULL AND e.pid <> '')`;
		const mine = `pid IN (${o.pids.map(lit).join(", ")})`;
		// Only the funnels these players started, so a long list of funnels doesn't cost a scan of each.
		const started = o.funnel ? "" : ` AND name IN (SELECT DISTINCT name FROM f WHERE ${mine})`;
		return {
			steps: `WITH ${base} SELECT name, step, label, COUNT(*) AS n FROM f WHERE step IS NOT NULL${started} GROUP BY name, step, label ORDER BY name, step, n DESC ${lim(10_000)}`,
			// The furthest step per player and funnel, and when they first logged it.
			players:
				`WITH ${base}, g AS (SELECT pid, name, step, MIN(t) AS t FROM f WHERE step IS NOT NULL AND ${mine} GROUP BY pid, name, step), ` +
				`m AS (SELECT pid, name, MAX(step) AS maxstep FROM g GROUP BY pid, name) ` +
				`SELECT m.pid AS pid, m.name AS name, m.maxstep AS maxstep, g.t AS t FROM m JOIN g ON g.pid = m.pid AND g.name = m.name AND g.step = m.maxstep ` +
				`ORDER BY pid, name ${lim(50_000)}`,
		};
	},
	shape(rows) {
		const funnels = new Map<string, Map<number, string | null>>();
		for (const r of rows.steps) {
			const name = str(r.name);
			const steps = funnels.get(name) ?? new Map<number, string | null>();
			funnels.set(name, steps);
			const step = num(r.step);
			const label = strOrNull(r.label);
			// Rows come most-logged label first; a step keeps its first non-null label.
			if (!steps.has(step) || (steps.get(step) === null && label !== null)) steps.set(step, label);
		}
		const ordered = new Map<string, { step: number; label: string | null }[]>();
		for (const [name, steps] of [...funnels].sort(([a], [b]) => a.localeCompare(b))) {
			ordered.set(
				name,
				[...steps].sort(([a], [b]) => a - b).map(([step, label]) => ({ step, label })),
			);
		}
		const progress: FunnelProgress[] = [];
		for (const r of rows.players) {
			const steps = ordered.get(str(r.name));
			if (!steps?.length) continue;
			const step = num(r.maxstep);
			const at = steps.findIndex((s) => s.step === step);
			const reached = at + 1;
			progress.push({
				pid: str(r.pid),
				funnel: str(r.name),
				step,
				label: steps[at]?.label ?? null,
				reached,
				of: steps.length,
				share: ratio(reached, steps.length),
				...(r.t === null || r.t === undefined ? {} : { reachedAt: iso(num(r.t)) }),
			});
		}
		return { funnels: [...ordered].map(([name, steps]) => ({ name, steps })), progress };
	},
});

// playtime-funnel ---------------------------------------------------------------------------------------------------------

/** The playtime funnel's thresholds, seconds (each step: playtime >= this, edges inclusive). */
export const PLAYTIME_STEPS_SECONDS = [30, 60, 180, 300, 600, 1800, 3600, 7200] as const;

/**
 * A session counts at most this long. A session's length is its first to its last event (the same as every other
 * query; a session still running counts up to its latest event). A server that kept a stuck or AFK session alive for
 * days would otherwise put one player past every step.
 */
export const PLAYTIME_SESSION_CAP_MS = 12 * 3_600_000;

/**
 * `total`: each player's playtime in the range (their sessions summed); the base is every player with a session row.
 * `first`: each new player's first-ever session (the rows the framework flags `newp`) found in the range; the base is
 * those new players. Players whose first session was before the range aren't in it (their first session isn't there).
 */
export type PlaytimeMeasure = "total" | "first";

export interface PlaytimeFunnelOptions {
	measure: PlaytimeMeasure;
}

export interface PlaytimeStep {
	/** The threshold: playtime >= seconds. */
	seconds: number;
	label: string;
	reached: number;
	/** Share of the base (every player, zero playtime included). */
	ofTotal: number;
	/** Share of the step before (the first step: of the base). */
	fromPrevious: number;
}

export interface PlaytimeFunnelResult {
	measure: PlaytimeMeasure;
	/** Players in the base (zero recorded playtime included). */
	players: number;
	/** The cap on one session's length, hours. */
	sessionCapHours: number;
	steps: PlaytimeStep[];
	biggestDrop: { seconds: number; lost: number; share: number } | null;
}

export function playtimeLabel(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600 || seconds % 3600 !== 0) return `${seconds / 60}m`;
	return `${seconds / 3600}h`;
}

export const playtimeFunnel = defineQuery<PlaytimeFunnelOptions, PlaytimeFunnelResult>({
	name: "playtime-funnel",
	summary: "share of players whose playtime reached 30s, 1m, 3m, 5m, 10m, 30m, 1h, 2h: total in the range, or (measure: first) new players' first session",
	defaultDays: 30,
	options: (input = {}) => {
		const measure = input.measure ?? "total";
		if (measure !== "total" && measure !== "first") throw new Error(`measure must be "total" or "first"`);
		return { measure };
	},
	statements(ctx, f, o) {
		const table = eventsTable(ctx, f);
		const cap = int(PLAYTIME_SESSION_CAP_MS);
		const first = o.measure === "first";
		// One statement: sessions (first to last event, capped), summed per player, then one count per step.
		const counts = PLAYTIME_STEPS_SECONDS.map((sec) => `SUM(CASE WHEN len >= ${int(sec * 1000)} THEN 1 ELSE 0 END) AS r${sec}`).join(", ");
		return {
			funnel:
				`WITH ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t FROM ${table} e WHERE ${playerRows(f, ctx, first ? "e.newp" : "")}), ` +
				`s0 AS (SELECT sid, MIN(pid) AS pid, MAX(t) - MIN(t) AS len FROM ev GROUP BY sid), ` +
				`s AS (SELECT sid, pid, CASE WHEN len > ${cap} THEN ${cap} ELSE len END AS len FROM s0), ` +
				// A player has one first session; should two be flagged (a rejoin before the first was saved), the longest counts.
				`u AS (SELECT pid, ${first ? "MAX(len)" : "SUM(len)"} AS len FROM s GROUP BY pid) ` +
				`SELECT COUNT(*) AS players, ${counts} FROM u ${ctx.dialect.limit(1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const row = rows.funnel[0] ?? {};
		const players = num(row.players);
		let previous = players;
		let biggestDrop: PlaytimeFunnelResult["biggestDrop"] = null;
		const steps = PLAYTIME_STEPS_SECONDS.map<PlaytimeStep>((seconds) => {
			const reached = num(row[`r${seconds}`]);
			const lost = previous - reached;
			if (lost > 0 && (!biggestDrop || lost > biggestDrop.lost)) biggestDrop = { seconds, lost, share: ratio(lost, previous) };
			const out = { seconds, label: playtimeLabel(seconds), reached, ofTotal: ratio(reached, players), fromPrevious: ratio(reached, previous) };
			previous = reached;
			return out;
		});
		return { measure: o.measure, players, sessionCapHours: PLAYTIME_SESSION_CAP_MS / 3_600_000, steps, biggestDrop };
	},
});

// funnel-players ----------------------------------------------------------------------------------------------------------

/** Most players one funnel -> players read lists (the cap). */
export const FUNNEL_PLAYERS_MAX = 200;

export type FunnelPlayersMode = "reached" | "dropped";

export interface FunnelPlayersOptions {
	/** A logged funnel (the `name` of its funnel rows); or `measure` for a playtime funnel (one of the two). */
	funnel?: string;
	measure?: PlaytimeMeasure;
	/** Logged funnels: the step (its index value, `props.i`). Playtime funnels: the threshold in seconds. */
	step: number;
	/** reached: got at least this far. dropped: reached the step before (the start, for the first) but not this one. */
	mode: FunnelPlayersMode;
	/** Most rows listed (1-200, default 200). */
	limit: number;
	stepKey: string;
}

/** One player at a funnel step. */
export interface FunnelPlayer {
	pid: string;
	/**
	 * Logged funnels: reached, when they first logged this step or a later one; dropped, when they first logged their
	 * last step. Playtime funnels: null (playtime is a sum, not a moment).
	 */
	at: string | null;
	/** Logged funnels: their furthest step in the range and when they first logged it. Null for playtime funnels. */
	lastStep: number | null;
	lastStepAt: string | null;
	/** Playtime funnels: their playtime (total in the range, or the first session), seconds. */
	playtimeSeconds?: number;
	/** Their latest row in the range under the filters (ISO). */
	lastAt: string | null;
	/** Joined in by the server route: the UserId (identity table) and Roblox names (profile cache), when known. */
	uid?: number;
	name?: string;
	displayName?: string;
}

export interface FunnelPlayersResult {
	funnel: string | null;
	measure: PlaytimeMeasure | null;
	step: number;
	mode: FunnelPlayersMode;
	/** Players matching; `more` of them are not listed. */
	total: number;
	more: number;
	players: FunnelPlayer[];
}

/**
 * The players at one funnel step (Funnels page side panel), the same membership as the `funnel` and `playtime-funnel`
 * counts. Logged funnel: a player reached step S when their furthest step in the range is >= S (`funnel`'s "reached");
 * dropped at S when their furthest step is >= the step before S (the previous step anyone logged in the range) and < S.
 * Playtime funnel: reached when their playtime (capped sessions, summed or the first one) is >= the threshold, dropped
 * when it is >= the threshold before (0 for the first) and below this one. One statement; the total rides along as a
 * window count. Logged funnels: most recent `at` first; playtime funnels: most recently seen first.
 */
export const funnelPlayers = defineQuery<FunnelPlayersOptions, FunnelPlayersResult>({
	name: "funnel-players",
	summary: "the players who reached (or dropped off at) one funnel step, a logged funnel or (measure) a playtime one (at most 200)",
	defaultDays: 30,
	options: (input = {}) => {
		const hasFunnel = input.funnel !== undefined && input.funnel !== "";
		const hasMeasure = input.measure !== undefined && (input.measure as unknown) !== "";
		if (hasFunnel === hasMeasure) throw new Error("give funnel (a logged funnel) or measure (a playtime funnel), one of the two");
		const mode = input.mode ?? "reached";
		if (mode !== "reached" && mode !== "dropped") throw new Error('mode must be "reached" or "dropped"');
		const raw: unknown = input.step;
		const step = typeof raw === "string" && /^-?\d{1,10}$/.test(raw) ? Number(raw) : raw;
		if (typeof step !== "number" || !Number.isInteger(step) || Math.abs(step) > 1e9) throw new Error("step must be a whole number");
		const out: FunnelPlayersOptions = {
			step,
			mode,
			limit: intOption(input.limit, "limit", FUNNEL_PLAYERS_MAX, 1, FUNNEL_PLAYERS_MAX),
			stepKey: assertSafeKey(input.stepKey ?? PROP_KEYS.funnelStep, "stepKey"),
		};
		if (hasFunnel) out.funnel = assertSafeKey(String(input.funnel), "funnel");
		else {
			if (input.measure !== "total" && input.measure !== "first") throw new Error('measure must be "total" or "first"');
			out.measure = input.measure;
			if (!(PLAYTIME_STEPS_SECONDS as readonly number[]).includes(step)) throw new Error(`step must be one of the playtime thresholds (${PLAYTIME_STEPS_SECONDS.join(", ")} s)`);
		}
		return out;
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const table = eventsTable(ctx, f);
		// Their latest row in the range, for the selected players only.
		const seen = `ls AS (SELECT e.pid AS pid, MAX(e.t) AS last_t FROM ${table} e WHERE ${where(f, ctx)} AND e.pid IN (SELECT pid FROM sel) GROUP BY e.pid)`;
		if (o.measure) {
			const cap = int(PLAYTIME_SESSION_CAP_MS);
			const first = o.measure === "first";
			const at = (PLAYTIME_STEPS_SECONDS as readonly number[]).indexOf(o.step);
			const lo = at > 0 ? (PLAYTIME_STEPS_SECONDS[at - 1] as number) : 0;
			const cond = o.mode === "reached" ? `len >= ${int(o.step * 1000)}` : `len >= ${int(lo * 1000)} AND len < ${int(o.step * 1000)}`;
			return {
				players:
					`WITH ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t FROM ${table} e WHERE ${playerRows(f, ctx, first ? "e.newp" : "")}), ` +
					`s0 AS (SELECT sid, MIN(pid) AS pid, MAX(t) - MIN(t) AS len FROM ev GROUP BY sid), ` +
					`s AS (SELECT sid, pid, CASE WHEN len > ${cap} THEN ${cap} ELSE len END AS len FROM s0), ` +
					`u AS (SELECT pid, ${first ? "MAX(len)" : "SUM(len)"} AS len FROM s GROUP BY pid), ` +
					`sel AS (SELECT pid, len FROM u WHERE ${cond}), ${seen} ` +
					`SELECT sel.pid AS pid, sel.len AS len, ls.last_t AS last_t, COUNT(*) OVER () AS total FROM sel LEFT JOIN ls ON ls.pid = sel.pid ` +
					`ORDER BY last_t DESC, pid ${d.limit(o.limit)}`,
			};
		}
		const s = int(o.step);
		const base =
			`f AS (SELECT e.pid AS pid, e.t AS t, CAST(${d.jsonNumber("e.props", o.stepKey)} AS BIGINT) AS step ` +
			`FROM ${table} e WHERE ${where(f, ctx)} AND e.kind = 'funnel' AND e.name = ${lit(o.funnel as string)} AND e.pid IS NOT NULL AND e.pid <> ''), ` +
			`f2 AS (SELECT pid, step, MIN(t) AS t FROM f WHERE step IS NOT NULL GROUP BY pid, step), ` +
			`pm AS (SELECT pid, MAX(step) AS maxstep FROM f2 GROUP BY pid), ` +
			`pl AS (SELECT f2.pid AS pid, f2.step AS maxstep, f2.t AS maxt FROM f2 JOIN pm ON pm.pid = f2.pid AND f2.step = pm.maxstep), `;
		const sel =
			o.mode === "reached"
				? `r AS (SELECT pid, MIN(t) AS rt FROM f2 WHERE step >= ${s} GROUP BY pid), ` +
					`sel AS (SELECT r.pid AS pid, r.rt AS rt, pl.maxstep AS maxstep, pl.maxt AS maxt FROM r JOIN pl ON pl.pid = r.pid)`
				: // The step before S among the steps anyone logged in the range (none for the first step: nobody drops there).
					`pv AS (SELECT MAX(step) AS ps FROM f2 WHERE step < ${s}), ` +
					`sel AS (SELECT pl.pid AS pid, pl.maxt AS rt, pl.maxstep AS maxstep, pl.maxt AS maxt FROM pl JOIN pv ON pl.maxstep >= pv.ps WHERE pl.maxstep < ${s})`;
		return {
			players:
				`WITH ${base}${sel}, ${seen} ` +
				`SELECT sel.pid AS pid, sel.rt AS rt, sel.maxstep AS maxstep, sel.maxt AS maxt, ls.last_t AS last_t, COUNT(*) OVER () AS total ` +
				`FROM sel LEFT JOIN ls ON ls.pid = sel.pid ORDER BY rt DESC, pid ${d.limit(o.limit)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const when = (v: unknown) => (v === null || v === undefined ? null : iso(num(v)));
		const players = rows.players.map((r): FunnelPlayer => {
			const lastAt = when(r.last_t);
			if (o.measure) return { pid: str(r.pid), at: null, lastStep: null, lastStepAt: null, playtimeSeconds: round(num(r.len) / 1000, 0), lastAt };
			return { pid: str(r.pid), at: when(r.rt), lastStep: num(r.maxstep), lastStepAt: when(r.maxt), lastAt };
		});
		const total = num(rows.players[0]?.total);
		return { funnel: o.funnel ?? null, measure: o.measure ?? null, step: o.step, mode: o.mode, total, more: Math.max(0, total - players.length), players };
	},
});
