/**
 * The shared table's logic without React: column specs, the underlying value of a cell (what sorts, filters and
 * exports, never the formatted text), search and column filters, CSV, and how a view (sort, filters, hidden columns)
 * is written to and read from the URL and localStorage. DataTable.tsx is the UI on top of this.
 */
import type { ReactNode } from "react";
import { fmtNum, fmtTime } from "@/lib/format";

export type ColumnType = "text" | "number" | "date" | "enum" | "boolean";
export type FilterKind = "set" | "range" | "text" | "since";
export type SinceKey = "1h" | "24h" | "7d" | "30d";

export const SINCE_MS: Record<SinceKey, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
export const SINCE_LABELS: Record<SinceKey, string> = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };

/**
 * One column of a DataTable. The cell you SEE (`cell`) and the value a column sorts, filters and exports by
 * (`accessor`) are separate on purpose: a "47 / 60" cell has the accessor `s.players`, an "812 MB" cell has `s.memoryMb`,
 * "5 min ago" has the timestamp. Return a number for numbers, epoch ms / ISO string / Date for dates, null for "no value"
 * (missing values sort last in both directions).
 */
export interface DataColumn<T> {
	/** Stable id: keys the saved view, the URL and the picker. Use the same id for the same column across releases. */
	id: string;
	/** Label (header, Columns picker, CSV header, filter chips). */
	header: string;
	/** The underlying value (see above). */
	accessor: (row: T) => unknown;
	/** What the cell shows. Default: the formatted accessor value. */
	cell?: (row: T) => ReactNode;
	/** Sorting and filtering behaviour. Default: guessed from the first values (number, boolean, Date, else text). */
	type?: ColumnType;
	/** Plain text of the cell, for search and for the per-column filter's option labels. Default: by type. */
	format?: (value: unknown, row: T) => string;
	/** Extra text the search box should also match (e.g. a second line under the main text). */
	searchText?: (row: T) => string;
	/**
	 * The per-column filter. Default by type: enum and boolean get a checklist, number a min/max range, date a "last
	 * 24 hours" style choice; text gets none (the search box covers it). `false` turns it off, "text" adds a contains box.
	 */
	filter?: false | FilterKind;
	/** For `enum`: values to offer even when no row has them. */
	options?: readonly string[];
	/** For `enum`: the logical order for sorting and for the checklist (e.g. ["critical", "warning", "info"]). */
	order?: readonly string[];
	/** Which direction the first click sorts. Default: "desc" for numbers and dates (biggest / newest first), else "asc". */
	firstSort?: "asc" | "desc";
	sortable?: boolean;
	/** Can be hidden in the Columns picker (default true). */
	hideable?: boolean;
	/** Hidden until the user turns it on in the Columns picker. */
	defaultHidden?: boolean;
	/** Part of the search box's matches (default true). */
	searchable?: boolean;
	align?: "left" | "right" | "center";
	/** Minimum width in px (the user can still drag it wider or narrower). */
	minWidth?: number;
	/** Classes for the `td` and the `th`. */
	className?: string;
	headerClassName?: string;
	/** Tooltip for the header. */
	title?: string;
	/** A small muted word after the header label (a unit, or a SQL type). */
	hint?: string;
	/** Something after the header label that isn't part of the sort button (e.g. a details popover's trigger). */
	headerExtra?: ReactNode;
	/** The value in the CSV and in "Copy cell" (default: the accessor value; dates as ISO). */
	exportValue?: (row: T) => unknown;
}

/** A column with everything resolved. */
export interface Column<T> {
	spec: DataColumn<T>;
	id: string;
	header: string;
	type: ColumnType;
	filterKind: FilterKind | null;
	align: "left" | "right" | "center";
	sortable: boolean;
	hideable: boolean;
	defaultHidden: boolean;
	searchable: boolean;
	raw(row: T): unknown;
	/** number (numbers, dates as epoch ms, booleans as 0/1) or string, or undefined for "no value". */
	norm(row: T): number | string | undefined;
	text(row: T): string;
	exportValue(row: T): unknown;
}

export interface Entry<T> {
	row: T;
	/** Index in the data the table was given. */
	i: number;
}

