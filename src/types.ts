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

/**
 * User-supplied CSS color literal accepted by color tokens: hex only
 * (#rgb / #rgba / #rrggbb / #rrggbbaa). rgb()/rgba() functions are not
 * supported (commas/spaces inside conflict with token separators).
 */
export type CssColorLiteral = `#${string}`;

/** Border/text/separator color: named palette option or custom CSS color */
export type StyleColorOptionOrCustom = StyleColorOption | CssColorLiteral;

/** Background: named palette option or custom CSS color */
export type BackgroundOptionOrCustom = ColumnBackgroundOption | CssColorLiteral;

export type SeparatorLineStyle = "solid" | "dashed" | "dotted" | "double" | "custom";

export type ColumnLayout = "row" | "stack";

export interface ColumnStyleData {
	background?: BackgroundOptionOrCustom;
	borderColor?: StyleColorOptionOrCustom;
	textColor?: StyleColorOptionOrCustom;
	showBorder?: boolean;
	/** Show only left border (callout-style) instead of full border */
	leftBorder?: boolean;
	horizontalDividers?: boolean;
	separator?: boolean;
	separatorColor?: StyleColorOptionOrCustom;
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
	/**
	 * Char range of the `%% col-start %%` marker line (trailing newline
	 * excluded). Lossless patching rewrites exactly this span.
	 */
	containerMarkerOffset: [number, number];
	/** Char range of the `%% col-end %%` marker line (trailing newline excluded). */
	endMarkerOffset: [number, number];
	/** Per-column char range of each `%% col-break:… %%` marker line. */
	columnMarkerOffsets: [number, number][];
}

/**
 * Parsed region as a tree node: the flat `ColumnRegion` plus each column's
 * nested regions (recursively).
 *
 * All offsets inside `region` stay relative to the string it was parsed from
 * (the column content for nested nodes) — `baseOffset` / `baseLine` locate
 * that string inside the parent document, so absolute positions are
 * `baseOffset + relative` and `baseLine + relativeLine`.
 */
export interface RegionNode {
	region: ColumnRegion;
	/** Document char offset of this region's coordinate origin. */
	baseOffset: number;
	/** Document line index of line 0 of this region's source. */
	baseLine: number;
	columns: ColumnNode[];
}

export interface ColumnNode {
	/** Index within the parent region's `columns`. */
	index: number;
	column: ColumnData;
	/** Regions nested inside this column's content, in document order. */
	childRegions: RegionNode[];
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
	/**
	 * @Iteration: [v0.5.0] 未实现的空白配置 — 无拖拽手柄/编辑器，读取后不参与渲染；
	 * 保留占位（package.json 未声明该项），待编辑器落地时决定去留。
	 */
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
