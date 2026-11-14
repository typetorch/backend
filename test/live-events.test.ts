/**
 * Scheduled live events (src/server/live-events.ts and the /v1/live-events routes): the store's checks and statuses
 * over time, the schedule servers get (start and end inside it, so it ends with the backend down), cancelling, the
 * signed record read back and verified, each event's sync state, and the gates (owners change, viewers read, audited).
 * Every token and key is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { openSqlite } from "../src/fleet/db.ts";
import { LiveEventError, LiveEventStore, signCommands, signedViewOf, syncOf, verifySettingsRecord, type Schedule } from "../src/server/live-events.ts";
import { ADMIN, T0, asJson, bearer, harness, type Harness } from "./harness.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };

/** A settings record signed like the CLI does (tt1settings \n seq \n at \n body), with a fresh key pair. */
function keyPair() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = (publicKey.export({ format: "jwk" }) as { x: string }).x;
	return { privateKey, publicRaw: Buffer.from(raw, "base64url").toString("base64") };
}
function record(seq: number, game: Record<string, unknown>, key: ReturnType<typeof keyPair>) {
	const at = "2026-10-09T12:00:00.000Z";
	const body = JSON.stringify({ defaultBranch: "main", game });
	const sig = sign(null, Buffer.from(`tt1settings\n${seq}\n${at}\n${body}`, "utf8"), key.privateKey).toString("base64");
	return { v: 1, seq, at, body, sig, sigF: sig };
}

