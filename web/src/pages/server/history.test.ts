import { describe, expect, it } from "vitest";
import type { FleetServerDetail } from "@/lib/types";
import { alertBundle, bundlePlayers, isBundleId, lifetimeMs, logEntries, offlineText, playerLogOwners, plain, timelineEvents } from "./history";

const BUNDLE = "0123456789abcdef0123456789abcdef";
const server = { job: "j", serverType: "public", branch: "prod", artifact: "a1", players: 0, maxPlayers: 20, startedAt: "2026-10-09T08:00:00.000Z", lastSeen: "2026-10-09T09:59:00.000Z", appliedSeq: 3, generation: 2, health: "ok", lastError: null, kernel: "0.5.3", experiment: false };
const base = (over: Partial<FleetServerDetail>): FleetServerDetail => ({ server, state: "live", debug: { watched: false, connected: false }, ...over });
const at = (iso: string) => new Date(iso).getTime();

describe("offline history", () => {
	it("the Offline badge's words and how long the server ran", () => {
		const closed = base({ state: "closed", server: { ...server, closedAt: "2026-10-09T10:00:00.000Z" } });
		expect(offlineText(closed)).toBe("closed at 2026-10-09 10:00:00 UTC");
		expect(lifetimeMs(closed)).toBe(2 * 3_600_000);
		// Lost without the sweep's mark yet: its last heartbeat.
		const lost = base({ state: "lost" });
		expect(offlineText(lost)).toBe("lost at 2026-10-09 09:59:00 UTC");
		expect(lifetimeMs(lost)).toBe(119 * 60_000);
		expect(offlineText(base({ state: "gone", server: null }))).toBe("gone");
		expect(lifetimeMs(base({ state: "gone", server: null }))).toBeUndefined();
		expect(lifetimeMs(base({ state: "live" }), at("2026-10-09T08:30:00Z"))).toBe(30 * 60_000);
	});

	it("the Timeline: alerts, reports, swaps, the start and the close, newest first; an alert's bundle", () => {
		const events = timelineEvents(
			base({
				state: "closed",
				server: { ...server, closedAt: "2026-10-09T10:00:00.000Z" },
				history: {
					alerts: [{ id: 7, at: at("2026-10-09T09:00:00Z"), level: "critical", code: "deploy_failed", message: "start failed", acked: false, details: { stage: "start", bundle: BUNDLE } }],
					reports: [{ seq: 4, branch: "prod", artifact: "a2", job: "j", result: "failed", error: "boom", seconds: 1.234, at: at("2026-10-09T08:59:00Z") }],
					bundles: [],
					swaps: [{ at: at("2026-10-09T08:00:05Z"), name: "g1", artifact: "a1", branch: "prod", reason: "boot", loadSeconds: 1.5, swapSeconds: null, bundle: BUNDLE }],
					metrics: { from: null, to: null },
				},
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["closed", "alert", "report", "swap", "started"]);
		expect(events[1]).toMatchObject({ title: "critical alert deploy_failed", detail: "start failed", bundle: BUNDLE });
		expect(events[2]).toMatchObject({ title: "Deploy #4: failed", tone: "critical", detail: "a2 · took 1.23 s · boom" });
		expect(events[3]).toMatchObject({ title: "Generation g1 started (boot)", detail: "a1 · load 1.5 s" });
	});

	it("bundle ids and alert details: only 32 lowercase hex", () => {
		expect(isBundleId(BUNDLE)).toBe(true);
		expect(isBundleId(BUNDLE.toUpperCase())).toBe(false);
		expect(isBundleId("../x")).toBe(false);
		expect(alertBundle({ bundle: BUNDLE })).toBe(BUNDLE);
		expect(alertBundle({ bundle: 12 })).toBeUndefined();
		expect(alertBundle(null)).toBeUndefined();
	});

	it("a bundle's untrusted sections become plain rows", () => {
		expect(logEntries([{ i: 3, t: 10, kind: "error", text: "<script>x</script>" }, { t: "x", kind: "weird", text: { a: 1 } }, null])).toEqual([
			{ i: 3, t: 10, kind: "error", text: "<script>x</script>" },
			{ i: 2, t: 0, kind: "output", text: '{"a":1}' },
			{ i: 3, t: 0, kind: "output", text: "" },
		]);
		expect(logEntries("nope")).toEqual([]);
		const players = bundlePlayers([{ u: 101, n: "One", joinedAt: 5, ping: 80, client: { ok: true } }, "junk"]);
		expect(players[0]).toEqual({ userId: "101", name: "One", joinedAt: 5, ping: 80, client: '{"ok":true}' });
		expect(players[1]).toEqual({ userId: "", name: "", client: "" });
		expect(playerLogOwners({ "101": [], "202": [] }, players)).toEqual([
			{ userId: "101", label: "One (101)" },
			{ userId: "202", label: "UserId 202" },
		]);
		expect(plain("x".repeat(10), 5)).toBe("xxxx…");
	});
});
