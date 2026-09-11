/**
 * Marker-line surgery: rewrite a single  / 
 * payload while keeping every byte the caller did not ask to change.
 *
 * Splicing the payload substring (instead of regenerating the line) is what
 * makes the edit lossless: prefix/suffix spacing, token order, the separator
 * style (comma / full-width comma) and unknown tokens all survive. The
 * structural operations built on top of this live in `patch.ts`.
 */
import type {ColumnRegion, ColumnStyleData} from "../types";
import {isResponsiveToken, RESPONSIVE_TOKEN} from "./regionPayload";
import {STYLE_TOKEN_DEFS, serializeStyleTokens} from "./styleTokens";

export interface TextEdit {
	from: number;
	to: number;
	text: string;
}

/** Fields a caller may change on a `%% col-break %%` line. */
export interface ColumnMarkerUpdate {
	/** Width in percent; `0` removes the width token. */
	widthPercent?: number;
	/** Stack group id; `null` removes the token. */
	stacked?: number | null;
	/** Replacement style; an empty object clears all style tokens. */
	style?: ColumnStyleData;
}

/** Fields a caller may change on a `%% col-start %%` line. */
export interface ContainerMarkerUpdate {
	style?: ColumnStyleData;
	/** `"row"` removes an explicit `l:` token. */
	layout?: "row" | "stack";
	/** `true` ensures the bare `responsive` token, `false` removes it; `undefined` leaves it untouched. */
	responsive?: boolean;
}

const STYLE_KEYS: ReadonlySet<string> = (() => {
	const keys = new Set<string>();
	for (const def of STYLE_TOKEN_DEFS) {
		keys.add(def.key);
		for (const alias of def.aliases ?? []) keys.add(alias);
	}
	return keys;
})();

const MARKER_LINE_PATTERNS = {
	break: /^([ \t]*%%[ \t]*col-break)([ \t]*:([\s\S]*?))?([ \t]*%%[ \t]*)$/d,
	start: /^([ \t]*%%[ \t]*col-start)([ \t]*:([\s\S]*?))?([ \t]*%%[ \t]*)$/d,
} as const;

interface MarkerLineParts {
	/** Marker name plus any formatting before the `:` (verbatim). */
	prefix: string;
	/** ` %%` and whatever formatting followed the payload (verbatim). */
	suffix: string;
	/** Raw payload without the leading `:`. */
	payload: string;
}

function parseMarkerLine(line: string, kind: keyof typeof MARKER_LINE_PATTERNS): MarkerLineParts | null {
	const match = MARKER_LINE_PATTERNS[kind].exec(line);
	if (!match || !match.indices) return null;
	const prefixEnd = match.indices[1]![1];
	const payloadRange = match.indices[3];
	return {
		prefix: line.slice(0, prefixEnd),
		suffix: line.slice(payloadRange ? payloadRange[1] : prefixEnd),
		payload: payloadRange ? line.slice(payloadRange[0], payloadRange[1]) : "",
	};
}

interface PayloadSplit {
	pieces: string[];
	separators: string[];
}

/** Split a payload on top-level commas, keeping the exact separators. */
function splitPayload(payload: string): PayloadSplit {
	const pieces: string[] = [];
	const separators: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of payload) {
		if (ch === "(") depth++;
		else if (ch === ")") depth = Math.max(0, depth - 1);
		if (depth === 0 && (ch === "," || ch === "，")) {
			pieces.push(current);
			separators.push(ch);
			current = "";
			continue;
		}
		current += ch;
	}
	pieces.push(current);
	return {pieces, separators};
}

function tokenKey(piece: string): string | null {
	const sep = piece.indexOf(":");
	if (sep <= 0) return null;
	const key = piece.slice(0, sep).trim().toLowerCase();
	return /^[a-z]+$/.test(key) ? key : null;
}

function isWidthPiece(piece: string, isFirst: boolean): boolean {
	const key = tokenKey(piece);
	if (key === "w") return true;
	return isFirst && /^\s*\d+\s*$/.test(piece);
}

function joinPieces(pieces: ReadonlyArray<string>, separator: string): string {
	return pieces.filter((p) => p.trim().length > 0).join(separator);
}

/** Mutable progress of one payload rewrite. */
interface BreakRewrite {
	update: ColumnMarkerUpdate;
	styleTokens: string[] | null;
	styleEmitted: boolean;
	stackedEmitted: boolean;
}

interface StartRewrite {
	update: ContainerMarkerUpdate;
	styleTokens: string[] | null;
	styleEmitted: boolean;
	layoutEmitted: boolean;
	responsiveEmitted: boolean;
}

/**
 * Rewrite a `col-break` payload, keeping every token the update does not
 * mention — including tokens this codebase does not know about.
 */
function rewriteBreakPayload(payload: string, update: ColumnMarkerUpdate): string {
	const {pieces, separators} = splitPayload(payload);
	const state: BreakRewrite = {
		update,
		styleTokens: update.style === undefined ? null : serializeStyleTokens(update.style),
		styleEmitted: false,
		stackedEmitted: false,
	};
	const kept: string[] = [];
	for (let index = 0; index < pieces.length; index++) {
		keepBreakPiece(kept, pieces[index]!, index, state);
	}
	insertMissingBreakTokens(kept, pieces, state);
	return joinPieces(kept, separators[0] ?? ",");
}

