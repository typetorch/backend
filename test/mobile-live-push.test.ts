/**
 * The mobile app's live numbers and push (mobile docs PUSH_WATCH_WIDGETS.md, section 1): the CCU milestone rule's state
 * machine, the CCU history, GET /v1/mobile/live (its shape, its auth, aggregates only), the push registration's
 * lifecycle (register, replace, test push, logout / revoke / revoke all / expiry / refresh) and the milestone push
 * through the alert evaluator, against a fake Expo push service and a fake Roblox. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { checkCcuMilestone, milestonesUpTo, newMilestoneState, type Verdict } from "../src/alerts/checks.ts";
import { alertSettingsFromEnv, defaultAlertSettings } from "../src/alerts/rules.ts";
import { CcuHistory, formatDuration, formatHours, milestoneBody, seriesMinutes } from "../src/server/mobile-live.ts";
import { EXPO_PUSH_URL, EXPO_RECEIPTS_URL } from "../src/server/mobile-push.ts";
import { ADMIN, API, T0, asJson, bearer, harness, type Harness } from "./harness.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const Q = { start: 10, rearmPercent: 70, cooldownMinutes: 30 };
const fired = (v: Verdict): number[] => (v.state === "firing" ? v.findings.map((f) => Number(f.details.milestone)) : []);

describe("ccuMilestone: the state machine", () => {
	/** Feeds CCU values one minute apart from `t0`; returns what fired at each step. */
	function run(values: number[], q = Q, t0 = T0, state = newMilestoneState()) {
		return values.map((players, i) => fired(checkCcuMilestone(state, { players, servers: 2 }, t0 + i * MIN, q)));
	}

	test("milestones double from start", () => {
		expect(milestonesUpTo(85, 10)).toEqual([10, 20, 40, 80]);
		expect(milestonesUpTo(9, 10)).toEqual([]);
		expect(milestonesUpTo(5, 5)).toEqual([5]);
	});

	test("fires once at 10, 20 and 40 as players climb; nothing while it stays above", () => {
		expect(run([0, 5, 10, 12, 15, 20, 25, 39, 40, 44, 40, 41])).toEqual([[], [], [10], [], [], [20], [], [], [40], [], [], []]);
	});

	test("the first sample only learns the level: a restart at 45 announces nothing", () => {
		expect(run([45, 46, 50])).toEqual([[], [], []]);
	});

	test("a jump from 15 to 50 fires only the highest crossed (40); 20 counts as reached", () => {
		expect(run([15, 50, 60, 79])).toEqual([[], [40], [], []]);
	});

	test("re-arms below 70 % of the milestone; the cooldown (per milestone) keeps a bounce quiet", () => {
		const state = newMilestoneState();
		const at = (players: number, minute: number) => fired(checkCcuMilestone(state, { players, servers: 1 }, T0 + minute * MIN, Q));
		expect(at(0, 0)).toEqual([]);
		expect(at(20, 1)).toEqual([20]);
		// 15 is 75 % of 20: not re-armed, so back at 20 it stays quiet.
		expect(at(15, 2)).toEqual([]);
		expect(at(20, 3)).toEqual([]);
		// 13 is below 14 (70 %): re-armed; back at 20 within 30 min of the first: the cooldown keeps it quiet.
		expect(at(13, 4)).toEqual([]);
		expect(at(21, 5)).toEqual([]);
		// Dropped again, back after the cooldown: fires.
		expect(at(12, 20)).toEqual([]);
		expect(at(22, 32)).toEqual([20]);
		// Below 7 (70 % of 10) re-arms 10 too; climbing again fires 10, then 20 is still within its cooldown.
		expect(at(6, 40)).toEqual([]);
		expect(at(11, 41)).toEqual([10]);
		expect(at(20, 42)).toEqual([]);
	});

	test("the finding: key, message, details and its own repeat window", () => {
		const state = newMilestoneState();
		checkCcuMilestone(state, { players: 150, servers: 9 }, T0, Q);
		const v = checkCcuMilestone(state, { players: 163, servers: 10 }, T0 + MIN, Q);
		expect(v.state).toBe("firing");
		const f = v.state === "firing" ? v.findings[0] : undefined;
		expect(f).toMatchObject({ key: "160", message: "Reached 160 CCU (163 players online on 10 servers)", details: { milestone: 160, ccu: 163, servers: 10 }, repeatMinutes: 30 });
		expect(checkCcuMilestone(state, undefined, T0, Q).state).toBe("waiting");
	});

	test("a changed start begins again (learns the level first)", () => {
		const state = newMilestoneState();
		run([0, 12], Q, T0, state);
		expect(run([12, 26], { ...Q, start: 25 }, T0 + 10 * MIN, state)).toEqual([[], [25]]);
	});

	test("settings: defaults, env names and bounds", () => {
		expect(defaultAlertSettings().rules.ccuMilestone).toEqual({ on: true, level: "info", params: { start: 10, rearmPercent: 70, cooldownMinutes: 30 } });
		const env = alertSettingsFromEnv({ TYPETORCH_ALERT_CCU_MILESTONE_START: "100", TYPETORCH_ALERT_CCU_MILESTONE_REARM_PERCENT: "80", TYPETORCH_ALERT_CCU_MILESTONE_COOLDOWN_MINUTES: "60" });
		expect(env.rules.ccuMilestone.params).toEqual({ start: 100, rearmPercent: 80, cooldownMinutes: 60 });
		expect(() => alertSettingsFromEnv({ TYPETORCH_ALERT_CCU_MILESTONE_REARM_PERCENT: "100" })).toThrow("must be from 10 to 99");
	});
});

