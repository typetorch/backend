/**
 * The explorer's one table. Every table in the explorer is this component:
 *
 *  - click a header to sort (ascending, descending, off); shift-click adds a column to the sort; numbers, dates and
 *    enums sort by their underlying value (`accessor`), never by the text the cell shows
 *  - a search box over the visible columns, per-column filters (checklist, range, "last 24 hours", contains), chips
 *    for the active ones
 *  - a Columns picker (checkboxes, reset), draggable column widths, a sticky header, "12 of 340 rows", paging
 *  - copy a cell or a row as JSON, export the filtered and sorted view as CSV, copy a link to the view
 *  - the view is remembered per table id in localStorage and written to the URL (`fleet-servers.sort=-players`)
 *
 * It is TanStack Table (sorting, multi-sort, paging, visibility) with the filtering, persistence and export in
 * model.ts. Define the columns outside the component (or in useMemo): the table re-reads them when the array changes.
 */
import { getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type ColumnDef, type Header } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Columns3, Download, Ellipsis, ListFilter, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useInRouterContext, useSearchParams } from "react-router";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtInt } from "@/lib/format";
import { copyText, downloadText, exportFilename } from "./clipboard";
import {
	buildSearchIndex,
	compareNormalised,
	copyValue,
	defaultView,
	describeFilter,
	effectiveView,
	filterEntries,
	filterOptions,
	isDefaultView,
	isFiltered,
	isVisible,
	numberBounds,
	PAGE_SIZES,
	resolveColumns,
	SINCE_LABELS,
	toCsv,
	type Column,
	type ColumnFilter,
	type DataColumn,
	type Entry,
	type SinceKey,
	type SortSpec,
	type TableView,
} from "./model";
import { useTableView, withViewParams, type UrlBridge } from "./use-table-view";

export interface DataTableProps<T> {
	/** Names this table for the saved view and the URL (`fleet-servers`). Unique in the app; letters, digits, - and _. */
	id: string;
	columns: readonly DataColumn<T>[];
	data: readonly T[];
	/** The table's accessible name ("Live servers"). */
	label?: string;
	/** A stable key for a row (default: its index in `data`). */
	rowId?: (row: T, index: number) => string;
	/** Skeleton rows instead of data (the header stays, so the layout doesn't jump). */
	loading?: boolean;
	/** Shown instead of the table when `data` is empty. */
	empty?: ReactNode;
	/** The sort a first visit starts with, e.g. [{ id: "count", desc: true }]. Removing every sort restores the data's own order. */
	defaultSort?: readonly SortSpec[];
	/** Rows per page (default 50; the user can pick 25 to 500). */
	pageSize?: number;
	/** The scroll area's max height (CSS), default 70vh; the header sticks inside it. */
	maxHeight?: string;
	/** The search box: "auto" (default) shows it from 6 rows up. */
	search?: boolean | "auto";
	/** Extra controls at the left of the toolbar. */
	toolbar?: ReactNode;
	/** Extra items in the Columns menu, under the column checkboxes (e.g. "Add funnel"). Mounted only while the menu is open. */
	columnsMenu?: ReactNode;
	/** Makes rows clickable (and focusable: Enter or Space). Clicks on links and buttons inside a row don't count. */
	onRowClick?: (row: T) => void;
	/** A clickable row's accessible name (what Enter or Space does, e.g. "Open error: ..."); the selected row is aria-current. */
	rowActionLabel?: (row: T) => string;
	isRowSelected?: (row: T) => boolean;
	rowClassName?: (row: T) => string | undefined;
	/** Rows shown first, outside sorting, filtering, paging and export (a total or an average). */
	pinnedRows?: readonly T[];
	/** What "Copy row as JSON" and "Copy as JSON" write (default: the row itself). */
	rowJson?: (row: T) => unknown;
	/** The per-row menu (copy cell, copy row). Default on. */
	rowMenu?: boolean;
	/** Remember the view in localStorage (default true). */
	persist?: boolean;
	/** Reflect the view in the URL query (default true; ignored without a router). */
	urlSync?: boolean;
	density?: "normal" | "compact";
	className?: string;
}

