/**
 * The sender (plans/29 "Sender"): due sends are leased from the durable queue (`notify:due`), each goes to Roblox's
 * Open Cloud send API behind one token bucket, and its outcome lands in notify_sends, the user's state and the rows.
 *
 *   POST https://apis.roblox.com/cloud/v2/users/{userId}/notifications   x-api-key: OPENCLOUD_NOTIFY_KEY ?? OPENCLOUD_API_KEY
 *   { source: { universe: "universes/<id>" },
 *     payload: { message_id, type: "MOMENT", parameters, join_experience: { launch_data }, analytics_data: { category } } }  ->  { path, id }
 *
 * Dry run (`notify.dryRun`, on by default, and any kind without a template): everything but the POST. The send ends
 * with status `dry` and a `sent` row with `dry: true`; it counts toward the day / week caps like a real one (the dry run
 * is a rehearsal of the schedule), but not toward once_ever / per_key, so the real send still happens once it's off.
 *
 * Retries (network, 5xx, 429): 30 s, 2 min, 8 min, then failed. A 429 also halves the bucket's rate and honours
 * Retry-After; the rate climbs back 10 % a minute. Keys and tokens are never logged.
 */
import { signToken, type NotifyKeys } from "./token.ts";
import type { Durable } from "../store/durable.ts";
import { DUE_SET, isOnline, type NotifyStore, type OutRow, type SendRow } from "./store.ts";
import { DAY_MS, type DayClock } from "./planner.ts";

export const SEND_URL = (userId: number) => `https://apis.roblox.com/cloud/v2/users/${userId}/notifications`;
/**
 * S2: Roblox allows 4000 requests per 1 s window per key and says so on every answer (x-ratelimit-limit / -remaining /
 * -reset); the bucket follows those headers. `notify.rate` (default 50 / s) is only our own lower ceiling.
 */
export const DEFAULT_RATE = 50;
export const RETRY_DELAYS_MS = [30_000, 120_000, 480_000] as const;
/** First try + the retries. */
export const MAX_TRIES = RETRY_DELAYS_MS.length + 1;
/** A leased send must finish (or be put back) within this; a crash returns it after it. */
export const LEASE_MS = 120_000;
export const WORKERS = 4;
export const SEND_TIMEOUT_MS = 30_000;
/** S1: a user who isn't opted in is left alone this long. */
export const MUTE_MS = 7 * DAY_MS;
/** Failed for good (a fatal answer): the user is looked at again after this. */
export const FATAL_RECHECK_MS = 3_600_000;

/**
 * S3: Roblox's per-recipient limit answers at send time with 429 RESOURCE_EXHAUSTED and a per-recipient message
 * (`daily_limit`: no retry, no backoff, re-planned for the user's next day); any other 429 is `rate_limited`.
 * Our `dailyCap` (planner) stays the first guard.
 */
export type Outcome = "ok" | "not_subscribed" | "bad_template" | "daily_limit" | "rate_limited" | "retry" | "fatal";

// TODO(S3): the exact per-recipient message is to be confirmed on a non-owner account (the owner skips the throttle).
export const DAILY_LIMIT_MESSAGE = /per recipient|recipient.*(limit|throttl)|notifications? per (user|day)/i;

/** Roblox's answer -> what to do. `http` 0 = no answer (network error, timeout). */
/** Roblox's refusal as the explorer shows it: its message, plus the details when there are any (up to 1000 chars). */
export function refusalText(body: unknown): string | null {
	const b = (typeof body === "object" && body !== null ? body : {}) as { message?: unknown; details?: unknown };
	const parts = [typeof b.message === "string" ? b.message : "", b.details !== undefined ? JSON.stringify(b.details) : ""].filter(Boolean);
	return parts.length ? parts.join(" ").slice(0, 1000) : null;
}

