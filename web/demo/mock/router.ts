/**
 * The demo's backend: answers the explorer's same-origin /api/* requests in the browser.
 *
 * Handlers register per method and path pattern (the path after /api), one file per API domain (web/demo/mock/<domain>.ts):
 *
 *   route<FleetServers>("GET", "/v1/fleet/servers", async (req) => ({ servers: [...], players: 12 }));
 *   route<{ query: SavedQuery }>("PATCH", "/v1/saved-queries/:id", (req) => { ...; return { query } });
 *   route("DELETE", "/v1/things/:id", () => fail(404, "no such thing"));
 *   stream("/v1/fleet/stream", (req, sink) => { sink.send("hello", { at }); const t = setInterval(...); return () => clearInterval(t); });
 *
 * A handler gets a MockRequest (params, query, parsed JSON body) and returns the JSON body (status 200), or a Response for
 * anything else (json(201, body), fail(400, "message"), binary). Throwing HttpError(status, message) answers
 * { error: message } like the backend; any other throw answers 500 { error: "demo handler failed", detail }.
 *
 * Patterns: literal segments, `:name` (one segment, URL-decoded into params.name) and a final `*` (the rest, params["*"]).
 * The most literal pattern wins, so "/v1/maps/export" beats "/v1/maps/:name". A path that matches a pattern but not the
 * method answers 405; an /api path nobody handles answers 404 { error: "not in the demo" } and warns once in the console.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface MockRequest<B = unknown> {
	method: Method;
	/** The path after /api (no query string), e.g. "/v1/fleet/servers/abc". */
	path: string;
	url: URL;
	query: URLSearchParams;
	/** `:name` segments of the pattern, decoded. */
	params: Record<string, string>;
	headers: Headers;
	/** The JSON body parsed (undefined when there is none or it isn't JSON; see `text`). */
	body: B;
	text: string;
	signal?: AbortSignal | undefined;
}

export type Handler<T = unknown> = (req: MockRequest) => T | Response | Promise<T | Response>;

export interface StreamSink {
	/** A named SSE event (`event: <name>`); data is JSON-encoded like the backend's. */
	send(event: string, data: unknown): void;
	/** An unnamed event (EventSource's "message"). */
	message(data: unknown): void;
	/** Ends the stream (the page sees an error and CLOSED, as when the backend goes away). */
	close(): void;
	/** False once the page closed it. */
	readonly open: boolean;
}

/** Runs while the stream is open; return a cleanup (stop timers). */
export type StreamHandler = (req: MockRequest, sink: StreamSink) => void | (() => void);

export class HttpError extends Error {
	override name = "HttpError";
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

/** A JSON answer with a status (and headers). */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** The backend's error shape: { error, ...extra } (extra: detail, login, placeVersion...). */
export function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
	return json(status, { error, ...extra });
}

export const NOT_IN_DEMO = "not in the demo";

// Registry ---------------------------------------------------------------------------------------------------------------

interface Compiled {
	pattern: string;
	parts: string[];
	rest: boolean;
	score: number;
}

interface RouteEntry extends Compiled {
	method: Method;
	handler: Handler;
}

interface StreamEntry extends Compiled {
	handler: StreamHandler;
}

const routes: RouteEntry[] = [];
const streams: StreamEntry[] = [];

function compile(pattern: string): Compiled {
	if (!pattern.startsWith("/")) throw new Error(`demo route pattern must start with /: ${pattern}`);
	const parts = pattern.split("/").slice(1);
	const rest = parts[parts.length - 1] === "*";
	if (rest) parts.pop();
	// Literal segments count most, then params; a rest wildcard least.
	const score = parts.reduce((s, p) => s + (p.startsWith(":") ? 1 : 3), 0) * 2 - (rest ? 1 : 0);
	return { pattern, parts, rest, score };
}

function match(c: Compiled, segments: string[]): Record<string, string> | undefined {
	if (c.rest ? segments.length < c.parts.length : segments.length !== c.parts.length) return undefined;
	const params: Record<string, string> = {};
	for (let i = 0; i < c.parts.length; i++) {
		const p = c.parts[i] as string;
		const s = segments[i] as string;
		if (p.startsWith(":")) {
			if (s === "") return undefined;
			try {
				params[p.slice(1)] = decodeURIComponent(s);
			} catch {
				return undefined;
			}
		} else if (p !== s) return undefined;
	}
	if (c.rest) params["*"] = segments.slice(c.parts.length).join("/");
	return params;
}

