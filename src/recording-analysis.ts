/**
 * The recordings explorer's analyses (plans/16, the Recordings page), as plain functions over decoded sessions so they
 * can be tested without a database:
 *   - Track: a decoded session in typed arrays (what the decoded-session cache keeps, ~32 bytes a sample);
 *   - map assignment: which map each sample / positioned event belongs to (the latest event with a `map` prop on the
 *     same server, else the player's own latest), with a top-down x/z frame per map;
 *   - Grid: counts per frame cell (heatmaps, bounded output);
 *   - layers: path density, idle spots, deaths, spawns, screens, buttons, prompts and quits on a map;
 *   - the quit autopsy: what the last seconds before leaving looked like, against the sessions that didn't leave;
 *   - time to first action: spawn -> first move, screen, button, prompt, round.
 */
import { detectSignals, type DecodedRecording, type DetectorOptions, type RecordingInput, type RecordingInputType, type RecordingSample, type Signal, type Vec3 } from "./recording.ts";

// Tracks ----------------------------------------------------------------------------------------------------------------

/** A decoded session in typed arrays. Samples without a character (camera only) have NaN x/y/z. */
export interface Track {
	sid: string;
	pid: string;
	job: string;
	art: string;
	/** Absolute ms per sample, ascending. */
	t: Float64Array;
	x: Float32Array;
	y: Float32Array;
	z: Float32Array;
	/** Camera look direction (unit vector); NaN when unknown. */
	lx: Float32Array;
	ly: Float32Array;
	lz: Float32Array;
	/** Inputs and UI events, absolute ms, ascending. */
	inputs: RecordingInput[];
	/** Chunks missing between the decoded ones. */
	gaps: number;
	/** The recording's first and last moment (first chunk start, last sample or input). */
	start: number;
	end: number;
}

export function toTrack(rec: DecodedRecording, meta: { job: string; art: string; start?: number }): Track {
	const samples = [...rec.samples].sort((a, b) => a.t - b.t);
	const n = samples.length;
	const track: Track = {
		sid: rec.sid,
		pid: rec.pid,
		job: meta.job,
		art: meta.art,
		t: new Float64Array(n),
		x: new Float32Array(n),
		y: new Float32Array(n),
		z: new Float32Array(n),
		lx: new Float32Array(n),
		ly: new Float32Array(n),
		lz: new Float32Array(n),
		inputs: [...rec.inputs].sort((a, b) => a.t - b.t),
		gaps: rec.gaps ?? 0,
		start: 0,
		end: 0,
	};
	for (let i = 0; i < n; i++) {
		const s = samples[i];
		track.t[i] = s.t;
		track.x[i] = s.pos ? s.pos[0] : Number.NaN;
		track.y[i] = s.pos ? s.pos[1] : Number.NaN;
		track.z[i] = s.pos ? s.pos[2] : Number.NaN;
		track.lx[i] = s.look ? s.look[0] : Number.NaN;
		track.ly[i] = s.look ? s.look[1] : Number.NaN;
		track.lz[i] = s.look ? s.look[2] : Number.NaN;
	}
	const firstInput = track.inputs[0]?.t ?? Number.POSITIVE_INFINITY;
	const lastInput = track.inputs.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
	const first = Math.min(n ? track.t[0] : Number.POSITIVE_INFINITY, firstInput, meta.start ?? Number.POSITIVE_INFINITY);
	const last = Math.max(n ? track.t[n - 1] : Number.NEGATIVE_INFINITY, lastInput);
	track.start = Number.isFinite(first) ? first : 0;
	track.end = Number.isFinite(last) ? last : track.start;
	return track;
}

/** Bytes a track holds (the cache's budget). */
export function trackBytes(track: Track): number {
	return track.t.length * 32 + track.inputs.length * 64 + 256;
}

/** Back to sample objects, for the confusion detectors (transient). */
export function trackToDecoded(track: Track): DecodedRecording {
	const samples: RecordingSample[] = [];
	for (let i = 0; i < track.t.length; i++) {
		const s: RecordingSample = { t: track.t[i] };
		if (!Number.isNaN(track.x[i])) s.pos = [track.x[i], track.y[i], track.z[i]];
		if (!Number.isNaN(track.lx[i])) s.look = [track.lx[i], track.ly[i], track.lz[i]];
		samples.push(s);
	}
	return { pid: track.pid, sid: track.sid, samples, inputs: track.inputs, gaps: track.gaps };
}

