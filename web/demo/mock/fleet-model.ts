/**
 * The demo fleet: what the backend's fleet store (src/fleet/service.ts) would hold for The Prison, derived from the data
 * pack so the Fleet, Server, Deploys and Performance pages line up with the analytics pages.
 *
 * - Servers are the pack's JobIds. The live ones are the jobs running "now" on the pack's shifted timeline; when fewer
 *   than three prod servers run, the most recent prod servers that had players keep running, and the newest dev server
 *   runs too (degraded: its last generation failed its check), so every page has something to show.
 * - Player counts, TPS and memory are smooth seeded functions of the JobId and the time (5-minute knots), peaking at the
 *   most players the pack's heartbeats reported, so the list, the server page and its charts agree at any moment.
 * - Deploys are the pack's artifact / seq sequence (195-224) with each server's real deploy reports; the seqs the sample
 *   has no server for are dev releases nobody booted. Seq 217 had one failed start (the lockdown doors), fixed by 219.
 * - Alerts, debug bundles and chart marks are seeded on the same timeline, in the game's own words.
 *
 * Nothing here holds a Roblox UserId: player names are fakeName(pid), ids fakeUserId(pid) (negative), addresses come
 * from the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
 */
import { deployRecord, DEPLOY_FAILED_RESULTS, DEPLOY_OK_RESULTS, type DeployRow, type DeploySummary } from "../../../src/fleet/deploys.ts";
import { healthReasons } from "../../../src/fleet/health.ts";
import type { DeployMark, MarkKind } from "@/lib/perf";
import type { DeployDetail, DeployNeighbor, DeployRecord } from "@/lib/deploys";
import type {
	BundleBody,
	BundleSummary,
	BundleSwap,
	DebugBundle,
	FleetAlert,
	FleetReports,
	FleetServer,
	FleetServerReport,
	GameColumn,
	GameColumnValue,
	GeoStatus,
	GoneServer,
	ServerBudget,
	ServerLocation,
} from "@/lib/types";
import { DAY_MS, PLACE_ID } from "./data";
import { pack, type Pack, type PackJob, type PackPlayer } from "./pack";
import { fakeName, fakeUserId, hashString, rng } from "./rng";

// The backend's constants (src/fleet/service.ts; copied: that module pulls in the store) --------------------------------

export const LOST_AFTER_MS = 90_000;
export const STUCK_WINDOW_MS = 30 * 60_000;
export const KEEP_METRICS_MS = 2 * 3_600_000;
export const ROLLUP_MS = 5 * 60_000;
export const METRICS_MAX_POINTS = 720;
export const HEARTBEAT_MS = 60_000;
export const DEPLOY_KINDS = ["deploy", "rollback", "promote", "resign"] as const;
export const MARK_ONLY_KINDS = ["kernel", "backup"] as const;
export const MARK_KINDS: readonly MarkKind[] = [...DEPLOY_KINDS, ...MARK_ONLY_KINDS];
export const DEPLOY_ALERTS_MAX = 50;
/** The place version every server of the pack's last days runs (the maps index's export names it). */
export const PLACE_VERSION = 10328;

// Small helpers ---------------------------------------------------------------------------------------------------------

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const smooth = (f: number) => f * f * (3 - 2 * f);

/** Seeded value noise: a value in [0, 1) per (key, knot), interpolated smoothly between knots `every` ms apart. */
export function noise(key: string, t: number, every: number): number {
	const k = Math.floor(t / every);
	const f = smooth((t - k * every) / every);
	const a = rng(`${key}:${k}`).next();
	const b = rng(`${key}:${k + 1}`).next();
	return a + (b - a) * f;
}

// Places a server can run in (Roblox's data centers; the address itself is from a documentation range) ------------------

// iata: game.ServerRegion's code for the data center (newer kernels send it; the backend maps it to the city).
const DATA_CENTERS: (Omit<ServerLocation, "asn" | "org"> & { iata: string; w: number })[] = [
	{ country: "US", countryName: "United States", region: "Virginia", city: "Ashburn", iata: "IAD", lat: 39.04, lon: -77.49, w: 6 },
	{ country: "US", countryName: "United States", region: "Texas", city: "Dallas", iata: "DFW", lat: 32.78, lon: -96.8, w: 4 },
	{ country: "US", countryName: "United States", region: "California", city: "Los Angeles", iata: "LAX", lat: 34.05, lon: -118.24, w: 4 },
	{ country: "US", countryName: "United States", region: "Illinois", city: "Chicago", iata: "ORD", lat: 41.88, lon: -87.63, w: 3 },
	{ country: "US", countryName: "United States", region: "Florida", city: "Miami", iata: "MIA", lat: 25.76, lon: -80.19, w: 2 },
	{ country: "DE", countryName: "Germany", region: "Hesse", city: "Frankfurt am Main", iata: "FRA", lat: 50.11, lon: 8.68, w: 4 },
	{ country: "NL", countryName: "Netherlands", region: "North Holland", city: "Amsterdam", iata: "AMS", lat: 52.37, lon: 4.9, w: 3 },
	{ country: "GB", countryName: "United Kingdom", region: "England", city: "London", iata: "LHR", lat: 51.51, lon: -0.13, w: 3 },
	{ country: "FR", countryName: "France", region: "Île-de-France", city: "Paris", iata: "CDG", lat: 48.86, lon: 2.35, w: 2 },
	{ country: "SG", countryName: "Singapore", region: "Singapore", city: "Singapore", iata: "SIN", lat: 1.29, lon: 103.85, w: 2 },
	{ country: "JP", countryName: "Japan", region: "Tokyo", city: "Tokyo", iata: "NRT", lat: 35.68, lon: 139.69, w: 1 },
	{ country: "AU", countryName: "Australia", region: "New South Wales", city: "Sydney", iata: "SYD", lat: -33.87, lon: 151.21, w: 1 },
	{ country: "BR", countryName: "Brazil", region: "São Paulo", city: "São Paulo", iata: "GRU", lat: -23.55, lon: -46.63, w: 1 },
	{ country: "IN", countryName: "India", region: "Maharashtra", city: "Mumbai", iata: "BOM", lat: 19.08, lon: 72.88, w: 1 },
];

const DOC_RANGES = ["192.0.2", "198.51.100", "203.0.113"];

export const GEO_STATUS: GeoStatus = { state: "ready", source: "DB-IP Lite (demo copy)", attribution: "IP geolocation by DB-IP (demo data)", attributionUrl: null, built: "2026-11-01T00:00:00.000Z" };

function locationOf(job: string): { ip: string; firstIp: string; ipChangedAt: number | null; location: ServerLocation; region: string | null; geoSource: "roblox" | "ip" } {
	const r = rng(`fleet:geo:${job}`);
	const dc = r.weighted(DATA_CENTERS.map((d) => [d, d.w] as const));
	const range = r.pick(DOC_RANGES);
	const ip = `${range}.${r.int(2, 254)}`;
	const moved = r.chance(0.04);
	const { w: _w, iata, ...place } = dc;
	const firstIp = moved ? `${r.pick(DOC_RANGES)}.${r.int(2, 254)}` : ip;
	// Most servers run a kernel that sends the Roblox region; the rest are located by their address.
	const region = r.chance(0.85) ? iata : null;
	return { ip, firstIp, ipChangedAt: null, location: { ...place, asn: 22697, org: "Roblox" }, region, geoSource: region ? "roblox" : "ip" };
}

