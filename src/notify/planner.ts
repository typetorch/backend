/**
 * The planner (plans/29 "Planner"): every 30 s, users with a pending intent whose window opened get one send planned,
 * or a reason they get none now (a `skipped` row) and the time to look again (`next_check`).
 *
 * `decide` is the whole rule set as a pure function over the user's state, their intents and sends, the config, the
 * switches, `now` and `random` (tests pin both). In order:
 *   1. intents: window open (at <= now < until), kind in the config and switched on (and not halted);
 *      repeat: once_ever = no real send of the kind ever, per_key = none of that key (else the intent is superseded);
 *      daily = none of the kind this day (the `notify.clock` day), and under `perWeek` this ISO week (Mon 00:00 UTC);
 *   2. the user: muted, online, quiet after leaving, the day cap (`dailyCap` per the clock: rolling24 = 24 h after a
 *      send, utc_day = the UTC date), the lapse cap (sends per rolling week by days since last seen; past the last entry
 *      nothing), cut by the unopened backoff (after N unopened in a row, x factor for `days`);
 *   3. the best intent: lowest priority number, then the soonest `until`; a kind with `beats` outranks the listed kinds
 *      within its last `withinHours`;
 *   4. when: `asap` = now; `preferred_hour` = the user's usual hour (the mode of their last 20 session starts, else
 *      17:00 UTC) +-20 min of jitter, but no later than `until - 1 h` nor `at + maxWaitHours`.
 */
import { newNid } from "./token.ts";
import type { KindConfig, NotifyConfig } from "./config.ts";
import { isOnline, type IntentRow, type NotifyStore, type OutRow, type UserRow } from "./store.ts";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const DEFAULT_HOUR = 17;
export const JITTER_MS = 20 * 60_000;
/** Users looked at per tick (`notify.batch`). */
export const PLANNER_BATCH = 500;
/** How long a user with nothing plannable (kinds off, no config) waits before the next look. */
export const IDLE_RECHECK_MS = 10 * 60_000;

export type DayClock = "rolling24" | "utc_day";
export type SkipWhy = "online" | "quiet" | "capped_day" | "capped_week" | "lapsed" | "muted" | "outranked" | "expired" | "dropped" | "repeat";

export interface PlannerUser {
	/** In game: an `online` presence newer than `notify.presenceStaleHours`. */
	online: boolean;
	/** When that presence goes stale (look again then), or null. */
	onlineUntil: number | null;
	leftAt: number | null;
	lastSeen: number | null;
	hours: number[];
	unopened: number;
	backoffAt: number | null;
	muteUntil: number | null;
	cappedUntil: number | null;
}

export interface PlannerIntent {
	kind: string;
	key: string;
	at: number;
	until: number;
}

export interface PastSend {
	kind: string;
	key: string;
	/** sent_at, unix ms. */
	at: number;
}

export interface DecideInput<I extends PlannerIntent = PlannerIntent> {
	user: PlannerUser;
	intents: I[];
	/** Sends (sent or dry) of the last 8 days, for the caps. */
	recent: PastSend[];
	/** (kind, key) pairs ever really sent, for once_ever / per_key. */
	sentKeys: { kind: string; key: string }[];
	config: NotifyConfig;
	kindOn(kind: string): boolean;
	clock: DayClock;
	now: number;
	random: () => number;
}

export interface Decision<I extends PlannerIntent = PlannerIntent> {
	plan?: { intent: I; at: number; why: "asap" | "hour" | "until" };
	/** Rows to write: one per reason (k = the kind concerned). */
	skips: { kind: string; why: SkipWhy }[];
	/** Intents never to send (once_ever / per_key already sent). */
	superseded: I[];
	/** When to look at the user again (ignored when a send is planned). */
	nextCheck: number;
}

const utcDayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
/** Monday 00:00 UTC of t's ISO week. */
export const isoWeekStart = (t: number) => {
	const day = utcDayStart(t);
	const weekday = (new Date(day).getUTCDay() + 6) % 7;
	return day - weekday * DAY_MS;
};

