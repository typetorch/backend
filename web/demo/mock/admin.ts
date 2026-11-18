/**
 * The admin side, as the backend answers an owner (src/server/app.ts, runtime-settings.ts, audit.ts, backup.ts,
 * metrics.ts, storage.ts, disk.ts, devices.ts):
 *
 *   GET   /v1/admin/settings               every runtime setting with its value, source and bounds, the env-only names
 *   PATCH /v1/admin/settings               { key: value | null }: checked like the backend (same messages), guarded, saved
 *   POST  /v1/admin/settings/test-alert    "sent (HTTP 204)" (nothing leaves the browser; 3 a minute like the backend)
 *   GET   /v1/admin/alert-rules            the backend alert rules' last run, from the saved backendAlerts setting
 *   GET   /v1/admin/stats?window           the server's own metrics: a quiet Bun process with The Prison's traffic
 *   GET   /v1/admin/audit                  who did what: sign-ins, releases (the pack's deploy seqs), backups, settings...
 *   GET   /v1/admin/backups, POST          the nightly backups and "Back up now"
 *   POST  /v1/admin/backups/download       a small tar (a manifest and a note: the demo has no data folder to send)
 *   GET   /v1/admin/devices, DELETE <id>   the browsers trusted through typetorch.dev
 *   GET   /v1/storage                      the data folder, sized from the pack's rows and days
 *
 * Settings shared with other domains stay where those domains read them: `errorDropRules` is the error domain's list
 * (./errors), `notify.*` the notification switches (./notify). Every write lands in the audit log (recordAudit, also
 * used by ./maps).
 */
import type {
	AlertRulesMeta,
	AlertRulesStatus,
	AuditEntry,
	AuditPage,
	BackendStats,
	BackupInfo,
	BackupsStatus,
	BlessedDevice,
	DiskStatus,
	LatencySummary,
	RouteGroup,
	RouteStats,
	RuntimeSetting,
	SettingsAuditEntry,
	SettingsView,
	StatsBucket,
	StatsWindow,
	StoragePart,
	StorageReport,
	TestAlertResult,
} from "@/lib/types";
import { checkAlertSettings, defaultAlertSettings, RULES, rulesMeta, type BackendAlertSettings } from "../../../src/alerts/rules.ts";
import { checkDropRules } from "../../../src/errors/drop-rules.ts";
import { ipAllowed, parseIpRules } from "../../../src/server/ipfilter.ts";
import { DEMO_VERSION } from "./auth";
import { DAY_MS, now } from "./data";
import { getErrorDropRules, errorDropRulesSource, resetErrorDropRules, serverStartedAt, setErrorDropRules } from "./errors";
import { playersAt } from "./fleet-model";
import { getNotifySwitches, setNotifySwitches, type NotifySwitches } from "./notify";
import { pack, type Pack } from "./pack";
import { DEMO_OWNER, hashString, rng } from "./rng";
import { fail, HttpError, json, route, type MockRequest } from "./router";
import { slice } from "./state";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The visitor's address as the demo's backend "sees" it (a documentation address). */
export const DEMO_IP = "203.0.113.42";
/** The owner as the backend names it in settings and audit entries (a Roblox session). */
export const OWNER_WHO = `roblox user ${DEMO_OWNER.userId} (${DEMO_OWNER.name})`;

// Rate limits (per minute, in memory) ------------------------------------------------------------------------------------

const takes = new Map<string, number[]>();

/** Like the backend's RateLimiter: false once `perMinute` were taken in the last minute. */
function take(key: string, perMinute: number): { ok: true } | { ok: false; retryAfter: number } {
	const at = now();
	const recent = (takes.get(key) ?? []).filter((t) => t > at - MINUTE_MS);
	if (recent.length >= perMinute) {
		takes.set(key, recent);
		return { ok: false, retryAfter: Math.max(1, Math.ceil(((recent[0] as number) + MINUTE_MS - at) / 1000)) };
	}
	recent.push(at);
	takes.set(key, recent);
	return { ok: true };
}

const tooMany = (seconds: number) => json(429, { error: "rate limited" }, { "retry-after": String(seconds) });

/** Forgets the rate limits (tests). */
export function resetAdminLimits(): void {
	takes.clear();
}

// The audit log ----------------------------------------------------------------------------------------------------------

type AuditInput = Omit<AuditEntry, "id" | "at"> & { at: number };

const OWNER_ACTOR = { actor: OWNER_WHO, actorKind: "roblox", userId: DEMO_OWNER.userId, role: "admin", via: "cookie", ip: DEMO_IP } as const;
const SYSTEM_ACTOR = (label: string) => ({ actor: label, actorKind: "system", userId: null, role: "none", via: "none", ip: "" }) as const;
const API_KEY_ACTOR = { actor: "api key", actorKind: "api-key", userId: null, role: "game", via: "bearer", ip: "198.51.100.23" } as const;

/** What visitors did (newest last), on top of the seeded history. */
const auditWrites = slice<AuditInput[]>("admin.audit", () => []);

/** Adds an entry to the audit log (the owner's own actions by default). `at` may lie ahead (an export that ends later). */
export function recordAudit(entry: { action: string; outcome?: AuditEntry["outcome"]; status?: number | null; details?: Record<string, unknown> | null; at?: number; system?: string }): void {
	const who = entry.system ? SYSTEM_ACTOR(entry.system) : OWNER_ACTOR;
	auditWrites.update((list) => {
		list.push({ ...who, at: entry.at ?? now(), action: entry.action, outcome: entry.outcome ?? "ok", status: entry.status === undefined ? (entry.system ? null : 200) : entry.status, details: entry.details ?? null });
		// Bounded like everything in the demo's storage.
		if (list.length > 2000) list.splice(0, list.length - 2000);
	});
}

/** The seeded settings history: the same changes show in the Settings page's list and the audit log. */
interface SettingsHistory {
	at: number;
	action: "change" | "test-alert";
	set?: string[];
	result?: string;
	changes?: Record<string, unknown>[];
}

function settingsHistory(at: number): SettingsHistory[] {
	const today = Math.floor(at / DAY_MS) * DAY_MS;
	const out: SettingsHistory[] = [
		{
			at: today - 12 * DAY_MS + 10 * HOUR_MS + 14 * MINUTE_MS,
			action: "change",
			set: ["errorDropRules"],
			changes: [{ key: "errorDropRules", added: ["locale-noise", "coregui", "sound-timeouts"], removed: [], source: "dashboard" }],
		},
		{ at: today - 9 * DAY_MS + 18 * HOUR_MS + 40 * MINUTE_MS, action: "change", set: ["alertWebhookUrl"], changes: [{ key: "alertWebhookUrl", from: "not set", to: "set", source: "dashboard" }] },
		{ at: today - 9 * DAY_MS + 18 * HOUR_MS + 41 * MINUTE_MS, action: "test-alert", result: "sent (HTTP 204)" },
		{ at: today - 6 * DAY_MS + 11 * HOUR_MS + 2 * MINUTE_MS, action: "change", set: ["notify.dryRun"], changes: [{ key: "notify.dryRun", from: true, to: false, source: "dashboard" }] },
		{ at: today - 2 * DAY_MS + 16 * HOUR_MS + 25 * MINUTE_MS, action: "test-alert", result: "sent (HTTP 204)" },
	];
	return out.filter((h) => h.at <= at);
}

/** The scheduled backups' times (03:00 UTC + a few seconds) from the pack's first day up to `at`. */
function scheduledBackupTimes(p: Pack, at: number): number[] {
	const out: number[] = [];
	for (let day = Math.floor(p.from / DAY_MS) * DAY_MS + DAY_MS; day <= at; day += DAY_MS) {
		const t = day + 3 * HOUR_MS + 4_000 + (hashString(`backup:${day}`) % 9_000);
		if (t <= at) out.push(t);
	}
	return out;
}

