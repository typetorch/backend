/**
 * Plans/34: the server page's Game tab. "Game commands": a button per command the game declared (op `game.<name>`, one
 * audited command each, like the kernel's ops), labelled game-defined (read-only is the game's promise: the kernel can't
 * check it); answers draw as a table (`{ kind: "table", columns, rows }`), key-value pairs (`{ kind: "kv", items }`) or
 * JSON. "Streams": the latest value of each stream (the built-in positions, the game's own), polled about every second.
 * Answers and frames stay in this page's memory only.
 */
import { useState } from "react";
import { EmptyState, JsonBlock, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/lib/format";
import { latestValue } from "@/lib/live-map";
import { useRemote } from "@/lib/remote-debug";
import type { StreamsState } from "@/lib/live-streams";
import type { GameCommand, GameStream, LivePlayer, StreamPoint } from "@/lib/types";
import { RemoteBar, useDebug } from "./shared";

export const GAME_DEFINED_TEXT = "Game-defined: the game promises these are read-only; the kernel can't check it.";
export const NO_DECLARATIONS_TEXT = "This server's game declares no commands or streams (framework 0.8.0+ with kernel 0.6.0: fleet.command / fleet.stream).";

const cellText = (v: unknown) => (v === null || v === undefined ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A command's answer: a table, key-value pairs, or JSON. */
export function GameAnswer({ value }: { value: unknown }) {
	const v = value as { kind?: unknown; columns?: unknown; rows?: unknown; items?: unknown } | null;
	if (v && v.kind === "table" && Array.isArray(v.columns) && Array.isArray(v.rows)) {
		const columns = v.columns.map(cellText);
		return (
			<div className="max-h-[60vh] overflow-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							{columns.map((c, i) => (
								<TableHead key={`${c}-${i}`}>{c}</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{v.rows.map((row, r) => (
							<TableRow key={r}>
								{(Array.isArray(row) ? row : [row]).map((cell, c) => (
									<TableCell key={c} className={typeof cell === "number" ? "text-right tabular-nums" : undefined}>
										{cellText(cell)}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		);
	}
	if (v && v.kind === "kv" && typeof v.items === "object" && v.items !== null && !Array.isArray(v.items)) {
		return (
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
				{Object.entries(v.items as Record<string, unknown>).map(([k, item]) => (
					<div key={k} className="contents">
						<dt className="text-muted-foreground">{k}</dt>
						<dd className="font-mono text-xs break-all">{cellText(item)}</dd>
					</div>
				))}
			</dl>
		);
	}
	return <JsonBlock value={value} />;
}

/** One declared command: its button, optional JSON args, its last answer. */
function CommandRow({ command }: { command: GameCommand }) {
	const { call } = useDebug();
	const remote = useRemote<unknown>(call, `game.${command.n}`);
	const [args, setArgs] = useState("");
	const [argsError, setArgsError] = useState<string | null>(null);
	const run = () => {
		let parsed: Record<string, unknown> | undefined;
		if (args.trim()) {
			try {
				const value = JSON.parse(args);
				if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
				parsed = value as Record<string, unknown>;
			} catch {
				setArgsError("Args must be a JSON object, e.g. {\"team\": \"red\"}.");
				return;
			}
		}
		setArgsError(null);
		void remote.run(parsed);
	};
	return (
		<div className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0" data-testid={`game-command-${command.n}`}>
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="font-medium">{command.l ?? command.n}</span>
				<code className="text-xs text-muted-foreground">game.{command.n}</code>
				<Badge variant="outline" title={GAME_DEFINED_TEXT}>
					game-defined
				</Badge>
			</div>
			{command.d ? <p className="text-sm text-muted-foreground">{command.d}</p> : null}
			<RemoteBar state={remote} onFetch={run} label="Run">
				<Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="args (JSON, optional)" aria-label={`Args for ${command.l ?? command.n}`} className="h-8 w-56 font-mono text-xs" />
			</RemoteBar>
			{argsError ? (
				<p role="alert" className="text-sm text-destructive">
					{argsError}
				</p>
			) : null}
			{remote.data !== undefined ? <GameAnswer value={remote.data} /> : null}
		</div>
	);
}

function PositionsPanel({ players }: { players: LivePlayer[] }) {
	if (!players.length) return <p className="text-sm text-muted-foreground">Nobody in the server.</p>;
	return (
		<div className="max-h-80 overflow-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Player</TableHead>
						<TableHead>State</TableHead>
						<TableHead className="text-right">x</TableHead>
						<TableHead className="text-right">y</TableHead>
						<TableHead className="text-right">z</TableHead>
						<TableHead className="text-right">HP</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{players.map((p) => (
						<TableRow key={p.u}>
							<TableCell>{p.n}</TableCell>
							<TableCell>{p.st}</TableCell>
							{[p.x, p.y, p.z, p.hp].map((v, i) => (
								<TableCell key={i} className="text-right tabular-nums">
									{v === undefined ? "–" : v.toFixed(1)}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function StreamPanel({ stream, value, at }: { stream: GameStream; value: unknown; at?: number }) {
	const points = stream.k === "points" ? (value as { points?: StreamPoint[] } | undefined)?.points : undefined;
	return (
		<div className="space-y-1.5" data-testid={`game-stream-${stream.n}`}>
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="font-medium">{stream.l ?? stream.n}</span>
				<code className="text-xs text-muted-foreground">game.{stream.n}</code>
				<span className="text-xs text-muted-foreground">
					{stream.hz} Hz{stream.k === "points" ? ", points (drawn on the Live map)" : ""}
					{at !== undefined ? ` · ${fmtTime(at).slice(11)} UTC` : ""}
				</span>
			</div>
			{value === undefined ? (
				<p className="text-sm text-muted-foreground">No sample yet.</p>
			) : points ? (
				<p className="text-sm">
					{points.length} point{points.length === 1 ? "" : "s"}
					{points.some((p) => p.label) ? `: ${points.filter((p) => p.label).slice(0, 12).map((p) => p.label).join(", ")}` : ""}
				</p>
			) : (
				<JsonBlock value={value} className="max-h-64" />
			)}
		</div>
	);
}

export function GameTab({ streams }: { streams: StreamsState }) {
	const declared = streams.declared;
	const positions = latestValue(streams.frames, "positions");
	const players = (positions?.value as { players?: LivePlayer[] } | undefined)?.players ?? [];
	if (!streams.loaded) return <p className="text-sm text-muted-foreground">Reading what this server's game declared...</p>;
	return (
		<div className="space-y-4">
			{streams.error ? (
				<p role="alert" className="text-sm text-destructive">
					{streams.error}
				</p>
			) : null}
			<Section title="Game commands" description={GAME_DEFINED_TEXT}>
				{declared?.commands.length ? (
					<div className="space-y-3">
						{declared.commands.map((c) => (
							<CommandRow key={c.n} command={c} />
						))}
					</div>
				) : (
					<EmptyState>{NO_DECLARATIONS_TEXT}</EmptyState>
				)}
			</Section>
			<Section title="Streams" description="The latest samples while this page is open (the kernel posts them every second; kept 2 minutes, in memory only).">
				<div className="space-y-4">
					<div className="space-y-1.5">
						<div className="flex flex-wrap items-baseline gap-2">
							<span className="font-medium">Positions</span>
							<code className="text-xs text-muted-foreground">positions</code>
							<span className="text-xs text-muted-foreground">2 Hz, built in{positions ? ` · ${fmtTime(positions.t).slice(11)} UTC` : ""}</span>
						</div>
						{positions ? <PositionsPanel players={players} /> : <p className="text-sm text-muted-foreground">No sample yet (kernel 0.6.0+ sends them while this page is open).</p>}
					</div>
					{(declared?.streams ?? []).map((s) => {
						const latest = latestValue(streams.frames, `game.${s.n}`);
						return <StreamPanel key={s.n} stream={s} value={latest?.value} {...(latest ? { at: latest.t } : {})} />;
					})}
				</div>
			</Section>
		</div>
	);
}
