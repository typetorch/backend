/**
 * Backend alerts (src/alerts): every rule as a pure check with made-up data and a fixed clock; the settings value (env
 * defaults, strict checks, partial changes); the evaluator on an in-memory SQLite with a fake clock (sampling, the error
 * queries, dedup across a restart, the throttle, rules switched off without analytics); and the routes through the app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSqlite, type FleetDb } from "../src/fleet/db.ts";
import { FleetService } from "../src/fleet/service.ts";
import { ErrorStore } from "../src/errors/store.ts";
import {
	check5xx,
	checkCcuDrop,
	checkDiskGrowth,
	checkDiskLow,
	checkErrorSpike,
	checkFleetSilent,
	checkIngestStopped,
	checkLatency,
	checkLoopLag,
	checkMemory,
	checkNewErrorKinds,
	type MinuteStat,
	type Sample,
	type Verdict,
} from "../src/alerts/checks.ts";
import { BackendAlerts, type MetricsSource, type RaisedAlert } from "../src/alerts/evaluator.ts";
import { alertSettingsFromEnv, checkAlertSettings, defaultAlertSettings, RULES, type BackendAlertSettings } from "../src/alerts/rules.ts";
import { ADMIN, API, T0, asJson, bearer, harness, type Harness } from "./harness.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const GB = 1024 ** 3;
const findings = (v: Verdict) => (v.state === "firing" ? v.findings : []);

/** One sample a minute from `from` for `count` minutes; `at(i)` gives players / servers / the rows counter. */
function samples(from: number, count: number, at: (i: number) => Partial<Sample>): Sample[] {
	return Array.from({ length: count }, (_, i) => ({ t: from + i * MIN, servers: 4, players: 100, rowsIn: 0, ...at(i) }));
}

describe("checks: errors", () => {
	const q = { minutes: 10, factor: 5, minCount: 50, baselineHours: 24 };
	test("a spike fires; the usual rate, a small count and a steady kind do not", () => {
		const v = checkErrorSpike(
			[
				// 24 h at 144 windows: 1440 before = 10 per window; 300 now = 30x.
				{ fp: "aa", template: "attempt to index nil with 'Parent'", recent: 300, baseline: 1440 },
				// Steady: 100 now, 14400 before = 100 per window.
				{ fp: "bb", template: "steady", recent: 100, baseline: 14_400 },
				// Below minCount, even from nothing.
				{ fp: "cc", template: "small", recent: 40, baseline: 0 },
				// From nothing, at minCount.
				{ fp: "dd", template: "fresh", recent: 60, baseline: 0 },
			],
			q,
		);
		expect(v.state).toBe("firing");
		expect(findings(v).map((f) => f.key)).toEqual(["aa", "dd"]);
		expect(findings(v)[0]?.message).toContain("300 in 10 min vs 10 usually (30.0x)");
		expect(checkErrorSpike([], q).state).toBe("ok");
	});

	test("a new kind after the latest deploy fires once it is loud enough; one from before the deploy does not", () => {
		const deploy = { seq: 42, branch: "main", artifact: "abc123", at: T0 };
		const q2 = { minutes: 30, minCount: 20 };
		const kinds = [
			{ fp: "new", template: "boom", firstAt: T0 + 5 * MIN, total: 25 },
			{ fp: "quiet", template: "rare", firstAt: T0 + 6 * MIN, total: 3 },
			{ fp: "late", template: "later", firstAt: T0 + 45 * MIN, total: 500 },
			{ fp: "old", template: "before", firstAt: T0 - MIN, total: 500 },
		];
		const v = checkNewErrorKinds(deploy, kinds, T0 + 20 * MIN, q2);
		expect(findings(v).map((f) => f.key)).toEqual(["42:new"]);
		expect(findings(v)[0]).toMatchObject({ seq: 42, branch: "main", artifact: "abc123" });
		expect(checkNewErrorKinds(null, kinds, T0, q2).state).toBe("waiting");
		expect(checkNewErrorKinds(deploy, [kinds[1] as never], T0 + 20 * MIN, q2).state).toBe("ok");
	});
});

