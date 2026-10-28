/**
 * The audit log (server/audit.ts and its one hook in app.ts): what is recorded for sign-ins, sign-outs, lockouts,
 * settings, the owner list, viewers, alert acks, erasure, the CLI's release marks and refused writes; that secrets never
 * reach it; who may read it (owners only, behind the allow list); filters, pages and retention. Every token, URL and
 * address is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact, routeAction, settingChanges } from "../src/server/audit.ts";
import { ADMIN, API, T0, asJson, bearer, cookieOf, harness, json, post, type Harness } from "./harness.ts";

const LOOKUP = "lookup-token-for-tests-0123456789abcdef0";
const HOOK = "https://hooks.example.test/webhooks/333/fake-audit-webhook-secret-CCCC";
const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };
const OWNER = 7007;
const VIEWER = 8008;
const DAY = 86_400_000;

type Entry = { id: number; actor: string; actorKind: string; role: string; via: string; ip: string; action: string; outcome: string; status: number | null; details: Record<string, any> | null };

describe("audit log helpers", () => {
	test("redact: known secret values anywhere, secret-looking keys, long strings, deep and long values", () => {
		const secret = "super-secret-value-0123456789";
		const out = redact({ a: `see ${secret} here`, nested: { list: [secret, "fine"] }, adminToken: "anything", webhookUrl: "https://x.test", note: "x".repeat(500), deep: { a: { b: { c: { d: { e: 1 } } } } }, many: Array.from({ length: 60 }, (_, i) => i) }, [secret]) as Record<string, any>;
		expect(out.a).toBe("[redacted]");
		expect(out.nested.list).toEqual(["[redacted]", "fine"]);
		expect(out.adminToken).toBe("[redacted]");
		expect(out.webhookUrl).toBe("[redacted]");
		expect(out.note).toHaveLength(200);
		expect(JSON.stringify(out.deep)).toContain("[...]");
		expect(out.many).toHaveLength(51);
		expect(JSON.stringify(out)).not.toContain(secret);
		// Short "secrets" (an unset value, a stray word) don't blank everything.
		expect(redact({ a: "abc" }, ["", "ab", undefined])).toEqual({ a: "abc" });
	});

	test("routeAction: friendly names for known writes, ids folded out of the rest", () => {
		expect(routeAction("POST", "/v1/fleet/alerts/12/ack")).toEqual({ action: "alert.ack", details: { alert: 12 } });
		expect(routeAction("POST", "/v1/fleet/servers/job-9/commands")).toEqual({ action: "debug.command", details: { job: "job-9" } });
		expect(routeAction("POST", "/v1/fleet/mark").action).toBe("deploy.mark");
		expect(routeAction("DELETE", "/v1/things/0123456789abcdef")).toEqual({ action: "DELETE /v1/things/:id", details: { path: "/v1/things/0123456789abcdef" } });
		expect(routeAction("POST", "/v1/identity/backfill")).toEqual({ action: "POST /v1/identity/backfill" });
	});

	test("settingChanges: old and new values, lists as added / removed, the secret as set / not set", () => {
		const before: Record<string, unknown> = { alertWebhookUrl: "", ipPerMinute: 6000, webViewers: [1, 2] };
		const after: Record<string, unknown> = { alertWebhookUrl: HOOK, ipPerMinute: 8000, webViewers: [2, 3] };
		const changes = settingChanges(["alertWebhookUrl", "ipPerMinute", "webViewers"], (k) => before[k], (k) => after[k], () => "dashboard");
		expect(changes).toEqual([
			{ key: "alertWebhookUrl", from: "not set", to: "set", source: "dashboard" },
			{ key: "ipPerMinute", from: 6000, to: 8000, source: "dashboard" },
			{ key: "webViewers", added: [3], removed: [1], source: "dashboard" },
		]);
		expect(JSON.stringify(changes)).not.toContain("hooks.example.test");
	});
});

describe("the audit log in the server", () => {
	let h: Harness;
	let owner: Record<string, string>;
	let viewer: Record<string, string>;
	const entries = async (query = "", headers: Record<string, string> = bearer(ADMIN)): Promise<Entry[]> => (await asJson(await h.call(`/v1/admin/audit${query}`, { headers }))).entries as Entry[];
	const latest = async (action: string) => (await entries(`?action=${encodeURIComponent(action)}&limit=1`))[0] as Entry;

	beforeAll(async () => {
		h = await harness({ TYPETORCH_LOOKUP_TOKEN: LOOKUP, TYPETORCH_WEB_VIEWERS: String(VIEWER), TYPETORCH_LOGIN_MAX_FAILURES: "3" }, { fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [OWNER] }), headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(200);
		owner = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: OWNER, name: "Owner_Name" }, "admin")}`, ...XT };
		viewer = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}`, ...XT };
	});
	afterAll(() => h.close());

	test("the owner list: who, the seq, who was added", async () => {
		const e = await latest("access.owners");
		expect(e).toMatchObject({ actor: "admin token", actorKind: "token", role: "admin", via: "bearer", outcome: "ok", status: 200, ip: "127.0.0.1" });
		expect(e.details).toMatchObject({ seq: 1, added: [OWNER], removed: [] });
		// A stale seq is refused and recorded as such.
		expect((await h.call("/v1/access", { method: "PUT", ...json({ seq: 0, owners: [] }), headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(409);
		expect(await latest("access.owners")).toMatchObject({ outcome: "refused", status: 409 });
	});

	test("token sign-in: success with the method and address, failures, the lockout; sign-out", async () => {
		const ip = "198.51.100.20";
		const ok = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { ...JSON_TYPE, ...XT }, ip });
		expect(ok.status).toBe(200);
		expect(await latest("sign-in")).toMatchObject({ actor: "admin token", role: "admin", via: "cookie", ip, outcome: "ok", details: { method: "token", role: "admin" } });
		const cookie = cookieOf(ok) as string;
		expect((await h.call("/v1/auth/logout", { method: "POST", headers: { cookie, ...XT }, ip })).status).toBe(200);
		expect(await latest("sign-out")).toMatchObject({ actor: "admin token", ip, outcome: "ok" });

		const bad = "198.51.100.21";
		for (let i = 0; i < 3; i++) expect((await h.call("/v1/auth/login", { method: "POST", ...json({ token: "not-the-admin-token-0123456789abcdef" }), headers: { ...JSON_TYPE, ...XT }, ip: bad })).status).toBe(401);
		const failed = (await entries(`?action=sign-in&outcome=failed`)).filter((e) => e.ip === bad);
		expect(failed).toHaveLength(3);
		expect(failed[0]).toMatchObject({ actor: "anonymous", actorKind: "anonymous", role: "none", details: { method: "token", what: "admin login" } });
		expect(await latest("sign-in.lockout")).toMatchObject({ ip: bad, outcome: "refused", details: { failures: 3 } });
		// A wrong Bearer on an admin route counts the same way.
		await h.call("/v1/queries", { headers: bearer("wrong-bearer-token-0123456789abcdef0"), ip: "198.51.100.22" });
		expect((await entries("?action=sign-in&outcome=failed")).find((e) => e.ip === "198.51.100.22")?.details).toMatchObject({ method: "bearer" });
	});

	test("a settings save: the keys with old and new values, the webhook only as set; refusals too", async () => {
		const res = await h.call("/v1/admin/settings", { method: "PATCH", ...json({ alertWebhookUrl: HOOK, ipPerMinute: 8000, webViewers: [VIEWER, 9009] }), headers: { ...JSON_TYPE, ...owner } });
		expect(res.status).toBe(200);
		const e = await latest("settings.change");
		expect(e).toMatchObject({ actor: `roblox user ${OWNER} (Owner_Name)`, actorKind: "roblox", role: "admin", via: "cookie", outcome: "ok" });
		expect(e.details?.changes).toEqual([
			{ key: "alertWebhookUrl", from: "not set", to: "set", source: "dashboard" },
			{ key: "webViewers", added: [9009], removed: [], source: "dashboard" },
			{ key: "ipPerMinute", from: 6000, to: 8000, source: "dashboard" },
		]);
		// The lockout guard's refusal is recorded (its message names the rule, never a value).
		expect((await h.call("/v1/admin/settings", { method: "PATCH", ...json({ adminAllowIps: ["10.9.9.9"] }), headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(409);
		expect(await latest("settings.change")).toMatchObject({ actor: "admin token", outcome: "refused", status: 409, details: { key: "adminAllowIps", guard: "allow-list" } });
		expect((await h.call("/v1/admin/settings/test-alert", { method: "POST", headers: bearer(ADMIN) })).status).toBe(200);
		expect(await latest("settings.test-alert")).toMatchObject({ outcome: "ok", details: { result: "sent (HTTP 204)" } });
	});

	test("alert acks, erasure (counts, never the pids), the CLI's marks, a refused write by the web role", async () => {
		expect((await h.call("/v1/fleet/alert", post(API, { level: "warning", code: "audit_test", message: "m", j: "job-audit" }))).status).toBe(202);
		const alerts = (await asJson(await h.call("/v1/fleet/alerts", { headers: bearer(ADMIN) }))).alerts as { id: number }[];
		const id = alerts[0]?.id as number;
		expect((await h.call(`/v1/fleet/alerts/${id}/ack`, { method: "POST", ...json({}), headers: { ...JSON_TYPE, ...owner } })).status).toBe(200);
		expect(await latest("alert.ack")).toMatchObject({ actor: `roblox user ${OWNER} (Owner_Name)`, outcome: "ok", details: { alert: id } });

		expect((await h.call("/v1/erasure", { method: "POST", ...json({ pids: ["pid-erase-a", "pid-erase-b"] }), headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(200);
		const erased = await latest("erasure");
		expect(erased).toMatchObject({ actor: "admin token", outcome: "ok", details: { source: "admin", pids: 2 } });
		expect(JSON.stringify(erased)).not.toContain("pid-erase-a");

		expect((await h.call("/v1/fleet/mark", post(API, { j: "cli", k: "kernel", v: "0.4.0", pv: 23, t: T0 }))).status).toBe(202);
		expect(await latest("deploy.mark")).toMatchObject({ actor: "api key", actorKind: "api-key", role: "game", via: "bearer", outcome: "ok" });
		// Game writes that aren't release events (heartbeats, alerts) are not admin actions.
		expect(await entries("?action=POST%20/v1/fleet/alert")).toEqual([]);

		expect((await h.call("/v1/identity/backfill", { method: "POST", headers: viewer })).status).toBe(403);
		expect(await latest("POST /v1/identity/backfill")).toMatchObject({ actor: `roblox user ${VIEWER} (Viewer)`, role: "web", outcome: "refused", status: 403 });
	});

	test("no secret reaches the log, the SQLite file or the server's log lines", async () => {
		const all = JSON.stringify(await entries("?limit=500"));
		for (const secret of [ADMIN, API, LOOKUP, HOOK, "fake-audit-webhook-secret-CCCC", "not-the-admin-token", "wrong-bearer-token"]) expect(all).not.toContain(secret);
		const file = readFileSync(join(h.dir, "fleet.sqlite")).toString("latin1") + (() => {
			try {
				return readFileSync(join(h.dir, "fleet.sqlite-wal")).toString("latin1");
			} catch {
				return "";
			}
		})();
		expect(file).not.toContain("fake-audit-webhook-secret-CCCC");
		expect(h.logs.join("\n")).not.toContain("fake-audit-webhook-secret-CCCC");
	});

	test("owners only: the web role, the lookup token, the game key and no credentials are refused; the allow list hides it", async () => {
		expect((await h.call("/v1/admin/audit", { headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/v1/admin/audit", { headers: owner })).status).toBe(200);
		expect((await h.call("/v1/admin/audit", { headers: viewer })).status).toBe(403);
		expect((await h.call("/v1/admin/audit", { headers: bearer(LOOKUP) })).status).toBe(403);
		expect((await h.call("/v1/admin/audit", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/admin/audit")).status).toBe(401);
		expect((await h.call("/v1/admin/audit", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		const allow = await harness({ TYPETORCH_ADMIN_ALLOW_IPS: "127.0.0.1" });
		try {
			expect((await allow.call("/v1/admin/audit", { headers: bearer(ADMIN), ip: "203.0.113.50" })).status).toBe(404);
			expect((await allow.call("/v1/admin/audit", { headers: bearer(ADMIN) })).status).toBe(200);
		} finally {
			await allow.close();
		}
	});

	test("filters, pages, facets; bad parameters are 400", async () => {
		const byOwner = await entries(`?actor=${encodeURIComponent(`roblox user ${OWNER} (Owner_Name)`)}`);
		expect(byOwner.length).toBeGreaterThan(0);
		expect(byOwner.every((e) => e.actor === `roblox user ${OWNER} (Owner_Name)`)).toBe(true);
		const settings = await entries("?action=settings.*");
		expect(new Set(settings.map((e) => e.action))).toEqual(new Set(["settings.change", "settings.test-alert"]));
		const first = await asJson(await h.call("/v1/admin/audit?limit=2&facets=1", { headers: bearer(ADMIN) }));
		expect(first.entries).toHaveLength(2);
		expect(first.entries[0].id).toBeGreaterThan(first.entries[1].id);
		expect(first.keepDays).toBe(365);
		expect(first.facets.actions.map((a: { action: string }) => a.action)).toContain("sign-in");
		expect(first.facets.actors.map((a: { actor: string }) => a.actor)).toContain("admin token");
		const second = await entries(`?limit=2&before=${first.next}`);
		expect(second[0]?.id).toBeLessThan(first.entries[1].id);
		for (const bad of ["?nope=1", "?limit=0", "?limit=501", "?outcome=maybe", "?since=yesterday", "?action=%3Cscript%3E", "?before=-1", "?limit=1&limit=2"]) {
			expect(`${bad} ${(await h.call(`/v1/admin/audit${bad}`, { headers: bearer(ADMIN) })).status}`).toBe(`${bad} 400`);
		}
	});

	test("retention: a runtime setting; old entries are pruned", async () => {
		const view = await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }));
		expect(view.settings.find((s: { key: string }) => s.key === "auditKeepDays")).toMatchObject({ value: 365, group: "retention", min: 7 });
		const before = await h.app.audit.count();
		expect(before).toBeGreaterThan(5);
		expect((await h.call("/v1/admin/settings", { method: "PATCH", ...json({ auditKeepDays: 7 }), headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(200);
		h.setNow(T0 + 8 * DAY);
		expect(await h.app.audit.prune(true)).toBeGreaterThanOrEqual(before);
		const left = await entries();
		expect(left.every((e) => e.action !== "access.owners")).toBe(true);
		h.setNow(T0);
	});
});

describe("the audit log's bounds", () => {
	test("entries without a signed-in caller are capped per minute and counted in one entry", async () => {
		const h = await harness({ TYPETORCH_LOGIN_MAX_FAILURES: "1000" });
		try {
			for (let i = 0; i < 130; i++) await h.call("/v1/auth/login", { method: "POST", ...json({ token: "not-the-admin-token-0123456789abcdef" }), headers: { ...JSON_TYPE, ...XT }, ip: `198.51.100.${i % 200}` });
			expect(await h.app.audit.count()).toBe(120);
			expect(h.app.audit.counters.suppressed).toBe(10);
			h.setNow(T0 + 61_000);
			await h.call("/v1/auth/login", { method: "POST", ...json({ token: "not-the-admin-token-0123456789abcdef" }), headers: { ...JSON_TYPE, ...XT } });
			const page = await h.app.audit.list({ action: "audit.suppressed" });
			expect(page.entries[0]).toMatchObject({ actorKind: "system", details: { entries: 10 } });
		} finally {
			await h.close();
		}
	});
});
