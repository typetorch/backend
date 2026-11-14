// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "@/lib/api";
import { ErrorDropRules, exactRuleFor, newRuleId } from "./ErrorDropRules";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe("drop rules", () => {
	test("an exact rule escapes quotes and backslashes; new ids don't collide", () => {
		expect(exactRuleFor('Failed "x" at C:\\a')).toBe('message = "Failed \\"x\\" at C:\\\\a"');
		expect(newRuleId([{ id: "r1" }, { id: "r3" }])).toBe("r4");
		expect(newRuleId([])).toBe("r1");
	});

	test("lists rules with their counts; viewers get no controls", async () => {
		vi.spyOn(api, "errorDropRules").mockResolvedValue({
			rules: [
				{ id: "mesh", expr: 'message contains "mesh"', note: "asset noise", on: true },
				{ id: "bad", expr: "nope", on: true, error: "expected a field" },
			],
			counts: { mesh: { items: 3, occurrences: 40, lastAt: Date.now() } },
			since: new Date().toISOString(),
			source: "dashboard",
		});
		wrap(<ErrorDropRules canEdit={false} />);
		await waitFor(() => expect(screen.getByText('message contains "mesh"')).toBeTruthy());
		expect(screen.getByText("asset noise")).toBeTruthy();
		expect(screen.getByText(/Dropped 3 reports \(40 errors\)/)).toBeTruthy();
		expect(screen.getByText("Not applied: expected a field")).toBeTruthy();
		expect(screen.queryByText("Add rule")).toBeNull();
		expect(screen.queryByText("Delete")).toBeNull();
	});

	test("owners: a prefilled draft is previewed", async () => {
		vi.spyOn(api, "errorDropRules").mockResolvedValue({ rules: [], counts: {}, since: new Date().toISOString(), source: "default" });
		const preview = vi.spyOn(api, "previewDropRule").mockResolvedValue({ ok: true, days: 7, kinds: 10, matchedKinds: 2, matchedOccurrences: 55, allOccurrences: 300, matches: [{ fp: "a", template: "Failed to load mesh 1", realm: "client", lastAt: "", occurrences: 50 }] });
		wrap(<ErrorDropRules canEdit draft='message contains "mesh"' />);
		await waitFor(() => expect(screen.getByText(/Would drop 2 kinds of the 10 stored/)).toBeTruthy(), { timeout: 2000 });
		expect(preview).toHaveBeenCalledWith('message contains "mesh"', expect.anything());
		expect(screen.getByText("Failed to load mesh 1")).toBeTruthy();
		expect(screen.getByText("Add rule")).toBeTruthy();
	});
});
