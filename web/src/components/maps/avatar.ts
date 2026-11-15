/**
 * The replay's default avatars (plans/36): Roblox's R6 and R15 characters drawn procedurally as boxes (no downloaded
 * models), posed by Motor6D.Transform rotations, coloured by BodyColors and wearing classic clothing.
 *
 * Coordinates: Roblox and three.js are both right-handed with Y up, and a character faces -Z at identity (its right is
 * +X), so nothing is converted. `root` is the HumanoidRootPart's frame: put it at the recorded root position with
 * `root.rotation.y = yaw` (yaw 0 = facing -Z, the replay's convention; see placeAvatar).
 *
 * Joints work like Roblox's Motor6D: Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse(). Each joint is a
 * chain of three nodes under Part0's group (C0, the Transform rotation, C1 inverted) with Part1's group under it, so
 * setPose only writes quaternions. CFrame.Angles(rx, ry, rz) is Rx * Ry * Rz, three's Euler order "XYZ".
 *
 *   - R6: Roblox's own C0 / C1 (RootJoint, Neck, shoulders and hips rotated so a positive Z Transform on the right
 *     shoulder swings the arm forward and up), parts Torso 2x2x1, arms / legs 1x2x1, Head 2x1x1 (drawn 1.25x1x1, the head
 *     mesh's look), root 3 studs above the feet.
 *   - R15: the default blocky rig's parts and joints. APPROXIMATE: Roblox's R15 Motor6Ds are axis aligned (no rotation
 *     in C0 / C1), which this keeps, so clip rotations apply as in Roblox; but the part sizes and pivot positions are
 *     chosen to be consistent (arms and legs 2 studs long, hip height 2, root 3 studs above the feet) rather than copied
 *     from the real rig (e.g. the real UpperArm is 1.169 tall and overlaps the LowerArm). Pivots: Root at the lower
 *     torso's top, Waist the same point, Neck the upper torso's top, shoulders 0.25 under the shoulder top at the arm's
 *     centre line, elbows / wrists / knees / ankles at the segment boundaries, hips at the lower torso's bottom.
 *
 * Clothing: the classic 585x559 Shirt / Pants template. Torso cross: up (231, 8, 128x64), right side (165, 74, 64x128),
 * front (231, 74, 128x128), left side (361, 74), back (427, 74), down (231, 204). Right arm / right leg cross: left side
 * (19, 355), back (85, 355), right side (151, 355), front (217, 355), up (217, 289), down (217, 485), 64x128 and 64x64.
 * Left arm / left leg: front (308, 355), left (374, 355), back (440, 355), right (506, 355), up (308, 289), down
 * (308, 485). The shirt covers the torso and arms, the pants the torso and legs (the shirt drawn over them); each is a
 * textured shell slightly larger than the body box, faces mapped so the template reads upright and unmirrored from
 * outside. R15 splits each face's template rows across its segments by their heights (APPROXIMATE to Roblox's split).
 * The T-shirt graphic is a decal over the torso front, the face a decal on the head front (a simple drawn face when
 * none is given and a canvas is available).
 */
import * as THREE from "three";
import type { ExtLook } from "@/lib/types";

export type AvatarKind = "R6" | "R15";
export type Quat = [number, number, number, number];
export type Face = "front" | "back" | "left" | "right" | "top" | "bottom";
export type ClothingLayer = "shirt" | "pants";
type Vec3 = [number, number, number];
type Rect = [x: number, y: number, w: number, h: number];

export const R6_JOINTS: readonly string[] = ["RootJoint", "Neck", "Left Shoulder", "Right Shoulder", "Left Hip", "Right Hip"];
export const R15_JOINTS: readonly string[] = [
	"Root",
	"Waist",
	"Neck",
	"LeftShoulder",
	"LeftElbow",
	"LeftWrist",
	"RightShoulder",
	"RightElbow",
	"RightWrist",
	"LeftHip",
	"LeftKnee",
	"LeftAnkle",
	"RightHip",
	"RightKnee",
	"RightAnkle",
];

