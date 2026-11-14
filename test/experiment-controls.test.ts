/**
 * Experiments you can trust and run from the explorer: the sample ratio check against the intended split, more than
 * two variants (each against the control, Holm-corrected), forced players left out, the minimum detectable effect and
 * days to significance; and POST /v1/experiments/<key>/change (owners only, audited, answers the signed CLI command,
 * changes nothing). Every token, pid and UserId is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { assignmentCheck } from "../src/queries/experiment.ts";
import { parseChange, prepareChange, shellWord } from "../src/server/experiment-change.ts";
import { ADMIN, API, T0, asJson, bearer, harness, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const OWNER = 7_001;
const VIEWER = 7_002;

let seq = 0;
function ev(pid: string, sid: string, t: number, kind: string, name: string, exp: Record<string, string>, props?: object) {
	seq += 1;
	return {
		v: 1,
		t,
		kind,
		name,
		pid,
		sid,
		job: "job-1",
		srv: "public",
		place: 1,
		art: "a1b2c3d-000001",
		seq,
		branch: "prod",
		channel: "prod",
		dev: "phone",
		newp: true,
		exp: JSON.stringify(exp),
		sexp: "",
		src: "server",
		...(props ? { props: JSON.stringify(props) } : {}),
	};
}

/** One player: the assignment row, a stamped row, and (back) a second session a day later. */
function player(pid: string, t: number, experiment: string, variant: string, o: { vi?: number; variants: number; forced?: boolean; back?: boolean }) {
	const exp = { [experiment]: variant };
	const props = { variant, variants: o.variants, ...(o.vi !== undefined ? { vi: o.vi } : {}), ...(o.forced ? { forced: true } : {}) };
	return [
		ev(pid, `${pid}-s1`, t, "experiment", experiment, exp, props),
		ev(pid, `${pid}-s1`, t + 5 * MIN, "zone", "Lobby", exp),
		...(o.back ? [ev(pid, `${pid}-s2`, t + DAY, "zone", "Lobby", exp)] : []),
	];
}