describe("mobile live: helpers", () => {
	test("the CCU history: per minute, nearest point for the delta, peak since, the coarse backfill before the first sample", () => {
		const h = new CcuHistory();
		for (let i = 0; i <= 5; i++) h.record(T0 - (5 - i) * MIN + 10_000, 100 + i);
		h.record(T0 + 20_000, 106);
		// Taken at the first read after the start: a rollup bucket that reaches into the first sample's minute is dropped.
		h.backfill([
			{ t: T0 - 60 * MIN, ccu: 300 },
			{ t: T0 - 20 * MIN, ccu: 90 },
			{ t: T0 - 7 * MIN, ccu: 999 },
		]);
		expect(h.hasBackfill).toBe(true);
		expect(h.series(T0 + 30_000, 30).map((p) => p.ccu)).toEqual([90, 100, 101, 102, 103, 104, 106]);
		expect(h.at(T0 - 5 * MIN)).toBe(100);
		expect(h.peakSince(T0 - 2 * 60 * MIN)).toBe(300);
		expect(h.peakSince(T0 - 30 * MIN)).toBe(106);
		expect(new CcuHistory().at(T0)).toBeNull();
		// 24 hours kept.
		h.record(T0 + DAY + MIN, 1);
		expect(h.size).toBe(1);
	});

	test("minutes: 1..360, default 30", () => {
		expect(seriesMinutes(null)).toBe(30);
		expect(seriesMinutes("1")).toBe(1);
		expect(seriesMinutes("360")).toBe(360);
		for (const bad of ["0", "361", "-1", "1.5", "abc", "1e2", "0360"]) expect(seriesMinutes(bad)).toBeUndefined();
	});

	test("the push body", () => {
		expect(formatDuration(1120)).toBe("18 m 40 s");
		expect(formatDuration(45)).toBe("45 s");
		expect(formatHours(1240.5)).toBe("1,241 h");
		expect(formatHours(2.5)).toBe("2.5 h");
		const hour = { at: new Date(T0).toISOString(), avgSessionSeconds: 1120, medianSessionSeconds: 545, sessionsEnded: 412, playtimeHours: 1240.4 };
		expect(milestoneBody("The Prison", hour, 163)).toBe("The Prison · last hour: 18 m 40 s avg session · 1,240 h played");
		expect(milestoneBody("The Prison", { ...hour, avgSessionSeconds: null }, 163)).toBe("The Prison · last hour: 1,240 h played");
		expect(milestoneBody("The Prison", null, 1630)).toBe("The Prison · 1,630 playing");
	});
});

