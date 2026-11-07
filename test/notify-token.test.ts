/**
 * The signed launch data (plans/29-contract.md "The signed launch data token"), with the shared test vector: the
 * framework pins the same string in its Luau test. The expected string was computed with node:crypto on its own:
 *   msg = "tt1n.abc0123xyz.gift_new." + (123456789).toString(36) + "." + (1762500000).toString(36) + "." + base64url("mail:42")
 *   sig = base64url(HMAC-SHA256(ascii("k" x 43), msg)[0..16])
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NID_PATTERN, NotifyKeyStore, newNid, parseKeys, signToken, tokenLength, verifyToken } from "../src/notify/token.ts";

const KEY = "k".repeat(43);
const VECTOR = "tt1n.abc0123xyz.gift_new.21i3v9.t5chpc.bWFpbDo0Mg.qHiEc9Cd2kb-f4921kh__g";
const FIELDS = { nid: "abc0123xyz", kind: "gift_new", userId: 123456789, t: 1762500000, data: "mail:42" };
const OTHER = "o".repeat(43);

describe("notify token", () => {
	test("the shared test vector", () => {
		expect(signToken(KEY, FIELDS)).toBe(VECTOR);
		expect(tokenLength(FIELDS)).toBe(VECTOR.length);
	});

	test("the second shared vector: no data, signed with what becomes the previous key", () => {
		const P = "p".repeat(43);
		const t = signToken(P, { nid: "zzzzzzzzzz", kind: "streak", userId: 123456789, t: 1762500000 });
		expect(t).toBe("tt1n.zzzzzzzzzz.streak.21i3v9.t5chpc..KhyQ1AJ5cpd4v62lfhqqUg");
		expect(verifyToken(t, { current: KEY, previous: P, since: 1762500000 }, 123456789, 1762500000 + 3600)).toMatchObject({ ok: true, kind: "streak", data: "" });
	});

	test("no data: an empty part", () => {
		const t = signToken(KEY, { ...FIELDS, data: "" });
		expect(t.split(".")).toHaveLength(7);
		expect(t.split(".")[5]).toBe("");
		expect(verifyToken(t, { current: KEY, since: 1 }, 123456789, FIELDS.t + 10)).toMatchObject({ ok: true, data: "" });
	});

	test("verify: ok, wrong user, too old, bad sig, format, not ours", () => {
		const keys = { current: KEY, since: FIELDS.t - 100 };
		expect(verifyToken(VECTOR, keys, 123456789, FIELDS.t + 60)).toEqual({ ok: true, nid: "abc0123xyz", kind: "gift_new", userId: 123456789, t: FIELDS.t, data: "mail:42", age: 60 });
		expect(verifyToken(VECTOR, keys, 987654321, FIELDS.t + 60)).toEqual({ ok: false, why: "user" });
		expect(verifyToken(VECTOR, keys, 123456789, FIELDS.t + 14 * 86_400 + 1)).toEqual({ ok: false, why: "old" });
		expect(verifyToken(VECTOR.slice(0, -2) + "AA", keys, 123456789, FIELDS.t)).toEqual({ ok: false, why: "sig" });
		expect(verifyToken(VECTOR, { current: OTHER, since: 1 }, 123456789, FIELDS.t)).toEqual({ ok: false, why: "sig" });
		expect(verifyToken("tt1n.a.b", keys, 1, FIELDS.t)).toEqual({ ok: false, why: "format" });
		expect(verifyToken("mail:42", keys, 1, FIELDS.t)).toEqual({ ok: false, why: "not_ours" });
	});

	test("the previous key: accepted for 14 days after the rotation, refused after", () => {
		const since = FIELDS.t - 100;
		const keys = { current: OTHER, previous: KEY, since };
		expect(verifyToken(VECTOR, keys, 123456789, since + 13 * 86_400).ok).toBe(true);
		expect(verifyToken(VECTOR, keys, 123456789, since + 14 * 86_400 + 1)).toEqual({ ok: false, why: "sig" });
	});

	test("signing refuses bad fields and more than 200 bytes", () => {
		expect(() => signToken(KEY, { ...FIELDS, nid: "ABC" })).toThrow();
		expect(() => signToken(KEY, { ...FIELDS, kind: "Gift" })).toThrow();
		expect(() => signToken(KEY, { ...FIELDS, data: "x".repeat(65) })).toThrow();
		// The worst case of the contract fits: 24-char kind, 64-byte data.
		expect(signToken(KEY, { ...FIELDS, kind: "k".repeat(24), userId: Number.MAX_SAFE_INTEGER, data: "x".repeat(64) }).length).toBeLessThanOrEqual(200);
	});

	test("nids: 10 of [0-9a-z], different every time", () => {
		const seen = new Set(Array.from({ length: 500 }, () => newNid()));
		expect(seen.size).toBe(500);
		for (const n of seen) expect(NID_PATTERN.test(n)).toBe(true);
	});

	test("keys: checked, saved with mode 600, the env override wins, the summary never holds a key", () => {
		expect(() => parseKeys({ current: "short", since: 1 }, 100)).toThrow();
		expect(() => parseKeys({ current: KEY, since: 10_000 }, 100)).toThrow();
		expect(() => parseKeys({ current: KEY, previous: KEY, since: 1 }, 100)).toThrow();
		const dir = mkdtempSync(join(tmpdir(), "tt-notify-keys-"));
		try {
			const file = join(dir, "notify-keys.json");
			const store = new NotifyKeyStore(file, undefined);
			expect(store.keys()).toBeUndefined();
			store.save(parseKeys({ current: KEY, previous: OTHER, since: 50 }, 100));
			if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(new NotifyKeyStore(file, undefined).keys()).toEqual({ current: KEY, previous: OTHER, since: 50 });
			const env = "e".repeat(43);
			const withEnv = new NotifyKeyStore(file, env);
			expect(withEnv.keys()?.current).toBe(env);
			expect(JSON.stringify(withEnv.summary())).not.toContain(KEY);
			expect(withEnv.summary()).toEqual({ current: true, previous: true, since: 50, env: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
