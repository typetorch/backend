// @vitest-environment jsdom
/**
 * The Live events page: the lists by status with UTC and local times, each event's sync state, the signing card (the
 * command for owners, none for viewers), the form (UTC times, values JSON checked before sending), cancel, the lift
 * report with its verdict; and the helpers (UTC inputs, lifts, chart marks).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { fmtLift, fmtUtc, liveEventMarks, parseValues, utcInputToIso, type LiftReport, type LiveEvent, type LiveEventsView } from "@/lib/live-events";
import type { AuthInfo } from "@/lib/types";
import LiveEvents, { signedText } from "./LiveEvents";

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const OWNER = { ok: true, role: "admin", via: "cookie" } as AuthInfo;
const VIEWER = { ok: true, role: "web", via: "cookie" } as AuthInfo;

const base = { note: null, createdAt: "2026-11-10T10:00:00.000Z", createdBy: "roblox user 1 (owner)", cancelledAt: null, cancelledBy: null };
const EVENTS: LiveEvent[] = [
	{ ...base, id: "ev_live000000", name: "Double cash", values: { "cash.multiplier": 2 }, start: "2026-11-14T12:00:00.000Z", end: "2026-11-15T23:59:00.000Z", status: "live", sync: "signed" },
	{ ...base, id: "ev_next000000", name: "XP weekend", values: { "xp.multiplier": 3 }, start: "2026-11-21T12:00:00.000Z", end: "2026-11-22T12:00:00.000Z", status: "scheduled", sync: "unsigned" },
	{ ...base, id: "ev_past000000", name: "Halloween", values: { "shop.discount": 0.2 }, start: "2026-10-31T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", status: "ended", sync: "done" },
];
const VIEW: LiveEventsView = {
	now: "2026-11-15T12:00:00.000Z",
	events: EVENTS,
	schedule: { v: 1, events: [] },
	commands: { json: '{"v":1,"events":[]}', bash: "typetorch settings set game.tt.events - <<'TT_EVENTS'\n{}\nTT_EVENTS", powershell: "Get-Content live-events.json -Raw | typetorch settings set game.tt.events -" },
	signed: { state: "ok", seq: 12, at: "2026-11-14T11:00:00.000Z", verified: "sig", schedule: null, readAt: "2026-11-15T12:00:00.000Z" },
	needsSigning: true,
};

const lift = (value: number, baseline: number, l: number, direction: "up" | "down" | "flat" | "unknown") => ({ value, baseline, lift: l, spread: { min: -0.03, max: 0.05 }, weeks: [baseline], direction });
const REPORT: LiftReport = {
	plan: { event: { from: 0, to: 1 }, after: { from: 1, to: 2 }, baselines: [], skipped: [], partial: false, afterPartial: false, stepDays: 7, afterDays: 3 },
	weeksUsed: [1, 2, 3],
	weeksEmpty: [],
	event: {
		players: lift(100, 100, 0, "flat"),
		playtimePerPlayer: lift(35.4, 30, 0.18, "up"),
		sessionsPerPlayer: lift(1.2, 1.2, 0, "flat"),
		robuxPerPlayer: lift(5, 5, 0, "flat"),
		payerConversion: lift(0.05, 0.05, 0, "flat"),
		newPlayers: lift(10, 10, 0, "flat"),
	},
	after: null,
	net: null,
	raw: { event: { from: 0, to: 1, players: 100, newPlayers: 10, sessions: 120, playtimeMinutes: 3540, robux: 500, purchases: 5, payers: 5 }, after: null },
	verdict: "+18% playtime per player (baseline range -3% to +5%). No dip the 3 days after.",
	headline: "up",
};

function wrap(auth: AuthInfo) {
	return render(
		<MemoryRouter>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AuthProvider value={auth}>
					<LiveEvents />
				</AuthProvider>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("the Live events page", () => {
	test("lists live, upcoming and past with sync states; owners see the signing command and the form", async () => {
		vi.spyOn(api, "liveEvents").mockResolvedValue(VIEW);
		wrap(OWNER);
		await waitFor(() => expect(screen.getByText("Double cash")).toBeTruthy(), { timeout: 5000 });
		expect(screen.getByText("XP weekend")).toBeTruthy();
		expect(screen.getByText("Halloween")).toBeTruthy();
		expect(screen.getByText("Signed: servers have it")).toBeTruthy();
		expect(screen.getByText("Not signed yet: servers won't run it")).toBeTruthy();
		expect(screen.getByText(/Sign the schedule: servers don't have the latest changes/)).toBeTruthy();
		expect(screen.getByText(/TT_EVENTS/)).toBeTruthy();
		expect(screen.getByRole("form", { name: "Schedule a live event" })).toBeTruthy();
		// UTC and local times.
		expect(screen.getAllByText(/Sat 2026-11-14 12:00 UTC/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/local/).length).toBeGreaterThan(0);
		// Cancel only on scheduled and live events.
		expect(screen.getAllByText("Cancel")).toHaveLength(2);
	});

	test("viewers: no form, no command, no cancel", async () => {
		vi.spyOn(api, "liveEvents").mockResolvedValue(VIEW);
		wrap(VIEWER);
		await waitFor(() => expect(screen.getByText("Double cash")).toBeTruthy(), { timeout: 5000 });
		expect(screen.queryByRole("form", { name: "Schedule a live event" })).toBeNull();
		expect(screen.queryByText(/TT_EVENTS/)).toBeNull();
		expect(screen.queryByText("Cancel")).toBeNull();
		expect(screen.getByText(/An owner runs this/)).toBeTruthy();
	});

	test("the form: bad JSON is caught before sending; a good one sends UTC times", async () => {
		vi.spyOn(api, "liveEvents").mockResolvedValue({ ...VIEW, needsSigning: false });
		const create = vi.spyOn(api, "createLiveEvent").mockResolvedValue({ event: EVENTS[1] as LiveEvent, commands: VIEW.commands });
		wrap(OWNER);
		await waitFor(() => expect(screen.getByRole("form", { name: "Schedule a live event" })).toBeTruthy(), { timeout: 5000 });
		fireEvent.change(screen.getByPlaceholderText("Double cash weekend"), { target: { value: "XP weekend" } });
		fireEvent.change(screen.getByLabelText("Values"), { target: { value: "{ nope" } });
		fireEvent.change(screen.getByLabelText("Start (UTC)"), { target: { value: "2026-11-21T12:00" } });
		fireEvent.change(screen.getByLabelText("End (UTC)"), { target: { value: "2026-11-22T12:00" } });
		fireEvent.click(screen.getByText("Schedule"));
		await waitFor(() => expect(screen.getByText(/values must be JSON/)).toBeTruthy());
		expect(create).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Values"), { target: { value: '{ "xp.multiplier": 3 }' } });
		fireEvent.click(screen.getByText("Schedule"));
		await waitFor(() => expect(create).toHaveBeenCalled());
		expect(create.mock.calls[0]?.[0]).toEqual({ name: "XP weekend", values: { "xp.multiplier": 3 }, start: "2026-11-21T12:00:00.000Z", end: "2026-11-22T12:00:00.000Z" });
	});

	test("cancel asks first, then calls the backend", async () => {
		vi.spyOn(api, "liveEvents").mockResolvedValue(VIEW);
		const cancel = vi.spyOn(api, "cancelLiveEvent").mockResolvedValue({ event: { ...(EVENTS[1] as LiveEvent), status: "cancelled" }, commands: VIEW.commands });
		const confirm = vi.spyOn(globalThis, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
		wrap(OWNER);
		await waitFor(() => expect(screen.getAllByText("Cancel").length).toBe(2), { timeout: 5000 });
		fireEvent.click(screen.getAllByText("Cancel")[1] as HTMLElement);
		expect(cancel).not.toHaveBeenCalled();
		fireEvent.click(screen.getAllByText("Cancel")[1] as HTMLElement);
		await waitFor(() => expect(cancel).toHaveBeenCalledWith("ev_next000000"));
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	test("a past event's lift report: the verdict and the metric rows", async () => {
		vi.spyOn(api, "liveEvents").mockResolvedValue(VIEW);
		const get = vi.spyOn(api, "liveEventLift").mockResolvedValue({ event: EVENTS[2] as LiveEvent, report: REPORT, cached: false });
		wrap(VIEWER);
		await waitFor(() => expect(screen.getByText("Halloween")).toBeTruthy(), { timeout: 5000 });
		// Live and past events have a report; the upcoming one doesn't.
		expect(screen.getAllByText("Lift report")).toHaveLength(2);
		fireEvent.click(screen.getAllByText("Lift report")[1] as HTMLElement);
		await waitFor(() => expect(screen.getByTestId("verdict").textContent).toBe(REPORT.verdict), { timeout: 5000 });
		expect(get).toHaveBeenCalledWith("ev_past000000", { weeks: 3, afterDays: 3 }, expect.anything());
		expect(screen.getByText("Playtime per player")).toBeTruthy();
		expect(screen.getByText("+18%")).toBeTruthy();
	});
});

describe("helpers", () => {
	test("UTC inputs, formats, values", () => {
		expect(utcInputToIso("2026-11-21T12:00")).toBe("2026-11-21T12:00:00.000Z");
		expect(utcInputToIso("")).toBeUndefined();
		expect(fmtUtc("2026-11-21T12:00:00.000Z")).toBe("Sat 2026-11-21 12:00 UTC");
		expect(fmtLift(0.184)).toBe("+18%");
		expect(fmtLift(-0.031)).toBe("-3%");
		expect(fmtLift(-0.001)).toBe("+0%");
		expect(fmtLift(null)).toBe("–");
		expect(parseValues('{"a":1}')).toEqual({ a: 1 });
		expect(() => parseValues("[]")).toThrow(/object/);
		expect(() => parseValues("{}")).toThrow(/object/);
	});

	test("chart marks: a start and an end line in range; never-run cancelled events left out; an early cancel ends then", () => {
		const from = Date.parse("2026-11-01T00:00:00Z");
		const to = Date.parse("2026-11-30T00:00:00Z");
		const marks = liveEventMarks(EVENTS, from, to);
		expect(marks.map((m) => m.id)).toEqual(["event:ev_live000000:start", "event:ev_live000000:end", "event:ev_next000000:start", "event:ev_next000000:end", "event:ev_past000000:end"]);
		expect(marks[0]).toMatchObject({ kind: "event", message: "Double cash starts", seq: null });
		const cancelledEarly = { ...(EVENTS[0] as LiveEvent), status: "cancelled" as const, cancelledAt: "2026-11-15T00:00:00.000Z" };
		expect(liveEventMarks([cancelledEarly], from, to).map((m) => m.time)).toEqual(["2026-11-14T12:00:00.000Z", "2026-11-15T00:00:00.000Z"]);
		const neverRan = { ...(EVENTS[1] as LiveEvent), status: "cancelled" as const, cancelledAt: "2026-11-15T00:00:00.000Z" };
		expect(liveEventMarks([neverRan], from, to)).toEqual([]);
	});

	test("the signed record line", () => {
		expect(signedText({ state: "unconfigured", readAt: "" })).toMatch(/OPENCLOUD_API_KEY/);
		expect(signedText({ ...VIEW.signed, verified: "unchecked" })).toMatch(/signature not checked/);
		expect(signedText({ ...VIEW.signed, verified: "no" })).toMatch(/servers refuse it/);
	});
});
