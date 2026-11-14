/**
 * Recordings: new players' first-session recordings without Roblox Studio. Four tabs:
 *   Map layers   pick a map, toggle layers (path density, idle spots, deaths, screens, buttons, quits, positioned events),
 *                filter by values, zone and screen; click a cell for the sessions there
 *   Replay       a session list (also reached from a cell, a quit, the First session page's signals), then a top-down replay
 *   Quit autopsy the last seconds before quitting, classified, against the players who stayed
 *   First actions seconds from spawn to the first move, screen, button, prompt and round, by device and build
 * The tab, map, layers, view and session live in the URL next to the shared filters.
 */
import { ArrowLeft, Play } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Metric, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { ToggleChip } from "@/components/ToggleChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtInt, fmtNum, fmtPct, fmtTime, shortId } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { FirstActionSplit, FirstActionStat, QuitAutopsyRow, RecFrame, RecSampling, RecordingLayersResult } from "@/lib/types";
import { MapView, type ToView } from "./recordings/MapView";
import { ACTION_LABELS, NO_MAP, REASON_LABELS, RECORDING_LAYERS, cellBox, layerColor, layerName, mapName } from "./recordings/map";
import { ReplayPlayer } from "./recordings/ReplayPlayer";

const TABS = ["layers", "replay", "autopsy", "first"] as const;
type Tab = (typeof TABS)[number];
export const DEFAULT_LAYERS = ["path", "quit"];

/** Page URL parameters (kept next to the filter bar's). */
function usePageParams() {
	const [params, setParams] = useSearchParams();
	const set = useCallback(
		(patch: Record<string, string | null | undefined>) =>
			setParams((current) => {
				const copy = new URLSearchParams(current);
				for (const [k, v] of Object.entries(patch)) {
					if (v) copy.set(k, v);
					else copy.delete(k);
				}
				return copy;
			}),
		[setParams],
	);
	return [params, set] as const;
}

function SamplingNote({ sampling, notes = [] }: { sampling: RecSampling; notes?: string[] }) {
	const lines = [...notes];
	if (sampling.sampled && !notes.some((n) => n.startsWith("Sampled"))) lines.push(`Sampled ${fmtInt(sampling.used)} of ${fmtInt(sampling.recorded)} recorded sessions.`);
	if (sampling.failed) lines.push(`${fmtInt(sampling.failed)} sessions did not decode.`);
	if (sampling.eventsCapped) lines.push("Some sessions' events hit a row cap: zone, screen and tutorial details may be missing for them.");
	if (!lines.length) return null;
	return (
		<ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="sampling-note">
			{lines.map((l) => (
				<li key={l}>{l}</li>
			))}
		</ul>
	);
}

// Map layers --------------------------------------------------------------------------------------------------------------

