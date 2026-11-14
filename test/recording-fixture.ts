/**
 * A synthetic round-based game for the recordings explorer: a lobby at the origin and two maps far apart (Forest around
 * (1000, 1000), Desert around (-2000, 500)), servers announcing each round with a server-level `round_start {map}`, and
 * recorded first sessions (real tt-rec-1 chunks) that end in known ways, by `k % 8`:
 *   0 left: Shop screen open, three presses of Shop/Buy/Coins100 that change no screen
 *   1 left: died (a death record and a positioned `down {cause: zombie}`) shortly before leaving
 *   2 left: idle for 17 s, still in the tutorial (step 1 of 3)
 *   3 left: stuck (pressing W, not moving)
 *   4-7 stayed (recording ended by its 60 s window): walking, a HUD button, a prompt, the full tutorial, a later
 *       positioned `down {cause: fall}` after the recording
 * Sessions 0-7 play Forest, 8-15 Desert, and so on.
 * Builds: ART_NEW players start walking in the lobby after 2 s; ART_OLD players stand until the round teleports them.
 */
import type { EventRow, RecordingRow } from "../src/schema.ts";
import { RecWriter } from "./recwriter.ts";

export const RF_DAY = 86_400_000;
/** 2026-10-05 12:00 UTC (as the main fixture). */
export const RF_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const RF_ART_OLD = "a1b2c3d-111111";
export const RF_ART_NEW = "e4f5a6b-222222";
export const MAP_CENTERS: Record<string, [number, number]> = { Forest: [1000, 1000], Desert: [-2000, 500] };
export const MAPS = Object.keys(MAP_CENTERS);
const LOBBY: [number, number] = [0, 0];
const SPACING_MS = 90_000;
const JOBS = 4;

export interface RecordingFixture {
	events: EventRow[];
	recordings: RecordingRow[];
	/** Per session: what it was built as. */
	sessions: { sid: string; pid: string; k: number; group: number; map: string; job: string; art: string; dev: string; start: number; left: boolean }[];
}

interface Sample {
	t: number;
	x: number;
	z: number;
}

