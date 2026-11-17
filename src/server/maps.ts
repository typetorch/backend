/**
 * The maps routes (plans/33): exported map geometry for the explorer's 2D and 3D maps.
 *
 *   GET    /v1/maps                    (every signed-in role)  the maps of the latest export (bounds, part counts, place
 *                                      version, how each was found, override, alignment), the export's state, whether
 *                                      Roblox has a newer place version, the unmatched map names, the history
 *   GET    /v1/maps/<name>/geometry    (every signed-in role)  one map's geometry (`TTMP`, maps/format.ts) with an ETag
 *                                      (its content hash); `(lobby)` is the lobby. Version 1 (parts only) unless `?v=2`:
 *                                      then version 2 with the texture section when the map has textures
 *   POST   /v1/maps/export             (owners, audited)       starts an export: `{ names?: string[] }` adds map names to
 *                                      the ones the events carry; 202 with the export's state, 409 while one runs
 *   PUT    /v1/maps/<name>/override    (owners, audited)       `{ path?, offset? }`: the model to use and/or an offset (the lobby, `(lobby)`: an offset only)
 *   DELETE /v1/maps/<name>/override    (owners, audited)       removes it
 *
 * The export needs OPENCLOUD_API_KEY (universe.place.luau-execution-session:read and :write) and TYPETORCH_UNIVERSE_ID;
 * the place is the universe's root place (else the fleet's). "Out of date": the place's newest version from the Assets
 * API (asset:read on the key; else the newest `pv` the fleet's servers reported in the last day) is newer than the
 * exported one. The alignment check reads positioned events (`map-positions`) over the last ALIGN_DAYS days.
 * A finished export starts the animation pass (anims/store.ts) through `afterExport`.
 */
import { MapFormatError, mapBlobV1 } from "../maps/format.ts";
import { alignment, overrideFor, type Alignment } from "../maps/match.ts";
import { mapKey } from "../maps/script.ts";
import { LOBBY, type MapStore, MapsError } from "../maps/store.ts";
import { latestPlaceVersion } from "../opencloud.ts";
import type { MapPositionsResult } from "../queries/maps.ts";
import { json, readCapped } from "./http.ts";

/** Positioned events read for the alignment check and the export's map names. */
export const ALIGN_DAYS = 30;
/** How long the newest place version and the positions are kept (ms). */
export const PLACE_VERSION_TTL_MS = 10 * 60_000;
export const POSITIONS_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export interface MapsDeps {
	store: MapStore;
	clock: () => number;
	/** The Open Cloud key and universe, or null when either is missing. */
	openCloud(): { apiKey: string; universeId: number } | null;
	/** The place to export: the universe's root place, else the fleet's. */
	placeId(): Promise<number | null>;
	/** The newest `pv` the fleet heard for the place since `since` (null without the fleet). */
	fleetPlaceVersion(placeId: number, since: number): Promise<number | null>;
	/** The map-positions query over the last `days` (null when analytics is off). */
	positions(days: number): Promise<MapPositionsResult | null>;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	/** After a successful export (the animation pass: plans/36 "The clips"). Never throws into the export. */
	afterExport?: (input: { apiKey: string; universeId: number; placeId: number; by: string }) => void;
}

export interface MapsCaller {
	/** The owner's name for the records, or the 403 for everyone else. */
	manage(): string | Response;
	owner: boolean;
	note(note: { action: string; outcome?: "ok" | "failed" | "refused"; details?: Record<string, unknown> }): void;
	/** Writes the export's end to the audit log (a system entry). */
	auditDone(outcome: "ok" | "failed", details: Record<string, unknown>): void;
}

interface PlaceVersionInfo {
	latest: number | null;
	source: "roblox" | "fleet" | null;
	note?: string;
}

export class MapsRoutes {
	private placeVersion: { at: number; placeId: number; value: PlaceVersionInfo } | null = null;
	private positionsCache: { at: number; value: MapPositionsResult | null; error?: string } | null = null;

	constructor(private readonly deps: MapsDeps) {}