describe("checks: players and ingest", () => {
	const tick = MIN;
	test("players online drop: fires past the share with servers up; not below the minimum peak, not without servers, not before the window is covered", () => {
		const q = { percent: 50, minutes: 10, minPlayers: 20 };
		const now = T0 + 10 * MIN;
		const falling = samples(T0, 11, (i) => ({ players: i < 8 ? 200 : 60 }));
		const v = checkCcuDrop(falling, now, q, tick);
		expect(v.state).toBe("firing");
		expect(findings(v)[0]?.message).toContain("fell 70% in 10 min (200 to 60)");
		expect(checkCcuDrop(samples(T0, 11, (i) => ({ players: i < 8 ? 10 : 2 })), now, q, tick).state).toBe("waiting");
		expect(checkCcuDrop(samples(T0, 11, (i) => (i < 10 ? {} : { players: 0, servers: 0 })), now, q, tick).state).toBe("ok");
		expect(checkCcuDrop(samples(T0, 11, () => ({ players: 150 })), now, q, tick).state).toBe("ok");
		expect(checkCcuDrop(samples(now - 3 * MIN, 4, () => ({})), now, q, tick).state).toBe("waiting");
	});

	test("fleet silent: no heartbeat and no ingest after traffic fires, keyed by the silence; not with ingest, not without players before", () => {
		const q = { minutes: 10, minPlayers: 10 };
		const last = T0 + 30 * MIN;
		const before = samples(T0, 31, () => ({ players: 40 }));
		const now = last + 12 * MIN;
		const v = checkFleetSilent(before, last, last, now, q);
		expect(v.state).toBe("firing");
		expect(findings(v)[0]?.key).toBe(String(last));
		expect(findings(v)[0]?.message).toContain("no heartbeat and no analytics ingest for 12 min, after 40 players");
		// Analytics off: heartbeats alone decide (and the message leaves ingest out).
		expect(findings(checkFleetSilent(before, last, undefined, now, q))[0]?.message).toContain("no heartbeat for 12 min");
		expect(checkFleetSilent(before, last, now - MIN, now, q).state).toBe("ok");
		expect(checkFleetSilent(before, last, last, last + 5 * MIN, q).state).toBe("ok");
		expect(checkFleetSilent(samples(T0, 31, () => ({ players: 3 })), last, last, now, q).state).toBe("waiting");
		expect(checkFleetSilent([], null, null, now, q).state).toBe("waiting");
	});

	test("ingest stopped: zero rows after steady traffic with players online fires; not after sparse traffic, not with nobody online", () => {
		const q = { minutes: 10, minRowsPerMinute: 100 };
		// 30 minutes at 500 rows a minute, then 10 minutes of nothing.
		const steady = samples(T0, 41, (i) => ({ rowsIn: Math.min(i, 30) * 500 }));
		const now = T0 + 40 * MIN;
		const v = checkIngestStopped(steady, now, q, tick);
		expect(v.state).toBe("firing");
		expect(findings(v)[0]?.message).toContain("no rows for 10 min after 500 rows / min, while 100 players are online");
		const still = samples(T0, 41, (i) => ({ rowsIn: i * 500 }));
		expect(checkIngestStopped(still, now, q, tick).state).toBe("ok");
		// One burst then nothing: not steady.
		const burst = samples(T0, 41, (i) => ({ rowsIn: i >= 1 ? 30_000 : 0 }));
		expect(checkIngestStopped(burst, now, q, tick).state).toBe("waiting");
		const empty = samples(T0, 41, (i) => ({ rowsIn: Math.min(i, 30) * 500, players: i >= 30 ? 0 : 100 }));
		expect(checkIngestStopped(empty, now, q, tick).state).toBe("ok");
		expect(checkIngestStopped(steady.slice(-20), now, q, tick).state).toBe("waiting");
	});
});

