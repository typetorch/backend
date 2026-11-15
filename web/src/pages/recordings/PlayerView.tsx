/**
 * The replay's Player view (plans/36): what the player saw, at the recorded viewport's aspect.
 *
 *   - The 3D scene from the recorded camera (any session: tt-rec-1 has the camera; FOV from tt-ext-1 View, else 70),
 *     with the recorded player, other players and tracked models (PlayerScene, lazy); "Free camera" orbits instead.
 *   - Over it: the recorded UI (UiOverlay, extended sessions), click / tap rings at the pointer's position, the latest
 *     button / screen / prompt as a caption, and "AFK" while the player was away (the extended streams paused).
 *   - Below: the legend by kind, what is on screen now with its animations (a clip plays when exported, else the
 *     recorded joints or the rest pose, with the animation's id shown), and the picked UI node's or entity's properties.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { LoadingBlock } from "@/components/common";
import { ToggleChip } from "@/components/ToggleChip";
import { useAnimClips } from "@/lib/anim-clips";
import type { Bounds } from "@/lib/maps";
import type { RecordingReplayResult } from "@/lib/types";
import { afkAt, alive, animIdOf, captionAt, captions, entityAt, entityNames, kindColor, ringsAt, tracksAt, viewAt } from "./ext-replay";
import { fmtClock } from "./map";
import { useExportFor, useMapGeometry } from "./RealMap";
import { UiOverlay, UiProperties } from "./UiOverlay";

const PlayerScene = lazy(() => import("@/components/maps/PlayerScene"));

/** A box around the recorded positions (the scene's grid) when the map has no export. */
export function boundsOfSamples(replay: RecordingReplayResult): Bounds | null {
	let min: [number, number, number] | null = null;
	let max: [number, number, number] = [0, 0, 0];
	for (const s of replay.samples ?? []) {
		if (s[1] === null || s[2] === null || s[3] === null) continue;
		const p: [number, number, number] = [s[1], s[2], s[3]];
		if (!min) {
			min = [...p];
			max = [...p];
			continue;
		}
		for (let k = 0; k < 3; k++) {
			min[k] = Math.min(min[k] as number, p[k] as number);
			max[k] = Math.max(max[k] as number, p[k] as number);
		}
	}
	if (!min) return null;
	return { min: [min[0] - 20, min[1] - 4, min[2] - 20], max: [max[0] + 20, max[1] + 4, max[2] + 20] };
}

