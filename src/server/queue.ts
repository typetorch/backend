/**
 * Plans/35 C: the queue bucket between ingest nodes and the main server (optional; TYPETORCH_ROLE=all never loads it).
 *
 *   <prefix>events/<node>-<ms>-<n>.parquet        a closed file of accepted event rows (stored columns, with rt)
 *   <prefix>recordings/<node>-<ms>-<n>.parquet
 *   <prefix>identities/<node>-<ms>-<n>.ndjson     identity rows ({ pid, uid, t } per line) that rode ingest batches
 *
 * An ingest node writes a file, uploads it, and deletes its local copy once the upload is confirmed; the main server's
 * loader lists the bucket each tick, downloads ready files (bounded per tick), loads them in the same transaction as its
 * own raw files, then deletes them from the bucket. Delivery is at least once: a key the main server already committed is
 * remembered (live.loaded_remote) and only deleted, and a row that still arrives twice is an exact duplicate, which the
 * nightly export drops.
 *
 * The bucket client is Bun's built-in S3Client (R2 works). Error messages never carry the credentials.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { QueueConfig } from "./config.ts";
import { parseIdentities, type IdentityRow } from "../fleet/identity.ts";

export type QueueTable = "events" | "recordings" | "identities";
export const QUEUE_TABLES: readonly QueueTable[] = ["events", "recordings", "identities"];

/** An ingest node's id: stable per data folder (server/ingest-node.ts). */
export const NODE_ID = /^[a-z0-9]{4,32}$/;
const KEY_NAME = /^([a-z0-9]{4,32})-(\d{1,16})-(\d{1,10})\.(parquet|ndjson)$/;

/** The object key of a closed file. */
export function queueKey(prefix: string, table: QueueTable, node: string, ms: number, n: number): string {
	return `${prefix}${table}/${node}-${ms}-${n}.${table === "identities" ? "ndjson" : "parquet"}`;
}

/** A key this queue writes (anything else in the bucket is left alone), with its parts. */
export function parseQueueKey(prefix: string, key: string): { table: QueueTable; name: string; node: string; ms: number } | undefined {
	if (!key.startsWith(prefix)) return undefined;
	const rest = key.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash < 0) return undefined;
	const table = rest.slice(0, slash) as QueueTable;
	if (!QUEUE_TABLES.includes(table)) return undefined;
	const name = rest.slice(slash + 1);
	const m = KEY_NAME.exec(name);
	if (!m || (m[4] === "ndjson") !== (table === "identities")) return undefined;
	return { table, name, node: m[1], ms: Number(m[2]) };
}

export interface QueueObject {
	key: string;
	size: number;
}

/** What the queue needs from a bucket (Bun's S3Client in production; tests talk to a fake S3 server through it). */
export interface QueueBucket {
	/** Uploads a local file; resolves once the bucket confirmed it. */
	put(key: string, path: string): Promise<void>;
	/** Up to `max` keys under `prefix` (one page), with their sizes; `truncated` when there are more. */
	list(prefix: string, max: number): Promise<{ objects: QueueObject[]; truncated: boolean }>;
	/** Downloads an object to a local file; returns its bytes. */
	download(key: string, path: string): Promise<number>;
	/** Deletes an object (a missing one is fine). */
	remove(key: string): Promise<void>;
}

/** Each bucket call gets this long (a stuck connection must not hold the loader or the uploader). */
export const BUCKET_TIMEOUT_MS = 30_000;

interface BunS3File {
	write(data: unknown): Promise<number>;
	delete(): Promise<void>;
}
interface BunS3Client {
	file(key: string): BunS3File;
	list(options: { prefix?: string; maxKeys?: number }): Promise<{ contents?: { key: string; size?: number }[]; isTruncated?: boolean }>;
}
type BunS3Ctor = new (options: Record<string, unknown>) => BunS3Client;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<T>((_, fail) => {
			timer = setTimeout(() => fail(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
			(timer as { unref?: () => void }).unref?.();
		}),
	]);
}

