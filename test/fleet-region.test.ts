/**
 * game.ServerRegion as the server's location: the heartbeat's optional `region` (validated, the latest non-empty one
 * kept), the airport table, precedence over the IP lookup (with the network still from it), unknown codes, older
 * kernels unchanged, and the column added to older fleet files. Addresses are documentation ranges; tokens are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/fleet/db.ts";
import { parseRegion, REGION_AIRPORTS, regionAirport } from "../src/fleet/regions.ts";
import { FleetService, parseHeartbeat } from "../src/fleet/service.ts";
import { openApiSpec } from "../src/server/openapi.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";
import { asnFixture, cityFixture } from "./mmdb-fixture.ts";

const hb = (j: string, over: Record<string, unknown> = {}) => ({ j, t: "public", b: "prod", a: "art-1", n: 3, m: 20, v: "0.5.3", q: 1, g: 1, h: "ok", sv: 2, ...over });

describe("parsing", () => {
	test("only three uppercase letters are a region; anything else is ignored, never refused", () => {
		expect(parseRegion("IAD")).toBe("IAD");
		expect(parseRegion("ZZZ")).toBe("ZZZ");
		for (const bad of ["", "iad", "IA", "IADX", " IAD", "IAD\n", "I1D", "ÄBC", 123, null, undefined, ["IAD"], { r: "IAD" }]) expect(parseRegion(bad)).toBeNull();
		expect(parseHeartbeat(hb("j1", { region: "LHR" })).region).toBe("LHR");
		expect(parseHeartbeat(hb("j1", { region: "x".repeat(10_000) })).region).toBeNull();
		expect(parseHeartbeat(hb("j1")).region).toBeNull();
	});

	test("the airport table: well-formed codes, sane coordinates, ISO country codes; unknown and prototype names are null", () => {
		expect(Object.keys(REGION_AIRPORTS).length).toBeGreaterThan(40);
		for (const [code, a] of Object.entries(REGION_AIRPORTS)) {
			expect(code).toMatch(/^[A-Z]{3}$/);
			expect(a.country).toMatch(/^[A-Z]{2}$/);
			expect(Math.abs(a.lat)).toBeLessThanOrEqual(90);
			expect(Math.abs(a.lon)).toBeLessThanOrEqual(180);
		}
		expect(regionAirport("IAD")).toMatchObject({ city: "Ashburn", country: "US", subdivision: "Virginia" });
		expect(regionAirport("SYD")).toMatchObject({ city: "Sydney", country: "AU" });
		expect(regionAirport("QQQ")).toBeNull();
		expect(regionAirport("constructor")).toBeNull();
		expect(regionAirport(null)).toBeNull();
	});
});

describe("the routes", () => {
	let h: Harness;
	const dir = mkdtempSync(join(tmpdir(), "tt-region-files-"));
	const cityPath = join(dir, "city.mmdb");
	const asnPath = join(dir, "asn.mmdb");

	beforeAll(async () => {
		writeFileSync(cityPath, cityFixture());
		writeFileSync(asnPath, asnFixture());
		h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_GEOIP: cityPath, TYPETORCH_GEOIP_ASN: asnPath });
	});
	afterAll(async () => {
		await h.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const server = async (job: string) => (await asJson(await h.call(`/v1/fleet/servers/${job}`, { headers: bearer(ADMIN) }))).server;

	test("an older kernel (no region): the IP lookup exactly as before, geoSource ip", async () => {
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("old-kernel")), ip: "192.0.2.7" })).status).toBe(202);
		await h.app.geo.flush();
		expect(await server("old-kernel")).toMatchObject({
			region: null,
			geoSource: "ip",
			location: { country: "US", countryName: "United States", region: "Virginia", city: "Sterling", lat: 39.0067, lon: -77.4291, asn: 22697, org: "Roblox" },
		});
	});

	test("a region wins over the IP lookup (city, country, coordinates); the network still comes from the address", async () => {
		// The address says Frankfurt; Roblox says Amsterdam.
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("new-kernel", { region: "AMS" })), ip: "198.51.100.1" })).status).toBe(202);
		await h.app.geo.flush();
		const s = await server("new-kernel");
		expect(s).toMatchObject({ region: "AMS", geoSource: "roblox", location: { country: "NL", countryName: "Netherlands", city: "Amsterdam", lat: 52.37, lon: 4.9 } });
		const list = await asJson(await h.call("/v1/fleet/servers", { headers: bearer(ADMIN) }));
		expect(list.servers.find((x: { job: string }) => x.job === "new-kernel")).toMatchObject({ region: "AMS", geoSource: "roblox", location: { city: "Amsterdam" } });
		// The Sterling address' network (AS22697 Roblox) rides along with a region.
		h.setNow(h.now() + 1000);
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("new-kernel", { region: "IAD" })), ip: "192.0.2.7" })).status).toBe(202);
		await h.app.geo.flush();
		expect(await server("new-kernel")).toMatchObject({ region: "IAD", geoSource: "roblox", location: { city: "Ashburn", country: "US", asn: 22697, org: "Roblox" } });
	});

	test("the latest non-empty region is kept: a heartbeat without one (or a malformed one) changes nothing", async () => {
		for (const over of [{}, { region: "" }, { region: "iad" }, { region: 7 }]) {
			h.setNow(h.now() + 1000);
			expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("new-kernel", over)), ip: "192.0.2.7" })).status).toBe(202);
			expect((await server("new-kernel")).region).toBe("IAD");
		}
	});

	test("an unknown code is shown as itself: no city or coordinates (never the IP estimate's)", async () => {
		// A private address: no IP lookup either, so no location at all, just the code.
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("future-dc", { region: "QQQ" })), ip: "10.1.2.3" })).status).toBe(202);
		await h.app.geo.flush();
		expect(await server("future-dc")).toMatchObject({ region: "QQQ", geoSource: "roblox", location: null });
		// A known address: the network only.
		h.setNow(h.now() + 1000);
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("future-dc", { region: "QQQ" })), ip: "192.0.2.7" })).status).toBe(202);
		await h.app.geo.flush();
		expect(await server("future-dc")).toMatchObject({ region: "QQQ", geoSource: "roblox", location: { country: null, city: null, lat: null, lon: null, asn: 22697 } });
	});

	test("the closing request's heartbeat can carry it too", async () => {
		expect((await h.call("/v1/fleet/closing", { ...post(API, hb("closing-dc", { closing: true, region: "SYD" })), ip: "10.1.2.4" })).status).toBe(202);
		const gone = await asJson(await h.call("/v1/fleet/servers?gone=1", { headers: bearer(ADMIN) }));
		expect(gone.servers.find((x: { job: string }) => x.job === "closing-dc")).toMatchObject({ region: "SYD", geoSource: "roblox", location: { city: "Sydney" } });
	});

	test("no location at all: geoSource null", async () => {
		expect((await h.call("/v1/fleet/heartbeat", { ...post(API, hb("nowhere")), ip: "10.9.9.9" })).status).toBe(202);
		await h.app.geo.flush();
		expect(await server("nowhere")).toMatchObject({ region: null, geoSource: null, location: null });
	});
});

describe("the migration and docs", () => {
	test("a fleet file without the column gets it; its rows read with no region", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-region-migrate-"));
		try {
			const path = join(dir, "fleet.sqlite");
			const old = await openSqlite(path);
			await old.exec(
				"CREATE TABLE servers (job TEXT PRIMARY KEY, server_type TEXT, branch TEXT, channel TEXT, artifact TEXT, players INTEGER, max_players INTEGER, started_at INTEGER, " +
					"last_write INTEGER, place_id INTEGER, experiment INTEGER, kernel TEXT, applied_seq INTEGER, generation INTEGER, health TEXT, last_error TEXT, server_version INTEGER, " +
					"sent_at INTEGER, budget TEXT, tps REAL, tps_min REAL, phys_fps REAL, mem_mb REAL, lua_mb REAL, place_version INTEGER, ip TEXT, first_ip TEXT, ip_changed_at INTEGER, cv TEXT, " +
					"first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, closed_at INTEGER, lost_at INTEGER);",
			);
			await old.run("INSERT INTO servers (job, branch, first_seen, last_seen) VALUES (?, ?, ?, ?)", ["old-job", "prod", T0, T0]);
			await old.close();
			const db = await openSqlite(path);
			const fleet = await FleetService.open({ db, clock: () => T0 + 1000 });
			expect((await db.all<{ name: string }>("PRAGMA table_info(servers)")).map((c) => c.name)).toContain("server_region");
			expect((await fleet.server("old-job")).server).toMatchObject({ region: null, geoSource: null, location: null });
			await fleet.applyHeartbeat({ ...parseHeartbeat(hb("old-job", { region: "GRU" })), ip: null });
			expect((await fleet.server("old-job")).server).toMatchObject({ region: "GRU", geoSource: "roblox", location: { country: "BR", city: "Sao Paulo" } });
			await fleet.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the OpenAPI spec documents region and geoSource", () => {
		const props = (openApiSpec() as { components: { schemas: { FleetServer: { properties: Record<string, unknown> } } } }).components.schemas.FleetServer.properties;
		expect(Object.keys(props)).toEqual(expect.arrayContaining(["region", "geoSource", "location"]));
	});
});
