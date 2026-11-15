/**
 * Filters every logical query accepts, and their SQL. Values are checked and rendered as literals (Basin's SQL API
 * takes one query string, so there are no bind parameters anywhere).
 */
import { DEVICES, type Device } from "../schema.ts";
import { DAY_MS, assertSafeKey, int, lit, type Dialect } from "./dialect.ts";

export interface Filters {
	/** Start (inclusive): unix ms, an ISO time, or a date ("2026-10-01" = that day's 00:00 UTC). */
	from?: number | string;
	/** End: unix ms or an ISO time (exclusive), or a date (inclusive: "2026-10-05" includes that whole day). */
	to?: number | string;
	/** Artifact id(s). */
	art?: string | string[];
	branch?: string | string[];
	channel?: string | string[];
	dev?: Device | Device[];
	/** "new": first-ever sessions only (`newp`); "returning": every other session. */
	players?: "new" | "returning";
	/** Players in an experiment variant (read from the `exp` column). */
	variant?: { experiment: string; variant: string | string[] };
	/** Server experiment(s) (`sexp`). */
	sexp?: string | string[];
	place?: number;
	// Audience (player-level, from the players' join rows in the range; see whereSql):
	/** ISO country code(s), e.g. "US" (join `country`). */
	country?: string | string[];
	/** Language code(s) without the region, e.g. "en" (join `locale` "en-us"; framework 2026-11-15 on). */
	lang?: string | string[];
	/** Roblox account-age bucket(s) (join `age`). */
	age?: AccountAge | AccountAge[];
	/** Roblox Premium at the join (join `prem`); "true" / "false" are taken too (URL parameters). */
	prem?: boolean | "true" | "false";
	/** Join source(s) (join `from`: direct, teleport, teleport_game, referral, share, follow, ...). */
	source?: string | string[];
}

/** The account-age buckets the framework sends (join `age`). */
export const ACCOUNT_AGES = ["<1d", "1-7d", "7-30d", "30-90d", "90-365d", "1-3y", "3y+"] as const;
export type AccountAge = (typeof ACCOUNT_AGES)[number];

/** The audience filters: player-level, matched on the players' join rows (see whereSql). */
export const AUDIENCE_KEYS = ["country", "lang", "age", "prem", "source"] as const;

/** Filters after checking, with the time range resolved to ms. */
export interface NormalizedFilters
	extends Omit<Filters, "from" | "to" | "art" | "branch" | "channel" | "dev" | "sexp" | "country" | "lang" | "age" | "prem" | "source"> {
	from: number;
	to: number;
	art?: string[];
	branch?: string[];
	channel?: string[];
	dev?: Device[];
	sexp?: string[];
	/** Upper case. */
	country?: string[];
	/** Lower case. */
	lang?: string[];
	age?: AccountAge[];
	prem?: boolean;
	source?: string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseTime(value: number | string, what: string, endOfDay: boolean): number {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new Error(`${what} must be unix milliseconds`);
		return value;
	}
	const text = value.trim();
	if (/^\d{12,14}$/.test(text)) return Number(text);
	const ms = Date.parse(DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text);
	if (!Number.isFinite(ms)) throw new Error(`${what} is not a date or time: ${JSON.stringify(value)}`);
	return DATE_ONLY.test(text) && endOfDay ? ms + DAY_MS : ms;
}

/**
 * The UTC days (inclusive) a `from` / `to` pair covers, for the day rollups: dates as before ("2026-10-05" to
 * "2026-10-05" is that day), and exact instants (unix ms or ISO; `to` exclusive) widen to the days they touch, so a
 * "last hour" window reads the rollups of the one or two days it falls in. Missing ends are open.
 */
export function rollupDays(from: string | null | undefined, to: string | null | undefined): { first: number; last: number } {
	const first = from ? Math.floor(parseTime(from, "from", false) / DAY_MS) : -Infinity;
	const last = to ? Math.floor((parseTime(to, "to", true) - 1) / DAY_MS) : Infinity;
	return { first, last };
}

