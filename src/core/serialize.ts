/**
 * Document serialization: columns back into marker text.
 *
 * Note: this normalizes the block — canonical token order, canonical
 * separators, blank lines around markers. It is lossless only for documents
 * this module wrote (fresh templates); rewriting a user's existing document
 * must go through `patch.ts` instead.
 */
import type {ColumnData, ColumnLayout, ColumnStyleData} from "../types";
import {serializeStyleTokens} from "./styleTokens";

export function serializeBreakPayload(column: ColumnData): string {
	const tokens: string[] = [];
	if (column.widthPercent > 0) {
		tokens.push(String(Math.round(column.widthPercent)));
	}
	if (column.stacked && column.stacked > 0) {
		tokens.push(`stk:${column.stacked}`);
	}
	tokens.push(...serializeStyleTokens(column.style));
	return tokens.length > 0 ? `:${tokens.join(",")}` : "";
}

export function serializeStartPayload(
	style: ColumnStyleData | undefined,
	layout?: ColumnLayout,
	responsive?: boolean,
): string {
	const tokens: string[] = [];
	if (layout && layout !== "row") tokens.push(`l:${layout}`);
	if (responsive) tokens.push("responsive");
	tokens.push(...serializeStyleTokens(style));
	return tokens.length > 0 ? `:${tokens.join(",")}` : "";
}

/**
 * Serialize columns back to the marker format.
 *
 * Note: this normalizes the block (canonical token order, blank lines around
 * markers) — it is lossless only for documents this module wrote. Use
 * `patch.ts` when rewriting a user's existing document.
 */
export function serializeColumns(
	columns: ReadonlyArray<ColumnData>,
	containerStyle?: ColumnStyleData,
	layout?: ColumnLayout,
	responsive?: boolean,
): string {
	const parts: string[] = [`%% col-start${serializeStartPayload(containerStyle, layout, responsive)} %%`];
	for (const col of columns) {
		parts.push(`%% col-break${serializeBreakPayload(col)} %%`);
		if (col.content.trim().length > 0) {
			parts.push(col.content);
		}
	}
	parts.push("%% col-end %%");
	// Blank lines keep comments out of adjacent HTML blocks and make
	// every rewritten marker a standalone Markdown block in previews.
	return parts.join("\n\n");
}
