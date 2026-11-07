/**
 * One player's notification rows (plans/29, the per-player view behind GET /v1/notify/user): the opt-in prompt as the
 * framework logged it (`optin_check` {can, where, err}, `optin_shown` {where}, `optin_closed` {where, secs, err}), the
 * consent the backend inferred (`optin_inferred` {state}), and the taps (`open` {nid, k, age, first}, `open_bad` {why},
 * `played` {nid, k, secs}). Newest first, at most `limit` (500). `pids` (1-20) are the player's pids (from
 * `identities`); none = no rows. Only the time range filters apply (default: the last 400 days).
 *
 * `opens` (plans/30): the player's join rows (`session` / `join`) that came from a notification tap (their props carry
 * the send's `nid`), with the raw join data `jd` the framework stores on them, newest first (at most 200), so the view
 * can show what Roblox handed the opening session next to the send.
 */
import { assertSafeKey } from "../sql/dialect.ts";
import { defineQuery, eventsTable, int, intOption, iso, lit, num, str } from "./core.ts";
import { notifyCte } from "./notify-common.ts";

export interface NotifyPlayerOptions {
	pids: string[];
	limit: number;
}

export interface NotifyPlayerRow {
	at: string;
	t: number;
	name: string;
	pid: string;
	where: string | null;
	secs: number | null;
	err: string | null;
	/** optin_check: the prompt could be shown ("true" / "false" as logged), else null. */
	can: string | null;
	/** optin_inferred: subscribed | not_subscribed. */
	state: string | null;
	nid: string | null;
	kind: string | null;
	why: string | null;
	age: number | null;
}

export interface NotifyPlayerOpen {
	/** The send's id, from the join row's props. */
	nid: string;
	at: string;
	t: number;
	sid: string;
	/** The join row's `jd` (plans/30), or null when the framework stored none (`joinData: "summary"` / older games). */
	jd: Record<string, unknown> | null;
}

export interface NotifyPlayerResult {
	from: string;
	to: string;
	rows: NotifyPlayerRow[];
	more: boolean;
	opens: NotifyPlayerOpen[];
}

/** How many notification-opened join rows the view reads. */
const OPENS_MAX = 200;

const NAMES = ["optin_check", "optin_shown", "optin_closed", "optin_inferred", "open", "open_bad", "played"];
const PID = /^[A-Za-z0-9_-]{1,64}$/;

export const notifyPlayer = defineQuery<NotifyPlayerOptions, NotifyPlayerResult>({
	name: "notify-player",
	summary: "one player's notification rows: opt-in prompt checks / shown / closed, inferred consent, opens and plays (notify rows; option pids)",
	defaultDays: 400,
	options: (input = {}) => {
		const pids = input.pids ?? [];
		if (!Array.isArray(pids) || pids.length > 20 || pids.some((p) => typeof p !== "string" || !PID.test(p))) throw new Error("pids is a list of at most 20 pids");
		return { pids: [...new Set(pids)], limit: intOption(input.limit, "limit", 500, 1, 2000) };
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const who = o.pids.length ? `pid IN (${o.pids.map(lit).join(", ")})` : "1 = 0";
		const text = (k: string) => d.jsonText("props", assertSafeKey(k, "key"));
		return {
			rows:
				`WITH ${notifyCte(ctx, f)} SELECT t, name, pid, ${text("where")} AS w, ${text("secs")} AS secs, ${text("err")} AS err, ${text("can")} AS can, ${text("state")} AS state, ` +
				`${text("nid")} AS nid, ${text("k")} AS k, ${text("why")} AS why, ${text("age")} AS age, props FROM n WHERE ${who} AND name IN (${NAMES.map(lit).join(", ")}) ORDER BY t DESC, name ${d.limit(o.limit + 1)}`,
			opens:
				`SELECT DISTINCT e.t AS t, e.sid AS sid, ${d.jsonText("e.props", "nid")} AS nid, e.props AS props FROM ${eventsTable(ctx, f)} e ` +
				`WHERE e.t >= ${int(f.from)} AND e.t < ${int(f.to)} AND e.kind = 'session' AND e.name = 'join' AND ${o.pids.length ? `e.pid IN (${o.pids.map(lit).join(", ")})` : "1 = 0"} ` +
				`AND e.props LIKE '%"nid":%' ORDER BY t DESC ${d.limit(OPENS_MAX)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const list = rows.rows ?? [];
		const orNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : str(v));
		const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : num(v));
		// Booleans (can) don't read the same on every engine: from the props text.
		const canOf = (props: unknown) => {
			const p = str(props);
			return /"can":(true|"true")/.test(p) ? "true" : /"can":(false|"false")/.test(p) ? "false" : null;
		};
		return {
			from: iso(f.from),
			to: iso(f.to),
			rows: list.slice(0, o.limit).map((r) => ({
				at: iso(num(r.t)),
				t: num(r.t),
				name: str(r.name),
				pid: str(r.pid),
				where: orNull(r.w),
				secs: numOrNull(r.secs),
				err: orNull(r.err),
				can: r.name === "optin_check" ? canOf(r.props) : null,
				state: orNull(r.state),
				nid: orNull(r.nid),
				kind: orNull(r.k),
				why: orNull(r.why),
				age: numOrNull(r.age),
			})),
			more: list.length > o.limit,
			opens: (rows.opens ?? [])
				.map((r) => {
					let props: Record<string, unknown> = {};
					try {
						const parsed = JSON.parse(str(r.props)) as unknown;
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) props = parsed as Record<string, unknown>;
					} catch {}
					const jd = props.jd && typeof props.jd === "object" && !Array.isArray(props.jd) ? (props.jd as Record<string, unknown>) : null;
					return { nid: orNull(r.nid) ?? (typeof props.nid === "string" ? props.nid : ""), at: iso(num(r.t)), t: num(r.t), sid: str(r.sid), jd };
				})
				.filter((x) => x.nid !== ""),
		};
	},
});
