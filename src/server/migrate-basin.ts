/**
 * Plans/35 B: moving analytics history between Basin and this server, on the migration engine (server/migrate.ts).
 *
 * Basin -> here (`from: { kind: "basin" }`, the R2 SQL token): reads `<namespace>.events` / `.recordings` through the
 * Basin SQL API (store/basin.ts), never DuckDB's iceberg extension (no runtime downloads). Basin SQL is DataFusion with a
 * row cap: every query ends in `LIMIT <= 10,000`, there is no OFFSET, and every query is billed for what it scans (at
 * least 10 MB). So:
 *   - the days come from one per-day count query per table (it reads the `t` column only);
 *   - a day over `windowRows` rows is sliced into time windows (an hour histogram, then a minute one for a big hour), so
 *     each page query scans one window, not the day;
 *   - inside a window, pages go by keyset: ORDER BY t, h where h = md5 of every column (length-prefixed, NULLs marked:
 *     two rows have the same h only when they are the same row), `WHERE t > T OR (t = T AND h >= H)`, skipping the copies
 *     of the last row already taken. Exact duplicate rows are counted, not lost at a page edge, so the rows read add up
 *     to Basin's count exactly; the import drops them anyway (the late-row merge);
 *   - Basin rows have no `rt`: each gets the time this server received it (the import), as the ingest path stamps every
 *     row it takes in. Rows of a day that came twice keep the first (the merge keeps MIN(rt)).
 * Verified per day: the rows read equal Basin's count for the day (counted again at the end: a day that grew since, e.g.
 * rows that rolled into Basin late, is imported again once); every row read is in the day file afterwards (an anti-join
 * of each merged batch, on the contract columns, without erased players); for days before this server's own rows
 * began, the day file holds no more rows than Basin has. Not verified: a hash against Basin (Basin can't compute
 * DuckDB's hash()), nor that exact duplicates in Basin were meant to be there (they collapse here, as they would have
 * on a DuckDB server).
 *
 * Here -> Basin (`to: { kind: "basin" }`, the send token): runs on the server being emptied. Waits until this server has
 * received nothing for `quietMs` (the game's analytics already go to Basin), then sends every day, newest first: a
 * stable snapshot of the day (export.ts snapshotDay: the day file and live rows, erased players left out, exact
 * duplicates collapsed, sorted by every column) is posted as JSON arrays of at most `sendBytes` (4 MB; Basin takes 5 MB)
 * to the events / recordings stream. Basin can't dedupe or delete, so a page is recorded `sending` (with its id) before
 * the POST and `sent` after the 2xx; a page found `sending` (the server stopped mid-send, or no answer came) stops the
 * job in `needs_decision` until the owner resolves it: `resend` (Basin may then hold it twice) or `skip` (its rows may
 * be missing). 429 and 5xx answers are retried (Basin took nothing); 4xx stop the job (nothing taken). Rows that reach
 * this server after their day was sent go in a later part of the day (rows with a newer `rt`). With Basin read settings
 * in the env (config basinRead) the verify step compares per-day counts after Basin's roll delay: `match`, `missing`,
 * `duplicates`; without them a day ends `sent`. Nothing on this server is deleted.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayNumber, dayString, fieldsOf } from "../duckdb/layout.ts";
import type { FleetDb } from "../fleet/db.ts";
import type { FieldSpec } from "../schema.ts";
import { DAY_MS, int } from "../sql/dialect.ts";
import { BASIN_SQL_API, basinErrorOf, basinQueryUrl, parseBasinRows } from "../store/basin.ts";
import { EXPORT_TABLES, localDays, newerRows, newestRt, snapshotDay, snapshotRows, snapshotStat, type ExportTable } from "./export.ts";
import type { DayRow, JobData, MigrationTarget, StepName, StepView } from "./migrate.ts";
import type { Warehouse } from "./warehouse.ts";

export interface BasinReadSettings {
	accountId: string;
	bucket: string;
	/** The Basin SQL token (never logged, never returned). */
	token: string;
	namespace: string;
}

/** Knobs of the Basin directions (tests make them small). */
export interface BasinKnobs {
	/** The SQL API's base URL (tests: a local fake). */
	endpoint?: string;
	/** Rows a SQL page asks for (1-10,000; default 10,000). */
	pageRows?: number;
	/** A day over this many rows is sliced into time windows of about this many (default 50,000). */
	windowRows?: number;
	/** From Basin: how long after the start the job waits for Basin's roll delay before its last count (default 10 min). */
	settleMs?: number;
	/** To Basin: bytes a POST holds at most (default 4 MB; Basin takes 5 MB). */
	sendBytes?: number;
	/** To Basin: rows a POST holds at most (default 10,000). */
	sendRows?: number;
	/** To Basin: how long the counts may lag behind the last send before a day is called missing (default 10 min). */
	rollWaitMs?: number;
	/** To Basin: time between count checks while it waits (default 30 s). */
	rollPollMs?: number;
	/** Per request (default 25 s). */
	timeoutMs?: number;
	/** Tries per request on 429 / 5xx / no connection (default 6). */
	tries?: number;
}

/** What the job lends a Basin flow (server/migrate.ts Migration). */
export interface FlowHost {
	readonly db: FleetDb;
	readonly analytics: boolean;
	readonly clock: () => number;
	readonly log: (line: string) => void;
	readonly job: JobData;
	readonly target: MigrationTarget;
	/** The job's folder (<data dir>/migrate). */
	readonly dir: string;
	readonly fetch: typeof fetch;
	readonly knobs: Required<Omit<BasinKnobs, "endpoint">> & { endpoint: string };
	readonly mergeRows: number;
	readonly quietMs: number;
	readonly pollMs: number;
	/** Basin SQL read settings of this server's env (to Basin: the verify step). */
	readonly basinRead: BasinReadSettings | undefined;
	warehouse(): Warehouse | undefined;
	keepDays(): number;
	/** The token sent in `start` (from Basin: the SQL token; to Basin: the send token). */
	token(): string;
	/** Aborted on pause, cancel and stop. */
	signal(): AbortSignal;
	/** Aborted on cancel and stop only (a POST in flight finishes on a pause). */
	hardSignal(): AbortSignal;
	sleep(ms: number): Promise<void>;
	save(): Promise<void>;
	checkpoint(): void;
	/** Throws the job's stop signal (the loop ends quietly). */
	stopped(): never;
	pace(rows: number, startedAt: number): Promise<void>;
	waitForRoom(): Promise<void>;
	step(name: StepName): StepView;
	setDay(day: DayRow, change: Partial<DayRow>): Promise<void>;
}