// ---- values -------------------------------------------------------------------------------------------------------

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const UTC_NO_ZONE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms of a date-ish value: ms number, Date, ISO string, or "YYYY-MM-DD hh:mm:ss" (the server's UTC). */
export function toEpochMs(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "bigint") return Number(value);
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	const ms = DAY_ONLY.test(text) ? Date.parse(`${text}T00:00:00Z`) : UTC_NO_ZONE.test(text) ? Date.parse(`${text.replace(" ", "T")}Z`) : Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

/** The sortable form of a value; undefined means "no value" (sorted last). */
export function normalise(value: unknown, type: ColumnType): number | string | undefined {
	if (value === null || value === undefined) return undefined;
	switch (type) {
		case "number":
			return toNumber(value);
		case "date":
			return toEpochMs(value);
		case "boolean":
			return value === true || value === "true" ? 1 : value === false || value === "false" ? 0 : undefined;
		default:
			return rawText(value);
	}
}

/** Any value as plain text. */
export function rawText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

export function defaultFormat(value: unknown, type: ColumnType): string {
	if (value === null || value === undefined || value === "") return "";
	switch (type) {
		case "number": {
			const n = toNumber(value);
			return n === undefined ? rawText(value) : fmtNum(n);
		}
		case "date": {
			const ms = toEpochMs(value);
			return ms === undefined ? rawText(value) : fmtTime(ms);
		}
		case "boolean":
			return value === true || value === "true" ? "yes" : value === false || value === "false" ? "no" : rawText(value);
		default:
			return rawText(value);
	}
}

/** Sort comparator for two defined normalised values. Text compares naturally ("job-2" before "job-10"), enums by `order`. */
export function compareNormalised(a: number | string | undefined, b: number | string | undefined, order?: readonly string[]): number {
	if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
	if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
	if (order) {
		const rank = (v: number | string) => {
			const at = order.indexOf(String(v));
			return at < 0 ? order.length : at;
		};
		const diff = rank(a) - rank(b);
		if (diff) return diff;
	}
	return collator.compare(String(a), String(b));
}

export function inferType(values: readonly unknown[]): ColumnType {
	for (const v of values) {
		if (v === null || v === undefined || v === "") continue;
		if (typeof v === "number" || typeof v === "bigint") return "number";
		if (typeof v === "boolean") return "boolean";
		if (v instanceof Date) return "date";
		return "text";
	}
	return "text";
}

/** DuckDB's column type names mapped to a table column type (SQL results). */
export function typeFromSql(sqlType: string): ColumnType | undefined {
	const t = sqlType.toUpperCase();
	if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?\d*|FLOAT\d*|DOUBLE|REAL|DECIMAL.*|NUMERIC.*)$/.test(t)) return "number";
	if (t === "BOOLEAN" || t === "BOOL") return "boolean";
	if (/^(TIMESTAMP.*|DATE|DATETIME)$/.test(t)) return "date";
	return undefined;
}

export function resolveColumns<T>(specs: readonly DataColumn<T>[], rows: readonly T[]): Column<T>[] {
	return specs.map((spec) => {
		const type = spec.type ?? inferType(rows.slice(0, 200).map(spec.accessor));
		const filterKind: FilterKind | null =
			spec.filter === false ? null : spec.filter ? spec.filter : type === "enum" || type === "boolean" ? "set" : type === "number" ? "range" : type === "date" ? "since" : null;
		const raw = spec.accessor;
		const text = (row: T): string => {
			const value = raw(row);
			return spec.format ? spec.format(value, row) : defaultFormat(value, type);
		};
		return {
			spec,
			id: spec.id,
			header: spec.header,
			type,
			filterKind,
			align: spec.align ?? (type === "number" ? "right" : "left"),
			sortable: spec.sortable !== false,
			hideable: spec.hideable !== false,
			defaultHidden: spec.defaultHidden === true,
			searchable: spec.searchable !== false,
			raw,
			norm: (row: T) => normalise(raw(row), type),
			text,
			exportValue: (row: T) => {
				if (spec.exportValue) return spec.exportValue(row);
				const value = raw(row);
				if (type === "date") {
					const ms = toEpochMs(value);
					return ms === undefined ? value : new Date(ms).toISOString();
				}
				return value;
			},
		};
	});
}

// ---- view state ---------------------------------------------------------------------------------------------------

export interface SortSpec {
	id: string;
	desc: boolean;
}

