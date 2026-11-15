/**
 * Plans/35 A: the migration job. A new server pulls an old server's history row by row through the old server's export
 * API (server/export.ts), never by copying files. It runs inside the new server (so it survives the CLI or a browser
 * closing), one at a time, and keeps its state in the SQLite file (`migrate_*` tables): the source, the old admin token
 * sealed with instance.key, a cursor per SQLite table and per day, and each day's result. A crash or a redeploy on
 * either side resumes at the last page.
 *
 * Steps, in order:
 *   1 erased       the old server's erased pids, applied here first (their rows are then dropped at import)
 *   2 identities   pid <-> UserId (an erasure that reaches this server during the move finds the pids)
 *   3 fleet        deploys (by seq: this server's own releases since the cutover stay), marks, reports, alerts, server
 *                  metrics, error logs, saved queries, the audit log; the runtime settings saved on the old server's
 *                  Settings page (not the webhook URL, not the admin allow list or the token login)
 *   4 events       day by day, newest first, in pages; each page is staged on disk and merged into the day file by the
 *   5 recordings   warehouse's late-row merge (Warehouse.mergeDay), never through live.duckdb
 *   6 live         once the old server has received nothing for 10 minutes: the days that changed meanwhile again
 *   7 rollups      rebuilt here from the imported day files, never copied
 *   8 verify       every day once more: (rows, hash) equal to the old server's (minus pids erased here since) for days
 *                  before the cutover, a superset check (an anti-join, page by page) for the cutover days
 *
 * Throttled: a rows-per-second cap, and it waits while the loader is behind or a query runs. Never destructive: the old
 * server is only read. The job is written against a Source (list days, count and hash a day, read a page) and a Target
 * (write a page, count and hash a day), so other directions (Basin) can plug in.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { dayNumber, dayString, fieldsOf, readJsonColumns } from "../duckdb/layout.ts";
import type { ErrorStore } from "../errors/store.ts";
import type { FleetDb, SqlValue, SyncTx } from "../fleet/db.ts";
import type { IdentityStore } from "../fleet/identity.ts";
import { DAY_MS } from "../sql/dialect.ts";
import { dayStat, EXPORT_TABLES, FLEET_EXPORT_TABLES, missingRows, type DayStat, type ExportTable, type FleetExportTable } from "./export.ts";
import type { InstanceKey } from "./instance-key.ts";
import type { RuntimeSettings } from "./runtime-settings.ts";
import type { Warehouse } from "./warehouse.ts";
import { BASIN_SQL_API, checkStreamUrl, FromBasinFlow, NeedsDecision, PAGES_SCHEMA, ToBasinFlow, type BasinKnobs, type BasinReadSettings, type Decision, type FlowHost } from "./migrate-basin.ts";
import { ACCOUNT_ID, BASIN_IDENT, BUCKET_NAME } from "../store/basin.ts";

export const MIGRATE_STATES = ["idle", "running", "paused", "waiting", "done", "failed", "cancelled", "needs_decision"] as const;
export type MigrateState = (typeof MIGRATE_STATES)[number];
export const STEP_NAMES = ["erased", "identities", "fleet", "events", "recordings", "live", "rollups", "verify"] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type StepState = "pending" | "running" | "done" | "failed";
/** `sent`: a day moved to Basin without read settings here to count it there (to-basin). */
export type DayState = "pending" | "importing" | "match" | "missing" | "differs" | "duplicates" | "sent";
export type Direction = "from-backend" | "from-basin" | "to-basin";

export interface StepView {
	name: StepName;
	state: StepState;
	done: number;
	total: number;
	note?: string;
}

export interface DayView {
	table: ExportTable;
	day: string;
	state: DayState;
	rowsSource: number;
	rowsTarget: number;
	note: string;
}

/** Where the rows come from: an old server, Basin (its bucket and namespace), or this server (to Basin). */
export type SourceRef = { kind: "backend"; url: string } | { kind: "basin"; accountId: string; bucket: string; namespace: string } | { kind: "local" };
export type SourceView = { kind: "backend"; url: string } | { kind: "basin"; bucket: string; namespace: string } | { kind: "local" };

export interface MigrateStatus {
	state: MigrateState;
	direction: Direction | null;
	source: SourceView | null;
	/** To Basin: the streams the rows go to. */
	target?: { kind: "basin"; events: string; recordings: string };
	startedAt: number | null;
	finishedAt: number | null;
	rowsPerSecond: number;
	rowsDone: number;
	rowsTotal: number;
	steps: StepView[];
	days: DayView[];
	waitingFor: string | null;
	/** To Basin: a page cut off mid-send waits for `resolve` (resend or skip). */
	decision: Decision | null;
	error: string | null;
}

// Source and target ------------------------------------------------------------------------------------------------------

export interface SourceManifest {
	server: { instance: string; now: number };
	tables: Record<ExportTable, DayStat[]>;
	live: { day: string | null; rows: number; lastRt: number | null };
	fleet: Record<string, { rows: number; maxId: number | null }>;
	erased: number;
}

/** Where rows come from (the old server's export API; phase 2: Basin's Iceberg tables). */
export interface MigrationSource {
	readonly kind: "backend";
	manifest(signal: AbortSignal): Promise<SourceManifest>;
	/** Rows and hash of one day without `exclude` (pids erased on the target since). */
	dayHash(table: ExportTable, day: string, exclude: string[], signal: AbortSignal): Promise<{ rows: number; hash: string }>;
	/** Writes page `page` of the day (stored row format, NDJSON) to `file`. */
	readPage(table: ExportTable, day: string, page: number, size: number, file: string, signal: AbortSignal): Promise<{ rows: number; last: boolean }>;
	/** Backend sources only: the erased pids, a page of a SQLite table, the runtime settings saved on its Settings page. */
	erased(signal: AbortSignal): Promise<string[]>;
	fleetPage(table: FleetExportTable, after: number, size: number, signal: AbortSignal): Promise<{ rows: Record<string, unknown>[]; next: number | null }>;
	settings(signal: AbortSignal): Promise<{ key: string; source: string; value?: unknown }[]>;
}

/** Where rows go (this server's day files; phase 2: Basin's streams). */
export interface MigrationTarget {
	/** The file a page is staged in (the target owns it from then on). */
	pageFile(table: ExportTable, day: string, page: number): string;
	/** A scratch file for a verify page. */
	scratchFile(): string;
	/** Applies the staged pages of a day (here: one late-row merge into the day file), then forgets them; with `check`, the rows of them not in the day afterwards. */
	flushDay(table: ExportTable, day: string, check?: boolean): Promise<number>;
	dayHash(table: ExportTable, day: string): Promise<{ rows: number; hash: string }>;
	/** Rows of page files that the target's copy of the day lacks. */
	missing(table: ExportTable, day: string, file: string | string[]): Promise<number>;
	rollups(days: string[]): Promise<void>;
	erasedPids(): string[];
	/** Drops every staged page (cancel). */
	clear(): void;
}

// The old server's export API, as a source -------------------------------------------------------------------------------

export class MigrateHttpError extends Error {
	override name = "MigrateHttpError";
	constructor(
		message: string,
		readonly status: number,
		readonly fatal: boolean,
	) {
		super(message);
	}
}

/** Bytes one page may hold on disk (inflated). */
const PAGE_BYTES_MAX = 1024 * 1024 * 1024;
const JSON_BYTES_MAX = 64 * 1024 * 1024;

export interface BackendSourceOptions {
	url: string;
	token: string;
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Tries per request (network errors, 429, 5xx); default 6. */
	tries?: number;
}

export class BackendSource implements MigrationSource {
	readonly kind = "backend" as const;
	private readonly fetcher: typeof fetch;
	private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

	constructor(private readonly o: BackendSourceOptions) {
		this.fetcher = o.fetch ?? fetch;
		this.sleep = o.sleep ?? abortableSleep;
	}

