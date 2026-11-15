/**
 * Exported map geometry on disk, and the export itself (plans/33).
 *
 * `<data dir>/maps/index.json` (written atomically, mode 0600): the latest export (place, place version, when, by whom,
 * the maps with their bounds and part counts, the unmatched names), a short history, and the manual overrides
 * (map name -> model path and/or offset, owners only). `<data dir>/maps/geometry/<sha256>.ttmp`: one stored map
 * (format.ts `TTMP`), named by its content hash, so an unchanged map is never written twice and the hash is its ETag.
 * Blobs no export references any more are removed after each export.
 *
 * One export at a time (`busy`), at most one every MIN_EXPORT_GAP_MS. It runs in the background: `status()` tells the
 * explorer how far it got.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadBinaryOutput, OpenCloudError, runLuauTask } from "../opencloud.ts";
import { noteImageIds } from "../images/store.ts";
import { type Bounds, mapBlob, parseExport, parseTextures, RECORD_BYTES, summarize, textureImages, type Vec3 } from "./format.ts";
import { pickMaps } from "./match.ts";
import { exportScript, mapKey } from "./script.ts";

export const INDEX_VERSION = 1;
/** Exports a server keeps in the history list. */
export const HISTORY_MAX = 20;
/** Map names an export looks for, at most. */
export const NAMES_MAX = 200;
export const OVERRIDES_MAX = 100;
export const PATH_MAX = 512;
export const OFFSET_MAX = 1_000_000;
/** The least time between two exports (Roblox allows 5 task creations a minute per key owner). */
export const MIN_EXPORT_GAP_MS = 30_000;
/** The export task's own timeout (Luau Execution allows up to 300 s). */
export const TASK_TIMEOUT_SECONDS = 180;
/** The lobby's name in the list (the events never name it). */
export const LOBBY = "(lobby)";

export interface MapOverride {
	/** The model's path from the DataModel ("ReplicatedStorage.assets.maps.Mall"). */
	path?: string;
	/** Added to the geometry to put it where the game plays it (studs). */
	offset?: Vec3;
	by: string;
	at: number;
}

export interface StoredMap {
	name: string;
	kind: "map" | "lobby";
	/** How the model was found: by its name, by a manual override, or the lobby (Workspace's other parts). */
	via: "name" | "override" | "lobby";
	path: string;
	parts: number;
	meshes: number;
	unions: number;
	invisible: number;
	bounds: Bounds | null;
	hash: string;
	bytes: number;
	/** Other models with the same name (not used). */
	alternatives: string[];
	/** Its Decals, Textures and MaterialVariant parts (plans/36 phase 5; absent: none, or exported before textures). */
	textures?: MapTextureCounts;
}

export interface MapTextureCounts {
	decals: number;
	textures: number;
	variantParts: number;
	/** Distinct image Content strings (surfaces and color maps). */
	images: number;
}

export interface ExportRecord {
	placeId: number;
	universeId: number;
	placeVersion: number | null;
	at: number;
	by: string;
	seconds: number;
	parts: number;
	bytes: number;
	truncated: boolean;
	maps: StoredMap[];
	unmatched: string[];
	notes: string[];
}

export interface MapsIndex {
	format: number;
	latest: ExportRecord | null;
	history: { at: number; by: string; placeVersion: number | null; maps: number; parts: number }[];
	overrides: Record<string, MapOverride>;
}

export interface ExportStatus {
	state: "idle" | "running" | "done" | "failed";
	step: string;
	startedAt: number | null;
	finishedAt: number | null;
	by: string | null;
	error: string | null;
}

export class MapsError extends Error {
	override name = "MapsError";
	constructor(
		readonly status: number,
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
	}
}

export interface MapStoreOptions {
	dataDir: string;
	clock?: () => number;
	log?: (line: string) => void;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** Open Cloud base URL (tests). */
	base?: string;
	pollMs?: number;
	retryDelayMs?: number;
	/** Where the textures' image ids go (default: the module's noteImageIds). */
	noteImages?: (ids: readonly string[]) => void;
}

export interface ExportInput {
	apiKey: string;
	universeId: number;
	placeId: number;
	names: string[];
	by: string;
	/** Told when the export ends (the audit's system entry, then the animation pass). */
	onDone?: (outcome: "ok" | "failed", details: Record<string, unknown>) => void;
}

