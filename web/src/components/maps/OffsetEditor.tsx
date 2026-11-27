/**
 * An exported map's offset override, inline (the live map, so owners line a map up with the dots without leaving it).
 * Typing previews the offset at once (`onPreview`: the scene moves, nothing is saved); Save stores it (PUT
 * /v1/maps/<name>/override, keeping a round map's model path), Reset drops the unsaved values, Remove deletes the override.
 * The lobby takes an offset only (the backend refuses a path for it).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isReadOnly, useAuth } from "@/lib/auth";
import { MAPS_KEY, mapsApi, type MapInfo, type Vec3 } from "@/lib/maps";

/** Whether this session may set overrides: an owner (the maps list's canExport), not a read-only session. */
export function useCanEditMaps(): boolean {
	const auth = useAuth();
	const list = useQuery({ queryKey: MAPS_KEY, queryFn: ({ signal }) => mapsApi.list(signal), retry: false, staleTime: 60_000 });
	return Boolean(list.data?.canExport) && !isReadOnly(auth);
}

const AXES = ["x", "y", "z"] as const;

/** The draft as an offset, or null when a field isn't a number. */
function parse(draft: readonly string[]): Vec3 | null {
	const v = draft.map((s) => (s.trim() === "" ? Number.NaN : Number(s)));
	return v.every((n) => Number.isFinite(n)) ? (v as Vec3) : null;
}

export function OffsetEditor({ map, onPreview }: { map: MapInfo; onPreview: (offset: Vec3 | null) => void }) {
	const client = useQueryClient();
	const [draft, setDraft] = useState<string[]>(() => map.offset.map(String));
	const parsed = parse(draft);
	const dirty = parsed !== null && parsed.some((v, i) => v !== map.offset[i]);
	// The preview follows the draft; a saved or reset draft previews nothing (the map's own offset is drawn).
	useEffect(() => {
		onPreview(dirty ? parsed : null);
	}, [dirty, parsed?.join(",")]);
	useEffect(() => () => onPreview(null), []);

	const done = () => client.invalidateQueries({ queryKey: MAPS_KEY });
	const save = useMutation({
		mutationFn: (offset: Vec3) => mapsApi.setOverride(map.name, { offset, ...(path ? { path } : {}) }),
		onSuccess: done,
	});
	const path = map.kind === "map" ? map.override?.path : undefined;
	// Clearing the offset keeps a model path (the override then holds the path only).
	const remove = useMutation({ mutationFn: () => (path ? mapsApi.setOverride(map.name, { path }) : mapsApi.removeOverride(map.name)), onSuccess: done });
	const zero = parsed !== null && parsed.every((v) => v === 0);
	// An all-zero offset is no offset: Save clears it.
	const submit = () => {
		if (!parsed) return;
		if (zero) {
			if (map.override?.offset) remove.mutate();
			return;
		}
		save.mutate(parsed);
	};
	const busy = save.isPending || remove.isPending;
	const error = (save.error ?? remove.error) as Error | null;

	return (
		<form
			className="flex flex-wrap items-center gap-1.5 text-xs"
			aria-label="Map offset"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<span className="font-medium text-muted-foreground">Offset</span>
			{AXES.map((axis, i) => (
				<label key={axis} className="flex items-center gap-1">
					<span className="text-muted-foreground">{axis}</span>
					<Input
						type="number"
						step={1}
						value={draft[i]}
						onChange={(e) => setDraft((d) => d.map((v, k) => (k === i ? e.target.value : v)))}
						aria-label={`Offset ${axis}`}
						className="h-7 w-20 px-1.5 text-xs tabular-nums"
					/>
				</label>
			))}
			<Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={busy || !parsed || !dirty}>
				Save
			</Button>
			{dirty ? (
				<Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDraft(map.offset.map(String))}>
					Reset
				</Button>
			) : null}
			{map.override?.offset && !dirty ? (
				<Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => remove.mutate()}>
					Remove
				</Button>
			) : null}
			<span className="text-muted-foreground" role="status">
				{busy ? "Saving…" : dirty ? "Previewing, not saved" : map.offset.some((v) => v !== 0) ? "Saved" : ""}
			</span>
			{error ? <span className="text-destructive">{error.message}</span> : null}
		</form>
	);
}
