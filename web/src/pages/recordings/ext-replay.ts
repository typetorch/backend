/**
 * The replay's extended streams (plans/36) at a moment: plain functions, no three.js, for the Player view and its tests.
 *
 *   - Camera: the recorded camera between samples (tt-rec-1, every session); FOV from tt-ext-1 View, else 70.
 *   - The recorded player: its root between samples, facing the character yaw.
 *   - Entities (other players, tracked models): between their Move records, alive from Spawn to Gone.
 *   - Poses: each joint's recorded Motor6D.Transform, slerped between its samples (a joint not re-sent held its value).
 *   - Animations: the tracks playing on an entity, their clip time (TimePosition + the speed integrated since the play)
 *     and weight; clips from GET /api/v1/anims/<id> sampled by joint name (or by the part name Roblox's KeyframeSequence
 *     uses, mapped to its Motor6D on the standard rigs). Blend: the clip pose, then a recorded Pose overrides the
 *     joints it has, fading back to the clip within POSE_FADE_MS of each sample (drift correction).
 */
import type { ExtAnim, ExtEntity, ExtendedReplay, ExtRigKind, RecordingReplayResult } from "@/lib/types";

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

const IDENTITY: Quat = [0, 0, 0, 1];

/** Spherical interpolation, the shorter way round. */
export function slerp(a: Quat, b: Quat, k: number): Quat {
	let [bx, by, bz, bw] = b;
	let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
	if (cos < 0) {
		cos = -cos;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}
	let ka = 1 - k;
	let kb = k;
	if (cos < 0.9995) {
		const angle = Math.acos(Math.min(1, cos));
		const sin = Math.sin(angle);
		ka = Math.sin((1 - k) * angle) / sin;
		kb = Math.sin(k * angle) / sin;
	}
	const out: Quat = [a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb];
	const n = Math.hypot(...out) || 1;
	return [out[0] / n, out[1] / n, out[2] / n, out[3] / n];
}

/** The last index whose time is <= t (-1: none), by binary search over ascending times. */
export function lastAtOrBefore(times: ArrayLike<number>, t: number): number {
	let lo = 0;
	let hi = times.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((times[mid] as number) <= t) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

function angleLerp(a: number, b: number, k: number): number {
	let d = b - a;
	while (d > Math.PI) d -= Math.PI * 2;
	while (d < -Math.PI) d += Math.PI * 2;
	return a + d * k;
}

// The viewport and the camera -------------------------------------------------------------------------------------------

export interface ViewState {
	w: number;
	h: number;
	inset: number;
	fov: number;
	fps: number | null;
}

/** The session's viewport from its `session` / `device` event (w, h), when it has one. */
export function deviceViewport(replay: RecordingReplayResult): { w: number; h: number } | null {
	const e = (replay.events ?? []).find((x) => x.kind === "session" && x.name === "device");
	const w = Number(e?.props?.w);
	const h = Number(e?.props?.h);
	return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** The viewport, inset, FOV and fps at `t`: tt-ext-1 View records, else the device event and FOV 70. */
export function viewAt(replay: RecordingReplayResult, t: number): ViewState {
	const views = replay.extended?.view ?? [];
	if (views.length) {
		const i = Math.max(0, lastAtOrBefore(views.map((v) => v[0]), t));
		const v = views[i] as ExtendedReplay["view"][number];
		return { w: v[1] || 1280, h: v[2] || 720, inset: v[3], fov: v[4] || 70, fps: v[5] };
	}
	const device = deviceViewport(replay);
	return { w: device?.w ?? 1280, h: device?.h ?? 720, inset: 0, fov: 70, fps: null };
}

export interface CameraState {
	position: Vec3;
	/** Unit look direction. */
	look: Vec3;
	yaw: number;
	pitch: number;
}

type Sample = NonNullable<RecordingReplayResult["samples"]>[number];

/** The two samples around `t` that have `has`, and how far between them (no blend across a jump of `jump` studs). */
function around(samples: readonly Sample[], t: number, has: (s: Sample) => boolean, pos: (s: Sample) => Vec3, jump: number): { a: Sample; b: Sample; k: number } | null {
	let i = lastAtOrBefore(
		samples.map((s) => s[0]),
		t,
	);
	while (i >= 0 && !has(samples[i] as Sample)) i--;
	let j = i + 1;
	while (j < samples.length && !has(samples[j] as Sample)) j++;
	const a = i >= 0 ? (samples[i] as Sample) : undefined;
	const b = j < samples.length ? (samples[j] as Sample) : undefined;
	if (!a && !b) return null;
	if (!a || !b) return { a: (a ?? b) as Sample, b: (a ?? b) as Sample, k: 0 };
	const pa = pos(a);
	const pb = pos(b);
	if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) > jump || b[0] === a[0]) return { a, b: a, k: 0 };
	return { a, b, k: Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) };
}

