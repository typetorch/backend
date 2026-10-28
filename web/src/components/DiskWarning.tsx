/**
 * The data disk's free space (server/disk.ts on the backend): a line when it is fine, an alert when it is under the
 * warning threshold (the backend raises a `disk_low` fleet alert at the same time). Owners only, like the pages it is on.
 */
import { HardDrive, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fmtBytes, fmtPct } from "@/lib/format";
import type { DiskStatus } from "@/lib/types";

export function diskWarningText(d: DiskStatus): string {
	const threshold = d.level === "critical" ? d.criticalFreePercent : d.warnFreePercent;
	return `${fmtBytes(d.freeBytes)} of ${fmtBytes(d.totalBytes)} free (${fmtPct(d.freePercent / 100)}, under ${threshold}%). Make a backup, then free space: shorter retention on the Settings page, or a bigger volume.`;
}

export function DiskWarning({ disk, quiet = false }: { disk: DiskStatus | null | undefined; quiet?: boolean }) {
	if (!disk) return null;
	if (disk.level === "ok") {
		if (quiet) return null;
		return (
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<HardDrive className="size-3.5" aria-hidden />
				Disk: {fmtBytes(disk.freeBytes)} of {fmtBytes(disk.totalBytes)} free ({fmtPct(disk.freePercent / 100)}).
			</p>
		);
	}
	return (
		<Alert variant="destructive" role="alert">
			<TriangleAlert />
			<AlertTitle>{disk.level === "critical" ? "The data disk is almost full" : "The data disk is filling up"}</AlertTitle>
			<AlertDescription>{diskWarningText(disk)}</AlertDescription>
		</Alert>
	);
}