// The game's own columns (plans/34): game state only, never player names or ids --------------------------------------

export const GAME_COLUMNS: GameColumn[] = [
	{ n: "inmates", l: "Inmates", t: "number" },
	{ n: "guards", l: "Guards", t: "number" },
	{ n: "medics", l: "Medics", t: "number" },
	{ n: "escapes", l: "Escapes", t: "number" },
	{ n: "arrests", l: "Arrests", t: "number" },
	{ n: "lockdown", l: "Lockdown", t: "bool" },
	{ n: "phase", l: "Day phase", t: "string" },
];

// Model -------------------------------------------------------------------------------------------------------------------

export interface Model {
	p: Pack;
	at: number;
	/** Live servers, newest heartbeat first (the backend's order). */
	live: PackJob[];
	liveSet: Set<string>;
	/** Jobs that kept running past the pack (see the file comment). */
	extended: Set<string>;
	/** Not live, the most recently gone first. */
	gone: PackJob[];
	/** Gone servers that never said goodbye (lost), with when the sweep noticed. */
	lost: Map<string, number>;
	/** The dev server whose generation failed its check. */
	degraded: string | null;
	deploys: DeployInfo[];
	bySeq: Map<number, DeployInfo>;
	reportsByJob: Map<string, ReportRow[]>;
	alerts: FleetAlert[];
	bundles: StoredBundle[];
}

export interface ReportRow extends FleetServerReport {
	generation: number | null;
	kernel: string | null;
	players: number | null;
}

export interface DeployInfo {
	seq: number;
	branch: string;
	artifact: string;
	channel: string;
	kind: string;
	from: string | null;
	message: string | null;
	at: number;
	reports: ReportRow[];
}

export interface StoredBundle extends BundleSummary {
	body: BundleBody;
}

let cached: { key: string; model: Model } | undefined;

/** The fleet as it is now (rebuilt when the pack's minute changes). */
export async function model(): Promise<Model> {
	const p = await pack();
	const key = `${p.now}:${p.shiftMs}`;
	if (cached?.key === key) return cached.model;
	const m = build(p);
	cached = { key, model: m };
	return m;
}

export function resetFleetModel(): void {
	cached = undefined;
	poolCache.clear();
}

function build(p: Pack): Model {
	const at = p.now;
	const live = p.jobs.filter((j) => j.live);
	const extended = new Set<string>();
	const prodLive = live.filter((j) => j.branch === "prod").length;
	if (prodLive < 3) {
		const recent = p.jobs
			.filter((j) => !j.live && j.branch === "prod" && j.srv === "public" && (j.maxPlayers ?? 0) >= 4 && at - j.lastAt < 6 * 3_600_000)
			.sort((a, b) => b.lastAt - a.lastAt)
			.slice(0, 3 - prodLive);
		for (const j of recent) {
			live.push(j);
			extended.add(j.job);
		}
	}
	let degraded: string | null = null;
	if (!live.some((j) => j.branch === "dev")) {
		const dev = p.jobs.filter((j) => j.branch === "dev").sort((a, b) => b.firstAt - a.firstAt)[0];
		if (dev) {
			live.push(dev);
			extended.add(dev.job);
			degraded = dev.job;
		}
	}
	const liveSet = new Set(live.map((j) => j.job));
	live.sort((a, b) => lastSeenOf(b, at, true) - lastSeenOf(a, at, true) || a.job.localeCompare(b.job));
	const gone = p.jobs.filter((j) => !liveSet.has(j.job)).sort((a, b) => b.lastAt - a.lastAt);
	const lost = new Map<string, number>();
	for (const j of gone) {
		// About one in 25 servers with players dies without a closing message (a Roblox host going away).
		if ((j.maxPlayers ?? 0) > 0 && j.lastAt - j.firstAt > 20 * 60_000 && hashString(`fleet:lost:${j.job}`) % 25 === 0) lost.set(j.job, j.lastAt + LOST_AFTER_MS + (hashString(j.job) % 30_000));
	}
	const { deploys, reportsByJob, failedJob } = buildDeploys(p);
	const bySeq = new Map(deploys.map((d) => [d.seq, d]));
	const m: Model = { p, at, live, liveSet, extended, gone, lost, degraded, deploys, bySeq, reportsByJob, alerts: [], bundles: [] };
	buildAlertsAndBundles(m, failedJob);
	return m;
}

// Servers -----------------------------------------------------------------------------------------------------------------

const startOf = (j: PackJob) => j.startedAt ?? j.firstAt;

/** The last heartbeat: every 60 s from a per-server phase (live), or the pack's last row. */
export function lastSeenOf(j: PackJob, at: number, live: boolean): number {
	if (!live) return j.lastAt;
	const phase = hashString(`fleet:hb:${j.job}`) % HEARTBEAT_MS;
	return Math.max(startOf(j), Math.floor((at - phase) / HEARTBEAT_MS) * HEARTBEAT_MS + phase);
}

/** Players on a server at `t`: up to the most a heartbeat reported, ramping up after the start, drifting every 5 minutes. */
export function playersAt(j: PackJob, t: number): number {
	const peak = j.maxPlayers ?? 0;
	if (peak <= 0) return 0;
	const start = startOf(j);
	if (t < start) return 0;
	const ramp = clamp((t - start) / (8 * 60_000), 0.15, 1);
	const v = 0.62 + 0.38 * noise(`fleet:players:${j.job}`, t, ROLLUP_MS);
	return clamp(Math.round(peak * v * ramp), peak > 1 ? 1 : 0, j.maxSlots ?? 35);
}

export interface Reading {
	t: number;
	players: number;
	tps: number;
	tpsMin: number;
	physFps: number;
	memMb: number;
	luaMb: number;
}

/** A heartbeat's readings at `t` (deterministic per server and minute). */
export function readingAt(j: PackJob, t: number, degraded = false): Reading {
	const players = playersAt(j, t);
	const minute = Math.floor(t / 60_000);
	const r = rng(`fleet:reading:${j.job}:${minute}`);
	const base = rng(`fleet:base:${j.job}`);
	const upHours = Math.max(0, (t - startOf(j)) / 3_600_000);
	const dip = r.chance(0.025) ? r.float(4, 11) : 0;
	const tps = clamp(60 - Math.abs(r.normal(0, 0.18)) - players * 0.012 - dip, 30, 60);
	const tpsMin = clamp(tps - r.float(1.5, 6) - players * 0.08 - dip * 0.6, 20, tps);
	const physFps = clamp(60 - Math.abs(r.normal(0, 0.12)) - dip * 0.4, 30, 60);
	const memMb = base.int(1650, 2050) + players * 27 + Math.min(upHours, 30) * 21 + (degraded ? 260 : 0) + r.normal(0, 14);
	const luaMb = base.int(160, 230) + players * 8.5 + Math.min(upHours, 30) * 3 + r.normal(0, 4);
	return { t, players, tps: round1(tps), tpsMin: round1(tpsMin), physFps: round1(physFps), memMb: Math.round(memMb), luaMb: round1(luaMb) };
}