function backupName(at: number): string {
	return `typetorch-backup-${new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/** The seeded audit history for the pack's span: sign-ins, releases, backups, settings, a few refused sign-ins. */
function seededAudit(p: Pack, at: number): AuditInput[] {
	const out: AuditInput[] = [];
	const firstDay = Math.floor(p.from / DAY_MS) * DAY_MS;
	for (let day = firstDay; day <= at; day += DAY_MS) {
		const r = rng(`audit:day:${day}`);
		// The owner signs in once or twice a day.
		const signIns = r.int(1, 2);
		for (let i = 0; i < signIns; i++) {
			const t = day + r.int(8, 22) * HOUR_MS + r.int(0, 59) * MINUTE_MS + r.int(0, 59_000);
			out.push({ ...OWNER_ACTOR, at: t, action: "sign-in", outcome: "ok", status: 302, details: { method: "roblox", role: "admin" } });
		}
		// Someone guessing the admin token now and then.
		if (r.chance(0.3)) {
			const ip = `192.0.2.${r.int(10, 250)}`;
			const t = day + r.int(0, 23) * HOUR_MS + r.int(0, 59) * MINUTE_MS;
			for (let i = 0; i < r.int(1, 3); i++) {
				out.push({ actor: "anonymous", actorKind: "anonymous", userId: null, role: "none", via: "none", ip, at: t + i * 4_000, action: "sign-in", outcome: "failed", status: 401, details: { method: "token" } });
			}
		}
		// The owner watching a live server's remote debug once in a while.
		if (r.chance(0.35)) {
			const jobs = p.jobs.filter((j) => j.branch === "prod" && j.firstAt < day + DAY_MS && j.lastAt > day && (j.maxPlayers ?? 0) > 3);
			if (jobs.length) {
				const j = r.pick(jobs);
				const t = Math.max(j.firstAt, Math.min(j.lastAt, day + r.int(12, 22) * HOUR_MS));
				out.push({ ...OWNER_ACTOR, at: t, action: "debug.watch", outcome: "ok", status: 200, details: { job: j.job } });
			}
		}
	}
	for (const t of scheduledBackupTimes(p, at)) {
		const r = rng(`audit:backup:${t}`);
		out.push({ ...SYSTEM_ACTOR("server (scheduled)"), at: t, action: "backup.create", outcome: "ok", status: null, details: { name: backupName(t), bytes: backupBytes(p, t), files: r.int(40, 70), duckdb: true, seconds: Math.round(r.float(4, 11) * 10) / 10 } });
	}
	// Releases: the CLI starts each deploy with the game key (the pack's real seqs and artifacts).
	const seen = new Set<number>();
	for (const a of [...p.artifacts].sort((x, y) => x.firstAt - y.firstAt)) {
		if (!a.seq || seen.has(a.seq)) continue;
		seen.add(a.seq);
		const t = a.firstAt - 60_000 - (hashString(`audit:deploy:${a.art}`) % 60_000);
		if (t > at) continue;
		out.push({ ...API_KEY_ACTOR, at: t, action: "deploy.start", outcome: "ok", status: 200, details: { seq: a.seq, artifact: a.art, branch: a.branch } });
	}
	for (const h of settingsHistory(at)) {
		if (h.action === "change") out.push({ ...OWNER_ACTOR, at: h.at, action: "settings.change", outcome: "ok", status: 200, details: { changes: h.changes ?? [] } });
		else out.push({ ...OWNER_ACTOR, at: h.at, action: "settings.test-alert", outcome: "ok", status: 200, details: { result: h.result ?? "" } });
	}
	return out.filter((e) => e.at >= p.from && e.at <= at);
}

/** Every audit entry up to now, oldest first, numbered by time. */
async function auditEntries(): Promise<AuditEntry[]> {
	const p = await pack();
	const at = now();
	const all = [...seededAudit(p, at), ...auditWrites.get().filter((e) => e.at <= at)].sort((a, b) => a.at - b.at);
	return all.map((e, i) => ({ ...e, id: i + 1, at: new Date(e.at).toISOString() }));
}

const AUDIT_PAGE_MAX = 500;
const AUDIT_KEEP_DAYS = 365;

route<AuditPage>("GET", "/v1/admin/audit", async (req) => {
	const q = req.query;
	const allowed = new Set(["actor", "action", "outcome", "since", "until", "before", "limit", "facets"]);
	for (const key of q.keys()) {
		if (!allowed.has(key)) return fail(400, `unknown parameter ${JSON.stringify(key.slice(0, 40))}`);
		if (q.getAll(key).length > 1) return fail(400, `one ${key}`);
	}
	const actor = q.get("actor") ?? undefined;
	if (actor !== undefined && (actor.length === 0 || actor.length > 120)) return fail(400, "actor: 1 to 120 characters");
	const action = q.get("action") ?? undefined;
	if (action !== undefined && !/^[\w .:/*-]{1,80}$/.test(action)) return fail(400, "action: up to 80 letters, digits and . : / - * (a trailing * matches a prefix)");
	const outcome = q.get("outcome") ?? undefined;
	if (outcome !== undefined && outcome !== "ok" && outcome !== "failed" && outcome !== "refused") return fail(400, "outcome: ok, failed or refused");
	const time = (name: string): number | undefined | null => {
		const raw = q.get(name);
		if (raw === null) return undefined;
		const n = /^\d{1,16}$/.test(raw) ? Number(raw) : raw.length <= 40 ? Date.parse(raw) : Number.NaN;
		return Number.isFinite(n) ? n : null;
	};
	const since = time("since");
	const until = time("until");
	if (since === null || until === null) return fail(400, "since and until: unix ms or an ISO time");
	const int = (name: string, max: number): number | undefined | null => {
		const raw = q.get(name);
		if (raw === null) return undefined;
		return /^\d{1,16}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= max ? Number(raw) : null;
	};
	const before = int("before", Number.MAX_SAFE_INTEGER);
	const limit = int("limit", AUDIT_PAGE_MAX);
	if (before === null) return fail(400, "before: an entry id");
	if (limit === null) return fail(400, `limit: 1 to ${AUDIT_PAGE_MAX}`);
	const all = await auditEntries();
	const matches = all
		.filter((e) => {
			if (actor !== undefined && e.actor !== actor) return false;
			if (action !== undefined && (action.endsWith("*") ? !e.action.startsWith(action.slice(0, -1)) : e.action !== action)) return false;
			if (outcome !== undefined && e.outcome !== outcome) return false;
			const t = Date.parse(e.at);
			if (since !== undefined && t < since) return false;
			if (until !== undefined && t >= until) return false;
			if (before !== undefined && e.id >= before) return false;
			return true;
		})
		.reverse();
	const n = limit ?? 100;
	const page = matches.slice(0, n);
	const out: AuditPage = { entries: page, next: matches.length > n ? (page[page.length - 1]?.id ?? null) : null, keepDays: AUDIT_KEEP_DAYS };
	if (q.get("facets") === "1") {
		const actors = new Map<string, { actor: string; kind: string; entries: number }>();
		const actions = new Map<string, number>();
		for (const e of all) {
			const a = actors.get(e.actor) ?? { actor: e.actor, kind: e.actorKind, entries: 0 };
			a.entries++;
			actors.set(e.actor, a);
			actions.set(e.action, (actions.get(e.action) ?? 0) + 1);
		}
		out.facets = {
			actors: [...actors.values()].sort((a, b) => b.entries - a.entries).slice(0, 100),
			actions: [...actions.entries()]
				.map(([a, entries]) => ({ action: a, entries }))
				.sort((a, b) => b.entries - a.entries)
				.slice(0, 100),
		};
	}
	return out;
});

// Runtime settings -------------------------------------------------------------------------------------------------------

/**
 * The editable settings as src/server/runtime-settings.ts defines them (SETTINGS), in its order. A copy, because that
 * module pulls the server's whole config; demo/test/admin.test.ts checks it against the backend's on Node.
 */
type Kind = RuntimeSetting["kind"];
export interface DemoSettingDef {
	key: string;
	env: string;
	group: RuntimeSetting["group"];
	kind: Kind;
	label: string;
	help: string;
	options?: readonly string[];
	min?: number;
	max?: number;
	unit?: string;
	zero?: string;
	maxEntries?: number;
}

const WEBHOOK_FORMATS = ["auto", "discord", "slack", "json"] as const;
const ALERT_LEVELS = ["critical", "warning", "info"] as const;
const NOTIFY_CLOCKS = ["rolling24", "utc_day"] as const;

export const SETTING_DEFS: readonly DemoSettingDef[] = [
	{ key: "alertWebhookUrl", env: "TYPETORCH_ALERT_WEBHOOK_URL", group: "alerts", kind: "secret", label: "Alert webhook", help: "A Discord, Slack or JSON webhook (https). Never shown again once saved." },
	{ key: "alertWebhookFormat", env: "TYPETORCH_ALERT_WEBHOOK_FORMAT", group: "alerts", kind: "choice", options: WEBHOOK_FORMATS, label: "Webhook format", help: "auto picks Discord or Slack from the URL, else JSON." },
	{ key: "alertWebhookLevels", env: "TYPETORCH_ALERT_WEBHOOK_LEVELS", group: "alerts", kind: "levels", options: ALERT_LEVELS, label: "Alert levels sent", help: "Which alert levels go to the webhook." },
	{ key: "backendAlerts", env: "TYPETORCH_BACKEND_ALERTS", group: "backendAlerts", kind: "alertRules", label: "Backend alert rules", help: "Alerts the backend raises from its own data (errors, players online, ingest, its own health, disk)." },
	{ key: "adminAllowIps", env: "TYPETORCH_ADMIN_ALLOW_IPS", group: "access", kind: "ips", maxEntries: 64, label: "Admin allow list", help: "Addresses and CIDR ranges that may reach the explorer and admin routes; empty = any address. Game routes stay open." },
	{ key: "tokenLogin", env: "TYPETORCH_TOKEN_LOGIN", group: "access", kind: "switch", label: "Admin token login", help: "The explorer's paste-the-token login. The CLI's Bearer token works either way." },
	{ key: "webViewers", env: "TYPETORCH_WEB_VIEWERS", group: "access", kind: "users", maxEntries: 200, label: "Viewers (read-only)", help: "Roblox UserIds who may sign in with Roblox and see everything but change nothing (the web role). Owners from the access list are admins either way." },
	{ key: "ipPerMinute", env: "TYPETORCH_IP_PER_MINUTE", group: "limits", kind: "number", min: 100, max: 1_000_000, unit: "requests / min", label: "Ingest per address", help: "Game requests per address per minute (servers share egress addresses)." },
	{ key: "jobPerMinute", env: "TYPETORCH_JOB_PER_MINUTE", group: "limits", kind: "number", min: 10, max: 100_000, unit: "requests / min", label: "Ingest per server", help: "Ingest batches per game server (JobId) per minute." },
	{ key: "errorsIpPerMinute", env: "TYPETORCH_ERRORS_IP_PER_MINUTE", group: "limits", kind: "number", min: 60, max: 1_000_000, unit: "requests / min", label: "Error logs per address", help: "POST /v1/errors per address per minute." },
	{ key: "fleetNewJobsPerMinute", env: "TYPETORCH_NEW_JOBS_PER_MINUTE", group: "limits", kind: "number", min: 100, max: 1_000_000, unit: "servers / min", label: "New servers per minute", help: "Never-seen JobIds let in per minute (fleet and error logs, counted apart)." },
	{ key: "keepDays", env: "TYPETORCH_KEEP_DAYS", group: "retention", kind: "number", min: 7, max: 36_500, zero: "forever", unit: "days", label: "Analytics history", help: "Days of Parquet day files kept; 0 keeps them forever. Applied at the nightly export." },
	{ key: "rawKeepDays", env: "TYPETORCH_RAW_KEEP_DAYS", group: "retention", kind: "number", min: 1, max: 3650, zero: "forever", unit: "days", label: "Raw archives", help: "Days of raw batch archives kept; 0 keeps them forever. Applied at the nightly export." },
	{ key: "errorKeepDays", env: "TYPETORCH_ERROR_KEEP_DAYS", group: "retention", kind: "number", min: 1, max: 3650, unit: "days", label: "Error log history", help: "Days of error counts kept (pruned hourly)." },
	{ key: "errorMaxKinds", env: "TYPETORCH_ERROR_MAX_KINDS", group: "retention", kind: "number", min: 100, max: 1_000_000, unit: "kinds", label: "Error kinds stored", help: "Past it, new kinds are dropped and counted." },
	{ key: "errorRowsPerDay", env: "TYPETORCH_ERROR_ROWS_PER_DAY", group: "retention", kind: "number", min: 10_000, max: 1_000_000_000, unit: "rows / day", label: "Error rows per day", help: "New error count and player rows per UTC day; past it they are dropped and counted." },
	{
		key: "errorDropRules",
		env: "TYPETORCH_ERROR_DROP_RULES",
		group: "retention",
		kind: "dropRules",
		maxEntries: 50,
		label: "Error drop rules",
		help: "Filter expressions: error logs a rule matches are dropped when they arrive and never stored (asset / mesh load failures and other noise). Edit them on the Errors page, with a preview of what each would drop.",
	},
	{ key: "auditKeepDays", env: "TYPETORCH_AUDIT_KEEP_DAYS", group: "retention", kind: "number", min: 7, max: 3650, unit: "days", label: "Audit log history", help: "Days of audit log entries kept (who did what on the admin side; pruned hourly)." },
	{ key: "deployKeepDays", env: "TYPETORCH_DEPLOY_KEEP_DAYS", group: "retention", kind: "number", min: 7, max: 3650, unit: "days", label: "Deploy history", help: "Days of releases kept in the deploy history (at most 10,000 rows; pruned hourly)." },
	{ key: "notify.enabled", env: "TYPETORCH_NOTIFY_ENABLED", group: "notify", kind: "switch", label: "Notifications", help: "Experience notifications: plan and send (off = paused; intents still queue)." },
	{ key: "notify.dryRun", env: "TYPETORCH_NOTIFY_DRY_RUN", group: "notify", kind: "switch", label: "Dry run", help: "Plan and write the rows, never send to Roblox. On by default: turn it off once the Notifications page looks right." },
	{
		key: "notify.rate",
		env: "TYPETORCH_NOTIFY_RATE",
		group: "notify",
		kind: "number",
		min: 1,
		max: 4000,
		unit: "sends / s",
		label: "Send rate ceiling",
		help: "Our own ceiling on sends per second (Roblox allows 4000 a second per key and says so on every answer; the sender follows that too). A 429 halves the rate for a while.",
	},
	{ key: "notify.clock", env: "TYPETORCH_NOTIFY_CLOCK", group: "notify", kind: "choice", options: NOTIFY_CLOCKS, label: "Daily cap clock", help: "rolling24: the next send at least 24 h after the last; utc_day: one per UTC date." },
	{
		key: "notify.presenceStaleHours",
		env: "TYPETORCH_NOTIFY_PRESENCE_STALE_HOURS",
		group: "notify",
		kind: "number",
		min: 1,
		max: 168,
		unit: "hours",
		label: "Presence goes stale",
		help: "A player counts as in game this long after the last online ping (game servers refresh it every 3 h), so a crashed server never keeps them 'online' for good.",
	},
	{ key: "keys.ratePerMinute", env: "TYPETORCH_KEYS_RATE_PER_MINUTE", group: "keys", kind: "number", min: 1, max: 100_000, unit: "requests / min", label: "Requests per key", help: "Requests a minute per named API key (ttk_ keys); over it they get 429. The game key keeps the ingest limits." },
	{
		key: "players.supportEvents",
		env: "TYPETORCH_PLAYERS_SUPPORT_EVENTS",
		group: "keys",
		kind: "names",
		maxEntries: 64,
		label: "Support events",
		help: "Event names a support key may read per player (GET /v1/players/by-uid/<uid>/events and /summary); join, leave and device are the session rows; feedback is the player feedback (plans/32). Admin keys read any.",
	},
	{ key: "notify.kinds", env: "TYPETORCH_NOTIFY_KINDS_OFF", group: "notify", kind: "kindSwitches", maxEntries: 64, label: "Kinds", help: "Per kind on / off (the Notifications page has the switches). A kind not listed is on." },
];

/** src/server/runtime-settings.ts ENV_ONLY. */
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
	"OPENCLOUD_NOTIFY_KEY",
	"TYPETORCH_NOTIFY_KEY",
] as const;

const BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));
const NOTIFY_KIND_KEY = /^notify\.kinds\.([a-z0-9_]{1,24})\.enabled$/;
const SETTINGS_AUDIT_MAX = 50;
const NOTIFY_KEYS = new Set(["notify.enabled", "notify.dryRun", "notify.rate", "notify.clock", "notify.presenceStaleHours", "notify.kinds"]);

/**
 * The environment's values (the backend's defaults; a few set on "Coolify"). The notify ones match the notification
 * switches' seed except dryRun, which the owner turned off on the Settings page (see the seeded history).
 */
const FALLBACK: Record<string, unknown> = {
	alertWebhookUrl: "",
	alertWebhookFormat: "auto",
	alertWebhookLevels: ["critical", "warning", "info"],
	backendAlerts: defaultAlertSettings(),
	adminAllowIps: [],
	tokenLogin: true,
	webViewers: [],
	ipPerMinute: 6000,
	jobPerMinute: 60,
	errorsIpPerMinute: 1200,
	fleetNewJobsPerMinute: 2000,
	keepDays: 400,
	rawKeepDays: 14,
	errorKeepDays: 30,
	errorMaxKinds: 5000,
	errorRowsPerDay: 2_000_000,
	errorDropRules: [],
	auditKeepDays: 365,
	deployKeepDays: 365,
	"notify.enabled": true,
	"notify.dryRun": true,
	"notify.rate": 50,
	"notify.clock": "rolling24",
	"notify.presenceStaleHours": 6,
	"keys.ratePerMinute": 120,
	"players.supportEvents": ["ac_flag", "ac_action", "ac_honeypot", "join", "leave"],
	"notify.kinds": {},
};
/** Variables set in the demo's "environment" (the rest are the built-in defaults). */
const ENV_SET = new Set(["TYPETORCH_KEEP_DAYS", "TYPETORCH_RAW_KEEP_DAYS", "TYPETORCH_NOTIFY_ENABLED", "TYPETORCH_ALERT_WEBHOOK_LEVELS"]);
const fallbackSource = (d: DemoSettingDef): "env" | "default" => (ENV_SET.has(d.env) ? "env" : "default");

interface SettingsState {
	/** Values saved from the dashboard (not errorDropRules / notify.*: those live with their domains). */
	stored: Record<string, unknown>;
	/** notify.* keys saved from the dashboard (their values are the notification switches). */
	notifyDashboard: string[];
	/** Settings changes and test alerts made in this browser, newest first (the seeded history is added on read). */
	audit: SettingsAuditEntry[];
}

const settingsState = slice<SettingsState>("admin.settings", () => ({
	// A webhook saved on the Settings page (only "set" is ever shown); the value is a placeholder that is never sent.
	stored: { alertWebhookUrl: "https://discord.com/api/webhooks/0/demo-placeholder", alertWebhookLevels: ["critical", "warning"] },
	notifyDashboard: ["notify.dryRun"],
	audit: [],
}));

function notifyValue(key: string, s: NotifySwitches): unknown {
	switch (key) {
		case "notify.enabled":
			return s.enabled;
		case "notify.dryRun":
			return s.dryRun;
		case "notify.rate":
			return s.rate;
		case "notify.clock":
			return s.clock;
		case "notify.presenceStaleHours":
			return s.presenceStaleHours;
		default:
			return Object.fromEntries(s.kindsOff.map((k) => [k, false]));
	}
}

function notifyChange(key: string, value: unknown): Partial<NotifySwitches> {
	switch (key) {
		case "notify.enabled":
			return { enabled: value as boolean };
		case "notify.dryRun":
			return { dryRun: value as boolean };
		case "notify.rate":
			return { rate: value as number };
		case "notify.clock":
			return { clock: value as NotifySwitches["clock"] };
		case "notify.presenceStaleHours":
			return { presenceStaleHours: value as number };
		default:
			return {
				kindsOff: Object.entries(value as Record<string, boolean>)
					.filter(([, on]) => !on)
					.map(([k]) => k),
			};
	}
}

/** The current value of a setting and where it comes from. */
function current(key: string): { value: unknown; source: "env" | "dashboard" | "default" } {
	const def = BY_KEY.get(key) as DemoSettingDef;
	const s = settingsState.get();
	if (key === "errorDropRules") return { value: getErrorDropRules(), source: errorDropRulesSource() };
	if (NOTIFY_KEYS.has(key)) return { value: notifyValue(key, getNotifySwitches()), source: s.notifyDashboard.includes(key) ? "dashboard" : fallbackSource(def) };
	if (Object.hasOwn(s.stored, key)) return { value: s.stored[key], source: "dashboard" };
	return { value: FALLBACK[key], source: fallbackSource(def) };
}

/** The saved backendAlerts value (the alert rules page and the settings page read the same). */
export function backendAlertSettings(): BackendAlertSettings {
	return current("backendAlerts").value as BackendAlertSettings;
}

const copy = <T>(v: T): T => structuredClone(v);

function settingViews(): RuntimeSetting[] {
	return SETTING_DEFS.map((def): RuntimeSetting => {
		const meta = {
			key: def.key,
			env: def.env,
			group: def.group,
			label: def.label,
			help: def.help,
			...(def.options ? { options: [...def.options] } : {}),
			...(def.kind === "number" ? { min: def.min as number, max: def.max as number, unit: def.unit as string, ...(def.zero ? { zero: def.zero } : {}) } : {}),
			...(def.maxEntries !== undefined && def.kind !== "dropRules" ? { maxEntries: def.maxEntries } : {}),
			// The backend's own definitions (readonly arrays there; the explorer's type is the same shape).
			...(def.kind === "alertRules" ? { rules: rulesMeta() as unknown as AlertRulesMeta } : {}),
		};
		const { value, source } = current(def.key);
		if (def.kind === "secret") return { ...meta, kind: "secret", source, set: value !== "", fallbackSet: FALLBACK[def.key] !== "" };
		return { ...meta, kind: def.kind, source, value: copy(value), fallback: copy(FALLBACK[def.key]), fallbackSource: fallbackSource(def) };
	});
}

function centralFingerprint(): string {
	const r = rng("central:fingerprint");
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let out = "tt1-";
	for (let i = 0; i < 32; i++) out += alphabet[r.int(0, 31)];
	return out;
}

function settingsAudit(): SettingsAuditEntry[] {
	const seeded: SettingsAuditEntry[] = settingsHistory(now()).map((h) =>
		h.action === "change" ? { at: new Date(h.at).toISOString(), who: OWNER_WHO, via: "session", action: "change", set: h.set ?? [] } : { at: new Date(h.at).toISOString(), who: OWNER_WHO, via: "session", action: "test-alert", result: h.result ?? "" },
	);
	return [...settingsState.get().audit, ...seeded.reverse()].slice(0, SETTINGS_AUDIT_MAX);
}

function settingsView(): SettingsView {
	return {
		enabled: true,
		settings: settingViews(),
		envOnly: [...ENV_ONLY],
		audit: settingsAudit(),
		you: { ip: DEMO_IP, roblox: true },
		robloxSignIn: true,
		centralLogin: { on: true, issuer: "https://dash.typetorch.dev", fingerprint: centralFingerprint(), unblessed: "admin", blessKeys: 1 },
	};
}

/** A refused change: the backend's SettingsError (400 = the value is wrong, 409 = a guard). */
class SettingsRefused extends HttpError {
	constructor(message: string, status: 400 | 409, key?: string, guard?: "allow-list" | "token-login") {
		super(status, message, { ...(key ? { key } : {}), ...(guard ? { guard } : {}) });
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeName = (name: string): string => (/^[A-Za-z0-9_]{1,48}$/.test(name) ? `"${name}"` : "(a key that is not a setting name)");

function isHttpsUrl(value: string): boolean {
	if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
	try {
		const u = new URL(value);
		return u.protocol === "https:" && u.hostname !== "";
	} catch {
		return false;
	}
}

/** runtime-settings.ts checkSetting, the same rules and messages. */
function checkSetting(def: DemoSettingDef, raw: unknown, base: unknown): unknown {
	const key = def.key;
	switch (def.kind) {
		case "secret": {
			if (typeof raw !== "string") throw new SettingsRefused(`${key} is a string: an https:// URL, or "" for none`, 400, key);
			const value = raw.trim();
			if (value === "") return "";
			if (!isHttpsUrl(value)) throw new SettingsRefused(`${key} must be an https:// URL (or "" for none)`, 400, key);
			return value;
		}
		case "choice": {
			const options = def.options ?? [];
			if (typeof raw !== "string" || !options.includes(raw)) throw new SettingsRefused(`${key} is one of ${options.join(", ")}`, 400, key);
			return raw;
		}
		case "levels": {
			const options = def.options ?? [];
			const message = `${key} is a non-empty list of ${options.join(", ")}`;
			if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) throw new SettingsRefused(message, 400, key);
			for (const level of raw) if (typeof level !== "string" || !options.includes(level)) throw new SettingsRefused(message, 400, key);
			return options.filter((o) => raw.includes(o));
		}
		case "ips": {
			const max = def.maxEntries ?? 64;
			let parts: unknown[];
			if (typeof raw === "string") {
				if (raw.length > 8192) throw new SettingsRefused(`${key} is too long`, 400, key);
				parts = [raw];
			} else if (Array.isArray(raw)) {
				if (raw.length > max) throw new SettingsRefused(`${key} holds at most ${max} addresses or ranges`, 400, key);
				parts = raw;
			} else throw new SettingsRefused(`${key} is a list of addresses and CIDR ranges (an array of strings, or one string separated by commas), [] for any address`, 400, key);
			const out: string[] = [];
			for (const part of parts) {
				if (typeof part !== "string") throw new SettingsRefused(`${key} entries are strings: addresses or CIDR ranges`, 400, key);
				for (const piece of part.split(/[\s,]+/)) {
					const entry = piece.trim();
					if (!entry) continue;
					if (entry.length > 64) throw new SettingsRefused(`${key}: an entry is longer than 64 characters`, 400, key);
					try {
						parseIpRules(entry);
					} catch (error) {
						throw new SettingsRefused(`${key}: ${(error as Error).message}`, 400, key);
					}
					if (!out.includes(entry)) out.push(entry);
				}
			}
			if (out.length > max) throw new SettingsRefused(`${key} holds at most ${max} addresses or ranges`, 400, key);
			return out;
		}
		case "users": {
			const max = def.maxEntries ?? 200;
			if (typeof raw === "string" ? raw.length > 8192 : !Array.isArray(raw)) {
				throw new SettingsRefused(`${key} is a list of Roblox UserIds (an array of numbers, or one string separated by commas), [] for none`, 400, key);
			}
			const parts = typeof raw === "string" ? raw.split(/[\s,]+/) : (raw as unknown[]);
			const out: number[] = [];
			for (const part of parts) {
				if (typeof part === "string" && part.trim() === "") continue;
				const n = typeof part === "string" && /^\d{1,16}$/.test(part.trim()) ? Number(part.trim()) : part;
				if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new SettingsRefused(`${key}: entries are Roblox UserIds (positive whole numbers)`, 400, key);
				if (!out.includes(n)) out.push(n);
			}
			if (out.length > max) throw new SettingsRefused(`${key}: at most ${max} UserIds`, 400, key);
			return out.sort((a, b) => a - b);
		}
		case "switch":
			if (typeof raw !== "boolean") throw new SettingsRefused(`${key} is true or false`, 400, key);
			return raw;
		case "alertRules":
			try {
				return checkAlertSettings(raw, base as BackendAlertSettings);
			} catch (error) {
				throw new SettingsRefused((error as Error).message, 400, key);
			}
		case "names": {
			const list = typeof raw === "string" ? (raw.length > 8192 ? null : raw.split(/[\s,]+/)) : Array.isArray(raw) ? raw : null;
			if (!list) throw new SettingsRefused(`${key} is a list of event names (an array of strings, or one string separated by commas)`, 400, key);
			const out: string[] = [];
			for (const name of list) {
				if (typeof name !== "string") throw new SettingsRefused(`${key} entries are event names`, 400, key);
				const n = name.trim();
				if (!n) continue;
				if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(n)) throw new SettingsRefused(`${key}: event names are 1-128 of A-Z a-z 0-9 _ . : -`, 400, key);
				if (!out.includes(n)) out.push(n);
			}
			if (out.length > (def.maxEntries ?? 64)) throw new SettingsRefused(`${key} holds at most ${def.maxEntries} names`, 400, key);
			return out;
		}
		case "dropRules":
			try {
				return checkDropRules(raw);
			} catch (error) {
				throw new SettingsRefused((error as Error).message, 400, key);
			}
		case "kindSwitches": {
			if (!isRecord(raw)) throw new SettingsRefused(`${key} is an object of kind name -> true / false`, 400, key);
			const entries = Object.entries(raw);
			if (entries.length > (def.maxEntries ?? 64)) throw new SettingsRefused(`${key} holds at most ${def.maxEntries} kinds`, 400, key);
			const out: Record<string, boolean> = {};
			for (const [name, on] of entries) {
				if (!/^[a-z0-9_]{1,24}$/.test(name)) throw new SettingsRefused(`${key}: kind names are 1-24 of a-z 0-9 _`, 400, key);
				if (typeof on !== "boolean") throw new SettingsRefused(`${key}: each kind is true or false`, 400, key);
				out[name] = on;
			}
			return out;
		}
		case "number": {
			const min = def.min as number;
			const max = def.max as number;
			const range = `${min} to ${max}${def.zero ? ` (or 0 = ${def.zero})` : ""}`;
			if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new SettingsRefused(`${key} must be a whole number from ${range}`, 400, key);
			if (def.zero && raw === 0) return 0;
			if (raw < min || raw > max) throw new SettingsRefused(`${key} must be from ${range}`, 400, key);
			return raw;
		}
	}
}

