/**
 * On the Overview for owners: a note while the backend refused ingest as busy (503) in the last minute
 * (GET /v1/admin/stats?window=1m, `ingest.lastBusyAt` against the server's `now`), polled every 30 s. Game servers keep
 * the refused batches and send them again, so nothing is lost; the Backend stats page has the counts.
 */
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api } from "@/lib/api";
import { recentlyBusy } from "@/lib/migrate";

export const BUSY_STATS_KEY = ["backend-stats-busy"] as const;

export function IngestBusyNote() {
	const q = useQuery({ queryKey: BUSY_STATS_KEY, queryFn: ({ signal }) => api.backendStats("1m", signal), refetchInterval: 30_000, staleTime: 15_000, retry: false });
	if (!q.data || !recentlyBusy(q.data.ingest, q.data.now)) return null;
	return (
		<Alert role="status" data-ingest-busy>
			<Gauge />
			<AlertDescription>
				<p>
					The backend answered busy (503) to game servers in the last minute: they keep the batches and retry; see{" "}
					<Link to="/backend" className="underline underline-offset-2">
						Backend stats
					</Link>
					.
				</p>
			</AlertDescription>
		</Alert>
	);
}