/** A page cut off mid-send: the job waits for the owner (POST { action: "resolve", page, choice }). */
export class NeedsDecision extends Error {
	override name = "NeedsDecision";
	constructor(readonly decision: Decision) {
		super(decision.why);
	}
}

export interface Decision {
	page: string;
	table: ExportTable;
	day: string;
	rows: number;
	why: string;
	/** The question, for a reader that shows one line (the CLI). */
	question: string;
}

/** A Basin request that can't go on (a refused token, a malformed answer). */
export class BasinMoveError extends Error {
	override name = "BasinMoveError";
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const HEX32 = /^[0-9a-f]{32}$/;
const STRING_MAX = 1024 * 1024;
/** Bun / Node codes of a connection that never opened: the request was not sent, a retry can't double anything. */
const NOT_SENT = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket", "ConnectionClosed_BeforeSend", "UNABLE_TO_GET_ISSUER_CERT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

/** One line, no control characters, at most 300 characters. */
function oneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}

function retryAfter(res: Response, fallback: number): number {
	const after = Number(res.headers.get("retry-after"));
	return Number.isFinite(after) && after > 0 ? Math.min(after, 300) * 1000 : fallback;
}

const quoted = (table: ExportTable) =>
	fieldsOf(table)
		.map((f) => `"${f.name}"`)
		.join(", ");

/**
 * md5 of every contract column, each written as `n` (NULL) or `v<length>:<text>`: two rows share it only when every
 * column is equal (md5 collisions aside). Plain SQL both DataFusion and DuckDB run (the tests' fake runs it on DuckDB).
 */
export function rowKeySql(table: ExportTable): string {
	const parts = fieldsOf(table).map((f) => {
		const c = `"${f.name}"`;
		const text = `CAST(${c} AS VARCHAR)`;
		return `CASE WHEN ${c} IS NULL THEN 'n' ELSE 'v' || CAST(character_length(${text}) AS VARCHAR) || ':' || ${text} END`;
	});
	return `md5(${parts.join(" || ")})`;
}

// Basin SQL ---------------------------------------------------------------------------------------------------------------

/** The Basin SQL API with retries (429, 5xx, edge errors, no connection), a timeout per query, the job's stop signal. */
export class BasinSql {
	private readonly url: string;

	constructor(
		private readonly read: BasinReadSettings,
		private readonly host: Pick<FlowHost, "fetch" | "knobs" | "signal" | "sleep" | "checkpoint">,
	) {
		this.url = basinQueryUrl(read.accountId, read.bucket, host.knobs.endpoint);
	}

	table(table: ExportTable): string {
		return `${this.read.namespace}.${table}`;
	}

	async query(statement: string): Promise<Record<string, unknown>[]> {
		const tries = this.host.knobs.tries;
		let delay = 1000;
		for (let attempt = 1; ; attempt++) {
			this.host.checkpoint();
			let res: Response;
			try {
				res = await this.host.fetch(this.url, {
					method: "POST",
					redirect: "error",
					headers: { authorization: `Bearer ${this.read.token}`, "content-type": "application/json" },
					body: JSON.stringify({ query: statement }),
					signal: AbortSignal.any([this.host.signal(), AbortSignal.timeout(this.host.knobs.timeoutMs)]),
				});
			} catch (error) {
				this.host.checkpoint();
				if (attempt >= tries) throw new BasinMoveError(`Basin SQL did not answer (${oneLine((error as Error).message ?? String(error))})`);
				await this.host.sleep(delay);
				delay = Math.min(delay * 2, 30_000);
				continue;
			}
			const text = await res.text().catch(() => "");
			let body: unknown;
			try {
				body = text ? JSON.parse(text) : undefined;
			} catch {
				body = undefined;
			}
			const failed = !res.ok || (typeof body === "object" && body !== null && (body as { success?: unknown }).success === false);
			if (!failed) {
				if (body === undefined) throw new BasinMoveError("Basin SQL answered something that is not JSON");
				return parseBasinRows(body) as Record<string, unknown>[];
			}
			const { message, codes } = basinErrorOf(body, text);
			if (res.status === 401 || res.status === 403) throw new BasinMoveError(`Basin refused the SQL token (${res.status}): it needs Basin SQL read, Basin Catalog read and R2 storage read`);
			if ((res.status === 429 || res.status >= 500 || codes.includes(80001)) && attempt < tries) {
				await this.host.sleep(retryAfter(res, delay));
				delay = Math.min(delay * 2, 30_000);
				continue;
			}
			throw new BasinMoveError(`Basin SQL ${res.status}: ${oneLine(message)}`);
		}
	}

	/** Rows per UTC day of a table (one query; it reads `t` only). */
	async dayCounts(table: ExportTable): Promise<Map<string, number>> {
		const day = `CAST(floor(t / ${DAY_MS}) AS BIGINT)`;
		const rows = await this.query(`SELECT ${day} AS day, COUNT(*) AS n FROM ${this.table(table)} GROUP BY ${day} ORDER BY day LIMIT 10000`);
		const out = new Map<string, number>();
		for (const r of rows) {
			const d = Number(r.day);
			const n = Number(r.n);
			if (Number.isSafeInteger(d) && Number.isSafeInteger(n) && n > 0 && d >= 0 && d < 200_000) out.set(dayString(d), n);
		}
		return out;
	}

	async count(table: ExportTable, from: number, to: number): Promise<number> {
		const rows = await this.query(`SELECT COUNT(*) AS n FROM ${this.table(table)} WHERE t >= ${int(from)} AND t < ${int(to)} LIMIT 1`);
		return Number(rows[0]?.n ?? 0);
	}

