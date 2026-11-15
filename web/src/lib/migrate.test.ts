import { describe, expect, it } from "vitest";
import { daysLeft, historyBannerText, migrateActions, migratePollMs, recentlyBusy, sourceHost } from "./migrate";
import type { MigrateDay, MigrateStatus } from "./types";

const day = (d: string, state: MigrateDay["state"], table: MigrateDay["table"] = "events"): MigrateDay => ({ table, day: d, state, rowsSource: 10, rowsTarget: state === "pending" ? 0 : 10, note: "" });

function status(over: Partial<MigrateStatus>): MigrateStatus {
	return {
		state: "running",
		direction: "from-backend",
		source: { kind: "backend", url: "https://old.example.com:8443/base" },
		startedAt: 1,
		finishedAt: null,
		rowsPerSecond: 20_000,
		rowsDone: 0,
		rowsTotal: 0,
		steps: [],
		days: [],
		waitingFor: null,
		decision: null,
		error: null,
		...over,
	};
}

describe("Basin directions", () => {
	it("from Basin: the banner names Basin; to Basin: no banner (nothing here is missing); a sent day is done", () => {
		const days = [day("2026-11-01", "pending"), day("2026-11-02", "sent")];
		expect(historyBannerText(status({ direction: "from-basin", source: { kind: "basin", bucket: "b", namespace: "typetorch" }, days: [day("2026-11-01", "pending")] }))).toBe("History is still importing from Basin");
		expect(historyBannerText(status({ direction: "to-basin", source: { kind: "local" }, days }))).toBeNull();
		expect(daysLeft(days)).toBe(1);
		expect(sourceHost({ source: { kind: "local" } })).toBe("the old server");
	});
});

describe("historyBannerText", () => {
	it("names the oldest events day already done while older ones still import", () => {
		const s = status({ days: [day("2026-11-01", "pending"), day("2026-11-02", "importing"), day("2026-11-04", "match"), day("2026-11-03", "differs"), day("2026-10-01", "match", "recordings")] });
		expect(historyBannerText(s)).toBe("History before 2026-11-03 still importing");
	});

	it("names the source's host when no events day is done yet", () => {
		expect(historyBannerText(status({ days: [day("2026-11-01", "pending"), day("2026-10-30", "match", "recordings")] }))).toBe("History is still importing from old.example.com:8443");
		expect(historyBannerText(status({ state: "paused", source: null, days: [day("2026-11-01", "importing")] }))).toBe("History is still importing from the old server");
	});

	it("is quiet when nothing imports: idle, done, failed, no events day left, or no status", () => {
		const days = [day("2026-11-01", "pending")];
		expect(historyBannerText(status({ state: "waiting", days }))).not.toBeNull();
		for (const state of ["idle", "done", "failed", "cancelled", "needs_decision"] as const) expect(historyBannerText(status({ state, days }))).toBeNull();
		expect(historyBannerText(status({ days: [day("2026-11-01", "match"), day("2026-11-02", "pending", "recordings")] }))).toBeNull();
		expect(historyBannerText(undefined)).toBeNull();
	});
});

describe("migrate helpers", () => {
	it("counts the days not checked yet", () => {
		expect(daysLeft([day("a", "pending"), day("b", "importing"), day("c", "match"), day("d", "missing"), day("e", "duplicates")])).toBe(2);
	});

	it("polls fast only while running or waiting", () => {
		expect(migratePollMs("running")).toBe(5_000);
		expect(migratePollMs("waiting")).toBe(5_000);
		expect(migratePollMs("paused")).toBe(60_000);
		expect(migratePollMs(undefined)).toBe(60_000);
	});

	it("offers the buttons a state allows", () => {
		expect(migrateActions("running")).toEqual(["pause", "cancel"]);
		expect(migrateActions("paused")).toEqual(["resume", "cancel"]);
		expect(migrateActions("needs_decision")).toEqual(["cancel"]);
		expect(migrateActions("done")).toEqual([]);
		expect(migrateActions("idle")).toEqual([]);
	});

	it("reads the source host, or falls back", () => {
		expect(sourceHost({ source: { kind: "backend", url: "not a url" } })).toBe("the old server");
	});

	it("is busy only when the last busy answer is within a minute of the server's clock", () => {
		const now = 1_700_000_000_000;
		expect(recentlyBusy({ busy: 3, inflight: 1, lastBusyAt: now - 20_000 }, now)).toBe(true);
		expect(recentlyBusy({ busy: 3, inflight: 1, lastBusyAt: now - 61_000 }, now)).toBe(false);
		expect(recentlyBusy({ busy: 0, inflight: 0, lastBusyAt: null }, now)).toBe(false);
		expect(recentlyBusy(undefined, now)).toBe(false);
	});
});
