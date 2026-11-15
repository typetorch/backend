/**
 * Map geometry's binary formats (plans/33). All numbers little-endian.
 *
 * The export task's output (`TTMX`, what the Luau script returns as its BinaryOutput):
 *   magic "TTMX" (4) | version u16 (1 or 2) | entries u16
 *   per entry:
 *     kind u8 (0 map candidate, 1 lobby) | via u8 (0 matched by name, 1 manual override, 2 lobby)
 *     name: len u8 + UTF-8 (the instance's Name) | want: len u8 + UTF-8 (the map name it was matched for; "" for the lobby)
 *     path: len u16 + UTF-8 (GetFullName, e.g. "ReplicatedStorage.assets.maps.Mall")
 *     parts u32 | parts x RECORD_BYTES records
 *     version 2 only: textures u32 (bytes) | the entry's texture section (below; part indices are the entry's)
 *
 * One stored map (`TTMP`, what GET /v1/maps/<name>/geometry serves):
 *   magic "TTMP" (4) | version u16 (1 or 2) | record size u16 (48) | parts u32 | textures u32   = 16 bytes
 *   parts x RECORD_BYTES records
 *   version 2 only: the texture section (`textures` bytes; version 1 has 0 there and nothing after the records)
 * A map without textures is stored as version 1 (byte for byte what it was before textures). The route serves version 1
 * (the records only) unless the explorer asks for `?v=2`, so an explorer from before textures keeps working.
 *
 * The texture section (plans/36 phase 5; image ids only, the pixels come from the images route):
 *   strings u16, each len u16 + UTF-8 (Content strings as the place has them: "rbxassetid://123", "http://www.roblox.com/asset/?id=123")
 *   variants u16, each VARIANT_BYTES: name u16 (string) | color map u16 (string; 65535 = none) | base material u16
 *     (Enum.Material value) | flags u8 (bit 0: MaterialService's override for its base material) | 0 u8 | studs per tile f32
 *   surfaces u32, each SURFACE_BYTES: part u32 | kind u8 (0 Decal, 1 Texture) | face u8 (Enum.NormalId value: 0 Right,
 *     1 Top, 2 Back, 3 Left, 4 Bottom, 5 Front) | image u16 (string) | color r, g, b u8 (Color3, clamped) | transparency u8
 *     | studs per tile U, V f32 | offset studs U, V f32 (a Decal: 0) | ZIndex i16 | 0 u16
 *   variant parts u32, each VARIANT_PART_BYTES: part u32 | variant u16 (the part's MaterialVariant, or its material's
 *     override when it names none)
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
/** Version 1: parts only. */
export const FORMAT_VERSION = 1;
/** Version 2: parts and the texture section (the export task writes 2; stored maps without textures stay 1). */
export const FORMAT_VERSION_TEXTURES = 2;
export const SURFACE_BYTES = 32;
export const VARIANT_BYTES = 12;
export const VARIANT_PART_BYTES = 6;
/** No string (a variant without a color map). */
export const NO_STRING = 0xffff;
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
	/** The entry's texture section (version 2; empty for version 1 or a map without textures). */
	textures: Uint8Array;
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
	if (version !== FORMAT_VERSION && version !== FORMAT_VERSION_TEXTURES) throw new MapFormatError(`map export version ${version} (this backend reads ${FORMAT_VERSION} and ${FORMAT_VERSION_TEXTURES})`);
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
		const records = bytes.subarray(at, at + parts * RECORD_BYTES);
		at += parts * RECORD_BYTES;
		let textures: Uint8Array = new Uint8Array(0);
		if (version === FORMAT_VERSION_TEXTURES) {
			need(4);
			const length = view.getUint32(at, true);
			at += 4;
			need(length);
			textures = bytes.subarray(at, at + length);
			at += length;
			if (length) parseTextures(textures, parts);
		}
		out.push({ kind, via, name, want, path, parts, records, textures });
	}
	if (at !== bytes.byteLength) throw new MapFormatError(`${bytes.byteLength - at} bytes after the last entry`);
	return out;
}

/** One stored map: the TTMP header plus the records (version 1), and the texture section after them when there is one (version 2). */
export function mapBlob(records: Uint8Array, textures: Uint8Array = new Uint8Array(0)): Uint8Array {
	if (records.byteLength % RECORD_BYTES !== 0) throw new MapFormatError("records are not a whole number of parts");
	const out = new Uint8Array(MAP_HEADER_BYTES + records.byteLength + textures.byteLength);
	const view = new DataView(out.buffer);
	out.set(new TextEncoder().encode(MAP_MAGIC), 0);
	view.setUint16(4, textures.byteLength ? FORMAT_VERSION_TEXTURES : FORMAT_VERSION, true);
	view.setUint16(6, RECORD_BYTES, true);
	view.setUint32(8, records.byteLength / RECORD_BYTES, true);
	view.setUint32(12, textures.byteLength, true);
	out.set(records, MAP_HEADER_BYTES);
	out.set(textures, MAP_HEADER_BYTES + records.byteLength);
	return out;
}

