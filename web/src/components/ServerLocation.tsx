/**
 * Where a game server is (the backend looks its public address up in an offline IP database, fleet/geo.ts): the country
 * as its ISO code in a small chip (no flag emoji), the city and region next to it, and the credit line the database's
 * licence asks for (DB-IP Lite: CC BY 4.0) wherever locations are shown.
 */
import type { FleetServer, GeoStatus, ServerLocation } from "@/lib/types";

/** "Sterling, Virginia" (the place under the country), or null. */
export function placeText(loc: ServerLocation | null | undefined): string | null {
	if (!loc) return null;
	const parts = [loc.city, loc.region].filter((p): p is string => !!p && p.length > 0);
	// A region equal to the city ("Singapore, Singapore") says it once.
	const unique = parts.filter((p, i) => parts.indexOf(p) === i);
	return unique.length ? unique.join(", ") : null;
}

/** One line: "Sterling, Virginia, US", "Japan", or "–". */
export function locationText(loc: ServerLocation | null | undefined): string {
	if (!loc) return "–";
	const place = placeText(loc);
	if (place) return loc.country ? `${place}, ${loc.country}` : place;
	return loc.countryName ?? loc.country ?? "–";
}

/** The tooltip: the full country name, the place, the coordinates and the network. */
export function locationTitle(loc: ServerLocation | null | undefined): string | undefined {
	if (!loc) return undefined;
	const lines = [[placeText(loc), loc.countryName ?? loc.country].filter(Boolean).join(", ")];
	if (loc.lat !== null && loc.lon !== null) lines.push(`about ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`);
	if (loc.asn !== null || loc.org) lines.push(`network ${[loc.asn !== null ? `AS${loc.asn}` : null, loc.org].filter(Boolean).join(" ")}`);
	return lines.filter(Boolean).join(" | ");
}

/** "AS22697 Roblox", or null. */
export function networkText(loc: ServerLocation | null | undefined): string | null {
	if (!loc || (loc.asn === null && !loc.org)) return null;
	return [loc.asn !== null ? `AS${loc.asn}` : null, loc.org].filter(Boolean).join(" ");
}

export function CountryCode({ code, name }: { code: string | null | undefined; name?: string | null }) {
	if (!code) return <span className="text-muted-foreground">–</span>;
	return (
		<span className="inline-block rounded border px-1 font-mono text-[10px] leading-4 font-medium tracking-wide" title={name ?? undefined} aria-label={name ? `${name} (${code})` : code}>
			{code}
		</span>
	);
}

/** The country chip and the place: "[US] Sterling, Virginia". */
export function LocationLabel({ location }: { location: ServerLocation | null | undefined }) {
	if (!location) return <span className="text-muted-foreground">unknown</span>;
	const place = placeText(location);
	return (
		<span className="inline-flex items-center gap-1.5" title={locationTitle(location)}>
			<CountryCode code={location.country} name={location.countryName} />
			<span>{place ?? location.countryName ?? ""}</span>
		</span>
	);
}

/** The credit line (DB-IP's licence asks for it where its data is shown); nothing for a source that needs none. */
export function GeoCredit({ geo }: { geo: GeoStatus | null | undefined }) {
	if (!geo || geo.state !== "ready" || !geo.attribution) return null;
	return (
		<p className="text-xs text-muted-foreground">
			Locations are approximate.{" "}
			{geo.attributionUrl ? (
				<a href={geo.attributionUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
					{geo.attribution}
				</a>
			) : (
				geo.attribution
			)}
			{geo.attributionUrl?.includes("db-ip.com") ? " (CC BY 4.0)." : "."}
		</p>
	);
}

export interface CountryCount {
	country: string;
	countryName: string | null;
	servers: number;
	players: number;
	/** The places servers are in, most servers first. */
	places: string[];
}

/** Servers by country, most first ("??" for servers with no known location). */
export function countryCounts(servers: readonly FleetServer[]): CountryCount[] {
	const out = new Map<string, CountryCount & { placeCounts: Map<string, number> }>();
	for (const s of servers) {
		const code = s.location?.country ?? "??";
		const row = out.get(code) ?? { country: code, countryName: s.location?.countryName ?? (code === "??" ? "Unknown" : null), servers: 0, players: 0, places: [], placeCounts: new Map<string, number>() };
		row.servers++;
		row.players += s.players ?? 0;
		const place = placeText(s.location);
		if (place) row.placeCounts.set(place, (row.placeCounts.get(place) ?? 0) + 1);
		out.set(code, row);
	}
	return [...out.values()]
		.map(({ placeCounts, ...row }) => ({ ...row, places: [...placeCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p) }))
		.sort((a, b) => b.servers - a.servers || a.country.localeCompare(b.country));
}
