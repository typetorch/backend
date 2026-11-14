/**
 * Scheduled live events (GET /v1/live-events, the backend's src/server/live-events.ts): the types, the form's UTC
 * times, and the chart marks (a start and an end line per event, next to the deploy marks).
 */
import type { DeployMark } from "./perf";

export type LiveEventStatus = "scheduled" | "live" | "ended" | "cancelled";
export type SyncState = "signed" | "outdated" | "unsigned" | "cancel-unsigned" | "done" | "unknown";

export interface LiveEvent {
	id: string;
	name: string;
	note: string | null;
	values: Record<string, unknown>;
	start: string;
	end: string;
	status: LiveEventStatus;
	createdAt: string;
	createdBy: string;
	cancelledAt: string | null;
	cancelledBy: string | null;
	sync?: SyncState;
}

export interface ScheduledEvent {
	id: string;
	name: string;
	start: number;
	end: number;
	set: Record<string, unknown>;
}

export interface SignedView {
	state: "ok" | "unconfigured" | "missing" | "error";
	error?: string;
	seq?: number;
	at?: string;
	verified?: "sig" | "sigF" | "no" | "unchecked";
	schedule?: { v: 1; events: ScheduledEvent[] } | null;
	readAt: string;
}

export interface SignCommands {
	json: string;
	bash: string;
	powershell: string;
}

export interface LiveEventsView {
	now: string;
	events: LiveEvent[];
	schedule: { v: 1; events: ScheduledEvent[] };
	commands: SignCommands;
	signed: SignedView;
	needsSigning: boolean;
}

export interface LiveEventInput {
	name: string;
	values: Record<string, unknown>;
	start: string;
	end: string;
	note?: string;
}

export type Direction = "up" | "down" | "flat" | "unknown";

export interface Lift {
	value: number | null;
	baseline: number | null;
	lift: number | null;
	spread: { min: number; max: number } | null;
	weeks: (number | null)[];
	direction: Direction;
}

export interface LiftWindow {
	from: number;
	to: number;
}

export interface LiftWindowMetrics extends LiftWindow {
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeMinutes: number;
	robux: number;
	purchases: number;
	payers: number;
}

export type LiftMetricKey = "players" | "playtimePerPlayer" | "sessionsPerPlayer" | "robuxPerPlayer" | "payerConversion" | "newPlayers";
export type NetMetricKey = "playtimeMinutes" | "robux" | "sessions" | "newPlayers";

export interface LiftReport {
	plan: {
		event: LiftWindow;
		after: LiftWindow | null;
		baselines: { weeksBack: number; event: LiftWindow; after: LiftWindow | null }[];
		skipped: { weeksBack: number; reason: string }[];
		partial: boolean;
		afterPartial: boolean;
		stepDays: number;
		afterDays: number;
	};
	weeksUsed: number[];
	weeksEmpty: number[];
	event: Record<LiftMetricKey, Lift>;
	after: Record<LiftMetricKey, Lift> | null;
	net: Record<NetMetricKey, Lift> | null;
	raw: { event: LiftWindowMetrics; after: LiftWindowMetrics | null };
	verdict: string;
	headline: Direction;
}

export const LIFT_ROWS: { key: LiftMetricKey; label: string; kind: "count" | "minutes" | "ratio" | "robux" | "share" }[] = [
	{ key: "players", label: "Players", kind: "count" },
	{ key: "playtimePerPlayer", label: "Playtime per player", kind: "minutes" },
	{ key: "sessionsPerPlayer", label: "Sessions per player", kind: "ratio" },
	{ key: "robuxPerPlayer", label: "Robux per player", kind: "robux" },
	{ key: "payerConversion", label: "Payer conversion", kind: "share" },
	{ key: "newPlayers", label: "New players", kind: "count" },
];

export const NET_ROWS: { key: NetMetricKey; label: string }[] = [
	{ key: "playtimeMinutes", label: "Playtime (min)" },
	{ key: "robux", label: "Robux" },
	{ key: "sessions", label: "Sessions" },
	{ key: "newPlayers", label: "New players" },
];

/** "+18%" (null: "–"). */
export function fmtLift(x: number | null | undefined): string {
	if (x === null || x === undefined || !Number.isFinite(x)) return "–";
	const r = Math.round(x * 100);
	return `${r >= 0 ? "+" : ""}${r === 0 ? 0 : r}%`;
}

/** "-3% to +5%". */
export function fmtSpread(s: { min: number; max: number } | null | undefined): string {
	return s ? `${fmtLift(s.min)} to ${fmtLift(s.max)}` : "–";
}

/** A datetime-local value ("2026-11-21T12:00") read as UTC, as an ISO time; undefined when it isn't one. */
export function utcInputToIso(value: string): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
	const ms = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A time as a datetime-local value in UTC ("2026-11-21T12:00"). */
export function isoToUtcInput(ms: number): string {
	return new Date(ms).toISOString().slice(0, 16);
}

/** "Sat 2026-11-21 12:00 UTC". */
export function fmtUtc(iso: string | number): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return String(iso);
	const day = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
	return `${day} ${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The same time on this browser's clock: "Sat 15:00 local" ("Sat 21 Nov 15:00 local" on another day than in UTC). */
export function fmtLocal(iso: string | number, timeZone?: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) };
	return `${d.toLocaleString("en-GB", opts)} local`;
}

/** A form's values text: a JSON object of game keys. Throws a plain message. */
export function parseValues(text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('values must be JSON: { "cash.multiplier": 2 }');
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error('values is an object of game keys: { "cash.multiplier": 2 }');
	return parsed as Record<string, unknown>;
}

/** The events' start and end lines in [from, to) as chart marks (cancelled ones left out; one cancelled early ends then). */
export function liveEventMarks(events: readonly LiveEvent[], from: number, to: number): DeployMark[] {
	const out: DeployMark[] = [];
	for (const e of events) {
		if (e.status === "cancelled" && (!e.cancelledAt || Date.parse(e.cancelledAt) <= Date.parse(e.start))) continue;
		const end = e.status === "cancelled" && e.cancelledAt ? Math.min(Date.parse(e.end), Date.parse(e.cancelledAt)) : Date.parse(e.end);
		for (const [edge, at] of [
			["start", Date.parse(e.start)],
			["end", end],
		] as const) {
			if (at < from || at >= to) continue;
			out.push({
				id: `event:${e.id}:${edge}`,
				kind: "event",
				at,
				time: new Date(at).toISOString(),
				branch: null,
				seq: null,
				artifact: null,
				channel: null,
				from: null,
				kernel: null,
				placeVersion: null,
				message: `${e.name} ${edge === "start" ? "starts" : "ends"}`,
			});
		}
	}
	return out;
}
