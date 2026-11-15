/**
 * Writers for the export tasks' binary layouts, the way the Luau scripts lay them out (src/maps/script.ts texture
 * sections, src/anims/script.ts TTAN), for the tests. Every id and value is made up.
 */
import { NO_STRING, SURFACE_KINDS } from "../src/maps/format.ts";

class Bytes {
	readonly out: number[] = [];
	u8(v: number) {
		this.out.push(v & 0xff);
	}
	u16(v: number) {
		this.u8(v);
		this.u8(v >> 8);
	}
	i16(v: number) {
		this.u16(v < 0 ? v + 0x10000 : v);
	}
	u32(v: number) {
		this.u16(v & 0xffff);
		this.u16(v >>> 16);
	}
	f32(v: number) {
		for (const x of new Uint8Array(new Float32Array([v]).buffer)) this.u8(x);
	}
	raw(bytes: Uint8Array) {
		for (const b of bytes) this.u8(b);
	}
	str8(s: string) {
		const b = new TextEncoder().encode(s);
		this.u8(b.length);
		this.raw(b);
	}
	str16(s: string) {
		const b = new TextEncoder().encode(s);
		this.u16(b.length);
		this.raw(b);
	}
	bytes(): Uint8Array {
		return new Uint8Array(this.out);
	}
}

export interface TestSurface {
	part: number;
	kind?: (typeof SURFACE_KINDS)[number];
	face?: number;
	image: string;
	color?: [number, number, number];
	transparency?: number;
	tile?: [number, number, number, number];
	zIndex?: number;
}
export interface TestVariant {
	name: string;
	colorMap?: string;
	baseMaterial?: number;
	override?: boolean;
	studsPerTile?: number;
}

/** A texture section (src/maps/format.ts). */
export function writeTextures(input: { surfaces?: TestSurface[]; variants?: TestVariant[]; variantParts?: [number, number][] }): Uint8Array {
	const strings: string[] = [];
	const at = (s: string) => {
		let i = strings.indexOf(s);
		if (i < 0) i = strings.push(s) - 1;
		return i;
	};
	const variants = (input.variants ?? []).map((v) => ({ ...v, nameAt: at(v.name), mapAt: v.colorMap ? at(v.colorMap) : NO_STRING }));
	const surfaces = (input.surfaces ?? []).map((s) => ({ ...s, imageAt: at(s.image) }));
	const w = new Bytes();
	w.u16(strings.length);
	for (const s of strings) w.str16(s);
	w.u16(variants.length);
	for (const v of variants) {
		w.u16(v.nameAt);
		w.u16(v.mapAt);
		w.u16(v.baseMaterial ?? 256);
		w.u8(v.override ? 1 : 0);
		w.u8(0);
		w.f32(v.studsPerTile ?? 4);
	}
	w.u32(surfaces.length);
	for (const s of surfaces) {
		w.u32(s.part);
		w.u8(SURFACE_KINDS.indexOf(s.kind ?? "decal"));
		w.u8(s.face ?? 5);
		w.u16(s.imageAt);
		for (const c of s.color ?? [255, 255, 255]) w.u8(c);
		w.u8(Math.round((s.transparency ?? 0) * 255));
		for (const v of s.tile ?? [0, 0, 0, 0]) w.f32(v);
		w.i16(s.zIndex ?? 1);
		w.u16(0);
	}
	const vp = input.variantParts ?? [];
	w.u32(vp.length);
	for (const [part, variant] of vp) {
		w.u32(part);
		w.u16(variant);
	}
	return w.bytes();
}

export interface TestClip {
	id: string;
	status?: "ok" | "failed" | "skipped";
	error?: string;
	loop?: boolean;
	priority?: number;
	keyframes?: { t: number; poses: { name: string; q?: [number, number, number, number]; pos?: [number, number, number]; style?: number; direction?: number; weight?: number }[] }[];
}

/** An animation export's output (src/anims/format.ts TTAN). */
export function writeAnimExport(clips: TestClip[]): Uint8Array {
	const w = new Bytes();
	w.raw(new TextEncoder().encode("TTAN"));
	w.u16(1);
	w.u16(clips.length);
	for (const c of clips) {
		w.str8(c.id);
		if (c.status === "failed") {
			w.u8(1);
			w.str16(c.error ?? "boom");
			continue;
		}
		if (c.status === "skipped") {
			w.u8(2);
			continue;
		}
		w.u8(0);
		w.u8(c.loop ? 1 : 0);
		w.u16(c.priority ?? 1);
		const names: string[] = [];
		for (const k of c.keyframes ?? []) for (const p of k.poses) if (!names.includes(p.name)) names.push(p.name);
		w.u16(names.length);
		for (const n of names) w.str8(n);
		w.u16((c.keyframes ?? []).length);
		for (const k of c.keyframes ?? []) {
			w.f32(k.t);
			w.u16(k.poses.length);
			for (const p of k.poses) {
				w.u16(names.indexOf(p.name));
				for (const v of p.q ?? [0, 0, 0, 1]) w.f32(v);
				for (const v of p.pos ?? [0, 0, 0]) w.f32(v);
				w.u8(p.style ?? 0);
				w.u8(p.direction ?? 0);
				w.f32(p.weight ?? 1);
			}
		}
	}
	return w.bytes();
}