describe("the store", () => {
	let now = T0;
	let store: LiveEventStore;
	beforeAll(async () => {
		const db = await openSqlite(":memory:");
		store = await LiveEventStore.open(db, () => now);
	});

	const make = (over: Record<string, unknown> = {}) => store.create({ name: "Double cash", values: { "cash.multiplier": 2 }, start: T0 + DAY, end: T0 + 2 * DAY, ...over }, "admin token");

	test("checks the input", async () => {
		const bad: [Record<string, unknown>, RegExp][] = [
			[{ name: "" }, /name/],
			[{ name: "two\nlines" }, /name/],
			[{ values: {} }, /1 to 8 keys/],
			[{ values: [] }, /object of game keys/],
			[{ values: { "bad key!": 1 } }, /letters, digits/],
			[{ values: { "tt.events": {} } }, /schedule itself/],
			[{ values: { a: null } }, /null/],
			[{ values: { a: "x".repeat(2000) } }, /1024 bytes/],
			[{ start: "2026-11-21 12:00" }, /zone/],
			[{ start: T0 - HOUR }, /backdated/],
			[{ end: T0 + DAY }, /after start/],
			[{ end: T0 + 40 * DAY }, /31 days/],
			[{ start: T0 + 400 * DAY, end: T0 + 401 * DAY }, /366 days/],
		];
		for (const [over, message] of bad) {
			const error = await make(over).catch((e) => e);
			expect(error).toBeInstanceOf(LiveEventError);
			expect((error as LiveEventError).message).toMatch(message);
			expect((error as LiveEventError).status).toBe(400);
		}
		expect(store.list()).toEqual([]);
	});

	test("creates: whole seconds, an ISO start with a zone, 'now' rounds up; statuses follow the clock", async () => {
		const a = await make({ start: "2026-10-10T14:00:00.250+02:00", end: T0 + 2 * DAY + 999 });
		expect(a).toMatchObject({ name: "Double cash", values: { "cash.multiplier": 2 }, start: "2026-10-10T12:00:00.000Z", end: new Date(T0 + 2 * DAY).toISOString(), status: "scheduled", createdBy: "admin token" });
		expect(a.id).toMatch(/^ev_[0-9a-z]{10}$/);
		// A start a minute ago (the form's "now") starts now, on the whole second.
		now = T0 + 500;
		const b = await store.create({ name: "Shop sale", values: { "shop.discount": 0.2 }, start: T0 - MIN, end: T0 + HOUR }, "admin token");
		expect(b).toMatchObject({ start: new Date(T0).toISOString(), status: "live" });
		now = T0 + 2 * HOUR;
		expect(store.get(b.id)?.status).toBe("ended");
		expect(store.get(a.id)?.status).toBe("scheduled");
		now = T0 + DAY + 1;
		expect(store.get(a.id)?.status).toBe("live");
		now = T0 + 2 * HOUR;
	});

	test("refuses a clash on a key it shares with an overlapping event; other keys or times are fine", async () => {
		const clash = await make({ start: T0 + 1.5 * DAY, end: T0 + 3 * DAY }).catch((e) => e);
		expect(clash).toBeInstanceOf(LiveEventError);
		expect((clash as LiveEventError).status).toBe(409);
		expect((clash as Error).message).toMatch(/sets cash.multiplier at the same time/);
		await make({ values: { "xp.multiplier": 2 }, name: "Double XP" });
		await make({ start: T0 + 2 * DAY, end: T0 + 3 * DAY, name: "Next day" });
	});

	test("the schedule: scheduled and live events, seconds, start order; ended and cancelled ones drop out", async () => {
		const s = store.schedule();
		expect(s.v).toBe(1);
		// Start order (the two at the same start in id order).
		expect(s.events.map((e) => e.name).sort()).toEqual(["Double XP", "Double cash", "Next day"]);
		expect(s.events.at(-1)?.name).toBe("Next day");
		expect(s.events.find((e) => e.name === "Double cash")).toEqual({ id: expect.stringMatching(/^ev_/), name: "Double cash", start: (T0 + DAY) / 1000, end: (T0 + 2 * DAY) / 1000, set: { "cash.multiplier": 2 } });
		const next = store.list().find((e) => e.name === "Next day")!;
		const cancelled = await store.cancel(next.id, "roblox user 1");
		expect(cancelled).toMatchObject({ status: "cancelled", cancelledBy: "roblox user 1" });
		expect(store.schedule().events.map((e) => e.name).sort()).toEqual(["Double XP", "Double cash"]);
		await expect(store.cancel(next.id, "x")).rejects.toThrow(/already cancelled/);
		await expect(store.cancel("ev_0000000000", "x")).rejects.toThrow(/no such event/);
		const ended = store.list().find((e) => e.name === "Shop sale")!;
		await expect(store.cancel(ended.id, "x")).rejects.toThrow(/ended/);
		// The cancelled event's keys are free again.
		await make({ start: T0 + 2.5 * DAY, end: T0 + 3 * DAY, name: "Replacement" });
	});

	test("rows survive a reopen", async () => {
		const db = await openSqlite(":memory:");
		const a = await LiveEventStore.open(db, () => T0);
		const made = await a.create({ name: "Kept", values: { k: true }, start: T0 + HOUR, end: T0 + 2 * HOUR }, "admin token");
		const b = await LiveEventStore.open(db, () => T0);
		expect(b.get(made.id)).toEqual(made);
	});

	test("the CLI commands: the compact JSON in a quoted heredoc, and PowerShell from a file", () => {
		const schedule: Schedule = { v: 1, events: [{ id: "ev_abcdefghij", name: "It's 'quoted'", start: 1, end: 2, set: { a: 1 } }] };
		const c = signCommands(schedule);
		expect(c.json).toBe(JSON.stringify(schedule));
		expect(c.bash).toBe(`typetorch settings set game.tt.events - <<'TT_EVENTS'\n${c.json}\nTT_EVENTS`);
		expect(c.powershell).toContain("typetorch settings set game.tt.events -");
	});
});

