import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { basinSchemaFiles, BASIN_EVENTS_SCHEMA, BASIN_RECORDINGS_SCHEMA } from "../src/basin/schema.ts";
import { EVENT_COLUMNS, RECORDING_COLUMNS } from "../src/schema.ts";
import { BatchShapeError, validateBatch, validateEvent, validateRecording } from "../src/validate.ts";

const T = 1_790_000_000_000;

const event = (over: Record<string, unknown> = {}) => ({
	v: 1,
	t: T,
	kind: "custom",
	name: "quest_done",
	pid: "p_abc",
	sid: "s_1",
	job: "job-1",
	srv: "public",
	place: 123,
	art: "a1b2c3d-1f2e3d",
	seq: 12,
	branch: "prod",
	channel: "prod",
	dev: "phone",
	newp: true,
	state: "zone:Lobby|screen:Shop|activity:round",
	exp: '{"onboarding":"short"}',
	sexp: "",
	src: "server",
	props: '{"quest":"tutorial"}',
	...over,
});

const recording = (over: Record<string, unknown> = {}) => ({
	v: 1,
	t: T,
	pid: "p_abc",
	sid: "s_1",
	job: "job-1",
	art: "a1b2c3d-1f2e3d",
	chunk: 0,
	codec: "tt-rec-1",
	data: "AAECAw==",
	n: 4,
	...over,
});

describe("validateEvent", () => {
	test("accepts a full row and keeps only known fields", () => {
		const result = validateEvent({ ...event(), extra: "dropped" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Object.keys(result.row).sort()).toEqual([...EVENT_COLUMNS].sort());
			expect("extra" in result.row).toBe(false);
		}
	});

	test("accepts a minimal server row (no player)", () => {
		const result = validateEvent({ v: 1, t: T, kind: "tech", name: "server_perf", job: "j", art: "a" });
		expect(result.ok).toBe(true);
	});

	test.each([
		[{ v: 2 }, "v must be 1"],
		[{ t: 1_790_000_000 }, "unix milliseconds"],
		[{ t: 1.5 }, "integer"],
		[{ kind: "nope" }, "kind must be one of"],
		[{ dev: "fridge" }, "dev must be one of"],
		[{ newp: "yes" }, "boolean"],
		[{ props: "{not json" }, "not valid JSON"],
		[{ props: "[1,2]" }, "JSON object"],
		[{ props: JSON.stringify({ x: "y".repeat(5000) }) }, "larger than 4096 bytes"],
		[{ exp: '{"onboarding":3}' }, "variant names"],
		[{ name: "x".repeat(200) }, "longer than 128"],
		[{ job: undefined }, "job is required"],
		[{ place: 2 ** 60 }, "integer"],
		[{ name: "a\0b" }, "NUL"],
	])("rejects %p", (over, message) => {
		const result = validateEvent(event(over));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(message);
	});

	test("purchase, currency and feedback rows come from the server only", () => {
		const purchase = { kind: "purchase", name: "product", props: '{"product":1234,"robux":99}' };
		const currency = { kind: "currency", name: "coins", props: '{"delta":50,"reason":"x"}' };
		const feedback = { kind: "feedback", name: "submit", props: '{"scale":"thumbs","type":"thumbs","steps":2,"r":1,"norm":1,"len":0,"play_s":30}' };
		for (const over of [purchase, currency, feedback]) {
			const client = validateEvent(event({ ...over, src: "client" }));
			expect(client.ok).toBe(false);
			if (!client.ok) expect(client.error).toContain("game server only");
			expect(validateEvent(event({ ...over, src: "server" })).ok).toBe(true);
			expect(validateEvent(event({ ...over, src: undefined })).ok).toBe(true); // rows from before src existed
		}
		// Other client kinds still pass.
		expect(validateEvent(event({ src: "client" })).ok).toBe(true);
		const batch = validateBatch({ events: [event(), event({ ...purchase, src: "client" }), event({ ...purchase, src: "server" })] });
		expect(batch.events.map((e) => e.kind)).toEqual(["custom", "purchase"]);
		expect(batch.rejected).toBe(1);
	});

	test("null fields count as missing", () => {
		const result = validateEvent(event({ sexp: null, props: null }));
		expect(result.ok).toBe(true);
		if (result.ok) expect("props" in result.row).toBe(false);
	});
});

describe("validateRecording", () => {
	test("accepts a chunk", () => {
		const result = validateRecording(recording());
		expect(result.ok).toBe(true);
		if (result.ok) expect(Object.keys(result.row).sort()).toEqual([...RECORDING_COLUMNS].sort());
	});
	test.each([
		[{ codec: "tt-rec-2" }, "codec must be one of"],
		[{ data: "not base64!" }, "base64"],
		[{ chunk: -1 }, "chunk"],
		[{ pid: undefined }, "pid is required"],
	])("rejects %p", (over, message) => {
		const result = validateRecording(recording(over));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(message);
	});
});

describe("validateBatch", () => {
	test("drops invalid rows and counts them", () => {
		const out = validateBatch({ events: [event(), event({ kind: "bad" }), event()], recordings: [recording(), { v: 1 }] });
		expect(out.events.length).toBe(2);
		expect(out.recordings.length).toBe(1);
		expect(out.rejected).toBe(2);
		expect(out.errors[0]).toContain("events[1]");
	});
	test("refuses a wrong shape", () => {
		expect(() => validateBatch([])).toThrow(BatchShapeError);
		expect(() => validateBatch({ events: {} })).toThrow(BatchShapeError);
		expect(() => validateBatch({ events: new Array(10).fill(event()) }, { maxRows: 5 })).toThrow("at most 5");
	});
	test("an empty body is fine", () => {
		expect(validateBatch({}).events).toEqual([]);
	});
});

describe("Basin stream schemas", () => {
	test("the committed files match the generator", () => {
		const root = join(import.meta.dir, "..");
		for (const [path, text] of Object.entries(basinSchemaFiles())) {
			expect(readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")).toBe(text);
		}
	});
	test("fields follow the contract", () => {
		expect(BASIN_EVENTS_SCHEMA.fields.map((f) => f.name)).toEqual([...EVENT_COLUMNS]);
		expect(BASIN_RECORDINGS_SCHEMA.fields.map((f) => f.name)).toEqual([...RECORDING_COLUMNS]);
		const types = Object.fromEntries(BASIN_EVENTS_SCHEMA.fields.map((f) => [f.name, f.type]));
		expect(types).toMatchObject({ v: "int32", t: "int64", place: "int64", seq: "int64", newp: "bool", props: "string" });
		const required = BASIN_EVENTS_SCHEMA.fields.filter((f) => f.required).map((f) => f.name);
		expect(required).toEqual(["v", "t", "kind", "name", "job", "art"]);
		for (const field of [...BASIN_EVENTS_SCHEMA.fields, ...BASIN_RECORDINGS_SCHEMA.fields]) {
			expect(["string", "int32", "int64", "bool"]).toContain(field.type);
		}
	});
});
