/**
 * The audit log: who did what on the admin side. One row per state-changing admin action (settings, the owner list,
 * viewers, trusted browsers, alert acks, erasure, the identity backfill, backups, remote debug, the CLI's release starts
 * and marks), every sign-in (success and failure, with the method and the address), sign-out and lockout, in the
 * backend's SQLite file (`audit_log`). app.ts records it in one place: the request handler writes an entry after the
 * route answered, from what the route's gate saw (the principal) plus what the handler noted (the action's name and
 * details); a write the handler didn't name is still recorded under its method and route.
 *
 * Never a secret: details go through `redact` (known secret values and secret-looking keys become "[redacted]") and
 * are capped in size; a setting of the secret kind is recorded as set / not set only. Bounded: entries older than
 * `keepDays` are pruned, at most MAX_ROWS are kept, and entries nobody signed in caused (failed sign-ins, a lockout) are
 * capped per minute, the rest counted in one `audit.suppressed` entry.
 */
import type { FleetDb, SqlValue } from "../fleet/db.ts";
import type { SessionUser } from "./auth.ts";
import { SETTINGS, type RuntimeKey } from "./runtime-settings.ts";

const DAY = 86_400_000;
/** The most rows kept whatever the retention says (the oldest go first). */
export const AUDIT_MAX_ROWS = 200_000;
/** Entries per minute without a signed-in caller (failed sign-ins, lockouts, the erasure webhook) before they are counted instead. */
export const AUDIT_ANONYMOUS_PER_MINUTE = 120;
/** A page of GET /v1/admin/audit. */
export const AUDIT_PAGE_MAX = 500;
/** The details JSON of one entry, bytes. */
export const AUDIT_DETAILS_MAX = 4096;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, actor_kind TEXT NOT NULL, user_id INTEGER,
	role TEXT NOT NULL, via TEXT NOT NULL, ip TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, status INTEGER, details TEXT);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log (actor, id);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action, id);
