/**
 * Animation clips for the replay (plans/36 "The clips"): GET /api/v1/anims/<animationId> answers
 * `{ id, length, looped, keyframes: [{ t, poses: { [jointName]: [qx, qy, qz, qw] } }], priority? }` once the export task
 * has read the animation, 404 until then (or when the endpoint isn't there). A clip never changes: kept for the page's
 * life; a missing one is asked again after a minute.
 */
import { useEffect, useState } from "react";
import type { AnimClip, Quat } from "@/pages/recordings/ext-replay";

const MAX_KEYFRAMES = 5000;
const RETRY_MS = 60_000;

const clips = new Map<string, { clip: AnimClip | null; at: number }>();
const inflight = new Map<string, Promise<AnimClip | null>>();

const isQuat = (q: unknown): q is Quat => Array.isArray(q) && q.length === 4 && q.every((v) => typeof v === "number" && Number.isFinite(v));

/** A clip from the endpoint's JSON, or null when it isn't one (only well-formed joints and keyframes kept). */
export function parseClip(body: unknown, id: string): AnimClip | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b.keyframes)) return null;
	const keyframes: AnimClip["keyframes"] = [];
	for (const k of b.keyframes.slice(0, MAX_KEYFRAMES) as unknown[]) {
		if (!k || typeof k !== "object") continue;
		const { t, poses } = k as { t?: unknown; poses?: unknown };
		if (typeof t !== "number" || !Number.isFinite(t) || !poses || typeof poses !== "object") continue;
		const kept: Record<string, Quat> = {};
		for (const [name, q] of Object.entries(poses as Record<string, unknown>)) if (isQuat(q)) kept[name] = q;
		keyframes.push({ t, poses: kept });
	}
	keyframes.sort((a, c) => a.t - c.t);
	const length = typeof b.length === "number" && Number.isFinite(b.length) ? b.length : (keyframes.at(-1)?.t ?? 0);
	return { id, length, looped: b.looped === true, keyframes, ...(typeof b.priority === "number" ? { priority: b.priority } : {}) };
}

export function loadClip(id: string, options: { base?: string; fetch?: typeof fetch; now?: () => number } = {}): Promise<AnimClip | null> {
	const now = (options.now ?? Date.now)();
	const known = clips.get(id);
	if (known && (known.clip || now - known.at < RETRY_MS)) return Promise.resolve(known.clip);
	const running = inflight.get(id);
	if (running) return running;
	const job = (async () => {
		let clip: AnimClip | null = null;
		try {
			const response = await (options.fetch ?? fetch)(`${options.base ?? "/api"}/v1/anims/${encodeURIComponent(id)}`, { credentials: "same-origin" });
			if (response.ok) clip = parseClip(await response.json(), id);
		} catch {
			clip = null;
		}
		clips.set(id, { clip, at: now });
		return clip;
	})().finally(() => inflight.delete(id));
	inflight.set(id, job);
	return job;
}

/** The clips for these animation ids (digits), as they arrive: a map of id -> clip (null: none). */
export function useAnimClips(ids: readonly string[]): ReadonlyMap<string, AnimClip | null> {
	const key = [...new Set(ids)].sort().join(",");
	const [map, setMap] = useState<ReadonlyMap<string, AnimClip | null>>(() => new Map());
	useEffect(() => {
		let live = true;
		const list = key ? key.split(",") : [];
		void Promise.all(list.map(async (id) => [id, await loadClip(id)] as const)).then((entries) => {
			if (live) setMap(new Map(entries));
		});
		return () => {
			live = false;
		};
	}, [key]);
	return map;
}

/** Forgets every clip (tests). */
export function clearAnimClips(): void {
	clips.clear();
	inflight.clear();
}
