/**
 * Runtime settings (the backend README's "Runtime settings"): what an owner may change without a redeploy. A value saved
 * here wins over the environment and applies at once; "Reset to env" goes back to the environment's value. The alert
 * webhook is a secret: the page only knows whether one is set. A new one goes into a password field that empties after
 * the save, and the backend never sends it back.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RotateCcw, Save, Send, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { alertRulesChange, BackendAlertRules, type AlertRulesDraft } from "@/components/BackendAlertRules";
import { CentralLoginSection } from "@/components/CentralLoginSection";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtInt, fmtTime, plural } from "@/lib/format";
import type { RuntimeSetting, SecretSetting, SettingSource, SettingsAuditEntry, SettingsView, ValueSetting } from "@/lib/types";

export const SETTINGS_KEY = ["admin-settings"] as const;

const GROUPS: { id: RuntimeSetting["group"]; title: string; description: string }[] = [
	{ id: "alerts", title: "Alerts", description: "Where fleet alerts go, and which ones." },
	{ id: "backendAlerts", title: "Backend alerts", description: "Alerts the backend raises from its own data, checked once a minute. They show on the Fleet page and go to the webhook like the game's." },
	{ id: "access", title: "Access", description: "Who may reach the explorer, and how owners sign in." },
	{ id: "limits", title: "Rate limits", description: "Per minute. Game servers past a limit get 429 and retry." },
	{ id: "retention", title: "Retention and error budgets", description: "How long data is kept, and how much error data is stored." },
];

const SOURCE_TEXT: Record<SettingSource, string> = { dashboard: "Dashboard", env: "Env", default: "Default" };
const SOURCE_TITLE: Record<SettingSource, string> = {
	dashboard: "Saved on this page: wins over the environment",
	env: "From the environment (Coolify)",
	default: "The built-in default (not set in the environment)",
};

/** The picked option of a toggle stands out (the value is the point here). */
const PICKED = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

/** Unsaved changes per key: null = back to the environment; numbers and lists as typed text; the rest as values. */
export type Draft = Record<string, unknown>;

/** Why a typed number can't be saved, or null. */
export function numberProblem(setting: Pick<ValueSetting, "min" | "max" | "zero">, text: string): string | null {
	const t = text.trim();
	const range = `${fmtInt(setting.min ?? 0)} to ${fmtInt(setting.max ?? 0)}${setting.zero ? ` (or 0 = ${setting.zero})` : ""}`;
	if (!/^-?\d+$/.test(t)) return `a whole number from ${range}`;
	const n = Number(t);
	if (setting.zero && n === 0) return null;
	if (n < (setting.min ?? -Infinity) || n > (setting.max ?? Infinity)) return `from ${range}`;
	return null;
}