describe("checks: the backend's own health", () => {
	const now = T0 + 10 * MIN + 30_000;
	/** Whole minutes T0 .. T0 + 9 min. */
	const minutes = (m: (i: number) => Partial<MinuteStat>): MinuteStat[] => Array.from({ length: 10 }, (_, i) => ({ at: T0 + i * MIN, requests: 600, errors5xx: 0, p99: 40, rssMb: 200, loopLagMs: 2, ...m(i) }));

	test("latency: p99 over the threshold in every minute of the window; one fast minute or too few requests keep it quiet", () => {
		const q = { p99Ms: 2000, minutes: 5, minRequests: 30 };
		expect(checkLatency(minutes((i) => (i >= 5 ? { p99: 2500 + i } : {})), now, q).state).toBe("firing");
		expect(checkLatency(minutes((i) => (i >= 5 && i !== 7 ? { p99: 2500 } : {})), now, q).state).toBe("ok");
		expect(checkLatency(minutes((i) => (i >= 5 ? { p99: 2500, requests: 5 } : {})), now, q).state).toBe("ok");
		expect(checkLatency(minutes(() => ({})).slice(0, 7), now, q).state).toBe("waiting");
	});

	test("memory and loop lag: sustained over the window", () => {
		expect(findings(checkMemory(minutes((i) => (i >= 5 ? { rssMb: 900 } : {})), now, { rssMb: 800, minutes: 5 }))[0]?.message).toContain("RSS above 800 MB for 5 min (900 MB now)");
		expect(checkMemory(minutes((i) => (i >= 6 ? { rssMb: 900 } : {})), now, { rssMb: 800, minutes: 5 }).state).toBe("ok");
		expect(checkLoopLag(minutes((i) => (i >= 7 ? { loopLagMs: 800 } : {})), now, { lagMs: 500, minutes: 3 }).state).toBe("firing");
		expect(checkLoopLag(minutes((i) => (i === 9 ? { loopLagMs: 5000 } : {})), now, { lagMs: 500, minutes: 3 }).state).toBe("ok");
	});

	test("5xx: the share over the window, with a minimum of requests", () => {
		const q = { percent: 5, minutes: 5, minRequests: 100 };
		const v = check5xx(minutes((i) => (i >= 5 ? { errors5xx: 60 } : {})), now, q);
		expect(findings(v)[0]?.message).toContain("10.0% of requests answered 5xx in the last 5 min (300 of 3000)");
		expect(check5xx(minutes((i) => (i >= 5 ? { errors5xx: 10 } : {})), now, q).state).toBe("ok");
		expect(check5xx(minutes(() => ({ requests: 10, errors5xx: 10 })), now, q).state).toBe("waiting");
	});
});

describe("checks: disk", () => {
	test("low: below the share or below the size (0 turns one off)", () => {
		const total = 100 * GB;
		expect(checkDiskLow({ freeBytes: 5 * GB, totalBytes: total }, { percent: 10, gb: 2 }).state).toBe("firing");
		expect(checkDiskLow({ freeBytes: 20 * GB, totalBytes: total }, { percent: 10, gb: 2 }).state).toBe("ok");
		expect(checkDiskLow({ freeBytes: 5 * GB, totalBytes: total }, { percent: 0, gb: 2 }).state).toBe("ok");
		expect(checkDiskLow({ freeBytes: 1 * GB, totalBytes: total }, { percent: 0, gb: 2 }).state).toBe("firing");
		expect(checkDiskLow(null, { percent: 10, gb: 2 }).state).toBe("waiting");
	});

	test("growth: fires when the last days' growth fills the disk within the window; needs a day of samples", () => {
		const total = 100 * GB;
		const now = T0 + 3 * 86_400_000;
		// 3 days ago 70 GB used, now 85 GB: 5 GB a day, 15 GB free = 3 days.
		const history = [{ t: T0, usedBytes: 70 * GB, freeBytes: 30 * GB }];
		const disk = { freeBytes: 15 * GB, totalBytes: total };
		const v = checkDiskGrowth(history, disk, now, { days: 7 });
		expect(v.state).toBe("firing");
		expect(findings(v)[0]?.message).toContain("fills up in about 3 days (+5.0 GB a day");
		expect(checkDiskGrowth(history, disk, now, { days: 2 }).state).toBe("ok");
		expect(checkDiskGrowth([{ t: now - HOUR, usedBytes: 70 * GB, freeBytes: 30 * GB }], disk, now, { days: 7 }).state).toBe("waiting");
		expect(checkDiskGrowth([{ t: T0, usedBytes: 90 * GB, freeBytes: 10 * GB }], disk, now, { days: 7 }).state).toBe("ok");
	});
});

