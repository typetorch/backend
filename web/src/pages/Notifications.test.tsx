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
import { api, ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AuthInfo, NotifyFunnelCounts, NotifyFunnelResult, NotifyOptinResult, NotifyQueueResult, NotifyStatus, NotifyUserView, SettingsView } from "@/lib/types";
import Notifications, { placeholdersOf, rowsToParams } from "./Notifications";
import { playerLookup } from "./notifications/PlayerPanel";

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

const T0 = Date.UTC(2026, 9, 3, 12);
const userView: NotifyUserView = {
	userId: 4242,
	known: true,
	pids: ["pid-aaaa"],
	name: "Tester",
	displayName: "Test Player",
	otherMatches: [5151],
	prefs: { off: ["daily", "streak"], rev: 5, updated: T0 },
	state: { optin: "subscribed", optinAt: T0, muteUntil: null, muted: false, online: false, presenceAt: T0, lastSeen: T0, leftAt: T0, unopened: 1, backoffAt: null, cappedUntil: null, nextCheck: null, busy: null },
	sends: [
		{ nid: "nid-1", kind: "gift_new", status: "sent", test: false, plannedAt: T0, sentAt: T0 + 1000, http: 200, code: null, try: 1, openedAt: T0 + 60_000, playedSecs: 95, category: null },
		{ nid: "nid-2", kind: "streak", status: "failed", test: true, plannedAt: T0, sentAt: null, http: 400, code: "FAILED_PRECONDITION", try: 2, openedAt: null, playedSecs: null, category: null },
	],
	intents: [{ kind: "streak", key: "day-3", status: "pending", at: T0 + 3_600_000, until: null, updated: T0, planned: false, params: { day: "3" } }],
	events: {
		from: "2025-09-01T00:00:00.000Z",
		to: "2026-10-05T00:00:00.000Z",
		more: false,
		rows: [
			{ at: "2026-10-03T11:00:00.000Z", t: T0 - 3_600_000, name: "optin_check", pid: "pid-aaaa", where: "streak_2", secs: null, err: "HTTP 500", can: "true", state: null, nid: null, kind: null, why: null, age: null },
			{ at: "2026-10-03T11:00:05.000Z", t: T0 - 3_595_000, name: "optin_shown", pid: "pid-aaaa", where: "streak_2", secs: null, err: null, can: null, state: null, nid: null, kind: null, why: null, age: null },
			{ at: "2026-10-03T11:00:12.000Z", t: T0 - 3_588_000, name: "optin_closed", pid: "pid-aaaa", where: "streak_2", secs: 7, err: null, can: null, state: null, nid: null, kind: null, why: null, age: null },
			{ at: "2026-10-03T12:00:01.000Z", t: T0 + 1000, name: "optin_inferred", pid: "pid-aaaa", where: null, secs: null, err: null, can: null, state: "subscribed", nid: "nid-1", kind: "gift_new", why: null, age: null },
			{ at: "2026-10-03T12:01:00.000Z", t: T0 + 60_000, name: "open", pid: "pid-aaaa", where: null, secs: null, err: null, can: null, state: null, nid: "nid-1", kind: "gift_new", why: null, age: 59 },
		],
	},
	eventsError: "the events are busy",
};

