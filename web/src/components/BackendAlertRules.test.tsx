// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { AlertRulesMeta, AlertRulesStatus, BackendAlertSettings, SettingsView } from "@/lib/types";
import Settings from "@/pages/Settings";
import { alertRulesChange, paramProblem, type AlertRulesDraft } from "./BackendAlertRules";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** Two rules of the real ones, enough to drive the page. */
const meta: AlertRulesMeta = {
	general: [
		{ key: "repeatMinutes", env: "TYPETORCH_BACKEND_ALERTS_REPEAT_MINUTES", label: "Repeat after", unit: "min", min: 5, max: 10_080, default: 180 },
		{ key: "perHour", env: "TYPETORCH_BACKEND_ALERTS_PER_HOUR", label: "At most", unit: "alerts / hour", min: 1, max: 120, default: 12 },
	],
	rules: [
		{
			id: "ccuDrop",
			code: "backend_ccu_drop",
			env: "TYPETORCH_ALERT_CCU_DROP",
			group: "players",
			label: "Players online drop",
			help: "Players online fall by this share within the window while servers are still up.",
			level: "critical",
			on: true,
			needs: ["fleet"],
			params: [
				{ key: "percent", env: "TYPETORCH_ALERT_CCU_DROP_PERCENT", label: "Drop", unit: "%", min: 10, max: 100, default: 50 },
				{ key: "minutes", env: "TYPETORCH_ALERT_CCU_DROP_MINUTES", label: "Within", unit: "min", min: 2, max: 120, default: 10 },
			],
		},
		{
			id: "ingestStopped",
			code: "backend_ingest_stopped",
			env: "TYPETORCH_ALERT_INGEST_STOPPED",
			group: "ingest",
			label: "Ingest stopped",
			help: "No analytics rows for the window after steady traffic.",
			level: "warning",
			on: true,
			needs: ["analytics"],
			params: [{ key: "minutes", env: "TYPETORCH_ALERT_INGEST_STOPPED_MINUTES", label: "No rows for", unit: "min", min: 3, max: 120, default: 10 }],
		},
		{
			id: "diskLow",
			code: "backend_disk_low",
			env: "TYPETORCH_ALERT_DISK_LOW",
			group: "disk",
			label: "Disk space low",
			help: "Free space below either threshold.",
			level: "critical",
			on: true,
			needs: [],
			params: [{ key: "gb", env: "TYPETORCH_ALERT_DISK_LOW_GB", label: "Or free below", unit: "GB", min: 1, max: 100_000, default: 2, zero: "off" }],
		},
	],
};

const value: BackendAlertSettings = {
	on: true,
	repeatMinutes: 180,
	perHour: 12,
	rules: {
		ccuDrop: { on: true, level: "critical", params: { percent: 50, minutes: 10 } },
		ingestStopped: { on: true, level: "warning", params: { minutes: 10 } },
		diskLow: { on: true, level: "critical", params: { gb: 2 } },
	},
};

const view: SettingsView = {
	enabled: true,
	settings: [
		{
			key: "backendAlerts",
			env: "TYPETORCH_BACKEND_ALERTS",
			group: "backendAlerts",
			kind: "alertRules",
			label: "Backend alert rules",
			help: "Alerts the backend raises from its own data.",
			source: "default",
			rules: meta,
			value,
			fallback: value,
			fallbackSource: "default",
		},
	],
	envOnly: ["TYPETORCH_API_KEY"],
	audit: [],
	you: { ip: "203.0.113.7", roblox: false },
	robloxSignIn: false,
};

const status: AlertRulesStatus = {
	on: true,
	tickSeconds: 60,
	lastRunAt: new Date(Date.now() - 20_000).toISOString(),
	lastRunMs: 3.2,
	raised: 2,
	deduped: 0,
	throttled: 1,
	failed: 0,
	rules: [
		{ id: "ccuDrop", state: "firing", note: "down 62%", lastRaisedAt: new Date(Date.now() - 60_000).toISOString() },
		{ id: "ingestStopped", state: "unavailable", note: "analytics aren't running", lastRaisedAt: null },
		{ id: "diskLow", state: "ok", note: "40.0 GB free (40.0%)", lastRaisedAt: null },
	],
};

function mount(rules: () => Promise<AlertRulesStatus> = () => Promise.resolve(status)) {
	vi.spyOn(api, "settings").mockResolvedValue(view);
	vi.spyOn(api, "alertRules").mockImplementation(rules);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/settings"]}>
				<Settings />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}
const rule = (id: string) => document.querySelector(`[data-rule="${id}"]`) as HTMLElement;
const findRule = (id: string) =>
	waitFor(() => {
		const el = rule(id);
		if (!el) throw new Error(`no rule ${id} yet`);
		return el;
	});
const saveButton = () => screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;