const TEAM_SHARE = { guards: 0.27, medics: 0.1 };

/** The game's column values at `t`. */
export function columnValuesAt(j: PackJob, t: number, players: number): Record<string, GameColumnValue> {
	const guards = Math.round(players * TEAM_SHARE.guards);
	const medics = players >= 6 ? Math.max(1, Math.round(players * TEAM_SHARE.medics)) : 0;
	const upMin = Math.max(0, (t - startOf(j)) / 60_000);
	const escapes = Math.floor(upMin * (players / 22) * 0.09 + noise(`fleet:esc:${j.job}`, t, 600_000) * 2);
	const arrests = Math.floor(upMin * (players / 22) * 0.16 + noise(`fleet:arr:${j.job}`, t, 600_000) * 3);
	const lockdown = players >= 8 && rng(`fleet:lockdown:${j.job}:${Math.floor(t / 600_000)}`).chance(0.12);
	// A day in the prison is 24 minutes: morning count, work, yard, dinner, lights out.
	const phases = ["roll call", "work shift", "yard time", "dinner", "lights out"];
	const phase = phases[Math.floor(((t / 60_000) % 24) / (24 / phases.length))] as string;
	return { inmates: players - guards - medics, guards, medics, escapes, arrests, lockdown, phase };
}

function budgetOf(j: PackJob, reading: Reading): ServerBudget {
	const r = rng(`fleet:budget:${j.job}:${Math.floor(reading.t / 60_000)}`);
	const n = reading.players;
	const dsLimit = 60 + n * 10;
	return {
		p: n,
		ds: { r: r.int(n * 2, n * 4 + 4), w: r.int(n, n * 2 + 3), l: r.int(0, 2), x: 0, lr: dsLimit, lw: dsLimit, br: r.int(dsLimit * 2, dsLimit * 4), bw: r.int(dsLimit * 2, dsLimit * 4) },
		ms: { u: r.int(n * 3, n * 6 + 10), l: 1000 + 100 * n },
		h: { r: r.int(2, 9), l: 500 },
		mg: { p: r.int(1, 6), lp: 150 + 60 * n, s: 2, ls: 20 + 8 * n },
		by: { k: r.int(1, 4), d: r.int(n, n * 3 + 2), a: r.int(2, 8), g: r.int(n, n * 2 + 2) },
		mem: { t: reading.memMb, h: reading.luaMb },
	};
}

const DEGRADED_ERROR = "Generation 3 failed its check: ServerScriptService.Prison.WardenOffice:41: attempt to index nil with 'Keycard'";

/** One server as the fleet API answers it (`ips`: owners see addresses). */
export function serverInfo(m: Model, j: PackJob, ips = true): FleetServer {
	const live = m.liveSet.has(j.job);
	const lastSeen = lastSeenOf(j, m.at, live);
	const reading = readingAt(j, live ? lastSeen : j.lastAt, j.job === m.degraded);
	const players = live ? reading.players : 0;
	const health = j.job === m.degraded ? "degraded" : "ok";
	const reports = m.reportsByJob.get(j.job) ?? [];
	const generation = reports.reduce((g, r) => Math.max(g, r.generation ?? 0), 0) || 1;
	const geo = locationOf(j.job);
	const closed = !live && !m.lost.has(j.job);
	return {
		job: j.job,
		serverType: j.srv,
		lastSeen: new Date(lastSeen).toISOString(),
		ageSeconds: Math.max(0, Math.round((m.at - lastSeen) / 1000)),
		branch: j.branch,
		channel: j.channel,
		artifact: j.art,
		players,
		maxPlayers: j.maxSlots ?? 35,
		startedAt: iso(startOf(j)),
		lastWrite: iso(lastSeen - (hashString(`fleet:write:${j.job}`) % 20_000)),
		placeId: j.place ?? PLACE_ID,
		placeVersion: placeVersionOf(m, j),
		experiment: false,
		kernel: j.kernel,
		appliedSeq: j.seq,
		generation: j.job === m.degraded ? 3 : generation,
		health,
		lastError: j.job === m.degraded ? DEGRADED_ERROR : null,
		serverVersion: null,
		budget: budgetOf(j, reading),
		tps: reading.tps,
		tpsMin: reading.tpsMin,
		physFps: reading.physFps,
		memMb: reading.memMb,
		luaMb: reading.luaMb,
		reasons: healthReasons({ health, tps: reading.tps, memMb: reading.memMb, lastSeen, closed }, m.at),
		...(ips ? { ip: geo.ip, firstIp: geo.firstIp } : {}),
		ipChangedAt: geo.firstIp !== geo.ip ? iso(startOf(j) + 41 * 60_000) : null,
		location: geo.location,
		region: geo.region,
		geoSource: geo.geoSource,
		cv: columnValuesAt(j, live ? lastSeen : j.lastAt, players),
	};
}

/** The place version a server ran: today's export for the pack's last days, one less before (a publish a week in). */
export function placeVersionOf(m: Model, j: PackJob): number {
	return startOf(j) >= m.p.from + 6 * DAY_MS ? PLACE_VERSION : PLACE_VERSION - 1;
}

export function goneServer(m: Model, j: PackJob, ips = true): GoneServer {
	const lostAt = m.lost.get(j.job);
	const closedAt = lostAt === undefined ? j.lastAt + 1_000 + (hashString(`fleet:close:${j.job}`) % 4_000) : null;
	return {
		...serverInfo(m, j, ips),
		closedAt: iso(closedAt),
		lostAt: iso(lostAt ?? null),
		state: lostAt === undefined ? "closed" : "lost",
		firstSeen: new Date(j.firstAt).toISOString(),
	};
}

// Who is on a server ------------------------------------------------------------------------------------------------------

export interface Occupant {
	pid: string;
	/** A UserId that can't be a real account (negative). */
	userId: number;
	name: string;
	team: "inmate" | "guard" | "medic" | "warden";
	/** When they joined this server (ms). */
	joinedAt: number;
	player: PackPlayer | undefined;
}

const poolCache = new Map<string, PackPlayer[]>();

/** The pack's players who were playing while this server ran (their pids give the names). */
function poolFor(p: Pack, j: PackJob): PackPlayer[] {
	let pool = poolCache.get(j.job);
	if (!pool) {
		pool = p.players.filter((x) => x.firstAt <= j.lastAt && x.lastAt >= j.firstAt - 3_600_000);
		if (pool.length < 40) pool = p.players.filter((x) => x.lastAt >= j.firstAt - 2 * DAY_MS).slice(0, 400);
		poolCache.set(j.job, pool);
	}
	return pool;
}

const normalTeam = (team: string | null | undefined): Occupant["team"] | undefined => {
	const t = (team ?? "").toLowerCase();
	return t === "inmate" || t === "guard" || t === "medic" || t === "warden" ? t : undefined;
};

