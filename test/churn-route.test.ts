/**
 * POST /v1/query/churn through the app: the at-risk list gets UserIds (identities) and, for owners only, each player's
 * notification opt-in as the backend learned it (notify_users); the web role reads the list without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const DAY = 86_400_000;
const UID_A = 1001;
const UID_B = 1002;

/** One session (join + leave) of `pid` on the day `d` days before T0's day, at 09:00 UTC. */
function session(pid: string, d: number) {
	const t = (Math.floor(T0 / DAY) - d) * DAY + 9 * 3_600_000;
	const base = { v: 1, pid, sid: `${pid}-${d}`, job: "job-1", srv: "public", place: 1, art: "a1b2c3d-000001", seq: 1, branch: "prod", channel: "prod", dev: "phone", newp: false, exp: "{}", sexp: "", src: "server" };
	return [
		{ ...base, t, kind: "session", name: "join" },
		{ ...base, t: t + 600_000, kind: "session", name: "leave" },
	];
}

describe("churn over HTTP", () => {
	let h: Harness;
	beforeAll(async () => {
		// a and b played daily until 3 days ago (at risk: late for their rhythm); c played today.
		const days = [3, 4, 5, 6, 7];
		const events = [...days.flatMap((d) => session("a", d)), ...days.flatMap((d) => session("b", d)), ...session("c", 0)];
		const identities = [
			{ pid: "a", uid: UID_A, t: T0 - 7 * DAY },
			{ pid: "b", uid: UID_B, t: T0 - 7 * DAY },
		];
		h = await harness({ TYPETORCH_WEB_VIEWERS: "9001" });
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events, identities }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		await h.app.load();
		await h.app.notify.store.db.run("INSERT INTO notify_users (user_id, optin, optin_at) VALUES (?, 'subscribed', ?)", [UID_A, T0 - DAY]);
	});
	afterAll(() => h.close());

	const body = { filters: { from: new Date(T0 - 30 * DAY).toISOString() }, options: { bucket: "at_risk" } };

	test("owners: UserIds and the opt-in state on the at-risk list", async () => {
		const r = await asJson(await h.call("/v1/query/churn", post(ADMIN, body)));
		expect(r.result.buckets.find((b: { bucket: string }) => b.bucket === "at_risk").players).toBe(2);
		const by = Object.fromEntries(r.result.list.map((p: { pid: string }) => [p.pid, p]));
		expect(by.a).toMatchObject({ bucket: "at_risk", uid: UID_A, optin: "subscribed", daysSince: 3 });
		expect(by.b).toMatchObject({ uid: UID_B, optin: null });
	});

	test("the web role: the list without the opt-in state", async () => {
		const cookie = `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 9001, name: "Viewer" }, "web")}`;
		const res = await h.call("/v1/query/churn", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie, "x-typetorch": "1" } });
		expect(res.status).toBe(200);
		const r = await asJson(res);
		expect(r.result.list.map((p: { uid?: number }) => p.uid).sort()).toEqual([UID_A, UID_B]);
		for (const p of r.result.list) expect(p).not.toHaveProperty("optin");
	});

	test("erased players are left out", async () => {
		expect((await h.call("/v1/erasure", post(ADMIN, { pid: "b" }))).status).toBe(200);
		const r = await asJson(await h.call("/v1/query/churn", post(ADMIN, body)));
		expect(r.result.list.map((p: { pid: string }) => p.pid)).toEqual(["a"]);
	});
});
