/**
 * Named API keys with roles (plans/31). A key is `ttk_<id>_<secret>`: `id` 10 chars [0-9a-z] (public: lists, audit),
 * `secret` base64url of 32 random bytes, shown once at creation and never stored or logged. The table lives in the
 * fleet SQLite file:
 *
 *   api_keys (id PK, name, role, hash, created_at, created_by, expires_at, last_used_at, revoked_at)
 *
 * `hash` = SHA-256 hex of the whole key string. A request's key is parsed for its id, the row is found in memory (every
 * active key is cached: the server is one process and creates / revokes through this store), and the hash is compared
 * in constant time. Revoked or expired keys answer like unknown ones (401). `last_used_at` is written at most once a
 * minute per key.
 *
 * Roles map to scopes (ROLE_SCOPES); routes map to the scope they need (scopeOf). The env tokens stay as they are and are
 * listed as built-in keys (`env:api`, `env:api-previous`, `env:admin`, `env:lookup`), not revocable here.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FleetDb } from "../fleet/db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS api_keys_name ON api_keys (name, revoked_at);
`;

export const SCOPES = ["ingest:write", "identity:resolve", "players:read", "analytics:query", "analytics:sql", "settings:write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];
export const ROLES = ["game", "lookup", "support", "analyst", "admin"] as const;
export type KeyRole = (typeof ROLES)[number];

export const ROLE_SCOPES: Record<KeyRole, readonly Scope[]> = {
	game: ["ingest:write"],
	lookup: ["identity:resolve"],
	support: ["identity:resolve", "players:read"],
	analyst: ["analytics:sql", "analytics:query", "identity:resolve"],
	admin: SCOPES,
};

export const KEY_PATTERN = /^ttk_([0-9a-z]{10})_([A-Za-z0-9_-]{43})$/;
export const NAME_PATTERN = /^[a-z0-9._-]{1,48}$/;
/** Keys a backend keeps (active and revoked): a bound on the table and the cache. */
export const KEYS_MAX = 1000;
const LAST_USED_EVERY_MS = 60_000;
const DAY_MS = 86_400_000;

export interface KeyInfo {
	id: string;
	name: string;
	role: KeyRole;
	scopes: Scope[];
	createdAt: string;
	createdBy: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
	builtIn: boolean;
}

/** A key that authenticated a request. */
export interface CallerKey {
	id: string;
	name: string;
	role: KeyRole;
	scopes: readonly Scope[];
	builtIn: boolean;
}

interface Row {
	id: string;
	name: string;
	role: KeyRole;
	hash: string;
	created_at: number;
	created_by: string;
	expires_at: number | null;
	last_used_at: number | null;
	revoked_at: number | null;
}

export class KeyError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409,
	) {
		super(message);
	}
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

/** A fresh id: 10 characters [0-9a-z] (rejection sampling, no modulo bias). */
function newId(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	let out = "";
	while (out.length < 10) for (const b of randomBytes(16)) if (b < 252 && out.length < 10) out += alphabet[b % 36];
	return out;
}

