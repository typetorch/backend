/**
 * Experience notifications, wired (plans/29, the contract plans/29-contract.md "HTTP (backend)"): the service that owns
 * notify.db, the planner, the sender and the keys, and the request handlers app.ts routes to after its own gates.
 *
 *   game key   POST /v1/notify/intents  { v: 1, items }  -> { ok, accepted, rejected: [{ i, why }], stale }
 *              POST /v1/notify/opened   { nid, u }       -> { state: first | repeat | unknown }
 *              POST /v1/notify/played   { nid, u, secs } -> { ok }
 *   admin      GET|PUT /v1/notify/config, GET /v1/notify/status, PUT /v1/notify/keys, POST /v1/notify/test, POST /v1/notify/send
 */
import { dirname, join } from "node:path";
import { openSqlite, type FleetDb } from "../fleet/db.ts";
import { Durable } from "../store/durable.ts";
import { CUSTOM_KIND, ConfigError, TEMPLATE, validateConfig, type NotifyConfig } from "./config.ts";
import { DAY_MS, HOUR_MS, Planner, dayFreeAt, type DayClock, type RowSink } from "./planner.ts";
import { MUTE_MS, Sender } from "./sender.ts";
import { DUE_SET, NotifyStore, PENDING_MAX, type IntentOp } from "./store.ts";
import { DATA_MAX_BYTES, KIND_PATTERN, NID_PATTERN, NotifyKeyStore, newNid, parseKeys, tokenLength, type NotifyKeys } from "./token.ts";

export const INTENTS_BODY_MAX = 256 * 1024;
export const ITEMS_MAX = 200;
export const SMALL_BODY_MAX = 4 * 1024;
export const KEY_MAX = 64;
export const PARAMS_MAX = 8;
export const PARAM_NAME = /^[a-zA-Z0-9_]{1,32}$/;
export const PARAM_VALUE_MAX = 64;
/** An intent's window: `until` defaults to `at` + 7 days, and may reach a year out at most. */
export const DEFAULT_WINDOW_MS = 7 * DAY_MS;
export const MAX_AHEAD_MS = 365 * DAY_MS;
export const NOTIFY_KEYS_FILE = "notify-keys.json";
/** Rows buffered for the events table before the oldest are dropped (counted). */
export const ROWS_MAX = 10_000;

export type Reply = { status: number; body: Record<string, unknown> };
const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const uidOk = (u: unknown): u is number => typeof u === "number" && Number.isSafeInteger(u) && u > 0;
const secondsOk = (t: unknown): t is number => typeof t === "number" && Number.isSafeInteger(t) && t > 0 && t < 1e11;

/** The switches app.ts reads from the runtime settings (`notify.*`). */
export interface NotifySwitches {
	enabled(): boolean;
	dryRun(): boolean;
	rate(): number;
	clock(): DayClock;
	kindEnabled(kind: string): boolean;
}

export interface NotifyOptions {
	/** The fleet SQLite file's path: notify.db goes next to it (":memory:" stays in memory). */
	fleetDb: string;
	dataDir: string;
	/** TYPETORCH_NOTIFY_KEY (current only; beats the keys file). */
	envKey?: string;
	/** OPENCLOUD_NOTIFY_KEY ?? OPENCLOUD_API_KEY. */
	apiKey?: string;
	universeId?: number;
	switches: NotifySwitches;
	/** S1b: turn a kind off for good (app.ts: the runtime setting, audited as the system) and alert. */
	stopKind(kind: string, why: "bad_template"): void;
	/** UserId -> the pid for backend rows ("" when unknown); erased players are never named. */
	pidOf(userId: number): Promise<string>;
	/** Hands rows to the events pipeline (the bus); absent = rows dropped (no analytics part). */
	publish?(rows: Record<string, unknown>[]): Promise<void>;
	clock?: () => number;
	random?: () => number;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

/** notify.db's path for a fleet DB path. */
export const notifyDbPath = (fleetDb: string) => (fleetDb === ":memory:" ? ":memory:" : join(dirname(fleetDb), "notify.db"));

/** Rows the backend writes (src = backend, no sid, pid from identities), buffered and flushed after each step. */
class RowBuffer {
	private rows: { uid: number; t: number; name: string; props: Record<string, unknown> }[] = [];
	dropped = 0;

	constructor(private readonly o: NotifyOptions, private readonly clock: () => number) {}

	readonly push: RowSink = (uid, name, props) => {
		if (!this.o.publish) return;
		this.rows.push({ uid, t: this.clock(), name, props });
		if (this.rows.length > ROWS_MAX) {
			this.rows.shift();
			this.dropped++;
		}
	};

