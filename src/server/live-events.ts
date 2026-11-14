/**
 * Scheduled live events ("double cash, Saturday 12:00 to Sunday 23:59 UTC"): an event sets game live values
 * (`liveConfig` keys) for a time window on every game server.
 *
 * Security design (option b of the brief): the backend never holds the game's signing key and gives servers nothing
 * they treat as signed. It keeps the schedule and prepares its JSON; the owner signs it with the CLI like any other
 * live value (`typetorch settings set game.tt.events -`), with the start and end times INSIDE the signed record. The
 * framework (settings.ts) switches the values on and off at those times on each server's own clock: a server that
 * starts mid-event picks it up from the record at boot, and the event ends on time even when the backend is down
 * then, because nothing has to be sent at the end. Cancelling is signing the schedule without the event. The backend
 * only reads the signed record back (Open Cloud, read scope) to show whether servers have the current schedule.
 *
 *   game["tt.events"] = { v: 1, events: [{ id, name, start, end, set: { [key]: JSON } }] }   (unix seconds, UTC)
 *
 * The table lives in the fleet SQLite file, every row cached in memory (the server is one process and writes through
 * this store):
 *
 *   live_events (id PK, name, note, values_json, start_at, end_at, created_at, created_by, cancelled_at, cancelled_by)
 *
 * Status: cancelled (cancelled_at set), scheduled (now < start), live (start <= now < end), ended. Times are whole
 * seconds (ms in the table).
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { FleetDb } from "../fleet/db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS live_events (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, values_json TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, cancelled_at INTEGER, cancelled_by TEXT);
CREATE INDEX IF NOT EXISTS live_events_start ON live_events (start_at);
`;

/** The `game` key of the signed schedule (framework settings.ts LIVE_EVENTS_KEY). */
export const LIVE_EVENTS_KEY = "tt.events";
/** The CLI's game key rule (cli settings.ts GAME_KEY_PATTERN). */
export const GAME_KEY_PATTERN = /^[A-Za-z0-9_.:/-]{1,64}$/;
/** Events kept (all of them: past ones carry their reports). */
export const LIVE_EVENTS_MAX = 5000;
/** Scheduled and live events at once (the framework reads 64 from a schedule). */
export const PENDING_MAX = 50;
/** Keys one event sets. */
export const VALUES_MAX = 8;
/** One value, JSON bytes. */
export const VALUE_BYTES_MAX = 1024;
/** The whole schedule, JSON bytes (the record's `game` is at most 16 KB, shared with the game's other values). */
export const SCHEDULE_BYTES_MAX = 8192;
export const DURATION_MAX_DAYS = 31;
export const AHEAD_MAX_DAYS = 366;
/** A start this far in the past is still "now" (the form's clock, a slow request). */
const START_SLACK_MS = 5 * 60_000;
const DAY = 86_400_000;

export type LiveEventStatus = "scheduled" | "live" | "ended" | "cancelled";

export interface LiveEvent {
	id: string;
	name: string;
	note: string | null;
	/** The `game` values it sets while it runs. */
	values: Record<string, unknown>;
	start: string;
	end: string;
	status: LiveEventStatus;
	createdAt: string;
	createdBy: string;
	cancelledAt: string | null;
	cancelledBy: string | null;
}

interface Row {
	id: string;
	name: string;
	note: string | null;
	values_json: string;
	start_at: number;
	end_at: number;
	created_at: number;
	created_by: string;
	cancelled_at: number | null;
	cancelled_by: string | null;
}

export class LiveEventError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409,
	) {
		super(message);
	}
}

const iso = (ms: number) => new Date(ms).toISOString();

function newId(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	let out = "ev_";
	while (out.length < 13) for (const b of randomBytes(16)) if (b < 252 && out.length < 13) out += alphabet[b % 36];
	return out;
}

/** A time from the form: unix ms or an ISO time with a zone (a time without one would be ambiguous). */
function timeOf(value: unknown, what: string): number {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
		const ms = Date.parse(value.trim());
		if (Number.isFinite(ms)) return ms;
	}
	throw new LiveEventError(`${what} is unix ms or an ISO time with a zone (2026-11-21T12:00:00Z)`, 400);
}

