/**
 * `GET /v1/live` (admin): Server-Sent Events of what the bus carries, for the explorer.
 *
 *   ?topics=events,heartbeat,deploy,alert,error   (default: all)
 *
 * The hub is one bus subscriber (queued, so ingest never waits for it). High-rate topics are summed up and sent at most
 * once a second: `events` {batches, events, recordings, rejected, kinds} and `heartbeat` {servers: [...]}. The rare ones
 * go out at once: `deploy`, `alert`, `error`. Each browser has its own bounded buffer; when it is full its messages are
 * dropped and counted (stats), so a slow client costs memory for 64 small messages and nothing else.
 *
 *   event: hello      { at, topics }                   on connect
 *   event: events     { at, batches, events, recordings, rejected, kinds: { <kind>: n } }
 *   event: heartbeat  { at, servers: [{ job, branch, artifact, players, health, closing? }], more }
 *   event: deploy     { at, kind: "report" | "start", seq, branch, artifact, job?, result? }
 *   event: alert      { at, alert }
 *   event: error      { at, total, rejected, kinds: [{ fp, template, count, realm }] }
 */
import type { DeployMessage, HeartbeatMessage } from "../fleet/service.ts";
import { TOPICS, type BackendBus, type ErrorMessage, type EventsMessage, type Topic } from "./topics.ts";

const BUFFER = 64;

interface Client {
	topics: Set<Topic>;
	controller: ReadableStreamDefaultController<Uint8Array>;
	dropped: number;
	ping?: ReturnType<typeof setInterval>;
}

export interface LiveStats {
	clients: number;
	sent: number;
	/** Messages not sent because a browser's buffer was full. */
	dropped: number;
}

export interface LiveOptions {
	maxClients: number;
	clock?: () => number;
	flushMs?: number;
	pingSeconds?: number;
}

export class LiveHub {
	private readonly clients = new Set<Client>();
	private readonly encoder = new TextEncoder();
	private readonly clock: () => number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;
	private sent = 0;
	private dropped = 0;
	private events = { batches: 0, events: 0, recordings: 0, rejected: 0, kinds: new Map<string, number>() };
	private heartbeats = new Map<string, { job: string; branch: string | null; artifact: string | null; players: number | null; health: string | null; closing?: true }>();

	constructor(
		private readonly bus: BackendBus,
		private readonly options: LiveOptions,
	) {
		this.clock = options.clock ?? Date.now;
	}

	get stats(): LiveStats {
		return { clients: this.clients.size, sent: this.sent, dropped: this.dropped };
	}

	/** Subscribes to the bus and starts the once-a-second summaries. */
	start(): void {
		this.unsubscribe = this.bus.subscribe(
			"live",
			TOPICS,
			(topic, message) => {
				if (!this.clients.size) return;
				switch (topic) {
					case "events": {
						const m = message as EventsMessage;
						this.events.batches++;
						this.events.events += m.events.length;
						this.events.recordings += m.recordings.length;
						this.events.rejected += m.rejected;
						for (const e of m.events) this.events.kinds.set(e.kind, (this.events.kinds.get(e.kind) ?? 0) + 1);
						break;
					}
					case "heartbeat": {
						const m = message as HeartbeatMessage;
						const job = m.kind === "heartbeat" ? m.heartbeat.job : m.job;
						if (this.heartbeats.size < 5000 || this.heartbeats.has(job)) {
							const h = m.heartbeat;
							this.heartbeats.set(job, {
								job,
								branch: h?.branch ?? null,
								artifact: h?.artifact ?? null,
								players: h?.players ?? null,
								health: h?.health ?? null,
								...(m.kind === "closing" ? { closing: true as const } : {}),
							});
						}
						break;
					}
					case "deploy": {
						const m = message as DeployMessage;
						this.broadcast("deploy", {
							at: this.clock(),
							kind: m.kind,
							...(m.kind === "report"
								? { seq: m.report.seq, branch: m.report.branch, artifact: m.report.artifact, job: m.report.job, result: m.report.result }
								: m.kind === "mark"
									? { mark: m.mark.kind, seq: m.mark.seq, branch: m.mark.branch, artifact: m.mark.artifact, kernel: m.mark.kernel }
									: { seq: m.deploy.seq, branch: m.deploy.branch, artifact: m.deploy.artifact, ...(m.deploy.kind ? { release: m.deploy.kind } : {}) }),
						});
						break;
					}
					case "alert":
						this.broadcast("alert", { at: this.clock(), alert: message });
						break;
					case "error": {
						const m = message as ErrorMessage;
						this.broadcast("error", {
							at: this.clock(),
							total: m.total,
							rejected: m.rejected,
							kinds: m.items.slice(0, 10).map((i) => ({ fp: i.fp, template: i.template.slice(0, 200), count: i.count, realm: i.realm })),
						});
						break;
					}
				}
			},
			{ mode: "queue", maxQueue: 256, maxBytes: 4 * 1024 * 1024 },
		);
		this.timer = setInterval(() => this.flush(), this.options.flushMs ?? 1000);
		this.timer.unref?.();
	}

