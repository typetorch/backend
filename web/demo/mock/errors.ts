/**
 * Error logs (src/errors/http.ts, src/server/app.ts) over a deterministic error world built from the pack:
 *
 *   GET  /v1/errors                     kinds with counts, players, sparkline, builds
 *   GET  /v1/errors/<fp>                one kind: stack, series, by build / branch / realm / job
 *   GET  /v1/errors/<fp>/players        who hit it (fake names, never a UserId), and the occurrences without a player
 *   GET  /v1/players/<pid>/errors       the kinds one player hit
 *   GET  /v1/servers/<job>/errors       the kinds one game server reported
 *   GET  /v1/errors/drop-rules          the drop rules (demo state) and their drops since the "server" started
 *   POST /v1/errors/drop-rules/preview  what an expression would drop
 *   SSE  /v1/live?topics=error          hello, then `error` events as the pack's occurrences pass "now"
 *
 * The world: every error kind of the pack (its real client / server messages, their counts, players, servers, builds and
 * time spans) spread into occurrences on the pack's real jobs and pids, plus The Prison's own script errors (arrests,
 * escapes, quests, the shop, the vault...) at a steady rate that follows how many servers ran each hour, including a
 * regression that a deploy brought and the next one fixed. Occurrences after now are hidden, so the list grows as the day
 * goes on, and the live stream says so. Drop rules (saved through the Errors page / Settings) drop the occurrences after
 * they were saved, like the backend drops items at ingest.
 */
import { checkDropRules, compileDropExpr, DropRuleError, type DropSubject, type ErrorDropRule } from "../../../src/errors/drop-rules.ts";
import { parseFilter, parseWindow } from "../../../src/errors/http.ts";
import { ERROR_JOB_PATTERN, ErrorInputError, FP_PATTERN } from "../../../src/errors/parse.ts";
import { ERROR_BUILDS_LISTED, ERROR_JOBS_LISTED, ERROR_PLAYERS_MAX, ERROR_SORT_COLUMNS, PLAYER_ERRORS_MAX, SERVER_ERRORS_MAX, type ErrorFilter, type ErrorSortColumn, type ErrorWindow } from "../../../src/errors/store.ts";
import type { DropPreview, ErrorDetail, ErrorDropRules, ErrorKind, ErrorList, ErrorPlayers, PlayerErrors, ServerErrors } from "@/lib/types";
import { DAY_MS, now, readDataJson } from "./data";
import { pack, type PackError, type PackJob, type PackPlayer } from "./pack";
import { fakeName, hashString, rng, type Rng } from "./rng";
import { fail, HttpError, route, stream, type MockRequest } from "./router";
import { onStateChange, slice } from "./state";

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** errorKeepDays: the backend's default (TYPETORCH_ERROR_KEEP_DAYS). */
export const ERROR_KEEP_DAYS = 30;
/** The pid shape the backend checks (fleet/identity.ts PID_PATTERN). */
export const PID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const iso = (ms: number) => new Date(ms).toISOString();

// The world ------------------------------------------------------------------------------------------------------------

type Realm = "server" | "client";

export interface WorldKind {
	fp: string;
	template: string;
	stack: string | null;
	realm: Realm;
}

export interface Occurrence {
	/** Index into the world's kinds. */
	k: number;
	t: number;
	n: number;
	job: string;
	pid: string | null;
	branch: string;
	build: string;
}

export interface ErrorWorld {
	shift: number;
	kinds: WorldKind[];
	byFp: Map<string, number>;
	/** Oldest first; may reach past now (hidden by `stored()`). */
	occ: Occurrence[];
}

/** The raw facts (unshifted, uncapped): the world is built once per day shift, so it doesn't move as the clock does. */
interface RawFacts {
	meta: { firstT: number; lastT: number };
	jobs: Omit<PackJob, "live">[];
	players: PackPlayer[];
	errors: PackError[];
}

/** The Prison's own script errors: the systems behind the pack's events (arrests, escapes, quests, shop, vault, jobs...). */
interface GameError {
	template: string;
	stack: string;
	realm: Realm;
	/** Occurrences per hour at an average hour. */
	rate: number;
	/** Share that names a player. */
	withPlayer: number;
	/** Only builds with a deploy seq in [from, to] (a regression and its fix). */
	seqs?: [number, number];
	/** Branch: prod (default), dev, or any. */
	branch?: "prod" | "dev" | "any";
}

const SSS = "ServerScriptService.Systems";
const PS = "Players.Player.PlayerScripts.Controllers";

