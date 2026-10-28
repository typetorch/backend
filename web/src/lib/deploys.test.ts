import { describe, expect, it } from "vitest";
import { bucketIndex, deployTitle, errorChanges, groupMarks, impactWindows, labelTime, markDeploySeq, markLabel, placeOnLabels, startedByText } from "./deploys";
import type { DeployMark } from "./perf";
import type { ErrorKind, ErrorList } from "./types";

const H = 3_600_000;
const D = 86_400_000;
const T = Date.UTC(2026, 9, 8);

const mark = (id: string, at: number, extra: Partial<DeployMark> = {}): DeployMark => ({
	id,
	kind: "deploy",
	at,
	time: new Date(at).toISOString(),
	branch: "prod",
	seq: Number(id.split(":")[1]),
	artifact: null,
	channel: null,
	from: null,
	kernel: null,
	placeVersion: null,
	message: null,
	...extra,
});

describe("words", () => {
	it("titles, labels, who started it, which marks open a deploy page", () => {
		expect(deployTitle({ kind: "rollback", seq: 43, branch: "prod" })).toBe("Rollback #43 prod");
		expect(deployTitle({ kind: "resign", seq: 7, branch: null })).toBe("Re-sign #7");
		expect(markLabel(mark("deploy:42", T))).toBe("#42 prod");
		expect(markLabel(mark("mark:1", T, { kind: "kernel", seq: null, branch: null, kernel: "0.4.0" }))).toBe("kernel 0.4.0");
		expect(startedByText({ startedBy: "alice", inferred: false })).toBe("alice");
		expect(startedByText({ startedBy: null, inferred: true })).toBe("server reports");
		expect(startedByText({ startedBy: null, inferred: false })).toBe("CLI");
		expect(markDeploySeq(mark("deploy:42", T))).toBe(42);
		expect(markDeploySeq(mark("mark:3", T, { kind: "backup", seq: 41 }))).toBeNull();
	});
});

describe("markers on bars", () => {
	it("a label's start time", () => {
		expect(labelTime("2026-10-08")).toBe(T);
		expect(labelTime("2026-10-08 14:05")).toBe(T + 14 * H + 5 * 60_000);
		expect(labelTime("10-08")).toBeNaN();
	});

	it("the bar a moment falls in; the last bar as long as the one before; outside is -1", () => {
		const starts = [T, T + H, T + 2 * H];
		expect(bucketIndex(T - 1, starts)).toBe(-1);
		expect(bucketIndex(T, starts)).toBe(0);
		expect(bucketIndex(T + H + 1, starts)).toBe(1);
		expect(bucketIndex(T + 3 * H - 1, starts)).toBe(2);
		expect(bucketIndex(T + 3 * H, starts)).toBe(-1);
		expect(bucketIndex(T + D - 1, [T])).toBe(0);
		expect(bucketIndex(T, [])).toBe(-1);
	});

	it("marks on one bar share a line; marks off the chart are left out", () => {
		const place = placeOnLabels(["2026-10-08", "2026-10-09"]);
		const groups = groupMarks([mark("deploy:1", T + H), mark("deploy:2", T + 2 * H), mark("deploy:3", T + D + H), mark("deploy:4", T + 5 * D)], place);
		expect(groups.map((g) => [g.x, g.marks.map((m) => m.seq)])).toEqual([
			["2026-10-08", [1, 2]],
			["2026-10-09", [3]],
		]);
		expect(groupMarks([mark("deploy:1", T)], placeOnLabels(["10-08"]))).toEqual([]);
	});
});

describe("before vs after", () => {
	it("two equal windows, shortened to the time since the deploy, none under 5 minutes", () => {
		expect(impactWindows(T, 24, T + 48 * H)).toEqual({ before: { from: T - 24 * H, to: T }, after: { from: T, to: T + 24 * H }, ms: 24 * H });
		expect(impactWindows(T, 24, T + 2 * H + 30_000)?.ms).toBe(2 * H);
		expect(impactWindows(T, 24, T + 4 * 60_000)).toBeNull();
	});

	const kind = (fp: string, count: number): ErrorKind => ({ fp, template: `error ${fp}`, topFrame: null, realm: "server", count, players: 1, firstAt: "", lastAt: "", total: count, spark: [] });
	const list = (kinds: ErrorKind[], more = 0): ErrorList => ({ window: { from: "", to: "", bucketSeconds: 60, buckets: 1 }, kinds, totals: { count: 0, kinds: kinds.length, players: 0 }, more });

	it("error kinds with counts on both sides, new ones first", () => {
		const rows = errorChanges(list([kind("a", 5), kind("b", 2)]), list([kind("b", 9), kind("c", 1)]));
		expect(rows.map((r) => [r.fp, r.before, r.after, r.isNew])).toEqual([
			["c", 0, 1, true],
			["b", 2, 9, false],
			["a", 5, 0, false],
		]);
		// A truncated before list can't tell what is new.
		expect(errorChanges(list([kind("a", 5)], 3), list([kind("c", 1)])).some((r) => r.isNew)).toBe(false);
	});
});
