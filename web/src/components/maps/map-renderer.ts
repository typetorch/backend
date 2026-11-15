/**
 * The 2D / 3D map renderer (plans/33), three.js, no React. One instanced mesh per (shape, look) so thousands of parts
 * draw in a handful of calls; rendering happens on demand (a camera move, a change), never in a loop.
 *
 *   - 3D: a perspective camera with orbit controls (left drag turns, right drag pans, the wheel zooms) and fly keys
 *     (W A S D move, Q E down / up, Shift faster) while the canvas has focus.
 *   - 2D: the same scene from straight above through an orthographic camera (north, -Z, up); left or right drag pans,
 *     the wheel zooms toward the cursor. Vector geometry redrawn at the device's pixel ratio: crisp at any zoom.
 *   - The Y band: two clipping planes hide geometry above and below it (walls are cut like a floor plan); layer marks
 *     outside the band are left out.
 *   - See-through looks (glassy, invisible walls, markers) are drawn as solid shapes: a depth-only pre-pass, then one blend
 *     of the nearest surface per pixel (a stencil bit per look), so a part's back and inner faces never show through its
 *     front. Where the band cuts a part open, its inner faces show as a flat cap (a floor-plan section: solids darker,
 *     walls and glass less see-through). They are pulled toward the camera (polygon offset): a wall's bottom on the floor's
 *     top doesn't z-fight it.
 *   - Parts, by the draw rule (lib/maps.ts partKind / isDrawn): everything that collides, visible or not, and visible
 *     non-colliding parts that aren't meshes or unions; non-colliding meshes / unions only with `decorative`, invisible
 *     non-colliding parts only with `markers`. Real part colors, never a tint: solid (transparency < 0.5), glassy (< 0.95,
 *     see-through), invisible walls (collide, >= 0.95: their color, half see-through), markers (faint). MeshParts and
 *     unions are their boxes, marked by a thin dark outline (not a fill color, which would read like the game's).
 *   - Layers (world coordinates): points (fixed-size dots), paths (lines), polygons (filled, a camera cone), heat cells
 *     (flat squares at the cell's height, colored by count on a log scale).
 * Shapes follow Roblox's: a cylinder's axis is the part's X; a wedge's slope faces -Z (its tall face is +Z); the corner
 * wedge's peak is over its (+X, -Z) corner (not checked against Studio).
 */
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FLAGS, heatColor, isDrawn, partKind, type Bounds, type MapGeometry, type MapLayer, type MapPoint, type Vec3 } from "@/lib/maps";

export type MapMode = "2d" | "3d";

export interface SceneOptions {
	mode: MapMode;
	offset: Vec3;
	band: [number, number] | null;
	/** Non-colliding meshes and unions. */
	decorative: boolean;
	/** Invisible non-colliding parts. */
	markers: boolean;
}

/** A unit box's 12 edges (24 endpoints), for the mesh / union outlines. */
const BOX_EDGES = (() => {
	const c = [-0.5, 0.5];
	const out: number[] = [];
	for (const a of c) for (const b of c) out.push(-0.5, a, b, 0.5, a, b, a, -0.5, b, a, 0.5, b, a, b, -0.5, a, b, 0.5);
	return out;
})();

// Triangles wound counter-clockwise seen from outside (front faces out), like three's own shapes: back faces are the
// inside, which shows only where the band cuts a part open (drawn as the cap).
function wedgeGeometry(): THREE.BufferGeometry {
	const A = [-0.5, -0.5, -0.5], B = [0.5, -0.5, -0.5], C = [0.5, -0.5, 0.5], D = [-0.5, -0.5, 0.5], E = [-0.5, 0.5, 0.5], F = [0.5, 0.5, 0.5];
	return triangles([A, B, C, A, C, D, D, C, F, D, F, E, A, F, B, A, E, F, A, D, E, B, F, C]);
}

