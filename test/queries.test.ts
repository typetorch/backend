/**
 * The logical queries against a real DuckDB holding the fixture, checked against plain-JS reference computations.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { Graph, LEFT, START } from "../src/graph.ts";
import { registerDecoder, type DecodedRecording } from "../src/recording.ts";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { ACCESS_CODE, ART_NEW, ART_OLD, DAY, NOW, TODAY, fixtureDb, generateFixture } from "./fixtures.ts";

const fx = generateFixture();
let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;

beforeAll(async () => {
	({ instance, connection } = await fixtureDb(fx));
	store = new DuckDbStore(connection, (name) => name, () => NOW);
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

const inRange = (days: number) => fx.events.filter((e) => e.t >= NOW - days * DAY && e.t < NOW);
const playerEvents = (rows: EventRow[]) => rows.filter((e) => e.pid && e.sid);
const day = (t: number) => Math.floor(t / DAY);
const zoneOf = (state?: string) => (state ? (/(?:^|\|)zone:([^|]*)/.exec(state)?.[1] ?? "") || null : null);
const screenOf = (state?: string) => (state ? (/(?:^|\|)screen:([^|]*)/.exec(state)?.[1] ?? "") || null : null);

function sessions(rows: EventRow[]) {
	const out = new Map<string, { pid: string; t0: number; t1: number; isnew: boolean }>();
	for (const e of playerEvents(rows)) {
		const s = out.get(e.sid as string) ?? { pid: e.pid as string, t0: e.t, t1: e.t, isnew: false };
		s.t0 = Math.min(s.t0, e.t);
		s.t1 = Math.max(s.t1, e.t);
		s.isnew ||= e.newp === true;
		out.set(e.sid as string, s);
	}
	return out;
}

describe("overview", () => {
	test("totals and days match a reference computation", async () => {
		const r = await store.query("overview");
		const rows = inRange(30);
		const s = sessions(rows);
		const players = new Set(playerEvents(rows).map((e) => e.pid));
		const newPlayers = new Set(playerEvents(rows).filter((e) => e.newp).map((e) => e.pid));
		const playtime = [...s.values()].reduce((sum, x) => sum + x.t1 - x.t0, 0);
		expect(r.players).toBe(players.size);
		expect(r.newPlayers).toBe(newPlayers.size);
		expect(r.sessions).toBe(s.size);
		expect(r.events).toBe(rows.length);
		expect(r.playtimeHours).toBe(Math.round((playtime / 3_600_000) * 10) / 10);
		expect(r.days.reduce((sum, d) => sum + d.sessions, 0)).toBe(s.size);
		expect(r.days[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("filters: device, artifact, new/returning, variant", async () => {
		const all = await store.query("overview");
		const phone = await store.query("overview", { dev: "phone" });
		const ref = new Set(playerEvents(inRange(30)).filter((e) => e.dev === "phone").map((e) => e.pid));
		expect(phone.players).toBe(ref.size);
		expect(phone.players).toBeLessThan(all.players);
		const old = await store.query("overview", { art: ART_OLD });
		const neu = await store.query("overview", { art: [ART_NEW] });
		expect(old.sessions + neu.sessions).toBe(all.sessions);
		const fresh = await store.query("overview", { players: "new" });
		const back = await store.query("overview", { players: "returning" });
		expect(fresh.sessions + back.sessions).toBe(all.sessions);
		expect(fresh.sessions).toBe(fresh.newPlayers);
		const short = await store.query("overview", { variant: { experiment: "onboarding", variant: "short" } });
		const long = await store.query("overview", { variant: { experiment: "onboarding", variant: ["long"] } });
		expect(short.players + long.players).toBe(all.players);
	});

	test("date ranges: a date-only `to` includes that day", async () => {
		const date = new Date((TODAY - 3) * DAY).toISOString().slice(0, 10);
		const r = await store.query("overview", { from: date, to: date });
		expect(r.days.map((d) => d.date)).toEqual([date]);
		expect(() => store.render("overview", { from: "2026-10-05", to: "2026-10-01" })).toThrow("before");
		expect(() => store.render("overview", { from: "yesterday" })).toThrow("not a date");
	});

	test("short windows: exact instants, and the chart step follows the window (1 min, 5 min, hourly; daily beyond a day)", async () => {
		const at = async (hours: number) => store.query("overview", { from: new Date(NOW - hours * 3_600_000).toISOString() });
		for (const [hours, step] of [
			[1, 60_000],
			[6, 300_000],
			[24, 3_600_000],
		] as const) {
			const r = await at(hours);
			expect([hours, r.bucketMs]).toEqual([hours, step]);
			const s = sessions(playerEvents(fx.events.filter((e) => e.t >= NOW - hours * 3_600_000 && e.t < NOW)));
			expect(r.sessions).toBe(s.size);
			const buckets = r.buckets ?? [];
			expect(buckets.reduce((sum, b) => sum + b.sessions, 0)).toBe(s.size);
			for (const b of buckets) {
				expect(b.t % step).toBe(0);
				expect(b.time).toBe(new Date(b.t).toISOString());
			}
			// One bucket against the reference: the sessions that started in it.
			const busiest = [...buckets].sort((a, b) => b.sessions - a.sessions)[0];
			if (busiest) expect(busiest.sessions).toBe([...s.values()].filter((x) => x.t0 >= busiest.t && x.t0 < busiest.t + step).length);
		}
		expect((await at(24)).buckets?.length).toBeGreaterThan(1);
		// Longer windows keep the day series only; unix ms works as well as ISO.
		const week = await store.query("overview", { from: NOW - 7 * DAY, to: NOW });
		expect(week.bucketMs).toBe(DAY);
		expect(week.buckets).toBeUndefined();
		expect(week.days.length).toBeGreaterThan(1);
	});
});

describe("roblox numbers and retention", () => {
	function reference(k: number) {
		const rows = inRange(30);
		const cohort = new Map<string, number>();
		for (const e of playerEvents(rows).filter((e) => e.newp)) cohort.set(e.pid as string, Math.min(cohort.get(e.pid as string) ?? Infinity, day(e.t)));
		const days = new Map<string, Set<number>>();
		for (const e of fx.events) if (e.pid && e.t >= NOW - 30 * DAY) (days.get(e.pid) ?? days.set(e.pid, new Set()).get(e.pid))?.add(day(e.t));
		let of = 0;
		let kept = 0;
		for (const [pid, cday] of cohort) {
			if (cday + k >= TODAY) continue;
			of++;
			if (days.get(pid)?.has(cday + k)) kept++;
		}
		return { of, kept, cohort };
	}

	test("D1/D7, bounce, qualified plays, payers", async () => {
		const r = await store.query("roblox");
		const d1 = reference(1);
		const d7 = reference(7);
		expect(r.d1Retention).toEqual({ rate: Math.round((d1.kept / d1.of) * 10_000) / 10_000, count: d1.kept, of: d1.of });
		expect(r.d7Retention.count).toBe(d7.kept);
		expect(r.d7Retention.of).toBe(d7.of);
		const s = [...sessions(inRange(30)).values()];
		expect(r.qualifiedPlays.count).toBe(s.filter((x) => x.t1 - x.t0 >= 5 * 60_000).length);
		expect(r.firstPlayBounce.count).toBe(s.filter((x) => x.isnew && x.t1 - x.t0 < 60_000).length);
		const purchases = inRange(30).filter((e) => e.kind === "purchase");
		expect(r.purchases).toBe(purchases.length);
		expect(r.payerConversion.count).toBe(new Set(purchases.map((e) => e.pid)).size);
		const robux = purchases.reduce((sum, e) => sum + JSON.parse(e.props as string).robux, 0);
		expect(r.robuxPerUser).toBe(Math.round((robux / r.players) * 100) / 100);
		const longer = await store.query("roblox", {}, { qualifiedMinutes: 20 });
		expect(longer.qualifiedPlays.count).toBeLessThan(r.qualifiedPlays.count);
		expect(() => store.render("roblox", {}, { qualifiedMinutes: 0 })).toThrow("qualifiedMinutes");
	});

	test("retention cohorts", async () => {
		const r = await store.query("retention", {}, { days: [1, 7] });
		const ref = reference(1);
		const sizes = new Map<number, number>();
		for (const cday of ref.cohort.values()) sizes.set(cday, (sizes.get(cday) ?? 0) + 1);
		expect(r.cohorts.length).toBe(sizes.size);
		expect(r.cohorts.reduce((s, c) => s + c.size, 0)).toBe(ref.cohort.size);
		const last = r.cohorts.at(-1);
		expect(last?.kept["1"]).toBeNull(); // yesterday's cohort: today isn't over
		const keptD1 = r.cohorts.reduce((s, c) => s + (c.keptPlayers["1"] ?? 0), 0);
		expect(keptD1).toBe(ref.kept);
		expect(r.average["1"]).toBe(Math.round((ref.kept / ref.of) * 10_000) / 10_000);
	});
});

describe("funnel", () => {
	test("lists funnels without a name", async () => {
		const r = await store.query("funnel");
		expect(r.funnel).toBeNull();
		if (r.funnel === null) expect(r.funnels.map((f) => f.name)).toEqual(["onboarding"]);
	});

	test("steps: reached = players whose highest step is at least this one", async () => {
		const r = await store.query("funnel", {}, { funnel: "onboarding" });
		if (r.funnel === null) throw new Error("expected steps");
		const max = new Map<string, number>();
		for (const e of inRange(30).filter((e) => e.kind === "funnel")) max.set(e.pid as string, Math.max(max.get(e.pid as string) ?? 0, JSON.parse(e.props as string).i));
		for (const step of r.steps) expect(step.reached).toBe([...max.values()].filter((m) => m >= step.step).length);
		expect(r.steps.map((s) => s.label)).toEqual(["spawned", "moved", "opened_shop", "bought_item", "joined_round"]);
		expect(r.steps[0].ofStart).toBe(1);
		expect(r.steps[1].medianSecondsFromStart).toBe(5);
		expect(r.biggestDrop?.step).toBe(2);
	});
});

describe("funnel-progress", () => {
	test("each player's furthest step as a share of the funnel's steps", async () => {
		const max = new Map<string, number>();
		for (const e of inRange(30).filter((e) => e.kind === "funnel")) max.set(e.pid as string, Math.max(max.get(e.pid as string) ?? 0, JSON.parse(e.props as string).i));
		const pids = [...max.keys()].slice(0, 20);
		const r = await store.query("funnel-progress", {}, { pids: [...pids, "nobody-at-all"] });
		expect(r.funnels.map((f) => f.name)).toEqual(["onboarding"]);
		expect(r.funnels[0].steps.map((s) => s.label)).toEqual(["spawned", "moved", "opened_shop", "bought_item", "joined_round"]);
		expect(r.progress.map((p) => p.pid).sort()).toEqual([...pids].sort());
		for (const p of r.progress) {
			expect(p.step).toBe(max.get(p.pid) as number);
			expect(p.of).toBe(5);
			expect(p.reached).toBe(p.step);
			expect(p.share).toBe(p.step / 5);
			// When they first logged it: the earliest of their rows at that step.
			const first = Math.min(...inRange(30).filter((e) => e.kind === "funnel" && e.pid === p.pid && JSON.parse(e.props as string).i === p.step).map((e) => e.t as number));
			expect(p.reachedAt).toBe(new Date(first).toISOString());
		}
		const one = await store.query("funnel-progress", {}, { funnel: "onboarding", pids: [pids[0]] });
		expect(one.progress).toHaveLength(1);
		expect((await store.query("funnel-progress", {}, { funnel: "none_such", pids })).progress).toEqual([]);
	});

	test("needs pids", async () => {
		await expect(store.query("funnel-progress", {}, {})).rejects.toThrow(/pids/);
		await expect(store.query("funnel-progress", {}, { pids: ["bad pid!"] })).rejects.toThrow(/pid/);
	});
});

describe("player timeline and graph", () => {
	const pid = "p0003";
	const mine = fx.events.filter((e) => e.pid === pid);

	test("timeline", async () => {
		const r = await store.query("timeline", {}, { pid });
		expect(r.events.length).toBe(mine.length);
		expect(r.sessions.length).toBe(new Set(mine.map((e) => e.sid)).size);
		expect(r.sessions[0].firstSession).toBe(true);
		expect(r.events[0].kind).toBe("session");
		const limited = await store.query("timeline", {}, { pid, limit: 5 });
		expect(limited.events.length).toBe(5);
		expect(limited.truncated).toBe(true);
		expect(() => store.render("timeline", {}, { pid: "x' OR 1=1 --" })).toThrow("pid");
	});

	test("player graph edges match the session's zone moves", async () => {
		const g = await store.query("player-graph", {}, { pid, facet: "zone" });
		expect(g).toBeInstanceOf(Graph);
		const expected = new Map<string, number>();
		const bySession = new Map<string, EventRow[]>();
		for (const e of mine) (bySession.get(e.sid as string) ?? bySession.set(e.sid as string, []).get(e.sid as string))?.push(e);
		for (const rows of bySession.values()) {
			const seq: string[] = [];
			for (const e of rows.sort((a, b) => a.t - b.t)) {
				const z = zoneOf(e.state);
				if (z && seq.at(-1) !== z) seq.push(z);
			}
			const path = [START, ...seq, LEFT];
			for (let i = 1; i < path.length; i++) expected.set(`${path[i - 1]}>${path[i]}`, (expected.get(`${path[i - 1]}>${path[i]}`) ?? 0) + 1);
		}
		const got = new Map(g.edges.map((e) => [`${e.from}>${e.to}`, e.count]));
		expect(got).toEqual(expected);
		const mermaid = g.toMermaid();
		expect(mermaid.startsWith("flowchart LR\n")).toBe(true);
		expect(mermaid).toContain('(["start"])');
		expect(mermaid).toContain("linkStyle 0 stroke-width:");
	});

	test("flow graph merges players and drops small edges", async () => {
		const g = await store.query("flow", {}, { facet: "zone", minCount: 50 });
		expect(g.kind).toBe("flow");
		expect(g.edges.every((e) => e.count >= 50)).toBe(true);
		expect(g.hiddenEdges).toBeGreaterThan(0);
		const all = await store.query("flow", {}, { facet: "zone", minCount: 1 });
		const starts = all.edges.filter((e) => e.from === START).reduce((s, e) => s + e.count, 0);
		const withZone = new Set(playerEvents(inRange(7)).filter((e) => zoneOf(e.state)).map((e) => e.sid));
		expect(starts).toBe(withZone.size);
		const full = await store.query("flow", {}, { facet: "all", maxEdges: 10 });
		expect(full.edges.length).toBe(10);
		expect(full.edges[0].from.includes("zone:") || full.edges[0].from === START).toBe(true);
		const json = JSON.parse(JSON.stringify(full));
		expect(Graph.fromJSON(json).toMermaid()).toBe(full.toMermaid());
	});

	/** The node of an event as the graph query sees it (zone facet; with moments, key moments are "@..." nodes). */
	const nodeOf = (e: EventRow, moments: boolean): string | null => {
		const props = e.props ? (JSON.parse(e.props) as Record<string, unknown>) : {};
		if (moments && e.kind === "funnel") return `@${e.name}: ${String(props.step ?? props.i)}`;
		if (moments && e.kind === "purchase") return `@purchase: ${String(props.product ?? e.name)}`;
		if (moments && ["personal_best", "round_end"].includes(e.name)) return `@${e.name}`;
		return zoneOf(e.state);
	};
	const visitsOf = (rows: EventRow[], moments: boolean) => {
		const seq: string[] = [];
		for (const e of [...rows].sort((a, b) => a.t - b.t)) {
			const n = nodeOf(e, moments);
			if (n && seq.at(-1) !== n) seq.push(n);
		}
		return seq;
	};

	test("one session (sid): only its moves, and the path in order with the time in each state", async () => {
		const sid = mine[0].sid as string;
		const rows = mine.filter((e) => e.sid === sid);
		const g = await store.query("player-graph", {}, { pid, sid, facet: "zone" });
		expect(g.sid).toBe(sid);
		const seq = visitsOf(rows, false);
		expect(g.path?.map((p) => p.state)).toEqual(seq);
		expect(g.path?.map((p) => p.step)).toEqual(seq.map((_, i) => i + 1));
		expect(g.ended).toBe(true);
		const moves = seq.length + 1; // (start) -> first, each next, last -> (left)
		expect(g.edges.reduce((s, e) => s + e.count, 0)).toBe(moves);
		// Time per state = the path's time in it; all of it adds up to the session (first zone event to last event).
		const total = (g.path ?? []).reduce((s, p) => s + p.ms, 0);
		const first = rows.filter((e) => zoneOf(e.state)).reduce((m, e) => Math.min(m, e.t), Infinity);
		expect(total).toBe(Math.max(...rows.map((e) => e.t)) - first);
		expect(g.nodes.filter((n) => !n.id.startsWith("(")).reduce((s, n) => s + n.dwellMs, 0)).toBe(total);
		const all = await store.query("player-graph", {}, { pid, facet: "zone" });
		expect(all.path).toBeUndefined();
		expect(all.edges.reduce((s, e) => s + e.count, 0)).toBeGreaterThan(moves);
		expect(() => store.render("player-graph", {}, { pid, sid: "x' --" })).toThrow("sid");
	});

	test("nodes say what happened there: top events and funnel steps", async () => {
		const g = await store.query("flow", {}, { facet: "zone", minCount: 1 });
		const rows = playerEvents(inRange(7));
		const shop = g.nodes.find((n) => n.id === "Shop");
		const bought = rows.filter((e) => e.kind === "purchase" && zoneOf(e.state) === "Shop").length;
		expect(bought).toBeGreaterThan(0);
		expect(shop?.events).toEqual([{ kind: "purchase", name: "product", count: bought }]);
		const lobby = g.nodes.find((n) => n.id === "Lobby");
		const funnelRows = rows.filter((e) => e.kind === "funnel" && zoneOf(e.state) === "Lobby");
		const spawned = funnelRows.filter((e) => JSON.parse(e.props as string).step === "spawned");
		expect(lobby?.steps?.[0]).toEqual({ funnel: "onboarding", step: "spawned", index: 1, count: spawned.length, players: new Set(spawned.map((e) => e.pid)).size });
		expect(lobby?.steps?.map((s) => s.index)).toEqual([...(lobby?.steps ?? [])].map((s) => s.index).sort((a, b) => (a ?? 0) - (b ?? 0)));
		expect(g.nodes.every((n) => n.id.startsWith("(") || (n.events?.length ?? 0) <= 5)).toBe(true);
		const plain = await store.query("flow", {}, { facet: "zone", details: false });
		expect(plain.nodes.some((n) => n.events !== undefined)).toBe(false);
	});

	test("moments: funnel steps and purchases become small nodes on the path", async () => {
		const payer = [...new Set(fx.events.filter((e) => e.kind === "purchase" && e.pid).map((e) => e.pid as string))][0];
		const rows = fx.events.filter((e) => e.pid === payer && e.sid);
		const sid = rows.find((e) => e.kind === "funnel")?.sid as string;
		const g = await store.query("player-graph", {}, { pid: payer, sid, facet: "zone", moments: true });
		const seq = visitsOf(rows.filter((e) => e.sid === sid), true);
		expect(g.moments).toBe(true);
		expect(g.path?.map((p) => p.state)).toEqual(seq);
		expect(seq.some((s) => s.startsWith("@onboarding: "))).toBe(true);
		expect(g.nodes.some((n) => n.id === "@onboarding: spawned")).toBe(true);
		expect(g.toMermaid()).toContain('(["onboarding: spawned"])');
	});
});

