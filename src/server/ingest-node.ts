/**
 * Plans/35 C: an ingest node (TYPETORCH_ROLE=ingest), one of several in front of one main server. Optional: most games
 * run one server (`all`) and never start this.
 *
 *   POST /v1/ingest     game key: the same validation, limits (per node), busy 503 and erased-pid filtering as a server;
 *                       accepted rows go to local raw NDJSON before the 202 (as on a server)
 *   POST /v1/identity   game key: identity rows, forwarded to the main server through the bucket
 *   GET  /v1/auth/check the game key answers role "game" (`typetorch backend setup --ingest` checks it)
 *   GET  /healthz       { ok }; with the admin token the node's queue numbers
 *   anything else       404 "this is an ingest node; the explorer and the fleet API are on the main server"
 *
 * Every TYPETORCH_INGEST_ROTATE_SECONDS (5; sooner past 64 MB) the raw files are closed, moved into a batch folder
 * (data/ingest/spool/<table>-<ms>-<n>/), written as one Parquet file per table (identities: NDJSON), uploaded to
 * `<prefix><table>/<node>-<ms>-<n>.parquet`, and deleted only after the upload is confirmed. A crash keeps the batch
 * folder; the next start uploads it again under the same key (at least once). The erased pids come from the main server
 * (TYPETORCH_MAIN_URL, the admin token) every minute and are kept on disk, so a main server that is down leaves the node
 * working on the last list. No live.duckdb, no nightly jobs, no explorer: DuckDB only writes the Parquet files.
 * One process per data folder (lock.duckdb, like a server): a rolling deploy's new node waits for the old one.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { pathLit, readJsonColumns, storedColumns } from "../duckdb/layout.ts";
import { DataFolderLocked, isLockConflict } from "../duckdb/lock.ts";
import { parseIdentities, PID_PATTERN } from "../fleet/identity.ts";
import { runtimeName, serve, type Served } from "../runtime.ts";
import { lit } from "../sql/dialect.ts";
import { BatchShapeError, validateBatch } from "../validate.ts";
import { PACKAGE } from "../version.ts";
import { isHttps } from "./auth.ts";
import { IngestBusy } from "./busy.ts";
import type { ServerConfig } from "./config.ts";
import { API_CSP, FailureLimiter, RateLimiter, bearer, clientIp, json, readCapped, tokenIn, tooMany, withSecurityHeaders } from "./http.ts";
import { describeError, NODE_ID, queueKey, s3Bucket, type QueueBucket, type QueueStats, type QueueTable } from "./queue.ts";
import { RawLogClosed, spoolLog, type RawLog, type SpoolTable } from "./raw.ts";

export const INGEST_NODE_HINT = "this is an ingest node; the explorer and the fleet API are on the main server";
/** A table's open raw file past this rotates at once (plans/35 C: "or at 64 MB"). */
export const ROTATE_BYTES = 64 * 1024 * 1024;
/** NDJSON going into one Parquet file at most; the rest waits for the next rotation. */
const BATCH_MAX_BYTES = 256 * 1024 * 1024;
const ERASED_PULL_MS = 60_000;
const ERASED_RETRY_MS = 10_000;
const ERASED_MAX_BYTES = 64 * 1024 * 1024;
const ERASED_MAX = 2_000_000;
const GAME_KEY_MAX_FAILURES = 30;
const RETRY_AFTER_SECONDS = 5;
const STOP_DRAIN_MS = 5000;
/** At stop, what is closed gets this long to reach the bucket (the rest goes at the next start). */
const STOP_UPLOAD_MS = 8000;
const HANDOVER_RETRY_MS = 1000;
const BATCH_DIR = /^(events|recordings|identities)-(\d{1,16})-(\d{1,10})$/;

