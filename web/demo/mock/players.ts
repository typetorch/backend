/**
 * Players: identities, profiles and experiments (src/server/app.ts).
 *
 *   GET  /v1/identity?pid=|uid=              { identities: [] }  (the demo maps no UserId to a pid)
 *   GET  /v1/identity                        { count: 0, backfill: false }
 *   POST /v1/identity/backfill               { scanned: 0, added: 0, known: 0 }  (nothing to read: no DataStore)
 *   GET  /v1/identity/<pid>/profile          { pid, linked: false, name, displayName }: a fake name ("Inmate_4821"), never
 *                                            a UserId or an avatar, so nothing is ever loaded from roblox.com
 *   GET  /v1/experiments                     the overrides (demo state: one_tap_play and tutorial_ui, the pack's experiments)
 *   POST /v1/experiments/<key>/change        the backend's own checks and CLI command; the demo also applies it to the
 *                                            overrides, as if the owner ran the command
 *   GET  /v1/experiments/<key>/players       the backend's experiment-players query on the pack, with fake names
 */
import { EXPERIMENT_NAME, ExperimentChangeInput, parseChange, prepareChange, type ChangeRequest } from "../../../src/server/experiment-change.ts";
import { ExperimentPlayersInput, parseExperimentPlayers } from "../../../src/server/experiment-players.ts";
import { renderQuery } from "../../../src/queries/index.ts";
import type { BackfillResult, ExperimentOverride, ExperimentOverrides, ExperimentPlayers, Identity, PlayerProfile, PreparedExperimentChange } from "@/lib/types";
import { queryContext, runNamedQuery } from "./analytics";
import { now } from "./data";
import { PID_PATTERN } from "./errors";
import { pack } from "./pack";
import { fakeName } from "./rng";
import { fail, HttpError, route } from "./router";
import { slice } from "./state";

// Identity ---------------------------------------------------------------------------------------------------------------

/** parseUid (fleet/identity.ts): digits, a positive safe integer. */
function parseUid(value: string): number | undefined {
	const n = /^\d{1,16}$/.test(value) ? Number(value) : undefined;
	return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

route<{ identities: Identity[] } | { count: number; backfill: boolean }>("GET", "/v1/identity", (req) => {
	const pid = req.query.get("pid");
	const uid = req.query.get("uid");
	if (pid) {
		if (!PID_PATTERN.test(pid)) return fail(400, "bad pid");
		return { identities: [] };
	}
	if (uid) {
		if (parseUid(uid) === undefined) return fail(400, "uid must be a UserId (digits)");
		return { identities: [] };
	}
	// No pid is linked to a UserId in the demo, and there is no DataStore to backfill from.
	return { count: 0, backfill: false };
});

route<BackfillResult>("POST", "/v1/identity/backfill", () => ({ scanned: 0, added: 0, known: 0 }));

/** A player's demo profile: a fake name from the team they played most; never a UserId, never an avatar URL. */
export async function profileOf(pid: string): Promise<PlayerProfile> {
	const p = await pack();
	const player = p.player(pid);
	if (!player) return { pid, linked: false };
	const name = fakeName(pid, player.team);
	return { pid, linked: false, name, displayName: name };
}

route<PlayerProfile>("GET", "/v1/identity/:pid/profile", async (req) => {
	const pid = req.params.pid as string;
	if (!PID_PATTERN.test(pid)) return fail(400, "bad pid");
	return profileOf(pid);
});

// Experiments ------------------------------------------------------------------------------------------------------------

/**
 * The settings file's experiment overrides. one_tap_play runs an even split; tutorial_ui was moved to 70 / 30 for the
 * spotlight (the pack has about twice as many spotlight players as beam).
 */
const overrides = slice<ExperimentOverrides>("players.experiments", () => ({
	source: "settings-file",
	experiments: {
		one_tap_play: { active: true, weights: [1, 1] },
		tutorial_ui: { active: true, weights: [70, 30] },
	},
}));

route<ExperimentOverrides>("GET", "/v1/experiments", () => overrides.get());

/** What running the prepared command does to the override (typetorch experiment resume / stop / weights / settle / clear). */
export function applyChange(current: ExperimentOverride | undefined, change: ChangeRequest): ExperimentOverride | undefined {
	const next: ExperimentOverride = { ...(current ?? {}) };
	switch (change.action) {
		case "start":
			next.active = true;
			delete next.variant;
			return next;
		case "stop":
			next.active = false;
			return next;
		case "split":
			next.weights = change.weights as number[];
			return next;
		case "settle":
			next.variant = change.variant as string;
			return next;
		case "clear":
			return undefined;
	}
}

route<PreparedExperimentChange>("POST", "/v1/experiments/:experiment/change", (req) => {
	const experiment = req.params.experiment as string;
	if (!EXPERIMENT_NAME.test(experiment)) return fail(400, "experiment name: 1-64 letters, digits and _ - . /");
	if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return fail(415, "send JSON: { action, weights?, variant?, variants? }");
	if (req.text.length > 4096) return fail(413, "body too large");
	if (req.body === undefined) return fail(400, "body is not JSON");
	let request: ChangeRequest;
	let prepared: PreparedExperimentChange;
	try {
		request = parseChange(req.body);
		prepared = prepareChange(experiment, request);
	} catch (error) {
		if (error instanceof ExperimentChangeInput) return fail(400, error.message);
		throw error;
	}
	overrides.update((o) => {
		const next = applyChange(o.experiments[experiment], request);
		if (next) o.experiments[experiment] = next;
		else delete o.experiments[experiment];
		o.source = "settings-file";
	});
	return { ...prepared, notes: [...prepared.notes, "Demo: applied to this browser's overrides right away, as if the command had run."] };
});

route<ExperimentPlayers>("GET", "/v1/experiments/:experiment/players", async (req) => {
	let input: ReturnType<typeof parseExperimentPlayers>;
	try {
		input = parseExperimentPlayers(req.url.pathname.replace(/^\/api/, ""), req.query, now());
		renderQuery(queryContext(), "experiment-players", input.filters, input.options);
	} catch (error) {
		if (error instanceof ExperimentPlayersInput && error.message === "not found") return fail(404, "not found");
		return fail(400, (error as Error).message.slice(0, 300));
	}
	let found: ExperimentPlayers;
	try {
		found = (await runNamedQuery("experiment-players", input.filters, input.options)) as ExperimentPlayers;
	} catch (error) {
		throw new HttpError(500, "query failed", { detail: ((error as Error).message ?? String(error)).slice(0, 300) });
	}
	const p = await pack();
	// No UserIds (not mapped): the demo's fake names only.
	return { ...found, players: found.players.map((x) => ({ ...x, name: fakeName(x.pid, p.player(x.pid)?.team), displayName: fakeName(x.pid, p.player(x.pid)?.team) })) };
});
