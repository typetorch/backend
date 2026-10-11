/**
 * Error logs in the backend's SQLite file: one row per error kind (fingerprint: template, first and last seen, one sample
 * stack), counts per minute (by branch, build and realm) and the analytics ids (`pid`) affected per day. Bounded: at most
 * `maxKinds` kinds (more are dropped and counted), a few new kinds per sender per hour, 2,000 pids per kind and day, a
 * daily budget of new rows, counts older than `keepDays` are pruned. Batches are stored one at a time, each in one
 * transaction, behind a bounded queue (full = 429), so a flood can't hold the event loop.
 */
import type { FleetDb, SqlValue, SyncTx } from "../fleet/db.ts";
import { ERROR_LIMITS, type ErrorBatch, type ErrorItem } from "./parse.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
export const PIDS_PER_KIND_DAY = 2000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS error_kinds (
	fp TEXT PRIMARY KEY, template TEXT NOT NULL, stack TEXT, realm TEXT NOT NULL,
	first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, total INTEGER NOT NULL DEFAULT 0, last_branch TEXT, last_build TEXT);
CREATE INDEX IF NOT EXISTS error_kinds_last ON error_kinds (last_at);
CREATE TABLE IF NOT EXISTS error_counts (
	fp TEXT NOT NULL, minute INTEGER NOT NULL, branch TEXT NOT NULL, build TEXT NOT NULL, realm TEXT NOT NULL, n INTEGER NOT NULL,
	PRIMARY KEY (fp, minute, branch, build, realm)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS error_counts_minute ON error_counts (minute);
CREATE TABLE IF NOT EXISTS error_pids (
	fp TEXT NOT NULL, day INTEGER NOT NULL, realm TEXT NOT NULL, branch TEXT NOT NULL, build TEXT NOT NULL, pid TEXT NOT NULL,
	PRIMARY KEY (fp, day, realm, branch, build, pid)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS error_pids_day ON error_pids (day);
`;

export interface ErrorWindow {
	/** Unix ms, inclusive start and exclusive end. */
	from: number;
	to: number;
	bucketSeconds: number;
}

export interface ErrorFilter {
	branch?: string;
	build?: string;
	realm?: "server" | "client";
}

export interface ErrorKindSummary {
	fp: string;
	template: string;
	/** First line of the sample stack. */
	topFrame: string | null;
	realm: string;
	/** Occurrences inside the window. */
	count: number;
	/** Analytics ids affected inside the window (days touched). */
	players: number;
	firstAt: string;
	lastAt: string;
	/** All-time occurrences. */
	total: number;
	/** Counts per bucket across the window (oldest first). */
	spark: number[];
}

export interface ErrorList {
	window: { from: string; to: string; bucketSeconds: number; buckets: number };
	kinds: ErrorKindSummary[];
	totals: { count: number; kinds: number; players: number };
	/** Kinds that exist but didn't fit the `limit`. */
	more: number;
	/**
	 * Builds (artifact ids) with errors in the window under the other filters (the build filter itself is ignored, so the
	 * choice stays listed), most recently seen first, at most ERROR_BUILDS_LISTED. "(unknown)" is the empty build.
	 */
	builds: { build: string; n: number; lastAt: string }[];
}

export interface ErrorDetail {
	kind: { fp: string; template: string; stack: string | null; realm: string; firstAt: string; lastAt: string; total: number };
	window: { from: string; to: string; bucketSeconds: number; buckets: number };
	count: number;
	players: number;
	series: { t: string; n: number }[];
	byBuild: { build: string; n: number }[];
	byBranch: { branch: string; n: number }[];
	byRealm: { realm: string; n: number }[];
}

/** Players listed for one kind at most (GET /v1/errors/<fp>/players). */
export const ERROR_PLAYERS_MAX = 200;

export interface ErrorPlayer {
	/** The pseudonymous analytics id. */
	pid: string;
	/**
	 * Occurrences in the reports that named this player. A report is one minute of one kind on one server, so when several
	 * players hit a kind in the same minute each of them is counted with the whole report (an upper bound).
	 */
	count: number;
	/** Days (UTC) the player hit it in the window. */
	days: number;
	firstAt: string;
	lastAt: string;
	/** "server" and/or "client": where the reports naming them came from. */
	realms: string[];
}

export interface ErrorPlayers {
	fp: string;
	window: { from: string; to: string };
	/** Most occurrences first, then the most recently seen; at most `limit`. */
	players: ErrorPlayer[];
	/** Players in the window (the same day-based count as the kind's `players`). */
	total: number;
	/** Players past the limit. */
	more: number;
	/** Occurrences in reports that named no player, per side (server errors about nobody, clients without an analytics id). */
	withoutPlayer: { realm: string; count: number; firstAt: string; lastAt: string }[];
}

export interface ErrorStats {
	kinds: number;
	batches: number;
	items: number;
	occurrences: number;
	/** Items not stored because the kind table was full. */
	droppedKinds: number;
	/** Items for a new kind not stored because their sender (JobId or address) used its new-kind quota for the hour. */
	droppedQuota: number;
	/** New count and player rows not stored because the day's row budget was spent. */
	droppedRows: number;
	/** New rows written today (UTC) and the budget. */
	rowsToday: number;
	rowsPerDay: number;
	/** Batches waiting for the store, and batches refused (429) because the queue was full. */
	queued: number;
	refusedFull: number;
}

interface KindRow {
	fp: string;
	template: string;
	stack: string | null;
	realm: string;
	first_at: number;
	last_at: number;
	total: number;
	last_branch: string | null;
	last_build: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Picks a bucket size: at most 72 buckets of a size from a short list (1 h -> 1 min, 6 h -> 5 min, 24 h -> 30 min, 7 d -> 6 h,
 * 30 d -> 12 h), or the caller's.
 */
export function chooseBucket(spanMs: number, requestedSeconds?: number): number {
	if (requestedSeconds !== undefined) {
		const s = Math.max(60, Math.round(requestedSeconds / 60) * 60);
		return Math.max(s, Math.ceil(spanMs / 500 / MINUTE) * 60);
	}
	for (const s of [60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400]) if (spanMs / (s * 1000) <= 72) return s;
	return 86400;
}

/** Counts spread over the minutes an item covers (evenly, the remainder in the last minute), or all in the last one. */
export function spreadCount(count: number, firstAt: number, lastAt: number): { minute: number; n: number }[] {
	const last = Math.floor(lastAt / MINUTE);
	const first = Math.floor(firstAt / MINUTE);
	if (lastAt - firstAt > ERROR_LIMITS.spreadMs || first >= last) return [{ minute: last, n: count }];
	const minutes = last - first + 1;
	const each = Math.floor(count / minutes);
	const out: { minute: number; n: number }[] = [];
	for (let m = first; m <= last; m++) {
		const n = m === last ? count - each * (minutes - 1) : each;
		if (n > 0) out.push({ minute: m, n });
	}
	return out;
}

/** Builds listed with an error list (the explorer's artifact filter). */
export const ERROR_BUILDS_LISTED = 50;

/** New kinds one sender may add per clock hour: per JobId, and per address (JobIds are made up freely). */
export const NEW_KINDS_PER_JOB_HOUR = 50;
export const NEW_KINDS_PER_IP_HOUR = 200;
/** Batches waiting for the store; past this POST /v1/errors answers 429. */
export const ERROR_QUEUE_MAX = 64;
/** New error_counts + error_pids rows per UTC day (TYPETORCH_ERROR_ROWS_PER_DAY); past it new rows are dropped and counted. */
export const ERROR_ROWS_PER_DAY = 2_000_000;

/** The store's queue is full: answer 429. */
export class ErrorQueueFull extends Error {
	override name = "ErrorQueueFull";
}

/** Uses per key within the current clock hour; bounded memory (the map is cleared every hour and capped). */
class HourQuota {
	private window = -1;
	private readonly used = new Map<string, number>();

	constructor(
		readonly limit: number,
		private readonly clock: () => number,
	) {}

	private roll(): void {
		const w = Math.floor(this.clock() / 3_600_000);
		if (w !== this.window) {
			this.window = w;
			this.used.clear();
		}
	}

	left(key: string): number {
		this.roll();
		return this.limit - (this.used.get(key) ?? 0);
	}

	use(key: string): void {
		this.roll();
		this.used.set(key, (this.used.get(key) ?? 0) + 1);
		if (this.used.size > 100_000) this.used.delete(this.used.keys().next().value as string);
	}
}

/** A number, or a function read on every use (a runtime setting from the explorer's Settings page). */
export type LiveNumber = number | (() => number);

export interface ErrorStoreOptions {
	clock: () => number;
	keepDays: LiveNumber;
	maxKinds: LiveNumber;
	rowsPerDay: LiveNumber;
	newKindsPerJobHour: number;
	newKindsPerIpHour: number;
	maxQueue: number;
}

const live = (value: LiveNumber): (() => number) => (typeof value === "function" ? value : () => value);

const yieldTurn = () => new Promise<void>((done) => setImmediate(done));

export class ErrorStore {
	private kindCount = 0;
	private readonly counters: ErrorStats = { kinds: 0, batches: 0, items: 0, occurrences: 0, droppedKinds: 0, droppedQuota: 0, droppedRows: 0, rowsToday: 0, rowsPerDay: 0, queued: 0, refusedFull: 0 };
	private lastPrune = 0;
	private rowDay = -1;
	private readonly jobQuota: HourQuota;
	private readonly ipQuota: HourQuota;
	private readonly keepDays: () => number;
	private readonly maxKinds: () => number;
	private readonly rowsPerDay: () => number;
	/** Batches are stored one at a time, each in one transaction, with a turn of the event loop between them. */
	private chain: Promise<void> = Promise.resolve();
	private waiting = 0;

	private constructor(
		private readonly db: FleetDb,
		private readonly options: ErrorStoreOptions,
	) {
		this.jobQuota = new HourQuota(options.newKindsPerJobHour, options.clock);
		this.ipQuota = new HourQuota(options.newKindsPerIpHour, options.clock);
		this.keepDays = live(options.keepDays);
		this.maxKinds = live(options.maxKinds);
		this.rowsPerDay = live(options.rowsPerDay);
	}

	/** Counters for /healthz (rowsPerDay is the current budget). */
	get stats(): ErrorStats {
		this.counters.rowsPerDay = this.rowsPerDay();
		return this.counters;
	}

	static async open(db: FleetDb, options: Partial<ErrorStoreOptions> = {}): Promise<ErrorStore> {
		await db.exec(SCHEMA);
		// sample_at: when the sample (template, stack) was last replaced (added after the first release).
		const columns = await db.all<{ name: string }>("PRAGMA table_info(error_kinds)");
		if (!columns.some((c) => c.name === "sample_at")) await db.exec("ALTER TABLE error_kinds ADD COLUMN sample_at INTEGER");
		// Per player (added for the error -> players list): occurrences in the reports that named them, and when (unix ms).
		// Rows written before have NULLs: they count as one occurrence somewhere in their day.
		const pidColumns = new Set((await db.all<{ name: string }>("PRAGMA table_info(error_pids)")).map((c) => c.name));
		for (const column of ["n", "first_at", "last_at"]) if (!pidColumns.has(column)) await db.exec(`ALTER TABLE error_pids ADD COLUMN ${column} INTEGER`);
		// Occurrences in reports that named no player (server errors about nobody, clients without an analytics id yet).
		const countColumns = await db.all<{ name: string }>("PRAGMA table_info(error_counts)");
		if (!countColumns.some((c) => c.name === "anon")) await db.exec("ALTER TABLE error_counts ADD COLUMN anon INTEGER NOT NULL DEFAULT 0");
		const store = new ErrorStore(db, {
			clock: options.clock ?? Date.now,
			keepDays: options.keepDays ?? 30,
			maxKinds: options.maxKinds ?? 5000,
			rowsPerDay: options.rowsPerDay ?? ERROR_ROWS_PER_DAY,
			newKindsPerJobHour: options.newKindsPerJobHour ?? NEW_KINDS_PER_JOB_HOUR,
			newKindsPerIpHour: options.newKindsPerIpHour ?? NEW_KINDS_PER_IP_HOUR,
			maxQueue: options.maxQueue ?? ERROR_QUEUE_MAX,
		});
		store.kindCount = Number((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM error_kinds"))?.n ?? 0);
		store.counters.kinds = store.kindCount;
		return store;
	}

	/** Whether a new batch would be refused (429) right now. */
	get full(): boolean {
		return this.waiting >= this.options.maxQueue;
	}

	/**
	 * Stores a validated batch from `sender` (its address; the JobId is `batch.job`). Batches queue up (at most
	 * `maxQueue`, else ErrorQueueFull) and are stored one at a time, each in one transaction.
	 */
	async record(batch: ErrorBatch, sender: { ip?: string } = {}): Promise<{ stored: number; droppedKinds: number }> {
		if (this.full) {
			this.counters.refusedFull++;
			throw new ErrorQueueFull("the error store is busy");
		}
		this.waiting++;
		this.counters.queued = this.waiting;
		const run = this.chain.then(() => this.store(batch, sender.ip ?? ""));
		this.chain = run.then(yieldTurn, yieldTurn);
		try {
			return await run;
		} finally {
			this.waiting--;
			this.counters.queued = this.waiting;
		}
	}

	/** Room left in today's row budget (the count starts again at UTC midnight). */
	private rowRoom(): number {
		const day = Math.floor(this.options.clock() / DAY);
		if (day !== this.rowDay) {
			this.rowDay = day;
			this.counters.rowsToday = 0;
		}
		return this.rowsPerDay() - this.counters.rowsToday;
	}

	private async store(batch: ErrorBatch, ip: string): Promise<{ stored: number; droppedKinds: number }> {
		const result = await this.db.transaction((tx) => {
			let stored = 0;
			let droppedKinds = 0;
			for (const item of batch.items) {
				if (this.recordItem(tx, item, batch.job, ip)) stored++;
				else droppedKinds++;
			}
			return { stored, droppedKinds };
		});
		this.counters.batches++;
		this.counters.items += result.stored;
		return result;
	}

	private recordItem(tx: SyncTx, item: ErrorItem, job: string, ip: string): boolean {
		const existing = tx.first<{ last_at: number; sample_at: number | null }>("SELECT last_at, sample_at FROM error_kinds WHERE fp = ?", [item.fp]);
		const branch = item.branch ?? "";
		const build = item.build ?? "";
		if (!existing) {
			if (this.kindCount >= this.maxKinds()) {
				this.counters.droppedKinds++;
				return false;
			}
			// One sender can't fill the kind table: a few new kinds an hour per JobId and per address.
			if (this.jobQuota.left(job) <= 0 || this.ipQuota.left(ip) <= 0) {
				this.counters.droppedQuota++;
				return false;
			}
			tx.run(
				"INSERT INTO error_kinds (fp, template, stack, realm, first_at, last_at, total, last_branch, last_build, sample_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[item.fp, item.template, item.stack, item.realm, item.firstAt, item.lastAt, item.count, item.branch, item.build, item.lastAt],
			);
			this.jobQuota.use(job);
			this.ipQuota.use(ip);
			this.kindCount++;
			this.counters.kinds = this.kindCount;
		} else {
			const newest = item.lastAt >= existing.last_at;
			// The sample follows the newest report (the stack only when the item has one), so text that one key holder sent
			// first doesn't stay: the next report replaces it.
			const fresh = item.lastAt >= Number(existing.sample_at ?? 0);
			const sets = ["first_at = MIN(first_at, ?)", "last_at = MAX(last_at, ?)", "total = total + ?"];
			const params: SqlValue[] = [item.firstAt, item.lastAt, item.count];
			if (newest) {
				sets.push("last_branch = ?", "last_build = ?");
				params.push(item.branch, item.build);
			}
			if (fresh) {
				sets.push("template = ?", "sample_at = ?");
				params.push(item.template, item.lastAt);
				if (item.stack) {
					sets.push("stack = ?");
					params.push(item.stack);
				}
			}
			tx.run(`UPDATE error_kinds SET ${sets.join(", ")} WHERE fp = ?`, [...params, item.fp]);
		}
		this.counters.occurrences += item.count;
		// New rows count against the day's budget; adding to a row that exists is free.
		const anonymous = item.pids.length === 0;
		for (const { minute, n } of spreadCount(item.count, item.firstAt, item.lastAt)) {
			const key: SqlValue[] = [item.fp, minute, branch, build, item.realm];
			const anon = anonymous ? n : 0;
			if (tx.run("UPDATE error_counts SET n = n + ?, anon = anon + ? WHERE fp = ? AND minute = ? AND branch = ? AND build = ? AND realm = ?", [n, anon, ...key]).changes) continue;
			if (this.rowRoom() <= 0) {
				this.counters.droppedRows++;
				continue;
			}
			tx.run("INSERT INTO error_counts (fp, minute, branch, build, realm, n, anon) VALUES (?, ?, ?, ?, ?, ?, ?)", [...key, n, anon]);
			this.counters.rowsToday++;
		}
		if (item.pids.length) {
			const day = Math.floor(item.lastAt / DAY);
			const held = Number(tx.first<{ n: number }>("SELECT COUNT(*) AS n FROM error_pids WHERE fp = ? AND day = ?", [item.fp, day])?.n ?? 0);
			let room = PIDS_PER_KIND_DAY - held;
			for (const pid of item.pids) {
				// A player's row that exists counts up (free); a new one needs room for the kind's day and the row budget.
				const key: SqlValue[] = [item.fp, day, item.realm, branch, build, pid];
				const added = tx.run(
					"UPDATE error_pids SET n = COALESCE(n, 1) + ?, first_at = MIN(COALESCE(first_at, ?), ?), last_at = MAX(COALESCE(last_at, ?), ?) " +
						"WHERE fp = ? AND day = ? AND realm = ? AND branch = ? AND build = ? AND pid = ?",
					[item.count, item.firstAt, item.firstAt, item.lastAt, item.lastAt, ...key],
				).changes;
				if (added) continue;
				if (room <= 0) continue;
				if (this.rowRoom() <= 0) {
					this.counters.droppedRows++;
					break;
				}
				tx.run("INSERT INTO error_pids (fp, day, realm, branch, build, pid, n, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [...key, item.count, item.firstAt, item.lastAt]);
				room--;
				this.counters.rowsToday++;
			}
		}
		return true;
	}

	/** Drops counts and players older than the keep window, and kinds not seen since (hourly is plenty). */
	async prune(): Promise<number> {
		const now = this.options.clock();
		if (now - this.lastPrune < 3_600_000) return 0;
		this.lastPrune = now;
		const cutoff = now - this.keepDays() * DAY;
		let removed = 0;
		removed += (await this.db.run("DELETE FROM error_counts WHERE minute < ?", [Math.floor(cutoff / MINUTE)])).changes;
		removed += (await this.db.run("DELETE FROM error_pids WHERE day < ?", [Math.floor(cutoff / DAY)])).changes;
		const gone = (await this.db.run("DELETE FROM error_kinds WHERE last_at < ?", [cutoff])).changes;
		removed += gone;
		if (gone) {
			this.kindCount = Number((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM error_kinds"))?.n ?? 0);
			this.counters.kinds = this.kindCount;
		}
		return removed;
	}

	private where(filter: ErrorFilter, alias: string): { sql: string; params: SqlValue[] } {
		const parts: string[] = [];
		const params: SqlValue[] = [];
		if (filter.branch !== undefined) (parts.push(`${alias}.branch = ?`), params.push(filter.branch));
		if (filter.build !== undefined) (parts.push(`${alias}.build = ?`), params.push(filter.build));
		if (filter.realm !== undefined) (parts.push(`${alias}.realm = ?`), params.push(filter.realm));
		return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
	}

	private bucketIndex(w: ErrorWindow): { fromMinute: number; toMinute: number; bucketMinutes: number; buckets: number; start: number } {
		const bucketMinutes = Math.max(1, Math.round(w.bucketSeconds / 60));
		const fromMinute = Math.floor(w.from / MINUTE);
		const toMinute = Math.max(fromMinute, Math.ceil(w.to / MINUTE) - 1);
		const start = Math.floor(fromMinute / bucketMinutes);
		const end = Math.floor(toMinute / bucketMinutes);
		return { fromMinute, toMinute, bucketMinutes, buckets: end - start + 1, start };
	}

	/** Error kinds seen inside the window, most frequent first. */
	async list(w: ErrorWindow, filter: ErrorFilter = {}, options: { limit?: number; search?: string } = {}): Promise<ErrorList> {
		const limit = Math.min(Math.max(1, options.limit ?? 100), 500);
		const idx = this.bucketIndex(w);
		const f = this.where(filter, "c");
		const search = options.search?.trim();
		const searchSql = search ? " AND (k.template LIKE ? ESCAPE '\\' OR k.fp = ?)" : "";
		const searchParams: SqlValue[] = search ? [`%${search.replace(/[\\%_]/g, "\\$&")}%`, search] : [];
		const rows = await this.db.all<{ fp: string; n: number; template: string; stack: string | null; realm: string; first_at: number; last_at: number; total: number }>(
			"SELECT k.fp, SUM(c.n) AS n, k.template, k.stack, k.realm, k.first_at, k.last_at, k.total FROM error_counts c JOIN error_kinds k ON k.fp = c.fp " +
				`WHERE c.minute BETWEEN ? AND ?${f.sql}${searchSql} GROUP BY k.fp ORDER BY n DESC, k.last_at DESC LIMIT ?`,
			[idx.fromMinute, idx.toMinute, ...f.params, ...searchParams, limit + 1],
		);
		const shown = rows.slice(0, limit);
		const spark = new Map<string, number[]>();
		const players = new Map<string, number>();
		for (let i = 0; i < shown.length; i += 100) {
			const chunk = shown.slice(i, i + 100).map((r) => r.fp);
			const marks = chunk.map(() => "?").join(", ");
			const series = await this.db.all<{ fp: string; b: number; n: number }>(
				`SELECT c.fp, c.minute / CAST(? AS INTEGER) AS b, SUM(c.n) AS n FROM error_counts c WHERE c.fp IN (${marks}) AND c.minute BETWEEN ? AND ?${f.sql} GROUP BY c.fp, b`,
				[idx.bucketMinutes, ...chunk, idx.fromMinute, idx.toMinute, ...f.params],
			);
			for (const s of series) {
				const arr = spark.get(s.fp) ?? new Array<number>(idx.buckets).fill(0);
				const at = Number(s.b) - idx.start;
				if (at >= 0 && at < idx.buckets) arr[at] = Number(s.n);
				spark.set(s.fp, arr);
			}
			const p = this.where(filter, "p");
			const who = await this.db.all<{ fp: string; n: number }>(
				`SELECT p.fp, COUNT(DISTINCT p.pid) AS n FROM error_pids p WHERE p.fp IN (${marks}) AND p.day BETWEEN ? AND ?${p.sql} GROUP BY p.fp`,
				[...chunk, Math.floor(w.from / DAY), Math.floor((w.to - 1) / DAY), ...p.params],
			);
			for (const r of who) players.set(r.fp, Number(r.n));
		}
		const pf = this.where(filter, "p");
		const totalPlayers = Number(
			(await this.db.first<{ n: number }>(`SELECT COUNT(DISTINCT p.pid) AS n FROM error_pids p WHERE p.day BETWEEN ? AND ?${pf.sql}`, [Math.floor(w.from / DAY), Math.floor((w.to - 1) / DAY), ...pf.params]))?.n ?? 0,
		);
		const totalCount = Number((await this.db.first<{ n: number | null }>(`SELECT SUM(c.n) AS n FROM error_counts c WHERE c.minute BETWEEN ? AND ?${f.sql}`, [idx.fromMinute, idx.toMinute, ...f.params]))?.n ?? 0);
		const kindsInWindow = Number((await this.db.first<{ n: number }>(`SELECT COUNT(DISTINCT c.fp) AS n FROM error_counts c WHERE c.minute BETWEEN ? AND ?${f.sql}`, [idx.fromMinute, idx.toMinute, ...f.params]))?.n ?? 0);
		const { build: _build, ...others } = filter;
		const bf = this.where(others, "c");
		const builds = await this.db.all<{ build: string; n: number; last: number }>(
			`SELECT c.build, SUM(c.n) AS n, MAX(c.minute) AS last FROM error_counts c WHERE c.minute BETWEEN ? AND ?${bf.sql} GROUP BY c.build ORDER BY last DESC, n DESC, c.build LIMIT ?`,
			[idx.fromMinute, idx.toMinute, ...bf.params, ERROR_BUILDS_LISTED],
		);
		return {
			window: { from: iso(w.from), to: iso(w.to), bucketSeconds: idx.bucketMinutes * 60, buckets: idx.buckets },
			kinds: shown.map((r) => ({
				fp: r.fp,
				template: r.template,
				topFrame: r.stack ? (r.stack.split("\n")[0] ?? "").slice(0, 300) || null : null,
				realm: r.realm,
				count: Number(r.n),
				players: players.get(r.fp) ?? 0,
				firstAt: iso(Number(r.first_at)),
				lastAt: iso(Number(r.last_at)),
				total: Number(r.total),
				spark: spark.get(r.fp) ?? new Array<number>(idx.buckets).fill(0),
			})),
			totals: { count: totalCount, kinds: kindsInWindow, players: totalPlayers },
			more: Math.max(0, rows.length - limit),
			builds: builds.map((b) => ({ build: b.build || "(unknown)", n: Number(b.n), lastAt: iso(Number(b.last) * MINUTE) })),
		};
	}

	/**
	 * One kind's players inside the window (by the days their rows cover, like the kind's `players` count), under the same
	 * branch / build / realm filter: most occurrences first, then the most recently seen, at most `limit` (1-200).
	 * Rows written before per-player counts existed count as one occurrence in their day. Undefined: no such kind.
	 */
	async players(fp: string, w: ErrorWindow, filter: ErrorFilter = {}, limit: number = ERROR_PLAYERS_MAX): Promise<ErrorPlayers | undefined> {
		const kind = await this.db.first<{ fp: string }>("SELECT fp FROM error_kinds WHERE fp = ?", [fp]);
		if (!kind) return undefined;
		const cap = Math.min(Math.max(1, Math.floor(limit)), ERROR_PLAYERS_MAX);
		const pf = this.where(filter, "p");
		const days = [Math.floor(w.from / DAY), Math.floor((w.to - 1) / DAY)];
		const rows = await this.db.all<{ pid: string; n: number; days: number; first_at: number; last_at: number; realms: string }>(
			"SELECT p.pid, SUM(COALESCE(p.n, 1)) AS n, COUNT(DISTINCT p.day) AS days, " +
				`MIN(COALESCE(p.first_at, p.day * ${DAY})) AS first_at, MAX(COALESCE(p.last_at, p.day * ${DAY} + ${DAY - 1})) AS last_at, GROUP_CONCAT(DISTINCT p.realm) AS realms ` +
				`FROM error_pids p WHERE p.fp = ? AND p.day BETWEEN ? AND ?${pf.sql} GROUP BY p.pid ORDER BY n DESC, last_at DESC, p.pid LIMIT ?`,
			[fp, ...days, ...pf.params, cap],
		);
		const total = Number((await this.db.first<{ n: number }>(`SELECT COUNT(DISTINCT p.pid) AS n FROM error_pids p WHERE p.fp = ? AND p.day BETWEEN ? AND ?${pf.sql}`, [fp, ...days, ...pf.params]))?.n ?? 0);
		const idx = this.bucketIndex(w);
		const f = this.where(filter, "c");
		const anon = await this.db.all<{ realm: string; n: number; first: number; last: number }>(
			`SELECT c.realm, SUM(c.anon) AS n, MIN(c.minute) AS first, MAX(c.minute) AS last FROM error_counts c WHERE c.fp = ? AND c.anon > 0 AND c.minute BETWEEN ? AND ?${f.sql} GROUP BY c.realm ORDER BY n DESC`,
			[fp, idx.fromMinute, idx.toMinute, ...f.params],
		);
		return {
			fp,
			window: { from: iso(w.from), to: iso(w.to) },
			players: rows.map((r) => ({
				pid: r.pid,
				count: Number(r.n),
				days: Number(r.days),
				firstAt: iso(Number(r.first_at)),
				lastAt: iso(Number(r.last_at)),
				realms: String(r.realms ?? "")
					.split(",")
					.filter(Boolean)
					.sort(),
			})),
			total,
			more: Math.max(0, total - rows.length),
			withoutPlayer: anon.map((r) => ({ realm: r.realm, count: Number(r.n), firstAt: iso(Number(r.first) * MINUTE), lastAt: iso((Number(r.last) + 1) * MINUTE - 1) })),
		};
	}

	/** Right to erasure: the players' rows go (their counts stay, without them). */
	async erasePids(pids: string[]): Promise<number> {
		let removed = 0;
		for (let i = 0; i < pids.length; i += 200) {
			const chunk = pids.slice(i, i + 200);
			removed += (await this.db.run(`DELETE FROM error_pids WHERE pid IN (${chunk.map(() => "?").join(", ")})`, chunk)).changes;
		}
		return removed;
	}

	/** One kind: its sample stack, the window's count, players and series, and where it happens. */
	async detail(fp: string, w: ErrorWindow, filter: ErrorFilter = {}): Promise<ErrorDetail | undefined> {
		const kind = await this.db.first<KindRow>("SELECT * FROM error_kinds WHERE fp = ?", [fp]);
		if (!kind) return undefined;
		const idx = this.bucketIndex(w);
		const f = this.where(filter, "c");
		const base = [fp, idx.fromMinute, idx.toMinute, ...f.params];
		const series = new Array<number>(idx.buckets).fill(0);
		const rows = await this.db.all<{ b: number; n: number }>(`SELECT c.minute / CAST(? AS INTEGER) AS b, SUM(c.n) AS n FROM error_counts c WHERE c.fp = ? AND c.minute BETWEEN ? AND ?${f.sql} GROUP BY b`, [idx.bucketMinutes, ...base]);
		let count = 0;
		for (const r of rows) {
			const at = Number(r.b) - idx.start;
			if (at >= 0 && at < idx.buckets) series[at] = Number(r.n);
			count += Number(r.n);
		}
		const group = async (column: "build" | "branch" | "realm") =>
			this.db.all<{ k: string; n: number }>(`SELECT c.${column} AS k, SUM(c.n) AS n FROM error_counts c WHERE c.fp = ? AND c.minute BETWEEN ? AND ?${f.sql} GROUP BY c.${column} ORDER BY n DESC LIMIT 20`, base);
		const pf = this.where(filter, "p");
		const players = Number(
			(await this.db.first<{ n: number }>(`SELECT COUNT(DISTINCT p.pid) AS n FROM error_pids p WHERE p.fp = ? AND p.day BETWEEN ? AND ?${pf.sql}`, [fp, Math.floor(w.from / DAY), Math.floor((w.to - 1) / DAY), ...pf.params]))?.n ?? 0,
		);
		return {
			kind: { fp: kind.fp, template: kind.template, stack: kind.stack, realm: kind.realm, firstAt: iso(Number(kind.first_at)), lastAt: iso(Number(kind.last_at)), total: Number(kind.total) },
			window: { from: iso(w.from), to: iso(w.to), bucketSeconds: idx.bucketMinutes * 60, buckets: idx.buckets },
			count,
			players,
			series: series.map((n, i) => ({ t: iso((idx.start + i) * idx.bucketMinutes * MINUTE), n })),
			byBuild: (await group("build")).map((r) => ({ build: r.k || "(unknown)", n: Number(r.n) })),
			byBranch: (await group("branch")).map((r) => ({ branch: r.k || "(unknown)", n: Number(r.n) })),
			byRealm: (await group("realm")).map((r) => ({ realm: r.k, n: Number(r.n) })),
		};
	}
}
