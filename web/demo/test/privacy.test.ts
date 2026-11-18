/**
 * What the demo serves under /data/ carries no player names, real Roblox ids or machine paths. The pack was scrubbed at
 * export, but the recordings' string tables kept the tutorial NPC's "__tutorial_npc_<a player's name>" (prepare-data.ts
 * scrubs those now); this keeps it that way for any future pack.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { decodeTtRec1Chunk } from "../../../src/recording.ts";
import { DATA_DIR, describeWithPack } from "./harness";

/** The game's own NPC names (not players'). */
const STOCK_NPCS = new Set(["Inmate", "Guard", "Medic", "Warden", "Training Guard", "Training Inmate", "<player>"]);

function text(file: string): string {
	const bytes = readFileSync(join(DATA_DIR, file));
	return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
}

describeWithPack("the served data pack", () => {
	it("recording chunks name no player (tutorial NPCs, character paths)", () => {
		const lines = text("recordings.csv.gz").split("\n");
		const header = lines[0]?.split(",") ?? [];
		const at = header.indexOf("data");
		expect(at).toBeGreaterThanOrEqual(0);
		const leaked = new Set<string>();
		let strings = 0;
		for (const line of lines.slice(1)) {
			if (!line) continue;
			const data = line.split(",")[at];
			if (!data) continue;
			for (const r of decodeTtRec1Chunk(Uint8Array.from(Buffer.from(data, "base64"))).records) {
				if (r.text === undefined) continue;
				strings++;
				for (const m of r.text.matchAll(/__tutorial_npc_([^/.]*)/g)) if (!STOCK_NPCS.has(m[1] ?? "")) leaked.add(r.text);
			}
		}
		expect(strings).toBeGreaterThan(1000);
		expect([...leaked].slice(0, 5)).toEqual([]);
	});

	it("no real place / universe id, no machine path, no roblox avatar or profile URL", () => {
		for (const file of ["facts.json", "maps-index.json", "manifest.json", "events.csv.gz"]) {
			const body = text(file);
			expect(body, file).not.toMatch(/91308579636443|8795395994/);
			expect(body, file).not.toMatch(/\/home\/|phasenull/i);
			expect(body, file).not.toMatch(/rbxcdn\.com|roblox\.com\/users\//);
		}
	});

	it("the maps index names only the demo owner (UserId -1), never a real exporter", () => {
		const index = text("maps-index.json");
		expect(index).toContain("roblox user -1 (demo_owner)");
		expect(index).not.toMatch(/roblox user (?!-1 )/);
	});
});
