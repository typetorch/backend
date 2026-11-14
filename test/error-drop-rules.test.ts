/** Error drop rules: the expression language, the dropper, and the whole path (settings -> POST /v1/errors -> preview). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkDropRules, compileDropExpr, DROP_RULES_MAX, ErrorDropper, type DropSubject } from "../src/errors/drop-rules.ts";
import { ADMIN, API, T0, asJson, bearer, harness, type Harness } from "./harness.ts";

const subject = (over: Partial<DropSubject> = {}): DropSubject => ({
	message: "Failed to load mesh rbxassetid://123 (HTTP 403)",
	stack: "Workspace.Map.Loader:12",
	realm: "client",
	branch: "prod",
	build: "abc-1",
	fp: "fp-mesh",
	...over,
});
const matches = (expr: string, s: DropSubject = subject()) => compileDropExpr(expr).test(s);

describe("drop expressions", () => {
	test("operators, case, fields", () => {
		expect(matches('message contains "failed to load MESH"')).toBe(true);
		expect(matches('message contains "sound"')).toBe(false);
		expect(matches('message startswith "Failed"')).toBe(true);
		expect(matches('message endswith "(http 403)"')).toBe(true);
		expect(matches('realm is "client"')).toBe(true);
		expect(matches('realm = "CLIENT"')).toBe(true);
		expect(matches('realm != "client"')).toBe(false);
		expect(matches('branch = "prod"')).toBe(true);
		expect(matches('stack contains "Loader"')).toBe(true);
		expect(matches('any contains "loader:12"')).toBe(true);
		expect(matches('fp = "fp-mesh"')).toBe(true);
		expect(matches('build startswith "abc"')).toBe(true);
		expect(matches('stack contains "x"', subject({ stack: null }))).toBe(false);
	});

	test("regexes, and / or / not, parentheses, precedence", () => {
		expect(matches("message matches /HTTP 4\\d\\d/")).toBe(true);
		expect(matches("message matches /http 4\\d\\d/")).toBe(false);
		expect(matches("message matches /http 4\\d\\d/i")).toBe(true);
		expect(matches('message contains "mesh" and realm = "server"')).toBe(false);
		expect(matches('message contains "sound" or message contains "mesh"')).toBe(true);
		expect(matches('not realm = "server"')).toBe(true);
		// and binds tighter: a or (b and c).
		expect(matches('message contains "mesh" or message contains "sound" and realm = "server"')).toBe(true);
		expect(matches('(message contains "mesh" or message contains "sound") and realm = "server"')).toBe(false);
		expect(matches("message contains 'it\\'s' or message contains \"mesh\"")).toBe(true);
		expect(matches('MESSAGE CONTAINS "mesh" AND NOT branch = "dev"')).toBe(true);
	});

	test("readable errors for bad expressions, and the regex guard", () => {
		const reason = (expr: string) => {
			try {
				compileDropExpr(expr);
				return "";
			} catch (error) {
				return (error as Error).message;
			}
		};
		expect(reason("")).toContain("empty");
		expect(reason('msg contains "x"')).toContain("expected a field");
		expect(reason("message has \"x\"")).toContain("expected an operator");
		expect(reason("message contains")).toContain("missing a value");
		expect(reason("message contains /x/")).toContain("use matches");
		expect(reason('message matches "x"')).toContain("/regex/");
		expect(reason('message contains "x')).toContain("unclosed quote");
		expect(reason('(message contains "x"')).toContain("missing )");
		expect(reason('message contains "x" realm = "client"')).toContain("join conditions");
		expect(reason("message matches /(a+)+$/")).toContain("repeat");
		expect(reason("message matches /x/g")).toContain("flags");
		expect(reason("message matches /[/")).toContain("bad /regex/");
		expect(reason("message matches /abc")).toContain("unclosed /regex/");
		expect(reason(`message contains "${"x".repeat(600)}"`)).toContain("at most");
	});

	test("checking a saved list: ids, bounds, a bad expression names its rule", () => {
		expect(checkDropRules([{ id: "mesh", expr: ' message contains "mesh" ', note: "asset noise", on: true }])).toEqual([{ id: "mesh", expr: 'message contains "mesh"', note: "asset noise", on: true }]);
		expect(() => checkDropRules([{ id: "a", expr: "nope", on: true }])).toThrow("rule 1");
		expect(() => checkDropRules([{ id: "a", expr: 'fp = "x"', on: true }, { id: "a", expr: 'fp = "y"', on: true }])).toThrow("twice");
		expect(() => checkDropRules([{ id: "bad id!", expr: 'fp = "x"', on: true }])).toThrow("id");
		expect(() => checkDropRules([{ id: "a", expr: 'fp = "x"' }])).toThrow("on is");
		expect(() => checkDropRules(Array.from({ length: DROP_RULES_MAX + 1 }, (_, i) => ({ id: `r${i}`, expr: 'fp = "x"', on: true })))).toThrow("at most");
	});

	test("the dropper: only rules that are on, counted on the first match, swapped live", () => {
		let now = 1000;
		const d = new ErrorDropper(
			[
				{ id: "mesh", expr: 'message contains "mesh"', on: true },
				{ id: "off", expr: 'message contains "nil"', on: false },
			],
			() => now,
		);
		const base = { stack: null, firstAt: 0, lastAt: 0, branch: null, build: null, realm: "server" as const, pids: [] };
		const items = [
			{ ...base, fp: "a", template: "Failed to load mesh", count: 5 },
			{ ...base, fp: "b", template: "attempt to index nil", count: 2 },
		];
		const r = d.filter(items);
		expect(r.dropped).toBe(1);
		expect(r.kept.map((i) => i.fp)).toEqual(["b"]);
		expect(d.stats()).toEqual({ mesh: { items: 1, occurrences: 5, lastAt: 1000 } });
		now = 2000;
		d.set([{ id: "nil", expr: 'message contains "nil"', on: true }]);
		expect(d.filter(items).kept.map((i) => i.fp)).toEqual(["a"]);
		expect(d.stats()).toEqual({ nil: { items: 1, occurrences: 2, lastAt: 2000 } });
	});
});

describe("drop rules end to end", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	const MIN = 60_000;
	const item = (fp: string, template: string, realm = "client") => ({ fp, template, count: 4, firstAt: T0 - 2 * MIN, lastAt: T0 - MIN, branch: "prod", build: "b1", realm, pids: ["p1"] });
	const postErrors = (job: string, errors: unknown[]) => h.call("/v1/errors", { method: "POST", body: JSON.stringify({ j: job, errors }), headers: { ...bearer(API), "content-type": "application/json" } });
	const patch = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body), headers: { ...bearer(ADMIN), "content-type": "application/json" } });
	const preview = (expr: string) => h.call("/v1/errors/drop-rules/preview", { method: "POST", body: JSON.stringify({ expr }), headers: { ...bearer(ADMIN), "content-type": "application/json" } });
	const kinds = async () => ((await asJson(await h.call("/v1/errors?window=24h", { headers: bearer(ADMIN) }))).kinds as { fp: string }[]).map((k) => k.fp).sort();

	test("a matching error is dropped at ingest and counted; the rest is stored; the preview shows what a rule would catch", async () => {
		// Before any rule: both kinds are stored; the preview finds the mesh one among them.
		expect((await postErrors("job-d1", [item("fp-mesh-1", "Failed to load mesh rbxassetid://1"), item("fp-nil-1", "attempt to index nil", "server")])).status).toBe(202);
		await Bun.sleep(50);
		expect(await kinds()).toEqual(["fp-mesh-1", "fp-nil-1"]);
		const p = await asJson(await preview('message contains "failed to load" and realm = "client"'));
		expect(p).toMatchObject({ ok: true, kinds: 2, matchedKinds: 1, matchedOccurrences: 4 });
		expect(p.matches[0]).toMatchObject({ fp: "fp-mesh-1", occurrences: 4 });
		expect(await asJson(await preview("message contains"))).toMatchObject({ ok: false, error: expect.stringContaining("missing a value") });

		// A bad rule is refused by the settings PATCH.
		expect((await patch({ errorDropRules: [{ id: "x", expr: "nope", on: true }] })).status).toBe(400);
		expect((await patch({ errorDropRules: [{ id: "mesh", expr: 'message matches /failed to load (mesh|asset)/i', note: "asset noise", on: true }] })).status).toBe(200);

		const res = await asJson(await postErrors("job-d1", [item("fp-mesh-2", "Failed to load asset rbxassetid://2"), item("fp-nil-2", "attempt to call nil", "server")]));
		expect(res).toMatchObject({ accepted: 1, dropped: 1 });
		await Bun.sleep(50);
		expect(await kinds()).toEqual(["fp-mesh-1", "fp-nil-1", "fp-nil-2"]);
		const view = await asJson(await h.call("/v1/errors/drop-rules", { headers: bearer(ADMIN) }));
		expect(view.rules).toEqual([{ id: "mesh", expr: "message matches /failed to load (mesh|asset)/i", note: "asset noise", on: true }]);
		expect(view.counts.mesh).toMatchObject({ items: 1, occurrences: 4 });
		expect(view.source).toBe("dashboard");

		// Everything dropped: 202, nothing queued.
		expect(await asJson(await postErrors("job-d1", [item("fp-mesh-3", "failed to load mesh x")]))).toMatchObject({ accepted: 0, dropped: 1 });
		// Turned off: stored again.
		expect((await patch({ errorDropRules: [{ id: "mesh", expr: 'message contains "mesh"', on: false }] })).status).toBe(200);
		expect(await asJson(await postErrors("job-d1", [item("fp-mesh-4", "failed to load mesh y")]))).toMatchObject({ accepted: 1 });
	});

	test("the preview is for owners; the list reads for any signed-in role", async () => {
		expect((await h.call("/v1/errors/drop-rules/preview", { method: "POST", body: "{}" })).status).toBe(401);
		expect((await h.call("/v1/errors/drop-rules", {})).status).toBe(401);
		expect((await h.call("/v1/errors/drop-rules", { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
	});
});
