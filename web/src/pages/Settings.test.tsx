// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { RuntimeSetting, SettingsView } from "@/lib/types";
import Settings, { buildChanges, numberProblem, splitList } from "./Settings";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const NEW_HOOK = "https://discord.com/api/webhooks/123/made-up-secret-token-for-the-test";

const settings: RuntimeSetting[] = [
	{ key: "alertWebhookUrl", env: "TYPETORCH_ALERT_WEBHOOK_URL", group: "alerts", kind: "secret", label: "Alert webhook", help: "A Discord, Slack or JSON webhook (https).", source: "dashboard", set: true, fallbackSet: false },
	{ key: "alertWebhookFormat", env: "TYPETORCH_ALERT_WEBHOOK_FORMAT", group: "alerts", kind: "choice", label: "Webhook format", help: "auto picks from the URL.", source: "default", options: ["auto", "discord", "slack", "json"], value: "auto", fallback: "auto", fallbackSource: "default" },
	{ key: "alertWebhookLevels", env: "TYPETORCH_ALERT_WEBHOOK_LEVELS", group: "alerts", kind: "levels", label: "Alert levels sent", help: "Which levels.", source: "default", options: ["critical", "warning", "info"], value: ["critical"], fallback: ["critical"], fallbackSource: "default" },
	{ key: "adminAllowIps", env: "TYPETORCH_ADMIN_ALLOW_IPS", group: "access", kind: "ips", label: "Admin allow list", help: "Empty = any address.", source: "env", maxEntries: 64, value: ["203.0.113.7"], fallback: ["203.0.113.7"], fallbackSource: "env" },
	{ key: "tokenLogin", env: "TYPETORCH_TOKEN_LOGIN", group: "access", kind: "switch", label: "Admin token login", help: "The paste-the-token login.", source: "default", value: true, fallback: true, fallbackSource: "default" },
	{ key: "ipPerMinute", env: "TYPETORCH_IP_PER_MINUTE", group: "limits", kind: "number", label: "Ingest per address", help: "Per address.", source: "dashboard", min: 100, max: 1_000_000, unit: "requests / min", value: 8000, fallback: 6000, fallbackSource: "default" },
	{ key: "jobPerMinute", env: "TYPETORCH_JOB_PER_MINUTE", group: "limits", kind: "number", label: "Ingest per server", help: "Per JobId.", source: "env", min: 10, max: 100_000, unit: "requests / min", value: 90, fallback: 90, fallbackSource: "env" },
	{ key: "keepDays", env: "TYPETORCH_KEEP_DAYS", group: "retention", kind: "number", label: "Analytics history", help: "Days kept.", source: "default", min: 7, max: 36_500, zero: "forever", unit: "days", value: 400, fallback: 400, fallbackSource: "default" },
];

const view: SettingsView = {
	enabled: true,
	settings,
	envOnly: ["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN", "TYPETORCH_PUBLIC_URL"],
	audit: [
		{ at: "2026-10-09T11:00:00.000Z", who: "roblox user 1001 (OwnerName)", via: "session", action: "change", set: ["ipPerMinute"], reset: ["keepDays"] },
		{ at: "2026-10-09T10:00:00.000Z", who: "admin token", via: "bearer", action: "test-alert", result: "sent (HTTP 204)" },
	],
	you: { ip: "203.0.113.7", roblox: false },
	robloxSignIn: true,
};

function mount(data: SettingsView = view) {
	vi.spyOn(api, "settings").mockResolvedValue(data);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/settings"]}>
				<Settings />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}
const row = (key: string) => document.querySelector(`[data-setting="${key}"]`) as HTMLElement;
const findRow = (key: string) =>
	waitFor(() => {
		const el = row(key);
		if (!el) throw new Error(`no row ${key} yet`);
		return el;
	});
const saveButton = () => screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;

