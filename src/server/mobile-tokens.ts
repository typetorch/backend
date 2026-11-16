/**
 * Mobile app tokens: long-lived Bearer tokens for the TypeTorch app (README "Mobile app"). The app signs in once in the
 * phone's browser (GET /auth/mobile/start, the backend's own Roblox or typetorch.dev login, a consent page, a one-time
 * code with PKCE) or with the admin token once, and keeps a token in the phone's secure store.
 *
 * Format `ttm_<id>_<secret>` (plans/31's key format with its own prefix): `id` 10 chars [0-9a-z], `secret` base64url of
 * 32 random bytes. Only SHA-256 of the whole token is kept (SQLite `mobile_tokens` in the backend's file), compared in
 * constant time. A token carries the role its sign-in gave (admin or web) and its user; a Roblox user's token is
 * re-checked on every request (Auth.principal: an owner for admin, a viewer or owner for web) and revoked when the user
 * no longer holds it. A token made with the admin token dies when the admin token changes; one made by an owner on a
 * trusted (blessed) browser dies when that browser is revoked. Lifetime TYPETORCH_MOBILE_TOKEN_DAYS (30 to 90, default
 * 60); `last_used_at` is written at most once a minute. Bounded: MOBILE_TOKENS_PER_USER active tokens per user (the one
 * used longest ago is revoked past it), MOBILE_TOKENS_MAX active in all (a new one is refused past it); revoked and
 * expired rows are deleted MOBILE_TOKENS_KEEP_DAYS after.
 *
 * The active tokens live in memory as well (Auth.principal is synchronous); the table is the source at start.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FleetDb } from "../fleet/db.ts";
import type { AccessRole, SessionUser } from "./auth.ts";

export const MOBILE_TOKEN_PREFIX = "ttm_";
export const MOBILE_TOKEN_PATTERN = /^ttm_([0-9a-z]{10})_([A-Za-z0-9_-]{43})$/;
export const MOBILE_ID_PATTERN = /^[0-9a-z]{10}$/;
export const MOBILE_TOKENS_PER_USER = 20;
export const MOBILE_TOKENS_MAX = 2000;
export const MOBILE_TOKENS_KEEP_DAYS = 30;
export const MOBILE_DEVICE_MAX = 64;
const DAY = 86_400_000;
const TOUCH_MS = 60_000;
const DEAD_MAX = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_tokens (
	id TEXT PRIMARY KEY, hash TEXT NOT NULL, user_kind TEXT NOT NULL, user_id INTEGER, user_name TEXT, login TEXT, role TEXT NOT NULL,
	device_name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER,
	revoke_reason TEXT, admin_token_hash TEXT, blessed_device TEXT);
CREATE INDEX IF NOT EXISTS mobile_tokens_user ON mobile_tokens (user_kind, user_id);
`;

/** Who a mobile app token belongs to: the admin token or a Roblox user (a named API key never makes one). */
export type MobileUser = Exclude<SessionUser, { kind: "key" }>;

/** One token as the server keeps it (no secret; `hash` never leaves this module's callers). */
export interface MobileTokenRecord {
	id: string;
	hash: string;
	user: MobileUser;
	role: AccessRole;
	device: string;
	created: number;
	expires: number;
	lastUsed: number | null;
	revoked: number | null;
	revokeReason: string | null;
	/** Sessions.hashToken of the admin token it was made with (user kind "token" only). */
	adminTokenHash: string | null;
	/** The trusted browser an owner's admin token came through (typetorch.dev login): revoking it revokes the token. */
	blessedDevice: string | null;
}

/** What the explorer and the app see: no hash. */
export interface MobileTokenView {
	id: string;
	device: string;
	user: { kind: "token" } | { kind: "roblox"; userId: number; name: string; login?: "typetorch.dev" };
	role: AccessRole;
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string | null;
	revokedAt?: string;
	revokeReason?: string;
	/** The token of this request. */
	current?: true;
}

export class MobileTokenError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

interface Row {
	id: string;
	hash: string;
	user_kind: string;
	user_id: number | null;
	user_name: string | null;
	login: string | null;
	role: string;
	device_name: string;
	created_at: number;
	expires_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
	revoke_reason: string | null;
	admin_token_hash: string | null;
	blessed_device: string | null;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function newId(): string {
	let id = "";
	for (let i = 0; i < 10; i++) id += ALPHABET[randomInt(ALPHABET.length)];
	return id;
}

/** A device name for the list: printable, trimmed, at most MOBILE_DEVICE_MAX characters; "Mobile app" when empty. */
export function deviceName(raw: unknown): string {
	if (typeof raw !== "string") return "Mobile app";
	const clean = raw.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MOBILE_DEVICE_MAX);
	return clean || "Mobile app";
}

