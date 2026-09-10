/**
 * Style token → CSS mapping.
 *
 * Ported from amatya-aditya/advanced-multi-column (AGPL-3.0). Obsidian CSS
 * variables are mapped onto VSCode theme tokens so both the column editor
 * webview and the native markdown preview follow the active theme.
 */
import type {BackgroundOptionOrCustom, ColumnBackgroundOption, ColumnStyleData, StyleColorOption, StyleColorOptionOrCustom} from "../types";
import {isCssColorLiteral} from "./parser";

export const BACKGROUND_CSS: Record<ColumnBackgroundOption, string> = {
	transparent: "transparent",
	primary: "var(--vscode-editor-background)",
	secondary: "var(--vscode-sideBar-background)",
	alt: "var(--vscode-editorWidget-background)",
	"accent-soft": "color-mix(in srgb, var(--vscode-button-background) 14%, transparent)",
	"red-soft": "rgba(239, 68, 68, 0.14)",
	"orange-soft": "rgba(245, 158, 11, 0.14)",
	"yellow-soft": "rgba(234, 179, 8, 0.14)",
	"green-soft": "rgba(34, 197, 94, 0.14)",
	"cyan-soft": "rgba(6, 182, 212, 0.14)",
	"blue-soft": "rgba(59, 130, 246, 0.14)",
	"pink-soft": "rgba(236, 72, 153, 0.14)",
};

/** Solid/opaque colors that correspond to each soft background – used for
 *  the left-border accent stripe so it reads like a callout. */
export const HEADER_BORDER_CSS: Record<string, string> = {
	"accent-soft": "var(--vscode-button-background)",
	"red-soft": "#ef4444",
	"orange-soft": "#f59e0b",
	"yellow-soft": "#eab308",
	"green-soft": "#22c55e",
	"cyan-soft": "#06b6d4",
	"blue-soft": "#3b82f6",
	"pink-soft": "#ec4899",
	secondary: "var(--vscode-panel-border)",
	alt: "var(--vscode-panel-border)",
	primary: "var(--vscode-panel-border)",
};

export const COLOR_CSS: Record<StyleColorOption, string> = {
	transparent: "transparent",
	gray: "var(--vscode-panel-border)",
	accent: "var(--vscode-button-background)",
	muted: "var(--vscode-descriptionForeground)",
	text: "var(--vscode-editor-foreground)",
	red: "#ef4444",
	orange: "#f59e0b",
	yellow: "#eab308",
	green: "#22c55e",
	cyan: "#06b6d4",
	blue: "#3b82f6",
	pink: "#ec4899",
};

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

function hasOwnKey<T extends object>(obj: T, key: PropertyKey): key is keyof T {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Palette key or custom CSS color literal (#hex / rgb() / rgba()). */
function isBackgroundOptionOrCustom(value: string): value is BackgroundOptionOrCustom {
	return hasOwnKey(BACKGROUND_CSS, value) || isCssColorLiteral(value);
}

function isStyleColorOptionOrCustom(value: string): value is StyleColorOptionOrCustom {
	return hasOwnKey(COLOR_CSS, value) || isCssColorLiteral(value);
}

export function toStyleData(style: unknown): ColumnStyleData | null {
	if (typeof style !== "object" || style === null) return null;

	const record = style as Record<string, unknown>;
	const parsed: ColumnStyleData = {};

	const background = record.background;
	if (typeof background === "string" && isBackgroundOptionOrCustom(background)) {
		parsed.background = background;
	}

	const borderColor = record.borderColor;
	if (typeof borderColor === "string" && isStyleColorOptionOrCustom(borderColor)) {
		parsed.borderColor = borderColor;
	}

	const textColor = record.textColor;
	if (typeof textColor === "string" && isStyleColorOptionOrCustom(textColor)) {
		parsed.textColor = textColor;
	}

	if (typeof record.showBorder === "boolean") {
		parsed.showBorder = record.showBorder;
	}

	if (typeof record.horizontalDividers === "boolean") {
		parsed.horizontalDividers = record.horizontalDividers;
	}

	if (typeof record.separator === "boolean") {
		parsed.separator = record.separator;
	}

	const separatorColor = record.separatorColor;
	if (typeof separatorColor === "string" && isStyleColorOptionOrCustom(separatorColor)) {
		parsed.separatorColor = separatorColor;
	}

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

	if (typeof record.leftBorder === "boolean") {
		parsed.leftBorder = record.leftBorder;
	}

	const textAlign = record.textAlign;
	if (textAlign === "left" || textAlign === "center" || textAlign === "right") {
		parsed.textAlign = textAlign;
	}

	const borderRadius = record.borderRadius;
	if (typeof borderRadius === "string" && borderRadius.length > 0) {
		parsed.borderRadius = borderRadius;
	}

	const margin = record.margin;
	if (typeof margin === "string" && margin.length > 0) {
		parsed.margin = margin;
	}

	const borderWidth = record.borderWidth;
	if (typeof borderWidth === "string" && borderWidth.length > 0) {
		parsed.borderWidth = borderWidth;
	}

	for (const key of ["borderWidthLeft", "borderWidthTop", "borderWidthRight", "borderWidthBottom", "borderRadiusLeft", "borderRadiusTop", "borderRadiusRight", "borderRadiusBottom"] as const) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) {
			parsed[key] = value;
		}
	}

	return Object.keys(parsed).length > 0 ? parsed : null;
}

