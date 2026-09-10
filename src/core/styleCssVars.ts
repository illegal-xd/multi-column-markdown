/**
 * Style → CSS custom properties.
 *
 * Every builder returns a map of `--columns-*` variables; the stylesheet reads
 * those variables. Multi-value shorthands are expanded to per-side values
 * because a longhand `var()` chain cannot receive a shorthand (it would be
 * invalid at computed-value time and fall back to the initial value).
 */
import type {ColumnStyleData} from "../types";
import {resolveBackground, resolveColorValue} from "./style";

/**
 * Expand a CSS 1–4 value spacing shorthand ("4 8", "1px 2px 3px 4px") into
 * per-side single values, following the CSS box-model rules.
 */
export function expandSpacingShorthand(value: string): {top: string; right: string; bottom: string; left: string} {
	const parts = value.split(/\s+/).filter((p) => p.length > 0);
	const top = parts[0] ?? "0";
	const right = parts[1] ?? top;
	const bottom = parts[2] ?? top;
	const left = parts[3] ?? right;
	return {top, right, bottom, left};
}

type CssProps = Record<string, string>;

/** Build the CSS-variable map for a column's style. */
export function buildColumnCssProps(parsed: ColumnStyleData): CssProps {
	const props: CssProps = {};
	if (parsed.background) props["--columns-col-bg"] = resolveBackground(parsed.background);
	if (parsed.textColor) props["--columns-col-text"] = resolveColorValue(parsed.textColor);
	applyBorderVars(parsed, props);
	if (parsed.separator) applySeparatorVars(parsed, props);
	applyMarginVars(parsed, props);
	if (parsed.padding) props["--columns-col-padding"] = parsed.padding;
	if (parsed.textAlign) props["--columns-col-text-align"] = parsed.textAlign;
	applyBorderRadiusVars(parsed, props);
	if (parsed.leftBorder) {
		props["--columns-left-border-width"] = parsed.borderWidthLeft ?? parsed.borderWidth ?? "3px";
	}
	return props;
}

/** Build the CSS-variable map for a container's style. */
export function buildContainerCssProps(parsed: ColumnStyleData): CssProps {
	const props: CssProps = {};
	if (parsed.background) props["--columns-block-bg"] = resolveBackground(parsed.background);
	if (parsed.textColor) props["--columns-block-text"] = resolveColorValue(parsed.textColor);
	applyContainerBorderVars(parsed, props);
	if (parsed.gap) props["--columns-block-gap"] = parsed.gap;
	return props;
}

function applySeparatorVars(parsed: ColumnStyleData, props: CssProps): void {
	props["--columns-col-sep-color"] = resolveColorValue(parsed.separatorColor ?? "gray");
	props["--columns-col-sep-width"] = `${parsed.separatorWidth ?? 1}px`;
	if (parsed.separatorStyle && parsed.separatorStyle !== "custom") {
		props["--columns-col-sep-style"] = parsed.separatorStyle;
	}
}

/** Margin shorthand → per-side; per-side alone when no shorthand. */
function applyMarginVars(parsed: ColumnStyleData, props: CssProps): void {
	if (!parsed.margin) {
		if (parsed.marginLeft) props["--columns-col-ml"] = parsed.marginLeft;
		if (parsed.marginTop) props["--columns-col-mt"] = parsed.marginTop;
		if (parsed.marginRight) props["--columns-col-mr"] = parsed.marginRight;
		if (parsed.marginBottom) props["--columns-col-mb"] = parsed.marginBottom;
		return;
	}
	// m: shorthand expanded — longhand var() chains cannot receive multi-values.
	const sides = expandSpacingShorthand(parsed.margin);
	props["--columns-col-margin"] = parsed.margin;
	props["--columns-col-ml"] = parsed.marginLeft ?? sides.left;
	props["--columns-col-mt"] = parsed.marginTop ?? sides.top;
	props["--columns-col-mr"] = parsed.marginRight ?? sides.right;
	props["--columns-col-mb"] = parsed.marginBottom ?? sides.bottom;
}

function hasBorderSignal(parsed: ColumnStyleData): boolean {
	return (
		parsed.showBorder !== undefined ||
		parsed.horizontalDividers !== undefined ||
		parsed.borderColor !== undefined ||
		parsed.borderWidth !== undefined ||
		parsed.borderWidthLeft !== undefined ||
		parsed.borderWidthTop !== undefined ||
		parsed.borderWidthRight !== undefined ||
		parsed.borderWidthBottom !== undefined
	);
}

function applyBorderVars(parsed: ColumnStyleData, props: CssProps): void {
	if (!hasBorderSignal(parsed)) return;
	if (parsed.horizontalDividers) props["--columns-col-horizontal-width"] = "1px";
	// sb:0 suppresses all border vars (per-side does not revive them).
	if (parsed.showBorder === false) return;
	props["--columns-col-border-color"] = resolveColorValue(parsed.borderColor ?? "gray");
	const hasPerSide =
		parsed.borderWidthLeft !== undefined ||
		parsed.borderWidthTop !== undefined ||
		parsed.borderWidthRight !== undefined ||
		parsed.borderWidthBottom !== undefined;
	const hasExplicit =
		parsed.borderWidth !== undefined ||
		(!hasPerSide && (parsed.showBorder === true || parsed.borderColor !== undefined));
	props["--columns-col-border-width"] = parsed.borderWidth ?? (hasExplicit ? "1px" : "0px");
	expandBorderWidthVars(parsed, parsed.horizontalDividers ?? false, props);
}

