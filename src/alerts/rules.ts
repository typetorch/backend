/**
 * Backend alert rules: what the backend watches in its own data (src/alerts/evaluator.ts), each rule with an on/off
 * switch, a level and its thresholds. One runtime setting (`backendAlerts`) holds all of them, so the Settings page edits
 * them without a redeploy; the environment gives the defaults, one variable per value:
 *   TYPETORCH_BACKEND_ALERTS=on|off            every rule at once
 *   TYPETORCH_BACKEND_ALERTS_REPEAT_MINUTES    how long the same alert stays quiet after it was raised
 *   TYPETORCH_BACKEND_ALERTS_PER_HOUR          backend alerts raised per hour at most (the rest are counted)
 *   TYPETORCH_ALERT_<RULE>=on|off, TYPETORCH_ALERT_<RULE>_LEVEL, TYPETORCH_ALERT_<RULE>_<THRESHOLD>
 * The defaults stay quiet on a small test place: every rule that compares against "before" needs a minimum volume first.
 */
import type { AlertLevel } from "../fleet/service.ts";

const ALERT_LEVELS: readonly AlertLevel[] = ["critical", "warning", "info"];

/** What a rule needs to run; without it the rule is skipped (and says why). */
export type RuleNeeds = "analytics" | "fleet";

export interface ParamDef {
	key: string;
	/** The suffix of the environment variable: TYPETORCH_ALERT_<RULE>_<env>. */
	env: string;
	label: string;
	unit: string;
	min: number;
	max: number;
	default: number;
	/** What 0 means, when 0 is allowed below `min` ("off"). */
	zero?: string;
}

export interface RuleDef {
	id: RuleId;
	/** The alert's code (lowercase, as the fleet's alert codes). */
	code: string;
	/** The middle of the environment variable: TYPETORCH_ALERT_<env>. */
	env: string;
	group: "errors" | "players" | "ingest" | "backend" | "disk";
	label: string;
	help: string;
	level: AlertLevel;
	on: boolean;
	needs: RuleNeeds[];
	params: readonly ParamDef[];
}

export const RULE_IDS = ["errorSpike", "errorNewAfterDeploy", "ccuDrop", "fleetSilent", "ingestStopped", "backendLatency", "backendMemory", "backendLoopLag", "backend5xx", "diskLow", "diskGrowth"] as const;
export type RuleId = (typeof RULE_IDS)[number];

const p = (key: string, env: string, label: string, unit: string, min: number, max: number, def: number, zero?: string): ParamDef => ({ key, env, label, unit, min, max, default: def, ...(zero ? { zero } : {}) });

