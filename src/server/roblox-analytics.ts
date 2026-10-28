/**
 * Creator Hub's acquisition numbers from Roblox itself (Open Cloud Analytics Query API, `universe.analytics:read` on
 * OPENCLOUD_API_KEY, TYPETORCH_UNIVERSE_ID): the play-through rate and its parts, which a game server can't see (they
 * start at the Home impression). Per metric one query over the last 2 x `days` full UTC days at one-day buckets, split
 * into the period and the period before, like the `benchmarks` query:
 *   - RFYPlayThroughRate                   "Play through rate (home recommendations)": Creator Hub's PTR chart
 *   - QualifiedEndToEndCVR                 "Qualified play through rate per user", every acquisition source
 *   - UniqueUsersWithImpressions           users who saw the game's tile, per day (also per AcquisitionSource)
 *   - QualifiedUniqueUsersWithPlaySessions users with a qualified play, per day (also per AcquisitionSource)
 * A rate over the period is the mean of its daily values (Creator Hub's moving average); a count the sum of the days.
 * Roblox doesn't document a rate's scale: it is read as a fraction, unless a day's value is above 1 (then percent).
 * The genre benchmarks (50th / 90th) aren't in the API; the user still copies those from Creator Hub.
 *
 * Roblox allows 30 queries a minute per key owner. A refresh is 6 queries (plus polls of a slow one), the answer is
 * kept `ttlMs` (1 h: the data is daily), one refresh runs at a time, and at most `perMinute` (default 12) queries
 * leave the server a minute. The key goes only into `x-api-key` (opencloud.ts), never into an answer or a log line.
 */
import { ANALYTICS_READ_SCOPE, OpenCloudError, queryAnalyticsMetric, type AnalyticsSeries } from "../opencloud.ts";
import { RateLimiter } from "./http.ts";

const DAY_MS = 86_400_000;
export const ACQUISITION_DAYS = [7, 14, 28] as const;

export interface AcquisitionPeriod {
	/** The period's first day, 00:00 UTC, and the end of its last day (exclusive). */
	from: string;
	to: string;
	/** Days Roblox had a value for (rates: the days with a play-through value). */
	daysWithData: number;
	/** Roblox's "Play through rate (home recommendations)", mean of the days, as a fraction; null without data. */
	playThroughHome: number | null;
	/** Roblox's "Qualified play through rate per user" (every source), mean of the days, as a fraction. */
	qualifiedPlayThrough: number | null;
	/** Users who saw the game's tile (unique per day), summed over the days. */
	impressions: number;
	/** Users with a qualified play (unique per day), summed over the days. */
	qualifiedPlays: number;
}

export interface AcquisitionDay {
	day: string;
	playThroughHome: number | null;
	qualifiedPlayThrough: number | null;
	impressions: number | null;
	qualifiedPlays: number | null;
}

export interface AcquisitionSource {
	/** The AcquisitionSource value as Roblox sent it (e.g. `HomeRecommendations`). */
	source: string;
	/** Roblox's display name for it, when sent. */
	label: string;
	impressions: number;
	qualifiedPlays: number;
	/** qualifiedPlays / impressions over the period, or null without impressions. */
	rate: number | null;
}

export interface AcquisitionResult {
	days: number;
	/** The metric ids asked, as the API names them. */
	metrics: Record<"playThroughHome" | "qualifiedPlayThrough" | "impressions" | "qualifiedPlays", string>;
	current: AcquisitionPeriod;
	previous: AcquisitionPeriod;
	/** Both periods, oldest first. */
	daily: AcquisitionDay[];
	/** The current period per acquisition source, most impressions first. */
	sources: AcquisitionSource[];
	/** When Roblox was asked (ISO). */
	fetchedAt: string;
}

export class RobloxAnalyticsError extends Error {
	override name = "RobloxAnalyticsError";
	constructor(
		message: string,
		/** What the explorer gets: 400 (Roblox refused the query), 409 (not configured), 429, 502 (Roblox failed or refused the key), 504 (too slow). */
		readonly status: number,
	) {
		super(message);
	}
}

