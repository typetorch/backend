/**
 * Plans/30: the raw join data `jd` the framework stores on a `session` / `join` row (a privacy-safe copy of Roblox's
 * `GetJoinData()`: launch data cut to 200 bytes, teleport data as size and keys only, pids instead of UserIds). Shown
 * pretty-printed, collapsed by default, monospace; `trunc` (the copy was cut to its 1 KB cap) as a badge. Nothing without
 * a `jd`.
 */
import { Badge } from "@/components/ui/badge";

/** The `jd` object of a join row's props, or undefined (absent, or not an object). */
export function joinDataOf(props: unknown): Record<string, unknown> | undefined {
	if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
	const jd = (props as { jd?: unknown }).jd;
	return jd && typeof jd === "object" && !Array.isArray(jd) ? (jd as Record<string, unknown>) : undefined;
}

export function JoinData({ jd, label = "Join data", open = false }: { jd: Record<string, unknown> | null | undefined; label?: string; open?: boolean }) {
	if (!jd) return null;
	const keys = Array.isArray(jd.keys) ? jd.keys.filter((k): k is string => typeof k === "string") : [];
	return (
		<details className="group rounded-md border bg-muted/30 text-xs" open={open}>
			<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-2 py-1.5 select-none">
				<span className="text-muted-foreground group-open:rotate-90" aria-hidden="true">
					&#9656;
				</span>
				<span className="font-medium">{label}</span>
				{keys.length ? <span className="min-w-0 break-all text-muted-foreground">{keys.join(", ")}</span> : null}
				{jd.trunc === true ? (
					<Badge variant="outline" title="The copy was cut to fit its 1 KB cap">
						truncated
					</Badge>
				) : null}
			</summary>
			<pre className="max-h-80 overflow-auto border-t px-2 py-1.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">{JSON.stringify(jd, null, 2)}</pre>
		</details>
	);
}
