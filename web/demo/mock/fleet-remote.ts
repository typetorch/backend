/**
 * Remote debug in the demo (plans/25 and 34): what a live Prison server's kernel would answer to each read-only op, from
 * the same model as the fleet list (players, readings, deploy reports, the game's columns), plus the in-memory command
 * queue and watches (the backend keeps those in memory too: a reload forgets them). The audit is kept in the demo state.
 *
 * Player identities are the demo's fake ones (fakeName, negative fakeUserId); nothing links to Roblox.
 */
import { checkCommand, gameCommandName, OPS, RemoteDebugInputError } from "../../../src/fleet/remote-debug.ts";
import type {
	DebugAuditEntry,
	DebugStatus,
	DexChildrenPage,
	DexPropRow,
	DexProps,
	DexRow,
	RemoteAssets,
	RemoteBudget,
	RemoteBuilds,
	RemoteCommand,
	RemoteErrors,
	RemoteLogEntry,
	RemoteLogs,
	RemoteModules,
	RemoteNetwork,
	RemotePlayerLogs,
	RemotePlayers,
	RemoteStatus,
	StateEntry,
	StateQuery,
	StateReply,
} from "@/lib/types";
import { now } from "./data";
import { clientLogLines, columnValuesAt, lastSeenOf, occupantsAt, placeVersionOf, readingAt, serverLogLine, type Model, type Occupant } from "./fleet-model";
import { GAME_COMMANDS } from "./fleet-world";
import type { PackJob } from "./pack";
import { DEMO_OWNER, hashString, rng } from "./rng";
import { HttpError } from "./router";
import { slice } from "./state";

// Watches and the command queue (memory only, like the backend) ------------------------------------------------------------

/** A watch lapses 60 s after the last one; the server picks it up about 1.5 s after it starts (an instant wake). */
const WATCH_MS = 60_000;
const CONNECT_MS = 1_500;
const COMMAND_TTL_MS = 30_000;
const KEEP_ANSWERS_MS = 3 * 60_000;

const watches = new Map<string, { since: number; until: number }>();
let liveMapUntil = 0;

export function debugStatus(job: string, at = now()): DebugStatus {
	const w = watches.get(job);
	if (!w || w.until < at) return { watched: false, connected: false };
	const connected = at - w.since >= CONNECT_MS;
	const lastPollAt = connected ? at - ((at - w.since) % 8_000) : undefined;
	return { watched: true, watchedUntil: w.until, connected, ...(lastPollAt !== undefined ? { lastPollAt } : {}) };
}

/** POST .../watch: starts or extends the watch; `wake` while the server hasn't polled yet. */
export function watch(job: string, at = now()): DebugStatus & { wake: boolean } {
	const held = watches.get(job);
	const since = held && held.until >= at ? held.since : at;
	watches.set(job, { since, until: at + WATCH_MS });
	const status = debugStatus(job, at);
	return { ...status, wake: !status.connected };
}

export function watchLiveMap(at = now()): { until: number; wake: boolean } {
	const wake = liveMapUntil < at;
	liveMapUntil = at + WATCH_MS;
	return { until: liveMapUntil, wake };
}

export function liveMapWatchedUntil(at = now()): number | null {
	return liveMapUntil >= at ? liveMapUntil : null;
}

interface Command {
	id: string;
	job: string;
	op: string;
	args: Record<string, unknown>;
	createdAt: number;
	expiresAt: number;
	/** When the kernel answers (it picks the command up once connected, then takes a few hundred ms). */
	readyAt: number;
	ms: number;
	answer?: { result?: unknown; error?: string; redacted?: number };
}

const commands = new Map<string, Command>();

/** Forgets watches and commands (tests). */
export function resetRemote(): void {
	watches.clear();
	commands.clear();
	liveMapUntil = 0;
}

const audit = slice<DebugAuditEntry[]>("fleet.debugAudit", () => []);

/** The audit: newest first (the backend keeps the last 500 in memory). */
export function auditLog(limit: number): DebugAuditEntry[] {
	return audit.get().slice(0, Math.min(Math.max(1, limit), 500));
}

/** The visitor's address as the audit writes it (a documentation address: the demo never sees a real one). */
const VISITOR_IP = "198.51.100.23";

const isWholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** Checks the op and args like the backend (src/fleet/remote-debug.ts), except that the demo's UserIds are negative. */
function checked(op: unknown, args: unknown, declared: (name: string) => boolean): { op: string; args: Record<string, unknown> } {
	if (op === "player.logs") {
		const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
		for (const key of Object.keys(a)) if (key !== "userId" && key !== "since") throw new RemoteDebugInputError(`unknown argument ${JSON.stringify(key.slice(0, 40))}`);
		if (!isWholeNumber(a.userId) || a.userId === 0) throw new RemoteDebugInputError("userId must be a UserId");
		if (a.since !== undefined && (!isWholeNumber(a.since) || a.since < 0)) throw new RemoteDebugInputError("since must be a whole number >= 0");
		return { op, args: { userId: a.userId, ...(a.since !== undefined ? { since: a.since } : {}) } };
	}
	return checkCommand(op, args, declared);
}

function auditSummary(op: string, args: Record<string, unknown>): string {
	if (Object.hasOwn(OPS, op)) return (OPS[op] as (typeof OPS)[string]).summary(args);
	const n = Object.keys(args).length;
	return `game-defined${n ? `, ${n} arg${n === 1 ? "" : "s"}` : ""}`;
}