/** The rules, in the order the Settings page lists them. */
export const RULES: readonly RuleDef[] = [
	{
		id: "errorSpike",
		code: "backend_error_spike",
		env: "ERROR_SPIKE",
		group: "errors",
		label: "Error spike",
		help: "An error kind's count in the last minutes is far above its usual rate (the hours before).",
		level: "warning",
		on: true,
		needs: [],
		params: [
			p("minutes", "MINUTES", "Window", "min", 5, 120, 10),
			p("factor", "FACTOR", "Times the usual rate", "x", 2, 1000, 5),
			p("minCount", "MIN_COUNT", "At least", "errors in the window", 5, 1_000_000, 50),
			p("baselineHours", "BASELINE_HOURS", "Usual rate over", "h", 1, 72, 24),
		],
	},
	{
		id: "errorNewAfterDeploy",
		code: "backend_error_new",
		env: "ERROR_NEW",
		group: "errors",
		label: "New error after a deploy",
		help: "An error kind never seen before shows up within minutes of the latest deploy.",
		level: "warning",
		on: true,
		needs: ["fleet"],
		params: [p("minutes", "MINUTES", "First seen within", "min after the deploy", 5, 1440, 30), p("minCount", "MIN_COUNT", "At least", "errors", 1, 1_000_000, 20)],
	},
	{
		id: "ccuDrop",
		code: "backend_ccu_drop",
		env: "CCU_DROP",
		group: "players",
		label: "Players online drop",
		help: "Players online (fleet heartbeats) fall by this share within the window while servers are still up.",
		level: "critical",
		on: true,
		needs: ["fleet"],
		params: [p("percent", "PERCENT", "Drop", "%", 10, 100, 50), p("minutes", "MINUTES", "Within", "min", 2, 120, 10), p("minPlayers", "MIN_PLAYERS", "Peak at least", "players", 1, 10_000_000, 20)],
	},
	{
		id: "fleetSilent",
		code: "backend_fleet_silent",
		env: "FLEET_SILENT",
		group: "players",
		label: "Fleet silent",
		help: "No heartbeats (and no analytics ingest, when it runs) for the window, after players were online in the hour before.",
		level: "critical",
		on: true,
		needs: ["fleet"],
		params: [p("minutes", "MINUTES", "Silent for", "min", 3, 240, 10), p("minPlayers", "MIN_PLAYERS", "Players before at least", "players", 1, 10_000_000, 10)],
	},
	{
		id: "ingestStopped",
		code: "backend_ingest_stopped",
		env: "INGEST_STOPPED",
		group: "ingest",
		label: "Ingest stopped",
		help: "No analytics rows for the window after steady traffic in the 30 minutes before, while players are still online.",
		level: "warning",
		on: true,
		needs: ["analytics"],
		params: [p("minutes", "MINUTES", "No rows for", "min", 3, 120, 10), p("minRowsPerMinute", "MIN_ROWS_PER_MINUTE", "Traffic before at least", "rows / min", 1, 1_000_000_000, 100)],
	},
	{
		id: "backendLatency",
		code: "backend_latency",
		env: "LATENCY",
		group: "backend",
		label: "Slow requests",
		help: "Request latency p99 above the threshold in every minute of the window (minutes with few requests don't count).",
		level: "warning",
		on: true,
		needs: [],
		params: [p("p99Ms", "P99_MS", "p99 above", "ms", 50, 60_000, 2000), p("minutes", "MINUTES", "For", "min", 1, 60, 5), p("minRequests", "MIN_REQUESTS", "Requests at least", "a minute", 1, 1_000_000, 30)],
	},
	{
		id: "backendMemory",
		code: "backend_memory",
		env: "MEMORY",
		group: "backend",
		label: "Memory",
		help: "The backend process's resident memory (RSS) above the threshold for the whole window.",
		level: "warning",
		on: true,
		needs: [],
		params: [p("rssMb", "RSS_MB", "RSS above", "MB", 64, 65_536, 800), p("minutes", "MINUTES", "For", "min", 1, 60, 5)],
	},
	{
		id: "backendLoopLag",
		code: "backend_loop_lag",
		env: "LOOP_LAG",
		group: "backend",
		label: "Event loop lag",
		help: "The event loop came late by more than the threshold in every minute of the window (the server is too busy to answer).",
		level: "warning",
		on: true,
		needs: [],
		params: [p("lagMs", "LAG_MS", "Lag above", "ms", 10, 60_000, 500), p("minutes", "MINUTES", "For", "min", 1, 60, 3)],
	},
	{
		id: "backend5xx",
		code: "backend_5xx",
		env: "5XX",
		group: "backend",
		label: "Server errors (5xx)",
		help: "The share of requests answered 5xx over the window.",
		level: "warning",
		on: true,
		needs: [],
		params: [p("percent", "PERCENT", "Share above", "%", 1, 100, 5), p("minutes", "MINUTES", "Over", "min", 1, 60, 5), p("minRequests", "MIN_REQUESTS", "Requests at least", "in the window", 1, 1_000_000_000, 100)],
	},
	{
		id: "diskLow",
		code: "backend_disk_low",
		env: "DISK_LOW",
		group: "disk",
		label: "Disk space low",
		help: "Free space on the data folder's disk below either threshold.",
		level: "critical",
		on: true,
		needs: [],
		params: [p("percent", "PERCENT", "Free below", "%", 1, 90, 10, "off"), p("gb", "GB", "Or free below", "GB", 1, 100_000, 2, "off")],
	},
	{
		id: "diskGrowth",
		code: "backend_disk_growth",
		env: "DISK_GROWTH",
		group: "disk",
		label: "Disk filling up",
		help: "At the growth of the last days (at least one day of hourly samples), the disk is full within this many days.",
		level: "warning",
		on: true,
		needs: [],
		params: [p("days", "DAYS", "Full within", "days", 1, 365, 7)],
	},
];

