/**
 * Test helpers for the demo's mocks (vitest, Node). Every domain's tests start with:
 *
 *   import { describeWithPack, setupDemo, testApi } from "./harness";
 *   describeWithPack("fleet mocks", () => {
 *     beforeAll(() => setupDemo());                 // pinned clock, no latency, fresh state, the pack's data
 *     it("lists servers", async () => {
 *       const api = testApi();                        // the explorer's real createApi() over the mock router
 *       const servers = await api.fleetServers();     // any api.* function, typed as the explorer sees it
 *     });
 *   });
 *
 * setupDemo({ engine: true }) also opens the Node DuckDB engine (analytics queries, /v1/sql, pack SQL); facts-only mocks
 * don't need it. Without the prepared data (web/demo/public/data, made by `bun run demo:data` from the pack) the suites
 * skip. The real network is off: any non-/api fetch throws.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import { createApi } from "@/lib/api";
import { setClock, setDataReader } from "../mock/data";
import { setEngine } from "../mock/engine";
import "../mock/handlers";
import { resetPackCache } from "../mock/pack";
import { createMockFetch, setLatency } from "../mock/router";
import { installShims } from "../mock/shims";
import { resetState } from "../mock/state";
import { createNodeEngine, type NodeEngine } from "./node-engine";

// A string, not a URL: under jsdom the global URL is jsdom's, which node:url refuses.
export const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data");
export const hasPack = existsSync(join(DATA_DIR, "manifest.json")) && existsSync(join(DATA_DIR, "facts.json"));

/** A suite that needs the prepared pack: skipped (with a note) without it. */
export const describeWithPack: typeof describe = (hasPack ? describe : describe.skip) as typeof describe;

/** 2026-11-15 14:00 UTC: the pack's last day (2026-11-14) moves onto this day; rows after 14:00 are hidden. */
export const TEST_NOW = Date.UTC(2026, 10, 15, 14, 0, 0);

/** fetch for tests: /api/* through the mock router, anything else is refused (no network in tests). */
export const mockFetch = createMockFetch(async (input) => {
	throw new Error(`a demo test tried to reach the network: ${String(input instanceof Request ? input.url : input)}`);
});

/** The explorer's API client over the mock router (every api.* function, typed). */
export function testApi() {
	return createApi({ fetch: mockFetch });
}

/** Points the global fetch at the mock router too (for code that calls fetch itself, like web/src/lib/maps.ts). */
export function installTestFetch(): () => void {
	const real = globalThis.fetch;
	globalThis.fetch = mockFetch;
	return () => {
		globalThis.fetch = real;
	};
}

let opened: NodeEngine | undefined;

export interface SetupOptions {
	/** The demo clock (default TEST_NOW). */
	now?: number;
	/** Open the Node DuckDB engine (analytics). Opened once per test file and kept. */
	engine?: boolean;
}

/** Pins the clock, drops latency and state, reads data from DATA_DIR, and opens the engine when asked. */
export async function setupDemo(options: SetupOptions = {}): Promise<void> {
	const at = options.now ?? TEST_NOW;
	setClock(() => at);
	setLatency(0);
	installShims();
	resetState();
	resetPackCache();
	setDataReader(async (name) => new Uint8Array(readFileSync(join(DATA_DIR, name))));
	if (options.engine && !opened) {
		opened = await createNodeEngine(DATA_DIR);
		setEngine(opened);
	}
}

/** Closes the engine (afterAll). */
export function teardownDemo(): void {
	opened?.close();
	opened = undefined;
	setEngine(null);
	setClock(null);
}