/** POST .../commands: queues a command (409 when nobody watches the server). */
export function enqueue(m: Model, j: PackJob, body: unknown): RemoteCommand {
	const at = now();
	const b = (typeof body === "object" && body !== null ? body : {}) as { op?: unknown; args?: unknown };
	let parsed: { op: string; args: Record<string, unknown> };
	try {
		parsed = checked(b.op, b.args, (name) => GAME_COMMANDS.some((c) => c.n === name));
	} catch (error) {
		if (error instanceof RemoteDebugInputError) throw new HttpError(400, error.message);
		throw error;
	}
	const status = debugStatus(j.job, at);
	if (!status.watched) throw new HttpError(409, "this server isn't watched: open its page (POST .../watch) first");
	const waiting = [...commands.values()].filter((c) => c.job === j.job && !c.answer && c.readyAt > at);
	if (waiting.length >= 8) throw new HttpError(429, "this server already has 8 commands waiting");
	const r = rng(`fleet:cmd:${at}:${commands.size}`);
	const id = r.hex(24);
	const w = watches.get(j.job) as { since: number };
	const pickup = Math.max(at, w.since + CONNECT_MS);
	const ms = parsed.op === "dex.children" || parsed.op === "state" ? r.int(8, 40) : r.int(2, 18);
	const command: Command = { id, job: j.job, op: parsed.op, args: parsed.args, createdAt: at, expiresAt: at + COMMAND_TTL_MS, readyAt: pickup + r.int(250, 700), ms };
	commands.set(id, command);
	audit.update((list) => [{ at, who: `roblox:${DEMO_OWNER.userId}`, ip: VISITOR_IP, op: parsed.op, job: j.job, args: auditSummary(parsed.op, parsed.args), id }, ...list].slice(0, 500));
	// Forget answers past their keep.
	for (const [key, c] of commands) if (c.createdAt < at - KEEP_ANSWERS_MS) commands.delete(key);
	return { id, op: parsed.op, state: "queued", createdAt: at, expiresAt: command.expiresAt };
}

/** GET .../commands/<id>: the command's state and, once the kernel answered, its result. */
export function commandView(m: Model, j: PackJob | undefined, job: string, id: string): RemoteCommand | undefined {
	const c = commands.get(id);
	if (!c || c.job !== job) return undefined;
	const at = now();
	const base = { id: c.id, op: c.op, createdAt: c.createdAt, expiresAt: c.expiresAt };
	if (at < c.readyAt) return { ...base, state: at >= c.readyAt - 200 ? "sent" : "queued", ...(at >= c.readyAt - 200 ? { sentAt: c.readyAt - 200 } : {}) };
	if (!c.answer) {
		try {
			if (!j || !m.liveSet.has(job)) throw new Error("expired");
			c.answer = { result: answer(m, j, c.op, c.args, c.readyAt) };
		} catch (error) {
			c.answer = { error: error instanceof Error ? error.message : String(error) };
		}
	}
	if (c.answer.error === "expired") return { ...base, state: "expired" };
	return {
		...base,
		state: c.answer.error ? "failed" : "done",
		sentAt: c.readyAt - 200,
		doneAt: c.readyAt,
		ms: c.ms,
		...(c.answer.error ? { error: c.answer.error } : { result: c.answer.result }),
	};
}

// The answers ------------------------------------------------------------------------------------------------------------

/** One op's answer for a live server at `t` (throws a kernel-style reason on failure). */
export function answer(m: Model, j: PackJob, op: string, args: Record<string, unknown>, t: number): unknown {
	switch (op) {
		case "status":
			return status(m, j, t);
		case "builds":
			return builds(m, j);
		case "budget":
			return budget(m, j, t);
		case "logs":
			return logs(m, j, t, args);
		case "players":
			return players(m, j, t);
		case "player.logs":
			return playerLogs(m, j, t, args);
		case "errors":
			return errors(m, j, t);
		case "modules":
			return modules(m, j);
		case "state":
			return (args.queries as StateQuery[]).map((q) => state(m, j, t, q));
		case "assets":
			return assets(m, j);
		case "network":
			return network(m, j, t);
		case "dex.children":
			return (args.nodes as { id: number; offset?: number; limit?: number }[]).map((n) => dexChildren(m, j, t, n));
		case "dex.props":
			return dexProps(m, j, t, args.id as number);
		default: {
			const name = gameCommandName(op);
			if (name) return gameCommand(m, j, t, name);
			throw new Error(`op_not_allowed: ${op}`);
		}
	}
}

const startOf = (j: PackJob) => j.startedAt ?? j.firstAt;

function status(m: Model, j: PackJob, t: number): RemoteStatus {
	const reading = readingAt(j, t, j.job === m.degraded);
	const reports = m.reportsByJob.get(j.job) ?? [];
	const gen = j.job === m.degraded ? 3 : reports.reduce((g, r) => Math.max(g, r.generation ?? 0), 0) || 1;
	const lastReport = reports[reports.length - 1];
	const genStart = j.job === m.degraded ? t - 40 * 60_000 : (lastReport?.at ?? startOf(j));
	const cmds = [...commands.values()].filter((c) => c.job === j.job);
	return {
		status: {
			jobId: j.job,
			placeId: j.place ?? undefined,
			placeVersion: placeVersionOf(m, j),
			serverType: j.srv ?? "public",
			branch: j.branch ?? "prod",
			channel: j.channel ?? j.branch ?? "prod",
			rules: "signed",
			pinned: false,
			uptime: Math.round((t - startOf(j)) / 1000),
			generation: { name: `${j.art}#${gen}`, number: gen, uptime: Math.round((t - genStart) / 1000), artifact: { artifactId: j.art ?? undefined, branch: j.branch, seq: j.seq } },
			players: reading.players,
			maxPlayers: j.maxSlots ?? 35,
			kernelVersion: j.kernel ?? "0.5.5",
			kernelBuild: `k${hashString(j.kernel ?? "").toString(16).slice(0, 7)}`,
			memoryMb: reading.memMb,
			luaHeapKb: Math.round(reading.luaMb * 1024),
			appliedSeq: j.seq ?? undefined,
			signedOnly: true,
			health: { state: j.job === m.degraded ? "degraded" : "ok", errors: j.job === m.degraded ? 14 : 0, windowSeconds: 60 },
			remoteDebug: { state: "polling", polls: Math.max(1, Math.round((t - (watches.get(j.job)?.since ?? t)) / 8000)), commands: cmds.length, answered: cmds.filter((c) => c.answer).length, refused: 0, redacted: 0 },
		},
		fleet: { heartbeatEvery: 60, lastHeartbeat: Math.round(lastSeenOf(j, t, true) / 1000), tps: reading.tps, tpsMin: reading.tpsMin, physFps: reading.physFps, cv: columnValuesAt(j, t, reading.players) },
	};
}