describe("Settings page", () => {
	it("groups the settings with their source, shows the webhook only as set, the env-only line and the audit list", async () => {
		mount();
		expect(await screen.findByText("Alerts")).toBeTruthy();
		for (const title of ["Access", "Rate limits", "Retention and error budgets", "Recent changes"]) expect(screen.getByText(title)).toBeTruthy();
		expect(within(row("ipPerMinute")).getByText("Dashboard")).toBeTruthy();
		expect(within(row("jobPerMinute")).getByText("Env")).toBeTruthy();
		expect(within(row("keepDays")).getByText("Default")).toBeTruthy();
		expect(within(row("keepDays")).getByText(/0 = forever/)).toBeTruthy();
		expect(within(row("ipPerMinute")).getByText("TYPETORCH_IP_PER_MINUTE")).toBeTruthy();
		// The webhook: "Set", a password field that starts empty, never a value.
		const hook = row("alertWebhookUrl");
		expect(within(hook).getByText("Set")).toBeTruthy();
		const input = within(hook).getByLabelText("Alert webhook") as HTMLInputElement;
		expect(input.type).toBe("password");
		expect(input.value).toBe("");
		expect(screen.getByText(/Environment only \(change these on Coolify and redeploy\)/)).toBeTruthy();
		expect(screen.getByText("TYPETORCH_API_KEY, TYPETORCH_ADMIN_TOKEN, TYPETORCH_PUBLIC_URL")).toBeTruthy();
		expect(screen.getByText("Set ipPerMinute")).toBeTruthy();
		expect(screen.getByText("Reset keepDays")).toBeTruthy();
		expect(screen.getByText(/Test alert: sent \(HTTP 204\)/)).toBeTruthy();
		expect(within(row("adminAllowIps")).getByText("203.0.113.7", { selector: "span" })).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
	});

	it("checks numbers against the bounds and saves only what changed", async () => {
		const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ ...view, changed: ["jobPerMinute"] });
		mount();
		const input = within(await findRow("jobPerMinute")).getByLabelText("Ingest per server") as HTMLInputElement;
		expect(input.value).toBe("90");
		fireEvent.change(input, { target: { value: "5" } });
		expect(within(row("jobPerMinute")).getByText("Must be from 10 to 100,000.")).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
		fireEvent.change(input, { target: { value: "120" } });
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenCalledWith({ jobPerMinute: 120 }));
		expect(await screen.findByText("Saved 1 setting; in effect now.")).toBeTruthy();
	});

	it("a new webhook URL goes in a password field that is emptied after the save; Clear and Reset to env", async () => {
		const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ ...view, changed: ["alertWebhookUrl"] });
		mount();
		const input = within(await findRow("alertWebhookUrl")).getByLabelText("Alert webhook") as HTMLInputElement;
		fireEvent.change(input, { target: { value: `  ${NEW_HOOK}  ` } });
		expect(within(row("alertWebhookUrl")).getByText("Unsaved")).toBeTruthy();
		// The test alert waits for the save (it uses the saved webhook).
		expect((screen.getByRole("button", { name: /send test alert/i }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenCalledWith({ alertWebhookUrl: NEW_HOOK }));
		await waitFor(() => expect((within(row("alertWebhookUrl")).getByLabelText("Alert webhook") as HTMLInputElement).value).toBe(""));
		expect(document.body.innerHTML).not.toContain("made-up-secret-token");
		// Clear: "" (no webhook); Reset to env on a dashboard value: null.
		fireEvent.click(within(row("alertWebhookUrl")).getByRole("button", { name: "Clear" }));
		expect(within(row("alertWebhookUrl")).getByText(/Cleared when you save/)).toBeTruthy();
		fireEvent.click(within(row("ipPerMinute")).getByRole("button", { name: /reset to env/i }));
		expect((within(row("ipPerMinute")).getByLabelText("Ingest per address") as HTMLInputElement).value).toBe("6000");
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenLastCalledWith({ alertWebhookUrl: "", ipPerMinute: null }));
	});

	it("shows the backend's refusal in its own words (the allow-list lockout guard)", async () => {
		const save = vi.spyOn(api, "saveSettings").mockRejectedValue(
			new ApiError(409, "refused: that admin allow list does not include your address (203.0.113.7), so it would lock you out", "/v1/admin/settings"),
		);
		mount();
		const area = within(await findRow("adminAllowIps")).getByLabelText("Admin allow list") as HTMLTextAreaElement;
		expect(area.value).toBe("203.0.113.7");
		expect(within(row("adminAllowIps")).getByText(/Your address as the backend sees it/)).toBeTruthy();
		fireEvent.change(area, { target: { value: "10.0.0.0/8\n198.51.100.1, 198.51.100.2" } });
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenCalledWith({ adminAllowIps: ["10.0.0.0/8", "198.51.100.1", "198.51.100.2"] }));
		expect(await screen.findByText("Not saved")).toBeTruthy();
		expect(screen.getByText(/would lock you out/)).toBeTruthy();
		// Nothing was lost: the typed list is still there to fix.
		expect((within(row("adminAllowIps")).getByLabelText("Admin allow list") as HTMLTextAreaElement).value).toContain("198.51.100.2");
	});

	it("the token login can only be turned off from a Roblox session", async () => {
		mount();
		const off = within(await findRow("tokenLogin")).getByRole("radio", { name: "Off" }) as HTMLButtonElement;
		expect(off.disabled).toBe(true);
		expect(within(row("tokenLogin")).getByText("To turn it off, sign in with Roblox first.")).toBeTruthy();
		cleanup();
		const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ ...view, changed: ["tokenLogin"], sessionsEnded: 2 });
		mount({ ...view, you: { ip: "203.0.113.7", roblox: true } });
		const enabled = within(await findRow("tokenLogin")).getByRole("radio", { name: "Off" }) as HTMLButtonElement;
		expect(enabled.disabled).toBe(false);
		fireEvent.click(enabled);
		// Levels and format are toggles too.
		fireEvent.click(within(row("alertWebhookLevels")).getByRole("button", { name: "warning" }));
		fireEvent.click(within(row("alertWebhookFormat")).getByRole("radio", { name: "slack" }));
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenCalledWith({ tokenLogin: false, alertWebhookLevels: ["critical", "warning"], alertWebhookFormat: "slack" }));
		expect(await screen.findByText(/2 browser sessions made with the admin token signed out/)).toBeTruthy();
	});

	it("sends a test alert through the saved webhook and says how it went", async () => {
		const testAlert = vi.spyOn(api, "testAlert").mockResolvedValueOnce({ ok: true, status: 204 });
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /send test alert/i }));
		expect(await screen.findByText("Test alert sent (HTTP 204).")).toBeTruthy();
		testAlert.mockRejectedValueOnce(new ApiError(429, "rate limited", "/v1/admin/settings/test-alert"));
		fireEvent.click(screen.getByRole("button", { name: /send test alert/i }));
		expect(await screen.findByText("Too many test alerts: wait a minute.")).toBeTruthy();
		testAlert.mockRejectedValueOnce(new ApiError(502, "the webhook answered HTTP 404", "/v1/admin/settings/test-alert"));
		fireEvent.click(screen.getByRole("button", { name: /send test alert/i }));
		expect(await screen.findByText("the webhook answered HTTP 404")).toBeTruthy();
	});

	it("is read only when the backend runs with TYPETORCH_RUNTIME_SETTINGS=off", async () => {
		mount({ ...view, enabled: false });
		expect(await screen.findByText("Read only")).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
		expect((within(row("jobPerMinute")).getByLabelText("Ingest per server") as HTMLInputElement).disabled).toBe(true);
		expect((within(row("alertWebhookUrl")).getByLabelText("Alert webhook") as HTMLInputElement).disabled).toBe(true);
	});

	it("names a failure to load", async () => {
		vi.spyOn(api, "settings").mockRejectedValue(new ApiError(404, "not found", "/v1/admin/settings"));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<Settings />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		expect(await screen.findByText("not found")).toBeTruthy();
	});
});

