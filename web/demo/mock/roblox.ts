/**
 * What the backend asks Roblox for (src/server/roblox-products.ts, roblox-analytics.ts), answered in the browser: the
 * demo never calls Roblox.
 *
 *   GET /v1/roblox/products?gamepass&product        The Prison's game passes and developer products, by the ids the pack's
 *                                                   purchase events carry (Prison-flavored names, real prices from the
 *                                                   events where they were bought); never an icon (no roblox.com images)
 *   GET /v1/roblox/analytics/acquisition?days       Creator Hub's play-through rate, impressions and qualified plays, built
 *                                                   on the pack's daily players (and its new players)
 *   GET /v1/roblox/demographics?from&to&dev&players&country   Creator Hub's Demographics cards from the pack's players
 *                                                   (countries, devices), with Roblox's filters applied like the backend
 */
import type { RobloxAcquisition, RobloxAcquisitionDay, RobloxAcquisitionPeriod, RobloxAcquisitionSource, RobloxDemographicBreakdown, RobloxDemographicRow, RobloxDemographics, RobloxProductInfo } from "@/lib/types";
import { ACQUISITION_DAYS, METRICS, robloxWindow } from "../../../src/server/roblox-analytics.ts";
import { MAX_PRODUCT_IDS, parseIdList } from "../../../src/server/roblox-products.ts";
import { normalizeFilters } from "../../../src/sql/filters.ts";
import type { Device } from "../../../src/schema.ts";
import { DAY_MS, now } from "./data";
import { pack, type Pack } from "./pack";
import { rng } from "./rng";
import { fail, route } from "./router";

// Products ---------------------------------------------------------------------------------------------------------------

interface Product {
	type: RobloxProductInfo["type"];
	id: number;
	name: string;
	price: number | null;
	forSale: boolean;
}

/**
 * The ids in the pack's purchase and purchase_prompt events. Prices are what the purchase events paid where there was a
 * purchase; names are the demo's own (Prison-style), not looked up anywhere.
 */
export const PRODUCTS: readonly Product[] = [
	{ type: "gamepass", id: 1525207977, name: "VIP Cell Block", price: 399, forSale: true },
	{ type: "gamepass", id: 1526635821, name: "Riot Gear", price: 499, forSale: true },
	{ type: "gamepass", id: 1626400419, name: "Contraband Smuggler", price: 349, forSale: true },
	{ type: "gamepass", id: 1626862412, name: "Double Cash", price: 199, forSale: true },
	{ type: "gamepass", id: 1626940430, name: "Master Lockpick", price: 248, forSale: true },
	{ type: "gamepass", id: 1627336401, name: "Extra Inventory", price: 149, forSale: true },
	{ type: "gamepass", id: 1627462380, name: "SWAT Guard", price: 499, forSale: true },
	{ type: "gamepass", id: 1627792410, name: "Tunnel Digger", price: 299, forSale: false },
	{ type: "gamepass", id: 1628020367, name: "Cafeteria Chef", price: 129, forSale: true },
	{ type: "gamepass", id: 1628242346, name: "Radio", price: 99, forSale: true },
	{ type: "gamepass", id: 1898406988, name: "Medic Bag", price: 200, forSale: true },
	{ type: "gamepass", id: 1899198682, name: "Warden's Office", price: 2899, forSale: true },
	{ type: "gamepass", id: 2063636065, name: "Fast Escape", price: 249, forSale: true },
	{ type: "product", id: 3476606134, name: "Cash Briefcase (25,000)", price: 790, forSale: true },
	{ type: "product", id: 3476606291, name: "Cash Stack (6,000)", price: 199, forSale: true },
	{ type: "product", id: 3476606399, name: "Pocket Cash (1,000)", price: 49, forSale: true },
	{ type: "product", id: 3476615617, name: "Strength Potion", price: 70, forSale: true },
	{ type: "product", id: 3476615738, name: "Speed Potion", price: 40, forSale: true },
	{ type: "product", id: 3476616011, name: "Revive Potion", price: 249, forSale: true },
	{ type: "product", id: 3476616109, name: "Stealth Potion", price: 70, forSale: true },
	{ type: "product", id: 3476616178, name: "Jump Potion", price: 40, forSale: true },
	{ type: "product", id: 3605933534, name: "Weapon Crate", price: 99, forSale: true },
	{ type: "product", id: 3605933583, name: "Rare Weapon Crate", price: 249, forSale: true },
	{ type: "product", id: 3605933632, name: "Legendary Weapon Crate", price: 599, forSale: true },
	{ type: "product", id: 3605933687, name: "Skin Crate", price: 149, forSale: true },
	{ type: "product", id: 3605933775, name: "Key Card Bundle", price: 75, forSale: true },
	{ type: "product", id: 3605933831, name: "Skip Quest", price: 25, forSale: true },
	{ type: "product", id: 3605934169, name: "Bail Out", price: 120, forSale: true },
	{ type: "product", id: 3609321973, name: "Instant Respawn", price: 15, forSale: true },
	{ type: "product", id: 3609322018, name: "Shorter Sentence", price: 35, forSale: true },
	{ type: "product", id: 3609322053, name: "Guard Bribe", price: 60, forSale: false },
];