export function PlayerView({ replay, t, playing = false, speed = 1, map }: { replay: RecordingReplayResult; t: number; playing?: boolean; speed?: number; map: string }) {
	const ext = replay.extended ?? null;
	const [free, setFree] = useState(false);
	const [showUi, setShowUi] = useState(true);
	const [picked, setPicked] = useState<{ kind: "ui" | "entity"; id: number } | null>(null);
	const [hover, setHover] = useState<{ e: number; left: number; top: number } | null>(null);
	const exp = useExportFor(map);
	const geometry = useMapGeometry(exp.info);
	const fallbackBounds = useMemo(() => boundsOfSamples(replay), [replay]);
	const animIds = useMemo(() => [...new Set((ext?.anims ?? []).map((a) => animIdOf(a.id)).filter((id): id is string => id !== null))], [ext]);
	const clips = useAnimClips(animIds);
	const names = useMemo(() => (ext ? entityNames(ext) : new Map<number, string>()), [ext]);
	const captionList = useMemo(() => captions(replay), [replay]);
	const view = viewAt(replay, t);
	const afk = afkAt(ext, t);
	const caption = captionAt(captionList, t);
	const rings = ringsAt(replay, t);
	const onScreen = (ext?.entities ?? []).filter((e) => e.e !== 0 && alive(e, t) && entityAt(e, t));
	const kinds = [...new Set(onScreen.map((e) => (e.player ? "player" : e.kind)))].sort();
	const real = exp.info !== null;
	const pickedEntity = picked?.kind === "entity" ? (ext?.entities.find((e) => e.e === picked.id) ?? null) : null;
	const aspect = view.w / Math.max(1, view.h);
	const insetPct = (view.inset / Math.max(1, view.h)) * 100;

	return (
		<div className="space-y-2" data-testid="player-view">
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<div className="flex gap-1" role="group" aria-label="Camera">
					<ToggleChip pressed={!free} onClick={() => setFree(false)}>
						Recorded camera
					</ToggleChip>
					<ToggleChip pressed={free} onClick={() => setFree(true)}>
						Free camera
					</ToggleChip>
				</div>
				{ext?.ui.length ? (
					<ToggleChip pressed={showUi} onClick={() => setShowUi(!showUi)}>
						UI
					</ToggleChip>
				) : null}
				<span>
					{view.w}x{view.h} px, FOV {view.fov}
					{ext ? "" : " (assumed: no extended data)"}
					{real ? "" : " · no map export: people only"}
				</span>
			</div>
			<div className="mx-auto w-full" style={{ maxWidth: `calc(70vh * ${aspect.toFixed(4)})` }}>
				<div className="relative w-full overflow-hidden rounded-md border bg-slate-900" style={{ aspectRatio: `${view.w} / ${view.h}` }} data-testid="player-viewport" data-aspect={aspect.toFixed(3)}>
					<Suspense fallback={<LoadingBlock rows={4} />}>
						<PlayerScene
							geometry={geometry.data ?? null}
							bounds={exp.info?.bounds ?? fallbackBounds}
							offset={exp.info?.offset ?? [0, 0, 0]}
							replay={replay}
							t={t}
							playing={playing}
							speed={speed}
							camera={free ? "orbit" : "player"}
							clips={clips}
							selected={picked?.kind === "entity" ? picked.id : null}
							onPick={(e) => setPicked(e === null ? null : { kind: "entity", id: e })}
							onHover={(e, at) => setHover(e === null ? null : { e, ...at })}
							label={`Player view at ${fmtClock(t)}`}
						/>
					</Suspense>
					{ext && showUi && !free ? (
						<UiOverlay ui={ext.ui} t={t} viewport={{ w: view.w, h: view.h, inset: view.inset }} selected={picked?.kind === "ui" ? picked.id : null} onSelect={(i) => setPicked(i === null ? null : { kind: "ui", id: i })} />
					) : null}
					{!free
						? rings.map((r) => (
								<span
									key={`${r.t}-${r.x}-${r.y}`}
									data-testid="tap-ring"
									className="pointer-events-none absolute rounded-full border-2"
									style={{
										left: `${r.x * 100}%`,
										top: `calc(${r.y * 100}% + ${insetPct}%)`,
										width: `${1.5 + r.age * 3}rem`,
										height: `${1.5 + r.age * 3}rem`,
										transform: "translate(-50%, -50%)",
										borderColor: r.type === "tap" ? "#22d3ee" : "#f8fafc",
										opacity: 1 - r.age,
									}}
								/>
							))
						: null}
					{afk ? <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded bg-background/85 px-2 py-0.5 text-xs font-medium">AFK: extended streams paused</div> : null}
					{caption ? (
						<div className="pointer-events-none absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded bg-background/85 px-2 py-0.5 text-xs" data-testid="player-caption">
							{caption.label}
						</div>
					) : null}
					{hover ? (
						<div className="pointer-events-none absolute rounded bg-background/90 px-1.5 py-0.5 text-xs" style={{ left: hover.left + 12, top: hover.top + 12 }}>
							{names.get(hover.e) ?? `entity ${hover.e}`}
						</div>
					) : null}
				</div>
			</div>
			{ext ? (
				<div className="grid gap-3 text-xs md:grid-cols-2">
					<div className="space-y-1">
						<div className="font-medium">On screen</div>
						{kinds.length ? (
							<ul className="flex flex-wrap gap-2" aria-label="Legend">
								{kinds.map((k) => (
									<li key={k} className="flex items-center gap-1">
										<span className="inline-block size-2.5 rounded-sm" style={{ background: kindColor(k) }} />
										{k}
									</li>
								))}
							</ul>
						) : (
							<p className="text-muted-foreground">No other players or tracked models near the player.</p>
						)}
						<ul className="max-h-40 space-y-0.5 overflow-y-auto" data-testid="player-entities">
							{[...(ext.entities.some((e) => e.e === 0) ? [0] : []), ...onScreen.map((e) => e.e)].map((e) => {
								const anims = tracksAt(ext, e, t);
								return (
									<li key={e}>
										<button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setPicked({ kind: "entity", id: e })}>
											{names.get(e) ?? `entity ${e}`}
										</button>
										{anims.length ? (
											<span className="text-muted-foreground">
												{" "}
												playing{" "}
												{anims.map((a) => {
													const id = animIdOf(a.anim.id);
													const has = id ? clips.get(id) : null;
													return `${id ?? a.anim.id}${has ? "" : " (no clip)"}`;
												}).join(", ")}
											</span>
										) : null}
									</li>
								);
							})}
						</ul>
					</div>
					<div className="min-w-0">
						{picked?.kind === "ui" ? <UiProperties ui={ext.ui} i={picked.id} t={t} /> : null}
						{picked?.kind === "entity" ? <EntityProperties replay={replay} e={picked.id} name={names.get(picked.id) ?? `entity ${picked.id}`} entity={pickedEntity ?? null} t={t} /> : null}
						{!picked ? <p className="text-muted-foreground">Click a person, a model or a piece of the UI for its recorded properties.</p> : null}
					</div>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">This session has no extended recording: the Player view shows the recorded camera, the player and their clicks and taps (FOV assumed 70).</p>
			)}
		</div>
	);
}