/** Body colour slots (the Look record's order). */
const HEAD = 0,
	TORSO = 1,
	LEFT_ARM = 2,
	RIGHT_ARM = 3,
	LEFT_LEG = 4,
	RIGHT_LEG = 5;

/** Classic defaults: bright yellow head and arms, bright blue torso, yellowish green legs. */
export const DEFAULT_COLORS: NonNullable<ExtLook["colors"]> = ["#f5cd30", "#0d69ac", "#f5cd30", "#f5cd30", "#a4bd47", "#a4bd47"];

type Area = "torso" | "rarm" | "larm" | "rleg" | "lleg";

interface Region {
	area: Area;
	/** The template rows this part covers on side faces, as fractions of the face's height from its top. */
	from: number;
	to: number;
	top: boolean;
	bottom: boolean;
}

interface PartDef {
	name: string;
	size: Vec3;
	slot: number;
	/** Drawn at this size instead (the head mesh). */
	visual?: Vec3;
	region?: Region;
}

interface JointDef {
	name: string;
	part0: string;
	part1: string;
	c0: THREE.Matrix4;
	c1: THREE.Matrix4;
}

interface RigDef {
	parts: PartDef[];
	joints: JointDef[];
	/** The part the T-shirt decal sits on. */
	chest: string;
}

/** CFrame.new(x, y, z) * CFrame.Angles(rx, ry, rz). */
function cf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
	return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, "XYZ")).setPosition(x, y, z);
}

const PI = Math.PI;
const whole = (area: Area): Region => ({ area, from: 0, to: 1, top: true, bottom: true });

const R6: RigDef = {
	parts: [
		{ name: "Torso", size: [2, 2, 1], slot: TORSO, region: whole("torso") },
		{ name: "Head", size: [2, 1, 1], slot: HEAD, visual: [1.25, 1, 1] },
		{ name: "Left Arm", size: [1, 2, 1], slot: LEFT_ARM, region: whole("larm") },
		{ name: "Right Arm", size: [1, 2, 1], slot: RIGHT_ARM, region: whole("rarm") },
		{ name: "Left Leg", size: [1, 2, 1], slot: LEFT_LEG, region: whole("lleg") },
		{ name: "Right Leg", size: [1, 2, 1], slot: RIGHT_LEG, region: whole("rleg") },
	],
	joints: [
		{ name: "RootJoint", part0: "HumanoidRootPart", part1: "Torso", c0: cf(0, 0, 0, -PI / 2, 0, PI), c1: cf(0, 0, 0, -PI / 2, 0, PI) },
		{ name: "Neck", part0: "Torso", part1: "Head", c0: cf(0, 1, 0, -PI / 2, 0, PI), c1: cf(0, -0.5, 0, -PI / 2, 0, PI) },
		{ name: "Left Shoulder", part0: "Torso", part1: "Left Arm", c0: cf(-1, 0.5, 0, 0, -PI / 2, 0), c1: cf(0.5, 0.5, 0, 0, -PI / 2, 0) },
		{ name: "Right Shoulder", part0: "Torso", part1: "Right Arm", c0: cf(1, 0.5, 0, 0, PI / 2, 0), c1: cf(-0.5, 0.5, 0, 0, PI / 2, 0) },
		{ name: "Left Hip", part0: "Torso", part1: "Left Leg", c0: cf(-1, -1, 0, 0, -PI / 2, 0), c1: cf(-0.5, 1, 0, 0, -PI / 2, 0) },
		{ name: "Right Hip", part0: "Torso", part1: "Right Leg", c0: cf(1, -1, 0, 0, PI / 2, 0), c1: cf(0.5, 1, 0, 0, PI / 2, 0) },
	],
	chest: "Torso",
};

// R15 segment heights (arms and legs: 0.9 + 0.8 + 0.3 = 2) and their share of the template's rows.
const UPPER = 0.9,
	LOWER = 0.8,
	END = 0.3;
