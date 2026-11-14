/**
 * `map-positions` (plans/33): the map names the events carry and where positioned events happened on each map.
 *
 *   names  the distinct values of the `mapKey` prop (default `map`) with their event counts (the 200 most common):
 *          the names the map export looks for.
 *   cells  positioned events (numeric `px` and `pz` props, `py` optional) that also carry the map prop, counted per
 *          (map, event, x cell, z cell) with the cell size `cell` (0.5, 1, 2 or 4 studs); the `maxCells` busiest cells.
 *          Each cell has its average and lowest `py`. These are the explorer's event layer on the 2D / 3D map and the
 *          samples of the backend's alignment check (maps/match.ts).
 *
 * Every filter of the filter bar applies. Studs are the game's world coordinates (the export's coordinates).
 */
import { assertSafeKey } from "../sql/dialect.ts";
import { defineQuery, eventsTable, intOption, lit, num, str, where, type QueryContext } from "./core.ts";
import type { NormalizedFilters } from "../sql/filters.ts";

export const MAP_CELL_SIZES = [0.5, 1, 2, 4] as const;
export type MapCellSize = (typeof MAP_CELL_SIZES)[number];
export const MAP_NAMES_MAX = 200;
export const MAP_CELLS_MAX = 10_000;

export interface MapPositionsOptions {
	mapKey: string;
	cell: MapCellSize;
	maxCells: number;
	/** Only this map's cells (its exact prop value). */
	map?: string;
}

export interface MapCell {
	map: string;
	/** `kind:name` of the event. */
	event: string;
	/** The cell's low corner, studs. */
	x: number;
	z: number;
	/** Average and lowest `py` in the cell (null without `py`). */
	y: number | null;
	ylo: number | null;
	n: number;
}

export interface MapPositionsResult {
	mapKey: string;
	cell: MapCellSize;
	names: { name: string; events: number }[];
	cells: MapCell[];
	/** The cell list hit maxCells (the quietest cells are missing). */
	truncated: boolean;
}

function mapExpr(ctx: QueryContext, key: string): string {
	return ctx.dialect.jsonText("e.props", key);
}

export const mapPositions = defineQuery<MapPositionsOptions, MapPositionsResult>({
	name: "map-positions",
	summary: "Map names from the events' map prop, and positioned events (px/py/pz) per map in 0.5-4 stud cells",
	defaultDays: 7,
	options(input) {
		const key = input?.mapKey === undefined ? "map" : String(input.mapKey);
		assertSafeKey(key, "mapKey");
		const cell = input?.cell === undefined ? 1 : Number(input.cell);
		if (!(MAP_CELL_SIZES as readonly number[]).includes(cell)) throw new Error(`cell must be one of ${MAP_CELL_SIZES.join(", ")}`);
		const map = input?.map === undefined || input.map === null || input.map === "" ? undefined : String(input.map);
		if (map !== undefined && map.length > 200) throw new Error("map is at most 200 characters");
		return { mapKey: key, cell: cell as MapCellSize, maxCells: intOption(input?.maxCells, "maxCells", 5000, 1, MAP_CELLS_MAX), ...(map !== undefined ? { map } : {}) };
	},
	statements(ctx, f: NormalizedFilters, o) {
		const d = ctx.dialect;
		const m = mapExpr(ctx, o.mapKey);
		const px = d.jsonNumber("e.props", "px");
		const py = d.jsonNumber("e.props", "py");
		const pz = d.jsonNumber("e.props", "pz");
		const table = eventsTable(ctx, f);
		const onMap = `${m} IS NOT NULL AND ${m} <> ''${o.map !== undefined ? ` AND ${m} = ${lit(o.map)}` : ""}`;
		const cell = String(o.cell);
		return {
			names: `SELECT ${m} AS name, COUNT(*) AS n FROM ${table} e WHERE ${where(f, ctx)} AND ${m} IS NOT NULL AND ${m} <> '' GROUP BY 1 ORDER BY n DESC, name ${d.limit(MAP_NAMES_MAX)}`,
			cells:
				`SELECT map, event, cx, cz, AVG(py) AS y, MIN(py) AS ylo, COUNT(*) AS n FROM (` +
				`SELECT ${m} AS map, e.kind || ':' || e.name AS event, CAST(FLOOR(${px} / ${cell}) AS BIGINT) AS cx, CAST(FLOOR(${pz} / ${cell}) AS BIGINT) AS cz, ${py} AS py ` +
				`FROM ${table} e WHERE ${where(f, ctx)} AND ${onMap} AND ${px} IS NOT NULL AND ${pz} IS NOT NULL) p ` +
				`GROUP BY map, event, cx, cz ORDER BY n DESC, map, event, cx, cz ${d.limit(o.maxCells + 1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const cellRows = rows.cells ?? [];
		const truncated = cellRows.length > o.maxCells;
		const nullable = (v: unknown) => (v === null || v === undefined ? null : Math.round(num(v) * 100) / 100);
		return {
			mapKey: o.mapKey,
			cell: o.cell,
			names: (rows.names ?? []).map((r) => ({ name: str(r.name), events: num(r.n) })),
			cells: cellRows.slice(0, o.maxCells).map((r) => ({
				map: str(r.map),
				event: str(r.event),
				x: num(r.cx) * o.cell,
				z: num(r.cz) * o.cell,
				y: nullable(r.y),
				ylo: nullable(r.ylo),
				n: num(r.n),
			})),
			truncated,
		};
	},
});
