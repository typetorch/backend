/**
 * Runtime settings: the backend settings an owner can change from the explorer's Settings page without a redeploy.
 * Coolify (like Docker) injects environment variables when the container is created, so a running process can't re-read
 * them; instead the environment gives the defaults and values saved here override them. They apply at once: every
 * consumer reads the current value through `get` (the rate limiters, the error store, the warehouse's pruning, the alert
 * notifier, the admin allow list, the login).
 *
 * Stored in `<data dir>/runtime-settings.json` (written atomically, mode 0600), with a short audit list: who changed
 * which keys, never the values. The alert webhook URL is a secret: no route returns it (only whether it is set and where
 * it comes from), no log line or error carries it.
 *
 * Two guards keep an owner from locking themselves out: a new admin allow list must include the caller's own address (as
 * the server sees it), and the token login can only be turned off from a Roblox session on a server where Sign in with
 * Roblox is configured. If it happens anyway (your address changed), TYPETORCH_RUNTIME_SETTINGS=off and a redeploy make
 * the server ignore the file (kept on disk) and use the environment again.
 *
 * The secrets and the wiring stay env-only (ENV_ONLY): changing them still needs Coolify and a redeploy.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHttpsUrl, parseUserIds, type ServerConfig } from "./config.ts";
import { ipAllowed, parseIpRules, type IpRule } from "./ipfilter.ts";

export const RUNTIME_SETTINGS_FILE = "runtime-settings.json";
/** Audit entries kept (newest first). */
export const AUDIT_MAX = 50;
/** Addresses and ranges in the admin allow list. */
export const ALLOW_LIST_MAX = 64;
/** Roblox UserIds in the viewer list (the read-only `web` role). */
export const VIEWERS_MAX = 200;
/** PATCH bodies are small. */
export const SETTINGS_BODY_MAX = 16 * 1024;

export const ALERT_LEVELS = ["critical", "warning", "info"] as const;
export type AlertLevelName = (typeof ALERT_LEVELS)[number];
/** "auto" = from the URL's host (Discord, Slack, else JSON). */
export const WEBHOOK_FORMATS = ["auto", "discord", "slack", "json"] as const;
export type WebhookFormatSetting = (typeof WEBHOOK_FORMATS)[number];

/** The effective value of every editable setting. */
export interface RuntimeValues {
	/** "" = no webhook. A secret. */
	alertWebhookUrl: string;
	alertWebhookFormat: WebhookFormatSetting;
	alertWebhookLevels: AlertLevelName[];
	/** [] = any address may reach the admin side. */
	adminAllowIps: string[];
	tokenLogin: boolean;
	/** Roblox UserIds who sign in as read-only viewers (the `web` role); owners (the access list) are admins regardless. */
	webViewers: number[];
	ipPerMinute: number;
	jobPerMinute: number;
	errorsIpPerMinute: number;
	fleetNewJobsPerMinute: number;
	keepDays: number;
	rawKeepDays: number;
	errorKeepDays: number;
	errorMaxKinds: number;
	errorRowsPerDay: number;
	deployKeepDays: number;
}
export type RuntimeKey = keyof RuntimeValues;
export type SettingSource = "env" | "dashboard" | "default";
export type SettingGroup = "alerts" | "access" | "limits" | "retention";

interface BaseDef {
	key: RuntimeKey;
	/** The environment variable that gives the default. */
	env: string;
	group: SettingGroup;
	label: string;
	help: string;
}

export type SettingDef =
	| (BaseDef & { kind: "secret" })
	| (BaseDef & { kind: "choice"; options: readonly string[] })
	| (BaseDef & { kind: "levels"; options: readonly string[] })
	| (BaseDef & { kind: "ips"; maxEntries: number })
	| (BaseDef & { kind: "users"; maxEntries: number })
	| (BaseDef & { kind: "switch" })
	| (BaseDef & { kind: "number"; min: number; max: number; unit: string; zero?: string });

