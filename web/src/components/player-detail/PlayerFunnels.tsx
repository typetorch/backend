/**
 * The player's progress in each funnel they started over the range: a progress bar per funnel, furthest step over it.
 * A bar (hover, focus or tap) lists the funnel's steps, the reached ones checked and the furthest one highlighted with
 * when they reached it, from the same funnel-progress answer.
 */
import { FunnelProgressBar } from "@/components/FunnelProgressBar";
import { FunnelStepList, HoverPopover } from "@/components/FunnelSteps";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalytics } from "@/lib/hooks";

export function PlayerFunnels({ pid }: { pid: string }) {
	const q = useAnalytics("funnel-progress", { pids: [pid] });
	if (q.isPending) {
		return (
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<Skeleton className="h-10" />
				<Skeleton className="h-10" />
			</div>
		);
	}
	if (q.isError) return <p className="text-xs text-muted-foreground">Couldn't load funnel progress: {q.error.message}</p>;
	const rows = q.data.progress.filter((p) => p.pid === pid).sort((a, b) => a.funnel.localeCompare(b.funnel));
	if (!rows.length) return <p className="text-xs text-muted-foreground">No funnel steps in this range.</p>;
	const stepsOf = new Map(q.data.funnels.map((f) => [f.name, f.steps]));
	return (
		<ul aria-label="Funnel progress" className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
			{rows.map((p) => (
				<li key={p.funnel} className="min-w-0">
					<HoverPopover className="block w-full space-y-1" trigger={
						<>
							<div className="flex items-baseline justify-between gap-2 text-xs">
								<span className="truncate font-medium" title={p.funnel}>
									{p.funnel}
								</span>
								<span className="shrink-0 text-muted-foreground tabular-nums">
									step {p.reached} of {p.of}
									{p.label ? `: ${p.label}` : ""}
								</span>
							</div>
							<FunnelProgressBar progress={p} />
						</>
					}>
						<FunnelStepList funnel={p.funnel} steps={stepsOf.get(p.funnel)} progress={p} />
					</HoverPopover>
				</li>
			))}
		</ul>
	);
}
