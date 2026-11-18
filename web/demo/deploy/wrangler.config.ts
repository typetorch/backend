/** Tooling side of the Worker config: where the static assets come from (`bun run demo:build` in web/ makes them). */
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	assetsDirectory: "../../dist-demo",
});
