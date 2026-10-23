/**
 * Game servers from `kind = "fleet"` rows (they replaced the MemoryStore heartbeat and deploy reports):
 *   servers      — the latest heartbeat per JobId that is recent enough;
 *   deployReport — how a deploy went: results per server, errors grouped, and servers still below its seq.
 * Every field is read out of `props` one by one in SQL, so `k` (a private server's access code) never leaves the
 * database.
 *
 * How fresh "recent" can be depends on the backend: the DuckDB server has rows a few seconds after a game server
 * posts them (loader tick). Basin makes rows queryable only after its sink writes a file: the roll interval (60 s
 * minimum for Iceberg tables, 300 s default; the setup guide uses 60 s) plus the commit, so expect 1-2 minutes with
 * a 60 s roll (not measured live yet). Hence the defaults: 150 s on DuckDB, 360 s on Basin.
 */
import { DEPLOY_RESULTS, FLEET_DEPLOY_REPORT, FLEET_HEARTBEAT } from "../schema.ts";
import { lit, type Dialect } from "../sql/dialect.ts";
import { whereSql } from "../sql/filters.ts";
import { defineQuery, eventsTable, int, intOption, iso, num, numOrNull, round, str, strOrNull, type QueryContext } from "./core.ts";

export const SERVERS_MAX_AGE_DEFAULT = { duckdb: 150, basin: 360 } as const;

/**
 * Heartbeat fields returned (props key -> column), the kernel's fleet status (kernel src/server/Kernel.server.luau
 * fleetStatus): t = server type, s and u = unix seconds, x = 1 during an A/B pin, sv = 2. `k` is deliberately missing.
 */
const HEARTBEAT_TEXT = { t: "server_type", b: "branch", c: "channel", a: "artifact", v: "kernel", h: "health", e: "last_error" } as const;
const HEARTBEAT_NUM = { n: "players", m: "max_players", s: "started_at", u: "last_write", p: "place_id", q: "applied_seq", g: "generation", x: "experiment", sv: "server_version" } as const;

function heartbeatColumns(d: Dialect): string {
	return [
		...Object.entries(HEARTBEAT_TEXT).map(([key, col]) => `${d.jsonText("e.props", key)} AS ${col}`),
		...Object.entries(HEARTBEAT_NUM).map(([key, col]) => `${d.jsonNumber("e.props", key)} AS ${col}`),
	].join(", ");
}

/** Latest heartbeat per JobId newer than maxAge; `extra` adds conditions on the heartbeat columns (alias hb). */
function latestHeartbeats(ctx: QueryContext, maxAgeSeconds: number, branch: string | undefined, f: Parameters<typeof whereSql>[0], extra = ""): string {
	const since = ctx.now - maxAgeSeconds * 1000;
	const table = ctx.table("events", since, ctx.now + 60_000);
	const branchCond = branch ? ` AND hb.branch = ${lit(branch)}` : "";
	return (
		`WITH h AS (SELECT e.job AS job, e.t AS t, ${heartbeatColumns(ctx.dialect)}, ROW_NUMBER() OVER (PARTITION BY e.job ORDER BY e.t DESC) AS rn ` +
		`FROM ${table} e WHERE e.kind = 'fleet' AND e.name = ${lit(FLEET_HEARTBEAT)} AND e.t >= ${int(since)} AND ${whereSql(f, ctx.dialect, { prefix: "e.", noTime: true })}) ` +
		`SELECT hb.job AS job, hb.t AS t, ${[...Object.values(HEARTBEAT_TEXT), ...Object.values(HEARTBEAT_NUM)].map((c) => `hb.${c} AS ${c}`).join(", ")} ` +
		`FROM h hb WHERE hb.rn = 1${branchCond}${extra} ORDER BY hb.t DESC, hb.job ${ctx.dialect.limit(10_000)}`
	);
}

export type { HealthReason } from "../fleet/health.ts";
import type { HealthReason } from "../fleet/health.ts";

