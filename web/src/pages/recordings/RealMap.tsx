/**
 * The Recordings page on the real map (plans/33): when a map has an export (GET /v1/maps; names match the recordings'
 * map values without case or punctuation, no map = the lobby), its layers and replays draw through MapScene (three.js,
 * lazy) on the exported geometry, in 2D or 3D. Without an export the page keeps its SVG silhouette (MapView).
 *
 *   - Layers: each layer's cells (the query's frame: cell index -> studs from the frame's minX / minZ and cell size) as
 *     world cells or points. Heights: the cell's recorded average (recording layers carry it), else the floor under the
 *     cell from the geometry, else the renderer's floor. A 2D click picks the cell under it.
 *   - Replay: the path as a path layer, the current position as a point, the camera's direction as a cone.
 * The switches (Points / Heatmap, 2D / 3D, the cell size) live in the URL (lib/map-view.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { Box, Map as MapIcon } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { LoadingBlock } from "@/components/common";
import { ToggleChip } from "@/components/ToggleChip";
import { usePageParams } from "@/lib/hooks";
import { mapViewPatch, readMapView, type MapViewState } from "@/lib/map-view";
import { CELL_SIZES, exportFor, floorUnder, MAPS_KEY, mapsApi, recordingLayer, ROOT_HEIGHT, type CellSize, type MapGeometry, type MapInfo, type MapLayer } from "@/lib/maps";
import type { RecFrame, RecMapLayer } from "@/lib/types";
import { layerColor, layerName } from "./map";
import type { ReplayScene } from "./ReplayPlayer";

const MapScene = lazy(() => import("@/components/maps/MapScene"));

/** The cell size on the real map when the URL names none (finer than the query's own 4+ stud grid). */
export const REAL_MAP_CELL: CellSize = 2;

/** The exported maps (null while loading; [] when there are none or the list can't be read). */
export function useMapExports(): MapInfo[] | null {
	const list = useQuery({ queryKey: MAPS_KEY, queryFn: ({ signal }) => mapsApi.list(signal), retry: false, staleTime: 60_000 });
	if (list.isLoading) return null;
	return list.data?.maps.filter((m) => m.bounds !== null && m.parts > 0) ?? [];
}

/** The export for a recordings map name (null: none, or the list is still loading). */
export function useExportFor(name: string | null | undefined): { info: MapInfo | null; loading: boolean } {
	const maps = useMapExports();
	return { info: maps ? exportFor(maps, name) : null, loading: maps === null };
}