export interface IngestNodeOptions {
	clock?: () => number;
	log?: (line: string) => void;
	/** The fetch for the erased-pid pull. */
	fetch?: typeof fetch;
	/** Tests drive the rotation and the pull themselves. */
	manualJobs?: boolean;
	/** The queue bucket (default: Bun's S3Client on TYPETORCH_QUEUE_*). */
	bucket?: QueueBucket;
	backend?: "bun" | "node";
	handoverRetryMs?: number;
	/** The node can't go on (it gave up waiting for its data folder): main.ts shuts down and exits 1. */
	onFatal?: (error: Error) => void;
}

export interface IngestNodeStats extends QueueStats {
	node: string;
	erased: { pids: number; pulledAt: number | null; errors: number; lastError: string | null };
}

export interface IngestNode {
	readonly port: number;
	/** This node's id (stable per data folder): the `<node>` in the bucket keys. */
	readonly node: string;
	readonly busy: IngestBusy;
	readonly state: "ready" | "handover" | "stopping";
	handle(req: Request, ip?: string): Promise<Response>;
	/** One rotation: close the raw files, write the batches, upload what is closed. */
	cycle(): Promise<{ uploaded: number; failed: number }>;
	/** Pulls the erased pids from the main server; false when it couldn't (the last list stays). */
	pullErased(): Promise<boolean>;
	stats(): IngestNodeStats;
	stop(): Promise<void>;
}

/** The node id of a data folder: made once, kept in data/ingest/node-id. */
export function nodeIdOf(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "node-id");
	if (existsSync(file)) {
		const id = readFileSync(file, "utf8").trim();
		if (NODE_ID.test(id)) return id;
	}
	const id = randomBytes(6).toString("hex");
	writeFileSync(`${file}.tmp`, `${id}\n`);
	renameSync(`${file}.tmp`, file);
	return id;
}

interface Batch {
	name: string;
	table: SpoolTable;
	ms: number;
	n: number;
}

/** The node's disk side: raw files, batches, Parquet, uploads, the erased list. Opened once the folder lock is ours. */
class Spool {
	readonly stats: IngestNodeStats;
	private readonly spoolDir: string;
	private readonly erasedFile: string;
	private erased = new Set<string>();
	private erasedVersion = 0;
	private dbErasedVersion = -1;
	/** Starts anywhere, so a key made after a restart never repeats one from before (the main server skips keys it committed). */
	private counter = randomInt(1_000_000_000);
	private running: Promise<{ uploaded: number; failed: number }> | undefined;
	private spoolBytes = 0;

	private constructor(
		readonly node: string,
		readonly raw: RawLog<SpoolTable>,
		private readonly instance: DuckDBInstance,
		private readonly db: DuckDBConnection,
		private readonly bucket: QueueBucket,
		private readonly prefix: string,
		ingestDir: string,
		private readonly clock: () => number,
		private readonly log: (line: string) => void,
	) {
		this.spoolDir = join(ingestDir, "spool");
		this.erasedFile = join(ingestDir, "erased.json");
		mkdirSync(this.spoolDir, { recursive: true });
		this.stats = { role: "ingest", node, pendingFiles: 0, pendingBytes: 0, lastUploadAt: null, files: 0, errors: 0, lastError: null, lastErrorAt: null, bucket: "unknown", erased: { pids: 0, pulledAt: null, errors: 0, lastError: null } };
		this.loadErased();
		this.measure();
	}

	/** Takes the folder (lock.duckdb, like a server) or throws DataFolderLocked. */
	static async open(config: ServerConfig, bucket: QueueBucket, prefix: string, clock: () => number, log: (line: string) => void): Promise<Spool> {
		const ingestDir = join(config.dataDir, "ingest");
		const tmp = join(config.dataDir, "tmp");
		mkdirSync(tmp, { recursive: true });
		const instance = await DuckDBInstance.create(":memory:", { memory_limit: config.memoryLimit, threads: String(config.threads), temp_directory: tmp.replace(/\\/g, "/"), preserve_insertion_order: "false" });
		let db: DuckDBConnection | undefined;
		try {
			db = await instance.connect();
			try {
				await db.run(`ATTACH ${pathLit(join(config.dataDir, "lock.duckdb"))} AS folder_lock`);
			} catch (error) {
				if (isLockConflict(error)) throw new DataFolderLocked(join(config.dataDir, "lock.duckdb"), (error as Error).message);
				throw error;
			}
			await db.run("CREATE TABLE erased (pid VARCHAR)");
			// Only now, with the folder ours: the last run's open raw files become ready.
			const raw = spoolLog(join(config.dataDir, "raw", "incoming"), config.fsyncMs, clock);
			return new Spool(nodeIdOf(ingestDir), raw, instance, db, bucket, prefix, ingestDir, clock, log);
		} catch (error) {
			try {
				db?.closeSync();
			} catch {}
			instance.closeSync();
			throw error;
		}
	}

