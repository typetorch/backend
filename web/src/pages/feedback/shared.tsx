/**
 * Player feedback pieces (plans/32), shared by the Feedback page and the player detail's Feedback view: a rating drawn
 * in its scale's own shape (thumbs, stars, a labelled scale such as the faces BAD..GREAT), one scale's distribution, the
 * trend chart, and the list of submissions.
 */
import { MessageSquareText, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { cn } from "cn";
import { PlayerPageLink } from "@/components/PlayerLink";
import { Badge } from "@/components/ui/badge";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtAgo, fmtInt, fmtNum, fmtPct, fmtTime } from "@/lib/format";
import type { FeedbackRow, FeedbackScaleSummary, FeedbackSummaryResult } from "@/lib/types";

/** A readable scale name: the legacy rows say so. */
export function scaleName(s: { scale: string; legacy?: boolean }): string {
	return s.legacy || s.scale === "legacy_faces5" ? "Faces (legacy)" : s.scale || "(no scale)";
}

/** Good / middling / bad by the normalised rating (0..1). */
export function normTone(norm: number | null): string {
	if (norm === null) return "var(--muted-foreground)";
	if (norm >= 0.67) return "var(--status-good)";
	if (norm >= 0.34) return "var(--status-warning)";
	return "var(--status-critical)";
}

/** The rating as words, for labels and screen readers. */
export function ratingText(row: Pick<FeedbackRow, "type" | "steps" | "r" | "label">): string {
	if (row.r === null) return "No rating";
	if (row.type === "thumbs") return row.label ?? (row.r ? "Thumbs up" : "Thumbs down");
	if (row.type === "stars") return `${row.r} of ${row.steps} stars`;
	return row.label ? `${row.label} (${row.r} of ${row.steps})` : `${row.r} of ${row.steps}`;
}

/** One rating in its scale's shape: a thumb, a row of stars, or the step's label (faces) with r / steps. */
export function Rating({ row, className }: { row: Pick<FeedbackRow, "type" | "steps" | "r" | "label" | "norm">; className?: string }) {
	const text = ratingText(row);
	if (row.r === null) {
		return (
			<span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)} title={text}>
				<MessageSquareText className="size-3.5" aria-hidden />
				text only
			</span>
		);
	}
	if (row.type === "thumbs") {
		const Icon = row.r ? ThumbsUp : ThumbsDown;
		return (
			<span className={cn("inline-flex items-center gap-1 text-xs font-medium", className)} role="img" aria-label={text} title={text} style={{ color: normTone(row.r ? 1 : 0) }}>
				<Icon className="size-4" aria-hidden />
				{row.label ? <span aria-hidden>{row.label}</span> : null}
			</span>
		);
	}
	if (row.type === "stars") {
		const steps = Math.max(1, Math.min(10, row.steps));
		return (
			<span className={cn("inline-flex items-center gap-0.5", className)} role="img" aria-label={text} title={text}>
				{Array.from({ length: steps }, (_, i) => (
					<Star key={i} className={cn("size-3.5", i < (row.r ?? 0) ? "fill-[var(--status-warning)] text-[var(--status-warning)]" : "text-muted-foreground/40")} aria-hidden />
				))}
			</span>
		);
	}
	return (
		<span className={cn("inline-flex items-center gap-1.5", className)} role="img" aria-label={text} title={text}>
			<span className="rounded-md border px-1.5 py-0.5 text-xs font-semibold" style={{ color: normTone(row.norm), borderColor: normTone(row.norm) }} aria-hidden>
				{row.label ?? row.r}
			</span>
			<span className="text-[11px] text-muted-foreground tabular-nums" aria-hidden>
				{row.r}/{row.steps}
			</span>
		</span>
	);
}

