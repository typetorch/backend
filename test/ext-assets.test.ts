/**
 * Plans/36 phase 5 and "The clips": the image store (Roblox's public thumbnails API, mocked here: pending -> completed,
 * blocked, 429 backoff, batches of 100, CDN-only downloads, never fetched twice), the animation store and its format,
 * and the routes' gates. No Roblox: every answer is a fake, every id made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnimFormatError, jointsOf, parseAnimExport, rigOf } from "../src/anims/format.ts";
import { animScript, DEFAULT_R6_ANIMATIONS } from "../src/anims/script.ts";
import { AnimStore, installAnimStore, noteAnimationIds } from "../src/anims/store.ts";
import { assetIdOf, BATCH_MAX, CALL_GAP_MS, cdnUrl, ImageStore, installImageStore, noteImageIds, PENDING_BASE_MS, RETRY_BLOCKED_MS, sniff } from "../src/images/store.ts";
import { exportScript } from "../src/maps/script.ts";
import { writeAnimExport } from "./asset-writers.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

/** A fake Roblox: thumbnails answers by id (a state, or a function of the call count), CDN bytes, and a call log. */
interface FakeThumbs {
	states: Record<string, string | ((call: number) => string)>;
	calls: string[][];
	downloads: string[];
	/** The next answers' status (429 / 500), consumed one per call. */
	statuses: number[];
	retryAfter?: string;
	imageUrl?: (id: string) => string;
	body?: Uint8Array;
}

function fakeThumbs(f: FakeThumbs): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.hostname === "thumbnails.roblox.com" && url.pathname === "/v1/assets") {
			const ids = (url.searchParams.get("assetIds") ?? "").split(",");
			expect(url.searchParams.get("size")).toBe("700x700");
			expect(url.searchParams.get("format")).toBe("Png");
			f.calls.push(ids);
			const status = f.statuses.shift();
			if (status) return new Response("{}", { status, headers: f.retryAfter ? { "retry-after": f.retryAfter } : {} });
			const n = f.calls.length;
			const data = ids
				.filter((id) => id in f.states)
				.map((id) => {
					const s = f.states[id] as string | ((call: number) => string);
					const state = typeof s === "function" ? s(n) : s;
					return { targetId: Number(id), state, imageUrl: state === "Completed" ? (f.imageUrl?.(id) ?? `https://tr.rbxcdn.com/fake-${id}/700/700/Image/Png/noFilter`) : null, version: "TN3" };
				});
			return Response.json({ data });
		}
		if (url.hostname.endsWith("rbxcdn.com") || url.hostname === "evil.test") {
			f.downloads.push(url.hostname + url.pathname);
			return new Response((f.body ?? PNG) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } });
		}
		return new Response("not here", { status: 404 });
	}) as typeof fetch;
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "tt-assets-"));
}

