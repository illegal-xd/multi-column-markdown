/**
 * Marker payload parsing: `col-break:40,stk:1,b:secondary` →
 * `{width, style, stacked}`, `col-start:l:stack,b:alt` →
 * `{containerStyle, layout}`.
 *
 * Bridges the structural scanner (`parser.ts`) and the style-token vocabulary
 * (`styleTokens.ts`): it splits a payload into the few structural fields the
 * scanner needs and hands the rest to the style parser.
 */
import type {ColumnLayout, ColumnStyleData} from "../types";
import {parseBoolean, parseStyleTokens, splitTopLevelComma} from "./styleTokens";

const LAYOUT_VALUES: ReadonlySet<string> = new Set(["row", "stack"]);

/**
 * Bare `col-start` token that turns on the responsive layout. A flag, not a
 * style token — `responsive:1` is deliberately *not* accepted, so a typo can
 * never silently change a document's layout.
 */
export const RESPONSIVE_TOKEN = "responsive";

/**
 * Case-insensitive bare-token test. The length guard runs first so the style
 * tokens that make up most payloads (`b:secondary`, `pd:4 8`) never allocate
 * a lower-cased copy — this check runs per token on every preview refresh.
 */
export function isResponsiveToken(token: string): boolean {
	return token.length === RESPONSIVE_TOKEN.length && token.toLowerCase() === RESPONSIVE_TOKEN;
}

function isColumnLayout(value: string): value is ColumnLayout {
	return LAYOUT_VALUES.has(value);
}

/**
 * Split a payload into trimmed, non-empty tokens in a single pass. The
 * `.map().filter()` chain this replaces allocated three arrays per payload,
 * and every column of every preview refresh parses a payload.
 */
function splitTokens(payload: string): string[] {
	const parts = splitTopLevelComma(payload);
	const tokens: string[] = [];
	for (const part of parts) {
		const token = part.trim();
		if (token.length > 0) tokens.push(token);
	}
	return tokens;
}

/** Parse a `col-break` payload into width / style / stacked-group. */
export function parseBreakPayload(payload: string | undefined): {
	width: number;
	style?: ColumnStyleData;
	stacked?: number;
} {
	if (!payload) return {width: 0};
	const tokens = splitTokens(payload);
	if (tokens.length === 0) return {width: 0};

	let width = 0;
	let stacked: number | undefined;
	let firstTokenHandled = false;
	const styleTokens: string[] = [];

	for (const token of tokens) {
		if (!firstTokenHandled) {
			firstTokenHandled = true;
			if (/^\d+$/.test(token)) {
				width = Math.max(0, Math.min(100, parseInt(token, 10)));
				continue;
			}
			if (token.startsWith("w:")) {
				const maybeWidth = parseInt(token.slice(2), 10);
				if (Number.isFinite(maybeWidth) && maybeWidth > 0) {
					width = Math.max(0, Math.min(100, maybeWidth));
					continue;
				}
			}
		}
		if (token.startsWith("stk:")) {
			const raw = token.slice(4);
			// Support boolean values for backward compatibility
			const boolVal = parseBoolean(raw);
			if (boolVal !== null) {
				stacked = boolVal ? 1 : 0;
			} else {
				// Numeric stack group ID
				const numVal = parseInt(raw, 10);
				if (Number.isFinite(numVal) && numVal >= 0) {
					stacked = numVal;
				}
			}
			continue;
		}
		styleTokens.push(token);
	}

	const style = parseStyleTokens(styleTokens);
	const result: {width: number; style?: ColumnStyleData; stacked?: number} = {width};
	if (style) result.style = style;
	if (stacked && stacked > 0) result.stacked = stacked;
	return result;
}

/** Parse a `col-start` payload into container style / layout / responsive. */
export function parseStartPayload(payload: string | undefined): {
	containerStyle?: ColumnStyleData;
	layout?: ColumnLayout;
	responsive?: boolean;
} {
	if (!payload) return {};
	const tokens = splitTokens(payload);
	if (tokens.length === 0) return {};

	let layout: ColumnLayout | undefined;
	let responsive = false;
	const styleTokens: string[] = [];
	for (const token of tokens) {
		if (token.startsWith("l:")) {
			const value = token.slice(2).trim();
			if (isColumnLayout(value)) layout = value;
		} else if (isResponsiveToken(token)) {
			responsive = true;
		} else {
			styleTokens.push(token);
		}
	}
	const containerStyle = parseStyleTokens(styleTokens);
	const result: {containerStyle?: ColumnStyleData; layout?: ColumnLayout; responsive?: boolean} = {
		containerStyle,
		layout,
	};
	if (responsive) result.responsive = true;
	return result;
}
