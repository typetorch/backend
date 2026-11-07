// @vitest-environment jsdom
/**
 * The Notifications page: the funnel per kind (no impressions / clicks step), the opt-in and queue sections, the halted
 * banner, the switches (runtime settings through PATCH /v1/admin/settings), the test send, and the read-only role
 * without the owner routes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AuthInfo, NotifyFunnelCounts, NotifyFunnelResult, NotifyOptinResult, NotifyQueueResult, NotifyStatus, SettingsView } from "@/lib/types";
import Notifications, { parseParams } from "./Notifications";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});

const counts = (o: Partial<NotifyFunnelCounts>): NotifyFunnelCounts => ({
	wants: 0,
	planned: 0,
	sent: 0,
	dry: 0,
	tests: 0,
	players: 0,
	opened: 0,
	played: 0,
	returnedD1: 0,
	assisted: 0,
	openRate: 0,
	playedRate: 0,
	returnRate: 0,
	...o,
});

const gift = counts({ wants: 20, planned: 18, sent: 16, players: 16, opened: 4, played: 3, returnedD1: 5, assisted: 2, openRate: 0.25, playedRate: 0.75, returnRate: 0.3125 });
const streak = counts({ wants: 9, planned: 8, sent: 4, dry: 3, players: 4, opened: 1, openRate: 0.25 });
const funnel: NotifyFunnelResult = {
	from: "2026-10-01T00:00:00.000Z",
	to: "2026-10-05T00:00:00.000Z",
	kind: null,
	kinds: [
		{ kind: "gift_new", ...gift },
		{ kind: "streak", ...streak },
	],
	days: [
		{ date: "2026-10-03", kind: "gift_new", ...gift },
		{ date: "2026-10-03", kind: "streak", ...streak },
	],
	daily: [{ date: "2026-10-03", ...counts({ sent: 20, opened: 5, played: 3 }) }],
	totals: counts({ wants: 29, planned: 26, sent: 20, dry: 3, players: 20, opened: 5, played: 3, returnedD1: 5, assisted: 2, openRate: 0.25, playedRate: 0.6, returnRate: 0.25 }),
};
const optin: NotifyOptinResult = {
	from: funnel.from,
	to: funnel.to,
	totals: { checks: 40, canPrompt: 30, errors: 1, shown: 25, closed: 24, shownRate: 0.625, avgShownSecs: 6.5, subscribed: 12, notSubscribed: 7 },
	byWhere: [{ where: "streak_2", checks: 40, canPrompt: 30, errors: 1, shown: 25, closed: 24, shownRate: 0.625, avgShownSecs: 6.5 }],
	days: [],
};
const queue: NotifyQueueResult = {
	from: funnel.from,
	to: funnel.to,
	kind: null,
	totals: { planned: 26, sent: 20, dry: 3, failed: 4, final: 2, rateLimited: 1, skipped: 9, last429At: "2026-10-03T11:00:00.000Z" },
	hours: [{ hour: "2026-10-03T11:00:00.000Z", planned: 2, sent: 1, dry: 0, failed: 2, rateLimited: 1, skipped: 0 }],
	planned: [{ kind: "gift_new", why: "asap", planned: 18 }],
	skipped: [{ kind: "streak", why: "online", skipped: 9 }],
	failures: [
		{ kind: "gift_new", http: 429, code: "RESOURCE_EXHAUSTED", failures: 1, final: 0, sends: 1, lastAt: "2026-10-03T11:00:00.000Z" },
		{ kind: "streak", http: 400, code: "FAILED_PRECONDITION", failures: 3, final: 2, sends: 3, lastAt: "2026-10-03T12:00:00.000Z" },
	],
};
const status: NotifyStatus = {
	enabled: true,
	dryRun: false,
	rate: 10,
	clock: "rolling24",
	configured: { universe: true, apiKey: true },
	keys: { current: true, previous: false, since: 1_762_500_000_000 },
	kinds: [
		{ kind: "gift_new", enabled: true, template: true, pending: 3, text: "You got {gift}! Claim it before it expires." },
		{ kind: "streak", enabled: false, template: true, pending: 1, halted: "bad_template" },
	],
	halted: [{ kind: "streak", why: "bad_template", at: 1_762_500_000_000 }],
	queue: { pending: 4, due1h: 2, sending: 0 },
	bucket: { rate: 5, tokens: 4.2, last429At: null },
	sends24h: { sent: 20, failed: 4, dry: 3 },
	mutes: 7,
	config: true,
};

function mount(auth: AuthInfo | null = null) {
	const queries: [string, Record<string, unknown>][] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
		queries.push([name, options]);
		if (name === "notify-funnel") return funnel;
		if (name === "notify-optin") return optin;
		if (name === "notify-queue") return queue;
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const statusSpy = vi.spyOn(api, "notifyStatus").mockResolvedValue(status);
	const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ settings: [], audit: [] } as unknown as SettingsView);
	const test = vi.spyOn(api, "notifyTest").mockResolvedValue({ nid: "abc0123xyz", status: "sent" });
	const config = vi.spyOn(api, "notifyConfig").mockResolvedValue({ config: { dailyCap: 1, kinds: { gift_new: { template: "m-1" } } }, updatedAt: Date.now() - 60_000, by: "owner" });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<AuthProvider value={auth}>
				<MemoryRouter initialEntries={["/notifications"]}>
					<Notifications />
				</MemoryRouter>
			</AuthProvider>
		</QueryClientProvider>,
	);
	return { queries, statusSpy, save, test, config };
}

describe("Notifications page", () => {
	it("shows the funnel per kind with rates, and no impressions or clicks step", async () => {
		const { queries } = mount();
		const table = await screen.findByRole("table", { name: "Funnel by kind" });
		expect(within(table).getByText("gift_new")).toBeTruthy();
		expect(within(table).getAllByText("25%").length).toBeGreaterThan(0);
		expect(within(table).getByText("75%")).toBeTruthy();
		expect(screen.getByText("Assisted returns")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/impression|click/i);
		expect(queries.map(([n]) => n).sort()).toEqual(["notify-funnel", "notify-optin", "notify-queue"]);
	});

	it("shows the opt-in, the live queue, failures and mutes", async () => {
		mount();
		expect(await screen.findByRole("table", { name: "Opt-in by where" })).toBeTruthy();
		expect(screen.getByText("streak_2")).toBeTruthy();
		expect(await screen.findByText("2 due in the next hour")).toBeTruthy();
		const failures = screen.getByRole("table", { name: "Failures by http and code" });
		expect(within(failures).getByText("RESOURCE_EXHAUSTED")).toBeTruthy();
		expect(within(failures).getByText("429")).toBeTruthy();
		expect(screen.getByText("7 muted players")).toBeTruthy();
		expect(await screen.findByText("You got {gift}! Claim it before it expires.")).toBeTruthy();
	});

	it("says when a kind stopped on a bad template", async () => {
		mount();
		expect(
			await screen.findByText("Kind streak stopped: its template (message id) does not exist on Roblox. Fix the template, push the config, then turn the kind back on."),
		).toBeTruthy();
	});

	it("switches go through the runtime settings", async () => {
		const { save } = mount();
		fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Sending" })).getByRole("radio", { name: "Paused" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.enabled": false }));
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Dry run" })).getByRole("radio", { name: "On" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.dryRun": true }));
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Kind streak" })).getByRole("radio", { name: "On" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.kinds.streak.enabled": true }));
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Day clock" })).getByRole("radio", { name: "UTC day" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.clock": "utc_day" }));
		const rate = screen.getByLabelText("Rate ceiling (sends / s)");
		fireEvent.change(rate, { target: { value: "5000" } });
		expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(rate, { target: { value: "25" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.rate": 25 }));
	});

	it("sends a test and shows the result", async () => {
		const { test } = mount();
		const form = await screen.findByRole("form", { name: "Send a test" });
		fireEvent.click(within(form).getByRole("button", { name: "Send a test" }));
		expect(await within(form).findByText("UserId must be a positive whole number.")).toBeTruthy();
		fireEvent.change(within(form).getByLabelText("UserId"), { target: { value: "123456789" } });
		fireEvent.change(within(form).getByLabelText("Params"), { target: { value: "gift=5 coins\n" } });
		fireEvent.click(within(form).getByRole("button", { name: "Send a test" }));
		await waitFor(() => expect(test).toHaveBeenCalledWith({ userId: 123456789, kind: "gift_new", params: { gift: "5 coins" } }));
		expect(await within(form).findByText("abc0123xyz")).toBeTruthy();
	});

	it("shows the pushed config only when asked", async () => {
		const { config } = mount();
		const button = await screen.findByRole("button", { name: "Show the pushed config" });
		expect(config).not.toHaveBeenCalled();
		fireEvent.click(button);
		expect(await screen.findByText(/"dailyCap": 1/)).toBeTruthy();
	});

	it("the read-only role sees the analytics, not the owner routes", async () => {
		const { statusSpy } = mount({ ok: true, role: "web", via: "cookie" });
		expect(await screen.findByRole("table", { name: "Funnel by kind" })).toBeTruthy();
		expect(screen.getByText("The live queue and the controls are for owners.")).toBeTruthy();
		expect(statusSpy).not.toHaveBeenCalled();
		expect(screen.queryByRole("form", { name: "Send a test" })).toBeNull();
	});
});

describe("parseParams", () => {
	it("reads name=value lines", () => {
		expect(parseParams("a=1\n\n b = two words \n")).toEqual({ a: "1", b: "two words" });
		expect(parseParams("  ")).toBeUndefined();
		expect(() => parseParams("nope")).toThrow(/name=value/);
	});
});
