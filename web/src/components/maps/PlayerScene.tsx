/**
 * The replay's 3D scene with people in it (plans/36): the exported map (when there is one) through MapRenderer, the
 * recorded player and every recorded entity as actors, seen from the recorded camera ("player") or with the orbit
 * controls ("orbit"). Loaded lazily (three.js stays out of the main bundle); jsdom tests mock it.
 *
 *   - The recorded player: the default avatar of its Rig kind (R6 when unknown) at the tt-rec-1 root, facing the
 *     character yaw; hidden when the camera is inside its head (first person, as Roblox hides it locally).
 *   - Entities: a Humanoid model as the default avatar of its rig kind (R6 when unknown) wearing its Look (body colours,
 *     clothing from /api/v1/images, body colours alone until an image is ready or when there is none); anything else as
 *     a box of its size in its kind's colour. Created while alive, disposed when gone.
 *   - Poses: the playing clips (GET /api/v1/anims/<id>) blended with the recorded joints (ext-replay.ts blendPose).
 *   - While playing, the scene runs its own animation frames between the page's 10 Hz clock ticks (smooth motion).
 */
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "cn";
import { assetIdOf, loadAssetImage } from "@/lib/asset-images";
import type { Bounds, MapGeometry, MapLayer, Vec3 } from "@/lib/maps";
import type { ExtEntity, ExtLook, RecordingReplayResult } from "@/lib/types";
import { animIdOf, blendPose, cameraAt, entityAt, kindColor, poseTracks, recordedPose, rigAt, sampleClip, selfAt, tracksAt, viewAt, alive, type AnimClip, type Quat } from "@/pages/recordings/ext-replay";
import { createAvatar, placeAvatar, type Avatar, type AvatarKind } from "./avatar";
import { MapRenderer } from "./map-renderer";

export interface PlayerSceneProps {
	geometry: MapGeometry | null;
	bounds: Bounds | null;
	offset?: Vec3;
	replay: RecordingReplayResult;
	/** ms into the replay. */
	t: number;
	playing?: boolean;
	speed?: number;
	camera: "player" | "orbit";
	/** Clips by animation id (digits); null: none exported. */
	clips?: ReadonlyMap<string, AnimClip | null>;
	/** Extra world layers (the path, in the orbit view). */
	layers?: MapLayer[];
	selected?: number | null;
	onPick?: (entity: number | null) => void;
	onHover?: (entity: number | null, at: { left: number; top: number }) => void;
	label?: string;
	className?: string;
}

interface Actor {
	object: THREE.Object3D;
	avatar?: Avatar;
	box?: THREE.Mesh;
}

const NO_OFFSET: Vec3 = [0, 0, 0];
const NO_CLIPS: ReadonlyMap<string, AnimClip | null> = new Map();
const CLICK_PX = 5;

/** Decoded clothing images by asset id (shared by every actor). */
const decoded = new Map<string, Promise<HTMLImageElement | null>>();

function decodeAsset(id: string): Promise<HTMLImageElement | null> {
	let job = decoded.get(id);
	if (!job) {
		job = loadAssetImage(id).then(
			(image) =>
				image.state !== "ready"
					? null
					: new Promise<HTMLImageElement | null>((resolve) => {
							const img = new Image();
							img.onload = () => resolve(img);
							img.onerror = () => resolve(null);
							img.src = image.url;
						}),
		);
		decoded.set(id, job);
		// a 202 that never finished: try again next time
		void job.then((img) => (img ? undefined : decoded.delete(id)));
	}
	return job;
}

function avatarKind(rig: string | undefined): AvatarKind {
	return rig === "R15" ? "R15" : "R6";
}

function dress(avatar: Avatar, look: ExtLook | undefined, alive: () => boolean): void {
	if (!look) return;
	const slots = (["shirt", "pants", "tshirt", "face"] as const).map((slot) => [slot, assetIdOf(look[slot])] as const).filter(([, id]) => id !== null);
	if (!slots.length) return;
	void Promise.all(slots.map(async ([slot, id]) => [slot, await decodeAsset(id as string)] as const)).then((images) => {
		if (!alive()) return;
		avatar.setClothing(Object.fromEntries(images));
	});
}

