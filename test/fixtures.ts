/**
 * A deterministic synthetic game: ~300 players over 21 days, an onboarding experiment (short vs long; long keeps
 * more players), zones and screens, an onboarding funnel, purchases, a few confused first sessions, game-server
 * heartbeats and deploy reports, and first-session recordings (JSON inside base64, read by a test decoder).
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { createTableSql, fieldsOf } from "../src/duckdb/layout.ts";
import type { EventRow, RecordingRow } from "../src/schema.ts";
import { prng } from "../src/stats.ts";
import { RecWriter } from "./recwriter.ts";

export const DAY = 86_400_000;
/** 2026-10-05 12:00 UTC */
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const TODAY = Math.floor(NOW / DAY);
export const FIRST_DAY = TODAY - 20;
export const ART_OLD = "a1b2c3d-111111";
export const ART_NEW = "e4f5a6b-222222";
export const ACCESS_CODE = "SECRET-ACCESS-CODE-42";

export interface Fixture {
	events: EventRow[];
	recordings: RecordingRow[];
}

const ZONES = ["Lobby", "Shop", "Arena", "Forest"];

/** The framework leaves empty parts out: `zone:Lobby|activity:idle`, `zone:Lobby|screen:Shop|activity:idle`. */
function state(zone: string, screen = "", activity = "idle"): string {
	return [`zone:${zone}`, screen ? `screen:${screen}` : "", `activity:${activity}`].filter(Boolean).join("|");
}

