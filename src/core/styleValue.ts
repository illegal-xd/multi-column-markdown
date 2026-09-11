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
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value.charAt(i);
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			if (depth > 0) depth--;
		} else if (depth === 0 && isSeparator(ch)) {
			// Slice whole segments instead of appending character by character:
			// the old `cur += ch` loop allocated a new string per character,
			// and this runs for every token of every column on every refresh.
			parts.push(value.slice(start, i));
			start = i + 1;
		}
	}
	if (start < value.length || parts.length === 0) parts.push(value.slice(start));
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
export interface ExpandedToken {
	key: string;
	value: string;
}

/**
 * Expand raw tokens into key/value pairs.
 *
 * - `b:secondary ml:10` → `b`=`secondary` + `ml`=`10`（同一 token 里夹带的另一个
 *   key 拆成独立条目）;
 * - `m:4 8 bw:2` → `m`=`4 8` + `bw`=`2`（多值简写整体保留）;
 * - spaces inside parentheses (`rgba(59, 130, 246, 0.12)`) are never split.
 *
 * Tokens with no usable `key:value` shape are dropped: they carry no style
 * information, and returning pairs means the caller never re-slices them.
 */
export function expandTokenEntries(tokens: ReadonlyArray<string>): ExpandedToken[] {
	const result: ExpandedToken[] = [];
	for (const token of tokens) {
		const sep = token.indexOf(":");
		if (sep <= 0) continue;
		const key = token.slice(0, sep).trim().toLowerCase();
		const value = token.slice(sep + 1).trim();
		if (value.length === 0) continue;

		if (value.includes(" ")) {
			const segments = splitTopLevelSpace(value);
			const extra: ExpandedToken[] = [];
			const kept: string[] = [];
			for (let i = 0; i < segments.length; i++) {
				const segment = segments[i];
				const segmentSep = segment.indexOf(":");
				if (segmentSep <= 0) {
					kept.push(segment);
				} else if (i > 0) {
					extra.push({
						key: segment.slice(0, segmentSep).trim().toLowerCase(),
						value: segment.slice(segmentSep + 1).trim(),
					});
				}
			}
			if (extra.length > 0) {
				result.push({key, value: kept.join(" ")});
				result.push(...extra);
				continue;
			}
		}
		result.push({key, value});
	}
	return result;
}
