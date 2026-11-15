/**
 * The move from another server (GET / POST /v1/admin/migrate): plain helpers the Migration card on the Settings page,
 * the history banner on the analytics pages and their tests share.
 */
import type { IngestPressure, MigrateAction, MigrateDay, MigrateState, MigrateStatus } from "./types";

/** One cache entry for the card and the banner: the card's polls keep the banner current. */
export const MIGRATE_KEY = ["admin-migrate"] as const;

/** States in which a move is under way (the banner shows, the card polls fast while running or waiting). */
const ACTIVE: ReadonlySet<MigrateState> = new Set(["running", "paused", "waiting"]);

/** Day states that are finished (checked against the source, whatever the outcome). */
const DAY_DONE: ReadonlySet<MigrateDay["state"]> = new Set(["match", "missing", "differs", "duplicates"]);

export function dayDone(day: Pick<MigrateDay, "state">): boolean {
	return DAY_DONE.has(day.state);
}

/** Days not checked yet (pending or importing). */
export function daysLeft(days: readonly Pick<MigrateDay, "state">[]): number {
	return days.filter((d) => !dayDone(d)).length;
}

/** How often the card asks: every 5 s while the move runs or waits, else every minute. */
export function migratePollMs(state: MigrateState | undefined): number {
	return state === "running" || state === "waiting" ? 5_000 : 60_000;
}

/** The buttons a state offers (the backend answers 409 when one doesn't apply after all). */
export function migrateActions(state: MigrateState): MigrateAction[] {
	switch (state) {
		case "running":
		case "waiting":
			return ["pause", "cancel"];
		case "paused":
		case "failed":
			return ["resume", "cancel"];
		case "needs_decision":
			return ["cancel"];
		default:
			return [];
	}
}

/** The source's host for a sentence ("old.example.com"), or "the old server" when the URL doesn't parse. */
export function sourceHost(status: Pick<MigrateStatus, "source">): string {
	const url = status.source?.url;
	if (!url) return "the old server";
	try {
		return new URL(url).host || "the old server";
	} catch {
		return "the old server";
	}
}

/**
 * The analytics pages' banner while a move still imports event history: "History before <day> still importing" (the
 * oldest events day already done), else "History is still importing from <host>". Null when nothing is importing.
 */
export function historyBannerText(status: MigrateStatus | null | undefined): string | null {
	if (!status || !ACTIVE.has(status.state)) return null;
	const events = (status.days ?? []).filter((d) => d.table === "events");
	if (!events.some((d) => !dayDone(d))) return null;
	const done = events
		.filter(dayDone)
		.map((d) => d.day)
		.sort();
	return done.length ? `History before ${done[0]} still importing` : `History is still importing from ${sourceHost(status)}`;
}

/** Whether the backend answered busy (503) to ingest in the minute before its own clock. */
export function recentlyBusy(ingest: IngestPressure | null | undefined, now: number, withinMs = 60_000): boolean {
	const at = ingest?.lastBusyAt;
	return typeof at === "number" && at <= now + 1_000 && now - at <= withinMs;
}