export interface ServerInfo {
	job: string;
	/** public | private | reserved | studio (the heartbeat's `t`). */
	serverType: string | null;
	lastSeen: string;
	ageSeconds: number;
	branch: string | null;
	channel: string | null;
	artifact: string | null;
	players: number | null;
	maxPlayers: number | null;
	startedAt: string | null;
	lastWrite: string | null;
	placeId: number | null;
	/** The place version the server runs (heartbeat `pv`, game.PlaceVersion); Fleet API only, null from older kernels. */
	placeVersion?: number | null;
	/** Running an A/B experiment pin (`x = 1`). */
	experiment: boolean;
	kernel: string | null;
	appliedSeq: number | null;
	generation: number | null;
	health: string | null;
	lastError: string | null;
	/** The status format version (`sv`, 2 since kernel 0.3.2). */
	serverVersion: number | null;
	/**
	 * Kernel 0.4.0 (problem 25): the heartbeat's budget summary `bu` (requests per minute next to Roblox's limits; see
	 * parseBudget in fleet/service.ts). Fleet API only; null when the server sent none.
	 */
	budget?: Record<string, unknown> | null;
	/**
	 * Kernel 0.4.2 (fleet API only; null when the server sent none, e.g. an older kernel): server TPS averaged over the
	 * last heartbeat interval and its slowest second, physics FPS (heartbeat `pf`), total memory and Lua heap in MB (the
	 * budget summary's `bu.mem`).
	 */
	tps?: number | null;
	tpsMin?: number | null;
	physFps?: number | null;
	memMb?: number | null;
	luaMb?: number | null;
	/**
	 * Fleet API only: why the server needs a look (fleet/health.ts), each signal with its reading and the line it
	 * crossed; empty when nothing tripped.
	 */
	reasons?: HealthReason[];
}

/** Unix seconds or ms -> ms (the kernel sends seconds). */
export function toMs(value: number | null): number | null {
	if (value === null) return null;
	return value < 1e11 ? value * 1000 : value;
}

function serverInfo(r: Record<string, unknown>, now: number): ServerInfo {
	const t = num(r.t);
	const ms = (v: unknown) => {
		const n = toMs(numOrNull(v));
		return n === null ? null : iso(n);
	};
	return {
		job: str(r.job),
		serverType: strOrNull(r.server_type),
		lastSeen: iso(t),
		ageSeconds: Math.max(0, round((now - t) / 1000, 0)),
		branch: strOrNull(r.branch),
		channel: strOrNull(r.channel),
		artifact: strOrNull(r.artifact),
		players: numOrNull(r.players),
		maxPlayers: numOrNull(r.max_players),
		startedAt: ms(r.started_at),
		lastWrite: ms(r.last_write),
		placeId: numOrNull(r.place_id),
		experiment: num(r.experiment) === 1,
		kernel: strOrNull(r.kernel),
		appliedSeq: numOrNull(r.applied_seq),
		generation: numOrNull(r.generation),
		health: strOrNull(r.health),
		lastError: strOrNull(r.last_error),
		serverVersion: numOrNull(r.server_version),
	};
}

// servers ---------------------------------------------------------------------------------------------------------------

export interface ServersOptions {
	branch?: string;
	/** Heartbeats older than this are gone servers. Default 150 s (DuckDB) / 360 s (Basin). */
	maxAgeSeconds?: number;
}

export interface ServersResult {
	maxAgeSeconds: number;
	servers: ServerInfo[];
	players: number;
	byArtifact: { artifact: string; servers: number; players: number }[];
	byHealth: Record<string, number>;
}

