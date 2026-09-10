/**
 * Stack-group semantics: adjacent columns sharing a positive `stk:` id form
 * one visual group.
 *
 * Single source of truth for grouping — the preview renderer (layout and
 * separators) and any editor-side operation must agree on what a group is.
 */
import type {ColumnData} from "../types";

export interface ColumnGroup {
	/** Indices into the parent `columns` array, in order. */
	indices: number[];
	/** True when the indices belong to one `stk:` group. */
	isStack: boolean;
}

export function groupColumns(columns: ReadonlyArray<ColumnData>): ColumnGroup[] {
	const groups: ColumnGroup[] = [];
	let i = 0;
	while (i < columns.length) {
		const stackId = columns[i]!.stacked;
		if (stackId && stackId > 0) {
			const start = i;
			while (i < columns.length && columns[i]!.stacked === stackId) i++;
			groups.push({indices: Array.from({length: i - start}, (_, k) => start + k), isStack: true});
		} else {
			groups.push({indices: [i], isStack: false});
			i++;
		}
	}
	return groups;
}
