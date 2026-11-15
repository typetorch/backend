/**
 * The demo's response headers, shared by the Worker (worker.ts) and the Vite dev server (vite.demo.config.ts).
 *
 * The Content-Security-Policy is the demo's privacy guarantee in the browser: the page may talk to its own origin and to
 * jsDelivr (the DuckDB-WASM bundle) only, so nothing reaches roblox.com, the real backend, extensions.duckdb.org or any
 * other third party, whatever a mock answers.
 */
export const JSDELIVR = "https://cdn.jsdelivr.net";

export function contentSecurityPolicy(dev = false): string {
	return [
		"default-src 'self'",
		// The Vite dev server injects an inline module (React refresh) and talks over a websocket.
		`script-src 'self' 'wasm-unsafe-eval' blob: ${JSDELIVR}${dev ? " 'unsafe-inline'" : ""}`,
		"worker-src 'self' blob:",
		`connect-src 'self' ${JSDELIVR}${dev ? " ws: wss:" : ""}`,
		"img-src 'self' data: blob:",
		"style-src 'self' 'unsafe-inline'",
		"font-src 'self' data:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

export const SAFE_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"X-Frame-Options": "DENY",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