export type ColumnFilter =
	| { kind: "set"; values: string[] }
	| { kind: "range"; min?: number; max?: number }
	| { kind: "text"; q: string }
	| { kind: "since"; within: SinceKey };

/** Everything the user changed about a table that is remembered. */
export interface TableView {
	sort: SortSpec[];
	search: string;
	filters: Record<string, ColumnFilter>;
	/** Overrides of the default column visibility: true = shown, false = hidden. */
	columns: Record<string, boolean>;
	/** Widths in px of columns the user resized. */
	sizes: Record<string, number>;
	pageSize: number;
}

export const PAGE_SIZES = [25, 50, 100, 250, 500] as const;
export const DEFAULT_PAGE_SIZE = 50;

export function defaultView(options: { sort?: readonly SortSpec[]; pageSize?: number } = {}): TableView {
	return { sort: (options.sort ?? []).map((s) => ({ ...s })), search: "", filters: {}, columns: {}, sizes: {}, pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE };
}

export function isDefaultView(view: TableView, defaults: TableView): boolean {
	return JSON.stringify(canonical(view)) === JSON.stringify(canonical(defaults));
}

function canonical(view: TableView) {
	const sortKeys = <V>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return { ...view, filters: sortKeys(view.filters), columns: sortKeys(view.columns), sizes: sortKeys(view.sizes) };
}

/** True while the search or any column filter narrows the rows. */
export function isFiltered(view: Pick<TableView, "search" | "filters">): boolean {
	return view.search.trim() !== "" || Object.keys(view.filters).length > 0;
}

export function isVisible<T>(col: Column<T>, view: Pick<TableView, "columns">): boolean {
	return view.columns[col.id] ?? !col.defaultHidden;
}

/**
 * The saved view as it applies to these columns: sort, filters, sizes and visibility for columns that don't exist (any
 * more) are dropped, filters of a kind the column no longer takes too, and at least one column stays visible.
 */
export function effectiveView<T>(view: TableView, cols: readonly Column<T>[]): TableView {
	const byId = new Map(cols.map((c) => [c.id, c]));
	const sort = view.sort.filter((s, at) => byId.get(s.id)?.sortable && view.sort.findIndex((o) => o.id === s.id) === at);
	const filters: Record<string, ColumnFilter> = {};
	for (const [id, f] of Object.entries(view.filters)) if (byId.get(id)?.filterKind === f.kind) filters[id] = f;
	const columns: Record<string, boolean> = {};
	for (const [id, on] of Object.entries(view.columns)) {
		const col = byId.get(id);
		if (col && col.hideable && on !== !col.defaultHidden) columns[id] = on;
	}
	const sizes: Record<string, number> = {};
	for (const [id, px] of Object.entries(view.sizes)) if (byId.has(id)) sizes[id] = px;
	const next: TableView = { ...view, sort, filters, columns, sizes };
	if (cols.length && !cols.some((c) => isVisible(c, next))) {
		const first = cols[0] as Column<T>;
		next.columns = { ...next.columns, [first.id]: true };
	}
	return next;
}

// ---- filtering ----------------------------------------------------------------------------------------------------

/** The checklist key of a value ("" = empty). */
export function setKey(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return rawText(value);
}

export function searchTerms(search: string): string[] {
	return search.toLowerCase().split(/\s+/).filter(Boolean);
}

function haystack<T>(col: Column<T>, row: T): string {
	const shown = col.text(row);
	const raw = rawText(col.raw(row));
	const extra = col.spec.searchText?.(row) ?? "";
	return `${shown}\n${raw === shown ? "" : raw}\n${extra}`.toLowerCase();
}

/** The lower-cased text of each row over the columns the search box looks at (the visible, searchable ones). */
export function buildSearchIndex<T>(rows: readonly T[], searchCols: readonly Column<T>[]): string[] {
	return rows.map((row) => searchCols.map((c) => haystack(c, row)).join("\n"));
}

export function matchesFilter<T>(col: Column<T>, row: T, filter: ColumnFilter, now: number): boolean {
	switch (filter.kind) {
		case "set":
			return filter.values.includes(setKey(col.raw(row)));
		case "range": {
			const n = col.norm(row);
			if (typeof n !== "number") return false;
			return (filter.min === undefined || n >= filter.min) && (filter.max === undefined || n <= filter.max);
		}
		case "text":
			return haystack(col, row).includes(filter.q.toLowerCase());
		case "since": {
			const ms = col.norm(row);
			return typeof ms === "number" && ms >= now - SINCE_MS[filter.within];
		}
	}
}

