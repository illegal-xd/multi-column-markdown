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
		parsed.borderColor !== undefined;

	if (hasBorderSignals) {
		const effectiveBorderColor = COLOR_CSS[parsed.borderColor ?? "gray"];
		const showBorder = parsed.showBorder ?? parsed.borderColor !== undefined;
		const showHorizontal = parsed.horizontalDividers ?? false;

		cssProps["--columns-col-border-color"] = effectiveBorderColor;
		cssProps["--columns-col-border-width"] = showBorder ? "1px" : "0px";
		if (showHorizontal) cssProps["--columns-col-horizontal-width"] = "1px";
	}

	if (parsed.separator) {
		cssProps["--columns-col-sep-color"] = COLOR_CSS[parsed.separatorColor ?? "gray"];
		cssProps["--columns-col-sep-width"] = `${parsed.separatorWidth ?? 1}px`;
		if (parsed.separatorStyle && parsed.separatorStyle !== "custom") {
			cssProps["--columns-col-sep-style"] = parsed.separatorStyle;
		}
	}

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
