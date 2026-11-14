/**
 * The Errors page's drop rules (backend: src/errors/drop-rules.ts, runtime setting `errorDropRules`): filter expressions
 * whose matching error logs are dropped when they arrive, never stored. The list shows each rule's drops since the
 * server started; the editor previews, as you type, which stored error kinds a rule would have caught. Saving goes
 * through PATCH /v1/admin/settings (owners); viewers see the list read-only.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, plural } from "@/lib/format";
import type { ErrorDropRule, ErrorDropRules as RulesView, DropPreview } from "@/lib/types";

/** `message = "<the template>"`, quotes and backslashes escaped: a rule for exactly this error. */
export function exactRuleFor(template: string): string {
	return `message = "${template.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A fresh id for a new rule (the counters and the list key off it). */
export function newRuleId(existing: { id: string }[]): string {
	for (let n = existing.length + 1; ; n++) {
		const id = `r${n}`;
		if (!existing.some((r) => r.id === id)) return id;
	}
}

export const DROP_EXAMPLES = [
	'message contains "Failed to load mesh"',
	'(message contains "asset" or message contains "mesh") and realm = "client"',
	"any matches /Content failed to load|HTTP 4\\d\\d/i",
	'message startswith "Infinite yield possible" and not branch = "dev"',
];

function Syntax() {
	return (
		<details className="text-xs text-muted-foreground">
			<summary className="cursor-pointer select-none">How to write one</summary>
			<div className="mt-2 space-y-1.5">
				<p>
					<code>field op value</code>, joined with <code>and</code> / <code>or</code> (and first), <code>not</code>, and parentheses. Text ignores case.
				</p>
				<p>
					Fields: <code>message</code> (names and ids already replaced), <code>stack</code>, <code>any</code> (message or stack), <code>realm</code> (server / client), <code>branch</code>, <code>build</code>, <code>fp</code>.
				</p>
				<p>
					Operators: <code>contains</code>, <code>startswith</code>, <code>endswith</code>, <code>is</code> / <code>=</code>, <code>!=</code> with <code>"text"</code>; <code>matches</code> with <code>/regex/</code> or <code>/regex/i</code>.
				</p>
				<ul className="space-y-0.5 font-mono">
					{DROP_EXAMPLES.map((e) => (
						<li key={e}>{e}</li>
					))}
				</ul>
			</div>
		</details>
	);
}

/** The preview of an expression against what is stored, a moment after the typing stops. */
function Preview({ expr }: { expr: string }) {
	const [settled, setSettled] = useState(expr);
	useEffect(() => {
		const t = setTimeout(() => setSettled(expr), 350);
		return () => clearTimeout(t);
	}, [expr]);
	const q = useQuery({
		queryKey: ["errors", "drop-preview", settled],
		queryFn: ({ signal }) => api.previewDropRule(settled, signal),
		enabled: settled.trim() !== "",
		staleTime: 30_000,
		retry: false,
	});
	if (!settled.trim()) return null;
	if (q.isPending) return <p className="text-xs text-muted-foreground">Checking...</p>;
	if (q.isError) return <ErrorState error={q.error} title="Couldn't preview" />;
	const p: DropPreview = q.data;
	if (!p.ok) return <p className="text-xs text-[var(--status-critical)]">{p.error}</p>;
	return (
		<div className="space-y-1.5 text-xs">
			<p className={cn(p.matchedKinds ? "text-foreground" : "text-muted-foreground")}>
				Would drop {plural(p.matchedKinds, "kind")} of the {fmtInt(p.kinds)} stored: {plural(p.matchedOccurrences, "error")} of {fmtInt(p.allOccurrences)} in the last {p.days} days.
			</p>
			{p.matches.length ? (
				<ul className="max-h-48 space-y-1 overflow-y-auto rounded border p-2">
					{p.matches.map((m) => (
						<li key={m.fp} className="flex items-baseline justify-between gap-3">
							<span className="min-w-0 truncate font-mono" title={m.template}>
								{m.template}
							</span>
							<span className="shrink-0 tabular-nums text-muted-foreground">
								{fmtInt(m.occurrences)} · {m.realm}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** The rules and the editor. `draft` prefills a new rule (from an error's "Drop errors like this"). */
export function ErrorDropRules({ canEdit, draft }: { canEdit: boolean; draft?: string }) {
	const client = useQueryClient();
	const q = useQuery({ queryKey: ["errors", "drop-rules"], queryFn: ({ signal }) => api.errorDropRules(signal), refetchInterval: 30_000 });
	const [expr, setExpr] = useState(draft ?? "");
	const [note, setNote] = useState("");
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		if (draft !== undefined) setExpr(draft);
	}, [draft]);

	const save = async (rules: ErrorDropRule[]) => {
		setSaving(true);
		setProblem(null);
		try {
			await api.saveSettings({ errorDropRules: rules });
			await client.invalidateQueries({ queryKey: ["errors", "drop-rules"] });
			return true;
		} catch (error) {
			setProblem((error as Error).message);
			return false;
		} finally {
			setSaving(false);
		}
	};

	if (q.isPending) return <LoadingBlock rows={3} />;
	if (q.isError) return <ErrorState error={q.error} />;
	const view: RulesView = q.data;
	const rules = view.rules.map(({ error: _error, ...r }) => r);
	const add = async () => {
		if (await save([...rules, { id: newRuleId(rules), expr: expr.trim(), ...(note.trim() ? { note: note.trim() } : {}), on: true }])) {
			setExpr("");
			setNote("");
		}
	};

	return (
		<div className="space-y-5">
			<p className="text-sm text-muted-foreground">
				Error logs a rule matches are dropped when they arrive and never stored (asset and mesh load failures, other noise). Saving a rule doesn't delete what is already stored; it stops new ones.
			</p>
			{canEdit ? (
				<div className="space-y-2 rounded-lg border p-3">
					<div className="text-sm font-medium">New rule</div>
					<Textarea className="font-mono text-xs" rows={2} spellCheck={false} placeholder={DROP_EXAMPLES[0]} value={expr} onChange={(e) => setExpr(e.target.value)} aria-label="Expression" />
					<Input className="h-8 text-xs" placeholder="Note (optional): why it is dropped" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
					<Preview expr={expr} />
					<div className="flex items-center gap-2">
						<Button size="sm" disabled={saving || !expr.trim()} onClick={add}>
							Add rule
						</Button>
						{problem ? <span className="text-xs text-[var(--status-critical)]">{problem}</span> : null}
					</div>
					<Syntax />
				</div>
			) : null}
			{rules.length === 0 ? (
				<EmptyState>No drop rules: every error log is stored.</EmptyState>
			) : (
				<ul className="space-y-2">
					{view.rules.map((r) => {
						const count = view.counts[r.id];
						return (
							<li key={r.id} className={cn("space-y-1 rounded-lg border p-3", !r.on && "opacity-60")}>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<code className="min-w-0 flex-1 break-words text-xs">{r.expr}</code>
									<div className="flex shrink-0 items-center gap-1.5">
										{r.on ? <Badge variant="outline">on</Badge> : <Badge variant="secondary">off</Badge>}
										{canEdit ? (
											<>
												<Button size="xs" variant="outline" disabled={saving} onClick={() => save(rules.map((x) => (x.id === r.id ? { ...x, on: !x.on } : x)))}>
													{r.on ? "Turn off" : "Turn on"}
												</Button>
												<Button size="xs" variant="outline" disabled={saving} onClick={() => setExpr(r.expr)} title="Copy into the editor to change it">
													Edit copy
												</Button>
												<Button size="xs" variant="outline" disabled={saving} onClick={() => save(rules.filter((x) => x.id !== r.id))}>
													Delete
												</Button>
											</>
										) : null}
									</div>
								</div>
								{r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
								{r.error ? <p className="text-xs text-[var(--status-critical)]">Not applied: {r.error}</p> : null}
								<p className="text-xs tabular-nums text-muted-foreground">
									{count ? `Dropped ${plural(count.items, "report")} (${plural(count.occurrences, "error")}), last ${fmtAgo(count.lastAt ?? undefined)}` : "Nothing dropped"} since the server started {fmtAgo(view.since)}.
								</p>
							</li>
						);
					})}
				</ul>
			)}
			{view.source === "env" ? <p className="text-xs text-muted-foreground">These come from TYPETORCH_ERROR_DROP_RULES; saving here overrides it.</p> : null}
		</div>
	);
}