/** `notify.kinds.<kind>.enabled` entries folded into one notify.kinds value (runtime-settings.ts foldKindSwitches). */
function foldKindSwitches(body: Record<string, unknown>, currentKinds: Record<string, boolean>): [string, unknown][] {
	const out: [string, unknown][] = [];
	let kinds: Record<string, boolean> | undefined;
	for (const [name, raw] of Object.entries(body)) {
		const m = NOTIFY_KIND_KEY.exec(name);
		if (!m) {
			out.push([name, raw]);
			continue;
		}
		kinds ??= { ...(isRecord(body["notify.kinds"]) ? (body["notify.kinds"] as Record<string, boolean>) : currentKinds) };
		if (raw === null) delete kinds[m[1] as string];
		else if (typeof raw === "boolean") kinds[m[1] as string] = raw;
		else throw new SettingsRefused(`${name} is true or false (or null to reset it)`, 400, "notify.kinds");
	}
	if (kinds) {
		const i = out.findIndex(([n]) => n === "notify.kinds");
		if (i >= 0) out.splice(i, 1);
		out.push(["notify.kinds", kinds]);
	}
	return out;
}

/** settingChanges (server/audit.ts): old -> new per key, a secret as set / not set, a list as added / removed. */
function settingChanges(changed: string[], before: Map<string, unknown>): Record<string, unknown>[] {
	return changed.map((key) => {
		const def = BY_KEY.get(key);
		const from = before.get(key);
		const { value: to, source } = current(key);
		if (def?.kind === "secret") return { key, from: from ? "set" : "not set", to: to ? "set" : "not set", source };
		if (Array.isArray(from) && Array.isArray(to)) {
			const label = (v: unknown) => (isRecord(v) && typeof v.id === "string" ? v.id : String(v));
			const was = new Set(from.map(label));
			const nowSet = new Set(to.map(label));
			return { key, added: to.map(label).filter((v) => !was.has(v)), removed: from.map(label).filter((v) => !nowSet.has(v)), source };
		}
		return { key, from, to, source };
	});
}

