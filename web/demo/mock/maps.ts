/**
 * The maps routes (src/server/maps.ts, src/maps/store.ts) over The Prison's real exported map (the pack's
 * maps-index.json and <sha256>.ttmp, served from the site's own /data/):
 *
 *   GET    /v1/maps                   the latest export (one lobby map: The Prison is a single-place game), the export's
 *                                     state, the place version (the fleet's PLACE_VERSION: up to date), overrides, history
 *   GET    /v1/maps/:name/geometry    the TTMP bytes, ETag = the content hash (304 on If-None-Match)
 *   POST   /v1/maps/export            a simulated export: ~10 s through the backend's steps, then a new history entry
 *   PUT    /v1/maps/:name/override    { path?, offset? }, checked like MapStore.setOverride
 *   DELETE /v1/maps/:name/override
 *
 * The events carry no `map` prop and no positions, so `names` is empty and every alignment is "unknown" (as the backend
 * answers for this game). Nothing here loads DuckDB.
 */
import type { ExportStatus, MapInfo, MapOverride, MapsView, Vec3 } from "@/lib/maps";
import { OWNER_WHO, recordAudit } from "./admin";
import { manifest, now, readData, readDataJson, shiftMs } from "./data";
import { PLACE_VERSION } from "./fleet-model";
import { pack } from "./pack";
import { fail, json, route } from "./router";
import { slice } from "./state";

const LOBBY = "(lobby)";
const OVERRIDES_MAX = 100;
const PATH_MAX = 512;
const OFFSET_MAX = 1_000_000;
const MIN_EXPORT_GAP_MS = 30_000;
/** How long the simulated export takes, and its steps (src/maps/store.ts names them). */
const EXPORT_STEPS: [number, string][] = [
	[0, "starting"],
	[600, "creating the task"],
	[1_800, "queued on Roblox"],
	[4_200, "running in the place"],
	[8_600, "downloading the geometry"],
	[9_600, "storing"],
];
export const EXPORT_MS = 10_400;

const mapKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

interface IndexMap extends Omit<MapInfo, "offset" | "override" | "alignment"> {}

interface MapsIndex {
	format: 1;
	latest: (NonNullable<MapsView["latest"]> & { maps: IndexMap[] }) | null;
	history: MapsView["history"];
	overrides: Record<string, MapOverride>;
}

interface MapsState {
	overrides: Record<string, MapOverride>;
	/** Exports run in this browser (oldest first). */
	exports: { startedAt: number; by: string; names: string[] }[];
}

const state = slice<MapsState>("maps.state", () => ({ overrides: {}, exports: [] }));

const EMPTY_INDEX: MapsIndex = { format: 1, latest: null, history: [], overrides: {} };

async function loadIndex(): Promise<MapsIndex> {
	const m = await manifest();
	if (!m.maps.index) return EMPTY_INDEX;
	try {
		return await readDataJson<MapsIndex>(m.maps.index);
	} catch {
		return EMPTY_INDEX;
	}
}

/** The pack's export time on the demo's timeline: shifted like the rest, and never later than an hour ago. */
function shiftedExport(at: number): number {
	let t = at + shiftMs();
	const latest = now() - 3_600_000;
	while (t > latest) t -= 86_400_000;
	return t;
}

function exportStatus(at: number): ExportStatus {
	const last = state.get().exports.at(-1);
	if (!last) return { state: "idle", step: "", startedAt: null, finishedAt: null, by: null, error: null };
	const elapsed = at - last.startedAt;
	if (elapsed >= EXPORT_MS) return { state: "done", step: "done", startedAt: last.startedAt, finishedAt: last.startedAt + EXPORT_MS, by: last.by, error: null };
	let step = "starting";
	for (const [t, s] of EXPORT_STEPS) if (elapsed >= t) step = s;
	return { state: "running", step, startedAt: last.startedAt, finishedAt: null, by: last.by, error: null };
}