function list<T extends string>(value: T | T[] | undefined, what: string, check?: (v: string) => void): T[] | undefined {
	if (value === undefined) return undefined;
	const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
	if (values.length === 0) return undefined;
	if (values.length > 50) throw new Error(`${what}: at most 50 values`);
	for (const v of values) {
		if (typeof v !== "string" || v.length > 128) throw new Error(`${what} values must be strings of at most 128 characters`);
		check?.(v);
	}
	return values;
}

/**
 * Checks filters and resolves the time range. Without `from`, the range starts `defaultDays` before `to` (default:
 * now). Basin bills by data scanned, so every query has a range.
 */
export function normalizeFilters(filters: Filters = {}, options: { now: number; defaultDays: number }): NormalizedFilters {
	const to = filters.to !== undefined ? parseTime(filters.to, "to", true) : options.now;
	const from = filters.from !== undefined ? parseTime(filters.from, "from", false) : to - options.defaultDays * DAY_MS;
	if (from >= to) throw new Error("from must be before to");
	const out: NormalizedFilters = { from, to };
	out.art = list(filters.art, "art");
	out.branch = list(filters.branch, "branch");
	out.channel = list(filters.channel, "channel");
	out.sexp = list(filters.sexp, "sexp");
	out.dev = list(filters.dev, "dev", (d) => {
		if (!(DEVICES as readonly string[]).includes(d)) throw new Error(`dev must be one of ${DEVICES.join(", ")}`);
	});
	if (filters.players !== undefined) {
		if (filters.players !== "new" && filters.players !== "returning") throw new Error('players must be "new" or "returning"');
		out.players = filters.players;
	}
	if (filters.variant !== undefined) {
		assertSafeKey(filters.variant.experiment, "experiment");
		const variants = list(filters.variant.variant, "variant");
		if (!variants) throw new Error("variant.variant is required");
		out.variant = { experiment: filters.variant.experiment, variant: variants };
	}
	if (filters.place !== undefined) {
		if (!Number.isSafeInteger(filters.place)) throw new Error("place must be an integer");
		out.place = filters.place;
	}
	out.country = list(filters.country, "country", (v) => {
		if (!/^[A-Za-z]{2}$/.test(v)) throw new Error("country must be a two-letter ISO code such as US");
	})?.map((v) => v.toUpperCase());
	out.lang = list(filters.lang, "lang", (v) => {
		if (!/^[A-Za-z]{2,3}$/.test(v)) throw new Error("lang must be a two- or three-letter language code such as en");
	})?.map((v) => v.toLowerCase());
	out.age = list(filters.age, "age", (v) => {
		if (!(ACCOUNT_AGES as readonly string[]).includes(v)) throw new Error(`age must be one of ${ACCOUNT_AGES.join(", ")}`);
	});
	out.source = list(filters.source, "source", (v) => {
		if (!/^[a-z][a-z0-9_]{0,31}$/.test(v)) throw new Error("source must be a join source such as direct or teleport (lowercase letters, digits, _)");
	});
	if (filters.prem !== undefined) {
		const prem = filters.prem as unknown;
		if (prem === true || prem === "true") out.prem = true;
		else if (prem === false || prem === "false") out.prem = false;
		else throw new Error("prem must be true or false");
	}
	for (const key of Object.keys(out) as (keyof NormalizedFilters)[]) if (out[key] === undefined) delete out[key];
	return out;
}

function inList(column: string, values: readonly string[]): string {
	return values.length === 1 ? `${column} = ${lit(values[0])}` : `${column} IN (${values.map(lit).join(", ")})`;
}

export interface WhereOptions {
	/** Column prefix, e.g. "e." */
	prefix?: string;
	/** Leave out the time range (the caller adds its own). */
	noTime?: boolean;
	/** Only the filters that exist on the recordings table (time, art), and only `codecs` rows (default tt-rec-1). */
	recordings?: boolean;
	/** With `recordings`: the codecs to read (default `["tt-rec-1"]`; plans/36's `tt-ext-1` rows only when asked). */
	codecs?: readonly string[];
	/**
	 * The events table for a range: the audience filters need it (their join rows). Without it they don't apply (server
	 * and fleet rows have no player, like the device filter's perf.ts serverFilters).
	 */
	table?: (from: number, to: number) => string;
}

