/**
 * The 2D minimap / 3D map of one map (plans/33): a thin React wrapper around MapRenderer (three.js). Loaded lazily
 * (`React.lazy(() => import("@/components/maps/MapScene"))`), so three.js stays out of the main bundle.
 *
 * Props are plain data: the decoded geometry and its bounds, the view (2D / 3D), the offset that puts the geometry where
 * the game plays it, the Y band, and the layers in world coordinates (lib/maps.ts MapLayer). Any page with positions
 * (the recordings explorer's paths, replays, quits) draws on it by passing layers.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import type { Bounds, MapGeometry, MapLayer, Vec3 } from "@/lib/maps";
import { MapRenderer, type MapMode } from "./map-renderer";

export interface MapSceneProps {
	geometry: MapGeometry | null;
	bounds: Bounds | null;
	mode: MapMode;
	layers?: MapLayer[];
	offset?: Vec3;
	band?: [number, number] | null;
	showInvisible?: boolean;
	tintMeshes?: boolean;
	className?: string;
}

const NO_OFFSET: Vec3 = [0, 0, 0];

export default function MapScene({ geometry, bounds, mode, layers = [], offset = NO_OFFSET, band = null, showInvisible = false, tintMeshes = false, className }: MapSceneProps) {
	const host = useRef<HTMLDivElement>(null);
	const renderer = useRef<MapRenderer | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);

	useEffect(() => {
		if (!host.current) return;
		try {
			renderer.current = new MapRenderer(host.current);
		} catch (error) {
			setFailed(`The map needs WebGL, which this browser didn't start (${(error as Error).message}).`);
		}
		return () => {
			renderer.current?.dispose();
			renderer.current = null;
		};
	}, []);

	useEffect(() => {
		renderer.current?.update(geometry, bounds, layers, { mode, offset, band, showInvisible, tintMeshes });
	}, [geometry, bounds, layers, mode, offset, band, showInvisible, tintMeshes]);

	return (
		<div className={cn("relative h-full w-full overflow-hidden rounded-md border bg-muted/30", className)}>
			<div
				ref={host}
				className="h-full w-full"
				onPointerMove={(e) => setCursor(renderer.current?.worldAt(e.clientX, e.clientY) ?? null)}
				onPointerLeave={() => setCursor(null)}
			/>
			{failed ? <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">{failed}</div> : null}
			<div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground tabular-nums">
				{mode === "2d" ? (cursor ? `x ${Math.round(cursor.x)}, z ${Math.round(cursor.z)} · drag to pan, wheel to zoom` : "drag to pan, wheel to zoom · north up") : "drag to turn, right drag to pan, wheel to zoom · click, then W A S D Q E to fly"}
			</div>
			<button type="button" className="absolute top-2 right-2 rounded border bg-background/80 px-2 py-1 text-xs hover:bg-background" onClick={() => renderer.current?.fit()}>
				Fit
			</button>
		</div>
	);
}
