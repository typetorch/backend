/**
 * The audit log (owners only; the backend README's "Audit log"): who did what on the admin side, newest first. Sign-ins
 * (and failed ones, with the address), sign-outs, lockouts, settings changes with their old and new values (the webhook
 * only as set / not set), owner and viewer changes, trusted browsers, alert acks, erasure, backups, remote debug and
 * release starts. Filters by actor, action and outcome (kept in the URL, so a link opens the same view); older entries
 * a page at a time. The backend redacts secrets before anything is stored.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { compactJson, fmtAgo, fmtInt, fmtTime } from "@/lib/format";
import type { AuditEntry, AuditFilters, AuditPage } from "@/lib/types";

const PAGE = 100;
const ALL = "__all";
const OUTCOMES: AuditEntry["outcome"][] = ["ok", "failed", "refused"];

/** "a -> b" for a value in a change. */
const shown = (v: unknown) => (Array.isArray(v) ? v.join(", ") || "none" : typeof v === "string" ? v || '""' : JSON.stringify(v));

/** One line about what an entry changed: the settings with old -> new, owners added and removed, else its details. */
export function auditSummary(e: Pick<AuditEntry, "action" | "details">): string {
	const d = e.details ?? {};
	if (e.action === "settings.change" && Array.isArray(d.changes)) {
		return (d.changes as Record<string, unknown>[])
			.map((c) => {
				if (Array.isArray(c.added) || Array.isArray(c.removed)) {
					const added = (c.added as unknown[] | undefined) ?? [];
					const removed = (c.removed as unknown[] | undefined) ?? [];
					return `${c.key}: ${[added.length ? `+${added.join(", +")}` : "", removed.length ? `-${removed.join(", -")}` : ""].filter(Boolean).join(" ") || "reordered"}`;
				}
				return `${c.key}: ${shown(c.from)} -> ${shown(c.to)}`;
			})
			.join("; ");
	}
	if (e.action === "access.owners" && (Array.isArray(d.added) || Array.isArray(d.removed))) {
		const added = (d.added as unknown[]) ?? [];
		const removed = (d.removed as unknown[]) ?? [];
		return [`seq ${d.seq ?? "?"}`, added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : "", !added.length && !removed.length ? "no change" : ""].filter(Boolean).join("; ");
	}
	if (!Object.keys(d).length) return "";
	return compactJson(d, 240);
}

const OUTCOME_VARIANT: Record<AuditEntry["outcome"], "secondary" | "destructive" | "outline"> = { ok: "secondary", failed: "destructive", refused: "outline" };