export function hasColumnStyle(style: unknown): boolean {
	return toStyleData(style) !== null;
}

/**
 * Expand a CSS 1–4 value spacing shorthand ("4 8", "1px 2px 3px 4px") into
 * per-side single values, following the CSS box-model rules:
 *   1 value  → all sides
 *   2 values → top/bottom, right/left
 *   3 values → top, right/left, bottom
 *   4 values → top, right, bottom, left
 *
 * Used to feed per-side CSS custom properties so longhand `var()` chains
 * never receive a multi-value shorthand (which would be invalid at
 * computed-value time and fall back to the property's initial value).
 */
export function expandSpacingShorthand(value: string): {top: string; right: string; bottom: string; left: string} {
	const parts = value.split(/\s+/).filter((p) => p.length > 0);
	const top = parts[0] ?? "0";
	const right = parts[1] ?? top;
	const bottom = parts[2] ?? top;
	const left = parts[3] ?? right;
	return {top, right, bottom, left};
}

export function buildColumnCssProps(parsed: ColumnStyleData): Record<string, string> {
	const cssProps: Record<string, string> = {};

	if (parsed.background) {
		cssProps["--columns-col-bg"] = resolveBackground(parsed.background);
	}
	if (parsed.textColor) {
		cssProps["--columns-col-text"] = resolveColorValue(parsed.textColor);
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
		const showHorizontal = parsed.horizontalDividers ?? false;
		if (showHorizontal) cssProps["--columns-col-horizontal-width"] = "1px";

		// 显式 sb:0 关闭边框：不输出任何边框宽度/颜色变量（per-side 亦不复活）。
		if (parsed.showBorder !== false) {
			const effectiveBorderColor = resolveColorValue(parsed.borderColor ?? "gray");
			cssProps["--columns-col-border-color"] = effectiveBorderColor;
			// 宽度权重：显式 bw: 简写 > 显式 sb:1/bc:（无 per-side 时默认 1px）> per-side 单独
			// （其他方向保持 0px，仅指定方向有边框——避免默认 1px 边框污染渲染）。
			const hasPerSideWidth =
				parsed.borderWidthLeft !== undefined ||
				parsed.borderWidthTop !== undefined ||
				parsed.borderWidthRight !== undefined ||
				parsed.borderWidthBottom !== undefined;
			const hasExplicitBorder =
				parsed.borderWidth !== undefined ||
				(!hasPerSideWidth && (parsed.showBorder === true || parsed.borderColor !== undefined));
			cssProps["--columns-col-border-width"] = parsed.borderWidth ?? (hasExplicitBorder ? "1px" : "0px");
			// 多值简写（如 bw:0 2）必须展开为单边变量：longhand var() 链不能收到多值
			// （否则 invalid at computed-value time → 属性回退到 initial 值，边框全乱）。
			// hd 开启时顶/底由水平线宽度控制，不展开 bw 的 t/b（除非显式 bwt/bwb）。
			if (parsed.borderWidth) {
				const sides = expandSpacingShorthand(parsed.borderWidth);
				cssProps["--columns-col-border-width-l"] = parsed.borderWidthLeft ?? sides.left;
				cssProps["--columns-col-border-width-r"] = parsed.borderWidthRight ?? sides.right;
				if (!showHorizontal) {
					cssProps["--columns-col-border-width-t"] = parsed.borderWidthTop ?? sides.top;
					cssProps["--columns-col-border-width-b"] = parsed.borderWidthBottom ?? sides.bottom;
				} else {
					if (parsed.borderWidthTop) cssProps["--columns-col-border-width-t"] = parsed.borderWidthTop;
					if (parsed.borderWidthBottom) cssProps["--columns-col-border-width-b"] = parsed.borderWidthBottom;
				}
			} else {
				if (parsed.borderWidthLeft) cssProps["--columns-col-border-width-l"] = parsed.borderWidthLeft;
				if (parsed.borderWidthTop) cssProps["--columns-col-border-width-t"] = parsed.borderWidthTop;
				if (parsed.borderWidthRight) cssProps["--columns-col-border-width-r"] = parsed.borderWidthRight;
				if (parsed.borderWidthBottom) cssProps["--columns-col-border-width-b"] = parsed.borderWidthBottom;
			}
		}
	}

	if (parsed.separator) {
		cssProps["--columns-col-sep-color"] = resolveColorValue(parsed.separatorColor ?? "gray");
		cssProps["--columns-col-sep-width"] = `${parsed.separatorWidth ?? 1}px`;
		if (parsed.separatorStyle && parsed.separatorStyle !== "custom") {
			cssProps["--columns-col-sep-style"] = parsed.separatorStyle;
		}
	}

	if (parsed.padding) cssProps["--columns-col-padding"] = parsed.padding;
	// m: 简写展开为单边变量（多值不能落入 longhand var() 链，否则 invalid → 全 0）。
	if (parsed.margin) {
		const sides = expandSpacingShorthand(parsed.margin);
		cssProps["--columns-col-margin"] = parsed.margin;
		cssProps["--columns-col-ml"] = parsed.marginLeft ?? sides.left;
		cssProps["--columns-col-mt"] = parsed.marginTop ?? sides.top;
		cssProps["--columns-col-mr"] = parsed.marginRight ?? sides.right;
		cssProps["--columns-col-mb"] = parsed.marginBottom ?? sides.bottom;
	} else {
		if (parsed.marginLeft) cssProps["--columns-col-ml"] = parsed.marginLeft;
		if (parsed.marginTop) cssProps["--columns-col-mt"] = parsed.marginTop;
		if (parsed.marginRight) cssProps["--columns-col-mr"] = parsed.marginRight;
		if (parsed.marginBottom) cssProps["--columns-col-mb"] = parsed.marginBottom;
	}
	if (parsed.textAlign) cssProps["--columns-col-text-align"] = parsed.textAlign;
	// br: 简写展开为四角变量（多值不能落入 longhand var() 链，否则角变 0px）。
	if (parsed.borderRadius) {
		const s = expandSpacingShorthand(parsed.borderRadius);
		cssProps["--columns-col-radius"] = parsed.borderRadius;
		let tl = s.top;
		let tr = s.right;
		let br2 = s.bottom;
		let bl = s.left;
		// Per-side radii: l/t/r/b each cover the two corners of that edge.
		if (parsed.borderRadiusLeft) {
			tl = parsed.borderRadiusLeft;
			bl = parsed.borderRadiusLeft;
		}
		if (parsed.borderRadiusTop) {
			tl = parsed.borderRadiusTop;
			tr = parsed.borderRadiusTop;
		}
		if (parsed.borderRadiusRight) {
			tr = parsed.borderRadiusRight;
			br2 = parsed.borderRadiusRight;
		}
		if (parsed.borderRadiusBottom) {
			bl = parsed.borderRadiusBottom;
			br2 = parsed.borderRadiusBottom;
		}
		cssProps["--columns-col-radius-tl"] = tl;
		cssProps["--columns-col-radius-tr"] = tr;
		cssProps["--columns-col-radius-br"] = br2;
		cssProps["--columns-col-radius-bl"] = bl;
	} else {
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
	}

	// 左边界模式（lb:1）：宽度尊重显式 bwl/bw，默认 3px（callout 风格）。
	if (parsed.leftBorder) {
		cssProps["--columns-left-border-width"] = parsed.borderWidthLeft ?? parsed.borderWidth ?? "3px";
	}

	return cssProps;
}