/** Expand `bw:` shorthand or emit per-side widths individually. */
function expandBorderWidthVars(
	parsed: ColumnStyleData,
	showHorizontal: boolean,
	props: CssProps,
): void {
	if (!parsed.borderWidth) {
		if (parsed.borderWidthLeft) props["--columns-col-border-width-l"] = parsed.borderWidthLeft;
		if (parsed.borderWidthTop) props["--columns-col-border-width-t"] = parsed.borderWidthTop;
		if (parsed.borderWidthRight) props["--columns-col-border-width-r"] = parsed.borderWidthRight;
		if (parsed.borderWidthBottom) props["--columns-col-border-width-b"] = parsed.borderWidthBottom;
		return;
	}
	// bw: shorthand must expand — longhand var() chains cannot receive multi-values.
	const sides = expandSpacingShorthand(parsed.borderWidth);
	props["--columns-col-border-width-l"] = parsed.borderWidthLeft ?? sides.left;
	props["--columns-col-border-width-r"] = parsed.borderWidthRight ?? sides.right;
	if (!showHorizontal) {
		props["--columns-col-border-width-t"] = parsed.borderWidthTop ?? sides.top;
		props["--columns-col-border-width-b"] = parsed.borderWidthBottom ?? sides.bottom;
		return;
	}
	// hd controls top/bottom unless bwt:/bwb: are explicit.
	if (parsed.borderWidthTop) props["--columns-col-border-width-t"] = parsed.borderWidthTop;
	if (parsed.borderWidthBottom) props["--columns-col-border-width-b"] = parsed.borderWidthBottom;
}

function applyBorderRadiusVars(parsed: ColumnStyleData, props: CssProps): void {
	if (parsed.borderRadius) applyBorderRadiusShorthand(parsed, props);
	else applyBorderRadiusPerSide(parsed, props);
}

/** `br:` shorthand expanded to four corners; per-side overrides win. */
function applyBorderRadiusShorthand(parsed: ColumnStyleData, props: CssProps): void {
	const s = expandSpacingShorthand(parsed.borderRadius!);
	props["--columns-col-radius"] = parsed.borderRadius!;
	let tl = s.top;
	let tr = s.right;
	let br = s.bottom;
	let bl = s.left;
	// Per-side radii: l/t/r/b each cover the two corners of that edge.
	if (parsed.borderRadiusLeft) { tl = parsed.borderRadiusLeft; bl = parsed.borderRadiusLeft; }
	if (parsed.borderRadiusTop) { tl = parsed.borderRadiusTop; tr = parsed.borderRadiusTop; }
	if (parsed.borderRadiusRight) { tr = parsed.borderRadiusRight; br = parsed.borderRadiusRight; }
	if (parsed.borderRadiusBottom) { bl = parsed.borderRadiusBottom; br = parsed.borderRadiusBottom; }
	props["--columns-col-radius-tl"] = tl;
	props["--columns-col-radius-tr"] = tr;
	props["--columns-col-radius-br"] = br;
	props["--columns-col-radius-bl"] = bl;
}

/** Per-side radii when no `br:` shorthand: l/t/r/b each covers two corners. */
function applyBorderRadiusPerSide(parsed: ColumnStyleData, props: CssProps): void {
	if (parsed.borderRadiusLeft) {
		props["--columns-col-radius-tl"] = parsed.borderRadiusLeft;
		props["--columns-col-radius-bl"] = parsed.borderRadiusLeft;
	}
	if (parsed.borderRadiusTop) {
		props["--columns-col-radius-tl"] = parsed.borderRadiusTop;
		props["--columns-col-radius-tr"] = parsed.borderRadiusTop;
	}
	if (parsed.borderRadiusRight) {
		props["--columns-col-radius-tr"] = parsed.borderRadiusRight;
		props["--columns-col-radius-br"] = parsed.borderRadiusRight;
	}
	if (parsed.borderRadiusBottom) {
		props["--columns-col-radius-bl"] = parsed.borderRadiusBottom;
		props["--columns-col-radius-br"] = parsed.borderRadiusBottom;
	}
}

function applyContainerBorderVars(parsed: ColumnStyleData, props: CssProps): void {
	const hasSignal =
		parsed.showBorder !== undefined ||
		parsed.horizontalDividers !== undefined ||
		parsed.borderColor !== undefined ||
		parsed.borderWidth !== undefined;
	if (!hasSignal) return;
	if (parsed.horizontalDividers) props["--columns-block-horizontal-width"] = "1px";
	if (parsed.showBorder === false) return;
	props["--columns-block-border-color"] = resolveColorValue(parsed.borderColor ?? "gray");
	const showBorder = parsed.showBorder ?? (parsed.borderColor !== undefined || parsed.borderWidth !== undefined);
	props["--columns-block-border-width"] = parsed.borderWidth ?? (showBorder ? "1px" : "0px");
}