/** The user's usual hour: the mode of their session-start hours (ties: the latest seen), else 17:00 UTC. */
export function preferredHour(hours: number[]): number {
	if (!hours.length) return DEFAULT_HOUR;
	const counts = new Map<number, number>();
	for (const h of hours) counts.set(h, (counts.get(h) ?? 0) + 1);
	let best = hours[hours.length - 1] as number;
	for (let i = hours.length - 1; i >= 0; i--) {
		const h = hours[i] as number;
		if ((counts.get(h) ?? 0) > (counts.get(best) ?? 0)) best = h;
	}
	return best;
}

/** The day cap: when the user may get the next send (<= now = now). */
export function dayFreeAt(sends: number[], cap: number, clock: DayClock, now: number): number {
	if (clock === "utc_day") {
		const today = sends.filter((t) => t >= utcDayStart(now)).length;
		return today >= cap ? utcDayStart(now) + DAY_MS : now;
	}
	const inWindow = sends.filter((t) => t > now - DAY_MS).sort((a, b) => a - b);
	return inWindow.length >= cap ? (inWindow[inWindow.length - cap] as number) + DAY_MS : now;
}

/** The lapse cap (sends per rolling week) for the user now; 0 = nothing (past the last entry). */
export function weeklyCap(config: NotifyConfig, user: PlannerUser, now: number): number {
	const away = user.lastSeen !== null ? Math.floor(Math.max(0, now - user.lastSeen) / DAY_MS) : 0;
	const entry = config.lapse.find(([days]) => away < days);
	if (!entry) return 0;
	let cap = entry[1];
	const b = config.unopenedBackoff;
	if (cap > 0 && user.unopened >= b.after && user.backoffAt !== null && now - user.backoffAt < b.days * DAY_MS) cap = Math.max(1, Math.floor(cap * b.factor));
	return cap;
}

