/** Pieces the Notifications tabs share: the on / off switch, small stat strips, the subscriber bar, text previews. */
import { cn } from "cn";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtInt } from "@/lib/format";
import type { NotifyOptinTotals } from "@/lib/types";

export const PICKED = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";
export const tick = (d: string) => d.slice(5);
export const hourTick = (iso: string) => iso.slice(11, 16);

export function OnOff({ label, value, disabled, onChange, on = "On", off = "Off" }: { label: string; value: boolean; disabled?: boolean; onChange(next: boolean): void; on?: string; off?: string }) {
	return (
		<ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={value ? "on" : "off"} disabled={disabled} onValueChange={(v) => v && onChange(v === "on")} aria-label={label}>
			<ToggleGroupItem value="on" className={PICKED}>
				{on}
			</ToggleGroupItem>
			<ToggleGroupItem value="off" className={PICKED}>
				{off}
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

/** A row of small numbers in one bordered strip (instead of a card per number): wraps on narrow cards. */
export function StatStrip({ items, label }: { items: { label: string; value: string; sub?: string }[]; label?: string }) {
	return (
		<dl aria-label={label} className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 2xl:grid-cols-6">
			{items.map((item) => (
				<div key={item.label} className="space-y-0.5 bg-card px-3 py-2.5">
					<dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
					<dd className="text-xl font-semibold tracking-tight tabular-nums">{item.value}</dd>
					{item.sub ? <dd className="text-xs text-muted-foreground">{item.sub}</dd> : null}
				</div>
			))}
		</dl>
	);
}

/** Subscribed / not subscribed / unknown as one bar with a legend (the opt-in the backend learned from its sends). */
export function SubscriberBar({ counts, className }: { counts: Pick<NotifyOptinTotals, "subscribed" | "notSubscribed" | "unknown">; className?: string }) {
	const total = counts.subscribed + counts.notSubscribed + counts.unknown;
	const parts = [
		{ key: "subscribed", n: counts.subscribed, label: "subscribed", color: "var(--chart-3)" },
		{ key: "not", n: counts.notSubscribed, label: "not subscribed", color: "var(--status-critical)" },
		{ key: "unknown", n: counts.unknown, label: "unknown (never sent to)", color: "var(--muted-foreground)" },
	];
	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${fmtInt(counts.subscribed)} subscribed, ${fmtInt(counts.notSubscribed)} not subscribed, ${fmtInt(counts.unknown)} unknown`}>
				{total
					? parts.map((p) => (p.n ? <div key={p.key} className={cn("h-full", p.key === "unknown" && "opacity-30")} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} /> : null))
					: null}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{parts.map((p) => (
					<span key={p.key} className="inline-flex items-center gap-1.5">
						<span className={cn("size-2 rounded-full", p.key === "unknown" && "opacity-30")} style={{ background: p.color }} aria-hidden />
						<span className="font-medium text-foreground tabular-nums">{fmtInt(p.n)}</span> {p.label}
					</span>
				))}
			</div>
		</div>
	);
}

/** A kind's text with the send's params filled in (placeholders without a value stay as they are). */
export function fillText(text: string | undefined, params: unknown): string | undefined {
	if (!text) return undefined;
	const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
	return text.replace(/\{([A-Za-z0-9_-]{1,32})\}/g, (whole, name: string) => (typeof p[name] === "string" ? (p[name] as string) : whole));
}

/** Two letters for an avatar circle: the name's first two, or the UserId's last two digits. */
export function initials(name: string | null | undefined, userId: number): string {
	return name ? name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?" : String(userId).slice(-2);
}
