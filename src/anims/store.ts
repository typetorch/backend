/**
 * Animation clips for the replays (plans/36 "Animations on every tracked Animator", "The clips").
 *
 * The replay decoders note every animation id the recordings play (`noteAnimationIds`); the animation pass (a read-only
 * Open Cloud Luau Execution task, script.ts, right after each map export or on its own through POST /v1/anims/export)
 * loads each id not exported yet with KeyframeSequenceProvider and stores its keyframes. Roblox's default R6 animations
 * (script.ts DEFAULT_R6_ANIMATIONS) are always in the list, so a fresh game has them.
 *
 * On disk: `<data dir>/anims/index.json` (atomic, 0600): the ids seen (with when), the exported ones, the failed ones
 * (with the pcall's error; tried again after RETRY_FAILED_MS), the last pass. `<data dir>/anims/clips/<id>.json`: one
 * clip (format.ts `Clip`); an animation asset's keyframes never change, so a stored clip is never exported again.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetIdOf } from "../images/store.ts";
import { downloadBinaryOutput, OpenCloudError, runLuauTask } from "../opencloud.ts";
import { type Clip, parseAnimExport } from "./format.ts";
import { animScript, DEFAULT_R6_ANIMATIONS, IDS_PER_TASK } from "./script.ts";

const INDEX_VERSION = 1;
/** Animation ids remembered at most (seen, exported, failed each). */
export const SEEN_MAX = 5000;
export const RETRY_FAILED_MS = 86_400_000;
/** The least time between two animation passes. */
export const MIN_PASS_GAP_MS = 30_000;
export const TASK_TIMEOUT_SECONDS = 180;
/** A stored clip's JSON at most. */
export const CLIP_MAX_BYTES = 4 * 1024 * 1024;
const SAVE_DELAY_MS = 2000;

export interface AnimsIndex {
	format: number;
	seen: Record<string, number>;
	exported: Record<string, { at: number; bytes: number }>;
	failed: Record<string, { at: number; error: string }>;
	last: AnimPass | null;
}

export interface AnimPass {
	at: number;
	by: string;
	placeId: number;
	placeVersion: number | null;
	seconds: number;
	ids: number;
	loaded: number;
	failed: number;
	skipped: number;
}

export interface AnimPassStatus {
	state: "idle" | "running" | "done" | "failed";
	step: string;
	startedAt: number | null;
	finishedAt: number | null;
	by: string | null;
	error: string | null;
}

export class AnimsError extends Error {
	override name = "AnimsError";
	constructor(
		readonly status: number,
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
	}
}

export interface AnimStoreOptions {
	dataDir: string;
	clock?: () => number;
	log?: (line: string) => void;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	base?: string;
	pollMs?: number;
	retryDelayMs?: number;
}

export interface AnimPassInput {
	apiKey: string;
	universeId: number;
	placeId: number;
	by: string;
	onDone?: (outcome: "ok" | "failed", details: Record<string, unknown>) => void;
}

export class AnimStore {
	readonly dir: string;
	private readonly clipsDir: string;
	private readonly file: string;
	private readonly clock: () => number;
	private index: AnimsIndex;
	private indexMtime = 0;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private current: AnimPassStatus = { state: "idle", step: "", startedAt: null, finishedAt: null, by: null, error: null };
	private running: Promise<void> | null = null;

	constructor(private readonly options: AnimStoreOptions) {
		this.dir = join(options.dataDir, "anims");
		this.clipsDir = join(this.dir, "clips");
		this.file = join(this.dir, "index.json");
		this.clock = options.clock ?? Date.now;
		this.index = this.load();
	}

	private load(): AnimsIndex {
		const empty: AnimsIndex = { format: INDEX_VERSION, seen: {}, exported: {}, failed: {}, last: null };
		if (!existsSync(this.file)) return empty;
		try {
			this.indexMtime = statSync(this.file).mtimeMs;
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as AnimsIndex;
			if (parsed?.format !== INDEX_VERSION) return empty;
			return { ...empty, ...parsed, seen: parsed.seen ?? {}, exported: parsed.exported ?? {}, failed: parsed.failed ?? {} };
		} catch (error) {
			this.options.log?.(`anims: ${this.file} is unreadable (${(error as Error).message}); starting empty`);
			return empty;
		}
	}

