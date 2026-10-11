/**
 * The server page's offline history (GET /v1/fleet/servers/<job> `history`, and kernel 0.5.3 debug bundles), as plain
 * data for the Timeline, the Offline badge and the bundle view. A bundle's sections come from a game server: untrusted,
 * so everything here turns them into plain strings and numbers (the page renders text only, never HTML).
 */
import { fmtTime } from "@/lib/format";
import type { FleetServerDetail, RemoteLogEntry, ServerHistory } from "@/lib/types";

/** A kernel-made bundle id: 32 lowercase hex characters (anything else in ?bundle= is ignored). */
export const BUNDLE_ID = /^[0-9a-f]{32}$/;

export const isBundleId = (value: unknown): value is string => typeof value === "string" && BUNDLE_ID.test(value);

/** The bundle an alert points at (kernel 0.5.3 `d.bundle`), or undefined. */
export function alertBundle(details: Record<string, unknown> | null | undefined): string | undefined {
	const id = details?.bundle;
	return isBundleId(id) ? id : undefined;
}

const ms = (iso: string | null | undefined) => {
	if (!iso) return undefined;
	const t = new Date(iso).getTime();
	return Number.isNaN(t) ? undefined : t;
};

/** When a server that isn't live went: closed at, lost at (the sweep's mark, else its last heartbeat), or nothing (gone). */
export function goneAt(detail: Pick<FleetServerDetail, "server" | "state">): number | undefined {
	const s = detail.server;
	if (!s) return undefined;
	if (detail.state === "closed") return ms(s.closedAt) ?? ms(s.lastSeen);
	if (detail.state === "lost") return ms(s.lostAt) ?? ms(s.lastSeen);
	return undefined;
}

/** The Offline badge's words: "closed at 2026-10-09 10:00:00 UTC", "lost at ...", "gone" (no row left). */
export function offlineText(detail: Pick<FleetServerDetail, "server" | "state">): string {
	const at = goneAt(detail);
	if (detail.state === "closed") return at !== undefined ? `closed at ${fmtTime(at)} UTC` : "closed";
	if (detail.state === "lost") return at !== undefined ? `lost at ${fmtTime(at)} UTC` : "lost";
	return "gone";
}

/** How long the server ran: from its start to now (live) or to when it went; undefined when unknown. */
export function lifetimeMs(detail: Pick<FleetServerDetail, "server" | "state">, now = Date.now()): number | undefined {
	const s = detail.server;
	const start = ms(s?.startedAt);
	if (start === undefined) return undefined;
	const end = detail.state === "live" ? now : (goneAt(detail) ?? ms(s?.lastSeen) ?? now);
	return end >= start ? end - start : undefined;
}

/** Where the whole-life charts start: the metrics' first point, else the server's start, else its first heartbeat. */
export function lifeStart(detail: Pick<FleetServerDetail, "server" | "history">): number | undefined {
	return detail.history?.metrics.from ?? ms(detail.server?.startedAt) ?? ms(detail.server?.firstSeen);
}

export type TimelineKind = "alert" | "report" | "swap" | "closed" | "lost" | "started";

export interface TimelineEvent {
	key: string;
	at: number;
	kind: TimelineKind;
	/** critical / warning / info for alerts; failed / ok for reports. */
	tone?: "critical" | "warning" | "info" | "good";
	title: string;
	detail?: string;
	/** A debug bundle this event points at (an alert's d.bundle, a swap's source). */
	bundle?: string;
}