export interface RobloxAnalyticsOptions {
	apiKey?: string;
	universeId?: number;
	fetch?: typeof fetch;
	clock?: () => number;
	/** Analytics queries a minute at most (default 12, well under Roblox's 30 shared by every use of the key). */
	perMinute?: number;
	ttlMs?: number;
	/** Per Open Cloud call (default 10 s). */
	timeoutMs?: number;
	/** Between polls of a slow query (default 1 s). */
	pollMs?: number;
}

export const METRICS = {
	playThroughHome: "RFYPlayThroughRate",
	qualifiedPlayThrough: "QualifiedEndToEndCVR",
	impressions: "UniqueUsersWithImpressions",
	qualifiedPlays: "QualifiedUniqueUsersWithPlaySessions",
} as const;

export const OFF_MESSAGE = `Roblox analytics are off: set OPENCLOUD_API_KEY (scope ${ANALYTICS_READ_SCOPE}) and TYPETORCH_UNIVERSE_ID`;
const MAX_SOURCES = 32;

interface Entry {
	value: AcquisitionResult;
	expires: number;
}

export class RobloxAnalytics {
	private readonly cache = new Map<string, Entry>();
	private readonly inFlight = new Map<string, Promise<AcquisitionResult & { cached: boolean }>>();
	private readonly limiter: RateLimiter;
	private readonly clock: () => number;

	constructor(private readonly o: RobloxAnalyticsOptions) {
		this.clock = o.clock ?? Date.now;
		this.limiter = new RateLimiter(o.perMinute ?? 12, this.clock);
	}

	get configured(): boolean {
		return Boolean(this.o.apiKey && this.o.universeId);
	}

	/** The last `days` full UTC days against the `days` before, from Roblox. */
	async acquisition(days: number): Promise<AcquisitionResult & { cached: boolean }> {
		if (!(ACQUISITION_DAYS as readonly number[]).includes(days)) throw new RobloxAnalyticsError(`days: one of ${ACQUISITION_DAYS.join(", ")}`, 400);
		if (!this.o.apiKey || !this.o.universeId) throw new RobloxAnalyticsError(OFF_MESSAGE, 409);
		// Today isn't over: the window ends at today's 00:00 UTC.
		const end = Math.floor(this.clock() / DAY_MS) * DAY_MS;
		const key = `${days} ${end}`;
		const hit = this.cache.get(key);
		if (hit && hit.expires > this.clock()) return { ...hit.value, cached: true };
		const pending = this.inFlight.get(key);
		if (pending) return pending;
		const queries = 6;
		for (let i = 0; i < queries; i++) {
			if (!this.limiter.take("roblox")) {
				if (hit) return { ...hit.value, cached: true };
				throw new RobloxAnalyticsError("too many Roblox analytics queries: try again in a minute", 429);
			}
		}
		const lookup = this.load(days, end)
			.then((value) => {
				this.cache.set(key, { value, expires: this.clock() + (this.o.ttlMs ?? 3_600_000) });
				while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string);
				return { ...value, cached: false };
			})
			.catch((error: unknown) => {
				throw toAnalyticsError(error);
			})
			.finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, lookup);
		return lookup;
	}

	private async load(days: number, end: number): Promise<AcquisitionResult> {
		const start = end - 2 * days * DAY_MS;
		const query = (metric: string, breakdown?: string[]) =>
			queryAnalyticsMetric({
				apiKey: this.o.apiKey as string,
				universeId: this.o.universeId as number,
				...(this.o.fetch ? { fetch: this.o.fetch } : {}),
				timeoutMs: this.o.timeoutMs ?? 10_000,
				attempts: 2,
				pollMs: this.o.pollMs ?? 1000,
				query: { metric, granularity: "OneDay", startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), ...(breakdown ? { breakdown } : {}) },
			});
		const [home, qualified, impressions, plays, impressionsBySource, playsBySource] = await Promise.all([
			query(METRICS.playThroughHome),
			query(METRICS.qualifiedPlayThrough),
			query(METRICS.impressions),
			query(METRICS.qualifiedPlays),
			query(METRICS.impressions, ["AcquisitionSource"]),
			query(METRICS.qualifiedPlays, ["AcquisitionSource"]),
		]);
		const homeByDay = rateByDay(home);
		const qualifiedByDay = rateByDay(qualified);
		const impressionsByDay = countByDay(impressions);
		const playsByDay = countByDay(plays);
		const daily: AcquisitionDay[] = [];
		for (let t = start; t < end; t += DAY_MS) {
			const day = new Date(t).toISOString().slice(0, 10);
			daily.push({ day, playThroughHome: homeByDay.get(day) ?? null, qualifiedPlayThrough: qualifiedByDay.get(day) ?? null, impressions: impressionsByDay.get(day) ?? null, qualifiedPlays: playsByDay.get(day) ?? null });
		}
		const period = (from: number, to: number): AcquisitionPeriod => {
			const rows = daily.filter((d) => Date.parse(d.day) >= from && Date.parse(d.day) < to);
			return {
				from: new Date(from).toISOString(),
				to: new Date(to).toISOString(),
				daysWithData: rows.filter((d) => d.playThroughHome !== null || d.qualifiedPlayThrough !== null || d.impressions !== null).length,
				playThroughHome: mean(rows.map((d) => d.playThroughHome)),
				qualifiedPlayThrough: mean(rows.map((d) => d.qualifiedPlayThrough)),
				impressions: sum(rows.map((d) => d.impressions)),
				qualifiedPlays: sum(rows.map((d) => d.qualifiedPlays)),
			};
		};
		const mid = end - days * DAY_MS;
		return {
			days,
			metrics: { ...METRICS },
			current: period(mid, end),
			previous: period(start, mid),
			daily,
			sources: sources(impressionsBySource, playsBySource, mid, end),
			fetchedAt: new Date(this.clock()).toISOString(),
		};
	}
}