export const servers = defineQuery<ServersOptions, ServersResult>({
	name: "servers",
	summary: "live game servers: the latest heartbeat per JobId (branch, artifact, players, health, applied seq)",
	defaultDays: 1,
	options: (input = {}) => {
		const out: ServersOptions = {};
		if (input.branch) out.branch = String(input.branch).slice(0, 64);
		if (input.maxAgeSeconds !== undefined) out.maxAgeSeconds = intOption(input.maxAgeSeconds, "maxAgeSeconds", 150, 10, 86_400);
		return out;
	},
	statements(ctx, f, o) {
		const maxAge = o.maxAgeSeconds ?? SERVERS_MAX_AGE_DEFAULT[ctx.dialect.name];
		return { servers: latestHeartbeats(ctx, maxAge, o.branch, f) };
	},
	shape(rows, ctx, _f, o) {
		const list = rows.servers.map((r) => serverInfo(r, ctx.now));
		const art = new Map<string, { servers: number; players: number }>();
		const byHealth: Record<string, number> = {};
		for (const s of list) {
			const a = art.get(s.artifact ?? "(unknown)") ?? { servers: 0, players: 0 };
			a.servers++;
			a.players += s.players ?? 0;
			art.set(s.artifact ?? "(unknown)", a);
			byHealth[s.health ?? "(unknown)"] = (byHealth[s.health ?? "(unknown)"] ?? 0) + 1;
		}
		return {
			maxAgeSeconds: o.maxAgeSeconds ?? SERVERS_MAX_AGE_DEFAULT[ctx.dialect.name],
			servers: list,
			players: list.reduce((sum, s) => sum + (s.players ?? 0), 0),
			byArtifact: [...art].map(([artifact, v]) => ({ artifact, ...v })).sort((a, b) => b.servers - a.servers),
			byHealth,
		};
	},
});

// deployReport ----------------------------------------------------------------------------------------------------------

export interface DeployReportOptions {
	/** The deploy's seq. */
	seq?: number;
	/** Or: the newest deploy of this artifact. */
	artifact?: string;
	/** Or (default): the newest deploy that has reports. */
	latest?: boolean;
	branch?: string;
	/** For "servers still below the seq": heartbeats newer than this count. */
	maxAgeSeconds?: number;
}

export interface DeployReportResult {
	seq: number | null;
	branch: string | null;
	artifact: string | null;
	firstReport: string | null;
	lastReport: string | null;
	/** Servers that reported (latest report per server). */
	reported: number;
	/** Per result: servers, players on them, median and slowest seconds. */
	results: { result: string; servers: number; players: number; medianSeconds: number | null; maxSeconds: number | null }[];
	errors: { error: string; servers: number; exampleJob: string }[];
	/** Live servers (on the branch) whose latest heartbeat's applied seq is still below the deploy's. */
	behind: ServerInfo[];
}

function reportCtes(ctx: QueryContext, f: Parameters<typeof whereSql>[0], o: DeployReportOptions): string {
	const d = ctx.dialect;
	const p = (key: string) => d.jsonText("e.props", key);
	const n = (key: string) => d.jsonNumber("e.props", key);
	const branch = o.branch ? ` AND (${p("b")} = ${lit(o.branch)})` : "";
	const mode = o.seq !== undefined ? `s = ${int(o.seq)}` : o.artifact ? `a = ${lit(o.artifact)}` : "s IS NOT NULL";
	return (
		`rep AS (SELECT e.job AS job, e.t AS t, CAST(${n("s")} AS BIGINT) AS s, ${p("b")} AS b, ${p("a")} AS a, COALESCE(${p("j")}, e.job) AS j, ` +
		`${p("r")} AS r, ${p("e")} AS err, ${n("d")} AS d, ${n("p")} AS p FROM ${eventsTable(ctx, f)} e ` +
		`WHERE e.kind = 'fleet' AND e.name = ${lit(FLEET_DEPLOY_REPORT)} AND ${whereSql(f, d, { prefix: "e." })}${branch}), ` +
		`tgt AS (SELECT MAX(s) AS seq FROM rep WHERE ${mode}), ` +
		`cur AS (SELECT rep.job AS job, rep.t AS t, rep.s AS s, rep.b AS b, rep.a AS a, rep.j AS j, rep.r AS r, rep.err AS err, rep.d AS d, rep.p AS p FROM rep JOIN tgt ON rep.s = tgt.seq), ` +
		`lat AS (SELECT j, r, err, d, p FROM (SELECT j, r, err, d, p, ROW_NUMBER() OVER (PARTITION BY j ORDER BY t DESC) AS rn FROM cur) z WHERE rn = 1)`
	);
}

