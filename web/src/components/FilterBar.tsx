/** The filter bar every page shares: date range, branch, artifact, device, new/returning, experiment variant. */
import { RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activeFilterCount, isoDate, RANGE_LABELS, rangeOnly, type FilterState, type RangePreset } from "@/lib/filters";
import { useAnalytics, useFilters } from "@/lib/hooks";
import { DEVICES } from "@/lib/types";

const ANY = "__any";
const SEP = "|";

/** A text filter with suggestions; commits after a short pause, on Enter or on blur. */
function SuggestInput({
	value,
	onCommit,
	placeholder,
	options,
	label,
}: {
	value?: string;
	onCommit(v: string): void;
	placeholder: string;
	options: string[];
	label: string;
}) {
	const id = useId();
	const [text, setText] = useState(value ?? "");
	const commit = useRef(onCommit);
	commit.current = onCommit;
	useEffect(() => setText(value ?? ""), [value]);
	useEffect(() => {
		if (text.trim() === (value ?? "")) return;
		const timer = setTimeout(() => commit.current(text.trim()), 600);
		return () => clearTimeout(timer);
	}, [text, value]);
	const now = () => text.trim() !== (value ?? "") && commit.current(text.trim());
	return (
		<>
			<Input
				aria-label={label}
				className="h-8 w-40"
				placeholder={placeholder}
				list={`${id}-list`}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onBlur={now}
				onKeyDown={(e) => e.key === "Enter" && now()}
			/>
			<datalist id={`${id}-list`}>
				{options.map((o) => (
					<option key={o} value={o} />
				))}
			</datalist>
		</>
	);
}

export function FilterBar() {
	const { state, apiFilters, set, reset } = useFilters();
	const range = rangeOnly(apiFilters);
	const values = useAnalytics("values", {}, { filters: range });
	const experiments = useAnalytics("experiment", {}, { filters: range });
	const pairs = experiments.data && experiments.data.experiment === null ? experiments.data.experiments.filter((e) => e.variant) : [];
	const variantValue = state.exp && state.variant ? `${state.exp}${SEP}${state.variant}` : ANY;
	const today = isoDate(Date.now());

	const setRange = (value: string) => {
		const next = value as RangePreset;
		if (next === "custom") set({ range: "custom", from: state.from ?? isoDate(Date.now() - 29 * 86_400_000), to: state.to ?? today });
		else set({ range: next });
	};
	const setVariant = (value: string) => {
		if (value === ANY) return set({ exp: undefined, variant: undefined });
		const at = value.indexOf(SEP); // experiment names can't hold "|" (letters, digits, _ - .)
		set({ exp: value.slice(0, at), variant: value.slice(at + 1) });
	};

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select value={state.range} onValueChange={setRange}>
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
				<div className="flex items-center gap-1">
					<Input
						type="date"
						aria-label="From (UTC)"
						className="h-8 w-36"
						value={state.from ?? ""}
						max={state.to ?? today}
						onChange={(e) => set({ from: e.target.value || undefined })}
					/>
					<span className="text-xs text-muted-foreground">to</span>
					<Input
						type="date"
						aria-label="To (UTC, inclusive)"
						className="h-8 w-36"
						value={state.to ?? ""}
						min={state.from}
						onChange={(e) => set({ to: e.target.value || undefined })}
					/>
				</div>
			) : null}
			<SuggestInput
				label="Branch"
				placeholder="any branch"
				value={state.branch}
				options={(values.data?.branch ?? []).map((v) => v.value)}
				onCommit={(v) => set({ branch: v || undefined })}
			/>
			<SuggestInput
				label="Artifact"
				placeholder="any artifact"
				value={state.art}
				options={(values.data?.art ?? []).map((v) => v.value)}
				onCommit={(v) => set({ art: v || undefined })}
			/>
			<Select value={state.dev ?? ANY} onValueChange={(v) => set({ dev: v === ANY ? undefined : (v as FilterState["dev"]) })}>
				<SelectTrigger size="sm" className="w-32" aria-label="Device">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ANY}>any device</SelectItem>
					{DEVICES.map((d) => (
						<SelectItem key={d} value={d}>
							{d}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select value={state.players ?? ANY} onValueChange={(v) => set({ players: v === ANY ? undefined : (v as FilterState["players"]) })}>
				<SelectTrigger size="sm" className="w-36" aria-label="New or returning">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ANY}>all sessions</SelectItem>
					<SelectItem value="new">new players</SelectItem>
					<SelectItem value="returning">returning</SelectItem>
				</SelectContent>
			</Select>
			<Select value={variantValue} onValueChange={setVariant}>
				<SelectTrigger size="sm" className="w-48" aria-label="Experiment variant">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ANY}>any variant</SelectItem>
					{variantValue !== ANY && !pairs.some((p) => `${p.experiment}${SEP}${p.variant}` === variantValue) ? (
						<SelectItem value={variantValue}>
							{state.exp}: {state.variant}
						</SelectItem>
					) : null}
					{pairs.map((p) => (
						<SelectItem key={`${p.experiment}${SEP}${p.variant}`} value={`${p.experiment}${SEP}${p.variant}`}>
							{p.experiment}: {p.variant} ({p.players})
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{activeFilterCount(state) > 0 ? (
				<Button variant="ghost" size="sm" onClick={reset}>
					<RotateCcw />
					Clear
				</Button>
			) : null}
		</div>
	);
}
