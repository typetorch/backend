/**
 * A game pass or developer product id that says what it is: the raw id stays visible (with the name beside it when
 * `showName`), and hovering, focusing or tapping it opens a small card with the item's icon, name, type and Robux price
 * (GET /v1/roblox/products, batched and cached by lib/products). An id of another kind, or one Roblox doesn't know,
 * stays just the id. With `filterColumn`, inside a DataTable, the id is a link: clicking it (or the card's "Show only
 * this") narrows the table to that column's value.
 */
import { ListFilter, Package, Ticket } from "lucide-react";
import { useId, useRef, useState, type PointerEvent } from "react";
import { cn } from "cn";
import { useTableFilter } from "@/components/data-table";
import { Button } from "@/components/ui/button";
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
	/** The table column holding this id (its accessor value is the id): clicking the id filters the table to it. */
	filterColumn?: string;
	className?: string;
}

export function ProductId({ id, kind, showName = false, filterColumn, className }: ProductIdProps) {
	const type = productTypeOf(kind);
	const n = parseProductId(id);
	if (id === null || id === undefined || id === "") return <span className="text-muted-foreground">–</span>;
	if (!type || n === undefined) return <span className={cn("font-mono", className)}>{String(id)}</span>;
	return <KnownProduct type={type} id={n} value={id} showName={showName} filterColumn={filterColumn} className={className} />;
}

function KnownProduct({ type, id, value, showName, filterColumn, className }: { type: ProductType; id: number; value: unknown; showName: boolean; filterColumn?: string; className?: string }) {
	const table = useTableFilter();
	const filter = table && filterColumn ? () => table.filterBy(filterColumn, value) : undefined;
	const { info, loading } = useProductInfo(type, id);
	const [open, setOpen] = useState(false);
	const pointer = useRef<string>("");
	const button = useRef<HTMLButtonElement>(null);
	const contentId = useId();
	const name = info?.status === "ok" ? info.name : null;
	const label = `${productTypeLabel(type)} ${id}${name ? `: ${name}` : ""}${filter ? ", click to show only this" : ""}`;
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
						"inline-flex max-w-full min-w-0 items-baseline gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
						filter ? "group cursor-pointer" : "cursor-help",
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
						// A tap toggles (the card has the filter button); a mouse click or Enter filters when it can, else keeps it open.
						if (pointer.current === "touch" || pointer.current === "pen") setOpen((v) => !v);
						else if (filter) {
							filter();
							setOpen(false);
						} else setOpen(true);
						pointer.current = "";
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") setOpen(false);
					}}
				>
					<span
						className={cn(
							"font-mono underline underline-offset-2",
							filter ? "decoration-muted-foreground/60 group-hover:text-primary group-hover:decoration-primary" : "decoration-muted-foreground/50 decoration-dotted",
						)}
					>
						{id}
					</span>
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
				{filter ? (
					<Button
						variant="outline"
						size="xs"
						className="w-full"
						onClick={() => {
							filter();
							setOpen(false);
						}}
					>
						<ListFilter className="size-3" aria-hidden />
						Show only this
					</Button>
				) : null}
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

/** "Game pass" / "Developer product" (other kinds as logged). */
export const productKindLabel = (kind: string) => (productTypeOf(kind) ? productTypeLabel(productTypeOf(kind) as ProductType) : kind);

/** A purchase kind; with `filterColumn`, inside a DataTable, a link that narrows the table to that kind. */
export function ProductKind({ kind, filterColumn }: { kind: string; filterColumn?: string }) {
	const table = useTableFilter();
	const label = productKindLabel(kind);
	if (!table || !filterColumn) return <>{label}</>;
	return (
		<button
			type="button"
			data-no-row-click
			title={`Show only ${label.toLowerCase()} purchases`}
			className="rounded-sm text-left underline decoration-muted-foreground/60 underline-offset-2 outline-none hover:text-primary hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/60"
			onClick={(e) => {
				e.stopPropagation();
				table.filterBy(filterColumn, kind);
			}}
		>
			{label}
		</button>
	);
}
