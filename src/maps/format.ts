/**
 * Map geometry's binary formats (plans/33). All numbers little-endian.
 *
 * The export task's output (`TTMX`, what the Luau script returns as its BinaryOutput):
 *   magic "TTMX" (4) | version u16 (1) | entries u16
 *   per entry:
 *     kind u8 (0 map candidate, 1 lobby) | via u8 (0 matched by name, 1 manual override, 2 lobby)
 *     name: len u8 + UTF-8 (the instance's Name) | want: len u8 + UTF-8 (the map name it was matched for; "" for the lobby)
 *     path: len u16 + UTF-8 (GetFullName, e.g. "ReplicatedStorage.assets.maps.Mall")
 *     parts u32 | parts x RECORD_BYTES records
 *
 * One stored map (`TTMP`, what GET /v1/maps/<name>/geometry serves):
 *   magic "TTMP" (4) | version u16 (1) | record size u16 (48) | parts u32 | reserved u32 (0)   = 16 bytes
 *   parts x RECORD_BYTES records
 *
 * A part record (48 bytes):
 *    0 position x, y, z      f32 x3  (studs, world space; the CFrame's position)
 *   12 rotation qx, qy, qz, qw f32 x4 (unit quaternion of the CFrame's rotation; three.js order)
 *   28 size x, y, z          f32 x3  (studs; a MeshPart / union: its bounding size)
 *   40 color r, g, b         u8 x3
 *   43 transparency          u8      (round(Transparency * 255))
 *   44 material              u16     (Enum.Material value)
 *   46 shape                 u8      (0 ball, 1 block, 2 cylinder (axis = the part's X), 3 wedge, 4 corner wedge)
 *   47 flags                 u8      (FLAGS: mesh, union, invisible (Transparency >= 0.95), collide, truss)
 */

export const EXPORT_MAGIC = "TTMX";
export const MAP_MAGIC = "TTMP";
export const FORMAT_VERSION = 1;
export const RECORD_BYTES = 48;
export const MAP_HEADER_BYTES = 16;
export const SHAPES = ["ball", "block", "cylinder", "wedge", "cornerWedge"] as const;
export type Shape = (typeof SHAPES)[number];
export const FLAGS = { mesh: 1, union: 2, invisible: 4, collide: 8, truss: 16 } as const;
/** Transparency at or above this counts as invisible (flagged, never dropped: invisible walls shape where players walk). */
export const INVISIBLE_AT = 0.95;

export class MapFormatError extends Error {
	override name = "MapFormatError";
}

export interface ExportEntry {
	kind: "map" | "lobby";
	via: "name" | "override" | "lobby";
	/** The instance's Name. */
	name: string;
	/** The map name (from the events) it was found for; "" for the lobby. */
	want: string;
	path: string;
	parts: number;
	/** The entry's records (parts x RECORD_BYTES), a view into the task output. */
	records: Uint8Array;
}

const KINDS = ["map", "lobby"] as const;
const VIAS = ["name", "override", "lobby"] as const;

/** Reads the export task's output. Throws MapFormatError on anything malformed (never reads past the end). */
export function parseExport(bytes: Uint8Array): ExportEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let at = 0;
	const need = (n: number) => {
		if (at + n > bytes.byteLength) throw new MapFormatError(`export output cut short at byte ${at} (needs ${n} more of ${bytes.byteLength})`);
	};
	const text = (len: number) => {
		need(len);
		const s = decoder.decode(bytes.subarray(at, at + len));
		at += len;
		return s;
	};
	need(8);
	if (text(4) !== EXPORT_MAGIC) throw new MapFormatError("not a map export (no TTMX magic)");
	const version = view.getUint16(at, true);
	if (version !== FORMAT_VERSION) throw new MapFormatError(`map export version ${version} (this backend reads ${FORMAT_VERSION})`);
	const count = view.getUint16(at + 2, true);
	at += 4;
	const out: ExportEntry[] = [];
	for (let i = 0; i < count; i++) {
		need(3);
		const kind = KINDS[view.getUint8(at)];
		const via = VIAS[view.getUint8(at + 1)];
		if (!kind || !via) throw new MapFormatError(`entry ${i}: unknown kind or via`);
		const nameLen = view.getUint8(at + 2);
		at += 3;
		const name = text(nameLen);
		need(1);
		const wantLen = view.getUint8(at);
		at += 1;
		const want = text(wantLen);
		need(2);
		const pathLen = view.getUint16(at, true);
		at += 2;
		const path = text(pathLen);
		need(4);
		const parts = view.getUint32(at, true);
		at += 4;
		need(parts * RECORD_BYTES);
		out.push({ kind, via, name, want, path, parts, records: bytes.subarray(at, at + parts * RECORD_BYTES) });
		at += parts * RECORD_BYTES;
	}
	if (at !== bytes.byteLength) throw new MapFormatError(`${bytes.byteLength - at} bytes after the last entry`);
	return out;
}