/** JSON with sorted object keys: two values compare equal whatever order their keys came in. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Checks an event's values: 1-VALUES_MAX game keys, each a JSON value (no null: Luau tables can't hold it). */
function valuesOf(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new LiveEventError('values is an object of game keys: { "cash.multiplier": 2 }', 400);
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length === 0 || entries.length > VALUES_MAX) throw new LiveEventError(`an event sets 1 to ${VALUES_MAX} keys`, 400);
	for (const [key, value] of entries) {
		if (!GAME_KEY_PATTERN.test(key)) throw new LiveEventError(`key "${key.slice(0, 80)}" must be 1-64 characters of letters, digits and _ . : / -`, 400);
		if (key === LIVE_EVENTS_KEY) throw new LiveEventError(`"${LIVE_EVENTS_KEY}" is the schedule itself`, 400);
		if (value === null || value === undefined) throw new LiveEventError(`${key}: a value is required (null can't be sent to Luau)`, 400);
		let text: string;
		try {
			text = JSON.stringify(value);
		} catch {
			throw new LiveEventError(`${key}: not a JSON value`, 400);
		}
		if (text === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new LiveEventError(`${key}: not a JSON value`, 400);
		if (Buffer.byteLength(text, "utf8") > VALUE_BYTES_MAX) throw new LiveEventError(`${key}: at most ${VALUE_BYTES_MAX} bytes of JSON`, 400);
	}
	return Object.fromEntries(entries);
}

/** One event in the signed schedule. */
export interface ScheduledEvent {
	id: string;
	name: string;
	/** Unix seconds. */
	start: number;
	end: number;
	set: Record<string, unknown>;
}

export interface Schedule {
	v: 1;
	events: ScheduledEvent[];
}

export class LiveEventStore {
	private readonly rows = new Map<string, Row>();

	private constructor(
		private readonly db: FleetDb,
		private readonly clock: () => number,
	) {}

	static async open(db: FleetDb, clock: () => number = Date.now): Promise<LiveEventStore> {
		await db.exec(SCHEMA);
		const store = new LiveEventStore(db, clock);
		for (const r of await db.all<Row>("SELECT * FROM live_events ORDER BY start_at LIMIT ?", [LIVE_EVENTS_MAX])) store.rows.set(r.id, store.normal(r));
		return store;
	}

	private normal(r: Row): Row {
		const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
		return { ...r, start_at: Number(r.start_at), end_at: Number(r.end_at), created_at: Number(r.created_at), cancelled_at: n(r.cancelled_at) };
	}

	private statusOf(r: Row, now: number): LiveEventStatus {
		if (r.cancelled_at !== null) return "cancelled";
		if (now < r.start_at) return "scheduled";
		if (now < r.end_at) return "live";
		return "ended";
	}

	private info(r: Row, now: number): LiveEvent {
		return {
			id: r.id,
			name: r.name,
			note: r.note,
			values: JSON.parse(r.values_json) as Record<string, unknown>,
			start: iso(r.start_at),
			end: iso(r.end_at),
			status: this.statusOf(r, now),
			createdAt: iso(r.created_at),
			createdBy: r.created_by,
			cancelledAt: r.cancelled_at === null ? null : iso(r.cancelled_at),
			cancelledBy: r.cancelled_by,
		};
	}

	/** Every event, newest start first. */
	list(): LiveEvent[] {
		const now = this.clock();
		return [...this.rows.values()].sort((a, b) => b.start_at - a.start_at || a.id.localeCompare(b.id)).map((r) => this.info(r, now));
	}

	get(id: string): LiveEvent | undefined {
		const r = this.rows.get(id);
		return r ? this.info(r, this.clock()) : undefined;
	}

	/** The windows of the other events that weren't cancelled (a lift baseline must not overlap them). */
	windowsExcept(id: string): { from: number; to: number }[] {
		return [...this.rows.values()].filter((r) => r.id !== id && r.cancelled_at === null).map((r) => ({ from: r.start_at, to: r.end_at }));
	}

