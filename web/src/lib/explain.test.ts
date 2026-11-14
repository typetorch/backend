import { describe, expect, test } from "vitest";
import { explainHeadline, explainItems, fmtDelta, fmtSigned, rankDimensions, segmentName, segmentPhrase } from "./explain";
import { d1Drop, seg } from "./explain.fixture";
import type { ExplainResult } from "./types";

describe("explain headline", () => {
	test("the biggest effect, then the biggest from another dimension", () => {
		expect(explainHeadline(d1Drop())).toBe("D1 fell 4.1 points; 72% of it is phones (rate) and 15% is a bigger share of join source teleport (mix).");
	});

	test("small segments only lead when nothing else explains it, and say so", () => {
		const r = d1Drop();
		const items = explainItems(r);
		expect(items.at(-1)?.segment.value).toBe("vr");
		r.dimensions = [{ dimension: "device", total: 1, segments: [seg("vr", { rate: -0.041, contribution: -0.041, shareOfChange: 1, small: true })] }];
		expect(explainHeadline(r)).toBe("D1 fell 4.1 points; 100% of it is VR (rate, few players).");
	});

	test("counts: the change with its percent, each segment's own change", () => {
		const r: ExplainResult = {
			...d1Drop(),
			metric: "players",
			kind: "count",
			unit: "players",
			change: 52,
			relative: 0.2708,
			current: { ...d1Drop().current, value: 244 },
			baseline: { ...d1Drop().baseline, value: 192 },
			dimensions: [
				{ dimension: "device", total: 2, segments: [seg("phone", { rate: 24, contribution: 24, shareOfChange: 0.4615 }), seg("console", { rate: 11, contribution: 11, shareOfChange: 0.2115 })] },
				{ dimension: "country", total: 1, segments: [seg("BR", { rate: 30, contribution: 30, shareOfChange: 0.5769 })] },
			],
		};
		expect(explainHeadline(r)).toBe("Players rose 52 players (+27%); 58% of it is players from Brazil and 46% is phones.");
	});

	test("no change, and changes no segment explains", () => {
		expect(explainHeadline({ ...d1Drop(), change: 0 })).toBe("D1 didn't change (35.9% in both periods).");
		const r = d1Drop();
		r.dimensions = [{ dimension: "device", total: 1, segments: [seg("phone", { rate: 0.01, contribution: 0.01, shareOfChange: -0.24 })] }];
		expect(explainHeadline(r)).toMatch(/no single segment explains it/);
	});

	test("dimensions rank by the share one trusted segment explains", () => {
		expect(rankDimensions(d1Drop()).map((d) => d.dimension)).toEqual(["source", "device"]);
	});
});

describe("explain labels", () => {
	test("segment names and phrases", () => {
		expect(segmentName("country", seg("US"))).toBe("United States");
		expect(segmentName("language", seg("pt"))).toBe("Portuguese");
		expect(segmentName("premium", seg("true"))).toBe("Premium");
		expect(segmentName("device", seg(null))).toBe("Not sent");
		expect(segmentName("build", seg(null, { other: true, segments: 3 }))).toBe("Other (3)");
		expect(segmentPhrase("language", seg("pt"))).toBe("Portuguese speakers");
		expect(segmentPhrase("playerType", seg("new"))).toBe("new players");
		expect(segmentPhrase("country", seg(null))).toBe("players with no country sent");
	});

	test("deltas in the metric's unit", () => {
		expect(fmtDelta("share", -0.041)).toBe("4.1 points");
		expect(fmtDelta("share", 0.0012)).toBe("0.12 points");
		expect(fmtDelta("minutes", 0.5)).toBe("30 s");
		expect(fmtSigned("robux", -0.4)).toBe("-R$ 0.4");
		expect(fmtSigned("players", 12)).toBe("+12 players");
	});
});
