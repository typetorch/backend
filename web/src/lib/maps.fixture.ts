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

export function ttmp(parts: P[]): Uint8Array {
	const out = new Uint8Array(16 + parts.length * RECORD_BYTES);
	const v = new DataView(out.buffer);
	out.set([84, 84, 77, 80]);
	v.setUint16(4, 1, true);
	v.setUint16(6, RECORD_BYTES, true);
	v.setUint32(8, parts.length, true);
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
