/**
 * Server metrics for the explorer's "Backend stats" page (GET /v1/admin/stats): what this process is doing right now and
 * over the last hour, like Roblox's Performance tab. Everything is in memory and bounded:
 *   - two rings of buckets: one per second (the last 2 minutes) and one per minute (the last hour); every event is
 *     counted into both;
 *   - a bucket holds request counts by status class, request latency as a log-spaced histogram (percentiles come from
 *     it, so a bucket costs a fixed ~60 integers whatever the load), the same per route group, DuckDB statement counts
 *     and latency, rows accepted by ingest and rows loaded by the loader, SQLite reads and writes, and the sampler's
 *     memory / CPU / event loop lag;
 *   - the sampler runs once a second (app.ts owns the timer; tests call sample() themselves).
 * Streams (SSE) and the remote debug long-poll are counted as requests but kept out of the latency percentiles: their
 * "duration" is how long the client waited, not how fast the server was.
 */
import type { FleetDb, SqlValue, SyncTx } from "../fleet/db.ts";

/** Latency histogram: bin i holds durations up to BIN_FLOOR_MS * BIN_GROWTH^i (0.05 ms ... ~32 s); the last bin is open. */
const BIN_FLOOR_MS = 0.05;
const BIN_GROWTH = 1.25;
const BINS = 61;
const LOG_GROWTH = Math.log(BIN_GROWTH);
const binUpper = (i: number): number => BIN_FLOOR_MS * BIN_GROWTH ** i;

function binOf(ms: number): number {
	if (!(ms > BIN_FLOOR_MS)) return 0;
	return Math.min(BINS - 1, Math.ceil(Math.log(ms / BIN_FLOOR_MS) / LOG_GROWTH));
}

/** A fixed-size latency histogram. */
export class Histogram {
	readonly bins = new Uint32Array(BINS);
	count = 0;
	sum = 0;
	max = 0;

	add(ms: number): void {
		this.bins[binOf(ms)]++;
		this.count++;
		this.sum += ms;
		if (ms > this.max) this.max = ms;
	}

	merge(other: Histogram): void {
		for (let i = 0; i < BINS; i++) this.bins[i] += other.bins[i];
		this.count += other.count;
		this.sum += other.sum;
		if (other.max > this.max) this.max = other.max;
	}

	/** The value at `share` (0..1) of the samples: the upper bound of the bin it falls in (the max for the last bin); null without samples. */
	percentile(share: number): number | null {
		if (this.count === 0) return null;
		const target = Math.max(1, Math.ceil(this.count * share));
		let seen = 0;
		for (let i = 0; i < BINS; i++) {
			seen += this.bins[i];
			if (seen >= target) return i === BINS - 1 ? round2(this.max) : round2(Math.min(binUpper(i), this.max));
		}
		return round2(this.max);
	}

