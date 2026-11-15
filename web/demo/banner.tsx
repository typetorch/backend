/**
 * The slim strip above the explorer: what this is, Reset demo (forgets every change made in this browser), a link to
 * typetorch.dev, and while DuckDB-WASM loads (the first analytics answer), what it is doing.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { engineStatus, onEngineStatus, type EngineState } from "./mock/engine";
import { hasChanges, onStateChange, resetState } from "./mock/state";
import "./layout.css";

function useEngineState(): EngineState {
	const [state, setState] = useState(engineStatus);
	useEffect(() => onEngineStatus(setState), []);
	return state;
}

function useChanged(): boolean {
	const [changed, setChanged] = useState(hasChanges);
	useEffect(() => onStateChange(() => setChanged(hasChanges())), []);
	return changed;
}

function EngineNote({ state }: { state: EngineState }) {
	if (state.state === "loading")
		return (
			<span className="inline-flex items-center gap-1.5 text-muted-foreground" role="status">
				<span className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
				{state.step}…
			</span>
		);
	if (state.state === "failed")
		return (
			<span className="text-[var(--status-critical)]" role="status" title={state.error}>
				Analytics engine failed to load. Reload to try again.
			</span>
		);
	return null;
}

export function DemoBanner() {
	const engine = useEngineState();
	const changed = useChanged();
	const reset = () => {
		resetState();
		window.location.reload();
	};
	return (
		<div className="border-b bg-muted text-foreground">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 text-xs">
				<p className="min-w-0 flex-1">
					<span className="font-medium">Demo:</span> anonymized sample data from The Prison. You're signed in as an owner; changes stay in your browser.
				</p>
				<EngineNote state={engine} />
				<div className="flex shrink-0 items-center gap-3">
					<button
						type="button"
						onClick={reset}
						title={changed ? "Forget every change made in this browser" : "Nothing changed yet"}
						className="rounded-md border bg-background px-2 py-0.5 font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						Reset demo
					</button>
					<a href="https://www.typetorch.dev" target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
						typetorch.dev
					</a>
				</div>
			</div>
		</div>
	);
}

/** Keeps --demo-banner-h (layout.css fits the explorer's shell under the banner) at the banner's height. */
function trackHeight(element: HTMLElement): void {
	const set = () => document.documentElement.style.setProperty("--demo-banner-h", `${element.offsetHeight}px`);
	set();
	if (typeof ResizeObserver !== "undefined") new ResizeObserver(set).observe(element);
}

export function mountBanner(element: HTMLElement): void {
	trackHeight(element);
	createRoot(element).render(
		<StrictMode>
			<DemoBanner />
		</StrictMode>,
	);
}