	async flush(): Promise<void> {
		if (!this.rows.length || !this.o.publish) return;
		const batch = this.rows;
		this.rows = [];
		const pids = new Map<number, string>();
		const out: Record<string, unknown>[] = [];
		for (const r of batch) {
			if (!pids.has(r.uid)) pids.set(r.uid, await this.o.pidOf(r.uid));
			out.push({ v: 1, t: r.t, kind: "notify", name: r.name, pid: pids.get(r.uid) ?? "", sid: "", job: "backend", art: "backend", src: "backend", props: JSON.stringify(r.props) });
		}
		for (let i = 0; i < out.length; i += 1000) await this.o.publish(out.slice(i, i + 1000));
	}
}

interface Halt {
	why: "bad_template";
	at: number;
}
const HALTED_KEY = "notify:halted";

export class NotifyService {
	readonly planner: Planner;
	readonly sender: Sender;
	readonly rows: RowBuffer;
	private halted = new Map<string, Halt>();
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	/** notify.db's path (":memory:" in tests): the nightly backup copies it. */
	readonly dbPath: string;

	private constructor(
		private readonly o: NotifyOptions,
		readonly db: FleetDb,
		readonly store: NotifyStore,
		readonly durable: Durable,
		readonly keys: NotifyKeyStore,
	) {
		this.clock = o.clock ?? Date.now;
		this.log = o.log ?? (() => {});
		this.dbPath = notifyDbPath(o.fleetDb);
		this.rows = new RowBuffer(o, this.clock);
		const kindOn = (kind: string) => this.kindOn(kind);
		this.planner = new Planner({ store, clock: this.clock, ...(o.random ? { random: o.random } : {}), enabled: () => o.switches.enabled(), kindOn, dayClock: () => o.switches.clock(), rows: this.rows.push });
		this.sender = new Sender({
			store,
			durable,
			clock: this.clock,
			...(o.fetch ? { fetch: o.fetch } : {}),
			...(o.sleep ? { sleep: o.sleep } : {}),
			enabled: () => o.switches.enabled(),
			dryRun: () => o.switches.dryRun(),
			rate: () => o.switches.rate(),
			dayClock: () => o.switches.clock(),
			kindOn,
			halt: (kind, why) => void this.halt(kind, why),
			keys: () => keys.keys(),
			apiKey: () => o.apiKey,
			universeId: () => o.universeId,
			rows: this.rows.push,
			log: this.log,
		});
	}

	static async open(o: NotifyOptions): Promise<NotifyService> {
		const clock = o.clock ?? Date.now;
		const db = await openSqlite(notifyDbPath(o.fleetDb));
		const durable = await Durable.open(db, clock);
		const store = await NotifyStore.open(db, clock);
		const keys = new NotifyKeyStore(join(o.dataDir, NOTIFY_KEYS_FILE), o.envKey, o.log);
		const service = new NotifyService(o, db, store, durable, keys);
		const saved = await durable.getJson<Record<string, Halt>>(HALTED_KEY);
		if (isRecord(saved)) for (const [kind, h] of Object.entries(saved)) if (KIND_PATTERN.test(kind) && isRecord(h)) service.halted.set(kind, { why: "bad_template", at: Number(h.at) || 0 });
		return service;
	}

	kindOn(kind: string): boolean {
		return kind === CUSTOM_KIND || (this.o.switches.kindEnabled(kind) && !this.halted.has(kind));
	}

	private async saveHalts(): Promise<void> {
		await this.durable.setJson(HALTED_KEY, Object.fromEntries(this.halted));
	}

	/** S1b: the kind's message id doesn't exist on Roblox. Stops the kind (switch + halt flag) and alerts. */
	async halt(kind: string, why: "bad_template"): Promise<void> {
		if (this.halted.has(kind)) return;
		this.halted.set(kind, { why, at: this.clock() });
		await this.saveHalts();
		this.log(`alert: notify kind ${kind} stopped: its template (message id) does not exist on Roblox; fix it, push the config, then turn the kind back on`);
		try {
			this.o.stopKind(kind, why);
		} catch (error) {
			this.log(`notify: could not switch kind ${kind} off (${((error as Error).message ?? String(error)).slice(0, 120)}); the halt holds it`);
		}
	}

	/** Clears halts for kinds that were turned back on (the Settings change) or got a new template (a config push). */
	async clearHalts(kinds: string[]): Promise<void> {
		let changed = false;
		for (const kind of kinds) changed = this.halted.delete(kind) || changed;
		if (changed) {
			await this.saveHalts();
			// Their users are looked at again on the next tick.
			await this.db.run("UPDATE notify_users SET next_check = 0 WHERE next_check > ?", [this.clock()]);
		}
	}

