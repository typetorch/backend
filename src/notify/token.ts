/**
 * The signed launch data (plans/29-contract.md "The signed launch data token"):
 *
 *   tt1n.<nid>.<k>.<uid36>.<t36>.<data>.<sig>
 *
 * nid: 10 chars [0-9a-z] (crypto random per send); k: the kind name; uid36 / t36: the UserId and the send time (unix
 * seconds) in lowercase base36; data: the intent's data as base64url without padding ("" when none); sig: base64url (no
 * padding) of the first 16 bytes of HMAC-SHA256(key, everything before the last "."), the key being the ASCII bytes of
 * the key string (43 chars of base64url, never decoded). At most 200 bytes. The framework verifies it on join; the
 * backend signs, and has `verifyToken` for its tests (the same rules as the framework's).
 *
 * The keys live in <data>/notify-keys.json (mode 0600; written by PUT /v1/notify/keys, i.e. `typetorch notify key
 * rotate`) or TYPETORCH_NOTIFY_KEY (current only, wins over the file). They are never logged and never returned.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const TOKEN_PREFIX = "tt1n.";
export const TOKEN_MAX_BYTES = 200;
export const DATA_MAX_BYTES = 64;
export const KIND_PATTERN = /^[a-z0-9_]{1,24}$/;
export const NID_PATTERN = /^[0-9a-z]{10}$/;
/** A key string: base64url of 32 random bytes (43 characters). */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The previous key stays valid this long after a rotation. */
export const PREVIOUS_KEY_MS = 7 * 86_400_000;
/** A token older than this is refused (`old`). */
export const TOKEN_MAX_AGE_S = 14 * 86_400;

const NID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A fresh send id: 10 characters [0-9a-z] from crypto randomness (rejection sampling, no modulo bias). */
export function newNid(): string {
	let out = "";
	while (out.length < 10) {
		for (const b of randomBytes(16)) {
			if (b < 252 && out.length < 10) out += NID_ALPHABET[b % 36];
		}
	}
	return out;
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

export interface TokenFields {
	nid: string;
	kind: string;
	userId: number;
	/** Send time, unix seconds. */
	t: number;
	/** The intent's data (<= 64 bytes UTF-8), or "" / undefined. */
	data?: string;
}

/** The token without its signature (the HMAC message). */
function message(f: TokenFields): string {
	return `${TOKEN_PREFIX}${f.nid}.${f.kind}.${f.userId.toString(36)}.${Math.floor(f.t).toString(36)}.${f.data ? b64url(Buffer.from(f.data, "utf8")) : ""}`;
}

function mac(key: string, msg: string): string {
	return b64url(createHmac("sha256", Buffer.from(key, "ascii")).update(msg, "utf8").digest().subarray(0, 16));
}

/** The token's length in bytes for these fields (the signature is always 22 characters). */
export function tokenLength(f: TokenFields): number {
	return Buffer.byteLength(message(f), "utf8") + 1 + 22;
}

/** Signs a token. Throws when a field is malformed or the result is over 200 bytes. */
export function signToken(key: string, f: TokenFields): string {
	if (!NID_PATTERN.test(f.nid)) throw new Error("token: bad nid");
	if (!KIND_PATTERN.test(f.kind)) throw new Error("token: bad kind");
	if (!Number.isSafeInteger(f.userId) || f.userId <= 0) throw new Error("token: bad UserId");
	if (!Number.isSafeInteger(Math.floor(f.t)) || f.t < 0) throw new Error("token: bad time");
	if (f.data && Buffer.byteLength(f.data, "utf8") > DATA_MAX_BYTES) throw new Error("token: data over 64 bytes");
	const msg = message(f);
	const token = `${msg}.${mac(key, msg)}`;
	if (Buffer.byteLength(token, "utf8") > TOKEN_MAX_BYTES) throw new Error("token: over 200 bytes");
	return token;
}

export interface NotifyKeys {
	current: string;
	previous?: string;
	/** When `current` became current, unix seconds. */
	since: number;
}

export type VerifyResult =
	| { ok: true; nid: string; kind: string; userId: number; t: number; data: string; age: number }
	| { ok: false; why: "not_ours" | "format" | "sig" | "user" | "old" };

/**
 * The framework's check, for tests and tools: prefix, 7 parts, the signature with `current` then `previous` (while
 * `now - since < 7 d`), the UserId, the age (< 14 d). `nowS` is unix seconds.
 */
export function verifyToken(token: string, keys: NotifyKeys, userId: number, nowS: number): VerifyResult {
	if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, why: "not_ours" };
	const parts = token.split(".");
	if (parts.length !== 7) return { ok: false, why: "format" };
	const [, nid, kind, uid36, t36, data, sig] = parts as [string, string, string, string, string, string, string];
	if (!NID_PATTERN.test(nid) || !KIND_PATTERN.test(kind) || !/^[0-9a-z]{1,12}$/.test(uid36) || !/^[0-9a-z]{1,12}$/.test(t36) || !/^[A-Za-z0-9_-]*$/.test(data) || !/^[A-Za-z0-9_-]{22}$/.test(sig)) {
		return { ok: false, why: "format" };
	}
	const msg = token.slice(0, token.lastIndexOf("."));
	const given = Buffer.from(sig, "base64url");
	const matches = (key: string) => {
		const expected = Buffer.from(mac(key, msg), "base64url");
		return expected.length === given.length && timingSafeEqual(expected, given);
	};
	const previousOk = keys.previous !== undefined && nowS - keys.since < PREVIOUS_KEY_MS / 1000;
	if (!matches(keys.current) && !(previousOk && matches(keys.previous as string))) return { ok: false, why: "sig" };
	const uid = Number.parseInt(uid36, 36);
	if (uid !== userId) return { ok: false, why: "user" };
	const t = Number.parseInt(t36, 36);
	if (nowS - t > TOKEN_MAX_AGE_S) return { ok: false, why: "old" };
	return { ok: true, nid, kind, userId: uid, t, data: Buffer.from(data, "base64url").toString("utf8"), age: nowS - t };
}

