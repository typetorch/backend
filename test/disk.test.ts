/**
 * The data disk (server/disk.ts): the level from the free space and the thresholds, what `GET /v1/storage`,
 * `GET /v1/admin/backups` and `/healthz` say about it, and the `disk_low` fleet alert: one per level until it is acked
 * or the disk has room again, never one a check, and nothing after a restart while the alert is still open.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DiskWatch, diskLevel, diskStatus, type DiskUsage } from "../src/server/disk.ts";
import { ADMIN, asJson, bearer, harness, json, type Harness } from "./harness.ts";

const GB = 1024 ** 3;
const T = { warnFreePercent: 15, criticalFreePercent: 5 };

describe("disk levels", () => {
	test("ok, warning and critical from the free percent; 0 turns a level off", () => {
		expect(diskLevel({ freeBytes: 10 * GB, totalBytes: 25 * GB }, T)).toBe("ok");
		expect(diskLevel({ freeBytes: 3 * GB, totalBytes: 25 * GB }, T)).toBe("warning");
		expect(diskLevel({ freeBytes: 1 * GB, totalBytes: 25 * GB }, T)).toBe("critical");
		expect(diskLevel({ freeBytes: 1 * GB, totalBytes: 25 * GB }, { warnFreePercent: 15, criticalFreePercent: 0 })).toBe("warning");
		expect(diskLevel({ freeBytes: 0, totalBytes: 25 * GB }, { warnFreePercent: 0, criticalFreePercent: 0 })).toBe("ok");
		expect(diskLevel({ freeBytes: 0, totalBytes: 0 }, T)).toBe("ok");
		expect(diskStatus({ freeBytes: 3 * GB, totalBytes: 25 * GB }, T, 0)).toMatchObject({ freePercent: 12, level: "warning", warnFreePercent: 15, criticalFreePercent: 5, at: "1970-01-01T00:00:00.000Z" });
	});

	test("the watch alerts once per level, again after room came back, and logs changes", async () => {
		let usage: DiskUsage | null = { freeBytes: 10 * GB, totalBytes: 25 * GB };
		const alerts: string[] = [];
		const logs: string[] = [];
		const watch = new DiskWatch({ path: "/data", thresholds: T, usage: () => usage, alert: (a) => void alerts.push(a.level), clock: () => 0, log: (l) => logs.push(l) });
		expect(watch.status).toBeNull();
		expect((await watch.check())?.level).toBe("ok");
		expect(alerts).toEqual([]);
		usage = { freeBytes: 3 * GB, totalBytes: 25 * GB };
		await watch.check();
		await watch.check();
		expect(alerts).toEqual(["warning"]);
		usage = { freeBytes: 1 * GB, totalBytes: 25 * GB };
		await watch.check();
		expect(alerts).toEqual(["warning", "critical"]);
		// Back to a warning: nothing new (the critical one is open); room again, then a warning: a new one.
		usage = { freeBytes: 3 * GB, totalBytes: 25 * GB };
		await watch.check();
		expect(alerts).toEqual(["warning", "critical"]);
		usage = { freeBytes: 10 * GB, totalBytes: 25 * GB };
		await watch.check();
		usage = { freeBytes: 3 * GB, totalBytes: 25 * GB };
		await watch.check();
		expect(alerts).toEqual(["warning", "critical", "warning"]);
		expect(logs.some((l) => l.startsWith("disk: warning:"))).toBe(true);
		expect(logs.some((l) => l.startsWith("disk: room again:"))).toBe(true);
		// Not measurable: no status, no alert.
		usage = null;
		expect(await watch.check()).toBeNull();
		expect(watch.status).toBeNull();
	});
});

describe("the disk in the server", () => {
	let h: Harness;
	let usage: DiskUsage = { freeBytes: 20 * GB, totalBytes: 25 * GB };
	const alerts = async () => ((await asJson(await h.call("/v1/fleet/alerts?since=0", { headers: bearer(ADMIN) }))).alerts as { id: number; code: string; level: string; acked: boolean; details: Record<string, unknown> }[]).filter((a) => a.code === "disk_low");

	beforeAll(async () => {
		h = await harness({ TYPETORCH_DISK_WARN_PERCENT: "20", TYPETORCH_DISK_CRITICAL_PERCENT: "8", TYPETORCH_WEB_VIEWERS: "4242" }, { diskUsage: () => usage });
	});
	afterAll(() => h.close());

	test("the storage report, the backups status and /healthz carry the level", async () => {
		await h.app.diskTick();
		const storage = await asJson(await h.call("/v1/storage", { headers: bearer(ADMIN) }));
		expect(storage.disk).toMatchObject({ freeBytes: 20 * GB, totalBytes: 25 * GB, freePercent: 80, level: "ok", warnFreePercent: 20, criticalFreePercent: 8 });
		const backups = await asJson(await h.call("/v1/admin/backups", { headers: bearer(ADMIN) }));
		expect(backups.disk).toMatchObject({ level: "ok", freePercent: 80 });
		const health = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		expect(health.disk).toEqual({ freeBytes: 20 * GB, totalBytes: 25 * GB, freePercent: 80, level: "ok" });
		expect(await alerts()).toEqual([]);
	});

	test("under the threshold: one disk_low alert, a critical one when it gets worse, none while one is open", async () => {
		usage = { freeBytes: 4 * GB, totalBytes: 25 * GB };
		await h.app.diskTick();
		await h.app.diskTick();
		let open = await alerts();
		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({ level: "warning", acked: false, details: { freePercent: 16, thresholdPercent: 20 } });
		expect((await h.app.fleet!.diskLow({ level: "warning", freeBytes: 4 * GB, totalBytes: 25 * GB, freePercent: 16, threshold: 20 }))).toBeNull();
		// The explorer's storage report is cached for 30 s: a new reading after.
		h.setNow(h.now() + 31_000);
		expect((await asJson(await h.call("/v1/storage", { headers: bearer(ADMIN) }))).disk.level).toBe("warning");
		usage = { freeBytes: 1 * GB, totalBytes: 25 * GB };
		await h.app.diskTick();
		open = await alerts();
		expect(open.map((a) => a.level).sort()).toEqual(["critical", "warning"]);
		// Acked and still full: the next worse reading alerts again; the same level does not.
		for (const a of open) expect((await h.call(`/v1/fleet/alerts/${a.id}/ack`, { method: "POST", ...json({}), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
		await h.app.diskTick();
		expect((await alerts()).filter((a) => !a.acked)).toHaveLength(0);
		usage = { freeBytes: 20 * GB, totalBytes: 25 * GB };
		await h.app.diskTick();
		usage = { freeBytes: 1 * GB, totalBytes: 25 * GB };
		await h.app.diskTick();
		const fresh = (await alerts()).filter((a) => !a.acked);
		expect(fresh).toHaveLength(1);
		expect(fresh[0]?.level).toBe("critical");
		expect(fresh[0]?.details).toMatchObject({ freeBytes: GB, thresholdPercent: 8 });
	});

	test("the explorer's storage report is owners only (a viewer never sees the server's disk)", async () => {
		const viewer = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 4242, name: "Viewer" }, "web")}` };
		expect((await h.call("/v1/storage", { headers: viewer })).status).toBe(403);
		expect((await h.call("/v1/admin/backups", { headers: viewer })).status).toBe(403);
	});
});