/** The rows that pass the search (every word must appear somewhere in the visible columns) and every column filter. */
export function filterEntries<T>(
	rows: readonly T[],
	cols: readonly Column<T>[],
	view: Pick<TableView, "search" | "filters">,
	index: readonly string[],
	now = Date.now(),
): Entry<T>[] {
	const terms = searchTerms(view.search);
	const active = Object.entries(view.filters).flatMap(([id, f]) => {
		const col = cols.find((c) => c.id === id);
		return col ? [{ col, f }] : [];
	});
	const out: Entry<T>[] = [];
	rows.forEach((row, i) => {
		if (terms.length) {
			const text = index[i] ?? "";
			if (!terms.every((t) => text.includes(t))) return;
		}
		for (const { col, f } of active) if (!matchesFilter(col, row, f, now)) return;
		out.push({ row, i });
	});
	return out;
}

export interface FilterOption {
	value: string;
	label: string;
	count: number;
}

/** The checklist of a "set" filter: every value in the data (and the declared options) with how many rows have it. */
export function filterOptions<T>(col: Column<T>, rows: readonly T[]): FilterOption[] {
	const found = new Map<string, FilterOption>();
	for (const row of rows) {
		const value = setKey(col.raw(row));
		const seen = found.get(value);
		if (seen) seen.count++;
		else found.set(value, { value, label: value === "" ? "(empty)" : col.text(row) || value, count: 1 });
	}
	for (const declared of col.spec.options ?? []) if (!found.has(declared)) found.set(declared, { value: declared, label: declared, count: 0 });
	const order = col.spec.order;
	return [...found.values()].sort((a, b) => {
		if (a.value === "" || b.value === "") return a.value === "" ? 1 : -1;
		return compareNormalised(a.value, b.value, order);
	});
}

/** Smallest and largest number in a column (for the range filter's placeholders). */
export function numberBounds<T>(col: Column<T>, rows: readonly T[]): { min: number; max: number } | null {
	let min = Infinity;
	let max = -Infinity;
	for (const row of rows) {
		const n = col.norm(row);
		if (typeof n === "number") {
			if (n < min) min = n;
			if (n > max) max = n;
		}
	}
	return min <= max ? { min, max } : null;
}

/** "ok, degraded", "5 to 20", "at least 5", "contains abc", "last 24 hours" for the chip of an active filter. */
export function describeFilter<T>(col: Column<T> | undefined, filter: ColumnFilter): string {
	switch (filter.kind) {
		case "set": {
			const labels = filter.values.map((v) => (v === "" ? "(empty)" : col?.type === "boolean" ? (v === "true" ? "yes" : "no") : v));
			return labels.length > 3 ? `${labels.slice(0, 3).join(", ")} +${labels.length - 3}` : labels.join(", ");
		}
		case "range":
			return filter.min !== undefined && filter.max !== undefined ? `${fmtNum(filter.min)} to ${fmtNum(filter.max)}` : filter.min !== undefined ? `at least ${fmtNum(filter.min)}` : `at most ${fmtNum(filter.max)}`;
		case "text":
			return `contains "${filter.q}"`;
		case "since":
			return SINCE_LABELS[filter.within].toLowerCase();
	}
}

// ---- CSV ----------------------------------------------------------------------------------------------------------

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * One CSV field. Quoted when it holds a comma, quote or line break. Text that starts with = + - @ (or a tab / return)
 * gets a leading ' so a spreadsheet doesn't run it as a formula: error messages and event names can come from clients.
 */