/** A texture section's counts, and its image ids handed to the image store (fire and forget). */
function textureCounts(textures: Uint8Array, parts: number, note: (ids: readonly string[]) => void): MapTextureCounts | undefined {
	if (!textures.byteLength) return undefined;
	const t = parseTextures(textures, parts);
	const images = textureImages(t);
	note(images);
	let decals = 0;
	for (const s of t.surfaces) if (s.kind === "decal") decals++;
	return { decals, textures: t.surfaces.length - decals, variantParts: t.variantParts.size, images: images.length };
}

export class MapStore {
	readonly dir: string;
	private readonly geometryDir: string;
	private readonly file: string;
	private readonly clock: () => number;
	private index: MapsIndex;
	/** index.json's mtime when it was read (another instance sharing the data dir, a rolling deploy, may write it). */
	private indexMtime = 0;
	private current: ExportStatus = { state: "idle", step: "", startedAt: null, finishedAt: null, by: null, error: null };
	private running: Promise<void> | null = null;

	constructor(private readonly options: MapStoreOptions) {
		this.dir = join(options.dataDir, "maps");
		this.geometryDir = join(this.dir, "geometry");
		this.file = join(this.dir, "index.json");
		this.clock = options.clock ?? Date.now;
		this.index = this.load();
	}

	private load(): MapsIndex {
		const empty: MapsIndex = { format: INDEX_VERSION, latest: null, history: [], overrides: {} };
		if (!existsSync(this.file)) return empty;
		try {
			this.indexMtime = statSync(this.file).mtimeMs;
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as MapsIndex;
			if (parsed?.format !== INDEX_VERSION) return empty;
			return { ...empty, ...parsed, overrides: parsed.overrides ?? {}, history: parsed.history ?? [] };
		} catch (error) {
			this.options.log?.(`maps: ${this.file} is unreadable (${(error as Error).message}); starting empty`);
			return empty;
		}
	}

