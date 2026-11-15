/**
 * Plans/25 "Instant wake": a watched server learns it is watched from its next heartbeat reply (`rd: 1`, up to 30 s
 * away). When a watch STARTS for a job that isn't polling, this publishes a tiny unsigned wake through Roblox Open Cloud
 * Messaging instead, so the kernel (0.5.1+) starts its debug poll within a second:
 *
 *   POST https://apis.roblox.com/cloud/v2/universes/<TYPETORCH_UNIVERSE_ID>:publishMessage
 *   x-api-key: <OPENCLOUD_API_KEY>
 *   { "topic": "TypeTorch/deploy", "message": "{\"k\":\"rd\",\"j\":\"<JobId>\"}" }
 *
 * The topic: TypeTorch/deploy, the kernel's control topic. Every kernel holds that subscription for its life and it
 * already carries unsigned control messages told apart by `k` (the settings ping) and `rc` (the peers' ask), so no
 * server subscribes to anything new (Roblox allows 20 + 8 x players subscriptions a server). Kernels before 0.5.1
 * ignore a `k` message they don't know (no branch, not a deploy); the rekey topic was not used because older kernels
 * read ANY message there as a key rotation hint (every server would re-read the key asset).
 *
 * Trust: the wake is a hint, never a command. The woken kernel's first poll asks this backend, which says whether the
 * job is really watched, so a forged wake (anyone who can publish to the universe) costs that server one poll.
 *
 * The key: an Open Cloud API key with ONLY universe-messaging-service:publish for this universe. It goes into the
 * x-api-key header and nowhere else: never logged, never in an error line (scrubbed), never in a response.
 *
 * Limits: one wake per job per WAKE_JOB_GAP_MS (the kernel acts on one per 10 s too) and WAKE_PER_MINUTE in all. Every
 * server receives every wake, and Roblox allows (40 + 80 x servers) messages a minute per topic and (400 + 200 x
 * servers) for the whole game, shared with the in-engine MessagingService: 10 a minute stays well under both. A
 * failure is logged and changes nothing else: the watch stands and the heartbeat reply still wakes the server.
 */
import { publishMessage } from "../opencloud.ts";

/** The kernel's control topic (deploys, the settings ping, the peers' ask): every kernel already subscribes to it. */
export const WAKE_TOPIC = "TypeTorch/deploy";
/** At most one wake per job this often. */
export const WAKE_JOB_GAP_MS = 10_000;
/** Wakes a minute in all (sliding 60 s). */
export const WAKE_PER_MINUTE = 10;
/** The page says "Waking server..." this long after a wake went out; then the heartbeat path's text. */
export const WAKE_SHOWN_MS = 30_000;
/** One publish at most (no retry: a publish that went through twice would deliver twice; the heartbeat is the backup). */
export const WAKE_TIMEOUT_MS = 10_000;

/** Plans/34: at most one live map wake (`{"k":"lm"}`, every server) this often. */
export const LIVE_MAP_WAKE_GAP_MS = 30_000;

/** What `wake` did: published now, one went out for this job lately, the global cap stopped it, or wake is off. */
export type WakeResult = "sent" | "recent" | "limited" | "off";

export interface RemoteDebugWakerOptions {
	/** OPENCLOUD_API_KEY (Open Cloud, universe-messaging-service:publish only). */
	apiKey?: string;
	/** TYPETORCH_UNIVERSE_ID. */
	universeId?: number;
	fetch?: typeof fetch;
	/** The Open Cloud base URL (tests). */
	base?: string;
	clock?: () => number;
	log?: (line: string) => void;
}

/** The wake's message text: `{"k":"rd","j":"<JobId>"}` (JobIds are at most 64 characters: far under 1 KiB). */
export function wakeMessage(job: string): string {
	return JSON.stringify({ k: "rd", j: job });
}

/** Plans/34: the live map wake, `{"k":"lm"}`: every server that hears it posts its positions (kernels before 0.6.0 ignore it). */
export function liveMapWakeMessage(): string {
	return JSON.stringify({ k: "lm" });
}

export class RemoteDebugWaker {
	/** Both the key and the universe are set. */
	readonly enabled: boolean;
	/** published: went through; failed: refused or unreachable; recent: skipped (WAKE_JOB_GAP_MS); limited: the cap. */
	readonly stats = { published: 0, failed: 0, recent: 0, limited: 0 };
	private readonly clock: () => number;
	private readonly jobs = new Map<string, { at: number; failed: boolean }>();
	/** When each wake of the last minute went out. */
	private readonly sentAt: number[] = [];
	private readonly inflight = new Set<Promise<void>>();
	private limitLoggedAt = -Infinity;
	private liveMapAt = -Infinity;

