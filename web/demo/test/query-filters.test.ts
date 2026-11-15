/**
 * Every named query with the filters the explorer's pages send (filter bar presets 1h / 1d / 7d / 30d, a custom range,
 * the "vs previous period" window, a device, new players, an experiment variant, a country, a branch): each answers
 * without an error, and the analytics windows a visitor lands on (7d and 30d) have data.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Filters } from "@/lib/types";
import { QUERY_NAMES } from "../../../src/queries/index.ts";
import { sql } from "../mock/engine";
import { pack } from "../mock/pack";
import { describeWithPack, setupDemo, teardownDemo, TEST_NOW, testApi } from "./harness";

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Queries the pack has no rows for (see queries.test.ts). */
const EMPTY_OK = new Set(["notify-player", "map-positions"]);

function hasData(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "number") return value > 0;
	if (value && typeof value === "object") return Object.values(value).some(hasData);
	return false;
}

const FILTERS: Record<string, Filters> = {
	"7d": { from: day(TEST_NOW - 6 * DAY) },
	"30d": { from: day(TEST_NOW - 29 * DAY) },
	"1d": { from: new Date(TEST_NOW - 24 * 3_600_000).toISOString() },
	"1h": { from: new Date(TEST_NOW - 3_600_000).toISOString() },
	custom: { from: day(TEST_NOW - 10 * DAY), to: day(TEST_NOW - 4 * DAY) },
	"7d vs prev": { from: day(TEST_NOW - 13 * DAY), to: day(TEST_NOW - 7 * DAY) },
	"7d phone": { from: day(TEST_NOW - 6 * DAY), dev: "phone" },
	"7d new": { from: day(TEST_NOW - 6 * DAY), players: "new" },
	"7d returning": { from: day(TEST_NOW - 6 * DAY), players: "returning" },
	"7d variant": { from: day(TEST_NOW - 6 * DAY), variant: { experiment: "one_tap_play", variant: "one_tap" } },
	"7d US": { from: day(TEST_NOW - 6 * DAY), country: "US" },
	"7d prod": { from: day(TEST_NOW - 6 * DAY), branch: "prod" },
};

describeWithPack("named queries with the pages' filters", () => {
	let options: Record<string, object> = {};
	const empties: string[] = [];

	beforeAll(async () => {
		await setupDemo({ engine: true });
		const p = await pack();
		const pid = [...p.players].filter((x) => x.lastAt > p.now - 3 * DAY).sort((a, b) => b.events - a.events)[0]?.pid as string;
		const sessions = (await testApi().raw("recording-sessions", { filters: {}, options: {} })).result as { sessions: { sid: string }[] };
		const sid = sessions.sessions[0]?.sid as string;
		options = {
			"funnel-progress": { pids: [pid] },
			"funnel-players": { funnel: "first_session", step: 1 },
			timeline: { pid },
			"player-graph": { pid },
			"player-stats": { pid },
			"player-events": { pids: [pid], names: ["join", "leave", "quest_complete", "shop_buy", "level_up", "death"] },
			"player-summary": { pids: [pid], names: ["join", "leave", "quest_complete", "shop_buy", "level_up", "death"] },
			"experiment-players": { experiment: "one_tap_play" },
			"recording-replay": { sid },
			"notify-player": { pid },
		};
	});
	afterAll(() => {
		// Informational (other filters can be empty on the pack): written where DEMO_QUERY_REPORT points.
		if (process.env.DEMO_QUERY_REPORT) writeFileSync(process.env.DEMO_QUERY_REPORT, `empty answers (${empties.length}):\n${empties.join("\n")}\n`);
		teardownDemo();
	});

	for (const name of QUERY_NAMES) {
		it(name, async () => {
			const failures: string[] = [];
			for (const [label, filters] of Object.entries(FILTERS)) {
				try {
					const answer = await testApi().raw(name, { filters, options: options[name] ?? {} });
					if (!EMPTY_OK.has(name) && !hasData(answer.result)) {
						empties.push(`${name} [${label}]`);
						if (label === "7d" || label === "30d") failures.push(`${label}: no data`);
					}
				} catch (error) {
					failures.push(`${label}: ${(error as Error).message}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}

	it("the fast JSON path (rewriteSql) answers like the macro for every key", async () => {
		const keys = ["team", "item", "quest", "weapon", "cause", "job", "type", "reason", "ui", "source", "variant", "step", "from", "to", "country", "robux", "variants", "forced", "text", "r", "norm", "price", "amount", "one_tap_play", "tutorial_ui"];
		for (const column of ["props", "exp"])
			for (const key of keys) {
				const path = `'$."${key}"'`;
				const [row] = await sql(`SELECT count(*) AS n FROM events WHERE json_extract_string(${column}, ${path}) IS DISTINCT FROM tt_json_extract_string(${column}, ${path})`);
				expect(row?.n, `${column} ${key}`).toBe(0);
			}
	});
});