route<SettingsView>("GET", "/v1/admin/settings", () => settingsView());

route<SettingsView>("PATCH", "/v1/admin/settings", (req) => {
	if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return fail(415, "send JSON: { key: value, ... }");
	if (req.text.length > 16 * 1024) return fail(413, "body too large");
	let body: unknown;
	try {
		body = JSON.parse(req.text);
	} catch {
		return fail(400, "body is not JSON");
	}
	try {
		return patchSettings(body);
	} catch (error) {
		if (error instanceof SettingsRefused) {
			recordAudit({ action: "settings.change", outcome: error.status === 409 ? "refused" : "failed", status: error.status, details: { error: error.message, ...error.extra } });
		}
		throw error;
	}
});

function patchSettings(body: unknown): SettingsView {
	if (!isRecord(body)) throw new SettingsRefused('send a JSON object of settings, e.g. { "ipPerMinute": 8000 } (null resets one to the environment)', 400);
	const entries = foldKindSwitches(body, current("notify.kinds").value as Record<string, boolean>);
	if (!entries.length) throw new SettingsRefused("nothing to change", 400);
	// Check everything first (all or nothing), then the guards, then apply.
	const next = new Map<string, { reset: true } | { value: unknown }>();
	for (const [name, raw] of entries) {
		const def = BY_KEY.get(name);
		if (!def || !(Object.hasOwn(body, name) || name === "notify.kinds")) throw new SettingsRefused(`unknown setting ${safeName(name)}; the editable ones are ${SETTING_DEFS.map((s) => s.key).join(", ")}`, 400);
		next.set(def.key, raw === null ? { reset: true } : { value: checkSetting(def, raw, current(def.key).value) });
	}
	const after = (key: string): unknown => {
		const n = next.get(key);
		if (!n) return current(key).value;
		return "reset" in n ? FALLBACK[key] : n.value;
	};
	if (next.has("adminAllowIps")) {
		const list = after("adminAllowIps") as string[];
		if (list.length && !ipAllowed(parseIpRules(list.join(",")), DEMO_IP)) {
			throw new SettingsRefused(
				`refused: that admin allow list does not include your address (${DEMO_IP}), so it would lock you out; add it, or leave the list empty for any address`,
				409,
				"adminAllowIps",
				"allow-list",
			);
		}
	}
	// The token login may go off: the demo's owner is signed in with Roblox and Sign in with Roblox is on (no guard trips).

	const before = new Map(SETTING_DEFS.map((d) => [d.key, copy(current(d.key).value)]));
	const sourceBefore = new Map(SETTING_DEFS.map((d) => [d.key, current(d.key).source]));
	const touched = new Map<string, "set" | "reset">();
	for (const [key, n] of next) {
		touched.set(key, "reset" in n ? "reset" : "set");
		if (key === "errorDropRules") {
			if ("reset" in n) resetErrorDropRules();
			else setErrorDropRules(n.value);
		} else if (NOTIFY_KEYS.has(key)) {
			setNotifySwitches(notifyChange(key, "reset" in n ? FALLBACK[key] : n.value));
			settingsState.update((s) => {
				s.notifyDashboard = s.notifyDashboard.filter((k) => k !== key);
				if (!("reset" in n)) s.notifyDashboard.push(key);
			});
		} else {
			settingsState.update((s) => {
				if ("reset" in n) delete s.stored[key];
				else s.stored[key] = n.value;
			});
		}
	}
	const changed = SETTING_DEFS.map((d) => d.key).filter((k) => touched.has(k) && (JSON.stringify(before.get(k)) !== JSON.stringify(current(k).value) || sourceBefore.get(k) !== current(k).source));
	if (changed.length) {
		const set = changed.filter((k) => touched.get(k) === "set");
		const reset = changed.filter((k) => touched.get(k) === "reset");
		const entry: SettingsAuditEntry = { at: new Date(now()).toISOString(), who: OWNER_WHO, via: "session", action: "change", ...(set.length ? { set } : {}), ...(reset.length ? { reset } : {}) };
		settingsState.update((s) => {
			s.audit = [entry, ...s.audit].slice(0, SETTINGS_AUDIT_MAX);
		});
		recordAudit({ action: "settings.change", details: { changes: settingChanges(changed, before) } });
	}
	return { ...settingsView(), changed };
}