	constructor(private readonly options: RemoteDebugWakerOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.enabled = Boolean(options.apiKey) && Boolean(options.universeId);
	}

	/** The startup line (names only, never a value). */
	describe(): string {
		if (this.enabled) return `remote debug wake is on (Open Cloud Messaging, universe ${this.options.universeId}, topic ${WAKE_TOPIC}): a watched server starts polling within seconds`;
		const missing = [!this.options.apiKey ? "OPENCLOUD_API_KEY" : "", !this.options.universeId ? "TYPETORCH_UNIVERSE_ID" : ""].filter(Boolean).join(" and ");
		return `remote debug wake is off (${missing} not set): a watched server starts polling at its next heartbeat, up to 30 s`;
	}

	/**
	 * Wakes `job` (fire and forget: the publish runs in the background; its failure is logged, never thrown). Call it
	 * when a watch starts on a job that isn't polling.
	 */
	wake(job: string): WakeResult {
		if (!this.enabled) return "off";
		const now = this.clock();
		this.prune(now);
		const last = this.jobs.get(job);
		if (last && now - last.at < WAKE_JOB_GAP_MS) {
			this.stats.recent++;
			return "recent";
		}
		if (this.capped(now)) return "limited";
		this.sentAt.push(now);
		const entry = { at: now, failed: false };
		this.jobs.set(job, entry);
		this.start(wakeMessage(job), `for ${job}`, entry);
		return "sent";
	}

	/**
	 * Plans/34: the /live page's watch started: one `{"k":"lm"}` wake to every server, at most one per
	 * LIVE_MAP_WAKE_GAP_MS, inside the same WAKE_PER_MINUTE cap. Fire and forget like `wake`.
	 */
	wakeLiveMap(): WakeResult {
		if (!this.enabled) return "off";
		const now = this.clock();
		this.prune(now);
		if (now - this.liveMapAt < LIVE_MAP_WAKE_GAP_MS) {
			this.stats.recent++;
			return "recent";
		}
		if (this.capped(now)) return "limited";
		this.sentAt.push(now);
		this.liveMapAt = now;
		this.start(liveMapWakeMessage(), "for the live map", { failed: false });
		return "sent";
	}

	/** The WAKE_PER_MINUTE cap is reached (counted and logged once a minute). */
	private capped(now: number): boolean {
		if (this.sentAt.length < WAKE_PER_MINUTE) return false;
		this.stats.limited++;
		if (now - this.limitLoggedAt >= 60_000) {
			this.limitLoggedAt = now;
			this.options.log?.(`remote debug wake: ${WAKE_PER_MINUTE} wakes went out in the last minute; the next watched servers start polling at their heartbeat`);
		}
		return true;
	}

	private start(message: string, what: string, entry: { failed: boolean }): void {
		const running: Promise<void> = this.publish(message, what, entry).finally(() => this.inflight.delete(running));
		this.inflight.add(running);
	}

	/** A wake went out for `job` lately and didn't fail: the server should be polling in a moment. */
	waking(job: string): boolean {
		const entry = this.jobs.get(job);
		return entry !== undefined && !entry.failed && this.clock() - entry.at < WAKE_SHOWN_MS;
	}

	/** Waits for the publishes running now (tests, and a clean stop). */
	async idle(): Promise<void> {
		while (this.inflight.size) await Promise.allSettled([...this.inflight]);
	}

	private async publish(message: string, what: string, entry: { failed: boolean }): Promise<void> {
		const apiKey = this.options.apiKey as string;
		try {
			await publishMessage({
				apiKey,
				universeId: this.options.universeId as number,
				topic: WAKE_TOPIC,
				message,
				timeoutMs: WAKE_TIMEOUT_MS,
				...(this.options.fetch ? { fetch: this.options.fetch } : {}),
				...(this.options.base ? { base: this.options.base } : {}),
			});
			this.stats.published++;
		} catch (error) {
			entry.failed = true;
			this.stats.failed++;
			// The error text never holds the key (opencloud.ts), scrubbed anyway.
			const text = String((error as Error)?.message ?? error)
				.split(apiKey)
				.join("<redacted>")
				.replace(/[\u0000-\u001f\u007f]/g, " ")
				.slice(0, 300);
			this.options.log?.(`remote debug wake ${what} failed (the server starts polling at its next heartbeat): ${text}`);
		}
	}

	private prune(now: number): void {
		while (this.sentAt.length && now - this.sentAt[0] >= 60_000) this.sentAt.shift();
		for (const [job, entry] of this.jobs) if (now - entry.at >= Math.max(WAKE_JOB_GAP_MS, WAKE_SHOWN_MS)) this.jobs.delete(job);
	}
}
