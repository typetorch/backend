/**
 * Cross-domain links: an id one page shows opens on the page it links to (a JobId from the fleet, errors or analytics
 * opens its server page; a deploy seq opens; a pid from errors or analytics is a pack player with a profile; an error
 * fingerprint from a server or player list opens; every alert's bundle opens; every bought product has a name).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { pack } from "../mock/pack";
import { describeWithPack, setupDemo, teardownDemo, TEST_NOW, testApi } from "./harness";

const DAY = 86_400_000;

/** Every string value under `key` anywhere in `value`. */
function collect(value: unknown, key: string, out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) for (const v of value) collect(v, key, out);
	else if (value && typeof value === "object")
		for (const [k, v] of Object.entries(value)) {
			if (k === key && typeof v === "string" && v) out.add(v);
			else collect(v, key, out);
		}
	return out;
}

describeWithPack("ids link up across the demo's pages", () => {
	beforeAll(() => setupDemo({ engine: true }));
	afterAll(() => teardownDemo());

	it("every live and gone server opens, with metrics, errors and Roblox logs", async () => {
		const api = testApi();
		const live = (await api.fleetServers()).servers;
		expect(live.length).toBeGreaterThan(0);
		for (const s of live) {
			const d = await api.fleetServer(s.job);
			expect(d.server?.job, s.job).toBe(s.job);
			expect((await api.serverMetrics(s.job)).length, s.job).toBeGreaterThan(0);
			await api.serverErrors(s.job, { window: "24h" });
			await api.robloxServerLogs(s.job);
		}
		const gone = await api.fleetGoneServers();
		expect(gone.length).toBeGreaterThan(0);
		for (const s of gone.slice(0, 40)) expect((await api.fleetServer(s.job)).server?.job, s.job).toBe(s.job);
	});

	it("every deploy in the history opens, and its servers open", async () => {
		const api = testApi();
		const seqs: number[] = [];
		let before: number | undefined;
		for (let i = 0; i < 20; i++) {
			const page = await api.fleetDeploys({ limit: 50, ...(before !== undefined ? { before } : {}) });
			seqs.push(...page.deploys.map((d) => d.seq));
			if (page.next === null) break;
			before = page.next;
		}
		expect(seqs.length).toBeGreaterThan(10);
		for (const seq of seqs) {
			const d = await api.fleetDeploy(seq);
			expect(d.deploy.seq).toBe(seq);
			for (const job of collect(d.report, "job")) expect((await api.fleetServer(job)).server, `seq ${seq} job ${job}`).not.toBeNull();
		}
	});

	it("every alert's server and bundle open", async () => {
		const api = testApi();
		const alerts = await api.fleetAlerts({ limit: 1000 });
		expect(alerts.length).toBeGreaterThan(0);
		for (const a of alerts) {
			if (a.job) expect((await api.fleetServer(a.job)).server, `alert ${a.id} ${a.code} job`).not.toBeNull();
			if (typeof a.details?.bundle === "string") expect((await api.debugBundle(a.details.bundle as string)).id).toBe(a.details.bundle);
			if (a.seq) expect((await api.fleetDeploy(a.seq)).deploy.seq).toBe(a.seq);
		}
	});

	it("errors link to servers, players and back", async () => {
		const api = testApi();
		const p = await pack();
		const list = await api.errors({ window: "7d", limit: 30 });
		expect(list.kinds.length).toBeGreaterThan(0);
		for (const k of list.kinds.slice(0, 15)) {
			const d = await api.errorKind(k.fp, { window: "7d" });
			expect(d.kind.fp).toBe(k.fp);
			for (const j of (d.byJob ?? []).slice(0, 5)) expect((await api.fleetServer(j.job)).server, `error ${k.fp} job ${j.job}`).not.toBeNull();
			const players = await api.errorPlayers(k.fp, { window: "7d" });
			for (const pl of players.players.slice(0, 5)) {
				expect(p.player(pl.pid), `error ${k.fp} pid ${pl.pid}`).toBeTruthy();
				expect(pl.uid).toBeUndefined();
				const mine = await api.playerErrors(pl.pid, { window: "7d" });
				expect(mine.errors.some((e) => e.fp === k.fp), `player ${pl.pid} lists ${k.fp}`).toBe(true);
			}
		}
		const job = (await api.fleetServers()).servers[0]?.job as string;
		const se = await api.serverErrors(job, { window: "7d" });
		for (const e of se.errors.slice(0, 5)) expect((await api.errorKind(e.fp, { window: "7d" })).kind.fp).toBe(e.fp);
	});

	it("pids and JobIds in the analytics answers are the pack's and open", async () => {
		const api = testApi();
		const p = await pack();
		const from = new Date(TEST_NOW - 6 * DAY).toISOString().slice(0, 10);
		const pids = new Set<string>();
		const jobs = new Set<string>();
		for (const name of ["players", "servers", "perf-server", "recording-sessions", "monetization-players", "churn", "quit-autopsy", "events"]) {
			let result: unknown;
			try {
				result = (await api.raw(name, { filters: { from }, options: {} })).result;
			} catch {
				continue;
			}
			collect(result, "pid", pids);
			collect(result, "job", jobs);
		}
		expect(pids.size).toBeGreaterThan(0);
		for (const pid of [...pids].slice(0, 30)) {
			expect(p.player(pid), pid).toBeTruthy();
			const profile = await api.playerProfile(pid);
			expect(profile).toBeTruthy();
		}
		// `job` is also a prop of the game's own (a prison job like trash_bin): only JobIds.
		const jobIds = [...jobs].filter((j) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(j));
		expect(jobIds.length).toBeGreaterThan(0);
		for (const job of jobIds.slice(0, 30)) expect((await api.fleetServer(job)).server, `analytics job ${job}`).not.toBeNull();
	});

	it("every product a player bought has a name", async () => {
		const api = testApi();
		const from = new Date(TEST_NOW - 29 * DAY).toISOString().slice(0, 10);
		const result = (await api.raw("monetization", { filters: { from }, options: {} })).result as { products: { kind: string; product: string | null }[] };
		const gamepass = new Set<number>();
		const product = new Set<number>();
		for (const p of result.products) {
			const id = Number(p.product);
			if (!Number.isSafeInteger(id) || id <= 0) continue;
			if (p.kind === "gamepass") gamepass.add(id);
			else if (p.kind === "product") product.add(id);
		}
		expect(gamepass.size + product.size).toBeGreaterThan(0);
		const items = await api.robloxProducts({ gamepass: [...gamepass].slice(0, 25), product: [...product].slice(0, 25) });
		expect(items.length).toBe(Math.min(25, gamepass.size) + Math.min(25, product.size));
		for (const item of items) {
			expect(item.status, JSON.stringify(item)).toBe("ok");
			expect(item.name, JSON.stringify(item)).toBeTruthy();
			expect(item.icon ?? null).toBeNull();
		}
	});

	it("experiments, live events and saved queries open", async () => {
		const api = testApi();
		const overrides = await api.experimentOverrides();
		expect(overrides).toBeTruthy();
		for (const exp of ["one_tap_play", "tutorial_ui"]) {
			const players = await api.experimentPlayers(exp, { from: new Date(TEST_NOW - 13 * DAY).toISOString().slice(0, 10) });
			expect(JSON.stringify(players).length).toBeGreaterThan(20);
		}
		const live = await api.liveEvents();
		expect(live.events.length).toBeGreaterThan(0);
		// The page asks for a lift report only once an event started (an upcoming one answers 409, like the backend).
		for (const e of live.events.filter((x) => Date.parse(x.start) < TEST_NOW)) await api.liveEventLift(e.id);
		const saved = await api.savedQueries();
		expect(saved.length).toBeGreaterThan(0);
		for (const q of saved) {
			const r = await api.sql(q.sql, 100);
			expect(r.rows.length, q.name).toBeGreaterThan(0);
		}
	});
});