	isErased(pid: string): boolean {
		return this.erased.has(pid);
	}

	/** Bytes accepted and not yet in the bucket: the busy check's backlog. */
	pendingBytes(): number {
		return this.raw.pendingBytes() + this.spoolBytes;
	}

	private loadErased(): void {
		try {
			const saved = JSON.parse(readFileSync(this.erasedFile, "utf8")) as { at?: unknown; pids?: unknown };
			if (Array.isArray(saved.pids)) this.setErased(saved.pids.filter((p): p is string => typeof p === "string" && PID_PATTERN.test(p)), typeof saved.at === "number" ? saved.at : null, false);
		} catch {
			// none yet
		}
	}

	setErased(pids: string[], at: number | null, save = true): void {
		const next = new Set(pids);
		const changed = next.size !== this.erased.size || pids.some((p) => !this.erased.has(p));
		if (changed) {
			this.erased = next;
			this.erasedVersion++;
			if (save) {
				writeFileSync(`${this.erasedFile}.tmp`, JSON.stringify({ at, pids: [...next] }));
				renameSync(`${this.erasedFile}.tmp`, this.erasedFile);
			}
		}
		this.stats.erased.pids = next.size;
		this.stats.erased.pulledAt = at;
	}

	private batches(): Batch[] {
		const out: Batch[] = [];
		for (const name of readdirSync(this.spoolDir)) {
			const m = BATCH_DIR.exec(name);
			if (m && statSync(join(this.spoolDir, name)).isDirectory()) out.push({ name, table: m[1] as SpoolTable, ms: Number(m[2]), n: Number(m[3]) });
		}
		return out.sort((a, b) => a.ms - b.ms || a.n - b.n);
	}

	/** Batches waiting and their bytes (NDJSON or the written file). */
	private measure(): void {
		let bytes = 0;
		const batches = this.batches();
		for (const b of batches) {
			const out = this.outPath(b);
			if (existsSync(out)) bytes += statSync(out).size;
			else for (const f of readdirSync(join(this.spoolDir, b.name))) bytes += statSync(join(this.spoolDir, b.name, f)).size;
		}
		this.spoolBytes = bytes;
		this.stats.pendingFiles = batches.length;
		this.stats.pendingBytes = bytes + this.raw.pendingBytes();
	}

	private outPath(b: Batch): string {
		return join(this.spoolDir, `${b.name}.${b.table === "identities" ? "ndjson" : "parquet"}`);
	}

	/** One rotation (one at a time; a call while one runs waits for it). */
	cycle(): Promise<{ uploaded: number; failed: number }> {
		this.running ??= this.cycleNow().finally(() => (this.running = undefined));
		return this.running;
	}