export const GAME_ERRORS: GameError[] = [
	{
		template: `${SSS}.ArrestService:142: attempt to index nil with 'Character'`,
		stack: `${SSS}.ArrestService:142 function cuffTarget\n${SSS}.ArrestService:88 function onTaserHit\nReplicatedStorage.Packages.Signal:41 function fire`,
		realm: "server",
		rate: 1.1,
		withPlayer: 0.9,
	},
	{
		template: `${SSS}.EscapeService:311: escape zone "SewerGrate" has no spawn point for team Inmate`,
		stack: `${SSS}.EscapeService:311 function respawnEscaped\n${SSS}.EscapeService:204 function onZoneTouched`,
		realm: "server",
		rate: 0.45,
		withPlayer: 1,
	},
	{
		template: `${SSS}.QuestService:97: unknown quest id "weekly_inmate_escape_5_times" in a saved profile`,
		stack: `${SSS}.QuestService:97 function loadProgress\n${SSS}.PlayerData:63 function onProfileLoaded`,
		realm: "server",
		rate: 0.3,
		withPlayer: 1,
	},
	{
		template: `${SSS}.ShopService:204: ProcessReceipt for product "cash_pack_2" timed out after 15 s`,
		stack: `${SSS}.ShopService:204 function processReceipt\n${SSS}.CashService:56 function grant`,
		realm: "server",
		rate: 0.12,
		withPlayer: 1,
	},
	{
		template: `${SSS}.CashService:118: cash save throttled (DataStore budget exhausted), retrying in 6 s`,
		stack: `${SSS}.CashService:118 function save\n${SSS}.PlayerData:140 function autosave`,
		realm: "server",
		rate: 0.7,
		withPlayer: 0.8,
	},
	{
		template: `${SSS}.VaultService:133: vault door "Vault_B" tween interrupted: the door was destroyed`,
		stack: `${SSS}.VaultService:133 function openDoor\n${SSS}.VaultService:71 function onCracked`,
		realm: "server",
		rate: 0.2,
		withPlayer: 0.4,
	},
	{
		template: `${SSS}.JobService:72: trash_bin job target is nil (bin respawned mid-job)`,
		stack: `${SSS}.JobService:72 function completeJob\n${SSS}.JobService:40 function onPrompt`,
		realm: "server",
		rate: 0.9,
		withPlayer: 1,
	},
	{
		template: `${SSS}.LockpickService:58: lockpick result for cell door "C-14" that is already open`,
		stack: `${SSS}.LockpickService:58 function finish\n${SSS}.LockpickService:31 function onResult`,
		realm: "server",
		rate: 0.35,
		withPlayer: 1,
	},
	{
		template: `${SSS}.BountyService:119: bounty target left before the payout (reward kept by the warden)`,
		stack: `${SSS}.BountyService:119 function payout\n${SSS}.BountyService:77 function onTargetArrested`,
		realm: "server",
		rate: 0.15,
		withPlayer: 0.6,
	},
	{
		template: `${SSS}.TeamQueue:45: guard slots full (8/8) and the queued player has no fallback team`,
		stack: `${SSS}.TeamQueue:45 function promote\n${SSS}.TeamQueue:22 function onPlayerRemoving`,
		realm: "server",
		rate: 0.25,
		withPlayer: 1,
	},
	{
		template: `${SSS}.MedicService:88: heal reward for a player who is already at full health`,
		stack: `${SSS}.MedicService:88 function rewardHeal\n${SSS}.MedicService:52 function onSyringeUsed`,
		realm: "server",
		rate: 0.3,
		withPlayer: 1,
		seqs: [221, 223],
	},
	{
		template: `${PS}.HudController:211: attempt to perform arithmetic on nil value (field 'cash')`,
		stack: `${PS}.HudController:211 function renderCash\n${PS}.HudController:95 function onDataChanged`,
		realm: "client",
		rate: 0.8,
		withPlayer: 0.97,
	},
	{
		template: `${PS}.MissionsController:88: Infinite yield possible on 'ReplicatedStorage.Quests:WaitForChild("daily_guard_guard_area_2x")'`,
		stack: `${PS}.MissionsController:88 function pinQuest\n${PS}.MissionsController:40 function open`,
		realm: "client",
		rate: 0.4,
		withPlayer: 0.97,
	},
	{
		template: `${PS}.ShopController:150: attempt to index nil with 'Price' (item "electrospear")`,
		stack: `${PS}.ShopController:150 function selectItem\n${PS}.ShopController:61 function onClick`,
		realm: "client",
		rate: 0.35,
		withPlayer: 0.97,
	},
	{
		template: `${PS}.TutorialController:302: beam target "TutorialMop" not found in Workspace`,
		stack: `${PS}.TutorialController:302 function showBeam\n${PS}.TutorialController:118 function step`,
		realm: "client",
		rate: 1.4,
		withPlayer: 0.97,
		seqs: [219, 223],
	},
	{
		template: `${PS}.SpinController:64: daily spin result arrived after the wheel closed`,
		stack: `${PS}.SpinController:64 function onResult\n${PS}.SpinController:20 function spin`,
		realm: "client",
		rate: 0.25,
		withPlayer: 0.97,
	},
	{
		template: `${PS}.MinimapController:40: prison map chunk "CellBlockB" failed to stream in`,
		stack: `${PS}.MinimapController:40 function loadChunk\n${PS}.MinimapController:12 function init`,
		realm: "client",
		rate: 0.5,
		withPlayer: 0.97,
	},
	{
		template: `${PS}.CombatController:177: weapon "sledgehammer" has no swing animation loaded`,
		stack: `${PS}.CombatController:177 function swing\n${PS}.CombatController:90 function onActivated`,
		realm: "client",
		rate: 0.3,
		withPlayer: 0.97,
		branch: "any",
	},
];

/** A kind's fingerprint: 16 hex characters from its message and side (like the kernel's hashed fps). */
export function fpOf(template: string, realm: string): string {
	const a = hashString(`fp:${realm}:${template}`).toString(16).padStart(8, "0");
	const b = hashString(`fp2:${template}:${realm}`).toString(16).padStart(8, "0");
	return `${a}${b}`;
}

/** A pack message as a template and a stack ("...\n    Stack Begin\n    Script '...', Line 6\n    Stack End"). */
export function splitMessage(msg: string): { template: string; stack: string | null } {
	const i = msg.indexOf("\n");
	if (i < 0) return { template: msg.trim(), stack: null };
	const lines = msg
		.slice(i + 1)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && l !== "Stack Begin" && l !== "Stack End");
	return { template: msg.slice(0, i).trim(), stack: lines.length ? lines.join("\n").slice(0, 4000) : null };
}

/** Poisson-ish draw for small means. */
function poisson(r: Rng, mean: number): number {
	if (mean <= 0) return 0;
	const limit = Math.exp(-Math.min(mean, 30));
	let k = 0;
	let p = 1;
	do {
		k++;
		p *= r.next();
	} while (p > limit && k < 60);
	return k - 1;
}

