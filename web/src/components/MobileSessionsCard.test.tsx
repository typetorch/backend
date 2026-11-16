// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { MobileTokenList } from "@/lib/types";
import { fmtIn, MobileSessionsCard, tokenUser } from "./MobileSessionsCard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const list: MobileTokenList = {
	lifetimeDays: 60,
	tokens: [
		{ id: "abcdefghij", device: "Pixel 9", user: { kind: "roblox", userId: 1001, name: "OwnerName" }, role: "admin", createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-12-31T10:00:00.000Z", lastUsedAt: null },
		{ id: "klmnopqrst", device: "iPhone", user: { kind: "token" }, role: "admin", createdAt: "2026-11-02T10:00:00.000Z", expiresAt: "2027-01-01T10:00:00.000Z", lastUsedAt: "2026-11-03T10:00:00.000Z", current: true },
	],
};

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MobileSessionsCard />
		</QueryClientProvider>,
	);
}

describe("Mobile app sessions", () => {
	it("lists the tokens (device, who, role) and revokes one", async () => {
		vi.spyOn(api, "mobileTokens").mockResolvedValue(list);
		const revoke = vi.spyOn(api, "revokeMobileToken").mockResolvedValue({ ok: true, lifetimeDays: 60, tokens: [list.tokens[1] as MobileTokenList["tokens"][number]] });
		mount();
		expect(await screen.findByText("Pixel 9")).toBeTruthy();
		expect(screen.getByText("iPhone")).toBeTruthy();
		expect(screen.getByText("OwnerName (1001)")).toBeTruthy();
		expect(screen.getByText("Admin token")).toBeTruthy();
		expect(screen.getByText("This app")).toBeTruthy();
		expect(screen.getByText("never")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Revoke Pixel 9" }));
		await waitFor(() => expect(revoke).toHaveBeenCalledWith("abcdefghij"));
		await waitFor(() => expect(screen.queryByText("Pixel 9")).toBeNull());
	});

	it("revokes every session after a confirmation, and only then", async () => {
		vi.spyOn(api, "mobileTokens").mockResolvedValue(list);
		const all = vi.spyOn(api, "revokeAllMobileTokens").mockResolvedValue({ ok: true, revoked: 2, lifetimeDays: 60, tokens: [] });
		mount();
		expect(await screen.findByText("Pixel 9")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Revoke all" }));
		const dialog = screen.getByRole("alertdialog", { name: "Revoke all 2 mobile app sessions?" });
		expect(dialog.textContent).toContain("signs out at once");
		expect(all).not.toHaveBeenCalled();
		// Cancel closes it without revoking.
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(all).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Revoke all" }));
		const confirm = screen.getAllByRole("button", { name: "Revoke all" }).find((b) => screen.getByRole("alertdialog").contains(b)) as HTMLElement;
		fireEvent.click(confirm);
		await waitFor(() => expect(all).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Revoked 2 mobile app sessions.")).toBeTruthy();
		await waitFor(() => expect(screen.queryByText("Pixel 9")).toBeNull());
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.getByText(/No phone is signed in/)).toBeTruthy();
	});

	it("says so when no phone is signed in (and offers no Revoke all)", async () => {
		vi.spyOn(api, "mobileTokens").mockResolvedValue({ tokens: [], lifetimeDays: 45 });
		mount();
		expect(await screen.findByText(/No phone is signed in/)).toBeTruthy();
		expect(screen.getByText(/lasts 45 days/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Revoke all" })).toBeNull();
	});

	it("formats who and when", () => {
		expect(tokenUser({ ...(list.tokens[0] as MobileTokenList["tokens"][number]), user: { kind: "roblox", userId: 7, name: "A", login: "typetorch.dev" } })).toBe("A (7) via typetorch.dev");
		const now = Date.UTC(2026, 10, 1);
		expect(fmtIn(new Date(now + 3 * 86_400_000).toISOString(), now)).toBe("in 3 d");
		expect(fmtIn(new Date(now + 2 * 3_600_000).toISOString(), now)).toBe("in 2 h");
		expect(fmtIn(new Date(now - 1000).toISOString(), now)).toBe("expired");
	});
});