/** The request body a send posts (sendBody) without the signed launch data, which only the send itself makes. */
export function requestBody(send: Pick<SendRow, "template" | "params" | "category" | "kind">, universeId: string | number, launchData?: string) {
	const parameters: Record<string, { string_value: string }> = {};
	if (send.params) {
		try {
			for (const [k, v] of Object.entries(JSON.parse(send.params) as Record<string, unknown>)) if (typeof v === "string") parameters[k] = { string_value: v };
		} catch {}
	}
	return {
		source: { universe: `universes/${universeId}` },
		payload: {
			message_id: send.template,
			type: "MOMENT",
			...(Object.keys(parameters).length ? { parameters } : {}),
			...(launchData ? { join_experience: { launch_data: launchData } } : {}),
			analytics_data: { category: send.category ?? send.kind },
		},
	};
}

export function classify(http: number, body: unknown): Outcome {
	const b = (typeof body === "object" && body !== null ? body : {}) as { code?: unknown; message?: unknown };
	const code = typeof b.code === "string" ? b.code : "";
	const message = typeof b.message === "string" ? b.message : "";
	if (http >= 200 && http < 300) return "ok";
	if (http === 0 || http === 408 || http >= 500) return "retry";
	// S1: not opted in (checked by Roblox before the template).
	if (http === 400 && code === "FAILED_PRECONDITION" && /not opted in/i.test(message)) return "not_subscribed";
	// S1b: an opted-in user and a message id that doesn't exist: the kind's config is wrong.
	if (http === 404 && code === "NOT_FOUND" && /message id/i.test(message)) return "bad_template";
	if (http === 429) return code === "RESOURCE_EXHAUSTED" && DAILY_LIMIT_MESSAGE.test(message) ? "daily_limit" : "rate_limited";
	return "fatal";
}

/** Retry-After: seconds, or an HTTP date. Returns ms (0 when absent or odd), at most an hour. */
export function retryAfterMs(header: string | null, now: number): number {
	if (!header) return 0;
	const s = header.trim();
	if (/^\d{1,6}$/.test(s)) return Math.min(3_600_000, Number(s) * 1000);
	const t = Date.parse(s);
	return Number.isFinite(t) ? Math.min(3_600_000, Math.max(0, t - now)) : 0;
}

/** What Roblox's x-ratelimit-* headers say: requests per window, left in this window, seconds until it resets. */
export interface RateHeaders {
	limit?: number;
	windowMs?: number;
	remaining?: number;
	resetMs?: number;
}

/**
 * S2: `x-ratelimit-limit: 4000, 4000;w=1, 4000;w=1` (the first number, its window from the first `w=`, default 1 s),
 * `x-ratelimit-remaining: n`, `x-ratelimit-reset: seconds`. Missing or odd values are left out.
 */
export function parseRateHeaders(get: (name: string) => string | null): RateHeaders {
	const out: RateHeaders = {};
	const limit = get("x-ratelimit-limit");
	if (limit) {
		const first = /^\s*(\d{1,9})/.exec(limit);
		if (first) out.limit = Number(first[1]);
		const w = /;\s*w=(\d{1,6})/.exec(limit);
		out.windowMs = (w ? Math.max(1, Number(w[1])) : 1) * 1000;
	}
	const remaining = get("x-ratelimit-remaining");
	if (remaining && /^\s*\d{1,9}\s*$/.test(remaining)) out.remaining = Number(remaining);
	const reset = get("x-ratelimit-reset");
	if (reset && /^\s*\d{1,6}(\.\d+)?\s*$/.test(reset)) out.resetMs = Math.min(3_600_000, Math.round(Number(reset) * 1000));
	return out;
}

/**
 * The token bucket. Its rate is the lowest of: our ceiling (`notify.rate`), Roblox's (x-ratelimit-limit / its window,
 * once an answer said it), and the 429 fallback (halved on each 429, +10 % a minute back). Capacity: one second's worth.
 * On top, Roblox's window: never more requests in it than the last x-ratelimit-remaining said; at 0, wait for the reset.
 * A 429 blocks until its Retry-After.
 */
export class TokenBucket {
	rate: number;
	tokens: number;
	last429At: number | null = null;
	/** Roblox's own limit per second, from the headers (undefined until an answer carried them). */
	robloxRate: number | undefined;
	private blockedUntil = 0;
	private refilledAt: number;
	private recoveredAt: number;
	/** The 429 fallback's rate (Infinity = no 429 lately). */
	private backoffRate = Number.POSITIVE_INFINITY;
	private window: { remaining: number; endsAt: number } | undefined;

