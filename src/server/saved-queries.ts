/**
 * Saved queries for the explorer's Query page: a name, one read-only SQL statement, an optional chart type and whether it
 * is pinned to the Overview as a tile. One table in the backend's SQLite file:
 * `saved_queries (id, name, sql, chart, pinned, created_by, created_at, updated_by, updated_at)`.
 *
 * Saving never runs anything: the SQL is checked with the sandbox's text layer (one SELECT / WITH, no denied words) and
 * kept as text. Running it is `POST /v1/sql` like any ad-hoc query, so every layer of the sandbox applies on each run and
 * the read-only web role runs a saved query exactly as it runs its own SQL.
 *
 *   GET    /v1/saved-queries          (admin, web)  { queries: [...] }, by name
 *   GET    /v1/saved-queries/<id>     (admin, web)  one query
 *   POST   /v1/saved-queries          (admin)       { name, sql, chart?, pinned? } -> 201 { query }
 *   PATCH  /v1/saved-queries/<id>     (admin)       any of { name, sql, chart, pinned } -> { query }
 *   DELETE /v1/saved-queries/<id>     (admin)       { ok: true }
 *
 * Bounded: at most SAVED_QUERIES_MAX queries, PINNED_MAX of them pinned, names of NAME_MAX characters (unique, ignoring
 * case), the SQL as long as the sandbox takes (32 KB), bodies of BODY_MAX bytes; writes are rate limited per address.
 */
import type { FleetDb, SyncTx } from "../fleet/db.ts";
import { json, readCapped } from "./http.ts";
import { checkSqlText, SqlInputError } from "./sql.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_queries (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sql TEXT NOT NULL, chart TEXT, pinned INTEGER NOT NULL DEFAULT 0,
	created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS saved_queries_name ON saved_queries (name COLLATE NOCASE);
