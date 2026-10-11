/** A player's name linking to their Players page (side sheets that list players: Errors, Experiments). */
import { Link, useLocation } from "react-router";
import { FILTER_KEYS } from "@/lib/filters";
import { shortId } from "@/lib/format";

/** What a players list knows about one player: the pid, and the Roblox names when the server has them. */
export interface NamedPlayer {
	pid: string;
	name?: string;
	displayName?: string;
}

/** "Display (@name)", "@name", or the short pid when the server knows no name. */
export function playerLabel(p: NamedPlayer): string {
	if (!p.name) return shortId(p.pid, 10);
	return p.displayName && p.displayName !== p.name ? `${p.displayName} (@${p.name})` : `@${p.name}`;
}

/** The Players page for one pid, keeping the explorer's shared filters that are in the URL. */
export function PlayerPageLink({ row }: { row: NamedPlayer }) {
	const { search } = useLocation();
	const current = new URLSearchParams(search);
	const params = new URLSearchParams();
	for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
	params.set("pid", row.pid);
	return (
		<Link to={{ pathname: "/players", search: `?${params.toString()}` }} className="font-medium underline-offset-2 hover:underline" title={`Open player ${row.pid}`}>
			{playerLabel(row)}
		</Link>
	);
}
