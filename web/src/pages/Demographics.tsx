/**
 * Who plays, like Creator Hub's Demographics page, from two sources:
 *   - Roblox (GET /v1/roblox/demographics): age group, gender, language, country, platform and OS, as daily active
 *     users over the filter bar's range (its full UTC days), with its device, new / returning and country filters as
 *     Roblox's Platform / IsNewUser / Country; branch, artifact, experiment, language, account age, Premium and join
 *     source have no Roblox equivalent and are listed as not applied.
 *     Needs `universe.analytics:read` on OPENCLOUD_API_KEY.
 *   - Our join events (the `demographics` query, every filter applies): country, language, device, account age and
 *     Premium, each player once.
 * Each card is a ranked bar list: label, bar, share; the count is in the tooltip.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "cn";
import { ANALYTICS_SCOPE } from "@/components/RobloxAcquisition";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import { fmtInt, fmtPct, plural } from "@/lib/format";
import { ACCOUNT_AGE, ACCOUNT_AGE_ORDER, countryName, languageName } from "@/lib/audience";
import type { FilterState } from "@/lib/filters";
import { useAnalytics, useFilters } from "@/lib/hooks";
import type { DemographicDimension, DemographicsResult, RobloxDemographicBreakdown, RobloxDemographics } from "@/lib/types";

/** One bar of a card. */
export interface BarRow {
	key: string;
	label: string;
	share: number;
	count: number;
	/** Not sent / unknown: drawn muted. */
	muted?: boolean;
}

export { countryName, languageName };

const capitalize = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/** Our join events' rows as bars: names for codes, "Not sent" last, account age in age order. */
export function ownRows(dimension: DemographicDimension, r: DemographicsResult): BarRow[] {
	const rows = r.dimensions[dimension].map((x): BarRow => {
		const muted = x.value === null;
		let label = x.value ?? "Not sent";
		if (x.value !== null) {
			if (dimension === "country") label = countryName(x.value);
			else if (dimension === "language") label = languageName(x.value);
			else if (dimension === "accountAge") label = ACCOUNT_AGE[x.value as keyof typeof ACCOUNT_AGE] ?? x.value;
			else if (dimension === "premium") label = x.value === "true" ? "Premium" : "Not Premium";
			else label = capitalize(x.value);
		}
		return { key: x.value ?? "", label, share: x.share, count: x.players, ...(muted ? { muted } : {}) };
	});
	if (dimension === "accountAge") {
		const at = (k: string) => (ACCOUNT_AGE_ORDER.includes(k) ? ACCOUNT_AGE_ORDER.indexOf(k) : 99);
		rows.sort((a, b) => at(a.key) - at(b.key));
	} else rows.sort((a, b) => Number(Boolean(a.muted)) - Number(Boolean(b.muted)) || b.count - a.count);
	return rows;
}

/** Roblox's rows as bars: its display names, ISO codes turned into names when it sent none. */
export function robloxRows(breakdown: RobloxDemographicBreakdown, rows: { value: string; label: string; users: number; share: number }[]): BarRow[] {
	return rows.map((x) => {
		let label = x.label;
		if (label === x.value && breakdown === "Country") label = countryName(x.value);
		if (label === x.value && breakdown === "Locale") label = languageName(x.value);
		const muted = /^unknown$/i.test(x.value);
		return { key: x.value, label, share: x.share, count: x.users, ...(muted ? { muted } : {}) };
	});
}