export const RULES_BY_ID = new Map<RuleId, RuleDef>(RULES.map((r) => [r.id, r]));

export interface RuleSetting {
	on: boolean;
	level: AlertLevel;
	params: Record<string, number>;
}

/** The `backendAlerts` runtime setting. */
export interface BackendAlertSettings {
	/** The master switch. */
	on: boolean;
	/** The same alert (rule and subject) is raised again only after this many minutes. */
	repeatMinutes: number;
	/** Backend alerts raised per hour at most. */
	perHour: number;
	rules: Record<RuleId, RuleSetting>;
}

export const GENERAL_PARAMS: readonly ParamDef[] = [
	p("repeatMinutes", "TYPETORCH_BACKEND_ALERTS_REPEAT_MINUTES", "Repeat after", "min", 5, 10_080, 180),
	p("perHour", "TYPETORCH_BACKEND_ALERTS_PER_HOUR", "At most", "alerts / hour", 1, 120, 12),
];

export const BACKEND_ALERTS_ENV = "TYPETORCH_BACKEND_ALERTS";
export const ruleEnv = (rule: RuleDef, suffix?: string): string => `TYPETORCH_ALERT_${rule.env}${suffix ? `_${suffix}` : ""}`;

/** Every environment variable the backend alerts read. */
export function alertEnvNames(): string[] {
	return [BACKEND_ALERTS_ENV, ...GENERAL_PARAMS.map((g) => g.env), ...RULES.flatMap((r) => [ruleEnv(r), ruleEnv(r, "LEVEL"), ...r.params.map((q) => ruleEnv(r, q.env))])];
}