/** The editable settings, in the order the Settings page shows them. Bounds apply to values saved from the dashboard. */
export const SETTINGS: readonly SettingDef[] = [
	{ key: "alertWebhookUrl", env: "TYPETORCH_ALERT_WEBHOOK_URL", group: "alerts", kind: "secret", label: "Alert webhook", help: "A Discord, Slack or JSON webhook (https). Never shown again once saved." },
	{ key: "alertWebhookFormat", env: "TYPETORCH_ALERT_WEBHOOK_FORMAT", group: "alerts", kind: "choice", options: WEBHOOK_FORMATS, label: "Webhook format", help: "auto picks Discord or Slack from the URL, else JSON." },
	{ key: "alertWebhookLevels", env: "TYPETORCH_ALERT_WEBHOOK_LEVELS", group: "alerts", kind: "levels", options: ALERT_LEVELS, label: "Alert levels sent", help: "Which alert levels go to the webhook." },
	{ key: "adminAllowIps", env: "TYPETORCH_ADMIN_ALLOW_IPS", group: "access", kind: "ips", maxEntries: ALLOW_LIST_MAX, label: "Admin allow list", help: "Addresses and CIDR ranges that may reach the explorer and admin routes; empty = any address. Game routes stay open." },
	{ key: "tokenLogin", env: "TYPETORCH_TOKEN_LOGIN", group: "access", kind: "switch", label: "Admin token login", help: "The explorer's paste-the-token login. The CLI's Bearer token works either way." },
	{ key: "webViewers", env: "TYPETORCH_WEB_VIEWERS", group: "access", kind: "users", maxEntries: VIEWERS_MAX, label: "Viewers (read-only)", help: "Roblox UserIds who may sign in with Roblox and see everything but change nothing (the web role). Owners from the access list are admins either way." },
	{ key: "ipPerMinute", env: "TYPETORCH_IP_PER_MINUTE", group: "limits", kind: "number", min: 100, max: 1_000_000, unit: "requests / min", label: "Ingest per address", help: "Game requests per address per minute (servers share egress addresses)." },
	{ key: "jobPerMinute", env: "TYPETORCH_JOB_PER_MINUTE", group: "limits", kind: "number", min: 10, max: 100_000, unit: "requests / min", label: "Ingest per server", help: "Ingest batches per game server (JobId) per minute." },
	{ key: "errorsIpPerMinute", env: "TYPETORCH_ERRORS_IP_PER_MINUTE", group: "limits", kind: "number", min: 60, max: 1_000_000, unit: "requests / min", label: "Error logs per address", help: "POST /v1/errors per address per minute." },
	{ key: "fleetNewJobsPerMinute", env: "TYPETORCH_NEW_JOBS_PER_MINUTE", group: "limits", kind: "number", min: 100, max: 1_000_000, unit: "servers / min", label: "New servers per minute", help: "Never-seen JobIds let in per minute (fleet and error logs, counted apart)." },
	{ key: "keepDays", env: "TYPETORCH_KEEP_DAYS", group: "retention", kind: "number", min: 7, max: 36_500, zero: "forever", unit: "days", label: "Analytics history", help: "Days of Parquet day files kept; 0 keeps them forever. Applied at the nightly export." },
	{ key: "rawKeepDays", env: "TYPETORCH_RAW_KEEP_DAYS", group: "retention", kind: "number", min: 1, max: 3650, zero: "forever", unit: "days", label: "Raw archives", help: "Days of raw batch archives kept; 0 keeps them forever. Applied at the nightly export." },
	{ key: "errorKeepDays", env: "TYPETORCH_ERROR_KEEP_DAYS", group: "retention", kind: "number", min: 1, max: 3650, unit: "days", label: "Error log history", help: "Days of error counts kept (pruned hourly)." },
	{ key: "errorMaxKinds", env: "TYPETORCH_ERROR_MAX_KINDS", group: "retention", kind: "number", min: 100, max: 1_000_000, unit: "kinds", label: "Error kinds stored", help: "Past it, new kinds are dropped and counted." },
	{ key: "errorRowsPerDay", env: "TYPETORCH_ERROR_ROWS_PER_DAY", group: "retention", kind: "number", min: 10_000, max: 1_000_000_000, unit: "rows / day", label: "Error rows per day", help: "New error count and player rows per UTC day; past it they are dropped and counted." },
	{ key: "deployKeepDays", env: "TYPETORCH_DEPLOY_KEEP_DAYS", group: "retention", kind: "number", min: 7, max: 3650, unit: "days", label: "Deploy history", help: "Days of releases kept in the deploy history (at most 10,000 rows; pruned hourly)." },
];

