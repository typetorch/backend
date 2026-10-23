/**
 * The Fleet page's Restarts card: the universe's server restarts as Roblox lists them (Open Cloud server management,
 * through the backend: GET /v1/roblox/restarts), the latest start first. Roblox documents only part of a restart's
 * status, so the state and times are what the backend could pick out and every other field shows as text.
 */
import { useQuery } from "@tanstack/react-query";
import { EmptyState, QueryState } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import type { RobloxRestart } from "@/lib/types";
import { fieldsText } from "@/pages/server/RobloxLogs";
import { MEMORY_ONLY, Tone } from "@/pages/server/shared";

export const RESTARTS_OFF_TEXT = "Roblox's server restarts need OPENCLOUD_API_KEY (with universe:read on the game) and TYPETORCH_UNIVERSE_ID on the backend.";

/** Running restarts stand out; finished ones are grey. Roblox's spelling varies, so this reads the word loosely. */
export function restartTone(state: string | null): string {
	const s = (state ?? "").toLowerCase().replace(/[_\s-]/g, "");
	if (s.includes("fail") || s.includes("error") || s.includes("cancel")) return "bg-[var(--status-critical)]";
	if (s.includes("progress") || s.includes("running") || s.includes("pending") || s.includes("delay") || s.includes("stopping") || s.includes("restarting")) return "bg-[var(--status-warning)]";
	if (s.includes("complete") || s.includes("done") || s.includes("success") || s.includes("finish")) return "bg-[var(--status-good)]";
	return "bg-muted-foreground";
}

const COLUMNS: DataColumn<RobloxRestart>[] = [
	{ id: "startedAt", header: "Started (UTC)", type: "date", accessor: (r) => r.startedAt, cell: (r) => (r.startedAt ? `${fmtTime(r.startedAt)} (${fmtAgo(r.startedAt)})` : "–"), className: "font-mono text-xs tabular-nums whitespace-nowrap" },
	{ id: "state", header: "State", type: "enum", accessor: (r) => r.state ?? "unknown", cell: (r) => <Tone tone={restartTone(r.state)}>{r.state ?? "unknown"}</Tone> },
	{ id: "endedAt", header: "Ended (UTC)", type: "date", accessor: (r) => r.endedAt, cell: (r) => (r.endedAt ? fmtTime(r.endedAt) : "–"), className: "font-mono text-xs tabular-nums whitespace-nowrap" },
	{ id: "fields", header: "Details", accessor: (r) => fieldsText(r.fields) || null, className: "max-w-[40rem] font-mono text-xs break-words" },
	{ id: "id", header: "Restart id", accessor: (r) => r.id, defaultHidden: true, className: "font-mono text-xs" },
];

export function RobloxRestarts() {
	const restarts = useQuery({
		queryKey: ["roblox", "restarts"],
		queryFn: ({ signal }) => api.robloxRestarts(signal),
		refetchInterval: 60_000,
		retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
	});
	if (restarts.error instanceof ApiError && restarts.error.status === 409) return <EmptyState>{RESTARTS_OFF_TEXT}</EmptyState>;
	return (
		<QueryState query={restarts}>
			{(data) => (
				<DataTable
					id="roblox-restarts"
					label="Roblox server restarts"
					columns={COLUMNS}
					data={data}
					rowId={(r) => r.id}
					defaultSort={[{ id: "startedAt", desc: true }]}
					maxHeight="20rem"
					empty={<EmptyState>Roblox lists no server restarts for this game.</EmptyState>}
					{...MEMORY_ONLY}
				/>
			)}
		</QueryState>
	);
}