`;

/** How a saved query's rows are shown: a table, or a small chart (first column = x, the number columns = series). */
export const SAVED_QUERY_CHARTS = ["table", "bar", "line"] as const;
export type SavedQueryChart = (typeof SAVED_QUERY_CHARTS)[number];
export const SAVED_QUERIES_MAX = 200;
export const PINNED_MAX = 12;
export const NAME_MAX = 100;
export const BODY_MAX = 64 * 1024;
/** Creates, edits and deletes per address per minute. */
export const WRITES_PER_MINUTE = 60;

const CONTROL = /[\u0000-\u001f\u007f]/;
const FIELDS = new Set(["name", "sql", "chart", "pinned"]);

export class SavedQueryError extends Error {
	override name = "SavedQueryError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface SavedQuery {
	id: number;
	name: string;
	sql: string;
	/** null: the Query page's table, no chart picked. */
	chart: SavedQueryChart | null;
	pinned: boolean;
	createdBy: string;
	createdAt: string;
	updatedBy: string;
	updatedAt: string;
}

export interface SavedQueryInput {
	name?: string;
	sql?: string;
	chart?: SavedQueryChart | null;
	pinned?: boolean;
}

interface Row {
	id: number;
	name: string;
	sql: string;
	chart: string | null;
	pinned: number;
	created_by: string;
	created_at: number;
	updated_by: string;
	updated_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function rowOf(r: Row): SavedQuery {
	return {
		id: Number(r.id),
		name: r.name,
		sql: r.sql,
		chart: (SAVED_QUERY_CHARTS as readonly string[]).includes(r.chart ?? "") ? (r.chart as SavedQueryChart) : null,
		pinned: Number(r.pinned) === 1,
		createdBy: r.created_by,
		createdAt: iso(Number(r.created_at)),
		updatedBy: r.updated_by,
		updatedAt: iso(Number(r.updated_at)),
	};
}

/**
 * Checks a create (`full`: name and sql required) or an edit body. Unknown keys, wrong types, a name with control
 * characters or over NAME_MAX, SQL the sandbox's text layer refuses: 400.
 */
export function parseSavedQuery(body: unknown, full: boolean): SavedQueryInput {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SavedQueryError(400, "the body is a JSON object");
	const raw = body as Record<string, unknown>;
	const unknown = Object.keys(raw).filter((k) => !FIELDS.has(k));
	if (unknown.length) throw new SavedQueryError(400, `unknown field: ${unknown.slice(0, 3).join(", ")}`);
	const out: SavedQueryInput = {};
	if (raw.name !== undefined || full) {
		if (typeof raw.name !== "string") throw new SavedQueryError(400, "name is a string");
		const name = raw.name.trim();
		if (!name || name.length > NAME_MAX) throw new SavedQueryError(400, `name is 1 to ${NAME_MAX} characters`);
		if (CONTROL.test(name)) throw new SavedQueryError(400, "name has control characters");
		out.name = name;
	}
	if (raw.sql !== undefined || full) {
		try {
			out.sql = checkSqlText(raw.sql);
		} catch (error) {
			throw new SavedQueryError(400, error instanceof SqlInputError ? error.message : "sql is not a query");
		}
	}
	if (raw.chart !== undefined) {
		if (raw.chart !== null && !(SAVED_QUERY_CHARTS as readonly unknown[]).includes(raw.chart)) throw new SavedQueryError(400, `chart is null or one of ${SAVED_QUERY_CHARTS.join(", ")}`);
		out.chart = raw.chart as SavedQueryChart | null;
	}
	if (raw.pinned !== undefined) {
		if (typeof raw.pinned !== "boolean") throw new SavedQueryError(400, "pinned is true or false");
		out.pinned = raw.pinned;
	}
	if (!full && !Object.keys(out).length) throw new SavedQueryError(400, "nothing to change");
	return out;
}

export class SavedQueryStore {
	private constructor(
		private readonly db: FleetDb,
		private readonly clock: () => number,
	) {}

	static async open(db: FleetDb, clock: () => number = Date.now): Promise<SavedQueryStore> {
		await db.exec(SCHEMA);
		return new SavedQueryStore(db, clock);
	}

	/** Every saved query, by name (at most SAVED_QUERIES_MAX exist). */
	async list(): Promise<SavedQuery[]> {
		return (await this.db.all<Row>("SELECT * FROM saved_queries ORDER BY name COLLATE NOCASE, id")).map(rowOf);
	}

	async get(id: number): Promise<SavedQuery | undefined> {
		const row = await this.db.first<Row>("SELECT * FROM saved_queries WHERE id = ?", [id]);
		return row ? rowOf(row) : undefined;
	}

	/** Adds one (the count, pin and name checks and the insert in one transaction). */
	async create(input: SavedQueryInput, who: string): Promise<SavedQuery> {
		const now = this.clock();
		const id = await this.db.transaction((tx) => {
			const n = Number(tx.first<{ n: number }>("SELECT COUNT(*) AS n FROM saved_queries")?.n ?? 0);
			if (n >= SAVED_QUERIES_MAX) throw new SavedQueryError(409, `at most ${SAVED_QUERIES_MAX} saved queries: delete one first`);
			if (input.pinned) this.checkPins(tx, undefined);
			this.checkName(tx, input.name as string, undefined);
			return tx.run("INSERT INTO saved_queries (name, sql, chart, pinned, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
				input.name as string,
				input.sql as string,
				input.chart ?? null,
				input.pinned ? 1 : 0,
				who,
				now,
				who,
				now,
			]).lastId;
		});
		return (await this.get(id)) as SavedQuery;
	}

	/** Changes the fields given; undefined when there is no such query. */
	async update(id: number, patch: SavedQueryInput, who: string): Promise<SavedQuery | undefined> {
		const now = this.clock();
		const found = await this.db.transaction((tx) => {
			const row = tx.first<Row>("SELECT * FROM saved_queries WHERE id = ?", [id]);
			if (!row) return false;
			if (patch.pinned && Number(row.pinned) !== 1) this.checkPins(tx, id);
			if (patch.name !== undefined) this.checkName(tx, patch.name, id);
			const sets = ["updated_by = ?", "updated_at = ?"];
			const params: (string | number | null)[] = [who, now];
			if (patch.name !== undefined) (sets.push("name = ?"), params.push(patch.name));
			if (patch.sql !== undefined) (sets.push("sql = ?"), params.push(patch.sql));
			if (patch.chart !== undefined) (sets.push("chart = ?"), params.push(patch.chart));
			if (patch.pinned !== undefined) (sets.push("pinned = ?"), params.push(patch.pinned ? 1 : 0));
			tx.run(`UPDATE saved_queries SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
			return true;
		});
		return found ? this.get(id) : undefined;
	}

	async remove(id: number): Promise<boolean> {
		return (await this.db.run("DELETE FROM saved_queries WHERE id = ?", [id])).changes > 0;
	}

	private checkPins(tx: SyncTx, except: number | undefined): void {
		const pinned = Number(tx.first<{ n: number }>("SELECT COUNT(*) AS n FROM saved_queries WHERE pinned = 1 AND id <> ?", [except ?? -1])?.n ?? 0);
		if (pinned >= PINNED_MAX) throw new SavedQueryError(409, `at most ${PINNED_MAX} queries pinned to the Overview: unpin one first`);
	}

	private checkName(tx: SyncTx, name: string, except: number | undefined): void {
		if (tx.first("SELECT id FROM saved_queries WHERE name = ? COLLATE NOCASE AND id <> ?", [name, except ?? -1])) throw new SavedQueryError(409, "a saved query with that name exists");
	}
}