/** The table. Reflects its view in the URL when it is inside a router. */
export function DataTable<T>(props: DataTableProps<T>) {
	const inRouter = useInRouterContext();
	if (inRouter && props.urlSync !== false) return <RoutedTable {...props} />;
	return <TableImpl {...props} url={null} />;
}

/**
 * URL changes of one tick are applied together: tables that mount at the same time each want to add their own
 * parameters, and two separate navigations from the same snapshot would drop each other's.
 */
let queued: ((params: URLSearchParams) => URLSearchParams)[] = [];
function queueUrlUpdate(change: (params: URLSearchParams) => URLSearchParams, current: URLSearchParams, apply: (next: URLSearchParams) => void) {
	queued.push(change);
	if (queued.length > 1) return;
	queueMicrotask(() => {
		const changes = queued;
		queued = [];
		const next = changes.reduce((params, fn) => fn(params), new URLSearchParams(current));
		if (next.toString() !== current.toString()) apply(next);
	});
}

function RoutedTable<T>(props: DataTableProps<T>) {
	const [params, setParams] = useSearchParams();
	const url = useMemo<UrlBridge>(
		() => ({
			params,
			update: (change) => queueUrlUpdate(change, params, (next) => setParams(next, { replace: true })),
		}),
		[params, setParams],
	);
	return <TableImpl {...props} url={url} />;
}

const HEADER_BORDER = "shadow-[inset_0_-1px_0_var(--border)]";
const MIN_WIDTH = 48;

