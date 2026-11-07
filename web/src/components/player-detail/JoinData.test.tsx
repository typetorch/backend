// @vitest-environment jsdom
/** Plans/30: the raw join data on the Timeline's join rows: pretty-printed and collapsed, `trunc` as a badge, nothing without it. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JoinData, joinDataOf } from "./JoinData";

const jd = {
	keys: ["GameJoinContext", "LaunchData", "SourcePlaceId"],
	LaunchData: "tt1n.abc0123xyz.gift_new.21i3v9.t5chpc.bWFpbDo0Mg.qHiEc9Cd2kb-f4921kh__g",
	LaunchDataLen: 74,
	SourcePlaceId: 123,
	GameJoinContext: { JoinSource: "ExperienceNotification" },
};

afterEach(cleanup);

describe("JoinData", () => {
	it("shows the jd pretty-printed in a collapsed, monospace block", () => {
		render(<JoinData jd={jd} />);
		const summary = screen.getByText("Join data");
		expect(screen.getByText("GameJoinContext, LaunchData, SourcePlaceId")).toBeTruthy();
		const details = summary.closest("details") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		const pre = details.querySelector("pre") as HTMLPreElement;
		expect(pre.className).toContain("font-mono");
		expect(pre.textContent).toBe(JSON.stringify(jd, null, 2));
		fireEvent.click(summary);
		expect(screen.queryByText("truncated")).toBeNull();
	});

	it("marks a cut copy with a truncated badge", () => {
		render(<JoinData jd={{ ...jd, trunc: true }} />);
		expect(screen.getByText("truncated")).toBeTruthy();
	});

	it("shows nothing without a jd", () => {
		const { container } = render(<JoinData jd={undefined} />);
		expect(container.innerHTML).toBe("");
		expect(joinDataOf({ from: "direct" })).toBeUndefined();
		expect(joinDataOf({ jd: "text" })).toBeUndefined();
		expect(joinDataOf(null)).toBeUndefined();
		expect(joinDataOf({ jd })).toEqual(jd);
	});
});
