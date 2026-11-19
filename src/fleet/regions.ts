/**
 * Roblox's own answer to "where is this server": `game.ServerRegion` (server only, 2026), the IATA code of the airport
 * nearest the data center that hosts it ("IAD", "LHR", "SYD"...; "" in Studio). The kernel sends it as the heartbeat's
 * optional top-level `region`. When a server has one it is the location's source of truth (geoSource "roblox"); the
 * IP lookup (fleet/geo.ts) is the fallback for older kernels (geoSource "ip").
 *
 * Roblox adds codes over time, so the list is open-ended: a code missing from REGION_AIRPORTS is still stored and shown
 * as itself, just without a city or coordinates. The coordinates are the metro area's (city level), like the IP
 * database's. The code is a display hint only and never used for anything security-related.
 */

/** A well-formed code: three uppercase letters, nothing else. */
export const REGION_CODE = /^[A-Z]{3}$/;

/** The heartbeat's `region` when it is a well-formed code, else null (missing, "", wrong shape: ignored). */
export function parseRegion(value: unknown): string | null {
	return typeof value === "string" && REGION_CODE.test(value) ? value : null;
}

export interface RegionAirport {
	city: string;
	/** The first subdivision (state, province), like the IP database's `region`; null where none is usual. */
	subdivision: string | null;
	/** ISO 3166-1 alpha-2. */
	country: string;
	countryName: string;
	lat: number;
	lon: number;
}

const a = (city: string, subdivision: string | null, country: string, countryName: string, lat: number, lon: number): RegionAirport => ({ city, subdivision, country, countryName, lat, lon });

