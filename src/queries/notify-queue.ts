/**
 * The notification sender's history (plans/29 "Explorer page", the queue section) from the backend's `notify` rows:
 * planned / sent / dry / failed / skipped per hour (with the 429s, Roblox's rate limit), what was planned by kind and
 * why (`asap`, `hour`, `until`), what was skipped by kind and why, and failures by kind, HTTP status and code (how many
 * were final). The live queue (pending intents, the token bucket) comes from `GET /v1/notify/status`, not from here.
 */
import { defineQuery, iso, num, numOrNull, str } from "./core.ts";
import { hourOf, kindCondition, notifyCte, notifyKindOption, propTrue } from "./notify-common.ts";

const HOUR_MS = 3_600_000;
/** Dense hour series up to this many hours (a week); a longer range lists only hours with rows. */
const DENSE_HOURS = 24 * 7;

export interface NotifyQueueOptions {
	kind?: string;
}

export interface NotifyQueueHour {
	/** The hour's start (ISO). */
	hour: string;
	planned: number;
	/** Real sends (not dry runs). */
	sent: number;
	dry: number;
	failed: number;
	/** Failed with HTTP 429. */
	rateLimited: number;
	skipped: number;
}

export interface NotifyQueuePlanned {
	kind: string;
	/** asap | hour | until. */
	why: string;
	planned: number;
}

export interface NotifyQueueSkip {
	kind: string;
	why: string;
	skipped: number;
}

export interface NotifyQueueFailure {
	kind: string;
	/** The HTTP status (null for a network error). */
	http: number | null;
	code: string;
	failures: number;
	/** Of them, how many ended the send (no retry). */
	final: number;
	/** Distinct sends. */
	sends: number;
	lastAt: string | null;
}

export interface NotifyQueueResult {
	from: string;
	to: string;
	kind: string | null;
	totals: { planned: number; sent: number; dry: number; failed: number; final: number; rateLimited: number; skipped: number; last429At: string | null };
	hours: NotifyQueueHour[];
	planned: NotifyQueuePlanned[];
	skipped: NotifyQueueSkip[];
	failures: NotifyQueueFailure[];
}

export const notifyQueue = defineQuery<NotifyQueueOptions, NotifyQueueResult>({
	name: "notify-queue",
	summary: "the notification sender per hour (planned, sent, dry, failed, 429s, skipped), planned and skipped by kind and why, failures by http and code (notify rows)",
	defaultDays: 1,
	options: (input = {}) => {
		const kind = notifyKindOption(input.kind);
		return kind !== undefined ? { kind } : {};
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const lim = d.limit(10_000);
		const w = `WITH ${notifyCte(ctx, f)} `;
		const kc = kindCondition(ctx, o.kind);
		const http = d.jsonNumber("props", "http");
		const byWhy = (name: string) =>
			`${w}SELECT k, why, COUNT(*) AS n FROM (SELECT COALESCE(${d.jsonText("props", "k")}, '') AS k, COALESCE(${d.jsonText("props", "why")}, '') AS why FROM n ` +
			`WHERE name = '${name}'${kc}) x GROUP BY k, why ORDER BY n DESC, k, why ${d.limit(500)}`;
		return {
			hours:
				`${w}SELECT hr, SUM(CASE WHEN name = 'planned' THEN 1 ELSE 0 END) AS planned, SUM(CASE WHEN name = 'sent' AND dry = 0 THEN 1 ELSE 0 END) AS sent, ` +
				`SUM(CASE WHEN name = 'sent' AND dry = 1 THEN 1 ELSE 0 END) AS dry, SUM(CASE WHEN name = 'failed' THEN 1 ELSE 0 END) AS failed, ` +
				`SUM(CASE WHEN name = 'failed' AND http = 429 THEN 1 ELSE 0 END) AS rl, SUM(CASE WHEN name = 'skipped' THEN 1 ELSE 0 END) AS skipped FROM (` +
				`SELECT ${hourOf("t")} AS hr, name, CASE WHEN ${propTrue("props", "dry")} THEN 1 ELSE 0 END AS dry, ${http} AS http FROM n ` +
				`WHERE name IN ('planned', 'sent', 'failed', 'skipped')${kc}) x GROUP BY hr ORDER BY hr ${lim}`,
			planned: byWhy("planned"),
			skipped: byWhy("skipped"),
			failures:
				`${w}SELECT k, http, code, COUNT(*) AS n, SUM(fin) AS fin, COUNT(DISTINCT nid) AS sends, MAX(t) AS last FROM (` +
				`SELECT COALESCE(${d.jsonText("props", "k")}, '') AS k, ${http} AS http, COALESCE(${d.jsonText("props", "code")}, '') AS code, ` +
				`CASE WHEN ${propTrue("props", "final")} THEN 1 ELSE 0 END AS fin, ${d.jsonText("props", "nid")} AS nid, t FROM n WHERE name = 'failed'${kc}) x ` +
				`GROUP BY k, http, code ORDER BY n DESC, k, code ${d.limit(500)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const found = new Map(rows.hours.map((r) => [num(r.hr), r]));
		const first = Math.floor(f.from / HOUR_MS);
		const last = Math.floor((f.to - 1) / HOUR_MS);
		const hourNumbers = last - first < DENSE_HOURS ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [...found.keys()].sort((a, b) => a - b);
		const hours: NotifyQueueHour[] = hourNumbers.map((h) => {
			const r = found.get(h);
			return {
				hour: iso(h * HOUR_MS),
				planned: num(r?.planned),
				sent: num(r?.sent),
				dry: num(r?.dry),
				failed: num(r?.failed),
				rateLimited: num(r?.rl),
				skipped: num(r?.skipped),
			};
		});
		const sum = (key: keyof Omit<NotifyQueueHour, "hour">) => rows.hours.reduce((s, r) => s + num(r[key === "rateLimited" ? "rl" : key]), 0);
		const failures: NotifyQueueFailure[] = rows.failures.map((r) => {
			const http = numOrNull(r.http);
			const lastAt = numOrNull(r.last);
			return {
				kind: str(r.k),
				http: http === null ? null : Math.round(http),
				code: str(r.code).slice(0, 64),
				failures: num(r.n),
				final: num(r.fin),
				sends: num(r.sends),
				lastAt: lastAt === null ? null : iso(lastAt),
			};
		});
		const last429 = failures.filter((x) => x.http === 429 && x.lastAt).map((x) => x.lastAt as string).sort().pop() ?? null;
		return {
			from: iso(f.from),
			to: iso(f.to),
			kind: o.kind ?? null,
			totals: {
				planned: sum("planned"),
				sent: sum("sent"),
				dry: sum("dry"),
				failed: sum("failed"),
				final: failures.reduce((s, x) => s + x.final, 0),
				rateLimited: sum("rateLimited"),
				skipped: sum("skipped"),
				last429At: last429,
			},
			hours,
			planned: rows.planned.map((r) => ({ kind: str(r.k), why: str(r.why).slice(0, 32), planned: num(r.n) })),
			skipped: rows.skipped.map((r) => ({ kind: str(r.k), why: str(r.why).slice(0, 32), skipped: num(r.n) })),
			failures,
		};
	},
});