const BY_ID = new Map(PRODUCTS.map((p) => [`${p.type}:${p.id}`, p]));

route<{ items: RobloxProductInfo[] }>("GET", "/v1/roblox/products", (req) => {
	const q = req.query;
	for (const key of q.keys()) if (key !== "gamepass" && key !== "product") return fail(400, "only gamepass and product ids");
	if (q.getAll("gamepass").length > 1 || q.getAll("product").length > 1) return fail(400, "one gamepass and one product list");
	const gamepass = parseIdList(q.get("gamepass"));
	const product = parseIdList(q.get("product"));
	if (!gamepass || !product) return fail(400, "ids must be comma-separated positive integers");
	if (!gamepass.length && !product.length) return fail(400, "no ids: ?gamepass=1,2&product=3");
	if (gamepass.length + product.length > MAX_PRODUCT_IDS) return fail(400, `at most ${MAX_PRODUCT_IDS} ids`);
	const item = (type: Product["type"], id: number): RobloxProductInfo => {
		const known = BY_ID.get(`${type}:${id}`);
		// No icon ever: the explorer would load it from Roblox's CDN.
		if (!known) return { type, id, status: "not_found", name: null, price: null, forSale: null, icon: null };
		return { type, id, status: "ok", name: known.name, price: known.forSale ? known.price : null, forSale: known.forSale, icon: null };
	};
	return { items: [...[...new Set(gamepass)].map((id) => item("gamepass", id)), ...[...new Set(product)].map((id) => item("product", id))] };
});

// Daily players from the pack ---------------------------------------------------------------------------------------------

interface DayCount {
	/** Players active that day, and how many of them played for the first time. */
	active: number;
	fresh: number;
}

const daily = new WeakMap<Pack, Map<number, DayCount>>();

/** Players per full UTC day of the pack (by the shifted timeline), from each player's first / last day and sessions. */
function packDays(p: Pack): Map<number, DayCount> {
	const hit = daily.get(p);
	if (hit) return hit;
	const out = new Map<number, DayCount>();
	const add = (day: number, fresh: boolean) => {
		const c = out.get(day) ?? { active: 0, fresh: 0 };
		c.active++;
		if (fresh) c.fresh++;
		out.set(day, c);
	};
	for (const pl of p.players) {
		const first = Math.floor(pl.firstAt / DAY_MS) * DAY_MS;
		const last = Math.floor(pl.lastAt / DAY_MS) * DAY_MS;
		add(first, pl.newInWindow);
		const span = Math.round((last - first) / DAY_MS);
		if (span <= 0) continue;
		const q = Math.max(0, Math.min(1, (pl.sessions - 2) / Math.max(1, span - 1)));
		const r = rng(`roblox:days:${pl.pid}`);
		for (let d = first + DAY_MS; d < last; d += DAY_MS) if (r.chance(q)) add(d, false);
		add(last, false);
	}
	daily.set(p, out);
	return out;
}

