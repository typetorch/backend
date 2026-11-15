/**
 * Sign-in: every visitor is the game's owner (role admin, a Roblox user session). There is no login page; signing out
 * just reloads (the explorer's signOut goes to "/", which signs in again).
 *
 *   GET  /v1/auth/check   the owner session (src/server/app.ts authCheck)
 *   POST /v1/auth/login   { ok, role: admin } (the token form never shows, but answer it anyway)
 *   POST /v1/auth/logout  { ok: true }
 *   POST /auth/device     trusting this browser: already trusted
 *   GET  /healthz         the admin view (the sidebar's "connected · N live rows")
 */
import type { AuthInfo, Health } from "@/lib/types";
import { DAY_MS, now } from "./data";
import { pack } from "./pack";
import { DEMO_OWNER } from "./rng";
import { route } from "./router";

/** The backend version the demo imitates (the explorer shows it in places). */
export const DEMO_VERSION = "0.1.0";

export const OWNER_SESSION: AuthInfo = {
	ok: true,
	role: "admin",
	via: "cookie",
	// No avatar: nothing is loaded from Roblox.
	user: { kind: "roblox", userId: DEMO_OWNER.userId, name: DEMO_OWNER.name, displayName: DEMO_OWNER.displayName },
	version: DEMO_VERSION,
};

route<AuthInfo>("GET", "/v1/auth/check", () => OWNER_SESSION);
route<AuthInfo>("POST", "/v1/auth/login", () => OWNER_SESSION);
route<{ ok: boolean }>("POST", "/v1/auth/logout", () => ({ ok: true }));
route<{ ok: boolean; blessed: boolean; upgraded?: boolean }>("POST", "/auth/device", () => ({ ok: true, blessed: true }));

route<Health>("GET", "/healthz", async () => {
	const p = await pack();
	const at = now();
	const today = Math.floor(at / DAY_MS) * DAY_MS;
	// Today's rows sit in the backend's live tables until the nightly export: the pack's rows since midnight.
	const todayShare = Math.max(0, Math.min(1, (at - today) / DAY_MS));
	const perDay = p.totals.events / 14;
	return {
		ok: true,
		runtime: "bun 1.3 (demo)",
		uptimeSeconds: Math.round((at - today) / 1000) + 3 * 86_400,
		rssMb: 412,
		analytics: { loaderLagSeconds: 0.4, live: { events: Math.round(perDay * todayShare), recordings: Math.round((p.totals.recordings.chunks / 14) * todayShare) }, loadedRows: p.totals.events },
		fleet: { servers: p.jobs.filter((j) => j.live).length, alerts: 0, unacked: 0, streams: 1 },
	};
});