function cornerWedgeGeometry(): THREE.BufferGeometry {
	const A = [-0.5, -0.5, -0.5], B = [0.5, -0.5, -0.5], C = [0.5, -0.5, 0.5], D = [-0.5, -0.5, 0.5], P = [0.5, 0.5, -0.5];
	return triangles([A, B, C, A, C, D, B, P, C, A, P, B, A, D, P, D, C, P]);
}

function triangles(vertices: number[][]): THREE.BufferGeometry {
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(vertices.flat(), 3));
	g.computeVertexNormals();
	return g;
}

/** The unit shapes by Roblox shape index: ball, block, cylinder (axis X), wedge, corner wedge. */
export function shapeGeometries(): THREE.BufferGeometry[] {
	const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
	cylinder.rotateZ(-Math.PI / 2);
	return [new THREE.SphereGeometry(0.5, 18, 12), new THREE.BoxGeometry(1, 1, 1), cylinder, wedgeGeometry(), cornerWedgeGeometry()];
}

export type Look = "solid" | "glassy" | "wall" | "marker";

/**
 * The see-through looks in draw order: opacity, how much more opaque their cut (cap) is, and their stencil bit (one blend
 * per pixel per look). Markers' caps stay faint: they're often big zones the camera is inside, where every back face is
 * "cap".
 */
export const SEE_THROUGH = [
	{ look: "glassy", opacity: 0.35, cap: 0.5, bit: 1 },
	{ look: "wall", opacity: 0.55, cap: 0.5, bit: 2 },
	{ look: "marker", opacity: 0.18, cap: 0, bit: 4 },
] as const satisfies readonly { look: Exclude<Look, "solid">; opacity: number; cap: number; bit: number }[];

/** Above the 3D layer marks (10+, drawn first so walls tint what's behind them), under the 2D ones (2000+, on top). */
const PARTS_ORDER = 1000;

/**
 * Where the band cuts a part open, its inside (back faces) shows. Drawn flat (unlit), it reads as a filled section, the
 * cut: solids darker (their own color, shade 0.45), see-through parts their full color and less see-through (SEE_THROUGH
 * cap: half way to opaque), so walls cut by the band stand out in the top-down view.
 */
function withCap(material: THREE.MeshLambertMaterial, shade: number, opaque: number): THREE.MeshLambertMaterial {
	const cap = `if (!gl_FrontFacing) { outgoingLight = diffuseColor.rgb * ${shade.toFixed(3)}; diffuseColor.a = mix(diffuseColor.a, 1.0, ${opaque.toFixed(3)}); }`;
	material.onBeforeCompile = (shader) => {
		shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `${cap}\n#include <opaque_fragment>`);
	};
	material.customProgramCacheKey = () => cap;
	return material;
}

export interface PartMaterials {
	/** The color pass of each look. */
	color: Record<Look, THREE.MeshLambertMaterial>;
	/** The depth-only pre-pass of each see-through look. */
	depth: Record<Exclude<Look, "solid">, THREE.MeshBasicMaterial>;
}

/**
 * The parts' materials. Solid: opaque, both sides (the inside is the cap). See-through: the pre-pass writes the nearest
 * depth of the look's parts, then the color pass blends only that surface (depth equal, the look's stencil bit not yet
 * set), once per pixel. Both pulled toward the camera by the same polygon offset, so they match each other and win over
 * a coplanar floor.
 */
export function partMaterials(clippingPlanes: THREE.Plane[]): PartMaterials {
	const base = { clippingPlanes, side: THREE.DoubleSide } as const;
	// One pass for both sides (three otherwise draws a transparent double-sided material back, then front); the depth and
	// the stencil already keep only the nearest surface.
	const offset = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, forceSinglePass: true } as const;
	const color = { solid: withCap(new THREE.MeshLambertMaterial({ ...base }), 0.45, 0) } as PartMaterials["color"];
	const depth = {} as PartMaterials["depth"];
	for (const { look, opacity, cap, bit } of SEE_THROUGH) {
		depth[look] = new THREE.MeshBasicMaterial({ ...base, ...offset, colorWrite: false, depthWrite: true, transparent: true });
		color[look] = withCap(
			new THREE.MeshLambertMaterial({
				...base,
				...offset,
				transparent: true,
				opacity,
				depthWrite: false,
				depthFunc: THREE.LessEqualDepth,
				stencilWrite: true,
				stencilRef: bit,
				stencilFuncMask: bit,
				stencilWriteMask: bit,
				stencilFunc: THREE.NotEqualStencilFunc,
				stencilZPass: THREE.ReplaceStencilOp,
			}),
			1,
			cap,
		);
	}
	return { color, depth };
}