describe("experiments", () => {
	test("lists experiments", async () => {
		const r = await store.query("experiment");
		expect(r.experiment).toBeNull();
		if (r.experiment === null) expect(r.experiments.map((e) => e.variant).sort()).toEqual(["long", "short"]);
	});

	test("per-variant numbers and plain words", async () => {
		const r = await store.query("experiment", {}, { experiment: "onboarding", control: "short" });
		if (r.experiment === null) throw new Error("expected results");
		expect(r.control).toBe("short");
		const days = new Map<string, Set<number>>();
		for (const e of playerEvents(inRange(30))) (days.get(e.pid as string) ?? days.set(e.pid as string, new Set()).get(e.pid as string))?.add(day(e.t));
		const variantOf = (pid: string) => (Number(pid.slice(1)) % 2 === 0 ? "short" : "long");
		for (const v of r.variants) {
			const pids = [...days.keys()].filter((p) => variantOf(p) === v.variant);
			expect(v.players).toBe(pids.length);
			expect(v.returned.count).toBe(pids.filter((p) => (days.get(p)?.size ?? 0) >= 2).length);
		}
		const kept = r.comparisons.find((c) => c.variant === "long" && c.metric === "returned");
		expect(kept?.method).toBe("two-proportion z-test");
		expect(kept?.sure).toBeGreaterThan(0.95);
		expect(kept?.words).toMatch(/^long keeps more players: 9\d% sure$/);
		const playtime = r.comparisons.find((c) => c.metric === "playtime");
		expect(playtime?.method).toBe("bootstrap");
		const welch = await store.query("experiment", {}, { experiment: "onboarding", maxValues: 0 });
		if (welch.experiment === null) throw new Error("expected results");
		expect(welch.comparisons.find((c) => c.metric === "playtime")?.method).toBe("welch (normal approx.)");
		expect(r.mixedPlayers).toBe(0);
	});
});

