/**
 * plans/36 tt-ext-1: the decoder against the reference encoder (test/fixtures/ext-encoder.ts, written from the same
 * contract). Every record type round-trips; smallest-three quaternions; anchors; the string table and UI tree across
 * keyframes (what continues, what ends); a lost chunk (decoding resumes at the next keyframe chunk); a malformed chunk;
 * unknown tags and longer payloads skipped by length; the caps.
 */
import { describe, expect, test } from "bun:test";
import { animationIdsOf, decodeTtExt1, EXT_LIMITS, parseTtExt1Chunk, unpackQuat } from "../src/recording-ext.ts";
import { ExtChunkWriter, packQuat, type Quat } from "./fixtures/ext-encoder.ts";
import { frameworkOf } from "../src/queries/recordings.ts";

const T0 = 1_700_000_000_000;

function closeQuat(a: readonly number[], b: readonly number[], eps = 0.004) {
	// q and -q are the same rotation
	const sign = a.reduce((s, v, i) => s + v * (b[i] as number), 0) < 0 ? -1 : 1;
	for (let i = 0; i < 4; i++) expect(Math.abs((a[i] as number) - sign * (b[i] as number))).toBeLessThan(eps);
}

function axisAngle(axis: [number, number, number], deg: number): Quat {
	const h = (deg * Math.PI) / 360;
	const n = Math.hypot(...axis);
	return [(axis[0] / n) * Math.sin(h), (axis[1] / n) * Math.sin(h), (axis[2] / n) * Math.sin(h), Math.cos(h)];
}

const R6 = ["RootJoint", "Neck", "Left Shoulder", "Right Shoulder", "Left Hip", "Right Hip"];

describe("smallest-three quaternions", () => {
	test("round trip within the 10-bit precision, any dropped component and sign", () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
		const cases: Quat[] = [[0, 0, 0, 1], [1, 0, 0, 0], [0, -1, 0, 0], [0, 0, 0.7071, -0.7071], axisAngle([0, 0, 1], 90), axisAngle([1, 2, 3], -170)];
		for (let i = 0; i < 200; i++) cases.push([rand(), rand(), rand(), rand()]);
		for (const q of cases) {
			const n = Math.hypot(...q);
			closeQuat(unpackQuat(packQuat(q)), q.map((c) => c / n));
		}
	});
	test("the dropped index is the largest component", () => {
		expect(packQuat([0.1, 0.9, 0.1, 0.4]) & 3).toBe(1);
		expect(packQuat([0, 0, 0, 1]) & 3).toBe(3);
	});
});

