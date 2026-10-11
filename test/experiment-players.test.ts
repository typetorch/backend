/**
 * GET /v1/experiments/<key>/players: the players in one experiment, from the `experiment` rows and the `exp` stamps.
 * Variants, random vs forced, the page's filters, the cap, the gates, bad parameters and erased players. The fake
 * Roblox answers names; every token, pid and UserId is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseExperimentPlayers } from "../src/server/experiment-players.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const UID_A = 5001;

const fakeRoblox = (async (input: string | URL | Request) => {
	const url = String(input instanceof Request ? input.url : input);
	const user = /users\.roblox\.com\/v1\/users\/(\d+)/.exec(url);
	if (user) return new Response(JSON.stringify({ id: Number(user[1]), name: `tester_${user[1]}`, displayName: "Tester" }), { headers: { "content-type": "application/json" } });
	return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

let seq = 0;
function ev(pid: string, t: number, kind: string, name: string, o: { exp?: Record<string, string>; props?: object; branch?: string; dev?: string } = {}) {
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
		dev: o.dev ?? "phone",
		newp: true,
		exp: JSON.stringify(o.exp ?? {}),
		sexp: "",
		src: "server",
		...(o.props ? { props: JSON.stringify(o.props) } : {}),
	};
}

/** A player's assignment row and two stamped rows after it. */
function assigned(pid: string, t: number, variant: string, o: { forced?: boolean; branch?: string; dev?: string; experiment?: string } = {}) {
	const experiment = o.experiment ?? "onboarding";
	const exp = { [experiment]: variant };
	return [
		ev(pid, t, "experiment", experiment, { exp, props: { variant, variants: 2, ...(o.forced ? { forced: true } : {}) }, ...o }),
		ev(pid, t + MIN, "zone", "Lobby", { exp, ...o }),
		ev(pid, t + 2 * MIN, "zone", "Shop", { exp, ...o }),
	];
}

