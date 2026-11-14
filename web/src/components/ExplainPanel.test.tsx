// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { d1Drop } from "@/lib/explain.fixture";
import { ExplainView } from "./ExplainPanel";

describe("the explain panel", () => {
	test("leads with the headline, then the most telling dimension's segments, ranked", () => {
		render(<ExplainView data={d1Drop()} />);
		expect(screen.getByTestId("explain-headline").textContent).toBe("D1 fell 4.1 points; 72% of it is phones (rate) and 15% is a bigger share of join source teleport (mix).");
		// Join source has the trusted segment explaining the most (direct, 80%): it opens first, in the server's order.
		const table = screen.getByRole("table", { name: "Join source segments" });
		const rows = within(table).getAllByRole("row").slice(1);
		expect(rows.map((r) => r.getAttribute("data-segment"))).toEqual(["teleport", "direct"]);
		expect(within(rows[0] as HTMLElement).getByText("-0.62 points")).toBeTruthy(); // the mix effect
		// Both periods' values up top.
		expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
		expect(screen.getAllByText("35.9%")).toHaveLength(1);
	});

	test("flags small segments, and a segment's name drills in (not `other`)", () => {
		const onDrill = vi.fn();
		const data = d1Drop();
		data.dimensions = [data.dimensions[1]!];
		render(<ExplainView data={data} onDrill={onDrill} />);
		const table = screen.getByRole("table", { name: "Device segments" });
		const rows = within(table).getAllByRole("row").slice(1);
		expect(rows.map((r) => r.getAttribute("data-segment"))).toEqual(["phone", "vr", "desktop", "Other (1)"]);
		expect(within(rows[1] as HTMLElement).getByText("few players")).toBeTruthy();
		expect(within(rows[3] as HTMLElement).queryByRole("button")).toBeNull();
		fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "phone" }));
		expect(onDrill).toHaveBeenCalledWith({ dimension: "device", value: "phone" });
	});
});