const COLUMNS: DataColumn<AuditEntry>[] = [
	{ id: "at", header: "When", type: "date", accessor: (e) => e.at, cell: (e) => <span title={fmtTime(e.at)}>{fmtAgo(e.at)}</span>, format: (_v, e) => fmtTime(e.at), className: "text-xs whitespace-nowrap" },
	{
		id: "actor",
		header: "Who",
		accessor: (e) => e.actor,
		cell: (e) => (
			<span className="text-xs">
				{e.actor}
				{e.role !== "none" ? <span className="text-muted-foreground"> ({e.role}{e.via === "bearer" ? ", CLI token" : e.via === "cookie" ? ", explorer" : ""})</span> : null}
			</span>
		),
		minWidth: 160,
	},
	{ id: "ip", header: "Address", accessor: (e) => e.ip, cell: (e) => <span className="font-mono text-xs">{e.ip || "-"}</span> },
	{ id: "action", header: "Action", type: "enum", accessor: (e) => e.action, cell: (e) => <span className="font-mono text-xs">{e.action}</span> },
	{ id: "outcome", header: "Outcome", type: "enum", order: OUTCOMES, accessor: (e) => e.outcome, cell: (e) => <Badge variant={OUTCOME_VARIANT[e.outcome]}>{e.outcome}{e.status && e.status >= 400 ? ` ${e.status}` : ""}</Badge> },
	{ id: "details", header: "Details", accessor: auditSummary, cell: (e) => <span className="text-xs break-words whitespace-normal">{auditSummary(e)}</span>, minWidth: 240 },
	{ id: "role", header: "Role", type: "enum", accessor: (e) => e.role, defaultHidden: true },
	{ id: "status", header: "HTTP", accessor: (e) => e.status, defaultHidden: true },
	{ id: "id", header: "Id", accessor: (e) => e.id, defaultHidden: true },
];

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | undefined; options: { value: string; label: string }[]; onChange: (v: string | undefined) => void }) {
	return (
		<Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
			<SelectTrigger size="sm" className="w-full min-w-0 sm:w-56" aria-label={label}>
				<SelectValue placeholder={label} />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>{`Every ${label.toLowerCase()}`}</SelectItem>
				{value && !options.some((o) => o.value === value) ? <SelectItem value={value}>{value}</SelectItem> : null}
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export default function AuditLog() {
	const [params, setParams] = useSearchParams();
	const filters: AuditFilters = {
		...(params.get("actor") ? { actor: params.get("actor") as string } : {}),
		...(params.get("action") ? { action: params.get("action") as string } : {}),
		...(OUTCOMES.includes(params.get("outcome") as AuditEntry["outcome"]) ? { outcome: params.get("outcome") as AuditEntry["outcome"] } : {}),
	};
	const setFilter = (key: "actor" | "action" | "outcome", value: string | undefined) =>
		setParams(
			(p) => {
				const next = new URLSearchParams(p);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true },
		);

	const query = useInfiniteQuery({
		queryKey: ["audit", filters],
		queryFn: ({ pageParam, signal }) => api.audit({ ...filters, limit: PAGE, ...(pageParam ? { before: pageParam } : { facets: true }) }, signal),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (last: AuditPage) => last.next ?? undefined,
		refetchInterval: 30_000,
	});
	const pages = query.data?.pages ?? [];
	const entries = useMemo(() => pages.flatMap((p) => p.entries), [pages]);
	const facets = pages[0]?.facets;
	const keepDays = pages[0]?.keepDays;

	return (
		<div className="space-y-4">
			<PageHeader
				title="Audit log"
				description={`Who did what on the admin side: sign-ins, settings, owners and viewers, trusted browsers, alert acks, erasure, backups.${keepDays ? ` Kept ${fmtInt(keepDays)} days.` : ""} Secrets are never recorded.`}
			/>
			<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
				<FilterSelect label="Actor" value={filters.actor} options={(facets?.actors ?? []).map((a) => ({ value: a.actor, label: `${a.actor} (${fmtInt(a.entries)})` }))} onChange={(v) => setFilter("actor", v)} />
				<FilterSelect label="Action" value={filters.action} options={(facets?.actions ?? []).map((a) => ({ value: a.action, label: `${a.action} (${fmtInt(a.entries)})` }))} onChange={(v) => setFilter("action", v)} />
				<FilterSelect label="Outcome" value={filters.outcome} options={OUTCOMES.map((o) => ({ value: o, label: o }))} onChange={(v) => setFilter("outcome", v)} />
				{filters.actor || filters.action || filters.outcome ? (
					<Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
						Clear filters
					</Button>
				) : null}
			</div>
			<Section contentClassName="space-y-3">
				{query.isPending ? (
					<LoadingBlock rows={6} />
				) : query.isError ? (
					<ErrorState error={query.error} />
				) : (
						<>
							<DataTable
								id="audit-log"
								label="Audit log"
								columns={COLUMNS}
								data={entries}
								rowId={(e) => String(e.id)}
								defaultSort={[{ id: "at", desc: true }]}
								empty={<EmptyState>{filters.actor || filters.action || filters.outcome ? "No entries match these filters." : "Nothing recorded yet. Sign-ins and every change on the admin side show up here."}</EmptyState>}
							/>
							{query.hasNextPage ? (
								<Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
									{query.isFetchingNextPage ? "Loading" : "Load older entries"}
								</Button>
							) : entries.length ? (
								<p className="text-xs text-muted-foreground">That is everything kept{keepDays ? ` (the last ${fmtInt(keepDays)} days)` : ""}.</p>
							) : null}
						</>
				)}
			</Section>
		</div>
	);
}