	constructor(
		private readonly target: () => number,
		private readonly clock: () => number,
	) {
		this.rate = Math.max(0.1, target());
		this.tokens = Math.max(1, this.rate);
		this.refilledAt = clock();
		this.recoveredAt = clock();
	}

	private ceiling(): number {
		return Math.max(0.1, Math.min(this.target(), this.robloxRate ?? Number.POSITIVE_INFINITY));
	}

	private refresh(now: number): void {
		const ceiling = this.ceiling();
		// +10 % per whole minute since the last 429 or step, until the fallback no longer limits.
		while (Number.isFinite(this.backoffRate) && now - this.recoveredAt >= 60_000) {
			this.recoveredAt += 60_000;
			this.backoffRate *= 1.1;
			if (this.backoffRate >= ceiling) this.backoffRate = Number.POSITIVE_INFINITY;
		}
		this.rate = Math.min(ceiling, this.backoffRate);
		const cap = Math.max(1, this.rate);
		this.tokens = Math.min(cap, this.tokens + ((now - this.refilledAt) / 1000) * this.rate);
		this.refilledAt = now;
		if (this.window && now >= this.window.endsAt) this.window = undefined;
	}

	/** Takes a token now (0), or says how long to wait (ms) before asking again. */
	take(): number {
		const now = this.clock();
		this.refresh(now);
		if (now < this.blockedUntil) return this.blockedUntil - now;
		if (this.window && this.window.remaining <= 0) return Math.max(1, this.window.endsAt - now);
		if (this.tokens >= 1) {
			this.tokens -= 1;
			if (this.window) this.window.remaining--;
			return 0;
		}
		return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
	}

	/** An answer's x-ratelimit-* headers. */
	onHeaders(h: RateHeaders): void {
		const now = this.clock();
		if (h.limit !== undefined && h.limit > 0) this.robloxRate = h.limit / ((h.windowMs ?? 1000) / 1000);
		if (h.remaining !== undefined) this.window = { remaining: h.remaining, endsAt: now + (h.resetMs ?? h.windowMs ?? 1000) };
		this.refresh(now);
	}

	on429(retryAfter: number): void {
		const now = this.clock();
		this.refresh(now);
		this.backoffRate = Math.max(0.1, this.rate / 2);
		this.rate = this.backoffRate;
		this.tokens = 0;
		this.last429At = now;
		this.recoveredAt = now;
		this.blockedUntil = Math.max(this.blockedUntil, now + retryAfter);
	}

	view(): { rate: number; tokens: number; last429At: number | null; blockedUntil: number | null; robloxRate: number | null; windowRemaining: number | null } {
		this.refresh(this.clock());
		return {
			rate: Math.round(this.rate * 100) / 100,
			tokens: Math.round(this.tokens * 100) / 100,
			last429At: this.last429At,
			blockedUntil: this.blockedUntil > this.clock() ? this.blockedUntil : null,
			robloxRate: this.robloxRate ?? null,
			windowRemaining: this.window?.remaining ?? null,
		};
	}

	/** The state worth keeping across a deploy (kv). */
	snapshot(): { backoffRate: number | null; last429At: number | null; blockedUntil: number; robloxRate: number | null } {
		return { backoffRate: Number.isFinite(this.backoffRate) ? this.backoffRate : null, last429At: this.last429At, blockedUntil: this.blockedUntil, robloxRate: this.robloxRate ?? null };
	}

	restore(s: { backoffRate?: unknown; last429At?: unknown; blockedUntil?: unknown; robloxRate?: unknown }): void {
		if (typeof s.backoffRate === "number" && s.backoffRate > 0) this.backoffRate = s.backoffRate;
		if (typeof s.robloxRate === "number" && s.robloxRate > 0) this.robloxRate = s.robloxRate;
		if (typeof s.last429At === "number") this.last429At = s.last429At;
		if (typeof s.blockedUntil === "number") this.blockedUntil = s.blockedUntil;
		this.recoveredAt = this.last429At ?? this.clock();
		this.refresh(this.clock());
	}
}

