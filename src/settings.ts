/**
 * Settings layer: maps VSCode workspace configuration onto the plugin
 * settings shape (ported from the reference plugin's DEFAULT_SETTINGS +
 * validateSettings, AGPL-3.0).
 */
import * as vscode from "vscode";
import type {
	ColumnBackgroundOption,
	ColumnsSettings,
	DividerLineStyle,
	HeaderTypeConfig,
	StyleColorOption,
	StyleTargetMode,
} from "./types";

const CONFIG_SECTION = "multiColumnMarkdown";

export const BACKGROUND_OPTION_VALUES: ColumnBackgroundOption[] = [
	"transparent",
	"primary",
	"secondary",
	"alt",
	"accent-soft",
	"red-soft",
	"orange-soft",
	"yellow-soft",
	"green-soft",
	"cyan-soft",
	"blue-soft",
	"pink-soft",
];

export const STYLE_COLOR_OPTION_VALUES: StyleColorOption[] = [
	"gray",
	"accent",
	"muted",
	"text",
	"red",
	"orange",
	"yellow",
	"green",
	"cyan",
	"blue",
	"pink",
];

export const DIVIDER_STYLE_VALUES: DividerLineStyle[] = ["solid", "dashed", "dotted", "double"];

export const DEFAULT_HEADER_TYPES: HeaderTypeConfig[] = [
	{id: "note", icon: "pencil", background: "blue-soft", textColor: "blue", fontSize: 0.85, fontWeight: 600},
	{id: "info", icon: "info", background: "cyan-soft", textColor: "cyan", fontSize: 0.85, fontWeight: 600},
	{id: "tip", icon: "lightbulb", background: "green-soft", textColor: "green", fontSize: 0.85, fontWeight: 600},
	{id: "warning", icon: "triangle-alert", background: "orange-soft", textColor: "orange", fontSize: 0.85, fontWeight: 600},
	{id: "danger", icon: "zap", background: "red-soft", textColor: "red", fontSize: 0.85, fontWeight: 600},
];

export const DEFAULT_SETTINGS: ColumnsSettings = {
	defaultColumnCount: 2,
	minColumnWidthPercent: 10,
	showDragHandles: true,
	enableSlashSuggest: true,
	inheritStyleOnAdd: true,
	styleTargetMode: "all",
	styleTargetColumnIndex: 1,
	containerBackground: "primary",
	showContainerBorder: true,
	containerBorderWidthPx: 1,
	containerBorderColor: "gray",
	containerCornerRadiusPx: 8,
	containerTextColor: "text",
	verticalDividerWidthPx: 1,
	verticalDividerStyle: "solid",
	verticalDividerColor: "gray",
	enableHeaders: true,
	headerTypes: [...DEFAULT_HEADER_TYPES],
};

function isBackgroundOption(value: unknown): value is ColumnBackgroundOption {
	return typeof value === "string" && (BACKGROUND_OPTION_VALUES as string[]).includes(value);
}

function isStyleColorOption(value: unknown): value is StyleColorOption {
	return typeof value === "string" && (STYLE_COLOR_OPTION_VALUES as string[]).includes(value);
}

function isDividerStyle(value: unknown): value is DividerLineStyle {
	return typeof value === "string" && (DIVIDER_STYLE_VALUES as string[]).includes(value);
}

function isStyleTargetMode(value: unknown): value is StyleTargetMode {
	return value === "all" || value === "specific";
}

function parseHeaderTypes(raw: unknown): HeaderTypeConfig[] {
	if (!Array.isArray(raw)) return [...DEFAULT_HEADER_TYPES];
	const result: HeaderTypeConfig[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.id !== "string" || rec.id.length === 0) continue;
		const entry: HeaderTypeConfig = {
			id: rec.id,
			icon: typeof rec.icon === "string" ? rec.icon : "pencil",
			background: isBackgroundOption(rec.background) ? rec.background : "blue-soft",
			textColor: isStyleColorOption(rec.textColor) ? rec.textColor : "blue",
			fontSize: typeof rec.fontSize === "number" && Number.isFinite(rec.fontSize)
				? Math.max(0.5, Math.min(2, rec.fontSize))
				: 0.85,
			fontWeight: typeof rec.fontWeight === "number" && Number.isFinite(rec.fontWeight)
				? Math.max(100, Math.min(900, Math.round(rec.fontWeight)))
				: 600,
		};
		result.push(entry);
	}
	return result.length > 0 ? result : [...DEFAULT_HEADER_TYPES];
}

