/**
 * /live (plans/34): every live server's players at once on the exported map, coloured per server, with a list per
 * server. The page holds the fleet-wide live map watch (POST /v1/fleet/live-map/watch every 20 s; it lapses a minute
 * after the page goes): while it holds, kernels 0.6.0+ post their positions every 3 s, and the page reads the latest of
 * each server every 3 s, moving each dot between its last two frames.
 *
 * Positions and names stay in this page's memory (never the query cache, localStorage or the URL). Owners only: the
 * read-only role gets a note (the backend refuses it).
 */
import { useMemo } from "react";
import { PageHeader } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isReadOnly, useAuth } from "@/lib/auth";
import { colorFor, isPlaced, LIVE_DELAY_MS, type LiveDot, playersAt, renderTime } from "@/lib/live-map";
import { type LiveServer, useLiveMap, useTicker } from "@/lib/live-streams";
import { LiveMap, type LiveGroup } from "./live/LiveMap";
import { JobLink } from "./server/shared";

export const LIVE_READ_ONLY_TEXT = "The live map shows players' names and positions: owners only.";

/** Every server's dots at the page's clock `now`, coloured per server (exported for the tests). */
export function liveDots(servers: readonly LiveServer[], now: number): LiveDot[] {
	const out: LiveDot[] = [];
	for (const s of servers) {
		const newest = s.frames[s.frames.length - 1];
		if (!newest) continue;
		const at = renderTime(newest.t, now - s.arrivedAt, LIVE_DELAY_MS);
		for (const p of playersAt(s.frames, at)) {
			if (isPlaced(p)) out.push({ key: `${s.job}:${p.u}`, name: p.n, x: p.x, y: p.y, z: p.z, color: colorFor(s.job), group: s.job });
		}
	}
	return out;
}

export default function LivePage() {
	const readOnly = isReadOnly(useAuth());
	const live = useLiveMap(!readOnly);
	const now = useTicker(live.servers.length > 0);
	const dots = useMemo(() => liveDots(live.servers, now), [live.servers, now]);
	const groups: LiveGroup[] = live.servers.map((s) => ({
		id: s.job,
		color: colorFor(s.job),
		label: (
			<span className="flex flex-wrap items-baseline gap-1.5">
				<JobLink job={s.job} />
				<span className="font-normal text-muted-foreground">
					{s.branch ?? "–"} · {s.artifact ?? "–"}
				</span>
			</span>
		),
	}));
	const players = live.servers.reduce((n, s) => n + (s.frames[s.frames.length - 1]?.s.positions?.players.length ?? 0), 0);
	return (
		<>
			<PageHeader
				title="Live map"
				description={
					readOnly
						? LIVE_READ_ONLY_TEXT
						: `Every live server's players on the exported map, coloured per server (a frame every 3 s per server, kernel 0.6.0+). ${live.servers.length} server${live.servers.length === 1 ? "" : "s"}, ${players} player${players === 1 ? "" : "s"}.`
				}
			/>
			{readOnly ? (
				<Alert>
					<AlertTitle>Owners only</AlertTitle>
					<AlertDescription>{LIVE_READ_ONLY_TEXT}</AlertDescription>
				</Alert>
			) : (
				<>
					{live.watchError || live.error ? (
						<p role="alert" className="text-sm text-destructive">
							{live.watchError ?? live.error}
						</p>
					) : null}
					{live.loaded && !live.servers.length ? (
						<p className="text-sm text-muted-foreground">No positions yet: servers start posting within seconds of this page opening (kernels before 0.6.0 never do).</p>
					) : null}
					<LiveMap dots={dots} groups={groups} label="Live map of every server" empty={live.loaded ? "No players with a character right now." : "Waiting for the servers..."} />
				</>
			)}
		</>
	);
}