	haltedKinds(): string[] {
		return [...this.halted.keys()];
	}

	/** The planner's tick (every 30 s), then the rows. */
	async planTick(): Promise<void> {
		try {
			await this.planner.tick();
		} finally {
			await this.rows.flush();
		}
	}

	/** The sender's tick (every second), then the rows. */
	async sendTick(): Promise<void> {
		try {
			await this.sender.tick();
		} finally {
			await this.rows.flush();
		}
	}

	/** Every minute: expired kv; every 10 minutes (the app's prune timer): old sends and intents. */
	async sweep(): Promise<void> {
		await this.durable.sweep();
	}

	async prune(): Promise<{ sends: number; intents: number }> {
		return this.store.prune(this.clock());
	}

	async eraseUser(userId: number): Promise<number> {
		return this.store.eraseUser(userId);
	}

	async close(): Promise<void> {
		await this.sender.idle(2000);
		await this.rows.flush().catch(() => undefined);
		await this.db.close();
	}

	// Game routes ------------------------------------------------------------------------------------------------------

	async intents(body: unknown): Promise<Reply> {
		if (!isRecord(body) || body.v !== 1 || !Array.isArray(body.items)) return reply(400, { error: "send { v: 1, items: [...] }" });
		if (body.items.length > ITEMS_MAX) return reply(400, { error: `at most ${ITEMS_MAX} items per request` });
		const cfg = await this.store.config();
		const now = this.clock();
		const ops: IntentOp[] = [];
		const rejected: { i: number; why: string }[] = [];
		const index: number[] = [];
		const full = (await this.store.pendingCount()) >= PENDING_MAX;
		body.items.forEach((raw, i) => {
			const why = parseItem(raw, cfg?.config, now, ops, full);
			if (why) rejected.push({ i, why });
			else index.push(i);
		});
		const result = ops.length ? await this.store.apply(ops, (cfg?.config.quietAfterLeaveMinutes ?? 120) * 60_000) : { accepted: 0, stale: 0, cancelled: [] };
		for (const c of result.cancelled) if (c.dropped) this.rows.push(c.userId, "skipped", { k: c.kind, why: "dropped" });
		await this.rows.flush();
		return reply(200, { ok: true, accepted: result.accepted + result.stale, rejected, stale: result.stale });
	}

	async opened(body: unknown): Promise<Reply> {
		if (!isRecord(body) || typeof body.nid !== "string" || !NID_PATTERN.test(body.nid) || !uidOk(body.u)) return reply(400, { error: "send { nid, u }" });
		const r = await this.store.opened(body.nid, body.u);
		return reply(200, { state: r.state });
	}

	async played(body: unknown): Promise<Reply> {
		if (!isRecord(body) || typeof body.nid !== "string" || !NID_PATTERN.test(body.nid) || !uidOk(body.u)) return reply(400, { error: "send { nid, u, secs }" });
		const secs = body.secs;
		if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0 || secs > 7 * 86_400) return reply(400, { error: "secs is 0 to 604800" });
		await this.store.played(body.nid, body.u, Math.round(secs));
		return reply(200, { ok: true });
	}

	// Admin routes -----------------------------------------------------------------------------------------------------

	async getConfig(): Promise<Reply> {
		const c = await this.store.config();
		return reply(200, { config: c?.config ?? null, updatedAt: c?.updatedAt ?? null, by: c?.by ?? null });
	}

	/** PUT /v1/notify/config: validated and stored; kinds whose template changed lose their halt. */
	async putConfig(body: unknown, by: string): Promise<Reply & { kinds?: string[] }> {
		let config: NotifyConfig;
		try {
			config = validateConfig(body);
		} catch (error) {
			if (error instanceof ConfigError) return reply(400, { error: error.message });
			throw error;
		}
		const before = (await this.store.config())?.config;
		await this.store.setConfig(config, by);
		const fixed = this.haltedKinds().filter((k) => config.kinds[k] && config.kinds[k]?.template !== before?.kinds[k]?.template);
		await this.clearHalts(fixed);
		return { ...reply(200, { ok: true, kinds: Object.keys(config.kinds).length, updatedAt: (await this.store.config())?.updatedAt ?? this.clock() }), kinds: Object.keys(config.kinds) };
	}

	async putKeys(body: unknown): Promise<Reply> {
		let keys: NotifyKeys;
		try {
			keys = parseKeys(body, Math.floor(this.clock() / 1000));
		} catch (error) {
			return reply(400, { error: (error as Error).message });
		}
		this.keys.save(keys);
		return reply(200, { ok: true, keys: this.keys.summary() });
	}

