// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, experimentPlayerQuery } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AssignmentCheck, AuthInfo, ExperimentPlayers, ExperimentResult } from "@/lib/types";
import Experiments, { daysText, experimentRows, gameVariants, mdeText, SampleRatio, weightView } from "./Experiments";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const list: ExperimentResult = {
	experiment: null,
	experiments: [
		{ experiment: "onboarding", variant: "long", players: 3, forced: 2, variantCount: 2 },
		{ experiment: "onboarding", variant: "short", players: 4, forced: 0, variantCount: 2 },
		{ experiment: "shop.color", variant: "red", players: 1, forced: 0, variantCount: 3 },
	],
};
const results: ExperimentResult = {
	experiment: "onboarding",
	scope: "player",
	control: "short",
	variants: [
		{ variant: "long", players: 3, returned: { rate: 0.5, count: 1 }, payers: { rate: 0, count: 0 }, playtimeMinutes: 3, robuxPerPlayer: 0, sessionsPerPlayer: 1 },
		{ variant: "short", players: 4, returned: { rate: 0.25, count: 1 }, payers: { rate: 0, count: 0 }, playtimeMinutes: 2, robuxPerPlayer: 0, sessionsPerPlayer: 1 },
	],
	comparisons: [],
	mixedPlayers: 0,
};
const players: ExperimentPlayers = {
	experiment: "onboarding",
	variant: null,
	variants: [
		{ variant: "long", players: 3, forced: 2 },
		{ variant: "short", players: 4, forced: 0 },
	],
	total: 2,
	more: 0,
	players: [
		{ pid: "pid-aaaa", variant: "long", how: "forced", assignedAt: "2026-10-09T11:00:00.000Z", firstAt: "2026-10-09T11:00:00.000Z", lastAt: "2026-10-09T11:30:00.000Z", events: 4, mixed: false, uid: 4242, name: "Tester", displayName: "Test Player" },
		{ pid: "pid-bbbb", variant: "short", how: "unknown", assignedAt: null, firstAt: "2026-10-09T10:00:00.000Z", lastAt: "2026-10-09T10:10:00.000Z", events: 1, mixed: true },
	],
};

function mockApi() {
	const query = vi.spyOn(api, "query").mockImplementation(async (_name, _filters, options) => ((options as { experiment?: string }).experiment ? results : list) as never);
	const overrides = vi.spyOn(api, "experimentOverrides").mockResolvedValue({ source: "settings-file", experiments: { onboarding: { weights: [3, 1] } } });
	const who = vi.spyOn(api, "experimentPlayers").mockResolvedValue(players);
	return { query, overrides, who };
}

function PlayersStandIn() {
	const { search } = useLocation();
	return <div>Players page {search}</div>;
}

function mount(path = "/experiments", auth: AuthInfo | null = null) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<AuthProvider value={auth}>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route path="/experiments" element={<Experiments />} />
						<Route path="/players" element={<PlayersStandIn />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		</QueryClientProvider>,
	);
}