route<TestAlertResult>("POST", "/v1/admin/settings/test-alert", () => {
	const limit = take("test-alert", 3);
	if (!limit.ok) return tooMany(limit.retryAfter);
	if (current("alertWebhookUrl").value === "") return json(409, { ok: false, error: "no alert webhook is set: save one first" });
	// Nothing leaves the browser: the demo answers as a Discord webhook does.
	const result = "sent (HTTP 204)";
	settingsState.update((s) => {
		s.audit = [{ at: new Date(now()).toISOString(), who: OWNER_WHO, via: "session" as const, action: "test-alert" as const, result }, ...s.audit].slice(0, SETTINGS_AUDIT_MAX);
	});
	recordAudit({ action: "settings.test-alert", details: { result } });
	return { ok: true, status: 204 };
});

// The data folder, the disk and the server's own numbers -----------------------------------------------------------------

const GIB = 1024 ** 3;
const DISK_TOTAL = 80 * GIB;
/** What else is on the disk (the OS, Docker images, the other apps on the box). */
const DISK_BASE_USED = 21.6 * GIB;

/** Events per pack day, from the facts (days before today; today is in the live table). */
function dayRows(p: Pack, at: number): { date: string; events: number; recordings: number }[] {
	const today = Math.floor(at / DAY_MS) * DAY_MS;
	const first = Math.floor(p.from / DAY_MS) * DAY_MS;
	const days: number[] = [];
	for (let d = first; d < today; d += DAY_MS) days.push(d);
	const weights = days.map((d) => 0.75 + 0.5 * rng(`storage:day:${d - p.shiftMs}`).next());
	const sum = weights.reduce((a, b) => a + b, 0) || 1;
	const perDay = p.totals.events / 14;
	const recPerDay = p.totals.recordings.chunks / 14;
	return days.map((d, i) => ({ date: new Date(d).toISOString().slice(0, 10), events: Math.round(((weights[i] as number) / sum) * perDay * days.length), recordings: Math.round(((weights[i] as number) / sum) * recPerDay * days.length) }));
}