describe("experiment results you can trust", () => {
	let h: Harness;
	const t = T0 - 4 * DAY;
	const from = new Date(T0 - 5 * DAY).toISOString();
	const query = async (options: object) => (await asJson(await h.call("/v1/query/experiment", post(ADMIN, { filters: { from }, options })))).result as Record<string, any>;

	beforeAll(async () => {
		h = await harness();
		const events: object[] = [];
		const variants = ["a", "b", "c"];
		// trio: 60 random players per variant (c keeps far more players), and 5 forced into c who all came back.
		for (let i = 0; i < 180; i++) {
			const v = i % 3;
			const k = Math.floor(i / 3);
			const back = v === 2 ? k % 2 === 0 : k % 6 === 0;
			events.push(...player(`trio-${i}`, t + i * 1000, "trio", variants[v] as string, { vi: v + 1, variants: 3, back }));
		}
		for (let i = 0; i < 5; i++) events.push(...player(`trio-f${i}`, t + i * 1000, "trio", "c", { vi: 3, variants: 3, forced: true, back: true }));
		// skew: 100 in a, 50 in b: wrong for an even split, right for 2:1.
		for (let i = 0; i < 150; i++) events.push(...player(`skew-${i}`, t + i * 1000, "skew", i < 100 ? "a" : "b", { vi: i < 100 ? 1 : 2, variants: 2 }));
		// legacy: rows from a framework without vi.
		for (let i = 0; i < 40; i++) events.push(...player(`old-${i}`, t + i * 1000, "legacy", i % 2 ? "x" : "y", { variants: 2 }));
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		expect((await asJson(r)).rejected).toBe(0);
		await h.app.load();
	});
	afterAll(() => h.close());

	test("three variants: forced players out, the split checked in the game's order, each variant against the control with Holm", async () => {
		const r = await query({ experiment: "trio", control: "a" });
		expect(r.forcedPlayers).toBe(5);
		expect(r.variants.map((v: { variant: string; players: number }) => [v.variant, v.players])).toEqual([
			["a", 60],
			["b", 60],
			["c", 60],
		]);
		expect(r.assignment).toMatchObject({ order: "game", variantCount: 3, weights: [1, 1, 1], weightsFrom: "even" });
		expect(r.assignment.variants).toEqual([
			{ variant: "a", index: 1, players: 60 },
			{ variant: "b", index: 2, players: 60 },
			{ variant: "c", index: 3, players: 60 },
		]);
		expect(r.assignment.srm).toMatchObject({ df: 2, mismatch: false, enough: true });
		expect(r.assignment.srm.pValue).toBeCloseTo(1, 6);
		const kept = r.comparisons.filter((c: { metric: string }) => c.metric === "returned");
		expect(kept.map((c: { variant: string }) => c.variant)).toEqual(["b", "c"]);
		const [b, c] = kept;
		// a and b came back at the same rate (10 of 60): no difference, p = 1 either way.
		expect(b.pValue).toBe(1);
		// c (30 of 60) vs a (10 of 60): the smaller p of two doubles under Holm.
		expect(c.pAdjusted).toBeCloseTo(Math.min(1, 2 * c.pValue), 5);
		expect(c.sure).toBeCloseTo(1 - c.pAdjusted, 4);
		expect(c.days).toBe(0);
		expect(c.words).toMatch(/^c keeps more players: 9\d% sure$/);
		// The minimum detectable effect at 60 per group (5% / 2 variants, 80% power) for a 1/6 rate.
		const p = 1 / 6;
		expect(c.mde).toBeCloseTo((2.241403 + 0.841621) * Math.sqrt((p * (1 - p) * 2) / 60), 3);
		expect(c.mdeLift).toBeCloseTo(c.mde / p, 3);
		expect(b.needed).toBeNull();
		expect(b.days).toBeNull();
		expect(r.rangeDays).toBe(5);
	});

	test("sample ratio mismatch: loud against an even split, fine against the settings' 2:1", async () => {
		const even = await query({ experiment: "skew" });
		expect(even.assignment.srm.mismatch).toBe(true);
		expect(even.assignment.srm.pValue).toBeLessThan(0.001);
		expect(even.assignment.note).toContain("split changed");
		const weighted = await query({ experiment: "skew", weights: [2, 1] });
		expect(weighted.assignment).toMatchObject({ weights: [2, 1], weightsFrom: "settings" });
		expect(weighted.assignment.srm.mismatch).toBe(false);
		expect(weighted.assignment.srm.pValue).toBeCloseTo(1, 6);
		// Weights from the URL form too.
		expect((await query({ experiment: "skew", weights: "2,1" })).assignment.srm.mismatch).toBe(false);
		expect((await h.call("/v1/query/experiment", post(ADMIN, { filters: { from }, options: { experiment: "skew", weights: [0, 0] } }))).status).toBe(400);
	});

	test("rows without the variant order: an even split is still checked, uneven weights are not", async () => {
		const even = await query({ experiment: "legacy" });
		expect(even.assignment.order).toBe("names");
		expect(even.assignment.srm.mismatch).toBe(false);
		const uneven = await query({ experiment: "legacy", weights: [3, 1] });
		expect(uneven.assignment.srm).toBeNull();
		expect(uneven.assignment.note).toContain("game's variant order");
	});
});

test("assignment check: unseen variants count as 0, a weight count that doesn't fit is said", () => {
	const rows = [{ variant: "a", vi: 1, vimax: 1, nrows: 50, nvi: 50, nvar: 3, players: 50 }];
	const check = assignmentCheck(rows, undefined);
	expect(check.variants).toEqual([
		{ variant: "a", index: 1, players: 50 },
		{ variant: "(variant 2)", index: 2, players: 0 },
		{ variant: "(variant 3)", index: 3, players: 0 },
	]);
	expect(check.srm?.mismatch).toBe(true);
	expect(assignmentCheck(rows, [2, 1]).note).toContain("don't fit");
	expect(assignmentCheck([], undefined).srm).toBeNull();
});