export function defaultAlertSettings(): BackendAlertSettings {
	return {
		on: true,
		repeatMinutes: GENERAL_PARAMS[0].default,
		perHour: GENERAL_PARAMS[1].default,
		rules: Object.fromEntries(RULES.map((r) => [r.id, { on: r.on, level: r.level, params: Object.fromEntries(r.params.map((q) => [q.key, q.default])) }])) as Record<RuleId, RuleSetting>,
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function checkNumber(def: ParamDef, raw: unknown, where: string): number {
	const range = `${def.min} to ${def.max}${def.zero ? ` (or 0 = ${def.zero})` : ""}`;
	if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new Error(`${where} must be a whole number from ${range}`);
	if (def.zero && raw === 0) return 0;
	if (raw < def.min || raw > def.max) throw new Error(`${where} must be from ${range}`);
	return raw;
}

/**
 * Checks a `backendAlerts` value strictly and returns it normalised. Missing parts keep `base` (the current value, else
 * the defaults), so `{ "rules": { "ccuDrop": { "on": false } } }` turns one rule off. Unknown names are refused; the
 * error messages only hold names from the definitions.
 */
export function checkAlertSettings(raw: unknown, base: BackendAlertSettings = defaultAlertSettings()): BackendAlertSettings {
	if (!isRecord(raw)) throw new Error('backendAlerts is an object: { "on", "repeatMinutes", "perHour", "rules": { "<rule>": { "on", "level", "params": { ... } } } }');
	const out: BackendAlertSettings = { on: base.on, repeatMinutes: base.repeatMinutes, perHour: base.perHour, rules: { ...base.rules } };
	for (const name of Object.keys(raw)) if (!["on", "repeatMinutes", "perHour", "rules"].includes(name)) throw new Error(`backendAlerts: unknown field (the fields are on, repeatMinutes, perHour, rules)`);
	if (raw.on !== undefined) {
		if (typeof raw.on !== "boolean") throw new Error("backendAlerts.on is true or false");
		out.on = raw.on;
	}
	for (const g of GENERAL_PARAMS) if (raw[g.key] !== undefined) (out as unknown as Record<string, number>)[g.key] = checkNumber(g, raw[g.key], `backendAlerts.${g.key}`);
	if (raw.rules !== undefined) {
		if (!isRecord(raw.rules)) throw new Error("backendAlerts.rules is an object of rules by name");
		for (const [id, value] of Object.entries(raw.rules)) {
			const def = RULES_BY_ID.get(id as RuleId);
			if (!def) throw new Error(`backendAlerts.rules: unknown rule; the rules are ${RULE_IDS.join(", ")}`);
			if (!isRecord(value)) throw new Error(`backendAlerts.rules.${def.id} is an object: { "on", "level", "params" }`);
			for (const name of Object.keys(value)) if (!["on", "level", "params"].includes(name)) throw new Error(`backendAlerts.rules.${def.id}: unknown field (the fields are on, level, params)`);
			const prev = base.rules[def.id];
			const rule: RuleSetting = { on: prev.on, level: prev.level, params: { ...prev.params } };
			if (value.on !== undefined) {
				if (typeof value.on !== "boolean") throw new Error(`backendAlerts.rules.${def.id}.on is true or false`);
				rule.on = value.on;
			}
			if (value.level !== undefined) {
				if (typeof value.level !== "string" || !(ALERT_LEVELS as readonly string[]).includes(value.level)) throw new Error(`backendAlerts.rules.${def.id}.level is one of ${ALERT_LEVELS.join(", ")}`);
				rule.level = value.level as AlertLevel;
			}
			if (value.params !== undefined) {
				if (!isRecord(value.params)) throw new Error(`backendAlerts.rules.${def.id}.params is an object`);
				for (const [key, n] of Object.entries(value.params)) {
					const param = def.params.find((q) => q.key === key);
					if (!param) throw new Error(`backendAlerts.rules.${def.id}.params: unknown threshold; the thresholds are ${def.params.map((q) => q.key).join(", ")}`);
					rule.params[param.key] = checkNumber(param, n, `backendAlerts.rules.${def.id}.params.${param.key}`);
				}
			}
			out.rules[def.id] = rule;
		}
	}
	return out;
}

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];

function envFlag(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (TRUE.includes(raw.toLowerCase())) return true;
	if (FALSE.includes(raw.toLowerCase())) return false;
	throw new Error(`${name} is on or off (1/0, true/false, yes/no, on/off)`);
}

function envNumber(env: Record<string, string | undefined>, name: string, def: ParamDef, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	return checkNumber(def, Number(raw), name);
}

/** The defaults from the environment (an invalid value stops the start, like every other setting). */
export function alertSettingsFromEnv(env: Record<string, string | undefined>): BackendAlertSettings {
	const out = defaultAlertSettings();
	out.on = envFlag(env, BACKEND_ALERTS_ENV, out.on);
	out.repeatMinutes = envNumber(env, GENERAL_PARAMS[0].env, GENERAL_PARAMS[0], out.repeatMinutes);
	out.perHour = envNumber(env, GENERAL_PARAMS[1].env, GENERAL_PARAMS[1], out.perHour);
	for (const r of RULES) {
		const rule = out.rules[r.id];
		rule.on = envFlag(env, ruleEnv(r), rule.on);
		const level = env[ruleEnv(r, "LEVEL")];
		if (level) {
			if (!(ALERT_LEVELS as readonly string[]).includes(level.toLowerCase())) throw new Error(`${ruleEnv(r, "LEVEL")} is one of ${ALERT_LEVELS.join(", ")}`);
			rule.level = level.toLowerCase() as AlertLevel;
		}
		for (const q of r.params) rule.params[q.key] = envNumber(env, ruleEnv(r, q.env), q, rule.params[q.key] as number);
	}
	return out;
}

/** The rule definitions as the Settings page reads them (GET /v1/admin/settings, on the backendAlerts setting). */
export function rulesMeta(): { general: ParamDef[]; rules: (Omit<RuleDef, "env"> & { env: string })[] } {
	return {
		general: GENERAL_PARAMS.map((g) => ({ ...g })),
		rules: RULES.map((r) => ({ ...r, env: ruleEnv(r), needs: [...r.needs], params: r.params.map((q) => ({ ...q, env: ruleEnv(r, q.env) })) })),
	};
}
