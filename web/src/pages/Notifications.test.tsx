// @vitest-environment jsdom
/**
 * The Notifications page: the tabs (Health with Needs attention, Funnel, Inbox with the side panel and the Player panel,
 * Subscribers from the opt-in list, Kinds, Queue & errors, Settings), the status chip's popover, the halted banner, the
 * switches (runtime settings through PATCH /v1/admin/settings), the test send, and the read-only role without the owner
 * routes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AuthInfo, NotifyFunnelCounts, NotifyFunnelResult, NotifyOptinResult, NotifyQueueResult, NotifyStatus, NotifyUsersView, NotifyUserView, SettingsView } from "@/lib/types";
import Notifications, { placeholdersOf, rowsToParams } from "./Notifications";
import { attentionItems } from "./notifications/attention";
import { funnelSteps } from "./notifications/FunnelTab";
import { healthSentence } from "./notifications/HealthTab";
import { sendLabel, sendMatches } from "./notifications/InboxTab";
import { playerLookup } from "./notifications/PlayerPanel";

// A whole page with tabs, tables and charts in jsdom: role queries are slow on a busy machine
vi.setConfig({ testTimeout: 20_000 });

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
	byWhere: [{ where: "streak_2", checks: 40, canPrompt: 30, errors: 1, shown: 25, closed: 24, shownRate: 0.625, avgShownSecs: 6.5, shownPlayers: 20, subscribed: 9, notSubscribed: 4, subscribedRate: 0.45 }],
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
		{ kind: "gift_new", http: 429, code: "RESOURCE_EXHAUSTED", failures: 1, final: 0, sends: 1, lastAt: new Date(Date.now() - 3_600_000).toISOString() },
		{ kind: "streak", http: 400, code: "FAILED_PRECONDITION", failures: 3, final: 2, sends: 3, lastAt: new Date(Date.now() - 7_200_000).toISOString() },
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
		{ nid: "nid-2", kind: "streak", status: "failed", test: true, plannedAt: T0, sentAt: null, http: 400, code: "FAILED_PRECONDITION", try: 2, openedAt: null, playedSecs: null, category: null, template: "tmpl-2", params: { days: "3" }, error: "User is not subscribed", request: { payload: { message_id: "tmpl-2", parameters: { days: { string_value: "3" } } } } },
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

const usersView: NotifyUsersView = {
	counts: { subscribed: 5, notSubscribed: 2, unknown: 9, muted: 2, newThisWeek: 1 },
	users: [
		{ userId: 9001, name: "subby", displayName: "Sub", optin: "subscribed", optinAt: T0, lastSeen: T0, online: false, muteUntil: null, sends: 3, opened: 2 },
		{ userId: 9002, name: null, displayName: null, optin: "subscribed", optinAt: T0 - 1000, lastSeen: null, online: true, muteUntil: null, sends: 1, opened: 0 },
	],
	next: "1700000000000.9001",
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
			{ ...userView.sends[0], nid: "rcnt000001", userId: 42, name: "ava_plays", displayName: "Ava", optin: "subscribed", params: { gift: "5 coins" } },
			{ ...userView.sends[0], nid: "rcnt000002", userId: 43, name: null, displayName: null, openedAt: null, optin: null },
			{ ...userView.sends[1], nid: "rcnt000003", userId: 44, name: "bo", displayName: null, optin: "not_subscribed" },
		],
	});
	const users = vi.spyOn(api, "notifyUsers").mockImplementation(async (p = {}) => ({ ...usersView, next: p.cursor ? null : "1700000000000.9001" }));
	const csv = vi.spyOn(api, "notifyUsersCsv").mockResolvedValue({ name: "notify-subscribed.csv", blob: new Blob(["user_id\n"]), truncated: false });
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
	return { queries, statusSpy, save, test, config, user, recent, users, csv };
}

describe("Notifications page", () => {
	it("opens on Health: the status sentence, who can get notifications, and what needs attention", async () => {
		const { users } = mount();
		const sentence = await screen.findByRole("status", { name: "Sending status" });
		await waitFor(() => expect(sentence.textContent).toContain("Sending, with a kind stopped."));
		expect(sentence.textContent).toContain("25% opened");
		expect(await screen.findByLabelText("5 subscribed, 2 not subscribed, 9 unknown")).toBeTruthy();
		expect(users).toHaveBeenCalledWith({ limit: 1 }, expect.anything());
		const list = await screen.findByRole("list", { name: "Needs attention" });
		expect(within(list).getByText("Kind streak stopped")).toBeTruthy();
		expect(within(list).getByText("3 sends failed (400 FAILED_PRECONDITION) in the last 24 h")).toBeTruthy();
		expect(within(list).getByText("Players who aren't opted in: they are muted 7 days automatically.", { exact: false })).toBeTruthy();
		expect(within(list).getByText("1 rate-limited send (429) in the last 24 h")).toBeTruthy();
		// KPI cards
		expect(screen.getByText("Subscribers (known)")).toBeTruthy();
		expect(screen.getByText("+1 this week")).toBeTruthy();
		expect(screen.getByText("Came back next day")).toBeTruthy();
		// the queue tab carries its issue count
		expect(screen.getByLabelText("2 open issues")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/impression|click/i);
	});

	it("the status chip opens the live queue in a popover", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Sending · 5/s: right now" }, { timeout: 8000 }));
		const now = await screen.findByLabelText("Right now", undefined, { timeout: 8000 });
		expect(within(now).getByText("Due in the next hour")).toBeTruthy();
		expect(within(now).getByText("20 sent, 4 failed, 3 dry")).toBeTruthy();
		expect(screen.getByText("Dry run off")).toBeTruthy();
	});

	it("Funnel: prompt to back next day, insights, the opt-in by spot", async () => {
		const { queries } = mount(null, { url: "/notifications?tab=funnel" });
		const steps = await screen.findByRole("list", { name: "Notification funnel" });
		expect(within(steps).getByText("Prompt shown")).toBeTruthy();
		expect(within(steps).getByText("48%")).toBeTruthy(); // 12 subscribed of 25 shown
		expect(screen.getByText("gift_new: 25% opened")).toBeTruthy();
		expect(screen.getByText("streak_2: 45% subscribed")).toBeTruthy();
		expect(screen.getByText("Assisted returns")).toBeTruthy();
		const where = screen.getByRole("table", { name: "Opt-in by where" });
		expect(within(where).getByText("streak_2")).toBeTruthy();
		expect(within(where).getByText("45%")).toBeTruthy();
		// this range and the one before it (the Sent card's change)
		expect(queries.map(([n]) => n).sort()).toEqual(["notify-funnel", "notify-funnel", "notify-optin", "notify-queue"]);
	});

	it("Kinds: the funnel per kind with rates, the kind's text and its switch", async () => {
		const { save } = mount(null, { url: "/notifications?tab=kinds" });
		const table = await screen.findByRole("table", { name: "Funnel by kind" });
		expect(within(table).getByText("gift_new")).toBeTruthy();
		expect(within(table).getAllByText("25%").length).toBeGreaterThan(0);
		expect(within(table).getByText("75%")).toBeTruthy();
		expect(await within(table).findByText("You got {gift}! Claim it before it expires.")).toBeTruthy();
		fireEvent.click(within(await within(table).findByRole("radiogroup", { name: "Kind streak" })).getByRole("radio", { name: "On" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.kinds.streak.enabled": true }));
		expect(screen.getByText("By kind and day")).toBeTruthy();
	});

	it("Queue & errors: the live queue, failures and mutes, planned and skipped", async () => {
		mount(null, { url: "/notifications?tab=queue" });
		expect(await screen.findByText("2 due in the next hour")).toBeTruthy();
		const failures = screen.getByRole("table", { name: "Failures by http and code" });
		expect(within(failures).getByText("RESOURCE_EXHAUSTED")).toBeTruthy();
		expect(within(failures).getByText("429")).toBeTruthy();
		expect(screen.getByText("7 muted players")).toBeTruthy();
		expect(screen.getByRole("table", { name: "Skipped by kind and why" })).toBeTruthy();
	});

	it("says when a kind stopped on a bad template", async () => {
		mount();
		expect(
			await screen.findByText("Kind streak stopped: its template (message id) does not exist on Roblox. Fix the template, push the config, then turn the kind back on."),
		).toBeTruthy();
	});

	it("shows the auth halt as a red banner and stopped templates, and doesn't crash on a kind-less halt", async () => {
		mount(null, {
			url: "/notifications?tab=queue",
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
		expect(screen.getByRole("button", { name: "Stopped: right now" })).toBeTruthy();
	});

	it("Inbox: the feed with filters and search; a send opens the side panel, then the full player view", async () => {
		const { recent, user } = mount(null, { url: "/notifications?tab=inbox" });
		const feed = await screen.findByRole("list", { name: "Recent notifications" });
		expect(recent).toHaveBeenCalledWith({ limit: 200 }, expect.anything());
		expect(within(feed).getByText("You got 5 coins! Claim it before it expires.")).toBeTruthy();
		expect(within(feed).getByRole("button", { name: "UserId 43 gift_new sent" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Failed" }));
		expect(within(screen.getByRole("list", { name: "Recent notifications" })).getAllByRole("button")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "All" }));
		fireEvent.click(screen.getByRole("button", { name: "Subscribers" }));
		expect(within(screen.getByRole("list", { name: "Recent notifications" })).getAllByRole("button")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Subscribers" }));
		fireEvent.change(screen.getByLabelText("Search sends"), { target: { value: "rcnt000002" } });
		expect(within(screen.getByRole("list", { name: "Recent notifications" })).getAllByRole("button")).toHaveLength(1);
		fireEvent.change(screen.getByLabelText("Search sends"), { target: { value: "@ava" } });
		fireEvent.click(screen.getByRole("button", { name: "@ava_plays gift_new opened" }));
		await waitFor(() => expect(user).toHaveBeenCalledWith({ uid: "42" }, expect.anything()));
		const side = await screen.findByRole("region", { name: "Selected send" });
		expect(within(side).getByText(/Subscribed since/)).toBeTruthy();
		expect(within(side).getByText("daily off in game")).toBeTruthy();
		expect(within(side).getByText("Request, answer and join data")).toBeTruthy();
		fireEvent.click(within(side).getByRole("button", { name: "Open full player view" }));
		expect(await screen.findByRole("region", { name: "Player notifications" })).toBeTruthy();
	}, 20_000);

	it("Find on the same player asks the server again (a refresh)", async () => {
		const { user } = mount(null, { url: "/notifications?tab=inbox" });
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
		const { user } = mount(null, { url: "/notifications?tab=inbox" });
		const form = await screen.findByRole("search", { name: "Find a player" });
		fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "4242" } });
		fireEvent.click(within(form).getByRole("button", { name: "Find" }));
		await waitFor(() => expect(user).toHaveBeenCalledWith({ uid: "4242" }, expect.anything()));
		const region = await screen.findByRole("region", { name: "Player notifications" });
		// one player link (the Players page by pid), no separate UserId / pid lines
		const who = within(region).getByRole("link", { name: "Test Player (@Tester)" });
		expect(who.getAttribute("href")).toContain("pid=pid-aaaa");
		expect(within(region).queryByText("pid-aaaa")).toBeNull();
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

	it("shows a clicked send's request body and Roblox's refusal", async () => {
		mount(null, { url: "/notifications?player=4242" });
		const sends = await screen.findByRole("table", { name: "Past notifications" });
		fireEvent.click(within(sends).getByText("400 FAILED_PRECONDITION"));
		const detail = await screen.findByRole("region", { name: "Notification detail" });
		expect(within(detail).getByText("User is not subscribed")).toBeTruthy();
		expect(within(detail).getByText("tmpl-2")).toBeTruthy();
		expect(within(detail).getByText(/"string_value": "3"/)).toBeTruthy();
	});

	it("shows the opening session's join data next to an opened send", async () => {
		const { user } = mount(null, { url: "/notifications?tab=inbox" });
		user.mockResolvedValue({
			...userView,
			events: { ...(userView.events as NonNullable<NotifyUserView["events"]>), opens: [{ nid: "nid-1", at: "2026-10-03T12:01:00.000Z", t: T0 + 60_000, sid: "sid-x", jd: { keys: ["LaunchData"], LaunchData: "tt1n.nid-1", trunc: true } }] },
		});
		const form = await screen.findByRole("search", { name: "Find a player" });
		fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "4242" } });
		fireEvent.click(within(form).getByRole("button", { name: "Find" }));
		const opens = await screen.findByRole("region", { name: "Opening sessions" });
		expect(within(opens).getByText("nid-1")).toBeTruthy();
		expect(within(opens).getByText("truncated")).toBeTruthy();
		expect((within(opens).getByText("Join data").closest("details") as HTMLElement).querySelector("pre")?.textContent).toContain("tt1n.nid-1");
		// The unopened send has no block.
		expect(within(opens).queryByText("nid-2")).toBeNull();
	});

	it("opens the player from the URL (the Inbox tab) and shows a not-found error", async () => {
		const { user } = mount(null, { url: "/notifications?player=pid-aaaa&by=pid" });
		expect(await screen.findByRole("region", { name: "Player notifications" })).toBeTruthy();
		expect(user).toHaveBeenCalledWith({ pid: "pid-aaaa" }, expect.anything());
		expect(screen.getByRole("tab", { name: "Inbox" }).getAttribute("aria-selected")).toBe("true");
		cleanup();
		mount(null, { url: "/notifications?player=Nobody" });
		expect(await screen.findByText("no player with that name in the name cache")).toBeTruthy();
	});

	it("Subscribers: counts per state, pages, search, a player link and the CSV", async () => {
		globalThis.URL.createObjectURL ??= (() => "blob:x") as typeof URL.createObjectURL;
		globalThis.URL.revokeObjectURL ??= (() => undefined) as typeof URL.revokeObjectURL;
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		const { users, csv, user } = mount(null, { url: "/notifications?tab=subscribers" });
		const table = await screen.findByRole("table", { name: "Subscribers" });
		expect(within(table).getByText("@subby")).toBeTruthy();
		expect(within(table).getByText("online")).toBeTruthy();
		expect(users).toHaveBeenCalledWith({ state: "subscribed", limit: 50 }, expect.anything());
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		await waitFor(() => expect(users).toHaveBeenCalledWith({ state: "subscribed", limit: 50, cursor: "1700000000000.9001" }, expect.anything()));
		fireEvent.click(screen.getByRole("button", { name: /^Not subscribed/ }));
		await waitFor(() => expect(users).toHaveBeenCalledWith({ state: "not_subscribed", limit: 50 }, expect.anything()));
		fireEvent.change(screen.getByLabelText("Find a subscriber", { selector: "input" }), { target: { value: "9001" } });
		fireEvent.submit(screen.getByRole("search", { name: "Find a subscriber" }));
		await waitFor(() => expect(users).toHaveBeenCalledWith({ state: "not_subscribed", limit: 50, q: "9001" }, expect.anything()));
		fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
		await waitFor(() => expect(csv).toHaveBeenCalledWith({ state: "not_subscribed", q: "9001" }));
		fireEvent.click(await screen.findByRole("button", { name: "@subby" }));
		await waitFor(() => expect(user).toHaveBeenCalledWith({ uid: "9001" }, expect.anything()));
	}, 20_000);

	it("Settings: switches go through the runtime settings", async () => {
		const { save } = mount(null, { url: "/notifications?tab=settings", status: { ...status, presenceStaleHours: 6 } });
		fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Sending" })).getByRole("radio", { name: "Paused" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.enabled": false }));
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Dry run" })).getByRole("radio", { name: "On" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.dryRun": true }));
		fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Kind streak" })).getByRole("radio", { name: "On" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.kinds.streak.enabled": true }));
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Day clock" })).getByRole("radio", { name: "UTC day" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.clock": "utc_day" }));
		const rate = screen.getByLabelText("Rate ceiling (sends / s)");
		const saveRate = screen.getByRole("button", { name: "Save Rate ceiling (sends / s)" }) as HTMLButtonElement;
		fireEvent.change(rate, { target: { value: "5000" } });
		expect(saveRate.disabled).toBe(true);
		fireEvent.change(rate, { target: { value: "25" } });
		fireEvent.click(saveRate);
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.rate": 25 }));
		fireEvent.change(screen.getByLabelText("Presence goes stale after (hours)"), { target: { value: "12" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Presence goes stale after (hours)" }));
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "notify.presenceStaleHours": 12 }));
	}, 20_000);

	it("Settings: sends a test with a text preview and shows the result", async () => {
		const { test } = mount(null, { url: "/notifications?tab=settings" });
		const form = await screen.findByRole("form", { name: "Send a test" });
		fireEvent.click(within(form).getByRole("button", { name: "Send a test" }));
		expect(await within(form).findByText("UserId must be a positive whole number.")).toBeTruthy();
		fireEvent.change(within(form).getByLabelText("UserId"), { target: { value: "123456789" } });
		fireEvent.change(within(form).getByLabelText("gift value"), { target: { value: "5 coins" } });
		expect(within(form).getByLabelText("Preview").textContent).toContain("You got 5 coins! Claim it before it expires.");
		fireEvent.click(within(form).getByRole("button", { name: "Add param" }));
		fireEvent.click(within(form).getByRole("button", { name: "Remove param 2" }));
		fireEvent.click(within(form).getByRole("button", { name: "Send a test" }));
		await waitFor(() => expect(test).toHaveBeenCalledWith({ userId: 123456789, kind: "gift_new", params: { gift: "5 coins" } }));
		expect(await within(form).findByText("abc0123xyz")).toBeTruthy();
	});

	it("Settings: the kinds' config record (read-only) and the config JSON when asked", async () => {
		const { config } = mount(null, { url: "/notifications?tab=settings" });
		const kinds = await screen.findByRole("table", { name: "Kinds config" });
		expect(await within(kinds).findByText("m-1")).toBeTruthy();
		expect(config).toHaveBeenCalled();
		expect(screen.queryByText(/"dailyCap": 1/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Show the pushed config" }));
		expect(await screen.findByText(/"dailyCap": 1/)).toBeTruthy();
	});

	it("the header's Send a test goes to Settings", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
		expect(await screen.findByRole("form", { name: "Send a test" })).toBeTruthy();
	});

	it("the read-only role sees the analytics, not the owner routes or tabs", async () => {
		const { statusSpy, users, recent } = mount({ ok: true, role: "web", via: "cookie" }, { url: "/notifications?tab=settings" });
		expect(await screen.findByText("The live queue and the controls are for owners.")).toBeTruthy();
		expect(screen.queryByRole("tab", { name: "Inbox" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "Subscribers" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
		expect(screen.getByRole("tab", { name: "Kinds" })).toBeTruthy();
		expect(statusSpy).not.toHaveBeenCalled();
		expect(users).not.toHaveBeenCalled();
		expect(recent).not.toHaveBeenCalled();
		expect(screen.queryByRole("form", { name: "Send a test" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Send a test" })).toBeNull();
		cleanup();
		mount({ ok: true, role: "web", via: "cookie" }, { url: "/notifications?tab=kinds" });
		expect(await screen.findByRole("table", { name: "Funnel by kind" })).toBeTruthy();
		expect(screen.queryByRole("radiogroup", { name: "Kind streak" })).toBeNull();
	});

	it("a 403 on the status hides the owner tabs too", async () => {
		const { statusSpy } = mount(null, { url: "/notifications?tab=inbox" });
		statusSpy.mockRejectedValue(new ApiError(403, "forbidden", "/v1/notify/status"));
		cleanup();
		const again = mount(null, { url: "/notifications?tab=inbox" });
		again.statusSpy.mockRejectedValue(new ApiError(403, "forbidden", "/v1/notify/status"));
		expect(await screen.findByRole("tab", { name: "Health" })).toBeTruthy();
	});
});

describe("notification helpers", () => {
	it("attention: halts, pause, dry run, setup, failures by code, 429s, a weak prompt spot", () => {
		const now = Date.UTC(2026, 9, 3, 13);
		const items = attentionItems({
			now,
			status: { ...status, enabled: false, dryRun: true, configured: { universe: false, apiKey: true } },
			queue,
			optin: {
				...optin,
				byWhere: [
					{ ...optin.byWhere[0], where: "good", shownPlayers: 100, subscribed: 50, subscribedRate: 0.5 },
					{ ...optin.byWhere[0], where: "bad", shownPlayers: 40, subscribed: 4, subscribedRate: 0.1 },
					{ ...optin.byWhere[0], where: "tiny", shownPlayers: 3, subscribed: 0, subscribedRate: 0 },
				],
			},
		});
		const ids = items.map((i) => i.id);
		expect(ids).toEqual(expect.arrayContaining(["halted-streak", "paused", "dry-run", "setup", "spot-bad"]));
		expect(ids).not.toContain("spot-tiny");
		expect(ids).not.toContain("spot-good");
		expect(items[0]?.level).toBe("error");
		expect(items.find((i) => i.id === "spot-bad")?.tab).toBe("funnel");
		// the queue fixture's failures are an hour or two old (relative to the real clock): none count 24 h after
		expect(attentionItems({ queue, now: Date.now() + 2 * 86_400_000 })).toEqual([]);
		expect(attentionItems({ queue }).map((i) => i.id).sort()).toEqual(["fail-400|FAILED_PRECONDITION", "rate-limited"]);
	});

	it("funnel steps: each % of the step before, without the prompt steps when the opt-in rows are missing", () => {
		const steps = funnelSteps(funnel, optin);
		expect(steps.map((s) => s.label)).toEqual(["Prompt shown", "Subscribed", "Sent", "Opened", "Played 1 min+", "Back next day"]);
		expect(steps[0]?.rate).toBeNull();
		expect(steps[1]?.rate).toBeCloseTo(12 / 25);
		expect(funnelSteps(funnel, undefined).map((s) => s.label)[0]).toBe("Sent");
	});

	it("health sentence and send labels", () => {
		expect(healthSentence({ ...status, halted: [] }, funnel).lead).toBe("Sending normally.");
		expect(healthSentence({ ...status, enabled: false, halted: [] }, funnel)).toMatchObject({ level: "warn", lead: "Sending is paused." });
		expect(healthSentence(undefined, undefined).lead).toBe("Sending status is for owners.");
		expect(sendLabel({ status: "sent", openedAt: 1 }).text).toBe("opened");
		expect(sendLabel({ status: "planned", openedAt: null }).text).toBe("queued");
		expect(sendMatches({ status: "sent", openedAt: null, test: false }, "unopened")).toBe(true);
		expect(sendMatches({ status: "cancelled", openedAt: null, test: false }, "failed")).toBe(true);
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
