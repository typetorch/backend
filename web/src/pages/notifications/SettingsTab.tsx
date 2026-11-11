/**
 * The Settings tab (owners who can edit): the runtime settings `notify.*` through PATCH /v1/admin/settings (audited, no
 * redeploy), a test send with a text preview, the kinds as the pushed config record has them (read-only, with their
 * on / off switch) and the config record itself.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { EmptyState, JsonBlock, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt } from "@/lib/format";
import type { NotifyConfigView, NotifyStatus } from "@/lib/types";
import { fillText, OnOff, PICKED } from "./shared";

export const NOTIFY_STATUS_KEY = ["notify-status"] as const;
export const NOTIFY_CONFIG_KEY = ["notify-config"] as const;

/** Saves runtime settings and refreshes the status; `notice` says it took effect. */
export function useNotifySettings() {
	const client = useQueryClient();
	const [notice, setNotice] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (changes: Record<string, unknown>) => api.saveSettings(changes),
		onSuccess: () => setNotice("Saved; in effect now."),
		onSettled: () => void client.invalidateQueries({ queryKey: NOTIFY_STATUS_KEY }),
	});
	const set = (key: string, value: unknown) => {
		setNotice(null);
		save.mutate({ [key]: value });
	};
	return { set, busy: save.isPending, error: save.isError ? save.error : null, notice };
}

/** A whole number setting with its own Save button (bounds checked before saving). */
function NumberSetting({ id, label, value, min, max, disabled, onSave }: { id: string; label: string; value: number; min: number; max: number; disabled: boolean; onSave(next: number): void }) {
	const [text, setText] = useState(String(value));
	const n = Number(text);
	const ok = Number.isFinite(n) && n >= min && n <= max;
	return (
		<form
			className="space-y-1"
			onSubmit={(e) => {
				e.preventDefault();
				if (ok) onSave(Math.round(n));
			}}
		>
			<Label htmlFor={id}>{label}</Label>
			<div className="flex gap-2">
				<Input id={id} inputMode="numeric" className="h-8 w-24 tabular-nums" aria-invalid={ok ? undefined : true} value={text} onChange={(e) => setText(e.target.value)} />
				<Button type="submit" size="sm" variant="outline" disabled={disabled || !ok || Math.round(n) === value} aria-label={`Save ${label}`}>
					Save
				</Button>
			</div>
		</form>
	);
}

function Controls({ status }: { status: NotifyStatus }) {
	const { set, busy, error, notice } = useNotifySettings();
	return (
		<Section className="min-w-0" title="Sending" description="Runtime settings: saved at once, audited, no redeploy. Dry run plans and logs every send without posting it to Roblox.">
			<div className="space-y-4">
				<div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
					<div className="space-y-1">
						<Label>Sending</Label>
						<OnOff label="Sending" value={status.enabled} disabled={busy} onChange={(v) => set("notify.enabled", v)} on="On" off="Paused" />
					</div>
					<div className="space-y-1">
						<Label>Dry run</Label>
						<OnOff label="Dry run" value={status.dryRun} disabled={busy} onChange={(v) => set("notify.dryRun", v)} />
					</div>
					<div className="space-y-1">
						<Label>Day clock</Label>
						<ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={status.clock} disabled={busy} onValueChange={(v) => v && set("notify.clock", v)} aria-label="Day clock">
							<ToggleGroupItem value="rolling24" className={PICKED}>
								Rolling 24 h
							</ToggleGroupItem>
							<ToggleGroupItem value="utc_day" className={PICKED}>
								UTC day
							</ToggleGroupItem>
						</ToggleGroup>
					</div>
					<NumberSetting key={`rate-${status.rate}`} id="notify-rate" label="Rate ceiling (sends / s)" value={status.rate} min={1} max={4000} disabled={busy} onSave={(v) => set("notify.rate", v)} />
					{status.presenceStaleHours !== undefined ? (
						<NumberSetting
							key={`stale-${status.presenceStaleHours}`}
							id="notify-stale"
							label="Presence goes stale after (hours)"
							value={status.presenceStaleHours}
							min={1}
							max={168}
							disabled={busy}
							onSave={(v) => set("notify.presenceStaleHours", v)}
						/>
					) : null}
				</div>
				<div className="flex flex-wrap gap-2 text-xs">
					<Badge variant={status.configured.universe && status.configured.apiKey ? "outline" : "destructive"}>
						{status.configured.universe && status.configured.apiKey ? "Open Cloud configured" : `Missing ${[!status.configured.universe && "universe", !status.configured.apiKey && "API key"].filter(Boolean).join(" and ")}`}
					</Badge>
					<Badge variant={status.keys.current ? "outline" : "destructive"}>{status.keys.current ? `Signing key set${status.keys.previous ? " (+ previous)" : ""}` : "No signing key"}</Badge>
					<Badge variant={status.config ? "outline" : "destructive"}>{status.config ? "Config pushed" : "No config pushed"}</Badge>
				</div>
				{error ? <p className="text-sm text-destructive">{error.message}</p> : null}
				{notice ? (
					<p role="status" className="text-sm text-muted-foreground">
						{notice}
					</p>
				) : null}
			</div>
		</Section>
	);
}