const dayOf = (time: string) => new Date(Date.parse(time)).toISOString().slice(0, 10);

/** The series without a breakdown: value per UTC day (a count; non-finite dropped). */
function countByDay(series: AnalyticsSeries[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const s of series) {
		if (s.breakdowns.length) continue;
		for (const p of s.dataPoints) if (p.value !== null && p.value >= 0) out.set(dayOf(p.time), p.value);
	}
	return out;
}

/** A rate per UTC day as a fraction: Roblox doesn't say the scale, so a series with a day above 1 is read as percent. */
function rateByDay(series: AnalyticsSeries[]): Map<string, number> {
	const raw = countByDay(series);
	const percent = [...raw.values()].some((v) => v > 1);
	return new Map([...raw].map(([day, v]) => [day, round(percent ? v / 100 : v, 6)]));
}

function sources(impressions: AnalyticsSeries[], plays: AnalyticsSeries[], from: number, to: number): AcquisitionSource[] {
	const bySource = new Map<string, AcquisitionSource>();
	const add = (series: AnalyticsSeries[], field: "impressions" | "qualifiedPlays") => {
		for (const s of series) {
			const b = s.breakdowns.find((x) => x.dimension === "AcquisitionSource");
			if (!b) continue;
			const row = bySource.get(b.value) ?? { source: b.value.slice(0, 80), label: (b.displayValue ?? b.value).slice(0, 80), impressions: 0, qualifiedPlays: 0, rate: null };
			if (b.displayValue && row.label === row.source) row.label = b.displayValue.slice(0, 80);
			for (const p of s.dataPoints) {
				const t = Date.parse(p.time);
				if (p.value !== null && p.value >= 0 && t >= from && t < to) row[field] += p.value;
			}
			bySource.set(b.value, row);
		}
	};
	add(impressions, "impressions");
	add(plays, "qualifiedPlays");
	return [...bySource.values()]
		.map((r) => ({ ...r, rate: r.impressions > 0 ? round(r.qualifiedPlays / r.impressions, 6) : null }))
		.sort((a, b) => b.impressions - a.impressions || a.source.localeCompare(b.source))
		.slice(0, MAX_SOURCES);
}

function mean(values: (number | null)[]): number | null {
	const xs = values.filter((v): v is number => v !== null);
	return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 6) : null;
}

const sum = (values: (number | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

function toAnalyticsError(error: unknown): RobloxAnalyticsError {
	if (error instanceof RobloxAnalyticsError) return error;
	if (error instanceof OpenCloudError) {
		const status = error.status === 400 ? 400 : error.status === 429 ? 429 : error.status === 504 ? 504 : 502;
		return new RobloxAnalyticsError(error.message, status);
	}
	return new RobloxAnalyticsError(`Roblox analytics failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`, 502);
}