	/** Writes index.json now (atomic, 0600). */
	save(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			mkdirSync(this.dir, { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.index), { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, this.file);
			this.indexMtime = statSync(this.file).mtimeMs;
		} catch (error) {
			this.options.log?.(`anims: couldn't write ${this.file} (${(error as Error).message})`);
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.save();
		}, SAVE_DELAY_MS);
		(this.saveTimer as { unref?: () => void }).unref?.();
	}

	/** Reads index.json again when another process (a rolling deploy) changed it; never over unsaved notes. */
	private fresh(): AnimsIndex {
		try {
			if (!this.saveTimer && existsSync(this.file) && statSync(this.file).mtimeMs !== this.indexMtime) this.index = this.load();
		} catch {
			// keep what is in memory
		}
		return this.index;
	}

	/** Remembers animation ids (asset ids or `rbxassetid://` strings; anything else ignored). Idempotent. */
	note(ids: readonly string[]): number {
		if (!Array.isArray(ids)) return 0;
		const index = this.fresh();
		let added = 0;
		const now = this.clock();
		for (const raw of ids.slice(0, 10_000)) {
			const id = typeof raw === "string" ? assetIdOf(raw) : null;
			if (!id || id in index.seen) continue;
			if (Object.keys(index.seen).length >= SEEN_MAX) break;
			index.seen[id] = now;
			added++;
		}
		if (added) this.scheduleSave();
		return added;
	}

	/** One stored clip, or why there is none. */
	clip(id: string): { state: "exported"; clip: Clip } | { state: "failed"; error: string } | { state: "pending" } {
		const index = this.fresh();
		if (index.exported[id]) {
			try {
				return { state: "exported", clip: JSON.parse(readFileSync(join(this.clipsDir, `${id}.json`), "utf8")) as Clip };
			} catch {
				delete index.exported[id];
				this.scheduleSave();
			}
		}
		const failed = index.failed[id];
		if (failed) return { state: "failed", error: failed.error };
		return { state: "pending" };
	}

	/** The ids the next pass loads: seen and the defaults, not exported, not failed recently. Oldest seen first. */
	waiting(): string[] {
		const index = this.fresh();
		const now = this.clock();
		const ids = [...Object.keys(DEFAULT_R6_ANIMATIONS), ...Object.entries(index.seen).sort((a, b) => a[1] - b[1]).map(([id]) => id)];
		return [...new Set(ids)].filter((id) => !index.exported[id] && !(index.failed[id] && now - index.failed[id].at < RETRY_FAILED_MS));
	}

	summary(): { seen: number; exported: number; failed: number; waiting: number; last: AnimPass | null; pass: AnimPassStatus; defaults: { id: string; name: string; exported: boolean }[] } {
		const index = this.fresh();
		return {
			seen: Object.keys(index.seen).length,
			exported: Object.keys(index.exported).length,
			failed: Object.keys(index.failed).length,
			waiting: this.waiting().length,
			last: index.last,
			pass: this.status(),
			defaults: Object.entries(DEFAULT_R6_ANIMATIONS).map(([id, name]) => ({ id, name, exported: Boolean(index.exported[id]) })),
		};
	}

	status(): AnimPassStatus {
		return { ...this.current };
	}

	async idle(): Promise<void> {
		await this.running;
	}

	/** Starts an animation pass in the background. 409 while one runs, 429 too soon after the last; null: nothing to load. */
	start(input: AnimPassInput): AnimPassStatus | null {
		if (this.current.state === "running") throw new AnimsError(409, "an animation pass is already running");
		const last = Math.max(this.current.startedAt ?? 0, this.fresh().last?.at ?? 0);
		const wait = last + MIN_PASS_GAP_MS - this.clock();
		if (last && wait > 0) throw new AnimsError(429, `the last animation pass was moments ago: try again in ${Math.ceil(wait / 1000)} s`, Math.ceil(wait / 1000));
		const ids = this.waiting().slice(0, IDS_PER_TASK);
		if (!ids.length) return null;
		this.current = { state: "running", step: "starting", startedAt: this.clock(), finishedAt: null, by: input.by, error: null };
		this.running = this.run(input, ids).finally(() => {
			this.running = null;
		});
		return this.status();
	}

	private async run(input: AnimPassInput, ids: string[]): Promise<void> {
		const started = this.clock();
		const step = (s: string) => {
			this.current.step = s;
		};
		try {
			const task = await runLuauTask({
				apiKey: input.apiKey,
				universeId: input.universeId,
				placeId: input.placeId,
				script: animScript(ids),
				timeoutSeconds: TASK_TIMEOUT_SECONDS,
				binaryOutput: true,
				attempts: 3,
				...(this.options.fetch ? { fetch: this.options.fetch } : {}),
				...(this.options.base ? { base: this.options.base } : {}),
				...(this.options.sleep ? { sleep: this.options.sleep } : {}),
				...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
				...(this.options.retryDelayMs !== undefined ? { retryDelayMs: this.options.retryDelayMs } : {}),
				onState: (s) => step(s === "creating" ? "creating the task" : s === "QUEUED" ? "queued on Roblox" : s === "PROCESSING" ? "loading animations in the place" : s),
			});
			if (task.state !== "COMPLETE") throw new AnimsError(502, `the animation task ended ${task.state || "without a state"}${describeTaskError(task.error)}`);
			if (!task.binaryOutputUri) throw new AnimsError(502, "the animation task returned no binary output");
			step("downloading the clips");
			const bytes = await downloadBinaryOutput({ uri: task.binaryOutputUri, apiKey: input.apiKey, maxBytes: 128 * 1024 * 1024, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.sleep ? { sleep: this.options.sleep } : {}) });
			step("storing");
			const clips = parseAnimExport(bytes);
			const index = this.fresh();
			mkdirSync(this.clipsDir, { recursive: true });
			const now = this.clock();
			let loaded = 0;
			let failed = 0;
			let skipped = 0;
			for (const c of clips) {
				if (!ids.includes(c.id)) continue;
				if (c.status === "skipped") {
					skipped++;
					continue;
				}
				if (c.status === "failed") {
					failed++;
					index.failed[c.id] = { at: now, error: c.error.replace(/https?:\/\/\S+/g, "<url>").slice(0, 300) };
					continue;
				}
				const text = JSON.stringify({ ...c.clip, exportedAt: now } satisfies Clip);
				if (text.length > CLIP_MAX_BYTES) {
					failed++;
					index.failed[c.id] = { at: now, error: `the clip is ${text.length} bytes as JSON (at most ${CLIP_MAX_BYTES})` };
					continue;
				}
				const file = join(this.clipsDir, `${c.id}.json`);
				const tmp = `${file}.${process.pid}.tmp`;
				writeFileSync(tmp, text, { mode: 0o600 });
				renameSync(tmp, file);
				index.exported[c.id] = { at: now, bytes: text.length };
				delete index.failed[c.id];
				loaded++;
			}
			const summary = parseSummary(task.results[0]);
			const fromPath = /\/versions\/(\d+)\//.exec(task.path ?? "")?.[1];
			index.last = {
				at: now,
				by: input.by,
				placeId: input.placeId,
				placeVersion: summary.placeVersion ?? (fromPath ? Number(fromPath) : null),
				seconds: Math.round((now - started) / 100) / 10,
				ids: ids.length,
				loaded,
				failed,
				skipped,
			};
			this.save();
			this.current = { ...this.current, state: "done", step: "done", finishedAt: this.clock() };
			this.options.log?.(`anims: pass on place ${input.placeId}: ${loaded} loaded, ${failed} failed, ${skipped} skipped of ${ids.length}`);
			input.onDone?.("ok", { placeId: input.placeId, ids: ids.length, loaded, failed, skipped, seconds: index.last.seconds });
		} catch (error) {
			const message = (error instanceof OpenCloudError || error instanceof AnimsError ? error.message : `the animation pass failed: ${(error as Error)?.message ?? error}`).slice(0, 500);
			this.current = { ...this.current, state: "failed", step: "failed", finishedAt: this.clock(), error: message };
			this.options.log?.(`anims: pass failed: ${message}`);
			input.onDone?.("failed", { placeId: input.placeId, error: message.slice(0, 200) });
		}
	}

	stop(): void {
		if (this.saveTimer) this.save();
	}
}