/** Settings that stay environment-only (secrets and wiring): change them on Coolify and redeploy. */
export const ENV_ONLY = [
	"TYPETORCH_API_KEY",
	"TYPETORCH_API_KEY_PREVIOUS",
	"TYPETORCH_ADMIN_TOKEN",
	"ROBLOX_OAUTH_CLIENT_ID",
	"ROBLOX_OAUTH_CLIENT_SECRET",
	"OPENCLOUD_API_KEY",
	"TYPETORCH_PUBLIC_URL",
	"TYPETORCH_TRUST_PROXY",
	"TYPETORCH_TRUSTED_PROXIES",
	"TYPETORCH_CLOUDFLARE",
	"TYPETORCH_DATA_DIR",
	"PORT",
	"HOST",
	"TYPETORCH_CENTRAL_LOGIN",
	"TYPETORCH_CENTRAL_LOGIN_ISSUER",
	"TYPETORCH_CENTRAL_LOGIN_UNBLESSED",
	"TYPETORCH_CENTRAL_LOGIN_KIDS",
	"TYPETORCH_CENTRAL_LOGIN_LABEL",
	"TYPETORCH_ROBLOX_BROKER_CLIENT_ID",
	"TYPETORCH_ROBLOX_BROKER_DISCOVERY",
] as const;

const BY_KEY = new Map<string, SettingDef>(SETTINGS.map((d) => [d.key, d]));

/** A refused change: 400 = the value is wrong, 409 = a guard (or the feature is off). The message never holds a secret. */
export class SettingsError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409,
		readonly key?: RuntimeKey,
		readonly guard?: "allow-list" | "token-login",
	) {
		super(message);
	}
}

/** Who changed something, for the audit list and the log line. */
export interface SettingsActor {
	/** "admin token", or "roblox user <id> (<name>)". */
	who: string;
	via: "bearer" | "session";
}

export interface PatchContext extends SettingsActor {
	/** The caller's address as the server sees it (trusted-proxy rules applied). */
	ip: string;
	/** The caller is signed in with Roblox (a session), not with the admin token. */
	robloxSession: boolean;
	/** Sign in with Roblox is configured on this server. */
	robloxSignIn: boolean;
}

export interface AuditEntry {
	at: string;
	who: string;
	via: "bearer" | "session";
	action: "change" | "test-alert";
	/** Keys given a value, and keys reset to the environment (names only, never values). */
	set?: RuntimeKey[];
	reset?: RuntimeKey[];
	/** The test alert's outcome ("sent (HTTP 204)", "failed: ..."); never the URL. */
	result?: string;
}

/** One setting as GET /v1/admin/settings shows it. A secret has `set` and `fallbackSet`, never a value. */
export type SettingView = {
	key: RuntimeKey;
	env: string;
	group: SettingGroup;
	label: string;
	help: string;
	kind: SettingDef["kind"];
	source: SettingSource;
	options?: readonly string[];
	min?: number;
	max?: number;
	zero?: string;
	unit?: string;
	maxEntries?: number;
} & ({ set: boolean; fallbackSet: boolean } | { value: unknown; fallback: unknown; fallbackSource: "env" | "default" });

