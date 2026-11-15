/**
 * Plans/34: the live map's data path, plain functions (no React, no three.js): which exported map a position is on, the
 * map most players are on, positions interpolated between the kernel's frames (2 Hz on the server page, one every 3 s on
 * /live) so dots move smoothly, each player's short trail, and the MapScene layers (lib/maps.ts MapLayer).
 *
 * Frames hold player names and positions: callers keep them in component state only (never the query cache,
 * localStorage or the URL), like remote debug answers.
 */
import { ALIGN_MARGIN, LAYER_COLORS, type MapInfo, type MapLayer, type MapPoint } from "./maps";
import type { LivePlayer, StreamFrame, StreamPoint } from "./types";

/** The trail: the last this many ms of a player's positions. */
export const TRAIL_MS = 20_000;
/** A jump longer than this (studs) between two samples breaks the trail (a teleport, a map change). */
export const TRAIL_BREAK = 40;
/** How far behind the newest frame the server page draws, so there is a next frame to move toward. */
export const SERVER_DELAY_MS = 1_000;
/** The same on /live (a frame every 3 s). */
export const LIVE_DELAY_MS = 3_000;
/** A 2D click or hover picks the nearest dot within this many studs. */
export const PICK_STUDS = 8;

/** A placed player: one with a position. */
export interface PlacedPlayer extends LivePlayer {
	x: number;
	y: number;
	z: number;
}

export const isPlaced = (p: LivePlayer): p is PlacedPlayer => p.st !== "none" && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** An exported map's box in world studs (bounds + offset), grown by `margin`. */
function worldBox(m: MapInfo, margin: number): { minX: number; maxX: number; minZ: number; maxZ: number; area: number } | null {
	if (!m.bounds) return null;
	const [ox, , oz] = m.offset;
	const minX = m.bounds.min[0] + ox - margin;
	const maxX = m.bounds.max[0] + ox + margin;
	const minZ = m.bounds.min[2] + oz - margin;
	const maxZ = m.bounds.max[2] + oz + margin;
	return { minX, maxX, minZ, maxZ, area: (maxX - minX) * (maxZ - minZ) };
}

/**
 * The exported map a position is on: one whose bounds plus 8 studs contain (x, z) (a round map before the lobby, then the
 * smallest), else the lobby's export, else null.
 */
