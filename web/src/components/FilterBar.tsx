/**
 * The filter bar every page shares: date range, branch, artifact, device, new/returning, experiment variant, and the
 * Audience popover (country, language, account age, Premium, join source: player-level, from the players' join rows).
 */
import { RotateCcw, Users } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ACCOUNT_AGE, audienceChoices, countryName, JOIN_SOURCES, joinSourceName, languageName, type Choice } from "@/lib/audience";
import { activeFilterCount, audienceFilterCount, isoDate, RANGE_LABELS, rangeOnly, type FilterState, type RangePreset } from "@/lib/filters";
import { useAnalytics, useFilters } from "@/lib/hooks";
import { ACCOUNT_AGES, DEVICES } from "@/lib/types";

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

/** One labelled choice of the Audience popover ("any" clears it). */
function AudienceSelect({ label, value, any, choices, onChange }: { label: string; value?: string; any: string; choices: Choice[]; onChange(v: string | undefined): void }) {
	const list = value && !choices.some((c) => c.value === value) ? [{ value, label: value }, ...choices] : choices;
	return (
		<div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
			<span className="text-xs text-muted-foreground">{label}</span>
			<Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
				<SelectTrigger size="sm" className="w-full" aria-label={label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ANY}>{any}</SelectItem>
					{list.map((c) => (
						<SelectItem key={c.value} value={c.value}>
							{c.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/** What the Audience button says: "Audience", or the picked values ("United States, Premium") when few. */
export function audienceSummary(state: FilterState): string {
	const parts: string[] = [];
	if (state.country) parts.push(countryName(state.country));
	if (state.lang) parts.push(languageName(state.lang));
	if (state.age) parts.push(`account ${ACCOUNT_AGE[state.age]}`);
	if (state.prem) parts.push(state.prem === "true" ? "Premium" : "not Premium");
	if (state.source) parts.push(joinSourceName(state.source).replace(/ \(.*\)$/, ""));
	if (parts.length === 0) return "Audience";
	return parts.length <= 2 ? parts.join(", ") : `Audience (${parts.length})`;
}

/**
 * The audience filters: country and language from the values our join events carry in the range (the demographics
 * query), account age, Premium and join source from the framework's fixed lists. Player-level: a player is in when
 * one of their joins in the range says so, and then all their rows count.
 */
export function AudienceFilters({
	state,
	set,
	countries,
	languages,
	open,
	onOpenChange,
}: {
	state: FilterState;
	set(patch: Partial<FilterState>): void;
	countries: Choice[];
	languages: Choice[];
	open?: boolean;
	onOpenChange?(open: boolean): void;
}) {
	const count = audienceFilterCount(state);
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button variant={count ? "secondary" : "outline"} size="sm" className="h-8 max-w-56" aria-label={`Audience filters${count ? ` (${count} set)` : ""}`}>
					<Users />
					<span className="truncate">{audienceSummary(state)}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80">
				<p className="text-xs text-muted-foreground">Players whose joins in the range say so (all their rows then count). From our join events: older framework builds send no language.</p>
				<AudienceSelect label="Country" any="any country" value={state.country} choices={countries} onChange={(v) => set({ country: v })} />
				<AudienceSelect label="Language" any="any language" value={state.lang} choices={languages} onChange={(v) => set({ lang: v })} />
				<AudienceSelect
					label="Account age"
					any="any account age"
					value={state.age}
					choices={ACCOUNT_AGES.map((a) => ({ value: a, label: ACCOUNT_AGE[a] }))}
					onChange={(v) => set({ age: v as FilterState["age"] })}
				/>
				<AudienceSelect
					label="Premium"
					any="Premium or not"
					value={state.prem}
					choices={[
						{ value: "true", label: "Premium" },
						{ value: "false", label: "Not Premium" },
					]}
					onChange={(v) => set({ prem: v as FilterState["prem"] })}
				/>
				<AudienceSelect
					label="Join source"
					any="any join source"
					value={state.source}
					choices={Object.entries(JOIN_SOURCES).map(([value, label]) => ({ value, label }))}
					onChange={(v) => set({ source: v })}
				/>
				{count ? (
					<Button variant="ghost" size="sm" className="self-start" onClick={() => set({ country: undefined, lang: undefined, age: undefined, prem: undefined, source: undefined })}>
						<RotateCcw />
						Clear audience
					</Button>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

export function FilterBar() {
	const { state, apiFilters, set, reset } = useFilters();
	const range = rangeOnly(apiFilters);
	const values = useAnalytics("values", {}, { filters: range });
	const experiments = useAnalytics("experiment", {}, { filters: range });
	// The countries and languages seen in the range (over the range only, so a picked one doesn't hide the others),
	// asked once the Audience popover opens, not on every page.
	const [audienceOpen, setAudienceOpen] = useState(false);
	const demographics = useAnalytics("demographics", {}, { filters: range, enabled: audienceOpen });
	const { countries, languages } = audienceChoices(demographics.data, state);
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
			<AudienceFilters state={state} set={set} countries={countries} languages={languages} open={audienceOpen} onOpenChange={setAudienceOpen} />
			{activeFilterCount(state) > 0 ? (
				<Button variant="ghost" size="sm" onClick={reset}>
					<RotateCcw />
					Clear
				</Button>
			) : null}
		</div>
	);
}
