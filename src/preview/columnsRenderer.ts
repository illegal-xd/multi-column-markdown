/**
 * Column region → HTML.
 *
 * Pure rendering: takes the raw region source extracted by the block ruler,
 * re-parses it with the shared structural parser and emits the container,
 * groups, separators and columns. Layout math lives in `layoutMath.ts`,
 * style → CSS variables in `styleVars.ts`, escaping in `htmlEscape.ts`.
 */
import type MarkdownIt from "markdown-it";
import {findColumnRegions} from "../core/parser";
import {groupColumns, type ColumnGroup} from "../core/groups";
import type {ColumnData, ColumnRegion} from "../types";
import {columnCacheKey, getCachedColumnHtml, setCachedColumnHtml} from "./columnHtmlCache";
import {getRenderScope} from "./renderScope";
import {escapeHtml} from "./htmlEscape";
import {applyColumnStyleVars, applyContainerStyleVars, resolveColor} from "./styleVars";
import {gapPx, separatorWidthPx, shrinkPx} from "./layoutMath";

/** Hard cap on column nesting (deeper content degrades to plain Markdown). */
export const MAX_NESTING_DEPTH = 8;

/** Env key set while rendering content that must not re-enter the column rule. */
export const PASSTHROUGH_ENV_KEY = "__amcPassthrough";

/**
 * Render the raw source of one or more column regions. When the source holds
 * no closed region, it is rendered as plain Markdown instead of disappearing —
 * a broken block must stay visible to the author.
 *
 * `baseLine` is the line of `raw`'s first line **within the current render
 * scope** (0-based). Line-number invariant: everything this function emits is
 * relative to that scope. A column's content is rendered by its own
 * `md.render()` call, so those numbers start at 0 again; `renderColumnItem`
 * shifts them into scope coordinates exactly once (`rebaseDataLines`). Nesting
 * therefore needs no global offset: each column boundary converts its own
 * subtree, outermost scope last.
 */
export function renderColumns(raw: string, md: MarkdownIt, env: unknown, depth: number, baseLine = 0): string {
	if (depth > MAX_NESTING_DEPTH) return renderPassthrough(raw, md, env, baseLine);
	const regions = findColumnRegions(raw);
	if (regions.length === 0) return renderPassthrough(raw, md, env, baseLine);
	return regions.map((region) => renderRegion(region, md, env, depth, baseLine)).join("\n");
}

/** Render raw source without letting the column rule fire again. */
function renderPassthrough(raw: string, md: MarkdownIt, env: unknown, baseLine = 0): string {
	const holder = (typeof env === "object" && env !== null ? env : {}) as Record<string, unknown>;
	const previous = holder[PASSTHROUGH_ENV_KEY];
	holder[PASSTHROUGH_ENV_KEY] = true;
	try {
		return `<div class="amc-parse-fallback">${rebaseDataLines(md.render(raw, holder), baseLine)}</div>`;
	} finally {
		holder[PASSTHROUGH_ENV_KEY] = previous;
	}
}

interface RenderContext {
	md: MarkdownIt;
	env: unknown;
	depth: number;
	/** Per-column flex-basis shrink in px (see `layoutMath.ts`). */
	shrink: number;
	/** Scope-relative line of the region's first line (for `data-line`). */
	baseLine: number;
}

export function renderRegion(
	region: ColumnRegion,
	md: MarkdownIt,
	env: unknown,
	depth: number,
	baseLine = 0,
): string {
	const context: RenderContext = {
		md,
		env,
		depth,
		shrink: shrinkPx(region, gapPx(region.containerStyle)),
		baseLine,
	};
	const groups = groupColumns(region.columns);
	let html = openContainer(region, depth, baseLine);
	for (let index = 0; index < groups.length; index++) {
		html += renderGroup(region, groups, index, context);
	}
	return `${html}</div>`;
}

function openContainer(region: ColumnRegion, depth: number, baseLine: number): string {
	const containerVars = applyContainerStyleVars(region.containerStyle);
	const classes = [
		"columns-container",
		"columns-ui",
		"columns-reading",
		region.layout === "stack" ? "columns-stacked" : "",
		region.responsive ? "columns-responsive" : "",
		depth > 0 ? "columns-nested" : "",
		containerVars ? "columns-custom-style" : "",
	].filter(Boolean).join(" ");
	const lineAttr = ` data-line="${baseLine}"`;
	return containerVars
		? `<div class="${classes}"${lineAttr} style="${containerVars}">`
		: `<div class="${classes}"${lineAttr}>`;
}

function renderGroup(
	region: ColumnRegion,
	groups: ReadonlyArray<ColumnGroup>,
	index: number,
	context: RenderContext,
): string {
	const group = groups[index]!;
	const previous = groups[index - 1];
	let html = previous ? buildSeparatorHtml(lastColumn(region, previous)) : "";
	const useStackWrapper = group.isStack && region.layout !== "stack" && group.indices.length > 1;
	if (useStackWrapper) html += `<div class="columns-stack-group"${stackGroupStyle(region, group, context)}>`;

	for (let position = 0; position < group.indices.length; position++) {
		if (position > 0 && group.isStack) {
			html += buildSeparatorHtml(region.columns[group.indices[position - 1]!]!);
		}
		html += renderColumnItem(region, group.indices[position]!, useStackWrapper, context);
	}

	return useStackWrapper ? `${html}</div>` : html;
}