describe("the backendAlerts setting", () => {
	test("defaults: every rule on, with its level; env variables override one value each", () => {
		const d = defaultAlertSettings();
		expect(Object.keys(d.rules)).toEqual(RULES.map((r) => r.id));
		expect(d.rules.ccuDrop).toEqual({ on: true, level: "critical", params: { percent: 50, minutes: 10, minPlayers: 20 } });
		const env = alertSettingsFromEnv({ TYPETORCH_ALERT_CCU_DROP: "off", TYPETORCH_ALERT_CCU_DROP_PERCENT: "30", TYPETORCH_ALERT_5XX_LEVEL: "Critical", TYPETORCH_BACKEND_ALERTS_PER_HOUR: "4" });
		expect(env.rules.ccuDrop).toEqual({ on: false, level: "critical", params: { percent: 30, minutes: 10, minPlayers: 20 } });
		expect(env.rules.backend5xx.level).toBe("critical");
		expect(env.perHour).toBe(4);
		expect(() => alertSettingsFromEnv({ TYPETORCH_ALERT_CCU_DROP_PERCENT: "5" })).toThrow("TYPETORCH_ALERT_CCU_DROP_PERCENT must be from 10 to 100");
		expect(() => alertSettingsFromEnv({ TYPETORCH_ALERT_DISK_LOW: "maybe" })).toThrow("TYPETORCH_ALERT_DISK_LOW is on or off");
	});

	test("checks: partial values keep the base, unknown names and bad values are refused", () => {
		const base = defaultAlertSettings();
		const next = checkAlertSettings({ rules: { diskLow: { params: { gb: 0 } }, ccuDrop: { level: "info" } } }, base);
		expect(next.rules.diskLow.params).toEqual({ percent: 10, gb: 0 });
		expect(next.rules.ccuDrop.level).toBe("info");
		expect(next.rules.errorSpike).toEqual(base.rules.errorSpike);
		expect(() => checkAlertSettings({ rules: { nope: {} } })).toThrow("unknown rule");
		expect(() => checkAlertSettings({ rules: { ccuDrop: { params: { nope: 1 } } } })).toThrow("unknown threshold");
		expect(() => checkAlertSettings({ rules: { ccuDrop: { params: { percent: 5 } } } })).toThrow("must be from 10 to 100");
		expect(() => checkAlertSettings({ rules: { ccuDrop: { params: { percent: 50.5 } } } })).toThrow("whole number");
		expect(() => checkAlertSettings({ rules: { ccuDrop: { level: "loud" } } })).toThrow("level is one of");
		expect(() => checkAlertSettings({ extra: 1 })).toThrow("unknown field");
		expect(() => checkAlertSettings([])).toThrow("is an object");
	});
});

// The evaluator --------------------------------------------------------------------------------------------------------------