describe("asset ids", () => {
	test("Content strings -> asset ids; built-in content and other hosts -> null", () => {
		expect(assetIdOf("rbxassetid://123")).toBe("123");
		expect(assetIdOf("  rbxassetid://00123 ")).toBe("123");
		expect(assetIdOf("123")).toBe("123");
		expect(assetIdOf("http://www.roblox.com/asset/?id=456")).toBe("456");
		expect(assetIdOf("https://www.roblox.com/asset?id=789&version=1")).toBe("789");
		expect(assetIdOf("https://assetdelivery.roblox.com/asset/?ID=42")).toBe("42");
		expect(assetIdOf("rbxthumb://type=Asset&id=55&w=420&h=420")).toBe("55");
		expect(assetIdOf("rbxthumb://type=AvatarHeadShot&id=55&w=420&h=420")).toBeNull();
		expect(assetIdOf("rbxasset://textures/face.png")).toBeNull();
		expect(assetIdOf("https://evil.test/asset/?id=1")).toBeNull();
		expect(assetIdOf("https://roblox.com.evil.test/asset/?id=1")).toBeNull();
		expect(assetIdOf("rbxassetid://abc")).toBeNull();
		expect(assetIdOf("0")).toBeNull();
		expect(assetIdOf("")).toBeNull();
		expect(assetIdOf("1".repeat(21))).toBeNull();
	});

	test("downloads only from a Roblox CDN over https; the type from the bytes", () => {
		expect(cdnUrl("https://tr.rbxcdn.com/abc/700/700/Image/Png")).toBe(true);
		expect(cdnUrl("http://tr.rbxcdn.com/abc")).toBe(false);
		expect(cdnUrl("https://rbxcdn.com.evil.test/abc")).toBe(false);
		expect(cdnUrl("https://user:pw@tr.rbxcdn.com/abc")).toBe(false);
		expect(cdnUrl("https://tr.rbxcdn.com:8443/abc")).toBe(false);
		expect(sniff(PNG)).toBe("png");
		expect(sniff(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
		expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
		expect(sniff(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
	});
});

describe("the image resolver", () => {
	test("pending -> completed: retried with a backoff, downloaded once, stored, never fetched again", async () => {
		const dir = tmp();
		let now = T0;
		const f: FakeThumbs = { states: { "101": (n) => (n === 1 ? "Pending" : "Completed") }, calls: [], downloads: [], statuses: [] };
		const store = new ImageStore({ dataDir: dir, clock: () => now, fetch: fakeThumbs(f), auto: false });
		expect(store.get("101")).toEqual({ state: "pending" });
		await store.drain();
		expect(f.calls).toEqual([["101"]]);
		expect(store.get("101").state).toBe("pending");
		// Too early for the retry: nothing.
		now += PENDING_BASE_MS - 1;
		await store.drain();
		expect(f.calls.length).toBe(1);
		now += 1;
		await store.drain();
		expect(f.calls.length).toBe(2);
		expect(f.downloads).toEqual(["tr.rbxcdn.com/fake-101/700/700/Image/Png/noFilter"]);
		const got = store.get("101");
		expect(got.state).toBe("stored");
		expect(got.state === "stored" && got.type).toBe("png");
		expect(got.state === "stored" && got.bytes).toEqual(PNG);
		// Stored: noting it again or asking again calls nobody.
		expect(store.note(["101", "rbxassetid://101"])).toBe(0);
		now += 60_000;
		await store.drain();
		expect(f.calls.length).toBe(2);
		store.stop();
		// A restart remembers it.
		const again = new ImageStore({ dataDir: dir, clock: () => now, fetch: fakeThumbs(f), auto: false });
		expect(again.get("101").state).toBe("stored");
		expect(again.status()).toMatchObject({ stored: 1, queued: 0 });
		rmSync(dir, { recursive: true, force: true });
	});

	test("blocked and error are final (404 states); asked again only after their age; unknown ids after a few misses", async () => {
		const dir = tmp();
		let now = T0;
		const f: FakeThumbs = { states: { "201": "Blocked", "202": "Error" }, calls: [], downloads: [], statuses: [] };
		const store = new ImageStore({ dataDir: dir, clock: () => now, fetch: fakeThumbs(f), auto: false });
		store.note(["201", "202", "203"]);
		await store.drain();
		expect(store.get("201")).toEqual({ state: "blocked" });
		expect(store.get("202")).toEqual({ state: "error" });
		expect(store.get("203")).toEqual({ state: "pending" });
		for (let i = 0; i < 5; i++) {
			now += 60_000;
			await store.drain();
		}
		expect(store.get("203")).toEqual({ state: "unknown" });
		const calls = f.calls.length;
		expect(store.get("201")).toEqual({ state: "blocked" });
		expect(f.calls.length).toBe(calls);
		now += RETRY_BLOCKED_MS;
		expect(store.get("201")).toEqual({ state: "pending" });
		f.states["201"] = "Completed";
		await store.drain();
		expect(store.get("201").state).toBe("stored");
		rmSync(dir, { recursive: true, force: true });
	});

	test("batches of at most 100 ids, one call a second", async () => {
		const dir = tmp();
		let now = T0;
		const ids = Array.from({ length: 250 }, (_, i) => String(300_000 + i));
		const f: FakeThumbs = { states: Object.fromEntries(ids.map((id) => [id, "Completed"])), calls: [], downloads: [], statuses: [] };
		const store = new ImageStore({ dataDir: dir, clock: () => now, fetch: fakeThumbs(f), auto: false });
		noteImageIds(ids); // no store installed: kept until one is
		installImageStore(store);
		expect(store.status().queued).toBe(250);
		await store.drain();
		expect(f.calls.map((c) => c.length)).toEqual([BATCH_MAX]);
		now += CALL_GAP_MS - 1;
		await store.drain();
		expect(f.calls.length).toBe(1);
		now += 1;
		await store.drain();
		now += CALL_GAP_MS;
		await store.drain();
		expect(f.calls.map((c) => c.length)).toEqual([100, 100, 50]);
		for (let i = 0; i < 100 && store.status().downloading; i++) await store.drain();
		expect(store.status()).toMatchObject({ stored: 250, queued: 0, downloading: 0 });
		installImageStore(null);
		rmSync(dir, { recursive: true, force: true });
	});

	test("429: the loop backs off (Retry-After, then exponentially) and then goes on", async () => {
		const dir = tmp();
		let now = T0;
		const f: FakeThumbs = { states: { "401": "Completed" }, calls: [], downloads: [], statuses: [429, 429], retryAfter: "10" };
		const store = new ImageStore({ dataDir: dir, clock: () => now, fetch: fakeThumbs(f), auto: false });
		store.note(["401"]);
		await store.drain();
		expect(f.calls.length).toBe(1);
		expect(store.status().backoffMs).toBe(10_000);
		now += 9_999;
		await store.drain();
		expect(f.calls.length).toBe(1);
		now += 1;
		await store.drain();
		expect(f.calls.length).toBe(2);
		// Retry-After 10 s again, but the backoff doubled past the base: at least 10 s.
		expect(store.status().backoffMs).toBeGreaterThanOrEqual(10_000);
		now += store.status().backoffMs;
		await store.drain();
		expect(f.calls.length).toBe(3);
		expect(store.get("401").state).toBe("stored");
		expect(store.status().rateLimited).toBe(2);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a URL off the CDN or bytes that aren't an image are never stored", async () => {
		const dir = tmp();
		let now = T0;
		const f: FakeThumbs = { states: { "501": "Completed", "502": "Completed" }, calls: [], downloads: [], statuses: [], imageUrl: (id) => (id === "501" ? "https://evil.test/x.png" : `https://tr.rbxcdn.com/${id}`) };
		const store = new ImageStore({ dataDir: dir, clock: () => now, fetch: fakeThumbs(f), auto: false });
		store.note(["501"]);
		await store.drain();
		expect(store.get("501")).toEqual({ state: "error" });
		expect(f.downloads).toEqual([]);
		f.body = new TextEncoder().encode("<html>not an image</html>");
		store.note(["502"]);
		now += CALL_GAP_MS;
		await store.drain();
		expect(f.downloads).toEqual(["tr.rbxcdn.com/502"]);
		expect(store.get("502")).toEqual({ state: "error" });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("animation clips", () => {
	test("TTAN: clips, failures and skips; weight-0 poses left out; R6 joints named", () => {
		const bytes = writeAnimExport([
			{
				id: "180426354",
				loop: true,
				priority: 1000,
				keyframes: [
					{ t: 0.8, poses: [{ name: "HumanoidRootPart", weight: 0 }, { name: "Torso" }, { name: "Left Leg", q: [0, 0, 0.5, Math.sqrt(0.75)], style: 3, direction: 2 }] },
					{ t: 0, poses: [{ name: "Torso", pos: [0, 0.25, 0] }, { name: "Right Arm" }] },
				],
			},
			{ id: "7", status: "failed", error: "Animation failed to load" },
			{ id: "8", status: "skipped" },
		]);
		const clips = parseAnimExport(bytes);
		expect(clips.map((c) => [c.id, c.status])).toEqual([
			["180426354", "ok"],
			["7", "failed"],
			["8", "skipped"],
		]);
		const ok = clips[0];
		if (ok?.status !== "ok") throw new Error("expected a clip");
		expect(ok.clip).toMatchObject({ id: "180426354", length: 0.8, looped: true, priority: "Core", rig: "R6" });
		expect(ok.clip.keyframes.map((k) => k.t)).toEqual([0, 0.8]);
		expect(Object.keys(ok.clip.keyframes[1]?.poses ?? {})).toEqual(["Torso", "Left Leg"]);
		expect(ok.clip.keyframes[1]?.poses["Left Leg"]?.[2]).toBeCloseTo(0.5, 4);
		expect(ok.clip.keyframes[1]?.easing).toEqual({ "Left Leg": ["Cubic", "InOut"] });
		expect(ok.clip.keyframes[0]?.positions).toEqual({ Torso: [0, 0.25, 0] });
		expect(ok.clip.joints).toEqual({ Torso: "RootJoint", "Left Leg": "Left Hip", "Right Arm": "Right Shoulder" });
		expect(() => parseAnimExport(bytes.subarray(0, bytes.byteLength - 1))).toThrow(AnimFormatError);
		expect(() => parseAnimExport(new Uint8Array([...bytes, 0]))).toThrow("after the last clip");
	});

	test("rigs and joints: R15 by its part names; anything else is other", () => {
		expect(rigOf(["LowerTorso", "UpperTorso", "Head", "LeftUpperArm"])).toBe("R15");
		expect(rigOf(["Head"])).toBe("R15");
		expect(rigOf(["Torso", "Head"])).toBe("R6");
		expect(rigOf(["Tail", "Head"])).toBe("other");
		expect(jointsOf(["LeftFoot", "Head", "Tail"])).toEqual({ LeftFoot: "LeftAnkle", Head: "Neck" });
	});

	test("the scripts: ids as escaped strings, KeyframeSequenceProvider in a pcall; the map export reads decals, textures, variants", () => {
		const script = animScript(["123", "bad id", "456"]);
		expect(script).toContain('local IDS = { "123", "456" }');
		expect(script).toContain("GetKeyframeSequenceAsync");
		expect(script).toContain("pcall(function() return KSP:GetKeyframeSequenceAsync");
		const maps = exportScript({ names: ["Mall"] });
		expect(maps).toContain('child:IsA("Decal")');
		expect(maps).toContain("GetMaterialVariant");
		expect(maps).toContain("GetBaseMaterialOverride");
		expect(maps).toContain("buffer.writeu16(buf, 4, 2)");
	});

	test("every string.pack in the export scripts gets as many values as its format names (a live run caught one short)", () => {
		const packs = (script: string) => {
			const out: { format: string; args: number }[] = [];
			for (let at = script.indexOf("string.pack("); at >= 0; at = script.indexOf("string.pack(", at + 1)) {
				let i = at + "string.pack(".length;
				let depth = 1;
				let commas = 0;
				const start = i;
				for (; i < script.length && depth > 0; i++) {
					const c = script[i];
					if (c === "(" || c === "{") depth++;
					else if (c === ")" || c === "}") depth--;
					else if (c === "," && depth === 1) commas++;
				}
				const format = /^"([^"]*)"/.exec(script.slice(start))?.[1] ?? "";
				out.push({ format, args: commas });
			}
			return out;
		};
		const values = (format: string) => format.replace(/^[<>=!]/, "").replace(/[0-9]+/g, "").length;
		const all = [...packs(animScript(["1"])), ...packs(exportScript({ names: ["Mall"] }))];
		expect(all.length).toBeGreaterThan(8);
		for (const p of all) expect({ format: p.format, values: p.args }).toEqual({ format: p.format, values: values(p.format) });
	});

	test("the store: notes are idempotent, the defaults always wait, a stored clip is never asked again", () => {
		const dir = tmp();
		const store = new AnimStore({ dataDir: dir, clock: () => T0 });
		noteAnimationIds(["rbxassetid://900"]); // before install: handed over
		installAnimStore(store);
		noteAnimationIds(["900", "rbxassetid://901", "not an id"]);
		expect(store.summary().seen).toBe(2);
		const waiting = store.waiting();
		for (const id of Object.keys(DEFAULT_R6_ANIMATIONS)) expect(waiting).toContain(id);
		expect(waiting.slice(-2)).toEqual(["900", "901"]);
		expect(store.clip("900")).toEqual({ state: "pending" });
		installAnimStore(null);
		store.stop();
		rmSync(dir, { recursive: true, force: true });
	});
});

// The routes ---------------------------------------------------------------------------------------------------------------

const UNIVERSE = 5_151_001;
const PLACE = 5_151_002;
const OPEN_CLOUD = "fake-open-cloud-key-for-tests-abcdef0123456789";
const TASK = `universes/${UNIVERSE}/places/${PLACE}/versions/9/luau-execution-sessions/s-1/tasks/t-anim`;

describe("the image and animation routes", () => {
	let h: Harness;
	let off: Harness;
	const VIEWER = 88_001;
	let web: Record<string, string>;
	const f: FakeThumbs = { states: { "601": (n) => (n === 1 ? "Pending" : "Completed"), "602": "Blocked" }, calls: [], downloads: [], statuses: [] };
	const thumbs = fakeThumbs(f);
	const tasks = { scripts: [] as string[], polls: 0 };
	const fake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://games.roblox.com/v1/games?universeIds=")) return Response.json({ data: [{ id: UNIVERSE, rootPlaceId: PLACE, name: "Anim Game", playing: 1 }] });
		if (url.startsWith("https://apis.roblox.com/")) {
			expect(new Headers(init?.headers).get("x-api-key")).toBe(OPEN_CLOUD);
			if (url.endsWith("/luau-execution-session-tasks") && init?.method === "POST") {
				tasks.scripts.push(JSON.parse(String(init.body)).script);
				return Response.json({ path: TASK, state: "QUEUED" });
			}
			if (url === `https://apis.roblox.com/cloud/v2/${TASK}`) {
				tasks.polls++;
				return Response.json({ path: TASK, state: "COMPLETE", output: { results: [JSON.stringify({ placeVersion: 9 })] }, binaryOutputUri: "https://storage.test/anim?sig=secret" });
			}
		}
		if (url.startsWith("https://storage.test/anim")) {
			return new Response(
				writeAnimExport([
					{ id: "180435571", loop: true, keyframes: [{ t: 0, poses: [{ name: "Head" }] }, { t: 1.5, poses: [{ name: "Head", q: [0, 0.1, 0, Math.sqrt(0.99)] }] }] },
					{ id: "700", status: "failed", error: "HTTP 403 (Forbidden) https://assetdelivery.example/x?sig=1" },
				]) as Uint8Array<ArrayBuffer>,
			);
		}
		return thumbs(input, init);
	}) as typeof fetch;

	beforeAll(async () => {
		h = await harness({ TYPETORCH_UNIVERSE_ID: String(UNIVERSE), OPENCLOUD_API_KEY: OPEN_CLOUD, TYPETORCH_WEB_VIEWERS: String(VIEWER) }, { fetch: fake, mapExport: { sleep: async () => {}, pollMs: 1 } });
		off = await harness({}, { fetch: fake });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}`, "x-typetorch": "1", origin: "http://backend.test" };
	});
	afterAll(async () => {
		await h.close();
		await off.close();
	});

	test("images: 202 while resolving, then the PNG with a year-long immutable cache; blocked 404; bad ids 400", async () => {
		const first = await h.call("/v1/images/601", { headers: web });
		expect(first.status).toBe(202);
		expect(await asJson(first)).toEqual({ state: "pending" });
		await h.app.images.drain();
		expect((await h.call("/v1/images/601", { headers: bearer(ADMIN) })).status).toBe(202);
		h.setNow(h.now() + 10_000);
		await h.app.images.drain();
		const got = await h.call("/v1/images/601", { headers: web });
		expect(got.status).toBe(200);
		expect(got.headers.get("content-type")).toBe("image/png");
		expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(got.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);

		expect((await h.call("/v1/images/602", { headers: web })).status).toBe(202);
		h.setNow(h.now() + 2_000);
		await h.app.images.drain();
		const blocked = await h.call("/v1/images/602", { headers: web });
		expect(blocked.status).toBe(404);
		expect(await asJson(blocked)).toEqual({ state: "blocked" });

		for (const bad of ["abc", "0", "12.5", "rbxassetid%3A%2F%2F1"]) expect((await h.call(`/v1/images/${bad}`, { headers: web })).status).toBe(400);
		expect((await h.call("/v1/images/601", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		const status = await asJson(await h.call("/v1/images", { headers: web }));
		expect(status).toMatchObject({ stored: 1, blocked: 1, queued: 0 });
	});

	test("gates: the game key and no key read nothing; viewers can't run the animation pass", async () => {
		for (const path of ["/v1/images/601", "/v1/anims/180435571", "/v1/images", "/v1/anims"]) {
			expect((await h.call(path, { headers: bearer(API) })).status).toBe(401);
			expect((await h.call(path)).status).toBe(401);
		}
		expect((await h.call("/v1/anims/export", { method: "POST", body: "{}", headers: { ...web, "content-type": "application/json" } })).status).toBe(403);
		expect((await h.call("/v1/anims/export", post(API, {}))).status).toBe(401);
		const unconfigured = await off.call("/v1/anims/export", post(ADMIN, {}));
		expect(unconfigured.status).toBe(409);
		expect(tasks.scripts.length).toBe(0);
	});

	test("animations: 404 until exported, the pass (owners, audited) stores clips, failures say why", async () => {
		const before = await h.call("/v1/anims/180435571", { headers: web });
		expect(before.status).toBe(404);
		expect(await asJson(before)).toEqual({ state: "pending" });
		// A url-encoded rbxassetid:// id is noted for the pass.
		expect((await h.call(`/v1/anims/${encodeURIComponent("rbxassetid://700")}`, { headers: web })).status).toBe(404);
		expect((await h.call("/v1/anims/nope", { headers: web })).status).toBe(400);

		const r = await h.call("/v1/anims/export", post(ADMIN, {}));
		expect(r.status).toBe(202);
		expect((await asJson(r)).pass.state).toBe("running");
		await h.app.anims.idle();
		expect(tasks.scripts.length).toBe(1);
		expect(tasks.scripts[0]).toContain('"700"');
		expect(tasks.scripts[0]).toContain('"180435571"');

		const clip = await h.call("/v1/anims/180435571", { headers: web });
		expect(clip.status).toBe(200);
		expect(clip.headers.get("cache-control")).toContain("immutable");
		const body = await asJson(clip);
		expect(body).toMatchObject({ id: "180435571", length: 1.5, looped: true, priority: "Movement", rig: "R15", joints: { Head: "Neck" } });
		expect(body.keyframes.length).toBe(2);
		expect(body.keyframes[1].poses.Head[1]).toBeCloseTo(0.1, 4);
		expect((await asJson(await h.call(`/v1/anims/${encodeURIComponent("rbxassetid://180435571")}`, { headers: web }))).id).toBe("180435571");

		const failed = await asJson(await h.call("/v1/anims/700", { headers: web }));
		expect(failed.state).toBe("failed");
		expect(failed.error).toContain("403");
		expect(failed.error).not.toContain("sig=");

		const summary = await asJson(await h.call("/v1/anims", { headers: web }));
		expect(summary).toMatchObject({ exported: 1, failed: 1, last: { loaded: 1, failed: 1 } });
		expect(summary.defaults.find((d: { id: string }) => d.id === "180435571").exported).toBe(true);

		// Too soon for another pass.
		expect((await h.call("/v1/anims/export", post(ADMIN, {}))).status).toBe(429);
		const audit = await asJson(await h.call("/v1/admin/audit?action=anims.*", { headers: bearer(ADMIN) }));
		const actions = audit.entries.map((e: { action: string; outcome: string }) => `${e.action} ${e.outcome}`);
		expect(actions).toContain("anims.export ok");
		expect(actions).toContain("anims.export.done ok");
	});
});