export function mapForPosition(maps: readonly MapInfo[], x: number, z: number): MapInfo | null {
	let best: { m: MapInfo; area: number } | null = null;
	for (const m of maps) {
		const box = worldBox(m, ALIGN_MARGIN);
		if (!box || x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
		const better = !best || (m.kind === "map" && best.m.kind !== "map") || (m.kind === best.m.kind && box.area < best.area);
		if (better) best = { m, area: box.area };
	}
	return best?.m ?? maps.find((m) => m.kind === "lobby") ?? null;
}

/** Players per map name (each placed player's map), and the map most are on (ties: the first name). */
export function mapCounts(maps: readonly MapInfo[], players: readonly { x: number; z: number }[]): { counts: Map<string, number>; top: string | null } {
	const counts = new Map<string, number>();
	for (const p of players) {
		const m = mapForPosition(maps, p.x, p.z);
		if (m) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
	}
	let top: string | null = null;
	for (const [name, n] of counts) if (top === null || n > (counts.get(top) ?? 0)) top = name;
	return { counts, top };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** The angle between a and b by the short way round. */
function lerpAngle(a: number, b: number, k: number): number {
	let d = b - a;
	while (d > Math.PI) d -= 2 * Math.PI;
	while (d < -Math.PI) d += 2 * Math.PI;
	return a + d * k;
}

/**
 * The players at time `at` (the kernel's clock), from positions frames sorted by t: each placed player moved between
 * the frame before and the frame after `at`. Past the newest frame, its positions; before the oldest, the oldest's.
 * A player who isn't in the next frame stays where the earlier one had them; a new one appears at its first position.
 */
export function playersAt(frames: readonly StreamFrame[], at: number): LivePlayer[] {
	const withPositions = frames.filter((f) => f.s.positions);
	if (!withPositions.length) return [];
	const after = withPositions.findIndex((f) => f.t > at);
	if (after === -1) return (withPositions[withPositions.length - 1] as StreamFrame).s.positions?.players ?? [];
	if (after === 0) return (withPositions[0] as StreamFrame).s.positions?.players ?? [];
	const a = withPositions[after - 1] as StreamFrame;
	const b = withPositions[after] as StreamFrame;
	const k = b.t === a.t ? 1 : Math.min(1, Math.max(0, (at - a.t) / (b.t - a.t)));
	const before = new Map((a.s.positions?.players ?? []).map((p) => [p.u, p]));
	return (b.s.positions?.players ?? []).map((next) => {
		const prev = before.get(next.u);
		if (!prev || !isPlaced(prev) || !isPlaced(next)) return k < 0.5 && prev ? prev : next;
		return {
			...next,
			x: lerp(prev.x, next.x, k),
			y: lerp(prev.y, next.y, k),
			z: lerp(prev.z, next.z, k),
			...(prev.yaw !== undefined && next.yaw !== undefined ? { yaw: lerpAngle(prev.yaw, next.yaw, k) } : {}),
		};
	});
}

/** Where to draw: `delay` behind the newest frame, moving on with the time since it arrived (never past it). */
export function renderTime(newestT: number, sinceArrivedMs: number, delay: number): number {
	return newestT - delay + Math.min(delay, Math.max(0, sinceArrivedMs));
}

/**
 * Each player's trail: their positions in frames from `at - TRAIL_MS` to `at`, then `now` (the interpolated point),
 * split where they jump more than TRAIL_BREAK studs.
 */
export function trails(frames: readonly StreamFrame[], at: number, now: readonly LivePlayer[]): Map<number, MapPoint[][]> {
	const raw = new Map<number, MapPoint[]>();
	for (const f of frames) {
		if (f.t < at - TRAIL_MS || f.t > at || !f.s.positions) continue;
		for (const p of f.s.positions.players) {
			if (!isPlaced(p)) continue;
			const list = raw.get(p.u) ?? [];
			list.push({ x: p.x, y: p.y, z: p.z });
			raw.set(p.u, list);
		}
	}
	for (const p of now) {
		if (!isPlaced(p)) continue;
		const list = raw.get(p.u) ?? [];
		list.push({ x: p.x, y: p.y, z: p.z });
		raw.set(p.u, list);
	}
	const out = new Map<number, MapPoint[][]>();
	for (const [u, points] of raw) {
		const paths: MapPoint[][] = [[]];
		for (const point of points) {
			const path = paths[paths.length - 1] as MapPoint[];
			const last = path[path.length - 1];
			if (last && Math.hypot(point.x - last.x, point.z - last.z) > TRAIL_BREAK) paths.push([point]);
			else path.push(point);
		}
		out.set(u, paths.filter((p) => p.length > 1));
	}
	return out;
}

/** A stable color for a key (a UserId, a JobId). */
export function colorFor(key: string | number): string {
	const text = String(key);
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
	return LAYER_COLORS[h % LAYER_COLORS.length] as string;
}

/** One dot on the live map: a player, the key that picks and follows them, the color, an optional trail. */
export interface LiveDot {
	key: string;
	name: string;
	x: number;
	y: number;
	z: number;
	color: string;
	/** What the dot belongs to (the /live page: the server). */
	group?: string;
	trail?: MapPoint[][];
}

/** The scene's layers: trails first (under), then a dot per player (the followed one bigger), then the markers. */
export function liveLayers(dots: readonly LiveDot[], markers: readonly MapLayer[], followed: string | null): MapLayer[] {
	const out: MapLayer[] = [];
	for (const d of dots) if (d.trail?.length) out.push({ id: `trail:${d.key}`, label: `${d.name}'s trail`, color: d.color, paths: d.trail });
	for (const d of dots) out.push({ id: `dot:${d.key}`, label: d.name, color: d.color, points: [{ x: d.x, y: d.y, z: d.z }], pointSize: d.key === followed ? 14 : 9 });
	out.push(...markers);
	return out;
}

/** The dot nearest (x, z) within PICK_STUDS (a 2D point, or a 3D pick: MapRenderer.pickAt), or null. */
export function nearestDot(dots: readonly LiveDot[], x: number, z: number, within = PICK_STUDS): LiveDot | null {
	let best: LiveDot | null = null;
	let bestD = within;
	for (const d of dots) {
		const dist = Math.hypot(d.x - x, d.z - z);
		if (dist <= bestD) [best, bestD] = [d, dist];
	}
	return best;
}

/** A `points` stream's latest value as marker layers (one per color; points without one take the stream's). */
export function pointLayers(stream: string, label: string, value: unknown, color: string): MapLayer[] {
	const points = (value as { points?: StreamPoint[] } | null)?.points;
	if (!Array.isArray(points)) return [];
	const byColor = new Map<string, MapPoint[]>();
	for (const p of points) {
		if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y) || !Number.isFinite(p?.z)) continue;
		const c = typeof p.color === "string" && p.color ? p.color : color;
		byColor.set(c, [...(byColor.get(c) ?? []), { x: p.x, y: p.y, z: p.z }]);
	}
	return [...byColor].map(([c, list], i) => ({ id: `marker:${stream}:${i}`, label, color: c, points: list, pointSize: 6 }));
}

/** The newest value of a stream in the frames (undefined: none yet). */
export function latestValue(frames: readonly StreamFrame[], stream: string): { t: number; value: unknown } | undefined {
	for (let i = frames.length - 1; i >= 0; i--) {
		const f = frames[i] as StreamFrame;
		if (Object.hasOwn(f.s, stream)) return { t: f.t, value: f.s[stream] };
	}
	return undefined;
}

/** Frames merged: the new ones after the held ones (by t, no repeats), only the last `keepMs` of the newest. */
export function mergeFrames(held: readonly StreamFrame[], incoming: readonly StreamFrame[], keepMs = 120_000): StreamFrame[] {
	const byT = new Map<number, StreamFrame>();
	for (const f of held) byT.set(f.t, f);
	for (const f of incoming) byT.set(f.t, byT.has(f.t) ? { t: f.t, s: { ...(byT.get(f.t) as StreamFrame).s, ...f.s } } : f);
	const all = [...byT.values()].sort((a, b) => a.t - b.t);
	const newest = all[all.length - 1]?.t ?? 0;
	return all.filter((f) => f.t >= newest - keepMs);
}
