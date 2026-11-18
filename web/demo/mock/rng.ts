/**
 * Seeded randomness: the same seed gives the same numbers on every visit, so mock answers are stable (and tests can pin
 * them). Seed with what the answer is about: `rng(\`fleet:${job}\`)`, `rng(\`player:${pid}\`)`.
 *
 * Also the demo's fake identities: names like "Inmate_4821" / "Guard_0193" and UserIds that can never be a real Roblox
 * account (negative, like Studio's test players). Never put a real-looking UserId, a username or a roblox.com URL in a mock.
 */

/** A 32-bit hash of a string (FNV-1a with a final mix). */
export function hashString(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	return h >>> 0;
}

export interface Rng {
	/** [0, 1) */
	next(): number;
	/** An integer in [min, max] (both included). */
	int(min: number, max: number): number;
	/** A float in [min, max). */
	float(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
	/** True with probability p. */
	chance(p: number): boolean;
	/** A copy, shuffled. */
	shuffle<T>(items: readonly T[]): T[];
	/** A weighted pick: [[value, weight], ...]. */
	weighted<T>(items: readonly (readonly [T, number])[]): T;
	/** Roughly normal (mean, sd), clamped to [min, max] when given. */
	normal(mean: number, sd: number, min?: number, max?: number): number;
	/** A hex id of `length` characters. */
	hex(length: number): string;
	/** A fresh generator for a sub-topic (stable: depends only on this seed and the label). */
	fork(label: string): Rng;
}

/** mulberry32 over a string or number seed. */
export function rng(seed: string | number): Rng {
	const base = typeof seed === "number" ? seed >>> 0 : hashString(seed);
	let state = base;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const self: Rng = {
		next,
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		float: (min, max) => min + next() * (max - min),
		pick: (items) => {
			if (!items.length) throw new Error("rng.pick on an empty list");
			return items[Math.floor(next() * items.length)] as (typeof items)[number];
		},
		chance: (p) => next() < p,
		shuffle: (items) => {
			const out = [...items];
			for (let i = out.length - 1; i > 0; i--) {
				const j = Math.floor(next() * (i + 1));
				[out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
			}
			return out;
		},
		weighted: (items) => {
			const total = items.reduce((a, [, w]) => a + Math.max(0, w), 0);
			let r = next() * total;
			for (const [value, w] of items) {
				r -= Math.max(0, w);
				if (r < 0) return value;
			}
			return (items[items.length - 1] as readonly [never, number])[0];
		},
		normal: (mean, sd, min, max) => {
			const u = Math.max(next(), 1e-12);
			const v = next();
			let x = mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
			if (min !== undefined) x = Math.max(min, x);
			if (max !== undefined) x = Math.min(max, x);
			return x;
		},
		hex: (length) => {
			let s = "";
			while (s.length < length) s += Math.floor(next() * 16).toString(16);
			return s;
		},
		fork: (label) => rng(hashString(`${base}:${label}`)),
	};
	return self;
}

// Fake identities -------------------------------------------------------------------------------------------------------

/** A player's demo name: "Inmate_4821" or "Guard_0193" (the team they played most, else from the pid). Never a real name. */
export function fakeName(pid: string, team?: string | null): string {
	const h = hashString(`name:${pid}`);
	const role = team === "guard" || team === "Guard" ? "Guard" : team === "inmate" || team === "Inmate" ? "Inmate" : h % 3 === 0 ? "Guard" : "Inmate";
	return `${role}_${String(h % 10_000).padStart(4, "0")}`;
}

/**
 * A UserId for a pid that can't be a real Roblox account: negative (Studio's test players are -1, -2, ...), stable per pid.
 * Prefer leaving the UserId out (null) where the type allows; use this only where a number is required, and make sure the
 * answer carries no avatar URL and nothing links it to roblox.com.
 */
export function fakeUserId(pid: string): number {
	return -(100_000 + (hashString(`uid:${pid}`) % 900_000));
}

/**
 * The demo owner (every visitor is signed in as it). Its UserId is -1, like Studio's first test player: no Roblox account
 * can ever have it (a positive id might be someone's). It is only ever text ("Roblox user -1", the audit actor, the maps
 * index's "by", which prepare-data rewrites to this actor), never an avatar or a roblox.com link.
 */
export const DEMO_OWNER = { userId: -1, name: "demo_owner", displayName: "Demo Owner" } as const;

/** The owner as the backend names an actor: "roblox user -1 (demo_owner)". */
export const DEMO_OWNER_ACTOR = `roblox user ${DEMO_OWNER.userId} (${DEMO_OWNER.name})`;
