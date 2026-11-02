// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataColumn } from "./index";
import { STORAGE_PREFIX } from "./model";

interface Server {
	job: string;
	branch: string;
	health: "ok" | "degraded" | "failing";
	players: number;
	max: number;
	/** Shown as "812 MB". */
	memoryMb: number | null;
	/** Shown as "59.8". */
	tps: number | null;
	seen: string;
}

const servers: Server[] = [
	{ job: "job-10", branch: "dev", health: "ok", players: 47, max: 60, memoryMb: 812, tps: 59.8, seen: "2026-10-09T11:59:30Z" },
	{ job: "job-2", branch: "prod", health: "failing", players: 5, max: 60, memoryMb: 95, tps: 12, seen: "2026-10-09T09:00:00Z" },
	{ job: "job-1", branch: "prod", health: "degraded", players: 110, max: 120, memoryMb: null, tps: null, seen: "2026-10-08T12:00:00Z" },
	{ job: "job-3", branch: "prod", health: "ok", players: 9, max: 60, memoryMb: 1203, tps: 30.5, seen: "2026-10-09T11:00:00Z" },
];

const columns: DataColumn<Server>[] = [
	{ id: "job", header: "Job", accessor: (s) => s.job },
	{ id: "branch", header: "Branch", type: "enum", accessor: (s) => s.branch },
	{ id: "health", header: "Health", type: "enum", order: ["ok", "degraded", "failing"], accessor: (s) => s.health },
	{ id: "players", header: "Players", accessor: (s) => s.players, cell: (s) => `${s.players} / ${s.max}` },
	{ id: "memory", header: "Memory", accessor: (s) => s.memoryMb, cell: (s) => (s.memoryMb === null ? "–" : `${s.memoryMb} MB`), format: (v) => (v === null ? "" : `${v} MB`) },
	{ id: "tps", header: "TPS", accessor: (s) => s.tps },
	{ id: "seen", header: "Seen", type: "date", accessor: (s) => s.seen, cell: () => "recently" },
	{ id: "channel", header: "Channel", defaultHidden: true, accessor: () => "live" },
];

beforeAll(() => {
	// Radix menus and popovers measure their anchor.
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function Probe() {
	return <div data-testid="search">{useLocation().search}</div>;
}

function mount(props: Partial<React.ComponentProps<typeof DataTable<Server>>> = {}, entry = "/fleet") {
	return render(
		<MemoryRouter initialEntries={[entry]}>
			<DataTable<Server> id="servers" label="Servers" columns={columns} data={servers} {...props} />
			<Probe />
		</MemoryRouter>,
	);
}

/** The first cell of each body row, in order. */
const jobs = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")?.textContent ?? "");

const header = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const columnHeader = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });
const openMenu = (name: string) => {
	const trigger = screen.getByRole("button", { name });
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
};

describe("DataTable layout", () => {
	it("keeps the header row sticky and the table scrollable inside its own region", () => {
		mount();
		for (const th of Array.from(document.querySelectorAll("thead th"))) {
			// `relative` would win over `sticky` when the classes are merged.
			expect(th.classList.contains("sticky")).toBe(true);
			expect(th.classList.contains("relative")).toBe(false);
		}
		const region = screen.getByRole("region", { name: "Servers, scrollable" });
		expect(region.className).toContain("overflow-auto");
		expect(region.getAttribute("tabindex")).toBe("0");
	});
});

describe("DataTable sorting", () => {
	it("starts in the order of the data and counts the rows", () => {
		mount();
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
		expect(screen.getByRole("status").textContent).toBe("4 rows");
	});

	it("sorts a column shown as '47 / 60' by the number: biggest first, then smallest first, then off", () => {
		mount();
		fireEvent.click(header("Players"));
		expect(jobs()).toEqual(["job-1", "job-10", "job-3", "job-2"]);
		expect(columnHeader("Players").getAttribute("aria-sort")).toBe("descending");
		fireEvent.click(header("Players"));
		expect(jobs()).toEqual(["job-2", "job-3", "job-10", "job-1"]);
		expect(columnHeader("Players").getAttribute("aria-sort")).toBe("ascending");
		fireEvent.click(header("Players"));
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
		expect(columnHeader("Players").getAttribute("aria-sort")).toBe("none");
	});

	it("sorts memory shown in MB and TPS by their numbers, rows without a value last in both directions", () => {
		mount();
		fireEvent.click(header("Memory"));
		expect(jobs()).toEqual(["job-3", "job-10", "job-2", "job-1"]);
		fireEvent.click(header("Memory"));
		expect(jobs()).toEqual(["job-2", "job-10", "job-3", "job-1"]);
		fireEvent.click(header("TPS"));
		expect(jobs()).toEqual(["job-10", "job-3", "job-2", "job-1"]);
	});

	it("sorts dates by the timestamp and text naturally", () => {
		mount();
		fireEvent.click(header("Seen"));
		expect(jobs()).toEqual(["job-10", "job-3", "job-2", "job-1"]);
		fireEvent.click(header("Job"));
		expect(jobs()).toEqual(["job-1", "job-2", "job-3", "job-10"]);
	});

	it("shift-click adds a second sort", () => {
		mount();
		fireEvent.click(header("Branch"));
		fireEvent.click(header("Players"), { shiftKey: true });
		// Branch ascending (dev, prod...), then players biggest first inside prod.
		expect(jobs()).toEqual(["job-10", "job-1", "job-3", "job-2"]);
		expect(columnHeader("Branch").textContent).toContain("1");
		expect(columnHeader("Players").textContent).toContain("2");
	});

	it("starts from defaultSort, and removing it brings the data's own order back", () => {
		mount({ defaultSort: [{ id: "players", desc: true }] });
		expect(jobs()).toEqual(["job-1", "job-10", "job-3", "job-2"]);
		fireEvent.click(header("Players")); // desc -> asc
		fireEvent.click(header("Players")); // asc -> off
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
	});
});