const limb = (area: Area, part: "upper" | "lower" | "end"): Region =>
	part === "upper"
		? { area, from: 0, to: UPPER / 2, top: true, bottom: false }
		: part === "lower"
			? { area, from: UPPER / 2, to: (UPPER + LOWER) / 2, top: false, bottom: false }
			: { area, from: (UPPER + LOWER) / 2, to: 1, top: false, bottom: true };

function r15Limbs(side: "Left" | "Right"): { parts: PartDef[]; joints: JointDef[] } {
	const s = side === "Left" ? -1 : 1;
	const arm: Area = side === "Left" ? "larm" : "rarm";
	const leg: Area = side === "Left" ? "lleg" : "rleg";
	const armSlot = side === "Left" ? LEFT_ARM : RIGHT_ARM;
	const legSlot = side === "Left" ? LEFT_LEG : RIGHT_LEG;
	return {
		parts: [
			{ name: `${side}UpperArm`, size: [1, UPPER, 1], slot: armSlot, region: limb(arm, "upper") },
			{ name: `${side}LowerArm`, size: [1, LOWER, 1], slot: armSlot, region: limb(arm, "lower") },
			{ name: `${side}Hand`, size: [1, END, 1], slot: armSlot, region: limb(arm, "end") },
			{ name: `${side}UpperLeg`, size: [1, UPPER, 1], slot: legSlot, region: limb(leg, "upper") },
			{ name: `${side}LowerLeg`, size: [1, LOWER, 1], slot: legSlot, region: limb(leg, "lower") },
			{ name: `${side}Foot`, size: [1, END, 1], slot: legSlot, region: limb(leg, "end") },
		],
		joints: [
			// UpperTorso centre y 0.2 (top 1.0); shoulder pivot at y 0.75, the upper arm's centre line.
			{ name: `${side}Shoulder`, part0: "UpperTorso", part1: `${side}UpperArm`, c0: cf(1.5 * s, 0.55, 0), c1: cf(0, 0.2, 0) },
			{ name: `${side}Elbow`, part0: `${side}UpperArm`, part1: `${side}LowerArm`, c0: cf(0, -UPPER / 2, 0), c1: cf(0, LOWER / 2, 0) },
			{ name: `${side}Wrist`, part0: `${side}LowerArm`, part1: `${side}Hand`, c0: cf(0, -LOWER / 2, 0), c1: cf(0, END / 2, 0) },
			// LowerTorso centre y -0.8 (bottom -1.0): hips at its bottom.
			{ name: `${side}Hip`, part0: "LowerTorso", part1: `${side}UpperLeg`, c0: cf(0.5 * s, -0.2, 0), c1: cf(0, UPPER / 2, 0) },
			{ name: `${side}Knee`, part0: `${side}UpperLeg`, part1: `${side}LowerLeg`, c0: cf(0, -UPPER / 2, 0), c1: cf(0, LOWER / 2, 0) },
			{ name: `${side}Ankle`, part0: `${side}LowerLeg`, part1: `${side}Foot`, c0: cf(0, -LOWER / 2, 0), c1: cf(0, END / 2, 0) },
		],
	};
}

