/**
 * Moving to this server from another one (GET / POST /v1/admin/migrate), on the Settings page: the state, the source,
 * the rows copied so far, each step, and the per-day report (rows on the old server against rows here). Pause, resume
 * and cancel while it runs; when nothing has run yet, a form that starts a move with the old server's URL and admin
 * token (a password field that empties on submit; the backend never sends the token back). Owners only, like the page;
 * on servers without the endpoint (404) or for a read-only session (403) it shows nothing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Ban, CircleAlert, Pause, Play } from "lucide-react";
import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingBlock, Section, ShareBar } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtInt, fmtPct, fmtTime, plural } from "@/lib/format";
import { daysLeft, MIGRATE_KEY, migrateActions, migratePollMs } from "@/lib/migrate";
import type { MigrateAction, MigrateDay, MigrateDecision, MigrateState, MigrateStatus, MigrateStep } from "@/lib/types";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const STATE_TEXT: Record<MigrateState, string> = {
	idle: "Idle",
	running: "Running",
	paused: "Paused",
	waiting: "Waiting",
	done: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
	needs_decision: "Needs a decision",
};
const STATE_VARIANT: Record<MigrateState, BadgeVariant> = {
	idle: "outline",
	running: "default",
	paused: "secondary",
	waiting: "secondary",
	done: "secondary",
	failed: "destructive",
	cancelled: "outline",
	needs_decision: "destructive",
};

const STEP_TEXT: Record<MigrateStep["name"], string> = {
	erased: "Erasure requests",
	identities: "Identities",
	fleet: "Fleet history",
	events: "Events",
	recordings: "Recordings",
	live: "Today (live)",
	rollups: "Rollups",
	verify: "Verify",
};
const STEP_VARIANT: Record<MigrateStep["state"], BadgeVariant> = { pending: "outline", running: "default", done: "secondary", failed: "destructive" };

const DAY_VARIANT: Record<MigrateDay["state"], BadgeVariant> = {
	pending: "outline",
	importing: "default",
	match: "secondary",
	missing: "destructive",
	differs: "destructive",
	duplicates: "destructive",
	sent: "outline",
};
const DAY_ORDER = ["pending", "importing", "match", "missing", "differs", "duplicates", "sent"] as const;

const DAY_COLUMNS: DataColumn<MigrateDay>[] = [
	{ id: "table", header: "Table", type: "enum", accessor: (d) => d.table },
	{ id: "day", header: "Day", accessor: (d) => d.day, cell: (d) => <span className="font-mono text-xs whitespace-nowrap">{d.day}</span> },
	{ id: "state", header: "State", type: "enum", order: DAY_ORDER, accessor: (d) => d.state, cell: (d) => <Badge variant={DAY_VARIANT[d.state]}>{d.state}</Badge> },
	{ id: "source", header: "Rows source", type: "number", accessor: (d) => d.rowsSource, cell: (d) => fmtInt(d.rowsSource), className: "text-right tabular-nums" },
	{ id: "target", header: "Rows here", type: "number", accessor: (d) => d.rowsTarget, cell: (d) => fmtInt(d.rowsTarget), className: "text-right tabular-nums" },
	{ id: "note", header: "Note", accessor: (d) => d.note, cell: (d) => <span className="text-xs text-muted-foreground">{d.note || "-"}</span>, className: "whitespace-normal" },
];

const ACTION_TEXT: Record<MigrateAction, { idle: string; busy: string }> = {
	pause: { idle: "Pause", busy: "Pausing" },
	resume: { idle: "Resume", busy: "Resuming" },
	cancel: { idle: "Cancel", busy: "Cancelling" },
};

/** The backend's 409 (and anything else) as one line. */
function actionError(error: Error): string {
	if (error instanceof ApiError && error.status === 409) return `Not now: ${error.message}`;
	if (error instanceof ApiError && error.status === 429) return "Too many requests: wait a moment.";
	return error.message;
}

