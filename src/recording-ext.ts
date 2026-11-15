/**
 * plans/36 extended recording: decoding `tt-ext-1` chunks into a session timeline for the replay.
 *
 * The wire contract is plans/36 "Wire contract: tt-ext-1" (the framework's SCHEMA.md has the same text). Little-endian;
 * a 4-byte header (`u8 version` 1, `u8 flags`: bit 0 last chunk, bit 1 the chunk starts with a Keyframe, `u16 0`), then
 * records `u8 tag, u16 dt, u16 length, payload`. Unknown tags are skipped by their length; a known record's payload may
 * be longer than this decoder reads (newer fields at the end are ignored), never shorter (a malformed chunk).
 *
 * Segments: a Keyframe record (tag 2) starts one. The string table and the UI tree are cleared and the full state
 * follows. A segment runs across chunks; a lost chunk (a gap in `chunk`) or a malformed one ends it, and decoding
 * resumes at the next chunk whose flag bit 1 is set.
 *
 * Readings of the contract where it leaves room (listed in the PR):
 *   - The keyframe block (the state written right after a Keyframe) lasts until the first record with dt > 0, or the
 *     first UiProps / UiGone / Move / Gone / AnimStop / AnimAdjust. An entity, UI node or animation alive before the
 *     Keyframe and re-sent in that block (same wire id and kind / class / parent / animation) continues as the same
 *     one; one not re-sent ends at the Keyframe. So a replay doesn't blink at every keyframe and the response stays small.
 *   - A lost or malformed chunk ends everything alive at the last decoded moment (the state across the gap is unknown).
 *   - Rig / Look / Pose records may name an entity before its Spawn in the same segment (a keyframe writes every Rig
 *     before the Spawns): they wait for that Spawn.
 *   - Yaw bytes (Spawn, Move) map like tt-rec-1's: byte / 256 × 2π − π.
 *   - UiGone also ends the node's visible descendants (the recorder may or may not send them one by one).
 *   - The recorded player is entity 0 (no Spawn: positions come from tt-rec-1); it is listed when any record names it.
 */
import type { ChunkRow, Vec3 } from "./recording.ts";

export const TT_EXT_CODEC = "tt-ext-1";

export const TT_EXT_TAGS = {
	wait: 0,
	string: 1,
	keyframe: 2,
	view: 3,
	afk: 4,
	anchor: 5,
	rig: 6,
	pose: 7,
	spawn: 8,
	look: 9,
	move: 10,
	gone: 11,
	animPlay: 12,
	animStop: 13,
	animAdjust: 14,
	uiNode: 20,
	uiProps: 21,
	uiGone: 22,
} as const;

/** UI field mask bits, in wire order. */
export const UI_FIELD_BITS = {
	rect: 0,
	rotation: 1,
	order: 2,
	background: 3,
	text: 4,
	textStyle: 5,
	image: 6,
	imageStyle: 7,
	imageRect: 8,
	stroke: 9,
	corner: 10,
	parent: 11,
	clip: 12,
	gradient: 13,
} as const;

export const UI_CLASSES = ["ScreenGui", "Frame", "TextLabel", "TextButton", "TextBox", "ImageLabel", "ImageButton", "ScrollingFrame", "ViewportFrame", "CanvasGroup", "VideoFrame"] as const;

export type RigKind = "none" | "R6" | "R15" | "other";
const RIG_KINDS: RigKind[] = ["none", "R6", "R15", "other"];

/** 1/8 stud (Move positions, Spawn sizes). */
const STUD_SCALE = 8;
const NO_PARENT = 65535;
const SQRT1_2 = 0.70710678;
const HEADER = 4;
const RECORD_HEADER = 5;

// The decoded timeline (the replay's `extended`) ------------------------------------------------------------------------

export interface ExtLook {
	/** Head, torso, left arm, right arm, left leg, right leg (#rrggbb). */
	colors?: [string, string, string, string, string, string];
	shirt?: string;
	pants?: string;
	tshirt?: string;
	face?: string;
}

export interface ExtEntity {
	/** 0 = the recorded player; others 1.. (one per spawn, never reused). */
	e: number;
	kind: string;
	humanoid: boolean;
	/** Another player's character. */
	player: boolean;
	/** Extents (studs). */
	size: Vec3;
	from: number;
	to: number | null;
	look?: ExtLook;
	/** [t, x, y, z, yaw]: the spawn first. */
	moves: [number, number, number, number, number][];
}