/** Today's rows so far (the healthz "live rows" formula, so the two agree). */
function liveRows(p: Pack, at: number): { events: number; recordings: number } {
	const today = Math.floor(at / DAY_MS) * DAY_MS;
	const share = Math.max(0, Math.min(1, (at - today) / DAY_MS));
	return { events: Math.round((p.totals.events / 14) * share), recordings: Math.round((p.totals.recordings.chunks / 14) * share) };
}

const PARQUET_EVENT_BYTES = 23;
const PARQUET_CHUNK_BYTES = 640;
const RAW_ROW_BYTES = 58;

function storageReport(p: Pack, at: number): StorageReport {
	const days = dayRows(p, at);
	const live = liveRows(p, at);
	const r = rng(`storage:${Math.floor(at / 30_000)}`);
	const dayParts = (key: "events" | "recordings", label: string, per: number, pick: (d: (typeof days)[number]) => number): StoragePart => ({
		key,
		label,
		bytes: days.reduce((s, d) => s + pick(d) * per + 4096, 0),
		files: days.length,
		days: days.length,
		...(days.length ? { oldest: days[0]?.date as string, newest: days[days.length - 1]?.date as string } : {}),
	});
	const rawDays = days.slice(-14).map((d) => ({ date: d.date, bytes: d.events * RAW_ROW_BYTES + d.recordings * 900 }));
	const todayRaw = live.events * RAW_ROW_BYTES + live.recordings * 900;
	const incoming = r.int(4, 40) * 1024;
	const parts: StoragePart[] = [
		{ key: "live", label: "DuckDB live (today)", bytes: 12 * 1024 * 1024 + live.events * 61 + live.recordings * 700, files: 2 },
		dayParts("events", "Parquet events", PARQUET_EVENT_BYTES, (d) => d.events),
		dayParts("recordings", "Parquet recordings", PARQUET_CHUNK_BYTES, (d) => d.recordings),
		{ key: "rawIncoming", label: "Raw incoming", bytes: incoming, files: r.int(1, 6) },
		{ key: "rawArchive", label: "Raw archive", bytes: rawDays.reduce((s, d) => s + d.bytes, 0) + todayRaw, files: (rawDays.length + 1) * 288 },
		{ key: "rollups", label: "Rollups", bytes: days.length * 214_000, files: days.length * 3 },
		{ key: "sql", label: "SQL sandbox", bytes: 0, files: 0 },
		{ key: "tmp", label: "DuckDB spill", bytes: 0, files: 0 },
		{ key: "fleet", label: "Fleet SQLite", bytes: 38 * 1024 * 1024 + p.jobs.length * 21_000, files: 3 },
	];
	const before = rawDays.slice(-7);
	return {
		at: new Date(Math.floor(at / 30_000) * 30_000).toISOString(),
		cacheSeconds: 30,
		totalBytes: parts.reduce((s, x) => s + x.bytes, 0),
		parts,
		rows: { liveEvents: live.events, liveRecordings: live.recordings, parquetEvents: days.reduce((s, d) => s + d.events, 0), parquetRecordings: days.reduce((s, d) => s + d.recordings, 0) },
		growth: { todayBytes: todayRaw + incoming, avgPerDayBytes: before.length ? Math.round(before.reduce((s, d) => s + d.bytes, 0) / before.length) : null, days: [...rawDays, { date: new Date(at).toISOString().slice(0, 10), bytes: todayRaw }].slice(-8) },
		disk: diskStatus(p, at),
	};
}

/** The data folder's disk (measured every 10 minutes, like DiskWatch). */
function diskStatus(p: Pack, at: number): DiskStatus {
	const measured = Math.floor(at / 600_000) * 600_000;
	const used = DISK_BASE_USED + dataBytes(p, measured);
	const free = DISK_TOTAL - used;
	return { freeBytes: Math.round(free), totalBytes: DISK_TOTAL, freePercent: Math.round((free / DISK_TOTAL) * 1000) / 10, level: "ok", warnFreePercent: 15, criticalFreePercent: 5, at: new Date(measured).toISOString() };
}

/** The data folder's size at a time (also a backup's size, minus the raw archive). */
function dataBytes(p: Pack, at: number): number {
	const days = dayRows(p, at);
	const live = liveRows(p, at);
	return 12 * 1024 * 1024 + live.events * 61 + days.reduce((s, d) => s + d.events * (PARQUET_EVENT_BYTES + RAW_ROW_BYTES) + d.recordings * (PARQUET_CHUNK_BYTES + 900), 0) + 38 * 1024 * 1024;
}

function backupBytes(p: Pack, at: number): number {
	const days = dayRows(p, at);
	return 9 * 1024 * 1024 + 38 * 1024 * 1024 + days.reduce((s, d) => s + d.events * PARQUET_EVENT_BYTES + d.recordings * PARQUET_CHUNK_BYTES, 0) + (hashString(`backup:bytes:${at}`) % 400_000);
}

route<StorageReport>("GET", "/v1/storage", async () => storageReport(await pack(), now()));

// Backups ----------------------------------------------------------------------------------------------------------------

const BACKUP_KEEP = 3;
const BACKUP_EVERY_HOURS = 24;
const BACKUP_DIR = "/data/backups";

interface ManualBackup {
	name: string;
	at: number;
	reason: "manual";
	bytes: number;
	files: number;
}

const manualBackups = slice<ManualBackup[]>("admin.backups", () => []);

async function backupsStatus(): Promise<BackupsStatus> {
	const p = await pack();
	const at = now();
	const scheduled = scheduledBackupTimes(p, at).map((t): BackupInfo => ({ name: backupName(t), createdAt: new Date(t).toISOString(), reason: "scheduled", bytes: backupBytes(p, t), files: rng(`audit:backup:${t}`).int(40, 70), duckdb: true }));
	const manual = manualBackups
		.get()
		.filter((b) => b.at <= at)
		.map((b): BackupInfo => ({ name: b.name, createdAt: new Date(b.at).toISOString(), reason: b.reason, bytes: b.bytes, files: b.files, duckdb: true }));
	const all = [...scheduled, ...manual].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
	const kept = all.slice(0, BACKUP_KEEP);
	const newest = all[0];
	const newestAt = newest?.createdAt ? Date.parse(newest.createdAt) : undefined;
	return {
		dir: BACKUP_DIR,
		keep: BACKUP_KEEP,
		everyHours: BACKUP_EVERY_HOURS,
		running: false,
		last: newest && newest.createdAt ? { at: newest.createdAt, ok: true, reason: newest.reason ?? "scheduled", name: newest.name } : null,
		// The schedule counts from the newest backup of any kind (backup.ts status()).
		next: new Date(newestAt !== undefined ? Math.max(at, newestAt + BACKUP_EVERY_HOURS * HOUR_MS) : at).toISOString(),
		backups: kept,
		disk: diskStatus(p, at),
	};
}

route<BackupsStatus>("GET", "/v1/admin/backups", () => backupsStatus());

route<BackupsStatus & { ok: true; manifest: Record<string, unknown> }>("POST", "/v1/admin/backups", async () => {
	const limit = take("backup", 2);
	if (!limit.ok) return tooMany(limit.retryAfter);
	const p = await pack();
	const at = now();
	let name = backupName(at);
	const names = new Set(manualBackups.get().map((b) => b.name));
	for (let i = 2; names.has(name); i++) name = `${backupName(at)}-${i}`;
	const r = rng(`backup:manual:${name}`);
	const manifest = {
		format: "typetorch-backup-v1",
		name,
		createdAt: new Date(at).toISOString(),
		version: DEMO_VERSION,
		reason: "manual",
		seconds: Math.round(r.float(3.5, 9) * 10) / 10,
		bytes: backupBytes(p, at),
		files: r.int(40, 70),
		sqlite: true,
		duckdb: true,
		dayFiles: dayRows(p, at).length * 2,
		dayFilesBy: "link",
		state: ["access.json", "runtime-settings.json", "devices.json", "settings.json", "instance.key", "audit/"],
		leftOut: ["raw/incoming (the last seconds of accepted batches; in the next backup)", "raw/archive (the loaded batches again; their rows are in live.duckdb and the day files)"],
	};
	manualBackups.update((list) => {
		list.push({ name, at, reason: "manual", bytes: manifest.bytes, files: manifest.files });
		list.sort((a, b) => a.at - b.at);
		if (list.length > 20) list.splice(0, list.length - 20);
	});
	recordAudit({ action: "backup.create", details: { name, bytes: manifest.bytes, files: manifest.files, duckdb: true, seconds: manifest.seconds } });
	return { ok: true, manifest, ...(await backupsStatus()) };
});

/** A ustar archive of small files (what the download sends: the demo has no data folder to pack). */
export function tarFiles(files: { name: string; data: Uint8Array; mtime: number }[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	const enc = new TextEncoder();
	const field = (header: Uint8Array, offset: number, length: number, text: string) => header.set(enc.encode(text).subarray(0, length), offset);
	const octal = (n: number, length: number) => `${n.toString(8).padStart(length - 1, "0")}\0`;
	for (const f of files) {
		const header = new Uint8Array(512);
		field(header, 0, 100, f.name);
		field(header, 100, 8, "0000600\0");
		field(header, 108, 8, "0000000\0");
		field(header, 116, 8, "0000000\0");
		field(header, 124, 12, octal(f.data.byteLength, 12));
		field(header, 136, 12, octal(Math.floor(f.mtime / 1000), 12));
		field(header, 148, 8, "        ");
		field(header, 156, 1, "0");
		field(header, 257, 6, "ustar\0");
		field(header, 263, 2, "00");
		field(header, 265, 32, "typetorch");
		field(header, 297, 32, "typetorch");
		const sum = header.reduce((a, b) => a + b, 0);
		field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(f.data.byteLength / 512) * 512);
		padded.set(f.data);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((s, b) => s + b.byteLength, 0));
	let at = 0;
	for (const b of blocks) {
		out.set(b, at);
		at += b.byteLength;
	}
	return out;
}