/** Roblox's view of a day: the pack's day, or (before the pack) the pack's average with a gentle trend and noise. */
function dayCount(p: Pack, day: number): DayCount {
	const days = packDays(p);
	const today = Math.floor(p.now / DAY_MS) * DAY_MS;
	const first = Math.floor(p.from / DAY_MS) * DAY_MS;
	const found = day >= first && day < today ? days.get(day) : undefined;
	if (found) return found;
	const full = [...days.entries()].filter(([d]) => d >= first && d < today).map(([, c]) => c);
	const mean = (pick: (c: DayCount) => number) => (full.length ? full.reduce((s, c) => s + pick(c), 0) / full.length : 0);
	const r = rng(`roblox:before:${day - p.shiftMs}`);
	const trend = 1 - 0.006 * Math.max(0, (first - day) / DAY_MS);
	return { active: Math.round(mean((c) => c.active) * trend * r.float(0.88, 1.12)), fresh: Math.round(mean((c) => c.fresh) * trend * r.float(0.85, 1.15)) };
}

// Acquisition (GET /v1/roblox/analytics/acquisition) ---------------------------------------------------------------------

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

const SOURCES: { source: string; label: string; share: number; rate: number }[] = [
	{ source: "HomeRecommendations", label: "Home recommendations", share: 0.61, rate: 0.031 },
	{ source: "Search", label: "Search", share: 0.14, rate: 0.088 },
	{ source: "SponsoredAds", label: "Sponsored ads", share: 0.12, rate: 0.022 },
	{ source: "FriendActivity", label: "Friend activity", share: 0.07, rate: 0.17 },
	{ source: "Other", label: "Other", share: 0.06, rate: 0.06 },
];

/** When "Roblox was asked" for an answer: kept an hour, like the backend's cache (in memory, per page load). */
const fetched = new Map<string, number>();
function askedAt(key: string, at: number): { fetchedAt: string; cached: boolean } {
	const first = fetched.get(key);
	if (first !== undefined && at - first < 3_600_000 && at >= first) return { fetchedAt: new Date(first).toISOString(), cached: true };
	fetched.set(key, at);
	return { fetchedAt: new Date(at).toISOString(), cached: false };
}

route<RobloxAcquisition>("GET", "/v1/roblox/analytics/acquisition", async (req) => {
	const q = req.query;
	for (const key of q.keys()) if (key !== "days") return fail(400, `unknown parameter ${JSON.stringify(key.slice(0, 40))}`);
	if (q.getAll("days").length > 1) return fail(400, "one days");
	const raw = q.get("days") ?? "7";
	const days = Number(raw);
	if (!/^[1-9]\d?$/.test(raw) || !(ACQUISITION_DAYS as readonly number[]).includes(days)) return fail(400, `days: one of ${ACQUISITION_DAYS.join(", ")}`);
	const p = await pack();
	const at = now();
	const end = Math.floor(at / DAY_MS) * DAY_MS;
	const start = end - 2 * days * DAY_MS;
	const dailyRows: RobloxAcquisitionDay[] = [];
	for (let t = start; t < end; t += DAY_MS) {
		const c = dayCount(p, t);
		const r = rng(`roblox:acq:${t - p.shiftMs}`);
		const qualifiedPlayThrough = round6(r.normal(0.044, 0.004, 0.03, 0.06));
		const qualifiedPlays = Math.round(c.active * r.float(0.86, 0.94));
		dailyRows.push({ day: new Date(t).toISOString().slice(0, 10), playThroughHome: round6(r.normal(0.031, 0.003, 0.02, 0.045)), qualifiedPlayThrough, impressions: Math.round(qualifiedPlays / qualifiedPlayThrough), qualifiedPlays });
	}
	const period = (from: number, to: number): RobloxAcquisitionPeriod => {
		const rows = dailyRows.filter((d) => Date.parse(d.day) >= from && Date.parse(d.day) < to);
		const mean = (xs: (number | null)[]) => {
			const v = xs.filter((x): x is number => x !== null);
			return v.length ? round6(v.reduce((a, b) => a + b, 0) / v.length) : null;
		};
		return {
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
			daysWithData: rows.length,
			playThroughHome: mean(rows.map((d) => d.playThroughHome)),
			qualifiedPlayThrough: mean(rows.map((d) => d.qualifiedPlayThrough)),
			impressions: rows.reduce((s, d) => s + (d.impressions ?? 0), 0),
			qualifiedPlays: rows.reduce((s, d) => s + (d.qualifiedPlays ?? 0), 0),
		};
	};
	const mid = end - days * DAY_MS;
	const current = period(mid, end);
	const r = rng(`roblox:sources:${days}:${end - p.shiftMs}`);
	const raw0 = SOURCES.map((s) => {
		const impressions = Math.round(current.impressions * s.share * r.float(0.9, 1.1));
		return { ...s, impressions, plays: impressions * s.rate * r.float(0.85, 1.15) };
	});
	const playsSum = raw0.reduce((a, s) => a + s.plays, 0) || 1;
	const sources: RobloxAcquisitionSource[] = raw0
		.map((s) => {
			const qualifiedPlays = Math.round((s.plays / playsSum) * current.qualifiedPlays);
			return { source: s.source, label: s.label, impressions: s.impressions, qualifiedPlays, rate: s.impressions > 0 ? round6(qualifiedPlays / s.impressions) : null };
		})
		.sort((a, b) => b.impressions - a.impressions || a.source.localeCompare(b.source));
	const { fetchedAt, cached } = askedAt(`acquisition:${days}:${end}`, at);
	return {
		source: "roblox",
		days,
		metrics: { ...METRICS },
		current,
		previous: period(start, mid),
		daily: dailyRows,
		sources,
		fetchedAt,
		cached,
	};
});