function toRecord(r: Row): MobileTokenRecord {
	const user: MobileUser =
		r.user_kind === "roblox" && r.user_id !== null
			? { kind: "roblox", userId: Number(r.user_id), name: r.user_name ?? `Roblox user ${r.user_id}`, ...(r.login === "typetorch.dev" ? { login: "typetorch.dev" as const } : {}) }
			: { kind: "token" };
	return {
		id: r.id,
		hash: r.hash,
		user,
		role: r.role === "admin" ? "admin" : "web",
		device: r.device_name,
		created: Number(r.created_at),
		expires: Number(r.expires_at),
		lastUsed: r.last_used_at === null ? null : Number(r.last_used_at),
		revoked: r.revoked_at === null ? null : Number(r.revoked_at),
		revokeReason: r.revoke_reason,
		adminTokenHash: r.admin_token_hash,
		blessedDevice: r.blessed_device,
	};
}

/** The list view of a record. */
export function viewOf(t: MobileTokenRecord, currentId?: string): MobileTokenView {
	const u = t.user;
	return {
		id: t.id,
		device: t.device,
		user: u.kind === "roblox" ? { kind: "roblox", userId: u.userId, name: u.name, ...(u.login ? { login: u.login } : {}) } : { kind: "token" },
		role: t.role,
		createdAt: new Date(t.created).toISOString(),
		expiresAt: new Date(t.expires).toISOString(),
		lastUsedAt: t.lastUsed === null ? null : new Date(t.lastUsed).toISOString(),
		...(t.revoked !== null ? { revokedAt: new Date(t.revoked).toISOString() } : {}),
		...(t.revokeReason ? { revokeReason: t.revokeReason } : {}),
		...(currentId === t.id ? { current: true as const } : {}),
	};
}

/** The same user (the admin token counts as one user; a named API key owns no mobile app token). */
export function sameUser(a: SessionUser, b: SessionUser): boolean {
	if (a.kind === "key" || b.kind === "key") return false;
	if (a.kind === "token" || b.kind === "token") return a.kind === b.kind;
	return a.userId === b.userId;
}

export interface MobileTokensOptions {
	/** Lifetime of a new token, days (30 to 90). */
	days: number;
	clock?: () => number;
	log?: (line: string) => void;
	perUser?: number;
	max?: number;
}

export interface MintInput {
	user: MobileUser;
	role: AccessRole;
	device: string;
	adminTokenHash?: string;
	blessedDevice?: string;
}

export class MobileTokens {
	/** The active tokens (not revoked, not expired at the last look), by id. */
	private readonly active = new Map<string, MobileTokenRecord>();
	/**
	 * Tokens that were real and are not any more (revoked, expired), by id: their hash and why, so a phone presenting one
	 * hears "sign in again" instead of counting toward the wrong-token lockout. Bounded (DEAD_MAX, oldest go first).
	 */
	private readonly dead = new Map<string, { hash: string; reason: string }>();
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private readonly perUser: number;
	private readonly max: number;
	private lastPrune = 0;

	private constructor(
		private readonly db: FleetDb,
		private readonly options: MobileTokensOptions,
	) {
		this.clock = options.clock ?? Date.now;
		this.log = options.log ?? (() => {});
		this.perUser = options.perUser ?? MOBILE_TOKENS_PER_USER;
		this.max = options.max ?? MOBILE_TOKENS_MAX;
	}

	static async open(db: FleetDb, options: MobileTokensOptions): Promise<MobileTokens> {
		await db.exec(SCHEMA);
		const store = new MobileTokens(db, options);
		const rows = await db.all<Row>("SELECT * FROM mobile_tokens WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at LIMIT ?", [store.clock(), store.max]);
		for (const row of rows) store.active.set(row.id, toRecord(row));
		const dead = await db.all<Row>("SELECT id, hash, revoke_reason, expires_at, revoked_at FROM mobile_tokens WHERE revoked_at IS NOT NULL OR expires_at <= ? ORDER BY created_at LIMIT ?", [store.clock(), DEAD_MAX]);
		for (const row of dead) store.dead.set(row.id, { hash: row.hash, reason: row.revoked_at !== null ? (row.revoke_reason ?? "revoked") : "expired" });
		return store;
	}

