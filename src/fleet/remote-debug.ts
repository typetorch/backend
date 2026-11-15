/**
 * Remote debug of one game server (plans/25). A Roblox server can't be called into, so it pulls:
 *
 *   explorer  POST /v1/fleet/servers/<job>/watch            the page is open (repeated every 20 s; lapses after 60 s)
 *   game      POST /v1/fleet/heartbeat -> { ok, rd: 1 }     a watched job's heartbeat reply wakes the kernel's poll
 *   game      GET  /v1/fleet/commands?wait=8               long-poll: the commands queued for this JobId
 *   explorer  POST /v1/fleet/servers/<job>/commands         { op, args } -> { id }
 *   game      POST /v1/fleet/results                        { j, results: [{ id, ok, json?, error?, ms?, redacted? }] }
 *   explorer  GET  /v1/fleet/servers/<job>/commands/<id>   the answer (only for whoever queued it)
 *
 * v1 is READ-ONLY: the op table below is the allow-list (the kernel and the framework keep their own). Plans/34 adds
 * game-defined ops (`game.<name>`), accepted only for a job that declared them (read-only is the game's promise). Results can hold
 * player names, logs and state: they live in MEMORY only (never on disk, the bus, /v1/live or a log line) and are
 * dropped a few minutes after they arrive. Every queued command is audit-logged (who, op, job, an args summary; never a
 * result, never a player's UserId).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** How long a watch lasts after the page last said so (the page repeats every 20 s). */
export const WATCH_MS = 60_000;
/** A server counts as connected when it polled within this long. */
export const CONNECTED_MS = 15_000;
/** At most this many jobs are watched at once (the oldest watch goes). */
export const WATCH_MAX = 32;
/** A command nobody picked up expires this long after it was queued. */
export const QUEUED_TTL_MS = 30_000;
/** A command the server picked up expires this long after that without an answer. */
export const SENT_TTL_MS = 20_000;
/** Answers (and expired commands) are kept this long, in memory only, then dropped. */
export const RESULT_TTL_MS = 180_000;
/** Commands waiting (queued or sent) per job. */
export const PENDING_MAX = 8;
/** Commands (with answers) held at all; past it the oldest finished ones go first. */
export const COMMANDS_MAX = 2000;
/** Bytes of answers held at all (JSON text); past it the oldest answers are dropped. */
export const RESULT_BYTES_MAX = 32 * 1024 * 1024;
/** One answer at most (JSON text). The kernel refuses more than 200 KB itself. */
export const RESULT_MAX = 256 * 1024;
/** The longest a poll is held. */
export const POLL_WAIT_MAX_S = 8;
/** The args of one command at most (JSON). */
export const ARGS_MAX = 16 * 1024;
export const AUDIT_KEPT = 500;
/** The audit file is rotated (one .1 kept) past this size. */
export const AUDIT_FILE_MAX = 5 * 1024 * 1024;

export class RemoteDebugInputError extends Error {}

/** Who asked, as the game sees it: an explorer user signed in with Roblox, or the admin token (or a token session). */
export type Caller = { kind: "roblox"; userId: number } | { kind: "token" };

/** One key per caller: commands and answers are only readable by the same key. */
export function callerKey(caller: Caller): string {
	return caller.kind === "roblox" ? `roblox:${caller.userId}` : "token";
}

type Args = Record<string, unknown>;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !v.includes("\0");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function only(args: Args, keys: string[]): void {
	for (const key of Object.keys(args)) if (!keys.includes(key)) throw new RemoteDebugInputError(`unknown argument ${JSON.stringify(key.slice(0, 40))}`);
}

function noArgs(args: Args): Args {
	only(args, []);
	return {};
}

/**
 * The read-only ops (the allow-list) and their argument checks. Each returns the args as sent to the game (unknown keys
 * refused) or throws RemoteDebugInputError. `summary` is the audit's view of the args: sizes and plain numbers, never a
 * player's UserId.
 */