/** One scale's distribution: thumbs as up / down shares, stars and scales as a histogram per step with the average. */
export function Distribution({ scale }: { scale: FeedbackScaleSummary }) {
	const rated = scale.rated;
	if (scale.type === "thumbs") {
		const up = scale.counts.find((c) => c.r === 1)?.n ?? 0;
		const down = scale.counts.find((c) => c.r === 0)?.n ?? 0;
		const parts = [
			{ key: "up", icon: ThumbsUp, label: scale.labels[1] ?? "Up", n: up, color: "var(--status-good)" },
			{ key: "down", icon: ThumbsDown, label: scale.labels[0] ?? "Down", n: down, color: "var(--status-critical)" },
		];
		return (
			<div className="space-y-3" aria-label={`${scaleName(scale)} distribution`}>
				<div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${fmtPct(rated ? up / rated : 0, 0)} up, ${fmtPct(rated ? down / rated : 0, 0)} down`}>
					{rated ? parts.map((p) => (p.n ? <div key={p.key} className="h-full" style={{ width: `${(p.n / rated) * 100}%`, background: p.color }} /> : null)) : null}
				</div>
				<div className="grid grid-cols-2 gap-3">
					{parts.map((p) => (
						<div key={p.key} className="space-y-0.5">
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<p.icon className="size-3.5" style={{ color: p.color }} aria-hidden />
								{p.label}
							</div>
							<div className="text-2xl font-semibold tracking-tight tabular-nums">{rated ? fmtPct(p.n / rated, 0) : "–"}</div>
							<div className="text-xs text-muted-foreground tabular-nums">{fmtInt(p.n)}</div>
						</div>
					))}
				</div>
			</div>
		);
	}
	const max = Math.max(1, ...scale.counts.map((c) => c.n));
	return (
		<div className="space-y-3" aria-label={`${scaleName(scale)} distribution`}>
			<ul className="space-y-1.5">
				{[...scale.counts].reverse().map((c) => {
					const norm = scale.steps > 1 ? (c.r - 1) / (scale.steps - 1) : 1;
					const name = c.label ?? (scale.type === "stars" ? `${c.r} star${c.r === 1 ? "" : "s"}` : String(c.r));
					return (
						<li key={c.r} className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2 text-xs" aria-label={`${name}: ${fmtInt(c.n)}`}>
							<span className="flex min-w-0 items-center gap-1 truncate font-medium">
								{scale.type === "stars" ? <Star className="size-3 shrink-0 fill-[var(--status-warning)] text-[var(--status-warning)]" aria-hidden /> : null}
								<span className="truncate">{name}</span>
							</span>
							<span className="h-3 overflow-hidden rounded-sm bg-muted">
								<span className="block h-full rounded-sm" style={{ width: `${(c.n / max) * 100}%`, background: normTone(norm) }} />
							</span>
							<span className="text-right text-muted-foreground tabular-nums">
								{fmtInt(c.n)} <span className="text-[11px]">{rated ? fmtPct(c.n / rated, 0) : ""}</span>
							</span>
						</li>
					);
				})}
			</ul>
			<p className="text-sm">
				Average{" "}
				<span className="font-semibold tabular-nums">
					{scale.avgR === null ? "–" : `${fmtNum(scale.avgR, 2)} / ${scale.steps}`}
				</span>
				{scale.avgNorm === null ? null : <span className="text-muted-foreground"> ({fmtPct(scale.avgNorm, 0)} of the top)</span>}
			</p>
		</div>
	);
}

const trendChart: ChartConfig = { n: { label: "Feedback", color: "var(--chart-1)" }, score: { label: "Average (% of top)", color: "var(--chart-3)" } };

/** Count per bucket as bars, the average normalised rating as a line (0-100 %, across scales). */
export function TrendChart({ summary }: { summary: FeedbackSummaryResult }) {
	const data = summary.trend.map((p) => ({ at: summary.bucket === "hour" ? `${p.at.slice(0, 10)} ${p.at.slice(11, 16)}` : p.at, n: p.n, score: p.avgNorm === null ? null : Math.round(p.avgNorm * 1000) / 10 }));
	const tick = (d: string) => (d.length > 10 ? d.slice(11) : d.slice(5));
	return (
		<ChartContainer config={trendChart} className="aspect-auto h-56 w-full">
			<ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barCategoryGap={2}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="at" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
				<YAxis yAxisId="n" tickLine={false} axisLine={false} width={36} allowDecimals={false} />
				<YAxis yAxisId="score" orientation="right" domain={[0, 100]} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}%`} />
				<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
				<ChartLegend content={<ChartLegendContent />} />
				<Bar yAxisId="n" dataKey="n" fill="var(--color-n)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
				<Line yAxisId="score" dataKey="score" stroke="var(--color-score)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
			</ComposedChart>
		</ChartContainer>
	);
}

/** "4m 05s" / "1h 12m" for play time in seconds. */
export function fmtPlay(seconds: number | null): string | null {
	if (seconds === null) return null;
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The submissions, newest first: rating, text, then who / when / device / play time / state / topic / ctx. */
export function FeedbackList({ rows, showPlayer = true, label = "Feedback" }: { rows: FeedbackRow[]; showPlayer?: boolean; label?: string }) {
	return (
		<ul className="divide-y rounded-lg border" aria-label={label}>
			{rows.map((row) => {
				const play = fmtPlay(row.play_s);
				return (
					<li key={`${row.t}-${row.pid}-${row.sid}-${row.scale}-${row.r}-${row.text ?? ""}`} className="space-y-1.5 px-3 py-2.5">
						<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
							<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
								<Rating row={row} />
								{row.topic ? (
									<Badge variant="secondary" className="h-5 px-1.5 font-mono text-[11px]">
										{row.topic}
									</Badge>
								) : null}
								{row.legacy ? (
									<Badge variant="outline" className="h-5 px-1.5 text-[11px]" title="An older custom/feedback row, read as the faces scale">
										legacy
									</Badge>
								) : null}
							</div>
							<span className="text-[11px] text-muted-foreground tabular-nums" title={fmtTime(row.t)}>
								{fmtAgo(row.t)}
							</span>
						</div>
						{row.text ? (
							<p className="text-sm break-words whitespace-pre-wrap">
								{row.text}
								{row.len > row.text.length ? <span className="text-xs text-muted-foreground"> (cut, {fmtInt(row.len)} characters sent)</span> : null}
							</p>
						) : (
							<p className="text-xs text-muted-foreground">No text</p>
						)}
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
							{showPlayer ? (
								<span className="min-w-0 text-foreground">
									<PlayerPageLink row={{ pid: row.pid, ...(row.uid !== undefined ? { uid: row.uid } : {}), ...(row.name ? { name: row.name } : {}), ...(row.displayName ? { displayName: row.displayName } : {}) }} />
								</span>
							) : null}
							{row.dev ? <span>{row.dev}</span> : null}
							{play ? <span>played {play}</span> : null}
							{row.state ? <span className="max-w-full truncate font-mono text-[11px]">{row.state}</span> : null}
						</div>
						{row.ctx ? (
							<div className="flex flex-wrap gap-1" aria-label="Context">
								{Object.entries(row.ctx).map(([k, v]) => (
									<span key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
										{k}: {String(v)}
									</span>
								))}
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