const camPos = (s: Sample): Vec3 => [s[7] ?? 0, s[8] ?? 0, s[9] ?? 0];

/** The recorded camera at `t` (null: the replay has no camera positions, e.g. an older server). */
export function cameraAt(replay: RecordingReplayResult, t: number): CameraState | null {
	const samples = replay.samples ?? [];
	const hit = around(samples, t, (s) => s[7] !== null && s[7] !== undefined && s[4] !== null, camPos, 60);
	if (!hit) return null;
	const { a, b, k } = hit;
	const pa = camPos(a);
	const pb = camPos(b);
	const position: Vec3 = [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k];
	const yaw = angleLerp(a[4] as number, b[4] as number, k);
	const ly = Math.max(-1, Math.min(1, (a[5] ?? 0) + ((b[5] ?? 0) - (a[5] ?? 0)) * k));
	const flat = Math.sqrt(1 - ly * ly);
	return { position, look: [-Math.sin(yaw) * flat, ly, -Math.cos(yaw) * flat], yaw, pitch: Math.asin(ly) };
}

export interface RootState {
	position: Vec3;
	/** Facing (radians, 0 = facing -Z). */
	yaw: number;
}

const rootPos = (s: Sample): Vec3 => [s[1] ?? 0, s[2] ?? 0, s[3] ?? 0];

/** The recorded player's root at `t` (null: no character then). Facing: the character yaw, else the camera's. */
export function selfAt(replay: RecordingReplayResult, t: number): RootState | null {
	const samples = replay.samples ?? [];
	const hit = around(samples, t, (s) => s[1] !== null && s[3] !== null, rootPos, 30);
	if (!hit) return null;
	const { a, b, k } = hit;
	// no character at `t` itself (between a death and a respawn): the samples say so
	const exact = samples[lastAtOrBefore(samples.map((s) => s[0]), t)];
	if (exact && exact[1] === null && exact[0] > a[0]) return null;
	const pa = rootPos(a);
	const pb = rootPos(b);
	const ya = a[6] ?? a[4] ?? 0;
	const yb = b[6] ?? b[4] ?? ya;
	return { position: [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k], yaw: angleLerp(ya, yb, k) };
}

// AFK, entities ---------------------------------------------------------------------------------------------------------

export function afkAt(ext: ExtendedReplay | null | undefined, t: number): boolean {
	return (ext?.afk ?? []).some(([from, to]) => t >= from && (to === null || t < to));
}

export function alive(item: { from: number; to: number | null }, t: number): boolean {
	return t >= item.from && (item.to === null || t < item.to);
}

/** An entity's position and yaw at `t` (null: not alive). Between Moves; no blend across a 30-stud jump. */
export function entityAt(ent: ExtEntity, t: number): RootState | null {
	if (!alive(ent, t) || !ent.moves.length) return null;
	const i = lastAtOrBefore(
		ent.moves.map((m) => m[0]),
		t,
	);
	const a = ent.moves[Math.max(0, i)] as ExtEntity["moves"][number];
	const b = ent.moves[i + 1];
	if (i < 0 || !b || b[0] === a[0] || Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) > 30) return { position: [a[1], a[2], a[3]], yaw: a[4] };
	const k = (t - a[0]) / (b[0] - a[0]);
	return { position: [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k], yaw: angleLerp(a[4], b[4], k) };
}

/** Kind colours (the legend and the boxes): a fixed palette by kind name, the same on every replay. */
const KIND_PALETTE = ["#e8590c", "#2f9e44", "#ae3ec9", "#1c7ed6", "#f08c00", "#0c8599", "#e03131", "#5c7cfa"];

export function kindColor(kind: string): string {
	if (kind === "player") return "#3b82f6";
	if (kind === "self") return "#ef4444";
	let h = 0;
	for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
	return KIND_PALETTE[h % KIND_PALETTE.length] as string;
}

/** A readable name per entity: other players numbered in order of appearance ("player 1"), models by kind. */
export function entityNames(ext: ExtendedReplay): Map<number, string> {
	const out = new Map<number, string>();
	let players = 0;
	for (const ent of ext.entities) {
		if (ent.e === 0) out.set(0, "recorded player");
		else if (ent.player) out.set(ent.e, `player ${++players}`);
		else out.set(ent.e, `${ent.kind} #${ent.e}`);
	}
	return out;
}

// Rigs and poses --------------------------------------------------------------------------------------------------------

export interface Rig {
	rig: ExtRigKind;
	joints: string[];
}

/** An entity's rig at `t` (the latest Rig record at or before it, else its first). */
export function rigAt(ext: ExtendedReplay, e: number, t: number): Rig | null {
	let found: Rig | null = null;
	for (const r of ext.rigs) {
		if (r.e !== e) continue;
		if (r.t <= t || !found) found = { rig: r.rig, joints: r.joints };
		if (r.t > t) break;
	}
	return found;
}