	/** Rows per bucket of `bucketMs` in [from, to). */
	async histogram(table: ExportTable, from: number, to: number, bucketMs: number): Promise<{ start: number; n: number }[]> {
		const b = `CAST(floor(t / ${int(bucketMs)}) AS BIGINT)`;
		const rows = await this.query(`SELECT ${b} AS b, COUNT(*) AS n FROM ${this.table(table)} WHERE t >= ${int(from)} AND t < ${int(to)} GROUP BY ${b} ORDER BY b LIMIT 10000`);
		return rows.map((r) => ({ start: Number(r.b) * bucketMs, n: Number(r.n) })).filter((x) => Number.isSafeInteger(x.start) && Number.isSafeInteger(x.n) && x.start >= from && x.start < to);
	}

	/** One keyset page of [from, to), ordered by (t, h), after (T, H): `>=` H unless `strict`. */
	async page(table: ExportTable, from: number, to: number, after: { t: number; h: string; strict: boolean } | null, size: number): Promise<Record<string, unknown>[]> {
		const cols = quoted(table);
		const inner = `SELECT ${cols}, ${rowKeySql(table)} AS h FROM ${this.table(table)} WHERE t >= ${int(from)} AND t < ${int(to)}${after ? ` AND t >= ${int(after.t)}` : ""}`;
		if (after && !HEX32.test(after.h)) throw new BasinMoveError("a page cursor is malformed");
		const where = after ? ` WHERE t > ${int(after.t)} OR h ${after.strict ? ">" : ">="} '${after.h}'` : "";
		return this.query(`SELECT ${cols}, h FROM (${inner}) x${where} ORDER BY t, h LIMIT ${int(size)}`);
	}

	/** Copies of one row (t, h) in Basin. */
	async countKey(table: ExportTable, t: number, h: string): Promise<number> {
		if (!HEX32.test(h)) throw new BasinMoveError("a page cursor is malformed");
		const rows = await this.query(`SELECT COUNT(*) AS n FROM (SELECT ${rowKeySql(table)} AS h FROM ${this.table(table)} WHERE t = ${int(t)}) x WHERE h = '${h}' LIMIT 1`);
		return Number(rows[0]?.n ?? 0);
	}
}

/** A Basin row as a stored row (contract columns + rt), or undefined when it doesn't fit the row format. */
export function storedRow(fields: readonly FieldSpec[], raw: Record<string, unknown>, rt: number): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		let v = raw[f.name];
		if (v === undefined || v === null) {
			if (f.required) return undefined;
			out[f.name] = null;
			continue;
		}
		if (f.type === "int32" || f.type === "int64") {
			if (typeof v === "string" && /^-?\d{1,19}$/.test(v)) v = Number(v);
			if (typeof v !== "number" || !Number.isSafeInteger(v)) return undefined;
			if (f.type === "int32" && (v < -2147483648 || v > 2147483647)) return undefined;
		} else if (f.type === "bool") {
			if (v === "true" || v === "false") v = v === "true";
			if (typeof v !== "boolean") return undefined;
		} else if (typeof v !== "string" || v.length > STRING_MAX) return undefined;
		out[f.name] = v;
	}
	out.rt = rt;
	return out;
}

/**
 * A contiguous partition of [from, to) into windows of about `max` rows from bucket counts (a bucket over `max` is a
 * window of its own). Empty stretches join a neighbour, so a row that lands there later is still inside a window.
 */
export function cutWindows(buckets: { start: number; n: number }[], from: number, to: number, max: number): [number, number][] {
	const out: [number, number][] = [];
	let start = from;
	let sum = 0;
	for (const b of [...buckets].sort((x, y) => x.start - y.start)) {
		if (b.start <= start) {
			sum += b.n;
			continue;
		}
		if (sum > 0 && sum + b.n > max) {
			out.push([start, b.start]);
			start = b.start;
			sum = 0;
		}
		sum += b.n;
	}
	out.push([start, to]);
	return out;
}

// From Basin --------------------------------------------------------------------------------------------------------------

interface PullCursor {
	windows: [number, number][];
	w: number;
	t: number | null;
	h: string | null;
	/** Copies of row (t, h) taken so far (the next page starts at its first copy). */
	k: number;
	strict: boolean;
	refused: number;
	missing: number;
}

const freshPull = (): PullCursor => ({ windows: [], w: 0, t: null, h: null, k: 0, strict: false, refused: 0, missing: 0 });

function parseJson<T>(text: string, fallback: () => T): T {
	if (!text) return fallback();
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback();
	}
}

const NOT_APPLICABLE_FROM = {
	erased: "not applicable: Basin holds no erasure list (this server's erased players are still left out of every imported row)",
	identities: "not applicable: Basin games keep pid <-> UserId on the fleet API, not in Basin",
	fleet: "not applicable: Basin holds analytics only",
};

export class FromBasinFlow {
	private readonly sql: BasinSql;

	constructor(
		private readonly h: FlowHost,
		read: BasinReadSettings,
	) {
		this.sql = new BasinSql(read, h);
	}

	/** Runs a step; false = the job's own (rollups). */
	async runStep(name: StepName): Promise<boolean> {
		const s = this.h.step(name);
		if (name === "erased" || name === "identities" || name === "fleet") {
			s.note = NOT_APPLICABLE_FROM[name];
			return true;
		}
		if (name === "rollups") return false;
		if (!this.h.analytics) {
			s.note = "analytics is off on this server";
			return true;
		}
		if (name === "events" || name === "recordings") await this.stepTable(name, s);
		else if (name === "live") await this.settle(s);
		else if (name === "verify") await this.verify(s);
		return true;
	}

	private async plan(table: ExportTable, counts: Map<string, number>): Promise<number> {
		const keep = this.h.keepDays();
		const today = Math.floor(this.h.clock() / DAY_MS);
		let skipped = 0;
		for (const [day, rows] of counts) {
			if (keep > 0 && dayNumber(day) < today - keep) {
				skipped++;
				continue;
			}
			await this.h.db.run("INSERT OR IGNORE INTO migrate_days (tbl, day, state, rows_source, hash_source) VALUES (?, ?, 'pending', ?, '')", [table, day, rows]);
		}
		const total = await this.h.db.first<{ n: number }>("SELECT COALESCE(SUM(rows_source), 0) AS n FROM migrate_days");
		this.h.job.rowsTotal = Number(total?.n ?? 0);
		return skipped;
	}