/** A fake Expo push service and Roblox games API. `tickets` decides each message's ticket. */
class FakeServices {
	pushes: { to: string; title: string; body: string; channelId?: string; priority?: string; sound?: string; data?: Record<string, unknown> }[] = [];
	requests = 0;
	receiptsAsked: string[][] = [];
	ticket: (to: string) => Record<string, unknown> = () => ({ status: "ok", id: `ticket-${++this.requests}` });
	receipts: Record<string, unknown> = {};
	down = false;

	fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === EXPO_PUSH_URL) {
			if (this.down) throw new Error("connect ECONNREFUSED");
			const messages = JSON.parse(String(init?.body)) as FakeServices["pushes"];
			expect(messages.length).toBeLessThanOrEqual(100);
			this.pushes.push(...messages);
			return Response.json({ data: messages.map((m) => this.ticket(m.to)) });
		}
		if (url === EXPO_RECEIPTS_URL) {
			const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
			this.receiptsAsked.push(ids);
			return Response.json({ data: Object.fromEntries(ids.filter((id) => id in this.receipts).map((id) => [id, this.receipts[id]])) });
		}
		if (url.startsWith("https://games.roblox.com/v1/games?universeIds=123456789")) return Response.json({ data: [{ id: 123456789, rootPlaceId: 1001, name: "The Prison", playing: 7 }] });
		if (url.startsWith("https://thumbnails.roblox.com/")) return Response.json({ data: [] });
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

const hb = (j: string, n: number, now: number) => ({ j, t: "public", b: "prod", c: "prod", a: "art-41", n, m: 50, s: Math.floor((now - 3_600_000) / 1000), u: Math.floor(now / 1000), p: 1001, v: "0.3.2", q: 41, g: 3, h: "ok", sv: 2 });
const PUSH_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const PUSH_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const PUSH_C = "ExpoPushToken[cccccccccccccccccccccc]";

