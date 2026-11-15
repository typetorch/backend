/**
 * The recordings explorer (the explorer's Recordings page): first-session recordings without Roblox Studio.
 *   recording-layers    per map: a top-down frame, a density silhouette, and layers (path, idle, deaths, spawns,
 *                       screens, buttons, prompts, quits, positioned events) as grid cells
 *   recording-sessions  recorded sessions, filtered by map cell, why the recording ended, or a confusion signal
 *   recording-replay    one session: samples, inputs, events, signals and maps, for the top-down replay
 *   quit-autopsy        the last seconds before a player left, classified, against the sessions that didn't leave
 *   first-action        seconds from spawn to the first move, screen, button, prompt and round, by device and build
 *
 * Maps: a sample (or a positioned event) belongs to the map of the latest event before it on the same server (`job`)
 * whose props carry the map key (option `mapKey`, default `map`), else the player's own latest; a lobby zone or a
 * position far outside the map's area goes to the "(lobby / unknown)" layer. Positioned events: any event whose props
 * have numeric `px` and `pz` (studs; `py` optional).
 *
 * Decoding is the slow part, so decoded sessions are cached in memory (TrackCache) by a signature of their chunk rows:
 * Parquet days never change, so their sessions decode once; a session still being written (today) changes signature
 * with each new chunk and decodes again. Past `maxSessions` the recorded sessions are sampled (a fixed hash order, so
 * the same range gives the same sample), and the result says so.
 */
import {
	FIRST_ACTION_DEFAULTS,
	AUTOPSY_DEFAULTS,
	Grid,
	type GridCell,
	LAYER_LABELS,
	NO_MAP,
	PointSet,
	RECORDING_LAYERS,
	addRecordingLayers,
	assignSamples,
	zoneMapsOf,
	boundsOf,
	classifyEnding,
	firstActionStats,
	firstActions,
	frameFor,
	inside,
	lastPosition,
	rejectStrays,
	statePart,
	summarizeAutopsy,
	toTrack,
	trackBytes,
	trackToDecoded,
	tutorialMaxSteps,
	type AutopsyOptions,
	type AutopsyRow,
	type Bounds,
	type FirstActionStat,
	type FirstActions,
	type FirstAction,
	type Frame,
	type LayerSession,
	type MapSources,
	type MapTimeline,
	type RecordingLayerId,
	type SessionEvent,
	type Track,
} from "../recording-analysis.ts";
import { decodeSessions, decoderVersion, detectSignals, type ChunkRow, type RecordingInput, type Signal, type SignalKind, type ZoneTimeline } from "../recording.ts";
import { assertSafeKey } from "../sql/dialect.ts";
import { whereSql, type NormalizedFilters } from "../sql/filters.ts";
import { defineQuery, eventsTable, int, lit, num, playerRows, str, strOrNull, type QueryContext, type Row, type Rows, type RunStatements } from "./core.ts";

// The decoded-session cache ---------------------------------------------------------------------------------------------

/** Decoded sessions by sid, least recently used out first, within a byte budget. */
export class TrackCache {
	private entries = new Map<string, { signature: string; track: Track; bytes: number }>();
	private used = 0;
	hits = 0;
	misses = 0;
	constructor(private readonly maxBytes: number) {}
	get(sid: string, signature: string): Track | undefined {
		const entry = this.entries.get(sid);
		if (!entry || entry.signature !== signature) {
			this.misses++;
			return undefined;
		}
		this.entries.delete(sid);
		this.entries.set(sid, entry);
		this.hits++;
		return entry.track;
	}
	set(sid: string, signature: string, track: Track): void {
		const old = this.entries.get(sid);
		if (old) {
			this.used -= old.bytes;
			this.entries.delete(sid);
		}
		const bytes = trackBytes(track);
		if (bytes > this.maxBytes) return;
		this.entries.set(sid, { signature, track, bytes });
		this.used += bytes;
		for (const [key, entry] of this.entries) {
			if (this.used <= this.maxBytes) break;
			this.entries.delete(key);
			this.used -= entry.bytes;
		}
	}
	clear(): void {
		this.entries.clear();
		this.used = 0;
		this.hits = 0;
		this.misses = 0;
	}
	get size(): number {
		return this.entries.size;
	}
	get bytes(): number {
		return this.used;
	}
}

/** ~96 MB: about 3 M samples, a few thousand sessions. */
export const trackCache = new TrackCache(96 * 1024 * 1024);

export function clearRecordingCache(): void {
	trackCache.clear();
}

// Options ---------------------------------------------------------------------------------------------------------------

export interface RecordingBaseOptions {
	/** The props key that names the map. Default "map". */
	mapKey: string;
	/** Most recorded sessions to decode; more are sampled. Default 3000. */
	maxSessions: number;
}

