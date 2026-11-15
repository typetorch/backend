/**
 * The recorded UI tree at a moment: alive windows, fields merged from the changes (a change replaces a whole field, a
 * reparent overrides the parent), the draw order (ScreenGui DisplayOrder, the ScreenGui first, then `order`), paths, and
 * rich text parsed into plain spans (never HTML).
 */
import { describe, expect, it } from "vitest";
import type { ExtUiNode } from "@/lib/types";
import { fieldsAt, richText, stripRichText, uiPath, uiStateAt } from "./ui-state";

const ui: ExtUiNode[] = [
	{ i: 0, cls: 0, from: 0, to: null, parent: null, f: { order: 5 } },
	{ i: 1, cls: 1, from: 0, to: null, parent: 0, f: { rect: [0, 0, 100, 100], order: 2, background: { color: "#ff0000", transparency: 0 } } },
	{
		i: 2,
		cls: 2,
		from: 100,
		to: 500,
		parent: 1,
		f: { rect: [10, 10, 50, 20], order: 3, text: "a", textStyle: { color: "#000000", transparency: 0, size: 14, family: "", weight: 400, xAlign: 1, yAlign: 1, scaled: false, wrapped: false, rich: false, strokeTransparency: 1, strokeColor: "#000000" } },
		ch: [
			[300, { text: "c" }],
			[200, { text: "b", rect: [20, 20, 50, 20] }],
		],
	},
	{ i: 3, cls: 0, from: 0, to: null, parent: null, f: { order: 1 } },
	{ i: 4, cls: 1, from: 0, to: null, parent: 3, f: { rect: [0, 0, 10, 10], order: 9 }, ch: [[400, { parent: 1 }]] },
	{ i: 5, cls: 1, from: 0, to: null, parent: 0, f: { rect: [0, 0, 1, 1], order: 2 } },
];

describe("uiStateAt", () => {
	it("keeps only nodes alive at t (from inclusive, to exclusive)", () => {
		expect(uiStateAt(ui, 50).map((s) => s.i)).not.toContain(2);
		expect(uiStateAt(ui, 100).map((s) => s.i)).toContain(2);
		expect(uiStateAt(ui, 499).map((s) => s.i)).toContain(2);
		expect(uiStateAt(ui, 500).map((s) => s.i)).not.toContain(2);
	});

	it("merges changes up to t in time order, whole fields replaced", () => {
		const at = (t: number) => uiStateAt(ui, t).find((s) => s.i === 2)?.fields;
		expect(at(150)).toMatchObject({ text: "a", rect: [10, 10, 50, 20] });
		expect(at(250)).toMatchObject({ text: "b", rect: [20, 20, 50, 20], order: 3 });
		expect(at(300)).toMatchObject({ text: "c", rect: [20, 20, 50, 20] });
		expect(fieldsAt(ui, 2, 250)?.text).toBe("b");
		expect(fieldsAt(ui, 99, 0)).toBeNull();
	});

	it("draws by the ScreenGui's DisplayOrder, the ScreenGui first, then order, then i", () => {
		expect(uiStateAt(ui, 150).map((s) => s.i)).toEqual([3, 4, 0, 1, 5, 2]);
	});

	it("a reparent moves the node under its new ScreenGui", () => {
		const s = uiStateAt(ui, 450);
		expect(s.find((n) => n.i === 4)?.parent).toBe(1);
		expect(s.map((n) => n.i)).toEqual([3, 0, 1, 5, 2, 4]);
	});
});

describe("uiPath", () => {
	it("class names and the index among same-class siblings", () => {
		expect(uiPath(ui, 2)).toBe("ScreenGui[1]/Frame[1]/TextLabel[1]");
		expect(uiPath(ui, 5)).toBe("ScreenGui[1]/Frame[2]");
		expect(uiPath(ui, 4)).toBe("ScreenGui[2]/Frame[1]");
	});
});

describe("richText", () => {
	it("parses nested tags into styled spans", () => {
		expect(richText('a <b>b <i>c</i></b> <font color="#FF0000" size="20" weight="bold">d</font>')).toEqual([
			{ text: "a " },
			{ text: "b ", bold: true },
			{ text: "c", bold: true, italic: true },
			{ text: " " },
			{ text: "d", color: "#ff0000", size: 20, weight: 700 },
		]);
	});

	it("rgb colours, underline, strike, uppercase and line breaks", () => {
		expect(richText('<font color="rgb(255,0,0)">r</font><br/><u>u</u><s>s</s><uc>x</uc>')).toEqual([
			{ text: "r", color: "rgb(255, 0, 0)" },
			{ text: "\n", br: true },
			{ text: "u", underline: true },
			{ text: "s", strike: true },
			{ text: "x", uppercase: true },
		]);
	});

	it("decodes entities and keeps unknown tags' text as text", () => {
		expect(stripRichText("&lt;b&gt; &amp; &quot;q&quot; &apos;")).toBe("<b> & \"q\" '");
		expect(richText("<script>alert(1)</script> ok")).toEqual([{ text: "alert(1) ok" }]);
		expect(richText('<stroke color="#000" thickness="2">s</stroke>')).toEqual([{ text: "s" }]);
		expect(richText('<font color="javascript:alert(1)">x</font>')).toEqual([{ text: "x" }]);
	});

	it("plain text without tags is one span", () => {
		expect(richText("hello")).toEqual([{ text: "hello" }]);
	});
});
