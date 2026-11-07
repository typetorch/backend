/**
 * The sender (src/notify/sender.ts) through the notify service on in-memory SQLite, with a fake Roblox (fetch) and a
 * pinned clock: classify, the rate headers and the token bucket, dry runs, real sends and their launch data, S1 / S1b,
 * retries, the lease handover, and the planner + sender together.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifyService } from "../src/notify/routes.ts";
import { LEASE_MS, MUTE_MS, TokenBucket, classify, parseRateHeaders, retryAfterMs } from "../src/notify/sender.ts";
import { DUE_SET } from "../src/notify/store.ts";
import { verifyToken } from "../src/notify/token.ts";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const KEY = "k".repeat(43);
const OPEN_CLOUD = "fake-open-cloud-key-for-tests-000";
const CONFIG = {
	kinds: {
		gift: { template: "msg-gift", text: "{gift} is waiting for you", priority: 10, repeat: "per_key", send: "asap" },
		day2: { template: "msg-day2", priority: 30, repeat: "once_ever", send: "asap" },
		draft: { priority: 50, repeat: "daily", send: "asap" },
	},
};

interface Call {
	url: string;
	headers: Headers;
	body: Record<string, any>;
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeRoblox(answers: Answer[] = []) {
	const calls: Call[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		const a = answers.shift() ?? { status: 200, body: { path: "users/1/notifications/abc", id: `roblox-${calls.length}` } };
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { "x-ratelimit-limit": "4000, 4000;w=1, 4000;w=1", "x-ratelimit-remaining": "3999", "x-ratelimit-reset": "1", ...a.headers } });
	}) as typeof fetch;
	return { calls, fetch: fetchImpl };
}

const open: NotifyService[] = [];
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
});

async function setup(o: { answers?: Answer[]; dryRun?: boolean; fleetDb?: string; publish?: "published" | "unavailable" | "off"; now?: number } = {}) {
	const t = { now: o.now ?? T0 };
	const sw = { enabled: true, dryRun: o.dryRun ?? false, rate: 50, clock: "rolling24" as "rolling24" | "utc_day", kinds: {} as Record<string, boolean>, stale: 6, publish: (o.publish ?? "published") as "published" | "unavailable" | "off" };
	const stoppedAll: string[] = [];
	const rows: Record<string, any>[] = [];
	const stopped: string[] = [];
	const roblox = fakeRoblox(o.answers);
	const svc = await NotifyService.open({
		fleetDb: o.fleetDb ?? ":memory:",
		dataDir: "/nonexistent-tt-notify-test",
		envKey: KEY,
		apiKey: OPEN_CLOUD,
		universeId: 4242,
		switches: { enabled: () => sw.enabled, dryRun: () => sw.dryRun, rate: () => sw.rate, clock: () => sw.clock, kindEnabled: (k) => sw.kinds[k] !== false, presenceStaleHours: () => sw.stale },
		stopKind: (k) => {
			stopped.push(k);
			sw.kinds[k] = false;
		},
		stopAll: (why) => {
			stoppedAll.push(why);
			sw.enabled = false;
		},
		pidOf: async (u) => (u === 7 ? "" : `pid-${u}`),
		publish: async (r) => {
			if (sw.publish === "published") rows.push(...r);
			return sw.publish;
		},
		clock: () => t.now,
		random: () => 0.5,
		fetch: roblox.fetch,
		sleep: async (ms) => void (t.now += ms),
		log: () => {},
	});
	open.push(svc);
	expect((await svc.putConfig(CONFIG, "test")).status).toBe(200);
	let rev = 1;
	const want = async (u: number, k: string, extra: Record<string, unknown> = {}) => svc.intents({ v: 1, items: [{ op: "want", u, k, rev: rev++, ...(k === "gift" ? { params: { gift: "5 coins" } } : {}), ...extra }] });
	const named = (name: string) => rows.filter((r) => r.name === name).map((r) => ({ pid: r.pid, ...JSON.parse(r.props) }));
	return { svc, t, sw, rows, named, stopped, stoppedAll, roblox, want, nextRev: () => rev++ };
}

describe("classify", () => {
	test.each([
		[200, {}, "ok"],
		[201, {}, "ok"],
		[400, { code: "FAILED_PRECONDITION", message: "User 1 is not opted in to receive notifications for your experience 2." }, "not_subscribed"],
		[400, { code: "FAILED_PRECONDITION", message: "something else" }, "fatal"],
		[404, { code: "NOT_FOUND", message: "Message id abc does not exist." }, "bad_template"],
		[404, { code: "NOT_FOUND", message: "User not found" }, "fatal"],
		[429, { code: "RESOURCE_EXHAUSTED", message: "Too many requests" }, "rate_limited"],
		[429, { code: "RESOURCE_EXHAUSTED", message: "You can only send 1 notification per recipient per day." }, "daily_limit"],
		[429, { code: "RESOURCE_EXHAUSTED", message: "Recipient throttle reached" }, "daily_limit"],
		[429, { code: "TOO_MANY_REQUESTS", message: "1 notification per recipient" }, "rate_limited"],
		[0, {}, "retry"],
		[408, {}, "retry"],
		[500, {}, "retry"],
		[503, "not json", "retry"],
		[401, { code: "UNAUTHENTICATED" }, "fatal"],
		[403, { code: "PERMISSION_DENIED" }, "fatal"],
	])("HTTP %d %j -> %s", (http, body, outcome) => {
		expect(classify(http as number, body)).toBe(outcome as ReturnType<typeof classify>);
	});

	test("Retry-After: seconds or an HTTP date", () => {
		expect(retryAfterMs("12", T0)).toBe(12_000);
		expect(retryAfterMs(new Date(T0 + 30_000).toUTCString(), T0)).toBe(30_000);
		expect(retryAfterMs("soon", T0)).toBe(0);
		expect(retryAfterMs(null, T0)).toBe(0);
	});

	test("S2 rate headers", () => {
		const h = (o: Record<string, string>) => parseRateHeaders((n) => o[n] ?? null);
		expect(h({ "x-ratelimit-limit": "4000, 4000;w=1, 4000;w=1", "x-ratelimit-remaining": "3998", "x-ratelimit-reset": "1" })).toEqual({ limit: 4000, windowMs: 1000, remaining: 3998, resetMs: 1000 });
		expect(h({ "x-ratelimit-limit": "600;w=60" })).toEqual({ limit: 600, windowMs: 60_000 });
		expect(h({ "x-ratelimit-remaining": "-1", "x-ratelimit-reset": "x" })).toEqual({});
	});
});

describe("token bucket", () => {
	test("our ceiling, Roblox's window (remaining 0 waits for the reset), 429 halving, Retry-After, 10 % a minute back", () => {
		const t = { now: T0 };
		const b = new TokenBucket(() => 10, () => t.now);
		let taken = 0;
		while (b.take() === 0) taken++;
		expect(taken).toBe(10);
		t.now += 1000;
		expect(b.take()).toBe(0);
		// Roblox: 4000 / s, but 1 left in this window: one more, then wait for the reset.
		b.onHeaders({ limit: 4000, windowMs: 1000, remaining: 1, resetMs: 800 });
		t.now += 1000;
		expect(b.view().robloxRate).toBe(4000);
		b.onHeaders({ remaining: 1, resetMs: 800 });
		expect(b.take()).toBe(0);
		expect(b.take()).toBe(800);
		t.now += 800;
		expect(b.take()).toBe(0);
		// A 429 with Retry-After 5 s: blocked 5 s, then at half the rate.
		b.on429(5000);
		expect(b.view().rate).toBe(5);
		expect(b.take()).toBe(5000);
		t.now += 5000;
		expect(b.take()).toBe(0);
		t.now += 60_000;
		expect(b.view().rate).toBe(5.5);
		t.now += 10 * 60_000;
		expect(b.view().rate).toBe(10);
		// Roblox's limit below ours wins.
		b.onHeaders({ limit: 2, windowMs: 1000 });
		expect(b.view().rate).toBe(2);
	});
});

describe("sends", () => {
	test("dry run: planned, `dry`, a sent row with dry: true, never a POST; it counts for the day cap", async () => {
		const s = await setup({ dryRun: true });
		expect((await s.want(100, "gift", { key: "letter-1", data: "mail:1" })).body).toMatchObject({ accepted: 1, rejected: [] });
		await s.svc.planTick();
		const [planned] = s.named("planned");
		expect(planned).toMatchObject({ pid: "pid-100", k: "gift", why: "asap" });
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
		expect(s.named("sent")).toEqual([{ pid: "pid-100", nid: planned.nid, k: "gift", try: 1, category: "gift", dry: true }]);
		expect((await s.svc.store.send(planned.nid))?.status).toBe("dry");
		// A second gift the same day waits for the day cap.
		await s.want(100, "gift", { key: "letter-2" });
		await s.svc.planTick();
		expect(s.named("skipped")).toEqual([{ pid: "pid-100", k: "gift", why: "capped_day" }]);
		// Rows: kind notify, src backend, no sid, never the UserId.
		for (const r of s.rows) expect([r.kind, r.src, r.sid, r.job, JSON.stringify(r).includes("100,")]).toEqual(["notify", "backend", "", "backend", false]);
	});

	test("a kind without a template is planned and dry-run only", async () => {
		const s = await setup();
		await s.want(5, "draft");
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
		expect(s.named("sent")[0]).toMatchObject({ k: "draft", dry: true });
	});

	test("a real send: the Open Cloud request, signed launch data, optin_inferred subscribed once, per_key afterwards", async () => {
		const s = await setup();
		await s.want(123456789, "gift", { key: "letter-1", data: "mail:42" });
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(1);
		const call = s.roblox.calls[0] as Call;
		expect(call.url).toBe("https://apis.roblox.com/cloud/v2/users/123456789/notifications");
		expect(call.headers.get("x-api-key")).toBe(OPEN_CLOUD);
		expect(call.body).toMatchObject({ source: { universe: "universes/4242" }, payload: { message_id: "msg-gift", type: "MOMENT", parameters: { gift: { string_value: "5 coins" } }, analytics_data: { category: "gift" } } });
		// joinExperience / analyticsData belong inside payload (UserNotification_Payload): at the top level Roblox drops them
		expect(call.body.join_experience).toBeUndefined();
		expect(call.body.analytics_data).toBeUndefined();
		const nid = s.named("planned")[0].nid;
		const v = verifyToken(call.body.payload.join_experience.launch_data, { current: KEY, since: 1 }, 123456789, Math.floor(s.t.now / 1000));
		expect(v).toMatchObject({ ok: true, nid, kind: "gift", data: "mail:42" });
		expect(s.named("optin_inferred")).toEqual([{ pid: "pid-123456789", state: "subscribed" }]);
		expect(s.named("sent")).toEqual([{ pid: "pid-123456789", nid, k: "gift", try: 1, roblox_id: "roblox-1", category: "gift" }]);
		expect((await s.svc.store.intent(123456789, "gift", "letter-1"))?.status).toBe("sent");
		// The same key again a day later: superseded (per_key), nothing sent.
		s.t.now += 2 * 86_400_000;
		await s.want(123456789, "gift", { key: "letter-1" });
		await s.svc.planTick();
		expect((await s.svc.store.intent(123456789, "gift", "letter-1"))?.status).toBe("superseded");
		expect(s.named("skipped").at(-1)).toEqual({ pid: "pid-123456789", k: "gift", why: "repeat" });
		// Opens: first, then repeat; another user's nid is unknown.
		expect((await s.svc.opened({ nid, u: 123456789 })).body).toEqual({ state: "first" });
		expect((await s.svc.opened({ nid, u: 123456789 })).body).toEqual({ state: "repeat" });
		expect((await s.svc.opened({ nid, u: 5 })).body).toEqual({ state: "unknown" });
		expect((await s.svc.played({ nid, u: 123456789, secs: 300 })).body).toEqual({ ok: true });
		expect((await s.svc.store.send(nid))?.played_secs).toBe(300);
	});

	test("S1: not opted in -> muted 7 days, optin_inferred not_subscribed, failed final, no retry", async () => {
		const s = await setup({ answers: [{ status: 400, body: { code: "FAILED_PRECONDITION", message: "User 9 is not opted in to receive notifications for your experience 4242." } }] });
		await s.want(9, "day2");
		await s.svc.planTick();
		await s.svc.sendTick();
		const user = await s.svc.store.user(9);
		expect([Number(user?.mute_until), user?.optin]).toEqual([s.t.now + MUTE_MS, "not_subscribed"]);
		expect(s.named("optin_inferred")).toEqual([{ pid: "pid-9", state: "not_subscribed" }]);
		expect(s.named("failed")).toEqual([{ pid: "pid-9", nid: s.named("planned")[0].nid, k: "day2", http: 400, code: "not_subscribed", final: true }]);
		s.t.now += 3600_000;
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(1);
		expect((await s.svc.store.intent(9, "day2", ""))?.status).toBe("pending");
	});

	test("S1b: a template that doesn't exist halts the kind, never mutes the user, keeps the intent; back on = sent", async () => {
		const s = await setup({ answers: [{ status: 404, body: { code: "NOT_FOUND", message: "Message id msg-gift does not exist." } }] });
		await s.want(11, "gift", { key: "a" });
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.stopped).toEqual(["gift"]);
		expect(s.named("failed")[0]).toMatchObject({ k: "gift", http: 404, code: "bad_template", final: true });
		expect(s.named("optin_inferred")).toEqual([{ pid: "pid-11", state: "subscribed" }]);
		const user = await s.svc.store.user(11);
		expect([user?.mute_until ?? null, user?.optin]).toEqual([null, "subscribed"]);
		expect((await s.svc.store.intent(11, "gift", "a"))?.status).toBe("pending");
		const status = (await s.svc.status()).body as Record<string, any>;
		expect(status.kinds.find((k: { kind: string }) => k.kind === "gift")).toMatchObject({ enabled: false, halted: "bad_template", text: "{gift} is waiting for you" });
		expect(status.halted).toEqual([{ kind: "gift", why: "bad_template", at: T0 }]);
		// Halted: nothing planned for the kind.
		s.t.now += 60_000;
		await s.svc.planTick();
		expect(s.named("planned")).toHaveLength(1);
		// The owner fixes it and turns the kind back on: the same intent goes out.
		s.sw.kinds.gift = true;
		await s.svc.clearHalts(["gift"]);
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(2);
		expect((await s.svc.store.intent(11, "gift", "a"))?.status).toBe("sent");
	});

	test("retries: network / 5xx at 30 s, 2 min, 8 min, then failed final", async () => {
		const s = await setup({ answers: [{ status: 503 }, { status: 0 as number }, { status: 500 }, { status: 502 }] });
		await s.want(12, "day2");
		await s.svc.planTick();
		const nid = s.named("planned")[0].nid;
		await s.svc.sendTick();
		for (const delay of [30_000, 120_000, 480_000]) {
			expect(await s.svc.durable.zscore(DUE_SET, nid)).toBe(s.t.now + delay);
			s.t.now += delay - 1;
			await s.svc.sendTick();
			s.t.now += 1;
			await s.svc.sendTick();
		}
		expect(s.roblox.calls).toHaveLength(4);
		expect(s.named("failed").map((f) => [f.http, f.final])).toEqual([
			[503, false],
			[0, false],
			[500, false],
			[502, true],
		]);
		expect((await s.svc.store.send(nid))?.status).toBe("failed");
		expect(await s.svc.durable.zscore(DUE_SET, nid)).toBeUndefined();
	});

	test("daily_limit: failed final, re-planned for the user's next day, the bucket untouched", async () => {
		const s = await setup({ answers: [{ status: 429, body: { code: "RESOURCE_EXHAUSTED", message: "Only 1 notification per recipient per day" } }] });
		await s.want(21, "day2");
		await s.svc.planTick();
		const nid = s.named("planned")[0].nid;
		await s.svc.sendTick();
		expect(s.svc.sender.bucket.view()).toMatchObject({ rate: 50, last429At: null });
		expect(s.named("failed")).toEqual([{ pid: "pid-21", nid, k: "day2", http: 429, code: "daily_limit", final: true }]);
		expect(await s.svc.durable.zscore(DUE_SET, nid)).toBeUndefined();
		expect((await s.svc.store.intent(21, "day2", ""))?.status).toBe("pending");
		s.t.now += 23 * 3600_000;
		await s.svc.planTick();
		expect(s.named("planned")).toHaveLength(1);
		s.t.now += 3600_000;
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(2);
		expect((await s.svc.store.intent(21, "day2", ""))?.status).toBe("sent");
	});

	test("429: the bucket halves, the retry waits for Retry-After", async () => {
		const s = await setup({ answers: [{ status: 429, body: { code: "RESOURCE_EXHAUSTED" }, headers: { "retry-after": "300" } }] });
		await s.want(13, "day2");
		await s.svc.planTick();
		const nid = s.named("planned")[0].nid;
		await s.svc.sendTick();
		expect(s.svc.sender.bucket.view()).toMatchObject({ rate: 25, last429At: T0 });
		expect(await s.svc.durable.zscore(DUE_SET, nid)).toBe(T0 + 300_000);
	});

	test("lease handover: a crashed worker's send comes back after the lease and goes out once", async () => {
		const s = await setup();
		await s.want(14, "day2");
		await s.svc.planTick();
		// A worker leases it and dies before sending.
		expect(await s.svc.durable.lease(DUE_SET, s.t.now, LEASE_MS, 10)).toHaveLength(1);
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
		s.t.now += LEASE_MS;
		await s.svc.sendTick();
		await s.svc.sendTick();
		s.t.now += LEASE_MS * 2;
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(1);
		expect(s.named("sent")).toHaveLength(1);
	});

	test("checked again at send time: online -> cancelled; a drop cancels a planned send", async () => {
		const s = await setup();
		await s.want(15, "day2");
		await s.svc.planTick();
		await s.svc.intents({ v: 1, items: [{ op: "presence", u: 15, online: true, at: Math.floor(s.t.now / 1000) }] });
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
		expect(s.named("skipped")).toEqual([{ pid: "pid-15", k: "day2", why: "online" }]);
		// Another user: planned for later (a preferred-hour kind), then dropped.
		await s.svc.putConfig({ kinds: { ...CONFIG.kinds, day2: { template: "msg-day2", priority: 30, repeat: "once_ever" } } }, "test");
		await s.want(16, "day2");
		await s.svc.planTick();
		const nid = s.named("planned").at(-1).nid;
		expect(await s.svc.durable.zscore(DUE_SET, nid)).toBe(Date.UTC(2026, 10, 9, 17));
		await s.svc.intents({ v: 1, items: [{ op: "drop", u: 16, k: "day2", rev: s.nextRev() }] });
		expect((await s.svc.store.send(nid))?.status).toBe("cancelled");
		expect(s.named("skipped").at(-1)).toEqual({ pid: "pid-16", k: "day2", why: "dropped" });
		expect((await s.svc.store.user(16))?.busy).toBeNull();
	});

	test("quiet after leaving: nothing for 2 h after the session ends", async () => {
		const s = await setup();
		await s.svc.intents({ v: 1, items: [{ op: "presence", u: 17, online: false, at: Math.floor(s.t.now / 1000) - 600 }] });
		await s.want(17, "day2");
		await s.svc.planTick();
		expect(s.named("skipped")).toEqual([{ pid: "pid-17", k: "day2", why: "quiet" }]);
		s.t.now += 110 * 60_000;
		await s.svc.planTick();
		expect(s.named("planned")).toHaveLength(1);
	});

	test("test sends bypass the caps; one-off sends respect the day cap and the mute", async () => {
		const s = await setup();
		await s.want(18, "day2");
		await s.svc.planTick();
		await s.svc.sendTick();
		const t = await s.svc.test({ userId: 18, kind: "gift", params: { gift: "x" } });
		expect(t.body).toMatchObject({ status: "planned" });
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(2);
		expect(s.named("sent").at(-1)).toMatchObject({ k: "gift", test: true });
		expect((await s.svc.send({ userId: 18, template: "msg-x" })).body).toEqual({ skipped: "capped_day" });
		const ok = await s.svc.send({ userId: 19, template: "msg-x", data: "x" });
		expect(ok.body).toMatchObject({ status: "planned" });
		await s.svc.sendTick();
		expect(s.roblox.calls.at(-1)?.body).toMatchObject({ payload: { message_id: "msg-x", analytics_data: { category: "msg-x" } } });
		expect((await s.svc.test({ userId: 18, kind: "gift" })).status).toBe(400);
	});

	test("erasure removes the user everywhere", async () => {
		const s = await setup();
		await s.want(20, "gift", { key: "a" });
		await s.svc.planTick();
		expect(await s.svc.eraseUser(20)).toBeGreaterThanOrEqual(3);
		expect(await s.svc.store.user(20)).toBeUndefined();
		expect(await s.svc.store.pendingIntents(20)).toEqual([]);
		expect(await s.svc.durable.zcount(DUE_SET, 0, Number.MAX_SAFE_INTEGER)).toBe(0);
	});
});

describe("prefs: the player's switched-off kinds", () => {
	const prefs = (s: Awaited<ReturnType<typeof setup>>, u: number, off: string[], rev = s.nextRev()) => s.svc.intents({ v: 1, items: [{ op: "prefs", u, off, rev }] });

	test("an off kind is skipped (pref_off) but kept; switched back on, it goes out while its window is open", async () => {
		const s = await setup();
		expect((await prefs(s, 30, ["gift", "gift", "day2"])).body).toMatchObject({ accepted: 1, rejected: [], stale: 0 });
		expect(await s.svc.store.prefsOff(30)).toEqual(["day2", "gift"]);
		await s.want(30, "gift", { key: "letter-1" });
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
		expect(s.named("planned")).toEqual([]);
		expect(s.named("skipped")).toEqual([{ pid: "pid-30", k: "gift", why: "pref_off" }]);
		expect((await s.svc.store.intent(30, "gift", "letter-1"))?.status).toBe("pending");
		// The next ticks don't repeat the row (the user is looked at again when the window ends or the prefs change).
		s.t.now += 60_000;
		await s.svc.planTick();
		expect(s.named("skipped")).toHaveLength(1);
		// Back on (a newer rev, `gift` no longer listed): planned at once and sent.
		await prefs(s, 30, ["day2"]);
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.named("planned")).toHaveLength(1);
		expect(s.roblox.calls).toHaveLength(1);
		expect((await s.svc.store.intent(30, "gift", "letter-1"))?.status).toBe("sent");
	});

	test("ordered by rev: an older prefs item is stale and changes nothing", async () => {
		const s = await setup();
		const newer = s.nextRev() + 10;
		await prefs(s, 31, ["gift"], newer);
		expect((await prefs(s, 31, [], newer - 1)).body).toMatchObject({ accepted: 1, stale: 1 });
		expect((await prefs(s, 31, [], newer)).body).toMatchObject({ stale: 1 });
		expect(await s.svc.store.prefsOff(31)).toEqual(["gift"]);
		// An empty list replaces the set: everything on again.
		await prefs(s, 31, [], newer + 1);
		expect(await s.svc.store.prefsOff(31)).toEqual([]);
	});

	test("switching a kind off cancels its send still planned for later; the intent stays pending", async () => {
		const s = await setup();
		await s.svc.putConfig({ kinds: { ...CONFIG.kinds, day2: { template: "msg-day2", priority: 30, repeat: "once_ever" } } }, "test");
		await s.want(32, "day2");
		await s.svc.planTick();
		const nid = s.named("planned").at(-1).nid;
		await prefs(s, 32, ["day2"]);
		expect((await s.svc.store.send(nid))?.status).toBe("cancelled");
		expect(s.named("skipped")).toEqual([{ pid: "pid-32", k: "day2", why: "pref_off" }]);
		expect(await s.svc.store.intent(32, "day2", "")).toMatchObject({ status: "pending", nid: null });
		expect((await s.svc.store.user(32))?.busy).toBeNull();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
	});

	test("checked again at send time: a kind switched off after planning is cancelled, not sent", async () => {
		const s = await setup();
		await s.want(33, "day2");
		await s.svc.planTick();
		// As if the prefs landed while the send was leased (apply leaves a leased send to its holder).
		await s.svc.store.db.run("INSERT INTO notify_prefs (user_id, off, rev, updated) VALUES (33, '[\"day2\"]', 1, 0)");
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(0);
		expect(s.named("skipped")).toEqual([{ pid: "pid-33", k: "day2", why: "pref_off" }]);
		expect((await s.svc.store.intent(33, "day2", ""))?.status).toBe("pending");
	});

	test("test sends bypass prefs; custom sends are unaffected", async () => {
		const s = await setup();
		await prefs(s, 34, ["gift", "day2"]);
		expect((await s.svc.test({ userId: 34, kind: "gift", params: { gift: "x" } })).body).toMatchObject({ status: "planned" });
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(1);
		await prefs(s, 35, ["custom", "gift"]);
		expect((await s.svc.send({ userId: 35, template: "msg-x" })).body).toMatchObject({ status: "planned" });
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(2);
	});

	test("the per-player view shows the off kinds; erasure removes them", async () => {
		const s = await setup();
		expect((await s.svc.userView(36)).prefs).toBeNull();
		await prefs(s, 36, ["gift"]);
		const view = await s.svc.userView(36);
		expect(view).toMatchObject({ known: true, prefs: { off: ["gift"], updated: T0 } });
		await s.svc.eraseUser(36);
		expect(await s.svc.store.prefs(36)).toBeUndefined();
	});
});

describe("review fixes (backend#23)", () => {
	const presence = (s: Awaited<ReturnType<typeof setup>>, u: number, online: boolean, at: number) => s.svc.intents({ v: 1, items: [{ op: "presence", u, online, at }] });

	test("presence goes stale after notify.presenceStaleHours; at in ms (seconds still read); a tie: online wins", async () => {
		const s = await setup();
		// ms
		await presence(s, 30, true, T0);
		await s.want(30, "day2");
		await s.svc.planTick();
		expect(s.named("skipped")).toEqual([{ pid: "pid-30", k: "day2", why: "online" }]);
		expect(Number((await s.svc.store.user(30))?.next_check)).toBe(T0 + 6 * 3600_000);
		// No refresh for 6 h: no longer online, the send goes.
		s.t.now = T0 + 6 * 3600_000;
		await s.svc.planTick();
		expect(s.named("planned")).toHaveLength(1);
		// Seconds still read; leave and join at the same instant: online wins.
		await presence(s, 31, true, Math.floor(T0 / 1000));
		expect(Number((await s.svc.store.user(31))?.presence_at)).toBe(T0);
		await presence(s, 31, false, T0);
		expect(Number((await s.svc.store.user(31))?.online)).toBe(1);
		await presence(s, 32, false, T0);
		await presence(s, 32, true, T0);
		expect(Number((await s.svc.store.user(32))?.online)).toBe(1);
	});

	test("dry run keeps the intent pending: the caps count the dry row, the real send goes once dry run is off (once_ever too)", async () => {
		const s = await setup({ dryRun: true });
		await s.want(33, "day2");
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.named("sent")[0]).toMatchObject({ k: "day2", dry: true });
		expect((await s.svc.store.intent(33, "day2", ""))?.status).toBe("pending");
		// Same day: the dry row holds the day cap.
		s.t.now += 3600_000;
		await s.svc.planTick();
		expect(s.named("planned")).toHaveLength(1);
		s.sw.dryRun = false;
		s.t.now = T0 + 24 * 3600_000 + 1000;
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(1);
		expect((await s.svc.store.intent(33, "day2", ""))?.status).toBe("sent");
	});

	test("the unopened backoff starts after `after` unopened real sends", async () => {
		const s = await setup();
		await s.svc.putConfig({ lapse: [[60, 7]], unopenedBackoff: { after: 2, factor: 0.5, days: 14 }, kinds: CONFIG.kinds }, "test");
		for (let i = 0; i < 2; i++) {
			await s.want(34, "gift", { key: `g${i}` });
			await s.svc.planTick();
			await s.svc.sendTick();
			s.t.now += 25 * 3600_000;
		}
		const u = await s.svc.store.user(34);
		expect([Number(u?.unopened), Number(u?.backoff_at)]).toEqual([2, T0 + 25 * 3600_000]);
		// An open ends it.
		await s.svc.opened({ nid: s.named("planned")[1].nid, u: 34 });
		expect((await s.svc.store.user(34))?.backoff_at).toBeNull();
	});

	test("priority: a want that outranks a send still planned for later cancels it and goes now", async () => {
		const s = await setup();
		await s.svc.putConfig({ kinds: { ...CONFIG.kinds, daily: { template: "msg-daily", priority: 70, repeat: "daily", send: "preferred_hour" }, gift_expiring: { template: "msg-exp", priority: 20, repeat: "per_key", send: "asap" } } }, "test");
		s.t.now = Date.UTC(2026, 10, 9, 18);
		await s.want(35, "daily", { key: "d1" });
		await s.svc.planTick();
		const daily = s.named("planned")[0];
		expect(daily.for).toBe(Date.UTC(2026, 10, 10, 17) / 1000);
		await s.want(35, "gift_expiring", { key: "e1" });
		expect((await s.svc.store.send(daily.nid))?.status).toBe("cancelled");
		expect(s.named("skipped")).toEqual([{ pid: "pid-35", k: "daily", why: "outranked" }]);
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls.map((c) => c.body.payload.message_id)).toEqual(["msg-exp"]);
		expect((await s.svc.store.intent(35, "daily", "d1"))?.status).toBe("pending");
	});

	test("the outbox: rows survive a crash before the publish and go out once, later", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-notify-outbox-"));
		try {
			const fleetDb = join(dir, "fleet.sqlite");
			const a = await setup({ fleetDb, publish: "unavailable" });
			await a.want(36, "day2");
			await a.svc.planTick();
			await a.svc.sendTick();
			expect(a.rows).toEqual([]);
			expect(await a.svc.store.outboxCount()).toBe(3);
			// "Crash": the process goes away with the rows unpublished (close keeps them: analytics unavailable).
			await a.svc.close();
			open.splice(open.indexOf(a.svc), 1);
			const b = await setup({ fleetDb, publish: "published", now: a.t.now });
			// planned, optin_inferred, sent
			expect(await b.svc.flushRows()).toBe(3);
			expect(await b.svc.flushRows()).toBe(0);
			expect(b.named("planned")).toHaveLength(1);
			expect(b.named("sent")).toHaveLength(1);
			expect(await b.svc.store.outboxCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("401 / 403: every send stops (kind-less halted entry), nobody is muted; turning notifications back on resumes", async () => {
		// Both sends were already on their way (4 workers): both refused, nothing more leaves after.
		const refused = { status: 403, body: { code: "PERMISSION_DENIED", message: "scope" } };
		const s = await setup({ answers: [refused, refused] });
		await s.want(37, "day2");
		await s.want(38, "gift", { key: "a" });
		await s.svc.planTick();
		await s.svc.sendTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(2);
		expect(s.stoppedAll).toEqual(["auth"]);
		const status = (await s.svc.status()).body as Record<string, any>;
		expect(status.halted).toContainEqual({ why: "auth", at: T0 });
		expect(status.haltedAll).toEqual({ why: "auth", at: T0 });
		for (const u of [37, 38]) expect([(await s.svc.store.user(u))?.mute_until ?? null, (await s.svc.store.intent(u, u === 37 ? "day2" : "gift", u === 37 ? "" : "a"))?.status]).toEqual([null, "pending"]);
		// The owner fixes the key and turns notifications back on.
		s.sw.enabled = true;
		expect(await s.svc.resume()).toBe(true);
		s.t.now += 60_000;
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls).toHaveLength(4);
	});

	test("a 400 other than not-opted-in fails that intent for good (no re-plan)", async () => {
		const s = await setup({ answers: [{ status: 400, body: { code: "INVALID_ARGUMENT", message: "bad parameter" } }] });
		await s.want(39, "day2");
		await s.svc.planTick();
		await s.svc.sendTick();
		expect((await s.svc.store.intent(39, "day2", ""))?.status).toBe("failed");
		expect(s.named("failed")[0]).toMatchObject({ http: 400, code: "INVALID_ARGUMENT", final: true });
		s.t.now += 2 * 86_400_000;
		await s.svc.planTick();
		expect(s.named("planned")).toHaveLength(1);
	});

	test("dup_refused: a retry Roblox refuses as over the per-recipient limit counts as delivered", async () => {
		const s = await setup({ answers: [{ status: 503 }, { status: 429, body: { code: "RESOURCE_EXHAUSTED", message: "1 notification per recipient" } }] });
		await s.want(40, "day2");
		await s.svc.planTick();
		await s.svc.sendTick();
		s.t.now += 30_000;
		await s.svc.sendTick();
		const nid = s.named("planned")[0].nid;
		expect(await s.svc.store.send(nid)).toMatchObject({ status: "sent", code: "dup_refused" });
		expect((await s.svc.store.intent(40, "day2", ""))?.status).toBe("sent");
		expect(s.svc.sender.bucket.view().last429At).toBeNull();
		expect(s.named("failed").at(-1)).toMatchObject({ code: "dup_refused", final: true });
	});

	test("roblox_id is Roblox's id only, never the path (it names the user)", async () => {
		const s = await setup({ answers: [{ status: 200, body: { path: "users/41/notifications/abc" } }] });
		await s.want(41, "day2");
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.named("sent")[0].roblox_id).toBe("");
		expect((await s.svc.store.send(s.named("planned")[0].nid))?.roblox_id).toBe("");
	});

	test("allowTemplate: a game-supplied template that doesn't exist halts that template only", async () => {
		const s = await setup({ answers: [{ status: 404, body: { code: "NOT_FOUND", message: "Message id game-t does not exist." } }] });
		await s.svc.putConfig({ kinds: { ...CONFIG.kinds, promo: { template: "msg-promo", priority: 40, repeat: "per_key", send: "asap", allowTemplate: true } } }, "test");
		await s.want(42, "promo", { key: "a", template: "game-t" });
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.stopped).toEqual([]);
		const status = (await s.svc.status()).body as Record<string, any>;
		expect(status.haltedTemplates).toEqual([{ template: "game-t", at: T0 }]);
		expect(status.kinds.find((k: { kind: string }) => k.kind === "promo").enabled).toBe(true);
		// Another user with the kind's own template still gets theirs; the halted template's intent waits.
		await s.want(43, "promo", { key: "b" });
		s.t.now += 25 * 3600_000;
		await s.svc.planTick();
		await s.svc.sendTick();
		expect(s.roblox.calls.map((c) => [c.url.split("/")[6], c.body.payload.message_id])).toEqual([
			["42", "game-t"],
			["43", "msg-promo"],
		]);
		expect((await s.svc.store.intent(42, "promo", "a"))?.status).toBe("pending");
	});

	test("prune: users unseen 180 days with nothing pending go; one with a pending intent stays; erasure takes the outbox too", async () => {
		const s = await setup({ publish: "unavailable" });
		await presence(s, 44, false, T0 - 200 * 86_400_000);
		await presence(s, 45, false, T0 - 200 * 86_400_000);
		await s.want(45, "day2", { until: Math.floor(T0 / 1000) + 86_400 });
		expect((await s.svc.prune()).users).toBe(1);
		expect(await s.svc.store.user(44)).toBeUndefined();
		expect(await s.svc.store.user(45)).toBeDefined();
		await s.svc.planTick();
		expect(await s.svc.store.outboxCount()).toBeGreaterThan(0);
		await s.svc.eraseUser(45);
		expect(await s.svc.store.outboxCount()).toBe(0);
	});
});
