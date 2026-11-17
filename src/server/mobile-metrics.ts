/**
 * The mobile app's widget stats (GET /v1/mobile/live?metrics=a,b,c; mobile docs WIDGET_STATS.md, section 1): numbers the
 * person picks per widget, each with the same number for the window right before. Aggregates only: no player id or name
 * goes in or out of here.
 *
 * Every number comes from a named query the explorer already runs, with the dashboard's default filters (no branch,
 * channel or audience filter; the queries' own Studio rules):
 *   - `dau` / `wau` / `mau` / `new:<w>`: `overview` (players, new players) over the last 24 h / 7 d / 30 d / the window,
 *     and again over the window before;
 *   - `d1` / `d7`: `retention` (days [1] / [7]) over the two latest complete join-day cohorts;
 *   - `session:<w>` / `playtime:<w>` / `sessions:<w>`: `session-time` (by end, no merge: the Session time page's default)
 *     over the window; its `previous` is the window before;
 *   - `revenue:<w>` / `payers:<w>`: `monetization` (Robux players paid, payers) over the window, and the window before;
 *   - `ccu`, `servers`, `peakToday`: the endpoint's own top-level fields.
 * One computation ("source") serves every metric that reads it (`session:1h` and `playtime:1h` are one session-time run).
 * Each source is cached METRIC_TTL_MS (`mau` and `d7` METRIC_SLOW_TTL_MS), one computation at a time per source and at
 * most METRIC_CONCURRENCY at once; a failed one keeps the last good numbers (retried after a minute). A request waits at
 * most `waitMs` for a computation (the phone's timeout is 10 s); a slower one finishes in the background for the next
 * poll. At most METRIC_ENTRIES_MAX sources are kept (least recently asked go first).
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Ids answered per request; ids past it answer null. */
export const METRICS_MAX = 12;
/** The `metrics` parameter's length, characters (longer: 400). */
export const METRICS_PARAM_MAX = 1000;
export const METRIC_TTL_MS = 5 * MINUTE;
/** `mau` and `d7`: heavier reads. */
export const METRIC_SLOW_TTL_MS = 15 * MINUTE;
/** After a failed computation, the next try waits this long (the last good numbers are served meanwhile). */
const METRIC_RETRY_MS = MINUTE;
export const METRIC_ENTRIES_MAX = 64;
export const METRIC_CONCURRENCY = 2;
/** How long a request waits for a computation. */
export const METRIC_WAIT_MS = 8000;

export type MetricUnit = "count" | "ratio" | "robux" | "seconds" | "hours";

export interface MetricValue {
	value: number | null;
	/** The same metric for the window right before (null when unknown). */
	prev: number | null;
	unit: MetricUnit;
	label: string;
}

/** A source's numbers by field; `<field>Prev` is the window before. */
export type Numbers = Record<string, number | null>;

export interface MetricSpec {
	id: string;
	unit: MetricUnit;
	label: string;
	/** The source it reads ("live" = the endpoint's own fields) and the field in it. */
	source: string;
	field: string;
	ttlMs: number;
}

/** `<n>h` (1..72) or `<n>d` (1..90) as ms; undefined otherwise (no leading zeros, no other units). */
export function parseWindow(raw: string): number | undefined {
	const m = /^([1-9]\d?)([hd])$/.exec(raw);
	if (!m) return undefined;
	const n = Number(m[1]);
	if (m[2] === "h") return n <= 72 ? n * HOUR : undefined;
	return n <= 90 ? n * DAY : undefined;
}

const FIXED: Record<string, Omit<MetricSpec, "id" | "ttlMs"> & { ttlMs?: number }> = {
	ccu: { unit: "count", label: "CCU", source: "live", field: "ccu" },
	servers: { unit: "count", label: "Servers", source: "live", field: "servers" },
	peakToday: { unit: "count", label: "Peak today", source: "live", field: "peakToday" },
	dau: { unit: "count", label: "DAU", source: `players:${DAY}`, field: "players" },
	wau: { unit: "count", label: "WAU", source: `players:${7 * DAY}`, field: "players" },
	mau: { unit: "count", label: "MAU", source: `players:${30 * DAY}`, field: "players", ttlMs: METRIC_SLOW_TTL_MS },
	d1: { unit: "ratio", label: "D1", source: "retention:1", field: "retention" },
	d7: { unit: "ratio", label: "D7", source: "retention:7", field: "retention", ttlMs: METRIC_SLOW_TTL_MS },
};

