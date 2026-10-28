/**
 * The deploy history: every release (POST /v1/fleet/deploy, or one known from its reports) with its outcome, paged newest
 * first (GET /v1/fleet/deploys), one release with its report and alerts (GET /v1/fleet/deploys/<seq>), counts frozen onto
 * the row before the reports go, and the retention setting. All tokens are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSqlite } from "../src/fleet/db.ts";
import { deployOutcome, DEPLOY_ERRORS_KEPT, DEPLOY_ERROR_TEXT_MAX } from "../src/fleet/deploys.ts";
import { FleetService, KEEP_REPORTS_MS, parseDeploy, STUCK_WINDOW_MS } from "../src/fleet/service.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

async function service(clock: () => number, extra: Partial<Parameters<typeof FleetService.open>[0]> = {}) {
	return FleetService.open({ db: await openSqlite(":memory:"), clock, ...extra });
}

const heartbeat = (j: string, seq: number, branch = "prod") => ({ j, t: "public", b: branch, a: `art-${seq}`, n: 3, m: 10, s: Math.floor(T0 / 1000) - 600, u: Math.floor(T0 / 1000), p: 1, v: "0.5.3", q: seq, g: 1, h: "ok", sv: 2 });

describe("parsing and outcomes", () => {
	test("`by` names who started a release (at most 64 characters)", () => {
		expect(parseDeploy({ s: 1, b: "prod", by: "alice" })).toMatchObject({ by: "alice" });
		expect(parseDeploy({ s: 1, b: "prod" })).toMatchObject({ by: null });
		expect(() => parseDeploy({ s: 1, b: "prod", by: "x".repeat(65) })).toThrow(/at most 64/);
		expect(() => parseDeploy({ s: 1, b: "prod", by: 7 })).toThrow(/by must be a string/);
	});

	test("the outcome from the counts", () => {
		const at = T0;
		expect(deployOutcome({ reported: 0, ok: 0, failed: 0, stuck: 0 }, at, at + MIN, STUCK_WINDOW_MS)).toBe("pending");
		expect(deployOutcome({ reported: 0, ok: 0, failed: 0, stuck: 0 }, at, at + STUCK_WINDOW_MS, STUCK_WINDOW_MS)).toBe("no_reports");
		expect(deployOutcome({ reported: 3, ok: 3, failed: 0, stuck: 0 }, at, at, STUCK_WINDOW_MS)).toBe("ok");
		expect(deployOutcome({ reported: 3, ok: 2, failed: 1, stuck: 0 }, at, at, STUCK_WINDOW_MS)).toBe("partial");
		expect(deployOutcome({ reported: 2, ok: 0, failed: 2, stuck: 1 }, at, at, STUCK_WINDOW_MS)).toBe("failed");
		expect(deployOutcome({ reported: 2, ok: 2, failed: 0, stuck: 1 }, at, at, STUCK_WINDOW_MS)).toBe("stuck");
	});
});

describe("the service", () => {
	test("every release newest first with its counts, errors and who started it; pages by seq", async () => {
		let now = T0;
		const fleet = await service(() => now);
		await fleet.deploy({ s: 40, b: "prod", a: "art-40", ch: "prod", k: "deploy", by: "alice", t: T0 - 3 * HOUR });
		await fleet.deploy({ s: 41, b: "prod", a: "art-41", ch: "prod", k: "deploy", fr: "art-40", m: "new shop", by: "ci", t: T0 - 2 * HOUR });
		for (const [j, r, e] of [
			["job-1", "swapped", null],
			["job-2", "booted", null],
			["job-3", "failed", "attempt to index nil"],
			["job-4", "failed", "attempt to index nil"],
			["job-5", "rolled_back", "load timeout"],
		] as const)
			await fleet.report({ s: 41, j, r, b: "prod", a: "art-41", ...(e ? { e } : {}) });
		await fleet.report({ s: 41, j: "job-4", r: "swapped", b: "prod", a: "art-41" }); // a retry: its newest report counts
		await fleet.deploy({ s: 42, b: "prod", a: "art-40", ch: "prod", k: "rollback", fr: "art-41", by: "auto_rollback", t: T0 - HOUR });
		await fleet.report({ s: 43, j: "job-9", r: "swapped", b: "dev", a: "art-43" }); // known from its report only

		const page = await fleet.deployHistory();
		expect(page.next).toBeNull();
		expect(page.deploys.map((d) => d.seq)).toEqual([43, 42, 41, 40]);
		const [inferred, rollback, d41, d40] = page.deploys;
		expect(inferred).toMatchObject({ kind: "deploy", inferred: true, branch: "dev", startedBy: null, reported: 1, ok: 1, outcome: "ok", frozen: false });
		expect(rollback).toMatchObject({ kind: "rollback", from: "art-41", startedBy: "auto_rollback", at: T0 - HOUR, reported: 0, outcome: "no_reports" });
		expect(d41).toMatchObject({
			seq: 41,
			artifact: "art-41",
			from: "art-40",
			message: "new shop",
			startedBy: "ci",
			startedAt: new Date(T0 - 2 * HOUR).toISOString(),
			reported: 5,
			ok: 3,
			failed: 2,
			results: { swapped: 2, booted: 1, failed: 1, rolled_back: 1 },
			errors: [
				{ error: "attempt to index nil", servers: 1 },
				{ error: "load timeout", servers: 1 },
			],
			errorKinds: 2,
			outcome: "partial",
		});
		expect(d40).toMatchObject({ startedBy: "alice", outcome: "no_reports" });

		// Pages: `next` is the last seq of the page, `before` takes it.
		const first = await fleet.deployHistory({ limit: 2 });
		expect(first.deploys.map((d) => d.seq)).toEqual([43, 42]);
		expect(first.next).toBe(42);
		const second = await fleet.deployHistory({ limit: 2, before: 42 });
		expect(second.deploys.map((d) => d.seq)).toEqual([41, 40]);
		expect(second.next).toBeNull();
		expect((await fleet.deployHistory({ branch: "dev" })).deploys.map((d) => d.seq)).toEqual([43]);
		expect((await fleet.deployHistory({ limit: 10_000 })).deploys).toHaveLength(4);

		// A later post without `by` keeps the one known.
		await fleet.deploy({ s: 41, b: "prod", a: "art-41", k: "deploy", t: T0 - 2 * HOUR });
		expect((await fleet.deployDetail(41))?.deploy.startedBy).toBe("ci");
		now = T0;
		await fleet.close();
	});

	test("one release: its report, its alerts, the releases before and after it on its branch", async () => {
		const fleet = await service(() => T0);
		await fleet.deploy({ s: 10, b: "prod", a: "art-10", k: "deploy", t: T0 - 2 * HOUR });
		await fleet.deploy({ s: 11, b: "prod", a: "art-11", k: "deploy", t: T0 - HOUR });
		await fleet.deploy({ s: 12, b: "dev", a: "art-12", k: "deploy", t: T0 - 50 * MIN });
		await fleet.deploy({ s: 13, b: "prod", a: "art-13", k: "deploy", t: T0 - 30 * MIN });
		await fleet.report({ s: 11, j: "job-1", r: "failed", e: "boom", b: "prod", a: "art-11" });
		await fleet.alert({ level: "critical", code: "deploy_failed", message: "boom", j: "job-1", b: "prod", a: "art-11", s: 11 });
		await fleet.alert({ level: "warning", code: "other", message: "elsewhere", j: "job-2", b: "prod", a: "art-13", s: 13 });

		const detail = await fleet.deployDetail(11);
		expect(detail?.deploy).toMatchObject({ seq: 11, failed: 1, outcome: "failed" });
		expect(detail?.report).toMatchObject({ seq: 11, reported: 1, errors: [{ error: "boom", servers: 1, exampleJob: "job-1" }] });
		expect(detail?.alerts.map((a) => a.code)).toEqual(["deploy_failed"]);
		expect(detail?.previous).toEqual({ seq: 10, kind: "deploy", artifact: "art-10", at: T0 - 2 * HOUR });
		expect(detail?.next).toEqual({ seq: 13, kind: "deploy", artifact: "art-13", at: T0 - 30 * MIN });
		expect((await fleet.deployDetail(12))?.previous).toBeNull();
		expect(await fleet.deployDetail(99)).toBeUndefined();
		await fleet.close();
	});

	test("stuck servers are counted on the release when the sweep raises server_stuck", async () => {
		let now = T0;
		const fleet = await service(() => now);
		await fleet.heartbeat(heartbeat("job-1", 19));
		await fleet.heartbeat(heartbeat("job-2", 19));
		await fleet.deploy({ s: 20, b: "prod", a: "art-20", k: "deploy" });
		await fleet.report({ s: 20, j: "job-1", r: "swapped", b: "prod", a: "art-20" });
		now = T0 + 4 * MIN;
		await fleet.heartbeat(heartbeat("job-1", 20));
		await fleet.heartbeat(heartbeat("job-2", 19));
		expect((await fleet.sweep()).stuck).toBe(1);
		expect((await fleet.deployDetail(20))?.deploy).toMatchObject({ ok: 1, stuck: 1, outcome: "stuck" });
		await fleet.close();
	});

	test("the counts are frozen onto the row before the reports go, and the history keeps them", async () => {
		let now = T0;
		const db = await openSqlite(":memory:");
		const fleet = await FleetService.open({ db, clock: () => now });
		await fleet.deploy({ s: 30, b: "prod", a: "art-30", k: "deploy" });
		const long = `a${"y".repeat(DEPLOY_ERROR_TEXT_MAX + 50)}`;
		for (let i = 0; i < DEPLOY_ERRORS_KEPT + 2; i++) await fleet.report({ s: 30, j: `job-${i}`, r: "failed", e: i === 0 ? long : `error ${i}`, b: "prod", a: "art-30" });
		await fleet.report({ s: 30, j: "job-ok", r: "swapped", b: "prod", a: "art-30" });
		const live = (await fleet.deployDetail(30))?.deploy;
		expect(live).toMatchObject({ frozen: false, reported: DEPLOY_ERRORS_KEPT + 3, failed: DEPLOY_ERRORS_KEPT + 2, ok: 1, errorKinds: DEPLOY_ERRORS_KEPT + 2 });
		expect(live?.errors).toHaveLength(DEPLOY_ERRORS_KEPT);
		expect(live?.errors.find((e) => e.error.startsWith("ay"))?.error.length).toBe(DEPLOY_ERROR_TEXT_MAX);

		// A day before the reports' 30 days end: frozen (the hourly retention), the reports still there.
		now = T0 + KEEP_REPORTS_MS - DAY + HOUR;
		await fleet.sweep();
		expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM reports"))?.n).toBe(DEPLOY_ERRORS_KEPT + 3);
		const frozen = (await fleet.deployDetail(30))?.deploy;
		expect(frozen).toMatchObject({ frozen: true, reported: live?.reported, ok: 1, failed: live?.failed, results: live?.results, errors: live?.errors, errorKinds: live?.errorKinds, firstReport: live?.firstReport });
		// Reports after the freeze don't change it.
		await fleet.report({ s: 30, j: "job-late", r: "booted", b: "prod", a: "art-30" });
		expect((await fleet.deployDetail(30))?.deploy.reported).toBe(live?.reported as number);

		// The reports go; the history keeps the release and its counts (no live report on the page any more).
		now = T0 + KEEP_REPORTS_MS + 2 * HOUR;
		await fleet.sweep();
		expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE received < ?", [T0 + DAY]))?.n).toBe(0);
		const after = await fleet.deployDetail(30);
		expect(after?.report).toBeNull();
		expect(after?.deploy).toMatchObject({ frozen: true, outcome: "partial", reported: live?.reported });
		expect((await fleet.deployHistory()).deploys[0]).toMatchObject({ seq: 30, frozen: true, failed: live?.failed });
		await fleet.close();
	});

	test("releases are kept deployKeepDays (a live setting) and at most deploysMaxRows", async () => {
		let now = T0;
		let keep = 365;
		const fleet = await service(() => now, { deployKeepDays: () => keep, deploysMaxRows: 3 });
		for (let s = 1; s <= 5; s++) {
			now = T0 + s * MIN;
			await fleet.deploy({ s, b: "prod", a: `art-${s}`, k: "deploy" });
		}
		now = T0 + 2 * HOUR;
		await fleet.sweep();
		expect((await fleet.deployHistory()).deploys.map((d) => d.seq)).toEqual([5, 4, 3]);
		keep = 7;
		now = T0 + 8 * DAY;
		await fleet.sweep();
		expect((await fleet.deployHistory()).deploys).toEqual([]);
		await fleet.close();
	});

	test("a deploys table from before the history gets its columns on open; old rows read as unfrozen", async () => {
		const db = await openSqlite(":memory:");
		await db.exec("CREATE TABLE deploys (seq INTEGER PRIMARY KEY, branch TEXT, artifact TEXT, channel TEXT, t INTEGER, received INTEGER NOT NULL, stuck_at INTEGER, kind TEXT, from_artifact TEXT, message TEXT)");
		await db.run("INSERT INTO deploys (seq, branch, artifact, channel, t, received, kind) VALUES (1, 'prod', 'art-1', 'prod', NULL, ?, 'deploy')", [T0 - HOUR]);
		const fleet = await FleetService.open({ db, clock: () => T0 });
		expect((await db.all<{ name: string }>("PRAGMA table_info(deploys)")).map((c) => c.name)).toEqual(expect.arrayContaining(["started_by", "summary_at", "reported", "ok", "failed", "stuck", "results", "errors"]));
		expect((await fleet.deployHistory()).deploys).toMatchObject([{ seq: 1, kind: "deploy", inferred: false, startedBy: null, frozen: false, reported: 0, stuck: 0, outcome: "no_reports" }]);
		await fleet.close();
	});
});

describe("over HTTP", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet" });
	});
	afterAll(async () => {
		await h.close();
	});

	test("the CLI posts `by` with the game key; the history reads with the admin token, paged, with one release by seq", async () => {
		for (const s of [70, 71, 72]) expect((await h.call("/v1/fleet/deploy", post(API, { j: "cli", s, b: "prod", a: `art-${s}`, k: "deploy", by: "alice", t: T0 - MIN }))).status).toBe(202);
		expect((await h.call("/v1/fleet/report", post(API, { s: 72, j: "job-1", r: "swapped", b: "prod", a: "art-72" }))).status).toBe(202);
		await h.app.bus.idle(2000);
		const page = await asJson(await h.call("/v1/fleet/deploys?limit=2", { headers: bearer(ADMIN) }));
		expect(page.deploys.map((d: { seq: number }) => d.seq)).toEqual([72, 71]);
		expect(page.deploys[0]).toMatchObject({ startedBy: "alice", reported: 1, ok: 1, outcome: "ok" });
		expect(page.next).toBe(71);
		const rest = await asJson(await h.call(`/api/v1/fleet/deploys?limit=2&before=${page.next}&branch=prod`, { headers: bearer(ADMIN) }));
		expect(rest.deploys.map((d: { seq: number }) => d.seq)).toEqual([70]);
		expect(rest.next).toBeNull();

		const one = await h.call("/v1/fleet/deploys/72", { headers: bearer(ADMIN) });
		expect(one.status).toBe(200);
		const body = await asJson(one);
		expect(body.deploy).toMatchObject({ seq: 72, artifact: "art-72" });
		expect(body.report).toMatchObject({ seq: 72, reported: 1 });
		expect(body.previous).toMatchObject({ seq: 71 });
		expect(body.next).toBeNull();

		expect((await h.call("/v1/fleet/deploys/999", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/fleet/deploys?before=x", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call(`/v1/fleet/deploys?branch=${"b".repeat(65)}`, { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/fleet/deploys/abc", { headers: bearer(ADMIN) })).status).toBe(404);
		// The game key writes, never reads; no credentials, nothing.
		expect((await h.call("/v1/fleet/deploys", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/fleet/deploys/72")).status).toBe(401);
		expect((await h.call("/v1/fleet/deploys", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
	});

	test("the retention is a runtime setting", async () => {
		const res = await h.call("/v1/admin/settings", { method: "PATCH", body: JSON.stringify({ deployKeepDays: 30 }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		expect(res.status).toBe(200);
		expect(h.app.settings.get("deployKeepDays")).toBe(30);
		const low = await h.call("/v1/admin/settings", { method: "PATCH", body: JSON.stringify({ deployKeepDays: 1 }), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		expect(low.status).toBe(400);
	});
});
