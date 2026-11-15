/**
 * The map view's state in the URL (Maps and Recordings pages), next to the filter bar's parameters, so a view is
 * shareable and survives switching maps:
 *
 *   mode=3d          2D (default) or 3D
 *   draw=points      heat cells (default) or points (the Recordings page's old `view=dots` reads as points)
 *   cell=0.5|1|2     heat cell size in studs (absent: the page's default)
 *   band=f2          the Y band: floor 2 of the map's detected floors; `band=10..40` a free range; `band=player`
 *                    follows the replayed player (everything well above them cut away, so roofs don't hide them);
 *                    absent = all (a replay: player), `band=all` = all even in a replay
 *   decor=1          non-colliding meshes and unions drawn (as boxes)
 *   markers=1        invisible non-colliding parts drawn (markers, triggers)
 *   hide=a,b         layers switched off (Maps page; the Recordings page keeps its `layers` list)
 *
 * Switching maps keeps all of it; only a free band range that doesn't fit the new map's heights is dropped.
 */
import { CELL_SIZES, type CellSize, type DrawToggles, type Floor } from "./maps";

export type BandChoice = { kind: "all" } | { kind: "floor"; index: number } | { kind: "range"; lo: number; hi: number } | { kind: "player" };

export interface MapViewState extends DrawToggles {
	mode: "2d" | "3d";
	draw: "heat" | "points";
	/** null: the page's default. */
	cell: CellSize | null;
	band: BandChoice;
	hidden: string[];
}

export const VIEW_KEYS = ["mode", "draw", "cell", "band", "decor", "markers", "hide"] as const;

export function readMapView(params: URLSearchParams): MapViewState {
	const cell = Number(params.get("cell"));
	const draw = params.get("draw") ?? params.get("view");
	return {
		mode: params.get("mode") === "3d" ? "3d" : "2d",
		draw: draw === "points" || draw === "dots" ? "points" : "heat",
		cell: params.has("cell") && (CELL_SIZES as readonly number[]).includes(cell) ? (cell as CellSize) : null,
		band: readBand(params.get("band")),
		decorative: params.get("decor") === "1",
		markers: params.get("markers") === "1",
		hidden: (params.get("hide") ?? "").split(",").filter(Boolean),
	};
}

export function readBand(raw: string | null): BandChoice {
	if (!raw) return { kind: "all" };
	if (raw === "player") return { kind: "player" };
	const floor = /^f(\d{1,2})$/.exec(raw);
	if (floor) return Number(floor[1]) >= 1 ? { kind: "floor", index: Number(floor[1]) - 1 } : { kind: "all" };
	const range = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(raw);
	if (range) {
		const lo = Number(range[1]);
		const hi = Number(range[2]);
		if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return { kind: "range", lo, hi };
	}
	return { kind: "all" };
}

export function bandParam(band: BandChoice): string | null {
	if (band.kind === "floor") return `f${band.index + 1}`;
	if (band.kind === "range") return `${band.lo}..${band.hi}`;
	if (band.kind === "player") return "player";
	return null;
}

/** The URL patch for a part of the state (null removes a key: the default). */
export function mapViewPatch(state: Partial<MapViewState>): Record<string, string | null> {
	const patch: Record<string, string | null> = {};
	if (state.mode !== undefined) patch.mode = state.mode === "3d" ? "3d" : null;
	if (state.draw !== undefined) {
		patch.draw = state.draw === "points" ? "points" : null;
		patch.view = null;
	}
	if (state.cell !== undefined) patch.cell = state.cell === null ? null : String(state.cell);
	if (state.band !== undefined) patch.band = bandParam(state.band);
	if (state.decorative !== undefined) patch.decor = state.decorative ? "1" : null;
	if (state.markers !== undefined) patch.markers = state.markers ? "1" : null;
	if (state.hidden !== undefined) patch.hide = state.hidden.length ? state.hidden.join(",") : null;
	return patch;
}

/** Studs kept above the followed player's feet: their own storey (walls, low ceilings), not the roof over it. */
export const FOLLOW_HEADROOM = 9;

/** The band that follows a player whose feet are at `feetY`: everything from the map's bottom to just under the roof. */
export function followBand(feetY: number, lo: number): [number, number] {
	return [Math.min(lo, feetY - 1), feetY + FOLLOW_HEADROOM];
}

/**
 * The band to draw on a map: a floor of its own (null while the floors aren't known or it has fewer), a free range when
 * it fits the map's heights [lo, hi], following the player when their feet are known (`feetY`), else none (all).
 */
export function resolveBand(band: BandChoice, floors: readonly Floor[], lo: number, hi: number, feetY?: number | null): [number, number] | null {
	if (band.kind === "player") return feetY === null || feetY === undefined ? null : followBand(feetY, lo);
	if (band.kind === "floor") return floors.length > 1 ? (floors[band.index]?.band ?? null) : null;
	if (band.kind === "range") return bandFits(band, lo, hi) ? [band.lo, band.hi] : null;
	return null;
}

/** A free range fits a map whose heights are [lo, hi] when it lies inside them. */
export function bandFits(band: { lo: number; hi: number }, lo: number, hi: number): boolean {
	return band.lo >= lo && band.hi <= hi;
}
