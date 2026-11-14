// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { BarList, countryName, filtersRobloxCannotTake, languageName, ownRows, robloxRows, windowLabel } from "./Demographics";
import type { DemographicsResult } from "@/lib/types";

const result = (rows: Partial<DemographicsResult["dimensions"]>): DemographicsResult => ({
	from: "",
	to: "",
	players: 10,
	dimensions: { country: [], language: [], accountAge: [], premium: [], device: [], ...rows },
});

describe("demographics labels", () => {
	test("codes become names; unknown codes stay", () => {
		expect(countryName("US")).toBe("United States");
		expect(countryName("XX-1")).toBe("XX-1");
		expect(languageName("pt-br")).toBe("Portuguese");
		expect(languageName("en_us")).toBe("English");
	});

	test("our rows: Not sent last and muted, account age in age order, Premium named", () => {
		const r = result({
			language: [
				{ value: null, players: 6, share: 0.6 },
				{ value: "en", players: 4, share: 0.4 },
			],
			accountAge: [
				{ value: "3y+", players: 6, share: 0.6 },
				{ value: "<1d", players: 4, share: 0.4 },
			],
			premium: [{ value: "true", players: 1, share: 0.1 }],
		});
		expect(ownRows("language", r).map((x) => [x.label, x.muted ?? false])).toEqual([
			["English", false],
			["Not sent", true],
		]);
		expect(ownRows("accountAge", r).map((x) => x.label)).toEqual(["Under a day", "3+ years"]);
		expect(ownRows("premium", r)[0]?.label).toBe("Premium");
	});

	test("Roblox rows keep its display names, name bare ISO codes, mute Unknown", () => {
		const rows = robloxRows("Country", [
			{ value: "US", label: "US", users: 277, share: 0.9 },
			{ value: "Unknown", label: "Unknown", users: 3, share: 0.1 },
		]);
		expect(rows.map((x) => [x.label, x.muted ?? false])).toEqual([
			["United States", false],
			["Unknown", true],
		]);
		expect(robloxRows("AgeGroupV2", [{ value: "Age21Plus", label: "21+", users: 1, share: 1 }])[0]?.label).toBe("21+");
	});

	test("the bar list shows the top rows and a toggle for the rest", () => {
		const rows = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: `Row ${i}`, share: (12 - i) / 100, count: 12 - i }));
		render(<BarList rows={rows} top={10} unit="player" />);
		expect(screen.getByText("Row 0")).toBeTruthy();
		expect(screen.queryByText("Row 11")).toBeNull();
		expect(screen.getByText("Show all 12")).toBeTruthy();
		expect(screen.getByTitle("Row 0: 12 players (12%)")).toBeTruthy();
	});

	test("which filters Roblox can't take, and the window's label", () => {
		expect(filtersRobloxCannotTake({ range: "7d", dev: "phone", players: "new" })).toEqual([]);
		expect(filtersRobloxCannotTake({ range: "7d", branch: "dev", art: "a1", exp: "onb", variant: "short" })).toEqual(["branch", "artifact", "experiment variant"]);
		expect(filtersRobloxCannotTake({ range: "7d", country: "US", lang: "en", age: "<1d", prem: "true", source: "direct" })).toEqual(["language", "account age", "Premium", "join source"]);
		expect(windowLabel({ from: "2026-10-18T00:00:00.000Z", to: "2026-11-15T00:00:00.000Z", days: 28 })).toBe("2026-10-18 - 2026-11-14 (28 days, UTC)");
		expect(windowLabel({ from: "2026-11-14T00:00:00.000Z", to: "2026-11-15T00:00:00.000Z", days: 1 })).toBe("2026-11-14 (UTC)");
	});
});
