/**
 * Style token → CSS mapping.
 *
 * Ported from amatya-aditya/advanced-multi-column (AGPL-3.0). Obsidian CSS
 * variables are mapped onto VSCode theme tokens so both the column editor
 * webview and the native markdown preview follow the active theme.
 */
import type {BackgroundOptionOrCustom, ColumnBackgroundOption, ColumnStyleData, StyleColorOption, StyleColorOptionOrCustom} from "../types";
import {BACKGROUND_CSS, COLOR_CSS} from "./palette";
import {isBackgroundOptionOrCustom, isStyleColorOptionOrCustom} from "./styleTokens";
import {buildColumnCssProps, buildContainerCssProps} from "./styleCssVars";

export {BACKGROUND_CSS, COLOR_CSS, HEADER_BORDER_CSS} from "./palette";
export {buildColumnCssProps, buildContainerCssProps, expandSpacingShorthand} from "./styleCssVars";

const COLUMN_STYLE_VAR_KEYS = [
	"--columns-col-bg",
	"--columns-col-text",
	"--columns-col-border-color",
	"--columns-col-border-width",
	"--columns-col-horizontal-width",
	"--columns-col-sep-color",
	"--columns-col-sep-width",
	"--columns-col-sep-style",
	"--columns-col-padding",
	"--columns-col-ml",
	"--columns-col-mt",
	"--columns-col-mr",
	"--columns-col-mb",
	"--columns-col-margin",
	"--columns-col-text-align",
	"--columns-col-radius",
	"--columns-col-radius-tl",
	"--columns-col-radius-tr",
	"--columns-col-radius-br",
	"--columns-col-radius-bl",
	"--columns-col-border-width-l",
	"--columns-col-border-width-t",
	"--columns-col-border-width-r",
	"--columns-col-border-width-b",
] as const;

const CONTAINER_STYLE_VAR_KEYS = [
	"--columns-block-bg",
	"--columns-block-text",
	"--columns-block-border-color",
	"--columns-block-border-width",
	"--columns-block-horizontal-width",
] as const;

const SEPARATOR_STYLE_VALUES = new Set<string>(["solid", "dashed", "dotted", "double", "custom"]);

/** Resolve a background value: palette key → CSS value, custom color → pass through. */
export function resolveBackground(value: BackgroundOptionOrCustom): string {
	return BACKGROUND_CSS[value as ColumnBackgroundOption] ?? value;
}

/** Resolve a color value: palette key → CSS value, custom color → pass through. */
export function resolveColorValue(value: StyleColorOptionOrCustom): string {
	return COLOR_CSS[value as StyleColorOption] ?? value;
}

/** Color fields validated with a palette/hex guard. */
const COLOR_FIELDS: ReadonlyArray<{field: string; guard: (v: string) => boolean}> = [
	{field: "background", guard: (v) => isBackgroundOptionOrCustom(v)},
	{field: "borderColor", guard: (v) => isStyleColorOptionOrCustom(v)},
	{field: "textColor", guard: (v) => isStyleColorOptionOrCustom(v)},
	{field: "separatorColor", guard: (v) => isStyleColorOptionOrCustom(v)},
];

/** Boolean toggle fields. */
const BOOLEAN_FIELDS: ReadonlyArray<string> = [
	"showBorder", "horizontalDividers", "separator", "leftBorder",
];

/** Non-empty string fields (shorthand + per-side border/radius). */
const STRING_FIELDS: ReadonlyArray<string> = [
	"margin", "borderWidth", "borderRadius",
	"borderWidthLeft", "borderWidthTop", "borderWidthRight", "borderWidthBottom",
	"borderRadiusLeft", "borderRadiusTop", "borderRadiusRight", "borderRadiusBottom",
];

/**
 * Validate an unknown object into a {@link ColumnStyleData}, discarding
 * unknown or malformed fields. Table-driven: each category shares a loop,
 * with the four special-cased fields handled individually.
 */
export function toStyleData(style: unknown): ColumnStyleData | null {
	if (typeof style !== "object" || style === null) return null;
	const record = style as Record<string, unknown>;
	const parsed: ColumnStyleData = {};
	const sink = parsed as Record<string, unknown>;

	for (const {field, guard} of COLOR_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && guard(value)) sink[field] = value;
	}
	for (const field of BOOLEAN_FIELDS) {
		if (typeof record[field] === "boolean") sink[field] = record[field];
	}
	for (const field of STRING_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value.length > 0) sink[field] = value;
	}
	applySpecialStyleFields(record, parsed);

	return Object.keys(parsed).length > 0 ? parsed : null;
}

/** Fields whose validation does not fit a generic table (type/range/enum). */
function applySpecialStyleFields(record: Record<string, unknown>, parsed: ColumnStyleData): void {
	const separatorStyle = record.separatorStyle;
	if (typeof separatorStyle === "string" && SEPARATOR_STYLE_VALUES.has(separatorStyle)) {
		parsed.separatorStyle = separatorStyle as ColumnStyleData["separatorStyle"];
	}
	const separatorWidth = record.separatorWidth;
	if (typeof separatorWidth === "number" && separatorWidth >= 1 && separatorWidth <= 8) {
		parsed.separatorWidth = separatorWidth;
	}
	const separatorCustomChar = record.separatorCustomChar;
	if (typeof separatorCustomChar === "string" && separatorCustomChar.length > 0 && separatorCustomChar.length <= 3) {
		parsed.separatorCustomChar = separatorCustomChar;
	}
	const textAlign = record.textAlign;
	if (textAlign === "left" || textAlign === "center" || textAlign === "right") {
		parsed.textAlign = textAlign;
	}
}

export function hasColumnStyle(style: unknown): boolean {
	return toStyleData(style) !== null;
}

/**
 * Apply a style to an element: clear the variable slots the builder owns,
 * then (if the style is non-empty) write the builder's variables and tag the
 * `columns-custom-style` class so the CSS picks them up.
 */
function applyStyleVars(
	element: HTMLElement,
	style: unknown,
	varKeysToClear: ReadonlyArray<string>,
	cssBuilder: (parsed: ColumnStyleData) => Record<string, string>,
): void {
	const clearProps: Record<string, string> = {};
	for (const key of varKeysToClear) clearProps[key] = "";
	applyCssProps(element, clearProps);

	const parsed = toStyleData(style);
	if (!parsed) {
		element.classList.remove("columns-custom-style");
		return;
	}

	element.classList.add("columns-custom-style");
	applyCssProps(element, cssBuilder(parsed));
}

/** Set multiple CSS custom properties on an element. */
export function applyCssProps(element: HTMLElement, props: Record<string, string>): void {
	for (const [key, value] of Object.entries(props)) {
		element.style.setProperty(key, value);
	}
}

export function applyColumnStyle(element: HTMLElement, style: unknown): void {
	applyStyleVars(element, style, COLUMN_STYLE_VAR_KEYS, buildColumnCssProps);
	const parsed = toStyleData(style);
	element.classList.toggle("columns-left-border", !!parsed?.leftBorder);
}

export function applyContainerStyle(element: HTMLElement, style: unknown): void {
	applyStyleVars(
		element,
		style,
		CONTAINER_STYLE_VAR_KEYS,
		buildContainerCssProps,
	);
}