	private async cycleNow(): Promise<{ uploaded: number; failed: number }> {
		await this.raw.rotate();
		// Closed raw files -> one batch folder per table (a rename each: a crash leaves whole files on either side).
		const ready = this.raw.ready();
		for (const table of ["events", "recordings", "identities"] as const) {
			let files = ready.filter((f) => f.table === table);
			for (const f of files.filter((f) => f.bytes === 0)) rmSync(f.path, { force: true });
			files = files.filter((f) => f.bytes > 0);
			while (files.length) {
				let bytes = 0;
				const take = files.filter((f) => (bytes += f.bytes) - f.bytes < BATCH_MAX_BYTES || f === files[0]);
				files = files.slice(take.length);
				const ms = this.clock();
				let n = ++this.counter;
				while (existsSync(join(this.spoolDir, `${table}-${ms}-${n}`))) n = ++this.counter;
				const dir = join(this.spoolDir, `${table}-${ms}-${n}`);
				mkdirSync(dir);
				for (const f of take) renameSync(f.path, join(dir, f.name));
			}
		}
		let uploaded = 0;
		let failed = 0;
		for (const batch of this.batches()) {
			try {
				const out = this.outPath(batch);
				if (!existsSync(out) && !(await this.write(batch, out))) {
					// Nothing left (every row erased): no upload.
					this.drop(batch);
					continue;
				}
				await this.bucket.put(queueKey(this.prefix, batch.table as QueueTable, this.node, batch.ms, batch.n), out);
				// Confirmed: only now the local copies go.
				this.drop(batch);
				uploaded++;
				this.stats.files++;
				this.stats.lastUploadAt = this.clock();
				this.stats.bucket = "ok";
			} catch (error) {
				failed++;
				this.stats.errors++;
				this.stats.lastError = describeError(error).slice(0, 300);
				this.stats.lastErrorAt = this.clock();
				this.stats.bucket = "down";
				this.log(`ingest node: ${batch.name} not uploaded (${this.stats.lastError}); it stays on disk and is tried again`);
				// The bucket is likely down: the rest waits for the next rotation.
				break;
			}
		}
		this.measure();
		return { uploaded, failed };
	}

	private drop(batch: Batch): void {
		rmSync(this.outPath(batch), { force: true });
		rmSync(join(this.spoolDir, batch.name), { recursive: true, force: true });
	}

	/** Writes a batch's file (Parquet; identities NDJSON) without erased players' rows. Returns the rows written. */
	private async write(batch: Batch, out: string): Promise<number> {
		const dir = join(this.spoolDir, batch.name);
		const sources = readdirSync(dir)
			.filter((n) => n.endsWith(".ndjson"))
			.map((n) => join(dir, n));
		if (!sources.length) return 0;
		const tmp = `${out}.tmp`;
		let rows = 0;
		if (batch.table === "identities") {
			const lines: string[] = [];
			for (const source of sources) {
				for (const line of readFileSync(source, "utf8").split("\n")) {
					if (!line) continue;
					let row: unknown;
					try {
						row = JSON.parse(line);
					} catch {
						continue;
					}
					const parsed = parseIdentities([row], this.clock()).rows[0];
					if (parsed && !this.erased.has(parsed.pid)) lines.push(JSON.stringify(parsed));
				}
			}
			rows = lines.length;
			if (!rows) return 0;
			writeFileSync(tmp, `${lines.join("\n")}\n`);
		} else {
			await this.syncErased();
			const table = batch.table;
			const cols = storedColumns(table)
				.map((c) => `"${c}"`)
				.join(", ");
			// ignore_errors: a line a crash cut short is skipped (the rest of the file still goes).
			const result = await this.db.run(
				`COPY (SELECT ${cols} FROM read_json([${sources.map(pathLit).join(", ")}], format = 'newline_delimited', columns = ${readJsonColumns(table)}, ignore_errors = true) r ` +
					`WHERE r.pid IS NULL OR NOT EXISTS (SELECT 1 FROM erased x WHERE x.pid = r.pid)) TO ${pathLit(tmp)} (FORMAT parquet, COMPRESSION zstd)`,
			);
			rows = Number(result.rowsChanged);
			if (!rows) {
				rmSync(tmp, { force: true });
				return 0;
			}
		}
		renameSync(tmp, out);
		return rows;
	}

	/** The DuckDB copy of the erased list, refreshed when the list changed. */
	private async syncErased(): Promise<void> {
		if (this.dbErasedVersion === this.erasedVersion) return;
		await this.db.run("DELETE FROM erased");
		const pids = [...this.erased];
		for (let i = 0; i < pids.length; i += 1000) await this.db.run(`INSERT INTO erased VALUES ${pids.slice(i, i + 1000).map((p) => `(${lit(p)})`).join(", ")}`);
		this.dbErasedVersion = this.erasedVersion;
	}

