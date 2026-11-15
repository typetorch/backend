/**
 * The Maps page's data (plans/33): the backend's map list and export (GET /v1/maps, POST /v1/maps/export, the overrides),
 * one map's geometry (GET /v1/maps/<name>/geometry, the binary `TTMP` format: backend src/maps/format.ts and the README's
 * "Maps" section), and the layers drawn on the 2D / 3D map.
 *
 * Layers are plain data in world coordinates (studs, the game's own; the map's offset is applied to the geometry, never
 * to a layer): points, paths and heat cells. The recordings explorer hands its layers (paths, idle, deaths, quits,
 * replays) to the same MapScene props.
 */
import { ApiError, CSRF_HEADER } from "./api";

// The API ---------------------------------------------------------------------------------------------------------------

export type Vec3 = [number, number, number];
export interface Bounds {
	min: Vec3;
	max: Vec3;
}

export type AlignmentState = "aligned" | "partial" | "off" | "unknown";

export interface MapInfo {
	name: string;
	kind: "map" | "lobby";
	via: "name" | "override" | "lobby";
	path: string;
	parts: number;
	meshes: number;
	unions: number;
	invisible: number;
	bounds: Bounds | null;
	hash: string;
	bytes: number;
	alternatives: string[];
	offset: Vec3;
	override?: MapOverride;
	alignment: { state: AlignmentState; samples: number; inside: number; suggestedOffset?: Vec3 };
}

export interface MapOverride {
	path?: string;
	offset?: Vec3;
	by: string;
	at: number;
}

export interface ExportStatus {
	state: "idle" | "running" | "done" | "failed";
	step: string;
	startedAt: number | null;
	finishedAt: number | null;
	by: string | null;
	error: string | null;
}

export interface MapsView {
	configured: boolean;
	canExport: boolean;
	export: ExportStatus;
	latest: {
		placeId: number;
		universeId: number;
		placeVersion: number | null;
		at: number;
		by: string;
		seconds: number;
		parts: number;
		bytes: number;
		truncated: boolean;
		unmatched: string[];
		notes: string[];
	} | null;
	placeVersion: { latest: number | null; source: "roblox" | "fleet" | null; exported: number | null; outOfDate: boolean; note?: string };
	maps: MapInfo[];
	names: { name: string; events: number }[];
	overrides: Record<string, MapOverride>;
	history: { at: number; by: string; placeVersion: number | null; maps: number; parts: number }[];
	alignmentNote?: string;
}

/** The map-positions query's answer (backend src/queries/maps.ts). */
export interface MapPositionsResult {
	mapKey: string;
	cell: number;
	names: { name: string; events: number }[];
	cells: { map: string; event: string; x: number; z: number; y: number | null; ylo: number | null; n: number }[];
	truncated: boolean;
}

export const LOBBY = "(lobby)";
/** The map list's query key (the Maps page, and the Recordings page for its real-map view). */
export const MAPS_KEY = ["maps"] as const;
export const CELL_SIZES = [0.5, 1, 2] as const;
export type CellSize = (typeof CELL_SIZES)[number];

async function call<T>(path: string, init: RequestInit = {}, base = "/api"): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${base}${path}`, {
			...init,
			credentials: "same-origin",
			headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.method && init.method !== "GET" ? { [CSRF_HEADER]: "1" } : {}), ...init.headers },
		});
	} catch (error) {
		throw new ApiError(0, `cannot reach the backend: ${(error as Error).message}`, path);
	}
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		// not JSON
	}
	if (!response.ok) throw new ApiError(response.status, (body as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`, path, body);
	return body as T;
}

