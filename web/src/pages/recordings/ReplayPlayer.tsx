/**
 * One recorded session played back top-down: the path on the current map, a moving dot with the camera's direction as a
 * cone, and a timeline of inputs, events and confusion signals with a scrubber, play / pause and speed.
 *
 * plans/36: a "Player view" (PlayerView: the recorded camera, people, the recorded UI, taps) next to the map, the
 * default for sessions with extended data; under the timeline the AFK spans, a captions strip (buttons, screens,
 * prompts) and an FPS strip (tt-ext-1 View records, else the client tech rows).
 */
import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ToggleChip } from "@/components/ToggleChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MapPoint } from "@/lib/maps";
import type { RecFrame, RecordingReplayResult } from "@/lib/types";
import { captions as buildCaptions, fpsSeries } from "./ext-replay";
import { MapView, type ToView } from "./MapView";
import { cone, fmtClock, frameAround, mapAtTime, mapName, markers as buildMarkers, poseAt, stateAtTime, type Pose } from "./map";
import { PlayerView } from "./PlayerView";

export type ReplayCamera = "map" | "player";

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;
const TICK_MS = 100;

const WHY: Record<string, string> = {
	left: "the player left",
	window: "the 60 s window ran out",
	cap: "hit the size cap",
	end: "the server ended it",
};

export function whyLabel(why: string | null | undefined): string {
	return why ? (WHY[why] ?? why) : "unknown";
}

/** The replay at the current moment in world studs (the real map draws these; the SVG map uses the overlay). */
export interface ReplayScene {
	/** The whole path on this map, and the part played so far (t: ms into the session). */
	path: (MapPoint & { t?: number })[];
	passed: (MapPoint & { t?: number })[];
	pose: Pose | null;
	/** The camera's direction: [x, z] corners from the character (null without a yaw). */
	cone: [number, number][] | null;
}

/**
 * Draws the map `map` with the overlay (SVG, cell units) or the scene (world studs); the page swaps in the real map
 * when it has an export, else the map layer's frame and silhouette.
 */
export type RenderMap = (map: string, overlay: (toView: ToView) => ReactNode, fallback: RecFrame | null, scene: ReplayScene) => ReactNode;

const defaultRenderMap: RenderMap = (map, overlay, fallback) =>
	fallback ? <MapView frame={fallback} background={[]} overlay={overlay} label={`Replay on ${mapName(map)}`} /> : <p className="text-sm text-muted-foreground">No positions on this map.</p>;

/** The FPS strip: fps over the session (a line, 30 and 60 marked), the value now. */
export function FpsStrip({ series, duration, t }: { series: readonly [number, number][]; duration: number; t: number }) {
	if (series.length < 2 || duration <= 0) return null;
	const top = Math.max(60, ...series.map((p) => p[1]));
	const x = (ms: number) => Math.max(0, Math.min(100, (ms / duration) * 100));
	const y = (fps: number) => 30 - (Math.min(fps, top) / top) * 28;
	let now: number | null = null;
	for (const p of series) if (p[0] <= t) now = p[1];
	return (
		<div className="flex items-center gap-2" data-testid="replay-fps">
			<span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{now === null ? "fps" : `${Math.round(now)} fps`}</span>
			<svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full rounded bg-muted" role="img" aria-label="Frames per second over the session">
				<line x1="0" x2="100" y1={y(60)} y2={y(60)} stroke="currentColor" strokeOpacity={0.15} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
				<line x1="0" x2="100" y1={y(30)} y2={y(30)} stroke="#ef4444" strokeOpacity={0.35} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
				<polyline points={series.map((p) => `${x(p[0])},${y(p[1])}`).join(" ")} fill="none" stroke="#10b981" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
				<line x1={x(t)} x2={x(t)} y1="0" y2="32" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
			</svg>
		</div>
	);
}