describe("DataTable search and filters", () => {
	it("hides small tables' search until there are more than 5 rows, but never the Columns picker", () => {
		mount();
		expect(screen.queryByRole("searchbox")).toBeNull();
		expect(screen.getByRole("button", { name: "Columns" })).toBeTruthy();
		cleanup();
		mount({ search: true });
		expect(screen.getByRole("searchbox")).toBeTruthy();
	});

	it("filters over the visible columns and says '2 of 4 rows'", async () => {
		mount({ search: true });
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "failing" } });
		await waitFor(() => expect(jobs()).toEqual(["job-2"]));
		expect(screen.getByRole("status").textContent).toBe("1 of 4 rows");
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "812 mb" } });
		await waitFor(() => expect(jobs()).toEqual(["job-10"]));
		// The Channel column is hidden, so its text doesn't match.
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "live" } });
		await waitFor(() => expect(jobs()).toEqual(["No rows match. Clear filters"]));
	});

	it("filters by a checklist on an enum column and shows a chip that removes it", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Filter Health" }));
		fireEvent.click(await screen.findByRole("checkbox", { name: /^ok/ }));
		await waitFor(() => expect(jobs()).toEqual(["job-10", "job-3"]));
		expect(screen.getByRole("status").textContent).toBe("2 of 4 rows");
		const chip = screen.getByRole("button", { name: "Remove filter Health: ok" });
		fireEvent.click(chip);
		await waitFor(() => expect(jobs()).toHaveLength(4));
	});

	it("filters a number column by a range of its numbers", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Filter Memory" }));
		fireEvent.change(await screen.findByRole("spinbutton", { name: "Min" }), { target: { value: "100" } });
		await waitFor(() => expect(jobs()).toEqual(["job-10", "job-3"]));
		fireEvent.change(screen.getByRole("spinbutton", { name: "Max" }), { target: { value: "900" } });
		await waitFor(() => expect(jobs()).toEqual(["job-10"]));
		expect(screen.getByRole("button", { name: /Remove filter Memory: 100 to 900/ })).toBeTruthy();
	});
});

describe("DataTable columns", () => {
	it("hides a column from the Columns picker, resets, and keeps the last visible column", async () => {
		mount();
		expect(screen.queryByRole("columnheader", { name: /Channel/ })).toBeNull();
		openMenu("Columns");
		// The open menu hides the page from the accessibility tree, hence `hidden`.
		const head = (name: RegExp) => screen.queryByRole("columnheader", { name, hidden: true });
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Channel" }));
		expect(head(/Channel/)).toBeTruthy();
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "TPS" }));
		expect(head(/TPS/)).toBeNull();
		fireEvent.click(screen.getByRole("menuitem", { name: /Reset columns/ }));
		expect(head(/TPS/)).toBeTruthy();
		expect(head(/Channel/)).toBeNull();
	});

	it("stops sorting by a column that Reset columns hides again", async () => {
		const byNumber = { id: "number", header: "Number", defaultHidden: true, accessor: (s: Server) => Number(s.job.split("-")[1]) };
		mount({ columns: [...columns.slice(0, 3), byNumber] });
		openMenu("Columns");
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Number" }));
		fireEvent.click(screen.getByRole("button", { name: /^Number/, hidden: true }));
		expect(jobs()).toEqual(["job-10", "job-3", "job-2", "job-1"]);
		fireEvent.click(screen.getByRole("menuitem", { name: /Reset columns/ }));
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
	});

	it("stops sorting by a column that is hidden", async () => {
		mount();
		fireEvent.click(header("Players"));
		expect(jobs()[0]).toBe("job-1");
		openMenu("Columns");
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Players" }));
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
	});
});