export interface PatchResult {
	/** Keys whose stored value actually changed. */
	changed: RuntimeKey[];
	/** The token login went from on to off with this change. */
	tokenLoginTurnedOff: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A key name safe to echo back (it came from the request). */
const safeName = (name: string): string => (/^[A-Za-z0-9_]{1,48}$/.test(name) ? `"${name}"` : "(a key that is not a setting name)");

function parseAllowList(def: SettingDef & { kind: "ips" }, raw: unknown): string[] {
	let parts: unknown[];
	if (typeof raw === "string") {
		if (raw.length > 8192) throw new SettingsError(`${def.key} is too long`, 400, def.key);
		parts = [raw];
	} else if (Array.isArray(raw)) {
		if (raw.length > def.maxEntries) throw new SettingsError(`${def.key} holds at most ${def.maxEntries} addresses or ranges`, 400, def.key);
		parts = raw;
	} else throw new SettingsError(`${def.key} is a list of addresses and CIDR ranges (an array of strings, or one string separated by commas), [] for any address`, 400, def.key);
	const out: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string") throw new SettingsError(`${def.key} entries are strings: addresses or CIDR ranges`, 400, def.key);
		for (const piece of part.split(/[\s,]+/)) {
			const entry = piece.trim();
			if (!entry) continue;
			if (entry.length > 64) throw new SettingsError(`${def.key}: an entry is longer than 64 characters`, 400, def.key);
			try {
				parseIpRules(entry);
			} catch (error) {
				throw new SettingsError(`${def.key}: ${(error as Error).message}`, 400, def.key);
			}
			if (!out.includes(entry)) out.push(entry);
		}
	}
	if (out.length > def.maxEntries) throw new SettingsError(`${def.key} holds at most ${def.maxEntries} addresses or ranges`, 400, def.key);
	return out;
}

/** Checks one value strictly; returns it normalised. Throws SettingsError (never with the secret in it). */
export function checkSetting(def: SettingDef, raw: unknown): RuntimeValues[RuntimeKey] {
	switch (def.kind) {
		case "secret": {
			if (typeof raw !== "string") throw new SettingsError(`${def.key} is a string: an https:// URL, or "" for none`, 400, def.key);
			const value = raw.trim();
			if (value === "") return "";
			if (!isHttpsUrl(value)) throw new SettingsError(`${def.key} must be an https:// URL (or "" for none)`, 400, def.key);
			return value;
		}
		case "choice":
			if (typeof raw !== "string" || !def.options.includes(raw)) throw new SettingsError(`${def.key} is one of ${def.options.join(", ")}`, 400, def.key);
			return raw as WebhookFormatSetting;
		case "levels": {
			if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) throw new SettingsError(`${def.key} is a non-empty list of ${def.options.join(", ")}`, 400, def.key);
			for (const level of raw) if (typeof level !== "string" || !def.options.includes(level)) throw new SettingsError(`${def.key} is a non-empty list of ${def.options.join(", ")}`, 400, def.key);
			return def.options.filter((o) => raw.includes(o)) as AlertLevelName[];
		}
		case "ips":
			return parseAllowList(def, raw);
		case "users": {
			if (typeof raw === "string" ? raw.length > 8192 : !Array.isArray(raw)) {
				throw new SettingsError(`${def.key} is a list of Roblox UserIds (an array of numbers, or one string separated by commas), [] for none`, 400, def.key);
			}
			try {
				return parseUserIds(raw as string | unknown[], def.maxEntries);
			} catch (error) {
				throw new SettingsError(`${def.key}: ${(error as Error).message}`, 400, def.key);
			}
		}
		case "switch":
			if (typeof raw !== "boolean") throw new SettingsError(`${def.key} is true or false`, 400, def.key);
			return raw;
		case "number": {
			const range = `${def.min} to ${def.max}${def.zero ? ` (or 0 = ${def.zero})` : ""}`;
			if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new SettingsError(`${def.key} must be a whole number from ${range}`, 400, def.key);
			if (def.zero && raw === 0) return 0;
			if (raw < def.min || raw > def.max) throw new SettingsError(`${def.key} must be from ${range}`, 400, def.key);
			return raw;
		}
	}
}