export interface ExtAnim {
	e: number;
	track: number;
	/** The AnimationId as set (e.g. `rbxassetid://180426354`). */
	id: string;
	from: number;
	to: number | null;
	looped: boolean;
	/** TimePosition when it started (s). */
	time: number;
	/** [t, speed, weight]: the play first, then each AnimAdjust. */
	adjust: [number, number, number][];
}

export interface ExtUiFields {
	rect?: [number, number, number, number];
	rotation?: number;
	order?: number;
	background?: { color: string; transparency: number };
	text?: string;
	textStyle?: {
		color: string;
		transparency: number;
		size: number;
		family: string;
		weight: number;
		xAlign: number;
		yAlign: number;
		scaled: boolean;
		wrapped: boolean;
		rich: boolean;
		strokeTransparency: number;
		strokeColor: string;
	};
	image?: string;
	imageStyle?: { color: string; transparency: number; scaleType: number };
	imageRect?: { offset: [number, number]; size: [number, number]; slice: [number, number, number, number] };
	stroke?: { color: string; transparency: number; thickness: number };
	corner?: number;
	/** Changes only: reparented (the parent's `i`, null for none). */
	parent?: number | null;
	clip?: boolean;
	gradient?: { keys: [number, string][]; rotation: number };
}

export interface ExtUiNode {
	/** Its index in `ui`. */
	i: number;
	cls: number;
	from: number;
	to: number | null;
	parent: number | null;
	f: ExtUiFields;
	ch?: [number, ExtUiFields][];
}

/** A session's extended streams; every `t` is ms after the decode's `origin` (the replay's start). */
export interface ExtTimeline {
	chunks: number;
	gaps: number;
	/** Records of unknown tags skipped by their length. */
	skipped: number;
	truncated?: boolean;
	failed?: string;
	/** [t, viewport w, h, top inset, fov, fps] */
	view: [number, number, number, number, number, number][];
	/** [from, to]; to null = until the end. */
	afk: [number, number | null][];
	rigs: { t: number; e: number; rig: RigKind; joints: string[] }[];
	/** [t, entity, joint index, qx, qy, qz, qw] */
	poses: [number, number, number, number, number, number, number][];
	entities: ExtEntity[];
	anims: ExtAnim[];
	ui: ExtUiNode[];
}

// Raw records (one chunk, string ids unresolved) -------------------------------------------------------------------------

/** A UI field set as on the wire: strings still as ids, parent as a wire id. */
export interface RawUiFields extends Omit<ExtUiFields, "text" | "textStyle" | "image" | "parent"> {
	text?: number;
	textStyle?: Omit<NonNullable<ExtUiFields["textStyle"]>, "family"> & { family: number };
	image?: number;
	parent?: number;
}

export type ExtRecord = { at: number } & (
	| { tag: 0 }
	| { tag: 1; id: number; text: string }
	| { tag: 2 }
	| { tag: 3; w: number; h: number; inset: number; fov: number; fps: number }
	| { tag: 4; afk: boolean }
	| { tag: 5; anchor: Vec3 }
	| { tag: 6; entity: number; rig: number; joints: number[] }
	| { tag: 7; entity: number; joints: [number, number, number, number, number][] }
	| { tag: 8; entity: number; kind: number; flags: number; pos: Vec3; yaw: number; size: Vec3 }
	| { tag: 9; entity: number; colors?: number[]; slots: [number, number][] }
	| { tag: 10; moves: [number, number, number, number, number][] }
	| { tag: 11; entity: number }
	| { tag: 12; entity: number; track: number; anim: number; speed: number; weight: number; looped: boolean; time: number }
	| { tag: 13; entity: number; track: number }
	| { tag: 14; entity: number; track: number; speed: number; weight: number }
	| { tag: 20; id: number; parent: number; cls: number; fields: RawUiFields }
	| { tag: 21; id: number; fields: RawUiFields }
	| { tag: 22; id: number }
	| { tag: -1; unknown: number }
);

export interface ExtChunk {
	version: number;
	last: boolean;
	keyframe: boolean;
	records: ExtRecord[];
	/** Records of unknown tags. */
	skipped: number;
}

export class ExtDecodeError extends Error {
	override name = "ExtDecodeError";
}

function yawOf(byte: number): number {
	return (byte / 256) * Math.PI * 2 - Math.PI;
}

/** A smallest-three quaternion (plans/36 Pose) back to [x, y, z, w]. */
export function unpackQuat(u: number): [number, number, number, number] {
	const idx = u & 3;
	const comp = (shift: number) => (((u >>> shift) & 1023) / 1023 * 2 - 1) * SQRT1_2;
	const a = comp(2);
	const b = comp(12);
	const c = comp(22);
	const dropped = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
	const out: [number, number, number, number] = [0, 0, 0, 0];
	const rest = [a, b, c];
	let k = 0;
	for (let i = 0; i < 4; i++) out[i] = i === idx ? dropped : (rest[k++] as number);
	return out;
}