function builds(m: Model, j: PackJob): RemoteBuilds {
	const head = (branch: string) => m.deploys.filter((d) => d.branch === branch).pop();
	const branches = ["prod", "dev"].flatMap((name) => {
		const d = head(name);
		return d ? [{ name, channel: name, artifactId: d.artifact, commit: d.artifact.slice(0, 7), seq: d.seq, deployedAt: Math.round(d.at / 1000), by: { kind: "roblox", name: DEMO_OWNER.name } }] : [];
	});
	const artifacts = m.deploys
		.slice(-10)
		.reverse()
		.map((d) => ({ branch: d.branch, artifactId: d.artifact, seq: d.seq, commit: d.artifact.slice(0, 7), at: Math.round(d.at / 1000), channel: d.channel, live: head(d.branch)?.seq === d.seq, running: d.artifact === j.art, verified: true }));
	const reports = (m.reportsByJob.get(j.job) ?? []).slice(-10).map((r) => ({ s: r.seq, b: r.branch ?? undefined, a: r.artifact ?? undefined, r: r.result, ...(r.error ? { e: r.error } : {}), d: r.seconds ?? undefined, t: Math.round(r.at / 1000), g: r.generation ?? undefined, k: r.kernel ?? undefined }));
	return { branches, artifacts, reports };
}

function budget(m: Model, j: PackJob, t: number): RemoteBudget {
	const reading = readingAt(j, t, j.job === m.degraded);
	const n = reading.players;
	const r = rng(`fleet:rbudget:${j.job}:${Math.floor(t / 60_000)}`);
	const ds = 60 + n * 10;
	const row = (name: string, limit: number, share: number) => {
		const used = Math.round(limit * share * r.float(0.5, 1.1));
		return { name, used, limit, left: Math.max(0, limit - used) };
	};
	return {
		players: n,
		window: 60,
		kinds: {
			DataStore: { rows: [row("GetAsync", ds, 0.12), row("SetAsync / UpdateAsync", ds, 0.25), row("GetSortedAsync", 5 + n * 2, 0.1), row("ListKeysAsync", 5 + n * 2, 0.02)], callers: { kernel: r.int(1, 3), game: r.int(n, n * 3 + 2), analytics: r.int(1, 4) } },
			MemoryStore: { rows: [row("Requests", 1000 + 100 * n, 0.04)], callers: { kernel: r.int(2, 6), game: r.int(n * 2, n * 5) } },
			HttpService: { rows: [row("Requests", 500, 0.015)], callers: { kernel: r.int(1, 3), analytics: r.int(2, 6) } },
			MessagingService: { rows: [row("Publish", 150 + 60 * n, 0.01), row("Subscriptions", 20 + 8 * n, 0.1)], callers: { kernel: 2 } },
		},
		detail: [
			{ caller: "game", kind: "DataStore", op: "UpdateAsync players__prod", perMinute: r.int(n, n * 2 + 2), total: r.int(200, 4000) },
			{ caller: "game", kind: "DataStore", op: "GetAsync players__prod", perMinute: r.int(0, n), total: r.int(100, 2000) },
			{ caller: "game", kind: "MemoryStore", op: "SortedMap.Get RestartSessions", perMinute: r.int(n, n * 3), total: r.int(300, 6000) },
			{ caller: "kernel", kind: "DataStore", op: "GetAsync TypeTorch settings", perMinute: 1, total: r.int(30, 900) },
			{ caller: "analytics", kind: "HttpService", op: "POST /v1/events", perMinute: r.int(2, 6), total: r.int(200, 9000) },
		],
		memory: {
			total: reading.memMb,
			luaHeap: reading.luaMb,
			heapKb: Math.round(reading.luaMb * 1024),
			tags: [
				{ name: "PhysicsParts", mb: Math.round(reading.memMb * 0.21) },
				{ name: "Script", mb: Math.round(reading.luaMb) },
				{ name: "Instances", mb: Math.round(reading.memMb * 0.14) },
				{ name: "Animation", mb: Math.round(30 + n * 3) },
				{ name: "Sounds", mb: Math.round(reading.memMb * 0.06) },
				{ name: "Navigation", mb: 18 },
			],
		},
		generations: [{ name: `${j.art}#${j.job === m.degraded ? 3 : 1}`, modules: MODULES.length, running: true }],
		refused: 0,
	};
}

/** The kernel's server log ring: a line every 4 s since the start, the last 1,000 kept. */
const LOG_EVERY_S = 4;
const LOG_RING = 1000;

function logs(m: Model, j: PackJob, t: number, args: Record<string, unknown>): RemoteLogs {
	const s0 = Math.floor(startOf(j) / 1000);
	const last = Math.max(1, Math.floor((t / 1000 - s0) / LOG_EVERY_S));
	const first = Math.max(1, last - LOG_RING + 1);
	const since = typeof args.since === "number" ? args.since : 0;
	const limit = typeof args.limit === "number" ? args.limit : 200;
	const from = Math.max(first, since + 1, last - limit + 1);
	const entries: RemoteLogEntry[] = [];
	for (let i = from; i <= last; i++) {
		const at = s0 + i * LOG_EVERY_S;
		entries.push({ i, t: at, ...serverLogLine(m, j, at, i) });
	}
	return { entries, last };
}

