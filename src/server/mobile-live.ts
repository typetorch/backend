/**
 * The mobile app's live numbers (GET /v1/mobile/live, the CCU milestone push): players online now and their history,
 * and the last hour's sessions. Aggregates only: no player id or name ever goes in or out of here.
 *
 * CCU history: the alert evaluator samples the fleet once a minute (evaluator.ts `onSample`, the same count as GET
 * /v1/fleet/servers); `CcuHistory` keeps one point a minute for 24 hours in memory (1440 points at most). A restart
 * loses it, so the first read after a start also takes the fleet's 5-minute metrics rollups since 00:00 UTC (or the
 * last 6 hours, whichever is longer) as coarse points before the first sample: each server's most players in the bucket,
 * summed, so it can read a little high, and only kernels that send metrics (0.4.2+) count.
 *
 * The last hour: one session-time query (src/queries/session-time.ts, the Session time page's sessions) over the
 * last 60 minutes, cached LAST_HOUR_TTL_MS; one computation at a time, the last good answer is kept when one fails.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Per-minute points kept. */
export const CCU_KEEP_MS = DAY;
export const LAST_HOUR_TTL_MS = 5 * MINUTE;
/** After a failed computation, the next try waits this long (the stale answer is served meanwhile). */
const LAST_HOUR_RETRY_MS = MINUTE;
/** `minutes` of the series: 1 to 360, default 30. */
export const SERIES_MAX_MINUTES = 360;
export const SERIES_DEFAULT_MINUTES = 30;
/** "About 5 minutes ago": the point closest to it within this much either way. */
const DELTA_SLACK_MS = 3 * MINUTE;

export interface CcuPoint {
	/** The minute's start (or the rollup bucket's start), unix ms. */
	t: number;
	ccu: number;
}

/** Players online history: one point a minute (newest wins within a minute), the coarse backfill before it. */
export class CcuHistory {
	private readonly points: CcuPoint[] = [];
	private coarse: CcuPoint[] = [];
	private backfilled = false;

	/** One sample (unix ms, players). Kept per minute; points older than CCU_KEEP_MS go. */
	record(t: number, ccu: number): void {
		const minute = Math.floor(t / MINUTE) * MINUTE;
		const last = this.points[this.points.length - 1];
		if (last && last.t === minute) last.ccu = ccu;
		else if (!last || minute > last.t) this.points.push({ t: minute, ccu });
		while (this.points.length && (this.points[0] as CcuPoint).t < t - CCU_KEEP_MS) this.points.shift();
		while (this.coarse.length && (this.coarse[0] as CcuPoint).t < t - CCU_KEEP_MS) this.coarse.shift();
	}

	/** Whether the backfill was taken (it is taken once per process). */
	get hasBackfill(): boolean {
		return this.backfilled;
	}

	/** The rollup points from before this process: only those before the first per-minute point are kept. */
	backfill(points: readonly CcuPoint[]): void {
		this.backfilled = true;
		const first = this.points[0]?.t ?? Number.POSITIVE_INFINITY;
		this.coarse = points.filter((p) => p.t + 5 * MINUTE <= first).slice(-300);
	}

	/** Every point, oldest first. */
	private all(): CcuPoint[] {
		return this.coarse.length ? [...this.coarse, ...this.points] : this.points;
	}

	/** The points of the last `minutes`, oldest first. */
	series(now: number, minutes: number): CcuPoint[] {
		const from = now - minutes * MINUTE;
		return this.all()
			.filter((p) => p.t >= from && p.t <= now)
			.map((p) => ({ t: p.t, ccu: p.ccu }));
	}

	/** The point closest to `t` within `slack`, or null. */
	at(t: number, slack = DELTA_SLACK_MS): number | null {
		let best: CcuPoint | undefined;
		for (const p of this.all()) if (Math.abs(p.t - t) <= slack && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
		return best ? best.ccu : null;
	}

	/** The highest point since `from`, or null with none. */
	peakSince(from: number): number | null {
		let peak: number | null = null;
		for (const p of this.all()) if (p.t >= from && (peak === null || p.ccu > peak)) peak = p.ccu;
		return peak;
	}

	get size(): number {
		return this.points.length + this.coarse.length;
	}
}

/** 00:00 UTC of the day `now` is in. */
export const utcMidnight = (now: number): number => Math.floor(now / DAY) * DAY;

/** The `minutes` query parameter: 1..360, default 30; undefined when it isn't a whole number in range. */
export function seriesMinutes(raw: string | null): number | undefined {
	if (raw === null || raw === "") return SERIES_DEFAULT_MINUTES;
	if (!/^\d{1,3}$/.test(raw)) return undefined;
	const n = Number(raw);
	return n >= 1 && n <= SERIES_MAX_MINUTES ? n : undefined;
}

/** The last hour's sessions as the app shows them. */
export interface LastHour {
	at: string;
	avgSessionSeconds: number | null;
	medianSessionSeconds: number | null;
	sessionsEnded: number;
	playtimeHours: number;
}

/** The session-time summary fields this reads (src/queries/session-time.ts SessionTimeSummary). */
export interface SessionSummaryLike {
	sessions: number;
	avgMinutes: number | null;
	medianMinutes: number | null;
	playedMinutes: number;
}

export function lastHourOf(summary: SessionSummaryLike, at: number): LastHour {
	return {
		at: new Date(at).toISOString(),
		avgSessionSeconds: summary.avgMinutes === null ? null : Math.round(summary.avgMinutes * 60),
		medianSessionSeconds: summary.medianMinutes === null ? null : Math.round(summary.medianMinutes * 60),
		sessionsEnded: summary.sessions,
		playtimeHours: Math.round((summary.playedMinutes / 60) * 10) / 10,
	};
}

/** The last hour's numbers, computed at most once per LAST_HOUR_TTL_MS, one computation at a time. */
export class LastHourCache {
	private value: LastHour | undefined;
	private computedAt = Number.NEGATIVE_INFINITY;
	private triedAt = Number.NEGATIVE_INFINITY;
	private running: Promise<LastHour | undefined> | undefined;

