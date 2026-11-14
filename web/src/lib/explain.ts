/**
 * "Explain this change": labels, number formats and the plain-language headline for the `explain` query's answer
 * (src/queries/explain.ts in the backend says how the rate and mix effects are computed).
 */
import { fmtInt, fmtMinutes, fmtNum, fmtPct } from "./format";
import type { ExplainDimension, ExplainMetric, ExplainResult, ExplainSegment, ExplainUnit } from "./types";

export const EXPLAIN_METRIC_LABELS: Record<ExplainMetric, string> = {
	players: "Players",
	dau: "DAU",
	newPlayers: "New players",
	returningPlayers: "Returning players",
	sessions: "Sessions",
	playtime: "Playtime",
	playtimePerPlayer: "Playtime per player",
	sessionsPerPlayer: "Sessions per player",
	avgSession: "Avg session",
	d1: "D1",
	payerConversion: "Payer conversion",
	robuxPerPlayer: "Robux per player",
	revenuePerPlayer: "Revenue per player",
};

export const EXPLAIN_METRICS = Object.keys(EXPLAIN_METRIC_LABELS) as ExplainMetric[];

export const DIMENSION_LABELS: Record<ExplainDimension, string> = {
	device: "Device",
	country: "Country",
	language: "Language",
	accountAge: "Account age",
	premium: "Premium",
	source: "Join source",
	build: "Build",
	branch: "Branch",
	playerType: "New / returning",
};

const names = (type: "region" | "language") => {
	try {
		return new Intl.DisplayNames(["en"], { type });
	} catch {
		return undefined;
	}
};
const regionNames = names("region");
const languageNames = names("language");
const display = (n: Intl.DisplayNames | undefined, code: string) => {
	try {
		return n?.of(code) ?? code;
	} catch {
		return code;
	}
};

const DEVICES: Record<string, string> = { phone: "phones", desktop: "desktops", tablet: "tablets", console: "consoles", vr: "VR" };

/** A segment as a table / chart label: "phone", "United States", "Portuguese", "Premium", "Not sent", "Other (3)". */
export function segmentName(dimension: ExplainDimension, s: Pick<ExplainSegment, "value" | "other" | "segments">): string {
	if (s.other) return `Other (${s.segments ?? 0})`;
	const v = s.value;
	if (v === null) return "Not sent";
	if (dimension === "country" && /^[A-Za-z]{2}$/.test(v)) return display(regionNames, v.toUpperCase());
	if (dimension === "language" && /^[a-z]{2,3}$/.test(v)) return display(languageNames, v);
	if (dimension === "premium") return v === "true" ? "Premium" : "Not Premium";
	if (dimension === "playerType") return v === "new" ? "New" : "Returning";
	return v;
}

/** A segment inside a sentence: "phones", "players from United States", "join source teleport", "build abc-42". */
export function segmentPhrase(dimension: ExplainDimension, s: Pick<ExplainSegment, "value" | "other" | "segments">): string {
	if (s.other) return `other ${DIMENSION_LABELS[dimension].toLowerCase()} values`;
	const v = s.value;
	if (v === null) return `players with no ${DIMENSION_LABELS[dimension].toLowerCase()} sent`;
	switch (dimension) {
		case "device":
			return DEVICES[v] ?? `${v} players`;
		case "country":
			return `players from ${segmentName(dimension, s)}`;
		case "language":
			return `${segmentName(dimension, s)} speakers`;
		case "accountAge":
			return `accounts aged ${v}`;
		case "premium":
			return v === "true" ? "Premium players" : "non-Premium players";
		case "source":
			return `join source ${v}`;
		case "build":
			return `build ${v}`;
		case "branch":
			return `branch ${v}`;
		case "playerType":
			return v === "new" ? "new players" : "returning players";
	}
}

/** A value of the metric: "42.1%", "12.5 min", "R$ 1.23", "1,204". */
export function fmtMetric(unit: ExplainUnit, value: number | null | undefined): string {
	if (value === null || value === undefined) return "–";
	switch (unit) {
		case "share":
			return fmtPct(value, 1);
		case "minutes":
			return fmtMinutes(value);
		case "hours":
			return `${fmtNum(value, 1)} h`;
		case "robux":
			return `R$ ${fmtNum(value, 2)}`;
		case "number":
			return fmtNum(value, 2);
		default:
			return fmtInt(value);
	}
}