export function useMapGeometry(info: MapInfo | null) {
	return useQuery({
		queryKey: ["map-geometry", info?.name, info?.hash],
		queryFn: ({ signal }) => mapsApi.geometry(info?.name as string, signal),
		enabled: info !== null,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** The view state in the URL, and a setter. */
export function useMapView(): [MapViewState, (patch: Partial<MapViewState>) => void] {
	const [params, set] = usePageParams();
	return [readMapView(params), (patch) => set(mapViewPatch(patch))];
}

/** Points / Heatmap (left out with `draw: false`), 2D / 3D (only with a real map) and the cell size (real map only). */
export function ViewSwitches({ real, draw = true, cell, autoCell }: { real: boolean; draw?: boolean; cell?: boolean; autoCell?: number }) {
	const [state, set] = useMapView();
	const size = state.cell ?? REAL_MAP_CELL;
	return (
		<div className="flex flex-wrap items-center gap-3">
			{draw ? (
				<div className="flex gap-1" role="group" aria-label="Draw as">
					<ToggleChip pressed={state.draw === "points"} onClick={() => set({ draw: "points" })}>
						Points
					</ToggleChip>
					<ToggleChip pressed={state.draw === "heat"} onClick={() => set({ draw: "heat" })}>
						Heatmap
					</ToggleChip>
				</div>
			) : null}
			{real ? (
				<div className="flex gap-1" role="group" aria-label="View">
					<ToggleChip pressed={state.mode === "2d"} onClick={() => set({ mode: "2d" })}>
						<MapIcon /> 2D
					</ToggleChip>
					<ToggleChip pressed={state.mode === "3d"} onClick={() => set({ mode: "3d" })}>
						<Box /> 3D
					</ToggleChip>
				</div>
			) : null}
			{real && cell ? (
				<div className="flex flex-wrap items-center gap-1" role="group" aria-label="Cell size">
					<span className="text-xs text-muted-foreground">Cell</span>
					{CELL_SIZES.map((c) => (
						<ToggleChip key={c} pressed={size === c} onClick={() => set({ cell: c === REAL_MAP_CELL ? null : c })}>
							{c} stud{c === 1 ? "" : "s"}
						</ToggleChip>
					))}
				</div>
			) : !real && cell && autoCell ? (
				<span className="text-xs text-muted-foreground">Cells of {autoCell} studs (no map export: the recordings' own grid)</span>
			) : null}
		</div>
	);
}

/** The scene on the real map, once its geometry loads (an error falls back to `fallback`). */
function Scene({ info, layers, onPick, label, fallback }: { info: MapInfo; layers: MapLayer[]; onPick?: (p: { x: number; z: number }) => void; label: string; fallback: React.ReactNode }) {
	const [state] = useMapView();
	const geometry = useMapGeometry(info);
	if (geometry.error) return <>{fallback}</>;
	return (
		<div className="h-[min(70vh,44rem)] min-h-80" data-testid="real-map" data-map={info.name}>
			<Suspense fallback={<LoadingBlock rows={6} />}>
				<MapScene geometry={geometry.data ?? null} bounds={info.bounds} mode={state.mode} layers={layers} offset={info.offset} label={label} {...(onPick ? { onPick } : {})} />
			</Suspense>
		</div>
	);
}

/** The map layers tab's layers as world layers (heat cells or points), the picked cell outlined. */
export function worldLayers(layers: readonly RecMapLayer[], frame: RecFrame, draw: "heat" | "points", geometry: MapGeometry | null | undefined, offset: MapInfo["offset"], selected: [number, number] | null): MapLayer[] {
	const floor = geometry ? (x: number, z: number) => floorUnder(geometry, x, z, offset) : undefined;
	const out: MapLayer[] = layers.map((l, i) => {
		const world = recordingLayer({ id: l.id, label: layerName(l.id), color: layerColor(l.id, i), cells: l.cells, ...(l.cell !== undefined ? { cell: l.cell } : {}) }, frame, floor);
		return draw === "heat" ? { ...world, points: [] } : { ...world, cells: [] };
	});
	if (selected) {
		const x0 = frame.minX + selected[0] * frame.cell;
		const z0 = frame.minZ + selected[1] * frame.cell;
		const hit = layers.flatMap((l) => l.cells).find((c) => c[0] === selected[0] && c[1] === selected[1] && c[3] !== undefined);
		const y = hit?.[3] !== undefined ? (hit[3] as number) - ROOT_HEIGHT + 0.3 : ((floor?.(x0 + frame.cell / 2, z0 + frame.cell / 2) ?? 0) + 0.3);
		const c = frame.cell;
		out.push({ id: "selected", label: "Picked cell", color: "#f8fafc", paths: [[{ x: x0, y, z: z0 }, { x: x0 + c, y, z: z0 }, { x: x0 + c, y, z: z0 + c }, { x: x0, y, z: z0 + c }, { x: x0, y, z: z0 }]] });
	}
	return out;
}

export function RealLayersMap({
	info,
	frame,
	layers,
	selected,
	onCellClick,
	label,
	fallback,
}: {
	info: MapInfo;
	frame: RecFrame;
	layers: readonly RecMapLayer[];
	selected: [number, number] | null;
	onCellClick: (col: number, row: number) => void;
	label: string;
	fallback: React.ReactNode;
}) {
	const [state] = useMapView();
	const geometry = useMapGeometry(info);
	const world = useMemo(() => worldLayers(layers, frame, state.draw, geometry.data, info.offset, selected), [layers, frame, state.draw, geometry.data, info.offset, selected]);
	const pick = (p: { x: number; z: number }) => {
		const col = Math.floor((p.x - frame.minX) / frame.cell);
		const row = Math.floor((p.z - frame.minZ) / frame.cell);
		if (col >= 0 && row >= 0 && col < frame.cols && row < frame.rows) onCellClick(col, row);
	};
	return <Scene info={info} layers={world} onPick={pick} label={label} fallback={fallback} />;
}

/** The replay's layers in world studs: the whole path faint, the played part, the camera cone, the character. */
export function replayLayers(scene: ReplayScene): MapLayer[] {
	const pose = scene.pose;
	const y = pose?.y ?? scene.passed[scene.passed.length - 1]?.y ?? 0;
	const out: MapLayer[] = [
		{ id: "replay-all", label: "Path", color: "#93c5fd", paths: [scene.path] },
		{ id: "replay-passed", label: "Path so far", color: "#2563eb", paths: [scene.passed] },
	];
	if (scene.cone) out.push({ id: "replay-cone", label: "Camera", color: "#f59e0b", polygons: [scene.cone.map(([x, z]) => ({ x, y, z }))] });
	if (pose) out.push({ id: "replay-dot", label: "Player", color: "#ef4444", points: [{ x: pose.x, y, z: pose.z }], pointSize: 12 });
	return out;
}

export function RealReplayMap({ info, scene, label, fallback }: { info: MapInfo; scene: ReplayScene; label: string; fallback: React.ReactNode }) {
	const layers = useMemo(() => replayLayers(scene), [scene]);
	return <Scene info={info} layers={layers} label={label} fallback={fallback} />;
}
