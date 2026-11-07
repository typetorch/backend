/** The durable layer (src/store/durable.ts): kv with expiry, counters, sorted sets and leases, on in-memory SQLite. */
import { beforeEach, describe, expect, test } from "bun:test";
import { openSqlite } from "../src/fleet/db.ts";
import { Durable } from "../src/store/durable.ts";

let now = 1_000_000;
let d: Durable;

beforeEach(async () => {
	now = 1_000_000;
	d = await Durable.open(await openSqlite(":memory:"), () => now);
});

describe("kv", () => {
	test("get / set / del, json", async () => {
		expect(await d.get("a")).toBeUndefined();
		await d.set("a", "1");
		expect(await d.get("a")).toBe("1");
		await d.setJson("j", { x: [1, 2] });
		expect(await d.getJson<unknown>("j")).toEqual({ x: [1, 2] });
		expect(await d.del("a")).toBe(true);
		expect(await d.del("a")).toBe(false);
		expect(await d.get("a")).toBeUndefined();
	});

	test("a ttl hides the value once it runs out; sweep deletes it", async () => {
		await d.set("t", "v", 1000);
		await d.set("keep", "v");
		now += 999;
		expect(await d.get("t")).toBe("v");
		now += 1;
		expect(await d.get("t")).toBeUndefined();
		expect(await d.sweep()).toBe(1);
		expect(await d.get("keep")).toBe("v");
	});

	test("incr: starts at 0, the ttl is set when the counter starts and is not pushed back", async () => {
		expect(await d.incr("c", 1, 1000)).toBe(1);
		now += 600;
		expect(await d.incr("c", 2, 1000)).toBe(3);
		now += 400;
		// The first ttl ran out: a fresh counter.
		expect(await d.incr("c", 1, 1000)).toBe(1);
		expect(await d.incr("n")).toBe(1);
		expect(await d.incr("n", -3)).toBe(-2);
	});

	test("bounds: empty or long keys are refused", async () => {
		await expect(d.set("", "x")).rejects.toThrow();
		await expect(d.set("k".repeat(257), "x")).rejects.toThrow();
		await expect(d.set("k", "x".repeat(64 * 1024 + 1))).rejects.toThrow();
	});
});

describe("zset and lease", () => {
	test("zadd / zrangeDue / zrem: due by score, lowest first", async () => {
		await d.zadd("q", "b", 200);
		await d.zadd("q", "a", 100);
		await d.zadd("q", "c", 5000);
		await d.zadd("other", "x", 1);
		expect(await d.zrangeDue("q", 1000, 10)).toEqual([
			{ member: "a", score: 100 },
			{ member: "b", score: 200 },
		]);
		await d.zadd("q", "a", 6000);
		expect((await d.zrangeDue("q", 1000, 10)).map((m) => m.member)).toEqual(["b"]);
		expect(await d.zrem("q", "b")).toBe(true);
		expect(await d.zrangeDue("q", 1000, 10)).toEqual([]);
		expect(await d.zcount("q", 0, 10_000)).toBe(2);
	});

	test("lease: one taker per member; a crashed holder's members come back after the ttl", async () => {
		for (let i = 0; i < 5; i++) await d.zadd("q", `m${i}`, i);
		const first = await d.lease("q", 10, 1000, 3);
		expect(first.map((m) => m.member)).toEqual(["m0", "m1", "m2"]);
		const second = await d.lease("q", 10, 1000, 10);
		expect(second.map((m) => m.member)).toEqual(["m3", "m4"]);
		expect(await d.lease("q", 500, 1000, 10)).toEqual([]);
		expect(await d.zleased("q", 500)).toBe(5);
		// The first holder finished m0 and "crashed" holding m1, m2; the second re-queued m3 for later.
		await d.zrem("q", "m0");
		await d.zadd("q", "m3", 5000);
		const back = await d.lease("q", 1010, 1000, 10);
		expect(back.map((m) => m.member).sort()).toEqual(["m1", "m2", "m4"]);
		expect(await d.zscore("q", "m3")).toBe(5000);
	});
});
