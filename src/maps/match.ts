/**
 * Which exported model is which map, and whether a map's geometry sits where the players are (plans/33).
 *
 * pickMaps: the export packs every candidate (script.ts); per map name the backend keeps one:
 *   a manual override's model first, else, among the Models / Folders whose normalized name equals the map name's, the one
 *   with the most parts, then the shortest path. Map names with no candidate are `unmatched`;
 *   names with several candidates list the others as `alternatives`.
 *
 * alignment: the share of positioned samples (event `px`/`pz`, recordings) of a map that fall inside the map's bounds
 * (grown by ALIGN_MARGIN studs, the override offset applied). `aligned` at ALIGNED_SHARE or more, `partial` from
 * PARTIAL_SHARE, else `off` with a suggested offset (the samples' median minus the bounds' center, on x and z; y from the
 * samples' low end to the bounds' floor). Under MIN_SAMPLES samples: `unknown`.
 */
import type { Bounds, ExportEntry, Vec3 } from "./format.ts";
import { mapKey } from "./script.ts";

export const ALIGN_MARGIN = 8;
export const ALIGNED_SHARE = 0.8;
export const PARTIAL_SHARE = 0.2;
export const MIN_SAMPLES = 10;

export interface Picked {
	/** The map name as the events spell it. */
	name: string;
	entry: ExportEntry;
	alternatives: string[];
}

export interface Picks {
	maps: Picked[];
	unmatched: string[];
}

/** One model per map name (see the file comment). `names` are the events' map names (original spelling). */
export function pickMaps(names: string[], entries: ExportEntry[], overrides: Record<string, { path?: string }> = {}): Picks {
	const candidates = entries.filter((e) => e.kind === "map");
	const maps: Picked[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const key = mapKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const overridePath = overrideFor(overrides, name)?.path;
		const forced = overridePath ? candidates.find((c) => c.via === "override" && c.path === overridePath) : undefined;
		const named = candidates.filter((c) => c.via === "name" && mapKey(c.name) === key);
		const ranked = [...named].sort(rank);
		const best = forced ?? ranked[0];
		if (!best) {
			unmatched.push(name);
			continue;
		}
		maps.push({ name, entry: best, alternatives: [...(forced ? named : ranked.slice(1))].map((c) => c.path).filter((p) => p !== best.path) });
	}
	return { maps, unmatched };
}

/** More parts first, then the shorter path. */
function rank(a: ExportEntry, b: ExportEntry): number {
	return b.parts - a.parts || a.path.length - b.path.length || a.path.localeCompare(b.path);
}

/** An override by map name, ignoring case and punctuation. */
export function overrideFor<T>(overrides: Record<string, T>, name: string): T | undefined {
	const key = mapKey(name);
	for (const [k, v] of Object.entries(overrides)) if (mapKey(k) === key) return v;
	return undefined;
}

export type AlignmentState = "aligned" | "partial" | "off" | "unknown";

export interface Alignment {
	state: AlignmentState;
	samples: number;
	/** Share of samples inside the (offset) bounds, 0-1. */
	inside: number;
	/** With `off`: what to add to the geometry so it covers the samples. */
	suggestedOffset?: Vec3;
}

export interface Sample {
	x: number;
	y?: number | null;
	z: number;
	/** How many samples this point stands for (a heat cell's count; default 1). */
	n?: number;
}

export function alignment(bounds: Bounds | null, samples: Sample[], offset: Vec3 = [0, 0, 0]): Alignment {
	const good = samples.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.z));
	const total = good.reduce((sum, s) => sum + weight(s), 0);
	if (!bounds || total < MIN_SAMPLES) return { state: "unknown", samples: total, inside: 0 };
	const min = bounds.min.map((v, i) => v + (offset[i] as number) - ALIGN_MARGIN);
	const max = bounds.max.map((v, i) => v + (offset[i] as number) + ALIGN_MARGIN);
	let inside = 0;
	for (const s of good) {
		const yOk = s.y === undefined || s.y === null || !Number.isFinite(s.y) || (s.y >= (min[1] as number) && s.y <= (max[1] as number));
		if (s.x >= (min[0] as number) && s.x <= (max[0] as number) && s.z >= (min[2] as number) && s.z <= (max[2] as number) && yOk) inside += weight(s);
	}
	const share = Math.round((inside / total) * 1000) / 1000;
	const state: AlignmentState = share >= ALIGNED_SHARE ? "aligned" : share >= PARTIAL_SHARE ? "partial" : "off";
	if (state !== "off") return { state, samples: total, inside: share };
	const mx = weightedMedian(good.map((s) => [s.x, weight(s)]));
	const mz = weightedMedian(good.map((s) => [s.z, weight(s)]));
	const ys = good.filter((s) => s.y !== undefined && s.y !== null && Number.isFinite(s.y)).map((s) => [s.y as number, weight(s)] as [number, number]);
	const cx = (bounds.min[0] + bounds.max[0]) / 2 + offset[0];
	const cz = (bounds.min[2] + bounds.max[2]) / 2 + offset[2];
	const dy = ys.length ? weightedQuantile(ys, 0.05) - (bounds.min[1] + offset[1]) - 3 : 0;
	const r = (v: number) => Math.round(v * 10) / 10;
	return { state, samples: total, inside: share, suggestedOffset: [r(offset[0] + mx - cx), r(offset[1] + (ys.length ? dy : 0)), r(offset[2] + mz - cz)] };
}

const weight = (s: Sample) => (s.n !== undefined && Number.isFinite(s.n) && s.n > 0 ? s.n : 1);

function weightedMedian(values: [number, number][]): number {
	return weightedQuantile(values, 0.5);
}

function weightedQuantile(values: [number, number][], q: number): number {
	const sorted = [...values].sort((a, b) => a[0] - b[0]);
	const total = sorted.reduce((s, [, w]) => s + w, 0);
	let run = 0;
	for (const [v, w] of sorted) {
		run += w;
		if (run >= total * q) return v;
	}
	return sorted[sorted.length - 1]?.[0] ?? 0;
}