function stringOption(value: unknown, name: string, max = 200): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be a string of at most ${max} characters`);
	return value;
}

function stringList(value: unknown, name: string, maxItems = 50): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length > maxItems || value.some((v) => typeof v !== "string" || v.length > 200)) throw new Error(`${name} must be a list of at most ${maxItems} strings`);
	return value as string[];
}

function numberOption(value: unknown, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === null) return fallback;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
	return n;
}

function baseOptions(input: Partial<RecordingBaseOptions> = {}): RecordingBaseOptions {
	return {
		mapKey: assertSafeKey(stringOption(input.mapKey, "mapKey", 64) ?? "map", "mapKey"),
		maxSessions: Math.round(numberOption(input.maxSessions, "maxSessions", 3000, 1, 20_000)),
	};
}

/** A sid / pid as it goes into SQL. */
function checkId(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`${name} must be 1-64 characters of letters, digits, _ or -`);
	return value;
}

// SQL --------------------------------------------------------------------------------------------------------------------

/** Map events are read from this long before the range (the map a server was on when a session began). */
const MAP_LOOKBACK_MS = 2 * 3_600_000;
/** Session events are read until this long after the last chunk started (a chunk covers about 10 s). */
const AFTER_LAST_CHUNK_MS = 60_000;
/** Base cell of positioned events in SQL (studs); map frames use multiples of it. */
const BASE_CELL = 4;

function recTable(ctx: QueryContext, f: NormalizedFilters): string {
	return ctx.table("recordings", f.from, f.to);
}

function recWhere(ctx: QueryContext, f: NormalizedFilters): string {
	return whereSql(f, ctx.dialect, { prefix: "r.", recordings: true });
}

/** Recorded sessions in the range (the filter bar's segment through their events): chunk stats, device, why it ended. */
function sessionsSql(ctx: QueryContext, f: NormalizedFilters): string {
	const why = ctx.dialect.jsonText("e.props", "why");
	return (
		`WITH r AS (SELECT r.sid AS sid, MIN(r.pid) AS pid, MIN(r.job) AS job, MIN(r.art) AS art, MIN(r.t) AS t0, MAX(r.t) AS t1, COUNT(*) AS chunks, ` +
		`SUM(r.n) AS n, SUM(length(r.data)) AS bytes FROM ${recTable(ctx, f)} r WHERE ${recWhere(ctx, f)} AND r.sid IS NOT NULL AND r.sid <> '' GROUP BY r.sid), ` +
		`m AS (SELECT e.sid AS sid, MAX(CASE WHEN e.dev IS NOT NULL AND e.dev <> '' AND e.dev <> 'unknown' THEN e.dev ELSE NULL END) AS dev, ` +
		`MAX(CASE WHEN e.kind = 'recording_meta' AND e.name = 'end' THEN ${why} ELSE NULL END) AS why FROM ${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx)} GROUP BY e.sid) ` +
		`SELECT r.sid AS sid, r.pid AS pid, r.job AS job, r.art AS art, r.t0 AS t0, r.t1 AS t1, r.chunks AS chunks, r.n AS n, r.bytes AS bytes, m.dev AS dev, m.why AS why ` +
		`FROM r JOIN m ON m.sid = r.sid ORDER BY r.sid ${ctx.dialect.limit(20_000)}`
	);
}

function mapExpr(ctx: QueryContext, mapKey: string): string {
	return ctx.dialect.jsonText("e.props", mapKey);
}

/** Map change points per server (by = job) or per player (by = pid), near the recorded sessions. */
function mapPointsSql(ctx: QueryContext, f: NormalizedFilters, mapKey: string, by: "job" | "pid"): string {
	const map = mapExpr(ctx, mapKey);
	return (
		`WITH w AS (SELECT r.${by} AS k, MIN(r.t) AS a, MAX(r.t) AS b FROM ${recTable(ctx, f)} r WHERE ${recWhere(ctx, f)} AND r.${by} IS NOT NULL AND r.${by} <> '' GROUP BY r.${by}), ` +
		`m AS (SELECT DISTINCT e.${by} AS k, e.t AS t, ${map} AS map FROM ${ctx.table("events", f.from - MAP_LOOKBACK_MS, f.to)} e JOIN w ON w.k = e.${by} ` +
		`WHERE e.t >= w.a - ${int(MAP_LOOKBACK_MS)} AND e.t <= w.b + ${int(AFTER_LAST_CHUNK_MS)} AND ${map} IS NOT NULL), ` +
		`x AS (SELECT k, t, map, LAG(map) OVER (PARTITION BY k ORDER BY t, map) AS prev FROM m) ` +
		`SELECT k, t, map FROM x WHERE prev IS NULL OR prev <> map ORDER BY k, t, map ${ctx.dialect.limit(100_000)}`
	);
}

/** Positioned events per (kind, name) in the range. */
function positionedCatalogSql(ctx: QueryContext, f: NormalizedFilters): string {
	const px = ctx.dialect.jsonNumber("e.props", "px");
	const pz = ctx.dialect.jsonNumber("e.props", "pz");
	return (
		`SELECT e.kind AS kind, e.name AS name, COUNT(*) AS n FROM ${eventsTable(ctx, f)} e WHERE ${where(ctx, f)} AND ${px} IS NOT NULL AND ${pz} IS NOT NULL ` +
		`GROUP BY e.kind, e.name ORDER BY n DESC, kind, name ${ctx.dialect.limit(200)}`
	);
}

function where(ctx: QueryContext, f: NormalizedFilters): string {
	return whereSql(f, ctx.dialect, { prefix: "e." });
}

export interface PositionedLayerSpec {
	kind: string;
	name: string;
	/** Split (and filter) by this props key. */
	split?: string;
}

/**
 * Positioned events in BASE_CELL cells per map, value and zone/screen match. The map: the server's latest map event
 * before each event, else the player's (a running count of map events per server / player marks the groups).
 */
function positionedCellsSql(ctx: QueryContext, f: NormalizedFilters, mapKey: string, specs: readonly PositionedLayerSpec[], zone?: string, screen?: string): string {
	const d = ctx.dialect;
	const px = d.jsonNumber("e.props", "px");
	const pz = d.jsonNumber("e.props", "pz");
	const map = mapExpr(ctx, mapKey);
	const splits = specs.filter((s) => s.split);
	const v = splits.length
		? `CASE ${splits.map((s) => `WHEN e.kind = ${lit(s.kind)} AND e.name = ${lit(s.name)} THEN ${d.jsonText("e.props", s.split as string)}`).join(" ")} ELSE NULL END`
		: "CAST(NULL AS VARCHAR)";
	const conds = [zone ? `split_part(split_part('|' || COALESCE(e.state, ''), ${lit("|zone:")}, 2), '|', 1) = ${lit(zone)}` : "", screen ? `split_part(split_part('|' || COALESCE(e.state, ''), ${lit("|screen:")}, 2), '|', 1) = ${lit(screen)}` : ""].filter(Boolean);
	const keep = conds.length ? `CASE WHEN ${conds.join(" AND ")} THEN 1 ELSE 0 END` : "1";
	const rows = "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW";
	return (
		`WITH pe AS (SELECT e.job AS job, COALESCE(e.pid, '') AS pid, e.t AS t, e.kind AS kind, e.name AS name, ${px} AS px, ${pz} AS pz, ${v} AS v, ${keep} AS keep, 0 AS ism, CAST(NULL AS VARCHAR) AS map ` +
		`FROM ${eventsTable(ctx, f)} e WHERE ${where(ctx, f)} AND ${px} IS NOT NULL AND ${pz} IS NOT NULL), ` +
		`mk AS (SELECT e.job AS job, COALESCE(e.pid, '') AS pid, e.t AS t, '' AS kind, '' AS name, CAST(NULL AS DOUBLE) AS px, CAST(NULL AS DOUBLE) AS pz, CAST(NULL AS VARCHAR) AS v, 0 AS keep, 1 AS ism, ${map} AS map ` +
		`FROM ${ctx.table("events", f.from - MAP_LOOKBACK_MS, f.to)} e WHERE e.t >= ${int(f.from - MAP_LOOKBACK_MS)} AND e.t < ${int(f.to)} AND ${map} IS NOT NULL), ` +
		`u AS (SELECT * FROM pe UNION ALL SELECT * FROM mk), ` +
		`g AS (SELECT u.*, SUM(ism) OVER (PARTITION BY job ORDER BY t, ism DESC ${rows}) AS gj, ` +
		`SUM(CASE WHEN ism = 1 AND pid <> '' THEN 1 ELSE 0 END) OVER (PARTITION BY pid ORDER BY t, ism DESC ${rows}) AS gp FROM u), ` +
		`a AS (SELECT g.*, MAX(map) OVER (PARTITION BY job, gj) AS jmap, MAX(CASE WHEN ism = 1 AND pid <> '' THEN map ELSE NULL END) OVER (PARTITION BY pid, gp) AS pmap FROM g) ` +
		`SELECT CASE WHEN gj > 0 THEN jmap ELSE pmap END AS map, kind, name, v, keep, CAST(floor(px / ${BASE_CELL}) AS BIGINT) AS cx, CAST(floor(pz / ${BASE_CELL}) AS BIGINT) AS cz, ` +
		`COUNT(*) AS n FROM a WHERE ism = 0 GROUP BY CASE WHEN gj > 0 THEN jmap ELSE pmap END, kind, name, v, keep, CAST(floor(px / ${BASE_CELL}) AS BIGINT), CAST(floor(pz / ${BASE_CELL}) AS BIGINT) ` +
		`ORDER BY n DESC, map, kind, name, v, keep, cx, cz ${d.limit(20_000)}`
	);
}

// Loading ----------------------------------------------------------------------------------------------------------------

/** The first phase's rows, for finish() (shape() hands them over keyed by its result object). */
const pending = new WeakMap<object, Rows>();

function keep<R extends object>(result: R, rows: Rows): R {
	pending.set(result, rows);
	return result;
}

function taken(result: object): Rows {
	const rows = pending.get(result) ?? {};
	pending.delete(result);
	return rows;
}

export interface RecordedSession {
	sid: string;
	pid: string;
	job: string;
	art: string;
	/** First and last chunk start (ms). */
	t0: number;
	t1: number;
	chunks: number;
	n: number;
	bytes: number;
	dev: string;
	/** Why the recording ended (recording_meta end): window, left, cap, end; null when unknown. */
	why: string | null;
}

export interface Sampling {
	/** Recorded sessions in the range (with the filters). */
	recorded: number;
	/** Decoded and used. */
	used: number;
	/** True when `used` < `recorded` (a fixed sample). */
	sampled: boolean;
	failed: number;
	/** The session list hit its row cap (Basin: 10,000). */
	capped: boolean;
	/** The session events hit a statement's row cap: some sessions miss late events. */
	eventsCapped: boolean;
}

export interface LoadedSession extends RecordedSession {
	track: Track;
	events: SessionEvent[];
}

function parseSessions(rows: Row[]): RecordedSession[] {
	return rows.map((r) => ({
		sid: str(r.sid),
		pid: str(r.pid),
		job: str(r.job),
		art: str(r.art),
		t0: num(r.t0),
		t1: num(r.t1),
		chunks: num(r.chunks),
		n: num(r.n),
		bytes: num(r.bytes),
		dev: strOrNull(r.dev) ?? "unknown",
		why: strOrNull(r.why),
	}));
}

/** FNV-1a, for a fixed sample order. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function sampleSessions<T extends { sid: string }>(sessions: readonly T[], max: number): T[] {
	if (sessions.length <= max) return [...sessions];
	return [...sessions]
		.sort((a, b) => hash(a.sid) - hash(b.sid) || (a.sid < b.sid ? -1 : 1))
		.slice(0, max)
		.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
}

/** Groups sessions into batches of at most `maxRows` estimated rows and `maxSids` sessions. */
function batches<T>(items: readonly T[], weight: (item: T) => number, maxRows: number, maxSids: number): T[][] {
	const out: T[][] = [];
	let current: T[] = [];
	let rows = 0;
	for (const item of items) {
		const w = Math.max(1, weight(item));
		if (current.length && (rows + w > maxRows || current.length >= maxSids)) {
			out.push(current);
			current = [];
			rows = 0;
		}
		current.push(item);
		rows += w;
	}
	if (current.length) out.push(current);
	return out;
}

function signature(s: RecordedSession): string {
	return `${decoderVersion()}:${s.job}:${s.pid}:${s.t0}:${s.t1}:${s.chunks}:${s.n}:${s.bytes}`;
}

const EVENT_KINDS = ["session", "state", "zone", "funnel", "custom", "recording_meta"];
const EVENT_ROWS = 10_000;

function parseProps(text: unknown): Record<string, unknown> | undefined {
	if (typeof text !== "string" || !text) return undefined;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Decodes (or takes from the cache) the sessions, and reads their events (state, funnels, custom, recording_meta). */
export async function loadSessions(
	ctx: QueryContext,
	f: NormalizedFilters,
	sessions: readonly RecordedSession[],
	run: RunStatements,
	options: { events?: boolean } = {},
): Promise<{ loaded: LoadedSession[]; failed: number; eventsCapped: boolean }> {
	const lim = ctx.dialect.limit;
	const tracks = new Map<string, Track>();
	const missing: RecordedSession[] = [];
	for (const s of sessions) {
		const hit = trackCache.get(s.sid, signature(s));
		if (hit) tracks.set(s.sid, hit);
		else missing.push(s);
	}
	const statements: Record<string, string> = {};
	const list = (group: readonly RecordedSession[]) => group.map((s) => lit(s.sid)).join(", ");
	batches(missing, (s) => s.chunks, 10_000, 500).forEach((group, i) => {
		statements[`chunks_${i}`] =
			`SELECT r.sid AS sid, r.pid AS pid, r.chunk AS chunk, r.codec AS codec, r.data AS data, r.n AS n, r.t AS t FROM ${recTable(ctx, f)} r ` +
			`WHERE ${recWhere(ctx, f)} AND r.sid IN (${list(group)}) ORDER BY r.sid, r.chunk ${lim(10_000)}`;
	});
	if (options.events !== false) {
		batches(sessions, () => 1, 200, 200).forEach((group, i) => {
			statements[`events_${i}`] =
				`SELECT e.sid AS sid, e.t AS t, e.kind AS kind, e.name AS name, e.state AS state, ` +
				`CASE WHEN e.kind IN ('funnel', 'custom', 'recording_meta') THEN e.props ELSE NULL END AS props ` +
				`FROM ${eventsTable(ctx, f)} e JOIN (SELECT r.sid AS sid, MAX(r.t) AS t1 FROM ${recTable(ctx, f)} r WHERE ${recWhere(ctx, f)} AND r.sid IN (${list(group)}) GROUP BY r.sid) x ` +
				`ON x.sid = e.sid WHERE e.t >= ${int(f.from)} AND e.t < ${int(f.to)} AND e.t <= x.t1 + ${int(AFTER_LAST_CHUNK_MS)} ` +
				`AND e.kind IN (${EVENT_KINDS.map(lit).join(", ")}) ORDER BY e.sid, e.t, e.kind, e.name ${lim(EVENT_ROWS)}`;
		});
	}
	const rows: Rows = Object.keys(statements).length ? await run(statements) : {};
	let failed = 0;
	const meta = new Map(sessions.map((s) => [s.sid, s]));
	for (const [name, chunkRows] of Object.entries(rows)) {
		if (!name.startsWith("chunks_")) continue;
		const chunks: ChunkRow[] = chunkRows.map((r) => ({ sid: str(r.sid), pid: str(r.pid), chunk: num(r.chunk), codec: str(r.codec) as ChunkRow["codec"], data: str(r.data), n: num(r.n), t: num(r.t) }));
		const decoded = decodeSessions(chunks);
		failed += decoded.failed;
		for (const rec of decoded.recordings) {
			const s = meta.get(rec.sid);
			if (!s) continue;
			const track = toTrack(rec, { job: s.job, art: s.art, start: s.t0 });
			trackCache.set(s.sid, signature(s), track);
			tracks.set(s.sid, track);
		}
	}
	const events = new Map<string, SessionEvent[]>();
	let eventsCapped = false;
	for (const [name, eventRows] of Object.entries(rows)) {
		if (!name.startsWith("events_")) continue;
		if (eventRows.length >= Math.min(EVENT_ROWS, ctx.dialect.maxRows)) eventsCapped = true;
		for (const r of eventRows) {
			const sid = str(r.sid);
			const list = events.get(sid) ?? [];
			const e: SessionEvent = { t: num(r.t), kind: str(r.kind), name: str(r.name), state: strOrNull(r.state) };
			const props = parseProps(r.props);
			if (props) e.props = props;
			list.push(e);
			events.set(sid, list);
		}
	}
	const loaded: LoadedSession[] = [];
	for (const s of sessions) {
		const track = tracks.get(s.sid);
		if (track) loaded.push({ ...s, track, events: events.get(s.sid) ?? [] });
	}
	return { loaded, failed, eventsCapped };
}

function timelines(rows: Row[] | undefined): Map<string, MapTimeline> {
	const out = new Map<string, MapTimeline>();
	for (const r of rows ?? []) {
		const key = str(r.k);
		const list = out.get(key) ?? [];
		list.push({ t: num(r.t), map: strOrNull(r.map) ?? null });
		out.set(key, list);
	}
	for (const list of out.values()) list.sort((a, b) => a.t - b.t);
	return out;
}

/** Map names and their indexes (NO_MAP is 0). */
class MapNames {
	names: string[] = [NO_MAP];
	private index = new Map<string, number>([[NO_MAP, 0]]);
	of = (name: string): number => {
		let i = this.index.get(name);
		if (i === undefined) {
			i = this.names.length;
			this.names.push(name);
			this.index.set(name, i);
		}
		return i;
	};
}

export interface PositionedCell {
	map: string;
	kind: string;
	name: string;
	value: string | null;
	keep: boolean;
	x: number;
	z: number;
	n: number;
}

export interface Prepared {
	sessions: (LoadedSession & LayerSession)[];
	names: string[];
	frames: Map<string, Frame>;
	cores: Map<string, Bounds>;
	/** Samples and sessions per map; `confirmed` = samples whose analytics zone named the map. */
	stats: Map<string, { samples: number; confirmed: number; sessions: Set<string>; events: number }>;
	/** Samples with any analytics zone (0 = the game names no zones: map assignment by map events alone). */
	zoned: number;
	positioned: PositionedCell[];
	sources: MapSources;
}

const MAX_POINTS_PER_MAP = 60_000;
/** Points whose zone named their map: at least this many (and 5% of the map's points) and a map's area comes from them alone. */
const MIN_CONFIRMED_POINTS = 50;

/** Map assignment for the sessions (and positioned cells), each map's frame, strays moved to NO_MAP. */
export function prepareMaps(loaded: readonly LoadedSession[], sources: MapSources, positionedRows: Row[], grid: number): Prepared {
	const names = new MapNames();
	let zoned = 0;
	const sessions = loaded.map((s) => {
		const { maps, confirmed, zoned: z } = assignSamples(s.track, s.events, sources, names.of);
		zoned += z;
		return { ...s, maps, confirmed };
	});
	const positioned: PositionedCell[] = positionedRows.map((r) => ({
		map: strOrNull(r.map) || NO_MAP,
		kind: str(r.kind),
		name: str(r.name),
		value: strOrNull(r.v),
		keep: num(r.keep) === 1,
		x: (num(r.cx) + 0.5) * BASE_CELL,
		z: (num(r.cz) + 0.5) * BASE_CELL,
		n: num(r.n),
	}));
	for (const c of positioned) names.of(c.map);
	const collect = () => {
		const points = names.names.map(() => new PointSet());
		const totals = names.names.map(() => 0);
		for (const s of sessions) for (let i = 0; i < s.maps.length; i++) if (!Number.isNaN(s.track.x[i])) totals[s.maps[i]]++;
		// A map with enough points whose zone named it takes its area from those alone: the rest may be players elsewhere
		// (the lobby's shop) while the server's latest map event still names it.
		const confirmedTotals = names.names.map(() => 0);
		for (const s of sessions) for (let i = 0; i < s.maps.length; i++) if (s.confirmed[i] && !Number.isNaN(s.track.x[i])) confirmedTotals[s.maps[i]]++;
		const onlyConfirmed = totals.map((n, m) => m !== 0 && confirmedTotals[m] >= Math.max(MIN_CONFIRMED_POINTS, n * 0.05));
		const counted = totals.map((n, m) => (onlyConfirmed[m] ? confirmedTotals[m] : n));
		const strides = counted.map((n) => Math.max(1, Math.ceil(n / MAX_POINTS_PER_MAP)));
		const seen = names.names.map(() => 0);
		for (const s of sessions) {
			for (let i = 0; i < s.maps.length; i++) {
				if (Number.isNaN(s.track.x[i])) continue;
				const m = s.maps[i];
				if (onlyConfirmed[m] && !s.confirmed[i]) continue;
				if (seen[m]++ % strides[m] === 0) points[m].add(s.track.x[i], s.track.z[i], strides[m]);
			}
		}
		for (const c of positioned) points[names.of(c.map)].add(c.x, c.z, c.n);
		return points.map((p) => boundsOf(p));
	};
	// First pass: each map's area; points far outside it go to NO_MAP; then the areas again.
	const first = collect();
	const cores = first.map((b) => b?.core);
	cores[0] = undefined;
	for (const s of sessions) rejectStrays(s.track, s.maps, cores, 0);
	for (const c of positioned) {
		const core = cores[names.of(c.map)];
		if (c.map !== NO_MAP && core && !inside(core, c.x, c.z)) c.map = NO_MAP;
	}
	const second = collect();
	const frames = new Map<string, Frame>();
	const coreMap = new Map<string, Bounds>();
	names.names.forEach((name, i) => {
		const b = second[i];
		if (!b) return;
		frames.set(name, frameFor(b.frame, grid, BASE_CELL));
		coreMap.set(name, b.core);
	});
	const stats = new Map<string, { samples: number; confirmed: number; sessions: Set<string>; events: number }>();
	const stat = (name: string) => {
		let s = stats.get(name);
		if (!s) {
			s = { samples: 0, confirmed: 0, sessions: new Set(), events: 0 };
			stats.set(name, s);
		}
		return s;
	};
	for (const s of sessions) {
		for (let i = 0; i < s.maps.length; i++) {
			if (Number.isNaN(s.track.x[i])) continue;
			const st = stat(names.names[s.maps[i]]);
			st.samples++;
			if (s.confirmed[i]) st.confirmed++;
			st.sessions.add(s.sid);
		}
	}
	for (const c of positioned) stat(c.map).events += c.n;
	return { sessions, names: names.names, frames, cores: coreMap, stats, zoned, positioned, sources };
}

function sourcesFrom(rows: Rows): MapSources {
	const byJob = timelines(rows.jobMaps);
	const byPid = timelines(rows.pidMaps);
	return { byJob, byPid, zoneMaps: zoneMapsOf(byJob, byPid) };
}

/** The common first phase: the session list, sampled, decoded, with events and maps. */
async function prepareAll(
	rows: Rows,
	ctx: QueryContext,
	f: NormalizedFilters,
	o: RecordingBaseOptions,
	run: RunStatements,
	grid = 96,
): Promise<{ prepared: Prepared; sampling: Sampling; all: RecordedSession[] }> {
	const all = parseSessions(rows.sessions ?? []);
	const chosen = sampleSessions(all, o.maxSessions);
	const { loaded, failed, eventsCapped } = await loadSessions(ctx, f, chosen, run);
	const prepared = prepareMaps(loaded, sourcesFrom(rows), rows.cells ?? [], grid);
	return {
		prepared,
		all,
		sampling: {
			recorded: all.length,
			used: loaded.length,
			sampled: chosen.length < all.length,
			failed,
			capped: all.length >= Math.min(20_000, ctx.dialect.maxRows),
			eventsCapped,
		},
	};
}

function baseStatements(ctx: QueryContext, f: NormalizedFilters, o: RecordingBaseOptions): Record<string, string> {
	return {
		sessions: sessionsSql(ctx, f),
		jobMaps: mapPointsSql(ctx, f, o.mapKey, "job"),
		pidMaps: mapPointsSql(ctx, f, o.mapKey, "pid"),
	};
}

/** The map with the most samples and positioned events (a named map before the lobby). */
function defaultMap(prepared: Prepared): string | null {
	let best: string | null = null;
	let bestScore = -1;
	for (const [name, s] of prepared.stats) {
		const score = s.samples + s.events + (name === NO_MAP ? 0 : 1e12);
		if (score > bestScore && (s.samples > 0 || s.events > 0)) {
			best = name;
			bestScore = score;
		}
	}
	return best;
}

// recording-layers -----------------------------------------------------------------------------------------------------

export interface LayersOptions extends RecordingBaseOptions {
	/** The map to show (default: the one with the most data). */
	map?: string;
	/** Layer ids: recording layers (RECORDING_LAYERS) and positioned events as `ev:<kind>:<name>`. Default: every recording layer. */
	layers: string[];
	/** Per positioned layer id: a props key to split it by (its values come back for the toggles). */
	split: Record<string, string>;
	/** Per layer id: keep only these values. */
	values: Record<string, string[]>;
	zone?: string;
	screen?: string;
	/** Cells along the frame's longer side. Default 96. */
	grid: number;
	/**
	 * Studs per cell instead of `grid` (LAYER_CELL_SIZES: 0.5, 1, 2 or 4), for the explorer's real-map view. The frame
	 * keeps its origin (a multiple of the base cell); positioned event layers stay at the base cell (their SQL bins it),
	 * so they carry their own `cell`.
	 */
	cell?: LayerCellSize;
	/** Most cells per layer (the largest). Default 4000 (20,000 with `cell`). */
	maxCells: number;
	/** The silhouette (every sample on the map). Default true; the real-map view leaves it out. */
	background: boolean;
}

export const LAYER_CELL_SIZES = [0.5, 1, 2, 4] as const;
export type LayerCellSize = (typeof LAYER_CELL_SIZES)[number];

/** `frame` with `cell` studs per cell (same origin and extent: a frame's extent is a multiple of the base cell). */
export function refineFrame(frame: Frame, cell: number): Frame {
	const cols = Math.max(1, Math.ceil((frame.maxX - frame.minX) / cell - 1e-9));
	const rows = Math.max(1, Math.ceil((frame.maxZ - frame.minZ) / cell - 1e-9));
	return { minX: frame.minX, minZ: frame.minZ, maxX: frame.minX + cols * cell, maxZ: frame.minZ + rows * cell, cell, cols, rows };
}

export interface MapLayer {
	id: string;
	label: string;
	source: "recording" | "events";
	/** Points on the frame after the filters. */
	count: number;
	sessions: number;
	values: { value: string; count: number }[];
	/** [column, row, count, average Y?] (recording layers carry the samples' average height). */
	cells: GridCell[];
	/** Studs per cell when it isn't the frame's (positioned events with a finer `cell`); same origin. */
	cell?: number;
	/** Cells left out (past maxCells). */
	cellsCut: number;
	/** Recorded sessions that added to it (a few, for the replay). */
	examples: string[];
}

export interface LayersResult {
	mapKey: string;
	/** `confirmed`: samples whose analytics zone named the map (the rest were placed by the server's map event alone). */
	maps: { map: string; samples: number; confirmed: number; sessions: number; events: number }[];
	/** Samples with any analytics zone: above 0, the game names its places by zone, and a map with no confirmed sample has no
	 * recorded evidence of where it is (e.g. every sample was a player in a tutorial area while the server ran that map). */
	zoned: number;
	map: string | null;
	frame: Frame | null;
	/** Every recorded sample on the map (unfiltered): the walkable area's silhouette (empty with `background: false`). */
	background: GridCell[];
	layers: MapLayer[];
	/** Positioned events in the range, per kind and name. */
	catalog: { kind: string; name: string; count: number }[];
	sampling: Sampling;
	notes: string[];
}

function parseLayerId(id: string): { kind: "recording"; id: RecordingLayerId } | { kind: "events"; event: string; name: string } {
	if ((RECORDING_LAYERS as readonly string[]).includes(id)) return { kind: "recording", id: id as RecordingLayerId };
	const m = /^ev:([A-Za-z0-9_.-]{1,64}):([A-Za-z0-9_.\- ]{1,64})$/.exec(id);
	if (!m) throw new Error(`unknown layer ${JSON.stringify(id)}: one of ${RECORDING_LAYERS.join(", ")}, or ev:<kind>:<name>`);
	return { kind: "events", event: m[1], name: m[2] };
}

function recordValues(input: unknown, name: string): Record<string, string[]> {
	if (input === undefined || input === null) return {};
	if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${name} must be an object`);
	const out: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		parseLayerId(k);
		out[k] = stringList(v, `${name}.${k}`, 200) ?? [];
	}
	return out;
}

