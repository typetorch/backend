/**
 * Plans/35 D: backpressure. POST /v1/ingest answers `503 { error: "busy: ...", busy: true }` with `Retry-After: 10-30`
 * (jittered) **before reading the body** while the backend is behind: raw/incoming holds more than `busyBytes`, or more
 * than `busyRequests` ingest requests are in flight. Game servers keep a 503'd batch and back off, so a surge spreads out
 * in their queues instead of every request timing out at once. Both limits are runtime settings (0 = off). Only ingest
 * is refused this way: heartbeats, error logs and identities never are.
 */
export const BUSY_RETRY_MIN_SECONDS = 10;
export const BUSY_RETRY_MAX_SECONDS = 30;
/** How long a measured raw backlog is reused (a directory listing per request would cost more than the check saves). */
const BACKLOG_CACHE_MS = 1000;

export interface BusyOptions {
	maxBytes: () => number;
	maxRequests: () => number;
	/** Bytes waiting in raw/incoming; undefined while analytics isn't open. */
	pendingBytes: () => number | undefined;
	clock?: () => number;
	random?: () => number;
}

export interface BusyView {
	/** Busy refusals since the start. */
	busy: number;
	/** Ingest requests being handled now. */
	inflight: number;
	/** When the last busy refusal was (unix ms), or null. */
	lastBusyAt: number | null;
}

export class IngestBusy {
	private inflight = 0;
	private refused = 0;
	private lastBusyAt: number | null = null;
	private backlog: { bytes: number; at: number } | undefined;
	private readonly clock: () => number;
	private readonly random: () => number;

	constructor(private readonly o: BusyOptions) {
		this.clock = o.clock ?? Date.now;
		this.random = o.random ?? Math.random;
	}

	/** The refusal (why, and the Retry-After seconds), or undefined when the request may go on. Counted when refused. */
	check(): { why: string; retryAfter: number } | undefined {
		const maxRequests = this.o.maxRequests();
		let why: string | undefined;
		if (maxRequests > 0 && this.inflight >= maxRequests) why = `${this.inflight} ingest requests in flight (limit ${maxRequests})`;
		const maxBytes = this.o.maxBytes();
		if (!why && maxBytes > 0) {
			const bytes = this.backlogBytes();
			if (bytes !== undefined && bytes > maxBytes) why = `the loader is behind (${Math.round(bytes / 1024 / 1024)} MB waiting, limit ${Math.round(maxBytes / 1024 / 1024)} MB)`;
		}
		if (!why) return undefined;
		this.refused++;
		this.lastBusyAt = this.clock();
		const span = BUSY_RETRY_MAX_SECONDS - BUSY_RETRY_MIN_SECONDS;
		return { why, retryAfter: BUSY_RETRY_MIN_SECONDS + Math.min(span, Math.floor(this.random() * (span + 1))) };
	}

	private backlogBytes(): number | undefined {
		const now = performance.now();
		if (this.backlog && now - this.backlog.at < BACKLOG_CACHE_MS) return this.backlog.bytes;
		const bytes = this.o.pendingBytes();
		if (bytes === undefined) return undefined;
		this.backlog = { bytes, at: now };
		return bytes;
	}

	/** Counts one ingest request in flight; call the answer when it is done. */
	enter(): () => void {
		this.inflight++;
		let left = false;
		return () => {
			if (left) return;
			left = true;
			this.inflight--;
		};
	}

	view(): BusyView {
		return { busy: this.refused, inflight: this.inflight, lastBusyAt: this.lastBusyAt };
	}
}