/** The layer toggles, value chips and filters. Pure props: the page owns the state (tests drive it directly). */
export function LayerControls({
	data,
	active,
	onToggle,
	values,
	onValues,
	split,
	onSplit,
}: {
	data: Pick<RecordingLayersResult, "layers" | "catalog">;
	active: string[];
	onToggle: (id: string) => void;
	values: Record<string, string[]>;
	onValues: (id: string, values: string[]) => void;
	split: Record<string, string>;
	onSplit: (id: string, key: string) => void;
}) {
	const positioned = data.catalog.map((c) => ({ id: `ev:${c.kind}:${c.name}`, count: c.count }));
	const all = [...RECORDING_LAYERS.map((id) => ({ id, count: undefined as number | undefined })), ...positioned];
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-1.5" role="group" aria-label="Layers">
				{all.map(({ id, count }, i) => {
					const shown = data.layers.find((l) => l.id === id);
					return (
						<ToggleChip key={id} pressed={active.includes(id)} onClick={() => onToggle(id)} title={id}>
							<span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: layerColor(id, i - RECORDING_LAYERS.length) }} />
							{layerName(id)}
							{shown ? <span className="tabular-nums opacity-80">{fmtInt(shown.count)}</span> : count !== undefined ? <span className="tabular-nums opacity-60">{fmtInt(count)}</span> : null}
						</ToggleChip>
					);
				})}
			</div>
			{positioned.length === 0 ? <p className="text-xs text-muted-foreground">No positioned events (props px / pz) in this range.</p> : null}
			{data.layers
				.filter((l) => active.includes(l.id) && (l.values.length > 0 || l.source === "events"))
				.map((l) => {
					const picked = values[l.id] ?? [];
					return (
						<div key={l.id} className="space-y-1" data-testid={`values-${l.id}`}>
							<div className="flex flex-wrap items-center gap-2 text-xs font-medium">
								{layerName(l.id)}
								{l.source === "events" ? (
									<SplitInput value={split[l.id] ?? ""} onChange={(key) => onSplit(l.id, key)} label={`Split ${layerName(l.id)} by a prop`} />
								) : null}
								{picked.length ? (
									<button type="button" className="text-muted-foreground underline" onClick={() => onValues(l.id, [])}>
										show all
									</button>
								) : null}
							</div>
							<div className="flex flex-wrap gap-1">
								{l.values.slice(0, 16).map((v) => (
									<ToggleChip
										key={v.value}
										pressed={picked.includes(v.value)}
										className="h-6 text-xs"
										onClick={() => onValues(l.id, picked.includes(v.value) ? picked.filter((x) => x !== v.value) : [...picked, v.value])}
									>
										{v.value} <span className="tabular-nums opacity-70">{fmtInt(v.count)}</span>
									</ToggleChip>
								))}
							</div>
						</div>
					);
				})}
		</div>
	);
}

function SplitInput({ value, onChange, label }: { value: string; onChange: (key: string) => void; label: string }) {
	const [text, setText] = useState(value);
	const apply = () => text.trim() !== value && onChange(text.trim());
	return (
		<Input
			aria-label={label}
			placeholder="split by prop, e.g. cause"
			className="h-6 w-48 text-xs"
			value={text}
			onChange={(e) => setText(e.target.value)}
			onBlur={apply}
			onKeyDown={(e) => e.key === "Enter" && apply()}
		/>
	);
}

function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
	const [text, setText] = useState(value);
	const apply = () => text.trim() !== value && onChange(text.trim());
	return (
		<Input aria-label={label} placeholder={label} className="h-7 w-36 text-xs" value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === "Enter" && apply()} />
	);
}

function pick<T>(record: Record<string, T>, keys: readonly string[], keep: (v: T) => boolean): Record<string, T> {
	return Object.fromEntries(Object.entries(record).filter(([k, v]) => keys.includes(k) && keep(v)));
}