describe("GET /v1/experiments/<key>/players", () => {
	let h: Harness;
	const t = T0 - 3 * 3_600_000;
	const get = async (q: string) => asJson(await h.call(`/v1/experiments/${q}`, { headers: bearer(ADMIN) }));
	const pids = (r: Record<string, any>) => r.players.map((p: { pid: string; variant: string }) => `${p.pid}:${p.variant}`);

	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: "9001" }, { fetch: fakeRoblox });
		const events = [
			...assigned("p-a", t, "short"),
			...assigned("p-b", t + 10 * MIN, "long", { forced: true }),
			// Assigned before the window: only stamped rows.
			ev("p-c", t + 20 * MIN, "zone", "Lobby", { exp: { onboarding: "long" }, dev: "desktop" }),
			// Seen in both variants (the settings changed).
			...assigned("p-d", t + 30 * MIN, "short"),
			...assigned("p-d", t + 40 * MIN, "long", { forced: true }),
			...assigned("p-e", t + 50 * MIN, "short"),
			...assigned("p-f", t + 60 * MIN, "short", { branch: "dev" }),
			// Another experiment only.
			...assigned("p-g", t + 70 * MIN, "red", { experiment: "shop.color" }),
			// 205 players in a big one, for the cap.
			...Array.from({ length: 205 }, (_, i) => ev(`big-${String(i).padStart(3, "0")}`, t + i * 1000, "experiment", "big", { exp: { big: i % 2 ? "b" : "a" }, props: { variant: i % 2 ? "b" : "a", variants: 2 } })),
		];
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events, identities: [{ pid: "p-a", uid: UID_A, t }] }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		expect((await asJson(r)).rejected).toBe(0);
		await h.app.load();
	});
	afterAll(() => h.close());

	test("players per variant, most recently seen first, random vs forced vs unknown, mixed players", async () => {
		const r = await get("onboarding/players?window=1d");
		expect(pids(r)).toEqual(["p-f:short", "p-e:short", "p-d:long", "p-d:short", "p-c:long", "p-b:long", "p-a:short"]);
		expect(r).toMatchObject({ experiment: "onboarding", variant: null, total: 7, more: 0 });
		expect(r.variants).toEqual([
			{ variant: "long", players: 3, forced: 2 },
			{ variant: "short", players: 4, forced: 0 },
		]);
		const by = (pid: string, variant: string) => r.players.find((p: { pid: string; variant: string }) => p.pid === pid && p.variant === variant);
		expect(by("p-a", "short")).toMatchObject({ how: "random", assignedAt: new Date(t).toISOString(), firstAt: new Date(t).toISOString(), lastAt: new Date(t + 2 * MIN).toISOString(), events: 3, mixed: false, uid: UID_A });
		expect(by("p-b", "long")).toMatchObject({ how: "forced", mixed: false });
		expect(by("p-c", "long")).toMatchObject({ how: "unknown", assignedAt: null, events: 1 });
		expect(by("p-d", "long")).toMatchObject({ how: "forced", mixed: true });
		expect(by("p-d", "short")).toMatchObject({ how: "random", mixed: true });
		// Unlinked pids carry no UserId; nothing secret in the answer.
		expect(by("p-b", "long").uid).toBeUndefined();
		expect(JSON.stringify(r)).not.toContain(API);
		expect(JSON.stringify(r)).not.toContain(ADMIN);
		// The Roblox name is looked up in the background and shows on the next read.
		await new Promise((done) => setTimeout(done, 20));
		expect((await get("onboarding/players?window=1d")).players.find((p: { pid: string }) => p.pid === "p-a")).toMatchObject({ uid: UID_A, name: `tester_${UID_A}`, displayName: "Tester" });
	});

	test("one variant; the page's filters and window", async () => {
		const long = await get("onboarding/players?window=1d&variant=long");
		expect(pids(long)).toEqual(["p-d:long", "p-c:long", "p-b:long"]);
		expect(long).toMatchObject({ variant: "long", total: 3, more: 0 });
		expect(long.variants.length).toBe(2);
		expect(pids(await get("onboarding/players?window=1d&branch=dev"))).toEqual(["p-f:short"]);
		expect(pids(await get("onboarding/players?window=1d&dev=desktop"))).toEqual(["p-c:long"]);
		// The filter bar's own variant filter (here the same experiment).
		expect(pids(await get("onboarding/players?window=1d&inExperiment=onboarding&inVariant=long"))).toEqual(["p-d:long", "p-c:long", "p-b:long"]);
		// A window that ends before most of them: from/to as the explorer sends them.
		expect(pids(await get(`onboarding/players?from=${new Date(t - MIN).toISOString()}&to=${new Date(t + 15 * MIN).toISOString()}`))).toEqual(["p-b:long", "p-a:short"]);
		expect(pids(await get("onboarding/players?window=30m"))).toEqual([]);
		expect((await get("nobody/players?window=1d")).players).toEqual([]);
		expect(pids(await get("shop.color/players?window=1d"))).toEqual(["p-g:red"]);
		// The query by POST takes the same join.
		const posted = await asJson(await h.call("/v1/query/experiment-players", post(ADMIN, { filters: { from: new Date(t - MIN).toISOString() }, options: { experiment: "onboarding", variant: "short" } })));
		expect(posted.result.players.find((p: { pid: string }) => p.pid === "p-a").uid).toBe(UID_A);
	});

	test("at most 200, total and more; limit", async () => {
		const big = await get("big/players?window=1d");
		expect(big.players.length).toBe(200);
		expect(big).toMatchObject({ total: 205, more: 5 });
		expect(big.players[0].pid).toBe("big-204");
		const two = await get("big/players?window=1d&limit=2&variant=a");
		expect(pids(two)).toEqual(["big-204:a", "big-202:a"]);
		expect(two).toMatchObject({ total: 103, more: 101 });
	});

	test("bad parameters are 400; other paths 404; only GET", async () => {
		for (const q of ["limit=0", "limit=201", "limit=1.5", "limit=x", "window=5x", "players=all", "place=abc", "dev=toaster", "inExperiment=onboarding", "from=yesterday", `variant=${"v".repeat(65)}`]) {
			expect([q, (await h.call(`/v1/experiments/onboarding/players?${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		}
		for (const key of ["bad%20name", "a'b", "%E0%A4%A", "x".repeat(65)]) {
			expect([key, (await h.call(`/v1/experiments/${key}/players`, { headers: bearer(ADMIN) })).status]).toEqual([key, 400]);
		}
		expect((await h.call("/v1/experiments/onboarding", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/experiments/onboarding/other", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/experiments/onboarding/players", { method: "POST", ...json({}), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(405);
	});

	test("reads need a signed-in reader: nobody and the API key are refused; the web role reads", async () => {
		expect((await h.call("/v1/experiments/onboarding/players")).status).toBe(401);
		expect((await h.call("/v1/experiments/onboarding/players", { headers: bearer(API) })).status).toBe(401);
		const web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 9001, name: "Viewer" }, "web")}` };
		expect((await h.call("/v1/experiments/onboarding/players?window=1d", { headers: web })).status).toBe(200);
		expect((await h.call("/api/v1/experiments/onboarding/players?window=1d", { headers: web })).status).toBe(200);
	});

	test("erased players are left out", async () => {
		expect((await h.call("/v1/erasure", post(ADMIN, { pid: "p-e" }))).status).toBe(200);
		const r = await get("onboarding/players?window=1d");
		expect(pids(r)).not.toContain("p-e:short");
		expect(r.total).toBe(6);
	});
});

describe("parseExperimentPlayers", () => {
	test("maps the URL to filters and options", () => {
		const q = new URLSearchParams("variant=b&limit=50&window=6h&branch=prod&branch=dev&players=new&place=12&inExperiment=x&inVariant=y");
		expect(parseExperimentPlayers("/v1/experiments/onboarding/players", q, T0)).toEqual({
			filters: { from: T0 - 6 * 3_600_000, branch: ["prod", "dev"], players: "new", place: 12, variant: { experiment: "x", variant: ["y"] } },
			options: { experiment: "onboarding", variant: "b", limit: 50 },
		});
		// `from` wins over `window`.
		expect(parseExperimentPlayers("/v1/experiments/a/players", new URLSearchParams("from=2026-10-01&window=1h"), T0).filters).toEqual({ from: "2026-10-01" });
	});
});

describe("experiment weights and state for the Experiments page", () => {
	let h: Harness;
	const t = T0 - 3 * 3_600_000;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: "9001" });
		const events = [...assigned("w-a", t, "short"), ...assigned("w-b", t + MIN, "long", { forced: true }), ...assigned("w-c", t + 2 * MIN, "long")];
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		await h.app.load();
	});
	afterAll(() => h.close());

	test("the experiments list counts forced players and the variants the game declares", async () => {
		const r = await asJson(await h.call("/v1/query/experiment", post(ADMIN, { filters: { from: new Date(t - MIN).toISOString() } })));
		expect(r.result.experiments).toEqual([
			{ experiment: "onboarding", variant: "long", players: 2, forced: 1, variantCount: 2 },
			{ experiment: "onboarding", variant: "short", players: 1, forced: 0, variantCount: 2 },
		]);
	});

	test("GET /v1/experiments: the overrides from the settings file only, for every reader; none without a file", async () => {
		const read = async (headers: Record<string, string> = bearer(ADMIN)) => h.call("/v1/experiments", { headers });
		expect(await asJson(await read())).toEqual({ source: "none", experiments: {} });
		writeFileSync(
			join(h.dir, "settings.json"),
			JSON.stringify({ flushSeconds: 20, token: "fake-ingest-token-0123456789", events: "https://example.invalid/v1/ingest", experiments: { onboarding: { weights: [3, 1], players: { "123": "long" } }, shop: { active: false }, colors: { variant: "red" } } }),
		);
		const r = await asJson(await read());
		expect(r).toEqual({ source: "settings-file", experiments: { onboarding: { weights: [3, 1] }, shop: { active: false }, colors: { variant: "red" } } });
		const text = JSON.stringify(r);
		expect(text).not.toContain("fake-ingest-token");
		expect(text).not.toContain("123");
		const web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 9001, name: "Viewer" }, "web")}` };
		expect((await read(web)).status).toBe(200);
		expect((await read(bearer(API))).status).toBe(401);
		expect((await read({})).status).toBe(401);
		expect((await h.call("/v1/experiments", post(ADMIN, {}))).status).toBe(405);
		writeFileSync(join(h.dir, "settings.json"), "{ not json");
		expect(await asJson(await read())).toEqual({ source: "unreadable", experiments: {} });
	});
});
