/** The "vs previous period" chip in a page's header (Overview, Errors, Performance); its state is `vs=prev` in the URL. */
import { ToggleChip } from "@/components/ToggleChip";
import { useCompare } from "@/lib/compare";

export function CompareToggle({ disabled, title }: { disabled?: boolean; title?: string }) {
	const [on, setOn] = useCompare();
	return (
		<ToggleChip pressed={on && !disabled} disabled={disabled} onClick={() => setOn(!on)} title={title ?? "Show the change against the period before, of the same length"}>
			vs previous period
		</ToggleChip>
	);
}