/** Registers a handler. T is the answer's JSON type (from web/src/lib/types.ts), so tsc catches shape drift. */
export function route<T = unknown>(method: Method | Method[], pattern: string, handler: Handler<T>): void {
	for (const m of Array.isArray(method) ? method : [method]) {
		if (routes.some((r) => r.method === m && r.pattern === pattern)) throw new Error(`demo route ${m} ${pattern} is registered twice`);
		routes.push({ ...compile(pattern), method: m, handler: handler as Handler });
	}
	routes.sort((a, b) => b.score - a.score);
}

/** Registers an EventSource stream under /api (e.g. "/v1/live", "/v1/fleet/stream"). */
export function stream(pattern: string, handler: StreamHandler): void {
	if (streams.some((s) => s.pattern === pattern)) throw new Error(`demo stream ${pattern} is registered twice`);
	streams.push({ ...compile(pattern), handler });
	streams.sort((a, b) => b.score - a.score);
}

/** Every registered route (tests, the inventory check). */
export function registeredRoutes(): { method: Method; pattern: string }[] {
	return routes.map((r) => ({ method: r.method, pattern: r.pattern }));
}

export function registeredStreams(): string[] {
	return streams.map((s) => s.pattern);
}

// Latency ----------------------------------------------------------------------------------------------------------------

let latency: [number, number] = [50, 250];

/** Artificial answer time in ms (default 50-250; tests set [0, 0]). */
export function setLatency(min: number, max = min): void {
	latency = [min, max];
}

function wait(signal?: AbortSignal | null): Promise<void> {
	const [min, max] = latency;
	const ms = min + Math.random() * (max - min);
	if (ms <= 0) return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve();
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(): Error {
	try {
		return new DOMException("The operation was aborted.", "AbortError");
	} catch {
		const e = new Error("The operation was aborted.");
		e.name = "AbortError";
		return e;
	}
}

// Dispatch ---------------------------------------------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(message);
}

/** The base the demo resolves relative URLs against (the page in a browser, a stand-in origin in tests). */
function origin(): string {
	try {
		if (typeof location !== "undefined" && location.origin && location.origin !== "null") return location.origin;
	} catch {
		// no location
	}
	return "http://demo.localhost";
}

/** The /api path of a URL on this origin, or undefined when the request isn't ours (other origins, static files). */
export function apiPath(url: URL): string | undefined {
	if (url.origin !== origin()) return undefined;
	if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return url.pathname.slice(4) || "/";
	return undefined;
}

function toUrl(input: RequestInfo | URL): URL {
	if (input instanceof URL) return new URL(input.href);
	if (typeof input === "string") return new URL(input, origin());
	return new URL(input.url, origin());
}

async function bodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Blob) return body.text();
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBuffer);
	if (body === undefined || body === null) {
		if (typeof Request !== "undefined" && input instanceof Request) return input.clone().text();
		return "";
	}
	return String(body);
}

/** Answers one /api request through the handlers (no latency). Exposed for tests and for handlers that call each other. */
export async function dispatch(method: string, url: URL, init: { headers?: HeadersInit; text?: string; signal?: AbortSignal | null } = {}): Promise<Response> {
	const path = apiPath(url) ?? url.pathname;
	const segments = path.split("/").slice(1);
	const upper = method.toUpperCase() as Method;
	let entry: RouteEntry | undefined;
	let params: Record<string, string> | undefined;
	const allowed = new Set<string>();
	for (const r of routes) {
		const p = match(r, segments);
		if (!p) continue;
		allowed.add(r.method);
		if (!entry && r.method === upper) {
			entry = r;
			params = p;
		}
	}
	if (!entry || !params) {
		if (allowed.size) return fail(405, `${[...allowed].join(" or ")} only`);
		warnOnce(`${upper} ${path}`, `[demo] no mock for ${upper} /api${path}: answering 404 "${NOT_IN_DEMO}"`);
		return fail(404, NOT_IN_DEMO);
	}
	const text = init.text ?? "";
	let body: unknown = undefined;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
	}
	const req: MockRequest = { method: upper, path, url, query: url.searchParams, params, headers: new Headers(init.headers), body, text, signal: init.signal ?? undefined };
	try {
		const answer = await entry.handler(req);
		if (answer instanceof Response) return answer;
		if (answer === undefined) return fail(500, "demo handler answered nothing", { detail: `${upper} ${entry.pattern}` });
		return json(200, answer);
	} catch (error) {
		if (error instanceof HttpError) return fail(error.status, error.message, error.extra);
		if (error instanceof Error && error.name === "AbortError") throw error;
		console.error(`[demo] ${upper} /api${path} failed`, error);
		return fail(500, "demo handler failed", { detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
	}
}

/**
 * A fetch that answers /api/* on this origin from the handlers (with the artificial latency) and passes everything else to
 * `passThrough` (the real fetch).
 */
export function createMockFetch(passThrough: typeof fetch = (...args) => fetch(...args)): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = toUrl(input);
		if (apiPath(url) === undefined) return passThrough(input, init);
		const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
		const method = init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
		const headers = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
		const text = await bodyText(input, init);
		await wait(signal);
		const response = await dispatch(method, url, { ...(headers ? { headers } : {}), text, signal: signal ?? null });
		if (signal?.aborted) throw abortError();
		return response;
	};
}

