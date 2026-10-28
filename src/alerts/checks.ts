/**
 * The backend alert rules as pure functions: data in (samples, counts, the clock), a verdict out. The evaluator
 * (evaluator.ts) gathers the data and raises what fires; the tests feed made-up data and a fixed `now`.
 *
 * A verdict is "ok" (watched, nothing wrong), "waiting" (not enough data yet, e.g. right after a start, or too little
 * traffic to judge) or "firing" with one finding per subject. A finding's `key` names the subject (an error kind, a
 * silence that began at a given time; "" for the whole fleet): the same rule and key is raised once per repeat window.
 */

export interface Finding {
	key: string;
	message: string;
	details: Record<string, string | number | boolean | null>;
	branch?: string | null;
	artifact?: string | null;
	seq?: number | null;
}

export type Verdict = { state: "ok" | "waiting"; note: string } | { state: "firing"; note: string; findings: Finding[] };

const MINUTE = 60_000;
const ok = (note: string): Verdict => ({ state: "ok", note });
const waiting = (note: string): Verdict => ({ state: "waiting", note });
const firing = (note: string, findings: Finding[]): Verdict => ({ state: "firing", note, findings });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Error templates and names go into webhooks: one line, short. */
export const shortText = (text: string, max = 120): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

// Errors ------------------------------------------------------------------------------------------------------------------

export interface KindWindow {
	fp: string;
	template: string;
	/** Occurrences in the last `minutes`. */
	recent: number;
	/** Occurrences in the `baselineHours` before that. */
	baseline: number;
}

export function checkErrorSpike(kinds: readonly KindWindow[], q: { minutes: number; factor: number; minCount: number; baselineHours: number }): Verdict {
	const windows = Math.max(1, (q.baselineHours * 60) / q.minutes);
	const findings: Finding[] = [];
	for (const k of kinds) {
		if (k.recent < q.minCount) continue;
		const usual = k.baseline / windows;
		// A kind that was quiet before counts as one occurrence per window, so minCount alone decides then.
		if (k.recent < q.factor * Math.max(usual, 1)) continue;
		const usualText = usual < 1 ? "almost none before" : `${Math.round(usual)} usually (${(k.recent / usual).toFixed(1)}x)`;
		findings.push({
			key: k.fp,
			message: `error spike: ${k.recent} in ${q.minutes} min vs ${usualText}: ${shortText(k.template)}`,
			details: { fp: k.fp, recent: k.recent, usualPerWindow: Math.round(usual * 10) / 10, minutes: q.minutes, baselineHours: q.baselineHours },
		});
	}
	if (findings.length) return firing(plural(findings.length, "kind") + " spiking", findings);
	return kinds.length ? ok(`top kind ${Math.max(...kinds.map((k) => k.recent))} in ${q.minutes} min`) : ok(`no kind at ${q.minCount}+ in ${q.minutes} min`);
}

export interface DeployInfo {
	seq: number;
	branch: string | null;
	artifact: string | null;
	/** When the deploy arrived (unix ms). */
	at: number;
}

export interface NewKind {
	fp: string;
	template: string;
	firstAt: number;
	total: number;
}

/** Kinds first seen within `minutes` after the latest deploy; `kinds` may hold others (they are filtered here). */
export function checkNewErrorKinds(deploy: DeployInfo | null, kinds: readonly NewKind[], now: number, q: { minutes: number; minCount: number }): Verdict {
	if (!deploy) return waiting("no deploy recorded yet");
	const until = deploy.at + q.minutes * MINUTE;
	const fresh = kinds.filter((k) => k.firstAt >= deploy.at && k.firstAt <= until);
	const loud = fresh.filter((k) => k.total >= q.minCount);
	if (!loud.length) return ok(`seq ${deploy.seq}: ${plural(fresh.length, "new kind")}${now <= until ? "" : " (window over)"}`);
	return firing(
		`seq ${deploy.seq}: ${plural(loud.length, "new kind")}`,
		loud.map((k) => ({
			key: `${deploy.seq}:${k.fp}`,
			message: `new error after deploy seq ${deploy.seq} (${k.total} so far, first seen ${Math.max(0, Math.round((k.firstAt - deploy.at) / MINUTE))} min after it): ${shortText(k.template)}`,
			details: { fp: k.fp, total: k.total, firstAt: new Date(k.firstAt).toISOString(), deployAt: new Date(deploy.at).toISOString() },
			branch: deploy.branch,
			artifact: deploy.artifact,
			seq: deploy.seq,
		})),
	);
}