/** The queue bucket over Bun's S3Client. Needs Bun (the Docker image runs it); Node gets a clear error at start. */
export function s3Bucket(config: QueueConfig, timeoutMs = BUCKET_TIMEOUT_MS): QueueBucket {
	const bun = (globalThis as unknown as { Bun?: { S3Client?: BunS3Ctor; file(path: string): unknown; write(path: string, data: unknown): Promise<number> } }).Bun;
	if (!bun?.S3Client) throw new Error("TYPETORCH_ROLE=main / ingest needs Bun (its built-in S3 client): run the server with bun, as the Docker image does");
	const client = new bun.S3Client({
		bucket: config.bucket,
		endpoint: config.endpoint,
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		...(config.region ? { region: config.region } : {}),
	});
	const secrets = [config.secretAccessKey, config.accessKeyId];
	const guard = async <T>(what: string, job: () => Promise<T>): Promise<T> => {
		try {
			return await withTimeout(job(), timeoutMs, what);
		} catch (error) {
			throw new Error(`${what}: ${describeError(error, secrets)}`);
		}
	};
	return {
		put: (key, path) => guard("upload", async () => void (await client.file(key).write(bun.file(path)))),
		list: (prefix, max) =>
			guard("list", async () => {
				const page = await client.list({ prefix, maxKeys: max });
				const objects = (page.contents ?? []).map((c) => ({ key: String(c.key), size: Number(c.size ?? 0) }));
				return { objects, truncated: page.isTruncated === true };
			}),
		download: (key, path) => guard("download", () => bun.write(path, client.file(key))),
		remove: (key) => guard("delete", () => client.file(key).delete()),
	};
}

/** A bucket error in a few words, without credentials (S3 errors carry a code; other errors their message). */
export function describeError(error: unknown, secrets: readonly string[] = []): string {
	const e = error as { code?: unknown; name?: unknown; message?: unknown };
	let text = typeof e?.code === "string" && e.code ? `${e.code}${typeof e.message === "string" && e.message ? `: ${e.message}` : ""}` : typeof e?.message === "string" ? e.message : String(error);
	for (const secret of secrets) if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
	return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}

// The main server's side ------------------------------------------------------------------------------------------------

/** A downloaded queue file the loader puts in live.duckdb (with its own raw files, in one transaction). */
export interface RemoteFile {
	table: "events" | "recordings";
	key: string;
	path: string;
	bytes: number;
}

export interface QueueStats {
	role: "main" | "ingest";
	/** Files waiting: in the bucket (main: as last listed) or not yet uploaded (ingest). */
	pendingFiles: number;
	pendingBytes: number;
	/** Main: the last commit that took bucket files (unix ms). */
	lastLoadAt?: number | null;
	/** Ingest: the last confirmed upload (unix ms). */
	lastUploadAt?: number | null;
	/** Files loaded (main) or uploaded (ingest) since start. */
	files: number;
	/** Bucket or file errors since start, and the last one (never a credential). */
	errors: number;
	lastError: string | null;
	lastErrorAt: number | null;
	/** Whether the last bucket call worked. */
	bucket: "ok" | "down" | "unknown";
	/** Main: whether the last listing had more keys than one page. */
	truncated?: boolean;
	/** Main: identity rows taken from the bucket since start. */
	identities?: number;
}

export interface MainQueueOptions {
	bucket: QueueBucket;
	prefix: string;
	/** Where downloads go (data/raw/remote). */
	dir: string;
	maxFilesPerTick?: number;
	maxBytesPerTick?: number;
	/** A bigger object is skipped (and reported): an ingest node never writes one. */
	maxFileBytes?: number;
	listMax?: number;
	isErased(pid: string): boolean;
	upsertIdentities(rows: IdentityRow[]): Promise<void>;
	/** Raised once per outage (a backend alert); `back` when the bucket answers again. */
	onBucketDown?(info: { error: string; since: number }): void | Promise<void>;
	/** Raised once per file that can't be loaded (quarantined for a while, then tried again). */
	onBadFile?(info: { key: string; error: string }): void | Promise<void>;
	/** How long the bucket must fail before onBucketDown (default 60 s). */
	downAfterMs?: number;
	clock?: () => number;
	log?: (line: string) => void;
}

/** Downloads running at once. */
const CONCURRENCY = 4;
/** A file that failed to load waits this long before it is tried again. */
const QUARANTINE_MS = 10 * 60_000;

