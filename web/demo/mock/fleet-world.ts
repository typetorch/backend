/**
 * Where the demo's players stand: walkable floors read from The Prison's exported map (the pack's TTMP file, the same
 * geometry the Maps page draws), and each player wandering between seeded waypoints on them. Positions are a pure
 * function of (server, player, time), so the server page's 2 Hz frames, the /live page's 3 s frames and any reload agree.
 *
 * Also the game's declared streams (plans/34): `alarms` (points: the alarm bells that ring during a riot) and `round`
 * (json: the day phase and the counts the Fleet columns show).
 */
import { decodeGeometry, FLAGS, ROOT_HEIGHT } from "@/lib/maps";
import type { GameCommand, GameStream, LivePlayer, StreamFrame, StreamPoint } from "@/lib/types";
import { readData, readDataJson } from "./data";
import { columnValuesAt, occupantsAt, type Model, type Occupant } from "./fleet-model";
import type { PackJob } from "./pack";
import { hashString, rng } from "./rng";

interface Slab {
	x: number;
	z: number;
	/** The walkable top. */
	y: number;
	/** Half sizes along the part's own axes, and its yaw. */
	hx: number;
	hz: number;
	cos: number;
	sin: number;
	w: number;
}

interface World {
	slabs: Slab[];
	total: number;
}

interface MapsIndexFile {
	latest?: { maps?: { name: string; kind: string; hash: string; bounds?: { min: number[]; max: number[] } | null }[] } | null;
}

let world: Promise<World> | undefined;

/** The walkable floors of the pack's lobby map (loaded once; a box over the map's bounds when the geometry is missing). */
export function loadWorld(): Promise<World> {
	world ??= (async () => {
		const index = await readDataJson<MapsIndexFile>("maps-index.json").catch(() => null);
		const map = index?.latest?.maps?.find((x) => x.kind === "lobby") ?? index?.latest?.maps?.[0];
		const slabs: Slab[] = [];
		if (map) {
			try {
				const g = decodeGeometry(await readData(`${map.hash}.ttmp`));
				for (let i = 0; i < g.count; i++) {
					const flags = g.flags[i] as number;
					if (!(flags & FLAGS.collide) || flags & FLAGS.invisible) continue;
					const qx = g.rotation[i * 4] as number;
					const qy = g.rotation[i * 4 + 1] as number;
					const qz = g.rotation[i * 4 + 2] as number;
					const qw = g.rotation[i * 4 + 3] as number;
					if (Math.abs(qx) > 0.05 || Math.abs(qz) > 0.05) continue;
					const sx = Math.abs(g.size[i * 3] as number);
					const sy = Math.abs(g.size[i * 3 + 1] as number);
					const sz = Math.abs(g.size[i * 3 + 2] as number);
					const area = sx * sz;
					const top = (g.position[i * 3 + 1] as number) + sy / 2;
					// Floors players walk on: flat slabs, not the roof plate over the whole prison or tiny ledges.
					if (sy > 4 || area < 120 || area > 60_000 || top > 100 || top < -20) continue;
					const yaw = 2 * Math.atan2(qy, qw);
					slabs.push({ x: g.position[i * 3] as number, z: g.position[i * 3 + 2] as number, y: top, hx: Math.max(1, sx / 2 - 2), hz: Math.max(1, sz / 2 - 2), cos: Math.cos(yaw), sin: Math.sin(yaw), w: Math.sqrt(area) });
				}
			} catch {
				// no geometry: the box below
			}
			if (!slabs.length && map.bounds) {
				const [x0 = 0, y0 = 0, z0 = 0] = map.bounds.min;
				const [x1 = 0, , z1 = 0] = map.bounds.max;
				slabs.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, y: y0 + 10, hx: (x1 - x0) / 4, hz: (z1 - z0) / 4, cos: 1, sin: 0, w: 1 });
			}
		}
		if (!slabs.length) slabs.push({ x: 0, z: 0, y: 10, hx: 40, hz: 40, cos: 1, sin: 0, w: 1 });
		return { slabs, total: slabs.reduce((s, x) => s + x.w, 0) };
	})();
	return world;
}

export function resetWorld(): void {
	world = undefined;
}

function pickSlab(w: World, r: ReturnType<typeof rng>): Slab {
	let x = r.next() * w.total;
	for (const s of w.slabs) {
		x -= s.w;
		if (x < 0) return s;
	}
	return w.slabs[w.slabs.length - 1] as Slab;
}

function pointOn(s: Slab, r: ReturnType<typeof rng>): { x: number; y: number; z: number } {
	const u = r.float(-s.hx, s.hx);
	const v = r.float(-s.hz, s.hz);
	return { x: s.x + u * s.cos + v * s.sin, y: s.y + ROOT_HEIGHT, z: s.z - u * s.sin + v * s.cos };
}

/** How long a player stays on one floor slab, and the time between waypoints on it. */
const AREA_MS = 150_000;
const STEP_MS = 7_000;

