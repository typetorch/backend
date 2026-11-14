/**
 * The Feedback page (plans/32): what players said through `TypeTorch.feedback().submit(...)` (the `feedback` rows) and
 * the older `custom/feedback` rows (read as the faces scale). A header with the range and the device, four KPI cards,
 * one distribution per scale in its own shape (thumbs: up / down; stars and scales: a histogram and the average), the
 * trend (count and the average normalised rating, so a scale change still reads as one line), and the list with its
 * filters (rating, has text, search; URL `rating`, `text`, `q`).
 *
 * The shell's filter bar is off: the range and the device are the page's own (the same URL keys).
 */
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Metric, QueryState, Section } from "@/components/common";
import { RangePicker } from "@/components/RangePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { describeRange, rangeOnly } from "@/lib/filters";
import { fmtInt, fmtPct } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import { DEVICES, type Device, type FeedbackScaleSummary, type FeedbackSummaryResult, type Filters } from "@/lib/types";
import { Distribution, FeedbackList, scaleName, TrendChart } from "./feedback/shared";

export const PAGE_SIZE = 50;
const ALL = "__all";
const PICKED = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";
export const EMPTY_TEXT = "No feedback yet in this range. Games send it with TypeTorch.feedback().submit(player, { rating, text }) on the server; older custom events named feedback show here too.";

/** The rating filter's value: `<scale>:<r>`. */
export function parseRating(value: string): { scale: string; r: number } | null {
	const m = /^([A-Za-z0-9_.-]{1,64}):(\d{1,2})$/.exec(value);
	return m ? { scale: m[1] as string, r: Number(m[2]) } : null;
}

function ratingOptions(scales: FeedbackScaleSummary[]): { value: string; label: string }[] {
	return scales.flatMap((s) =>
		[...s.counts].reverse().map((c) => ({
			value: `${s.scale}:${c.r}`,
			label: `${scales.length > 1 ? `${scaleName(s)}: ` : ""}${c.label ?? (s.type === "stars" ? `${c.r} stars` : s.type === "thumbs" ? (c.r ? "Up" : "Down") : String(c.r))}`,
		})),
	);
}