/** The environment's values (or the built-in defaults) for every editable setting. */
export function envValues(config: ServerConfig): RuntimeValues {
	return {
		alertWebhookUrl: config.alertWebhookUrl ?? "",
		alertWebhookFormat: config.alertWebhookFormat ?? "auto",
		alertWebhookLevels: ALERT_LEVELS.filter((l) => config.alertWebhookLevels.has(l)),
		adminAllowIps: config.adminAllowIps?.map((r) => r.text) ?? [],
		tokenLogin: config.tokenLogin,
		webViewers: [...config.webViewers],
		ipPerMinute: config.ipPerMinute,
		jobPerMinute: config.jobPerMinute,
		errorsIpPerMinute: config.errorsIpPerMinute,
		fleetNewJobsPerMinute: config.fleetNewJobsPerMinute,
		keepDays: config.keepDays,
		rawKeepDays: config.rawKeepDays,
		errorKeepDays: config.errorKeepDays,
		errorMaxKinds: config.errorMaxKinds,
		errorRowsPerDay: config.errorRowsPerDay,
		deployKeepDays: config.deployKeepDays,
	};
}

export interface RuntimeSettingsOptions {
	file: string;
	/** False (TYPETORCH_RUNTIME_SETTINGS=off): the file is neither read nor written; changes are refused. */
	enabled: boolean;
	fallback: RuntimeValues;
	/** Names of the environment variables that were set (undefined = treat every fallback as "env"). */
	envSet?: ReadonlySet<string>;
	clock?: () => number;
	log?: (line: string) => void;
}

export class RuntimeSettings {
	readonly enabled: boolean;
	private stored: Partial<RuntimeValues> = {};
	private auditList: AuditEntry[] = [];
	private allowRules: IpRule[] | undefined;
	private readonly file: string;
	private readonly fallback: RuntimeValues;
	private readonly fallbackSource: Record<RuntimeKey, "env" | "default">;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;

	constructor(options: RuntimeSettingsOptions) {
		this.file = options.file;
		this.enabled = options.enabled;
		this.fallback = options.fallback;
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
		this.fallbackSource = Object.fromEntries(SETTINGS.map((d) => [d.key, !options.envSet || options.envSet.has(d.env) ? "env" : "default"])) as Record<RuntimeKey, "env" | "default">;
		this.load();
		this.refresh();
	}

	static fromConfig(config: ServerConfig, o: { clock?: () => number; log?: (line: string) => void } = {}): RuntimeSettings {
		return new RuntimeSettings({
			file: join(config.dataDir, RUNTIME_SETTINGS_FILE),
			enabled: config.runtimeSettings,
			fallback: envValues(config),
			envSet: config.envSet,
			...(o.clock ? { clock: o.clock } : {}),
			...(o.log ? { log: o.log } : {}),
		});
	}

	/**
	 * Reads the file again (a deploy's previous server may have saved values while both ran) and applies it at once.
	 * Returns the keys whose value changed (names only).
	 */
	reload(): RuntimeKey[] {
		const before = SETTINGS.map((d) => JSON.stringify(this.get(d.key)));
		this.stored = {};
		this.auditList = [];
		this.load();
		this.refresh();
		return SETTINGS.filter((d, i) => JSON.stringify(this.get(d.key)) !== before[i]).map((d) => d.key);
	}

	/** The current value: the dashboard's when one is saved, else the environment's (or the default). */
	get<K extends RuntimeKey>(key: K): RuntimeValues[K] {
		return Object.hasOwn(this.stored, key) ? (this.stored[key] as RuntimeValues[K]) : this.fallback[key];
	}

	source(key: RuntimeKey): SettingSource {
		return Object.hasOwn(this.stored, key) ? "dashboard" : this.fallbackSource[key];
	}

	/** The admin allow list as rules; undefined = any address. */
	adminAllowRules(): IpRule[] | undefined {
		return this.allowRules;
	}

	/** Whether this Roblox user is on the viewer list (the read-only web role). */
	isViewer(userId: number): boolean {
		return this.get("webViewers").includes(userId);
	}

	/** Keys saved from the dashboard (names only: for the startup line). */
	overridden(): RuntimeKey[] {
		return SETTINGS.map((d) => d.key).filter((k) => Object.hasOwn(this.stored, k));
	}

	audit(): AuditEntry[] {
		return this.auditList.map((e) => ({ ...e, ...(e.set ? { set: [...e.set] } : {}), ...(e.reset ? { reset: [...e.reset] } : {}) }));
	}

