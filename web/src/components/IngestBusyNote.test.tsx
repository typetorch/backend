// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { BackendStats } from "@/lib/types";
import { IngestBusyNote } from "./IngestBusyNote";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

function mount(ingest: BackendStats["ingest"]) {
	const spy = vi.spyOn(api, "backendStats").mockResolvedValue({ now: NOW, ...(ingest ? { ingest } : {}) } as BackendStats);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const out = render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<IngestBusyNote />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { spy, ...out };
}

describe("IngestBusyNote", () => {
	it("shows while the backend answered busy in the last minute, with a link to Backend stats", async () => {
		const { spy } = mount({ busy: 4, inflight: 2, lastBusyAt: NOW - 15_000 });
		expect(await screen.findByText(/answered busy \(503\) to game servers in the last minute/)).toBeTruthy();
		expect(spy).toHaveBeenCalledWith("1m", expect.anything());
		expect(screen.getByRole("link", { name: "Backend stats" }).getAttribute("href")).toBe("/backend");
	});

	it("stays quiet when the last busy answer is older than a minute, never happened, or the server doesn't say", async () => {
		for (const ingest of [{ busy: 4, inflight: 0, lastBusyAt: NOW - 90_000 }, { busy: 0, inflight: 0, lastBusyAt: null }, undefined]) {
			const { spy, container, unmount } = mount(ingest);
			await waitFor(() => expect(spy).toHaveBeenCalled());
			await new Promise((r) => setTimeout(r, 0));
			expect(container.textContent).toBe("");
			unmount();
			vi.restoreAllMocks();
		}
	});
});