describe("preparing a change: the command", () => {
	test("each action and its command", () => {
		expect(prepareChange("onboarding", parseChange({ action: "stop" })).command).toBe("typetorch experiment stop onboarding");
		expect(prepareChange("onboarding", parseChange({ action: "start" })).command).toBe("typetorch experiment resume onboarding");
		expect(prepareChange("onboarding", parseChange({ action: "clear" })).command).toBe("typetorch experiment clear onboarding");
		const split = prepareChange("shop.color", parseChange({ action: "split", weights: [3, 1, 0.5], variants: ["red", "blue", "green"] }));
		expect(split.command).toBe("typetorch experiment weights shop.color 3,1,0.5 --variants red,blue,green");
		expect(split.dryRun).toBe(`${split.command} --dry-run`);
		expect(split.effect).toContain("red 66.7%");
		const settle = prepareChange("onboarding", parseChange({ action: "settle", variant: "it's long", variants: ["short", "it's long"] }));
		expect(settle.command).toBe(`typetorch experiment settle onboarding 'it'\\''s long' --variants 'short,it'\\''s long'`);
		expect(prepareChange("onboarding", parseChange({ action: "split", weights: [1, 1] })).notes[0]).toContain("--variants");
		expect(prepareChange("x", parseChange({ action: "settle", variant: "a,b", variants: ["a,b", "c"] })).notes[0]).toContain("comma");
	});

	test("refuses what the CLI or the game would refuse", () => {
		for (const body of [
			{},
			{ action: "delete" },
			{ action: "split" },
			{ action: "split", weights: [0, 0] },
			{ action: "split", weights: [1, 1], variants: ["a"] },
			{ action: "settle" },
			{ action: "settle", variant: "-rf" },
			{ action: "settle", variant: "z", variants: ["a", "b"] },
			{ action: "stop", weights: [1] },
			{ action: "stop", extra: 1 },
			{ action: "split", weights: [1, 1], variants: ["a", "a"] },
		]) {
			expect(() => parseChange(body)).toThrow();
		}
		expect(() => prepareChange("bad name", { action: "stop" })).toThrow();
		expect(shellWord("$(reboot)")).toBe("'$(reboot)'");
	});
});

describe("POST /v1/experiments/<key>/change", () => {
	let h: Harness;
	let owner: Record<string, string>;
	let viewer: Record<string, string>;
	const XT = { "x-typetorch": "1", "content-type": "application/json" };

	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		expect((await h.call("/v1/access", { method: "PUT", body: JSON.stringify({ seq: 1, owners: [OWNER] }), headers: { "content-type": "application/json", ...bearer(ADMIN) } })).status).toBe(200);
		owner = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: OWNER, name: "Owner" }, "admin")}`, ...XT };
		viewer = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}`, ...XT };
	});
	afterAll(() => h.close());

	test("owners get the command, audited; viewers and the game key are refused; nothing else changes", async () => {
		const before = await asJson(await h.call("/v1/experiments", { headers: bearer(ADMIN) }));
		const r = await h.call("/v1/experiments/onboarding/change", { method: "POST", body: JSON.stringify({ action: "split", weights: [3, 1], variants: ["short", "long"] }), headers: owner });
		expect(r.status).toBe(200);
		const body = await asJson(r);
		expect(body).toMatchObject({ experiment: "onboarding", action: "split", command: "typetorch experiment weights onboarding 3,1 --variants short,long" });
		const audit = (await asJson(await h.call("/v1/admin/audit?action=experiment.prepare&limit=1", { headers: bearer(ADMIN) }))).entries[0];
		expect(audit).toMatchObject({ action: "experiment.prepare", outcome: "ok", actorKind: "roblox", userId: OWNER });
		expect(audit.details).toMatchObject({ experiment: "onboarding", change: "split", weights: [3, 1], command: body.command });
		// It applies nothing: the overrides this server knows are what they were.
		expect(await asJson(await h.call("/v1/experiments", { headers: bearer(ADMIN) }))).toEqual(before);

		expect((await h.call("/v1/experiments/onboarding/change", { method: "POST", body: JSON.stringify({ action: "stop" }), headers: viewer })).status).toBe(403);
		expect([401, 403]).toContain((await h.call("/v1/experiments/onboarding/change", post(API, { action: "stop" }))).status);
		expect((await h.call("/v1/experiments/onboarding/change", { method: "POST", body: JSON.stringify({ action: "stop" }) })).status).toBe(401);
		expect((await h.call("/v1/experiments/onboarding/change", { headers: bearer(ADMIN) })).status).toBe(405);
	});

	test("bad input: 400 with the reason, the refusal audited", async () => {
		const bad = await h.call("/v1/experiments/onboarding/change", post(ADMIN, { action: "settle", variant: "-x" }));
		expect(bad.status).toBe(400);
		expect((await asJson(bad)).error).toContain('start with "-"');
		const audit = (await asJson(await h.call("/v1/admin/audit?action=experiment.prepare&limit=1", { headers: bearer(ADMIN) }))).entries[0];
		expect(audit).toMatchObject({ outcome: "failed" });
		expect((await h.call(`/v1/experiments/${encodeURIComponent("a b")}/change`, post(ADMIN, { action: "stop" }))).status).toBe(400);
		expect((await h.call("/v1/experiments/onboarding/change", { method: "POST", body: "{", headers: { ...bearer(ADMIN), "content-type": "application/json" } })).status).toBe(400);
		expect((await h.call("/v1/experiments/onboarding/change", { method: "POST", body: "{}", headers: bearer(ADMIN) })).status).toBe(415);
	});
});
