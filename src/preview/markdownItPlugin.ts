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
import {START_RE, fencedLineMask, findRegionEnd, markerLineAt} from "../core/markers";
import {blockLines, type BlockRuleState, type MarkdownItLike} from "./markdownItTypes";
import {PASSTHROUGH_ENV_KEY, renderColumns} from "./columnsRenderer";
import {installTaskLists} from "./taskLists";
import {installWikilinkInline} from "./wikilinks";

const installedMarkdownIt = new WeakSet<object>();

export function installColumnsMarkdownItPlugin(md: MarkdownIt): void {
	if (installedMarkdownIt.has(md)) return;
	installedMarkdownIt.add(md);

	const m = md as unknown as MarkdownItLike;
	m.block.ruler.before("paragraph", "amc_columns", columnsBlockRule);
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

	const lines = blockLines(state, startLine, endLine);
	const fenced = fencedLineMask(lines);
	const first = markerLineAt(lines, fenced, 0);
	if (first === null || !START_RE.test(first)) return false;
	if (silent) return false;

	const endIndex = findRegionEnd(lines, fenced, 0);
	if (endIndex < 0) return false; // unclosed — leave as plain text

	const token = state.push("amc_columns", "", 0);
	token.content = state.getLines(startLine, startLine + endIndex + 1, state.blkIndent, false);
	token.map = [startLine, startLine + endIndex];
	state.line = startLine + endIndex + 1;
	return true;
}

function createColumnsRenderer(md: MarkdownIt): MarkdownItLike["renderer"]["rules"][string] {
	return (tokens, idx, _options, env) => {
		const depth = (env as {amcDepth?: number} | undefined)?.amcDepth ?? 0;
		return renderColumns(tokens[idx]!.content, md, env, depth);
	};
}