test("experiments per server: pinned artifacts vs unpinned servers", async () => {
	const r = await store.query("experiment", {}, { scope: "server" });
	if (r.experiment === null) throw new Error("expected results");
	expect(r.control).toBe("(unpinned)");
	expect(r.variants.map((v) => v.variant)).toEqual(["(unpinned)", "pin-art-1"]);
	expect(r.variants.find((v) => v.variant === "pin-art-1")?.players).toBe(60);
	expect(r.comparisons.every((c) => c.variant === "pin-art-1")).toBe(true);
	const one = await store.query("experiment", {}, { scope: "server", experiment: "pin-art-1" });
	if (one.experiment === null) throw new Error("expected results");
	expect(one.variants.length).toBe(2);
});

describe("first-session confusion", () => {
	test("signals from events", async () => {
		const r = await store.query("confusion");
		const firsts = playerEvents(inRange(14)).filter((e) => e.newp);
		expect(r.firstSessions).toBe(new Set(firsts.map((e) => e.sid)).size);
		// Screen loops: sessions that opened Shop 3+ times.
		const opens = new Map<string, number>();
		const last = new Map<string, string | null>();
		for (const e of firsts.filter((e) => e.state).sort((a, b) => a.t - b.t)) {
			const scr = screenOf(e.state);
			if (scr && last.get(e.sid as string) !== scr) opens.set(e.sid as string, (opens.get(e.sid as string) ?? 0) + 1);
			last.set(e.sid as string, scr);
		}
		const shop = r.screenLoops.find((s) => s.screen === "Shop");
		expect(shop?.loopSessions).toBe([...opens.values()].filter((n) => n >= 3).length);
		expect(shop?.loopSessions).toBeGreaterThan(0);
		// Early leaves: the bounced first sessions (all in the Lobby).
		const lobby = r.earlyLeave.find((z) => z.zone === "Lobby");
		const bounced = [...sessions(firsts).values()].filter((s) => s.t1 - s.t0 < 120_000).length;
		expect(lobby?.early).toBe(bounced);
		expect(r.backAndForth[0].flagged).toBeGreaterThan(0);
	});

	test("signals from tt-rec-1 recordings: idle in the Lobby, repeated clicks on one button", async () => {
		const r = await store.query("confusion");
		const firstSids = new Set(playerEvents(inRange(14)).filter((e) => e.newp).map((e) => e.sid));
		const recorded = new Set(fx.recordings.filter((x) => x.t >= NOW - 14 * DAY && firstSids.has(x.sid)).map((x) => x.sid));
		expect(recorded.size).toBeGreaterThan(0);
		expect(r.recordings).toMatchObject({ available: true, sessions: recorded.size, failedSessions: 0 });
		expect(r.recordings.repeatedClicks).toEqual([{ button: "Shop/Buy/Coins100", count: recorded.size, avgPresses: 3 }]);
		expect(r.recordings.idle).toEqual([{ zone: "Lobby", count: recorded.size, avgSeconds: 12 }]);
		expect(r.recordings.cameraSpin).toEqual([]);
	});

	test("a malformed chunk is counted, not fatal", async () => {
		const restore = registerDecoder({
			codec: "tt-rec-1",
			decode(): DecodedRecording {
				throw new Error("bad chunk");
			},
		});
		try {
			const r = await store.query("confusion");
			expect(r.recordings.available).toBe(true);
			expect(r.recordings.sessions).toBe(0);
			expect(r.recordings.failedSessions).toBeGreaterThan(0);
		} finally {
			restore();
		}
	});
});