/** `count` sessions, the first starting `startMs` (default: 2 days before RF_NOW). */
export function recordingFixture(count = 40, startMs = RF_NOW - 2 * RF_DAY): RecordingFixture {
	const events: EventRow[] = [];
	const recordings: RecordingRow[] = [];
	const sessions: RecordingFixture["sessions"] = [];
	for (let k = 0; k < count; k++) {
		const group = k % 8;
		const left = group < 4;
		const map = MAPS[(k >> 3) % 2];
		const [mx, mz] = MAP_CENTERS[map];
		const job = `rjob-${k % JOBS}`;
		const art = k % 2 === 0 ? RF_ART_NEW : RF_ART_OLD;
		const dev = k % 3 === 0 ? "phone" : "desktop";
		const pid = `rp${String(k).padStart(5, "0")}`;
		const sid = `rs${String(k).padStart(5, "0")}`;
		const S = startMs + k * SPACING_MS;
		sessions.push({ sid, pid, k, group, map, job, art, dev, start: S, left });
		const base = { v: 1 as const, job, srv: "public", place: 1001, art, seq: art === RF_ART_OLD ? 41 : 42, branch: "prod", channel: "prod", exp: "{}", sexp: "", src: "server" as const };
		let state = "zone:Lobby|activity:idle";
		const ev = (t: number, kind: EventRow["kind"], name: string, props?: object, extra: Partial<EventRow> = {}) =>
			events.push({ ...base, pid, sid, dev: dev as EventRow["dev"], newp: true, t: S + t, kind, name, state, ...(props ? { props: JSON.stringify(props) } : {}), ...extra });
		const server = (t: number, name: string, props: object) =>
			events.push({ ...base, pid: "", sid: "", t: S + t, kind: "custom", name, state: "", props: JSON.stringify(props) });

		// Positions and inputs, ms after S.
		const samples: Sample[] = [];
		const inputs: { t: number; kind: "key" | "event"; code: number; text?: string }[] = [];
		const end = left ? [23_000, 24_000, 25_000, 22_000][group] : 40_000;
		const ox = mx + (k % 7) * 5;
		const oz = mz + (k % 5) * 4;
		let x = LOBBY[0] + (k % 4);
		let z = LOBBY[1];
		for (let t = 0; t <= end; t += 100) {
			if (t < 5_000) {
				if (art === RF_ART_NEW && t >= 2_000) x += 0.5;
			} else if (t === 5_000) {
				x = ox;
				z = oz;
			} else {
				const walking = group === 4 || group === 5 || group === 6 || group === 7 ? t < 35_000 : group === 0 ? t < 15_000 : group === 1 ? t < 19_000 : group === 2 ? t < 8_000 : false;
				if (walking) x += 0.4;
			}
			samples.push({ t, x, z });
		}
		inputs.push({ t: 0, kind: "event", code: 9 }); // spawned
		if (art === RF_ART_NEW) inputs.push({ t: 1_900, kind: "key", code: 119 });
		if (group !== 2) for (let t = 6_000; t < Math.min(end, 35_000); t += 1_000) inputs.push({ t, kind: "key", code: 119 });
		if (group === 0) {
			inputs.push({ t: 16_500, kind: "key", code: 101 }, { t: 17_000, kind: "event", code: 3, text: "Shop" });
			for (const t of [19_000, 20_000, 21_000]) inputs.push({ t, kind: "event", code: 1, text: "Shop/Buy/Coins100" });
		}
		if (group === 1) inputs.push({ t: 20_000, kind: "event", code: 8 });
		if (group >= 4) inputs.push({ t: 7_000, kind: "event", code: 1, text: "HUD/Play" }, { t: 12_000, kind: "event", code: 7, text: "Workspace/Crate/Prompt" });
		inputs.sort((a, b) => a.t - b.t);

		// Chunks of 10 s.
		const chunkCount = Math.ceil((end + 1) / 10_000);
		for (let c = 0; c < chunkCount; c++) {
			const from = c * 10_000;
			const to = from + 10_000;
			const w = new RecWriter();
			type Rec = { t: number; f: () => void };
			const recs: Rec[] = [];
			for (const s of samples) if (s.t >= from && s.t < to) recs.push({ t: s.t, f: () => w.sample(s.t - from, s.x, 3, s.z, 0, s.x, 8, s.z + 10, 0, -0.3) });
			for (const i of inputs) {
				if (i.t < from || i.t >= to) continue;
				recs.push({ t: i.t + 0.5, f: () => (i.kind === "key" ? w.key(i.t - from, 1, i.code) : w.event(i.t - from, i.code, i.text)) });
			}
			recs.sort((a, b) => a.t - b.t);
			for (const r of recs) r.f();
			recordings.push({ v: 1, t: S + from, pid, sid, job, art, chunk: c, codec: "tt-rec-1", data: w.finish(c === chunkCount - 1), n: w.samples });
		}

		// Events.
		ev(0, "session", "join", { from: "direct" });
		ev(1, "recording_meta", "start", { share: 1 });
		ev(1_000, "funnel", "tutorial", { i: 1, step: "spawn" });
		if (k % 5 === 0) events.push({ ...base, pid, sid, dev: dev as EventRow["dev"], newp: true, t: S + 2_000, kind: "custom", name: "buy", state, props: JSON.stringify({ item: "hat", px: LOBBY[0] + 2, py: 3, pz: LOBBY[1] + 1 }) });
		server(5_000, "round_start", { map, round: k, players: 4, difficulty: "normal" });
		state = "zone:Arena|activity:round";
		ev(5_000, "zone", "enter", { zone: "Arena", from: "Lobby" });
		if (group !== 2) {
			ev(9_000, "funnel", "tutorial", { i: 2, step: "move" });
			ev(14_000, "funnel", "tutorial", { i: 3, step: "done" });
		}
		if (group === 0) {
			state = "zone:Arena|screen:Shop|activity:round";
			ev(17_000, "state", "screen", { to: "Shop", from: "" });
		}
		if (group === 1) ev(20_000, "custom", "down", { map, cause: "zombie", cause_kind: "npc", wave: 1, phase: "fight", px: samples.at(-1)?.x, py: 3, pz: samples.at(-1)?.z });
		ev(end, "recording_meta", "end", { why: left ? "left" : "window", chunks: chunkCount, bytes: 1000 });
		if (left) ev(end + 200, "session", "leave", { secs: Math.round(end / 1000), why: "left" });
		else {
			ev(70_000, "custom", "down", { map, cause: "fall", cause_kind: "world", wave: 2, phase: "fight", px: ox + 20, py: 3, pz: oz - 10 });
			ev(80_000, "session", "leave", { secs: 80, why: "left" });
		}
		server(85_000, "round_result", { map, survived: !left, kills: 3 });
	}
	events.sort((a, b) => a.t - b.t);
	return { events, recordings, sessions };
}
