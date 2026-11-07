/**
 * notify.db (plans/29 "Backend"): the intents, the per-user state, the sends and the pushed config, next to the fleet
 * SQLite file (same wrapper, WAL), plus the durable layer's kv / zset tables in the same file (src/store/durable.ts).
 *
 *   notify_intents (user_id, kind, key) PK   at / until (unix ms), params JSON, data, template, rev, status
 *                                            pending | sent | dropped | expired | superseded, nid (the planned send)
 *   notify_users   user_id PK                online, presence_at, left_at, last_seen, hours JSON (last 20 session-start
 *                                            UTC hours), sent_at, unopened, backoff_at, mute_until, capped_until, optin,
 *                                            optin_at, next_check (the planner skips the user until then), busy (the
 *                                            outstanding send's nid)
 *   notify_sends   nid PK                    user_id, kind, key, rev, template, category, params, data, planned_at,
 *                                            sent_at, status planned | sending | sent | dry | failed | cancelled, http,
 *                                            code, roblox_id, try, opened_at, played_secs, test
 *   notify_config  id = 1                    the pushed `notifications` object, updated_at, by
 *   notify_outbox  id                        backend rows (uid, t, name, props) written in the same transaction as the
 *                                            state change they describe, deleted once published to the events
 *
 * The UserId is player data: it never leaves this file except to Roblox's send API; rows in `events` carry the pid.
 */
import type { FleetDb, SyncTx } from "../fleet/db.ts";
import type { NotifyConfig } from "./config.ts";

export const NOTIFY_SCHEMA = `
CREATE TABLE IF NOT EXISTS notify_intents (user_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER NOT NULL, params TEXT, data TEXT, template TEXT, rev INTEGER NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, nid TEXT, PRIMARY KEY (user_id, kind, key));
CREATE INDEX IF NOT EXISTS notify_intents_due ON notify_intents (status, at);
CREATE INDEX IF NOT EXISTS notify_intents_until ON notify_intents (status, until);
CREATE INDEX IF NOT EXISTS notify_intents_updated ON notify_intents (updated);
CREATE INDEX IF NOT EXISTS notify_intents_user ON notify_intents (user_id, status);
CREATE TABLE IF NOT EXISTS notify_users (user_id INTEGER PRIMARY KEY, online INTEGER NOT NULL DEFAULT 0, presence_at INTEGER NOT NULL DEFAULT 0, left_at INTEGER, last_seen INTEGER, hours TEXT NOT NULL DEFAULT '[]', sent_at INTEGER, unopened INTEGER NOT NULL DEFAULT 0, backoff_at INTEGER, mute_until INTEGER, capped_until INTEGER, optin TEXT, optin_at INTEGER, next_check INTEGER NOT NULL DEFAULT 0, busy TEXT, created INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notify_users_check ON notify_users (next_check);
CREATE INDEX IF NOT EXISTS notify_users_seen ON notify_users (last_seen);
CREATE TABLE IF NOT EXISTS notify_sends (nid TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, template TEXT, category TEXT, params TEXT, data TEXT, planned_at INTEGER NOT NULL, sent_at INTEGER, status TEXT NOT NULL, http INTEGER, code TEXT, roblox_id TEXT, try INTEGER NOT NULL DEFAULT 0, opened_at INTEGER, played_secs INTEGER, test INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notify_sends_user ON notify_sends (user_id, created);
CREATE INDEX IF NOT EXISTS notify_sends_status ON notify_sends (status, updated);
CREATE INDEX IF NOT EXISTS notify_sends_created ON notify_sends (created);
CREATE TABLE IF NOT EXISTS notify_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, t INTEGER NOT NULL, name TEXT NOT NULL, props TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notify_outbox_uid ON notify_outbox (uid);
CREATE TABLE IF NOT EXISTS notify_config (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL, updated_at INTEGER NOT NULL, by TEXT NOT NULL);
`;

export const DUE_SET = "notify:due";
/** Session-start hours kept per user (the preferred hour is their mode). */
export const HOURS_KEPT = 20;
/** Sends kept, finished intents kept (prune). */
export const SENDS_KEEP_MS = 120 * 86_400_000;
export const INTENTS_KEEP_MS = 30 * 86_400_000;
/** Pending intents the backend holds at most (a leaked game key can't fill the disk). */
export const PENDING_MAX = 2_000_000;
/** notify_users rows unseen this long, with nothing pending or outstanding, are pruned. */
export const USERS_KEEP_MS = 180 * 86_400_000;
/** Rows waiting in the outbox at most (the oldest go past it, counted). */
export const OUTBOX_MAX = 200_000;
/** Presence `at` under this is unix seconds (older senders); at or over it, unix ms. */
export const SECONDS_BELOW = 1e11;

