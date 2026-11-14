/**
 * The audience: names for the join data's codes (country, language, account age, join source), shared by the filter
 * bar's Audience filters and the Demographics page.
 */
import { ACCOUNT_AGES, type AccountAge, type DemographicsResult } from "./types";

const regionNames = (() => {
	try {
		return new Intl.DisplayNames(["en"], { type: "region" });
	} catch {
		return undefined;
	}
})();
const languageNames = (() => {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" });
	} catch {
		return undefined;
	}
})();

/** "US" -> "United States"; anything Intl doesn't know stays as it is. */
export function countryName(code: string): string {
	if (!/^[A-Za-z]{2}$/.test(code)) return code;
	try {
		return regionNames?.of(code.toUpperCase()) ?? code;
	} catch {
		return code;
	}
}

/** "en" / "en-us" / "en_us" -> "English" (the language without the region, like Creator Hub's Language card). */
export function languageName(code: string): string {
	const base = code.split(/[-_]/)[0]?.toLowerCase() ?? "";
	if (!/^[a-z]{2,3}$/.test(base)) return code;
	try {
		return languageNames?.of(base) ?? code;
	} catch {
		return code;
	}
}

export const ACCOUNT_AGE: Record<AccountAge, string> = {
	"<1d": "Under a day",
	"1-7d": "1-7 days",
	"7-30d": "1-4 weeks",
	"30-90d": "1-3 months",
	"90-365d": "3-12 months",
	"1-3y": "1-3 years",
	"3y+": "3+ years",
};
export const ACCOUNT_AGE_ORDER: readonly string[] = ACCOUNT_AGES;

/** The join sources the framework sends (`from` of session/join; framework analytics SCHEMA.md). */
export const JOIN_SOURCES: Record<string, string> = {
	direct: "Direct (home, search, sorts)",
	teleport: "Teleport (this game)",
	teleport_game: "Teleport (another game)",
	referral: "Referral / invite link",
	share: "Share link (launch data)",
	follow: "Followed someone",
};

export function joinSourceName(source: string): string {
	return JOIN_SOURCES[source] ?? source;
}

export interface Choice {
	value: string;
	label: string;
}

/**
 * The country and language choices for the Audience filters: the values the demographics query saw in the range, most
 * players first, named; the value picked now is kept even when the range doesn't have it.
 */
export function audienceChoices(r: DemographicsResult | undefined, picked: { country?: string; lang?: string } = {}): { countries: Choice[]; languages: Choice[] } {
	const of = (dimension: "country" | "language", name: (v: string) => string, keep?: string): Choice[] => {
		const values = (r?.dimensions[dimension] ?? []).flatMap((x) => (x.value ? [{ value: x.value, label: `${name(x.value)} (${x.value})`, players: x.players }] : []));
		const out: Choice[] = values.map(({ value, label }) => ({ value, label }));
		if (keep && !out.some((c) => c.value === keep)) out.unshift({ value: keep, label: `${name(keep)} (${keep})` });
		return out;
	};
	return { countries: of("country", countryName, picked.country), languages: of("language", languageName, picked.lang) };
}
