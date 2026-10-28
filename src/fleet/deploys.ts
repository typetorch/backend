/**
 * Deploy history: every release in the deploys table (the CLI's POST /v1/fleet/deploy, or one known only from its
 * servers' reports), newest first, with its outcome: servers per report result (each server's newest report), how many
 * swapped or booted fine, failed or rolled back, were stuck, and its most common deploy errors.
 *
 * Reports are kept 30 days (KEEP_REPORTS_MS) and releases longer (the deployKeepDays setting, a year by default). While
 * a release's reports are all still there, its outcome is counted from them on every read; a day before the oldest of
 * them would go, the hourly retention writes the counts onto the release's row ("frozen", `summary_at`), and from then
 * on that row is what the history shows. A release's reports all arrive after its row exists (a report inserts the row
 * when the CLI's post never came), so a release younger than KEEP_REPORTS_MS has every one of its reports.
 *
 * Portable like the rest of the fleet core: FleetDb only, no Node APIs.
 */
import type { FleetDb, SqlValue } from "./db.ts";

/** Report results that count as a server running the release. */
export const DEPLOY_OK_RESULTS: readonly string[] = ["swapped", "booted", "skipped"];
/** Report results that count as a failed swap (rolled_back: the kernel went back to the build before). */
export const DEPLOY_FAILED_RESULTS: readonly string[] = ["failed", "rolled_back"];
/** Releases are kept this long by default (the deployKeepDays runtime setting, TYPETORCH_DEPLOY_KEEP_DAYS). */
export const KEEP_DEPLOYS_DAYS = 365;
/**
 * And at most this many rows (the newest by arrival): the CLI posts at most 30 a minute and every report with a new seq
 * adds a row, so a leaked game key could otherwise grow the table for a year. A team shipping 25 times a day fits a year.
 */
export const DEPLOYS_MAX_ROWS = 10_000;
/** A release's most common deploy errors kept on its row, and each one's length at most. */
export const DEPLOY_ERRORS_KEPT = 5;
export const DEPLOY_ERROR_TEXT_MAX = 300;
/** GET /v1/fleet/deploys: rows per page by default and at most. */
export const DEPLOYS_PAGE_DEFAULT = 50;
export const DEPLOYS_PAGE_MAX = 100;
/** Releases counted from their reports per statement (each a few thousand report rows at most). */
const SUMMARY_CHUNK = 20;
/** Releases frozen per hourly run at most (the rest wait an hour; normally a handful are due). */
const FREEZE_PER_RUN = 500;

/** Columns added to the deploys table for the history (to files made before it). */
export const ADDED_DEPLOY_HISTORY_COLUMNS: [string, string][] = [
	["started_by", "TEXT"],
	["summary_at", "INTEGER"],
	["reported", "INTEGER"],
	["ok", "INTEGER"],
	["failed", "INTEGER"],
	["stuck", "INTEGER"],
	["results", "TEXT"],
	["errors", "TEXT"],
	["error_kinds", "INTEGER"],
	["first_report", "INTEGER"],
	["last_report", "INTEGER"],
];

/**
 * pending: no verdict yet (no report, and the stuck window is still open); ok: every server that reported runs it;
 * partial: some failed, some run it; failed: every server that reported failed; stuck: servers sent no report 3 minutes
 * after the start (the server_stuck alert); no_reports: nothing reported and the window is over (or the reports were
 * gone before the history was kept).
 */
export const DEPLOY_OUTCOMES = ["pending", "ok", "partial", "failed", "stuck", "no_reports"] as const;
export type DeployOutcome = (typeof DEPLOY_OUTCOMES)[number];

export interface DeploySummary {
	/** Servers that reported (each server's newest report counts). */
	reported: number;
	ok: number;
	failed: number;
	/** Servers still below the seq with no report 3 minutes after the start (set by the sweep's server_stuck check). */
	stuck: number;
	/** Servers per report result. */
	results: Record<string, number>;
	/** The most common deploy errors (at most DEPLOY_ERRORS_KEPT, each cut to DEPLOY_ERROR_TEXT_MAX). */
	errors: { error: string; servers: number }[];
	/** Distinct errors in all. */
	errorKinds: number;
	firstReport: number | null;
	lastReport: number | null;
}

/** One release in the history. */
export interface DeployRecord extends Omit<DeploySummary, "firstReport" | "lastReport"> {
	seq: number;
	branch: string | null;
	artifact: string | null;
	channel: string | null;
	/** deploy, rollback, promote, resign; "deploy" for one known only from reports (`inferred`). */
	kind: string;
	inferred: boolean;
	/** rollback / promote: the build the branch ran before. */
	from: string | null;
	message: string | null;
	/** Who or what started it, when the CLI said (`by`: a user, "ci", "auto_rollback"...). */
	startedBy: string | null;
	/** When it started (the CLI's time, else when the backend first heard of it), unix ms and ISO. */
	at: number;
	startedAt: string;
	firstReport: string | null;
	lastReport: string | null;
	outcome: DeployOutcome;
	/** The counts come from the row (the reports are gone or about to go), not from the reports. */
	frozen: boolean;
}