export function buildWorld(facts: RawFacts, shift: number): ErrorWorld {
	const kinds: WorldKind[] = [];
	const byFp = new Map<string, number>();
	const occ: Occurrence[] = [];
	const kindOf = (template: string, stack: string | null, realm: Realm): number => {
		const fp = fpOf(template, realm);
		let k = byFp.get(fp);
		if (k === undefined) {
			k = kinds.length;
			kinds.push({ fp, template, stack, realm });
			byFp.set(fp, k);
		}
		return k;
	};

	// Jobs and players by hour / day (raw time).
	const jobs = facts.jobs.filter((j) => j.firstAt <= j.lastAt);
	const jobsByHour = new Map<number, typeof jobs>();
	for (const j of jobs) {
		for (let h = Math.floor(j.firstAt / HOUR); h <= Math.floor(j.lastAt / HOUR); h++) {
			const list = jobsByHour.get(h) ?? [];
			list.push(j);
			jobsByHour.set(h, list);
		}
	}
	const playersByDay = new Map<number, PackPlayer[]>();
	for (const p of facts.players) {
		for (let d = Math.floor(p.firstAt / DAY_MS); d <= Math.floor(p.lastAt / DAY_MS); d++) {
			const list = playersByDay.get(d) ?? [];
			list.push(p);
			playersByDay.set(d, list);
		}
	}
	const activeJobs = (t: number) => (jobsByHour.get(Math.floor(t / HOUR)) ?? []).filter((j) => j.firstAt - 5 * MINUTE <= t && t <= j.lastAt + 5 * MINUTE);
	const activePlayers = (t: number) => (playersByDay.get(Math.floor(t / DAY_MS)) ?? []).filter((p) => p.firstAt <= t && t <= p.lastAt + HOUR);
	const nearestJob = (t: number): (typeof jobs)[number] | undefined => {
		let best: (typeof jobs)[number] | undefined;
		let gap = Infinity;
		for (const j of jobs) {
			const g = t < j.firstAt ? j.firstAt - t : t > j.lastAt ? t - j.lastAt : 0;
			if (g < gap) {
				gap = g;
				best = j;
			}
		}
		return best;
	};
	const pickJob = (r: Rng, t: number, ok: (j: (typeof jobs)[number]) => boolean) => {
		const live = activeJobs(t);
		const fit = live.filter(ok);
		const list = fit.length ? fit : live;
		if (!list.length) return nearestJob(t);
		return r.weighted(list.map((j) => [j, j.errors + j.players / 4 + 0.5] as const));
	};

	// The pack's own error kinds: their rows spread over their span, their counts summing to their total.
	for (const e of facts.errors) {
		const realm: Realm = e.src === "server" ? "server" : "client";
		const { template, stack } = splitMessage(e.msg);
		const k = kindOf(template, stack, realm);
		const r = rng(`errors:pack:${kinds[k]?.fp}:${e.firstAt}`);
		const rows = Math.max(1, e.n);
		const counts = new Array<number>(rows).fill(1);
		for (let extra = Math.max(0, e.total - rows); extra > 0; extra--) counts[r.int(0, rows - 1)]! += 1;
		const arts = new Set(e.arts);
		const pool: PackPlayer[] = [];
		if (e.players > 0) {
			const overlap = facts.players.filter((p) => p.lastAt >= e.firstAt - HOUR && p.firstAt <= e.lastAt + HOUR);
			const ranked = r.shuffle(overlap).sort((a, b) => Number(b.errors > 0) - Number(a.errors > 0));
			pool.push(...ranked.slice(0, e.players));
		}
		for (let i = 0; i < rows; i++) {
			const t = rows === 1 ? e.lastAt : i === 0 ? e.firstAt : i === rows - 1 ? e.lastAt : r.int(e.firstAt, e.lastAt);
			const job = pickJob(r, t, (j) => (j.art ? arts.has(j.art) : false));
			if (!job) continue;
			const build = job.art && arts.has(job.art) ? job.art : (r.pick(e.arts.length ? e.arts : [job.art ?? ""]) ?? "");
			const branch = job.art && arts.has(job.art) ? (job.branch ?? "") : (e.branches[0] ?? job.branch ?? "");
			let pid: string | null = null;
			if (pool.length && !(realm === "client" && r.chance(0.04))) {
				const here = pool.filter((p) => p.firstAt <= t && t <= p.lastAt + HOUR);
				pid = r.pick(here.length ? here : pool).pid;
			}
			occ.push({ k, t: t + shift, n: counts[i] ?? 1, job: job.job, pid, branch, build });
		}
	}

	// The game's own script errors, hour by hour, following how many servers ran.
	const firstHour = Math.floor(facts.meta.firstT / HOUR);
	const lastHour = Math.floor(facts.meta.lastT / HOUR);
	let activity = 0;
	for (let h = firstHour; h <= lastHour; h++) activity += jobsByHour.get(h)?.length ?? 0;
	const average = Math.max(1, activity / Math.max(1, lastHour - firstHour + 1));
	for (const g of GAME_ERRORS) {
		const k = kindOf(g.template, g.stack, g.realm);
		const fits = (j: (typeof jobs)[number]) =>
			(g.branch === "any" || (j.branch ?? "prod") === (g.branch ?? "prod")) && (!g.seqs || (j.seq !== null && j.seq >= g.seqs[0] && j.seq <= g.seqs[1]));
		for (let h = firstHour; h <= lastHour; h++) {
			const here = (jobsByHour.get(h) ?? []).filter(fits);
			if (!here.length) continue;
			const r = rng(`errors:game:${k}:${h}`);
			const n = poisson(r, (g.rate * here.length) / average);
			for (let i = 0; i < n; i++) {
				const t = h * HOUR + r.int(0, HOUR - 1);
				const live = here.filter((j) => j.firstAt - 5 * MINUTE <= t && t <= j.lastAt + 5 * MINUTE);
				const job = r.weighted((live.length ? live : here).map((j) => [j, j.players / 4 + 1] as const));
				let pid: string | null = null;
				if (r.chance(g.withPlayer)) {
					const players = activePlayers(t);
					if (players.length) pid = r.pick(players).pid;
				}
				occ.push({ k, t: t + shift, n: r.weighted([[1, 8], [2, 2], [3, 1]]), job: job.job, pid, branch: job.branch ?? "", build: job.art ?? "" });
			}
		}
	}
	occ.sort((a, b) => a.t - b.t || a.k - b.k);
	return { shift, kinds, byFp, occ };
}

