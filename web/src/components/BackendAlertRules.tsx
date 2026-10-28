/**
 * The backend alert rules on the Settings page (the backendAlerts runtime setting): a master switch, the repeat window and
 * the hourly cap, then each rule with its on/off, level and thresholds, and what it saw on the backend's last run (GET
 * /v1/admin/alert-rules). The draft keeps typed numbers as text; `alertRulesChange` turns it into the value to save, or
 * says what blocks it.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, plural } from "@/lib/format";
import type { AlertLevelName, AlertParamDef, AlertRuleDef, AlertRulesMeta, AlertRulesStatus, BackendAlertSettings } from "@/lib/types";

/** The draft: the setting's value with numbers as typed. */
export interface AlertRulesDraft {
	on: boolean;
	repeatMinutes: number | string;
	perHour: number | string;
	rules: Record<string, { on: boolean; level: AlertLevelName; params: Record<string, number | string> }>;
}

const LEVELS: AlertLevelName[] = ["critical", "warning", "info"];
const PICKED = "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";
const GROUP_TITLES: Record<AlertRuleDef["group"], string> = { errors: "Errors", players: "Players online", ingest: "Analytics ingest", backend: "Backend health", disk: "Disk" };

/** Why a typed threshold can't be saved, or null. */
export function paramProblem(param: AlertParamDef, text: number | string): string | null {
	const t = String(text).trim();
	const range = `${fmtInt(param.min)} to ${fmtInt(param.max)}${param.zero ? ` (or 0 = ${param.zero})` : ""}`;
	if (!/^-?\d+$/.test(t)) return `a whole number from ${range}`;
	const n = Number(t);
	if (param.zero && n === 0) return null;
	return n < param.min || n > param.max ? `from ${range}` : null;
}

/** The value to save for a draft, or the first problem ("Players online drop, Drop: from 10 to 100"). */
export function alertRulesChange(meta: AlertRulesMeta, draft: AlertRulesDraft): { value: BackendAlertSettings } | { problem: string } {
	const value: BackendAlertSettings = { on: draft.on, repeatMinutes: 0, perHour: 0, rules: {} };
	for (const g of meta.general) {
		const raw = (draft as unknown as Record<string, number | string>)[g.key] ?? "";
		const problem = paramProblem(g, raw);
		if (problem) return { problem: `${g.label}: ${problem}` };
		(value as unknown as Record<string, number>)[g.key] = Number(String(raw).trim());
	}
	for (const rule of meta.rules) {
		const d = draft.rules[rule.id];
		if (!d) continue;
		const params: Record<string, number> = {};
		for (const p of rule.params) {
			const raw = d.params[p.key] ?? "";
			const problem = paramProblem(p, raw);
			if (problem) return { problem: `${rule.label}, ${p.label}: ${problem}` };
			params[p.key] = Number(String(raw).trim());
		}
		value.rules[rule.id] = { on: d.on, level: d.level, params };
	}
	return { value };
}

const STATE_BADGE: Record<AlertRulesStatus["rules"][number]["state"], { text: string; variant: "destructive" | "secondary" | "outline" }> = {
	firing: { text: "Firing", variant: "destructive" },
	ok: { text: "OK", variant: "secondary" },
	waiting: { text: "Waiting", variant: "outline" },
	off: { text: "Off", variant: "outline" },
	unavailable: { text: "Unavailable", variant: "outline" },
};