export interface DeployRow {
	seq: number;
	branch: string | null;
	artifact: string | null;
	channel: string | null;
	t: number | null;
	received: number;
	kind: string | null;
	from_artifact: string | null;
	message: string | null;
	started_by: string | null;
	summary_at: number | null;
	reported: number | null;
	ok: number | null;
	failed: number | null;
	stuck: number | null;
	results: string | null;
	errors: string | null;
	error_kinds: number | null;
	first_report: number | null;
	last_report: number | null;
}

export const DEPLOY_ROW_COLUMNS =
	"seq, branch, artifact, channel, t, received, kind, from_artifact, message, started_by, summary_at, reported, ok, failed, stuck, results, errors, error_kinds, first_report, last_report";

/** Lets other work run between chunks (setTimeout exists on Bun, Node and Workers). */
const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const toMs = (t: number | null) => (t === null ? null : t < 1e11 ? t * 1000 : t);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** When a release started: the CLI's time (ms; older rows may hold seconds), else its row's arrival. */
export function deployAt(r: Pick<DeployRow, "t" | "received">): number {
	return toMs(r.t) ?? r.received;
}

export function deployOutcome(s: Pick<DeploySummary, "reported" | "ok" | "failed" | "stuck">, at: number, now: number, stuckWindowMs: number): DeployOutcome {
	if (s.failed > 0) return s.ok > 0 ? "partial" : "failed";
	if (s.stuck > 0) return "stuck";
	if (s.reported === 0) return now - at < stuckWindowMs ? "pending" : "no_reports";
	return "ok";
}

const emptySummary = (): DeploySummary => ({ reported: 0, ok: 0, failed: 0, stuck: 0, results: {}, errors: [], errorKinds: 0, firstReport: null, lastReport: null });

/** Counts each release's outcome from its reports (each server's newest), in chunks with a yield in between. `stuck` stays 0. */
export async function summarize(db: FleetDb, seqs: readonly number[]): Promise<Map<number, DeploySummary>> {
	const out = new Map<number, DeploySummary>();
	for (let i = 0; i < seqs.length; i += SUMMARY_CHUNK) {
		if (i > 0) await yieldLoop();
		const chunk = seqs.slice(i, i + SUMMARY_CHUNK);
		const marks = chunk.map(() => "?").join(", ");
		const latest = `SELECT seq, job, MAX(id) AS id FROM reports WHERE seq IN (${marks}) GROUP BY seq, job`;
		const counts = await db.all<{ seq: number; result: string; servers: number }>(
			`SELECT r.seq AS seq, r.result AS result, COUNT(*) AS servers FROM reports r JOIN (${latest}) l ON l.id = r.id GROUP BY r.seq, r.result`,
			chunk as SqlValue[],
		);
		const errors = await db.all<{ seq: number; error: string; servers: number }>(
			`SELECT r.seq AS seq, r.error AS error, COUNT(*) AS servers FROM reports r JOIN (${latest}) l ON l.id = r.id WHERE r.error IS NOT NULL GROUP BY r.seq, r.error ORDER BY r.seq, servers DESC, r.error`,
			chunk as SqlValue[],
		);
		const times = await db.all<{ seq: number; first: number; last: number }>(
			`SELECT seq, MIN(received) AS first, MAX(received) AS last FROM reports WHERE seq IN (${marks}) GROUP BY seq`,
			chunk as SqlValue[],
		);
		const of = (seq: number) => {
			let s = out.get(seq);
			if (!s) out.set(seq, (s = emptySummary()));
			return s;
		};
		for (const c of counts) {
			const s = of(c.seq);
			s.results[c.result] = c.servers;
			s.reported += c.servers;
			if (DEPLOY_OK_RESULTS.includes(c.result)) s.ok += c.servers;
			if (DEPLOY_FAILED_RESULTS.includes(c.result)) s.failed += c.servers;
		}
		for (const e of errors) {
			const s = of(e.seq);
			s.errorKinds++;
			if (s.errors.length < DEPLOY_ERRORS_KEPT) s.errors.push({ error: e.error.slice(0, DEPLOY_ERROR_TEXT_MAX), servers: e.servers });
		}
		for (const t of times) {
			const s = of(t.seq);
			s.firstReport = t.first;
			s.lastReport = t.last;
		}
	}
	return out;
}