export interface SavedQueryRouteContext {
	store: SavedQueryStore;
	/** For a write: the admin's name for the record (never a token), or the refusal (403 for the web role). */
	writer(): string | Response;
	/** False when the caller is over WRITES_PER_MINUTE. */
	allowWrite(): boolean;
}

function idOf(text: string): number | undefined {
	return /^[1-9]\d{0,9}$/.test(text) ? Number(text) : undefined;
}

/** The saved-query routes (the caller has passed the read gate: every signed-in role reads). */
export async function handleSavedQueries(req: Request, path: string, ctx: SavedQueryRouteContext): Promise<Response> {
	const method = req.method;
	const rest = path.slice("/v1/saved-queries".length);
	try {
		if (rest === "") {
			if (method === "GET") return json(200, { queries: await ctx.store.list() });
			if (method !== "POST") return json(405, { error: "GET or POST only" });
			const who = ctx.writer();
			if (who instanceof Response) return who;
			if (!ctx.allowWrite()) return json(429, { error: "too many saved-query changes: wait a minute" }, { "retry-after": "60" });
			const input = parseSavedQuery(await readBody(req), true);
			return json(201, { query: await ctx.store.create(input, who) });
		}
		const id = idOf(rest.slice(1));
		if (!rest.startsWith("/") || id === undefined) return json(404, { error: "no such saved query" });
		if (method === "GET") {
			const found = await ctx.store.get(id);
			return found ? json(200, { query: found }) : json(404, { error: "no such saved query" });
		}
		if (method !== "PATCH" && method !== "DELETE") return json(405, { error: "GET, PATCH or DELETE only" });
		const who = ctx.writer();
		if (who instanceof Response) return who;
		if (!ctx.allowWrite()) return json(429, { error: "too many saved-query changes: wait a minute" }, { "retry-after": "60" });
		if (method === "DELETE") return (await ctx.store.remove(id)) ? json(200, { ok: true }) : json(404, { error: "no such saved query" });
		const changed = await ctx.store.update(id, parseSavedQuery(await readBody(req), false), who);
		return changed ? json(200, { query: changed }) : json(404, { error: "no such saved query" });
	} catch (error) {
		if (error instanceof SavedQueryError) return json(error.status, { error: error.message });
		throw error;
	}
}

async function readBody(req: Request): Promise<unknown> {
	const raw = await readCapped(req, BODY_MAX);
	if (!raw) throw new SavedQueryError(413, "body too large");
	try {
		return JSON.parse(Buffer.from(raw).toString("utf8") || "null");
	} catch {
		throw new SavedQueryError(400, "body is not JSON");
	}
}
