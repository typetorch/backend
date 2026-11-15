/**
 * Plans/34: game declarations (heartbeat `xh` / `x`, the `xq` reply), column values (`cv` on the server row), game.*
 * commands only when declared, the streams ring (limits, memory only, dropped when the job goes), the live map watch
 * (`lm` in replies, the `{"k":"lm"}` wake), the live map read, the Fleet page's columns and the roles. Tokens are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanPositions, FRAMES_PER_POST_MAX, LIVE_MAP_WATCH_MS, LiveDebugHub, parseColumnValues, parseDeclarations, RING_MS, STREAM_VALUE_MAX } from "../src/fleet/live-debug.ts";
import { LIVE_MAP_WAKE_GAP_MS, WAKE_TOPIC } from "../src/fleet/remote-debug-wake.ts";
import { openApiSpec } from "../src/server/openapi.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";

/** A player name that must never reach the disk or a log line. */
const NAME = "PlayerNameMarker_9q2x";
const KEY = "messaging-key-for-tests-ONLY-publish-0123456789abcdef";

const DECL = {
	c: [
		{ n: "current_map", l: "Map", t: "string" },
		{ n: "in_round", l: "In round", t: "bool" },
		{ n: "round_no", t: "number" },
	],
	cmd: [{ n: "round_state", l: "Round state", d: "The round's phase and timers" }],
	st: [
		{ n: "spawns", hz: 1, k: "points", l: "Spawns" },
		{ n: "score", hz: 10 },
	],
};

function hbOf(h: Harness, j: string, over: Record<string, unknown> = {}) {
	return { j, t: "public", b: "prod", c: "prod", a: "art-1", n: 2, m: 20, s: Math.floor((h.now() - 3_600_000) / 1000), u: Math.floor(h.now() / 1000), p: 1001, v: "0.5.7", q: 7, g: 2, h: "ok", sv: 2, ...over };
}

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...filesUnder(path));
		else out.push(path);
	}
	return out;
}

const positions = (players: unknown[] = [{ u: 101, n: NAME, x: 10.04, y: 5, z: -20, yaw: 1.234, hp: 100, st: "alive" }]) => ({ players });

describe("parsing", () => {
	test("declarations: bad entries out, labels cut, rates clamped, limits", () => {
		const d = parseDeclarations({
			c: [{ n: "ok_col", l: "x".repeat(60), t: "number" }, { n: "Bad" }, { n: "ok_col" }, { n: "other", t: "weird" }, ...Array.from({ length: 20 }, (_, i) => ({ n: `c${i}` }))],
			cmd: [{ n: "a", d: "d".repeat(300) }, { n: "1bad" }],
			st: [{ n: "fast", hz: 50 }, { n: "slow", hz: 0.01, k: "points" }, { n: "norate" }],
		});
		expect(d?.c[0]).toEqual({ n: "ok_col", l: "x".repeat(40), t: "number" });
		expect(d?.c[1]).toEqual({ n: "other" });
		expect(d?.c.length).toBe(16);
		expect(d?.cmd).toEqual([{ n: "a", d: "d".repeat(200) }]);
		expect(d?.st).toEqual([
			{ n: "fast", hz: 4, k: "json" },
			{ n: "slow", hz: 0.2, k: "points" },
			{ n: "norate", hz: 0.2, k: "json" },
		]);
		expect(parseDeclarations(1)).toBeNull();
		expect(parseDeclarations([])).toBeNull();
	});

	test("column values: names checked, strings cut, odd values null", () => {
		expect(JSON.parse(parseColumnValues({ current_map: "m".repeat(80), in_round: true, n: 3, bad_obj: { a: 1 }, Nope: 1, nan: Number.NaN }) as string)).toEqual({ current_map: "m".repeat(64), in_round: true, n: 3, bad_obj: null, nan: null });
		expect(parseColumnValues("x")).toBeNull();
		expect(parseColumnValues({})).toBeNull();
	});

	test("positions: documented fields only, no position without a character", () => {
		expect(cleanPositions({ players: [{ u: 1, n: "A", x: 1.26, y: 2, z: 3, st: "alive", extra: "no" }, { u: 2, n: "B", x: 1, st: "none" }, { n: "no id" }] })).toEqual({
			players: [
				{ u: 1, n: "A", x: 1.3, y: 2, z: 3, st: "alive" },
				{ u: 2, n: "B", st: "none" },
			],
		});
		expect(cleanPositions({ nope: 1 })).toBeNull();
	});

	test("the hub: xq for an unknown hash, kept declarations, nothing declared drops them", () => {
		const hub = new LiveDebugHub({ clock: () => T0 });
		expect(hub.heartbeat("j", { xh: "h1" })).toEqual({ xq: 1 });
		expect(hub.heartbeat("j", { xh: "h1", xd: DECL })).toEqual({});
		expect(hub.heartbeat("j", { xh: "h1" })).toEqual({});
		expect(hub.hasCommand("j", "round_state")).toBe(true);
		expect(hub.heartbeat("j", { xh: "h2" })).toEqual({ xq: 1 });
		expect(hub.heartbeat("j", {})).toEqual({});
		expect(hub.declarations("j")).toBeUndefined();
	});
});