export const OPS: Record<string, { check(args: Args): Args; summary(args: Args): string }> = {
	status: { check: noArgs, summary: () => "" },
	builds: { check: noArgs, summary: () => "" },
	budget: { check: noArgs, summary: () => "" },
	errors: { check: noArgs, summary: () => "" },
	players: { check: noArgs, summary: () => "" },
	modules: { check: noArgs, summary: () => "" },
	assets: { check: noArgs, summary: () => "" },
	network: { check: noArgs, summary: () => "" },
	logs: {
		check(args) {
			only(args, ["since", "limit"]);
			if (args.since !== undefined && !isInt(args.since, 0, 2 ** 52)) throw new RemoteDebugInputError("since must be a whole number >= 0");
			if (args.limit !== undefined && !isInt(args.limit, 1, 500)) throw new RemoteDebugInputError("limit must be 1-500");
			return { ...(args.since !== undefined ? { since: args.since } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) };
		},
		summary: (a) => [a.since !== undefined ? `since=${a.since}` : "", a.limit !== undefined ? `limit=${a.limit}` : ""].filter(Boolean).join(" "),
	},
	"player.logs": {
		check(args) {
			only(args, ["userId", "since"]);
			if (!isInt(args.userId, 1, 2 ** 52)) throw new RemoteDebugInputError("userId must be a UserId");
			if (args.since !== undefined && !isInt(args.since, 0, 2 ** 52)) throw new RemoteDebugInputError("since must be a whole number >= 0");
			return { userId: args.userId, ...(args.since !== undefined ? { since: args.since } : {}) };
		},
		// Who was looked at stays out of the audit (it would keep a player's UserId on disk).
		summary: () => "one player",
	},
	state: {
		check(args) {
			only(args, ["queries"]);
			const queries = args.queries;
			if (!Array.isArray(queries) || queries.length < 1 || queries.length > 12) throw new RemoteDebugInputError("queries: 1-12 state queries");
			return {
				queries: queries.map((q) => {
					if (!isRecord(q)) throw new RemoteDebugInputError("each query is an object");
					only(q, ["root", "path", "page", "filter", "keep"]);
					if (!isText(q.root, 120)) throw new RemoteDebugInputError("root: a module name (or \"\" for the list)");
					const path = q.path ?? [];
					if (!Array.isArray(path) || path.length > 24 || !path.every((s) => isText(s, 600))) throw new RemoteDebugInputError("path: at most 24 segments");
					const page = q.page ?? 0;
					if (!isInt(page, 0, 100_000)) throw new RemoteDebugInputError("page: a whole number");
					if (q.filter !== undefined && !isText(q.filter, 64)) throw new RemoteDebugInputError("filter: at most 64 characters");
					if (q.keep !== undefined && (!Array.isArray(q.keep) || q.keep.length > 50 || !q.keep.every((s) => isText(s, 600)))) throw new RemoteDebugInputError("keep: at most 50 segments");
					return { side: "server", root: q.root, path, page, ...(q.filter !== undefined ? { filter: q.filter } : {}), ...(q.keep !== undefined ? { keep: q.keep } : {}) };
				}),
			};
		},
		summary: (a) => `${(a.queries as unknown[]).length} quer${(a.queries as unknown[]).length === 1 ? "y" : "ies"}`,
	},
	"dex.children": {
		check(args) {
			only(args, ["nodes"]);
			const nodes = args.nodes;
			if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 8) throw new RemoteDebugInputError("nodes: 1-8 { id, offset?, limit? }");
			return {
				nodes: nodes.map((n) => {
					if (!isRecord(n)) throw new RemoteDebugInputError("each node is an object");
					only(n, ["id", "offset", "limit"]);
					if (!isInt(n.id, 0, 2 ** 52)) throw new RemoteDebugInputError("node id: a whole number");
					if (n.offset !== undefined && !isInt(n.offset, 0, 1_000_000)) throw new RemoteDebugInputError("offset: a whole number");
					if (n.limit !== undefined && !isInt(n.limit, 1, 200)) throw new RemoteDebugInputError("limit: 1-200");
					return { id: n.id, ...(n.offset !== undefined ? { offset: n.offset } : {}), ...(n.limit !== undefined ? { limit: n.limit } : {}) };
				}),
			};
		},
		summary: (a) => `${(a.nodes as unknown[]).length} node(s)`,
	},
	"dex.props": {
		check(args) {
			only(args, ["id"]);
			if (!isInt(args.id, 0, 2 ** 52)) throw new RemoteDebugInputError("id: a whole number");
			return { id: args.id };
		},
		summary: (a) => `id=${a.id}`,
	},
};