describe("settings helpers", () => {
	it("numberProblem: whole numbers inside the bounds, and 0 where it means forever", () => {
		const b = { min: 7, max: 100, zero: "forever" };
		expect(numberProblem(b, "7")).toBeNull();
		expect(numberProblem(b, " 100 ")).toBeNull();
		expect(numberProblem(b, "0")).toBeNull();
		expect(numberProblem(b, "6")).toBe("from 7 to 100 (or 0 = forever)");
		expect(numberProblem(b, "7.5")).toContain("a whole number");
		expect(numberProblem(b, "")).toContain("a whole number");
		expect(numberProblem({ min: 1, max: 10 }, "0")).toBe("from 1 to 10");
	});

	it("the support events list (plans/31) is edited as names, one per line, and saved as a list", async () => {
		const names: RuntimeSetting = { key: "players.supportEvents", env: "TYPETORCH_PLAYERS_SUPPORT_EVENTS", group: "keys", kind: "names", label: "Support events", help: "Event names a support key may read.", source: "default", maxEntries: 64, value: ["ac_flag", "join"], fallback: ["ac_flag", "join"], fallbackSource: "default" };
		const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ ...view, changed: ["players.supportEvents"] });
		mount({ ...view, settings: [...settings, names] });
		const field = within(await findRow("players.supportEvents")).getByRole("textbox") as HTMLTextAreaElement;
		expect(field.value).toBe("ac_flag\njoin");
		expect(screen.getByText("API keys")).toBeTruthy();
		fireEvent.change(field, { target: { value: "ac_flag\nac_action, leave" } });
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenCalledWith({ "players.supportEvents": ["ac_flag", "ac_action", "leave"] }));
	});

	it("splitList and buildChanges", () => {
		expect(splitList(" 10.0.0.0/8,\n203.0.113.7  2001:db8::/32 ")).toEqual(["10.0.0.0/8", "203.0.113.7", "2001:db8::/32"]);
		expect(splitList("")).toEqual([]);
		const { changes, problems } = buildChanges(settings, { ipPerMinute: "9000", keepDays: null, adminAllowIps: "", tokenLogin: true, nope: 1 }, "");
		expect(changes).toEqual({ ipPerMinute: 9000, keepDays: null, adminAllowIps: [], tokenLogin: true });
		expect(problems).toEqual({});
		expect(buildChanges(settings, { jobPerMinute: "1" }, "http://insecure.example").problems).toEqual({ jobPerMinute: "from 10 to 100,000", alertWebhookUrl: "an https:// URL" });
	});
});
