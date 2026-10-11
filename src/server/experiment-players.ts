/**
 * GET /v1/experiments/<experiment>/players: the request's parameters as the `experiment-players` query's filters and
 * options (the query checks the values; this only maps the URL and refuses what can't be mapped).
 *
 *   ?variant=          one variant (the per-variant counts still cover all of them)
 *   &limit=            1-200 (default 200)
 *   &from=&to=         the explorer's range (unix ms, ISO, or a date), or &window=30m|6h|7d (ends now) without `from`
 *   &branch=&art=&channel=&dev=&sexp=   repeatable;  &players=new|returning;  &place=
 *   &inExperiment=&inVariant=           the filter bar's "players in a variant" filter (another experiment's variant)
 */
import type { Filters } from "../sql/filters.ts";
import type { ExperimentPlayersOptions } from "../queries/experiment.ts";
import { EXPERIMENT_PLAYERS_MAX } from "../queries/experiment.ts";

export class ExperimentPlayersInput extends Error {
	override name = "ExperimentPlayersInput";
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const LIST_FILTERS = ["branch", "art", "channel", "dev", "sexp"] as const;
/** Longest raw parameter value read (the query refuses longer filter values itself; this bounds the work before it). */
const MAX_PARAM = 256;

function one(q: URLSearchParams, key: string): string | undefined {
	const v = q.get(key);
	if (v === null || v === "") return undefined;
	if (v.length > MAX_PARAM) throw new ExperimentPlayersInput(`${key} is too long`);
	return v;
}

export function parseExperimentPlayers(path: string, q: URLSearchParams, now: number): { filters: Filters; options: Partial<ExperimentPlayersOptions> } {
	const m = /^\/v1\/experiments\/([^/]+)\/players$/.exec(path);
	if (!m) throw new ExperimentPlayersInput("not found");
	let experiment: string;
	try {
		experiment = decodeURIComponent(m[1] as string);
	} catch {
		throw new ExperimentPlayersInput("bad experiment name");
	}
	const options: Partial<ExperimentPlayersOptions> = { experiment };
	const variant = one(q, "variant");
	if (variant !== undefined) options.variant = variant;
	const limit = one(q, "limit");
	if (limit !== undefined) {
		const n = Number(limit);
		if (!/^\d{1,4}$/.test(limit) || n < 1 || n > EXPERIMENT_PLAYERS_MAX) throw new ExperimentPlayersInput(`limit is a whole number from 1 to ${EXPERIMENT_PLAYERS_MAX}`);
		options.limit = n;
	}

	const filters: Filters = {};
	const from = one(q, "from");
	const to = one(q, "to");
	if (from !== undefined) filters.from = from;
	if (to !== undefined) filters.to = to;
	const window = one(q, "window");
	if (window !== undefined && from === undefined) {
		const w = /^(\d{1,4})([mhd])$/.exec(window);
		if (!w) throw new ExperimentPlayersInput("window is a number and m, h or d (e.g. 30m, 24h, 7d)");
		const end = to !== undefined && /^\d{12,14}$/.test(to) ? Number(to) : now;
		filters.from = end - Number(w[1]) * (UNIT_MS[w[2] as string] as number);
	}
	for (const key of LIST_FILTERS) {
		const values = q.getAll(key).filter((v) => v !== "");
		if (!values.length) continue;
		if (values.length > 50) throw new ExperimentPlayersInput(`${key}: at most 50 values`);
		if (values.some((v) => v.length > MAX_PARAM)) throw new ExperimentPlayersInput(`${key} is too long`);
		(filters as Record<string, unknown>)[key] = values;
	}
	const players = one(q, "players");
	if (players !== undefined) {
		if (players !== "new" && players !== "returning") throw new ExperimentPlayersInput('players is "new" or "returning"');
		filters.players = players;
	}
	const place = one(q, "place");
	if (place !== undefined) {
		if (!/^\d{1,16}$/.test(place)) throw new ExperimentPlayersInput("place is a PlaceId (digits)");
		filters.place = Number(place);
	}
	const inExperiment = one(q, "inExperiment");
	const inVariant = q.getAll("inVariant").filter((v) => v !== "");
	if (inExperiment !== undefined || inVariant.length) {
		if (inExperiment === undefined || !inVariant.length) throw new ExperimentPlayersInput("inExperiment and inVariant go together");
		if (inVariant.length > 50 || inVariant.some((v) => v.length > MAX_PARAM)) throw new ExperimentPlayersInput("inVariant: at most 50 values");
		filters.variant = { experiment: inExperiment, variant: inVariant };
	}
	return { filters, options };
}
