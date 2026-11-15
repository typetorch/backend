/**
 * Load test: starts the server as a child process (a fresh temp data folder, DuckDB memory_limit 400MB, 2 threads)
 * and measures it.
 *
 *   bun scripts/loadtest.ts analytics --rate 1000 --seconds 60     synthetic gzip batches at N events/s
 *   bun scripts/loadtest.ts fleet --servers 2500 --seconds 90      N game servers heartbeating every 30 s
 *   add --node to run the server under Node (dist/, after `bun run build`)
 *   add --cpus 1 to pin the server to one core (Windows: processor affinity; Linux: taskset)
 *   add --ingest-nodes 2 (analytics) for plans/35 C: a main server plus N ingest nodes (TYPETORCH_ROLE=main / ingest)
 *     and an in-process fake S3 bucket (test/s3-fake.ts) between them; the batches go round-robin to the nodes
 *
 * Reports: request latency (p50/p95/p99/max), the server's peak RSS, loader lag (peak, and the time to catch up
 * after the load stops), query time afterwards; for the fleet: heartbeat -> query and heartbeat -> SSE latency.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createFleetClient } from "../src/fleet/client.ts";
import { fakeS3, queueEnv } from "../test/s3-fake.ts";

const args = process.argv.slice(2);
const mode = args[0] === "fleet" ? "fleet" : "analytics";
const opt = (name: string, fallback: number) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? Number(args[i + 1]) : fallback;
};
const useNode = args.includes("--node");
/** Pin the server to this many CPU cores (a 1 GB VPS usually has 1 vCPU). */
const pinCpus = opt("cpus", 0);
const seconds = opt("seconds", mode === "fleet" ? 90 : 60);
const INGEST = "loadtest-ingest-token-0123456789abcdef";
const ADMIN = "loadtest-admin-token-0123456789abcdef";
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "tt-loadtest-"));
/** Plans/35 C: ingest nodes in front of the server (0 = the plain single server). */
const ingestNodes = mode === "analytics" ? opt("ingest-nodes", 0) : 0;
const s3 = ingestNodes > 0 ? fakeS3() : undefined;
const queue = s3 ? queueEnv(s3) : {};

function percentile(values: number[], p: number): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