	/** One call with retries: 429 / 503 wait their Retry-After, 5xx and network errors back off; 401 / 403 / 404 / 4xx stop the job. */
	private async call(path: string, signal: AbortSignal, init: RequestInit = {}, timeoutMs = 10 * 60_000): Promise<Response> {
		const tries = this.o.tries ?? 6;
		let delay = 1000;
		// A 429 is the old server's own throttle (one export at a time, 120 a minute): waited out, not counted as a failure.
		let throttled = 0;
		for (let attempt = 1; ; attempt++) {
			if (signal.aborted) throw new Stopped();
			let res: Response;
			try {
				res = await this.fetcher(`${this.o.url}${path}`, {
					...init,
					redirect: "error",
					headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.o.token}`, accept: "application/json, application/x-ndjson" },
					signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
				});
			} catch (error) {
				if (signal.aborted) throw new Stopped();
				if (attempt >= tries) throw new MigrateHttpError(`the old server did not answer (${clean((error as Error).message ?? String(error))})`, 0, false);
				await this.sleep(delay, signal);
				delay = Math.min(delay * 2, 30_000);
				continue;
			}
			if (res.ok) return res;
			const text = clean(await res.text().catch(() => ""));
			if (res.status === 401 || res.status === 403) throw new MigrateHttpError(`the old server refused the token (${res.status}): give its admin token (a Bearer, not a browser session)`, res.status, true);
			if (res.status === 404) throw new MigrateHttpError(`the old server has no ${path.split("?")[0]} (404): update it to a backend with the export API first`, 404, true);
			if (res.status === 429 && throttled < 10_000) {
				throttled++;
				attempt--;
				const after = Number(res.headers.get("retry-after"));
				await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 300) * 1000 : 1000, signal);
				continue;
			}
			if ((res.status === 429 || res.status >= 500) && attempt < tries) {
				const after = Number(res.headers.get("retry-after"));
				await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 300) * 1000 : delay, signal);
				delay = Math.min(delay * 2, 30_000);
				continue;
			}
			throw new MigrateHttpError(`the old server answered ${res.status} to ${path.split("?")[0]}${text ? `: ${text}` : ""}`, res.status, res.status < 500 && res.status !== 429);
		}
	}

	private async json<T>(path: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
		const res = await this.call(path, signal, init);
		const text = await res.text();
		if (text.length > JSON_BYTES_MAX) throw new MigrateHttpError(`the old server's answer to ${path.split("?")[0]} is too big`, 0, true);
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new MigrateHttpError(`the old server's answer to ${path.split("?")[0]} is not JSON`, 0, true);
		}
	}

	async manifest(signal: AbortSignal): Promise<SourceManifest> {
		const m = await this.json<SourceManifest & { version?: number }>("/v1/admin/export/manifest", signal);
		if (!m || m.version !== 1 || !m.tables || !Array.isArray(m.tables.events) || !Array.isArray(m.tables.recordings)) throw new MigrateHttpError("the old server's manifest is not version 1", 0, true);
		for (const table of EXPORT_TABLES) {
			m.tables[table] = m.tables[table].filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.day)) && Number.isSafeInteger(d.rows) && /^\d{1,20}$/.test(String(d.hash)));
		}
		return m;
	}

	async dayHash(table: ExportTable, day: string, exclude: string[], signal: AbortSignal): Promise<{ rows: number; hash: string }> {
		const r = await this.json<{ rows: number; hash: string }>(`/v1/admin/export/hash?table=${table}&day=${day}`, signal, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ exclude }),
		});
		return { rows: Number(r.rows), hash: String(r.hash) };
	}

	async readPage(table: ExportTable, day: string, page: number, size: number, file: string, signal: AbortSignal): Promise<{ rows: number; last: boolean }> {
		const res = await this.call(`/v1/admin/export/rows?table=${table}&day=${day}&page=${page}&size=${size}`, signal);
		const rows = Number(res.headers.get("x-typetorch-rows") ?? "0");
		const last = res.headers.get("x-typetorch-last-page") === "1";
		rmSync(file, { force: true });
		if (res.body) {
			let bytes = 0;
			const capped = async function* (body: AsyncIterable<Uint8Array>) {
				for await (const chunk of body) {
					bytes += chunk.byteLength;
					if (bytes > PAGE_BYTES_MAX) throw new MigrateHttpError("a page of the old server is over 1 GB: use smaller pages", 0, true);
					yield chunk;
				}
			};
			await pipeline(Readable.from(capped(Readable.fromWeb(res.body as unknown as NodeReadableStream))), createWriteStream(file), { signal });
		}
		return { rows: Number.isSafeInteger(rows) && rows >= 0 ? rows : 0, last };
	}

	async erased(signal: AbortSignal): Promise<string[]> {
		const r = await this.json<{ pids?: unknown }>("/v1/admin/export/erased", signal);
		return Array.isArray(r.pids) ? r.pids.filter((p): p is string => typeof p === "string" && PID.test(p)) : [];
	}

	async fleetPage(table: FleetExportTable, after: number, size: number, signal: AbortSignal): Promise<{ rows: Record<string, unknown>[]; next: number | null }> {
		const r = await this.json<{ rows?: unknown; next?: unknown }>(`/v1/admin/export/fleet?table=${table}&after=${after}&size=${size}`, signal);
		const rows = Array.isArray(r.rows) ? r.rows.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)) : [];
		const next = typeof r.next === "number" && Number.isSafeInteger(r.next) && r.next > after ? r.next : null;
		return { rows, next };
	}

	async settings(signal: AbortSignal): Promise<{ key: string; source: string; value?: unknown }[]> {
		const r = await this.json<{ settings?: unknown }>("/v1/admin/settings", signal);
		return Array.isArray(r.settings) ? (r.settings as { key: string; source: string; value?: unknown }[]) : [];
	}
}

// This server's day files, as a target ------------------------------------------------------------------------------------

export class LocalTarget implements MigrationTarget {
	private seq = 0;

	constructor(
		private readonly warehouse: () => Warehouse | undefined,
		private readonly dir: string,
		private readonly clock: () => number,
	) {}

	private open(): Warehouse {
		const w = this.warehouse();
		if (!w) throw new Error("analytics is not open on this server");
		return w;
	}

	private dayDir(table: ExportTable, day: string): string {
		return join(this.dir, `${table}-${day}`);
	}

	pageFile(table: ExportTable, day: string, page: number): string {
		const dir = this.dayDir(table, day);
		mkdirSync(dir, { recursive: true });
		return join(dir, `page-${page}.ndjson`);
	}

	scratchFile(): string {
		const dir = join(this.dir, "verify");
		mkdirSync(dir, { recursive: true });
		return join(dir, `page-${Date.now()}-${++this.seq}.ndjson`);
	}

	async flushDay(table: ExportTable, day: string, check = false): Promise<number> {
		const dir = this.dayDir(table, day);
		if (!existsSync(dir)) return 0;
		const files = readdirSync(dir)
			.filter((n) => /^page-\d+\.ndjson$/.test(n))
			.map((n) => join(dir, n));
		let missing = 0;
		if (files.length) {
			await this.open().mergeDay(table, dayNumber(day), files);
			if (check) missing = await this.missing(table, day, files);
		}
		rmSync(dir, { recursive: true, force: true });
		return missing;
	}

	dayHash(table: ExportTable, day: string): Promise<{ rows: number; hash: string }> {
		return dayStat(this.open(), table, dayNumber(day));
	}

	missing(table: ExportTable, day: string, file: string | string[]): Promise<number> {
		const contract = fieldsOf(table)
			.map((f) => `"${f.name}"`)
			.join(", ");
		return missingRows(this.open(), table, dayNumber(day), file, readJsonColumns(table), contract);
	}

	async rollups(days: string[]): Promise<void> {
		const today = Math.floor(this.clock() / DAY_MS);
		const finished = days.map(dayNumber).filter((d) => d < today);
		if (finished.length) await this.open().rebuildRollups([...new Set(finished)].sort((a, b) => a - b));
	}

