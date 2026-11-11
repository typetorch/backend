/**
 * The Health tab: one sentence on how sending is going, who can get notifications, the opened and back-next-day trends
 * per day, and the "Needs attention" list (attention.ts), each issue linking to the tab with its detail.
 */
import { ArrowRight } from "lucide-react";
import { cn } from "cn";
import { Section } from "@/components/common";
import { Sparkline } from "@/components/Sparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isoDate } from "@/lib/filters";
import { fmtInt, fmtPct } from "@/lib/format";
import type { NotifyFunnelResult, NotifyOptinTotals, NotifyStatus } from "@/lib/types";
import type { AttentionItem, NotifyTab } from "./attention";
import { SubscriberBar } from "./shared";

export type HealthLevel = "ok" | "warn" | "error";

/** The status line: stopped / paused / dry run / normal, then today's sends, the open rate and the next-day return. */
export function healthSentence(status: NotifyStatus | undefined, funnel: NotifyFunnelResult | undefined, now = Date.now()): { level: HealthLevel; lead: string; rest: string } {
	const lead = !status
		? "Sending status is for owners."
		: status.haltedAll
			? "Every send stopped: Roblox refused the Open Cloud key."
			: !status.enabled
				? "Sending is paused."
				: status.dryRun
					? "Dry run: sends are planned and logged, never posted."
					: status.halted.some((h) => h.kind)
						? "Sending, with a kind stopped."
						: "Sending normally.";
	const level: HealthLevel = !status ? "ok" : status.haltedAll || status.halted.some((h) => h.kind) ? "error" : !status.enabled || status.dryRun ? "warn" : "ok";
	if (!funnel) return { level, lead, rest: "" };
	const today = funnel.daily.find((d) => d.date === isoDate(now))?.sent ?? 0;
	const t = funnel.totals;
	const parts = [`${fmtInt(today)} sent today`];
	if (t.sent) parts.push(`${fmtPct(t.openRate, 0)} opened`);
	if (t.players && t.returnRate > 0) parts.push(`1 in ${Math.max(1, Math.round(1 / t.returnRate))} players notified came back the next day`);
	return { level, lead, rest: `${parts.join(", ")}.` };
}

const DOT: Record<HealthLevel, string> = { ok: "bg-[var(--status-good)]", warn: "bg-[var(--status-warning)]", error: "bg-[var(--status-critical)]" };
const ISSUE: Record<AttentionItem["level"], { label: string; variant: "destructive" | "secondary" | "outline" }> = {
	error: { label: "error", variant: "destructive" },
	warn: { label: "warn", variant: "secondary" },
	info: { label: "info", variant: "outline" },
};
const TAB_NAMES: Record<NotifyTab, string> = { health: "Health", funnel: "the funnel", inbox: "the inbox", subscribers: "subscribers", kinds: "kinds", queue: "errors", settings: "settings" };

export function StatusDot({ level, className }: { level: HealthLevel; className?: string }) {
	return <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[level], className)} aria-hidden />;
}

function Trend({ label, value, values, sub }: { label: string; value: string; values: number[]; sub: string }) {
	return (
		<Card className="gap-1 py-4">
			<CardContent className="space-y-1">
				<div className="text-xs font-medium text-muted-foreground">{label}</div>
				<div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
				<Sparkline values={values} width={220} height={32} label={`${label} per day`} />
				<div className="text-xs text-muted-foreground">{sub}</div>
			</CardContent>
		</Card>
	);
}

export function HealthTab({
	status,
	funnel,
	counts,
	countsNote,
	items,
	goTab,
	ownerOnly,
}: {
	status: NotifyStatus | undefined;
	funnel: NotifyFunnelResult | undefined;
	counts: Pick<NotifyOptinTotals, "subscribed" | "notSubscribed" | "unknown"> | undefined;
	countsNote?: string;
	items: AttentionItem[];
	goTab(tab: NotifyTab): void;
	ownerOnly: boolean;
}) {
	const s = healthSentence(status, funnel);
	const daily = funnel?.daily ?? [];
	const t = funnel?.totals;
	return (
		<div className="space-y-4">
			<Card className="py-4" role="status" aria-label="Sending status">
				<CardContent className="space-y-1.5">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<StatusDot level={s.level} />
						{items.some((i) => i.level !== "info") ? `${items.filter((i) => i.level !== "info").length} to look at` : "All good"}
					</div>
					<p className="text-base">
						<span className="font-medium">{s.lead}</span> {s.rest}
					</p>
				</CardContent>
			</Card>
			<div className="grid gap-3 md:grid-cols-3">
				<Card className="gap-2 py-4">
					<CardContent className="space-y-2">
						<div className="text-xs font-medium text-muted-foreground">Who can get notifications</div>
						{counts ? <SubscriberBar counts={counts} /> : <p className="text-sm text-muted-foreground">The opt-in list is for owners.</p>}
						{countsNote ? <p className="text-xs text-muted-foreground">{countsNote}</p> : null}
						{ownerOnly ? (
							<Button type="button" variant="outline" size="sm" onClick={() => goTab("subscribers")}>
								See the list
								<ArrowRight />
							</Button>
						) : null}
					</CardContent>
				</Card>
				<Trend label="Opened" value={t?.sent ? fmtPct(t.openRate) : "–"} values={daily.map((d) => (d.sent ? d.opened / d.sent : 0))} sub="share of sends opened, per day" />
				<Trend label="Back next day" value={t?.players ? fmtPct(t.returnRate) : "–"} values={daily.map((d) => d.returnRate)} sub={`+${fmtInt(t?.assisted ?? 0)} assisted (back without opening)`} />
			</div>
			<Section title="Needs attention" description="From the live status and the range's queue and opt-in rows.">
				{items.length ? (
					<ul className="divide-y" aria-label="Needs attention">
						{items.map((item) => (
							<li key={item.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
								<Badge variant={ISSUE[item.level].variant} className="mt-0.5 w-12">
									{ISSUE[item.level].label}
								</Badge>
								<div className="min-w-0 flex-1">
									<p className="font-medium">{item.title}</p>
									<p className="text-sm text-muted-foreground">
										{item.detail}{" "}
										{item.tab !== "health" && (ownerOnly || (item.tab !== "settings" && item.tab !== "inbox" && item.tab !== "subscribers")) ? (
											<button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => goTab(item.tab)}>
												See {TAB_NAMES[item.tab]}
											</button>
										) : null}
									</p>
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">Nothing needs a look right now.</p>
				)}
			</Section>
		</div>
	);
}
