// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataTable } from "@/components/data-table";
import { reasonLines, reasonText } from "@/components/HealthReasons";
import type { FleetServer, FleetServers, HealthReason } from "@/lib/types";
import { budgetPressure, budgetText, ByCountry, countriesText, memoryHigh, SERVER_COLUMNS, serverColumns, tpsLow, tpsText } from "./Fleet";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const server = (job: string, over: Partial<FleetServer> = {}): FleetServer => ({
	job,
	serverType: "public",
	branch: "prod",
	artifact: "a1",
	players: 10,
	maxPlayers: 60,
	startedAt: "2026-10-09T08:00:00Z",
	lastSeen: "2026-10-09T11:59:00Z",
	appliedSeq: 5,
	generation: 1,
	health: "ok",
	lastError: null,
	kernel: "0.4.2",
	experiment: false,
	...over,
});

// Kernel 0.4.2 rows carry tps / tpsMin / physFps / memMb / luaMb; job-c is an older kernel (none of them).
const servers = [
	server("job-a", { players: 47, health: "ok", tps: 59.8, tpsMin: 52, physFps: 60, memMb: 812, luaMb: 140.5, budget: { ds: { r: 30, lr: 60 }, h: { r: 10, l: 500 } }, lastSeen: "2026-10-09T11:59:30Z" }),
	server("job-b", { players: 5, health: "failing", tps: 12, tpsMin: 3.5, physFps: 20, memMb: 95, luaMb: 30, budget: { ds: { r: 59, lr: 60 } }, lastSeen: "2026-10-09T09:00:00Z" }),
	server("job-c", { players: 110, maxPlayers: 120, health: "degraded", kernel: "0.4.0", lastSeen: "2026-10-08T12:00:00Z" }),
	server("job-d", { players: 9, health: "ok", tps: 30.5, tpsMin: 55, physFps: 59, memMb: 3203, luaMb: null, budget: { h: { r: 400, l: 500 } }, lastSeen: "2026-10-09T11:00:00Z" }),
];

function mount(rows: FleetServer[] = servers) {
	return render(
		<MemoryRouter>
			<DataTable<FleetServer> id="fleet-servers" columns={SERVER_COLUMNS} data={rows} rowId={(s) => s.job} />
		</MemoryRouter>,
	);
}

/** The Job cell of each body row (the id is shortened, so job-a stays job-a). */
const jobs = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")?.textContent ?? "");
/** The text of one column's cells, top to bottom. */
const cells = (header: string) => {
	const index = Array.from(document.querySelectorAll("thead th")).findIndex((th) => th.textContent?.startsWith(header));
	return Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[index]?.textContent ?? "");
};
const sortBy = (name: string, options?: { shiftKey?: boolean }) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }), options);

