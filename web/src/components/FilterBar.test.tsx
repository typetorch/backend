// @vitest-environment jsdom
/**
 * The filter bar's Audience popover: the button names what is picked, the country / language choices come from the
 * demographics query (asked only once the popover opens, over the range only), and a pick lands in the URL and in the
 * queries' filters.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { audienceChoices } from "@/lib/audience";
import type { DemographicsResult } from "@/lib/types";
import { audienceSummary, FilterBar } from "./FilterBar";

vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	// Radix Select uses these in jsdom.
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const demographics: DemographicsResult = {
	from: "",
	to: "",
	players: 10,
	dimensions: {
		country: [
			{ value: "US", players: 6, share: 0.6 },
			{ value: "BR", players: 3, share: 0.3 },
			{ value: null, players: 1, share: 0.1 },
		],
		language: [
			{ value: "en", players: 6, share: 0.6 },
			{ value: "pt", players: 3, share: 0.3 },
		],
		accountAge: [],
		premium: [],
		device: [],
	},
};

function Location() {
	return <output data-testid="search">{useLocation().search}</output>;
}

function mount(url = "/") {
	const calls: { name: string; filters: Record<string, unknown> }[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, filters: Record<string, unknown> = {}) => {
		calls.push({ name, filters });
		if (name === "values") return { branch: [], art: [], channel: [], dev: [] };
		if (name === "experiment") return { experiment: null, experiments: [] };
		if (name === "demographics") return demographics;
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>
				<FilterBar />
				<Location />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return calls;
}

describe("audience helpers", () => {
	it("the button says what is picked", () => {
		expect(audienceSummary({ range: "7d" })).toBe("Audience");
		expect(audienceSummary({ range: "7d", country: "US", prem: "true" })).toBe("United States, Premium");
		expect(audienceSummary({ range: "7d", lang: "pt", source: "teleport_game" })).toBe("Portuguese, Teleport");
		expect(audienceSummary({ range: "7d", country: "US", age: "<1d", prem: "false" })).toBe("Audience (3)");
	});

	it("choices: the range's values named, most players first, not-sent left out, the picked value kept", () => {
		const { countries, languages } = audienceChoices(demographics, { country: "GB" });
		expect(countries.map((c) => c.label)).toEqual(["United Kingdom (GB)", "United States (US)", "Brazil (BR)"]);
		expect(languages.map((c) => c.value)).toEqual(["en", "pt"]);
		expect(audienceChoices(undefined).countries).toEqual([]);
	});
});

describe("the Audience popover", () => {
	it("reads the URL, asks for choices only once opened, and a pick goes to the URL and the filters", async () => {
		const calls = mount("/?range=7d&prem=true");
		const button = await screen.findByRole("button", { name: "Audience filters (1 set)" });
		expect(button.textContent).toContain("Premium");
		await waitFor(() => expect(calls.some((c) => c.name === "values")).toBe(true));
		expect(calls.some((c) => c.name === "demographics")).toBe(false);

		fireEvent.click(button);
		const country = await screen.findByRole("combobox", { name: "Country" });
		await waitFor(() => expect(calls.some((c) => c.name === "demographics")).toBe(true));
		// Over the range only: the picked audience doesn't narrow its own choices.
		expect(calls.find((c) => c.name === "demographics")?.filters).not.toHaveProperty("prem");
		expect(within(screen.getByRole("combobox", { name: "Premium" })).getByText("Premium")).toBeTruthy();

		country.focus();
		fireEvent.keyDown(country, { key: "Enter" });
		fireEvent.click(await screen.findByRole("option", { name: "Brazil (BR)" }));
		await waitFor(() => expect(screen.getByTestId("search").textContent).toContain("country=BR"));
		expect(screen.getByTestId("search").textContent).toContain("prem=true");
	});
});