interface Rig {
	db: FleetDb;
	fleet: FleetService;
	alerts: BackendAlerts;
	raised: RaisedAlert[];
	setNow(ms: number): void;
	settings: BackendAlertSettings;
	metrics: MetricsSource;
	analytics: { on: boolean };
	disk: { now: { freeBytes: number; totalBytes: number } | null };
}

async function rig(options: { db?: FleetDb; settings?: BackendAlertSettings } = {}): Promise<Rig> {
	let now = T0;
	const db = options.db ?? (await openSqlite(":memory:"));
	await ErrorStore.open(db, { clock: () => now });
	const fleet = await FleetService.open({ db, clock: () => now });
	const raised: RaisedAlert[] = [];
	const r: Rig = {
		db,
		fleet,
		raised,
		setNow: (ms) => (now = ms),
		settings: options.settings ?? defaultAlertSettings(),
		metrics: { minutes: [], totals: { rowsIn: 0 } },
		analytics: { on: true },
		disk: { now: { freeBytes: 50 * GB, totalBytes: 100 * GB } },
		alerts: undefined as never,
	};
	r.alerts = new BackendAlerts({
		db,
		fleet: true,
		analytics: () => r.analytics.on,
		metrics: () => r.metrics,
		disk: () => r.disk.now,
		settings: () => r.settings,
		raise: async (a) => {
			raised.push(a);
			return fleet.serverAlert(a);
		},
		clock: () => now,
	});
	return r;
}

const onlyRules = (s: BackendAlertSettings, ...ids: (keyof BackendAlertSettings["rules"])[]) => {
	for (const id of Object.keys(s.rules) as (keyof BackendAlertSettings["rules"])[]) s.rules[id].on = ids.includes(id);
	return s;
};