/** A change of the metric, without its sign: "4.1 points", "1.2 min", "120 players", "R$ 0.40". */
export function fmtDelta(unit: ExplainUnit, delta: number): string {
	const d = Math.abs(delta);
	switch (unit) {
		case "share": {
			const points = d * 100;
			return `${fmtNum(points, points < 1 ? 2 : 1)} points`;
		}
		case "minutes":
			return d < 1 ? `${Math.round(d * 60)} s` : `${fmtNum(d, 1)} min`;
		case "hours":
			return `${fmtNum(d, 1)} h`;
		case "robux":
			return `R$ ${fmtNum(d, 2)}`;
		case "number":
			return fmtNum(d, 2);
		case "sessions":
			return `${fmtInt(d)} sessions`;
		default:
			return `${fmtInt(d)} players`;
	}
}

/** A signed change for the table: "+4.1 points", "-120 players". */
export function fmtSigned(unit: ExplainUnit, delta: number): string {
	if (delta === 0) return "0";
	return `${delta > 0 ? "+" : "-"}${fmtDelta(unit, delta)}`;
}

/** One reason the metric moved: a segment's rate or mix effect (counts: its whole change). */
export interface ExplainItem {
	dimension: ExplainDimension;
	segment: ExplainSegment;
	part: "rate" | "mix" | "count";
	/** In the metric's unit. */
	value: number;
	/** value / the total change. */
	share: number;
}

/** Every rate and mix effect pushing the same way as the change, biggest share first; small segments after the rest. */
export function explainItems(r: ExplainResult): ExplainItem[] {
	if (!r.change) return [];
	const items: ExplainItem[] = [];
	for (const d of r.dimensions) {
		for (const s of d.segments) {
			if (s.other) continue;
			const parts: ["rate" | "mix" | "count", number][] = r.kind === "count" ? [["count", s.contribution]] : [["rate", s.rate], ["mix", s.mix]];
			for (const [part, value] of parts) {
				const share = value / r.change;
				if (share > 0) items.push({ dimension: d.dimension, segment: s, part, value, share });
			}
		}
	}
	return items.sort((a, b) => Number(a.segment.small) - Number(b.segment.small) || b.share - a.share);
}

const pct = (share: number) => fmtPct(share, 0);

function itemText(item: ExplainItem, first: boolean): string {
	const lead = `${pct(item.share)}${first ? " of it" : ""} is `;
	const phrase = segmentPhrase(item.dimension, item.segment);
	const notes = [item.part === "count" ? "" : item.part, item.segment.small ? "few players" : ""].filter(Boolean);
	const note = notes.length ? ` (${notes.join(", ")})` : "";
	if (item.part === "mix") {
		const bigger = item.segment.current.share >= item.segment.baseline.share;
		return `${lead}a ${bigger ? "bigger" : "smaller"} share of ${phrase}${note}`;
	}
	return `${lead}${phrase}${note}`;
}

/**
 * The panel's first line, e.g. "D1 fell 4.1 points; 72% of it is phones (rate) and 15% is a bigger share of join source
 * X (mix)": the biggest effect, then the biggest of the other kind (rate or mix) from another dimension (dimensions
 * overlap: the same players are in one segment of each, so their shares don't add up across dimensions).
 */
export function explainHeadline(r: ExplainResult): string {
	const name = EXPLAIN_METRIC_LABELS[r.metric];
	if (!r.change) return `${name} didn't change (${fmtMetric(r.unit, r.current.value)} in both periods).`;
	const relative = r.kind === "count" && r.relative !== null ? ` (${r.relative > 0 ? "+" : ""}${fmtPct(r.relative, Math.abs(r.relative) < 0.1 ? 1 : 0)})` : "";
	const moved = `${name} ${r.change > 0 ? "rose" : "fell"} ${fmtDelta(r.unit, r.change)}${relative}`;
	const items = explainItems(r);
	const first = items[0];
	if (!first) return `${moved}; no single segment explains it: the segments moved in different directions.`;
	// Then what else moved it: the other kind of effect (rate <-> mix) when one explains 5%+, else any, from another dimension.
	const others = items.filter((i) => i.dimension !== first.dimension && i.share >= 0.05);
	const second = others.find((i) => i.part !== first.part) ?? others[0];
	return `${moved}; ${itemText(first, true)}${second ? ` and ${itemText(second, false)}` : ""}.`;
}

/** The dimensions, the most telling first: the biggest share of the change one trusted segment explains. */
export function rankDimensions(r: ExplainResult): ExplainResult["dimensions"] {
	const best = (d: ExplainResult["dimensions"][number]) => Math.max(0, ...d.segments.filter((s) => !s.other && !s.small).map((s) => Math.abs(s.shareOfChange ?? 0)));
	return [...r.dimensions].sort((a, b) => best(b) - best(a));
}
