/**
 * The extended replay at a moment (plans/36): the recorded camera and viewport, the player's root, entities between
 * moves, recorded joints slerped, animation tracks' clip time and weight, clips sampled by joint or part name, the
 * clip / recorded-pose blend, captions, tap rings and the fps series.
 */
import { describe, expect, it } from "vitest";
import type { ExtendedReplay, RecordingReplayResult } from "@/lib/types";
import { afkAt, animIdOf, blendPose, cameraAt, captionAt, captions, entityAt, entityNames, fpsSeries, kindColor, poseTracks, POSE_FADE_MS, recordedPose, ringsAt, rigAt, sampleClip, selfAt, slerp, tracksAt, viewAt, type AnimClip, type Quat } from "./ext-replay";

const deg = (axis: [number, number, number], d: number): Quat => {
	const h = (d * Math.PI) / 360;
	return [axis[0] * Math.sin(h), axis[1] * Math.sin(h), axis[2] * Math.sin(h), Math.cos(h)];
};
const angle = (q: Quat) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;

const ext = (over: Partial<ExtendedReplay> = {}): ExtendedReplay => ({ chunks: 1, gaps: 0, skipped: 0, view: [], afk: [], rigs: [], poses: [], entities: [], anims: [], ui: [], ...over });

const replay = (over: Partial<RecordingReplayResult> = {}): RecordingReplayResult => ({
	found: true,
	sid: "s",
	duration: 10_000,
	samples: [
		[0, 0, 3, 0, 0, 0, 0, 0, 5, 10],
		[1_000, 10, 3, 0, Math.PI / 2, 0.5, Math.PI / 2, 10, 5, 10],
		[2_000, null, null, null, Math.PI / 2, 0.5, null, 10, 5, 10],
	],
	...over,
});

describe("view and camera", () => {
	it("the viewport from View records, else the device event, FOV 70", () => {
		const r = replay({ extended: ext({ view: [[0, 1920, 1080, 58, 70, 60], [5_000, 1280, 720, 36, 90, 30]] }) });
		expect(viewAt(r, 100)).toEqual({ w: 1920, h: 1080, inset: 58, fov: 70, fps: 60 });
		expect(viewAt(r, 6_000)).toMatchObject({ w: 1280, fov: 90 });
		expect(viewAt(replay({ events: [{ t: 0, kind: "session", name: "device", props: { w: 800, h: 400 } }] }), 0)).toEqual({ w: 800, h: 400, inset: 0, fov: 70, fps: null });
		expect(viewAt(replay(), 0)).toMatchObject({ w: 1280, h: 720, fov: 70 });
	});
	it("the camera between samples: position, yaw, pitch from lookY", () => {
		const c = cameraAt(replay(), 500);
		expect(c?.position).toEqual([5, 5, 10]);
		expect(c?.yaw).toBeCloseTo(Math.PI / 4, 5);
		expect(c?.look[1]).toBeCloseTo(0.25, 5);
		// yaw 0 looks along -Z
		const c0 = cameraAt(replay(), 0);
		expect(c0?.look[2]).toBeCloseTo(-1, 5);
		expect(cameraAt(replay({ samples: [[0, 1, 2, 3, 0, 0]] }), 0)).toBeNull();
	});
	it("the player's root faces the character yaw; no root while there is no character", () => {
		expect(selfAt(replay(), 500)).toEqual({ position: [5, 3, 0], yaw: Math.PI / 4 });
		expect(selfAt(replay(), 2_500)).toBeNull();
	});
});

describe("entities, AFK, names", () => {
	const zombie = { e: 1, kind: "zombie", humanoid: true, player: false, size: [4, 5, 1] as [number, number, number], from: 1_000, to: 5_000, moves: [[1_000, 0, 0, 0, 0], [2_000, 10, 0, 0, Math.PI], [3_000, 100, 0, 0, Math.PI]] as [number, number, number, number, number][] };
	it("between moves, alive from spawn to gone, no blend across a jump", () => {
		expect(entityAt(zombie, 500)).toBeNull();
		expect(entityAt(zombie, 1_500)?.position).toEqual([5, 0, 0]);
		expect(entityAt(zombie, 2_500)?.position).toEqual([10, 0, 0]);
		expect(entityAt(zombie, 5_000)).toBeNull();
	});
	it("AFK spans, names and kind colours", () => {
		const x = ext({ afk: [[1_000, 2_000], [5_000, null]], entities: [{ ...zombie, e: 0, kind: "self" }, zombie, { ...zombie, e: 2, player: true, kind: "player" }] });
		expect([afkAt(x, 1_500), afkAt(x, 2_000), afkAt(x, 9_000)]).toEqual([true, false, true]);
		expect([...entityNames(x).values()]).toEqual(["recorded player", "zombie #1", "player 1"]);
		expect(kindColor("zombie")).toBe(kindColor("zombie"));
		expect(kindColor("player")).toBe("#3b82f6");
	});
});