export function decide<I extends PlannerIntent>(input: DecideInput<I>): Decision<I> {
	const { user, config, now, clock } = input;
	const out: Decision<I> = { skips: [], superseded: [], nextCheck: Number.POSITIVE_INFINITY };
	const later = (t: number) => (out.nextCheck = Math.min(out.nextCheck, Math.max(t, now + 1000)));
	const sentKey = new Set(input.sentKeys.map((s) => `${s.kind}\u0000${s.key}`));
	const sentKind = new Set(input.sentKeys.map((s) => s.kind));
	const dayStart = clock === "utc_day" ? utcDayStart(now) : now - DAY_MS;
	const weekStart = isoWeekStart(now);

	// 1. The intents that could go now.
	const eligible: { intent: I; kind: KindConfig }[] = [];
	const kindSkips = new Map<string, SkipWhy>();
	for (const intent of input.intents) {
		if (intent.at > now) {
			later(intent.at);
			continue;
		}
		if (intent.until <= now) continue;
		const kind = config.kinds[intent.kind];
		if (!kind || !input.kindOn(intent.kind)) {
			later(now + IDLE_RECHECK_MS);
			continue;
		}
		if ((kind.repeat === "once_ever" && sentKind.has(intent.kind)) || (kind.repeat === "per_key" && sentKey.has(`${intent.kind}\u0000${intent.key}`))) {
			out.superseded.push(intent);
			kindSkips.set(intent.kind, "repeat");
			continue;
		}
		if (kind.repeat === "daily") {
			const ofKind = input.recent.filter((s) => s.kind === intent.kind);
			const today = ofKind.filter((s) => (clock === "utc_day" ? s.at >= dayStart : s.at > dayStart));
			if (today.length) {
				kindSkips.set(intent.kind, "capped_day");
				later(clock === "utc_day" ? dayStart + DAY_MS : Math.min(...today.map((s) => s.at)) + DAY_MS);
				continue;
			}
			if (kind.perWeek !== undefined && ofKind.filter((s) => s.at >= weekStart).length >= kind.perWeek) {
				kindSkips.set(intent.kind, "capped_week");
				later(weekStart + WEEK_MS);
				continue;
			}
		}
		eligible.push({ intent, kind });
	}
	if (!eligible.length) {
		if (!Number.isFinite(out.nextCheck)) out.nextCheck = now + IDLE_RECHECK_MS;
		for (const [kind, why] of kindSkips) if (why !== "repeat") out.skips.push({ kind, why });
		for (const [kind, why] of kindSkips) if (why === "repeat") out.skips.push({ kind, why });
		return out;
	}

	// 3 (early). The best one, so a user-level skip names the kind it held back.
	eligible.sort((a, b) => a.kind.priority - b.kind.priority || a.intent.until - b.intent.until || (a.intent.kind < b.intent.kind ? -1 : a.intent.kind > b.intent.kind ? 1 : a.intent.key < b.intent.key ? -1 : 1));
	let best = eligible[0] as { intent: I; kind: KindConfig };
	for (const e of eligible) {
		const beats = e.kind.beats;
		if (e !== best && beats && beats.kinds.includes(best.intent.kind) && e.intent.until - now <= beats.withinHours * HOUR_MS) {
			best = e;
			break;
		}
	}
	const k = best.intent.kind;
	for (const [kind, why] of kindSkips) if (why === "repeat") out.skips.push({ kind, why });

	// 2. The user.
	const skip = (why: SkipWhy, until: number) => {
		out.skips.push({ kind: k, why });
		out.nextCheck = Math.max(until, now + 1000);
		return out;
	};
	if (user.muteUntil !== null && user.muteUntil > now) return skip("muted", user.muteUntil);
	if (user.online) return skip("online", user.onlineUntil ?? now + DAY_MS);
	const quietUntil = user.leftAt !== null ? user.leftAt + config.quietAfterLeaveMinutes * 60_000 : 0;
	if (quietUntil > now) return skip("quiet", quietUntil);
	if (user.cappedUntil !== null && user.cappedUntil > now) return skip("capped_day", user.cappedUntil);
	const times = input.recent.map((s) => s.at);
	const dayFree = dayFreeAt(times, config.dailyCap, clock, now);
	if (dayFree > now) return skip("capped_day", dayFree);
	const cap = weeklyCap(config, user, now);
	if (cap <= 0) return skip("lapsed", now + DAY_MS);
	const week = times.filter((t) => t > now - WEEK_MS).sort((a, b) => a - b);
	if (week.length >= cap) return skip("lapsed", (week[week.length - cap] as number) + WEEK_MS);

	// 3. Outranked kinds (one row each).
	const losers = new Set(eligible.filter((e) => e !== best && e.intent.kind !== k).map((e) => e.intent.kind));
	for (const kind of losers) out.skips.push({ kind, why: "outranked" });

	// 4. When.
	const intent = best.intent;
	if (best.kind.send === "asap") {
		out.plan = { intent, at: now, why: "asap" };
		return out;
	}
	const hour = preferredHour(user.hours);
	let base = utcDayStart(now - JITTER_MS) + hour * HOUR_MS;
	if (base < now - JITTER_MS) base += DAY_MS;
	let at = Math.max(now, Math.round(base + (input.random() * 2 - 1) * JITTER_MS));
	let why: "hour" | "until" = "hour";
	const deadline = Math.min(intent.until - HOUR_MS, best.kind.maxWaitHours !== undefined ? intent.at + best.kind.maxWaitHours * HOUR_MS : Number.POSITIVE_INFINITY);
	if (at > deadline) {
		at = Math.max(now, deadline);
		why = "until";
	}
	out.plan = { intent, at, why };
	return out;
}

// The tick -------------------------------------------------------------------------------------------------------------

export interface RowSink {
	(userId: number, name: string, props: Record<string, unknown>): void;
}

export interface PlannerOptions {
	store: NotifyStore;
	clock: () => number;
	random?: () => number;
	/** The switches (runtime settings + halts). */
	enabled(): boolean;
	kindOn(kind: string): boolean;
	dayClock(): DayClock;
	/** `notify.presenceStaleHours` in ms. */
	presenceStaleMs(): number;
	/** A game-supplied template (allowTemplate) Roblox said doesn't exist: its intents wait. */
	templateOn(template: string): boolean;
	batch?: number;
}

