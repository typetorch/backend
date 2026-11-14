/**
 * Map export (plans/33): the binary formats (a writer here, the backend's reader), map matching by name, the alignment
 * math, the export through a fake Open Cloud (task create -> 429 -> poll -> binary download; a failed task), the routes'
 * gates (viewers can't export, the game key reads nothing) and the map-positions query. No Roblox, no Lune: the export
 * output is built by the writer below the way the Luau script lays it out. Every key and id is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EXPORT_MAGIC, FLAGS, FORMAT_VERSION, halfExtents, MapFormatError, mapBlob, mapRecords, parseExport, readPart, RECORD_BYTES, SHAPES, summarize, type ExportEntry, type Shape } from "../src/maps/format.ts";
import { ALIGNED_SHARE, alignment, pickMaps } from "../src/maps/match.ts";
import { exportScript, luauString, mapKey } from "../src/maps/script.ts";
import { LOBBY, MIN_EXPORT_GAP_MS } from "../src/maps/store.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

// The writer (the Luau script's layout) ---------------------------------------------------------------------------------

interface TestPart {
	pos: [number, number, number];
	q?: [number, number, number, number];
	size: [number, number, number];
	color?: [number, number, number];
	transparency?: number;
	material?: number;
	shape?: Shape;
	flags?: number;
}

interface TestEntry {
	kind: 0 | 1;
	via: 0 | 1 | 2;
	name: string;
	want: string;
	path: string;
	parts: TestPart[];
}

function writeExport(entries: TestEntry[]): Uint8Array {
	const enc = new TextEncoder();
	const chunks: number[] = [];
	const u8 = (v: number) => chunks.push(v & 0xff);
	const u16 = (v: number) => {
		u8(v);
		u8(v >> 8);
	};
	const u32 = (v: number) => {
		u16(v & 0xffff);
		u16(v >>> 16);
	};
	const f32 = (v: number) => {
		const b = new Uint8Array(new Float32Array([v]).buffer);
		for (const x of b) u8(x);
	};
	for (const c of enc.encode(EXPORT_MAGIC)) u8(c);
	u16(FORMAT_VERSION);
	u16(entries.length);
	for (const e of entries) {
		u8(e.kind);
		u8(e.via);
		const name = enc.encode(e.name);
		u8(name.length);
		for (const c of name) u8(c);
		const want = enc.encode(e.want);
		u8(want.length);
		for (const c of want) u8(c);
		const path = enc.encode(e.path);
		u16(path.length);
		for (const c of path) u8(c);
		u32(e.parts.length);
		for (const p of e.parts) {
			for (const v of p.pos) f32(v);
			for (const v of p.q ?? [0, 0, 0, 1]) f32(v);
			for (const v of p.size) f32(v);
			for (const v of p.color ?? [163, 162, 165]) u8(v);
			u8(Math.round((p.transparency ?? 0) * 255));
			u16(p.material ?? 256);
			u8(SHAPES.indexOf(p.shape ?? "block"));
			u8(p.flags ?? FLAGS.collide);
		}
	}
	return new Uint8Array(chunks);
}

const Y90: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const box = (x: number, y: number, z: number, extra: Partial<TestPart> = {}): TestPart => ({ pos: [x, y, z], size: [4, 1, 4], ...extra });

/** A garage far from the origin (like gnome's maps), a smaller same-named copy, the mall, and the lobby. */
function gnomeLike(): TestEntry[] {
	return [
		{ kind: 0, via: 0, name: "ParkingGarage", want: "parking_garage", path: "ReplicatedStorage.assets.maps.ParkingGarage", parts: [box(1000, 0, 1000, { size: [40, 1, 40] }), box(1010, 10, 1010, { q: Y90, size: [20, 2, 4], flags: FLAGS.mesh }), box(990, 5, 990, { transparency: 1, flags: FLAGS.invisible | FLAGS.collide })] },
		{ kind: 0, via: 0, name: "parkinggarage", want: "parking_garage", path: "Workspace.Old.parkinggarage", parts: [box(0, 0, 0)] },
		{ kind: 0, via: 0, name: "Mall", want: "Mall", path: "ReplicatedStorage.assets.maps.Mall", parts: [box(-500, 0, -500, { shape: "wedge", size: [8, 4, 8] }), box(-480, 0, -500, { shape: "cylinder", flags: FLAGS.union })] },
		{ kind: 1, via: 2, name: "Workspace", want: "", path: "Workspace", parts: [box(0, 50, 0, { color: [255, 0, 0] })] },
	];
}

