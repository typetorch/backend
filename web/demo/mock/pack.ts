/**
 * Facts from the data pack for the mocks that aren't analytics queries (fleet, deploys, errors, players, experiments...),
 * so their pages line up with the analytics pages without loading DuckDB: the same job ids, pids, artifacts, deploy seqs,
 * branches, server types, error messages and event vocabulary.
 *
 *   const p = await pack();
 *   p.jobs.filter((j) => j.live)          // servers running "now" (the pack's day moved onto today)
 *   p.player(pid), p.job(job), p.artifact(art)
 *   p.vocabulary.props.item               // [{ value: "sledgehammer", n: 1666 }, ...] (also team, quest, weapon, cause...)
 *
 * Every time (firstAt, lastAt, t, startedAt) is already shifted by whole days so the pack's last day is today (UTC), and
 * nothing that starts after now is listed; lastAt is capped at now. Times inside raw `props` strings are NOT shifted (use
 * shiftMs() / shiftSeconds() from ./data). For anything else, ask the engine: `sql("SELECT ... FROM events ...")` (loads
 * DuckDB-WASM, seconds on the first call; prefer the facts where they are enough).
 */
import { loadSpan, now, readDataJson, shiftFor } from "./data";

export interface PackJob {
	job: string;
	place: number | null;
	art: string | null;
	seq: number | null;
	branch: string | null;
	channel: string | null;
	/** Server type: public, reserved, studio. */
	srv: string | null;
	firstAt: number;
	lastAt: number;
	/** Running now: started before now and its rows reach past now (on the pack's shifted timeline). */
	live: boolean;
	rows: number;
	players: number;
	sessions: number;
	/** The most players a heartbeat reported (null: no heartbeat, e.g. Studio). */
	maxPlayers: number | null;
	/** The server's player slots (heartbeat `m`). */
	maxSlots: number | null;
	kernel: string | null;
	/** The server's start (heartbeat `s`), shifted. */
	startedAt: number | null;
	errors: number;
}

export interface PackArtifact {
	art: string;
	seq: number | null;
	branch: string | null;
	firstAt: number;
	lastAt: number;
	jobs: number;
	players: number;
}

export interface PackPlayer {
	pid: string;
	firstAt: number;
	lastAt: number;
	sessions: number;
	events: number;
	dev: string | null;
	/** The pid's first session falls in the pack's window. */
	newInWindow: boolean;
	country: string | null;
	age: string | null;
	premium: boolean | null;
	/** The team they played most (inmate, guard, medic...), from props. */
	team: string | null;
	level: number | null;
	errors: number;
	purchases: number;
}

export interface PackDeployReport {
	t: number;
	job: string;
	art: string;
	seq: number;
	branch: string;
	srv: string;
	/** Raw JSON (times inside unshifted): a artifact, s seq, b branch, r result, d seconds, k kernel, t unix seconds... */
	props: string;
}

export interface PackError {
	msg: string;
	src: string | null;
	/** Rows (error events) and their summed counts. */
	n: number;
	total: number;
	players: number;
	servers: number;
	firstAt: number;
	lastAt: number;
	arts: string[];
	branches: string[];
	dev: string | null;
}

export interface PackExperiment {
	experiment: string;
	variant: string | null;
	players: number;
	firstAt: number;
	lastAt: number;
}

export interface PackVocabulary {
	events: { kind: string; name: string; n: number; players: number }[];
	/** Top values per props key: team, item, quest, weapon, cause, job, type, reason, ui, source, variant, step, why, from, to, country, age. */
	props: Record<string, { value: string; n: number }[]>;
	/** Player states ("screen:missions|activity:inmate") by count. */
	states: { state: string; n: number }[];
}

interface Facts {
	format: 1;
	meta: { placeId: number; universeId: number; firstT: number; lastT: number; events: number; players: number; recordings: { sessions: number; players: number; chunks: number } };
	jobs: Omit<PackJob, "live">[];
	artifacts: PackArtifact[];
	players: PackPlayer[];
	deployReports: PackDeployReport[];
	errors: PackError[];
	vocabulary: PackVocabulary;
	experiments: PackExperiment[];
}

