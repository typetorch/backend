import { describe, expect, test } from "bun:test";
import { Graph, buildGraph, formatDuration } from "../src/graph.ts";
import { decodeSessions, decodeTtRec1, decodeTtRec1Chunk, detectSignals, hasDecoder, lookVector, type RecordingSample } from "../src/recording.ts";
import { RecWriter } from "./recwriter.ts";
import { blankLiterals, checkAst, checkSqlText, jsonValue } from "../src/server/sql.ts";
import { bootstrapMeans, normalCdf, percentSure, prng, twoProportion, verdict, welch } from "../src/stats.ts";

describe("stats", () => {
	test("normal CDF", () => {
		expect(normalCdf(0)).toBeCloseTo(0.5, 6);
		expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
		expect(normalCdf(-2.5758)).toBeCloseTo(0.005, 4);
	});

	test("two-proportion z-test", () => {
		// 50/100 vs 65/100: pooled 0.575, z = 2.1456, two-sided p = 0.0319.
		const r = twoProportion(50, 100, 65, 100);
		expect(r.a).toBe(0.5);
		expect(r.b).toBe(0.65);
		expect(r.pValue).toBeCloseTo(0.0319, 3);
		expect(r.sure).toBeCloseTo(0.968, 3);
		expect(twoProportion(0, 0, 1, 2).sure).toBe(0);
		expect(twoProportion(10, 10, 10, 10).sure).toBe(0);
	});

	test("Welch and bootstrap agree on a clear difference", () => {
		const random = prng(3);
		const a = Array.from({ length: 400 }, () => 10 + random() * 10);
		const b = Array.from({ length: 400 }, () => 11 + random() * 10);
		const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
		const variance = (x: number[]) => x.reduce((s, v) => s + (v - mean(x)) ** 2, 0) / (x.length - 1);
		const boot = bootstrapMeans(a, b, { seed: 5 });
		const w = welch(mean(a), variance(a), a.length, mean(b), variance(b), b.length);
		expect(boot.sure).toBeGreaterThan(0.99);
		expect(w.sure).toBeGreaterThan(0.99);
		expect(bootstrapMeans(a, b, { seed: 5 })).toEqual(boot); // repeatable
		const same = bootstrapMeans(a, a.slice().reverse());
		expect(same.sure).toBeLessThan(0.5);
	});

	test("plain words", () => {
		const strong = twoProportion(400, 1000, 460, 1000);
		expect(verdict("B", "returned", strong, 1000)).toBe(`B keeps more players: ${percentSure(strong.sure)} sure`);
		const weak = twoProportion(40, 100, 47, 100);
		expect(verdict("B", "returned", weak, 100)).toMatch(/^No clear difference yet \(\d+% sure\)$/);
		expect(verdict("B", "robux", strong, 10)).toContain("Too few players");
		expect(percentSure(0.99999)).toBe("99%");
	});
});