/** Plans/34: a game-defined command's args at most (JSON). */
export const GAME_ARGS_MAX = 2 * 1024;
/** Plans/34: game-defined ops are `game.<name>`, the name as the game declared it. */
const GAME_OP = /^game\.([a-z][a-z0-9_]{0,31})$/;

/** The op is a game-defined one (`game.<name>`): its name, else undefined. */
export function gameCommandName(op: unknown): string | undefined {
	return typeof op === "string" ? GAME_OP.exec(op)?.[1] : undefined;
}

/**
 * Checks an op and its args; returns the args to send. Throws RemoteDebugInputError. A game-defined op (`game.<name>`)
 * passes only when `declared(name)` says the server declared it (plans/34); its args are any JSON object of at most
 * GAME_ARGS_MAX bytes (the game checks them).
 */
export function checkCommand(op: unknown, args: unknown, declared: (name: string) => boolean = () => false): { op: string; args: Args } {
	const game = gameCommandName(op);
	if (game !== undefined) {
		if (!declared(game)) throw new RemoteDebugInputError(`${op} is not declared by this server (its game registers the commands it answers; see the Game tab)`);
		if (args !== undefined && args !== null && !isRecord(args)) throw new RemoteDebugInputError("args must be an object");
		const raw = (args ?? {}) as Args;
		if (JSON.stringify(raw).length > GAME_ARGS_MAX) throw new RemoteDebugInputError(`args over ${GAME_ARGS_MAX} bytes`);
		return { op: op as string, args: raw };
	}
	if (typeof op !== "string" || !Object.hasOwn(OPS, op)) throw new RemoteDebugInputError(`unknown op ${JSON.stringify(String(op).slice(0, 40))}: v1 is read-only (${Object.keys(OPS).join(", ")}, or a game.<name> the server declared)`);
	if (args !== undefined && args !== null && !isRecord(args)) throw new RemoteDebugInputError("args must be an object");
	const raw = (args ?? {}) as Args;
	if (JSON.stringify(raw).length > ARGS_MAX) throw new RemoteDebugInputError(`args over ${ARGS_MAX} bytes`);
	return { op, args: OPS[op].check(raw) };
}

/** The audit's view of a command's args: the allow-list's summary, or for a game-defined op only how many args (never their values). */
function auditSummary(op: string, args: Args): string {
	if (Object.hasOwn(OPS, op)) return OPS[op].summary(args);
	const n = Object.keys(args).length;
	return `game-defined${n ? `, ${n} arg${n === 1 ? "" : "s"}` : ""}`;
}

export type CommandState = "queued" | "sent" | "done" | "failed" | "expired";

interface Command {
	id: string;
	job: string;
	op: string;
	args: Args;
	by: Caller;
	owner: string;
	createdAt: number;
	expiresAt: number;
	state: CommandState;
	sentAt?: number;
	doneAt?: number;
	ms?: number;
	result?: unknown;
	resultBytes: number;
	error?: string;
	redacted?: number;
}

/** What the explorer reads back. */
export interface CommandView {
	id: string;
	op: string;
	state: CommandState;
	createdAt: number;
	expiresAt: number;
	sentAt?: number;
	doneAt?: number;
	ms?: number;
	result?: unknown;
	error?: string;
	redacted?: number;
}

/** What the game gets: `exp` = unix ms after which the backend no longer takes the answer. */
export interface CommandForGame {
	id: string;
	op: string;
	args: Args;
	by: Caller;
	exp: number;
}

export interface AuditEntry {
	at: number;
	who: string;
	ip: string;
	op: string;
	job: string;
	args: string;
	id: string;
}

export interface DebugStatus {
	watched: boolean;
	watchedUntil?: number;
	connected: boolean;
	lastPollAt?: number;
}

