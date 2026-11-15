/**
 * Plans/34: the live map, shared by the server page's Live map tab and /live. Players are dots on the exported map
 * (plans/33 MapScene, 2D / 3D, the shared height controls and URL view state), the name on hover, an optional short
 * trail, the game's `points` streams as markers.
 *
 * The map comes from the positions: a player is on the exported map whose bounds plus 8 studs contain them, else the
 * lobby's export (lib/live-map.ts mapForPosition). It shows the map most players are on, with a switcher; following a
 * player (a click on their dot in 2D, or Follow in the list) shows their map and, like a replay's "Follow player", cuts
 * away everything well above them.
 */
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { EmptyState, LoadingBlock } from "@/components/common";
import { BandControls } from "@/components/maps/BandControls";
import { ToggleChip } from "@/components/ToggleChip";
import { Button } from "@/components/ui/button";
import { usePageParams } from "@/lib/hooks";
import { mapCounts, mapForPosition, nearestDot, type LiveDot, liveLayers } from "@/lib/live-map";
import { bandParam, readMapView, resolveBand, type BandChoice } from "@/lib/map-view";
import { detectFloors, ROOT_HEIGHT, type MapLayer } from "@/lib/maps";
import { bandChoiceFor, useMapExports, useMapGeometry, ViewSwitches } from "../recordings/RealMap";

const MapScene = lazy(() => import("@/components/maps/MapScene"));

export interface LiveGroup {
	id: string;
	label: ReactNode;
	color: string;
}