const root = join(import.meta.dir, "..");
const command = useNode ? ["node", join(root, "dist", "server", "main.js")] : [process.execPath, join(root, "src", "server", "main.ts")];
const child = spawn(command[0], command.slice(1), {
	env: {
		...process.env,
		TYPETORCH_DATA_DIR: dir,
		PORT: String(port),
		TYPETORCH_API_KEY: INGEST,
		TYPETORCH_ADMIN_TOKEN: ADMIN,
		TYPETORCH_LOAD_SECONDS: "2",
		TYPETORCH_MEMORY_LIMIT: "400MB",
		TYPETORCH_THREADS: "2",
		TYPETORCH_IP_PER_MINUTE: "1000000",
		TYPETORCH_JOB_PER_MINUTE: "100000",
		TYPETORCH_PARTS: mode,
		TYPETORCH_EXPLORER: "off",
		...(ingestNodes > 0 ? { TYPETORCH_ROLE: "main", TYPETORCH_PARTS: "analytics,fleet", ...queue } : {}),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
/** The ingest nodes: each its own process, data folder and port. */
const nodes = Array.from({ length: ingestNodes }, (_, i) => {
	const nodeDir = mkdtempSync(join(tmpdir(), `tt-loadtest-ingest${i}-`));
	const nodePort = port + 1 + i;
	const proc = spawn(command[0], command.slice(1), {
		env: {
			...process.env,
			TYPETORCH_DATA_DIR: nodeDir,
			PORT: String(nodePort),
			TYPETORCH_API_KEY: INGEST,
			TYPETORCH_ADMIN_TOKEN: ADMIN,
			TYPETORCH_MEMORY_LIMIT: "200MB",
			TYPETORCH_THREADS: "1",
			TYPETORCH_IP_PER_MINUTE: "1000000",
			TYPETORCH_JOB_PER_MINUTE: "100000",
			TYPETORCH_ROLE: "ingest",
			TYPETORCH_MAIN_URL: base,
			TYPETORCH_INGEST_ROTATE_SECONDS: "2",
			...queue,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const node = { dir: nodeDir, base: `http://127.0.0.1:${nodePort}`, proc, log: "" };
	proc.stdout?.on("data", (d) => (node.log += d));
	proc.stderr?.on("data", (d) => (node.log += d));
	return node;
});
if (pinCpus > 0 && child.pid) {
	const mask = (1 << pinCpus) - 1;
	const { spawnSync } = await import("node:child_process");
	const pinned =
		process.platform === "win32"
			? spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).ProcessorAffinity = ${mask}`])
			: spawnSync("taskset", ["-p", mask.toString(16), String(child.pid)]);
	if (pinned.status !== 0) console.warn(`could not pin the server to ${pinCpus} cpu(s)`);
}
let log = "";
child.stdout?.on("data", (d) => (log += d));
child.stderr?.on("data", (d) => (log += d));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function health(): Promise<{ rssMb: number; analytics?: { loaderLagSeconds: number; pendingBytes: number; loadedRows: number; live: { events: number } }; queue?: { pendingFiles: number; pendingBytes: number } }> {
	return (await (await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as never;
}
async function nodeHealth(nodeBase: string): Promise<{ rssMb: number; queue?: { pendingFiles: number; pendingBytes: number; files: number; errors: number } }> {
	return (await (await fetch(`${nodeBase}/healthz`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as never;
}

async function analytics() {
	const rate = opt("rate", 1000);
	const batch = opt("batch", 250);
	const servers = 200;
	// Pre-built gzip bodies (the client shares this machine's CPU with the server).
	const now = Date.now();
	const bodies = Array.from({ length: 64 }, (_, b) => {
		const job = `job-${b % servers}`;
		const events = Array.from({ length: batch }, (_, i) => ({
			v: 1,
			t: now + i,
			kind: ["custom", "zone", "state", "tech", "funnel"][i % 5],
			name: ["quest_done", "enter", "screen", "client_perf", "onboarding"][i % 5],
			pid: `p${b}_${i % 40}`,
			sid: `s${b}_${i % 40}`,
			job,
			srv: "public",
			place: 1001,
			art: "a1b2c3d-1f2e3d",
			seq: 42,
			branch: "prod",
			channel: "prod",
			dev: "phone",
			newp: i % 7 === 0,
			state: `zone:Z${i % 6}|screen:|activity:round`,
			exp: '{"onboarding":"short"}',
			src: "server",
			props: JSON.stringify({ step: i % 5, fps: 58, label: "opened_shop", robux: 0 }),
		}));
		return gzipSync(JSON.stringify({ events }));
	});
	const requestsPerSecond = rate / batch;
	const latencies: number[] = [];
	let errors = 0;
	let sent = 0;
	let peakRss = 0;
	let peakLag = 0;
	let peakNodeRss = 0;
	let peakBucketFiles = 0;
	const inflight = new Set<Promise<void>>();
	const started = performance.now();
	const monitor = setInterval(async () => {
		try {
			const h = await health();
			peakRss = Math.max(peakRss, h.rssMb);
			peakLag = Math.max(peakLag, h.analytics?.loaderLagSeconds ?? 0);
			peakBucketFiles = Math.max(peakBucketFiles, h.queue?.pendingFiles ?? 0);
			for (const node of nodes) peakNodeRss = Math.max(peakNodeRss, (await nodeHealth(node.base)).rssMb);
		} catch {}
	}, 1000);
	while (performance.now() - started < seconds * 1000) {
		const due = Math.floor(((performance.now() - started) / 1000) * requestsPerSecond);
		while (sent < due) {
			const body = bodies[sent % bodies.length];
			sent++;
			const t0 = performance.now();
			const target = nodes.length ? nodes[sent % nodes.length].base : base;
			const p = fetch(`${target}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-encoding": "gzip" }, body })
				.then(async (r) => {
					await r.arrayBuffer();
					if (r.status !== 202) errors++;
					latencies.push(performance.now() - t0);
				})
				.catch(() => void errors++)
				.finally(() => inflight.delete(p));
			inflight.add(p);
		}
		await sleep(5);
	}
	await Promise.all(inflight);
	const stopAt = performance.now();
	let caughtUp = 0;
	for (let i = 0; i < 600; i++) {
		const h = await health();
		peakRss = Math.max(peakRss, h.rssMb);
		// With ingest nodes: caught up once nothing waits on a node, in the bucket or in the main server's raw files.
		let nodesPending = 0;
		for (const node of nodes) nodesPending += (await nodeHealth(node.base)).queue?.pendingBytes ?? 1;
		if ((h.analytics?.pendingBytes ?? 1) === 0 && nodesPending === 0 && (h.queue?.pendingFiles ?? 0) === 0 && (!nodes.length || (h.analytics?.live.events ?? 0) >= (sent - errors) * batch)) {
			caughtUp = (performance.now() - stopAt) / 1000;
			break;
		}
		await sleep(250);
	}
	clearInterval(monitor);
	const h = await health();
	const q0 = performance.now();
	const q = await fetch(`${base}/v1/query/overview`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}" });
	const overviewMs = performance.now() - q0;
	const f0 = performance.now();
	await fetch(`${base}/v1/query/flow`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ options: { facet: "zone" } }) });
	const flowMs = performance.now() - f0;
	return {
		mode,
		targetEventsPerSecond: rate,
		achievedEventsPerSecond: Math.round((sent * batch) / seconds),
		seconds,
		requests: sent,
		errors,
		batchEvents: batch,
		latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: percentile(latencies, 100) },
		peakRssMb: peakRss,
		peakLoaderLagSeconds: peakLag,
		catchUpSeconds: Math.round(caughtUp * 10) / 10,
		rowsLoaded: h.analytics?.loadedRows,
		liveRows: h.analytics?.live.events,
		queryMs: { overview: Math.round(overviewMs), flow: Math.round(flowMs), overviewStatus: q.status },
		...(nodes.length ? { ingestNodes: nodes.length, peakNodeRssMb: peakNodeRss, peakBucketFiles, bucketObjectsLeft: s3?.objects.size ?? 0 } : {}),
	};
}