export interface SenderOptions {
	store: NotifyStore;
	durable: Durable;
	clock: () => number;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	enabled(): boolean;
	dryRun(): boolean;
	rate(): number;
	dayClock(): DayClock;
	kindOn(kind: string): boolean;
	/** S1b: a kind's template doesn't exist on Roblox: stop the kind (app.ts sets the switch, audits, alerts). */
	halt(kind: string, why: "bad_template"): void;
	/** S1b for a game-supplied template (allowTemplate): only that template stops. */
	haltTemplate(template: string): void;
	/** 401 / 403: the API key is wrong or lacks the scope: every send stops until an owner turns notifications back on. */
	haltAll(why: "auth"): void;
	/** Every send stopped (the auth halt). */
	allHalted(): boolean;
	/** `notify.presenceStaleHours` in ms. */
	presenceStaleMs(): number;
	keys(): NotifyKeys | undefined;
	apiKey(): string | undefined;
	universeId(): number | undefined;
	log?: (line: string) => void;
	workers?: number;
}

const BUCKET_KEY = "notify:bucket";

export class Sender {
	readonly bucket: TokenBucket;
	private running: Promise<number> | undefined;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly log: (line: string) => void;
	private restored = false;
	/** A send's POST in flight (the stop waits for them; their leases cover a kill). */
	private inflight = 0;

	constructor(private readonly o: SenderOptions) {
		this.bucket = new TokenBucket(() => o.rate(), o.clock);
		this.sleep = o.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
		this.log = o.log ?? (() => {});
	}

	/** Real sends are possible: an API key and the universe. Without them only dry runs go. */
	configured(): { apiKey: boolean; universe: boolean } {
		return { apiKey: Boolean(this.o.apiKey()), universe: Boolean(this.o.universeId()) };
	}

	get busy(): number {
		return this.inflight;
	}

	/** One pass (never two at once): lease the due sends and work them off with N workers. Returns sends handled. */
	tick(): Promise<number> {
		this.running ??= this.pass().finally(() => (this.running = undefined));
		return this.running;
	}

	private async pass(): Promise<number> {
		if (!this.restored) {
			this.restored = true;
			const saved = await this.o.durable.getJson<Record<string, unknown>>(BUCKET_KEY);
			if (saved) this.bucket.restore(saved);
		}
		if (!this.o.enabled() || this.o.allHalted()) return 0;
		const now = this.o.clock();
		// No more than about a minute's worth at the current rate, so leases never run out while waiting for tokens.
		const limit = Math.max(1, Math.min(500, Math.floor(this.bucket.rate * 60)));
		const leased = await this.o.durable.lease(DUE_SET, now, LEASE_MS, limit);
		if (!leased.length) return 0;
		let next = 0;
		const work = async () => {
			while (next < leased.length) {
				const item = leased[next++] as { member: string };
				try {
					await this.one(item.member);
				} catch (error) {
					this.log(`notify: send ${item.member} failed: ${((error as Error).message ?? String(error)).slice(0, 200)}`);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(this.o.workers ?? WORKERS, leased.length) }, work));
		return leased.length;
	}

	private async cancel(send: SendRow, why: string | null, user: { next_check?: number } = {}): Promise<void> {
		const rows: OutRow[] = why ? [{ uid: Number(send.user_id), name: "skipped", props: { k: send.kind, why } }] : [];
		await this.o.store.finish(send.nid, { status: "cancelled", user, rows });
	}

