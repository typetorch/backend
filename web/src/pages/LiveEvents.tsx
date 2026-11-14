/**
 * The Live events page: scheduled changes to game live values ("double cash, Saturday 12:00 to Sunday 23:59 UTC"),
 * and afterwards whether each one raised playtime, revenue and so on, or just moved it in time.
 *
 *   - The signing card: the backend never signs. When servers don't hold the current schedule yet (a new event, a
 *     cancel), it shows the CLI command that signs it (bash / zsh, or PowerShell with the JSON saved as a file). Once
 *     signed, every server switches on and off at the times on its own clock, even with the backend down.
 *   - Owners schedule (name, the game values as JSON, start and end in UTC with the local time beside) and cancel.
 *   - Live now, Upcoming, Past; a past or live event opens its lift report: the event window against the same weekdays
 *     and hours of the previous weeks (default 3), each metric's lift with the baseline's normal range, the days after
 *     (a dip there = pulled forward), and a plain verdict.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Copy, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Section } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { compactJson, fmtAgo, fmtInt, fmtMinutes, fmtNum, fmtPct } from "@/lib/format";
import {
	LIFT_ROWS,
	NET_ROWS,
	fmtLift,
	fmtLocal,
	fmtSpread,
	fmtUtc,
	isoToUtcInput,
	parseValues,
	utcInputToIso,
	type Direction,
	type Lift,
	type LiftReport,
	type LiveEvent,
	type LiveEventsView,
	type SignedView,
	type SyncState,
} from "@/lib/live-events";

export const LIVE_EVENTS_KEY = ["live-events"] as const;

const STATUS_STYLE: Record<LiveEvent["status"], string> = {
	live: "bg-[var(--status-good)]/15 text-[var(--status-good)]",
	scheduled: "bg-primary/10 text-primary",
	ended: "bg-muted text-muted-foreground",
	cancelled: "bg-muted text-muted-foreground line-through",
};

export const SYNC_TEXT: Record<SyncState, { label: string; tone: "good" | "warn" | "muted" }> = {
	signed: { label: "Signed: servers have it", tone: "good" },
	outdated: { label: "Signed with other times or values: sign again", tone: "warn" },
	unsigned: { label: "Not signed yet: servers won't run it", tone: "warn" },
	"cancel-unsigned": { label: "Cancelled, but still signed: servers WILL run it until you sign", tone: "warn" },
	done: { label: "", tone: "muted" },
	unknown: { label: "Signed state unknown", tone: "muted" },
};

/** One line about the signed record the backend read back. */
export function signedText(s: SignedView): string {
	if (s.state === "unconfigured") return "The backend can't read the signed record (set OPENCLOUD_API_KEY with universe-datastores.objects:read and TYPETORCH_UNIVERSE_ID), so it can't tell whether servers have the schedule.";
	if (s.state === "missing") return "No signed settings record yet.";
	if (s.state === "error") return `Reading the signed record failed: ${s.error ?? "unknown error"}`;
	const by = s.verified === "sig" || s.verified === "sigF" ? `signature verified (${s.verified})` : s.verified === "no" ? "NOT signed by the game's keys: servers refuse it" : "signature not checked (no game signing keys on this backend)";
	return `Signed record #${s.seq}, written ${s.at ? fmtAgo(s.at) : "–"}, ${by}; read ${fmtAgo(s.readAt)}.`;
}

function Copyable({ label, text }: { label: string; text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between gap-2">
				<div className="text-xs font-medium text-muted-foreground">{label}</div>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						void navigator.clipboard?.writeText(text).then(() => setCopied(true));
					}}
				>
					<Copy className="size-3.5" />
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
		</div>
	);
}

