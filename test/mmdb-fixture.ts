/**
 * A tiny MaxMind DB (.mmdb) writer for the geo tests: an IPv6 tree (24-bit records) with IPv4 networks under ::/96,
 * maps, strings, doubles and unsigned ints. Enough to build a City-like and an ASN-like database with made-up entries
 * (documentation ranges), so the real reader (mmdb-lib) is tested on real bytes.
 */

type Value = string | number | { double: number } | { u64: number } | Value[] | { [key: string]: Value };

function control(type: number, size: number): number[] {
	if (size >= 285) throw new Error("fixture sizes stay under 285");
	// Sizes 29-284: 29 in the control byte, the rest in one byte after it (after the extended type byte, if any).
	const [low, extra] = size < 29 ? [size, []] : [29, [size - 29]];
	return type <= 7 ? [(type << 5) | low, ...extra] : [low, type - 7, ...extra];
}

function uint(n: number): number[] {
	const out: number[] = [];
	let v = n;
	while (v > 0) {
		out.unshift(v & 0xff);
		v = Math.floor(v / 256);
	}
	return out;
}

function encode(value: Value): number[] {
	if (typeof value === "string") {
		const bytes = [...new TextEncoder().encode(value)];
		return [...control(2, bytes.length), ...bytes];
	}
	if (typeof value === "number") {
		// Small non-negative integers: uint16 / uint32.
		const bytes = uint(value);
		return [...control(value <= 0xffff ? 5 : 6, bytes.length), ...bytes];
	}
	if (Array.isArray(value)) return [...control(11, value.length), ...value.flatMap(encode)];
	if ("double" in value && typeof value.double === "number") {
		const buf = Buffer.alloc(8);
		buf.writeDoubleBE(value.double);
		return [...control(3, 8), ...buf];
	}
	if ("u64" in value && typeof value.u64 === "number") {
		const bytes = uint(value.u64);
		return [...control(9, bytes.length), ...bytes];
	}
	const entries = Object.entries(value as Record<string, Value>);
	return [...control(7, entries.length), ...entries.flatMap(([k, v]) => [...encode(k), ...encode(v)])];
}

type Rec = { node: number } | { data: number } | null;

/** networks: "192.0.2.0/24" -> record. */
export function buildMmdb(databaseType: string, networks: Record<string, Value>): Buffer {
	const nodes: [Rec, Rec][] = [[null, null]];
	const data: number[] = [];
	for (const [cidr, record] of Object.entries(networks)) {
		const [addr, len] = cidr.split("/");
		const octets = addr.split(".").map(Number);
		const bits: number[] = [...new Array(96).fill(0)];
		for (const o of octets) for (let i = 7; i >= 0; i--) bits.push((o >> i) & 1);
		const prefix = 96 + Number(len);
		const offset = data.length;
		data.push(...encode(record));
		let at = 0;
		for (let i = 0; i < prefix; i++) {
			const side = bits[i];
			if (i === prefix - 1) {
				nodes[at][side] = { data: offset };
				break;
			}
			const next = nodes[at][side];
			if (next && "node" in next) at = next.node;
			else {
				nodes.push([null, null]);
				nodes[at][side] = { node: nodes.length - 1 };
				at = nodes.length - 1;
			}
		}
	}
	const count = nodes.length;
	const value = (r: Rec) => (r === null ? count : "node" in r ? r.node : count + 16 + r.data);
	const tree: number[] = [];
	for (const [l, r] of nodes) for (const v of [value(l), value(r)]) tree.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
	const metadata = encode({
		binary_format_major_version: 2,
		binary_format_minor_version: 0,
		build_epoch: { u64: 1_793_000_000 },
		database_type: databaseType,
		description: { en: "TypeTorch test fixture" },
		ip_version: 6,
		languages: ["en"],
		node_count: count,
		record_size: 24,
	});
	return Buffer.from([...tree, ...new Array(16).fill(0), ...data, ...Buffer.from("abcdef4d61784d696e642e636f6d", "hex"), ...metadata]);
}

/** A City database: 192.0.2.0/24 in Sterling (US), 198.51.100.0/24 in Frankfurt (DE), 203.0.113.0/24 country only (JP). */
export function cityFixture(type = "DBIP-City-Lite (compat=GeoLite2-City)"): Buffer {
	return buildMmdb(type, {
		"192.0.2.0/24": {
			city: { names: { en: "Sterling" } },
			country: { iso_code: "US", names: { en: "United States" } },
			location: { latitude: { double: 39.0067 }, longitude: { double: -77.4291 } },
			subdivisions: [{ names: { en: "Virginia" } }],
		},
		"198.51.100.0/24": {
			city: { names: { en: "Frankfurt am Main" } },
			country: { iso_code: "DE", names: { en: "Germany" } },
			location: { latitude: { double: 50.1109 }, longitude: { double: 8.68213 } },
			subdivisions: [{ names: { en: "Hesse" } }],
		},
		"203.0.113.0/24": { country: { iso_code: "JP", names: { en: "Japan" } } },
	});
}

/** An ASN database for 192.0.2.0/24. */
export function asnFixture(): Buffer {
	return buildMmdb("DBIP-ASN-Lite (compat=GeoLite2-ASN)", { "192.0.2.0/24": { autonomous_system_number: 22697, autonomous_system_organization: "Roblox" } });
}
