/**
 * The demo's Worker: the static build of web/dist-demo (see wrangler.config.ts) behind a small entry (worker.ts) that adds
 * the security headers and long caching. Deploy with `cf deploy` from this folder (Node 22.18+); `cf deploy --dry-run`
 * checks it without uploading.
 */
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "typetorch-demo",
		compatibilityDate: "2026-11-01",
		entrypoint: "worker.ts",
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "single-page-application",
			runWorkerFirst: true,
		},
		domains: ["demo.typetorch.dev"],
		env: {
			ASSETS: bindings.assets(),
		},
	},
});
