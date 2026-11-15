/**
 * Roblox image assets for the replay (plans/36 phase 5): GET /api/v1/images/<assetId> answers the PNG (200), 202 while
 * the backend is still fetching it from Roblox's thumbnails API (retried a few times), 404 for an unknown or refused
 * image. Fetched (not an <img src>) so all three answers are told apart; a ready image becomes an object URL, cached for
 * the page's life (an asset id's pixels never change). Content that is not an asset id (`rbxasset://`, `rbxthumb://`,
 * empty) has no image: the caller draws a placeholder.
 */
import { useEffect, useState } from "react";

export type AssetImage = { state: "loading" } | { state: "pending" } | { state: "missing" } | { state: "ready"; url: string };

/** The numeric asset id in an Image / template / texture string (`rbxassetid://1`, `http://www.roblox.com/asset/?id=1`, `1`), else null. */
export function assetIdOf(content: string | null | undefined): string | null {
	if (!content) return null;
	const text = content.trim();
	if (/^\d{1,20}$/.test(text)) return text;
	let m = /^rbxassetid:\/\/(\d{1,20})\s*$/i.exec(text);
	if (m) return m[1] as string;
	m = /^https?:\/\/(?:www\.)?roblox\.com\/asset\/?\?(?:.*&)?id=(\d{1,20})(?:&.*)?$/i.exec(text);
	if (m) return m[1] as string;
	return null;
}

/** Retries of a 202 answer and the wait between them. */
export const PENDING_RETRIES = 6;
export const PENDING_WAIT_MS = 5000;

const cache = new Map<string, AssetImage>();
const inflight = new Map<string, Promise<AssetImage>>();
const listeners = new Map<string, Set<(image: AssetImage) => void>>();

function settle(id: string, image: AssetImage): AssetImage {
	cache.set(id, image);
	for (const fn of listeners.get(id) ?? []) fn(image);
	return image;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loads one asset image (shared by every caller; a 202 is retried, then stays "pending" until the page reloads). */
export function loadAssetImage(id: string, options: { base?: string; fetch?: typeof fetch; wait?: (ms: number) => Promise<unknown> } = {}): Promise<AssetImage> {
	const known = cache.get(id);
	if (known && known.state !== "loading") return Promise.resolve(known);
	const running = inflight.get(id);
	if (running) return running;
	const doFetch = options.fetch ?? fetch;
	const pause = options.wait ?? wait;
	cache.set(id, { state: "loading" });
	const job = (async (): Promise<AssetImage> => {
		for (let attempt = 0; attempt <= PENDING_RETRIES; attempt++) {
			let response: Response;
			try {
				response = await doFetch(`${options.base ?? "/api"}/v1/images/${encodeURIComponent(id)}`, { credentials: "same-origin" });
			} catch {
				return settle(id, { state: "missing" });
			}
			if (response.status === 202) {
				if (attempt === PENDING_RETRIES) return settle(id, { state: "pending" });
				settle(id, { state: "pending" });
				await pause(PENDING_WAIT_MS);
				continue;
			}
			if (!response.ok) return settle(id, { state: "missing" });
			const blob = await response.blob();
			if (!blob.type.startsWith("image/") && blob.type !== "") return settle(id, { state: "missing" });
			return settle(id, { state: "ready", url: URL.createObjectURL(blob) });
		}
		return settle(id, { state: "pending" });
	})().finally(() => inflight.delete(id));
	inflight.set(id, job);
	return job;
}

/** The image for an Image / template string: null when it is no asset id (draw a placeholder), else its state. */
export function useAssetImage(content: string | null | undefined): AssetImage | null {
	const id = assetIdOf(content);
	const [image, setImage] = useState<AssetImage | null>(() => (id ? (cache.get(id) ?? { state: "loading" }) : null));
	useEffect(() => {
		if (!id) {
			setImage(null);
			return;
		}
		setImage(cache.get(id) ?? { state: "loading" });
		let set = listeners.get(id);
		if (!set) listeners.set(id, (set = new Set()));
		const fn = (next: AssetImage) => setImage(next);
		set.add(fn);
		void loadAssetImage(id).then(fn);
		return () => {
			set?.delete(fn);
		};
	}, [id]);
	return image;
}

/** Forgets every cached image (tests). */
export function clearAssetImages(): void {
	for (const image of cache.values()) if (image.state === "ready") URL.revokeObjectURL?.(image.url);
	cache.clear();
	inflight.clear();
	listeners.clear();
}