export const deployReport = defineQuery<DeployReportOptions, DeployReportResult>({
	name: "deployReport",
	summary: "how a deploy went: results per server, errors grouped, servers still below its seq (by seq, artifact or latest)",
	defaultDays: 2,
	options: (input = {}) => {
		const out: DeployReportOptions = {};
		const modes = [input.seq !== undefined, !!input.artifact, !!input.latest].filter(Boolean).length;
		if (modes > 1) throw new Error("give one of seq, artifact or latest");
		if (input.seq !== undefined) out.seq = intOption(input.seq, "seq", 0, 0, Number.MAX_SAFE_INTEGER);
		if (input.artifact) out.artifact = String(input.artifact).slice(0, 64);
		if (modes === 0 || input.latest) out.latest = true;
		if (input.branch) out.branch = String(input.branch).slice(0, 64);
		if (input.maxAgeSeconds !== undefined) out.maxAgeSeconds = intOption(input.maxAgeSeconds, "maxAgeSeconds", 150, 10, 86_400);
		return out;
	},
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const ctes = reportCtes(ctx, f, o);
		return {
			target: `WITH ${ctes} SELECT tgt.seq AS seq, MIN(cur.b) AS branch, MIN(cur.a) AS artifact, MIN(cur.t) AS first_t, MAX(cur.t) AS last_t, COUNT(DISTINCT cur.j) AS reported FROM tgt LEFT JOIN cur ON cur.s = tgt.seq GROUP BY tgt.seq ${lim(1)}`,
			results: `WITH ${ctes} SELECT r, COUNT(*) AS servers, SUM(COALESCE(p, 0)) AS players, MEDIAN(d) AS median_d, MAX(d) AS max_d FROM lat GROUP BY r ORDER BY servers DESC, r ${lim(100)}`,
			errors: `WITH ${ctes} SELECT err, COUNT(*) AS servers, MIN(j) AS example_job FROM lat WHERE err IS NOT NULL AND err <> '' GROUP BY err ORDER BY servers DESC, err ${lim(50)}`,
		};
	},
	shape(rows) {
		const t = rows.target[0] ?? {};
		const order = (r: string) => {
			const i = (DEPLOY_RESULTS as readonly string[]).indexOf(r);
			return i < 0 ? 99 : i;
		};
		return {
			seq: numOrNull(t.seq),
			branch: strOrNull(t.branch),
			artifact: strOrNull(t.artifact),
			firstReport: numOrNull(t.first_t) === null ? null : iso(num(t.first_t)),
			lastReport: numOrNull(t.last_t) === null ? null : iso(num(t.last_t)),
			reported: num(t.reported),
			results: rows.results
				.map((r) => ({
					result: str(r.r) || "(none)",
					servers: num(r.servers),
					players: num(r.players),
					medianSeconds: numOrNull(r.median_d) === null ? null : round(num(r.median_d), 1),
					maxSeconds: numOrNull(r.max_d) === null ? null : round(num(r.max_d), 1),
				}))
				.sort((a, b) => order(a.result) - order(b.result)),
			errors: rows.errors.map((r) => ({ error: str(r.err), servers: num(r.servers), exampleJob: str(r.example_job) })),
			behind: [],
		};
	},
	async finish(result, ctx, f, o, run) {
		const seq = result.seq ?? o.seq ?? null;
		const branch = o.branch ?? result.branch ?? undefined;
		if (seq === null) return result;
		const maxAge = o.maxAgeSeconds ?? SERVERS_MAX_AGE_DEFAULT[ctx.dialect.name];
		const rows = await run({ behind: latestHeartbeats(ctx, maxAge, branch, { from: f.from, to: f.to }, ` AND (hb.applied_seq IS NULL OR hb.applied_seq < ${int(seq)})`) });
		return { ...result, seq, branch: result.branch ?? branch ?? null, behind: rows.behind.map((r) => serverInfo(r, ctx.now)) };
	},
});