const hex = (r: number, g: number, b: number) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
const unit = (byte: number) => Math.round((byte / 255) * 1000) / 1000;

/** A bounded reader over one record's payload; reading past it throws (a malformed record). */
class Payload {
	private offset: number;
	constructor(
		private readonly view: DataView,
		start: number,
		private readonly end: number,
		private readonly tag: number,
	) {
		this.offset = start;
	}
	private need(n: number): number {
		const at = this.offset;
		if (at + n > this.end) throw new ExtDecodeError(`tt-ext-1: record ${this.tag} is shorter than its fields`);
		this.offset += n;
		return at;
	}
	u8(): number {
		return this.view.getUint8(this.need(1));
	}
	u16(): number {
		return this.view.getUint16(this.need(2), true);
	}
	i16(): number {
		return this.view.getInt16(this.need(2), true);
	}
	u32(): number {
		return this.view.getUint32(this.need(4), true);
	}
	f32(): number {
		return this.view.getFloat32(this.need(4), true);
	}
	rgb(): string {
		return hex(this.u8(), this.u8(), this.u8());
	}
	rest(): Uint8Array {
		const at = this.need(this.end - this.offset);
		return new Uint8Array(this.view.buffer, this.view.byteOffset + at, this.end - at);
	}
}

function readUiFields(p: Payload, mask: number): RawUiFields {
	const f: RawUiFields = {};
	const has = (bit: number) => (mask & (1 << bit)) !== 0;
	if (has(0)) f.rect = [p.i16(), p.i16(), p.u16(), p.u16()];
	if (has(1)) f.rotation = p.i16() / 10;
	if (has(2)) f.order = p.u16();
	if (has(3)) {
		const color = p.rgb();
		f.background = { color, transparency: unit(p.u8()) };
	}
	if (has(4)) f.text = p.u16();
	if (has(5)) {
		const color = p.rgb();
		const transparency = unit(p.u8());
		const size = p.u8();
		const family = p.u16();
		const weight = p.u16();
		const xAlign = p.u8();
		const yAlign = p.u8();
		const flags = p.u8();
		const strokeTransparency = unit(p.u8());
		const strokeColor = p.rgb();
		f.textStyle = { color, transparency, size, family, weight, xAlign, yAlign, scaled: (flags & 1) !== 0, wrapped: (flags & 2) !== 0, rich: (flags & 4) !== 0, strokeTransparency, strokeColor };
	}
	if (has(6)) f.image = p.u16();
	if (has(7)) {
		const color = p.rgb();
		f.imageStyle = { color, transparency: unit(p.u8()), scaleType: p.u8() };
	}
	if (has(8)) f.imageRect = { offset: [p.u16(), p.u16()], size: [p.u16(), p.u16()], slice: [p.u16(), p.u16(), p.u16(), p.u16()] };
	if (has(9)) {
		const color = p.rgb();
		f.stroke = { color, transparency: unit(p.u8()), thickness: p.u8() / 4 };
	}
	if (has(10)) f.corner = p.u8();
	if (has(11)) f.parent = p.u16();
	if (has(12)) f.clip = p.u8() !== 0;
	if (has(13)) {
		const n = p.u8();
		const keys: [number, string][] = [];
		for (let i = 0; i < n; i++) {
			const time = unit(p.u8());
			keys.push([time, p.rgb()]);
		}
		f.gradient = { keys, rotation: p.i16() };
	}
	// higher bits: fields this decoder doesn't know; they come last, the record's length skips them
	return f;
}

const utf8 = new TextDecoder();