describe("the signed record", () => {
	const key = keyPair();
	const other = keyPair();
	const sched: Schedule = { v: 1, events: [{ id: "ev_aaaaaaaaaa", name: "Double cash", start: (T0 + DAY) / 1000, end: (T0 + 2 * DAY) / 1000, set: { "cash.multiplier": 2 } }] };

	test("verifies like the kernel: sig or sigF with the game's public keys; a changed body fails", () => {
		const r = record(4, { "tt.events": sched }, key);
		expect(verifySettingsRecord(r, [key.publicRaw])).toBe("sig");
		expect(verifySettingsRecord({ ...r, sig: "AAAA" }, [key.publicRaw])).toBe("sigF");
		expect(verifySettingsRecord(r, [other.publicRaw])).toBe("no");
		expect(verifySettingsRecord({ ...r, body: r.body.replace("2}", "3}") }, [key.publicRaw])).toBe("no");
	});

	test("the view: seq, the schedule, verified or unchecked; missing; not a record", () => {
		const r = record(4, { "tt.events": sched, other: 1 }, key);
		expect(signedViewOf(r, [key.publicRaw], T0)).toMatchObject({ state: "ok", seq: 4, verified: "sig", schedule: sched });
		expect(signedViewOf(r, [], T0)).toMatchObject({ state: "ok", verified: "unchecked" });
		expect(signedViewOf(undefined, [], T0)).toMatchObject({ state: "missing" });
		expect(signedViewOf({ v: 1, seq: 1, at: "x", body: "{" }, [], T0)).toMatchObject({ state: "error" });
		expect(signedViewOf(record(5, {}, key), [], T0)).toMatchObject({ state: "ok", schedule: null });
	});

	test("sync per event: signed, outdated, unsigned, a cancel not signed yet, done, unknown", () => {
		const base = { id: "ev_aaaaaaaaaa", name: "Double cash", note: null, values: { "cash.multiplier": 2 }, start: new Date(T0 + DAY).toISOString(), end: new Date(T0 + 2 * DAY).toISOString(), createdAt: "", createdBy: "", cancelledAt: null, cancelledBy: null };
		const view = signedViewOf(record(4, { "tt.events": sched }, key), [key.publicRaw], T0);
		expect(syncOf({ ...base, status: "scheduled" }, view, T0)).toBe("signed");
		// Key order in values doesn't matter; another value or time does.
		expect(syncOf({ ...base, status: "scheduled", values: { "cash.multiplier": 3 } }, view, T0)).toBe("outdated");
		expect(syncOf({ ...base, status: "scheduled", end: new Date(T0 + 3 * DAY).toISOString() }, view, T0)).toBe("outdated");
		expect(syncOf({ ...base, id: "ev_bbbbbbbbbb", status: "scheduled" }, view, T0)).toBe("unsigned");
		expect(syncOf({ ...base, status: "cancelled" }, view, T0)).toBe("cancel-unsigned");
		expect(syncOf({ ...base, status: "cancelled" }, signedViewOf(record(5, { "tt.events": { v: 1, events: [] } }, key), [key.publicRaw], T0), T0)).toBe("done");
		expect(syncOf({ ...base, status: "ended" }, view, T0 + 3 * DAY)).toBe("done");
		expect(syncOf({ ...base, status: "scheduled" }, signedViewOf(undefined, [], T0), T0)).toBe("unsigned");
		expect(syncOf({ ...base, status: "scheduled" }, { state: "unconfigured", readAt: "" }, T0)).toBe("unknown");
		// Signed by keys the game doesn't use: servers refuse it, so it proves nothing.
		expect(syncOf({ ...base, status: "scheduled" }, signedViewOf(record(4, { "tt.events": sched }, other), [key.publicRaw], T0), T0)).toBe("unknown");
	});

	test("the event ends without the backend: its end time is inside the signed schedule", () => {
		const view = signedViewOf(record(4, { "tt.events": sched }, key), [key.publicRaw], T0);
		const signed = view.schedule?.events[0];
		expect(signed?.end).toBe((T0 + 2 * DAY) / 1000);
	});
});