	summary(): LatencySummary {
		return { count: this.count, p50: this.percentile(0.5), p90: this.percentile(0.9), p99: this.percentile(0.99), max: this.count ? round2(this.max) : null, avg: this.count ? round2(this.sum / this.count) : null };
	}
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LatencySummary {
	count: number;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	max: number | null;
	avg: number | null;
}

// Route groups ------------------------------------------------------------------------------------------------------------

export type RouteGroup = "ingest" | "errors-in" | "fleet-in" | "long-poll" | "stream" | "query" | "sql" | "rollups" | "errors" | "fleet" | "roblox" | "auth" | "admin" | "health" | "explorer" | "other";

/** The groups whose duration is the client's wait, not the server's work: counted, but out of the latency percentiles. */
const WAITING_GROUPS = new Set<RouteGroup>(["long-poll", "stream"]);

const FLEET_GAME_POSTS = new Set(["heartbeat", "report", "alert", "closing", "deploy", "mark", "results"]);

/** Which group a request belongs to (pure: tested on its own). */
export function routeGroup(method: string, path: string): RouteGroup {
	const m = method.toUpperCase();
	if (path === "/healthz") return "health";
	if (path === "/v1/ingest") return "ingest";
	if (path === "/v1/errors" && m === "POST") return "errors-in";
	if (path === "/v1/identity" && m === "POST") return "ingest";
	if (path === "/v1/live" || path === "/v1/fleet/stream") return "stream";
	if (path === "/v1/fleet/commands" && m === "GET") return "long-poll";
	if (path.startsWith("/v1/fleet/")) {
		if (m === "POST" && FLEET_GAME_POSTS.has(path.slice("/v1/fleet/".length))) return "fleet-in";
		return "fleet";
	}
	if (path.startsWith("/v1/query/") || path === "/v1/queries") return "query";
	if (path === "/v1/sql") return "sql";
	if (path.startsWith("/v1/rollups/")) return "rollups";
	if (path.startsWith("/v1/errors") || /^\/v1\/players\/[^/]+\/errors$/.test(path) || path.startsWith("/v1/experiments")) return "errors";
	if (path === "/v1/place" || path.startsWith("/v1/roblox/") || path.startsWith("/v1/identity")) return "roblox";
	if (path.startsWith("/v1/auth/") || path.startsWith("/auth/") || path.startsWith("/typetorch/challenge/")) return "auth";
	if (path.startsWith("/v1/admin/") || path === "/v1/storage" || path === "/v1/settings" || path.startsWith("/v1/access") || path.startsWith("/v1/central/") || path === "/v1/erasure") return "admin";
	if (path.startsWith("/v1/")) return "other";
	return "explorer";
}

// Buckets -----------------------------------------------------------------------------------------------------------------

interface RouteCell {
	requests: number;
	errors: number;
	latency: Histogram;
}

/** The sampler's reading, kept as the last one of the bucket (memory, CPU, loop lag: the max of the bucket). */
export interface Sample {
	rssMb: number;
	heapMb: number;
	heapTotalMb: number;
	externalMb: number;
	cpuPercent: number;
	loopLagMs: number;
}

class Bucket {
	requests = 0;
	/** By status class: index 2 = 2xx, 3 = 3xx, 4 = 4xx, 5 = 5xx. */
	readonly status = [0, 0, 0, 0, 0, 0];
	readonly latency = new Histogram();
	readonly routes = new Map<RouteGroup, RouteCell>();
	duckQueries = 0;
	readonly duckLatency = new Histogram();
	rowsIn = 0;
	bytesIn = 0;
	rowsLoaded = 0;
	sqliteReads = 0;
	sqliteWrites = 0;
	sample: Sample | undefined;
	loopLagMaxMs = 0;

	constructor(readonly at: number) {}

	route(group: RouteGroup): RouteCell {
		let cell = this.routes.get(group);
		if (!cell) {
			cell = { requests: 0, errors: 0, latency: new Histogram() };
			this.routes.set(group, cell);
		}
		return cell;
	}
}

/** A ring of buckets `spanMs` wide, the last `keep` of them. */
class Ring {
	private readonly buckets = new Map<number, Bucket>();

	constructor(
		readonly spanMs: number,
		readonly keep: number,
	) {}

	at(now: number): Bucket {
		const start = Math.floor(now / this.spanMs) * this.spanMs;
		let bucket = this.buckets.get(start);
		if (!bucket) {
			bucket = new Bucket(start);
			this.buckets.set(start, bucket);
			const oldest = start - this.spanMs * this.keep;
			for (const key of this.buckets.keys()) if (key <= oldest) this.buckets.delete(key);
		}
		return bucket;
	}