/** The latest export and the history: the pack's export, then the ones finished in this browser. */
async function exports(): Promise<{ latest: MapsIndex["latest"]; history: MapsView["history"] }> {
	await pack();
	const index = await loadIndex();
	if (!index.latest) return { latest: null, history: [] };
	const at = now();
	const base = { ...index.latest, at: shiftedExport(index.latest.at) };
	const history = index.history.map((h) => ({ ...h, at: shiftedExport(h.at) }));
	let latest = base;
	for (const e of state.get().exports) {
		const done = e.startedAt + EXPORT_MS;
		if (done > at) continue;
		const seconds = Math.round((EXPORT_MS - 1_700) / 100) / 10;
		latest = { ...base, at: done, by: e.by, placeVersion: PLACE_VERSION, seconds };
		history.unshift({ at: done, by: e.by, placeVersion: PLACE_VERSION, maps: base.maps.length, parts: base.parts });
	}
	return { latest, history: history.slice(0, 20) };
}

function overrideFor(overrides: Record<string, MapOverride>, name: string): MapOverride | undefined {
	const key = mapKey(name);
	for (const [k, v] of Object.entries(overrides)) if (mapKey(k) === key) return v;
	return undefined;
}

route<MapsView>("GET", "/v1/maps", async () => {
	const at = now();
	const { latest, history } = await exports();
	const overrides = state.get().overrides;
	const maps: MapInfo[] = (latest?.maps ?? []).map((m) => {
		const override = m.kind === "map" ? overrideFor(overrides, m.name) : undefined;
		return { ...m, offset: (override?.offset ?? [0, 0, 0]) as Vec3, ...(override ? { override } : {}), alignment: { state: "unknown", samples: 0, inside: 0 } };
	});
	const exported = latest?.placeVersion ?? null;
	return {
		configured: true,
		canExport: true,
		export: exportStatus(at),
		latest: latest
			? { placeId: latest.placeId, universeId: latest.universeId, placeVersion: exported, at: latest.at, by: latest.by, seconds: latest.seconds, parts: latest.parts, bytes: latest.bytes, truncated: latest.truncated, unmatched: latest.unmatched, notes: latest.notes }
			: null,
		placeVersion: { latest: latest ? PLACE_VERSION : null, source: latest ? "roblox" : null, exported, outOfDate: exported !== null && latest !== null && PLACE_VERSION > exported },
		maps,
		names: [],
		overrides,
		history,
	};
});

route<{ export: ExportStatus; names: string[] }>("POST", "/v1/maps/export", async (req) => {
	let extra: string[] = [];
	if (req.text.length > 16 * 1024) return fail(413, "body too large");
	if (req.text.length) {
		let body: unknown;
		try {
			body = JSON.parse(req.text);
		} catch {
			return fail(400, "body is not JSON");
		}
		const names = (body as { names?: unknown } | null)?.names;
		if (names !== undefined) {
			if (!Array.isArray(names) || names.length > 50 || !names.every((n) => typeof n === "string" && n.length > 0 && n.length <= 100 && !/[\u0000-\u001f]/.test(n))) {
				return fail(400, "names is a list of at most 50 map names (1-100 characters each)");
			}
			extra = names as string[];
		}
	}
	const at = now();
	const current = exportStatus(at);
	if (current.state === "running") {
		recordAudit({ action: "maps.export", outcome: "refused", status: 409, details: { error: "an export is already running" } });
		return fail(409, "an export is already running");
	}
	const { latest } = await exports();
	const last = Math.max(current.startedAt ?? 0, latest?.at ?? 0);
	const wait = last + MIN_EXPORT_GAP_MS - at;
	if (last && wait > 0) {
		const message = `the last export was moments ago: try again in ${Math.ceil(wait / 1000)} s`;
		recordAudit({ action: "maps.export", outcome: "refused", status: 429, details: { error: message } });
		return json(429, { error: message }, { "retry-after": String(Math.ceil(wait / 1000)) });
	}
	const placeId = latest?.placeId ?? (await pack()).placeId;
	state.update((s) => {
		s.exports.push({ startedAt: at, by: OWNER_WHO, names: extra });
		if (s.exports.length > 20) s.exports.splice(0, s.exports.length - 20);
	});
	recordAudit({ action: "maps.export", status: 202, details: { placeId, names: extra.length } });
	// The export's end, as the backend's system entry (shows once its time has come).
	recordAudit({
		action: "maps.export.done",
		system: "map export",
		at: at + EXPORT_MS,
		details: { placeId, placeVersion: PLACE_VERSION, maps: latest?.maps.length ?? 0, parts: latest?.parts ?? 0, bytes: latest?.bytes ?? 0, seconds: Math.round((EXPORT_MS - 1_700) / 100) / 10, unmatched: 0 },
	});
	return json(202, { export: exportStatus(at), names: extra });
});

