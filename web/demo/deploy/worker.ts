/**
 * The demo's Worker: serves the static build (env.ASSETS) and adds the security headers on every answer, plus long caching
 * for hashed build files and revalidation for the data pack. The page is static and backendless: there is no /api here, the mocks answer
 * it in the browser (an /api request that reaches this Worker gets a 404).
 */
import { contentSecurityPolicy, SAFE_HEADERS } from "./headers.ts";

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
}

const YEAR = "public, max-age=31536000, immutable";
// Revalidated on every use (a cheap 304 through the ETag): the files keep their names across deploys, and the manifest, the
// facts and the CSVs must come from the same pack (a stale manifest would shift or count a newer pack wrongly).
const REVALIDATE = "public, no-cache";

function cacheFor(path: string): string | undefined {
	// Vite's hashed files and the map geometry (named by its sha256): their name changes with their content.
	if (path.startsWith("/assets/") || /^\/data\/[0-9a-f]{64}\.ttmp$/.test(path)) return YEAR;
	if (path.startsWith("/data/")) return REVALIDATE;
	return undefined;
}

/** Build files and data are never the SPA fallback: a missing one is a 404, not index.html (cached for a year as a script). */
const isFile = (path: string) => path.startsWith("/assets/") || path.startsWith("/data/");

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			return new Response(JSON.stringify({ error: "not in the demo" }), { status: 404, headers: { "content-type": "application/json", ...SAFE_HEADERS } });
		}
		const answer = await env.ASSETS.fetch(request);
		if (isFile(url.pathname) && (answer.headers.get("content-type") ?? "").includes("text/html")) {
			return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SAFE_HEADERS } });
		}
		const response = new Response(answer.body, answer);
		for (const [name, value] of Object.entries(SAFE_HEADERS)) response.headers.set(name, value);
		response.headers.set("Content-Security-Policy", contentSecurityPolicy());
		const cache = answer.ok ? cacheFor(url.pathname) : undefined;
		if (cache) response.headers.set("Cache-Control", cache);
		else if ((response.headers.get("content-type") ?? "").includes("text/html")) response.headers.set("Cache-Control", "no-cache");
		return response;
	},
};
