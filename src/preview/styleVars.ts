/**
 * Style → CSS variable record builders for the markdown-it preview renderer.
 */
import {
	buildColumnCssProps,
	buildContainerCssProps,
	resolveColorValue,
} from "../core/style";
import type {ColumnStyleData, StyleColorOptionOrCustom} from "../types";

function styleToVarsString(vars: Record<string, string>): string {
	return Object.entries(vars)
		.map(([key, value]) => `${key}:${value}`)
		.join(";");
}

/** Style attribute fragment for a column item. */
export function applyColumnStyleVars(style: ColumnStyleData | undefined): string {
	return style ? styleToVarsString(buildColumnCssProps(style)) : "";
}

/** Style attribute fragment for a container. */
export function applyContainerStyleVars(style: ColumnStyleData | undefined): string {
	return style ? styleToVarsString(buildContainerCssProps(style)) : "";
}

/** CSS color value resolution for separator rendering (preview). */
export function resolveColor(name: StyleColorOptionOrCustom | undefined): string {
	return resolveColorValue(name ?? "gray");
}