	async status(): Promise<Reply> {
		const now = this.clock();
		const cfg = await this.store.config();
		const pending = await this.store.pendingByKind();
		const s = this.o.switches;
		const kinds = Object.entries(cfg?.config.kinds ?? {}).map(([kind, k]) => ({
			kind,
			enabled: this.kindOn(kind),
			template: Boolean(k.template),
			pending: pending.get(kind) ?? 0,
			...(this.halted.has(kind) ? { halted: "bad_template" } : {}),
		}));
		const bucket = this.sender.bucket.view();
		return reply(200, {
			enabled: s.enabled(),
			dryRun: s.dryRun(),
			rate: s.rate(),
			clock: s.clock(),
			configured: this.sender.configured(),
			config: Boolean(cfg),
			keys: this.keys.summary(),
			kinds,
			halted: [...this.halted].map(([kind, h]) => ({ kind, why: h.why, at: h.at })),
			queue: { pending: [...pending.values()].reduce((a, b) => a + b, 0), due1h: await this.durable.zcount(DUE_SET, 0, now + HOUR_MS), sending: await this.durable.zleased(DUE_SET, now) },
			bucket: { rate: bucket.rate, tokens: bucket.tokens, last429At: bucket.last429At },
			sends24h: await this.store.sendCounts(now - DAY_MS),
			mutes: await this.store.mutes(now),
			rowsDropped: this.rows.dropped,
		});
	}

	/** POST /v1/notify/test: one send of a configured kind now, bypassing every cap (marked test). */
	async test(body: unknown): Promise<Reply> {
		if (!isRecord(body) || !uidOk(body.userId) || typeof body.kind !== "string" || !KIND_PATTERN.test(body.kind)) return reply(400, { error: "send { userId, kind, params?, data? }" });
		const cfg = await this.store.config();
		const kind = cfg?.config.kinds[body.kind];
		if (!kind) return reply(400, { error: "unknown kind: push the config first (typetorch notify push)" });
		const extra = parseExtras(body, body.kind, body.userId, this.clock());
		if (typeof extra === "string") return reply(400, { error: extra });
		const nid = newNid();
		await this.store.plan({ nid, userId: body.userId, kind: body.kind, key: `test:${nid}`, rev: 0, template: kind.template ?? null, category: kind.category ?? body.kind, params: extra.params, data: extra.data, plannedAt: this.clock(), test: true });
		this.rows.push(body.userId, "planned", { nid, k: body.kind, for: Math.floor(this.clock() / 1000), why: "asap", test: true });
		await this.rows.flush();
		void this.sendTick().catch(() => undefined);
		return reply(200, { nid, status: "planned" });
	}

	/** POST /v1/notify/send: a one-off (kind custom, category = template) that respects the mute and the day cap. */
	async send(body: unknown): Promise<Reply> {
		if (!isRecord(body) || !uidOk(body.userId) || typeof body.template !== "string" || !TEMPLATE.test(body.template)) return reply(400, { error: "send { userId, template, params?, data? }" });
		const extra = parseExtras(body, CUSTOM_KIND, body.userId, this.clock());
		if (typeof extra === "string") return reply(400, { error: extra });
		const now = this.clock();
		const user = await this.store.user(body.userId);
		if (user?.mute_until && Number(user.mute_until) > now) return reply(200, { skipped: "muted" });
		if (user?.busy) return reply(200, { skipped: "busy" });
		if (user?.capped_until && Number(user.capped_until) > now) return reply(200, { skipped: "capped_day" });
		const cap = (await this.store.config())?.config.dailyCap ?? 1;
		const recent = await this.store.recentSends(body.userId, now - 2 * DAY_MS);
		if (dayFreeAt(recent.map((r) => r.at), cap, this.o.switches.clock(), now) > now) return reply(200, { skipped: "capped_day" });
		const nid = newNid();
		await this.store.plan({ nid, userId: body.userId, kind: CUSTOM_KIND, key: `send:${nid}`, rev: 0, template: body.template, category: body.template.slice(0, 64), params: extra.params, data: extra.data, plannedAt: now, test: false });
		this.rows.push(body.userId, "planned", { nid, k: CUSTOM_KIND, for: Math.floor(now / 1000), why: "asap" });
		await this.rows.flush();
		void this.sendTick().catch(() => undefined);
		return reply(200, { nid, status: "planned" });
	}

	/** For tests and the status line: the mute that S1 sets. */
	static readonly MUTE_MS = MUTE_MS;
}

