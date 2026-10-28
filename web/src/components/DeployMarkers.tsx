/**
 * Deploy markers for any recharts chart: one vertical line per release, rollback, kernel publish or backup refresh (GET
 * /v1/fleet/marks), labelled "#42 prod", with a hover card (focus works too) and, by default, a click that opens the
 * release's deploy page.
 *
 *   const deploys = useDeployMarks({ from, to }, branch);         // the marks in range, [] while hidden
 *   const [hover, setHover] = useState<MarkHover | null>(null);
 *   <div className="relative">
 *     <LineChart ...>{markerLines(groupMarks(deploys.marks, (m) => m.at), { onHover: setHover, onClick })}</LineChart>
 *     <MarkHoverCard hover={hover} />
 *   </div>
 *   <DeployMarksToggle {...deploys} />                              // hides them on every chart (remembered)
 *
 * On a time axis the line's x is the mark's time; on bars (a category axis) it is the label of the bar it falls in
 * (`placeOnLabels`), with marks on one bar sharing a line.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { ReferenceLine } from "recharts";
import { ToggleChip } from "@/components/ToggleChip";
import { api } from "@/lib/api";
import { markDeploySeq, markLabel, type MarkGroup } from "@/lib/deploys";
import { MARK_STYLE, markDetails, markTitle, type DeployMark } from "@/lib/perf";

// Shown or hidden (one switch for every chart, kept in localStorage) ----------------------------------------------------

const STORAGE_KEY = "tt-explorer-deploy-marks";
const listeners = new Set<() => void>();

function readShown(): boolean {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setDeployMarksShown(shown: boolean): void {
	try {
		if (shown) globalThis.localStorage?.removeItem(STORAGE_KEY);
		else globalThis.localStorage?.setItem(STORAGE_KEY, "off");
	} catch {
		// private mode: the switch lasts until the page reloads
	}
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && listener();
	globalThis.addEventListener?.("storage", onStorage);
	return () => {
		listeners.delete(listener);
		globalThis.removeEventListener?.("storage", onStorage);
	};
}

export function useDeployMarksShown(): [boolean, (shown: boolean) => void] {
	return [useSyncExternalStore(subscribe, readShown, () => true), setDeployMarksShown];
}

// The marks -------------------------------------------------------------------------------------------------------------

export interface DeployMarks {
	/** What the charts draw: the marks in range, or [] while hidden. */
	marks: DeployMark[];
	/** Every mark in range, shown or not (the toggle's count). */
	all: DeployMark[];
	shown: boolean;
	setShown(shown: boolean): void;
	error: unknown;
}

/**
 * The marks in [from, to] (rounded out to whole minutes so the cache key holds still; the Performance page reads the same
 * key). `branch` keeps that branch's releases and the place-wide marks. A backend without the fleet part answers 404:
 * no marks, no error shown.
 */
export function useDeployMarks(range: { from: number; to: number } | null | undefined, branch?: string, options: { enabled?: boolean } = {}): DeployMarks {
	const [shown, setShown] = useDeployMarksShown();
	const from = range && Number.isFinite(range.from) ? Math.floor(range.from / 60_000) * 60_000 : null;
	const to = range && Number.isFinite(range.to) ? Math.ceil(range.to / 60_000) * 60_000 : null;
	const valid = from !== null && to !== null && to > from && to - from <= 366 * 86_400_000;
	const query = useQuery({
		queryKey: ["fleet", "marks", from, to, branch ?? ""],
		queryFn: ({ signal }) => api.fleetMarks({ since: from as number, until: to as number, ...(branch ? { branch } : {}), limit: 1000 }, signal),
		enabled: valid && (options.enabled ?? true),
		retry: false,
		staleTime: 60_000,
	});
	const all = useMemo(() => query.data ?? [], [query.data]);
	return { marks: shown ? all : [], all, shown, setShown, error: query.error };
}

/** Opens a release's deploy page (kernel and backup marks have none). */
export function useOpenDeploy(): (mark: DeployMark) => void {
	const navigate = useNavigate();
	return useCallback(
		(mark: DeployMark) => {
			const seq = markDeploySeq(mark);
			if (seq !== null) void navigate(`/deploys/${seq}`);
		},
		[navigate],
	);
}

// Drawing ---------------------------------------------------------------------------------------------------------------

export interface MarkHover {
	marks: DeployMark[];
	x: number;
}

/** Labels are drawn while a chart has at most this many lines (more would overlap); the hover card always works. */
export const MAX_LABELLED = 6;