/** One stored map: the TTMP header plus the records. */
export function mapBlob(records: Uint8Array): Uint8Array {
	if (records.byteLength % RECORD_BYTES !== 0) throw new MapFormatError("records are not a whole number of parts");
	const out = new Uint8Array(MAP_HEADER_BYTES + records.byteLength);
	const view = new DataView(out.buffer);
	out.set(new TextEncoder().encode(MAP_MAGIC), 0);
	view.setUint16(4, FORMAT_VERSION, true);
	view.setUint16(6, RECORD_BYTES, true);
	view.setUint32(8, records.byteLength / RECORD_BYTES, true);
	view.setUint32(12, 0, true);
	out.set(records, MAP_HEADER_BYTES);
	return out;
}

/** A stored map's records (checks the header). */
export function mapRecords(blob: Uint8Array): { parts: number; records: Uint8Array } {
	if (blob.byteLength < MAP_HEADER_BYTES || new TextDecoder().decode(blob.subarray(0, 4)) !== MAP_MAGIC) throw new MapFormatError("not a stored map (no TTMP magic)");
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const version = view.getUint16(4, true);
	const size = view.getUint16(6, true);
	if (version !== FORMAT_VERSION || size !== RECORD_BYTES) throw new MapFormatError(`stored map version ${version}, record size ${size}`);
	const parts = view.getUint32(8, true);
	if (blob.byteLength !== MAP_HEADER_BYTES + parts * RECORD_BYTES) throw new MapFormatError("stored map length doesn't match its part count");
	return { parts, records: blob.subarray(MAP_HEADER_BYTES) };
}

export interface Part {
	position: [number, number, number];
	rotation: [number, number, number, number];
	size: [number, number, number];
	color: [number, number, number];
	transparency: number;
	material: number;
	shape: Shape;
	flags: number;
}

export function readPart(records: Uint8Array, index: number): Part {
	const view = new DataView(records.buffer, records.byteOffset + index * RECORD_BYTES, RECORD_BYTES);
	const f = (o: number) => view.getFloat32(o, true);
	return {
		position: [f(0), f(4), f(8)],
		rotation: [f(12), f(16), f(20), f(24)],
		size: [f(28), f(32), f(36)],
		color: [view.getUint8(40), view.getUint8(41), view.getUint8(42)],
		transparency: view.getUint8(43) / 255,
		material: view.getUint16(44, true),
		shape: SHAPES[view.getUint8(46)] ?? "block",
		flags: view.getUint8(47),
	};
}

export type Vec3 = [number, number, number];
export interface Bounds {
	min: Vec3;
	max: Vec3;
}

export interface MapSummary {
	parts: number;
	meshes: number;
	unions: number;
	invisible: number;
	/** World-space box around every part (rotation included); null with no parts. */
	bounds: Bounds | null;
}

/** Part counts by flag and the world-space bounding box (each part's rotated box). Non-finite parts are skipped. */
export function summarize(records: Uint8Array): MapSummary {
	const parts = Math.floor(records.byteLength / RECORD_BYTES);
	const min: Vec3 = [Infinity, Infinity, Infinity];
	const max: Vec3 = [-Infinity, -Infinity, -Infinity];
	let meshes = 0;
	let unions = 0;
	let invisible = 0;
	for (let i = 0; i < parts; i++) {
		const p = readPart(records, i);
		if (p.flags & FLAGS.mesh) meshes++;
		if (p.flags & FLAGS.union) unions++;
		if (p.flags & FLAGS.invisible) invisible++;
		const half = halfExtents(p.rotation, p.size);
		for (let a = 0; a < 3; a++) {
			const c = p.position[a] as number;
			const h = half[a] as number;
			if (!Number.isFinite(c) || !Number.isFinite(h)) continue;
			min[a] = Math.min(min[a] as number, c - h);
			max[a] = Math.max(max[a] as number, c + h);
		}
	}
	const bounds = min.every(Number.isFinite) && max.every(Number.isFinite) ? { min: min.map(r2) as Vec3, max: max.map(r2) as Vec3 } : null;
	return { parts, meshes, unions, invisible, bounds };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The world-axis half extents of a box of `size` turned by the quaternion: |R| * size / 2. */
export function halfExtents(q: [number, number, number, number], size: Vec3): Vec3 {
	const [x, y, z, w] = q;
	const m = [
		[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
		[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
		[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
	];
	const h = size.map((s) => Math.abs(s) / 2) as Vec3;
	return [0, 1, 2].map((r) => {
		const row = m[r] as number[];
		return Math.abs(row[0] as number) * h[0] + Math.abs(row[1] as number) * h[1] + Math.abs(row[2] as number) * h[2];
	}) as Vec3;
}