export default function PlayerScene({ geometry, bounds, offset = NO_OFFSET, replay, t, playing = false, speed = 1, camera, clips = NO_CLIPS, layers, selected = null, onPick, onHover, label, className }: PlayerSceneProps) {
	const host = useRef<HTMLDivElement>(null);
	const renderer = useRef<MapRenderer | null>(null);
	const actors = useRef(new Map<number, Actor>());
	const [failed, setFailed] = useState<string | null>(null);
	const down = useRef<{ x: number; y: number } | null>(null);
	const ext = replay.extended ?? null;
	const tracks = useMemo(() => (ext ? poseTracks(ext) : new Map()), [ext]);
	const entities = useMemo(() => (ext?.entities ?? []).filter((e) => e.e !== 0), [ext]);
	const self = useMemo(() => ext?.entities.find((e) => e.e === 0), [ext]);

	useEffect(() => {
		if (!host.current) return;
		try {
			renderer.current = new MapRenderer(host.current);
		} catch (error) {
			setFailed(`The replay needs WebGL, which this browser didn't start (${(error as Error).message}).`);
		}
		const owned = actors.current;
		return () => {
			for (const actor of owned.values()) disposeActor(actor);
			owned.clear();
			renderer.current?.dispose();
			renderer.current = null;
		};
	}, []);

	// a new replay: its actors start over
	useEffect(() => {
		const owned = actors.current;
		return () => {
			for (const actor of owned.values()) {
				renderer.current?.actors.remove(actor.object);
				disposeActor(actor);
			}
			owned.clear();
		};
	}, [replay]);

	useEffect(() => {
		renderer.current?.update(geometry, bounds, layers ?? [], { mode: "3d", offset, band: null, decorative: false, markers: false });
	}, [geometry, bounds, layers, offset]);

	// what the scene shows at a moment (called per animation frame while playing)
	const draw = useRef<(at: number) => void>(() => undefined);
	draw.current = (at: number) => {
		const r = renderer.current;
		if (!r) return;
		const owned = actors.current;
		const poseFor = (e: number, avatar: Avatar) => {
			const playingClips = [];
			if (ext) {
				for (const track of tracksAt(ext, e, at)) {
					const id = animIdOf(track.anim.id);
					const clip = id ? clips.get(id) : null;
					if (clip) playingClips.push({ pose: sampleClip(clip, track.time, track.anim.looped), weight: track.weight, priority: clip.priority ?? 0, from: track.anim.from });
				}
			}
			const recorded = recordedPose(tracks, e, at);
			avatar.setPose(blendPose(playingClips, recorded) as Record<string, Quat>);
		};
		const ensure = (e: number, make: () => Actor) => {
			let actor = owned.get(e);
			if (!actor) {
				actor = make();
				actor.object.userData.actor = e;
				owned.set(e, actor);
				r.actors.add(actor.object);
			}
			return actor;
		};
		const drop = (e: number) => {
			const actor = owned.get(e);
			if (!actor) return;
			r.actors.remove(actor.object);
			disposeActor(actor);
			owned.delete(e);
		};
		const cam = cameraAt(replay, at);
		// the recorded player
		const root = selfAt(replay, at);
		if (root) {
			const actor = ensure(0, () => {
				const avatar = createAvatar(avatarKind(ext ? rigAt(ext, 0, at)?.rig : undefined), self?.look?.colors ? { colors: self.look.colors } : {});
				dress(avatar, self?.look, () => owned.get(0)?.avatar === avatar);
				return { object: avatar.root, avatar };
			});
			const avatar = actor.avatar as Avatar;
			placeAvatar(avatar, root.position[0], root.position[1], root.position[2], root.yaw);
			poseFor(0, avatar);
			const head = new THREE.Vector3(root.position[0], root.position[1] + 1.5, root.position[2]);
			const firstPerson = camera === "player" && cam !== null && head.distanceTo(new THREE.Vector3(...cam.position)) < 1.2;
			actor.object.visible = !firstPerson;
			avatar.setHighlight(selected === 0);
		} else drop(0);
		// everyone and everything else
		for (const ent of entities) {
			const state = alive(ent, at) ? entityAt(ent, at) : null;
			if (!state) {
				drop(ent.e);
				continue;
			}
			const actor = ensure(ent.e, () => makeEntity(ent, ext ? rigAt(ext, ent.e, at)?.rig : undefined, () => owned.has(ent.e)));
			if (actor.avatar) {
				placeAvatar(actor.avatar, state.position[0], state.position[1], state.position[2], state.yaw);
				poseFor(ent.e, actor.avatar);
				actor.avatar.setHighlight(selected === ent.e);
			} else {
				actor.object.position.set(...state.position);
				actor.object.rotation.set(0, state.yaw, 0);
				const material = actor.box?.material as THREE.MeshLambertMaterial | undefined;
				material?.emissive.setHex(selected === ent.e ? 0x444444 : 0x000000);
			}
		}
		if (camera === "player" && cam) r.setView({ position: cam.position, look: cam.look, fov: viewAt(replay, at).fov });
		else r.setView(null);
		r.render();
	};

	// the page's clock: draw at `t`; while playing, interpolate between its ticks
	useEffect(() => {
		const since = performance.now();
		draw.current(t);
		if (!playing) return;
		let frame = requestAnimationFrame(function step(now) {
			draw.current(t + Math.min(250, now - since) * speed);
			frame = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(frame);
	}, [t, playing, speed, camera, selected, clips, replay]);

	const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
		const start = down.current;
		down.current = null;
		if (!onPick || !start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_PX) return;
		const hit = renderer.current?.pickActor(e.clientX, e.clientY);
		onPick(hit ? (hit.userData.actor as number) : null);
	};

	return (
		<div className={cn("relative h-full w-full overflow-hidden", className)}>
			<div
				ref={host}
				className="h-full w-full"
				role="img"
				aria-label={label ?? "Replay"}
				style={onPick ? { cursor: "pointer" } : undefined}
				onPointerDown={(e) => {
					down.current = { x: e.clientX, y: e.clientY };
				}}
				onPointerUp={onPointerUp}
				onPointerMove={(e) => {
					if (!onHover || e.buttons !== 0) return;
					const rect = e.currentTarget.getBoundingClientRect();
					const hit = renderer.current?.pickActor(e.clientX, e.clientY);
					onHover(hit ? (hit.userData.actor as number) : null, { left: e.clientX - rect.left, top: e.clientY - rect.top });
				}}
				onPointerLeave={() => onHover?.(null, { left: 0, top: 0 })}
			/>
			{failed ? <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">{failed}</div> : null}
		</div>
	);
}

function makeEntity(ent: ExtEntity, rig: string | undefined, isAlive: () => boolean): Actor {
	if (ent.humanoid) {
		const avatar = createAvatar(avatarKind(rig), ent.look?.colors ? { colors: ent.look.colors } : {});
		dress(avatar, ent.look, isAlive);
		return { object: avatar.root, avatar };
	}
	const [x, y, z] = ent.size;
	const box = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.2, x), Math.max(0.2, y), Math.max(0.2, z)), new THREE.MeshLambertMaterial({ color: kindColor(ent.kind), transparent: true, opacity: 0.85 }));
	const group = new THREE.Group();
	group.add(box);
	return { object: group, box };
}

function disposeActor(actor: Actor): void {
	actor.avatar?.dispose();
	if (actor.box) {
		actor.box.geometry.dispose();
		(actor.box.material as THREE.Material).dispose();
	}
}
