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
import { fontStack, gradientCss, gradientMask, gradientStops, rgba, UiOverlay, UiProperties } from "./UiOverlay";

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

describe("framework 0.7.3 fields: gradient transparency, CanvasGroup, UIScale", () => {
	// gnome's modal "Highlight" (prod sid 9801fd31): a white Frame, UIGradient white -> white, transparency 0.9 -> 1 (0.7) -> 1, rotation 90
	const highlight = { keys: [[0, "#ffffff"], [1, "#ffffff"]] as [number, string][], rotation: 90 };
	const highlightAlpha = { keys: [[0, 0.902], [0.702, 1], [1, 1]] as [number, number][], offset: [0, 0] as [number, number] };
	const white = { color: "#ffffff", transparency: 0 };

	it("merges colour and transparency keypoints onto one stop list, each interpolated at the other's times", () => {
		expect(
			gradientStops(
				[
					[0, "#ff0000"],
					[1, "#0000ff"],
				],
				[
					[0, 0],
					[0.5, 1],
					[1, 0.5],
				],
			),
		).toEqual([
			[0, "#ff0000", 0],
			[0.5, "#800080", 1],
			[1, "#0000ff", 0.5],
		]);
		expect(gradientStops(undefined, [[0.25, 0.5]])).toEqual([[0.25, "#ffffff", 0.5]]);
		expect(gradientStops([], [])).toEqual([]);
	});

	it("draws gnome's Highlight as a faint sheen, not an opaque white sheet", () => {
		expect(gradientCss(highlight, highlightAlpha, white)).toBe("linear-gradient(180deg, rgba(255, 255, 255, 0.098) 0%, rgba(255, 255, 255, 0) 70.2%, rgba(255, 255, 255, 0) 100%)");
		// before 0.7.3 (no transparency recorded) the same gradient is opaque
		expect(gradientCss(highlight, undefined, white)).toBe("linear-gradient(180deg, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 1) 100%)");
	});

	it("multiplies the gradient with the background colour and transparency, and shifts the stops by the Offset", () => {
		expect(gradientCss({ keys: [[0, "#ffffff"], [1, "#808080"]], rotation: 0 }, { keys: [[0, 0.5], [1, 0.5]], offset: [0, 0] }, { color: "#ff0000", transparency: 0.5 })).toBe(
			"linear-gradient(90deg, rgba(255, 0, 0, 0.25) 0%, rgba(128, 0, 0, 0.25) 100%)",
		);
		// Offset: along the direction moves the stops, across it changes nothing
		expect(gradientCss({ keys: [[0, "#000000"], [1, "#ffffff"]], rotation: 0 }, { keys: [], offset: [0.25, 0.4] }, white)).toBe("linear-gradient(90deg, rgba(0, 0, 0, 1) 25%, rgba(255, 255, 255, 1) 125%)");
		expect(gradientCss({ keys: [[0, "#000000"], [1, "#ffffff"]], rotation: 90 }, { keys: [], offset: [0, -0.25] }, white)).toBe("linear-gradient(180deg, rgba(0, 0, 0, 1) -25%, rgba(255, 255, 255, 1) 75%)");
	});

	it("masks text and images by the gradient's transparency (ring gauges)", () => {
		expect(gradientMask(highlight, undefined)).toBeUndefined();
		expect(gradientMask(highlight, { keys: [[0, 0], [1, 0]], offset: [0, 0] })).toBeUndefined();
		expect(gradientMask({ keys: [], rotation: 0 }, { keys: [[0, 0], [0.5, 0], [0.501, 1], [1, 1]], offset: [0, 0] })).toBe(
			"linear-gradient(90deg, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 1) 50%, rgba(0, 0, 0, 0) 50.1%, rgba(0, 0, 0, 0) 100%)",
		);
	});

	const scene: ExtUiNode[] = [
		{ i: 0, cls: 0, from: 0, to: null, parent: null, f: { order: 0, rect: [0, 0, 800, 600] } },
		{ i: 1, cls: 1, from: 0, to: null, parent: 0, f: { rect: [0, 0, 800, 600], order: 1, background: white, gradient: highlight, gradientAlpha: highlightAlpha } },
		{ i: 2, cls: 9, from: 0, to: null, parent: 0, f: { rect: [0, 0, 200, 200], order: 2, background: { color: "#000000", transparency: 0 }, group: { transparency: 0.5, color: "#ffffff" } } },
		{ i: 3, cls: 9, from: 0, to: null, parent: 2, f: { rect: [0, 0, 100, 100], order: 3, background: { color: "#000000", transparency: 0 }, group: { transparency: 0.5, color: "#ff0000" } } },
		{ i: 4, cls: 2, from: 0, to: null, parent: 3, f: { rect: [0, 0, 32, 32], order: 4, text: '$<font size="10">5</font>', textStyle: { ...textStyle, size: 32 }, textScale: 2 } },
		{ i: 5, cls: 9, from: 0, to: null, parent: 0, f: { rect: [0, 0, 50, 50], order: 5, background: { color: "#000000", transparency: 0 }, group: { transparency: 1, color: "#ffffff" } } },
		{ i: 6, cls: 2, from: 0, to: null, parent: 5, f: { rect: [0, 0, 50, 50], order: 6, text: "hidden", textStyle } },
		// a HUD hidden by UIScale 0: a 0x0 box whose text size is 0
		{ i: 7, cls: 2, from: 0, to: null, parent: 0, f: { rect: [300, 300, 0, 0], order: 7, text: "ghost", textStyle: { ...textStyle, size: 0 }, textScale: 0 } },
		{ i: 8, cls: 5, from: 0, to: null, parent: 0, f: { rect: [400, 0, 50, 50], order: 8, image: "rbxasset://textures/ui/ring.png", imageStyle: { color: "#ffffff", transparency: 0, scaleType: 0 }, gradient: { keys: [], rotation: 0 }, gradientAlpha: { keys: [[0, 0], [0.5, 0], [0.501, 1], [1, 1]], offset: [0, 0] } } },
	];

	it("draws the sheen in place of the plain background, multiplies CanvasGroup opacity down the tree, scales rich text by textScale", () => {
		render(<UiOverlay ui={scene} t={0} viewport={{ w: 800, h: 600, inset: 0 }} />);
		const sheen = node(1);
		expect(sheen.style.backgroundColor).toBe("");
		expect(sheen.getAttribute("style")).toContain("linear-gradient");
		expect(sheen.getAttribute("style")).not.toContain("rgba(255, 255, 255, 1)");
		expect(node(2).style.opacity).toBe("0.5");
		expect(node(3).style.opacity).toBe("0.25");
		expect(node(4).style.opacity).toBe("0.25");
		// a fully transparent group draws nothing
		expect(node(5)).toBeNull();
		expect(node(6)).toBeNull();
		// TextSize 16 × UIScale 2 recorded as 32; the rich <font size="10"> × 2, all × the 0.5 overlay scale
		const text = node(4).querySelector("[data-testid=ui-text]") as HTMLElement;
		expect(text.style.fontSize).toBe("16px");
		expect((text.querySelector("span span:last-child") as HTMLElement).style.fontSize).toBe("10px");
		expect(node(7).querySelector("[data-testid=ui-text]")).toBeNull();
		expect(node(8).querySelector("[data-testid=ui-gradient-mask]")).not.toBeNull();
		expect(node(1).querySelector("[data-testid=ui-gradient-mask]")).toBeNull();
	});

	it("lists the new fields in Properties", () => {
		render(
			<div>
				<UiProperties ui={scene} i={1} t={0} />
				<UiProperties ui={scene} i={3} t={0} />
				<UiProperties ui={scene} i={4} t={0} />
			</div>,
		);
		const text = screen.getAllByTestId("ui-properties").map((p) => p.textContent);
		expect(text[0]).toContain("Gradient transparency0%: 90%, 70%: 100%, 100%: 100%");
		expect(text[1]).toContain("50% transparent");
		expect(text[1]).toContain("#ff0000");
		expect(text[2]).toContain("UIScale2x");
	});
});

describe("helpers", () => {
	it("rgba and font stacks", () => {
		expect(rgba("#102030", 0.25)).toBe("rgba(16, 32, 48, 0.75)");
		expect(fontStack("rbxasset://fonts/families/GothamSSm.json")).toContain("Gotham");
		expect(fontStack("rbxasset://fonts/families/Weird.json")).toBe("'Weird', system-ui, sans-serif");
	});
});