function describeTaskError(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const e = error as Record<string, unknown>;
	const text = [e.code, e.message].filter((v) => typeof v === "string" && v).join(": ");
	return text ? ` (${text.replace(/\s+/g, " ").slice(0, 300)})` : "";
}

function parseSummary(raw: unknown): { placeVersion: number | null } {
	try {
		const s = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const v = Number(s.placeVersion);
		return { placeVersion: Number.isSafeInteger(v) && v > 0 ? v : null };
	} catch {
		return { placeVersion: null };
	}
}

// The module's store (one backend serves one game) -------------------------------------------------------------------------

let current: AnimStore | null = null;
const early = new Set<string>();

/** The server's store (app start), or null. Ids noted before it are handed over. */
export function installAnimStore(store: AnimStore | null): void {
	current = store;
	if (store && early.size) {
		store.note([...early]);
		early.clear();
	}
}

export function animStore(): AnimStore | null {
	return current;
}

/**
 * Remembers animation ids seen in replays (fire and forget, idempotent): asset ids or `rbxassetid://` strings. The next
 * animation pass (after a map export, or POST /v1/anims/export) loads the ones not exported yet.
 */
export function noteAnimationIds(ids: readonly string[]): void {
	if (!Array.isArray(ids) || ids.length === 0) return;
	if (current) {
		current.note(ids);
		return;
	}
	for (const raw of ids.slice(0, 1000)) {
		const id = typeof raw === "string" ? assetIdOf(raw) : null;
		if (id && early.size < SEEN_MAX) early.add(id);
	}
}
