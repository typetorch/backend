/**
 * First-session recordings: decoding the packed chunks (tt-rec-1) and finding confusion signals in them.
 *
 * tt-rec-1 is the framework's format (framework/src/analytics/SCHEMA.md "tt-rec-1"; reference decoder `decodeChunk` in
 * framework/src/analytics/codec.ts). Little-endian; a 4-byte header (u8 version 1, u8 flags (bit 0: last chunk), u16
 * sample interval ms), then records, each `u8 tag, u16 dt` (ms since the previous record; the first since the row's
 * `t`) and a payload by tag. Each chunk decodes on its own (own anchor, own string table). A test decodes a chunk the
 * framework's encoder wrote (under Lune) byte for byte.
 */
import type { RecordingRow } from "./schema.ts";

export type Vec3 = [number, number, number];

/** About 10 per second: where the character and the camera were. */
export interface RecordingSample {
	t: number;
	/** Character root position (studs); absent while there is no character (a Camera record). */
	pos?: Vec3;
	/** Character facing yaw (radians, 0 = facing -Z). */
	yaw?: number;
	/** Camera position and look direction (unit vector). */
	cam?: Vec3;
	look?: Vec3;
}

export type RecordingInputType =
	| "key"
	| "click"
	| "tap"
	| "pad"
	| "scroll"
	| "stick_start"
	| "stick_stop"
	| "button"
	| "hover"
	| "screen_open"
	| "screen_close"
	| "prompt_shown"
	| "prompt_hidden"
	| "prompt_used"
	| "death"
	| "spawn"
	| "textbox"
	| "custom";

/** Something that happened once: an input, a button press (target = its path, e.g. Shop/Buy/Coins100), a screen. */
export interface RecordingInput {
	t: number;
	type: RecordingInputType;
	/** Button/screen/prompt path, or the game's event name. */
	target?: string;
	/** Key or input code (Enum.KeyCode / UserInputType value). */
	code?: number;
	/** The game processed the input (e.g. a click on UI). */
	processed?: boolean;
}

export interface DecodedRecording {
	pid: string;
	sid: string;
	samples: RecordingSample[];
	inputs: RecordingInput[];
	/** Chunks missing between the ones decoded (a lost batch). */
	gaps?: number;
}

export class RecordingCodecUnavailable extends Error {
	override name = "RecordingCodecUnavailable";
}

export type ChunkRow = Pick<RecordingRow, "pid" | "sid" | "chunk" | "codec" | "data" | "n"> & { t?: number };

export interface RecordingDecoder {
	codec: string;
	/** Decodes all chunks of one session (already sorted by chunk). */
	decode(chunks: ChunkRow[]): DecodedRecording;
}

// tt-rec-1 ---------------------------------------------------------------------------------------------------------------

export const TT_REC_TAGS = { wait: 0, anchor: 1, sample: 2, camera: 3, key: 4, pointer: 5, string: 6, event: 7 } as const;
const POSITION_SCALE = 8;
const CAMERA_SCALE = 16;
const NO_STRING = 65535;

export interface DecodedRecord {
	tag: number;
	/** ms since the chunk start. */
	at: number;
	values?: number[];
	kind?: number;
	processed?: boolean;
	code?: number;
	x?: number;
	y?: number;
	id?: number;
	text?: string;
}

export interface DecodedChunk {
	version: number;
	last: boolean;
	intervalMs: number;
	records: DecodedRecord[];
}

function unwrapYaw(byte: number): number {
	return (byte / 256) * Math.PI * 2 - Math.PI;
}