function occupantRow(o: Occupant, t: number) {
	const r = rng(`fleet:occ:${o.pid}`);
	const age = o.player?.age;
	const accountAge = age === "<7d" ? r.int(1, 6) : age === "7-30d" ? r.int(7, 30) : r.int(31, 2400);
	return {
		userId: o.userId,
		name: o.name,
		displayName: o.name.replace("_", " "),
		dev: false,
		role: o.team,
		accountAge,
		pingMs: rng(`fleet:ping:${o.pid}:${Math.floor(t / 30_000)}`).int(35, 190),
		client: { generation: "ok", ok: true, at: Math.round((o.joinedAt + 3_000) / 1000) },
	};
}

function players(m: Model, j: PackJob, t: number): RemotePlayers {
	return { players: occupantsAt(m, j, t).map((o) => occupantRow(o, t)), max: j.maxSlots ?? 35 };
}

function playerLogs(m: Model, j: PackJob, t: number, args: Record<string, unknown>): RemotePlayerLogs {
	const o = occupantsAt(m, j, t).find((x) => x.userId === args.userId);
	if (!o) throw new Error("not_in_server");
	const from = Math.floor(o.joinedAt / 1000);
	const total = Math.max(1, Math.floor((t / 1000 - from) / 5));
	const since = typeof args.since === "number" ? args.since : 0;
	const start = Math.max(since + 1, total - 199);
	return { userId: o.userId, name: o.name, entries: start > total ? [] : clientLogLines(o, from + (start - 1) * 5, total - start + 1, start) };
}

function errors(m: Model, j: PackJob, t: number): RemoteErrors {
	const kinds = m.p.errors.filter((e) => (j.art ? e.arts.includes(j.art) : true)).slice(0, 12);
	const upHours = Math.max(0.1, (t - startOf(j)) / 3_600_000);
	const top = kinds.map((e) => ({ fp: hashString(e.msg).toString(16).padStart(8, "0"), template: e.msg.split("\n")[0]?.replace(/\d{5,}/g, "<n>") ?? e.msg, total: Math.max(1, Math.round(e.total * Math.min(1, upHours / 24))), realm: (e.src === "server" ? "server" : "client") as "server" | "client" }));
	const seenServer = top.filter((x) => x.realm === "server").reduce((s, x) => s + x.total, 0);
	const seenClient = top.filter((x) => x.realm === "client").reduce((s, x) => s + x.total, 0);
	return { enabled: true, kinds: top.length, waiting: 0, seen: { server: seenServer, client: seenClient }, sent: top.length, requests: Math.ceil(upHours * 2), failed: 0, rejected: 0, dropped: {}, lastOkAt: Math.round((t - 47_000) / 1000), top };
}

/** The game's modules (framework services), as the dev menu's Modules tab lists them. */
const MODULES: { name: string; deps: string[]; initMs: number; hooks?: string[] }[] = [
	{ name: "DataService", deps: [], initMs: 38 },
	{ name: "TeamService", deps: ["DataService"], initMs: 4 },
	{ name: "EconomyService", deps: ["DataService"], initMs: 6 },
	{ name: "InventoryService", deps: ["DataService"], initMs: 11 },
	{ name: "ShopService", deps: ["EconomyService", "InventoryService"], initMs: 9 },
	{ name: "QuestService", deps: ["DataService", "EconomyService"], initMs: 14, hooks: ["onQuestComplete"] },
	{ name: "JobService", deps: ["EconomyService", "QuestService"], initMs: 7 },
	{ name: "CombatService", deps: ["TeamService"], initMs: 5, hooks: ["onKnockout"] },
	{ name: "ArrestService", deps: ["TeamService", "CombatService", "EconomyService"], initMs: 3 },
	{ name: "EscapeService", deps: ["TeamService", "QuestService"], initMs: 8, hooks: ["onEscape"] },
	{ name: "LockdownService", deps: ["TeamService"], initMs: 12 },
	{ name: "MedicService", deps: ["TeamService", "EconomyService"], initMs: 2 },
	{ name: "SpinWheelService", deps: ["EconomyService", "InventoryService"], initMs: 3 },
	{ name: "TutorialService", deps: ["QuestService"], initMs: 5 },
	{ name: "RoundService", deps: ["LockdownService"], initMs: 2 },
];

function modules(m: Model, j: PackJob): RemoteModules {
	const list = MODULES.map((x, i) => ({ name: x.name, dependencies: x.deps, loadOrder: i + 1, initMs: x.initMs }));
	return {
		modules: list,
		state: {
			modules: MODULES.map((x, i) => ({ name: x.name, dependencies: x.deps, loadOrder: i + 1, initMs: x.initMs, ...(x.hooks ? { hooks: x.hooks } : {}) })),
			persist: [
				{ key: "players__prod", kind: "DataStore", entries: occupantsAt(m, j, now()).length, preview: "{ cash, xp, level, inventory, quests }" },
				{ key: "RestartSessions", kind: "MemoryStore SortedMap", entries: 0, preview: "{}" },
				{ key: "ShopStock", kind: "MemoryStore HashMap", entries: 9, preview: "{ molotov = 4, faintspray = 6, ... }" },
			],
		},
	};
}

// op state: each module's live state as plain tables -------------------------------------------------------------------------

