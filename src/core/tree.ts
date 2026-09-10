/**
 * Region tree: the structural parser's flat regions, arranged as a tree with
 * document-absolute coordinates.
 *
 * The flat parser materializes nesting lazily — a nested block stays a string
 * inside its parent column until someone re-parses it. That is fine for
 * rendering, but write-back needs a stable address for every marker in the
 * *document*, so this module walks the nesting once and records where each
 * level's coordinate system starts (`baseOffset` / `baseLine`).
 *
 * Deliberately not a general Markdown AST: nodes exist only where column
 * markers do, everything else stays raw text.
 */
import {findColumnRegions} from "./parser";
import type {ColumnNode, ColumnRegion, ContainerPath, RegionNode} from "../types";

/** Parse a document into nested region nodes (one per top-level block). */
export function parseRegionTree(doc: string): RegionNode[] {
	return findColumnRegions(doc).map((region) => toNode(doc, region, 0, 0));
}

function toNode(doc: string, region: ColumnRegion, baseOffset: number, baseLine: number): RegionNode {
	const columns: ColumnNode[] = region.columns.map((column, index) => {
		const childBase = columnContentOrigin(doc, region, baseOffset, baseLine, index);
		const childRegions = childBase === null
			? []
			: findColumnRegions(column.content).map((child) =>
				toNode(doc, child, childBase.offset, childBase.line),
			);
		return {index, column, childRegions};
	});
	return {region, baseOffset, baseLine, columns};
}

/**
 * Where a column's `content` string starts in the document. The parser trims
 * the joined lines, so the origin shifts past any whitespace-only prefix —
 * including whole blank lines, which also shift the line number.
 */
function columnContentOrigin(
	doc: string,
	region: ColumnRegion,
	baseOffset: number,
	baseLine: number,
	index: number,
): {offset: number; line: number} | null {
	const content = region.columns[index]?.content;
	const span = region.columnAbsoluteOffsets[index];
	const contentLines = region.columnLineRanges[index];
	if (content === undefined || !span || !contentLines) return null;

	const startOffset = baseOffset + span[0];
	const raw = doc.slice(startOffset, baseOffset + span[1]);
	const trimmedStart = raw.length - raw.trimStart().length;
	let blankLines = 0;
	for (let i = 0; i < trimmedStart; i++) {
		if (raw[i] === "\n") blankLines += 1;
	}
	return {offset: startOffset + trimmedStart, line: baseLine + contentLines[0] + blankLines};
}

/**
 * Resolve a container path relative to `root`. Semantics mirror the
 * serializer's `ContainerPath`: each entry descends from the current
 * columns (`columnIndex`) into that column's nested regions
 * (`regionIndex`); an empty path resolves to `root` itself.
 */
export function findNodeAtPath(root: RegionNode, path: ContainerPath): RegionNode | null {
	let node: RegionNode = root;
	for (const entry of path) {
		const column = node.columns[entry.columnIndex];
		const child = column?.childRegions[entry.regionIndex];
		if (!child) return null;
		node = child;
	}
	return node;
}

/**
 * A copy of the node's region with every offset/line shifted into document
 * coordinates, so it can be handed to the patch functions together with the
 * whole document.
 */
export function rebaseRegion(node: RegionNode): ColumnRegion {
	const region = node.region;
	if (node.baseOffset === 0 && node.baseLine === 0) return region;

	const shiftSpan = (span: [number, number]): [number, number] =>
		[span[0] + node.baseOffset, span[1] + node.baseOffset];
	const shiftRange = (range: [number, number]): [number, number] =>
		[range[0] + node.baseLine, range[1] + node.baseLine];

	return {
		...region,
		from: region.from + node.baseOffset,
		to: region.to + node.baseOffset,
		lineStart: region.lineStart + node.baseLine,
		lineEnd: region.lineEnd + node.baseLine,
		containerMarkerOffset: shiftSpan(region.containerMarkerOffset),
		endMarkerOffset: shiftSpan(region.endMarkerOffset),
		columnMarkerOffsets: region.columnMarkerOffsets.map(shiftSpan),
		columnAbsoluteOffsets: region.columnAbsoluteOffsets.map(shiftSpan),
		columnLineRanges: region.columnLineRanges.map(shiftRange),
	};
}

/** Document offset of a region-relative offset. */
export function absoluteOffset(node: RegionNode, regionRelative: number): number {
	return node.baseOffset + regionRelative;
}

/** Document line of a region-relative line. */
export function absoluteLine(node: RegionNode, regionRelativeLine: number): number {
	return node.baseLine + regionRelativeLine;
}

/** Document char range of a marker span recorded by the parser. */
export function absoluteSpan(node: RegionNode, span: [number, number]): [number, number] {
	return [node.baseOffset + span[0], node.baseOffset + span[1]];
}
