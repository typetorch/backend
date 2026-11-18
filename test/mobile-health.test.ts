/**
 * The mobile app's health card (`health` on GET /v1/mobile/live): the two hour windows of the Errors page's count, the
 * Fleet page's healthy-server rule, the alerts (open count, newest three of the last 24 h, titles), the 60 s cache, a
 * failure keeping the last good card, null without the fleet part; then the whole card through the app on seeded
 * errors, heartbeats and alerts. Every token is made up; no player id goes in or out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ErrorWindow } from "../src/errors/store.ts";
import type { Alert } from "../src/fleet/service.ts";
import { alertTitle, computeHealth, HEALTH_TTL_MS, hourWindows, MobileHealth, type HealthSources } from "../src/server/mobile-health.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const alert = (id: number, level: Alert["level"], at: number, message: string, acked = false): Alert => ({
	id,
	level,
	code: "test",
	message,
	job: null,
	branch: null,
	artifact: null,
	seq: null,
	generation: null,
	kernel: null,
	source: "game",
	details: null,
	createdAt: new Date(at).toISOString(),
	at,
	acked,
	ackedAt: null,
	ackedBy: null,
});

/** Fake services: error counts per window start, servers with their reasons, alerts (filtered like FleetService.alerts). */
function fakes(o: { counts?: Map<number, number>; reasons?: number[]; alerts?: Alert[] } = {}) {
	const lists: ErrorWindow[] = [];
	const alertAsks: { since?: number; unacked?: boolean; limit?: number }[] = [];
	const sources = {
		errors: {
			list: async (w: ErrorWindow) => {
				lists.push(w);
				return { totals: { count: o.counts?.get(w.from) ?? 0, kinds: 0, players: 0 } };
			},
		},
		fleet: {
			servers: async () => ({ servers: (o.reasons ?? []).map((n) => ({ reasons: Array.from({ length: n }, () => ({ signal: "tps" })) })) }),
			alerts: async (q: { since?: number; unacked?: boolean; limit?: number } = {}) => {
				alertAsks.push(q);
				return (o.alerts ?? [])
					.filter((a) => a.at >= (q.since ?? 0) && (!q.unacked || !a.acked))
					.sort((a, b) => b.id - a.id)
					.slice(0, q.limit ?? 200);
			},
		},
	} as unknown as HealthSources;
	return { sources, lists, alertAsks };
}

