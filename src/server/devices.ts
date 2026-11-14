/**
 * Blessed devices (plans typetorch-dev-login "Trust concentration"): an owner who signs in through typetorch.dev gets
 * full admin only on a browser that was blessed once by something the broker never sees: the admin token
 * (`POST /auth/device`) or a link signed by the game's signing key (`GET /auth/bless`). A blessing is the cookie
 * `tt_device` (`<id>.<secret>`, 180 days, HttpOnly, SameSite=Lax, Secure over https) bound to a record in
 * `<data dir>/devices.json` (mode 0600) that holds only a hash of the secret. The secret rotates on every use (the
 * previous one stays good for a minute, for two tabs at once). Owners list and revoke devices on the Settings page.
 * A device blessed with the admin token stops counting when the token changes.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEVICE_COOKIE = "tt_device";
export const DEVICE_LIFE_MS = 180 * 86_400_000;
export const DEVICES_MAX = 50;
const ROTATE_GRACE_MS = 60_000;

export type BlessedVia = "admin token" | "signing key";

interface DeviceRecord {
	id: string;
	hash: string;
	/** The secret before the last rotation, good until `prevUntil`. */
	prevHash?: string;
	prevUntil?: number;
	created: number;
	used: number;
	via: BlessedVia;
	/** The admin token's session hash when blessed with it. */
	tokenHash?: string;
	/** A short, sanitized browser name for the list. */
	agent?: string;
}

/** What the Settings page shows: no hash, no secret. */
export interface DeviceView {
	id: string;
	created: string;
	used: string;
	via: BlessedVia;
	agent?: string;
	current?: boolean;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const same = (hashHex: string, secret: string) => {
	const given = sha256(secret);
	const stored = Buffer.from(hashHex, "hex");
	return stored.length === given.length && timingSafeEqual(stored, given);
};

/** A short label from a User-Agent: the browser and the OS, letters and digits only. */
export function agentLabel(ua: string | null): string | undefined {
	if (!ua) return undefined;
	const browser = /(Edg|OPR|Firefox|Chrome|Safari)\/\d+/.exec(ua)?.[0]?.replace("Edg/", "Edge/").replace("OPR/", "Opera/");
	const os = /(Windows|Android|iPhone|iPad|Mac OS X|Linux|CrOS)/.exec(ua)?.[0];
	const label = [browser, os].filter(Boolean).join(" on ").replace(/[^\w ./]/g, "").slice(0, 60);
	return label || undefined;
}

export class DeviceStore {
	private records: DeviceRecord[] = [];