function stateRoots(m: Model, j: PackJob, t: number): Record<string, unknown> {
	const people = occupantsAt(m, j, t);
	const cv = columnValuesAt(j, t, people.length);
	const v = m.p.vocabulary.props;
	const quests = (v.quest ?? []).slice(0, 12).map((q) => q.value);
	const items = (v.item ?? []).slice(0, 14).map((q) => q.value.toLowerCase());
	const byName = (f: (o: Occupant, r: ReturnType<typeof rng>) => unknown) => Object.fromEntries(people.map((o) => [o.name, f(o, rng(`fleet:state:${o.pid}`))]));
	return {
		DataService: { loaded: byName((o, r) => ({ version: r.int(40, 900), dirty: r.chance(0.2), lastSave: Math.round((t - r.int(5, 240) * 1000) / 1000) })), saveEvery: 120, retries: { UpdateAsync: 0 } },
		TeamService: { counts: { Inmates: cv.inmates, Guards: cv.guards, Medics: cv.medics }, members: byName((o) => o.team), maxGuards: 10 },
		EconomyService: { wallets: byName((o, r) => ({ cash: r.int(0, 300) * 10, earnedToday: r.int(0, 200) * 10 })), salary: { guard: 120, medic: 100, every: 600 } },
		InventoryService: { bags: byName((o, r) => r.shuffle(items).slice(0, r.int(0, 4))), capacity: 6 },
		ShopService: { stock: Object.fromEntries(items.slice(0, 9).map((item, i) => [item, (hashString(`${j.job}:${item}:${Math.floor(t / 600_000)}`) % 8) + (i === 0 ? 0 : 1)])), prices: Object.fromEntries(items.slice(0, 9).map((item) => [item, ((hashString(item) % 50) + 5) * 10])), restockEvery: 600 },
		QuestService: { daily: { resetAt: Math.floor(t / 86_400_000 + 1) * 86_400, quests: quests.slice(0, 4) }, active: byName((o, r) => ({ quest: r.pick(quests), progress: r.int(0, 2), goal: 3 })) },
		JobService: { open: { janitor: 3, chef: 2, laundry: 2 }, working: byName((o, r) => (o.team === "inmate" && r.chance(0.4) ? r.pick(["janitor", "chef", "trash_bin"]) : null)) },
		CombatService: { knockedOut: {}, weapons: (v.weapon ?? []).slice(0, 8).map((w) => w.value), taserCooldown: 3 },
		ArrestService: { bounty: 75, arrestsToday: cv.arrests, wanted: byName((o, r) => (o.team === "inmate" && r.chance(0.15) ? { level: r.int(1, 3) } : null)) },
		EscapeService: { routes: { sewer: { open: true, escapes: Math.ceil(Number(cv.escapes) * 0.5) }, yard_fence: { open: true, escapes: Math.floor(Number(cv.escapes) * 0.3) }, laundry_chute: { open: !cv.lockdown, escapes: Math.floor(Number(cv.escapes) * 0.2) }, roof: { open: false, escapes: 0 } }, escapedToday: cv.escapes },
		LockdownService: { active: cv.lockdown, block: cv.lockdown ? "A" : null, doors: { A: cv.lockdown ? "closed" : "open", B: "open", C: "open" }, lastRiot: Math.round((t - 1_800_000) / 1000) },
		MedicService: { healing: {}, rewardCash: 40, bandageStack: 3 },
		SpinWheelService: { freeSpinUsed: byName((o, r) => r.chance(0.6)), odds: { cash150: 0.4, xp_boost: 0.25, faintspray: 0.15, bandage: 0.15, nothing: 0.05 } },
		TutorialService: { version: "v4", inTutorial: byName((o, r) => (o.player?.newInWindow && r.chance(0.3) ? { step: r.int(1, 7) } : null)) },
		RoundService: { phase: cv.phase, dayLengthMinutes: 24, startedAt: Math.round(startOf(j) / 1000) },
	};
}

const typeOf = (v: unknown) => (v === null || v === undefined ? "nil" : Array.isArray(v) || typeof v === "object" ? "table" : typeof v === "string" ? "string" : typeof v === "boolean" ? "boolean" : "number");

function preview(v: unknown): string {
	if (v === null || v === undefined) return "nil";
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v !== "object") return String(v);
	const keys = Array.isArray(v) ? v.map((_, i) => String(i + 1)) : Object.keys(v);
	const text = keys
		.slice(0, 4)
		.map((k) => {
			const x = Array.isArray(v) ? v[Number(k) - 1] : (v as Record<string, unknown>)[k];
			const inner = typeof x === "object" && x !== null ? "{...}" : preview(x);
			return Array.isArray(v) ? inner : `${k} = ${inner}`;
		})
		.join(", ");
	return `{ ${text}${keys.length > 4 ? ", ..." : ""} }`;
}

const STATE_PAGE = 100;

function state(m: Model, j: PackJob, t: number, q: StateQuery): StateReply {
	const roots = stateRoots(m, j, t);
	let value: unknown;
	if (!q.root) value = roots;
	else {
		value = roots[q.root];
		for (const seg of q.path ?? []) {
			if (typeof value !== "object" || value === null) {
				value = undefined;
				break;
			}
			value = Array.isArray(value) ? value[Number(seg) - 1] : (value as Record<string, unknown>)[seg];
		}
	}
	const empty = { page: 0, pages: 0, hasMore: false, matched: 0, entries: [] as StateEntry[], size: 0 };
	if (value === undefined) return { type: "nil", preview: "nil", missing: true, ...empty };
	if (typeof value !== "object" || value === null) return { type: typeOf(value), preview: preview(value), ...empty };
	const pairs: [string, unknown][] = Array.isArray(value) ? value.map((x, i) => [String(i + 1), x]) : Object.entries(value as Record<string, unknown>);
	const filter = (q.filter ?? "").toLowerCase();
	const matched = filter ? pairs.filter(([k]) => k.toLowerCase().includes(filter)) : pairs;
	const pages = Math.max(1, Math.ceil(matched.length / STATE_PAGE));
	const page = Math.min(q.page ?? 0, pages - 1);
	const entries = matched.slice(page * STATE_PAGE, (page + 1) * STATE_PAGE).map(([key, x]): StateEntry => ({ key, seg: key, type: typeOf(x), preview: preview(x), expandable: typeof x === "object" && x !== null && (Array.isArray(x) ? x.length > 0 : Object.keys(x).length > 0) }));
	return { type: "table", preview: preview(value), size: pairs.length, matched: matched.length, entries, page, pages, hasMore: page < pages - 1 };
}

