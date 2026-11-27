// extKeepDays: the nightly cuts extended replays (tt-ext-1) out of old recordings day files and keeps the normal ones.
import { afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Warehouse } from "../src/server/warehouse.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function writeDay(dir: string, day: string, t: number): Promise<void> {
	const db = await DuckDBInstance.create(":memory:");
	const c = await db.connect();
	const row = (pid: string, codec: string, chunk: number) => `(1, ${t}::BIGINT, '${pid}', 's', 'j', 'a', ${chunk}, '${codec}', 'AAAA', 1, ${t}::BIGINT)`;
	await c.run(
		`COPY (SELECT * FROM (VALUES ${[row("p1", "tt-rec-1", 0), row("p1", "tt-ext-1", 1), row("p2", "tt-ext-1", 0), row("p2", "tt-rec-1", 1)].join(", ")}) ` +
			`x(v, t, pid, sid, job, art, chunk, codec, data, n, rt)) TO '${join(dir, `${day}.parquet`)}' (FORMAT parquet)`,
	);
	c.closeSync();
}

async function codecs(file: string): Promise<string[]> {
	const db = await DuckDBInstance.create(":memory:");
	const c = await db.connect();
	const rows = (await c.runAndReadAll(`SELECT codec FROM read_parquet('${file}') ORDER BY pid, chunk`)).getRowObjects();
	c.closeSync();
	return rows.map((r) => String(r.codec));
}

describe("extended recordings retention", () => {
	test("old day files lose only their tt-ext-1 rows; recent ones are untouched", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "tt-ext-"));
		dirs.push(dataDir);
		const recDir = join(dataDir, "recordings");
		mkdirSync(recDir, { recursive: true });
		await writeDay(recDir, "2026-09-01", Date.UTC(2026, 8, 1, 10)); // 87 days old
		await writeDay(recDir, "2026-11-20", Date.UTC(2026, 10, 20, 10)); // 7 days old
		const w = await Warehouse.open({ dataDir, memoryLimit: "256MB", threads: 1, keepDays: 400, rawKeepDays: 14, extKeepDays: () => 60, compactMb: 256, queryTimeoutSeconds: 30, queryConcurrency: 1, fsyncMs: 0, clock: () => NOW, log: () => {} });
		try {
			const first = await w.nightly();
			expect(first.pruned).toBe(1);
			expect(await codecs(join(recDir, "2026-09-01.parquet"))).toEqual(["tt-rec-1", "tt-rec-1"]);
			expect(await codecs(join(recDir, "2026-11-20.parquet"))).toEqual(["tt-rec-1", "tt-ext-1", "tt-ext-1", "tt-rec-1"]);
			// Nothing extended is left in the old file: a second night rewrites nothing.
			expect((await w.nightly()).pruned).toBe(0);
		} finally {
			await w.close();
		}
	});

	test("0 keeps extended replays as long as the day file", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "tt-ext-"));
		dirs.push(dataDir);
		const recDir = join(dataDir, "recordings");
		mkdirSync(recDir, { recursive: true });
		await writeDay(recDir, "2026-09-01", Date.UTC(2026, 8, 1, 10));
		const w = await Warehouse.open({ dataDir, memoryLimit: "256MB", threads: 1, keepDays: 400, rawKeepDays: 14, extKeepDays: 0, compactMb: 256, queryTimeoutSeconds: 30, queryConcurrency: 1, fsyncMs: 0, clock: () => NOW, log: () => {} });
		try {
			await w.nightly();
			expect(await codecs(join(recDir, "2026-09-01.parquet"))).toHaveLength(4);
		} finally {
			await w.close();
		}
	});
});