/** A player's position at `t` (ms): waypoints every 7 s on a slab, a new slab every few minutes. */
export function positionAt(w: World, key: string, t: number): { x: number; y: number; z: number; yaw: number } {
	const phase = hashString(`walk:${key}`) % AREA_MS;
	const area = Math.floor((t + phase) / AREA_MS);
	const slab = pickSlab(w, rng(`walk:${key}:area:${area}`));
	const k = Math.floor(t / STEP_MS);
	const f = (t - k * STEP_MS) / STEP_MS;
	const a = pointOn(slab, rng(`walk:${key}:${area}:${k}`));
	// The last waypoint of an area is the first of the next one's slab's own (a short walk over, or a door).
	const nextArea = Math.floor((t + STEP_MS + phase) / AREA_MS);
	const b = pointOn(nextArea === area ? slab : pickSlab(w, rng(`walk:${key}:area:${nextArea}`)), rng(`walk:${key}:${nextArea}:${k + 1}`));
	// Stand still for the first part of a step (looking around), then walk.
	const g = f < 0.35 ? 0 : (f - 0.35) / 0.65;
	const e = g * g * (3 - 2 * g);
	const yaw = Math.round(((Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI + 360) % 360);
	return { x: round2(a.x + (b.x - a.x) * e), y: round2(a.y + (b.y - a.y) * e), z: round2(a.z + (b.z - a.z) * e), yaw };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Every player of a server at `t`, as the built-in `positions` stream sends them. */
export function livePlayersAt(m: Model, w: World, j: PackJob, t: number): LivePlayer[] {
	return occupantsAt(m, j, t).map((o: Occupant): LivePlayer => {
		const key = `${j.job}:${o.pid}`;
		// Knocked out now and then (a fight in the yard), back after a respawn; just joined: no character yet.
		const down = hashString(`${key}:${Math.floor(t / 20_000)}`) % 37 === 0;
		if (t - o.joinedAt < 4_000) return { u: o.userId, n: o.name, st: "none" };
		const at = positionAt(w, key, t);
		const hp = down ? 0 : Math.max(15, 100 - (hashString(`${key}:hp:${Math.floor(t / 15_000)}`) % 9 === 0 ? hashString(key) % 70 : 0));
		return { u: o.userId, n: o.name, x: at.x, y: at.y, z: at.z, yaw: at.yaw, hp, st: down ? "dead" : "alive" };
	});
}

// The game's declarations (plans/34) ---------------------------------------------------------------------------------------

export const GAME_STREAMS: GameStream[] = [
	{ n: "alarms", hz: 0.5, k: "points", l: "Alarm bells" },
	{ n: "round", hz: 0.5, k: "json", l: "Day phase" },
];

export const GAME_COMMANDS: GameCommand[] = [
	{ n: "round_state", l: "Round state", d: "The day phase, the lockdown and the counts per team." },
	{ n: "economy", l: "Cash today", d: "Cash earned and spent on this server since it started, per source." },
	{ n: "escapes", l: "Escape routes", d: "Escapes per route since the server started." },
	{ n: "shop_stock", l: "Shop stock", d: "What the prison shop has left until the next restock." },
];

/** The alarm bells (points): rung during a lockdown, near the cell blocks. */
function alarmPoints(w: World, j: PackJob, t: number, lockdown: boolean): StreamPoint[] {
	const r = rng(`alarms:${j.job}`);
	const bells = Array.from({ length: 5 }, (_, i) => ({ ...pointOn(pickSlab(w, r), r), label: `Bell ${String.fromCharCode(65 + i)}` }));
	return bells.map((b, i) => ({ x: round2(b.x), y: round2(b.y + 6), z: round2(b.z), label: b.label, color: lockdown && (i + Math.floor(t / 2000)) % 2 === 0 ? "#ef4444" : "#9ca3af" }));
}

/** Frames of one server in (since, now]: positions at 2 Hz, the game's streams at 0.5 Hz (kept 120 s, like the hub). */
export function framesFor(m: Model, w: World, j: PackJob, since: number | undefined, now: number): StreamFrame[] {
	const step = 500;
	const from = Math.max(since ?? now - 10_000, now - 120_000);
	const out: StreamFrame[] = [];
	for (let t = Math.floor(from / step) * step + step; t <= now; t += step) {
		if (t <= from) continue;
		const s: StreamFrame["s"] = { positions: { players: livePlayersAt(m, w, j, t) } };
		if (t % 2000 === 0) {
			const players = s.positions?.players.length ?? 0;
			const cv = columnValuesAt(j, t, players);
			s["game.round"] = { phase: cv.phase, lockdown: cv.lockdown, inmates: cv.inmates, guards: cv.guards, medics: cv.medics, escapes: cv.escapes, arrests: cv.arrests };
			s["game.alarms"] = { points: alarmPoints(w, j, t, cv.lockdown === true) };
		}
		out.push({ t, s });
	}
	return out;
}
