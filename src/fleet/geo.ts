/**
 * Where game servers are: the public IP a server's heartbeats come from (resolved by the host, trusted proxies and
 * Cloudflare aware) and its location from an offline IP database (an .mmdb file: DB-IP's free "IP to City Lite" and
 * "IP to ASN Lite" by default, MaxMind GeoLite2 files work too). No address ever leaves the backend for a lookup.
 *
 * The heartbeat only calls `note(ip)`: a Map check, and a new address goes into a bounded pending set. A timer then
 * looks a batch up (in memory, microseconds each) and writes it to the `ip_geo` table in one transaction; the fleet's
 * server reads join that table on the server's latest IP. Without a database (missing, still downloading, or off)
 * nothing is looked up and locations stay unknown; when one is loaded, addresses of the servers already stored are
 * looked up then (`setReader`'s backfill).
 *
 * Bounds: at most GEO_MAX_PENDING addresses wait (more are dropped until the next heartbeat brings them again), the
 * in-memory "already looked up" map holds GEO_CACHE_MAX addresses (oldest dropped first), and the table only keeps
 * addresses some servers row still names (FleetService's hourly retention prunes the rest).
 */
import { Reader, type AsnResponse, type CityResponse } from "mmdb-lib";
import { parseIp } from "../server/ipfilter.ts";
import type { FleetDb } from "./db.ts";

/** One address' location; every field null when the database doesn't know it. */
export interface GeoLocation {
	/** ISO 3166-1 alpha-2 country code ("US"). */
	country: string | null;
	countryName: string | null;
	/** The first subdivision (state, province, region). */
	region: string | null;
	city: string | null;
	/** Approximate (city level at best), degrees. */
	lat: number | null;
	lon: number | null;
	/** The autonomous system (with an ASN database). */
	asn: number | null;
	org: string | null;
}

/** An opened database. `lookup` returns null for an address it has no entry for (private ranges, unknown ones). */
export interface GeoReader {
	lookup(ip: string): GeoLocation | null;
	/** What the explorer shows next to locations: the database's name, the licence's attribution, its build time. */
	readonly info: GeoSourceInfo;
}

export interface GeoSourceInfo {
	/** "DB-IP City Lite" or the file's database_type. */
	source: string;
	/** The attribution the database's licence asks for (DB-IP Lite: CC BY 4.0), or null. */
	attribution: string | null;
	attributionUrl: string | null;
	/** When the database was built (unix ms), or null. */
	built: number | null;
}

/** GET /v1/fleet/servers' `geo`: whether locations can be shown, and the source to credit. */
export interface GeoStatus {
	/** ready: a database is loaded. missing: on, but no database yet (first download running or failed). off: TYPETORCH_GEOIP=off. */
	state: "ready" | "missing" | "off";
	source: string | null;
	attribution: string | null;
	attributionUrl: string | null;
	/** ISO time the database was built, or null. */
	built: string | null;
}

/** What the fleet service needs from the locator. */
export interface GeoSink {
	note(ip: string): void;
	status(): GeoStatus;
	stop(): void;
}

export const GEO_OFF: GeoStatus = { state: "off", source: null, attribution: null, attributionUrl: null, built: null };

/** Addresses waiting for a lookup at most. */
export const GEO_MAX_PENDING = 2000;
/** Addresses remembered as looked up at most (the table holds them all; this only spares a write). */
export const GEO_CACHE_MAX = 20_000;
/** Addresses looked up and written per transaction; the next batch waits for the next turn of the event loop. */
export const GEO_BATCH = 250;
/** A stored lookup older than this is done again (databases are refreshed monthly). */
export const GEO_RECHECK_MS = 30 * 86_400_000;
/** Addresses of stored servers looked up when a database is loaded, at most. */
export const GEO_BACKFILL_MAX = 5000;

/** The table (created by FleetService.open, so the server reads can always join it). Columns are prefixed g. in reads. */
export const IP_GEO_SCHEMA = `
CREATE TABLE IF NOT EXISTS ip_geo (
	ip TEXT PRIMARY KEY, country TEXT, country_name TEXT, region TEXT, city TEXT, lat REAL, lon REAL, asn INTEGER, org TEXT,
	source TEXT, looked_up INTEGER NOT NULL);
`;

// Addresses ---------------------------------------------------------------------------------------------------------------

/**
 * An address in one canonical text form, or null when it isn't one: IPv4 dotted (an IPv4-mapped IPv6 address becomes
 * IPv4), IPv6 lower case with the longest run of zero groups as "::" (RFC 5952). Zones and brackets are dropped.
 */