/** Runs `job` over `items`, `limit` at a time. */
export async function eachLimit<T>(items: readonly T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await job(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The main server's consumer. Per loader tick: `fetch` (outside the DuckDB job lock: lists, downloads, takes identity
 * files), the warehouse loads the files, then `finish` deletes what was committed from the bucket. Never throws: a
 * bucket that can't be reached is counted, raised as a backend alert, and the server goes on with its own ingest.
 */
export class MainQueue {
	readonly stats: QueueStats = { role: "main", pendingFiles: 0, pendingBytes: 0, lastLoadAt: null, files: 0, errors: 0, lastError: null, lastErrorAt: null, bucket: "unknown", truncated: false, identities: 0 };
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private failingSince: number | null = null;
	private alerted = false;
	private readonly quarantine = new Map<string, number>();

	constructor(private readonly o: MainQueueOptions) {
		this.clock = o.clock ?? Date.now;
		this.log = o.log ?? (() => {});
		// Downloads a crash left behind: the bucket still holds them (deleted only after the commit), so they come again.
		rmSync(o.dir, { recursive: true, force: true });
		for (const table of ["events", "recordings", "identities"]) mkdirSync(join(o.dir, table), { recursive: true });
	}

	/** Bytes the busy check counts on top of raw/incoming: the bucket backlog as last listed. */
	backlogBytes(): number {
		return this.stats.pendingBytes;
	}

	private failed(error: unknown, what: string): void {
		const text = `${what}: ${describeError(error)}`.slice(0, 300);
		this.stats.errors++;
		this.stats.lastError = text;
		this.stats.lastErrorAt = this.clock();
		this.stats.bucket = "down";
		const now = this.clock();
		if (this.failingSince === null) {
			this.failingSince = now;
			this.log(`queue bucket: ${text} (the server goes on with its own ingest; bucket files wait)`);
		}
		if (!this.alerted && now - this.failingSince >= (this.o.downAfterMs ?? 60_000)) {
			this.alerted = true;
			void Promise.resolve(this.o.onBucketDown?.({ error: text, since: this.failingSince })).catch(() => {});
		}
	}

	private worked(): void {
		if (this.failingSince !== null) this.log(`queue bucket: answering again after ${Math.round((this.clock() - this.failingSince) / 1000)} s`);
		this.failingSince = null;
		this.alerted = false;
		this.stats.bucket = "ok";
	}

	/**
	 * Lists the bucket and downloads what this tick takes. Keys in `committed` (loaded by an earlier tick whose delete
	 * didn't happen: a crash, a bucket error) are only deleted. Identity files are upserted here (idempotent).
	 */
	async fetch(committed: ReadonlySet<string>): Promise<{ files: RemoteFile[]; done: string[] }> {
		const now = this.clock();
		for (const [key, until] of this.quarantine) if (until <= now) this.quarantine.delete(key);
		const listed: (QueueObject & { table: QueueTable })[] = [];
		let truncated = false;
		try {
			for (const table of QUEUE_TABLES) {
				const page = await this.o.bucket.list(`${this.o.prefix}${table}/`, this.o.listMax ?? 1000);
				truncated ||= page.truncated;
				for (const object of page.objects) {
					const parsed = parseQueueKey(this.o.prefix, object.key);
					if (parsed && parsed.table === table) listed.push({ ...object, table });
				}
			}
			this.worked();
		} catch (error) {
			this.failed(error, "list");
			return { files: [], done: [] };
		}
		this.stats.pendingFiles = listed.length;
		this.stats.pendingBytes = listed.reduce((n, o) => n + o.size, 0);
		this.stats.truncated = truncated;

		const done = listed.filter((o) => committed.has(o.key)).map((o) => o.key);
		const maxFiles = this.o.maxFilesPerTick ?? 64;
		const maxBytes = this.o.maxBytesPerTick ?? 256 * 1024 * 1024;
		const maxFileBytes = this.o.maxFileBytes ?? 512 * 1024 * 1024;
		const take: (QueueObject & { table: QueueTable })[] = [];
		let bytes = 0;
		for (const object of listed.sort((a, b) => (parseQueueKey(this.o.prefix, a.key)?.ms ?? 0) - (parseQueueKey(this.o.prefix, b.key)?.ms ?? 0))) {
			if (committed.has(object.key) || this.quarantine.has(object.key)) continue;
			if (object.size > maxFileBytes) {
				this.bad(object.key, `${object.size} bytes, over the ${maxFileBytes} a file may have`);
				continue;
			}
			if (take.length >= maxFiles || (take.length && bytes + object.size > maxBytes)) break;
			take.push(object);
			bytes += object.size;
		}
		const files: RemoteFile[] = [];
		await eachLimit(take, CONCURRENCY, async (object) => {
			const parsed = parseQueueKey(this.o.prefix, object.key);
			if (!parsed) return;
			const path = join(this.o.dir, object.table, parsed.name);
			try {
				const got = await this.o.bucket.download(object.key, path);
				// Replaced by something bigger between the listing and the download: not taken.
				if (got > maxFileBytes) throw new BadQueueFile(`${got} bytes, over the ${maxFileBytes} a file may have`);
				if (object.table === "identities") {
					await this.identities(path);
					done.push(object.key);
				} else files.push({ table: object.table as "events" | "recordings", key: object.key, path, bytes: got });
			} catch (error) {
				rmSync(path, { force: true });
				if (error instanceof BadQueueFile) this.bad(object.key, error.message);
				else this.failed(error, "download");
			}
		});
		return { files, done };
	}

	/** Upserts an identity file's rows (checked again here: the bucket is not trusted more than a game server). */
	private async identities(path: string): Promise<void> {
		const size = statSync(path).size;
		if (size > 64 * 1024 * 1024) throw new BadQueueFile("an identity file over 64 MB");
		const text = readFileSync(path, "utf8");
		rmSync(path, { force: true });
		const raw: unknown[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				raw.push(JSON.parse(line));
			} catch {
				// a bad line is skipped
			}
		}
		const now = this.clock();
		for (let i = 0; i < raw.length; i += 1000) {
			const rows = parseIdentities(raw.slice(i, i + 1000), now).rows.filter((r) => !this.o.isErased(r.pid));
			if (rows.length) await this.o.upsertIdentities(rows);
			this.stats.identities = (this.stats.identities ?? 0) + rows.length;
		}
	}

	private bad(key: string, error: string): void {
		if (this.quarantine.has(key)) return;
		this.quarantine.set(key, this.clock() + QUARANTINE_MS);
		this.stats.errors++;
		this.stats.lastError = `${key.slice(this.o.prefix.length)}: ${error}`.slice(0, 300);
		this.stats.lastErrorAt = this.clock();
		this.log(`queue bucket: ${this.stats.lastError} (skipped for ${QUARANTINE_MS / 60_000} min)`);
		void Promise.resolve(this.o.onBadFile?.({ key: key.slice(this.o.prefix.length), error })).catch(() => {});
	}

	/** Downloads that weren't loaded (a local failure): their local copies go; the bucket still has them. */
	discard(files: readonly RemoteFile[]): void {
		for (const file of files) rmSync(file.path, { force: true });
	}

	/** The load failed with these files in it: they wait (quarantined) and the loader goes on with its own raw files. */
	failedLoad(files: readonly RemoteFile[], error: unknown): void {
		for (const file of files) {
			rmSync(file.path, { force: true });
			this.bad(file.key, describeError(error));
		}
	}

	/** After the commit: the loaded files leave the bucket and the disk. Returns the keys the bucket let go of. */
	async finish(loaded: readonly RemoteFile[], done: readonly string[]): Promise<string[]> {
		for (const file of loaded) rmSync(file.path, { force: true });
		if (loaded.length) {
			this.stats.files += loaded.length;
			this.stats.lastLoadAt = this.clock();
		}
		const removed: string[] = [];
		await eachLimit([...loaded.map((f) => f.key), ...done], CONCURRENCY, async (key) => {
			try {
				await this.o.bucket.remove(key);
				removed.push(key);
			} catch (error) {
				// Still in the bucket: the next tick sees it as committed and deletes it then.
				this.failed(error, "delete");
			}
		});
		return removed;
	}
}

/** A queue file that can't be used (too big, unreadable): skipped for a while, never fatal. */
export class BadQueueFile extends Error {
	override name = "BadQueueFile";
}
