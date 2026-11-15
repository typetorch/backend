/**
 * The renderer's pure parts (no WebGL here): the shapes are closed and wound outward (back faces are the inside, drawn
 * as the cut's cap), and the see-through looks draw one nearest surface per pixel (a depth pre-pass, then an equal-depth
 * color pass with a stencil bit each), pulled toward the camera so a wall's bottom doesn't z-fight the floor.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { partMaterials, patchMaterial, SEE_THROUGH, shapeGeometries } from "./map-renderer";

describe("shapes", () => {
	it("every triangle faces out of its shape (normal away from the shape's center)", () => {
		const names = ["ball", "block", "cylinder", "wedge", "cornerWedge"];
		shapeGeometries().forEach((geometry, k) => {
			const g = geometry.index ? geometry.toNonIndexed() : geometry;
			const p = g.getAttribute("position");
			const center = new THREE.Vector3();
			for (let i = 0; i < p.count; i++) center.add(new THREE.Vector3().fromBufferAttribute(p, i));
			center.divideScalar(p.count);
			let inward = 0;
			for (let i = 0; i < p.count; i += 3) {
				const [a, b, c] = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, i + j)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
				const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
				if (normal.lengthSq() < 1e-12) continue; // the sphere's degenerate pole triangles
				const mid = a.clone().add(b).add(c).divideScalar(3).sub(center);
				if (normal.dot(mid) <= 0) inward++;
			}
			expect({ shape: names[k], inward }).toEqual({ shape: names[k], inward: 0 });
		});
	});
});

describe("part materials", () => {
	const clip = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 9), new THREE.Plane(new THREE.Vector3(0, 1, 0), 2)];
	const m = partMaterials(clip);

	it("solids: opaque, both sides (the inside is the cap), clipped by the band", () => {
		expect(m.color.solid).toMatchObject({ transparent: false, depthWrite: true, side: THREE.DoubleSide, clippingPlanes: clip });
	});

	it("see-through looks: a depth-only pre-pass and an equal-depth color pass, the same polygon offset, a stencil bit each", () => {
		const bits = new Set<number>();
		for (const { look, opacity, bit } of SEE_THROUGH) {
			const depth = m.depth[look];
			const color = m.color[look];
			expect(depth).toMatchObject({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide, clippingPlanes: clip });
			expect(color).toMatchObject({ transparent: true, opacity, depthWrite: false, depthFunc: THREE.LessEqualDepth, side: THREE.DoubleSide, clippingPlanes: clip });
			for (const key of ["polygonOffset", "polygonOffsetFactor", "polygonOffsetUnits", "forceSinglePass"] as const) expect(color[key]).toBe(depth[key]);
			expect(color.polygonOffset && color.polygonOffsetFactor < 0 && color.polygonOffsetUnits < 0).toBe(true);
			// Blend only where the look's bit isn't set yet, then set it: one blend per pixel.
			expect(color).toMatchObject({ stencilWrite: true, stencilRef: bit, stencilFuncMask: bit, stencilWriteMask: bit, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
			bits.add(bit);
		}
		expect([...bits].reduce((a, b) => a | b, 0)).toBe([...bits].reduce((a, b) => a + b, 0)); // distinct single bits
	});

	it("the cap: back faces flat, see-through walls' caps more opaque, markers' not", () => {
		const shader = { fragmentShader: "x\n#include <opaque_fragment>\n" } as THREE.WebGLProgramParametersWithUniforms;
		m.color.wall.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
		expect(shader.fragmentShader).toContain("if (!gl_FrontFacing) { outgoingLight = diffuseColor.rgb * 1.000; diffuseColor.a = mix(diffuseColor.a, 1.0, 0.500); }");
		expect(m.color.marker.customProgramCacheKey()).toContain("1.0, 0.000");
		expect(m.color.solid.customProgramCacheKey()).toContain("* 0.450");
	});
});

describe("texture shader patches (plans/36 phase 5)", () => {
	const lambert = () => ({ vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} as Record<string, { value: unknown }> }) as unknown as THREE.WebGLProgramParametersWithUniforms;

	it("the solids' look: an instance attribute per part's Material, a uniform to switch it, the cap kept", () => {
		const look = { value: 1 };
		const m = partMaterials([], look);
		const shader = lambert();
		m.color.solid.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
		expect(shader.vertexShader).toContain("attribute float ttMaterial;");
		expect(shader.vertexShader).toContain("vTTMaterial = ttMaterial;");
		expect(shader.fragmentShader).toContain("float ttLook(float material, vec3 p, vec3 n)");
		expect(shader.fragmentShader).toContain("diffuseColor.rgb *= mix(1.0, ttLook(vTTMaterial, vTTLocal, vTTNormal), ttLookOn);");
		expect(shader.fragmentShader).toContain("if (!gl_FrontFacing)");
		expect(shader.uniforms.ttLookOn).toBe(look);
		// The see-through looks don't read the attribute (their meshes share the plain shapes).
		const wall = lambert();
		m.color.wall.onBeforeCompile(wall, {} as THREE.WebGLRenderer);
		expect(wall.vertexShader).not.toContain("ttMaterial");
		expect(m.color.solid.customProgramCacheKey()).not.toBe(partMaterials([]).color.solid.customProgramCacheKey());
	});

	it("a MaterialVariant tiles its map over the part in studs; a Decal / Texture quad places its map per instance", () => {
		const tile = { value: 8 };
		const variant = patchMaterial(new THREE.MeshLambertMaterial(), { tile });
		const v = lambert();
		variant.onBeforeCompile(v, {} as THREE.WebGLRenderer);
		expect(v.vertexShader).toContain("vMapUv = ttPlane(vTTLocal, normal) / max(ttStudsPerTile, 0.01);");
		expect(v.uniforms.ttStudsPerTile).toBe(tile);
		const surface = patchMaterial(new THREE.MeshLambertMaterial(), { surface: true });
		const s = lambert();
		surface.onBeforeCompile(s, {} as THREE.WebGLRenderer);
		expect(s.vertexShader).toContain("attribute vec4 ttUv;");
		expect(s.vertexShader).toContain("vMapUv = vec2(uv.x * ttUv.x + ttUv.z, 1.0 - ((1.0 - uv.y) * ttUv.y + ttUv.w));");
		expect(s.fragmentShader).toContain("diffuseColor *= vTTTint;");
		expect(new Set([variant.customProgramCacheKey(), surface.customProgramCacheKey()]).size).toBe(2);
	});
});