export const mapsApi = {
	list: (signal?: AbortSignal) => call<MapsView>("/v1/maps", signal ? { signal } : {}),
	export: (names: string[] = []) => call<{ export: ExportStatus; names: string[] }>("/v1/maps/export", { method: "POST", body: JSON.stringify(names.length ? { names } : {}) }),
	setOverride: (name: string, body: { path?: string; offset?: Vec3 }) => call<{ override: MapOverride | null }>(`/v1/maps/${encodeURIComponent(name)}/override`, { method: "PUT", body: JSON.stringify(body) }),
	removeOverride: (name: string) => call<{ override: null }>(`/v1/maps/${encodeURIComponent(name)}/override`, { method: "DELETE" }),
	/** One map's geometry, decoded. `hash` only keys the cache (the server answers by name, with the hash as its ETag). */
	async geometry(name: string, signal?: AbortSignal): Promise<MapGeometry> {
		const path = `/v1/maps/${encodeURIComponent(name)}/geometry`;
		const response = await fetch(`/api${path}`, { credentials: "same-origin", ...(signal ? { signal } : {}) });
		if (!response.ok) {
			let message = `HTTP ${response.status}`;
			try {
				message = ((await response.json()) as { error?: string }).error ?? message;
			} catch {
				// not JSON
			}
			throw new ApiError(response.status, message, path);
		}
		return decodeGeometry(new Uint8Array(await response.arrayBuffer()));
	},
};

// The geometry ----------------------------------------------------------------------------------------------------------

export const RECORD_BYTES = 48;
export const HEADER_BYTES = 16;
export const SHAPES = ["ball", "block", "cylinder", "wedge", "cornerWedge"] as const;
export type Shape = (typeof SHAPES)[number];
export const FLAGS = { mesh: 1, union: 2, invisible: 4, collide: 8, truss: 16 } as const;

/** A map's parts as flat arrays (index i: position 3i..3i+2, rotation 4i..4i+3, ...), ready for instanced meshes. */
export interface MapGeometry {
	count: number;
	position: Float32Array;
	rotation: Float32Array;
	size: Float32Array;
	color: Uint8Array;
	transparency: Uint8Array;
	material: Uint16Array;
	shape: Uint8Array;
	flags: Uint8Array;
}

export function decodeGeometry(bytes: Uint8Array): MapGeometry {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = String.fromCharCode(...bytes.subarray(0, 4));
	if (bytes.byteLength < HEADER_BYTES || magic !== "TTMP") throw new Error("not map geometry (no TTMP header)");
	const version = view.getUint16(4, true);
	const size = view.getUint16(6, true);
	if (version !== 1 || size !== RECORD_BYTES) throw new Error(`map geometry version ${version} (this explorer reads 1)`);
	const count = view.getUint32(8, true);
	if (bytes.byteLength !== HEADER_BYTES + count * RECORD_BYTES) throw new Error("map geometry is cut short");
	const g: MapGeometry = {
		count,
		position: new Float32Array(count * 3),
		rotation: new Float32Array(count * 4),
		size: new Float32Array(count * 3),
		color: new Uint8Array(count * 3),
		transparency: new Uint8Array(count),
		material: new Uint16Array(count),
		shape: new Uint8Array(count),
		flags: new Uint8Array(count),
	};
	for (let i = 0; i < count; i++) {
		const o = HEADER_BYTES + i * RECORD_BYTES;
		for (let a = 0; a < 3; a++) {
			g.position[i * 3 + a] = view.getFloat32(o + a * 4, true);
			g.size[i * 3 + a] = view.getFloat32(o + 28 + a * 4, true);
			g.color[i * 3 + a] = view.getUint8(o + 40 + a);
		}
		for (let a = 0; a < 4; a++) g.rotation[i * 4 + a] = view.getFloat32(o + 12 + a * 4, true);
		g.transparency[i] = view.getUint8(o + 43);
		g.material[i] = view.getUint16(o + 44, true);
		g.shape[i] = view.getUint8(o + 46);
		g.flags[i] = view.getUint8(o + 47);
	}
	return g;
}

/** World-axis half height of part i (its rotated box). */
export function halfHeight(g: MapGeometry, i: number): number {
	const [x, y, z, w] = [g.rotation[i * 4], g.rotation[i * 4 + 1], g.rotation[i * 4 + 2], g.rotation[i * 4 + 3]] as number[] as [number, number, number, number];
	const r10 = 2 * (x * y + z * w);
	const r11 = 1 - 2 * (x * x + z * z);
	const r12 = 2 * (y * z - x * w);
	return (Math.abs(r10) * Math.abs(g.size[i * 3] as number) + Math.abs(r11) * Math.abs(g.size[i * 3 + 1] as number) + Math.abs(r12) * Math.abs(g.size[i * 3 + 2] as number)) / 2;
}

