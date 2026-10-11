/**
 * A funnel's step names in a small popover that opens on hover, focus or tap: the column header lists the steps, a
 * player's progress cell lists them with the ones they reached checked and their furthest step highlighted.
 */
import { Check, Circle, Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtAgo, fmtTime } from "@/lib/format";
import type { FunnelProgress } from "@/lib/types";

export interface FunnelStepName {
	step: number;
	label: string | null;
}

/**
 * A popover that opens on hover and keyboard focus (like a tooltip) and on a tap (phones have no hover); Escape or a
 * tap outside closes it. It never takes the focus.
 */
export function HoverPopover({ trigger, children, label, className }: { trigger: ReactNode; children: ReactNode; label?: string; className?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className={cn("rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}
					onMouseEnter={() => setOpen(true)}
					onMouseLeave={() => setOpen(false)}
					onFocus={() => setOpen(true)}
					onBlur={() => setOpen(false)}
					onClick={(e) => {
						// A tap opens it (the trigger's own toggle would close a popover the hover just opened).
						e.preventDefault();
						setOpen(true);
					}}
				>
					{trigger}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-2.5 text-xs" onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
				{children}
			</PopoverContent>
		</Popover>
	);
}

/** The steps in order; with a player's progress, the reached ones checked and the furthest one highlighted (with when). */
export function FunnelStepList({ funnel, steps, progress }: { funnel: string; steps: readonly FunnelStepName[] | undefined; progress?: FunnelProgress | null }) {
	const withPlayer = progress !== undefined;
	return (
		<div className="space-y-1.5">
			<div className="font-medium">{funnel}</div>
			{steps?.length ? (
				<ol className="space-y-0.5" aria-label={`Steps of ${funnel}`}>
					{steps.map((s) => {
						const reached = !!progress && s.step <= progress.step;
						const current = !!progress && s.step === progress.step;
						return (
							<li key={s.step} aria-current={current ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded px-1.5 py-0.5", current && "bg-muted font-medium")}>
								{withPlayer ? (
									reached ? (
										<Check className="size-3.5 shrink-0 text-[var(--status-good)]" aria-label="reached" />
									) : (
										<Circle className="size-3 shrink-0 text-muted-foreground" aria-label="not reached" />
									)
								) : null}
								<span className="text-muted-foreground tabular-nums">{s.step}.</span>
								<span className="min-w-0 truncate">{s.label ?? "(no name)"}</span>
								{current && progress?.reachedAt ? (
									<span className="ml-auto shrink-0 font-normal text-muted-foreground" title={fmtTime(progress.reachedAt)}>
										{fmtAgo(progress.reachedAt)}
									</span>
								) : null}
							</li>
						);
					})}
				</ol>
			) : (
				<p className="text-muted-foreground">No step of it logged by these players in this range.</p>
			)}
			{withPlayer && !progress ? <p className="text-muted-foreground">Not started in this range.</p> : null}
		</div>
	);
}

/** The header's trigger: a small info icon that lists the funnel's steps. */
export function FunnelStepsHeaderTip({ funnel, steps }: { funnel: string; steps: readonly FunnelStepName[] | undefined }) {
	return (
		<HoverPopover label={`Steps of ${funnel}`} className="inline-flex size-5 items-center justify-center text-muted-foreground hover:text-foreground" trigger={<Info className="size-3.5" aria-hidden />}>
			<FunnelStepList funnel={funnel} steps={steps} />
		</HoverPopover>
	);
}
