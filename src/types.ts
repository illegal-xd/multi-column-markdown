/**
 * Shared type definitions for the Advanced Multi Column VSCode extension.
 * Mirrors the reference plugin (amatya-aditya/advanced-multi-column) types.
 */

export type ColumnBackgroundOption =
	| "transparent"
	| "primary"
	| "secondary"
	| "alt"
	| "accent-soft"
	| "red-soft"
	| "orange-soft"
	| "yellow-soft"
	| "green-soft"
	| "cyan-soft"
	| "blue-soft"
	| "pink-soft";

export type StyleColorOption =
	| "gray"
	| "accent"
	| "muted"
	| "text"
	| "red"
	| "orange"
	| "yellow"
	| "green"
	| "cyan"
	| "blue"
	| "pink";

export type SeparatorLineStyle = "solid" | "dashed" | "dotted" | "double" | "custom";

export type ColumnLayout = "row" | "stack";

export interface ColumnStyleData {
	background?: ColumnBackgroundOption;
	borderColor?: StyleColorOption;
	textColor?: StyleColorOption;
	showBorder?: boolean;
	/** Show only left border (callout-style) instead of full border */
	leftBorder?: boolean;
	horizontalDividers?: boolean;
	separator?: boolean;
	separatorColor?: StyleColorOption;
	separatorStyle?: SeparatorLineStyle;
	separatorWidth?: number;
	separatorCustomChar?: string;
}

export interface ColumnData {
	content: string;
	widthPercent: number; // 0 means auto/equal
	style?: ColumnStyleData;
	/** Stack group ID: 0/undefined = not stacked, positive number = stack group */
	stacked?: number;
}

export interface ColumnRegion {
	/** Document char offset of the first char of `%% col-start %%` */
	from: number;
	/** Document char offset past the last char of `%% col-end %%` */
	to: number;
	/** Parsed columns */
	columns: ColumnData[];
	/** Optional style for the whole column block container */
	containerStyle?: ColumnStyleData;
	/** Layout direction: "row" (side-by-side, default) or "stack" (top-to-bottom) */
	layout?: ColumnLayout;
	/** Line number (0-based) of the `%% col-start %%` line */
	lineStart: number;
	/** Line number (0-based) of the `%% col-end %%` line */
	lineEnd: number;
	/** Per-column line ranges: [startLine, endLine] inclusive, 0-based */
	columnLineRanges: [number, number][];
	/**
	 * Per-column absolute character ranges in the DOCUMENT the region was
	 * parsed from: [from, to] of the column's raw content lines. For nested
	 * regions this is relative to the parent column content string — the
	 * extension host resolves these into document offsets via the path.
	 */
	columnAbsoluteOffsets: [number, number][];
}

/** Path addressing for nested columns: [columnIndex, regionIndex][] */
export interface ContainerPathEntry {
	columnIndex: number;
	regionIndex: number;
}

export type ContainerPath = ContainerPathEntry[];

export type DividerLineStyle = "solid" | "dashed" | "dotted" | "double";

export type StyleTargetMode = "all" | "specific";

export interface HeaderTypeConfig {
	id: string;
	icon: string;
	background: ColumnBackgroundOption;
	textColor: StyleColorOption;
	fontSize: number;
	fontWeight: number;
}

export interface ColumnsSettings {
	defaultColumnCount: number;
	minColumnWidthPercent: number;
	showDragHandles: boolean;
	enableSlashSuggest: boolean;
	inheritStyleOnAdd: boolean;
	styleTargetMode: StyleTargetMode;
	styleTargetColumnIndex: number;
	containerBackground: ColumnBackgroundOption;
	showContainerBorder: boolean;
	containerBorderWidthPx: number;
	containerBorderColor: StyleColorOption;
	containerCornerRadiusPx: number;
	containerTextColor: StyleColorOption;
	verticalDividerWidthPx: number;
	verticalDividerStyle: DividerLineStyle;
	verticalDividerColor: StyleColorOption;
	enableHeaders: boolean;
	headerTypes: HeaderTypeConfig[];
}
