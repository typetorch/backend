/** The planner's rules (src/notify/planner.ts `decide`): a pure function over a pinned clock and random. */
import { describe, expect, test } from "bun:test";
import { validateConfig, type NotifyConfig } from "../src/notify/config.ts";
import { DAY_MS, HOUR_MS, JITTER_MS, PREF_OFF_RECHECK_MS, dayFreeAt, decide, isoWeekStart, preferredHour, weeklyCap, type DecideInput, type PlannerIntent, type PlannerUser } from "../src/notify/planner.ts";

/** Monday 2026-11-09 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const CONFIG: NotifyConfig = validateConfig({
	dailyCap: 1,
	quietAfterLeaveMinutes: 120,
	kinds: {
		gift_new: { template: "t-gift", priority: 10, repeat: "per_key", send: "preferred_hour", maxWaitHours: 48 },
		gift_expiring: { template: "t-exp", priority: 20, repeat: "per_key", send: "asap" },
		day2: { template: "t-day2", priority: 30, repeat: "once_ever", send: "asap" },
		streak: { template: "t-streak", priority: 60, repeat: "daily", send: "asap", beats: { kinds: ["gift_new"], withinHours: 4 } },
		daily: { template: "t-daily", priority: 70, repeat: "daily", perWeek: 2, send: "asap" },
	},
});

const user = (u: Partial<PlannerUser> = {}): PlannerUser => ({ online: false, onlineUntil: null, leftAt: NOW - 10 * HOUR_MS, lastSeen: NOW - 10 * HOUR_MS, hours: [], unopened: 0, backoffAt: null, muteUntil: null, cappedUntil: null, ...u });
const intent = (kind: string, key = "", extra: Partial<PlannerIntent> = {}): PlannerIntent => ({ kind, key, at: NOW - HOUR_MS, until: NOW + 3 * DAY_MS, ...extra });
const input = (o: Partial<DecideInput>): DecideInput => ({ user: user(), intents: [], recent: [], sentKeys: [], config: CONFIG, kindOn: () => true, clock: "rolling24", now: NOW, random: () => 0.5, ...o });

describe("priority and beats", () => {
	test("event kinds beat recurring ones: the lowest priority number wins, the rest are outranked", () => {
		const d = decide(input({ intents: [intent("daily", "1"), intent("gift_expiring", "g1"), intent("streak", "5")] }));
		expect(d.plan?.intent.kind).toBe("gift_expiring");
		expect(d.plan?.why).toBe("asap");
		expect(d.skips.map((s) => [s.kind, s.why]).sort()).toEqual([
			["daily", "outranked"],
			["streak", "outranked"],
		]);
	});

	test("same priority: the soonest until first", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "late", { until: NOW + 2 * DAY_MS }), intent("gift_expiring", "soon", { until: NOW + DAY_MS })] }));
		expect(d.plan?.intent.key).toBe("soon");
		expect(d.skips).toEqual([]);
	});

	test("beats: streak outranks gift_new only within its last 4 hours", () => {
		const far = decide(input({ intents: [intent("gift_new", "g"), intent("streak", "5", { until: NOW + 10 * HOUR_MS })] }));
		expect(far.plan?.intent.kind).toBe("gift_new");
		const close = decide(input({ intents: [intent("gift_new", "g"), intent("streak", "5", { until: NOW + 3 * HOUR_MS })] }));
		expect(close.plan?.intent.kind).toBe("streak");
		expect(close.skips).toEqual([{ kind: "gift_new", why: "outranked" }]);
	});

	test("a kind switched off is never planned", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "g")], kindOn: (k) => k !== "gift_expiring" }));
		expect(d.plan).toBeUndefined();
		expect(d.nextCheck).toBeGreaterThan(NOW);
	});
});

describe("repeat", () => {
	test("once_ever: superseded after any real send of the kind", () => {
		const d = decide(input({ intents: [intent("day2")], sentKeys: [{ kind: "day2", key: "" }] }));
		expect(d.plan).toBeUndefined();
		expect(d.superseded.map((i) => i.kind)).toEqual(["day2"]);
		expect(d.skips).toEqual([{ kind: "day2", why: "repeat" }]);
	});

	test("per_key: only that key is superseded", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "a"), intent("gift_expiring", "b")], sentKeys: [{ kind: "gift_expiring", key: "a" }] }));
		expect(d.plan?.intent.key).toBe("b");
		expect(d.superseded.map((i) => i.key)).toEqual(["a"]);
	});

	test("daily: none twice a day (both clocks); perWeek caps the ISO week", () => {
		const cfg = { ...CONFIG, dailyCap: 3 };
		// A daily sent 5 h ago: not again inside 24 h (rolling) / today (utc_day).
		const recent = [{ kind: "daily", key: "x", at: NOW - 5 * HOUR_MS }];
		expect(decide(input({ config: cfg, intents: [intent("daily", "y")], recent })).skips).toEqual([{ kind: "daily", why: "capped_day" }]);
		expect(decide(input({ config: cfg, intents: [intent("daily", "y")], recent, clock: "utc_day" })).skips).toEqual([{ kind: "daily", why: "capped_day" }]);
		// Sent yesterday 23:00 UTC: rolling24 still blocks, utc_day lets it go.
		const late = [{ kind: "daily", key: "x", at: Date.UTC(2026, 10, 8, 23) }];
		expect(decide(input({ config: cfg, intents: [intent("daily", "y")], recent: late })).plan).toBeUndefined();
		expect(decide(input({ config: cfg, intents: [intent("daily", "y")], recent: late, clock: "utc_day" })).plan?.intent.kind).toBe("daily");
		// perWeek 2: two this ISO week (Monday 00:00 on) -> capped_week until next Monday.
		const wed = Date.UTC(2026, 10, 11, 12);
		const week = [
			{ kind: "daily", key: "1", at: Date.UTC(2026, 10, 9, 1) },
			{ kind: "daily", key: "2", at: Date.UTC(2026, 10, 10, 1) },
		];
		const d = decide(input({ config: cfg, now: wed, intents: [intent("daily", "3", { at: wed - HOUR_MS, until: wed + DAY_MS })], recent: week, user: user({ leftAt: wed - 10 * HOUR_MS, lastSeen: wed - 10 * HOUR_MS }) }));
		expect(d.skips).toEqual([{ kind: "daily", why: "capped_week" }]);
		expect(d.nextCheck).toBe(Date.UTC(2026, 10, 16));
		expect(isoWeekStart(wed)).toBe(Date.UTC(2026, 10, 9));
	});
});

describe("the user", () => {
	const one = [intent("gift_expiring", "g")];

	test("muted, online, quiet after leaving: skipped with the time to look again", () => {
		const muted = decide(input({ intents: one, user: user({ muteUntil: NOW + DAY_MS }) }));
		expect([muted.plan, muted.skips, muted.nextCheck]).toEqual([undefined, [{ kind: "gift_expiring", why: "muted" }], NOW + DAY_MS]);
		const online = decide(input({ intents: one, user: user({ online: true }) }));
		expect(online.skips).toEqual([{ kind: "gift_expiring", why: "online" }]);
		const quiet = decide(input({ intents: one, user: user({ leftAt: NOW - 30 * 60_000 }) }));
		expect([quiet.skips, quiet.nextCheck]).toEqual([[{ kind: "gift_expiring", why: "quiet" }], NOW + 90 * 60_000]);
	});

	test("dailyCap, rolling24: free 24 h after the last send", () => {
		const recent = [{ kind: "gift_new", key: "x", at: NOW - 20 * HOUR_MS }];
		const d = decide(input({ intents: one, recent }));
		expect([d.skips, d.nextCheck]).toEqual([[{ kind: "gift_expiring", why: "capped_day" }], NOW + 4 * HOUR_MS]);
		expect(dayFreeAt([NOW - 25 * HOUR_MS], 1, "rolling24", NOW)).toBe(NOW);
	});

	test("dailyCap, utc_day: free at the next UTC midnight; yesterday's send doesn't count", () => {
		const today = [{ kind: "gift_new", key: "x", at: Date.UTC(2026, 10, 9, 1) }];
		const d = decide(input({ intents: one, recent: today, clock: "utc_day" }));
		expect([d.skips, d.nextCheck]).toEqual([[{ kind: "gift_expiring", why: "capped_day" }], Date.UTC(2026, 10, 10)]);
		const yesterday = [{ kind: "gift_new", key: "x", at: Date.UTC(2026, 10, 8, 22) }];
		expect(decide(input({ intents: one, recent: yesterday, clock: "utc_day" })).plan?.intent.key).toBe("g");
		// dailyCap 2 lets a second one through.
		expect(decide(input({ intents: one, recent: today, clock: "utc_day", config: { ...CONFIG, dailyCap: 2 } })).plan).toBeDefined();
	});

	test("Roblox's daily limit (capped_until) holds the user", () => {
		const d = decide(input({ intents: one, user: user({ cappedUntil: NOW + HOUR_MS }) }));
		expect(d.skips).toEqual([{ kind: "gift_expiring", why: "capped_day" }]);
	});

	test("lapse decay: fewer a week the longer away; past the last entry nothing", () => {
		const away = (days: number) => user({ lastSeen: NOW - days * DAY_MS, leftAt: NOW - days * DAY_MS });
		expect(weeklyCap(CONFIG, away(3), NOW)).toBe(7);
		expect(weeklyCap(CONFIG, away(20), NOW)).toBe(2);
		expect(weeklyCap(CONFIG, away(45), NOW)).toBe(1);
		expect(weeklyCap(CONFIG, away(61), NOW)).toBe(0);
		expect(decide(input({ intents: one, user: away(61) })).skips).toEqual([{ kind: "gift_expiring", why: "lapsed" }]);
		// 20 days away, two sends this rolling week: lapsed until the older one is a week old.
		const recent = [
			{ kind: "a", key: "", at: NOW - 3 * DAY_MS },
			{ kind: "a", key: "", at: NOW - 2 * DAY_MS },
		];
		const d = decide(input({ intents: one, user: away(20), recent }));
		expect([d.skips, d.nextCheck]).toEqual([[{ kind: "gift_expiring", why: "lapsed" }], NOW + 4 * DAY_MS]);
	});

	test("unopened backoff: after 5 unopened in a row the week's cap is halved, for 14 days", () => {
		const backed = user({ lastSeen: NOW - 20 * DAY_MS, leftAt: NOW - 20 * DAY_MS, unopened: 5, backoffAt: NOW - DAY_MS });
		expect(weeklyCap(CONFIG, backed, NOW)).toBe(1);
		expect(weeklyCap(CONFIG, { ...backed, backoffAt: NOW - 15 * DAY_MS }, NOW)).toBe(2);
	});
});

describe("when", () => {
	test("preferred hour: the mode of the session starts, default 17:00 UTC, +-20 min jitter", () => {
		expect(preferredHour([])).toBe(17);
		expect(preferredHour([9, 20, 20, 9, 9, 3])).toBe(9);
		const gift = [intent("gift_new", "g")];
		const at = (random: number, hours: number[] = []) => decide(input({ intents: gift, random: () => random, user: user({ hours }) })).plan?.at;
		expect(at(0.5)).toBe(Date.UTC(2026, 10, 9, 17));
		expect(at(0)).toBe(Date.UTC(2026, 10, 9, 17) - JITTER_MS);
		expect(at(1)).toBe(Date.UTC(2026, 10, 9, 17) + JITTER_MS);
		// 09:00 has passed today: tomorrow 09:00.
		expect(at(0.5, [9, 9, 10])).toBe(Date.UTC(2026, 10, 10, 9));
		// The hour is now (12:00 +- jitter): never in the past.
		expect(at(0, [12])).toBe(NOW);
	});

	test("until - 1 h when the hour misses the window; maxWaitHours caps the wait", () => {
		const d = decide(input({ intents: [intent("gift_new", "g", { until: NOW + 3 * HOUR_MS })], user: user({ hours: [9] }) }));
		expect(d.plan).toEqual({ intent: expect.objectContaining({ key: "g" }), at: NOW + 2 * HOUR_MS, why: "until" });
		const cfg = validateConfig({ kinds: { gift_new: { template: "t", priority: 1, repeat: "per_key", maxWaitHours: 2 } } });
		const w = decide(input({ config: cfg, intents: [intent("gift_new", "g", { at: NOW })], user: user({ hours: [9] }) }));
		expect(w.plan).toMatchObject({ at: NOW + 2 * HOUR_MS, why: "until" });
	});

	test("an intent whose window hasn't opened is looked at again when it does", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "g", { at: NOW + 5 * 60_000 })] }));
		expect(d.plan).toBeUndefined();
		expect(d.nextCheck).toBe(NOW + 5 * 60_000);
	});
});

describe("prefs (the player's switched-off kinds)", () => {
	test("an off kind is never planned: skipped pref_off, looked at again when its window ends (not every tick)", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "g", { until: NOW + 2 * DAY_MS })], off: new Set(["gift_expiring"]) }));
		expect(d.plan).toBeUndefined();
		expect(d.superseded).toEqual([]);
		expect(d.skips).toEqual([{ kind: "gift_expiring", why: "pref_off" }]);
		expect(d.nextCheck).toBe(NOW + 2 * DAY_MS);
		const long = decide(input({ intents: [intent("gift_expiring", "g", { until: NOW + 300 * DAY_MS })], off: new Set(["gift_expiring"]) }));
		expect(long.nextCheck).toBe(NOW + PREF_OFF_RECHECK_MS);
	});

	test("the next kind goes instead (an off kind never outranks); other kinds untouched", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "g"), intent("daily", "1")], off: new Set(["gift_expiring", "streak"]) }));
		expect(d.plan?.intent.kind).toBe("daily");
		expect(d.skips).toEqual([{ kind: "gift_expiring", why: "pref_off" }]);
		expect(decide(input({ intents: [intent("gift_expiring", "g")], off: new Set(["daily"]) })).plan?.intent.kind).toBe("gift_expiring");
	});

	test("a window not yet open still wakes the planner at its start", () => {
		const d = decide(input({ intents: [intent("gift_expiring", "g"), intent("daily", "1", { at: NOW + HOUR_MS })], off: new Set(["gift_expiring"]) }));
		expect(d.plan).toBeUndefined();
		expect(d.nextCheck).toBe(NOW + HOUR_MS);
	});
});

describe("config validation", () => {
	test("the rules the CLI copies", () => {
		expect(() => validateConfig({ kinds: { custom: { priority: 1, repeat: "daily" } } })).toThrow(/reserved/);
		expect(() => validateConfig({ kinds: { Gift: { priority: 1, repeat: "daily" } } })).toThrow();
		expect(() => validateConfig({ kinds: { a: { priority: 1001, repeat: "daily" } } })).toThrow();
		expect(() => validateConfig({ kinds: { a: { priority: 1, repeat: "daily", perWeek: 8 } } })).toThrow();
		expect(() => validateConfig({ kinds: { a: { priority: 1, repeat: "weekly" } } })).toThrow();
		expect(() => validateConfig({ kinds: { a: { priority: 1, repeat: "daily", extra: 1 } } })).toThrow();
		expect(() => validateConfig({ dailyCap: 4, kinds: {} })).toThrow();
		expect(() => validateConfig({ lapse: [[30, 2], [14, 7]], kinds: {} })).toThrow(/ascending/);
		expect(() => validateConfig({ kinds: { a: { priority: 1, repeat: "daily", template: "x".repeat(129) } } })).toThrow();
		// As loose as the CLI: lapse day 0, fractional hours, any category text.
		const ok = validateConfig({ lapse: [[0, 7], [30, 1]], unopenedBackoff: { after: 3, factor: 1, days: 365 }, kinds: { a: { priority: 0, repeat: "daily", maxWaitHours: 0.5, category: "Gift letters", beats: { kinds: ["b"], withinHours: 1.5 } } } });
		expect(ok.kinds.a).toMatchObject({ send: "preferred_hour", maxWaitHours: 0.5, category: "Gift letters" });
	});
});
