/**
 * Backups (server/backup.ts): a consistent copy while the server runs (live.duckdb by COPY FROM DATABASE between the
 * warehouse's jobs, SQLite by VACUUM INTO on a worker, the day files hard-linked), keep N, the schedule, the tar
 * download without the two secrets, who may make and download one, and the tar format itself. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { backupFiles, tarHeader } from "../src/server/backup.ts";
import { DAY, NOW, generateFixture } from "./fixtures.ts";
import { ADMIN, API, asJson, bearer, harness, json, type Harness } from "./harness.ts";

const LOOKUP = "lookup-token-for-tests-0123456789abcdef0";
const HOOK = "https://hooks.example.test/webhooks/444/fake-backup-webhook-secret-DDDD";
const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };
const VIEWER = 5005;
const KEY_TEXT = "-----BEGIN PRIVATE KEY-----\nfake-instance-key-for-tests\n-----END PRIVATE KEY-----\n";

/** The entries of a tar: name, size, content. */
function untar(bytes: Uint8Array): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	const buf = Buffer.from(bytes);
	let at = 0;
	while (at + 512 <= buf.length) {
		const header = buf.subarray(at, at + 512);
		if (header.every((b) => b === 0)) break;
		const text = (from: number, len: number) => header.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
		const name = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
		const size = parseInt(text(124, 12), 8);
		// The checksum covers the header with its own field as spaces.
		const sum = [...header].reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
		expect(parseInt(text(148, 8), 8)).toBe(sum);
		at += 512;
		if (text(156, 1) === "0") out.set(name, buf.subarray(at, at + size));
		at += Math.ceil(size / 512) * 512;
	}
	return out;
}

async function countRows(file: string, sql: string): Promise<number> {
	const instance = await DuckDBInstance.create(":memory:");
	const c = await instance.connect();
	try {
		await c.run(`ATTACH '${file.replace(/'/g, "''")}' AS b (READ_ONLY)`);
		const rows = await (await c.run(sql)).getRows();
		return Number(rows[0]?.[0]);
	} finally {
		c.closeSync();
		instance.closeSync();
	}
}

// The fixture's ingest, load and nightly export, then VACUUM INTO and COPY FROM DATABASE: slow on a loaded machine.
setDefaultTimeout(60_000);

