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
 */
export function renderColumns(raw: string, md: MarkdownIt, env: unknown, depth: number): string {
	if (depth > MAX_NESTING_DEPTH) return renderPassthrough(raw, md, env);
	const regions = findColumnRegions(raw);
	if (regions.length === 0) return renderPassthrough(raw, md, env);
	return regions.map((region) => renderRegion(region, md, env, depth)).join("\n");
}

/** Render raw source without letting the column rule fire again. */
function renderPassthrough(raw: string, md: MarkdownIt, env: unknown): string {
	const holder = (typeof env === "object" && env !== null ? env : {}) as Record<string, unknown>;
	const previous = holder[PASSTHROUGH_ENV_KEY];
	holder[PASSTHROUGH_ENV_KEY] = true;
	try {
		return `<div class="amc-parse-fallback">${md.render(raw, holder)}</div>`;
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
}

export function renderRegion(region: ColumnRegion, md: MarkdownIt, env: unknown, depth: number): string {
	const context: RenderContext = {md, env, depth, shrink: shrinkPx(region, gapPx(region.containerStyle))};
	const groups = groupColumns(region.columns);
	let html = openContainer(region, depth);
	for (let index = 0; index < groups.length; index++) {
		html += renderGroup(region, groups, index, context);
	}
	return `${html}</div>`;
}

function openContainer(region: ColumnRegion, depth: number): string {
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
	return containerVars
		? `<div class="${classes}" style="${containerVars}">`
		: `<div class="${classes}">`;
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
	const inner = context.md.render(col.content, {
		...(context.env as object),
		amcDepth: context.depth + 1,
	});
	return `<div class="${classes.join(" ")}"${styleAttr}><div class="column-content">${inner}</div></div>`;
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
