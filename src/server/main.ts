#!/usr/bin/env node
/**
 * typetorch-backend: the analytics API (DuckDB), the fleet API (SQLite), error logs and the explorer in one process
 * (README "The backend").
 *   bun src/server/main.ts [--env-file backend.env]
 *   node dist/server/main.js [--env-file backend.env]
 * Settings come from environment variables (TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN are required).
 * SIGTERM / SIGINT stop it within seconds (server/lifecycle.ts); a rolling deploy's new server takes the data folder over
 * from the old one (server/app.ts "Rolling deploys").
 */
import { runtimeName } from "../runtime.ts";
import { startApp, type App } from "./app.ts";
import { describeConfig, loadConfig } from "./config.ts";
import { startIngestNode, type IngestNode } from "./ingest-node.ts";
import { handleShutdown } from "./lifecycle.ts";

async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log("usage: typetorch-backend [--env-file <file>]\nRequired: TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN (32+ random characters each, different). See the README for the rest.");
		return;
	}
	const config = loadConfig();
	for (const warning of config.warnings) console.warn(`[backend] ${warning}`);
	const log = (line: string) => console.log(`[backend] ${line}`);
	// Plans/35 C: an ingest node is its own small server (no DuckDB warehouse, no fleet, no explorer).
	if (config.role === "ingest") {
		let node: Promise<IngestNode> | undefined;
		const lifecycle = handleShutdown({ stop: async () => (await node?.catch(() => undefined))?.stop(), log, exit: (code) => process.exit(code) });
		node = startIngestNode(config, { log: (line) => console.log(`[ingest] ${line}`) });
		const started = await node;
		if (lifecycle.requested) return;
		console.log(`[ingest] listening on ${config.host}:${started.port} (${runtimeName()}); node ${started.node || "(waiting for the data folder)"}; ${describeConfig(config)}`);
		return;
	}
	// Signals are handled from the first moment (as PID 1 in a container an unhandled SIGTERM would be ignored): one that
	// comes during the start stops the app as soon as it is up.
	let starting: Promise<App> | undefined;
	const lifecycle = handleShutdown({
		stop: async () => {
			const app = await starting?.catch(() => undefined);
			await app?.stop();
		},
		log,
		exit: (code) => process.exit(code),
	});
	// The app logs why it gives up (a handover that never ended); stopping cleanly then exits 1 (Docker restarts it).
	starting = startApp(config, { onFatal: () => void lifecycle.shutdown("fatal error", 1) });
	const app = await starting;
	if (lifecycle.requested) return;
	// The environment's view, then (names only) what the explorer's Settings page saved over it.
	const saved = app.settings.overridden();
	const overrides = saved.length ? `; saved on the Settings page (these win over the environment): ${saved.join(", ")}` : "";
	const fingerprint = app.central ? `; instance fingerprint ${app.central.fingerprint}` : "";
	console.log(`[backend] listening on ${config.host}:${app.port} (${runtimeName()}); ${describeConfig(config)}${fingerprint}${overrides}`);
}

main().catch((error) => {
	console.error(`[backend] ${(error as Error).message}`);
	process.exit(1);
});