export function LiveMap({
	dots,
	markers = [],
	groups,
	label,
	empty = "No players with a character right now.",
}: {
	dots: LiveDot[];
	markers?: MapLayer[];
	/** The list's sections (the /live page: one per server); none = one list. */
	groups?: LiveGroup[];
	label: string;
	empty?: ReactNode;
}) {
	const maps = useMapExports();
	const [params, setParams] = usePageParams();
	const state = readMapView(params);
	const [picked, setPicked] = useState<string | null>(null);
	const [followed, setFollowed] = useState<string | null>(null);
	const [hover, setHover] = useState<{ name: string; left: number; top: number } | null>(null);
	const list = maps ?? [];
	const { counts, top } = useMemo(() => mapCounts(list, dots), [list, dots]);
	const followedDot = followed ? dots.find((d) => d.key === followed) : undefined;
	const followedMap = followedDot ? mapForPosition(list, followedDot.x, followedDot.z)?.name : undefined;
	const lobby = list.find((m) => m.kind === "lobby")?.name;
	const name = followedMap ?? picked ?? top ?? lobby ?? list[0]?.name ?? null;
	const info = list.find((m) => m.name === name) ?? null;
	const geometry = useMapGeometry(info);
	const floors = useMemo(() => (geometry.data && info ? detectFloors(geometry.data, info.offset[1]) : []), [geometry.data, info]);
	const lo = info?.bounds ? Math.floor(info.bounds.min[1] + info.offset[1]) : 0;
	const hi = info?.bounds ? Math.ceil(info.bounds.max[1] + info.offset[1]) : 100;
	const following = followedDot !== undefined;
	const choice = bandChoiceFor(params.get("band"), state.band, following);
	const feet = followedDot ? Math.round(followedDot.y - ROOT_HEIGHT) : undefined;
	const band = resolveBand(choice, floors, lo, hi, feet);
	const setBand = (b: BandChoice) => setParams({ band: b.kind === "all" ? (following ? "all" : null) : b.kind === "player" ? null : bandParam(b) });
	// Only this map's players are drawn on it (the others stand on another map's coordinates).
	const here = useMemo(() => (info ? dots.filter((d) => mapForPosition(list, d.x, d.z)?.name === info.name) : []), [dots, list, info]);
	const layers = useMemo(() => liveLayers(here, markers, followed), [here, markers, followed]);
	const follow = (key: string | null) => {
		setFollowed(key);
		if (key) setPicked(null);
	};

	if (maps === null) return <LoadingBlock rows={4} />;
	const sections = groups ?? [{ id: "", label: null, color: "" }];
	return (
		<div className="grid gap-3 lg:grid-cols-[1fr_16rem]">
			<div className="min-w-0 space-y-2">
				{list.length ? (
					<>
						<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Map">
							<span className="text-xs font-medium text-muted-foreground">Map</span>
							{list.map((m) => (
								<ToggleChip
									key={m.name}
									pressed={m.name === name}
									onClick={() => {
										setPicked(m.name);
										setFollowed(null);
									}}
								>
									{m.name}
									<span className="tabular-nums opacity-70">{counts.get(m.name) ?? 0}</span>
								</ToggleChip>
							))}
						</div>
						<ViewSwitches real draw={false} />
						{info ? <BandControls choice={choice} band={band} floors={floors} lo={lo} hi={hi} follow={following} onChange={setBand} className="max-w-xl" /> : null}
						<div className="relative h-[min(70vh,40rem)] min-h-80" data-testid="live-map" data-map={info?.name ?? ""} data-band={band ? band.join("..") : "all"} data-followed={followed ?? ""}>
							{info && !geometry.error ? (
								<Suspense fallback={<LoadingBlock rows={6} />}>
									<MapScene
										geometry={geometry.data ?? null}
										bounds={info.bounds}
										mode={state.mode}
										layers={layers}
										offset={info.offset}
										band={band}
										label={label}
										onPick={(p) => follow(nearestDot(here, p.x, p.z)?.key ?? null)}
										onHover={(p, at) => {
											const dot = p ? nearestDot(here, p.x, p.z) : null;
											setHover(dot ? { name: dot.name, ...at } : null);
										}}
									/>
								</Suspense>
							) : (
								<EmptyState>{geometry.error ? "This map's geometry could not be read." : "No exported map to draw on."}</EmptyState>
							)}
							{hover ? (
								<div role="tooltip" className="pointer-events-none absolute z-10 rounded border bg-background/95 px-2 py-1 text-xs shadow" style={{ left: hover.left + 12, top: hover.top + 12 }}>
									{hover.name}
								</div>
							) : null}
						</div>
						<p className="text-xs text-muted-foreground">Hover a dot for the name; click one (2D) or use Follow to follow that player. Positions are live and stay in this page only.</p>
					</>
				) : (
					<EmptyState>No exported maps yet: export them on the Maps page to see players on them. The list shows who is where.</EmptyState>
				)}
			</div>
			<aside className="space-y-3 text-sm" aria-label="Players">
				{dots.length === 0 ? <p className="text-muted-foreground">{empty}</p> : null}
				{sections.map((g) => {
					const mine = dots.filter((d) => (groups ? d.group === g.id : true));
					if (groups && !mine.length) return null;
					return (
						<section key={g.id} className="space-y-1">
							{g.label ? (
								<div className="flex items-center gap-1.5 text-xs font-medium">
									<span className="size-2.5 rounded-full" style={{ background: g.color }} aria-hidden />
									{g.label}
								</div>
							) : null}
							<ul className="space-y-0.5">
								{mine.map((d) => {
									const on = mapForPosition(list, d.x, d.z)?.name;
									return (
										<li key={d.key} className="flex items-center gap-1.5">
											<span className="size-2 shrink-0 rounded-full" style={{ background: d.color }} aria-hidden />
											<span className="min-w-0 flex-1 truncate" title={on ? `on ${on}` : undefined}>
												{d.name}
											</span>
											<Button type="button" variant={followed === d.key ? "default" : "ghost"} size="sm" className="h-6 px-2 text-xs" onClick={() => follow(followed === d.key ? null : d.key)} aria-pressed={followed === d.key}>
												{followed === d.key ? "Following" : "Follow"}
											</Button>
										</li>
									);
								})}
							</ul>
						</section>
					);
				})}
			</aside>
		</div>
	);
}