export function ReplayPlayer({
	replay,
	renderMap = defaultRenderMap,
	initialT = 0,
	camera: cameraProp,
	onCameraChange,
}: {
	replay: RecordingReplayResult;
	renderMap?: RenderMap;
	initialT?: number;
	/** Map or Player view (controlled by the page, e.g. from the URL); default: Player view for extended sessions. */
	camera?: ReplayCamera;
	onCameraChange?: (camera: ReplayCamera) => void;
}) {
	const [cameraState, setCameraState] = useState<ReplayCamera>(replay.extended ? "player" : "map");
	const camera = cameraProp ?? cameraState;
	const setCamera = (c: ReplayCamera) => (onCameraChange ? onCameraChange(c) : setCameraState(c));
	const duration = replay.duration ?? 0;
	const samples = replay.samples ?? [];
	const [t, setT] = useState(Math.min(initialT, duration));
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState<number>(1);
	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => {
			setT((current) => {
				const next = current + TICK_MS * speed;
				if (next >= duration) {
					setPlaying(false);
					return duration;
				}
				return next;
			});
		}, TICK_MS);
		return () => clearInterval(timer);
	}, [playing, speed, duration]);
	const marks = useMemo(() => buildMarkers(replay), [replay]);
	const map = mapAtTime(replay.maps, t) ?? replay.map ?? "";
	// The path on the current map: samples whose map segment is this map.
	const onMap = useMemo(() => {
		const segments = replay.maps ?? [];
		return samples.filter((s) => s[1] !== null && s[3] !== null && mapAtTime(segments, s[0]) === map);
	}, [samples, replay.maps, map]);
	const fallback = useMemo(() => frameAround(onMap.map((s) => [s[1] as number, s[3] as number])), [onMap]);
	const pose = poseAt(onMap, t);
	const points = useMemo(() => onMap.map((s) => ({ x: s[1] as number, y: s[2] ?? 0, z: s[3] as number, t: s[0] })), [onMap]);
	const scene: ReplayScene = {
		path: points,
		passed: points.filter((p) => p.t <= t),
		pose,
		cone: pose ? cone(pose, 10) : null,
	};
	const state = stateAtTime(replay, t);
	const recent = marks.filter((m) => m.t <= t).slice(-6).reverse();
	const keys = (replay.inputs ?? []).filter((i) => i.type === "key" && i.t <= t).length;
	const captionList = useMemo(() => buildCaptions(replay), [replay]);
	const fps = useMemo(() => fpsSeries(replay), [replay]);
	const afk = replay.extended?.afk ?? [];
	const pct = (ms: number) => `${duration ? Math.max(0, Math.min(100, (ms / duration) * 100)) : 0}%`;
	const overlay = (toView: ToView) => {
		const passed = onMap.filter((s) => s[0] <= t);
		const line = (list: typeof onMap) => list.map((s) => toView(s[1] as number, s[3] as number).join(",")).join(" ");
		const view = pose ? toView(pose.x, pose.z) : null;
		const c = pose ? cone(pose, 3 * (fallback?.cell ?? 4)) : null;
		return (
			<g data-testid="replay-overlay">
				<polyline points={line(onMap)} fill="none" stroke="#3b82f6" strokeOpacity={0.25} strokeWidth={0.25} strokeLinejoin="round" />
				<polyline points={line(passed)} fill="none" stroke="#3b82f6" strokeWidth={0.35} strokeLinejoin="round" data-testid="replay-path" />
				{c ? <polygon points={c.map(([x, z]) => toView(x, z).join(",")).join(" ")} fill="#f59e0b" fillOpacity={0.35} data-testid="replay-cone" /> : null}
				{view ? <circle cx={view[0]} cy={view[1]} r={0.7} fill="#ef4444" stroke="white" strokeWidth={0.2} data-testid="replay-dot" data-x={pose?.x.toFixed(1)} data-z={pose?.z.toFixed(1)} /> : null}
			</g>
		);
	};
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<Badge variant="outline">{replay.dev ?? "unknown device"}</Badge>
				<Badge variant="outline" className="font-mono">
					{replay.art || "no build"}
				</Badge>
				<Badge variant={replay.why === "left" ? "destructive" : "secondary"}>Ended: {whyLabel(replay.why)}</Badge>
				{replay.gaps ? <Badge variant="outline">{replay.gaps} chunk(s) lost</Badge> : null}
				{replay.extended ? <Badge variant="secondary">Extended</Badge> : null}
				{replay.framework ? (
					<Badge variant="outline" className="font-mono" title="The TypeTorch framework that recorded it" data-testid="replay-framework">
						framework {replay.framework}
					</Badge>
				) : null}
				{replay.extended?.gaps ? <Badge variant="outline">{replay.extended.gaps} extended chunk(s) lost</Badge> : null}
				{replay.extended?.failed ? <Badge variant="outline" title={replay.extended.failed}>Extended data partly unreadable</Badge> : null}
				{replay.extended?.truncated ? <Badge variant="outline">Extended data cut at the size cap</Badge> : null}
				<div className="flex gap-1" role="group" aria-label="Replay view">
					<ToggleChip pressed={camera === "map"} onClick={() => setCamera("map")}>
						Map
					</ToggleChip>
					<ToggleChip pressed={camera === "player"} onClick={() => setCamera("player")}>
						Player view
					</ToggleChip>
				</div>
				<span className="text-muted-foreground">
					{mapName(map)}
					{state.zone ? ` · zone ${state.zone}` : ""}
					{state.screen ? ` · screen ${state.screen}` : ""}
				</span>
			</div>
			<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
				<div className="min-w-0">{camera === "player" ? <PlayerView replay={replay} t={t} playing={playing} speed={speed} map={map} /> : renderMap(map, overlay, fallback, scene)}</div>
				<div className="space-y-2 text-sm">
					<div className="font-medium">Just happened</div>
					{recent.length ? (
						<ul className="space-y-1" data-testid="replay-recent">
							{recent.map((m, i) => (
								<li key={`${m.t}-${i}`} className="flex gap-2">
									<span className="w-12 shrink-0 tabular-nums text-muted-foreground">{fmtClock(m.t)}</span>
									<span className="min-w-0 break-words">{m.label}</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground">Nothing yet.</p>
					)}
					<p className="text-xs text-muted-foreground">{keys} key presses so far</p>
				</div>
			</div>
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" size="sm" variant="default" aria-label={playing ? "Pause" : "Play"} onClick={() => (t >= duration ? (setT(0), setPlaying(true)) : setPlaying(!playing))}>
						{playing ? <Pause /> : <Play />}
					</Button>
					<Button type="button" size="sm" variant="outline" aria-label="Back to the start" onClick={() => setT(0)}>
						<RotateCcw />
					</Button>
					<span className="tabular-nums text-sm" data-testid="replay-clock">
						{fmtClock(t)} / {fmtClock(duration)}
					</span>
					<div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Speed">
						{SPEEDS.map((s) => (
							<ToggleChip key={s} pressed={speed === s} onClick={() => setSpeed(s)}>
								{s}x
							</ToggleChip>
						))}
					</div>
				</div>
				<input type="range" className="w-full" aria-label="Replay position" min={0} max={duration} step={TICK_MS} value={t} onChange={(e) => setT(Number(e.target.value))} />
				<div className="relative h-6 rounded bg-muted" data-testid="replay-timeline">
					{afk.map(([from, to], i) => (
						<div
							key={`afk-${i}`}
							data-testid="replay-afk"
							title={`AFK ${fmtClock(from)} to ${to === null ? "the end" : fmtClock(to)}`}
							className="pointer-events-none absolute top-0 h-6 rounded-sm bg-foreground/15"
							style={{ left: pct(from), width: `calc(${pct(to ?? duration)} - ${pct(from)})`, backgroundImage: "repeating-linear-gradient(45deg, transparent 0 4px, rgba(127,127,127,0.35) 4px 6px)" }}
						/>
					))}
					{marks.map((m, i) => (
						<button
							key={`${m.t}-${i}`}
							type="button"
							title={`${fmtClock(m.t)} ${m.label}`}
							aria-label={`${fmtClock(m.t)} ${m.label}`}
							onClick={() => setT(m.t)}
							className="absolute top-0 h-6 w-1 -translate-x-1/2 rounded-sm"
							style={{ left: `${duration ? (m.t / duration) * 100 : 0}%`, background: m.color, opacity: m.kind === "signal" ? 0.6 : 0.9 }}
						/>
					))}
					<div className="pointer-events-none absolute top-0 h-6 w-0.5 bg-foreground" style={{ left: `${duration ? (t / duration) * 100 : 0}%` }} />
				</div>
				{captionList.length ? (
					<div className="relative h-5 overflow-hidden rounded bg-muted/60" data-testid="replay-captions" aria-label="Buttons, screens and prompts">
						{captionList.map((c, i) => (
							<button
								key={`${c.t}-${i}`}
								type="button"
								onClick={() => setT(c.t)}
								title={`${fmtClock(c.t)} ${c.label}`}
								className="absolute top-0 h-5 max-w-24 truncate border-l-2 border-violet-500 px-1 text-left text-[10px] leading-5 hover:bg-background/60"
								style={{ left: pct(c.t) }}
							>
								{c.label}
							</button>
						))}
					</div>
				) : null}
				<FpsStrip series={fps} duration={duration} t={t} />
				<p className="text-xs text-muted-foreground">
					{afk.length ? "Hatched: AFK (the extended streams paused). " : ""}Marks: grey clicks and taps, purple buttons / screens / prompts, red deaths, orange the game's events, amber confusion signals. Click one to jump there.
				</p>
			</div>
		</div>
	);
}
