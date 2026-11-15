// @vitest-environment jsdom
/**
 * The recorded UI over the Player view: nodes at their rects scaled to the overlay's width (the top inset added), drawn
 * in the recorded order, text and rich text as spans, images from /api/v1/images/<id> (fetched: ready, or a placeholder
 * for engine content), and a click on a node selecting it for the Properties panel.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAssetImages } from "@/lib/asset-images";
import type { ExtUiNode } from "@/lib/types";
import { fontStack, rgba, UiOverlay, UiProperties } from "./UiOverlay";

const textStyle = { color: "#ffffff", transparency: 0, size: 20, family: "rbxasset://fonts/families/GothamSSm.json", weight: 700, xAlign: 0, yAlign: 1, scaled: false, wrapped: false, rich: true, strokeTransparency: 1, strokeColor: "#000000" };

const ui: ExtUiNode[] = [
	{ i: 0, cls: 0, from: 0, to: null, parent: null, f: { order: 0, rect: [0, 0, 800, 600] } },
	{ i: 1, cls: 1, from: 0, to: null, parent: 0, f: { rect: [100, 40, 200, 100], order: 1, background: { color: "#ff0000", transparency: 0 }, corner: 8, clip: true } },
	{ i: 2, cls: 2, from: 0, to: null, parent: 1, f: { rect: [120, 60, 100, 30], order: 2, text: "Coins <b>12</b>", textStyle, background: { color: "#000000", transparency: 1 } } },
	{ i: 3, cls: 5, from: 0, to: null, parent: 1, f: { rect: [250, 60, 100, 100], order: 3, image: "rbxasset://textures/ui/x.png", imageStyle: { color: "#ffffff", transparency: 0, scaleType: 0 } } },
	{ i: 4, cls: 5, from: 0, to: null, parent: 0, f: { rect: [400, 0, 50, 50], order: 4, image: "rbxassetid://123", imageStyle: { color: "#ffffff", transparency: 0, scaleType: 3 } } },
];

beforeEach(() => {
	clearAssetImages();
	Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
	URL.createObjectURL = vi.fn(() => "blob:image-123");
	URL.revokeObjectURL = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => (url.endsWith("/v1/images/123") ? new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } }) : new Response("", { status: 404 }))),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	// @ts-expect-error back to the prototype chain's own clientWidth
	delete HTMLElement.prototype.clientWidth;
});

const node = (i: number) => document.querySelector(`[data-ui="${i}"]`) as HTMLElement;

describe("UiOverlay", () => {
	it("scales the recorded viewport to its width and adds the top inset", () => {
		render(<UiOverlay ui={ui} t={0} viewport={{ w: 800, h: 600, inset: 36 }} />);
		expect(screen.getByTestId("ui-overlay").dataset.scale).toBe("0.500");
		const frame = node(1);
		expect(frame.style.left).toBe("50px");
		expect(frame.style.top).toBe("38px");
		expect(frame.style.width).toBe("100px");
		expect(frame.style.borderRadius).toBe("4px");
		expect(frame.style.backgroundColor).toBe("rgb(255, 0, 0)");
		expect(node(0)).toBeNull();
	});

	it("draws text and rich text as spans, in the recorded z-order, clipped by its parent", () => {
		render(<UiOverlay ui={ui} t={0} viewport={{ w: 800, h: 600, inset: 0 }} />);
		const label = node(2);
		expect(label.textContent).toBe("Coins 12");
		expect(label.querySelector("span span:last-child")?.getAttribute("style")).toContain("font-weight: 700");
		expect(Number(label.style.zIndex)).toBeGreaterThan(Number(node(1).style.zIndex));
		// the image beyond the frame's right edge (x 250..350, y 60..160 vs 100..300, 40..140) is cut at the frame's edges
		expect(node(3).style.clipPath).toBe("inset(0px 25px 10px 0px)");
	});

	it("draws engine content as a placeholder and a ready asset image from the images API", async () => {
		render(<UiOverlay ui={ui} t={0} viewport={{ w: 800, h: 600, inset: 0 }} />);
		expect(node(3).querySelector("[data-testid=ui-placeholder]")?.textContent).toContain("engine image");
		await waitFor(() => expect(node(4).querySelector("[data-testid=ui-image]")?.getAttribute("data-src")).toBe("blob:image-123"));
		expect(fetch).toHaveBeenCalledWith("/api/v1/images/123", expect.anything());
	});

	it("selects a node on click and shows its properties", () => {
		function Harness() {
			const [selected, setSelected] = useState<number | null>(null);
			return (
				<div>
					<UiOverlay ui={ui} t={0} viewport={{ w: 800, h: 600, inset: 0 }} selected={selected} onSelect={setSelected} />
					{selected !== null ? <UiProperties ui={ui} i={selected} t={0} /> : null}
				</div>
			);
		}
		render(<Harness />);
		fireEvent.click(node(2));
		const panel = screen.getByTestId("ui-properties");
		expect(panel.textContent).toContain("ScreenGui[1]/Frame[1]/TextLabel[1]");
		expect(panel.textContent).toContain("Coins <b>12</b>");
		expect(panel.textContent).toContain("GothamSSm 700, 20 px");
		expect(node(2).style.outline).toContain("solid");
		fireEvent.click(node(2));
		expect(screen.queryByTestId("ui-properties")).toBeNull();
	});
});

describe("helpers", () => {
	it("rgba and font stacks", () => {
		expect(rgba("#102030", 0.25)).toBe("rgba(16, 32, 48, 0.75)");
		expect(fontStack("rbxasset://fonts/families/GothamSSm.json")).toContain("Gotham");
		expect(fontStack("rbxasset://fonts/families/Weird.json")).toBe("'Weird', system-ui, sans-serif");
	});
});