function download(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SigningCard({ view, canEdit, refreshing, onRefresh }: { view: LiveEventsView; canEdit: boolean; refreshing: boolean; onRefresh(): void }) {
	const refresh = (
		<Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
			<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
			Check again
		</Button>
	);
	if (!view.needsSigning) {
		return (
			<Section title="Servers' schedule" description={signedText(view.signed)} actions={refresh}>
				<p className="text-sm text-muted-foreground">
					{view.signed.state === "ok" ? "Servers hold the current schedule: each event switches on and off at its times on its own." : "Sign the schedule with the CLI after every change (below when one is needed)."}
				</p>
			</Section>
		);
	}
	return (
		<Alert>
			<CalendarClock className="size-4" />
			<AlertTitle className="flex flex-wrap items-center justify-between gap-2">
				<span>Sign the schedule: servers don't have the latest changes</span>
				{refresh}
			</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					The backend can't sign (it never holds the game's key). {canEdit ? "Run this where your signing keys are" : "An owner runs this where the signing keys are"}; servers pick it up within seconds and then switch each event on and off at its times
					on their own, even if the backend is down. {signedText(view.signed)}
				</p>
				{canEdit ? (
					<>
						<Copyable label="bash / zsh" text={view.commands.bash} />
						<Copyable label="PowerShell (after Download JSON)" text={view.commands.powershell} />
						<Button size="sm" variant="outline" onClick={() => download("live-events.json", view.commands.json)}>
							<Download className="size-3.5" />
							Download JSON
						</Button>
					</>
				) : null}
			</AlertDescription>
		</Alert>
	);
}

/** The schedule form (owners). Times are UTC; the local time shows under each. */
function CreateForm({ onDone }: { onDone(): void }) {
	const [name, setName] = useState("");
	const [values, setValues] = useState('{ "cash.multiplier": 2 }');
	const [start, setStart] = useState("");
	const [end, setEnd] = useState("");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const startIso = utcInputToIso(start);
	const endIso = utcInputToIso(end);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		let parsed: Record<string, unknown>;
		try {
			parsed = parseValues(values);
		} catch (err) {
			setError((err as Error).message);
			return;
		}
		if (!startIso || !endIso) {
			setError("Pick the start and the end (UTC).");
			return;
		}
		setBusy(true);
		try {
			await api.createLiveEvent({ name: name.trim(), values: parsed, start: startIso, end: endIso, ...(note.trim() ? { note: note.trim() } : {}) });
			setName("");
			setNote("");
			onDone();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => void submit(e)} aria-label="Schedule a live event">
			<label className="space-y-1 text-sm">
				<span className="text-xs font-medium text-muted-foreground">Name</span>
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Double cash weekend" maxLength={80} required />
			</label>
			<label className="space-y-1 text-sm md:row-span-2">
				<span className="text-xs font-medium text-muted-foreground">Game values while it runs (JSON: the liveConfig keys)</span>
				<Textarea value={values} onChange={(e) => setValues(e.target.value)} className="font-mono text-xs" rows={3} aria-label="Values" />
			</label>
			<div className="grid grid-cols-2 gap-2">
				<label className="space-y-1 text-sm">
					<span className="text-xs font-medium text-muted-foreground">Start (UTC)</span>
					<Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start (UTC)" />
					<span className="block text-xs text-muted-foreground">
						{startIso ? fmtLocal(startIso) : ""}{" "}
						<button type="button" className="underline" onClick={() => setStart(isoToUtcInput(Date.now()))}>
							now
						</button>
					</span>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-xs font-medium text-muted-foreground">End (UTC)</span>
					<Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End (UTC)" />
					<span className="block text-xs text-muted-foreground">{endIso ? fmtLocal(endIso) : ""}</span>
				</label>
			</div>
			<label className="space-y-1 text-sm">
				<span className="text-xs font-medium text-muted-foreground">Note (optional)</span>
				<Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
			</label>
			<div className="flex flex-wrap items-center gap-3 md:col-span-2">
				<Button type="submit" disabled={busy || !name.trim()}>
					Schedule
				</Button>
				{error ? <span className="text-sm text-destructive">{error}</span> : <span className="text-xs text-muted-foreground">Then sign the schedule with the CLI (the card above shows the command).</span>}
			</div>
		</form>
	);
}

function directionStyle(d: Direction): string {
	return d === "up" ? "text-[var(--status-good)]" : d === "down" ? "text-[var(--status-critical)]" : "text-muted-foreground";
}

function fmtMetric(kind: (typeof LIFT_ROWS)[number]["kind"], v: number | null): string {
	if (v === null) return "–";
	if (kind === "count") return fmtInt(v);
	if (kind === "minutes") return fmtMinutes(v);
	if (kind === "share") return fmtPct(v);
	return fmtNum(v);
}

