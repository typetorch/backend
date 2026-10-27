/** The machine-readable docs: GET /openapi.json, /docs, /llms.txt (src/server/openapi.ts). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FLEET_LIMITS } from "../src/fleet/http.ts";
import { QUERY_NAMES } from "../src/queries/index.ts";
import { openApiSpec } from "../src/server/openapi.ts";
import { asJson, harness, type Harness } from "./harness.ts";

type Spec = { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, { operationId: string; security: unknown[]; "x-roles": string[] }>> };

describe("openapi", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	test("every path literal the router answers is in the spec", () => {
		const spec = openApiSpec() as unknown as Spec;
		const patterns = Object.keys(spec.paths).map((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, "[^/]+")}$`));
		const app = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");
		const literals = [...app.matchAll(/path === "(\/[^"]+)"/g)].map((m) => m[1] as string);
		literals.push(...[...app.matchAll(/path === `\$\{CENTRAL_PATH\}(\/[^`]+)`/g)].map((m) => `/auth/typetorch${m[1]}`));
		literals.push(...Object.keys(FLEET_LIMITS).map((k) => `/v1/fleet/${k}`));
		expect(literals.length).toBeGreaterThan(40);
		const missing = [...new Set(literals)].filter((l) => !patterns.some((re) => re.test(l)));
		expect(missing).toEqual([]);
	});

	test("the spec: unique operation ids, security per role, the query names", () => {
		const spec = openApiSpec() as unknown as Spec;
		expect(spec.openapi).toBe("3.1.0");
		const ops = Object.values(spec.paths).flatMap((m) => Object.values(m));
		const ids = ops.map((o) => o.operationId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(spec.paths["/healthz"]?.get?.security).toEqual([]);
		expect(spec.paths["/v1/ingest"]?.post?.security).toEqual([{ apiKey: [] }]);
		expect(spec.paths["/v1/identity/resolve"]?.get?.security).toEqual([{ adminToken: [] }, { session: [] }, { lookupToken: [] }]);
		expect(spec.paths["/v1/access"]?.put?.security).toEqual([{ adminToken: [] }]);
		const query = spec.paths["/v1/query/{name}"]?.post as unknown as { parameters: { schema: { enum: string[] } }[] };
		expect(query.parameters[0]?.schema.enum).toEqual(QUERY_NAMES);
	});

	test("GET /openapi.json, open; the server is relative, /api under the explorer's prefix", async () => {
		const res = await h.call("/openapi.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("application/json");
		const spec = (await asJson(res)) as Spec;
		expect(spec.servers).toEqual([{ url: "/" }]);
		expect(Object.keys(spec.paths)).toContain("/v1/fleet/servers");
		const prefixed = (await asJson(await h.call("/api/openapi.json"))) as Spec;
		expect(prefixed.servers).toEqual([{ url: "/api" }]);
		expect((await h.call("/openapi.json", { method: "POST" })).status).toBe(405);
	});

	test("GET /docs: Swagger UI pinned with SRI, its own CSP; the init script from this origin", async () => {
		const res = await h.call("/docs");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/html");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("script-src 'self' https://cdn.jsdelivr.net");
		expect(csp).toContain("frame-ancestors 'none'");
		const html = await res.text();
		expect(html).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js" integrity="sha384-/);
		expect(html).toContain('src="docs/swagger-init.js"');
		const init = await h.call("/docs/swagger-init.js");
		expect(init.status).toBe(200);
		expect(init.headers.get("content-type")).toStartWith("text/javascript");
		expect(await init.text()).toContain('url: "openapi.json"');
	});

	test("GET /llms.txt: what the server is and where the docs are", async () => {
		const res = await h.call("/llms.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/markdown");
		const text = await res.text();
		expect(text).toStartWith("# TypeTorch backend\n\n> ");
		expect(text).toContain("](/openapi.json)");
		expect(text).toContain("https://github.com/typetorch/backend");
		expect(text).toContain("https://github.com/typetorch/docs");
	});

	test("absolute links with TYPETORCH_PUBLIC_URL; 404 outside the admin allow list", async () => {
		const other = await harness({ TYPETORCH_PUBLIC_URL: "https://backend.example.com", TYPETORCH_ADMIN_ALLOW_IPS: "127.0.0.1" });
		try {
			expect(((await asJson(await other.call("/openapi.json"))) as Spec).servers).toEqual([{ url: "https://backend.example.com" }]);
			expect(await (await other.call("/llms.txt")).text()).toContain("(https://backend.example.com/openapi.json)");
			for (const path of ["/openapi.json", "/docs", "/llms.txt"]) expect((await other.call(path, { ip: "203.0.113.9" })).status).toBe(404);
		} finally {
			await other.close();
		}
	});
});
