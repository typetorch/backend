/**
 * The public demo (demo.typetorch.dev): the real explorer over a mock backend that runs in the browser (web/demo/).
 *
 *   bun run demo:dev     prepares the data, then Vite on http://localhost:5174 (no backend needed)
 *   bun run demo:build   prepares the data, type-checks web/demo and builds web/dist-demo (served by the demo Worker)
 *   bun run demo:test    the demo's tests (web/demo/test, Node DuckDB over the prepared pack; skipped without it)
 *
 * The explorer's own vite.config.ts, build and tests don't know about any of this.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { contentSecurityPolicy, SAFE_HEADERS } from "./demo/deploy/headers.ts";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => {
	// The browser build imports a few backend modules (src/queries, src/server/sql.ts...) whose Node imports are never
	// called in the demo: they resolve to stand-ins. Tests run on Node and keep the real modules.
	const browser = mode !== "test";
	const shims = browser
		? [
				{ find: /^node:(fs|fs\/promises|path|crypto|url|os)$/, replacement: at("./demo/shims/node-builtins.ts") },
				{ find: /^@duckdb\/node-api$/, replacement: at("./demo/shims/duckdb-node-api.ts") },
			]
		: [];
	const headers = { ...SAFE_HEADERS, "Content-Security-Policy": contentSecurityPolicy(true) };
	return {
		root: at("./demo"),
		publicDir: at("./demo/public"),
		plugins: [react(), tailwindcss()],
		resolve: { alias: [{ find: /^@\//, replacement: `${at("./src")}/` }, ...shims] },
		server: { host: "localhost", port: 5174, strictPort: false, fs: { allow: [at("./"), at("../src")] }, headers },
		preview: { host: "localhost", port: 4174, headers },
		build: { outDir: at("./dist-demo"), emptyOutDir: true, chunkSizeWarningLimit: 1200 },
		test: {
			root: at("./"),
			environment: "node",
			include: ["demo/test/**/*.test.{ts,tsx}"],
			testTimeout: 120_000,
			hookTimeout: 180_000,
			fileParallelism: false,
		},
	};
});