function LayersTab({ openReplay }: { openReplay: (sid: string) => void }) {
	const [params, set] = usePageParams();
	const map = params.get("map") ?? undefined;
	const rawLayers = params.get("layers") ?? DEFAULT_LAYERS.join(",");
	const active = rawLayers === "none" ? [] : rawLayers.split(",").filter(Boolean);
	const view = params.get("view") === "dots" ? "dots" : "heat";
	const [values, setValues] = useState<Record<string, string[]>>({});
	const [split, setSplit] = useState<Record<string, string>>({});
	const [zone, setZone] = useState("");
	const [screen, setScreen] = useState("");
	const [cell, setCell] = useState<[number, number] | null>(null);
	const options = useMemo(
		() => ({
			...(map !== undefined ? { map } : {}),
			layers: active,
			values: pick(values, active, (v) => v.length > 0),
			split: pick(split, active.filter((id) => id.startsWith("ev:")), (v) => v !== ""),
			...(zone ? { zone } : {}),
			...(screen ? { screen } : {}),
		}),
		[map, active.join(","), values, split, zone, screen],
	);
	const q = useAnalytics("recording-layers", options, { keepPrevious: true });
	const toggle = (id: string) => set({ layers: (active.includes(id) ? active.filter((x) => x !== id) : [...active, id]).join(",") || "none" });
	return (
		<QueryState query={q} isEmpty={(d) => d.sampling.recorded === 0 && d.catalog.length === 0} empty="No recorded first sessions or positioned events in this range.">
			{(data) => {
				const frame = data.frame;
				const drawn = data.layers.map((l, i) => ({ id: l.id, label: layerName(l.id), color: layerColor(l.id, i), cells: l.cells }));
				const cellLayer = active.find((id) => (RECORDING_LAYERS as readonly string[]).includes(id) && id !== "path") ?? "path";
				const box = frame && cell ? cellBox(frame, cell[0], cell[1]) : null;
				return (
					<div className="space-y-4">
						<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Maps">
							{data.maps.map((m) => (
								<ToggleChip
									key={m.map}
									pressed={data.map === m.map}
									onClick={() => {
										setCell(null);
										set({ map: m.map });
									}}
								>
									{mapName(m.map)} <span className="tabular-nums opacity-70">{fmtInt(m.sessions)}</span>
								</ToggleChip>
							))}
						</div>
						<LayerControls
							data={data}
							active={active}
							onToggle={toggle}
							values={values}
							onValues={(id, v) => setValues({ ...values, [id]: v })}
							split={split}
							onSplit={(id, key) => {
								setSplit({ ...split, [id]: key });
								setValues({ ...values, [id]: [] });
							}}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<FilterInput label="Zone" value={zone} onChange={setZone} />
							<FilterInput label="Screen" value={screen} onChange={setScreen} />
							<div className="ml-auto flex gap-1" role="group" aria-label="View">
								<ToggleChip pressed={view === "heat"} onClick={() => set({ view: null })}>
									Heatmap
								</ToggleChip>
								<ToggleChip pressed={view === "dots"} onClick={() => set({ view: "dots" })}>
									Dots
								</ToggleChip>
							</div>
						</div>
						<SamplingNote sampling={data.sampling} notes={data.notes} />
						{frame ? (
							<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
								<div className="min-w-0 space-y-1">
									<MapView
										frame={frame}
										background={data.background}
										layers={drawn}
										mode={view}
										selected={cell}
										onCellClick={(c, r) => setCell([c, r])}
										label={`Map ${mapName(data.map ?? "")}`}
									/>
									<p className="text-xs text-muted-foreground">
										Top-down: x to the right, z down; one cell is {fmtNum(frame.cell, 0)} studs. The grey silhouette is every recorded position on this map. Click a cell for its sessions.
									</p>
								</div>
								<div className="space-y-3">
									<Legend layers={data.layers} />
									{box ? (
										<Section title="Sessions in this cell" description={`With a ${layerName(cellLayer).toLowerCase()} point at x ${box[0]} to ${box[2]}, z ${box[1]} to ${box[3]}.`}>
											<SessionList options={{ map: data.map, box, layer: cellLayer, limit: 20 }} openReplay={openReplay} compact />
										</Section>
									) : null}
								</div>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">Nothing to draw on this map.</p>
						)}
					</div>
				);
			}}
		</QueryState>
	);
}

function Legend({ layers }: { layers: RecordingLayersResult["layers"] }) {
	if (!layers.length) return null;
	return (
		<ul className="space-y-1 text-sm" aria-label="Legend">
			{layers.map((l, i) => (
				<li key={l.id} className="flex items-center gap-2">
					<span aria-hidden className="inline-block size-3 shrink-0 rounded-sm" style={{ background: layerColor(l.id, i) }} />
					<span className="min-w-0 flex-1 truncate">{layerName(l.id)}</span>
					<span className="tabular-nums">{fmtInt(l.count)}</span>
					{l.sessions ? <span className="text-xs tabular-nums text-muted-foreground">{fmtInt(l.sessions)} sessions</span> : null}
					{l.cellsCut ? <span className="text-xs text-muted-foreground">({fmtInt(l.cellsCut)} small cells left out)</span> : null}
				</li>
			))}
		</ul>
	);
}

// Sessions and replay ---------------------------------------------------------------------------------------------------

