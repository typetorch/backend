/** Error logs: POST /v1/errors, the store (kinds, per-minute counts, players), the admin reads, the live stream. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ERROR_LIMITS, ErrorInputError, parseErrorBatch } from "../src/errors/parse.ts";
import { chooseBucket, ErrorQueueFull, ErrorStore, spreadCount } from "../src/errors/store.ts";
import { openSqlite } from "../src/fleet/db.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const item = (over: Record<string, unknown> = {}) => ({
	fp: "fp-boom",
	template: "Script <player.name> failed: attempt to index nil",
	stack: "Workspace.Game.Round:42\nWorkspace.Game.Main:7",
	count: 3,
	firstAt: T0 - 2 * MIN,
	lastAt: T0 - MIN,
	branch: "prod",
	build: "a1b2c3d-000042",
	realm: "server",
	pids: ["p1", "p2"],
	...over,
});

describe("parseErrorBatch", () => {
	test("a good batch; seconds become ms; the bare array works; unknown fields are dropped", () => {
		const b = parseErrorBatch({ v: 1, j: "job-1", errors: [item({ firstAt: Math.floor((T0 - MIN) / 1000), lastAt: Math.floor(T0 / 1000), extra: "x" })] }, T0);
		expect(b).toMatchObject({ job: "job-1", rejected: 0, total: 3 });
		expect(b.items[0]).toMatchObject({ fp: "fp-boom", firstAt: T0 - MIN, lastAt: T0, realm: "server", branch: "prod", build: "a1b2c3d-000042", pids: ["p1", "p2"] });
		expect(b.items[0]).not.toHaveProperty("extra");
		// The bare array works with the JobId in the X-TT-Job header.
		expect(parseErrorBatch([item()], T0, "job-h")).toMatchObject({ job: "job-h" });
		expect(parseErrorBatch({ j: "job-1", errors: [] }, T0)).toMatchObject({ job: "job-1", items: [], total: 0 });
		const minimal = parseErrorBatch({ j: "job-1", errors: [{ fp: "a", template: "t", count: 1, firstAt: T0, lastAt: T0, realm: "client" }] }, T0).items[0];
		expect(minimal).toMatchObject({ stack: null, branch: null, build: null, pids: [] });
	});

	test("the body itself must have the right shape (400)", () => {
		for (const bad of [null, "text", 5, {}, { j: "job-1", errors: {} }, { j: "job-1", errors: "x" }, { j: 5, errors: [] }, { j: "x".repeat(65), errors: [] }, { j: "line" + String.fromCharCode(10) + "break", errors: [] }]) {
			expect(() => parseErrorBatch(bad, T0)).toThrow(ErrorInputError);
		}
		expect(() => parseErrorBatch({ j: "job-1", errors: new Array(ERROR_LIMITS.items + 1).fill(item()) }, T0)).toThrow("at most 200");
		expect(parseErrorBatch({ j: "job-1", errors: new Array(ERROR_LIMITS.items).fill(item()) }, T0).items.length).toBe(200);
	});

	test("j (the JobId) is required: in the body or the X-TT-Job header", () => {
		for (const body of [{ errors: [] }, { j: "", errors: [] }, { j: null, errors: [] }, [item()]]) expect(() => parseErrorBatch(body, T0)).toThrow("j (the JobId) is required");
		expect(parseErrorBatch({ errors: [] }, T0, "job-header").job).toBe("job-header");
		expect(parseErrorBatch({ j: "job-body", errors: [] }, T0, "job-header").job).toBe("job-body");
		expect(() => parseErrorBatch({ errors: [] }, T0, "x".repeat(65))).toThrow(ErrorInputError);
	});

	test("bad items are dropped and counted, with the first few reasons", () => {
		const bad = [
			item({ fp: "" }),
			item({ fp: "has space" }),
			item({ fp: "x".repeat(65) }),
			item({ template: "" }),
			item({ template: "t".repeat(ERROR_LIMITS.template + 1) }),
			item({ stack: "s".repeat(ERROR_LIMITS.stack + 1) }),
			item({ template: "nul\0inside" }),
			item({ count: 0 }),
			item({ count: 1.5 }),
			item({ count: ERROR_LIMITS.count + 1 }),
			item({ count: "3" }),
			item({ firstAt: T0, lastAt: T0 - MIN }),
			item({ firstAt: T0 - 8 * 86_400_000, lastAt: T0 - 8 * 86_400_000 + 1000 }),
			item({ firstAt: T0, lastAt: T0 + 3_600_000 }),
			item({ firstAt: "now", lastAt: T0 }),
			item({ realm: "studio" }),
			item({ realm: undefined }),
			item({ branch: "b".repeat(65) }),
			item({ pids: "p1" }),
			"not an object",
			null,
		];
		const b = parseErrorBatch({ j: "job-1", errors: [...bad, item()] }, T0);
		expect(b.items.length).toBe(1);
		expect(b.rejected).toBe(bad.length);
		expect(b.errors.length).toBe(5);
		expect(b.errors[0]).toContain("errors[0]");
	});

	test("limits of the pid list: at most 10 (more are ignored), bad ids dropped", () => {
		const pids = [...Array.from({ length: 70 }, (_, i) => `p${i}`), "bad id", "x".repeat(65), 5];
		const out = parseErrorBatch({ j: "job-1", errors: [item({ pids })] }, T0).items[0]?.pids as string[];
		expect(out.length).toBe(10);
		expect(out.every((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p))).toBe(true);
	});

	test("counts are spread over the minutes an item covers", () => {
		expect(spreadCount(10, T0, T0)).toEqual([{ minute: Math.floor(T0 / MIN), n: 10 }]);
		expect(spreadCount(10, T0 - 3 * MIN, T0)).toEqual([
			{ minute: Math.floor(T0 / MIN) - 3, n: 2 },
			{ minute: Math.floor(T0 / MIN) - 2, n: 2 },
			{ minute: Math.floor(T0 / MIN) - 1, n: 2 },
			{ minute: Math.floor(T0 / MIN), n: 4 },
		]);
		// Longer than 10 minutes: all in the last minute (one item is at most 11 count rows).
		expect(spreadCount(10, T0 - 3 * 3_600_000, T0)).toEqual([{ minute: Math.floor(T0 / MIN), n: 10 }]);
		expect(spreadCount(10, T0 - 11 * MIN, T0)).toEqual([{ minute: Math.floor(T0 / MIN), n: 10 }]);
		expect(spreadCount(100, T0 - 10 * MIN, T0).length).toBe(11);
		expect(spreadCount(2, T0 - 3 * MIN, T0).reduce((s, x) => s + x.n, 0)).toBe(2);
		expect(chooseBucket(3_600_000)).toBe(60);
		expect(chooseBucket(6 * 3_600_000)).toBe(300);
		expect(chooseBucket(24 * 3_600_000)).toBe(1800);
		expect(chooseBucket(7 * 86_400_000)).toBe(21600);
		expect(chooseBucket(30 * 86_400_000)).toBe(43200);
		expect(chooseBucket(3_600_000, 300)).toBe(300);
		expect(chooseBucket(30 * 86_400_000, 60)).toBeGreaterThan(60);
	});
});

describe("POST /v1/errors", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	test("accepts a batch with the API key; the admin token and anonymous callers are refused", async () => {
		const ok = await h.call("/v1/errors", post(API, { v: 1, j: "job-e1", errors: [item(), item({ fp: "fp-other", template: "other <player.user_id>", count: 1, pids: [] })] }));
		expect(ok.status).toBe(202);
		expect(await asJson(ok)).toEqual({ accepted: 2, rejected: 0 });
		expect((await h.call("/v1/errors", post(ADMIN, { j: "job-e1", errors: [] }))).status).toBe(401);
		expect((await h.call("/v1/errors", post(undefined, { j: "job-e1", errors: [] }))).status).toBe(401);
		expect((await h.call("/v1/errors", { method: "PUT", ...json({ j: "job-e1", errors: [] }), headers: { ...bearer(API) } })).status).toBe(401);
		// No JobId: 400.
		const none = await h.call("/v1/errors", post(API, { errors: [item()] }));
		expect(none.status).toBe(400);
		expect((await asJson(none)).error).toContain("j (the JobId) is required");
	});

	test("strict sizes like /v1/ingest: shape 400, body 413, inflated 413, bad rows counted", async () => {
		expect((await h.call("/v1/errors", post(API, { j: "job-s", errors: "nope" }))).status).toBe(400);
		expect((await h.call("/v1/errors", { method: "POST", body: "{nope", headers: bearer(API) })).status).toBe(400);
		expect((await h.call("/v1/errors", { method: "POST", body: new Uint8Array([0x1f, 0x8b, 1, 2, 3]), headers: { ...bearer(API), "content-encoding": "gzip" } })).status).toBe(400);
		expect((await h.call("/v1/errors", { method: "POST", body: new Uint8Array(600 * 1024), headers: bearer(API) })).status).toBe(413);
		const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 32));
		expect((await h.call("/v1/errors", { method: "POST", body: bomb, headers: { ...bearer(API), "content-encoding": "gzip" } })).status).toBe(413);
		expect((await h.call("/v1/errors", post(API, { j: "job-s", errors: new Array(201).fill(item()) }))).status).toBe(400);
		const mixed = await h.call("/v1/errors", post(API, { j: "job-s", errors: [item({ fp: "fp-mixed" }), item({ count: -1 }), item({ realm: "x" })] }));
		expect(mixed.status).toBe(202);
		expect(await asJson(mixed)).toMatchObject({ accepted: 1, rejected: 2 });
		const gz = await h.call("/v1/errors", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ j: "job-s", errors: [item({ fp: "fp-gz" })] }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(gz.status).toBe(202);
	});

	test("rate limit per JobId: 30 a minute pass, the 31st is 429", async () => {
		const codes: number[] = [];
		for (let i = 0; i < 31; i++) codes.push((await h.call("/v1/errors", post(API, { j: "job-flood", errors: [] }))).status);
		expect(codes.slice(0, 30).every((c) => c === 202)).toBe(true);
		expect(codes[30]).toBe(429);
		expect((await h.call("/v1/errors", post(API, { j: "job-other", errors: [] }))).status).toBe(202);
		// The JobId may come in the X-TT-Job header (then the bare array works).
		const viaHeader = await h.call("/v1/errors", { method: "POST", body: JSON.stringify([item({ fp: "fp-hdr" })]), headers: { ...bearer(API), "x-tt-job": "job-hdr" } });
		expect(viaHeader.status).toBe(202);
	});
});

describe("error kinds, counts and the admin reads", () => {
	let h: Harness;
	const get = async (path: string) => asJson(await h.call(path, { headers: bearer(ADMIN) }));
	// Roblox's user API, faked: names for the error -> players list (looked up in the background, cached).
	const robloxCalls: string[] = [];
	const fakeRoblox = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		robloxCalls.push(url);
		const user = /users\.roblox\.com\/v1\/users\/(\d+)/.exec(url);
		if (user) return new Response(JSON.stringify({ id: Number(user[1]), name: `Tester${user[1]}`, displayName: "Test Player" }), { headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_ERROR_MAX_KINDS: "10" }, { fetch: fakeRoblox });
		const send = async (...items: Record<string, unknown>[]) => expect((await h.call("/v1/errors", post(API, { j: "job-a", errors: items }))).status).toBe(202);
		// Three minutes of one server error on prod build A, two players...
		await send(item({ count: 4, firstAt: T0 - 3 * MIN, lastAt: T0 - 3 * MIN, pids: ["p1", "p2"] }));
		await send(item({ count: 6, firstAt: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, pids: ["p2", "p3"], stack: "a different later stack" }));
		// ...the same kind on dev build B (client),
		await send(item({ count: 2, firstAt: T0 - MIN, lastAt: T0 - MIN, branch: "dev", build: "b2-000043", realm: "client", pids: ["p4"] }));
		// ...and a second kind, once, two hours ago.
		await send({ fp: "fp-two", template: "HTTP 429 from <url>", count: 1, firstAt: T0 - 2 * 3_600_000, lastAt: T0 - 2 * 3_600_000, branch: "prod", build: "a1b2c3d-000042", realm: "server", pids: [] });
		await h.app.bus.idle();
	});
	afterAll(() => h.close());

	test("the list: kinds in a window with counts, players, a sparkline and the sample stack's first line", async () => {
		const r = await get("/v1/errors?window=1h");
		expect(r.window).toMatchObject({ bucketSeconds: 60, buckets: 60 });
		expect(r.kinds.map((k: { fp: string }) => k.fp)).toEqual(["fp-boom"]); // fp-two is two hours old
		const k = r.kinds[0];
		expect(k).toMatchObject({ fp: "fp-boom", count: 12, players: 4, total: 12, realm: "server", topFrame: "Workspace.Game.Round:42" });
		expect(k.template).toContain("<player.name>");
		expect(k.spark.length).toBe(60);
		expect(k.spark.reduce((a: number, b: number) => a + b, 0)).toBe(12);
		expect(k.spark.slice(-4)).toEqual([0, 4, 6, 2]); // T0-4m, T0-3m, T0-2m, T0-1m: the window ends at T0, exclusive
		expect(r.totals).toEqual({ count: 12, kinds: 1, players: 4 });
		const wide = await get("/v1/errors?window=24h");
		expect(wide.kinds.map((x: { fp: string }) => x.fp)).toEqual(["fp-boom", "fp-two"]);
		expect(wide.totals).toMatchObject({ count: 13, kinds: 2 });
		expect(wide.window.bucketSeconds).toBe(1800);
		expect(wide.kinds[0].spark.length).toBe(wide.window.buckets);
	});

	test("filters: branch, build, realm, text; limit", async () => {
		const dev = await get("/v1/errors?window=1h&branch=dev");
		expect(dev.kinds[0]).toMatchObject({ fp: "fp-boom", count: 2, players: 1 });
		expect((await get("/v1/errors?window=1h&build=a1b2c3d-000042")).kinds[0]).toMatchObject({ count: 10, players: 3 });
		expect((await get("/v1/errors?window=1h&realm=client")).kinds[0]).toMatchObject({ count: 2 });
		expect((await get("/v1/errors?window=24h&q=HTTP%20429")).kinds.map((x: { fp: string }) => x.fp)).toEqual(["fp-two"]);
		expect((await get("/v1/errors?window=24h&q=fp-two")).kinds.length).toBe(1);
		expect((await get("/v1/errors?window=24h&q=%25")).kinds.length).toBe(0); // % is text, not a wildcard
		const one = await get("/v1/errors?window=24h&limit=1");
		expect(one.kinds.length).toBe(1);
		expect(one.more).toBe(1);
		expect((await get("/v1/errors?window=1h&branch=nowhere")).kinds).toEqual([]);
	});

	test("artifact filter: builds in the window, most recent first; the build filter keeps the list and combines", async () => {
		const all = await get("/v1/errors?window=1h");
		// b2-000043 was last seen at T0-1m, a1b2c3d-000042 at T0-2m.
		expect(all.builds.map((b: { build: string }) => b.build)).toEqual(["b2-000043", "a1b2c3d-000042"]);
		expect(all.builds[0]).toMatchObject({ n: 2, lastAt: new Date(Math.floor((T0 - MIN) / MIN) * MIN).toISOString() });
		const one = await get("/v1/errors?window=1h&build=b2-000043");
		expect(one.totals.count).toBe(2);
		expect(one.builds.length).toBe(2); // the choice stays listed
		// With another filter: only builds under it, and the build filter combines with it.
		expect((await get("/v1/errors?window=1h&branch=prod")).builds.map((b: { build: string }) => b.build)).toEqual(["a1b2c3d-000042"]);
		expect((await get("/v1/errors?window=1h&branch=prod&build=b2-000043")).kinds).toEqual([]);
		expect((await get("/v1/errors?window=24h&build=a1b2c3d-000042&realm=server")).totals.count).toBe(11);
		// Invalid values are refused.
		for (const q of [`build=${"x".repeat(65)}`, "build=a%00b", "build=a%0Ab", "branch=a%7Fb"]) {
			expect([q, (await h.call(`/v1/errors?window=1h&${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		}
		// A value the SQL would mind is only a value (parameterized).
		expect((await get("/v1/errors?window=1h&build=%27%20OR%201%3D1%20--")).kinds).toEqual([]);
	});

	test("one kind: the first sample stack is kept, series, where it happens", async () => {
		const d = await get("/v1/errors/fp-boom?window=1h");
		expect(d.kind).toMatchObject({ fp: "fp-boom", stack: "Workspace.Game.Round:42\nWorkspace.Game.Main:7", realm: "server", total: 12 });
		expect(d.kind.firstAt).toBe(new Date(T0 - 3 * MIN).toISOString());
		expect(d.kind.lastAt).toBe(new Date(T0 - MIN).toISOString());
		expect(d).toMatchObject({ count: 12, players: 4 });
		expect(d.series.length).toBe(60);
		expect(d.series.reduce((s: number, p: { n: number }) => s + p.n, 0)).toBe(12);
		expect(d.series.at(-1)).toEqual({ t: new Date(Math.floor((T0 - MIN) / MIN) * MIN).toISOString(), n: 2 });
		expect(d.series.at(-2)).toEqual({ t: new Date(Math.floor((T0 - 2 * MIN) / MIN) * MIN).toISOString(), n: 6 });
		expect(d.byBuild).toEqual([
			{ build: "a1b2c3d-000042", n: 10 },
			{ build: "b2-000043", n: 2 },
		]);
		expect(d.byBranch).toEqual([
			{ branch: "prod", n: 10 },
			{ branch: "dev", n: 2 },
		]);
		expect(d.byRealm).toEqual([
			{ realm: "server", n: 10 },
			{ realm: "client", n: 2 },
		]);
		expect((await get("/v1/errors/fp-boom?window=1h&branch=dev")).count).toBe(2);
		expect((await h.call("/v1/errors/nope", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/errors/bad%20fp", { headers: bearer(ADMIN) })).status).toBe(400);
	});

	test("the players who hit a kind: counts, first and last seen, filters, the cap, UserIds and names, erased left out", async () => {
		const r = await get("/v1/errors/fp-boom/players?window=1h");
		// p2 was in both server reports (4 + 6), p3 in the second (6), p1 in the first (4), p4 sent the client one (2).
		expect(r.players.map((p: { pid: string; count: number }) => [p.pid, p.count])).toEqual([
			["p2", 10],
			["p3", 6],
			["p1", 4],
			["p4", 2],
		]);
		expect(r).toMatchObject({ fp: "fp-boom", total: 4, more: 0, withoutPlayer: [] });
		expect(r.players[0]).toMatchObject({ days: 1, realms: ["server"], firstAt: new Date(T0 - 3 * MIN).toISOString(), lastAt: new Date(T0 - 2 * MIN).toISOString() });
		expect(r.players[3]).toMatchObject({ pid: "p4", realms: ["client"] });
		// The page's filters: side, branch, artifact.
		expect((await get("/v1/errors/fp-boom/players?window=1h&realm=client")).players.map((p: { pid: string }) => p.pid)).toEqual(["p4"]);
		expect((await get("/v1/errors/fp-boom/players?window=1h&branch=prod")).players.map((p: { pid: string }) => p.pid)).toEqual(["p2", "p3", "p1"]);
		expect((await get("/v1/errors/fp-boom/players?window=1h&build=b2-000043")).players.map((p: { pid: string }) => p.pid)).toEqual(["p4"]);
		expect((await get("/v1/errors/fp-boom/players?window=1h&branch=nowhere")).players).toEqual([]);
		// The cap: limit=2 shows the top two and says how many more.
		const capped = await get("/v1/errors/fp-boom/players?window=1h&limit=2");
		expect(capped.players.map((p: { pid: string }) => p.pid)).toEqual(["p2", "p3"]);
		expect(capped).toMatchObject({ total: 4, more: 2 });
		for (const q of ["limit=0", "limit=201", "limit=x", "realm=moon", "window=5x"]) {
			expect([q, (await h.call(`/v1/errors/fp-boom/players?${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		}
		expect((await h.call("/v1/errors/nope/players", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/errors/bad%20fp/players", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/errors/fp-boom/other", { headers: bearer(ADMIN) })).status).toBe(404);
		// Reads need a signed-in reader: the API key and nobody are refused.
		expect((await h.call("/v1/errors/fp-boom/players", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/errors/fp-boom/players")).status).toBe(401);
		// A report that named nobody: shown per side, without a player.
		const two = await get("/v1/errors/fp-two/players?window=24h");
		expect(two.players).toEqual([]);
		expect(two.withoutPlayer).toEqual([{ realm: "server", count: 1, firstAt: new Date(Math.floor((T0 - 2 * 3_600_000) / MIN) * MIN).toISOString(), lastAt: new Date(Math.floor((T0 - 2 * 3_600_000) / MIN) * MIN + MIN - 1).toISOString() }]);
		// A linked pid gets its UserId; the Roblox name is looked up in the background and shows on the next read.
		expect((await h.call("/v1/identity", post(API, { identities: [{ pid: "p1", uid: 4242, t: T0 }] }))).status).toBe(202);
		const linked = (await get("/v1/errors/fp-boom/players?window=1h")).players.find((p: { pid: string }) => p.pid === "p1");
		expect(linked.uid).toBe(4242);
		await new Promise((done) => setTimeout(done, 20));
		expect(robloxCalls.some((u) => u.includes("/v1/users/4242"))).toBe(true);
		const named = (await get("/v1/errors/fp-boom/players?window=1h")).players.find((p: { pid: string }) => p.pid === "p1");
		expect(named).toMatchObject({ uid: 4242, name: "Tester4242", displayName: "Test Player" });
		expect(JSON.stringify(named)).not.toContain(API);
		// Erasure removes the player's error rows (the counts stay).
		expect((await h.call("/v1/erasure", post(ADMIN, { pid: "p3" }))).status).toBe(200);
		const after = await get("/v1/errors/fp-boom/players?window=1h");
		expect(after.players.map((p: { pid: string }) => p.pid)).toEqual(["p2", "p1", "p4"]);
		expect(after.total).toBe(3);
		expect((await get("/v1/errors/fp-boom?window=1h")).count).toBe(12);
	});

	test("player -> errors: the kinds one player hit, sorted, filtered, capped, behind the read gate", async () => {
		// p2 and p1 also hit the second kind (it exists already, so the kind cap test below is unchanged).
		const send = async (...items: Record<string, unknown>[]) => expect((await h.call("/v1/errors", post(API, { j: "job-a", errors: items }))).status).toBe(202);
		const two = { fp: "fp-two", template: "HTTP 429 from <url>", branch: "prod", build: "a1b2c3d-000042", realm: "server" };
		await send({ ...two, count: 1, firstAt: T0 - 30 * MIN, lastAt: T0 - 30 * MIN, pids: ["p2"] });
		await send({ ...two, count: 4, firstAt: T0 - 10 * MIN, lastAt: T0 - 10 * MIN, pids: ["p1"] });
		await h.app.bus.idle();
		const p2 = await get("/v1/players/p2/errors?window=1h");
		expect(p2).toMatchObject({ pid: "p2", total: 2, more: 0 });
		expect(p2.errors.map((e: { fp: string; count: number }) => [e.fp, e.count])).toEqual([
			["fp-boom", 10],
			["fp-two", 1],
		]);
		expect(p2.errors[0]).toMatchObject({ template: expect.any(String), topFrame: "Workspace.Game.Round:42", realms: ["server"], days: 1, firstAt: new Date(T0 - 3 * MIN).toISOString(), lastAt: new Date(T0 - 2 * MIN).toISOString() });
		expect(p2.errors[0].total).toBeGreaterThanOrEqual(12);
		expect(p2.errors[1]).toMatchObject({ template: "HTTP 429 from <url>", total: 6 });
		// Same count: the most recently seen first.
		expect((await get("/v1/players/p1/errors?window=1h")).errors.map((e: { fp: string; count: number }) => [e.fp, e.count])).toEqual([
			["fp-boom", 4],
			["fp-two", 4],
		]);
		// Filters: side, branch, build.
		expect((await get("/v1/players/p4/errors?window=1h&realm=client")).errors.map((e: { fp: string }) => e.fp)).toEqual(["fp-boom"]);
		expect((await get("/v1/players/p4/errors?window=1h&realm=server")).errors).toEqual([]);
		expect((await get("/v1/players/p4/errors?window=1h&branch=dev&build=b2-000043")).errors.map((e: { realms: string[] }) => e.realms)).toEqual([["client"]]);
		expect((await get("/v1/players/p2/errors?window=1h&branch=dev")).total).toBe(0);
		expect((await get("/v1/players/p2/errors?window=1h&build=a1b2c3d-000042")).total).toBe(2);
		// The cap.
		const capped = await get("/v1/players/p2/errors?window=1h&limit=1");
		expect(capped).toMatchObject({ total: 2, more: 1 });
		expect(capped.errors.map((e: { fp: string }) => e.fp)).toEqual(["fp-boom"]);
		// A pid nobody reported: empty.
		expect(await get("/v1/players/nobody-here/errors?window=1h")).toMatchObject({ errors: [], total: 0, more: 0 });
		// Bad input.
		for (const q of ["limit=0", "limit=201", "limit=1.5", "window=5x", "realm=moon"]) {
			expect([q, (await h.call(`/v1/players/p2/errors?${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		}
		expect((await h.call("/v1/players/bad%20pid/errors", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call(`/v1/players/${"x".repeat(65)}/errors`, { headers: bearer(ADMIN) })).status).toBe(400);
		// Erased (p3, by the test above): not found.
		expect((await h.call("/v1/players/p3/errors?window=1h", { headers: bearer(ADMIN) })).status).toBe(404);
		// Gates: the API key writes only; no credentials; GET only.
		expect((await h.call("/v1/players/p2/errors", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/players/p2/errors")).status).toBe(401);
		expect((await h.call("/v1/players/p2/errors", post(ADMIN, {}))).status).toBe(405);
	});

	test("bad parameters are 400", async () => {
		for (const q of ["window=5x", "window=0m", "from=yesterday", "bucket=10", "bucket=999999", "limit=0", "limit=501", "realm=moon", "from=2026-10-09T13:00:00Z&to=2026-10-09T12:00:00Z"]) {
			expect([q, (await h.call(`/v1/errors?${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		}
		// Explicit from / to and a bucket work.
		const r = await get(`/v1/errors?from=${T0 - 10 * MIN}&to=${T0}&bucket=300`);
		expect(r.window.bucketSeconds).toBe(300);
		expect(r.kinds[0].count).toBe(12);
	});

	test("stats and the kind cap: kinds past the limit are dropped and counted", async () => {
		const many = Array.from({ length: 15 }, (_, i) => item({ fp: `fp-many-${i}`, count: 1, pids: [] }));
		const res = await h.call("/v1/errors", post(API, { j: "job-b", errors: many }));
		expect(res.status).toBe(202);
		await h.app.bus.idle();
		const stats = h.app.errors.stats;
		expect(stats.kinds).toBe(10);
		expect(stats.droppedKinds).toBe(7); // 2 kinds existed, room for 8 more, 15 sent
		const detail = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		expect(detail.errors).toMatchObject({ kinds: 10, droppedKinds: 7 });
		// A known kind still counts when the table is full.
		await h.call("/v1/errors", post(API, { j: "job-b", errors: [item({ count: 5 })] }));
		expect((await get("/v1/errors?window=1h")).kinds.find((k: { fp: string }) => k.fp === "fp-boom").count).toBe(17);
	});

	test("old counts and kinds are pruned", async () => {
		h.setNow(T0 + 40 * 86_400_000);
		expect(await h.app.errors.prune()).toBeGreaterThan(0);
		expect((await get("/v1/errors?window=30d")).kinds).toEqual([]);
		expect(h.app.errors.stats.kinds).toBe(0);
		h.setNow(T0);
	});
});

describe("error kinds <-> game servers", () => {
	let h: Harness;
	const get = async (path: string) => asJson(await h.call(path, { headers: bearer(ADMIN) }));
	const send = async (job: string, ...items: Record<string, unknown>[]) => expect((await h.call("/v1/errors", post(API, { j: job, errors: items }))).status).toBe(202);
	const JOB_A = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";
	beforeAll(async () => {
		h = await harness();
		await send(JOB_A, item({ count: 4, firstAt: T0 - 3 * MIN, lastAt: T0 - 3 * MIN }), item({ fp: "fp-two", template: "HTTP 429 from <url>", count: 1, firstAt: T0 - 2 * MIN, lastAt: T0 - 2 * MIN }));
		await send(JOB_A, item({ count: 2, firstAt: T0 - MIN, lastAt: T0 - MIN }));
		await send("job-b", item({ count: 1, firstAt: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, branch: "dev", build: "b2-000043", realm: "client" }));
		// Two days ago, on a server that is long gone.
		await send("job-old", item({ count: 9, firstAt: T0 - 2 * 86_400_000, lastAt: T0 - 2 * 86_400_000 }));
		await h.app.bus.idle();
	});
	afterAll(() => h.close());

	test("a kind's detail lists the servers that reported it in the window, most occurrences first", async () => {
		const d = await get("/v1/errors/fp-boom?window=1h");
		expect(d.byJob).toEqual([
			{ job: JOB_A, n: 6, branch: "prod", build: "a1b2c3d-000042", lastAt: new Date(T0 - MIN).toISOString() },
			{ job: "job-b", n: 1, branch: "dev", build: "b2-000043", lastAt: new Date(T0 - 2 * MIN).toISOString() },
		]);
		expect((await get("/v1/errors/fp-boom?window=1h&realm=client")).byJob.map((j: { job: string }) => j.job)).toEqual(["job-b"]);
		expect((await get("/v1/errors/fp-boom?window=7d")).byJob.map((j: { job: string }) => j.job)).toEqual(["job-old", JOB_A, "job-b"]);
	});

	test("GET /v1/servers/<job>/errors: the kinds one server reported, filtered, capped, behind the read gate", async () => {
		const a = await get(`/v1/servers/${JOB_A}/errors?window=1h`);
		expect(a).toMatchObject({ job: JOB_A, total: 2, more: 0 });
		expect(a.errors.map((e: { fp: string; count: number }) => [e.fp, e.count])).toEqual([
			["fp-boom", 6],
			["fp-two", 1],
		]);
		expect(a.errors[0]).toMatchObject({ topFrame: "Workspace.Game.Round:42", realms: ["server"], firstAt: new Date(T0 - 3 * MIN).toISOString(), total: 16 });
		expect(await get(`/v1/servers/${JOB_A}/errors?window=1h&limit=1`)).toMatchObject({ total: 2, more: 1 });
		expect((await get(`/v1/servers/${JOB_A}/errors?window=1h&realm=client`)).errors).toEqual([]);
		expect((await get("/v1/servers/job-old/errors?window=1h")).errors).toEqual([]);
		expect((await get("/v1/servers/job-old/errors?window=7d")).errors.map((e: { count: number }) => e.count)).toEqual([9]);
		expect(await get("/v1/servers/nobody/errors")).toMatchObject({ errors: [], total: 0 });
		for (const q of ["limit=0", "limit=201", "window=5x", "realm=moon"]) expect([q, (await h.call(`/v1/servers/${JOB_A}/errors?${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		expect((await h.call(`/v1/servers/${"x".repeat(65)}/errors`, { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/servers/a%0Ab/errors", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/servers/%E0%A4%A/errors", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call(`/v1/servers/${JOB_A}/errors`, { headers: bearer(API) })).status).toBe(401);
		expect((await h.call(`/v1/servers/${JOB_A}/errors`)).status).toBe(401);
		expect((await h.call(`/v1/servers/${JOB_A}/errors`, post(ADMIN, {}))).status).toBe(405);
	});

	test("server rows go with the keep window", async () => {
		h.setNow(T0 + 31 * 86_400_000);
		await h.app.errors.prune();
		expect(await get(`/v1/servers/${JOB_A}/errors?window=30d`)).toMatchObject({ errors: [], total: 0 });
	});
});

describe("error -> players in the store", () => {
	test("rows written before per-player counts count once in their day; new reports add to them", async () => {
		const db = await openSqlite(":memory:");
		const DAY = 86_400_000;
		const day = Math.floor((T0 - MIN) / DAY);
		// The schema of the first release (no n / first_at / last_at, no anon).
		await db.exec(`CREATE TABLE error_kinds (fp TEXT PRIMARY KEY, template TEXT NOT NULL, stack TEXT, realm TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, total INTEGER NOT NULL DEFAULT 0, last_branch TEXT, last_build TEXT);
			CREATE TABLE error_counts (fp TEXT NOT NULL, minute INTEGER NOT NULL, branch TEXT NOT NULL, build TEXT NOT NULL, realm TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (fp, minute, branch, build, realm)) WITHOUT ROWID;
			CREATE TABLE error_pids (fp TEXT NOT NULL, day INTEGER NOT NULL, realm TEXT NOT NULL, branch TEXT NOT NULL, build TEXT NOT NULL, pid TEXT NOT NULL, PRIMARY KEY (fp, day, realm, branch, build, pid)) WITHOUT ROWID;`);
		await db.run("INSERT INTO error_kinds (fp, template, realm, first_at, last_at, total) VALUES ('fp-old', 't', 'server', ?, ?, 5)", [T0 - MIN, T0 - MIN]);
		await db.run("INSERT INTO error_counts VALUES ('fp-old', ?, 'prod', 'b1', 'server', 5)", [Math.floor((T0 - MIN) / MIN)]);
		await db.run("INSERT INTO error_pids VALUES ('fp-old', ?, 'server', 'prod', 'b1', 'old-pid')", [day]);
		const store = await ErrorStore.open(db, { clock: () => T0 });
		const w = { from: T0 - 3_600_000, to: T0, bucketSeconds: 60 };
		const before = await store.players("fp-old", w);
		expect(before?.players).toEqual([{ pid: "old-pid", count: 1, days: 1, firstAt: new Date(day * DAY).toISOString(), lastAt: new Date(day * DAY + DAY - 1).toISOString(), realms: ["server"] }]);
		expect(before?.withoutPlayer).toEqual([]);
		await store.record(parseErrorBatch({ j: "job-1", errors: [item({ fp: "fp-old", count: 3, firstAt: T0 - MIN, lastAt: T0 - MIN, branch: "prod", build: "b1", pids: ["old-pid"] })] }, T0));
		expect((await store.players("fp-old", w))?.players[0]).toMatchObject({ pid: "old-pid", count: 4, lastAt: new Date(T0 - MIN).toISOString() });
		expect(await store.players("nope", w)).toBeUndefined();
		await db.close();
	});

	test("at most 200 players, sorted by count then last seen", async () => {
		const db = await openSqlite(":memory:");
		const store = await ErrorStore.open(db, { clock: () => T0 });
		// 25 batches of 10 items, one pid each: 250 players; player i hits it (i % 7) + 1 times, at minute i % 50.
		for (let b = 0; b < 25; b++) {
			const errors = Array.from({ length: 10 }, (_, k) => {
				const i = b * 10 + k;
				return item({ fp: "fp-many", count: (i % 7) + 1, firstAt: T0 - (50 - (i % 50)) * MIN, lastAt: T0 - (50 - (i % 50)) * MIN, pids: [`pl${i}`] });
			});
			await store.record(parseErrorBatch({ j: `job-${b}`, errors }, T0));
		}
		const r = await store.players("fp-many", { from: T0 - 3_600_000, to: T0, bucketSeconds: 60 }, {}, 500);
		expect(r?.players.length).toBe(200);
		expect(r).toMatchObject({ total: 250, more: 50 });
		const list = r?.players ?? [];
		for (let i = 1; i < list.length; i++) {
			const [a, b] = [list[i - 1] as (typeof list)[number], list[i] as (typeof list)[number]];
			expect(a.count > b.count || (a.count === b.count && a.lastAt >= b.lastAt)).toBe(true);
		}
		expect(list[0]?.count).toBe(7);
		await db.close();
	});

	test("player -> errors: at most 200 kinds, sorted by count then last seen", async () => {
		const db = await openSqlite(":memory:");
		const store = await ErrorStore.open(db, { clock: () => T0, maxKinds: 1000, newKindsPerJobHour: 1000, newKindsPerIpHour: 1000 });
		// 25 batches of 10 kinds, all naming one player: kind i is hit (i % 7) + 1 times, at minute i % 50.
		for (let b = 0; b < 25; b++) {
			const errors = Array.from({ length: 10 }, (_, k) => {
				const i = b * 10 + k;
				return item({ fp: `fp-k${i}`, count: (i % 7) + 1, firstAt: T0 - (50 - (i % 50)) * MIN, lastAt: T0 - (50 - (i % 50)) * MIN, pids: ["one-player"] });
			});
			await store.record(parseErrorBatch({ j: `job-${b}`, errors }, T0));
		}
		const r = await store.playerErrors("one-player", { from: T0 - 3_600_000, to: T0, bucketSeconds: 60 }, {}, 500);
		expect(r.errors.length).toBe(200);
		expect(r).toMatchObject({ total: 250, more: 50 });
		for (let i = 1; i < r.errors.length; i++) {
			const [a, b] = [r.errors[i - 1] as (typeof r.errors)[number], r.errors[i] as (typeof r.errors)[number]];
			expect(a.count > b.count || (a.count === b.count && a.lastAt >= b.lastAt)).toBe(true);
		}
		expect(r.errors[0]?.count).toBe(7);
		expect((await store.playerErrors("someone-else", { from: T0 - 3_600_000, to: T0, bucketSeconds: 60 })).errors).toEqual([]);
		await db.close();
	});
});

describe("GET /v1/live", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	/** Reads SSE frames from a response until `until` says stop (or the timeout). */
	async function frames(res: Response, until: (events: { event: string; data: any }[]) => boolean, ms = 4000) {
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const events: { event: string; data: any }[] = [];
		let buffer = "";
		const stop = Date.now() + ms;
		// One read stays pending between rounds: dropping it would lose its chunk.
		let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
		while (Date.now() < stop && !until(events)) {
			pending ??= reader.read();
			const next = await Promise.race([pending, new Promise<undefined>((r) => setTimeout(() => r(undefined), 200))]);
			if (!next) continue;
			pending = undefined;
			if (next.done) break;
			if (next.value) buffer += decoder.decode(next.value);
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const raw = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const event = /^event: (.*)$/m.exec(raw)?.[1];
				const data = /^data: (.*)$/m.exec(raw)?.[1];
				if (event && data) events.push({ event, data: JSON.parse(data) });
			}
		}
		await reader.cancel().catch(() => {});
		return events;
	}

	test("admin only; topics are checked", async () => {
		expect((await h.call("/v1/live")).status).toBe(401);
		expect((await h.call("/v1/live", { headers: bearer(API) })).status).toBe(401);
		const bad = await h.call("/v1/live?topics=events,nope", { headers: bearer(ADMIN) });
		expect(bad.status).toBe(400);
		expect((await asJson(bad)).error).toContain("nope");
		const ok = await h.call("/v1/live?topics=error", { headers: bearer(ADMIN) });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toBe("text/event-stream");
		await ok.body?.cancel();
	});

	test("errors, alerts, deploys and summed-up events and heartbeats arrive; other topics are filtered out", async () => {
		const res = await h.call("/v1/live", { headers: bearer(ADMIN) });
		const only = await h.call("/v1/live?topics=alert", { headers: bearer(ADMIN) });
		const started = frames(res, (e) => ["hello", "error", "alert", "deploy", "events", "heartbeat"].every((n) => e.some((x) => x.event === n)));
		const alertsOnly = frames(only, (e) => e.some((x) => x.event === "alert"));
		await Bun.sleep(50);
		await h.call("/v1/errors", post(API, { j: "job-l", errors: [item({ fp: "fp-live", template: "live <player.name>" })] }));
		await h.call("/v1/fleet/alert", post(API, { level: "warning", code: "live_test", message: "hello", j: "job-l", b: "prod" }));
		await h.call("/v1/fleet/report", post(API, { s: 7, b: "prod", a: "art-7", j: "job-l", r: "swapped" }));
		await h.call("/v1/fleet/deploy", post(API, { s: 8, b: "prod", a: "art-8" }));
		await h.call("/v1/fleet/heartbeat", post(API, { j: "job-l", b: "prod", a: "art-7", n: 5, h: "ok" }));
		await h.call("/v1/ingest", { method: "POST", ...json({ events: [{ v: 1, t: T0, kind: "custom", name: "x", job: "job-l", art: "art-7", pid: "p1", sid: "s1" }] }), headers: { "content-type": "application/json", ...bearer(API) } });
		const events = await started;
		const by = (name: string) => events.filter((e) => e.event === name);
		expect(by("hello")[0]?.data.topics).toEqual(["events", "heartbeat", "deploy", "alert", "error"]);
		expect(by("error")[0]?.data).toMatchObject({ total: 3, rejected: 0, kinds: [{ fp: "fp-live", count: 3, realm: "server" }] });
		expect(by("alert")[0]?.data.alert).toMatchObject({ code: "live_test", level: "warning", source: "game" });
		expect(by("deploy").map((e) => e.data.kind).sort()).toEqual(["report", "start"]);
		expect(by("events")[0]?.data).toMatchObject({ batches: 1, events: 1, rejected: 0, kinds: { custom: 1 } });
		expect(by("heartbeat")[0]?.data.servers[0]).toMatchObject({ job: "job-l", branch: "prod", players: 5, health: "ok" });
		const filtered = await alertsOnly;
		expect(filtered.filter((e) => e.event !== "hello" && e.event !== "alert")).toEqual([]);
		expect(filtered.some((e) => e.event === "alert")).toBe(true);
	});

	test("a limit on open streams, and stats in /healthz", async () => {
		const g = await harness({ TYPETORCH_LIVE_MAX_CLIENTS: "2" });
		try {
			const a = await g.call("/v1/live", { headers: bearer(ADMIN) });
			const b = await g.call("/v1/live", { headers: bearer(ADMIN) });
			const c = await g.call("/v1/live", { headers: bearer(ADMIN) });
			expect([a.status, b.status, c.status]).toEqual([200, 200, 429]);
			expect((await asJson(await g.call("/healthz", { headers: bearer(ADMIN) }))).live).toMatchObject({ clients: 2 });
			await a.body?.cancel();
			await b.body?.cancel();
			await Bun.sleep(20);
			expect(g.app.live.stats.clients).toBe(0);
		} finally {
			await g.close();
		}
	});

	test("over a real connection too (Bun.serve), and a browser's session cookie works", async () => {
		const login = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" } });
		const cookie = (login.headers.getSetCookie().find((c) => c.startsWith("tt_session=")) as string).split(";")[0] as string;
		const res = await fetch(`${h.base}/api/v1/live?topics=error`, { headers: { cookie } });
		expect(res.status).toBe(200);
		const got = frames(res, (e) => e.some((x) => x.event === "error"));
		await Bun.sleep(50);
		await h.call("/v1/errors", post(API, { j: "job-net", errors: [item({ fp: "fp-net" })] }));
		expect((await got).some((e) => e.event === "error" && e.data.kinds[0].fp === "fp-net")).toBe(true);
	});
});

