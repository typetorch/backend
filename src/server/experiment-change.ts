/**
 * POST /v1/experiments/<experiment>/change (owners): start, stop, re-split, settle or clear an experiment from the
 * Experiments page.
 *
 * The live split is the `experiments` override in the game's SIGNED settings record (plans/20): servers only apply a
 * record both of the game's prod keys signed, and those keys live on the owners' machines, never on this server
 * (security: a backend that held them, or that wrote unsigned settings, could change every prod server). So the
 * explorer cannot apply the change itself. This route checks it, records it in the audit log, and answers the exact
 * `typetorch experiment ...` command (CLI 0.9+, the same signed write as `settings set`: read, verify, change, sign
 * with both keys, write, ping) that applies it from the owner's machine, plus its `--dry-run` twin that shows the
 * override before and after without writing. Nothing here changes any state but the audit log.
 */

export class ExperimentChangeInput extends Error {
	override name = "ExperimentChangeInput";
}

/** The CLI's (and the framework's) experiment names: 1-64 letters, digits, _ - . / */
export const EXPERIMENT_NAME = /^[A-Za-z0-9_\-./]{1,64}$/;
/** The framework's isVariantList: 1-16 distinct names of 1-32 characters. */
export const VARIANTS_MAX = 16;
export const VARIANT_MAX = 32;
export const CHANGE_BODY_MAX = 4096;

export const CHANGE_ACTIONS = ["start", "stop", "split", "settle", "clear"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export interface ChangeRequest {
	action: ChangeAction;
	/** split: one relative weight per variant, in the game's order (the first is the control). */
	weights?: number[];
	/** settle: the variant everyone gets. */
	variant?: string;
	/** The game's variants in its order, when the page knows them: the CLI then checks the count and the name. */
	variants?: string[];
}

export interface PreparedChange {
	experiment: string;
	action: ChangeAction;
	/** The command that applies it (signed with the game's keys on the owner's machine). */
	command: string;
	/** The same with --dry-run: shows the override before and after, writes nothing. */
	dryRun: string;
	/** What it does, in plain words. */
	effect: string;
	/** Things to know (e.g. why --variants was left out). */
	notes: string[];
}

/** A shell word: as is when it is plainly safe, else single-quoted (a ' inside becomes '\''). */
export function shellWord(text: string): string {
	return /^[A-Za-z0-9_\-./:,@+=%]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function checkVariant(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > VARIANT_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new ExperimentChangeInput(`${what} must be a variant name (1-${VARIANT_MAX} characters, no control characters)`);
	}
	// The CLI would read a leading "-" as an option.
	if (value.startsWith("-")) throw new ExperimentChangeInput(`${what} can't start with "-" (the CLI would read it as an option)`);
	return value;
}

/** Checks the body of a change; throws ExperimentChangeInput with a plain message. */
export function parseChange(body: unknown): ChangeRequest {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ExperimentChangeInput("send { action, weights?, variant?, variants? }");
	const raw = body as Record<string, unknown>;
	for (const key of Object.keys(raw)) if (!["action", "weights", "variant", "variants"].includes(key)) throw new ExperimentChangeInput(`unknown field ${JSON.stringify(key.slice(0, 40))}`);
	if (!CHANGE_ACTIONS.includes(raw.action as ChangeAction)) throw new ExperimentChangeInput(`action must be one of ${CHANGE_ACTIONS.join(", ")}`);
	const out: ChangeRequest = { action: raw.action as ChangeAction };
	if (raw.variants !== undefined) {
		const list = raw.variants;
		if (!Array.isArray(list) || list.length < 1 || list.length > VARIANTS_MAX) throw new ExperimentChangeInput(`variants must list 1-${VARIANTS_MAX} variants`);
		const names = list.map((v, i) => checkVariant(v, `variants[${i}]`));
		if (new Set(names).size !== names.length) throw new ExperimentChangeInput("variants must be distinct");
		out.variants = names;
	}
	if (out.action === "split") {
		const w = raw.weights;
		if (!Array.isArray(w) || w.length < 1 || w.length > VARIANTS_MAX || w.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0) || !w.some((x) => (x as number) > 0)) {
			throw new ExperimentChangeInput(`weights must be 1-${VARIANTS_MAX} numbers >= 0, at least one above 0`);
		}
		if (out.variants && w.length !== out.variants.length) throw new ExperimentChangeInput(`${w.length} weights for ${out.variants.length} variants: one weight per variant, in the game's order`);
		out.weights = w as number[];
	} else if (raw.weights !== undefined) throw new ExperimentChangeInput("weights only go with action split");
	if (out.action === "settle") {
		out.variant = checkVariant(raw.variant, "variant");
		if (out.variants && !out.variants.includes(out.variant)) throw new ExperimentChangeInput(`variant ${JSON.stringify(out.variant)} isn't one of the variants`);
	} else if (raw.variant !== undefined) throw new ExperimentChangeInput("variant only goes with action settle");
	return out;
}

/** A weight as the CLI reads it back (no exponent, no trailing zeros). */
function weightText(w: number): string {
	return String(Math.round(w * 1e6) / 1e6);
}

/** The prepared change: the command, its dry run and what it does. `experiment` must already be a checked name. */
export function prepareChange(experiment: string, change: ChangeRequest): PreparedChange {
	if (!EXPERIMENT_NAME.test(experiment)) throw new ExperimentChangeInput("experiment name: 1-64 letters, digits and _ - . /");
	const notes: string[] = [];
	const args = ["typetorch", "experiment"];
	let effect: string;
	switch (change.action) {
		case "start":
			args.push("resume", experiment);
			effect = "Starts it again: drops stop and settle, keeps the weights (and forced players).";
			break;
		case "stop":
			args.push("stop", experiment);
			effect = "Stops it: everyone gets the first variant (the control) and events are no longer stamped with it.";
			break;
		case "split": {
			const weights = change.weights as number[];
			const total = weights.reduce((s, w) => s + w, 0);
			args.push("weights", experiment, weights.map(weightText).join(","));
			const shares = weights.map((w, i) => `${change.variants?.[i] ?? `variant ${i + 1}`} ${Math.round((w / total) * 1000) / 10}%`);
			effect = `Splits new and returning players ${shares.join(", ")}. Players only move when the boundary passes their hash.`;
			break;
		}
		case "settle":
			args.push("settle", experiment, change.variant as string);
			effect = `Settles it: everyone gets ${change.variant} (stamped, forced). Forced players are left out of the results.`;
			break;
		case "clear":
			args.push("clear", experiment);
			effect = "Removes the override (and its forced players): the game's even split again.";
			break;
	}
	if ((change.action === "split" || change.action === "settle") && change.variants) {
		// The CLI splits --variants on commas: a name with one can't be passed (the check is skipped, not wrong).
		if (change.variants.some((v) => v.includes(","))) notes.push("A variant name holds a comma, so --variants (the CLI's count and name check) is left out.");
		else args.push("--variants", change.variants.join(","));
	}
	if (change.action === "split" && !change.variants) notes.push("Weights go in the order the game lists its variants (the first is the control); add --variants a,b so the CLI checks the count.");
	const command = args.map(shellWord).join(" ");
	return {
		experiment,
		action: change.action,
		command,
		dryRun: `${command} --dry-run`,
		effect,
		notes: [
			...notes,
			"Run it in the game's folder: it signs the settings with the game's two keys and servers apply it within seconds (no deploy).",
		],
	};
}