/** Checks a PUT /v1/notify/keys body. Throws an Error whose message never holds a key. */
export function parseKeys(body: unknown, nowS: number): NotifyKeys {
	const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
	if (typeof b.current !== "string" || !KEY_PATTERN.test(b.current)) throw new Error("current must be a key: 43 characters of base64url (typetorch notify key rotate makes one)");
	if (b.previous !== undefined && b.previous !== null && (typeof b.previous !== "string" || !KEY_PATTERN.test(b.previous))) throw new Error("previous must be a key like current, or left out");
	if (b.previous === b.current) throw new Error("previous must differ from current");
	if (typeof b.since !== "number" || !Number.isSafeInteger(b.since) || b.since <= 0 || b.since > nowS + 300) throw new Error("since must be unix seconds, not in the future");
	return { current: b.current, ...(typeof b.previous === "string" ? { previous: b.previous } : {}), since: b.since };
}

/** The keys file plus the environment override. Never logs or returns a key outside `keys()`. */
export class NotifyKeyStore {
	private stored: NotifyKeys | undefined;

	constructor(
		private readonly file: string,
		private readonly envKey: string | undefined,
		private readonly log: (line: string) => void = () => {},
	) {
		this.load();
	}

	private load(): void {
		if (!existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
			this.stored = parseKeys(raw, Number.MAX_SAFE_INTEGER / 2);
		} catch {
			this.log("notify: notify-keys.json could not be read; no signing key until the next PUT /v1/notify/keys");
		}
	}

	/** The keys in force: TYPETORCH_NOTIFY_KEY replaces `current` (previous / since from the file when present). */
	keys(): NotifyKeys | undefined {
		if (this.envKey) return { current: this.envKey, ...(this.stored?.previous && this.stored.previous !== this.envKey ? { previous: this.stored.previous } : {}), since: this.stored?.since ?? 0 };
		return this.stored;
	}

	/** For status: never the keys themselves. */
	summary(): { current: boolean; previous: boolean; since: number | null; env: boolean } {
		const k = this.keys();
		return { current: Boolean(k), previous: Boolean(k?.previous), since: k ? k.since || null : null, env: Boolean(this.envKey) };
	}

	/** Writes the file atomically with mode 0600. */
	save(keys: NotifyKeys): void {
		const text = `${JSON.stringify(keys)}\n`;
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		rmSync(tmp, { force: true });
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.file);
		try {
			chmodSync(this.file, 0o600);
		} catch {}
		this.stored = keys;
	}
}