export const recordingLayers = defineQuery<LayersOptions, LayersResult>({
	name: "recording-layers",
	summary: "first-session recordings on a top-down map: path density, idle spots, deaths, screens, buttons, prompts, quits and positioned events as grid cells",
	defaultDays: 7,
	options(input = {}) {
		const layers = stringList(input.layers, "layers", 40) ?? [...RECORDING_LAYERS];
		let cell: LayerCellSize | undefined;
		if (input.cell !== undefined && input.cell !== null && (input.cell as unknown) !== "") {
			const n = Number(input.cell);
			if (!(LAYER_CELL_SIZES as readonly number[]).includes(n)) throw new Error(`cell must be one of ${LAYER_CELL_SIZES.join(", ")}`);
			cell = n as LayerCellSize;
		}
		for (const id of layers) parseLayerId(id);
		const split: Record<string, string> = {};
		if (input.split !== undefined && input.split !== null) {
			if (typeof input.split !== "object" || Array.isArray(input.split)) throw new Error("split must be an object");
			for (const [k, v] of Object.entries(input.split)) {
				if (parseLayerId(k).kind !== "events") throw new Error("split is for positioned event layers (ev:<kind>:<name>)");
				split[k] = assertSafeKey(String(v), "split key");
			}
		}
		return {
			...baseOptions(input),
			map: stringOption(input.map, "map"),
			layers,
			split,
			values: recordValues(input.values, "values"),
			zone: stringOption(input.zone, "zone", 64),
			screen: stringOption(input.screen, "screen", 64),
			grid: Math.round(numberOption(input.grid, "grid", 96, 8, 256)),
			...(cell !== undefined ? { cell } : {}),
			maxCells: Math.round(numberOption(input.maxCells, "maxCells", cell !== undefined ? 20_000 : 4000, 10, 20_000)),
			background: input.background === undefined || input.background === null ? true : input.background === true || (input.background as unknown) === "true",
		};
	},
	statements(ctx, f, o) {
		const specs: PositionedLayerSpec[] = Object.entries(o.split).map(([id, split]) => {
			const p = parseLayerId(id) as { event: string; name: string };
			return { kind: p.event, name: p.name, split };
		});
		return {
			...baseStatements(ctx, f, o),
			catalog: positionedCatalogSql(ctx, f),
			cells: positionedCellsSql(ctx, f, o.mapKey, specs, o.zone, o.screen),
		};
	},
	shape(rows, _ctx, _f, o) {
		return keep({
			mapKey: o.mapKey,
			maps: [],
			zoned: 0,
			map: null,
			frame: null,
			background: [],
			layers: [],
			catalog: (rows.catalog ?? []).map((r) => ({ kind: str(r.kind), name: str(r.name), count: num(r.n) })),
			sampling: { recorded: 0, used: 0, sampled: false, failed: 0, capped: false, eventsCapped: false },
			notes: [],
		}, rows);
	},
	async finish(result, ctx, f, o, run) {
		const rows = taken(result);
		const { prepared, sampling } = await prepareAll(rows, ctx, f, o, run, o.grid);
		const notes: string[] = [];
		if (sampling.sampled) notes.push(`Sampled ${sampling.used} of ${sampling.recorded} recorded sessions (a fixed sample for this range).`);
		if (sampling.capped) notes.push("The session list hit its row cap: narrow the range for every session.");
		if ((rows.cells ?? []).length >= Math.min(20_000, ctx.dialect.maxRows)) notes.push("Positioned events hit the row cap: the rarest cells are left out.");
		const maps = [...prepared.stats]
			.map(([map, s]) => ({ map, samples: s.samples, confirmed: s.confirmed, sessions: s.sessions.size, events: s.events }))
			.filter((m) => m.samples > 0 || m.events > 0)
			.sort((a, b) => b.samples + b.events - (a.samples + a.events) || a.map.localeCompare(b.map));
		const map = o.map !== undefined ? o.map : defaultMap(prepared);
		const auto = map !== null ? prepared.frames.get(map) : undefined;
		if (map === null || !auto) return { ...result, maps, zoned: prepared.zoned, map, sampling, notes };
		const frame = o.cell !== undefined ? refineFrame(auto, o.cell) : auto;
		// Positioned events come binned at BASE_CELL: finer frames keep them at that size (same origin).
		const eventFrame = frame.cell % BASE_CELL === 0 ? frame : refineFrame(frame, BASE_CELL);
		const mapIndex = prepared.names.indexOf(map);
		const background = new Grid(frame);
		if (o.background) for (const s of prepared.sessions) for (let i = 0; i < s.maps.length; i++) if (s.maps[i] === mapIndex && !Number.isNaN(s.track.x[i])) background.add(s.track.x[i], s.track.z[i]);
		const wantedRec = o.layers.filter((id) => parseLayerId(id).kind === "recording") as RecordingLayerId[];
		const recLayers = addRecordingLayers(prepared.sessions, mapIndex, frame, wantedRec, { zone: o.zone, screen: o.screen, values: o.values });
		const layers: MapLayer[] = [];
		for (const id of o.layers) {
			const parsed = parseLayerId(id);
			if (parsed.kind === "recording") {
				const l = recLayers.get(parsed.id);
				if (!l) continue;
				const cells = l.grid.cells(o.maxCells);
				layers.push({
					id,
					label: LAYER_LABELS[parsed.id],
					source: "recording",
					count: l.grid.total,
					sessions: l.sessions.size,
					values: valueList(l.values),
					cells,
					cellsCut: l.grid.size - cells.length,
					examples: l.examples.slice(0, 20),
				});
			} else {
				const grid = new Grid(eventFrame);
				const values = new Map<string, number>();
				const keep = o.values[id];
				const split = o.split[id] !== undefined;
				for (const c of prepared.positioned) {
					if (c.map !== map || c.kind !== parsed.event || c.name !== parsed.name || !c.keep) continue;
					const value = c.value ?? "(none)";
					if (split) values.set(value, (values.get(value) ?? 0) + c.n);
					if (split && keep?.length && !keep.includes(value)) continue;
					grid.add(c.x, c.z, c.n);
				}
				const cells = grid.cells(o.maxCells);
				layers.push({
					id,
					label: `${parsed.event} / ${parsed.name}${split ? ` by ${o.split[id]}` : ""}`,
					source: "events",
					count: grid.total,
					sessions: 0,
					values: valueList(values),
					cells,
					...(eventFrame !== frame ? { cell: eventFrame.cell } : {}),
					cellsCut: grid.size - cells.length,
					examples: [],
				});
			}
		}
		return { ...result, maps, zoned: prepared.zoned, map, frame, background: background.cells(o.maxCells * 2), layers, sampling, notes };
	},
});

