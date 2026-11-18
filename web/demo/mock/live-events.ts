/**
 * Scheduled live events (src/server/live-events.ts, app.ts liveEventsRoute):
 *
 *   GET  /v1/live-events?refresh=1          events with their sync state, the schedule, the sign commands, the signed view
 *   POST /v1/live-events                    create (the backend's checks: names, values, times, clashes, the schedule size)
 *   POST /v1/live-events/<id>/cancel        cancel
 *   GET  /v1/live-events/<id>/lift          the lift report: the backend's live-event-lift query on the pack + its report
 *
 * Kept in the demo state, seeded with Prison events around the pack's last days (one ended, one live, one scheduled, one
 * cancelled). The backend never signs: the owner runs the CLI command. The demo can't, so "Refresh" (refresh=1) reads
 * back a record that holds the current schedule, as if the owner had just signed it.
 */
import { AFTER_DAYS_MAX, buildLiftReport, planLiftWindows, WEEKS_MAX } from "../../../src/server/live-event-lift.ts";
import { AHEAD_MAX_DAYS, DURATION_MAX_DAYS, GAME_KEY_PATTERN, LIVE_EVENTS_KEY, LIVE_EVENTS_MAX, PENDING_MAX, SCHEDULE_BYTES_MAX, signCommands, syncOf, VALUE_BYTES_MAX, VALUES_MAX } from "../../../src/server/live-events.ts";
import type { LiftReport, LiveEvent, LiveEventsView, LiveEventStatus, ScheduledEvent, SignCommands, SignedView } from "@/lib/live-events";
import { runNamedQuery } from "./analytics";
import { DAY_MS, now } from "./data";
import { DEMO_OWNER, rng } from "./rng";
import { fail, HttpError, json, route } from "./router";
import { nextId, slice } from "./state";

const HOUR = 3_600_000;
const START_SLACK_MS = 5 * 60_000;
/** actorOf() for the demo owner's Roblox session. */
export const DEMO_ACTOR = `roblox user ${DEMO_OWNER.userId} (${DEMO_OWNER.name})`;

interface Row {
	id: string;
	name: string;
	note: string | null;
	values: Record<string, unknown>;
	start: number;
	end: number;
	createdAt: number;
	createdBy: string;
	cancelledAt: number | null;
	cancelledBy: string | null;
}

interface Signed {
	seq: number;
	at: number;
	schedule: { v: 1; events: ScheduledEvent[] };
}

const iso = (ms: number) => new Date(ms).toISOString();

function statusOf(r: Row, at: number): LiveEventStatus {
	if (r.cancelledAt !== null) return "cancelled";
	if (at < r.start) return "scheduled";
	if (at < r.end) return "live";
	return "ended";
}

function info(r: Row, at: number): LiveEvent {
	return {
		id: r.id,
		name: r.name,
		note: r.note,
		values: r.values,
		start: iso(r.start),
		end: iso(r.end),
		status: statusOf(r, at),
		createdAt: iso(r.createdAt),
		createdBy: r.createdBy,
		cancelledAt: r.cancelledAt === null ? null : iso(r.cancelledAt),
		cancelledBy: r.cancelledBy,
	};
}

function scheduleFrom(rows: Row[]): { v: 1; events: ScheduledEvent[] } {
	return {
		v: 1,
		events: [...rows]
			.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
			.map((r) => ({ id: r.id, name: r.name, start: r.start / 1000, end: r.end / 1000, set: r.values })),
	};
}

const pendingRows = (rows: Row[], at: number) => rows.filter((r) => r.cancelledAt === null && r.end > at);

function seedRows(): Row[] {
	const at = now();
	const today = Math.floor(at / DAY_MS) * DAY_MS;
	const hour = Math.floor(at / HOUR) * HOUR;
	return [
		{
			id: "ev_dblcash7k2",
			name: "Double Cash Weekend",
			note: "Every cash reward x2: jobs, quests, escapes and arrests.",
			values: { "cash.multiplier": 2 },
			start: today - 5 * DAY_MS + 16 * HOUR,
			end: today - 3 * DAY_MS + 22 * HOUR,
			createdAt: today - 7 * DAY_MS + 10 * HOUR,
			createdBy: DEMO_ACTOR,
			cancelledAt: null,
			cancelledBy: null,
		},
		{
			id: "ev_jailbrk4q9",
			name: "Jailbreak Rush",
			note: "Escapes pay double and the sewer grate opens every 30 s.",
			values: { "escape.rewardMultiplier": 2, "escape.sewerCooldownSeconds": 30 },
			start: hour - 2 * HOUR,
			end: hour + 4 * HOUR,
			createdAt: today - 1 * DAY_MS + 9 * HOUR,
			createdBy: DEMO_ACTOR,
			cancelledAt: null,
			cancelledBy: null,
		},
		{
			id: "ev_guardrc2m8",
			name: "Guard Recruitment Drive",
			note: "Guards earn +50 salary per shift; shield batons 25% off in the armory.",
			values: { "team.guardSalaryBonus": 50, "shop.discount.shieldbaton": 0.25 },
			start: today + 3 * DAY_MS + 15 * HOUR,
			end: today + 5 * DAY_MS + 15 * HOUR,
			createdAt: today - 2 * DAY_MS + 14 * HOUR,
			createdBy: DEMO_ACTOR,
			cancelledAt: null,
			cancelledBy: null,
		},
		{
			id: "ev_lockdwn9x3",
			name: "Warden's Lockdown Night",
			note: "Cell doors stay shut, lockpicks only. Called off: it clashed with the tutorial test.",
			values: { "prison.lockdown": true, "shop.price.lockpick": 0 },
			start: today + 1 * DAY_MS + 20 * HOUR,
			end: today + 1 * DAY_MS + 23 * HOUR,
			createdAt: today - 4 * DAY_MS + 11 * HOUR,
			createdBy: DEMO_ACTOR,
			cancelledAt: today - 1 * DAY_MS + 18 * HOUR,
			cancelledBy: DEMO_ACTOR,
		},
	];
}

