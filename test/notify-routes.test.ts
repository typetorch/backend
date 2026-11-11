/**
 * The notification routes through the whole app (test/harness.ts): auth per role, body and item validation, stale revs,
 * the admin routes (config, status, keys never returned, test), the runtime-settings keys (including the per-kind key
 * and clearing a halt), the rows reaching ingest, and the erasure hook.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, API, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const KEY = "k".repeat(43);
const CONFIG = {
	dailyCap: 1,
	kinds: {
		gift: { template: "msg-gift", text: "{gift} from {user-name}", priority: 10, repeat: "per_key", send: "asap" },
		streak: { template: "msg-streak", priority: 60, repeat: "daily", allowTemplate: true },
	},
};
const put = (token: string, body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...bearer(token) } });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", ...bearer(ADMIN) } });

describe("notify routes", () => {
	let h: Harness;
	let rev = 1_762_500_000_000;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	const intents = (items: unknown[], token = API) => h.call("/v1/notify/intents", post(token, { v: 1, items }));

	test("auth: game routes take the API key only; admin routes refuse the API key", async () => {
		expect((await intents([], "wrong-key-0123456789abcdef0123456")).status).toBe(401);
		expect((await intents([], ADMIN)).status).toBe(401);
		expect((await h.call("/v1/notify/status", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/notify/status")).status).toBe(401);
		expect((await h.call("/v1/notify/config", put(API, CONFIG))).status).toBe(401);
		expect((await h.call("/v1/notify/opened", { method: "GET", headers: bearer(API) })).status).toBe(405);
	});

	test("before a config push every want is unknown_kind; the push is validated and audited", async () => {
		const r = await asJson(await intents([{ op: "want", u: 1, k: "gift", rev: rev++ }]));
		expect(r).toEqual({ ok: true, accepted: 0, rejected: [{ i: 0, why: "unknown_kind" }], stale: 0 });
		expect((await h.call("/v1/notify/config", put(ADMIN, { kinds: { custom: { priority: 1, repeat: "daily" } } }))).status).toBe(400);
		expect((await h.call("/v1/notify/config", put(ADMIN, CONFIG))).status).toBe(200);
		const got = await asJson(await h.call("/v1/notify/config", { headers: bearer(ADMIN) }));
		expect(got.config.kinds.gift).toMatchObject({ template: "msg-gift", send: "asap" });
		expect(got.by).toBe("admin token");
		const audit = await asJson(await h.call("/v1/admin/audit?action=notify.config", { headers: bearer(ADMIN) }));
		expect(JSON.stringify(audit)).toContain("notify.config");
	});

	test("items: validation per item, rejected with why; plain and gzip JSON", async () => {
		const now = Math.floor(h.now() / 1000);
		const r = await asJson(
			await intents([
				{ op: "want", u: 1, k: "gift", key: "a", params: { gift: "5 coins", "user-name": "Bob" }, data: "mail:1", rev: rev++ },
				{ op: "want", u: 0, k: "gift", rev: rev++ },
				{ op: "want", u: 1, k: "Gift", rev: rev++ },
				{ op: "want", u: 1, k: "gift", key: "x".repeat(65), rev: rev++ },
				{ op: "want", u: 1, k: "gift", params: { gift: "x".repeat(65), "user-name": "b" }, rev: rev++ },
				{ op: "want", u: 1, k: "gift", params: { gift: "x" }, rev: rev++ },
				{ op: "want", u: 1, k: "gift", params: { gift: "x", "user-name": "b", other: "c" }, rev: rev++ },
				{ op: "want", u: 1, k: "gift", params: { gift: "x", "user-name": "b" }, data: "d".repeat(65), rev: rev++ },
				{ op: "want", u: 1, k: "gift", params: { gift: "x", "user-name": "b" }, template: "msg-other", rev: rev++ },
				{ op: "want", u: 1, k: "streak", template: "msg-other", at: now, until: now - 10, rev: rev++ },
				{ op: "want", u: 1, k: "streak", template: "msg-other", rev: 0 },
				{ op: "fly", u: 1 },
				{ op: "presence", u: 2, online: true, at: now },
				{ op: "drop", u: 1, k: "streak", key: "never-wanted", rev: rev++ },
			]),
		);
		expect(r.accepted).toBe(3);
		expect(r.rejected).toEqual([
			{ i: 1, why: "bad_user" },
			{ i: 2, why: "bad_kind" },
			{ i: 3, why: "bad_key" },
			{ i: 4, why: "bad_params" },
			{ i: 5, why: "missing_param" },
			{ i: 6, why: "unknown_param" },
			{ i: 7, why: "bad_data" },
			{ i: 8, why: "template_not_allowed" },
			{ i: 9, why: "bad_time" },
			{ i: 10, why: "bad_rev" },
			{ i: 11, why: "bad_op" },
		]);
		expect((await intents(new Array(201).fill({ op: "presence", u: 1, online: true, at: now }))).status).toBe(400);
		expect((await h.call("/v1/notify/intents", post(API, { v: 2, items: [] }))).status).toBe(400);
		expect((await h.call("/v1/notify/intents", { method: "POST", body: "x".repeat(300 * 1024), headers: bearer(API) })).status).toBe(413);
		const gz = Bun.gzipSync(Buffer.from(JSON.stringify({ v: 1, items: [{ op: "presence", u: 3, online: false, at: now }] })));
		expect(await asJson(await h.call("/v1/notify/intents", { method: "POST", body: gz, headers: { ...bearer(API), "content-encoding": "gzip" } }))).toMatchObject({ accepted: 1 });
	});

	test("prefs items: kind names (any, pushed or not), at most 32 after duplicates go, a rev", async () => {
		const many = Array.from({ length: 33 }, (_, i) => `k${i}`);
		const r = await asJson(
			await intents([
				{ op: "prefs", u: 9, off: ["gift", "streak", "gift", "not_pushed_yet"], rev: rev++ },
				{ op: "prefs", u: 9, off: ["Gift"], rev: rev++ },
				{ op: "prefs", u: 9, off: many, rev: rev++ },
				{ op: "prefs", u: 9, off: [...many.slice(0, 32), "k0"], rev: rev++ },
				{ op: "prefs", u: 9, off: "gift", rev: rev++ },
				{ op: "prefs", u: 9, off: [], rev: 0 },
				{ op: "prefs", u: -1, off: [], rev: rev++ },
				{ op: "prefs", u: 9, off: ["x".repeat(25)], rev: rev++ },
			]),
		);
		expect(r.rejected).toEqual([
			{ i: 1, why: "bad_kind" },
			{ i: 2, why: "too_many" },
			{ i: 4, why: "bad_item" },
			{ i: 5, why: "bad_rev" },
			{ i: 6, why: "bad_user" },
			{ i: 7, why: "bad_kind" },
		]);
		expect(r.accepted).toBe(2);
		const view = await asJson(await h.call("/v1/notify/user?uid=9", { headers: bearer(ADMIN) }));
		expect(view.prefs.off).toEqual(many.slice(0, 32).sort());
	});

	test("stale revs: an older want or drop is accepted and counted, never applied", async () => {
		const newer = rev++;
		await intents([{ op: "want", u: 4, k: "streak", key: "s", rev: newer }]);
		const r = await asJson(await intents([{ op: "drop", u: 4, k: "streak", key: "s", rev: newer - 5 }, { op: "want", u: 4, k: "streak", key: "s", rev: newer }]));
		expect(r).toMatchObject({ accepted: 2, rejected: [], stale: 2 });
		const status = await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }));
		expect(status.kinds.find((k: { kind: string }) => k.kind === "streak").pending).toBe(1);
		// A drop for a key never wanted leaves a tombstone: the older want arriving late is stale.
		const late = await asJson(await intents([{ op: "want", u: 1, k: "streak", key: "never-wanted", rev: 5 }]));
		expect(late.stale).toBe(1);
	});

	test("keys: stored with mode 600, never returned or logged; status says only set / not set", async () => {
		expect((await h.call("/v1/notify/keys", put(ADMIN, { current: "short", since: 1 }))).status).toBe(400);
		const since = Math.floor(h.now() / 1000);
		const r = await h.call("/v1/notify/keys", put(ADMIN, { current: KEY, previous: "p".repeat(43), since }));
		expect(r.status).toBe(200);
		const text = JSON.stringify(await asJson(r));
		expect(text).not.toContain(KEY);
		const file = join(h.dir, "notify-keys.json");
		expect(existsSync(file)).toBe(true);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8")).current).toBe(KEY);
		const status = await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }));
		expect(status.keys).toEqual({ current: true, previous: true, since, env: false });
		expect(JSON.stringify(status)).not.toContain(KEY);
		expect(h.logs.join("\n")).not.toContain(KEY);
		const audit = await asJson(await h.call("/v1/admin/audit", { headers: bearer(ADMIN) }));
		expect(JSON.stringify(audit)).not.toContain(KEY);
	});

	test("status: defaults (enabled, dry run, 50/s, rolling24), kinds with text, the queue", async () => {
		const s = await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }));
		expect(s).toMatchObject({ enabled: true, dryRun: true, rate: 50, clock: "rolling24", configured: { apiKey: false, universe: false }, config: true, halted: [] });
		expect(s.kinds).toEqual([
			{ kind: "gift", enabled: true, template: true, text: "{gift} from {user-name}", pending: 1 },
			{ kind: "streak", enabled: true, template: true, pending: 1 },
		]);
		expect(s.queue).toMatchObject({ pending: 2 });
	});

	test("runtime settings: notify.* keys and the per-kind key through PATCH /v1/admin/settings", async () => {
		const r = await h.call("/v1/admin/settings", patch({ "notify.enabled": false, "notify.kinds.gift.enabled": false, "notify.rate": 20, "notify.clock": "utc_day" }));
		expect(r.status).toBe(200);
		expect((await asJson(r)).changed.sort()).toEqual(["notify.clock", "notify.enabled", "notify.kinds", "notify.rate"]);
		let s = await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }));
		expect([s.enabled, s.rate, s.clock, s.kinds[0].enabled]).toEqual([false, 20, "utc_day", false]);
		expect((await h.call("/v1/admin/settings", patch({ "notify.kinds.gift.enabled": "yes" }))).status).toBe(400);
		expect((await h.call("/v1/admin/settings", patch({ "notify.rate": 0 }))).status).toBe(400);
		// A halted kind: switching it back on clears the halt.
		await h.app.notify.halt("gift", "bad_template");
		expect((await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }))).halted).toHaveLength(1);
		expect((await h.call("/v1/admin/settings", patch({ "notify.kinds.gift.enabled": true, "notify.enabled": null, "notify.rate": null, "notify.clock": null }))).status).toBe(200);
		s = await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }));
		expect([s.enabled, s.halted, s.kinds[0].enabled]).toEqual([true, [], true]);
	});

	test("the halt switches the kind off through the runtime settings, audited as the system", async () => {
		await h.app.notify.halt("streak", "bad_template");
		expect(h.app.settings.get("notify.kinds").streak).toBe(false);
		expect(h.app.settings.audit()[0]).toMatchObject({ who: "system (notify: template not found)", set: ["notify.kinds"] });
		expect(h.logs.some((l) => l.includes("alert: notify kind streak stopped"))).toBe(true);
		await h.call("/v1/admin/settings", patch({ "notify.kinds.streak.enabled": null }));
		expect((await asJson(await h.call("/v1/notify/status", { headers: bearer(ADMIN) }))).halted).toEqual([]);
	});

	test("the planner and sender write rows into the events (dry run), pid from identities, no UserId", async () => {
		await h.call("/v1/identity", post(API, { identities: [{ pid: "player-one", uid: 1, t: h.now() }] }));
		await h.app.notify.planTick();
		await h.app.notify.sendTick();
		await h.app.load();
		const r = await asJson(await h.call("/v1/sql", post(ADMIN, { sql: "SELECT name, pid, src, props FROM events WHERE kind = 'notify' ORDER BY t, name" })));
		const rows = (r.rows as string[][]).map(([name, pid, src, props]) => ({ name, pid, src, props }));
		expect(rows.map((x) => x.name)).toContain("sent");
		const sent = rows.find((x) => x.name === "sent" && x.pid === "player-one");
		expect(sent?.src).toBe("backend");
		expect(JSON.parse(sent?.props ?? "{}")).toMatchObject({ k: "gift", dry: true });
	});

	test("test send (admin): bypasses the caps; a viewer can't; opened / played answer the game", async () => {
		const t = await asJson(await h.call("/v1/notify/test", post(ADMIN, { userId: 1, kind: "streak" })));
		expect(t.status).toBe("planned");
		expect((await h.call("/v1/notify/test", post(ADMIN, { userId: 1, kind: "nope" }))).status).toBe(400);
		expect(await asJson(await h.call("/v1/notify/opened", post(API, { nid: t.nid, u: 1 })))).toEqual({ state: "first" });
		expect(await asJson(await h.call("/v1/notify/opened", post(API, { nid: "zzzzzzzzzz", u: 1 })))).toEqual({ state: "unknown" });
		expect((await h.call("/v1/notify/opened", post(API, { nid: "BAD", u: 1 }))).status).toBe(400);
		expect(await asJson(await h.call("/v1/notify/played", post(API, { nid: t.nid, u: 1, secs: 61 })))).toEqual({ ok: true });
		expect((await h.call("/v1/notify/played", post(API, { nid: t.nid, u: 1, secs: -1 }))).status).toBe(400);
	});

	test("the per-player view: consent rows with dates, sends with opens and plays, intents; by uid, pid or name", async () => {
		const t = h.now();
		const row = (name: string, props: object, dt: number) => ({ v: 1, t: t + dt, kind: "notify", name, pid: "player-one", sid: "s1", job: "job-1", art: "a1", src: "server", props: JSON.stringify(props) });
		const ingest = await h.call(
			"/v1/ingest",
			post(API, { events: [row("optin_check", { can: true, where: "shop" }, -3000), row("optin_shown", { where: "shop" }, -2000), row("optin_closed", { where: "shop", secs: 4, err: "timeout" }, -1000)] }),
		);
		expect(ingest.status).toBe(202);
		await h.app.load();
		const r = await h.call("/v1/notify/user?uid=1", { headers: bearer(ADMIN) });
		expect(r.status).toBe(200);
		const v = await asJson(r);
		expect(v).toMatchObject({ userId: 1, known: true, pids: ["player-one"] });
		expect(v.sends.length).toBeGreaterThan(0);
		expect(v.sends.find((x: { test: boolean }) => x.test)).toMatchObject({ kind: "streak", openedAt: expect.any(Number), playedSecs: 61 });
		expect(v.intents.length).toBeGreaterThan(0);
		const names = v.events.rows.map((x: { name: string }) => x.name);
		expect(names).toEqual(expect.arrayContaining(["optin_check", "optin_shown", "optin_closed"]));
		expect(v.events.rows.find((x: { name: string }) => x.name === "optin_closed")).toMatchObject({ where: "shop", secs: 4, err: "timeout" });
		expect(v.events.rows.find((x: { name: string }) => x.name === "optin_check")).toMatchObject({ can: "true", where: "shop" });
		expect((await asJson(await h.call("/v1/notify/user?pid=player-one", { headers: bearer(ADMIN) }))).userId).toBe(1);
		expect((await h.call("/v1/notify/user?name=nobody_known", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/notify/user", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/notify/user?uid=1", { headers: bearer(API) })).status).toBe(401);
	});

	test("the recent table: newest sends of everyone, a kind filter, limits, owners only", async () => {
		const a = await asJson(await h.call("/v1/notify/test", post(ADMIN, { userId: 7, kind: "streak" })));
		const b = await asJson(await h.call("/v1/notify/test", post(ADMIN, { userId: 8, kind: "streak" })));
		const r = await h.call("/v1/notify/recent?limit=2", { headers: bearer(ADMIN) });
		expect(r.status).toBe(200);
		const v = await asJson(r);
		expect(v.sends).toHaveLength(2);
		expect(v.sends.map((x: { nid: string }) => x.nid).sort()).toEqual([a.nid, b.nid].sort());
		expect(v.sends[0]).toMatchObject({ kind: "streak", test: true, userId: expect.any(Number), name: null });
		expect((await asJson(await h.call("/v1/notify/recent?kind=nope", { headers: bearer(ADMIN) }))).sends).toEqual([]);
		expect((await h.call("/v1/notify/recent?limit=0", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/notify/recent?limit=501", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/notify/recent?kind=Bad-Kind", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/notify/recent", { headers: bearer(API) })).status).toBe(401);
	});

	test("the opt-in list: counts, keyset pages per state, search, CSV, owners only", async () => {
		const now = h.now();
		const db = h.app.notify.db;
		// 5 subscribed (one this week), 2 not subscribed (muted), 3 unknown
		for (let i = 0; i < 5; i++) await db.run("INSERT OR REPLACE INTO notify_users (user_id, optin, optin_at, last_seen, created) VALUES (?, 'subscribed', ?, ?, ?)", [9000 + i, now - (i === 0 ? 1 : 10) * 86_400_000 - i, now, now]);
		for (let i = 0; i < 2; i++) await db.run("INSERT OR REPLACE INTO notify_users (user_id, optin, optin_at, mute_until, created) VALUES (?, 'not_subscribed', ?, ?, ?)", [9100 + i, now - 1000, now + 86_400_000 + i, now]);
		for (let i = 0; i < 3; i++) await db.run("INSERT OR REPLACE INTO notify_users (user_id, created) VALUES (?, ?)", [9200 + i, now]);
		await db.run("INSERT INTO notify_sends (nid, user_id, kind, key, planned_at, sent_at, status, opened_at, test, created, updated) VALUES ('optinlist1', 9000, 'gift', 'a', ?, ?, 'sent', ?, 0, ?, ?)", [now, now, now, now, now]);
		await db.run("INSERT INTO notify_sends (nid, user_id, kind, key, planned_at, sent_at, status, test, created, updated) VALUES ('optinlist2', 9000, 'gift', 'b', ?, ?, 'sent', 1, ?, ?)", [now, now, now, now]);
		const get = (qs: string, token = ADMIN) => h.call(`/v1/notify/users${qs}`, { headers: bearer(token) });

		const first = await asJson(await get("?state=subscribed&limit=2"));
		expect(first.counts.subscribed).toBeGreaterThanOrEqual(5);
		expect(first.counts.newThisWeek).toBeGreaterThanOrEqual(1);
		expect(first.counts.muted).toBeGreaterThanOrEqual(2);
		expect(first.users).toHaveLength(2);
		expect(first.users[0]).toMatchObject({ userId: 9000, optin: "subscribed", sends: 1, opened: 1, name: null, muteUntil: null });
		expect(typeof first.next).toBe("string");
		// walk every page: each player once, newest optin_at first
		const seen: number[] = first.users.map((u: { userId: number }) => u.userId);
		let next = first.next as string | null;
		while (next) {
			const page = await asJson(await get(`?state=subscribed&limit=2&cursor=${encodeURIComponent(next)}`));
			seen.push(...page.users.map((u: { userId: number }) => u.userId));
			next = page.next;
		}
		const mine = seen.filter((u) => u >= 9000 && u < 9100);
		expect(mine).toEqual([9000, 9001, 9002, 9003, 9004]);
		expect(new Set(seen).size).toBe(seen.length);

		const muted = await asJson(await get("?state=muted"));
		expect(muted.users.filter((u: { userId: number }) => u.userId >= 9100 && u.userId < 9200).map((u: { userId: number }) => u.userId)).toEqual([9101, 9100]);
		expect(muted.users[0].muteUntil).toBeGreaterThan(now);
		const unknown = await asJson(await get("?state=unknown&limit=200"));
		expect(unknown.users.map((u: { userId: number }) => u.userId)).toEqual(expect.arrayContaining([9200, 9201, 9202]));
		expect(unknown.users.every((u: { optin: unknown }) => u.optin === null)).toBe(true);
		expect((await asJson(await get("?state=not_subscribed&q=9101"))).users.map((u: { userId: number }) => u.userId)).toEqual([9101]);
		expect((await asJson(await get("?state=subscribed&q=9101"))).users).toEqual([]);
		expect((await asJson(await get("?q=nobody_cached"))).users).toEqual([]);

		for (const bad of ["?state=all", "?limit=0", "?limit=201", "?cursor=x", "?format=xml", "?q=%3Cscript%3E"]) expect((await get(bad)).status).toBe(400);
		expect((await get("", API)).status).toBe(401);
		expect((await get("")).status).toBe(200);
		expect((await h.call("/v1/notify/users", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);

		const csv = await get("?state=subscribed&format=csv");
		expect(csv.status).toBe(200);
		expect(csv.headers.get("content-type")).toContain("text/csv");
		expect(csv.headers.get("content-disposition")).toContain("notify-subscribed.csv");
		const lines = (await csv.text()).trim().split("\n");
		expect(lines[0]).toBe("user_id,name,state,optin_at,last_seen,online,mute_until,sends,opened");
		expect(lines.some((l) => l.startsWith("9000,,subscribed,"))).toBe(true);
		const audit = await asJson(await h.call("/v1/admin/audit?action=notify.users.export", { headers: bearer(ADMIN) }));
		expect(JSON.stringify(audit)).toContain("notify.users.export");
		expect(JSON.stringify(audit)).not.toContain("9000");

		// The pages walk an index (no sort of the whole table)
		for (const sql of [
			"SELECT * FROM notify_users WHERE optin = 'subscribed' AND (optin_at < 5 OR (optin_at = 5 AND user_id < 3)) ORDER BY optin_at DESC, user_id DESC LIMIT 10",
			"SELECT * FROM notify_users WHERE optin IS NULL AND optin_at IS NULL AND user_id < 3 ORDER BY optin_at DESC, user_id DESC LIMIT 10",
			"SELECT * FROM notify_users WHERE mute_until > 5 ORDER BY mute_until DESC, user_id DESC LIMIT 10",
		]) {
			const plan = JSON.stringify(await db.all(`EXPLAIN QUERY PLAN ${sql}`, []));
			expect(plan).not.toContain("TEMP B-TREE");
		}
		await db.run("DELETE FROM notify_users WHERE user_id >= 9000 AND user_id < 9300");
		await db.run("DELETE FROM notify_sends WHERE nid IN ('optinlist1', 'optinlist2')");
	});

	test("the recent table carries each player's opt-in state and the send's params", async () => {
		await h.app.notify.db.run("UPDATE notify_users SET optin = 'subscribed', optin_at = ? WHERE user_id = 7", [h.now()]);
		const v = await asJson(await h.call("/v1/notify/recent?limit=50", { headers: bearer(ADMIN) }));
		const row = v.sends.find((x: { userId: number }) => x.userId === 7);
		expect(row).toMatchObject({ optin: "subscribed", params: null });
	});

	test("until must be after at; presence `at` in ms", async () => {
		const now = Math.floor(h.now() / 1000);
		const r = await asJson(await intents([{ op: "want", u: 1, k: "streak", key: "eq", at: now, until: now, rev: rev++ }, { op: "presence", u: 9, online: true, at: h.now() }]));
		expect(r.rejected).toEqual([{ i: 0, why: "bad_time" }]);
		expect(Number((await h.app.notify.store.user(9))?.presence_at)).toBe(h.now());
	});

	test("erasure by pid removes the user's notification rows", async () => {
		expect(await h.app.notify.store.user(1)).toBeDefined();
		const r = await h.call("/v1/erasure", post(ADMIN, { pid: "player-one" }));
		expect(r.status).toBe(200);
		expect(await h.app.notify.store.user(1)).toBeUndefined();
		expect(await h.app.notify.store.pendingIntents(1)).toEqual([]);
	});
});
