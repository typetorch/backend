/**
 * POST /v1/query/funnel-players: the players at one funnel step (reached, or dropped off there), for a logged funnel
 * and the built-in playtime funnels. Step edges (a skipped step, a step nobody logged), the page's filters, the cap,
 * the gates, bad parameters and erased players. Every token and pid is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const UID_A = 5101;

let seq = 0;
function ev(pid: string, t: number, kind: string, name: string, o: { props?: object; branch?: string } = {}) {
	seq += 1;
	return {
		v: 1,
		t,
		kind,
		name,
		pid,
		sid: `${pid}-s1`,
		job: "job-1",
		srv: "public",
		place: 1,
		art: "a1b2c3d-000001",
		seq,
		branch: o.branch ?? "prod",
		channel: "prod",
		dev: "phone",
		newp: true,
		exp: "{}",
		sexp: "",
		src: "server",
		...(o.props ? { props: JSON.stringify(o.props) } : {}),
	};
}
const LABELS = ["", "spawned", "moved", "done"];
const step = (pid: string, t: number, i: number, branch?: string) => ev(pid, t, "funnel", "tut", { props: { i, s: LABELS[i] }, ...(branch ? { branch } : {}) });

describe("funnel-players", () => {
	let h: Harness;
	const t = T0 - 3 * 3_600_000;
	const from = new Date(t - MIN).toISOString();
	const iso = (ms: number) => new Date(ms).toISOString();
	const read = async (options: object, filters: object = { from }) => asJson(await h.call("/v1/query/funnel-players", post(ADMIN, { filters, options })));
	const pids = (r: Record<string, any>) => r.result.players.map((p: { pid: string }) => p.pid);

	beforeAll(async () => {
		const events = [
			// a: every step, then plays on to t+5m.
			step("a", t, 1),
			step("a", t + MIN, 2),
			step("a", t + 2 * MIN, 3),
			ev("a", t + 5 * MIN, "zone", "Lobby"),
			// b: two steps.
			step("b", t + 10 * MIN, 1),
			step("b", t + 11 * MIN, 2),
			// c: the first step only.
			step("c", t + 20 * MIN, 1),
			// d: skips step 2 (step 3 counts as reaching it).
			step("d", t + 30 * MIN, 1),
			step("d", t + 32 * MIN, 3),
			// e: the first step, on the dev branch.
			step("e", t + 40 * MIN, 1, "dev"),
			// f: no funnel; a 45 s session (playtime only).
			ev("f", t + 50 * MIN, "zone", "Lobby"),
			ev("f", t + 50 * MIN + 45_000, "zone", "Shop"),
			// 205 starters of another funnel, for the cap.
			...Array.from({ length: 205 }, (_, i) => ev(`big-${String(i).padStart(3, "0")}`, t + i * 1000, "funnel", "big", { props: { i: 1 } })),
		];
		h = await harness({ TYPETORCH_WEB_VIEWERS: "9001" });
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events, identities: [{ pid: "a", uid: UID_A, t }] }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		expect((await asJson(r)).rejected).toBe(0);
		await h.app.load();
	});
	afterAll(() => h.close());

	test("reached: furthest step at least this one, most recent first; a skipped step counts as reached", async () => {
		const one = await read({ funnel: "tut", step: 1 });
		expect(pids(one)).toEqual(["e", "d", "c", "b", "a"]);
		expect(one.result).toMatchObject({ funnel: "tut", measure: null, step: 1, mode: "reached", total: 5, more: 0 });
		const two = await read({ funnel: "tut", step: 2 });
		expect(pids(two)).toEqual(["d", "b", "a"]);
		const by = (pid: string) => two.result.players.find((p: { pid: string }) => p.pid === pid);
		// d reached step 2 by logging step 3; at = when.
		expect(by("d")).toMatchObject({ at: iso(t + 32 * MIN), lastStep: 3, lastStepAt: iso(t + 32 * MIN), lastAt: iso(t + 32 * MIN) });
		expect(by("a")).toMatchObject({ at: iso(t + MIN), lastStep: 3, lastStepAt: iso(t + 2 * MIN), lastAt: iso(t + 5 * MIN), uid: UID_A });
		expect(by("b")).toMatchObject({ lastStep: 2 });
		expect(by("b").uid).toBeUndefined();
		expect(pids(await read({ funnel: "tut", step: 3 }))).toEqual(["d", "a"]);
		expect(pids(await read({ funnel: "tut", step: 4 }))).toEqual([]);
		expect(JSON.stringify(two)).not.toContain(ADMIN);
		expect(JSON.stringify(two)).not.toContain(API);
	});

	test("dropped: reached the step before (among the logged steps) but not this one", async () => {
		const two = await read({ funnel: "tut", step: 2, mode: "dropped" });
		expect(pids(two)).toEqual(["e", "c"]);
		expect(two.result.players[0]).toMatchObject({ at: iso(t + 40 * MIN), lastStep: 1, lastStepAt: iso(t + 40 * MIN) });
		expect(pids(await read({ funnel: "tut", step: 3, mode: "dropped" }))).toEqual(["b"]);
		// Nobody drops at the first step; past the last step, everyone who finished the last one.
		expect((await read({ funnel: "tut", step: 1, mode: "dropped" })).result).toMatchObject({ total: 0, players: [] });
		expect(pids(await read({ funnel: "tut", step: 4, mode: "dropped" }))).toEqual(["d", "a"]);
	});

	test("the page's filters and range", async () => {
		expect(pids(await read({ funnel: "tut", step: 1 }, { from, branch: ["dev"] }))).toEqual(["e"]);
		expect(pids(await read({ funnel: "tut", step: 2, mode: "dropped" }, { from, branch: ["prod"] }))).toEqual(["c"]);
		expect(pids(await read({ funnel: "tut", step: 1 }, { from, to: iso(t + 15 * MIN) }))).toEqual(["b", "a"]);
		expect(pids(await read({ funnel: "nobody", step: 1 }))).toEqual([]);
	});

	test("playtime funnels: playtime value, reached and dropped against the thresholds", async () => {
		const r = await read({ measure: "total", step: 60 });
		expect(pids(r)).toEqual(["d", "b", "a"]);
		expect(r.result).toMatchObject({ funnel: null, measure: "total", step: 60, total: 3 });
		expect(r.result.players.map((p: { playtimeSeconds: number }) => p.playtimeSeconds)).toEqual([120, 60, 300]);
		expect(r.result.players[2]).toMatchObject({ at: null, lastStep: null, lastAt: iso(t + 5 * MIN), uid: UID_A });
		expect(pids(await read({ measure: "total", step: 60, mode: "dropped" }))).toEqual(["f"]);
		expect(pids(await read({ measure: "first", step: 180 }))).toEqual(["a"]);
		expect(pids(await read({ measure: "first", step: 180, mode: "dropped" }))).toEqual(["d", "b"]);
		// Below the first threshold (zero included): c, e and the 205 one-row players.
		const under = await read({ measure: "total", step: 30, mode: "dropped", limit: 3 });
		expect(under.result).toMatchObject({ total: 207, more: 204 });
		expect(pids(await read({ measure: "total", step: 30, mode: "dropped" }, { from, branch: ["dev"] }))).toEqual(["e"]);
	});

	test("at most 200, total and more; limit", async () => {
		const big = await read({ funnel: "big", step: 1 });
		expect(big.result.players.length).toBe(200);
		expect(big.result).toMatchObject({ total: 205, more: 5 });
		expect(big.result.players[0].pid).toBe("big-204");
		const two = await read({ funnel: "big", step: 1, limit: 2 });
		expect(pids(two)).toEqual(["big-204", "big-203"]);
		expect(two.result).toMatchObject({ total: 205, more: 203 });
	});

	test("bad parameters are 400", async () => {
		for (const options of [
			{},
			{ step: 1 },
			{ funnel: "tut" },
			{ funnel: "tut", measure: "total", step: 60 },
			{ funnel: "tut", step: 1, mode: "left" },
			{ funnel: "tut", step: "abc" },
			{ funnel: "tut", step: 1.5 },
			{ funnel: "tut", step: 1e12 },
			{ funnel: "a'b", step: 1 },
			{ funnel: "tut", step: 1, limit: 0 },
			{ funnel: "tut", step: 1, limit: 201 },
			{ measure: "total", step: 45 },
			{ measure: "week", step: 60 },
		]) {
			const r = await h.call("/v1/query/funnel-players", post(ADMIN, { filters: { from }, options }));
			expect([options, r.status]).toEqual([options, 400]);
		}
	});

	test("reads need a signed-in reader: nobody and the API key are refused; the web role reads", async () => {
		const body = { filters: { from }, options: { funnel: "tut", step: 1 } };
		expect((await h.call("/v1/query/funnel-players", post(undefined, body))).status).toBe(401);
		expect((await h.call("/v1/query/funnel-players", post(API, body))).status).toBe(401);
		const cookie = `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 9001, name: "Viewer" }, "web")}`;
		const asWeb = (headers: Record<string, string>) => h.call("/v1/query/funnel-players", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie, ...headers } });
		expect((await asWeb({})).status).toBe(403);
		const ok = await asWeb({ "x-typetorch": "1" });
		expect(ok.status).toBe(200);
		expect(pids(await asJson(ok)).length).toBe(5);
	});

	test("erased players are left out", async () => {
		expect((await h.call("/v1/erasure", post(ADMIN, { pid: "d" }))).status).toBe(200);
		const r = await read({ funnel: "tut", step: 2 });
		expect(pids(r)).toEqual(["b", "a"]);
		expect(r.result.total).toBe(2);
	});
});
