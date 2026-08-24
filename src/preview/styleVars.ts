/**
 * Style → CSS variable record builders (DOM-free, for the markdown-it
 * preview renderer which has no element access).
 */
import {BACKGROUND_CSS, COLOR_CSS} from "../core/style";
import type {ColumnStyleData, StyleColorOption} from "../types";

export function buildColumnStyleVars(parsed: ColumnStyleData): Record<string, string> {
	const cssProps: Record<string, string> = {};

	if (parsed.background) {
		cssProps["--columns-col-bg"] = BACKGROUND_CSS[parsed.background];
	}
	if (parsed.textColor) {
		cssProps["--columns-col-text"] = COLOR_CSS[parsed.textColor];
	}

	const hasBorderSignals =
		parsed.showBorder !== undefined ||
		parsed.horizontalDividers !== undefined ||
		parsed.borderColor !== undefined ||
		parsed.borderWidth !== undefined ||
		parsed.borderWidthLeft !== undefined ||
		parsed.borderWidthTop !== undefined ||
		parsed.borderWidthRight !== undefined ||
		parsed.borderWidthBottom !== undefined;

	if (hasBorderSignals) {
		const effectiveBorderColor = COLOR_CSS[parsed.borderColor ?? "gray"];
		const showBorder =
			parsed.showBorder ??
			(parsed.borderColor !== undefined ||
				parsed.borderWidth !== undefined ||
				parsed.borderWidthLeft !== undefined ||
				parsed.borderWidthTop !== undefined ||
				parsed.borderWidthRight !== undefined ||
				parsed.borderWidthBottom !== undefined);
		const showHorizontal = parsed.horizontalDividers ?? false;

		cssProps["--columns-col-border-color"] = effectiveBorderColor;
		cssProps["--columns-col-border-width"] = parsed.borderWidth ?? (showBorder ? "1px" : "0px");
		if (showHorizontal) cssProps["--columns-col-horizontal-width"] = "1px";
	}

	if (parsed.separator) {
		cssProps["--columns-col-sep-color"] = COLOR_CSS[parsed.separatorColor ?? "gray"];
		cssProps["--columns-col-sep-width"] = `${parsed.separatorWidth ?? 1}px`;
		if (parsed.separatorStyle && parsed.separatorStyle !== "custom") {
			cssProps["--columns-col-sep-style"] = parsed.separatorStyle;
		}
	}

	if (parsed.padding) cssProps["--columns-col-padding"] = parsed.padding;
	if (parsed.marginLeft) cssProps["--columns-col-ml"] = parsed.marginLeft;
	if (parsed.marginTop) cssProps["--columns-col-mt"] = parsed.marginTop;
	if (parsed.marginRight) cssProps["--columns-col-mr"] = parsed.marginRight;
	if (parsed.marginBottom) cssProps["--columns-col-mb"] = parsed.marginBottom;
	if (parsed.margin) cssProps["--columns-col-margin"] = parsed.margin;
	if (parsed.textAlign) cssProps["--columns-col-text-align"] = parsed.textAlign;
	if (parsed.borderRadius) cssProps["--columns-col-radius"] = parsed.borderRadius;
	// Per-side radii: l/t/r/b each cover the two corners of that edge.
	if (parsed.borderRadiusLeft) {
		cssProps["--columns-col-radius-tl"] = parsed.borderRadiusLeft;
		cssProps["--columns-col-radius-bl"] = parsed.borderRadiusLeft;
	}
	if (parsed.borderRadiusTop) {
		cssProps["--columns-col-radius-tl"] = parsed.borderRadiusTop;
		cssProps["--columns-col-radius-tr"] = parsed.borderRadiusTop;
	}
	if (parsed.borderRadiusRight) {
		cssProps["--columns-col-radius-tr"] = parsed.borderRadiusRight;
		cssProps["--columns-col-radius-br"] = parsed.borderRadiusRight;
	}
	if (parsed.borderRadiusBottom) {
		cssProps["--columns-col-radius-bl"] = parsed.borderRadiusBottom;
		cssProps["--columns-col-radius-br"] = parsed.borderRadiusBottom;
	}
	// Per-side border widths (override the shorthand).
	if (parsed.borderWidthLeft) cssProps["--columns-col-border-width-l"] = parsed.borderWidthLeft;
	if (parsed.borderWidthTop) cssProps["--columns-col-border-width-t"] = parsed.borderWidthTop;
	if (parsed.borderWidthRight) cssProps["--columns-col-border-width-r"] = parsed.borderWidthRight;
	if (parsed.borderWidthBottom) cssProps["--columns-col-border-width-b"] = parsed.borderWidthBottom;

	return cssProps;
}

export function buildContainerStyleVars(parsed: ColumnStyleData): Record<string, string> {
	const cssProps: Record<string, string> = {};

	if (parsed.background) {
		cssProps["--columns-block-bg"] = BACKGROUND_CSS[parsed.background];
	}
	if (parsed.textColor) {
		cssProps["--columns-block-text"] = COLOR_CSS[parsed.textColor];
	}

	const hasBorderSignals =
		parsed.showBorder !== undefined ||
		parsed.horizontalDividers !== undefined ||
		parsed.borderColor !== undefined;

	if (hasBorderSignals) {
		const effectiveBorderColor = COLOR_CSS[parsed.borderColor ?? "gray"];
		const showBorder = parsed.showBorder ?? parsed.borderColor !== undefined;
		const showHorizontal = parsed.horizontalDividers ?? false;

		cssProps["--columns-block-border-color"] = effectiveBorderColor;
		cssProps["--columns-block-border-width"] = showBorder ? "1px" : "0px";
		if (showHorizontal) cssProps["--columns-block-horizontal-width"] = "1px";
	}

	if (parsed.gap) cssProps["--columns-block-gap"] = parsed.gap;

	return cssProps;
}

function styleToVarsString(vars: Record<string, string>): string {
	return Object.entries(vars)
		.map(([key, value]) => `${key}:${value}`)
		.join(";");
}

/** Style attribute fragment for a column item. */
export function applyColumnStyleVars(style: ColumnStyleData | undefined): string {
	if (!style) return "";
	return styleToVarsString(buildColumnStyleVars(style));
}

/** Style attribute fragment for a container. */
export function applyContainerStyleVars(style: ColumnStyleData | undefined): string {
	if (!style) return "";
	return styleToVarsString(buildContainerStyleVars(style));
}

/** CSS color value resolution for separator rendering (preview). */
export function resolveColor(name: StyleColorOption | undefined): string {
	return COLOR_CSS[name ?? "gray"];
}