function valueList(values: Map<string, number>, max = 50): { value: string; count: number }[] {
	return [...values]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
		.slice(0, max);
}

// recording-sessions ---------------------------------------------------------------------------------------------------

export interface SessionsOptions extends RecordingBaseOptions {
	/** Only sessions that were on this map... */
	map?: string;
	/** ...inside this box [x0, z0, x1, z1] (studs)... */
	box?: [number, number, number, number];
	/** ...with this layer's point there (default `path`: passed through it). */
	layer: string;
	/** Why the recording ended (left, window, cap, end; "unknown"). */
	why?: string;
	/** A confusion signal, optionally in a zone or on a button. */
	signal?: SignalKind;
	zone?: string;
	target?: string;
	/** A sid or pid prefix. */
	search?: string;
	limit: number;
}

export interface SessionSummary {
	sid: string;
	pid: string;
	art: string;
	dev: string;
	why: string | null;
	start: number;
	seconds: number;
	samples: number;
	inputs: number;
	maps: string[];
	signals: { idle: number; camera_spin: number; repeated_clicks: number };
}

export interface SessionsResult {
	total: number;
	sessions: SessionSummary[];
	sampling: Sampling;
}

const SIGNALS: SignalKind[] = ["idle", "camera_spin", "repeated_clicks"];