function DevicePicker({ value, onChange }: { value: Device | undefined; onChange(next: Device | undefined): void }) {
	return (
		<Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : (v as Device))}>
			<SelectTrigger size="sm" className="w-32" aria-label="Device">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All devices</SelectItem>
				{DEVICES.map((d) => (
					<SelectItem key={d} value={d}>
						{d}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function Kpis({ s }: { s: FeedbackSummaryResult }) {
	const thumbsOnly = s.scales.length > 0 && s.scales.every((x) => x.type === "thumbs");
	return (
		<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<Metric label="Feedback" value={fmtInt(s.total)} sub={`from ${fmtInt(s.players)} players`} />
			<Metric label="With text" value={fmtInt(s.withText)} sub={s.total ? `${fmtPct(s.withText / s.total, 0)} of all` : undefined} />
			{thumbsOnly && s.thumbs ? (
				<Metric label="Thumbs up" value={fmtPct(s.thumbs.upShare, 0)} sub={`${fmtInt(s.thumbs.up)} up, ${fmtInt(s.thumbs.down)} down`} />
			) : (
				<Metric label="Average rating" value={s.avgNorm === null ? "–" : fmtPct(s.avgNorm, 0)} sub="of the scale's top, across scales" />
			)}
			<Metric label="Rated" value={fmtInt(s.rated)} sub={`${fmtInt(s.total - s.rated)} text only${s.legacy ? `, ${fmtInt(s.legacy)} legacy` : ""}`} />
		</div>
	);
}

function Overview({ s }: { s: FeedbackSummaryResult }) {
	return (
		<>
			<Kpis s={s} />
			{s.scales.length > 1 ? (
				<p className="text-sm text-muted-foreground">The scale changed in this range: one distribution per scale (newest first). The trend uses the normalised rating, so it reads across scales.</p>
			) : null}
			<div className="grid gap-4 lg:grid-cols-2">
				{s.scales.map((scale) => (
					<Section
						key={`${scale.scale}-${scale.type}-${scale.steps}`}
						className="min-w-0"
						title={scaleName(scale)}
						description={`${scale.type === "thumbs" ? "Thumbs" : scale.type === "stars" ? `${scale.steps} stars` : `${scale.steps}-step scale`}, ${fmtInt(scale.rated)} rated${scale.textOnly ? `, ${fmtInt(scale.textOnly)} text only` : ""}`}
					>
						<Distribution scale={scale} />
					</Section>
				))}
				<Section className="min-w-0 lg:col-span-2" title="Trend" description={`Feedback per ${s.bucket} and the average rating (% of the scale's top).`}>
					<TrendChart summary={s} />
				</Section>
			</div>
		</>
	);
}

function ListSection({ filters, summary }: { filters: Filters; summary: FeedbackSummaryResult | undefined }) {
	const [rating, setRating] = useParam("rating");
	const [text, setText] = useParam("text");
	const [q, setQ] = useParam("q");
	const [draft, setDraft] = useState(q);
	const [offset, setOffset] = useState(0);
	useEffect(() => setDraft(q), [q]);
	// The search applies 300 ms after the last key.
	useEffect(() => {
		if (draft.trim() === q) return;
		const id = setTimeout(() => setQ(draft.trim().slice(0, 100)), 300);
		return () => clearTimeout(id);
	}, [draft, q, setQ]);
	const picked = parseRating(rating);
	const options = {
		limit: PAGE_SIZE,
		offset,
		...(picked ? { scale: picked.scale, r: picked.r } : {}),
		...(text === "yes" ? { hasText: true } : text === "no" ? { hasText: false } : {}),
		...(q ? { q } : {}),
	};
	// Back to the first page whenever a filter or the range changes.
	const key = JSON.stringify([filters, rating, text, q]);
	const [seen, setSeen] = useState(key);
	if (seen !== key) {
		setSeen(key);
		setOffset(0);
	}
	const list = useAnalytics("feedback-list", options, { filters, keepPrevious: true });
	const choices = ratingOptions(summary?.scales ?? []);
	return (
		<Section title="Feedback" description="Newest first. A player's name opens their player view.">
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<Select value={picked ? rating : ALL} onValueChange={(v) => setRating(v === ALL ? "" : v)}>
						<SelectTrigger size="sm" className="w-48" aria-label="Rating">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All ratings</SelectItem>
							{choices.map((c) => (
								<SelectItem key={c.value} value={c.value}>
									{c.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={text || "all"} onValueChange={(v) => v && setText(v === "all" ? "" : v)} aria-label="Has text">
						<ToggleGroupItem value="all" className={PICKED}>
							All
						</ToggleGroupItem>
						<ToggleGroupItem value="yes" className={PICKED}>
							With text
						</ToggleGroupItem>
						<ToggleGroupItem value="no" className={PICKED}>
							No text
						</ToggleGroupItem>
					</ToggleGroup>
					<span className="relative min-w-0 flex-1 sm:max-w-64">
						<Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
						<Input aria-label="Search the text" placeholder="Search the text" className="h-8 pl-7" maxLength={100} value={draft} onChange={(e) => setDraft(e.target.value)} />
					</span>
				</div>
				<QueryState query={list} loadingRows={5} isEmpty={(d) => d.rows.length === 0} empty={rating || text || q ? "No feedback matches these filters." : EMPTY_TEXT}>
					{(data) => (
						<div className="space-y-2">
							<FeedbackList rows={data.rows} />
							<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
								<span className="tabular-nums">
									{fmtInt(data.offset + 1)}-{fmtInt(data.offset + data.rows.length)} of {fmtInt(data.total)}
								</span>
								<span className="flex gap-1">
									<Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
										<ChevronLeft />
										Newer
									</Button>
									<Button type="button" variant="outline" size="sm" disabled={!data.more || offset + PAGE_SIZE > 5000} onClick={() => setOffset(offset + PAGE_SIZE)}>
										Older
										<ChevronRight />
									</Button>
								</span>
							</div>
						</div>
					)}
				</QueryState>
			</div>
		</Section>
	);
}

export default function Feedback() {
	const { state, apiFilters, set } = useFilters();
	// Only the range and the device apply here (the filter bar is off).
	const filters: Filters = { ...rangeOnly(apiFilters), ...(state.dev ? { dev: state.dev } : {}) };
	const summary = useAnalytics("feedback-summary", {}, { filters });
	return (
		<div className="mx-auto w-full max-w-[1480px] space-y-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight">Feedback</h1>
					<p className="text-sm text-muted-foreground">What players told the game, {describeRange(state)}{state.dev ? ` on ${state.dev}` : ""}: ratings, text, and who sent it.</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<RangePicker />
					<DevicePicker value={state.dev} onChange={(dev) => set({ dev })} />
				</div>
			</div>
			<QueryState query={summary} loadingRows={6} isEmpty={(d) => d.total === 0} empty={EMPTY_TEXT}>
				{(s) => (
					<div className="space-y-5">
						<Overview s={s} />
						<ListSection filters={filters} summary={s} />
					</div>
				)}
			</QueryState>
		</div>
	);
}