let worldCache: { shift: number; world: Promise<ErrorWorld> } | undefined;

/** The error world for the current day shift (built once a day). */
export async function errorWorld(): Promise<ErrorWorld> {
	const p = await pack();
	if (!worldCache || worldCache.shift !== p.shiftMs) {
		const shift = p.shiftMs;
		const world = readDataJson<RawFacts>("facts.json").then((facts) => buildWorld(facts, shift));
		worldCache = { shift, world };
		world.catch(() => (worldCache = undefined));
	}
	return worldCache.world;
}

// Drop rules (the runtime setting errorDropRules) -------------------------------------------------------------------------

interface DropState {
	rules: ErrorDropRule[];
	/** When each rule (by id + expression) started dropping; missing: since the server started. */
	savedAt: Record<string, number>;
	source: "env" | "dashboard" | "default";
}

const SEED_RULES: ErrorDropRule[] = [
	{ id: "locale-noise", expr: 'message contains "DateTimeLocaleConfig"', note: "Roblox's own locale files: nothing the game can fix", on: true },
	{ id: "coregui", expr: 'message startswith "[Roblox]" or stack contains "CoreGui."', note: "Errors from Roblox's CoreGui scripts", on: true },
	{ id: "sound-timeouts", expr: 'message matches /^Failed to load sound rbxassetid:\\/\\/\\d+: HttpError: Timedout$/ and realm = "client"', note: "CDN timeouts on phones (off while we check the sound budget)", on: false },
];

const dropState = slice<DropState>("errors.dropRules", () => ({ rules: SEED_RULES, savedAt: {}, source: "dashboard" }));

const ruleKey = (r: ErrorDropRule) => `${r.id}\u0000${r.expr}`;

/** When the demo's backend "started" (healthz says up three days and today): the drop counters count from here. */
export function serverStartedAt(at = now()): number {
	return Math.floor(at / DAY_MS) * DAY_MS - 3 * DAY_MS;
}

/** The saved drop rules (the Settings page's errorDropRules reads these). */
export function getErrorDropRules(): ErrorDropRule[] {
	return dropState.get().rules;
}

export function errorDropRulesSource(): DropState["source"] {
	return dropState.get().source;
}

/**
 * Saves the drop rules (PATCH /v1/admin/settings { errorDropRules } calls this; the admin domain owns that route).
 * Checked like the backend's settings PATCH (throws DropRuleError). New or changed rules drop from now on.
 */
export function setErrorDropRules(raw: unknown): ErrorDropRule[] {
	const rules = checkDropRules(raw);
	const at = now();
	dropState.update((s) => {
		const before = new Map(s.rules.map((r) => [ruleKey(r), r]));
		const savedAt: Record<string, number> = {};
		for (const r of rules) {
			const old = before.get(ruleKey(r));
			const kept = s.savedAt[ruleKey(r)];
			// Unchanged and already on: keeps its start; new, edited or switched on: drops from now.
			savedAt[ruleKey(r)] = old && old.on && r.on ? (kept ?? serverStartedAt(at)) : at;
		}
		return { rules, savedAt, source: "dashboard" };
	});
	return rules;
}

/** Back to the built-in default (an empty list, like the backend without the setting). */
export function resetErrorDropRules(): void {
	dropState.set({ rules: [], savedAt: {}, source: "default" });
}

export { DropRuleError };

interface Compiled {
	rule: ErrorDropRule;
	since: number;
	test: (s: DropSubject) => boolean;
}

function compiledRules(): Compiled[] {
	const s = dropState.get();
	const start = serverStartedAt();
	const out: Compiled[] = [];
	for (const rule of s.rules) {
		if (!rule.on) continue;
		try {
			out.push({ rule, since: Math.max(start, s.savedAt[ruleKey(rule)] ?? start), test: compileDropExpr(rule.expr).test });
		} catch {
			// a saved rule that doesn't parse is skipped (the page shows its error)
		}
	}
	return out;
}

interface Stored {
	world: ErrorWorld;
	/** Occurrences kept (not dropped), t <= now, oldest first. */
	occ: Occurrence[];
	/** Per kind index: first / last seen, all-time total, last branch and build (error_kinds). */
	kinds: Map<number, { firstAt: number; lastAt: number; total: number; branch: string; build: string }>;
	drops: Record<string, { items: number; occurrences: number; lastAt: number | null }>;
}

let storedCache: { key: string; value: Stored } | undefined;
onStateChange(() => (storedCache = undefined));

