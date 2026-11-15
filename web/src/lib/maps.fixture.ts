/** A stored map (TTMP) writer for the tests: the backend's layout (src/maps/format.ts). */
import { FLAGS, RECORD_BYTES } from "./maps";

interface P {
	pos: [number, number, number];
	size: [number, number, number];
	q?: [number, number, number, number];
	flags?: number;
	shape?: number;
	t?: number;
}

/** Version 1, or 2 with `textures` (a texture section, `textureSection` below) after the records. */
export function ttmp(parts: P[], textures?: Uint8Array): Uint8Array {
	const out = new Uint8Array(16 + parts.length * RECORD_BYTES + (textures?.byteLength ?? 0));
	const v = new DataView(out.buffer);
	out.set([84, 84, 77, 80]);
	v.setUint16(4, textures ? 2 : 1, true);
	v.setUint16(6, RECORD_BYTES, true);
	v.setUint32(8, parts.length, true);
	v.setUint32(12, textures?.byteLength ?? 0, true);
	if (textures) out.set(textures, 16 + parts.length * RECORD_BYTES);
	parts.forEach((p, i) => {
		const o = 16 + i * RECORD_BYTES;
		p.pos.forEach((x, a) => v.setFloat32(o + a * 4, x, true));
		(p.q ?? [0, 0, 0, 1]).forEach((x, a) => v.setFloat32(o + 12 + a * 4, x, true));
		p.size.forEach((x, a) => v.setFloat32(o + 28 + a * 4, x, true));
		out.set([10, 20, 30, Math.round((p.t ?? 0) * 255)], o + 40);
		v.setUint16(o + 44, 256, true);
		v.setUint8(o + 46, p.shape ?? 1);
		v.setUint8(o + 47, p.flags ?? FLAGS.collide);
	});
	return out;
}

export interface FixtureSurface {
	part: number;
	kind?: 0 | 1;
	face?: number;
	image: string;
	color?: [number, number, number];
	transparency?: number;
	tile?: [number, number, number, number];
	zIndex?: number;
}

/** A texture section (backend src/maps/format.ts): strings, variants, surfaces, variant parts. */
export function textureSection(input: { surfaces?: FixtureSurface[]; variants?: { name: string; colorMap?: string; studsPerTile?: number; baseMaterial?: number }[]; variantParts?: [number, number][] }): Uint8Array {
	const strings: string[] = [];
	const at = (s: string) => {
		let i = strings.indexOf(s);
		if (i < 0) i = strings.push(s) - 1;
		return i;
	};
	const variants = (input.variants ?? []).map((x) => ({ ...x, n: at(x.name), m: x.colorMap ? at(x.colorMap) : 0xffff }));
	const surfaces = (input.surfaces ?? []).map((x) => ({ ...x, i: at(x.image) }));
	const bytes: number[] = [];
	const push = (n: number, write: (v: DataView) => void) => {
		const b = new Uint8Array(n);
		write(new DataView(b.buffer));
		bytes.push(...b);
	};
	const enc = new TextEncoder();
	push(2, (v) => v.setUint16(0, strings.length, true));
	for (const s of strings) {
		const e = enc.encode(s);
		push(2, (v) => v.setUint16(0, e.length, true));
		bytes.push(...e);
	}
	push(2, (v) => v.setUint16(0, variants.length, true));
	for (const x of variants)
		push(12, (v) => {
			v.setUint16(0, x.n, true);
			v.setUint16(2, x.m, true);
			v.setUint16(4, x.baseMaterial ?? 816, true);
			v.setFloat32(8, x.studsPerTile ?? 4, true);
		});
	push(4, (v) => v.setUint32(0, surfaces.length, true));
	for (const x of surfaces)
		push(32, (v) => {
			v.setUint32(0, x.part, true);
			v.setUint8(4, x.kind ?? 0);
			v.setUint8(5, x.face ?? 5);
			v.setUint16(6, x.i, true);
			(x.color ?? [255, 255, 255]).forEach((c, k) => v.setUint8(8 + k, c));
			v.setUint8(11, Math.round((x.transparency ?? 0) * 255));
			(x.tile ?? [0, 0, 0, 0]).forEach((t, k) => v.setFloat32(12 + k * 4, t, true));
			v.setInt16(28, x.zIndex ?? 1, true);
		});
	const vp = input.variantParts ?? [];
	push(4, (v) => v.setUint32(0, vp.length, true));
	for (const [part, variant] of vp)
		push(6, (v) => {
			v.setUint32(0, part, true);
			v.setUint16(4, variant, true);
		});
	return new Uint8Array(bytes);
}