/** The players on a server at `t`: one per slot, each slot changing hands every 15-40 minutes. */
export function occupantsAt(m: Model, j: PackJob, t: number): Occupant[] {
	const n = playersAt(j, t);
	const pool = poolFor(m.p, j);
	const out: Occupant[] = [];
	const used = new Set<string>();
	for (let slot = 0; slot < n; slot++) {
		const s = rng(`fleet:slot:${j.job}:${slot}`);
		const stay = s.int(15, 40) * 60_000;
		const offset = s.int(0, stay);
		const epoch = Math.floor((t + offset) / stay);
		const r = rng(`fleet:slot:${j.job}:${slot}:${epoch}`);
		let player: PackPlayer | undefined;
		for (let tries = 0; tries < 4 && pool.length; tries++) {
			const c = r.pick(pool);
			if (!used.has(c.pid)) {
				player = c;
				break;
			}
		}
		const pid = player?.pid ?? r.hex(32);
		used.add(pid);
		const guards = Math.round(n * TEAM_SHARE.guards);
		const medics = n >= 6 ? Math.max(1, Math.round(n * TEAM_SHARE.medics)) : 0;
		const team: Occupant["team"] = slot === 0 && n >= 10 ? "warden" : slot < guards ? "guard" : slot < guards + medics ? "medic" : (normalTeam(player?.team) === "guard" ? "inmate" : "inmate");
		const joinedAt = Math.max(startOf(j), epoch * stay - offset);
		out.push({ pid, userId: fakeUserId(pid), name: fakeName(pid, team === "warden" || team === "medic" ? "guard" : team), team, joinedAt, player });
	}
	return out;
}

// Deploys -----------------------------------------------------------------------------------------------------------------

/** What each release said (the CLI's -m), in the game's words; seqs not listed get a generic line. */
const MESSAGES: Record<number, string> = {
	195: "Guard salary every 10 min (was 15), cafeteria stew heals 25",
	196: "wip: sewer escape route colliders",
	197: "wip: trash bin search cooldown",
	198: "wip: trash bin search cooldown (2)",
	199: "dev: spin wheel odds table",
	200: "dev: janitor job pays per spill",
	201: "dev: lockpick break chance 15%",
	202: "dev: lockpick break chance 20%",
	203: "dev: taser stun 2.5 s",
	204: "dev: taser stun 2 s, cooldown 3 s",
	205: "dev: medic heal reward",
	206: "dev: medic heal reward (cash 40)",
	207: "dev: arrest bounty for guards",
	208: "dev: arrest bounty 75 cash",
	209: "dev: quest board refresh",
	210: "Quest board: daily quests reset at 00:00 UTC",
	211: "wip: faint spray restock timer",
	212: "Spin wheel: one free spin a day, odds in the shop",
	213: "Tutorial v4 for new inmates; one-tap play test",
	214: "Medic heal reward, bandages stack to 3",
	215: "Medic heal reward, bandages stack to 3",
	216: "wip: lockdown doors on riot",
	217: "Lockdown: cell block doors close during a riot",
	218: "wip: lockdown doors cold start",
	219: "Fix lockdown doors nil on a cold start",
	220: "wip: escape quest counts sewer exits",
	221: "wip: trash search cooldown 20 s",
	222: "Escape quest counts sewer exits; trash search cooldown 20 s",
	223: "wip: warden office keycard",
	224: "Shop: molotov 450 -> 600 cash, faint spray restocks every 10 min",
};

const FAILED_217 = "start_failed: ServerScriptService.Prison.Lockdown:88: attempt to index nil with 'Doors'";