function StepsTable({ steps }: { steps: MigrateStep[] }) {
	if (!steps.length) return null;
	return (
		<Table aria-label="Migration steps">
			<TableHeader>
				<TableRow>
					<TableHead>Step</TableHead>
					<TableHead>State</TableHead>
					<TableHead className="text-right">Done</TableHead>
					<TableHead>Note</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{steps.map((s) => (
					<TableRow key={s.name} data-step={s.name}>
						<TableCell className="whitespace-nowrap">{STEP_TEXT[s.name] ?? s.name}</TableCell>
						<TableCell>
							<Badge variant={STEP_VARIANT[s.state]}>{s.state}</Badge>
						</TableCell>
						<TableCell className="text-right tabular-nums whitespace-nowrap">{s.total ? `${fmtInt(s.done)} / ${fmtInt(s.total)}` : fmtInt(s.done)}</TableCell>
						<TableCell className="min-w-40 whitespace-normal text-xs text-muted-foreground">{s.note || "-"}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function StartForm() {
	const client = useQueryClient();
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [rate, setRate] = useState("");
	const start = useMutation({
		mutationFn: (input: { url: string; token: string; rowsPerSecond?: number }) =>
			api.migrateStart({ from: { kind: "backend", url: input.url, token: input.token }, ...(input.rowsPerSecond ? { rowsPerSecond: input.rowsPerSecond } : {}) }),
		onSuccess: (status) => client.setQueryData(MIGRATE_KEY, status),
	});
	const rateText = rate.trim();
	const rateBad = rateText !== "" && !/^\d+$/.test(rateText);
	const urlBad = url.trim() !== "" && !/^https?:\/\/\S+$/i.test(url.trim());
	const ready = Boolean(url.trim() && token.trim()) && !rateBad && !urlBad && !start.isPending;

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		const input = { url: url.trim(), token: token.trim(), ...(rateText ? { rowsPerSecond: Number(rateText) } : {}) };
		// The token leaves the page once: the field empties whatever the answer.
		setToken("");
		start.mutate(input);
	}

	return (
		<form className="space-y-3" onSubmit={submit} aria-label="Start a move">
			<p className="text-sm text-muted-foreground">
				Move to another server: start it here, on the new server. It copies the old server's history (identities, fleet, events, recordings, today's live rows) day by day and checks each day's row count against the old one. Keep the old server running until the move is done.
			</p>
			<div className="grid gap-3 md:grid-cols-[1fr_1fr_10rem]">
				<div className="min-w-0 space-y-1.5">
					<Label htmlFor="migrate-url">Old server URL</Label>
					<Input id="migrate-url" className="h-8" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://old.example.com" value={url} aria-invalid={urlBad || undefined} onChange={(e) => setUrl(e.target.value)} />
				</div>
				<div className="min-w-0 space-y-1.5">
					<Label htmlFor="migrate-token">Old server's admin token</Label>
					<Input id="migrate-token" className="h-8" type="password" autoComplete="off" spellCheck={false} placeholder="sent once, never shown again" value={token} onChange={(e) => setToken(e.target.value)} />
				</div>
				<div className="min-w-0 space-y-1.5">
					<Label htmlFor="migrate-rate">Rows per second</Label>
					<Input id="migrate-rate" className="h-8 tabular-nums" inputMode="numeric" placeholder="default" value={rate} aria-invalid={rateBad || undefined} onChange={(e) => setRate(e.target.value)} />
				</div>
			</div>
			{urlBad ? <p className="text-xs text-destructive">The URL must start with https:// (or http://).</p> : null}
			{rateBad ? <p className="text-xs text-destructive">Rows per second must be a whole number (empty: the server's default).</p> : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" size="sm" disabled={!ready}>
					<ArrowRightLeft />
					{start.isPending ? "Starting" : "Start the move"}
				</Button>
				{start.isError ? <span className="text-xs text-destructive">{actionError(start.error)}</span> : null}
			</div>
		</form>
	);
}

function Controls({ s }: { s: MigrateStatus }) {
	const client = useQueryClient();
	const [confirmCancel, setConfirmCancel] = useState(false);
	const act = useMutation({
		mutationFn: (action: MigrateAction) => api.migrateAction(action),
		onSuccess: (status) => {
			client.setQueryData(MIGRATE_KEY, status);
			setConfirmCancel(false);
		},
	});
	const actions = migrateActions(s.state);
	if (!actions.length) return null;
	const pending = act.isPending ? act.variables : undefined;
	return (
		<div className="flex flex-wrap items-center gap-2">
			{actions.includes("pause") ? (
				<Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate("pause")}>
					<Pause />
					{pending === "pause" ? ACTION_TEXT.pause.busy : ACTION_TEXT.pause.idle}
				</Button>
			) : null}
			{actions.includes("resume") ? (
				<Button size="sm" disabled={act.isPending} onClick={() => act.mutate("resume")}>
					<Play />
					{pending === "resume" ? ACTION_TEXT.resume.busy : ACTION_TEXT.resume.idle}
				</Button>
			) : null}
			{actions.includes("cancel") ? (
				<>
					<Button variant={confirmCancel ? "destructive" : "ghost"} size="sm" disabled={act.isPending} onClick={() => (confirmCancel ? act.mutate("cancel") : setConfirmCancel(true))}>
						<Ban />
						{pending === "cancel" ? ACTION_TEXT.cancel.busy : confirmCancel ? "Cancel the move?" : ACTION_TEXT.cancel.idle}
					</Button>
					{confirmCancel && !act.isPending ? (
						<Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
							Keep going
						</Button>
					) : null}
				</>
			) : null}
			{act.isError ? <span className="text-xs text-destructive">{actionError(act.error)}</span> : null}
		</div>
	);
}

/** Where the rows go: "from <old url>", "from Basin (bucket)", "to Basin". */
function Route({ s }: { s: MigrateStatus }) {
	const source = s.source;
	if (s.direction === "to-basin") return <span className="min-w-0 text-muted-foreground">from this server to Basin</span>;
	if (source?.kind === "basin")
		return (
			<span className="min-w-0 text-muted-foreground">
				from Basin <span className="font-mono break-all text-foreground">{`${source.bucket} / ${source.namespace}`}</span>
			</span>
		);
	if (source?.kind === "backend")
		return (
			<span className="min-w-0 text-muted-foreground">
				from <span className="font-mono break-all text-foreground">{source.url}</span>
			</span>
		);
	return null;
}

/** A page cut off mid-send to Basin: Basin can't dedupe or delete, so the owner picks (resend may double it, skip may lose it). */
function DecisionBlock({ decision }: { decision: MigrateDecision }) {
	const client = useQueryClient();
	const resolve = useMutation({
		mutationFn: (choice: "resend" | "skip") => api.migrateResolve(decision.page, choice),
		onSuccess: (status) => client.setQueryData(MIGRATE_KEY, status),
	});
	return (
		<Alert>
			<CircleAlert />
			<AlertTitle>A page needs a decision</AlertTitle>
			<AlertDescription>
				<p className="break-words">
					{fmtInt(decision.rows)} rows of {decision.table} {decision.day} (page <span className="font-mono">{decision.page}</span>): {decision.why}.
				</p>
				<p className="text-xs">Resend: Basin may then hold these rows twice. Skip: they may be missing in Basin. The verify step reports either.</p>
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate("resend")}>
						{resolve.isPending && resolve.variables === "resend" ? "Resending" : "Resend"}
					</Button>
					<Button variant="outline" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate("skip")}>
						{resolve.isPending && resolve.variables === "skip" ? "Skipping" : "Skip"}
					</Button>
					{resolve.isError ? <span className="text-xs text-destructive">{actionError(resolve.error)}</span> : null}
				</div>
			</AlertDescription>
		</Alert>
	);
}

export function MigrationBody({ s }: { s: MigrateStatus }) {
	if (s.state === "idle" && !s.days.length) return <StartForm />;
	const share = s.rowsTotal > 0 ? s.rowsDone / s.rowsTotal : 0;
	const left = daysLeft(s.days);
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
				<Badge variant={STATE_VARIANT[s.state] ?? "outline"} data-testid="migrate-state">
					{STATE_TEXT[s.state] ?? s.state}
				</Badge>
				<Route s={s} />
				{s.startedAt ? <span className="text-xs text-muted-foreground" title={fmtTime(s.startedAt)}>started {fmtAgo(s.startedAt)}</span> : null}
				{s.finishedAt ? <span className="text-xs text-muted-foreground" title={fmtTime(s.finishedAt)}>finished {fmtAgo(s.finishedAt)}</span> : null}
			</div>
			<div className="space-y-1">
				<div role="progressbar" aria-label="Rows copied" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
					<ShareBar share={share} tone={s.state === "failed" ? "alert" : "default"} />
				</div>
				<div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
					<span>
						{fmtInt(s.rowsDone)} of {fmtInt(s.rowsTotal)} rows ({fmtPct(share)})
					</span>
					<span>
						{s.days.length ? `${plural(left, "day")} left` : null}
						{s.rowsPerSecond ? `${s.days.length ? " · " : ""}at most ${fmtInt(s.rowsPerSecond)} rows / s` : null}
					</span>
				</div>
			</div>
			{s.waitingFor ? <p className="text-sm text-muted-foreground">Waiting for: {s.waitingFor}</p> : null}
			{s.error ? (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>The move stopped on an error</AlertTitle>
					<AlertDescription>
						<p className="break-words">{s.error}</p>
					</AlertDescription>
				</Alert>
			) : null}
			{s.state === "needs_decision" && s.decision ? <DecisionBlock decision={s.decision} /> : null}
			<Controls s={s} />
			<StepsTable steps={s.steps} />
			<DataTable
				id="migrate-days"
				label="Per-day report"
				columns={DAY_COLUMNS}
				data={s.days}
				rowId={(d) => `${d.table}:${d.day}`}
				defaultSort={[{ id: "day", desc: true }]}
				density="compact"
				maxHeight="24rem"
				empty={<EmptyState>No day listed yet.</EmptyState>}
			/>
		</div>
	);
}

/** 403 (read-only) and 404 (an older server): nothing to show, and no more polling. */
export const migrateHidden = (error: unknown) => error instanceof ApiError && (error.status === 403 || error.status === 404);

/** The move's status, shared by the card (which polls) and the banner. */
export function useMigrateStatus(options: { poll?: boolean; enabled?: boolean } = {}) {
	return useQuery({
		queryKey: MIGRATE_KEY,
		queryFn: ({ signal }) => api.migrateStatus(signal),
		retry: false,
		staleTime: 60_000,
		enabled: options.enabled ?? true,
		refetchInterval: options.poll ? (query) => (migrateHidden(query.state.error) ? false : migratePollMs(query.state.data?.state)) : false,
	});
}

export function MigrationCard() {
	const q = useMigrateStatus({ poll: true });
	if (q.isError && migrateHidden(q.error)) return null;
	return (
		<Section title="Migration" description="Moving analytics history from another server or Basin to this one, or from this one to Basin, day by day, with a row count check per day.">
			{q.data ? <MigrationBody s={q.data} /> : q.isError ? <ErrorState error={q.error} /> : <LoadingBlock rows={2} />}
		</Section>
	);
}