/** Reads one tt-ext-1 chunk into raw records (string ids unresolved). Throws ExtDecodeError on a malformed chunk. */
export function parseTtExt1Chunk(bytes: Uint8Array): ExtChunk {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = bytes.byteLength;
	if (size < HEADER) throw new ExtDecodeError("tt-ext-1: chunk too short");
	const version = view.getUint8(0);
	if (version !== 1) throw new ExtDecodeError(`tt-ext-1: unknown version ${version}`);
	const flags = view.getUint8(1);
	const chunk: ExtChunk = { version, last: (flags & 1) !== 0, keyframe: (flags & 2) !== 0, records: [], skipped: 0 };
	let offset = HEADER;
	let at = 0;
	while (offset < size) {
		if (offset + RECORD_HEADER > size) throw new ExtDecodeError(`tt-ext-1: a record header runs past the end at byte ${offset}`);
		const tag = view.getUint8(offset);
		at += view.getUint16(offset + 1, true);
		const length = view.getUint16(offset + 3, true);
		const start = offset + RECORD_HEADER;
		const end = start + length;
		if (end > size) throw new ExtDecodeError(`tt-ext-1: record ${tag} at byte ${offset} runs past the end of the chunk`);
		offset = end;
		const p = new Payload(view, start, end, tag);
		switch (tag) {
			case TT_EXT_TAGS.wait:
				chunk.records.push({ tag, at });
				break;
			case TT_EXT_TAGS.string: {
				const id = p.u16();
				chunk.records.push({ tag, at, id, text: utf8.decode(p.rest()) });
				break;
			}
			case TT_EXT_TAGS.keyframe:
				chunk.records.push({ tag, at });
				break;
			case TT_EXT_TAGS.view:
				chunk.records.push({ tag, at, w: p.u16(), h: p.u16(), inset: p.u16(), fov: p.u8(), fps: p.u8() });
				break;
			case TT_EXT_TAGS.afk:
				chunk.records.push({ tag, at, afk: p.u8() !== 0 });
				break;
			case TT_EXT_TAGS.anchor:
				chunk.records.push({ tag, at, anchor: [p.f32(), p.f32(), p.f32()] });
				break;
			case TT_EXT_TAGS.rig: {
				const entity = p.u8();
				const rig = p.u8();
				const n = p.u8();
				const joints: number[] = [];
				for (let i = 0; i < n; i++) joints.push(p.u16());
				chunk.records.push({ tag, at, entity, rig, joints });
				break;
			}
			case TT_EXT_TAGS.pose: {
				const entity = p.u8();
				const mask = p.u32();
				const joints: [number, number, number, number, number][] = [];
				for (let i = 0; i < 32; i++) if ((mask >>> i) & 1) joints.push([i, ...unpackQuat(p.u32())]);
				chunk.records.push({ tag, at, entity, joints });
				break;
			}
			case TT_EXT_TAGS.spawn: {
				const entity = p.u8();
				const kind = p.u16();
				const f = p.u8();
				const pos: Vec3 = [p.f32(), p.f32(), p.f32()];
				const yaw = yawOf(p.u8());
				const s: Vec3 = [p.u16() / STUD_SCALE, p.u16() / STUD_SCALE, p.u16() / STUD_SCALE];
				chunk.records.push({ tag, at, entity, kind, flags: f, pos, yaw, size: s });
				break;
			}
			case TT_EXT_TAGS.look: {
				const entity = p.u8();
				const f = p.u8();
				let colors: number[] | undefined;
				if (f & 1) {
					colors = [];
					for (let i = 0; i < 18; i++) colors.push(p.u8());
				}
				const n = p.u8();
				const slots: [number, number][] = [];
				for (let i = 0; i < n; i++) slots.push([p.u8(), p.u16()]);
				chunk.records.push({ tag, at, entity, ...(colors ? { colors } : {}), slots });
				break;
			}
			case TT_EXT_TAGS.move: {
				const count = p.u8();
				const moves: [number, number, number, number, number][] = [];
				for (let i = 0; i < count; i++) moves.push([p.u8(), p.i16(), p.i16(), p.i16(), p.u8()]);
				chunk.records.push({ tag, at, moves });
				break;
			}
			case TT_EXT_TAGS.gone:
				chunk.records.push({ tag, at, entity: p.u8() });
				break;
			case TT_EXT_TAGS.animPlay: {
				const entity = p.u8();
				const track = p.u16();
				const anim = p.u16();
				const speed = p.i16() / 100;
				const weight = unit(p.u8());
				const looped = (p.u8() & 1) !== 0;
				chunk.records.push({ tag, at, entity, track, anim, speed, weight, looped, time: p.u16() / 100 });
				break;
			}
			case TT_EXT_TAGS.animStop:
				chunk.records.push({ tag, at, entity: p.u8(), track: p.u16() });
				break;
			case TT_EXT_TAGS.animAdjust: {
				const entity = p.u8();
				const track = p.u16();
				const speed = p.i16() / 100;
				chunk.records.push({ tag, at, entity, track, speed, weight: unit(p.u8()) });
				break;
			}
			case TT_EXT_TAGS.uiNode: {
				const id = p.u16();
				const parent = p.u16();
				const cls = p.u8();
				const mask = p.u16();
				chunk.records.push({ tag, at, id, parent, cls, fields: readUiFields(p, mask) });
				break;
			}
			case TT_EXT_TAGS.uiProps: {
				const id = p.u16();
				const mask = p.u16();
				chunk.records.push({ tag, at, id, fields: readUiFields(p, mask) });
				break;
			}
			case TT_EXT_TAGS.uiGone:
				chunk.records.push({ tag, at, id: p.u16() });
				break;
			default:
				chunk.skipped++;
				chunk.records.push({ tag: -1, at, unknown: tag });
		}
	}
	return chunk;
}

