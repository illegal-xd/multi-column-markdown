/**
 * Marker-based column syntax parser (structure only).
 *
 * Ported 1:1 from amatya-aditya/advanced-multi-column (AGPL-3.0), preserving
 * the exact regexes, token semantics and edge-case behavior so documents
 * render identically in both implementations.
 *
 * Syntax:
 *   %% col-start %%                 <- optional style/layout tokens
 *   %% col-break %%                 <- starts column 1 (equal width)
 *   content...
 *   %% col-break:40 %%              <- starts column 2 at 40% width
 *   content...
 *   %% col-end %%
 *
 * Content between col-start and the FIRST col-break is ignored.
 *
 * Scope: this file scans *structure* — markers, nesting, offsets, spans. The
 * neighbouring concerns live in their own modules and are re-exported here so
 * existing callers keep working:
 *   - `markers.ts`        marker grammar + fenced-code awareness
 *   - `styleTokens.ts`    style-token vocabulary
 *   - `serialize.ts`      canonical block serialization
 *   - `regionCache.ts`    bounded, frozen result cache
 */
import type {
	ColumnLayout,
	ColumnRegion,
	ColumnStyleData,
} from "../types";
import {BREAK_RE, END_RE, START_RE, fencedLineMask, markerLineAt} from "./markers";
import {cachedRegions} from "./regionCache";
import {parseBreakPayload, parseStartPayload} from "./regionPayload";

export {isCssColorLiteral, parseStyleTokens, serializeStyleTokens} from "./styleTokens";
export {serializeBreakPayload, serializeColumns, serializeStartPayload} from "./serialize";
export {clearRegionCache, getRegionCacheStats} from "./regionCache";

/** Character offset of the first char of every line. */
function lineStartOffsets(lines: ReadonlyArray<string>): number[] {
	const offsets: number[] = new Array(lines.length);
	let acc = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets[i] = acc;
		acc += (lines[i] ?? "").length + 1;
	}
	return offsets;
}

interface PendingColumn {
	lines: string[];
	width: number;
	style?: ColumnStyleData;
	stacked?: number;
	lineStart: number;
	markerOffset: [number, number];
}

/** Scanner state for the region currently being read. */
interface ScanState {
	inRegion: boolean;
	regionStartOffset: number;
	regionStartLine: number;
	containerMarker: [number, number];
	seenFirstBreak: boolean;
	columns: PendingColumn[];
	current: PendingColumn | null;
	nestedDepth: number;
	containerStyle: ColumnStyleData | undefined;
	layout: ColumnLayout | undefined;
	responsive: boolean | undefined;
}

/** Read-only inputs shared by every line of a scan. */
interface ScanContext {
	lines: ReadonlyArray<string>;
	offsets: ReadonlyArray<number>;
}

interface LineInfo {
	index: number;
	text: string;
	marker: string | null;
	span: [number, number];
}

function createScanState(): ScanState {
	return {
		inRegion: false,
		regionStartOffset: -1,
		regionStartLine: -1,
		containerMarker: [0, 0],
		seenFirstBreak: false,
		columns: [],
		current: null,
		nestedDepth: 0,
		containerStyle: undefined,
		layout: undefined,
		responsive: undefined,
	};
}

function openRegion(state: ScanState, line: LineInfo): void {
	const startMatch = line.marker?.match(START_RE);
	if (!startMatch) return;
	const parsed = parseStartPayload(startMatch[1]);
	state.inRegion = true;
	state.regionStartOffset = line.span[0];
	state.regionStartLine = line.index;
	state.containerMarker = line.span;
	state.seenFirstBreak = false;
	state.columns = [];
	state.current = null;
	state.nestedDepth = 0;
	state.containerStyle = parsed.containerStyle;
	state.layout = parsed.layout;
	state.responsive = parsed.responsive;
}

function closeRegion(state: ScanState): void {
	state.inRegion = false;
	state.seenFirstBreak = false;
	state.columns = [];
	state.current = null;
	state.nestedDepth = 0;
	state.containerStyle = undefined;
	state.layout = undefined;
	state.responsive = undefined;
}

function pushCurrentColumn(state: ScanState): void {
	if (state.seenFirstBreak && state.current) state.columns.push(state.current);
}

function startColumn(state: ScanState, line: LineInfo, breakPayload: string | undefined): void {
	pushCurrentColumn(state);
	state.seenFirstBreak = true;
	const parsed = parseBreakPayload(breakPayload);
	state.current = {
		lines: [],
		width: parsed.width,
		style: parsed.style,
		stacked: parsed.stacked,
		lineStart: line.index + 1, // content starts on the next line
		markerOffset: line.span,
	};
}