/** A ranked bar list: label (right-aligned), bar scaled to the biggest share, share; the first `top` rows, then a toggle. */
export function BarList({ rows, top = 8, unit }: { rows: BarRow[]; top?: number; unit: string }) {
	const [all, setAll] = useState(false);
	if (rows.length === 0) return <EmptyState>Nothing in this range.</EmptyState>;
	const max = Math.max(...rows.map((r) => r.share), 0.0001);
	const shown = all ? rows : rows.slice(0, top);
	return (
		<div className="space-y-2.5">
			{shown.map((r) => (
				<div key={r.key} className="grid grid-cols-[minmax(5rem,9rem)_1fr] items-center gap-3 text-sm" title={`${r.label}: ${plural(r.count, unit)} (${fmtPct(r.share, 1)})`}>
					<div className={cn("truncate text-right", r.muted ? "text-muted-foreground italic" : "text-foreground/90")}>{r.label}</div>
					<div className="flex min-w-0 items-center gap-2">
						<div className="h-2.5 rounded-full" style={{ width: `${Math.max(1.5, (r.share / max) * 80)}%`, backgroundColor: r.muted ? "var(--muted-foreground)" : "var(--chart-1)", opacity: r.muted ? 0.4 : 1 }} />
						<span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtPct(r.share, 1)}</span>
					</div>
				</div>
			))}
			{rows.length > top ? (
				<button type="button" onClick={() => setAll(!all)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
					{all ? "Show fewer" : `Show all ${rows.length}`}
				</button>
			) : null}
		</div>
	);
}

function SourceBadge({ children }: { children: string }) {
	return (
		<Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
			{children}
		</Badge>
	);
}

const ROBLOX_CARDS: { key: RobloxDemographicBreakdown; title: string; top?: number }[] = [
	{ key: "AgeGroupV2", title: "Age" },
	{ key: "Gender", title: "Gender" },
	{ key: "Locale", title: "Language" },
	{ key: "Country", title: "Country", top: 10 },
	{ key: "Platform", title: "Platform" },
	{ key: "OperatingSystem", title: "Operating system" },
];

/** The filter bar's filters Roblox has no equivalent for (device, new / returning and country map to Roblox's dimensions). */
export function filtersRobloxCannotTake(state: FilterState): string[] {
	const out: string[] = [];
	if (state.branch) out.push("branch");
	if (state.art) out.push("artifact");
	if (state.exp && state.variant) out.push("experiment variant");
	if (state.lang) out.push("language");
	if (state.age) out.push("account age");
	if (state.prem) out.push("Premium");
	if (state.source) out.push("join source");
	return out;
}

const day = (iso: string) => iso.slice(0, 10);

/** "2026-10-18 - 2026-11-14 (28 days, UTC)" from Roblox's window (its end is exclusive). */
export function windowLabel(w: { from: string; to: string; days: number }): string {
	const last = new Date(Date.parse(w.to) - 1).toISOString();
	return w.days === 1 ? `${day(w.from)} (UTC)` : `${day(w.from)} - ${day(last)} (${w.days} days, UTC)`;
}