describe("health card: the numbers", () => {
	test("hour windows: the last 60 whole minutes (the current one included) and the 60 before, back to back", () => {
		// On a minute boundary: the current minute is [T0, T0 + 1 min).
		expect(hourWindows(T0)).toEqual({ current: { from: T0 + MIN - HOUR, to: T0 + MIN }, previous: { from: T0 + MIN - 2 * HOUR, to: T0 + MIN - HOUR } });
		// Mid-minute: the same minute.
		expect(hourWindows(T0 + 30_000)).toEqual(hourWindows(T0));
		expect(hourWindows(T0 + MIN - 1)).toEqual(hourWindows(T0));
		expect(hourWindows(T0 + MIN).current.to).toBe(T0 + 2 * MIN);
	});

	test("errors over the two windows, servers ok = no Health reasons, alerts: open count, newest three of 24 h, titles", async () => {
		const w = hourWindows(T0);
		const long = `Error spike after deploy #142 on prod: ${"x".repeat(80)}`;
		const { sources, lists, alertAsks } = fakes({
			counts: new Map([
				[w.current.from, 143],
				[w.previous.from, 31],
			]),
			reasons: [0, 0, 2, 0, 1, 0],
			alerts: [
				alert(1, "critical", T0 - DAY - 1, "too old"),
				alert(2, "warning", T0 - 5 * HOUR, "older open"),
				alert(3, "info", T0 - 3 * HOUR, "acked one", true),
				alert(4, "critical", T0 - 2 * HOUR, long),
				alert(5, "warning", T0 - HOUR, "  Server   lost:\n job-7  "),
			],
		});
		const h = await computeHealth(sources, T0);
		expect(h).toEqual({
			errors1h: 143,
			errorsPrev1h: 31,
			servers: 6,
			serversOk: 4,
			// 2, 4, 5 (1 is older than 24 h, 3 acked).
			alertsOpen: 3,
			alerts: [
				{ level: "warning", title: "Server lost: job-7", at: new Date(T0 - HOUR).toISOString() },
				{ level: "critical", title: `${long.slice(0, 77)}...`, at: new Date(T0 - 2 * HOUR).toISOString() },
				// Acked alerts are still listed (the last 24 h, newest first).
				{ level: "info", title: "acked one", at: new Date(T0 - 3 * HOUR).toISOString() },
			],
		});
		expect(h.alerts[1]?.title).toHaveLength(80);
		// Whole windows, the Errors page's list with no filter.
		expect(lists.map((l) => [l.from, l.to])).toEqual([
			[w.current.from, w.current.to],
			[w.previous.from, w.previous.to],
		]);
		expect(alertAsks).toEqual([
			{ since: T0 - DAY, unacked: true, limit: 1000 },
			{ since: T0 - DAY, limit: 3 },
		]);
		expect(alertTitle("short")).toBe("short");
		expect(alertTitle("y".repeat(80))).toBe("y".repeat(80));
		expect(alertTitle("y".repeat(81))).toBe(`${"y".repeat(77)}...`);
	});

	test("an empty game: zeros and no alerts", async () => {
		expect(await computeHealth(fakes().sources, T0)).toEqual({ errors1h: 0, errorsPrev1h: 0, servers: 0, serversOk: 0, alertsOpen: 0, alerts: [] });
	});

	test("cached 60 s, one computation at a time, a failure keeps the last good card; null without the fleet part", async () => {
		let now = T0;
		let errors = 5;
		let fail = false;
		let computations = 0;
		const base = fakes().sources;
		const sources = {
			...base,
			errors: {
				list: async (w: ErrorWindow) => {
					if (w.from === hourWindows(now).current.from) computations++;
					if (fail) throw new Error("db closed");
					return { totals: { count: w.from === hourWindows(now).current.from ? errors : 0 } };
				},
			},
		} as unknown as HealthSources;
		const health = new MobileHealth({ sources: () => sources, clock: () => now });
		const [a, b] = await Promise.all([health.get(), health.get()]);
		expect(a?.errors1h).toBe(5);
		expect(b).toEqual(a);
		expect(computations).toBe(1);
		errors = 9;
		now += HEALTH_TTL_MS - 1;
		expect((await health.get())?.errors1h).toBe(5);
		now += 1;
		expect((await health.get())?.errors1h).toBe(9);
		expect(computations).toBe(2);
		fail = true;
		now += HEALTH_TTL_MS;
		expect((await health.get())?.errors1h).toBe(9);
		expect(computations).toBe(3);

		expect(await new MobileHealth({ sources: () => undefined, clock: () => T0 }).get()).toBeNull();
		// Failing from the start: null.
		const broken = { ...base, fleet: { servers: async () => Promise.reject(new Error("down")), alerts: async () => [] } } as unknown as HealthSources;
		expect(await new MobileHealth({ sources: () => broken, clock: () => T0 }).get()).toBeNull();
	});
});

const hb = (j: string, h: string, now: number) => ({ j, t: "public", b: "prod", c: "prod", a: "art-41", n: 4, m: 50, s: Math.floor((now - HOUR) / 1000), u: Math.floor(now / 1000), p: 1001, v: "0.3.2", q: 41, g: 3, h, sv: 2 });

const LONG = `Memory over 3000 MB on job-d ${"m".repeat(90)}`;

