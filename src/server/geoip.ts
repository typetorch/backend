/**
 * The offline IP database behind game server locations (fleet/geo.ts looks addresses up in it; nothing is sent out).
 *
 * TYPETORCH_GEOIP=dbip (the default in production): DB-IP's free "IP to City Lite" and "IP to ASN Lite" databases
 * (CC BY 4.0: the explorer credits DB-IP wherever it shows a location) live in <data>/geoip/ as dbip-city-lite.mmdb and
 * dbip-asn-lite.mmdb. At start the files there are loaded (when present), and a check a minute after start and then
 * daily downloads this month's release (https://download.db-ip.com/free/dbip-<kind>-lite-YYYY-MM.mmdb.gz; the
 * previous month's while this one isn't out, for a first install) when a file is missing or was fetched in an earlier
 * month. A download streams through gunzip into a temporary file (size-capped, time-limited), must open as the
 * expected kind of database, and is then renamed over the old file and loaded: a failed one leaves the old file in
 * use. Two containers sharing the folder (a rolling deploy) each use their own temporary name; the rename is atomic.
 *
 * TYPETORCH_GEOIP=<path to a City .mmdb>: that file (and TYPETORCH_GEOIP_ASN's) is used as it is and never downloaded,
 * e.g. MaxMind GeoLite2-City.mmdb kept fresh by geoipupdate. TYPETORCH_GEOIP=off: no locations.
 *
 * The files are memory-mapped under Bun (the OS pages in what lookups touch), read whole under Node.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { mmdbReader, openMmdb, type GeoLocator, type GeoReader } from "../fleet/geo.ts";
import type { GeoIpConfig } from "./config.ts";

export const DBIP_FILES = { city: "dbip-city-lite.mmdb", asn: "dbip-asn-lite.mmdb" } as const;
export type DbipKind = keyof typeof DBIP_FILES;

/** A release's URL: kind city or asn, the month (UTC) of `at`. */
export function dbipUrl(kind: DbipKind, at: number): string {
	const d = new Date(at);
	const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
	return `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;
}

/** The first moment of the month before `at`'s (UTC). */
const previousMonth = (at: number) => {
	const d = new Date(at);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
};

const monthOf = (at: number) => {
	const d = new Date(at);
	return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/** Download caps: the City Lite file is ~60 MB gzipped, ~130 MB inflated (2026). */
export const GEOIP_MAX_GZIP_BYTES = 256 * 1024 * 1024;
export const GEOIP_MAX_BYTES = 1024 * 1024 * 1024;
/** One download at most this long (in the background: nothing waits on it). */
export const GEOIP_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** The first check after start, then the interval between checks. */
export const GEOIP_FIRST_CHECK_MS = 60_000;
export const GEOIP_CHECK_MS = 24 * 3_600_000;

/** A file's bytes as a Buffer: memory-mapped under Bun, read under Node. */
function mapFile(path: string): Buffer {
	const bun = (globalThis as { Bun?: { mmap?: (path: string) => Uint8Array } }).Bun;
	if (bun?.mmap) {
		const bytes = bun.mmap(path);
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	return readFileSync(path);
}

/** The files the config names that exist, opened; undefined when there is no City file (or it doesn't open). */
export function openGeoReader(config: GeoIpConfig, log: (line: string) => void = () => {}): GeoReader | undefined {
	if (config.mode === "off") return undefined;
	const city = config.mode === "dbip" ? join(config.dir, DBIP_FILES.city) : config.city;
	const asn = config.mode === "dbip" ? join(config.dir, DBIP_FILES.asn) : config.asn;
	if (!existsSync(city)) return undefined;
	try {
		let asnBytes: Buffer | undefined;
		if (asn && existsSync(asn)) {
			try {
				asnBytes = mapFile(asn);
				openMmdb(asnBytes, "asn");
			} catch (error) {
				log(`geoip: the ASN database doesn't open, locations go on without AS numbers (${(error as Error).message})`);
				asnBytes = undefined;
			}
		}
		return mmdbReader(mapFile(city), asnBytes);
	} catch (error) {
		log(`geoip: the City database doesn't open: locations stay unknown (${(error as Error).message})`);
		return undefined;
	}
}

class DownloadError extends Error {}

/**
 * Downloads `url` (gzip) into `target`: streamed through gunzip into a temporary file next to it, checked with
 * `validate`, then renamed over it. Throws DownloadError (404: "not published") or the check's error; never leaves a
 * temporary file behind.
 */