	/** The buckets inside the last `keep` spans ending now, oldest first (missing ones are left out: nothing happened). */
	list(now: number, count = this.keep): Bucket[] {
		const end = Math.floor(now / this.spanMs) * this.spanMs;
		const oldest = end - this.spanMs * (count - 1);
		return [...this.buckets.values()].filter((b) => b.at >= oldest && b.at <= end).sort((a, b) => a.at - b.at);
	}
}

// The public shape --------------------------------------------------------------------------------------------------------

export interface StatsBucket {
	at: number;
	requests: number;
	status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
	latency: LatencySummary;
	duckdb: { queries: number; latency: LatencySummary; rowsLoaded: number };
	sqlite: { reads: number; writes: number };
	ingest: { rows: number; bytes: number };
	memory: { rssMb: number; heapMb: number; heapTotalMb: number; externalMb: number } | null;
	cpuPercent: number | null;
	loopLagMs: number | null;
}

export interface RouteStats {
	group: RouteGroup;
	requests: number;
	errors: number;
	latency: LatencySummary;
}

export interface StatsRates {
	/** The window the rates are averaged over, seconds. */
	seconds: number;
	requests: number;
	errors: number;
	duckQueries: number;
	rowsIn: number;
	rowsLoaded: number;
	sqliteReads: number;
	sqliteWrites: number;
}

export interface StatsTotals {
	requests: number;
	errors: number;
	duckQueries: number;
	rowsIn: number;
	bytesIn: number;
	rowsLoaded: number;
	sqliteReads: number;
	sqliteWrites: number;
	since: number;
}

export type StatsWindow = "1m" | "5m" | "15m" | "1h";
export const STATS_WINDOWS: readonly StatsWindow[] = ["1m", "5m", "15m", "1h"];
const WINDOW_MINUTES: Record<StatsWindow, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };

export interface StatsView {
	now: number;
	uptimeSeconds: number;
	/** The live numbers: the last 10 whole seconds averaged. */
	rates: StatsRates;
	/** The latest sampler reading (memory, CPU, event loop lag). */
	sample: Sample | null;
	/** Request latency over the last 10 whole seconds, and over the picked window. */
	latency: { recent: LatencySummary; window: LatencySummary };
	duckdb: { recent: LatencySummary; window: LatencySummary };
	totals: StatsTotals;
	/** Per second, the last 2 minutes (missing seconds: nothing happened). */
	seconds: StatsBucket[];
	/** Per minute, the last hour. */
	minutes: StatsBucket[];
	/** Per route group over the picked window, busiest first. */
	window: StatsWindow;
	routes: RouteStats[];
}

export interface MetricsOptions {
	clock?: () => number;
	/** The process readings (tests pass fixed ones). */
	memory?: () => NodeJS.MemoryUsage;
	cpu?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
	/** Real time for the CPU share and the loop lag (the fake clock of tests stands still). */
	realNow?: () => number;
}

const SECONDS_KEEP = 120;
const MINUTES_KEEP = 60;
const RECENT_SECONDS = 10;
const MB = 1048576;

export class ServerMetrics {
	private readonly seconds = new Ring(1000, SECONDS_KEEP + 1);
	private readonly minutes = new Ring(60_000, MINUTES_KEEP + 1);
	private readonly clock: () => number;
	private readonly readMemory: () => NodeJS.MemoryUsage;
	private readonly readCpu: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
	private readonly realNow: () => number;
	private readonly totals: StatsTotals;
	private last: Sample | null = null;
	private lastCpu: { usage: NodeJS.CpuUsage; at: number } | undefined;
	private expectedTick: number | undefined;

	constructor(options: MetricsOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.readMemory = options.memory ?? (() => process.memoryUsage());
		this.readCpu = options.cpu ?? ((previous) => process.cpuUsage(previous));
		this.realNow = options.realNow ?? (() => performance.now());
		this.totals = { requests: 0, errors: 0, duckQueries: 0, rowsIn: 0, bytesIn: 0, rowsLoaded: 0, sqliteReads: 0, sqliteWrites: 0, since: this.clock() };
	}

	private both(fn: (b: Bucket) => void): void {
		const now = this.clock();
		fn(this.seconds.at(now));
		fn(this.minutes.at(now));
	}

	/** One finished request. */
	request(method: string, path: string, status: number, ms: number): void {
		const group = routeGroup(method, path);
		const cls = Math.min(5, Math.max(0, Math.floor(status / 100)));
		const failed = status >= 500;
		const timed = !WAITING_GROUPS.has(group);
		this.totals.requests++;
		if (failed) this.totals.errors++;
		this.both((b) => {
			b.requests++;
			b.status[cls]++;
			if (timed) b.latency.add(ms);
			const cell = b.route(group);
			cell.requests++;
			if (failed) cell.errors++;
			if (timed) cell.latency.add(ms);
		});
	}