	erasedPids(): string[] {
		return this.warehouse()?.erasedPids() ?? [];
	}

	clear(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

// The job ---------------------------------------------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS migrate_job (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, token TEXT);
CREATE TABLE IF NOT EXISTS migrate_days (
	tbl TEXT NOT NULL, day TEXT NOT NULL, state TEXT NOT NULL, rows_source INTEGER NOT NULL, hash_source TEXT NOT NULL,
	rows_target INTEGER NOT NULL DEFAULT 0, next_page INTEGER NOT NULL DEFAULT 0, page_size INTEGER NOT NULL DEFAULT 0,
	staged_rows INTEGER NOT NULL DEFAULT 0, pass_rows INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
	tries INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '', PRIMARY KEY (tbl, day));
CREATE TABLE IF NOT EXISTS migrate_cursors (tbl TEXT PRIMARY KEY, after INTEGER NOT NULL, done INTEGER NOT NULL, rows INTEGER NOT NULL);
${PAGES_SCHEMA};
`;

const PID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PURPOSE = "migrate token v1";
/** Runtime settings never copied from the old server: the webhook URL (a secret, never served anyway) and the guarded ones. */
const SETTINGS_NOT_COPIED = new Set(["alertWebhookUrl", "adminAllowIps", "tokenLogin"]);
/** Tables whose integer key is this server's own: rows come in with new keys. */
const NEW_KEYS = new Set<FleetExportTable>(["marks", "reports", "alerts", "server_metrics", "audit_log", "saved_queries"]);
const STRING_MAX = 1024 * 1024;
/** Tables a second run from the same old server goes on with (inserted once, or upserted); the rest add up counts. */
const RESUMABLE = new Set<FleetExportTable>(["deploys", "marks", "reports", "alerts", "server_metrics", "saved_queries", "audit_log", "identities"]);
/** The integer key of a table (its rowid): the cursor after the last page. */
const KEY_OF: Partial<Record<FleetExportTable, string>> = { deploys: "seq", marks: "id", reports: "id", alerts: "id", server_metrics: "id", saved_queries: "id", audit_log: "id" };

export interface JobData {
	state: MigrateState;
	direction: Direction;
	source: SourceRef;
	/** To Basin: the stream URLs. */
	target?: { kind: "basin"; events: string; recordings: string };
	decision?: Decision | null;
	startedAt: number;
	finishedAt: number | null;
	rowsPerSecond: number;
	rowsTotal: number;
	fleetDone: number;
	steps: StepView[];
	waitingFor: string | null;
	error: string | null;
	/** Days from this one on also hold this server's own rows (checked as a superset). */
	cutoverDay: number;
}

export interface DayRow {
	tbl: ExportTable;
	day: string;
	state: DayState;
	rows_source: number;
	hash_source: string;
	rows_target: number;
	next_page: number;
	page_size: number;
	staged_rows: number;
	pass_rows: number;
	imported: number;
	tries: number;
	verified: number;
	note: string;
	/** The Basin directions' cursor (JSON): from Basin the time windows and the keyset, to Basin the parts of the day. */
	cursor: string;
}

export class MigrateError extends Error {
	override name = "MigrateError";
	constructor(
		message: string,
		readonly status: 400 | 409 | 501,
	) {
		super(message);
	}
}

/** Thrown inside the job when it was paused, cancelled or the server stops. */
class Stopped extends Error {
	override name = "Stopped";
}

export interface MigrationOptions {
	db: FleetDb;
	dataDir: string;
	warehouse: () => Warehouse | undefined;
	analytics: boolean;
	identities: IdentityStore;
	errors: ErrorStore;
	runtime: RuntimeSettings;
	/** The instance key (made on first use): seals the old server's token. */
	instanceKey: () => InstanceKey;
	/** This server's name in its own export manifest (a migration from itself is refused). */
	instanceId: () => string;
	defaultRowsPerSecond: number;
	/** Seconds between loader ticks: the job waits while raw/incoming holds data older than two of them. */
	loadSeconds: number;
	/** Days of day files kept here (0 = forever): older days are not imported (the nightly prune would delete them). */
	keepDays: () => number;
	fetch?: typeof fetch;
	clock?: () => number;
	log?: (line: string) => void;
	/** Rows a page (events, recordings) and rows a SQLite page. */
	pageSize?: { events?: number; recordings?: number; fleet?: number };
	/** Staged rows of a day merged at once (a long day merges in a few steps). */
	mergeRows?: number;
	/** How long the old server must have received nothing before its live rows are taken (10 minutes). */
	quietMs?: number;
	/** How often the job asks the old server again while it waits for quiet. */
	pollMs?: number;
	/** The longest the job waits for running queries before it goes on anyway. */
	queryWaitMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Called after each page is staged (tests). */
	onPage?: (table: ExportTable, day: string, page: number) => void | Promise<void>;
	/** Tries per request to the old server (default 6). */
	tries?: number;
	/** Plans/35 B: the Basin directions' knobs (tests: a fake SQL API, small pages, short waits). */
	basin?: BasinKnobs;
	/** Basin SQL read settings from this server's env (a move to Basin compares counts there). */
	basinRead?: BasinReadSettings;
}

export interface StartBody {
	action?: unknown;
	from?: unknown;
	to?: unknown;
	rowsPerSecond?: unknown;
	/** resolve: the page id and resend | skip. */
	page?: unknown;
	choice?: unknown;
}

/** A token as sent in `start`: printable, no spaces, 20-4096 characters (Cloudflare tokens are 40). */
function checkToken(raw: unknown, what: string, min: number): string {
	if (typeof raw !== "string" || raw.length < min || raw.length > 4096 || !/^[\x21-\x7e]+$/.test(raw)) throw new MigrateError(`${what} (${min}+ printable characters, no spaces)`, 400);
	return raw;
}

function emptySteps(): StepView[] {
	return STEP_NAMES.map((name) => ({ name, state: "pending" as StepState, done: 0, total: 0 }));
}

/** Checks a `from.url`: https, or http on this machine only (the token would cross the network in clear otherwise). */
export function checkSourceUrl(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 2048) throw new MigrateError("from.url is the old server's address (https://...)", 400);
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new MigrateError("from.url is not a URL", 400);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new MigrateError("from.url must be https (plain http only on this machine: the token would cross the network in clear)", 400);
	if (url.username || url.password) throw new MigrateError("from.url must not hold a user or password: the token goes in from.token", 400);
	if (url.search || url.hash) throw new MigrateError("from.url is the server's address only, without a query", 400);
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export class Migration {
	private data: JobData | undefined;
	private token: string | undefined;
	private source: MigrationSource | undefined;
	private readonly target: MigrationTarget;
	private controller = new AbortController();
	private halt: "pause" | "cancel" | "stop" | undefined;
	private loop: Promise<void> | undefined;
	/** Aborted on cancel and stop only: a POST to Basin in flight finishes on a pause. */
	private hardController = new AbortController();
	private flow: FromBasinFlow | ToBasinFlow | undefined;
	private runId = 0;
	private manifestCache: SourceManifest | undefined;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private columns = new Map<string, Set<string>>();

	private constructor(private readonly o: MigrationOptions) {
		this.clock = o.clock ?? Date.now;
		this.log = o.log ?? (() => {});
		this.sleep = o.sleep ?? abortableSleep;
		this.target = new LocalTarget(o.warehouse, join(o.dataDir, "migrate"), this.clock);
	}

	/** Opens the state; a job that was running when the server stopped goes on (in the background). */
	static async open(o: MigrationOptions): Promise<Migration> {
		await o.db.exec(SCHEMA);
		// A state file from before the Basin directions: the day cursor column.
		const cols = await o.db.all<{ name: string }>("PRAGMA table_info(migrate_days)");
		if (!cols.some((c) => c.name === "cursor")) await o.db.exec("ALTER TABLE migrate_days ADD COLUMN cursor TEXT NOT NULL DEFAULT ''");
		const m = new Migration(o);
		const row = await o.db.first<{ data: string; token: string | null }>("SELECT data, token FROM migrate_job WHERE id = 1");
		if (row) {
			try {
				m.data = JSON.parse(row.data) as JobData;
			} catch {
				m.data = undefined;
			}
			if (m.data && row.token && ["running", "waiting", "paused", "failed", "needs_decision"].includes(m.data.state)) {
				try {
					m.token = o.instanceKey().open(TOKEN_PURPOSE, row.token);
				} catch {
					m.data.state = "failed";
					m.data.error = "the migration's token can't be read with this server's instance.key: start the migration again";
					await m.save();
				}
			}
			if (m.data && (m.data.state === "running" || m.data.state === "waiting") && m.token) {
				m.log(`migrate: resuming the move (${m.data.direction})`);
				m.launch();
			}
		}
		return m;
	}

	/** The token in memory (the audit log's redactor covers it). */
	secrets(): string[] {
		return this.token ? [this.token] : [];
	}

	get running(): boolean {
		return this.data?.state === "running" || this.data?.state === "waiting";
	}

	async status(): Promise<MigrateStatus> {
		const d = this.data;
		if (!d) {
			return { state: "idle", direction: null, source: null, startedAt: null, finishedAt: null, rowsPerSecond: this.o.defaultRowsPerSecond, rowsDone: 0, rowsTotal: 0, steps: emptySteps(), days: [], waitingFor: null, decision: null, error: null };
		}
		const days = await this.o.db.all<DayRow>("SELECT * FROM migrate_days ORDER BY CASE tbl WHEN 'events' THEN 0 ELSE 1 END, day DESC");
		const rowsDone = d.fleetDone + days.reduce((sum, r) => sum + Math.min(r.imported, r.rows_source), 0);
		const src = d.source;
		return {
			state: d.state,
			direction: d.direction,
			source: src.kind === "basin" ? { kind: "basin", bucket: src.bucket, namespace: src.namespace } : src.kind === "local" ? { kind: "local" } : { kind: "backend", url: src.url },
			...(d.target ? { target: { ...d.target } } : {}),
			startedAt: d.startedAt,
			finishedAt: d.finishedAt,
			rowsPerSecond: d.rowsPerSecond,
			rowsDone,
			// The total is the manifest's estimate (the old server's numbers move while it runs): never under what was done.
			rowsTotal: d.state === "done" ? rowsDone : Math.max(d.rowsTotal, rowsDone),
			steps: d.steps.map((s) => ({ ...s })),
			days: days.map((r) => ({ table: r.tbl, day: r.day, state: r.state, rowsSource: r.rows_source, rowsTarget: r.rows_target, note: r.note })),
			waitingFor: d.waitingFor,
			decision: d.decision ?? null,
			error: d.error,
		};
	}

	/** POST /v1/admin/migrate: start, pause, resume, cancel, resolve (a page cut off mid-send to Basin). */
	async act(body: StartBody): Promise<MigrateStatus> {
		const action = body.action;
		if (action === "start") await this.start(body);
		else if (action === "pause") await this.pause();
		else if (action === "resume") await this.resume();
		else if (action === "cancel") await this.cancel();
		else if (action === "resolve") await this.resolve(body);
		else if (action === "status") return this.status();
		else throw new MigrateError("action is start, pause, resume, cancel, resolve or status", 400);
		return this.status();
	}

	/** resolve { page, choice: resend | skip }: the page the job waits on goes again, or is left out. */
	private async resolve(body: StartBody): Promise<void> {
		const d = this.data;
		if (!d || d.state !== "needs_decision" || !d.decision) throw new MigrateError("no page waits for a decision (resolve is for a page cut off mid-send to Basin)", 409);
		if (typeof body.page !== "string" || body.page !== d.decision.page) throw new MigrateError(`page is the id the status names (${d.decision.page})`, 400);
		if (body.choice !== "resend" && body.choice !== "skip") throw new MigrateError("choice is resend or skip", 400);
		if (!this.token) throw new MigrateError("the send token is gone: start the move again (the days already sent stay sent)", 409);
		await this.loop;
		const changed = await this.o.db.run("UPDATE migrate_pages SET state = ?, at = ? WHERE id = ? AND state = 'sending'", [body.choice === "resend" ? "resend" : "skipped", this.clock(), body.page]);
		if (!changed.changes) throw new MigrateError("that page is no longer waiting", 409);
		d.state = "running";
		d.decision = null;
		d.error = null;
		await this.save();
		this.log(`migrate: page ${body.page} ${body.choice === "resend" ? "will be sent again" : "skipped"} by the owner`);
		this.launch();
	}

	private async start(body: StartBody): Promise<void> {
		const plan = this.parseStart(body);
		let rate = this.o.defaultRowsPerSecond;
		if (body.rowsPerSecond !== undefined) {
			if (typeof body.rowsPerSecond !== "number" || !Number.isSafeInteger(body.rowsPerSecond) || body.rowsPerSecond < 1 || body.rowsPerSecond > 10_000_000) throw new MigrateError("rowsPerSecond is 1 to 10,000,000", 400);
			rate = body.rowsPerSecond;
		}
		if (this.data && ["running", "waiting", "paused", "needs_decision"].includes(this.data.state)) throw new MigrateError(`a migration is ${this.data.state}: cancel it first (or resume it)`, 409);
		if (plan.direction !== "from-backend" && !this.o.analytics) throw new MigrateError("the analytics part is off on this server: a Basin move needs it", 409);
		await this.loop;
		const sealed = this.o.instanceKey().seal(TOKEN_PURPOSE, plan.token);
		// The cutover: the first day this server holds rows of its own (kept from an earlier run of the job: by then
		// imported days would look like its own).
		const prev = this.data;
		const cutoverDay = prev?.cutoverDay !== undefined && prev.direction !== "to-basin" ? prev.cutoverDay : await this.ownFirstDay();
		// The same old server again (after done, a cancel or a failure): the SQLite tables go on from their cursors (the
		// rows since come over, nothing twice); the tables merged by adding counts are not taken again.
		const sameSource = plan.direction === "from-backend" && prev?.direction === "from-backend" && prev.source.kind === "backend" && plan.source.kind === "backend" && prev.source.url === plan.source.url;
		// To the same Basin streams again: the days sent stay sent (Basin can't dedupe), unfinished ones go on at their page.
		const sameStreams = plan.direction === "to-basin" && prev?.direction === "to-basin" && prev.target?.events === plan.target?.events && prev.target?.recordings === plan.target?.recordings;
		this.data = {
			state: "running",
			direction: plan.direction,
			source: plan.source,
			...(plan.target ? { target: plan.target } : {}),
			decision: null,
			startedAt: this.clock(),
			finishedAt: null,
			rowsPerSecond: rate,
			rowsTotal: 0,
			fleetDone: 0,
			steps: emptySteps(),
			waitingFor: null,
			error: null,
			cutoverDay,
		};
		this.token = plan.token;
		if (!sameStreams) this.target.clear();
		await this.o.db.transaction((tx) => {
			if (!sameStreams) {
				tx.run("DELETE FROM migrate_days");
				tx.run("DELETE FROM migrate_pages");
			} else tx.run("UPDATE migrate_days SET verified = 0");
			if (sameSource) tx.run(`UPDATE migrate_cursors SET done = 0 WHERE tbl IN (${[...RESUMABLE].map((t) => `'${t}'`).join(", ")})`);
			else if (plan.direction === "from-backend") tx.run("DELETE FROM migrate_cursors");
			tx.run("INSERT INTO migrate_job (id, data, token) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, token = excluded.token", [JSON.stringify(this.data), sealed]);
		});
		this.log(`migrate: started (${plan.direction}${plan.source.kind === "backend" ? ` from ${plan.source.url}` : plan.source.kind === "basin" ? ` from Basin bucket ${plan.source.bucket}` : " to Basin"}) at ${rate} rows/s`);
		this.launch();
	}

	/** The direction of a `start` body, after its checks (the token is never part of an error). */
	private parseStart(body: StartBody): { direction: Direction; source: SourceRef; target?: { kind: "basin"; events: string; recordings: string }; token: string } {
		if (body.to !== undefined) {
			if (body.from !== undefined) throw new MigrateError("send from or to, not both", 400);
			const to = body.to as { kind?: unknown; events?: unknown; recordings?: unknown; token?: unknown } | null;
			if (!to || typeof to !== "object" || to.kind !== "basin") throw new MigrateError('to is { kind: "basin", events, recordings, token }', 400);
			let events: string;
			let recordings: string;
			try {
				events = checkStreamUrl(to.events, "to.events");
				recordings = checkStreamUrl(to.recordings, "to.recordings");
			} catch (error) {
				throw new MigrateError((error as Error).message, 400);
			}
			const token = checkToken(to.token, "to.token is the Basin send token", 20);
			return { direction: "to-basin", source: { kind: "local" }, target: { kind: "basin", events, recordings }, token };
		}
		const from = body.from as { kind?: unknown; url?: unknown; token?: unknown; accountId?: unknown; bucket?: unknown; namespace?: unknown } | undefined;
		if (!from || typeof from !== "object") throw new MigrateError('from is { kind: "backend", url, token } or { kind: "basin", accountId, bucket, token, namespace }', 400);
		if (from.kind === "basin") {
			if (typeof from.accountId !== "string" || !ACCOUNT_ID.test(from.accountId)) throw new MigrateError("from.accountId is a Cloudflare account id (32 hex characters)", 400);
			if (typeof from.bucket !== "string" || !BUCKET_NAME.test(from.bucket)) throw new MigrateError("from.bucket is the R2 bucket of the Basin catalog", 400);
			const namespace = from.namespace === undefined ? "typetorch" : from.namespace;
			if (typeof namespace !== "string" || !BASIN_IDENT.test(namespace)) throw new MigrateError("from.namespace is a Basin namespace (letters, digits, _)", 400);
			const token = checkToken(from.token, "from.token is the Basin SQL token", 20);
			return { direction: "from-basin", source: { kind: "basin", accountId: from.accountId.toLowerCase(), bucket: from.bucket, namespace }, token };
		}
		if (from.kind !== "backend") throw new MigrateError('from.kind is "backend" or "basin"', 400);
		const url = checkSourceUrl(from.url);
		if (typeof from.token !== "string" || from.token.length < 32 || from.token.length > 4096 || /\s/.test(from.token)) throw new MigrateError("from.token is the old server's admin token (32+ characters)", 400);
		return { direction: "from-backend", source: { kind: "backend", url }, token: from.token };
	}

	/** The first day with rows this server took in itself (live rows, raw files, day files); today when there are none. */
	private async ownFirstDay(): Promise<number> {
		const today = Math.floor(this.clock() / DAY_MS);
		const w = this.o.warehouse();
		if (!w) return today;
		let first = today;
		for (const table of EXPORT_TABLES) {
			const dir = table === "events" ? w.layout.events : w.layout.recordings;
			if (!existsSync(dir)) continue;
			for (const name of readdirSync(dir)) {
				const m = /^(\d{4}-\d{2}-\d{2})\.parquet$/.exec(name);
				if (m) first = Math.min(first, dayNumber(m[1] as string));
			}
			const row = (await w.sql(`SELECT MIN(t) AS t FROM live.${table}`))[0];
			if (row?.t !== null && row?.t !== undefined) first = Math.min(first, Math.floor(Number(row.t) / DAY_MS));
		}
		const oldest = w.raw.oldestPending();
		if (oldest !== undefined) first = Math.min(first, Math.floor(oldest / DAY_MS));
		return first;
	}

	private async pause(): Promise<void> {
		if (!this.data || !(this.data.state === "running" || this.data.state === "waiting")) throw new MigrateError(`nothing to pause (the migration is ${this.data?.state ?? "idle"})`, 409);
		await this.halted("pause");
		this.data.state = "paused";
		this.data.waitingFor = null;
		await this.save();
		this.log("migrate: paused");
	}

	private async resume(): Promise<void> {
		if (this.data?.state === "needs_decision") throw new MigrateError("a page waits for a decision: resolve it (resend or skip)", 409);
		if (!this.data || !(this.data.state === "paused" || this.data.state === "failed")) throw new MigrateError(`nothing to resume (the migration is ${this.data?.state ?? "idle"})`, 409);
		if (!this.token) throw new MigrateError("the migration's token is gone: start the migration again", 409);
		await this.loop;
		this.data.state = "running";
		this.data.error = null;
		for (const s of this.data.steps) if (s.state === "failed") s.state = "pending";
		await this.save();
		this.log("migrate: resumed");
		this.launch();
	}

	private async cancel(): Promise<void> {
		if (!this.data || ["done", "cancelled"].includes(this.data.state)) throw new MigrateError(`nothing to cancel (the migration is ${this.data?.state ?? "idle"})`, 409);
		await this.halted("cancel");
		this.data.state = "cancelled";
		this.data.finishedAt = this.clock();
		this.data.waitingFor = null;
		this.data.decision = null;
		this.token = undefined;
		this.target.clear();
		await this.o.db.run("UPDATE migrate_job SET data = ?, token = NULL WHERE id = 1", [JSON.stringify(this.data)]);
		this.log("migrate: cancelled (rows already imported stay)");
	}

	/** Stops the loop (pause, cancel, the server stopping) and waits for it, at most 10 s. */
	private async halted(why: "pause" | "cancel" | "stop"): Promise<void> {
		this.halt = why;
		this.controller.abort();
		if (why !== "pause") this.hardController.abort();
		const loop = this.loop;
		if (loop) await Promise.race([loop, new Promise((done) => setTimeout(done, 10_000).unref?.())]);
	}

	/** The server stops: the state stays as it is in SQLite (a running job goes on at the next start). */
	async stop(): Promise<void> {
		if (this.loop) await this.halted("stop");
	}

	private launch(): void {
		const id = ++this.runId;
		this.halt = undefined;
		this.controller = new AbortController();
		this.hardController = new AbortController();
		const d = this.data!;
		this.source = undefined;
		this.flow = undefined;
		if (d.source.kind === "backend") this.source = new BackendSource({ url: d.source.url, token: this.token!, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), sleep: this.sleep, ...(this.o.tries ? { tries: this.o.tries } : {}) });
		else if (d.source.kind === "basin") this.flow = new FromBasinFlow(this.host(), { accountId: d.source.accountId, bucket: d.source.bucket, namespace: d.source.namespace, token: this.token! });
		else if (d.target) this.flow = new ToBasinFlow(this.host(), { events: d.target.events, recordings: d.target.recordings });
		this.loop = this.run(id).finally(() => {
			if (this.runId === id) this.loop = undefined;
		});
	}

	private async save(): Promise<void> {
		if (this.data) await this.o.db.run("UPDATE migrate_job SET data = ? WHERE id = 1", [JSON.stringify(this.data)]);
	}

	private checkpoint(): void {
		if (this.halt || this.controller.signal.aborted) throw new Stopped();
	}

	private step(name: StepName): StepView {
		return this.data!.steps.find((s) => s.name === name)!;
	}

	private async run(id: number): Promise<void> {
		const d = this.data!;
		try {
			if (this.source) {
				const manifest = await this.manifest();
				if (manifest.server.instance && manifest.server.instance === this.o.instanceId()) throw new MigrateHttpError("that URL is this server: give the old server's address", 0, true);
			}
			if (this.flow instanceof ToBasinFlow) await this.flow.pending();
			for (const name of STEP_NAMES) {
				const s = this.step(name);
				if (s.state === "done") continue;
				s.state = "running";
				await this.save();
				await this.runStep(name);
				s.state = "done";
				await this.save();
			}
			d.state = "done";
			d.finishedAt = this.clock();
			d.waitingFor = null;
			this.token = undefined;
			await this.o.db.run("UPDATE migrate_job SET data = ?, token = NULL WHERE id = 1", [JSON.stringify(d)]);
			const days = await this.o.db.all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM migrate_days GROUP BY state");
			this.log(`migrate: done (${days.map((r) => `${r.n} ${r.state}`).join(", ") || "no days"})`);
		} catch (error) {
			if (this.runId !== id) return;
			if (error instanceof NeedsDecision) {
				d.state = "needs_decision";
				d.decision = error.decision;
				d.waitingFor = null;
				await this.save().catch(() => {});
				this.log(`migrate: needs a decision on page ${error.decision.page} (${error.decision.why})`);
				return;
			}
			if (error instanceof Stopped || this.halt) return;
			d.state = "failed";
			d.error = clean((error as Error).message ?? String(error));
			d.waitingFor = null;
			for (const s of d.steps) if (s.state === "running") s.state = "failed";
			await this.save().catch(() => {});
			this.log(`migrate: failed: ${d.error}`);
		}
	}

	private async manifest(): Promise<SourceManifest> {
		this.manifestCache = await this.source!.manifest(this.controller.signal);
		return this.manifestCache;
	}

	private async runStep(name: StepName): Promise<void> {
		if (this.flow && (await this.flow.runStep(name))) return;
		switch (name) {
			case "erased":
				return this.stepErased();
			case "identities":
				return this.importFleet("identities", this.step("identities"));
			case "fleet":
				return this.stepFleet();
			case "events":
			case "recordings":
				return this.stepTable(name);
			case "live":
				return this.stepLive();
			case "rollups":
				return this.stepRollups();
			case "verify":
				return this.stepVerify();
		}
	}

	// Steps 1-3 ------------------------------------------------------------------------------------------------------------

	private async stepErased(): Promise<void> {
		const s = this.step("erased");
		const pids = await this.source!.erased(this.controller.signal);
		s.total = pids.length;
		const w = this.o.warehouse();
		for (let i = 0; i < pids.length; i += 500) {
			this.checkpoint();
			const batch = pids.slice(i, i + 500);
			if (w) await w.erase(batch);
			await this.o.identities.deletePids(batch);
			await this.o.errors.erasePids(batch);
			s.done = Math.min(pids.length, i + batch.length);
			await this.save();
		}
		if (w && pids.length) void w.rewriteErased().catch((e) => this.log(`erasure rewrite failed: ${(e as Error).message}`));
		if (!w && pids.length) s.note = "analytics is off here: the erased pids only removed identities and error players";
	}

	private async stepFleet(): Promise<void> {
		const s = this.step("fleet");
		const manifest = this.manifestCache!;
		const tables = FLEET_EXPORT_TABLES.filter((t) => t !== "identities");
		s.total = tables.reduce((sum, t) => sum + (manifest.fleet[t]?.rows ?? 0), 0);
		for (const table of tables) await this.importFleet(table, s);
		// The runtime settings the old server's Settings page saved, unless this server saved its own.
		const settings = await this.source!.settings(this.controller.signal);
		const copied: string[] = [];
		for (const setting of settings) {
			if (!setting || typeof setting.key !== "string" || setting.source !== "dashboard" || !("value" in setting) || SETTINGS_NOT_COPIED.has(setting.key)) continue;
			try {
				if (this.o.runtime.source(setting.key as never) === "dashboard") continue;
				this.o.runtime.patchBySystem({ [setting.key]: setting.value }, "system (migration from the old server)");
				copied.push(setting.key);
			} catch {
				// Not a setting here, or a value this version refuses: left as it is.
			}
		}
		s.note = `${copied.length} runtime settings copied${copied.length ? ` (${copied.join(", ")})` : ""}; not copied: the webhook URL, the admin allow list, the token login`;
	}

	/** The columns of a table here (only those are written: a row's keys never reach the SQL otherwise). */
	private async columnsOf(table: string): Promise<Set<string> | undefined> {
		let cols = this.columns.get(table);
		if (!cols) {
			const rows = await this.o.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
			if (!rows.length) return undefined;
			cols = new Set(rows.map((r) => r.name));
			this.columns.set(table, cols);
		}
		return cols;
	}

	/** Pages one SQLite table over; each page and its cursor commit in one transaction (exactly once). */
	private async importFleet(table: FleetExportTable, s: StepView): Promise<void> {
		const manifest = this.manifestCache!;
		if (table === "identities") s.total = manifest.fleet.identities?.rows ?? 0;
		const cols = await this.columnsOf(table);
		const cursor = await this.o.db.first<{ after: number; done: number; rows: number }>("SELECT after, done, rows FROM migrate_cursors WHERE tbl = ?", [table]);
		if (cursor?.done) return;
		if (!cols || !manifest.fleet[table]) {
			await this.o.db.run("INSERT OR REPLACE INTO migrate_cursors (tbl, after, done, rows) VALUES (?, 0, 1, 0)", [table]);
			return;
		}
		let after = cursor?.after ?? 0;
		const size = this.o.pageSize?.fleet ?? 2000;
		for (;;) {
			this.checkpoint();
			const started = Date.now();
			const page = await this.source!.fleetPage(table, after, size, this.controller.signal);
			this.checkpoint();
			const erased = new Set(this.target.erasedPids());
			const rows = page.rows.filter((r) => !(table === "identities" || table === "error_pids") || (typeof r.pid === "string" && PID.test(r.pid) && !erased.has(r.pid)));
			const next = page.next;
			// The last page: the cursor moves to its last key, so a later run from the same server takes only what came since.
			const key = KEY_OF[table];
			const lastKey = key ? page.rows.reduce((max, r) => (typeof r[key] === "number" && Number.isSafeInteger(r[key]) ? Math.max(max, r[key] as number) : max), after) : after;
			await this.o.db.transaction((tx) => {
				for (const row of rows) insertFleetRow(tx, table, row, cols);
				tx.run("INSERT INTO migrate_cursors (tbl, after, done, rows) VALUES (?, ?, ?, ?) ON CONFLICT (tbl) DO UPDATE SET after = excluded.after, done = excluded.done, rows = rows + excluded.rows", [
					table,
					next ?? lastKey,
					next === null ? 1 : 0,
					page.rows.length,
				]);
			});
			this.data!.fleetDone += page.rows.length;
			s.done += page.rows.length;
			await this.save();
			await this.pace(page.rows.length, started);
			if (next === null) break;
			after = next;
		}
	}

	// Steps 4-8 ------------------------------------------------------------------------------------------------------------

	/** The days to import from the manifest (within this server's history setting), newest first. */
	private async planDays(table: ExportTable, manifest: SourceManifest): Promise<number> {
		const keep = this.o.keepDays();
		const today = Math.floor(this.clock() / DAY_MS);
		let skipped = 0;
		for (const d of manifest.tables[table]) {
			if (keep > 0 && dayNumber(d.day) < today - keep) {
				skipped++;
				continue;
			}
			await this.o.db.run("INSERT OR IGNORE INTO migrate_days (tbl, day, state, rows_source, hash_source) VALUES (?, ?, 'pending', ?, ?)", [table, d.day, d.rows, d.hash]);
		}
		const total = await this.o.db.first<{ n: number }>("SELECT COALESCE(SUM(rows_source), 0) AS n FROM migrate_days");
		this.data!.rowsTotal = Number(total?.n ?? 0) + Object.values(manifest.fleet).reduce((sum, f) => sum + f.rows, 0);
		return skipped;
	}

	private liveDays(manifest: SourceManifest): Set<string> {
		// The old server's live rows can span yesterday (before its nightly export) and today.
		const out = new Set<string>();
		if (manifest.live.day) {
			out.add(manifest.live.day);
			out.add(dayString(dayNumber(manifest.live.day) - 1));
		}
		return out;
	}

	private async stepTable(table: ExportTable): Promise<void> {
		const s = this.step(table);
		if (!this.o.analytics) {
			s.note = "analytics is off on this server";
			return;
		}
		const manifest = this.manifestCache!;
		const skipped = await this.planDays(table, manifest);
		if (skipped) s.note = `${skipped} days older than this server's analytics history setting not imported`;
		const live = this.liveDays(manifest);
		const days = await this.o.db.all<DayRow>("SELECT * FROM migrate_days WHERE tbl = ? ORDER BY day DESC", [table]);
		s.total = days.length;
		s.done = days.filter((d) => d.state !== "pending" && d.state !== "importing").length;
		for (const day of days) {
			if (day.state !== "pending" && day.state !== "importing") continue;
			await this.importDay(day);
			// The days that also hold this server's rows, or the old server's live rows, are checked once it is quiet.
			if (dayNumber(day.day) < this.data!.cutoverDay && !live.has(day.day)) await this.verifyDay(day);
			else await this.setDay(day, { note: "checked once the old server is quiet" });
			s.done++;
			await this.save();
		}
	}