	async handle(req: Request, path: string, caller: MapsCaller): Promise<Response> {
		const method = req.method;
		if (path === "/v1/maps") return method === "GET" ? this.list(caller) : json(405, { error: "GET only" });
		if (path === "/v1/maps/export") {
			if (method !== "POST") return json(405, { error: "POST only" });
			const who = caller.manage();
			return typeof who === "string" ? this.export(req, who, caller) : who;
		}
		const m = /^\/v1\/maps\/([^/]+)\/(geometry|override)$/.exec(path);
		if (!m) return json(404, { error: "not found" });
		let name: string;
		try {
			name = decodeURIComponent(m[1] as string);
		} catch {
			return json(400, { error: "bad map name" });
		}
		if (m[2] === "geometry") return method === "GET" ? this.geometry(req, name) : json(405, { error: "GET only" });
		if (method !== "PUT" && method !== "DELETE") return json(405, { error: "PUT or DELETE only" });
		const who = caller.manage();
		return typeof who === "string" ? this.override(req, name, who, caller) : who;
	}

	private async list(caller: MapsCaller): Promise<Response> {
		const { store } = this.deps;
		const latest = store.latest;
		const positions = latest ? await this.positions() : { value: null };
		const cells = positions.value?.cells ?? [];
		const maps = (latest?.maps ?? []).map((m) => {
			const override = overrideFor(store.overrides, m.kind === "lobby" ? LOBBY : m.name);
			const offset = override?.offset ?? [0, 0, 0];
			const samples = m.kind === "map" ? cells.filter((c) => mapMatches(c.map, m.name)).map((c) => ({ x: c.x + (positions.value?.cell ?? 1) / 2, z: c.z + (positions.value?.cell ?? 1) / 2, y: c.ylo ?? c.y, n: c.n })) : [];
			const align: Alignment = m.kind === "map" ? alignment(m.bounds, samples, offset) : { state: "unknown", samples: 0, inside: 0 };
			return { ...m, offset, ...(override ? { override } : {}), alignment: align };
		});
		const placeVersion = latest ? await this.latestVersion(latest.placeId) : { latest: null, source: null };
		const exported = latest?.placeVersion ?? null;
		return json(200, {
			configured: this.deps.openCloud() !== null,
			canExport: caller.owner,
			export: store.status(),
			latest: latest ? { placeId: latest.placeId, universeId: latest.universeId, placeVersion: exported, at: latest.at, by: latest.by, seconds: latest.seconds, parts: latest.parts, bytes: latest.bytes, truncated: latest.truncated, unmatched: latest.unmatched, notes: latest.notes } : null,
			placeVersion: { ...placeVersion, exported, outOfDate: exported !== null && placeVersion.latest !== null && placeVersion.latest > exported },
			maps,
			names: positions.value?.names ?? [],
			overrides: store.overrides,
			history: store.history,
			...(positions.error ? { alignmentNote: positions.error } : {}),
		});
	}