export function csvField(value: unknown): string {
	if (value === null || value === undefined) return "";
	let text = typeof value === "string" ? value : rawText(value);
	if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The CSV of rows over these columns (header line first, CRLF line ends). */
export function toCsv<T>(cols: readonly Column<T>[], rows: readonly T[]): string {
	const lines = [cols.map((c) => csvField(c.header)).join(",")];
	for (const row of rows) lines.push(cols.map((c) => csvField(c.exportValue(row))).join(","));
	return lines.join("\r\n");
}

/** One value as the text "Copy cell" puts on the clipboard. */
export function copyValue<T>(col: Column<T>, row: T): string {
	const value = col.exportValue(row);
	return value === null || value === undefined ? "" : rawText(value);
}

// ---- URL and storage ----------------------------------------------------------------------------------------------

const MAX_PARAM = 1000;
const MAX_ITEMS = 200;

/** Ids inside a comma list: percent-encoded, and a leading "-" or "+" too (those mark direction / visibility). */
const encId = (id: string) => encodeURIComponent(id).replace(/^[-+]/, (c) => (c === "-" ? "%2D" : "%2B"));
const decId = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

const FILTER_PREFIX = ".f.";

/** The URL query for a view, with the table id as prefix (`fleet-servers.sort=-players,job`); defaults are left out. */
export function viewToParams(id: string, view: TableView, defaults: TableView): Record<string, string> {
	const out: Record<string, string> = {};
	if (JSON.stringify(view.sort) !== JSON.stringify(defaults.sort)) out[`${id}.sort`] = view.sort.length ? view.sort.map((s) => `${s.desc ? "-" : ""}${encId(s.id)}`).join(",") : "none";
	if (view.search.trim()) out[`${id}.q`] = view.search;
	for (const [col, f] of Object.entries(view.filters)) out[`${id}${FILTER_PREFIX}${col}`] = encodeFilter(f);
	const cols = Object.entries(view.columns).map(([col, on]) => `${on ? "+" : "-"}${encId(col)}`);
	if (cols.length) out[`${id}.cols`] = cols.join(",");
	if (view.pageSize !== defaults.pageSize) out[`${id}.size`] = String(view.pageSize);
	return out;
}

function encodeFilter(f: ColumnFilter): string {
	switch (f.kind) {
		case "set":
			return `set:${f.values.map(encodeURIComponent).join(",")}`;
		case "range":
			return `range:${f.min ?? ""}..${f.max ?? ""}`;
		case "text":
			return `text:${f.q}`;
		case "since":
			return `since:${f.within}`;
	}
}

function decodeFilter(text: string): ColumnFilter | undefined {
	const colon = text.indexOf(":");
	if (colon < 0 || text.length > MAX_PARAM) return undefined;
	const kind = text.slice(0, colon);
	const body = text.slice(colon + 1);
	if (kind === "set") {
		const values = body === "" ? [""] : body.split(",").slice(0, MAX_ITEMS).map(decId);
		return { kind: "set", values };
	}
	if (kind === "range") {
		const [lo = "", hi = ""] = body.split("..");
		const min = lo === "" ? undefined : Number(lo);
		const max = hi === "" ? undefined : Number(hi);
		if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min === undefined && max === undefined)) return undefined;
		return { kind: "range", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
	}
	if (kind === "text") return body ? { kind: "text", q: body } : undefined;
	if (kind === "since") return body in SINCE_MS ? { kind: "since", within: body as SinceKey } : undefined;
	return undefined;
}

/** Does the URL carry any state for this table? (Then it wins over the saved view: someone shared a link.) */
export function hasViewParams(id: string, params: URLSearchParams): boolean {
	for (const key of params.keys()) if (key.startsWith(`${id}.`) && (key === `${id}.sort` || key === `${id}.q` || key === `${id}.cols` || key === `${id}.size` || key.startsWith(`${id}${FILTER_PREFIX}`))) return true;
	return false;
}

/** The view a URL describes (fields it doesn't mention keep the defaults). */
export function paramsToView(id: string, params: URLSearchParams, defaults: TableView): TableView {
	const view: TableView = { ...defaults, sort: defaults.sort.map((s) => ({ ...s })), filters: {}, columns: {}, sizes: {} };
	const sort = params.get(`${id}.sort`);
	if (sort !== null) {
		view.sort =
			sort === "none"
				? []
				: sort
						.slice(0, MAX_PARAM)
						.split(",")
						.slice(0, 8)
						.filter(Boolean)
						.map((item) => (item.startsWith("-") ? { id: decId(item.slice(1)), desc: true } : { id: decId(item), desc: false }));
	}
	view.search = (params.get(`${id}.q`) ?? "").slice(0, 200);
	for (const [key, value] of params.entries()) {
		if (!key.startsWith(`${id}${FILTER_PREFIX}`)) continue;
		const f = decodeFilter(value);
		if (f) view.filters[key.slice(id.length + FILTER_PREFIX.length)] = f;
	}
	const cols = params.get(`${id}.cols`);
	if (cols) for (const item of cols.slice(0, MAX_PARAM).split(",").slice(0, MAX_ITEMS)) if (item.startsWith("-") || item.startsWith("+")) view.columns[decId(item.slice(1))] = item.startsWith("+");
	const size = Number.parseInt(params.get(`${id}.size`) ?? "", 10);
	if (size >= 1 && size <= 1000) view.pageSize = size;
	return view;
}

