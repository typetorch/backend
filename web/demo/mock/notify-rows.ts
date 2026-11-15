/**
 * The `kind = 'notify'` rows behind the Notifications page's analytics tabs (notify-funnel, notify-optin, notify-queue).
 * The pack has none, so the engine's setup writes them (synthetic, like the feedback answers in engine.ts):
 *
 *   - the sends of notify.ts's world (the Inbox / Subscribers tabs), row for row: `want` (the game asking), `planned`,
 *     `sent` or `failed` (400 not opted in, 429, 503 with its retries), `skipped` for a cancelled send, `optin_inferred`
 *     from the answers; `open` / `played` when the world's player opened it, placed at the start of the mapped player's
 *     next session (within 48 h), so opens, plays and D1 returns line up with real sessions;
 *   - the planner's other skips (online, quiet hours, daily cap, muted...);
 *   - the opt-in prompt (`optin_check` / `optin_shown` / `optin_closed`) in the pack players' early sessions.
 *
 * The world is keyed by demo UserIds; each of its users is mapped (here only, never in an answer) to a pack pid that
 * started playing about when they did. The rows carry pids only, like the backend's; identity answers stay empty.
 * Game-server rows take the session's context (job, artifact, device...) from that session's first row and sit inside
 * the session, so they never stretch it.
 */
import { EVENT_FIELDS } from "../../../src/schema.ts";
import { DAY_MS } from "./data";
import type { Row } from "./engine";
import { NOTIFY_KINDS, notifyWorld, type WorldSend } from "./notify";
import { hashString, rng } from "./rng";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const OPEN_WINDOW_MS = 2 * DAY_MS;
const CHUNK = 1500;

interface Session {
	pid: string;
	sid: string;
	t0: number;
	t1: number;
}