describe("the fleet servers table", () => {
	it("shows players as '47 / 60' but sorts them by the number", () => {
		mount();
		expect(screen.getByText("47 / 60")).toBeTruthy();
		sortBy("Players");
		expect(jobs()).toEqual(["job-c", "job-a", "job-d", "job-b"]);
		sortBy("Players");
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
	});

	it("shows TPS as 'average / slowest second' and memory in MB, '–' for an older kernel", () => {
		mount();
		expect(cells("TPS")).toEqual(["59.8 / 52.0", "12.0 / 3.5(warning)", "–", "30.5 / 55.0(warning)"]);
		expect(cells("Memory")).toEqual(["812", "95", "–", "3,203(warning)"]);
		expect(tpsText(servers[0])).toBe("59.8 / 52.0");
		expect(tpsText(servers[2])).toBe("–");
		expect(tpsText(server("x", { tps: 60 }))).toBe("60.0");
	});

	it("sorts TPS by the average, slowest first, and memory by the number, biggest first; rows without a value last", () => {
		mount();
		sortBy("TPS");
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
		sortBy("TPS");
		expect(jobs()).toEqual(["job-a", "job-d", "job-b", "job-c"]);
		sortBy("TPS"); // off
		sortBy("Memory");
		expect(jobs()).toEqual(["job-d", "job-a", "job-b", "job-c"]);
		sortBy("Memory");
		expect(jobs()).toEqual(["job-b", "job-a", "job-d", "job-c"]);
	});

	it("warns under 50 TPS and over 3,000 MB, never for an unknown reading", () => {
		expect(tpsLow(49.9)).toBe(true);
		expect(tpsLow(50)).toBe(false);
		expect(tpsLow(null)).toBe(false);
		expect(tpsLow(undefined)).toBe(false);
		expect(memoryHigh(3001)).toBe(true);
		expect(memoryHigh(3000)).toBe(false);
		expect(memoryHigh(null)).toBe(false);
		mount();
		// The tooltip says why (colour never carries the meaning alone).
		expect(screen.getByTitle(/average 12\.0, slowest second 3\.5, physics 20 FPS \(under 50\)/)).toBeTruthy();
		expect(screen.getByTitle(/Total 3,203 MB, Lua heap \? \(over 3,000 MB\)/)).toBeTruthy();
		expect(screen.getByTitle(/Total 812 MB, Lua heap 140\.5 MB$/)).toBeTruthy();
	});

	it("the Health badge of a server with reasons opens them; a healthy one is plain text", async () => {
		const reasons: HealthReason[] = [
			{ signal: "health", label: "Kernel health", value: "degraded", threshold: "ok", unit: null, op: "!=" },
			{ signal: "memory", label: "Memory", value: 3400, threshold: 3000, unit: "MB", op: ">" },
		];
		mount([server("job-a"), server("job-c", { health: "degraded", lastError: "boom", reasons })]);
		expect(screen.queryByRole("button", { name: /^ok:/ })).toBeNull();
		const badge = screen.getByRole("button", { name: "degraded: 3 reasons, show why" });
		expect(badge.getAttribute("title")).toBe(["Kernel health degraded", "Memory 3,400 MB, over 3,000 MB", "Last error: boom"].join("\n"));
		fireEvent.click(badge);
		expect(await screen.findByText("Memory 3,400 MB, over 3,000 MB")).toBeTruthy();
		expect(screen.getByText("Last error: boom")).toBeTruthy();
	});

	it("words each signal plainly with its reading and line", () => {
		expect(reasonText({ signal: "tps", label: "TPS", value: 31.2, threshold: 50, unit: "TPS", op: "<" })).toBe("TPS 31.2, under 50");
		expect(reasonText({ signal: "memory", label: "Memory", value: 3001, threshold: 3000, unit: "MB", op: ">" })).toBe("Memory 3,001 MB, over 3,000 MB");
		expect(reasonText({ signal: "heartbeat", label: "Heartbeat age", value: 80, threshold: 75, unit: "s", op: ">" })).toBe("Last heartbeat 80 s ago, over 75 s");
		expect(reasonText({ signal: "health", label: "Kernel health", value: "failed", threshold: "ok", unit: null, op: "!=" })).toBe("Kernel health failed");
		// The last error only explains the kernel's health; a healthy row has no lines.
		expect(reasonLines({ reasons: [{ signal: "tps", label: "TPS", value: 40, threshold: 50, unit: "TPS", op: "<" }], lastError: "old" })).toEqual(["TPS 40, under 50"]);
		expect(reasonLines({ reasons: [], lastError: null })).toEqual([]);
		expect(reasonLines({ lastError: null })).toEqual([]);
	});

	it("puts the worst health first on the first click, and sorts 'Seen' by the heartbeat time", () => {
		mount();
		sortBy("Health");
		expect(jobs()[0]).toBe("job-b");
		expect(jobs()[1]).toBe("job-c");
		sortBy("Health"); // asc
		sortBy("Health"); // off
		sortBy("Seen");
		expect(jobs()).toEqual(["job-a", "job-d", "job-b", "job-c"]);
	});

	it("sorts the budget by the share of the tightest limit in use; memory is not repeated in its text", () => {
		expect(budgetPressure(null)).toBeNull();
		expect(budgetPressure({ ds: { r: 30, lr: 60 }, h: { r: 10, l: 500 } })).toBe(0.5);
		expect(budgetPressure({ h: { r: 400, l: 500 } })).toBe(0.8);
		expect(budgetPressure({ mem: { t: 400 } })).toBeNull();
		expect(budgetText({ ds: { r: 30, lr: 60 }, mem: { t: 812 } })).toBe("DS 30/60");
		mount();
		sortBy("Budget");
		// job-b 59/60, job-d 400/500, job-a 30/60; job-c has no budget.
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
	});

	it("has the extra columns in the picker (channel, TPS min, physics, Lua heap...), hidden until turned on", () => {
		mount();
		expect(screen.queryByRole("columnheader", { name: /Channel/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Last error/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /TPS min/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Physics/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Lua heap/ })).toBeNull();
		expect(screen.getByRole("columnheader", { name: /Health/ })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: /^TPS/ })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: /Memory/ })).toBeTruthy();
	});
});