	/** Every setting for the Settings page. Secrets: whether one is set and where it comes from, never the value. */
	view(): SettingView[] {
		return SETTINGS.map((def): SettingView => {
			const meta = {
				key: def.key,
				env: def.env,
				group: def.group,
				label: def.label,
				help: def.help,
				kind: def.kind,
				source: this.source(def.key),
				...(def.kind === "choice" || def.kind === "levels" ? { options: [...def.options] } : {}),
				...(def.kind === "number" ? { min: def.min, max: def.max, unit: def.unit, ...(def.zero ? { zero: def.zero } : {}) } : {}),
				...(def.kind === "ips" || def.kind === "users" ? { maxEntries: def.maxEntries } : {}),
			};
			if (def.kind === "secret") return { ...meta, set: this.get(def.key) !== "", fallbackSet: this.fallback[def.key] !== "" };
			const copy = (v: unknown) => (Array.isArray(v) ? [...v] : v);
			return { ...meta, value: copy(this.get(def.key)), fallback: copy(this.fallback[def.key]), fallbackSource: this.fallbackSource[def.key] };
		});
	}

	/**
	 * Applies a partial change: `{ key: value }` sets, `{ key: null }` resets to the environment. All or nothing: every
	 * value is checked, then the lockout guards run on the result, then the file is written, then the new values apply.
	 */
	patch(body: unknown, ctx: PatchContext): PatchResult {
		if (!this.enabled) throw new SettingsError("runtime settings are off on this server (TYPETORCH_RUNTIME_SETTINGS=off): change the environment on Coolify and redeploy", 409);
		if (!isRecord(body)) throw new SettingsError('send a JSON object of settings, e.g. { "ipPerMinute": 8000 } (null resets one to the environment)', 400);
		const entries = Object.entries(body);
		if (!entries.length) throw new SettingsError("nothing to change", 400);
		const next: Partial<RuntimeValues> = { ...this.stored };
		const touched = new Map<RuntimeKey, "set" | "reset">();
		for (const [name, raw] of entries) {
			const def = BY_KEY.get(name);
			if (!def || !Object.hasOwn(body, name)) throw new SettingsError(`unknown setting ${safeName(name)}; the editable ones are ${SETTINGS.map((s) => s.key).join(", ")}`, 400);
			if (raw === null) {
				delete next[def.key];
				touched.set(def.key, "reset");
			} else {
				(next as Record<string, unknown>)[def.key] = checkSetting(def, raw);
				touched.set(def.key, "set");
			}
		}
		const after = <K extends RuntimeKey>(key: K): RuntimeValues[K] => (Object.hasOwn(next, key) ? (next[key] as RuntimeValues[K]) : this.fallback[key]);

		// Guard: the admin allow list must keep letting the caller in (a reset to the environment's list counts too).
		if (touched.has("adminAllowIps")) {
			const list = after("adminAllowIps");
			if (list.length && !ipAllowed(parseIpRules(list.join(",")), ctx.ip)) {
				throw new SettingsError(
					`refused: that admin allow list does not include your address (${ctx.ip || "unknown"}), so it would lock you out; add it, or leave the list empty for any address`,
					409,
					"adminAllowIps",
					"allow-list",
				);
			}
		}
		// Guard: the token login goes off only when Roblox sign-in works and the caller is using it right now.
		const wasOn = this.get("tokenLogin");
		if (wasOn && !after("tokenLogin")) {
			if (!ctx.robloxSignIn) {
				throw new SettingsError(
					"refused: turning the token login off needs Sign in with Roblox (ROBLOX_OAUTH_CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET and TYPETORCH_PUBLIC_URL on Coolify), or nobody could sign in to the explorer",
					409,
					"tokenLogin",
					"token-login",
				);
			}
			if (!ctx.robloxSession) throw new SettingsError("refused: sign in with Roblox first, then turn the token login off from that session", 409, "tokenLogin", "token-login");
		}

		const changed = SETTINGS.map((d) => d.key).filter((k) => Object.hasOwn(this.stored, k) !== Object.hasOwn(next, k) || JSON.stringify(this.stored[k]) !== JSON.stringify(next[k]));
		if (changed.length) {
			const set = changed.filter((k) => touched.get(k) === "set");
			const reset = changed.filter((k) => touched.get(k) === "reset");
			const entry: AuditEntry = { at: new Date(this.clock()).toISOString(), who: ctx.who, via: ctx.via, action: "change", ...(set.length ? { set } : {}), ...(reset.length ? { reset } : {}) };
			const audit = [entry, ...this.auditList].slice(0, AUDIT_MAX);
			this.write(next, audit);
			this.stored = next;
			this.auditList = audit;
			this.refresh();
			this.log(`runtime settings changed by ${ctx.who} (${ctx.via}): ${[set.length ? `set ${set.join(", ")}` : "", reset.length ? `reset ${reset.join(", ")}` : ""].filter(Boolean).join("; ")}`);
		}
		return { changed, tokenLoginTurnedOff: wasOn && !this.get("tokenLogin") };
	}