describe("binary format", () => {
	test("round trip: the export output -> entries -> a stored map -> parts", () => {
		const bytes = writeExport(gnomeLike());
		const entries = parseExport(bytes);
		expect(entries.map((e) => [e.kind, e.via, e.name, e.want, e.path, e.parts])).toEqual([
			["map", "name", "ParkingGarage", "parking_garage", "ReplicatedStorage.assets.maps.ParkingGarage", 3],
			["map", "name", "parkinggarage", "parking_garage", "Workspace.Old.parkinggarage", 1],
			["map", "name", "Mall", "Mall", "ReplicatedStorage.assets.maps.Mall", 2],
			["lobby", "lobby", "Workspace", "", "Workspace", 1],
		]);
		const garage = entries[0] as ExportEntry;
		const blob = mapBlob(garage.records);
		expect(blob.byteLength).toBe(16 + 3 * RECORD_BYTES);
		const { parts, records } = mapRecords(blob);
		expect(parts).toBe(3);
		const second = readPart(records, 1);
		expect(second.position).toEqual([1010, 10, 1010]);
		expect(second.rotation[1]).toBeCloseTo(Math.SQRT1_2, 6);
		expect(second.size).toEqual([20, 2, 4]);
		expect(second.flags & FLAGS.mesh).toBeTruthy();
		const third = readPart(records, 2);
		expect(third.transparency).toBe(1);
		expect(third.flags & FLAGS.invisible).toBeTruthy();
		const mall = parseExport(bytes)[2] as ExportEntry;
		expect(readPart(mall.records, 0).shape).toBe("wedge");
		expect(readPart(mall.records, 1).shape).toBe("cylinder");
	});

	test("summary: counts by flag and rotated bounds", () => {
		const garage = parseExport(writeExport(gnomeLike()))[0] as ExportEntry;
		const s = summarize(garage.records);
		expect(s).toMatchObject({ parts: 3, meshes: 1, unions: 0, invisible: 1 });
		// The turned part (20 x 4 footprint, 90 degrees about Y) spans x 1008..1012, z 1000..1020.
		expect(s.bounds).toEqual({ min: [980, -0.5, 980], max: [1020, 11, 1020] });
		const h = halfExtents(Y90, [20, 2, 4]);
		expect(h[0]).toBeCloseTo(2, 5);
		expect(h[2]).toBeCloseTo(10, 5);
	});

	test("malformed output is refused, never read past the end", () => {
		const good = writeExport(gnomeLike());
		expect(() => parseExport(good.subarray(0, good.byteLength - 5))).toThrow(MapFormatError);
		expect(() => parseExport(new Uint8Array([...good, 0]))).toThrow("after the last entry");
		const bad = good.slice();
		bad[0] = 0x58;
		expect(() => parseExport(bad)).toThrow("magic");
		const v2 = good.slice();
		v2[4] = 2;
		expect(() => parseExport(v2)).toThrow("version 2");
		expect(() => mapRecords(new Uint8Array(10))).toThrow(MapFormatError);
		const blob = mapBlob(new Uint8Array(RECORD_BYTES));
		expect(() => mapRecords(blob.subarray(0, blob.byteLength - 1))).toThrow("length");
		expect(parseExport(writeExport([]))).toEqual([]);
	});
});

