/**
 * Every named query of the backend (src/queries QUERIES) through the demo's /v1/query route, on the pack: each answers
 * without an error, and with data unless the pack has none for it (notifications were not in The Prison's
 * window; map positions need props the pack doesn't log).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { QUERY_NAMES } from "../../../src/queries/index.ts";
import { pack } from "../mock/pack";
import { describeWithPack, setupDemo, teardownDemo, testApi } from "./harness";

/** Queries the pack has no rows for: they must still answer. */
const EMPTY_OK = new Set(["notify-player", "map-positions"]);

/** Some value in the answer is a non-empty list or a positive number. */
function hasData(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "number") return value > 0;
	if (value && typeof value === "object") return Object.values(value).some(hasData);
	return false;
}

describeWithPack("named queries on the demo pack", () => {
	let options: Record<string, object> = {};

	beforeAll(async () => {
		await setupDemo({ engine: true });
		const p = await pack();
		// The most active player of the last days, a recorded session, an experiment and a funnel from the pack.
		const pid = [...p.players].filter((x) => x.lastAt > p.now - 3 * 86_400_000).sort((a, b) => b.events - a.events)[0]?.pid as string;
		const api = testApi();
		const sessions = (await api.raw("recording-sessions", { filters: {}, options: {} })).result as { sessions: { sid: string }[] };
		const sid = sessions.sessions[0]?.sid as string;
		const experiment = p.experiments[0]?.experiment as string;
		options = {
			"funnel-progress": { pids: [pid] },
			"funnel-players": { funnel: "first_session", step: 1 },
			timeline: { pid },
			"player-graph": { pid },
			"player-stats": { pid },
			"player-events": { pids: [pid], names: ["join", "leave", "quest_complete", "shop_buy", "level_up", "death"] },
			"player-summary": { pids: [pid], names: ["join", "leave", "quest_complete", "shop_buy", "level_up", "death"] },
			"experiment-players": { experiment },
			"recording-replay": { sid },
			"notify-player": { pid },
		};
	});
	afterAll(() => teardownDemo());

	for (const name of QUERY_NAMES) {
		it(name, async () => {
			const answer = await testApi().raw(name, { filters: {}, options: options[name] ?? {} });
			expect(answer.ms).toBeTypeOf("number");
			expect(answer.result).toBeTruthy();
			if (!EMPTY_OK.has(name)) expect(hasData(answer.result), `${name} answered no data: ${JSON.stringify(answer.result).slice(0, 300)}`).toBe(true);
		});
	}

	it("refuses an unknown query and bad options like the backend", async () => {
		await expect(testApi().raw("nope", {})).rejects.toMatchObject({ status: 404 });
		await expect(testApi().raw("timeline", { options: { pid: "not a pid!" } })).rejects.toMatchObject({ status: 400 });
	});
});
