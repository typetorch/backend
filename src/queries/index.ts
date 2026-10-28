/** Every logical query, by name, and the code that renders and runs them for any backend. */
import { normalizeFilters, type Filters, type NormalizedFilters } from "../sql/filters.ts";
import { benchmarks, realtime, trends } from "./benchmarks.ts";
import { confusion } from "./confusion.ts";
import { economy } from "./economy.ts";
import type { QueryContext, QueryDef, Rows, RunStatements } from "./core.ts";
import { experiment, experimentPlayers } from "./experiment.ts";
import { events, players, values } from "./explore.ts";
import { deployReport, servers } from "./fleet.ts";
import { funnel, funnelPlayers, funnelProgress, playtimeFunnel, timeline } from "./funnel.ts";
import { flow, playerGraph } from "./graph.ts";
import { monetization } from "./monetization.ts";
import { overview, retention, roblox, topEvents } from "./overview.ts";
import { playerStats } from "./player.ts";
import { perfClient, perfCompare, perfServer } from "./perf.ts";

export const QUERIES = {
	overview,
	roblox,
	retention,
	funnel,
	"funnel-progress": funnelProgress,
	"playtime-funnel": playtimeFunnel,
	"funnel-players": funnelPlayers,
	timeline,
	"player-graph": playerGraph,
	"player-stats": playerStats,
	flow,
	experiment,
	"experiment-players": experimentPlayers,
	confusion,
	"top-events": topEvents,
	servers,
	deployReport,
	players,
	values,
	events,
	benchmarks,
	realtime,
	trends,
	"perf-client": perfClient,
	"perf-server": perfServer,
	"perf-compare": perfCompare,
	economy,
	monetization,
} as const;

export type QueryName = keyof typeof QUERIES;
type Def<N extends QueryName> = (typeof QUERIES)[N];
export type QueryOptions<N extends QueryName> = Def<N> extends QueryDef<infer O, unknown> ? Partial<O> : never;
export type QueryResult<N extends QueryName> = Def<N> extends QueryDef<object, infer R> ? R : never;

export const QUERY_NAMES = Object.keys(QUERIES) as QueryName[];

export function isQueryName(name: string): name is QueryName {
	return Object.hasOwn(QUERIES, name);
}

function def(name: string): QueryDef<object, unknown> {
	if (!isQueryName(name)) throw new UnknownQueryError(name);
	return QUERIES[name] as unknown as QueryDef<object, unknown>;
}

export class UnknownQueryError extends Error {
	override name = "UnknownQueryError";
	constructor(readonly query: string) {
		super(`unknown query ${JSON.stringify(query)}; known: ${QUERY_NAMES.join(", ")}`);
	}
}

export interface Rendered {
	name: QueryName;
	filters: NormalizedFilters;
	statements: Record<string, string>;
}

/** The SQL a query would run (for `--sql` / review), without running it. */
export function renderQuery(ctx: QueryContext, name: string, filters?: Filters, options?: object): Rendered {
	const q = def(name);
	const f = normalizeFilters(filters, { now: ctx.now, defaultDays: q.defaultDays });
	const o = q.options(options as never);
	return { name: name as QueryName, filters: f, statements: q.statements(ctx, f, o) };
}

/** Renders, runs and shapes a query. `run` executes statements on the backend. */
export async function runQuery(ctx: QueryContext, run: RunStatements, name: string, filters?: Filters, options?: object): Promise<unknown> {
	const q = def(name);
	const f = normalizeFilters(filters, { now: ctx.now, defaultDays: q.defaultDays });
	const o = q.options(options as never);
	const rows: Rows = await run(q.statements(ctx, f, o));
	let result = q.shape(rows, ctx, f, o);
	if (q.finish) result = await q.finish(result, ctx, f, o, run);
	return result;
}

/** One line per query, for help texts and the server's index. */
export function describeQueries(): { name: QueryName; summary: string; defaultDays: number }[] {
	return QUERY_NAMES.map((name) => ({ name, summary: QUERIES[name].summary, defaultDays: QUERIES[name].defaultDays }));
}