/** A backend row waiting for the events table: the UserId stays in notify.db, the pid is looked up at publish. */
export interface OutRow {
	uid: number;
	name: string;
	props: Record<string, unknown>;
}

/** `failed`: Roblox refused it for good (a 400 other than not-opted-in, ...): never planned again. */
export type IntentStatus = "pending" | "sent" | "dropped" | "expired" | "superseded" | "failed";
export type SendStatus = "planned" | "sending" | "sent" | "dry" | "failed" | "cancelled";

export interface IntentRow {
	user_id: number;
	kind: string;
	key: string;
	at: number;
	until: number;
	params: string | null;
	data: string | null;
	template: string | null;
	rev: number;
	status: IntentStatus;
	updated: number;
	nid: string | null;
}

export interface UserRow {
	user_id: number;
	online: number;
	presence_at: number;
	left_at: number | null;
	last_seen: number | null;
	hours: string;
	sent_at: number | null;
	unopened: number;
	backoff_at: number | null;
	mute_until: number | null;
	capped_until: number | null;
	optin: string | null;
	optin_at: number | null;
	next_check: number;
	busy: string | null;
}

export interface SendRow {
	nid: string;
	user_id: number;
	kind: string;
	key: string;
	rev: number;
	template: string | null;
	category: string | null;
	params: string | null;
	data: string | null;
	planned_at: number;
	sent_at: number | null;
	status: SendStatus;
	http: number | null;
	code: string | null;
	roblox_id: string | null;
	try: number;
	opened_at: number | null;
	played_secs: number | null;
	test: number;
	created: number;
	updated: number;
}

/** One intent item, checked (routes.ts). Times unix ms. */
export type IntentOp =
	| { op: "want"; u: number; k: string; key: string; at: number; until: number; params: Record<string, string> | null; data: string | null; template: string | null; rev: number }
	| { op: "drop"; u: number; k: string; key: string | null; why: string | null; rev: number }
	| { op: "presence"; u: number; online: boolean; at: number; staleMs: number };

export interface ApplyOptions {
	quietMs: number;
	/** A kind's priority number (lower wins), for cancelling a still-planned lower-priority send. */
	priority(kind: string): number | undefined;
}

export interface ApplyResult {
	accepted: number;
	stale: number;
	/** Planned sends cancelled by a drop or a newer want (their zset members are removed already). */
	cancelled: { nid: string; userId: number; kind: string; dropped: boolean }[];
}

const num = (v: unknown): number => Number(v ?? 0);

export class NotifyStore {
	private configCache: { config: NotifyConfig; updatedAt: number; by: string } | null | undefined;
	private pendingCache: { at: number; n: number } | undefined;
	/** Rows dropped because the outbox was full (status shows it). */
	outboxDropped = 0;

	private constructor(
		readonly db: FleetDb,
		private readonly clock: () => number,
	) {}

	static async open(db: FleetDb, clock: () => number = Date.now): Promise<NotifyStore> {
		await db.exec(NOTIFY_SCHEMA);
		return new NotifyStore(db, clock);
	}

	// Config ----------------------------------------------------------------------------------------------------------

	async config(): Promise<{ config: NotifyConfig; updatedAt: number; by: string } | null> {
		if (this.configCache !== undefined) return this.configCache;
		const row = await this.db.first<{ config: string; updated_at: number; by: string }>("SELECT config, updated_at, by FROM notify_config WHERE id = 1");
		this.configCache = row ? { config: JSON.parse(row.config) as NotifyConfig, updatedAt: num(row.updated_at), by: row.by } : null;
		return this.configCache;
	}

	async setConfig(config: NotifyConfig, by: string): Promise<void> {
		const at = this.clock();
		await this.db.run("INSERT INTO notify_config (id, config, updated_at, by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, by = excluded.by", [
			JSON.stringify(config),
			at,
			by,
		]);
		this.configCache = { config, updatedAt: at, by };
		// A new config can make kinds plannable again: everyone is looked at on the next tick.
		await this.db.run("UPDATE notify_users SET next_check = 0 WHERE next_check > ?", [at]);
	}

