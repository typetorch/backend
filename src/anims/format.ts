/**
 * The animation export's binary output (`TTAN`, what the Luau script in script.ts returns as its BinaryOutput; plans/36
 * "The clips"). Little-endian throughout.
 *
 *   magic "TTAN" (4) | version u16 (1) | clips u16
 *   per clip:
 *     id: len u8 + ASCII digits
 *     status u8: 0 loaded, 1 failed (the pcall's error follows), 2 skipped (the task's deadline came first)
 *     status 1: message len u16 + UTF-8
 *     status 0:
 *       flags u8 (bit 0 Loop) | priority u16 (Enum.AnimationPriority value)
 *       names u16, each len u8 + UTF-8 (the Poses' names: the Motor6D Part1 names, "Torso", "Left Arm", "LeftUpperArm"...)
 *       keyframes u16, each: time f32 (s) | poses u16, each POSE_BYTES:
 *         name u16 (index into names) | rotation qx, qy, qz, qw f32 x4 (the Pose CFrame's, three.js order)
 *         | position x, y, z f32 x3 | easing style u8 (Enum.PoseEasingStyle) | easing direction u8 (Enum.PoseEasingDirection)
 *         | weight f32
 *
 * Stored per animation id as JSON (`Clip`), which GET /v1/anims/<id> serves.
 */

export const ANIM_MAGIC = "TTAN";
export const ANIM_FORMAT_VERSION = 1;
export const POSE_BYTES = 2 + 16 + 12 + 1 + 1 + 4;
/** Caps a clip must stay under (a KeyframeSequence far bigger is not a character animation). */
export const KEYFRAMES_MAX = 5000;
export const POSES_MAX = 128;

export class AnimFormatError extends Error {
	override name = "AnimFormatError";
}

export const PRIORITIES: Record<number, string> = { 0: "Idle", 1: "Movement", 2: "Action", 3: "Action2", 4: "Action3", 5: "Action4", 1000: "Core" };
export const EASING_STYLES = ["Linear", "Constant", "Elastic", "Cubic", "Bounce", "CubicV2"] as const;
export const EASING_DIRECTIONS = ["In", "Out", "InOut"] as const;

/** R6: the Pose name (the Motor6D's Part1) -> the Motor6D's name. */
export const R6_JOINTS: Record<string, string> = {
	Torso: "RootJoint",
	Head: "Neck",
	"Left Arm": "Left Shoulder",
	"Right Arm": "Right Shoulder",
	"Left Leg": "Left Hip",
	"Right Leg": "Right Hip",
};
/** R15: the Pose name (the Motor6D's Part1) -> the Motor6D's name (Roblox's standard R15 rig). */
export const R15_JOINTS: Record<string, string> = {
	LowerTorso: "Root",
	UpperTorso: "Waist",
	Head: "Neck",
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

export type Quat = [number, number, number, number];

/** One clip as served: what a replay needs to play it on a rig by joint name. */
export interface Clip {
	id: string;
	/** Seconds (the last keyframe's time). */
	length: number;
	looped: boolean;
	/** Enum.AnimationPriority's name ("Core", "Idle", "Movement", "Action"...). */
	priority: string;
	/** "R6" / "R15" when every joint is that rig's, else "other". */
	rig: "R6" | "R15" | "other";
	/** Keyframes by time; each Pose's rotation by its name (its weight-0 poses left out). */
	keyframes: ClipKeyframe[];
	/** Pose name -> Motor6D name, for the poses this clip moves that a standard R6 / R15 rig has. */
	joints: Record<string, string>;
	exportedAt: number;
}

export interface ClipKeyframe {
	t: number;
	poses: Record<string, Quat>;
	/** Pose positions that aren't zero (rare in character animations; the root's bob). */
	positions?: Record<string, [number, number, number]>;
	/** Easing to the next keyframe when it isn't Linear: [style, direction] names. */
	easing?: Record<string, [string, string]>;
}

export type ExportedClip = { id: string; status: "ok"; clip: Omit<Clip, "exportedAt"> } | { id: string; status: "failed"; error: string } | { id: string; status: "skipped" };

const r5 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : 0);

