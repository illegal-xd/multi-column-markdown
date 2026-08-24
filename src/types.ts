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
	| "transparent"
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
	/** Column padding (CSS spacing, e.g. "5px" / "4px 8px"); default 5px */
	padding?: string;
	/** Gap between columns (CSS spacing, e.g. "5px" / "0.5em"); default 5px */
	gap?: string;
	/** Column margins (CSS spacing); default 0 */
	marginLeft?: string;
	marginTop?: string;
	marginRight?: string;
	marginBottom?: string;
	/**
	 * Margin shorthand (`m:` token, CSS spacing 1-4 values). Overrides are
	 * applied per-direction by the directional fields above.
	 */
	margin?: string;
	/**
	 * Border width shorthand (`bw:` token, CSS spacing 1-4 values); a single
	 * value applies to all four sides. Default 1px when the border is shown.
	 */
	borderWidth?: string;
	/** Per-side border widths (`bwl:`/`bwt:`/`bwr:`/`bwb:` tokens); override the shorthand */
	borderWidthLeft?: string;
	borderWidthTop?: string;
	borderWidthRight?: string;
	borderWidthBottom?: string;
	/** Column border radius (`br:` token, CSS spacing); default 4px */
	borderRadius?: string;
	/** Per-side border radii (`brl:`/`brt:`/`brr:`/`brb:` tokens); l=left edge (top-left+bottom-left), etc. */
	borderRadiusLeft?: string;
	borderRadiusTop?: string;
	borderRadiusRight?: string;
	borderRadiusBottom?: string;
	/** Column content horizontal alignment (`ta:` token); default inherits */
	textAlign?: "left" | "center" | "right";
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
