/**
 * The default avatars (no WebGL here, plain three objects): R6 and R15 rest poses put the parts where Roblox's rigs
 * do, a Transform rotates a part about its joint like a Motor6D (Part1 = Part0 * C0 * Transform * C1:Inverse()), the
 * root follows the replay's yaw convention (0 = facing -Z, right = +X), and clothing faces land on the classic
 * 585x559 template's rectangles, upright and unmirrored from outside.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { clothingRect, createAvatar, placeAvatar, R15_JOINTS, R6_JOINTS, TEMPLATE_HEIGHT, TEMPLATE_WIDTH, type Avatar, type Quat } from "./avatar";

function at(avatar: Avatar, part: string, local: [number, number, number] = [0, 0, 0]): [number, number, number] {
	avatar.root.updateMatrixWorld(true);
	const node = avatar.root.getObjectByName(part);
	if (!node) throw new Error(`no part ${part}`);
	const v = new THREE.Vector3(...local).applyMatrix4(node.matrixWorld);
	return [round(v.x), round(v.y), round(v.z)];
}

const round = (v: number) => Math.round(v * 1000) / 1000 + 0;

const quat = (axis: [number, number, number], degrees: number): Quat => {
	const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), (degrees * Math.PI) / 180);
	return [q.x, q.y, q.z, q.w];
};

describe("R6", () => {
	it("names Roblox's six Motor6Ds", () => {
		expect(createAvatar("R6").joints).toEqual(["RootJoint", "Neck", "Left Shoulder", "Right Shoulder", "Left Hip", "Right Hip"]);
		expect(R6_JOINTS).toHaveLength(6);
	});

	it("rest pose: torso at the root, head 1.5 above, arms at x ±1.5, legs at x ±0.5 and 2 below (right = +X)", () => {
		const a = createAvatar("R6");
		expect(at(a, "Torso")).toEqual([0, 0, 0]);
		expect(at(a, "Head")).toEqual([0, 1.5, 0]);
		expect(at(a, "Right Arm")).toEqual([1.5, 0, 0]);
		expect(at(a, "Left Arm")).toEqual([-1.5, 0, 0]);
		expect(at(a, "Right Leg")).toEqual([0.5, -2, 0]);
		expect(at(a, "Left Leg")).toEqual([-0.5, -2, 0]);
		// the feet 3 studs under the root (the root's height above the floor)
		expect(at(a, "Left Leg", [0, -1, 0])[1]).toBe(-3);
	});

	it("parts keep their orientation in the rest pose (C0 * C1:Inverse() is a pure offset)", () => {
		const a = createAvatar("R6");
		a.root.updateMatrixWorld(true);
		for (const name of ["Torso", "Head", "Right Arm", "Left Leg"]) {
			const q = new THREE.Quaternion();
			a.root.getObjectByName(name)?.getWorldQuaternion(q);
			expect(Math.abs(q.w)).toBeCloseTo(1, 6);
		}
	});

	it("a +90 degree Right Shoulder Transform (about the joint's Z) swings the arm forward (-Z) to shoulder height", () => {
		// The shoulder's C0 is turned 90 degrees about Y, so its Z axis is the torso's +X: rotating about it lifts the arm
		// toward the character's front, as Roblox's Motor6D does for a positive angle on the right shoulder.
		const a = createAvatar("R6");
		expect(at(a, "Right Arm", [0, -1, 0])).toEqual([1.5, -1, 0]);
		a.setPose({ "Right Shoulder": quat([0, 0, 1], 90) });
		expect(at(a, "Right Arm", [0, -1, 0])).toEqual([1.5, 0.5, -1.5]);
		// the other arm stays put
		expect(at(a, "Left Arm", [0, -1, 0])).toEqual([-1.5, -1, 0]);
		// a pose without the joint puts it back to rest
		a.setPose({});
		expect(at(a, "Right Arm", [0, -1, 0])).toEqual([1.5, -1, 0]);
	});

	it("the RootJoint turns the whole body; the root follows the replay's yaw (0 = facing -Z)", () => {
		const a = createAvatar("R6");
		placeAvatar(a, 10, 3, 5, Math.PI / 2);
		// facing -X: the character's right (+X at rest) is now -Z
		expect(at(a, "Right Arm")).toEqual([10, 3, 3.5]);
		expect(at(a, "Head")).toEqual([10, 4.5, 5]);
	});

	it("ignores unknown joints and non-finite or zero quaternions", () => {
		const a = createAvatar("R6");
		a.setPose({ Nope: quat([1, 0, 0], 45), Neck: [Number.NaN, 0, 0, 1], "Left Hip": [0, 0, 0, 0] });
		expect(at(a, "Head")).toEqual([0, 1.5, 0]);
		expect(at(a, "Left Leg")).toEqual([-0.5, -2, 0]);
	});
});

describe("R15", () => {
	it("names the 15 Motor6Ds", () => {
		expect(createAvatar("R15").joints).toEqual(R15_JOINTS);
		expect(R15_JOINTS).toHaveLength(15);
	});

	it("rest pose: torso pieces, head, arms at x ±1.5, legs at x ±0.5, feet 3 under the root (hip height 2)", () => {
		const a = createAvatar("R15");
		expect(at(a, "LowerTorso")).toEqual([0, -0.8, 0]);
		expect(at(a, "UpperTorso")).toEqual([0, 0.2, 0]);
		expect(at(a, "Head")).toEqual([0, 1.5, 0]);
		expect(at(a, "RightUpperArm")[0]).toBe(1.5);
		expect(at(a, "LeftHand")).toEqual([-1.5, -0.85, 0]);
		expect(at(a, "RightFoot")).toEqual([0.5, -2.85, 0]);
		expect(at(a, "LeftFoot", [0, -0.15, 0])[1]).toBe(-3);
		// arms 2 long like R6: from the shoulder top (1.0) to the hand's bottom (-1.0)
		expect(at(a, "RightUpperArm", [0, 0.45, 0])[1]).toBe(1);
		expect(at(a, "RightHand", [0, -0.15, 0])[1]).toBe(-1);
	});

	it("axis-aligned joints: +90 degrees about X on a shoulder points the arm forward (-Z); the elbow carries the hand", () => {
		const a = createAvatar("R15");
		a.setPose({ RightShoulder: quat([1, 0, 0], 90) });
		const hand = at(a, "RightHand");
		expect(hand[2]).toBeLessThan(-1.5);
		expect(hand[1]).toBeCloseTo(0.75, 3);
		a.setPose({ RightShoulder: quat([1, 0, 0], 90), RightElbow: quat([1, 0, 0], 90) });
		// bent up at the elbow: the hand rises above the shoulder
		expect(at(a, "RightHand")[1]).toBeGreaterThan(0.75);
	});
});

describe("clothing", () => {
	it("R6 faces on the classic template", () => {
		expect(clothingRect("R6", "Torso", "front", "shirt")).toEqual([231, 74, 128, 128]);
		expect(clothingRect("R6", "Torso", "back", "pants")).toEqual([427, 74, 128, 128]);
		expect(clothingRect("R6", "Torso", "top", "shirt")).toEqual([231, 8, 128, 64]);
		expect(clothingRect("R6", "Right Arm", "front", "shirt")).toEqual([217, 355, 64, 128]);
		expect(clothingRect("R6", "Right Arm", "right", "shirt")).toEqual([151, 355, 64, 128]);
		expect(clothingRect("R6", "Left Arm", "left", "shirt")).toEqual([374, 355, 64, 128]);
		expect(clothingRect("R6", "Left Leg", "back", "pants")).toEqual([440, 355, 64, 128]);
		expect(clothingRect("R6", "Right Leg", "bottom", "pants")).toEqual([217, 485, 64, 64]);
		// shirts don't cover legs, pants don't cover arms, nothing covers the head
		expect(clothingRect("R6", "Right Arm", "front", "pants")).toBeNull();
		expect(clothingRect("R6", "Left Leg", "front", "shirt")).toBeNull();
		expect(clothingRect("R6", "Head", "front", "shirt")).toBeNull();
	});

	it("R15 splits a face's rows across its segments; the ends take the up / down squares", () => {
		expect(clothingRect("R15", "RightUpperArm", "top", "shirt")).toEqual([217, 289, 64, 64]);
		expect(clothingRect("R15", "RightUpperArm", "bottom", "shirt")).toBeNull();
		expect(clothingRect("R15", "RightUpperArm", "front", "shirt")).toEqual([217, 355, 64, 128 * 0.45]);
		const lower = clothingRect("R15", "RightLowerArm", "front", "shirt") as number[];
		expect(lower[1]).toBeCloseTo(355 + 128 * 0.45, 6);
		expect(lower[3]).toBeCloseTo(128 * 0.4, 6);
		expect(clothingRect("R15", "LeftFoot", "bottom", "pants")).toEqual([308, 485, 64, 64]);
		expect(clothingRect("R15", "UpperTorso", "front", "shirt")).toEqual([231, 74, 128, 128 * 0.8]);
		expect(clothingRect("R15", "LowerTorso", "bottom", "pants")).toEqual([231, 204, 128, 64]);
		expect(clothingRect("R15", "LowerTorso", "top", "pants")).toBeNull();
	});

	it("the shirt shell maps the torso front's top right corner (character's right, seen on the viewer's left) to the rect's top left", () => {
		const a = createAvatar("R6");
		const shell = a.root.getObjectByName("Torso:shirt") as THREE.Mesh;
		const pos = shell.geometry.getAttribute("position");
		const nrm = shell.geometry.getAttribute("normal");
		const uv = shell.geometry.getAttribute("uv");
		let found = 0;
		for (let i = 0; i < pos.count; i++) {
			if (nrm.getZ(i) !== -1) continue;
			const [x, y] = [pos.getX(i), pos.getY(i)];
			const want = [(x > 0 ? 231 : 231 + 128) / TEMPLATE_WIDTH, 1 - (y > 0 ? 74 : 74 + 128) / TEMPLATE_HEIGHT];
			expect(uv.getX(i)).toBeCloseTo(want[0] as number, 6);
			expect(uv.getY(i)).toBeCloseTo(want[1] as number, 6);
			found++;
		}
		expect(found).toBe(6);
		// the shell has all six faces on the torso, only the faces with a rect elsewhere (an R15 hand: no top)
		expect(pos.count).toBe(36);
		const hand = createAvatar("R15").root.getObjectByName("RightHand:shirt") as THREE.Mesh;
		expect(hand.geometry.getAttribute("position").count).toBe(30);
	});

	it("faces wind outward (counter-clockwise from outside)", () => {
		const shell = createAvatar("R6").root.getObjectByName("Torso:pants") as THREE.Mesh;
		const p = shell.geometry.getAttribute("position");
		const n = shell.geometry.getAttribute("normal");
		for (let i = 0; i < p.count; i += 3) {
			const [a, b, c] = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, i + j)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
			const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
			expect(face.dot(new THREE.Vector3().fromBufferAttribute(n, i))).toBeGreaterThan(0);
		}
	});

	it("shows the shells only while an image is set; t-shirt decal likewise", () => {
		const a = createAvatar("R6");
		const shirt = a.root.getObjectByName("Right Arm:shirt") as THREE.Mesh;
		const pants = a.root.getObjectByName("Right Leg:pants") as THREE.Mesh;
		const tshirt = a.root.getObjectByName("Torso:tshirt") as THREE.Mesh;
		expect([shirt.visible, pants.visible, tshirt.visible]).toEqual([false, false, false]);
		const image = { width: 585, height: 559 } as unknown as HTMLImageElement;
		a.setClothing({ shirt: image, tshirt: image });
		expect([shirt.visible, pants.visible, tshirt.visible]).toEqual([true, false, true]);
		expect((shirt.material as THREE.MeshLambertMaterial).map).not.toBeNull();
		a.setClothing({ pants: image });
		expect([shirt.visible, pants.visible, tshirt.visible]).toEqual([false, true, false]);
		a.dispose();
	});
});

describe("looks", () => {
	it("body colours by the Look order (head, torso, left arm, right arm, left leg, right leg); defaults without one", () => {
		const a = createAvatar("R15", { colors: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"] });
		const color = (part: string) => ((a.root.getObjectByName(`${part}:body`) as THREE.Mesh).material as THREE.MeshLambertMaterial).color.getHexString();
		expect([color("Head"), color("UpperTorso"), color("LowerTorso"), color("LeftLowerArm"), color("RightHand"), color("LeftFoot"), color("RightUpperLeg")]).toEqual([
			"111111",
			"222222",
			"222222",
			"333333",
			"444444",
			"555555",
			"666666",
		]);
		a.setColors();
		expect(color("UpperTorso")).toBe("0d69ac");
	});

	it("meshes carry their part's name for picking; highlight and dispose don't throw", () => {
		const a = createAvatar("R6");
		expect(a.meshes.map((m) => m.userData.part)).toEqual(["Torso", "Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"]);
		const scene = new THREE.Scene();
		scene.add(a.root);
		a.setHighlight(true);
		a.setHighlight(false);
		expect(() => a.dispose()).not.toThrow();
		expect(scene.children).toHaveLength(0);
		expect(() => a.dispose()).not.toThrow();
	});
});