describe("map matching by name", () => {
	test("normalized names: case and punctuation don't matter", () => {
		expect(mapKey("Parking Garage")).toBe("parkinggarage");
		expect(mapKey("parking_garage")).toBe("parkinggarage");
		expect(mapKey("HedgeMaze")).toBe(mapKey("hedge-maze"));
		expect(mapKey("__")).toBe("");
	});

	test("one model per name: most parts wins, others are alternatives; no model -> unmatched", () => {
		const entries = parseExport(writeExport(gnomeLike()));
		const picks = pickMaps(["parking_garage", "Mall", "Port", "PARKING GARAGE", "__"], entries);
		expect(picks.maps.map((m) => [m.name, m.entry.path, m.alternatives])).toEqual([
			["parking_garage", "ReplicatedStorage.assets.maps.ParkingGarage", ["Workspace.Old.parkinggarage"]],
			["Mall", "ReplicatedStorage.assets.maps.Mall", []],
		]);
		expect(picks.unmatched).toEqual(["Port"]);
	});

	test("a manual override's model wins over the name match", () => {
		const entries = parseExport(writeExport([...gnomeLike(), { kind: 0, via: 1, name: "GarageV2", want: "parking_garage", path: "ServerStorage.GarageV2", parts: [box(5, 5, 5)] }]));
		const picks = pickMaps(["parking_garage"], entries, { "Parking Garage": { path: "ServerStorage.GarageV2" } });
		expect(picks.maps[0]?.entry.path).toBe("ServerStorage.GarageV2");
		expect(picks.maps[0]?.alternatives).toEqual(["ReplicatedStorage.assets.maps.ParkingGarage", "Workspace.Old.parkinggarage"]);
	});

	test("the script embeds names and override paths as escaped Luau strings", () => {
		expect(luauString('a"b\\c\n')).toBe('"a\\034b\\092c\\010"');
		expect(luauString("Çarşı")).toBe('"\\195\\135ar\\197\\159\\196\\177"');
		const script = exportScript({ names: ["parking_garage", "Parking Garage", "Mall]] .. os.exit()"], overrides: [{ name: "Mall", path: "ServerStorage.Maps.Mall" }] });
		expect(script).toContain('["parkinggarage"] = "parking_garage"');
		// Duplicates by key are sent once; nothing from a name reaches the script unescaped.
		expect(script.match(/\["parkinggarage"\]/g)?.length).toBe(1);
		expect(script).not.toContain("os.exit()");
		expect(script).toContain('path = { "ServerStorage", "Maps", "Mall" }');
		// Read-only: the script never saves, publishes or writes a DataStore.
		for (const word of ["SavePlace", "Publish", "SetAsync", "UpdateAsync", "RemoveAsync", ":Destroy", "HttpService:Request", "PostAsync"]) expect(script).not.toContain(word);
	});
});

describe("alignment", () => {
	const bounds = { min: [980, -1, 980] as [number, number, number], max: [1020, 30, 1020] as [number, number, number] };
	const around = (cx: number, cz: number, y = 3, count = 30) => Array.from({ length: count }, (_, i) => ({ x: cx + ((i % 5) - 2) * 3, z: cz + (Math.floor(i / 5) - 3) * 3, y }));

	test("samples inside the bounds: aligned", () => {
		const a = alignment(bounds, around(1000, 1000));
		expect(a.state).toBe("aligned");
		expect(a.inside).toBeGreaterThanOrEqual(ALIGNED_SHARE);
	});

	test("no overlap: off, with the offset that moves the geometry onto the samples", () => {
		const a = alignment(bounds, around(1300, 700, 53));
		expect(a.state).toBe("off");
		expect(a.inside).toBe(0);
		expect(a.suggestedOffset?.[0]).toBeCloseTo(300, -1);
		expect(a.suggestedOffset?.[2]).toBeCloseTo(-300, -1);
		// The floor moved to the samples' low end, minus a character's height.
		expect(a.suggestedOffset?.[1]).toBeCloseTo(51, 0);
		// With that offset applied, it is aligned.
		expect(alignment(bounds, around(1300, 700, 53), a.suggestedOffset).state).toBe("aligned");
	});

	test("weights (heat cells), partial overlap, too few samples", () => {
		expect(alignment(bounds, [{ x: 1000, z: 1000, n: 5 }, { x: 5000, z: 5000, n: 5 }]).state).toBe("partial");
		expect(alignment(bounds, [{ x: 1000, z: 1000, n: 3 }]).state).toBe("unknown");
		expect(alignment(null, around(1000, 1000)).state).toBe("unknown");
	});
});

