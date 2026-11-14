/**
 * The recordings explorer: the analyses on hand-built sessions (map assignment, grids, the quit autopsy, time to first
 * action), the five queries on a synthetic round-based game (test/recording-fixture.ts) in DuckDB, the decoded-session
 * cache, sampling, decoding at scale, and Basin's SQL giving the same results (run on DuckDB through shims).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
	Grid,
	NO_MAP,
	assignMap,
	classifyEnding,
	firstActionStats,
	firstActions,
	frameFor,
	mapAt,
	openScreens,
	summarizeAutopsy,
	toTrack,
	type MapSources,
	type SessionEvent,
} from "../src/recording-analysis.ts";
import { decodeSessions, registerDecoder, type DecodedRecording, type RecordingInput } from "../src/recording.ts";
import { clearRecordingCache, sampleSessions, trackCache } from "../src/queries/recordings.ts";
import { BasinStore } from "../src/store/basin.ts";
import { DuckDbStore, readRows } from "../src/store/duckdb.ts";
import { fixtureDb } from "./fixtures.ts";
import { MAP_CENTERS, RF_ART_NEW, RF_ART_OLD, RF_NOW, recordingFixture } from "./recording-fixture.ts";
import { RecWriter } from "./recwriter.ts";

// Hand-built sessions ----------------------------------------------------------------------------------------------------

const T0 = 1_000_000;

/** A session: samples (t ms after T0, x, z), inputs (t ms after T0). */
function track(samples: [number, number, number][], inputs: (Omit<RecordingInput, "t"> & { t: number })[] = [], job = "j1", pid = "p1") {
	const rec: DecodedRecording = {
		pid,
		sid: "s1",
		samples: samples.map(([t, x, z]) => ({ t: T0 + t, pos: [x, 3, z], look: [0, 0, -1] })),
		inputs: inputs.map((i) => ({ ...i, t: T0 + i.t })),
	};
	return toTrack(rec, { job, art: "a" });
}

/** Still at (x, z) from `from` to `to` ms, a sample every 100 ms. */
function still(from: number, to: number, x = 0, z = 0): [number, number, number][] {
	const out: [number, number, number][] = [];
	for (let t = from; t <= to; t += 100) out.push([t, x, z]);
	return out;
}

describe("map assignment", () => {
	const sources: MapSources = {
		byJob: new Map([
			[
				"j1",
				[
					{ t: 100, map: "Forest" },
					{ t: 500, map: "Desert" },
					{ t: 900, map: "" },
				],
			],
		]),
		byPid: new Map([["p9", [{ t: 50, map: "Swamp" }]]]),
	};
	test("the latest map event on the server before the moment", () => {
		expect(mapAt(sources.byJob.get("j1"), 99)).toBeUndefined();
		expect(assignMap(sources, "j1", "p1", 100)).toBe("Forest");
		expect(assignMap(sources, "j1", "p1", 499)).toBe("Forest");
		expect(assignMap(sources, "j1", "p1", 500)).toBe("Desert");
		// An empty map value: no map (the lobby).
		expect(assignMap(sources, "j1", "p1", 950)).toBe(NO_MAP);
	});
	test("falls back to the player's own latest, then no map", () => {
		expect(assignMap(sources, "j1", "p9", 60)).toBe("Swamp");
		expect(assignMap(sources, "other", "p9", 10_000)).toBe("Swamp");
		expect(assignMap(sources, "other", "p1", 10_000)).toBe(NO_MAP);
		expect(assignMap(sources, "j1", "p9", 10)).toBe(NO_MAP);
	});
	test("a lobby zone is no map", () => {
		expect(assignMap(sources, "j1", "p1", 600, "Lobby")).toBe(NO_MAP);
		expect(assignMap(sources, "j1", "p1", 600, "Arena")).toBe("Desert");
		expect(assignMap({ ...sources, lobbyZone: /^hub$/i }, "j1", "p1", 600, "Hub")).toBe(NO_MAP);
	});
});

