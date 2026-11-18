/**
 * Player names that survive the id re-keying, scrubbed out of the demo pack (build-pack.ts) and again out of what the demo
 * serves (prepare-data.ts, so an older pack is safe too).
 *
 * The game's tutorial spawns an NPC named "__tutorial_npc_<the player's display name>". Its name reaches the recordings'
 * string tables (button / prompt paths such as "__tutorial_npc_<name>/HumanoidRootPart/RescuePrompt") and error messages.
 * Every such name becomes "<player>" (the pack's placeholder, as for "Players.<player>"); the game's stock NPCs stay.
 */
import { decodeTtRec1Chunk, TT_REC_TAGS } from "../../../src/recording.ts";

export const NPC_PREFIX = "__tutorial_npc_";
const STOCK_NPCS = ["Inmate", "Guard", "Medic", "Warden", "Training Guard", "Training Inmate", "<player>"];
const STOCK = new Set(STOCK_NPCS);

/** A recording string (an instance path, "/"-separated; display names have no "/" or "."). */
export function scrubRecordingText(text: string): string {
	return text.replace(/__tutorial_npc_([^/.]*)/g, (whole, name: string) => (STOCK.has(name) ? whole : `${NPC_PREFIX}<player>`));
}

/** An error message ("Players.<name>", "Workspace.<name>", "__tutorial_npc_<name>" with up to one space in the name). */
export function scrubMessageText(text: string): string {
	return text
		.replace(/(Players|Workspace)\.[A-Za-z0-9_]+/g, "$1.<player>")
		.replace(new RegExp(`${NPC_PREFIX}(?!(?:${STOCK_NPCS.map((n) => n.replace(/[<>]/g, "\\$&")).join("|")})(?![A-Za-z0-9_]))[^\\s/."']+(?: [^\\s/."']+)?`, "g"), `${NPC_PREFIX}<player>`);
}

const RECORD_BYTES: Record<number, number> = {
	[TT_REC_TAGS.wait]: 3,
	[TT_REC_TAGS.anchor]: 15,
	[TT_REC_TAGS.sample]: 18,
	[TT_REC_TAGS.camera]: 11,
	[TT_REC_TAGS.key]: 6,
	[TT_REC_TAGS.pointer]: 10,
	[TT_REC_TAGS.event]: 6,
};

const decode = (base64: string) => Uint8Array.from(Buffer.from(base64, "base64"));

/** A tt-rec-1 chunk (base64) with every string record passed through scrubRecordingText; undefined when nothing changed. */
export function scrubRecordingChunk(base64: string): string | undefined {
	const bytes = decode(base64);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const parts: Uint8Array[] = [];
	let changed = false;
	let offset = 4;
	let copyFrom = 0;
	for (const record of decodeTtRec1Chunk(bytes).records) {
		// string: u8 tag, u16 dt, u16 id, u8 length, the UTF-8 text
		const size = record.tag === TT_REC_TAGS.string ? 6 + view.getUint8(offset + 5) : RECORD_BYTES[record.tag];
		if (size === undefined) throw new Error(`tt-rec-1: unknown tag ${record.tag}`);
		if (record.tag === TT_REC_TAGS.string && record.text !== undefined) {
			const text = scrubRecordingText(record.text);
			if (text !== record.text) {
				let encoded = new TextEncoder().encode(text);
				if (encoded.length > 255) encoded = encoded.subarray(0, 255);
				parts.push(bytes.subarray(copyFrom, offset + 5), Uint8Array.of(encoded.length), encoded);
				copyFrom = offset + size;
				changed = true;
			}
		}
		offset += size;
	}
	if (offset !== bytes.length) throw new Error("tt-rec-1: record sizes don't add up to the chunk");
	if (!changed) return undefined;
	parts.push(bytes.subarray(copyFrom));
	return Buffer.concat(parts).toString("base64");
}

/** The strings of a chunk the scrub would still change (empty when the chunk is clean). */
export function recordingNames(base64: string): string[] {
	return decodeTtRec1Chunk(decode(base64))
		.records.flatMap((r) => (r.text !== undefined && scrubRecordingText(r.text) !== r.text ? [r.text] : []));
}