function parseProps(props: string): Record<string, unknown> {
	try {
		const v = JSON.parse(props) as unknown;
		return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const numOr = (v: unknown, d: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function buildDeploys(p: Pack): { deploys: DeployInfo[]; reportsByJob: Map<string, ReportRow[]>; failedJob: string | null } {
	const reports = new Map<number, ReportRow[]>();
	for (const r of p.deployReports) {
		const props = parseProps(r.props);
		const row: ReportRow = {
			seq: r.seq,
			branch: r.branch,
			artifact: r.art,
			job: r.job,
			result: typeof props.r === "string" ? props.r : "booted",
			error: null,
			seconds: numOr(props.d, null),
			at: r.t,
			generation: numOr(props.g, null),
			kernel: typeof props.k === "string" ? props.k : null,
			players: numOr(props.p, null),
		};
		reports.set(r.seq, [...(reports.get(r.seq) ?? []), row]);
	}
	// Seq 217's smallest server failed to start the new generation (the story the deploy page tells; 219 fixes it).
	let failedJob: string | null = null;
	const r217 = reports.get(217);
	if (r217?.length) {
		const sizes = new Map(p.jobs.map((j) => [j.job, j.rows]));
		const victim = [...r217].sort((a, b) => (sizes.get(a.job) ?? 0) - (sizes.get(b.job) ?? 0))[0] as ReportRow;
		victim.result = "failed";
		victim.error = FAILED_217;
		victim.seconds = 4.8;
		failedJob = victim.job;
	}
	const arts = p.artifacts.filter((a) => (a.seq ?? 0) > 0);
	const known = new Map<number, (typeof arts)[number]>();
	for (const a of arts) if (!known.has(a.seq as number) || (known.get(a.seq as number) as (typeof arts)[number]).jobs < a.jobs) known.set(a.seq as number, a);
	if (!known.size) return { deploys: [], reportsByJob: new Map(), failedJob };
	const seqs = [...known.keys()].sort((a, b) => a - b);
	const lo = seqs[0] as number;
	const hi = seqs[seqs.length - 1] as number;
	const out: DeployInfo[] = [];
	for (let seq = lo; seq <= hi; seq++) {
		const a = known.get(seq);
		const rs = (reports.get(seq) ?? []).sort((x, y) => x.at - y.at);
		if (a) {
			const r = rng(`fleet:deploy:${seq}`);
			const first = Math.min(a.firstAt, rs[0]?.at ?? a.firstAt);
			// The pack's first release was out before the window starts.
			const at = seq === lo && a.firstAt <= p.from + 60_000 ? p.from - 36 * 3_600_000 : first - r.int(15_000, 75_000);
			out.push({ seq, branch: a.branch ?? "prod", artifact: a.art, channel: a.branch ?? "prod", kind: "deploy", from: null, message: MESSAGES[seq] ?? null, at, reports: rs });
		} else {
			// A dev release no server of the sample booted.
			const r = rng(`fleet:deploy:${seq}`);
			out.push({ seq, branch: "dev", artifact: `${r.hex(7)}-${r.hex(6)}`, channel: "dev", kind: "deploy", from: null, message: MESSAGES[seq] ?? null, at: 0, reports: [] });
		}
	}
	// Times: seqs only grow, so each release is before the next one; the gaps sit between their neighbours.
	for (let i = out.length - 2; i >= 0; i--) {
		const d = out[i] as DeployInfo;
		const next = out[i + 1] as DeployInfo;
		if (d.at === 0) continue;
		const nextAt = next.at || Number.POSITIVE_INFINITY;
		if (d.at >= nextAt) d.at = nextAt - 90_000;
	}
	for (let i = 0; i < out.length; i++) {
		const d = out[i] as DeployInfo;
		if (d.at !== 0) continue;
		const prev = out.slice(0, i).reverse().find((x) => x.at !== 0);
		const next = out.slice(i + 1).find((x) => x.at !== 0);
		const a = prev?.at ?? (next ? next.at - 3_600_000 : p.from);
		const b = next?.at ?? a + 3_600_000;
		d.at = Math.round(a + (b - a) * rng(`fleet:gap:${d.seq}`).float(0.3, 0.7));
	}
	// A prod release of a commit that was on dev first is a promote.
	for (const d of out) {
		if (d.branch !== "prod") continue;
		const commit = d.artifact.slice(0, 7);
		const dev = out.filter((x) => x.branch === "dev" && x.seq < d.seq && x.artifact.startsWith(commit)).pop();
		if (dev) {
			d.kind = "promote";
			d.from = dev.artifact;
		}
	}
	const now = p.now;
	const visible = out.filter((d) => d.at <= now);
	const reportsByJob = new Map<string, ReportRow[]>();
	for (const d of visible) for (const r of d.reports) if (r.at <= now) reportsByJob.set(r.job, [...(reportsByJob.get(r.job) ?? []), r]);
	return { deploys: visible.map((d) => ({ ...d, reports: d.reports.filter((r) => r.at <= now) })), reportsByJob, failedJob };
}

/** Each server's newest report of a release. */
function latestReports(d: DeployInfo): ReportRow[] {
	const byJob = new Map<string, ReportRow>();
	for (const r of d.reports) {
		const held = byJob.get(r.job);
		if (!held || held.at <= r.at) byJob.set(r.job, r);
	}
	return [...byJob.values()];
}

function summaryOf(d: DeployInfo): DeploySummary {
	const latest = latestReports(d);
	const results: Record<string, number> = {};
	const errors = new Map<string, number>();
	let ok = 0;
	let failed = 0;
	for (const r of latest) {
		results[r.result] = (results[r.result] ?? 0) + 1;
		if (DEPLOY_OK_RESULTS.includes(r.result)) ok++;
		if (DEPLOY_FAILED_RESULTS.includes(r.result)) failed++;
		if (r.error) errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
	}
	const times = d.reports.map((r) => r.at);
	return {
		reported: latest.length,
		ok,
		failed,
		stuck: 0,
		results,
		errors: [...errors].map(([error, servers]) => ({ error, servers })).sort((a, b) => b.servers - a.servers),
		errorKinds: errors.size,
		firstReport: times.length ? Math.min(...times) : null,
		lastReport: times.length ? Math.max(...times) : null,
	};
}

export function deployRecordOf(m: Model, d: DeployInfo): DeployRecord {
	const row: DeployRow = {
		seq: d.seq,
		branch: d.branch,
		artifact: d.artifact,
		channel: d.channel,
		t: d.at,
		received: d.at,
		kind: d.kind,
		from_artifact: d.from,
		message: d.message,
		started_by: DEMO_STARTED_BY,
		summary_at: null,
		reported: null,
		ok: null,
		failed: null,
		stuck: null,
		results: null,
		errors: null,
		error_kinds: null,
		first_report: null,
		last_report: null,
	};
	return deployRecord(row, summaryOf(d), m.at, STUCK_WINDOW_MS) as DeployRecord;
}

/** Who started the releases (the CLI posts the owner's name). */
export const DEMO_STARTED_BY = "demo_owner (CLI)";

/** GET /v1/fleet/reports: one release's reports, servers still behind it, and the per-result counts. */
export function fleetReports(m: Model, options: { seq?: number; artifact?: string; branch?: string }, ips = true): FleetReports {
	let seq: number | null = options.seq ?? null;
	if (seq === null && options.artifact) seq = m.deploys.filter((d) => d.artifact === options.artifact).reduce<number | null>((s, d) => Math.max(s ?? 0, d.seq), null);
	if (seq === null) seq = m.deploys.filter((d) => !options.branch || d.branch === options.branch).reduce<number | null>((s, d) => Math.max(s ?? 0, d.seq), null);
	const empty: FleetReports = { seq, branch: options.branch ?? null, artifact: null, startedAt: null, firstReport: null, lastReport: null, reported: 0, results: [], errors: [], behind: [], stuck: [], reports: [] };
	if (seq === null) return empty;
	const d = m.bySeq.get(seq);
	if (!d) return empty;
	const latest = latestReports(d);
	const groups = new Map<string, { servers: number; players: number; seconds: number[] }>();
	const errors = new Map<string, { servers: number; exampleJob: string }>();
	for (const r of latest) {
		const g = groups.get(r.result) ?? { servers: 0, players: 0, seconds: [] };
		g.servers++;
		g.players += r.players ?? 0;
		if (r.seconds !== null) g.seconds.push(r.seconds);
		groups.set(r.result, g);
		if (r.error) {
			const e = errors.get(r.error) ?? { servers: 0, exampleJob: r.job };
			e.servers++;
			errors.set(r.error, e);
		}
	}
	const order = ["swapped", "failed", "rolled_back", "skipped", "booted"];
	const median = (v: number[]) => {
		if (!v.length) return null;
		const s = [...v].sort((a, b) => a - b);
		const mid = s.length >> 1;
		return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
	};
	const branch = options.branch ?? d.branch;
	const behind = m.live.filter((j) => (!branch || j.branch === branch) && (j.seq === null || j.seq < (seq as number))).sort((a, b) => a.job.localeCompare(b.job));
	const times = latest.map((r) => r.at);
	return {
		seq,
		branch,
		artifact: d.artifact,
		startedAt: iso(d.at),
		firstReport: times.length ? iso(Math.min(...times)) : null,
		lastReport: times.length ? iso(Math.max(...times)) : null,
		reported: latest.length,
		results: [...groups]
			.map(([result, g]) => ({ result, servers: g.servers, players: g.players, medianSeconds: median(g.seconds) === null ? null : round1(median(g.seconds) as number), maxSeconds: g.seconds.length ? round1(Math.max(...g.seconds)) : null }))
			.sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result)),
		errors: [...errors].map(([error, e]) => ({ error, ...e })).sort((a, b) => b.servers - a.servers),
		behind: behind.map((j) => serverInfo(m, j, ips)),
		stuck: [],
		reports: d.reports.map((r) => ({ seq: r.seq, branch: r.branch, artifact: r.artifact, job: r.job, result: r.result, error: r.error, seconds: r.seconds, at: r.at, generation: r.generation, kernel: r.kernel, players: r.players })),
	};
}

export function deployDetail(m: Model, seq: number, alerts: FleetAlert[]): DeployDetail | undefined {
	const d = m.bySeq.get(seq);
	if (!d) return undefined;
	const neighbor = (x: DeployInfo | undefined): DeployNeighbor | null => (x ? { seq: x.seq, kind: x.kind, artifact: x.artifact, at: x.at } : null);
	const same = m.deploys.filter((x) => x.branch === d.branch);
	return {
		deploy: deployRecordOf(m, d),
		report: fleetReports(m, { seq }),
		alerts: alerts.filter((a) => a.seq === seq).sort((a, b) => b.id - a.id).slice(0, DEPLOY_ALERTS_MAX),
		previous: neighbor(same.filter((x) => x.seq < seq).pop()),
		next: neighbor(same.find((x) => x.seq > seq)),
	};
}

// Marks -------------------------------------------------------------------------------------------------------------------

export function marks(m: Model, options: { since: number; until: number; branch?: string; kinds?: Set<string> }): DeployMark[] {
	const want = (k: string) => !options.kinds || options.kinds.has(k);
	const out: DeployMark[] = [];
	for (const d of m.deploys) {
		if (d.at < options.since || d.at >= options.until || !want(d.kind)) continue;
		if (options.branch && d.branch !== options.branch) continue;
		out.push({ id: `deploy:${d.seq}`, kind: d.kind as MarkKind, at: d.at, time: new Date(d.at).toISOString(), branch: d.branch, seq: d.seq, artifact: d.artifact, channel: d.channel, from: d.from, kernel: null, placeVersion: null, message: d.message, results: summaryOf(d).results });
	}
	// The kernel publish: the first server that ran 0.5.5.
	if (want("kernel")) {
		const first = m.p.jobs.find((j) => j.kernel === "0.5.5");
		if (first) {
			const at = first.firstAt - 4 * 60_000;
			if (at >= options.since && at < options.until) out.push({ id: "mark:1", kind: "kernel", at, time: new Date(at).toISOString(), branch: null, seq: null, artifact: null, channel: null, from: null, kernel: "0.5.5", placeVersion: PLACE_VERSION - 1, message: "Kernel 0.5.5 published (remote debug: game columns, streams)" });
		}
	}
	// The backup place, refreshed every night at 04:00 UTC.
	if (want("backup")) {
		for (let day = Math.floor(Math.max(options.since, m.p.from) / DAY_MS); day * DAY_MS < Math.min(options.until, m.at); day++) {
			const at = day * DAY_MS + 4 * 3_600_000 + (hashString(`fleet:backup:${day}`) % 600_000);
			if (at < options.since || at >= options.until || at > m.at) continue;
			out.push({ id: `mark:${100 + day - Math.floor(m.p.from / DAY_MS)}`, kind: "backup", at, time: new Date(at).toISOString(), branch: null, seq: null, artifact: null, channel: null, from: null, kernel: null, placeVersion: at >= m.p.from + 6 * DAY_MS ? PLACE_VERSION : PLACE_VERSION - 1, message: "Backup place refreshed" });
		}
	}
	return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id, "en", { numeric: true }));
}

