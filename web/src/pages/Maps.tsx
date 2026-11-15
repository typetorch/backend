/**
 * The Maps page (plans/33): each map's real geometry, exported from the place through Open Cloud (no Studio, no game
 * code), as a top-down 2D minimap or a 3D map, with the positioned events (`px`/`py`/`pz` props) drawn on it.
 *
 *   - The export card: the last export (when, place version, parts), "out of date" when Roblox has a newer place
 *     version, the Export button for owners (its progress while it runs), the map names no model was found for.
 *   - The map picker, 2D / 3D, the Y band (detected floors or a free range: geometry above and below is cut away, so an
 *     indoor floor shows in 2D), and what's drawn: the collision geometry by default (lib/maps.ts isDrawn), with
 *     toggles for decorative meshes and for markers.
 *   - Layers: one per positioned event; dots or heat cells of 0.5, 1 or 2 studs (the filter bar applies).
 *   - Alignment: whether the positioned events land on the geometry, else the recordings' positions on that map;
 *     owners apply the suggested offset or set a model path.
 * The map and the whole view (lib/map-view.ts) live in the URL: switching maps keeps the view. The three.js scene
 * (components/maps/MapScene) loads only when a map is shown.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Box, Download, Map as MapIcon, RefreshCw } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Section } from "@/components/common";
import { ToggleChip } from "@/components/ToggleChip";
import { BandControls } from "@/components/maps/BandControls";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isReadOnly, useAuth } from "@/lib/auth";
import { useAnalytics, usePageParams } from "@/lib/hooks";
import { fmtAgo, fmtBytes, fmtInt, fmtPct } from "@/lib/format";
import { bandFits, mapViewPatch, readMapView, resolveBand, type MapViewState } from "@/lib/map-view";
import {
	alignmentOf,
	CELL_SIZES,
	countKinds,
	detectFloors,
	eventLayers,
	LOBBY,
	MAPS_KEY,
	mapsApi,
	nameKey,
	partsText,
	recordingSamples,
	type MapInfo,
	type MapLayer,
	type MapsView,
	type Vec3,
} from "@/lib/maps";

const MapScene = lazy(() => import("@/components/maps/MapScene"));

export { MAPS_KEY };

const ALIGN_TEXT: Record<MapInfo["alignment"]["state"], { label: string; tone: string }> = {
	aligned: { label: "Aligned with where players are", tone: "bg-[var(--status-good)]/15 text-[var(--status-good)]" },
	partial: { label: "Partly aligned", tone: "bg-[var(--status-warn)]/15 text-[var(--status-warn)]" },
	off: { label: "Not aligned: players are elsewhere", tone: "bg-destructive/15 text-destructive" },
	unknown: { label: "Alignment unknown (too few positions)", tone: "bg-muted text-muted-foreground" },
};

export default function Maps() {
	const client = useQueryClient();
	const auth = useAuth();
	const list = useQuery({
		queryKey: MAPS_KEY,
		queryFn: ({ signal }) => mapsApi.list(signal),
		refetchInterval: (q) => (q.state.data?.export.state === "running" ? 1500 : false),
	});
	// Owners only (the server says so too; a viewer's session never gets the Export button or the override form).
	const view = list.data && isReadOnly(auth) ? { ...list.data, canExport: false } : list.data;
	const [params, setParams] = usePageParams();
	const picked = params.get("map");
	const maps = view?.maps ?? [];
	const map = maps.find((m) => m.name === picked) ?? maps[0] ?? null;

	const startExport = useMutation({
		mutationFn: () => mapsApi.export(),
		onSettled: () => client.invalidateQueries({ queryKey: MAPS_KEY }),
	});

	// When an export finishes, the geometry may have changed: refetch it.
	const exportState = view?.export.state;
	useEffect(() => {
		if (exportState === "done") void client.invalidateQueries({ queryKey: ["map-geometry"] });
	}, [exportState, client]);

	return (
		<div className="space-y-4">
			<PageHeader
				title="Maps"
				description="Each map's geometry from the place (hitboxes: parts, wedges, cylinders, balls; meshes and unions as boxes), as a 2D minimap or a 3D map, with where things happen on it."
				actions={
					<Button variant="outline" size="sm" onClick={() => void list.refetch()} disabled={list.isFetching}>
						<RefreshCw data-icon="inline-start" className={list.isFetching ? "animate-spin" : undefined} />
						Refresh
					</Button>
				}
			/>
			{list.isLoading ? <LoadingBlock rows={4} /> : list.error ? <ErrorState error={list.error} /> : view ? <ExportCard view={view} onExport={() => startExport.mutate()} exportError={startExport.error} starting={startExport.isPending} /> : null}
			{view && maps.length ? (
				<>
					<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Map">
						{maps.map((m) => (
							<ToggleChip key={m.name} pressed={m.name === map?.name} onClick={() => setParams({ map: m.name })}>
								{m.name === LOBBY ? "Lobby" : m.name}
								{m.kind === "map" && m.alignment.state === "off" ? <AlertTriangle className="text-[var(--status-warn)]" aria-label="not aligned" /> : null}
							</ToggleChip>
						))}
					</div>
					{map ? <MapPanel key={`${map.name}:${map.hash}`} map={map} view={view} /> : null}
				</>
			) : view && !list.isLoading ? (
				<EmptyState>{view.latest ? "The last export found no maps." : "No maps yet: export them from the place (owners)."}</EmptyState>
			) : null}
		</div>
	);
}

function ExportCard({ view, onExport, exportError, starting }: { view: MapsView; onExport: () => void; exportError: unknown; starting: boolean }) {
	const running = view.export.state === "running";
	const latest = view.latest;
	const pv = view.placeVersion;
	return (
		<Section
			title="Export"
			description="A read-only Luau Execution task on the place: maps are the models named like the events' map values, the lobby is the rest of Workspace."
			actions={
				view.canExport ? (
					<Button size="sm" onClick={onExport} disabled={running || starting || !view.configured}>
						<Download data-icon="inline-start" />
						{running ? "Exporting…" : latest ? "Export again" : "Export maps"}
					</Button>
				) : null
			}
		>
			<div className="space-y-2 text-sm">
				{!view.configured ? (
					<p className="text-muted-foreground">Export needs OPENCLOUD_API_KEY (with universe.place.luau-execution-session read and write) and TYPETORCH_UNIVERSE_ID on the backend.</p>
				) : null}
				{running ? (
					<p role="status" className="flex items-center gap-2">
						<RefreshCw className="size-4 animate-spin" /> {view.export.step || "starting"}…
					</p>
				) : null}
				{view.export.state === "failed" && view.export.error ? (
					<Alert variant="destructive">
						<AlertTitle>The last export failed</AlertTitle>
						<AlertDescription>{view.export.error}</AlertDescription>
					</Alert>
				) : null}
				{exportError ? (
					<Alert variant="destructive">
						<AlertDescription>{(exportError as Error).message}</AlertDescription>
					</Alert>
				) : null}
				{latest ? (
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<span>
							Exported {fmtAgo(latest.at)} by {latest.by}
						</span>
						<span>place version {latest.placeVersion ?? "?"}</span>
						<span>
							{fmtInt(latest.parts)} parts, {fmtBytes(latest.bytes)}, {latest.seconds} s
						</span>
						{pv.outOfDate ? (
							<Badge variant="outline" className="border-[var(--status-warn)] text-[var(--status-warn)]">
								Out of date: Roblox has place version {pv.latest}{pv.source === "fleet" ? " (from the game servers)" : ""}. Export again.
							</Badge>
						) : pv.latest !== null ? (
							<Badge variant="outline">Up to date</Badge>
						) : null}
					</div>
				) : (
					<p className="text-muted-foreground">Not exported yet.</p>
				)}
				{pv.note ? <p className="text-xs text-muted-foreground">{pv.note}</p> : null}
				{latest?.truncated ? <p className="text-[var(--status-warn)]">The place has more parts than one export takes: some are missing.</p> : null}
				{latest?.unmatched.length ? (
					<p className="text-muted-foreground">
						No model found for: {latest.unmatched.join(", ")}. Owners can set a model path below (Alignment), then export again.
					</p>
				) : null}
				{latest?.notes.map((n) => (
					<p key={n} className="text-xs text-muted-foreground">
						{n}
					</p>
				))}
			</div>
		</Section>
	);
}

function MapPanel({ map, view }: { map: MapInfo; view: MapsView }) {
	const [params, setParams] = usePageParams();
	const state = readMapView(params);
	const set = (patch: Partial<MapViewState>) => setParams(mapViewPatch(patch));
	const mode = state.mode;
	const cell = state.cell ?? 1;
	const heat = state.draw === "heat";
	const hidden = useMemo(() => new Set(state.hidden), [state.hidden.join(",")]);
	const isMap = map.kind === "map";

	const geometry = useQuery({
		queryKey: ["map-geometry", map.name, map.hash],
		queryFn: ({ signal }) => mapsApi.geometry(map.name, signal),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const positions = useAnalytics("map-positions", { cell, map: map.name }, { enabled: isMap, keepPrevious: true });
	const layers = useMemo(() => eventLayers(positions.data, map.name), [positions.data, map.name]);
	const shown: MapLayer[] = useMemo(
		() => layers.filter((l) => !hidden.has(l.id)).map((l) => (heat ? { ...l, points: [] } : { ...l, cells: [] })),
		[layers, hidden, heat],
	);
	const floors = useMemo(() => (geometry.data ? detectFloors(geometry.data, map.offset[1]) : []), [geometry.data, map.offset]);
	const kinds = useMemo(() => (geometry.data ? countKinds(geometry.data) : null), [geometry.data]);
	const lo = map.bounds ? Math.floor(map.bounds.min[1] + map.offset[1]) : 0;
	const hi = map.bounds ? Math.ceil(map.bounds.max[1] + map.offset[1]) : 100;
	const band = resolveBand(state.band, floors, lo, hi);
	// A free range from another map that doesn't fit this one's heights: back to all (floors and the rest carry over).
	const misfit = state.band.kind === "range" && !bandFits(state.band, lo, hi);
	useEffect(() => {
		if (misfit) setParams({ band: null });
	}, [misfit, setParams]);
	const toggleLayer = (id: string) => set({ hidden: hidden.has(id) ? state.hidden.filter((x) => x !== id) : [...state.hidden, id] });

	return (
		<div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
			<div className="space-y-2">
				<div className="h-[min(70vh,44rem)] min-h-80">
					{geometry.error ? (
						<ErrorState error={geometry.error} />
					) : (
						<Suspense fallback={<LoadingBlock rows={6} />}>
							<MapScene geometry={geometry.data ?? null} bounds={map.bounds} mode={mode} layers={shown} offset={map.offset} band={band} decorative={state.decorative} markers={state.markers} label={`Map ${map.name}`} />
						</Suspense>
					)}
				</div>
				<p className="text-xs text-muted-foreground">
					{map.name === LOBBY ? "Lobby" : map.name}: {partsText(map)} from {map.path}
					{map.via === "override" ? " (manual model path)" : ""}
					{map.alternatives.length ? `; also named like it: ${map.alternatives.join(", ")}` : ""}
				</p>
			</div>
			<div className="space-y-4">
				<Section title="View">
					<div className="space-y-3 text-sm">
						<div className="flex gap-1.5" role="group" aria-label="View">
							<ToggleChip pressed={mode === "2d"} onClick={() => set({ mode: "2d" })}>
								<MapIcon /> 2D
							</ToggleChip>
							<ToggleChip pressed={mode === "3d"} onClick={() => set({ mode: "3d" })}>
								<Box /> 3D
							</ToggleChip>
						</div>
						<BandControls choice={state.band.kind === "player" ? { kind: "all" } : state.band} band={band} floors={floors} lo={lo} hi={hi} onChange={(b) => set({ band: b })} />
						<div className="space-y-1.5" role="group" aria-label="Drawn">
							<label className="flex items-center gap-2">
								<input type="checkbox" checked={state.decorative} onChange={(e) => set({ decorative: e.target.checked })} /> Decorative meshes{kinds ? ` (${fmtInt(kinds.decorMesh)})` : ""}
							</label>
							<label className="flex items-center gap-2">
								<input type="checkbox" checked={state.markers} onChange={(e) => set({ markers: e.target.checked })} /> Markers and triggers{kinds ? ` (${fmtInt(kinds.marker)})` : ""}
							</label>
							<p className="text-xs text-muted-foreground" data-testid="draw-rule">
								Drawn: every part that collides ({kinds ? `${fmtInt(kinds.collide)}, ${fmtInt(kinds.collideInvisible)} of them invisible walls, see-through` : "invisible walls see-through"}) and small visible decoration
								{kinds ? ` (${fmtInt(kinds.decor)})` : ""}, in their own colors. Decorative meshes are meshes and unions that don't collide, drawn as their bounding boxes (outlined, often much bigger than the real shape); markers are invisible parts that don't collide.
							</p>
						</div>
					</div>
				</Section>
				{isMap ? (
					<Section title="Layers" description="Events with px / pz props on this map; the filter bar applies.">
						<div className="space-y-3 text-sm">
							<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Draw as">
								<ToggleChip pressed={heat} onClick={() => set({ draw: "heat" })}>
									Heat cells
								</ToggleChip>
								<ToggleChip pressed={!heat} onClick={() => set({ draw: "points" })}>
									Dots
								</ToggleChip>
							</div>
							<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Cell size">
								<span className="text-xs text-muted-foreground">Cell</span>
								{CELL_SIZES.map((c) => (
									<ToggleChip key={c} pressed={cell === c} onClick={() => set({ cell: c === 1 ? null : c })}>
										{c} stud{c === 1 ? "" : "s"}
									</ToggleChip>
								))}
							</div>
							{positions.isLoading ? (
								<LoadingBlock rows={2} />
							) : positions.error ? (
								<ErrorState error={positions.error} />
							) : layers.length ? (
								<div className="flex flex-wrap gap-1.5" role="group" aria-label="Layers">
									{layers.map((l) => {
										const n = (l.cells ?? []).reduce((sum, c) => sum + c.n, 0);
										return (
											<ToggleChip key={l.id} pressed={!hidden.has(l.id)} onClick={() => toggleLayer(l.id)}>
												<span className="inline-block size-2.5 rounded-full" style={{ background: l.color }} aria-hidden />
												{l.label} ({fmtInt(n)})
											</ToggleChip>
										);
									})}
								</div>
							) : (
								<p className="text-xs text-muted-foreground">No positioned events on this map in this range. Events with numeric px / pz props (and the map prop) show here.</p>
							)}
							{positions.data?.truncated ? <p className="text-xs text-muted-foreground">Only the busiest cells are shown.</p> : null}
						</div>
					</Section>
				) : null}
				{isMap ? <AlignmentCard map={map} view={view} canEdit={view.canExport} /> : null}
			</div>
		</div>
	);
}

/**
 * The map's alignment: the backend's (positioned events, last 30 days) when it has enough of them, else the recordings'
 * positions on that map (the recording-layers query's silhouette, the filter bar's range) through the same check.
 */