const events = slice<Row[]>("live.events", seedRows);
/** The signed settings record as last read back: at first it holds the seeded schedule (signed by the owner). */
const signed = slice<Signed>("live.signed", () => {
	const at = now();
	return { seq: 41, at: at - 20 * HOUR, schedule: scheduleFrom(pendingRows(seedRows(), at)) };
});

function signedView(at: number): SignedView {
	const s = signed.get();
	return { state: "ok", seq: s.seq, at: iso(s.at), verified: "sig", schedule: s.schedule, readAt: iso(at) };
}

export function liveEventsView(refresh: boolean): LiveEventsView {
	const at = now();
	const rows = events.get();
	const schedule = scheduleFrom(pendingRows(rows, at));
	if (refresh) {
		// The demo's stand-in for "the owner ran the sign command": the record now holds the current schedule.
		const current = signed.get();
		if (JSON.stringify(current.schedule) !== JSON.stringify(schedule)) signed.set({ seq: current.seq + 1, at, schedule });
	}
	const view = signedView(at);
	const list = [...rows].sort((a, b) => b.start - a.start || a.id.localeCompare(b.id)).map((r) => info(r, at));
	const withSync = list.map((e) => ({ ...e, sync: syncOf(e as never, view as never, at) }));
	const needsSigning = withSync.some((e) => e.sync === "unsigned" || e.sync === "outdated" || e.sync === "cancel-unsigned");
	return { now: iso(at), events: withSync, schedule, commands: signCommands(schedule), signed: view, needsSigning };
}

route<LiveEventsView>("GET", "/v1/live-events", (req) => liveEventsView(req.query.get("refresh") === "1"));

function newId(): string {
	const r = rng(`live-event:${nextId("liveEvent")}:${now()}`);
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	let out = "ev_";
	while (out.length < 13) out += alphabet[r.int(0, 35)];
	return out;
}

function timeOf(value: unknown, what: string): number {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
		const ms = Date.parse(value.trim());
		if (Number.isFinite(ms)) return ms;
	}
	throw new HttpError(400, `${what} is unix ms or an ISO time with a zone (2026-11-21T12:00:00Z)`);
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function valuesOf(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HttpError(400, 'values is an object of game keys: { "cash.multiplier": 2 }');
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length === 0 || entries.length > VALUES_MAX) throw new HttpError(400, `an event sets 1 to ${VALUES_MAX} keys`);
	for (const [key, value] of entries) {
		if (!GAME_KEY_PATTERN.test(key)) throw new HttpError(400, `key "${key.slice(0, 80)}" must be 1-64 characters of letters, digits and _ . : / -`);
		if (key === LIVE_EVENTS_KEY) throw new HttpError(400, `"${LIVE_EVENTS_KEY}" is the schedule itself`);
		if (value === null || value === undefined) throw new HttpError(400, `${key}: a value is required (null can't be sent to Luau)`);
		const text = JSON.stringify(value);
		if (text === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new HttpError(400, `${key}: not a JSON value`);
		if (bytes(text) > VALUE_BYTES_MAX) throw new HttpError(400, `${key}: at most ${VALUE_BYTES_MAX} bytes of JSON`);
	}
	return Object.fromEntries(entries);
}

