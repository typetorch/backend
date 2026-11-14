import { describe, expect, it } from "vitest";
import { activeFilterCount, audienceFilterCount, describeRange, readFilters, toApiFilters, windowBucketMs, writeFilters } from "./filters";

const NOW = Date.UTC(2026, 9, 5, 18, 0, 0);

describe("hour presets", () => {
	it("send an exact instant from the whole minute; read and written like the day presets", () => {
		const late = NOW + 42_123; // 18:00:42.123
		expect(toApiFilters({ range: "1h" }, late)).toEqual({ from: "2026-10-05T17:00:00.000Z" });
		expect(toApiFilters({ range: "6h", dev: "phone" }, late)).toEqual({ from: "2026-10-05T12:00:00.000Z", dev: "phone" });
		// Same minute, same filters (the query cache holds still).
		expect(toApiFilters({ range: "1h" }, late + 10_000)).toEqual(toApiFilters({ range: "1h" }, late));
		expect(readFilters(new URLSearchParams("range=6h&from=2026-10-01")).range).toBe("6h");
		expect(readFilters(new URLSearchParams("range=6h&from=2026-10-01")).from).toBeUndefined();
		expect(writeFilters({ range: "1h" }, new URLSearchParams()).toString()).toBe("range=1h");
		expect(describeRange({ range: "1h" })).toBe("the last 1 hour");
		expect(describeRange({ range: "6h" })).toBe("the last 6 hours");
	});

	it("chart steps by window: 1 h -> 1 min, 6 h -> 5 min, a day -> hourly, longer -> daily", () => {
		const H = 3_600_000;
		expect(windowBucketMs(H + 60_000)).toBe(60_000);
		expect(windowBucketMs(6 * H + 60_000)).toBe(300_000);
		expect(windowBucketMs(18 * H)).toBe(H);
		expect(windowBucketMs(24 * H)).toBe(H);
		expect(windowBucketMs(7 * 24 * H)).toBe(24 * H);
	});
});

describe("filters", () => {
	it("read from the URL, ignoring junk", () => {
		const s = readFilters(new URLSearchParams("range=7d&branch=dev&dev=fridge&players=new&exp=lobby_hint&variant=none&pid=abc"));
		expect(s).toEqual({ range: "7d", branch: "dev", players: "new", exp: "lobby_hint", variant: "none" });
		expect(readFilters(new URLSearchParams("range=nope&from=2026-01-01")).range).toBe("30d");
		expect(readFilters(new URLSearchParams("range=custom&from=2026-10-01&to=bad"))).toEqual({ range: "custom", from: "2026-10-01" });
	});

	it("written back keeping page parameters, defaults left out", () => {
		const next = writeFilters({ range: "30d", dev: "phone" }, new URLSearchParams("pid=abc&branch=old"));
		expect(next.toString()).toBe("pid=abc&dev=phone");
		expect(readFilters(writeFilters({ range: "custom", from: "2026-09-01", to: "2026-09-30", art: "a1" }, new URLSearchParams()))).toEqual({
			range: "custom",
			from: "2026-09-01",
			to: "2026-09-30",
			art: "a1",
		});
	});

	it("become the server's filters (UTC days; presets include today)", () => {
		expect(toApiFilters({ range: "7d" }, NOW)).toEqual({ from: "2026-09-29" });
		expect(toApiFilters({ range: "1d" }, NOW)).toEqual({ from: "2026-10-05" });
		expect(toApiFilters({ range: "custom", from: "2026-09-01", to: "2026-09-30", dev: "phone", players: "returning" }, NOW)).toEqual({
			from: "2026-09-01",
			to: "2026-09-30",
			dev: "phone",
			players: "returning",
		});
		expect(toApiFilters({ range: "30d", exp: "e" }, NOW)).toEqual({ from: "2026-09-06" });
		expect(toApiFilters({ range: "30d", exp: "e", variant: "b" }, NOW).variant).toEqual({ experiment: "e", variant: "b" });
		expect(activeFilterCount({ range: "7d", branch: "dev", exp: "e" })).toBe(1);
	});
});

describe("3 days and since the last prod deploy", () => {
	it("3 days is today and the 2 before", () => {
		expect(toApiFilters({ range: "3d" }, NOW)).toEqual({ from: "2026-10-03" });
		expect(readFilters(new URLSearchParams("range=3d")).range).toBe("3d");
		expect(describeRange({ range: "3d" })).toBe("last 3 days (UTC)");
	});

	it("deploy starts at the release's minute; today while it isn't known", () => {
		const since = Date.UTC(2026, 9, 4, 9, 30, 25);
		expect(toApiFilters({ range: "deploy", sinceMs: since, dev: "phone" }, NOW)).toEqual({ from: "2026-10-04T09:30:00.000Z", dev: "phone" });
		expect(toApiFilters({ range: "deploy" }, NOW)).toEqual({ from: "2026-10-05" });
		expect(readFilters(new URLSearchParams("range=deploy")).range).toBe("deploy");
		// The release time is looked up, never written to the URL.
		expect(writeFilters({ range: "deploy", sinceMs: since }, new URLSearchParams()).toString()).toBe("range=deploy");
		expect(describeRange({ range: "deploy", sinceMs: since })).toBe("since the last prod deploy (2026-10-04 09:30 UTC)");
	});
});

describe("audience filters", () => {
	it("read from the URL with the backend's checks, written back, and sent as the server's filters", () => {
		const s = readFilters(new URLSearchParams("country=us&lang=PT&age=1-3y&prem=true&source=teleport_game"));
		expect(s).toEqual({ range: "30d", country: "US", lang: "pt", age: "1-3y", prem: "true", source: "teleport_game" });
		// Junk is dropped here, not sent to be refused.
		expect(readFilters(new URLSearchParams("country=USA&lang=e1&age=2y&prem=yes&source=Bad%20One"))).toEqual({ range: "30d" });
		expect(readFilters(writeFilters(s, new URLSearchParams()))).toEqual(s);
		expect(writeFilters({ range: "30d", age: "<1d" }, new URLSearchParams("pid=abc")).toString()).toBe("pid=abc&age=%3C1d");
		expect(toApiFilters({ range: "7d", country: "BR", prem: "false", lang: "en", age: "3y+", source: "direct" }, NOW)).toEqual({
			from: "2026-09-29",
			country: "BR",
			prem: false,
			lang: "en",
			age: "3y+",
			source: "direct",
		});
		expect(activeFilterCount({ range: "7d", country: "US", prem: "true" })).toBe(2);
		expect(audienceFilterCount({ range: "7d", dev: "phone", source: "direct" })).toBe(1);
	});
});