// The timeline builder ---------------------------------------------------------------------------------------------------

export interface ExtLimits {
	poses: number;
	moves: number;
	entities: number;
	anims: number;
	uiNodes: number;
	uiChanges: number;
	views: number;
}

/** Caps on one session's timeline (a replay response stays a few MB at most). */
export const EXT_LIMITS: ExtLimits = { poses: 150_000, moves: 200_000, entities: 4000, anims: 20_000, uiNodes: 20_000, uiChanges: 150_000, views: 20_000 };

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

const LOOK_SLOTS: Record<number, keyof Omit<ExtLook, "colors">> = { 1: "shirt", 2: "pants", 3: "tshirt", 4: "face" };

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Records that end a keyframe block (state is done, the stream goes on). */
const AFTER_BLOCK = new Set<number>([TT_EXT_TAGS.uiProps, TT_EXT_TAGS.uiGone, TT_EXT_TAGS.move, TT_EXT_TAGS.gone, TT_EXT_TAGS.animStop, TT_EXT_TAGS.animAdjust]);

class TimelineBuilder {
	readonly out: ExtTimeline = { chunks: 0, gaps: 0, skipped: 0, view: [], afk: [], rigs: [], poses: [], entities: [], anims: [], ui: [] };
	private moves = 0;
	private uiChanges = 0;
	// segment state
	private inSegment = false;
	private strings = new Map<number, string>();
	private anchor: Vec3 = [0, 0, 0];
	private entByWire = new Map<number, ExtEntity>();
	private uiByWire = new Map<number, ExtUiNode>();
	private animByKey = new Map<string, ExtAnim>();
	private pendingRigs = new Map<number, { t: number; rig: RigKind; joints: string[] }>();
	private pendingLooks = new Map<number, ExtLook>();
	// the keyframe block: what may continue
	private block: { t: number; ent: Map<number, ExtEntity>; ui: Map<number, ExtUiNode>; anims: Map<string, ExtAnim> } | null = null;
	/** Merged current fields per UI node (to diff a re-sent node). */
	private uiCurrent = new Map<number, ExtUiFields>();
	private rigOf = new Map<number, { rig: RigKind; joints: string[] }>();
	private last = 0;

	constructor(
		private readonly origin: number,
		private readonly limits: ExtLimits,
	) {}

	private cap(): void {
		this.out.truncated = true;
	}

	private str(id: number): string {
		return this.strings.get(id) ?? "";
	}

	private entity0(t: number): ExtEntity {
		let e = this.out.entities.find((x) => x.e === 0);
		if (!e) {
			e = { e: 0, kind: "self", humanoid: true, player: false, size: [4, 5, 1], from: t, to: null, moves: [] };
			this.out.entities.unshift(e);
		}
		return e;
	}

	/** The replay entity a wire id names now (0 is the recorded player). */
	private entity(wire: number, t: number): ExtEntity | undefined {
		return wire === 0 ? this.entity0(t) : this.entByWire.get(wire);
	}

	private closeEntity(ent: ExtEntity, t: number): void {
		if (ent.to === null && ent.e !== 0) ent.to = t;
		for (const [key, anim] of this.animByKey) {
			if (anim.e !== ent.e) continue;
			if (anim.to === null) anim.to = t;
			this.animByKey.delete(key);
		}
	}

	private closeUi(node: ExtUiNode, t: number): void {
		if (node.to === null) node.to = Math.max(node.from, t);
	}

	/** Ends everything alive (a gap, a malformed chunk, the end of a keyframe block for what wasn't re-sent). */
	private endSegment(t: number): void {
		this.closeBlock();
		for (const ent of this.entByWire.values()) this.closeEntity(ent, t);
		for (const anim of this.animByKey.values()) if (anim.to === null) anim.to = t;
		for (const node of this.uiByWire.values()) this.closeUi(node, t);
		this.entByWire.clear();
		this.animByKey.clear();
		this.uiByWire.clear();
		this.pendingRigs.clear();
		this.pendingLooks.clear();
		this.strings.clear();
		this.inSegment = false;
	}

	private closeBlock(): void {
		const block = this.block;
		if (!block) return;
		this.block = null;
		for (const ent of block.ent.values()) this.closeEntity(ent, block.t);
		for (const anim of block.anims.values()) if (anim.to === null) anim.to = block.t;
		for (const node of block.ui.values()) this.closeUi(node, block.t);
	}

