/**
 * Plans/34: game-defined remote debug, streams, the live map and custom fleet columns. All of it IN MEMORY (this process):
 *
 *   game      POST /v1/fleet/heartbeat { ..., xh?, x?, cv? } -> { ok, rd?, xq?, lm? }
 *               `xh` the declarations' hash (every heartbeat while the game declared anything), `x` the declarations
 *               (first heartbeat, on a change, when asked: `xq: 1`), `cv` the column values (stored with the server row
 *               by the fleet service; parseColumnValues here).
 *   game      POST /v1/fleet/streams { j, frames: [{ t, s: { <stream>: value } }] } -> { ok, watch, lm }
 *   explorer  POST /v1/fleet/live-map/watch    the /live page is open (every 20 s; lapses after 60 s)
 *   explorer  GET  /v1/fleet/servers/<job>/streams?since=   -> { declared: { streams, commands }, frames }
 *   explorer  GET  /v1/fleet/live-map           -> { servers: [{ job, branch, artifact, at, players }] }
 *   explorer  GET  /v1/fleet/columns            -> { columns } (the union of the live servers' declared columns)
 *
 * Frames hold player names, UserIds and positions: a ring of the last RING_MS per job, never on disk, the bus, /v1/live
 * or a log line, dropped when the job is lost or closed. Declarations are game metadata (names, labels), also in memory
 * only: a restarted backend asks for them again (`xq: 1`).
 *
 * The heartbeat's `x` key: older kernels send `x = 1` there (an A/B experiment pin). Plans/34 puts the declarations
 * object under the same key, so they are told apart by type: an object is the declarations, a number / boolean / string
 * the experiment flag (parseHeartbeat keeps the stored flag for a heartbeat that carried declarations instead).
 */

/** Command, stream and column names. */
export const DECL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const COLUMNS_MAX = 16;
export const COMMANDS_MAX = 32;
export const STREAMS_MAX = 8;
export const LABEL_MAX = 40;
export const DESCRIPTION_MAX = 200;
/** A column's string value at most (characters). */
export const COLUMN_TEXT_MAX = 64;
export const STREAM_HZ_MIN = 0.2;
export const STREAM_HZ_MAX = 4;
/** The declarations' hash at most (characters). */
export const HASH_MAX = 64;
/** Jobs whose declarations are held at most (the oldest heartbeat goes first). */
export const DECLARED_JOBS_MAX = 5000;
/** Declarations of a job without a heartbeat this long are dropped (lost / closed drop them sooner). */
export const DECLARED_IDLE_MS = 10 * 60_000;

/** The built-in stream (the kernel's, no game code). */
export const POSITIONS = "positions";
/** How long frames are kept per job. */
export const RING_MS = 120_000;
/** POST /v1/fleet/streams at most. */
export const STREAMS_BODY_MAX = 64 * 1024;
/** One stream value at most (JSON text); bigger ones are dropped and counted. */
export const STREAM_VALUE_MAX = 16 * 1024;
/** Frames in one post at most (one second at 4 Hz is 4; slack for a late post). */
export const FRAMES_PER_POST_MAX = 32;
/** Bytes of frames per watched job (the server page open) at most; the oldest go first. */
export const RING_BYTES_WATCHED = 4 * 1024 * 1024;
/** Bytes of frames per job seen only by the live map (one positions frame every 3 s). */
export const RING_BYTES_LIVE_MAP = 512 * 1024;
/** Bytes of frames held at all. */
export const RING_BYTES_MAX = 96 * 1024 * 1024;
/** Players kept from one positions frame, points from one points frame. */
export const PLAYERS_MAX = 200;
export const POINTS_MAX = 500;

/** The fleet-wide live map watch lasts this long after the /live page last said so (it repeats every 20 s). */
export const LIVE_MAP_WATCH_MS = 60_000;
/** A server is on the live map while its latest positions frame is this recent. */
export const LIVE_MAP_FRESH_MS = 15_000;

export class LiveDebugInputError extends Error {}

export type ColumnType = "string" | "number" | "bool";
export interface ColumnDecl {
	n: string;
	l?: string;
	t?: ColumnType;
}
export interface CommandDecl {
	n: string;
	l?: string;
	d?: string;
}
export type StreamKind = "points" | "json";
export interface StreamDecl {
	n: string;
	hz: number;
	k: StreamKind;
	l?: string;
}
export interface Declarations {
	c: ColumnDecl[];
	cmd: CommandDecl[];
	st: StreamDecl[];
}

