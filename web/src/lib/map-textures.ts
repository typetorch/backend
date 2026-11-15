/**
 * Textures on the exported maps (plans/36 phase 5): pure data for the renderer, no three.js.
 *
 *   - Decals and Textures: one quad per surface on its part's face (a Texture tiled by StudsPerTileU / V and its offsets),
 *     grouped by image so a map with 1000+ parts draws one instanced mesh per distinct image.
 *   - MaterialVariants: the parts using one are drawn with its ColorMap tiled every StudsPerTile studs (renderer).
 *   - Built-in materials: a light procedural pattern per material in the parts' shader (MATERIAL_LOOK_GLSL).
 *   - The pixels: GET /api/v1/images/<id> (the backend's thumbnails store): 200 an image, 202 still resolving (asked
 *     again with a backoff), 404 none (the plain colour stays).
 *
 * Faces follow Enum.NormalId: 0 Right (+X), 1 Top (+Y), 2 Back (+Z), 3 Left (-X), 4 Bottom (-Y), 5 Front (-Z). A face's
 * image is drawn as seen from outside, upright for the side faces; on Top and Bottom its top points to the part's front
 * (-Z). Not checked against Studio.
 */
import { FLAGS, isDrawn, type DrawToggles, type MapGeometry } from "./maps";

// Asset ids -------------------------------------------------------------------------------------------------------------

const ASSET_ID = /^[1-9][0-9]{0,19}$/;