const R15: RigDef = (() => {
	const left = r15Limbs("Left");
	const right = r15Limbs("Right");
	const parts: PartDef[] = [
		{ name: "LowerTorso", size: [2, 0.4, 1], slot: TORSO, region: { area: "torso", from: 0.8, to: 1, top: false, bottom: true } },
		{ name: "UpperTorso", size: [2, 1.6, 1], slot: TORSO, region: { area: "torso", from: 0, to: 0.8, top: true, bottom: false } },
		{ name: "Head", size: [2, 1, 1], slot: HEAD, visual: [1.25, 1, 1] },
		...left.parts,
		...right.parts,
	];
	const joints: JointDef[] = [
		{ name: "Root", part0: "HumanoidRootPart", part1: "LowerTorso", c0: cf(0, -0.6, 0), c1: cf(0, 0.2, 0) },
		{ name: "Waist", part0: "LowerTorso", part1: "UpperTorso", c0: cf(0, 0.2, 0), c1: cf(0, -0.8, 0) },
		{ name: "Neck", part0: "UpperTorso", part1: "Head", c0: cf(0, 0.8, 0), c1: cf(0, -0.5, 0) },
	];
	// R15_JOINTS order: shoulders / elbows / wrists, then hips / knees / ankles, left before right.
	const byName = new Map([...left.joints, ...right.joints].map((j) => [j.name, j]));
	for (const name of R15_JOINTS.slice(3)) joints.push(byName.get(name) as JointDef);
	return { parts, joints, chest: "UpperTorso" };
})();

const RIGS: Record<AvatarKind, RigDef> = { R6, R15 };

// Clothing template --------------------------------------------------------------------------------------------------

export const TEMPLATE_WIDTH = 585;
export const TEMPLATE_HEIGHT = 559;

const TORSO_CROSS: Record<Face, Rect> = {
	top: [231, 8, 128, 64],
	right: [165, 74, 64, 128],
	front: [231, 74, 128, 128],
	left: [361, 74, 64, 128],
	back: [427, 74, 128, 128],
	bottom: [231, 204, 128, 64],
};
const RIGHT_CROSS: Record<Face, Rect> = {
	left: [19, 355, 64, 128],
	back: [85, 355, 64, 128],
	right: [151, 355, 64, 128],
	front: [217, 355, 64, 128],
	top: [217, 289, 64, 64],
	bottom: [217, 485, 64, 64],
};
const LEFT_CROSS: Record<Face, Rect> = {
	front: [308, 355, 64, 128],
	left: [374, 355, 64, 128],
	back: [440, 355, 64, 128],
	right: [506, 355, 64, 128],
	top: [308, 289, 64, 64],
	bottom: [308, 485, 64, 64],
};
const CROSSES: Record<Area, Record<Face, Rect>> = { torso: TORSO_CROSS, rarm: RIGHT_CROSS, rleg: RIGHT_CROSS, larm: LEFT_CROSS, lleg: LEFT_CROSS };
const LAYER_AREAS: Record<ClothingLayer, readonly Area[]> = { shirt: ["torso", "rarm", "larm"], pants: ["torso", "rleg", "lleg"] };

function regionRect(region: Region, face: Face, layer: ClothingLayer): Rect | null {
	if (!LAYER_AREAS[layer].includes(region.area)) return null;
	const full = CROSSES[region.area][face];
	if (face === "top") return region.top ? [...full] : null;
	if (face === "bottom") return region.bottom ? [...full] : null;
	const [x, y, w, h] = full;
	return [x, y + region.from * h, w, (region.to - region.from) * h];
}

/** The template rectangle (px of the 585x559 template) a body part's face wears, or null (no clothing there). */
export function clothingRect(kind: AvatarKind, part: string, face: Face, layer: ClothingLayer): Rect | null {
	const def = RIGS[kind].parts.find((p) => p.name === part);
	return def?.region ? regionRect(def.region, face, layer) : null;
}