// Demographics (GET /v1/roblox/demographics) -----------------------------------------------------------------------------

/** Roblox's breakdown values with their share (before filters). */
const AGE_GROUPS: [string, string, number][] = [
	["AgeUnder9", "Under 9", 0.05],
	["Age9To12", "9-12", 0.24],
	["Age13To17", "13-17", 0.37],
	["Age18To20", "18-20", 0.12],
	["Age21Plus", "21+", 0.17],
	["Unknown", "Unknown", 0.05],
];
const GENDERS: [string, string, number][] = [
	["Male", "Male", 0.67],
	["Female", "Female", 0.25],
	["Unknown", "Unknown", 0.08],
];
const PLATFORMS: Record<string, string> = { phone: "Phone", tablet: "Tablet", desktop: "Computer", console: "Console" };
const OS_BY_PLATFORM: Record<string, [string, number][]> = {
	Phone: [
		["Android", 0.58],
		["iOS", 0.42],
	],
	Tablet: [
		["iOS", 0.56],
		["Android", 0.44],
	],
	Computer: [
		["Windows", 0.91],
		["macOS", 0.09],
	],
	Console: [
		["Xbox", 0.68],
		["PlayStation", 0.32],
	],
};
const LANGUAGE_OF: Record<string, [string, string]> = {
	US: ["en_us", "English"],
	GB: ["en_us", "English"],
	CA: ["en_us", "English"],
	AU: ["en_us", "English"],
	NZ: ["en_us", "English"],
	IE: ["en_us", "English"],
	PH: ["en_us", "English"],
	IN: ["en_us", "English"],
	SG: ["en_us", "English"],
	ZA: ["en_us", "English"],
	RU: ["ru_ru", "Russian"],
	UA: ["ru_ru", "Russian"],
	BY: ["ru_ru", "Russian"],
	KZ: ["ru_ru", "Russian"],
	BR: ["pt_br", "Portuguese (Brazil)"],
	PT: ["pt_br", "Portuguese (Brazil)"],
	MX: ["es_es", "Spanish"],
	ES: ["es_es", "Spanish"],
	AR: ["es_es", "Spanish"],
	CO: ["es_es", "Spanish"],
	CL: ["es_es", "Spanish"],
	PE: ["es_es", "Spanish"],
	SA: ["ar_001", "Arabic"],
	AE: ["ar_001", "Arabic"],
	EG: ["ar_001", "Arabic"],
	FR: ["fr_fr", "French"],
	BE: ["fr_fr", "French"],
	PL: ["pl_pl", "Polish"],
	DE: ["de_de", "German"],
	AT: ["de_de", "German"],
	ID: ["id_id", "Indonesian"],
	JP: ["ja_jp", "Japanese"],
	KR: ["ko_kr", "Korean"],
	TR: ["tr_tr", "Turkish"],
	IT: ["it_it", "Italian"],
	NL: ["nl_nl", "Dutch"],
	TH: ["th_th", "Thai"],
	VN: ["vi_vn", "Vietnamese"],
};

