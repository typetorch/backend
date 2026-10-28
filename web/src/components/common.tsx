/** Small building blocks shared by the pages: headers, stat tiles, sections, loading / error / empty states. */
import type { UseQueryResult } from "@tanstack/react-query";
import { CircleAlert, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-end justify-between gap-3">
			<div className="min-w-0">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
		</div>
	);
}

export function Section({
	title,
	description,
	actions,
	children,
	className,
	contentClassName,
}: {
	title?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<Card className={cn("gap-3", className)}>
			{title || description || actions ? (
				<CardHeader>
					{title ? <CardTitle>{title}</CardTitle> : null}
					{description ? <CardDescription>{description}</CardDescription> : null}
					{actions ? <CardAction>{actions}</CardAction> : null}
				</CardHeader>
			) : null}
			<CardContent className={contentClassName}>{children}</CardContent>
		</Card>
	);
}

/** A stat tile: label, big value, one muted line under it; `delta` (a ChangeChip) sits next to the value. */
export function Metric({ label, value, sub, hint, tone, delta }: { label: ReactNode; value: ReactNode; sub?: ReactNode; hint?: ReactNode; tone?: "muted"; delta?: ReactNode }) {
	return (
		<Card className="gap-1 py-4">
			<CardContent className="space-y-1">
				<div className="text-xs font-medium text-muted-foreground">{label}</div>
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<div className={cn("text-2xl font-semibold tracking-tight tabular-nums", tone === "muted" && "text-muted-foreground")}>{value}</div>
					{delta}
				</div>
				{sub ? <div className="text-xs text-muted-foreground tabular-nums">{sub}</div> : null}
				{hint ? <div className="pt-1 text-xs leading-snug text-muted-foreground">{hint}</div> : null}
			</CardContent>
		</Card>
	);
}

export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
	return (
		<div className={cn("space-y-2", className)}>
			{Array.from({ length: rows }, (_, i) => (
				<Skeleton key={i} className="h-8 w-full" />
			))}
		</div>
	);
}

export function ErrorState({ error, title = "Could not load this" }: { error: unknown; title?: string }) {
	const message = error instanceof Error ? error.message : String(error);
	const hint =
		error instanceof ApiError && error.status === 503
			? "Start the explorer with the game repo: bun run dev -- --game <game repo> (its .env holds TYPETORCH_ADMIN_TOKEN)"
			: error instanceof ApiError && error.notFound
				? "This server doesn't have that endpoint or query yet: update and restart the backend."
				: error instanceof ApiError && (error.status === 502 || error.status === 0)
					? "Is the backend running?"
					: null;
	return (
		<Alert variant="destructive">
			<CircleAlert />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>
				<p className="break-words">{message}</p>
				{hint ? <p>{hint}</p> : null}
			</AlertDescription>
		</Alert>
	);
}

export function EmptyState({ children = "No data for these filters yet." }: { children?: ReactNode }) {
	return (
		<div className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			<Inbox className="size-4 shrink-0" />
			<div>{children}</div>
		</div>
	);
}

/** Renders a query's loading / error state, or its data. */
export function QueryState<T>({
	query,
	children,
	isEmpty,
	empty,
	loadingRows,
}: {
	query: UseQueryResult<T, Error>;
	children: (data: T) => ReactNode;
	isEmpty?: (data: T) => boolean;
	empty?: ReactNode;
	loadingRows?: number;
}) {
	if (query.isPending) return <LoadingBlock rows={loadingRows} />;
	if (query.isError) return <ErrorState error={query.error} />;
	if (isEmpty?.(query.data)) return <EmptyState>{empty}</EmptyState>;
	return <>{children(query.data)}</>;
}

/** A thin horizontal bar for a 0-1 share (tables, funnels). */
export function ShareBar({ share, className, tone = "default" }: { share: number; className?: string; tone?: "default" | "alert" }) {
	const width = Math.max(0, Math.min(1, share)) * 100;
	return (
		<div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
			<div className={cn("h-full rounded-full", tone === "alert" ? "bg-[var(--status-critical)]" : "bg-[var(--chart-1)]")} style={{ width: `${width}%` }} />
		</div>
	);
}

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
	return (
		<pre className={cn("max-h-[60vh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed", className)}>
			{typeof value === "string" ? value : JSON.stringify(value, null, 2)}
		</pre>
	);
}

/** A small "label: value" inline pair. */
export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
	return (
		<div className="flex items-baseline gap-1.5 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<span className="font-medium tabular-nums">{children}</span>
		</div>
	);
}