function zoneTimeline(events: readonly SessionEvent[]): ZoneTimeline {
	const out: ZoneTimeline = [];
	let last: string | null | undefined;
	for (const e of events) {
		if (e.state === undefined) continue;
		const zone = statePart(e.state, "zone");
		if (zone !== last) out.push({ t: e.t, zone });
		last = zone;
	}
	return out;
}

export const recordingSessions = defineQuery<SessionsOptions, SessionsResult>({
	name: "recording-sessions",
	summary: "recorded first sessions, by map cell, why the recording ended or a confusion signal (for the replay)",
	defaultDays: 7,
	options(input = {}) {
		let box: SessionsOptions["box"];
		if (input.box !== undefined && input.box !== null) {
			if (!Array.isArray(input.box) || input.box.length !== 4 || input.box.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new Error("box must be [x0, z0, x1, z1]");
			box = input.box as SessionsOptions["box"];
		}
		const layer = stringOption(input.layer, "layer", 140) ?? "path";
		if (parseLayerId(layer).kind !== "recording") throw new Error("layer must be a recording layer");
		const signal = stringOption(input.signal, "signal", 32);
		if (signal !== undefined && !SIGNALS.includes(signal as SignalKind)) throw new Error(`signal must be one of ${SIGNALS.join(", ")}`);
		return {
			...baseOptions(input),
			map: stringOption(input.map, "map"),
			box,
			layer,
			why: stringOption(input.why, "why", 32),
			signal: signal as SignalKind | undefined,
			zone: stringOption(input.zone, "zone", 64),
			target: stringOption(input.target, "target"),
			search: stringOption(input.search, "search", 64),
			limit: Math.round(numberOption(input.limit, "limit", 50, 1, 500)),
		};
	},
	statements(ctx, f, o) {
		return baseStatements(ctx, f, o);
	},
	shape(rows) {
		return keep({ total: 0, sessions: [], sampling: { recorded: 0, used: 0, sampled: false, failed: 0, capped: false, eventsCapped: false } }, rows);
	},
	async finish(result, ctx, f, o, run) {
		const rows = taken(result);
		let all = parseSessions(rows.sessions ?? []);
		if (o.search) all = all.filter((s) => s.sid.startsWith(o.search as string) || s.pid.startsWith(o.search as string));
		if (o.why) all = all.filter((s) => (s.why ?? "unknown") === o.why);
		const chosen = sampleSessions(all, o.maxSessions);
		const { loaded, failed, eventsCapped } = await loadSessions(ctx, f, chosen, run);
		const prepared = prepareMaps(loaded, sourcesFrom(rows), [], 96);
		const matched: { s: (typeof prepared.sessions)[number]; signals?: Signal[] }[] = [];
		for (const s of prepared.sessions) {
			if (o.map !== undefined) {
				const index = prepared.names.indexOf(o.map);
				if (index < 0 || !s.maps.includes(index)) continue;
				if (o.box) {
					const [x0, z0, x1, z1] = o.box;
					const b = { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) };
					if (!boxHit(s, index, b, o.layer as RecordingLayerId)) continue;
				}
			}
			let signals: Signal[] | undefined;
			if (o.signal) {
				signals = detectSignals(trackToDecoded(s.track), zoneTimeline(s.events));
				if (!signals.some((sig) => sig.kind === o.signal && (!o.zone || sig.zone === o.zone) && (!o.target || sig.target === o.target))) continue;
			}
			matched.push({ s, signals });
		}
		matched.sort((a, b) => b.s.track.start - a.s.track.start || (a.s.sid < b.s.sid ? -1 : 1));
		const out: SessionSummary[] = matched.slice(0, o.limit).map(({ s, signals }) => {
			const counts = { idle: 0, camera_spin: 0, repeated_clicks: 0 };
			for (const sig of signals ?? detectSignals(trackToDecoded(s.track), zoneTimeline(s.events))) counts[sig.kind]++;
			const used = new Set<string>();
			for (let i = 0; i < s.maps.length; i++) if (!Number.isNaN(s.track.x[i])) used.add(prepared.names[s.maps[i]]);
			return {
				sid: s.sid,
				pid: s.pid,
				art: s.art,
				dev: s.dev,
				why: s.why,
				start: s.track.start,
				seconds: Math.round((s.track.end - s.track.start) / 100) / 10,
				samples: s.track.t.length,
				inputs: s.track.inputs.length,
				maps: [...used].sort(),
				signals: counts,
			};
		});
		return {
			total: matched.length,
			sessions: out,
			sampling: { recorded: all.length, used: loaded.length, sampled: chosen.length < all.length, failed, capped: all.length >= Math.min(20_000, ctx.dialect.maxRows), eventsCapped },
		};
	},
});

