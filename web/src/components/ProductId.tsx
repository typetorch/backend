/**
 * A game pass or developer product id that says what it is: the raw id stays visible (with the name beside it when
 * `showName`), and hovering, focusing or tapping it opens a small card with the item's icon, name, type and Robux price
 * (GET /v1/roblox/products, batched and cached by lib/products). An id of another kind, or one Roblox doesn't know,
 * stays just the id.
 */
import { Package, Ticket } from "lucide-react";
import { useId, useRef, useState, type PointerEvent } from "react";
import { cn } from "cn";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { fmtInt } from "@/lib/format";
import { parseProductId, productIconUrl, productTypeLabel, productTypeOf, useProductInfo, type ProductType } from "@/lib/products";
import type { RobloxProductInfo } from "@/lib/types";

export interface ProductIdProps {
	/** The id as logged (number or digits). */
	id: unknown;
	/** The purchase kind ("gamepass", "product", ...) or a product type. */
	kind: string | null | undefined;
	/** The name beside the id (tables with room for it). */
	showName?: boolean;
	className?: string;
}

export function ProductId({ id, kind, showName = false, className }: ProductIdProps) {
	const type = productTypeOf(kind);
	const n = parseProductId(id);
	if (id === null || id === undefined || id === "") return <span className="text-muted-foreground">–</span>;
	if (!type || n === undefined) return <span className={cn("font-mono", className)}>{String(id)}</span>;
	return <KnownProduct type={type} id={n} showName={showName} className={className} />;
}

function KnownProduct({ type, id, showName, className }: { type: ProductType; id: number; showName: boolean; className?: string }) {
	const { info, loading } = useProductInfo(type, id);
	const [open, setOpen] = useState(false);
	const pointer = useRef<string>("");
	const button = useRef<HTMLButtonElement>(null);
	const contentId = useId();
	const name = info?.status === "ok" ? info.name : null;
	const label = `${productTypeLabel(type)} ${id}${name ? `: ${name}` : ""}`;
	const hover = (next: boolean) => (e: PointerEvent) => {
		if (e.pointerType === "mouse") setOpen(next);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<button
					ref={button}
					type="button"
					data-no-row-click
					aria-label={label}
					aria-expanded={open}
					aria-haspopup="dialog"
					{...(open ? { "aria-controls": contentId } : {})}
					className={cn(
						"inline-flex max-w-full min-w-0 cursor-help items-baseline gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
						className,
					)}
					onPointerDown={(e) => {
						pointer.current = e.pointerType;
					}}
					onPointerEnter={hover(true)}
					onPointerLeave={hover(false)}
					onFocus={() => {
						// A tap focuses too: its click toggles instead.
						if (pointer.current !== "touch" && pointer.current !== "pen") setOpen(true);
					}}
					onBlur={() => setOpen(false)}
					onClick={(e) => {
						e.stopPropagation();
						// A tap toggles; a mouse click or Enter keeps it open (hover and focus opened it already).
						if (pointer.current === "touch" || pointer.current === "pen") setOpen((v) => !v);
						else setOpen(true);
						pointer.current = "";
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") setOpen(false);
					}}
				>
					<span className="font-mono underline decoration-muted-foreground/50 decoration-dotted underline-offset-2">{id}</span>
					{showName && name ? <span className="min-w-0 truncate font-sans text-muted-foreground">{name}</span> : null}
				</button>
			</PopoverAnchor>
			<PopoverContent
				id={contentId}
				role="dialog"
				aria-label={label}
				side="top"
				align="start"
				className="w-64 gap-2 p-2.5"
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => {
					// The id itself handles its own taps and clicks.
					if (button.current?.contains(e.target as Node)) e.preventDefault();
				}}
				onPointerEnter={hover(true)}
				onPointerLeave={hover(false)}
			>
				<ProductCard type={type} id={id} info={info} loading={loading} />
			</PopoverContent>
		</Popover>
	);
}

function ProductCard({ type, id, info, loading }: { type: ProductType; id: number; info: RobloxProductInfo | undefined; loading: boolean }) {
	const icon = productIconUrl(info?.icon);
	const Fallback = type === "gamepass" ? Ticket : Package;
	const name = info?.status === "ok" ? info.name : null;
	const note = loading
		? "Asking Roblox..."
		: info?.status === "not_found"
			? "Roblox doesn't know this id."
			: info?.status === "unavailable" || !info
				? "Roblox didn't answer."
				: null;
	const price = info?.status === "ok" ? (info.price !== null ? `${fmtInt(info.price)} Robux` : info.forSale === false ? "Off sale" : "No price") : null;
	return (
		<div className="flex items-start gap-2.5" data-testid="product-card">
			{icon ? (
				<img src={icon} alt="" className="size-12 shrink-0 rounded-md bg-muted object-cover" referrerPolicy="no-referrer" />
			) : (
				<span className="grid size-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden>
					<Fallback className="size-5" />
				</span>
			)}
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="line-clamp-2 text-sm font-medium leading-tight">{name ?? `${productTypeLabel(type)} ${id}`}</span>
				<span className="text-xs text-muted-foreground">{productTypeLabel(type)}</span>
				{price ? <span className="text-xs font-medium tabular-nums">{price}</span> : null}
				{note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
				<span className="font-mono text-[11px] text-muted-foreground">{id}</span>
			</div>
		</div>
	);
}