export interface RemoteDebugOptions {
	clock?: () => number;
	/** Where the audit file goes (`<dir>/remote-debug.jsonl`); none = memory and the log line only. */
	auditDir?: string;
	log?: (line: string) => void;
	/** Random ids (tests pass a counter). */
	newId?: () => string;
	/** Plans/34: whether `job` declared the game command `name` (live-debug.ts hasCommand); none = no game.* op passes. */
	gameCommand?: (job: string, name: string) => boolean;
}

interface Waiter {
	resolve: () => void;
	timer: ReturnType<typeof setTimeout>;
}

export class RemoteDebugHub {
	private readonly clock: () => number;
	private readonly watches = new Map<string, { until: number; by: string }>();
	private readonly polls = new Map<string, number>();
	private readonly commands = new Map<string, Command>();
	private readonly byJob = new Map<string, string[]>();
	private readonly waiters = new Map<string, Waiter>();
	private readonly audits: AuditEntry[] = [];
	private resultBytes = 0;
	readonly stats = { queued: 0, sent: 0, done: 0, failed: 0, expired: 0, ignored: 0, dropped: 0 };

	constructor(private readonly options: RemoteDebugOptions = {}) {
		this.clock = options.clock ?? Date.now;
	}

	// Watching ----------------------------------------------------------------------------------------------------------

	/** The explorer page is open on `job`. */
	watch(job: string, caller: Caller): DebugStatus {
		const now = this.clock();
		this.watches.delete(job);
		this.watches.set(job, { until: now + WATCH_MS, by: callerKey(caller) });
		while (this.watches.size > WATCH_MAX) {
			let oldest: string | undefined;
			let oldestUntil = Infinity;
			for (const [key, w] of this.watches) if (w.until < oldestUntil) [oldest, oldestUntil] = [key, w.until];
			this.watches.delete(oldest as string);
		}
		return this.status(job);
	}

	isWatched(job: string): boolean {
		const w = this.watches.get(job);
		return w !== undefined && w.until > this.clock();
	}

	status(job: string): DebugStatus {
		const now = this.clock();
		const w = this.watches.get(job);
		const last = this.polls.get(job);
		const watched = w !== undefined && w.until > now;
		return { watched, ...(watched ? { watchedUntil: w.until } : {}), connected: last !== undefined && now - last <= CONNECTED_MS, ...(last !== undefined ? { lastPollAt: last } : {}) };
	}

	/** What a heartbeat reply carries for `job`: `{ rd: 1 }` while it is watched or has commands waiting. */
	heartbeatReply(job: string): { rd: 1 } | undefined {
		return this.isWatched(job) || this.pending(job).some((c) => c.state === "queued") ? { rd: 1 } : undefined;
	}

	// Commands (explorer) -----------------------------------------------------------------------------------------------

	private pending(job: string): Command[] {
		const ids = this.byJob.get(job) ?? [];
		return ids.map((id) => this.commands.get(id)).filter((c): c is Command => c !== undefined && (c.state === "queued" || c.state === "sent"));
	}

	/**
	 * Queues a checked command. Throws RemoteDebugInputError (unknown op, bad args), or returns the reason it can't:
	 * "not_watched" (409: watch first), "busy" (429: PENDING_MAX waiting).
	 */
	enqueue(job: string, op: unknown, args: unknown, caller: Caller, ip = ""): CommandView | "not_watched" | "busy" {
		const checked = checkCommand(op, args, (name) => this.options.gameCommand?.(job, name) ?? false);
		this.sweep();
		if (!this.isWatched(job)) return "not_watched";
		if (this.pending(job).length >= PENDING_MAX) return "busy";
		const now = this.clock();
		const command: Command = {
			id: this.options.newId?.() ?? crypto.randomUUID().replaceAll("-", ""),
			job,
			op: checked.op,
			args: checked.args,
			by: caller,
			owner: callerKey(caller),
			createdAt: now,
			expiresAt: now + QUEUED_TTL_MS,
			state: "queued",
			resultBytes: 0,
		};
		this.commands.set(command.id, command);
		this.byJob.set(job, [...(this.byJob.get(job) ?? []), command.id]);
		this.stats.queued++;
		// A command means the page is open: the watch (and so the kernel's poll) lasts WATCH_MS from now at least.
		const watched = this.watches.get(job);
		if (watched) watched.until = Math.max(watched.until, now + WATCH_MS);
		this.audit({ at: now, who: command.owner, ip, op: command.op, job, args: auditSummary(command.op, command.args), id: command.id });
		this.trim();
		// A held poll answers at once.
		const waiter = this.waiters.get(job);
		if (waiter) waiter.resolve();
		return this.view(command);
	}