// Players and ingest ------------------------------------------------------------------------------------------------------

/** One evaluator sample: the fleet as heartbeats tell it and the ingest counter. */
export interface Sample {
	t: number;
	/** Open servers heard from in the last 90 s, and their players. */
	servers: number;
	players: number;
	/** Rows ingest accepted since the process started (a counter). */
	rowsIn: number;
}

/** The samples in [from, to], oldest first. */
const between = (samples: readonly Sample[], from: number, to: number) => samples.filter((s) => s.t >= from && s.t <= to);
/** Whether the samples reach back to `from` (one tick of slack). */
const covers = (samples: readonly Sample[], from: number, tickMs: number) => samples.length > 0 && samples[0].t <= from + tickMs;

export function checkCcuDrop(samples: readonly Sample[], now: number, q: { percent: number; minutes: number; minPlayers: number }, tickMs: number): Verdict {
	const last = samples[samples.length - 1];
	const from = now - q.minutes * MINUTE;
	if (!last || !covers(samples, from, tickMs)) return waiting(`collecting ${q.minutes} min of samples`);
	const window = between(samples, from, now);
	const peak = Math.max(...window.map((s) => s.players));
	if (peak < q.minPlayers) return waiting(`peak ${peak} players, below ${q.minPlayers}`);
	const drop = ((peak - last.players) / peak) * 100;
	if (drop < q.percent || last.servers === 0) return ok(`${last.players} players online (peak ${peak} in ${q.minutes} min)`);
	return firing(`down ${Math.round(drop)}%`, [
		{
			key: "",
			message: `players online fell ${Math.round(drop)}% in ${q.minutes} min (${peak} to ${last.players}) while ${plural(last.servers, "server")} still send heartbeats`,
			details: { peak, now: last.players, servers: last.servers, dropPercent: Math.round(drop), minutes: q.minutes },
		},
	]);
}

/**
 * The fleet went quiet: no heartbeat for `minutes`, and (when analytics run) no ingest either, after at least
 * `minPlayers` were online in the hour before. `lastHeartbeat` is the newest last_seen of any server (null = none ever);
 * `lastIngest` is when the ingest counter last moved (undefined = analytics off, not part of the rule).
 */
export function checkFleetSilent(samples: readonly Sample[], lastHeartbeat: number | null, lastIngest: number | null | undefined, now: number, q: { minutes: number; minPlayers: number }): Verdict {
	if (lastHeartbeat === null) return waiting("no heartbeat ever");
	const quiet = now - lastHeartbeat;
	if (quiet < q.minutes * MINUTE) return ok(`last heartbeat ${Math.round(quiet / 1000)} s ago`);
	if (lastIngest !== undefined && lastIngest !== null && now - lastIngest < q.minutes * MINUTE) return ok("heartbeats stopped, ingest still arrives");
	const before = between(samples, lastHeartbeat - 60 * MINUTE, lastHeartbeat);
	const peak = before.length ? Math.max(...before.map((s) => s.players)) : 0;
	if (peak < q.minPlayers) return waiting(before.length ? `quiet, but only ${peak} players before` : "quiet since before this server started");
	return firing(`silent ${Math.round(quiet / MINUTE)} min`, [
		{
			key: String(lastHeartbeat),
			message: `the fleet is silent: no heartbeat${lastIngest === undefined ? "" : " and no analytics ingest"} for ${Math.round(quiet / MINUTE)} min, after ${peak} players online in the hour before`,
			details: { lastHeartbeat: new Date(lastHeartbeat).toISOString(), silentMinutes: Math.round(quiet / MINUTE), peakBefore: peak },
		},
	]);
}

/** Minutes of traffic before the quiet window that "steady" looks at, and the share of them that need rows. */
export const INGEST_BASELINE_MINUTES = 30;
const STEADY_SHARE = 0.75;