export function buildContainerCssProps(parsed: ColumnStyleData): Record<string, string> {
	const cssProps: Record<string, string> = {};

	if (parsed.background) {
		cssProps["--columns-block-bg"] = resolveBackground(parsed.background);
	}
	if (parsed.textColor) {
		cssProps["--columns-block-text"] = resolveColorValue(parsed.textColor);
	}

	const hasBorderSignals =
		parsed.showBorder !== undefined ||
		parsed.horizontalDividers !== undefined ||
		parsed.borderColor !== undefined ||
		parsed.borderWidth !== undefined;

	if (hasBorderSignals) {
		const showHorizontal = parsed.horizontalDividers ?? false;
		if (showHorizontal) cssProps["--columns-block-horizontal-width"] = "1px";

		// 显式 sb:0 关闭容器边框：不输出边框变量。
		if (parsed.showBorder !== false) {
			const effectiveBorderColor = resolveColorValue(parsed.borderColor ?? "gray");
			cssProps["--columns-block-border-color"] = effectiveBorderColor;
			const showBorder = parsed.showBorder ?? (parsed.borderColor !== undefined || parsed.borderWidth !== undefined);
			cssProps["--columns-block-border-width"] = parsed.borderWidth ?? (showBorder ? "1px" : "0px");
		}
	}

	if (parsed.gap) cssProps["--columns-block-gap"] = parsed.gap;

	return cssProps;
}

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