function LiftCell({ l }: { l: Lift | undefined }) {
	if (!l) return <TableCell className="text-muted-foreground">–</TableCell>;
	return (
		<TableCell className="tabular-nums">
			<span className={cn("font-medium", directionStyle(l.direction))}>{fmtLift(l.lift)}</span>
			<span className="ml-1 text-xs text-muted-foreground">({fmtSpread(l.spread)})</span>
		</TableCell>
	);
}

export function LiftReportView({ report }: { report: LiftReport }) {
	const p = report.plan;
	return (
		<div className="space-y-3">
			<p className={cn("text-sm font-medium", directionStyle(report.headline))} data-testid="verdict">
				{report.verdict}
			</p>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Metric</TableHead>
						<TableHead>Event</TableHead>
						<TableHead>Baseline</TableHead>
						<TableHead>Lift (normal range)</TableHead>
						<TableHead>{p.after ? `${p.afterDays} day${p.afterDays === 1 ? "" : "s"} after` : "After"}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{LIFT_ROWS.map((row) => (
						<TableRow key={row.key}>
							<TableCell>{row.label}</TableCell>
							<TableCell className="tabular-nums">{fmtMetric(row.kind, report.event[row.key].value)}</TableCell>
							<TableCell className="tabular-nums text-muted-foreground">{fmtMetric(row.kind, report.event[row.key].baseline)}</TableCell>
							<LiftCell l={report.event[row.key]} />
							<LiftCell l={report.after?.[row.key]} />
						</TableRow>
					))}
				</TableBody>
			</Table>
			{report.net ? (
				<p className="text-xs text-muted-foreground">
					Net over the event and the days after: {NET_ROWS.map((r) => `${r.label} ${fmtLift(report.net?.[r.key].lift)}`).join(", ")}.
				</p>
			) : null}
			<p className="text-xs text-muted-foreground">
				Baseline: the same weekdays and hours {report.weeksUsed.length ? report.weeksUsed.map((w) => `${w * (p.stepDays / 7)}`).join(", ") : "–"} week(s) earlier (the mean; the range is how much each of those weeks moved
				against the others).
				{p.skipped.length ? ` Skipped: ${p.skipped.map((s) => `${s.weeksBack * (p.stepDays / 7)} weeks back (${s.reason})`).join("; ")}.` : ""}
				{report.weeksEmpty.length ? ` No data ${report.weeksEmpty.map((w) => w * (p.stepDays / 7)).join(", ")} weeks back.` : ""}
				{p.partial ? " The event is still running: the windows are cut at now." : ""}
				{!p.partial && p.afterPartial && p.afterDays > 0 ? " The days after aren't over yet." : ""}
			</p>
		</div>
	);
}

function LiftPanel({ event }: { event: LiveEvent }) {
	const [weeks, setWeeks] = useState(3);
	const [afterDays, setAfterDays] = useState(3);
	const lift = useQuery({ queryKey: ["live-event-lift", event.id, weeks, afterDays], queryFn: ({ signal }) => api.liveEventLift(event.id, { weeks, afterDays }, signal), staleTime: 5 * 60_000 });
	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
				<label className="flex items-center gap-1">
					Baseline weeks
					<Input type="number" min={1} max={8} value={weeks} onChange={(e) => setWeeks(Math.min(8, Math.max(1, Number(e.target.value) || 3)))} className="h-7 w-16" aria-label="Baseline weeks" />
				</label>
				<label className="flex items-center gap-1">
					Days after
					<Input type="number" min={0} max={7} value={afterDays} onChange={(e) => setAfterDays(Math.min(7, Math.max(0, Number(e.target.value) || 0)))} className="h-7 w-16" aria-label="Days after" />
				</label>
			</div>
			{lift.isLoading ? <LoadingBlock rows={3} /> : lift.error ? <ErrorState error={lift.error} title="Could not build the report" /> : lift.data ? <LiftReportView report={lift.data.report} /> : null}
		</div>
	);
}