	constructor(
		private readonly file: string,
		private readonly clock: () => number = Date.now,
	) {
		if (!existsSync(file)) return;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices?: unknown };
			if (Array.isArray(parsed.devices)) {
				this.records = (parsed.devices as DeviceRecord[])
					.filter((d) => typeof d?.id === "string" && /^[0-9a-f]{16}$/.test(d.id) && typeof d.hash === "string" && /^[0-9a-f]{64}$/.test(d.hash) && (d.via === "admin token" || d.via === "signing key"))
					.slice(-DEVICES_MAX);
			}
		} catch {
			// Unreadable: no device is blessed (fail closed).
		}
	}

	static at(dataDir: string, clock?: () => number): DeviceStore {
		return new DeviceStore(join(dataDir, "devices.json"), clock);
	}

	private save(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ devices: this.records })}\n`, { mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {}
		renameSync(tmp, this.file);
	}

	private sweep(now: number): void {
		this.records = this.records.filter((d) => now - d.used < DEVICE_LIFE_MS);
	}

	/** Blesses a new device; returns the cookie value (`<id>.<secret>`). */
	bless(via: BlessedVia, extra: { tokenHash?: string; agent?: string } = {}): string {
		const now = this.clock();
		this.sweep(now);
		const id = randomBytes(8).toString("hex");
		const secret = randomBytes(32).toString("base64url");
		this.records.push({ id, hash: sha256(secret).toString("hex"), created: now, used: now, via, ...(via === "admin token" && extra.tokenHash ? { tokenHash: extra.tokenHash } : {}), ...(extra.agent ? { agent: extra.agent } : {}) });
		// Past the cap the device used longest ago goes.
		while (this.records.length > DEVICES_MAX) {
			let oldest = 0;
			for (let i = 1; i < this.records.length; i++) if ((this.records[i] as DeviceRecord).used < (this.records[oldest] as DeviceRecord).used) oldest = i;
			this.records.splice(oldest, 1);
		}
		this.save();
		return `${id}.${secret}`;
	}

	private find(cookie: string | undefined, tokenHash: string): DeviceRecord | undefined {
		if (!cookie || cookie.length > 128) return undefined;
		const dot = cookie.indexOf(".");
		if (dot < 0) return undefined;
		const id = cookie.slice(0, dot);
		const secret = cookie.slice(dot + 1);
		const now = this.clock();
		const record = this.records.find((d) => d.id === id);
		if (!record || now - record.used >= DEVICE_LIFE_MS) return undefined;
		if (record.via === "admin token" && record.tokenHash && record.tokenHash !== tokenHash) return undefined;
		if (same(record.hash, secret)) return record;
		if (record.prevHash && record.prevUntil && now < record.prevUntil && same(record.prevHash, secret)) return record;
		return undefined;
	}

	/** The device id behind a cookie, if it is blessed (no rotation: for marking "this device" in the list). */
	idOf(cookie: string | undefined, tokenHash: string): string | undefined {
		return this.find(cookie, tokenHash)?.id;
	}

	/** Checks a cookie; when it is blessed, rotates its secret and returns the new cookie value. */
	use(cookie: string | undefined, tokenHash: string): string | undefined {
		const record = this.find(cookie, tokenHash);
		if (!record) return undefined;
		const now = this.clock();
		const secret = randomBytes(32).toString("base64url");
		record.prevHash = record.hash;
		record.prevUntil = now + ROTATE_GRACE_MS;
		record.hash = sha256(secret).toString("hex");
		record.used = now;
		this.save();
		return `${record.id}.${secret}`;
	}

	list(currentId?: string): DeviceView[] {
		this.sweep(this.clock());
		return this.records
			.map((d) => ({ id: d.id, created: new Date(d.created).toISOString(), used: new Date(d.used).toISOString(), via: d.via, ...(d.agent ? { agent: d.agent } : {}), ...(d.id === currentId ? { current: true } : {}) }))
			.sort((a, b) => b.used.localeCompare(a.used));
	}

	/** Whether a device id is blessed and not expired. */
	has(id: string): boolean {
		const record = this.records.find((d) => d.id === id);
		return Boolean(record && this.clock() - record.used < DEVICE_LIFE_MS);
	}

	revoke(id: string): boolean {
		const before = this.records.length;
		this.records = this.records.filter((d) => d.id !== id);
		if (this.records.length === before) return false;
		this.save();
		return true;
	}

	get size(): number {
		return this.records.length;
	}
}

// Signed blessing links (the CLI's `typetorch backend bless`) --------------------------------------------------------

export const BLESS_KEYS_MAX = 4;
const BLESS_CHALLENGE_TTL_MS = 5 * 60_000;
const BLESS_CHALLENGES_MAX = 100;

/** The message a blessing link signs: a fixed prefix, this backend's fingerprint and the one-time challenge. */
export function blessMessage(fingerprint: string, challenge: string): string {
	return `typetorch-bless-v1\n${fingerprint}\n${challenge}`;
}

/**
 * The public keys a blessing link may be signed with (the game's signing keys: raw Ed25519, base64), kept in
 * `<data dir>/bless-keys.json`, set by the CLI with the admin token; and the one-time challenges (5 minutes, single
 * use, at most 100 at a time).
 */
export class BlessKeys {
	private keys: { raw: string; key: KeyObject }[] = [];
	private readonly challenges = new Map<string, number>();

	constructor(
		private readonly file: string,
		private readonly clock: () => number = Date.now,
	) {
		if (!existsSync(file)) return;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { keys?: unknown };
			this.keys = BlessKeys.parse(parsed.keys);
		} catch {
			this.keys = [];
		}
	}

	static at(dataDir: string, clock?: () => number): BlessKeys {
		return new BlessKeys(join(dataDir, "bless-keys.json"), clock);
	}

	/** Checks `[base64 raw 32-byte Ed25519 public key, ...]`; throws an Error with a plain message. */
	static parse(value: unknown): { raw: string; key: KeyObject }[] {
		if (!Array.isArray(value)) throw new Error("keys must be an array of base64 Ed25519 public keys");
		if (value.length > BLESS_KEYS_MAX) throw new Error(`at most ${BLESS_KEYS_MAX} keys`);
		const out: { raw: string; key: KeyObject }[] = [];
		for (const k of value) {
			if (typeof k !== "string" || k.length > 64) throw new Error("each key is a base64 raw Ed25519 public key (32 bytes)");
			const bytes = Buffer.from(k, "base64");
			if (bytes.length !== 32) throw new Error("each key is a base64 raw Ed25519 public key (32 bytes)");
			const raw = bytes.toString("base64");
			if (out.some((o) => o.raw === raw)) continue;
			out.push({ raw, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" }) });
		}
		return out;
	}

	list(): string[] {
		return this.keys.map((k) => k.raw);
	}

	put(value: unknown): string[] {
		this.keys = BlessKeys.parse(value);
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ keys: this.list() })}\n`, { mode: 0o600 });
		renameSync(tmp, this.file);
		return this.list();
	}

	/** A fresh one-time challenge. */
	challenge(): string {
		const now = this.clock();
		for (const [c, at] of this.challenges) if (now - at > BLESS_CHALLENGE_TTL_MS) this.challenges.delete(c);
		while (this.challenges.size >= BLESS_CHALLENGES_MAX) this.challenges.delete(this.challenges.keys().next().value as string);
		const c = randomBytes(32).toString("base64url");
		this.challenges.set(c, now);
		return c;
	}

	/** Spends the challenge (whatever the outcome) and checks the signature against the stored keys. */
	check(fingerprint: string, challenge: string, signature: string): boolean {
		if (challenge.length > 128 || signature.length > 200) return false;
		const at = this.challenges.get(challenge);
		this.challenges.delete(challenge);
		if (at === undefined || this.clock() - at > BLESS_CHALLENGE_TTL_MS) return false;
		const sig = Buffer.from(signature, "base64url");
		if (sig.length !== 64) return false;
		const message = Buffer.from(blessMessage(fingerprint, challenge), "utf8");
		return this.keys.some((k) => {
			try {
				return verify(null, message, k.key, sig);
			} catch {
				return false;
			}
		});
	}

	get size(): number {
		return this.keys.length;
	}
}
