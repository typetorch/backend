/** Shared setup for the backend tests: an app on a temp data folder with a fake clock, and request helpers. All tokens are made up. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App, type AppOptions } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";

export const API = "game-api-key-for-tests-0123456789abcdef";
export const PREVIOUS = "previous-api-key-for-tests-0123456789abc";
export const ADMIN = "admin-token-for-tests-0123456789abcdef0";
export const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

export interface Harness {
	app: App;
	/** http://127.0.0.1:<port>, for tests that need a real connection. */
	base: string;
	dir: string;
	logs: string[];
	setNow(ms: number): void;
	now(): number;
	/** One request through app.handle, from `ip`. */
	call(path: string, init?: RequestInit & { ip?: string }): Promise<Response>;
	close(): Promise<void>;
}

/** Sign in with typetorch.dev is on by default; the harness turns it off (no real broker reports) unless `env` sets it. */
export async function harness(env: Record<string, string> = {}, options: { fetch?: typeof fetch; reportSleep?: (ms: number) => Promise<void>; diskUsage?: AppOptions["diskUsage"] } = {}): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "tt-backend-"));
	let now = T0;
	const logs: string[] = [];
	const config = loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: dir, PORT: "0", TYPETORCH_MEMORY_LIMIT: "256MB", TYPETORCH_EXPLORER: "off", TYPETORCH_CENTRAL_LOGIN: "off", ...env });
	const app = await startApp(config, { clock: () => now, manualJobs: true, log: (l) => logs.push(l), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.reportSleep ? { reportSleep: options.reportSleep } : {}), ...(options.diskUsage ? { diskUsage: options.diskUsage } : {}) });
	return {
		app,
		base: `http://127.0.0.1:${app.port}`,
		dir,
		logs,
		setNow: (ms) => (now = ms),
		now: () => now,
		call: (path, init = {}) => {
			const { ip, ...rest } = init;
			return app.handle(new Request(`http://backend.test${path}`, rest), ip ?? "127.0.0.1");
		},
		close: async () => {
			await app.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
export const json = (body: unknown): { body: string; headers: Record<string, string> } => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });
export const post = (token: string | undefined, body: unknown): RequestInit => ({ method: "POST", ...json(body), headers: { "content-type": "application/json", ...(token ? bearer(token) : {}) } });
export const cookieOf = (res: Response): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith("tt_session="))?.split(";")[0];
export const asJson = async (res: Response) => (await res.json()) as Record<string, any>;