/** A session in three chunks: a keyframe chunk, a diff chunk, a second keyframe chunk (60 s later). */
function session() {
	const c0 = new ExtChunkWriter({ keyframe: true })
		.keyframe()
		.string(0, "zombie")
		.string(1, "rbxassetid://180426354")
		.string(2, "Coins: 10")
		.string(3, "rbxasset://fonts/families/GothamSSm.json")
		.string(4, "rbxassetid://555")
		.string(5, "rbxassetid://111")
		.string(6, "rbxassetid://222");
	R6.forEach((name, i) => c0.string(10 + i, name));
	c0.view(1920, 1080, 58, 70, 60)
		.anchor([100, 0, -50])
		.rig(0, 1, [10, 11, 12, 13, 14, 15])
		.rig(1, 1, [10, 11, 12, 13, 14, 15]) // before its Spawn: waits for it
		.pose(0, R6.map(() => [0, 0, 0, 1] as Quat))
		.spawn(1, 0, 1, [110, 3, -40], 0, [4, 5, 1])
		.look(1, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [1, 2, 3], [4, 5, 6], [7, 8, 9]], [[1, 5], [2, 6]])
		.animPlay(1, 3, 1, 1.5, 1, true, 0.25)
		.animPlay(0, 1, 1, 1, 0.5, false, 0)
		.uiNode(0, 65535, 0, { order: 5, rect: [0, 0, 1920, 1022] })
		.uiNode(1, 0, 1, { rect: [10, 20, 300, 100], rotation: 12.5, order: 1, background: [10, 20, 30, 0.5], stroke: [1, 2, 3, 0, 2.5], corner: 8, clip: true, gradient: { keys: [[0, 255, 0, 0], [1, 0, 0, 255]], rotation: 90 } })
		.uiNode(2, 1, 2, { rect: [20, 30, 200, 40], order: 2, text: 2, textStyle: { rgb: [255, 255, 255], transparency: 0, size: 24, family: 3, weight: 700, xAlign: 1, yAlign: 1, flags: 5, strokeTransparency: 0.5, strokeRgb: [0, 0, 0] } })
		.uiNode(3, 1, 5, { rect: [5, 5, 64, 64], order: 3, image: 4, imageStyle: { rgb: [255, 128, 0], transparency: 0.25, scaleType: 1 }, imageRect: [1, 2, 3, 4, 10, 10, 20, 20] })
		.uiNode(4, 0, 1, { rect: [0, 0, 10, 10], order: 4 });
	const c1 = new ExtChunkWriter()
		.move([[1, 12.5, 3, 10, Math.PI / 2]], 300) // 110+... anchor is 100,0,-50
		.pose(0, [undefined, undefined, undefined, axisAngle([0, 0, 1], 90)], 0)
		.uiProps(2, { text: 2, rect: [21, 30, 200, 40] }, 0)
		.animAdjust(1, 3, 0.5, 0.75, 100)
		.afk(true, 100)
		.record(99, 0, [1, 2, 3]) // unknown tag: skipped by its length
		.record(4, 0, [0, 9, 9, 9]) // Afk back, with trailing bytes a newer encoder might add
		.uiProps(1, { parent: 0, background: [1, 1, 1, 0] }, 100)
		.animStop(0, 1, 100)
		.uiGone(4, 100)
		.gone(1, 100); // ends entity 1 and its tracks
	const c2 = new ExtChunkWriter({ keyframe: true, last: true })
		.keyframe(60_000 - 900)
		.string(7, "zombie") // a new table: different ids for the same strings
		.string(8, "Coins: 11");
	R6.forEach((name, i) => c2.string(20 + i, name));
	c2.rig(0, 1, [20, 21, 22, 23, 24, 25]) // same rig: not repeated
		.spawn(2, 7, 0, [50, 1, 50], -Math.PI / 2, [2, 2, 2])
		.uiNode(9, 65535, 0, { order: 5, rect: [0, 0, 1920, 1022] }) // ScreenGui under a new wire id: a new node
		.uiNode(0, 65535, 0, { order: 5, rect: [0, 0, 1920, 1022] }) // same id, class and parent: continues
		.uiNode(1, 0, 1, { rect: [10, 20, 300, 100], rotation: 12.5, order: 1, background: [1, 1, 1, 0], stroke: [1, 2, 3, 0, 2.5], corner: 8, clip: true, gradient: { keys: [[0, 255, 0, 0], [1, 0, 0, 255]], rotation: 90 } })
		.uiNode(2, 1, 2, { rect: [21, 30, 200, 40], order: 2, text: 8 }) // continues, its text changed
		// node 3 (the image) is not re-sent: it ends at the keyframe
		.move([[2, 1, 0, 0, 0]], 300);
	return [c0.row(0, T0), c1.row(1, T0 + 10_000), c2.row(2, T0 + 20_000)];
}

