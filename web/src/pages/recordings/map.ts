/**
 * The Recordings page's plain helpers: layer colours, cell shading, frames from a session's own samples, where the
 * character was at a moment of a replay, and the replay timeline's markers. Kept apart from the components for tests.
 */
import type { RecCell, RecFrame, RecordingReplayResult } from "@/lib/types";

/** The no-map layer's name (src/recording-analysis.ts NO_MAP). */
export const NO_MAP = "(lobby / unknown)";

export const RECORDING_LAYERS = ["path", "idle", "death", "spawn", "screen_open", "screen_close", "button", "prompt", "quit"] as const;

export const LAYER_NAMES: Record<string, string> = {
	path: "Positions",
	idle: "Idle spots",
	death: "Deaths",
	spawn: "Spawns",
	screen_open: "Screens opened",
	screen_close: "Screens closed",
	button: "Button presses",
	prompt: "Prompts used",
	quit: "Quits",
};

/** Colours that read on light and dark backgrounds. */
const LAYER_COLORS: Record<string, string> = {
	path: "#3b82f6",
	idle: "#f59e0b",
	death: "#ef4444",
	spawn: "#10b981",
	screen_open: "#8b5cf6",
	screen_close: "#a78bfa",
	button: "#ec4899",
	prompt: "#14b8a6",
	quit: "#dc2626",
};
const EVENT_COLORS = ["#f97316", "#06b6d4", "#84cc16", "#e11d48", "#6366f1", "#eab308"];

export function layerColor(id: string, index = 0): string {
	return LAYER_COLORS[id] ?? EVENT_COLORS[index % EVENT_COLORS.length];
}

export function layerName(id: string): string {
	if (LAYER_NAMES[id]) return LAYER_NAMES[id];
	const m = /^ev:([^:]+):(.+)$/.exec(id);
	return m ? `${m[2]} (${m[1]})` : id;
}

export function mapName(map: string): string {
	return map === NO_MAP ? "Lobby / no map" : map;
}

/** 0..1 shade of a cell: square root, so a few busy cells don't wash out the rest; a floor so single points show. */
export function shade(count: number, max: number, floor = 0.18): number {
	if (max <= 0 || count <= 0) return 0;
	return floor + (1 - floor) * Math.sqrt(Math.min(1, count / max));
}

export function maxCount(cells: readonly RecCell[]): number {
	let max = 0;
	for (const c of cells) if (c[2] > max) max = c[2];
	return max;
}

/** A cell's area in studs: [x0, z0, x1, z1]. */
export function cellBox(frame: RecFrame, col: number, row: number): [number, number, number, number] {
	const x0 = frame.minX + col * frame.cell;
	const z0 = frame.minZ + row * frame.cell;
	return [x0, z0, x0 + frame.cell, z0 + frame.cell];
}

/** A frame around points (studs), for a map the layers query has no frame for. */
export function frameAround(points: readonly [number, number][], grid = 96): RecFrame | null {
	if (!points.length) return null;
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (const [x, z] of points) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minZ = Math.min(minZ, z);
		maxZ = Math.max(maxZ, z);
	}
	const pad = Math.max(8, (maxX - minX) * 0.1, (maxZ - minZ) * 0.1);
	minX -= pad;
	maxX += pad;
	minZ -= pad;
	maxZ += pad;
	const cell = 4 * Math.max(1, Math.ceil(Math.max(maxX - minX, maxZ - minZ) / (4 * grid)));
	const fx = Math.floor(minX / cell) * cell;
	const fz = Math.floor(minZ / cell) * cell;
	const cols = Math.max(1, Math.ceil((maxX - fx) / cell));
	const rows = Math.max(1, Math.ceil((maxZ - fz) / cell));
	return { minX: fx, minZ: fz, maxX: fx + cols * cell, maxZ: fz + rows * cell, cell, cols, rows };
}

export type ReplaySample = NonNullable<RecordingReplayResult["samples"]>[number];

/** The map at `t` (ms after the start) from the replay's map segments. */
export function mapAtTime(maps: RecordingReplayResult["maps"], t: number): string | undefined {
	let found: string | undefined;
	for (const m of maps ?? []) {
		if (m.t > t) break;
		found = m.map;
	}
	return found ?? maps?.[0]?.map;
}

export interface Pose {
	x: number;
	z: number;
	/** Camera yaw (radians, 0 = facing -Z, "up" on the map), when known. */
	yaw: number | null;
}

