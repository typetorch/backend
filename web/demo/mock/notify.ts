/**
 * Experience notifications (src/notify/routes.ts, app.ts notifyUser / notifyRecent / notifyUsers):
 *
 *   GET  /v1/notify/status           switches, kinds, the queue, the token bucket, the last day's sends
 *   GET  /v1/notify/config           the pushed config: The Prison's kinds (daily spin, quests, Jailbreak Rush, bounties...)
 *   POST /v1/notify/test             a test send, kept in the demo state (never sent anywhere)
 *   GET  /v1/notify/user?uid|pid|name   one player's consent, sends and intents
 *   GET  /v1/notify/recent           everyone's newest sends
 *   GET  /v1/notify/users            the opt-in list (JSON pages, or CSV with format=csv)
 *
 * The pack has no notification rows, and its pids are never mapped to UserIds, so this is a synthetic notify world keyed
 * by demo UserIds: 13-digit numbers from 9000000000000 up, far past any real Roblox account (the explorer's notification
 * pages want digits; they never build a roblox.com link or avatar from them). Names are the demo's fake ones. A pid
 * lookup answers like the backend does for an unlinked pid (404 "no UserId known for that pid").
 * Sends follow the pack's days (moved onto today like everything else) and appear as their time passes now.
 */
import type { NotifyConfigView, NotifyOptinState, NotifyOptinTotals, NotifyOptinUser, NotifyRecentSend, NotifyRecentView, NotifyStatus, NotifyTestResult, NotifyUserIntent, NotifyUserSend, NotifyUsersView, NotifyUserView } from "@/lib/types";
import { DAY_MS, now, UNIVERSE_ID } from "./data";
import { PID_PATTERN } from "./errors";
import { DEMO_ACTOR } from "./live-events";
import { pack } from "./pack";
import { fakeName, hashString, rng, type Rng } from "./rng";
import { fail, route } from "./router";
import { slice } from "./state";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const MUTE_MS = 7 * DAY_MS;
const KIND_PATTERN = /^[a-z0-9_]{1,24}$/;
const PARAM_NAME = /^[a-zA-Z0-9_-]{1,32}$/;
const DATA_MAX_BYTES = 64;
const CSV_MAX = 10_000;
export const OPTIN_STATES = ["subscribed", "not_subscribed", "unknown", "muted"] as const;
/** The first demo UserId: 13 digits, far past any real Roblox account. */
export const DEMO_UID_BASE = 9_000_000_000_000;

// Config and switches --------------------------------------------------------------------------------------------------

interface KindConfig {
	text: string;
	template: string;
	priority: number;
	repeat: "once_ever" | "per_key" | "daily";
	send: "asap" | "preferred_hour";
	perWeek?: number;
	maxWaitHours?: number;
	category?: string;
}

/** Message ids are made up (Roblox's are UUIDs); the texts are The Prison's. */
export const NOTIFY_KINDS: Record<string, KindConfig> = {
	daily_spin: { text: "Your daily spin is ready, inmate. Free cash is waiting in the yard!", template: "5f0c2a9e-3b71-4d1e-9a2f-6c8b1e7d4a10", priority: 200, repeat: "daily", send: "preferred_hour", category: "daily_spin" },
	quest_reset: { text: "New daily quests are up: {quest} pays {cash} cash today.", template: "8a4d1f3c-27e9-4b05-b6d2-0e9c5a8f1b33", priority: 150, repeat: "daily", send: "preferred_hour", perWeek: 4, category: "quests" },
	jailbreak_rush: { text: "Jailbreak Rush is live! Escapes pay double for the next {hours} hours.", template: "c1e7b9d2-5a3f-4e68-8d14-2b6f0a9c7e55", priority: 300, repeat: "per_key", send: "asap", maxWaitHours: 2, category: "live_event" },
	bounty_on_you: { text: "A {cash} cash bounty is on your head. The guards are looking for you.", template: "e3b5a0f4-91c6-47d2-a8e3-5d0b7c2f9a61", priority: 250, repeat: "per_key", send: "asap", maxWaitHours: 1, category: "bounty" },
	guard_shift: { text: "Guard shift open tonight: +{bonus} salary for every arrest.", template: "2d9f6e1a-c4b8-4a73-9e05-7f3a1d6b8c29", priority: 100, repeat: "daily", send: "preferred_hour", perWeek: 2, category: "guards" },
	comeback: { text: "The warden misses you. Your cell is still waiting.", template: "7b2c8d5e-0f13-4c9a-b7e6-3a1d9f4e2b87", priority: 50, repeat: "per_key", send: "preferred_hour", perWeek: 1, category: "comeback" },
};