route("POST", "/v1/admin/backups/download", () => {
	const limit = take("backup", 2);
	if (!limit.ok) return tooMany(limit.retryAfter);
	const at = now();
	const name = backupName(at);
	const manifest = {
		format: "typetorch-backup-v1",
		name,
		createdAt: new Date(at).toISOString(),
		version: DEMO_VERSION,
		reason: "download",
		seconds: 0.1,
		bytes: 0,
		files: 2,
		sqlite: false,
		duckdb: false,
		dayFiles: 0,
		dayFilesBy: "none",
		state: [],
		leftOut: ["everything: this is the public demo (demo.typetorch.dev), which has no data folder; a real backend's download holds fleet.sqlite, live.duckdb, the Parquet day files and its state files"],
	};
	const note = [
		"TypeTorch demo backup",
		"",
		"This is the public demo of the TypeTorch backend's explorer: it runs in your browser on an anonymized sample of The Prison's data,",
		"so there is no data folder to back up. On a real backend this download is a tar of a fresh backup (fleet.sqlite, notify.sqlite,",
		"live.duckdb, the Parquet day files, access.json, runtime-settings.json without the alert webhook URL...): see the README's",
		'"Backups and restore". Nothing was sent anywhere.',
		"",
	].join("\n");
	const enc = new TextEncoder();
	const files = [
		{ name: `${name}/manifest.json`, data: enc.encode(`${JSON.stringify(manifest, null, "\t")}\n`), mtime: at },
		{ name: `${name}/README.txt`, data: enc.encode(note), mtime: at },
	];
	manifest.bytes = files.reduce((s, f) => s + f.data.byteLength, 0);
	files[0] = { name: `${name}/manifest.json`, data: enc.encode(`${JSON.stringify(manifest, null, "\t")}\n`), mtime: at };
	const tar = tarFiles(files);
	recordAudit({ action: "backup.download", details: { name, bytes: manifest.bytes, files: manifest.files, duckdb: false } });
	return new Response(tar as Uint8Array<ArrayBuffer>, {
		status: 200,
		headers: { "content-type": "application/x-tar", "content-disposition": `attachment; filename="${name}.tar"`, "cache-control": "no-store", "x-backup-bytes": String(manifest.bytes) },
	});
});

// Trusted browsers (Sign in with typetorch.dev) --------------------------------------------------------------------------

interface DeviceRecord {
	id: string;
	/** Days and hours before today 00:00 UTC (stable across visits). */
	createdDaysAgo: number;
	usedHoursAgo: number;
	via: BlessedDevice["via"];
	agent?: string;
	current?: boolean;
}

const devicesState = slice<DeviceRecord[]>("admin.devices", () => [
	{ id: rng("device:1").hex(16), createdDaysAgo: 12.6, usedHoursAgo: 0, via: "signing key", agent: "Chrome/131 on Windows", current: true },
	{ id: rng("device:2").hex(16), createdDaysAgo: 5.3, usedHoursAgo: 26, via: "admin token", agent: "Safari/18 on iPhone" },
	{ id: rng("device:3").hex(16), createdDaysAgo: 2.1, usedHoursAgo: 51, via: "signing key", agent: "Firefox/133 on Linux" },
]);

function deviceViews(): BlessedDevice[] {
	const at = now();
	const today = Math.floor(at / DAY_MS) * DAY_MS;
	return devicesState.get().map((d) => {
		const created = today - d.createdDaysAgo * DAY_MS;
		const used = d.current ? at : Math.max(created, at - d.usedHoursAgo * HOUR_MS);
		return { id: d.id, created: new Date(created).toISOString(), used: new Date(used).toISOString(), via: d.via, ...(d.agent ? { agent: d.agent } : {}), ...(d.current ? { current: true } : {}) };
	});
}

route<{ devices: BlessedDevice[] }>("GET", "/v1/admin/devices", () => ({ devices: deviceViews() }));

route<{ ok: boolean; sessionsEnded: number; devices: BlessedDevice[] }>("DELETE", "/v1/admin/devices/:id", (req: MockRequest) => {
	const id = req.params.id as string;
	if (!/^[0-9a-f]{16}$/.test(id)) return fail(400, "bad device id");
	if (!devicesState.get().some((d) => d.id === id)) return fail(404, "no such device");
	devicesState.update((list) => list.filter((d) => d.id !== id));
	recordAudit({ action: "device.revoke", details: { device: id, sessionsEnded: 0 } });
	return { ok: true, sessionsEnded: 0, devices: deviceViews() };
});

// Server metrics (GET /v1/admin/stats) -----------------------------------------------------------------------------------

const STATS_WINDOWS: readonly StatsWindow[] = ["1m", "5m", "15m", "1h"];
const WINDOW_MINUTES: Record<StatsWindow, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };

/** How busy the game is at a time of day (UTC): The Prison peaks in the European evening and the US afternoon. */
function dayCurve(t: number): number {
	const h = ((t % DAY_MS) / HOUR_MS + 24) % 24;
	return 0.55 + 0.25 * Math.cos(((h - 19) / 24) * 2 * Math.PI) + 0.2 * Math.cos(((h - 1) / 12) * 2 * Math.PI) * 0.5;
}

interface Load {
	/** Requests per second (ingest batches, heartbeats, error logs, the explorer). */
	requests: number;
	/** Analytics rows accepted per second. */
	rows: number;
	servers: number;
	players: number;
}

