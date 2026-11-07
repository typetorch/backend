/**
 * The notify-funnel, notify-optin and notify-queue queries on hand-made `notify` rows in an in-memory DuckDB: the
 * funnel per kind and day (real sends vs dry runs and tests, opens, plays >= 1 min, D1 returns, assisted returns), the
 * opt-in prompt by where and per day, the sender's hours, skips and failures; and the same answers from the Basin SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { basinOver } from "./basin-shim.ts";
import { DAY, NOW, TODAY, fixtureDb, insertRows } from "./fixtures.ts";

const H = 3_600_000;
const D0 = (TODAY - 3) * DAY;
const D1 = (TODAY - 2) * DAY;
const D2 = (TODAY - 1) * DAY;
const RANGE = { from: "2026-10-03", to: "2026-10-04" };

/** A game-server row (framework): the player's session of that day. */
const game = (pid: string, t: number, kind: EventRow["kind"], name: string, props?: object): EventRow => ({
	v: 1,
	t,
	kind,
	name,
	pid,
	sid: `${pid}-${Math.floor(t / DAY)}`,
	job: "job-1",
	art: "a1b2c3d-000001",
	dev: "desktop",
	src: "server",
	...(props ? { props: JSON.stringify(props) } : {}),
});
/** A backend row: no session, no device. */
const backend = (pid: string, t: number, name: string, props: object): EventRow => ({
	v: 1,
	t,
	kind: "notify",
	name,
	pid,
	sid: "",
	job: "backend",
	art: "backend",
	src: "backend",
	props: JSON.stringify(props),
} as EventRow);
const join = (pid: string, t: number) => game(pid, t, "session", "join");
const planned = (pid: string, t: number, nid: string, k: string, why: string) => backend(pid, t, "planned", { nid, k, for: Math.floor(t / 1000), why });
const sent = (pid: string, t: number, nid: string, k: string, extra: object = {}) => backend(pid, t, "sent", { nid, k, try: 1, roblox_id: `r-${nid}`, category: k, ...extra });