export type ColumnValue = string | number | boolean | null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Text without control characters, cut to `max` (labels and descriptions are display text). */
function label(v: unknown, max: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const clean = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
	return clean || undefined;
}

function entries<T>(raw: unknown, max: number, one: (r: Record<string, unknown>, name: string) => T): T[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of raw) {
		if (out.length >= max) break;
		if (!isRecord(item) || typeof item.n !== "string" || !DECL_NAME.test(item.n) || seen.has(item.n)) continue;
		seen.add(item.n);
		out.push(one(item, item.n));
	}
	return out;
}

/**
 * The heartbeat's `x` (plans/34) cleaned: bad entries (a name that doesn't match DECL_NAME, a repeat, a stream without
 * a rate) are left out, labels cut to their limits, rates clamped to 0.2-4 Hz, past the limits the rest dropped. Null
 * when `x` isn't an object (an older kernel's experiment flag). Never a reason to refuse the heartbeat.
 */
export function parseDeclarations(raw: unknown): Declarations | null {
	if (!isRecord(raw)) return null;
	return {
		c: entries(raw.c, COLUMNS_MAX, (r, n) => {
			const l = label(r.l, LABEL_MAX);
			const t = r.t === "string" || r.t === "number" || r.t === "bool" ? r.t : undefined;
			return { n, ...(l ? { l } : {}), ...(t ? { t } : {}) };
		}),
		cmd: entries(raw.cmd, COMMANDS_MAX, (r, n) => {
			const l = label(r.l, LABEL_MAX);
			const d = label(r.d, DESCRIPTION_MAX);
			return { n, ...(l ? { l } : {}), ...(d ? { d } : {}) };
		}),
		st: entries(raw.st, STREAMS_MAX, (r, n) => {
			const l = label(r.l, LABEL_MAX);
			const hz = finite(r.hz) ? Math.min(STREAM_HZ_MAX, Math.max(STREAM_HZ_MIN, r.hz)) : STREAM_HZ_MIN;
			return { n, hz, k: r.k === "points" ? "points" : "json", ...(l ? { l } : {}) } satisfies StreamDecl;
		}),
	};
}

/**
 * The heartbeat's `cv`: `{ <name>: string (<= 64) | number | bool | null }` as JSON text, or null (missing, not an
 * object, nothing valid). Names that don't match DECL_NAME are left out, at most COLUMNS_MAX kept, longer strings cut,
 * other values (objects, NaN) stored as null.
 */
export function parseColumnValues(raw: unknown): string | null {
	if (!isRecord(raw)) return null;
	const out: Record<string, ColumnValue> = {};
	let n = 0;
	for (const [key, value] of Object.entries(raw)) {
		if (n >= COLUMNS_MAX) break;
		if (!DECL_NAME.test(key)) continue;
		n++;
		if (typeof value === "string") out[key] = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, COLUMN_TEXT_MAX);
		else if (typeof value === "boolean") out[key] = value;
		else if (finite(value) && Math.abs(value) <= 9e15) out[key] = value;
		else out[key] = null;
	}
	return n ? JSON.stringify(out) : null;
}

/** The stored column values as an object (null: none, or not readable). */
export function columnValuesOf(text: string | null | undefined): Record<string, ColumnValue> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return isRecord(value) ? (value as Record<string, ColumnValue>) : null;
	} catch {
		return null;
	}
}

// Stream values ---------------------------------------------------------------------------------------------------------------

export interface LivePlayer {
	u: number;
	n: string;
	x?: number;
	y?: number;
	z?: number;
	yaw?: number;
	hp?: number;
	st: "alive" | "dead" | "none";
}

export interface StreamPoint {
	x: number;
	y: number;
	z: number;
	label?: string;
	color?: string;
}