/** Each box face: its outward normal and two tangents (u x v = normal, so the corners wind counter-clockwise outside). */
const FACES: { face: Face; n: Vec3; u: Vec3; v: Vec3 }[] = [
	{ face: "right", n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
	{ face: "left", n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
	{ face: "top", n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
	{ face: "bottom", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
	{ face: "back", n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
	{ face: "front", n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/**
 * Where a point of a unit box face lands on the face's template rectangle: s left to right, t top to bottom, as the
 * template is drawn (seen from outside, upright; the cross's neighbours share edges: the right side sits left of the
 * front, the up face above it).
 */
function faceST(face: Face, x: number, y: number, z: number): [number, number] {
	switch (face) {
		case "front":
			return [0.5 - x, 0.5 - y];
		case "back":
			return [x + 0.5, 0.5 - y];
		case "right":
			return [0.5 - z, 0.5 - y];
		case "left":
			return [z + 0.5, 0.5 - y];
		case "top":
			return [0.5 - x, 0.5 - z];
		case "bottom":
			return [0.5 - x, z + 0.5];
	}
}

/** A box shell of `size` with only the faces given, each UV-mapped onto its template rectangle. */
export function clothingGeometry(size: Vec3, rects: Partial<Record<Face, Rect>>): THREE.BufferGeometry {
	const position: number[] = [];
	const normal: number[] = [];
	const uv: number[] = [];
	for (const { face, n, u, v } of FACES) {
		const rect = rects[face];
		if (!rect) continue;
		const corner = (a: number, b: number) => {
			const p: Vec3 = [n[0] * 0.5 + u[0] * a + v[0] * b, n[1] * 0.5 + u[1] * a + v[1] * b, n[2] * 0.5 + u[2] * a + v[2] * b];
			const [s, t] = faceST(face, p[0], p[1], p[2]);
			position.push(p[0] * size[0], p[1] * size[1], p[2] * size[2]);
			normal.push(...n);
			uv.push((rect[0] + s * rect[2]) / TEMPLATE_WIDTH, 1 - (rect[1] + t * rect[3]) / TEMPLATE_HEIGHT);
		};
		for (const [a, b] of [
			[-0.5, -0.5],
			[0.5, -0.5],
			[0.5, 0.5],
			[-0.5, -0.5],
			[0.5, 0.5],
			[-0.5, 0.5],
		] as const)
			corner(a, b);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
	g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
	g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
	return g;
}

// The avatar ----------------------------------------------------------------------------------------------------------

export interface Avatar {
	readonly kind: AvatarKind;
	/** The HumanoidRootPart's frame: place it at the root's position (studs) with its yaw (radians, 0 = facing -Z). */
	readonly root: THREE.Group;
	readonly joints: readonly string[];
	/** The body meshes (for picking: each mesh's `userData.part` is its part's name). */
	readonly meshes: readonly THREE.Mesh[];
	/** Motor6D.Transform rotation per joint name (missing = rest). Unknown names and non-finite values are ignored. */
	setPose(pose: Readonly<Record<string, Quat>>): void;
	setColors(colors?: ExtLook["colors"]): void;
	/** Clothing images (decoded: HTMLImageElement, canvas, ImageBitmap...); null / undefined = none. */
	setClothing(images: { shirt?: TexImageSource | null; pants?: TexImageSource | null; tshirt?: TexImageSource | null; face?: TexImageSource | null }): void;
	setHighlight(on: boolean): void;
	dispose(): void;
}

/** Puts an avatar's root at a position (studs) facing a yaw (radians, 0 = facing -Z). */
export function placeAvatar(avatar: Avatar, x: number, y: number, z: number, yaw: number): void {
	avatar.root.position.set(x, y, z);
	avatar.root.rotation.set(0, yaw, 0);
}

function textureOf(image: TexImageSource): THREE.Texture {
	const texture = new THREE.Texture(image as unknown as HTMLImageElement);
	texture.colorSpace = THREE.SRGBColorSpace;
	if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
		// WebGL ignores flipY for ImageBitmaps: flip the V coordinate instead.
		texture.flipY = false;
		texture.repeat.set(1, -1);
		texture.offset.set(0, 1);
	}
	texture.needsUpdate = true;
	return texture;
}

/** A plain smiling face (the default when no face texture is given), when a 2D canvas is available. */
function defaultFace(): THREE.Texture | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 64;
	let ctx: CanvasRenderingContext2D | null = null;
	try {
		ctx = canvas.getContext("2d");
	} catch {
		ctx = null;
	}
	if (!ctx) return null;
	ctx.fillStyle = "#111";
	ctx.beginPath();
	ctx.ellipse(22, 26, 3.5, 6, 0, 0, Math.PI * 2);
	ctx.ellipse(42, 26, 3.5, 6, 0, 0, Math.PI * 2);
	ctx.fill();
	ctx.lineWidth = 3;
	ctx.strokeStyle = "#111";
	ctx.beginPath();
	ctx.arc(32, 34, 13, 0.2 * Math.PI, 0.8 * Math.PI);
	ctx.stroke();
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

/** A default R6 or R15 character in its rest pose, root at the origin facing -Z. */
export function createAvatar(kind: AvatarKind, options: { colors?: ExtLook["colors"] } = {}): Avatar {
	const rig = RIGS[kind];
	const root = new THREE.Group();
	root.name = "HumanoidRootPart";
	root.userData.avatar = kind;
	const groups = new Map<string, THREE.Object3D>([["HumanoidRootPart", root]]);
	const transforms = new Map<string, THREE.Object3D>();
	for (const joint of rig.joints) {
		const parent = groups.get(joint.part0);
		if (!parent) throw new Error(`avatar: ${joint.name} before its Part0 ${joint.part0}`);
		const c0 = new THREE.Object3D();
		c0.name = `${joint.name}:C0`;
		c0.matrixAutoUpdate = false;
		c0.matrix.copy(joint.c0);
		const transform = new THREE.Object3D();
		transform.name = `${joint.name}:Transform`;
		const c1 = new THREE.Object3D();
		c1.name = `${joint.name}:C1`;
		c1.matrixAutoUpdate = false;
		c1.matrix.copy(joint.c1).invert();
		const part = new THREE.Group();
		part.name = joint.part1;
		parent.add(c0);
		c0.add(transform);
		transform.add(c1);
		c1.add(part);
		groups.set(joint.part1, part);
		transforms.set(joint.name, transform);
	}

	const geometries: THREE.BufferGeometry[] = [];
	const bodyMaterials: { material: THREE.MeshLambertMaterial; slot: number }[] = [];
	const meshes: THREE.Mesh[] = [];
	const layerMaterials: Record<ClothingLayer, THREE.MeshLambertMaterial> = {
		shirt: new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.05 }),
		pants: new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.05 }),
	};
	const overlays: Record<ClothingLayer, THREE.Mesh[]> = { shirt: [], pants: [] };
	for (const def of rig.parts) {
		const group = groups.get(def.name) as THREE.Object3D;
		const geometry = new THREE.BoxGeometry(...(def.visual ?? def.size));
		geometries.push(geometry);
		const material = new THREE.MeshLambertMaterial();
		bodyMaterials.push({ material, slot: def.slot });
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = `${def.name}:body`;
		mesh.userData.part = def.name;
		group.add(mesh);
		meshes.push(mesh);
		if (!def.region) continue;
		for (const layer of ["pants", "shirt"] as const) {
			const rects: Partial<Record<Face, Rect>> = {};
			let any = false;
			for (const { face } of FACES) {
				const rect = regionRect(def.region, face, layer);
				if (rect) {
					rects[face] = rect;
					any = true;
				}
			}
			if (!any) continue;
			// The shirt's shell sits just outside the pants' on the torso.
			const grow = layer === "shirt" ? 0.04 : 0.02;
			const shell = clothingGeometry([def.size[0] + grow, def.size[1] + grow, def.size[2] + grow], rects);
			geometries.push(shell);
			const overlay = new THREE.Mesh(shell, layerMaterials[layer]);
			overlay.name = `${def.name}:${layer}`;
			overlay.userData.part = def.name;
			overlay.visible = false;
			group.add(overlay);
			overlays[layer].push(overlay);
		}
	}

	// T-shirt graphic on the chest's front, face on the head's front (planes face +Z; turned to face -Z).
	const chest = rig.parts.find((p) => p.name === rig.chest) as PartDef;
	const tshirtMaterial = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.05 });
	const tshirtGeometry = new THREE.PlaneGeometry(chest.size[0] * 0.9, Math.min(chest.size[1], 1.6) * 0.9);
	geometries.push(tshirtGeometry);
	const tshirt = new THREE.Mesh(tshirtGeometry, tshirtMaterial);
	tshirt.name = `${rig.chest}:tshirt`;
	tshirt.rotation.y = Math.PI;
	tshirt.position.set(0, 0, -chest.size[2] / 2 - 0.03);
	tshirt.visible = false;
	(groups.get(rig.chest) as THREE.Object3D).add(tshirt);

	const head = rig.parts.find((p) => p.name === "Head") as PartDef;
	const headSize = head.visual ?? head.size;
	const faceMaterial = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.05, color: 0xffffff });
	const faceGeometry = new THREE.PlaneGeometry(Math.min(headSize[0], 1), headSize[1]);
	geometries.push(faceGeometry);
	const faceDecal = new THREE.Mesh(faceGeometry, faceMaterial);
	faceDecal.name = "Head:face";
	faceDecal.rotation.y = Math.PI;
	faceDecal.position.set(0, 0, -headSize[2] / 2 - 0.01);
	(groups.get("Head") as THREE.Object3D).add(faceDecal);
	const fallbackFace = defaultFace();
	faceMaterial.map = fallbackFace;
	faceDecal.visible = fallbackFace !== null;

	const textures: Partial<Record<"shirt" | "pants" | "tshirt" | "face", THREE.Texture>> = {};
	const identity = new THREE.Quaternion();

	const setColors = (colors?: ExtLook["colors"]) => {
		const list = colors && colors.length === 6 ? colors : DEFAULT_COLORS;
		for (const { material, slot } of bodyMaterials) {
			const value = list[slot] ?? DEFAULT_COLORS[slot] ?? "#a3a2a5";
			try {
				material.color.set(value);
			} catch {
				material.color.set(DEFAULT_COLORS[slot] ?? "#a3a2a5");
			}
		}
	};
	setColors(options.colors);

	const swap = (key: "shirt" | "pants" | "tshirt" | "face", image: TexImageSource | null | undefined): THREE.Texture | null => {
		textures[key]?.dispose();
		delete textures[key];
		if (!image) return null;
		const texture = textureOf(image);
		textures[key] = texture;
		return texture;
	};

	let disposed = false;
	return {
		kind,
		root,
		joints: kind === "R6" ? R6_JOINTS : R15_JOINTS,
		meshes,
		setPose(pose) {
			for (const [name, node] of transforms) {
				const q = pose[name];
				if (q && q.length === 4 && q.every(Number.isFinite) && q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] > 1e-8) node.quaternion.set(q[0], q[1], q[2], q[3]).normalize();
				else node.quaternion.copy(identity);
			}
		},
		setColors,
		setClothing(images) {
			for (const layer of ["shirt", "pants"] as const) {
				const texture = swap(layer, images[layer]);
				layerMaterials[layer].map = texture;
				layerMaterials[layer].needsUpdate = true;
				for (const overlay of overlays[layer]) overlay.visible = texture !== null;
			}
			const shirtGraphic = swap("tshirt", images.tshirt);
			tshirtMaterial.map = shirtGraphic;
			tshirtMaterial.needsUpdate = true;
			tshirt.visible = shirtGraphic !== null;
			const face = swap("face", images.face);
			faceMaterial.map = face ?? fallbackFace;
			faceMaterial.needsUpdate = true;
			faceDecal.visible = faceMaterial.map !== null;
		},
		setHighlight(on) {
			for (const { material } of bodyMaterials) material.emissive.set(on ? 0x3a3a3a : 0x000000);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			root.removeFromParent();
			for (const g of geometries) g.dispose();
			for (const { material } of bodyMaterials) material.dispose();
			for (const m of [layerMaterials.shirt, layerMaterials.pants, tshirtMaterial, faceMaterial]) m.dispose();
			for (const t of Object.values(textures)) t?.dispose();
			fallbackFace?.dispose();
		},
	};
}