describe("the evaluator", () => {
	test("an error spike from the error tables is raised once, stored as a fleet alert (source server), and not again after a restart", async () => {
		const r = await rig();
		onlyRules(r.settings, "errorSpike");
		const nowMinute = Math.floor((T0 + 2 * HOUR) / MIN);
		await r.db.run("INSERT INTO error_kinds (fp, template, realm, first_at, last_at, total) VALUES ('k1', 'attempt to index nil', 'server', ?, ?, 1000)", [T0, T0 + 2 * HOUR]);
		for (let m = 0; m < 10; m++) await r.db.run("INSERT INTO error_counts (fp, minute, branch, build, realm, n) VALUES ('k1', ?, 'main', 'b1', 'server', 30)", [nowMinute - m]);
		// The usual: 1 a minute over the day before.
		await r.db.run("INSERT INTO error_counts (fp, minute, branch, build, realm, n) VALUES ('k1', ?, 'main', 'b1', 'server', 120)", [nowMinute - 100]);
		r.setNow(T0 + 2 * HOUR);
		await r.alerts.tick();
		expect(r.raised).toHaveLength(1);
		expect(r.raised[0]).toMatchObject({ code: "backend_error_spike", level: "warning", details: { rule: "errorSpike", key: "k1", recent: 300 } });
		const stored = await r.fleet.alerts();
		expect(stored[0]).toMatchObject({ code: "backend_error_spike", source: "server", job: null });
		expect(r.alerts.status().rules.find((x) => x.id === "errorSpike")).toMatchObject({ state: "firing" });

		// The next tick: deduped in memory. A fresh evaluator on the same file (a restart): deduped by the alerts table.
		r.setNow(T0 + 2 * HOUR + MIN);
		await r.alerts.tick();
		const again = await rig({ db: r.db, settings: r.settings });
		again.setNow(T0 + 2 * HOUR + 2 * MIN);
		await again.alerts.tick();
		expect(r.raised).toHaveLength(1);
		expect(again.raised).toHaveLength(0);
		expect(again.alerts.stats.deduped).toBe(1);
		// After the repeat window it is raised again (still spiking).
		const later = T0 + 2 * HOUR + 181 * MIN;
		for (let m = 0; m < 10; m++) await r.db.run("INSERT INTO error_counts (fp, minute, branch, build, realm, n) VALUES ('k1', ?, 'main', 'b1', 'server', 30)", [Math.floor(later / MIN) - m]);
		again.setNow(later);
		await again.alerts.tick();
		expect(again.raised).toHaveLength(1);
		await r.fleet.close();
	});

	test("a new error kind after the latest deploy (the fleet's deploys table) carries the deploy's seq", async () => {
		const r = await rig();
		onlyRules(r.settings, "errorNewAfterDeploy");
		await r.db.run("INSERT INTO deploys (seq, branch, artifact, received) VALUES (7, 'main', 'art7', ?)", [T0]);
		await r.db.run("INSERT INTO error_kinds (fp, template, realm, first_at, last_at, total) VALUES ('n1', 'new thing broke', 'server', ?, ?, 40)", [T0 + 3 * MIN, T0 + 9 * MIN]);
		await r.db.run("INSERT INTO error_kinds (fp, template, realm, first_at, last_at, total) VALUES ('o1', 'old thing', 'server', ?, ?, 4000)", [T0 - HOUR, T0 + 9 * MIN]);
		r.setNow(T0 + 10 * MIN);
		await r.alerts.tick();
		expect(r.raised.map((a) => [a.code, a.seq, a.details.key])).toEqual([["backend_error_new", 7, "7:n1"]]);
		await r.fleet.close();
	});

	test("players online drop and fleet silent from heartbeats over ticks; ingest stopped is off without analytics", async () => {
		const r = await rig();
		onlyRules(r.settings, "ccuDrop", "fleetSilent", "ingestStopped");
		r.analytics.on = false;
		const beat = (job: string, players: number, at: number) =>
			r.db.run("INSERT INTO servers (job, players, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(job) DO UPDATE SET players = excluded.players, last_seen = excluded.last_seen", [job, players, at, at]);
		for (let i = 0; i <= 10; i++) {
			const t = T0 + i * MIN;
			r.setNow(t);
			await beat("job-a", i < 8 ? 100 : 20, t);
			await beat("job-b", i < 8 ? 100 : 20, t);
			await r.alerts.tick();
		}
		expect(r.raised.map((a) => a.code)).toEqual(["backend_ccu_drop"]);
		expect(r.raised[0]?.message).toContain("fell 80% in 10 min (200 to 40) while 2 servers still send heartbeats");
		expect(r.alerts.status().rules.find((x) => x.id === "ingestStopped")).toMatchObject({ state: "unavailable", note: "analytics aren't running" });

		// The servers stop sending; 11 minutes later the fleet is silent (analytics off: heartbeats alone).
		const lastBeat = T0 + 10 * MIN;
		for (let i = 1; i <= 11; i++) {
			r.setNow(lastBeat + i * MIN);
			await r.alerts.tick();
		}
		expect(r.raised.map((a) => a.code)).toEqual(["backend_ccu_drop", "backend_fleet_silent"]);
		expect(r.raised[1]?.details.key).toBe(String(lastBeat));
		await r.fleet.close();
	});

	test("health rules read the metrics' whole minutes; the throttle caps alerts per hour; the master switch stops everything", async () => {
		const r = await rig();
		onlyRules(r.settings, "backendMemory", "backendLoopLag", "backend5xx", "diskLow");
		r.settings.perHour = 2;
		r.setNow(T0 + 10 * MIN + 1000);
		r.metrics = {
			minutes: Array.from({ length: 10 }, (_, i) => ({ at: T0 + i * MIN, requests: 100, status: { "5xx": 50 }, latency: { p99: 10 }, memory: { rssMb: 950 }, loopLagMs: 900 })),
			totals: { rowsIn: 0 },
		};
		r.disk.now = { freeBytes: GB, totalBytes: 100 * GB };
		await r.alerts.tick();
		expect(r.raised.map((a) => a.code)).toEqual(["backend_memory", "backend_loop_lag"]);
		expect(r.alerts.stats.throttled).toBe(2);
		r.settings.on = false;
		r.setNow(T0 + 3 * HOUR);
		await r.alerts.tick();
		expect(r.raised).toHaveLength(2);
		expect(r.alerts.status().rules.every((x) => x.state === "off")).toBe(true);
		await r.fleet.close();
	});

	test("disk growth from hourly samples kept in SQLite", async () => {
		const r = await rig();
		onlyRules(r.settings, "diskGrowth");
		// Once a week at most: one alert for the whole run (hourly ticks would repeat it every repeat window).
		r.settings.repeatMinutes = 10_080;
		// Two days at 5 GB a day used more, 100 GB disk.
		for (let h = 0; h <= 48; h++) {
			r.setNow(T0 + h * HOUR);
			const used = 60 * GB + (5 * GB * h) / 24;
			r.disk.now = { freeBytes: 100 * GB - used, totalBytes: 100 * GB };
			await r.alerts.tick();
		}
		const rows = await r.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM backend_disk_samples");
		expect(rows?.n).toBe(49);
		// 30 GB free at 5 GB a day: 6 days, within the default 7.
		expect(r.raised.map((a) => a.code)).toEqual(["backend_disk_growth"]);
		expect(r.raised[0]?.message).toContain("fills up in about 6 days");
		await r.fleet.close();
	});
});