const QUESTS = ["inmate_clean_3_spills", "inmate_search_3_trashcans", "guard_arrest_3_hostiles", "inmate_escape_prison", "guard_taser_2_hostiles", "inmate_use_1_lockpick"];

export interface NotifySwitches {
	enabled: boolean;
	dryRun: boolean;
	rate: number;
	clock: "rolling24" | "utc_day";
	presenceStaleHours: number;
	/** Kinds switched off (notify.kinds). */
	kindsOff: string[];
}

const switches = slice<NotifySwitches>("notify.switches", () => ({ enabled: true, dryRun: false, rate: 50, clock: "rolling24", presenceStaleHours: 6, kindsOff: [] }));

/** The notify.* runtime settings (the Settings page / the Notifications Settings tab save them through the admin domain). */
export function getNotifySwitches(): NotifySwitches {
	return switches.get();
}

export function setNotifySwitches(change: Partial<NotifySwitches>): NotifySwitches {
	return switches.update((s) => ({ ...s, ...change }));
}

// The world ------------------------------------------------------------------------------------------------------------

export interface WorldSend {
	nid: string;
	userId: number;
	kind: string;
	plannedAt: number;
	sentAt: number;
	status: "sent" | "failed" | "cancelled" | "dry";
	http: number | null;
	code: string | null;
	error: string | null;
	try: number;
	openedAt: number | null;
	playedSecs: number | null;
	params: Record<string, string> | null;
	robloxId: string | null;
	test: boolean;
}

export interface WorldUser {
	userId: number;
	name: string | null;
	firstSeen: number;
	lastSeen: number;
	/** The opt-in as learned (when a send's answer said so). */
	optin: "subscribed" | "not_subscribed" | null;
	optinAt: number | null;
	prefsOff: string[] | null;
	intents: (NotifyUserIntent & { createdAt: number })[];
}

export interface NotifyWorld {
	shift: number;
	base: number;
	users: WorldUser[];
	byUid: Map<number, WorldUser>;
	/** Oldest first by plannedAt. */
	sends: WorldSend[];
}

const NID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const nidOf = (r: Rng) => Array.from({ length: 10 }, () => NID_ALPHABET[r.int(0, 35)]).join("");
const uuidOf = (r: Rng) => `${r.hex(8)}-${r.hex(4)}-4${r.hex(3)}-${r.pick(["8", "9", "a", "b"])}${r.hex(3)}-${r.hex(12)}`;

function paramsFor(kind: string, r: Rng): Record<string, string> | null {
	switch (kind) {
		case "quest_reset":
			return { quest: r.pick(QUESTS).replace(/_/g, " "), cash: String(r.pick([150, 200, 250, 400])) };
		case "jailbreak_rush":
			return { hours: String(r.pick([2, 4, 6])) };
		case "bounty_on_you":
			return { cash: String(r.pick([300, 500, 750, 1000])) };
		case "guard_shift":
			return { bonus: String(r.pick([25, 50])) };
		default:
			return null;
	}
}

/** A send time on a day: mostly the evening (preferred hour), else any hour. */
function sendTime(r: Rng, day: number): number {
	const hour = r.chance(0.7) ? r.int(16, 21) : r.int(0, 23);
	return day + hour * HOUR + r.int(0, 59) * MINUTE + r.int(0, 59) * 1000;
}