route("GET", "/v1/maps/:name/geometry", async (req) => {
	const name = req.params.name as string;
	const { latest } = await exports();
	const key = mapKey(name);
	const map = latest?.maps.find((m) => (name === LOBBY ? m.kind === "lobby" : m.kind === "map" && mapKey(m.name) === key));
	if (!map) return fail(404, name === LOBBY ? "no lobby geometry: export the maps first" : `no exported map named ${JSON.stringify(name.slice(0, 100))}`);
	const etag = `"${map.hash}"`;
	const headers = { etag, "cache-control": "private, no-cache", "x-map-parts": String(map.parts) };
	const asked = req.headers.get("if-none-match");
	if (asked && asked.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
	if (!/^[0-9a-f]{64}$/.test(map.hash)) return fail(404, "the map's geometry file is missing: export again");
	let bytes: Uint8Array;
	try {
		bytes = await readData(`${map.hash}.ttmp`);
	} catch {
		return fail(404, "the map's geometry file is missing: export again");
	}
	return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) } });
});

route<{ name: string; override: MapOverride | null; note?: string }>(["PUT", "DELETE"], "/v1/maps/:name/override", (req) => {
	const name = req.params.name as string;
	if (name === LOBBY) return fail(400, "the lobby has no override");
	let body: unknown = null;
	if (req.method === "PUT") {
		if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return fail(415, "send JSON: { path?, offset? }");
		if (req.text.length > 4 * 1024) return fail(413, "body too large");
		try {
			body = JSON.parse(req.text);
		} catch {
			return fail(400, "body is not JSON");
		}
		if (body === null) return fail(400, "send { path?, offset? } (DELETE removes the override)");
	}
	const refuse = (status: number, message: string) => {
		recordAudit({ action: "maps.override.set", outcome: "refused", status, details: { map: name.slice(0, 100), error: message } });
		return fail(status, message);
	};
	const clean = name.trim();
	if (!clean || clean.length > 100 || !mapKey(clean)) return refuse(400, "the map name must have letters or digits (at most 100 characters)");
	const overrides = state.get().overrides;
	const existing = Object.keys(overrides).find((k) => mapKey(k) === mapKey(clean));
	if (body === null) {
		state.update((s) => {
			if (existing) delete s.overrides[existing];
		});
		recordAudit({ action: "maps.override.remove", details: { map: name.slice(0, 100) } });
		return { name, override: null };
	}
	if (typeof body !== "object" || Array.isArray(body)) return refuse(400, "send { path?, offset? } or null");
	const input = body as Record<string, unknown>;
	for (const k of Object.keys(input)) if (k !== "path" && k !== "offset") return refuse(400, `unknown field ${k}`);
	const out: MapOverride = { by: OWNER_WHO, at: now() };
	if (input.path !== undefined && input.path !== null && input.path !== "") {
		if (typeof input.path !== "string" || input.path.length > PATH_MAX || /[\u0000-\u001f]/.test(input.path) || input.path.split(".").some((s) => s === "")) {
			return refuse(400, `path is an instance path like ReplicatedStorage.assets.maps.Mall (at most ${PATH_MAX} characters)`);
		}
		out.path = input.path;
	}
	if (input.offset !== undefined && input.offset !== null) {
		const o = input.offset;
		if (!Array.isArray(o) || o.length !== 3 || !o.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= OFFSET_MAX)) {
			return refuse(400, `offset is [x, y, z] in studs (each at most ${OFFSET_MAX} away from 0)`);
		}
		out.offset = o.map((v) => Math.round((v as number) * 100) / 100) as Vec3;
	}
	if (!out.path && !out.offset) return refuse(400, "an override needs a path, an offset or both (null removes it)");
	if (!existing && Object.keys(overrides).length >= OVERRIDES_MAX) return refuse(409, `at most ${OVERRIDES_MAX} overrides`);
	state.update((s) => {
		if (existing) delete s.overrides[existing];
		s.overrides[clean] = out;
	});
	recordAudit({ action: "maps.override.set", details: { map: name.slice(0, 100), ...(out.path ? { path: out.path } : {}), ...(out.offset ? { offset: out.offset } : {}) } });
	return { name, override: out, ...(out.path ? { note: "the model path applies at the next export" } : {}) };
});