	/** Imports a day from its cursor: page by page, staged, merged every `mergeRows` and at the end. */
	private async importDay(day: DayRow): Promise<void> {
		const size = day.page_size || (this.o.pageSize?.[day.tbl] ?? (day.tbl === "events" ? 50_000 : 1000));
		await this.setDay(day, { state: "importing", page_size: size });
		const mergeRows = this.o.mergeRows ?? 1_000_000;
		let page = day.next_page;
		for (;;) {
			await this.waitForRoom();
			const started = Date.now();
			const file = this.target.pageFile(day.tbl, day.day, page);
			const got = await this.source!.readPage(day.tbl, day.day, page, size, file, this.controller.signal);
			this.checkpoint();
			const passRows = day.pass_rows + got.rows;
			await this.setDay(day, { next_page: page + 1, staged_rows: day.staged_rows + got.rows, pass_rows: passRows, imported: Math.max(day.imported, passRows) });
			await this.o.onPage?.(day.tbl, day.day, page);
			if (got.last || day.staged_rows >= mergeRows) {
				await this.target.flushDay(day.tbl, day.day);
				await this.setDay(day, { staged_rows: 0 });
			}
			await this.pace(got.rows, started);
			if (got.last) break;
			page++;
		}
	}

	/** Re-imports a day from its first page (idempotent: exact duplicates drop at the merge). */
	private async reimport(day: DayRow, source?: DayStat): Promise<void> {
		await this.setDay(day, { next_page: 0, staged_rows: 0, pass_rows: 0, verified: 0, ...(source ? { rows_source: source.rows, hash_source: source.hash } : {}) });
		await this.importDay(day);
	}