async function fleet() {
	const count = opt("servers", 2500);
	const every = 30_000;
	const latencies: number[] = [];
	let errors = 0;
	let peakRss = 0;
	const heartbeat = (j: number, extra: object = {}) => ({ j: `job-${j}`, t: Date.now(), b: j % 10 === 0 ? "dev" : "prod", c: "prod", a: "a1b2c3d-1f2e3d", n: j % 30, m: 30, s: Date.now(), u: Date.now(), p: 1001, v: "0.3.2", q: 42, g: 3, h: "ok", sv: "640", ...extra });
	const post = async (path: string, body: object) => {
		const t0 = performance.now();
		try {
			const r = await fetch(`${base}/v1/fleet/${path}`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-type": "application/json" }, body: JSON.stringify(body) });
			await r.arrayBuffer();
			if (r.status !== 202) errors++;
		} catch {
			errors++;
		}
		latencies.push(performance.now() - t0);
	};
	const client = createFleetClient({ url: base, token: ADMIN, ingestToken: INGEST });
	// SSE latency: a watcher measures post -> event.
	const pending = new Map<string, number>();
	const sse: number[] = [];
	const stream = client.stream((e) => {
		if (e.type === "server" && pending.has(`${e.server.job}:${e.server.players}`)) {
			sse.push(performance.now() - (pending.get(`${e.server.job}:${e.server.players}`) as number));
		}
	});
	const started = performance.now();
	let sent = 0;
	const inflight = new Set<Promise<void>>();
	const toQuery: number[] = [];
	const readMs: number[] = [];
	let probe = 0;
	while (performance.now() - started < seconds * 1000) {
		const due = Math.floor(((performance.now() - started) / every) * count);
		while (sent < due) {
			const p = post("heartbeat", heartbeat(sent % count)).finally(() => inflight.delete(p));
			inflight.add(p);
			sent++;
		}
		// Every second: a changed heartbeat, then measure until the read shows it, plus the SSE event.
		if (performance.now() - started > (probe + 1) * 1000) {
			probe++;
			const j = probe % count;
			const players = 100 + probe;
			pending.set(`job-${j}:${players}`, performance.now());
			const t0 = performance.now();
			await post("heartbeat", heartbeat(j, { n: players }));
			const r0 = performance.now();
			const list = await client.servers();
			readMs.push(performance.now() - r0);
			if (list.servers.some((s) => s.job === `job-${j}` && s.players === players)) toQuery.push(performance.now() - t0);
			try {
				const h = await health();
				peakRss = Math.max(peakRss, h.rssMb);
			} catch {}
		}
		await sleep(5);
	}
	await Promise.all(inflight);
	stream.close();
	const list = await client.servers();
	return {
		mode,
		servers: count,
		heartbeatEverySeconds: every / 1000,
		seconds,
		heartbeats: sent,
		errors,
		heartbeatLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: percentile(latencies, 100) },
		heartbeatToQueryMs: { p50: percentile(toQuery, 50), p95: percentile(toQuery, 95), max: percentile(toQuery, 100) },
		heartbeatToSseMs: { p50: percentile(sse, 50), p95: percentile(sse, 95), max: percentile(sse, 100) },
		serversListMs: { p50: percentile(readMs, 50), p95: percentile(readMs, 95) },
		liveServersListed: list.servers.length,
		peakRssMb: peakRss,
	};
}

try {
	for (let i = 0; i < 150 && !log.includes("listening"); i++) await sleep(100);
	if (!log.includes("listening")) throw new Error(`the server didn't start:\n${log}`);
	for (const node of nodes) {
		for (let i = 0; i < 150 && !node.log.includes("listening"); i++) await sleep(100);
		if (!node.log.includes("listening")) throw new Error(`an ingest node didn't start:\n${node.log}`);
	}
	const result = mode === "fleet" ? await fleet() : await analytics();
	const machine = { serverCpus: pinCpus || cpus().length, cpus: cpus().length, cpu: cpus()[0]?.model, ramGb: Math.round(totalmem() / 1e9), os: process.platform, server: /\(((?:bun|node) [^)]+)\)/.exec(log)?.[1] ?? "?" };
	console.log(JSON.stringify({ ...result, machine }, null, 2));
} finally {
	child.kill();
	for (const node of nodes) node.proc.kill();
	await sleep(1000);
	s3?.stop();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
	for (const node of nodes) rmSync(node.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
