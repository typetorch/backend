/**
 * The recorded UI drawn over the Player view (plans/36 phase 4): every visible GuiObject as an absolutely placed box at the
 * rectangle Roblox laid it out at, scaled from the recorded viewport to this element's width (the parent keeps the
 * recorded aspect). No layout is re-done here: the rects are AbsolutePosition / AbsoluteSize after Roblox's own layout.
 *
 * Best-effort choices:
 *   - Coordinates: AbsolutePosition is measured below the top bar inset (a ScreenGui with IgnoreGuiInset reports
 *     negative y at the very top), so a node's top is `rect.y + inset` on the full screen.
 *   - Clipping (ClipsDescendants, ScrollingFrame, CanvasGroup): rects are absolute and drawn flat, so a node is cut by a
 *     clip-path to the intersection of its clipping ancestors' rects (rotation is ignored for the cut).
 *   - UIGradient multiplies the object's colour in Roblox: drawn as a CSS linear-gradient in place of the background.
 *   - ImageColor3 (tint): a multiply layer masked by the image itself; ImageRect is in the image's pixels, assumed to be
 *     the thumbnail's (the backend's thumbnails keep the aspect, up to 700 px: big sprite sheets may be off).
 *   - Fonts: FontFace.Family (e.g. rbxasset://fonts/families/GothamSSm.json) to a CSS stack with web-safe fallbacks.
 *   - Rich text: parsed into spans (ui-state.ts richText), never set as HTML.
 * Only nodes that draw something take the pointer (an invisible full-screen container would block the 3D view): a click
 * selects a node, a click on the selected node or Escape clears it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "cn";
import { assetIdOf, useAssetImage } from "@/lib/asset-images";
import type { ExtUiFields, ExtUiNode } from "@/lib/types";
import { alwaysClips, isImageClass, isTextClass, richText, uiClassName, uiPath, uiStateAt, fieldsAt, type RichSpan, type UiNodeState } from "./ui-state";

export interface UiViewport {
	w: number;
	h: number;
	inset: number;
}

/** "#rrggbb" + transparency (0..1) as rgba(). */
export function rgba(hex: string | undefined, transparency = 0): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
	const v = m ? Number.parseInt(m[1] as string, 16) : 0xffffff;
	const a = Math.max(0, Math.min(1, 1 - transparency));
	return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${Number(a.toFixed(3))})`;
}

const FONT_STACKS: [RegExp, string][] = [
	[/^gotham/i, "Gotham, Montserrat, 'Helvetica Neue', Arial, sans-serif"],
	[/^montserrat/i, "Montserrat, 'Helvetica Neue', Arial, sans-serif"],
	[/^sourcesans/i, "'Source Sans Pro', 'Source Sans 3', Arial, sans-serif"],
	[/^(builder|builder sans)/i, "'Builder Sans', 'Source Sans 3', Arial, sans-serif"],
	[/^fredoka/i, "'Fredoka One', Fredoka, 'Arial Rounded MT Bold', sans-serif"],
	[/^luckiest/i, "'Luckiest Guy', Impact, sans-serif"],
	[/^(bangers|creepster|cartoon)/i, "Bangers, Impact, sans-serif"],
	[/^(robotomono|inconsolata|code|ubuntumono|jetbrains)/i, "'Roboto Mono', ui-monospace, Menlo, Consolas, monospace"],
	[/^roboto/i, "Roboto, Arial, sans-serif"],
	[/^(merriweather|garamond|crimson|antique|playfair)/i, "Merriweather, Georgia, serif"],
	[/^arial/i, "Arial, Helvetica, sans-serif"],
];

/** A CSS font-family for a FontFace.Family (or a rich text face). */
export function fontStack(family: string | undefined): string {
	const name = (/([\w-]+)\.json$/i.exec(family ?? "")?.[1] ?? family ?? "").replace(/[^\w -]/g, "");
	for (const [re, stack] of FONT_STACKS) if (re.test(name)) return stack;
	return name ? `'${name}', system-ui, sans-serif` : "system-ui, sans-serif";
}

const ALIGN = ["flex-start", "center", "flex-end"] as const;
const TEXT_ALIGN = ["left", "center", "right"] as const;

function gradientCss(g: NonNullable<ExtUiFields["gradient"]>, transparency: number): string | undefined {
	if (!g.keys.length) return undefined;
	const stops = g.keys.length === 1 ? [...g.keys, [1, g.keys[0]?.[1] ?? "#ffffff"] as [number, string]] : g.keys;
	return `linear-gradient(${90 + g.rotation}deg, ${stops.map(([at, color]) => `${rgba(color, transparency)} ${Math.round(at * 1000) / 10}%`).join(", ")})`;
}

/** Draws something (takes the pointer): a visible background, text, an image, a stroke, or a box class. */
function drawsSomething(s: UiNodeState): boolean {
	const f = s.fields;
	if (f.background && f.background.transparency < 1) return true;
	if (f.stroke && f.stroke.transparency < 1) return true;
	if (isTextClass(s.cls) && f.text) return true;
	if (isImageClass(s.cls) && f.image) return true;
	return s.cls === 8 || s.cls === 10;
}

export function UiOverlay({ ui, t, viewport, selected = null, onSelect, className }: { ui: ExtUiNode[]; t: number; viewport: UiViewport; selected?: number | null; onSelect?: (i: number | null) => void; className?: string }) {
	const host = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = host.current;
		if (!el) return;
		setWidth(el.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (selected === null || !onSelect) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onSelect(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selected, onSelect]);
	const scale = width > 0 && viewport.w > 0 ? width / viewport.w : 1;
	const nodes = useMemo(() => uiStateAt(ui, t), [ui, t]);
	const byI = useMemo(() => new Map(nodes.map((n) => [n.i, n])), [nodes]);
	return (
		<div ref={host} className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} data-testid="ui-overlay" data-scale={scale.toFixed(3)}>
			{nodes.map((s, z) =>
				s.cls === 0 || !s.fields.rect ? null : (
					<UiBox key={s.i} state={s} z={z + 1} scale={scale} inset={viewport.inset} clip={clipRect(s, byI)} selected={selected === s.i} onSelect={onSelect} />
				),
			)}
		</div>
	);
}

/** The intersection of the clipping ancestors' rects (screen px, inset applied later), or null. */
function clipRect(s: UiNodeState, byI: Map<number, UiNodeState>): [number, number, number, number] | null {
	let box: [number, number, number, number] | null = null;
	const seen = new Set<number>([s.i]);
	let up = s.parent === null ? undefined : byI.get(s.parent);
	while (up && !seen.has(up.i)) {
		seen.add(up.i);
		if (up.cls !== 0 && up.fields.rect && (up.fields.clip || alwaysClips(up.cls))) {
			const [x, y, w, h] = up.fields.rect;
			box = box ? [Math.max(box[0], x), Math.max(box[1], y), Math.min(box[2], x + w), Math.min(box[3], y + h)] : [x, y, x + w, y + h];
		}
		up = up.parent === null ? undefined : byI.get(up.parent);
	}
	return box;
}

function UiBox({ state, z, scale, inset, clip, selected, onSelect }: { state: UiNodeState; z: number; scale: number; inset: number; clip: [number, number, number, number] | null; selected: boolean; onSelect?: ((i: number | null) => void) | undefined }) {
	const f = state.fields;
	const [x, y, w, h] = f.rect as [number, number, number, number];
	const style: CSSProperties = {
		left: x * scale,
		top: (y + inset) * scale,
		width: Math.max(0, w * scale),
		height: Math.max(0, h * scale),
		zIndex: z,
	};
	if (f.rotation) style.transform = `rotate(${f.rotation}deg)`;
	const bg = f.background;
	if (bg && bg.transparency < 1) style.backgroundColor = rgba(bg.color, bg.transparency);
	if (f.gradient && bg && bg.transparency < 1) {
		const g = gradientCss(f.gradient, bg.transparency);
		if (g) style.backgroundImage = g;
	}
	if (f.corner) style.borderRadius = f.corner * scale;
	if (f.stroke && f.stroke.transparency < 1 && f.stroke.thickness > 0) style.boxShadow = `0 0 0 ${Math.max(0.5, f.stroke.thickness * scale)}px ${rgba(f.stroke.color, f.stroke.transparency)}`;
	if (clip) {
		const [cx0, cy0, cx1, cy1] = clip;
		if (cx1 <= cx0 || cy1 <= cy0) return null;
		const top = Math.max(0, cy0 - y) * scale;
		const left = Math.max(0, cx0 - x) * scale;
		const right = Math.max(0, x + w - cx1) * scale;
		const bottom = Math.max(0, y + h - cy1) * scale;
		if (top || left || right || bottom) style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
	}
	const interactive = onSelect !== undefined && drawsSomething(state);
	if (interactive) style.pointerEvents = "auto";
	if (selected) {
		style.outline = "2px solid #f59e0b";
		style.outlineOffset = 1;
	}
	let inner: ReactNode = null;
	if (isImageClass(state.cls) && f.image) inner = <UiImage fields={f} scale={scale} />;
	else if (state.cls === 8 || state.cls === 10) inner = <Placeholder label={uiClassName(state.cls)} />;
	if (isTextClass(state.cls) && f.text) inner = <UiText fields={f} scale={scale} />;
	return (
		<div
			className={cn("absolute box-border", interactive && "cursor-pointer")}
			style={style}
			data-testid="ui-node"
			data-ui={state.i}
			data-class={uiClassName(state.cls)}
			aria-label={interactive ? uiClassName(state.cls) : undefined}
			onClick={
				interactive
					? (e) => {
							e.stopPropagation();
							onSelect?.(selected ? null : state.i);
						}
					: undefined
			}
		>
			{inner}
		</div>
	);
}

function Placeholder({ label }: { label: string }) {
	return (
		<div className="flex h-full w-full items-center justify-center overflow-hidden border border-dashed border-muted-foreground/50 bg-muted/20" data-testid="ui-placeholder">
			<span className="truncate px-0.5 text-[9px] leading-none text-muted-foreground">{label}</span>
		</div>
	);
}

function UiText({ fields, scale }: { fields: ExtUiFields; scale: number }) {
	const s = fields.textStyle;
	const spans = useMemo<RichSpan[]>(() => (s?.rich ? richText(fields.text ?? "") : [{ text: fields.text ?? "" }]), [fields.text, s?.rich]);
	const size = (s?.size ?? 14) * scale;
	const style: CSSProperties = {
		display: "flex",
		width: "100%",
		height: "100%",
		justifyContent: ALIGN[s?.xAlign ?? 1],
		alignItems: ALIGN[s?.yAlign ?? 1],
		textAlign: TEXT_ALIGN[s?.xAlign ?? 1],
		color: rgba(s?.color ?? "#000000", s?.transparency ?? 0),
		fontSize: size,
		lineHeight: 1.1,
		fontFamily: fontStack(s?.family),
		fontWeight: s?.weight ?? 400,
		whiteSpace: s?.wrapped ? "pre-wrap" : "pre",
		overflowWrap: s?.wrapped ? "break-word" : "normal",
	};
	if (s && s.strokeTransparency < 1) {
		const c = rgba(s.strokeColor, s.strokeTransparency);
		const d = Math.max(0.5, scale);
		style.textShadow = `${d}px 0 ${c}, -${d}px 0 ${c}, 0 ${d}px ${c}, 0 -${d}px ${c}`;
	}
	return (
		<div style={style} data-testid="ui-text">
			<span>
				{spans.map((rs, k) => {
					if (rs.br) return <br key={k} />;
					const css: CSSProperties = {};
					if (rs.bold) css.fontWeight = 700;
					if (rs.weight) css.fontWeight = rs.weight;
					if (rs.italic) css.fontStyle = "italic";
					const deco = [rs.underline ? "underline" : "", rs.strike ? "line-through" : ""].filter(Boolean).join(" ");
					if (deco) css.textDecoration = deco;
					if (rs.color) css.color = rs.color;
					if (rs.size) css.fontSize = rs.size * scale;
					if (rs.face) css.fontFamily = fontStack(rs.face);
					if (rs.uppercase) css.textTransform = "uppercase";
					if (rs.smallcaps) css.fontVariant = "small-caps";
					return Object.keys(css).length ? (
						<span key={k} style={css}>
							{rs.text}
						</span>
					) : (
						<span key={k}>{rs.text}</span>
					);
				})}
			</span>
		</div>
	);
}

/** The natural size of a loaded image (null until it loads; jsdom never loads). */
function useNaturalSize(url: string | null): [number, number] | null {
	const [size, setSize] = useState<[number, number] | null>(null);
	useEffect(() => {
		setSize(null);
		if (!url || typeof Image === "undefined") return;
		const img = new Image();
		img.onload = () => setSize([img.naturalWidth, img.naturalHeight]);
		img.src = url;
		return () => {
			img.onload = null;
		};
	}, [url]);
	return size;
}

function UiImage({ fields, scale }: { fields: ExtUiFields; scale: number }) {
	const image = useAssetImage(fields.image);
	const url = image?.state === "ready" ? image.url : null;
	const natural = useNaturalSize(url);
	if (!url) {
		const label = image === null ? (fields.image?.startsWith("rbxasset://") ? "engine image" : "image") : image.state === "missing" ? "image unavailable" : "image loading";
		return <Placeholder label={`${label}${assetIdOf(fields.image) ? ` ${assetIdOf(fields.image)}` : ""}`} />;
	}
	const st = fields.imageStyle;
	const opacity = 1 - (st?.transparency ?? 0);
	const tinted = st && st.color.toLowerCase() !== "#ffffff";
	const [w, h] = (fields.rect ?? [0, 0, 0, 0]).slice(2) as [number, number];
	const r = fields.imageRect;
	const scaleType = st?.scaleType ?? 0;
	const layer: CSSProperties = { position: "absolute", inset: 0, backgroundImage: `url("${url}")`, backgroundRepeat: "no-repeat", opacity };
	if (scaleType === 1 && r && (r.slice[2] > r.slice[0] || r.slice[3] > r.slice[1]) && natural) {
		// 9-slice: border-image with the slice centre's margins (image px), drawn at the screen scale
		const [x0, y0, x1, y1] = r.slice;
		const [nw, nh] = natural;
		const edges = [y0, nw - x1, nh - y1, x0].map((v) => Math.max(0, v));
		return (
			<div
				data-testid="ui-image"
				data-src={url}
				style={{
					position: "absolute",
					inset: 0,
					opacity,
					borderStyle: "solid",
					borderWidth: edges.map((v) => `${v * scale}px`).join(" "),
					borderImageSource: `url("${url}")`,
					borderImageSlice: `${edges.join(" ")} fill`,
				}}
			/>
		);
	}
	if (r && r.size[0] > 0 && r.size[1] > 0 && natural) {
		const sx = (w * scale) / r.size[0];
		const sy = (h * scale) / r.size[1];
		layer.backgroundSize = `${natural[0] * sx}px ${natural[1] * sy}px`;
		layer.backgroundPosition = `${-r.offset[0] * sx}px ${-r.offset[1] * sy}px`;
	} else if (scaleType === 2) {
		layer.backgroundRepeat = "repeat";
		if (natural) layer.backgroundSize = `${natural[0] * scale}px ${natural[1] * scale}px`;
	} else if (scaleType === 3) {
		layer.backgroundSize = "contain";
		layer.backgroundPosition = "center";
	} else if (scaleType === 4) {
		layer.backgroundSize = "cover";
		layer.backgroundPosition = "center";
	} else layer.backgroundSize = "100% 100%";
	const tint: CSSProperties | null = tinted
		? {
				...layer,
				backgroundImage: "none",
				backgroundColor: st.color,
				mixBlendMode: "multiply",
				maskImage: `url("${url}")`,
				WebkitMaskImage: `url("${url}")`,
				maskSize: layer.backgroundSize as string | undefined,
				WebkitMaskSize: layer.backgroundSize as string | undefined,
				maskPosition: layer.backgroundPosition as string | undefined,
				WebkitMaskPosition: layer.backgroundPosition as string | undefined,
				maskRepeat: layer.backgroundRepeat,
				WebkitMaskRepeat: layer.backgroundRepeat,
			}
		: null;
	return (
		<div className="absolute inset-0 overflow-hidden" style={{ borderRadius: "inherit" }}>
			<div data-testid="ui-image" data-src={url} style={layer} />
			{tint ? <div style={tint} /> : null}
		</div>
	);
}

// Properties ----------------------------------------------------------------------------------------------------------------

function Swatch({ color, transparency }: { color: string; transparency?: number }) {
	return (
		<span className="inline-flex items-center gap-1">
			<span className="inline-block size-3 shrink-0 rounded-sm border" style={{ background: rgba(color, transparency ?? 0) }} />
			<span className="font-mono">{color}</span>
			{transparency ? <span className="text-muted-foreground">({Math.round(transparency * 100)}% transparent)</span> : null}
		</span>
	);
}

const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A light "Properties" for one recorded UI node at `t`: path, class, lifetime and every recorded field. */
export function UiProperties({ ui, i, t, className }: { ui: ExtUiNode[]; i: number; t: number; className?: string }) {
	const node = ui.find((n) => n.i === i);
	const f = fieldsAt(ui, i, t);
	if (!node || !f) return null;
	const rows: [string, ReactNode][] = [
		["Path", <span className="font-mono break-all">{uiPath(ui, i)}</span>],
		["Class", uiClassName(node.cls)],
		["Visible", `${fmtS(node.from)} to ${node.to === null ? "the end" : fmtS(node.to)}`],
	];
	if (f.rect) rows.push(["Rect", `${f.rect[0]}, ${f.rect[1]} · ${f.rect[2]} x ${f.rect[3]} px`]);
	if (f.rotation) rows.push(["Rotation", `${f.rotation} deg`]);
	if (f.order !== undefined) rows.push([node.cls === 0 ? "DisplayOrder" : "Draw order", f.order]);
	if (f.background) rows.push(["Background", <Swatch color={f.background.color} transparency={f.background.transparency} />]);
	if (f.text !== undefined) rows.push(["Text", <span className="break-words whitespace-pre-wrap">{f.text}</span>]);
	if (f.textStyle) {
		const s = f.textStyle;
		rows.push(["Text colour", <Swatch color={s.color} transparency={s.transparency} />]);
		rows.push(["Font", `${(/([\w-]+)\.json$/i.exec(s.family)?.[1] ?? s.family) || "?"} ${s.weight}, ${s.size} px`]);
		rows.push(["Alignment", `${TEXT_ALIGN[s.xAlign] ?? s.xAlign} / ${["top", "centre", "bottom"][s.yAlign] ?? s.yAlign}`]);
		const flags = [s.scaled && "scaled", s.wrapped && "wrapped", s.rich && "rich text"].filter(Boolean).join(", ");
		if (flags) rows.push(["Text flags", flags]);
		if (s.strokeTransparency < 1) rows.push(["Text stroke", <Swatch color={s.strokeColor} transparency={s.strokeTransparency} />]);
	}
	if (f.image !== undefined) rows.push(["Image", <span className="font-mono break-all">{f.image || "(none)"}</span>]);
	if (f.imageStyle) {
		rows.push(["Image colour", <Swatch color={f.imageStyle.color} transparency={f.imageStyle.transparency} />]);
		rows.push(["Scale type", ["Stretch", "Slice", "Tile", "Fit", "Crop"][f.imageStyle.scaleType] ?? f.imageStyle.scaleType]);
	}
	if (f.imageRect) {
		const r = f.imageRect;
		if (r.size[0] || r.size[1]) rows.push(["Image rect", `offset ${r.offset.join(", ")} · size ${r.size.join(" x ")}`]);
		if (r.slice.some((v) => v !== 0)) rows.push(["Slice centre", r.slice.join(", ")]);
	}
	if (f.stroke) rows.push(["Stroke", <span className="inline-flex items-center gap-1"><Swatch color={f.stroke.color} transparency={f.stroke.transparency} /> {f.stroke.thickness} px</span>]);
	if (f.corner) rows.push(["Corner", `${f.corner} px`]);
	if (f.clip) rows.push(["Clips descendants", "yes"]);
	if (f.gradient) rows.push(["Gradient", <span className="inline-flex flex-wrap gap-1">{f.gradient.keys.map(([at, c], k) => <span key={k}>{Math.round(at * 100)}% <Swatch color={c} /></span>)} · {f.gradient.rotation} deg</span>]);
	return (
		<div className={cn("max-h-80 overflow-auto rounded-md border bg-background p-2 text-xs", className)} data-testid="ui-properties">
			<div className="mb-1 font-medium">Properties</div>
			<dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-2 gap-y-1">
				{rows.map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="min-w-0">{value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