/** Recorded joint rotations per entity and joint name: ascending times and their quaternions. */
export type PoseTracks = Map<number, Map<string, { t: number[]; q: Quat[] }>>;

export function poseTracks(ext: ExtendedReplay): PoseTracks {
	const out: PoseTracks = new Map();
	const rigsOf = new Map<number, { t: number; joints: string[] }[]>();
	for (const r of ext.rigs) {
		let list = rigsOf.get(r.e);
		if (!list) rigsOf.set(r.e, (list = []));
		list.push({ t: r.t, joints: r.joints });
	}
	for (const [t, e, j, x, y, z, w] of ext.poses) {
		const rigs = rigsOf.get(e);
		if (!rigs) continue;
		const rig = rigs[Math.max(0, lastAtOrBefore(rigs.map((r) => r.t), t))];
		const name = rig?.joints[j];
		if (!name) continue;
		let joints = out.get(e);
		if (!joints) out.set(e, (joints = new Map()));
		let track = joints.get(name);
		if (!track) joints.set(name, (track = { t: [], q: [] }));
		track.t.push(t);
		track.q.push([x, y, z, w]);
	}
	return out;
}

/** The recorded pose at `t` (slerp between a joint's samples) and, per joint, how far (ms) `t` is from its nearest sample. */
export function recordedPose(tracks: PoseTracks, e: number, t: number): { pose: Record<string, Quat>; near: Record<string, number> } {
	const pose: Record<string, Quat> = {};
	const near: Record<string, number> = {};
	for (const [name, track] of tracks.get(e) ?? []) {
		const i = lastAtOrBefore(track.t, t);
		if (i < 0) continue; // before its first sample: rest
		const a = track.q[i] as Quat;
		const ta = track.t[i] as number;
		const tb = track.t[i + 1];
		if (tb === undefined) {
			pose[name] = a;
			near[name] = t - ta;
			continue;
		}
		pose[name] = slerp(a, track.q[i + 1] as Quat, (t - ta) / (tb - ta));
		near[name] = Math.min(t - ta, tb - t);
	}
	return { pose, near };
}

// Animations ------------------------------------------------------------------------------------------------------------

/** GET /api/v1/anims/<id> (another branch's endpoint). */
export interface AnimClip {
	id: string;
	/** Seconds. */
	length: number;
	looped: boolean;
	keyframes: { t: number; poses: Record<string, Quat> }[];
	priority?: number;
}

/** The digits of an AnimationId (`rbxassetid://123`, `http://www.roblox.com/asset/?id=123`), else null. */
export function animIdOf(content: string): string | null {
	const m = /(\d{1,20})\s*$/.exec(content.trim());
	return m ? (m[1] as string) : null;
}

export interface PlayingTrack {
	anim: ExtAnim;
	/** Seconds into the clip (not wrapped). */
	time: number;
	speed: number;
	weight: number;
}

/** The tracks playing on entity `e` at `t`, with their clip time and weight. */
export function tracksAt(ext: ExtendedReplay, e: number, t: number): PlayingTrack[] {
	const out: PlayingTrack[] = [];
	for (const anim of ext.anims) {
		if (anim.e !== e || !alive(anim, t)) continue;
		let time = anim.time;
		let speed = anim.adjust[0]?.[1] ?? 1;
		let weight = anim.adjust[0]?.[2] ?? 1;
		let since = anim.from;
		for (const [at, s, w] of anim.adjust) {
			if (at > t) break;
			time += ((at - since) / 1000) * speed;
			since = at;
			speed = s;
			weight = w;
		}
		time += ((t - since) / 1000) * speed;
		out.push({ anim, time, speed, weight });
	}
	return out;
}

/** KeyframeSequence Poses are named after parts; on the standard rigs each part has one Motor6D (its Part1). */
export const PART_TO_JOINT: Record<string, string> = {
	Torso: "RootJoint",
	Head: "Neck",
	"Left Arm": "Left Shoulder",
	"Right Arm": "Right Shoulder",
	"Left Leg": "Left Hip",
	"Right Leg": "Right Hip",
	LowerTorso: "Root",
	UpperTorso: "Waist",
	LeftUpperArm: "LeftShoulder",
	LeftLowerArm: "LeftElbow",
	LeftHand: "LeftWrist",
	RightUpperArm: "RightShoulder",
	RightLowerArm: "RightElbow",
	RightHand: "RightWrist",
	LeftUpperLeg: "LeftHip",
	LeftLowerLeg: "LeftKnee",
	LeftFoot: "LeftAnkle",
	RightUpperLeg: "RightHip",
	RightLowerLeg: "RightKnee",
	RightFoot: "RightAnkle",
};

