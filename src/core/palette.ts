/**
 * Canonical color vocabulary — single source of truth.
 *
 * Every option list in the codebase is derived from these two records:
 *   - the style-token validator (`core/styleTokens.ts`)
 *   - the CSS variable mapping (`core/style.ts`)
 *   - the settings validator + `package.json` enum (`settings.ts`)
 *
 * Adding a palette entry is a one-line change here; the `Record<...>` types
 * make the compiler reject a vocabulary that drifts from `types.ts`.
 */
import type {ColumnBackgroundOption, StyleColorOption} from "../types";

export const BACKGROUND_CSS: Record<ColumnBackgroundOption, string> = {
	transparent: "transparent",
	primary: "var(--vscode-editor-background)",
	secondary: "var(--vscode-sideBar-background)",
	alt: "var(--vscode-editorWidget-background)",
	"accent-soft": "color-mix(in srgb, var(--vscode-button-background) 14%, transparent)",
	"red-soft": "rgba(239, 68, 68, 0.14)",
	"orange-soft": "rgba(245, 158, 11, 0.14)",
	"yellow-soft": "rgba(234, 179, 8, 0.14)",
	"green-soft": "rgba(34, 197, 94, 0.14)",
	"cyan-soft": "rgba(6, 182, 212, 0.14)",
	"blue-soft": "rgba(59, 130, 246, 0.14)",
	"pink-soft": "rgba(236, 72, 153, 0.14)",
};

export const COLOR_CSS: Record<StyleColorOption, string> = {
	transparent: "transparent",
	gray: "var(--vscode-panel-border)",
	accent: "var(--vscode-button-background)",
	muted: "var(--vscode-descriptionForeground)",
	text: "var(--vscode-editor-foreground)",
	red: "#ef4444",
	orange: "#f59e0b",
	yellow: "#eab308",
	green: "#22c55e",
	cyan: "#06b6d4",
	blue: "#3b82f6",
	pink: "#ec4899",
};

/** Solid/opaque colors that correspond to each soft background — used for
 *  the left-border accent stripe so it reads like a callout. */
export const HEADER_BORDER_CSS: Record<string, string> = {
	"accent-soft": "var(--vscode-button-background)",
	"red-soft": "#ef4444",
	"orange-soft": "#f59e0b",
	"yellow-soft": "#eab308",
	"green-soft": "#22c55e",
	"cyan-soft": "#06b6d4",
	"blue-soft": "#3b82f6",
	"pink-soft": "#ec4899",
	secondary: "var(--vscode-panel-border)",
	alt: "var(--vscode-panel-border)",
	primary: "var(--vscode-panel-border)",
};

/** Background vocabulary, in declaration order (drives pickers). */
export const BACKGROUND_OPTION_VALUES = Object.keys(BACKGROUND_CSS) as ColumnBackgroundOption[];

/** Color vocabulary, in declaration order (drives pickers). */
export const STYLE_COLOR_OPTION_VALUES = Object.keys(COLOR_CSS) as StyleColorOption[];

/**
 * Colors offered in the VSCode settings UI: same vocabulary minus
 * `transparent`, which only makes sense as an inline token
 * (`bc:transparent`) — mirrors the `enum`s declared in package.json.
 */
export const CONFIG_COLOR_OPTION_VALUES = STYLE_COLOR_OPTION_VALUES.filter(
	(value) => value !== "transparent",
);