/**
 * Handle one line while a region is open. Returns the finished region when
 * this line closes it, otherwise null (the line was consumed as content).
 */
function handleRegionLine(state: ScanState, context: ScanContext, line: LineInfo): ColumnRegion | null {
	// Nested opens are counted in the header zone too, otherwise an example
	// block written before the first break would close the region early.
	if (line.marker !== null && START_RE.test(line.marker)) {
		state.nestedDepth += 1;
		appendContent(state, line.text);
		return null;
	}
	if (line.marker !== null && END_RE.test(line.marker) && state.nestedDepth > 0) {
		state.nestedDepth -= 1;
		appendContent(state, line.text);
		return null;
	}
	if (state.nestedDepth === 0 && line.marker !== null) {
		const breakMatch = line.marker.match(BREAK_RE);
		if (breakMatch) {
			startColumn(state, line, breakMatch[1]);
			return null;
		}
		if (END_RE.test(line.marker)) {
			pushCurrentColumn(state);
			const region = buildRegion(state, context, line);
			closeRegion(state);
			return region;
		}
	}
	appendContent(state, line.text);
	return null;
}

function appendContent(state: ScanState, text: string): void {
	if (state.seenFirstBreak && state.current) state.current.lines.push(text);
}

function parseColumnRegions(doc: string): ColumnRegion[] {
	const regions: ColumnRegion[] = [];
	const lines = doc.split("\n");
	// Markers inside fenced code blocks are documentation, not layout.
	const fenced = fencedLineMask(lines);
	const offsets = lineStartOffsets(lines);
	const context: ScanContext = {lines, offsets};
	const state = createScanState();

	for (let index = 0; index < lines.length; index++) {
		const text = lines[index] ?? "";
		const marker = markerLineAt(lines, fenced, index);
		const line: LineInfo = {index, text, marker, span: [offsets[index]!, offsets[index]! + text.length]};

		if (!state.inRegion) {
			openRegion(state, line);
			continue;
		}
		const closed = handleRegionLine(state, context, line);
		if (closed) regions.push(closed);
	}

	return regions;
}

/** Clamp total widths: if sum > 100%, reset all to equal. */
function clampWidths(columns: ReadonlyArray<PendingColumn>): ReadonlyArray<PendingColumn> {
	const total = columns.reduce((sum, column) => sum + column.width, 0);
	return total > 100 ? columns.map((column) => ({...column, width: 0})) : columns;
}

function contentSpan(context: ScanContext, column: PendingColumn): [number, number] {
	const startLine = column.lineStart;
	const endLine = startLine + column.lines.length - 1;
	const startOffset = context.offsets[startLine] ?? 0;
	const endOffset = (context.offsets[endLine] ?? 0) + (context.lines[endLine] ?? "").length;
	return [startOffset, endOffset];
}

function buildRegion(state: ScanState, context: ScanContext, end: LineInfo): ColumnRegion | null {
	const columns = clampWidths(state.columns);
	if (columns.length === 0) return null;
	const endMarker = end.span;
	const lineEnd = end.index;

	const region: ColumnRegion = {
		from: state.regionStartOffset,
		to: endMarker[1],
		columns: columns.map((column) => ({
			content: column.lines.join("\n").trim(),
			widthPercent: column.width,
			style: column.style,
			...(column.stacked && column.stacked > 0 ? {stacked: column.stacked} : {}),
		})),
		containerStyle: state.containerStyle,
		layout: state.layout,
		lineStart: state.regionStartLine,
		lineEnd,
		columnLineRanges: columns.map((column) => {
			const start = column.lineStart;
			return [start, Math.max(start, start + column.lines.length - 1)];
		}),
		columnAbsoluteOffsets: columns.map((column) => contentSpan(context, column)),
		containerMarkerOffset: state.containerMarker,
		endMarkerOffset: endMarker,
		columnMarkerOffsets: columns.map((column) => column.markerOffset),
	};
	// Set the flag conditionally instead of spreading a temporary object: the
	// key stays absent (never `false`), so a non-responsive region keeps a
	// byte-identical shape through JSON round-trips.
	if (state.responsive) region.responsive = true;
	return region;
}

/**
 * Find all column regions, reusing a bounded LRU cache for unchanged input.
 * The returned array is frozen — callers must not mutate it.
 */
export function findColumnRegions(doc: string): ColumnRegion[] {
	return cachedRegions(doc, () => parseColumnRegions(doc));
}

/**
 * Fast pre-filter: does this document contain any column markers at all?
 */
export function docContainsColumns(doc: string): boolean {
	return doc.includes("col-start") && doc.includes("col-end");
}
