// @vitest-environment jsdom
/**
 * Render smoke test: the real explorer (web/src/main.tsx, unchanged, with its own router) mounted in jsdom over the demo's
 * mock backend (Node DuckDB engine), visiting every route and tab. For each page it records every /api answer that was
 * not 2xx, console errors, unhandled rejections, the error boundary / ErrorState texts and skeletons left after the page
 * settles. jsdom can't run WebGL (the map canvases): those components render their "no WebGL" fallback, which is fine.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { pack } from "../mock/pack";
import { MockEventSource, setLatency } from "../mock/router";
import { setClock } from "../mock/data";
import { describeWithPack, mockFetch, setupDemo, teardownDemo, TEST_NOW, testApi } from "./harness";

interface Problem {
	route: string;
	kind: string;
	detail: string;
}

const problems: Problem[] = [];
let current = "(boot)";
let inflight = 0;
const pending = new Map<number, string>();
let reqId = 0;
const REPORT = process.env.DEMO_PAGES_REPORT;
async function log(line: string): Promise<void> {
	if (!REPORT) return;
	const { appendFileSync } = await import("node:fs");
	appendFileSync(REPORT, `${line}\n`);
}
let lastActivity = 0;
const consoleErrors: string[] = [];

function note(kind: string, detail: string) {
	problems.push({ route: current, kind, detail: detail.slice(0, 400) });
}

const countingFetch: typeof fetch = async (input, init) => {
	inflight++;
	lastActivity = performance.now();
	const url = String(input instanceof Request ? input.url : input);
	const method = init?.method ?? "GET";
	const id = ++reqId;
	pending.set(id, `${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
	try {
		const res = await mockFetch(input, init);
		if (!res.ok && res.status !== 304) {
			const body = await res.clone().text();
			note(`http ${res.status}`, `${method} ${url.replace(/^https?:\/\/[^/]+/, "")} -> ${body}`);
		}
		return res;
	} catch (error) {
		if ((error as Error).name !== "AbortError") note("fetch threw", `${method} ${url}: ${(error as Error).message}`);
		throw error;
	} finally {
		pending.delete(id);
		inflight--;
		lastActivity = performance.now();
	}
};

async function settle(minMs = 1200, quietMs = 600, maxMs = 15_000): Promise<void> {
	const start = performance.now();
	await new Promise((r) => setTimeout(r, minMs));
	for (;;) {
		const t = performance.now();
		if (inflight === 0 && t - lastActivity >= quietMs) return;
		if (t - start > maxMs) {
			note("timeout", `not quiet after ${maxMs} ms; in flight: ${[...pending.values()].join(", ")}`);
			return;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function visit(path: string): Promise<string> {
	current = path;
	window.history.pushState({}, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
	await settle();
	const root = document.getElementById("root") as HTMLElement;
	// The page, plus what it opened in portals (sheets, dialogs, popovers): everything in <body> but the banner and the app shell's sidebar.
	const portals = Array.from(document.body.children).filter((el) => el.id !== "root" && el.id !== "demo-banner");
	const scopes = [root.querySelector("main") ?? root, ...portals];
	const text = scopes.map((el) => el.textContent ?? "").join("\n");
	if ((root.textContent ?? "").includes("This page failed to render")) note("error boundary", (root.textContent ?? "").slice(0, 300));
	if (!(root.querySelector("main")?.textContent ?? "").trim()) note("no main content", (root.textContent ?? "").slice(0, 200));
	for (const scope of [root, ...portals])
		for (const el of Array.from(scope.querySelectorAll('[role="alert"]'))) {
			const t = el.textContent ?? "";
			if (/Could not load|failed|error/i.test(t)) note("alert", t);
		}
	const skeletons = scopes.reduce((n, el) => n + el.querySelectorAll('[data-slot="skeleton"]').length, 0);
	if (skeletons) note("skeletons left", String(skeletons));
	for (const m of text.match(/(No [^.\n]{0,80}?(yet|in (this|the) (range|window)|for these filters)[^.\n]{0,40}\.?|Nothing [^.\n]{0,60})/g) ?? []) note("empty-ish", m);
	if (/not in the demo/.test(text)) note("not in demo text", text.slice(Math.max(0, text.indexOf("not in the demo") - 100), text.indexOf("not in the demo") + 50));
	for (const e of consoleErrors.splice(0)) note("console.error", e);
	return text;
}

describeWithPack("every page renders on the mock backend", () => {
	let job = "";
	let deadJob = "";
	let seq = 0;
	let pid = "";
	let fp = "";
	beforeAll(async () => {
		await setupDemo({ engine: true });
		vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: TEST_NOW });
		setClock(() => Date.now());
		setLatency(0);
		const g = globalThis as Record<string, unknown>;
		g.ResizeObserver ??= class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
		g.IntersectionObserver ??= class {
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		};
		window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
		Element.prototype.scrollIntoView ??= () => {};
		HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
		window.URL.createObjectURL ??= () => "blob:demo";
		globalThis.fetch = countingFetch;
		globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
		const realError = console.error;
		console.error = (...args: unknown[]) => {
			consoleErrors.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack?.split("\n").slice(1, 4).join("\n")}` : String(a))).join(" "));
			void realError;
		};
		process.on("unhandledRejection", (reason) => note("unhandled rejection", String((reason as Error)?.stack ?? reason)));

		const api = testApi();
		const servers = await api.fleetServers();
		job = servers.servers[0]?.job ?? "";
		const gone = await api.fleetGoneServers();
		deadJob = gone[0]?.job ?? "";
		const deploys = await api.fleetDeploys({});
		seq = deploys.deploys[0]?.seq ?? 0;
		const p = await pack();
		pid = [...p.players].sort((a, b) => b.events - a.events)[0]?.pid ?? "";
		const errors = await api.errors({ window: "7d" });
		fp = errors.kinds[0]?.fp ?? "";

		document.body.innerHTML = '<div id="demo-banner"></div><div id="root"></div>';
		window.history.replaceState({}, "", "/");
		const { mountBanner } = await import("../banner");
		mountBanner(document.getElementById("demo-banner") as HTMLElement);
		await import("@/main");
		await settle(2000);
	}, 180_000);

	afterAll(() => {
		vi.useRealTimers();
		teardownDemo();
	});

	it("visits every route and tab", async () => {
		expect(job && seq && pid && fp).toBeTruthy();
		const routes = [
			"/",
			"/?range=30d",
			"/?range=1d",
			"/?range=1h",
			"/?range=7d&dev=phone",
			"/?range=7d&players=new",
			"/roblox",
			"/economy",
			"/monetization",
			"/notifications",
			"/notifications?tab=funnel",
			"/notifications?tab=inbox",
			"/notifications?tab=subscribers",
			"/notifications?tab=kinds",
			"/notifications?tab=queue",
			"/notifications?tab=settings",
			"/feedback",
			"/retention",
			"/retention?view=revenue",
			"/demographics",
			"/funnels",
			"/funnels?compare=1",
			"/players",
			`/players?pid=${encodeURIComponent(pid)}`,
			"/flow",
			"/experiments",
			"/experiments?experiment=one_tap_play",
			"/experiments?experiment=tutorial_ui",
			"/?exp=one_tap_play&variant=one_tap",
			"/live-events",
			"/first-session",
			"/recordings",
			"/recordings?tab=replay",
			"/recordings?tab=autopsy",
			"/recordings?tab=first",
			"/maps",
			"/events",
			`/events?pid=${encodeURIComponent(pid)}`,
			"/fleet",
			"/fleet?branch=dev",
			"/live",
			"/deploys",
			`/deploys/${seq}`,
			"/deploys/217",
			"/performance",
			`/performance?job=${encodeURIComponent(job)}`,
			...["status", "logs", "players", "game", "map", "state", "dex", "modules", "builds", "budget", "errors", "network", "audit"].map((t) => `/servers/${encodeURIComponent(job)}?tab=${t}`),
			...(deadJob ? [`/servers/${encodeURIComponent(deadJob)}`] : []),
			"/errors",
			"/errors?window=7d",
			`/errors?window=7d&fp=${encodeURIComponent(fp)}`,
			"/query",
			"/query?tab=sql",
			"/query?q=retention",
			"/settings",
			"/backend",
			"/audit",
			"/nope",
		];
		const pages: Record<string, number> = {};
		for (const r of routes) {
			const before = problems.length;
			const started = performance.now();
			const text = await visit(r);
			pages[r] = text.length;
			await log(`${r}  ${Math.round(performance.now() - started)} ms, ${text.length} chars: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
			for (const p of problems.slice(before)) await log(`   ${p.kind}: ${p.detail.replace(/\n/g, " | ")}`);
		}
		// jsdom has no WebGL: the map canvases log that and show their fallback.
		const serious = problems.filter((p) => !["empty-ish", "skeletons left"].includes(p.kind) && !/Error creating WebGL context/.test(p.detail));
		expect(serious).toEqual([]);
	}, 900_000);
});