/** What the backend's error tables hold now: the world up to now, without what the drop rules dropped. */
export async function stored(): Promise<Stored> {
	const world = await errorWorld();
	const at = now();
	const key = `${world.shift}:${at}`;
	if (storedCache?.key === key && storedCache.value.world === world) return storedCache.value;
	const rules = compiledRules();
	const drops: Stored["drops"] = Object.fromEntries(dropState.get().rules.map((r) => [r.id, { items: 0, occurrences: 0, lastAt: null }]));
	// A rule's verdict per kind, branch and build (the subject's only parts that vary).
	const memo = new Map<string, boolean>();
	const hits = (i: number, r: Compiled, o: Occurrence): boolean => {
		const key = `${i}|${o.k}|${o.branch}|${o.build}`;
		let hit = memo.get(key);
		if (hit === undefined) {
			const kind = world.kinds[o.k] as WorldKind;
			hit = r.test({ message: kind.template, stack: kind.stack, realm: kind.realm, branch: o.branch || null, build: o.build || null, fp: kind.fp });
			memo.set(key, hit);
		}
		return hit;
	};
	const occ: Occurrence[] = [];
	const kinds: Stored["kinds"] = new Map();
	for (const o of world.occ) {
		if (o.t > at) break;
		// The first rule that was on then and matches drops it (counted there), like ErrorDropper at ingest.
		const dropped = rules.find((r, i) => o.t >= r.since && hits(i, r, o));
		if (dropped) {
			const d = drops[dropped.rule.id] ?? { items: 0, occurrences: 0, lastAt: null };
			d.items += 1;
			d.occurrences += o.n;
			d.lastAt = Math.max(d.lastAt ?? 0, o.t);
			drops[dropped.rule.id] = d;
			continue;
		}
		occ.push(o);
		const k = kinds.get(o.k);
		if (k) {
			k.lastAt = o.t;
			k.total += o.n;
			k.branch = o.branch;
			k.build = o.build;
		} else kinds.set(o.k, { firstAt: o.t, lastAt: o.t, total: o.n, branch: o.branch, build: o.build });
	}
	const value: Stored = { world, occ, kinds, drops };
	storedCache = { key, value };
	return value;
}

// Reads ----------------------------------------------------------------------------------------------------------------

function bucketIndex(w: ErrorWindow) {
	const bucketMinutes = Math.max(1, Math.round(w.bucketSeconds / 60));
	const fromMinute = Math.floor(w.from / MINUTE);
	const toMinute = Math.max(fromMinute, Math.ceil(w.to / MINUTE) - 1);
	const start = Math.floor(fromMinute / bucketMinutes);
	const end = Math.floor(toMinute / bucketMinutes);
	return { fromMinute, toMinute, bucketMinutes, buckets: end - start + 1, start };
}

const inMinutes = (o: Occurrence, idx: { fromMinute: number; toMinute: number }) => {
	const m = Math.floor(o.t / MINUTE);
	return m >= idx.fromMinute && m <= idx.toMinute;
};

function dayRange(w: ErrorWindow): [number, number] {
	return [Math.floor(w.from / DAY_MS), Math.floor((w.to - 1) / DAY_MS)];
}

const inDays = (o: Occurrence, days: [number, number]) => {
	const d = Math.floor(o.t / DAY_MS);
	return d >= days[0] && d <= days[1];
};

function matches(o: Occurrence, kind: WorldKind, f: ErrorFilter): boolean {
	if (f.branch !== undefined && o.branch !== f.branch) return false;
	if (f.build !== undefined && o.build !== f.build) return false;
	if (f.realm !== undefined && kind.realm !== f.realm) return false;
	return true;
}

/** Window and filter from the query, with the backend's 400s. */
function parseRead(req: MockRequest): { window: ErrorWindow; filter: ErrorFilter } {
	try {
		return { window: parseWindow(req.query, now(), ERROR_KEEP_DAYS), filter: parseFilter(req.query) };
	} catch (error) {
		if (error instanceof ErrorInputError) throw new HttpError(400, error.message);
		throw error;
	}
}

function limitOf(req: MockRequest, fallback: number, max: number): number {
	const text = req.query.get("limit");
	const limit = text ? Number(text) : fallback;
	if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new HttpError(400, `limit is a whole number from 1 to ${max}`);
	return limit;
}

const topFrame = (stack: string | null) => (stack ? (stack.split("\n")[0] ?? "").slice(0, 300) || null : null);

function sortedRealms(set: Set<string>): string[] {
	return [...set].filter(Boolean).sort();
}