	private async stepTable(table: ExportTable, s: StepView): Promise<void> {
		const skipped = await this.plan(table, await this.sql.dayCounts(table));
		if (skipped) s.note = `${skipped} days older than this server's analytics history setting not imported`;
		const days = await this.h.db.all<DayRow>("SELECT * FROM migrate_days WHERE tbl = ? ORDER BY day DESC", [table]);
		s.total = days.length;
		s.done = days.filter((d) => d.state !== "pending" && d.state !== "importing").length;
		for (const day of days) {
			if (day.state !== "pending" && day.state !== "importing") continue;
			await this.importDay(day);
			await this.check(day);
			s.done++;
			await this.h.save();
		}
	}

	/** Time windows of a day: the whole day, or slices of about windowRows rows (hour buckets, minute buckets for a big hour). */
	private async windows(table: ExportTable, day: DayRow): Promise<[number, number][]> {
		const from = dayNumber(day.day) * DAY_MS;
		const to = from + DAY_MS;
		const max = this.h.knobs.windowRows;
		if (day.rows_source <= max) return [[from, to]];
		const buckets: { start: number; n: number }[] = [];
		for (const hour of await this.sql.histogram(table, from, to, HOUR_MS)) {
			if (hour.n > max) buckets.push(...(await this.sql.histogram(table, hour.start, hour.start + HOUR_MS, MINUTE_MS)));
			else buckets.push(hour);
		}
		return cutWindows(buckets, from, to, max);
	}

	/** Imports a day from its cursor: keyset pages per window, staged, merged every mergeRows and at the end. */
	private async importDay(day: DayRow): Promise<void> {
		const table = day.tbl;
		const c = parseJson<PullCursor>(day.cursor, freshPull);
		const size = this.h.knobs.pageRows;
		if (!c.windows.length) c.windows = await this.windows(table, day);
		await this.h.setDay(day, { state: "importing", page_size: size, cursor: JSON.stringify(c) });
		const fields = fieldsOf(table);
		while (c.w < c.windows.length) {
			const [from, to] = c.windows[c.w] as [number, number];
			await this.h.waitForRoom();
			const started = Date.now();
			const after = c.t === null || c.h === null ? null : { t: c.t, h: c.h, strict: c.strict };
			const rows = await this.sql.page(table, from, to, after, size);
			this.h.checkpoint();
			// The page must be in (t, h) order, inside the window and after the cursor; anything else is not Basin as known.
			let prev = after ? { t: after.t, h: after.h } : null;
			for (const r of rows) {
				const t = Number(r.t);
				const hk = String(r.h);
				if (!Number.isSafeInteger(t) || t < from || t >= to || !HEX32.test(hk)) throw new BasinMoveError("Basin answered a row outside the page asked for");
				if (prev && (t < prev.t || (t === prev.t && hk < prev.h))) throw new BasinMoveError("Basin answered rows out of order");
				prev = { t, h: hk };
			}
			// Copies of the last row taken come first again (`>=`): skip as many as were taken.
			let skip = 0;
			if (after && !after.strict) while (skip < rows.length && skip < c.k && Number(rows[skip]?.t) === c.t && rows[skip]?.h === c.h) skip++;
			const fresh = rows.slice(skip);
			let extra = 0;
			if (after && !after.strict && fresh.length === 0 && rows.length === size) {
				// A full page of one row's copies: count them in Basin, take the count (the copies collapse here anyway).
				const n = await this.sql.countKey(table, after.t, after.h);
				extra = Math.max(0, n - c.k);
				c.k = Math.max(c.k, n);
				c.strict = true;
			} else if (rows.length < size) {
				c.w++;
				c.t = null;
				c.h = null;
				c.k = 0;
				c.strict = false;
			} else {
				const last = rows[rows.length - 1] as Record<string, unknown>;
				const lt = Number(last.t);
				const lh = String(last.h);
				const copies = fresh.filter((r) => Number(r.t) === lt && r.h === lh).length;
				if (c.t === lt && c.h === lh && !c.strict) c.k += copies;
				else c.k = copies;
				c.t = lt;
				c.h = lh;
				c.strict = false;
			}
			const rt = this.h.clock();
			const lines: string[] = [];
			for (const r of fresh) {
				const row = storedRow(fields, r, rt);
				if (row) lines.push(JSON.stringify(row));
				else c.refused++;
			}
			let page = day.next_page;
			if (lines.length) {
				writeFileSync(this.h.target.pageFile(table, day.day, page), `${lines.join("\n")}\n`);
				page++;
			}
			const read = fresh.length + extra;
			await this.h.setDay(day, { next_page: page, staged_rows: day.staged_rows + lines.length, pass_rows: day.pass_rows + read, imported: Math.max(day.imported, day.pass_rows + read), cursor: JSON.stringify(c) });
			if (day.staged_rows >= this.h.mergeRows) await this.flush(day, c);
			await this.h.pace(read, started);
		}
		await this.flush(day, c);
	}

	/** Merges the staged pages into the day file and counts the rows of them that are not there afterwards. */
	private async flush(day: DayRow, c: PullCursor): Promise<void> {
		c.missing += await this.h.target.flushDay(day.tbl, day.day, true);
		await this.h.setDay(day, { staged_rows: 0, cursor: JSON.stringify(c) });
	}

	private async reimport(day: DayRow, rows: number): Promise<void> {
		await this.h.setDay(day, { rows_source: rows, next_page: 0, staged_rows: 0, pass_rows: 0, verified: 0, cursor: "", state: "pending" });
		await this.importDay(day);
	}