interface NotifyRow {
	/** The session for a game-server row; null for a backend row. */
	sid: string | null;
	pid: string;
	t: number;
	name: string;
	props: Record<string, unknown>;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const keyHash = (text: string) => (hashString(`key:${text}`).toString(16).padStart(8, "0") + hashString(`key2:${text}`).toString(16).padStart(8, "0")).slice(0, 12);

/** The newest session of `list` (sorted by t0) that started at or before `t`. */
function sessionBefore(list: Session[], t: number): Session | undefined {
	let found: Session | undefined;
	for (const s of list) {
		if (s.t0 > t) break;
		found = s;
	}
	return found;
}

/** The first session of `list` that starts after `t` (within `windowMs`). */
function sessionAfter(list: Session[], t: number, windowMs: number): Session | undefined {
	for (const s of list) if (s.t0 > t) return s.t0 - t <= windowMs ? s : undefined;
	return undefined;
}

/** A time inside the session, `offset` ms after its start (never past its end). */
const inside = (s: Session, offset: number) => Math.min(s.t1, s.t0 + Math.max(0, offset));

/** Builds the rows (pure: the world, and the sessions of every player). Exported for tests. */
export function buildNotifyRows(world: { users: { userId: number; firstSeen: number; optin: string | null }[]; sends: WorldSend[] }, sessions: Session[]): NotifyRow[] {
	const byPid = new Map<string, Session[]>();
	for (const s of sessions) {
		const list = byPid.get(s.pid);
		if (list) list.push(s);
		else byPid.set(s.pid, [s]);
	}
	for (const list of byPid.values()) list.sort((a, b) => a.t0 - b.t0 || (a.sid < b.sid ? -1 : 1));
	const players = [...byPid.entries()].map(([pid, list]) => ({ pid, firstAt: (list[0] as Session).t0, sessions: list.length })).sort((a, b) => a.firstAt - b.firstAt || (a.pid < b.pid ? -1 : 1));

	// World user -> pid: the unused player who started closest to the user's first visit (subscribed users prefer players
	// who came back at least once, so their sends can be opened).
	const pidOf = new Map<number, string>();
	const used = new Set<string>();
	for (const u of [...world.users].sort((a, b) => a.firstSeen - b.firstSeen || a.userId - b.userId)) {
		let best: string | undefined;
		let bestCost = Infinity;
		for (const p of players) {
			if (used.has(p.pid)) continue;
			const cost = Math.abs(p.firstAt - u.firstSeen) + (u.optin === "subscribed" ? (p.sessions < 2 ? 3 * DAY_MS : 0) + (p.sessions < 4 ? DAY_MS : 0) : 0);
			if (cost < bestCost) {
				bestCost = cost;
				best = p.pid;
			}
		}
		if (!best) break;
		used.add(best);
		pidOf.set(u.userId, best);
	}

	const rows: NotifyRow[] = [];
	const backend = (pid: string, t: number, name: string, props: Record<string, unknown>) => rows.push({ sid: null, pid, t, name, props });
	const game = (s: Session, t: number, name: string, props: Record<string, unknown>) => rows.push({ sid: s.sid, pid: s.pid, t, name, props });

	// The world's sends.
	const inferred = new Set<number>();
	const sendDays = new Map<number, Set<number>>();
	for (const send of world.sends) {
		const pid = pidOf.get(send.userId);
		if (!pid || send.test) continue;
		const list = byPid.get(pid) ?? [];
		const r = rng(`notify-rows:${send.nid}`);
		const k = send.kind;
		const config = NOTIFY_KINDS[k];
		const day = Math.floor(send.sentAt / DAY_MS);
		if (!sendDays.has(send.userId)) sendDays.set(send.userId, new Set());
		sendDays.get(send.userId)?.add(day);
		// The game asked for it in the player's last session before the plan.
		const before = sessionBefore(list, send.plannedAt - MINUTE);
		if (before) {
			const at = Math.min(before.t1, Math.max(before.t0, send.plannedAt - r.int(2, 90) * MINUTE));
			game(before, at, "want", { k, key: keyHash(`${pid}:${k}:${day}`), at: Math.floor(at / 1000), until: config?.maxWaitHours ? Math.floor((at + config.maxWaitHours * HOUR) / 1000) : 0, offline: true });
		}
		const why = config?.send === "asap" ? "asap" : r.chance(0.12) ? "until" : "hour";
		backend(pid, send.plannedAt, "planned", { nid: send.nid, k, for: Math.floor(send.sentAt / 1000), why });
		const category = config?.category ?? k;
		if (send.status === "cancelled") {
			backend(pid, send.sentAt, "skipped", { k, why: r.weighted([["outranked", 3], ["dropped", 2], ["expired", 1]]) });
			continue;
		}
		if (send.status === "failed") {
			const http = send.http;
			if (http === 400) {
				backend(pid, send.sentAt, "failed", { nid: send.nid, k, http, code: send.code ?? "FAILED_PRECONDITION", final: true });
				backend(pid, send.sentAt, "optin_inferred", { state: "not_subscribed" });
				inferred.add(send.userId);
			} else {
				// Retries with backoff, the last one final.
				for (let i = send.try - 1; i >= 0; i--) backend(pid, send.sentAt - i * (30_000 << (2 * i)), "failed", { nid: send.nid, k, http, code: send.code ?? String(http), final: i === 0 });
			}
			continue;
		}
		if (!inferred.has(send.userId)) {
			backend(pid, send.sentAt, "optin_inferred", { state: "subscribed" });
			inferred.add(send.userId);
		}
		backend(pid, send.sentAt, "sent", { nid: send.nid, k, try: send.try, roblox_id: send.robloxId ?? `${send.nid}-r`, category });
		if (send.openedAt !== null) {
			const s = sessionAfter(list, send.sentAt, OPEN_WINDOW_MS);
			if (s) {
				game(s, s.t0, "open", { nid: send.nid, k, age: Math.round((s.t0 - send.sentAt) / 1000), first: true });
				const secs = Math.min(send.playedSecs ?? 0, Math.floor((s.t1 - s.t0) / 1000));
				if (secs >= 1) game(s, s.t0 + secs * 1000, "played", { nid: send.nid, k, secs });
			}
		}
	}

	// The planner's other skips: a subscribed player on a day without a send, a muted one (not opted in, 7 days).
	const kinds = Object.keys(NOTIFY_KINDS);
	for (const u of world.users) {
		const pid = pidOf.get(u.userId);
		if (!pid || u.optin === null) continue;
		const r = rng(`notify-rows:skips:${u.userId}`);
		const firstDay = Math.floor(u.firstSeen / DAY_MS) + 1;
		const lastDay = Math.floor((world.sends[world.sends.length - 1]?.plannedAt ?? u.firstSeen) / DAY_MS);
		for (let day = firstDay; day <= lastDay; day++) {
			if (sendDays.get(u.userId)?.has(day)) continue;
			const muted = u.optin === "not_subscribed" && day < firstDay + 7;
			if (!r.chance(muted ? 0.3 : 0.25)) continue;
			const why = muted ? "muted" : r.weighted([["online", 40], ["quiet", 20], ["capped_day", 18], ["capped_week", 10], ["lapsed", 6], ["pref_off", 6]]);
			const t = day * DAY_MS + r.int(15, 21) * HOUR + r.int(0, 59) * MINUTE;
			backend(pid, t, "skipped", { k: r.weighted(kinds.map((k) => [k, k === "daily_spin" ? 4 : k === "quest_reset" ? 3 : 1] as const)), why });
		}
	}

	// The opt-in prompt: checked early in a player's first sessions until it was shown once.
	const optinOf = new Map<string, string | null>();
	for (const u of world.users) {
		const pid = pidOf.get(u.userId);
		if (pid) optinOf.set(pid, u.optin);
	}
	const WHERE: [string, number][] = [["after_escape", 30], ["daily_reward", 25], ["quest_complete", 25], ["cell_block", 20]];
	for (const { pid } of players) {
		const list = byPid.get(pid) ?? [];
		const r = rng(`notify-rows:optin:${pid}`);
		const known = optinOf.get(pid);
		for (const s of list.filter((x) => x.t1 - x.t0 >= 60_000).slice(0, 3)) {
			const at = inside(s, Math.min(r.int(45, 600) * 1000, Math.floor((s.t1 - s.t0) / 2)));
			const err = known === undefined && r.chance(0.02) ? r.pick(["timeout", "HTTP 500"]) : null;
			const can = known === "subscribed" || known === "not_subscribed" ? true : !err && r.chance(0.6);
			const where = r.weighted(WHERE);
			game(s, at, "optin_check", err ? { can: false, where, err } : { can, where });
			if (!can || (known === undefined && !r.chance(0.85))) continue;
			const shown = Math.min(s.t1, at + 1000);
			game(s, shown, "optin_shown", { where });
			const closed = Math.min(s.t1, shown + r.int(2, 25) * 1000);
			game(s, closed, "optin_closed", { where, secs: Math.round((closed - shown) / 1000) });
			break;
		}
	}
	return rows.sort((a, b) => a.t - b.t || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0) || (a.name < b.name ? -1 : 1));
}