	/** A command's state and answer, for the caller who queued it only (others: undefined, like a missing one). */
	get(id: string, caller: Caller, job?: string): CommandView | undefined {
		this.sweep();
		const command = this.commands.get(id);
		if (!command || command.owner !== callerKey(caller) || (job !== undefined && command.job !== job)) return undefined;
		return this.view(command);
	}

	private view(c: Command): CommandView {
		return {
			id: c.id,
			op: c.op,
			state: c.state,
			createdAt: c.createdAt,
			expiresAt: c.expiresAt,
			...(c.sentAt !== undefined ? { sentAt: c.sentAt } : {}),
			...(c.doneAt !== undefined ? { doneAt: c.doneAt } : {}),
			...(c.ms !== undefined ? { ms: c.ms } : {}),
			...(c.state === "done" ? { result: c.result } : {}),
			...(c.error !== undefined ? { error: c.error } : {}),
			...(c.redacted ? { redacted: c.redacted } : {}),
		};
	}

	// The game ----------------------------------------------------------------------------------------------------------

	/** The queued commands of `job`, marked sent (each one is handed out once). */
	private take(job: string): CommandForGame[] {
		const now = this.clock();
		const out: CommandForGame[] = [];
		for (const c of this.pending(job)) {
			if (c.state !== "queued") continue;
			c.state = "sent";
			c.sentAt = now;
			c.expiresAt = now + SENT_TTL_MS;
			this.stats.sent++;
			out.push({ id: c.id, op: c.op, args: c.args, by: c.by, exp: c.expiresAt });
		}
		return out;
	}