function parseJson<T>(text: string | null, fallback: T): T {
	if (!text) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

/** The counts kept on a frozen row. */
function storedSummary(r: DeployRow): DeploySummary {
	return {
		reported: r.reported ?? 0,
		ok: r.ok ?? 0,
		failed: r.failed ?? 0,
		stuck: r.stuck ?? 0,
		results: parseJson<Record<string, number>>(r.results, {}),
		errors: parseJson<{ error: string; servers: number }[]>(r.errors, []),
		errorKinds: r.error_kinds ?? 0,
		firstReport: r.first_report,
		lastReport: r.last_report,
	};
}

export function deployRecord(r: DeployRow, summary: DeploySummary | undefined, now: number, stuckWindowMs: number): DeployRecord {
	const frozen = r.summary_at !== null;
	const s = frozen ? storedSummary(r) : { ...(summary ?? emptySummary()), stuck: r.stuck ?? 0 };
	const at = deployAt(r);
	return {
		seq: r.seq,
		branch: r.branch,
		artifact: r.artifact,
		channel: r.channel,
		kind: r.kind ?? "deploy",
		inferred: r.kind === null,
		from: r.from_artifact,
		message: r.message,
		startedBy: r.started_by,
		at,
		startedAt: new Date(at).toISOString(),
		reported: s.reported,
		ok: s.ok,
		failed: s.failed,
		stuck: s.stuck,
		results: s.results,
		errors: s.errors,
		errorKinds: s.errorKinds,
		firstReport: iso(s.firstReport),
		lastReport: iso(s.lastReport),
		outcome: deployOutcome(s, at, now, stuckWindowMs),
		frozen,
	};
}

/** Rows to records: the live ones counted from their reports, the frozen ones from the row. */
export async function deployRecords(db: FleetDb, rows: DeployRow[], now: number, stuckWindowMs: number): Promise<DeployRecord[]> {
	const live = await summarize(
		db,
		rows.filter((r) => r.summary_at === null).map((r) => r.seq),
	);
	return rows.map((r) => deployRecord(r, live.get(r.seq), now, stuckWindowMs));
}

export interface DeployListOptions {
	branch?: string;
	/** The page before this seq (the previous page's `next`). */
	before?: number;
	limit?: number;
}

/** One page of the history, newest (highest seq) first; `next` is the cursor for the page after, null at the end. */
export async function listDeploys(db: FleetDb, now: number, stuckWindowMs: number, options: DeployListOptions = {}): Promise<{ deploys: DeployRecord[]; next: number | null }> {
	const limit = Math.min(Math.max(1, options.limit ?? DEPLOYS_PAGE_DEFAULT), DEPLOYS_PAGE_MAX);
	const where: string[] = [];
	const params: SqlValue[] = [];
	if (options.before !== undefined) {
		where.push("seq < ?");
		params.push(options.before);
	}
	if (options.branch) {
		where.push("branch = ?");
		params.push(options.branch);
	}
	params.push(limit + 1);
	const rows = await db.all<DeployRow>(`SELECT ${DEPLOY_ROW_COLUMNS} FROM deploys${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, params);
	const page = rows.slice(0, limit);
	return { deploys: await deployRecords(db, page, now, stuckWindowMs), next: rows.length > limit ? page[page.length - 1].seq : null };
}

/**
 * Writes the counts onto the rows of releases whose oldest reports go within a day (or are already gone), so the
 * history keeps them; frozen rows are never counted again. At most FREEZE_PER_RUN a run, oldest first.
 */
export async function freezeSummaries(db: FleetDb, now: number, keepReportsMs: number): Promise<number> {
	const due = await db.all<{ seq: number }>("SELECT seq FROM deploys WHERE summary_at IS NULL AND received < ? ORDER BY received LIMIT ?", [now - keepReportsMs + 86_400_000, FREEZE_PER_RUN]);
	for (let i = 0; i < due.length; i += SUMMARY_CHUNK) {
		const chunk = due.slice(i, i + SUMMARY_CHUNK).map((d) => d.seq);
		const counts = await summarize(db, chunk);
		await db.transaction((tx) => {
			for (const seq of chunk) {
				const s = counts.get(seq) ?? emptySummary();
				tx.run(
					"UPDATE deploys SET summary_at = ?, reported = ?, ok = ?, failed = ?, results = ?, errors = ?, error_kinds = ?, first_report = ?, last_report = ? WHERE seq = ? AND summary_at IS NULL",
					[now, s.reported, s.ok, s.failed, JSON.stringify(s.results), JSON.stringify(s.errors), s.errorKinds, s.firstReport, s.lastReport, seq],
				);
			}
		});
		await yieldLoop();
	}
	return due.length;
}

/** Releases older than `keepDays`, and past DEPLOYS_MAX_ROWS the oldest arrivals. */
export async function pruneDeploys(db: FleetDb, now: number, keepDays: number, maxRows = DEPLOYS_MAX_ROWS): Promise<void> {
	await db.run("DELETE FROM deploys WHERE received < ?", [now - keepDays * 86_400_000]);
	await db.run("DELETE FROM deploys WHERE seq IN (SELECT seq FROM deploys ORDER BY received DESC, seq DESC LIMIT -1 OFFSET ?)", [maxRows]);
}
