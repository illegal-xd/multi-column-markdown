/**
 * markdown-it plugin installer — renders column markers in the built-in
 * Markdown preview (the VSCode equivalent of the reference plugin's Reading
 * View).
 *
 * Loaded by VSCode's markdown preview extension via the
 * `contributes.markdownMarkdownItPlugins` declaration. It runs in the
 * markdown extension host, which is what lets `preview/embed.ts` read the
 * workspace when resolving `![[note]]` targets.
 *
 * Implementation: a **block ruler** (before `paragraph`) matches the
 * `%% col-start %%` line, scans forward for the matching `%% col-end %%`
 * (supporting nesting) and consumes the whole line range as a single
 * `amc_columns` token carrying the raw source. Rendering re-parses the
 * region with the shared `findColumnRegions` and recursively renders each
 * column with the same markdown-it instance — identical parsing semantics
 * to the reference implementation.
 *
 * This file only wires things together; the work lives in:
 *   - `core/markers.ts`      marker grammar + fenced-code awareness
 *   - `core/parser.ts`       structural parsing
 *   - `preview/columnsRenderer.ts`  column HTML
 *   - `preview/wikilinks.ts` / `preview/embed.ts` / `preview/taskLists.ts`
 */
import type MarkdownIt from "markdown-it";
import {START_RE, fencedLineMask, findRegionEnd, hasMarkerPrefix, markerLineAt} from "../core/markers";
import {blockLines, type BlockRuleState, type MarkdownItLike} from "./markdownItTypes";
import {PASSTHROUGH_ENV_KEY, renderColumns} from "./columnsRenderer";
import {logRenderFailure} from "./renderLog";
import {installTaskLists} from "./taskLists";
import {installWikilinkInline} from "./wikilinks";

const installedMarkdownIt = new WeakSet<object>();

/** Diagnostics: per-instance column HTML cache counters (see `columnHtmlCache`). */
export {getColumnHtmlCacheStats} from "./columnHtmlCache";

export function installColumnsMarkdownItPlugin(md: MarkdownIt): void {
	if (installedMarkdownIt.has(md)) return;
	installedMarkdownIt.add(md);

	const m = md as unknown as MarkdownItLike;
	// `alt: ["paragraph"]` puts the rule on the paragraph terminator chain as
	// well: without it the paragraph rule never probes this ruler, so a marker
	// line directly after a paragraph line was swallowed into that paragraph.
	m.block.ruler.before("paragraph", "amc_columns", columnsBlockRule, {alt: ["paragraph"]});
	m.renderer.rules["amc_columns"] = createColumnsRenderer(md);

	installWikilinkInline(md);
	installTaskLists(md);
}

/**
 * Block ruler: consume `%% col-start %%` … `%% col-end %%` as one token.
 * The scan is shared with the structural parser (`core/markers.ts`), so both
 * agree on nesting and on what counts as a marker.
 */
function columnsBlockRule(
	state: BlockRuleState,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	if (state.env?.[PASSTHROUGH_ENV_KEY]) return false;
	// O(1) negative gate: this rule runs at every block start of the document,
	// so slicing the remaining lines (below) unconditionally made parsing
	// quadratic in document length. Only a line whose first non-space chars are
	// `%%` can be a column marker — everything else bails out here.
	if (!hasMarkerPrefix(state.src, state.bMarks[startLine], state.eMarks[startLine])) return false;

	const endIndex = scanRegion(state, startLine, endLine);
	if (endIndex === null) return false;
	// `silent` is markdown-it's terminator probe (the paragraph rule asks every
	// ruler "does a block start on this line?"). Answering false here made a
	// `%% col-start %%` line directly after a paragraph line get swallowed as
	// paragraph text — the region then rendered as literal markers in the
	// preview while the structural parser still treated it as a region. Only a
	// *closed* region claims the line, so malformed blocks keep their current
	// all-text rendering.
	if (silent) return true;

	const token = state.push("amc_columns", "", 0);
	token.content = state.getLines(startLine, startLine + endIndex + 1, state.blkIndent, false);
	token.map = [startLine, startLine + endIndex];
	state.line = startLine + endIndex + 1;
	return true;
}

/**
 * Line index (relative to `startLine`) of the `%% col-end %%` closing a region
 * opened at `startLine`, or null when this line does not open a closed region.
 *
 * Fail-open: a throw inside the scan (fenced-code masking, marker grammar, a
 * broken patch to this file) must not escape into the preview renderer — an
 * escaping exception blanks the whole document. Returning null leaves the lines
 * to markdown-it's own rules, so they render as ordinary text.
 */
function scanRegion(state: BlockRuleState, startLine: number, endLine: number): number | null {
	try {
		const lines = blockLines(state, startLine, endLine);
		const fenced = fencedLineMask(lines);
		const first = markerLineAt(lines, fenced, 0);
		if (first === null || !START_RE.test(first)) return null;
		const endIndex = findRegionEnd(lines, fenced, 0);
		return endIndex < 0 ? null : endIndex;
	} catch (error) {
		logRenderFailure("columns:scan", error);
		return null;
	}
}

function createColumnsRenderer(md: MarkdownIt): MarkdownItLike["renderer"]["rules"][string] {
	return (tokens, idx, _options, env) => {
		const depth = (env as {amcDepth?: number} | undefined)?.amcDepth ?? 0;
		// `token.map[0]` is the region's first line in the current render scope
		// (the document at the top level, a column's content when nested).
		return renderColumns(tokens[idx]!.content, md, env, depth, tokens[idx]!.map?.[0] ?? 0);
	};
}