describe("grid aggregation", () => {
	test("frames: cells a multiple of the base cell, aligned, at most `grid` across", () => {
		const f = frameFor({ minX: -3, maxX: 397, minZ: 10, maxZ: 50 }, 50, 4);
		expect(f.cell).toBe(8);
		expect(f.minX).toBe(-8);
		expect(f.minZ).toBe(8);
		expect(f.cols).toBeLessThanOrEqual(51);
		expect(f.maxX).toBeGreaterThanOrEqual(397);
		expect(f.maxZ).toBeGreaterThanOrEqual(50);
	});
	test("counts per cell, outside points counted apart, the largest cells kept", () => {
		const g = new Grid({ minX: 0, minZ: 0, maxX: 40, maxZ: 40, cell: 10, cols: 4, rows: 4 });
		g.add(1, 1);
		g.add(9.9, 9.9);
		g.add(15, 35, 5);
		g.add(-1, 5);
		g.add(40, 5);
		expect(g.cells()).toEqual([
			[0, 0, 2],
			[1, 3, 5],
		]);
		expect(g.total).toBe(7);
		expect(g.outside).toBe(2);
		expect(g.cells(1)).toEqual([[1, 3, 5]]);
	});
});

describe("quit autopsy classification", () => {
	const ctx = (t: ReturnType<typeof track>, events: SessionEvent[] = []) => ({ track: t, events, tutorialMax: new Map([["tutorial", 3]]) });
	const reasons = (hits: { reason: string; value?: string }[]) => hits.map((h) => (h.value ? `${h.reason}:${h.value}` : h.reason));

	test("idle: no input and no movement over the window", () => {
		expect(reasons(classifyEnding(ctx(track(still(0, 20_000)))))).toEqual(["idle"]);
	});
	test("stuck: movement keys, little movement, no screen", () => {
		const keys = [11_000, 13_000, 15_000, 17_000].map((t) => ({ t, type: "key" as const, code: 119 }));
		expect(reasons(classifyEnding(ctx(track(still(0, 20_000), keys))))).toEqual(["stuck"]);
	});
	test("walking with keys is not stuck", () => {
		const walk: [number, number, number][] = still(0, 20_000).map(([t]) => [t, t / 500, 0]);
		const keys = [11_000, 13_000, 15_000].map((t) => ({ t, type: "key" as const, code: 119 }));
		expect(reasons(classifyEnding(ctx(track(walk, keys))))).toEqual(["none"]);
	});
	test("a screen open at the end, and presses that change no screen", () => {
		const inputs = [
			{ t: 12_000, type: "screen_open" as const, target: "Shop" },
			{ t: 13_000, type: "button" as const, target: "Shop/Buy" },
			{ t: 13_100, type: "screen_open" as const, target: "Confirm" },
			{ t: 13_500, type: "screen_close" as const, target: "Confirm" },
			{ t: 15_000, type: "button" as const, target: "Shop/Buy" },
			{ t: 17_000, type: "button" as const, target: "Shop/Buy" },
		];
		const hits = reasons(classifyEnding(ctx(track(still(0, 20_000), inputs))));
		expect(hits).toContain("screen:Shop");
		expect(hits).toContain("dead_clicks");
		expect(hits).not.toContain("idle");
		expect(openScreens(inputs.map((i) => ({ ...i, t: T0 + i.t })), T0 + 13_200)).toEqual(["Shop", "Confirm"]);
	});
	test("the state's screen when the recording has no screen events", () => {
		const events: SessionEvent[] = [{ t: T0 + 5_000, kind: "state", name: "screen", state: "zone:Arena|screen:Settings" }];
		expect(reasons(classifyEnding(ctx(track(still(0, 20_000), [{ t: 19_000, type: "key", code: 119 }]), events)))).toContain("screen:Settings");
	});
	test("died: a death record or a down event shortly before the end", () => {
		const walk: [number, number, number][] = still(0, 30_000).map(([t]) => [t, t / 500, 0]);
		expect(reasons(classifyEnding(ctx(track(walk, [{ t: 15_000, type: "death" }]))))).toContain("died");
		const down: SessionEvent[] = [{ t: T0 + 25_000, kind: "custom", name: "down", props: { cause: "zombie" } }];
		expect(reasons(classifyEnding(ctx(track(walk), down)))).toContain("died");
		const early: SessionEvent[] = [{ t: T0 + 2_000, kind: "custom", name: "down" }];
		expect(reasons(classifyEnding(ctx(track(walk), early)))).not.toContain("died");
	});
	test("in a tutorial step below the furthest anyone reached", () => {
		const step = (i: number, name: string): SessionEvent => ({ t: T0 + i * 1000, kind: "funnel", name: "tutorial", props: { i, step: name } });
		expect(reasons(classifyEnding(ctx(track(still(0, 20_000)), [step(1, "spawn"), step(2, "move")])))).toContain("tutorial:tutorial step 2 (move)");
		expect(reasons(classifyEnding(ctx(track(still(0, 20_000)), [step(1, "spawn"), step(2, "move"), step(3, "done")])))).not.toContain("tutorial:tutorial step 3 (done)");
	});
	test("where they stood: a coarse cell of the map's frame", () => {
		const frame = { minX: 0, minZ: 0, maxX: 60, maxZ: 60, cell: 4, cols: 15, rows: 15 };
		const hits = classifyEnding({ ...ctx(track(still(0, 20_000, 55, 5))), map: "Forest", frame });
		expect(hits.at(-1)).toEqual({ reason: "place", value: "Forest · F1" });
	});
	test("quitters against stayers: shares and lift", () => {
		const s = (sid: string, left: boolean, ...hits: { reason: "idle" | "screen" | "none"; value?: string }[]) => ({ sid, left, hits });
		const summary = summarizeAutopsy([
			s("a", true, { reason: "idle" }),
			s("b", true, { reason: "idle" }, { reason: "screen", value: "Shop" }),
			s("c", false, { reason: "idle" }),
			s("d", false, { reason: "none" }),
			s("e", false, { reason: "screen", value: "Shop" }),
			s("f", false, { reason: "none" }),
		]);
		expect(summary.left).toBe(2);
		expect(summary.stayed).toBe(4);
		const idle = summary.rows.find((r) => r.reason === "idle");
		expect(idle).toMatchObject({ left: 2, leftShare: 1, stayed: 1, stayedShare: 0.25, lift: 4, examples: ["a", "b"] });
		expect(summary.rows.find((r) => r.reason === "screen" && r.value === "Shop")).toMatchObject({ left: 1, stayed: 1, lift: 2 });
		expect(summary.rows.find((r) => r.reason === "screen" && r.value === undefined)).toMatchObject({ left: 1, stayed: 1 });
		expect(summary.rows.find((r) => r.reason === "none")).toMatchObject({ left: 0, stayed: 2, lift: 0 });
	});
});