/** "10.0.0.0/8, 203.0.113.7" or one per line -> the list the backend takes. */
export function splitList(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

/** The PATCH body for a draft (plus a newly typed webhook URL), and what blocks saving. */
export function buildChanges(settings: RuntimeSetting[], draft: Draft, newSecret: string): { changes: Record<string, unknown>; problems: Record<string, string> } {
	const changes: Record<string, unknown> = {};
	const problems: Record<string, string> = {};
	for (const [key, value] of Object.entries(draft)) {
		const setting = settings.find((s) => s.key === key);
		if (!setting) continue;
		if (value === null) {
			changes[key] = null;
			continue;
		}
		if (setting.kind === "number") {
			const problem = numberProblem(setting, String(value));
			if (problem) problems[key] = problem;
			else changes[key] = Number(String(value).trim());
		} else if (setting.kind === "alertRules" && setting.rules) {
			const result = alertRulesChange(setting.rules, value as AlertRulesDraft);
			if ("problem" in result) problems[key] = `a valid value (${result.problem})`;
			else changes[key] = result.value;
		} else if (setting.kind === "ips" || setting.kind === "users") changes[key] = splitList(String(value));
		else changes[key] = value;
	}
	const secret = newSecret.trim();
	const webhook = settings.find((s) => s.kind === "secret");
	if (secret && webhook) {
		if (!/^https:\/\/\S+$/i.test(secret)) problems[webhook.key] = "an https:// URL";
		else changes[webhook.key] = secret;
	}
	return { changes, problems };
}

function SourceBadge({ source }: { source: SettingSource }) {
	return (
		<Badge variant={source === "dashboard" ? "default" : source === "env" ? "secondary" : "outline"} title={SOURCE_TITLE[source]}>
			{SOURCE_TEXT[source]}
		</Badge>
	);
}

/** One setting: its name, env variable and source on the left; the control, help and state on the right. */
function Field({
	setting,
	draft,
	onReset,
	onUndo,
	disabled,
	problem,
	children,
	note,
	typed = false,
}: {
	setting: RuntimeSetting;
	draft: Draft;
	onReset(): void;
	onUndo(): void;
	disabled: boolean;
	problem?: string | undefined;
	children: ReactNode;
	note?: ReactNode;
	/** A new secret is typed (not in the draft: it lives in its own field). */
	typed?: boolean;
}) {
	const pending = Object.hasOwn(draft, setting.key);
	const resetting = pending && draft[setting.key] === null;
	const bounds =
		setting.kind === "number" ? `${fmtInt(setting.min ?? 0)} to ${fmtInt(setting.max ?? 0)} ${setting.unit ?? ""}${setting.zero ? `; 0 = ${setting.zero}` : ""}`.trim() : null;
	return (
		<div className="grid gap-2 border-b py-3 last:border-b-0 md:grid-cols-[15rem_1fr]" data-setting={setting.key}>
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					<Label htmlFor={`setting-${setting.key}`}>{setting.label}</Label>
					<SourceBadge source={setting.source} />
					{pending || typed ? <Badge variant="outline">Unsaved</Badge> : null}
				</div>
				<div className="break-all font-mono text-[11px] text-muted-foreground">{setting.env}</div>
			</div>
			<div className="min-w-0 space-y-1.5">
				{children}
				<p className="text-xs text-muted-foreground">
					{setting.help}
					{bounds ? <span className="tabular-nums"> ({bounds})</span> : null}
				</p>
				{note}
				{problem ? <p className="text-xs text-destructive">Must be {problem}.</p> : null}
				{resetting ? <p className="text-xs text-muted-foreground">Goes back to the environment's value when you save.</p> : null}
				<div className="flex flex-wrap gap-1">
					{pending ? (
						<Button variant="ghost" size="xs" onClick={onUndo} disabled={disabled}>
							<Undo2 />
							Undo
						</Button>
					) : null}
					{setting.source === "dashboard" && !resetting ? (
						<Button variant="ghost" size="xs" onClick={onReset} disabled={disabled}>
							<RotateCcw />
							Reset to env
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}

function WebhookControl({
	setting,
	draft,
	secret,
	setSecret,
	clear,
	disabled,
}: {
	setting: SecretSetting;
	draft: Draft;
	secret: string;
	setSecret(v: string): void;
	clear(): void;
	disabled: boolean;
}) {
	const pending = Object.hasOwn(draft, setting.key) ? draft[setting.key] : undefined;
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<Badge variant={setting.set ? "secondary" : "outline"}>{setting.set ? "Set" : "Not set"}</Badge>
				{pending === "" ? <span className="text-xs text-muted-foreground">Cleared when you save: no alerts go out.</span> : null}
				{pending === null ? <span className="text-xs text-muted-foreground">{setting.fallbackSet ? "The environment's webhook again when you save." : "None when you save (the environment has none)."}</span> : null}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					id={`setting-${setting.key}`}
					type="password"
					autoComplete="off"
					spellCheck={false}
					className="h-8 max-w-md"
					placeholder={setting.set ? "Paste a new URL to replace it" : "https://discord.com/api/webhooks/..."}
					value={secret}
					disabled={disabled}
					onChange={(e) => setSecret(e.target.value)}
				/>
				{setting.set && pending !== "" ? (
					<Button variant="outline" size="sm" onClick={clear} disabled={disabled}>
						Clear
					</Button>
				) : null}
			</div>
		</div>
	);
}

/** What a change did, as plain text (the search and the CSV use it; the cell shows the same words). */
function auditWhat(e: SettingsAuditEntry): string {
	if (e.action === "test-alert") return `Test alert: ${e.result ?? ""}`;
	return [e.set?.length ? `Set ${e.set.join(", ")}` : "", e.reset?.length ? `Reset ${e.reset.join(", ")}` : ""].filter(Boolean).join("; ");
}

const AUDIT_COLUMNS: DataColumn<SettingsAuditEntry>[] = [
	{ id: "at", header: "When", type: "date", accessor: (e) => e.at, cell: (e) => <span title={fmtTime(e.at)}>{fmtAgo(e.at)}</span>, format: (_v, e) => fmtAgo(e.at), className: "text-xs" },
	{
		id: "who",
		header: "Who",
		accessor: (e) => e.who,
		cell: (e) => (
			<>
				{e.who}
				<span className="text-muted-foreground"> ({e.via === "bearer" ? "CLI token" : "explorer"})</span>
			</>
		),
		className: "text-xs",
	},
	{ id: "via", header: "Via", type: "enum", accessor: (e) => (e.via === "bearer" ? "CLI token" : "explorer"), defaultHidden: true },
	{ id: "action", header: "Action", type: "enum", accessor: (e) => e.action, defaultHidden: true },
	{
		id: "what",
		header: "What",
		accessor: auditWhat,
		cell: (e) =>
			e.action === "test-alert" ? (
				<>Test alert: {e.result}</>
			) : (
				<>
					{e.set?.length ? <span>Set {e.set.join(", ")}</span> : null}
					{e.set?.length && e.reset?.length ? "; " : null}
					{e.reset?.length ? <span>Reset {e.reset.join(", ")}</span> : null}
				</>
			),
		className: "text-xs whitespace-normal",
	},
];

function AuditList({ entries }: { entries: SettingsAuditEntry[] }) {
	return (
		<DataTable
			id="settings-audit"
			label="Settings changes"
			columns={AUDIT_COLUMNS}
			data={entries}
			defaultSort={[{ id: "at", desc: true }]}
			empty={<EmptyState>No changes yet. Each save and test alert is listed here (who and which settings, never the values).</EmptyState>}
		/>
	);
}

function SettingsForm({ data }: { data: SettingsView }) {
	const client = useQueryClient();
	const [draft, setDraft] = useState<Draft>({});
	const [secret, setSecret] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const disabled = !data.enabled;

	const { changes, problems } = buildChanges(data.settings, draft, secret);
	const dirty = Object.keys(changes).length > 0 || Object.keys(problems).length > 0;
	const set = (key: string, value: unknown) => {
		setNotice(null);
		setDraft((d) => ({ ...d, [key]: value }));
	};
	const undo = (key: string) =>
		setDraft((d) => {
			const next = { ...d };
			delete next[key];
			return next;
		});

	const save = useMutation({
		mutationFn: (body: Record<string, unknown>) => api.saveSettings(body),
		onSuccess: (view) => {
			client.setQueryData(SETTINGS_KEY, view);
			setDraft({});
			setSecret("");
			const n = view.changed?.length ?? 0;
			setNotice(
				`${n ? `Saved ${plural(n, "setting")}; in effect now.` : "Nothing changed."}${view.sessionsEnded ? ` ${plural(view.sessionsEnded, "browser session")} made with the admin token signed out.` : ""}`,
			);
		},
	});
	const test = useMutation({
		mutationFn: () => api.testAlert(),
		onSettled: () => void client.invalidateQueries({ queryKey: SETTINGS_KEY }),
	});

	const dashboardKeys = data.settings.filter((s) => s.source === "dashboard").map((s) => s.key);
	const resetAll = () => {
		setNotice(null);
		setSecret("");
		setDraft(Object.fromEntries(dashboardKeys.map((k) => [k, null])));
	};
	const webhook = data.settings.find((s): s is SecretSetting => s.kind === "secret");
	const webhookPending = Boolean(secret.trim()) || (webhook ? Object.hasOwn(draft, webhook.key) : false);

	function control(setting: RuntimeSetting): ReactNode {
		const id = `setting-${setting.key}`;
		if (setting.kind === "secret")
			return (
				<WebhookControl
					setting={setting}
					draft={draft}
					secret={secret}
					setSecret={(v) => {
						setNotice(null);
						setSecret(v);
						if (v) undo(setting.key);
					}}
					clear={() => {
						setSecret("");
						set(setting.key, "");
					}}
					disabled={disabled}
				/>
			);
		const shown = Object.hasOwn(draft, setting.key) ? (draft[setting.key] === null ? setting.fallback : draft[setting.key]) : setting.value;
		switch (setting.kind) {
			case "alertRules":
				return setting.rules ? <BackendAlertRules meta={setting.rules} value={shown as AlertRulesDraft} disabled={disabled} onChange={(v) => set(setting.key, v)} /> : null;
			case "number":
				return (
					<Input
						id={id}
						inputMode="numeric"
						className="h-8 w-40 tabular-nums"
						aria-invalid={problems[setting.key] ? true : undefined}
						value={String(shown ?? "")}
						disabled={disabled}
						onChange={(e) => set(setting.key, e.target.value)}
					/>
				);
			case "ips":
			case "users": {
				const text = Array.isArray(shown) ? (shown as (string | number)[]).join("\n") : String(shown ?? "");
				return (
					<Textarea
						id={id}
						className="max-w-md font-mono text-xs"
						rows={3}
						placeholder={setting.kind === "users" ? "One Roblox UserId per line (empty: no viewers)" : "Empty: any address"}
						spellCheck={false}
						value={text}
						disabled={disabled}
						onChange={(e) => set(setting.key, e.target.value)}
					/>
				);
			}
			case "choice":
				return (
					<ToggleGroup id={id} type="single" variant="outline" size="sm" spacing={0} value={String(shown)} disabled={disabled} onValueChange={(v) => v && set(setting.key, v)} aria-label={setting.label}>
						{(setting.options ?? []).map((o) => (
							<ToggleGroupItem key={o} value={o} className={PICKED}>
								{o}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				);
			case "levels": {
				const order = setting.options ?? [];
				return (
					<ToggleGroup
						id={id}
						type="multiple"
						variant="outline"
						size="sm"
						spacing={0}
						value={(shown as string[]) ?? []}
						disabled={disabled}
						onValueChange={(v) => v.length && set(setting.key, order.filter((o) => v.includes(o)))}
						aria-label={setting.label}
					>
						{order.map((o) => (
							<ToggleGroupItem key={o} value={o} className={PICKED}>
								{o}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				);
			}
			case "switch": {
				const on = shown === true;
				// The backend refuses to turn the token login off unless this is a Roblox session (so a way in still works).
				const offBlocked = setting.key === "tokenLogin" && setting.value === true && !(data.robloxSignIn && data.you.roblox);
				return (
					<ToggleGroup id={id} type="single" variant="outline" size="sm" spacing={0} value={on ? "on" : "off"} disabled={disabled} onValueChange={(v) => v && set(setting.key, v === "on")} aria-label={setting.label}>
						<ToggleGroupItem value="on" className={PICKED}>
							On
						</ToggleGroupItem>
						<ToggleGroupItem value="off" disabled={offBlocked} className={PICKED}>
							Off
						</ToggleGroupItem>
					</ToggleGroup>
				);
			}
		}
	}

	function noteFor(setting: RuntimeSetting): ReactNode {
		if (setting.key === "adminAllowIps")
			return (
				<p className="text-xs text-muted-foreground">
					Your address as the backend sees it: <span className="font-mono text-foreground">{data.you.ip || "unknown"}</span>. A list without it is refused.
				</p>
			);
		if (setting.key === "tokenLogin" && setting.kind === "switch" && setting.value === true && !(data.robloxSignIn && data.you.roblox))
			return <p className="text-xs text-muted-foreground">{data.robloxSignIn ? "To turn it off, sign in with Roblox first." : "Turning it off needs Sign in with Roblox on this backend."}</p>;
		if (setting.kind === "secret" && setting.set)
			return (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending || webhookPending}>
						<Send />
						Send test alert
					</Button>
					{webhookPending ? <span className="text-xs text-muted-foreground">Save first: the test uses the saved webhook.</span> : null}
					{test.isSuccess ? <span className="text-xs">Test alert sent{test.data.status ? ` (HTTP ${test.data.status})` : ""}.</span> : null}
					{test.isError ? (
						<span className="text-xs text-destructive">
							{test.error instanceof ApiError && test.error.status === 429 ? "Too many test alerts: wait a minute." : test.error.message}
						</span>
					) : null}
				</div>
			);
		return null;
	}

	return (
		<div className="space-y-4">
			<PageHeader
				title="Settings"
				description="Changes apply at once, no redeploy. A value saved here wins over the environment."
				actions={
					<>
						{dirty ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setDraft({});
									setSecret("");
								}}
							>
								Discard
							</Button>
						) : null}
						{dashboardKeys.length ? (
							<Button variant="outline" size="sm" onClick={resetAll} disabled={disabled}>
								<RotateCcw />
								Reset all to env
							</Button>
						) : null}
						<Button size="sm" onClick={() => save.mutate(changes)} disabled={disabled || !dirty || Object.keys(problems).length > 0 || save.isPending}>
							<Save />
							{save.isPending ? "Saving" : "Save"}
						</Button>
					</>
				}
			/>
			{disabled ? (
				<Alert>
					<CircleAlert />
					<AlertTitle>Read only</AlertTitle>
					<AlertDescription>TYPETORCH_RUNTIME_SETTINGS=off on this backend: the environment's values apply and nothing here can be changed.</AlertDescription>
				</Alert>
			) : null}
			{save.isError ? (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>Not saved</AlertTitle>
					<AlertDescription>
						<p className="break-words">{save.error.message}</p>
					</AlertDescription>
				</Alert>
			) : null}
			{notice ? (
				<p role="status" className="text-sm text-muted-foreground">
					{notice}
				</p>
			) : null}
			{GROUPS.map((group) => {
				const items = data.settings.filter((s) => s.group === group.id);
				if (!items.length) return null;
				return (
					<Section key={group.id} title={group.title} description={group.description} contentClassName="py-0">
						{items.map((setting) => (
							<Field key={setting.key} setting={setting} draft={draft} disabled={disabled} problem={problems[setting.key]} onReset={() => set(setting.key, null)} onUndo={() => undo(setting.key)} note={noteFor(setting)} typed={setting.kind === "secret" && Boolean(secret.trim())}>
								{control(setting)}
							</Field>
						))}
					</Section>
				);
			})}
			{data.centralLogin ? <CentralLoginSection info={data.centralLogin} /> : null}
			<p className="text-xs text-muted-foreground">
				Environment only (change these on Coolify and redeploy): <span className="font-mono">{data.envOnly.join(", ")}</span>.
			</p>
			<Section title="Recent changes" description="Who changed which settings, and test alerts. Values are never recorded.">
				<AuditList entries={data.audit} />
			</Section>
		</div>
	);
}

export default function Settings() {
	const query = useQuery({ queryKey: SETTINGS_KEY, queryFn: ({ signal }) => api.settings(signal), staleTime: 0 });
	if (query.data) return <SettingsForm data={query.data} />;
	return (
		<div className="space-y-4">
			<PageHeader title="Settings" description="Changes apply at once, no redeploy. A value saved here wins over the environment." />
			<QueryState query={query}>{() => null}</QueryState>
		</div>
	);
}