describe("fleet (game servers)", () => {
	test("servers: latest heartbeat per JobId, never the access code", async () => {
		const r = await store.query("servers");
		expect(r.servers.map((s) => s.job).sort()).toEqual(["job-1", "job-2", "job-4"]);
		expect(r.players).toBe(30);
		expect(r.byHealth).toEqual({ ok: 2, degraded: 1 });
		expect(r.servers.find((s) => s.job === "job-4")?.lastError).toBe("swap failed: boom");
		expect(JSON.stringify(r)).not.toContain(ACCESS_CODE);
		const wide = await store.query("servers", {}, { maxAgeSeconds: 3600 });
		expect(wide.servers.length).toBe(4);
		expect((await store.query("servers", {}, { branch: "dev" })).servers).toEqual([]);
		for (const sql of Object.values(store.render("servers").statements)) expect(sql).not.toMatch(/'k'|\$\."k"/);
	});

	test("deployReport: results, errors, servers still behind", async () => {
		const latest = await store.query("deployReport");
		expect(latest.seq).toBe(42);
		expect(latest.results).toEqual([
			{ result: "swapped", servers: 2, players: 20, medianSeconds: 1.8, maxSeconds: 2.4 },
			{ result: "failed", servers: 1, players: 10, medianSeconds: 0.4, maxSeconds: 0.4 },
		]);
		expect(latest.errors).toEqual([{ error: "swap failed: boom", servers: 1, exampleJob: "job-4" }]);
		expect(latest.behind.map((s) => s.job)).toEqual(["job-4"]);
		const old = await store.query("deployReport", {}, { seq: 41 });
		expect(old.results).toEqual([{ result: "swapped", servers: 3, players: 30, medianSeconds: 1.5, maxSeconds: 1.5 }]);
		expect(old.behind).toEqual([]);
		expect((await store.query("deployReport", {}, { artifact: ART_OLD })).seq).toBe(41);
		const none = await store.query("deployReport", {}, { seq: 43 });
		expect(none.reported).toBe(0);
		expect(none.behind.map((s) => s.job).sort()).toEqual(["job-1", "job-2", "job-4"]);
		expect(() => store.render("deployReport", {}, { seq: 1, latest: true })).toThrow("one of");
		expect(JSON.stringify(latest)).not.toContain(ACCESS_CODE);
	});
});

