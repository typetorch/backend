/**
 * The synthetic notify rows (mock/notify-rows.ts) behind the Notifications page's analytics tabs: the funnel, the opt-in
 * prompt and the sender queue have data, game-server rows sit inside real sessions (they never stretch one), backend
 * rows look like the backend's, and nothing carries a UserId.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NotifyFunnelResult } from "../../../src/queries/notify-funnel.ts";
import type { NotifyOptinResult } from "../../../src/queries/notify-optin.ts";
import type { NotifyQueueResult } from "../../../src/queries/notify-queue.ts";
import { sql } from "../mock/engine";
import { notifyWorld } from "../mock/notify";
import { describeWithPack, setupDemo, teardownDemo, testApi, TEST_NOW } from "./harness";

describeWithPack("notify rows", () => {
	beforeAll(() => setupDemo({ engine: true }));
	afterAll(() => teardownDemo());

	it("fills the funnel with the notify world's kinds", async () => {
		const funnel = (await testApi().raw("notify-funnel", { filters: {}, options: {} })).result as NotifyFunnelResult;
		const t = funnel.totals;
		expect(t.wants).toBeGreaterThan(50);
		expect(t.planned).toBeGreaterThan(100);
		expect(t.sent).toBeGreaterThan(100);
		expect(t.opened).toBeGreaterThan(5);
		expect(t.opened).toBeLessThanOrEqual(t.sent);
		expect(t.played).toBeLessThanOrEqual(t.opened);
		expect(t.returnedD1).toBeGreaterThan(0);
		const world = await notifyWorld();
		const kinds = new Set(world.sends.map((s) => s.kind));
		for (const k of funnel.kinds) expect(kinds.has(k.kind)).toBe(true);
		expect(funnel.kinds.length).toBeGreaterThanOrEqual(4);
	});

	it("fills the opt-in prompt and the sender queue", async () => {
		const optin = (await testApi().raw("notify-optin", { filters: {}, options: {} })).result as NotifyOptinResult;
		expect(optin.totals.checks).toBeGreaterThan(500);
		expect(optin.totals.shown).toBeGreaterThan(100);
		expect(optin.totals.subscribed).toBeGreaterThan(20);
		expect(optin.totals.notSubscribed).toBeGreaterThan(5);
		expect(optin.byWhere.map((w) => w.where)).toContain("after_escape");
		const queue = (await testApi().raw("notify-queue", { filters: { from: new Date(TEST_NOW - 6 * 86_400_000).toISOString().slice(0, 10) }, options: {} })).result as NotifyQueueResult;
		expect(queue.totals.sent).toBeGreaterThan(20);
		expect(queue.totals.failed).toBeGreaterThan(0);
		expect(queue.totals.skipped).toBeGreaterThan(0);
		expect(queue.failures.some((f) => f.http === 400 && f.code === "FAILED_PRECONDITION")).toBe(true);
		expect(queue.planned.length).toBeGreaterThan(0);
	});

	it("keeps game-server rows inside their sessions and backend rows like the backend's", async () => {
		const outside = await sql(
			`WITH s AS (SELECT sid, MIN(t) AS t0, MAX(t) AS t1 FROM _tt_events WHERE kind <> 'notify' AND sid <> '' GROUP BY sid) ` +
				`SELECT COUNT(*) AS n FROM _tt_events e LEFT JOIN s ON s.sid = e.sid WHERE e.kind = 'notify' AND e.sid <> '' AND (s.sid IS NULL OR e.t < s.t0 OR e.t > s.t1)`,
		);
		expect(Number(outside[0]?.n)).toBe(0);
		const backend = await sql(`SELECT DISTINCT job, art, src, sid FROM _tt_events WHERE kind = 'notify' AND name IN ('planned', 'sent', 'failed', 'skipped', 'optin_inferred')`);
		expect(backend).toEqual([{ job: "backend", art: "backend", src: "backend", sid: "" }]);
		const ids = await sql(`SELECT COUNT(*) AS n FROM _tt_events WHERE kind = 'notify' AND (props LIKE '%uid%' OR props LIKE '%userId%' OR props LIKE '%9000000%')`);
		expect(Number(ids[0]?.n)).toBe(0);
	});
});