// Alerts and debug bundles ------------------------------------------------------------------------------------------------

interface AlertSeed {
	at: number;
	level: FleetAlert["level"];
	code: string;
	message: string;
	job: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	source: FleetAlert["source"];
	details: Record<string, unknown> | null;
	kernel: string | null;
	bundle?: { code: string; stage?: string; error?: string; closing?: boolean };
}

/** The game's own alerts (its alert API), what a busy prison sends now and then. */
const GAME_ALERTS: { code: string; level: FleetAlert["level"]; w: number; text: (r: ReturnType<typeof rng>, p: Pack) => { message: string; details: Record<string, unknown> } }[] = [
	{
		code: "datastore_errors",
		level: "warning",
		w: 3,
		text: (r) => {
			const n = r.int(3, 9);
			return { message: `DataStore UpdateAsync failed ${n} times in a minute (players__prod): InternalServerError; inventories retried`, details: { store: "players__prod", api: "UpdateAsync", failures: n } };
		},
	},
	{
		code: "memorystore_errors",
		level: "warning",
		w: 2,
		text: (r) => ({ message: "MemoryStore SortedMap.Get failed (RestartSessions): Internal Error; restart sessions fell back to the DataStore", details: { structure: "RestartSessions", failures: r.int(2, 6) } }),
	},
	{
		code: "escape_wave",
		level: "info",
		w: 3,
		text: (r) => {
			const n = r.int(7, 14);
			return { message: `${n} inmates escaped in 10 minutes through the sewer exit (usual: 3)`, details: { escapes: n, route: "sewer", windowMinutes: 10 } };
		},
	},
	{
		code: "economy_spike",
		level: "info",
		w: 2,
		text: (r, p) => {
			const job = r.pick(p.vocabulary.props.job ?? [{ value: "janitor", n: 1 }]).value;
			const x = r.float(2.4, 3.6).toFixed(1);
			return { message: `Cash income ${x}x the hourly norm on this server (job_done: ${job})`, details: { source: "job_done", job, factor: Number(x) } };
		},
	},
	{
		code: "teleport_failed",
		level: "warning",
		w: 1,
		text: () => ({ message: "Teleport to a reserved server failed: HTTP 400 (Bad Request); 3 players stayed in the prison", details: { players: 3, status: 400 } }),
	},
	{
		code: "riot_lockdown",
		level: "info",
		w: 2,
		text: (r) => {
			const block = r.pick(["A", "B", "C"]);
			const arrests = r.int(4, 11);
			return { message: `Riot in cell block ${block}: lockdown for ${r.int(2, 5)} minutes, ${arrests} arrests`, details: { block, arrests } };
		},
	},
];

/** A 32-hex bundle id. */
const bundleId = (seed: string) => rng(`fleet:bundle:${seed}`).hex(32);

function activeJobAt(p: Pack, t: number, r: ReturnType<typeof rng>): PackJob | undefined {
	const running = p.jobs.filter((j) => j.firstAt <= t && j.lastAt >= t && (j.maxPlayers ?? 0) >= 4);
	return running.length ? r.pick(running) : undefined;
}

