/**
 * Style-token API: `b:secondary`, `pd:4 8`, `ss:dashed`, ...
 *
 * The vocabulary itself lives in `styleTokenTable.ts` and the value
 * primitives in `styleValue.ts`; this module is the entry point callers use
 * (parse a token list, serialize a style back to tokens) and re-exports the
 * pieces other modules depend on, so nobody has to know the split.
 *
 * Structure scanning (`markers.ts` / `parser.ts`) knows nothing about style
 * semantics; it only hands the raw token strings over.
 */
import type {ColumnStyleData} from "../types";
import {expandTokenEntries} from "./styleValue";
import {STYLE_TOKEN_DEFS, type StyleTokenDef} from "./styleTokenTable";

export {
	isBackgroundOptionOrCustom,
	isCssColorLiteral,
	isSeparatorStyle,
	isStyleColorOptionOrCustom,
	parseBoolean,
	parseCssSpacing,
	splitTopLevelComma,
} from "./styleValue";
export {STYLE_TOKEN_DEFS, type StyleTokenDef} from "./styleTokenTable";

const STYLE_TOKEN_BY_KEY: ReadonlyMap<string, StyleTokenDef> = (() => {
	const map = new Map<string, StyleTokenDef>();
	for (const def of STYLE_TOKEN_DEFS) {
		map.set(def.key, def);
		for (const alias of def.aliases ?? []) map.set(alias, def);
	}
	return map;
})();

/** Parse a list of raw style tokens into a style object, or undefined. */
export function parseStyleTokens(tokens: ReadonlyArray<string>): ColumnStyleData | undefined {
	let style: ColumnStyleData | undefined;
	// `expandTokenEntries` already resolved key/value, so this loop never
	// re-slices the raw token (this used to happen twice per token).
	for (const {key, value} of expandTokenEntries(tokens)) {
		const def = STYLE_TOKEN_BY_KEY.get(key);
		if (!def) continue;
		if (!style) style = {};
		def.apply(style, value);
	}
	return style && Object.keys(style).length > 0 ? style : undefined;
}

/** Serialize a style object back into canonical tokens (table order). */
export function serializeStyleTokens(style: ColumnStyleData | undefined): string[] {
	if (!style) return [];
	const tokens: string[] = [];
	for (const def of STYLE_TOKEN_DEFS) {
		const value = def.serialize(style);
		if (value !== undefined) tokens.push(`${def.key}:${value}`);
	}
	return tokens;
}