/** Decodes one tt-rec-1 chunk, like the framework's `decodeChunk`. Throws on a malformed chunk. */
export function decodeTtRec1Chunk(bytes: Uint8Array): DecodedChunk {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = bytes.byteLength;
	if (size < 4) throw new Error("tt-rec-1: chunk too short");
	const version = view.getUint8(0);
	if (version !== 1) throw new Error(`tt-rec-1: unknown version ${version}`);
	const result: DecodedChunk = { version, last: (view.getUint8(1) & 1) === 1, intervalMs: view.getUint16(2, true), records: [] };
	const strings = new Map<number, string>();
	const utf8 = new TextDecoder();
	let anchor: Vec3 = [0, 0, 0];
	let at = 0;
	let offset = 4;
	const need = (n: number) => {
		if (offset + n > size) throw new Error("tt-rec-1: record runs past the end of the chunk");
	};
	while (offset < size) {
		need(3);
		const tag = view.getUint8(offset);
		at += view.getUint16(offset + 1, true);
		offset += 3;
		const record: DecodedRecord = { tag, at };
		if (tag === TT_REC_TAGS.wait) {
			// time only
		} else if (tag === TT_REC_TAGS.anchor) {
			need(12);
			anchor = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
			record.values = [...anchor];
			offset += 12;
		} else if (tag === TT_REC_TAGS.sample) {
			need(15);
			const cx = anchor[0] + view.getInt16(offset, true) / POSITION_SCALE;
			const cy = anchor[1] + view.getInt16(offset + 2, true) / POSITION_SCALE;
			const cz = anchor[2] + view.getInt16(offset + 4, true) / POSITION_SCALE;
			record.values = [
				cx,
				cy,
				cz,
				unwrapYaw(view.getUint8(offset + 6)),
				cx + view.getInt16(offset + 7, true) / CAMERA_SCALE,
				cy + view.getInt16(offset + 9, true) / CAMERA_SCALE,
				cz + view.getInt16(offset + 11, true) / CAMERA_SCALE,
				unwrapYaw(view.getUint8(offset + 13)),
				(view.getInt8(offset + 14) / 127) * (Math.PI / 2),
			];
			offset += 15;
		} else if (tag === TT_REC_TAGS.camera) {
			need(8);
			record.values = [
				anchor[0] + view.getInt16(offset, true) / POSITION_SCALE,
				anchor[1] + view.getInt16(offset + 2, true) / POSITION_SCALE,
				anchor[2] + view.getInt16(offset + 4, true) / POSITION_SCALE,
				unwrapYaw(view.getUint8(offset + 6)),
				(view.getInt8(offset + 7) / 127) * (Math.PI / 2),
			];
			offset += 8;
		} else if (tag === TT_REC_TAGS.key || tag === TT_REC_TAGS.pointer) {
			need(tag === TT_REC_TAGS.pointer ? 7 : 3);
			const kind = view.getUint8(offset);
			record.kind = kind & 0x7f;
			record.processed = kind >= 0x80;
			record.code = view.getUint16(offset + 1, true);
			offset += 3;
			if (tag === TT_REC_TAGS.pointer) {
				record.x = view.getUint16(offset, true) / 65535;
				record.y = view.getUint16(offset + 2, true) / 65535;
				offset += 4;
			}
		} else if (tag === TT_REC_TAGS.string) {
			need(3);
			const id = view.getUint16(offset, true);
			const length = view.getUint8(offset + 2);
			need(3 + length);
			const text = utf8.decode(bytes.subarray(offset + 3, offset + 3 + length));
			strings.set(id, text);
			record.id = id;
			record.text = text;
			offset += 3 + length;
		} else if (tag === TT_REC_TAGS.event) {
			need(3);
			record.kind = view.getUint8(offset);
			const id = view.getUint16(offset + 1, true);
			record.id = id;
			if (id !== NO_STRING) record.text = strings.get(id);
			offset += 3;
		} else {
			throw new Error(`tt-rec-1: unknown record tag ${tag} at byte ${offset - 3}`);
		}
		result.records.push(record);
	}
	return result;
}