describe("the routes", () => {
	let h: Harness;
	let web: Record<string, string>;
	const reads: string[] = [];
	const key = keyPair();
	let stored: unknown;

	beforeAll(async () => {
		const fakeFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			reads.push(url);
			if (url.includes("/data-stores/TypeTorch/entries/settings")) return stored === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ value: stored }), { status: 200 });
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		h = await harness({ TYPETORCH_WEB_VIEWERS: "4004", OPENCLOUD_API_KEY: "open-cloud-key-for-tests-0123456789", TYPETORCH_UNIVERSE_ID: "123" }, { fetch: fakeFetch });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 4004, name: "Viewer" }, "web")}` };
	});
	afterAll(() => h.close());

	const create = (headers: Record<string, string>, body: unknown) => h.call("/v1/live-events", { method: "POST", body: JSON.stringify(body), headers: { ...JSON_TYPE, ...XT, ...headers } });
	const event = { name: "Double cash", values: { "cash.multiplier": 2 }, start: new Date(T0 + DAY).toISOString(), end: new Date(T0 + 2 * DAY).toISOString() };

	test("owners create (audited); viewers get 403; bad input 400", async () => {
		expect((await create(web, event)).status).toBe(403);
		const res = await create(bearer(ADMIN), event);
		expect(res.status).toBe(201);
		const body = await asJson(res);
		expect(body.event).toMatchObject({ name: "Double cash", status: "scheduled" });
		expect(body.commands.bash).toContain(body.event.id);
		expect((await create(bearer(ADMIN), { ...event, values: {} })).status).toBe(400);
		expect((await create(bearer(ADMIN), event)).status).toBe(409);
		const audit = await asJson(await h.call("/v1/admin/audit?action=live-events.create", { headers: bearer(ADMIN) }));
		expect(audit.entries.map((e: { outcome: string }) => e.outcome).sort()).toEqual(["failed", "ok", "refused"]);
		expect(audit.entries.find((e: { outcome: string }) => e.outcome === "ok").details).toMatchObject({ id: body.event.id, keys: ["cash.multiplier"] });
	});

	test("viewers read the list; with no record it says unsigned and needs signing; once signed it's in sync", async () => {
		let list = await asJson(await h.call("/v1/live-events", { headers: web }));
		expect(list.signed).toMatchObject({ state: "missing" });
		expect(list.events[0]).toMatchObject({ name: "Double cash", sync: "unsigned" });
		expect(list.needsSigning).toBe(true);
		expect(list.schedule.events).toHaveLength(1);
		// The owner runs the command; the record now holds the schedule (the harness has no trust keys: unchecked).
		stored = record(7, { "tt.events": list.schedule }, key);
		// Read again only after the cache (refresh: at most every 10 s).
		h.setNow(T0 + 11_000);
		list = await asJson(await h.call("/v1/live-events?refresh=1", { headers: web }));
		expect(list.signed).toMatchObject({ state: "ok", seq: 7, verified: "unchecked" });
		expect(list.events[0].sync).toBe("signed");
		expect(list.needsSigning).toBe(false);
		expect(reads.every((u) => u.includes("/universes/123/data-stores/TypeTorch/entries/settings"))).toBe(true);
	});

	test("cancel: owners only, audited; the cancel needs signing until the record drops it", async () => {
		const list = await asJson(await h.call("/v1/live-events", { headers: web }));
		const id = list.events[0].id as string;
		expect((await h.call(`/v1/live-events/${id}/cancel`, { method: "POST", headers: { ...web, ...XT } })).status).toBe(403);
		const res = await h.call(`/v1/live-events/${id}/cancel`, { method: "POST", headers: bearer(ADMIN) });
		expect(res.status).toBe(200);
		expect((await asJson(res)).commands.json).toBe('{"v":1,"events":[]}');
		const after = await asJson(await h.call("/v1/live-events", { headers: web }));
		expect(after.events[0]).toMatchObject({ status: "cancelled", sync: "cancel-unsigned" });
		expect(after.needsSigning).toBe(true);
		expect((await h.call(`/v1/live-events/${id}/cancel`, { method: "POST", headers: bearer(ADMIN) })).status).toBe(409);
		const audit = await asJson(await h.call("/v1/admin/audit?action=live-events.cancel", { headers: bearer(ADMIN) }));
		expect(audit.entries.map((e: { outcome: string }) => e.outcome).sort()).toEqual(["refused", "ok"].sort());
	});

	test("lift: 409 before the start, a report once it ran (empty data: no baseline), bad options 400, unknown 404", async () => {
		const made = await asJson(await create(bearer(ADMIN), { ...event, name: "Weekend", values: { "xp.multiplier": 2 } }));
		const id = made.event.id as string;
		expect((await h.call(`/v1/live-events/${id}/lift`, { headers: web })).status).toBe(409);
		h.setNow(T0 + 6 * DAY);
		// A fresh viewer session (the first one is past its maximum age by now).
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 4004, name: "Viewer" }, "web")}` };
		const res = await h.call(`/v1/live-events/${id}/lift?weeks=2&afterDays=2`, { headers: web });
		expect(res.status).toBe(200);
		const body = await asJson(res);
		expect(body.report.plan.baselines.map((b: { weeksBack: number }) => b.weeksBack)).toEqual([1, 2]);
		expect(body.report.headline).toBe("unknown");
		expect(body.report.verdict).toMatch(/Not enough baseline/);
		expect((await h.call(`/v1/live-events/${id}/lift?weeks=9`, { headers: web })).status).toBe(400);
		expect((await h.call("/v1/live-events/ev_0000000000/lift", { headers: web })).status).toBe(404);
		expect((await h.call("/v1/live-events/nope/lift", { headers: web })).status).toBe(404);
	});

	test("signed out: 401", async () => {
		expect((await h.call("/v1/live-events")).status).toBe(401);
	});
});