describe("backups", () => {
	let h: Harness;
	let viewer: Record<string, string>;
	const backupsDir = () => join(h.dir, "backups");

	beforeAll(async () => {
		h = await harness({ TYPETORCH_BACKUP_KEEP: "2", TYPETORCH_LOOKUP_TOKEN: LOOKUP, TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		h.setNow(NOW);
		viewer = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}`, ...XT };
		// Yesterday's and today's rows: the nightly export makes yesterday's day file, today's stay in live.duckdb.
		const fx = generateFixture();
		const dayStart = Math.floor(NOW / DAY) * DAY;
		const events = fx.events.filter((e) => e.t >= dayStart - DAY && e.t < NOW);
		const res = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events, recordings: [] }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(res.status).toBe(202);
		await h.app.load();
		await h.app.nightly();
		expect((await h.app.warehouse?.liveRows())?.events).toBeGreaterThan(0);
		// The two secrets of the data folder: the webhook URL (saved on the Settings page) and the instance key.
		expect((await h.call("/v1/admin/settings", { method: "PATCH", ...json({ alertWebhookUrl: HOOK }), headers: { ...JSON_TYPE, ...bearer(ADMIN) } })).status).toBe(200);
		writeFileSync(join(h.dir, "instance.key"), KEY_TEXT, { mode: 0o600 });
	});
	afterAll(() => h.close());

	test("POST /v1/admin/backups: a consistent local copy of both databases and the day files", async () => {
		const res = await h.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) });
		expect(res.status).toBe(200);
		const body = await asJson(res);
		const m = body.manifest;
		expect(m).toMatchObject({ format: "typetorch-backup-v1", reason: "manual", sqlite: true, duckdb: true, dayFilesBy: "link" });
		expect(m.dayFiles).toBeGreaterThan(0);
		expect(m.leftOut.join(" ")).toContain("raw/incoming");
		const folder = join(backupsDir(), m.name);
		const files = backupFiles(folder);
		expect(files).toContain("live.duckdb");
		expect(files).toContain("fleet.sqlite");
		expect(files).toContain("manifest.json");
		expect(files).toContain("runtime-settings.json");
		expect(files).toContain("instance.key");
		expect(files.some((f) => f.startsWith("events/") && f.endsWith(".parquet"))).toBe(true);
		expect(files.some((f) => f.startsWith("rollups/daily/"))).toBe(true);
		// The copy holds what the server holds.
		const live = (await h.app.warehouse?.liveRows())?.events as number;
		expect(await countRows(join(folder, "live.duckdb"), "SELECT COUNT(*) FROM b.events")).toBe(live);
		// Hard links: the same file, no extra space.
		const day = files.find((f) => f.startsWith("events/")) as string;
		expect(statSync(join(folder, day)).ino).toBe(statSync(join(h.dir, day)).ino);
		// SQLite: a real database with the audit log in it (VACUUM INTO, on a worker: no fallback line).
		const { Database } = (await import("bun:sqlite")) as unknown as { Database: new (p: string, o?: object) => { query(s: string): { get(): Record<string, number> }; close(): void } };
		const db = new Database(join(folder, "fleet.sqlite"), { readonly: true });
		expect(db.query("SELECT COUNT(*) AS n FROM audit_log").get().n).toBeGreaterThan(0);
		db.close();
		expect(h.logs.some((l) => l.includes("no worker thread"))).toBe(false);
		// The status lists it; the audit log says who made it.
		expect(body.backups[0]).toMatchObject({ name: m.name, reason: "manual", duckdb: true });
		const audit = await h.app.audit.list({ action: "backup.create" });
		expect(audit.entries[0]).toMatchObject({ actor: "admin token", outcome: "ok", details: { name: m.name } });
	});

	test("keep N: the oldest go; one backup at a time", async () => {
		h.setNow(NOW + 61_000);
		expect((await h.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) })).status).toBe(200);
		h.setNow(NOW + 122_000);
		expect((await h.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) })).status).toBe(200);
		const list = (await asJson(await h.call("/v1/admin/backups", { headers: bearer(ADMIN) }))).backups as { name: string }[];
		expect(list).toHaveLength(2);
		expect(readdirSync(backupsDir()).filter((n) => n.startsWith("typetorch-backup-"))).toHaveLength(2);
		const first = h.app.backups.runLocal("manual");
		await expect(h.app.backups.runLocal("manual")).rejects.toThrow(/being made/);
		await first;
		// Two a minute.
		h.setNow(NOW + 183_000);
		expect((await h.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) })).status).toBe(200);
		expect((await h.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) })).status).toBe(429);
	});

	test("the schedule: a backup when the newest is old enough, recorded as the server's", async () => {
		h.setNow(NOW + 3 * 60_000);
		await h.app.backupTick();
		expect((await h.app.audit.list({ action: "backup.create", actor: "server (scheduled)" })).entries).toHaveLength(0);
		h.setNow(NOW + 25 * 3_600_000);
		await h.app.backupTick();
		const scheduled = (await h.app.audit.list({ action: "backup.create", actor: "server (scheduled)" })).entries;
		expect(scheduled[0]).toMatchObject({ actorKind: "system", outcome: "ok" });
		expect((await asJson(await h.call("/v1/admin/backups", { headers: bearer(ADMIN) }))).backups[0]).toMatchObject({ reason: "scheduled" });
	});

	test("the download: a tar of a fresh backup, without the webhook URL and instance.key; its folder is gone after", async () => {
		h.setNow(NOW + 26 * 3_600_000);
		const res = await h.call("/v1/admin/backups/download", { method: "POST", headers: bearer(ADMIN) });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/x-tar");
		const name = /filename="(typetorch-backup-[^"]+)\.tar"/.exec(res.headers.get("content-disposition") ?? "")?.[1] as string;
		expect(name).toBeTruthy();
		const entries = untar(new Uint8Array(await res.arrayBuffer()));
		const names = [...entries.keys()];
		for (const file of ["live.duckdb", "fleet.sqlite", "manifest.json", "runtime-settings.json", "access.json"].filter((f) => f !== "access.json" || existsSync(join(h.dir, f)))) expect(names).toContain(`${name}/${file}`);
		expect(names.some((n) => n.startsWith(`${name}/events/`))).toBe(true);
		expect(names).not.toContain(`${name}/instance.key`);
		const all = [...entries.values()].map((b) => b.toString("latin1")).join("");
		expect(all).not.toContain("fake-backup-webhook-secret-DDDD");
		expect(all).not.toContain("fake-instance-key-for-tests");
		const settings = JSON.parse(entries.get(`${name}/runtime-settings.json`)?.toString("utf8") ?? "{}");
		expect(settings.values?.alertWebhookUrl).toBeUndefined();
		const manifest = JSON.parse(entries.get(`${name}/manifest.json`)?.toString("utf8") ?? "{}");
		expect(manifest).toMatchObject({ reason: "download", duckdb: true });
		expect(manifest.leftOut.join(" ")).toContain("instance.key");
		// The live.duckdb in the tar opens and holds the rows.
		const out = join(h.dir, "from-tar.duckdb");
		writeFileSync(out, entries.get(`${name}/live.duckdb`) as Buffer);
		expect(await countRows(out, "SELECT COUNT(*) FROM b.events")).toBe((await h.app.warehouse?.liveRows())?.events as number);
		expect(readdirSync(join(h.dir, "backup-tmp"))).toEqual([]);
		// The local backups keep the secrets (they stay on the server's disk).
		const local = (await asJson(await h.call("/v1/admin/backups", { headers: bearer(ADMIN) }))).backups[0].name as string;
		expect(readFileSync(join(backupsDir(), local, "instance.key"), "utf8")).toBe(KEY_TEXT);
		expect((await h.app.audit.list({ action: "backup.download" })).entries[0]).toMatchObject({ actor: "admin token", outcome: "ok", details: { name } });
	});

	test("owners only: the web role, the lookup token, the game key and no credentials are refused; cookies need X-TypeTorch", async () => {
		h.setNow(NOW + 27 * 3_600_000);
		// A fresh session: the clock moved past the first one's idle time.
		viewer = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "Viewer" }, "web")}`, ...XT };
		for (const [path, method] of [
			["/v1/admin/backups", "GET"],
			["/v1/admin/backups", "POST"],
			["/v1/admin/backups/download", "POST"],
		] as const) {
			expect(`${method} ${path} ${(await h.call(path, { method, headers: viewer })).status}`).toBe(`${method} ${path} 403`);
			expect((await h.call(path, { method, headers: bearer(LOOKUP) })).status).toBe(403);
			expect((await h.call(path, { method, headers: bearer(API) })).status).toBe(401);
			expect((await h.call(path, { method })).status).toBe(401);
		}
		expect((await h.call("/v1/admin/backups/download", { method: "GET", headers: bearer(ADMIN) })).status).toBe(405);
		const owner = `tt_session=${h.app.sessions.create({ kind: "token" })}`;
		expect((await h.call("/v1/admin/backups/download", { method: "POST", headers: { cookie: owner } })).status).toBe(403);
		const ok = await h.call("/v1/admin/backups/download", { method: "POST", headers: { cookie: owner, ...XT, origin: "http://backend.test" } });
		expect(ok.status).toBe(200);
		await ok.body?.cancel();
		// Cancelled mid-stream: the folder still goes.
		await new Promise((done) => setTimeout(done, 50));
		expect(readdirSync(join(h.dir, "backup-tmp"))).toEqual([]);
	});

	test("the allow list hides the routes", async () => {
		const allow = await harness({ TYPETORCH_ADMIN_ALLOW_IPS: "127.0.0.1" });
		try {
			expect((await allow.call("/v1/admin/backups", { headers: bearer(ADMIN), ip: "203.0.113.50" })).status).toBe(404);
			expect((await allow.call("/v1/admin/backups/download", { method: "POST", headers: bearer(ADMIN), ip: "203.0.113.50" })).status).toBe(404);
			expect((await allow.call("/v1/admin/backups", { headers: bearer(ADMIN) })).status).toBe(200);
		} finally {
			await allow.close();
		}
	});

	test("a fleet-only server backs up SQLite and its files, and says DuckDB is left out", async () => {
		const fleet = await harness({ TYPETORCH_PARTS: "fleet" });
		try {
			const m = (await asJson(await fleet.call("/v1/admin/backups", { method: "POST", headers: bearer(ADMIN) }))).manifest;
			expect(m).toMatchObject({ sqlite: true, duckdb: false, dayFiles: 0 });
			expect(m.leftOut.join(" ")).toContain("analytics part is off");
		} finally {
			await fleet.close();
		}
	});
});

describe("tar headers", () => {
	test("long names split at a slash into prefix and name; too long throws", () => {
		const dir = "d".repeat(120);
		const h = tarHeader(`${dir}/file.parquet`, 10, 0, "file");
		expect(Buffer.from(h.subarray(0, 100)).toString().replace(/\0.*$/s, "")).toBe("file.parquet");
		expect(Buffer.from(h.subarray(345, 500)).toString().replace(/\0.*$/s, "")).toBe(dir);
		expect(() => tarHeader("x".repeat(300), 1, 0, "file")).toThrow(/too long/);
	});

	test("sizes past 8 GiB use base-256", () => {
		const size = 9 * 1024 ** 3;
		const h = tarHeader("big", size, 0, "file");
		expect(h[124]).toBe(0x80);
		let n = 0n;
		for (let i = 125; i < 136; i++) n = (n << 8n) | BigInt(h[i] as number);
		expect(Number(n)).toBe(size);
	});
});
