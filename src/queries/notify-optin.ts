/**
 * The notification opt-in prompt (plans/29 "Explorer page"), from the framework's `optin_check` {can, where, err},
 * `optin_shown` {where} and `optin_closed` {where, secs} rows and the backend's `optin_inferred` {state}: checks ->
 * shown -> closed, plus the answers the backend inferred from its sends (OptInPromptClosed has no argument, so whether a
 * player said yes comes only from Roblox's answer to a send: `subscribed` / `not_subscribed`). Totals, by `where` (the
 * game's name for the spot that showed the prompt) and per UTC day. Counts are rows (distinct: resent copies count once).
 * Per spot, the answer is attributed by player: each player counts at the spot of their last `optin_shown` in the range,
 * with their latest inferred answer in the range (an answer can come from a prompt before the range: an estimate).
 */
import { dayOf, defineQuery, iso, isoDay, num, ratio, round, str } from "./core.ts";
import { notifyCte, propTrue } from "./notify-common.ts";

export interface NotifyOptinCounts {
	/** `optin_check` rows (CanPromptOptInAsync asked). */
	checks: number;
	/** Checks that said the prompt can be shown. */
	canPrompt: number;
	/** Checks that failed (an `err`). */
	errors: number;
	shown: number;
	closed: number;
	/** shown / checks. */
	shownRate: number;
	/** How long the prompt was up on average (seconds), or null without a closed row with `secs`. */
	avgShownSecs: number | null;
}

export interface NotifyOptinWhere extends NotifyOptinCounts {
	/** The game's name for the spot ("" when the row had none). */
	where: string;
	/** Players whose last prompt in the range was shown here. */
	shownPlayers: number;
	/** Of those, the ones whose latest inferred answer in the range is subscribed / not subscribed. */
	subscribed: number;
	notSubscribed: number;
	/** subscribed / shownPlayers. */
	subscribedRate: number;
}

export interface NotifyOptinDay extends NotifyOptinCounts {
	date: string;
	subscribed: number;
	notSubscribed: number;
}

export interface NotifyOptinResult {
	from: string;
	to: string;
	totals: NotifyOptinCounts & { subscribed: number; notSubscribed: number };
	/** By `where`, most checks first. */
	byWhere: NotifyOptinWhere[];
	days: NotifyOptinDay[];
}

interface Acc {
	checks: number;
	canPrompt: number;
	errors: number;
	shown: number;
	closed: number;
	secs: number;
	secsRows: number;
	subscribed: number;
	notSubscribed: number;
}

const acc = (): Acc => ({ checks: 0, canPrompt: 0, errors: 0, shown: 0, closed: 0, secs: 0, secsRows: 0, subscribed: 0, notSubscribed: 0 });

function counts(a: Acc): NotifyOptinCounts {
	return {
		checks: a.checks,
		canPrompt: a.canPrompt,
		errors: a.errors,
		shown: a.shown,
		closed: a.closed,
		shownRate: ratio(a.shown, a.checks),
		avgShownSecs: a.secsRows ? round(a.secs / a.secsRows, 1) : null,
	};
}

