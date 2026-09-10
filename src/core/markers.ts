/**
 * Canonical column-marker grammar + fenced-code awareness.
 *
 * Single source of truth for the marker regexes: both the structural scanner
 * (`parser.ts`) and the markdown-it block ruler (`preview/markdownItPlugin.ts`)
 * import from here, so a grammar change can never be applied to only one of
 * the two scanners.
 *
 * `fencedLineMask` also gives the scanner the one piece of Markdown awareness
 * it needs: markers written *inside* a fenced code block are documentation,
 * not layout. Without it, unbalanced example markers corrupt real documents.
 */

export const START_RE = /^%%\s*col-start(?:\s*:(.*?))?\s*%%$/;
export const BREAK_RE = /^%%\s*col-break(?:\s*:(.*?))?\s*%%$/;
export const END_RE = /^%%\s*col-end\s*%%$/;

interface FenceState {
	char: string;
	length: number;
}

/**
 * Flags every line that belongs to a fenced code block (opening fence,
 * body and closing fence). Handles ``` / ~~~ fences, longer fences, and the
 * CommonMark rules that matter here: ≤3 spaces of indent, closing fence must
 * use the same character and be at least as long, and a backtick fence's
 * info string may not itself contain a backtick.
 */
export function fencedLineMask(lines: ReadonlyArray<string>): boolean[] {
	const mask: boolean[] = new Array<boolean>(lines.length).fill(false);
	let fence: FenceState | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (fence) {
			mask[i] = true;
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
				fence = null;
			}
			continue;
		}
		const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!open) continue;
		const marker = open[1]!;
		const info = open[2] ?? "";
		if (marker[0] === "`" && info.includes("`")) continue; // not a fence
		fence = {char: marker[0]!, length: marker.length};
		mask[i] = true;
	}

	return mask;
}

/**
 * Index of the `%% col-end %%` that closes the region opened at `startIndex`,
 * or -1 when unclosed (or beyond `maxIndex`, exclusive).
 *
 * Shared by both scanners: the block ruler needs the same answer as the
 * structural parser, including the header-zone rule that a nested example
 * block opened before the first `col-break` still owns its own `col-end`.
 */
export function findRegionEnd(
	lines: ReadonlyArray<string>,
	fenced: ReadonlyArray<boolean>,
	startIndex: number,
	maxIndex: number = lines.length,
): number {
	let depth = 0;
	for (let i = startIndex; i < maxIndex; i++) {
		const marker = markerLineAt(lines, fenced, i);
		if (marker === null) continue;
		if (START_RE.test(marker)) {
			depth += 1;
			continue;
		}
		if (depth > 0 && END_RE.test(marker)) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * The marker text of a line, or null when the line cannot carry a marker:
 * empty lines, lines inside fenced code blocks, and lines indented by 4+
 * spaces (CommonMark indented code block — markdown-it's own rulers treat
 * them as code, so the scanner must agree).
 */
export function markerLineAt(
	lines: ReadonlyArray<string>,
	fenced: ReadonlyArray<boolean>,
	index: number,
): string | null {
	const line = lines[index];
	if (line === undefined || fenced[index]) return null;
	if (/^ {4}/.test(line) || line.startsWith("\t")) return null;
	const trimmed = line.trim();
	return trimmed.length === 0 ? null : trimmed;
}