describe("server locations", () => {
	const US = { country: "US", countryName: "United States", region: "Virginia", city: "Sterling", lat: 39, lon: -77, asn: 22697, org: "Roblox" };
	const DE = { country: "DE", countryName: "Germany", region: "Hesse", city: "Frankfurt am Main", lat: 50, lon: 8, asn: null, org: null };
	const located = [
		server("job-a", { location: US, ip: "192.0.2.7", firstIp: "192.0.2.7" }),
		server("job-b", { location: DE, ip: "198.51.100.1", firstIp: "192.0.2.9", ipChangedAt: "2026-10-09T11:00:00Z" }),
		server("job-c", { location: null, ip: null }),
		server("job-d", { location: US, ip: "192.0.2.8" }),
	];

	it("shows the country chip and the place, and sorts by the country code (unknown last)", () => {
		mount(located);
		expect(cells("Country")).toEqual(["USSterling, Virginia", "DEFrankfurt am Main, Hesse", "–", "USSterling, Virginia"]);
		sortBy("Country");
		expect(jobs()).toEqual(["job-b", "job-a", "job-d", "job-c"]);
	});

	it("owners get an IP column (a moved server says so); the read-only role's columns have none", () => {
		mount(located);
		expect(cells("IP")).toEqual(["192.0.2.7", "198.51.100.1 (moved)", "–", "192.0.2.8"]);
		expect(serverColumns(false).some((c) => c.id === "ip")).toBe(true);
		expect(serverColumns(true).some((c) => c.id === "ip")).toBe(false);
		expect(serverColumns(true).some((c) => c.id === "country")).toBe(true);
	});

	it("the Countries metric and the By country table group the live list, with the DB-IP credit", () => {
		expect(countriesText(located)).toBe("US (2), DE (1)");
		expect(countriesText([server("x", { location: null })])).toBe("unknown");
		const data: FleetServers = {
			servers: located,
			players: 0,
			byArtifact: [],
			byHealth: {},
			geo: { state: "ready", source: "DB-IP City Lite", attribution: "IP geolocation by DB-IP", attributionUrl: "https://db-ip.com", built: null },
		};
		render(
			<MemoryRouter>
				<ByCountry data={data} />
			</MemoryRouter>,
		);
		expect(screen.getByText("By country")).toBeTruthy();
		expect(screen.getByText("United States")).toBeTruthy();
		expect(screen.getByRole("link", { name: "IP geolocation by DB-IP" })).toBeTruthy();
		cleanup();
		const { container } = render(
			<MemoryRouter>
				<ByCountry data={{ ...data, servers: [server("x", { location: null })] }} />
			</MemoryRouter>,
		);
		expect(container.textContent).toBe("");
	});
});
