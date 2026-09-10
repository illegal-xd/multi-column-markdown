/**
 * Lossless write-back: turn an intent ("set this column's style", "delete
 * column 2") into a text edit that changes *only* what it must.
 *
 * `serializeColumns` (parser.ts) rebuilds a whole block from scratch: it
 * canonicalizes token order, drops tokens it does not know and normalizes
 * blank lines. That is fine for freshly inserted templates, but rewriting a
 * user's document that way is data loss — unknown tokens, comments and
 * formatting inside the block disappear.
 *
 * This module never regenerates what it did not touch:
 *   - marker lines are edited by splicing the payload substring, so the
 *     prefix/suffix spacing and every untouched token stay byte-identical;
 *   - content is moved around as verbatim slices of the original document.
 *
 * Every function is pure and returns {@link TextEdit}s (or null when the
 * request does not apply); the caller applies them, e.g. via
 * {@link applyEdits} or a VSCode `WorkspaceEdit`.
 */
import type {ColumnData, ColumnRegion} from "../types";
import {serializeStyleTokens} from "./styleTokens";
import {patchColumnMarker, type TextEdit} from "./markerPayload";

export {
	patchColumnMarker,
	patchContainerMarker,
	type ColumnMarkerUpdate,
	type ContainerMarkerUpdate,
	type TextEdit,
} from "./markerPayload";

/**
 * Verbatim decomposition of a region:
 *   head + Σ(marker[i] + body[i]) + tail
 * which concatenates back to the exact original bytes.
 */
interface RegionSegments {
	head: string;
	markers: string[];
	bodies: string[];
	tail: string;
}

function segmentRegion(doc: string, region: ColumnRegion): RegionSegments {
	const markers: string[] = [];
	const bodies: string[] = [];
	const spans = region.columnMarkerOffsets;

	for (let i = 0; i < spans.length; i++) {
		const span = spans[i]!;
		const next = spans[i + 1]?.[0] ?? region.endMarkerOffset[0];
		markers.push(doc.slice(span[0], span[1]));
		bodies.push(doc.slice(span[1], next));
	}

	return {
		head: doc.slice(region.from, spans[0]?.[0] ?? region.endMarkerOffset[0]),
		markers,
		bodies,
		tail: doc.slice(region.endMarkerOffset[0], region.to),
	};
}

function rebuildRegion(segments: RegionSegments, order: ReadonlyArray<number>): string {
	let text = segments.head;
	for (const index of order) {
		text += segments.markers[index]! + segments.bodies[index]!;
	}
	return text + segments.tail;
}

function markerForColumn(column: ColumnData): {marker: string; body: string} {
	const tokens: string[] = [];
	if (column.widthPercent > 0) tokens.push(String(Math.round(column.widthPercent)));
	if (column.stacked && column.stacked > 0) tokens.push(`stk:${column.stacked}`);
	tokens.push(...serializeStyleTokens(column.style));
	const payload = tokens.length > 0 ? `:${tokens.join(",")}` : "";
	return {marker: `%% col-break${payload} %%`, body: "\n\n"};
}

/**
 * Insert a column after `afterIndex` (`-1` inserts first). Untouched columns
 * keep their marker lines and content byte-for-byte; only the new column is
 * generated. `normalizeWidths` mirrors `serializeColumns`' equal-width
 * behaviour by patching width tokens in the surviving markers.
 */
export function insertColumn(
	doc: string,
	region: ColumnRegion,
	afterIndex: number,
	column: ColumnData,
	options: {normalizeWidths?: boolean} = {},
): TextEdit | null {
	if (afterIndex < -1 || afterIndex >= region.columns.length) return null;
	const segments = segmentRegion(doc, region);
	const order: number[] = segments.markers.map((_, i) => i);
	if (options.normalizeWidths !== false) {
		for (const i of order) {
			const edit = patchColumnMarker(doc, region, i, {widthPercent: 0});
			if (edit) segments.markers[i] = edit.text;
		}
	}
	const {marker, body} = markerForColumn(column);
	segments.markers.push(marker);
	segments.bodies.push(body);
	order.splice(afterIndex + 1, 0, order.length);
	return {from: region.from, to: region.to, text: rebuildRegion(segments, order)};
}

/** Remove one column, preserving every other byte of the region. */
export function removeColumn(doc: string, region: ColumnRegion, index: number): TextEdit | null {
	if (index < 0 || index >= region.columns.length) return null;
	const segments = segmentRegion(doc, region);
	const order = segments.markers.map((_, i) => i).filter((i) => i !== index);
	return {from: region.from, to: region.to, text: rebuildRegion(segments, order)};
}

/** Reorder columns, preserving marker lines and content verbatim. */
export function moveColumn(
	doc: string,
	region: ColumnRegion,
	from: number,
	to: number,
): TextEdit | null {
	if (from < 0 || from >= region.columns.length) return null;
	if (to < 0 || to >= region.columns.length) return null;
	if (from === to) return null;
	const segments = segmentRegion(doc, region);
	const order = segments.markers.map((_, i) => i);
	const [moved] = order.splice(from, 1);
	if (moved === undefined) return null;
	order.splice(to, 0, moved);
	return {from: region.from, to: region.to, text: rebuildRegion(segments, order)};
}

/** Apply text edits to a document. Edits must not overlap. */
export function applyEdits(doc: string, edits: ReadonlyArray<TextEdit>): string {
	const sorted = [...edits].sort((a, b) => b.from - a.from);
	let result = doc;
	for (const edit of sorted) {
		result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
	}
	return result;
}