// The export through the server -----------------------------------------------------------------------------------------

const UNIVERSE = 4_242_001;
const PLACE = 4_242_002;
const OPEN_CLOUD = "fake-open-cloud-key-for-tests-0123456789abcdef";
const TASK = `universes/${UNIVERSE}/places/${PLACE}/versions/37/luau-execution-sessions/s-1/tasks/t-1`;
const XT = { "x-typetorch": "1" };

interface FakeState {
	creates: number;
	polls: number;
	rateLimited: number;
	fail: boolean;
	latestVersion: number | "forbidden";
	scripts: string[];
	storageKeys: (string | null)[];
	output: Uint8Array;
	/** The download waits for this (an export that is still running). */
	gate?: Promise<void>;
}

function fakeRoblox(state: FakeState): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const headers = new Headers(init?.headers);
		if (url.startsWith("https://games.roblox.com/v1/games?universeIds=")) return Response.json({ data: [{ id: UNIVERSE, rootPlaceId: PLACE, name: "Map Game", playing: 1 }] });
		if (url.startsWith("https://thumbnails.roblox.com/")) return Response.json({ data: [] });
		if (url.startsWith("https://storage.test/")) {
			state.storageKeys.push(headers.get("x-api-key"));
			await state.gate;
			return new Response(state.output as Uint8Array<ArrayBuffer>);
		}
		if (url.startsWith("https://apis.roblox.com/")) {
			expect(headers.get("x-api-key")).toBe(OPEN_CLOUD);
			if (url.endsWith(`/places/${PLACE}/luau-execution-session-tasks`) && init?.method === "POST") {
				state.creates++;
				if (state.rateLimited > 0) {
					state.rateLimited--;
					return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
				}
				state.scripts.push(JSON.parse(String(init.body)).script);
				expect(JSON.parse(String(init.body)).enableBinaryOutput).toBe(true);
				return Response.json({ path: TASK, state: "QUEUED" });
			}
			if (url === `https://apis.roblox.com/cloud/v2/${TASK}`) {
				state.polls++;
				if (state.polls < 2) return Response.json({ path: TASK, state: "PROCESSING" });
				if (state.fail) return Response.json({ path: TASK, state: "FAILED", error: { code: "SCRIPT_ERROR", message: "boom at line 3" } });
				return Response.json({ path: TASK, state: "COMPLETE", output: { results: [JSON.stringify({ placeVersion: 37, truncated: false, notes: [] })] }, binaryOutputUri: "https://storage.test/out?sig=secret" });
			}
			if (url.startsWith(`https://apis.roblox.com/assets/v1/assets/${PLACE}/versions`)) {
				if (state.latestVersion === "forbidden") return new Response('{"message":"Forbidden"}', { status: 403 });
				return Response.json({ assetVersions: [{ path: `assets/${PLACE}/versions/${state.latestVersion}` }] });
			}
		}
		return new Response("not here", { status: 404 });
	}) as typeof fetch;
}

