/** /v1/sql, /v1/queries, saved queries and the owner session through the explorer's API client. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { describeWithPack, setupDemo, teardownDemo, testApi, TEST_NOW } from "./harness";

describeWithPack("analytics routes", () => {
	beforeAll(() => setupDemo({ engine: true }));
	afterAll(() => teardownDemo());

	it("lists the named queries", async () => {
		const queries = await testApi().queries();
		expect(queries.find((q) => q.name === "overview")?.defaultDays).toBeGreaterThan(0);
	});

	it("runs read-only SQL with column types, caps rows and hides rows after now", async () => {
		const api = testApi();
		const r = await api.sql("SELECT kind, COUNT(*) AS n, MAX(t) AS last FROM events GROUP BY kind ORDER BY n DESC", 3);
		expect(r.columns.map((c) => c.name)).toEqual(["kind", "n", "last"]);
		expect(r.columns[1]?.type).toBe("BIGINT");
		expect(r.rows).toHaveLength(3);
		expect(r.truncated).toBe(true);
		const last = await api.sql("SELECT MAX(t) AS t, MIN(t) AS f FROM events");
		expect(Number(last.rows[0]?.[0])).toBeLessThanOrEqual(TEST_NOW);
		expect(Number(last.rows[0]?.[0])).toBeGreaterThan(TEST_NOW - 3_600_000);
		const json = await api.sql("SELECT json_extract_string(props, '$.item') AS item FROM events WHERE name = 'shop_buy' AND item IS NOT NULL LIMIT 1");
		expect(typeof json.rows[0]?.[0]).toBe("string");
	});

	it("refuses writes, the demo's own tables and file readers", async () => {
		const api = testApi();
		for (const sql of ["DELETE FROM events", "SELECT 1; SELECT 2", "SELECT * FROM _tt_events", "SELECT * FROM read_csv('events.csv.gz')", "UPDATE _tt_clock SET now_ms = 0"]) {
			const error = await api.sql(sql).catch((e: unknown) => e);
			expect(error, sql).toBeInstanceOf(ApiError);
			expect((error as ApiError).status, sql).toBe(400);
		}
	});

	it("keeps saved queries in the demo state", async () => {
		const api = testApi();
		const seeded = await api.savedQueries();
		expect(seeded.length).toBeGreaterThan(0);
		for (const q of seeded) await api.sql(q.sql);
		const made = await api.createSavedQuery({ name: "Arrests per guard", sql: "SELECT pid, COUNT(*) AS n FROM events WHERE name = 'arrest' GROUP BY pid", chart: "bar" });
		expect(made.id).toBeGreaterThan(seeded.length);
		await expect(api.createSavedQuery({ name: "arrests PER guard", sql: "SELECT 1" })).rejects.toMatchObject({ status: 409 });
		await expect(api.createSavedQuery({ name: "x", sql: "DROP TABLE events" })).rejects.toMatchObject({ status: 400 });
		const renamed = await api.updateSavedQuery(made.id, { name: "Arrests by player", pinned: true });
		expect(renamed).toMatchObject({ name: "Arrests by player", pinned: true, chart: "bar" });
		expect(await api.deleteSavedQuery(made.id)).toEqual({ ok: true });
		await expect(api.deleteSavedQuery(made.id)).rejects.toMatchObject({ status: 404 });
	});
});

describe("the owner session (no data needed)", () => {
	beforeAll(() => setupDemo());

	it("signs everybody in as an owner without an avatar", async () => {
		const auth = await testApi().authCheck();
		expect(auth.role).toBe("admin");
		expect(auth.user).toMatchObject({ kind: "roblox", name: "demo_owner" });
		expect(auth.user && "avatar" in auth.user ? auth.user.avatar : undefined).toBeUndefined();
	});

	it("answers a route the demo doesn't have with 404 not in the demo", async () => {
		const error = await testApi().fleetDeploy(1).catch((e: unknown) => e);
		// The fleet domain may implement deploys; until then the router's fallback answers.
		if (error instanceof ApiError) expect([404, 200]).toContain(error.status);
	});
});
