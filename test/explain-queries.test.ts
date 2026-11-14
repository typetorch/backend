/**
 * The `explain` query: totals that match the queries behind the tiles (overview, roblox, monetization), shift-share
 * splits that add up to the change in every dimension, a hand-checked case, the `other` bucket, the drill-down and the
 * small-segment flag.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { ExplainResult } from "../src/queries/explain.ts";
import { EXPLAIN_METRICS } from "../src/queries/explain.ts";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, fixtureDb, generateFixture, type Fixture } from "./fixtures.ts";

const CURRENT = { from: NOW - 7 * DAY, to: NOW };
const BASELINE = { from: NOW - 14 * DAY, to: NOW - 7 * DAY };

/** The fixture, with every 3rd player's joins coming from a teleport (the fixture's joins all say `direct`). */
function fixture(): Fixture {
	const fx = generateFixture();
	for (const e of fx.events) {
		if (e.kind === "session" && e.name === "join" && e.pid && Number(e.pid.slice(1)) % 3 === 0) {
			e.props = JSON.stringify({ ...JSON.parse(e.props as string), from: "teleport" });
		}
	}
	return fx;
}

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;

beforeAll(async () => {
	({ instance, connection } = await fixtureDb(fixture()));
	store = new DuckDbStore(connection, (name) => name, () => NOW);
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

const run = (options: object, filters: object = CURRENT) => store.query("explain", filters as never, options as never) as Promise<ExplainResult>;

describe("explain: totals match the tiles' queries", () => {
	test("players, new players, sessions and playtime per player = overview (both windows)", async () => {
		for (const window of [CURRENT, BASELINE]) {
			const ov = await store.query("overview", window);
			const opts = window === CURRENT ? {} : { baseline: { from: NOW - 21 * DAY, to: NOW - 14 * DAY } };
			const value = async (metric: string) => (await run({ metric, dimension: "device", ...opts }, window)).current.value;
			expect(await value("players")).toBe(ov.players);
			expect(await value("newPlayers")).toBe(ov.newPlayers);
			expect(await value("returningPlayers")).toBe(ov.returningPlayers);
			expect(await value("sessions")).toBe(ov.sessions);
			expect(Math.round((await value("playtime")) * 10) / 10).toBe(ov.playtimeHours);
			expect(Math.round((await value("playtimePerPlayer")) * 10) / 10).toBe(ov.playtimePerPlayerMinutes);
			expect(Math.round((await value("avgSession")) * 10) / 10).toBe(ov.avgSessionMinutes);
		}
		// The baseline is the 7 days before.
		const r = await run({ metric: "players", dimension: "device" });
		expect(r.baseline.value).toBe((await store.query("overview", BASELINE)).players);
		expect(r.baseline.from).toBe(new Date(BASELINE.from).toISOString());
	});

	test("D1 = roblox's D1 (cohorts whose day 1 is over)", async () => {
		const r = await run({ metric: "d1", dimension: "device" });
		for (const [w, window] of [["current", CURRENT], ["baseline", BASELINE]] as const) {
			const rb = await store.query("roblox", window);
			expect(r[w].players).toBe(rb.d1Retention.of);
			expect(Math.round(r[w].value * 10_000) / 10_000).toBe(rb.d1Retention.rate);
		}
		expect(r.current.players).toBeGreaterThan(20);
	});

	test("payer conversion and Robux per player = monetization (gross; revenue = x creatorShare)", async () => {
		const m = await store.query("monetization", CURRENT);
		const conv = await run({ metric: "payerConversion", dimension: "device" });
		expect(conv.current.players).toBe(m.totals.activePlayers);
		expect(Math.round(conv.current.value * 10_000) / 10_000).toBe(m.totals.payerConversion);
		const robux = await run({ metric: "robuxPerPlayer", dimension: "device" });
		expect(robux.current.value * m.totals.activePlayers).toBeCloseTo(m.totals.robux, 0);
		const revenue = await run({ metric: "revenuePerPlayer", dimension: "device" });
		expect(revenue.current.value).toBeCloseTo(robux.current.value * 0.7, 3);
		expect(m.totals.payers).toBeGreaterThan(0);
	});

	test("DAU = player-days / days touched", async () => {
		const r = await run({ metric: "dau", dimension: "device" });
		const ov = await store.query("overview", CURRENT);
		const playerDays = ov.days.reduce((s, d) => s + d.players, 0);
		expect(r.current.value).toBeCloseTo(playerDays / 8, 3); // 12:00 to 12:00 touches 8 UTC days
	});
});

describe("explain: shift-share", () => {
	test.each(EXPLAIN_METRICS.map((m) => [m]))("%s: rate + mix of every dimension add up to the change", async (metric) => {
		const r = await run({ metric });
		expect(r.dimensions.map((d) => d.dimension)).toEqual(["device", "country", "language", "accountAge", "premium", "source", "build", "branch", "playerType"]);
		const tolerance = r.unit === "share" ? 1e-4 : 0.01;
		for (const d of r.dimensions) {
			const sum = d.segments.reduce((s, x) => s + x.rate + x.mix, 0);
			expect(Math.abs(sum - r.change)).toBeLessThan(tolerance);
			// Ranked by |contribution|, `other` last.
			const ranked = d.segments.filter((s) => !s.other).map((s) => Math.abs(s.contribution));
			expect(ranked).toEqual([...ranked].sort((a, b) => b - a));
			if (r.kind === "count") for (const s of d.segments) expect(s.mix).toBe(0);
		}
	});

	test("a hand-checked case: payer conversion by device", async () => {
		// Baseline day: 4 phones (1 payer, 25%), 6 desktops (3 payers, 50%) -> 40%.
		// Current day: 8 phones (1 payer, 12.5%), 2 desktops (1 payer, 50%) -> 20%. Change -0.2.
		// Average R = 0.3. Phone: rate (0.125 - 0.25) x (0.4 + 0.8) / 2 = -0.075; mix (0.8 - 0.4) x (0.1875 - 0.3) = -0.045.
		// Desktop: rate 0; mix (0.2 - 0.6) x (0.5 - 0.3) = -0.08. Sum -0.2. Phone 60% of the drop, desktop 40%.
		const day = Math.floor(NOW / DAY) - 3;
		const events: EventRow[] = [];
		let n = 0;
		const player = (d: number, dev: "phone" | "desktop", pays: boolean) => {
			const pid = `h${++n}`;
			const t = d * DAY + 10 * 3_600_000 + n * 60_000;
			const base = { v: 1 as const, pid, sid: `hs${n}`, job: "job-1", art: "a1", branch: "prod", dev, newp: false, src: "server" as const };
			events.push({ ...base, t, kind: "session", name: "join", props: JSON.stringify({ country: "US" }) });
			if (pays) events.push({ ...base, t: t + 1_000, kind: "purchase", name: "product", props: JSON.stringify({ product: 1, robux: 10 }) });
			events.push({ ...base, t: t + 30_000, kind: "session", name: "leave" });
		};
		for (let i = 0; i < 4; i++) player(day, "phone", i < 1);
		for (let i = 0; i < 6; i++) player(day, "desktop", i < 3);
		for (let i = 0; i < 8; i++) player(day + 1, "phone", i < 1);
		for (let i = 0; i < 2; i++) player(day + 1, "desktop", i < 1);
		const db = await fixtureDb({ events, recordings: [] });
		try {
			const s = new DuckDbStore(db.connection, (name) => name, () => NOW);
			const r = (await s.query("explain", { from: (day + 1) * DAY, to: (day + 2) * DAY }, { metric: "payerConversion", dimension: "device", minPlayers: 4 })) as ExplainResult;
			expect(r.baseline).toMatchObject({ value: 0.4, players: 10 });
			expect(r.current).toMatchObject({ value: 0.2, players: 10 });
			expect(r.change).toBeCloseTo(-0.2, 6);
			const [phone, desktop] = r.dimensions[0].segments;
			expect(phone).toMatchObject({ value: "phone", rate: -0.075, mix: -0.045, contribution: -0.12, shareOfChange: 0.6, small: false });
			expect(phone.baseline).toEqual({ players: 4, value: 0.25, share: 0.4 });
			expect(phone.current).toEqual({ players: 8, value: 0.125, share: 0.8 });
			expect(desktop).toMatchObject({ value: "desktop", rate: 0, mix: -0.08, contribution: -0.08, shareOfChange: 0.4, small: true });
			expect(phone.rate + phone.mix + desktop.rate + desktop.mix).toBeCloseTo(r.change, 9);
		} finally {
			db.connection.closeSync();
			db.instance.closeSync();
		}
	});
});

describe("explain: output shape", () => {
	test("top folds the rest into one `other` row, effects summed", async () => {
		const full = await run({ metric: "players", dimension: "build", top: 20 });
		const cut = await run({ metric: "players", dimension: "country", top: 1 });
		const country = cut.dimensions[0];
		expect(country.total).toBe(3);
		expect(country.segments).toHaveLength(2);
		expect(country.segments[1]).toMatchObject({ other: true, segments: 2 });
		expect(country.segments.reduce((s, x) => s + x.contribution, 0)).toBe(cut.change);
		expect(full.dimensions[0].segments.some((s) => s.other)).toBe(false);
	});

	test("the drill-down (within a segment) equals that segment's numbers, and leaves its own dimension out", async () => {
		const all = await run({ metric: "playtimePerPlayer", dimension: "device" });
		const phone = all.dimensions[0].segments.find((s) => s.value === "phone");
		const r = await run({ metric: "playtimePerPlayer", within: { dimension: "device", value: "phone" } });
		expect(r.within).toEqual({ dimension: "device", value: "phone" });
		expect(r.dimensions.map((d) => d.dimension)).not.toContain("device");
		expect(r.current.players).toBe(phone?.current.players as number);
		expect(r.current.value).toBeCloseTo(phone?.current.value as number, 3);
		expect(r.baseline.value).toBeCloseTo(phone?.baseline.value as number, 3);
		// The device filter gives the same population (one device per player in the fixture).
		const filtered = await run({ metric: "playtimePerPlayer", dimension: "country" }, { ...CURRENT, dev: "phone" });
		expect(filtered.current.value).toBeCloseTo(r.current.value, 3);
		// The "not sent" segment: players without a locale.
		const noLocale = await run({ metric: "players", dimension: "device", within: { dimension: "language", value: null } });
		expect(noLocale.current.players).toBeGreaterThan(0);
		expect(noLocale.current.players).toBeLessThan(all.current.players);
	});

	test("join source, language and new / returning segments read the join props and newp", async () => {
		const r = await run({ metric: "players" });
		const values = (d: string) => r.dimensions.find((x) => x.dimension === d)?.segments.map((s) => s.value).sort();
		expect(values("source")).toEqual(["direct", "teleport"]);
		expect(values("language")).toEqual(expect.arrayContaining(["en", "pt"]));
		expect(values("playerType")).toEqual(["new", "returning"]);
		expect(values("premium")).toEqual(["false", "true"]);
	});

	test("small segments are flagged by minPlayers", async () => {
		const strict = await run({ metric: "players", dimension: "country", minPlayers: 1000 });
		expect(strict.dimensions[0].segments.every((s) => s.small)).toBe(true);
		const loose = await run({ metric: "players", dimension: "country", minPlayers: 1 });
		expect(loose.dimensions[0].segments.every((s) => !s.small)).toBe(true);
	});

	test("options are checked", async () => {
		await expect(run({ metric: "nope" })).rejects.toThrow(/metric must be one of/);
		await expect(run({ dimension: "nope" })).rejects.toThrow(/dimension must be one of/);
		await expect(run({ baseline: { from: NOW - 8 * DAY, to: NOW - 2 * DAY } })).rejects.toThrow(/overlap/);
		await expect(run({ within: { dimension: "device", value: "" } })).rejects.toThrow(/within.value/);
		const custom = await run({ metric: "players", dimension: "device", baseline: { from: "2026-09-20", to: "2026-09-21" } });
		expect(custom.baseline.from).toBe("2026-09-20T00:00:00.000Z");
		expect(custom.baseline.to).toBe("2026-09-22T00:00:00.000Z");
	});
});
