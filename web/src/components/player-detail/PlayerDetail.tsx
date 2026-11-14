/**
 * The player detail: one container under the Players list. The profile card on top (Roblox headshot and names from the
 * backend, UserId, pid, the range's numbers), its progress in each funnel, the view buttons (Spending, Playtime,
 * Sessions, Timeline, Errors), the chosen view below. The view and Chart / Table live in the URL (`view`, `show`), next to the page's pid and filters.
 */
import { useQuery } from "@tanstack/react-query";
import { Bell, Bug, CalendarDays, Clock, Coins, History, MessageSquareText, type LucideIcon } from "lucide-react";
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { QueryState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { FeedbackList } from "@/pages/feedback/shared";
import { PlayerView as NotifyPlayerView } from "@/pages/notifications/PlayerPanel";
import { describeRange } from "@/lib/filters";
import { useAnalytics, useFilters } from "@/lib/hooks";
import { ErrorsView } from "./ErrorsView";
import { PlayerFunnels } from "./PlayerFunnels";
import { ProfileCard } from "./ProfileCard";
import type { Show } from "./SeriesView";
import { PlaytimeView, SessionsView, SpendingView } from "./StatViews";
import { TimelineView } from "./TimelineView";

export const PLAYER_VIEWS = ["spending", "playtime", "sessions", "timeline", "errors", "feedback", "notifications"] as const;
export type PlayerView = (typeof PLAYER_VIEWS)[number];

const FEEDBACK_LIMIT = 100;

const VIEW_BUTTONS: { id: PlayerView; label: string; icon: LucideIcon }[] = [
	{ id: "spending", label: "Spending", icon: Coins },
	{ id: "playtime", label: "Playtime", icon: Clock },
	{ id: "sessions", label: "Sessions", icon: CalendarDays },
	{ id: "timeline", label: "Timeline", icon: History },
	{ id: "errors", label: "Errors", icon: Bug },
	{ id: "feedback", label: "Feedback", icon: MessageSquareText },
	{ id: "notifications", label: "Notifications", icon: Bell },
];

/** The player's notifications (owners: GET /v1/notify/user by pid): consent with dates, every send with its opens and plays, the intents. */
function NotificationsView({ pid }: { pid: string }) {
	const q = useQuery({ queryKey: ["notify-user", { pid }], queryFn: ({ signal }) => api.notifyUser({ pid }, signal), retry: false, refetchInterval: 30_000 });
	return <QueryState query={q} loadingRows={3}>{(view) => <NotifyPlayerView view={view} onPick={() => undefined} />}</QueryState>;
}

/** The player's feedback (plans/32) in the range: `feedback-list` with the pid, newest first. */
function FeedbackView({ pid }: { pid: string }) {
	const q = useAnalytics("feedback-list", { pid, limit: FEEDBACK_LIMIT });
	return (
		<QueryState query={q} loadingRows={3} isEmpty={(d) => d.rows.length === 0} empty="No feedback from this player in this range.">
			{(d) => (
				<div className="space-y-2">
					<FeedbackList rows={d.rows} showPlayer={false} label="This player's feedback" />
					{d.more ? <p className="text-xs text-muted-foreground">The newest {FEEDBACK_LIMIT} of {d.total}; the Feedback page has the rest.</p> : null}
				</div>
			)}
		</QueryState>
	);
}

const isView = (value: string | null): value is PlayerView => (PLAYER_VIEWS as readonly (string | null)[]).includes(value);

export function PlayerDetail({ pid }: { pid: string }) {
	const [params, setParams] = useSearchParams();
	const view: PlayerView = isView(params.get("view")) ? (params.get("view") as PlayerView) : "spending";
	const show: Show = params.get("show") === "table" ? "table" : "chart";
	// One navigation for several keys (two setters in a row would each start from the same URL).
	const patch = useCallback(
		(changes: Record<string, string | null>) =>
			setParams((current) => {
				const copy = new URLSearchParams(current);
				for (const [key, value] of Object.entries(changes)) {
					if (value) copy.set(key, value);
					else copy.delete(key);
				}
				return copy;
			}),
		[setParams],
	);
	const { state } = useFilters();
	const stats = useAnalytics("player-stats", { pid });
	const profile = useQuery({ queryKey: ["player-profile", pid], queryFn: ({ signal }) => api.playerProfile(pid, signal), retry: false, staleTime: 5 * 60_000 });
	// Notifications are an owner route: the read-only role doesn't get the button.
	const owner = !isReadOnly(useAuth());
	const buttons = VIEW_BUTTONS.filter((b) => b.id !== "notifications" || owner);
	const onShow = (next: Show) => patch({ show: next === "table" ? "table" : null });
	return (
		<Card className="gap-0 py-0">
			<section aria-label="Player detail">
				<div className="border-b p-4 sm:p-6">
					<ProfileCard pid={pid} profile={profile} stats={stats.data} statsLoading={stats.isPending} range={describeRange(state)} />
				</div>
				<section aria-label="Funnels" className="space-y-2 border-b px-4 py-3 sm:px-6">
					<h3 className="text-xs font-medium text-muted-foreground">Funnels</h3>
					<PlayerFunnels pid={pid} />
				</section>
				<nav aria-label="Player views" className="border-b p-2 sm:p-3">
					<div className="grid gap-1 rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${buttons.length}, minmax(0, 1fr))` }}>
						{buttons.map(({ id, label, icon: Icon }) => (
							<Button
								key={id}
								variant={view === id ? "outline" : "ghost"}
								aria-pressed={view === id}
								className={`h-auto min-w-0 flex-col gap-1 px-1 py-2 text-xs sm:flex-row sm:gap-2 sm:text-sm ${view === id ? "bg-background shadow-xs dark:bg-background" : "text-muted-foreground"}`}
								onClick={() => patch({ view: id === "spending" ? null : id })}
							>
								<Icon />
								{label}
							</Button>
						))}
					</div>
				</nav>
				<div className="space-y-3 p-4 sm:p-6">
					{stats.data?.window.clamped && view !== "timeline" && view !== "errors" && view !== "feedback" && view !== "notifications" ? <p className="text-xs text-muted-foreground">The range is longer than 400 days: these numbers cover its last 400.</p> : null}
					{view === "notifications" && owner ? (
						<NotificationsView pid={pid} />
					) : view === "feedback" ? (
						<FeedbackView pid={pid} />
					) : view === "errors" ? (
						<ErrorsView pid={pid} />
					) : view === "timeline" ? (
						<TimelineView pid={pid} />
					) : (
						<QueryState query={stats} loadingRows={4}>
							{(s) =>
								view === "spending" ? (
									<SpendingView stats={s} show={show} onShow={onShow} />
								) : view === "playtime" ? (
									<PlaytimeView stats={s} show={show} onShow={onShow} />
								) : (
									<SessionsView stats={s} show={show} onShow={onShow} onSession={(sid) => patch({ view: "timeline", sid })} />
								)
							}
						</QueryState>
					)}
				</div>
			</section>
		</Card>
	);
}