// EventSource ------------------------------------------------------------------------------------------------------------

type Listener = (event: Event) => void;

/** An EventSource for /api/* stream URLs, fed by the registered stream handlers on timers. */
export class MockEventSource extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSED = 2;
	readonly url: string;
	readonly withCredentials: boolean;
	readyState = 0;
	onopen: Listener | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: Listener | null = null;
	private cleanup: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(url: string | URL, init?: EventSourceInit) {
		super();
		const full = new URL(String(url), origin());
		this.url = full.href;
		this.withCredentials = init?.withCredentials ?? false;
		const path = apiPath(full) ?? full.pathname;
		const segments = path.split("/").slice(1);
		let found: StreamEntry | undefined;
		let params: Record<string, string> | undefined;
		for (const s of streams) {
			params = match(s, segments);
			if (params) {
				found = s;
				break;
			}
		}
		const [min, max] = latency;
		this.timer = setTimeout(
			() => {
				if (this.readyState === 2) return;
				if (!found || !params) {
					warnOnce(`SSE ${path}`, `[demo] no mock stream for /api${path}: the page sees it as down`);
					this.readyState = 2;
					this.fire(new Event("error"));
					return;
				}
				this.readyState = 1;
				this.fire(new Event("open"));
				const req: MockRequest = { method: "GET", path, url: full, query: full.searchParams, params, headers: new Headers(), body: undefined, text: "" };
				const self = this;
				const sink: StreamSink = {
					send: (event, data) => self.emit(event, data),
					message: (data) => self.emit("message", data),
					close: () => {
						self.stop();
						self.fire(new Event("error"));
					},
					get open() {
						return self.readyState !== 2;
					},
				};
				try {
					const done = found.handler(req, sink);
					if (typeof done === "function") this.cleanup = done;
				} catch (error) {
					console.error(`[demo] stream /api${path} failed`, error);
				}
			},
			min + Math.random() * (max - min),
		);
	}

	private emit(event: string, data: unknown): void {
		if (this.readyState !== 1) return;
		const e = new MessageEvent(event, { data: typeof data === "string" ? data : JSON.stringify(data), origin: origin() });
		this.fire(e);
	}

	private fire(event: Event): void {
		this.dispatchEvent(event);
		if (event.type === "open") this.onopen?.(event);
		else if (event.type === "error") this.onerror?.(event);
		else if (event.type === "message") this.onmessage?.(event as MessageEvent);
	}

	private stop(): void {
		this.readyState = 2;
		clearTimeout(this.timer);
		const c = this.cleanup;
		this.cleanup = undefined;
		try {
			c?.();
		} catch {
			// ignore
		}
	}

	close(): void {
		this.stop();
	}
}

// Install ----------------------------------------------------------------------------------------------------------------

let installed = false;

/** Replaces window.fetch and EventSource (call before the app loads). Other URLs go to the real ones. */
export function installInterceptors(): void {
	if (installed) return;
	installed = true;
	const realFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = createMockFetch(realFetch);
	const RealEventSource = globalThis.EventSource;
	const Patched = function (this: unknown, url: string | URL, init?: EventSourceInit) {
		const full = new URL(String(url), origin());
		if (apiPath(full) !== undefined || !RealEventSource) return new MockEventSource(url, init);
		return new RealEventSource(url, init);
	} as unknown as typeof EventSource;
	Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
	(Patched as unknown as { prototype: unknown }).prototype = (RealEventSource ?? MockEventSource).prototype;
	globalThis.EventSource = Patched;
}