describe("poses and animations", () => {
	const R6 = ["RootJoint", "Neck", "Left Shoulder", "Right Shoulder", "Left Hip", "Right Hip"];
	const x = ext({
		rigs: [{ t: 0, e: 0, rig: "R6", joints: R6 }],
		poses: [
			[0, 0, 3, 0, 0, 0, 1],
			[1_000, 0, 3, ...deg([0, 0, 1], 90)],
			[0, 0, 1, 0, 0, 0, 1],
		],
		anims: [{ e: 0, track: 1, id: "rbxassetid://123", from: 1_000, to: 9_000, looped: true, time: 0.5, adjust: [[1_000, 1, 1], [3_000, 2, 0.5]] }],
	});
	it("slerp takes the short way", () => {
		expect(angle(slerp([0, 0, 0, 1], deg([0, 1, 0], 90), 0.5))).toBeCloseTo(45, 3);
		const negated = deg([0, 1, 0], 90).map((v) => -v) as Quat;
		expect(angle(slerp([0, 0, 0, 1], negated, 0.5))).toBeCloseTo(45, 3);
	});
	it("recorded joints by name, slerped between their samples, held after the last", () => {
		const tracks = poseTracks(x);
		const half = recordedPose(tracks, 0, 500);
		expect(angle(half.pose["Right Shoulder"] as Quat)).toBeCloseTo(45, 3);
		expect(half.near["Right Shoulder"]).toBe(500);
		expect(recordedPose(tracks, 0, 4_000).pose.Neck).toEqual([0, 0, 0, 1]);
		expect(rigAt(x, 0, 10)?.rig).toBe("R6");
		expect(rigAt(x, 7, 10)).toBeNull();
	});
	it("a track's clip time integrates its speed; weight from the latest adjust", () => {
		expect(tracksAt(x, 0, 500)).toEqual([]);
		const [a] = tracksAt(x, 0, 4_000);
		// 0.5 s start + 2 s at speed 1 + 1 s at speed 2
		expect(a?.time).toBeCloseTo(4.5, 6);
		expect(a?.weight).toBe(0.5);
		expect(animIdOf("rbxassetid://123")).toBe("123");
		expect(animIdOf("http://www.roblox.com/asset/?id=77")).toBe("77");
		expect(animIdOf("nothing")).toBeNull();
	});
	it("clips: slerp between keyframes, loop or hold, part names mapped to their Motor6D", () => {
		const clip: AnimClip = { id: "1", length: 2, looped: true, keyframes: [{ t: 0, poses: { "Right Arm": [0, 0, 0, 1], Neck: [0, 0, 0, 1] } }, { t: 2, poses: { "Right Arm": deg([1, 0, 0], 90), Neck: [0, 0, 0, 1] } }] };
		expect(angle(sampleClip(clip, 1)["Right Shoulder"] as Quat)).toBeCloseTo(45, 3);
		expect(angle(sampleClip(clip, 3)["Right Shoulder"] as Quat)).toBeCloseTo(45, 3);
		expect(angle(sampleClip(clip, 3, false)["Right Shoulder"] as Quat)).toBeCloseTo(90, 3);
		expect(sampleClip({ ...clip, keyframes: [] }, 1)).toEqual({});
	});
	it("blend: the clip, recorded joints alone where no clip has them, fading in near their samples", () => {
		const clip = { pose: { Neck: deg([0, 1, 0], 90) }, weight: 1, priority: 0, from: 0 };
		const recorded = { pose: { Neck: [0, 0, 0, 1] as Quat, "Left Hip": deg([1, 0, 0], 30) }, near: { Neck: 0, "Left Hip": 999 } };
		const on = blendPose([clip], recorded);
		expect(angle(on.Neck as Quat)).toBeCloseTo(0, 3); // at a sample: the recorded joint
		expect(angle(on["Left Hip"] as Quat)).toBeCloseTo(30, 3); // no clip has it
		const away = blendPose([clip], { ...recorded, near: { Neck: POSE_FADE_MS * 2, "Left Hip": 0 } });
		expect(angle(away.Neck as Quat)).toBeCloseTo(90, 3); // far from a sample: the clip
		const half = blendPose([{ ...clip, weight: 0.5 }], { pose: {}, near: {} });
		expect(angle(half.Neck as Quat)).toBeCloseTo(45, 3);
	});
});

describe("strips", () => {
	const r = replay({
		inputs: [
			{ t: 100, type: "click", x: 0.5, y: 0.25 },
			{ t: 200, type: "button", target: "HUD/Play" },
			{ t: 300, type: "tap", x: 0.1, y: 0.9 },
			{ t: 400, type: "key", code: 1 },
			{ t: 5_000, type: "screen_open", target: "Shop" },
		],
		fps: [
			[0, 60],
			[60_000, 30],
		],
	});
	it("captions: buttons, screens, prompts; the latest within its hold", () => {
		const list = captions(r);
		expect(list.map((c) => c.label)).toEqual(["Button: HUD/Play", "Opened: Shop"]);
		expect(captionAt(list, 1_000)?.label).toBe("Button: HUD/Play");
		expect(captionAt(list, 4_000)).toBeNull();
	});
	it("rings: clicks and taps with a position, fading over the window", () => {
		expect(ringsAt(r, 350).map((x) => [x.type, x.x, x.y])).toEqual([
			["click", 0.5, 0.25],
			["tap", 0.1, 0.9],
		]);
		expect(ringsAt(r, 900).map((x) => x.type)).toEqual(["tap"]);
	});
	it("fps: View records when there are some, else the tech rows", () => {
		expect(fpsSeries(r)).toEqual([
			[0, 60],
			[60_000, 30],
		]);
		expect(fpsSeries({ ...r, extended: ext({ view: [[0, 1, 1, 0, 70, 59], [1_000, 1, 1, 0, 70, 58]] }) })).toEqual([
			[0, 59],
			[1_000, 58],
		]);
	});
});
