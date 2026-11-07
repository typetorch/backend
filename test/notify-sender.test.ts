/**
 * The sender (src/notify/sender.ts) through the notify service on in-memory SQLite, with a fake Roblox (fetch) and a
 * pinned clock: classify, the rate headers and the token bucket, dry runs, real sends and their launch data, S1 / S1b,
 * retries, the lease handover, and the planner + sender together.
 */
import { afterEach, describe, expect, test } from "bun:test";
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

async function setup(o: { answers?: Answer[]; dryRun?: boolean; fleetDb?: string } = {}) {
	const t = { now: T0 };
	const sw = { enabled: true, dryRun: o.dryRun ?? false, rate: 50, clock: "rolling24" as "rolling24" | "utc_day", kinds: {} as Record<string, boolean> };
	const rows: Record<string, any>[] = [];
	const stopped: string[] = [];
	const roblox = fakeRoblox(o.answers);
	const svc = await NotifyService.open({
		fleetDb: o.fleetDb ?? ":memory:",
		dataDir: "/nonexistent-tt-notify-test",
		envKey: KEY,
		apiKey: OPEN_CLOUD,
		universeId: 4242,
		switches: { enabled: () => sw.enabled, dryRun: () => sw.dryRun, rate: () => sw.rate, clock: () => sw.clock, kindEnabled: (k) => sw.kinds[k] !== false },
		stopKind: (k) => {
			stopped.push(k);
			sw.kinds[k] = false;
		},
		pidOf: async (u) => (u === 7 ? "" : `pid-${u}`),
		publish: async (r) => void rows.push(...r),
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
	return { svc, t, sw, rows, named, stopped, roblox, want, nextRev: () => rev++ };
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
		expect(call.body).toMatchObject({ source: { universe: "universes/4242" }, payload: { message_id: "msg-gift", type: "MOMENT", parameters: { gift: { string_value: "5 coins" } } }, analytics_data: { category: "gift" } });
		const nid = s.named("planned")[0].nid;
		const v = verifyToken(call.body.join_experience.launch_data, { current: KEY, since: 1 }, 123456789, Math.floor(s.t.now / 1000));
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
		expect(s.roblox.calls.at(-1)?.body).toMatchObject({ payload: { message_id: "msg-x" }, analytics_data: { category: "msg-x" } });
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