	private keyframe(t: number): void {
		this.closeBlock();
		this.block = this.inSegment ? { t, ent: new Map(this.entByWire), ui: new Map(this.uiByWire), anims: new Map(this.animByKey) } : null;
		this.entByWire.clear();
		this.uiByWire.clear();
		this.animByKey.clear();
		this.pendingRigs.clear();
		this.pendingLooks.clear();
		this.strings.clear();
		this.anchor = [0, 0, 0];
		this.inSegment = true;
	}

	gap(count: number): void {
		this.out.gaps += count;
		if (this.inSegment) this.endSegment(this.last);
	}

	fail(message: string): void {
		this.out.failed ??= message;
		if (this.inSegment) this.endSegment(this.last);
	}

	get active(): boolean {
		return this.inSegment;
	}

	private setRig(e: number, t: number, rig: RigKind, joints: string[]): void {
		const current = this.rigOf.get(e);
		if (current && current.rig === rig && sameJson(current.joints, joints)) return;
		this.rigOf.set(e, { rig, joints });
		this.out.rigs.push({ t, e, rig, joints });
	}

	private applyLook(ent: ExtEntity, look: ExtLook): void {
		ent.look = { ...(ent.look ?? {}), ...look };
	}

	private addChange(node: ExtUiNode, t: number, fields: ExtUiFields): void {
		if (!Object.keys(fields).length) return;
		const current = this.uiCurrent.get(node.i) ?? {};
		this.uiCurrent.set(node.i, { ...current, ...fields });
		const ch = (node.ch ??= []);
		const lastChange = ch[ch.length - 1];
		if (lastChange && lastChange[0] === t) {
			Object.assign(lastChange[1], fields);
			return;
		}
		if (this.uiChanges >= this.limits.uiChanges) return this.cap();
		this.uiChanges++;
		ch.push([t, fields]);
	}

	private uiFields(raw: RawUiFields): ExtUiFields {
		const { text, textStyle, image, parent, ...rest } = raw;
		const f: ExtUiFields = { ...rest };
		if (text !== undefined) f.text = this.str(text);
		if (textStyle) f.textStyle = { ...textStyle, family: this.str(textStyle.family) };
		if (image !== undefined) f.image = this.str(image);
		if (parent !== undefined) f.parent = parent === NO_PARENT ? null : (this.uiByWire.get(parent)?.i ?? null);
		return f;
	}

