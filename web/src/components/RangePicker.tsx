/**
 * The date range alone, for pages whose shell filter bar is off (Notifications, Feedback): a preset, or Custom with two
 * UTC dates. It writes the same URL keys as the filter bar.
 */
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isoDate, RANGE_LABELS, type RangePreset } from "@/lib/filters";
import { useFilters } from "@/lib/hooks";

const DAY_MS = 86_400_000;

export function RangePicker() {
	const { state, set } = useFilters();
	const today = isoDate(Date.now());
	return (
		<>
			<Select
				value={state.range}
				onValueChange={(v) => {
					const next = v as RangePreset;
					if (next === "custom") set({ range: "custom", from: state.from ?? isoDate(Date.now() - 29 * DAY_MS), to: state.to ?? today });
					else set({ range: next });
				}}
			>
				<SelectTrigger size="sm" className="w-36" aria-label="Date range">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => (
						<SelectItem key={r} value={r}>
							{RANGE_LABELS[r]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{state.range === "custom" ? (
				<span className="flex items-center gap-1">
					<Input type="date" aria-label="From (UTC)" className="h-8 w-36" value={state.from ?? ""} max={state.to ?? today} onChange={(e) => set({ from: e.target.value || undefined })} />
					<span className="text-xs text-muted-foreground">to</span>
					<Input type="date" aria-label="To (UTC, inclusive)" className="h-8 w-36" value={state.to ?? ""} min={state.from} onChange={(e) => set({ to: e.target.value || undefined })} />
				</span>
			) : null}
		</>
	);
}