const COLOR = /^[#a-zA-Z0-9(),.% ]{1,32}$/;
const coordinate = (v: unknown): number | undefined => (finite(v) && Math.abs(v) <= 1e6 ? Math.round(v * 10) / 10 : undefined);

/** A `positions` value cleaned to its documented fields (players without a UserId or name are left out); null if it isn't one. */
export function cleanPositions(value: unknown): { players: LivePlayer[] } | null {
	if (!isRecord(value) || !Array.isArray(value.players)) return null;
	const players: LivePlayer[] = [];
	for (const p of value.players) {
		if (players.length >= PLAYERS_MAX) break;
		if (!isRecord(p) || !finite(p.u) || !Number.isSafeInteger(p.u) || p.u < 0) continue;
		const n = label(p.n, 64);
		if (!n) continue;
		const st = p.st === "alive" || p.st === "dead" || p.st === "none" ? p.st : "alive";
		const x = coordinate(p.x);
		const y = coordinate(p.y);
		const z = coordinate(p.z);
		const placed = st !== "none" && x !== undefined && y !== undefined && z !== undefined;
		players.push({
			u: p.u,
			n,
			...(placed ? { x, y, z } : {}),
			...(placed && finite(p.yaw) ? { yaw: Math.round(p.yaw * 100) / 100 } : {}),
			...(finite(p.hp) ? { hp: Math.round(p.hp * 10) / 10 } : {}),
			st: placed ? st : "none",
		});
	}
	return { players };
}

/** A `points` stream's value cleaned (points without x / y / z left out); null if it isn't one. */
export function cleanPoints(value: unknown): { points: StreamPoint[] } | null {
	if (!isRecord(value) || !Array.isArray(value.points)) return null;
	const points: StreamPoint[] = [];
	for (const p of value.points) {
		if (points.length >= POINTS_MAX) break;
		if (!isRecord(p)) continue;
		const x = coordinate(p.x);
		const y = coordinate(p.y);
		const z = coordinate(p.z);
		if (x === undefined || y === undefined || z === undefined) continue;
		const l = label(p.label, 64);
		const color = typeof p.color === "string" && COLOR.test(p.color) ? p.color : undefined;
		points.push({ x, y, z, ...(l ? { label: l } : {}), ...(color ? { color } : {}) });
	}
	return { points };
}

// The hub -------------------------------------------------------------------------------------------------------------------

export interface Frame {
	/** The kernel's sample time, unix ms. */
	t: number;
	s: Record<string, unknown>;
}

interface StoredFrame extends Frame {
	/** When it arrived (this clock). */
	at: number;
	bytes: number;
}

interface Ring {
	frames: StoredFrame[];
	bytes: number;
}

export interface LiveMapWatch {
	until: number;
	/** This call started the watch (it wasn't holding). */
	started: boolean;
	/** A wake went out (`sent`), or why not. */
	wake: "sent" | "recent" | "limited" | "off" | "none";
}

export interface LiveDebugOptions {
	clock?: () => number;
	/** The server page watches this job (remote-debug.ts isWatched): its streams post with `watch: true`. */
	isWatched?: (job: string) => boolean;
	/** Publishes the `{"k":"lm"}` wake (remote-debug-wake.ts wakeLiveMap; none: heartbeat replies only). */
	wakeLiveMap?: () => "sent" | "recent" | "limited" | "off";
	/** Bounds (tests pass small ones). */
	ringBytesMax?: number;
	declaredJobsMax?: number;
}

export interface IngestResult {
	ok: true;
	watch: boolean;
	lm: boolean;
	/** Frames kept, stream values dropped (undeclared, too big, malformed). */
	accepted: number;
	dropped: number;
}

export class LiveDebugHub {
	private readonly clock: () => number;
	private readonly declared = new Map<string, { hash: string | null; decl: Declarations; seen: number }>();
	private readonly rings = new Map<string, Ring>();
	private ringBytes = 0;
	private liveMapUntil = 0;
	readonly stats = { frames: 0, dropped: 0, tooBig: 0, undeclared: 0, idle: 0, asked: 0, evicted: 0 };

	constructor(private readonly options: LiveDebugOptions = {}) {
		this.clock = options.clock ?? Date.now;
	}

	// Declarations (the heartbeat) ------------------------------------------------------------------------------------------

	/**
	 * A heartbeat's plans/34 fields: keeps `x` when it came, and says what the reply carries: `xq: 1` when the heartbeat
	 * names a hash (`xh`) this process holds no declarations for, `lm: 1` while the live map is watched. A heartbeat
	 * without `xh` or `x` declared nothing: what was held for the job goes.
	 */
	heartbeat(job: string, body: unknown): { xq?: 1; lm?: 1 } {
		const now = this.clock();
		const b = isRecord(body) ? body : {};
		const hash = typeof b.xh === "string" && b.xh.length > 0 && b.xh.length <= HASH_MAX ? b.xh : null;
		const decl = parseDeclarations(b.x);
		let ask = false;
		if (decl) {
			this.declared.delete(job);
			this.declared.set(job, { hash, decl, seen: now });
			this.trimDeclared();
		} else if (hash) {
			const held = this.declared.get(job);
			if (held && held.hash === hash) {
				held.seen = now;
			} else {
				ask = true;
				this.stats.asked++;
			}
		} else {
			this.declared.delete(job);
		}
		return { ...(ask ? { xq: 1 as const } : {}), ...(this.liveMapOn() ? { lm: 1 as const } : {}) };
	}

	private trimDeclared(): void {
		const max = this.options.declaredJobsMax ?? DECLARED_JOBS_MAX;
		// A Map iterates in insertion order and every new set re-inserts: the first entries are the stalest.
		for (const job of this.declared.keys()) {
			if (this.declared.size <= max) break;
			this.declared.delete(job);
		}
	}

	/** What `job` declared (undefined: nothing, or not received yet). */
	declarations(job: string): Declarations | undefined {
		return this.declared.get(job)?.decl;
	}

	/** Whether `job` declared the command `name` (the remote-debug hub accepts `game.<name>` only then). */
	hasCommand(job: string, name: string): boolean {
		return this.declared.get(job)?.decl.cmd.some((c) => c.n === name) ?? false;
	}

	/**
	 * The Fleet page's game columns: the union of the declared columns of `jobs` (the live servers), by name; the first
	 * label and type seen win. Sorted by name.
	 */
	columns(jobs: Iterable<string>): ColumnDecl[] {
		const out = new Map<string, ColumnDecl>();
		for (const job of jobs) for (const c of this.declared.get(job)?.decl.c ?? []) if (!out.has(c.n)) out.set(c.n, c);
		return [...out.values()].sort((a, b) => a.n.localeCompare(b.n));
	}

	// Streams ---------------------------------------------------------------------------------------------------------------

	/** POST /v1/fleet/streams' body (the HTTP edge checked the key, the JobId and the size). Throws LiveDebugInputError. */
	ingest(job: string, body: unknown): IngestResult {
		const now = this.clock();
		const watch = this.options.isWatched?.(job) ?? false;
		const lm = this.liveMapOn();
		const b = isRecord(body) ? body : {};
		if (!Array.isArray(b.frames)) throw new LiveDebugInputError("frames must be a list");
		if (b.frames.length > FRAMES_PER_POST_MAX) throw new LiveDebugInputError(`at most ${FRAMES_PER_POST_MAX} frames a post`);
		// Nobody looks: nothing is kept (the reply tells the kernel to stop).
		if (!watch && !lm) {
			this.stats.idle++;
			return { ok: true, watch, lm, accepted: 0, dropped: 0 };
		}
		const streams = new Map<string, StreamDecl>((this.declared.get(job)?.decl.st ?? []).map((s) => [`game.${s.n}`, s]));
		let accepted = 0;
		let dropped = 0;
		for (const raw of b.frames) {
			if (!isRecord(raw) || !finite(raw.t) || raw.t < 0 || raw.t > 9e15 || !isRecord(raw.s)) {
				dropped++;
				continue;
			}
			const s: Record<string, unknown> = {};
			let bytes = 0;
			for (const [name, value] of Object.entries(raw.s)) {
				const decl = name === POSITIONS ? undefined : streams.get(name);
				if (name !== POSITIONS && !decl) {
					dropped++;
					this.stats.undeclared++;
					continue;
				}
				const clean = name === POSITIONS ? cleanPositions(value) : decl?.k === "points" ? cleanPoints(value) : value;
				if (clean === null || clean === undefined) {
					dropped++;
					continue;
				}
				const text = JSON.stringify(clean);
				if (text === undefined || text.length > STREAM_VALUE_MAX) {
					dropped++;
					this.stats.tooBig++;
					continue;
				}
				s[name] = clean;
				bytes += text.length + name.length;
			}
			if (!Object.keys(s).length) continue;
			this.push(job, { t: Math.round(raw.t), s, at: now, bytes: bytes + 32 }, watch);
			accepted++;
		}
		this.stats.frames += accepted;
		this.stats.dropped += dropped;
		this.trimAll(now);
		return { ok: true, watch, lm, accepted, dropped };
	}

	private push(job: string, frame: StoredFrame, watched: boolean): void {
		let ring = this.rings.get(job);
		if (!ring) {
			ring = { frames: [], bytes: 0 };
			this.rings.set(job, ring);
		}
		ring.frames.push(frame);
		ring.bytes += frame.bytes;
		this.ringBytes += frame.bytes;
		const cap = watched ? RING_BYTES_WATCHED : RING_BYTES_LIVE_MAP;
		while (ring.bytes > cap && ring.frames.length > 1) this.shift(ring);
	}

	private shift(ring: Ring): void {
		const old = ring.frames.shift();
		if (!old) return;
		ring.bytes -= old.bytes;
		this.ringBytes -= old.bytes;
	}

	/** Old frames out; past the global cap, the oldest frames of jobs the server page doesn't watch go first. */
	private trimAll(now: number): void {
		for (const [job, ring] of this.rings) {
			while (ring.frames.length && (ring.frames[0] as StoredFrame).at < now - RING_MS) this.shift(ring);
			if (!ring.frames.length) this.rings.delete(job);
		}
		const max = this.options.ringBytesMax ?? RING_BYTES_MAX;
		while (this.ringBytes > max) {
			let victim: Ring | undefined;
			let victimWatched = true;
			for (const [job, ring] of this.rings) {
				if (ring.frames.length < 2) continue;
				const watched = this.options.isWatched?.(job) ?? false;
				if (!victim || (victimWatched && !watched) || (victimWatched === watched && ring.bytes > victim.bytes)) {
					victim = ring;
					victimWatched = watched;
				}
			}
			if (!victim) break;
			this.shift(victim);
			this.stats.evicted++;
		}
	}

	/** `job`'s frames (sample time after `since`, if given), oldest first. */
	frames(job: string, since?: number): Frame[] {
		this.trimAll(this.clock());
		const ring = this.rings.get(job);
		if (!ring) return [];
		return ring.frames.filter((f) => since === undefined || f.t > since).map((f) => ({ t: f.t, s: f.s }));
	}

	/** Every job's latest positions frame of the last LIVE_MAP_FRESH_MS: { t, players }. */
	latestPositions(): Map<string, { at: number; players: LivePlayer[] }> {
		const now = this.clock();
		this.trimAll(now);
		const out = new Map<string, { at: number; players: LivePlayer[] }>();
		for (const [job, ring] of this.rings) {
			for (let i = ring.frames.length - 1; i >= 0; i--) {
				const f = ring.frames[i] as StoredFrame;
				if (f.at < now - LIVE_MAP_FRESH_MS) break;
				const value = f.s[POSITIONS] as { players: LivePlayer[] } | undefined;
				if (value) {
					out.set(job, { at: f.t, players: value.players });
					break;
				}
			}
		}
		return out;
	}

	/** The job is lost or closed: its declarations and frames go now. */
	forget(job: string): void {
		this.declared.delete(job);
		const ring = this.rings.get(job);
		if (ring) {
			this.ringBytes -= ring.bytes;
			this.rings.delete(job);
		}
	}

	// The live map (/live) ----------------------------------------------------------------------------------------------------

	liveMapOn(): boolean {
		return this.liveMapUntil > this.clock();
	}

	get liveMapWatchedUntil(): number | null {
		return this.liveMapOn() ? this.liveMapUntil : null;
	}

	/** The /live page is open: the watch holds LIVE_MAP_WATCH_MS more; one that starts wakes every server (rate-limited). */
	watchLiveMap(): LiveMapWatch {
		const now = this.clock();
		const started = this.liveMapUntil <= now;
		this.liveMapUntil = now + LIVE_MAP_WATCH_MS;
		const wake = started ? (this.options.wakeLiveMap?.() ?? "off") : "none";
		return { until: this.liveMapUntil, started, wake };
	}

	// Housekeeping --------------------------------------------------------------------------------------------------------------

	sweep(): void {
		const now = this.clock();
		this.trimAll(now);
		for (const [job, d] of this.declared) if (now - d.seen > DECLARED_IDLE_MS) this.declared.delete(job);
	}

	/** For /healthz (counts only). */
	get memory(): { declared: number; streamJobs: number; streamBytes: number; liveMap: boolean } {
		return { declared: this.declared.size, streamJobs: this.rings.size, streamBytes: this.ringBytes, liveMap: this.liveMapOn() };
	}
}
