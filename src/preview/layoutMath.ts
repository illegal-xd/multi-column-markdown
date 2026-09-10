/**
 * Flex-basis math for the preview renderer.
 *
 * IMPORTANT: the constants below describe the CSS in `media/previewStyle.css`
 * (`gap` default, separator element sizes). They are duplicated by necessity —
 * flex-basis needs the pixel width the browser will give a separator, and CSS
 * cannot hand it back at parse time. `test/layoutConstants.test.mjs` asserts
 * the CSS still matches these numbers, so the duplication cannot drift
 * silently.
 */
import type {ColumnData, ColumnRegion, ColumnStyleData} from "../types";
import {groupColumns} from "../core/groups";

/** Default container gap in px (`--columns-block-gap` fallback in the CSS). */
export const DEFAULT_GAP_PX = 5;
/** Fixed width of a visual separator element (`.column-separator-visual`). */
export const SEPARATOR_VISUAL_PX = 8;
/** Custom separator base size and per-step growth (`--sep-size` math). */
export const SEPARATOR_CUSTOM_BASE_PX = 6;
export const SEPARATOR_CUSTOM_UNIT_PX = 6;

/**
 * Gap in px for the flex-basis shrink compensation. Only px values (bare
 * numbers or `px` unit) translate exactly; other CSS lengths (em/%) fall
 * back to the default so the layout stays consistent with the CSS gap.
 */
export function gapPx(style: ColumnStyleData | undefined): number {
	const raw = style?.gap;
	if (!raw) return DEFAULT_GAP_PX;
	const m = /^\d+(\.\d+)?(px)?$/i.exec(raw.trim());
	return m ? parseFloat(m[0]) : DEFAULT_GAP_PX;
}

/**
 * Width in px of a group-to-group separator element. Must stay in sync with
 * `buildSeparatorHtml`: custom separators size via `--sep-size`, visual
 * separators are a fixed-width element.
 */
export function separatorWidthPx(style: ColumnStyleData | undefined): number {
	if (!style?.separator) return 0;
	if (style.separatorStyle === "custom") {
		return style.separatorWidth
			? style.separatorWidth * SEPARATOR_CUSTOM_UNIT_PX + SEPARATOR_CUSTOM_BASE_PX
			: SEPARATOR_CUSTOM_BASE_PX * 2;
	}
	return SEPARATOR_VISUAL_PX;
}

/**
 * Per-column flex-basis shrink (px) so columns + separators + gaps sum to
 * the container width. Each group-to-group separator contributes its own
 * width plus an extra gap (it adds one more flex item between columns):
 *   shrink = (S*(w + gap) + (N-1)*gap) / N
 * where N = column groups, S = separators between groups, w = sep width.
 */
export function shrinkPx(region: ColumnRegion, gap: number): number {
	const groups = groupColumns(region.columns);
	let extra = (groups.length - 1) * gap;
	for (let i = 1; i < groups.length; i++) {
		const prevGroup = groups[i - 1]!;
		const prevCol: ColumnData | undefined = region.columns[
			prevGroup.indices[prevGroup.indices.length - 1]!
		];
		if (prevCol?.style?.separator) {
			extra += separatorWidthPx(prevCol.style) + gap;
		}
	}
	return groups.length > 0 ? extra / groups.length : 0;
}
