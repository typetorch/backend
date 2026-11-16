/**
 * The Settings page's "Mobile app sessions": the TypeTorch app's tokens on this backend (device, who, role, made, last
 * used, expires) with a Revoke button each. The backend never sends a token back: only its id and what it is for.
 * Owners see every token (the page is theirs); revoking one signs that phone out at its next request. The table mounts
 * once the list is there (DataTable's hooks don't survive a switch from `loading` to its empty state).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { EmptyState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import type { MobileTokenList, MobileTokenView } from "@/lib/types";

export const MOBILE_TOKENS_KEY = ["mobile-tokens"] as const;

/** Who a token belongs to, for the list. */
export function tokenUser(t: MobileTokenView): string {
	if (t.user.kind === "token") return "Admin token";
	return `${t.user.name} (${t.user.userId})${t.user.login === "typetorch.dev" ? " via typetorch.dev" : ""}`;
}

/** "in 12 d" / "in 5 h" until an instant (the expiry). */
export function fmtIn(iso: string, now = Date.now()): string {
	const s = Math.round((new Date(iso).getTime() - now) / 1000);
	if (Number.isNaN(s)) return "–";
	if (s <= 0) return "expired";
	if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))} min`;
	if (s < 86_400) return `in ${Math.floor(s / 3600)} h`;
	return `in ${Math.floor(s / 86_400)} d`;
}

function columns(onRevoke: (t: MobileTokenView) => void, busy: boolean): DataColumn<MobileTokenView>[] {
	return [
		{
			id: "device",
			header: "Device",
			accessor: (t) => t.device,
			cell: (t) => (
				<span className="flex items-center gap-2">
					<span className="max-w-48 truncate">{t.device}</span>
					{t.current ? <Badge variant="secondary">This app</Badge> : null}
				</span>
			),
		},
		{ id: "user", header: "User", accessor: tokenUser, className: "text-xs" },
		{ id: "role", header: "Role", type: "enum", accessor: (t) => t.role, cell: (t) => <Badge variant={t.role === "admin" ? "default" : "outline"}>{t.role === "admin" ? "admin" : "read-only"}</Badge> },
		{ id: "created", header: "Created", type: "date", accessor: (t) => t.createdAt, cell: (t) => <span title={fmtTime(t.createdAt)}>{fmtAgo(t.createdAt)}</span>, format: (_v, t) => fmtTime(t.createdAt), className: "text-xs" },
		{
			id: "used",
			header: "Last used",
			type: "date",
			accessor: (t) => t.lastUsedAt ?? "",
			cell: (t) => (t.lastUsedAt ? <span title={fmtTime(t.lastUsedAt)}>{fmtAgo(t.lastUsedAt)}</span> : <span className="text-muted-foreground">never</span>),
			format: (_v, t) => fmtTime(t.lastUsedAt),
			className: "text-xs",
		},
		{ id: "expires", header: "Expires", type: "date", accessor: (t) => t.expiresAt, cell: (t) => <span title={fmtTime(t.expiresAt)}>{fmtIn(t.expiresAt)}</span>, format: (_v, t) => fmtTime(t.expiresAt), className: "text-xs" },
		{
			id: "revoke",
			header: "",
			accessor: (t) => t.id,
			cell: (t) => (
				<Button type="button" variant="outline" size="sm" onClick={() => onRevoke(t)} disabled={busy} aria-label={`Revoke ${t.device}`}>
					<Trash2 />
					Revoke
				</Button>
			),
		},
	];
}

function revokeError(error: unknown): string {
	if (error instanceof ApiError) return error.status === 404 ? "That token is already gone." : error.message;
	return error instanceof Error ? error.message : String(error);
}

export function MobileSessionsCard() {
	const client = useQueryClient();
	const list = useQuery({ queryKey: MOBILE_TOKENS_KEY, queryFn: ({ signal }) => api.mobileTokens(signal), staleTime: 0 });
	const revoke = useMutation({
		mutationFn: (id: string) => api.revokeMobileToken(id),
		onSuccess: (next) => client.setQueryData<MobileTokenList>(MOBILE_TOKENS_KEY, { tokens: next.tokens, lifetimeDays: next.lifetimeDays }),
	});
	const days = list.data?.lifetimeDays;
	return (
		<Section
			title="Mobile app sessions"
			description={`Phones signed in to this backend with the TypeTorch app. A session lasts ${days ?? 60} days and renews itself while the app is used; revoking one signs that phone out at once.`}
		>
			<div className="space-y-2">
				{list.isError ? <p className="text-sm text-destructive">Could not load the mobile app sessions.</p> : null}
				{list.data ? (
					<DataTable
						id="mobile-tokens"
						label="Mobile app sessions"
						columns={columns((t) => revoke.mutate(t.id), revoke.isPending)}
						data={list.data.tokens}
						rowId={(t) => t.id}
						defaultSort={[{ id: "created", desc: true }]}
						urlSync={false}
						rowMenu={false}
						empty={<EmptyState>No phone is signed in. The TypeTorch app signs in with Roblox in the phone's browser, or with the admin token once.</EmptyState>}
					/>
				) : list.isPending ? (
					<p className="text-sm text-muted-foreground">Loading</p>
				) : null}
				{revoke.isError ? <p className="text-sm text-destructive">{revokeError(revoke.error)}</p> : null}
			</div>
		</Section>
	);
}