describe("the maps routes", () => {
	let h: Harness;
	let off: Harness;
	const VIEWER = 77_001;
	let web: Record<string, string>;
	const state: FakeState = { creates: 0, polls: 0, rateLimited: 1, fail: false, latestVersion: 37, scripts: [], storageKeys: [], output: writeExport(gnomeLike()) };
	const t = T0 - 3_600_000;

	beforeAll(async () => {
		h = await harness({ TYPETORCH_UNIVERSE_ID: String(UNIVERSE), OPENCLOUD_API_KEY: OPEN_CLOUD, TYPETORCH_WEB_VIEWERS: String(VIEWER) }, { fetch: fakeRoblox(state), mapExport: { sleep: async () => {}, pollMs: 1 } });
		off = await harness({}, { fetch: fakeRoblox(state) });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}`, ...XT, origin: "http://backend.test" };
		// Positioned events on the garage (where its geometry is) and on the mall 600 studs off its geometry.
		const events = [];
		for (let i = 0; i < 20; i++) {
			events.push({ v: 1, t: t + i * 1000, kind: "custom", name: "down", pid: `p${i % 4}`, sid: `p${i % 4}-s`, job: "job-1", art: "a1b2c3d-000001", dev: "desktop", src: "server", props: JSON.stringify({ map: "parking_garage", px: 1000 + (i % 5), py: 3, pz: 1000 - (i % 3) }) });
			events.push({ v: 1, t: t + i * 1000, kind: "custom", name: "down", pid: `p${i % 4}`, sid: `p${i % 4}-s`, job: "job-1", art: "a1b2c3d-000001", dev: "desktop", src: "server", props: JSON.stringify({ map: "Mall", px: 100 + i, py: 3, pz: -500 }) });
		}
		events.push({ v: 1, t, kind: "custom", name: "round", pid: "p1", sid: "p1-s", job: "job-1", art: "a1b2c3d-000001", dev: "desktop", src: "server", props: JSON.stringify({ map: "Port" }) });
		const ing = await h.call("/v1/ingest", post(API, { events }));
		expect(ing.status).toBe(202);
		const ingested = await asJson(ing);
		expect(ingested.errors ?? []).toEqual([]);
		expect(ingested.accepted).toBe(41);
		await h.app.load();
	});
	afterAll(async () => {
		await h.close();
		await off.close();
	});

	test("map-positions: the names the events carry and positioned cells per map", async () => {
		const r = await asJson(await h.call("/v1/query/map-positions", post(ADMIN, { filters: { from: new Date(t - 60_000).toISOString() }, options: { cell: 2 } })));
		expect(r.result.names).toEqual([
			{ name: "Mall", events: 20 },
			{ name: "parking_garage", events: 20 },
			{ name: "Port", events: 1 },
		]);
		const garage = r.result.cells.filter((c: { map: string }) => c.map === "parking_garage");
		expect(garage.reduce((s: number, c: { n: number }) => s + c.n, 0)).toBe(20);
		expect(garage.every((c: { x: number; event: string }) => c.x >= 1000 && c.x <= 1004 && c.event === "custom:down")).toBe(true);
		expect((await h.call("/v1/query/map-positions", post(ADMIN, { options: { cell: 3 } }))).status).toBe(400);
		expect((await h.call("/v1/query/map-positions", post(ADMIN, { options: { mapKey: "x'y" } }))).status).toBe(400);
	});

	test("before an export: an empty list; not configured -> 409", async () => {
		const empty = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		expect(empty).toMatchObject({ configured: true, canExport: true, latest: null, maps: [], export: { state: "idle" } });
		expect((await h.call(`/v1/maps/${encodeURIComponent(LOBBY)}/geometry`, { headers: bearer(ADMIN) })).status).toBe(404);
		const r = await off.call("/v1/maps/export", post(ADMIN, {}));
		expect(r.status).toBe(409);
		expect((await asJson(r)).error).toContain("OPENCLOUD_API_KEY");
		expect((await asJson(await off.call("/v1/maps", { headers: bearer(ADMIN) }))).configured).toBe(false);
	});

	test("gates: viewers read but can't export or override (403); the game key and no key read nothing", async () => {
		expect((await h.call("/v1/maps", { headers: web })).status).toBe(200);
		expect((await asJson(await h.call("/v1/maps", { headers: web }))).canExport).toBe(false);
		const refused = await h.call("/v1/maps/export", { method: "POST", body: "{}", headers: { ...web, "content-type": "application/json" } });
		expect(refused.status).toBe(403);
		expect((await h.call("/v1/maps/Mall/override", { method: "PUT", body: '{"offset":[1,2,3]}', headers: { ...web, "content-type": "application/json" } })).status).toBe(403);
		expect((await h.call("/v1/maps/Mall/override", { method: "DELETE", headers: web })).status).toBe(403);
		for (const path of ["/v1/maps", "/v1/maps/Mall/geometry"]) {
			expect((await h.call(path, { headers: bearer(API) })).status).toBe(401);
			expect((await h.call(path)).status).toBe(401);
		}
		expect((await h.call("/v1/maps/export", post(API, {}))).status).toBe(401);
		expect(state.creates).toBe(0);
	});

	test("export: 429 waits and retries, polls, downloads (no key to the storage host), stores per map; audited", async () => {
		let open = () => {};
		state.gate = new Promise<void>((done) => (open = done));
		const r = await h.call("/v1/maps/export", post(ADMIN, { names: ["HedgeMaze"] }));
		expect(r.status).toBe(202);
		const started = await asJson(r);
		expect(started.export.state).toBe("running");
		expect(started.names).toEqual(["Mall", "parking_garage", "Port", "HedgeMaze"]);
		// One at a time.
		expect((await h.call("/v1/maps/export", post(ADMIN, {}))).status).toBe(409);
		open();
		await h.app.maps.idle();
		expect(state.creates).toBe(2);
		expect(state.storageKeys).toEqual([null]);
		expect(state.scripts[0]).toContain('["hedgemaze"] = "HedgeMaze"');

		const list = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		expect(list.export).toMatchObject({ state: "done", error: null });
		expect(list.latest).toMatchObject({ placeId: PLACE, placeVersion: 37, parts: 6, unmatched: ["Port", "HedgeMaze"] });
		expect(list.placeVersion).toMatchObject({ latest: 37, source: "roblox", exported: 37, outOfDate: false });
		const byName = Object.fromEntries(list.maps.map((m: { name: string }) => [m.name, m]));
		expect(Object.keys(byName)).toEqual(["Mall", "parking_garage", LOBBY]);
		expect(byName.parking_garage).toMatchObject({ kind: "map", via: "name", path: "ReplicatedStorage.assets.maps.ParkingGarage", parts: 3, meshes: 1, invisible: 1, alternatives: ["Workspace.Old.parkinggarage"] });
		expect(byName.parking_garage.alignment.state).toBe("aligned");
		// The mall's events are 600 studs east of its geometry: off, with the offset that fixes it.
		expect(byName.Mall.alignment.state).toBe("off");
		expect(byName.Mall.alignment.suggestedOffset[0]).toBeGreaterThan(550);
		expect(byName[LOBBY]).toMatchObject({ kind: "lobby", parts: 1 });

		// The geometry: TTMP bytes with an ETag, 304 on a match; a name in any spelling.
		const g = await h.call("/v1/maps/Parking%20Garage/geometry", { headers: bearer(ADMIN) });
		expect(g.status).toBe(200);
		expect(g.headers.get("content-type")).toBe("application/octet-stream");
		const etag = g.headers.get("etag") as string;
		expect(etag).toBe(`"${byName.parking_garage.hash}"`);
		const blob = new Uint8Array(await g.arrayBuffer());
		expect(mapRecords(blob).parts).toBe(3);
		expect((await h.call("/v1/maps/parking_garage/geometry", { headers: { ...bearer(ADMIN), "if-none-match": etag } })).status).toBe(304);
		expect((await h.call("/v1/maps/Port/geometry", { headers: bearer(ADMIN) })).status).toBe(404);
		// Viewers read geometry too.
		expect((await h.call("/v1/maps/Mall/geometry", { headers: web })).status).toBe(200);

		const audit = await asJson(await h.call("/v1/admin/audit?action=maps.*", { headers: bearer(ADMIN) }));
		const actions = audit.entries.map((e: { action: string; outcome: string }) => `${e.action} ${e.outcome}`);
		expect(actions).toContain("maps.export ok");
		expect(actions).toContain("maps.export.done ok");
	});

	test("too soon after an export: 429; a newer place version shows out of date", async () => {
		const soon = await h.call("/v1/maps/export", post(ADMIN, {}));
		expect(soon.status).toBe(429);
		expect(Number(soon.headers.get("retry-after"))).toBeGreaterThan(0);
		state.latestVersion = 40;
		h.setNow(T0 + 11 * 60_000);
		const list = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		expect(list.placeVersion).toMatchObject({ latest: 40, exported: 37, outOfDate: true, source: "roblox" });
	});

	test("the version list unreadable with the key: the fleet's newest pv, with a note", async () => {
		state.latestVersion = "forbidden";
		h.setNow(T0 + 22 * 60_000);
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: "job-maps", p: PLACE, pv: 41, players: 1, tps: 60, mem: 100, up: 10 }))).status).toBe(202);
		const list = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		expect(list.placeVersion.note).toContain("isn't readable");
		expect(list.placeVersion).toMatchObject({ source: "fleet", latest: 41, exported: 37, outOfDate: true });
	});

	test("overrides: owners set a path and offset; the offset re-aligns; bad input 400; delete", async () => {
		const bad = await h.call("/v1/maps/Mall/override", { method: "PUT", body: JSON.stringify({ offset: [1, 2] }), headers: { ...bearer(ADMIN), "content-type": "application/json" } });
		expect(bad.status).toBe(400);
		expect((await h.call("/v1/maps/Mall/override", { method: "PUT", body: JSON.stringify({ path: "a..b" }), headers: { ...bearer(ADMIN), "content-type": "application/json" } })).status).toBe(400);
		expect((await h.call("/v1/maps/Mall/override", { method: "PUT", body: JSON.stringify({ nope: 1 }), headers: { ...bearer(ADMIN), "content-type": "application/json" } })).status).toBe(400);
		const before = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		const suggested = before.maps.find((m: { name: string }) => m.name === "Mall").alignment.suggestedOffset;
		const set = await h.call("/v1/maps/Mall/override", { method: "PUT", body: JSON.stringify({ offset: suggested, path: "ReplicatedStorage.assets.maps.Mall" }), headers: { ...bearer(ADMIN), "content-type": "application/json" } });
		expect(set.status).toBe(200);
		h.setNow(T0 + 40 * 60_000);
		const after = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		const mall = after.maps.find((m: { name: string }) => m.name === "Mall");
		expect(mall.offset).toEqual(suggested);
		expect(mall.alignment.state).toBe("aligned");
		expect(after.overrides.Mall).toMatchObject({ path: "ReplicatedStorage.assets.maps.Mall", by: "admin token" });
		expect((await h.call("/v1/maps/Mall/override", { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
		expect((await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }))).overrides).toEqual({});
	});

	test("a failed task: the export says why, the old maps stay", async () => {
		state.fail = true;
		state.polls = 0;
		state.latestVersion = 37;
		h.setNow(T0 + 60 * 60_000);
		expect((await h.call("/v1/maps/export", post(ADMIN, {}))).status).toBe(202);
		await h.app.maps.idle();
		const list = await asJson(await h.call("/v1/maps", { headers: bearer(ADMIN) }));
		expect(list.export.state).toBe("failed");
		expect(list.export.error).toContain("FAILED");
		expect(list.export.error).toContain("boom at line 3");
		expect(list.maps.length).toBe(3);
		const audit = await asJson(await h.call("/v1/admin/audit?action=maps.export.done", { headers: bearer(ADMIN) }));
		expect(audit.entries.map((e: { outcome: string }) => e.outcome)).toContain("failed");
	});
});