	record(r: ExtRecord, abs: number): void {
		const t = Math.round(abs - this.origin);
		this.last = t;
		if (r.tag === TT_EXT_TAGS.keyframe) return this.keyframe(t);
		if (!this.inSegment) return;
		if (this.block && (AFTER_BLOCK.has(r.tag) || t > this.block.t)) this.closeBlock();
		switch (r.tag) {
			case TT_EXT_TAGS.string:
				this.strings.set(r.id, r.text);
				return;
			case TT_EXT_TAGS.view: {
				const row: ExtTimeline["view"][number] = [t, r.w, r.h, r.inset, r.fov, r.fps];
				const prev = this.out.view[this.out.view.length - 1];
				if (prev && prev.slice(1).every((v, i) => v === row[i + 1])) return;
				if (this.out.view.length >= this.limits.views) return this.cap();
				this.out.view.push(row);
				return;
			}
			case TT_EXT_TAGS.afk: {
				const open = this.out.afk[this.out.afk.length - 1];
				if (r.afk && !(open && open[1] === null)) this.out.afk.push([t, null]);
				else if (!r.afk && open && open[1] === null) open[1] = t;
				return;
			}
			case TT_EXT_TAGS.anchor:
				this.anchor = r.anchor;
				return;
			case TT_EXT_TAGS.rig: {
				const rig = RIG_KINDS[r.rig] ?? "other";
				const joints = r.joints.map((id) => this.str(id));
				const ent = this.entity(r.entity, t);
				if (ent) this.setRig(ent.e, t, rig, joints);
				else this.pendingRigs.set(r.entity, { t, rig, joints });
				return;
			}
			case TT_EXT_TAGS.pose: {
				const ent = this.entity(r.entity, t);
				if (!ent) return;
				for (const [j, x, y, z, w] of r.joints) {
					if (this.out.poses.length >= this.limits.poses) return this.cap();
					this.out.poses.push([t, ent.e, j, r4(x), r4(y), r4(z), r4(w)]);
				}
				return;
			}
			case TT_EXT_TAGS.spawn:
				return this.spawn(r, t);
			case TT_EXT_TAGS.look: {
				const look: ExtLook = {};
				if (r.colors) {
					const c = r.colors;
					look.colors = [0, 1, 2, 3, 4, 5].map((k) => hex(c[k * 3] as number, c[k * 3 + 1] as number, c[k * 3 + 2] as number)) as ExtLook["colors"];
				}
				for (const [slot, id] of r.slots) {
					const key = LOOK_SLOTS[slot];
					if (key) look[key] = this.str(id);
				}
				const ent = this.entity(r.entity, t);
				if (ent) this.applyLook(ent, look);
				else this.pendingLooks.set(r.entity, { ...(this.pendingLooks.get(r.entity) ?? {}), ...look });
				return;
			}
			case TT_EXT_TAGS.move:
				for (const [wire, x, y, z, yaw] of r.moves) {
					const ent = wire === 0 ? undefined : this.entByWire.get(wire);
					if (!ent) continue;
					if (this.moves >= this.limits.moves) return this.cap();
					this.moves++;
					ent.moves.push([t, r2(this.anchor[0] + x / STUD_SCALE), r2(this.anchor[1] + y / STUD_SCALE), r2(this.anchor[2] + z / STUD_SCALE), r3(yawOf(yaw))]);
				}
				return;
			case TT_EXT_TAGS.gone: {
				const ent = this.entByWire.get(r.entity);
				if (!ent) return;
				this.closeEntity(ent, t);
				this.entByWire.delete(r.entity);
				return;
			}
			case TT_EXT_TAGS.animPlay:
				return this.animPlay(r, t);
			case TT_EXT_TAGS.animStop: {
				const ent = this.entity(r.entity, t);
				const key = ent ? `${ent.e}:${r.track}` : "";
				const anim = this.animByKey.get(key);
				if (!anim) return;
				anim.to = t;
				this.animByKey.delete(key);
				return;
			}
			case TT_EXT_TAGS.animAdjust: {
				const ent = this.entity(r.entity, t);
				const anim = ent ? this.animByKey.get(`${ent.e}:${r.track}`) : undefined;
				if (anim) anim.adjust.push([t, r.speed, r.weight]);
				return;
			}
			case TT_EXT_TAGS.uiNode:
				return this.uiNode(r, t);
			case TT_EXT_TAGS.uiProps: {
				const node = this.uiByWire.get(r.id);
				if (!node) return;
				this.addChange(node, t, this.uiFields(r.fields));
				return;
			}
			case TT_EXT_TAGS.uiGone: {
				const node = this.uiByWire.get(r.id);
				if (!node) return;
				this.closeUi(node, t);
				this.uiByWire.delete(r.id);
				// its visible descendants go with it
				const gone = new Set([node.i]);
				let grew = true;
				while (grew) {
					grew = false;
					for (const [wire, other] of this.uiByWire) {
						const parent = this.uiCurrent.get(other.i)?.parent ?? other.parent;
						if (parent !== null && parent !== undefined && gone.has(parent)) {
							this.closeUi(other, t);
							this.uiByWire.delete(wire);
							gone.add(other.i);
							grew = true;
						}
					}
				}
				return;
			}
			case -1:
				this.out.skipped++;
				return;
		}
	}

	private spawn(r: Extract<ExtRecord, { tag: 8 }>, t: number): void {
		if (r.entity === 0) return;
		const kind = this.str(r.kind);
		const humanoid = (r.flags & 1) !== 0;
		const player = (r.flags & 2) !== 0;
		const move: [number, number, number, number, number] = [t, r2(r.pos[0]), r2(r.pos[1]), r2(r.pos[2]), r3(r.yaw)];
		let ent = this.block?.ent.get(r.entity);
		if (ent && ent.kind === kind && ent.humanoid === humanoid && ent.player === player) {
			this.block?.ent.delete(r.entity);
			const prev = ent.moves[ent.moves.length - 1];
			if (!prev || prev.slice(1).some((v, i) => v !== move[i + 1])) ent.moves.push(move);
		} else {
			const alive = this.entByWire.get(r.entity);
			if (alive) this.closeEntity(alive, t);
			if (this.out.entities.filter((x) => x.e !== 0).length >= this.limits.entities) return this.cap();
			const e = this.out.entities.reduce((m, x) => Math.max(m, x.e), 0) + 1;
			ent = { e, kind, humanoid, player, size: r.size.map(r2) as Vec3, from: t, to: null, moves: [move] };
			this.out.entities.push(ent);
		}
		this.entByWire.set(r.entity, ent);
		const rig = this.pendingRigs.get(r.entity);
		if (rig) {
			this.pendingRigs.delete(r.entity);
			this.setRig(ent.e, rig.t, rig.rig, rig.joints);
		}
		const look = this.pendingLooks.get(r.entity);
		if (look) {
			this.pendingLooks.delete(r.entity);
			this.applyLook(ent, look);
		}
	}