describe("time to first action", () => {
	test("from spawn: move, a screen the player opened, button, prompt, round", () => {
		const samples: [number, number, number][] = [
			[1_000, 0, 0],
			[2_000, 1, 0],
			[3_500, 4, 0],
		];
		const t = track(samples, [
			{ t: 900, type: "spawn" },
			{ t: 1_200, type: "screen_open", target: "HUD" }, // opened by the game: no input before it
			{ t: 4_000, type: "click", code: 0 },
			{ t: 4_500, type: "screen_open", target: "Shop" },
			{ t: 5_000, type: "button", target: "Shop/Buy" },
			{ t: 9_900, type: "prompt_used", target: "Crate" },
		]);
		const a = firstActions(t, T0 + 12_900);
		expect(a.spawn).toBe(T0 + 900);
		expect(a.seconds).toEqual({ move: 2.6, screen: 3.6, button: 4.1, prompt: 9, round: 12 });
		expect(firstActions(track([]), null)).toEqual({ spawn: null, seconds: { move: null, screen: null, button: null, prompt: null, round: null } });
	});
	test("medians, reached shares and histograms", () => {
		const row = (move: number | null) => ({ spawn: 0, seconds: { move, screen: null, button: null, prompt: null, round: null } });
		const stats = firstActionStats([row(1), row(3), row(8), row(null)]);
		const move = stats.find((s) => s.action === "move");
		expect(move).toMatchObject({ sessions: 4, reached: 3, share: 0.75, median: 3, p25: 2, p75: 5.5 });
		expect(move?.histogram.filter((h) => h.count).map((h) => [h.label, h.count])).toEqual([
			["1-2 s", 1],
			["2-5 s", 1],
			["5-10 s", 1],
		]);
		expect(stats.find((s) => s.action === "screen")).toMatchObject({ reached: 0, median: null });
	});
});