/** The asset id in a Content string (`rbxassetid://123`, `123`, `http(s)://www.roblox.com/asset/?id=123`), else null. Same as the backend's. */
export function assetIdOf(content: string): string | null {
	const s = content.trim();
	if (!s || s.length > 2048) return null;
	if (ASSET_ID.test(s)) return s;
	const clean = (id: string | null | undefined) => {
		const digits = (id ?? "").replace(/^0+/, "");
		return ASSET_ID.test(digits) ? digits : null;
	};
	let m = /^rbxassetid:\/\/([0-9]+)\/?(?:[?#].*)?$/i.exec(s);
	if (m) return clean(m[1]);
	m = /^rbxthumb:\/\/(.*)$/i.exec(s);
	if (m) {
		const params = new URLSearchParams(m[1]);
		return /^asset$/i.test(params.get("type") ?? "") ? clean(params.get("id")) : null;
	}
	if (!/^https?:\/\//i.test(s)) return null;
	try {
		const url = new URL(s);
		const host = url.hostname.toLowerCase();
		if ((host !== "roblox.com" && !host.endsWith(".roblox.com")) || !/^\/asset\/?$/i.test(url.pathname)) return null;
		for (const [k, v] of url.searchParams) if (k.toLowerCase() === "id") return clean(v);
	} catch {
		// not a URL
	}
	return null;
}

// The decoded section ---------------------------------------------------------------------------------------------------

export interface MapSurface {
	part: number;
	/** 0 Decal, 1 Texture. */
	kind: 0 | 1;
	face: number;
	/** The image's asset id. */
	image: string;
	color: [number, number, number];
	/** 0..1. */
	transparency: number;
	/** StudsPerTileU, StudsPerTileV, OffsetStudsU, OffsetStudsV (a Decal: zeros). */
	tile: [number, number, number, number];
	zIndex: number;
}

export interface MapVariant {
	name: string;
	/** The ColorMap's asset id (null: none, the part keeps its plain colour). */
	image: string | null;
	studsPerTile: number;
	baseMaterial: number;
}

export interface MapTextures {
	surfaces: MapSurface[];
	variants: MapVariant[];
	/** Per part: its variant's index, -1 for none. */
	variantOf: Int32Array;
}

const SURFACE_BYTES = 32;
const VARIANT_BYTES = 12;
const NO_STRING = 0xffff;

/** Reads a texture section (backend src/maps/format.ts). Throws on anything malformed; surfaces without an asset id are left out. */
export function decodeTextures(bytes: Uint8Array, parts: number): MapTextures {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let at = 0;
	const need = (n: number) => {
		if (at + n > bytes.byteLength) throw new Error("map textures are cut short");
	};
	need(2);
	const strings: string[] = [];
	const stringCount = view.getUint16(at, true);
	at += 2;
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
		if (s === undefined) throw new Error("map textures: a string out of range");
		return s;
	};
	need(2);
	const variantCount = view.getUint16(at, true);
	at += 2;
	need(variantCount * VARIANT_BYTES);
	const variants: MapVariant[] = [];
	for (let i = 0; i < variantCount; i++, at += VARIANT_BYTES) {
		const map = view.getUint16(at + 2, true);
		variants.push({ name: str(view.getUint16(at, true)), image: map === NO_STRING ? null : assetIdOf(str(map)), baseMaterial: view.getUint16(at + 4, true), studsPerTile: view.getFloat32(at + 8, true) });
	}
	need(4);
	const surfaceCount = view.getUint32(at, true);
	at += 4;
	need(surfaceCount * SURFACE_BYTES);
	const surfaces: MapSurface[] = [];
	for (let i = 0; i < surfaceCount; i++, at += SURFACE_BYTES) {
		const part = view.getUint32(at, true);
		const kind = view.getUint8(at + 4);
		const face = view.getUint8(at + 5);
		if (part >= parts || kind > 1 || face > 5) throw new Error("map textures: a surface out of range");
		const image = assetIdOf(str(view.getUint16(at + 6, true)));
		if (!image) continue;
		surfaces.push({
			part,
			kind: kind as 0 | 1,
			face,
			image,
			color: [view.getUint8(at + 8), view.getUint8(at + 9), view.getUint8(at + 10)],
			transparency: view.getUint8(at + 11) / 255,
			tile: [view.getFloat32(at + 12, true), view.getFloat32(at + 16, true), view.getFloat32(at + 20, true), view.getFloat32(at + 24, true)],
			zIndex: view.getInt16(at + 28, true),
		});
	}
	need(4);
	const variantParts = view.getUint32(at, true);
	at += 4;
	need(variantParts * 6);
	const variantOf = new Int32Array(parts).fill(-1);
	for (let i = 0; i < variantParts; i++, at += 6) {
		const part = view.getUint32(at, true);
		const variant = view.getUint16(at + 4, true);
		if (part >= parts || variant >= variantCount) throw new Error("map textures: a variant out of range");
		variantOf[part] = variant;
	}
	if (at !== bytes.byteLength) throw new Error("map textures: bytes after the end");
	return { surfaces, variants, variantOf };
}

// Faces -----------------------------------------------------------------------------------------------------------------

type V3 = [number, number, number];

/**
 * A face in the part's unit box: its centre, and its full extent along the image's u (left to right) and v (bottom to
 * top), so u x v points out of the part. The wedge's Top is its slope.
 */
interface FaceFrame {
	c: V3;
	u: V3;
	v: V3;
}

const BOX_FACES: FaceFrame[] = [
	{ c: [0.5, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // Right
	{ c: [0, 0.5, 0], u: [1, 0, 0], v: [0, 0, -1] }, // Top
	{ c: [0, 0, 0.5], u: [1, 0, 0], v: [0, 1, 0] }, // Back
	{ c: [-0.5, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // Left
	{ c: [0, -0.5, 0], u: [-1, 0, 0], v: [0, 0, -1] }, // Bottom
	{ c: [0, 0, -0.5], u: [-1, 0, 0], v: [0, 1, 0] }, // Front
];
const WEDGE_SLOPE: FaceFrame = { c: [0, 0, 0], u: [1, 0, 0], v: [0, -1, -1] };

/** The face a surface is drawn on, for the part's shape (0 ball, 1 block, 2 cylinder, 3 wedge, 4 corner wedge), or null when it isn't a flat quad there. */
export function faceFrame(shape: number, face: number): FaceFrame | null {
	if (face < 0 || face > 5) return null;
	if (shape === 1) return BOX_FACES[face] as FaceFrame;
	if (shape === 3) return face === 1 ? WEDGE_SLOPE : face === 2 || face === 4 ? (BOX_FACES[face] as FaceFrame) : null;
	if (shape === 4) return face === 4 ? (BOX_FACES[4] as FaceFrame) : null;
	return null;
}

function rotate(q: [number, number, number, number], v: V3): V3 {
	const [x, y, z, w] = q;
	// v + 2w(q x v) + 2 q x (q x v)
	const tx = 2 * (y * v[2] - z * v[1]);
	const ty = 2 * (z * v[0] - x * v[2]);
	const tz = 2 * (x * v[1] - y * v[0]);
	return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Studs a surface floats off its face (and a bit more per ZIndex), so it never z-fights the part. */
export const SURFACE_LIFT = 0.02;

/**
 * Where a surface's quad goes: a column-major 4x4 matrix (three.js `Matrix4.elements`) that maps the unit plane (x, y in
 * -0.5..0.5, facing +z) onto the face, and the face's size in studs. Null when the face isn't a quad of this shape.
 */
export function surfacePlacement(g: MapGeometry, part: number, face: number, zIndex = 1): { matrix: number[]; width: number; height: number } | null {
	const frame = faceFrame(g.shape[part] as number, face);
	if (!frame) return null;
	const size: V3 = [Math.max(0.05, Math.abs(g.size[part * 3] as number)), Math.max(0.05, Math.abs(g.size[part * 3 + 1] as number)), Math.max(0.05, Math.abs(g.size[part * 3 + 2] as number))];
	let q: [number, number, number, number] = [g.rotation[part * 4] as number, g.rotation[part * 4 + 1] as number, g.rotation[part * 4 + 2] as number, g.rotation[part * 4 + 3] as number];
	const len = Math.hypot(...q);
	q = len < 1e-3 ? [0, 0, 0, 1] : (q.map((c) => c / len) as typeof q);
	const scaled = (v: V3): V3 => [v[0] * size[0], v[1] * size[1], v[2] * size[2]];
	const u = rotate(q, scaled(frame.u));
	const v = rotate(q, scaled(frame.v));
	const c = rotate(q, scaled(frame.c));
	const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
	const nl = Math.hypot(...n) || 1;
	const lift = SURFACE_LIFT + 0.004 * Math.max(0, Math.min(zIndex, 20));
	const p: V3 = [(g.position[part * 3] as number) + c[0] + (n[0] / nl) * lift, (g.position[part * 3 + 1] as number) + c[1] + (n[1] / nl) * lift, (g.position[part * 3 + 2] as number) + c[2] + (n[2] / nl) * lift];
	return { matrix: [...u, 0, ...v, 0, n[0] / nl, n[1] / nl, n[2] / nl, 0, ...p, 1], width: Math.hypot(...u), height: Math.hypot(...v) };
}

/** Tiles at most along a side (a tiny StudsPerTile on a big face). */
export const MAX_REPEAT = 1024;

/**
 * The image's placement in the quad: [repeat u, repeat v, offset u, offset v] in tiles. A Decal stretches once over the
 * face; a Texture repeats every StudsPerTile studs from the face's top-left corner, shifted by its OffsetStuds.
 */
export function surfaceUv(s: Pick<MapSurface, "kind" | "tile">, width: number, height: number): [number, number, number, number] {
	if (s.kind === 0) return [1, 1, 0, 0];
	const [su, sv, ou, ov] = s.tile;
	const tu = su > 0.01 ? su : width;
	const tv = sv > 0.01 ? sv : height;
	return [Math.min(MAX_REPEAT, width / tu), Math.min(MAX_REPEAT, height / tv), ou / tu, ov / tv];
}

/** One image's quads: per instance a matrix (16), its uv placement (4) and its tint + alpha (4). */
export interface SurfaceGroup {
	image: string;
	count: number;
	matrices: Float32Array;
	uv: Float32Array;
	tint: Float32Array;
}

/**
 * The map's Decals and Textures grouped by image (one draw call each). A surface is drawn when its face is a quad of the
 * part's shape and the part is: any part that isn't a mesh or union (a decal shows on an invisible part too, as in the
 * game), and meshes / unions only when they are drawn (their box is a bounding box, the decal's place on it a guess).
 * Fully transparent surfaces are left out.
 */
export function groupSurfaces(g: MapGeometry, textures: MapTextures, toggles: DrawToggles): SurfaceGroup[] {
	const lists = new Map<string, { m: number[]; uv: number[]; tint: number[] }>();
	for (const s of textures.surfaces) {
		if (s.transparency >= 0.99 || s.part >= g.count) continue;
		const flags = g.flags[s.part] as number;
		if (flags & (FLAGS.mesh | FLAGS.union) && !isDrawn(flags, toggles)) continue;
		const placed = surfacePlacement(g, s.part, s.face, s.zIndex);
		if (!placed) continue;
		let list = lists.get(s.image);
		if (!list) lists.set(s.image, (list = { m: [], uv: [], tint: [] }));
		list.m.push(...placed.matrix);
		list.uv.push(...surfaceUv(s, placed.width, placed.height));
		list.tint.push(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255, 1 - s.transparency);
	}
	return [...lists].map(([image, l]) => ({ image, count: l.uv.length / 4, matrices: new Float32Array(l.m), uv: new Float32Array(l.uv), tint: new Float32Array(l.tint) }));
}

/** The variant (index) a part is drawn with, or -1: only solid parts whose variant has a color map. */
export function partVariant(textures: MapTextures | null, part: number): number {
	if (!textures) return -1;
	const v = textures.variantOf[part] ?? -1;
	return v >= 0 && textures.variants[v]?.image ? v : -1;
}

// Loading images ----------------------------------------------------------------------------------------------------------

export type ImageFetch = { state: "ready"; blob: Blob } | { state: "pending" } | { state: "none" };

/** One try at an image from the backend: 200 its bytes, 202 still resolving, anything else none. */
export async function fetchImage(id: string, doFetch: typeof fetch = fetch, signal?: AbortSignal): Promise<ImageFetch> {
	try {
		const response = await doFetch(`/api/v1/images/${id}`, { credentials: "same-origin", ...(signal ? { signal } : {}) });
		if (response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("image/")) return { state: "ready", blob: await response.blob() };
		if (response.status === 202 || response.status === 429 || response.status >= 500) return { state: "pending" };
		return { state: "none" };
	} catch (error) {
		if ((error as Error)?.name === "AbortError") throw error;
		return { state: "pending" };
	}
}

/** Waits between tries of a pending image (the backend resolves in seconds; Roblox renders new thumbnails in ~10 s). */
export const RETRY_MS = [4000, 8000, 15_000, 30_000, 60_000, 120_000] as const;

/** Images loading at once, at most. */
export const LOADS_MAX = 6;

/**
 * Loads image ids (at most LOADS_MAX at a time) and hands each ready blob to `onReady`; pending ones are tried again
 * after RETRY_MS (then given up), missing ones are dropped. `dispose` stops everything.
 */
export class ImageLoader {
	private readonly wanted = new Map<string, number>();
	private readonly queue: string[] = [];
	private active = 0;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly abort = new AbortController();
	private disposed = false;

	constructor(
		private readonly onReady: (id: string, blob: Blob) => void,
		private readonly doFetch: typeof fetch = (...args) => fetch(...args),
	) {}

	/** Asks for images (ids already asked for are ignored). */
	want(ids: Iterable<string>): void {
		for (const id of ids) {
			if (this.disposed || this.wanted.has(id) || !ASSET_ID.test(id)) continue;
			this.wanted.set(id, 0);
			this.queue.push(id);
		}
		this.pump();
	}

	private pump(): void {
		while (!this.disposed && this.active < LOADS_MAX && this.queue.length) {
			const id = this.queue.shift() as string;
			this.active++;
			void fetchImage(id, this.doFetch, this.abort.signal)
				.then((r) => {
					if (this.disposed) return;
					if (r.state === "ready") this.onReady(id, r.blob);
					else if (r.state === "pending") {
						const tries = this.wanted.get(id) ?? 0;
						const wait = RETRY_MS[tries];
						if (wait !== undefined) {
							this.wanted.set(id, tries + 1);
							const timer = setTimeout(() => {
								this.timers.delete(timer);
								this.queue.push(id);
								this.pump();
							}, wait);
							this.timers.add(timer);
						}
					}
				})
				.catch(() => {})
				.finally(() => {
					this.active--;
					this.pump();
				});
		}
	}

	dispose(): void {
		this.disposed = true;
		this.abort.abort();
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		this.queue.length = 0;
	}
}

// The built-in materials' look ----------------------------------------------------------------------------------------------

/** Enum.Material values with a pattern of their own (others with a grain get a fine noise; plastic, neon, glass, ice: none). */
export const MATERIALS = {
	Plastic: 256,
	SmoothPlastic: 272,
	Neon: 288,
	Wood: 512,
	WoodPlanks: 528,
	Marble: 784,
	Slate: 800,
	Concrete: 816,
	Granite: 832,
	Brick: 848,
	Pebble: 864,
	Cobblestone: 880,
	CorrodedMetal: 1040,
	DiamondPlate: 1056,
	Foil: 1072,
	Metal: 1088,
	Grass: 1280,
	LeafyGrass: 1284,
	Sand: 1296,
	Fabric: 1312,
	Ice: 1536,
	Glass: 1568,
	ForceField: 1584,
} as const;

/**
 * GLSL: `float ttLook(float material, vec3 p, vec3 n)`, a brightness factor (about 0.75..1.1) for a point `p` on a part
 * (part-local studs) with the local normal `n`. Cheap: a hash and a value noise, no textures.
 */
export const MATERIAL_LOOK_GLSL = /* glsl */ `
float ttHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ttNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(ttHash(i), ttHash(i + vec2(1.0, 0.0)), f.x), mix(ttHash(i + vec2(0.0, 1.0)), ttHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec2 ttPlane(vec3 p, vec3 n) {
	vec3 a = abs(n);
	return a.x > 0.5 ? p.zy : (a.y > 0.5 ? p.xz : p.xy);
}
float ttLook(float material, vec3 p, vec3 n) {
	int m = int(material + 0.5);
	if (m == ${MATERIALS.Plastic} || m == ${MATERIALS.SmoothPlastic} || m == ${MATERIALS.Neon} || m == ${MATERIALS.Glass} || m == ${MATERIALS.ForceField} || m == ${MATERIALS.Ice}) return 1.0;
	vec2 st = ttPlane(p, n);
	if (m == ${MATERIALS.Brick}) {
		vec2 b = st / vec2(2.0, 1.0);
		b.x += 0.5 * mod(floor(b.y), 2.0);
		vec2 f = fract(b);
		float mortar = max(step(f.x, 0.04), step(f.y, 0.08));
		return mix(0.9 + 0.14 * ttHash(floor(b)), 0.74, mortar);
	}
	if (m == ${MATERIALS.WoodPlanks}) {
		float plank = floor(st.y);
		float seam = step(fract(st.y), 0.05);
		float grain = 0.04 * sin(st.x * 5.0 + ttHash(vec2(plank, 1.0)) * 20.0);
		return mix(0.88 + 0.14 * ttHash(vec2(plank, 0.0)) + grain, 0.72, seam);
	}
	if (m == ${MATERIALS.Wood}) return 0.95 + 0.06 * sin(st.x * 3.0 + ttNoise(st * 0.7) * 6.0);
	if (m == ${MATERIALS.Grass} || m == ${MATERIALS.LeafyGrass}) return 0.88 + 0.2 * ttNoise(st * 3.0) * ttHash(floor(st * 8.0));
	if (m == ${MATERIALS.DiamondPlate}) {
		vec2 d = fract(st * 1.5) - 0.5;
		return 0.95 + 0.1 * step(min(abs(d.x + d.y), abs(d.x - d.y)), 0.07);
	}
	if (m == ${MATERIALS.Metal} || m == ${MATERIALS.Foil}) return 0.96 + 0.05 * ttNoise(vec2(st.x * 0.3, st.y * 12.0));
	if (m == ${MATERIALS.CorrodedMetal}) return 0.86 + 0.18 * ttNoise(st * 1.5);
	if (m == ${MATERIALS.Cobblestone} || m == ${MATERIALS.Pebble}) {
		vec2 c = st * 1.2;
		vec2 f = fract(c) - 0.5;
		return 0.84 + 0.14 * ttHash(floor(c)) - 0.12 * smoothstep(0.32, 0.5, max(abs(f.x), abs(f.y)));
	}
	if (m == ${MATERIALS.Fabric}) return 0.94 + 0.06 * step(0.5, fract((st.x + st.y) * 4.0));
	// Concrete, slate, granite, marble, sand and the rest: a fine grain.
	return 0.94 + 0.1 * ttNoise(st * 2.0);
}
`;