/** The index of the last sample at or before `t` (-1 when none). */
export function sampleAt(track: Track, t: number): number {
	let lo = 0;
	let hi = track.t.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (track.t[mid] <= t) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

/** Where the character was at `t`: the last sample with a position at or before it, else the first one after. */
export function positionAt(track: Track, t: number): Vec3 | undefined {
	for (let i = sampleAt(track, t); i >= 0; i--) if (!Number.isNaN(track.x[i])) return [track.x[i], track.y[i], track.z[i]];
	for (let i = 0; i < track.t.length; i++) if (!Number.isNaN(track.x[i])) return [track.x[i], track.y[i], track.z[i]];
	return undefined;
}

/** The last sample with a position. */
export function lastPosition(track: Track): Vec3 | undefined {
	for (let i = track.t.length - 1; i >= 0; i--) if (!Number.isNaN(track.x[i])) return [track.x[i], track.y[i], track.z[i]];
	return undefined;
}

// Session context (from events) -------------------------------------------------------------------------------------------

/** One of the session's events (state changes, funnels, the game's custom events, recording_meta). */
export interface SessionEvent {
	t: number;
	kind: string;
	name: string;
	state?: string | null;
	/** Parsed props (only for kinds the analyses read). */
	props?: Record<string, unknown>;
}

/** A part of an event's `state` ("zone:Lobby|screen:Shop|activity:idle" -> zone "Lobby"). */
export function statePart(state: string | null | undefined, part: string): string | null {
	if (!state) return null;
	for (const piece of state.split("|")) if (piece.startsWith(`${part}:`)) return piece.slice(part.length + 1) || null;
	return null;
}

/** The state after the last event at or before `t` (events ascending). */
export function stateAt(events: readonly SessionEvent[], t: number): string | null {
	let state: string | null = null;
	for (const e of events) {
		if (e.t > t) break;
		if (e.state !== undefined) state = e.state ?? null;
	}
	return state;
}

/** A state lookup that walks forward (for ascending `t` in one session). */
export class StateCursor {
	private index = 0;
	private current: string | null = null;
	constructor(private readonly events: readonly SessionEvent[]) {}
	at(t: number): string | null {
		while (this.index < this.events.length && this.events[this.index].t <= t) {
			const e = this.events[this.index++];
			if (e.state !== undefined) this.current = e.state ?? null;
		}
		return this.current;
	}
}

// Map assignment ------------------------------------------------------------------------------------------------------

/** The layer for samples without a map (the lobby, or before any map event). */
export const NO_MAP = "(lobby / unknown)";

/** Map change points, ascending: from `t` on, the map is `map` (null: none). */
export type MapTimeline = { t: number; map: string | null }[];

/** The map at `t` (undefined when the timeline has no point at or before it). */
export function mapAt(timeline: MapTimeline | undefined, t: number): string | null | undefined {
	if (!timeline?.length) return undefined;
	let lo = 0;
	let hi = timeline.length - 1;
	let found: string | null | undefined;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (timeline[mid].t <= t) {
			found = timeline[mid].map;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

export interface MapSources {
	/** Per server (job): the change points of the latest event with the map prop. */
	byJob: Map<string, MapTimeline>;
	/** Per player (pid): the same from the player's own events (the fallback). */
	byPid: Map<string, MapTimeline>;
	/** A zone matching this counts as no map (the lobby). Default /lobby/i. */
	lobbyZone?: RegExp;
	/**
	 * Zones that name a map (lower case -> the map's name as the events spell it): a game whose zones are its maps
	 * (gnome: zone "hedgemaze" on the HedgeMaze map, "lobby" / "shop" in the lobby building) says exactly where a player
	 * is, which beats the server's latest map event (still "hedgemaze" for a player shopping in the lobby).
	 */
	zoneMaps?: Map<string, string>;
}

/** The map names the timelines carry, by their lower case: a zone equal to one names that map. */
export function zoneMapsOf(...timelines: Map<string, MapTimeline>[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const byKey of timelines) for (const list of byKey.values()) for (const p of list) if (p.map) out.set(p.map.toLowerCase(), p.map);
	return out;
}

/**
 * The map a moment belongs to: a zone that names a map, else the server's latest map event, else the player's own, else
 * NO_MAP; a lobby zone wins over all.
 */
export function assignMap(sources: MapSources, job: string, pid: string, t: number, zone?: string | null): string {
	if (zone && (sources.lobbyZone ?? /lobby/i).test(zone)) return NO_MAP;
	const named = zone ? sources.zoneMaps?.get(zone.toLowerCase()) : undefined;
	if (named) return named;
	const byJob = job ? mapAt(sources.byJob.get(job), t) : undefined;
	if (byJob !== undefined) return byJob || NO_MAP;
	const byPid = pid ? mapAt(sources.byPid.get(pid), t) : undefined;
	return byPid || NO_MAP;
}

export interface Bounds {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
}

/** A top-down grid over a map: x to the right, z down (Roblox's -Z is "up" on screen). Origin aligned to the cell. */
export interface Frame extends Bounds {
	/** Studs per cell (a multiple of the base cell). */
	cell: number;
	cols: number;
	rows: number;
}

/** Weighted points (x, z, weight) of one map, for its bounds. */
export class PointSet {
	xs: number[] = [];
	zs: number[] = [];
	ws: number[] = [];
	total = 0;
	add(x: number, z: number, w = 1): void {
		if (!Number.isFinite(x) || !Number.isFinite(z) || w <= 0) return;
		this.xs.push(x);
		this.zs.push(z);
		this.ws.push(w);
		this.total += w;
	}
}

/** Weighted quantiles (each p in 0..1) of values, sorting once. */
export function weightedQuantiles(values: readonly number[], weights: readonly number[], ps: readonly number[]): number[] {
	if (!values.length) return ps.map(() => Number.NaN);
	const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
	let total = 0;
	for (const w of weights) total += w;
	return ps.map((p) => {
		const target = p * total;
		let acc = 0;
		for (const i of order) {
			acc += weights[i];
			if (acc >= target) return values[i];
		}
		return values[order[order.length - 1]];
	});
}

/**
 * The area a map's points cover. `core`: the 5th-95th percentiles of x and z widened by their span (at least 60 studs)
 * each way, used to reject points that can't be on the map (a stale map on a lobby position); `frame`: every point
 * inside the core, plus a small margin.
 */
export function boundsOf(points: PointSet): { frame: Bounds; core: Bounds } | undefined {
	if (points.total <= 0) return undefined;
	const [x5, x95] = weightedQuantiles(points.xs, points.ws, [0.05, 0.95]);
	const [z5, z95] = weightedQuantiles(points.zs, points.ws, [0.05, 0.95]);
	const cx = Math.max(x95 - x5, 60);
	const cz = Math.max(z95 - z5, 60);
	const core = { minX: x5 - cx, maxX: x95 + cx, minZ: z5 - cz, maxZ: z95 + cz };
	// The frame: every point inside the core, plus a small margin.
	const frame = { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minZ: Number.POSITIVE_INFINITY, maxZ: Number.NEGATIVE_INFINITY };
	for (let i = 0; i < points.xs.length; i++) {
		const x = points.xs[i];
		const z = points.zs[i];
		if (!inside(core, x, z)) continue;
		frame.minX = Math.min(frame.minX, x);
		frame.maxX = Math.max(frame.maxX, x);
		frame.minZ = Math.min(frame.minZ, z);
		frame.maxZ = Math.max(frame.maxZ, z);
	}
	const mx = Math.max((frame.maxX - frame.minX) * 0.03, 4);
	const mz = Math.max((frame.maxZ - frame.minZ) * 0.03, 4);
	return { frame: { minX: frame.minX - mx, maxX: frame.maxX + mx, minZ: frame.minZ - mz, maxZ: frame.maxZ + mz }, core };
}

export function inside(b: Bounds, x: number, z: number): boolean {
	return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/** A grid over bounds: at most `grid` cells along the longer side, cells a multiple of `baseCell` studs, aligned. */
export function frameFor(b: Bounds, grid = 96, baseCell = 4): Frame {
	const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, baseCell);
	const cell = baseCell * Math.max(1, Math.ceil(span / (baseCell * grid)));
	const minX = Math.floor(b.minX / cell) * cell;
	const minZ = Math.floor(b.minZ / cell) * cell;
	const cols = Math.max(1, Math.ceil((b.maxX - minX) / cell));
	const rows = Math.max(1, Math.ceil((b.maxZ - minZ) / cell));
	return { minX, minZ, maxX: minX + cols * cell, maxZ: minZ + rows * cell, cell, cols, rows };
}

/** [column, row, count, average height?] */
export type GridCell = [number, number, number, number?];

/**
 * Counts per frame cell. Points outside the frame are counted in `outside`. A point added with its height (`y`) adds to
 * the cell's average height, returned as the cell's 4th value (the 3D map puts the cell at walking height).
 */
export class Grid {
	private counts = new Map<number, number>();
	private heights = new Map<number, [number, number]>();
	total = 0;
	outside = 0;
	constructor(readonly frame: Frame) {}
	cellOf(x: number, z: number): [number, number] | undefined {
		const f = this.frame;
		const ix = Math.floor((x - f.minX) / f.cell);
		const iz = Math.floor((z - f.minZ) / f.cell);
		if (ix < 0 || iz < 0 || ix >= f.cols || iz >= f.rows || !Number.isFinite(ix) || !Number.isFinite(iz)) return undefined;
		return [ix, iz];
	}
	add(x: number, z: number, w = 1, y?: number): boolean {
		const c = this.cellOf(x, z);
		if (!c) {
			this.outside += w;
			return false;
		}
		this.addCell(c[0], c[1], w, y);
		return true;
	}
	addCell(ix: number, iz: number, w = 1, y?: number): void {
		const key = iz * this.frame.cols + ix;
		this.counts.set(key, (this.counts.get(key) ?? 0) + w);
		this.total += w;
		if (y !== undefined && Number.isFinite(y)) {
			const h = this.heights.get(key);
			if (h) {
				h[0] += y * w;
				h[1] += w;
			} else this.heights.set(key, [y * w, w]);
		}
	}
	/**
	 * [ix, iz, count] (plus the average height, to 0.1 stud, when the cell's points had one), row by row; at most `max`
	 * cells (the largest), sorted back into row order.
	 */
	cells(max = Number.POSITIVE_INFINITY): GridCell[] {
		let entries = [...this.counts];
		if (entries.length > max) entries = entries.sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, max);
		return entries
			.sort((a, b) => a[0] - b[0])
			.map(([key, n]) => {
				const h = this.heights.get(key);
				const cell: GridCell = [key % this.frame.cols, Math.floor(key / this.frame.cols), n];
				if (h && h[1] > 0) cell.push(Math.round((h[0] / h[1]) * 10) / 10);
				return cell;
			});
	}
	get size(): number {
		return this.counts.size;
	}
}

// Layers -----------------------------------------------------------------------------------------------------------------

/** Layers drawn from the recordings. */
export const RECORDING_LAYERS = ["path", "idle", "death", "spawn", "screen_open", "screen_close", "button", "prompt", "quit"] as const;
export type RecordingLayerId = (typeof RECORDING_LAYERS)[number];

export const LAYER_LABELS: Record<RecordingLayerId, string> = {
	path: "Positions (path density)",
	idle: "Idle spots (10 s+)",
	death: "Deaths",
	spawn: "Spawns",
	screen_open: "Screens opened",
	screen_close: "Screens closed",
	button: "Button presses",
	prompt: "Prompts used",
	quit: "Quits (last position)",
};

const INPUT_LAYER: Partial<Record<RecordingInputType, RecordingLayerId>> = {
	death: "death",
	spawn: "spawn",
	screen_open: "screen_open",
	screen_close: "screen_close",
	button: "button",
	prompt_used: "prompt",
};

/** One recorded session with what the layers need. */
export interface LayerSession {
	track: Track;
	/** Per sample: the map (an index into the shared names). */
	maps: Uint16Array;
	events: readonly SessionEvent[];
	why: string | null;
}

export interface LayerFilters {
	zone?: string;
	screen?: string;
	/** Per layer: keep only these values (screen name, button path, prompt path). */
	values?: Partial<Record<string, readonly string[]>>;
}

/** A layer's counts on one map. */
export interface LayerCounts {
	grid: Grid;
	/** Distinct sessions that added to it. */
	sessions: Set<string>;
	/** Count per value (before the value filter), for the toggles. */
	values: Map<string, number>;
	/** A few sessions per cell key, for "open a replay from this cell". */
	examples: string[];
}

/** Sessions in the last N seconds of a recording that ended with the player leaving. */
export const LEFT = "left";

/**
 * Adds the sessions' recording layers on map `mapIndex` to `out` (one LayerCounts per wanted layer).
 * `matches(t)` (zone/screen filters) is checked per point.
 */
export function addRecordingLayers(
	sessions: readonly LayerSession[],
	mapIndex: number,
	frame: Frame,
	wanted: readonly RecordingLayerId[],
	filters: LayerFilters,
	detector: DetectorOptions = {},
): Map<RecordingLayerId, LayerCounts> {
	const out = new Map<RecordingLayerId, LayerCounts>();
	for (const id of wanted) out.set(id, { grid: new Grid(frame), sessions: new Set(), values: new Map(), examples: [] });
	const want = new Set(wanted);
	const stateOk = (state: string | null) =>
		(!filters.zone || statePart(state, "zone") === filters.zone) && (!filters.screen || statePart(state, "screen") === filters.screen);
	const add = (id: RecordingLayerId, track: Track, x: number, y: number, z: number, value?: string) => {
		const layer = out.get(id);
		if (!layer) return;
		if (value !== undefined) layer.values.set(value, (layer.values.get(value) ?? 0) + 1);
		const keep = filters.values?.[id];
		if (keep?.length && (value === undefined || !keep.includes(value))) return;
		if (layer.grid.add(x, z, 1, y)) {
			layer.sessions.add(track.sid);
			if (layer.examples.length < 50 && !layer.examples.includes(track.sid)) layer.examples.push(track.sid);
		}
	};
	const onMap = (s: LayerSession, i: number) => i >= 0 && s.maps[i] === mapIndex && !Number.isNaN(s.track.x[i]);
	for (const s of sessions) {
		const { track } = s;
		const cursor = new StateCursor(s.events);
		if (want.has("path")) {
			for (let i = 0; i < track.t.length; i++) {
				if (!onMap(s, i)) continue;
				if ((filters.zone || filters.screen) && !stateOk(cursor.at(track.t[i]))) continue;
				add("path", track, track.x[i], track.y[i], track.z[i]);
			}
		}
		const pointAt = (t: number): number => {
			let i = sampleAt(track, t);
			while (i >= 0 && Number.isNaN(track.x[i])) i--;
			if (i < 0) for (i = 0; i < track.t.length && Number.isNaN(track.x[i]); i++);
			return i < track.t.length ? i : -1;
		};
		const addAt = (id: RecordingLayerId, t: number, value?: string) => {
			const i = pointAt(t);
			if (!onMap(s, i)) return;
			if ((filters.zone || filters.screen) && !stateOk(stateAt(s.events, t))) return;
			add(id, track, track.x[i], track.y[i], track.z[i], value);
		};
		for (const input of track.inputs) {
			const id = INPUT_LAYER[input.type];
			if (id && want.has(id)) addAt(id, input.t, id === "death" || id === "spawn" ? undefined : (input.target ?? "(none)"));
		}
		if (want.has("idle")) {
			for (const signal of detectSignals(trackToDecoded(track), undefined, detector)) if (signal.kind === "idle") addAt("idle", signal.t);
		}
		if (want.has("quit") && s.why === LEFT) {
			let i = track.t.length - 1;
			while (i >= 0 && Number.isNaN(track.x[i])) i--;
			if (onMap(s, i) && (!(filters.zone || filters.screen) || stateOk(stateAt(s.events, track.end)))) add("quit", track, track.x[i], track.y[i], track.z[i]);
		}
	}
	return out;
}

/**
 * Per sample: the map index (names shared across sessions), from the sources and the zone; and whether the zone itself
 * named that map (`confirmed`: those points alone give a map's area when there are enough of them).
 */
export function assignSamples(
	track: Track,
	events: readonly SessionEvent[],
	sources: MapSources,
	index: (name: string) => number,
): { maps: Uint16Array; confirmed: Uint8Array } {
	const maps = new Uint16Array(track.t.length);
	const confirmed = new Uint8Array(track.t.length);
	const cursor = new StateCursor(events);
	for (let i = 0; i < track.t.length; i++) {
		const t = track.t[i];
		const zone = statePart(cursor.at(t), "zone");
		const map = assignMap(sources, track.job, track.pid, t, zone);
		maps[i] = index(map);
		if (zone && map !== NO_MAP && zone.toLowerCase() === map.toLowerCase()) confirmed[i] = 1;
	}
	return { maps, confirmed };
}

/** Moves samples that fall outside their map's core bounds to NO_MAP (a stale map while the player is in the lobby). */
export function rejectStrays(track: Track, maps: Uint16Array, cores: (Bounds | undefined)[], noMap: number): number {
	let moved = 0;
	for (let i = 0; i < maps.length; i++) {
		const core = cores[maps[i]];
		if (maps[i] === noMap || !core || Number.isNaN(track.x[i])) continue;
		if (!inside(core, track.x[i], track.z[i])) {
			maps[i] = noMap;
			moved++;
		}
	}
	return moved;
}

// Quit autopsy -----------------------------------------------------------------------------------------------------------

export interface AutopsyOptions {
	/** The seconds before the end that count. Default 10. */
	windowSeconds: number;
	/** A death or a down within this many seconds before the end. Default 20. */
	diedSeconds: number;
	/** The game's events that mean downed / dead (custom kind). Default down, death_final. */
	downEvents: readonly string[];
	/** Funnels that are a tutorial (a regular expression on the funnel name). Default "tutorial|onboard". */
	tutorialPattern: string;
	/** Idle: no input and moved less than this. Default 2 studs. */
	stillStuds: number;
	/** Stuck: pressing movement keys / the stick but moved less than this. Default 3 studs. */
	stuckStuds: number;
	/** A button press with no screen change within this many ms is a dead click. Default 1500. */
	deadClickMs: number;
	/** Where they stood: the map split into this many cells per side. Default 6. */
	placeCells: number;
}

export const AUTOPSY_DEFAULTS: AutopsyOptions = {
	windowSeconds: 10,
	diedSeconds: 20,
	downEvents: ["down", "death_final"],
	tutorialPattern: "tutorial|onboard",
	stillStuds: 2,
	stuckStuds: 3,
	deadClickMs: 1500,
	placeCells: 6,
};

export const AUTOPSY_REASONS = ["screen", "died", "idle", "dead_clicks", "stuck", "tutorial", "place", "none"] as const;
export type AutopsyReason = (typeof AUTOPSY_REASONS)[number];

export interface ReasonHit {
	reason: AutopsyReason;
	/** The screen, the tutorial step, the map cell. */
	value?: string;
}

const PLAYER_INPUTS = new Set<RecordingInputType>(["key", "click", "tap", "pad", "scroll", "stick_start", "stick_stop", "button", "textbox", "prompt_used"]);
const MOVE_INPUTS = new Set<RecordingInputType>(["key", "stick_start", "pad", "tap"]);

/** The screens open at `t`, last opened last (from the recording's screen events). */
export function openScreens(inputs: readonly RecordingInput[], t: number): string[] {
	const open: string[] = [];
	for (const input of inputs) {
		if (input.t > t) break;
		if (!input.target) continue;
		if (input.type === "screen_open") {
			const at = open.indexOf(input.target);
			if (at >= 0) open.splice(at, 1);
			open.push(input.target);
		} else if (input.type === "screen_close") {
			const at = open.indexOf(input.target);
			if (at >= 0) open.splice(at, 1);
		}
	}
	return open;
}

export interface EndingContext {
	track: Track;
	events: readonly SessionEvent[];
	/** The map at the end and its frame (for "where they stood"). */
	map?: string;
	frame?: Frame;
	/** Per tutorial funnel: the highest step index any session reached (a lower last step = still in it). */
	tutorialMax: ReadonlyMap<string, number>;
}

function stepOf(e: SessionEvent): number {
	const i = e.props?.i;
	return typeof i === "number" ? i : Number(i ?? Number.NaN);
}

/** Why the recording ended where it did: every reason that applies to its last `windowSeconds`. */
export function classifyEnding(ctx: EndingContext, options: AutopsyOptions = AUTOPSY_DEFAULTS): ReasonHit[] {
	const { track, events } = ctx;
	const end = track.end;
	const from = end - options.windowSeconds * 1000;
	const hits: ReasonHit[] = [];
	const inWindow = track.inputs.filter((i) => i.t >= from && i.t <= end);

	// The screen open at the end (the recording's screen events, else the state on the last event).
	const screens = openScreens(track.inputs, end);
	const screen = screens.at(-1) ?? statePart(stateAt(events, end), "screen");
	if (screen) hits.push({ reason: "screen", value: screen });

	// Died or downed shortly before.
	const diedFrom = end - options.diedSeconds * 1000;
	const downs = new Set(options.downEvents);
	if (track.inputs.some((i) => i.type === "death" && i.t >= diedFrom && i.t <= end) || events.some((e) => e.t >= diedFrom && e.t <= end + 1000 && downs.has(e.name))) {
		hits.push({ reason: "died" });
	}

	// Movement over the window (horizontal): the farthest from where the window began.
	let origin: [number, number] | undefined;
	let farthest = 0;
	let covered = 0;
	for (let i = Math.max(0, sampleAt(track, from)); i < track.t.length && track.t[i] <= end; i++) {
		if (Number.isNaN(track.x[i])) continue;
		if (!origin) {
			origin = [track.x[i], track.z[i]];
			covered = track.t[i];
		}
		farthest = Math.max(farthest, Math.hypot(track.x[i] - origin[0], track.z[i] - origin[1]));
	}
	const span = origin ? end - Math.max(covered, from) : 0;
	const playerInputs = inWindow.filter((i) => PLAYER_INPUTS.has(i.type)).length;
	const moveInputs = inWindow.filter((i) => MOVE_INPUTS.has(i.type)).length;
	if (origin && playerInputs === 0 && farthest < options.stillStuds && span >= options.windowSeconds * 600) hits.push({ reason: "idle" });
	else if (origin && moveInputs >= 2 && farthest < options.stuckStuds && screens.length === 0) hits.push({ reason: "stuck" });

	// Dead clicks: presses that changed no screen.
	const screenChanges = track.inputs.filter((i) => i.type === "screen_open" || i.type === "screen_close").map((i) => i.t);
	const dead = inWindow.filter((i) => i.type === "button" && !screenChanges.some((t) => t >= i.t && t <= i.t + options.deadClickMs)).length;
	if (dead >= 2) hits.push({ reason: "dead_clicks" });

	// In a tutorial step: the last tutorial funnel step is below the furthest step anyone reached.
	const pattern = new RegExp(options.tutorialPattern, "i");
	let lastStep: SessionEvent | undefined;
	for (const e of events) if (e.t <= end + 1000 && e.kind === "funnel" && pattern.test(e.name)) lastStep = e;
	if (lastStep) {
		const step = stepOf(lastStep);
		const max = ctx.tutorialMax.get(lastStep.name);
		if (Number.isFinite(step) && max !== undefined && step < max) {
			const name = typeof lastStep.props?.step === "string" ? ` (${lastStep.props.step})` : "";
			hits.push({ reason: "tutorial", value: `${lastStep.name} step ${step}${name}` });
		}
	}

	if (!hits.length) hits.push({ reason: "none" });

	// Where they stood: a coarse cell of the map.
	const pos = lastPosition(track);
	if (pos && ctx.map) hits.push({ reason: "place", value: placeLabel(ctx.map, ctx.frame, pos, options.placeCells) });
	return hits;
}

/** "Map · B3": a coarse cell (columns A.., rows 1..) of the map's frame. */
export function placeLabel(map: string, frame: Frame | undefined, pos: Vec3, cells: number): string {
	if (!frame) return map;
	const col = Math.min(cells - 1, Math.max(0, Math.floor(((pos[0] - frame.minX) / (frame.maxX - frame.minX)) * cells)));
	const row = Math.min(cells - 1, Math.max(0, Math.floor(((pos[2] - frame.minZ) / (frame.maxZ - frame.minZ)) * cells)));
	return `${map} · ${String.fromCharCode(65 + col)}${row + 1}`;
}

/** The furthest step reached per tutorial funnel, over every session's events. */
export function tutorialMaxSteps(allEvents: Iterable<readonly SessionEvent[]>, tutorialPattern: string): Map<string, number> {
	const pattern = new RegExp(tutorialPattern, "i");
	const max = new Map<string, number>();
	for (const events of allEvents) {
		for (const e of events) {
			if (e.kind !== "funnel" || !pattern.test(e.name)) continue;
			const step = stepOf(e);
			if (Number.isFinite(step)) max.set(e.name, Math.max(max.get(e.name) ?? step, step));
		}
	}
	return max;
}

export interface AutopsyRow {
	reason: AutopsyReason;
	value?: string;
	/** Quitters with this reason, and their share of all quitters. */
	left: number;
	leftShare: number;
	/** The same for the sessions that didn't leave (their last seconds recorded). */
	stayed: number;
	stayedShare: number;
	/** leftShare / stayedShare (null when no stayer had it): over 1 = over-represented among quitters. */
	lift: number | null;
	/** A few quitting sessions with this reason (open in the replay). */
	examples: string[];
}

/** Counts reasons for quitters against stayers. Rows with a value (screen, step, place) come per value. */
export function summarizeAutopsy(sessions: readonly { sid: string; left: boolean; hits: readonly ReasonHit[] }[], examples = 5): { left: number; stayed: number; rows: AutopsyRow[] } {
	const left = sessions.filter((s) => s.left).length;
	const stayed = sessions.length - left;
	const rows = new Map<string, AutopsyRow>();
	const bump = (reason: AutopsyReason, value: string | undefined, s: { sid: string; left: boolean }) => {
		const key = `${reason}\u0000${value ?? ""}`;
		const row = rows.get(key) ?? { reason, ...(value !== undefined ? { value } : {}), left: 0, leftShare: 0, stayed: 0, stayedShare: 0, lift: null, examples: [] };
		if (s.left) {
			row.left++;
			if (row.examples.length < examples) row.examples.push(s.sid);
		} else row.stayed++;
		rows.set(key, row);
	};
	for (const s of sessions) {
		const seen = new Set<string>();
		for (const hit of s.hits) {
			// Each reason once per session as a whole ("screen open"), and once per value ("screen open: Shop").
			if (hit.value !== undefined && !seen.has(hit.reason) && hit.reason !== "place") {
				seen.add(hit.reason);
				bump(hit.reason, undefined, s);
			}
			bump(hit.reason, hit.value, s);
		}
	}
	const out = [...rows.values()].map((r) => {
		const leftShare = left ? r.left / left : 0;
		const stayedShare = stayed ? r.stayed / stayed : 0;
		return { ...r, leftShare: round4(leftShare), stayedShare: round4(stayedShare), lift: stayedShare > 0 ? round4(leftShare / stayedShare) : null };
	});
	out.sort((a, b) => b.left - a.left || (a.value === undefined ? -1 : 0) - (b.value === undefined ? -1 : 0) || a.reason.localeCompare(b.reason) || (a.value ?? "").localeCompare(b.value ?? ""));
	return { left, stayed, rows: out };
}

function round4(v: number): number {
	return Math.round(v * 10_000) / 10_000;
}

// Time to first action ---------------------------------------------------------------------------------------------------

export const FIRST_ACTIONS = ["move", "screen", "button", "prompt", "round"] as const;
export type FirstAction = (typeof FIRST_ACTIONS)[number];

export interface FirstActionOptions {
	/** A move: this many studs (horizontal) from where the character spawned. Default 3. */
	moveStuds: number;
	/** A screen counts as opened by the player when it opens within this many ms of a player input. Default 1500. */
	screenAfterInputMs: number;
}

export const FIRST_ACTION_DEFAULTS: FirstActionOptions = { moveStuds: 3, screenAfterInputMs: 1500 };

export interface FirstActions {
	/** When the character first existed (the first spawn event or position sample), absolute ms. */
	spawn: number | null;
	/** Seconds from spawn; null = not seen (in the recording for the first four, in the events for round). */
	seconds: Record<FirstAction, number | null>;
}

/** Seconds from spawn to the first move, player-opened screen, button press and prompt; `roundAt` from the events. */
export function firstActions(track: Track, roundAt: number | null, options: FirstActionOptions = FIRST_ACTION_DEFAULTS): FirstActions {
	let first = -1;
	for (let i = 0; i < track.t.length; i++) {
		if (!Number.isNaN(track.x[i])) {
			first = i;
			break;
		}
	}
	const spawnInput = track.inputs.find((i) => i.type === "spawn")?.t;
	const candidates = [first >= 0 ? track.t[first] : undefined, spawnInput].filter((v): v is number => v !== undefined);
	const spawn = candidates.length ? Math.min(...candidates) : null;
	const seconds: Record<FirstAction, number | null> = { move: null, screen: null, button: null, prompt: null, round: null };
	if (spawn === null) return { spawn, seconds };
	const since = (t: number) => Math.max(0, Math.round((t - spawn) / 100) / 10);
	if (first >= 0) {
		const x0 = track.x[first];
		const z0 = track.z[first];
		for (let i = first; i < track.t.length; i++) {
			if (!Number.isNaN(track.x[i]) && Math.hypot(track.x[i] - x0, track.z[i] - z0) > options.moveStuds) {
				seconds.move = since(track.t[i]);
				break;
			}
		}
	}
	let lastPlayerInput = Number.NEGATIVE_INFINITY;
	for (const input of track.inputs) {
		if (input.t < spawn) {
			if (PLAYER_INPUTS.has(input.type)) lastPlayerInput = input.t;
			continue;
		}
		if (input.type === "screen_open" && seconds.screen === null && input.t - lastPlayerInput <= options.screenAfterInputMs) seconds.screen = since(input.t);
		if (input.type === "button" && seconds.button === null) seconds.button = since(input.t);
		if (input.type === "prompt_used" && seconds.prompt === null) seconds.prompt = since(input.t);
		if (PLAYER_INPUTS.has(input.type)) lastPlayerInput = input.t;
	}
	if (roundAt !== null) seconds.round = since(Math.max(roundAt, spawn));
	return { spawn, seconds };
}

/** Histogram buckets (seconds) for the distributions. */
export const FIRST_ACTION_BUCKETS: { label: string; from: number; to: number }[] = [
	{ label: "<1 s", from: 0, to: 1 },
	{ label: "1-2 s", from: 1, to: 2 },
	{ label: "2-5 s", from: 2, to: 5 },
	{ label: "5-10 s", from: 5, to: 10 },
	{ label: "10-20 s", from: 10, to: 20 },
	{ label: "20-30 s", from: 20, to: 30 },
	{ label: "30-60 s", from: 30, to: 60 },
	{ label: "1-2 min", from: 60, to: 120 },
	{ label: "2 min+", from: 120, to: Number.POSITIVE_INFINITY },
];

export function quantile(sorted: readonly number[], p: number): number | null {
	if (!sorted.length) return null;
	const at = (sorted.length - 1) * p;
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)) * 10) / 10;
}

export interface FirstActionStat {
	action: FirstAction;
	sessions: number;
	reached: number;
	share: number;
	median: number | null;
	p25: number | null;
	p75: number | null;
	histogram: { label: string; count: number }[];
}

export function firstActionStats(rows: readonly FirstActions[]): FirstActionStat[] {
	const counted = rows.filter((r) => r.spawn !== null);
	return FIRST_ACTIONS.map((action) => {
		const values = counted.map((r) => r.seconds[action]).filter((v): v is number => v !== null).sort((a, b) => a - b);
		return {
			action,
			sessions: counted.length,
			reached: values.length,
			share: counted.length ? round4(values.length / counted.length) : 0,
			median: quantile(values, 0.5),
			p25: quantile(values, 0.25),
			p75: quantile(values, 0.75),
			histogram: FIRST_ACTION_BUCKETS.map((b) => ({ label: b.label, count: values.filter((v) => v >= b.from && v < b.to).length })),
		};
	});
}

export type { Signal };