function assets(m: Model, j: PackJob): RemoteAssets {
	const keys = ["Sounds/AlarmBell", "Sounds/CellDoor", "Sounds/Taser", "Models/Molotov", "Models/Lockpick", "Models/Sledgehammer", "UI/ShopIcons", "UI/SpinWheel", "Animations/Arrest", "Animations/Mop"];
	return {
		manifest: "ok",
		from: "signed settings",
		running: false,
		ms: 412,
		timedOut: false,
		entries: keys.map((key, i) => {
			const id = 100_000_000 + (hashString(`asset:${key}`) % 899_999_999);
			const version = (hashString(`v:${key}`) % 9) + 1;
			return { key, id, wanted: version, n: 1, version, live: i !== 3 || j.branch === "prod", source: "hot" };
		}),
		unmanaged: ["Workspace.Prison.Decor"],
	};
}

const REMOTES = ["ShopBuy", "QuestProgress", "QuestClaim", "Arrest", "TaserHit", "LockpickTry", "SpinWheel", "TeamSelect", "JobDone", "HealPlayer", "UseItem", "EscapeReached", "TutorialStep", "Chat.Report"];

function network(m: Model, j: PackJob, t: number): RemoteNetwork {
	const upMin = Math.max(1, (t - startOf(j)) / 60_000);
	const players = readingAt(j, t).players;
	return {
		supported: true,
		remotes: REMOTES.map((name) => {
			const r = rng(`fleet:net:${j.job}:${name}`);
			const rate = r.float(0.05, 1.6) * Math.max(1, players);
			const inbound = Math.round(rate * upMin);
			return { path: `ReplicatedStorage.Remotes.${name}`, inbound, outbound: Math.round(inbound * r.float(0.2, 1.4)), rejected: r.chance(0.3) ? Math.round(inbound * 0.004) : 0, errors: name === "ShopBuy" ? Math.round(inbound * 0.001) : 0 };
		}),
	};
}

// op dex.children / dex.props: a read-only DataModel ---------------------------------------------------------------------------

interface DexNode {
	id: number;
	name: string;
	className: string;
	parent: number;
	children: number[];
	attrs?: Record<string, string | number | boolean>;
	tags?: string[];
}

let dexTree: Map<number, DexNode> | undefined;

function staticDex(): Map<number, DexNode> {
	if (dexTree) return dexTree;
	const nodes = new Map<number, DexNode>();
	let next = 1;
	const add = (parent: number, name: string, className: string, extra: Partial<DexNode> = {}): number => {
		const id = next++;
		nodes.set(id, { id, name, className, parent, children: [], ...extra });
		nodes.get(parent)?.children.push(id);
		return id;
	};
	nodes.set(0, { id: 0, name: "game", className: "DataModel", parent: -1, children: [] });
	const workspace = add(0, "Workspace", "Workspace");
	add(0, "Players", "Players");
	const lighting = add(0, "Lighting", "Lighting");
	const rs = add(0, "ReplicatedStorage", "ReplicatedStorage");
	const sss = add(0, "ServerScriptService", "ServerScriptService");
	const ss = add(0, "ServerStorage", "ServerStorage");
	const sg = add(0, "StarterGui", "StarterGui");
	const sp = add(0, "StarterPlayer", "StarterPlayer");
	const teams = add(0, "Teams", "Teams");
	add(0, "SoundService", "SoundService");
	add(workspace, "Camera", "Camera");
	add(workspace, "Terrain", "Terrain");
	const prison = add(workspace, "Prison", "Model", { tags: ["Map"] });
	for (const block of ["A", "B", "C"]) {
		const b = add(prison, `CellBlock${block}`, "Model", { attrs: { Block: block, Lockdown: false } });
		for (let c = 1; c <= 12; c++) {
			const cell = add(b, `Cell_${block}${String(c).padStart(2, "0")}`, "Model", { attrs: { Capacity: 2 } });
			add(cell, "Bed", "Part");
			add(cell, "Toilet", "MeshPart");
			add(cell, "Door", "Part", { attrs: { Locked: true, Block: block }, tags: ["CellDoor"] });
		}
		add(b, "AlarmBell", "Part", { tags: ["AlarmBell"] });
	}
	const yard = add(prison, "Yard", "Model");
	add(yard, "Fence", "UnionOperation", { tags: ["Climbable"] });
	add(yard, "Gate", "Part", { attrs: { Locked: true } });
	add(yard, "BasketballCourt", "Model");
	const caf = add(prison, "Cafeteria", "Model");
	add(caf, "StewPot", "MeshPart", { attrs: { Heal: 25 } });
	for (let i = 1; i <= 6; i++) add(caf, `Table${i}`, "Model");
	const inf = add(prison, "Infirmary", "Model");
	add(inf, "MedicStation", "Part", { tags: ["Heal"] });
	const guardRoom = add(prison, "GuardRoom", "Model");
	add(guardRoom, "TaserRack", "Model");
	add(guardRoom, "Lockers", "Model");
	const warden = add(prison, "WardenOffice", "Model");
	add(warden, "KeycardReader", "Part", { attrs: { Level: 3 } });
	const sewers = add(prison, "Sewers", "Model");
	add(sewers, "Grate", "Part", { attrs: { Breakable: true } });
	add(sewers, "ExitTrigger", "Part", { tags: ["EscapeExit"], attrs: { Route: "sewer" } });
	const laundry = add(prison, "Laundry", "Model");
	add(laundry, "Chute", "Part", { tags: ["EscapeExit"], attrs: { Route: "laundry_chute" } });
	for (let i = 1; i <= 8; i++) add(prison, `TrashBin${i}`, "MeshPart", { tags: ["TrashBin"] });
	const spawns = add(workspace, "Spawns", "Folder");
	for (const team of ["Inmates", "Guards", "Medics"]) add(spawns, `${team}Spawn`, "SpawnLocation");
	add(lighting, "Atmosphere", "Atmosphere");
	add(lighting, "Sky", "Sky");
	const remotes = add(rs, "Remotes", "Folder");
	for (const r of REMOTES) add(remotes, r, r.includes(".") ? "RemoteFunction" : "RemoteEvent");
	add(rs, "Items", "Folder");
	add(rs, "TypeTorch", "Folder");
	const game = add(sss, "Prison", "Folder");
	for (const x of MODULES) add(game, x.name, "ModuleScript");
	add(sss, "Main", "Script");
	const tt = add(ss, "TypeTorch", "Folder");
	add(tt, "Generations", "Folder");
	add(ss, "Weapons", "Folder");
	for (const ui of ["ShopGui", "QuestsGui", "SpinWheelGui", "TeamSelectGui", "TutorialGui", "HudGui"]) add(sg, ui, "ScreenGui");
	add(sp, "StarterPlayerScripts", "StarterPlayerScripts");
	add(sp, "StarterCharacterScripts", "StarterCharacterScripts");
	for (const [team, color] of [
		["Inmates", "Neon orange"],
		["Guards", "Bright blue"],
		["Medics", "Lime green"],
	] as const)
		add(teams, team, "Team", { attrs: { Color: color } });
	dexTree = nodes;
	return nodes;
}