	/**
	 * A day's result: the rows read must equal Basin's count (counted again when they don't: a day that grew is imported
	 * again once), every row read must be in the day file, and a day before this server's own rows can't hold more.
	 */
	private async check(day: DayRow): Promise<void> {
		const c = parseJson<PullCursor>(day.cursor, freshPull);
		if (day.pass_rows !== day.rows_source && day.tries < 1) {
			const from = dayNumber(day.day) * DAY_MS;
			const now = await this.sql.count(day.tbl, from, from + DAY_MS);
			await this.h.setDay(day, { tries: day.tries + 1 });
			if (now !== day.pass_rows) {
				await this.reimport(day, now);
				return this.check(day);
			}
			await this.h.setDay(day, { rows_source: now });
		}
		const here = await this.h.target.dayHash(day.tbl, day.day);
		const exact = dayNumber(day.day) < this.h.job.cutoverDay;
		let state: DayRow["state"] = "match";
		let note = "";
		if (c.refused > 0) {
			state = "differs";
			note = `${c.refused} rows in Basin don't fit the row format (not imported)`;
		} else if (day.pass_rows < day.rows_source) {
			state = "missing";
			note = `missing ${day.rows_source - day.pass_rows}: read ${day.pass_rows} of Basin's ${day.rows_source} rows`;
		} else if (day.pass_rows > day.rows_source) {
			state = "differs";
			note = `read ${day.pass_rows} rows, Basin counts ${day.rows_source}`;
		} else if (c.missing > 0) {
			state = "missing";
			note = `missing ${c.missing}: rows read from Basin are not in the day file`;
		} else if (exact && here.rows > day.rows_source) {
			state = "differs";
			note = `${here.rows} rows here, ${day.rows_source} in Basin`;
		} else if (!exact) note = "also holds this server's own rows (checked: every Basin row is here)";
		else if (here.rows < day.rows_source) note = `${day.rows_source - here.rows} rows not kept: exact duplicates in Basin, or erased players`;
		await this.h.setDay(day, { state, rows_target: here.rows, verified: 1, note });
	}

	/** The live step: Basin's roll delay (rows the game sent just before the switch become readable minutes later). */
	private async settle(s: StepView): Promise<void> {
		const until = this.h.job.startedAt + this.h.knobs.settleMs;
		while (this.h.clock() < until) {
			this.h.checkpoint();
			this.h.job.state = "waiting";
			this.h.job.waitingFor = `Basin's roll delay: rows sent just before the switch can take minutes to become readable (until ${new Date(until).toISOString().slice(11, 16)} UTC)`;
			await this.h.save();
			await this.h.sleep(Math.max(1, Math.min(this.h.pollMs, until - this.h.clock())));
		}
		this.h.job.state = "running";
		this.h.job.waitingFor = null;
		s.note = "waited for Basin's roll delay; the verify step counts every day again";
		await this.h.save();
	}

	/** Every day counted in Basin again: days that grew (or appeared) are imported again, then every day is checked. */
	private async verify(s: StepView): Promise<void> {
		s.total = 0;
		s.done = 0;
		for (const table of EXPORT_TABLES) {
			const counts = await this.sql.dayCounts(table);
			await this.plan(table, counts);
			const days = await this.h.db.all<DayRow>("SELECT * FROM migrate_days WHERE tbl = ? ORDER BY day DESC", [table]);
			s.total += days.length;
			for (const day of days) {
				this.h.checkpoint();
				const now = counts.get(day.day) ?? 0;
				if (day.state === "pending" || day.state === "importing") await this.importDay(day);
				else if (now !== day.rows_source && day.tries < 2) {
					await this.h.setDay(day, { tries: day.tries + 1 });
					await this.reimport(day, now);
				}
				if (now !== day.rows_source) await this.h.setDay(day, { rows_source: now });
				await this.check(day);
				s.done++;
				await this.h.save();
			}
		}
		const bad = await this.h.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM migrate_days WHERE state <> 'match'");
		s.note = Number(bad?.n ?? 0) ? `${bad?.n} days are not a match: see the report` : "every day matches Basin's counts";
	}
}

// To Basin ----------------------------------------------------------------------------------------------------------------

interface PushPart {
	/** Rows received after this time only (a later part); null = the whole day. */
	newer: number | null;
	rows: number;
	hash: string;
	maxRt: number | null;
	/** When the snapshot was made (0 = not yet). */
	at: number;
	next: number;
	sent: number;
	skipped: number;
	refused: number;
	done: boolean;
	broken?: string;
}

interface PushCursor {
	/** Basin's rows of the day before this job sent any (null: no read settings). */
	before: number | null;
	parts: PushPart[];
	lastSendAt: number | null;
	resent: number;
}

interface PageRow {
	id: string;
	tbl: ExportTable;
	day: string;
	part: number;
	first: number;
	end_row: number;
	rows: number;
	state: "sending" | "sent" | "resend" | "skipped";
}

const freshPush = (): PushCursor => ({ before: null, parts: [], lastSendAt: null, resent: 0 });
const newPart = (newer: number | null): PushPart => ({ newer, rows: 0, hash: "0", maxRt: null, at: 0, next: 0, sent: 0, skipped: 0, refused: 0, done: false });

export const PAGES_SCHEMA = `CREATE TABLE IF NOT EXISTS migrate_pages (
	id TEXT PRIMARY KEY, tbl TEXT NOT NULL, day TEXT NOT NULL, part INTEGER NOT NULL, first INTEGER NOT NULL, end_row INTEGER NOT NULL,
	rows INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`;

const NOT_APPLICABLE_TO = {
	erased: "not applicable: the erasure list stays on this server (erased players' rows are never sent)",
	identities: "not applicable: pid <-> UserId stays on this server's fleet API",
	fleet: "not applicable: the fleet history, error logs and settings stay on this server",
	rollups: "not applicable: Basin computes from its rows",
};

export class ToBasinFlow {
	private readonly sql: BasinSql | undefined;

	constructor(
		private readonly h: FlowHost,
		private readonly streams: { events: string; recordings: string },
	) {
		this.sql = h.basinRead ? new BasinSql(h.basinRead, h) : undefined;
	}

	/** A page left `sending` (the server stopped mid-send): the owner decides before anything else is sent. */
	async pending(): Promise<void> {
		const page = await this.h.db.first<PageRow>("SELECT * FROM migrate_pages WHERE state = 'sending' ORDER BY at LIMIT 1");
		if (page) throw this.decision(page, "the server stopped while this page was being sent: Basin may or may not have it");
	}