	/** One DuckDB statement on a read connection (a logical query runs a few). */
	duckQuery(ms: number): void {
		this.totals.duckQueries++;
		this.both((b) => {
			b.duckQueries++;
			b.duckLatency.add(ms);
		});
	}

	/** Rows accepted by ingest (appended to the raw file). */
	rowsIn(rows: number, bytes: number): void {
		if (!rows && !bytes) return;
		this.totals.rowsIn += rows;
		this.totals.bytesIn += bytes;
		this.both((b) => {
			b.rowsIn += rows;
			b.bytesIn += bytes;
		});
	}

	/** Rows the loader put into the live DuckDB tables. */
	rowsLoaded(rows: number): void {
		if (!rows) return;
		this.totals.rowsLoaded += rows;
		this.both((b) => (b.rowsLoaded += rows));
	}

	sqlite(kind: "read" | "write", count = 1): void {
		if (kind === "read") this.totals.sqliteReads += count;
		else this.totals.sqliteWrites += count;
		this.both((b) => {
			if (kind === "read") b.sqliteReads += count;
			else b.sqliteWrites += count;
		});
	}

	/**
	 * The sampler: memory, the CPU share since the last sample and the event loop lag (how late this tick came against
	 * `expectedMs` after the last one). Called once a second by app.ts; returns the reading.
	 */
	sample(expectedMs = 1000): Sample {
		const real = this.realNow();
		const memory = this.readMemory();
		const usage = this.readCpu(this.lastCpu?.usage);
		let cpuPercent = 0;
		if (this.lastCpu) {
			const wallMs = Math.max(1, real - this.lastCpu.at);
			cpuPercent = Math.round(((usage.user + usage.system) / 1000 / wallMs) * 1000) / 10;
		}
		// cpuUsage(previous) is a delta; keep the absolute reading for the next delta.
		this.lastCpu = { usage: this.readCpu(), at: real };
		const loopLagMs = this.expectedTick === undefined ? 0 : Math.max(0, Math.round((real - this.expectedTick) * 100) / 100);
		this.expectedTick = real + expectedMs;
		const reading: Sample = {
			rssMb: Math.round((memory.rss / MB) * 10) / 10,
			heapMb: Math.round((memory.heapUsed / MB) * 10) / 10,
			heapTotalMb: Math.round((memory.heapTotal / MB) * 10) / 10,
			externalMb: Math.round(((memory.external + (memory.arrayBuffers ?? 0)) / MB) * 10) / 10,
			cpuPercent,
			loopLagMs,
		};
		this.last = reading;
		this.both((b) => {
			b.sample = reading;
			if (loopLagMs > b.loopLagMaxMs) b.loopLagMaxMs = loopLagMs;
		});
		return reading;
	}

