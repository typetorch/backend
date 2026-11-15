/**
 * Plans/34: the server page's Live map tab: the built-in positions stream (2 Hz) on the exported map, each dot moved
 * between frames (drawn a second behind the newest), a trail of the last 20 s, and the game's `points` streams as
 * markers. The frames come from the page's stream poll (the page's watch makes the kernel post them).
 */
import { useMemo } from "react";
import { colorFor, isPlaced, latestValue, type LiveDot, playersAt, pointLayers, renderTime, SERVER_DELAY_MS, trails } from "@/lib/live-map";
import { useTicker, type StreamsState } from "@/lib/live-streams";
import { LiveMap } from "../live/LiveMap";

/** The dots and markers at the page's clock `now` (exported for the tests). */
export function serverMapData(streams: StreamsState, now: number) {
	const frames = streams.frames;
	const newest = frames[frames.length - 1]?.t;
	if (newest === undefined) return { dots: [] as LiveDot[], markers: [] };
	const at = renderTime(newest, now - streams.arrivedAt, SERVER_DELAY_MS);
	const players = playersAt(frames, at);
	const paths = trails(frames, at, players);
	const dots: LiveDot[] = players.filter(isPlaced).map((p) => ({ key: String(p.u), name: p.n, x: p.x, y: p.y, z: p.z, color: colorFor(p.u), trail: paths.get(p.u) ?? [] }));
	const markers = (streams.declared?.streams ?? [])
		.filter((s) => s.k === "points")
		.flatMap((s) => pointLayers(`game.${s.n}`, s.l ?? s.n, latestValue(frames, `game.${s.n}`)?.value, colorFor(`stream:${s.n}`)));
	return { dots, markers };
}

export function LiveMapTab({ active, streams }: { active: boolean; streams: StreamsState }) {
	const now = useTicker(active && streams.frames.length > 0);
	const { dots, markers } = useMemo(() => serverMapData(streams, now), [streams, now]);
	if (!active) return null;
	if (!streams.loaded) return <p className="text-sm text-muted-foreground">Waiting for the first positions...</p>;
	return (
		<div className="space-y-2">
			{streams.error ? (
				<p role="alert" className="text-sm text-destructive">
					{streams.error}
				</p>
			) : null}
			{!streams.frames.length ? <p className="text-sm text-muted-foreground">No positions yet: kernel 0.5.7+ posts them a second or two after this page connects.</p> : null}
			<LiveMap dots={dots} markers={markers} label="Live map of this server" />
		</div>
	);
}
