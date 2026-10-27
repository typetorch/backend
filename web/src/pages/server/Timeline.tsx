/**
 * The Timeline of a server that isn't live (plans/25 offline history): its alerts, deploy reports, generation starts
 * (from its debug bundles), its start and its close or loss, newest first. Text only.
 */
import { Button } from "@/components/ui/button";
import { fmtTime } from "@/lib/format";
import type { FleetServerDetail } from "@/lib/types";
import { timelineEvents, type TimelineEvent } from "./history";
import { Tone } from "./shared";

const TONE: Record<NonNullable<TimelineEvent["tone"]>, string> = {
	critical: "bg-[var(--status-critical)]",
	warning: "bg-[var(--status-warning)]",
	info: "bg-muted-foreground",
	good: "bg-[var(--status-good)]",
};

const KIND_WORD: Record<TimelineEvent["kind"], string> = { alert: "alert", report: "deploy", swap: "swap", closed: "closed", lost: "lost", started: "start" };

export function Timeline({ detail, onBundle }: { detail: FleetServerDetail; onBundle: (id: string) => void }) {
	const events = timelineEvents(detail);
	if (!events.length) return <p className="text-sm text-muted-foreground">Nothing recorded for this server.</p>;
	return (
		<ol aria-label="Timeline" className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
			{events.map((e) => (
				<li key={e.key} className="flex flex-col gap-0.5 border-l-2 pl-3 sm:flex-row sm:gap-3">
					<span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:w-40">{fmtTime(e.at)} UTC</span>
					<span className="shrink-0 sm:w-20">
						<Tone tone={e.tone ? TONE[e.tone] : undefined}>{KIND_WORD[e.kind]}</Tone>
					</span>
					<span className="min-w-0 flex-1 space-y-0.5">
						<span className="block text-sm font-medium break-words">{e.title}</span>
						{e.detail ? <span className="block text-xs break-words whitespace-pre-wrap text-muted-foreground">{e.detail}</span> : null}
					</span>
					{e.bundle ? (
						<Button type="button" variant="link" size="sm" className="h-auto self-start p-0 text-xs" onClick={() => onBundle(e.bundle as string)}>
							Open bundle
						</Button>
					) : null}
				</li>
			))}
		</ol>
	);
}
