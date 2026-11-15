/**
 * The instance key (plans typetorch-dev-login "Project identity"): an Ed25519 key pair made on first start in
 * `<data dir>/instance.key` (PKCS#8 PEM, mode 0600). Its fingerprint, `tt1-<base32 of the first 20 bytes of
 * sha256(raw public key)>`, is this backend's identity on typetorch.dev: the audience of every central login assertion
 * and the name a person pastes into Add project. It signs the origin reports. Not a secret of the game (losing it means
 * a new fingerprint and a new Add project), but it is never logged or served; only the fingerprint and the public key are.
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

/** `tt1-` + base32 of the first 20 bytes of sha256(raw Ed25519 public key): 32 characters after the prefix. */
export function fingerprintOf(rawPublicKey: Uint8Array): string {
	return `tt1-${base32(createHash("sha256").update(rawPublicKey).digest().subarray(0, 20))}`;
}

export const FINGERPRINT_PATTERN = /^tt1-[a-z2-7]{32}$/;

/** The raw 32-byte public key of an Ed25519 KeyObject. */
export function rawEd25519(key: KeyObject): Buffer {
	const jwk = key.export({ format: "jwk" }) as { x?: string };
	if (!jwk.x) throw new Error("not an Ed25519 key");
	return Buffer.from(jwk.x, "base64url");
}

export class InstanceKey {
	private constructor(
		private readonly privateKey: KeyObject,
		/** Raw 32-byte public key. */
		readonly publicKey: Buffer,
		readonly fingerprint: string,
	) {}

	/** Loads `<dataDir>/instance.key`, or makes it (mode 0600) when it doesn't exist. */
	static loadOrCreate(dataDir: string): { key: InstanceKey; created: boolean } {
		const file = join(dataDir, "instance.key");
		let created = false;
		let privateKey: KeyObject;
		if (existsSync(file)) {
			try {
				privateKey = createPrivateKey(readFileSync(file, "utf8"));
			} catch {
				// Never put the file's content in the error.
				throw new Error(`${file} is not a readable Ed25519 private key: move it away to make a new one (that changes the fingerprint)`);
			}
			if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 key`);
		} else {
			privateKey = generateKeyPairSync("ed25519").privateKey;
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
			try {
				chmodSync(tmp, 0o600);
			} catch {}
			renameSync(tmp, file);
			created = true;
		}
		const raw = rawEd25519(createPublicKey(privateKey));
		return { key: new InstanceKey(privateKey, raw, fingerprintOf(raw)), created };
	}

	/** An Ed25519 signature over `data`. */
	sign(data: string | Uint8Array): Buffer {
		return sign(null, typeof data === "string" ? Buffer.from(data, "utf8") : data, this.privateKey);
	}

	/**
	 * Encrypts a secret this server keeps for itself (plans/35: the old server's admin token of a migration) with AES-256-GCM
	 * under a key derived (HKDF-SHA256) from the instance key and `purpose`: unreadable without instance.key. The answer is
	 * `v1.<base64url of iv | tag | ciphertext>`.
	 */
	seal(purpose: string, plain: string): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.derived(purpose), iv);
		const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
		return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
	}

	/** Decrypts what `seal` made with the same purpose; throws (without the content) when it can't. */
	open(purpose: string, sealed: string): string {
		if (!sealed.startsWith("v1.")) throw new Error("not a sealed value");
		const raw = Buffer.from(sealed.slice(3), "base64url");
		if (raw.length < 28) throw new Error("not a sealed value");
		const decipher = createDecipheriv("aes-256-gcm", this.derived(purpose), raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		try {
			return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
		} catch {
			throw new Error("the sealed value does not open with this instance key");
		}
	}

	private derived(purpose: string): Buffer {
		const ikm = this.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
		return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), `typetorch ${purpose}`, 32));
	}
}
