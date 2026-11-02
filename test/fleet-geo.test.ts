/**
 * Game server addresses and locations: the address on the server row (first and latest, the migration of older
 * files), the offline lookups (a tiny .mmdb fixture read by the real reader, and a counting fake for the cache), the
 * roles (the web role gets locations, never addresses) and the DB-IP download. Addresses are documentation ranges;
 * every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openSqlite, type FleetDb } from "../src/fleet/db.ts";
import { GEO_MAX_PENDING, GeoLocator, mmdbReader, normalizeIp, type GeoLocation, type GeoReader } from "../src/fleet/geo.ts";
import { FleetService, LOST_AFTER_MS, parseHeartbeat } from "../src/fleet/service.ts";
import { loadConfig } from "../src/server/config.ts";
import { dbipUrl, DBIP_FILES, downloadMmdb, GeoIpUpdater } from "../src/server/geoip.ts";
import { openApiSpec } from "../src/server/openapi.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";
import { asnFixture, cityFixture } from "./mmdb-fixture.ts";

const hb = (j: string, over: Record<string, unknown> = {}) => ({ j, t: "public", b: "prod", a: "art-1", n: 3, m: 20, v: "0.5.3", q: 1, g: 1, h: "ok", sv: 2, ...over });

describe("addresses", () => {
	test("normalizeIp: one text form per address, null for anything else", () => {
		expect(normalizeIp("192.0.2.7")).toBe("192.0.2.7");
		expect(normalizeIp(" ::ffff:192.0.2.7 ")).toBe("192.0.2.7");
		expect(normalizeIp("[2001:DB8:0:0:0:0:0:1]")).toBe("2001:db8::1");
		expect(normalizeIp("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
		expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
		expect(normalizeIp("::")).toBe("::");
		expect(normalizeIp("1:2:3:4:5:6:7:8")).toBe("1:2:3:4:5:6:7:8");
		for (const bad of ["", "unknown", "256.1.1.1", "1.2.3", "1::2::3", "x".repeat(100), null, undefined]) expect(normalizeIp(bad)).toBeNull();
	});
});

describe("the .mmdb reader", () => {
	test("reads a City and an ASN database: country, region, city, coordinates, AS; unknown is null", () => {
		const reader = mmdbReader(cityFixture(), asnFixture());
		expect(reader.lookup("192.0.2.7")).toEqual({ country: "US", countryName: "United States", region: "Virginia", city: "Sterling", lat: 39.0067, lon: -77.4291, asn: 22697, org: "Roblox" });
		expect(reader.lookup("198.51.100.1")).toMatchObject({ country: "DE", city: "Frankfurt am Main", region: "Hesse", asn: null, org: null });
		expect(reader.lookup("203.0.113.9")).toEqual({ country: "JP", countryName: "Japan", region: null, city: null, lat: null, lon: null, asn: null, org: null });
		expect(reader.lookup("10.0.0.1")).toBeNull();
		expect(reader.lookup("not an address")).toBeNull();
		// DB-IP Lite is CC BY 4.0: the source says so, for the explorer's credit line.
		expect(reader.info).toMatchObject({ source: "DB-IP City Lite + ASN Lite", attribution: "IP geolocation by DB-IP", attributionUrl: "https://db-ip.com" });
		expect(reader.info.built).toBe(1_793_000_000_000);
	});

	test("a file of the wrong kind or not a database at all is refused", () => {
		expect(() => mmdbReader(asnFixture())).toThrow(/City or Country/);
		expect(() => mmdbReader(cityFixture(), cityFixture())).toThrow(/ASN/);
		expect(() => mmdbReader(Buffer.from("not a database at all"))).toThrow();
		// Any other City database (MaxMind GeoLite2) works, without the DB-IP credit.
		expect(mmdbReader(cityFixture("GeoLite2-City")).info).toMatchObject({ source: "GeoLite2-City", attribution: null });
	});
});

/** A reader that counts its lookups. */
function countingReader(known: Record<string, Partial<GeoLocation>> = {}): GeoReader & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		info: { source: "test db", attribution: null, attributionUrl: null, built: null },
		lookup(ip) {
			calls.push(ip);
			const hit = known[ip];
			return hit ? { country: null, countryName: null, region: null, city: null, lat: null, lon: null, asn: null, org: null, ...hit } : null;
		},
	};
}

