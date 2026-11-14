/**
 * Who plays, from our own join events (`session` / `join`, one per session; the framework fills its props): country
 * (LocalizationService), language (Player.LocaleId, framework 2026-11-15 on; older payloads have none), Roblox account
 * age bucket, Premium, and device (from all their rows: a real device wins over "unknown"). Each player counts once per dimension, with the highest value their joins in the
 * window carry (a player rarely changes country or device inside one window). Shares are of the players with a join.
 * Every filter of the filter bar applies (new / returning: the joins of first-ever sessions / of the others).
 *
 * Roblox's own age group and gender aren't given to game servers: those come from the Analytics Query API
 * (server/roblox-analytics.ts, GET /v1/roblox/demographics).
 */
import { NOT_STUDIO, defineQuery, eventsTable, playerRows, ratio, str, num, type QueryContext } from "./core.ts";
import type { NormalizedFilters } from "../sql/filters.ts";

export const DEMOGRAPHIC_DIMENSIONS = ["country", "language", "accountAge", "premium", "device"] as const;
export type DemographicDimension = (typeof DEMOGRAPHIC_DIMENSIONS)[number];

export interface DemographicRow {
	/** The raw value (an ISO country code, a language code, an age bucket, "true"/"false", a device); null = not sent. */
	value: string | null;
	players: number;
	/** Of the players with a join in the window. */
	share: number;
}

export interface DemographicsResult {
	from: string;
	to: string;
	/** Players with a join in the window. */
	players: number;
	dimensions: Record<DemographicDimension, DemographicRow[]>;
}

/** Values kept per dimension (countries: about 200 exist). */
const MAX_VALUES = 250;

function valueExpr(ctx: QueryContext, d: DemographicDimension): string {
	const j = (key: string) => ctx.dialect.jsonText("e.props", key);
	switch (d) {
		case "country":
			return `UPPER(${j("country")})`;
		// "en-us" -> "en": the language without the region, like Creator Hub's Language card.
		case "language":
			return `LOWER(split_part(${j("locale")}, '-', 1))`;
		case "accountAge":
			return j("age");
		case "premium":
			return `LOWER(${j("prem")})`;
		case "device":
			return "e.dev";
	}
}

/**
 * One value per player: the highest their joins carry. For the device, "unknown" (rows from before the client reported
 * its device) only when no real device was seen; a plain MAX would pick it, as it sorts after every device name.
 */
function playerValue(ctx: QueryContext, d: DemographicDimension): string {
	if (d === "device") return "COALESCE(MAX(NULLIF(NULLIF(e.dev, ''), 'unknown')), MAX(NULLIF(e.dev, '')))";
	return `MAX(NULLIF(${valueExpr(ctx, d)}, ''))`;
}

export const demographics = defineQuery<Record<string, never>, DemographicsResult>({
	name: "demographics",
	summary: "who plays, from join events: country, language, account age, Premium, device (share of players)",
	defaultDays: 28,
	options: () => ({}),
	statements(ctx, f: NormalizedFilters) {
		const lim = ctx.dialect.limit;
		const joins = `${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx, `e.kind = 'session' AND e.name = 'join' AND ${NOT_STUDIO}`)}`;
		const out: Record<string, string> = {
			total: `SELECT COUNT(DISTINCT e.pid) AS players FROM ${joins} ${lim(1)}`,
		};
		// The device from all of a player's rows (the join is sent before the client reports its device, so it often says
		// "unknown"), counting only the players with a join, like the other cards.
		const allRows = `${eventsTable(ctx, f)} e WHERE ${playerRows(f, ctx, NOT_STUDIO)}`;
		for (const d of DEMOGRAPHIC_DIMENSIONS) {
			const perPlayer =
				d === "device"
					? `SELECT e.pid AS pid, ${playerValue(ctx, d)} AS v FROM ${allRows} GROUP BY e.pid HAVING MAX(CASE WHEN e.kind = 'session' AND e.name = 'join' THEN 1 ELSE 0 END) = 1`
					: `SELECT e.pid AS pid, ${playerValue(ctx, d)} AS v FROM ${joins} GROUP BY e.pid`;
			out[d] = `SELECT v, COUNT(*) AS players FROM (${perPlayer}) x GROUP BY v ORDER BY players DESC, v ${lim(MAX_VALUES)}`;
		}
		return out;
	},
	shape(rows, _ctx, f) {
		const players = num(rows.total[0]?.players);
		const dimensions = {} as Record<DemographicDimension, DemographicRow[]>;
		for (const d of DEMOGRAPHIC_DIMENSIONS) {
			dimensions[d] = (rows[d] ?? []).map((r) => {
				const n = num(r.players);
				return { value: r.v === null || r.v === undefined ? null : str(r.v).slice(0, 40), players: n, share: ratio(n, players) };
			});
		}
		return { from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString(), players, dimensions };
	},
});