export function generateFixture(seed = 7): Fixture {
	const rnd = prng(seed);
	const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
	const events: EventRow[] = [];
	const recordings: RecordingRow[] = [];
	let sidCounter = 0;
	const players = 300;
	for (let i = 0; i < players; i++) {
		const pid = `p${String(i).padStart(4, "0")}`;
		const variant = i % 2 === 0 ? "short" : "long";
		const dev = pick(["desktop", "phone", "phone", "tablet", "console"] as const);
		const joinDay = FIRST_DAY + Math.floor(rnd() * 20);
		const exp = JSON.stringify({ onboarding: variant });
		const keep = variant === "long" ? 0.55 : 0.3;
		// Days played: the join day, then each later day with probability `keep` (decaying).
		const days = [joinDay];
		for (let d = joinDay + 1; d <= TODAY; d++) if (rnd() < keep * Math.pow(0.9, d - joinDay - 1)) days.push(d);
		const payer = rnd() < (variant === "long" ? 0.15 : 0.08);
		days.forEach((day, sessionIndex) => {
			const first = sessionIndex === 0;
			const sid = `s${++sidCounter}`;
			const job = `job-${(sidCounter % 7) + 1}`;
			const art = day - FIRST_DAY < 10 ? ART_OLD : ART_NEW;
			const bounce = first && rnd() < 0.2;
			const minutes = bounce ? 0.5 : 2 + rnd() * 28;
			// Today's sessions happen in the morning, so they're over by NOW.
			let t = day * DAY + Math.floor((day === TODAY ? 2 : 8 + rnd() * 10) * 3_600_000);
			const sessionStart = t;
			const end = t + Math.floor(minutes * 60_000);
			// Every 5th player is on servers running a kernel experiment pin (sexp = the pinned artifact id; "" = none).
			const base = { v: 1 as const, pid, sid, job, srv: "public", place: 1001, art, seq: art === ART_OLD ? 41 : 42, branch: "prod", channel: "prod", dev, newp: first, exp, sexp: i % 5 === 0 ? "pin-art-1" : "", src: "server" as const };
			let zone = "Lobby";
			let screen = "";
			const push = (kind: EventRow["kind"], name: string, props?: object, at = t) =>
				events.push({ ...base, t: at, kind, name, state: state(zone, screen), ...(props ? { props: JSON.stringify(props) } : {}) });
			push("session", "join", { from: "direct", age: "1-7d", prem: i % 4 === 0, friends: 0, ret: first ? -1 : 1, country: (["US", "GB", "BR"] as const)[i % 3], ...(i % 5 === 4 ? {} : { locale: i % 2 === 0 ? "en-us" : "pt-br" }) });
			if (first) push("experiment", "onboarding", { variant });
			// Onboarding funnel in the first session.
			if (first) {
				const go = variant === "short" ? 0.8 : 0.7;
				for (let step = 1; step <= 5; step++) {
					t += 5_000;
					if (t >= end) break;
					// step(funnel, index, name): props i (index) and step (name), as the framework writes them.
					push("funnel", "onboarding", { i: step, step: ["spawned", "moved", "opened_shop", "bought_item", "joined_round"][step - 1] });
					if (rnd() > go) break;
				}
			}
			// Confused first sessions: Shop opened and closed over and over (every 10th player), Lobby<->Arena back and forth (every 7th).
			if (first && !bounce && i % 10 === 3) {
				for (let k = 0; k < 4 && t + 4_000 < end; k++) {
					t += 2_000;
					screen = "Shop";
					push("state", "screen");
					t += 2_000;
					screen = "";
					push("state", "screen");
				}
			}
			if (first && !bounce && i % 7 === 2) {
				for (let k = 0; k < 4 && t + 3_000 < end; k++) {
					t += 3_000;
					zone = zone === "Lobby" ? "Arena" : "Lobby";
					push("zone", "enter", { zone });
				}
			}
			// Wander through zones until the end.
			while (t + 30_000 < end) {
				t += 20_000 + Math.floor(rnd() * 40_000);
				if (t >= end) break;
				const next = pick(ZONES);
				if (next !== zone) {
					zone = next;
					push("zone", "enter", { zone });
				} else {
					push("tech", "client_perf", { fps: 60 });
				}
				if (payer && sessionIndex === 0 && zone === "Shop" && !events.some((e) => e.pid === pid && e.kind === "purchase")) {
					push("purchase", "product", { product: 1234, robux: 99, where: "shop" });
				}
			}
			if (payer && sessionIndex === 1) push("purchase", "product", { product: 555, robux: 199, where: "shop" });
			push("session", "leave", { secs: Math.round((end - (day * DAY)) / 1000), why: "left" }, end);
			if (first && i % 25 === 0) {
				// A real tt-rec-1 recording in two chunks: 12 s standing still in the Lobby, then 3 presses of the same
				// button within a second.
				const start = sessionStart;
				const a = new RecWriter();
				for (let ms = 0; ms <= 12_000; ms += 100) a.sample(ms, 10, 3, -20, 0, 10, 8, -30, 0, -0.2);
				const b = new RecWriter();
				b.key(0, 1, 119);
				for (const dt of [100, 400, 700]) b.event(dt, 1, "Shop/Buy/Coins100");
				recordings.push({ v: 1, t: start, pid, sid, job, art, chunk: 0, codec: "tt-rec-1", data: a.finish(false), n: a.samples });
				recordings.push({ v: 1, t: start + 13_000, pid, sid, job, art, chunk: 1, codec: "tt-rec-1", data: b.finish(true), n: 0 });
			}
		});
	}
	// Game servers: heartbeats for the last 10 minutes (job-3 stopped 20 minutes ago) and two deploys.
	const hb = (job: string, t: number, q: number, extra: object = {}) =>
		events.push({
			v: 1,
			t,
			kind: "fleet",
			name: "heartbeat",
			job,
			art: q === 42 ? ART_NEW : ART_OLD,
			branch: "prod",
			src: "server",
			// The kernel's fleet status: t = server type, s and u unix seconds, sv = 2 (k is what must never come back out).
			props: JSON.stringify({ t: "public", b: "prod", c: "prod", a: q === 42 ? ART_NEW : ART_OLD, n: 10, m: 20, s: Math.floor((NOW - 3_600_000) / 1000), u: Math.floor(t / 1000), p: 1001, v: "0.3.2", q, g: 3, h: "ok", sv: 2, ...extra }),
		});
	for (let m = 10; m >= 0; m--) {
		hb("job-1", NOW - m * 60_000, 42);
		hb("job-2", NOW - m * 60_000 - 5_000, 42, { k: ACCESS_CODE });
		hb("job-4", NOW - m * 60_000 - 9_000, 41, { h: "degraded", e: "swap failed: boom" });
	}
	hb("job-3", NOW - 20 * 60_000, 42);
	const report = (seq: number, job: string, r: string, t: number, extra: object = {}) =>
		events.push({
			v: 1,
			t,
			kind: "fleet",
			name: "deploy_report",
			job,
			art: seq === 42 ? ART_NEW : ART_OLD,
			branch: "prod",
			src: "server",
			props: JSON.stringify({ s: seq, b: "prod", a: seq === 42 ? ART_NEW : ART_OLD, j: job, r, t, g: 3, k: "0.3.2", p: 10, d: 1.5, ...extra }),
		});
	for (const job of ["job-1", "job-2", "job-4"]) report(41, job, "swapped", NOW - 30 * 60_000);
	report(42, "job-1", "swapped", NOW - 15 * 60_000, { d: 1.2 });
	report(42, "job-2", "swapped", NOW - 15 * 60_000, { d: 2.4 });
	report(42, "job-4", "failed", NOW - 15 * 60_000, { e: "swap failed: boom", d: 0.4 });
	events.sort((a, b) => a.t - b.t);
	return { events, recordings };
}

/** An in-memory DuckDB with the fixture in tables `events` and `recordings`. */
export async function fixtureDb(fixture: Fixture): Promise<{ instance: DuckDBInstance; connection: DuckDBConnection }> {
	const instance = await DuckDBInstance.create(":memory:", { threads: "2" });
	const connection = await instance.connect();
	await connection.run(createTableSql("events", "events"));
	await connection.run(createTableSql("recordings", "recordings"));
	await insertRows(connection, "events", fixture.events);
	await insertRows(connection, "recordings", fixture.recordings);
	return { instance, connection };
}

/** Appends rows with DuckDB's appender, column by column in the stored order (contract fields, then rt = null). */
export async function insertRows(connection: DuckDBConnection, table: "events" | "recordings", rows: object[]): Promise<void> {
	const fields = fieldsOf(table);
	const appender = await connection.createAppender(table);
	for (const row of rows as Record<string, unknown>[]) {
		for (const field of fields) {
			const value = row[field.name];
			if (value === undefined || value === null) appender.appendNull();
			else if (field.type === "int32") appender.appendInteger(value as number);
			else if (field.type === "int64") appender.appendBigInt(BigInt(value as number));
			else if (field.type === "bool") appender.appendBoolean(value as boolean);
			else appender.appendVarchar(value as string);
		}
		appender.appendNull(); // rt
		appender.endRow();
	}
	appender.closeSync();
}