export function checkIngestStopped(samples: readonly Sample[], now: number, q: { minutes: number; minRowsPerMinute: number }, tickMs: number): Verdict {
	const quietFrom = now - q.minutes * MINUTE;
	const baseFrom = quietFrom - INGEST_BASELINE_MINUTES * MINUTE;
	if (!covers(samples, baseFrom, tickMs)) return waiting(`collecting ${q.minutes + INGEST_BASELINE_MINUTES} min of samples`);
	const last = samples[samples.length - 1] as Sample;
	const atQuietFrom = [...samples].reverse().find((s) => s.t <= quietFrom) as Sample;
	const quietRows = last.rowsIn - atQuietFrom.rowsIn;
	if (quietRows > 0) return ok(`${Math.round(quietRows / q.minutes)} rows / min`);
	const base = between(samples, baseFrom - tickMs, quietFrom);
	const steps = base.slice(1).map((s, i) => s.rowsIn - (base[i] as Sample).rowsIn);
	const rows = (atQuietFrom.rowsIn - (base[0] as Sample).rowsIn) / INGEST_BASELINE_MINUTES;
	const steady = steps.length > 0 && steps.filter((d) => d > 0).length >= steps.length * STEADY_SHARE;
	if (!steady || rows < q.minRowsPerMinute) return waiting(`no rows; ${Math.round(rows)} rows / min before`);
	if (last.players === 0) return ok("no rows, and no players online");
	return firing(`no rows for ${q.minutes} min`, [
		{
			key: String(atQuietFrom.t),
			message: `analytics ingest stopped: no rows for ${q.minutes} min after ${Math.round(rows)} rows / min, while ${last.players} players are online`,
			details: { minutes: q.minutes, rowsPerMinuteBefore: Math.round(rows), players: last.players },
		},
	]);
}

// The backend's own health --------------------------------------------------------------------------------------------------

/** One whole minute of the backend's metrics (src/server/metrics.ts). */
export interface MinuteStat {
	at: number;
	requests: number;
	errors5xx: number;
	/** Request latency p99 of the minute (ms); null without timed requests. */
	p99: number | null;
	rssMb: number | null;
	loopLagMs: number | null;
}

/** The last `minutes` whole minutes before `now`; null when one is missing (the server is younger, or was stalled). */
function lastMinutes(stats: readonly MinuteStat[], now: number, minutes: number): MinuteStat[] | null {
	const end = Math.floor(now / MINUTE) * MINUTE;
	const out: MinuteStat[] = [];
	for (let at = end - minutes * MINUTE; at < end; at += MINUTE) {
		const m = stats.find((s) => s.at === at);
		if (!m) return null;
		out.push(m);
	}
	return out;
}

export function checkLatency(stats: readonly MinuteStat[], now: number, q: { p99Ms: number; minutes: number; minRequests: number }): Verdict {
	const span = lastMinutes(stats, now, q.minutes);
	if (!span) return waiting(`collecting ${q.minutes} min`);
	const worst = Math.max(...span.map((m) => m.p99 ?? 0));
	const slow = span.every((m) => m.requests >= q.minRequests && (m.p99 ?? 0) > q.p99Ms);
	if (!slow) return ok(`p99 ${worst} ms at most`);
	const best = Math.min(...span.map((m) => m.p99 ?? 0));
	return firing(`p99 over ${q.p99Ms} ms`, [
		{ key: "", message: `requests are slow: p99 above ${q.p99Ms} ms for ${q.minutes} min (${best} to ${worst} ms)`, details: { p99MinMs: best, p99MaxMs: worst, minutes: q.minutes } },
	]);
}

export function checkMemory(stats: readonly MinuteStat[], now: number, q: { rssMb: number; minutes: number }): Verdict {
	const span = lastMinutes(stats, now, q.minutes);
	if (!span || span.some((m) => m.rssMb === null)) return waiting(`collecting ${q.minutes} min`);
	const rss = (span[span.length - 1] as MinuteStat).rssMb as number;
	if (!span.every((m) => (m.rssMb as number) > q.rssMb)) return ok(`RSS ${Math.round(rss)} MB`);
	return firing(`RSS ${Math.round(rss)} MB`, [{ key: "", message: `backend memory: RSS above ${q.rssMb} MB for ${q.minutes} min (${Math.round(rss)} MB now)`, details: { rssMb: Math.round(rss), minutes: q.minutes } }]);
}

