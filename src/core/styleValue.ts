/**
 * Style value vocabulary: the color/boolean/spacing primitives shared by the
 * token table (`styleTokenTable.ts`) and the token API (`styleTokens.ts`).
 *
 * Deliberately free of dependencies on the token table so the table can build
 * on it without an import cycle.
 */
import type {
	BackgroundOptionOrCustom,
	SeparatorLineStyle,
	StyleColorOptionOrCustom,
} from "../types";
import {BACKGROUND_CSS, COLOR_CSS} from "./palette";

const BACKGROUND_OPTIONS: ReadonlySet<string> = new Set(Object.keys(BACKGROUND_CSS));
const STYLE_COLOR_OPTIONS: ReadonlySet<string> = new Set(Object.keys(COLOR_CSS));
const SEPARATOR_STYLE_OPTIONS: ReadonlySet<string> = new Set(["solid", "dashed", "dotted", "double", "custom"]);

export function isBackgroundOptionOrCustom(value: string): value is BackgroundOptionOrCustom {
	return BACKGROUND_OPTIONS.has(value) || isCssColorLiteral(value);
}

export function isStyleColorOptionOrCustom(value: string): value is StyleColorOptionOrCustom {
	return STYLE_COLOR_OPTIONS.has(value) || isCssColorLiteral(value);
}

export function isSeparatorStyle(value: string): value is SeparatorLineStyle {
	return SEPARATOR_STYLE_OPTIONS.has(value);
}

/**
 * User-supplied CSS color literal: #hex (3/4/6/8 digits). rgb()/rgba() is
 * intentionally NOT accepted (token separator conflicts with the commas and
 * spaces inside the function) — hex covers the same use cases cleanly.
 */
export function isCssColorLiteral(value: string): boolean {
	return /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

/** Toggle spellings accepted by `sb:`/`hd:`/`sep:`/`lb:`. */
export function parseBoolean(value: string): boolean | null {
	switch (value.toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return null;
	}
}

/**
 * Parse a CSS spacing value: bare numbers become px ("8" → "8px"),
 * multi-value shorthand keeps its structure ("4 8" → "4px 8px"),
 * unit-ed values pass through ("0.5em", "10%").
 */
export function parseCssSpacing(value: string): string | undefined {
	const parts = value.split(/\s+/).filter((p) => p.length > 0);
	if (parts.length === 0) return undefined;
	const converted = parts.map((p) => (/^\d+(\.\d+)?$/.test(p) ? `${p}px` : p));
	return converted.join(" ");
}

/**
 * Split a value on top-level commas (full-width or ASCII) only — commas
 * inside parentheses (e.g. `t:rgba(255,255,255,0.9)`) are kept intact so
 * custom color functions survive token splitting.
 */
export function splitTopLevelComma(payload: string): string[] {
	return splitTopLevel(payload, (ch) => ch === "," || ch === "，");
}

/**
 * Split a value on top-level whitespace only — spaces inside parentheses
 * (e.g. `rgba(59, 130, 246, 0.12)`) are kept intact so multi-value spacing
 * tokens and custom color functions survive expansion.
 */
function splitTopLevelSpace(value: string): string[] {
	return splitTopLevel(value, (ch) => /\s/.test(ch));
}

function splitTopLevel(value: string, isSeparator: (ch: string) => boolean): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of value) {
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth = Math.max(0, depth - 1);
		}
		if (isSeparator(ch) && depth === 0) {
			parts.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.length > 0 || parts.length === 0) parts.push(cur);
	return parts;
}

/**
 * Tolerate sloppy token separators:
 * - `b:secondary ml:10` (space-separated, values without spaces) is split
 *   into separate tokens; multi-value spacing tokens like `pd:4 8` are
 *   preserved (their extra segments carry no colon).
 * - Mixed forms keep the multi-value part: `m:4 8 bw:2` → `m:4 8` + `bw:2`.
 * - Spaces inside parentheses (`rgba(59, 130, 246, 0.12)`) are never split.
 */
export function expandTokenList(tokens: ReadonlyArray<string>): string[] {
	const result: string[] = [];
	for (const token of tokens) {
		const sep = token.indexOf(":");
		if (sep <= 0) {
			result.push(token);
			continue;
		}
		const key = token.slice(0, sep).trim().toLowerCase();
		const value = token.slice(sep + 1).trim();
		if (value.includes(" ")) {
			const segments = splitTopLevelSpace(value);
			const extra = segments.slice(1).filter((s) => s.includes(":"));
			if (extra.length > 0) {
				// "b:secondary ml:10" → "b:secondary" + "ml:10"
				// "m:4 8 bw:2" → "m:4 8" + "bw:2"（多值部分整体保留）
				const kept = segments.filter((s) => !s.includes(":"));
				result.push(`${key}:${kept.join(" ")}`);
				result.push(...extra);
				continue;
			}
		}
		result.push(token);
	}
	return result;
}