const WINDOWED: Record<string, { unit: MetricUnit; label: string; source: "players" | "sessions" | "money"; field: string }> = {
	new: { unit: "count", label: "New", source: "players", field: "new" },
	session: { unit: "seconds", label: "Session", source: "sessions", field: "session" },
	playtime: { unit: "hours", label: "Playtime", source: "sessions", field: "playtime" },
	sessions: { unit: "count", label: "Sessions", source: "sessions", field: "sessions" },
	revenue: { unit: "robux", label: "Revenue", source: "money", field: "revenue" },
	payers: { unit: "count", label: "Payers", source: "money", field: "payers" },
};

/** A metric id's spec, or null for an unknown or invalid one. */
export function parseMetricId(id: string): MetricSpec | null {
	if (Object.hasOwn(FIXED, id)) {
		const f = FIXED[id] as (typeof FIXED)[string];
		return { id, unit: f.unit, label: f.label, source: f.source, field: f.field, ttlMs: f.ttlMs ?? METRIC_TTL_MS };
	}
	const colon = id.indexOf(":");
	if (colon < 0) return null;
	const name = id.slice(0, colon);
	const window = id.slice(colon + 1);
	if (!Object.hasOwn(WINDOWED, name)) return null;
	const ms = parseWindow(window);
	if (ms === undefined) return null;
	const w = WINDOWED[name] as (typeof WINDOWED)[string];
	return { id, unit: w.unit, label: `${w.label} ${window}`, source: `${w.source}:${ms}`, field: w.field, ttlMs: METRIC_TTL_MS };
}

/**
 * The `metrics` parameter: undefined when absent (the answer has no `metrics`), else the ids in order, trimmed, empty
 * ones and repeats left out. Only a parameter over METRICS_PARAM_MAX characters is refused (unknown ids answer null).
 */
export function parseMetricsParam(raw: string | null): { ids: string[] } | { error: string } | undefined {
	if (raw === null) return undefined;
	if (raw.length > METRICS_PARAM_MAX) return { error: `metrics: at most ${METRICS_PARAM_MAX} characters` };
	const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
	return { ids };
}

/** Runs a named query (warehouse.query). */
export type RunQuery = (name: string, filters: { from: number; to: number }, options: object) => Promise<unknown>;

interface Entry {
	value?: Numbers;
	computedAt: number;
	triedAt: number;
	running?: Promise<void>;
}

/** Sources by key: fresh within the caller's TTL, else computed (one at a time per key, METRIC_CONCURRENCY at once). */
export class MetricsCache {
	private readonly entries = new Map<string, Entry>();
	private active = 0;
	private readonly queue: (() => void)[] = [];
	/** Computations started (tests). */
	computations = 0;

