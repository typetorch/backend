/**
 * The mobile app's game health card (`health` on every GET /v1/mobile/live answer): aggregates from the services behind
 * the explorer's Errors and Fleet pages, never a player.
 *
 *   - `errors1h` / `errorsPrev1h`: the Errors page's count (ErrorStore.list's `totals.count`, no filter) over the last 60
 *     whole minutes, the current minute included, and the 60 before. The error store only keeps errors (no warnings).
 *   - `servers` / `serversOk`: the Fleet page's live servers (FleetService.servers) and those whose Health badge has no
 *     reasons (fleet/health.ts: kernel health not ok, a late heartbeat, low TPS, high memory: the "needs a look" rule).
 *   - `alertsOpen`: fleet alerts (FleetService.alerts, the Fleet page's Alerts table) raised in the last 24 h that are not
 *     acknowledged (the table's Acked column), at most ALERTS_OPEN_MAX counted.
 *   - `alerts`: the newest HEALTH_ALERTS of the last 24 h (acknowledged or not): level, the Message column as the title
 *     (cut to HEALTH_TITLE_MAX characters), when.
 *
 * One computation at a time, kept HEALTH_TTL_MS; a failure keeps the last good value (retried after a minute).
 */
import type { Alert, FleetService } from "../fleet/service.ts";
import type { ErrorStore } from "../errors/store.ts";
import { METRIC_WAIT_MS, MetricsCache } from "./mobile-metrics.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const HEALTH_TTL_MS = MINUTE;
/** Alerts listed, newest first. */
export const HEALTH_ALERTS = 3;
/** An alert's title at most this many characters ("..." at the end when cut). */
export const HEALTH_TITLE_MAX = 80;
/** Open alerts counted at most (FleetService.alerts' page cap). */
export const ALERTS_OPEN_MAX = 1000;

export interface HealthAlert {
	level: Alert["level"];
	title: string;
	at: string;
}

export interface Health {
	errors1h: number;
	errorsPrev1h: number;
	servers: number;
	serversOk: number;
	alertsOpen: number;
	alerts: HealthAlert[];
}

/** The parts of the services it reads. */
export interface HealthSources {
	errors: Pick<ErrorStore, "list">;
	fleet: Pick<FleetService, "servers" | "alerts">;
}

/** A title of at most HEALTH_TITLE_MAX characters. */
export function alertTitle(message: string): string {
	const one = message.replace(/\s+/g, " ").trim();
	return one.length > HEALTH_TITLE_MAX ? `${one.slice(0, HEALTH_TITLE_MAX - 3)}...` : one;
}

/** The two hour windows: the last 60 whole minutes (the current one included) and the 60 before. */
export function hourWindows(now: number): { current: { from: number; to: number }; previous: { from: number; to: number } } {
	const end = Math.ceil((now + 1) / MINUTE) * MINUTE;
	return { current: { from: end - HOUR, to: end }, previous: { from: end - 2 * HOUR, to: end - HOUR } };
}

export async function computeHealth(s: HealthSources, now: number): Promise<Health> {
	const w = hourWindows(now);
	const count = async (win: { from: number; to: number }) => (await s.errors.list({ ...win, bucketSeconds: 3600 }, {}, { limit: 1 })).totals.count;
	const since = now - DAY;
	const [errors1h, errorsPrev1h, live, open, recent] = await Promise.all([
		count(w.current),
		count(w.previous),
		s.fleet.servers(),
		s.fleet.alerts({ since, unacked: true, limit: ALERTS_OPEN_MAX }),
		s.fleet.alerts({ since, limit: HEALTH_ALERTS }),
	]);
	return {
		errors1h,
		errorsPrev1h,
		servers: live.servers.length,
		serversOk: live.servers.filter((x) => (x.reasons ?? []).length === 0).length,
		alertsOpen: open.length,
		alerts: [...recent]
			.sort((a, b) => b.at - a.at || b.id - a.id)
			.slice(0, HEALTH_ALERTS)
			.map((a) => ({ level: a.level, title: alertTitle(a.message), at: a.createdAt })),
	};
}

export class MobileHealth {
	readonly cache: MetricsCache<Health>;

	constructor(
		private readonly o: {
			/** The services, or undefined without the fleet part (`health` is null). */
			sources: () => HealthSources | undefined;
			clock: () => number;
			log?: (line: string) => void;
			waitMs?: number;
		},
	) {
		this.cache = new MetricsCache<Health>(o.clock, o.log, { entries: 1, concurrency: 1 });
	}

	/** The card, or null without the fleet part or before a first good computation. Never throws. */
	async get(): Promise<Health | null> {
		const sources = this.o.sources();
		if (!sources) return null;
		return (await this.cache.get("health", HEALTH_TTL_MS, (now) => computeHealth(sources, now), this.o.waitMs ?? METRIC_WAIT_MS)) ?? null;
	}
}