`;

/**
 * Who acted. `token`: the admin token (Bearer, or a session made with it); `roblox`: a Sign in with Roblox session;
 * `typetorch.dev`: a Sign in with typetorch.dev session; `api-key`: the game key (the CLI's release starts and marks);
 * `roblox-webhook`: Roblox's signed erasure webhook; `anonymous`: nobody signed in (a failed sign-in); `system`: the server.
 */
export type AuditActorKind = "token" | "roblox" | "typetorch.dev" | "api-key" | "roblox-webhook" | "anonymous" | "system";
export type AuditOutcome = "ok" | "failed" | "refused";
export type AuditRole = "admin" | "web" | "game" | "none";
export type AuditVia = "bearer" | "cookie" | "signature" | "none";

export interface AuditActor {
	kind: AuditActorKind;
	/** "admin token", "roblox user 1001 (name)", "typetorch.dev user 1001 (name)", "api key", "anonymous". */
	label: string;
	userId?: number;
}

export interface AuditInput {
	actor: AuditActor;
	role: AuditRole;
	via: AuditVia;
	ip: string;
	/** A dotted name (settings.change, sign-in, ...) or, for a route nobody named, "<METHOD> <route>". */
	action: string;
	outcome: AuditOutcome;
	status?: number;
	details?: Record<string, unknown>;
}

export interface AuditEntry {
	id: number;
	at: string;
	actor: string;
	actorKind: AuditActorKind;
	userId: number | null;
	role: AuditRole;
	via: AuditVia;
	ip: string;
	action: string;
	outcome: AuditOutcome;
	status: number | null;
	details: Record<string, unknown> | null;
}

export interface AuditQuery {
	actor?: string;
	/** An action, or a prefix ending in "*" ("settings.*"). */
	action?: string;
	outcome?: AuditOutcome;
	since?: number;
	until?: number;
	/** Entries older than this id (the next page). */
	before?: number;
	limit?: number;
}

export interface AuditOptions {
	clock?: () => number;
	/** Days kept; read at every prune (a runtime setting). */
	keepDays: () => number;
	/** The secret values in play (tokens, keys, the webhook URL): any string holding one is redacted. */
	secrets: () => readonly (string | undefined)[];
	log?: (line: string) => void;
	maxRows?: number;
	anonymousPerMinute?: number;
}

/** Keys whose values are never recorded, whatever they hold. */
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[_-]?key|webhook[_-]?url|signature|^sig$|verifier|private/i;
const REDACTED = "[redacted]";

/**
 * A copy of `value` safe for the audit log: secret-looking keys and every string that holds a known secret become
 * "[redacted]"; strings are cut to 200 characters (control characters dropped), lists to 50 items, depth to 4.
 */
export function redact(value: unknown, secrets: readonly (string | undefined)[], depth = 0): unknown {
	const known = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8);
	const walk = (v: unknown, d: number): unknown => {
		if (v === null || typeof v === "number" || typeof v === "boolean") return v;
		if (typeof v === "string") {
			if (known.some((s) => v.includes(s))) return REDACTED;
			return v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
		}
		if (d >= 4) return "[...]";
		if (Array.isArray(v)) {
			const out = v.slice(0, 50).map((x) => walk(x, d + 1));
			if (v.length > 50) out.push(`[${v.length - 50} more]`);
			return out;
		}
		if (typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
				const key = k.replace(/[^\w.-]/g, "").slice(0, 48);
				if (!key) continue;
				out[key] = SECRET_KEY.test(key) ? REDACTED : walk(x, d + 1);
			}
			return out;
		}
		return String(v).slice(0, 200);
	};
	return walk(value, depth);
}

/** A Roblox name made safe for a label (letters, digits, _ . -); Roblox's "Roblox user <id>" stand-in adds nothing. */
function safeName(raw: string): string {
	return /^Roblox user \d+$/.test(raw) ? "" : raw.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
}

/** The actor behind a session user: the admin token, or a Roblox UserId with its name (and whether typetorch.dev signed it in). */
export function actorOfUser(user: SessionUser): AuditActor {
	if (user.kind === "token") return { kind: "token", label: "admin token" };
	const name = safeName(user.name);
	const kind = user.login === "typetorch.dev" ? "typetorch.dev" : "roblox";
	return { kind, label: `${kind === "roblox" ? "roblox" : "typetorch.dev"} user ${user.userId}${name ? ` (${name})` : ""}`, userId: user.userId };
}

export const ANONYMOUS: AuditActor = { kind: "anonymous", label: "anonymous" };

/**
 * The name of a write nobody named: friendly names for the known routes, else "<METHOD> <route>" with ids
 * (numbers, JobIds, hex) as ":id" so the action filter stays short; the real path goes in the details then.
 */
export function routeAction(method: string, path: string): { action: string; details?: Record<string, unknown> } {
	const ack = /^\/v1\/fleet\/alerts\/(\d{1,16})\/ack$/.exec(path);
	if (method === "POST" && ack) return { action: "alert.ack", details: { alert: Number(ack[1]) } };
	const debug = /^\/v1\/fleet\/servers\/([^/]{1,64})\/(watch|commands)$/.exec(path);
	if (method === "POST" && debug) return { action: debug[2] === "watch" ? "debug.watch" : "debug.command", details: { job: debug[1] } };
	if (method === "POST" && path === "/v1/fleet/deploy") return { action: "deploy.start" };
	if (method === "POST" && path === "/v1/fleet/mark") return { action: "deploy.mark" };
	if (method === "POST" && path === "/v1/central/report") return { action: "central.report" };
	const generic = path
		.split("/")
		.map((part) => (/^\d+$/.test(part) || /^[0-9a-f]{12,}$/i.test(part) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part) || part.length > 40 ? ":id" : part))
		.join("/")
		.slice(0, 80);
	return { action: `${method} ${generic}`, ...(generic !== path ? { details: { path: path.slice(0, 200) } } : {}) };
}

/**
 * What a settings save changed, for the audit entry: each key with its old and new value and where the new one comes
 * from. A secret (the webhook URL) only as "set" / "not set"; a list as what was added and removed.
 */
export function settingChanges(changed: readonly RuntimeKey[], before: (key: RuntimeKey) => unknown, after: (key: RuntimeKey) => unknown, source: (key: RuntimeKey) => string): Record<string, unknown>[] {
	return changed.map((key) => {
		const def = SETTINGS.find((d) => d.key === key);
		const from = before(key);
		const to = after(key);
		if (def?.kind === "secret") return { key, from: from ? "set" : "not set", to: to ? "set" : "not set", source: source(key) };
		if (Array.isArray(from) && Array.isArray(to)) {
			const was = new Set(from.map(String));
			const now = new Set(to.map(String));
			return { key, added: to.filter((v) => !was.has(String(v))), removed: from.filter((v) => !now.has(String(v))), source: source(key) };
		}
		return { key, from, to, source: source(key) };
	});
}

interface Row {
	id: number;
	at: number;
	actor: string;
	actor_kind: string;
	user_id: number | null;
	role: string;
	via: string;
	ip: string;
	action: string;
	outcome: string;
	status: number | null;
	details: string | null;
}

export class AuditLog {
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private readonly maxRows: number;
	private readonly anonymousPerMinute: number;
	private minute = -1;
	private anonymous = 0;
	private suppressed = 0;
	private lastPrune = 0;
	readonly counters = { recorded: 0, suppressed: 0, failed: 0, pruned: 0 };

	private constructor(
		private readonly db: FleetDb,
		private readonly options: AuditOptions,
	) {
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
		this.maxRows = options.maxRows ?? AUDIT_MAX_ROWS;
		this.anonymousPerMinute = options.anonymousPerMinute ?? AUDIT_ANONYMOUS_PER_MINUTE;
	}

	static async open(db: FleetDb, options: AuditOptions): Promise<AuditLog> {
		await db.exec(SCHEMA);
		return new AuditLog(db, options);
	}

	/** Writes one entry. Never throws: a failed write is logged (the action itself already happened). */
	async record(input: AuditInput): Promise<void> {
		const now = this.clock();
		const minute = Math.floor(now / 60_000);
		if (minute !== this.minute) {
			const dropped = this.suppressed;
			this.minute = minute;
			this.anonymous = 0;
			this.suppressed = 0;
			if (dropped) await this.insert(now, { actor: { kind: "system", label: "server" }, role: "none", via: "none", ip: "", action: "audit.suppressed", outcome: "ok", details: { entries: dropped, reason: `more than ${this.anonymousPerMinute} entries without a signed-in caller in a minute` } });
		}
		if (input.actor.kind === "anonymous" || input.actor.kind === "roblox-webhook") {
			if (++this.anonymous > this.anonymousPerMinute) {
				this.suppressed++;
				this.counters.suppressed++;
				return;
			}
		}
		await this.insert(now, input);
	}

	private async insert(at: number, input: AuditInput): Promise<void> {
		let details: string | null = null;
		if (input.details && Object.keys(input.details).length) {
			details = JSON.stringify(redact(input.details, this.options.secrets()));
			if (details.length > AUDIT_DETAILS_MAX) details = JSON.stringify({ truncated: true, keys: Object.keys(input.details).slice(0, 20) });
		}
		const secrets = this.options.secrets();
		const text = (v: string, max: number) => String(redact(v, secrets)).slice(0, max);
		try {
			await this.db.run("INSERT INTO audit_log (at, actor, actor_kind, user_id, role, via, ip, action, outcome, status, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
				at,
				text(input.actor.label, 120),
				input.actor.kind,
				input.actor.userId ?? null,
				input.role,
				input.via,
				text(input.ip, 64),
				text(input.action, 80),
				input.outcome,
				input.status ?? null,
				details,
			]);
			this.counters.recorded++;
		} catch (error) {
			this.counters.failed++;
			this.log(`audit log: could not write an entry (${(error as Error).message.slice(0, 120)})`);
		}
	}

	/** Newest first, `limit` at most (AUDIT_PAGE_MAX), filtered; `next` is the `before` of the next page. */
	async list(q: AuditQuery = {}): Promise<{ entries: AuditEntry[]; next: number | null }> {
		const where: string[] = [];
		const params: SqlValue[] = [];
		if (q.actor !== undefined) (where.push("actor = ?"), params.push(q.actor));
		if (q.action !== undefined) {
			if (q.action.endsWith("*")) {
				where.push("action >= ? AND action < ?");
				const prefix = q.action.slice(0, -1);
				params.push(prefix, `${prefix}￿`);
			} else (where.push("action = ?"), params.push(q.action));
		}
		if (q.outcome !== undefined) (where.push("outcome = ?"), params.push(q.outcome));
		if (q.since !== undefined) (where.push("at >= ?"), params.push(q.since));
		if (q.until !== undefined) (where.push("at < ?"), params.push(q.until));
		if (q.before !== undefined) (where.push("id < ?"), params.push(q.before));
		const limit = Math.min(AUDIT_PAGE_MAX, Math.max(1, q.limit ?? 100));
		const rows = await this.db.all<Row>(`SELECT * FROM audit_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, [...params, limit + 1]);
		const page = rows.slice(0, limit);
		return { entries: page.map(toEntry), next: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
	}

	/** The actors and actions there are entries for (the page's filters), most entries first, 100 of each at most. */
	async facets(): Promise<{ actors: { actor: string; kind: string; entries: number }[]; actions: { action: string; entries: number }[] }> {
		const actors = await this.db.all<{ actor: string; kind: string; n: number }>("SELECT actor, MIN(actor_kind) AS kind, COUNT(*) AS n FROM audit_log GROUP BY actor ORDER BY n DESC LIMIT 100");
		const actions = await this.db.all<{ action: string; n: number }>("SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 100");
		return { actors: actors.map((a) => ({ actor: a.actor, kind: a.kind, entries: Number(a.n) })), actions: actions.map((a) => ({ action: a.action, entries: Number(a.n) })) };
	}

	/** Drops entries past the retention and past MAX_ROWS (at most hourly unless `force`). Returns rows removed. */
	async prune(force = false): Promise<number> {
		const now = this.clock();
		if (!force && now - this.lastPrune < 3_600_000) return 0;
		this.lastPrune = now;
		let removed = (await this.db.run("DELETE FROM audit_log WHERE at < ?", [now - this.options.keepDays() * DAY])).changes;
		const top = await this.db.first<{ id: number | null }>("SELECT MAX(id) AS id FROM audit_log");
		if (top?.id) removed += (await this.db.run("DELETE FROM audit_log WHERE id <= ?", [top.id - this.maxRows])).changes;
		this.counters.pruned += removed;
		return removed;
	}

	async count(): Promise<number> {
		return Number((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log"))?.n ?? 0);
	}
}

function toEntry(r: Row): AuditEntry {
	let details: Record<string, unknown> | null = null;
	if (r.details) {
		try {
			details = JSON.parse(r.details) as Record<string, unknown>;
		} catch {
			details = null;
		}
	}
	return {
		id: Number(r.id),
		at: new Date(Number(r.at)).toISOString(),
		actor: r.actor,
		actorKind: r.actor_kind as AuditActorKind,
		userId: r.user_id === null ? null : Number(r.user_id),
		role: r.role as AuditRole,
		via: r.via as AuditVia,
		ip: r.ip,
		action: r.action,
		outcome: r.outcome as AuditOutcome,
		status: r.status === null ? null : Number(r.status),
		details,
	};
}