describe("the fleet service", () => {
	let db: FleetDb;
	let geo: GeoLocator;
	let fleet: FleetService;
	let now = T0;
	beforeAll(async () => {
		db = await openSqlite(":memory:");
		geo = new GeoLocator({ db, clock: () => now, flushDelayMs: 60_000 });
		fleet = await FleetService.open({ db, clock: () => now, geo });
	});
	afterAll(() => fleet.close());

	const beat = (job: string, ip: string | null) => fleet.applyHeartbeat({ ...parseHeartbeat(hb(job)), ip });
	const one = async (job: string) => (await fleet.server(job)).server;

	test("the row keeps the first address and the latest one, and when it changed", async () => {
		await beat("job-a", "192.0.2.7");
		expect(await one("job-a")).toMatchObject({ ip: "192.0.2.7", firstIp: "192.0.2.7", ipChangedAt: null, location: null });
		now += 30_000;
		// A heartbeat with no address (an embedder, a test) keeps the stored one.
		await beat("job-a", null);
		expect(await one("job-a")).toMatchObject({ ip: "192.0.2.7", ipChangedAt: null });
		now += 30_000;
		await beat("job-a", "198.51.100.1");
		expect(await one("job-a")).toMatchObject({ ip: "198.51.100.1", firstIp: "192.0.2.7", ipChangedAt: new Date(now).toISOString() });
	});

	test("without a database: status missing, no lookups, locations unknown", async () => {
		expect(fleet.geoStatus()).toMatchObject({ state: "missing", source: null });
		expect(geo.queued).toBe(0);
		expect((await fleet.servers()).geo.state).toBe("missing");
	});

	test("a database loaded later looks up the stored servers' addresses (backfill), once each", async () => {
		const reader = countingReader({ "198.51.100.1": { country: "DE", city: "Frankfurt am Main" }, "192.0.2.7": { country: "US" } });
		await geo.setReader(reader);
		expect(geo.queued).toBe(2);
		await geo.flush();
		expect(reader.calls.sort()).toEqual(["192.0.2.7", "198.51.100.1"]);
		expect((await one("job-a"))?.location).toMatchObject({ country: "DE", city: "Frankfurt am Main" });
		expect(fleet.geoStatus()).toMatchObject({ state: "ready", source: "test db" });
	});

	test("the heartbeat never waits on a lookup, and an address is looked up once however many heartbeats bring it", async () => {
		const reader = countingReader({ "203.0.113.9": { country: "JP" } });
		await geo.setReader(reader);
		await geo.flush();
		reader.calls.length = 0;
		for (let i = 0; i < 20; i++) {
			now += 1000;
			await beat(`job-many-${i % 4}`, "203.0.113.9");
		}
		// Nothing looked up yet: the heartbeats only queued it (once).
		expect(reader.calls).toEqual([]);
		expect(geo.queued).toBe(1);
		await geo.flush();
		for (let i = 0; i < 5; i++) await beat("job-many-0", "203.0.113.9");
		await geo.flush();
		expect(reader.calls).toEqual(["203.0.113.9"]);
		const live = await fleet.servers();
		expect(live.servers.filter((s) => s.job.startsWith("job-many-")).map((s) => s.location?.country)).toEqual(["JP", "JP", "JP", "JP"]);
		// An address the database doesn't know: looked up once, stored as unknown (null location).
		await beat("job-private", "10.1.2.3");
		await geo.flush();
		await beat("job-private", "10.1.2.3");
		await geo.flush();
		expect(reader.calls.filter((ip) => ip === "10.1.2.3")).toHaveLength(1);
		expect((await one("job-private"))?.location).toBeNull();
	});

	test("the pending set is bounded: past GEO_MAX_PENDING new addresses wait for a later heartbeat", async () => {
		const reader = countingReader();
		await geo.setReader(reader);
		await geo.flush();
		const before = geo.dropped;
		for (let i = 0; i < GEO_MAX_PENDING + 10; i++) geo.note(`2001:db8::${(i + 1).toString(16)}`);
		expect(geo.queued).toBe(GEO_MAX_PENDING);
		expect(geo.dropped - before).toBe(10);
		await geo.flush();
		expect(geo.queued).toBe(0);
	});

	test("the hourly retention drops stored locations no server names any more", async () => {
		const count = async () => (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM ip_geo"))?.n ?? 0;
		expect(await count()).toBeGreaterThan(GEO_MAX_PENDING);
		now += LOST_AFTER_MS + 3_700_000;
		await fleet.sweep();
		const left = await db.all<{ ip: string }>("SELECT ip FROM ip_geo ORDER BY ip");
		expect(left.map((r) => r.ip)).toEqual(["10.1.2.3", "192.0.2.7", "198.51.100.1", "203.0.113.9"]);
	});
});

describe("the migration", () => {
	test("a fleet file from before addresses gets the columns and the table; its rows read with no address", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-geo-migrate-"));
		try {
			const path = join(dir, "fleet.sqlite");
			const old = await openSqlite(path);
			// The servers table as kernel 0.5.x backends made it (place_version, no address columns).
			await old.exec(
				"CREATE TABLE servers (job TEXT PRIMARY KEY, server_type TEXT, branch TEXT, channel TEXT, artifact TEXT, players INTEGER, max_players INTEGER, started_at INTEGER, " +
					"last_write INTEGER, place_id INTEGER, experiment INTEGER, kernel TEXT, applied_seq INTEGER, generation INTEGER, health TEXT, last_error TEXT, server_version INTEGER, " +
					"sent_at INTEGER, budget TEXT, tps REAL, tps_min REAL, phys_fps REAL, mem_mb REAL, lua_mb REAL, place_version INTEGER, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, closed_at INTEGER, lost_at INTEGER);",
			);
			await old.run("INSERT INTO servers (job, branch, first_seen, last_seen) VALUES (?, ?, ?, ?)", ["old-job", "prod", T0, T0]);
			await old.close();

			const db = await openSqlite(path);
			const fleet = await FleetService.open({ db, clock: () => T0 + 1000 });
			const columns = (await db.all<{ name: string }>("PRAGMA table_info(servers)")).map((c) => c.name);
			expect(columns).toEqual(expect.arrayContaining(["ip", "first_ip", "ip_changed_at"]));
			expect((await db.all<{ name: string }>("PRAGMA table_info(ip_geo)")).map((c) => c.name)).toEqual(["ip", "country", "country_name", "region", "city", "lat", "lon", "asn", "org", "source", "looked_up"]);
			const indexes = (await db.all<{ name: string }>("PRAGMA index_list(servers)")).map((i) => i.name);
			expect(indexes).toEqual(expect.arrayContaining(["servers_ip", "servers_first_ip"]));
			expect((await fleet.server("old-job")).server).toMatchObject({ job: "old-job", ip: null, firstIp: null, ipChangedAt: null, location: null });
			// Without a locator: status off, heartbeats still store the address.
			expect(fleet.geoStatus().state).toBe("off");
			await fleet.applyHeartbeat({ ...parseHeartbeat(hb("old-job")), ip: "192.0.2.7" });
			expect((await fleet.server("old-job")).server).toMatchObject({ ip: "192.0.2.7", firstIp: "192.0.2.7" });
			await fleet.close();
			// Opening again (a second container in a handover) changes nothing.
			const again = await openSqlite(path);
			const reopened = await FleetService.open({ db: again, clock: () => T0 + 2000 });
			expect((await reopened.server("old-job")).server?.ip).toBe("192.0.2.7");
			await reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the routes", () => {
	let h: Harness;
	let web: Record<string, string>;
	const VIEWER = 5005;
	const dir = mkdtempSync(join(tmpdir(), "tt-geo-files-"));
	const cityPath = join(dir, "city.mmdb");
	const asnPath = join(dir, "asn.mmdb");

	beforeAll(async () => {
		writeFileSync(cityPath, cityFixture());
		writeFileSync(asnPath, asnFixture());
		h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_GEOIP: cityPath, TYPETORCH_GEOIP_ASN: asnPath, TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}` };
	});
	afterAll(async () => {
		await h.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("a heartbeat stores the connection's address (never one the body names); owners see it with the location", async () => {
		const res = await h.call("/v1/fleet/heartbeat", { ...post(API, hb("geo-job", { ip: "198.51.100.1", firstIp: "198.51.100.1" })), ip: "::ffff:192.0.2.7" });
		expect(res.status).toBe(202);
		await h.app.geo.flush();
		const list = await asJson(await h.call("/v1/fleet/servers", { headers: bearer(ADMIN) }));
		expect(list.servers[0]).toMatchObject({
			job: "geo-job",
			ip: "192.0.2.7",
			firstIp: "192.0.2.7",
			location: { country: "US", countryName: "United States", region: "Virginia", city: "Sterling", asn: 22697, org: "Roblox" },
		});
		expect(list.geo).toMatchObject({ state: "ready", source: "DB-IP City Lite + ASN Lite", attribution: "IP geolocation by DB-IP", attributionUrl: "https://db-ip.com" });
		const detail = await asJson(await h.call("/v1/fleet/servers/geo-job", { headers: bearer(ADMIN) }));
		expect(detail.server).toMatchObject({ ip: "192.0.2.7", location: { city: "Sterling" } });
		expect(detail.geo.state).toBe("ready");
	});

	test("the web role gets locations but never addresses: lists, the server view, reports and the stream", async () => {
		const list = await asJson(await h.call("/v1/fleet/servers", { headers: web }));
		expect(list.servers[0].location).toMatchObject({ country: "US", city: "Sterling" });
		expect(list.servers[0]).not.toHaveProperty("ip");
		expect(list.servers[0]).not.toHaveProperty("firstIp");
		const detail = await asJson(await h.call("/v1/fleet/servers/geo-job", { headers: web }));
		expect(detail.server.location.city).toBe("Sterling");
		expect(detail.server).not.toHaveProperty("ip");
		expect(detail.server).not.toHaveProperty("firstIp");
		// A deploy the server is behind on: the report lists it under `behind`.
		expect((await h.call("/v1/fleet/deploy", post(API, { s: 9, b: "prod", a: "art-2" }))).status).toBe(202);
		const reports = await asJson(await h.call("/v1/fleet/reports?seq=9", { headers: web }));
		expect(reports.behind.length).toBeGreaterThan(0);
		expect(JSON.stringify(reports)).not.toContain("192.0.2.7");
		expect(JSON.stringify(await asJson(await h.call("/v1/fleet/reports?seq=9", { headers: bearer(ADMIN) })))).toContain("192.0.2.7");
		// The stream: a server event as the web role sees it.
		const stream = await h.call("/v1/fleet/stream?types=server", { headers: web });
		const reader = stream.body!.getReader();
		await reader.read(); // hello
		h.setNow(h.now() + 1000);
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("geo-job-2")), ip: "192.0.2.8" })).status).toBe(202);
		const chunk = new TextDecoder().decode((await reader.read()).value);
		await reader.cancel();
		expect(chunk).toContain("event: server");
		expect(chunk).toContain("geo-job-2");
		expect(chunk).not.toContain("192.0.2.8");
		// Gone servers too.
		expect((await h.call("/v1/fleet/closing", { ...post(API, { j: "geo-job-2", closing: true }), ip: "192.0.2.8" })).status).toBe(202);
		const gone = await asJson(await h.call("/v1/fleet/servers?gone=1", { headers: web }));
		expect(gone.servers.find((s: { job: string }) => s.job === "geo-job-2")).not.toHaveProperty("ip");
		const goneAdmin = await asJson(await h.call("/v1/fleet/servers?gone=1", { headers: bearer(ADMIN) }));
		expect(goneAdmin.servers.find((s: { job: string }) => s.job === "geo-job-2")).toMatchObject({ ip: "192.0.2.8" });
	});

	test("an address that isn't one (a misconfigured proxy header) is stored as unknown", async () => {
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("geo-job-3")), ip: "unknown" })).status).toBe(202);
		const detail = await asJson(await h.call("/v1/fleet/servers/geo-job-3", { headers: bearer(ADMIN) }));
		expect(detail.server).toMatchObject({ ip: null, location: null });
	});
});

describe("the DB-IP download", () => {
	const at = Date.UTC(2026, 10, 2, 12);
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "tt-geo-dl-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/** Serves the fixtures for the months listed; 404 for anything else. */
	function server(months: string[], body: (kind: string) => Uint8Array = (kind) => gzipSync(kind === "city" ? cityFixture() : asnFixture())) {
		const urls: string[] = [];
		const fake = (async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			const m = /dbip-(city|asn)-lite-(\d{4}-\d{2})\.mmdb\.gz$/.exec(url);
			if (!m || !months.includes(m[2])) return new Response("not found", { status: 404 });
			return new Response(body(m[1]) as Uint8Array<ArrayBuffer>, { status: 200 });
		}) as typeof fetch;
		return { fake, urls };
	}

	test("the release URL names the kind and the UTC month", () => {
		expect(dbipUrl("city", at)).toBe("https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz");
		expect(dbipUrl("asn", Date.UTC(2027, 0, 1))).toBe("https://download.db-ip.com/free/dbip-asn-lite-2027-01.mmdb.gz");
	});

	test("a first install takes last month's release while this month's isn't out, then loads it", async () => {
		const db = await openSqlite(":memory:");
		const geo = new GeoLocator({ db, clock: () => at });
		const fleet = await FleetService.open({ db, clock: () => at, geo });
		const logs: string[] = [];
		const { fake, urls } = server(["2026-10"]);
		const updater = new GeoIpUpdater({ config: { mode: "dbip", dir }, locator: geo, fetch: fake, clock: () => at, log: (l) => logs.push(l) });
		await updater.load();
		expect(geo.ready).toBe(false);
		await updater.check();
		expect(updater.last).toBe("updated");
		expect(urls.map((u) => u.slice(u.lastIndexOf("/") + 1))).toEqual(["dbip-city-lite-2026-11.mmdb.gz", "dbip-city-lite-2026-10.mmdb.gz", "dbip-asn-lite-2026-11.mmdb.gz", "dbip-asn-lite-2026-10.mmdb.gz"]);
		expect(existsSync(join(dir, DBIP_FILES.city))).toBe(true);
		expect(geo.status()).toMatchObject({ state: "ready", source: "DB-IP City Lite + ASN Lite" });
		expect(readdirSync(dir).sort()).toEqual([DBIP_FILES.asn, DBIP_FILES.city].sort());
		// Fresh this month: the next check downloads nothing.
		urls.length = 0;
		await updater.check();
		expect(urls).toEqual([]);
		expect(updater.last).toBe("fresh");
		await fleet.close();
	});

	test("a file from an earlier month is replaced by this month's; a failed download keeps the old file", async () => {
		const old = (at - 40 * 86_400_000) / 1000;
		for (const name of Object.values(DBIP_FILES)) utimesSync(join(dir, name), old, old);
		const db = await openSqlite(":memory:");
		const geo = new GeoLocator({ db, clock: () => at });
		const fleet = await FleetService.open({ db, clock: () => at, geo });
		// This month's "release" is not a database: refused, the old files stay and stay loaded.
		const broken = server(["2026-11"], () => gzipSync(Buffer.from("this is not an mmdb file")));
		const logs: string[] = [];
		const updater = new GeoIpUpdater({ config: { mode: "dbip", dir }, locator: geo, fetch: broken.fake, clock: () => at, log: (l) => logs.push(l) });
		await updater.load();
		expect(geo.ready).toBe(true);
		await updater.check();
		expect(updater.last).toBe("failed");
		expect(logs.join("\n")).toContain("trying again tomorrow");
		expect(readdirSync(dir).sort()).toEqual([DBIP_FILES.asn, DBIP_FILES.city].sort());
		expect(geo.ready).toBe(true);
		// Not yet out (404) with a file already there: no fallback to last month, nothing changes.
		const notYet = server([]);
		const u2 = new GeoIpUpdater({ config: { mode: "dbip", dir }, locator: geo, fetch: notYet.fake, clock: () => at, log: () => {} });
		await u2.check();
		expect(notYet.urls.every((u) => u.includes("2026-11"))).toBe(true);
		// Then it is out.
		const good = server(["2026-11"]);
		const u3 = new GeoIpUpdater({ config: { mode: "dbip", dir }, locator: geo, fetch: good.fake, clock: () => at, log: () => {} });
		await u3.check();
		expect(u3.last).toBe("updated");
		await fleet.close();
	});

	test("downloads are size-capped and leave no temporary file behind", async () => {
		const target = join(dir, "capped.mmdb");
		const { fake } = server(["2026-11"]);
		await expect(downloadMmdb(dbipUrl("city", at), target, { fetch: fake, validate: () => {}, maxBytes: 100 })).rejects.toThrow(/too large/);
		await expect(downloadMmdb(dbipUrl("city", at), target, { fetch: fake, validate: () => {}, maxGzipBytes: 10 })).rejects.toThrow(/too large/);
		expect(readdirSync(dir).filter((n) => n.startsWith("capped"))).toEqual([]);
	});
});

describe("the docs", () => {
	test("the OpenAPI spec documents the address and location fields and the geo status", () => {
		const spec = openApiSpec() as Record<string, any>;
		const schemas = spec.components.schemas;
		expect(Object.keys(schemas.FleetServer.properties)).toEqual(expect.arrayContaining(["ip", "firstIp", "ipChangedAt", "location"]));
		expect(schemas.FleetServer.properties.ip.description).toContain("admin role only");
		expect(Object.keys(schemas.ServerLocation.properties)).toEqual(["country", "countryName", "region", "city", "lat", "lon", "asn", "org"]);
		expect(schemas.GeoStatus.properties.state.enum).toEqual(["ready", "missing", "off"]);
		const list = spec.paths["/v1/fleet/servers"].get.responses["200"].content["application/json"].schema;
		expect(list.properties.geo).toEqual({ $ref: "#/components/schemas/GeoStatus" });
	});
});

describe("the setting", () => {
	const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off" };
	test("TYPETORCH_GEOIP: dbip in production by default, off elsewhere, off, or a file", () => {
		expect(loadConfig([], { ...base, NODE_ENV: "production" }).geoip).toEqual({ mode: "dbip", dir: "/tmp/never-used/geoip" });
		expect(loadConfig([], { ...base, NODE_ENV: "test" }).geoip).toEqual({ mode: "off" });
		expect(loadConfig([], { ...base, NODE_ENV: "production", TYPETORCH_GEOIP: "off" }).geoip).toEqual({ mode: "off" });
		expect(loadConfig([], { ...base, TYPETORCH_GEOIP: "dbip" }).geoip).toEqual({ mode: "dbip", dir: "/tmp/never-used/geoip" });
		expect(loadConfig([], { ...base, TYPETORCH_GEOIP: "/srv/GeoLite2-City.mmdb", TYPETORCH_GEOIP_ASN: "/srv/GeoLite2-ASN.mmdb" }).geoip).toEqual({ mode: "file", city: "/srv/GeoLite2-City.mmdb", asn: "/srv/GeoLite2-ASN.mmdb" });
	});
});