export function normalizeIp(text: string | null | undefined): string | null {
	if (typeof text !== "string" || text.length === 0 || text.length > 64) return null;
	const parsed = parseIp(text);
	if (!parsed) return null;
	if (parsed.version === 4) {
		const a = parsed.address;
		return [24n, 16n, 8n, 0n].map((shift) => String((a >> shift) & 0xffn)).join(".");
	}
	const groups: number[] = [];
	for (let i = 7; i >= 0; i--) groups.push(Number((parsed.address >> BigInt(i * 16)) & 0xffffn));
	// The longest run of two or more zero groups (the first one on a tie) becomes "::".
	let bestAt = -1;
	let bestLen = 1;
	for (let i = 0; i < 8; ) {
		if (groups[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && groups[j] === 0) j++;
		if (j - i > bestLen) {
			bestAt = i;
			bestLen = j - i;
		}
		i = j;
	}
	const hex = (list: number[]) => list.map((g) => g.toString(16)).join(":");
	if (bestAt < 0) return hex(groups);
	return `${hex(groups.slice(0, bestAt))}::${hex(groups.slice(bestAt + bestLen))}`;
}

// Databases ---------------------------------------------------------------------------------------------------------------

const TEXT_MAX = 128;
const clip = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, TEXT_MAX) : null);
const coord = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max ? v : null);

/** The location fields of a City (or Country) record and an ASN record; null when neither says anything. */
export function locationOf(city: CityResponse | null | undefined, asn: AsnResponse | null | undefined): GeoLocation | null {
	const out: GeoLocation = {
		country: clip(city?.country?.iso_code ?? city?.registered_country?.iso_code),
		countryName: clip(city?.country?.names?.en ?? city?.registered_country?.names?.en),
		region: clip(city?.subdivisions?.[0]?.names?.en),
		city: clip(city?.city?.names?.en),
		lat: coord(city?.location?.latitude, 90),
		lon: coord(city?.location?.longitude, 180),
		asn: typeof asn?.autonomous_system_number === "number" && Number.isSafeInteger(asn.autonomous_system_number) ? asn.autonomous_system_number : null,
		org: clip(asn?.autonomous_system_organization),
	};
	return Object.values(out).some((v) => v !== null) ? out : null;
}

/** DB-IP's Lite databases are CC BY 4.0: wherever their data is shown, credit DB-IP with a link. */
export const DBIP_ATTRIBUTION = "IP geolocation by DB-IP";
export const DBIP_URL = "https://db-ip.com";

/** Opens an .mmdb file's bytes and checks its kind (a City or Country database, or an ASN one); throws when it isn't. */
export function openMmdb<T extends CityResponse | AsnResponse>(bytes: Buffer, kind: "city" | "asn"): Reader<T> {
	const reader = new Reader<T>(bytes);
	const type = String(reader.metadata.databaseType ?? "");
	if (kind === "city" ? !/city|country/i.test(type) : !/asn/i.test(type)) throw new Error(`not ${kind === "city" ? "a City or Country" : "an ASN"} database (${type.slice(0, 64)})`);
	return reader;
}

function isDbip(reader: Reader<never>): boolean {
	return /dbip|db-ip/i.test(reader.metadata.databaseType ?? "");
}

/**
 * A reader over a City database and optionally an ASN one (the files' bytes; a Buffer view of an mmap works). Throws
 * when a file isn't an .mmdb database or isn't the kind expected (a City/Country database first, an ASN one second).
 */
export function mmdbReader(cityBytes: Buffer, asnBytes?: Buffer): GeoReader {
	const city = openMmdb<CityResponse>(cityBytes, "city");
	const asn = asnBytes ? openMmdb<AsnResponse>(asnBytes, "asn") : undefined;
	const dbip = isDbip(city as Reader<never>);
	const built = city.metadata.buildEpoch instanceof Date && Number.isFinite(city.metadata.buildEpoch.getTime()) ? city.metadata.buildEpoch.getTime() : null;
	const info: GeoSourceInfo = {
		source: dbip ? `DB-IP ${/city/i.test(city.metadata.databaseType) ? "City" : "Country"} Lite${asn ? " + ASN Lite" : ""}` : clip(city.metadata.databaseType) ?? "mmdb",
		attribution: dbip ? DBIP_ATTRIBUTION : null,
		attributionUrl: dbip ? DBIP_URL : null,
		built,
	};
	const get = <T>(r: Reader<T & object> | undefined, ip: string): T | null => {
		if (!r) return null;
		try {
			return r.get(ip) as T | null;
		} catch {
			return null;
		}
	};
	return { info, lookup: (ip) => locationOf(get<CityResponse>(city, ip), get<AsnResponse>(asn as Reader<AsnResponse> | undefined, ip)) };
}

// The locator ---------------------------------------------------------------------------------------------------------------

export interface GeoLocatorOptions {
	db: FleetDb;
	/** False: TYPETORCH_GEOIP=off (status "off", nothing looked up). */
	enabled?: boolean;
	clock?: () => number;
	log?: (line: string) => void;
	/** Delay before a batch runs after a new address, ms (default 50: one batch for a burst of heartbeats). */
	flushDelayMs?: number;
}