function lastColumn(region: ColumnRegion, group: ColumnGroup): ColumnData {
	return region.columns[group.indices[group.indices.length - 1]!]!;
}

function stackGroupStyle(region: ColumnRegion, group: ColumnGroup, context: RenderContext): string {
	const maxWidth = Math.max(...group.indices.map((idx) => region.columns[idx]!.widthPercent));
	return maxWidth > 0
		? ` style="flex: 0 0 calc(${maxWidth}% - ${context.shrink.toFixed(1)}px)"`
		: "";
}

function renderColumnItem(
	region: ColumnRegion,
	columnIndex: number,
	useStackWrapper: boolean,
	context: RenderContext,
): string {
	const col = region.columns[columnIndex]!;
	const vars = applyColumnStyleVars(col.style);
	const classes = ["column-item"];
	if (vars) classes.push("columns-custom-style");
	if (col.style?.leftBorder) classes.push("columns-left-border");

	let styleAttr = vars ? ` style="${vars}"` : "";
	if (!useStackWrapper && region.layout !== "stack" && col.widthPercent > 0) {
		const flex = `flex: 0 0 calc(${col.widthPercent}% - ${context.shrink.toFixed(1)}px)`;
		styleAttr = styleAttr ? `${styleAttr.slice(0, -1)};${flex}"` : ` style="${flex}"`;
	}
	// Scope-relative line of this column's first content line: the region's own
	// line plus the column's line range inside the region source. Nested
	// rendering stays relative to this scope, so one rebase converts the whole
	// subtree (see the invariant on `renderColumns`).
	const columnLine = context.baseLine + (region.columnLineRanges[columnIndex]?.[0] ?? 0);
	const inner = rebaseDataLines(renderColumnContent(context, col.content), columnLine);
	return `<div class="${classes.join(" ")}" data-line="${columnLine}"${styleAttr}><div class="column-content">${inner}</div></div>`;
}

/**
 * Render one column's content, reusing the cached HTML of unchanged columns.
 *
 * The cache stores the *scope-relative* output (see `columnHtmlCache.ts`), so a
 * hit only saves the parse+render and the caller's rebase still applies. A
 * column whose render touched dynamic content (dataview, markdown embeds) is
 * not stored: its output changes without its text changing.
 */
function renderColumnContent(context: RenderContext, content: string): string {
	const owner = context.md as unknown as object;
	const key = columnCacheKey(content, context.depth);
	const cached = getCachedColumnHtml(owner, key);
	if (cached !== undefined) return cached;

	const childEnv = {
		...(context.env as object),
		amcDepth: context.depth + 1,
	};
	const scope = getRenderScope(childEnv);
	const marksBefore = scope.marks;
	const html = context.md.render(content, childEnv);
	if (scope.marks === marksBefore) setCachedColumnHtml(owner, key, html);
	return html;
}

/**
 * Shift the `data-line` attributes of an already-rendered fragment by `offset`.
 *
 * Column content is rendered by a nested `md.render()`, so every block inside
 * it carries a line number relative to that column. Left alone, the preview's
 * scroll sync maps those blocks to the wrong editor lines (and `anchor.ts`
 * records a wrong anchor). `offset` is the scope-relative line of the
 * fragment's first line, so `local + offset` is the scope-relative line the
 * caller's own `data-line` attributes use — the outermost scope being the
 * document, hence document-absolute.
 *
 * Scope: only `data-line="<digits>"` attribute syntax is rewritten. Markdown
 * escapes quotes inside code spans/blocks (`&quot;`), so literal text that
 * looks like the attribute is not rewritten in practice.
 */
export function rebaseDataLines(html: string, offset: number): string {
	if (offset === 0 || !html.includes("data-line=")) return html;
	return html.replace(/(\bdata-line=")(\d+)(")/g, (_match, prefix: string, line: string, suffix: string) => {
		return `${prefix}${offset + Number(line)}${suffix}`;
	});
}

export function buildSeparatorHtml(col: ColumnData): string {
	const style = col.style;
	if (!style?.separator) return "";

	const color = resolveColor(style.separatorColor);
	if (style.separatorStyle === "custom" && style.separatorCustomChar) {
		const size = separatorWidthPx(style);
		return `<div class="column-separator-custom" style="--sep-color:${color};--sep-size:${size}px">${escapeHtml(style.separatorCustomChar)}</div>`;
	}
	const width = style.separatorWidth ?? 1;
	const sepStyle = style.separatorStyle && style.separatorStyle !== "custom" ? style.separatorStyle : "solid";
	return `<div class="column-separator-visual" style="--sep-color:${color};--sep-width:${width}px;--sep-style:${sepStyle}"></div>`;
}