export function buildNotifyWorld(base: number, shift: number, count = 320): NotifyWorld {
	const users: WorldUser[] = [];
	const byUid = new Map<number, WorldUser>();
	const sends: WorldSend[] = [];
	const span = 14 * DAY_MS;
	for (let i = 0; users.length < count && i < count * 2; i++) {
		const r = rng(`notify:user:${i}`);
		const userId = DEMO_UID_BASE + 100_000 + (hashString(`notify-uid:${i}`) % 899_000_000);
		if (byUid.has(userId)) continue;
		const firstSeen = base + r.int(0, span - HOUR);
		const lastSeen = Math.min(base + span - 1, firstSeen + Math.round(r.weighted([[HOUR, 3], [DAY_MS, 3], [5 * DAY_MS, 3], [span, 2]]) * r.float(0.2, 1)));
		const optin = r.weighted<"subscribed" | "not_subscribed" | null>([["subscribed", 55], ["not_subscribed", 25], [null, 20]]);
		const user: WorldUser = {
			userId,
			name: r.chance(0.85) ? fakeName(`notify:${userId}`, r.chance(0.7) ? "inmate" : "guard") : null,
			firstSeen,
			lastSeen,
			optin,
			optinAt: null,
			prefsOff: r.chance(0.08) ? [r.pick(["comeback", "guard_shift", "quest_reset"])] : null,
			intents: [],
		};
		const kinds = Object.keys(NOTIFY_KINDS);
		if (optin === "not_subscribed") {
			// The first send's answer: not opted in (S1), which mutes the player for 7 days.
			const at = firstSeen + r.int(2, 30) * HOUR;
			user.optinAt = at;
			const kind = r.pick(kinds);
			sends.push({ nid: nidOf(r), userId, kind, plannedAt: at - r.int(1, 20) * MINUTE, sentAt: at, status: "failed", http: 400, code: "FAILED_PRECONDITION", error: "User is not opted in to receive experience notifications.", try: 1, openedAt: null, playedSecs: null, params: paramsFor(kind, r), robloxId: null, test: false });
		} else if (optin === "subscribed") {
			let day = Math.floor(firstSeen / DAY_MS) * DAY_MS + DAY_MS;
			let first = true;
			while (day < base + span) {
				if (r.chance(first ? 0.9 : 0.35)) {
					const kind = r.weighted(kinds.map((k) => [k, k === "daily_spin" ? 4 : k === "quest_reset" ? 3 : k === "comeback" && day > lastSeen + 3 * DAY_MS ? 4 : 1] as const));
					const sentAt = sendTime(r, day);
					const outcome = r.weighted<"ok" | "rate" | "server" | "cancel">([["ok", 92], ["rate", 3], ["server", 2], ["cancel", 3]]);
					const opened = outcome === "ok" && r.chance(0.32) ? sentAt + r.int(1, 240) * MINUTE : null;
					if (first) user.optinAt = sentAt;
					sends.push({
						nid: nidOf(r),
						userId,
						kind,
						plannedAt: sentAt - r.int(1, 45) * MINUTE,
						sentAt,
						status: outcome === "ok" ? "sent" : outcome === "cancel" ? "cancelled" : "failed",
						http: outcome === "ok" ? 200 : outcome === "rate" ? 429 : outcome === "server" ? 503 : null,
						code: outcome === "rate" ? "RESOURCE_EXHAUSTED" : outcome === "server" ? "UNAVAILABLE" : null,
						error: outcome === "rate" ? "Too many requests: the per-user daily limit was reached." : outcome === "server" ? "Service unavailable, retries exhausted." : null,
						try: outcome === "server" ? 4 : 1,
						openedAt: opened,
						playedSecs: opened !== null && r.chance(0.75) ? r.int(60, 2700) : null,
						params: paramsFor(kind, r),
						robloxId: outcome === "ok" ? uuidOf(r) : null,
						test: false,
					});
					first = false;
				}
				day += DAY_MS;
			}
			if (first) user.optin = null;
			// What the game wants next: a quest reset tomorrow, a comeback when they drift away.
			for (const kind of r.shuffle(["quest_reset", "comeback", "daily_spin"]).slice(0, r.int(0, 2))) {
				const at = Math.min(base + span - HOUR, lastSeen + r.int(2, 30) * HOUR);
				user.intents.push({ kind, key: kind === "comeback" ? "lapse" : `day:${new Date(at).toISOString().slice(0, 10)}`, status: "pending", at, until: at + 7 * DAY_MS, updated: at, planned: false, params: paramsFor(kind, r), createdAt: lastSeen });
			}
		}
		users.push(user);
		byUid.set(userId, user);
	}
	sends.sort((a, b) => a.plannedAt - b.plannedAt);
	return { shift, base, users, byUid, sends };
}