/** Data-center airports Roblox (and the clouds it rents from) is known or likely to use, by IATA code. */
export const REGION_AIRPORTS: Readonly<Record<string, RegionAirport>> = Object.freeze({
	// North America
	IAD: a("Ashburn", "Virginia", "US", "United States", 39.04, -77.49),
	DCA: a("Washington", "District of Columbia", "US", "United States", 38.9, -77.04),
	ORD: a("Chicago", "Illinois", "US", "United States", 41.88, -87.63),
	DFW: a("Dallas", "Texas", "US", "United States", 32.78, -96.8),
	IAH: a("Houston", "Texas", "US", "United States", 29.76, -95.37),
	LAX: a("Los Angeles", "California", "US", "United States", 34.05, -118.24),
	SJC: a("San Jose", "California", "US", "United States", 37.34, -121.89),
	SFO: a("San Francisco", "California", "US", "United States", 37.77, -122.42),
	SEA: a("Seattle", "Washington", "US", "United States", 47.61, -122.33),
	PDX: a("Portland", "Oregon", "US", "United States", 45.52, -122.68),
	MIA: a("Miami", "Florida", "US", "United States", 25.76, -80.19),
	ATL: a("Atlanta", "Georgia", "US", "United States", 33.75, -84.39),
	EWR: a("Secaucus", "New Jersey", "US", "United States", 40.79, -74.06),
	JFK: a("New York", "New York", "US", "United States", 40.71, -74.01),
	BOS: a("Boston", "Massachusetts", "US", "United States", 42.36, -71.06),
	DEN: a("Denver", "Colorado", "US", "United States", 39.74, -104.99),
	PHX: a("Phoenix", "Arizona", "US", "United States", 33.45, -112.07),
	SLC: a("Salt Lake City", "Utah", "US", "United States", 40.76, -111.89),
	LAS: a("Las Vegas", "Nevada", "US", "United States", 36.17, -115.14),
	CMH: a("Columbus", "Ohio", "US", "United States", 39.96, -83.0),
	YYZ: a("Toronto", "Ontario", "CA", "Canada", 43.65, -79.38),
	YUL: a("Montreal", "Quebec", "CA", "Canada", 45.5, -73.57),
	YVR: a("Vancouver", "British Columbia", "CA", "Canada", 49.28, -123.12),
	MEX: a("Mexico City", null, "MX", "Mexico", 19.43, -99.13),
	QRO: a("Queretaro", "Queretaro", "MX", "Mexico", 20.59, -100.39),
	// South America
	GRU: a("Sao Paulo", "Sao Paulo", "BR", "Brazil", -23.55, -46.63),
	GIG: a("Rio de Janeiro", "Rio de Janeiro", "BR", "Brazil", -22.91, -43.17),
	SCL: a("Santiago", null, "CL", "Chile", -33.45, -70.67),
	EZE: a("Buenos Aires", null, "AR", "Argentina", -34.6, -58.38),
	BOG: a("Bogota", null, "CO", "Colombia", 4.71, -74.07),
	LIM: a("Lima", null, "PE", "Peru", -12.05, -77.04),
	// Europe
	LHR: a("London", "England", "GB", "United Kingdom", 51.51, -0.13),
	AMS: a("Amsterdam", "North Holland", "NL", "Netherlands", 52.37, 4.9),
	FRA: a("Frankfurt", "Hesse", "DE", "Germany", 50.11, 8.68),
	CDG: a("Paris", "Ile-de-France", "FR", "France", 48.86, 2.35),
	MRS: a("Marseille", "Provence-Alpes-Cote d'Azur", "FR", "France", 43.3, 5.37),
	DUB: a("Dublin", null, "IE", "Ireland", 53.35, -6.26),
	MAD: a("Madrid", null, "ES", "Spain", 40.42, -3.7),
	MXP: a("Milan", "Lombardy", "IT", "Italy", 45.46, 9.19),
	WAW: a("Warsaw", null, "PL", "Poland", 52.23, 21.01),
	ARN: a("Stockholm", null, "SE", "Sweden", 59.33, 18.07),
	CPH: a("Copenhagen", null, "DK", "Denmark", 55.68, 12.57),
	HEL: a("Helsinki", null, "FI", "Finland", 60.17, 24.94),
	OSL: a("Oslo", null, "NO", "Norway", 59.91, 10.75),
	ZRH: a("Zurich", null, "CH", "Switzerland", 47.38, 8.54),
	VIE: a("Vienna", null, "AT", "Austria", 48.21, 16.37),
	BRU: a("Brussels", null, "BE", "Belgium", 50.85, 4.35),
	PRG: a("Prague", null, "CZ", "Czechia", 50.08, 14.44),
	IST: a("Istanbul", null, "TR", "Turkey", 41.01, 28.98),
	// Middle East and Africa
	DXB: a("Dubai", null, "AE", "United Arab Emirates", 25.2, 55.27),
	TLV: a("Tel Aviv", null, "IL", "Israel", 32.09, 34.78),
	JNB: a("Johannesburg", "Gauteng", "ZA", "South Africa", -26.2, 28.05),
	// Asia
	NRT: a("Tokyo", "Tokyo", "JP", "Japan", 35.68, 139.69),
	HND: a("Tokyo", "Tokyo", "JP", "Japan", 35.68, 139.69),
	KIX: a("Osaka", "Osaka", "JP", "Japan", 34.69, 135.5),
	ICN: a("Seoul", null, "KR", "South Korea", 37.57, 126.98),
	SIN: a("Singapore", null, "SG", "Singapore", 1.35, 103.82),
	HKG: a("Hong Kong", null, "HK", "Hong Kong", 22.32, 114.17),
	TPE: a("Taipei", null, "TW", "Taiwan", 25.03, 121.57),
	BOM: a("Mumbai", "Maharashtra", "IN", "India", 19.08, 72.88),
	DEL: a("Delhi", "Delhi", "IN", "India", 28.61, 77.21),
	MAA: a("Chennai", "Tamil Nadu", "IN", "India", 13.08, 80.27),
	BKK: a("Bangkok", null, "TH", "Thailand", 13.76, 100.5),
	CGK: a("Jakarta", null, "ID", "Indonesia", -6.21, 106.85),
	MNL: a("Manila", null, "PH", "Philippines", 14.6, 120.98),
	KUL: a("Kuala Lumpur", null, "MY", "Malaysia", 3.14, 101.69),
	// Oceania
	SYD: a("Sydney", "New South Wales", "AU", "Australia", -33.87, 151.21),
	MEL: a("Melbourne", "Victoria", "AU", "Australia", -37.81, 144.96),
	PER: a("Perth", "Western Australia", "AU", "Australia", -31.95, 115.86),
	AKL: a("Auckland", null, "NZ", "New Zealand", -36.85, 174.76),
});

/** The airport behind a code, or null (an unknown code: shown as itself, no city or coordinates). */
export function regionAirport(code: string | null | undefined): RegionAirport | null {
	if (!code || !Object.hasOwn(REGION_AIRPORTS, code)) return null;
	return REGION_AIRPORTS[code] ?? null;
}
