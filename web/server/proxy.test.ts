import { describe, expect, it } from "vitest";
import { assertSafeTarget, guardRequest, parseEnvFile, resolveTarget } from "./proxy";

const same = { host: "localhost:5173", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const TOKEN = "fake-admin-token-for-the-explorer-tests-0123456789";

/** A fake disk: path -> text; anything else throws like a missing file. */
const disk = (files: Record<string, string>) => (path: string) => {
	const hit = Object.entries(files).find(([name]) => path.replace(/\\/g, "/").endsWith(name));
	if (!hit) throw new Error(`ENOENT ${path}`);
	return hit[1];
};

describe("explorer proxy target", () => {
	it("parses env files like the backend does", () => {
		const file = '# comment\nTYPETORCH_API_KEY=abc\nTYPETORCH_ADMIN_TOKEN="quoted token"\nexport OTHER=1 # trailing\n';
		expect(parseEnvFile(file)).toEqual({ TYPETORCH_API_KEY: "abc", TYPETORCH_ADMIN_TOKEN: "quoted token", OTHER: "1" });
	});

	it("reads the admin token from the game's .env and the URL from its typetorch.json (backend.url, else fleet.url)", () => {
		const files = disk({
			"/game/.env": `OPENCLOUD_API_KEY=unrelated\nTYPETORCH_ADMIN_TOKEN=${TOKEN}\n`,
			"/game/typetorch.json": JSON.stringify({ backend: { url: "https://backend.example.com/" } }),
		});
		const target = resolveTarget({ TYPETORCH_GAME_DIR: "/game" }, files);
		expect(target.url).toBe("https://backend.example.com");
		expect(target.token).toBe(TOKEN);
		expect(target.source).toContain("typetorch.json");
		expect(target.source).not.toContain(TOKEN);
		const old = resolveTarget({ TYPETORCH_GAME_DIR: "/game" }, disk({ "/game/.env": `TYPETORCH_ADMIN_TOKEN=${TOKEN}`, "/game/typetorch.json": '{"fleet":{"url":"https://fleet.example.com"}}' }));
		expect(old.url).toBe("https://fleet.example.com");
	});

	it("the environment wins: TYPETORCH_ADMIN_TOKEN, TYPETORCH_BACKEND_URL, TYPETORCH_ENV_FILE", () => {
		const files = disk({ "/game/.env": "TYPETORCH_ADMIN_TOKEN=from-file", "/other.env": "TYPETORCH_ADMIN_TOKEN=from-other-file", "/game/typetorch.json": '{"backend":{"url":"https://a.example.com"}}' });
		expect(resolveTarget({ TYPETORCH_GAME_DIR: "/game", TYPETORCH_ADMIN_TOKEN: "from-env" }, files).token).toBe("from-env");
		expect(resolveTarget({ TYPETORCH_GAME_DIR: "/game", TYPETORCH_BACKEND_URL: "http://127.0.0.1:9000" }, files).url).toBe("http://127.0.0.1:9000");
		expect(resolveTarget({ TYPETORCH_GAME_DIR: "/game", TYPETORCH_ENV_FILE: "/other.env" }, files).token).toBe("from-other-file");
		expect(resolveTarget({ TYPETORCH_ENV_FILE: "/other.env" }, files).token).toBe("from-other-file");
	});

	it("without a game: no token and the local default URL; a missing .env or broken typetorch.json is not a crash", () => {
		expect(resolveTarget({}, disk({}))).toMatchObject({ url: "http://127.0.0.1:8787", source: "default url, no token" });
		expect(resolveTarget({}, disk({})).token).toBeUndefined();
		const broken = resolveTarget({ TYPETORCH_GAME_DIR: "/game" }, disk({ "/game/typetorch.json": "{not json" }));
		expect(broken.url).toBe("http://127.0.0.1:8787");
		expect(broken.source).toContain("no token in");
	});

	it("never sends the token over plain http to another machine", () => {
		expect(() => assertSafeTarget("https://backend.example.com")).not.toThrow();
		expect(() => assertSafeTarget("http://127.0.0.1:8787")).not.toThrow();
		expect(() => assertSafeTarget("http://localhost:8787")).not.toThrow();
		expect(() => assertSafeTarget("http://[::1]:8787")).not.toThrow();
		expect(() => assertSafeTarget("http://backend.example.com")).toThrow("plain http");
		expect(() => assertSafeTarget("http://10.0.0.5:8787")).toThrow("plain http");
		expect(() => assertSafeTarget("https://user:pass@backend.example.com")).toThrow("credentials");
		expect(() => assertSafeTarget("not a url")).toThrow("not a URL");
	});
});

describe("explorer proxy guard", () => {
	it("forwards only the explorer's endpoints", () => {
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/fleet/stream?branch=dev", headers: same }, true)).toEqual({ ok: true });
		// The Performance page's marks and a server's history.
		expect(guardRequest({ method: "GET", url: "/v1/fleet/marks?since=1&until=2&branch=prod", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/fleet/servers/11111111-2222-3333-4444-555555555555/metrics?since=1", headers: same }, true)).toEqual({ ok: true });
		// The deploy history: the list (paged) and one release by seq; nothing else under /deploys.
		expect(guardRequest({ method: "GET", url: "/v1/fleet/deploys?branch=prod&before=42&limit=50", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/fleet/deploys/42", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/fleet/deploys/abc", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/fleet/deploys", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "GET", url: "/v1/fleet/servers/../storage/metrics", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/fleet/mark", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/sql", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/storage", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/admin/stats?window=5m", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "POST", url: "/v1/admin/stats", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "GET", url: "/v1/admin/alert-rules", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/identity?uid=1", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/identity/pid-abc_123/profile", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "POST", url: "/v1/identity/pid-abc_123/profile", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "GET", url: "/v1/identity/a.b/profile", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/identity/backfill", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/auth/check", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/errors?window=24h&realm=server", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/errors/fp-abc123", headers: same }, true)).toEqual({ ok: true });
		// The server page's error kinds; saved queries are read only through the proxy.
		expect(guardRequest({ method: "GET", url: "/v1/servers/0b5c7d9e-1111/errors?window=30d", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/saved-queries", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/saved-queries/12", headers: same }, true)).toEqual({ ok: true });
		for (const method of ["POST", "PATCH", "DELETE"]) expect(guardRequest({ method, url: "/v1/saved-queries/12", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/saved-queries", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "GET", url: "/v1/live?topics=error", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "POST", url: "/v1/identity", headers: same }, true)).toMatchObject({ ok: false, status: 403 }); // the game's ingest route
		// Runtime settings: read only through the proxy; saving and the test alert stay on the backend's own explorer.
		expect(guardRequest({ method: "GET", url: "/v1/admin/settings", headers: same }, true)).toEqual({ ok: true });
		for (const method of ["PATCH", "POST", "PUT"]) expect(guardRequest({ method, url: "/v1/admin/settings", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/admin/settings/test-alert", headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		expect(guardRequest({ method: "GET", url: "/healthz", headers: { host: "localhost:5173", "sec-fetch-site": "none" } }, true)).toEqual({ ok: true });
		for (const [method, url] of [
			["POST", "/v1/erasure"],
			["POST", "/v1/ingest"],
			["POST", "/v1/errors"],
			["POST", "/v1/auth/login"],
			["POST", "/v1/auth/logout"],
			["GET", "/v1/auth/roblox/start"],
			["PUT", "/v1/access"],
			["GET", "/v1/access"],
			["POST", "/v1/fleet/alerts/3/ack"],
			["POST", "/v1/fleet/heartbeat"],
			["GET", "/v1/settings"],
			["GET", "/v1/query/overview"],
			["GET", "/v1/errors/../storage"],
			["POST", "/v1/query/../erasure"],
		]) {
			expect(guardRequest({ method, url, headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		}
	});

	it("forwards the server page's routes (plans/25) and nothing else under them", () => {
		const job = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";
		for (const [method, url] of [
			["GET", `/v1/fleet/servers/${job}`],
			["GET", `/v1/fleet/servers/${job}/metrics?since=1760000000000`],
			["POST", `/v1/fleet/servers/${job}/watch`],
			["POST", `/v1/fleet/servers/${job}/commands`],
			["GET", `/v1/fleet/servers/${job}/commands/abc123`],
			["GET", "/v1/fleet/debug/audit?limit=100"],
		]) {
			expect(guardRequest({ method, url, headers: same }, true), `${method} ${url}`).toEqual({ ok: true });
		}
		for (const [method, url] of [
			// The game's side of remote debug (the API key's routes) is never forwarded.
			["GET", "/v1/fleet/commands?wait=8"],
			["POST", "/v1/fleet/results"],
			["DELETE", `/v1/fleet/servers/${job}`],
			["POST", `/v1/fleet/servers/${job}`],
			["GET", `/v1/fleet/servers/${job}/watch`],
			["POST", `/v1/fleet/servers/${job}/commands/abc123`],
			["POST", `/v1/fleet/servers/${job}/kick`],
			["GET", `/v1/fleet/servers/${job}/../../access`],
			["POST", "/v1/fleet/debug/audit"],
		]) {
			expect(guardRequest({ method, url, headers: same }, true), `${method} ${url}`).toMatchObject({ ok: false, status: 403 });
		}
	});

	it("refuses other sites and non-JSON posts, and explains a missing token", () => {
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, "sec-fetch-site": "cross-site" } }, true)).toMatchObject({
			status: 403,
		});
		expect(
			guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, "sec-fetch-site": undefined, origin: "https://evil.example" } }, true),
		).toMatchObject({ status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, origin: "http://localhost:5173" } }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, "content-type": "text/plain" } }, true)).toMatchObject({
			status: 415,
		});
		const noToken = guardRequest({ method: "POST", url: "/v1/query/overview", headers: same }, false);
		expect(noToken).toMatchObject({ ok: false, status: 503 });
		expect(noToken.ok ? "" : noToken.error).toContain("--game");
	});
});
