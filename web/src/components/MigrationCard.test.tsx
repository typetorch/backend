// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, createApi } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AuthInfo, MigrateStatus } from "@/lib/types";
import { HistoryImportingBanner } from "./HistoryImportingBanner";
import { MigrationCard } from "./MigrationCard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const running: MigrateStatus = {
	state: "running",
	direction: "from-backend",
	source: { kind: "backend", url: "https://old.example.com" },
	startedAt: Date.now() - 600_000,
	finishedAt: null,
	rowsPerSecond: 20_000,
	rowsDone: 250_000,
	rowsTotal: 1_000_000,
	steps: [
		{ name: "identities", state: "done", done: 1200, total: 1200 },
		{ name: "events", state: "running", done: 3, total: 5, note: "2026-11-02 importing" },
		{ name: "verify", state: "pending", done: 0, total: 0 },
	],
	days: [
		{ table: "events", day: "2026-11-04", state: "match", rowsSource: 5000, rowsTarget: 5000, note: "" },
		{ table: "events", day: "2026-11-03", state: "differs", rowsSource: 4000, rowsTarget: 3990, note: "10 rows short" },
		{ table: "events", day: "2026-11-02", state: "importing", rowsSource: 3000, rowsTarget: 1000, note: "" },
		{ table: "events", day: "2026-11-01", state: "pending", rowsSource: 2000, rowsTarget: 0, note: "" },
	],
	waitingFor: null,
	decision: null,
	error: null,
};

function mount(node = <MigrationCard />, auth: AuthInfo | null = null) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<AuthProvider value={auth}>{node}</AuthProvider>
		</QueryClientProvider>,
	);
}

describe("MigrationCard", () => {
	it("shows the state, source, progress, steps and the per-day report", async () => {
		vi.spyOn(api, "migrateStatus").mockResolvedValue(running);
		mount();
		expect((await screen.findByTestId("migrate-state")).textContent).toBe("Running");
		expect(screen.getByText("https://old.example.com")).toBeTruthy();
		expect(screen.getByRole("progressbar", { name: "Rows copied" }).getAttribute("aria-valuenow")).toBe("25");
		expect(screen.getByText(/250,000 of 1,000,000 rows/)).toBeTruthy();
		expect(screen.getByText(/2 days left/)).toBeTruthy();
		const steps = screen.getByRole("table", { name: "Migration steps" });
		expect(within(steps).getByText("Identities")).toBeTruthy();
		expect(within(steps).getByText("3 / 5")).toBeTruthy();
		expect(within(steps).getByText("2026-11-02 importing")).toBeTruthy();
		const days = screen.getByRole("table", { name: "Per-day report" });
		expect(within(days).getAllByRole("row").length).toBe(5);
		expect(within(days).getByText("10 rows short")).toBeTruthy();
		expect(within(days).getByText("differs")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
	});

	it("Pause calls the backend and shows the answer; Cancel asks first", async () => {
		vi.spyOn(api, "migrateStatus").mockResolvedValue(running);
		const action = vi.spyOn(api, "migrateAction").mockResolvedValue({ ...running, state: "paused" });
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
		expect(action).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /Cancel the move\?/ })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Keep going/ }));

		fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
		await waitFor(() => expect(action).toHaveBeenCalledWith("pause"));
		expect((await screen.findByRole("button", { name: /Resume/ })).textContent).toContain("Resume");
		expect(screen.getByTestId("migrate-state").textContent).toBe("Paused");
	});

	it("confirmed cancel posts cancel; a 409 shows the server's reason", async () => {
		vi.spyOn(api, "migrateStatus").mockResolvedValue({ ...running, state: "paused" });
		const action = vi.spyOn(api, "migrateAction").mockRejectedValue(new ApiError(409, "nothing to cancel", "/v1/admin/migrate"));
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
		fireEvent.click(screen.getByRole("button", { name: /Cancel the move\?/ }));
		await waitFor(() => expect(action).toHaveBeenCalledWith("cancel"));
		expect(await screen.findByText("Not now: nothing to cancel")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
	});

	it("shows the waiting reason and the error", async () => {
		vi.spyOn(api, "migrateStatus").mockResolvedValue({ ...running, state: "failed", waitingFor: "the old server to answer", error: "source answered 401" });
		mount();
		expect(await screen.findByText("Waiting for: the old server to answer")).toBeTruthy();
		expect(screen.getByText("source answered 401")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
	});

	it("idle with no days: the explainer and the start form; the token field empties on submit", async () => {
		vi.spyOn(api, "migrateStatus").mockResolvedValue({ ...running, state: "idle", source: null, days: [], steps: [], rowsDone: 0, rowsTotal: 0 });
		const start = vi.spyOn(api, "migrateStart").mockResolvedValue(running);
		mount();
		expect(await screen.findByText(/Move to another server/)).toBeTruthy();
		const button = screen.getByRole("button", { name: /Start the move/ });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByLabelText("Old server URL"), { target: { value: "https://old.example.com" } });
		const token = screen.getByLabelText("Old server's admin token") as HTMLInputElement;
		expect(token.type).toBe("password");
		fireEvent.change(token, { target: { value: "fake-old-token" } });
		fireEvent.change(screen.getByLabelText("Rows per second"), { target: { value: "5000" } });
		fireEvent.click(button);
		await waitFor(() => expect(start).toHaveBeenCalledWith({ from: { kind: "backend", url: "https://old.example.com", token: "fake-old-token" }, rowsPerSecond: 5000 }));
		expect(token.value).toBe("");
		expect((await screen.findByTestId("migrate-state")).textContent).toBe("Running");
	});

	it("shows nothing on an older server (404) or a read-only session (403)", async () => {
		const spy = vi.spyOn(api, "migrateStatus").mockRejectedValue(new ApiError(404, "not found", "/v1/admin/migrate"));
		const { container } = mount();
		await waitFor(() => expect(spy).toHaveBeenCalled());
		await waitFor(() => expect(container.textContent).toBe(""));
	});

	it("migrateAction posts the action with the X-TypeTorch header", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(running), { status: 200 }));
		await createApi({ fetch: fetch as unknown as typeof globalThis.fetch }).migrateAction("pause");
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/api/v1/admin/migrate");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ action: "pause" });
		expect((init.headers as Record<string, string>)["x-typetorch"]).toBe("1");
	});
});

describe("HistoryImportingBanner", () => {
	const admin: AuthInfo = { ok: true, role: "admin", via: "cookie", user: { kind: "token" } };

	it("tells an admin that older history is still importing", async () => {
		vi.spyOn(api, "migrateStatus").mockResolvedValue(running);
		mount(<HistoryImportingBanner />, admin);
		expect(await screen.findByText("History before 2026-11-03 still importing")).toBeTruthy();
		expect(screen.getByText(/not a traffic drop/)).toBeTruthy();
	});

	it("doesn't ask for a read-only session, and shows nothing on an error", async () => {
		const spy = vi.spyOn(api, "migrateStatus").mockRejectedValue(new ApiError(500, "boom", "/v1/admin/migrate"));
		const { container, unmount } = mount(<HistoryImportingBanner />, { ...admin, role: "web" });
		expect(spy).not.toHaveBeenCalled();
		expect(container.textContent).toBe("");
		unmount();
		const second = mount(<HistoryImportingBanner />, admin);
		await waitFor(() => expect(spy).toHaveBeenCalled());
		expect(second.container.textContent).toBe("");
	});
});
