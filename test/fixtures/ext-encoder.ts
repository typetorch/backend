/**
 * A reference ENCODER for tt-ext-1 (plans/36 "Wire contract"), for tests only: it writes chunks the way the framework's
 * recorder is specified to, so the decoder's tests round-trip every record type. Not the framework's code; written from
 * the same contract text.
 */
import type { ChunkRow, Vec3 } from "../../src/recording.ts";
import { TT_EXT_TAGS } from "../../src/recording-ext.ts";

export type Quat = [number, number, number, number];

/** Smallest-three: `idx | a << 2 | b << 12 | c << 22`, the largest component dropped (sign flipped so it is positive). */
export function packQuat(q: Quat): number {
	const len = Math.hypot(...q) || 1;
	let v = q.map((c) => c / len) as Quat;
	let idx = 0;
	for (let i = 1; i < 4; i++) if (Math.abs(v[i] as number) > Math.abs(v[idx] as number)) idx = i;
	if ((v[idx] as number) < 0) v = v.map((c) => -c) as Quat;
	const rest = v.filter((_, i) => i !== idx);
	const enc = (c: number) => Math.max(0, Math.min(1023, Math.round((c / 0.70710678 + 1) / 2 * 1023)));
	return (idx | (enc(rest[0] as number) << 2) | (enc(rest[1] as number) << 12) | (enc(rest[2] as number) << 22)) >>> 0;
}

/** A UI field set to encode: strings as string ids (send them with `string` first). */
export interface UiFieldsIn {
	rect?: [number, number, number, number];
	rotation?: number;
	order?: number;
	background?: [number, number, number, number];
	text?: number;
	textStyle?: { rgb: [number, number, number]; transparency: number; size: number; family: number; weight: number; xAlign: number; yAlign: number; flags: number; strokeTransparency: number; strokeRgb: [number, number, number] };
	image?: number;
	imageStyle?: { rgb: [number, number, number]; transparency: number; scaleType: number };
	imageRect?: [number, number, number, number, number, number, number, number];
	stroke?: [number, number, number, number, number];
	corner?: number;
	parent?: number;
	clip?: boolean;
	gradient?: { keys: [number, number, number, number][]; rotation: number };
}

class Bytes {
	private parts: number[] = [];
	private readonly scratch = new DataView(new ArrayBuffer(4));
	u8(v: number): this {
		this.parts.push(v & 255);
		return this;
	}
	u16(v: number): this {
		this.scratch.setUint16(0, v, true);
		this.parts.push(this.scratch.getUint8(0), this.scratch.getUint8(1));
		return this;
	}
	i16(v: number): this {
		this.scratch.setInt16(0, v, true);
		this.parts.push(this.scratch.getUint8(0), this.scratch.getUint8(1));
		return this;
	}
	u32(v: number): this {
		this.scratch.setUint32(0, v >>> 0, true);
		for (let i = 0; i < 4; i++) this.parts.push(this.scratch.getUint8(i));
		return this;
	}
	f32(v: number): this {
		this.scratch.setFloat32(0, v, true);
		for (let i = 0; i < 4; i++) this.parts.push(this.scratch.getUint8(i));
		return this;
	}
	raw(bytes: Iterable<number>): this {
		for (const b of bytes) this.parts.push(b & 255);
		return this;
	}
	get length(): number {
		return this.parts.length;
	}
	toArray(): Uint8Array {
		return Uint8Array.from(this.parts);
	}
}

const unitByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
const yawByte = (yaw: number) => (Math.round(((yaw + Math.PI) / (Math.PI * 2)) * 256) % 256 + 256) % 256;