const DEVICE_WORDS: Record<string, RegExp> = { desktop: /desktop|computer|\bpc\b/i, phone: /phone/i, tablet: /tablet/i, console: /console|xbox|playstation/i, vr: /\bvr\b|virtual/i };
const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
function countryMatches(code: string, value: string): boolean {
	let name: string | undefined;
	try {
		name = COUNTRY_NAMES.of(code)?.toLowerCase();
	} catch {
		name = undefined;
	}
	return value.toLowerCase() === code.toLowerCase() || (name !== undefined && value.toLowerCase() === name);
}

type Shares = [string, string, number][];

function normalize(rows: Shares): Shares {
	const sum = rows.reduce((s, [, , w]) => s + w, 0) || 1;
	return rows.map(([v, l, w]) => [v, l, w / sum]);
}

/** Shares of the pack's players by a field (players weighted equally; null values left out). */
function playerShares(p: Pack, pick: (pl: Pack["players"][number]) => string | null): Map<string, number> {
	const counts = new Map<string, number>();
	let n = 0;
	for (const pl of p.players) {
		const v = pick(pl);
		if (!v) continue;
		counts.set(v, (counts.get(v) ?? 0) + 1);
		n++;
	}
	return new Map([...counts].map(([k, c]) => [k, c / Math.max(1, n)]));
}

