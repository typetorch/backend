/**
 * Plans/30: the raw join data `jd` (a prop on the `session` / `join` row). Ingest takes a ~1 KB `jd` object as is (props
 * are free-form JSON up to 4 KB), the Timeline's query gives it back intact, and the notifications per-player view pairs
 * an opened send with its opening session's `jd` (the join row carrying the send's `nid`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { validateBatch } from "../src/validate.ts";
import { ADMIN, API, asJson, bearer, harness, post, type Harness } from "./harness.ts";

/** A `jd` of the plan's shape, padded to about 1 KB. */
function joinData(extra: Record<string, unknown> = {}): Record<string, unknown> {
	const jd: Record<string, unknown> = {
		keys: ["FollowUserId", "GameJoinContext", "LaunchData", "Members", "ReferredByPlayerId", "SourceGameId", "SourcePlaceId", "TeleportData"],
		LaunchData: `tt1n.abc0123xyz.gift_new.21i3v9.t5chpc.bWFpbDo0Mg.qHiEc9Cd2kb-f4921kh__g`,
		LaunchDataLen: 74,
		SourcePlaceId: 1234567890,
		SourceGameId: 9876543210,
		GameJoinContext: { JoinSource: "ExperienceNotification", ItemType: "", AssetId: "0" },
		TeleportData: { bytes: 812, type: "table", keys: Array.from({ length: 20 }, (_, i) => `key_${String(i).padStart(2, "0")}_${"x".repeat(12)}`) },
		Members: { count: 3, pids: ["p_member1", "other", "other"] },
		ReferredByPlayerId: "other",
		FollowUserId: "p_follow1",
		other: { NewRobloxField: "number" },
		...extra,
	};
	return jd;
}

describe("plans/30 join data", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	const joinRow = (t: number, sid: string, props: Record<string, unknown>) => ({ v: 1, t, kind: "session", name: "join", pid: "jd-player", sid, job: "job-1", art: "a1", src: "server", props: JSON.stringify(props) });

	test("a join row with a ~1 KB jd passes validation unchanged", () => {
		const props = { from: "notification", ctx: "ExperienceNotification", nid: "abc0123xyz", nk: "gift_new", jd: joinData() };
		const text = JSON.stringify(props);
		expect(Buffer.byteLength(JSON.stringify(props.jd))).toBeGreaterThan(900);
		expect(Buffer.byteLength(JSON.stringify(props.jd))).toBeLessThanOrEqual(1024);
		const batch = validateBatch({ events: [joinRow(Date.UTC(2026, 10, 7), "s1", props)] });
		expect(batch.errors).toEqual([]);
		expect(batch.rejected).toBe(0);
		expect(batch.events[0]?.props).toBe(text);
	});

	test("ingest -> the Timeline's query gives the jd back intact (with trunc, and absent)", async () => {
		const t = h.now() - 60_000;
		const full = joinData();
		const cut = joinData({ trunc: true, TeleportData: { bytes: 99_000, type: "table" } });
		const res = await h.call(
			"/v1/ingest",
			post(API, {
				events: [
					joinRow(t, "s1", { from: "notification", nid: "abc0123xyz", nk: "gift_new", jd: full }),
					joinRow(t + 1000, "s2", { from: "direct", jd: cut }),
					joinRow(t + 2000, "s3", { from: "direct" }),
				],
			}),
		);
		expect(await asJson(res)).toMatchObject({ accepted: 3, rejected: 0 });
		await h.app.load();
		const r = await asJson(await h.call("/v1/query/timeline", post(ADMIN, { options: { pid: "jd-player" } })));
		const joins = (r.result.events as { name: string; sid: string; props: Record<string, unknown> }[]).filter((e) => e.name === "join");
		expect(joins.map((e) => e.sid)).toEqual(["s1", "s2", "s3"]);
		expect(joins[0]?.props.jd).toEqual(full);
		expect(joins[1]?.props.jd).toEqual(cut);
		expect(joins[2]?.props.jd).toBeUndefined();
	});

	test("the notifications per-player view pairs an opened send's nid with the opening session's jd", async () => {
		await h.call("/v1/identity", post(API, { identities: [{ pid: "jd-player", uid: 777, t: h.now() }] }));
		const v = await asJson(await h.call("/v1/notify/user?uid=777", { headers: bearer(ADMIN) }));
		expect(v.events.opens).toEqual([{ nid: "abc0123xyz", at: expect.any(String), t: expect.any(Number), sid: "s1", jd: joinData() }]);
	});
});