	/** Everything the page shows. */
	view(window: StatsWindow = "5m"): StatsView {
		const now = this.clock();
		// Whole seconds / minutes only: the one running now would read low.
		const recent = this.seconds.list(now - 1000, RECENT_SECONDS);
		const rate = (pick: (b: Bucket) => number) => Math.round((recent.reduce((sum, b) => sum + pick(b), 0) / RECENT_SECONDS) * 100) / 100;
		const recentLatency = new Histogram();
		const recentDuck = new Histogram();
		for (const b of recent) {
			recentLatency.merge(b.latency);
			recentDuck.merge(b.duckLatency);
		}
		const span = this.minutes.list(now, WINDOW_MINUTES[window] + 1).filter((b) => b.at > now - WINDOW_MINUTES[window] * 60_000);
		const windowLatency = new Histogram();
		const windowDuck = new Histogram();
		const routes = new Map<RouteGroup, RouteCell>();
		for (const b of span) {
			windowLatency.merge(b.latency);
			windowDuck.merge(b.duckLatency);
			for (const [group, cell] of b.routes) {
				let total = routes.get(group);
				if (!total) {
					total = { requests: 0, errors: 0, latency: new Histogram() };
					routes.set(group, total);
				}
				total.requests += cell.requests;
				total.errors += cell.errors;
				total.latency.merge(cell.latency);
			}
		}
		return {
			now,
			uptimeSeconds: Math.max(0, Math.round((now - this.totals.since) / 1000)),
			rates: {
				seconds: RECENT_SECONDS,
				requests: rate((b) => b.requests),
				errors: rate((b) => b.status[5]),
				duckQueries: rate((b) => b.duckQueries),
				rowsIn: rate((b) => b.rowsIn),
				rowsLoaded: rate((b) => b.rowsLoaded),
				sqliteReads: rate((b) => b.sqliteReads),
				sqliteWrites: rate((b) => b.sqliteWrites),
			},
			sample: this.last,
			latency: { recent: recentLatency.summary(), window: windowLatency.summary() },
			duckdb: { recent: recentDuck.summary(), window: windowDuck.summary() },
			totals: { ...this.totals },
			seconds: this.seconds.list(now - 1000, SECONDS_KEEP).map(publicBucket),
			minutes: this.minutes.list(now, MINUTES_KEEP).map(publicBucket),
			window,
			routes: [...routes.entries()].map(([group, cell]) => ({ group, requests: cell.requests, errors: cell.errors, latency: cell.latency.summary() })).sort((a, b) => b.requests - a.requests),
		};
	}
}

function publicBucket(b: Bucket): StatsBucket {
	return {
		at: b.at,
		requests: b.requests,
		status: { "2xx": b.status[2], "3xx": b.status[3], "4xx": b.status[4], "5xx": b.status[5] },
		latency: b.latency.summary(),
		duckdb: { queries: b.duckQueries, latency: b.duckLatency.summary(), rowsLoaded: b.rowsLoaded },
		sqlite: { reads: b.sqliteReads, writes: b.sqliteWrites },
		ingest: { rows: b.rowsIn, bytes: b.bytesIn },
		memory: b.sample ? { rssMb: b.sample.rssMb, heapMb: b.sample.heapMb, heapTotalMb: b.sample.heapTotalMb, externalMb: b.sample.externalMb } : null,
		cpuPercent: b.sample ? b.sample.cpuPercent : null,
		loopLagMs: b.sample ? b.loopLagMaxMs : null,
	};
}

export function parseStatsWindow(value: string | null): StatsWindow | undefined {
	if (value === null || value === "") return "5m";
	return (STATS_WINDOWS as readonly string[]).includes(value) ? (value as StatsWindow) : undefined;
}

/** A FleetDb whose statements are counted (reads: all / first; writes: run / exec and a transaction's statements). */
export function meterSqlite(db: FleetDb, metrics: ServerMetrics): FleetDb {
	const meterTx = (tx: SyncTx): SyncTx => ({
		run: (sql, params) => {
			metrics.sqlite("write");
			return tx.run(sql, params);
		},
		all: <R = Record<string, unknown>>(sql: string, params?: SqlValue[]) => {
			metrics.sqlite("read");
			return tx.all<R>(sql, params);
		},
		first: <R = Record<string, unknown>>(sql: string, params?: SqlValue[]) => {
			metrics.sqlite("read");
			return tx.first<R>(sql, params);
		},
	});
	return {
		exec: (sql) => {
			metrics.sqlite("write");
			return db.exec(sql);
		},
		run: (sql, params) => {
			metrics.sqlite("write");
			return db.run(sql, params);
		},
		all: <R = Record<string, unknown>>(sql: string, params?: SqlValue[]) => {
			metrics.sqlite("read");
			return db.all<R>(sql, params);
		},
		first: <R = Record<string, unknown>>(sql: string, params?: SqlValue[]) => {
			metrics.sqlite("read");
			return db.first<R>(sql, params);
		},
		transaction: (fn) => db.transaction((tx) => fn(meterTx(tx))),
		close: () => db.close(),
	};
}