/** Players (and their characters in Workspace) get ids from 100000 on: slot + 1. */
const PLAYER_ID = 100_000;
const CHARACTER_ID = 200_000;

function dexRow(n: DexNode): DexRow {
	return { id: n.id, name: n.name, className: n.className, childCount: n.children.length, parent: n.parent };
}

function dexChildren(m: Model, j: PackJob, t: number, q: { id: number; offset?: number; limit?: number }): DexChildrenPage {
	const tree = staticDex();
	const people = occupantsAt(m, j, t);
	let rows: DexRow[];
	if (q.id === 2) rows = people.map((o, i) => ({ id: PLAYER_ID + i + 1, name: o.name, className: "Player", childCount: 3, parent: 2 }));
	else if (q.id >= CHARACTER_ID) rows = ["HumanoidRootPart", "Humanoid", "Head", "Torso"].map((name, i) => ({ id: q.id * 10 + i, name, className: name === "Humanoid" ? "Humanoid" : "Part", childCount: 0, parent: q.id }));
	else if (q.id > PLAYER_ID && q.id < CHARACTER_ID) rows = ["Backpack", "PlayerGui", "PlayerScripts"].map((name, i) => ({ id: q.id * 10 + i, name, className: name, childCount: 0, parent: q.id }));
	else {
		const node = tree.get(q.id);
		if (!node) return { id: q.id, rows: [], total: 0, offset: q.offset ?? 0, gone: true };
		rows = node.children.map((c) => dexRow(tree.get(c) as DexNode));
		if (q.id === 1) rows = [...rows, ...people.map((o, i) => ({ id: CHARACTER_ID + i + 1, name: o.name, className: "Model", childCount: 4, parent: 1 }))];
		if (q.id === 0) rows = rows.map((r) => (r.id === 2 ? { ...r, childCount: people.length } : r));
	}
	const offset = q.offset ?? 0;
	const limit = q.limit ?? 200;
	return { id: q.id, rows: rows.slice(offset, offset + limit), total: rows.length, offset };
}

const prop = (name: string, category: string, kind: string, text: string, extra: Partial<DexPropRow> = {}): DexPropRow => ({ name, category, kind, text, ...extra });