	stop(): void {
		this.unsubscribe?.();
		if (this.timer) clearInterval(this.timer);
		for (const client of [...this.clients]) this.close(client);
	}

	private flush(): void {
		if (!this.clients.size) {
			this.events = { batches: 0, events: 0, recordings: 0, rejected: 0, kinds: new Map() };
			this.heartbeats.clear();
			return;
		}
		const at = this.clock();
		if (this.events.batches) {
			this.broadcast("events", { at, batches: this.events.batches, events: this.events.events, recordings: this.events.recordings, rejected: this.events.rejected, kinds: Object.fromEntries(this.events.kinds) });
			this.events = { batches: 0, events: 0, recordings: 0, rejected: 0, kinds: new Map() };
		}
		if (this.heartbeats.size) {
			const all = [...this.heartbeats.values()];
			this.broadcast("heartbeat", { at, servers: all.slice(0, 100), more: Math.max(0, all.length - 100) });
			this.heartbeats.clear();
		}
	}

	private write(client: Client, chunk: string): void {
		if ((client.controller.desiredSize ?? 1) <= 0) {
			client.dropped++;
			this.dropped++;
			return;
		}
		try {
			client.controller.enqueue(this.encoder.encode(chunk));
			this.sent++;
		} catch {
			this.close(client);
		}
	}

	private broadcast(event: Topic, data: unknown): void {
		if (!this.clients.size) return;
		const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of this.clients) if (client.topics.has(event)) this.write(client, chunk);
	}

	private close(client: Client): void {
		this.clients.delete(client);
		if (client.ping) clearInterval(client.ping);
		try {
			client.controller.close();
		} catch {}
	}

	/**
	 * The SSE response for a signed-in request. `keepOpen` switches off the connection's idle timeout; `stillAllowed` is
	 * asked on every ping and closes the stream once it says no (a revoked token or session, a role no longer held).
	 */
	connect(req: Request, url: URL, keepOpen?: () => void, stillAllowed?: () => boolean): Response {
		if (this.clients.size >= this.options.maxClients) {
			return new Response(JSON.stringify({ error: "too many live streams open" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10", "cache-control": "no-store" } });
		}
		const asked = (url.searchParams.get("topics") ?? "").split(",").filter(Boolean);
		const unknown = asked.filter((t) => !(TOPICS as readonly string[]).includes(t));
		if (unknown.length) return new Response(JSON.stringify({ error: `unknown topic ${JSON.stringify(unknown[0])}; topics are ${TOPICS.join(", ")}` }), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } });
		const topics = new Set<Topic>(asked.length ? (asked as Topic[]) : TOPICS);
		keepOpen?.();
		let client: Client | undefined;
		const body = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					client = { topics, controller, dropped: 0 };
					this.clients.add(client);
					this.write(client, `event: hello\ndata: ${JSON.stringify({ at: this.clock(), topics: [...topics] })}\n\n`);
					client.ping = setInterval(() => {
						let allowed = true;
						try {
							allowed = stillAllowed?.() ?? true;
						} catch {
							allowed = false;
						}
						if (!allowed) {
							if (client) this.close(client);
							return;
						}
						try {
							controller.enqueue(this.encoder.encode(": ping\n\n"));
						} catch {
							if (client) this.close(client);
						}
					}, (this.options.pingSeconds ?? 15) * 1000);
					req.signal.addEventListener("abort", () => client && this.close(client));
				},
				cancel: () => {
					if (client) this.close(client);
				},
			},
			new CountQueuingStrategy({ highWaterMark: BUFFER }),
		);
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
	}
}