export function isRole(value: unknown): value is KeyRole {
	return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The built-in keys (the env tokens), for the list. */
export interface BuiltIns {
	api: boolean;
	apiPrevious: boolean;
	lookup: boolean;
}

export class KeyStore {
	private readonly rows = new Map<string, Row>();

	private constructor(
		private readonly db: FleetDb,
		private readonly clock: () => number,
	) {}

	static async open(db: FleetDb, clock: () => number = Date.now): Promise<KeyStore> {
		await db.exec(SCHEMA);
		const store = new KeyStore(db, clock);
		for (const r of await db.all<Row>("SELECT * FROM api_keys ORDER BY created_at LIMIT ?", [KEYS_MAX])) store.rows.set(r.id, store.normal(r));
		return store;
	}

	private normal(r: Row): Row {
		const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
		return { ...r, created_at: Number(r.created_at), expires_at: n(r.expires_at), last_used_at: n(r.last_used_at), revoked_at: n(r.revoked_at) };
	}

	private active(r: Row, now: number): boolean {
		return r.revoked_at === null && (r.expires_at === null || r.expires_at > now);
	}

	/** Creates a key. Returns the key string (only here) and its info. Throws KeyError on bad input. */
	async create(input: unknown, createdBy: string): Promise<{ key: string; info: KeyInfo }> {
		const b = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
		if (typeof b.name !== "string" || !NAME_PATTERN.test(b.name)) throw new KeyError("name is 1-48 characters of a-z 0-9 . _ -", 400);
		if (!isRole(b.role)) throw new KeyError(`role is one of ${ROLES.join(", ")}`, 400);
		let expiresDays: number | undefined;
		if (b.expiresDays !== undefined && b.expiresDays !== null) {
			if (typeof b.expiresDays !== "number" || !Number.isSafeInteger(b.expiresDays) || b.expiresDays < 1 || b.expiresDays > 3650) throw new KeyError("expiresDays is a whole number from 1 to 3650", 400);
			expiresDays = b.expiresDays;
		}
		const now = this.clock();
		if ([...this.rows.values()].some((r) => r.name === b.name && r.revoked_at === null)) throw new KeyError(`a key named ${b.name} exists: revoke it first, or pick another name`, 409);
		if (this.rows.size >= KEYS_MAX) throw new KeyError(`at most ${KEYS_MAX} keys (revoked ones count)`, 409);
		let id = newId();
		while (this.rows.has(id)) id = newId();
		const key = `ttk_${id}_${randomBytes(32).toString("base64url")}`;
		const row: Row = { id, name: b.name, role: b.role, hash: sha256(key), created_at: now, created_by: createdBy.slice(0, 120), expires_at: expiresDays !== undefined ? now + expiresDays * DAY_MS : null, last_used_at: null, revoked_at: null };
		await this.db.run("INSERT INTO api_keys (id, name, role, hash, created_at, created_by, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)", [
			row.id,
			row.name,
			row.role,
			row.hash,
			row.created_at,
			row.created_by,
			row.expires_at,
		]);
		this.rows.set(id, row);
		return { key, info: this.info(row) };
	}

	/** The keys, newest first (revoked ones with `all`); never a hash or a secret. Built-ins first. */
	list(all: boolean, builtIns: BuiltIns): KeyInfo[] {
		const builtIn = (id: string, name: string, role: KeyRole): KeyInfo => ({ id, name, role, scopes: [...ROLE_SCOPES[role]], createdAt: new Date(0).toISOString(), createdBy: "environment", expiresAt: null, lastUsedAt: null, revokedAt: null, builtIn: true });
		const env: KeyInfo[] = [
			...(builtIns.api ? [builtIn("env:api", "TYPETORCH_API_KEY", "game")] : []),
			...(builtIns.apiPrevious ? [builtIn("env:api-previous", "TYPETORCH_API_KEY_PREVIOUS", "game")] : []),
			builtIn("env:admin", "TYPETORCH_ADMIN_TOKEN", "admin"),
			...(builtIns.lookup ? [builtIn("env:lookup", "TYPETORCH_LOOKUP_TOKEN", "lookup")] : []),
		];
		const rows = [...this.rows.values()].filter((r) => all || r.revoked_at === null).sort((a, b) => b.created_at - a.created_at);
		return [...env, ...rows.map((r) => this.info(r))];
	}

	async revoke(id: string): Promise<{ id: string; revokedAt: string }> {
		if (id.startsWith("env:")) throw new KeyError("built-in keys are the environment's tokens: rotate them on Coolify", 400);
		const row = this.rows.get(id);
		if (!row) throw new KeyError("no such key", 404);
		if (row.revoked_at === null) {
			row.revoked_at = this.clock();
			await this.db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [row.revoked_at, id]);
		}
		return { id, revokedAt: iso(row.revoked_at) as string };
	}

	/** The active key behind a bearer string, or undefined (not a key, unknown, wrong secret, revoked, expired). */
	resolve(token: string | undefined): CallerKey | undefined {
		if (!token) return undefined;
		const m = KEY_PATTERN.exec(token);
		if (!m) return undefined;
		const row = this.rows.get(m[1] as string);
		if (!row) return undefined;
		const given = Buffer.from(sha256(token), "hex");
		const stored = Buffer.from(row.hash, "hex");
		if (given.length !== stored.length || !timingSafeEqual(given, stored)) return undefined;
		const now = this.clock();
		if (!this.active(row, now)) return undefined;
		if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_EVERY_MS) {
			row.last_used_at = now;
			void this.db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, row.id]).catch(() => undefined);
		}
		return { id: row.id, name: row.name, role: row.role, scopes: ROLE_SCOPES[row.role], builtIn: false };
	}

	/** Whether a bearer looks like a named key (`ttk_...`), right or wrong. */
	static looksLikeKey(token: string | undefined): boolean {
		return typeof token === "string" && token.startsWith("ttk_");
	}

	private info(r: Row): KeyInfo {
		return { id: r.id, name: r.name, role: r.role, scopes: [...ROLE_SCOPES[r.role]], createdAt: iso(r.created_at) as string, createdBy: r.created_by, expiresAt: iso(r.expires_at), lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at), builtIn: false };
	}
}

/** The scope a bearer needs for a route (`path` without the /api prefix). */
export function scopeOf(method: string, path: string): Scope {
	if (method === "POST" && (path === "/v1/ingest" || path === "/v1/errors" || path === "/v1/identity")) return "ingest:write";
	if (method === "POST" && /^\/v1\/notify\/(intents|opened|played)$/.test(path)) return "ingest:write";
	if (/^\/v1\/fleet\/(heartbeat|report|alert|closing|deploy|bundle|mark|results)$/.test(path) && method === "POST") return "ingest:write";
	if (path === "/v1/fleet/commands" && method === "GET") return "ingest:write";
	if (path === "/v1/identity/resolve" && method === "GET") return "identity:resolve";
	if (/^\/v1\/players\/by-uid\/[^/]+\/(events|summary)$/.test(path) && method === "GET") return "players:read";
	if (/^\/v1\/query\/[A-Za-z-]+$/.test(path) && method === "POST") return "analytics:query";
	if (path === "/v1/queries" && method === "GET") return "analytics:query";
	if (path === "/v1/sql" && method === "POST") return "analytics:sql";
	if (path === "/v1/admin/settings" && method === "PATCH") return "settings:write";
	return "admin";
}