	/**
	 * Days before the cutover: (rows, hash) must equal the old server's, minus the pids erased here since. The cutover
	 * days: every old row must be here (an anti-join, page by page). A day that fails is imported again once, then left
	 * for the owner (`missing <n>` or `differs`).
	 */
	private async verifyDay(day: DayRow): Promise<void> {
		const exact = dayNumber(day.day) < this.data!.cutoverDay;
		const here = await this.target.dayHash(day.tbl, day.day);
		const exclude = await this.excludeList();
		const source = exclude.length ? await this.source!.dayHash(day.tbl, day.day, exclude, this.controller.signal) : { rows: day.rows_source, hash: day.hash_source };
		if (exact && here.rows === source.rows && here.hash === source.hash) return this.setDay(day, { state: "match", rows_target: here.rows, verified: 1, note: "" });
		const missing = await this.countMissing(day);
		if (missing === 0 && !exact) {
			const extra = here.rows - source.rows;
			return this.setDay(day, { state: "match", rows_target: here.rows, verified: 1, note: extra > 0 ? `superset: ${extra} rows only on this server` : "superset" });
		}
		if (day.tries < 1) {
			await this.setDay(day, { tries: day.tries + 1 });
			await this.reimport(day);
			return this.verifyDay(day);
		}
		if (missing > 0) return this.setDay(day, { state: "missing", rows_target: here.rows, verified: 1, note: `missing ${missing}` });
		return this.setDay(day, { state: "differs", rows_target: here.rows, verified: 1, note: `differs: ${here.rows} rows here, ${day.rows_source} on the old server` });
	}