function dexProps(m: Model, j: PackJob, t: number, id: number): DexProps {
	const tree = staticDex();
	const people = occupantsAt(m, j, t);
	if (id > PLAYER_ID && id < CHARACTER_ID) {
		const o = people[id - PLAYER_ID - 1];
		if (!o) throw new Error("not_found: that instance is gone");
		return {
			id,
			name: o.name,
			className: "Player",
			path: `game.Players.${o.name}`,
			props: [prop("Name", "Data", "string", o.name), prop("DisplayName", "Data", "string", o.name.replace("_", " ")), prop("UserId", "Data", "int64", String(o.userId), { readOnly: true }), prop("Team", "Team", "Instance", o.team === "guard" || o.team === "warden" ? "Guards" : o.team === "medic" ? "Medics" : "Inmates"), prop("AccountAge", "Data", "int", String(occupantRow(o, t).accountAge), { readOnly: true }), prop("Character", "Data", "Instance", o.name, { ref: CHARACTER_ID + id - PLAYER_ID })],
			attrs: [prop("Cash", "Attributes", "number", String(rng(`fleet:state:${o.pid}`).int(0, 300) * 10)), prop("Level", "Attributes", "number", String(o.player?.level ?? 1)), prop("Role", "Attributes", "string", o.team)],
			tags: o.team === "warden" ? ["Warden"] : [],
		};
	}
	if (id >= CHARACTER_ID && id < CHARACTER_ID * 5) {
		const o = people[id - CHARACTER_ID - 1];
		if (!o) throw new Error("not_found: that instance is gone");
		const at = rng(`fleet:char:${o.pid}`);
		return { id, name: o.name, className: "Model", path: `game.Workspace.${o.name}`, props: [prop("Name", "Data", "string", o.name), prop("ClassName", "Data", "string", "Model", { readOnly: true }), prop("Parent", "Data", "Instance", "Workspace", { ref: 1 }), prop("PrimaryPart", "Data", "Instance", "HumanoidRootPart"), prop("Health", "Humanoid", "float", String(at.int(40, 100)))], attrs: [prop("Team", "Attributes", "string", o.team)], tags: ["Character"] };
	}
	const node = tree.get(id);
	if (!node && id >= PLAYER_ID) {
		const parent = Math.floor(id / 10);
		const names = parent >= CHARACTER_ID ? ["HumanoidRootPart", "Humanoid", "Head", "Torso"] : ["Backpack", "PlayerGui", "PlayerScripts"];
		const name = names[id % 10] ?? "Instance";
		return { id, name, className: name === "HumanoidRootPart" || name === "Head" || name === "Torso" ? "Part" : name, path: name, props: [prop("Name", "Data", "string", name), prop("Parent", "Data", "Instance", "…", { ref: parent })], attrs: [], tags: [] };
	}
	if (!node) throw new Error("not_found: that instance is gone");
	const path: string[] = [];
	for (let n: DexNode | undefined = node; n && n.id !== 0; n = tree.get(n.parent)) path.unshift(n.name);
	const r = rng(`fleet:dex:${id}`);
	const props: DexPropRow[] = [prop("Name", "Data", "string", node.name), prop("ClassName", "Data", "string", node.className, { readOnly: true }), prop("Parent", "Data", "Instance", tree.get(node.parent)?.name ?? "nil", node.parent >= 0 ? { ref: node.parent } : {}), prop("Archivable", "Behavior", "bool", "true")];
	if (/Part|Union|Spawn/.test(node.className)) {
		props.push(
			prop("Anchored", "Behavior", "bool", "true"),
			prop("CanCollide", "Collision", "bool", node.name === "ExitTrigger" ? "false" : "true"),
			prop("Position", "Transform", "Vector3", `${r.float(-300, 300).toFixed(2)}, ${r.float(5, 60).toFixed(2)}, ${r.float(0, 900).toFixed(2)}`),
			prop("Size", "Transform", "Vector3", `${r.int(2, 20)}, ${r.int(1, 12)}, ${r.int(2, 20)}`),
			prop("Material", "Appearance", "EnumItem", r.pick(["Concrete", "Metal", "DiamondPlate", "Brick", "SmoothPlastic"]), { enumType: "Material" }),
			prop("Transparency", "Appearance", "float", node.name === "ExitTrigger" ? "1" : "0"),
		);
	}
	if (node.className === "Model") props.push(prop("PrimaryPart", "Data", "Instance", "nil"), prop("WorldPivot", "Transform", "CFrame", `${r.float(-300, 300).toFixed(1)}, ${r.float(5, 60).toFixed(1)}, ${r.float(0, 900).toFixed(1)}, 1, 0, 0, 0, 1, 0, 0, 0, 1`));
	if (node.className.endsWith("Script")) props.push(prop("Enabled", "Behavior", "bool", "true"), prop("RunContext", "Behavior", "EnumItem", "Legacy", { enumType: "RunContext" }), prop("Source", "Data", "ProtectedString", "<not readable>", { readOnly: true }));
	if (node.className === "Workspace") props.push(prop("Gravity", "Physics", "float", "196.2"), prop("StreamingEnabled", "Behavior", "bool", "true"));
	if (node.className === "Players") props.push(prop("MaxPlayers", "Data", "int", String(j.maxSlots ?? 35), { readOnly: true }), prop("CharacterAutoLoads", "Behavior", "bool", "true"));
	if (node.className === "Lighting") props.push(prop("ClockTime", "Appearance", "float", String(((t / 60_000) % 24).toFixed(2))), prop("Brightness", "Appearance", "float", "2"));
	const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => prop(k, "Attributes", typeof v === "boolean" ? "bool" : typeof v === "number" ? "number" : "string", String(v)));
	if (node.name.startsWith("CellBlock")) {
		const lockdown = columnValuesAt(j, t, people.length).lockdown === true;
		const i = attrs.findIndex((a) => a.name === "Lockdown");
		if (i >= 0) attrs[i] = prop("Lockdown", "Attributes", "bool", String(lockdown && node.name === "CellBlockA"));
	}
	return { id, name: node.name, className: node.className, path: path.length ? `game.${path.join(".")}` : "game", props, attrs, tags: node.tags ?? [] };
}

// Game-defined commands (plans/34) ----------------------------------------------------------------------------------------

function gameCommand(m: Model, j: PackJob, t: number, name: string): unknown {
	const people = occupantsAt(m, j, t);
	const cv = columnValuesAt(j, t, people.length);
	const upHours = Math.max(0.05, (t - startOf(j)) / 3_600_000);
	const r = rng(`fleet:game:${j.job}:${name}:${Math.floor(t / 60_000)}`);
	switch (name) {
		case "round_state":
			return { kind: "kv", items: { phase: cv.phase, lockdown: cv.lockdown, inmates: cv.inmates, guards: cv.guards, medics: cv.medics, escapes: cv.escapes, arrests: cv.arrests, warden: people.some((o) => o.team === "warden") } };
		case "economy": {
			const sources = (m.p.vocabulary.props.reason ?? []).slice(0, 8).map((x) => x.value);
			return { kind: "table", columns: ["source", "cash in", "cash out", "players"], rows: sources.map((s) => [s, Math.round(r.int(40, 400) * upHours * Math.max(1, people.length) / 4) * 10, s.includes("shop") ? r.int(100, 900) * 10 : 0, r.int(1, Math.max(1, people.length))]) };
		}
		case "escapes":
			return {
				kind: "table",
				columns: ["route", "escapes", "attempts", "open"],
				rows: [
					["sewer", Math.ceil(Number(cv.escapes) * 0.5), Math.ceil(Number(cv.escapes) * 1.4) + 1, true],
					["yard_fence", Math.floor(Number(cv.escapes) * 0.3), Math.ceil(Number(cv.escapes) * 1.1), true],
					["laundry_chute", Math.floor(Number(cv.escapes) * 0.2), Math.ceil(Number(cv.escapes) * 0.6), !cv.lockdown],
					["roof", 0, r.int(0, 3), false],
				],
			};
		case "shop_stock": {
			const items = (m.p.vocabulary.props.item ?? []).slice(0, 10).map((x) => x.value.toLowerCase()).filter((x, i, a) => a.indexOf(x) === i);
			const restock = 600 - Math.floor((t / 1000) % 600);
			return { kind: "table", columns: ["item", "left", "price", "restock in"], rows: items.map((item) => [item, hashString(`${j.job}:${item}:${Math.floor(t / 600_000)}`) % 8, ((hashString(item) % 50) + 5) * 10, `${Math.floor(restock / 60)}:${String(restock % 60).padStart(2, "0")}`]) };
		}
		default:
			throw new Error(`not_supported: ${name}`);
	}
}