export function checkLoopLag(stats: readonly MinuteStat[], now: number, q: { lagMs: number; minutes: number }): Verdict {
	const span = lastMinutes(stats, now, q.minutes);
	if (!span || span.some((m) => m.loopLagMs === null)) return waiting(`collecting ${q.minutes} min`);
	const lags = span.map((m) => m.loopLagMs as number);
	if (!lags.every((l) => l > q.lagMs)) return ok(`lag ${Math.round(Math.max(...lags))} ms at most`);
	return firing(`lag over ${q.lagMs} ms`, [
		{ key: "", message: `event loop lag above ${q.lagMs} ms in every minute for ${q.minutes} min (up to ${Math.round(Math.max(...lags))} ms)`, details: { lagMaxMs: Math.round(Math.max(...lags)), minutes: q.minutes } },
	]);
}

export function check5xx(stats: readonly MinuteStat[], now: number, q: { percent: number; minutes: number; minRequests: number }): Verdict {
	const span = lastMinutes(stats, now, q.minutes) ?? [];
	const requests = span.reduce((n, m) => n + m.requests, 0);
	const failed = span.reduce((n, m) => n + m.errors5xx, 0);
	if (requests < q.minRequests) return waiting(`${requests} requests in ${q.minutes} min, below ${q.minRequests}`);
	const share = (failed / requests) * 100;
	if (share < q.percent) return ok(`${share.toFixed(1)}% 5xx`);
	return firing(`${share.toFixed(1)}% 5xx`, [
		{ key: "", message: `${share.toFixed(1)}% of requests answered 5xx in the last ${q.minutes} min (${failed} of ${requests})`, details: { failed, requests, percent: Math.round(share * 10) / 10, minutes: q.minutes } },
	]);
}

// Disk ----------------------------------------------------------------------------------------------------------------------

export interface DiskNow {
	freeBytes: number;
	totalBytes: number;
}

const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

export function checkDiskLow(disk: DiskNow | null, q: { percent: number; gb: number }): Verdict {
	if (!disk || disk.totalBytes <= 0) return waiting("disk stats not available here");
	const pct = (disk.freeBytes / disk.totalBytes) * 100;
	const low = (q.percent > 0 && pct < q.percent) || (q.gb > 0 && disk.freeBytes < q.gb * GB);
	const note = `${gb(disk.freeBytes)} free (${pct.toFixed(1)}%)`;
	if (!low) return ok(note);
	return firing(note, [{ key: "", message: `disk space low on the data folder's disk: ${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)} (${pct.toFixed(1)}%)`, details: { freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, freePercent: Math.round(pct * 10) / 10 } }]);
}

/** One hourly disk sample (kept in SQLite, so restarts keep the history). */
export interface DiskSample {
	t: number;
	usedBytes: number;
	freeBytes: number;
}

/** How far back the growth looks, and the least history it needs. */
export const GROWTH_LOOKBACK_DAYS = 7;
const GROWTH_MIN_SPAN_MS = 86_400_000;

export function checkDiskGrowth(samples: readonly DiskSample[], disk: DiskNow | null, now: number, q: { days: number }): Verdict {
	if (!disk) return waiting("disk stats not available here");
	const recent = samples.filter((s) => s.t >= now - GROWTH_LOOKBACK_DAYS * 86_400_000 && s.t <= now);
	const first = recent[0];
	if (!first || now - first.t < GROWTH_MIN_SPAN_MS) return waiting("collecting a day of disk samples");
	const used = disk.totalBytes - disk.freeBytes;
	const perDay = ((used - first.usedBytes) / (now - first.t)) * 86_400_000;
	if (perDay <= 0) return ok("not growing");
	const daysLeft = disk.freeBytes / perDay;
	const left = daysLeft < 1 ? "less than a day" : plural(Math.floor(daysLeft), "day");
	const note = `+${gb(perDay)} / day, full in ${left}`;
	if (daysLeft >= q.days) return ok(note);
	return firing(note, [
		{
			key: "",
			message: `the data folder's disk fills up in about ${left} (+${gb(perDay)} a day over the last ${plural(Math.round((now - first.t) / 86_400_000), "day")},${gb(disk.freeBytes)} free)`,
			details: { perDayBytes: Math.round(perDay), daysLeft: Math.round(daysLeft * 10) / 10, freeBytes: disk.freeBytes },
		},
	]);
}