/** Reads the animation export's output. Throws AnimFormatError on anything malformed (never reads past the end). */
export function parseAnimExport(bytes: Uint8Array): ExportedClip[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let at = 0;
	const need = (n: number) => {
		if (at + n > bytes.byteLength) throw new AnimFormatError(`animation export cut short at byte ${at} (needs ${n} more of ${bytes.byteLength})`);
	};
	const u8 = () => {
		need(1);
		return view.getUint8(at++);
	};
	const u16 = () => {
		need(2);
		const v = view.getUint16(at, true);
		at += 2;
		return v;
	};
	const f32 = () => {
		need(4);
		const v = view.getFloat32(at, true);
		at += 4;
		return v;
	};
	const text = (len: number) => {
		need(len);
		const s = decoder.decode(bytes.subarray(at, at + len));
		at += len;
		return s;
	};
	need(8);
	if (text(4) !== ANIM_MAGIC) throw new AnimFormatError("not an animation export (no TTAN magic)");
	const version = u16();
	if (version !== ANIM_FORMAT_VERSION) throw new AnimFormatError(`animation export version ${version} (this backend reads ${ANIM_FORMAT_VERSION})`);
	const count = u16();
	const out: ExportedClip[] = [];
	for (let i = 0; i < count; i++) {
		const id = text(u8());
		if (!/^[1-9][0-9]{0,19}$/.test(id)) throw new AnimFormatError(`clip ${i}: bad id`);
		const status = u8();
		if (status === 1) {
			out.push({ id, status: "failed", error: text(u16()).slice(0, 300) });
			continue;
		}
		if (status === 2) {
			out.push({ id, status: "skipped" });
			continue;
		}
		if (status !== 0) throw new AnimFormatError(`clip ${id}: unknown status ${status}`);
		const flags = u8();
		const priority = u16();
		const nameCount = u16();
		const names: string[] = [];
		for (let n = 0; n < nameCount; n++) names.push(text(u8()));
		const frames = u16();
		if (frames > KEYFRAMES_MAX) throw new AnimFormatError(`clip ${id}: ${frames} keyframes (at most ${KEYFRAMES_MAX})`);
		const keyframes: ClipKeyframe[] = [];
		const moved = new Set<string>();
		for (let k = 0; k < frames; k++) {
			const t = f32();
			const poses = u16();
			if (poses > POSES_MAX) throw new AnimFormatError(`clip ${id}: ${poses} poses in a keyframe (at most ${POSES_MAX})`);
			need(poses * POSE_BYTES);
			const frame: ClipKeyframe = { t: r5(t), poses: {} };
			for (let p = 0; p < poses; p++) {
				const nameAt = u16();
				const name = names[nameAt];
				if (name === undefined) throw new AnimFormatError(`clip ${id}: pose name ${nameAt} out of range`);
				const q: Quat = [r5(f32()), r5(f32()), r5(f32()), r5(f32())];
				const pos: [number, number, number] = [r5(f32()), r5(f32()), r5(f32())];
				const style = u8();
				const direction = u8();
				const weight = f32();
				if (!(weight > 0)) continue;
				frame.poses[name] = q;
				moved.add(name);
				if (pos.some((v) => Math.abs(v) > 1e-4)) (frame.positions ??= {})[name] = pos;
				if (style !== 0) (frame.easing ??= {})[name] = [EASING_STYLES[style] ?? String(style), EASING_DIRECTIONS[direction] ?? String(direction)];
			}
			keyframes.push(frame);
		}
		keyframes.sort((a, b) => a.t - b.t);
		const length = keyframes.length ? Math.max(0, keyframes[keyframes.length - 1]?.t ?? 0) : 0;
		out.push({ id, status: "ok", clip: { id, length, looped: (flags & 1) !== 0, priority: PRIORITIES[priority] ?? String(priority), rig: rigOf(moved), keyframes, joints: jointsOf(moved) } });
	}
	if (at !== bytes.byteLength) throw new AnimFormatError(`${bytes.byteLength - at} bytes after the last clip`);
	return out;
}

/** Which standard rig a set of pose names belongs to (the root part's own pose aside). */
export function rigOf(names: Iterable<string>): Clip["rig"] {
	const list = [...names].filter((n) => n !== "HumanoidRootPart");
	if (!list.length) return "other";
	if (list.every((n) => n in R6_JOINTS)) return list.some((n) => n === "Torso" || n.includes(" ")) ? "R6" : list.every((n) => n in R15_JOINTS) ? "R15" : "R6";
	if (list.every((n) => n in R15_JOINTS)) return "R15";
	return "other";
}

/** The Motor6D names of the poses a standard R6 or R15 rig has ("Head" is "Neck" on both). */
export function jointsOf(names: Iterable<string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const n of names) {
		const joint = R6_JOINTS[n] ?? R15_JOINTS[n];
		if (joint) out[n] = joint;
	}
	return out;
}