function mount(auth: AuthInfo | null = null, opts: { status?: NotifyStatus; url?: string } = {}) {
	const queries: [string, Record<string, unknown>][] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
		queries.push([name, options]);
		if (name === "notify-funnel") return funnel;
		if (name === "notify-optin") return optin;
		if (name === "notify-queue") return queue;
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const statusSpy = vi.spyOn(api, "notifyStatus").mockResolvedValue(opts.status ?? status);
	const user = vi.spyOn(api, "notifyUser").mockImplementation(async (lookup) => {
		if ("name" in lookup) throw new ApiError(404, "no player with that name in the name cache", "/v1/notify/user");
		return userView;
	});
	const recent = vi.spyOn(api, "notifyRecent").mockResolvedValue({
		sends: [
			{ ...userView.sends[0], nid: "rcnt000001", userId: 42, name: "ava_plays", displayName: "Ava" },
			{ ...userView.sends[0], nid: "rcnt000002", userId: 43, name: null, displayName: null },
		],
	});
	const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ settings: [], audit: [] } as unknown as SettingsView);
	const test = vi.spyOn(api, "notifyTest").mockResolvedValue({ nid: "abc0123xyz", status: "sent" });
	const config = vi.spyOn(api, "notifyConfig").mockResolvedValue({ config: { dailyCap: 1, kinds: { gift_new: { template: "m-1" } } }, updatedAt: Date.now() - 60_000, by: "owner" });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<AuthProvider value={auth}>
				<MemoryRouter initialEntries={[opts.url ?? "/notifications"]}>
					<Notifications />
				</MemoryRouter>
			</AuthProvider>
		</QueryClientProvider>,
	);
	return { queries, statusSpy, save, test, config, user, recent };
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

	it("shows the auth halt as a red banner and stopped templates, and doesn't crash on a kind-less halt", async () => {
		mount(null, {
			status: {
				...status,
				halted: [{ why: "auth", at: 1_762_500_000_000 }, ...status.halted],
				haltedAll: { why: "auth", at: 1_762_500_000_000 },
				haltedTemplates: [{ template: "tmpl-gone", at: 1_762_500_000_000 }],
				outbox: 12,
				rowsDropped: 0,
				presenceStaleHours: 6,
			},
		});
		const text = await screen.findByText(
			"Notifications stopped: Roblox refused the Open Cloud key (401 / 403). Check OPENCLOUD_NOTIFY_KEY's scope (user-notifications) and universe, then turn notifications back on.",
		);
		expect(text.closest("[role=alert]")?.className).toMatch(/destructive/);
		expect(screen.getByText("Templates stopped")).toBeTruthy();
		expect(screen.getByText("tmpl-gone")).toBeTruthy();
		expect(screen.getByText(/Kind streak stopped: its template/)).toBeTruthy();
		expect(screen.queryByText(/Kind undefined/)).toBeNull();
		expect(screen.getByText("12 rows waiting")).toBeTruthy();
	});

	it("Find on the same player asks the server again (a refresh)", async () => {
		const { user } = mount();
		const form = await screen.findByRole("search", { name: "Find a player" });
		fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "4242" } });
		fireEvent.click(within(form).getByRole("button", { name: "Find" }));
		await screen.findByRole("region", { name: "Player notifications" });
		const before = user.mock.calls.length;
		fireEvent.click(within(form).getByRole("button", { name: "Find" }));
		await waitFor(() => expect(user.mock.calls.length).toBeGreaterThan(before));
		expect(user).toHaveBeenLastCalledWith({ uid: "4242" }, expect.anything());
	});

	it("finds a player by UserId and shows consent, sends and intents", async () => {
		const { user } = mount();
		const form = await screen.findByRole("search", { name: "Find a player" });
		fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "4242" } });
		fireEvent.click(within(form).getByRole("button", { name: "Find" }));
		await waitFor(() => expect(user).toHaveBeenCalledWith({ uid: "4242" }, expect.anything()));
		const region = await screen.findByRole("region", { name: "Player notifications" });
		expect(within(region).getByText("Test Player")).toBeTruthy();
		expect(within(region).getByText("pid-aaaa")).toBeTruthy();
		const off = within(region).getByLabelText("Kinds switched off");
		expect(within(off).getByText("daily")).toBeTruthy();
		expect(within(off).getByText("streak")).toBeTruthy();
		const consent = within(region).getByRole("table", { name: "Prompt and consent rows" });
		expect(within(consent).getByText("prompt check")).toBeTruthy();
		expect(within(consent).getByText("prompt closed")).toBeTruthy();
		expect(within(consent).getByText("HTTP 500")).toBeTruthy();
		expect(within(consent).queryByText("opened")).toBeNull();
		const sends = within(region).getByRole("table", { name: "Past notifications" });
		expect(within(sends).getByText("gift_new")).toBeTruthy();
		expect(within(sends).getByText("test")).toBeTruthy();
		expect(within(sends).getByText("400 FAILED_PRECONDITION")).toBeTruthy();
		expect(within(sends).getByText("95")).toBeTruthy();
		const intents = within(region).getByRole("table", { name: "Intents" });
		expect(within(intents).getByText("day-3")).toBeTruthy();
		expect(within(region).getByText("Event rows unavailable: the events are busy")).toBeTruthy();
		fireEvent.click(within(region).getByRole("button", { name: "5151" }));
		await waitFor(() => expect(user).toHaveBeenCalledWith({ uid: "5151" }, expect.anything()));
	});

	it("opens the player from the URL and shows a not-found error", async () => {
		const { user } = mount(null, { url: "/notifications?player=pid-aaaa&by=pid" });
		expect(await screen.findByRole("region", { name: "Player notifications" })).toBeTruthy();
		expect(user).toHaveBeenCalledWith({ pid: "pid-aaaa" }, expect.anything());
		cleanup();
		mount(null, { url: "/notifications?player=Nobody" });
		expect(await screen.findByText("no player with that name in the name cache")).toBeTruthy();
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
		fireEvent.click(within(form).getByRole("button", { name: "Add param" }));
		fireEvent.change(within(form).getByLabelText("Param 1 name"), { target: { value: "gift" } });
		fireEvent.change(within(form).getByLabelText("gift value"), { target: { value: "5 coins" } });
		fireEvent.click(within(form).getByRole("button", { name: "Add param" }));
		fireEvent.click(within(form).getByRole("button", { name: "Remove param 2" }));
		fireEvent.click(within(form).getByRole("button", { name: "Send a test" }));
		await waitFor(() => expect(test).toHaveBeenCalledWith({ userId: 123456789, kind: "gift_new", params: { gift: "5 coins" } }));
		expect(await within(form).findByText("abc0123xyz")).toBeTruthy();
	});

	it("lists the recent sends of everyone; a player opens the Player panel", async () => {
		const { recent, user } = mount();
		const table = await screen.findByRole("table", { name: "Recent notifications" });
		expect(recent).toHaveBeenCalledWith({ limit: 100 }, expect.anything());
		expect(within(table).getByText("@ava_plays")).toBeTruthy();
		expect(within(table).getByText("43")).toBeTruthy();
		fireEvent.click(within(table).getByRole("button", { name: "@ava_plays" }));
		await waitFor(() => expect(user).toHaveBeenCalledWith({ uid: "42" }, expect.anything()));
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
		expect(screen.queryByRole("search", { name: "Find a player" })).toBeNull();
		expect(screen.queryByRole("table", { name: "Recent notifications" })).toBeNull();
	});
});