/** Where the character was at `t`: between the samples around it (no jump across a teleport longer than `jump` studs). */
export function poseAt(samples: readonly ReplaySample[], t: number, jump = 30): Pose | null {
	let before: ReplaySample | undefined;
	let after: ReplaySample | undefined;
	for (const s of samples) {
		if (s[1] === null || s[3] === null) continue;
		if (s[0] <= t) before = s;
		else {
			after = s;
			break;
		}
	}
	const base = before ?? after;
	if (!base) return null;
	const yawOf = (s: ReplaySample) => s[4];
	if (!before || !after || after[0] === before[0]) return { x: base[1] as number, z: base[3] as number, yaw: yawOf(base) };
	const bx = before[1] as number;
	const bz = before[3] as number;
	const ax = after[1] as number;
	const az = after[3] as number;
	if (Math.hypot(ax - bx, az - bz) > jump) return { x: bx, z: bz, yaw: yawOf(before) };
	const k = (t - before[0]) / (after[0] - before[0]);
	return { x: bx + (ax - bx) * k, z: bz + (az - bz) * k, yaw: yawOf(before) };
}

/** The camera cone's corners (studs): from the character, `length` long, `spread` radians each side. */
export function cone(pose: Pose, length = 12, spread = Math.PI / 6): [number, number][] | null {
	if (pose.yaw === null) return null;
	const dir = (a: number): [number, number] => [pose.x - Math.sin(a) * length, pose.z - Math.cos(a) * length];
	return [[pose.x, pose.z], dir(pose.yaw - spread), dir(pose.yaw + spread)];
}

export type MarkerKind = "input" | "ui" | "event" | "signal";

export interface Marker {
	t: number;
	kind: MarkerKind;
	label: string;
	color: string;
}

/** Types too frequent to mark one by one (keys, sticks, hovers): only counted. */
const QUIET = new Set(["key", "stick_start", "stick_stop", "scroll", "hover", "pad", "prompt_shown", "prompt_hidden"]);

const INPUT_LABELS: Record<string, string> = {
	click: "Click",
	tap: "Tap",
	button: "Button",
	screen_open: "Opened",
	screen_close: "Closed",
	prompt_used: "Prompt",
	death: "Died",
	spawn: "Spawned",
	textbox: "Text box",
	custom: "Event",
};

/** Timeline markers: the inputs worth a mark, the session's events (no state noise) and the confusion signals. */
export function markers(replay: RecordingReplayResult): Marker[] {
	const out: Marker[] = [];
	for (const i of replay.inputs ?? []) {
		if (QUIET.has(i.type)) continue;
		const label = `${INPUT_LABELS[i.type] ?? i.type}${i.target ? `: ${i.target}` : ""}`;
		const kind: MarkerKind = i.type === "click" || i.type === "tap" ? "input" : "ui";
		out.push({ t: i.t, kind, label, color: i.type === "death" ? "#ef4444" : kind === "input" ? "#94a3b8" : "#8b5cf6" });
	}
	for (const e of replay.events ?? []) {
		if (e.kind === "state" || e.kind === "zone" || e.kind === "recording_meta") continue;
		if (e.t < 0 || (replay.duration !== undefined && e.t > replay.duration)) continue;
		out.push({ t: e.t, kind: "event", label: `${e.kind} / ${e.name}`, color: "#f97316" });
	}
	for (const s of replay.signals ?? []) {
		const label = s.kind === "idle" ? `Idle ${Math.round(s.amount / 1000)} s` : s.kind === "camera_spin" ? "Camera spin" : `Pressed ${s.amount}x${s.target ? `: ${s.target}` : ""}`;
		out.push({ t: s.t, kind: "signal", label, color: "#f59e0b" });
	}
	return out.sort((a, b) => a.t - b.t);
}

/** The latest state (zone / screen) at `t`, from the replay's events. */
export function stateAtTime(replay: RecordingReplayResult, t: number): { zone: string | null; screen: string | null } {
	let state: string | null | undefined;
	for (const e of replay.events ?? []) {
		if (e.t > t) break;
		if (e.state !== undefined) state = e.state;
	}
	const part = (key: string) => {
		for (const piece of (state ?? "").split("|")) if (piece.startsWith(`${key}:`)) return piece.slice(key.length + 1) || null;
		return null;
	};
	return { zone: part("zone"), screen: part("screen") };
}

export function fmtClock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${Math.floor((Math.max(0, ms) % 1000) / 100)}`;
}

export const REASON_LABELS: Record<string, string> = {
	screen: "A screen was open",
	died: "Died or downed shortly before",
	idle: "Idle (no input, not moving)",
	dead_clicks: "Presses that changed nothing",
	stuck: "Stuck (pressing to move, not moving)",
	tutorial: "In a tutorial step",
	place: "Where they stood",
	none: "None of these",
};

export const ACTION_LABELS: Record<string, string> = {
	move: "First move",
	screen: "First screen opened",
	button: "First button press",
	prompt: "First prompt used",
	round: "First round start",
};