function uiFields(b: Bytes, f: UiFieldsIn): number {
	let mask = 0;
	const set = (bit: number) => (mask |= 1 << bit);
	if (f.rect) {
		set(0);
		b.i16(f.rect[0]).i16(f.rect[1]).u16(f.rect[2]).u16(f.rect[3]);
	}
	if (f.rotation !== undefined) {
		set(1);
		b.i16(Math.round(f.rotation * 10));
	}
	if (f.order !== undefined) {
		set(2);
		b.u16(f.order);
	}
	if (f.background) {
		set(3);
		b.u8(f.background[0]).u8(f.background[1]).u8(f.background[2]).u8(unitByte(f.background[3]));
	}
	if (f.text !== undefined) {
		set(4);
		b.u16(f.text);
	}
	if (f.textStyle) {
		set(5);
		const s = f.textStyle;
		b.raw(s.rgb).u8(unitByte(s.transparency)).u8(s.size).u16(s.family).u16(s.weight).u8(s.xAlign).u8(s.yAlign).u8(s.flags).u8(unitByte(s.strokeTransparency)).raw(s.strokeRgb);
	}
	if (f.image !== undefined) {
		set(6);
		b.u16(f.image);
	}
	if (f.imageStyle) {
		set(7);
		b.raw(f.imageStyle.rgb).u8(unitByte(f.imageStyle.transparency)).u8(f.imageStyle.scaleType);
	}
	if (f.imageRect) {
		set(8);
		for (const v of f.imageRect) b.u16(v);
	}
	if (f.stroke) {
		set(9);
		b.u8(f.stroke[0]).u8(f.stroke[1]).u8(f.stroke[2]).u8(unitByte(f.stroke[3])).u8(Math.round(f.stroke[4] * 4));
	}
	if (f.corner !== undefined) {
		set(10);
		b.u8(f.corner);
	}
	if (f.parent !== undefined) {
		set(11);
		b.u16(f.parent);
	}
	if (f.clip !== undefined) {
		set(12);
		b.u8(f.clip ? 1 : 0);
	}
	if (f.gradient) {
		set(13);
		b.u8(f.gradient.keys.length);
		for (const [time, r, g, bl] of f.gradient.keys) b.u8(unitByte(time)).u8(r).u8(g).u8(bl);
		b.i16(f.gradient.rotation);
	}
	return mask;
}

/** Writes one chunk: `new ExtChunkWriter({ keyframe: true }).keyframe().string(0, "zombie")...finish()`. */
export class ExtChunkWriter {
	private readonly body = new Bytes();
	private records = 0;
	constructor(private readonly flags: { last?: boolean; keyframe?: boolean } = {}) {}