/** Copy one piece over, unless the update replaces or removes it. */
function keepBreakPiece(kept: string[], piece: string, index: number, state: BreakRewrite): void {
	const {update} = state;
	if (update.widthPercent !== undefined && isWidthPiece(piece, index === 0)) return;

	const key = tokenKey(piece);
	if (key === "stk") {
		if (update.stacked === undefined) kept.push(piece);
		else if (!state.stackedEmitted && update.stacked !== null && update.stacked > 0) {
			kept.push(`stk:${update.stacked}`);
			state.stackedEmitted = true;
		}
		return;
	}
	if (state.styleTokens !== null && key !== null && STYLE_KEYS.has(key)) {
		if (!state.styleEmitted) {
			kept.push(...state.styleTokens);
			state.styleEmitted = true;
		}
		return;
	}
	kept.push(piece);
}

/** Append width/stack/style tokens the original payload did not carry. */
function insertMissingBreakTokens(kept: string[], pieces: ReadonlyArray<string>, state: BreakRewrite): void {
	const {update, styleTokens} = state;
	if (update.widthPercent !== undefined && update.widthPercent > 0) {
		const usedKey = pieces.some((piece, index) => isWidthPiece(piece, index === 0) && tokenKey(piece) === "w");
		kept.unshift(usedKey ? `w:${Math.round(update.widthPercent)}` : String(Math.round(update.widthPercent)));
	}
	if (update.stacked !== undefined && update.stacked !== null && update.stacked > 0 && !state.stackedEmitted) {
		kept.push(`stk:${update.stacked}`);
	}
	if (styleTokens !== null && !state.styleEmitted && styleTokens.length > 0) kept.push(...styleTokens);
}

/** Rewrite a `col-start` payload (container style + layout). */
function rewriteStartPayload(payload: string, update: ContainerMarkerUpdate): string {
	const {pieces, separators} = splitPayload(payload);
	const state: StartRewrite = {
		update,
		styleTokens: update.style === undefined ? null : serializeStyleTokens(update.style),
		styleEmitted: false,
		layoutEmitted: false,
		responsiveEmitted: false,
	};
	const kept: string[] = [];
	for (const piece of pieces) keepStartPiece(kept, piece, state);
	if (update.layout === "stack" && !state.layoutEmitted) kept.push("l:stack");
	if (update.responsive === true && !state.responsiveEmitted) kept.push(RESPONSIVE_TOKEN);
	if (state.styleTokens !== null && !state.styleEmitted && state.styleTokens.length > 0) {
		kept.push(...state.styleTokens);
	}
	return joinPieces(kept, separators[0] ?? ",");
}

function keepStartPiece(kept: string[], piece: string, state: StartRewrite): void {
	const key = tokenKey(piece);
	if (key === "l") {
		if (state.update.layout === undefined) kept.push(piece);
		else if (!state.layoutEmitted && state.update.layout === "stack") {
			kept.push("l:stack");
			state.layoutEmitted = true;
		}
		return;
	}
	// Bare `responsive` flag (no `:`): kept verbatim unless the update turns it
	// off, mirroring how the parser reads it case-insensitively.
	if (key === null && isResponsiveToken(piece.trim())) {
		if (state.update.responsive !== false) {
			kept.push(piece);
			state.responsiveEmitted = true;
		}
		return;
	}
	if (state.styleTokens !== null && key !== null && STYLE_KEYS.has(key)) {
		if (!state.styleEmitted) {
			kept.push(...state.styleTokens);
			state.styleEmitted = true;
		}
		return;
	}
	kept.push(piece);
}

/**
 * Build the marker line for a given payload, reusing the original line's
 * formatting when one is supplied. An empty payload drops the `:` entirely,
 * matching what authors write for plain markers.
 */
function buildMarkerLine(prefix: string, suffix: string, payload: string): string {
	return payload.length > 0 ? `${prefix}:${payload}${suffix}` : `${prefix}${suffix}`;
}

/** Replace only the `%% col-break %%` line of one column. */
export function patchColumnMarker(
	doc: string,
	region: ColumnRegion,
	columnIndex: number,
	update: ColumnMarkerUpdate,
): TextEdit | null {
	const span = region.columnMarkerOffsets[columnIndex];
	if (!span) return null;
	const line = doc.slice(span[0], span[1]);
	const parts = parseMarkerLine(line, "break");
	if (!parts) return null;
	const payload = rewriteBreakPayload(parts.payload, update);
	return {from: span[0], to: span[1], text: buildMarkerLine(parts.prefix, parts.suffix, payload)};
}

/** Replace only the `%% col-start %%` line of a region. */
export function patchContainerMarker(
	doc: string,
	region: ColumnRegion,
	update: ContainerMarkerUpdate,
): TextEdit | null {
	const span = region.containerMarkerOffset;
	const line = doc.slice(span[0], span[1]);
	const parts = parseMarkerLine(line, "start");
	if (!parts) return null;
	const payload = rewriteStartPayload(parts.payload, update);
	return {from: span[0], to: span[1], text: buildMarkerLine(parts.prefix, parts.suffix, payload)};
}
