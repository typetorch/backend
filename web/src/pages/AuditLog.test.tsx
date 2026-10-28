// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { canSee, findNavItem } from "@/lib/nav";
import type { AuditEntry, AuditPage } from "@/lib/types";
import AuditLogPage, { auditSummary } from "./AuditLog";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const entry = (id: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
	id,
	at: new Date(Date.UTC(2026, 9, 27, 12, 0, id)).toISOString(),
	actor: "admin token",
	actorKind: "token",
	userId: null,
	role: "admin",
	via: "bearer",
	ip: "198.51.100.7",
	action: "settings.change",
	outcome: "ok",
	status: 200,
	details: { changes: [{ key: "ipPerMinute", from: 6000, to: 8000, source: "dashboard" }] },
	...over,
});

function mount(pages: AuditPage[], url = "/audit") {
	const spy = vi.spyOn(api, "audit");
	for (const p of pages) spy.mockResolvedValueOnce(p);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>
				<AuditLogPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return spy;
}

describe("auditSummary", () => {
	it("settings as old -> new, lists as added / removed, the secret as set", () => {
		expect(
			auditSummary({
				action: "settings.change",
				details: {
					changes: [
						{ key: "alertWebhookUrl", from: "not set", to: "set" },
						{ key: "ipPerMinute", from: 6000, to: 8000 },
						{ key: "webViewers", added: [9], removed: [1] },
					],
				},
			}),
		).toBe("alertWebhookUrl: not set -> set; ipPerMinute: 6000 -> 8000; webViewers: +9 -1");
		expect(auditSummary({ action: "access.owners", details: { seq: 2, added: [7], removed: [] } })).toBe("seq 2; added 7");
		expect(auditSummary({ action: "sign-in", details: null })).toBe("");
		expect(auditSummary({ action: "sign-in", details: { method: "token" } })).toContain("token");
	});
});

describe("the Audit log page", () => {
	it("is an owner-only admin page", () => {
		const item = findNavItem("/audit");
		expect(item?.label).toBe("Audit log");
		expect(canSee(item!, { role: "admin" })).toBe(true);
		expect(canSee(item!, { role: "web" })).toBe(false);
	});

	it("lists entries, asks for facets on the first page, and loads older pages", async () => {
		const spy = mount([
			{ entries: [entry(2), entry(1, { action: "sign-in", outcome: "failed", status: 401, actor: "anonymous", role: "none", details: { method: "token" } })], next: 1, keepDays: 365, facets: { actors: [{ actor: "admin token", kind: "token", entries: 2 }], actions: [{ action: "sign-in", entries: 1 }] } },
			{ entries: [entry(0, { action: "sign-out", details: null })], next: null, keepDays: 365 },
		]);
		expect(await screen.findByText("ipPerMinute: 6000 -> 8000")).toBeTruthy();
		expect(screen.getByText("failed 401")).toBeTruthy();
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ facets: true, limit: 100 });
		fireEvent.click(screen.getByRole("button", { name: "Load older entries" }));
		expect(await screen.findByText("sign-out")).toBeTruthy();
		expect(spy.mock.calls[1]?.[0]).toMatchObject({ before: 1 });
		await waitFor(() => expect(screen.getByText(/That is everything kept/)).toBeTruthy());
	});

	it("takes its filters from the URL", async () => {
		const spy = mount([{ entries: [], next: null, keepDays: 30, facets: { actors: [], actions: [] } }], "/audit?actor=admin%20token&action=sign-in&outcome=failed");
		expect(await screen.findByText("No entries match these filters.")).toBeTruthy();
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ actor: "admin token", action: "sign-in", outcome: "failed" });
	});
});