	/** Creates an event. Throws LiveEventError on bad input or a clash. */
	async create(input: unknown, createdBy: string): Promise<LiveEvent> {
		const b = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
		const name = typeof b.name === "string" ? b.name.trim() : "";
		if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new LiveEventError("name is 1-80 characters, one line", 400);
		let note: string | null = null;
		if (b.note !== undefined && b.note !== null && b.note !== "") {
			if (typeof b.note !== "string" || b.note.length > 500) throw new LiveEventError("note is at most 500 characters", 400);
			note = b.note;
		}
		const values = valuesOf(b.values);
		const now = this.clock();
		// Whole seconds: the schedule is in seconds.
		let start = Math.floor(timeOf(b.start, "start") / 1000) * 1000;
		const end = Math.floor(timeOf(b.end, "end") / 1000) * 1000;
		if (start < now - START_SLACK_MS) throw new LiveEventError("start is in the past (a live event can't be backdated)", 400);
		if (start < now) start = Math.floor(now / 1000) * 1000;
		if (end <= start) throw new LiveEventError("end must be after start", 400);
		if (end - start > DURATION_MAX_DAYS * DAY) throw new LiveEventError(`an event lasts at most ${DURATION_MAX_DAYS} days`, 400);
		if (start > now + AHEAD_MAX_DAYS * DAY) throw new LiveEventError(`start is at most ${AHEAD_MAX_DAYS} days ahead`, 400);
		const pending = [...this.rows.values()].filter((r) => r.cancelled_at === null && r.end_at > now);
		for (const r of pending) {
			if (r.start_at >= end || start >= r.end_at) continue;
			const theirs = Object.keys(JSON.parse(r.values_json) as object);
			const shared = Object.keys(values).filter((k) => theirs.includes(k));
			if (shared.length) throw new LiveEventError(`"${r.name}" (${r.id}) sets ${shared.join(", ")} at the same time: cancel it or pick other times`, 409);
		}
		if (pending.length >= PENDING_MAX) throw new LiveEventError(`at most ${PENDING_MAX} scheduled and live events at once`, 409);
		if (this.rows.size >= LIVE_EVENTS_MAX) throw new LiveEventError(`at most ${LIVE_EVENTS_MAX} events are kept`, 409);
		let id = newId();
		while (this.rows.has(id)) id = newId();
		const row: Row = { id, name, note, values_json: JSON.stringify(values), start_at: start, end_at: end, created_at: now, created_by: createdBy.slice(0, 120), cancelled_at: null, cancelled_by: null };
		const size = Buffer.byteLength(JSON.stringify(this.scheduleFrom([...pending, row])), "utf8");
		if (size > SCHEDULE_BYTES_MAX) throw new LiveEventError(`the signed schedule would be ${size} bytes (at most ${SCHEDULE_BYTES_MAX}): fewer or smaller events`, 409);
		await this.db.run(
			"INSERT INTO live_events (id, name, note, values_json, start_at, end_at, created_at, created_by, cancelled_at, cancelled_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
			[row.id, row.name, row.note, row.values_json, row.start_at, row.end_at, row.created_at, row.created_by],
		);
		this.rows.set(id, row);
		return this.info(row, now);
	}

	/** Cancels a scheduled or live event (servers drop it once the owner signs the new schedule). */
	async cancel(id: string, by: string): Promise<LiveEvent> {
		const row = this.rows.get(id);
		if (!row) throw new LiveEventError("no such event", 404);
		const now = this.clock();
		const status = this.statusOf(row, now);
		if (status === "cancelled") throw new LiveEventError("already cancelled", 409);
		if (status === "ended") throw new LiveEventError("it has ended", 409);
		row.cancelled_at = now;
		row.cancelled_by = by.slice(0, 120);
		await this.db.run("UPDATE live_events SET cancelled_at = ?, cancelled_by = ? WHERE id = ?", [row.cancelled_at, row.cancelled_by, id]);
		return this.info(row, now);
	}

	private scheduleFrom(rows: Row[]): Schedule {
		return {
			v: 1,
			events: [...rows]
				.sort((a, b) => a.start_at - b.start_at || a.id.localeCompare(b.id))
				.map((r) => ({ id: r.id, name: r.name, start: r.start_at / 1000, end: r.end_at / 1000, set: JSON.parse(r.values_json) as Record<string, unknown> })),
		};
	}

	/** What servers should hold now: every scheduled or live event (ended and cancelled ones drop out). */
	schedule(): Schedule {
		const now = this.clock();
		return this.scheduleFrom([...this.rows.values()].filter((r) => r.cancelled_at === null && r.end_at > now));
	}
}

/** The CLI commands that sign a schedule (bash / zsh, and PowerShell with the JSON in a file). */
export function signCommands(schedule: Schedule): { json: string; bash: string; powershell: string } {
	const json = JSON.stringify(schedule);
	return {
		json,
		bash: `typetorch settings set game.${LIVE_EVENTS_KEY} - <<'TT_EVENTS'\n${json}\nTT_EVENTS`,
		powershell: `Get-Content live-events.json -Raw | typetorch settings set game.${LIVE_EVENTS_KEY} -`,
	};
}

// The signed record, read back ----------------------------------------------------------------------------------------

/** What the backend saw in the signed settings record (DataStore `TypeTorch` / `settings`). */
export interface SignedView {
	/** ok: read; unconfigured: no Open Cloud key or universe; missing: no record; error: the read failed. */
	state: "ok" | "unconfigured" | "missing" | "error";
	error?: string;
	seq?: number;
	at?: string;
	/** Which signature verified with the game's public keys the backend knows (the trust-link keys); "unchecked" without keys. */
	verified?: "sig" | "sigF" | "no" | "unchecked";
	/** The schedule in the record (null: none, or not a v1 schedule). */
	schedule?: Schedule | null;
	readAt: string;
}

