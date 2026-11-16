/**
 * The Settings page's "Mobile app sessions": the TypeTorch app's tokens on this backend (device, who, role, made, last
 * used, expires) with a Revoke button each, and "Revoke all" (after a confirmation) that signs every phone out: rotating
 * the admin token ends only the tokens made with it, not the Roblox users'. The backend never sends a token back: only
 * its id and what it is for. Owners see every token (the page is theirs); revoking one signs that phone out at its next
 * request. The table mounts once the list is there, and again when it empties or fills (DataTable's hooks don't survive
 * a switch between rows and its empty state).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Trash2 } from "lucide-react";
import { useId, useState } from "react";
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

/** "Revoke all"'s confirmation: what it does, Cancel and the destructive button. */
function ConfirmRevokeAll({ count, busy, onConfirm, onCancel }: { count: number; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
	const title = useId();
	const text = useId();
	return (
		<div role="alertdialog" aria-labelledby={title} aria-describedby={text} className="space-y-3 rounded-lg border border-destructive/50 p-3">
			<p id={title} className="text-sm font-medium">
				Revoke all {count} mobile app {count === 1 ? "session" : "sessions"}?
			</p>
			<p id={text} className="text-sm text-muted-foreground">
				Every phone signed in to this backend with the TypeTorch app signs out at once, yours included, and has to sign in again. Rotating the admin token doesn't do this for Roblox sign-ins.
			</p>
			<div className="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
				<Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
					<LogOut />
					{busy ? "Revoking" : "Revoke all"}
				</Button>
			</div>
		</div>
	);
}

export function MobileSessionsCard() {
	const client = useQueryClient();
	const list = useQuery({ queryKey: MOBILE_TOKENS_KEY, queryFn: ({ signal }) => api.mobileTokens(signal), staleTime: 0 });
	const revoke = useMutation({
		mutationFn: (id: string) => api.revokeMobileToken(id),
		onSuccess: (next) => client.setQueryData<MobileTokenList>(MOBILE_TOKENS_KEY, { tokens: next.tokens, lifetimeDays: next.lifetimeDays }),
	});
	const [confirmAll, setConfirmAll] = useState(false);
	const revokeAll = useMutation({
		mutationFn: () => api.revokeAllMobileTokens(),
		onSuccess: (next) => {
			setConfirmAll(false);
			client.setQueryData<MobileTokenList>(MOBILE_TOKENS_KEY, { tokens: next.tokens, lifetimeDays: next.lifetimeDays });
		},
	});
	const days = list.data?.lifetimeDays;
	const count = list.data?.tokens.length ?? 0;
	const busy = revoke.isPending || revokeAll.isPending;
	return (
		<Section
			title="Mobile app sessions"
			description={`Phones signed in to this backend with the TypeTorch app. A session lasts ${days ?? 60} days and renews itself while the app is used; revoking one signs that phone out at once.`}
			actions={
				count > 0 && !confirmAll ? (
					<Button type="button" variant="outline" size="sm" onClick={() => setConfirmAll(true)} disabled={busy}>
						<LogOut />
						Revoke all
					</Button>
				) : null
			}
		>
			<div className="space-y-2">
				{confirmAll && count > 0 ? <ConfirmRevokeAll count={count} busy={revokeAll.isPending} onConfirm={() => revokeAll.mutate()} onCancel={() => setConfirmAll(false)} /> : null}
				{revokeAll.isSuccess ? (
					<p role="status" className="text-sm text-muted-foreground">
						Revoked {revokeAll.data.revoked} mobile app {revokeAll.data.revoked === 1 ? "session" : "sessions"}.
					</p>
				) : null}
				{revokeAll.isError ? <p className="text-sm text-destructive">{revokeError(revokeAll.error)}</p> : null}
				{list.isError ? <p className="text-sm text-destructive">Could not load the mobile app sessions.</p> : null}
				{/* Remounted when the list empties or fills (revoking the last one, Revoke all): its hooks change with that. */}
				{list.data ? (
					<DataTable
						key={count > 0 ? "rows" : "empty"}
						id="mobile-tokens"
						label="Mobile app sessions"
						columns={columns((t) => revoke.mutate(t.id), busy)}
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
