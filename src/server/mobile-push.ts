/**
 * Push for the TypeTorch app (README "Mobile app", mobile docs PUSH_WATCH_WIDGETS.md): one Expo push registration per
 * mobile app token (`POST /v1/mobile/push`), kept in SQLite `mobile_push` beside `mobile_tokens`, and the sender that
 * hands messages to Expo's push service (https://exp.host/--/api/v2/push/send, which passes them to FCM).
 *
 * A registration lives as long as its token: logout, revoke, revoke-all and expiry take it out (MobileTokens' onGone
 * hook, and `prune` for anything another process revoked); a refresh moves it to the new token. A push token answered
 * with DeviceNotRegistered (in the ticket, or in the receipt read 15 minutes later) is removed. Push tokens are never
 * returned by a route or logged: logs name the mobile token's id (not a secret) and counts.
 *
 * Bounded: one row per mobile token (MOBILE_PUSH_MAX in all), at most PENDING_MAX tickets waiting for their receipt.
 * Sends are batched (EXPO_BATCH messages a request) with a 10 s timeout each; a failure is logged and never thrown at
 * the caller that asked for the send (the alert evaluator).
 */
import type { FleetDb } from "../fleet/db.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo's push token: ExponentPushToken[...] (or the newer ExpoPushToken[...]). */
export const EXPO_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;
export const MOBILE_PUSH_MAX = 2000;
/** Messages per request to Expo (its limit). */
export const EXPO_BATCH = 100;
/** Receipt ids per request to Expo (its limit). */
const RECEIPT_BATCH = 300;
const TIMEOUT_MS = 10_000;
/** Expo keeps receipts a day; it suggests reading them after about 15 minutes. */
const RECEIPT_AFTER_MS = 15 * 60_000;
const RECEIPT_GIVE_UP_MS = 12 * 3_600_000;
const PENDING_MAX = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_push (
	token_id TEXT PRIMARY KEY, push_token TEXT NOT NULL, milestones INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mobile_push_token ON mobile_push (push_token);
`;

/** One message as Expo takes it (the fields used here). */
export interface ExpoMessage {
	to: string;
	title: string;
	body: string;
	channelId?: string;
	priority?: "default" | "normal" | "high";
	sound?: "default" | null;
	data?: Record<string, unknown>;
}

/** Expo's answer for one message: a ticket (ok with a receipt id) or an error. */
export interface ExpoTicket {
	status: "ok" | "error";
	id?: string;
	message?: string;
	details?: { error?: string };
}

export class MobilePushError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
	}
}

interface Row {
	token_id: string;
	push_token: string;
	milestones: number;
}

export interface MobilePushOptions {
	/** Whether a mobile app token id is still live (MobileTokens.get): a dead token's registration never gets a push. */
	isLive: (tokenId: string) => boolean;
	fetch?: typeof fetch;
	clock?: () => number;
	log?: (line: string) => void;
}

/** What a send did, for logs and tests (never the push tokens). */
export interface SendResult {
	sent: number;
	ok: number;
	failed: number;
	removed: number;
}

export class MobilePush {
	private readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	/** Receipt id -> the registration it was sent for, until its receipt is read. */
	private readonly pending = new Map<string, { tokenId: string; pushToken: string; at: number }>();

	private constructor(
		private readonly db: FleetDb,
		private readonly options: MobilePushOptions,
	) {
		this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
	}

	static async open(db: FleetDb, options: MobilePushOptions): Promise<MobilePush> {
		await db.exec(SCHEMA);
		return new MobilePush(db, options);
	}

	/**
	 * Registers (or replaces) the registration of one mobile app token. The same push token under another mobile token
	 * (the same phone signed in again) is dropped, so a phone never gets a milestone twice.
	 */
	async set(tokenId: string, pushToken: string, milestones: boolean): Promise<void> {
		if (!EXPO_TOKEN_PATTERN.test(pushToken)) throw new MobilePushError("token must be an Expo push token: ExponentPushToken[...]", 400, "bad_push_token");
		const have = await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM mobile_push WHERE token_id <> ?", [tokenId]);
		if (Number(have?.n ?? 0) >= MOBILE_PUSH_MAX) {
			await this.prune();
			const again = await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM mobile_push WHERE token_id <> ?", [tokenId]);
			if (Number(again?.n ?? 0) >= MOBILE_PUSH_MAX) throw new MobilePushError("too many push registrations on this server", 429);
		}
		const now = this.clock();
		await this.db.transaction((tx) => {
			tx.run("DELETE FROM mobile_push WHERE push_token = ? AND token_id <> ?", [pushToken, tokenId]);
			tx.run(
				"INSERT INTO mobile_push (token_id, push_token, milestones, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET push_token = excluded.push_token, milestones = excluded.milestones, updated_at = excluded.updated_at",
				[tokenId, pushToken, milestones ? 1 : 0, now, now],
			);
		});
	}

	/** Removes one mobile app token's registration; true when there was one. */
	async remove(tokenId: string): Promise<boolean> {
		return (await this.db.run("DELETE FROM mobile_push WHERE token_id = ?", [tokenId])).changes > 0;
	}

	/** The registration of one mobile app token (for the server only: never answered to a client). */
	async get(tokenId: string): Promise<{ pushToken: string; milestones: boolean } | undefined> {
		const row = await this.db.first<Row>("SELECT token_id, push_token, milestones FROM mobile_push WHERE token_id = ?", [tokenId]);
		return row ? { pushToken: row.push_token, milestones: row.milestones === 1 } : undefined;
	}

	/** The token is gone (MobileTokens' onGone): its registration goes, in the background. A refresh moves it instead. */
	forget(tokenId: string): void {
		void this.remove(tokenId).catch((e) => this.log(`mobile push: could not remove the registration of ${tokenId} (${(e as Error).message.slice(0, 120)})`));
	}

	/** A refresh made a new token for the same sign-in: the registration follows it. */
	async move(from: string, to: string): Promise<void> {
		await this.db.run("UPDATE OR REPLACE mobile_push SET token_id = ? WHERE token_id = ?", [to, from]);
	}

	/** Deletes the registrations whose mobile app token is no longer live in the table (another process revoked it). */
	async prune(): Promise<number> {
		const now = this.clock();
		const r = await this.db.run("DELETE FROM mobile_push WHERE token_id NOT IN (SELECT id FROM mobile_tokens WHERE revoked_at IS NULL AND expires_at > ?)", [now]);
		return r.changes;
	}

	/** How many registrations there are, and how many want milestones. */
	async counts(): Promise<{ registrations: number; milestones: number }> {
		const r = await this.db.first<{ n: number; m: number | null }>("SELECT COUNT(*) AS n, SUM(milestones) AS m FROM mobile_push");
		return { registrations: Number(r?.n ?? 0), milestones: Number(r?.m ?? 0) };
	}

	/**
	 * Sends one message (built per registration) to every registration with milestones on whose mobile token is live.
	 * Never throws: failures are logged and counted.
	 */
	async sendMilestones(build: (pushToken: string) => ExpoMessage): Promise<SendResult> {
		try {
			const rows = await this.db.all<Row>("SELECT token_id, push_token, milestones FROM mobile_push WHERE milestones = 1 ORDER BY token_id LIMIT ?", [MOBILE_PUSH_MAX]);
			const live = rows.filter((r) => this.options.isLive(r.token_id));
			const dead = rows.filter((r) => !this.options.isLive(r.token_id));
			for (const r of dead) this.forget(r.token_id);
			// One push per phone even if two registrations somehow share a push token.
			const seen = new Set<string>();
			const targets = live.filter((r) => (seen.has(r.push_token) ? false : (seen.add(r.push_token), true)));
			const result = await this.send(targets.map((r) => ({ tokenId: r.token_id, message: build(r.push_token) })));
			return { ...result, removed: result.removed + dead.length };
		} catch (error) {
			this.log(`mobile push: the milestone send failed (${(error as Error).message.slice(0, 160)})`);
			return { sent: 0, ok: 0, failed: 0, removed: 0 };
		}
	}

	/**
	 * Sends one message to one mobile token's registration and returns Expo's ticket (status, error), or undefined when
	 * the token has none. Throws MobilePushError 502 when Expo can't be reached.
	 */
	async sendOne(tokenId: string, build: (pushToken: string) => ExpoMessage): Promise<{ status: "ok" | "error"; error?: string } | undefined> {
		const reg = await this.get(tokenId);
		if (!reg) return undefined;
		const tickets = await this.post([{ tokenId, message: build(reg.pushToken) }]);
		if (!tickets) throw new MobilePushError("the push service could not be reached", 502, "push_unavailable");
		const t = tickets[0];
		if (!t) throw new MobilePushError("the push service gave no ticket", 502, "push_unavailable");
		await this.afterTicket(tokenId, reg.pushToken, t);
		return { status: t.status === "ok" ? "ok" : "error", ...(t.status !== "ok" ? { error: shortError(t) } : {}) };
	}

	/** Sends in batches of EXPO_BATCH; DeviceNotRegistered removes the registration. */
	private async send(list: { tokenId: string; message: ExpoMessage }[]): Promise<SendResult> {
		const out: SendResult = { sent: 0, ok: 0, failed: 0, removed: 0 };
		for (let i = 0; i < list.length; i += EXPO_BATCH) {
			const batch = list.slice(i, i + EXPO_BATCH);
			out.sent += batch.length;
			const tickets = await this.post(batch);
			if (!tickets) {
				out.failed += batch.length;
				continue;
			}
			for (let j = 0; j < batch.length; j++) {
				const entry = batch[j] as { tokenId: string; message: ExpoMessage };
				const t = tickets[j];
				if (t?.status === "ok") out.ok++;
				else out.failed++;
				if (t && (await this.afterTicket(entry.tokenId, entry.message.to, t))) out.removed++;
			}
		}
		if (out.sent) this.log(`mobile push: ${out.sent} sent, ${out.ok} accepted, ${out.failed} failed, ${out.removed} registration(s) removed`);
		return out;
	}

	/** Keeps an ok ticket for its receipt; removes a registration Expo says is gone. True when it removed one. */
	private async afterTicket(tokenId: string, pushToken: string, t: ExpoTicket): Promise<boolean> {
		if (t.status === "ok" && typeof t.id === "string" && t.id.length <= 64) {
			while (this.pending.size >= PENDING_MAX) this.pending.delete(this.pending.keys().next().value as string);
			this.pending.set(t.id, { tokenId, pushToken, at: this.clock() });
			return false;
		}
		if (t.details?.error === "DeviceNotRegistered") return this.dropDevice(tokenId, pushToken);
		return false;
	}

	/** Removes a registration only while it still holds that push token (the phone may have registered a new one since). */
	private async dropDevice(tokenId: string, pushToken: string): Promise<boolean> {
		const r = await this.db.run("DELETE FROM mobile_push WHERE token_id = ? AND push_token = ?", [tokenId, pushToken]);
		if (r.changes) this.log(`mobile push: ${tokenId}'s phone is no longer registered with Expo: registration removed`);
		return r.changes > 0;
	}

	/** One request to Expo's send endpoint; the tickets in order, or undefined (logged) when it failed. */
	private async post(batch: { tokenId: string; message: ExpoMessage }[]): Promise<ExpoTicket[] | undefined> {
		const answer = await this.call(
			EXPO_PUSH_URL,
			batch.map((b) => b.message),
		);
		const data = answer && Array.isArray((answer as { data?: unknown }).data) ? ((answer as { data: unknown[] }).data as ExpoTicket[]) : undefined;
		if (answer && !data) this.log("mobile push: the push service's answer had no tickets");
		return data;
	}

	private async call(url: string, body: unknown): Promise<unknown> {
		try {
			const res = await this.fetch(url, {
				method: "POST",
				headers: { accept: "application/json", "accept-encoding": "gzip, deflate", "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!res.ok) {
				this.log(`mobile push: the push service answered ${res.status}`);
				await res.body?.cancel().catch(() => {});
				return undefined;
			}
			const text = await res.text();
			if (text.length > 2_000_000) {
				this.log("mobile push: the push service's answer was too large");
				return undefined;
			}
			return JSON.parse(text) as unknown;
		} catch (error) {
			this.log(`mobile push: the push service could not be reached (${(error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message.slice(0, 120)})`);
			return undefined;
		}
	}

	/**
	 * Reads the receipts of tickets sent at least 15 minutes ago: a DeviceNotRegistered removes the registration. Tickets
	 * without a receipt after 12 hours are forgotten. Never throws.
	 */
	async checkReceipts(): Promise<number> {
		const now = this.clock();
		let removed = 0;
		for (const [id, p] of this.pending) if (now - p.at > RECEIPT_GIVE_UP_MS) this.pending.delete(id);
		const due = [...this.pending].filter(([, p]) => now - p.at >= RECEIPT_AFTER_MS);
		for (let i = 0; i < due.length; i += RECEIPT_BATCH) {
			const batch = due.slice(i, i + RECEIPT_BATCH);
			const answer = await this.call(EXPO_RECEIPTS_URL, { ids: batch.map(([id]) => id) });
			const data = answer && typeof (answer as { data?: unknown }).data === "object" ? ((answer as { data: Record<string, ExpoTicket | undefined> }).data ?? {}) : undefined;
			if (!data) continue;
			for (const [id, p] of batch) {
				const receipt = Object.hasOwn(data, id) ? data[id] : undefined;
				if (!receipt) continue;
				this.pending.delete(id);
				if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
					try {
						if (await this.dropDevice(p.tokenId, p.pushToken)) removed++;
					} catch (error) {
						this.log(`mobile push: could not remove a registration (${(error as Error).message.slice(0, 120)})`);
					}
				}
			}
		}
		return removed;
	}

	/** Tickets waiting for their receipt (tests). */
	get pendingReceipts(): number {
		return this.pending.size;
	}
}

/** A ticket's error for the app: Expo's error code, else a short message. */
function shortError(t: ExpoTicket): string {
	const code = t.details?.error;
	if (typeof code === "string" && /^[A-Za-z]{1,64}$/.test(code)) return code;
	return typeof t.message === "string" ? t.message.replace(/ExponentPushToken\[[^\]]*\]|ExpoPushToken\[[^\]]*\]/g, "the push token").slice(0, 160) : "error";
}
