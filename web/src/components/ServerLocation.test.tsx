// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetServer, ServerLocation } from "@/lib/types";
import { countryCounts, GeoCredit, LocationLabel, locationText, locationTitle, networkText, placeText } from "./ServerLocation";

afterEach(cleanup);

const loc = (over: Partial<ServerLocation> = {}): ServerLocation => ({ country: "US", countryName: "United States", region: "Virginia", city: "Sterling", lat: 39.0067, lon: -77.4291, asn: 22697, org: "Roblox", ...over });
const server = (job: string, location: ServerLocation | null, players = 1) => ({ job, players, location }) as FleetServer;

describe("location text", () => {
	it("says the place, then the country; a country alone by its name; unknown as a dash", () => {
		expect(locationText(loc())).toBe("Sterling, Virginia, US");
		expect(placeText(loc({ city: "Singapore", region: "Singapore", country: "SG" }))).toBe("Singapore");
		expect(locationText(loc({ city: null, region: null, country: "JP", countryName: "Japan" }))).toBe("Japan");
		expect(locationText(null)).toBe("–");
		expect(networkText(loc())).toBe("AS22697 Roblox");
		expect(networkText(loc({ asn: null, org: null }))).toBeNull();
		expect(locationTitle(loc())).toBe("Sterling, Virginia, United States | about 39.01, -77.43 | network AS22697 Roblox");
	});

	it("shows the country as a code chip (no flag emoji) with its name for screen readers", () => {
		render(<LocationLabel location={loc()} />);
		expect(screen.getByLabelText("United States (US)").textContent).toBe("US");
		expect(screen.getByText("Sterling, Virginia")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/\p{Regional_Indicator}/u);
	});
});

describe("the credit line", () => {
	it("credits DB-IP with a link when its database is in use, and nothing otherwise", () => {
		const { rerender, container } = render(<GeoCredit geo={{ state: "ready", source: "DB-IP City Lite", attribution: "IP geolocation by DB-IP", attributionUrl: "https://db-ip.com", built: null }} />);
		expect(screen.getByRole("link", { name: "IP geolocation by DB-IP" }).getAttribute("href")).toBe("https://db-ip.com");
		expect(container.textContent).toContain("CC BY 4.0");
		rerender(<GeoCredit geo={{ state: "ready", source: "GeoLite2-City", attribution: null, attributionUrl: null, built: null }} />);
		expect(container.textContent).toBe("");
		rerender(<GeoCredit geo={{ state: "missing", source: null, attribution: null, attributionUrl: null, built: null }} />);
		expect(container.textContent).toBe("");
	});
});

describe("servers by country", () => {
	it("counts servers and players per country, most servers first, with their places; unknown ones as ??", () => {
		const rows = countryCounts([
			server("a", loc(), 10),
			server("b", loc({ city: "Ashburn" }), 5),
			server("c", loc(), 1),
			server("d", loc({ country: "DE", countryName: "Germany", city: "Frankfurt am Main", region: "Hesse" }), 7),
			server("e", null, 2),
		]);
		expect(rows.map((r) => [r.country, r.servers, r.players])).toEqual([
			["US", 3, 16],
			["??", 1, 2],
			["DE", 1, 7],
		]);
		expect(rows[0].places).toEqual(["Sterling, Virginia", "Ashburn, Virginia"]);
		expect(rows[1].countryName).toBe("Unknown");
	});
});