function EntityProperties({ replay, e, name, entity, t }: { replay: RecordingReplayResult; e: number; name: string; entity: NonNullable<RecordingReplayResult["extended"]>["entities"][number] | null; t: number }) {
	const ext = replay.extended;
	const state = entity ? entityAt(entity, t) : null;
	const rows: [string, string][] = [["Entity", name]];
	if (entity) {
		rows.push(["Kind", entity.kind], ["Humanoid", entity.humanoid ? "yes" : "no"], ["Size", entity.size.map((v) => v.toFixed(1)).join(" x ")]);
		rows.push(["Seen", `${fmtClock(entity.from)} to ${entity.to === null ? "the end" : fmtClock(entity.to)}`]);
		if (state) rows.push(["Position", state.position.map((v) => v.toFixed(1)).join(", ")]);
		const look = entity.look;
		if (look?.shirt) rows.push(["Shirt", look.shirt]);
		if (look?.pants) rows.push(["Pants", look.pants]);
		if (look?.tshirt) rows.push(["T-shirt", look.tshirt]);
		if (look?.face) rows.push(["Face", look.face]);
	}
	const rig = ext?.rigs.filter((r) => r.e === e && r.t <= t).at(-1) ?? ext?.rigs.find((r) => r.e === e);
	if (rig) rows.push(["Rig", `${rig.rig} (${rig.joints.length} joints)`]);
	for (const track of ext ? tracksAt(ext, e, t) : []) rows.push([`Track ${track.anim.track}`, `${track.anim.id} · ${track.time.toFixed(2)} s · speed ${track.speed} · weight ${track.weight}${track.anim.looped ? " · looped" : ""}`]);
	return (
		<div className="max-h-64 overflow-auto rounded-md border p-2" data-testid="entity-properties">
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
				{rows.map(([k, v]) => (
					<div key={k} className="contents">
						<dt className="text-muted-foreground">{k}</dt>
						<dd className="break-all">{v}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
