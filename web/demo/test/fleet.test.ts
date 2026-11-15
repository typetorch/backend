/** The fleet mocks: every fleet api.* function through the mock router, answer shapes, writes and privacy. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { runRemote } from "@/lib/remote-debug";
import type { FleetAlert } from "@/lib/types";
import { setClock } from "../mock/data";
import { resetFleetModel } from "../mock/fleet-model";
import { resetRemote } from "../mock/fleet-remote";
import { resetPackCache } from "../mock/pack";
import { MockEventSource } from "../mock/router";
import { describeWithPack, setupDemo, teardownDemo, TEST_NOW, testApi } from "./harness";

let clockNow = TEST_NOW;

/** Moves the demo clock (the pack and the fleet model follow it). */
function at(ms: number) {
	clockNow = ms;
	setClock(() => ms);
	resetPackCache();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describeWithPack("fleet mocks", () => {
	beforeAll(async () => {
		await setupDemo();
		resetFleetModel();
		resetRemote();
	});
	afterAll(() => {
		at(TEST_NOW);
		teardownDemo();
	});

	it("lists live servers with players, metrics, locations and the game's columns", async () => {
		const api = testApi();
		const fleet = await api.fleetServers();
		expect(fleet.servers.length).toBeGreaterThanOrEqual(3);
		expect(fleet.players).toBe(fleet.servers.reduce((n, s) => n + (s.players ?? 0), 0));
		expect(fleet.players).toBeGreaterThan(0);
		expect(fleet.byArtifact.length).toBeGreaterThan(0);
		expect(fleet.geo?.state).toBe("ready");
		for (const s of fleet.servers) {
			expect(s.job).toMatch(UUID);
			expect(["prod", "dev"]).toContain(s.branch);
			expect(s.tps).toBeGreaterThan(30);
			expect(s.memMb).toBeGreaterThan(1000);
			expect(s.location?.org).toBe("Roblox");
			// Documentation addresses only.
			expect(s.ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
			expect(s.cv && typeof s.cv.inmates).toBe("number");
			expect(s.ageSeconds).toBeLessThan(75);
		}
		const prod = await api.fleetServers("prod");
		expect(prod.servers.every((s) => s.branch === "prod")).toBe(true);
		const perf = await api.perfServers();
		expect(perf.servers[0]?.tpsMin).toBeTypeOf("number");
		expect(await api.fleetColumns()).toEqual(expect.arrayContaining([expect.objectContaining({ n: "inmates" })]));
	});

	it("lists recently gone servers, the most recent first", async () => {
		const api = testApi();
		const gone = await api.fleetGoneServers();
		expect(gone.length).toBeGreaterThan(50);
		expect(gone.length).toBeLessThanOrEqual(200);
		const all = (await fetchJson("/api/v1/fleet/servers?gone=1&limit=1000", "GET")) as { servers: { state: string }[] };
		expect(all.servers.some((s) => s.state === "lost")).toBe(true);
		for (let i = 1; i < gone.length; i++) expect((gone[i - 1] as { lastSeen: string }).lastSeen >= (gone[i] as { lastSeen: string }).lastSeen).toBe(true);
		const s = gone[0];
		expect(s?.closedAt ?? s?.lostAt).toBeTruthy();
	});

	it("shows one server of any age with its history and metrics", async () => {
		const api = testApi();
		const live = (await api.fleetServers()).servers[0];
		const detail = await api.fleetServer(live?.job as string);
		expect(detail.state).toBe("live");
		expect(detail.server?.job).toBe(live?.job);
		expect(detail.history?.metrics.from).toBeTypeOf("number");
		const points = await api.serverMetrics(live?.job as string, TEST_NOW - 60 * 60_000);
		expect(points.length).toBeGreaterThan(30);
		expect(points.every((p) => p.t >= TEST_NOW - 61 * 60_000 && p.t <= TEST_NOW)).toBe(true);
		const gone = (await api.fleetGoneServers())[0];
		const goneDetail = await api.fleetServer(gone?.job as string);
		expect(["closed", "lost"]).toContain(goneDetail.state);
		expect((await api.serverMetrics(gone?.job as string, TEST_NOW - 3 * 86_400_000)).length).toBeGreaterThan(0);
		const unknown = await api.fleetServer("00000000-0000-0000-0000-000000000000");
		expect(unknown.state).toBe("unknown");
		await expect(api.watchServer("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ status: 409 });
	});

	it("answers the deploy history, one deploy, the latest report and chart marks", async () => {
		const api = testApi();
		const page = await api.fleetDeploys({ limit: 10 });
		expect(page.deploys).toHaveLength(10);
		expect(page.deploys[0]?.seq).toBe(224);
		expect(page.next).toBe(page.deploys[9]?.seq);
		const next = await api.fleetDeploys({ limit: 50, before: page.next as number });
		expect(next.deploys[0]?.seq).toBe((page.next as number) - 1);
		const all = [...page.deploys, ...next.deploys];
		expect(all.some((d) => d.kind === "promote")).toBe(true);
		const d217 = await api.fleetDeploy(217);
		expect(d217.deploy.outcome).toBe("partial");
		expect(d217.alerts.some((a) => a.code === "deploy_failed")).toBe(true);
		expect(d217.next?.seq).toBe(219);
		expect(d217.report?.errors.length).toBe(1);
		const d224 = await api.fleetDeploy(224);
		expect(d224.deploy.outcome).toBe("ok");
		expect(d224.deploy.reported).toBeGreaterThan(50);
		await expect(api.fleetDeploy(9999)).rejects.toMatchObject({ status: 404 });
		const latest = await api.fleetReport({ branch: "prod" });
		expect(latest.seq).toBe(224);
		expect(latest.results.length).toBeGreaterThan(0);
		expect((await api.fleetReport({ seq: 213 })).reported).toBeGreaterThan(10);
		expect((await api.fleetReport({ artifact: "658d61f-4eba4a" })).seq).toBe(224);
		const marks = await api.fleetMarks({ since: TEST_NOW - 14 * 86_400_000, until: TEST_NOW, limit: 1000 });
		expect(marks.some((m) => m.kind === "deploy")).toBe(true);
		expect(marks.some((m) => m.kind === "kernel")).toBe(true);
		expect(marks.some((m) => m.kind === "backup")).toBe(true);
		expect(marks.every((m) => m.at <= TEST_NOW)).toBe(true);
		await expect(api.fleetMarks({ kinds: "nope" })).rejects.toMatchObject({ status: 400 });
	});

	it("lists alerts, acks one, and opens the debug bundle an alert names", async () => {
		const api = testApi();
		const alerts = await api.fleetAlerts({ limit: 100 });
		expect(alerts.length).toBeGreaterThan(10);
		expect(alerts[0]?.id).toBeGreaterThan(alerts[1]?.id as number);
		const open = alerts.find((a) => !a.acked) as FleetAlert;
		expect(open).toBeDefined();
		const res = await fetchJson(`/api/v1/fleet/alerts/${open.id}/ack`, "POST");
		expect(res).toEqual({ ok: true });
		expect((await api.fleetAlerts({ limit: 100 })).find((a) => a.id === open.id)?.acked).toBe(true);
		expect((await api.fleetAlerts({ unacked: true, limit: 1000 })).some((a) => a.id === open.id)).toBe(false);
		const withBundle = (await api.fleetAlerts({ limit: 1000 })).find((a) => typeof a.details?.bundle === "string") as FleetAlert;
		const bundle = await api.debugBundle(withBundle.details?.bundle as string);
		expect(bundle.job).toBe(withBundle.job);
		expect(Array.isArray(bundle.body.serverLog)).toBe(true);
		expect((bundle.body.players as { u: number }[]).every((p) => p.u < 0)).toBe(true);
		const detail = await api.fleetServer(bundle.job);
		expect(detail.history?.bundles.some((b) => b.id === bundle.id)).toBe(true);
	});

	it("runs remote debug commands on a live server and audits them", async () => {
		const api = testApi();
		const job = (await api.fleetServers("prod")).servers[0]?.job as string;
		await expect(api.remoteCommand(job, "status")).rejects.toMatchObject({ status: 409 });
		const reply = await api.watchServer(job);
		expect(reply).toMatchObject({ job, watched: true, connected: false, wake: true });
		// Commands answer once the server polls: move the clock past its pickup.
		const queued = await api.remoteCommand(job, "status");
		expect(queued.state).toBe("queued");
		at(TEST_NOW + 3_000);
		const done = await api.remoteResult(job, queued.id);
		expect(done.state).toBe("done");
		expect((done.result as { status: { jobId: string } }).status.jobId).toBe(job);
		const run = async <T>(op: Parameters<typeof api.remoteCommand>[1], args?: Record<string, unknown>) => {
			const answer = await runRemote<T>(job, op, args, { api, pollMs: 1, sleep: async () => at(clockNow + 1_000), now: () => clockNow });
			return answer.result;
		};
		const players = await run<{ players: { userId: number; name: string }[] }>("players");
		expect(players.players.length).toBeGreaterThan(0);
		expect(players.players.every((p) => p.userId < 0 && /^(Inmate|Guard)_\d{4}$/.test(p.name))).toBe(true);
		const logs = await run<{ entries: unknown[]; last: number }>("logs", { limit: 50 });
		expect(logs.entries).toHaveLength(50);
		const playerLogs = await run<{ entries: unknown[] }>("player.logs", { userId: players.players[0]?.userId });
		expect(playerLogs.entries.length).toBeGreaterThan(0);
		for (const op of ["builds", "budget", "errors", "modules", "assets", "network"] as const) expect(await run(op)).toBeTruthy();
		const roots = await run<{ entries: { key: string }[] }[]>("state", { queries: [{ root: "", path: [] }] });
		expect(roots[0]?.entries.some((e) => e.key === "QuestService")).toBe(true);
		const quest = await run<{ entries: unknown[] }[]>("state", { queries: [{ root: "QuestService", path: ["daily"] }] });
		expect(quest[0]?.entries.length).toBeGreaterThan(0);
		const dex = await run<{ rows: { id: number; name: string }[] }[]>("dex.children", { nodes: [{ id: 0 }] });
		expect(dex[0]?.rows.some((r) => r.name === "Workspace")).toBe(true);
		const props = await run<{ className: string }>("dex.props", { id: 1 });
		expect(props.className).toBe("Workspace");
		const game = await run<{ kind: string }>("game.round_state");
		expect(game.kind).toBe("kv");
		await expect(api.remoteCommand(job, "game.not_declared")).rejects.toMatchObject({ status: 400 });
		const entries = await api.debugAudit(50);
		expect(entries.length).toBeGreaterThan(5);
		expect(entries[0]?.who).toBe("roblox:-1");
		const streams = await api.serverStreams(job);
		expect(streams.declared.streams.length).toBeGreaterThan(0);
		expect(streams.frames.length).toBeGreaterThan(5);
		const positions = streams.frames[streams.frames.length - 1]?.s.positions?.players ?? [];
		expect(positions.length).toBeGreaterThan(0);
		expect(positions.every((p) => p.u < 0)).toBe(true);
		const later = await api.serverStreams(job, streams.frames[streams.frames.length - 1]?.t);
		expect(later.frames).toHaveLength(0);
		at(TEST_NOW);
	});

	it("holds the live map watch and answers every server's positions", async () => {
		const api = testApi();
		const before = await api.liveMap();
		expect(before.servers).toHaveLength(0);
		const w = await api.watchLiveMap();
		expect(w.ok).toBe(true);
		const map = await api.liveMap();
		expect(map.watchedUntil).toBe(w.until);
		expect(map.servers.length).toBeGreaterThan(0);
		const placed = map.servers.flatMap((s) => s.players).filter((p) => p.st === "alive");
		expect(placed.length).toBeGreaterThan(0);
		// On the exported map's footprint.
		for (const p of placed) {
			expect(p.x).toBeGreaterThan(-600);
			expect(p.x).toBeLessThan(410);
			expect(p.z).toBeGreaterThan(-180);
			expect(p.z).toBeLessThan(1100);
		}
	});

	it("answers Roblox's server logs and the place card without any Roblox URL", async () => {
		const api = testApi();
		const job = (await api.fleetServers("prod")).servers[0]?.job as string;
		const logs = await api.robloxServerLogs(job);
		expect(logs.placeVersion).toBeGreaterThan(10000);
		expect(logs.logs.length).toBeGreaterThan(0);
		if (logs.nextPageToken) expect((await api.robloxServerLogs(job, { pageToken: logs.nextPageToken })).logs.length).toBeGreaterThan(0);
		const unknown = await api.robloxServerLogs("abc-def").catch((e: unknown) => e);
		expect(unknown).toBeInstanceOf(ApiError);
		expect((unknown as ApiError).status).toBe(409);
		expect((unknown as ApiError).body).toMatchObject({ placeVersion: null });
		const place = await api.place();
		expect(place).toMatchObject({ configured: true, name: "The Prison", icon: null, url: null });
		expect(JSON.stringify(place)).not.toMatch(/roblox\.com|rbxcdn/);
	});

	it("streams fleet events after hello", async () => {
		const api = testApi();
		const source = new MockEventSource(api.streamUrl({ branch: "prod" }));
		const hello = await new Promise<string>((resolve) => source.addEventListener("hello", (e) => resolve((e as MessageEvent<string>).data)));
		expect(JSON.parse(hello).at).toBeTypeOf("string");
		source.close();
	});
});

async function fetchJson(path: string, method: string): Promise<unknown> {
	const { mockFetch } = await import("./harness");
	const r = await mockFetch(path, method === "GET" ? {} : { method, headers: { "content-type": "application/json", "x-typetorch": "1" }, body: "{}" });
	return r.json();
}
