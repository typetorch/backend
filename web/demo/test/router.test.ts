/** The mock router itself: patterns, params, bodies, errors, 404 / 405, EventSource. No data pack needed. */
import { beforeAll, describe, expect, it } from "vitest";
import { dispatch, fail, HttpError, MockEventSource, route, stream } from "../mock/router";
import { mockFetch, setupDemo } from "./harness";

const url = (path: string) => new URL(`http://demo.localhost/api${path}`);

describe("mock router", () => {
	beforeAll(async () => {
		await setupDemo();
		route<{ id: string; q: string | null; body: unknown }>("POST", "/v1/__test/items/:id", (req) => ({ id: req.params.id as string, q: req.query.get("q"), body: req.body }));
		route("GET", "/v1/__test/items/special", () => ({ special: true }));
		route("GET", "/v1/__test/items/:id", () => ({ special: false }));
		route("GET", "/v1/__test/boom", () => {
			throw new HttpError(409, "busy", { retry: 3 });
		});
		route("GET", "/v1/__test/fail", () => fail(418, "teapot"));
		route("GET", "/v1/__test/files/*", (req) => ({ rest: req.params["*"] }));
		stream("/v1/__test/stream", (_req, sink) => {
			sink.send("hello", { at: 1 });
			sink.send("tick", { n: 1 });
		});
	});

	it("matches params, query strings and JSON bodies", async () => {
		const r = await mockFetch("/api/v1/__test/items/a%20b?q=1", { method: "POST", body: JSON.stringify({ x: 1 }) });
		expect(await r.json()).toEqual({ id: "a b", q: "1", body: { x: 1 } });
	});

	it("prefers literal segments", async () => {
		expect(await (await dispatch("GET", url("/v1/__test/items/special"))).json()).toEqual({ special: true });
		expect(await (await dispatch("GET", url("/v1/__test/items/other"))).json()).toEqual({ special: false });
		expect(await (await dispatch("GET", url("/v1/__test/files/a/b.txt"))).json()).toEqual({ rest: "a/b.txt" });
	});

	it("answers errors in the backend's shape", async () => {
		const boom = await dispatch("GET", url("/v1/__test/boom"));
		expect(boom.status).toBe(409);
		expect(await boom.json()).toEqual({ error: "busy", retry: 3 });
		expect((await dispatch("GET", url("/v1/__test/fail"))).status).toBe(418);
		const wrong = await dispatch("DELETE", url("/v1/__test/boom"));
		expect(wrong.status).toBe(405);
		const missing = await dispatch("GET", url("/v1/__test/nothing-here"));
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "not in the demo" });
	});

	it("leaves other URLs to the real fetch", async () => {
		await expect(mockFetch("https://example.com/x")).rejects.toThrow(/network/);
		await expect(mockFetch("/data/manifest.json")).rejects.toThrow(/network/);
	});

	it("aborts like fetch", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(mockFetch("/api/v1/auth/check", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	});

	it("streams named events to an EventSource", async () => {
		const source = new MockEventSource("/api/v1/__test/stream");
		const got: string[] = [];
		await new Promise<void>((resolve) => {
			source.addEventListener("hello", (e) => got.push(`hello ${(e as MessageEvent).data}`));
			source.addEventListener("tick", (e) => {
				got.push(`tick ${(e as MessageEvent).data}`);
				resolve();
			});
		});
		expect(source.readyState).toBe(1);
		source.close();
		expect(source.readyState).toBe(2);
		expect(got).toEqual(['hello {"at":1}', 'tick {"n":1}']);
	});
});