export async function downloadMmdb(
	url: string,
	target: string,
	options: { fetch: typeof fetch; validate: (bytes: Buffer) => void; timeoutMs?: number; maxGzipBytes?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<void> {
	const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? GEOIP_DOWNLOAD_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
	const res = await options.fetch(url, { signal, redirect: "follow", headers: { "user-agent": "typetorch-backend geoip" } });
	if (!res.ok || !res.body) {
		await res.body?.cancel().catch(() => {});
		throw new DownloadError(res.status === 404 ? "not published" : `HTTP ${res.status}`);
	}
	const declared = Number(res.headers.get("content-length") ?? "0");
	const maxGzip = options.maxGzipBytes ?? GEOIP_MAX_GZIP_BYTES;
	const max = options.maxBytes ?? GEOIP_MAX_BYTES;
	if (declared > maxGzip) {
		await res.body.cancel().catch(() => {});
		throw new DownloadError(`too large (${declared} bytes)`);
	}
	let gzBytes = 0;
	const counted = res.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				gzBytes += chunk.byteLength;
				if (gzBytes > maxGzip) controller.error(new DownloadError("too large"));
				else controller.enqueue(chunk);
			},
		}),
	);
	const reader = counted.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
	const file = await open(tmp, "w", 0o644);
	let ok = false;
	try {
		let bytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > max) throw new DownloadError("too large inflated");
			await file.write(value);
		}
		await file.sync();
		await file.close();
		options.validate(mapFile(tmp));
		await rename(tmp, target);
		ok = true;
	} finally {
		await reader.cancel().catch(() => {});
		if (!ok) {
			await file.close().catch(() => {});
			await rm(tmp, { force: true }).catch(() => {});
		}
	}
}

export interface GeoIpUpdaterOptions {
	config: GeoIpConfig;
	locator: GeoLocator;
	fetch?: typeof fetch;
	clock?: () => number;
	log?: (line: string) => void;
}

/** Loads the database at start and (dbip) keeps it downloaded and fresh. */
export class GeoIpUpdater {
	private timers: ReturnType<typeof setTimeout>[] = [];
	private running: Promise<void> | undefined;
	private stopped = false;
	/** Aborts a download that is running when the server stops. */
	private readonly abort = new AbortController();
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	/** The last check's outcome (tests, the startup line). */
	last: "loaded" | "fresh" | "updated" | "failed" | "off" | undefined;

	constructor(private readonly options: GeoIpUpdaterOptions) {
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
	}

	/** Opens what is on disk now (never downloads). */
	async load(): Promise<void> {
		const reader = openGeoReader(this.options.config, this.log);
		await this.options.locator.setReader(reader);
		if (reader) this.last = "loaded";
	}

	/** dbip: a check soon after start, then daily. */
	start(): void {
		if (this.options.config.mode !== "dbip" || this.stopped) return;
		const first = setTimeout(() => {
			void this.check();
			const daily = setInterval(() => void this.check(), GEOIP_CHECK_MS);
			(daily as { unref?: () => void }).unref?.();
			this.timers.push(daily);
		}, GEOIP_FIRST_CHECK_MS);
		(first as { unref?: () => void }).unref?.();
		this.timers.push(first);
	}

	stop(): void {
		this.stopped = true;
		this.abort.abort();
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
	}

	/** A file that is missing or fetched in an earlier month (UTC). */
	private stale(path: string): boolean {
		if (!existsSync(path)) return true;
		try {
			return monthOf(statSync(path).mtimeMs) < monthOf(this.clock());
		} catch {
			return true;
		}
	}

	/** Downloads what is stale (one check at a time), then reloads. Never throws. */
	check(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.checkNow().finally(() => (this.running = undefined));
		return this.running;
	}

	private async checkNow(): Promise<void> {
		const config = this.options.config;
		if (config.mode !== "dbip") {
			this.last = "off";
			return;
		}
		const doFetch = this.options.fetch ?? fetch;
		let updated = false;
		let failed = false;
		try {
			await mkdir(config.dir, { recursive: true });
		} catch (error) {
			this.log(`geoip: can't make ${config.dir}: ${(error as Error).message}`);
			this.last = "failed";
			return;
		}
		for (const kind of ["city", "asn"] as const) {
			if (this.stopped) return;
			const target = join(config.dir, DBIP_FILES[kind]);
			if (!this.stale(target)) continue;
			// The file must open as the kind of database it is named after.
			const validate = (bytes: Buffer) => void openMmdb(bytes, kind);
			const now = this.clock();
			// This month's release; while it isn't out (early on the 1st), last month's when there is no file at all.
			const months = existsSync(target) ? [now] : [now, previousMonth(now)];
			for (const at of months) {
				const url = dbipUrl(kind, at);
				try {
					await downloadMmdb(url, target, { fetch: doFetch, validate, signal: this.abort.signal });
					this.log(`geoip: downloaded ${DBIP_FILES[kind]} (${url.slice(url.lastIndexOf("/") + 1)})`);
					updated = true;
					break;
				} catch (error) {
					const message = (error as Error)?.message ?? String(error);
					if (error instanceof DownloadError && message === "not published" && at !== months[months.length - 1]) continue;
					this.log(`geoip: downloading ${url.slice(url.lastIndexOf("/") + 1)} failed (${message}); trying again tomorrow`);
					failed = true;
					break;
				}
			}
		}
		if (updated && !this.stopped) await this.load();
		this.last = failed ? "failed" : updated ? "updated" : "fresh";
	}
}