	private animPlay(r: Extract<ExtRecord, { tag: 12 }>, t: number): void {
		const ent = this.entity(r.entity, t);
		if (!ent) return;
		const key = `${ent.e}:${r.track}`;
		const id = this.str(r.anim);
		const carried = this.block?.anims.get(key);
		if (carried && carried.id === id) {
			this.block?.anims.delete(key);
			const prev = carried.adjust[carried.adjust.length - 1];
			if (!prev || prev[1] !== r.speed || prev[2] !== r.weight) carried.adjust.push([t, r.speed, r.weight]);
			this.animByKey.set(key, carried);
			return;
		}
		const alive = this.animByKey.get(key);
		if (alive && alive.to === null) alive.to = t;
		if (this.out.anims.length >= this.limits.anims) return this.cap();
		const anim: ExtAnim = { e: ent.e, track: r.track, id, from: t, to: null, looped: r.looped, time: r.time, adjust: [[t, r.speed, r.weight]] };
		this.out.anims.push(anim);
		this.animByKey.set(key, anim);
	}

	private uiNode(r: Extract<ExtRecord, { tag: 20 }>, t: number): void {
		const parent = r.parent === NO_PARENT ? null : (this.uiByWire.get(r.parent)?.i ?? null);
		const { parent: _ignored, ...fields } = this.uiFields(r.fields);
		const carried = this.block?.ui.get(r.id);
		if (carried && carried.cls === r.cls && (this.uiCurrent.get(carried.i)?.parent ?? carried.parent) === parent) {
			this.block?.ui.delete(r.id);
			const current = this.uiCurrent.get(carried.i) ?? {};
			const changed: ExtUiFields = {};
			for (const [key, value] of Object.entries(fields) as [keyof ExtUiFields, unknown][]) {
				if (!sameJson(current[key], value)) (changed as Record<string, unknown>)[key] = value;
			}
			this.addChange(carried, t, changed);
			this.uiByWire.set(r.id, carried);
			return;
		}
		const alive = this.uiByWire.get(r.id);
		if (alive) this.closeUi(alive, t);
		if (this.out.ui.length >= this.limits.uiNodes) return this.cap();
		const node: ExtUiNode = { i: this.out.ui.length, cls: r.cls, from: t, to: null, parent, f: fields };
		this.out.ui.push(node);
		this.uiCurrent.set(node.i, { ...fields, parent });
		this.uiByWire.set(r.id, node);
	}

	finish(): ExtTimeline {
		this.closeBlock();
		for (const node of this.out.ui) if (!node.ch?.length) delete node.ch;
		this.out.entities.sort((a, b) => a.e - b.e);
		return this.out;
	}
}

/**
 * Decodes a session's tt-ext-1 chunks (any order; sorted by `chunk` here) into its timeline, times in ms after `origin`
 * (the replay's start). Never throws: a malformed chunk sets `failed` and decoding resumes at the next keyframe chunk.
 */
export function decodeTtExt1(rows: readonly ChunkRow[], origin = 0, limits: ExtLimits = EXT_LIMITS): ExtTimeline {
	const chunks = rows.filter((r) => r.codec === TT_EXT_CODEC).sort((a, b) => a.chunk - b.chunk);
	const b = new TimelineBuilder(origin, limits);
	b.out.chunks = chunks.length;
	let expected = chunks[0]?.chunk ?? 0;
	for (const row of chunks) {
		if (row.chunk < expected) continue; // a duplicate row
		if (row.chunk > expected) b.gap(row.chunk - expected);
		expected = row.chunk + 1;
		let chunk: ExtChunk;
		try {
			chunk = parseTtExt1Chunk(Uint8Array.from(Buffer.from(row.data, "base64")));
		} catch (error) {
			b.fail(`chunk ${row.chunk}: ${(error as Error).message}`);
			continue;
		}
		if (!b.active && !chunk.keyframe) continue; // waiting for a keyframe chunk
		const start = row.t ?? 0;
		for (const r of chunk.records) b.record(r, start + r.at);
	}
	return b.finish();
}

/** The animation ids (the digits of each AnimationId) in a timeline, for the clip store. */
export function animationIdsOf(timeline: Pick<ExtTimeline, "anims">): string[] {
	const ids = new Set<string>();
	for (const a of timeline.anims) {
		const m = /(\d{1,20})\s*$/.exec(a.id);
		if (m) ids.add(m[1] as string);
	}
	return [...ids];
}