/** A session had a point of `layer` inside the box on map `index` (a one-cell frame exactly over the box). */
function boxHit(s: LayerSession, index: number, b: Bounds, layer: RecordingLayerId): boolean {
	// A half-stud grid exactly over the box (the page's boxes are whole cells of 0.5 studs or more); points outside it
	// don't count.
	const half = (v: number, round: (v: number) => number) => round(v * 2) / 2;
	const minX = half(b.minX, Math.floor);
	const minZ = half(b.minZ, Math.floor);
	const cols = Math.max(1, (half(b.maxX, Math.ceil) - minX) * 2);
	const rows = Math.max(1, (half(b.maxZ, Math.ceil) - minZ) * 2);
	const frame: Frame = { minX, minZ, maxX: minX + cols / 2, maxZ: minZ + rows / 2, cell: 0.5, cols, rows };
	return (addRecordingLayers([s], index, frame, [layer], {}).get(layer)?.grid.total ?? 0) > 0;
}

// recording-replay -----------------------------------------------------------------------------------------------------

export interface ReplayOptions {
	sid: string;
	mapKey: string;
}

export interface ReplayResult {
	found: boolean;
	sid: string;
	pid?: string;
	job?: string;
	art?: string;
	dev?: string;
	why?: string | null;
	/** Absolute ms of the recording's first moment; every `t` below is ms after it. */
	start?: number;
	duration?: number;
	gaps?: number;
	chunks?: number;
	/** [t, x, y, z, yaw (radians, 0 = facing -Z, from the camera look), lookY]; x/y/z null without a character. */
	samples?: [number, number | null, number | null, number | null, number | null, number | null][];
	inputs?: (Omit<RecordingInput, "t"> & { t: number })[];
	events?: { t: number; kind: string; name: string; state?: string | null; props?: Record<string, unknown> }[];
	signals?: { t: number; kind: SignalKind; amount: number; target?: string; zone?: string }[];
	/** The map over time (from `t` on), and the map it spent most samples on. */
	maps?: { t: number; map: string }[];
	map?: string;
	/** The session's own frame on that map (the page prefers the map layer's frame when it has one). */
	frame?: Frame | null;
	failed?: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export const recordingReplay = defineQuery<ReplayOptions, ReplayResult>({
	name: "recording-replay",
	summary: "one recorded session for the top-down replay: samples, inputs, events, confusion signals and maps",
	defaultDays: 30,
	options(input = {}) {
		return { sid: checkId(input.sid, "sid"), mapKey: assertSafeKey(stringOption(input.mapKey, "mapKey", 64) ?? "map", "mapKey") };
	},
	statements(ctx, f, o) {
		const why = ctx.dialect.jsonText("e.props", "why");
		return {
			meta:
				`SELECT MAX(CASE WHEN e.dev IS NOT NULL AND e.dev <> '' AND e.dev <> 'unknown' THEN e.dev ELSE NULL END) AS dev, ` +
				`MAX(CASE WHEN e.kind = 'recording_meta' AND e.name = 'end' THEN ${why} ELSE NULL END) AS why, COUNT(*) AS n ` +
				`FROM ${eventsTable(ctx, f)} e WHERE e.t >= ${int(f.from)} AND e.t < ${int(f.to)} AND e.sid = ${lit(o.sid)} ${ctx.dialect.limit(1)}`,
			events:
				`SELECT e.t AS t, e.kind AS kind, e.name AS name, e.state AS state, e.props AS props, e.job AS job FROM ${eventsTable(ctx, f)} e ` +
				`WHERE e.t >= ${int(f.from)} AND e.t < ${int(f.to)} AND e.sid = ${lit(o.sid)} AND e.kind <> 'tech' ORDER BY e.t, e.kind, e.name ${ctx.dialect.limit(3000)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const m = rows.meta[0] ?? {};
		return keep({ found: false, sid: o.sid, dev: strOrNull(m.dev) ?? "unknown", why: strOrNull(m.why) }, rows);
	},
	async finish(result, ctx, f, o, run) {
		const lim = ctx.dialect.limit;
		const firstRows = taken(result);
		const chunkRows = await run({
				chunks:
					`SELECT r.sid AS sid, r.pid AS pid, r.job AS job, r.art AS art, r.chunk AS chunk, r.codec AS codec, r.data AS data, r.n AS n, r.t AS t ` +
					`FROM ${recTable(ctx, f)} r WHERE r.t >= ${int(f.from)} AND r.t < ${int(f.to)} AND r.sid = ${lit(o.sid)} ORDER BY r.chunk ${lim(10_000)}`,
		});
		const first = { chunks: chunkRows.chunks ?? [], events: firstRows.events ?? [] };
		if (!first.chunks.length) return result;
		const c0 = first.chunks[0];
		const job = str(c0.job);
		const pid = str(c0.pid);
		const chunks: ChunkRow[] = first.chunks.map((r) => ({ sid: str(r.sid), pid: str(r.pid), chunk: num(r.chunk), codec: str(r.codec) as ChunkRow["codec"], data: str(r.data), n: num(r.n), t: num(r.t) }));
		const decoded = decodeSessions(chunks);
		if (!decoded.recordings.length) return { ...result, found: true, pid, job, art: str(c0.art), chunks: chunks.length, failed: decoded.errors[0] ?? "did not decode" };
		const track = toTrack(decoded.recordings[0], { job, art: str(c0.art), start: num(c0.t) });
		const events: SessionEvent[] = first.events.map((r) => {
			const e: SessionEvent = { t: num(r.t), kind: str(r.kind), name: str(r.name), state: strOrNull(r.state) };
			const props = parseProps(r.props);
			if (props) e.props = props;
			return e;
		});
		const map = mapExpr(ctx, o.mapKey);
		const around = `e.t >= ${int(track.start - MAP_LOOKBACK_MS)} AND e.t <= ${int(track.end + AFTER_LAST_CHUNK_MS)}`;
		const maps = await run({
			jobMaps: `SELECT e.job AS k, e.t AS t, ${map} AS map FROM ${ctx.table("events", track.start - MAP_LOOKBACK_MS, track.end + AFTER_LAST_CHUNK_MS)} e WHERE ${around} AND e.job = ${lit(job || "-")} AND ${map} IS NOT NULL ORDER BY e.t, map ${lim(5000)}`,
			pidMaps: `SELECT e.pid AS k, e.t AS t, ${map} AS map FROM ${ctx.table("events", track.start - MAP_LOOKBACK_MS, track.end + AFTER_LAST_CHUNK_MS)} e WHERE ${around} AND e.pid = ${lit(pid || "-")} AND ${map} IS NOT NULL ORDER BY e.t, map ${lim(5000)}`,
		});
		const session: LoadedSession = { sid: o.sid, pid, job, art: str(c0.art), t0: track.start, t1: track.end, chunks: chunks.length, n: track.t.length, bytes: 0, dev: result.dev ?? "unknown", why: result.why ?? null, track, events };
		const prepared = prepareMaps([session], sourcesFrom(maps), [], 96);
		const s = prepared.sessions[0];
		const segments: { t: number; map: string }[] = [];
		const perMap = new Map<string, number>();
		for (let i = 0; i < s.maps.length; i++) {
			const name = prepared.names[s.maps[i]];
			if (segments.at(-1)?.map !== name) segments.push({ t: Math.round(track.t[i] - track.start), map: name });
			if (!Number.isNaN(track.x[i])) perMap.set(name, (perMap.get(name) ?? 0) + 1);
		}
		const dominant = [...perMap].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? NO_MAP;
		const rel = (t: number) => Math.round(t - track.start);
		const samples: NonNullable<ReplayResult["samples"]> = [];
		for (let i = 0; i < track.t.length; i++) {
			const has = !Number.isNaN(track.x[i]);
			const look = !Number.isNaN(track.lx[i]);
			samples.push([
				rel(track.t[i]),
				has ? r2(track.x[i]) : null,
				has ? r2(track.y[i]) : null,
				has ? r2(track.z[i]) : null,
				look ? r2(Math.atan2(-track.lx[i], -track.lz[i])) : null,
				look ? r2(track.ly[i]) : null,
			]);
		}
		return {
			...result,
			found: true,
			pid,
			job,
			art: str(c0.art),
			start: track.start,
			duration: rel(track.end),
			gaps: track.gaps,
			chunks: chunks.length,
			samples,
			inputs: track.inputs.map((i) => ({ ...i, t: rel(i.t) })),
			events: events.map((e) => ({ ...e, t: rel(e.t) })),
			signals: detectSignals(trackToDecoded(track), zoneTimeline(events)).map((sig) => ({
				t: rel(sig.t),
				kind: sig.kind,
				amount: sig.amount,
				...(sig.target !== undefined ? { target: sig.target } : {}),
				...(sig.zone !== undefined ? { zone: sig.zone } : {}),
			})),
			maps: segments,
			map: dominant,
			frame: prepared.frames.get(dominant) ?? null,
		};
	},
});

// quit-autopsy ---------------------------------------------------------------------------------------------------------

export interface AutopsyQueryOptions extends RecordingBaseOptions, AutopsyOptions {
	/** Most example sessions per reason. Default 5. */
	examples: number;
}

export interface AutopsyResult {
	windowSeconds: number;
	/** Recordings that ended with the player leaving, and the rest. */
	left: number;
	stayed: number;
	byWhy: { why: string; sessions: number }[];
	rows: AutopsyRow[];
	sampling: Sampling;
}

export const quitAutopsy = defineQuery<AutopsyQueryOptions, AutopsyResult>({
	name: "quit-autopsy",
	summary: "why first-session players quit: their last seconds (screen open, died, idle, dead clicks, stuck, tutorial step, place) against those who stayed",
	defaultDays: 7,
	options(input = {}) {
		const list = stringList(input.downEvents, "downEvents", 20);
		const pattern = stringOption(input.tutorialPattern, "tutorialPattern", 100) ?? AUTOPSY_DEFAULTS.tutorialPattern;
		try {
			new RegExp(pattern, "i");
		} catch {
			throw new Error("tutorialPattern must be a regular expression");
		}
		return {
			...baseOptions(input),
			windowSeconds: numberOption(input.windowSeconds, "windowSeconds", AUTOPSY_DEFAULTS.windowSeconds, 1, 120),
			diedSeconds: numberOption(input.diedSeconds, "diedSeconds", AUTOPSY_DEFAULTS.diedSeconds, 1, 300),
			downEvents: list ?? AUTOPSY_DEFAULTS.downEvents,
			tutorialPattern: pattern,
			stillStuds: numberOption(input.stillStuds, "stillStuds", AUTOPSY_DEFAULTS.stillStuds, 0, 100),
			stuckStuds: numberOption(input.stuckStuds, "stuckStuds", AUTOPSY_DEFAULTS.stuckStuds, 0, 100),
			deadClickMs: numberOption(input.deadClickMs, "deadClickMs", AUTOPSY_DEFAULTS.deadClickMs, 100, 10_000),
			placeCells: Math.round(numberOption(input.placeCells, "placeCells", AUTOPSY_DEFAULTS.placeCells, 1, 26)),
			examples: Math.round(numberOption(input.examples, "examples", 5, 0, 50)),
		};
	},
	statements(ctx, f, o) {
		return baseStatements(ctx, f, o);
	},
	shape(rows, _ctx, _f, o) {
		return keep({ windowSeconds: o.windowSeconds, left: 0, stayed: 0, byWhy: [], rows: [], sampling: { recorded: 0, used: 0, sampled: false, failed: 0, capped: false, eventsCapped: false } }, rows);
	},
	async finish(result, ctx, f, o, run) {
		const rows = taken(result);
		const { prepared, sampling } = await prepareAll(rows, ctx, f, o, run);
		const tutorialMax = tutorialMaxSteps(
			prepared.sessions.map((s) => s.events),
			o.tutorialPattern,
		);
		const byWhy = new Map<string, number>();
		const classified = prepared.sessions.map((s) => {
			byWhy.set(s.why ?? "unknown", (byWhy.get(s.why ?? "unknown") ?? 0) + 1);
			const pos = lastPosition(s.track);
			let lastIndex = s.track.t.length - 1;
			while (lastIndex >= 0 && Number.isNaN(s.track.x[lastIndex])) lastIndex--;
			const map = pos && lastIndex >= 0 ? prepared.names[s.maps[lastIndex]] : undefined;
			return { sid: s.sid, left: s.why === "left", hits: classifyEnding({ track: s.track, events: s.events, map, frame: map ? prepared.frames.get(map) : undefined, tutorialMax }, o) };
		});
		const summary = summarizeAutopsy(classified, o.examples);
		// Places: only the 15 with the most quitters.
		const places = summary.rows.filter((r) => r.reason === "place").slice(0, 15);
		const rowsOut = summary.rows.filter((r) => r.reason !== "place").concat(places);
		return {
			...result,
			left: summary.left,
			stayed: summary.stayed,
			byWhy: [...byWhy].map(([why, sessions]) => ({ why, sessions })).sort((a, b) => b.sessions - a.sessions || a.why.localeCompare(b.why)),
			rows: rowsOut,
			sampling,
		};
	},
});

// first-action ---------------------------------------------------------------------------------------------------------

export interface FirstActionQueryOptions extends RecordingBaseOptions {
	/** Custom events that mean a round started. Default round_start, phase. */
	roundEvents: string[];
	moveStuds: number;
	screenAfterInputMs: number;
}

export interface FirstActionSplit {
	value: string;
	sessions: number;
	stats: Pick<FirstActionStat, "action" | "reached" | "share" | "median">[];
}

export interface FirstActionResult {
	sessions: number;
	/** Per action, a few sessions to replay (the slowest to reach it, and some that never did). */
	stats: (FirstActionStat & { examples: { slowest: string[]; never: string[] } })[];
	byDevice: FirstActionSplit[];
	byBuild: FirstActionSplit[];
	sampling: Sampling;
}

export const firstAction = defineQuery<FirstActionQueryOptions, FirstActionResult>({
	name: "first-action",
	summary: "first sessions: seconds from spawn to the first move, screen, button, prompt and round start, by device and build",
	defaultDays: 7,
	options(input = {}) {
		const rounds = stringList(input.roundEvents, "roundEvents", 20) ?? ["round_start", "phase"];
		for (const r of rounds) assertSafeKey(r, "round event");
		return {
			...baseOptions(input),
			roundEvents: rounds,
			moveStuds: numberOption(input.moveStuds, "moveStuds", FIRST_ACTION_DEFAULTS.moveStuds, 0.5, 100),
			screenAfterInputMs: numberOption(input.screenAfterInputMs, "screenAfterInputMs", FIRST_ACTION_DEFAULTS.screenAfterInputMs, 0, 60_000),
		};
	},
	statements(ctx, f, o) {
		const names = o.roundEvents.map(lit).join(", ");
		const recorded = `SELECT r.sid AS sid, MIN(r.job) AS job, MIN(r.t) AS t0 FROM ${recTable(ctx, f)} r WHERE ${recWhere(ctx, f)} AND r.sid IS NOT NULL AND r.sid <> '' GROUP BY r.sid`;
		return {
			...baseStatements(ctx, f, o),
			rounds:
				`WITH rs AS (${recorded}), ` +
				`ev AS (SELECT e.sid AS sid, e.job AS job, e.t AS t FROM ${eventsTable(ctx, f)} e WHERE e.t >= ${int(f.from)} AND e.t < ${int(f.to)} AND e.kind = 'custom' AND e.name IN (${names})), ` +
				`a AS (SELECT rs.sid AS sid, ev.t AS t FROM rs JOIN ev ON ev.sid = rs.sid WHERE ev.t >= rs.t0 ` +
				`UNION ALL SELECT rs.sid AS sid, ev.t AS t FROM rs JOIN ev ON ev.job = rs.job WHERE (ev.sid IS NULL OR ev.sid = '') AND ev.t >= rs.t0) ` +
				`SELECT sid, MIN(t) AS t FROM a GROUP BY sid ORDER BY sid ${ctx.dialect.limit(20_000)}`,
		};
	},
	shape(rows) {
		return keep({ sessions: 0, stats: [], byDevice: [], byBuild: [], sampling: { recorded: 0, used: 0, sampled: false, failed: 0, capped: false, eventsCapped: false } }, rows);
	},
	async finish(result, ctx, f, o, run) {
		const rows = taken(result);
		const all = parseSessions(rows.sessions ?? []);
		const chosen = sampleSessions(all, o.maxSessions);
		const { loaded, failed, eventsCapped } = await loadSessions(ctx, f, chosen, run, { events: false });
		const rounds = new Map((rows.rounds ?? []).map((r) => [str(r.sid), num(r.t)]));
		const per = loaded.map((s) => ({ s, actions: firstActions(s.track, rounds.get(s.sid) ?? null, o) }));
		const split = (key: (s: LoadedSession) => string): FirstActionSplit[] => {
			const groups = new Map<string, FirstActions[]>();
			for (const { s, actions } of per) {
				const k = key(s);
				const list = groups.get(k) ?? [];
				list.push(actions);
				groups.set(k, list);
			}
			return [...groups]
				.map(([value, list]) => ({
					value,
					sessions: list.length,
					stats: firstActionStats(list).map(({ action, reached, share, median }) => ({ action, reached, share, median })),
				}))
				.sort((a, b) => b.sessions - a.sessions || a.value.localeCompare(b.value));
		};
		return {
			...result,
			sessions: per.filter((p) => p.actions.spawn !== null).length,
			stats: firstActionStats(per.map((p) => p.actions)).map((stat) => ({ ...stat, examples: firstActionExamples(per, stat.action) })),
			byDevice: split((s) => s.dev),
			byBuild: split((s) => s.art || "(none)"),
			sampling: { recorded: all.length, used: loaded.length, sampled: chosen.length < all.length, failed, capped: all.length >= Math.min(20_000, ctx.dialect.maxRows), eventsCapped },
		};
	},
});

/** A few sessions to replay per action: the slowest that reached it, and ones that never did (spawned only). */
export function firstActionExamples(per: readonly { s: { sid: string }; actions: FirstActions }[], action: FirstAction, max = 3): { slowest: string[]; never: string[] } {
	const counted = per.filter((p) => p.actions.spawn !== null);
	const slowest = counted
		.filter((p) => p.actions.seconds[action] !== null)
		.sort((a, b) => (b.actions.seconds[action] as number) - (a.actions.seconds[action] as number) || (a.s.sid < b.s.sid ? -1 : 1))
		.slice(0, max)
		.map((p) => p.s.sid);
	const never = counted
		.filter((p) => p.actions.seconds[action] === null)
		.map((p) => p.s.sid)
		.sort()
		.slice(0, max);
	return { slowest, never };
}