export interface Pack {
	placeId: number;
	universeId: number;
	/** Now (the demo clock) and the shift applied (ms). */
	now: number;
	shiftMs: number;
	/** The shifted span of the data: first row, and now. */
	from: number;
	to: number;
	totals: Facts["meta"];
	/** Oldest first. */
	jobs: PackJob[];
	artifacts: PackArtifact[];
	players: PackPlayer[];
	deployReports: PackDeployReport[];
	/** Most rows first. */
	errors: PackError[];
	experiments: PackExperiment[];
	vocabulary: PackVocabulary;
	job(job: string): PackJob | undefined;
	player(pid: string): PackPlayer | undefined;
	artifact(art: string): PackArtifact | undefined;
	/** The artifact a branch ran at a time (the newest one seen there by then). */
	artifactAt(branch: string, at: number): PackArtifact | undefined;
}

let cached: { day: number; minute: number; pack: Pack } | undefined;

/** The pack's facts for the current clock (rebuilt at most once a minute). */
export async function pack(): Promise<Pack> {
	const facts = await readDataJson<Facts>("facts.json");
	await loadSpan();
	const at = now();
	const minute = Math.floor(at / 60_000);
	if (cached && cached.minute === minute) return cached.pack;
	const shift = shiftFor(facts.meta.lastT, at);
	const cap = (t: number) => Math.min(t, at);
	const jobs: PackJob[] = facts.jobs
		.filter((j) => j.firstAt + shift <= at)
		.map((j) => ({
			...j,
			firstAt: j.firstAt + shift,
			lastAt: cap(j.lastAt + shift),
			live: j.lastAt + shift >= at - 2 * 60_000,
			startedAt: j.startedAt === null ? null : j.startedAt + shift,
		}));
	const artifacts = facts.artifacts.filter((a) => a.firstAt + shift <= at).map((a) => ({ ...a, firstAt: a.firstAt + shift, lastAt: cap(a.lastAt + shift) }));
	const players = facts.players.filter((p) => p.firstAt + shift <= at).map((p) => ({ ...p, firstAt: p.firstAt + shift, lastAt: cap(p.lastAt + shift) }));
	const deployReports = facts.deployReports.filter((r) => r.t + shift <= at).map((r) => ({ ...r, t: r.t + shift }));
	const errors = facts.errors.filter((e) => e.firstAt + shift <= at).map((e) => ({ ...e, firstAt: e.firstAt + shift, lastAt: cap(e.lastAt + shift) }));
	const experiments = facts.experiments.filter((e) => e.firstAt + shift <= at).map((e) => ({ ...e, firstAt: e.firstAt + shift, lastAt: cap(e.lastAt + shift) }));
	const byJob = new Map(jobs.map((j) => [j.job, j]));
	const byPid = new Map(players.map((p) => [p.pid, p]));
	const byArt = new Map(artifacts.map((a) => [a.art, a]));
	const p: Pack = {
		placeId: facts.meta.placeId,
		universeId: facts.meta.universeId,
		now: at,
		shiftMs: shift,
		from: facts.meta.firstT + shift,
		to: at,
		totals: facts.meta,
		jobs,
		artifacts,
		players,
		deployReports,
		errors,
		experiments,
		vocabulary: facts.vocabulary,
		job: (job) => byJob.get(job),
		player: (pid) => byPid.get(pid),
		artifact: (art) => byArt.get(art),
		artifactAt: (branch, t) => {
			let found: PackArtifact | undefined;
			for (const a of artifacts) if (a.branch === branch && a.firstAt <= t && (!found || a.firstAt >= found.firstAt)) found = a;
			return found;
		},
	};
	cached = { day: Math.floor(at / 86_400_000), minute, pack: p };
	return p;
}

/** Forgets the cached facts (tests that move the clock). */
export function resetPackCache(): void {
	cached = undefined;
}