	/**
	 * Reads the table again: a rolling deploy's other process may have made, refreshed or revoked tokens while both ran
	 * (the handover calls this once the previous process is gone).
	 */
	async reload(): Promise<void> {
		const now = this.clock();
		const rows = await this.db.all<Row>("SELECT * FROM mobile_tokens WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at LIMIT ?", [now, this.max]);
		const seen = new Set<string>();
		for (const row of rows) {
			seen.add(row.id);
			const mine = this.active.get(row.id);
			const record = toRecord(row);
			// Keep the newer last-used mark this process may not have written yet.
			if (mine && mine.lastUsed !== null && (record.lastUsed === null || mine.lastUsed > record.lastUsed)) record.lastUsed = mine.lastUsed;
			this.active.set(row.id, record);
		}
		for (const [id, t] of this.active) {
			if (seen.has(id)) continue;
			this.active.delete(id);
			const row = await this.db.first<Row>("SELECT revoked_at, revoke_reason FROM mobile_tokens WHERE id = ?", [id]);
			this.bury(t, row && row.revoked_at !== null ? (row.revoke_reason ?? "revoked") : "expired");
		}
	}

	get lifetimeMs(): number {
		return this.options.days * DAY;
	}

	get size(): number {
		return this.active.size;
	}

	/** A new token: returns the token string (shown once) and its record. Revokes the user's oldest past the per-user cap. */
	async mint(input: MintInput, replacing?: string): Promise<{ token: string; record: MobileTokenRecord }> {
		const now = this.clock();
		this.sweep(now);
		const mine = [...this.active.values()].filter((t) => t.id !== replacing && sameUser(t.user, input.user));
		const others = this.active.size - (replacing && this.active.has(replacing) ? 1 : 0);
		// Past the per-user cap the user's token used longest ago goes; past the server's cap one more of theirs, or none is made.
		let over = Math.max(0, mine.length + 1 - this.perUser);
		if (others - over >= this.max) {
			if (mine.length > over) over++;
			else throw new MobileTokenError("too many mobile app tokens on this server: revoke some on the Settings page", 429);
		}
		if (over > 0) {
			const oldest = mine.sort((a, b) => (a.lastUsed ?? a.created) - (b.lastUsed ?? b.created)).slice(0, over);
			for (const t of oldest) await this.revoke(t.id, "replaced by a newer sign-in");
		}
		let id = newId();
		while (this.active.has(id) || (await this.db.first("SELECT id FROM mobile_tokens WHERE id = ?", [id]))) id = newId();
		const token = `${MOBILE_TOKEN_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
		const u = input.user;
		const record: MobileTokenRecord = {
			id,
			hash: sha256(token),
			user: u.kind === "roblox" ? { kind: "roblox", userId: u.userId, name: u.name.slice(0, 64), ...(u.login ? { login: u.login } : {}) } : { kind: "token" },
			role: input.role,
			device: deviceName(input.device),
			created: now,
			expires: now + this.lifetimeMs,
			lastUsed: null,
			revoked: null,
			revokeReason: null,
			adminTokenHash: u.kind === "token" ? (input.adminTokenHash ?? null) : null,
			blessedDevice: input.blessedDevice ?? null,
		};
		await this.db.run(
			"INSERT INTO mobile_tokens (id, hash, user_kind, user_id, user_name, login, role, device_name, created_at, expires_at, last_used_at, revoked_at, revoke_reason, admin_token_hash, blessed_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
			[
				id,
				record.hash,
				record.user.kind,
				record.user.kind === "roblox" ? record.user.userId : null,
				record.user.kind === "roblox" ? record.user.name : null,
				record.user.kind === "roblox" ? (record.user.login ?? "roblox") : null,
				record.role,
				record.device,
				record.created,
				record.expires,
				record.adminTokenHash,
				record.blessedDevice,
			],
		);
		this.active.set(id, record);
		return { token, record };
	}

	/**
	 * The live record behind a presented token, or undefined: unknown, wrong secret, revoked, expired, or made with an
	 * admin token that is no longer the current one. Marks it used (written at most once a minute).
	 */
	resolve(token: string, currentAdminTokenHash: string): MobileTokenRecord | undefined {
		if (token.length > 80) return undefined;
		const m = MOBILE_TOKEN_PATTERN.exec(token);
		if (!m) return undefined;
		const record = this.active.get(m[1] as string);
		if (!record) return undefined;
		const given = createHash("sha256").update(token).digest();
		const stored = Buffer.from(record.hash, "hex");
		if (stored.length !== given.length || !timingSafeEqual(stored, given)) return undefined;
		const now = this.clock();
		if (now >= record.expires) {
			this.active.delete(record.id);
			this.bury(record, "expired");
			return undefined;
		}
		if (record.user.kind === "token" && record.adminTokenHash !== currentAdminTokenHash) {
			void this.revoke(record.id, "the admin token changed");
			return undefined;
		}
		if (record.lastUsed === null || now - record.lastUsed >= TOUCH_MS) {
			record.lastUsed = now;
			void this.db.run("UPDATE mobile_tokens SET last_used_at = ? WHERE id = ?", [now, record.id]).catch((e) => this.log(`mobile tokens: could not mark a token used (${(e as Error).message.slice(0, 120)})`));
		}
		return record;
	}

	/**
	 * Why a presented token no longer works (revoked: the reason; or "expired"), when it is a real token that did (the
	 * secret matches); undefined for anything else, which counts as a wrong token.
	 */
	deadReason(token: string): string | undefined {
		if (token.length > 80) return undefined;
		const m = MOBILE_TOKEN_PATTERN.exec(token);
		if (!m) return undefined;
		const id = m[1] as string;
		const live = this.active.get(id);
		const entry = live && this.clock() >= live.expires ? { hash: live.hash, reason: "expired" } : this.dead.get(id);
		if (!entry) return undefined;
		const given = createHash("sha256").update(token).digest();
		const stored = Buffer.from(entry.hash, "hex");
		return stored.length === given.length && timingSafeEqual(stored, given) ? entry.reason : undefined;
	}

	private bury(record: MobileTokenRecord, reason: string): void {
		this.dead.delete(record.id);
		this.dead.set(record.id, { hash: record.hash, reason });
		while (this.dead.size > DEAD_MAX) this.dead.delete(this.dead.keys().next().value as string);
	}

	/** An active token by id (no secret check: for routes that already know the caller). */
	get(id: string): MobileTokenRecord | undefined {
		const t = this.active.get(id);
		return t && this.clock() < t.expires ? t : undefined;
	}

	/** Revokes one token; true when it was active. */
	async revoke(id: string, reason: string): Promise<boolean> {
		const live = this.active.get(id);
		const was = this.active.delete(id);
		if (live) this.bury(live, reason.slice(0, 80));
		const now = this.clock();
		const r = await this.db.run("UPDATE mobile_tokens SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL", [now, reason.slice(0, 80), id]);
		return was || r.changes > 0;
	}

	/** Revokes every active token the predicate matches; returns how many. */
	async revokeWhere(match: (t: MobileTokenRecord) => boolean, reason: string): Promise<number> {
		const ids = [...this.active.values()].filter(match).map((t) => t.id);
		for (const id of ids) await this.revoke(id, reason);
		return ids.length;
	}

	/**
	 * The tokens for a list: the active ones (or, with `all`, also revoked and expired ones still kept), newest first,
	 * 200 at most; only `owner`'s when given.
	 */
	async list(o: { owner?: SessionUser; all?: boolean } = {}): Promise<MobileTokenRecord[]> {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (!o.all) {
			where.push("revoked_at IS NULL AND expires_at > ?");
			params.push(this.clock());
		}
		if (o.owner) {
			if (o.owner.kind === "key") return [];
			if (o.owner.kind === "token") where.push("user_kind = 'token'");
			else {
				where.push("user_kind = 'roblox' AND user_id = ?");
				params.push(o.owner.userId);
			}
		}
		const rows = await this.db.all<Row>(`SELECT * FROM mobile_tokens${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`, params);
		return rows.map((r) => {
			const live = this.active.get(r.id);
			return live ?? toRecord(r);
		});
	}

	/** One token by id from the table (any state), or undefined. */
	async find(id: string): Promise<MobileTokenRecord | undefined> {
		if (!MOBILE_ID_PATTERN.test(id)) return undefined;
		const live = this.active.get(id);
		if (live) return live;
		const row = await this.db.first<Row>("SELECT * FROM mobile_tokens WHERE id = ?", [id]);
		return row ? toRecord(row) : undefined;
	}

	/** Deletes revoked and expired rows older than MOBILE_TOKENS_KEEP_DAYS (at most hourly unless `force`). */
	async prune(force = false): Promise<number> {
		const now = this.clock();
		this.sweep(now);
		if (!force && now - this.lastPrune < 3_600_000) return 0;
		this.lastPrune = now;
		const before = now - MOBILE_TOKENS_KEEP_DAYS * DAY;
		return (await this.db.run("DELETE FROM mobile_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?", [before, before])).changes;
	}

	private sweep(now: number): void {
		for (const [id, t] of this.active) {
			if (now >= t.expires) {
				this.active.delete(id);
				this.bury(t, "expired");
			}
		}
	}
}