function buildAlertsAndBundles(m: Model, failedJob: string | null): void {
	const p = m.p;
	const seeds: AlertSeed[] = [];
	// server_lost: the backend's sweep, one per lost server.
	for (const [job, lostAt] of m.lost) {
		const j = p.job(job) as PackJob;
		if (lostAt > m.at) continue;
		seeds.push({ at: lostAt, level: "warning", code: "server_lost", message: `1 server on ${j.branch ?? "?"} stopped sending heartbeats for 90 s without closing`, job, branch: j.branch, artifact: j.art, seq: null, source: "server", details: { jobs: [job], count: 1 }, kernel: null });
	}
	// Seq 217: the failed start, a critical alert and the bundle that follows it.
	if (failedJob) {
		const d = m.bySeq.get(217);
		const report = d?.reports.find((r) => r.job === failedJob);
		const j = p.job(failedJob);
		if (d && report && j) {
			seeds.push({
				at: report.at + 800,
				level: "critical",
				code: "deploy_failed",
				message: `Generation ${d.artifact}#2 failed to start on seq 217: ServerScriptService.Prison.Lockdown:88: attempt to index nil with 'Doors'`,
				job: failedJob,
				branch: d.branch,
				artifact: d.artifact,
				seq: 217,
				source: "game",
				details: { stage: "start", error: "ServerScriptService.Prison.Lockdown:88: attempt to index nil with 'Doors'", attempts: 1, reason: "deploy", kind: "swap", loadSeconds: 1.9, swapSeconds: 2.9, transient: false, rollbackTo: j.art ?? "" },
				kernel: j.kernel,
				bundle: { code: "start_failed", stage: "start", error: "ServerScriptService.Prison.Lockdown:88: attempt to index nil with 'Doors'" },
			});
		}
	}
	// The degraded dev server: its health rollback.
	if (m.degraded) {
		const j = p.job(m.degraded) as PackJob;
		const at = Math.min(m.at, startOf(j) + 50 * 60_000);
		seeds.push({ at, level: "critical", code: "health_rollback", message: "Generation 3 failed its health check (WardenOffice: 14 errors in 60 s); rolled back to generation 2", job: j.job, branch: j.branch, artifact: j.art, seq: j.seq, source: "game", details: { errors: 14, windowSeconds: 60, from: 3, to: 2 }, kernel: j.kernel, bundle: { code: "health_rollback", stage: "check", error: DEGRADED_ERROR } });
	}
	// The game's alerts: about four a day, on a server that had players then.
	const r = rng("fleet:alerts");
	for (let t = p.from + r.int(1, 4) * 3_600_000; t <= m.at; t += r.int(3, 9) * 3_600_000 + r.int(0, 3_600_000)) {
		const job = activeJobAt(p, t, r);
		if (!job) continue;
		const kind = r.weighted(GAME_ALERTS.map((g) => [g, g.w] as const));
		const { message, details } = kind.text(r, p);
		const critical = kind.code === "datastore_errors" && r.chance(0.25);
		const id = critical ? bundleId(`${job.job}:${t}`) : undefined;
		seeds.push({
			at: t,
			level: critical ? "critical" : kind.level,
			code: kind.code,
			message: critical ? message.replace("; inventories retried", "; 2 inventories not saved") : message,
			job: job.job,
			branch: job.branch,
			artifact: job.art,
			seq: job.seq,
			source: "game",
			details: { ...details, ...(id ? { bundle: id } : {}) },
			kernel: job.kernel,
			...(critical ? { bundle: { code: kind.code, error: "DataStoreService: InternalServerError: An internal server error occurred. API: UpdateAsync, Data Store: players__prod" } } : {}),
		});
	}
	seeds.sort((a, b) => a.at - b.at || a.code.localeCompare(b.code));
	const ackedBefore = m.at - 12 * 3_600_000;
	m.alerts = seeds.map((s, i) => {
		let details = s.details;
		if (s.bundle && !(details && "bundle" in details)) details = { ...(details ?? {}), bundle: bundleId(`${s.job}:${s.at}`) };
		return {
			id: i + 1,
			at: s.at,
			level: s.level,
			code: s.code,
			message: s.message,
			branch: s.branch,
			artifact: s.artifact,
			job: s.job,
			seq: s.seq,
			acked: s.at < ackedBefore,
			source: s.source,
			createdAt: new Date(s.at).toISOString(),
			details,
		};
	});
	m.bundles = [];
	for (const s of seeds) {
		if (!s.bundle || !s.job) continue;
		const j = p.job(s.job);
		if (!j) continue;
		const alert = m.alerts.find((a) => a.at === s.at && a.job === s.job && a.code === s.code);
		const id = (alert?.details?.bundle as string | undefined) ?? bundleId(`${s.job}:${s.at}`);
		m.bundles.push(makeBundle(m, j, id, s.at + 3_000, s, alert));
	}
}

function makeBundle(m: Model, j: PackJob, id: string, at: number, s: AlertSeed, alert: FleetAlert | undefined): StoredBundle {
	const people = occupantsAt(m, j, at).slice(0, 30);
	const reading = readingAt(j, at, j.job === m.degraded);
	const reports = (m.reportsByJob.get(j.job) ?? []).filter((r) => r.at <= at);
	const generation = j.job === m.degraded ? 3 : reports.reduce((g, r) => Math.max(g, r.generation ?? 0), 0) || 1;
	const history = reports.map((r, i) => ({ at: Math.round(r.at / 1000), name: `${r.artifact}#${i + 1}`, artifactId: r.artifact, branch: r.branch, reason: i === 0 ? "boot" : "deploy", loadSeconds: round1((r.seconds ?? 2) * 0.6), swapSeconds: r.seconds }));
	if (j.job === m.degraded) {
		const t0 = Math.round(startOf(j) / 1000);
		history.splice(0, history.length, { at: t0, name: `${j.art}#1`, artifactId: j.art, branch: j.branch, reason: "boot", loadSeconds: 1.2, swapSeconds: 1.9 }, { at: t0 + 1500, name: `${j.art}#2`, artifactId: j.art, branch: j.branch, reason: "restart", loadSeconds: 1.1, swapSeconds: 1.7 }, { at: Math.round(at / 1000) - 70, name: `${j.art}#3`, artifactId: j.art, branch: j.branch, reason: "deploy", loadSeconds: 1.4, swapSeconds: 2.2 });
	}
	const logStart = Math.round(at / 1000) - 120;
	const serverLog = Array.from({ length: 40 }, (_, i) => {
		const line = serverLogLine(m, j, logStart + i * 3, 10_000 + i);
		return { i: 10_000 + i, t: logStart + i * 3, kind: line.kind, text: line.text };
	});
	serverLog.push({ i: 10_040, t: Math.round(at / 1000) - 1, kind: "error", text: s.bundle?.error ?? s.message });
	const playerLogs: Record<string, unknown> = {};
	for (const o of people.slice(0, 3)) playerLogs[String(o.userId)] = clientLogLines(o, Math.round(at / 1000) - 60, 12);
	const body: BundleBody = {
		failure: { stage: s.bundle?.stage ?? null, error: s.bundle?.error ?? null, report: null, triggers: [{ code: s.bundle?.code ?? s.code, at: Math.round(s.at / 1000), level: s.level }] },
		server: { jobId: j.job, placeId: j.place ?? PLACE_ID, placeVersion: placeVersionOf(m, j), serverType: j.srv, players: reading.players, maxPlayers: j.maxSlots ?? 35, uptime: Math.round((at - startOf(j)) / 1000), memoryMb: reading.memMb, tps: reading.tps },
		deploy: { appliedSeq: j.seq, history, reports: reports.slice(-5).map((r) => ({ s: r.seq, b: r.branch, a: r.artifact, r: r.result, e: r.error, d: r.seconds, t: Math.round(r.at / 1000), g: r.generation, k: r.kernel })), failing: s.code === "deploy_failed" || s.code === "health_rollback", failedHere: s.code === "deploy_failed", pending: false, wanted: false, busy: false, restoring: false, heads: { [j.branch ?? "prod"]: { seq: j.seq, artifactId: j.art } }, refusals: [] },
		fallback: { active: false, moved: 0 },
		alerts: alert ? [{ level: alert.level, code: alert.code, message: alert.message, t: Math.round(alert.at / 1000) }] : [],
		players: people.map((o) => ({ u: o.userId, n: o.name, joinedAt: Math.round(o.joinedAt / 1000), ping: rng(`fleet:ping:${o.pid}`).int(40, 180), client: `gen ${generation} ok` })),
		serverLog,
		playerLogs,
	};
	const size = JSON.stringify(body).length;
	return {
		id,
		job: j.job,
		code: s.bundle?.code ?? s.code,
		level: s.level,
		message: s.message,
		closing: s.bundle?.closing ?? false,
		at,
		time: new Date(at).toISOString(),
		kernel: j.kernel,
		branch: j.branch,
		artifact: j.art,
		seq: j.seq,
		generation,
		players: people.length,
		size,
		stage: s.bundle?.stage ?? null,
		error: s.bundle?.error ?? null,
		body,
	};
}