const FAILED_RESULTS = new Set(["failed", "rolled_back"]);
const secs = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100) / 100} s` : undefined);

/**
 * The Timeline: alerts, deploy reports, generation starts (swaps, from the bundles' deploy history), the start and the
 * close or loss, newest first.
 */
export function timelineEvents(detail: Pick<FleetServerDetail, "server" | "state" | "history">): TimelineEvent[] {
	const h: ServerHistory | undefined = detail.history;
	const out: TimelineEvent[] = [];
	for (const a of h?.alerts ?? []) {
		const bundle = alertBundle(a.details);
		out.push({ key: `alert:${a.id}`, at: a.at, kind: "alert", tone: a.level, title: `${a.level} alert ${a.code}`, detail: a.message, ...(bundle ? { bundle } : {}) });
	}
	for (const [i, r] of (h?.reports ?? []).entries()) {
		const took = secs(r.seconds);
		out.push({
			key: `report:${r.seq}:${r.at}:${i}`,
			at: r.at,
			kind: "report",
			tone: FAILED_RESULTS.has(r.result) ? "critical" : "good",
			title: `Deploy #${r.seq}: ${r.result}`,
			detail: [r.artifact, took ? `took ${took}` : undefined, r.error].filter(Boolean).join(" · ") || undefined,
		});
	}
	for (const s of h?.swaps ?? []) {
		const times = [secs(s.loadSeconds) && `load ${secs(s.loadSeconds)}`, secs(s.swapSeconds) && `swap ${secs(s.swapSeconds)}`].filter(Boolean).join(", ");
		out.push({
			key: `swap:${s.at}:${s.name ?? ""}`,
			at: s.at,
			kind: "swap",
			tone: "info",
			title: `Generation ${s.name ?? "?"} started${s.reason ? ` (${s.reason})` : ""}`,
			detail: [s.artifact, times].filter(Boolean).join(" · ") || undefined,
			bundle: s.bundle,
		});
	}
	const started = ms(detail.server?.startedAt);
	if (started !== undefined) out.push({ key: "started", at: started, kind: "started", tone: "info", title: "Server started" });
	const went = goneAt(detail);
	if (went !== undefined && (detail.state === "closed" || detail.state === "lost"))
		out.push({
			key: detail.state,
			at: went,
			kind: detail.state,
			tone: detail.state === "lost" ? "warning" : "info",
			title: detail.state === "closed" ? "Server closed" : "Server lost (no heartbeat for 90 s, no closing message)",
		});
	return out.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

// A bundle's sections, as plain values -------------------------------------------------------------------------------------

/** Any value as one line of text (objects as compact JSON), clipped. */
export function plain(value: unknown, max = 2000): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const LOG_KINDS = new Set(["output", "info", "warning", "error"]);

/** Log lines (the server's `serverLog`, a player's `playerLogs` entry) as the log table's rows; an index when one is missing. */
export function logEntries(list: unknown): RemoteLogEntry[] {
	if (!Array.isArray(list)) return [];
	return list.map((raw, index) => {
		const e = record(raw);
		const kind = typeof e.kind === "string" && LOG_KINDS.has(e.kind) ? (e.kind as RemoteLogEntry["kind"]) : "output";
		return { i: num(e.i) ?? index + 1, t: num(e.t) ?? 0, kind, text: plain(e.text, 10_000) };
	});
}

export interface BundlePlayer {
	userId: string;
	name: string;
	joinedAt?: number;
	leftAt?: number;
	ping?: number;
	client: string;
}

/** The bundle's `players` ({ u, n, joinedAt, leftAt?, ping?, client? }) as rows. */
export function bundlePlayers(list: unknown): BundlePlayer[] {
	if (!Array.isArray(list)) return [];
	return list.map((raw) => {
		const p = record(raw);
		const joinedAt = num(p.joinedAt);
		const leftAt = num(p.leftAt);
		const ping = num(p.ping);
		return {
			userId: plain(p.u, 32),
			name: plain(p.n, 64),
			...(joinedAt !== undefined ? { joinedAt } : {}),
			...(leftAt !== undefined ? { leftAt } : {}),
			...(ping !== undefined ? { ping } : {}),
			client: plain(p.client, 300),
		};
	});
}

/** The players whose client logs are in the bundle, with their name when `players` has it. */
export function playerLogOwners(playerLogs: unknown, players: BundlePlayer[]): { userId: string; label: string }[] {
	const names = new Map(players.map((p) => [p.userId, p.name]));
	return Object.keys(record(playerLogs)).map((userId) => ({ userId, label: names.get(userId) ? `${names.get(userId)} (${userId})` : `UserId ${userId}` }));
}

/** A section's field as a plain object or list (for the Deploy and swaps tab). */
export const field = (section: unknown, key: string): unknown => record(section)[key];
export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asRecord = record;