	constructor(
		/** Computes the numbers for the hour before `now`; undefined when analytics aren't running. */
		private readonly compute: (now: number) => Promise<LastHour | undefined>,
		private readonly clock: () => number,
		private readonly log: (line: string) => void = () => {},
	) {}

	/** The cached numbers when fresh, else a new computation (or, while one fails, the last good ones). Never throws. */
	async get(): Promise<LastHour | null> {
		const now = this.clock();
		if (this.value && now - this.computedAt < LAST_HOUR_TTL_MS) return this.value;
		if (now - this.triedAt < LAST_HOUR_RETRY_MS && !this.running) return this.value ?? null;
		this.running ??= this.refresh(now).finally(() => (this.running = undefined));
		return (await this.running) ?? null;
	}

	/** The cached numbers without computing (the push body: never waits on a query). */
	peek(): LastHour | null {
		return this.value && this.clock() - this.computedAt < 2 * HOUR ? this.value : null;
	}

	private async refresh(now: number): Promise<LastHour | undefined> {
		this.triedAt = now;
		try {
			const value = await this.compute(now);
			if (!value) {
				this.value = undefined;
				return undefined;
			}
			this.value = value;
			this.computedAt = now;
			return value;
		} catch (error) {
			this.log(`mobile live: the last hour's sessions failed (${(error as Error).message.slice(0, 160)})`);
			return this.value;
		}
	}
}

/** How long the game's icon URL is kept. */
export const ICON_TTL_MS = 6 * HOUR;
/** After a failed lookup, the next waits this long (the last good URL is served meanwhile). */
export const ICON_RETRY_MS = 10 * MINUTE;

/**
 * The game's icon (`game.iconUrl`): one Roblox thumbnails lookup per ICON_TTL_MS, one at a time. A failed lookup keeps
 * the last good URL of the same universe (null with none). The first read waits up to `waitMs` for it.
 */
export class IconCache {
	private value: { universeId: number; url: string; at: number } | undefined;
	private tried: { universeId: number; at: number } | undefined;
	private running: Promise<void> | undefined;

	constructor(
		private readonly lookup: (universeId: number) => Promise<string | null>,
		private readonly clock: () => number,
		private readonly log: (line: string) => void = () => {},
	) {}

	async get(universeId: number | null, waitMs = 2000): Promise<string | null> {
		if (universeId === null) return null;
		const now = this.clock();
		const known = this.value?.universeId === universeId ? this.value : undefined;
		if (known && now - known.at < ICON_TTL_MS) return known.url;
		const recentlyTried = this.tried?.universeId === universeId && now - this.tried.at < ICON_RETRY_MS;
		if (!this.running && !recentlyTried) {
			this.tried = { universeId, at: now };
			this.running = this.refresh(universeId, now).finally(() => (this.running = undefined));
		}
		if (!known && this.running) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([this.running, new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
			clearTimeout(timer);
		}
		return this.value?.universeId === universeId ? this.value.url : null;
	}

	private async refresh(universeId: number, now: number): Promise<void> {
		try {
			const url = await this.lookup(universeId);
			if (url) this.value = { universeId, url, at: now };
		} catch (error) {
			this.log(`mobile live: the game's icon lookup failed (${(error as Error).message.slice(0, 120)})`);
		}
	}
}

/** "18 m 40 s", "2 h 5 m", "45 s". */
export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
	return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
}

/** "1,240 h" (whole hours from 10 up), "2.5 h" below. */
export function formatHours(hours: number): string {
	if (hours >= 10) return `${Math.round(hours).toLocaleString("en-US")} h`;
	return `${Math.round(hours * 10) / 10} h`;
}

/** The milestone push's body: "The Prison · last hour: 18 m 40 s avg session · 1,240 h played". */
export function milestoneBody(game: string, lastHour: LastHour | null, ccu: number): string {
	if (!lastHour) return `${game} · ${ccu.toLocaleString("en-US")} playing`;
	const parts = [lastHour.avgSessionSeconds !== null ? `${formatDuration(lastHour.avgSessionSeconds)} avg session` : null, `${formatHours(lastHour.playtimeHours)} played`].filter((p): p is string => p !== null);
	return `${game} · last hour: ${parts.join(" · ")}`;
}
