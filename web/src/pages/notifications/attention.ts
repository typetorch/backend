/**
 * The Notifications page's "Needs attention" list, derived in the browser from data the page already loads (the live
 * status, the queue and opt-in queries) with simple rules. Each issue names the tab that shows its detail.
 */
import type { NotifyOptinResult, NotifyQueueResult, NotifyStatus } from "@/lib/types";

export type NotifyTab = "health" | "funnel" | "inbox" | "subscribers" | "kinds" | "queue" | "settings";
export const NOTIFY_TABS: readonly NotifyTab[] = ["health", "funnel", "inbox", "subscribers", "kinds", "queue", "settings"];

export interface AttentionItem {
	id: string;
	level: "error" | "warn" | "info";
	title: string;
	detail: string;
	tab: NotifyTab;
}

const DAY_MS = 86_400_000;
/** A prompt spot needs this many players shown before its subscribed rate is compared. */
export const SPOT_MIN_SHOWN = 20;

/** Roblox's refusal of a player who isn't opted in (the sender mutes them for 7 days). */
const notOptedIn = (code: string) => /PRECONDITION|NOT_SUBSCRIBED|not_subscribed/i.test(code);

export function attentionItems(input: { status?: NotifyStatus; queue?: NotifyQueueResult; optin?: NotifyOptinResult; now?: number }): AttentionItem[] {
	const { status, queue, optin } = input;
	const now = input.now ?? Date.now();
	const out: AttentionItem[] = [];
	if (status) {
		if (status.haltedAll)
			out.push({ id: "halted-all", level: "error", title: "Every send stopped", detail: "Roblox refused the Open Cloud key (401 / 403). Fix the key, then turn sending back on.", tab: "settings" });
		for (const h of status.halted) {
			if (typeof h.kind === "string" && h.kind)
				out.push({ id: `halted-${h.kind}`, level: "error", title: `Kind ${h.kind} stopped`, detail: "Its template (message id) does not exist on Roblox. Fix it, push the config, then turn the kind back on.", tab: "kinds" });
		}
		if (status.haltedTemplates?.length)
			out.push({ id: "halted-templates", level: "warn", title: `${status.haltedTemplates.length} game-supplied ${status.haltedTemplates.length === 1 ? "template" : "templates"} stopped`, detail: "Roblox says they don't exist; sends that use them are dropped.", tab: "queue" });
		if (!status.enabled && !status.haltedAll) out.push({ id: "paused", level: "warn", title: "Sending is paused", detail: "Nothing is planned or sent until it is turned back on.", tab: "settings" });
		if (status.dryRun) out.push({ id: "dry-run", level: "info", title: "Dry run is on", detail: "Sends are planned and logged, never posted to Roblox.", tab: "settings" });
		const missing = [!status.configured.universe && "universe", !status.configured.apiKey && "API key", !status.keys.current && "signing key", !status.config && "pushed config"].filter(Boolean);
		if (missing.length) out.push({ id: "setup", level: "error", title: `Missing ${missing.join(", ")}`, detail: "Sends can't go out until the backend has it.", tab: "settings" });
	}
	if (queue) {
		// Failures seen in the last 24 h, by HTTP status and code (429s apart: they are retried)
		const recent = queue.failures.filter((f) => f.lastAt && now - Date.parse(f.lastAt) < DAY_MS);
		const groups = new Map<string, { http: number | null; code: string; n: number }>();
		let limited = 0;
		for (const f of recent) {
			if (f.http === 429) {
				limited += f.failures;
				continue;
			}
			const key = `${f.http ?? "network"}|${f.code}`;
			const g = groups.get(key) ?? { http: f.http, code: f.code, n: 0 };
			g.n += f.failures;
			groups.set(key, g);
		}
		for (const [key, g] of groups) {
			const what = `${g.http ?? "network"}${g.code ? ` ${g.code}` : ""}`;
			out.push({
				id: `fail-${key}`,
				level: "warn",
				title: `${g.n} ${g.n === 1 ? "send" : "sends"} failed (${what}) in the last 24 h`,
				detail: notOptedIn(g.code) ? "Players who aren't opted in: they are muted 7 days automatically." : "See the failures table for the kinds and Roblox's answer.",
				tab: "queue",
			});
		}
		if (limited) out.push({ id: "rate-limited", level: "info", title: `${limited} rate-limited ${limited === 1 ? "send" : "sends"} (429) in the last 24 h`, detail: "Retried automatically; the sender slows down.", tab: "queue" });
	}
	if (optin) {
		const spots = optin.byWhere.filter((w) => (w.shownPlayers ?? 0) > 0);
		const shown = spots.reduce((a, w) => a + (w.shownPlayers ?? 0), 0);
		const subscribed = spots.reduce((a, w) => a + (w.subscribed ?? 0), 0);
		const average = shown ? subscribed / shown : 0;
		if (spots.length > 1 && average > 0) {
			for (const w of spots) {
				const rate = w.subscribedRate ?? 0;
				if ((w.shownPlayers ?? 0) >= SPOT_MIN_SHOWN && rate < average / 2)
					out.push({
						id: `spot-${w.where}`,
						level: "warn",
						title: `${w.where || "(no spot name)"} prompt converts ${Math.round(rate * 100)}%`,
						detail: `The spots average ${Math.round(average * 100)}%. Consider moving or dropping it.`,
						tab: "funnel",
					});
			}
		}
	}
	const order = { error: 0, warn: 1, info: 2 } as const;
	return out.sort((a, b) => order[a.level] - order[b.level]);
}