let worldCache: { shift: number; world: NotifyWorld } | undefined;

export async function notifyWorld(): Promise<NotifyWorld> {
	const p = await pack();
	if (!worldCache || worldCache.shift !== p.shiftMs) worldCache = { shift: p.shiftMs, world: buildNotifyWorld(Math.floor(p.from / DAY_MS) * DAY_MS, p.shiftMs) };
	return worldCache.world;
}

// Test sends (demo state) -------------------------------------------------------------------------------------------------

interface TestSend {
	nid: string;
	userId: number;
	kind: string;
	plannedAt: number;
	params: Record<string, string> | null;
	data: string | null;
}

const tests = slice<TestSend[]>("notify.tests", () => []);

// Views ----------------------------------------------------------------------------------------------------------------

type ViewSend = NotifyUserSend & { userId: number };

/** A send as the store has it now: planned until its time passes, then its outcome. */
function sendAt(s: WorldSend, at: number): ViewSend | null {
	if (s.plannedAt > at) return null;
	const k = NOTIFY_KINDS[s.kind];
	const done = s.sentAt <= at;
	return {
		nid: s.nid,
		userId: s.userId,
		kind: s.kind,
		status: done ? s.status : "planned",
		test: s.test,
		plannedAt: s.plannedAt,
		sentAt: done && s.status !== "cancelled" ? s.sentAt : null,
		http: done ? s.http : null,
		code: done ? s.code : null,
		try: done ? s.try : 0,
		openedAt: done && s.openedAt !== null && s.openedAt <= at ? s.openedAt : null,
		playedSecs: done && s.openedAt !== null && s.openedAt + (s.playedSecs ?? 0) * 1000 <= at ? s.playedSecs : null,
		category: k?.category ?? s.kind,
		template: k?.template ?? null,
		params: s.params,
		data: null,
		robloxId: done ? s.robloxId : null,
		error: done ? s.error : null,
		request: requestBody(s.kind, s.params),
	};
}

/** sender.ts requestBody: what the send posts to Open Cloud (no launch data). */
function requestBody(kind: string, params: Record<string, string> | null): unknown {
	const k = NOTIFY_KINDS[kind];
	const parameters = Object.fromEntries(Object.entries(params ?? {}).map(([name, value]) => [name, { string_value: value }]));
	return {
		source: { universe: `universes/${UNIVERSE_ID}` },
		payload: { message_id: k?.template ?? null, type: "MOMENT", ...(Object.keys(parameters).length ? { parameters } : {}), analytics_data: { category: k?.category ?? kind } },
	};
}

function testSendAt(t: TestSend, world: NotifyWorld, at: number): ViewSend {
	const user = world.byUid.get(t.userId);
	const subscribed = currentOptin(user, at) === "subscribed";
	const done = at >= t.plannedAt + 3000;
	const k = NOTIFY_KINDS[t.kind];
	return {
		nid: t.nid,
		userId: t.userId,
		kind: t.kind,
		status: !done ? "planned" : subscribed ? "sent" : "failed",
		test: true,
		plannedAt: t.plannedAt,
		sentAt: done && subscribed ? t.plannedAt + 3000 : null,
		http: done ? (subscribed ? 200 : 400) : null,
		code: done && !subscribed ? "FAILED_PRECONDITION" : null,
		try: done ? 1 : 0,
		openedAt: null,
		playedSecs: null,
		category: k?.category ?? t.kind,
		template: k?.template ?? null,
		params: t.params,
		data: t.data,
		robloxId: done && subscribed ? uuidOf(rng(`notify:test:${t.nid}`)) : null,
		error: done && !subscribed ? "User is not opted in to receive experience notifications." : null,
		request: requestBody(t.kind, t.params),
	};
}