	private decision(page: PageRow, why: string): NeedsDecision {
		return new NeedsDecision({
			page: page.id,
			table: page.tbl,
			day: page.day,
			rows: page.rows,
			why,
			question: `${page.rows} rows of ${page.tbl} ${page.day} (page ${page.id}): ${why}. Resend (Basin may then hold them twice) or skip (they may be missing)?`,
		});
	}

	async runStep(name: StepName): Promise<boolean> {
		const s = this.h.step(name);
		if (name === "erased" || name === "identities" || name === "fleet" || name === "rollups") {
			s.note = NOT_APPLICABLE_TO[name];
			return true;
		}
		if (!this.h.analytics) {
			s.note = "analytics is off on this server";
			return true;
		}
		if (name === "events" || name === "recordings") {
			if (name === "events") await this.waitQuiet();
			await this.plan(name);
			await this.sendTable(name, s);
		} else if (name === "live") await this.stragglers(s);
		else if (name === "verify") await this.verify(s);
		return true;
	}

	/** Waits until this server has received nothing for quietMs and everything received is loaded. */
	private async waitQuiet(): Promise<void> {
		for (;;) {
			this.h.checkpoint();
			const w = this.h.warehouse();
			let why: string | null = "analytics to open on this server";
			if (w) {
				const now = this.h.clock();
				const newest = await newestRt(w, now);
				const quietFor = newest === null ? Infinity : now - newest;
				if (w.raw.oldestPending() === undefined && quietFor >= this.h.quietMs) why = null;
				else
					why = `this server to stop receiving analytics rows (last row ${Math.max(0, Math.round(quietFor / 60_000))} min ago; it waits for ${Math.round(this.h.quietMs / 60_000)} min of quiet): switch the game's analytics to Basin first (typetorch backend setup --analytics basin ...)`;
			}
			if (!why) break;
			this.h.job.state = "waiting";
			this.h.job.waitingFor = why;
			await this.h.save();
			await this.h.sleep(this.h.pollMs);
		}
		this.h.job.state = "running";
		this.h.job.waitingFor = null;
		await this.h.save();
	}

	/** The days this server holds (day files and live rows), with Basin's rows of each day before anything is sent. */
	private async plan(table: ExportTable): Promise<void> {
		const w = this.h.warehouse();
		if (!w) throw new BasinMoveError("analytics is not open on this server");
		const days = await localDays(w, table);
		const known = new Set((await this.h.db.all<{ day: string }>("SELECT day FROM migrate_days WHERE tbl = ?", [table])).map((r) => r.day));
		const fresh = days.filter((d) => !known.has(dayString(d.day)));
		const before = fresh.length && this.sql ? await this.sql.dayCounts(table) : undefined;
		for (const d of fresh) {
			const cursor: PushCursor = { ...freshPush(), before: before ? (before.get(dayString(d.day)) ?? 0) : null };
			await this.h.db.run("INSERT OR IGNORE INTO migrate_days (tbl, day, state, rows_source, hash_source, cursor) VALUES (?, ?, 'pending', ?, '', ?)", [table, dayString(d.day), d.rows, JSON.stringify(cursor)]);
		}
		const total = await this.h.db.first<{ n: number }>("SELECT COALESCE(SUM(rows_source), 0) AS n FROM migrate_days");
		this.h.job.rowsTotal = Number(total?.n ?? 0);
	}

	private async sendTable(table: ExportTable, s: StepView): Promise<void> {
		const days = await this.h.db.all<DayRow>("SELECT * FROM migrate_days WHERE tbl = ? ORDER BY day DESC", [table]);
		s.total = days.length;
		s.done = days.filter((d) => d.state !== "pending" && d.state !== "importing").length;
		for (const day of days) {
			if (day.state !== "pending" && day.state !== "importing") continue;
			await this.sendDay(day);
			s.done++;
			await this.h.save();
		}
	}

	private snapshotPath(table: ExportTable, day: string, part: number): string {
		const dir = join(this.h.dir, "basin");
		mkdirSync(dir, { recursive: true });
		return join(dir, `${table}-${day}-${part}.parquet`);
	}

	/** Sends every unfinished part of a day, then marks it `sent`. */
	private async sendDay(day: DayRow): Promise<void> {
		const c = parseJson<PushCursor>(day.cursor, freshPush);
		if (!c.parts.length) c.parts.push(newPart(null));
		await this.h.setDay(day, { state: "importing", cursor: JSON.stringify(c) });
		for (let p = 0; p < c.parts.length; p++) if (!(c.parts[p] as PushPart).done) await this.sendPart(day, c, p);
		const rows = c.parts.reduce((n, x) => n + x.rows, 0);
		const sent = c.parts.reduce((n, x) => n + x.sent, 0);
		const notes = [
			...c.parts.filter((x) => x.broken).map((x) => x.broken as string),
			...(c.parts.some((x) => x.skipped) ? [`${c.parts.reduce((n, x) => n + x.skipped, 0)} rows of skipped pages`] : []),
			...(c.parts.some((x) => x.refused) ? [`${c.parts.reduce((n, x) => n + x.refused, 0)} rows over the request size not sent`] : []),
			...(c.resent ? [`${c.resent} rows resent`] : []),
		];
		await this.h.setDay(day, { state: "sent", rows_source: rows, rows_target: sent, imported: sent, note: notes.join("; "), cursor: JSON.stringify(c) });
	}