function readNumber(cfg: vscode.WorkspaceConfiguration, key: string, fallback: number): number {
	const value = cfg.get<unknown>(key, fallback);
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(cfg: vscode.WorkspaceConfiguration, key: string, fallback: boolean): boolean {
	const value = cfg.get<unknown>(key, fallback);
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Read + validate settings from workspace configuration.
 * Mirrors the reference validateSettings() clamps.
 */
export function getSettings(): ColumnsSettings {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = DEFAULT_SETTINGS;

	let defaultColumnCount = readNumber(cfg, "defaultColumnCount", raw.defaultColumnCount);
	let minColumnWidthPercent = readNumber(cfg, "minColumnWidthPercent", raw.minColumnWidthPercent);

	// Ensure minColumnWidthPercent * defaultColumnCount <= 100%
	if (minColumnWidthPercent * defaultColumnCount > 100) {
		minColumnWidthPercent = Math.floor(100 / defaultColumnCount);
	}
	defaultColumnCount = Math.max(2, Math.min(6, Math.round(defaultColumnCount)));
	minColumnWidthPercent = Math.max(5, Math.min(30, minColumnWidthPercent));

	const styleTargetModeRaw = cfg.get<unknown>("styleTargetMode", raw.styleTargetMode);
	const containerBackgroundRaw = cfg.get<unknown>("containerBackground", raw.containerBackground);
	const containerBorderColorRaw = cfg.get<unknown>("containerBorderColor", raw.containerBorderColor);
	const containerTextColorRaw = cfg.get<unknown>("containerTextColor", raw.containerTextColor);
	const verticalDividerStyleRaw = cfg.get<unknown>("verticalDividerStyle", raw.verticalDividerStyle);
	const verticalDividerColorRaw = cfg.get<unknown>("verticalDividerColor", raw.verticalDividerColor);

	return {
		defaultColumnCount,
		minColumnWidthPercent,
		showDragHandles: readBoolean(cfg, "showDragHandles", raw.showDragHandles),
		enableSlashSuggest: readBoolean(cfg, "enableSlashSuggest", raw.enableSlashSuggest),
		inheritStyleOnAdd: readBoolean(cfg, "inheritStyleOnAdd", raw.inheritStyleOnAdd),
		styleTargetMode: isStyleTargetMode(styleTargetModeRaw) ? styleTargetModeRaw : raw.styleTargetMode,
		styleTargetColumnIndex: Math.max(1, Math.min(6, Math.round(
			readNumber(cfg, "styleTargetColumnIndex", raw.styleTargetColumnIndex),
		))),
		containerBackground: isBackgroundOption(containerBackgroundRaw) ? containerBackgroundRaw : raw.containerBackground,
		showContainerBorder: readBoolean(cfg, "showContainerBorder", raw.showContainerBorder),
		containerBorderWidthPx: Math.max(0, Math.min(8, readNumber(cfg, "containerBorderWidthPx", raw.containerBorderWidthPx))),
		containerBorderColor: isStyleColorOption(containerBorderColorRaw) ? containerBorderColorRaw : raw.containerBorderColor,
		containerCornerRadiusPx: Math.max(0, Math.min(24, readNumber(cfg, "containerCornerRadiusPx", raw.containerCornerRadiusPx))),
		containerTextColor: isStyleColorOption(containerTextColorRaw) ? containerTextColorRaw : raw.containerTextColor,
		verticalDividerWidthPx: Math.max(0, Math.min(8, readNumber(cfg, "verticalDividerWidthPx", raw.verticalDividerWidthPx))),
		verticalDividerStyle: isDividerStyle(verticalDividerStyleRaw) ? verticalDividerStyleRaw : raw.verticalDividerStyle,
		verticalDividerColor: isStyleColorOption(verticalDividerColorRaw) ? verticalDividerColorRaw : raw.verticalDividerColor,
		enableHeaders: readBoolean(cfg, "enableHeaders", raw.enableHeaders),
		headerTypes: parseHeaderTypes(cfg.get<unknown>("headerTypes", raw.headerTypes)),
	};
}

/** Persist a header type list back into workspace/user configuration. */
export async function saveHeaderTypes(headerTypes: HeaderTypeConfig[], target: vscode.ConfigurationTarget): Promise<void> {
	await vscode.workspace.getConfiguration(CONFIG_SECTION).update("headerTypes", headerTypes, target);
}
