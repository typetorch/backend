/**
 * The demo's clock and its data files (/data/ on the site: web/demo/public/data/, made by demo/scripts/prepare-data.ts).
 *
 * The pack covers 14 UTC days in the past. Everything the demo shows is moved forward by whole days so the pack's last day
 * is today (UTC), and nothing after "now" is shown: `shiftMs()` is that offset, the same for the analytics tables
 * (engine.ts) and the precomputed facts (pack.ts). Times inside `props` JSON (heartbeat `s` / `u` seconds, deploy report
 * `t`) are NOT shifted in the data: shift them with `shiftMs()` / `shiftSeconds()` when a mock shows them.
 */

export const DAY_MS = 86_400_000;
/** The pack's fake ids (the real ones were scrubbed). */
export const PLACE_ID = 9876543210;
export const UNIVERSE_ID = 1234567890;

let clock: () => number = () => Date.now();

/** Now, unix ms: the demo's clock (tests pin it with setClock). */
export function now(): number {
	return clock();
}

export function setClock(fn: (() => number) | null): void {
	clock = fn ?? (() => Date.now());
}

// Data files ------------------------------------------------------------------------------------------------------------

export interface TableFile {
	file: string;
	rows: number;
	bytes: number;
	columns: string[];
}

export interface Manifest {
	format: 1;
	firstT: number;
	lastT: number;
	tables: { events: TableFile; recordings: TableFile };
	csv: { nullstr: string };
	facts: { file: string; bytes: number };
	maps: { index: string | null; files: string[] };
}

/** Reads one file of /data/: the site's own origin in the browser; tests point it at the prepared folder. */
export type DataReader = (name: string) => Promise<Uint8Array>;

const browserReader: DataReader = async (name) => {
	const response = await fetch(`/data/${name}`);
	if (!response.ok) throw new Error(`/data/${name}: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
};

let reader: DataReader = browserReader;
const cache = new Map<string, Promise<unknown>>();

export function setDataReader(fn: DataReader | null): void {
	reader = fn ?? browserReader;
	cache.clear();
}

export function readData(name: string): Promise<Uint8Array> {
	return reader(name);
}

/** A JSON file of /data/, parsed once. */
export function readDataJson<T>(name: string): Promise<T> {
	let found = cache.get(name) as Promise<T> | undefined;
	if (!found) {
		found = reader(name).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as T);
		found.catch(() => cache.delete(name));
		cache.set(name, found);
	}
	return found;
}

export const manifest = () => readDataJson<Manifest>("manifest.json");

// The day shift ---------------------------------------------------------------------------------------------------------

/** Whole days (in ms) that move the pack's last day onto today (UTC) for a given now. */
export function shiftFor(lastT: number, at = now()): number {
	return (Math.floor(at / DAY_MS) - Math.floor(lastT / DAY_MS)) * DAY_MS;
}

let lastTKnown: number | undefined;

/** The shift for the current clock (the manifest must have loaded once: `await manifest()` or `await pack()`). */
export function shiftMs(): number {
	if (lastTKnown === undefined) throw new Error("demo data not loaded yet: await pack() or manifest() first");
	return shiftFor(lastTKnown);
}

/** The shift in seconds (heartbeat `s` / `u`, deploy report `t`). */
export function shiftSeconds(): number {
	return shiftMs() / 1000;
}

/** Loads the manifest and remembers the pack's span (makes shiftMs() usable). */
export async function loadSpan(): Promise<{ firstT: number; lastT: number }> {
	const m = await manifest();
	lastTKnown = m.lastT;
	return { firstT: m.firstT, lastT: m.lastT };
}
