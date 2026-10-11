/**
 * Game pass and developer product details for the product tooltips. Every id shown in the same render is collected and
 * asked in one GET /v1/roblox/products (50 ids a request), and each answer is kept by React Query for 30 minutes (the
 * backend caches an hour). A failed request degrades to "unavailable" items: the id stays, without a name.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { RobloxProductInfo } from "@/lib/types";

export type ProductType = RobloxProductInfo["type"];

const BATCH = 50;

/** A purchase kind (the framework's `kind`: "gamepass", "product", ...) as a product type; undefined for others. */
export function productTypeOf(kind: string | null | undefined): ProductType | undefined {
	const k = (kind ?? "").toLowerCase().replace(/[\s_-]/g, "");
	if (k === "gamepass" || k === "pass") return "gamepass";
	if (k === "product" || k === "devproduct" || k === "developerproduct") return "product";
	return undefined;
}

/** A product id from a table cell or event prop: a positive safe integer (number or digits), else undefined. */
export function parseProductId(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d{0,18}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export const productTypeLabel = (type: ProductType) => (type === "gamepass" ? "Game pass" : "Developer product");

type Fetcher = (ids: { gamepass: number[]; product: number[] }) => Promise<RobloxProductInfo[]>;
type Waiter = { type: ProductType; id: number; resolve(info: RobloxProductInfo): void };

/** Collects the ids asked in one tick and asks them in batches of 50. */
export function createProductLoader(fetcher: Fetcher) {
	let pending: Waiter[] = [];
	let scheduled = false;
	const flush = async () => {
		scheduled = false;
		const waiters = pending;
		pending = [];
		const keys = [...new Set(waiters.map((w) => `${w.type}:${w.id}`))];
		for (let i = 0; i < keys.length; i += BATCH) {
			const chunk = keys.slice(i, i + BATCH);
			const ids = { gamepass: [] as number[], product: [] as number[] };
			for (const k of chunk) {
				const [type, id] = k.split(":") as [ProductType, string];
				ids[type].push(Number(id));
			}
			let items: RobloxProductInfo[] = [];
			try {
				items = await fetcher(ids);
			} catch {
				// Degrade to the bare id below.
			}
			const found = new Map(items.map((it) => [`${it.type}:${it.id}`, it]));
			for (const w of waiters) {
				const key = `${w.type}:${w.id}`;
				if (!chunk.includes(key)) continue;
				w.resolve(found.get(key) ?? { type: w.type, id: w.id, status: "unavailable", name: null, price: null, forSale: null, icon: null });
			}
		}
	};
	return (type: ProductType, id: number): Promise<RobloxProductInfo> =>
		new Promise((resolve) => {
			pending.push({ type, id, resolve });
			if (!scheduled) {
				scheduled = true;
				setTimeout(() => void flush(), 0);
			}
		});
}

const loadProduct = createProductLoader((ids) => api.robloxProducts(ids));

/** One product's details; undefined while loading or without a type and id. */
export function useProductInfo(type: ProductType | undefined, id: number | undefined): { info: RobloxProductInfo | undefined; loading: boolean } {
	const q = useQuery({
		queryKey: ["roblox-product", type, id],
		queryFn: () => loadProduct(type as ProductType, id as number),
		enabled: type !== undefined && id !== undefined,
		staleTime: 30 * 60_000,
		gcTime: 60 * 60_000,
		retry: false,
	});
	return { info: q.data, loading: q.isLoading };
}

/** Only an https icon on Roblox's CDN (what the CSP allows). */
export function productIconUrl(icon: string | null | undefined): string | undefined {
	if (!icon) return undefined;
	try {
		const u = new URL(icon);
		return u.protocol === "https:" && !u.username && !u.password && u.hostname.endsWith(".rbxcdn.com") ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}
