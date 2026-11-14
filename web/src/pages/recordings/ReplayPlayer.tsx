/**
 * One recorded session played back top-down: the path on the current map, a moving dot with the camera's direction as a
 * cone, and a timeline of inputs, events and confusion signals with a scrubber, play / pause and speed.
 */
import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ToggleChip } from "@/components/ToggleChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RecFrame, RecordingReplayResult } from "@/lib/types";
import { MapView, type ToView } from "./MapView";
import { cone, fmtClock, frameAround, mapAtTime, mapName, markers as buildMarkers, poseAt, stateAtTime } from "./map";

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

/** Draws the map `map` with the overlay; the page swaps in the map layer's frame and silhouette. */
export type RenderMap = (map: string, overlay: (toView: ToView) => ReactNode, fallback: RecFrame | null) => ReactNode;

const defaultRenderMap: RenderMap = (map, overlay, fallback) =>
	fallback ? <MapView frame={fallback} background={[]} overlay={overlay} label={`Replay on ${mapName(map)}`} /> : <p className="text-sm text-muted-foreground">No positions on this map.</p>;

export function ReplayPlayer({ replay, renderMap = defaultRenderMap, initialT = 0 }: { replay: RecordingReplayResult; renderMap?: RenderMap; initialT?: number }) {
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
	const state = stateAtTime(replay, t);
	const recent = marks.filter((m) => m.t <= t).slice(-6).reverse();
	const keys = (replay.inputs ?? []).filter((i) => i.type === "key" && i.t <= t).length;
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
				<span className="text-muted-foreground">
					{mapName(map)}
					{state.zone ? ` · zone ${state.zone}` : ""}
					{state.screen ? ` · screen ${state.screen}` : ""}
				</span>
			</div>
			<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
				<div className="min-w-0">{renderMap(map, overlay, fallback)}</div>
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
				<p className="text-xs text-muted-foreground">
					Marks: grey clicks and taps, purple buttons / screens / prompts, red deaths, orange the game's events, amber confusion signals. Click one to jump there.
				</p>
			</div>
		</div>
	);
}