function currentOptin(user: WorldUser | undefined, at: number): "subscribed" | "not_subscribed" | null {
	if (!user || user.optinAt === null || user.optinAt > at) return null;
	return user.optin;
}

function muteUntil(user: WorldUser, at: number): number | null {
	if (user.optin !== "not_subscribed" || user.optinAt === null || user.optinAt > at) return null;
	const until = user.optinAt + MUTE_MS;
	return until > at ? until : null;
}

/** In game: seen recently and online in this half hour (moves as time goes). */
function online(user: WorldUser, at: number): boolean {
	if (user.firstSeen > at) return false;
	if (at - user.lastSeen > 2 * DAY_MS && user.lastSeen < at) return false;
	return hashString(`online:${user.userId}:${Math.floor(at / (30 * MINUTE))}`) % 12 === 0;
}

function lastSeenAt(user: WorldUser, at: number): number | null {
	if (user.firstSeen > at) return null;
	return online(user, at) ? at : Math.min(user.lastSeen, at);
}

/** Every send visible now (world + tests), newest first. */
async function allSends(at: number): Promise<ViewSend[]> {
	const world = await notifyWorld();
	const out: ViewSend[] = [];
	for (const s of world.sends) {
		const v = sendAt(s, at);
		if (v) out.push(v);
	}
	for (const t of tests.get()) if (t.plannedAt <= at) out.push(testSendAt(t, world, at));
	const when = (s: ViewSend) => s.sentAt ?? s.plannedAt ?? 0;
	return out.sort((a, b) => when(b) - when(a) || (a.nid < b.nid ? -1 : 1));
}

function nameOf(user: WorldUser | undefined): { name: string | null; displayName: string | null } {
	return { name: user?.name ?? null, displayName: user?.name ? user.name.replace("_", " ") : null };
}

// Routes ---------------------------------------------------------------------------------------------------------------

route<NotifyConfigView>("GET", "/v1/notify/config", async () => {
	const world = await notifyWorld();
	return {
		config: {
			dailyCap: 1,
			quietAfterLeaveMinutes: 120,
			lapse: [
				[14, 7],
				[30, 2],
				[60, 1],
			],
			unopenedBackoff: { after: 5, factor: 0.5, days: 14 },
			kinds: NOTIFY_KINDS,
		},
		updatedAt: world.base + 2 * HOUR,
		by: DEMO_ACTOR,
	};
});