export function SessionList({ options, openReplay, compact = false }: { options: Record<string, unknown>; openReplay: (sid: string) => void; compact?: boolean }) {
	const q = useAnalytics("recording-sessions", options, { keepPrevious: true });
	return (
		<QueryState query={q} isEmpty={(d) => d.total === 0} empty="No recorded sessions match.">
			{(data) => (
				<div className="space-y-2">
					<p className="text-xs text-muted-foreground">
						{fmtInt(data.total)} sessions{data.total > data.sessions.length ? `, the latest ${data.sessions.length} shown` : ""}.
					</p>
					<SamplingNote sampling={data.sampling} />
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Session</TableHead>
								{compact ? null : <TableHead>Started</TableHead>}
								<TableHead className="text-right">Length</TableHead>
								{compact ? null : <TableHead>Device</TableHead>}
								<TableHead>Ended</TableHead>
								{compact ? null : <TableHead>Maps</TableHead>}
								{compact ? null : <TableHead>Signals</TableHead>}
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.sessions.map((s) => (
								<TableRow key={s.sid}>
									<TableCell className="font-mono text-xs">{shortId(s.sid)}</TableCell>
									{compact ? null : <TableCell className="text-xs">{fmtTime(s.start)}</TableCell>}
									<TableCell className="text-right tabular-nums">{fmtNum(s.seconds, 0)} s</TableCell>
									{compact ? null : <TableCell>{s.dev}</TableCell>}
									<TableCell>{s.why === "left" ? <Badge variant="destructive">left</Badge> : (s.why ?? "unknown")}</TableCell>
									{compact ? null : <TableCell className="text-xs">{s.maps.map(mapName).join(", ")}</TableCell>}
									{compact ? null : (
										<TableCell className="text-xs">
											{[s.signals.idle ? `idle ${s.signals.idle}` : "", s.signals.camera_spin ? `spin ${s.signals.camera_spin}` : "", s.signals.repeated_clicks ? `clicks ${s.signals.repeated_clicks}` : ""].filter(Boolean).join(", ")}
										</TableCell>
									)}
									<TableCell className="text-right">
										<Button type="button" size="sm" variant="outline" onClick={() => openReplay(s.sid)} aria-label={`Replay ${s.sid}`}>
											<Play /> Replay
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</QueryState>
	);
}

/** The replay's map: the map layer's frame and silhouette when the session fits in it, else the session's own frame. */
function ReplayMap({ map, overlay, fallback }: { map: string; overlay: (toView: ToView) => ReactNode; fallback: RecFrame | null }) {
	const q = useAnalytics("recording-layers", { map, layers: [] });
	const shared = q.data?.map === map ? q.data.frame : null;
	const fits = shared && fallback && fallback.minX >= shared.minX - shared.cell && fallback.maxX <= shared.maxX + shared.cell && fallback.minZ >= shared.minZ - shared.cell && fallback.maxZ <= shared.maxZ + shared.cell;
	const frame = fits ? shared : fallback;
	if (!frame) return <p className="text-sm text-muted-foreground">No positions on this map.</p>;
	return <MapView frame={frame} background={fits ? (q.data?.background ?? []) : []} overlay={overlay} label={`Replay on ${mapName(map)}`} />;
}

const WHY_CHOICES = [
	{ value: "", label: "All" },
	{ value: "left", label: "Quit" },
	{ value: "window", label: "Played on" },
];

function ReplayTab({ openReplay }: { openReplay: (sid: string) => void }) {
	const [params, set] = usePageParams();
	const sid = params.get("sid");
	if (sid) return <ReplayView sid={sid} back={() => set({ sid: null })} />;
	const why = params.get("why") ?? "";
	const signal = params.get("signal") ?? undefined;
	const zone = params.get("zone") ?? undefined;
	const target = params.get("target") ?? undefined;
	const search = params.get("q") ?? undefined;
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex gap-1" role="group" aria-label="How it ended">
					{WHY_CHOICES.map((c) => (
						<ToggleChip key={c.label} pressed={why === c.value} onClick={() => set({ why: c.value })}>
							{c.label}
						</ToggleChip>
					))}
				</div>
				<FilterInput label="Session or player id" value={search ?? ""} onChange={(v) => set({ q: v })} />
				{signal ? (
					<Badge variant="secondary" className="gap-1">
						{signal.replace("_", " ")}
						{zone ? ` in ${zone}` : ""}
						{target ? ` on ${target}` : ""}
						<button type="button" aria-label="Clear the signal filter" onClick={() => set({ signal: null, zone: null, target: null })}>
							×
						</button>
					</Badge>
				) : null}
			</div>
			<SessionList options={{ ...(why ? { why } : {}), ...(signal ? { signal } : {}), ...(zone ? { zone } : {}), ...(target ? { target } : {}), ...(search ? { search } : {}), limit: 100 }} openReplay={openReplay} />
		</div>
	);
}

function ReplayView({ sid, back }: { sid: string; back: () => void }) {
	const q = useAnalytics("recording-replay", { sid });
	return (
		<div className="space-y-3">
			<Button type="button" size="sm" variant="ghost" onClick={back}>
				<ArrowLeft /> All sessions
			</Button>
			<QueryState query={q} isEmpty={(d) => !d.found} empty="This session has no recording in the selected range (widen the date range).">
				{(data) =>
					data.failed ? (
						<p className="text-sm text-muted-foreground">The recording did not decode: {data.failed}</p>
					) : (
						<Section title={`Session ${shortId(data.sid)}`} description={`Player ${data.pid ?? "?"}, ${fmtTime(data.start ?? 0)}, ${fmtNum((data.duration ?? 0) / 1000, 1)} s recorded.`}>
							<ReplayPlayer key={data.sid} replay={data} renderMap={(map, overlay, fallback) => <ReplayMap map={map} overlay={overlay} fallback={fallback} />} />
						</Section>
					)
				}
			</QueryState>
		</div>
	);
}

// Quit autopsy ----------------------------------------------------------------------------------------------------------

export function reasonLabel(row: Pick<QuitAutopsyRow, "reason" | "value">): string {
	if (row.value === undefined) return REASON_LABELS[row.reason] ?? row.reason;
	return row.value;
}

function Lift({ lift }: { lift: number | null }) {
	if (lift === null) return <Badge variant="destructive">only quitters</Badge>;
	return <span className={lift >= 1.5 ? "font-semibold text-red-600 dark:text-red-400" : lift < 1 ? "text-muted-foreground" : undefined}>{fmtNum(lift, 1)}x</span>;
}

function AutopsyTable({ rows, openReplay, caption }: { rows: QuitAutopsyRow[]; openReplay: (sid: string) => void; caption: string }) {
	return (
		<Table aria-label={caption}>
			<TableHeader>
				<TableRow>
					<TableHead>{caption}</TableHead>
					<TableHead className="text-right">Quitters</TableHead>
					<TableHead className="w-40">Share of quitters</TableHead>
					<TableHead className="text-right">Of the others</TableHead>
					<TableHead className="text-right">Lift</TableHead>
					<TableHead>Examples</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((r) => (
					<TableRow key={`${r.reason}-${r.value ?? ""}`}>
						<TableCell className="whitespace-normal">{reasonLabel(r)}</TableCell>
						<TableCell className="text-right tabular-nums">{fmtInt(r.left)}</TableCell>
						<TableCell>
							<div className="flex items-center gap-2">
								<ShareBar share={r.leftShare} className="w-20" tone={(r.lift ?? 99) >= 1.5 ? "alert" : "default"} />
								<span className="tabular-nums">{fmtPct(r.leftShare)}</span>
							</div>
						</TableCell>
						<TableCell className="text-right tabular-nums">{fmtPct(r.stayedShare)}</TableCell>
						<TableCell className="text-right tabular-nums">
							<Lift lift={r.lift} />
						</TableCell>
						<TableCell>
							<div className="flex flex-wrap gap-1">
								{r.examples.map((sid) => (
									<button key={sid} type="button" className="font-mono text-xs underline" onClick={() => openReplay(sid)} aria-label={`Replay ${sid}`}>
										{shortId(sid, 6)}
									</button>
								))}
							</div>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

const WINDOWS = [5, 10, 20, 30];

function AutopsyTab({ openReplay }: { openReplay: (sid: string) => void }) {
	const [params, set] = usePageParams();
	const windowSeconds = WINDOWS.includes(Number(params.get("win"))) ? Number(params.get("win")) : 10;
	const q = useAnalytics("quit-autopsy", { windowSeconds }, { keepPrevious: true });
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				Last
				<div className="flex gap-1" role="group" aria-label="Seconds before quitting">
					{WINDOWS.map((w) => (
						<ToggleChip key={w} pressed={windowSeconds === w} onClick={() => set({ win: w === 10 ? null : String(w) })}>
							{w} s
						</ToggleChip>
					))}
				</div>
				before the recording ended
			</div>
			<QueryState query={q} isEmpty={(d) => d.left + d.stayed === 0} empty="No recorded first sessions in this range.">
				{(data) => {
					const main = data.rows.filter((r) => r.value === undefined && r.reason !== "place");
					const by = (reason: string) => data.rows.filter((r) => r.reason === reason && r.value !== undefined);
					return (
						<div className="space-y-4">
							<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
								<Metric label="Quit in their first minute" value={fmtInt(data.left)} sub={`${fmtPct(data.left / Math.max(1, data.left + data.stayed))} of recordings`} />
								<Metric label="Played on" value={fmtInt(data.stayed)} sub="the comparison" />
								<Metric label="Recordings" value={fmtInt(data.left + data.stayed)} sub={data.byWhy.map((w) => `${w.why} ${fmtInt(w.sessions)}`).join(", ")} />
							</div>
							<SamplingNote sampling={data.sampling} />
							<Section
								title="What the last seconds looked like"
								description={`Each quit can have several reasons. "Of the others": the same over the last ${data.windowSeconds} s of the recordings that didn't end with a quit (their 60 s window ran out). Lift over 1 = more common among quitters.`}
							>
								<AutopsyTable rows={main} openReplay={openReplay} caption="Reason" />
							</Section>
							<div className="grid gap-4 xl:grid-cols-2">
								{by("screen").length ? (
									<Section title="Screen open when they quit">
										<AutopsyTable rows={by("screen")} openReplay={openReplay} caption="Screen" />
									</Section>
								) : null}
								{by("tutorial").length ? (
									<Section title="Tutorial step they stopped at">
										<AutopsyTable rows={by("tutorial")} openReplay={openReplay} caption="Step" />
									</Section>
								) : null}
								{by("place").length ? (
									<Section title="Where they stood" description="Each map split into 6 x 6 parts (columns A-F left to right, rows 1-6 top to bottom).">
										<AutopsyTable rows={by("place")} openReplay={openReplay} caption="Map part" />
									</Section>
								) : null}
							</div>
						</div>
					);
				}}
			</QueryState>
		</div>
	);
}

// First actions -------------------------------------------------------------------------------------------------------

function Histogram({ stat }: { stat: FirstActionStat }) {
	const max = Math.max(1, ...stat.histogram.map((h) => h.count));
	return (
		<div className="flex h-8 items-end gap-0.5" aria-label={`${ACTION_LABELS[stat.action]} distribution`}>
			{stat.histogram.map((h) => (
				<div key={h.label} title={`${h.label}: ${h.count}`} className="w-3 rounded-sm bg-primary/70" style={{ height: `${Math.max(h.count ? 8 : 2, (h.count / max) * 100)}%` }} />
			))}
		</div>
	);
}

const sec = (v: number | null) => (v === null ? "-" : `${fmtNum(v, 1)} s`);

function SplitTable({ title, rows }: { title: string; rows: FirstActionSplit[] }) {
	const actions = rows[0]?.stats.map((s) => s.action) ?? [];
	return (
		<Table aria-label={title}>
			<TableHeader>
				<TableRow>
					<TableHead>{title}</TableHead>
					<TableHead className="text-right">Sessions</TableHead>
					{actions.map((a) => (
						<TableHead key={a} className="text-right">
							{ACTION_LABELS[a]?.replace("First ", "") ?? a}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((r) => (
					<TableRow key={r.value}>
						<TableCell className="font-mono text-xs">{r.value}</TableCell>
						<TableCell className="text-right tabular-nums">{fmtInt(r.sessions)}</TableCell>
						{r.stats.map((s) => (
							<TableCell key={s.action} className="text-right tabular-nums" title={`${fmtPct(s.share)} reached it`}>
								{sec(s.median)} <span className="text-xs text-muted-foreground">{fmtPct(s.share, 0)}</span>
							</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function FirstActionsTab() {
	const q = useAnalytics("first-action");
	return (
		<QueryState query={q} isEmpty={(d) => d.sessions === 0} empty="No recorded first sessions in this range.">
			{(data) => (
				<div className="space-y-4">
					<SamplingNote sampling={data.sampling} />
					<Section
						title="Seconds from spawn"
						description="Move = 3 studs from the spawn point. A screen counts when it opens just after a player input (not HUDs the game opens). Move, screen, button and prompt are only seen inside the recording (until 60 s after the first input); round start comes from the events."
					>
						<Table aria-label="Time to first action">
							<TableHeader>
								<TableRow>
									<TableHead>Action</TableHead>
									<TableHead className="text-right">Reached</TableHead>
									<TableHead className="text-right">Median</TableHead>
									<TableHead className="text-right">Middle half</TableHead>
									<TableHead>Distribution (&lt;1 s ... 2 min+)</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.stats.map((s) => (
									<TableRow key={s.action}>
										<TableCell>{ACTION_LABELS[s.action] ?? s.action}</TableCell>
										<TableCell className="text-right tabular-nums">
											{fmtInt(s.reached)} <span className="text-xs text-muted-foreground">{fmtPct(s.share)}</span>
										</TableCell>
										<TableCell className="text-right font-medium tabular-nums">{sec(s.median)}</TableCell>
										<TableCell className="text-right tabular-nums">{s.p25 === null ? "-" : `${fmtNum(s.p25, 1)}-${fmtNum(s.p75, 1)} s`}</TableCell>
										<TableCell>
											<Histogram stat={s} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Section>
					<div className="grid gap-4 xl:grid-cols-2">
						<Section title="By build" description="Median seconds, and the share that reached it. Did a new tutorial make players act sooner?">
							<SplitTable title="Build" rows={data.byBuild} />
						</Section>
						<Section title="By device">
							<SplitTable title="Device" rows={data.byDevice} />
						</Section>
					</div>
				</div>
			)}
		</QueryState>
	);
}

// The page ---------------------------------------------------------------------------------------------------------------

export default function Recordings() {
	const [params, set] = usePageParams();
	const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "layers";
	const openReplay = useCallback((sid: string) => set({ tab: "replay", sid }), [set]);
	return (
		<>
			<PageHeader title="Recordings" description="New players' first sessions, recorded from spawn until a minute after their first input: where they went, a replay, why they quit, how soon they acted." />
			<Tabs value={tab} onValueChange={(v) => set({ tab: v === "layers" ? null : v })}>
				<TabsList>
					<TabsTrigger value="layers">Map layers</TabsTrigger>
					<TabsTrigger value="replay">Replay</TabsTrigger>
					<TabsTrigger value="autopsy">Quit autopsy</TabsTrigger>
					<TabsTrigger value="first">First actions</TabsTrigger>
				</TabsList>
				<TabsContent value="layers">{tab === "layers" ? <LayersTab openReplay={openReplay} /> : null}</TabsContent>
				<TabsContent value="replay">{tab === "replay" ? <ReplayTab openReplay={openReplay} /> : null}</TabsContent>
				<TabsContent value="autopsy">{tab === "autopsy" ? <AutopsyTab openReplay={openReplay} /> : null}</TabsContent>
				<TabsContent value="first">{tab === "first" ? <FirstActionsTab /> : null}</TabsContent>
			</Tabs>
		</>
	);
}

export { NO_MAP };