/** The INSERT statements for the rows (game-server rows copy their session's context from `_tt_first`). */
export function insertStatements(rows: NotifyRow[]): string[] {
	const columns = [...EVENT_FIELDS.map((f) => f.name), "rt"];
	const set: Record<string, string> = {
		v: "1",
		t: "n.t",
		kind: "'notify'",
		name: "n.name",
		pid: "n.pid",
		sid: "COALESCE(n.sid, '')",
		job: "CASE WHEN n.sid IS NULL THEN 'backend' ELSE s.job END",
		art: "CASE WHEN n.sid IS NULL THEN 'backend' ELSE s.art END",
		src: "CASE WHEN n.sid IS NULL THEN 'backend' ELSE 'server' END",
		props: "n.props",
		rt: "n.t",
	};
	const out: string[] = [];
	for (let i = 0; i < rows.length; i += CHUNK) {
		const values = rows
			.slice(i, i + CHUNK)
			.map((r) => `(${r.sid === null ? "NULL" : quote(r.sid)}, ${quote(r.pid)}, ${Math.round(r.t)}, ${quote(r.name)}, ${quote(JSON.stringify(r.props))})`)
			.join(", ");
		out.push(
			`INSERT INTO _tt_events (${columns.map((c) => `"${c}"`).join(", ")}) SELECT ${columns.map((c) => `${set[c] ?? `s."${c}"`} AS "${c}"`).join(", ")} ` +
				`FROM (SELECT CAST(sid AS VARCHAR) AS sid, CAST(pid AS VARCHAR) AS pid, CAST(t AS BIGINT) AS t, CAST(name AS VARCHAR) AS name, CAST(props AS VARCHAR) AS props ` +
				`FROM (VALUES ${values}) v(sid, pid, t, name, props)) n LEFT JOIN _tt_first s ON s.sid = n.sid`,
		);
	}
	return out;
}

/**
 * Writes the notify rows into `_tt_events` (after the base setup). `run` runs one statement on the engine being set up.
 * Returns how many rows it wrote.
 */
export async function addNotifyRows(run: (statement: string) => Promise<Row[]>): Promise<number> {
	const world = await notifyWorld();
	const real = `pid IS NOT NULL AND pid <> '' AND sid IS NOT NULL AND sid <> '' AND kind <> 'notify'`;
	const sessions = (await run(`SELECT pid, sid, MIN(t) AS t0, MAX(t) AS t1 FROM _tt_events WHERE ${real} GROUP BY pid, sid ORDER BY pid, t0, sid`)).map((r) => ({
		pid: String(r.pid),
		sid: String(r.sid),
		t0: Number(r.t0),
		t1: Number(r.t1),
	}));
	const rows = buildNotifyRows(world, sessions);
	await run(
		`CREATE OR REPLACE TABLE _tt_first AS SELECT * EXCLUDE (rn) FROM (SELECT *, row_number() OVER (PARTITION BY sid ORDER BY t, kind, name, props) AS rn FROM _tt_events WHERE ${real}) x WHERE rn = 1`,
	);
	for (const statement of insertStatements(rows)) await run(statement);
	await run("DROP TABLE _tt_first");
	return rows.length;
}