/** A clip's pose at `time` (s): slerp between the keyframes around it; looped clips wrap, others hold their ends. */
export function sampleClip(clip: AnimClip, time: number, looped = clip.looped): Record<string, Quat> {
	const frames = clip.keyframes;
	const out: Record<string, Quat> = {};
	if (!frames.length) return out;
	const length = clip.length > 0 ? clip.length : (frames[frames.length - 1] as AnimClip["keyframes"][number]).t;
	let at = time;
	if (looped && length > 0) at = ((at % length) + length) % length;
	else at = Math.max(0, Math.min(length, at));
	const times = frames.map((f) => f.t);
	const i = lastAtOrBefore(times, at);
	const a = frames[Math.max(0, i)] as AnimClip["keyframes"][number];
	const b = frames[i + 1];
	const k = b && i >= 0 && b.t > a.t ? (at - a.t) / (b.t - a.t) : 0;
	const names = new Set([...Object.keys(a.poses), ...Object.keys(b?.poses ?? {})]);
	for (const name of names) {
		const joint = PART_TO_JOINT[name] ?? name;
		const qa = a.poses[name] ?? b?.poses[name];
		const qb = b?.poses[name] ?? qa;
		if (!qa || !qb) continue;
		out[joint] = k > 0 ? slerp(qa, qb, k) : qa;
	}
	return out;
}

/** A recorded sample overrides the clip this close to it (ms), fading to the clip at the edge. */
export const POSE_FADE_MS = 150;

/**
 * The pose to draw: the playing clips (higher priority, then higher weight, then the latest started wins a joint; a
 * weight under 1 blends from rest), then the recorded joints: alone when no clip has the joint, else fading in near
 * their samples.
 */
export function blendPose(playing: readonly { pose: Record<string, Quat>; weight: number; priority: number; from: number }[], recorded: { pose: Record<string, Quat>; near: Record<string, number> }): Record<string, Quat> {
	const out: Record<string, Quat> = {};
	const order = [...playing].sort((a, b) => b.priority - a.priority || b.weight - a.weight || b.from - a.from);
	for (const clip of order) {
		for (const [joint, q] of Object.entries(clip.pose)) {
			if (out[joint]) continue;
			out[joint] = clip.weight >= 0.999 ? q : slerp(IDENTITY, q, Math.max(0, clip.weight));
		}
	}
	for (const [joint, q] of Object.entries(recorded.pose)) {
		const base = out[joint];
		if (!base) {
			out[joint] = q;
			continue;
		}
		const k = 1 - Math.min(1, (recorded.near[joint] ?? Number.POSITIVE_INFINITY) / POSE_FADE_MS);
		if (k > 0) out[joint] = slerp(base, q, k);
	}
	return out;
}

// The timeline strips ----------------------------------------------------------------------------------------------------

const CAPTION_TYPES: Record<string, string> = { button: "Button", screen_open: "Opened", screen_close: "Closed", prompt_shown: "Prompt shown", prompt_used: "Prompt used", prompt_hidden: "Prompt hidden" };

export interface Caption {
	t: number;
	type: string;
	label: string;
}

/** Button / screen / prompt events, for the captions strip. */
export function captions(replay: RecordingReplayResult): Caption[] {
	return (replay.inputs ?? []).filter((i) => CAPTION_TYPES[i.type] && i.target).map((i) => ({ t: i.t, type: i.type, label: `${CAPTION_TYPES[i.type]}: ${i.target}` }));
}

/** The caption shown at `t`: the latest one within `hold` ms. */
export function captionAt(list: readonly Caption[], t: number, hold = 2500): Caption | null {
	const i = lastAtOrBefore(
		list.map((c) => c.t),
		t,
	);
	const c = list[i];
	return c && t - c.t <= hold ? c : null;
}

/** Fps over time: tt-ext-1 View records (one a second) when present, else the client `tech` rows. */
export function fpsSeries(replay: RecordingReplayResult): [number, number][] {
	const views = (replay.extended?.view ?? []).filter((v) => v[5] > 0).map((v): [number, number] => [v[0], v[5]]);
	return views.length >= 2 ? views : (replay.fps ?? []);
}

export interface Ring {
	t: number;
	type: "click" | "tap";
	x: number;
	y: number;
	/** 0 just now .. 1 about to fade out. */
	age: number;
}

/** Clicks and taps with a position in the last `window` ms before `t`. */
export function ringsAt(replay: RecordingReplayResult, t: number, window = 700): Ring[] {
	const out: Ring[] = [];
	for (const i of replay.inputs ?? []) {
		if ((i.type !== "click" && i.type !== "tap") || i.x === undefined || i.y === undefined) continue;
		if (i.t > t) break;
		if (t - i.t <= window) out.push({ t: i.t, type: i.type, x: i.x, y: i.y, age: (t - i.t) / window });
	}
	return out;
}
