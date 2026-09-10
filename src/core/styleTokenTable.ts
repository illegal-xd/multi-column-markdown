/**
 * Style token table: the whole style vocabulary, one entry per token.
 *
 * Table order = serialization order (stable output matters for round-trip
 * tests and document diffs). Adding a token means adding one entry here plus
 * one test — validation primitives come from `styleValue.ts`.
 */
import type {ColumnStyleData} from "../types";
import {isBackgroundOptionOrCustom, isSeparatorStyle, isStyleColorOptionOrCustom, parseBoolean, parseCssSpacing} from "./styleValue";


/** A single style token: spelling in, style field set, token text out. */
export interface StyleTokenDef {
	/** Canonical key written by the serializer. */
	readonly key: string;
	/** Accepted alternate spellings in source. */
	readonly aliases?: readonly string[];
	apply(style: ColumnStyleData, value: string): void;
	serialize(style: ColumnStyleData): string | undefined;
}

type BooleanField = "showBorder" | "horizontalDividers" | "separator" | "leftBorder";
type SpacingField =
	| "padding"
	| "margin"
	| "marginLeft"
	| "marginTop"
	| "marginRight"
	| "marginBottom"
	| "gap"
	| "borderWidth"
	| "borderWidthLeft"
	| "borderWidthTop"
	| "borderWidthRight"
	| "borderWidthBottom"
	| "borderRadius"
	| "borderRadiusLeft"
	| "borderRadiusTop"
	| "borderRadiusRight"
	| "borderRadiusBottom";

function booleanDef(key: string, field: BooleanField, aliases?: readonly string[]): StyleTokenDef {
	return {
		key,
		aliases,
		apply: (style, value) => {
			const parsed = parseBoolean(value);
			if (parsed !== null) style[field] = parsed;
		},
		serialize: (style) => (style[field] === undefined ? undefined : style[field] ? "1" : "0"),
	};
}

function spacingDef(key: string, field: SpacingField, aliases?: readonly string[]): StyleTokenDef {
	return {
		key,
		aliases,
		apply: (style, value) => {
			const spacing = parseCssSpacing(value);
			if (spacing !== undefined) style[field] = spacing;
		},
		serialize: (style) => style[field],
	};
}

/**
 * Token table. Array order = serialization order (stable output matters for
 * round-trip tests and document diffs).
 */
export const STYLE_TOKEN_DEFS: readonly StyleTokenDef[] = [
	{
		key: "b",
		apply: (style, value) => {
			if (isBackgroundOptionOrCustom(value)) style.background = value;
		},
		serialize: (style) => style.background,
	},
	{
		key: "bc",
		apply: (style, value) => {
			if (isStyleColorOptionOrCustom(value)) style.borderColor = value;
		},
		serialize: (style) => style.borderColor,
	},
	{
		key: "t",
		aliases: ["tc"],
		apply: (style, value) => {
			if (isStyleColorOptionOrCustom(value)) style.textColor = value;
		},
		serialize: (style) => style.textColor,
	},
	booleanDef("sb", "showBorder"),
	booleanDef("hd", "horizontalDividers", ["h"]),
	booleanDef("sep", "separator"),
	{
		key: "sc",
		apply: (style, value) => {
			if (isStyleColorOptionOrCustom(value)) style.separatorColor = value;
		},
		serialize: (style) => style.separatorColor,
	},
	{
		key: "ss",
		apply: (style, value) => {
			if (isSeparatorStyle(value)) style.separatorStyle = value;
		},
		serialize: (style) => style.separatorStyle,
	},
	{
		key: "sw",
		apply: (style, value) => {
			const width = parseInt(value, 10);
			if (Number.isFinite(width) && width >= 1 && width <= 8) style.separatorWidth = width;
		},
		serialize: (style) => (style.separatorWidth === undefined ? undefined : String(style.separatorWidth)),
	},
	{
		key: "sx",
		apply: (style, value) => {
			if (value.length > 0 && value.length <= 3) style.separatorCustomChar = value;
		},
		serialize: (style) => style.separatorCustomChar,
	},
	booleanDef("lb", "leftBorder"),
	spacingDef("pd", "padding", ["pb"]), // "pb" tolerated as a common typo of "pd"
	spacingDef("ml", "marginLeft"),
	spacingDef("mt", "marginTop"),
	spacingDef("mr", "marginRight"),
	spacingDef("mb", "marginBottom"),
	spacingDef("m", "margin"),
	spacingDef("g", "gap"),
	{
		key: "ta",
		apply: (style, value) => {
			const align = value.trim().toLowerCase();
			if (align === "left" || align === "center" || align === "right") style.textAlign = align;
		},
		serialize: (style) => style.textAlign,
	},
	spacingDef("br", "borderRadius"),
	spacingDef("brl", "borderRadiusLeft"),
	spacingDef("brt", "borderRadiusTop"),
	spacingDef("brr", "borderRadiusRight"),
	spacingDef("brb", "borderRadiusBottom"),
	spacingDef("bw", "borderWidth"),
	spacingDef("bwl", "borderWidthLeft"),
	spacingDef("bwt", "borderWidthTop"),
	spacingDef("bwr", "borderWidthRight"),
	spacingDef("bwb", "borderWidthBottom"),
];