	private async one(nid: string): Promise<void> {
		const { store } = this.o;
		const send = await store.send(nid);
		if (!send || (send.status !== "planned" && send.status !== "sending")) {
			await this.o.durable.zrem(DUE_SET, nid);
			return;
		}
		const now = this.o.clock();
		const userId = Number(send.user_id);
		const test = Boolean(Number(send.test));
		// Look again at send time: the reason may be gone, the player may be in game, the kind switched off.
		if (!test && send.kind !== "custom") {
			const intent = await store.intent(userId, send.kind, send.key);
			if (!intent || intent.status !== "pending" || intent.nid !== nid) return this.cancel(send, intent && intent.status === "dropped" ? "dropped" : null);
			if (Number(intent.until) <= now) return this.cancel(send, "expired");
			if (!this.o.kindOn(send.kind)) return this.cancel(send, null, { next_check: now + 600_000 });
			// The player switched the kind off since it was planned: the intent stays pending (back on = it resumes).
			if ((await store.prefsOff(userId)).includes(send.kind)) return this.cancel(send, "pref_off");
		}
		if (!test) {
			const user = await store.user(userId);
			if (user && isOnline(user, now, this.o.presenceStaleMs())) return this.cancel(send, "online", { next_check: Number(user.presence_at) + this.o.presenceStaleMs() });
			if (user?.mute_until && Number(user.mute_until) > now) return this.cancel(send, "muted", { next_check: Number(user.mute_until) });
		}
		const dry = this.o.dryRun() || !send.template;
		if (!dry && !(this.o.apiKey() && this.o.universeId())) {
			// Not set up for real sends: back in the queue in a minute (the status page says why).
			await store.retryAt(nid, now + 60_000);
			return;
		}
		const attempt = Number(send.try) + 1;
		const category = send.category ?? send.kind;
		const row = (name: string, props: Record<string, unknown>): OutRow => ({ uid: userId, name, props });
		if (dry) {
			// A rehearsal: the intent stays pending (the real send goes out once dry run is off); the dry row counts for the caps.
			await store.finish(nid, { status: "dry", sentAt: now, rows: [row("sent", { nid, k: send.kind, try: attempt, category, dry: true, ...(test ? { test: true } : {}) })] });
			return;
		}
		// The token bucket (a wait ends early only when the stop runs out the lease, which returns the send).
		for (;;) {
			if (this.o.allHalted()) return store.retryAt(nid, this.o.clock() + 60_000);
			const wait = this.bucket.take();
			if (wait <= 0) break;
			await this.sleep(Math.min(wait, 5000));
		}
		await store.sending(nid, attempt);
		const { http, body, retryAfter } = await this.post(send);
		const outcome = classify(http, body);
		const at = this.o.clock();
		const user = await store.user(userId);
		const subscribed = user?.optin === "subscribed";
		const inferred = subscribed ? [] : [row("optin_inferred", { state: "subscribed" })];
		const code = typeof (body as { code?: unknown })?.code === "string" ? String((body as { code: string }).code).slice(0, 64) : http ? String(http) : "network";
		const failed = (c: string, final: boolean) => row("failed", { nid, k: send.kind, http, code: c, final });
		const error = refusalText(body);
		switch (outcome) {
			case "ok": {
				// Roblox's id only: its `path` names the user (users/<UserId>/...), never stored or sent to the events.
				const id = (body as { id?: unknown }) ?? {};
				const robloxId = typeof id.id === "string" ? id.id.slice(0, 128) : "";
				const cfg = await store.config();
				await store.finish(nid, {
					status: "sent",
					http,
					robloxId,
					sentAt: at,
					intent: test ? undefined : "sent",
					user: { sent_at: at, ...(subscribed ? {} : { optin: "subscribed", optin_at: at }) },
					unopenedInc: true,
					...(cfg ? { backoffAfter: cfg.config.unopenedBackoff.after } : {}),
					rows: [...inferred, row("sent", { nid, k: send.kind, try: attempt, roblox_id: robloxId, category, ...(test ? { test: true } : {}) })],
				});
				break;
			}
			case "not_subscribed":
				await store.finish(nid, {
					status: "failed", error,
					http,
					code: "not_subscribed",
					user: { mute_until: at + MUTE_MS, optin: "not_subscribed", optin_at: at, next_check: at + MUTE_MS },
					rows: [row("optin_inferred", { state: "not_subscribed" }), failed("not_subscribed", true)],
				});
				break;
			case "bad_template": {
				// The config is wrong, not the user: stop the kind (or only a game-supplied template), keep the intent pending.
				await store.finish(nid, { status: "failed", error, http, code: "bad_template", user: subscribed ? {} : { optin: "subscribed", optin_at: at }, rows: [...inferred, failed("bad_template", true)] });
				const kind = (await store.config())?.config.kinds[send.kind];
				if (send.kind === "custom") this.log("notify: a one-off send's template (message id) does not exist on Roblox");
				else if (kind?.allowTemplate && send.template && send.template !== kind.template) this.o.haltTemplate(send.template);
				else this.o.halt(send.kind, "bad_template");
				break;
			}
			case "daily_limit": {
				// A retry after a send that may have left (a crash or a timeout mid-POST): Roblox refusing it means the first
				// one most likely went out. Counted as delivered (caps, repeat), code dup_refused.
				if (attempt > 1) {
					await store.finish(nid, { status: "sent", http, code: "dup_refused", sentAt: at, intent: test ? undefined : "sent", user: { sent_at: at }, rows: [failed("dup_refused", true)] });
					break;
				}
				// Roblox's per-recipient limit: the intent stays pending for the user's next day (the clock's), no backoff.
				const free = this.o.dayClock() === "utc_day" ? Math.floor(at / DAY_MS) * DAY_MS + DAY_MS : at + DAY_MS;
				await store.finish(nid, { status: "failed", error, http, code: "daily_limit", user: { capped_until: free, next_check: free }, rows: [failed("daily_limit", true)] });
				break;
			}
			case "rate_limited":
			case "retry": {
				if (outcome === "rate_limited") {
					this.bucket.on429(retryAfter);
					await this.o.durable.setJson(BUCKET_KEY, this.bucket.snapshot(), 7 * DAY_MS);
				}
				const final = attempt >= MAX_TRIES;
				if (final) await store.finish(nid, { status: "failed", error, http, code, user: { next_check: at + FATAL_RECHECK_MS }, rows: [failed(code, true)] });
				else await store.retryAt(nid, at + Math.max(RETRY_DELAYS_MS[attempt - 1] as number, retryAfter), [failed(code, false)]);
				break;
			}
			case "fatal":
				if (http === 401 || http === 403) {
					// The key, not the user: put the send back untouched and stop every send until an owner turns them back on.
					await store.finish(nid, { status: "cancelled", http, code, error, rows: [failed(code, false)] });
					this.o.haltAll("auth");
					break;
				}
				// Anything else Roblox refuses for good (a 400 INVALID_ARGUMENT, ...): this intent is done, never planned again.
				await store.finish(nid, { status: "failed", error, http, code, intent: test ? undefined : "failed", rows: [failed(code, true)] });
				this.log(`notify: Roblox refused a send for good (HTTP ${http}, ${code})`);
				break;
		}
	}

