// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetServer, ServerLocation } from "@/lib/types";
import { countryCounts, GeoCredit, hasLocation, isIpEstimate, LocationLabel, locationText, locationTitle, networkText, placeText } from "./ServerLocation";

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
		expect(locationTitle(loc())).toBe("estimated from the server's IP address | Sterling, Virginia, United States | about 39.01, -77.43 | network AS22697 Roblox");
	});

	it("shows the country as a code chip (no flag emoji) with its name for screen readers", () => {
		render(<LocationLabel location={loc()} />);
		expect(screen.getByLabelText("United States (US)").textContent).toBe("US");
		expect(screen.getByText("Sterling, Virginia")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/\p{Regional_Indicator}/u);
	});
});

describe("the Roblox region", () => {
	const ashburn = loc({ city: "Ashburn", lat: 39.04, lon: -77.49 });

	it("leads with the airport code, then the city and country; an unknown code alone", () => {
		expect(locationText(ashburn, "IAD")).toBe("IAD · Ashburn, US");
		expect(locationText(null, "QQQ")).toBe("QQQ");
		expect(locationText(loc({ city: null, country: null, countryName: null, region: null, lat: null, lon: null }), "QQQ")).toBe("QQQ");
		expect(locationTitle(ashburn, "IAD")).toMatch(/^Roblox server region IAD \| Ashburn, Virginia, United States/);
		expect(locationTitle(null, "QQQ")).toContain("QQQ");
	});

	it("shows the code with a quiet Roblox note, and an IP estimate with its own note", () => {
		const { rerender, container } = render(<LocationLabel location={ashburn} region="IAD" geoSource="roblox" />);
		expect(screen.getByText("IAD")).toBeTruthy();
		expect(screen.getByText("Ashburn")).toBeTruthy();
		expect(screen.getByText("Roblox")).toBeTruthy();
		expect(container.textContent).not.toContain("IP est.");
		rerender(<LocationLabel location={loc()} geoSource="ip" />);
		expect(screen.getByText("IP est.")).toBeTruthy();
		expect(screen.getByText("Sterling, Virginia")).toBeTruthy();
		rerender(<LocationLabel location={null} region="QQQ" geoSource="roblox" />);
		expect(container.textContent).toBe("QQQRoblox");
		rerender(<LocationLabel location={null} />);
		expect(container.textContent).toBe("unknown");
	});

	it("credits the IP database only for IP estimates (older backends send no geoSource: an estimate)", () => {
		expect(isIpEstimate({ location: ashburn, region: "IAD", geoSource: "roblox" })).toBe(false);
		expect(isIpEstimate({ location: loc(), geoSource: "ip" })).toBe(true);
		expect(isIpEstimate({ location: loc() })).toBe(true);
		expect(isIpEstimate({ location: null })).toBe(false);
		expect(hasLocation({ location: null, region: "QQQ" })).toBe(true);
		expect(hasLocation({ location: null, region: null })).toBe(false);
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
