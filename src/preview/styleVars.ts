/**
 * Style → CSS variable record builders (DOM-free, for the markdown-it
 * preview renderer which has no element access).
 */
import {resolveBackground, resolveColorValue, expandSpacingShorthand} from "../core/style";
import type {ColumnStyleData, StyleColorOptionOrCustom} from "../types";

export function buildColumnStyleVars(parsed: ColumnStyleData): Record<string, string> {
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
			cssProps["--columns-col-border-color"] = resolveColorValue(parsed.borderColor ?? "gray");
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

export function buildContainerStyleVars(parsed: ColumnStyleData): Record<string, string> {
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
			cssProps["--columns-block-border-color"] = resolveColorValue(parsed.borderColor ?? "gray");
			const showBorder = parsed.showBorder ?? (parsed.borderColor !== undefined || parsed.borderWidth !== undefined);
			cssProps["--columns-block-border-width"] = parsed.borderWidth ?? (showBorder ? "1px" : "0px");
		}
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
export function resolveColor(name: StyleColorOptionOrCustom | undefined): string {
	return resolveColorValue(name ?? "gray");
}
