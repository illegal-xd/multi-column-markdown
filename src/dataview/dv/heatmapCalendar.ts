/**
 * `renderHeatmapCalendar` — port of the Obsidian **Heatmap Calendar** plugin's
 * dataviewjs helper (`Richardsl/heatmap-calendar-obsidian`):
 *
 *     renderHeatmapCalendar(this.container, { year, colors, entries, … })
 *
 * The sandbox has no DOM, so the container argument is ignored and the calendar
 * is emitted as a `heatmap` RenderOp; `render/html.ts` turns that into the same
 * element/class contract the plugin produces (`.heatmap-calendar-graph`,
 * `-year`, `-months`, `-days`, `-boxes`, `-content`), styled by
 * `media/dataview.css`.
 *
 * Documented adaptations (everything else mirrors upstream `main.ts`):
 *  - `colors`: a **string** falls back to the built-in green palette (upstream
 *    resolves the name against its own settings); a map is used as-is, and any
 *    palette that is not a non-empty string array falls back to the default.
 *  - `weekStartDay` comes from the `opts` argument (upstream reads its plugin
 *    setting, default 1 = Monday); labels are the fixed en-US short names
 *    upstream obtains from `toLocaleDateString("en-US", …)`.
 *  - The `today` border is only applied when the rendered year **is** the
 *    current year (upstream marks the same day-number in any year).
 */
import type {HeatmapBox, RenderOp} from "../types";

export interface HeatmapCalendarEntry {
	/** `YYYY-MM-DD` (required upstream; entries without a parsable date are dropped). */
	date?: string;
	/** Value mapped onto the palette; missing → `defaultEntryIntensity`. */
	intensity?: number;
	/** Key of `colors`; unknown/missing → the first palette. */
	color?: string;
	/** Text drawn inside the box (upstream: emoji/short label). */
	content?: string;
}

export interface HeatmapCalendarData {
	/** Defaults to the current year. */
	year?: number;
	/** Palette map (`{ name: [c0…c4] }`); a string falls back to the default palette. */
	colors?: Record<string, string[]> | string;
	entries?: HeatmapCalendarEntry[];
	/** Border on today's box; default true. */
	showCurrentDayBorder?: boolean;
	/** Intensity used by entries without one; default 4. */
	defaultEntryIntensity?: number;
	/** Intensity mapped to the first palette colour; default = lowest entry intensity. */
	intensityScaleStart?: number;
	/** Intensity mapped to the last palette colour; default = highest entry intensity. */
	intensityScaleEnd?: number;
}

export interface HeatmapOptions {
	/** Injectable "today" (tests); defaults to `new Date()`. */
	today?: Date;
	/** 0 = Sunday … 6 = Saturday; default `HEATMAP_WEEK_START_DAY`. */
	weekStartDay?: number;
}

/** Upstream `DEFAULT_SETTINGS.colors.default` (green scale). */
export const DEFAULT_HEATMAP_COLORS: readonly string[] = ["#c6e48b", "#7bc96f", "#49af5d", "#2e8840", "#196127"];
/** Upstream `DEFAULT_SETTINGS.weekStartDay` (Monday). */
export const HEATMAP_WEEK_START_DAY = 1;

const DEFAULT_ENTRY_INTENSITY = 4;
/** Upstream `DEFAULT_SETTINGS.intensityScaleStart/End` — used only when no entry has an intensity. */
const FALLBACK_SCALE_START = 1;
const FALLBACK_SCALE_END = 5;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Indexed by `Date#getDay()` — the names upstream gets from `toLocaleDateString("en-US")`. */
const WEEKDAY_BY_GETDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(input: number, min: number, max: number): number {
	return input < min ? min : input > max ? max : input;
}