/** Whether any audience filter is set. */
export function hasAudience(f: NormalizedFilters): boolean {
	return AUDIENCE_KEYS.some((k) => f[k] !== undefined);
}

/** A join row's audience value as SQL (on a JSON props column): the same expressions the demographics query reads. */
export function audienceValueSql(dialect: Dialect, props: string, key: "country" | "lang" | "age" | "source"): string {
	switch (key) {
		case "country":
			return `UPPER(${dialect.jsonText(props, "country")})`;
		// "en-us" -> "en": the language without the region, like Creator Hub's Language card.
		case "lang":
			return `LOWER(split_part(${dialect.jsonText(props, "locale")}, '-', 1))`;
		case "age":
			return dialect.jsonText(props, "age");
		case "source":
			return dialect.jsonText(props, "from");
	}
}

/**
 * The audience filters as one condition on the join rows (alias `aj`), or null when none is set. Each filter is one
 * test on a row, so "US and Premium" means one join row that says both (a player changes neither inside a window).
 */
function audienceJoinSql(f: NormalizedFilters, dialect: Dialect): string | null {
	const parts: string[] = [];
	for (const key of ["country", "lang", "age", "source"] as const) {
		const values = f[key];
		if (values) parts.push(inList(audienceValueSql(dialect, "aj.props", key), values));
	}
	if (f.prem !== undefined) parts.push(f.prem ? `${dialect.jsonBool("aj.props", "prem")} = TRUE` : `${dialect.jsonBool("aj.props", "prem")} = FALSE`);
	return parts.length ? parts.join(" AND ") : null;
}

/** The filters as one SQL condition (never empty: "TRUE" when nothing applies). */
export function whereSql(f: NormalizedFilters, dialect: Dialect, options: WhereOptions = {}): string {
	const p = options.prefix ?? "";
	const parts: string[] = [];
	if (!options.noTime) parts.push(`${p}t >= ${int(f.from)}`, `${p}t < ${int(f.to)}`);
	if (f.art) parts.push(inList(`${p}art`, f.art));
	if (options.recordings) parts.push(inList(`${p}codec`, [...(options.codecs ?? ["tt-rec-1"])]));
	if (!options.recordings) {
		if (f.branch) parts.push(inList(`${p}branch`, f.branch));
		if (f.channel) parts.push(inList(`${p}channel`, f.channel));
		if (f.dev) parts.push(inList(`${p}dev`, f.dev));
		if (f.sexp) parts.push(inList(`${p}sexp`, f.sexp));
		if (f.place !== undefined) parts.push(`${p}place = ${int(f.place)}`);
		if (f.players === "new") parts.push(`${p}newp = TRUE`);
		if (f.players === "returning") parts.push(`(${p}newp IS NULL OR ${p}newp = FALSE)`);
		if (f.variant) parts.push(inList(dialect.jsonText(`${p}exp`, f.variant.experiment), f.variant.variant as string[]));
		// Player-level: every row of a player with a join row in the range that matches (a semi-join; rows without a
		// player drop out). No LIMIT inside: a capped list would cut the audience silently.
		const audience = options.table ? audienceJoinSql(f, dialect) : null;
		if (audience && options.table) {
			parts.push(
				`${p}pid IN (SELECT aj.pid FROM ${options.table(f.from, f.to)} aj WHERE aj.t >= ${int(f.from)} AND aj.t < ${int(f.to)} ` +
					`AND aj.kind = 'session' AND aj.name = 'join' AND aj.pid IS NOT NULL AND aj.pid <> '' AND ${audience})`,
			);
		}
	}
	return parts.length ? parts.join(" AND ") : "TRUE";
}