	private save(): void {
		mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.index), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
		this.indexMtime = statSync(this.file).mtimeMs;
	}

	/** Reads index.json again when another process changed it. */
	private fresh(): MapsIndex {
		try {
			if (existsSync(this.file) && statSync(this.file).mtimeMs !== this.indexMtime) this.index = this.load();
		} catch {
			// keep what is in memory
		}
		return this.index;
	}

	get latest(): ExportRecord | null {
		return this.fresh().latest;
	}

	get history(): MapsIndex["history"] {
		return this.fresh().history;
	}

	get overrides(): Record<string, MapOverride> {
		return this.fresh().overrides;
	}

	status(): ExportStatus {
		return { ...this.current };
	}

	/** Resolves when the running export (if any) has finished (tests, shutdown). */
	async idle(): Promise<void> {
		await this.running;
	}

	/** A stored map by name (ignoring case and punctuation; LOBBY for the lobby). */
	find(name: string): StoredMap | undefined {
		const key = mapKey(name);
		return this.fresh().latest?.maps.find((m) => (name === LOBBY ? m.kind === "lobby" : m.kind === "map" && mapKey(m.name) === key));
	}

	geometry(map: StoredMap): Uint8Array | null {
		const file = join(this.geometryDir, `${map.hash}.ttmp`);
		if (!/^[0-9a-f]{64}$/.test(map.hash) || !existsSync(file)) return null;
		return new Uint8Array(readFileSync(file));
	}

	/** Sets or clears (null) a map's override. */
	setOverride(name: string, input: unknown, by: string): MapOverride | null {
		this.fresh();
		const clean = name.trim();
		if (!clean || clean.length > 100 || !mapKey(clean)) throw new MapsError(400, "the map name must have letters or digits (at most 100 characters)");
		const existing = Object.keys(this.index.overrides).find((k) => mapKey(k) === mapKey(clean));
		if (input === null) {
			if (existing) delete this.index.overrides[existing];
			this.save();
			return null;
		}
		if (typeof input !== "object" || Array.isArray(input)) throw new MapsError(400, "send { path?, offset? } or null");
		const body = input as Record<string, unknown>;
		for (const k of Object.keys(body)) if (k !== "path" && k !== "offset") throw new MapsError(400, `unknown field ${k}`);
		const out: MapOverride = { by, at: this.clock() };
		if (body.path !== undefined && body.path !== null && body.path !== "") {
			if (typeof body.path !== "string" || body.path.length > PATH_MAX || /[\u0000-\u001f]/.test(body.path) || body.path.split(".").some((s) => s === "")) {
				throw new MapsError(400, `path is an instance path like ReplicatedStorage.assets.maps.Mall (at most ${PATH_MAX} characters)`);
			}
			out.path = body.path;
		}
		if (body.offset !== undefined && body.offset !== null) {
			const o = body.offset;
			if (!Array.isArray(o) || o.length !== 3 || !o.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= OFFSET_MAX)) {
				throw new MapsError(400, `offset is [x, y, z] in studs (each at most ${OFFSET_MAX} away from 0)`);
			}
			out.offset = o.map((v) => Math.round((v as number) * 100) / 100) as Vec3;
		}
		if (!out.path && !out.offset) throw new MapsError(400, "an override needs a path, an offset or both (null removes it)");
		if (!existing && Object.keys(this.index.overrides).length >= OVERRIDES_MAX) throw new MapsError(409, `at most ${OVERRIDES_MAX} overrides`);
		if (existing) delete this.index.overrides[existing];
		this.index.overrides[clean] = out;
		this.save();
		return out;
	}

	/** Starts an export in the background. Throws MapsError 409 while one runs, 429 too soon after the last. */
	start(input: ExportInput): ExportStatus {
		if (this.current.state === "running") throw new MapsError(409, "an export is already running");
		this.fresh();
		const last = Math.max(this.current.startedAt ?? 0, this.index.latest?.at ?? 0);
		const wait = last + MIN_EXPORT_GAP_MS - this.clock();
		if (last && wait > 0) throw new MapsError(429, `the last export was moments ago: try again in ${Math.ceil(wait / 1000)} s`, Math.ceil(wait / 1000));
		this.current = { state: "running", step: "starting", startedAt: this.clock(), finishedAt: null, by: input.by, error: null };
		this.running = this.run(input).finally(() => {
			this.running = null;
		});
		return this.status();
	}

	private async run(input: ExportInput): Promise<void> {
		const started = this.clock();
		const step = (s: string) => {
			this.current.step = s;
		};
		try {
			const names = dedupe([...input.names, ...Object.keys(this.index.overrides)]).slice(0, NAMES_MAX);
			const overrides = Object.entries(this.index.overrides)
				.filter(([, o]) => o.path)
				.map(([name, o]) => ({ name, path: o.path as string }));
			const task = await runLuauTask({
				apiKey: input.apiKey,
				universeId: input.universeId,
				placeId: input.placeId,
				script: exportScript({ names, overrides }),
				timeoutSeconds: TASK_TIMEOUT_SECONDS,
				binaryOutput: true,
				attempts: 3,
				...(this.options.fetch ? { fetch: this.options.fetch } : {}),
				...(this.options.base ? { base: this.options.base } : {}),
				...(this.options.sleep ? { sleep: this.options.sleep } : {}),
				...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
				...(this.options.retryDelayMs !== undefined ? { retryDelayMs: this.options.retryDelayMs } : {}),
				onState: (s) => step(s === "creating" ? "creating the task" : s === "QUEUED" ? "queued on Roblox" : s === "PROCESSING" ? "running in the place" : s),
			});
			if (task.state !== "COMPLETE") throw new MapsError(502, `the export task ended ${task.state || "without a state"}${describeTaskError(task.error)}`);
			if (!task.binaryOutputUri) throw new MapsError(502, "the export task returned no binary output");
			step("downloading the geometry");
			const bytes = await downloadBinaryOutput({ uri: task.binaryOutputUri, apiKey: input.apiKey, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.sleep ? { sleep: this.options.sleep } : {}) });
			step("storing");
			const summary = parseSummary(task.results[0]);
			const entries = parseExport(bytes);
			const picks = pickMaps(names, entries, this.index.overrides);
			mkdirSync(this.geometryDir, { recursive: true });
			const store = (records: Uint8Array, textures: Uint8Array) => {
				const blob = mapBlob(records, textures);
				const hash = createHash("sha256").update(blob).digest("hex");
				const file = join(this.geometryDir, `${hash}.ttmp`);
				if (!existsSync(file)) {
					const tmp = `${file}.${process.pid}.tmp`;
					writeFileSync(tmp, blob, { mode: 0o600 });
					renameSync(tmp, file);
				}
				const counts = textureCounts(textures, records.byteLength / RECORD_BYTES, this.options.noteImages ?? noteImageIds);
				return { hash, bytes: blob.byteLength, ...(counts ? { textures: counts } : {}) };
			};
			const maps: StoredMap[] = picks.maps.map((p) => ({
				name: p.name,
				kind: "map",
				via: p.entry.via === "override" ? "override" : "name",
				path: p.entry.path,
				...summarize(p.entry.records),
				alternatives: p.alternatives.slice(0, 10),
				...store(p.entry.records, p.entry.textures),
			}));
			const lobby = entries.find((e) => e.kind === "lobby");
			if (lobby && lobby.parts > 0) maps.push({ name: LOBBY, kind: "lobby", via: "lobby", path: lobby.path, ...summarize(lobby.records), alternatives: [], ...store(lobby.records, lobby.textures) });
			const fromPath = /\/versions\/(\d+)\//.exec(task.path ?? "")?.[1];
			const placeVersion = summary.placeVersion ?? (fromPath ? Number(fromPath) : null);
			const record: ExportRecord = {
				placeId: input.placeId,
				universeId: input.universeId,
				placeVersion,
				at: this.clock(),
				by: input.by,
				seconds: Math.round((this.clock() - started) / 100) / 10,
				parts: maps.reduce((s, m) => s + m.parts, 0),
				bytes: bytes.byteLength,
				truncated: summary.truncated,
				maps,
				unmatched: picks.unmatched,
				notes: summary.notes,
			};
			this.index.latest = record;
			this.index.history = [{ at: record.at, by: record.by, placeVersion, maps: maps.length, parts: record.parts }, ...this.index.history].slice(0, HISTORY_MAX);
			this.save();
			this.prune();
			this.current = { ...this.current, state: "done", step: "done", finishedAt: this.clock() };
			this.options.log?.(`maps: exported ${maps.length} maps (${record.parts} parts, ${record.bytes} bytes) of place ${input.placeId} v${placeVersion ?? "?"} in ${record.seconds} s; unmatched: ${picks.unmatched.join(", ") || "none"}`);
			input.onDone?.("ok", { placeId: input.placeId, placeVersion, maps: maps.length, parts: record.parts, bytes: record.bytes, seconds: record.seconds, unmatched: picks.unmatched.length });
		} catch (error) {
			const message = (error instanceof OpenCloudError || error instanceof MapsError ? error.message : `the export failed: ${(error as Error)?.message ?? error}`).slice(0, 500);
			this.current = { ...this.current, state: "failed", step: "failed", finishedAt: this.clock(), error: message };
			this.options.log?.(`maps: export failed: ${message}`);
			input.onDone?.("failed", { placeId: input.placeId, error: message.slice(0, 200) });
		}
	}

	/** Removes geometry files the latest export doesn't reference. */
	private prune(): void {
		const keep = new Set((this.index.latest?.maps ?? []).map((m) => `${m.hash}.ttmp`));
		for (const file of existsSync(this.geometryDir) ? readdirSync(this.geometryDir) : []) {
			if (!keep.has(file)) rmSync(join(this.geometryDir, file), { force: true });
		}
	}
}

function dedupe(names: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of names) {
		const key = mapKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

function describeTaskError(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const e = error as Record<string, unknown>;
	const text = [e.code, e.message].filter((v) => typeof v === "string" && v).join(": ");
	return text ? ` (${text.replace(/\s+/g, " ").slice(0, 300)})` : "";
}

function parseSummary(raw: unknown): { placeVersion: number | null; truncated: boolean; notes: string[] } {
	try {
		const s = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const v = Number(s.placeVersion);
		return {
			placeVersion: Number.isSafeInteger(v) && v > 0 ? v : null,
			truncated: s.truncated === true,
			notes: Array.isArray(s.notes) ? s.notes.filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 300)).slice(0, 20) : [],
		};
	} catch {
		return { placeVersion: null, truncated: false, notes: [] };
	}
}
