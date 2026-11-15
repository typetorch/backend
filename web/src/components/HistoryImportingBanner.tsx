/**
 * Above the analytics pages while a move from another server still imports event history (GET /v1/admin/migrate): the
 * charts are missing those days, so a half-empty chart is not a traffic drop. Admins only (a read-only session can't
 * read the status, so it doesn't ask); nothing on an error or an older server.
 */
import { History } from "lucide-react";
import { useMigrateStatus } from "@/components/MigrationCard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isReadOnly, useAuth } from "@/lib/auth";
import { historyBannerText } from "@/lib/migrate";

export function HistoryImportingBanner() {
	const readOnly = isReadOnly(useAuth());
	const q = useMigrateStatus({ enabled: !readOnly });
	const text = readOnly || q.isError ? null : historyBannerText(q.data);
	if (!text) return null;
	return (
		<Alert data-history-importing>
			<History />
			<AlertTitle>{text}</AlertTitle>
			<AlertDescription>This backend is moving its history in from another server. Days not imported yet are missing from the charts: a half-empty chart is not a traffic drop. Settings shows the progress.</AlertDescription>
		</Alert>
	);
}