describe("mobile live and push through the app", () => {
	let h: Harness;
	let fake: FakeServices;
	let ipN = 0;
	const ip = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;

	const mint = async (device = "Pixel 9"): Promise<{ token: string; id: string }> => {
		const res = await h.call("/v1/auth/mobile/token", { method: "POST", body: JSON.stringify({ device }), headers: { "content-type": "application/json", ...bearer(ADMIN) }, ip: ip() });
		expect(res.status).toBe(200);
		const body = await asJson(res);
		return { token: body.token as string, id: body.id as string };
	};
	const live = (token: string | undefined, query = "") => h.call(`/v1/mobile/live${query}`, { headers: token ? bearer(token) : {}, ip: ip() });
	const register = (token: string, body: unknown) => h.call("/v1/mobile/push", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...bearer(token) }, ip: ip() });
	const unregister = (token: string) => h.call("/v1/mobile/push", { method: "DELETE", headers: bearer(token), ip: ip() });
	const testPush = (token: string) => h.call("/v1/mobile/push/test", { method: "POST", headers: bearer(token), ip: ip() });
	const registration = (id: string) => h.app.mobilePush.get(id);
	const patchSettings = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
	const beat = async (players: [string, number][]) => {
		for (const [job, n] of players) {
			const r = await h.call("/v1/fleet/heartbeat", { method: "POST", body: JSON.stringify(hb(job, n, h.now())), headers: { "content-type": "application/json", ...bearer(API) } });
			expect(r.status).toBe(202);
		}
	};
	/** Waits (30 s at most) until `done` holds: the milestone push and a gone token's cleanup run in the background. */
	const until = async (done: () => boolean | Promise<boolean>) => {
		const deadline = Date.now() + 30_000;
		while (!(await done())) {
			if (Date.now() > deadline) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 10));
		}
	};

	beforeAll(async () => {
		fake = new FakeServices();
		h = await harness({ TYPETORCH_UNIVERSE_ID: "123456789", TYPETORCH_PUBLIC_URL: "https://backend.example.test" }, { fetch: fake.fetch });
		// Sessions around T0 (one event row per join / leave; s3 is still running).
		const base = { v: 1, job: "job-1", srv: "public", place: 1001, art: "a1b2c3d-000001", seq: 1, branch: "prod", channel: "prod", dev: "phone", newp: false, exp: "{}", sexp: "", src: "server" };
		const session = (pid: string, from: number, to: number | null, last?: number) => [
			{ ...base, pid, sid: `${pid}-s`, t: from, kind: "session", name: "join" },
			...(to !== null ? [{ ...base, pid, sid: `${pid}-s`, t: to, kind: "session", name: "leave" }] : [{ ...base, pid, sid: `${pid}-s`, t: last as number, kind: "custom", name: "tick" }]),
		];
		const events = [
			...session("p1", T0 - 40 * MIN, T0 - 30 * MIN), // 10 min, ended in the hour
			...session("p2", T0 - 50 * MIN, T0 - 30 * MIN), // 20 min, ended in the hour
			...session("p3", T0 - 30 * MIN, null, T0 - MIN), // running: 30 min in the hour
			...session("p4", T0 - 180 * MIN, T0 - 170 * MIN), // over before the hour
			...session("p5", T0 - 90 * MIN, T0 - 45 * MIN), // 45 min, ended in the hour (15 of them inside it)
		];
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		await h.app.load();
	});
	afterAll(() => h.close());

	test("GET /v1/mobile/live: a mobile app token only; minutes checked", async () => {
		expect((await live(undefined)).status).toBe(401);
		// The admin token and an explorer session are not a mobile app token.
		expect((await live(ADMIN)).status).toBe(401);
		const cookie = `tt_session=${h.app.sessions.create({ kind: "token" }, "admin")}`;
		expect((await h.call("/v1/mobile/live", { headers: { cookie }, ip: ip() })).status).toBe(401);
		const { token, id } = await mint();
		for (const q of ["?minutes=0", "?minutes=361", "?minutes=abc", "?minutes=30&x=1"]) expect((await live(token, q)).status).toBe(400);
		expect((await h.call("/v1/mobile/live", { method: "POST", headers: bearer(token), ip: ip() })).status).toBe(405);
		// A revoked token hears "sign in again".
		expect((await h.call("/v1/auth/mobile/logout", { method: "POST", headers: bearer(token), ip: ip() })).status).toBe(200);
		const dead = await live(token);
		expect(dead.status).toBe(401);
		expect(await asJson(dead)).toMatchObject({ code: "mobile_token_dead" });
		expect(id).toBeTruthy();
	});

	test("GET /v1/mobile/live: CCU, servers, delta, peak, the series and the last hour (aggregates only)", async () => {
		const { token } = await mint();
		const alerts = h.app.backendAlerts;
		if (!alerts) throw new Error("no evaluator");
		// The milestone rule off here (its push would compute the last hour while the clock is still in the past).
		expect((await patchSettings({ backendAlerts: { rules: { ccuMilestone: { on: false } } } })).status).toBe(200);
		// One evaluator tick a minute for 10 minutes (the CCU history), players climbing 4 to 13 on job-1, 3 on job-2.
		for (let i = 0; i < 10; i++) {
			h.setNow(T0 - (10 - i) * MIN);
			await beat([
				["job-1", 4 + i],
				["job-2", 3],
			]);
			await alerts.tick();
		}
		h.setNow(T0);
		await beat([
			["job-1", 20],
			["job-2", 3],
		]);
		const res = await live(token, "?minutes=5");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await asJson(res);
		if (process.env.TT_PRINT_LIVE) console.log(JSON.stringify(body));
		// The release garden's copy rides on every answer (no deploy history here: 182 "no data" days).
		const { releases, ...rest } = body as { releases: { days: { bg: string; tri: string }[]; prod: number; dev: number } } & Record<string, unknown>;
		expect(releases.days).toHaveLength(182);
		expect(releases.days.every((c) => c.bg === "rnone" && c.tri === "rnone")).toBe(true);
		expect([releases.prod, releases.dev]).toEqual([0, 0]);
		// 5 minutes ago (T0 - 5 min) job-1 had 9 players: 9 + 3 = 12; now 23.
		expect(rest).toEqual({
			at: new Date(T0).toISOString(),
			// No icon from the fake thumbnails service: null.
			game: { name: "The Prison", universeId: 123456789, iconUrl: null },
			ccu: 23,
			servers: 2,
			delta: 11,
			peakToday: 23,
			series: [5, 4, 3, 2, 1].map((m) => ({ t: T0 - m * MIN, ccu: 4 + (10 - m) + 3 })),
			lastHour: {
				at: new Date(T0).toISOString(),
				// p1 10 min, p2 20 min, p5 45 min ended in the hour: mean 25 min, median 20 min.
				avgSessionSeconds: 1500,
				medianSessionSeconds: 1200,
				sessionsEnded: 3,
				// Inside the hour: p1 10 + p2 20 + p3 30 (running, up to now) + p5 15 = 75 min.
				playtimeHours: 1.3,
			},
			// The health card: two live servers, both healthy; no errors or alerts here.
			health: { errors1h: 0, errorsPrev1h: 0, servers: 2, serversOk: 2, alertsOpen: 0, alerts: [] },
		});
		// Aggregates only: no player or session id.
		for (const pid of ["p1", "p2", "p3", "p5", "p1-s"]) expect(JSON.stringify(body)).not.toContain(`"${pid}"`);
		// The last hour is cached 5 minutes: new sessions don't show before then.
		h.setNow(T0 + 2 * MIN);
		expect((await asJson(await live(token))).lastHour.at).toBe(new Date(T0).toISOString());
		h.setNow(T0 + 6 * MIN);
		expect((await asJson(await live(token))).lastHour.at).toBe(new Date(T0 + 6 * MIN).toISOString());
		h.setNow(T0);
	});

	test("GET /v1/mobile/live is rate limited per token", async () => {
		const { token } = await mint();
		let limited = 0;
		for (let i = 0; i < 25; i++) if ((await live(token)).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
	});

	test("POST /v1/mobile/push: validated; one registration per token (a second call replaces it); the push token is never answered", async () => {
		const { token, id } = await mint();
		expect((await register(token, { token: "not-a-token", milestones: true })).status).toBe(400);
		expect((await register(token, { token: "ExponentPushToken[]", milestones: true })).status).toBe(400);
		expect((await register(token, { token: `ExponentPushToken[${"x".repeat(200)}]`, milestones: true })).status).toBe(400);
		expect((await register(token, { token: PUSH_A, milestones: "yes" })).status).toBe(400);
		expect((await register(token, { token: PUSH_A, milestones: true, extra: 1 })).status).toBe(400);
		expect((await h.call("/v1/mobile/push", { method: "POST", body: "{", headers: { "content-type": "application/json", ...bearer(token) }, ip: ip() })).status).toBe(400);
		expect((await register(ADMIN, { token: PUSH_A, milestones: true })).status).toBe(401);
		const ok = await register(token, { token: PUSH_A, milestones: true });
		expect(ok.status).toBe(200);
		const text = await ok.text();
		expect(JSON.parse(text)).toEqual({ ok: true, milestones: true });
		expect(text).not.toContain("aaaa");
		expect(await registration(id)).toEqual({ pushToken: PUSH_A, milestones: true });
		expect(await asJson(await register(token, { token: PUSH_C, milestones: false }))).toEqual({ ok: true, milestones: false });
		expect(await registration(id)).toEqual({ pushToken: PUSH_C, milestones: false });
		// The same phone under a second token: the older registration goes (one push per phone).
		const other = await mint();
		expect((await register(other.token, { token: PUSH_C, milestones: true })).status).toBe(200);
		expect(await registration(id)).toBeUndefined();
		// DELETE removes this token's own registration only.
		expect(await asJson(await unregister(other.token))).toEqual({ ok: true });
		expect(await registration(other.id)).toBeUndefined();
		expect((await unregister(other.token)).status).toBe(200);
		// The push token never shows in the audit log or the server's log.
		const audit = await asJson(await h.call("/v1/admin/audit?action=mobile.push.*", { headers: bearer(ADMIN) }));
		expect(audit.entries.some((e: { action: string }) => e.action === "mobile.push.register")).toBe(true);
		expect(JSON.stringify(audit)).not.toContain("PushToken[");
		expect(h.logs.join("\n")).not.toContain("PushToken[");
	});

	test("logout, revoke, revoke all and expiry remove the registration; a refresh moves it to the new token", async () => {
		const a = await mint();
		await register(a.token, { token: PUSH_A, milestones: true });
		expect((await h.call("/v1/auth/mobile/logout", { method: "POST", headers: bearer(a.token), ip: ip() })).status).toBe(200);
		await until(async () => (await registration(a.id)) === undefined);

		const b = await mint();
		await register(b.token, { token: PUSH_B, milestones: true });
		expect((await h.call(`/v1/auth/mobile/tokens/${b.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
		expect(await registration(b.id)).toBeUndefined();

		// A refresh: the registration follows the new token; the old one has none.
		const c = await mint();
		await register(c.token, { token: PUSH_C, milestones: true });
		const refreshed = await asJson(await h.call("/v1/auth/mobile/refresh", { method: "POST", headers: bearer(c.token), ip: ip() }));
		expect(await registration(c.id)).toBeUndefined();
		expect(await registration(refreshed.id)).toEqual({ pushToken: PUSH_C, milestones: true });

		const d = await mint();
		await register(d.token, { token: PUSH_A, milestones: true });
		expect((await h.call("/v1/auth/mobile/tokens/revoke-all", { method: "POST", headers: bearer(ADMIN) })).status).toBe(200);
		expect(await registration(d.id)).toBeUndefined();
		expect(await registration(refreshed.id)).toBeUndefined();
		expect((await h.app.mobilePush.counts()).registrations).toBe(0);

		// Expiry: the token's lifetime (60 days) passes; its next use (or the prune) takes the registration out.
		const e = await mint();
		await register(e.token, { token: PUSH_B, milestones: true });
		h.setNow(T0 + 61 * DAY);
		expect((await live(e.token)).status).toBe(401);
		await until(async () => (await registration(e.id)) === undefined);
		const f = await mint();
		await register(f.token, { token: PUSH_A, milestones: true });
		h.setNow(T0 + 122 * DAY);
		expect(await h.app.mobilePush.prune()).toBe(1);
		expect(await registration(f.id)).toBeUndefined();
		h.setNow(T0);
	});

	test("POST /v1/mobile/push/test: one push to this token's registration, 1 per 10 s; 409 without one", async () => {
		const { token, id } = await mint();
		// No registration: 409, and the one test per 10 s isn't used up.
		expect((await testPush(token)).status).toBe(409);
		expect(await asJson(await testPush(token))).toEqual({ error: "not_registered" });
		await register(token, { token: PUSH_B, milestones: false });
		fake.pushes = [];
		const res = await testPush(token);
		expect(res.status).toBe(200);
		expect(await asJson(res)).toEqual({ ok: true, ticket: { status: "ok" } });
		expect(fake.pushes).toEqual([{ to: PUSH_B, title: "Test from TypeTorch", body: "The Prison · pushes work", channelId: "milestones", priority: "high", sound: "default", data: { kind: "test", backendUrl: "https://backend.example.test" } }]);
		expect((await testPush(token)).status).toBe(429);
		h.setNow(h.now() + 10_000);
		// Expo's error ticket goes back to the app; DeviceNotRegistered removes the registration.
		fake.ticket = () => ({ status: "error", message: `"${PUSH_B}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } });
		expect(await asJson(await testPush(token))).toEqual({ ok: true, ticket: { status: "error", error: "DeviceNotRegistered" } });
		expect(await registration(id)).toBeUndefined();
		fake.ticket = () => ({ status: "ok", id: `ticket-${++fake.requests}` });
		// Expo down: 502, nothing removed.
		h.setNow(h.now() + 10_000);
		await register(token, { token: PUSH_B, milestones: false });
		fake.down = true;
		expect((await testPush(token)).status).toBe(502);
		fake.down = false;
		expect(await registration(id)).toEqual({ pushToken: PUSH_B, milestones: false });
		await unregister(token);
		h.setNow(T0);
	});

	test("a CCU milestone: the alert goes where alerts go, and a push to every registration with milestones on", async () => {
		const alerts = h.app.backendAlerts;
		if (!alerts) throw new Error("no evaluator");
		expect((await patchSettings({ backendAlerts: { rules: { ccuMilestone: { on: true } } } })).status).toBe(200);
		const on = await mint("Phone on");
		const off = await mint("Phone off");
		await register(on.token, { token: PUSH_A, milestones: true });
		await register(off.token, { token: PUSH_B, milestones: false });
		fake.pushes = [];
		let now = T0 + 2 * 3_600_000;
		const at = async (players: number) => {
			now += MIN;
			h.setNow(now);
			await beat([["job-1", players]]);
			await alerts.tick();
		};
		await at(15);
		await at(15);
		expect(fake.pushes).toEqual([]);
		await at(50);
		await until(() => fake.pushes.length > 0);
		expect(fake.pushes).toHaveLength(1);
		const push = fake.pushes[0];
		expect(push).toMatchObject({ to: PUSH_A, title: "Reached 40 CCU", channelId: "milestones", priority: "high", sound: "default", data: { kind: "ccuMilestone", backendUrl: "https://backend.example.test", universeId: 123456789, ccu: 50, milestone: 40 } });
		expect(push?.body).toStartWith("The Prison · ");
		// The fleet alert (Fleet page, webhook) as well.
		const list = await asJson(await h.call("/v1/fleet/alerts", { headers: bearer(ADMIN) }));
		expect(list.alerts.some((a: { code: string; message: string }) => a.code === "backend_ccu_milestone" && a.message.startsWith("Reached 40 CCU"))).toBe(true);
		// Staying up there sends nothing more.
		await at(60);
		await new Promise((r) => setTimeout(r, 50));
		expect(fake.pushes).toHaveLength(1);
		// A receipt with DeviceNotRegistered (read 15 minutes later) removes the registration.
		const ticketId = `ticket-${fake.requests}`;
		fake.receipts[ticketId] = { status: "error", details: { error: "DeviceNotRegistered" } };
		h.setNow(now + 16 * MIN);
		expect(await h.app.mobilePush.checkReceipts()).toBe(1);
		expect(fake.receiptsAsked.at(-1)).toContain(ticketId);
		expect(await registration(on.id)).toBeUndefined();
		expect(await registration(off.id)).toEqual({ pushToken: PUSH_B, milestones: false });
		// Expo down: the evaluator goes on (the push failure is logged, never thrown).
		await register(on.token, { token: PUSH_A, milestones: true });
		fake.down = true;
		now += 20 * MIN;
		await at(10);
		await at(90);
		await until(() => h.logs.some((l) => l.includes("the push service could not be reached")));
		fake.down = false;
		expect(alerts.status().rules.find((r) => r.id === "ccuMilestone")).toMatchObject({ state: "firing" });
		h.setNow(T0);
	});
});