describe("DataTable remembers the view", () => {
	it("saves sort, filters and hidden columns per table id, and restores them on the next visit", async () => {
		const first = mount();
		fireEvent.click(header("Players"));
		openMenu("Columns");
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "TPS" }));
		await waitFor(() => expect(localStorage.getItem(`${STORAGE_PREFIX}servers`)).toBeTruthy());
		const saved = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}servers`) as string);
		expect(saved.sort).toEqual([{ id: "players", desc: true }]);
		expect(saved.columns).toEqual({ tps: false });
		first.unmount();
		mount();
		expect(jobs()).toEqual(["job-1", "job-10", "job-3", "job-2"]);
		expect(screen.queryByRole("columnheader", { name: /TPS/ })).toBeNull();
		cleanup();
		// Another table id starts clean.
		mount({ id: "other" });
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
	});

	it("works when localStorage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		mount();
		fireEvent.click(header("Players"));
		expect(jobs()[0]).toBe("job-1");
	});

	it("writes the view to the URL and reads it back from a shared link, which wins over the saved view", async () => {
		mount();
		fireEvent.click(header("Players"));
		await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?servers.sort=-players"));
		cleanup();
		localStorage.setItem(`${STORAGE_PREFIX}servers`, JSON.stringify({ sort: [{ id: "job", desc: false }] }));
		mount({}, "/fleet?servers.sort=-memory&servers.f.health=set:ok&servers.cols=-tps");
		expect(jobs()).toEqual(["job-3", "job-10"]);
		expect(screen.queryByRole("columnheader", { name: /TPS/ })).toBeNull();
		expect(screen.getByRole("button", { name: "Remove filter Health: ok" })).toBeTruthy();
	});

	it("leaves the URL alone with urlSync off, and keeps other query parameters", async () => {
		mount({ urlSync: false });
		fireEvent.click(header("Players"));
		await new Promise((r) => setTimeout(r, 400));
		expect(screen.getByTestId("search").textContent).toBe("");
		cleanup();
		localStorage.clear();
		mount({}, "/fleet?range=7d");
		fireEvent.click(header("Players"));
		await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?range=7d&servers.sort=-players"));
	});

	it("puts a view restored from localStorage into the URL, so the address shows what is on screen", async () => {
		localStorage.setItem(`${STORAGE_PREFIX}servers`, JSON.stringify({ sort: [{ id: "players", desc: true }], filters: { health: { kind: "set", values: ["ok"] } } }));
		mount();
		expect(jobs()).toEqual(["job-10", "job-3"]);
		await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?servers.sort=-players&servers.f.health=set%3Aok"));
	});

	it("keeps every table's parameters when several tables restore their views at once", async () => {
		localStorage.setItem(`${STORAGE_PREFIX}first`, JSON.stringify({ sort: [{ id: "job", desc: true }] }));
		localStorage.setItem(`${STORAGE_PREFIX}second`, JSON.stringify({ sort: [{ id: "players", desc: false }] }));
		render(
			<MemoryRouter initialEntries={["/fleet?range=7d"]}>
				<DataTable<Server> id="first" columns={columns} data={servers} />
				<DataTable<Server> id="second" columns={columns} data={servers} />
				<Probe />
			</MemoryRouter>,
		);
		await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?range=7d&first.sort=-job&second.sort=players"));
	});

	it("does not write to the URL when the table is left right after a change", async () => {
		const view = mount();
		fireEvent.click(header("Players"));
		view.unmount();
		// Saved for next time, but no late navigation.
		expect(localStorage.getItem(`${STORAGE_PREFIX}servers`)).toBeTruthy();
	});
});

describe("DataTable states", () => {
	it("shows the empty text instead of a table with no data", () => {
		mount({ data: [], empty: <p>No live servers.</p> });
		expect(screen.getByText("No live servers.")).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("shows skeleton rows while loading, under the real header", () => {
		mount({ loading: true });
		expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
		expect(screen.getByRole("columnheader", { name: /Job/ })).toBeTruthy();
		expect(document.querySelectorAll("tbody [data-slot=skeleton]").length).toBeGreaterThan(0);
		expect(screen.getByRole("status").textContent).toBe("Loading");
	});

	it("pages large tables and keeps the page when rows change under it", () => {
		const many: Server[] = Array.from({ length: 120 }, (_, i) => ({ ...servers[0]!, job: `job-${i}`, players: i }));
		mount({ data: many, pageSize: 25 });
		expect(jobs()).toHaveLength(25);
		expect(screen.getByText("Page 1 of 5")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(jobs()[0]).toBe("job-25");
		expect(screen.getByText("26 to 50 of 120")).toBeTruthy();
		// Sorting goes back to page one.
		fireEvent.click(header("Players"));
		expect(jobs()[0]).toBe("job-119");
		expect(screen.getByText("Page 1 of 5")).toBeTruthy();
	});

	it("shows pinned rows first and leaves them out of sorting, filtering and the count", async () => {
		mount({ pinnedRows: [{ ...servers[0]!, job: "Average" }], search: true });
		expect(jobs()[0]).toBe("Average");
		fireEvent.click(header("Players"));
		expect(jobs()[0]).toBe("Average");
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("0 of 4 rows"));
		expect(jobs()[0]).toBe("Average");
	});

	it("makes rows clickable by mouse and keyboard, except on links and buttons inside them", () => {
		const open = vi.fn();
		mount({ onRowClick: open, columns: [{ id: "job", header: "Job", accessor: (s: Server) => s.job, cell: (s: Server) => <a href="#x">{s.job}</a> }] });
		const row = document.querySelectorAll("tbody tr")[1] as HTMLElement;
		fireEvent.click(within(row).getByRole("link"));
		expect(open).not.toHaveBeenCalled();
		fireEvent.click(row);
		fireEvent.keyDown(row, { key: "Enter" });
		expect(open).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenCalledWith(servers[1]);
	});
});

describe("DataTable copy and export", () => {
	it("downloads the filtered and sorted view as CSV with the underlying values and the visible columns", async () => {
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((blob: Blob) => {
			blobs.push(blob);
			return "blob:test";
		});
		URL.revokeObjectURL = vi.fn();
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		mount({ search: true, defaultSort: [{ id: "players", desc: true }] });
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "prod" } });
		await waitFor(() => expect(jobs()).toEqual(["job-1", "job-3", "job-2"]));
		openMenu("Export and view options");
		fireEvent.click(await screen.findByRole("menuitem", { name: /Download CSV \(3 rows\)/ }));
		expect(blobs).toHaveLength(1);
		const text = await new Promise<string>((done) => {
			const reader = new FileReader();
			reader.onload = () => done(String(reader.result));
			reader.readAsText(blobs[0] as Blob);
		});
		expect(text.replace("\uFEFF", "")).toBe(
			["Job,Branch,Health,Players,Memory,TPS,Seen", "job-1,prod,degraded,110,,,2026-10-08T12:00:00.000Z", "job-3,prod,ok,9,1203,30.5,2026-10-09T11:00:00.000Z", "job-2,prod,failing,5,95,12,2026-10-09T09:00:00.000Z"].join("\r\n"),
		);
	});

	it("copies a row as JSON and a cell's value", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		mount();
		const row = document.querySelectorAll("tbody tr")[0] as HTMLElement;
		fireEvent.keyDown(within(row).getByRole("button", { name: "Row actions" }), { key: "ArrowDown" });
		fireEvent.click(await screen.findByRole("menuitem", { name: "Copy row as JSON" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(servers[0], null, 2)));
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied row"));
		fireEvent.keyDown(within(row).getByRole("button", { name: "Row actions" }), { key: "ArrowDown" });
		fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Copy cell" }), { key: "ArrowRight" });
		fireEvent.click(await screen.findByRole("menuitem", { name: /Memory/ }));
		await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("812"));
		await act(async () => {});
	});
});

describe("server sort", () => {
	it("asks the server for a header's order, keeps the rows as they came, and only sorts the columns it names", async () => {
		const onChange = vi.fn();
		render(
			<DataTable id="srv" label="Servers" columns={columns} data={servers} rowId={(s) => s.job} urlSync={false} persist={false} serverSort={{ columns: ["players", "job"], onChange }} />,
		);
		const t = screen.getByRole("table", { name: "Servers" });
		const jobs = () => [...t.querySelectorAll("tbody tr")].map((r) => r.querySelector("td")?.textContent);
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
		fireEvent.click(within(t).getByTitle(/^Sort by Players/));
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ id: "players", desc: true }));
		// Not re-sorted here: the server sends the next page in that order.
		expect(jobs()).toEqual(["job-10", "job-2", "job-1", "job-3"]);
		expect(within(t).getByRole("columnheader", { name: /Players/ }).getAttribute("aria-sort")).toBe("descending");
		expect(within(t).queryByTitle(/^Sort by TPS/)).toBeNull();
		// One column at a time.
		fireEvent.click(within(t).getByTitle(/^Sort by Job/), { shiftKey: true });
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ id: "job", desc: false }));
	});
});