/** A camera look direction from yaw (0 = facing -Z) and pitch (up positive). */
export function lookVector(yaw: number, pitch: number): Vec3 {
	const c = Math.cos(pitch);
	return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

/** Key/Pointer kinds that count as an input (2, 4, 6, 8: key/mouse/touch/pad up, not inputs of their own). */
const INPUT_KINDS: Record<number, RecordingInputType | undefined> = {
	1: "key",
	3: "click",
	5: "tap",
	7: "pad",
	9: "stick_start",
	10: "stick_stop",
	11: "scroll",
};

const EVENT_KINDS: Record<number, RecordingInputType | undefined> = {
	1: "button",
	2: "hover",
	3: "screen_open",
	4: "screen_close",
	5: "prompt_shown",
	6: "prompt_hidden",
	7: "prompt_used",
	8: "death",
	9: "spawn",
	10: "textbox",
	11: "custom",
};

/** Decodes a session's tt-rec-1 chunks (sorted by chunk) into absolute-time samples and inputs. */
export function decodeTtRec1(chunks: ChunkRow[]): DecodedRecording {
	const out: DecodedRecording = { pid: chunks[0]?.pid ?? "", sid: chunks[0]?.sid ?? "", samples: [], inputs: [], gaps: 0 };
	let expected = chunks[0]?.chunk ?? 0;
	for (const row of chunks) {
		if (row.chunk > expected) out.gaps = (out.gaps ?? 0) + (row.chunk - expected);
		expected = row.chunk + 1;
		const start = row.t ?? 0;
		const chunk = decodeTtRec1Chunk(Uint8Array.from(Buffer.from(row.data, "base64")));
		for (const r of chunk.records) {
			const t = start + r.at;
			const v = r.values;
			if (r.tag === TT_REC_TAGS.sample && v) {
				out.samples.push({ t, pos: [v[0], v[1], v[2]], yaw: v[3], cam: [v[4], v[5], v[6]], look: lookVector(v[7], v[8]) });
			} else if (r.tag === TT_REC_TAGS.camera && v) {
				out.samples.push({ t, cam: [v[0], v[1], v[2]], look: lookVector(v[3], v[4]) });
			} else if ((r.tag === TT_REC_TAGS.key || r.tag === TT_REC_TAGS.pointer) && r.kind !== undefined) {
				const type = INPUT_KINDS[r.kind];
				if (type) out.inputs.push({ t, type, ...(r.code !== undefined ? { code: r.code } : {}), processed: r.processed === true });
			} else if (r.tag === TT_REC_TAGS.event && r.kind !== undefined) {
				const type = EVENT_KINDS[r.kind];
				if (type) out.inputs.push({ t, type, ...(r.text !== undefined ? { target: r.text } : {}) });
			}
		}
	}
	return out;
}

const decoders = new Map<string, RecordingDecoder>([["tt-rec-1", { codec: "tt-rec-1", decode: decodeTtRec1 }]]);
let decoderGeneration = 0;

/** Replaces or adds a decoder (tests, or a newer codec). Returns a function that puts the previous one back. */
export function registerDecoder(decoder: RecordingDecoder): () => void {
	const previous = decoders.get(decoder.codec);
	decoders.set(decoder.codec, decoder);
	decoderGeneration++;
	return () => {
		if (previous) decoders.set(decoder.codec, previous);
		else decoders.delete(decoder.codec);
		decoderGeneration++;
	};
}

/** Changes whenever a decoder is replaced (caches of decoded sessions key on it). */
export function decoderVersion(): number {
	return decoderGeneration;
}

export function hasDecoder(codec: string): boolean {
	return decoders.has(codec);
}

export interface DecodedSessions {
	recordings: DecodedRecording[];
	/** Sessions that failed to decode (malformed chunk, unknown codec), with the first reasons. */
	failed: number;
	errors: string[];
}

/** Groups chunk rows by session and decodes each one; a session that fails is counted, not fatal. */
export function decodeSessions(rows: ChunkRow[]): DecodedSessions {
	const bySession = new Map<string, ChunkRow[]>();
	for (const row of rows) {
		// plans/36: a session's tt-ext-1 rows (extended recording) sit next to its tt-rec-1 ones; not this decoder's (an
		// unknown codec still counts as a failed session)
		if (row.codec === "tt-ext-1") continue;
		const list = bySession.get(row.sid) ?? [];
		list.push(row);
		bySession.set(row.sid, list);
	}
	const out: DecodedSessions = { recordings: [], failed: 0, errors: [] };
	for (const chunks of bySession.values()) {
		chunks.sort((a, b) => a.chunk - b.chunk);
		const decoder = decoders.get(chunks[0].codec);
		try {
			if (!decoder) throw new RecordingCodecUnavailable(`no decoder for codec ${chunks[0].codec}`);
			out.recordings.push(decoder.decode(chunks));
		} catch (error) {
			out.failed++;
			if (out.errors.length < 3) out.errors.push(`${chunks[0].sid}: ${(error as Error).message}`);
		}
	}
	return out;
}

// Confusion detectors ---------------------------------------------------------------------------------------------

/** What the player did themselves (hovers, prompts appearing, deaths and spawns don't end an idle stretch). */
const ACTIVE_INPUTS = new Set<RecordingInputType>(["key", "click", "tap", "pad", "scroll", "stick_start", "stick_stop", "button", "textbox", "prompt_used"]);

export interface DetectorOptions {
	/** Idle: at least this long with no input and (almost) no movement. Default 10 s. */
	idleSeconds?: number;
	/** Movement below this many studs counts as standing still. Default 2. */
	stillStuds?: number;
	/** Camera spin: at least this many degrees of camera turning... Default 360. */
	spinDegrees?: number;
	/** ...within this window... Default 6 s... */
	spinWindowSeconds?: number;
	/** ...while the character moved less than this. Default 4 studs. */
	spinMaxStuds?: number;
	/** Repeated clicks: this many presses of the same button... Default 3... */
	repeatClicks?: number;
	/** ...within this window, with no screen change in between. Default 2 s. */
	repeatWindowSeconds?: number;
}

export type SignalKind = "idle" | "camera_spin" | "repeated_clicks";

export interface Signal {
	kind: SignalKind;
	pid: string;
	sid: string;
	t: number;
	/** How long it lasted, ms (idle, spin) or the number of presses (repeated clicks). */
	amount: number;
	/** The button path (repeated clicks). */
	target?: string;
	/** The zone at that moment, when known. */
	zone?: string;
}

/** The zone a player was in over time (from the session's state events), for placing signals. */
export type ZoneTimeline = { t: number; zone: string | null }[];

export function zoneAt(timeline: ZoneTimeline | undefined, t: number): string | undefined {
	if (!timeline?.length) return undefined;
	let zone: string | null = null;
	for (const entry of timeline) {
		if (entry.t > t) break;
		zone = entry.zone;
	}
	return zone ?? undefined;
}

function distance(a: Vec3, b: Vec3): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Camera yaw in degrees from a look vector. */
function yaw(look: Vec3): number {
	return (Math.atan2(look[0], look[2]) * 180) / Math.PI;
}

function yawDelta(a: number, b: number): number {
	let d = b - a;
	while (d > 180) d -= 360;
	while (d < -180) d += 360;
	return Math.abs(d);
}

/** Finds idle spots, camera spins without movement, and repeated clicks in one decoded session. */
export function detectSignals(rec: DecodedRecording, zones?: ZoneTimeline, options: DetectorOptions = {}): Signal[] {
	const idleMs = (options.idleSeconds ?? 10) * 1000;
	const still = options.stillStuds ?? 2;
	const spinDeg = options.spinDegrees ?? 360;
	const spinWindow = (options.spinWindowSeconds ?? 6) * 1000;
	const spinStuds = options.spinMaxStuds ?? 4;
	const repeat = options.repeatClicks ?? 3;
	const repeatWindow = (options.repeatWindowSeconds ?? 2) * 1000;
	const signals: Signal[] = [];
	const at = (kind: SignalKind, t: number, amount: number, target?: string) => {
		const signal: Signal = { kind, pid: rec.pid, sid: rec.sid, t, amount };
		if (target !== undefined) signal.target = target;
		const zone = zoneAt(zones, t);
		if (zone !== undefined) signal.zone = zone;
		signals.push(signal);
	};
	const samples = [...rec.samples].sort((a, b) => a.t - b.t);
	const inputs = [...rec.inputs].sort((a, b) => a.t - b.t);

	// Idle: a stretch with no input and the character within `still` studs of where the stretch began.
	const activeInputs = inputs.filter((i) => ACTIVE_INPUTS.has(i.type));
	let inputIndex = 0;
	let idleStart: RecordingSample | undefined;
	let idleEnd = 0;
	const closeIdle = () => {
		if (idleStart && idleEnd - idleStart.t >= idleMs) at("idle", idleStart.t, idleEnd - idleStart.t);
		idleStart = undefined;
	};
	for (const sample of samples) {
		let hadInput = false;
		while (inputIndex < activeInputs.length && activeInputs[inputIndex].t <= sample.t) {
			hadInput = true;
			inputIndex++;
		}
		const moved = idleStart?.pos && sample.pos ? distance(idleStart.pos, sample.pos) > still : false;
		if (hadInput || moved || !sample.pos) {
			closeIdle();
			if (sample.pos && !hadInput) {
				idleStart = sample;
				idleEnd = sample.t;
			}
			continue;
		}
		if (!idleStart) idleStart = sample;
		idleEnd = sample.t;
	}
	closeIdle();

	// Camera spin: a sliding window turning >= spinDeg while the character stays within spinStuds.
	const withLook = samples.filter((s) => s.look && s.pos);
	let start = 0;
	let turned = 0;
	let lastSpinEnd = -Infinity;
	for (let i = 1; i < withLook.length; i++) {
		turned += yawDelta(yaw(withLook[i - 1].look as Vec3), yaw(withLook[i].look as Vec3));
		while (withLook[i].t - withLook[start].t > spinWindow) {
			turned -= yawDelta(yaw(withLook[start].look as Vec3), yaw(withLook[start + 1].look as Vec3));
			start++;
		}
		const moved = distance(withLook[start].pos as Vec3, withLook[i].pos as Vec3);
		if (turned >= spinDeg && moved < spinStuds && withLook[start].t > lastSpinEnd) {
			at("camera_spin", withLook[start].t, withLook[i].t - withLook[start].t);
			lastSpinEnd = withLook[i].t;
			start = i;
			turned = 0;
		}
	}

	// Repeated clicks: `repeat` presses of the same button within the window, no screen change in between.
	const presses = inputs.filter((i) => i.type === "button" || i.type === "screen_open" || i.type === "screen_close");
	let run: RecordingInput[] = [];
	const flush = () => {
		if (run.length >= repeat) at("repeated_clicks", run[0].t, run.length, run[0].target);
		run = [];
	};
	for (const input of presses) {
		if (input.type !== "button") {
			flush();
			continue;
		}
		if (run.length && (run[0].target !== input.target || input.t - run[0].t > repeatWindow)) flush();
		run.push(input);
	}
	flush();
	return signals;
}