export const notifyOptin = defineQuery<Record<string, never>, NotifyOptinResult>({
	name: "notify-optin",
	summary: "the notification opt-in prompt: checks, shown, closed, inferred subscribed / not subscribed, by where and per day (notify rows)",
	defaultDays: 30,
	options: () => ({}),
	statements(ctx, f) {
		const d = ctx.dialect;
		return {
			groups:
				`WITH ${notifyCte(ctx, f)} SELECT day, name, wh, st, can, err, COUNT(*) AS n, SUM(secs) AS secs, COUNT(secs) AS secs_n FROM (` +
				`SELECT ${dayOf("t")} AS day, name, COALESCE(${d.jsonText("props", "where")}, '') AS wh, COALESCE(${d.jsonText("props", "state")}, '') AS st, ` +
				`CASE WHEN ${propTrue("props", "can")} THEN 1 ELSE 0 END AS can, CASE WHEN COALESCE(${d.jsonText("props", "err")}, '') <> '' THEN 1 ELSE 0 END AS err, ` +
				`${d.jsonNumber("props", "secs")} AS secs FROM n WHERE name IN ('optin_check', 'optin_shown', 'optin_closed', 'optin_inferred')) x ` +
				`GROUP BY day, name, wh, st, can, err ORDER BY day, name, wh, st, can, err ${d.limit(10_000)}`,
			spots:
				`WITH ${notifyCte(ctx, f)}, ` +
				`sh AS (SELECT pid, wh FROM (SELECT pid, COALESCE(${d.jsonText("props", "where")}, '') AS wh, ROW_NUMBER() OVER (PARTITION BY pid ORDER BY t DESC) AS rn FROM n WHERE name = 'optin_shown' AND pid <> '') a WHERE rn = 1), ` +
				`inf AS (SELECT pid, st FROM (SELECT pid, COALESCE(${d.jsonText("props", "state")}, '') AS st, ROW_NUMBER() OVER (PARTITION BY pid ORDER BY t DESC) AS rn FROM n WHERE name = 'optin_inferred' AND pid <> '') b WHERE rn = 1) ` +
				`SELECT sh.wh AS wh, COUNT(*) AS players, SUM(CASE WHEN inf.st = 'subscribed' THEN 1 ELSE 0 END) AS sub, SUM(CASE WHEN inf.st = 'not_subscribed' THEN 1 ELSE 0 END) AS nsub ` +
				`FROM sh LEFT JOIN inf ON inf.pid = sh.pid GROUP BY sh.wh ORDER BY sh.wh ${d.limit(1000)}`,
		};
	},
	shape(rows, _ctx, f) {
		const total = acc();
		const byWhere = new Map<string, Acc>();
		const byDay = new Map<number, Acc>();
		for (const r of rows.groups) {
			const name = str(r.name);
			const n = num(r.n);
			const where = str(r.wh).slice(0, 64);
			const day = num(r.day);
			const targets: Acc[] = [total];
			if (!byDay.has(day)) byDay.set(day, acc());
			targets.push(byDay.get(day) as Acc);
			if (name !== "optin_inferred") {
				if (!byWhere.has(where)) byWhere.set(where, acc());
				targets.push(byWhere.get(where) as Acc);
			}
			for (const a of targets) {
				if (name === "optin_check") {
					a.checks += n;
					if (num(r.can)) a.canPrompt += n;
					if (num(r.err)) a.errors += n;
				} else if (name === "optin_shown") a.shown += n;
				else if (name === "optin_closed") {
					a.closed += n;
					a.secs += num(r.secs);
					a.secsRows += num(r.secs_n);
				} else if (str(r.st) === "subscribed") a.subscribed += n;
				else if (str(r.st) === "not_subscribed") a.notSubscribed += n;
			}
		}
		const spots = new Map<string, { players: number; sub: number; nsub: number }>();
		for (const r of rows.spots ?? []) spots.set(str(r.wh).slice(0, 64), { players: num(r.players), sub: num(r.sub), nsub: num(r.nsub) });
		for (const where of spots.keys()) if (!byWhere.has(where)) byWhere.set(where, acc());
		return {
			from: iso(f.from),
			to: iso(f.to),
			totals: { ...counts(total), subscribed: total.subscribed, notSubscribed: total.notSubscribed },
			byWhere: [...byWhere.entries()]
				.map(([where, a]) => {
					const sp = spots.get(where);
					return { where, ...counts(a), shownPlayers: sp?.players ?? 0, subscribed: sp?.sub ?? 0, notSubscribed: sp?.nsub ?? 0, subscribedRate: ratio(sp?.sub ?? 0, sp?.players ?? 0) };
				})
				.sort((a, b) => b.checks - a.checks || b.shown - a.shown || (a.where < b.where ? -1 : a.where > b.where ? 1 : 0)),
			days: [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, a]) => ({ date: isoDay(day), ...counts(a), subscribed: a.subscribed, notSubscribed: a.notSubscribed })),
		};
	},
});