export const toPlannerUser = (u: UserRow | undefined, now: number = Date.now(), staleMs: number = 6 * HOUR_MS): PlannerUser => {
	let hours: number[] = [];
	try {
		hours = (JSON.parse(u?.hours ?? "[]") as unknown[]).filter((h): h is number => typeof h === "number" && h >= 0 && h < 24);
	} catch {}
	const n = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
	return {
		online: isOnline(u, now, staleMs),
		onlineUntil: u && Number(u.online) ? Number(u.presence_at) + staleMs : null,
		leftAt: n(u?.left_at),
		lastSeen: n(u?.last_seen),
		hours,
		unopened: Number(u?.unopened ?? 0),
		backoffAt: n(u?.backoff_at),
		muteUntil: n(u?.mute_until),
		cappedUntil: n(u?.capped_until),
	};
};

export class Planner {
	private running = false;
	private readonly random: () => number;

	constructor(private readonly o: PlannerOptions) {
		this.random = o.random ?? Math.random;
	}

	/** One pass: expire, then plan for up to `batch` users. Returns what it did (tests read it). */
	async tick(): Promise<{ expired: number; looked: number; planned: number }> {
		if (this.running) return { expired: 0, looked: 0, planned: 0 };
		this.running = true;
		try {
			return await this.pass();
		} finally {
			this.running = false;
		}
	}

	private async pass(): Promise<{ expired: number; looked: number; planned: number }> {
		const { store } = this.o;
		const now = this.o.clock();
		const expired = await store.expire(now, 5000);
		const cfg = await store.config();
		if (!this.o.enabled() || !cfg) return { expired: expired.length, looked: 0, planned: 0 };
		const config = cfg.config;
		const users = await store.candidates(now, this.o.batch ?? PLANNER_BATCH);
		let planned = 0;
		for (const [i, userId] of users.entries()) {
			// Yield now and then: a full batch never holds the event loop for long.
			if (i % 50 === 49) await new Promise((done) => setTimeout(done, 0));
			const user = await store.user(userId);
			const u = toPlannerUser(user, now, this.o.presenceStaleMs());
			// The unopened backoff ran its course: start counting again.
			if (user && u.backoffAt !== null && now - u.backoffAt >= config.unopenedBackoff.days * DAY_MS) {
				await store.userField(userId, { unopened: 0, backoff_at: null });
				u.unopened = 0;
				u.backoffAt = null;
			}
			// A game-supplied template Roblox refused (S1b, allowTemplate): those intents wait until a config push clears it.
			const intents = (await store.pendingIntents(userId)).filter((x) => !(x.template && config.kinds[x.kind]?.allowTemplate && !this.o.templateOn(x.template)));
			const kinds = [...new Set(intents.map((x) => x.kind))];
			const d = decide<IntentRow & PlannerIntent>({
				user: u,
				intents: intents.map((x) => ({ ...x, at: Number(x.at), until: Number(x.until) })),
				recent: await store.recentSends(userId, now - 8 * DAY_MS),
				sentKeys: await store.sentKeys(userId, kinds),
				config,
				kindOn: (k) => this.o.kindOn(k),
				clock: this.o.dayClock(),
				now,
				random: this.random,
			});
			const rows: OutRow[] = d.skips.map((s) => ({ uid: userId, name: "skipped", props: { k: s.kind, why: s.why } }));
			if (!d.plan) {
				await store.decided(userId, { nextCheck: d.nextCheck, superseded: d.superseded, rows });
				continue;
			}
			const intent = d.plan.intent;
			const kind = config.kinds[intent.kind] as KindConfig;
			const nid = newNid();
			await store.plan(
				{
				nid,
				userId,
				kind: intent.kind,
				key: intent.key,
				rev: Number(intent.rev),
				template: (kind.allowTemplate && intent.template) || kind.template || null,
				category: kind.category ?? intent.kind,
				params: intent.params,
				data: intent.data,
					plannedAt: d.plan.at,
					test: false,
				},
				{ superseded: d.superseded, rows: [...rows, { uid: userId, name: "planned", props: { nid, k: intent.kind, for: Math.floor(d.plan.at / 1000), why: d.plan.why } }] },
			);
			planned++;
		}
		return { expired: expired.length, looked: users.length, planned };
	}
}
