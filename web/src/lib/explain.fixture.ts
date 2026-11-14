/** Test data for the explain panel and its headline (web/src/lib/explain.test.ts, components/ExplainPanel.test.tsx). */
import type { ExplainResult, ExplainSegment } from "./types";

export function seg(value: string | null, over: Partial<ExplainSegment> = {}): ExplainSegment {
	return {
		value,
		baseline: { players: 100, value: 0.4, share: 0.5 },
		current: { players: 100, value: 0.4, share: 0.5 },
		contribution: 0,
		rate: 0,
		mix: 0,
		shareOfChange: 0,
		small: false,
		...over,
	};
}

/** D1 fell 4.1 points: phones got worse (72% of it, rate), more players from teleports, who keep less (15%, mix). */
export function d1Drop(): ExplainResult {
	return {
		metric: "d1",
		kind: "ratio",
		unit: "share",
		within: null,
		minPlayers: 30,
		current: { from: "2026-10-08T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z", value: 0.359, players: 800 },
		baseline: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z", value: 0.4, players: 820 },
		change: -0.041,
		relative: -0.1025,
		dimensions: [
			{
				dimension: "source",
				total: 2,
				segments: [
					seg("teleport", { rate: -0.002, mix: -0.00615, contribution: -0.00815, shareOfChange: 0.1988, baseline: { players: 200, value: 0.3, share: 0.25 }, current: { players: 320, value: 0.29, share: 0.4 } }),
					seg("direct", { rate: -0.027, mix: -0.00585, contribution: -0.03285, shareOfChange: 0.8012 }),
				],
			},
			{
				dimension: "device",
				total: 4,
				segments: [
					seg("phone", { rate: -0.02952, mix: -0.0003, contribution: -0.02982, shareOfChange: 0.7273, baseline: { players: 400, value: 0.42, share: 0.49 }, current: { players: 390, value: 0.36, share: 0.49 } }),
					seg("vr", { rate: -0.009, mix: 0, contribution: -0.009, shareOfChange: 0.2195, small: true }),
					seg("desktop", { rate: -0.004, mix: 0.0018, contribution: -0.0022, shareOfChange: 0.0537 }),
					seg(null, { other: true, segments: 1, rate: 0, mix: 0, contribution: 0, shareOfChange: 0 }),
				],
			},
		],
	};
}