/** params / data of the admin sends, checked like an intent's. */
function parseExtras(body: Record<string, unknown>, kind: string, userId: number, now: number): { params: string | null; data: string | null } | string {
	const params = checkParams(body.params);
	if (params === false) return `params: at most ${PARAMS_MAX} entries, names ${PARAM_NAME.source}, string values of at most ${PARAM_VALUE_MAX} characters`;
	if (body.data !== undefined && (typeof body.data !== "string" || Buffer.byteLength(body.data, "utf8") > DATA_MAX_BYTES)) return `data is a string of at most ${DATA_MAX_BYTES} bytes`;
	const data = typeof body.data === "string" && body.data ? body.data : null;
	if (tokenLength({ nid: "0000000000", kind, userId, t: Math.floor(now / 1000) + 30 * 86_400, data: data ?? "" }) > 200) return "the launch data would be over 200 bytes";
	return { params: params ? JSON.stringify(params) : null, data };
}

/** false = bad; null = none. */
function checkParams(raw: unknown): Record<string, string> | null | false {
	if (raw === undefined || raw === null) return null;
	if (!isRecord(raw)) return false;
	const entries = Object.entries(raw);
	if (entries.length > PARAMS_MAX) return false;
	const out: Record<string, string> = {};
	for (const [k, v] of entries) {
		if (!PARAM_NAME.test(k) || typeof v !== "string" || v.length > PARAM_VALUE_MAX) return false;
		out[k] = v;
	}
	return entries.length ? out : null;
}

/** Checks one intent item; pushes the op, or returns why it is rejected. */
function parseItem(raw: unknown, config: NotifyConfig | undefined, now: number, ops: IntentOp[], full: boolean): string | undefined {
	if (!isRecord(raw)) return "bad_item";
	if (raw.op === "presence") {
		if (!uidOk(raw.u)) return "bad_user";
		if (typeof raw.online !== "boolean") return "bad_item";
		if (!secondsOk(raw.at) || raw.at * 1000 > now + HOUR_MS) return "bad_time";
		ops.push({ op: "presence", u: raw.u, online: raw.online, at: raw.at * 1000 });
		return undefined;
	}
	if (raw.op !== "want" && raw.op !== "drop") return "bad_op";
	if (!uidOk(raw.u)) return "bad_user";
	if (typeof raw.k !== "string" || !KIND_PATTERN.test(raw.k)) return "bad_kind";
	const kind = config?.kinds[raw.k];
	if (!kind) return "unknown_kind";
	if (raw.key !== undefined && (typeof raw.key !== "string" || raw.key.length > KEY_MAX || /[\0-\x1f]/.test(raw.key))) return "bad_key";
	if (typeof raw.rev !== "number" || !Number.isSafeInteger(raw.rev) || raw.rev <= 0) return "bad_rev";
	if (raw.op === "drop") {
		if (raw.why !== undefined && (typeof raw.why !== "string" || raw.why.length > 64)) return "bad_why";
		ops.push({ op: "drop", u: raw.u, k: raw.k, key: typeof raw.key === "string" ? raw.key : null, why: typeof raw.why === "string" ? raw.why : null, rev: raw.rev });
		return undefined;
	}
	if (full) return "full";
	if (raw.at !== undefined && !secondsOk(raw.at)) return "bad_time";
	if (raw.until !== undefined && !secondsOk(raw.until)) return "bad_time";
	const at = raw.at !== undefined ? (raw.at as number) * 1000 : now;
	const until = raw.until !== undefined ? (raw.until as number) * 1000 : Math.max(at, now) + DEFAULT_WINDOW_MS;
	if (until <= at || at > now + MAX_AHEAD_MS || until > now + MAX_AHEAD_MS) return "bad_time";
	const params = checkParams(raw.params);
	if (params === false) return "bad_params";
	if (raw.data !== undefined && (typeof raw.data !== "string" || Buffer.byteLength(raw.data, "utf8") > DATA_MAX_BYTES)) return "bad_data";
	let template: string | null = null;
	if (raw.template !== undefined) {
		if (!kind.allowTemplate) return "template_not_allowed";
		if (typeof raw.template !== "string" || !TEMPLATE.test(raw.template)) return "bad_template";
		template = raw.template;
	}
	const data = typeof raw.data === "string" && raw.data ? raw.data : null;
	// The signed launch data must fit Roblox's 200 bytes at the latest send time.
	if (tokenLength({ nid: "0000000000", kind: raw.k, userId: raw.u, t: Math.floor(until / 1000), data: data ?? "" }) > 200) return "too_long";
	ops.push({ op: "want", u: raw.u, k: raw.k, key: typeof raw.key === "string" ? raw.key : "", at, until, params, data, template, rev: raw.rev });
	return undefined;
}