describe("Experiments page: players and weights", () => {
	it("lists experiments with state, weights and forced; a click opens their players, each linking to their page", async () => {
		const { who } = mockApi();
		mount("/experiments?range=7d");
		const table = await screen.findByRole("table", { name: "Experiments" });
		const row = (await within(table).findByText("onboarding")).closest("tr") as HTMLElement;
		expect(row.getAttribute("aria-label")).toBe("Open players in experiment onboarding");
		expect(row.getAttribute("tabindex")).toBe("0");
		await waitFor(() => expect(within(row).getByRole("img", { name: "variant 1 (control): 75%" })).toBeTruthy());
		expect(within(row).getByRole("img", { name: "variant 2: 25%" })).toBeTruthy();
		expect(within(row).getByText("running")).toBeTruthy();
		// No override for shop.color: the game's even split over its 3 variants, said plainly.
		const shop = within(table).getByText("shop.color").closest("tr") as HTMLElement;
		expect(within(shop).getByText(/No override on this server: the game's default weights apply/)).toBeTruthy();
		fireEvent.click(row);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Players in onboarding")).toBeTruthy();
		const people = await within(dialog).findByRole("table", { name: "Players in onboarding" });
		const link = within(people).getByRole("link", { name: "Test Player (@Tester)" });
		expect(link.getAttribute("href")).toBe("/players?range=7d&pid=pid-aaaa");
		expect(within(people).getByRole("link", { name: "pid-bbbb" }).getAttribute("href")).toBe("/players?range=7d&pid=pid-bbbb");
		expect(within(people).getByText("forced")).toBeTruthy();
		expect(within(people).getByText("before range")).toBeTruthy();
		expect(within(people).getByText("mixed")).toBeTruthy();
		expect(who).toHaveBeenCalledWith("onboarding", expect.objectContaining({ from: expect.any(String) }), {}, expect.anything());
		fireEvent.click(link);
		expect(await screen.findByText("Players page ?range=7d&pid=pid-aaaa")).toBeTruthy();
	});

	it("Enter on a variant row opens that variant; Space on an experiment row; the variant chips switch it", async () => {
		const { who } = mockApi();
		mount();
		const variants = await screen.findByRole("table", { name: "Variants" });
		const long = within(variants).getByText("long").closest("tr") as HTMLElement;
		expect(long.getAttribute("aria-label")).toBe("Open players in variant long of onboarding");
		fireEvent.keyDown(long, { key: "Enter" });
		await screen.findByRole("dialog");
		await waitFor(() => expect(who).toHaveBeenLastCalledWith("onboarding", expect.anything(), { variant: "long" }, expect.anything()));
		const dialog = screen.getByRole("dialog");
		fireEvent.click(await within(dialog).findByRole("radio", { name: /all/ }));
		await waitFor(() => expect(who).toHaveBeenLastCalledWith("onboarding", expect.anything(), {}, expect.anything()));
		cleanup();
		mount();
		const shop = (await within(await screen.findByRole("table", { name: "Experiments" })).findByText("shop.color")).closest("tr") as HTMLElement;
		fireEvent.keyDown(shop, { key: " " });
		expect(await screen.findByText("Players in shop.color")).toBeTruthy();
	});

	it("a shared link (?assigned=&assignedVariant=) opens the sheet with the page's filters", async () => {
		const { who } = mockApi();
		mount("/experiments?range=7d&branch=prod&assigned=onboarding&assignedVariant=short");
		expect(await screen.findByRole("dialog")).toBeTruthy();
		await waitFor(() => expect(who).toHaveBeenCalledWith("onboarding", expect.objectContaining({ branch: "prod" }), { variant: "short" }, expect.anything()));
	});
});

describe("weights", () => {
	it("the override's weights by position; an even split without one; stopped and settled", () => {
		expect(weightView({ weights: [3, 1] }, "settings-file", 2, ["long", "short"]).shares).toEqual([
			{ label: "variant 1 (control)", share: 0.75 },
			{ label: "variant 2", share: 0.25 },
		]);
		const none = weightView(undefined, "none", 2, ["short", "long"]);
		expect(none).toMatchObject({ state: "running", shares: [{ label: "long", share: 0.5 }, { label: "short", share: 0.5 }] });
		expect(none.note).toContain("default weights apply");
		expect(weightView(undefined, "none", 3, ["a"]).shares.map((s) => s.label)).toEqual(["variant 1 (control)", "variant 2", "variant 3"]);
		expect(weightView(undefined, "none", null, [])).toMatchObject({ shares: [] });
		expect(weightView(undefined, "none", null, []).note).toContain("doesn't know");
		expect(weightView(undefined, "unreadable", 2, []).note).toContain("can't be read");
		expect(weightView({ weights: [1, 1, 1] }, "settings-file", 2, []).note).toContain("don't fit");
		expect(weightView({ active: false }, "settings-file", 2, [])).toMatchObject({ state: "stopped", shares: [{ share: 1 }] });
		expect(weightView({ variant: "long", weights: [1, 1] }, "settings-file", 2, [])).toMatchObject({ state: "settled", settledOn: "long", shares: [{ label: "long", share: 1 }] });
	});

	it("experiment rows sum players and forced per experiment", () => {
		const rows = experimentRows(list.experiment === null ? list.experiments : []);
		expect(rows.map((r) => [r.experiment, r.players, r.forced, r.variantCount, r.variants.join("|")])).toEqual([
			["onboarding", 7, 2, 2, "long|short"],
			["shop.color", 1, 0, 3, "red"],
		]);
	});
});

describe("experimentPlayerQuery", () => {
	it("filters as repeated params, the variant filter as inExperiment + inVariant", () => {
		expect(experimentPlayerQuery({ from: "2026-10-01", branch: ["prod", "dev"], dev: "phone", variant: { experiment: "x", variant: ["a", "b"] } }, { variant: "long", limit: 50 })).toBe(
			"?from=2026-10-01&branch=prod&branch=dev&dev=phone&inExperiment=x&inVariant=a&inVariant=b&variant=long&limit=50",
		);
		expect(experimentPlayerQuery({})).toBe("");
	});
});

const check = (players: number[], mismatch: boolean, extra: Partial<AssignmentCheck> = {}): AssignmentCheck => ({
	variants: players.map((n, i) => ({ variant: ["short", "long", "mid"][i] as string, index: i + 1, players: n })),
	order: "game",
	variantCount: players.length,
	weights: players.map(() => 1),
	weightsFrom: "even",
	srm: { expected: players.map(() => players.reduce((s, n) => s + n, 0) / players.length), chi2: 1, df: players.length - 1, pValue: mismatch ? 0.00002 : 0.4, enough: true, mismatch },
	...extra,
});

describe("trustworthy results", () => {
	it("a sample ratio mismatch is a loud warning; a fair split one quiet line", () => {
		render(<SampleRatio check={check([100, 50], true, { note: "If the split changed in this range, pick a range after the change." })} />);
		const alert = screen.getByRole("alert");
		expect(within(alert).getByText("Sample ratio mismatch: don't trust these numbers")).toBeTruthy();
		expect(alert.textContent).toContain("short 100 (66.7%, should be 50%)");
		expect(alert.textContent).toContain("p = 2.0e-5");
		expect(alert.textContent).toContain("split changed");
		cleanup();
		render(<SampleRatio check={check([100, 98], false)} />);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByTestId("srm-line").textContent).toContain("players per variant fit an even split (p = 0.4)");
		cleanup();
		render(<SampleRatio check={{ ...check([10, 10], false), srm: null, note: "Uneven weights are in the game's variant order" }} />);
		expect(screen.getByTestId("srm-line").textContent).toContain("Uneven weights");
	});

	it("can detect and time to tell, in words", () => {
		const base = { variant: "long", metric: "returned" as const, control: 0.2, value: 0.25, diff: 0.05, lift: 0.25, sure: 0.9, method: "z", words: "" };
		expect(mdeText({ ...base, mde: 0.04, mdeLift: 0.2 })).toBe("±20% (±4%)");
		expect(mdeText({ ...base, mde: null })).toBe("no players");
		expect(mdeText(base)).toBe("–");
		expect(daysText(0)).toBe("now");
		expect(daysText(2.2)).toBe("~3 days");
		expect(daysText(0.3)).toBe("under a day");
		expect(daysText(900)).toBe("over a year");
		expect(daysText(null)).toBe("–");
	});

	it("the variants in the game's order when the rows carry it, else by name", () => {
		const results3 = { ...(results as Extract<ExperimentResult, { variants: unknown }>), assignment: check([5, 5], false) };
		expect(gameVariants(results3)).toEqual({ names: ["short", "long"], known: true });
		expect(gameVariants({ ...results3, assignment: { ...check([5, 5], false), order: "names" } })).toEqual({ names: ["long", "short"], known: false });
	});
});

describe("running an experiment from the page", () => {
	const owner: AuthInfo = { role: "admin", user: { kind: "roblox", userId: 1, name: "Owner" } } as unknown as AuthInfo;
	const viewer: AuthInfo = { role: "web", user: { kind: "roblox", userId: 2, name: "Viewer" } } as unknown as AuthInfo;

	it("owners prepare a split and get the signed command to copy; the results ask with the override's weights", async () => {
		mockApi();
		vi.spyOn(api, "query").mockImplementation(async (_name, _filters, options) =>
			((options as { experiment?: string }).experiment ? { ...(results as object), assignment: check([4, 3], false) } : list) as never,
		);
		const change = vi.spyOn(api, "experimentChange").mockResolvedValue({
			experiment: "onboarding",
			action: "split",
			command: "typetorch experiment weights onboarding 9,1 --variants short,long",
			dryRun: "typetorch experiment weights onboarding 9,1 --variants short,long --dry-run",
			effect: "Splits new and returning players short 90%, long 10%.",
			notes: ["Run it in the game's folder."],
		});
		mount("/experiments", owner);
		const weight = await screen.findByRole("textbox", { name: "Weight of short (control)" });
		// The override's weights fill the inputs.
		expect((weight as HTMLInputElement).value).toBe("3");
		fireEvent.change(weight, { target: { value: "9" } });
		fireEvent.click(screen.getByRole("button", { name: "Change split" }));
		await waitFor(() => expect(change).toHaveBeenCalledWith("onboarding", { action: "split", weights: [9, 1], variants: ["short", "long"] }));
		const box = await screen.findByTestId("prepared-change");
		expect(within(box).getByLabelText("Run in the game's folder").textContent).toBe("typetorch experiment weights onboarding 9,1 --variants short,long");
		expect(within(box).getByLabelText("See the change first (writes nothing)").textContent).toContain("--dry-run");
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(change).toHaveBeenLastCalledWith("onboarding", { action: "stop" }));
		const asked = vi.mocked(api.query).mock.calls.map((c) => c[2] as { experiment?: string; weights?: number[] }).find((o) => o.experiment === "onboarding");
		expect(asked?.weights).toEqual([3, 1]);
	});

	it("viewers see the results but no controls", async () => {
		mockApi();
		mount("/experiments", viewer);
		await screen.findByRole("table", { name: "Variants" });
		expect(screen.queryByRole("button", { name: "Change split" })).toBeNull();
		expect(screen.queryByText("Run it")).toBeNull();
	});
});
