// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, createApi } from "@/lib/api";
import type { BackupsStatus } from "@/lib/types";
import { BackupCard } from "./BackupCard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const status: BackupsStatus = {
	dir: "/data/backups",
	keep: 3,
	everyHours: 24,
	running: false,
	last: null,
	next: new Date(Date.now() + 3_600_000).toISOString(),
	backups: [{ name: "typetorch-backup-20261027T120000Z", createdAt: "2026-10-27T12:00:00.000Z", reason: "scheduled", bytes: 2048, files: 9, duckdb: true }],
	disk: { freeBytes: 20 * 1024 ** 3, totalBytes: 25 * 1024 ** 3, freePercent: 80, level: "ok", warnFreePercent: 15, criticalFreePercent: 5, at: "2026-10-27T12:00:00.000Z" },
};

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<BackupCard />
		</QueryClientProvider>,
	);
}

describe("BackupCard", () => {
	it("shows the schedule and the local backups; Back up now and Download call the backend", async () => {
		vi.spyOn(api, "backups").mockResolvedValue(status);
		const now = vi.spyOn(api, "backupNow").mockResolvedValue(status);
		const download = vi.spyOn(api, "downloadBackup").mockRejectedValue(new ApiError(429, "rate limited", "/v1/admin/backups/download"));
		mount();
		expect(await screen.findByText("typetorch-backup-20261027T120000Z")).toBeTruthy();
		expect(screen.getByText(/Every 24 hours, keeping the newest 3/)).toBeTruthy();
		expect(screen.getByText(/Disk: .* free/)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Back up now/ }));
		await waitFor(() => expect(now).toHaveBeenCalled());
		fireEvent.click(await screen.findByRole("button", { name: /Download backup/ }));
		expect(await screen.findByText(/Two a minute at most/)).toBeTruthy();
		expect(download).toHaveBeenCalled();
	});

	it("warns when the disk is filling up", async () => {
		vi.spyOn(api, "backups").mockResolvedValue({ ...status, disk: { ...status.disk!, freeBytes: 2 * 1024 ** 3, freePercent: 8, level: "warning" } });
		mount();
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText("The data disk is filling up")).toBeTruthy();
		expect(screen.getByText(/under 15%/)).toBeTruthy();
	});

	it("downloadBackup posts with the X-TypeTorch header and returns the file name", async () => {
		const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-disposition": 'attachment; filename="typetorch-backup-x.tar"' } }));
		const out = await createApi({ fetch: fetch as unknown as typeof globalThis.fetch }).downloadBackup();
		expect(out.name).toBe("typetorch-backup-x.tar");
		expect(out.blob.size).toBe(3);
		const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["x-typetorch"]).toBe("1");
	});
});