function TableImpl<T>({
	id,
	columns: specs,
	data,
	label,
	rowId,
	loading = false,
	empty,
	defaultSort,
	pageSize: pageSizeProp,
	maxHeight = "70vh",
	search: searchMode = "auto",
	toolbar,
	columnsMenu,
	onRowClick,
	rowActionLabel,
	isRowSelected,
	rowClassName,
	pinnedRows,
	rowJson,
	rowMenu = true,
	persist = true,
	density = "normal",
	className,
	url,
}: DataTableProps<T> & { url: UrlBridge | null }) {
	const resolved = useMemo(() => resolveColumns(specs, data), [specs, data]);
	const byId = useMemo(() => new Map(resolved.map((c) => [c.id, c])), [resolved]);
	const sortKey = JSON.stringify(defaultSort ?? []);
	const defaults = useMemo(() => defaultView({ sort: JSON.parse(sortKey) as SortSpec[], ...(pageSizeProp ? { pageSize: pageSizeProp } : {}) }), [sortKey, pageSizeProp]);
	const { view: saved, update, reset } = useTableView({ id, defaults, persist, url });
	const view = useMemo(() => effectiveView(saved, resolved), [saved, resolved]);

	const visibleCols = useMemo(() => resolved.filter((c) => isVisible(c, view)), [resolved, view]);
	const visibleKey = visibleCols.map((c) => c.id).join("\n");
	// The search looks at what is on screen: the visible, searchable columns.
	const index = useMemo(() => buildSearchIndex(data, visibleCols.filter((c) => c.searchable)), [data, resolved, visibleKey]);
	const search = useDeferredValue(view.search);
	const entries = useMemo(() => filterEntries(data, resolved, { search, filters: view.filters }, index), [data, resolved, search, view.filters, index]);

	// A page's own row ids, made unique (a repeated id would make two rows share a React key).
	const ids = useMemo(() => {
		const seen = new Set<string>();
		return data.map((row, i) => {
			let id = rowId ? rowId(row, i) : String(i);
			if (seen.has(id)) id = `${id}#${i}`;
			seen.add(id);
			return id;
		});
	}, [data, rowId]);

	const [pageIndex, setPageIndex] = useState(0);
	const pageCount = Math.max(1, Math.ceil(entries.length / view.pageSize));
	const page = Math.min(pageIndex, pageCount - 1);

	const columnDefs = useMemo<ColumnDef<Entry<T>>[]>(
		() =>
			resolved.map((c) => ({
				id: c.id,
				accessorFn: (e: Entry<T>) => c.norm(e.row),
				header: c.header,
				enableSorting: c.sortable,
				enableHiding: c.hideable,
				sortUndefined: "last" as const,
				sortDescFirst: (c.spec.firstSort ?? (c.type === "number" || c.type === "date" ? "desc" : "asc")) === "desc",
				sortingFn: (a, b, columnId) => compareNormalised(a.getValue(columnId), b.getValue(columnId), c.spec.order),
			})),
		[resolved],
	);
	const table = useReactTable<Entry<T>>({
		data: entries,
		columns: columnDefs,
		state: {
			sorting: view.sort,
			columnVisibility: Object.fromEntries(resolved.map((c) => [c.id, isVisible(c, view)])),
			pagination: { pageIndex: page, pageSize: view.pageSize },
		},
		onSortingChange: (change) => {
			setPageIndex(0);
			update((v) => ({ ...v, sort: typeof change === "function" ? change(view.sort) : change }));
		},
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getRowId: (e) => ids[e.i] ?? String(e.i),
		autoResetPageIndex: false,
		enableSortingRemoval: true,
		enableMultiSort: true,
	});

	const [notice, setNotice] = useState("");
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(noticeTimer.current), []);
	const flash = useCallback((message: string) => {
		setNotice(message);
		clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(""), 2500);
	}, []);
	const copy = useCallback(async (text: string, what: string) => flash((await copyText(text)) ? `Copied ${what}` : "Could not copy"), [flash]);

	const change = useCallback(
		(patch: Partial<TableView>) => {
			setPageIndex(0);
			update((v) => ({ ...v, ...patch }));
		},
		[update],
	);
	const setFilter = useCallback(
		(columnId: string, filter: ColumnFilter | undefined) => {
			const next = { ...view.filters };
			if (filter) next[columnId] = filter;
			else delete next[columnId];
			change({ filters: next });
		},
		[view.filters, change],
	);
	const setColumn = useCallback(
		(col: Column<T>, on: boolean) => {
			const next = { ...view.columns };
			if (on === !col.defaultHidden) delete next[col.id];
			else next[col.id] = on;
			// A hidden column stops sorting: nothing on screen would say why the rows are in that order.
			change({ columns: next, ...(on ? {} : { sort: view.sort.filter((s) => s.id !== col.id) }) });
		},
		[view.columns, view.sort, change],
	);
	const setSize = useCallback((columnId: string, px: number | null) => {
		update((v) => {
			const sizes = { ...v.sizes };
			if (px === null) delete sizes[columnId];
			else sizes[columnId] = Math.max(MIN_WIDTH, Math.round(px));
			return { ...v, sizes };
		});
	}, [update]);

	const total = data.length;
	const shown = entries.length;
	const filtered = isFiltered(view);
	const showSearch = searchMode === true || (searchMode === "auto" && (total > 5 || view.search !== ""));
	const sortedRows = table.getPrePaginationRowModel().rows;
	const pageRows = table.getRowModel().rows;
	const visibleLeaf = table.getVisibleLeafColumns().map((c) => byId.get(c.id)).filter((c): c is Column<T> => c !== undefined);
	const hideable = resolved.filter((c) => c.hideable);
	const cellPad = density === "compact" ? "px-2 py-1 text-xs" : "";
	const jsonOf = (row: T) => (rowJson ? rowJson(row) : row);
	const exportRows = () => sortedRows.map((r) => r.original.row);

	const exportCsv = () => {
		const csv = toCsv(visibleLeaf, exportRows());
		flash(downloadText(exportFilename(id, "csv"), csv) ? `Saved ${fmtInt(sortedRows.length)} rows` : "Could not save");
	};
	const shareLink = () => {
		const next = withViewParams(new URLSearchParams(window.location.search), id, view, defaults);
		const link = new URL(window.location.href);
		link.search = next.toString();
		void copy(link.toString(), "link");
	};

	const clearFilters = () => change({ search: "", filters: {} });
	const empty0 = total === 0 && !loading;

	if (empty0) return <div className={className}>{empty ?? <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">No rows.</p>}</div>;

	const colSpan = visibleLeaf.length + (rowMenu ? 1 : 0);
	const activeFilters = Object.entries(view.filters).flatMap(([cid, f]) => {
		const col = byId.get(cid);
		return col ? [{ col, f }] : [];
	});
	const pinned = pinnedRows ?? [];

	return (
		<div className={cn("min-w-0 space-y-2", className)} data-slot="data-table" data-table-id={id}>
			<div className="flex flex-wrap items-center gap-2">
				{showSearch ? (
					<div className="relative min-w-40 max-w-72 flex-1">
						<Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden />
						<Input
							type="search"
							aria-label={`Search ${label ?? "rows"}`}
							placeholder="Search rows"
							className="h-8 pl-8"
							value={view.search}
							onChange={(e) => change({ search: e.target.value })}
							onKeyDown={(e) => e.key === "Escape" && view.search && change({ search: "" })}
						/>
					</div>
				) : null}
				{toolbar}
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<span role="status" aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
						{notice || (filtered && !loading ? `${fmtInt(shown)} of ${fmtInt(total)} rows` : loading ? "Loading" : `${fmtInt(total)} row${total === 1 ? "" : "s"}`)}
					</span>
					{hideable.length || columnsMenu ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" size="sm" aria-label="Columns">
									<Columns3 />
									Columns
									{visibleCols.length < resolved.length ? <span className="text-muted-foreground tabular-nums">{visibleCols.length}/{resolved.length}</span> : null}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="max-h-80 w-56">
								<DropdownMenuLabel>Show columns</DropdownMenuLabel>
								{hideable.map((c) => {
									const on = isVisible(c, view);
									return (
										<DropdownMenuCheckboxItem key={c.id} checked={on} disabled={on && visibleCols.length <= 1} onCheckedChange={(next) => setColumn(c, next === true)} onSelect={(e) => e.preventDefault()}>
											{c.header}
										</DropdownMenuCheckboxItem>
									);
								})}
								{columnsMenu ? (
									<>
										<DropdownMenuSeparator />
										{columnsMenu}
									</>
								) : null}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onSelect={(e) => {
										e.preventDefault();
										// Columns that are hidden by default stop sorting, as when they are hidden by hand.
										change({ columns: {}, sizes: {}, sort: view.sort.filter((s) => !byId.get(s.id)?.defaultHidden) });
									}}
								>
									<RotateCcw />
									Reset columns
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm" aria-label="Export and view options">
								<Download />
								<span className="hidden sm:inline">Export</span>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-60">
							<DropdownMenuItem onSelect={exportCsv}>Download CSV ({fmtInt(sortedRows.length)} rows)</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void copy(toCsv(visibleLeaf, exportRows()), "CSV")}>Copy as CSV</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void copy(JSON.stringify(exportRows().map(jsonOf), null, 2), "JSON")}>Copy as JSON</DropdownMenuItem>
							<DropdownMenuSeparator />
							{url ? <DropdownMenuItem onSelect={shareLink}>Copy link to this view</DropdownMenuItem> : null}
							<DropdownMenuItem disabled={isDefaultView(view, defaults) && !filtered} onSelect={() => { setPageIndex(0); reset(); }}>
								<RotateCcw />
								Reset view
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{activeFilters.length || view.search.trim() ? (
				<div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
					{activeFilters.map(({ col, f }) => (
						<button
							key={col.id}
							type="button"
							className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
							aria-label={`Remove filter ${col.header}: ${describeFilter(col, f)}`}
							onClick={() => setFilter(col.id, undefined)}
						>
							<span className="truncate">
								<span className="text-muted-foreground">{col.header}:</span> {describeFilter(col, f)}
							</span>
							<X className="size-3 shrink-0" aria-hidden />
						</button>
					))}
					<Button variant="ghost" size="xs" onClick={clearFilters}>
						Clear {activeFilters.length ? "filters" : "search"}
					</Button>
				</div>
			) : null}

			<div
				className="relative w-full overflow-auto rounded-lg border"
				style={{ maxHeight: maxHeight === "none" ? undefined : maxHeight }}
				role="region"
				aria-label={label ? `${label}, scrollable` : "Table, scrollable"}
				tabIndex={0}
			>
				<table className="w-full caption-bottom text-sm" aria-label={label} aria-busy={loading || undefined}>
					<TableHeader>
						<TableRow className="border-b-0 hover:bg-transparent">
							{table.getHeaderGroups()[0]?.headers.map((header) => {
								const col = byId.get(header.column.id);
								if (!col) return null;
								return (
									<HeaderCell
										key={header.id}
										header={header}
										col={col}
										rows={data}
										filter={view.filters[col.id]}
										onFilter={(f) => setFilter(col.id, f)}
										width={view.sizes[col.id]}
										onResize={(px) => setSize(col.id, px)}
										multi={view.sort.length > 1}
										pad={cellPad}
									/>
								);
							})}
							{rowMenu ? <TableHead className={cn("sticky top-0 z-10 w-8 bg-background px-1", HEADER_BORDER)}><span className="sr-only">Row actions</span></TableHead> : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{loading
							? Array.from({ length: 5 }, (_, r) => (
									<TableRow key={r} className="hover:bg-transparent">
										{Array.from({ length: colSpan }, (_, c) => (
											<TableCell key={c} className={cellPad}>
												<Skeleton className="h-4 w-full min-w-10" />
											</TableCell>
										))}
									</TableRow>
								))
							: null}
						{!loading
							? pinned.map((row, r) => (
									<TableRow key={`pin-${r}`} className="bg-muted/30 font-medium hover:bg-muted/30">
										{visibleLeaf.map((col) => (
											<BodyCell key={col.id} col={col} row={row} size={view.sizes[col.id]} pad={cellPad} />
										))}
										{rowMenu ? <TableCell /> : null}
									</TableRow>
								))
							: null}
						{!loading && shown === 0 ? (
							<TableRow className="hover:bg-transparent">
								<TableCell colSpan={colSpan} className="py-6 text-center text-muted-foreground whitespace-normal">
									No rows match.{" "}
									<Button variant="link" size="sm" onClick={clearFilters}>
										Clear filters
									</Button>
								</TableCell>
							</TableRow>
						) : null}
						{!loading
							? pageRows.map((r) => {
									const row = r.original.row;
									const selected = isRowSelected?.(row) ?? false;
									return (
										<TableRow
											key={r.id}
											data-state={selected ? "selected" : undefined}
											className={cn("group/row", onRowClick && "cursor-pointer", rowClassName?.(row))}
											{...(onRowClick
												? {
														tabIndex: 0,
														...(rowActionLabel ? { "aria-label": rowActionLabel(row) } : {}),
														...(selected ? { "aria-current": true } : {}),
														onClick: (e: React.MouseEvent) => {
															if ((e.target as HTMLElement).closest("a,button,input,select,textarea,[role=menuitem],[data-no-row-click]")) return;
															if (window.getSelection()?.toString()) return;
															onRowClick(row);
														},
														onKeyDown: (e: KeyboardEvent) => {
															if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
																e.preventDefault();
																onRowClick(row);
															}
														},
													}
												: {})}
										>
											{visibleLeaf.map((col) => (
												<BodyCell key={col.id} col={col} row={row} size={view.sizes[col.id]} pad={cellPad} />
											))}
											{rowMenu ? (
												<TableCell className="w-8 px-1 py-0 text-right">
													<RowMenu cols={visibleLeaf} row={row} json={jsonOf(row)} onCopy={copy} />
												</TableCell>
											) : null}
										</TableRow>
									);
								})
							: null}
					</TableBody>
				</table>
			</div>

			{!loading && pageCount > 1 ? (
				<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
					<span className="tabular-nums">
						{fmtInt(page * view.pageSize + 1)} to {fmtInt(Math.min(shown, (page + 1) * view.pageSize))} of {fmtInt(shown)}
					</span>
					<div className="flex items-center gap-2">
						<Select value={String(view.pageSize)} onValueChange={(v) => change({ pageSize: Number(v) })}>
							<SelectTrigger size="sm" className="w-36" aria-label="Rows per page">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{[...new Set([...PAGE_SIZES, view.pageSize])].sort((a, b) => a - b).map((n) => (
									<SelectItem key={n} value={String(n)}>
										{n} per page
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>
							<ChevronLeft />
						</Button>
						<span className="tabular-nums">
							Page {page + 1} of {pageCount}
						</span>
						<Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= pageCount - 1} onClick={() => setPageIndex(page + 1)}>
							<ChevronRight />
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}

// ---- cells --------------------------------------------------------------------------------------------------------

function widthStyle(size: number | undefined, minWidth: number | undefined): React.CSSProperties | undefined {
	if (size !== undefined) return { width: size, minWidth: size, maxWidth: size };
	return minWidth !== undefined ? { minWidth } : undefined;
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

function BodyCell<T>({ col, row, size, pad }: { col: Column<T>; row: T; size: number | undefined; pad: string }) {
	const shown = col.spec.cell ? col.spec.cell(row) : null;
	const text = shown === null ? col.text(row) : "";
	return (
		<TableCell
			className={cn(ALIGN[col.align], col.type === "number" && "tabular-nums", size !== undefined && "overflow-hidden text-ellipsis", pad, col.spec.className)}
			style={widthStyle(size, col.spec.minWidth)}
			title={size !== undefined && shown === null && text ? text : undefined}
		>
			{shown !== null ? shown : text ? text : <span className="text-muted-foreground">–</span>}
		</TableCell>
	);
}

function HeaderCell<T>({
	header,
	col,
	rows,
	filter,
	onFilter,
	width,
	onResize,
	multi,
	pad,
}: {
	header: Header<Entry<T>, unknown>;
	col: Column<T>;
	rows: readonly T[];
	filter: ColumnFilter | undefined;
	onFilter(filter: ColumnFilter | undefined): void;
	width: number | undefined;
	onResize(px: number | null): void;
	multi: boolean;
	pad: string;
}) {
	const column = header.column;
	const sorted = column.getIsSorted();
	const canSort = column.getCanSort();
	const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
	return (
		<TableHead
			scope="col"
			aria-sort={canSort ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
			className={cn("sticky top-0 z-10 bg-background", HEADER_BORDER, pad, col.spec.headerClassName)}
			style={widthStyle(width, col.spec.minWidth)}
			title={col.spec.title}
		>
			<div className={cn("flex items-center gap-0.5", col.align === "right" && "justify-end", col.align === "center" && "justify-center")}>
				{canSort ? (
					<button
						type="button"
						className={cn(
							"-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
							sorted && "text-foreground",
						)}
						title={`Sort by ${col.header} (shift-click to add a second sort)`}
						onClick={column.getToggleSortingHandler()}
					>
						{col.header}
						{col.spec.hint ? (
							<>
								{" "}
								<span className="text-[10px] font-normal text-muted-foreground">{col.spec.hint}</span>
							</>
						) : null}
						<Icon className={cn("size-3.5 shrink-0", sorted ? "opacity-100" : "opacity-40")} aria-hidden />
						{sorted && multi ? <span className="text-[10px] text-muted-foreground tabular-nums">{column.getSortIndex() + 1}</span> : null}
					</button>
				) : (
					<span>{col.header}</span>
				)}
				{col.spec.headerExtra ?? null}
				{col.filterKind ? <FilterPopover col={col} rows={rows} value={filter} onChange={onFilter} /> : null}
			</div>
			<ResizeHandle label={col.header} width={width} onResize={onResize} />
		</TableHead>
	);
}

/** The drag handle at a header's right edge. Arrow keys resize it too; double-click or Backspace forgets the width. */
function ResizeHandle({ label, width, onResize }: { label: string; width: number | undefined; onResize(px: number | null): void }) {
	const widthOf = (el: Element) => el.closest("th")?.getBoundingClientRect().width ?? width ?? 120;
	return (
		<span
			role="separator"
			aria-orientation="vertical"
			aria-label={`Resize ${label}`}
			aria-valuenow={Math.round(width ?? 0)}
			aria-valuemin={MIN_WIDTH}
			aria-valuemax={1200}
			tabIndex={0}
			className="absolute top-0 right-0 z-20 h-full w-2 cursor-col-resize touch-none select-none after:absolute after:top-1/4 after:right-0.5 after:h-1/2 after:w-px after:bg-border hover:after:bg-foreground/40 focus-visible:after:bg-ring"
			onClick={(e) => e.stopPropagation()}
			onDoubleClick={() => onResize(null)}
			onKeyDown={(e) => {
				const step = e.shiftKey ? 64 : 16;
				if (e.key === "ArrowRight") onResize(widthOf(e.currentTarget) + step);
				else if (e.key === "ArrowLeft") onResize(Math.max(MIN_WIDTH, widthOf(e.currentTarget) - step));
				else if (e.key === "Backspace" || e.key === "Delete") onResize(null);
				else return;
				e.preventDefault();
			}}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const target = e.currentTarget;
				const startX = e.clientX;
				const start = widthOf(target);
				target.setPointerCapture?.(e.pointerId);
				const move = (ev: PointerEvent) => onResize(Math.max(MIN_WIDTH, start + ev.clientX - startX));
				const stop = () => {
					target.removeEventListener("pointermove", move);
					target.removeEventListener("pointerup", stop);
					target.removeEventListener("pointercancel", stop);
				};
				target.addEventListener("pointermove", move);
				target.addEventListener("pointerup", stop);
				target.addEventListener("pointercancel", stop);
			}}
		/>
	);
}

// ---- row menu -----------------------------------------------------------------------------------------------------

function RowMenu<T>({ cols, row, json, onCopy }: { cols: readonly Column<T>[]; row: T; json: unknown; onCopy(text: string, what: string): void }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Row actions"
					className="text-muted-foreground opacity-60 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
					data-no-row-click
				>
					<Ellipsis />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 w-56" onClick={(e) => e.stopPropagation()}>
				<DropdownMenuItem onSelect={() => onCopy(JSON.stringify(json, null, 2), "row")}>Copy row as JSON</DropdownMenuItem>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Copy cell</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="max-h-72 w-64">
						{cols.map((c) => {
							const value = copyValue(c, row);
							return (
								<DropdownMenuItem key={c.id} onSelect={() => onCopy(value, c.header)}>
									<span className="shrink-0 text-muted-foreground">{c.header}</span>
									<span className="ml-auto max-w-28 truncate font-mono text-xs">{value || "empty"}</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ---- column filters -----------------------------------------------------------------------------------------------

function FilterPopover<T>({ col, rows, value, onChange }: { col: Column<T>; rows: readonly T[]; value: ColumnFilter | undefined; onChange(filter: ColumnFilter | undefined): void }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`Filter ${col.header}${value ? " (active)" : ""}`}
					className={cn(
						"rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
						value && "bg-primary/10 text-primary",
					)}
				>
					<ListFilter className="size-3.5" aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 font-normal" aria-label={`Filter ${col.header}`}>
				<div className="flex items-center justify-between gap-2">
					<span className="font-medium">{col.header}</span>
					<Button variant="ghost" size="xs" disabled={!value} onClick={() => onChange(undefined)}>
						Clear
					</Button>
				</div>
				{col.filterKind === "set" ? <SetFilter col={col} rows={rows} value={value?.kind === "set" ? value : undefined} onChange={onChange} /> : null}
				{col.filterKind === "range" ? <RangeFilter col={col} rows={rows} value={value?.kind === "range" ? value : undefined} onChange={onChange} /> : null}
				{col.filterKind === "text" ? (
					<Input
						autoFocus
						aria-label={`${col.header} contains`}
						placeholder="Contains"
						className="h-8"
						defaultValue={value?.kind === "text" ? value.q : ""}
						onChange={(e) => onChange(e.target.value ? { kind: "text", q: e.target.value } : undefined)}
					/>
				) : null}
				{col.filterKind === "since" ? (
					<div role="radiogroup" aria-label={`${col.header} within`} className="flex flex-col gap-1">
						{(["1h", "24h", "7d", "30d"] as SinceKey[]).map((k) => (
							<label key={k} className="flex items-center gap-2 py-0.5">
								<input type="radio" name={`since-${col.id}`} className="size-4 accent-primary" checked={value?.kind === "since" && value.within === k} onChange={() => onChange({ kind: "since", within: k })} />
								{SINCE_LABELS[k]}
							</label>
						))}
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

function SetFilter<T>({ col, rows, value, onChange }: { col: Column<T>; rows: readonly T[]; value: Extract<ColumnFilter, { kind: "set" }> | undefined; onChange(filter: ColumnFilter | undefined): void }) {
	const options = useMemo(() => filterOptions(col, rows), [col, rows]);
	const [find, setFind] = useState("");
	const chosen = new Set(value?.values ?? []);
	const toggle = (v: string) => {
		const next = new Set(chosen);
		if (next.has(v)) next.delete(v);
		else next.add(v);
		onChange(next.size ? { kind: "set", values: options.map((o) => o.value).filter((x) => next.has(x)).concat([...next].filter((x) => !options.some((o) => o.value === x))) } : undefined);
	};
	const listed = find ? options.filter((o) => o.label.toLowerCase().includes(find.toLowerCase())) : options;
	return (
		<div className="flex flex-col gap-1.5">
			{options.length > 10 ? <Input aria-label={`Find in ${col.header}`} placeholder="Find a value" className="h-8" value={find} onChange={(e) => setFind(e.target.value)} /> : null}
			<div className="max-h-56 overflow-y-auto pr-1">
				{listed.map((o) => (
					<label key={o.value} className="flex items-center gap-2 py-0.5">
						<input type="checkbox" className="size-4 shrink-0 accent-primary" checked={chosen.has(o.value)} onChange={() => toggle(o.value)} />
						<span className="truncate" title={o.label}>
							{o.label}
						</span>
						<span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">{fmtInt(o.count)}</span>
					</label>
				))}
				{listed.length === 0 ? <p className="py-1 text-xs text-muted-foreground">No values.</p> : null}
			</div>
			<p className="text-[11px] text-muted-foreground">Checked values only; none checked shows all.</p>
		</div>
	);
}

function RangeFilter<T>({ col, rows, value, onChange }: { col: Column<T>; rows: readonly T[]; value: Extract<ColumnFilter, { kind: "range" }> | undefined; onChange(filter: ColumnFilter | undefined): void }) {
	const bounds = useMemo(() => numberBounds(col, rows), [col, rows]);
	const [lo, setLo] = useState(value?.min?.toString() ?? "");
	const [hi, setHi] = useState(value?.max?.toString() ?? "");
	const commit = (a: string, b: string) => {
		const min = a.trim() === "" ? undefined : Number(a);
		const max = b.trim() === "" ? undefined : Number(b);
		const ok = (n: number | undefined) => n === undefined || Number.isFinite(n);
		if (!ok(min) || !ok(max)) return;
		onChange(min === undefined && max === undefined ? undefined : { kind: "range", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
	};
	return (
		<div className="grid grid-cols-2 gap-2">
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				Min
				<Input
					type="number"
					inputMode="decimal"
					className="h-8"
					placeholder={bounds ? String(bounds.min) : ""}
					value={lo}
					onChange={(e) => {
						setLo(e.target.value);
						commit(e.target.value, hi);
					}}
				/>
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				Max
				<Input
					type="number"
					inputMode="decimal"
					className="h-8"
					placeholder={bounds ? String(bounds.max) : ""}
					value={hi}
					onChange={(e) => {
						setHi(e.target.value);
						commit(lo, e.target.value);
					}}
				/>
			</label>
		</div>
	);
}