/** A copy of `params` without this table's keys. */
export function clearViewParams(id: string, params: URLSearchParams): URLSearchParams {
	const next = new URLSearchParams();
	for (const [key, value] of params.entries()) if (!(key.startsWith(`${id}.`) && (key === `${id}.sort` || key === `${id}.q` || key === `${id}.cols` || key === `${id}.size` || key.startsWith(`${id}${FILTER_PREFIX}`)))) next.append(key, value);
	return next;
}

export const STORAGE_PREFIX = "tt.table.v1.";

export function encodeStored(view: TableView): string {
	return JSON.stringify(view);
}

/** The saved view from localStorage text; anything malformed is dropped field by field. Null when nothing usable. */
export function decodeStored(text: string | null | undefined, defaults: TableView): TableView | null {
	if (!text || text.length > 100_000) return null;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const o = data as Record<string, unknown>;
	const view: TableView = { ...defaults, sort: defaults.sort.map((s) => ({ ...s })), filters: {}, columns: {}, sizes: {} };
	if (Array.isArray(o.sort)) view.sort = o.sort.flatMap((s) => (s && typeof s === "object" && typeof (s as SortSpec).id === "string" ? [{ id: (s as SortSpec).id, desc: (s as SortSpec).desc === true }] : [])).slice(0, 8);
	if (typeof o.search === "string") view.search = o.search.slice(0, 200);
	if (o.filters && typeof o.filters === "object") {
		for (const [id, f] of Object.entries(o.filters as Record<string, unknown>)) {
			const parsed = parseFilter(f);
			if (parsed) view.filters[id] = parsed;
		}
	}
	if (o.columns && typeof o.columns === "object") for (const [id, on] of Object.entries(o.columns as Record<string, unknown>)) if (typeof on === "boolean") view.columns[id] = on;
	if (o.sizes && typeof o.sizes === "object") for (const [id, px] of Object.entries(o.sizes as Record<string, unknown>)) if (typeof px === "number" && px >= 24 && px <= 2000) view.sizes[id] = Math.round(px);
	if (typeof o.pageSize === "number" && o.pageSize >= 1 && o.pageSize <= 1000) view.pageSize = Math.floor(o.pageSize);
	return view;
}

function parseFilter(f: unknown): ColumnFilter | undefined {
	if (!f || typeof f !== "object") return undefined;
	const o = f as Record<string, unknown>;
	if (o.kind === "set" && Array.isArray(o.values)) {
		const values = o.values.filter((v): v is string => typeof v === "string").slice(0, MAX_ITEMS);
		return values.length ? { kind: "set", values } : undefined;
	}
	if (o.kind === "range") {
		const min = typeof o.min === "number" && Number.isFinite(o.min) ? o.min : undefined;
		const max = typeof o.max === "number" && Number.isFinite(o.max) ? o.max : undefined;
		return min === undefined && max === undefined ? undefined : { kind: "range", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
	}
	if (o.kind === "text" && typeof o.q === "string" && o.q) return { kind: "text", q: o.q.slice(0, 200) };
	if (o.kind === "since" && typeof o.within === "string" && o.within in SINCE_MS) return { kind: "since", within: o.within as SinceKey };
	return undefined;
}

export function readStored(id: string, defaults: TableView): TableView | null {
	try {
		return decodeStored(globalThis.localStorage?.getItem(STORAGE_PREFIX + id), defaults);
	} catch {
		return null;
	}
}

/** Saves the view, or forgets it when it is the default. Never throws (private windows, blocked storage, full quota). */
export function writeStored(id: string, view: TableView, defaults: TableView): void {
	try {
		const storage = globalThis.localStorage;
		if (!storage) return;
		if (isDefaultView(view, defaults)) storage.removeItem(STORAGE_PREFIX + id);
		else storage.setItem(STORAGE_PREFIX + id, encodeStored(view));
	} catch {
		// remembered per session only
	}
}