	// Intents ---------------------------------------------------------------------------------------------------------

	/** Pending intents (cached 10 s: the intents route checks it against PENDING_MAX). */
	async pendingCount(): Promise<number> {
		const now = this.clock();
		if (this.pendingCache && now - this.pendingCache.at < 10_000) return this.pendingCache.n;
		const n = num((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM notify_intents WHERE status = 'pending'"))?.n);
		this.pendingCache = { at: now, n };
		return n;
	}

	/** Applies checked items in one transaction (last write wins per (user, kind, key) by `rev`). */
	async apply(items: IntentOp[], o: ApplyOptions): Promise<ApplyResult> {
		const now = this.clock();
		const out: ApplyResult = { accepted: 0, stale: 0, cancelled: [] };
		await this.db.transaction((tx) => {
			for (const item of items) {
				ensureUser(tx, item.u, now);
				if (item.op === "presence") {
					presence(tx, item, now, o.quietMs);
					out.accepted++;
					continue;
				}
				if (item.op === "want") {
					const old = tx.first<{ rev: number; nid: string | null }>("SELECT rev, nid FROM notify_intents WHERE user_id = ? AND kind = ? AND key = ?", [item.u, item.k, item.key]);
					if (old && num(old.rev) >= item.rev) {
						out.stale++;
						continue;
					}
					if (old?.nid) cancelPlanned(tx, old.nid, now, out, false);
					tx.run(
						"INSERT INTO notify_intents (user_id, kind, key, at, until, params, data, template, rev, status, updated, nid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL) " +
							"ON CONFLICT(user_id, kind, key) DO UPDATE SET at = excluded.at, until = excluded.until, params = excluded.params, data = excluded.data, template = excluded.template, rev = excluded.rev, status = 'pending', updated = excluded.updated, nid = NULL",
						[item.u, item.k, item.key, item.at, item.until, item.params ? JSON.stringify(item.params) : null, item.data, item.template, item.rev, now],
					);
					// Someone to look at again soon (a want may beat what held them back).
					tx.run("UPDATE notify_users SET next_check = MIN(next_check, ?) WHERE user_id = ?", [Math.max(now, item.at), item.u]);
					// Priority: a send still planned for later, of a kind this one outranks, is cancelled; the planner decides again.
					const mine = o.priority(item.k);
					const busy = tx.first<{ busy: string | null }>("SELECT busy FROM notify_users WHERE user_id = ?", [item.u])?.busy;
					if (busy && mine !== undefined) {
						const planned = tx.first<{ kind: string; planned_at: number; status: string }>("SELECT kind, planned_at, status FROM notify_sends WHERE nid = ?", [busy]);
						const theirs = planned ? o.priority(planned.kind) : undefined;
						if (planned && planned.status === "planned" && num(planned.planned_at) > now && planned.kind !== item.k && theirs !== undefined && mine < theirs) {
							if (cancelPlanned(tx, busy, now, out, false)) {
								tx.run("UPDATE notify_intents SET nid = NULL WHERE user_id = ? AND nid = ?", [item.u, busy]);
								tx.run("UPDATE notify_users SET next_check = 0 WHERE user_id = ?", [item.u]);
								outbox(tx, [{ uid: item.u, name: "skipped", props: { k: planned.kind, why: "outranked" } }], now);
							}
						}
					}
					out.accepted++;
					continue;
				}
				// drop: one key, or every key of the kind (only rows older than this rev). A missing key leaves a tombstone so
				// an older want arriving later is stale.
				const rows =
					item.key !== null
						? tx.all<{ key: string; rev: number; nid: string | null; status: string }>("SELECT key, rev, nid, status FROM notify_intents WHERE user_id = ? AND kind = ? AND key = ?", [item.u, item.k, item.key])
						: tx.all<{ key: string; rev: number; nid: string | null; status: string }>("SELECT key, rev, nid, status FROM notify_intents WHERE user_id = ? AND kind = ?", [item.u, item.k]);
				if (item.key !== null && !rows.length) {
					tx.run("INSERT INTO notify_intents (user_id, kind, key, at, until, params, data, template, rev, status, updated, nid) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'dropped', ?, NULL)", [item.u, item.k, item.key, now, now, item.rev, now]);
					out.accepted++;
					continue;
				}
				let any = false;
				for (const r of rows) {
					if (num(r.rev) >= item.rev) continue;
					any = true;
					if (r.nid && cancelPlanned(tx, r.nid, now, out, true)) outbox(tx, [{ uid: item.u, name: "skipped", props: { k: item.k, why: "dropped" } }], now);
					tx.run("UPDATE notify_intents SET status = CASE WHEN status = 'pending' THEN 'dropped' ELSE status END, rev = ?, updated = ?, nid = NULL WHERE user_id = ? AND kind = ? AND key = ?", [item.rev, now, item.u, item.k, r.key]);
				}
				if (any || !rows.length) out.accepted++;
				else out.stale++;
			}
		});
		this.pendingCache = undefined;
		return out;
	}

	/** Pending intents whose `until` passed: marked expired (at most `limit` per call). */
	async expire(now: number, limit: number): Promise<{ userId: number; kind: string; nid: string | null }[]> {
		return this.db.transaction((tx) => {
			const rows = tx.all<{ user_id: number; kind: string; nid: string | null }>(
				"UPDATE notify_intents SET status = 'expired', updated = ? WHERE rowid IN (SELECT rowid FROM notify_intents WHERE status = 'pending' AND until <= ? LIMIT ?) RETURNING user_id, kind, nid",
				[now, now, limit],
			);
			outbox(tx, rows.map((r) => ({ uid: num(r.user_id), name: "skipped", props: { k: r.kind, why: "expired" } })), now);
			return rows.map((r) => ({ userId: num(r.user_id), kind: r.kind, nid: r.nid }));
		});
	}

	/** Users with a pending intent whose window opened, no outstanding send, and next_check passed. */
	async candidates(now: number, limit: number): Promise<number[]> {
		const rows = await this.db.all<{ user_id: number }>(
			"SELECT u.user_id AS user_id FROM notify_users u WHERE u.next_check <= ? AND u.busy IS NULL AND EXISTS (SELECT 1 FROM notify_intents i WHERE i.user_id = u.user_id AND i.status = 'pending' AND i.at <= ?) ORDER BY u.next_check, u.user_id LIMIT ?",
			[now, now, limit],
		);
		return rows.map((r) => num(r.user_id));
	}

	async user(userId: number): Promise<UserRow | undefined> {
		return this.db.first<UserRow>("SELECT * FROM notify_users WHERE user_id = ?", [userId]);
	}

	async pendingIntents(userId: number): Promise<IntentRow[]> {
		return this.db.all<IntentRow>("SELECT * FROM notify_intents WHERE user_id = ? AND status = 'pending' ORDER BY kind, key LIMIT 500", [userId]);
	}

	async intent(userId: number, kind: string, key: string): Promise<IntentRow | undefined> {
		return this.db.first<IntentRow>("SELECT * FROM notify_intents WHERE user_id = ? AND kind = ? AND key = ?", [userId, kind, key]);
	}

	/** The user's sends since `since` that went out (sent or dry; test sends too: Roblox counts them). */
	async recentSends(userId: number, since: number): Promise<{ kind: string; key: string; at: number; status: string }[]> {
		const rows = await this.db.all<{ kind: string; key: string; sent_at: number; status: string }>(
			"SELECT kind, key, sent_at, status FROM notify_sends WHERE user_id = ? AND status IN ('sent', 'dry') AND sent_at >= ? ORDER BY sent_at LIMIT 1000",
			[userId, since],
		);
		return rows.map((r) => ({ kind: r.kind, key: r.key, at: num(r.sent_at), status: r.status }));
	}

	/** (kind, key) pairs ever really sent to the user (once_ever / per_key). */
	async sentKeys(userId: number, kinds: string[]): Promise<{ kind: string; key: string }[]> {
		if (!kinds.length) return [];
		return this.db.all<{ kind: string; key: string }>(`SELECT DISTINCT kind, key FROM notify_sends WHERE user_id = ? AND status = 'sent' AND test = 0 AND kind IN (${kinds.map(() => "?").join(", ")}) LIMIT 5000`, [
			userId,
			...kinds,
		]);
	}

	async setNextCheck(userId: number, at: number): Promise<void> {
		await this.db.run("UPDATE notify_users SET next_check = ? WHERE user_id = ?", [Math.round(at), userId]);
	}

	/** The planner's "not now": superseded intents, the next look and the skip rows, in one transaction. */
	async decided(userId: number, o: { nextCheck: number; superseded: { kind: string; key: string }[]; rows: OutRow[] }): Promise<void> {
		const now = this.clock();
		await this.db.transaction((tx) => {
			for (const i of o.superseded) tx.run("UPDATE notify_intents SET status = 'superseded', updated = ?, nid = NULL WHERE user_id = ? AND kind = ? AND key = ? AND status = 'pending'", [now, userId, i.kind, i.key]);
			tx.run("UPDATE notify_users SET next_check = ? WHERE user_id = ?", [Math.round(o.nextCheck), userId]);
			outbox(tx, o.rows, now);
		});
	}

	async markIntents(userId: number, items: { kind: string; key: string }[], status: IntentStatus): Promise<void> {
		const now = this.clock();
		await this.db.transaction((tx) => {
			for (const i of items) tx.run("UPDATE notify_intents SET status = ?, updated = ?, nid = NULL WHERE user_id = ? AND kind = ? AND key = ? AND status = 'pending'", [status, now, userId, i.kind, i.key]);
		});
	}

	/** Writes a planned send, links it to its intent (if any) and the user, in one transaction. */
	async plan(
		send: { nid: string; userId: number; kind: string; key: string; rev: number; template: string | null; category: string; params: string | null; data: string | null; plannedAt: number; test: boolean },
		extra: { rows?: OutRow[]; superseded?: { kind: string; key: string }[] } = {},
	): Promise<void> {
		const now = this.clock();
		await this.db.transaction((tx) => {
			ensureUser(tx, send.userId, now);
			for (const i of extra.superseded ?? []) tx.run("UPDATE notify_intents SET status = 'superseded', updated = ?, nid = NULL WHERE user_id = ? AND kind = ? AND key = ? AND status = 'pending'", [now, send.userId, i.kind, i.key]);
			outbox(tx, extra.rows ?? [], now);
			tx.run(
				"INSERT INTO notify_sends (nid, user_id, kind, key, rev, template, category, params, data, planned_at, status, test, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)",
				[send.nid, send.userId, send.kind, send.key, send.rev, send.template, send.category, send.params, send.data, Math.round(send.plannedAt), send.test ? 1 : 0, now, now],
			);
			if (!send.test) {
				tx.run("UPDATE notify_intents SET nid = ? WHERE user_id = ? AND kind = ? AND key = ?", [send.nid, send.userId, send.kind, send.key]);
				// Busy until the send is over; looked at again right after (the sender clears `busy`).
				tx.run("UPDATE notify_users SET busy = ?, next_check = 0 WHERE user_id = ?", [send.nid, send.userId]);
			}
			tx.run("INSERT INTO zset (name, member, score, lease_until) VALUES (?, ?, ?, 0) ON CONFLICT(name, member) DO UPDATE SET score = excluded.score, lease_until = 0", [DUE_SET, send.nid, Math.round(send.plannedAt)]);
		});
	}

	async send(nid: string): Promise<SendRow | undefined> {
		return this.db.first<SendRow>("SELECT * FROM notify_sends WHERE nid = ?", [nid]);
	}

	/** Marks a send `sending` with its try number (before the POST). */
	async sending(nid: string, attempt: number): Promise<void> {
		await this.db.run("UPDATE notify_sends SET status = 'sending', try = ?, updated = ? WHERE nid = ?", [attempt, this.clock(), nid]);
	}

	/**
	 * A send's last word: its row, the intent, the user (busy cleared; `user` fields set), the zset member removed.
	 * `intent` = the intent's new status (sent), or undefined to leave it pending.
	 */
	async finish(
		nid: string,
		o: { status: SendStatus; http?: number | null; code?: string | null; robloxId?: string | null; sentAt?: number; intent?: IntentStatus; user?: Partial<Pick<UserRow, "mute_until" | "optin" | "optin_at" | "capped_until" | "next_check" | "sent_at">>; unopenedInc?: boolean; backoffAfter?: number; rows?: OutRow[] },
	): Promise<void> {
		const now = this.clock();
		await this.db.transaction((tx) => {
			outbox(tx, o.rows ?? [], now);
			const s = tx.first<{ user_id: number; kind: string; key: string; test: number }>("SELECT user_id, kind, key, test FROM notify_sends WHERE nid = ?", [nid]);
			tx.run("UPDATE notify_sends SET status = ?, http = COALESCE(?, http), code = COALESCE(?, code), roblox_id = COALESCE(?, roblox_id), sent_at = COALESCE(?, sent_at), updated = ? WHERE nid = ?", [
				o.status,
				o.http ?? null,
				o.code ?? null,
				o.robloxId ?? null,
				o.sentAt ?? null,
				now,
				nid,
			]);
			tx.run("DELETE FROM zset WHERE name = ? AND member = ?", [DUE_SET, nid]);
			if (!s) return;
			const uid = num(s.user_id);
			if (!s.test) {
				tx.run("UPDATE notify_intents SET status = COALESCE(?, status), nid = NULL, updated = ? WHERE user_id = ? AND kind = ? AND key = ? AND nid = ?", [o.intent ?? null, now, uid, s.kind, s.key, nid]);
			}
			tx.run("UPDATE notify_users SET busy = NULL WHERE user_id = ? AND busy = ?", [uid, nid]);
			const u = o.user ?? {};
			for (const [field, value] of Object.entries(u)) {
				if (!["mute_until", "optin", "optin_at", "capped_until", "next_check", "sent_at"].includes(field)) continue;
				tx.run(`UPDATE notify_users SET ${field} = ? WHERE user_id = ?`, [value as number | string | null, uid]);
			}
			if (o.unopenedInc) {
				tx.run("UPDATE notify_users SET unopened = unopened + 1 WHERE user_id = ?", [uid]);
				if (o.backoffAfter !== undefined) tx.run("UPDATE notify_users SET backoff_at = ? WHERE user_id = ? AND unopened >= ? AND backoff_at IS NULL", [now, uid, o.backoffAfter]);
			}
		});
	}

	/** Puts a send back in the queue at `at` (a retry), keeping it outstanding. */
	async retryAt(nid: string, at: number, rows: OutRow[] = []): Promise<void> {
		const now = this.clock();
		await this.db.transaction((tx) => {
			outbox(tx, rows, now);
			tx.run("UPDATE notify_sends SET status = 'planned', updated = ? WHERE nid = ?", [now, nid]);
			tx.run("INSERT INTO zset (name, member, score, lease_until) VALUES (?, ?, ?, 0) ON CONFLICT(name, member) DO UPDATE SET score = excluded.score, lease_until = 0", [DUE_SET, nid, Math.round(at)]);
		});
	}

	async userField(userId: number, fields: Partial<Pick<UserRow, "next_check" | "unopened" | "backoff_at">>): Promise<void> {
		for (const [field, value] of Object.entries(fields)) {
			if (!["next_check", "unopened", "backoff_at"].includes(field)) continue;
			await this.db.run(`UPDATE notify_users SET ${field} = ? WHERE user_id = ?`, [value as number | null, userId]);
		}
	}

	// Opens and plays -------------------------------------------------------------------------------------------------

	/** POST /v1/notify/opened: first | repeat | unknown (an unknown nid, or one for another user). */
	async opened(nid: string, userId: number): Promise<{ state: "first" | "repeat" | "unknown"; kind?: string }> {
		const now = this.clock();
		return this.db.transaction((tx) => {
			const s = tx.first<{ user_id: number; opened_at: number | null; kind: string }>("SELECT user_id, opened_at, kind FROM notify_sends WHERE nid = ?", [nid]);
			if (!s || num(s.user_id) !== userId) return { state: "unknown" as const };
			if (s.opened_at !== null) return { state: "repeat" as const, kind: s.kind };
			tx.run("UPDATE notify_sends SET opened_at = ?, updated = ? WHERE nid = ?", [now, now, nid]);
			tx.run("UPDATE notify_users SET unopened = 0, backoff_at = NULL WHERE user_id = ?", [userId]);
			return { state: "first" as const, kind: s.kind };
		});
	}

	async played(nid: string, userId: number, secs: number): Promise<boolean> {
		return (await this.db.run("UPDATE notify_sends SET played_secs = MAX(COALESCE(played_secs, 0), ?), updated = ? WHERE nid = ? AND user_id = ?", [secs, this.clock(), nid, userId])).changes > 0;
	}

	// Status, prune, erasure ------------------------------------------------------------------------------------------

	async pendingByKind(): Promise<Map<string, number>> {
		const rows = await this.db.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM notify_intents WHERE status = 'pending' GROUP BY kind LIMIT 1000");
		return new Map(rows.map((r) => [r.kind, num(r.n)]));
	}

	async sendCounts(since: number): Promise<{ sent: number; failed: number; dry: number }> {
		const rows = await this.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM notify_sends WHERE updated >= ? AND status IN ('sent', 'failed', 'dry') GROUP BY status", [since]);
		const by = new Map(rows.map((r) => [r.status, num(r.n)]));
		return { sent: by.get("sent") ?? 0, failed: by.get("failed") ?? 0, dry: by.get("dry") ?? 0 };
	}

	async mutes(now: number): Promise<number> {
		return num((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM notify_users WHERE mute_until > ?", [now]))?.n);
	}

	async sendingCount(): Promise<number> {
		return num((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM notify_sends WHERE status = 'sending'"))?.n);
	}

	/** Old sends and finished intents (in chunks, so a big prune never holds the loop long). */
	async prune(now: number): Promise<{ sends: number; intents: number; users: number }> {
		let sends = 0;
		let intents = 0;
		let users = 0;
		for (let i = 0; i < 50; i++) {
			const a = (await this.db.run("DELETE FROM notify_sends WHERE rowid IN (SELECT rowid FROM notify_sends WHERE status IN ('sent', 'dry', 'failed', 'cancelled') AND updated < ? LIMIT 2000)", [now - SENDS_KEEP_MS])).changes;
			const b = (await this.db.run("DELETE FROM notify_intents WHERE rowid IN (SELECT rowid FROM notify_intents WHERE status <> 'pending' AND updated < ? LIMIT 2000)", [now - INTENTS_KEEP_MS])).changes;
			// Users unseen for 180 days with nothing pending or outstanding (their consent state goes with them).
			const c = (
				await this.db.run(
					"DELETE FROM notify_users WHERE rowid IN (SELECT u.rowid FROM notify_users u WHERE COALESCE(u.last_seen, u.created) < ? AND u.busy IS NULL AND (u.mute_until IS NULL OR u.mute_until < ?) " +
						"AND NOT EXISTS (SELECT 1 FROM notify_intents i WHERE i.user_id = u.user_id AND i.status = 'pending') LIMIT 2000)",
					[now - USERS_KEEP_MS, now],
				)
			).changes;
			sends += a;
			intents += b;
			users += c;
			if (a < 2000 && b < 2000 && c < 2000) break;
			await new Promise((done) => setTimeout(done, 0));
		}
		return { sends, intents, users };
	}

	// The outbox -----------------------------------------------------------------------------------------------------

	async outboxTake(limit: number): Promise<{ id: number; uid: number; t: number; name: string; props: string }[]> {
		return (await this.db.all<{ id: number; uid: number; t: number; name: string; props: string }>("SELECT id, uid, t, name, props FROM notify_outbox ORDER BY id LIMIT ?", [limit])).map((r) => ({
			...r,
			id: num(r.id),
			uid: num(r.uid),
			t: num(r.t),
		}));
	}

	async outboxDelete(maxId: number): Promise<void> {
		await this.db.run("DELETE FROM notify_outbox WHERE id <= ?", [maxId]);
	}

	async outboxCount(): Promise<number> {
		return num((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM notify_outbox"))?.n);
	}

	/** Keeps the outbox under OUTBOX_MAX (the oldest rows go; counted). */
	async outboxTrim(): Promise<number> {
		const n = await this.outboxCount();
		if (n <= OUTBOX_MAX) return 0;
		const gone = (await this.db.run("DELETE FROM notify_outbox WHERE id IN (SELECT id FROM notify_outbox ORDER BY id LIMIT ?)", [n - OUTBOX_MAX])).changes;
		this.outboxDropped += gone;
		return gone;
	}

	// The per-player view -------------------------------------------------------------------------------------------

	async userSends(userId: number, limit: number): Promise<SendRow[]> {
		return this.db.all<SendRow>("SELECT * FROM notify_sends WHERE user_id = ? ORDER BY created DESC LIMIT ?", [userId, limit]);
	}

	/** The newest sends of everyone (the Notifications page's live table), optionally one kind. */
	async latestSends(limit: number, kind?: string): Promise<SendRow[]> {
		if (kind) return this.db.all<SendRow>("SELECT * FROM notify_sends WHERE kind = ? ORDER BY created DESC LIMIT ?", [kind, limit]);
		return this.db.all<SendRow>("SELECT * FROM notify_sends ORDER BY created DESC LIMIT ?", [limit]);
	}

	async userIntents(userId: number, limit: number): Promise<IntentRow[]> {
		return this.db.all<IntentRow>("SELECT * FROM notify_intents WHERE user_id = ? ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, updated DESC LIMIT ?", [userId, limit]);
	}

	/** Right to erasure: every row of the user in the three tables (and their queued sends). */
	async eraseUser(userId: number): Promise<number> {
		this.pendingCache = undefined;
		return this.db.transaction((tx) => {
			const nids = tx.all<{ nid: string }>("SELECT nid FROM notify_sends WHERE user_id = ?", [userId]);
			for (const { nid } of nids) tx.run("DELETE FROM zset WHERE name = ? AND member = ?", [DUE_SET, nid]);
			let n = tx.run("DELETE FROM notify_sends WHERE user_id = ?", [userId]).changes;
			n += tx.run("DELETE FROM notify_intents WHERE user_id = ?", [userId]).changes;
			n += tx.run("DELETE FROM notify_users WHERE user_id = ?", [userId]).changes;
			n += tx.run("DELETE FROM notify_outbox WHERE uid = ?", [userId]).changes;
			return n;
		});
	}
}

function ensureUser(tx: SyncTx, userId: number, now: number): void {
	tx.run("INSERT INTO notify_users (user_id, created) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING", [userId, now]);
}

/**
 * One presence item (`at` unix ms). Ordered per user by `at`; on a tie online wins (a server hop leaves and joins in the
 * same moment). An `online` older than the stale window counts as offline, so a refresh after it starts a new session.
 */
function presence(tx: SyncTx, item: { u: number; online: boolean; at: number; staleMs: number }, now: number, quietMs: number): void {
	const u = tx.first<{ presence_at: number; hours: string; online: number }>("SELECT presence_at, hours, online FROM notify_users WHERE user_id = ?", [item.u]);
	const last = u ? num(u.presence_at) : 0;
	if (u && (last > item.at || (last === item.at && !item.online && num(u.online)))) return;
	if (item.online) {
		let hours: number[] = [];
		try {
			hours = (JSON.parse(u?.hours ?? "[]") as unknown[]).filter((h): h is number => typeof h === "number");
		} catch {}
		// A session start (not a refresh while online).
		const wasOnline = Boolean(u && num(u.online) && item.at - last < item.staleMs);
		if (!wasOnline) hours = [...hours, new Date(item.at).getUTCHours()].slice(-HOURS_KEPT);
		tx.run("UPDATE notify_users SET online = 1, presence_at = ?, last_seen = ?, hours = ?, next_check = ? WHERE user_id = ?", [item.at, item.at, JSON.stringify(hours), Math.max(now, item.at + item.staleMs), item.u]);
	} else {
		tx.run("UPDATE notify_users SET online = 0, presence_at = ?, left_at = ?, last_seen = ?, next_check = ? WHERE user_id = ?", [item.at, item.at, item.at, item.at + quietMs, item.u]);
	}
}

/** Cancels a send still waiting (not one being sent right now: it finishes, its holder sees the change). */
function cancelPlanned(tx: SyncTx, nid: string, now: number, out: ApplyResult, dropped: boolean): boolean {
	const s = tx.first<{ status: string; user_id: number; kind: string }>("SELECT status, user_id, kind FROM notify_sends WHERE nid = ?", [nid]);
	if (!s || s.status !== "planned") return false;
	const leased = tx.first<{ lease_until: number }>("SELECT lease_until FROM zset WHERE name = ? AND member = ?", [DUE_SET, nid]);
	if (leased && num(leased.lease_until) > now) return false;
	tx.run("UPDATE notify_sends SET status = 'cancelled', updated = ? WHERE nid = ?", [now, nid]);
	tx.run("DELETE FROM zset WHERE name = ? AND member = ?", [DUE_SET, nid]);
	tx.run("UPDATE notify_users SET busy = NULL WHERE user_id = ? AND busy = ?", [s.user_id, nid]);
	out.cancelled.push({ nid, userId: num(s.user_id), kind: s.kind, dropped });
	return true;
}

/** Backend rows into the outbox, inside the caller's transaction. */
export function outbox(tx: SyncTx, rows: OutRow[], now: number): void {
	for (const r of rows) tx.run("INSERT INTO notify_outbox (uid, t, name, props) VALUES (?, ?, ?, ?)", [r.uid, now, r.name, JSON.stringify(r.props)]);
}

/** Whether a user's last `online` presence still holds (not older than the stale window). */
export function isOnline(u: { online: number; presence_at: number } | undefined, now: number, staleMs: number): boolean {
	return Boolean(u && num(u.online) && now - num(u.presence_at) < staleMs);
}