route<NotifyStatus>("GET", "/v1/notify/status", async () => {
	const at = now();
	const world = await notifyWorld();
	const s = switches.get();
	const pending = new Map<string, number>();
	for (const u of world.users) for (const i of u.intents) if (i.createdAt <= at && (i.until ?? 0) > at) pending.set(i.kind, (pending.get(i.kind) ?? 0) + 1);
	const sends = await allSends(at);
	const day = sends.filter((x) => !x.test && (x.sentAt ?? x.plannedAt ?? 0) > at - DAY_MS);
	const due1h = world.sends.filter((x) => x.plannedAt > at && x.plannedAt <= at + HOUR).length;
	const last429 = sends.find((x) => x.http === 429);
	return {
		enabled: s.enabled,
		dryRun: s.dryRun,
		rate: s.rate,
		clock: s.clock,
		configured: { universe: true, apiKey: true },
		keys: { current: true, previous: false, since: world.base - 30 * DAY_MS },
		kinds: Object.entries(NOTIFY_KINDS).map(([kind, k]) => ({ kind, enabled: !s.kindsOff.includes(kind), template: true, text: k.text, pending: pending.get(kind) ?? 0 })),
		halted: [],
		haltedAll: null,
		haltedTemplates: [],
		presenceStaleHours: s.presenceStaleHours,
		outbox: 0,
		rowsDropped: 0,
		queue: { pending: [...pending.values()].reduce((a, b) => a + b, 0), due1h, sending: sends.filter((x) => x.status === "planned").length },
		bucket: { rate: s.rate, tokens: s.rate, last429At: last429?.sentAt ?? null },
		sends24h: { sent: day.filter((x) => x.status === "sent").length, failed: day.filter((x) => x.status === "failed").length, dry: day.filter((x) => x.status === "dry").length },
		mutes: world.users.filter((u) => muteUntil(u, at) !== null).length,
		config: true,
	};
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const uidOk = (u: unknown): u is number => typeof u === "number" && Number.isSafeInteger(u) && u > 0;

route<NotifyTestResult>("POST", "/v1/notify/test", (req) => {
	const body = req.body;
	if (!isRecord(body) || !uidOk(body.userId) || typeof body.kind !== "string" || !KIND_PATTERN.test(body.kind)) return fail(400, "send { userId, kind, params?, data? }");
	const kind = NOTIFY_KINDS[body.kind];
	if (!kind) return fail(400, "unknown kind: push the config first (typetorch notify push)");
	let params: Record<string, string> | null = null;
	if (body.params !== undefined && body.params !== null) {
		const entries = isRecord(body.params) ? Object.entries(body.params) : null;
		if (!entries || entries.length > 8 || entries.some(([k, v]) => !PARAM_NAME.test(k) || typeof v !== "string" || v.length > 64)) {
			return fail(400, `params: at most 8 entries, names ${PARAM_NAME.source}, string values of at most 64 characters`);
		}
		params = entries.length ? (Object.fromEntries(entries) as Record<string, string>) : null;
	}
	if (body.data !== undefined && (typeof body.data !== "string" || new TextEncoder().encode(body.data).length > DATA_MAX_BYTES)) return fail(400, `data is a string of at most ${DATA_MAX_BYTES} bytes`);
	const wanted = [...new Set([...kind.text.matchAll(/\{([a-zA-Z0-9_-]{1,32})\}/g)].map((m) => m[1] as string))];
	const given = Object.keys(params ?? {});
	const mismatch = wanted.some((p) => !given.includes(p)) ? "missing_param" : given.some((p) => !wanted.includes(p)) ? "unknown_param" : undefined;
	if (mismatch) return fail(400, `${mismatch}: params must be exactly the placeholders of the kind's text`);
	const at = now();
	const nid = nidOf(rng(`notify:test:${at}:${tests.get().length}`));
	tests.update((list) => {
		list.push({ nid, userId: body.userId as number, kind: body.kind as string, plannedAt: at, params, data: typeof body.data === "string" && body.data ? body.data : null });
		if (list.length > 200) list.splice(0, list.length - 200);
	});
	return { nid, status: "planned" };
});

route<NotifyUserView>("GET", "/v1/notify/user", async (req) => {
	const uidText = req.query.get("uid");
	const pidText = req.query.get("pid");
	const name = req.query.get("name");
	const world = await notifyWorld();
	let uid: number | undefined;
	let matches: number[] = [];
	if (uidText) {
		uid = /^\d{1,16}$/.test(uidText) ? Number(uidText) : undefined;
		if (uid === undefined || !Number.isSafeInteger(uid) || uid <= 0) return fail(400, "uid must be a UserId (digits)");
	} else if (pidText) {
		if (!PID_PATTERN.test(pidText)) return fail(400, "bad pid");
		// The demo maps no pid to a UserId (the identity table is empty).
		return fail(404, "no UserId known for that pid");
	} else if (name) {
		if (!/^[A-Za-z0-9_ .-]{1,64}$/.test(name)) return fail(400, "name is a Roblox username or display name");
		const needle = name.toLowerCase();
		matches = world.users.filter((u) => u.name && (u.name.toLowerCase() === needle || u.name.replace("_", " ").toLowerCase() === needle)).map((u) => u.userId);
		uid = matches[0];
		if (uid === undefined) return fail(404, "no player with that name in the name cache: search by UserId or pid (names are known once a player card was looked up)");
	} else return fail(400, "give uid, pid or name");
	const at = now();
	const user = world.byUid.get(uid);
	const seen = user && user.firstSeen <= at ? user : undefined;
	const sends = (await allSends(at)).filter((s) => s.userId === uid).slice(0, 200);
	const optin = currentOptin(seen, at);
	const mute = seen ? muteUntil(seen, at) : null;
	return {
		userId: uid,
		known: Boolean(seen) || sends.length > 0,
		pids: [],
		...nameOf(seen),
		...(matches.length > 1 ? { otherMatches: matches.slice(1) } : {}),
		prefs: seen?.prefsOff ? { off: seen.prefsOff, rev: 1, updated: seen.firstSeen + HOUR } : null,
		state: seen
			? {
					optin,
					optinAt: optin ? seen.optinAt : null,
					muteUntil: mute,
					muted: mute !== null,
					online: online(seen, at),
					presenceAt: online(seen, at) ? at - (hashString(`presence:${seen.userId}`) % 20) * MINUTE : null,
					lastSeen: lastSeenAt(seen, at),
					leftAt: online(seen, at) ? null : lastSeenAt(seen, at),
					unopened: sends.filter((s) => s.status === "sent" && s.openedAt === null && !s.test).length,
					backoffAt: null,
					cappedUntil: null,
					nextCheck: null,
					busy: null,
				}
			: null,
		sends: sends.map(({ userId: _u, ...s }) => s),
		intents: (seen?.intents ?? [])
			.filter((i) => i.createdAt <= at)
			.map(({ createdAt: _c, ...i }) => ({ ...i, status: (i.until ?? 0) > at ? i.status : "expired" })),
		events: null,
	};
});

route<NotifyRecentView>("GET", "/v1/notify/recent", async (req) => {
	const limitText = req.query.get("limit");
	const limit = limitText === null ? 100 : Number(limitText);
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(400, "limit is 1..500");
	const kind = req.query.get("kind") ?? undefined;
	if (kind !== undefined && !/^[a-z0-9_]{1,24}$/.test(kind)) return fail(400, "bad kind");
	const at = now();
	const world = await notifyWorld();
	const sends: NotifyRecentSend[] = (await allSends(at))
		.filter((s) => !kind || s.kind === kind)
		.slice(0, limit)
		.map((s) => {
			const user = world.byUid.get(s.userId);
			return {
				nid: s.nid,
				kind: s.kind,
				status: s.status,
				test: s.test,
				plannedAt: s.plannedAt,
				sentAt: s.sentAt,
				http: s.http,
				code: s.code,
				try: s.try,
				openedAt: s.openedAt,
				playedSecs: s.playedSecs,
				category: s.category,
				params: s.params,
				userId: s.userId,
				optin: currentOptin(user, at),
				...nameOf(user),
			};
		});
	return { sends };
});

interface OptinRow extends NotifyOptinUser {
	/** The keyset's time: optinAt (subscribed / not_subscribed), muteUntil (muted), 0 (unknown). */
	key: number;
}

async function optinRows(state: NotifyOptinState, at: number, uids?: number[]): Promise<OptinRow[]> {
	const world = await notifyWorld();
	const sends = await allSends(at);
	const totals = new Map<number, { sends: number; opened: number }>();
	for (const s of sends) {
		if (s.test || (s.status !== "sent" && s.status !== "failed")) continue;
		const t = totals.get(s.userId) ?? { sends: 0, opened: 0 };
		t.sends += 1;
		if (s.openedAt !== null) t.opened += 1;
		totals.set(s.userId, t);
	}
	const rows: OptinRow[] = [];
	for (const u of world.users) {
		if (u.firstSeen > at || (uids && !uids.includes(u.userId))) continue;
		const optin = currentOptin(u, at);
		const mute = muteUntil(u, at);
		const inState = state === "muted" ? mute !== null : state === "unknown" ? optin === null : optin === state;
		if (!inState) continue;
		const t = totals.get(u.userId) ?? { sends: 0, opened: 0 };
		const { name, displayName } = nameOf(u);
		rows.push({
			userId: u.userId,
			name,
			displayName,
			optin,
			optinAt: optin ? u.optinAt : null,
			lastSeen: lastSeenAt(u, at),
			online: online(u, at),
			muteUntil: mute,
			sends: t.sends,
			opened: t.opened,
			key: state === "muted" ? (mute ?? 0) : state === "unknown" ? 0 : (u.optinAt ?? 0),
		});
	}
	return rows.sort((a, b) => b.key - a.key || b.userId - a.userId);
}

async function optinCounts(at: number): Promise<NotifyOptinTotals> {
	const world = await notifyWorld();
	const out: NotifyOptinTotals = { subscribed: 0, notSubscribed: 0, unknown: 0, muted: 0, newThisWeek: 0 };
	for (const u of world.users) {
		if (u.firstSeen > at) continue;
		const optin = currentOptin(u, at);
		if (optin === "subscribed") {
			out.subscribed++;
			if ((u.optinAt ?? 0) >= at - 7 * DAY_MS) out.newThisWeek++;
		} else if (optin === "not_subscribed") out.notSubscribed++;
		else out.unknown++;
		if (muteUntil(u, at) !== null) out.muted++;
	}
	return out;
}

function csvCell(text: string): string {
	return /[",\n\r]/.test(text) || /^[=+\-@]/.test(text) ? `"${text.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : text;
}

route<NotifyUsersView>("GET", "/v1/notify/users", async (req) => {
	const p = req.query;
	const state = (p.get("state") ?? "subscribed") as NotifyOptinState;
	if (!(OPTIN_STATES as readonly string[]).includes(state)) return fail(400, `state is one of ${OPTIN_STATES.join(", ")}`);
	const csv = p.get("format") === "csv";
	if (p.get("format") !== null && !csv) return fail(400, "format is csv (or leave it out for JSON)");
	const limitText = p.get("limit");
	const limit = limitText === null ? 50 : Number(limitText);
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(400, "limit is 1..200");
	let after: { at: number; uid: number } | undefined;
	const cursorText = p.get("cursor");
	if (cursorText) {
		const m = /^(\d{1,16})\.(\d{1,19})$/.exec(cursorText);
		if (!m || !Number.isSafeInteger(Number(m[1])) || !Number.isSafeInteger(Number(m[2]))) return fail(400, "bad cursor");
		after = { at: Number(m[1]), uid: Number(m[2]) };
	}
	const q = (p.get("q") ?? "").trim();
	let uids: number[] | undefined;
	const world = await notifyWorld();
	if (q) {
		if (q.length > 64) return fail(400, "q is at most 64 characters");
		if (/^\d{1,19}$/.test(q)) uids = [Number(q)];
		else if (/^@?[A-Za-z0-9_ .-]{1,64}$/.test(q)) {
			const needle = q.replace(/^@/, "").toLowerCase();
			uids = world.users.filter((u) => u.name && (u.name.toLowerCase().startsWith(needle) || u.name.replace("_", " ").toLowerCase().startsWith(needle))).map((u) => u.userId).slice(0, 50);
		} else return fail(400, "q is a UserId or a username / display name");
	}
	const at = now();
	let rows = await optinRows(state, at, uids);
	if (after) {
		const a = after;
		rows = rows.filter((r) => (state === "unknown" ? r.userId < a.uid : r.key < a.at || (r.key === a.at && r.userId < a.uid)));
	}
	const strip = ({ key: _k, ...u }: OptinRow): NotifyOptinUser => u;
	if (!csv) {
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		return { counts: await optinCounts(at), users: page.map(strip), next: rows.length > limit && last ? `${last.key}.${last.userId}` : null };
	}
	const isoOr = (ms: number | null) => (ms ? new Date(ms).toISOString() : "");
	const lines = ["user_id,name,state,optin_at,last_seen,online,mute_until,sends,opened"];
	for (const u of rows.slice(0, CSV_MAX)) lines.push([u.userId, csvCell(u.name ?? ""), u.optin ?? "unknown", isoOr(u.optinAt), isoOr(u.lastSeen), u.online ? 1 : 0, isoOr(u.muteUntil), u.sends, u.opened].join(","));
	return new Response(`${lines.join("\n")}\n`, {
		status: 200,
		headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="notify-${state}.csv"`, "cache-control": "no-store", "x-truncated": rows.length > CSV_MAX ? "1" : "0" },
	});
});
