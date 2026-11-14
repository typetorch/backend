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
	paths?: MapPoint[][];
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