function RobloxSection() {
	const { state, apiFilters, pending } = useFilters();
	const params = {
		...(apiFilters.from !== undefined ? { from: String(apiFilters.from) } : {}),
		...(apiFilters.to !== undefined ? { to: String(apiFilters.to) } : {}),
		...(state.dev ? { dev: state.dev } : {}),
		...(state.players ? { players: state.players } : {}),
		...(state.country ? { country: state.country } : {}),
	};
	const q = useQuery({
		queryKey: ["roblox", "demographics", params],
		queryFn: ({ signal }) => api.robloxDemographics(params, signal),
		enabled: !pending,
		staleTime: 300_000,
		retry: false,
		placeholderData: keepPreviousData,
	});
	const off = q.error instanceof ApiError && q.error.status === 409;
	const noScope = q.error instanceof ApiError && q.error.message.includes(ANALYTICS_SCOPE);
	const cannot = filtersRobloxCannotTake(state);
	return (
		<section className="space-y-3">
			<h2 className="flex items-center gap-1.5 text-base font-semibold">
				From Roblox <SourceBadge>source: Roblox</SourceBadge>
			</h2>
			{q.isPending ? (
				<LoadingBlock rows={3} />
			) : off || noScope ? (
				<EmptyState>
					Off: give <code>OPENCLOUD_API_KEY</code> the <code>{ANALYTICS_SCOPE}</code> permission (API system universe-analytics, this experience) in Creator Hub
					{off ? (
						<>
							{" "}
							and set <code>TYPETORCH_UNIVERSE_ID</code>, then restart the backend
						</>
					) : null}
					. Age group and gender only come from here: Roblox doesn't give them to game servers.
				</EmptyState>
			) : q.isError ? (
				<ErrorState error={q.error} title="Roblox didn't answer" />
			) : (
				<>
					<div className="space-y-1 text-xs text-muted-foreground">
						<p>
							Creator Hub's Demographics: daily active users, {windowLabel(q.data.window)}
							{q.data.window.note ? ` (${q.data.window.note})` : ""}. Cached an hour.
						</p>
						{q.data.applied.length ? (
							<p>
								Filtered at Roblox:{" "}
								{q.data.applied.map((a) => `${a.filter} as ${a.dimension} ${a.values.join(" / ")}`).join("; ")}.
							</p>
						) : null}
						{q.data.notApplied.length || cannot.length ? (
							<p className="text-[var(--status-warning)]">
								Not applied here:{" "}
								{[...q.data.notApplied.map((n) => `${n.filter} (${n.reason})`), ...cannot.map((c) => `${c} (Roblox doesn't know it)`)].join("; ")}.
							</p>
						) : null}
					</div>
					<RobloxCards r={q.data} />
				</>
			)}
		</section>
	);
}

function RobloxCards({ r }: { r: RobloxDemographics }) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			{ROBLOX_CARDS.map((c) => {
				const card = r.breakdowns[c.key];
				return (
					<Section key={c.key} title={c.title} description={"error" in card ? undefined : `${fmtInt(card.total)} daily active users`}>
						{"error" in card ? <EmptyState>Roblox refused this card: {card.error}</EmptyState> : <BarList rows={robloxRows(c.key, card.rows)} unit="daily active user" {...(c.top ? { top: c.top } : {})} />}
					</Section>
				);
			})}
		</div>
	);
}

const OWN_CARDS: { key: DemographicDimension; title: string; info: string; top?: number }[] = [
	{ key: "country", title: "Country", info: "From LocalizationService on the game server at join.", top: 10 },
	{ key: "language", title: "Language", info: "The player's Roblox language setting (Player.LocaleId). Sent by the framework from 2026-11-15; players who only joined on older payloads show as Not sent." },
	{ key: "device", title: "Device", info: "The device of the player's sessions." },
	{ key: "accountAge", title: "Roblox account age", info: "How old the player's Roblox account was at join (not the player's age)." },
	{ key: "premium", title: "Premium", info: "Whether the player had Roblox Premium at join." },
];

function OwnSection() {
	const q = useAnalytics("demographics", {}, { keepPrevious: true });
	return (
		<section className="space-y-3">
			<h2 className="flex items-center gap-1.5 text-base font-semibold">
				From our events <SourceBadge>source: join events</SourceBadge>
			</h2>
			<QueryState query={q} isEmpty={(d) => d.players === 0} empty="No player joined in this range.">
				{(d) => (
					<>
						<p className="text-xs text-muted-foreground">{plural(d.players, "player")} with a join; every filter applies, and each player counts once per card.</p>
						<div className="grid gap-4 md:grid-cols-2">
							{OWN_CARDS.map((c) => (
								<Section key={c.key} title={c.title} description={c.info}>
									<BarList rows={ownRows(c.key, d)} unit="player" {...(c.top ? { top: c.top } : {})} />
								</Section>
							))}
						</div>
					</>
				)}
			</QueryState>
		</section>
	);
}

export default function Demographics() {
	return (
		<>
			<PageHeader title="Demographics" description="Who plays: Roblox's own breakdowns (age, gender, language, country, platform), and what our join events say (country, language, device, account age, Premium)." />
			<div className="space-y-8">
				<RobloxSection />
				<OwnSection />
			</div>
		</>
	);
}