describe("tt-ext-1 decoding", () => {
	test("the chunk header and raw records", () => {
		const bytes = Buffer.from(session()[0]!.data, "base64");
		const chunk = parseTtExt1Chunk(bytes);
		expect(chunk).toMatchObject({ version: 1, keyframe: true, last: false, skipped: 0 });
		expect(chunk.records[0]).toEqual({ tag: 2, at: 0 });
		const last = parseTtExt1Chunk(Buffer.from(session()[2]!.data, "base64"));
		expect(last.last).toBe(true);
	});

	test("every record type round-trips into the timeline", () => {
		const x = decodeTtExt1(session(), T0);
		expect(x).toMatchObject({ chunks: 3, gaps: 0, skipped: 1 });
		expect(x.failed).toBeUndefined();
		expect(x.view).toEqual([[0, 1920, 1080, 58, 70, 60]]);
		expect(x.afk).toEqual([[10_500, 10_500]]);
		// rigs: entity 0 and the zombie (entity 1), each once (the keyframe's same rig isn't repeated)
		expect(x.rigs).toEqual([
			{ t: 0, e: 0, rig: "R6", joints: R6 },
			{ t: 0, e: 1, rig: "R6", joints: R6 },
		]);
		// poses: six joints at the keyframe, then the right shoulder alone
		expect(x.poses.filter((p) => p[0] === 0)).toHaveLength(6);
		const shoulder = x.poses.find((p) => p[0] === 10_300);
		expect(shoulder?.slice(0, 3)).toEqual([10_300, 0, 3]);
		closeQuat(shoulder!.slice(3), axisAngle([0, 0, 1], 90));
		// entities
		const [self, zombie, second] = x.entities;
		expect(self).toMatchObject({ e: 0, kind: "self", to: null, moves: [] });
		expect(zombie).toMatchObject({ e: 1, kind: "zombie", humanoid: true, player: false, size: [4, 5, 1], from: 0, to: 10_900 });
		expect(zombie!.look).toEqual({ colors: ["#ff0000", "#00ff00", "#0000ff", "#010203", "#040506", "#070809"], shirt: "rbxassetid://111", pants: "rbxassetid://222" });
		expect(zombie!.moves[0]).toEqual([0, 110, 3, -40, 0]);
		// a Move is 1/8 stud from the Anchor
		expect(zombie!.moves[1]!.slice(0, 4)).toEqual([10_300, 112.5, 3, -40]);
		expect(zombie!.moves[1]![4]).toBeCloseTo(Math.PI / 2, 1);
		expect(second).toMatchObject({ e: 2, kind: "zombie", humanoid: false, from: 80_000 - 900, to: null, size: [2, 2, 2] });
		// a Move after the second keyframe: relative to that segment's anchor (reset to 0 at a keyframe)
		expect(second!.moves[1]!.slice(1, 4)).toEqual([1, 0, 0]);
		// animations: speed / weight / looped / time position; adjust; stop; ended with its entity
		expect(x.anims).toEqual([
			{ e: 1, track: 3, id: "rbxassetid://180426354", from: 0, to: 10_900, looped: true, time: 0.25, adjust: [[0, 1.5, 1], [10_400, 0.5, 0.749]] },
			{ e: 0, track: 1, id: "rbxassetid://180426354", from: 0, to: 10_700, looped: false, time: 0, adjust: [[0, 1, 0.502]] },
		]);
		expect(animationIdsOf(x)).toEqual(["180426354"]);
	});

	test("the UI tree: every field, changes, reparenting, gone, and keyframes", () => {
		const x = decodeTtExt1(session(), T0);
		const k2 = 80_000 - 900;
		const [screen, frame, label, image, small, screen2] = x.ui;
		expect(screen).toMatchObject({ i: 0, cls: 0, from: 0, to: null, parent: null, f: { order: 5, rect: [0, 0, 1920, 1022] } });
		expect(frame!.f).toEqual({
			rect: [10, 20, 300, 100],
			rotation: 12.5,
			order: 1,
			background: { color: "#0a141e", transparency: 0.502 },
			stroke: { color: "#010203", transparency: 0, thickness: 2.5 },
			corner: 8,
			clip: true,
			gradient: { keys: [[0, "#ff0000"], [1, "#0000ff"]], rotation: 90 },
		});
		expect(frame!.ch).toEqual([[10_600, { parent: 0, background: { color: "#010101", transparency: 0 } }]]);
		expect(label!.f).toEqual({
			rect: [20, 30, 200, 40],
			order: 2,
			text: "Coins: 10",
			textStyle: { color: "#ffffff", transparency: 0, size: 24, family: "rbxasset://fonts/families/GothamSSm.json", weight: 700, xAlign: 1, yAlign: 1, scaled: true, wrapped: false, rich: true, strokeTransparency: 0.502, strokeColor: "#000000" },
		});
		// a change at 10.3 s, then at the keyframe only what differs (the text, from the new string table)
		expect(label!.ch).toEqual([
			[10_300, { text: "Coins: 10", rect: [21, 30, 200, 40] }],
			[k2, { text: "Coins: 11" }],
		]);
		expect(label!.to).toBeNull();
		expect(image).toMatchObject({ cls: 5, parent: 1, to: k2, f: { image: "rbxassetid://555", imageStyle: { color: "#ff8000", transparency: 0.251, scaleType: 1 }, imageRect: { offset: [1, 2], size: [3, 4], slice: [10, 10, 20, 20] } } });
		expect(small).toMatchObject({ cls: 1, parent: 0, from: 0, to: 10_800 });
		expect(screen2).toMatchObject({ i: 5, cls: 0, parent: null, from: k2, to: null });
		expect(x.ui).toHaveLength(6);
	});

	test("UiGone ends the node's visible descendants too", () => {
		const c = new ExtChunkWriter({ keyframe: true })
			.keyframe()
			.uiNode(0, 65535, 0, {})
			.uiNode(1, 0, 1, {})
			.uiNode(2, 1, 2, {})
			.uiNode(3, 0, 1, {})
			.uiGone(1, 500);
		const x = decodeTtExt1([c.row(0, T0)], T0);
		expect(x.ui.map((n) => n.to)).toEqual([null, 500, 500, null]);
	});

	test("framework 0.7.3 UI fields: gradient transparency + offset (bit 14), CanvasGroup group and text UIScale (bit 15)", () => {
		// gnome's modal "Highlight": white, transparency 0.9 -> 1 (0.7) -> 1, rotation 90; a CanvasGroup; 2x-scaled text
		const c = new ExtChunkWriter({ keyframe: true })
			.keyframe()
			.string(0, "$")
			.uiNode(0, 65535, 0, { order: 1, rect: [0, 0, 1920, 1080] })
			.uiNode(1, 0, 1, { rect: [0, 0, 400, 300], order: 1, background: [255, 255, 255, 0], gradient: { keys: [[0, 255, 255, 255], [1, 255, 255, 255]], rotation: 90 }, gradientAlpha: { keys: [[0, 0.9], [0.7, 1], [1, 1]], offset: [0, -0.25] } })
			.uiNode(2, 0, 9, { rect: [0, 0, 100, 100], order: 2, background: [0, 0, 0, 1], group: [0.5, 255, 0, 0] })
			.uiNode(3, 2, 2, { rect: [0, 0, 32, 32], order: 3, text: 0, textStyle: { rgb: [255, 255, 255], transparency: 0, size: 32, family: 0, weight: 400, xAlign: 1, yAlign: 1, flags: 4, strokeTransparency: 1, strokeRgb: [0, 0, 0] }, textScale: 2 })
			.uiProps(2, { group: [0.25, 255, 255, 255] }, 100) // a second-mask field alone
			.uiProps(1, { gradientAlpha: { keys: [], offset: [0, 0] } }, 100); // back to opaque
		const x = decodeTtExt1([c.row(0, T0)], T0);
		const [, sheen, group, dollar] = x.ui;
		expect(sheen!.f.gradientAlpha).toEqual({ keys: [[0, 0.902], [0.702, 1], [1, 1]], offset: [0, -0.25] });
		expect(sheen!.f.gradient).toEqual({ keys: [[0, "#ffffff"], [1, "#ffffff"]], rotation: 90 });
		expect(sheen!.ch).toEqual([[200, { gradientAlpha: { keys: [], offset: [0, 0] } }]]);
		expect(group!.f.group).toEqual({ transparency: 0.502, color: "#ff0000" });
		expect(group!.ch).toEqual([[100, { group: { transparency: 0.251, color: "#ffffff" } }]]);
		expect(dollar!.f.textScale).toBe(2);
		expect(dollar!.f.textStyle?.size).toBe(32);
		expect(dollar!.f.group).toBeUndefined();
	});

	test("compatibility: a 0.7.2 chunk decodes without the new fields; unknown second-mask bits are skipped by length", () => {
		const old = new ExtChunkWriter({ keyframe: true }).keyframe().uiNode(0, 65535, 0, { order: 1, rect: [0, 0, 800, 600] }).uiNode(1, 0, 1, { rect: [1, 2, 3, 4], order: 1, background: [1, 2, 3, 0], gradient: { keys: [[0, 0, 0, 0]], rotation: 0 } });
		const oldChunk = parseTtExt1Chunk(old.finish());
		const node = oldChunk.records.find((r) => r.tag === 20 && r.id === 1) as Extract<(typeof oldChunk.records)[number], { tag: 20 }>;
		expect(node.fields).toEqual({ rect: [1, 2, 3, 4], order: 1, background: { color: "#010203", transparency: 0 }, gradient: { keys: [[0, "#000000"]], rotation: 0 } });
		// a newer recorder: second-mask bit 2 (two bytes this decoder can't read) after a known group; the next record decodes
		const newer = new ExtChunkWriter({ keyframe: true })
			.keyframe()
			.uiNode(0, 65535, 9, { order: 1, rect: [0, 0, 10, 10], group: [0.2, 1, 2, 3], moreUnknown: { bits: 4, bytes: [7, 7] } })
			.uiGone(0, 50);
		const chunk = parseTtExt1Chunk(newer.finish());
		expect(chunk.records.map((r) => r.tag)).toEqual([2, 20, 22]);
		const first = chunk.records[1] as Extract<(typeof chunk.records)[number], { tag: 20 }>;
		expect(first.fields).toEqual({ order: 1, rect: [0, 0, 10, 10], group: { transparency: 0.2, color: "#010203" } });
		expect(chunk.skipped).toBe(0);
	});

	test("a lost chunk: everything alive ends at the last decoded moment; decoding resumes at the next keyframe chunk", () => {
		const c0 = new ExtChunkWriter({ keyframe: true }).keyframe().string(0, "mob").spawn(1, 0, 0, [0, 0, 0], 0, [1, 1, 1]).uiNode(0, 65535, 0, {}).view(800, 600, 0, 70, 30, 2000);
		// chunk 1 lost; chunk 2 has no keyframe (skipped: its string ids mean nothing without the table); chunk 3 resumes
		const c2 = new ExtChunkWriter().string(0, "lost").spawn(5, 0, 0, [9, 9, 9], 0, [1, 1, 1]);
		const c3 = new ExtChunkWriter({ keyframe: true }).keyframe().string(3, "boss").spawn(1, 3, 0, [1, 2, 3], 0, [8, 8, 8]).uiNode(0, 65535, 0, {});
		const x = decodeTtExt1([c3.row(3, T0 + 30_000), c0.row(0, T0), c2.row(2, T0 + 20_000)], T0);
		expect(x.gaps).toBe(1);
		expect(x.entities.map((e) => [e.e, e.kind, e.from, e.to])).toEqual([
			[1, "mob", 0, 2000],
			[2, "boss", 30_000, null],
		]);
		expect(x.ui.map((n) => [n.from, n.to])).toEqual([
			[0, 2000],
			[30_000, null],
		]);
	});

	test("a first chunk without a keyframe is skipped until one comes", () => {
		const c0 = new ExtChunkWriter().string(0, "x").spawn(1, 0, 0, [0, 0, 0], 0, [1, 1, 1]);
		const c1 = new ExtChunkWriter({ keyframe: true }).keyframe().view(100, 100, 0, 70, 60);
		const x = decodeTtExt1([c0.row(0, T0), c1.row(1, T0 + 10_000)], T0);
		expect(x.entities).toEqual([]);
		expect(x.view).toEqual([[10_000, 100, 100, 0, 70, 60]]);
	});

	test("a malformed chunk: `failed`, that segment ends, the next keyframe chunk decodes", () => {
		const c0 = new ExtChunkWriter({ keyframe: true }).keyframe().string(0, "a").spawn(1, 0, 0, [0, 0, 0], 0, [1, 1, 1]);
		const bad = new ExtChunkWriter().record(8, 5, [1, 0]); // a Spawn far too short
		const c2 = new ExtChunkWriter({ keyframe: true }).keyframe().view(1, 2, 3, 4, 5);
		const x = decodeTtExt1([c0.row(0, T0), bad.row(1, T0 + 10_000), c2.row(2, T0 + 20_000)], T0);
		expect(x.failed).toContain("chunk 1");
		expect(x.entities[0]?.to).toBe(0);
		expect(x.view).toEqual([[20_000, 1, 2, 3, 4, 5]]);
		// a record header running past the end
		const cut = Buffer.from(c0.finish()).subarray(0, 10);
		expect(() => parseTtExt1Chunk(cut)).toThrow();
		expect(() => parseTtExt1Chunk(Uint8Array.from([2, 0, 0, 0]))).toThrow(/version/);
	});

	test("the keyframe block ends at the first later record: a node re-sent after it is a new one", () => {
		const c0 = new ExtChunkWriter({ keyframe: true }).keyframe().uiNode(0, 65535, 0, {}).keyframe(1000).uiNode(0, 65535, 0, {}, 500);
		const x = decodeTtExt1([c0.row(0, T0)], T0);
		expect(x.ui.map((n) => [n.from, n.to])).toEqual([
			[0, 1000],
			[1500, null],
		]);
	});

	test("an entity's animation continues across a keyframe when re-sent; Wait records only move time", () => {
		const c = new ExtChunkWriter({ keyframe: true })
			.keyframe()
			.string(0, "npc")
			.string(1, "rbxassetid://1")
			.spawn(1, 0, 1, [0, 0, 0], 0, [1, 1, 1])
			.animPlay(1, 7, 1, 1, 1, true, 0)
			.wait(65_535)
			.keyframe(0)
			.string(4, "rbxassetid://1")
			.string(5, "npc")
			.spawn(1, 5, 1, [0, 0, 0], 0, [1, 1, 1])
			.animPlay(1, 7, 4, 2, 1, true, 3);
		const x = decodeTtExt1([c.row(0, T0)], T0);
		expect(x.entities.map((e) => [e.e, e.from, e.to])).toEqual([[1, 0, null]]);
		expect(x.anims).toEqual([{ e: 1, track: 7, id: "rbxassetid://1", from: 0, to: null, looped: true, time: 0, adjust: [[0, 1, 1], [65_535, 2, 1]] }]);
	});

	test("caps: past a limit the rest is left out and `truncated` is set", () => {
		const c = new ExtChunkWriter({ keyframe: true }).keyframe();
		for (let i = 0; i < 20; i++) c.pose(0, [[0, 0, 0, 1]], 300);
		const x = decodeTtExt1([c.row(0, T0)], T0, { ...EXT_LIMITS, poses: 5 });
		expect(x.poses).toHaveLength(5);
		expect(x.truncated).toBe(true);
		const big = decodeTtExt1([c.row(0, T0), c.row(1, T0 + 10_000)], T0, { ...EXT_LIMITS, bytes: c.finish().length + 10 });
		expect(big.truncated).toBe(true);
		expect(big.poses).toHaveLength(20);
	});

	test("rows of other codecs are ignored; no rows: an empty timeline", () => {
		const c = new ExtChunkWriter({ keyframe: true }).keyframe().view(1, 1, 0, 70, 60);
		const other = { ...c.row(0, T0), codec: "tt-rec-1" as const };
		expect(decodeTtExt1([other], T0)).toMatchObject({ chunks: 0, view: [] });
		expect(decodeTtExt1([], T0)).toMatchObject({ chunks: 0, gaps: 0, entities: [], ui: [] });
	});
});

describe("framework version (framework 0.7.4: recording_meta ext_start fw)", () => {
	test("frameworkOf reads ext_start's fw, ignores other events and bad values", () => {
		const meta = (name: string, props?: Record<string, unknown>) => ({ kind: "recording_meta", name, props });
		expect(frameworkOf([meta("start"), meta("ext_start", { secs: 900, fw: "0.7.4" })])).toBe("0.7.4");
		expect(frameworkOf([meta("ext_start", { secs: 900 })])).toBeNull();
		expect(frameworkOf([meta("ext_start", { fw: 7 })])).toBeNull();
		expect(frameworkOf([meta("ext_start", { fw: "<script>" })])).toBeNull();
		expect(frameworkOf([{ kind: "custom", name: "ext_start", props: { fw: "0.7.4" } }])).toBeNull();
		expect(frameworkOf([])).toBeNull();
	});
});
