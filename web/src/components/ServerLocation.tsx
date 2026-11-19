/**
 * Where a game server is: its Roblox region (game.ServerRegion, an airport code like "IAD", the backend maps it to a
 * city) when the kernel sends one, else the backend's lookup of its public address in an offline IP database
 * (fleet/geo.ts). The region code first, then the country as its ISO code in a small chip (no flag emoji) and the
 * place, a quiet note of the source, and the credit line the IP database's licence asks for (DB-IP Lite: CC BY 4.0)
 * wherever its locations are shown.
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

/** What the location helpers need from a server. */
export type Located = Pick<FleetServer, "location" | "region" | "geoSource">;

/** One line: "IAD · Ashburn, US" with a region, "Sterling, Virginia, US", "Japan", "QQQ" (an unknown code), or "–". */
export function locationText(loc: ServerLocation | null | undefined, region?: string | null): string {
	if (region) {
		const place = loc ? (loc.city ? (loc.country ? `${loc.city}, ${loc.country}` : loc.city) : (loc.countryName ?? loc.country)) : null;
		return place ? `${region} · ${place}` : region;
	}
	if (!loc) return "–";
	const place = placeText(loc);
	if (place) return loc.country ? `${place}, ${loc.country}` : place;
	return loc.countryName ?? loc.country ?? "–";
}

/** Whether the location is the IP database's estimate (older backends send no geoSource: theirs always is). */
export function isIpEstimate(s: Located): boolean {
	return !!s.location && !s.region && s.geoSource !== "roblox";
}

/** Whether a server has anything to show where (a location, or a region code alone). */
export function hasLocation(s: Located): boolean {
	return !!s.location || !!s.region;
}

/** The tooltip: the source, the full country name, the place, the coordinates and the network. */
export function locationTitle(loc: ServerLocation | null | undefined, region?: string | null): string | undefined {
	if (!loc && !region) return undefined;
	const source = region ? `Roblox server region ${region}` : "estimated from the server's IP address";
	if (!loc) return `${source} (an airport code this backend has no city for yet)`;
	const lines = [source, [placeText(loc), loc.countryName ?? loc.country].filter(Boolean).join(", ")];
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

/**
 * The region code, the country chip and the place, and a quiet source note: "IAD · [US] Ashburn  Roblox" from a Roblox
 * region, "[US] Sterling, Virginia  IP est." from the IP database, "QQQ  Roblox" for a code with no city yet.
 */
export function LocationLabel({ location, region, geoSource }: { location: ServerLocation | null | undefined; region?: string | null; geoSource?: Located["geoSource"] }) {
	if (!location && !region) return <span className="text-muted-foreground">unknown</span>;
	const fromRoblox = !!region || geoSource === "roblox";
	const place = location ? (region ? (location.city ?? location.countryName) : (placeText(location) ?? location.countryName)) : null;
	return (
		<span className="inline-flex items-center gap-1.5" title={locationTitle(location, region)}>
			{region ? (
				<>
					<span className="font-mono text-[11px] font-medium">{region}</span>
					{location ? <span className="text-muted-foreground" aria-hidden="true">·</span> : null}
				</>
			) : null}
			{location ? <CountryCode code={location.country} name={location.countryName} /> : null}
			{place ? <span>{place}</span> : null}
			<span className="text-[10px] text-muted-foreground">{fromRoblox ? "Roblox" : "IP est."}</span>
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