export class MapRenderer {
	readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly world = new THREE.Group();
	private readonly parts = new THREE.Group();
	private readonly marks = new THREE.Group();
	private readonly perspective = new THREE.PerspectiveCamera(50, 1, 0.5, 20_000);
	private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50_000);
	private controls: OrbitControls | MapControls;
	private readonly shapes = shapeGeometries();
	private readonly clip = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6), new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6)];
	private readonly materials: PartMaterials;
	private readonly outlineMaterial: THREE.LineBasicMaterial;
	private grid: THREE.GridHelper | null = null;
	private geometry: MapGeometry | null = null;
	private bounds: Bounds | null = null;
	private layers: MapLayer[] = [];
	/** What a 3D click / hover can land on (built with the marks): the layers' dots and the heat cells' meshes. */
	private pickPoints: THREE.Vector3[] = [];
	private pickCells: THREE.InstancedMesh[] = [];
	private readonly raycaster = new THREE.Raycaster();
	private options: SceneOptions = { mode: "3d", offset: [0, 0, 0], band: null, decorative: false, markers: false };
	private readonly keys = new Set<string>();
	private flying = 0;
	private disposed = false;
	private frame = 0;
	private readonly resize: ResizeObserver;

	constructor(private readonly host: HTMLElement) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.localClippingEnabled = true;
		this.renderer.domElement.tabIndex = 0;
		this.renderer.domElement.style.outline = "none";
		host.appendChild(this.renderer.domElement);
		this.materials = partMaterials(this.clip);
		this.outlineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, clippingPlanes: this.clip });
		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
		const sun = new THREE.DirectionalLight(0xffffff, 1.4);
		sun.position.set(0.4, 1, 0.25);
		this.scene.add(sun);
		this.world.add(this.parts);
		this.scene.add(this.world, this.marks);
		this.ortho.up.set(0, 0, -1);
		this.controls = this.makeControls("3d");
		this.resize = new ResizeObserver(() => this.fitSize());
		this.resize.observe(host);
		this.renderer.domElement.addEventListener("keydown", this.onKey);
		this.renderer.domElement.addEventListener("keyup", this.onKey);
		this.renderer.domElement.addEventListener("blur", () => this.keys.clear());
		this.fitSize();
	}

	private makeControls(mode: MapMode): OrbitControls | MapControls {
		const dom = this.renderer.domElement;
		if (mode === "2d") {
			const c = new MapControls(this.ortho, dom);
			c.enableRotate = false;
			c.screenSpacePanning = true;
			c.zoomToCursor = true;
			c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
			c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
			c.minZoom = 0.02;
			c.maxZoom = 400;
			c.addEventListener("change", () => this.render());
			return c;
		}
		const c = new OrbitControls(this.perspective, dom);
		c.enableDamping = false;
		c.screenSpacePanning = true;
		c.addEventListener("change", () => this.render());
		return c;
	}

	private get camera(): THREE.Camera {
		return this.options.mode === "2d" ? this.ortho : this.perspective;
	}

	/** The map's parts (null: none), its bounds (the camera fits them), the layers and the view options. */
	update(geometry: MapGeometry | null, bounds: Bounds | null, layers: MapLayer[], options: SceneOptions): void {
		const geometryChanged = geometry !== this.geometry;
		const modeChanged = options.mode !== this.options.mode;
		const offsetChanged = options.offset.some((v, i) => v !== this.options.offset[i]);
		const looksChanged = options.decorative !== this.options.decorative || options.markers !== this.options.markers;
		this.geometry = geometry;
		this.bounds = bounds;
		this.layers = layers;
		this.options = { ...options };
		this.world.position.set(...options.offset);
		if (geometryChanged || looksChanged) this.buildParts();
		this.applyBand();
		this.buildMarks();
		if (modeChanged) {
			this.controls.dispose();
			this.controls = this.makeControls(options.mode);
		}
		if (geometryChanged || modeChanged || offsetChanged) this.fit();
		this.buildGrid();
		this.render();
	}

	private buildParts(): void {
		for (const child of [...this.parts.children]) {
			this.parts.remove(child);
			if (child instanceof THREE.InstancedMesh) child.dispose();
			else if (child instanceof THREE.LineSegments) child.geometry.dispose();
		}
		const g = this.geometry;
		if (!g) return;
		const toggles = { decorative: this.options.decorative, markers: this.options.markers };
		const buckets = new Map<string, number[]>();
		const outlined: number[] = [];
		for (let i = 0; i < g.count; i++) {
			const flags = g.flags[i] as number;
			if (!isDrawn(flags, toggles)) continue;
			const t = (g.transparency[i] as number) / 255;
			const kind = partKind(flags);
			const look: Look = kind === "marker" ? "marker" : flags & FLAGS.invisible ? "wall" : t >= 0.5 ? "glassy" : "solid";
			if (flags & (FLAGS.mesh | FLAGS.union)) outlined.push(i);
			const key = `${Math.min(g.shape[i] as number, 4)}:${look}`;
			let list = buckets.get(key);
			if (!list) buckets.set(key, (list = []));
			list.push(i);
		}
		const m = new THREE.Matrix4();
		const p = new THREE.Vector3();
		const q = new THREE.Quaternion();
		const s = new THREE.Vector3();
		const color = new THREE.Color();
		const matrixOf = (i: number, shape: number) => {
			p.set(g.position[i * 3] as number, g.position[i * 3 + 1] as number, g.position[i * 3 + 2] as number);
			q.set(g.rotation[i * 4] as number, g.rotation[i * 4 + 1] as number, g.rotation[i * 4 + 2] as number, g.rotation[i * 4 + 3] as number);
			if (q.lengthSq() < 1e-6) q.identity();
			else q.normalize();
			s.set(Math.max(0.05, Math.abs(g.size[i * 3] as number)), Math.max(0.05, Math.abs(g.size[i * 3 + 1] as number)), Math.max(0.05, Math.abs(g.size[i * 3 + 2] as number)));
			if (shape === 0) s.setScalar(Math.min(s.x, s.y, s.z));
			return m.compose(p, q, s);
		};
		for (const [key, list] of buckets) {
			const [shape, look] = key.split(":") as [string, Look];
			const mesh = new THREE.InstancedMesh(this.shapes[Number(shape)] as THREE.BufferGeometry, this.materials.color[look], list.length);
			list.forEach((i, k) => {
				mesh.setMatrixAt(k, matrixOf(i, Number(shape)));
				color.setRGB((g.color[i * 3] as number) / 255, (g.color[i * 3 + 1] as number) / 255, (g.color[i * 3 + 2] as number) / 255, THREE.SRGBColorSpace);
				mesh.setColorAt(k, color);
			});
			mesh.instanceMatrix.needsUpdate = true;
			if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
			mesh.computeBoundingSphere();
			this.parts.add(mesh);
			if (look === "solid") continue;
			// The look's depth pre-pass, sharing the instances; drawn right before the look's color pass.
			const rank = SEE_THROUGH.findIndex((s) => s.look === look);
			const depth = new THREE.InstancedMesh(mesh.geometry, this.materials.depth[look], list.length);
			depth.instanceMatrix = mesh.instanceMatrix;
			depth.boundingSphere = mesh.boundingSphere;
			depth.renderOrder = PARTS_ORDER + rank * 2;
			mesh.renderOrder = PARTS_ORDER + rank * 2 + 1;
			this.parts.add(depth);
		}
		// Meshes and unions drawn as boxes: a thin outline says "a bounding box, not the real shape".
		if (outlined.length) {
			const positions = new Float32Array(outlined.length * BOX_EDGES.length);
			const v = new THREE.Vector3();
			outlined.forEach((i, k) => {
				const matrix = matrixOf(i, 1);
				for (let e = 0; e < BOX_EDGES.length; e += 3) {
					v.set(BOX_EDGES[e] as number, BOX_EDGES[e + 1] as number, BOX_EDGES[e + 2] as number).applyMatrix4(matrix);
					positions.set([v.x, v.y, v.z], k * BOX_EDGES.length + e);
				}
			});
			const lines = new THREE.BufferGeometry();
			lines.setAttribute("position", new THREE.BufferAttribute(positions, 3));
			const outline = new THREE.LineSegments(lines, this.outlineMaterial);
			outline.renderOrder = 5;
			this.parts.add(outline);
		}
	}

	private applyBand(): void {
		const band = this.options.band;
		const [top, bottom] = this.clip as [THREE.Plane, THREE.Plane];
		top.constant = band ? band[1] : 1e6;
		bottom.constant = band ? -band[0] : 1e6;
	}

	private inBand(y: number | null | undefined): boolean {
		const band = this.options.band;
		return !band || y === null || y === undefined || (y >= band[0] - 3 && y <= band[1] + 3);
	}

	private buildMarks(): void {
		for (const child of [...this.marks.children]) {
			this.marks.remove(child);
			const o = child as THREE.Mesh;
			o.geometry?.dispose();
			(o.material as THREE.Material)?.dispose();
		}
		this.pickPoints = [];
		this.pickCells = [];
		const flat = this.options.mode === "2d";
		const floorY = this.options.band ? this.options.band[0] : this.bounds ? this.bounds.min[1] + this.options.offset[1] : 0;
		// 3D: before the see-through parts (a wall tints what's behind it, and hides nothing). 2D: after them, on top.
		let order = flat ? PARTS_ORDER * 2 : 10;
		for (const layer of this.layers) {
			const color = new THREE.Color(layer.color);
			const cells = (layer.cells ?? []).filter((c) => this.inBand(c.y));
			if (cells.length) {
				const size = layer.cellSize ?? 1;
				const plane = new THREE.PlaneGeometry(1, 1);
				plane.rotateX(-Math.PI / 2);
				const mesh = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthTest: !flat, depthWrite: false, side: THREE.DoubleSide }), cells.length);
				const max = Math.max(...cells.map((c) => c.n));
				const m = new THREE.Matrix4();
				const heat = new THREE.Color();
				cells.forEach((c, k) => {
					const y = (c.y ?? floorY + 3) - 2.8;
					m.makeScale(size, 1, size).setPosition(c.x + size / 2, y, c.z + size / 2);
					mesh.setMatrixAt(k, m);
					const [r, g, b] = heatColor(Math.log1p(c.n) / Math.log1p(max));
					mesh.setColorAt(k, heat.setRGB(r, g, b));
				});
				mesh.renderOrder = order++;
				mesh.instanceMatrix.needsUpdate = true;
				mesh.computeBoundingSphere();
				this.marks.add(mesh);
				this.pickCells.push(mesh);
			}
			for (const polygon of layer.polygons ?? []) {
				if (polygon.length < 3 || !polygon.every((p) => this.inBand(p.y))) continue;
				const vertices: number[] = [];
				for (let k = 1; k < polygon.length - 1; k++) for (const p of [polygon[0], polygon[k], polygon[k + 1]] as MapPoint[]) vertices.push(p.x, p.y, p.z);
				const g = new THREE.BufferGeometry();
				g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
				const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthTest: !flat, depthWrite: false, side: THREE.DoubleSide }));
				fill.renderOrder = order++;
				this.marks.add(fill);
			}
			const points = (layer.points ?? []).filter((p) => this.inBand(p.y));
			if (points.length && !cells.length) {
				const g = new THREE.BufferGeometry();
				g.setAttribute("position", new THREE.Float32BufferAttribute(points.flatMap((p) => [p.x, p.y, p.z]), 3));
				const dots = new THREE.Points(g, new THREE.PointsMaterial({ color, size: layer.pointSize ?? 7, sizeAttenuation: false, depthTest: !flat, transparent: flat }));
				dots.renderOrder = order++;
				this.marks.add(dots);
				for (const p of points) this.pickPoints.push(new THREE.Vector3(p.x, p.y, p.z));
			}
			for (const path of layer.paths ?? []) {
				const kept = path.filter((p) => this.inBand(p.y));
				if (kept.length < 2) continue;
				const g = new THREE.BufferGeometry().setFromPoints(kept.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
				const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: !flat, transparent: flat }));
				line.renderOrder = order++;
				this.marks.add(line);
			}
		}
	}

	private buildGrid(): void {
		if (this.grid) {
			this.scene.remove(this.grid);
			this.grid.dispose();
			this.grid = null;
		}
		const b = this.bounds;
		if (!b) return;
		const o = this.options.offset;
		const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 16);
		const step = span > 1500 ? 64 : span > 400 ? 16 : 8;
		const size = Math.ceil((span * 1.2) / step) * step;
		this.grid = new THREE.GridHelper(size, size / step, 0x888888, 0x888888);
		const material = this.grid.material as THREE.Material;
		material.transparent = true;
		material.opacity = 0.18;
		material.depthWrite = false;
		const y = this.options.band ? this.options.band[0] : b.min[1] + o[1];
		this.grid.position.set((b.min[0] + b.max[0]) / 2 + o[0], y - 0.05, (b.min[2] + b.max[2]) / 2 + o[2]);
		this.scene.add(this.grid);
	}

	/** Points the camera at the whole map. */
	fit(): void {
		const b = this.bounds;
		const o = this.options.offset;
		const center = b ? new THREE.Vector3((b.min[0] + b.max[0]) / 2 + o[0], (b.min[1] + b.max[1]) / 2 + o[1], (b.min[2] + b.max[2]) / 2 + o[2]) : new THREE.Vector3();
		const spanX = b ? b.max[0] - b.min[0] : 100;
		const spanZ = b ? b.max[2] - b.min[2] : 100;
		const radius = Math.max(spanX, spanZ, 20) / 2;
		const topY = (b ? b.max[1] + o[1] : 100) + 1000;
		if (this.options.mode === "2d") {
			this.ortho.position.set(center.x, topY, center.z);
			this.ortho.lookAt(center.x, center.y, center.z);
			const { width, height } = this.size();
			const aspect = width / height;
			const halfH = Math.max(spanZ / 2, spanX / 2 / aspect) * 1.08;
			this.ortho.left = -halfH * aspect;
			this.ortho.right = halfH * aspect;
			this.ortho.top = halfH;
			this.ortho.bottom = -halfH;
			this.ortho.zoom = 1;
			this.ortho.far = topY - (b ? b.min[1] + o[1] : -100) + 2000;
			this.ortho.updateProjectionMatrix();
		} else {
			this.perspective.position.set(center.x + radius * 0.9, center.y + radius * 1.1, center.z + radius * 1.3);
			this.perspective.far = Math.max(20_000, radius * 20);
			this.perspective.updateProjectionMatrix();
		}
		this.controls.target.copy(center);
		this.controls.update();
	}

	private size(): { width: number; height: number } {
		return { width: Math.max(1, this.host.clientWidth), height: Math.max(1, this.host.clientHeight) };
	}

	private fitSize(): void {
		const { width, height } = this.size();
		this.renderer.setSize(width, height, false);
		this.renderer.domElement.style.width = "100%";
		this.renderer.domElement.style.height = "100%";
		this.perspective.aspect = width / height;
		this.perspective.updateProjectionMatrix();
		const halfH = (this.ortho.top - this.ortho.bottom) / 2;
		this.ortho.left = -halfH * (width / height);
		this.ortho.right = halfH * (width / height);
		this.ortho.updateProjectionMatrix();
		this.render();
	}

	render(): void {
		if (this.disposed || this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			if (!this.disposed) this.renderer.render(this.scene, this.camera);
		});
	}

	/**
	 * What a click or hover at a point of the canvas lands on, as world x / z. 2D: the point itself (worldAt). 3D (the map's floor
	 * is not a plane to unproject onto): the layers' dot nearest on screen within `radius` px, else the heat cell under the pointer
	 * (a ray), else null.
	 */
	pickAt(clientX: number, clientY: number, radius = 14): { x: number; z: number } | null {
		if (this.options.mode === "2d") return this.worldAt(clientX, clientY);
		const rect = this.renderer.domElement.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		let best: THREE.Vector3 | null = null;
		let bestD = radius * radius;
		const v = new THREE.Vector3();
		for (const p of this.pickPoints) {
			v.copy(p).project(this.perspective);
			if (v.z < -1 || v.z > 1) continue; // behind the camera or past its far plane
			const dx = ((v.x + 1) / 2) * rect.width - px;
			const dy = ((1 - v.y) / 2) * rect.height - py;
			const d = dx * dx + dy * dy;
			if (d <= bestD) {
				bestD = d;
				best = p;
			}
		}
		if (best) return { x: best.x, z: best.z };
		if (!this.pickCells.length) return null;
		this.raycaster.setFromCamera(new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1), this.perspective);
		const hit = this.raycaster.intersectObjects(this.pickCells, false)[0];
		return hit ? { x: hit.point.x, z: hit.point.z } : null;
	}

	/** World x / z under a point of the canvas (2D only; null in 3D). */
	worldAt(clientX: number, clientY: number): { x: number; z: number } | null {
		if (this.options.mode !== "2d") return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const v = new THREE.Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0).unproject(this.ortho);
		return { x: v.x, z: v.z };
	}

	private readonly onKey = (event: KeyboardEvent): void => {
		const key = event.key.toLowerCase();
		if (!"wasdqe".includes(key) && key !== "shift") return;
		if (this.options.mode !== "3d") return;
		if (event.type === "keydown") this.keys.add(key);
		else this.keys.delete(key);
		event.preventDefault();
		if (this.keys.size && !this.flying) this.fly(performance.now());
	};

	private fly(last: number): void {
		this.flying = requestAnimationFrame((now) => {
			this.flying = 0;
			if (this.disposed || !this.keys.size || this.options.mode !== "3d") return;
			const dt = Math.min(0.05, (now - last) / 1000);
			const forward = new THREE.Vector3();
			this.perspective.getWorldDirection(forward);
			const right = new THREE.Vector3().crossVectors(forward, this.perspective.up).normalize();
			const move = new THREE.Vector3();
			if (this.keys.has("w")) move.add(forward);
			if (this.keys.has("s")) move.sub(forward);
			if (this.keys.has("d")) move.add(right);
			if (this.keys.has("a")) move.sub(right);
			if (this.keys.has("e")) move.y += 1;
			if (this.keys.has("q")) move.y -= 1;
			const distance = this.perspective.position.distanceTo(this.controls.target);
			move.normalize().multiplyScalar(Math.max(20, distance * 0.6) * dt * (this.keys.has("shift") ? 3 : 1));
			this.perspective.position.add(move);
			this.controls.target.add(move);
			this.controls.update();
			this.fly(now);
		});
	}

	dispose(): void {
		this.disposed = true;
		cancelAnimationFrame(this.frame);
		cancelAnimationFrame(this.flying);
		this.resize.disconnect();
		this.controls.dispose();
		this.renderer.domElement.removeEventListener("keydown", this.onKey);
		this.renderer.domElement.removeEventListener("keyup", this.onKey);
		this.geometry = null;
		this.layers = [];
		this.buildParts();
		this.buildMarks();
		for (const s of this.shapes) s.dispose();
		for (const m of [...Object.values(this.materials.color), ...Object.values(this.materials.depth)]) m.dispose();
		this.outlineMaterial.dispose();
		this.grid?.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}
}