/** LiveEventStore.create's checks, on the demo state. */
export function createEvent(input: unknown, createdBy: string): LiveEvent {
	const b = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "name is 1-80 characters, one line");
	let note: string | null = null;
	if (b.note !== undefined && b.note !== null && b.note !== "") {
		if (typeof b.note !== "string" || b.note.length > 500) throw new HttpError(400, "note is at most 500 characters");
		note = b.note;
	}
	const values = valuesOf(b.values);
	const at = now();
	let start = Math.floor(timeOf(b.start, "start") / 1000) * 1000;
	const end = Math.floor(timeOf(b.end, "end") / 1000) * 1000;
	if (start < at - START_SLACK_MS) throw new HttpError(400, "start is in the past (a live event can't be backdated)");
	if (start < at) start = Math.floor(at / 1000) * 1000;
	if (end <= start) throw new HttpError(400, "end must be after start");
	if (end - start > DURATION_MAX_DAYS * DAY_MS) throw new HttpError(400, `an event lasts at most ${DURATION_MAX_DAYS} days`);
	if (start > at + AHEAD_MAX_DAYS * DAY_MS) throw new HttpError(400, `start is at most ${AHEAD_MAX_DAYS} days ahead`);
	const rows = events.get();
	const pending = pendingRows(rows, at);
	for (const r of pending) {
		if (r.start >= end || start >= r.end) continue;
		const shared = Object.keys(values).filter((k) => Object.keys(r.values).includes(k));
		if (shared.length) throw new HttpError(409, `"${r.name}" (${r.id}) sets ${shared.join(", ")} at the same time: cancel it or pick other times`);
	}
	if (pending.length >= PENDING_MAX) throw new HttpError(409, `at most ${PENDING_MAX} scheduled and live events at once`);
	if (rows.length >= LIVE_EVENTS_MAX) throw new HttpError(409, `at most ${LIVE_EVENTS_MAX} events are kept`);
	let id = newId();
	while (rows.some((r) => r.id === id)) id = newId();
	const row: Row = { id, name, note, values, start, end, createdAt: at, createdBy: createdBy.slice(0, 120), cancelledAt: null, cancelledBy: null };
	const size = bytes(JSON.stringify(scheduleFrom([...pending, row])));
	if (size > SCHEDULE_BYTES_MAX) throw new HttpError(409, `the signed schedule would be ${size} bytes (at most ${SCHEDULE_BYTES_MAX}): fewer or smaller events`);
	events.update((list) => {
		list.push(row);
	});
	return info(row, at);
}

function commandsNow(): SignCommands {
	return signCommands(scheduleFrom(pendingRows(events.get(), now())));
}

route<{ event: LiveEvent; commands: SignCommands }>("POST", "/v1/live-events", (req) => {
	if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return fail(415, "send JSON: { name, values, start, end, note? }");
	if (req.text.length > 16 * 1024) return fail(413, "body too large");
	if (req.body === undefined) return fail(400, "body is not JSON");
	const event = createEvent(req.body, DEMO_ACTOR);
	return json(201, { event, commands: commandsNow() });
});

const ID_PATTERN = /^ev_[0-9a-z]{10}$/;

route<{ event: LiveEvent; commands: SignCommands }>("POST", "/v1/live-events/:id/cancel", (req) => {
	const id = req.params.id as string;
	if (!ID_PATTERN.test(id)) return fail(404, "not found");
	const row = events.get().find((r) => r.id === id);
	if (!row) return fail(404, "no such event");
	const at = now();
	const status = statusOf(row, at);
	if (status === "cancelled") return fail(409, "already cancelled");
	if (status === "ended") return fail(409, "it has ended");
	let done: Row = row;
	events.update((list) => {
		const r = list.find((x) => x.id === id) as Row;
		r.cancelledAt = at;
		r.cancelledBy = DEMO_ACTOR;
		done = r;
	});
	return { event: info(done, at), commands: commandsNow() };
});

interface LiftResult {
	windows: Parameters<typeof buildLiftReport>[1];
}

route<{ event: LiveEvent; report: LiftReport; cached: boolean }>("GET", "/v1/live-events/:id/lift", async (req) => {
	const id = req.params.id as string;
	if (!ID_PATTERN.test(id)) return fail(404, "not found");
	const rows = events.get();
	const row = rows.find((r) => r.id === id);
	if (!row) return fail(404, "no such event");
	const at = now();
	const event = info(row, at);
	const int = (name: string, fallback: number, max: number, min: number) => {
		const v = req.query.get(name);
		if (v === null || v === "") return fallback;
		const n = Number(v);
		return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
	};
	const weeks = int("weeks", 3, WEEKS_MAX, 1);
	const afterDays = int("afterDays", 3, AFTER_DAYS_MAX, 0);
	if (weeks === undefined) return fail(400, `weeks is a whole number from 1 to ${WEEKS_MAX}`);
	if (afterDays === undefined) return fail(400, `afterDays is a whole number from 0 to ${AFTER_DAYS_MAX}`);
	let plan: ReturnType<typeof planLiftWindows>;
	try {
		const end = row.cancelledAt !== null ? Math.min(row.end, row.cancelledAt) : row.end;
		const others = rows.filter((r) => r.id !== id && r.cancelledAt === null).map((r) => ({ from: r.start, to: r.end }));
		plan = planLiftWindows({ start: row.start, end }, at, { weeks, afterDays }, others);
	} catch (error) {
		return fail(409, (error as Error).message);
	}
	const lo = Math.min(...plan.windows.map((w) => w.from));
	const hi = Math.max(...plan.windows.map((w) => w.to));
	try {
		const result = (await runNamedQuery("live-event-lift", { from: lo, to: hi }, { windows: plan.windows })) as LiftResult;
		return { event, report: buildLiftReport(plan, result.windows) as LiftReport, cached: false };
	} catch (error) {
		return fail(500, "query failed", { detail: ((error as Error).message ?? String(error)).slice(0, 300) });
	}
});
