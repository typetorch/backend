/**
 * A top-down map as SVG, in cell units (x to the right, z down): the walkable-area silhouette (every recorded sample's
 * density), then each layer as a heatmap (shaded cells) or dots (sized by count). A cell click reports its column and
 * row; overlays (the replay's path, dot and camera cone) draw in studs through `toView`.
 */
import type { ReactNode } from "react";
import type { RecCell, RecFrame } from "@/lib/types";
import { maxCount, shade } from "./map";

export interface DrawnLayer {
	id: string;
	label: string;
	color: string;
	cells: RecCell[];
}

export type ToView = (x: number, z: number) => [number, number];

export function MapView({
	frame,
	background,
	layers = [],
	mode = "heat",
	selected,
	onCellClick,
	overlay,
	label,
	className,
}: {
	frame: RecFrame;
	background: RecCell[];
	layers?: DrawnLayer[];
	mode?: "heat" | "dots";
	selected?: [number, number] | null;
	onCellClick?: (col: number, row: number) => void;
	overlay?: (toView: ToView) => ReactNode;
	label: string;
	className?: string;
}) {
	const toView: ToView = (x, z) => [(x - frame.minX) / frame.cell, (z - frame.minZ) / frame.cell];
	const bgMax = maxCount(background);
	const click = (e: React.MouseEvent<SVGSVGElement>) => {
		if (!onCellClick) return;
		const svg = e.currentTarget;
		const rect = svg.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		const col = Math.floor(((e.clientX - rect.left) / rect.width) * frame.cols);
		const row = Math.floor(((e.clientY - rect.top) / rect.height) * frame.rows);
		if (col >= 0 && row >= 0 && col < frame.cols && row < frame.rows) onCellClick(col, row);
	};
	return (
		<svg
			viewBox={`0 0 ${frame.cols} ${frame.rows}`}
			preserveAspectRatio="xMidYMid meet"
			role="img"
			aria-label={label}
			className={className ?? "h-auto max-h-[70vh] w-full rounded-md border bg-muted/30"}
			onClick={click}
			style={onCellClick ? { cursor: "crosshair" } : undefined}
		>
			<g className="text-foreground" fill="currentColor" data-testid="map-background">
				{background.map(([c, r, n]) => (
					<rect key={`b${c}-${r}`} x={c} y={r} width={1} height={1} opacity={0.06 + 0.22 * shade(n, bgMax, 0)} />
				))}
			</g>
			{layers.map((layer) => {
				const max = maxCount(layer.cells);
				return (
					<g key={layer.id} fill={layer.color} data-layer={layer.id} aria-label={layer.label}>
						{layer.cells.map(([c, r, n]) =>
							mode === "dots" ? (
								<circle key={`${c}-${r}`} cx={c + 0.5} cy={r + 0.5} r={0.15 + 0.6 * Math.sqrt(n / (max || 1))} opacity={0.85}>
									<title>{`${layer.label}: ${n}`}</title>
								</circle>
							) : (
								<rect key={`${c}-${r}`} x={c} y={r} width={1} height={1} opacity={shade(n, max)}>
									<title>{`${layer.label}: ${n}`}</title>
								</rect>
							),
						)}
					</g>
				);
			})}
			{selected ? <rect x={selected[0]} y={selected[1]} width={1} height={1} fill="none" stroke="currentColor" strokeWidth={0.15} className="text-foreground" data-testid="map-selected" /> : null}
			{overlay?.(toView)}
		</svg>
	);
}