describe("graph", () => {
	const g = buildGraph({
		kind: "flow",
		facet: "zone",
		edges: [
			{ src: "(start)", dst: "Lobby", n: 10, players: 10, dwell_ms: 0 },
			{ src: "Lobby", dst: 'Sh"op', n: 6, players: 5, dwell_ms: 60_000 },
			{ src: "Lobby", dst: "(left)", n: 4, players: 4, dwell_ms: 8_000 },
			{ src: 'Sh"op', dst: "(left)", n: 1, players: 1, dwell_ms: 1000 },
		],
		nodes: [
			{ st: "Lobby", visits: 10, players: 10 },
			{ st: 'Sh"op', visits: 6, players: 5 },
		],
		minCount: 2,
	});

	test("build: shares, dwell, hidden edges, start/left nodes", () => {
		expect(g.edges.length).toBe(3);
		expect(g.hiddenEdges).toBe(1);
		expect(g.edges.find((e) => e.to === 'Sh"op')?.share).toBe(0.6);
		expect(g.nodes[0].id).toBe("(start)");
		expect(g.nodes.at(-1)?.id).toBe("(left)");
		expect(g.nodes.find((n) => n.id === "Lobby")?.dwellMs).toBe(68_000);
		expect(g.exits()).toEqual([{ state: "Lobby", count: 4, share: 1 }]); // the hidden Shop -> left edge is not counted
	});

	test("Mermaid: escaped labels, edge times, widths", () => {
		const m = g.toMermaid();
		expect(m).toContain("flowchart LR");
		expect(m).toContain("Sh#quot;op");
		expect(m).not.toContain('Sh"op');
		expect(m).toContain('-->|"6 · 10s"|');
		expect(m).toContain("linkStyle 0 stroke-width:6px");
		expect(m).toContain("%% 1 smaller edges not drawn");
		expect(g.toMermaid({ direction: "TD", times: false })).toContain('-->|"6"|');
	});

	test("state labels split on |", () => {
		const one = buildGraph({ kind: "player", facet: "all", pid: "p1", edges: [{ src: "(start)", dst: "zone:A|screen:", n: 1, dwell_ms: 0 }], nodes: [{ st: "zone:A|screen:", visits: 1 }] });
		expect(one.toMermaid()).toContain('["zone:A<br/>screen:<br/><small>1 visit</small>"]');
		expect(Graph.fromJSON(JSON.stringify(one)).toJSON()).toEqual(one.toJSON());
	});

	test("durations", () => {
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(125_000)).toBe("2m 05s");
		expect(formatDuration(3_780_000)).toBe("1h 03m");
	});
});

