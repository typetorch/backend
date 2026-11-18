/**
 * The demo's writable state: what visitors change (settings, saved queries, live events, alert acks, drop rules...) lives
 * in memory and is copied to localStorage, so it survives a reload in that browser and never leaves it. "Reset demo" (the
 * banner) clears every slice.
 *
 *   const rules = slice("errors.dropRules", () => seedRules());   // once, at module level
 *   rules.get();                       // the current value (the seed the first time)
 *   rules.set(next);                   // replace
 *   rules.update((draft) => { draft.push(rule); });   // change in place (a structured copy is saved)
 *   nextId("savedQuery")               // 1, 2, 3... per name, persisted
 *
 * Keys are "<domain>.<what>" (fleet.acks, players.overrides, admin.settings, ...). Values must be JSON (no Map, Date,
 * undefined in arrays). Every read and write is wrapped: a private window or blocked storage just means memory only.
 */

const PREFIX = "typetorch-demo:v1:";

export interface Slice<T> {
	readonly key: string;
	get(): T;
	set(value: T): void;
	update(change: (draft: T) => void | T): T;
	/** Back to the seed (this slice only). */
	reset(): void;
}

const memory = new Map<string, unknown>();
const seeds = new Map<string, () => unknown>();
const listeners = new Set<(key: string) => void>();

function storage(): Storage | undefined {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

function load(key: string): unknown {
	try {
		const raw = storage()?.getItem(PREFIX + key);
		return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as unknown);
	} catch {
		return undefined;
	}
}

function save(key: string, value: unknown): void {
	try {
		storage()?.setItem(PREFIX + key, JSON.stringify(value));
	} catch {
		// full or blocked: memory only
	}
}

/** One named piece of state with its seed (called once per key, at module level). */
export function slice<T>(key: string, seed: () => T): Slice<T> {
	if (seeds.has(key)) throw new Error(`demo state slice "${key}" is defined twice`);
	seeds.set(key, seed);
	const get = (): T => {
		if (!memory.has(key)) {
			const stored = load(key);
			memory.set(key, stored === undefined ? seed() : stored);
		}
		return memory.get(key) as T;
	};
	const set = (value: T) => {
		memory.set(key, value);
		save(key, value);
		for (const l of listeners) l(key);
	};
	return {
		key,
		get,
		set,
		update(change) {
			const draft = structuredClone(get());
			const returned = change(draft);
			const next = (returned === undefined ? draft : returned) as T;
			set(next);
			return next;
		},
		reset() {
			memory.delete(key);
			try {
				storage()?.removeItem(PREFIX + key);
			} catch {
				// ignore
			}
			for (const l of listeners) l(key);
		},
	};
}

const counters = slice<Record<string, number>>("core.counters", () => ({}));

/** The next id for a name (1, 2, ...), persisted with the rest of the state. */
export function nextId(name: string, start = 1): number {
	let id = start;
	counters.update((c) => {
		id = Math.max(c[name] ?? start - 1, start - 1) + 1;
		c[name] = id;
	});
	return id;
}

/** Forgets every change (memory and localStorage). The banner's "Reset demo" calls this, then reloads the page. */
export function resetState(): void {
	memory.clear();
	try {
		const s = storage();
		if (s) {
			const keys: string[] = [];
			for (let i = 0; i < s.length; i++) {
				const k = s.key(i);
				if (k?.startsWith(PREFIX)) keys.push(k);
			}
			for (const k of keys) s.removeItem(k);
		}
	} catch {
		// ignore
	}
	for (const l of listeners) l("*");
}

/** Called with the key whenever a slice changes ("*" on a reset). */
export function onStateChange(listener: (key: string) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Whether anything was changed in this browser (the banner shows "Reset demo" as active). */
export function hasChanges(): boolean {
	try {
		const s = storage();
		if (!s) return memory.size > 0;
		for (let i = 0; i < s.length; i++) if (s.key(i)?.startsWith(PREFIX)) return true;
	} catch {
		// ignore
	}
	return false;
}
