/**
 * Feedback through the server (plans/32): ingest takes `feedback` rows from the game server and refuses them from a
 * client, POST /v1/query/feedback-list joins the UserId from identities (never on the row) and leaves erased players
 * out, and only readers get it (the game key is write-only). Every token and pid is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const UID = 7_301;

function ev(pid: string, t: number, kind: string, name: string, props: object, src = "server") {
	return { v: 1, t, kind, name, pid, sid: `${pid}-s1`, job: "job-1", art: "a1b2c3d-000001", dev: "phone", src, props: JSON.stringify(props) };
}

describe("feedback route", () => {
	let h: Harness;
	const t = T0 - 3_600_000;
	const from = new Date(t - 60_000).toISOString();

	beforeAll(async () => {
		h = await harness();
		const r = await h.call(
			"/v1/ingest",
			post(API, {
				events: [
					ev("fb-a", t, "feedback", "submit", { scale: "thumbs", type: "thumbs", steps: 2, r: 1, norm: 1, label: "Up", text: "fun", len: 3, play_s: 90 }),
					ev("fb-b", t + 1000, "custom", "feedback", { username: "x", rating: 3, text: "", length: 0 }),
					ev("fb-c", t + 2000, "feedback", "submit", { scale: "thumbs", type: "thumbs", steps: 2, r: 0, norm: 0, len: 0, play_s: 5 }, "client"),
				],
				identities: [{ pid: "fb-a", uid: UID, t }],
			}),
		);
		expect(r.status).toBe(202);
		// The client-sent feedback row is refused (server-only kind).
		expect((await asJson(r)).rejected).toBe(1);
		await h.app.load();
	});
	afterAll(() => h.close());

	test("feedback-list: rows with the UserId joined in; summary counts both kinds", async () => {
		const list = await asJson(await h.call("/v1/query/feedback-list", post(ADMIN, { filters: { from }, options: {} })));
		expect(list.result.total).toBe(2);
		expect(list.result.rows.map((x: { pid: string; uid?: number; legacy: boolean; label: string }) => [x.pid, x.uid ?? null, x.legacy, x.label])).toEqual([
			["fb-b", null, true, "OK"],
			["fb-a", UID, false, "Up"],
		]);
		const summary = await asJson(await h.call("/v1/query/feedback-summary", post(ADMIN, { filters: { from }, options: {} })));
		expect(summary.result).toMatchObject({ total: 2, withText: 1, thumbs: { up: 1, down: 0, upShare: 1 } });
	});

	test("the game key can't read feedback", async () => {
		expect((await h.call("/v1/query/feedback-list", post(API, { filters: { from }, options: {} }))).status).toBe(401);
		expect((await h.call("/v1/query/feedback-list", { method: "POST", body: "{}" })).status).toBe(401);
	});

	test("bad options answer 400", async () => {
		const r = await h.call("/v1/query/feedback-list", post(ADMIN, { filters: { from }, options: { q: "x".repeat(101) } }));
		expect(r.status).toBe(400);
	});
});