const SETTINGS_CANONICAL = "tt1settings";

/** Checks a settings record's signatures (`tt1settings \n seq \n at \n body`, Ed25519, base64) against raw base64 public keys. */
export function verifySettingsRecord(record: { seq: number; at: string; body: string; sig?: unknown; sigF?: unknown }, publicKeys: string[]): "sig" | "sigF" | "no" {
	if (!Number.isSafeInteger(record.seq) || record.at.includes("\n")) return "no";
	const text = Buffer.from(`${SETTINGS_CANONICAL}\n${record.seq}\n${record.at}\n${record.body}`, "utf8");
	const check = (signature: unknown) =>
		typeof signature === "string" &&
		signature.length <= 200 &&
		publicKeys.some((k) => {
			try {
				const raw = Buffer.from(k, "base64");
				if (raw.length !== 32) return false;
				const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
				return verify(null, text, key, Buffer.from(signature, "base64"));
			} catch {
				return false;
			}
		});
	if (check(record.sig)) return "sig";
	if (check(record.sigF)) return "sigF";
	return "no";
}

/** A v1 schedule from a record's `game[tt.events]`, or null. */
export function scheduleIn(value: unknown): Schedule | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as { v?: unknown; events?: unknown };
	if (v.v !== 1 || !Array.isArray(v.events)) return null;
	const events: ScheduledEvent[] = [];
	for (const e of v.events as unknown[]) {
		if (typeof e !== "object" || e === null) continue;
		const x = e as Record<string, unknown>;
		if (typeof x.id !== "string" || typeof x.start !== "number" || typeof x.end !== "number" || typeof x.set !== "object" || x.set === null) continue;
		events.push({ id: x.id, name: typeof x.name === "string" ? x.name : x.id, start: x.start, end: x.end, set: x.set as Record<string, unknown> });
	}
	return { v: 1, events };
}

/** Parses the DataStore value of the settings record into a view (no network). */
export function signedViewOf(value: unknown, publicKeys: string[], now: number): SignedView {
	const readAt = iso(now);
	if (value === undefined || value === null) return { state: "missing", readAt };
	const r = value as { v?: unknown; seq?: unknown; at?: unknown; body?: unknown; sig?: unknown; sigF?: unknown };
	if (r.v !== 1 || typeof r.seq !== "number" || typeof r.at !== "string" || typeof r.body !== "string") return { state: "error", error: "the settings entry isn't a v1 record", readAt };
	let body: { game?: Record<string, unknown> };
	try {
		body = JSON.parse(r.body) as typeof body;
	} catch {
		return { state: "error", error: "the record's body isn't JSON", readAt };
	}
	const verified = publicKeys.length ? verifySettingsRecord({ seq: r.seq, at: r.at, body: r.body, sig: r.sig, sigF: r.sigF }, publicKeys) : "unchecked";
	return { state: "ok", seq: r.seq, at: r.at, verified, schedule: scheduleIn(body?.game?.[LIVE_EVENTS_KEY]), readAt };
}

/** Per event: does the signed record hold it as the backend has it? */
export type SyncState =
	/** In the record, the same times and values. */
	| "signed"
	/** In the record with other times or values. */
	| "outdated"
	/** Not in the record: servers won't run it until the owner signs. */
	| "unsigned"
	/** Cancelled here but still in the record and not over: servers WILL run it until the owner signs. */
	| "cancel-unsigned"
	/** Nothing to sign (ended, or cancelled and out of the record). */
	| "done"
	/** The record couldn't be read or verified. */
	| "unknown";

export function syncOf(event: LiveEvent, view: SignedView, now: number): SyncState {
	const startMs = Date.parse(event.start);
	const endMs = Date.parse(event.end);
	const inRecord = view.state === "ok" && view.verified !== "no" ? view.schedule?.events.find((e) => e.id === event.id) : undefined;
	if (event.status === "ended") return "done";
	if (view.state === "missing" && event.status === "cancelled") return "done";
	if (view.state !== "ok" && view.state !== "missing") return "unknown";
	if (view.state === "ok" && view.verified === "no") return "unknown";
	if (event.status === "cancelled") return inRecord && inRecord.end * 1000 > now ? "cancel-unsigned" : "done";
	if (!inRecord) return "unsigned";
	const same = inRecord.start * 1000 === startMs && inRecord.end * 1000 === endMs && stableJson(inRecord.set) === stableJson(event.values);
	return same ? "signed" : "outdated";
}
