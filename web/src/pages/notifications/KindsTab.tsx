/**
 * The Kinds tab: per kind sent, opened, played, back the next day, skipped and pending, with its on / off switch (owners
 * who can edit), and the funnel per kind and day in a collapsible.
 */
import { DataTable, type DataColumn } from "@/components/data-table";
import { Section, ShareBar } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { fmtInt, fmtPct } from "@/lib/format";
import type { NotifyFunnelCounts, NotifyFunnelResult, NotifyQueueResult, NotifyStatus } from "@/lib/types";
import { useNotifySettings } from "./SettingsTab";
import { OnOff } from "./shared";

type DayRow = NotifyFunnelCounts & { date: string; kind: string };
type KindRow = NotifyFunnelCounts & { kind: string; skipped: number; pending: number | null; live?: NotifyStatus["kinds"][number] };

const count = <R extends NotifyFunnelCounts>(id: keyof NotifyFunnelCounts, header: string, title?: string, hidden = false): DataColumn<R> => ({
	id,
	header,
	type: "number",
	align: "right",
	...(title ? { title } : {}),
	...(hidden ? { defaultHidden: true } : {}),
	accessor: (r) => r[id],
	cell: (r) => fmtInt(r[id]),
});
const rate = <R extends NotifyFunnelCounts>(id: string, header: string, get: (r: NotifyFunnelCounts) => number, title: string, hidden = false): DataColumn<R> => ({
	id,
	header,
	type: "number",
	align: "right",
	title,
	...(hidden ? { defaultHidden: true } : {}),
	accessor: (r) => get(r),
	cell: (r) => fmtPct(get(r)),
	format: (v) => fmtPct(v as number),
});

const DAY_COLUMNS: DataColumn<DayRow>[] = [
	{ id: "date", header: "Day", accessor: (r) => r.date, cell: (r) => <span className="tabular-nums">{r.date}</span> },
	{ id: "kind", header: "Kind", accessor: (r) => r.kind, type: "enum", cell: (r) => <span className="font-mono">{r.kind || "(none)"}</span> },
	count("wants", "Wants", "want rows from game servers"),
	count("planned", "Planned"),
	count("sent", "Sent", "real sends: not dry runs, not tests"),
	count("dry", "Dry run", "planned and logged, never sent"),
	count("opened", "Opened"),
	rate("openRate", "Open rate", (r) => r.openRate, "opened / sent"),
	count("played", "Played 1 min+"),
	count("returnedD1", "Back D1", "players sent to on a day who played the next day"),
	count("assisted", "Assisted", "never opened it, came back within 24 h"),
	count("tests", "Test sends", "real sends from Send a test: they reach Roblox but stay out of Sent and the rates"),
];

export function KindsTab({ funnel, queue, status, canEdit }: { funnel: NotifyFunnelResult; queue: NotifyQueueResult | undefined; status: NotifyStatus | undefined; canEdit: boolean }) {
	const { set, busy, error } = useNotifySettings();
	const skipped = new Map<string, number>();
	for (const s of queue?.skipped ?? []) skipped.set(s.kind, (skipped.get(s.kind) ?? 0) + s.skipped);
	const names = [...new Set([...funnel.kinds.map((k) => k.kind), ...(status?.kinds.map((k) => k.kind) ?? [])])];
	const empty = funnel.totals;
	const rows: KindRow[] = names.map((kind) => {
		const f = funnel.kinds.find((k) => k.kind === kind);
		const live = status?.kinds.find((k) => k.kind === kind);
		const zero = Object.fromEntries(Object.keys(empty).map((k) => [k, 0])) as unknown as NotifyFunnelCounts;
		return { ...(f ?? zero), kind, skipped: skipped.get(kind) ?? 0, pending: live ? live.pending : null, ...(live ? { live } : {}) };
	});
	const columns: DataColumn<KindRow>[] = [
		{
			id: "kind",
			header: "Kind",
			accessor: (r) => r.kind,
			cell: (r) => (
				<span className="font-mono">
					{r.kind || "(none)"}
					{r.live?.halted ? (
						<Badge variant="destructive" className="ml-2 font-sans">
							stopped
						</Badge>
					) : null}
					{r.live?.text ? <span className="mt-0.5 block max-w-72 font-sans text-xs whitespace-normal break-words text-muted-foreground">{r.live.text}</span> : null}
				</span>
			),
		},
		count("sent", "Sent", "real sends: not dry runs, not tests"),
		{
			id: "openRate",
			header: "Opened",
			type: "number",
			title: "opened / sent",
			accessor: (r) => r.openRate,
			format: (v) => fmtPct(v as number),
			cell: (r) => (
				<span className="flex min-w-32 items-center gap-2">
					<ShareBar share={r.openRate} className="w-20" />
					<span className="tabular-nums">{fmtPct(r.openRate)}</span>
				</span>
			),
		},
		rate("playedRate", "Played 1 min+", (r) => r.playedRate, "played at least a minute / opened"),
		rate("returnRate", "Back D1", (r) => r.returnRate, "players sent to who played the next day"),
		{ id: "skipped", header: "Skipped", type: "number", align: "right", accessor: (r) => r.skipped, cell: (r) => fmtInt(r.skipped) },
		{ id: "pending", header: "Pending", type: "number", align: "right", accessor: (r) => r.pending, cell: (r) => (r.pending === null ? "–" : fmtInt(r.pending)) },
		count("opened", "Opens", undefined, true),
		count("played", "Played", undefined, true),
		count("returnedD1", "Returned D1", undefined, true),
		count("assisted", "Assisted", "never opened it, came back within 24 h", true),
		count("planned", "Planned", undefined, true),
		count("wants", "Wants", undefined, true),
		count("dry", "Dry run", undefined, true),
		count("tests", "Test sends", undefined, true),
		...(status
			? [
					{
						id: "on",
						header: "On",
						sortable: false,
						accessor: (r: KindRow) => (r.live ? (r.live.enabled ? "on" : "off") : ""),
						cell: (r: KindRow) =>
							r.live ? (
								canEdit ? (
									<OnOff label={`Kind ${r.kind}`} value={r.live.enabled} disabled={busy} onChange={(v) => set(`notify.kinds.${r.kind}.enabled`, v)} />
								) : (
									<Badge variant={r.live.enabled ? "outline" : "secondary"}>{r.live.enabled ? "on" : "off"}</Badge>
								)
							) : (
								<span className="text-xs text-muted-foreground">not pushed</span>
							),
					} satisfies DataColumn<KindRow>,
				]
			: []),
	];
	return (
		<div className="space-y-4">
			<Section title="Kinds" description="Per kind in this range: real sends, the share opened, played at least a minute, back the next day; skips and the live pending count.">
				<div className="space-y-2">
					<DataTable id="notify-kinds" label="Funnel by kind" columns={columns} data={rows} rowId={(r) => r.kind} density="compact" maxHeight="28rem" />
					{error ? <p className="text-sm text-destructive">{error.message}</p> : null}
				</div>
			</Section>
			<details className="group rounded-xl border bg-card">
				<summary className="cursor-pointer px-4 py-3 text-sm font-medium">By kind and day</summary>
				<div className="min-w-0 px-4 pb-4">
					<DataTable id="notify-days" label="Funnel by kind and day" columns={DAY_COLUMNS} data={funnel.days} rowId={(r) => `${r.date}|${r.kind}`} density="compact" maxHeight="24rem" />
				</div>
			</details>
		</div>
	);
}