describe("decoding at scale", () => {
	test("3,000 sessions of 6 chunks (~1.1 M samples) decode, in order, in a few seconds", () => {
		const rows = [];
		for (let s = 0; s < 3_000; s++) {
			for (let c = 0; c < 6; c++) {
				const w = new RecWriter();
				for (let ms = 0; ms < 6_000; ms += 100) w.sample(ms, s + ms / 1000, 3, c, 0, s, 8, c + 10, 0, -0.2);
				w.key(50, 1, 119);
				w.event(70, 1, "HUD/Play");
				rows.push({ pid: `p${s}`, sid: `s${s}`, chunk: 5 - c, codec: "tt-rec-1" as const, data: w.finish(c === 0), n: w.samples, t: 1_000_000 + (5 - c) * 6_000 });
			}
		}
		const started = performance.now();
		const out = decodeSessions(rows);
		const ms = performance.now() - started;
		expect(out.failed).toBe(0);
		expect(out.recordings.length).toBe(3_000);
		const samples = out.recordings.reduce((n, r) => n + r.samples.length, 0);
		expect(samples).toBe(3_000 * 6 * 60);
		const first = out.recordings[0];
		expect(first.samples.every((x, i, all) => i === 0 || x.t > all[i - 1].t)).toBe(true);
		const t = toTrack(first, { job: "j", art: "a" });
		expect(t.t.length).toBe(360);
		expect(t.inputs.length).toBe(12);
		console.log(`decoded 18,000 chunks / ${samples} samples in ${Math.round(ms)} ms`);
		expect(ms).toBeLessThan(30_000);
	});
	test("a fixed sample: the same sessions every time, sorted", () => {
		const all = Array.from({ length: 100 }, (_, i) => ({ sid: `s${i}` }));
		const a = sampleSessions(all, 10);
		expect(a.length).toBe(10);
		expect(sampleSessions([...all].reverse(), 10)).toEqual(a);
		expect([...a].sort((x, y) => (x.sid < y.sid ? -1 : 1))).toEqual(a);
		expect(sampleSessions(all, 500).length).toBe(100);
	});
});

// The queries on the synthetic game ----------------------------------------------------------------------------------------

const fx = recordingFixture(40);
let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;
const left = fx.sessions.filter((s) => s.left);
const forest = fx.sessions.filter((s) => s.map === "Forest");
const forestLeft = forest.filter((s) => s.left);

