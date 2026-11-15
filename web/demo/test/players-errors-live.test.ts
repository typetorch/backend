/** Players, error logs (and the live stream), live events and notifications through the explorer's API client. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { DAY_MS, setClock } from "../mock/data";
import { errorEventBetween, getErrorDropRules, setErrorDropRules } from "../mock/errors";
import { DEMO_UID_BASE } from "../mock/notify";
import { pack } from "../mock/pack";
import { MockEventSource } from "../mock/router";
import { describeWithPack, mockFetch, setupDemo, teardownDemo, testApi, TEST_NOW } from "./harness";

const HOUR = 3_600_000;

/** No Roblox UserId, avatar or roblox.com URL anywhere in an answer. */
function expectPrivate(value: unknown): void {
	const text = JSON.stringify(value);
	expect(text).not.toMatch(/rbxcdn|roblox\.com\/users|thumbnails\.roblox|"avatar":"http/);
	expect(text).not.toMatch(/"uid":/);
}

describeWithPack("errors", () => {
	beforeAll(() => setupDemo());
	afterAll(() => teardownDemo());

	it("lists error kinds with counts, sparklines and builds", async () => {
		const list = await testApi().errors({ window: "7d" });
		expect(list.kinds.length).toBeGreaterThan(20);
		expect(list.totals.count).toBeGreaterThan(list.kinds[0]?.count ?? 0);
		expect(list.totals.players).toBeGreaterThan(10);
		expect(list.window.buckets).toBe(list.kinds[0]?.spark.length);
		expect(list.builds?.length).toBeGreaterThan(0);
		for (const k of list.kinds) {
			expect(Date.parse(k.lastAt)).toBeLessThanOrEqual(TEST_NOW);
			expect(k.spark.reduce((a, b) => a + b, 0)).toBe(k.count);
		}
		// The game's own script errors are there, next to the engine's.
		expect(list.kinds.some((k) => k.template.includes("ArrestService"))).toBe(true);
		const day = await testApi().errors({ window: "24h", realm: "server", sort: "-total", limit: 5 });
		expect(day.kinds.every((k) => k.realm === "server")).toBe(true);
		expect(day.kinds.length).toBeLessThanOrEqual(5);
		const totals = day.kinds.map((k) => k.total);
		expect([...totals].sort((a, b) => b - a)).toEqual(totals);
		const found = await testApi().errors({ window: "7d", q: "arrestservice" });
		expect(found.kinds.length).toBe(1);
	});

	it("answers 400 like the backend", async () => {
		for (const params of [{ window: "7x" }, { realm: "space" }, { limit: "0" }, { sort: "name" }]) {
			const error = await testApi()
				.errors(params as never)
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(400);
		}
		const missing = await testApi()
			.errorKind("ffffffffffffffff")
			.catch((e: unknown) => e);
		expect((missing as ApiError).status).toBe(404);
	});

	it("opens a kind, its players and servers, and the player's and server's lists", async () => {
		const api = testApi();
		const list = await api.errors({ window: "7d" });
		const kind = list.kinds.find((k) => k.players > 0) ?? list.kinds[0];
		if (!kind) throw new Error("no kind");
		const detail = await api.errorKind(kind.fp, { window: "7d" });
		expect(detail.kind.template).toBe(kind.template);
		expect(detail.count).toBe(kind.count);
		expect(detail.series.reduce((a, s) => a + s.n, 0)).toBe(kind.count);
		expect(detail.byBuild.length).toBeGreaterThan(0);
		expect(detail.byJob?.length).toBeGreaterThan(0);
		const players = await api.errorPlayers(kind.fp, { window: "7d" });
		expect(players.players.length).toBeGreaterThan(0);
		expect(players.total).toBe(kind.players);
		expect(players.players[0]?.name).toMatch(/^(Inmate|Guard)_\d{4}$/);
		expectPrivate(players);
		const pid = players.players[0]?.pid as string;
		const mine = await api.playerErrors(pid, { window: "7d" });
		expect(mine.errors.some((e) => e.fp === kind.fp)).toBe(true);
		const job = detail.byJob?.[0]?.job as string;
		const p = await pack();
		expect(p.job(job)).toBeDefined();
		const server = await api.serverErrors(job, { window: "7d" });
		expect(server.errors.some((e) => e.fp === kind.fp)).toBe(true);
		expect((await api.playerErrors("not a pid!").catch((e: unknown) => e)) as ApiError).toMatchObject({ status: 400 });
	});

	it("keeps drop rules, drops what they match from when they were saved, and previews", async () => {
		const api = testApi();
		const rules = await api.errorDropRules();
		expect(rules.rules.length).toBeGreaterThan(0);
		expect(rules.since).toBeTruthy();
		expect(Object.keys(rules.counts)).toEqual(rules.rules.map((r) => r.id));
		expect(rules.rules.filter((r) => r.error)).toEqual([]);
		// The seeded CoreGui rule has dropped since the server started.
		expect(Object.values(rules.counts).some((c) => c.items > 0)).toBe(true);
		const preview = await api.previewDropRule('message contains "ArrestService"');
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		expect(preview.matchedKinds).toBe(1);
		expect(preview.matchedOccurrences).toBeGreaterThan(0);
		const bad = await api.previewDropRule("message contains");
		expect(bad.ok).toBe(false);
		// Saved now: nothing before now is dropped, so the list is the same; the rule is listed with zero drops.
		setErrorDropRules([...getErrorDropRules(), { id: "arrests", expr: 'message contains "ArrestService"', on: true }]);
		const after = await api.errorDropRules();
		expect(after.rules.find((r) => r.id === "arrests")).toBeTruthy();
		expect(after.counts.arrests?.items).toBe(0);
		expect(after.source).toBe("dashboard");
		// Twelve hours on, the arrests that came after the save are dropped and counted, the earlier ones stay.
		const before = (await api.errors({ window: "7d", q: "arrestservice" })).kinds[0]?.count ?? 0;
		setClock(() => TEST_NOW + 12 * HOUR);
		try {
			const later = await api.errorDropRules();
			expect(later.counts.arrests?.items).toBeGreaterThan(0);
			const kept = (await api.errors({ window: "7d", to: TEST_NOW + 12 * HOUR, q: "arrestservice" })).kinds[0];
			expect(Date.parse(kept?.lastAt ?? "")).toBeLessThanOrEqual(TEST_NOW);
			expect(kept?.count ?? 0).toBeLessThanOrEqual(before);
		} finally {
			setClock(() => TEST_NOW);
		}
	});

	it("streams hello and error events", async () => {
		const source = new MockEventSource("/api/v1/live?topics=error");
		const hello = await new Promise<unknown>((resolve) => source.addEventListener("hello", (e) => resolve(JSON.parse((e as MessageEvent).data))));
		source.close();
		expect(hello).toMatchObject({ at: TEST_NOW, topics: ["error"] });
		const event = await errorEventBetween(TEST_NOW - 6 * HOUR, TEST_NOW);
		expect(event?.total).toBeGreaterThan(0);
		expect(event?.kinds[0]).toMatchObject({ fp: expect.any(String), template: expect.any(String), count: expect.any(Number) });
	});
});

describeWithPack("players and experiments", () => {
	beforeAll(() => setupDemo({ engine: true }));
	afterAll(() => teardownDemo());

	it("maps no UserIds and gives fake profiles without avatars", async () => {
		const api = testApi();
		const p = await pack();
		const pid = p.players[0]?.pid as string;
		expect(await api.identity({ pid })).toEqual([]);
		expect(await api.identity({ uid: 123 })).toEqual([]);
		expect(await api.identitySummary()).toEqual({ count: 0, backfill: false });
		expect(await api.backfillIdentities()).toEqual({ scanned: 0, added: 0, known: 0 });
		const profile = await api.playerProfile(pid);
		expect(profile).toMatchObject({ pid, linked: false });
		expect(profile.name).toMatch(/^(Inmate|Guard)_\d{4}$/);
		expect(profile.uid).toBeUndefined();
		expect(profile.avatar).toBeUndefined();
		expectPrivate(profile);
	});

	it("shows, changes and lists experiments", async () => {
		const api = testApi();
		const before = await api.experimentOverrides();
		expect(Object.keys(before.experiments).sort()).toEqual(["one_tap_play", "tutorial_ui"]);
		const prepared = await api.experimentChange("tutorial_ui", { action: "split", weights: [50, 50], variants: ["spotlight", "beam"] });
		expect(prepared.command).toBe("typetorch experiment weights tutorial_ui 50,50 --variants spotlight,beam");
		expect((await api.experimentOverrides()).experiments.tutorial_ui?.weights).toEqual([50, 50]);
		await api.experimentChange("tutorial_ui", { action: "settle", variant: "beam" });
		expect((await api.experimentOverrides()).experiments.tutorial_ui?.variant).toBe("beam");
		const bad = await api.experimentChange("tutorial_ui", { action: "split" }).catch((e: unknown) => e);
		expect((bad as ApiError).status).toBe(400);
		const players = await api.experimentPlayers("one_tap_play", { from: new Date(TEST_NOW - 7 * DAY_MS).toISOString() }, { limit: 20 });
		expect(players.players.length).toBeGreaterThan(0);
		expect(players.variants.map((v) => v.variant).sort()).toEqual(["menu", "one_tap"]);
		expect(players.players[0]?.name).toMatch(/^(Inmate|Guard)_\d{4}$/);
		expectPrivate(players);
	});
});

describeWithPack("live events", () => {
	beforeAll(() => setupDemo({ engine: true }));
	afterAll(() => teardownDemo());

	it("lists, creates, signs on refresh, cancels and reports lift", async () => {
		const api = testApi();
		const view = await api.liveEvents();
		expect(view.events.map((e) => e.status).sort()).toEqual(["cancelled", "ended", "live", "scheduled"]);
		expect(view.needsSigning).toBe(false);
		expect(view.signed.state).toBe("ok");
		const start = new Date(TEST_NOW + 2 * DAY_MS).toISOString();
		const end = new Date(TEST_NOW + 3 * DAY_MS).toISOString();
		const made = await api.createLiveEvent({ name: "Medic Appreciation Day", values: { "cash.healReward": 40 }, start, end });
		expect(made.event.status).toBe("scheduled");
		expect(made.event.id).toMatch(/^ev_[0-9a-z]{10}$/);
		expect(made.commands.bash).toContain("tt.events");
		const unsigned = await api.liveEvents();
		expect(unsigned.events.find((e) => e.id === made.event.id)?.sync).toBe("unsigned");
		expect(unsigned.needsSigning).toBe(true);
		const clash = await api.createLiveEvent({ name: "Again", values: { "cash.healReward": 10 }, start, end }).catch((e: unknown) => e);
		expect((clash as ApiError).status).toBe(409);
		const past = await api.createLiveEvent({ name: "Past", values: { x: 1 }, start: new Date(TEST_NOW - DAY_MS).toISOString(), end }).catch((e: unknown) => e);
		expect((past as ApiError).status).toBe(400);
		const signed = await api.liveEvents(true);
		expect(signed.needsSigning).toBe(false);
		const cancelled = await api.cancelLiveEvent(made.event.id);
		expect(cancelled.event.status).toBe("cancelled");
		expect((await api.cancelLiveEvent(made.event.id).catch((e: unknown) => e)) as ApiError).toMatchObject({ status: 409 });
		const ended = view.events.find((e) => e.status === "ended") as (typeof view.events)[number];
		const lift = await api.liveEventLift(ended.id, { weeks: 1, afterDays: 1 });
		expect(lift.report.raw.event.players).toBeGreaterThan(0);
		expect(lift.report.verdict).toBeTruthy();
		const scheduled = view.events.find((e) => e.status === "scheduled") as (typeof view.events)[number];
		expect((await api.liveEventLift(scheduled.id).catch((e: unknown) => e)) as ApiError).toMatchObject({ status: 409 });
	});
});

describeWithPack("notifications", () => {
	beforeAll(() => setupDemo());
	afterAll(() => teardownDemo());

	it("answers status, config, recent, users and per-player views", async () => {
		const api = testApi();
		const status = await api.notifyStatus();
		expect(status.enabled).toBe(true);
		expect(status.kinds.length).toBeGreaterThan(3);
		expect(status.sends24h.sent).toBeGreaterThan(0);
		const config = await api.notifyConfig();
		expect(Object.keys((config.config as { kinds: object }).kinds)).toContain("daily_spin");
		const recent = await api.notifyRecent({ limit: 50 });
		expect(recent.sends.length).toBe(50);
		for (const s of recent.sends) {
			expect(s.userId).toBeGreaterThanOrEqual(DEMO_UID_BASE);
			expect(s.plannedAt ?? 0).toBeLessThanOrEqual(TEST_NOW);
		}
		const spins = await api.notifyRecent({ kind: "daily_spin" });
		expect(spins.sends.every((s) => s.kind === "daily_spin")).toBe(true);
		const users = await api.notifyUsers({ limit: 20 });
		expect(users.users.length).toBe(20);
		expect(users.counts.subscribed).toBeGreaterThan(20);
		expect(users.next).toBeTruthy();
		const next = await api.notifyUsers({ limit: 20, cursor: users.next as string });
		expect(next.users[0]?.userId).not.toBe(users.users[0]?.userId);
		expect(new Set([...users.users, ...next.users].map((u) => u.userId)).size).toBe(40);
		const muted = await api.notifyUsers({ state: "muted" });
		expect(muted.users.every((u) => (u.muteUntil ?? 0) > TEST_NOW)).toBe(true);
		const one = users.users[0] as (typeof users.users)[number];
		const view = await api.notifyUser({ uid: String(one.userId) });
		expect(view.known).toBe(true);
		expect(view.sends.length).toBeGreaterThan(0);
		expect(view.pids).toEqual([]);
		if (one.name) expect((await api.notifyUser({ name: one.name })).userId).toBe(one.userId);
		expect((await api.notifyUser({ pid: "abc" }).catch((e: unknown) => e)) as ApiError).toMatchObject({ status: 404 });
		const csv = await api.notifyUsersCsv({ state: "subscribed" });
		expect(csv.name).toBe("notify-subscribed.csv");
		expect((await csv.blob.text()).split("\n")[0]).toBe("user_id,name,state,optin_at,last_seen,online,mute_until,sends,opened");
		expect(csv.truncated).toBe(false);
		const raw = await mockFetch("/api/v1/notify/users?format=xml");
		expect(raw.status).toBe(400);
	});

	it("keeps test sends", async () => {
		const api = testApi();
		const users = await api.notifyUsers({ limit: 1 });
		const userId = users.users[0]?.userId as number;
		const sent = await api.notifyTest({ userId, kind: "quest_reset", params: { quest: "inmate clean 3 spills", cash: "200" } });
		expect(sent.status).toBe("planned");
		const view = await api.notifyUser({ uid: String(userId) });
		expect(view.sends.find((s) => s.nid === sent.nid)?.test).toBe(true);
		const bad = await api.notifyTest({ userId, kind: "quest_reset" }).catch((e: unknown) => e);
		expect((bad as ApiError).status).toBe(400);
		const unknown = await api.notifyTest({ userId, kind: "nope" }).catch((e: unknown) => e);
		expect((unknown as ApiError).message).toContain("unknown kind");
	});
});
