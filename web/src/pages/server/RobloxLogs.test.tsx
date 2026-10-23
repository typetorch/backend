// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RobloxRestarts, RESTARTS_OFF_TEXT, restartTone } from "@/components/RobloxRestarts";
import { api, ApiError } from "@/lib/api";
import type { RobloxServerLogs } from "@/lib/types";
import { fieldsText, ROBLOX_LOGS_OFF_TEXT, RobloxLogs, severityTone } from "./RobloxLogs";

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

const JOB = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";

function wrap(node: React.ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>{node}</MemoryRouter>
		</QueryClientProvider>,
	);
}

const page = (over: Partial<RobloxServerLogs> = {}): RobloxServerLogs => ({
	jobId: JOB,
	placeId: 1,
	placeVersion: 412,
	logs: [{ time: "2026-10-09T12:00:00.000Z", severity: "Error", message: "<b>boom</b> at Script:3", count: 3, stack: null, placeVersion: 412, fields: {} }],
	nextPageToken: null,
	cached: false,
	...over,
});

describe("RobloxLogs", () => {
	it("shows Roblox's entries as text, loads the next page and searches", async () => {
		const spy = vi.spyOn(api, "robloxServerLogs").mockImplementation(async (_job, params = {}) =>
			params.pageToken ? page({ logs: [{ time: null, severity: "Warning", message: "second page", count: null, stack: null, placeVersion: 412, fields: { region: "eu" } }] }) : page({ nextPageToken: "p2" }),
		);
		wrap(<RobloxLogs job={JOB} placeVersion={412} />);
		expect(await screen.findByText("<b>boom</b> at Script:3")).toBeTruthy();
		expect(spy.mock.calls[0]?.[1]).toEqual({ placeVersion: 412 });
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("second page")).toBeTruthy();
		expect(spy.mock.calls.at(-1)?.[1]).toEqual({ pageToken: "p2", placeVersion: 412 });
		fireEvent.change(screen.getByLabelText("Search Roblox logs"), { target: { value: " boom " } });
		fireEvent.submit(screen.getByRole("search"));
		await waitFor(() => expect(spy.mock.calls.at(-1)?.[1]).toEqual({ search: "boom", placeVersion: 412 }));
	});

	it("an older kernel: asks for the place version, then shows the logs", async () => {
		const spy = vi.spyOn(api, "robloxServerLogs").mockImplementation(async (_job, params = {}) => {
			if (!params.placeVersion) throw new ApiError(409, "the server's place version isn't known", "/x", { error: "x", placeId: 1, placeVersion: null });
			return page();
		});
		wrap(<RobloxLogs job={JOB} />);
		fireEvent.change(await screen.findByLabelText("Place version"), { target: { value: "41x2" } });
		fireEvent.click(screen.getByRole("button", { name: "Show logs" }));
		expect(await screen.findByText("<b>boom</b> at Script:3")).toBeTruthy();
		expect(spy.mock.calls.at(-1)?.[1]).toEqual({ placeVersion: 412 });
	});

	it("not set up on the backend: says what to set", async () => {
		vi.spyOn(api, "robloxServerLogs").mockRejectedValue(new ApiError(409, "Roblox server management is off", "/x", { error: "off" }));
		wrap(<RobloxLogs job={JOB} placeVersion={1} />);
		expect(await screen.findByText(ROBLOX_LOGS_OFF_TEXT)).toBeTruthy();
	});

	it("tones and fields", () => {
		expect(severityTone("LOG_SEVERITY_ERROR")).toContain("critical");
		expect(severityTone("Warning")).toContain("warning");
		expect(severityTone(null)).toBe("bg-muted-foreground");
		expect(fieldsText({ a: 1, b: "x" })).toBe("a=1  b=x");
		expect(restartTone("IN_PROGRESS")).toContain("warning");
		expect(restartTone("Completed")).toContain("good");
	});
});

describe("RobloxRestarts", () => {
	it("lists restarts with their state", async () => {
		vi.spyOn(api, "robloxRestarts").mockResolvedValue([{ id: "r1", state: "IN_PROGRESS", startedAt: "2026-10-09T11:00:00.000Z", endedAt: null, fields: { "remaining.servers": 12 } }]);
		wrap(<RobloxRestarts />);
		expect(await screen.findByText("IN_PROGRESS")).toBeTruthy();
		expect(screen.getByText("remaining.servers=12")).toBeTruthy();
	});

	it("not set up: says what to set", async () => {
		vi.spyOn(api, "robloxRestarts").mockRejectedValue(new ApiError(409, "off", "/x", { error: "off" }));
		wrap(<RobloxRestarts />);
		expect(await screen.findByText(RESTARTS_OFF_TEXT)).toBeTruthy();
	});
});
