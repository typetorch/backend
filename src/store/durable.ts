/**
 * A small Redis-like layer on SQLite (plans/29 "Durable store"): key-value with expiry, counters, sorted sets and leases,
 * on the backend's own SQLite wrapper (src/fleet/db.ts: WAL, cached statements). It lives in a file on the data volume,
 * so it survives every deploy; it is the only code here that knows the tables' SQL, so it can move to another database
 * unchanged in shape. One backend process (single-tenant): no locking beyond SQLite's own.
 *
 *   kv(key PK, value, expires_at)                 get / set(ttl) / del / incr(by, ttl); expired rows are ignored on read
 *                                                 and swept by `sweep()` (the app runs it every minute)
 *   zset(name, member, score, lease_until)        zadd / zrangeDue / zrem / lease: due members by score; a lease hides a
 *                                                 member until it runs out, so a crashed worker's members come back
 *
 * Times are unix ms from the injected clock (tests pin it).
 */
import type { FleetDb } from "../fleet/db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS zset (name TEXT NOT NULL, member TEXT NOT NULL, score INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (name, member));
CREATE INDEX IF NOT EXISTS zset_due ON zset (name, score);
`;

/** Keys and members are short strings; values are capped so a bug can't fill the disk through one key. */
export const KEY_MAX = 256;
export const VALUE_MAX = 64 * 1024;
/** Most members one zrangeDue / lease returns. */
export const RANGE_MAX = 10_000;

export interface ZMember {
	member: string;
	score: number;
}

function checkKey(key: string, what = "key"): void {
	if (typeof key !== "string" || key.length === 0 || key.length > KEY_MAX) throw new Error(`durable: ${what} must be 1-${KEY_MAX} characters`);
}

export class Durable {
	private constructor(
		private readonly db: FleetDb,
		private readonly clock: () => number,
	) {}

	static async open(db: FleetDb, clock: () => number = Date.now): Promise<Durable> {
		await db.exec(SCHEMA);
		return new Durable(db, clock);
	}

	// kv -------------------------------------------------------------------------------------------------------------

	async get(key: string): Promise<string | undefined> {
		const row = await this.db.first<{ value: string; expires_at: number | null }>("SELECT value, expires_at FROM kv WHERE key = ?", [key]);
		if (!row || (row.expires_at !== null && Number(row.expires_at) <= this.clock())) return undefined;
		return row.value;
	}

	async getJson<T>(key: string): Promise<T | undefined> {
		const text = await this.get(key);
		if (text === undefined) return undefined;
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	}

	/** Sets a value; `ttlMs` makes it expire (none = kept until deleted). */
	async set(key: string, value: string, ttlMs?: number): Promise<void> {
		checkKey(key);
		if (value.length > VALUE_MAX) throw new Error(`durable: value over ${VALUE_MAX} characters`);
		await this.db.run("INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at", [
			key,
			value,
			ttlMs !== undefined ? this.clock() + Math.max(1, Math.round(ttlMs)) : null,
		]);
	}

	async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
		await this.set(key, JSON.stringify(value), ttlMs);
	}

	async del(key: string): Promise<boolean> {
		return (await this.db.run("DELETE FROM kv WHERE key = ?", [key])).changes > 0;
	}

	/**
	 * Adds `by` to an integer counter and returns the new value. A missing or expired key starts at 0 and gets `ttlMs`
	 * (like Redis INCR + EXPIRE NX: the expiry is set when the counter starts, never pushed back by later increments).
	 */
	async incr(key: string, by = 1, ttlMs?: number): Promise<number> {
		checkKey(key);
		if (!Number.isSafeInteger(by)) throw new Error("durable: incr takes a whole number");
		const now = this.clock();
		const expires = ttlMs !== undefined ? now + Math.max(1, Math.round(ttlMs)) : null;
		return this.db.transaction((tx) => {
			const row = tx.first<{ value: string; expires_at: number | null }>("SELECT value, expires_at FROM kv WHERE key = ?", [key]);
			const live = row && (row.expires_at === null || Number(row.expires_at) > now);
			const before = live ? Number.parseInt(row.value, 10) || 0 : 0;
			const value = before + by;
			tx.run("INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at", [
				key,
				String(value),
				live ? row.expires_at : expires,
			]);
			return value;
		});
	}

	/** Deletes expired keys; returns how many. */
	async sweep(): Promise<number> {
		return (await this.db.run("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?", [this.clock()])).changes;
	}

	// zset -----------------------------------------------------------------------------------------------------------

	/** Adds a member or moves it to a new score; a re-add also ends its lease (it is due again at `score`). */
	async zadd(name: string, member: string, score: number): Promise<void> {
		checkKey(name, "set name");
		checkKey(member, "member");
		await this.db.run("INSERT INTO zset (name, member, score, lease_until) VALUES (?, ?, ?, 0) ON CONFLICT(name, member) DO UPDATE SET score = excluded.score, lease_until = 0", [
			name,
			member,
			Math.round(score),
		]);
	}

	async zrem(name: string, member: string): Promise<boolean> {
		return (await this.db.run("DELETE FROM zset WHERE name = ? AND member = ?", [name, member])).changes > 0;
	}

	async zscore(name: string, member: string): Promise<number | undefined> {
		const row = await this.db.first<{ score: number }>("SELECT score FROM zset WHERE name = ? AND member = ?", [name, member]);
		return row ? Number(row.score) : undefined;
	}

	/** Members with score <= now and no live lease, lowest score first. */
	async zrangeDue(name: string, now: number, limit: number): Promise<ZMember[]> {
		const rows = await this.db.all<{ member: string; score: number }>("SELECT member, score FROM zset WHERE name = ? AND score <= ? AND lease_until <= ? ORDER BY score, member LIMIT ?", [
			name,
			now,
			now,
			Math.max(0, Math.min(RANGE_MAX, Math.floor(limit))),
		]);
		return rows.map((r) => ({ member: r.member, score: Number(r.score) }));
	}

	/** Members (due or not) in a score range, for status counts. */
	async zcount(name: string, min: number, max: number): Promise<number> {
		return Number((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM zset WHERE name = ? AND score >= ? AND score <= ?", [name, min, max]))?.n ?? 0);
	}

	/** Members under a live lease right now. */
	async zleased(name: string, now: number): Promise<number> {
		return Number((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM zset WHERE name = ? AND lease_until > ?", [name, now]))?.n ?? 0);
	}

	/**
	 * Takes up to `limit` due members (score <= now, lease run out) and leases them until now + ttl, in one
	 * `UPDATE ... RETURNING`: two callers can never get the same member, and a worker that dies holding a lease gives its
	 * members back once the lease runs out. The holder ends it with zrem (done) or zadd (due again later).
	 */
	async lease(name: string, now: number, ttlMs: number, limit: number): Promise<ZMember[]> {
		const n = Math.max(0, Math.min(RANGE_MAX, Math.floor(limit)));
		if (!n) return [];
		const rows = await this.db.all<{ member: string; score: number }>(
			"UPDATE zset SET lease_until = ? WHERE rowid IN (SELECT rowid FROM zset WHERE name = ? AND score <= ? AND lease_until <= ? ORDER BY score, member LIMIT ?) RETURNING member, score",
			[now + Math.max(1, Math.round(ttlMs)), name, now, now, n],
		);
		return rows.map((r) => ({ member: r.member, score: Number(r.score) })).sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1));
	}
}