/** One line: a wide invisible hit line, the visible line, a small flag at the top and the label beside it. */
function MarkShape(props: {
	x1?: number;
	y1?: number;
	x2?: number;
	y2?: number;
	marks: DeployMark[];
	selected: boolean;
	label: string | null;
	onHover(hover: MarkHover | null): void;
	onClick?(mark: DeployMark): void;
}) {
	const { x1, y1, x2, y2, marks, selected, label, onHover, onClick } = props;
	if (![x1, y1, x2, y2].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
	const mark = marks[marks.length - 1] as DeployMark;
	const style = MARK_STYLE[mark.kind] ?? MARK_STYLE.deploy;
	const top = Math.min(y1 as number, y2 as number);
	const x = x1 as number;
	const activate = () => onClick?.(mark);
	return (
		<g
			className="cursor-pointer outline-none"
			role="button"
			tabIndex={0}
			aria-label={marks.map((m) => `${markTitle(m)}, ${markDetails(m)[0]}`).join("; ")}
			data-mark={mark.id}
			onMouseEnter={() => onHover({ marks, x })}
			onMouseLeave={() => onHover(null)}
			onFocus={() => onHover({ marks, x })}
			onBlur={() => onHover(null)}
			onClick={activate}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					activate();
				}
			}}
		>
			<line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
			<line x1={x1} y1={y1} x2={x2} y2={y2} stroke={style.color} strokeWidth={selected ? 2.5 : 1.25} strokeDasharray={style.dash} strokeOpacity={selected ? 1 : 0.85} />
			<path d={`M${x - 4},${top} L${x + 4},${top} L${x},${top + 6} Z`} fill={style.color} />
			{label ? (
				<text x={x + 6} y={top + 8} fontSize={10} fill="var(--muted-foreground)" className="pointer-events-none select-none">
					{label}
				</text>
			) : null}
		</g>
	);
}

export interface MarkerOptions {
	selected?: string | null;
	onHover(hover: MarkHover | null): void;
	onClick?(mark: DeployMark): void;
	/** Draw the "#42 prod" labels (default: while there are at most MAX_LABELLED lines). */
	labels?: boolean;
}

/** The ReferenceLine elements for a chart's children (an array, so it works wherever recharts looks for them). */
export function markerLines(groups: readonly MarkGroup[], options: MarkerOptions): ReactElement[] {
	const labels = options.labels ?? groups.length <= MAX_LABELLED;
	return groups.map((g) => {
		const last = g.marks[g.marks.length - 1] as DeployMark;
		const label = labels ? `${markLabel(last)}${g.marks.length > 1 ? ` +${g.marks.length - 1}` : ""}` : null;
		return (
			<ReferenceLine
				key={`mark-${g.x}`}
				x={g.x}
				ifOverflow="discard"
				shape={(p: { x1?: number; y1?: number; x2?: number; y2?: number }) => (
					<MarkShape
						{...p}
						marks={g.marks}
						label={label}
						selected={g.marks.some((m) => m.id === options.selected)}
						onHover={options.onHover}
						{...(options.onClick ? { onClick: options.onClick } : {})}
					/>
				)}
			/>
		);
	});
}

/** The card over a hovered (or focused) line: each mark's title and details. */
export function MarkHoverCard({ hover, clickHint }: { hover: MarkHover | null; clickHint?: string }) {
	if (!hover) return null;
	return (
		<div
			className="pointer-events-none absolute top-0 z-10 max-w-64 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
			style={{ left: Math.max(90, hover.x) }}
			role="status"
		>
			<div className="divide-y">
				{hover.marks.slice(-4).map((m) => (
					<div key={m.id} className="py-1 first:pt-0 last:pb-0">
						<div className="font-medium">{markTitle(m)}</div>
						{markDetails(m).map((line) => (
							<div key={line} className="text-muted-foreground">
								{line}
							</div>
						))}
					</div>
				))}
			</div>
			{hover.marks.length > 4 ? <div className="pt-1 text-muted-foreground">and {hover.marks.length - 4} earlier</div> : null}
			{clickHint ? <div className="pt-0.5 text-muted-foreground">{clickHint}</div> : null}
		</div>
	);
}

/** Show / hide the markers on every chart; nothing while there are none in range. */
export function DeployMarksToggle({ all, shown, setShown, className }: Pick<DeployMarks, "all" | "shown" | "setShown"> & { className?: string }) {
	if (!all.length) return null;
	return (
		<ToggleChip pressed={shown} onClick={() => setShown(!shown)} title={shown ? "Hide the deploy markers on the charts" : "Show the deploy markers on the charts"} {...(className ? { className } : {})}>
			Deploys ({all.length})
		</ToggleChip>
	);
}