route<RobloxDemographics>("GET", "/v1/roblox/demographics", async (req) => {
	const q = req.query;
	const allowed = new Set(["from", "to", "dev", "players", "country"]);
	for (const key of q.keys()) {
		if (!allowed.has(key)) return fail(400, `unknown parameter ${JSON.stringify(key.slice(0, 40))}`);
		if (q.getAll(key).length > 1) return fail(400, `one ${key}`);
	}
	const at = now();
	let input: { from: number; to: number; dev?: string[]; players?: "new" | "returning"; country?: string[] };
	try {
		const get = (k: string) => q.get(k) ?? undefined;
		const raw = (k: string) => {
			const v = get(k);
			return v !== undefined && /^\d{12,14}$/.test(v) ? Number(v) : v;
		};
		const dev = get("dev")?.split(",").filter(Boolean);
		const players = get("players");
		const country = get("country")?.split(",").filter(Boolean);
		const f = normalizeFilters(
			{
				...(raw("from") !== undefined ? { from: raw("from") as string | number } : {}),
				...(raw("to") !== undefined ? { to: raw("to") as string | number } : {}),
				...(dev?.length ? { dev: dev as Device[] } : {}),
				...(players ? { players: players as "new" | "returning" } : {}),
				...(country?.length ? { country } : {}),
			},
			{ now: at, defaultDays: 28 },
		);
		input = { from: f.from, to: f.to, ...(f.dev?.length ? { dev: f.dev } : {}), ...(f.players ? { players: f.players } : {}), ...(f.country?.length ? { country: f.country } : {}) };
	} catch (error) {
		return fail(400, String((error as Error).message).slice(0, 200));
	}
	const p = await pack();
	const window = robloxWindow(input.from, input.to, at);
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	let dau = 0;
	let fresh = 0;
	for (let t = from; t < to; t += DAY_MS) {
		const c = dayCount(p, t);
		dau += c.active;
		fresh += c.fresh;
	}
	dau = Math.round(dau * 1.04);

	// The base cards, from the pack's players where it knows (country, device), else typical shares for the genre.
	const r = rng(`roblox:demo:${from - p.shiftMs}:${to - p.shiftMs}`);
	const countryShares = playerShares(p, (pl) => pl.country);
	const countries: Shares = [...countryShares]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 60)
		.map(([code, s]) => [code, code, s * r.float(0.9, 1.1)]);
	const langs = new Map<string, [string, number]>();
	for (const [code, , s] of countries) {
		const [value, label] = LANGUAGE_OF[code] ?? ["other", "Other"];
		const prev = langs.get(value);
		langs.set(value, [label, (prev?.[1] ?? 0) + s]);
	}
	const locales: Shares = [...langs].map(([v, [l, s]]) => [v, l, s]);
	const devShares = playerShares(p, (pl) => (pl.dev && PLATFORMS[pl.dev] ? (PLATFORMS[pl.dev] as string) : null));
	let platforms: Shares = [...devShares].map(([v, s]) => [v, v, s * r.float(0.93, 1.07)]);
	const applied: RobloxDemographics["applied"] = [];
	const notApplied: RobloxDemographics["notApplied"] = [];
	let factor = 1;
	let countryRows = normalize(countries);
	if (input.dev?.length) {
		const values = platforms.filter(([v]) => input.dev?.some((d) => DEVICE_WORDS[d]?.test(v))).map(([v]) => v);
		if (values.length) {
			const all = normalize(platforms);
			factor *= all.filter(([v]) => values.includes(v)).reduce((s, [, , w]) => s + w, 0);
			platforms = platforms.filter(([v]) => values.includes(v));
			applied.push({ filter: "device", dimension: "Platform", values });
		} else notApplied.push({ filter: "device", reason: `none of Roblox's platforms (${platforms.map(([, l]) => l).join(", ")}) is ${input.dev.join(" / ")}` });
	}
	if (input.players) {
		const newShare = dau > 0 ? Math.min(0.95, (fresh * 1.04) / dau) : 0.3;
		factor *= input.players === "new" ? newShare : 1 - newShare;
		applied.push({ filter: "players", dimension: "IsNewUser", values: [input.players === "new" ? "true" : "false"] });
	}
	if (input.country?.length) {
		const values = countries.filter(([v]) => input.country?.some((c) => countryMatches(c, v))).map(([v]) => v);
		if (values.length) {
			factor *= countryRows.filter(([v]) => values.includes(v)).reduce((s, [, , w]) => s + w, 0);
			countryRows = countryRows.filter(([v]) => values.includes(v));
			applied.push({ filter: "country", dimension: "Country", values });
		} else
			notApplied.push({
				filter: "country",
				reason: `none of the ${countries.length} countries Roblox reports for the window is ${input.country.join(" / ")}${countries.length ? ` (e.g. ${countries.slice(0, 3).map(([, l]) => l).join(", ")})` : ""}`,
			});
	}
	const total = Math.round(dau * factor);
	const os = new Map<string, number>();
	for (const [platform, , s] of normalize(platforms)) for (const [name, share] of OS_BY_PLATFORM[platform] ?? []) os.set(name, (os.get(name) ?? 0) + s * share);
	const card = (rows: Shares, jitter: boolean): { rows: RobloxDemographicRow[]; total: number } => {
		const shares = normalize(jitter ? rows.map(([v, l, w]) => [v, l, w * r.float(0.92, 1.08)]) : rows);
		const out = shares
			.map(([value, label, share]) => ({ value, label, users: Math.round(total * share), share: 0 }))
			.filter((x) => x.users > 0)
			.sort((a, b) => b.users - a.users || a.value.localeCompare(b.value));
		const sum = out.reduce((s, x) => s + x.users, 0);
		return { rows: out.map((x) => ({ ...x, share: sum > 0 ? round6(x.users / sum) : 0 })), total: sum };
	};
	const breakdowns = {
		AgeGroupV2: card(AGE_GROUPS, true),
		Gender: card(GENDERS, true),
		Locale: card(locales, false),
		Country: card(countryRows, false),
		Platform: card(platforms, false),
		OperatingSystem: card([...os].map(([v, s]) => [v, v, s]), false),
	} satisfies Record<RobloxDemographicBreakdown, { rows: RobloxDemographicRow[]; total: number }>;
	const { fetchedAt, cached } = askedAt(JSON.stringify(["demographics", window.from, window.to, applied]), at);
	return { source: "roblox", window, metric: "DailyActiveUsers", applied, notApplied, breakdowns, fetchedAt, cached };
});
