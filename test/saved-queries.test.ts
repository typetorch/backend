/**
 * Saved queries (src/server/saved-queries.ts): admins create, edit and delete them; every signed-in role lists them and
 * runs their SQL through POST /v1/sql. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSqlite } from "../src/fleet/db.ts";
import { PINNED_MAX, SAVED_QUERIES_MAX, SavedQueryError, SavedQueryStore, parseSavedQuery } from "../src/server/saved-queries.ts";
import { ADMIN, API, T0, asJson, bearer, harness, type Harness } from "./harness.ts";

const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };
const VIEWER = 4005;

const send = (method: string, body: unknown, headers: Record<string, string> = bearer(ADMIN)): RequestInit => ({ method, body: JSON.stringify(body), headers: { ...JSON_TYPE, ...headers } });

describe("parseSavedQuery", () => {
	test("a create needs a name and one read-only SELECT; an edit takes any of the fields", () => {
		expect(parseSavedQuery({ name: "  Top events ", sql: "SELECT 1;", chart: "bar", pinned: true }, true)).toEqual({ name: "Top events", sql: "SELECT 1", chart: "bar", pinned: true });
		expect(parseSavedQuery({ chart: null }, false)).toEqual({ chart: null });
		expect(parseSavedQuery({ pinned: false }, false)).toEqual({ pinned: false });
	});

	test("bad shapes are 400", () => {
		const bad: [unknown, boolean][] = [
			[null, true],
			[[], true],
			["text", true],
			[{ sql: "SELECT 1" }, true],
			[{ name: "x" }, true],
			[{ name: "", sql: "SELECT 1" }, true],
			[{ name: "x".repeat(101), sql: "SELECT 1" }, true],
			[{ name: "a\nb", sql: "SELECT 1" }, true],
			[{ name: 5, sql: "SELECT 1" }, true],
			[{ name: "x", sql: "DELETE FROM events" }, true],
			[{ name: "x", sql: "SELECT 1; SELECT 2" }, true],
			[{ name: "x", sql: "SELECT 1", chart: "pie" }, true],
			[{ name: "x", sql: "SELECT 1", pinned: "yes" }, true],
			[{ name: "x", sql: "SELECT 1", owner: "me" }, true],
			[{}, false],
			[{ sql: "" }, false],
		];
		for (const [body, full] of bad) expect(() => parseSavedQuery(body, full)).toThrow(SavedQueryError);
	});
});

describe("the store", () => {
	test("at most SAVED_QUERIES_MAX queries and PINNED_MAX pinned; names are unique ignoring case", async () => {
		const db = await openSqlite(":memory:");
		const store = await SavedQueryStore.open(db, () => T0);
		for (let i = 0; i < SAVED_QUERIES_MAX; i++) await store.create({ name: `q${i}`, sql: "SELECT 1", pinned: i < PINNED_MAX }, "admin token");
		await expect(store.create({ name: "one more", sql: "SELECT 1" }, "admin token")).rejects.toThrow(/at most 200/);
		const list = await store.list();
		expect(list.length).toBe(SAVED_QUERIES_MAX);
		expect(list.filter((q) => q.pinned).length).toBe(PINNED_MAX);
		const loose = list.find((q) => !q.pinned) as { id: number };
		await expect(store.update(loose.id, { pinned: true }, "admin token")).rejects.toThrow(/pinned/);
		await expect(store.update(loose.id, { name: "Q0" }, "admin token")).rejects.toThrow(/name exists/);
		// Re-pinning one that is pinned, or renaming a query to its own name, is fine.
		const pinned = list.find((q) => q.pinned) as { id: number; name: string };
		expect(await store.update(pinned.id, { pinned: true, name: pinned.name.toUpperCase() }, "admin token")).toMatchObject({ pinned: true, name: pinned.name.toUpperCase() });
		expect(await store.update(999_999, { pinned: false }, "admin token")).toBeUndefined();
		await db.close();
	});
});

describe("the routes and roles", () => {
	let h: Harness;
	let web: Record<string, string>;
	let ownerCookie: Record<string, string>;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "ViewerName" }, "web")}` };
		expect((await h.call("/v1/access", send("PUT", { seq: 1, owners: [77] }))).status).toBe(200);
		ownerCookie = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: 77, name: "OwnerName" }, "admin")}` };
	});
	afterAll(() => h.close());

	test("an admin creates, reads, edits and deletes; who and when are recorded, never a token", async () => {
		const created = await h.call("/v1/saved-queries", send("POST", { name: "Top events", sql: "SELECT name, COUNT(*) AS n FROM events GROUP BY name", chart: "bar" }));
		expect(created.status).toBe(201);
		const { query } = await asJson(created);
		expect(typeof query.id).toBe("number");
		expect(query).toMatchObject({ name: "Top events", chart: "bar", pinned: false, createdBy: "admin token", updatedBy: "admin token", createdAt: new Date(T0).toISOString() });
		expect(JSON.stringify(query)).not.toContain(ADMIN);
		expect(await asJson(await h.call(`/v1/saved-queries/${query.id}`, { headers: bearer(ADMIN) }))).toEqual({ query });

		// An owner's session edits it (with the explorer's header and its own origin).
		h.setNow(T0 + 60_000);
		const edit = await h.call(`/v1/saved-queries/${query.id}`, send("PATCH", { pinned: true, chart: null }, { ...ownerCookie, ...XT, origin: "http://backend.test" }));
		expect(edit.status).toBe(200);
		expect((await asJson(edit)).query).toMatchObject({ pinned: true, chart: null, createdBy: "admin token", updatedBy: "roblox user 77 (OwnerName)", updatedAt: new Date(T0 + 60_000).toISOString() });
		// Without the header, or from another site, a cookie can't change anything.
		expect((await h.call(`/v1/saved-queries/${query.id}`, send("PATCH", { pinned: false }, ownerCookie))).status).toBe(403);
		expect((await h.call(`/v1/saved-queries/${query.id}`, send("PATCH", { pinned: false }, { ...ownerCookie, ...XT, origin: "https://evil.example" }))).status).toBe(403);

		const list = await asJson(await h.call("/v1/saved-queries", { headers: bearer(ADMIN) }));
		expect(list.queries.map((q: { name: string; pinned: boolean }) => [q.name, q.pinned])).toEqual([["Top events", true]]);

		expect((await h.call(`/v1/saved-queries/${query.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call(`/v1/saved-queries/${query.id}`, { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call(`/v1/saved-queries/${query.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(404);
	});

	test("the web role lists and reads them, and runs their SQL; every change is 403", async () => {
		const { query } = await asJson(await h.call("/v1/saved-queries", send("POST", { name: "Ones", sql: "select 1 as one" })));
		expect((await asJson(await h.call("/v1/saved-queries", { headers: web }))).queries.map((q: { name: string }) => q.name)).toContain("Ones");
		const one = await asJson(await h.call(`/v1/saved-queries/${query.id}`, { headers: web }));
		const ran = await h.call("/v1/sql", { method: "POST", body: JSON.stringify({ sql: one.query.sql }), headers: { ...JSON_TYPE, ...web, ...XT } });
		expect(ran.status).toBe(200);
		expect((await asJson(ran)).rows).toEqual([[1]]);
		const session = { ...web, ...XT, origin: "http://backend.test" };
		for (const [method, path, body] of [
			["POST", "/v1/saved-queries", { name: "Mine", sql: "SELECT 2" }],
			["PATCH", `/v1/saved-queries/${query.id}`, { pinned: true }],
			["DELETE", `/v1/saved-queries/${query.id}`, undefined],
		] as const) {
			const res = await h.call(path, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { ...JSON_TYPE, ...session } });
			expect(`${method} ${res.status}`).toBe(`${method} 403`);
			expect((await asJson(res)).error).toContain("read-only");
		}
		expect((await asJson(await h.call(`/v1/saved-queries/${query.id}`, { headers: web }))).query).toMatchObject({ name: "Ones", pinned: false });
	});

	test("the API key and no credentials are refused; bad ids, methods and bodies", async () => {
		expect((await h.call("/v1/saved-queries", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/saved-queries")).status).toBe(401);
		expect((await h.call("/v1/saved-queries", send("POST", { name: "x", sql: "SELECT 1" }, bearer(API)))).status).toBe(401);
		for (const id of ["0", "abc", "1.5", "-1", "12345678901"]) expect([id, (await h.call(`/v1/saved-queries/${id}`, { headers: bearer(ADMIN) })).status]).toEqual([id, 404]);
		expect((await h.call("/v1/saved-queries/1/run", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/saved-queries", { method: "PUT", headers: bearer(ADMIN) })).status).toBe(405);
		expect((await h.call("/v1/saved-queries/1", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		expect((await h.call("/v1/saved-queries", { method: "POST", body: "{nope", headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(400);
		expect((await h.call("/v1/saved-queries", send("POST", { name: "x", sql: `SELECT '${"a".repeat(70_000)}'` }))).status).toBe(413);
		const bad = await h.call("/v1/saved-queries", send("POST", { name: "x", sql: "DROP TABLE events" }));
		expect(bad.status).toBe(400);
		expect((await asJson(bad)).error).toMatch(/SELECT or WITH/);
		expect((await h.call("/v1/saved-queries", send("POST", { name: "ONES", sql: "SELECT 1" }))).status).toBe(409);
	});

	test("changes are rate limited per address", async () => {
		const ip = "203.0.113.9";
		let last = 0;
		for (let i = 0; i < 61; i++) last = (await h.call("/v1/saved-queries/999999", { method: "DELETE", headers: bearer(ADMIN), ip })).status;
		expect(last).toBe(429);
		// Reads are not limited by it, nor are other addresses.
		expect((await h.call("/v1/saved-queries", { headers: bearer(ADMIN), ip })).status).toBe(200);
		expect((await h.call("/v1/saved-queries/999999", { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(404);
	});
});