	/** The pids erased here that the old server still serves (its own erased ones are left out of its answers already). */
	private async excludeList(): Promise<string[]> {
		const here = this.target.erasedPids();
		if (!here.length) return [];
		const there = new Set(await this.source!.erased(this.controller.signal));
		return here.filter((p) => !there.has(p));
	}

	/** Old rows of a day missing here, page by page. */
	private async countMissing(day: DayRow): Promise<number> {
		const size = day.page_size || (this.o.pageSize?.[day.tbl] ?? (day.tbl === "events" ? 50_000 : 1000));
		let missing = 0;
		for (let page = 0; ; page++) {
			await this.waitForRoom();
			const started = Date.now();
			const file = this.target.scratchFile();
			try {
				const got = await this.source!.readPage(day.tbl, day.day, page, size, file, this.controller.signal);
				if (got.rows) missing += await this.target.missing(day.tbl, day.day, file);
				await this.pace(got.rows, started);
				if (got.last) break;
			} finally {
				rmSync(file, { force: true });
			}
		}
		return missing;
	}

	/** Step 6: waits until the old server is quiet, then imports what changed meanwhile and checks the days left. */
	private async stepLive(): Promise<void> {
		const s = this.step("live");
		if (!this.o.analytics) {
			s.note = "analytics is off on this server";
			return;
		}
		const quietMs = this.o.quietMs ?? 10 * 60_000;
		let manifest = await this.manifest();
		for (;;) {
			this.checkpoint();
			const last = manifest.live.lastRt;
			const quietFor = last === null ? Infinity : manifest.server.now - last;
			if (manifest.live.rows === 0 || quietFor >= quietMs) break;
			this.data!.state = "waiting";
			this.data!.waitingFor = `the old server's live rows to go quiet (last row ${Math.max(0, Math.round(quietFor / 60_000))} min ago; it waits for ${Math.round(quietMs / 60_000)} min)`;
			await this.save();
			await this.sleep(this.o.pollMs ?? 60_000, this.controller.signal);
			this.checkpoint();
			manifest = await this.manifest();
		}
		this.data!.state = "running";
		this.data!.waitingFor = null;
		await this.save();
		await this.syncDays(manifest, s);
	}

