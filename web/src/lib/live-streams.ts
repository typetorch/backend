/**
 * Plans/34 hooks: the server page's stream poll (GET /v1/fleet/servers/<job>/streams about every second while the page
 * is open and visible; the page's own remote-debug watch makes the kernel post them), the /live page's fleet-wide watch
 * (POST /v1/fleet/live-map/watch every 20 s) and its poll (GET /v1/fleet/live-map every ~3 s), and a ticker for the
 * interpolated dots.
 *
 * Frames hold player names and positions: they live in this component state only (never the query cache, localStorage
 * or the URL) and go with the page.
 */
import { useEffect, useState } from "react";
import { api as defaultApi, type Api } from "./api";
import { mergeFrames } from "./live-map";
import type { LiveMapServer, ServerStreams, StreamFrame } from "./types";

export const STREAMS_POLL_MS = 1_000;
export const LIVE_MAP_POLL_MS = 3_000;
export const LIVE_MAP_WATCH_EVERY_MS = 20_000;
/** The interpolation's redraw rate (10 a second: smooth enough, cheap for the renderer). */
export const TICK_MS = 100;

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
const hidden = () => typeof document !== "undefined" && document.hidden;

export interface StreamsState {
	declared?: ServerStreams["declared"];
	frames: StreamFrame[];
	/** When the newest frame arrived (this page's clock, ms). */
	arrivedAt: number;
	error?: string;
	/** At least one answer came. */
	loaded: boolean;
}

/** Polls one server's streams while `enabled` (a live server, an owner's session). */
export function useServerStreams(job: string, enabled: boolean, client: Pick<Api, "serverStreams"> = defaultApi, every = STREAMS_POLL_MS): StreamsState {
	const [state, setState] = useState<StreamsState>({ frames: [], arrivedAt: 0, loaded: false });
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		let since: number | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const tick = async () => {
			if (!hidden()) {
				try {
					const answer = await client.serverStreams(job, since, controller.signal);
					if (stopped) return;
					const last = answer.frames[answer.frames.length - 1];
					if (last) since = Math.max(since ?? 0, last.t);
					setState((s) => {
						const frames = answer.frames.length ? mergeFrames(s.frames, answer.frames) : s.frames;
						const grew = frames[frames.length - 1]?.t !== s.frames[s.frames.length - 1]?.t;
						return { declared: answer.declared, frames, arrivedAt: grew ? Date.now() : s.arrivedAt, loaded: true };
					});
				} catch (error) {
					if (stopped || isAbort(error)) return;
					setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error), loaded: true }));
				}
			}
			if (!stopped) timer = setTimeout(tick, every);
		};
		void tick();
		return () => {
			stopped = true;
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [job, enabled, client, every]);
	return state;
}

/** Date.now(), refreshed every `ms` while `on` (the dots' interpolation). */
export function useTicker(on: boolean, ms = TICK_MS): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [on, ms]);
	return now;
}

/** One server on /live: its two latest frames (to move between) and when the newest arrived. */
export interface LiveServer extends Omit<LiveMapServer, "players" | "at"> {
	frames: StreamFrame[];
	arrivedAt: number;
}

export interface LiveMapState {
	servers: LiveServer[];
	error?: string;
	loaded: boolean;
	/** The watch was refused (the read-only role: owners only). */
	watchError?: string;
}

/** Holds the fleet-wide live map watch and polls every server's latest positions while `enabled`. */
export function useLiveMap(enabled: boolean, client: Pick<Api, "watchLiveMap" | "liveMap"> = defaultApi, every = LIVE_MAP_POLL_MS): LiveMapState {
	const [state, setState] = useState<LiveMapState>({ servers: [], loaded: false });
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		const watch = () => {
			if (hidden()) return;
			client.watchLiveMap(controller.signal).then(
				() => setState((s) => (s.watchError ? { ...s, watchError: undefined } : s)),
				(e: unknown) => {
					if (!isAbort(e)) setState((s) => ({ ...s, watchError: e instanceof Error ? e.message : String(e) }));
				},
			);
		};
		watch();
		const watchTimer = setInterval(watch, LIVE_MAP_WATCH_EVERY_MS);
		const onVisible = () => {
			if (!hidden()) watch();
		};
		document.addEventListener("visibilitychange", onVisible);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const tick = async () => {
			if (!hidden()) {
				try {
					const answer = await client.liveMap(controller.signal);
					if (stopped) return;
					setState((s) => {
						const held = new Map(s.servers.map((x) => [x.job, x]));
						const servers = answer.servers.map((x): LiveServer => {
							const before = held.get(x.job);
							const frame: StreamFrame = { t: x.at, s: { positions: { players: x.players } } };
							const last = before?.frames[before.frames.length - 1];
							if (before && last && last.t === x.at) return { ...before, branch: x.branch, artifact: x.artifact };
							return { job: x.job, branch: x.branch, artifact: x.artifact, frames: [...(last ? [last] : []), frame], arrivedAt: Date.now() };
						});
						return { ...s, servers, loaded: true, error: undefined };
					});
				} catch (error) {
					if (stopped || isAbort(error)) return;
					setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error), loaded: true }));
				}
			}
			if (!stopped) timer = setTimeout(tick, every);
		};
		void tick();
		return () => {
			stopped = true;
			controller.abort();
			clearInterval(watchTimer);
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [enabled, client, every]);
	return state;
}