describe("playerLookup", () => {
	it("guesses UserId, pid or name, or takes the pick", () => {
		expect(playerLookup(" 4242 ")).toEqual({ uid: "4242" });
		expect(playerLookup("pid-aaaa")).toEqual({ pid: "pid-aaaa" });
		expect(playerLookup("abcdefghijklmnopqrstuvwxyz")).toEqual({ pid: "abcdefghijklmnopqrstuvwxyz" });
		expect(playerLookup("Tester")).toEqual({ name: "Tester" });
		expect(playerLookup("Tester", "pid")).toEqual({ pid: "Tester" });
		expect(playerLookup("abc", "uid")).toBeNull();
		expect(playerLookup("a/b")).toBeNull();
		expect(playerLookup("")).toBeNull();
	});
});

describe("test params", () => {
	it("reads a kind's placeholders once, in order (dashes allowed)", () => {
		expect(placeholdersOf("{user-streak-remaining} until your {user-streak} ({user-streak})")).toEqual(["user-streak-remaining", "user-streak"]);
		expect(placeholdersOf(undefined)).toEqual([]);
	});
	it("turns rows into params: blank custom rows skipped, nameless values and duplicates refused", () => {
		const row = (name: string, value: string, fixed = false) => ({ id: Math.random(), name, value, fixed });
		expect(rowsToParams([row("a", "1", true), row(" b ", "two words"), row("", "")])).toEqual({ a: "1", b: "two words" });
		expect(rowsToParams([row("", "")])).toBeUndefined();
		expect(() => rowsToParams([row("", "x")])).toThrow(/no name/);
		expect(() => rowsToParams([row("a", "1"), row("a", "2")])).toThrow(/twice/);
	});
});