	/** Imports the days the manifest shows changed (or new) since they were imported, then checks every unchecked day. */
	private async syncDays(manifest: SourceManifest, s: StepView): Promise<void> {
		for (const table of EXPORT_TABLES) await this.planDays(table, manifest);
		const days = await this.o.db.all<DayRow>("SELECT * FROM migrate_days ORDER BY CASE tbl WHEN 'events' THEN 0 ELSE 1 END, day DESC");
		const bySource = new Map(EXPORT_TABLES.flatMap((t) => manifest.tables[t].map((d) => [`${t}:${d.day}`, d] as const)));
		s.total = days.length;
		s.done = 0;
		for (const day of days) {
			this.checkpoint();
			const now = bySource.get(`${day.tbl}:${day.day}`);
			if (now && (now.rows !== day.rows_source || now.hash !== day.hash_source)) {
				await this.setDay(day, { tries: 0 });
				await this.reimport(day, now);
				await this.verifyDay(day);
			} else if (day.state === "pending" || day.state === "importing") {
				if (day.state === "pending" || day.next_page === 0) await this.importDay(day);
				await this.verifyDay(day);
			} else if (!day.verified) await this.verifyDay(day);
			s.done++;
			await this.save();
		}
	}

	private async stepRollups(): Promise<void> {
		const s = this.step("rollups");
		if (!this.o.analytics) {
			s.note = "analytics is off on this server";
			return;
		}
		const days = (await this.o.db.all<{ day: string }>("SELECT DISTINCT day FROM migrate_days WHERE tbl = 'events' ORDER BY day")).map((r) => r.day);
		s.total = days.length;
		for (let i = 0; i < days.length; i += 30) {
			this.checkpoint();
			await this.target.rollups(days.slice(i, i + 30));
			s.done = Math.min(days.length, i + 30);
			await this.save();
		}
	}