	/** Adds a test alert to the audit list (and the log). `result` never holds the URL. */
	recordTest(actor: SettingsActor, result: string): void {
		const entry: AuditEntry = { at: new Date(this.clock()).toISOString(), who: actor.who, via: actor.via, action: "test-alert", result };
		const audit = [entry, ...this.auditList].slice(0, AUDIT_MAX);
		try {
			if (this.enabled) this.write(this.stored, audit);
		} catch (error) {
			this.log(`runtime settings: could not save the audit list (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
		}
		this.auditList = audit;
		this.log(`test alert from the Settings page by ${actor.who} (${actor.via}): ${result}`);
	}

	private refresh(): void {
		const list = this.get("adminAllowIps");
		this.allowRules = list.length ? parseIpRules(list.join(",")) : undefined;
	}

	private load(): void {
		if (!this.enabled) {
			if (existsSync(this.file)) this.log(`runtime settings are off (TYPETORCH_RUNTIME_SETTINGS=off): ${RUNTIME_SETTINGS_FILE} is kept but ignored; the environment applies`);
			return;
		}
		if (!existsSync(this.file)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			this.log(`runtime settings: ${RUNTIME_SETTINGS_FILE} could not be read; the environment applies until the next save`);
			return;
		}
		if (!isRecord(parsed)) return;
		const values = isRecord(parsed.values) ? parsed.values : {};
		for (const [name, raw] of Object.entries(values)) {
			const def = BY_KEY.get(name);
			if (!def) {
				this.log(`runtime settings: ignored the stored ${safeName(name)} (not a setting)`);
				continue;
			}
			try {
				(this.stored as Record<string, unknown>)[def.key] = checkSetting(def, raw);
			} catch (error) {
				this.log(`runtime settings: ignored the stored ${def.key} (${(error as Error).message})`);
			}
		}
		if (Array.isArray(parsed.audit)) {
			const keys = (v: unknown) => (Array.isArray(v) ? (v.filter((k) => typeof k === "string" && BY_KEY.has(k)) as RuntimeKey[]) : undefined);
			for (const raw of parsed.audit.slice(0, AUDIT_MAX)) {
				if (!isRecord(raw) || typeof raw.at !== "string" || typeof raw.who !== "string" || (raw.action !== "change" && raw.action !== "test-alert")) continue;
				const set = keys(raw.set);
				const reset = keys(raw.reset);
				this.auditList.push({
					at: raw.at.slice(0, 40),
					who: raw.who.slice(0, 80),
					via: raw.via === "bearer" ? "bearer" : "session",
					action: raw.action,
					...(set?.length ? { set } : {}),
					...(reset?.length ? { reset } : {}),
					...(typeof raw.result === "string" ? { result: raw.result.slice(0, 200) } : {}),
				});
			}
		}
	}

	/** Writes the file atomically (a fresh 0600 temp file, fsync, rename). Throws on failure; nothing in memory changes then. */
	private write(values: Partial<RuntimeValues>, audit: AuditEntry[]): void {
		const text = `${JSON.stringify({ version: 1, values, audit }, null, "\t")}\n`;
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		rmSync(tmp, { force: true });
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.file);
		try {
			chmodSync(this.file, 0o600);
		} catch {
			// Not every file system has modes (Windows).
		}
	}
}