beforeAll(async () => {
	({ instance, connection } = await fixtureDb(fx));
	store = new DuckDbStore(connection, (name) => name, () => RF_NOW);
	clearRecordingCache();
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

describe("recording-layers", () => {
	test("maps from the round events, frames where the maps are, the lobby apart", async () => {
		const r = await store.query("recording-layers", {}, { layers: ["path"] });
		expect(r.maps.map((m) => m.map).sort()).toEqual(["(lobby / unknown)", "Desert", "Forest"]);
		for (const m of r.maps) expect(m.sessions).toBe(m.map === NO_MAP ? 40 : fx.sessions.filter((s) => s.map === m.map).length);
		expect(r.map).not.toBe(NO_MAP);
		const center = MAP_CENTERS[r.map as string];
		expect(r.frame?.minX).toBeLessThanOrEqual(center[0]);
		expect(r.frame?.maxX).toBeGreaterThan(center[0]);
		expect((r.frame?.maxX ?? 0) - (r.frame?.minX ?? 0)).toBeLessThan(200);
		expect(r.sampling).toEqual({ recorded: 40, used: 40, sampled: false, failed: 0, capped: false, eventsCapped: false });
		// Path density: every sample on this map (after the teleport, 5 s into each session).
		const path = r.layers.find((l) => l.id === "path");
		const onMap = fx.sessions.filter((s) => s.map === r.map);
		const expected = onMap.reduce((n, s) => n + ((s.left ? [23_000, 24_000, 25_000, 22_000][s.group] : 40_000) - 5_000) / 100 + 1, 0);
		expect(path?.count).toBe(expected);
		expect(path?.cells.reduce((n, c) => n + c[2], 0)).toBe(expected);
		expect(r.background.reduce((n, c) => n + c[2], 0)).toBe(expected);
	});

	test("quits, idle spots, deaths and buttons on the map the quitters played", async () => {
		const r = await store.query("recording-layers", {}, { map: "Forest", layers: ["quit", "idle", "death", "button", "screen_open"] });
		const layer = (id: string) => r.layers.find((l) => l.id === id);
		const group = (g: number) => forest.filter((s) => s.group === g).length;
		expect(layer("quit")?.count).toBe(forestLeft.length);
		expect(layer("quit")?.sessions).toBe(forestLeft.length);
		expect(layer("idle")?.count).toBe(group(2));
		expect(layer("death")?.count).toBe(group(1));
		expect(layer("button")?.values).toEqual([
			{ value: "HUD/Play", count: forest.filter((s) => !s.left).length },
			{ value: "Shop/Buy/Coins100", count: 3 * group(0) },
		]);
		expect(layer("screen_open")?.values).toEqual([{ value: "Shop", count: group(0) }]);
		// A value filter keeps only those values (the toggles still list every value).
		const only = await store.query("recording-layers", {}, { map: "Forest", layers: ["button"], values: { button: ["Nope"] } });
		expect(only.layers[0].count).toBe(0);
		expect(only.layers[0].values.map((v) => v.value)).toEqual(["HUD/Play", "Shop/Buy/Coins100"]);
	});

	test("zone and screen filters", async () => {
		const shop = await store.query("recording-layers", {}, { map: "Forest", layers: ["path", "button"], screen: "Shop" });
		// Shop open from 17 s to the end (23 s) in the group-0 sessions.
		const shopping = forest.filter((s) => s.group === 0).length;
		expect(shop.layers.find((l) => l.id === "path")?.count).toBe(shopping * 61);
		expect(shop.layers.find((l) => l.id === "button")?.count).toBe(shopping * 3);
		const lobby = await store.query("recording-layers", {}, { map: "Forest", layers: ["path"], zone: "Lobby" });
		expect(lobby.layers[0].count).toBe(0);
	});

	test("positioned events (px/pz): by map, split and filtered by a prop, strays to the lobby", async () => {
		const r = await store.query("recording-layers", {}, { map: "Forest", layers: ["ev:custom:down", "ev:custom:buy"], split: { "ev:custom:down": "cause" } });
		expect(r.catalog).toEqual([
			{ kind: "custom", name: "down", count: 25 },
			{ kind: "custom", name: "buy", count: 8 },
		]);
		const down = r.layers.find((l) => l.id === "ev:custom:down");
		const falls = forest.filter((s) => !s.left).length;
		const zombies = forest.filter((s) => s.group === 1).length;
		expect(down?.values).toEqual([
			{ value: "fall", count: falls },
			{ value: "zombie", count: zombies },
		]);
		expect(down?.count).toBe(falls + zombies);
		// The lobby purchases: before any map on their server, or a stale map far away -> the lobby layer.
		expect(r.layers.find((l) => l.id === "ev:custom:buy")?.count).toBe(0);
		const lobby = await store.query("recording-layers", {}, { map: NO_MAP, layers: ["ev:custom:buy"] });
		expect(lobby.layers[0].count).toBe(8);
		const onlyZombies = await store.query("recording-layers", {}, { map: "Forest", layers: ["ev:custom:down"], split: { "ev:custom:down": "cause" }, values: { "ev:custom:down": ["zombie"] } });
		expect(onlyZombies.layers[0].count).toBe(zombies);
	});

	test("the filter bar: device and build", async () => {
		const phones = await store.query("recording-layers", { dev: "phone" }, { layers: ["quit"], map: "Forest" });
		expect(phones.sampling.recorded).toBe(fx.sessions.filter((s) => s.dev === "phone").length);
		expect(phones.layers[0].count).toBe(forestLeft.filter((s) => s.dev === "phone").length);
		const old = await store.query("recording-layers", { art: RF_ART_OLD }, { layers: ["quit"], map: "Forest" });
		expect(old.sampling.recorded).toBe(20);
	});

	test("bad options", () => {
		expect(() => store.render("recording-layers", {}, { layers: ["nope"] })).toThrow("unknown layer");
		expect(() => store.render("recording-layers", {}, { mapKey: "bad key'" })).toThrow();
		expect(() => store.render("recording-layers", {}, { split: { path: "cause" } })).toThrow("positioned");
	});

	test("another map key", async () => {
		const r = await store.query("recording-layers", {}, { mapKey: "arena", layers: ["path"] });
		expect(r.maps.map((m) => m.map)).toEqual([NO_MAP]);
	});
});

describe("decoded-session cache and sampling", () => {
	test("a second run decodes nothing; a replaced decoder decodes again", async () => {
		clearRecordingCache();
		await store.query("quit-autopsy");
		expect(trackCache.size).toBe(40);
		const misses = trackCache.misses;
		await store.query("quit-autopsy");
		expect(trackCache.misses).toBe(misses);
		let calls = 0;
		const restore = registerDecoder({
			codec: "tt-rec-1",
			decode(chunks) {
				calls++;
				return { pid: chunks[0].pid, sid: chunks[0].sid, samples: [], inputs: [] };
			},
		});
		try {
			const r = await store.query("first-action");
			expect(calls).toBe(40);
			expect(r.sessions).toBe(0);
		} finally {
			restore();
		}
		const again = await store.query("first-action");
		expect(again.sessions).toBe(40);
	});

	test("past maxSessions: a fixed sample, said so", async () => {
		const r = await store.query("recording-layers", {}, { maxSessions: 10, layers: ["path"] });
		expect(r.sampling).toMatchObject({ recorded: 40, used: 10, sampled: true });
		expect(r.notes[0]).toContain("Sampled 10 of 40");
		const again = await store.query("recording-layers", {}, { maxSessions: 10, layers: ["path"] });
		expect(again).toEqual(r);
	});
});

describe("recording-sessions", () => {
	test("latest first, by why, by map, by a box on the map", async () => {
		const all = await store.query("recording-sessions", {}, { limit: 5 });
		expect(all.total).toBe(40);
		expect(all.sessions.map((s) => s.sid)).toEqual(["rs00039", "rs00038", "rs00037", "rs00036", "rs00035"]);
		expect(all.sessions[0]).toMatchObject({ pid: "rp00039", why: "window", seconds: 40, maps: [NO_MAP, "Forest"] });
		const quits = await store.query("recording-sessions", {}, { why: "left", limit: 100 });
		expect(quits.sessions.map((s) => s.sid).sort()).toEqual(left.map((s) => s.sid));
		const onForest = await store.query("recording-sessions", {}, { map: "Forest", limit: 100 });
		expect(onForest.total).toBe(forest.length);
		// Where the stuck players quit: (1000 + (k % 7) * 5, 1000 + (k % 5) * 4) after the teleport.
		const stuck = forestLeft.filter((s) => s.group === 3);
		const k = stuck[0].k;
		const x = 1000 + (k % 7) * 5;
		const z = 1000 + (k % 5) * 4;
		const box = await store.query("recording-sessions", {}, { map: "Forest", box: [x - 1, z - 1, x + 1, z + 1], layer: "quit", limit: 100 });
		expect(box.sessions.map((s) => s.sid)).toContain(stuck[0].sid);
		expect(box.sessions.every((s) => s.why === "left")).toBe(true);
	});

	test("by a confusion signal (the First session page's links)", async () => {
		const idle = await store.query("recording-sessions", {}, { signal: "idle", limit: 100 });
		expect(idle.sessions.map((s) => s.sid).sort()).toEqual(left.filter((s) => s.group === 2).map((s) => s.sid));
		expect(idle.sessions[0].signals.idle).toBe(1);
		const clicks = await store.query("recording-sessions", {}, { signal: "repeated_clicks", target: "Shop/Buy/Coins100", limit: 100 });
		expect(clicks.total).toBe(5);
		expect((await store.query("recording-sessions", {}, { signal: "repeated_clicks", target: "Other" })).total).toBe(0);
		expect((await store.query("recording-sessions", {}, { signal: "idle", zone: "Arena" })).total).toBe(5);
		expect((await store.query("recording-sessions", {}, { signal: "idle", zone: "Lobby" })).total).toBe(0);
	});
});

describe("recording-replay", () => {
	test("samples, inputs, events, signals and maps at ms after the start", async () => {
		const s = left.find((x) => x.group === 0);
		if (!s) throw new Error("fixture");
		const r = await store.query("recording-replay", {}, { sid: s.sid });
		expect(r).toMatchObject({ found: true, sid: s.sid, pid: s.pid, job: s.job, art: s.art, dev: s.dev, why: "left", start: s.start, duration: 23_000, gaps: 0, chunks: 3, map: s.map });
		expect(r.samples?.length).toBe(231);
		expect(r.samples?.[0].slice(0, 5)).toEqual([0, 0, 3, 0, 0]);
		expect(r.samples?.[0][5]).toBeCloseTo(Math.sin(-0.3), 1);
		expect(r.maps).toEqual([
			{ t: 0, map: NO_MAP },
			{ t: 5_000, map: s.map },
		]);
		expect(r.inputs?.filter((i) => i.type === "button").map((i) => i.t)).toEqual([19_000, 20_000, 21_000]);
		expect(r.events?.find((e) => e.name === "screen")).toMatchObject({ t: 17_000, kind: "state", state: "zone:Arena|screen:Shop|activity:round" });
		expect(r.signals).toEqual([{ t: 19_000, kind: "repeated_clicks", amount: 3, target: "Shop/Buy/Coins100", zone: "Arena" }]);
		expect(r.frame?.minX).toBeLessThan(1000);
	});
	test("an unknown session; a bad sid", async () => {
		expect(await store.query("recording-replay", {}, { sid: "nope" })).toMatchObject({ found: false, sid: "nope" });
		expect(() => store.render("recording-replay", {}, { sid: "x' OR 1=1" })).toThrow("sid");
		expect(() => store.render("recording-replay", {}, {})).toThrow("sid");
	});
});

describe("quit-autopsy", () => {
	test("the planted endings, over-represented among quitters", async () => {
		const r = await store.query("quit-autopsy");
		expect(r).toMatchObject({ windowSeconds: 10, left: 20, stayed: 20 });
		expect(r.byWhy).toEqual([
			{ why: "left", sessions: 20 },
			{ why: "window", sessions: 20 },
		]);
		const row = (reason: string, value?: string) => r.rows.find((x) => x.reason === reason && x.value === value);
		const sids = (group: number) => left.filter((s) => s.group === group).map((s) => s.sid);
		expect(row("screen", "Shop")).toMatchObject({ left: 5, leftShare: 0.25, stayed: 0, lift: null, examples: sids(0) });
		expect(row("dead_clicks")).toMatchObject({ left: 5, stayed: 0, examples: sids(0) });
		expect(row("died")).toMatchObject({ left: 5, stayed: 0, examples: sids(1) });
		expect(row("idle")).toMatchObject({ left: 5, stayed: 0, examples: sids(2) });
		expect(row("tutorial", "tutorial step 1 (spawn)")).toMatchObject({ left: 5, stayed: 0, examples: sids(2) });
		expect(row("stuck")).toMatchObject({ left: 5, stayed: 0, examples: sids(3) });
		expect(row("none")).toMatchObject({ left: 0, stayed: 20, stayedShare: 1, lift: 0 });
		const places = r.rows.filter((x) => x.reason === "place");
		expect(places.length).toBeGreaterThan(0);
		expect(places.every((p) => p.value?.startsWith("Forest · ") || p.value?.startsWith("Desert · "))).toBe(true);
		expect(places.length).toBeLessThanOrEqual(15);
		expect(places.reduce((n, p) => n + p.left, 0)).toBeLessThanOrEqual(20);
	});
	test("a longer window", async () => {
		const r = await store.query("quit-autopsy", {}, { windowSeconds: 30 });
		expect(r.rows.find((x) => x.reason === "idle")).toBeUndefined();
	});
});

describe("first-action", () => {
	test("medians by device and by build: the new build moves sooner", async () => {
		const r = await store.query("first-action");
		expect(r.sessions).toBe(40);
		const stat = (action: string) => r.stats.find((s) => s.action === action);
		expect(stat("move")).toMatchObject({ reached: 40, median: 3.8, p25: 2.6, p75: 5 });
		expect(stat("round")).toMatchObject({ reached: 40, median: 5 });
		expect(stat("button")).toMatchObject({ reached: 25, median: 7 });
		expect(stat("prompt")).toMatchObject({ reached: 20, median: 12 });
		expect(stat("screen")).toMatchObject({ reached: 5, median: 17 });
		const build = (art: string) => r.byBuild.find((b) => b.value === art)?.stats.find((s) => s.action === "move");
		expect(build(RF_ART_NEW)).toMatchObject({ reached: 20, median: 2.6 });
		expect(build(RF_ART_OLD)).toMatchObject({ reached: 20, median: 5 });
		expect(r.byDevice.map((d) => [d.value, d.sessions])).toEqual([
			["desktop", fx.sessions.filter((s) => s.dev === "desktop").length],
			["phone", fx.sessions.filter((s) => s.dev === "phone").length],
		]);
	});
	test("other round events", async () => {
		const r = await store.query("first-action", {}, { roundEvents: ["round_result"] });
		expect(r.stats.find((s) => s.action === "round")).toMatchObject({ reached: 40, median: 85 });
	});
});

describe("Basin SQL gives the same results (run on DuckDB through shims)", () => {
	const ACCOUNT = "0123456789abcdef0123456789abcdef";
	beforeAll(async () => {
		await connection.run("CREATE SCHEMA IF NOT EXISTS typetorch");
		await connection.run("CREATE OR REPLACE VIEW typetorch.events AS SELECT * FROM main.events");
		await connection.run("CREATE OR REPLACE VIEW typetorch.recordings AS SELECT * FROM main.recordings");
		await connection.run(`CREATE OR REPLACE MACRO json_get_str(j, k) AS json_extract_string(j, '$."' || k || '"')`);
		await connection.run(`CREATE OR REPLACE MACRO json_get_float(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS DOUBLE)`);
		await connection.run(`CREATE OR REPLACE MACRO json_get_int(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS BIGINT)`);
	});
	const basin = () =>
		new BasinStore({
			accountId: ACCOUNT,
			bucket: "typetorch-analytics",
			token: "test-token-not-a-secret-123",
			clock: () => RF_NOW,
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				const query = JSON.parse(String(init?.body)).query as string;
				try {
					return new Response(JSON.stringify({ success: true, errors: [], result: { rows: await readRows(connection, query) } }), { status: 200 });
				} catch (error) {
					return new Response(JSON.stringify({ success: false, errors: [{ code: 40004, message: String(error) }] }), { status: 400 });
				}
			}) as typeof fetch,
		});
	const cases: [string, object][] = [
		["recording-layers", { layers: ["path", "quit", "idle", "button", "ev:custom:down", "ev:custom:buy"], split: { "ev:custom:down": "cause" } }],
		["recording-layers", { map: NO_MAP, layers: ["path", "ev:custom:buy"], zone: "Lobby" }],
		["recording-sessions", { why: "left", limit: 100 }],
		["recording-replay", { sid: "rs00001" }],
		["quit-autopsy", {}],
		["first-action", {}],
	];
	test.each(cases)("%s %j", async (name, options) => {
		const duck = await store.query(name as never, {}, options as never);
		const got = await basin().query(name as never, {}, options as never);
		expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(JSON.stringify(duck)));
	});
});