export async function listErrors(req: MockRequest): Promise<ErrorList> {
	const { window: w, filter } = parseRead(req);
	const limitText = req.query.get("limit");
	const limit = limitText ? Number(limitText) : 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit is a whole number from 1 to 500");
	const search = req.query.get("q") ?? undefined;
	if (search && search.length > 100) throw new HttpError(400, "q is at most 100 characters");
	const sortText = req.query.get("sort");
	let sort: { by: ErrorSortColumn; desc: boolean } | undefined;
	if (sortText) {
		const by = sortText.replace(/^-/, "") as ErrorSortColumn;
		if (!ERROR_SORT_COLUMNS.includes(by)) throw new HttpError(400, `sort is one of ${ERROR_SORT_COLUMNS.join(", ")}, with - in front for largest first`);
		sort = { by, desc: sortText.startsWith("-") };
	}
	const s = await stored();
	const idx = bucketIndex(w);
	const days = dayRange(w);
	const needle = search?.trim().toLowerCase();
	const groups = new Map<number, { n: number; spark: number[]; pids: Set<string> }>();
	let totalCount = 0;
	const totalKinds = new Set<number>();
	const totalPlayers = new Set<string>();
	const builds = new Map<string, { n: number; last: number }>();
	for (const o of s.occ) {
		const kind = s.world.kinds[o.k] as WorldKind;
		const minutes = inMinutes(o, idx);
		// The build list ignores the build filter (the explorer's build select).
		if (minutes && matches(o, kind, { ...filter, build: undefined })) {
			const b = builds.get(o.build) ?? { n: 0, last: 0 };
			b.n += o.n;
			b.last = Math.max(b.last, Math.floor(o.t / MINUTE));
			builds.set(o.build, b);
		}
		if (!matches(o, kind, filter)) continue;
		if (o.pid && inDays(o, days)) totalPlayers.add(o.pid);
		if (!minutes) continue;
		totalCount += o.n;
		totalKinds.add(o.k);
		if (needle && !kind.template.toLowerCase().includes(needle) && kind.fp !== search) continue;
		const g = groups.get(o.k) ?? { n: 0, spark: new Array<number>(idx.buckets).fill(0), pids: new Set<string>() };
		g.n += o.n;
		const at = Math.floor(Math.floor(o.t / MINUTE) / idx.bucketMinutes) - idx.start;
		if (at >= 0 && at < idx.buckets) g.spark[at] = (g.spark[at] ?? 0) + o.n;
		groups.set(o.k, g);
	}
	// Players per kind count by the days the rows cover (error_pids), not the minutes.
	for (const o of s.occ) {
		if (!o.pid || !groups.has(o.k) || !inDays(o, days) || !matches(o, s.world.kinds[o.k] as WorldKind, filter)) continue;
		groups.get(o.k)?.pids.add(o.pid);
	}
	const rows = [...groups.entries()].map(([k, g]) => {
		const kind = s.world.kinds[k] as WorldKind;
		const info = s.kinds.get(k) ?? { firstAt: 0, lastAt: 0, total: 0, branch: "", build: "" };
		return { k, kind, info, g };
	});
	const value = (r: (typeof rows)[number], by: ErrorSortColumn): number | string =>
		by === "count" ? r.g.n : by === "lastAt" ? r.info.lastAt : by === "firstAt" ? r.info.firstAt : by === "total" ? r.info.total : r.kind.realm;
	rows.sort((a, b) => {
		if (sort) {
			const x = value(a, sort.by);
			const y = value(b, sort.by);
			if (x !== y) return (x < y ? -1 : 1) * (sort.desc ? -1 : 1);
		}
		return b.g.n - a.g.n || b.info.lastAt - a.info.lastAt || (a.kind.fp < b.kind.fp ? -1 : 1);
	});
	const shown = rows.slice(0, limit);
	const kinds: ErrorKind[] = shown.map((r) => ({
		fp: r.kind.fp,
		template: r.kind.template,
		topFrame: topFrame(r.kind.stack),
		realm: r.kind.realm,
		count: r.g.n,
		players: r.g.pids.size,
		firstAt: iso(r.info.firstAt),
		lastAt: iso(r.info.lastAt),
		total: r.info.total,
		spark: r.g.spark,
	}));
	return {
		window: { from: iso(w.from), to: iso(w.to), bucketSeconds: idx.bucketMinutes * 60, buckets: idx.buckets },
		kinds,
		totals: { count: totalCount, kinds: totalKinds.size, players: totalPlayers.size },
		more: Math.max(0, rows.length - limit),
		builds: [...builds.entries()]
			.sort((a, b) => b[1].last - a[1].last || b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
			.slice(0, ERROR_BUILDS_LISTED)
			.map(([build, b]) => ({ build: build || "(unknown)", n: b.n, lastAt: iso(b.last * MINUTE) })),
	};
}

function checkFp(raw: string): string {
	if (!FP_PATTERN.test(raw)) throw new HttpError(400, "bad fingerprint");
	return raw;
}

export async function errorDetail(req: MockRequest): Promise<ErrorDetail> {
	const fp = checkFp(req.params.fp as string);
	const { window: w, filter } = parseRead(req);
	const s = await stored();
	const k = s.world.byFp.get(fp);
	const info = k === undefined ? undefined : s.kinds.get(k);
	if (k === undefined || !info) throw new HttpError(404, "no such error kind");
	const kind = s.world.kinds[k] as WorldKind;
	const idx = bucketIndex(w);
	const days = dayRange(w);
	const series = new Array<number>(idx.buckets).fill(0);
	let count = 0;
	const by = { build: new Map<string, number>(), branch: new Map<string, number>(), realm: new Map<string, number>() };
	const jobs = new Map<string, { n: number; branch: string; build: string; lastAt: number }>();
	const players = new Set<string>();
	for (const o of s.occ) {
		if (o.k !== k || !matches(o, kind, filter)) continue;
		if (o.pid && inDays(o, days)) players.add(o.pid);
		if (o.t >= w.from && o.t < w.to) {
			const j = jobs.get(o.job) ?? { n: 0, branch: o.branch, build: o.build, lastAt: 0 };
			j.n += o.n;
			j.lastAt = Math.max(j.lastAt, o.t);
			jobs.set(o.job, j);
		}
		if (!inMinutes(o, idx)) continue;
		count += o.n;
		const at = Math.floor(Math.floor(o.t / MINUTE) / idx.bucketMinutes) - idx.start;
		if (at >= 0 && at < idx.buckets) series[at] = (series[at] ?? 0) + o.n;
		by.build.set(o.build, (by.build.get(o.build) ?? 0) + o.n);
		by.branch.set(o.branch, (by.branch.get(o.branch) ?? 0) + o.n);
		by.realm.set(kind.realm, (by.realm.get(kind.realm) ?? 0) + o.n);
	}
	const top = (m: Map<string, number>) =>
		[...m.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20);
	return {
		kind: { fp, template: kind.template, stack: kind.stack, realm: kind.realm, firstAt: iso(info.firstAt), lastAt: iso(info.lastAt), total: info.total },
		window: { from: iso(w.from), to: iso(w.to), bucketSeconds: idx.bucketMinutes * 60, buckets: idx.buckets },
		count,
		players: players.size,
		series: series.map((n, i) => ({ t: iso((idx.start + i) * idx.bucketMinutes * MINUTE), n })),
		byBuild: top(by.build).map(([build, n]) => ({ build: build || "(unknown)", n })),
		byBranch: top(by.branch).map(([branch, n]) => ({ branch: branch || "(unknown)", n })),
		byRealm: top(by.realm).map(([realm, n]) => ({ realm, n })),
		byJob: [...jobs.entries()]
			.sort((a, b) => b[1].n - a[1].n || b[1].lastAt - a[1].lastAt || (a[0] < b[0] ? -1 : 1))
			.slice(0, ERROR_JOBS_LISTED)
			.map(([job, j]) => ({ job, n: j.n, branch: j.branch || "(unknown)", build: j.build || "(unknown)", lastAt: iso(j.lastAt) })),
	};
}

interface Agg {
	n: number;
	days: Set<number>;
	firstAt: number;
	lastAt: number;
	realms: Set<string>;
}

function add(map: Map<string, Agg>, key: string, o: Occurrence, realm: string): void {
	const a = map.get(key) ?? { n: 0, days: new Set<number>(), firstAt: o.t, lastAt: o.t, realms: new Set<string>() };
	a.n += o.n;
	a.days.add(Math.floor(o.t / DAY_MS));
	a.firstAt = Math.min(a.firstAt, o.t);
	a.lastAt = Math.max(a.lastAt, o.t);
	a.realms.add(realm);
	map.set(key, a);
}

const byCount = (a: [string, Agg], b: [string, Agg]) => b[1].n - a[1].n || b[1].lastAt - a[1].lastAt || (a[0] < b[0] ? -1 : 1);

/** The pack's team for a pid (for the fake name). */
async function nameOf(pid: string): Promise<string> {
	const p = await pack();
	return fakeName(pid, p.player(pid)?.team);
}

export async function errorPlayers(req: MockRequest): Promise<ErrorPlayers> {
	const fp = checkFp(req.params.fp as string);
	const { window: w, filter } = parseRead(req);
	const limit = limitOf(req, ERROR_PLAYERS_MAX, ERROR_PLAYERS_MAX);
	const s = await stored();
	const k = s.world.byFp.get(fp);
	if (k === undefined || !s.kinds.has(k)) throw new HttpError(404, "no such error kind");
	const kind = s.world.kinds[k] as WorldKind;
	const days = dayRange(w);
	const idx = bucketIndex(w);
	const who = new Map<string, Agg>();
	const anon = new Map<string, { n: number; first: number; last: number }>();
	for (const o of s.occ) {
		if (o.k !== k || !matches(o, kind, filter)) continue;
		if (o.pid) {
			if (inDays(o, days)) add(who, o.pid, o, kind.realm);
		} else if (inMinutes(o, idx)) {
			const m = Math.floor(o.t / MINUTE);
			const a = anon.get(kind.realm) ?? { n: 0, first: m, last: m };
			a.n += o.n;
			a.first = Math.min(a.first, m);
			a.last = Math.max(a.last, m);
			anon.set(kind.realm, a);
		}
	}
	const rows = [...who.entries()].sort(byCount).slice(0, limit);
	const players = [];
	for (const [pid, a] of rows) {
		const name = await nameOf(pid);
		// Names are the demo's fake ones; UserIds are never mapped, so there is no uid (and no Roblox link).
		players.push({ pid, name, displayName: name, count: a.n, days: a.days.size, firstAt: iso(a.firstAt), lastAt: iso(a.lastAt), realms: sortedRealms(a.realms) });
	}
	return {
		fp,
		window: { from: iso(w.from), to: iso(w.to) },
		players,
		total: who.size,
		more: Math.max(0, who.size - rows.length),
		withoutPlayer: [...anon.entries()]
			.sort((a, b) => b[1].n - a[1].n)
			.map(([realm, a]) => ({ realm, count: a.n, firstAt: iso(a.first * MINUTE), lastAt: iso((a.last + 1) * MINUTE - 1) })),
	};
}

export async function playerErrors(req: MockRequest): Promise<PlayerErrors> {
	const pid = req.params.pid as string;
	if (!PID_PATTERN.test(pid)) throw new HttpError(400, "bad pid");
	const { window: w, filter } = parseRead(req);
	const limit = limitOf(req, PLAYER_ERRORS_MAX, PLAYER_ERRORS_MAX);
	const s = await stored();
	const days = dayRange(w);
	const kinds = new Map<string, Agg>();
	for (const o of s.occ) {
		if (o.pid !== pid || !inDays(o, days)) continue;
		const kind = s.world.kinds[o.k] as WorldKind;
		if (!matches(o, kind, filter)) continue;
		add(kinds, kind.fp, o, kind.realm);
	}
	const rows = [...kinds.entries()].sort(byCount).slice(0, limit);
	return {
		pid,
		window: { from: iso(w.from), to: iso(w.to) },
		errors: rows.map(([fp, a]) => {
			const k = s.world.byFp.get(fp) as number;
			const kind = s.world.kinds[k] as WorldKind;
			return { fp, template: kind.template, topFrame: topFrame(kind.stack), realms: sortedRealms(a.realms), count: a.n, days: a.days.size, firstAt: iso(a.firstAt), lastAt: iso(a.lastAt), total: s.kinds.get(k)?.total ?? a.n };
		}),
		total: kinds.size,
		more: Math.max(0, kinds.size - rows.length),
	};
}

export async function serverErrors(req: MockRequest): Promise<ServerErrors> {
	const job = req.params.job as string;
	if (!ERROR_JOB_PATTERN.test(job)) throw new HttpError(400, "bad JobId");
	const { window: w, filter } = parseRead(req);
	const limit = limitOf(req, SERVER_ERRORS_MAX, SERVER_ERRORS_MAX);
	const s = await stored();
	const kinds = new Map<string, Agg>();
	for (const o of s.occ) {
		if (o.job !== job || o.t < w.from || o.t >= w.to) continue;
		const kind = s.world.kinds[o.k] as WorldKind;
		if (!matches(o, kind, filter)) continue;
		add(kinds, kind.fp, o, kind.realm);
	}
	const rows = [...kinds.entries()].sort(byCount).slice(0, limit);
	return {
		job,
		window: { from: iso(w.from), to: iso(w.to) },
		errors: rows.map(([fp, a]) => {
			const k = s.world.byFp.get(fp) as number;
			const kind = s.world.kinds[k] as WorldKind;
			return { fp, template: kind.template, topFrame: topFrame(kind.stack), realms: sortedRealms(a.realms), count: a.n, firstAt: iso(a.firstAt), lastAt: iso(a.lastAt), total: s.kinds.get(k)?.total ?? a.n };
		}),
		total: kinds.size,
		more: Math.max(0, kinds.size - rows.length),
	};
}

export async function dropRulesView(): Promise<ErrorDropRules> {
	const s = await stored();
	const state = dropState.get();
	const rules = state.rules.map((rule) => {
		let error: string | undefined;
		try {
			compileDropExpr(rule.expr);
		} catch (e) {
			error = (e as Error).message;
		}
		return { ...rule, ...(error ? { error } : {}) };
	});
	return { rules, counts: s.drops, since: iso(serverStartedAt()), source: state.source };
}

export async function previewDropRule(req: MockRequest): Promise<DropPreview | Response> {
	if (req.text.length > 8 * 1024) return fail(413, "body too large");
	if (req.text && req.body === undefined) return fail(400, "body is not JSON");
	const body = (req.body ?? {}) as { expr?: unknown; days?: unknown };
	if (typeof body !== "object" || body === null || typeof body.expr !== "string") return fail(400, "expr is a string");
	const days = body.days === undefined ? 7 : body.days;
	if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 90) return fail(400, "days is 1 to 90");
	let test: (s: DropSubject) => boolean;
	try {
		test = compileDropExpr(body.expr).test;
	} catch (error) {
		if (error instanceof DropRuleError) return { ok: false, error: error.message };
		throw error;
	}
	const s = await stored();
	const since = now() - days * DAY_MS;
	const recent = new Map<number, number>();
	for (const o of s.occ) if (o.t >= since) recent.set(o.k, (recent.get(o.k) ?? 0) + o.n);
	const kinds = [...s.kinds.entries()]
		.sort((a, b) => b[1].lastAt - a[1].lastAt)
		.slice(0, 5000)
		.map(([k, info]) => ({ kind: s.world.kinds[k] as WorldKind, info, recent: recent.get(k) ?? 0 }));
	const matched = kinds.filter((x) => test({ message: x.kind.template, stack: x.kind.stack, realm: x.kind.realm, branch: x.info.branch || null, build: x.info.build || null, fp: x.kind.fp }));
	const sum = (list: typeof kinds) => list.reduce((n, x) => n + x.recent, 0);
	return {
		ok: true,
		days,
		kinds: kinds.length,
		matchedKinds: matched.length,
		matchedOccurrences: sum(matched),
		allOccurrences: sum(kinds),
		matches: matched.slice(0, 50).map((x) => ({ fp: x.kind.fp, template: x.kind.template, realm: x.kind.realm, lastAt: iso(x.info.lastAt), occurrences: x.recent })),
	};
}