	/** Step 8: the old server once more (its nightly export may have moved rows since), every day checked again. */
	private async stepVerify(): Promise<void> {
		const s = this.step("verify");
		if (!this.o.analytics) {
			s.note = "analytics is off on this server";
			return;
		}
		const manifest = await this.manifest();
		await this.o.db.run("UPDATE migrate_days SET verified = 0 WHERE state IN ('match', 'missing', 'differs', 'duplicates')");
		await this.syncDays(manifest, s);
		const changed = (await this.o.db.all<{ day: string }>("SELECT day FROM migrate_days WHERE tbl = 'events' AND tries > 0")).map((r) => r.day);
		if (changed.length) await this.target.rollups(changed);
		const bad = await this.o.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM migrate_days WHERE state <> 'match'");
		s.note = Number(bad?.n ?? 0) ? `${bad?.n} days are not a match: see the report` : "every day matches";
	}

	private async setDay(day: DayRow, change: Partial<DayRow>): Promise<void> {
		Object.assign(day, change);
		await this.o.db.run(
			"UPDATE migrate_days SET state = ?, rows_source = ?, hash_source = ?, rows_target = ?, next_page = ?, page_size = ?, staged_rows = ?, pass_rows = ?, imported = ?, tries = ?, verified = ?, note = ?, cursor = ? WHERE tbl = ? AND day = ?",
			[day.state, day.rows_source, day.hash_source, day.rows_target, day.next_page, day.page_size, day.staged_rows, day.pass_rows, day.imported, day.tries, day.verified, day.note, day.cursor ?? "", day.tbl, day.day],
		);
	}

	/** What a Basin flow borrows from the job. */
	private host(): FlowHost {
		const k = this.o.basin ?? {};
		const self = this;
		return {
			db: this.o.db,
			analytics: this.o.analytics,
			clock: this.clock,
			log: this.log,
			get job() {
				return self.data!;
			},
			target: this.target,
			dir: join(this.o.dataDir, "migrate"),
			fetch: this.o.fetch ?? fetch,
			knobs: {
				endpoint: k.endpoint ?? BASIN_SQL_API,
				pageRows: Math.max(1, Math.min(10_000, k.pageRows ?? 10_000)),
				windowRows: Math.max(1, k.windowRows ?? 50_000),
				settleMs: k.settleMs ?? 10 * 60_000,
				sendBytes: Math.max(1024, Math.min(4.5 * 1024 * 1024, k.sendBytes ?? 4 * 1024 * 1024)),
				sendRows: Math.max(1, k.sendRows ?? 10_000),
				rollWaitMs: k.rollWaitMs ?? 10 * 60_000,
				rollPollMs: Math.max(1, k.rollPollMs ?? 30_000),
				timeoutMs: k.timeoutMs ?? 25_000,
				tries: Math.max(1, k.tries ?? this.o.tries ?? 6),
			},
			mergeRows: this.o.mergeRows ?? 1_000_000,
			quietMs: this.o.quietMs ?? 10 * 60_000,
			pollMs: this.o.pollMs ?? 60_000,
			basinRead: this.o.basinRead,
			warehouse: () => this.o.warehouse(),
			keepDays: () => this.o.keepDays(),
			token: () => {
				if (!this.token) throw new Stopped();
				return this.token;
			},
			signal: () => this.controller.signal,
			hardSignal: () => this.hardController.signal,
			sleep: (ms) => this.sleep(ms, this.controller.signal),
			save: () => this.save(),
			checkpoint: () => this.checkpoint(),
			stopped: () => {
				throw new Stopped();
			},
			pace: (rows, startedAt) => this.pace(rows, startedAt),
			waitForRoom: () => this.waitForRoom(),
			step: (name) => this.step(name),
			setDay: (day, change) => this.setDay(day, change),
		};
	}

	// Throttle -------------------------------------------------------------------------------------------------------------

	/** Live ingest first: waits while analytics isn't open here, the loader is behind, or a query runs (at most queryWaitMs). */
	private async waitForRoom(): Promise<void> {
		const d = this.data!;
		let queryWait = 0;
		for (;;) {
			this.checkpoint();
			const w = this.o.warehouse();
			let why: string | null = null;
			if (!w) why = "analytics to open on this server";
			else {
				const oldest = w.raw.oldestPending();
				if (oldest !== undefined && this.clock() - oldest > 2 * this.o.loadSeconds * 1000) why = "the loader to catch up with live ingest";
				else if (w.queriesRunning > 0 && queryWait < (this.o.queryWaitMs ?? 30_000)) {
					queryWait += 250;
					await this.sleep(250, this.controller.signal);
					continue;
				}
			}
			if (!why) break;
			if (d.waitingFor !== why) {
				d.waitingFor = why;
				await this.save();
			}
			await this.sleep(1000, this.controller.signal);
		}
		if (d.waitingFor && d.state === "running") {
			d.waitingFor = null;
			await this.save();
		}
	}

	/** The rows-per-second cap: a page of `rows` takes at least rows / rate seconds. */
	private async pace(rows: number, startedAt: number): Promise<void> {
		const wantMs = (rows * 1000) / Math.max(1, this.data!.rowsPerSecond);
		const left = wantMs - (Date.now() - startedAt);
		if (left > 0) await this.sleep(left, this.controller.signal);
		this.checkpoint();
	}
}

/** One row of a SQLite table from the old server, merged by the table's rules. Only this server's columns are written. */
function insertFleetRow(tx: SyncTx, table: FleetExportTable, row: Record<string, unknown>, cols: Set<string>): void {
	const names: string[] = [];
	const values: SqlValue[] = [];
	for (const [key, raw] of Object.entries(row)) {
		if (!cols.has(key)) continue;
		if (NEW_KEYS.has(table) && key === "id") continue;
		let value: SqlValue;
		if (raw === null || raw === undefined) value = null;
		else if (typeof raw === "number") value = Number.isFinite(raw) ? raw : null;
		else if (typeof raw === "boolean") value = raw ? 1 : 0;
		else if (typeof raw === "string") value = raw.length > STRING_MAX ? raw.slice(0, STRING_MAX) : raw;
		else continue;
		names.push(`"${key}"`);
		values.push(value);
	}
	if (!names.length) return;
	const head = `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
	switch (table) {
		case "identities":
			tx.run(`${head} ON CONFLICT (pid) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`, values);
			return;
		case "error_kinds":
			tx.run(
				`${head} ON CONFLICT (fp) DO UPDATE SET first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at), total = total + excluded.total, ` +
					`last_branch = CASE WHEN excluded.last_at > last_at THEN excluded.last_branch ELSE last_branch END, last_build = CASE WHEN excluded.last_at > last_at THEN excluded.last_build ELSE last_build END`,
				values,
			);
			return;
		case "error_counts":
			tx.run(`${head} ON CONFLICT (fp, minute, branch, build, realm) DO UPDATE SET n = n + excluded.n`, values);
			return;
		case "error_jobs":
			tx.run(`${head} ON CONFLICT (fp, job, realm, branch, build) DO UPDATE SET n = n + excluded.n, first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`, values);
			return;
		case "deploys":
		case "error_pids":
		case "saved_queries":
			tx.run(head.replace("INSERT INTO", "INSERT OR IGNORE INTO"), values);
			return;
		default:
			tx.run(head, values);
	}
}

/** One line, no control characters, at most 300 characters (an error from the network or the old server). */
function clean(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((done, fail) => {
		if (signal.aborted) return fail(new Stopped());
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			done();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			fail(new Stopped());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