function OnOff({ id, on, disabled, label, onChange }: { id?: string; on: boolean; disabled: boolean; label: string; onChange(on: boolean): void }) {
	return (
		<ToggleGroup id={id} type="single" variant="outline" size="sm" spacing={0} value={on ? "on" : "off"} disabled={disabled} onValueChange={(v) => v && onChange(v === "on")} aria-label={label}>
			<ToggleGroupItem value="on" className={PICKED}>
				On
			</ToggleGroupItem>
			<ToggleGroupItem value="off" className={PICKED}>
				Off
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

function NumberField({ param, value, disabled, label, onChange }: { param: AlertParamDef; value: number | string; disabled: boolean; label: string; onChange(text: string): void }) {
	const problem = paramProblem(param, value);
	return (
		<label className="flex flex-wrap items-center gap-1.5 text-xs" title={`${param.env}: ${fmtInt(param.min)} to ${fmtInt(param.max)}${param.zero ? `, 0 = ${param.zero}` : ""}`}>
			<span className="text-muted-foreground">{param.label}</span>
			<Input
				inputMode="numeric"
				className="h-7 w-24 tabular-nums"
				aria-label={label}
				aria-invalid={problem ? true : undefined}
				value={String(value)}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
			/>
			<span className="text-muted-foreground">{param.unit}</span>
		</label>
	);
}

function RuleBlock({ rule, draft, status, disabled, onChange }: { rule: AlertRuleDef; draft: AlertRulesDraft["rules"][string]; status?: AlertRulesStatus["rules"][number] | undefined; disabled: boolean; onChange(next: AlertRulesDraft["rules"][string]): void }) {
	const badge = status ? STATE_BADGE[status.state] : null;
	return (
		<div className="space-y-2 rounded-md border p-3" data-rule={rule.id}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sm font-medium">{rule.label}</span>
				{badge ? (
					<Badge variant={badge.variant} title={status?.note}>
						{badge.text}
					</Badge>
				) : null}
				{rule.needs.includes("analytics") ? <Badge variant="outline">needs analytics</Badge> : null}
				<span className="font-mono text-[11px] text-muted-foreground break-all">{rule.env}</span>
			</div>
			<p className="text-xs text-muted-foreground">{rule.help}</p>
			<div className="flex flex-wrap items-center gap-2">
				<OnOff on={draft.on} disabled={disabled} label={`${rule.label} on or off`} onChange={(on) => onChange({ ...draft, on })} />
				<ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={draft.level} disabled={disabled} onValueChange={(v) => v && onChange({ ...draft, level: v as AlertLevelName })} aria-label={`${rule.label} level`}>
					{LEVELS.map((l) => (
						<ToggleGroupItem key={l} value={l} className={PICKED}>
							{l}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-2">
				{rule.params.map((p) => (
					<NumberField
						key={p.key}
						param={p}
						value={draft.params[p.key] ?? ""}
						disabled={disabled}
						label={`${rule.label}: ${p.label}`}
						onChange={(text) => onChange({ ...draft, params: { ...draft.params, [p.key]: text } })}
					/>
				))}
			</div>
			{status && status.state !== "off" ? (
				<p className="text-xs text-muted-foreground">
					Last run: {status.note}
					{status.lastRaisedAt ? `; last raised ${fmtAgo(status.lastRaisedAt)}` : ""}
				</p>
			) : null}
		</div>
	);
}

export function BackendAlertRules({ meta, value, disabled, onChange }: { meta: AlertRulesMeta; value: AlertRulesDraft; disabled: boolean; onChange(next: AlertRulesDraft): void }) {
	const status = useQuery({ queryKey: ["alert-rules"], queryFn: ({ signal }) => api.alertRules(signal), refetchInterval: 60_000, retry: false });
	const byId = new Map((status.data?.rules ?? []).map((r) => [r.id, r]));
	const groups = [...new Set(meta.rules.map((r) => r.group))];
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<OnOff id="setting-backendAlerts" on={value.on} disabled={disabled} label="Backend alerts on or off" onChange={(on) => onChange({ ...value, on })} />
				{meta.general.map((g) => (
					<NumberField
						key={g.key}
						param={g}
						value={(value as unknown as Record<string, number | string>)[g.key] ?? ""}
						disabled={disabled}
						label={g.label}
						onChange={(text) => onChange({ ...value, [g.key]: text })}
					/>
				))}
			</div>
			{status.data ? (
				<p className="text-xs text-muted-foreground" role="status">
					{status.data.lastRunAt ? `Checked ${fmtAgo(status.data.lastRunAt)} (every ${status.data.tickSeconds} s)` : "Not checked yet"}: {plural(status.data.raised, "alert")} raised
					{status.data.throttled ? `, ${fmtInt(status.data.throttled)} over the hourly cap` : ""} since the start.
				</p>
			) : status.isError ? (
				<p className="text-xs text-muted-foreground">The rules' state is not available here (backend alerts need the fleet part).</p>
			) : null}
			{groups.map((group) => (
				<div key={group} className="space-y-2">
					<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{GROUP_TITLES[group]}</div>
					{meta.rules
						.filter((r) => r.group === group)
						.map((rule) => {
							const draft = value.rules[rule.id];
							if (!draft) return null;
							return <RuleBlock key={rule.id} rule={rule} draft={draft} status={byId.get(rule.id)} disabled={disabled} onChange={(next) => onChange({ ...value, rules: { ...value.rules, [rule.id]: next } })} />;
						})}
				</div>
			))}
		</div>
	);
}