	private async post(send: SendRow): Promise<{ http: number; body: unknown; retryAfter: number }> {
		const userId = Number(send.user_id);
		const keys = this.o.keys();
		let launchData: string | undefined;
		if (keys) {
			try {
				launchData = signToken(keys.current, { nid: send.nid, kind: send.kind, userId, t: Math.floor(this.o.clock() / 1000), data: send.data ?? "" });
			} catch {
				launchData = undefined;
			}
		}
		// joinExperience / analyticsData live INSIDE payload (the API reference, UserNotification_Payload). The Open Cloud guide's curl
		// example puts them at the top level, where Roblox accepts the request (200) and silently drops both: no launch data on Join,
		// no category in the dashboard (found 2026-11-07).
		const body = requestBody(send, this.o.universeId() as number, launchData);
		this.inflight++;
		try {
			const res = await (this.o.fetch ?? fetch)(SEND_URL(userId), {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": this.o.apiKey() as string },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			const text = (await res.text()).slice(0, 4096);
			let parsed: unknown = {};
			try {
				parsed = JSON.parse(text);
			} catch {}
			this.bucket.onHeaders(parseRateHeaders((name) => res.headers.get(name)));
			return { http: res.status, body: parsed, retryAfter: retryAfterMs(res.headers.get("retry-after"), this.o.clock()) };
		} catch {
			return { http: 0, body: {}, retryAfter: 0 };
		} finally {
			this.inflight--;
		}
	}

	/** Waits (up to `ms`) for the POSTs in flight; the rest keep their lease and come back to the next server. */
	async idle(ms: number): Promise<void> {
		const until = Date.now() + ms;
		while (this.inflight > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 20));
	}
}