	private async sendPart(day: DayRow, c: PushCursor, p: number): Promise<void> {
		const w = this.h.warehouse();
		if (!w) throw new BasinMoveError("analytics is not open on this server");
		const part = c.parts[p] as PushPart;
		const table = day.tbl;
		const path = this.snapshotPath(table, day.day, p);
		if (!existsSync(path)) {
			const st = await snapshotDay(w, table, dayNumber(day.day), path, part.newer ?? undefined);
			if (part.at === 0 || part.next === 0) Object.assign(part, { rows: st.rows, hash: st.hash, maxRt: st.maxRt, at: this.h.clock() });
			else if (st.rows !== part.rows || st.hash !== part.hash) {
				// Rebuilt after a crash, but the day changed meanwhile (an erasure): the rest can't be lined up with what went.
				part.broken = `the day changed here after ${part.next} of ${part.rows} rows were sent (now ${st.rows}); the rest was not sent`;
				part.done = true;
				rmSync(path, { force: true });
				await this.h.setDay(day, { cursor: JSON.stringify(c) });
				return;
			}
			await this.h.setDay(day, { cursor: JSON.stringify(c) });
		} else if (part.at === 0) {
			const st = await snapshotStat(w, table, path);
			Object.assign(part, { rows: st.rows, hash: st.hash, at: this.h.clock() });
		}
		const url = table === "events" ? this.streams.events : this.streams.recordings;
		while (part.next < part.rows) {
			this.h.checkpoint();
			await this.h.waitForRoom();
			const started = Date.now();
			const id = `${table}:${day.day}:${p}:${part.next}`;
			const known = await this.h.db.first<PageRow>("SELECT * FROM migrate_pages WHERE id = ?", [id]);
			if (known?.state === "sending") throw this.decision(known, "the server stopped while this page was being sent: Basin may or may not have it");
			if (known?.state === "skipped" || known?.state === "sent") {
				if (known.state === "skipped") part.skipped += known.rows;
				else part.sent += known.rows;
				part.next = known.end_row;
				await this.h.setDay(day, { cursor: JSON.stringify(c) });
				continue;
			}
			const first = part.next;
			let body: string;
			let rows: number;
			if (known?.state === "resend") {
				({ body, rows } = await this.pageBody(w, table, path, known.first, known.end_row - known.first, Infinity));
				c.resent += rows;
			} else {
				const built = await this.pageBody(w, table, path, first, Math.min(this.h.knobs.sendRows, part.rows - first), this.h.knobs.sendBytes);
				if (built.rows === 0) {
					// One row over the request size (not a row the ingest path takes): left out, counted.
					part.refused++;
					part.next++;
					await this.h.setDay(day, { cursor: JSON.stringify(c) });
					continue;
				}
				({ body, rows } = built);
			}
			const end = first + rows;
			await this.h.db.run("INSERT INTO migrate_pages (id, tbl, day, part, first, end_row, rows, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?) ON CONFLICT (id) DO UPDATE SET state = 'sending', at = excluded.at", [
				id,
				table,
				day.day,
				p,
				first,
				end,
				rows,
				this.h.clock(),
			]);
			await this.post(url, body, { id, tbl: table, day: day.day, part: p, first, end_row: end, rows, state: "sending" });
			part.sent += rows;
			part.next = end;
			c.lastSendAt = this.h.clock();
			await this.h.db.transaction((tx) => {
				tx.run("UPDATE migrate_pages SET state = 'sent', at = ? WHERE id = ?", [this.h.clock(), id]);
				tx.run("UPDATE migrate_days SET cursor = ?, imported = imported + ? WHERE tbl = ? AND day = ?", [JSON.stringify(c), rows, table, day.day]);
			});
			day.cursor = JSON.stringify(c);
			day.imported += rows;
			await this.h.pace(rows, started);
		}
		part.done = true;
		rmSync(path, { force: true });
		await this.h.setDay(day, { cursor: JSON.stringify(c) });
	}

	/** A JSON array of the snapshot's rows from `from` (contract columns only): as many as fit `maxBytes`, at most `count`. */
	private async pageBody(w: Warehouse, table: ExportTable, path: string, from: number, count: number, maxBytes: number): Promise<{ body: string; rows: number }> {
		const fields = fieldsOf(table);
		const parts: string[] = [];
		let bytes = 2;
		const batch = table === "events" ? 2000 : 50;
		for (let at = from; at < from + count; at += batch) {
			const rows = await snapshotRows(w, table, path, at, Math.min(batch, from + count - at));
			if (!rows.length) break;
			for (const r of rows) {
				const out: Record<string, unknown> = {};
				for (const f of fields) out[f.name] = r[f.name] ?? null;
				const text = JSON.stringify(out);
				const size = Buffer.byteLength(text) + (parts.length ? 1 : 0);
				if (bytes + size > maxBytes) return { body: `[${parts.join(",")}]`, rows: parts.length };
				parts.push(text);
				bytes += size;
			}
		}
		return { body: `[${parts.join(",")}]`, rows: parts.length };
	}

	/** One POST: 2xx = taken; 429 / 5xx / no connection = retried (nothing taken); 4xx = the job stops; no answer = a decision. */
	private async post(url: string, body: string, page: PageRow): Promise<void> {
		const tries = this.h.knobs.tries;
		let delay = 1000;
		for (let attempt = 1; ; attempt++) {
			let res: Response;
			try {
				res = await this.h.fetch(url, {
					method: "POST",
					redirect: "error",
					headers: { authorization: `Bearer ${this.h.token()}`, "content-type": "application/json" },
					body,
					signal: AbortSignal.any([this.h.hardSignal(), AbortSignal.timeout(this.h.knobs.timeoutMs)]),
				});
			} catch (error) {
				if (this.h.hardSignal().aborted) this.h.stopped();
				const code = String((error as { code?: unknown }).code ?? "");
				if (NOT_SENT.has(code) && attempt < tries) {
					await this.h.sleep(delay);
					delay = Math.min(delay * 2, 30_000);
					continue;
				}
				if (NOT_SENT.has(code)) {
					await this.h.db.run("DELETE FROM migrate_pages WHERE id = ? AND state = 'sending'", [page.id]);
					throw new BasinMoveError(`Basin's stream could not be reached (${oneLine(code)})`);
				}
				throw this.decision(page, `no answer from Basin's stream (${oneLine((error as Error).message ?? String(error))}): it may or may not have taken the page`);
			}
			const text = await res.text().catch(() => "");
			if (res.ok) return;
			if ((res.status === 429 || res.status >= 500) && attempt < tries) {
				await this.h.sleep(retryAfter(res, delay));
				delay = Math.min(delay * 2, 30_000);
				continue;
			}
			// Refused (or still failing after every try): Basin took nothing, so the page goes back to unsent.
			await this.h.db.run("DELETE FROM migrate_pages WHERE id = ? AND state = 'sending'", [page.id]);
			if (res.status === 401 || res.status === 403) throw new BasinMoveError(`Basin's stream refused the send token (${res.status}): it needs Pipelines Send`);
			throw new BasinMoveError(`Basin's stream answered ${res.status}${text ? `: ${oneLine(text)}` : ""}`);
		}
	}