// Routes ---------------------------------------------------------------------------------------------------------------

route<ErrorList>("GET", "/v1/errors", listErrors);
route<ErrorDropRules>("GET", "/v1/errors/drop-rules", dropRulesView);
route<DropPreview>("POST", "/v1/errors/drop-rules/preview", previewDropRule);
route<ErrorDetail>("GET", "/v1/errors/:fp", errorDetail);
route<ErrorPlayers>("GET", "/v1/errors/:fp/players", errorPlayers);
route<PlayerErrors>("GET", "/v1/players/:pid/errors", playerErrors);
route<ServerErrors>("GET", "/v1/servers/:job/errors", serverErrors);

/** How often the live stream looks for occurrences that passed "now". */
export const LIVE_TICK_MS = 15_000;

/** The `error` event for occurrences in (since, until]: { at, total, rejected, kinds: [{ fp, template, count, realm }] }. */
export async function errorEventBetween(since: number, until: number): Promise<{ at: number; total: number; rejected: number; kinds: { fp: string; template: string; count: number; realm: string }[] } | null> {
	const s = await stored();
	const kinds = new Map<number, number>();
	let total = 0;
	for (let i = s.occ.length - 1; i >= 0; i--) {
		const o = s.occ[i] as Occurrence;
		if (o.t <= since) break;
		if (o.t > until) continue;
		kinds.set(o.k, (kinds.get(o.k) ?? 0) + o.n);
		total += o.n;
	}
	if (!kinds.size) return null;
	return {
		at: until,
		total,
		rejected: 0,
		kinds: [...kinds.entries()].map(([k, count]) => {
			const kind = s.world.kinds[k] as WorldKind;
			return { fp: kind.fp, template: kind.template, count, realm: kind.realm };
		}),
	};
}

/** The event bus (src/server/live.ts): hello { at, topics }, then the topics asked for. The demo feeds `error`. */
stream("/v1/live", (req, sink) => {
	const topics = (req.query.get("topics") ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	sink.send("hello", { at: now(), topics });
	if (topics.length && !topics.includes("error")) return;
	let last = now();
	let busy = false;
	const timer = setInterval(() => {
		if (busy || !sink.open) return;
		busy = true;
		const until = now();
		errorEventBetween(last, until)
			.then((event) => {
				last = until;
				if (event && sink.open) sink.send("error", event);
			})
			.catch(() => undefined)
			.finally(() => (busy = false));
	}, LIVE_TICK_MS);
	return () => clearInterval(timer);
});