/** Upstream `map()`: linear remap clamped to the output range. */
function mapRange(current: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
	return clamp(((current - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin, outMin, outMax);
}

/** 1 = Jan 1 … 365/366 — UTC fields (upstream `getHowManyDaysIntoYear`). */
function dayOfYearUTC(d: Date): number {
	return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / MS_PER_DAY;
}

/** 1 = Jan 1 — the LOCAL calendar date of `d` (upstream `getHowManyDaysIntoYearLocal`). */
function dayOfYearLocal(d: Date): number {
	return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / MS_PER_DAY;
}

/** Row-axis labels, rotated so index 0 is `weekStartDay`. */
export function heatmapWeekdays(weekStartDay: number = HEATMAP_WEEK_START_DAY): string[] {
	const start = ((Math.trunc(weekStartDay) % 7) + 7) % 7;
	const out: string[] = [];
	for (let i = 0; i < 7; i++) out.push(WEEKDAY_BY_GETDAY[(i + start) % 7]!);
	return out;
}

function isPalette(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((c) => typeof c === "string");
}

interface Palette {
	name: string;
	colors: string[];
}

/** Upstream `colors[name] ?? colors[Object.keys(colors)[0]]`, with a safe fallback. */
function paletteFor(palettes: readonly Palette[], name: string | undefined): readonly string[] {
	if (palettes.length === 0) return DEFAULT_HEATMAP_COLORS;
	if (name !== undefined) {
		const named = palettes.find((p) => p.name === name);
		if (named) return named.colors;
	}
	return palettes[0]!.colors;
}

/** `HeatmapCalendarData.colors` → named palettes (insertion order; first = default). */
function resolvePalettes(colors: HeatmapCalendarData["colors"]): Palette[] {
	if (colors !== undefined && typeof colors === "object" && !Array.isArray(colors)) {
		const named: Palette[] = [];
		for (const [name, palette] of Object.entries(colors)) {
			if (isPalette(palette)) named.push({name, colors: palette});
		}
		if (named.length > 0) return named;
	}
	return [{name: "default", colors: DEFAULT_HEATMAP_COLORS as unknown as string[]}];
}

/** Upstream filters entries to the displayed year, parsing `date + "T00:00"` (local). */
function entryYear(date: unknown): number {
	return new Date(`${String(date)}T00:00`).getFullYear();
}

/**
 * `renderHeatmapCalendar(el, calendarData)` → `{kind: "heatmap"}`.
 *
 * Geometry mirrors upstream: leading blanks so the first column is
 * `weekStartDay`, then one box per day of the year, each carrying the
 * `month-<mon>` class plus `today` / `hasData` / `isEmpty`.
 */
export function buildHeatmapOp(data: unknown, opts: HeatmapOptions = {}): RenderOp {
	const src = (typeof data === "object" && data !== null ? data : {}) as HeatmapCalendarData;
	const today = opts.today ?? new Date();
	const weekStartDay = ((Math.trunc(opts.weekStartDay ?? HEATMAP_WEEK_START_DAY) % 7) + 7) % 7;

	const year = Number.isFinite(src.year) ? Math.trunc(src.year as number) : today.getFullYear();
	const palettes = resolvePalettes(src.colors);
	const entries = (Array.isArray(src.entries) ? src.entries : []).filter((e) => entryYear(e?.date) === year);
	const showTodayBorder = src.showCurrentDayBorder ?? true;
	const defaultIntensity = Number.isFinite(src.defaultEntryIntensity)
		? (src.defaultEntryIntensity as number)
		: DEFAULT_ENTRY_INTENSITY;

	const intensities = entries.filter((e) => e.intensity).map((e) => e.intensity as number);
	const minIntensity = intensities.length > 0 ? Math.min(...intensities) : FALLBACK_SCALE_START;
	const maxIntensity = intensities.length > 0 ? Math.max(...intensities) : FALLBACK_SCALE_END;
	const scaleStart = Number.isFinite(src.intensityScaleStart) ? (src.intensityScaleStart as number) : minIntensity;
	const scaleEnd = Number.isFinite(src.intensityScaleEnd) ? (src.intensityScaleEnd as number) : maxIntensity;

	// Day-of-year → box payload; a second entry on the same date wins (upstream array write).
	const mapped = new Map<number, {color: string; date: string; content?: string}>();
	for (const entry of entries) {
		const palette = paletteFor(palettes, entry.color === undefined ? undefined : String(entry.color));
		const levels = palette.length;
		const raw = Number.isFinite(entry.intensity) ? (entry.intensity as number) : defaultIntensity;
		const intensity =
			minIntensity === maxIntensity && scaleStart === scaleEnd
				? levels
				: Math.round(mapRange(raw, scaleStart, scaleEnd, 1, levels));
		const content = entry.content === undefined || entry.content === "" ? undefined : String(entry.content);
		mapped.set(dayOfYearUTC(new Date(String(entry.date))), {
			color: palette[intensity - 1] ?? palette[levels - 1]!,
			date: String(entry.date),
			content,
		});
	}

	const boxes: HeatmapBox[] = [];
	// Upstream: `(firstOfYear.getUTCDay() + 7 - weekStartDay) % 7` transparent filler boxes.
	const firstOfYear = new Date(Date.UTC(year, 0, 1));
	for (let blanks = (firstOfYear.getUTCDay() + 7 - weekStartDay) % 7; blanks > 0; blanks--) {
		boxes.push({color: "transparent", classes: []});
	}

	const daysInYear = dayOfYearUTC(new Date(Date.UTC(year, 11, 31)));
	const todayDayNumber = year === today.getFullYear() ? dayOfYearLocal(today) : -1;
	for (let day = 1; day <= daysInYear; day++) {
		const month = MONTH_SHORT[new Date(Date.UTC(year, 0, day)).getUTCMonth()]!;
		const classes = [`month-${month.toLowerCase()}`];
		if (day === todayDayNumber && showTodayBorder) classes.push("today");
		const hit = mapped.get(day);
		if (hit === undefined) {
			classes.push("isEmpty");
			boxes.push({classes});
		} else {
			classes.push("hasData");
			boxes.push({color: hit.color, date: hit.date, content: hit.content, classes});
		}
	}

	return {kind: "heatmap", year, weekdays: heatmapWeekdays(weekStartDay), boxes};
}