describe("notify queries", () => {
	let instance: DuckDBInstance;
	let connection: DuckDBConnection;
	let store: DuckDbStore;

	beforeAll(async () => {
		({ instance, connection } = await fixtureDb({ events: [], recordings: [] }));
		const t1 = D1 + 10 * H;
		const t2 = D2 + 11 * H;
		await insertRows(connection, "events", [
			// Before the range: never counted.
			sent("zed-0001", D0 + 10 * H, "n0", "gift_new"),
			// Day 1: wants (alice's delivered twice), plans, sends (one dry, one test).
			game("alice-01", t1 - H, "notify", "want", { k: "gift_new", key: "aaaaaaaaaaaa", until: 0 }),
			game("alice-01", t1 - H, "notify", "want", { k: "gift_new", key: "aaaaaaaaaaaa", until: 0 }),
			game("bob-0002", t1 - H, "notify", "want", { k: "gift_new", key: "bbbbbbbbbbbb" }),
			game("carol-03", t1 - H, "notify", "want", { k: "streak", key: "cccccccccccc" }),
			planned("alice-01", t1 - 10, "n1", "gift_new", "asap"),
			planned("bob-0002", t1 - 10, "n2", "gift_new", "hour"),
			planned("carol-03", t1 - 10, "n3", "streak", "until"),
			planned("dave-004", t1 - 10, "n4", "streak", "hour"),
			sent("alice-01", t1, "n1", "gift_new"),
			sent("bob-0002", t1, "n2", "gift_new"),
			sent("carol-03", t1, "n3", "streak"),
			sent("dave-004", t1, "n4", "streak", { dry: true }),
			sent("erin-005", t1, "n5", "gift_new", { test: true }),
			backend("bob-0002", t1 + 1, "skipped", { k: "gift_new", why: "capped_day" }),
			backend("carol-03", t1 + 2, "skipped", { k: "streak", why: "online" }),
			backend("dave-004", t1 + 3, "skipped", { k: "streak", why: "online" }),
			backend("alice-01", t1, "optin_inferred", { state: "subscribed" }),
			// alice opens n1 the next day (twice) and plays 5 min; carol opens n3 the same day and plays 30 s.
			join("alice-01", D2 + 9 * H),
			game("alice-01", D2 + 9 * H, "notify", "open", { nid: "n1", k: "gift_new", age: 82800, first: true }),
			game("alice-01", D2 + 9 * H + 60_000, "notify", "open", { nid: "n1", k: "gift_new", age: 82860, first: false }),
			game("alice-01", D2 + 9 * H + 300_000, "notify", "played", { nid: "n1", k: "gift_new", secs: 300 }),
			join("carol-03", t1 + 5 * H),
			game("carol-03", t1 + 5 * H, "notify", "open", { nid: "n3", k: "streak", age: 18000, first: true }),
			game("carol-03", t1 + 5 * H + 30_000, "notify", "played", { nid: "n3", k: "streak", secs: 30 }),
			// bob never opens n2 but comes back 5 h later (assisted) and the next day (D1 return).
			join("bob-0002", t1 + 5 * H),
			join("bob-0002", D2 + 20 * H),
			// Opt-in prompt.
			game("alice-01", t1 - 2 * H, "notify", "optin_check", { can: true, where: "shop" }),
			game("bob-0002", t1 - 2 * H, "notify", "optin_check", { can: false, where: "shop" }),
			game("carol-03", t1 - 2 * H, "notify", "optin_check", { can: false, where: "lobby", err: "timeout" }),
			game("alice-01", t1 - 2 * H + 1000, "notify", "optin_shown", { where: "shop" }),
			game("alice-01", t1 - 2 * H + 13_000, "notify", "optin_closed", { where: "shop", secs: 12 }),
			// Day 2: frank's send hits a 429 then goes out; gina isn't opted in.
			planned("frank-06", t2 - 10, "n6", "gift_new", "asap"),
			backend("frank-06", t2, "failed", { nid: "n6", k: "gift_new", http: 429, code: "RESOURCE_EXHAUSTED", final: false }),
			sent("frank-06", t2 + 60_000, "n6", "gift_new", { try: 2 }),
			planned("gina-007", t2 - 10, "n7", "streak", "hour"),
			backend("gina-007", t2, "failed", { nid: "n7", k: "streak", http: 400, code: "FAILED_PRECONDITION", final: true }),
			backend("gina-007", t2, "optin_inferred", { state: "not_subscribed" }),
		]);
		store = new DuckDbStore(connection, (name) => name, () => NOW);
	});
	afterAll(() => {
		connection.closeSync();
		instance.closeSync();
	});

	const counts = (o: Partial<Record<string, number>>) => ({
		wants: 0,
		planned: 0,
		sent: 0,
		dry: 0,
		tests: 0,
		players: 0,
		opened: 0,
		played: 0,
		returnedD1: 0,
		assisted: 0,
		openRate: 0,
		playedRate: 0,
		returnRate: 0,
		...o,
	});

	test("notify-funnel: per kind and day", async () => {
		const r = await store.query("notify-funnel", RANGE);
		expect(r.kind).toBeNull();
		expect(r.days).toEqual([
			{ date: "2026-10-03", kind: "gift_new", ...counts({ wants: 2, planned: 2, sent: 2, tests: 1, players: 2, opened: 1, played: 1, returnedD1: 2, assisted: 1, openRate: 0.5, playedRate: 1, returnRate: 1 }) },
			{ date: "2026-10-03", kind: "streak", ...counts({ wants: 1, planned: 2, sent: 1, dry: 1, players: 1, opened: 1, openRate: 1 }) },
			{ date: "2026-10-04", kind: "gift_new", ...counts({ planned: 1, sent: 1, players: 1 }) },
			{ date: "2026-10-04", kind: "streak", ...counts({ planned: 1 }) },
		]);
	});

	test("notify-funnel: per kind, per day and totals", async () => {
		const r = await store.query("notify-funnel", RANGE);
		expect(r.kinds).toEqual([
			{ kind: "gift_new", ...counts({ wants: 2, planned: 3, sent: 3, tests: 1, players: 3, opened: 1, played: 1, returnedD1: 2, assisted: 1, openRate: 0.3333, playedRate: 1, returnRate: 0.6667 }) },
			{ kind: "streak", ...counts({ wants: 1, planned: 3, sent: 1, dry: 1, players: 1, opened: 1, openRate: 1 }) },
		]);
		expect(r.daily.map((d) => [d.date, d.sent, d.opened])).toEqual([
			["2026-10-03", 3, 2],
			["2026-10-04", 1, 0],
		]);
		expect(r.totals).toMatchObject({ wants: 3, planned: 6, sent: 4, dry: 1, tests: 1, opened: 2, played: 1, returnedD1: 2, assisted: 1, openRate: 0.5 });
	});

	test("notify-funnel: one kind", async () => {
		const r = await store.query("notify-funnel", RANGE, { kind: "streak" });
		expect(r.kind).toBe("streak");
		expect(r.kinds.map((k) => k.kind)).toEqual(["streak"]);
		expect(r.totals).toMatchObject({ wants: 1, planned: 3, sent: 1, dry: 1, opened: 1 });
	});

	test("notify-optin: totals, by where, per day", async () => {
		const r = await store.query("notify-optin", RANGE);
		expect(r.totals).toEqual({ checks: 3, canPrompt: 1, errors: 1, shown: 1, closed: 1, shownRate: 0.3333, avgShownSecs: 12, subscribed: 1, notSubscribed: 1 });
		expect(r.byWhere).toEqual([
			{ where: "shop", checks: 2, canPrompt: 1, errors: 0, shown: 1, closed: 1, shownRate: 0.5, avgShownSecs: 12 },
			{ where: "lobby", checks: 1, canPrompt: 0, errors: 1, shown: 0, closed: 0, shownRate: 0, avgShownSecs: null },
		]);
		expect(r.days.map((d) => [d.date, d.checks, d.shown, d.subscribed, d.notSubscribed])).toEqual([
			["2026-10-03", 3, 1, 1, 0],
			["2026-10-04", 0, 0, 0, 1],
		]);
	});

	test("notify-queue: hours, plans, skips and failures", async () => {
		const r = await store.query("notify-queue", RANGE);
		expect(r.totals).toEqual({ planned: 6, sent: 5, dry: 1, failed: 2, final: 1, rateLimited: 1, skipped: 3, last429At: new Date(D2 + 11 * H).toISOString() });
		expect(r.hours).toHaveLength(48);
		expect(r.hours.find((h) => h.hour === new Date(D2 + 11 * H).toISOString())).toEqual({ hour: new Date(D2 + 11 * H).toISOString(), planned: 0, sent: 1, dry: 0, failed: 2, rateLimited: 1, skipped: 0 });
		expect(r.planned).toEqual([
			{ kind: "gift_new", why: "asap", planned: 2 },
			{ kind: "streak", why: "hour", planned: 2 },
			{ kind: "gift_new", why: "hour", planned: 1 },
			{ kind: "streak", why: "until", planned: 1 },
		]);
		expect(r.skipped).toEqual([
			{ kind: "streak", why: "online", skipped: 2 },
			{ kind: "gift_new", why: "capped_day", skipped: 1 },
		]);
		expect(r.failures).toEqual([
			{ kind: "gift_new", http: 429, code: "RESOURCE_EXHAUSTED", failures: 1, final: 0, sends: 1, lastAt: new Date(D2 + 11 * H).toISOString() },
			{ kind: "streak", http: 400, code: "FAILED_PRECONDITION", failures: 1, final: 1, sends: 1, lastAt: new Date(D2 + 11 * H).toISOString() },
		]);
		const streak = await store.query("notify-queue", RANGE, { kind: "streak" });
		expect(streak.totals).toMatchObject({ planned: 3, sent: 1, dry: 1, failed: 1, rateLimited: 0, skipped: 2, last429At: null });
	});

	test("no notify rows: empty results", async () => {
		const range = { from: "2026-09-01", to: "2026-09-02" };
		expect((await store.query("notify-funnel", range)).kinds).toEqual([]);
		expect((await store.query("notify-optin", range)).totals.checks).toBe(0);
		expect((await store.query("notify-queue", range)).totals.sent).toBe(0);
	});

	test("the Basin SQL gives the same answers", async () => {
		const basin = await basinOver(connection, NOW);
		for (const [name, options] of [
			["notify-funnel", {}],
			["notify-funnel", { kind: "gift_new" }],
			["notify-optin", {}],
			["notify-queue", {}],
			["notify-queue", { kind: "streak" }],
		] as const) {
			expect(JSON.parse(JSON.stringify(await basin.query(name, RANGE, options as never)))).toEqual(JSON.parse(JSON.stringify(await store.query(name, RANGE, options as never))));
		}
	});

	test("bad options are refused", () => {
		expect(() => store.render("notify-funnel", {}, { kind: "Gift-New" })).toThrow(/kind/);
		expect(() => store.render("notify-queue", {}, { kind: "x".repeat(25) })).toThrow(/kind/);
		expect(store.render("notify-funnel", {}, { kind: "gift_new" }).statements.sends).toContain("'gift_new'");
	});
});