export interface Floor {
	/** The walkable top, studs. */
	y: number;
	/** The band that shows this floor: from just under it to just under the next one up. */
	band: [number, number];
	/** Square studs of floor at this height. */
	area: number;
}

/** Studs between two floors, at least (closer tops are one floor: steps, curbs). */
export const FLOOR_GAP = 8;

/**
 * Floors from the geometry's walkable tops: flat, wide, collidable slabs (at most 4 studs thick, at least 64 square studs,
 * not tilted), their tops grouped within FLOOR_GAP studs and weighted by area; a level is a floor when it has at least
 * 15% of the biggest one's area. One floor or none: the slider alone does it.
 */
export function detectFloors(g: MapGeometry, offsetY = 0): Floor[] {
	const tops: [number, number][] = [];
	for (let i = 0; i < g.count; i++) {
		if (!((g.flags[i] as number) & FLAGS.collide)) continue;
		const qx = g.rotation[i * 4] as number;
		const qz = g.rotation[i * 4 + 2] as number;
		if (Math.abs(qx) > 0.05 || Math.abs(qz) > 0.05) continue;
		const sx = Math.abs(g.size[i * 3] as number);
		const sy = Math.abs(g.size[i * 3 + 1] as number);
		const sz = Math.abs(g.size[i * 3 + 2] as number);
		if (sy > 4 || sx * sz < 64) continue;
		tops.push([(g.position[i * 3 + 1] as number) + sy / 2 + offsetY, sx * sz]);
	}
	tops.sort((a, b) => a[0] - b[0]);
	const levels: { y: number; area: number; top: number }[] = [];
	for (const [y, area] of tops) {
		const last = levels[levels.length - 1];
		if (last && y - last.top < FLOOR_GAP) {
			if (area > last.area * 0.5 && y > last.y) last.y = y;
			last.area += area;
			last.top = y;
		} else levels.push({ y, area, top: y });
	}
	const biggest = Math.max(0, ...levels.map((l) => l.area));
	const kept = levels.filter((l) => l.area >= biggest * 0.15);
	return kept.map((l, i) => {
		const next = kept[i + 1];
		return { y: round1(l.y), band: [round1(l.y - 2), round1(next ? next.y - 2 : l.y + 30)] as [number, number], area: Math.round(l.area) };
	});
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// Layers ----------------------------------------------------------------------------------------------------------------

export interface MapPoint {
	x: number;
	y: number;
	z: number;
}

/** What the 2D and 3D maps draw on top of the geometry, in world coordinates (studs). */
export interface MapLayer {
	id: string;
	label: string;
	/** A CSS color (hex). */
	color: string;
	points?: MapPoint[];
	/** Dot size in pixels (default 7). */
	pointSize?: number;
	paths?: MapPoint[][];
	/** Filled shapes (convex, e.g. a camera cone), see-through. */
	polygons?: MapPoint[][];
	/** Heat cells: the low corner (x, z) of a `cellSize` square, its height and its count. */
	cells?: { x: number; z: number; y?: number | null; n: number }[];
	cellSize?: number;
}

/** A palette for event layers (distinct in light and dark). */
export const LAYER_COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e03131", "#5c7cfa"];

/** Heat: 0 = cold (transparent blue) to 1 = hot (yellow), as [r, g, b] 0-1. */
export function heatColor(t: number): [number, number, number] {
	const v = Math.max(0, Math.min(1, t));
	const stops: [number, [number, number, number]][] = [
		[0, [0.15, 0.3, 0.9]],
		[0.4, [0.55, 0.2, 0.85]],
		[0.7, [0.95, 0.3, 0.3]],
		[1, [1, 0.85, 0.2]],
	];
	for (let i = 1; i < stops.length; i++) {
		const [b, cb] = stops[i] as [number, [number, number, number]];
		const [a, ca] = stops[i - 1] as [number, [number, number, number]];
		if (v <= b) {
			const k = (v - a) / (b - a);
			return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
		}
	}
	return stops[stops.length - 1]?.[1] ?? [1, 1, 1];
}

/** The positioned-event layers of one map: one per event (`kind:name`), its cells; a sample point per cell's center. */
export function eventLayers(positions: MapPositionsResult | undefined, map: string): MapLayer[] {
	if (!positions) return [];
	const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const byEvent = new Map<string, MapLayer>();
	for (const c of positions.cells) {
		if (key(c.map) !== key(map)) continue;
		let layer = byEvent.get(c.event);
		if (!layer) {
			layer = { id: `ev:${c.event}`, label: c.event.replace(/^custom:/, ""), color: LAYER_COLORS[byEvent.size % LAYER_COLORS.length] as string, cells: [], points: [], cellSize: positions.cell };
			byEvent.set(c.event, layer);
		}
		layer.cells?.push({ x: c.x, z: c.z, y: c.ylo ?? c.y, n: c.n });
		layer.points?.push({ x: c.x + positions.cell / 2, y: c.y ?? 0, z: c.z + positions.cell / 2 });
	}
	return [...byEvent.values()].sort((a, b) => total(b) - total(a));
}

const total = (l: MapLayer) => (l.cells ?? []).reduce((s, c) => s + c.n, 0);

/** "4,523 parts (480 meshes)" */
export function partsText(m: Pick<MapInfo, "parts" | "meshes" | "unions" | "invisible">): string {
	const extra = [m.meshes ? `${m.meshes.toLocaleString("en-US")} meshes` : "", m.unions ? `${m.unions.toLocaleString("en-US")} unions` : "", m.invisible ? `${m.invisible.toLocaleString("en-US")} invisible` : ""].filter(Boolean);
	return `${m.parts.toLocaleString("en-US")} parts${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

// What's drawn ----------------------------------------------------------------------------------------------------------

/**
 * Each part's kind for the draw rule (any game): the collision geometry is the map.
 *   collide     collides (visible or invisible): always drawn, its real color; invisible ones see-through
 *   decor       visible, doesn't collide, not a mesh or union (small decoration): always drawn
 *   decorMesh   visible mesh or union that doesn't collide: off by default (its box is only a bounding volume, often
 *               huge: gnome's HedgeMaze hedges are whole maze quadrants)
 *   marker      invisible and doesn't collide (markers, triggers, zones): off by default
 */
export type PartKind = "collide" | "decor" | "decorMesh" | "marker";

export function partKind(flags: number): PartKind {
	if (flags & FLAGS.collide) return "collide";
	if (flags & FLAGS.invisible) return "marker";
	if (flags & (FLAGS.mesh | FLAGS.union)) return "decorMesh";
	return "decor";
}

/** The two toggles; both off by default. */
export interface DrawToggles {
	/** Non-colliding meshes and unions (as their boxes). */
	decorative: boolean;
	/** Invisible non-colliding parts. */
	markers: boolean;
}

export const DEFAULT_TOGGLES: DrawToggles = { decorative: false, markers: false };

export function isDrawn(flags: number, toggles: DrawToggles): boolean {
	const kind = partKind(flags);
	return kind === "decorMesh" ? toggles.decorative : kind === "marker" ? toggles.markers : true;
}

export interface KindCounts {
	collide: number;
	/** Of `collide`: the invisible ones (walls a game hides under meshes). */
	collideInvisible: number;
	decor: number;
	decorMesh: number;
	marker: number;
}

export function countKinds(g: MapGeometry): KindCounts {
	const out: KindCounts = { collide: 0, collideInvisible: 0, decor: 0, decorMesh: 0, marker: 0 };
	for (let i = 0; i < g.count; i++) {
		const f = g.flags[i] as number;
		const kind = partKind(f);
		out[kind]++;
		if (kind === "collide" && f & FLAGS.invisible) out.collideInvisible++;
	}
	return out;
}

/** Parts drawn under `toggles`. */
export function drawnCount(g: MapGeometry, toggles: DrawToggles): number {
	let n = 0;
	for (let i = 0; i < g.count; i++) if (isDrawn(g.flags[i] as number, toggles)) n++;
	return n;
}

// Names ---------------------------------------------------------------------------------------------------------------------

/** A map name without case or punctuation (the backend's match: `parking_garage` = `ParkingGarage`). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The recordings' map with no name (src/recording-analysis.ts NO_MAP): drawn on the lobby's export. */
export const RECORDINGS_NO_MAP = "(lobby / unknown)";

/** The exported map for a map name of the events / recordings (no case or punctuation; no map = the lobby). */
export function exportFor(maps: readonly MapInfo[] | undefined, name: string | null | undefined): MapInfo | null {
	if (!maps || !name) return null;
	if (name === RECORDINGS_NO_MAP) return maps.find((m) => m.kind === "lobby") ?? null;
	const key = nameKey(name);
	return maps.find((m) => m.kind === "map" && nameKey(m.name) === key) ?? null;
}

// Recording cells in the world -------------------------------------------------------------------------------------------

/** A recordings frame's origin and cell (lib/types RecFrame). */
export interface GridFrame {
	minX: number;
	minZ: number;
	cell: number;
}

/** A cell index of a frame to its low corner in studs (x, z). */
export function cellToWorld(frame: GridFrame, col: number, row: number, cell = frame.cell): { x: number; z: number } {
	return { x: frame.minX + col * cell, z: frame.minZ + row * cell };
}

/** World studs to the frame's cell index (null outside `cols` x `rows` when given). */
export function worldToCell(frame: GridFrame & { cols?: number; rows?: number }, x: number, z: number): [number, number] | null {
	const col = Math.floor((x - frame.minX) / frame.cell);
	const row = Math.floor((z - frame.minZ) / frame.cell);
	if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) return null;
	if ((frame.cols !== undefined && col >= frame.cols) || (frame.rows !== undefined && row >= frame.rows)) return null;
	return [col, row];
}

/**
 * The walkable top under (x, z): the lowest top of a colliding part over that spot inside `band` (every height without
 * one), offset applied; null when nothing collides there. For cells without a recorded height.
 */
export function floorUnder(g: MapGeometry, x: number, z: number, offset: Vec3 = [0, 0, 0], band: [number, number] | null = null): number | null {
	let best: number | null = null;
	const px = x - offset[0];
	const pz = z - offset[2];
	for (let i = 0; i < g.count; i++) {
		if (!((g.flags[i] as number) & FLAGS.collide)) continue;
		const [hx, hz] = halfExtentsXZ(g, i);
		const cx = g.position[i * 3] as number;
		const cz = g.position[i * 3 + 2] as number;
		if (Math.abs(px - cx) > hx || Math.abs(pz - cz) > hz) continue;
		const top = (g.position[i * 3 + 1] as number) + halfHeight(g, i) + offset[1];
		if (band && (top < band[0] || top > band[1])) continue;
		if (best === null || top < best) best = top;
	}
	return best;
}

/** World-axis half extents on x and z of part i (its rotated box). */
function halfExtentsXZ(g: MapGeometry, i: number): [number, number] {
	const [x, y, z, w] = [g.rotation[i * 4], g.rotation[i * 4 + 1], g.rotation[i * 4 + 2], g.rotation[i * 4 + 3]] as number[] as [number, number, number, number];
	const sx = Math.abs(g.size[i * 3] as number);
	const sy = Math.abs(g.size[i * 3 + 1] as number);
	const sz = Math.abs(g.size[i * 3 + 2] as number);
	const r00 = 1 - 2 * (y * y + z * z);
	const r01 = 2 * (x * y - z * w);
	const r02 = 2 * (x * z + y * w);
	const r20 = 2 * (x * z - y * w);
	const r21 = 2 * (y * z + x * w);
	const r22 = 1 - 2 * (x * x + y * y);
	return [(Math.abs(r00) * sx + Math.abs(r01) * sy + Math.abs(r02) * sz) / 2, (Math.abs(r20) * sx + Math.abs(r21) * sy + Math.abs(r22) * sz) / 2];
}

/** The character's root is about this high over the floor (recorded heights are the root's). */
export const ROOT_HEIGHT = 3;

/**
 * A recordings layer (cells of the query's frame) as a world-space MapLayer: each cell's low corner in studs, its
 * height from the cell's own samples when the layer carries it (4th value), else the floor under the cell (+ the root
 * height) from the geometry, else none (the renderer uses the band / map floor); a point per cell's center.
 */
export function recordingLayer(
	layer: { id: string; label: string; color: string; cells: readonly (readonly [number, number, number, number?])[]; cell?: number },
	frame: GridFrame,
	floor?: (x: number, z: number) => number | null,
): MapLayer {
	const size = layer.cell ?? frame.cell;
	const cells: NonNullable<MapLayer["cells"]> = [];
	const points: MapPoint[] = [];
	for (const c of layer.cells) {
		const { x, z } = cellToWorld(frame, c[0], c[1], size);
		let y: number | null = c[3] ?? null;
		if (y === null && floor) {
			const top = floor(x + size / 2, z + size / 2);
			y = top === null ? null : top + ROOT_HEIGHT;
		}
		cells.push({ x, z, y, n: c[2] });
		points.push({ x: x + size / 2, y: y ?? 0, z: z + size / 2 });
	}
	return { id: layer.id, label: layer.label, color: layer.color, cells, points, cellSize: size };
}

// Alignment -----------------------------------------------------------------------------------------------------------------

/** The backend's thresholds (src/maps/match.ts): box + 8 studs; aligned 80%, partial 20%, at least 10 samples. */
export const ALIGN_MARGIN = 8;
export const ALIGNED_SHARE = 0.8;
export const PARTIAL_SHARE = 0.2;
export const ALIGN_MIN_SAMPLES = 10;

export interface AlignSample {
	x: number;
	z: number;
	y?: number | null;
	/** How many samples the point stands for (a cell's count). */
	n: number;
}

/** The backend's alignment check (src/maps/match.ts `alignment`), for samples the backend doesn't read (recordings). */
export function alignmentOf(bounds: Bounds | null, samples: readonly AlignSample[], offset: Vec3 = [0, 0, 0]): MapInfo["alignment"] {
	const good = samples.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.z) && s.n > 0);
	const total = good.reduce((sum, s) => sum + s.n, 0);
	if (!bounds || total < ALIGN_MIN_SAMPLES) return { state: "unknown", samples: total, inside: 0 };
	const min = bounds.min.map((v, i) => v + (offset[i] as number) - ALIGN_MARGIN);
	const max = bounds.max.map((v, i) => v + (offset[i] as number) + ALIGN_MARGIN);
	let inside = 0;
	for (const s of good) {
		const yOk = s.y === undefined || s.y === null || !Number.isFinite(s.y) || (s.y >= (min[1] as number) && s.y <= (max[1] as number));
		if (s.x >= (min[0] as number) && s.x <= (max[0] as number) && s.z >= (min[2] as number) && s.z <= (max[2] as number) && yOk) inside += s.n;
	}
	const share = Math.round((inside / total) * 1000) / 1000;
	const state = share >= ALIGNED_SHARE ? "aligned" : share >= PARTIAL_SHARE ? "partial" : "off";
	if (state !== "off") return { state, samples: total, inside: share };
	const median = (values: [number, number][]) => {
		const sorted = [...values].sort((a, b) => a[0] - b[0]);
		let run = 0;
		for (const [v, w] of sorted) if ((run += w) >= total / 2) return v;
		return sorted[sorted.length - 1]?.[0] ?? 0;
	};
	const mx = median(good.map((s) => [s.x, s.n]));
	const mz = median(good.map((s) => [s.z, s.n]));
	const r = (v: number) => Math.round(v * 10) / 10;
	return {
		state,
		samples: total,
		inside: share,
		// What to add to the geometry so its center sits on the samples' median (y kept: recorded heights are the root's).
		suggestedOffset: [r(mx - (bounds.min[0] + bounds.max[0]) / 2), offset[1], r(mz - (bounds.min[2] + bounds.max[2]) / 2)],
	};
}

/** A recordings frame's cells (the silhouette: every sample) as alignment samples at the cells' centers. */
export function recordingSamples(frame: GridFrame, cells: readonly (readonly [number, number, number, number?])[]): AlignSample[] {
	return cells.map((c) => ({ x: frame.minX + (c[0] + 0.5) * frame.cell, z: frame.minZ + (c[1] + 0.5) * frame.cell, y: c[3] ?? null, n: c[2] }));
}