	constructor(
		private readonly clock: () => number,
		private readonly log: (line: string) => void = () => {},
		private readonly limits = { entries: METRIC_ENTRIES_MAX, concurrency: METRIC_CONCURRENCY },
	) {}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * The source's numbers: fresh ones, else a computation started (unless one failed in the last minute) and waited
	 * for up to `waitMs`; then whatever is known (the last good numbers, or undefined). Never throws.
	 */
	async get(key: string, ttlMs: number, compute: (now: number) => Promise<Numbers | undefined>, waitMs: number): Promise<Numbers | undefined> {
		const now = this.clock();
		let e = this.entries.get(key);
		if (e) {
			// Most recently asked last (the eviction order).
			this.entries.delete(key);
			this.entries.set(key, e);
			if (e.value && now - e.computedAt < ttlMs) return e.value;
		} else {
			if (!this.makeRoom()) return undefined;
			e = { computedAt: Number.NEGATIVE_INFINITY, triedAt: Number.NEGATIVE_INFINITY };
			this.entries.set(key, e);
		}
		const entry = e;
		if (!entry.running && now - entry.triedAt >= METRIC_RETRY_MS) {
			entry.triedAt = now;
			entry.running = this.refresh(key, entry, compute).finally(() => (entry.running = undefined));
		}
		if (entry.running) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([entry.running, new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
			clearTimeout(timer);
		}
		return entry.value;
	}

	/** Drops the least recently asked entry that isn't computing; false when every one is. */
	private makeRoom(): boolean {
		if (this.entries.size < this.limits.entries) return true;
		for (const [k, e] of this.entries) {
			if (!e.running) {
				this.entries.delete(k);
				return true;
			}
		}
		return false;
	}

	private async refresh(key: string, entry: Entry, compute: (now: number) => Promise<Numbers | undefined>): Promise<void> {
		if (this.active >= this.limits.concurrency) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		const now = this.clock();
		this.computations++;
		try {
			const value = await compute(now);
			if (value === undefined) entry.value = undefined;
			else {
				entry.value = value;
				entry.computedAt = now;
			}
		} catch (error) {
			this.log(`mobile live: metric ${key} failed (${(error as Error).message.slice(0, 160)})`);
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The fields a source's computation reads (the query results' shapes, src/queries). */
interface OverviewLike {
	players: number;
	newPlayers: number;
}
interface SessionSummaryLike {
	sessions: number;
	avgMinutes: number | null;
	playedMinutes: number;
}
interface SessionTimeLike {
	summary: SessionSummaryLike;
	previous: SessionSummaryLike;
}
interface MonetizationLike {
	totals: { robux: number; payers: number };
}
interface RetentionLike {
	cohorts: { date: string; size: number; kept: Record<string, number | null> }[];
}

const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** A source's computation: `players:<ms>`, `sessions:<ms>`, `money:<ms>`, `retention:<d>`. */
export function sourceCompute(source: string, run: RunQuery): (now: number) => Promise<Numbers> {
	const [kind, arg] = source.split(":") as [string, string];
	const n = Number(arg);
	if (kind === "players") {
		return async (now) => {
			const cur = (await run("overview", { from: now - n, to: now }, {})) as OverviewLike;
			const prev = (await run("overview", { from: now - 2 * n, to: now - n }, {})) as OverviewLike;
			return { players: cur.players, playersPrev: prev.players, new: cur.newPlayers, newPrev: prev.newPlayers };
		};
	}
	if (kind === "sessions") {
		return async (now) => {
			const r = (await run("session-time", { from: now - n, to: now }, { by: "end", mergeGapMinutes: 0 })) as SessionTimeLike;
			const avg = (s: SessionSummaryLike) => (s.avgMinutes === null ? null : Math.round(s.avgMinutes * 60));
			return {
				session: avg(r.summary),
				sessionPrev: avg(r.previous),
				playtime: round1(r.summary.playedMinutes / 60),
				playtimePrev: round1(r.previous.playedMinutes / 60),
				sessions: r.summary.sessions,
				sessionsPrev: r.previous.sessions,
			};
		};
	}
	if (kind === "money") {
		return async (now) => {
			const cur = (await run("monetization", { from: now - n, to: now }, { top: 1 })) as MonetizationLike;
			const prev = (await run("monetization", { from: now - 2 * n, to: now - n }, { top: 1 })) as MonetizationLike;
			return { revenue: Math.round(cur.totals.robux), revenuePrev: Math.round(prev.totals.robux), payers: cur.totals.payers, payersPrev: prev.totals.payers };
		};
	}
	if (kind === "retention") {
		// The latest complete cohort for day n joined n + 1 days before today (its day n is over); the one before it,
		// a day earlier. The range holds exactly those two join days.
		return async (now) => {
			const today = Math.floor(now / DAY);
			const r = (await run("retention", { from: (today - n - 2) * DAY, to: (today - n) * DAY }, { days: [n] })) as RetentionLike;
			const kept = (day: number) => r.cohorts.find((c) => c.date === isoDay(day))?.kept[String(n)] ?? null;
			return { retention: kept(today - n - 1), retentionPrev: kept(today - n - 2) };
		};
	}
	throw new Error(`unknown metric source ${source}`);
}

/** The widget stats: parses the ids, reads (or computes) their sources, shapes the answer. */
export class MobileMetrics {
	readonly cache: MetricsCache;

	constructor(
		private readonly o: {
			/** The named-query runner, or undefined while analytics aren't running (those metrics answer null). */
			run: () => RunQuery | undefined;
			clock: () => number;
			log?: (line: string) => void;
			waitMs?: number;
		},
	) {
		this.cache = new MetricsCache(o.clock, o.log);
	}

	/** `metrics` for the asked ids, in order: unknown ids and ids past METRICS_MAX null. `live`: ccu, servers, peakToday (+Prev). */
	async answer(ids: readonly string[], live: Numbers): Promise<Record<string, MetricValue | null>> {
		const specs = ids.map((id, i) => (i < METRICS_MAX ? parseMetricId(id) : null));
		const sources = new Map<string, number>();
		for (const s of specs) if (s && s.source !== "live") sources.set(s.source, Math.min(sources.get(s.source) ?? Number.POSITIVE_INFINITY, s.ttlMs));
		const run = this.o.run();
		const read = new Map<string, Numbers | undefined>([["live", live]]);
		await Promise.all(
			[...sources].map(async ([source, ttl]) => {
				read.set(source, run ? await this.cache.get(source, ttl, sourceCompute(source, run), this.o.waitMs ?? METRIC_WAIT_MS) : undefined);
			}),
		);
		return Object.fromEntries(
			ids.map((id, i) => {
				const spec = specs[i];
				if (!spec) return [id, null];
				const numbers = read.get(spec.source);
				return [id, { value: numbers?.[spec.field] ?? null, prev: numbers?.[`${spec.field}Prev`] ?? null, unit: spec.unit, label: spec.label }];
			}),
		);
	}
}