function loadAt(p: Pack, t: number): Load {
	const live = p.jobs.filter((j) => j.live);
	const players = live.reduce((s, j) => s + playersAt(j, Math.min(t, p.now)), 0);
	const curve = dayCurve(t);
	const servers = Math.max(1, live.length);
	// Each server sends an ingest batch every 5 s, a heartbeat a minute, error logs now and then; the explorer polls.
	const requests = (servers * (0.2 + 1 / 60 + 0.03) + 0.6) * (0.7 + 0.3 * curve);
	const rows = (p.totals.events / 14 / 86_400) * curve * 1.6;
	return { requests, rows, servers, players };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function latency(count: number, r: ReturnType<typeof rng>, base: number): LatencySummary {
	if (count <= 0) return { count: 0, p50: null, p90: null, p99: null, max: null, avg: null };
	const p50 = base * r.float(0.8, 1.25);
	const p90 = p50 * r.float(2.6, 3.8);
	const p99 = count >= 20 ? p90 * r.float(2.2, 3.4) : p90 * r.float(1.1, 1.6);
	const max = Math.max(p99, p99 * r.float(1, count >= 50 ? 2.4 : 1.3));
	return { count, p50: round2(p50), p90: round2(p90), p99: round2(p99), max: round2(max), avg: round2(p50 * r.float(1.4, 1.9)) };
}

/** Merges summaries roughly (count-weighted means for the percentiles, the max of the maxes). */
function mergeLatency(list: LatencySummary[]): LatencySummary {
	const xs = list.filter((l) => l.count > 0);
	const count = xs.reduce((s, l) => s + l.count, 0);
	if (!count) return { count: 0, p50: null, p90: null, p99: null, max: null, avg: null };
	const w = (pick: (l: LatencySummary) => number | null) => round2(xs.reduce((s, l) => s + (pick(l) ?? 0) * l.count, 0) / count);
	return { count, p50: w((l) => l.p50), p90: w((l) => l.p90), p99: round2(Math.max(...xs.map((l) => l.p99 ?? 0)) * 0.85), max: round2(Math.max(...xs.map((l) => l.max ?? 0))), avg: w((l) => l.avg) };
}

function poisson(r: ReturnType<typeof rng>, mean: number): number {
	if (mean <= 0) return 0;
	if (mean > 30) return Math.max(0, Math.round(r.normal(mean, Math.sqrt(mean))));
	const l = Math.exp(-mean);
	let k = 0;
	let prod = r.next();
	while (prod > l) {
		k++;
		prod *= r.next();
	}
	return k;
}

/** One bucket (a second or a minute) of the server's work, the same on every visit for the same time. */
function bucket(p: Pack, at: number, spanSeconds: number, share = 1): StatsBucket {
	const r = rng(`stats:${spanSeconds}:${at}`);
	const load = loadAt(p, at);
	const requests = poisson(r, load.requests * spanSeconds * share);
	const s4 = poisson(r, requests * 0.012);
	const s3 = poisson(r, requests * 0.004);
	const s5 = r.chance(spanSeconds > 1 ? 0.04 : 0.001) ? 1 : 0;
	const duck = poisson(r, 0.32 * spanSeconds * share * (0.6 + 0.4 * dayCurve(at)));
	const rows = poisson(r, load.rows * spanSeconds * share);
	const loaded = spanSeconds >= 60 ? Math.round(rows * r.float(0.9, 1.1)) : r.chance(0.2) ? poisson(r, load.rows * 5) : 0;
	return {
		at,
		requests,
		status: { "2xx": Math.max(0, requests - s4 - s3 - s5), "3xx": s3, "4xx": s4, "5xx": Math.min(s5, requests) },
		latency: latency(requests, r.fork("latency"), 1.9),
		duckdb: { queries: duck, latency: latency(duck, r.fork("duck"), 14), rowsLoaded: loaded },
		sqlite: { reads: poisson(r, requests * 1.3), writes: poisson(r, load.servers * spanSeconds * share * (1 / 60 + 0.02)) },
		ingest: { rows, bytes: Math.round(rows * r.float(150, 210)) },
		memory: { rssMb: Math.round(r.normal(412, 4, 398, 430)), heapMb: Math.round(r.normal(124, 5, 108, 140)), heapTotalMb: 168, externalMb: Math.round(r.normal(41, 1.5, 36, 46)) },
		cpuPercent: round2(r.normal(4.2 + 2.5 * dayCurve(at), 1.2, 0.8, 22)),
		loopLagMs: round2(r.normal(2.1, 0.9, 0.4, 14)),
	};
}

const ROUTE_MIX: [RouteGroup, number, number][] = [
	// group, share of requests, p50 ms
	["ingest", 0.52, 2.4],
	["fleet-in", 0.12, 1.6],
	["errors-in", 0.06, 1.8],
	["explorer", 0.08, 0.6],
	["health", 0.05, 0.4],
	["query", 0.05, 24],
	["fleet", 0.05, 3.1],
	["stream", 0.02, 0.9],
	["errors", 0.02, 6.2],
	["roblox", 0.01, 4.5],
	["auth", 0.01, 1.2],
	["admin", 0.01, 2.2],
];

async function backendStats(window: StatsWindow): Promise<BackendStats> {
	const p = await pack();
	const at = now();
	const lastSecond = Math.floor((at - 1000) / 1000) * 1000;
	const seconds: StatsBucket[] = [];
	for (let t = lastSecond - 119_000; t <= lastSecond; t += 1000) seconds.push(bucket(p, t, 1));
	const thisMinute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
	const minutes: StatsBucket[] = [];
	for (let t = thisMinute - 59 * MINUTE_MS; t <= thisMinute; t += MINUTE_MS) minutes.push(bucket(p, t, 60, t === thisMinute ? Math.max(0.02, (at - t) / MINUTE_MS) : 1));
	const recent = seconds.slice(-10);
	const rate = (pick: (b: StatsBucket) => number) => round2(recent.reduce((s, b) => s + pick(b), 0) / 10);
	const span = minutes.filter((b) => b.at > at - WINDOW_MINUTES[window] * MINUTE_MS);
	const windowRequests = span.reduce((s, b) => s + b.requests, 0);
	const windowErrors = span.reduce((s, b) => s + b.status["5xx"], 0);
	const r = rng(`stats:routes:${window}:${thisMinute}`);
	const routes: RouteStats[] = ROUTE_MIX.map(([group, share, base]) => {
		const requests = Math.round(windowRequests * share * r.float(0.85, 1.15));
		return { group, requests, errors: group === "ingest" ? windowErrors : 0, latency: latency(requests, r.fork(group), base) };
	})
		.filter((x) => x.requests > 0)
		.sort((a, b) => b.requests - a.requests);
	const started = serverStartedAt(at);
	const uptime = Math.max(0, Math.round((at - started) / 1000));
	const load = loadAt(p, at);
	const last = seconds[seconds.length - 1] as StatsBucket;
	return {
		now: at,
		uptimeSeconds: uptime,
		state: "ready",
		version: DEMO_VERSION,
		runtime: "bun 1.3 (demo)",
		rates: {
			seconds: 10,
			requests: rate((b) => b.requests),
			errors: rate((b) => b.status["5xx"]),
			duckQueries: rate((b) => b.duckdb.queries),
			rowsIn: rate((b) => b.ingest.rows),
			rowsLoaded: rate((b) => b.duckdb.rowsLoaded),
			sqliteReads: rate((b) => b.sqlite.reads),
			sqliteWrites: rate((b) => b.sqlite.writes),
		},
		sample: { rssMb: last.memory?.rssMb ?? 412, heapMb: last.memory?.heapMb ?? 124, heapTotalMb: 168, externalMb: last.memory?.externalMb ?? 41, cpuPercent: last.cpuPercent ?? 4, loopLagMs: last.loopLagMs ?? 2 },
		latency: { recent: mergeLatency(recent.map((b) => b.latency)), window: mergeLatency(span.map((b) => b.latency)) },
		duckdb: { recent: mergeLatency(recent.map((b) => b.duckdb.latency)), window: mergeLatency(span.map((b) => b.duckdb.latency)) },
		totals: {
			requests: Math.round(load.requests * uptime * 0.92),
			errors: Math.round(uptime / 5400),
			duckQueries: Math.round(0.3 * uptime),
			rowsIn: Math.round(load.rows * uptime * 0.7),
			bytesIn: Math.round(load.rows * uptime * 0.7 * 180),
			rowsLoaded: Math.round(load.rows * uptime * 0.7),
			sqliteReads: Math.round(load.requests * uptime * 1.2),
			sqliteWrites: Math.round(load.servers * uptime * 0.04),
			since: started,
		},
		seconds,
		minutes,
		window,
		routes,
	};
}

route<BackendStats>("GET", "/v1/admin/stats", async (req) => {
	const raw = req.query.get("window");
	const window = raw === null || raw === "" ? "5m" : (STATS_WINDOWS as readonly string[]).includes(raw) ? (raw as StatsWindow) : undefined;
	if (!window) return fail(400, `window must be one of ${STATS_WINDOWS.join(", ")}`);
	return backendStats(window);
});

// Backend alert rules (GET /v1/admin/alert-rules) ------------------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

route<AlertRulesStatus>("GET", "/v1/admin/alert-rules", async () => {
	const p = await pack();
	const at = now();
	const settings = backendAlertSettings();
	const lastRun = Math.floor((at - 7_000) / MINUTE_MS) * MINUTE_MS + 7_000;
	const load = loadAt(p, at);
	const disk = diskStatus(p, at);
	const latest = [...p.artifacts].filter((a) => a.branch === "prod" && a.seq).sort((a, b) => b.firstAt - a.firstAt)[0];
	const peak = Math.max(load.players, Math.round(load.players * 1.08));
	const minutesIn = (id: string, key: string) => settings.rules[id as keyof typeof settings.rules]?.params[key] ?? 0;
	const r = rng(`alert-rules:${Math.floor(at / MINUTE_MS)}`);
	const verdicts: Record<string, { state: "ok" | "waiting"; note: string }> = {
		errorSpike: { state: "ok", note: `top kind ${r.int(3, 14)} in ${minutesIn("errorSpike", "minutes")} min` },
		errorNewAfterDeploy: latest ? { state: "ok", note: `seq ${latest.seq}: ${plural(r.int(0, 2), "new kind")}${at - latest.firstAt > minutesIn("errorNewAfterDeploy", "minutes") * MINUTE_MS ? " (window over)" : ""}` } : { state: "waiting", note: "no deploy recorded yet" },
		ccuDrop: peak < minutesIn("ccuDrop", "minPlayers") ? { state: "waiting", note: `peak ${peak} players, below ${minutesIn("ccuDrop", "minPlayers")}` } : { state: "ok", note: `${load.players} players online (peak ${peak} in ${minutesIn("ccuDrop", "minutes")} min)` },
		fleetSilent: { state: "ok", note: `last heartbeat ${r.int(2, 40)} s ago` },
		ingestStopped: { state: "ok", note: `${Math.max(1, Math.round(load.rows * 60))} rows / min` },
		backendLatency: { state: "ok", note: `p99 ${r.int(60, 240)} ms at most` },
		backendMemory: { state: "ok", note: `RSS ${Math.round(r.normal(412, 4))} MB` },
		backendLoopLag: { state: "ok", note: `lag ${r.int(4, 16)} ms at most` },
		backend5xx: (() => {
			const requests = Math.round(load.requests * 60 * minutesIn("backend5xx", "minutes"));
			const min = minutesIn("backend5xx", "minRequests");
			return requests < min ? { state: "waiting" as const, note: `${requests} requests in ${minutesIn("backend5xx", "minutes")} min, below ${min}` } : { state: "ok" as const, note: "0.0% 5xx" };
		})(),
		diskLow: { state: "ok", note: `${(disk.freeBytes / GIB).toFixed(1)} GB free (${disk.freePercent.toFixed(1)}%)` },
		diskGrowth: { state: "ok", note: `+${((dataBytes(p, at) - dataBytes(p, at - DAY_MS)) / GIB).toFixed(1)} GB / day, full in ${plural(Math.floor(disk.freeBytes / Math.max(1, dataBytes(p, at) - dataBytes(p, at - DAY_MS))), "day")}` },
	};
	return {
		on: settings.on,
		tickSeconds: 60,
		lastRunAt: new Date(lastRun).toISOString(),
		lastRunMs: Math.round(r.float(18, 64)),
		raised: 0,
		deduped: 0,
		throttled: 0,
		failed: 0,
		rules: RULES.map((rule) => {
			const v = !settings.on || !settings.rules[rule.id].on ? { state: "off" as const, note: !settings.on ? "backend alerts are off" : "off" } : (verdicts[rule.id] ?? { state: "waiting" as const, note: "not run yet" });
			return { id: rule.id, state: v.state, note: v.note, lastRaisedAt: null };
		}),
	};
});