/** A test param row: `fixed` = a placeholder of the kind's text (its name can't be edited or removed). */
export interface ParamRow {
	id: number;
	name: string;
	value: string;
	fixed: boolean;
}

/** The `{placeholders}` of a kind's text, in order, each once (the backend's PARAM_NAME rule). */
export function placeholdersOf(text: string | undefined): string[] {
	const out: string[] = [];
	for (const m of (text ?? "").matchAll(/\{([A-Za-z0-9_-]{1,32})\}/g)) if (!out.includes(m[1])) out.push(m[1]);
	return out;
}

/** The rows as params: blank custom rows skipped; a value without a name or a name twice throws. */
export function rowsToParams(rows: ParamRow[]): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const row of rows) {
		const name = row.name.trim();
		if (!name) {
			if (row.value.trim()) throw new Error("A param has a value but no name.");
			continue;
		}
		if (name in out) throw new Error(`"${name}" is there twice.`);
		out[name] = row.value;
	}
	return Object.keys(out).length ? out : undefined;
}

let nextRowId = 1;
function rowsFor(text: string | undefined, keep: ParamRow[] = []): ParamRow[] {
	const fixed = placeholdersOf(text).map((name) => ({ id: nextRowId++, name, value: keep.find((r) => r.name === name)?.value ?? "", fixed: true }));
	const custom = keep.filter((r) => !r.fixed && !fixed.some((f) => f.name === r.name.trim()));
	return [...fixed, ...custom];
}

