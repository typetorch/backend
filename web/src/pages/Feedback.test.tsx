// @vitest-environment jsdom
/**
 * The Feedback page (plans/32): the KPI cards, one distribution per scale in its own shape (thumbs up / down shares, a
 * 5-step faces histogram with labels and the average), the list's ratings per scale, the filters (rating, has text,
 * search, device) reaching the queries, the empty state, and the player detail's Feedback view (feedback-list by pid).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { FeedbackListResult, FeedbackRow, FeedbackSummaryResult } from "@/lib/types";
import Feedback, { EMPTY_TEXT, parseRating } from "./Feedback";
import { ratingText } from "./feedback/shared";

vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	// Radix Select uses these in jsdom.
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});

const FACES = ["BAD", "MEH", "OK", "GOOD", "GREAT"];
const summary: FeedbackSummaryResult = {
	from: "2026-10-01T00:00:00.000Z",
	to: "2026-10-08T00:00:00.000Z",
	total: 12,
	withText: 5,
	players: 10,
	rated: 11,
	legacy: 4,
	avgNorm: 0.75,
	scales: [
		{
			scale: "thumbs",
			type: "thumbs",
			steps: 2,
			legacy: false,
			n: 4,
			rated: 4,
			textOnly: 0,
			counts: [
				{ r: 0, label: "Down", n: 1 },
				{ r: 1, label: "Up", n: 3 },
			],
			labels: { 0: "Down", 1: "Up" },
			avgR: 0.75,
			avgNorm: 0.75,
			firstAt: "2026-10-06T10:00:00.000Z",
			lastAt: "2026-10-07T10:00:00.000Z",
		},
		{
			scale: "legacy_faces5",
			type: "scale",
			steps: 5,
			legacy: true,
			n: 8,
			rated: 7,
			textOnly: 1,
			counts: FACES.map((label, i) => ({ r: i + 1, label, n: [1, 0, 1, 2, 3][i] as number })),
			labels: { 1: "BAD", 3: "OK", 4: "GOOD", 5: "GREAT" },
			avgR: 3.86,
			avgNorm: 0.7143,
			firstAt: "2026-10-01T10:00:00.000Z",
			lastAt: "2026-10-05T10:00:00.000Z",
		},
	],
	thumbs: { up: 3, down: 1, upShare: 0.75 },
	bucket: "day",
	trend: ["2026-10-01", "2026-10-02", "2026-10-03"].map((at, i) => ({ at, t: Date.parse(at), n: i + 1, rated: i + 1, withText: 0, avgNorm: i ? 0.5 : null })),
};

const row = (o: Partial<FeedbackRow>): FeedbackRow => ({
	t: Date.parse("2026-10-07T10:00:00.000Z"),
	at: "2026-10-07T10:00:00.000Z",
	pid: "pid-aaaa-0001",
	sid: "sid-1",
	dev: "phone",
	state: "zone:lobby|screen:feedback",
	scale: "thumbs",
	type: "thumbs",
	steps: 2,
	r: 1,
	norm: 1,
	label: "Up",
	text: null,
	len: 0,
	topic: null,
	ctx: null,
	play_s: 245,
	legacy: false,
	...o,
});
const rows: FeedbackRow[] = [
	row({ text: "Love the new map", len: 16, topic: "idea", ctx: { level: 12, map: "forest" }, uid: 4242, name: "ava_plays", displayName: "Ava" }),
	row({ pid: "pid-bbbb-0002", r: 0, norm: 0, label: "Down", dev: "desktop" }),
	row({ pid: "pid-cccc-0003", scale: "legacy_faces5", type: "scale", steps: 5, r: 4, norm: 0.75, label: "GOOD", text: "nice", len: 4, legacy: true, play_s: null, dev: "tablet" }),
	row({ pid: "pid-dddd-0004", scale: "stars5", type: "stars", steps: 5, r: 3, norm: 0.5, label: null }),
];
const list: FeedbackListResult = { total: 4, offset: 0, more: false, rows };

function mount(opts: { summary?: FeedbackSummaryResult; list?: FeedbackListResult; url?: string } = {}) {
	const calls: { name: string; filters: Record<string, unknown>; options: Record<string, unknown> }[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, filters: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, filters, options });
		if (name === "feedback-summary") return opts.summary ?? summary;
		if (name === "feedback-list") return opts.list ?? list;
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<AuthProvider value={null}>
				<MemoryRouter initialEntries={[opts.url ?? "/feedback"]}>
					<Feedback />
				</MemoryRouter>
			</AuthProvider>
		</QueryClientProvider>,
	);
	return calls;
}

const lastList = (calls: ReturnType<typeof mount>) => [...calls].reverse().find((c) => c.name === "feedback-list");

describe("Feedback page", () => {
	it("KPIs, a thumbs distribution as up / down shares and a faces histogram with labels and the average", async () => {
		mount();
		expect(await screen.findByRole("heading", { name: "Feedback", level: 1 })).toBeTruthy();
		expect(await screen.findByText("from 10 players")).toBeTruthy();
		expect(screen.getByText("Average rating")).toBeTruthy();
		expect(screen.getByText(/The scale changed in this range/)).toBeTruthy();
		const thumbs = screen.getByLabelText("thumbs distribution");
		expect(within(thumbs).getByRole("img", { name: "75% up, 25% down" })).toBeTruthy();
		expect(within(thumbs).getByText("Up")).toBeTruthy();
		const faces = screen.getByLabelText("Faces (legacy) distribution");
		for (const label of FACES) expect(within(faces).getByText(label)).toBeTruthy();
		expect(within(faces).getByLabelText("GREAT: 3")).toBeTruthy();
		expect(within(faces).getByLabelText("MEH: 0")).toBeTruthy();
		expect(within(faces).getByText("3.86 / 5")).toBeTruthy();
	});

	it("the list: a rating per scale, text, player name linking to the player view, device, play time, topic, ctx", async () => {
		mount();
		const feed = await screen.findByRole("list", { name: "Feedback" });
		expect(within(feed).getByRole("img", { name: "Up" })).toBeTruthy();
		expect(within(feed).getByRole("img", { name: "Down" })).toBeTruthy();
		expect(within(feed).getByRole("img", { name: "GOOD (4 of 5)" })).toBeTruthy();
		expect(within(feed).getByRole("img", { name: "3 of 5 stars" })).toBeTruthy();
		expect(within(feed).getByText("Love the new map")).toBeTruthy();
		const link = within(feed).getByRole("link", { name: "Ava (@ava_plays)" });
		expect(link.getAttribute("href")).toContain("/players?");
		expect(link.getAttribute("href")).toContain("pid=pid-aaaa-0001");
		expect(within(feed).getAllByText("played 4m 05s")).toHaveLength(3);
		expect(within(feed).getByText("idea")).toBeTruthy();
		expect(within(feed).getByText("level: 12")).toBeTruthy();
		expect(within(feed).getByText("legacy")).toBeTruthy();
		expect(within(feed).getAllByText("No text")).toHaveLength(2);
		expect(screen.getByText("1-4 of 4")).toBeTruthy();
	});

	it("filters reach the queries: rating, has text, search, device", async () => {
		const calls = mount({ url: "/feedback?rating=legacy_faces5:4&text=yes&dev=phone&q=map" });
		await screen.findByRole("list", { name: "Feedback" });
		expect(lastList(calls)?.options).toMatchObject({ scale: "legacy_faces5", r: 4, hasText: true, q: "map", limit: 50, offset: 0 });
		expect(lastList(calls)?.filters).toMatchObject({ dev: "phone" });
		expect(calls.find((c) => c.name === "feedback-summary")?.filters).toMatchObject({ dev: "phone" });
		fireEvent.click(screen.getByRole("radio", { name: "No text" }));
		await waitFor(() => expect(lastList(calls)?.options).toMatchObject({ hasText: false }));
		fireEvent.click(screen.getByRole("radio", { name: "All" }));
		await waitFor(() => expect(lastList(calls)?.options.hasText).toBeUndefined());
		fireEvent.change(screen.getByRole("textbox", { name: "Search the text" }), { target: { value: "lag" } });
		await waitFor(() => expect(lastList(calls)?.options).toMatchObject({ q: "lag" }));
	});

	it("no feedback yet: the empty state, no list", async () => {
		mount({ summary: { ...summary, total: 0, withText: 0, players: 0, rated: 0, legacy: 0, avgNorm: null, scales: [], thumbs: null }, list: { total: 0, offset: 0, more: false, rows: [] } });
		expect(await screen.findByText(EMPTY_TEXT)).toBeTruthy();
		expect(screen.queryByRole("list", { name: "Feedback" })).toBeNull();
	});

	it("helpers: the rating filter value and the rating words", () => {
		expect(parseRating("faces5:4")).toEqual({ scale: "faces5", r: 4 });
		expect(parseRating("bad value")).toBeNull();
		expect(ratingText({ type: "thumbs", steps: 2, r: 0, label: null })).toBe("Thumbs down");
		expect(ratingText({ type: "scale", steps: 5, r: 5, label: "GREAT" })).toBe("GREAT (5 of 5)");
		expect(ratingText({ type: "stars", steps: 5, r: null, label: null })).toBe("No rating");
	});
});