	/**
	 * The kernel's poll: the commands waiting for `job`, held up to `waitSeconds` while the job is watched and none is
	 * waiting (a command queued meanwhile answers at once). One held poll per job: a newer one answers the older now.
	 */
	async poll(job: string, waitSeconds: number, signal?: AbortSignal): Promise<{ watch: boolean; commands: CommandForGame[] }> {
		this.sweep();
		this.polls.set(job, this.clock());
		let commands = this.take(job);
		const wait = Math.max(0, Math.min(POLL_WAIT_MAX_S, waitSeconds));
		if (!commands.length && wait > 0 && this.isWatched(job) && !signal?.aborted) {
			this.waiters.get(job)?.resolve();
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					if (this.waiters.get(job)?.resolve === done) this.waiters.delete(job);
					signal?.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, wait * 1000);
				this.waiters.set(job, { resolve: done, timer });
				signal?.addEventListener("abort", done);
			});
			this.polls.set(job, this.clock());
			commands = this.take(job);
		}
		return { watch: this.isWatched(job), commands };
	}

	/** Whether `job` has a command out (sent, no answer yet): only then can its result post change anything. */
	awaiting(job: string): boolean {
		return this.pending(job).some((c) => c.state === "sent");
	}

	/**
	 * The kernel's answers. Only for commands sent to this job and still waiting; the rest is ignored (counted).
	 * `json` is the result as JSON text (at most RESULT_MAX); `error` a short reason.
	 */
	complete(job: string, raw: unknown): { accepted: number; ignored: number } {
		this.sweep();
		if (!Array.isArray(raw)) throw new RemoteDebugInputError("results must be a list");
		if (raw.length > 32) throw new RemoteDebugInputError("at most 32 results a request");
		const now = this.clock();
		let accepted = 0;
		let ignored = 0;
		for (const item of raw) {
			const r = isRecord(item) ? item : {};
			const command = typeof r.id === "string" ? this.commands.get(r.id) : undefined;
			if (!command || command.job !== job || command.state !== "sent") {
				ignored++;
				continue;
			}
			command.doneAt = now;
			command.expiresAt = now + RESULT_TTL_MS;
			if (isInt(r.ms, 0, 600_000)) command.ms = r.ms;
			if (isInt(r.redacted, 1, 100_000)) command.redacted = r.redacted;
			let value: unknown;
			let problem: string | undefined;
			if (r.ok === true) {
				if (r.json === undefined) value = null;
				else if (!isText(r.json, RESULT_MAX)) problem = `the answer is over ${RESULT_MAX / 1024} KB`;
				else {
					try {
						value = JSON.parse(r.json);
					} catch {
						problem = "the answer is not JSON";
					}
				}
			} else {
				problem = typeof r.error === "string" && r.error ? r.error.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) : "failed";
			}
			if (problem === undefined) {
				command.state = "done";
				command.result = value;
				command.resultBytes = typeof r.json === "string" ? r.json.length : 4;
				this.resultBytes += command.resultBytes;
				this.stats.done++;
			} else {
				command.state = "failed";
				command.error = problem;
				this.stats.failed++;
			}
			accepted++;
		}
		this.stats.ignored += ignored;
		this.trim();
		return { accepted, ignored };
	}

	// Housekeeping ------------------------------------------------------------------------------------------------------

	/** Expires commands, drops old answers, forgets old watches and polls. Cheap; runs on every call. */
	sweep(): void {
		const now = this.clock();
		for (const [id, c] of this.commands) {
			if ((c.state === "queued" || c.state === "sent") && now >= c.expiresAt) {
				c.state = "expired";
				c.error = c.sentAt === undefined ? "the server never picked it up" : "the server didn't answer in time";
				c.expiresAt = now + RESULT_TTL_MS;
				this.stats.expired++;
			} else if ((c.state === "done" || c.state === "failed" || c.state === "expired") && now >= c.expiresAt) {
				this.forget(id, c);
			}
		}
		for (const [job, w] of this.watches) if (w.until <= now) this.watches.delete(job);
		for (const [job, at] of this.polls) if (now - at > 10 * 60_000) this.polls.delete(job);
	}

	private forget(id: string, c: Command): void {
		this.resultBytes -= c.resultBytes;
		this.commands.delete(id);
		const ids = this.byJob.get(c.job)?.filter((x) => x !== id) ?? [];
		if (ids.length) this.byJob.set(c.job, ids);
		else this.byJob.delete(c.job);
	}

	/** Bounds: COMMANDS_MAX commands and RESULT_BYTES_MAX bytes of answers; the oldest finished ones go first. */
	private trim(): void {
		for (const [id, c] of this.commands) {
			if (this.commands.size <= COMMANDS_MAX && this.resultBytes <= RESULT_BYTES_MAX) break;
			if (c.state === "queued" || c.state === "sent") continue;
			this.forget(id, c);
			this.stats.dropped++;
		}
	}

	/** Answers held right now (JSON bytes), for /healthz. */
	get memory(): { commands: number; resultBytes: number; watched: number } {
		return { commands: this.commands.size, resultBytes: this.resultBytes, watched: this.watches.size };
	}

	stop(): void {
		for (const w of this.waiters.values()) w.resolve();
	}

	// Audit -------------------------------------------------------------------------------------------------------------

	private audit(entry: AuditEntry): void {
		this.audits.push(entry);
		if (this.audits.length > AUDIT_KEPT) this.audits.shift();
		this.options.log?.(`remote debug: ${entry.who} ${entry.op}${entry.args ? ` (${entry.args})` : ""} on ${entry.job} from ${entry.ip || "?"}`);
		const dir = this.options.auditDir;
		if (!dir) return;
		try {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const file = join(dir, "remote-debug.jsonl");
			if (existsSync(file) && statSync(file).size > AUDIT_FILE_MAX) renameSync(file, `${file}.1`);
			appendFileSync(file, `${JSON.stringify({ ...entry, at: new Date(entry.at).toISOString() })}\n`, { mode: 0o600 });
		} catch (error) {
			this.options.log?.(`remote debug: the audit file could not be written: ${(error as Error).message.slice(0, 200)}`);
		}
	}

	/** The newest audit entries first. */
	auditLog(limit = 100): AuditEntry[] {
		return this.audits.slice(-Math.max(1, Math.min(AUDIT_KEPT, limit))).reverse();
	}
}