export function TestSend({ kinds }: { kinds: { kind: string; text?: string }[] }) {
	const [userId, setUserId] = useState("");
	const [kind, setKind] = useState("");
	const picked = kind || kinds[0]?.kind || "";
	const textOf = (k: string) => kinds.find((x) => x.kind === k)?.text;
	const [rows, setRows] = useState<ParamRow[]>(() => rowsFor(textOf(picked)));
	const [rowsKind, setRowsKind] = useState(picked);
	// the kinds arrive after the first render, or the kind changed: re-seed the placeholder rows, keeping typed values and custom rows
	if (rowsKind !== picked) {
		setRowsKind(picked);
		setRows(rowsFor(textOf(picked), rows));
	}
	const [data, setData] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const send = useMutation({ mutationFn: (input: Parameters<typeof api.notifyTest>[0]) => api.notifyTest(input) });
	const edit = (id: number, patch: Partial<ParamRow>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	const preview = fillText(textOf(picked), Object.fromEntries(rows.filter((r) => r.name.trim() && r.value).map((r) => [r.name.trim(), r.value])));
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setProblem(null);
		const id = Number(userId.trim());
		if (!Number.isSafeInteger(id) || id <= 0) return setProblem("UserId must be a positive whole number.");
		if (!picked) return setProblem("Pick a kind.");
		let p: Record<string, string> | undefined;
		try {
			p = rowsToParams(rows);
		} catch (error) {
			return setProblem((error as Error).message);
		}
		send.mutate({ userId: id, kind: picked, ...(p ? { params: p } : {}), ...(data.trim() ? { data: data.trim() } : {}) });
	};
	return (
		<form className="space-y-3" onSubmit={submit} aria-label="Send a test">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="notify-test-user">UserId</Label>
					<Input id="notify-test-user" inputMode="numeric" className="h-8 tabular-nums" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="123456789" />
				</div>
				<div className="space-y-1">
					<Label htmlFor="notify-test-kind">Kind</Label>
					<Select value={picked} onValueChange={setKind}>
						<SelectTrigger id="notify-test-kind" size="sm" className="w-full" aria-label="Test kind">
							<SelectValue placeholder="No kinds pushed" />
						</SelectTrigger>
						<SelectContent>
							{kinds.map((k) => (
								<SelectItem key={k.kind} value={k.kind}>
									{k.kind}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<fieldset className="space-y-1.5 sm:col-span-2" aria-label="Params">
					<legend className="text-sm font-medium leading-none">Params</legend>
					{textOf(picked) ? <p className="font-mono text-xs text-muted-foreground">{`Text: ${textOf(picked)}`}</p> : null}
					{rows.map((row, index) => (
						<div key={row.id} className="flex items-center gap-2">
							<Input
								aria-label={`Param ${index + 1} name`}
								className="h-8 w-1/3 font-mono text-xs"
								spellCheck={false}
								readOnly={row.fixed}
								value={row.name}
								placeholder="name"
								onChange={(e) => edit(row.id, { name: e.target.value })}
							/>
							<Input aria-label={`${row.name || `Param ${index + 1}`} value`} className="h-8 min-w-0 flex-1 font-mono text-xs" spellCheck={false} value={row.value} placeholder="value" onChange={(e) => edit(row.id, { value: e.target.value })} />
							{row.fixed ? (
								<span className="w-8" aria-hidden />
							) : (
								<Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Remove ${row.name || `param ${index + 1}`}`} onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}>
									<X />
								</Button>
							)}
						</div>
					))}
					<Button type="button" variant="outline" size="sm" onClick={() => setRows((all) => [...all, { id: nextRowId++, name: "", value: "", fixed: false }])}>
						<Plus />
						Add param
					</Button>
				</fieldset>
				<div className="space-y-1">
					<Label htmlFor="notify-test-data">Launch data</Label>
					<Input id="notify-test-data" className="h-8 font-mono text-xs" maxLength={64} value={data} onChange={(e) => setData(e.target.value)} placeholder="optional, up to 64 bytes" />
				</div>
			</div>
			{preview ? (
				<p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" aria-label="Preview">
					<span className="text-xs text-muted-foreground">Preview: </span>
					{preview}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" size="sm" disabled={send.isPending || !kinds.length}>
					<Send />
					Send a test
				</Button>
			</div>
			{problem ? <p className="text-sm text-destructive">{problem}</p> : null}
			{send.isError ? <p className="text-sm text-destructive">{send.error.message}</p> : null}
			{send.data ? (
				<p role="status" className="text-sm">
					Test <span className="font-mono">{send.data.nid}</span>: {send.data.status}
				</p>
			) : null}
		</form>
	);
}

type KindRecord = { template?: string; priority?: number; perWeek?: number; repeat?: string; send?: string; maxWaitHours?: number; beats?: { kinds?: string[]; withinHours?: number } };
const kindsOf = (view: NotifyConfigView | undefined): Record<string, KindRecord> => {
	const kinds = (view?.config as { kinds?: unknown } | null | undefined)?.kinds;
	return kinds && typeof kinds === "object" && !Array.isArray(kinds) ? (kinds as Record<string, KindRecord>) : {};
};

/** The kinds as the pushed config record has them (read-only; `typetorch notify push` changes it), with their switch. */
function KindConfigTable({ status, config }: { status: NotifyStatus; config: NotifyConfigView | undefined }) {
	const { set, busy } = useNotifySettings();
	const record = kindsOf(config);
	const names = [...new Set([...status.kinds.map((k) => k.kind), ...Object.keys(record)])];
	if (!names.length) return <EmptyState>No kinds yet: push the game's notifications config with typetorch notify push.</EmptyState>;
	return (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full min-w-[40rem] text-sm" aria-label="Kinds config">
				<thead className="text-xs text-muted-foreground">
					<tr className="border-b">
						<th className="px-3 py-2 text-left font-medium">Kind</th>
						<th className="px-3 py-2 text-left font-medium">Template</th>
						<th className="px-3 py-2 text-right font-medium" title="lower wins">
							Priority
						</th>
						<th className="px-3 py-2 text-right font-medium">Max / week</th>
						<th className="px-3 py-2 text-left font-medium">When</th>
						<th className="px-3 py-2 text-left font-medium">Beats</th>
						<th className="px-3 py-2 text-left font-medium">On</th>
					</tr>
				</thead>
				<tbody>
					{names.map((name) => {
						const k = record[name] ?? {};
						const live = status.kinds.find((x) => x.kind === name);
						return (
							<tr key={name} className="border-b last:border-0">
								<td className="px-3 py-2 font-mono">
									{name}
									{live?.halted ? (
										<Badge variant="destructive" className="ml-2">
											stopped
										</Badge>
									) : null}
								</td>
								<td className="px-3 py-2 font-mono text-xs break-all">{k.template ?? <span className="font-sans text-muted-foreground">none (game supplies it)</span>}</td>
								<td className="px-3 py-2 text-right tabular-nums">{k.priority ?? "–"}</td>
								<td className="px-3 py-2 text-right tabular-nums">{k.perWeek ?? "–"}</td>
								<td className="px-3 py-2 text-xs">
									{k.send === "preferred_hour" ? "preferred hour" : (k.send ?? "asap")}
									{k.repeat ? `, ${k.repeat.replace("_", " ")}` : ""}
									{k.maxWaitHours ? `, waits up to ${k.maxWaitHours} h` : ""}
								</td>
								<td className="px-3 py-2 text-xs">{k.beats?.kinds?.length ? `${k.beats.kinds.join(", ")} within ${k.beats.withinHours ?? "?"} h` : "–"}</td>
								<td className="px-3 py-2">{live ? <OnOff label={`Kind ${name}`} value={live.enabled} disabled={busy} onChange={(v) => set(`notify.kinds.${name}.enabled`, v)} /> : <span className="text-xs text-muted-foreground">not pushed</span>}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function ConfigView({ query }: { query: ReturnType<typeof useConfigQuery> }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="space-y-2">
			<Button type="button" variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
				{open ? "Hide the pushed config" : "Show the pushed config"}
			</Button>
			{open ? (
				<QueryState query={query} loadingRows={2}>
					{(view) =>
						view.config ? (
							<div className="space-y-1">
								<p className="text-xs text-muted-foreground">
									Pushed {view.updatedAt ? fmtAgo(view.updatedAt) : "at an unknown time"}
									{view.by ? ` by ${view.by}` : ""}. Change it with <code className="font-mono">typetorch notify push</code>.
								</p>
								<JsonBlock value={view.config} />
							</div>
						) : (
							<EmptyState>
								No config pushed yet: run <code className="font-mono">typetorch notify push</code>.
							</EmptyState>
						)
					}
				</QueryState>
			) : null}
		</div>
	);
}

const useConfigQuery = () => useQuery({ queryKey: NOTIFY_CONFIG_KEY, queryFn: ({ signal }) => api.notifyConfig(signal), retry: false });

export function SettingsTab({ status }: { status: NotifyStatus }) {
	const config = useConfigQuery();
	return (
		<div className="space-y-4">
			<div className="grid items-start gap-4 xl:grid-cols-2">
				<Controls status={status} />
				<Section title="Send a test" description="Goes out now, outside the caps, marked test (counted under Test sends, not Sent). In dry run it is only logged.">
					<TestSend kinds={status.kinds.map((k) => ({ kind: k.kind, text: k.text }))} />
				</Section>
			</div>
			<Section
				title="Kinds"
				description={`From the pushed config record (read-only: typetorch notify push changes it); the switch is a runtime setting. ${fmtInt(status.kinds.length)} pushed.`}
			>
				<div className="space-y-3">
					<KindConfigTable status={status} config={config.data} />
					<ConfigView query={config} />
				</div>
			</Section>
		</div>
	);
}