	/** The live step: rows that reached this server after their day was sent (or new days) go as a later part. */
	private async stragglers(s: StepView): Promise<void> {
		const w = this.h.warehouse();
		if (!w) throw new BasinMoveError("analytics is not open on this server");
		await this.waitQuiet();
		let late = 0;
		for (const table of EXPORT_TABLES) {
			await this.plan(table);
			const days = await this.h.db.all<DayRow>("SELECT * FROM migrate_days WHERE tbl = ? ORDER BY day DESC", [table]);
			for (const day of days) {
				this.h.checkpoint();
				const c = parseJson<PushCursor>(day.cursor, freshPush);
				if (day.state === "sent" || day.state === "match" || day.state === "missing" || day.state === "duplicates") {
					const since = Math.max(...c.parts.map((x) => x.maxRt ?? x.at), 0);
					const n = await newerRows(w, table, dayNumber(day.day), since);
					if (!n) continue;
					late += n;
					c.parts.push(newPart(since));
					await this.h.setDay(day, { cursor: JSON.stringify(c) });
				}
				if (c.parts.some((x) => !x.done) || day.state === "pending" || day.state === "importing") await this.sendDay(day);
			}
		}
		s.note = late ? `${late} rows reached this server after their day was sent: sent too` : "nothing arrived after its day was sent";
	}

	/** Per-day counts in Basin once its roll delay passed (with read settings); else every day stays `sent`. */
	private async verify(s: StepView): Promise<void> {
		const days = await this.h.db.all<DayRow>("SELECT * FROM migrate_days ORDER BY CASE tbl WHEN 'events' THEN 0 ELSE 1 END, day DESC");
		s.total = days.length;
		if (!this.sql) {
			s.done = days.length;
			s.note = "not checked in Basin: set CLOUDFLARE_ACCOUNT_ID, BASIN_BUCKET and BASIN_SQL_TOKEN on this server to compare per-day counts";
			return;
		}
		const cursors = new Map(days.map((d) => [`${d.tbl}:${d.day}`, parseJson<PushCursor>(d.cursor, freshPush)]));
		const expected = (d: DayRow) => {
			const c = cursors.get(`${d.tbl}:${d.day}`) as PushCursor;
			return c.parts.reduce((n, x) => n + x.rows - x.refused, 0);
		};
		const lastSend = Math.max(0, ...[...cursors.values()].map((c) => c.lastSendAt ?? 0));
		const deadline = lastSend + this.h.knobs.rollWaitMs;
		let counts = new Map<ExportTable, Map<string, number>>();
		for (;;) {
			this.h.checkpoint();
			counts = new Map();
			for (const table of EXPORT_TABLES) counts.set(table, await this.sql.dayCounts(table));
			const got = (d: DayRow) => (counts.get(d.tbl)?.get(d.day) ?? 0) - ((cursors.get(`${d.tbl}:${d.day}`) as PushCursor).before ?? 0);
			const short = days.filter((d) => got(d) < expected(d));
			if (!short.length || this.h.clock() >= deadline) break;
			this.h.job.state = "waiting";
			this.h.job.waitingFor = `Basin's roll delay: ${short.length} days not all readable yet (checks every ${Math.round(this.h.knobs.rollPollMs / 1000)} s until ${new Date(deadline).toISOString().slice(11, 16)} UTC)`;
			await this.h.save();
			await this.h.sleep(Math.max(1, Math.min(this.h.knobs.rollPollMs, deadline - this.h.clock())));
		}
		this.h.job.state = "running";
		this.h.job.waitingFor = null;
		const startDay = Math.floor(this.h.job.startedAt / DAY_MS);
		s.done = 0;
		for (const d of days) {
			const c = cursors.get(`${d.tbl}:${d.day}`) as PushCursor;
			const before = c.before ?? 0;
			const got = (counts.get(d.tbl)?.get(d.day) ?? 0) - before;
			const want = expected(d);
			// Days the game may also send to Basin itself (today on), or that Basin already held rows of: a superset is fine.
			const superset = before > 0 || dayNumber(d.day) >= startDay;
			const notes = d.note ? [d.note] : [];
			let state: DayRow["state"];
			if (got < want) {
				state = "missing";
				notes.unshift(`missing ${want - got} in Basin`);
			} else if (got === want) state = "match";
			else if (superset) {
				state = "match";
				notes.unshift(`superset: ${got - want} more rows in Basin (the game's own${c.resent ? ", or a resent page" : ""})`);
			} else {
				state = "duplicates";
				notes.unshift(`${got - want} rows more in Basin than were sent${c.resent ? " (a resent page)" : ""}`);
			}
			await this.h.setDay(d, { state, rows_source: want, rows_target: got, verified: 1, note: notes.join("; ") });
			s.done++;
		}
		await this.h.save();
		const bad = await this.h.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM migrate_days WHERE state <> 'match'");
		s.note = Number(bad?.n ?? 0) ? `${bad?.n} days are not a match: see the report` : "every day matches Basin's counts";
	}
}

/** Checks a Basin stream URL: https, or http on this machine only (the send token would cross the network in clear). */
export function checkStreamUrl(raw: unknown, what: string): string {
	if (typeof raw !== "string" || raw.length > 2048) throw new Error(`${what} is a Basin stream URL (https://<stream id>.ingest.cloudflare.com)`);
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`${what} is not a URL`);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`${what} must be https (the send token would cross the network in clear)`);
	if (url.username || url.password) throw new Error(`${what} must not hold credentials: the token goes in to.token`);
	if (url.search || url.hash) throw new Error(`${what} must not have a query or fragment`);
	return url.href;
}

export { BASIN_SQL_API };