describe("routes", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_ALERT_CCU_DROP_PERCENT: "40" });
	});
	afterAll(() => h.close());

	test("GET /v1/admin/alert-rules: admin only; the state of every rule", async () => {
		expect((await h.call("/v1/admin/alert-rules")).status).toBe(401);
		expect((await h.call("/v1/admin/alert-rules", { headers: bearer(API) })).status).toBe(401);
		await h.app.backendAlerts?.tick();
		const res = await h.call("/v1/admin/alert-rules", { headers: bearer(ADMIN) });
		expect(res.status).toBe(200);
		const body = await asJson(res);
		expect(body.on).toBe(true);
		expect(body.rules.map((r: { id: string }) => r.id)).toEqual(RULES.map((r) => r.id));
		expect(body.rules.find((r: { id: string }) => r.id === "ingestStopped")).toMatchObject({ state: "unavailable" });
		expect((await h.call("/v1/admin/alert-rules", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
	});

	test("the backendAlerts setting: env defaults in the view with the rule definitions; a partial PATCH applies at once", async () => {
		const view = await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }));
		const setting = view.settings.find((s: { key: string }) => s.key === "backendAlerts");
		expect(setting).toMatchObject({ kind: "alertRules", group: "backendAlerts", env: "TYPETORCH_BACKEND_ALERTS", source: "env", fallbackSource: "env" });
		expect(setting.value.rules.ccuDrop.params.percent).toBe(40);
		expect(setting.rules.rules.find((r: { id: string }) => r.id === "ccuDrop").params[0]).toMatchObject({ key: "percent", env: "TYPETORCH_ALERT_CCU_DROP_PERCENT", min: 10, max: 100 });

		const patch = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
		const bad = await patch({ backendAlerts: { rules: { ccuDrop: { params: { percent: 1 } } } } });
		expect(bad.status).toBe(400);
		expect((await asJson(bad)).error).toContain("backendAlerts.rules.ccuDrop.params.percent must be from 10 to 100");
		const good = await patch({ backendAlerts: { rules: { ccuDrop: { on: false } } } });
		expect(good.status).toBe(200);
		const now = h.app.settings.get("backendAlerts");
		expect(now.rules.ccuDrop).toEqual({ on: false, level: "critical", params: { percent: 40, minutes: 10, minPlayers: 20 } });
		await h.app.backendAlerts?.tick();
		expect(h.app.backendAlerts?.status().rules.find((r) => r.id === "ccuDrop")?.state).toBe("off");
	});
});