export class GeoLocator implements GeoSink {
	private reader: GeoReader | undefined;
	/** Address -> when it was last looked up (insertion order = age, for eviction). */
	private readonly known = new Map<string, number>();
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | undefined;
	private stopped = false;
	private readonly clock: () => number;
	/** Addresses dropped because the pending set was full (tests, /healthz-style counters). */
	dropped = 0;

	constructor(private readonly options: GeoLocatorOptions) {
		this.clock = options.clock ?? Date.now;
	}

	get enabled(): boolean {
		return this.options.enabled !== false;
	}

	get ready(): boolean {
		return this.reader !== undefined;
	}

	status(): GeoStatus {
		if (!this.enabled) return GEO_OFF;
		const info = this.reader?.info;
		if (!info) return { state: "missing", source: null, attribution: null, attributionUrl: null, built: null };
		return { state: "ready", source: info.source, attribution: info.attribution, attributionUrl: info.attributionUrl, built: info.built === null ? null : new Date(info.built).toISOString() };
	}

	/**
	 * A new database (or none). Stored lookups stay readable; live servers' addresses are looked up again in the new
	 * database on their next heartbeat (the in-memory map starts empty), and the addresses of stored servers with no
	 * recent lookup (gone ones too) are queued now, at most GEO_BACKFILL_MAX.
	 */
	async setReader(reader: GeoReader | undefined): Promise<void> {
		this.reader = this.enabled ? reader : undefined;
		this.known.clear();
		if (!this.reader || this.stopped) return;
		const rows = await this.options.db.all<{ ip: string }>(
			"SELECT DISTINCT a.ip AS ip FROM (SELECT ip FROM servers WHERE ip IS NOT NULL UNION SELECT first_ip AS ip FROM servers WHERE first_ip IS NOT NULL) a " +
				"WHERE NOT EXISTS (SELECT 1 FROM ip_geo g WHERE g.ip = a.ip AND g.looked_up >= ?) LIMIT ?",
			[this.clock() - GEO_RECHECK_MS, GEO_BACKFILL_MAX],
		);
		for (const r of rows) this.note(r.ip);
	}

	/** The heartbeat's call: never waits, never throws. */
	note(ip: string): void {
		if (!this.reader || this.stopped) return;
		const seen = this.known.get(ip);
		if (seen !== undefined && this.clock() - seen < GEO_RECHECK_MS) return;
		if (this.pending.has(ip)) return;
		if (this.pending.size >= GEO_MAX_PENDING) {
			this.dropped++;
			return;
		}
		this.pending.add(ip);
		this.schedule();
	}

	private schedule(): void {
		if (this.timer || this.running || this.stopped) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.running = this.flushBatch()
				.catch((error) => this.options.log?.(`geoip: storing lookups failed: ${(error as Error)?.message ?? error}`))
				.finally(() => {
					this.running = undefined;
					if (this.pending.size) this.schedule();
				});
		}, this.options.flushDelayMs ?? 50);
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** Looks up and stores one batch (GEO_BATCH addresses). */
	private async flushBatch(): Promise<void> {
		const reader = this.reader;
		if (!reader || this.stopped || !this.pending.size) return;
		const batch: string[] = [];
		for (const ip of this.pending) {
			batch.push(ip);
			if (batch.length >= GEO_BATCH) break;
		}
		for (const ip of batch) this.pending.delete(ip);
		const now = this.clock();
		const rows = batch.map((ip) => ({ ip, loc: reader.lookup(ip) }));
		await this.options.db.transaction((tx) => {
			for (const { ip, loc } of rows) {
				tx.run(
					"INSERT INTO ip_geo (ip, country, country_name, region, city, lat, lon, asn, org, source, looked_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
						"ON CONFLICT(ip) DO UPDATE SET country = excluded.country, country_name = excluded.country_name, region = excluded.region, city = excluded.city, " +
						"lat = excluded.lat, lon = excluded.lon, asn = excluded.asn, org = excluded.org, source = excluded.source, looked_up = excluded.looked_up",
					[ip, loc?.country ?? null, loc?.countryName ?? null, loc?.region ?? null, loc?.city ?? null, loc?.lat ?? null, loc?.lon ?? null, loc?.asn ?? null, loc?.org ?? null, reader.info.source, now],
				);
			}
		});
		for (const { ip } of rows) {
			this.known.delete(ip);
			this.known.set(ip, now);
		}
		while (this.known.size > GEO_CACHE_MAX) {
			const oldest = this.known.keys().next().value as string;
			this.known.delete(oldest);
		}
	}

	/** Runs every pending lookup now (tests; the shutdown doesn't need it: the next heartbeat brings them again). */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		while (this.running) await this.running;
		while (this.pending.size && this.reader && !this.stopped) await this.flushBatch();
	}

	/** Before the database closes: no more batches. */
	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}

	/** Pending addresses (tests). */
	get queued(): number {
		return this.pending.size;
	}
}