describe("recordings", () => {
	// Written by the framework's own encoder (framework/out/analytics/codec.luau under Lune) with the same calls as its
	// scripts/test-analytics.luau codec test; the checks below are that test's checks.
	const FRAMEWORK_VECTOR =
		"AQFkAAEAAJqZyEIzM6NAzcwiwgIAAAAAAAAAAJSAAHIAqgCY6AJkAAgAAAAAAAaAAHIAqgD+YQNkAB4DZwGmAKmHBDIAAXcABTIAgwAAAED/vwYKAAAAEVNob3AvQnV5L0NvaW5zMTAwBwAAAQAABwoAAgAABwoACP//AP//AXERAECcRTMzo0AAAAAAAgAAAAAAAAAAgAAAAACgAIAA";
	const near = (a: number | undefined, b: number, tolerance: number) => a !== undefined && Math.abs(a - b) <= tolerance;

	test("tt-rec-1: decodes the framework's encoder output", () => {
		expect(hasDecoder("tt-rec-1")).toBe(true);
		const chunk = decodeTtRec1Chunk(Uint8Array.from(Buffer.from(FRAMEWORK_VECTOR, "base64")));
		expect([chunk.version, chunk.last, chunk.intervalMs]).toEqual([1, true, 100]);
		const r = chunk.records;
		expect(r.map((x) => x.tag).join(",")).toBe("1,2,2,3,4,5,6,7,7,7,0,1,2");
		const s1 = r[1].values as number[];
		expect(r[1].at).toBe(0);
		expect(near(s1[0], 100.3, 0.07) && near(s1[1], 5.1, 0.07) && near(s1[2], -40.7, 0.07)).toBe(true);
		expect(near(s1[3], 0.5, 0.025) && near(s1[7], 0.6, 0.025) && near(s1[8], -0.3, 0.013)).toBe(true);
		expect(near(s1[4], 108.3, 0.1) && near(s1[5], 12.2, 0.1) && near(s1[6], -30.1, 0.1)).toBe(true);
		const s2 = r[2].values as number[];
		expect(r[2].at).toBe(100);
		expect(near(s2[3], -3.0, 0.025) && (near(s2[7], 3.1, 0.025) || near(s2[7], 3.1 - 2 * Math.PI, 0.025))).toBe(true);
		const cam = r[3].values as number[];
		expect(near(cam[0], 200, 0.07) && near(cam[1], 50, 0.07) && near(cam[2], -20, 0.07) && near(cam[4], -1.5, 0.013)).toBe(true);
		expect(r[4]).toMatchObject({ kind: 1, code: 119, processed: false, at: 250 });
		expect(r[5]).toMatchObject({ kind: 3, processed: true });
		expect(near(r[5].x, 0.25, 0.0001) && near(r[5].y, 0.75, 0.0001)).toBe(true);
		expect([r[6].text, r[7].text, r[8].text]).toEqual(["Shop/Buy/Coins100", "Shop/Buy/Coins100", "Shop/Buy/Coins100"]);
		expect([r[7].kind, r[8].kind, r[9].kind, r[9].text]).toEqual([1, 2, 8, undefined]);
		expect(r[10].at).toBe(330 + 65535);
		expect(r[11].tag).toBe(1);
		expect(near((r[12].values as number[])[0], 5000, 0.07) && r[12].at === 70330).toBe(true);
	});

	test("tt-rec-1: a session's chunks as samples and inputs at absolute times", () => {
		const a = new RecWriter();
		a.sample(0, 1, 2, 3, 0, 1, 7, 13, Math.PI / 2, 0);
		a.key(50, 1, 119);
		a.key(60, 2, 119); // key up: not an input of its own
		const b = new RecWriter();
		b.event(10, 1, "HUD/Play");
		b.event(20, 3, "Shop");
		const rec = decodeTtRec1([
			{ pid: "p", sid: "s", chunk: 0, codec: "tt-rec-1", data: a.finish(false), n: 1, t: 1000 },
			{ pid: "p", sid: "s", chunk: 2, codec: "tt-rec-1", data: b.finish(true), n: 0, t: 5000 },
		]);
		expect(rec.samples.length).toBe(1);
		expect(rec.samples[0].t).toBe(1000);
		expect(near(rec.samples[0].pos?.[2], 3, 0.07)).toBe(true);
		const look = rec.samples[0].look as number[];
		const expected = lookVector(Math.PI / 2, 0);
		expect(near(look[0], expected[0], 0.03) && near(look[2], expected[2], 0.03)).toBe(true);
		expect(rec.inputs).toEqual([
			{ t: 1050, type: "key", code: 119, processed: false },
			{ t: 5010, type: "button", target: "HUD/Play" },
			{ t: 5020, type: "screen_open", target: "Shop" },
		]);
		expect(rec.gaps).toBe(1);
	});

	test("tt-rec-1: malformed chunks", () => {
		expect(() => decodeTtRec1Chunk(Uint8Array.from([2, 0, 100, 0]))).toThrow("version");
		expect(() => decodeTtRec1Chunk(Uint8Array.from([1, 0, 100, 0, 2, 0, 0, 1]))).toThrow("past the end");
		const out = decodeSessions([
			{ pid: "p", sid: "bad", chunk: 0, codec: "tt-rec-1", data: Buffer.from([9, 9, 9, 9]).toString("base64"), n: 0 },
			{ pid: "p", sid: "other", chunk: 0, codec: "tt-rec-9" as never, data: "", n: 0 },
		]);
		expect(out.recordings).toEqual([]);
		expect(out.failed).toBe(2);
		expect(out.errors[1]).toContain("no decoder");
	});

	const T = 1_000_000;
	const still = (from: number, to: number, look = (_t: number): [number, number, number] => [0, 0, 1]): RecordingSample[] => {
		const out: RecordingSample[] = [];
		for (let t = from; t <= to; t += 100) out.push({ t, pos: [0, 3, 0], cam: [0, 8, -10], look: look(t) });
		return out;
	};

	test("idle: no input and no movement for 10 s", () => {
		const signals = detectSignals({ pid: "p", sid: "s", samples: still(T, T + 12_000), inputs: [] }, [{ t: 0, zone: "Lobby" }]);
		expect(signals).toEqual([{ kind: "idle", pid: "p", sid: "s", t: T, amount: 12_000, zone: "Lobby" }]);
		const busy = detectSignals({ pid: "p", sid: "s", samples: still(T, T + 12_000), inputs: [{ t: T + 5000, type: "key" }] });
		expect(busy.filter((s) => s.kind === "idle")).toEqual([]);
	});

	test("camera spin: 360 degrees in place", () => {
		const spin = (t: number): [number, number, number] => {
			const a = ((t - T) / 4000) * 2 * Math.PI; // a full turn every 4 s
			return [Math.sin(a), 0, Math.cos(a)];
		};
		const signals = detectSignals({ pid: "p", sid: "s", samples: still(T, T + 5000, spin), inputs: [{ t: T + 50, type: "key" }] });
		const spins = signals.filter((s) => s.kind === "camera_spin");
		expect(spins.length).toBe(1);
		expect(spins[0].amount).toBeLessThanOrEqual(6000);
	});

	test("repeated clicks on one button, broken by a screen change", () => {
		const press = (t: number, target = "Shop/Buy") => ({ t, type: "button" as const, target });
		const signals = detectSignals({
			pid: "p",
			sid: "s",
			samples: [],
			inputs: [press(T), press(T + 400), press(T + 800), press(T + 1200), { t: T + 5000, type: "screen_open", target: "Shop" }, press(T + 5100), press(T + 5200), { t: T + 5300, type: "screen_close" }, press(T + 5400)],
		});
		expect(signals).toEqual([{ kind: "repeated_clicks", pid: "p", sid: "s", t: T, amount: 4, target: "Shop/Buy" }]);
	});
});

