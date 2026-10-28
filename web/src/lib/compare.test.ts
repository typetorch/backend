import { describe, expect, it } from "vitest";
import { previousPeriod, previousWindow, withPrevious } from "./compare";

const NOW = Date.UTC(2026, 9, 9, 12, 30, 15);
const H = 3_600_000;
const D = 86_400_000;

describe("previousPeriod", () => {
	it("an hour preset: the hour before, as instants (to is exclusive), other filters kept", () => {
		const p = previousPeriod({ range: "1h", branch: "prod", dev: "phone" }, NOW);
		expect(p).toEqual({ filters: { branch: "prod", dev: "phone", from: "2026-10-09T10:30:00.000Z", to: "2026-10-09T11:30:00.000Z" }, shiftMs: H });
	});

	it("a day preset: the same number of days before, up to the same time of day", () => {
		const p = previousPeriod({ range: "7d" }, NOW);
		expect(p?.shiftMs).toBe(7 * D);
		expect(p?.filters).toEqual({ from: "2026-09-26", to: "2026-10-02T12:30:00.000Z" });
		// The current 7d starts on 2026-10-03: the previous one ends 7 days before now and starts 7 days before that start.
	});

	it("a custom range: whole days before it; from a date to now; no start, no comparison", () => {
		expect(previousPeriod({ range: "custom", from: "2026-10-01", to: "2026-10-05" }, NOW)).toEqual({ filters: { from: "2026-09-26", to: "2026-09-30" }, shiftMs: 5 * D });
		expect(previousPeriod({ range: "custom", from: "2026-10-08" }, NOW)).toEqual({ filters: { from: "2026-10-06", to: "2026-10-07T12:30:00.000Z" }, shiftMs: 2 * D });
		expect(previousPeriod({ range: "custom" }, NOW)).toBeUndefined();
		expect(previousPeriod({ range: "custom", from: "2026-10-05", to: "2026-10-01" }, NOW)).toBeUndefined();
	});
});

describe("previousWindow and withPrevious", () => {
	it("the Errors window before, of the same length", () => {
		expect(previousWindow({ from: "2026-10-09T11:00:00.000Z", to: "2026-10-09T12:00:00.000Z" })).toEqual({ from: Date.UTC(2026, 9, 9, 10), to: Date.UTC(2026, 9, 9, 11) });
		expect(previousWindow({ from: "x", to: "2026-10-09T12:00:00.000Z" })).toBeUndefined();
	});

	it("puts the previous values on the current axis, null where it has none", () => {
		const rows = [
			{ t: 10 * H, s0: 1 },
			{ t: 11 * H, s0: 2 },
		];
		expect(withPrevious(rows, [{ t: 9 * H, s0: 7 }], H, "s0", "prev")).toEqual([
			{ t: 10 * H, s0: 1, prev: 7 },
			{ t: 11 * H, s0: 2, prev: null },
		]);
	});
});
