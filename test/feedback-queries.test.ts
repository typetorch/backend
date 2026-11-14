/**
 * feedback-summary and feedback-list (plans/32) on hand-made rows in an in-memory DuckDB: `feedback` kind rows of two
 * scales (a scale change: faces5 -> thumbs), the older `custom/feedback` rows mapped to `legacy_faces5`, a resent
 * duplicate, a text-only row; the list's filters (pid, scale, r, hasText, q, the filters' dev), paging; and the same
 * answers from the Basin SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { basinOver } from "./basin-shim.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const H = 3_600_000;
const D1 = (TODAY - 2) * DAY;
const D2 = (TODAY - 1) * DAY;
const RANGE = { from: "2026-10-03", to: "2026-10-04" };

const row = (pid: string, t: number, kind: EventRow["kind"], name: string, props: object, dev: EventRow["dev"] = "desktop"): EventRow => ({
	v: 1,
	t,
	kind,
	name,
	pid,
	sid: `${pid}-s`,
	job: "job-1",
	art: "a1b2c3d-000001",
	dev,
	state: "zone:lobby|screen:feedback",
	src: "server",
	props: JSON.stringify(props),
});
const faces = (pid: string, t: number, r: number | null, extra: object = {}, dev?: EventRow["dev"]) =>
	row(pid, t, "feedback", "submit", { scale: "faces5", type: "scale", steps: 5, ...(r === null ? {} : { r, norm: (r - 1) / 4, label: ["BAD", "MEH", "OK", "GOOD", "GREAT"][r - 1] }), len: 0, play_s: 120, ...extra }, dev);
const thumb = (pid: string, t: number, r: 0 | 1, extra: object = {}) => row(pid, t, "feedback", "submit", { scale: "thumbs", type: "thumbs", steps: 2, r, norm: r, label: r ? "Up" : "Down", len: 0, play_s: 60, ...extra }, "phone");
const legacy = (pid: string, t: number, rating: number, text = "") => row(pid, t, "custom", "feedback", { username: "someone", rating, text, length: text.length }, "tablet");

describe("feedback queries", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		const dup = faces("alice-01", D1 + 10 * H, 5, { text: "Love the gnomes", len: 15, topic: "idea", ctx: { level: 12, map: "forest", hard: true } });
		await insertRows(connection, "events", [
			// Before the range: never counted.
			faces("zed-0001", D1 - 5 * H, 1),
			// Day 1: the faces5 scale (alice's row resent once), two legacy rows.
			dup,
			dup,
			faces("bob-0002", D1 + 11 * H, 2, { text: "too HARD to find", len: 16 }, "phone"),
			faces("carol-03", D1 + 12 * H, null, { text: "a bug in the shop", len: 17, topic: "bug" }),
			legacy("dave-004", D1 + 13 * H, 4, "nice"),
			legacy("erin-005", D1 + 14 * H, 1),
			// Day 2: the scale changed to thumbs.
			thumb("alice-01", D2 + 9 * H, 1),
			thumb("frank-06", D2 + 10 * H, 1, { text: "fun", len: 3 }),
			thumb("gina-007", D2 + 11 * H, 0, { text: "Laggy %_ servers", len: 16 }),
			// Not feedback: other names of the kinds.
			row("alice-01", D2 + 12 * H, "custom", "feedback_opened", { rating: 5 }),
			row("alice-01", D2 + 12 * H, "feedback", "other", { r: 1 }),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	test("feedback-summary: totals, one distribution per scale, thumbs share, the daily trend", async () => {
		const r = await store.query("feedback-summary", RANGE);
		expect(r).toMatchObject({ total: 8, withText: 6, players: 7, rated: 7, legacy: 2, bucket: "hour" });
		// (1 + 0.25 + 0.75 + 0 + 1 + 1 + 0) / 7
		expect(r.avgNorm).toBeCloseTo(4 / 7, 4);
		expect(r.scales.map((s) => s.scale)).toEqual(["thumbs", "legacy_faces5", "faces5"]);
		const [thumbs, old, faces5] = r.scales;
		expect(thumbs).toMatchObject({ type: "thumbs", steps: 2, legacy: false, n: 3, rated: 3, textOnly: 0, labels: { 0: "Down", 1: "Up" }, avgR: 0.667 });
		expect(thumbs?.counts).toEqual([
			{ r: 0, label: "Down", n: 1 },
			{ r: 1, label: "Up", n: 2 },
		]);
		expect(old).toMatchObject({ type: "scale", steps: 5, legacy: true, n: 2, rated: 2, avgR: 2.5, avgNorm: 0.375 });
		expect(old?.counts.map((c) => [c.r, c.label, c.n])).toEqual([
			[1, "BAD", 1],
			[2, "MEH", 0],
			[3, "OK", 0],
			[4, "GOOD", 1],
			[5, "GREAT", 0],
		]);
		expect(faces5).toMatchObject({ type: "scale", steps: 5, legacy: false, n: 3, rated: 2, textOnly: 1, avgR: 3.5, avgNorm: 0.625, labels: { 2: "MEH", 5: "GREAT" } });
		expect(faces5?.counts.map((c) => c.n)).toEqual([0, 1, 0, 0, 1]);
		expect(r.thumbs).toEqual({ up: 2, down: 1, upShare: 0.6667 });
		// Two days -> per hour: 48 buckets, the rows in theirs.
		expect(r.trend).toHaveLength(48);
		const at = (t: number) => r.trend.find((p) => p.t === t);
		expect(at(D1 + 10 * H)).toMatchObject({ n: 1, rated: 1, withText: 1, avgNorm: 1 });
		expect(at(D1 + 12 * H)).toMatchObject({ n: 1, rated: 0, withText: 1, avgNorm: null });
		expect(at(D1)).toMatchObject({ n: 0, avgNorm: null });
	});

	test("feedback-summary: a longer range trends per day", async () => {
		const r = await store.query("feedback-summary", { from: "2026-09-30", to: "2026-10-05" });
		expect(r.bucket).toBe("day");
		expect(r.trend.map((p) => [p.at, p.n])).toEqual([
			["2026-09-30", 0],
			["2026-10-01", 0],
			["2026-10-02", 1],
			["2026-10-03", 5],
			["2026-10-04", 3],
			["2026-10-05", 0],
		]);
	});

	test("feedback-list: newest first, every field, legacy rows mapped", async () => {
		const r = await store.query("feedback-list", RANGE);
		expect(r.total).toBe(8);
		expect(r.more).toBe(false);
		expect(r.rows.map((x) => x.pid)).toEqual(["gina-007", "frank-06", "alice-01", "erin-005", "dave-004", "carol-03", "bob-0002", "alice-01"]);
		expect(r.rows[7]).toEqual({
			t: D1 + 10 * H,
			at: new Date(D1 + 10 * H).toISOString(),
			pid: "alice-01",
			sid: "alice-01-s",
			dev: "desktop",
			state: "zone:lobby|screen:feedback",
			scale: "faces5",
			type: "scale",
			steps: 5,
			r: 5,
			norm: 1,
			label: "GREAT",
			text: "Love the gnomes",
			len: 15,
			topic: "idea",
			ctx: { level: 12, map: "forest", hard: true },
			play_s: 120,
			legacy: false,
		});
		// Legacy: faces from the rating, no username, no topic / ctx / play time; empty text is no text.
		expect(r.rows[4]).toMatchObject({ pid: "dave-004", scale: "legacy_faces5", type: "scale", steps: 5, r: 4, norm: 0.75, label: "GOOD", text: "nice", len: 4, topic: null, ctx: null, play_s: null, legacy: true });
		expect(r.rows[3]).toMatchObject({ pid: "erin-005", r: 1, norm: 0, label: "BAD", text: null, len: 0, legacy: true });
		expect(JSON.stringify(r)).not.toContain("someone");
		// Text-only.
		expect(r.rows[5]).toMatchObject({ pid: "carol-03", r: null, norm: null, label: null, text: "a bug in the shop", topic: "bug" });
	});

	test("feedback-list: filters (pid, scale, r, hasText, q, dev) and paging", async () => {
		const pids = async (filters: object, options: object) => (await store.query("feedback-list", { ...RANGE, ...filters }, options)).rows.map((x) => x.pid);
		expect(await pids({}, { pid: "alice-01" })).toEqual(["alice-01", "alice-01"]);
		expect(await pids({}, { scale: "legacy_faces5" })).toEqual(["erin-005", "dave-004"]);
		expect(await pids({}, { r: 1 })).toEqual(["frank-06", "alice-01", "erin-005"]);
		expect(await pids({}, { scale: "thumbs", r: 0 })).toEqual(["gina-007"]);
		expect(await pids({}, { hasText: true })).toEqual(["gina-007", "frank-06", "dave-004", "carol-03", "bob-0002", "alice-01"]);
		expect(await pids({}, { hasText: false })).toEqual(["alice-01", "erin-005"]);
		// Case-insensitive substring; LIKE wildcards and quotes are plain text.
		expect(await pids({}, { q: "hard" })).toEqual(["bob-0002"]);
		expect(await pids({}, { q: "%_" })).toEqual(["gina-007"]);
		expect(await pids({}, { q: "%" })).toEqual(["gina-007"]);
		expect(await pids({}, { q: "o'clock" })).toEqual([]);
		expect(await pids({ dev: "phone" }, {})).toEqual(["gina-007", "frank-06", "alice-01", "bob-0002"]);
		expect(await pids({ dev: "tablet" }, { hasText: true })).toEqual(["dave-004"]);
		const page = await store.query("feedback-list", RANGE, { limit: 3, offset: 3 });
		expect(page).toMatchObject({ total: 8, offset: 3, more: true });
		expect(page.rows.map((x) => x.pid)).toEqual(["erin-005", "dave-004", "carol-03"]);
		const last = await store.query("feedback-list", RANGE, { limit: 3, offset: 6 });
		expect(last.more).toBe(false);
		expect(last.rows).toHaveLength(2);
	});

	test("no feedback in the range: zeros and an empty list", async () => {
		const range = { from: "2026-09-01", to: "2026-09-02" };
		const s = await store.query("feedback-summary", range);
		expect(s).toMatchObject({ total: 0, withText: 0, players: 0, avgNorm: null, scales: [], thumbs: null });
		expect(s.trend.every((p) => p.n === 0)).toBe(true);
		expect(await store.query("feedback-list", range)).toEqual({ total: 0, offset: 0, more: false, rows: [] });
	});

	test("the Basin SQL gives the same answers", async () => {
		const basin = await basinOver(connection, NOW);
		expect(await basin.query("feedback-summary", RANGE)).toEqual(await store.query("feedback-summary", RANGE));
		for (const options of [{}, { q: "HARD" }, { hasText: true, limit: 2, offset: 1 }, { scale: "legacy_faces5", r: 4 }]) {
			expect(await basin.query("feedback-list", RANGE, options)).toEqual(await store.query("feedback-list", RANGE, options));
		}
	});

	test("bad options are refused", () => {
		expect(() => store.render("feedback-list", {}, { pid: "a'b" })).toThrow(/pid/);
		expect(() => store.render("feedback-list", {}, { scale: "x y" })).toThrow(/scale/);
		expect(() => store.render("feedback-list", {}, { r: 11 })).toThrow(/r must/);
		expect(() => store.render("feedback-list", {}, { limit: 201 })).toThrow(/limit/);
		expect(() => store.render("feedback-list", {}, { offset: 5001 })).toThrow(/offset/);
		expect(() => store.render("feedback-list", {}, { hasText: "maybe" as never })).toThrow(/hasText/);
		expect(() => store.render("feedback-list", {}, { q: "x".repeat(101) })).toThrow(/q is at most/);
		expect(() => store.render("feedback-list", {}, { q: "a\u0001b" })).toThrow(/control/);
		// A quote in the search is a literal, not SQL.
		expect(store.render("feedback-list", {}, { q: "O'Clock" }).statements.rows).toContain("'o''clock'");
	});
});