	private async export(req: Request, who: string, caller: MapsCaller): Promise<Response> {
		const oc = this.deps.openCloud();
		if (!oc) {
			caller.note({ action: "maps.export", outcome: "refused", details: { error: "not configured" } });
			return json(409, { error: "map export needs OPENCLOUD_API_KEY (universe.place.luau-execution-session:read and :write) and TYPETORCH_UNIVERSE_ID" });
		}
		const raw = await readCapped(req, 16 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let extra: string[] = [];
		if (raw.length) {
			let body: unknown;
			try {
				body = JSON.parse(Buffer.from(raw).toString("utf8"));
			} catch {
				return json(400, { error: "body is not JSON" });
			}
			const names = (body as { names?: unknown })?.names;
			if (names !== undefined) {
				if (!Array.isArray(names) || names.length > 50 || !names.every((n) => typeof n === "string" && n.length > 0 && n.length <= 100 && !/[\u0000-\u001f]/.test(n))) {
					return json(400, { error: "names is a list of at most 50 map names (1-100 characters each)" });
				}
				extra = names as string[];
			}
		}
		const placeId = await this.deps.placeId();
		if (!placeId) return json(409, { error: "the place isn't known: TYPETORCH_UNIVERSE_ID's root place couldn't be read and no game server has reported its PlaceId" });
		this.positionsCache = null;
		const positions = await this.positions();
		const names = [...(positions.value?.names ?? []).map((n) => n.name), ...extra];
		try {
			const status = this.deps.store.start({
				...oc,
				placeId,
				names,
				by: who,
				onDone: (outcome, details) => {
					caller.auditDone(outcome, details);
					if (outcome !== "ok") return;
					try {
						this.deps.afterExport?.({ ...oc, placeId, by: who });
					} catch (error) {
						this.deps.log?.(`maps: the animation pass didn't start: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
					}
				},
			});
			caller.note({ action: "maps.export", details: { placeId, names: names.length } });
			return json(202, { export: status, names });
		} catch (error) {
			if (error instanceof MapsError) {
				caller.note({ action: "maps.export", outcome: "refused", details: { error: error.message } });
				return json(error.status, { error: error.message }, error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {});
			}
			throw error;
		}
	}

	private geometry(req: Request, name: string): Response {
		const map = this.deps.store.find(name);
		if (!map) return json(404, { error: name === LOBBY ? "no lobby geometry: export the maps first" : `no exported map named ${JSON.stringify(name.slice(0, 100))}` });
		const v2 = new URL(req.url).searchParams.get("v") === "2";
		const etag = v2 ? `"${map.hash}.2"` : `"${map.hash}"`;
		const headers = { etag, "cache-control": "private, no-cache", "x-map-parts": String(map.parts) };
		const asked = req.headers.get("if-none-match");
		if (asked && asked.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
		const stored = this.deps.store.geometry(map);
		if (!stored) return json(404, { error: "the map's geometry file is missing: export again" });
		let blob: Uint8Array;
		try {
			blob = v2 ? stored : mapBlobV1(stored);
		} catch (error) {
			if (error instanceof MapFormatError) return json(500, { error: `the stored geometry is unreadable: ${error.message}` });
			throw error;
		}
		return new Response(blob as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(blob.byteLength) } });
	}

	private async override(req: Request, name: string, who: string, caller: MapsCaller): Promise<Response> {
		let body: unknown = null;
		if (req.method === "PUT") {
			if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json(415, { error: "send JSON: { path?, offset? }" });
			const raw = await readCapped(req, 4 * 1024);
			if (!raw) return json(413, { error: "body too large" });
			try {
				body = JSON.parse(Buffer.from(raw).toString("utf8"));
			} catch {
				return json(400, { error: "body is not JSON" });
			}
			if (body === null) return json(400, { error: "send { path?, offset? } (DELETE removes the override)" });
		}
		try {
			const saved = this.deps.store.setOverride(name, body, who);
			caller.note({ action: saved ? "maps.override.set" : "maps.override.remove", details: { map: name.slice(0, 100), ...(saved?.path ? { path: saved.path } : {}), ...(saved?.offset ? { offset: saved.offset } : {}) } });
			return json(200, { name, override: saved, note: saved?.path ? "the model path applies at the next export" : undefined });
		} catch (error) {
			if (error instanceof MapsError) {
				caller.note({ action: "maps.override.set", outcome: "refused", details: { map: name.slice(0, 100), error: error.message } });
				return json(error.status, { error: error.message });
			}
			if (error instanceof MapFormatError) return json(500, { error: error.message });
			throw error;
		}
	}

	private async positions(): Promise<{ value: MapPositionsResult | null; error?: string }> {
		const now = this.deps.clock();
		if (this.positionsCache && now - this.positionsCache.at < POSITIONS_TTL_MS) return this.positionsCache;
		try {
			this.positionsCache = { at: now, value: await this.deps.positions(ALIGN_DAYS) };
		} catch (error) {
			this.positionsCache = { at: now, value: null, error: `positioned events couldn't be read: ${String((error as Error)?.message ?? error).slice(0, 200)}` };
		}
		return this.positionsCache;
	}

	private async latestVersion(placeId: number): Promise<PlaceVersionInfo> {
		const now = this.deps.clock();
		if (this.placeVersion && this.placeVersion.placeId === placeId && now - this.placeVersion.at < PLACE_VERSION_TTL_MS) return this.placeVersion.value;
		let value: PlaceVersionInfo = { latest: null, source: null };
		const oc = this.deps.openCloud();
		let note: string | undefined;
		if (oc) {
			try {
				value = { latest: await latestPlaceVersion({ apiKey: oc.apiKey, placeId, attempts: 1, timeoutMs: 8000, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }), source: "roblox" };
			} catch (error) {
				note = `Roblox's version list isn't readable with this key (${String((error as Error)?.message ?? error).slice(0, 160)}): the fleet's newest version is used`;
			}
		}
		if (value.latest === null) {
			try {
				const v = await this.deps.fleetPlaceVersion(placeId, now - DAY_MS);
				value = v !== null ? { latest: v, source: "fleet" } : { latest: null, source: null };
			} catch {
				// No fleet: unknown.
			}
			if (note) value.note = note;
		}
		this.placeVersion = { at: now, placeId, value };
		return value;
	}
}

/** Whether an event's map value names this map (ignoring case and punctuation, like the export). */
function mapMatches(value: string, name: string): boolean {
	return mapKey(value) === mapKey(name);
}