test("every route of live-debug-http.ts is in the OpenAPI list", () => {
	const spec = openApiSpec() as unknown as { paths: Record<string, Record<string, { "x-roles": string[] }>> };
	const source = readFileSync(new URL("../src/fleet/live-debug-http.ts", import.meta.url), "utf8");
	const literals = [...source.matchAll(/path === "(\/[^"]+)"/g)].map((m) => m[1] as string);
	expect(literals.length).toBeGreaterThanOrEqual(4);
	for (const literal of literals) expect(Object.keys(spec.paths)).toContain(literal);
	expect(spec.paths["/v1/fleet/servers/{jobId}/streams"]?.get?.["x-roles"]).toEqual(["admin"]);
	expect(spec.paths["/v1/fleet/columns"]?.get?.["x-roles"]).toEqual(["admin", "web"]);
	expect(spec.paths["/v1/fleet/streams"]?.post?.["x-roles"]).toEqual(["game"]);
});

describe("over HTTP", () => {
	let h: Harness;
	let web: Record<string, string>;
	const sent: { headers: Record<string, string>; body: { topic?: string; message?: string } }[] = [];
	const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		sent.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : {} });
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	const bodies: string[] = [];
	const read = async (res: Response) => {
		const text = await res.text();
		bodies.push(text);
		return JSON.parse(text) as Record<string, any>;
	};
	const heartbeat = (j: string, over: Record<string, unknown> = {}) => h.call("/v1/fleet/heartbeat", post(API, hbOf(h, j, over)));
	const admin = (path: string, init: RequestInit = {}) => h.call(path, { ...init, headers: { ...bearer(ADMIN), "content-type": "application/json", ...(init.headers as Record<string, string>) } });
	const streams = (j: string, frames: unknown[], token = API) => h.call("/v1/fleet/streams", post(token, { j, frames }));

	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet", OPENCLOUD_API_KEY: KEY, TYPETORCH_UNIVERSE_ID: "4242", TYPETORCH_WEB_VIEWERS: "77,78" }, { fetch: fakeFetch });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 77, name: "Viewer" }, "web")}` };
	});
	afterAll(async () => {
		await h.close();
	});

	test("the heartbeat: declarations, xq, cv on the server row, the A/B flag x and the declarations xd side by side", async () => {
		expect(await read(await heartbeat("cv-1", { x: 1 }))).toEqual({ ok: true });
		expect((await asJson(await admin("/v1/fleet/servers/cv-1"))).server.experiment).toBe(true);
		// A hash the backend holds nothing for: asked for the declarations.
		expect(await read(await heartbeat("cv-1", { x: 1, xh: "abc", cv: { current_map: "HedgeMaze", in_round: true, round_no: 4 } }))).toEqual({ ok: true, xq: 1 });
		const after = await asJson(await admin("/v1/fleet/servers/cv-1"));
		expect(after.server.cv).toEqual({ current_map: "HedgeMaze", in_round: true, round_no: 4 });
		// The declarations ride as `xd`, next to the A/B flag `x = 1`: both read.
		expect(await read(await heartbeat("cv-1", { x: 1, xh: "abc", xd: DECL, cv: { current_map: "Lobby" } }))).toEqual({ ok: true });
		const detail = await asJson(await admin("/v1/fleet/servers/cv-1"));
		expect(detail.server.experiment).toBe(true);
		expect((await asJson(await admin(`/v1/fleet/servers/cv-1/streams?since=0`))).declared.commands.map((c: { n: string }) => c.n)).toContain(DECL.cmd[0].n);
		expect(detail.server.cv).toEqual({ current_map: "Lobby" });
		expect(await read(await heartbeat("cv-1", { xh: "abc", cv: { current_map: "Lobby" } }))).toEqual({ ok: true });
		// The live list carries cv too; the columns route lists the union (any signed-in role).
		const list = await asJson(await admin("/v1/fleet/servers"));
		expect(list.servers.find((s: { job: string }) => s.job === "cv-1").cv).toEqual({ current_map: "Lobby" });
		const columns = await asJson(await h.call("/v1/fleet/columns", { headers: web }));
		expect(columns.columns).toEqual([{ n: "current_map", l: "Map", t: "string" }, { n: "in_round", l: "In round", t: "bool" }, { n: "round_no", t: "number" }]);
		expect((await h.call("/v1/fleet/columns")).status).toBe(401);
	});

	test("game.* commands: only when the server declared them, audited without arg values", async () => {
		await heartbeat("cmd-1", { xh: "h", xd: DECL });
		expect((await admin("/v1/fleet/servers/cmd-1/watch", { method: "POST" })).status).toBe(200);
		const refused = await admin("/v1/fleet/servers/cmd-1/commands", { method: "POST", body: JSON.stringify({ op: "game.nope" }) });
		expect(refused.status).toBe(400);
		expect((await asJson(refused)).error).toContain("not declared by this server");
		const big = await admin("/v1/fleet/servers/cmd-1/commands", { method: "POST", body: JSON.stringify({ op: "game.round_state", args: { pad: "x".repeat(3000) } }) });
		expect(big.status).toBe(400);
		const ok = await admin("/v1/fleet/servers/cmd-1/commands", { method: "POST", body: JSON.stringify({ op: "game.round_state", args: { secretArg: "ArgValueMarker" } }) });
		expect(ok.status).toBe(202);
		// The kernel gets it like any op.
		const polled = await asJson(await h.call("/v1/fleet/commands?wait=0", { headers: { ...bearer(API), "x-tt-job": "cmd-1" } }));
		expect(polled.commands[0]).toMatchObject({ op: "game.round_state", args: { secretArg: "ArgValueMarker" } });
		const audit = await asJson(await admin("/v1/fleet/debug/audit"));
		expect(audit.entries[0]).toMatchObject({ op: "game.round_state", job: "cmd-1", args: "game-defined, 1 arg" });
		expect(JSON.stringify(audit)).not.toContain("ArgValueMarker");
		// Another server didn't declare it.
		await heartbeat("cmd-2");
		await admin("/v1/fleet/servers/cmd-2/watch", { method: "POST" });
		expect((await admin("/v1/fleet/servers/cmd-2/commands", { method: "POST", body: JSON.stringify({ op: "game.round_state" }) })).status).toBe(400);
	});

	test("streams: kept only while watched, the ring, since, limits, undeclared and too big values dropped", async () => {
		await heartbeat("st-1", { xh: "h", xd: DECL });
		// Not watched, no live map: nothing kept, told to stop.
		expect(await read(await streams("st-1", [{ t: h.now(), s: { positions: positions() } }]))).toEqual({ ok: true, watch: false, lm: false });
		expect((await asJson(await admin("/v1/fleet/servers/st-1/streams"))).frames).toEqual([]);
		await admin("/v1/fleet/servers/st-1/watch", { method: "POST" });
		const t = h.now();
		const reply = await read(
			await streams("st-1", [
				{ t, s: { positions: positions(), "game.spawns": { points: [{ x: 1, y: 2, z: 3, label: "A", color: "#ff0000" }, { x: "bad" }] }, "game.score": { red: 3 }, "game.undeclared": 1 } },
				{ t: t + 500, s: { "game.score": { pad: "x".repeat(STREAM_VALUE_MAX + 10) } } },
			]),
		);
		expect(reply).toEqual({ ok: true, watch: true, lm: false, dropped: 2 });
		const got = await asJson(await admin("/v1/fleet/servers/st-1/streams"));
		expect(got.declared.commands).toEqual(DECL.cmd);
		expect(got.declared.streams.map((s: { n: string }) => s.n)).toEqual(["spawns", "score"]);
		expect(got.frames).toEqual([{ t, s: { positions: { players: [{ u: 101, n: NAME, x: 10, y: 5, z: -20, yaw: 1.23, hp: 100, st: "alive" }] }, "game.spawns": { points: [{ x: 1, y: 2, z: 3, label: "A", color: "#ff0000" }] }, "game.score": { red: 3 } } }]);
		await streams("st-1", [{ t: t + 1000, s: { positions: positions() } }]);
		expect((await asJson(await admin(`/v1/fleet/servers/st-1/streams?since=${t}`))).frames.map((f: { t: number }) => f.t)).toEqual([t + 1000]);
		expect((await admin("/v1/fleet/servers/st-1/streams?since=soon")).status).toBe(400);
		// Limits: frames per post, the body size, the JobId.
		expect((await streams("st-1", Array.from({ length: FRAMES_PER_POST_MAX + 1 }, () => ({ t, s: {} })))).status).toBe(400);
		expect((await streams("st-1", [{ t, s: { positions: { players: [], pad: "x".repeat(70_000) } } }])).status).toBe(413);
		expect((await h.call("/v1/fleet/streams", post(API, { frames: [] }))).status).toBe(400);
		// A JobId the fleet never heard of: nothing kept, told to stop.
		expect(await read(await streams("never-heard", [{ t, s: { positions: positions() } }]))).toEqual({ ok: true, watch: false, lm: false });
		// The game key only.
		expect((await streams("st-1", [], ADMIN)).status).toBe(401);
		// The ring keeps 120 s.
		h.setNow(T0 + RING_MS + 5_000);
		await heartbeat("st-1", { xh: "h" });
		await admin("/v1/fleet/servers/st-1/watch", { method: "POST" });
		await streams("st-1", [{ t: h.now(), s: { positions: positions() } }]);
		expect((await asJson(await admin("/v1/fleet/servers/st-1/streams"))).frames.map((f: { t: number }) => f.t)).toEqual([h.now()]);
		h.setNow(T0);
	});

	test("streams: the per-job rate limit", async () => {
		await heartbeat("rate-1");
		await admin("/v1/fleet/servers/rate-1/watch", { method: "POST" });
		let last = 0;
		for (let i = 0; i < 100; i++) {
			last = (await streams("rate-1", [])).status;
			if (last === 429) break;
		}
		expect(last).toBe(429);
	});

	test("a closed server's frames and declarations go at once; its column values stay on the row", async () => {
		await heartbeat("close-1", { xh: "h", xd: DECL, cv: { current_map: "HedgeMaze", in_round: null } });
		await admin("/v1/fleet/servers/close-1/watch", { method: "POST" });
		await streams("close-1", [{ t: h.now(), s: { positions: positions() } }]);
		expect((await asJson(await admin("/v1/fleet/servers/close-1/streams"))).frames.length).toBe(1);
		// The kernel's closing request: the heartbeat body without xh / x / cv.
		await h.call("/v1/fleet/closing", post(API, { ...hbOf(h, "close-1"), closing: true }));
		expect((await asJson(await admin("/v1/fleet/servers/close-1"))).server.cv).toEqual({ current_map: "HedgeMaze", in_round: null });
		const after = await asJson(await admin("/v1/fleet/servers/close-1/streams"));
		expect(after).toEqual({ declared: { streams: [], commands: [] }, frames: [] });
		// A lost one too (the sweep marks it after 90 s without a heartbeat).
		await heartbeat("lost-1", { xh: "h", xd: DECL });
		await admin("/v1/fleet/servers/lost-1/watch", { method: "POST" });
		await streams("lost-1", [{ t: h.now(), s: { positions: positions() } }]);
		h.setNow(T0 + 100_000);
		await h.app.fleet?.sweep();
		h.setNow(T0);
		expect(await asJson(await admin("/v1/fleet/servers/lost-1/streams"))).toEqual({ declared: { streams: [], commands: [] }, frames: [] });
	});

	test("the live map: watch, lm in replies, one wake per 30 s, the read, the lapse", async () => {
		await heartbeat("lm-1");
		await heartbeat("lm-2");
		expect((await asJson(await heartbeat("lm-1"))).lm).toBeUndefined();
		const before = sent.length;
		const watch = await read(await admin("/v1/fleet/live-map/watch", { method: "POST" }));
		expect(watch).toMatchObject({ ok: true, until: h.now() + LIVE_MAP_WATCH_MS, wake: true });
		await h.app.waker?.idle();
		const wakes = sent.slice(before);
		expect(wakes.length).toBe(1);
		expect(wakes[0]?.body).toEqual({ topic: WAKE_TOPIC, message: '{"k":"lm"}' });
		expect(wakes[0]?.headers["x-api-key"]).toBe(KEY);
		// Renewals send nothing.
		expect((await read(await admin("/v1/fleet/live-map/watch", { method: "POST" }))).wake).toBe(false);
		expect((await asJson(await heartbeat("lm-1"))).lm).toBe(1);
		// The streams reply says lm, and the read lists each server's latest positions.
		expect(await read(await streams("lm-1", [{ t: h.now(), s: { positions: positions() } }]))).toEqual({ ok: true, watch: false, lm: true });
		await streams("lm-2", [{ t: h.now(), s: { positions: positions([{ u: 5, n: "Other", st: "none" }]) } }]);
		const map = await read(await admin("/v1/fleet/live-map"));
		expect(map.watchedUntil).toBe(h.now() + LIVE_MAP_WATCH_MS);
		expect(map.servers.map((s: { job: string }) => s.job).filter((j: string) => j.startsWith("lm-")).sort()).toEqual(["lm-1", "lm-2"]);
		expect(map.servers.find((s: { job: string }) => s.job === "lm-1")).toMatchObject({ branch: "prod", artifact: "art-1", at: h.now(), players: [{ u: 101, n: NAME }] });
		// Lapsed after 60 s: no lm; the next watch starts it again (and wakes).
		h.setNow(T0 + LIVE_MAP_WATCH_MS + 1000);
		await heartbeat("lm-1");
		expect((await asJson(await heartbeat("lm-1"))).lm).toBeUndefined();
		expect(await read(await streams("lm-1", [{ t: h.now(), s: { positions: positions() } }]))).toEqual({ ok: true, watch: false, lm: false });
		expect((await read(await admin("/v1/fleet/live-map/watch", { method: "POST" }))).wake).toBe(true);
		await h.app.waker?.idle();
		// The waker's own gap: one live map wake per 30 s, whatever starts it.
		expect(h.app.waker?.wakeLiveMap()).toBe("recent");
		h.setNow(T0 + LIVE_MAP_WATCH_MS + 1000 + LIVE_MAP_WAKE_GAP_MS);
		expect(h.app.waker?.wakeLiveMap()).toBe("sent");
		await h.app.waker?.idle();
		h.setNow(T0);
		// The key never shows in a response or a log line.
		expect(bodies.join("\n")).not.toContain(KEY);
		expect(h.logs.join("\n")).not.toContain(KEY);
	});

	test("roles: the web role reads columns only; no session reads nothing", async () => {
		const web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 78, name: "Viewer 2" }, "web")}` };
		for (const path of ["/v1/fleet/servers/st-1/streams", "/v1/fleet/live-map"]) {
			expect((await h.call(path, { headers: web })).status).toBe(403);
			expect((await h.call(path)).status).toBe(401);
		}
		expect((await h.call("/v1/fleet/live-map/watch", { method: "POST", headers: { ...web, "x-typetorch-csrf": "1" } })).status).toBe(403);
		expect((await h.call("/v1/fleet/columns", { headers: web })).status).toBe(200);
	});

	test("player names and positions never reach the disk or a log line", () => {
		for (const file of filesUnder(h.dir)) {
			const text = readFileSync(file).toString("latin1");
			expect(text.includes(NAME)).toBe(false);
		}
		expect(h.logs.join("\n")).not.toContain(NAME);
	});
});