/** A stored map's records and texture section (checks the header; version 1 or 2). */
export function mapRecords(blob: Uint8Array): { parts: number; version: number; records: Uint8Array; textures: Uint8Array } {
	if (blob.byteLength < MAP_HEADER_BYTES || new TextDecoder().decode(blob.subarray(0, 4)) !== MAP_MAGIC) throw new MapFormatError("not a stored map (no TTMP magic)");
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const version = view.getUint16(4, true);
	const size = view.getUint16(6, true);
	if ((version !== FORMAT_VERSION && version !== FORMAT_VERSION_TEXTURES) || size !== RECORD_BYTES) throw new MapFormatError(`stored map version ${version}, record size ${size}`);
	const parts = view.getUint32(8, true);
	const extra = version === FORMAT_VERSION ? 0 : view.getUint32(12, true);
	if (blob.byteLength !== MAP_HEADER_BYTES + parts * RECORD_BYTES + extra) throw new MapFormatError("stored map length doesn't match its part count");
	const end = MAP_HEADER_BYTES + parts * RECORD_BYTES;
	return { parts, version, records: blob.subarray(MAP_HEADER_BYTES, end), textures: blob.subarray(end) };
}

/** A stored map as version 1 (the records only), for an explorer from before textures. A version 1 blob comes back as is. */
export function mapBlobV1(blob: Uint8Array): Uint8Array {
	const { version, records } = mapRecords(blob);
	return version === FORMAT_VERSION ? blob : mapBlob(records);
}

export interface Surface {
	part: number;
	kind: "decal" | "texture";
	/** Enum.NormalId value: 0 Right (+X), 1 Top (+Y), 2 Back (+Z), 3 Left (-X), 4 Bottom (-Y), 5 Front (-Z). */
	face: number;
	image: string;
	color: [number, number, number];
	transparency: number;
	studsPerTile: [number, number];
	offset: [number, number];
	zIndex: number;
}

export interface Variant {
	name: string;
	colorMap: string | null;
	baseMaterial: number;
	override: boolean;
	studsPerTile: number;
}

export interface Textures {
	strings: string[];
	variants: Variant[];
	surfaces: Surface[];
	/** Part index -> variant index. */
	variantParts: Map<number, number>;
}

export const SURFACE_KINDS = ["decal", "texture"] as const;

/** Reads a texture section (throws MapFormatError on anything malformed or out of range; `parts` bounds the part indices). */
export function parseTextures(bytes: Uint8Array, parts: number): Textures {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let at = 0;
	const need = (n: number) => {
		if (at + n > bytes.byteLength) throw new MapFormatError(`texture section cut short at byte ${at}`);
	};
	need(2);
	const stringCount = view.getUint16(at, true);
	at += 2;
	const strings: string[] = [];
	for (let i = 0; i < stringCount; i++) {
		need(2);
		const len = view.getUint16(at, true);
		at += 2;
		need(len);
		strings.push(decoder.decode(bytes.subarray(at, at + len)));
		at += len;
	}
	const str = (i: number) => {
		const s = strings[i];
		if (s === undefined) throw new MapFormatError(`texture section: string ${i} out of range`);
		return s;
	};
	need(2);
	const variantCount = view.getUint16(at, true);
	at += 2;
	need(variantCount * VARIANT_BYTES);
	const variants: Variant[] = [];
	for (let i = 0; i < variantCount; i++, at += VARIANT_BYTES) {
		const map = view.getUint16(at + 2, true);
		variants.push({ name: str(view.getUint16(at, true)), colorMap: map === NO_STRING ? null : str(map), baseMaterial: view.getUint16(at + 4, true), override: (view.getUint8(at + 6) & 1) !== 0, studsPerTile: view.getFloat32(at + 8, true) });
	}
	need(4);
	const surfaceCount = view.getUint32(at, true);
	at += 4;
	need(surfaceCount * SURFACE_BYTES);
	const surfaces: Surface[] = [];
	for (let i = 0; i < surfaceCount; i++, at += SURFACE_BYTES) {
		const part = view.getUint32(at, true);
		if (part >= parts) throw new MapFormatError(`texture section: surface on part ${part} of ${parts}`);
		const kind = SURFACE_KINDS[view.getUint8(at + 4)];
		const face = view.getUint8(at + 5);
		if (!kind || face > 5) throw new MapFormatError(`texture section: surface ${i} has an unknown kind or face`);
		surfaces.push({
			part,
			kind,
			face,
			image: str(view.getUint16(at + 6, true)),
			color: [view.getUint8(at + 8), view.getUint8(at + 9), view.getUint8(at + 10)],
			transparency: view.getUint8(at + 11) / 255,
			studsPerTile: [view.getFloat32(at + 12, true), view.getFloat32(at + 16, true)],
			offset: [view.getFloat32(at + 20, true), view.getFloat32(at + 24, true)],
			zIndex: view.getInt16(at + 28, true),
		});
	}
	need(4);
	const variantPartCount = view.getUint32(at, true);
	at += 4;
	need(variantPartCount * VARIANT_PART_BYTES);
	const variantParts = new Map<number, number>();
	for (let i = 0; i < variantPartCount; i++, at += VARIANT_PART_BYTES) {
		const part = view.getUint32(at, true);
		const variant = view.getUint16(at + 4, true);
		if (part >= parts || variant >= variantCount) throw new MapFormatError(`texture section: variant ${variant} on part ${part} out of range`);
		variantParts.set(part, variant);
	}
	if (at !== bytes.byteLength) throw new MapFormatError(`texture section: ${bytes.byteLength - at} bytes after its end`);
	return { strings, variants, surfaces, variantParts };
}

/** Every image Content string a texture section names (its surfaces' images and its variants' color maps). */
export function textureImages(textures: Textures): string[] {
	const out = new Set<string>();
	for (const s of textures.surfaces) out.add(s.image);
	for (const v of textures.variants) if (v.colorMap) out.add(v.colorMap);
	return [...out];
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