export function bundleSummary(b: StoredBundle): BundleSummary {
	const { body: _body, ...summary } = b;
	return summary;
}

export function bundleById(m: Model, id: string): DebugBundle | undefined {
	const b = m.bundles.find((x) => x.id === id);
	return b ? { ...bundleSummary(b), body: b.body } : undefined;
}

export function swapsOf(m: Model, job: string): BundleSwap[] {
	const swaps = new Map<string, BundleSwap>();
	for (const b of m.bundles.filter((x) => x.job === job).sort((a, c) => c.at - a.at)) {
		const history = (b.body.deploy as { history?: { at: number; name: string | null; artifactId: string | null; branch: string | null; reason: string | null; loadSeconds: number | null; swapSeconds: number | null }[] } | undefined)?.history ?? [];
		for (const h of history) {
			const key = `${h.at}\u0000${h.name ?? ""}`;
			if (!swaps.has(key)) swaps.set(key, { at: h.at * 1000, name: h.name, artifact: h.artifactId, branch: h.branch, reason: h.reason, loadSeconds: h.loadSeconds, swapSeconds: h.swapSeconds, bundle: b.id });
		}
	}
	return [...swaps.values()].sort((a, b) => b.at - a.at);
}

// Logs (server and clients), shared by the remote debug answers, bundles and Roblox's own logs ---------------------------

export interface LogLine {
	kind: "output" | "info" | "warning" | "error";
	text: string;
}

const pick = <T>(r: ReturnType<typeof rng>, list: readonly T[]) => r.pick(list);

/** Server log line `i` at unix second `t`, in the game's words. */
export function serverLogLine(m: Model, j: PackJob, t: number, i: number): LogLine {
	const r = rng(`fleet:log:${j.job}:${i}`);
	const v = m.p.vocabulary.props;
	const quest = pick(r, v.quest ?? [{ value: "inmate_escape_prison", n: 1 }]).value;
	const item = pick(r, v.item ?? [{ value: "lockpick", n: 1 }]).value;
	const weapon = pick(r, v.weapon ?? [{ value: "baton", n: 1 }]).value;
	const people = occupantsAt(m, j, t * 1000);
	const who = people.length ? pick(r, people).name : fakeName(r.hex(32));
	const guard = people.find((o) => o.team === "guard")?.name ?? "Guard_0193";
	const roll = r.next();
	if (roll < 0.02) {
		const err = m.p.errors.filter((e) => e.src === "server");
		if (err.length) return { kind: r.chance(0.5) ? "warning" : "error", text: pick(r, err).msg.split("\n")[0] as string };
	}
	if (roll < 0.05) return { kind: "warning", text: pick(r, ["[Data] players__prod UpdateAsync retry 1/3 (throttled)", "[Shop] restock skipped: MemoryStore busy", "[Teleport] reserved server queue full, retrying in 5 s", `[Combat] ${who} hit rate limit on ${weapon}`]) };
	if (roll < 0.17) return { kind: "info", text: `[Quests] ${who} completed ${quest} (+${r.int(3, 30) * 10} cash)` };
	if (roll < 0.27) return { kind: "info", text: `[Shop] ${who} bought ${item} for ${r.int(2, 60) * 10} cash` };
	if (roll < 0.33) return { kind: "info", text: `[Escape] ${who} escaped through the ${pick(r, ["sewer", "yard fence", "laundry chute", "roof"])} (${r.int(2, 9)}:${String(r.int(0, 59)).padStart(2, "0")})` };
	if (roll < 0.4) return { kind: "info", text: `[Arrest] ${guard} arrested ${who} (bounty ${r.int(5, 15) * 5} cash)` };
	if (roll < 0.46) return { kind: "info", text: `[Combat] ${who} knocked out with a ${weapon}` };
	if (roll < 0.51) return { kind: "info", text: `[Medic] ${who} healed for ${r.int(20, 60)} HP (+40 cash)` };
	if (roll < 0.56) return { kind: "output", text: `[Jobs] ${who} cleaned a spill (${r.int(1, 3)}/3)` };
	if (roll < 0.6) return { kind: "output", text: `[Jobs] ${who} searched a trash bin: ${pick(r, ["nothing", "bread", "lockpick", "glassknife", "lvl_1_key"])}` };
	if (roll < 0.64) return { kind: "output", text: `[Teams] ${who} joined ${pick(r, ["Inmates", "Guards", "Medics"])}` };
	if (roll < 0.68) return { kind: "output", text: `[Spin] ${who} spun the wheel: ${pick(r, ["150 cash", "xp boost", "faintspray", "bandage", "nothing"])}` };
	if (roll < 0.72) return { kind: "output", text: `[Round] ${pick(r, ["Roll call", "Work shift", "Yard time", "Dinner", "Lights out"])} begins` };
	if (roll < 0.75) return { kind: "output", text: `[Lockdown] ${pick(r, ["Riot in cell block A: doors closing", "Lockdown lifted", "Cafeteria fight: guards called"])}` };
	if (roll < 0.8) return { kind: "output", text: `[TypeTorch] heartbeat ok (${people.length} players, ${readingAt(j, t * 1000).tps} TPS)` };
	if (roll < 0.86) return { kind: "output", text: `[Data] saved ${r.int(1, 6)} inventories in ${r.int(40, 260)} ms` };
	return { kind: "output", text: `[Players] ${who} ${r.chance(0.5) ? "joined" : "left"} (${people.length}/${j.maxSlots ?? 35})` };
}

/** One client's log lines (op player.logs, bundles' playerLogs). */
export function clientLogLines(o: Pick<Occupant, "pid" | "name" | "team">, fromSeconds: number, count: number, startIndex = 1) {
	const out: { i: number; t: number; kind: LogLine["kind"]; text: string }[] = [];
	for (let k = 0; k < count; k++) {
		const r = rng(`fleet:clog:${o.pid}:${startIndex + k}`);
		const roll = r.next();
		const text =
			roll < 0.1
				? "Failed to load sound rbxassetid://7029024726: HttpError: Timedout"
				: roll < 0.2
					? `[UI] opened ${r.pick(["shop", "quests", "spin_wheel", "inventory", "team_select"])}`
					: roll < 0.35
						? `[Quests] progress ${r.pick(["inmate_clean_3_spills", "daily_common_play_15_minutes", "inmate_search_3_trashcans", "guard_guard_area_1x"])} ${r.int(1, 3)}/3`
						: roll < 0.45
							? `[Combat] hit by ${r.pick(["baton", "sledgehammer", "punch", "metalknife", "medictaser"])} (-${r.int(5, 35)} HP)`
							: roll < 0.55
								? `[Inventory] equipped ${r.pick(["lockpick", "bandage", "bread", "crowbar", "syringe"])}`
								: roll < 0.6
									? "[Net] ping spike 380 ms"
									: `[TypeTorch] client gen ok (${o.team})`;
		out.push({ i: startIndex + k, t: fromSeconds + k * 5, kind: roll < 0.1 ? "warning" : "output", text });
	}
	return out;
}