test("top-events", async () => {
	const r = await store.query("top-events", {}, { limit: 3 });
	expect(r.events.length).toBe(3);
	expect(r.events[0]).toMatchObject({ kind: "zone", name: "enter" });
	expect(r.events[0].count).toBe(inRange(7).filter((e) => e.kind === "zone" && e.name === "enter").length);
});

describe("explorer lookups", () => {
	test("players: most recent first, sessions and events match; search by part of a pid", async () => {
		const r = await store.query("players", {}, { limit: 1000 });
		const rows = playerEvents(inRange(30));
		const pids = new Set(rows.map((e) => e.pid));
		expect(r.players.length).toBe(pids.size);
		for (let i = 1; i < r.players.length; i++) expect(r.players[i - 1].lastSeen >= r.players[i].lastSeen).toBe(true);
		const p = r.players.find((x) => x.pid === "p0003");
		const mine = rows.filter((e) => e.pid === "p0003");
		if (p) {
			expect(p.events).toBe(mine.length);
			expect(p.sessions).toBe(new Set(mine.map((e) => e.sid)).size);
		}
		const found = await store.query("players", {}, { search: "p000", limit: 1000 });
		expect(found.players.map((x) => x.pid).every((pid) => pid.includes("p000"))).toBe(true);
		expect(found.players.length).toBe([...pids].filter((pid) => (pid as string).includes("p000")).length);
		expect((await store.query("players", {}, { limit: 3 })).players.length).toBe(3);
		expect(() => store.render("players", {}, { search: "x' OR 1=1 --" })).toThrow("search");
	});

	test("values: branches, artifacts (newest first), channels and devices", async () => {
		const r = await store.query("values");
		expect(r.branch.map((v) => v.value)).toEqual(["prod"]);
		expect(r.art.map((v) => v.value)).toEqual([ART_NEW, ART_OLD]);
		expect(r.dev.map((v) => v.value).sort()).toEqual(["console", "desktop", "phone", "tablet"]);
		const rows = inRange(30);
		expect(r.dev.reduce((sum, v) => sum + v.events, 0)).toBe(rows.filter((e) => e.dev).length);
		expect(r.dev[0].value).toBe("phone");
	});

	test("events: newest first, by kind/name/pid; fleet rows never carry props", async () => {
		const r = await store.query("events", {}, { kind: "zone", name: "enter", limit: 20 });
		expect(r.events.length).toBe(20);
		expect(r.events.every((e) => e.kind === "zone" && e.name === "enter")).toBe(true);
		for (let i = 1; i < r.events.length; i++) expect(r.events[i - 1].t >= r.events[i].t).toBe(true);
		const mine = await store.query("events", {}, { pid: "p0003", limit: 1000 });
		expect(mine.events.length).toBe(inRange(7).filter((e) => e.pid === "p0003").length);
		const fleet = await store.query("events", {}, { kind: "fleet", limit: 1000 });
		expect(fleet.events.length).toBeGreaterThan(0);
		expect(fleet.events.every((e) => e.props === null)).toBe(true);
		expect(JSON.stringify(fleet)).not.toContain(ACCESS_CODE);
		expect(() => store.render("events", {}, { name: "a'b" })).toThrow("name");
	});
});