	close(): void {
		try {
			this.db.interrupt();
			this.db.closeSync();
		} catch {}
		this.instance.closeSync();
	}
}

/** Starts an ingest node (TYPETORCH_ROLE=ingest). */
export async function startIngestNode(config: ServerConfig, options: IngestNodeOptions = {}): Promise<IngestNode> {
	if (config.role !== "ingest" || !config.queue || !config.mainUrl) throw new Error("startIngestNode needs TYPETORCH_ROLE=ingest with the queue settings and TYPETORCH_MAIN_URL");
	const clock = options.clock ?? Date.now;
	const log = options.log ?? ((line: string) => console.log(`[ingest] ${line}`));
	const doFetch = options.fetch ?? fetch;
	const queue = config.queue;
	const mainUrl = config.mainUrl;
	const bucket = options.bucket ?? s3Bucket(queue);
	const proxyOpts = { trustProxy: config.trustProxy, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}) };
	const proxyTrust = { hops: config.trustProxy, ...(config.trustedProxies ? { proxies: config.trustedProxies } : {}), ...(config.cloudflareIps ? { cloudflare: config.cloudflareIps } : {}) };

	let spool: Spool | undefined;
	let stopping = false;
	const handover = { since: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
	try {
		spool = await Spool.open(config, bucket, queue.prefix, clock, log);
	} catch (error) {
		if (!(error instanceof DataFolderLocked)) throw error;
		log(`handover: ${error.file} is held by another process (the previous container of a rolling deploy?): ingest answers 503 until it lets go; trying every ${(options.handoverRetryMs ?? HANDOVER_RETRY_MS) / 1000} s for up to ${config.handoverSeconds} s`);
	}

	const ipLimiter = new RateLimiter(config.ipPerMinute, clock);
	const jobLimiter = new RateLimiter(config.jobPerMinute, clock);
	const checkLimiter = new RateLimiter(120, clock);
	const authFailures = new FailureLimiter(config.loginMaxFailures, config.loginWindowMs, clock);
	const gameKeyFailures = new FailureLimiter(GAME_KEY_MAX_FAILURES, config.loginWindowMs, clock);
	const busy = new IngestBusy({ maxBytes: () => config.busyBytes, maxRequests: () => config.busyRequests, pendingBytes: () => spool?.pendingBytes(), clock });
	const isGame = (req: Request) => tokenIn(bearer(req), config.apiKeys);
	const isAdmin = (req: Request) => tokenIn(bearer(req), [config.adminToken]);
	const notFound = () => json(404, { error: `not found: ${INGEST_NODE_HINT}` });
	const unavailable = () => json(503, { error: stopping ? "the ingest node is restarting: try again in a few seconds" : "the ingest node is starting (deploy handover): try again in a few seconds" }, { "retry-after": String(RETRY_AFTER_SECONDS) });
	let rotateSoon = false;

	function badGameKey(req: Request, ip: string, what: string): Response {
		if (bearer(req) === undefined) return json(401, { error: "API key required" });
		const wait = gameKeyFailures.blocked(ip);
		if (wait) return tooMany(wait);
		if (gameKeyFailures.count(ip) === 0) log(`${what}: wrong API key from ${ip}`);
		gameKeyFailures.fail(ip);
		return json(401, { error: "API key required" });
	}

	async function readJsonBody(req: Request): Promise<{ value: unknown; bytes: number } | Response> {
		const body = await readCapped(req, config.maxBodyBytes);
		if (!body) return json(413, { error: `body over ${config.maxBodyBytes} bytes` });
		let bytes: Uint8Array = body;
		if (req.headers.get("content-encoding") === "gzip" || (body[0] === 0x1f && body[1] === 0x8b)) {
			try {
				bytes = gunzipSync(body, { maxOutputLength: config.maxInflateBytes });
			} catch (error) {
				if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || (error as Error).name === "RangeError") return json(413, { error: `inflated body over ${config.maxInflateBytes} bytes` });
				return json(400, { error: "body is not valid gzip" });
			}
			if (bytes.length > config.maxInflateBytes) return json(413, { error: `inflated body over ${config.maxInflateBytes} bytes` });
		}
		try {
			return { value: JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")), bytes: bytes.length };
		} catch {
			return json(400, { error: "body is not JSON" });
		}
	}

	/** Appends rows to the raw log (the 202 means "on this node's disk"); a big open file rotates at once. */
	async function append(s: Spool, table: SpoolTable, text: string): Promise<void> {
		await s.raw.append(table, text);
		if (!rotateSoon && s.raw.openBytes() >= ROTATE_BYTES && !options.manualJobs) {
			rotateSoon = true;
			setTimeout(() => void s.cycle().catch((e) => log(`rotation failed: ${(e as Error).message}`)).finally(() => (rotateSoon = false)), 0);
		}
	}

	async function ingest(req: Request, ip: string): Promise<Response> {
		if (!isGame(req)) return badGameKey(req, ip, "ingest");
		const refused = busy.check();
		if (refused) return json(503, { error: `busy: ${refused.why}; try again later`, busy: true }, { "retry-after": String(refused.retryAfter) });
		const leave = busy.enter();
		try {
			if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
			const s = spool;
			if (!s) return unavailable();
			const read = await readJsonBody(req);
			if (read instanceof Response) return read;
			let batch;
			try {
				batch = validateBatch(read.value);
			} catch (error) {
				if (error instanceof BatchShapeError) return json(400, { error: error.message });
				throw error;
			}
			const job = batch.events[0]?.job ?? batch.recordings[0]?.job;
			if (job && !jobLimiter.take(`job:${job}`)) return tooMany(jobLimiter.retryAfter(`job:${job}`));
			const parsed = read.value;
			const who = parseIdentities(isRecord(parsed) ? parsed.identities : undefined, clock());
			const known = who.rows.filter((r) => !s.isErased(r.pid));
			const rt = clock();
			try {
				if (batch.events.length) await append(s, "events", batch.events.map((r) => `${JSON.stringify({ ...r, rt })}\n`).join(""));
				if (batch.recordings.length) await append(s, "recordings", batch.recordings.map((r) => `${JSON.stringify({ ...r, rt })}\n`).join(""));
				if (known.length) await append(s, "identities", known.map((r) => `${JSON.stringify(r)}\n`).join(""));
			} catch (error) {
				if (error instanceof RawLogClosed) return unavailable();
				throw error;
			}
			return json(202, {
				accepted: batch.events.length + batch.recordings.length,
				rejected: batch.rejected,
				...(batch.errors.length ? { errors: batch.errors } : {}),
				...(who.rows.length || who.rejected ? { identities: known.length, identitiesRejected: who.rejected } : {}),
			});
		} finally {
			leave();
		}
	}

	async function postIdentity(req: Request, ip: string): Promise<Response> {
		if (!isGame(req)) return badGameKey(req, ip, "identity");
		if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
		const s = spool;
		if (!s) return unavailable();
		const raw = await readCapped(req, 256 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: unknown;
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8"));
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		const list = isRecord(body) && Array.isArray(body.identities) ? body.identities : body;
		const who = parseIdentities(list, clock());
		const known = who.rows.filter((r) => !s.isErased(r.pid));
		try {
			if (known.length) await append(s, "identities", known.map((r) => `${JSON.stringify(r)}\n`).join(""));
		} catch (error) {
			if (error instanceof RawLogClosed) return unavailable();
			throw error;
		}
		return json(202, { accepted: known.length, rejected: who.rejected });
	}

	function authCheck(req: Request, ip: string): Response {
		const blocked = authFailures.blocked(ip);
		if (blocked) return tooMany(blocked);
		if (!checkLimiter.take(ip)) return tooMany(checkLimiter.retryAfter(ip));
		const common = { service: "typetorch-backend", version: PACKAGE.version, node: "ingest", parts: { analytics: true, fleet: false } };
		if (isGame(req)) return json(200, { ok: true, role: "game", via: "bearer", ...common });
		if (isAdmin(req)) return json(200, { ok: true, role: "admin", via: "bearer", ...common });
		if (bearer(req) !== undefined) {
			authFailures.fail(ip);
			log(`token check failed from ${ip}`);
		}
		return json(401, { error: `sign in required (${INGEST_NODE_HINT})` });
	}

	function health(req: Request, ip: string): Response {
		const plain = () => json(200, { ok: true });
		const given = bearer(req) !== undefined;
		if (!given || authFailures.blocked(ip)) return plain();
		if (!isAdmin(req)) {
			if (!isGame(req)) authFailures.fail(ip);
			return plain();
		}
		const memory = process.memoryUsage();
		return json(200, {
			ok: true,
			role: "ingest",
			state: stopping ? "stopping" : spool ? "ready" : "handover",
			version: PACKAGE.version,
			runtime: runtimeName(),
			uptimeSeconds: Math.round(process.uptime()),
			rssMb: Math.round(memory.rss / 1048576),
			heapMb: Math.round(memory.heapUsed / 1048576),
			ingest: busy.view(),
			...(spool ? { queue: stats() } : {}),
		});
	}

	function stats(): IngestNodeStats {
		const s = spool;
		if (!s) return { role: "ingest", node: "", pendingFiles: 0, pendingBytes: 0, lastUploadAt: null, files: 0, errors: 0, lastError: null, lastErrorAt: null, bucket: "unknown", erased: { pids: 0, pulledAt: null, errors: 0, lastError: null } };
		return { ...s.stats, pendingBytes: s.pendingBytes(), erased: { ...s.stats.erased } };
	}

	async function route(req: Request, path: string, ip: string): Promise<Response> {
		const method = req.method;
		if (path === "/healthz") return method === "GET" || method === "HEAD" ? health(req, ip) : json(405, { error: "GET only" });
		if (path === "/v1/auth/check") return method === "GET" ? authCheck(req, ip) : json(405, { error: "GET only" });
		if (path === "/v1/ingest") return method === "POST" ? ingest(req, ip) : json(405, { error: "POST only" });
		if (path === "/v1/identity" && method === "POST") return postIdentity(req, ip);
		return notFound();
	}

	let inflight = 0;
	async function handle(req: Request, peer = ""): Promise<Response> {
		const ip = clientIp(req, peer, proxyTrust);
		const path = new URL(req.url).pathname;
		let response: Response;
		if (stopping) response = unavailable();
		else {
			inflight++;
			try {
				response = await route(req, path, ip);
			} catch (error) {
				log(`${req.method} ${path} failed: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
				response = json(500, { error: "internal error" });
			} finally {
				inflight--;
			}
		}
		return withSecurityHeaders(response, { https: isHttps(req, proxyOpts), csp: API_CSP });
	}

	/** GET <main>/v1/admin/export/erased with the admin token (no redirects: the token goes to that origin only). */
	async function pullErased(): Promise<boolean> {
		const s = spool;
		if (!s) return false;
		try {
			const res = await doFetch(`${mainUrl}/v1/admin/export/erased`, { headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
			if (res.status !== 200) {
				await res.body?.cancel().catch(() => {});
				throw new Error(`the main server answered ${res.status}`);
			}
			if (Number(res.headers.get("content-length") ?? 0) > ERASED_MAX_BYTES) throw new Error("the erased list is too big");
			const text = await res.text();
			if (text.length > ERASED_MAX_BYTES) throw new Error("the erased list is too big");
			const body = JSON.parse(text) as { pids?: unknown };
			if (!Array.isArray(body.pids) || body.pids.length > ERASED_MAX) throw new Error("the main server's answer has no pids list");
			s.setErased(body.pids.filter((p): p is string => typeof p === "string" && PID_PATTERN.test(p)), clock());
			return true;
		} catch (error) {
			s.stats.erased.errors++;
			s.stats.erased.lastError = describeError(error, [config.adminToken]).slice(0, 200);
			return false;
		}
	}

	const served: Served = await serve({
		hostname: config.host,
		port: config.port,
		maxRequestBodySize: config.maxBodyBytes * 2 + 64 * 1024,
		...(options.backend ? { backend: options.backend } : {}),
		fetch: (req, ctx) => handle(req, ctx.ip),
		error: () => withSecurityHeaders(json(500, { error: "internal error" }), { https: false, csp: API_CSP }),
	});

	const timers: ReturnType<typeof setTimeout>[] = [];
	let erasedTimer: ReturnType<typeof setTimeout> | undefined;
	function startJobs(s: Spool): void {
		if (options.manualJobs) return;
		const rotation = setInterval(() => void s.cycle().catch((e) => log(`rotation failed: ${(e as Error).message}`)), config.ingestRotateSeconds * 1000);
		rotation.unref?.();
		timers.push(rotation);
		const pull = () => {
			void pullErased().then((ok) => {
				if (stopping) return;
				erasedTimer = setTimeout(pull, ok ? ERASED_PULL_MS : ERASED_RETRY_MS);
				erasedTimer.unref?.();
			});
		};
		pull();
		// What a crash or the last stop left behind goes now.
		void s.cycle().catch((e) => log(`rotation failed: ${(e as Error).message}`));
	}
	if (spool) {
		startJobs(spool);
		log(`ingest node ${spool.node}: ${spool.stats.pendingFiles} batch(es) waiting from the last run; erased pids known: ${spool.stats.erased.pids}`);
	} else {
		const retry = () => {
			handover.timer = setTimeout(async () => {
				if (stopping) return;
				try {
					spool = await Spool.open(config, bucket, queue.prefix, clock, log);
					if (stopping) return spool.close();
					log(`handover: the folder is ours after ${((Date.now() - handover.since) / 1000).toFixed(1)} s; ingest is on`);
					startJobs(spool);
				} catch (error) {
					const fatal = (message: string) => {
						log(`error: ${message}`);
						options.onFatal?.(new Error(message));
					};
					if (!(error instanceof DataFolderLocked)) return fatal(`the ingest node could not open its data folder: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
					if (Date.now() - handover.since >= config.handoverSeconds * 1000) return fatal(`gave up after ${config.handoverSeconds} s waiting for ${error.file}: stop the other process using ${config.dataDir}`);
					retry();
				}
			}, options.handoverRetryMs ?? HANDOVER_RETRY_MS);
		};
		retry();
	}

	let stopped: Promise<void> | undefined;
	async function stopNow(): Promise<void> {
		stopping = true;
		if (handover.timer) clearTimeout(handover.timer);
		for (const t of timers) clearInterval(t);
		if (erasedTimer) clearTimeout(erasedTimer);
		const drainUntil = Date.now() + STOP_DRAIN_MS;
		while (inflight > 0 && Date.now() < drainUntil) await new Promise((done) => setTimeout(done, 20));
		await served.stop();
		const s = spool;
		if (!s) return;
		await s.raw.close();
		// What is closed gets a moment to reach the bucket; the rest stays on disk for the next start.
		const last = s.cycle().catch(() => ({ uploaded: 0, failed: 0 }));
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([last, new Promise((done) => (timer = setTimeout(done, STOP_UPLOAD_MS)))]);
		clearTimeout(timer);
		s.close();
	}

	return {
		port: served.port,
		get node() {
			return spool?.node ?? "";
		},
		busy,
		get state() {
			return stopping ? "stopping" : spool ? "ready" : "handover";
		},
		handle,
		cycle: () => (spool ? spool.cycle() : Promise.resolve({ uploaded: 0, failed: 0 })),
		pullErased,
		stats,
		stop() {
			stopped ??= stopNow();
			return stopped;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