describe("health on GET /v1/mobile/live through the app", () => {
	let h: Harness;
	let token = "";
	const N = T0;
	let ipN = 0;
	const ip = () => `10.90.0.${++ipN}`;
	const live = async () => {
		const res = await h.call("/v1/mobile/live", { headers: bearer(token), ip: ip() });
		expect(res.status).toBe(200);
		return asJson(res);
	};
	const errorsAt = async (job: string, fp: string, count: number, at: number) => {
		const r = await h.call("/v1/errors", post(API, { v: 1, j: job, errors: [{ fp, template: `boom ${fp}`, count, firstAt: at, lastAt: at, branch: "prod", build: "art-41", realm: "server", pids: [] }] }));
		expect(r.status).toBe(202);
		await h.app.bus.idle(2000);
	};
	const raise = async (at: number, j: string, level: string, message: string) => {
		h.setNow(at);
		expect((await h.call("/v1/fleet/alert", post(API, { level, code: "mobile_health_test", message, j }))).status).toBe(202);
		await h.app.bus.idle(2000);
	};
	const beat = async (job: string, health: string, at: number) => {
		h.setNow(at);
		expect((await h.call("/v1/fleet/heartbeat", post(API, hb(job, health, at)))).status).toBe(202);
		await h.app.bus.idle(2000);
	};

	beforeAll(async () => {
		h = await harness({ TYPETORCH_UNIVERSE_ID: "123456789" });
		// Alerts: one older than 24 h, one acked, three open; the newest three listed.
		await raise(N - DAY - MIN, "job-a", "critical", "Too old to show");
		await raise(N - 5 * HOUR, "job-b", "warning", "Server stuck on deploy #141");
		await raise(N - 2 * HOUR, "job-c", "info", "Acknowledged one");
		await raise(N - HOUR, "job-d", "warning", LONG);
		await raise(N - 30 * MIN, "job-e", "critical", "Error spike after deploy #142");
		h.setNow(N);
		const listed = await asJson(await h.call("/v1/fleet/alerts", { headers: bearer(ADMIN) }));
		const acked = (listed.alerts as { id: number; message: string }[]).find((a) => a.message === "Acknowledged one");
		if (!acked) throw new Error("no alert");
		expect((await h.call(`/v1/fleet/alerts/${acked.id}/ack`, { method: "POST", body: "{}", headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
		// Servers: job-1 and job-2 ok, job-3 degraded (kernel health), job-4 ok but its heartbeat is 80 s old (late).
		await beat("job-4", "ok", N - 80_000);
		await beat("job-3", "degraded", N - 10_000);
		await beat("job-2", "ok", N - 5000);
		await beat("job-1", "ok", N);
		// Errors (the window ends with the current minute: [N - 59 min, N + 1 min) and [N - 119 min, N - 59 min)).
		await errorsAt("job-1", "fp-a", 100, N - 10 * MIN);
		await errorsAt("job-2", "fp-b", 43, N - 59 * MIN);
		await errorsAt("job-1", "fp-a", 31, N - 60 * MIN);
		await errorsAt("job-3", "fp-c", 9, N - 121 * MIN);
		const mint = await h.call("/v1/auth/mobile/token", { method: "POST", body: JSON.stringify({ device: "Pixel 9" }), headers: { "content-type": "application/json", ...bearer(ADMIN) }, ip: ip() });
		token = (await asJson(mint)).token as string;
	});
	afterAll(() => h.close());

	test("the card: errors per hour, servers and the healthy ones, open alerts, the newest three", async () => {
		const body = await live();
		if (process.env.TT_PRINT_LIVE) console.log(JSON.stringify(body.health, null, 2));
		expect(body.health).toEqual({
			errors1h: 143,
			errorsPrev1h: 31,
			servers: 4,
			serversOk: 2,
			// job-b, job-d, job-e (job-a older than 24 h, job-c acked).
			alertsOpen: 3,
			alerts: [
				{ level: "critical", title: "Error spike after deploy #142", at: new Date(N - 30 * MIN).toISOString() },
				{ level: "warning", title: `${LONG.slice(0, 77)}...`, at: new Date(N - HOUR).toISOString() },
				{ level: "info", title: "Acknowledged one", at: new Date(N - 2 * HOUR).toISOString() },
			],
		});
		expect(body.health.alerts[1].title).toHaveLength(80);
		// The same servers as the top-level count.
		expect(body.servers).toBe(4);
	});

	test("cached 60 s: new errors show after a minute", async () => {
		await errorsAt("job-1", "fp-d", 7, N);
		h.setNow(N + 30_000);
		expect((await live()).health.errors1h).toBe(143);
		h.setNow(N + 61_000);
		const later = (await live()).health;
		// The window moved a minute: fp-b (N - 59 min) is now in the hour before.
		expect(later).toMatchObject({ errors1h: 107, errorsPrev1h: 74 });
	});
});