describe("alertRulesChange", () => {
	it("turns typed text into the value, or names the first problem", () => {
		const draft: AlertRulesDraft = { ...value, repeatMinutes: " 60 ", rules: { ...value.rules, ccuDrop: { on: false, level: "warning", params: { percent: "40", minutes: 10 } } } };
		expect(alertRulesChange(meta, draft)).toEqual({ value: { ...value, repeatMinutes: 60, rules: { ...value.rules, ccuDrop: { on: false, level: "warning", params: { percent: 40, minutes: 10 } } } } });
		expect(alertRulesChange(meta, { ...draft, perHour: "0" })).toEqual({ problem: "At most: from 1 to 120" });
		expect(alertRulesChange(meta, { ...draft, rules: { ...draft.rules, ccuDrop: { on: true, level: "critical", params: { percent: "5", minutes: 10 } } } })).toEqual({ problem: "Players online drop, Drop: from 10 to 100" });
	});

	it("paramProblem: whole numbers in bounds, 0 where it means off", () => {
		const gb = meta.rules[2]?.params[0] as AlertRulesMeta["general"][number];
		expect(paramProblem(gb, "0")).toBeNull();
		expect(paramProblem(gb, "2.5")).toBe("a whole number from 1 to 100,000 (or 0 = off)");
		expect(paramProblem(meta.general[1] as AlertRulesMeta["general"][number], 500)).toBe("from 1 to 120");
	});
});

describe("Settings page: backend alerts", () => {
	it("lists the rules by group with their state, env names and thresholds", async () => {
		mount();
		expect(await screen.findByText("Backend alerts")).toBeTruthy();
		const ccu = await findRule("ccuDrop");
		expect(within(ccu).getByText("Firing")).toBeTruthy();
		expect(within(ccu).getByText("TYPETORCH_ALERT_CCU_DROP")).toBeTruthy();
		expect(within(ccu).getByText(/Last run: down 62%; last raised/)).toBeTruthy();
		expect((within(ccu).getByLabelText("Players online drop: Drop") as HTMLInputElement).value).toBe("50");
		const ingest = rule("ingestStopped");
		expect(within(ingest).getByText("Unavailable")).toBeTruthy();
		expect(within(ingest).getByText("needs analytics")).toBeTruthy();
		expect(within(rule("diskLow")).getByText("OK")).toBeTruthy();
		for (const title of ["Players online", "Analytics ingest", "Disk"]) expect(screen.getByText(title)).toBeTruthy();
		expect(await screen.findByText(/2 alerts raised, 1 over the hourly cap since the start/)).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
	});

	it("turns a rule off, changes a level and a threshold, and saves the whole value", async () => {
		const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ ...view, changed: ["backendAlerts"] });
		mount();
		const ccu = await findRule("ccuDrop");
		fireEvent.click(within(ccu).getByRole("radio", { name: "Off" }));
		fireEvent.click(within(rule("ingestStopped")).getByRole("radio", { name: "critical" }));
		const percent = within(ccu).getByLabelText("Players online drop: Drop") as HTMLInputElement;
		fireEvent.change(percent, { target: { value: "5" } });
		expect(await screen.findByText("Must be a valid value (Players online drop, Drop: from 10 to 100).")).toBeTruthy();
		expect(percent.getAttribute("aria-invalid")).toBe("true");
		expect(saveButton().disabled).toBe(true);
		fireEvent.change(percent, { target: { value: "35" } });
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith({
				backendAlerts: {
					...value,
					rules: { ...value.rules, ccuDrop: { on: false, level: "critical", params: { percent: 35, minutes: 10 } }, ingestStopped: { on: true, level: "critical", params: { minutes: 10 } } },
				},
			}),
		);
	});

	it("the master switch and the general values; the level change is saved", async () => {
		const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ ...view, changed: ["backendAlerts"] });
		mount();
		await findRule("ccuDrop");
		fireEvent.click(within(rule("ingestStopped")).getByRole("radio", { name: "critical" }));
		fireEvent.click(within(screen.getByLabelText("Backend alerts on or off")).getByRole("radio", { name: "Off" }));
		fireEvent.change(screen.getByLabelText("Repeat after"), { target: { value: "30" } });
		fireEvent.click(saveButton());
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith({ backendAlerts: { ...value, on: false, repeatMinutes: 30, rules: { ...value.rules, ingestStopped: { on: true, level: "critical", params: { minutes: 10 } } } } }),
		);
	});

	it("without the rules' state (no fleet part) the rules still edit", async () => {
		mount(() => Promise.reject(new ApiError(404, "backend alerts need the fleet part (its alert store)", "/v1/admin/alert-rules")));
		const ccu = await findRule("ccuDrop");
		expect(await screen.findByText(/not available here/)).toBeTruthy();
		expect(within(ccu).queryByText("Firing")).toBeNull();
		expect((within(ccu).getByLabelText("Players online drop: Drop") as HTMLInputElement).disabled).toBe(false);
	});
});