export function useAlignment(map: MapInfo, view: Pick<MapsView, "names">): { alignment: MapInfo["alignment"]; source: "events" | "recordings"; loading: boolean } {
	const server = map.alignment;
	const needed = map.kind === "map" && server.state === "unknown";
	const guess = view.names.find((n) => nameKey(n.name) === nameKey(map.name))?.name ?? map.name;
	const first = useAnalytics("recording-layers", { map: guess, layers: [] }, { enabled: needed });
	const recorded = first.data?.maps.find((m) => nameKey(m.map) === nameKey(map.name))?.map;
	const second = useAnalytics("recording-layers", { map: recorded, layers: [] }, { enabled: needed && recorded !== undefined && recorded !== guess });
	const data = recorded !== undefined && recorded !== guess ? second.data : first.data;
	const computed = useMemo(() => (data?.frame ? alignmentOf(map.bounds, recordingSamples(data.frame, data.background), map.offset) : null), [data, map.bounds, map.offset]);
	if (!needed || !computed || computed.state === "unknown") return { alignment: server, source: "events", loading: needed && (first.isLoading || second.isLoading) };
	return { alignment: computed, source: "recordings", loading: false };
}

function AlignmentCard({ map, view, canEdit }: { map: MapInfo; view: MapsView; canEdit: boolean }) {
	const client = useQueryClient();
	const { alignment: a, source, loading } = useAlignment(map, view);
	const [path, setPath] = useState(map.override?.path ?? "");
	const [offset, setOffset] = useState<string[]>(map.offset.map(String));
	const save = useMutation({
		mutationFn: (body: { path?: string; offset?: Vec3 }) => mapsApi.setOverride(map.name, body),
		onSuccess: () => client.invalidateQueries({ queryKey: MAPS_KEY }),
	});
	const remove = useMutation({
		mutationFn: () => mapsApi.removeOverride(map.name),
		onSuccess: () => client.invalidateQueries({ queryKey: MAPS_KEY }),
	});
	const parsed = offset.map(Number);
	const offsetOk = parsed.every((v) => Number.isFinite(v));
	const text = ALIGN_TEXT[a.state];
	return (
		<Section title="Alignment">
			<div className="space-y-2 text-sm">
				<span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${text.tone}`}>{text.label}</span>
				<p className="text-xs text-muted-foreground" data-testid="alignment-source">
					{source === "recordings" ? `${fmtInt(a.samples)} recorded positions on this map (recordings, this range)` : `${fmtInt(a.samples)} positioned events (last 30 days)`}; {fmtPct(a.inside, 0)} inside the map's box.
					{loading ? " Checking the recordings…" : ""}
					{map.offset.some((v) => v !== 0) ? ` Offset ${map.offset.join(", ")} applied.` : ""}
				</p>
				{a.state === "off" && a.suggestedOffset ? (
					<div className="space-y-1">
						<p>Suggested offset: {a.suggestedOffset.join(", ")}</p>
						{canEdit ? (
							<Button size="sm" variant="outline" onClick={() => save.mutate({ offset: a.suggestedOffset as Vec3, ...(map.override?.path ? { path: map.override.path } : {}) })} disabled={save.isPending}>
								Use this offset
							</Button>
						) : null}
					</div>
				) : null}
				{canEdit ? (
					<form
						className="space-y-2 border-t pt-2"
						onSubmit={(e) => {
							e.preventDefault();
							save.mutate({ ...(path.trim() ? { path: path.trim() } : {}), ...(offsetOk && parsed.some((v) => v !== 0) ? { offset: parsed as Vec3 } : {}) });
						}}
					>
						<div className="text-xs font-medium text-muted-foreground">Override (owners)</div>
						<Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Model path, e.g. ReplicatedStorage.assets.maps.Mall" aria-label="Model path" className="h-8 text-xs" />
						<div className="grid grid-cols-3 gap-1">
							{["x", "y", "z"].map((axis, i) => (
								<Input key={axis} value={offset[i]} onChange={(e) => setOffset((o) => o.map((v, k) => (k === i ? e.target.value : v)))} aria-label={`Offset ${axis}`} className="h-8 text-xs" inputMode="decimal" />
							))}
						</div>
						<div className="flex gap-1.5">
							<Button size="sm" type="submit" disabled={save.isPending || !offsetOk}>
								Save
							</Button>
							{map.override ? (
								<Button size="sm" type="button" variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
									Remove override
								</Button>
							) : null}
						</div>
						{save.error ? <p className="text-xs text-destructive">{(save.error as Error).message}</p> : null}
						<p className="text-xs text-muted-foreground">A model path applies at the next export; an offset at once.</p>
					</form>
				) : null}
			</div>
		</Section>
	);
}