describe("ad-hoc SQL text checks", () => {
	test("strings, quoted names and comments are blanked; positions kept", () => {
		const sql = `SELECT 'a;b' AS "x;y" -- c;\n/* d; */ FROM $$e;$$`;
		const bare = blankLiterals(sql);
		expect(bare.length).toBe(sql.length);
		expect(bare.includes(";")).toBe(false);
		expect(() => blankLiterals("SELECT 'it''s")).toThrow("unterminated");
	});

	test("one SELECT/WITH statement, no write or setup words", () => {
		expect(checkSqlText("  SELECT 1;  ")).toBe("SELECT 1");
		expect(checkSqlText("WITH a AS (SELECT 1) SELECT * FROM a")).toContain("WITH");
		expect(checkSqlText("(SELECT 1) UNION (SELECT 2)")).toContain("UNION");
		expect(checkSqlText("SELECT 'set', \"load\" FROM events")).toContain("set");
		for (const bad of ["", "VALUES (1)", "SELECT 1; SELECT 2", "SELECT 1 FROM x; ATTACH 'y'", "PRAGMA version", "SELECT * FROM t WHERE x IN (SELECT 1) AND load = 1", "WITH a AS (DELETE FROM t) SELECT 1"]) {
			expect(() => checkSqlText(bad)).toThrow();
		}
		expect(() => checkSqlText(42)).toThrow("give the query");
	});

	test("AST checks: our views and the query's own CTEs only", () => {
		const ast = (refs: object[]) => ({ error: false, statements: [{ node: { from_table: refs } }] });
		expect(() => checkAst(ast([{ type: "BASE_TABLE", table_name: "events" }]))).not.toThrow();
		expect(() => checkAst(ast([{ type: "BASE_TABLE", table_name: "C:/x.parquet" }]))).toThrow("unknown table");
		expect(() => checkAst(ast([{ type: "BASE_TABLE", schema_name: "live", table_name: "events" }]))).toThrow("unknown table");
		expect(() => checkAst(ast([{ type: "TABLE_FUNCTION", function: { function_name: "read_text" } }]))).toThrow("read_text");
		expect(() => checkAst(ast([{ type: "TABLE_FUNCTION", function: { function_name: "range" } }]))).not.toThrow();
		const withCte = { error: false, statements: [{ node: { cte_map: { map: [{ key: "a" }] }, from_table: { type: "BASE_TABLE", table_name: "A" } } }] };
		expect(() => checkAst(withCte)).not.toThrow();
		expect(() => checkAst({ error: true, error_message: "Only SELECT statements can be serialized to json!" })).toThrow("not a single SELECT");
	});

	test("JSON values", () => {
		expect(jsonValue(5n)).toBe(5);
		expect(jsonValue(2n ** 70n)).toBe((2n ** 70n).toString());
		expect(jsonValue([1n, { a: 2n }])).toEqual([1, { a: 2 }]);
		expect(jsonValue(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
		expect(jsonValue(new Uint8Array([1, 2]))).toBe("AQI=");
		expect(jsonValue(Number.NaN)).toBe("NaN");
	});
});
