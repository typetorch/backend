/**
 * The map view's height (Y band) controls, shared by the Maps page and the Recordings page's real map: All, the map's
 * detected floors, "Follow player" (a replay only: cut away everything well above the player, so roofs don't hide them)
 * and a free from / to range. Geometry above and below the band is cut away by the renderer's clipping planes, layer
 * marks outside it are left out.
 */
import { ToggleChip } from "@/components/ToggleChip";
import type { BandChoice } from "@/lib/map-view";
import type { Floor } from "@/lib/maps";
import { cn } from "cn";

export function BandSlider({ lo, hi, band, onChange }: { lo: number; hi: number; band: [number, number] | null; onChange: (band: [number, number] | null) => void }) {
	const [a, b] = band ?? [lo, hi];
	const from = Math.max(lo, Math.min(hi, a));
	const to = Math.max(lo, Math.min(hi, b));
	return (
		<div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-xs tabular-nums">
			<span>from</span>
			<input type="range" aria-label="Band bottom" min={lo} max={hi} step={1} value={from} onChange={(e) => onChange([Math.min(Number(e.target.value), to - 1), to])} />
			<span className="w-10 text-right">{Math.round(from)}</span>
			<span>to</span>
			<input type="range" aria-label="Band top" min={lo} max={hi} step={1} value={to} onChange={(e) => onChange([from, Math.max(Number(e.target.value), from + 1)])} />
			<span className="w-10 text-right">{Math.round(to)}</span>
		</div>
	);
}

export function BandControls({
	choice,
	band,
	floors,
	lo,
	hi,
	onChange,
	follow = false,
	className,
}: {
	/** What the URL asks for. */
	choice: BandChoice;
	/** What is drawn (resolved against this map). */
	band: [number, number] | null;
	floors: readonly Floor[];
	lo: number;
	hi: number;
	onChange: (choice: BandChoice) => void;
	/** Offer "Follow player" (the replay). */
	follow?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("space-y-1.5", className)}>
			<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Floors">
				<span className="text-xs font-medium text-muted-foreground">Height (Y)</span>
				<ToggleChip pressed={choice.kind === "all" || (band === null && choice.kind !== "player")} onClick={() => onChange({ kind: "all" })}>
					All
				</ToggleChip>
				{follow ? (
					<ToggleChip pressed={choice.kind === "player"} onClick={() => onChange({ kind: "player" })} title="Cut away everything more than a storey above the player, so roofs don't hide them">
						Follow player
					</ToggleChip>
				) : null}
				{floors.length > 1
					? floors.map((f, i) => (
							<ToggleChip key={f.y} pressed={choice.kind === "floor" && choice.index === i} onClick={() => onChange({ kind: "floor", index: i })} title={`walkable at y ${f.y}`}>
								Floor {i + 1}
							</ToggleChip>
						))
					: null}
			</div>
			<BandSlider lo={lo} hi={hi} band={band} onChange={(b) => onChange(b ? { kind: "range", lo: b[0], hi: b[1] } : { kind: "all" })} />
		</div>
	);
}