	/** Any record: tag, dt (ms since the previous one), payload. */
	record(tag: number, dt: number, payload: Bytes | Uint8Array | number[] = []): this {
		const bytes = payload instanceof Bytes ? payload.toArray() : Uint8Array.from(payload);
		this.body.u8(tag).u16(dt).u16(bytes.length).raw(bytes);
		this.records++;
		return this;
	}
	wait(dt: number): this {
		return this.record(TT_EXT_TAGS.wait, dt);
	}
	string(id: number, text: string, dt = 0): this {
		return this.record(TT_EXT_TAGS.string, dt, new Bytes().u16(id).raw(new TextEncoder().encode(text)));
	}
	keyframe(dt = 0): this {
		return this.record(TT_EXT_TAGS.keyframe, dt, new Bytes().u16(0));
	}
	view(w: number, h: number, inset: number, fov: number, fps: number, dt = 0): this {
		return this.record(TT_EXT_TAGS.view, dt, new Bytes().u16(w).u16(h).u16(inset).u8(fov).u8(Math.min(255, fps)));
	}
	afk(on: boolean, dt = 0): this {
		return this.record(TT_EXT_TAGS.afk, dt, new Bytes().u8(on ? 1 : 0));
	}
	anchor(at: Vec3, dt = 0): this {
		return this.record(TT_EXT_TAGS.anchor, dt, new Bytes().f32(at[0]).f32(at[1]).f32(at[2]));
	}
	rig(entity: number, rig: number, jointIds: number[], dt = 0): this {
		const b = new Bytes().u8(entity).u8(rig).u8(jointIds.length);
		for (const id of jointIds) b.u16(id);
		return this.record(TT_EXT_TAGS.rig, dt, b);
	}
	/** joints[i] undefined = not sent (unchanged). */
	pose(entity: number, joints: (Quat | undefined)[], dt = 0): this {
		let mask = 0;
		const quats = new Bytes();
		joints.forEach((q, i) => {
			if (!q) return;
			mask |= 1 << i;
			quats.u32(packQuat(q));
		});
		return this.record(TT_EXT_TAGS.pose, dt, new Bytes().u8(entity).u32(mask >>> 0).raw(quats.toArray()));
	}
	spawn(entity: number, kind: number, flags: number, pos: Vec3, yaw: number, size: Vec3, dt = 0): this {
		const b = new Bytes().u8(entity).u16(kind).u8(flags).f32(pos[0]).f32(pos[1]).f32(pos[2]).u8(yawByte(yaw));
		for (const s of size) b.u16(Math.round(s * 8));
		return this.record(TT_EXT_TAGS.spawn, dt, b);
	}
	/** colors: 6 × [r, g, b]; slots: [slot, string id]. */
	look(entity: number, colors: [number, number, number][] | null, slots: [number, number][], dt = 0): this {
		const b = new Bytes().u8(entity).u8(colors ? 1 : 0);
		if (colors) for (const c of colors) b.raw(c);
		b.u8(slots.length);
		for (const [slot, id] of slots) b.u8(slot).u16(id);
		return this.record(TT_EXT_TAGS.look, dt, b);
	}
	/** Positions in studs relative to the Anchor (written as 1/8 stud). */
	move(items: [number, number, number, number, number][], dt = 0): this {
		const b = new Bytes().u8(items.length);
		for (const [e, x, y, z, yaw] of items) b.u8(e).i16(Math.round(x * 8)).i16(Math.round(y * 8)).i16(Math.round(z * 8)).u8(yawByte(yaw));
		return this.record(TT_EXT_TAGS.move, dt, b);
	}
	gone(entity: number, dt = 0): this {
		return this.record(TT_EXT_TAGS.gone, dt, new Bytes().u8(entity));
	}
	animPlay(entity: number, track: number, anim: number, speed: number, weight: number, looped: boolean, time: number, dt = 0): this {
		return this.record(TT_EXT_TAGS.animPlay, dt, new Bytes().u8(entity).u16(track).u16(anim).i16(Math.round(speed * 100)).u8(unitByte(weight)).u8(looped ? 1 : 0).u16(Math.round(time * 100)));
	}
	animStop(entity: number, track: number, dt = 0): this {
		return this.record(TT_EXT_TAGS.animStop, dt, new Bytes().u8(entity).u16(track));
	}
	animAdjust(entity: number, track: number, speed: number, weight: number, dt = 0): this {
		return this.record(TT_EXT_TAGS.animAdjust, dt, new Bytes().u8(entity).u16(track).i16(Math.round(speed * 100)).u8(unitByte(weight)));
	}
	uiNode(id: number, parent: number, cls: number, fields: UiFieldsIn, dt = 0): this {
		const values = new Bytes();
		const mask = uiFields(values, fields);
		return this.record(TT_EXT_TAGS.uiNode, dt, new Bytes().u16(id).u16(parent).u8(cls).u16(mask).raw(values.toArray()));
	}
	uiProps(id: number, fields: UiFieldsIn, dt = 0): this {
		const values = new Bytes();
		const mask = uiFields(values, fields);
		return this.record(TT_EXT_TAGS.uiProps, dt, new Bytes().u16(id).u16(mask).raw(values.toArray()));
	}
	uiGone(id: number, dt = 0): this {
		return this.record(TT_EXT_TAGS.uiGone, dt, new Bytes().u16(id));
	}
	get count(): number {
		return this.records;
	}
	finish(): Uint8Array {
		const head = new Bytes().u8(1).u8((this.flags.last ? 1 : 0) | (this.flags.keyframe ? 2 : 0)).u16(0);
		return Uint8Array.from([...head.toArray(), ...this.body.toArray()]);
	}
	/** As a recordings row (tt-ext-1). */
	row(chunk: number, t: number, ids: { sid?: string; pid?: string } = {}): ChunkRow & { t: number } {
		return { sid: ids.sid ?? "s1", pid: ids.pid ?? "p1", chunk, codec: "tt-ext-1", data: Buffer.from(this.finish()).toString("base64"), n: this.records, t };
	}
}