describe("POST /v1/errors under a flood (one API key holder)", () => {
	const items = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, i) => item({ fp: `fp-${i}`, ...over(i) }));
	const send = (h: Harness, j: string, errors: unknown[], ip = "198.51.100.1") => h.call("/v1/errors", { ...post(API, { j, errors }), ip });

	test("a limit per address, whatever JobIds are used", async () => {
		const h = await harness({ TYPETORCH_ERRORS_IP_PER_MINUTE: "5" });
		try {
			const codes: number[] = [];
			for (let i = 0; i < 6; i++) codes.push((await send(h, `job-ip-${i}`, [])).status);
			expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
			expect((await send(h, "job-ip-x", [], "198.51.100.2")).status).toBe(202);
		} finally {
			await h.close();
		}
	});

	test("never-seen JobIds per minute are capped; known ones keep going; the next minute lets new ones in", async () => {
		const h = await harness({ TYPETORCH_NEW_JOBS_PER_MINUTE: "3" });
		try {
			for (let i = 0; i < 3; i++) expect((await send(h, `job-new-${i}`, [], `198.51.100.${i + 10}`)).status).toBe(202);
			const refused = await send(h, "job-new-3", [], "198.51.100.20");
			expect(refused.status).toBe(429);
			expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
			expect((await send(h, "job-new-0", [], "198.51.100.10")).status).toBe(202);
			h.setNow(T0 + 61_000);
			expect((await send(h, "job-new-3", [], "198.51.100.20")).status).toBe(202);
		} finally {
			await h.close();
		}
	});

	test("the kind table can not be filled from one sender in an hour: 50 new kinds per JobId, 200 per address", async () => {
		const h = await harness();
		try {
			expect((await send(h, "job-k1", items(200))).status).toBe(202);
			expect(h.app.errors.stats).toMatchObject({ kinds: 50, droppedQuota: 150 });
			// Known kinds still count for that JobId (only new kinds are limited).
			await send(h, "job-k1", items(50));
			expect(h.app.errors.stats.droppedQuota).toBe(150);
			// More JobIds from the same address: 200 new kinds an hour in all.
			for (let j = 2; j <= 6; j++) await send(h, `job-k${j}`, items(50, (i) => ({ fp: `fp-${j}-${i}` })));
			expect(h.app.errors.stats.kinds).toBe(200);
			// Another address still adds kinds (a real game server elsewhere is not starved).
			await send(h, "job-elsewhere", [item({ fp: "fp-real" })], "203.0.113.50");
			expect(h.app.errors.stats.kinds).toBe(201);
			// The next hour the sender may add more.
			h.setNow(T0 + 3_600_000);
			await send(h, "job-k1", items(10, (i) => ({ fp: `fp-later-${i}`, firstAt: T0 + 3_500_000, lastAt: T0 + 3_500_000 })));
			expect(h.app.errors.stats.kinds).toBe(211);
		} finally {
			await h.close();
		}
	});

	test("one item is bounded work: at most 11 count rows, 10 pids and one server row", async () => {
		const h = await harness();
		try {
			const pids = Array.from({ length: 50 }, (_, i) => `p${i}`);
			await send(h, "job-b", [item({ fp: "fp-wide", count: 600, firstAt: T0 - 60 * MIN, lastAt: T0 - MIN, pids }), item({ fp: "fp-ten", count: 11, firstAt: T0 - 11 * MIN, lastAt: T0 - MIN, pids: [] })]);
			const d = await asJson(await h.call("/v1/errors/fp-wide?window=1h", { headers: bearer(ADMIN) }));
			expect(d.series.filter((p: { n: number }) => p.n > 0).length).toBe(1);
			expect(d.players).toBe(10);
			const ten = await asJson(await h.call("/v1/errors/fp-ten?window=1h", { headers: bearer(ADMIN) }));
			expect(ten.series.filter((p: { n: number }) => p.n > 0).length).toBe(11);
			expect(h.app.errors.stats.rowsToday).toBe(1 + 10 + 11 + 2);
		} finally {
			await h.close();
		}
	});

	test("a daily budget of new rows; drops are counted in /healthz; adding to rows that exist goes on", async () => {
		const h = await harness({ TYPETORCH_ERROR_ROWS_PER_DAY: "1000" });
		try {
			// One kind, 200 items in different minutes, 10 new pids each: far more than 1,000 new rows.
			const many = Array.from({ length: 200 }, (_, i) => item({ fp: "fp-budget", count: 1, firstAt: T0 - (i + 1) * MIN, lastAt: T0 - (i + 1) * MIN, pids: Array.from({ length: 10 }, (_, k) => `q${i}x${k}`) }));
			expect((await send(h, "job-budget", many)).status).toBe(202);
			const stats = h.app.errors.stats;
			expect(stats.rowsToday).toBe(1000);
			expect(stats.droppedRows).toBeGreaterThan(0);
			const health = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
			expect(health.errors).toMatchObject({ rowsToday: 1000, rowsPerDay: 1000 });
			expect(health.errors.droppedRows).toBe(stats.droppedRows);
			// A minute row that exists still counts up.
			const before = (await asJson(await h.call("/v1/errors/fp-budget?window=1h", { headers: bearer(ADMIN) }))).count;
			await send(h, "job-budget", [item({ fp: "fp-budget", count: 5, firstAt: T0 - MIN, lastAt: T0 - MIN, pids: [] })]);
			expect((await asJson(await h.call("/v1/errors/fp-budget?window=1h", { headers: bearer(ADMIN) }))).count).toBe(before + 5);
			// A new UTC day: a new budget.
			h.setNow(T0 + 86_400_000);
			await send(h, "job-budget", [item({ fp: "fp-budget", firstAt: T0 + 86_000_000, lastAt: T0 + 86_000_000 })]);
			expect(h.app.errors.stats.rowsToday).toBeGreaterThan(0);
			expect(h.app.errors.stats.rowsToday).toBeLessThan(20);
		} finally {
			await h.close();
		}
	});

	test("the sample follows the newest report, so text sent first does not stick", async () => {
		const h = await harness();
		try {
			await send(h, "job-evil", [item({ fp: "fp-real", template: "misleading text", stack: "fake:1", firstAt: T0 - 5 * MIN, lastAt: T0 - 5 * MIN })]);
			await send(h, "job-real", [item({ fp: "fp-real", template: "the real message", stack: "real:42", firstAt: T0 - 2 * MIN, lastAt: T0 - 2 * MIN })]);
			let d = await asJson(await h.call("/v1/errors/fp-real?window=1h", { headers: bearer(ADMIN) }));
			expect(d.kind).toMatchObject({ template: "the real message", stack: "real:42", total: 6 });
			// An older report does not replace a newer sample; an item without a stack keeps the stack.
			await send(h, "job-evil", [item({ fp: "fp-real", template: "old misleading", stack: "fake:2", firstAt: T0 - 4 * MIN, lastAt: T0 - 4 * MIN })]);
			await send(h, "job-real", [item({ fp: "fp-real", template: "the real message", stack: undefined, firstAt: T0 - MIN, lastAt: T0 - MIN })]);
			d = await asJson(await h.call("/v1/errors/fp-real?window=1h", { headers: bearer(ADMIN) }));
			expect(d.kind).toMatchObject({ template: "the real message", stack: "real:42" });
		} finally {
			await h.close();
		}
	});

	test("the store takes one batch at a time behind a bounded queue (full = 429), each batch quickly", async () => {
		const db = await openSqlite(":memory:");
		const store = await ErrorStore.open(db, { clock: () => T0, maxQueue: 2 });
		const batch = (j: string) => parseErrorBatch({ j, errors: items(200, (i) => ({ fp: `fp-q-${j}-${i % 50}`, count: 100, firstAt: T0 - 10 * MIN, lastAt: T0, pids: Array.from({ length: 10 }, (_, k) => `p${i}-${k}`) })) }, T0);
		const a = store.record(batch("a"), { ip: "1" });
		const b = store.record(batch("b"), { ip: "2" });
		expect(store.full).toBe(true);
		await expect(store.record(batch("c"), { ip: "3" })).rejects.toBeInstanceOf(ErrorQueueFull);
		expect(store.stats.refusedFull).toBe(1);
		await Promise.all([a, b]);
		expect(store.full).toBe(false);
		// The worst-case batch (200 items x 11 minutes x 10 pids) is one transaction: well under a second.
		const started = performance.now();
		await store.record(batch("d"), { ip: "4" });
		expect(performance.now() - started).toBeLessThan(1000);
		await db.close();
	});

	test("a flood of worst-case batches leaves the event loop free for other work", async () => {
		const h = await harness();
		try {
			const worst = (n: number) => items(200, (i) => ({ fp: `fp-f${n}-${i % 50}`, count: 100, firstAt: T0 - 10 * MIN, lastAt: T0, pids: Array.from({ length: 10 }, (_, k) => `p${n}-${i}-${k}`) }));
			const started = performance.now();
			const flood = Array.from({ length: 8 }, (_, n) => send(h, `job-f${n}`, worst(n), `198.51.100.${n + 100}`));
			// A timer set now fires long before the flood is through (each batch yields to the event loop).
			let fired = 0;
			await new Promise<void>((done) => setTimeout(() => ((fired = performance.now()), done()), 0));
			const statuses = (await Promise.all(flood)).map((r) => r.status);
			const finished = performance.now();
			expect(statuses.every((s) => s === 202)).toBe(true);
			expect(fired).toBeLessThan(finished);
			expect(fired - started).toBeLessThan((finished - started) / 2);
		} finally {
			await h.close();
		}
	});
});