function EventRow({ event, canEdit, onChanged }: { event: LiveEvent; canEdit: boolean; onChanged(): void }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sync = event.sync ? SYNC_TEXT[event.sync] : undefined;
	const ran = event.status === "live" || event.status === "ended" || (event.status === "cancelled" && event.cancelledAt !== null && event.cancelledAt > event.start);
	return (
		<li className="space-y-2 border-b py-3 last:border-b-0">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{event.name}</span>
						<Badge className={STATUS_STYLE[event.status]}>{event.status}</Badge>
						{sync?.label ? (
							<span className={cn("text-xs", sync.tone === "good" && "text-[var(--status-good)]", sync.tone === "warn" && "text-[var(--status-warning)] font-medium", sync.tone === "muted" && "text-muted-foreground")}>{sync.label}</span>
						) : null}
					</div>
					<div className="text-xs text-muted-foreground tabular-nums">
						{fmtUtc(event.start)} to {fmtUtc(event.end)} · {fmtLocal(event.start)} to {fmtLocal(event.end)}
					</div>
					<div className="font-mono text-xs">{compactJson(event.values, 200)}</div>
					{event.note ? <div className="text-xs text-muted-foreground">{event.note}</div> : null}
					<div className="text-xs text-muted-foreground">
						by {event.createdBy}
						{event.cancelledAt ? ` · cancelled ${fmtAgo(event.cancelledAt)} by ${event.cancelledBy ?? "–"}` : ""}
					</div>
				</div>
				<div className="flex items-center gap-2">
					{ran ? (
						<Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
							{open ? "Hide report" : "Lift report"}
						</Button>
					) : null}
					{canEdit && (event.status === "scheduled" || event.status === "live") ? (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => {
								if (!globalThis.confirm?.(`Cancel "${event.name}"? Servers drop it once you sign the new schedule.`)) return;
								setBusy(true);
								setError(null);
								api.cancelLiveEvent(event.id)
									.then(onChanged)
									.catch((e: Error) => setError(e.message))
									.finally(() => setBusy(false));
							}}
						>
							Cancel
						</Button>
					) : null}
				</div>
			</div>
			{error ? <div className="text-sm text-destructive">{error}</div> : null}
			{open ? <LiftPanel event={event} /> : null}
		</li>
	);
}

function EventList({ title, events, empty, canEdit, onChanged }: { title: string; events: LiveEvent[]; empty: string; canEdit: boolean; onChanged(): void }) {
	return (
		<Section title={title}>
			{events.length ? (
				<ul>
					{events.map((e) => (
						<EventRow key={e.id} event={e} canEdit={canEdit} onChanged={onChanged} />
					))}
				</ul>
			) : (
				<EmptyState>{empty}</EmptyState>
			)}
		</Section>
	);
}

export default function LiveEvents() {
	const canEdit = !isReadOnly(useAuth());
	const client = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const view = useQuery({ queryKey: LIVE_EVENTS_KEY, queryFn: ({ signal }) => api.liveEvents(false, signal), refetchInterval: 60_000 });
	const changed = () => {
		void client.invalidateQueries({ queryKey: LIVE_EVENTS_KEY });
	};
	const data = view.data;
	const live = data?.events.filter((e) => e.status === "live") ?? [];
	const upcoming = (data?.events.filter((e) => e.status === "scheduled") ?? []).sort((a, b) => a.start.localeCompare(b.start));
	const past = data?.events.filter((e) => e.status === "ended" || e.status === "cancelled") ?? [];
	return (
		<div className="space-y-4">
			<PageHeader
				title="Live events"
				description="Scheduled changes to game live values (liveConfig keys), switched on and off by every server at the times; afterwards, whether each one raised playtime and revenue or only moved them in time."
			/>
			{view.isLoading ? <LoadingBlock rows={4} /> : null}
			{view.error ? <ErrorState error={view.error} /> : null}
			{data ? (
				<>
					<SigningCard
						view={data}
						canEdit={canEdit}
						refreshing={refreshing}
						onRefresh={() => {
							setRefreshing(true);
							api.liveEvents(true)
								.then((fresh) => client.setQueryData(LIVE_EVENTS_KEY, fresh))
								.catch(() => undefined)
								.finally(() => setRefreshing(false));
						}}
					/>
					{canEdit ? (
						<Section title="Schedule an event" description="The game reads these keys with TypeTorch.liveConfig (its parse still checks the values); two events can't set one key at the same time.">
							<CreateForm onDone={changed} />
						</Section>
					) : null}
					<EventList title="Live now" events={live} empty="Nothing running." canEdit={canEdit} onChanged={changed} />
					<EventList title="Upcoming" events={upcoming} empty="Nothing scheduled." canEdit={canEdit} onChanged={changed} />
					<EventList title="Past" events={past} empty="No past events yet." canEdit={canEdit} onChanged={changed} />
				</>
			) : null}
		</div>
	);
}