describe("player stats (the Players page's player detail)", () => {
	const range = (from: number, to: number) => fx.events.filter((e) => e.t >= from && e.t < to);
	const payer = [...new Set(inRange(30).filter((e) => e.kind === "purchase").map((e) => e.pid as string))].sort()[0];
	const median = (values: number[]) => {
		const v = [...values].sort((a, b) => a - b);
		const mid = Math.floor(v.length / 2);
		return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
	};

	test("totals, sessions and purchases match a reference computation; the daily series is dense and adds up", async () => {
		expect(payer).toBeDefined();
		const r = await store.query("player-stats", {}, { pid: payer });
		const rows = range(NOW - 30 * DAY, NOW).filter((e) => e.pid === payer);
		const s = [...sessions(rows).values()];
		const lengths = s.map((x) => x.t1 - x.t0);
		const buys = rows.filter((e) => e.kind === "purchase");
		const robux = buys.reduce((sum, e) => sum + (JSON.parse(e.props as string) as { robux: number }).robux, 0);
		expect(r.pid).toBe(payer);
		expect(r.window).toMatchObject({ bucket: "day", clamped: false, days: 31 });
		expect(r.totals.sessions).toBe(s.length);
		expect(r.totals.events).toBe(rows.length);
		expect(r.totals.playtimeMinutes).toBe(Math.round((lengths.reduce((a, b) => a + b, 0) / 60_000) * 10) / 10);
		expect(r.totals.medianSessionMinutes).toBe(Math.round((median(lengths) / 60_000) * 10) / 10);
		expect(r.totals.purchases).toBe(buys.length);
		expect(r.totals.robux).toBe(robux);
		expect(r.totals.activeDays).toBe(new Set(s.map((x) => day(x.t0))).size);
		expect(r.totals.firstSeen).toBe(new Date(Math.min(...s.map((x) => x.t0))).toISOString());
		// Dense: one bucket per UTC day the window touches, oldest first; the buckets add up to the totals.
		expect(r.series.length).toBe(31);
		expect(r.series[0].start).toBe(new Date(day(NOW - 30 * DAY) * DAY).toISOString());
		expect(r.series.reduce((a, b) => a + b.sessions, 0)).toBe(s.length);
		expect(r.series.reduce((a, b) => a + b.purchases, 0)).toBe(buys.length);
		expect(r.series.reduce((a, b) => a + b.robux, 0)).toBe(robux);
		// Lists: newest first, with the purchase's product, price and place.
		expect(r.sessions.length).toBe(s.length);
		expect(Date.parse(r.sessions[0].start)).toBe(Math.max(...s.map((x) => x.t0)));
		expect(r.purchases.length).toBe(buys.length);
		expect(r.purchases[0]).toMatchObject({ kind: "product", where: "shop" });
		expect(["1234", "555"]).toContain(r.purchases[0].product ?? "");
		expect([99, 199]).toContain(r.purchases[0].robux ?? 0);
		expect(r.sessionsTruncated || r.purchasesTruncated).toBe(false);
	});

	test("the step follows the window: per hour up to a day, 5 minutes up to 6 hours, a minute up to an hour (the hour presets)", async () => {
		const from = TODAY * DAY;
		const r = await store.query("player-stats", { from, to: NOW }, { pid: payer });
		expect(r.window).toMatchObject({ bucket: "hour", bucketMs: 3_600_000, days: 1 });
		expect(r.series.length).toBe(12);
		expect(r.series[1].start).toBe(new Date(from + 3_600_000).toISOString());
		const s = sessions(range(from, NOW).filter((e) => e.pid === payer));
		expect(r.series.reduce((a, b) => a + b.sessions, 0)).toBe(s.size);
		// A custom single date (24 h) is per hour; two dates per day.
		expect((await store.query("player-stats", { from: "2026-10-01", to: "2026-10-01" }, { pid: payer })).window.bucket).toBe("hour");
		expect((await store.query("player-stats", { from: "2026-10-01", to: "2026-10-02" }, { pid: payer })).series.length).toBe(2);
		// The explorer's "Last 6 hours" / "Last 1 hour" send an ISO instant.
		const six = await store.query("player-stats", { from: new Date(NOW - 6 * 3_600_000).toISOString() }, { pid: payer });
		expect(six.window).toMatchObject({ bucket: "5 minutes", bucketMs: 300_000 });
		expect(six.series.length).toBe(72);
		const one = await store.query("player-stats", { from: new Date(NOW - 3_600_000).toISOString() }, { pid: payer });
		expect(one.window).toMatchObject({ bucket: "minute", days: 1 });
		expect(one.series.length).toBe(60);
		expect(one.series[0].start).toBe(new Date(NOW - 3_600_000).toISOString());
	});

	test("bounds: the window is cut to 400 days; list limits mark truncation; bad options are refused", async () => {
		const wide = await store.query("player-stats", { from: "2020-01-01" }, { pid: payer });
		expect(wide.window.clamped).toBe(true);
		expect(Date.parse(wide.window.from)).toBe(NOW - 400 * DAY);
		expect(wide.series.length).toBeLessThanOrEqual(401);
		const short = await store.query("player-stats", {}, { pid: payer, sessions: 1, purchases: 1 });
		expect(short.sessions.length).toBe(1);
		expect(short.sessionsTruncated).toBe(short.totals.sessions > 1);
		expect(short.purchasesTruncated).toBe(short.totals.purchases > 1);
		expect(() => store.render("player-stats", {}, { pid: "x' OR 1=1 --" })).toThrow("pid");
		expect(() => store.render("player-stats", {}, {})).toThrow("pid");
		expect(() => store.render("player-stats", {}, { pid: payer, sessions: 0 })).toThrow("sessions");
		expect(() => store.render("player-stats", {}, { pid: payer, purchases: 5000 })).toThrow("purchases");
	});

	test("a player without rows: zeros and empty lists, the series still dense", async () => {
		const r = await store.query("player-stats", { from: "2026-09-29", to: "2026-10-05" }, { pid: "nobody-here" });
		expect(r.totals).toMatchObject({ sessions: 0, events: 0, playtimeMinutes: 0, avgSessionMinutes: 0, medianSessionMinutes: 0, robux: 0, purchases: 0, firstSeen: null, lastSeen: null });
		expect(r.series.length).toBe(7);
		expect(r.series.every((b) => b.sessions === 0 && b.robux === 0)).toBe(true);
		expect(r.sessions).toEqual([]);
		expect(r.purchases).toEqual([]);
	});
});

test("unknown queries and bad filters are refused", async () => {
	await expect(store.query("nope" as never)).rejects.toThrow("unknown query");
	expect(() => store.render("overview", { dev: "fridge" as never })).toThrow("dev must be one of");
	expect(() => store.render("overview", { variant: { experiment: "a'b", variant: "x" } })).toThrow("experiment");
});
