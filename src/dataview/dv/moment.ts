/**
 * `moment` — Moment.js-compatible date facade for the dataviewjs sandbox.
 *
 * Obsidian ships Moment.js and exposes it app-wide (`obsidian.d.ts`:
 * `export const moment: typeof Moment`), so vault snippets written for Obsidian
 * call `moment("2024-01-15").add(1, "day").format("YYYY-MM-DD")` inside both
 * `dataviewjs` blocks and inline `$=` queries. This module supplies that
 * callable without a runtime dependency (the project ships zero runtime npm
 * deps), covering the surface real snippets use.
 *
 * Documented adaptations (everything else mirrors Moment semantics — including
 * date-only strings parsing as **local** midnight, 0-based `month()`, Sunday
 * `day()`, month/year arithmetic clamping Jan 31 + 1 month → Feb 28/29, and
 * immutability of every modifier):
 *  - Locale: English only. `moment.locale()` accepts a value and reports "en";
 *    there are no locale data files, no `moment.localeData()` internals and no
 *    plugins (`moment-precise-range`, `moment-business-days`, …).
 *  - Time zones: the local zone, UTC and fixed numeric offsets
 *    (`moment.utc`, `moment.unix`, `.utc()`, `.local()`, `.utcOffset(min)`,
 *    `moment.parseZone`). There is no IANA tz database, so DST-aware zone
 *    arithmetic beyond the local zone is out of scope.
 *  - `diff(unit, true)`: exact for everything below a month; month/quarter/year
 *    fractions are derived from the day difference (Moment's own month
 *    fraction algorithm is not replicated).
 *  - `startOf("week")` follows the `weekStart` option (default Sunday = Moment's
 *    `en` locale); `isoWeek()`/`startOf("isoWeek")` are ISO-8601 (Monday).
 *  - `calendar()` implements Moment's default `en` formats (Today/Yesterday/
 *    weekday/`L`).
 */
/** The part of `DvDate` this facade reads (Dataview's own date type). */
export interface DvDateLike {
	toMillis(): number;
	toJSDate?(): Date;
}

// ---------------------------------------------------------------------------
// constants + small helpers
// ---------------------------------------------------------------------------

const MONTHS_LONG = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
] as const;
const MONTHS_SHORT = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
/** Moment's `en` week order: Sunday first. */
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS_MIN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const MS_PER: Record<string, number> = {
	millisecond: 1,
	second: 1000,
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
};

/** Moment's default output format (ISO 8601 with offset). */
const DEFAULT_FORMAT = "YYYY-MM-DDTHH:mm:ssZ";

type Unit =
	| "millisecond" | "second" | "minute" | "hour" | "day" | "week"
	| "isoWeek" | "month" | "quarter" | "year" | "date";
type OffsetMode = "local" | number;

interface Fields {
	year: number;
	month: number; // 0-11
	date: number; // 1-31
	hour: number;
	minute: number;
	second: number;
	millisecond: number;
	day: number; // 0 = Sunday
}

export interface MomentOptions {
	/** Injectable clock (tests). Defaults to `Date.now`. */
	now?: () => number;
	/** Locale week start, 0 = Sunday (Moment `en` default). */
	weekStart?: number;
}

/** `DvDateLike` lives in its own file so `types.ts` stays dependency-free. */

const UNIT_ALIASES: Record<string, Unit> = {
	ms: "millisecond", millisecond: "millisecond", milliseconds: "millisecond",
	s: "second", second: "second", seconds: "second",
	m: "minute", minute: "minute", minutes: "minute",
	h: "hour", hour: "hour", hours: "hour",
	d: "day", day: "day", days: "day",
	w: "week", week: "week", weeks: "week",
	W: "isoWeek", isoWeek: "isoWeek", isoweek: "isoWeek",
	M: "month", month: "month", months: "month",
	date: "date", dates: "date",
	Q: "quarter", quarter: "quarter", quarters: "quarter",
	y: "year", year: "year", years: "year",
};

function unitOf(input: unknown): Unit | null {
	if (typeof input !== "string") return null;
	return UNIT_ALIASES[input] ?? UNIT_ALIASES[input.toLowerCase()] ?? null;
}

function pad(n: number, width: number): string {
	return String(Math.abs(n)).padStart(width, "0");
}

function ordinal(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
	switch (n % 10) {
		case 1: return `${n}st`;
		case 2: return `${n}nd`;
		case 3: return `${n}rd`;
		default: return `${n}th`;
	}
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** ISO-8601 week (Monday-based, week 1 contains Jan 4). */
export function isoWeekOf(year: number, month: number, date: number): {week: number; year: number} {
	const d = new Date(Date.UTC(year, month, date));
	const day = (d.getUTCDay() + 6) % 7; // Monday = 0
	d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
	const isoYear = d.getUTCFullYear();
	const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
	const firstDay = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
	const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
	return {week, year: isoYear};
}

/** Moment's `en` locale week: `weekStart`-based, week 1 contains Jan 1. */
export function localeWeekOf(year: number, month: number, date: number, weekStart: number): number {
	const jan1 = new Date(Date.UTC(year, 0, 1));
	const offset = (jan1.getUTCDay() - weekStart + 7) % 7; // days before the first week start
	const dayOfYear = Math.round((Date.UTC(year, month, date) - jan1.getTime()) / 86_400_000) + 1;
	return Math.ceil((dayOfYear + offset) / 7);
}

function dayOfYearOf(year: number, month: number, date: number): number {
	return Math.round((Date.UTC(year, month, date) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const OFFSET_TAIL = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?$/;

interface ParsedOffset {
	ms: number;
	offset: number | null;
}

/**
 * Parse an ISO-ish string. Native `Date.parse` treats a **date-only** string as
 * UTC, while Moment treats it as local midnight — the difference matters for
 * every `moment("2024-01-15").format()` snippet, so date-only strings are built
 * field-by-field in local time here.
 */
function offsetMinutesOf(raw: string): number {
	if (raw.toUpperCase() === "Z") return 0;
	const sign = raw[0] === "-" ? -1 : 1;
	const digits = raw.slice(1).replace(":", "");
	return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/**
 * Parse an ISO-ish string. Two Moment rules that native `Date.parse` gets wrong:
 *  - a date-only string is **local** midnight in Moment (native: UTC), and
 *  - a zone-less date-time is read in the requested mode, so `moment.utc("…T10:00:00")`
 *    is 10:00 UTC while `moment("…T10:00:00")` is 10:00 local.
 * An explicit zone always wins (it fixes both the instant and the displayed offset).
 */
function parseIso(str: string, utc: boolean): ParsedOffset {
	const trimmed = str.trim();
	const tail = OFFSET_TAIL.exec(trimmed);
	if (tail) {
		return {ms: Date.parse(trimmed), offset: offsetMinutesOf(tail[1]!)};
	}
	const m = ISO_PARTS.exec(trimmed);
	if (!m) {
		// Lenient fallback for the other shapes the host accepts (RFC 2822, …).
		return {ms: Date.parse(trimmed), offset: utc ? 0 : null};
	}
	const year = Number(m[1]);
	const month = Number(m[2]);
	const date = Number(m[3]);
	const hour = m[4] === undefined ? 0 : Number(m[4]);
	const minute = m[5] === undefined ? 0 : Number(m[5]);
	const second = m[6] === undefined ? 0 : Number(m[6]);
	const millisecond = m[7] === undefined ? 0 : Math.round(Number(`0.${m[7]}`) * 1000);
	// Out-of-range calendar fields are invalid (Moment), never silently rolled over.
	if (month < 1 || month > 12 || date < 1 || date > daysInMonth(year, month - 1)
		|| hour > 23 || minute > 59 || second > 59) {
		return {ms: Number.NaN, offset: null};
	}
	const ms = utc
		? Date.UTC(year, month - 1, date, hour, minute, second, millisecond)
		: new Date(year, month - 1, date, hour, minute, second, millisecond).getTime();
	return {ms, offset: utc ? 0 : null};
}

/** Format-directed parse for the tokens snippets actually use. */
function parseWithFormat(str: string, format: string, utc: boolean): number {
	const parts: Record<string, number> = {year: 1970, month: 0, date: 1, hour: 0, minute: 0, second: 0, millisecond: 0};
	let pm: boolean | null = null;
	const rx = new RegExp(
		format
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|A|a|Z|ZZ/g, (t) => {
				switch (t) {
					case "YYYY": return "(?<y>\\d{4})";
					case "YY": return "(?<yy>\\d{2})";
					case "MM": case "M": return "(?<mo>\\d{1,2})";
					case "DD": case "D": return "(?<d>\\d{1,2})";
					case "HH": case "H": case "hh": case "h": return "(?<h>\\d{1,2})";
					case "mm": case "m": return "(?<mi>\\d{1,2})";
					case "ss": case "s": return "(?<se>\\d{1,2})";
					case "SSS": return "(?<ms>\\d{1,3})";
					case "A": case "a": return "(?<ap>[AaPp][Mm])";
					case "Z": return "(?<z>[+-]\\d{2}:\\d{2}|Z)";
					case "ZZ": return "(?<z2>[+-]\\d{4}|Z)";
					default: return t;
				}
			}),
		"i",
	);
	const m = rx.exec(str.trim());
	if (!m || !m.groups) return Number.NaN;
	const g = m.groups;
	if (g.y !== undefined) parts.year = Number(g.y);
	else if (g.yy !== undefined) parts.year = 2000 + Number(g.yy);
	if (g.mo !== undefined) parts.month = Number(g.mo) - 1;
	if (g.d !== undefined) parts.date = Number(g.d);
	if (g.h !== undefined) parts.hour = Number(g.h);
	if (g.mi !== undefined) parts.minute = Number(g.mi);
	if (g.se !== undefined) parts.second = Number(g.se);
	if (g.ms !== undefined) parts.millisecond = Number(g.ms.padEnd(3, "0"));
	if (g.ap !== undefined) pm = g.ap.toLowerCase() === "pm";
	if (pm === true && parts.hour! < 12) parts.hour = parts.hour! + 12;
	if (pm === false && parts.hour! === 12) parts.hour = 0;
	const offset = g.z ?? g.z2;
	const base = utc
		? Date.UTC(parts.year!, parts.month!, parts.date!, parts.hour!, parts.minute!, parts.second!, parts.millisecond!)
		: new Date(parts.year!, parts.month!, parts.date!, parts.hour!, parts.minute!, parts.second!, parts.millisecond!).getTime();
	if (offset && offset.toUpperCase() !== "Z") {
		const sign = offset[0] === "-" ? -1 : 1;
		const digits = offset.slice(1).replace(":", "");
		const minutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
		return base - minutes * 60_000;
	}
	return base;
}

function isDvDateLike(value: unknown): value is DvDateLike {
	return typeof value === "object" && value !== null
		&& (typeof (value as DvDateLike).toJSDate === "function" || typeof (value as DvDateLike).toMillis === "function");
}

function isDateObject(value: unknown): boolean {
	return Object.prototype.toString.call(value) === "[object Date]";
}

// ---------------------------------------------------------------------------
// Moment value
// ---------------------------------------------------------------------------

/**
 * A single immutable instant. Every modifier returns a new instance (Moment
 * semantics), so chains like `moment(x).add(1, "day").format()` never mutate the
 * caller's value.
 */
export class MomentValue {
	private msValue: number;
	private mode: OffsetMode;
	private readonly weekStart: number;
	private readonly clock: () => number;

	constructor(ms: number, mode: OffsetMode, weekStart: number, clock: () => number) {
		this.msValue = ms;
		this.mode = mode;
		this.weekStart = weekStart;
		this.clock = clock;
	}

	// -- internals ----------------------------------------------------------

	/** Wall-clock milliseconds: the instant shifted into the displayed offset. */
	private wall(): number {
		return this.mode === "local" ? this.msValue : this.msValue + this.mode * 60_000;
	}

	private fromWall(wallMs: number): number {
		return this.mode === "local" ? wallMs : wallMs - this.mode * 60_000;
	}

	private fields(): Fields {
		const wall = this.wall();
		if (this.mode === "local") {
			const d = new Date(wall);
			return {
				year: d.getFullYear(), month: d.getMonth(), date: d.getDate(), day: d.getDay(),
				hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), millisecond: d.getMilliseconds(),
			};
		}
		const d = new Date(wall);
		return {
			year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(), day: d.getUTCDay(),
			hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), millisecond: d.getUTCMilliseconds(),
		};
	}

	private withFields(patch: Partial<Fields>): MomentValue {
		const f = {...this.fields(), ...patch};
		const wall = this.mode === "local"
			? new Date(f.year, f.month, f.date, f.hour, f.minute, f.second, f.millisecond).getTime()
			: Date.UTC(f.year, f.month, f.date, f.hour, f.minute, f.second, f.millisecond);
		return this.cloneWith(this.fromWall(wall), this.mode);
	}

	private cloneWith(ms: number, mode: OffsetMode = this.mode): MomentValue {
		return new MomentValue(ms, mode, this.weekStart, this.clock);
	}

	/**
	 * Adopt `next`'s instant/mode and return **this** — Moment's modifiers mutate
	 * the receiver (`const m = moment(); m.add(1, "day")` changes `m`), and vault
	 * snippets rely on that, so the facade reproduces it. `clone()` is the way to
	 * keep the original.
	 */
	private become(next: MomentValue): MomentValue {
		this.msValue = next.msValue;
		this.mode = next.mode;
		return this;
	}

	/** Month arithmetic with Moment's clamping (Jan 31 + 1 month → Feb 28/29). */
	private addMonths(months: number): MomentValue {
		const f = this.fields();
		const total = f.year * 12 + f.month + months;
		const year = Math.floor(total / 12);
		const month = ((total % 12) + 12) % 12;
		const date = Math.min(f.date, daysInMonth(year, month));
		return this.withFields({year, month, date});
	}

	// -- offsets ------------------------------------------------------------

	utc(): MomentValue { this.mode = 0; return this; }
	local(): MomentValue { this.mode = "local"; return this; }
	isUTC(): boolean { return this.mode === 0; }
	utcOffset(): number;
	utcOffset(minutes: number, keepLocalTime?: boolean): MomentValue;
	utcOffset(minutes?: number, keepLocalTime?: boolean): number | MomentValue {
		if (minutes === undefined) {
			return this.mode === "local" ? -new Date(this.msValue).getTimezoneOffset() : this.mode;
		}
		if (keepLocalTime) {
			// Keep the wall clock, move the instant (Moment's default is the reverse).
			const f = this.fields();
			const wall = Date.UTC(f.year, f.month, f.date, f.hour, f.minute, f.second, f.millisecond);
			return this.become(new MomentValue(wall - minutes * 60_000, minutes, this.weekStart, this.clock));
		}
		this.mode = minutes;
		return this;
	}

	// -- state --------------------------------------------------------------

	isValid(): boolean { return !Number.isNaN(this.msValue); }
	valueOf(): number { return this.msValue; }
	unix(): number { return Math.floor(this.msValue / 1000); }
	toDate(): Date { return new Date(this.msValue); }
	toArray(): number[] {
		const f = this.fields();
		return [f.year, f.month, f.date, f.hour, f.minute, f.second, f.millisecond];
	}
	toObject(): Fields & {date: number} { return {...this.fields()}; }
	toJSON(): string | null { return this.isValid() ? this.toISOString() : null; }
	toISOString(keepOffset = false): string {
		if (!this.isValid()) return "Invalid date";
		if (!keepOffset) return new Date(this.msValue).toISOString();
		return this.format("YYYY-MM-DD[T]HH:mm:ss.SSSZ");
	}
	clone(): MomentValue { return this.cloneWith(this.msValue); }
	locale(): string { return "en"; }

	format(format?: string): string {
		if (!this.isValid()) return "Invalid date";
		return formatMs(this, format ?? DEFAULT_FORMAT);
	}

	// -- field accessors ----------------------------------------------------

	year(): number;
	year(value: number): MomentValue;
	year(value?: number): number | MomentValue {
		return value === undefined ? this.fields().year : this.set("year", value);
	}
	month(): number;
	month(value: number): MomentValue;
	month(value?: number): number | MomentValue {
		return value === undefined ? this.fields().month : this.set("month", value);
	}
	date(): number;
	date(value: number): MomentValue;
	date(value?: number): number | MomentValue {
		return value === undefined ? this.fields().date : this.set("date", value);
	}
	day(): number;
	day(value: number): MomentValue;
	day(value?: number): number | MomentValue {
		// Moment's day setter moves within the current week (Sunday-based here).
		return value === undefined ? this.fields().day : this.add(value - this.fields().day, "day");
	}
	/** Locale weekday index (0 = `weekStart`; Moment's `en` = Sunday). */
	weekday(): number;
	weekday(value: number): MomentValue;
	weekday(value?: number): number | MomentValue {
		const current = (this.fields().day - this.weekStart + 7) % 7;
		return value === undefined ? current : this.add(value - current, "day");
	}
	isoWeekday(): number;
	isoWeekday(value: number): MomentValue;
	isoWeekday(value?: number): number | MomentValue {
		const current = ((this.fields().day + 6) % 7) + 1;
		return value === undefined ? current : this.add(value - current, "day");
	}
	hour(): number;
	hour(value: number): MomentValue;
	hour(value?: number): number | MomentValue {
		return value === undefined ? this.fields().hour : this.set("hour", value);
	}
	hours(): number;
	hours(value: number): MomentValue;
	hours(value?: number): number | MomentValue { return this.hour(value as number); }
	minute(): number;
	minute(value: number): MomentValue;
	minute(value?: number): number | MomentValue {
		return value === undefined ? this.fields().minute : this.set("minute", value);
	}
	minutes(): number;
	minutes(value: number): MomentValue;
	minutes(value?: number): number | MomentValue { return this.minute(value as number); }
	second(): number;
	second(value: number): MomentValue;
	second(value?: number): number | MomentValue {
		return value === undefined ? this.fields().second : this.set("second", value);
	}
	seconds(): number;
	seconds(value: number): MomentValue;
	seconds(value?: number): number | MomentValue { return this.second(value as number); }
	millisecond(): number;
	millisecond(value: number): MomentValue;
	millisecond(value?: number): number | MomentValue {
		return value === undefined ? this.fields().millisecond : this.set("millisecond", value);
	}
	milliseconds(): number;
	milliseconds(value: number): MomentValue;
	milliseconds(value?: number): number | MomentValue { return this.millisecond(value as number); }
	quarter(): number;
	quarter(value: number): MomentValue;
	quarter(value?: number): number | MomentValue {
		if (value === undefined) return Math.floor(this.fields().month / 3) + 1;
		// Moment keeps the month's position inside the quarter.
		return this.set("month", (value - 1) * 3 + (this.fields().month % 3));
	}
	dayOfYear(): number;
	dayOfYear(value: number): MomentValue;
	dayOfYear(value?: number): number | MomentValue {
		const f = this.fields();
		const current = dayOfYearOf(f.year, f.month, f.date);
		return value === undefined ? current : this.add(value - current, "day");
	}
	week(): number;
	week(value: number): MomentValue;
	week(value?: number): number | MomentValue {
		const f = this.fields();
		const current = localeWeekOf(f.year, f.month, f.date, this.weekStart);
		// Whole-week move inside the current week-year (Moment's setter is exact
		// around year boundaries; documented as approximate).
		return value === undefined ? current : this.add((value - current) * 7, "day");
	}
	isoWeek(): number;
	isoWeek(value: number): MomentValue;
	isoWeek(value?: number): number | MomentValue {
		const f = this.fields();
		const current = isoWeekOf(f.year, f.month, f.date).week;
		return value === undefined ? current : this.add((value - current) * 7, "day");
	}
	daysInMonth(): number { const f = this.fields(); return daysInMonth(f.year, f.month); }
	isLeapYear(): boolean { return isLeapYear(this.fields().year); }
	startOf(unit?: string): MomentValue { return this.become(this.toStartOf(unitOf(unit) ?? "millisecond")); }
	endOf(unit?: string): MomentValue { return this.become(this.toEndOf(unitOf(unit) ?? "millisecond")); }

	/** Public for the formatter/relatives — every field read goes through here. */
	_fields(): Fields { return this.fields(); }

	/** Month arithmetic with Moment's clamping (Jan 31 + 1 month → Feb 28/29). */
	_addMonths(months: number): MomentValue { return this.addMonths(months); }

	private toStartOf(unit: Unit): MomentValue {
		const f = this.fields();
		switch (unit) {
			case "year": return this.withFields({month: 0, date: 1, hour: 0, minute: 0, second: 0, millisecond: 0});
			case "quarter": return this.withFields({month: Math.floor(f.month / 3) * 3, date: 1, hour: 0, minute: 0, second: 0, millisecond: 0});
			case "month": return this.withFields({date: 1, hour: 0, minute: 0, second: 0, millisecond: 0});
			case "week": return this.toStartOf("day").withFields({date: f.date - ((f.day - this.weekStart + 7) % 7)});
			case "isoWeek": return this.toStartOf("day").withFields({date: f.date - ((f.day + 6) % 7)});
			case "day": case "date": return this.withFields({hour: 0, minute: 0, second: 0, millisecond: 0});
			case "hour": return this.withFields({minute: 0, second: 0, millisecond: 0});
			case "minute": return this.withFields({second: 0, millisecond: 0});
			case "second": return this.withFields({millisecond: 0});
			default: return this.clone();
		}
	}

	private toEndOf(unit: Unit): MomentValue {
		if (unit === "millisecond") return this.clone();
		// endOf(unit) === startOf(unit) + 1 unit - 1ms: the calendar step keeps
		// days DST-safe (a local day is not always 24h).
		const start = this.toStartOf(unit);
		const nextStart = start.add(1, unit === "isoWeek" ? "week" : unit);
		return nextStart.cloneWith(nextStart.valueOf() - 1);
	}

	/** `get(unit)` — Moment exposes the same names as the accessor methods. */
	get(unit?: string): number {
		const u = unitOf(unit);
		switch (u) {
			case "year": return this.year();
			case "month": return this.month();
			case "day": return this.day();
			case "hour": return this.hour();
			case "minute": return this.minute();
			case "second": return this.second();
			case "millisecond": return this.millisecond();
			case "week": return this.week();
			case "isoWeek": return this.isoWeek();
			case "quarter": return this.quarter();
			case "date": case "day": return this.date();
			default: return this.date();
		}
	}

	/** `set(unit, value)` / `set({year: …, month: …})` — mutates, like Moment. */
	set(unit: string | Partial<Fields>, value?: number): MomentValue {
		if (typeof unit === "object") {
			const patch: Partial<Fields> = {};
			if (unit.year !== undefined) patch.year = unit.year;
			if (unit.month !== undefined) patch.month = unit.month;
			if (unit.date !== undefined) patch.date = unit.date;
			if (unit.hour !== undefined) patch.hour = unit.hour;
			if (unit.minute !== undefined) patch.minute = unit.minute;
			if (unit.second !== undefined) patch.second = unit.second;
			if (unit.millisecond !== undefined) patch.millisecond = unit.millisecond;
			return this.become(this.withFields(patch));
		}
		const v = value ?? 0;
		switch (unitOf(unit)) {
			case "year": return this.become(this.withFields({year: v, date: Math.min(this.fields().date, daysInMonth(v, this.fields().month))}));
			case "month": return this.become(this.withFields({month: v, date: Math.min(this.fields().date, daysInMonth(this.fields().year, v))}));
			case "date": case "day": return this.become(this.withFields({date: v}));
			case "hour": return this.become(this.withFields({hour: v}));
			case "minute": return this.become(this.withFields({minute: v}));
			case "second": return this.become(this.withFields({second: v}));
			case "millisecond": return this.become(this.withFields({millisecond: v}));
			default: return this;
		}
	}

	// -- arithmetic ---------------------------------------------------------

	add(value: number, unit?: string): MomentValue {
		return this.become(this.shift(value, unitOf(unit) ?? "millisecond"));
	}

	subtract(value: number, unit?: string): MomentValue {
		return this.become(this.shift(-value, unitOf(unit) ?? "millisecond"));
	}

	private shift(value: number, unit: Unit): MomentValue {
		if (value === 0) return this.clone();
		switch (unit) {
			case "month": return this.addMonths(value);
			case "quarter": return this.addMonths(value * 3);
			case "year": {
				const f = this.fields();
				const year = f.year + value;
				return this.withFields({year, date: Math.min(f.date, daysInMonth(year, f.month))});
			}
			case "week": {
				const f = this.fields();
				// Calendar days keep the wall clock across DST (Moment semantics).
				return this.withFields({date: f.date + value * 7});
			}
			case "day": case "date": return this.withFields({date: this.fields().date + value});
			default: return this.cloneWith(this.msValue + value * MS_PER[unit]!);
		}
	}

	// -- comparison ---------------------------------------------------------

	/**
	 * Coerce a comparison/diff argument. Moment parses a bare string with
	 * `createLocal` even when the receiver is UTC, so `utcMoment.isSame("2024-01-16", "day")`
	 * compares a LOCAL instant against the UTC unit window; matching that keeps
	 * snippets behaving the same here.
	 */
	private otherValue(input: unknown): number {
		return momentMsFrom(input, "local", this.clock);
	}

	/**
	 * Unit-scoped comparison follows Moment exactly: `isBefore(b, "day")` asks
	 * whether this whole unit ends before `b`, `isAfter` whether it starts after
	 * `b`, and `isSame` whether `b` falls inside this unit (end inclusive).
	 */
	isBefore(input: unknown, unit?: string): boolean {
		const o = this.otherValue(input);
		return unit ? this.toEndOf(unitOf(unit) ?? "millisecond").valueOf() < o : this.msValue < o;
	}
	isSame(input: unknown, unit?: string): boolean {
		const o = this.otherValue(input);
		if (Number.isNaN(o)) return false;
		if (!unit) return this.msValue === o;
		const u = unitOf(unit) ?? "millisecond";
		return o >= this.toStartOf(u).valueOf() && o <= this.toEndOf(u).valueOf();
	}
	isAfter(input: unknown, unit?: string): boolean {
		const o = this.otherValue(input);
		return unit ? this.toStartOf(unitOf(unit) ?? "millisecond").valueOf() > o : this.msValue > o;
	}
	isSameOrBefore(input: unknown, unit?: string): boolean { return this.isSame(input, unit) || this.isBefore(input, unit); }
	isSameOrAfter(input: unknown, unit?: string): boolean { return this.isSame(input, unit) || this.isAfter(input, unit); }
	isBetween(from: unknown, to: unknown, unit?: string): boolean {
		return this.isAfter(from, unit) && this.isBefore(to, unit);
	}

	/**
	 * `diff`. Exact for every unit below a month; month/quarter/year are counted
	 * whole (Moment semantics) and their `float` fraction is derived from the day
	 * difference — Moment's own month-fraction algorithm is not replicated.
	 */
	diff(input: unknown, unit?: string, float = false): number {
		const other = this.otherValue(input);
		const u: Unit = unitOf(unit) ?? "millisecond";
		if (u === "month" || u === "quarter" || u === "year") {
			const per = u === "month" ? 1 : u === "quarter" ? 3 : 12;
			const wholeUnits = Math.trunc(wholeMonths(other, this.msValue, this.mode, this.weekStart, this.clock) / per);
			if (!float) return wholeUnits;
			const anchor = new MomentValue(other, this.mode, this.weekStart, this.clock).addMonths(wholeUnits * per);
			const monthLength = daysInMonth(anchor.fields().year, anchor.fields().month) * MS_PER.day!;
			return wholeUnits + (this.msValue - anchor.valueOf()) / (monthLength * per);
		}
		const raw = (this.msValue - other) / (MS_PER[u] ?? 1);
		return float ? raw : Math.trunc(raw);
	}

	// -- relative -----------------------------------------------------------

	from(input: unknown, withoutSuffix = false): string {
		return relativeString(this.msValue, this.otherValue(input), withoutSuffix);
	}
	to(input: unknown, withoutSuffix = false): string {
		return relativeString(this.otherValue(input), this.msValue, withoutSuffix);
	}
	fromNow(withoutSuffix = false): string {
		return relativeString(this.msValue, this.clock(), withoutSuffix);
	}
	toNow(withoutSuffix = false): string {
		return relativeString(this.clock(), this.msValue, withoutSuffix);
	}
	calendar(reference?: unknown, formats?: Record<string, string>): string {
		return calendarString(this, reference === undefined ? this.clock() : this.otherValue(reference), formats);
	}
	formatOffset(): string {
		const minutes = this.mode === "local" ? -new Date(this.msValue).getTimezoneOffset() : this.mode;
		const sign = minutes >= 0 ? "+" : "-";
		const abs = Math.abs(minutes);
		return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
	}
	/** Internal: the fields/tokens formatter needs both. */
	_peek(): {ms: number; mode: OffsetMode; weekStart: number} {
		return {ms: this.msValue, mode: this.mode, weekStart: this.weekStart};
	}
}

/** Whole months between `from` and `to` (truncated toward zero). */
function wholeMonths(from: number, to: number, mode: OffsetMode, weekStart: number, clock: () => number): number {
	if (from === to) return 0;
	const sign = to > from ? 1 : -1;
	const lo = new MomentValue(sign === 1 ? from : to, mode, weekStart, clock);
	const hi = new MomentValue(sign === 1 ? to : from, mode, weekStart, clock);
	let months = (hi.year() - lo.year()) * 12 + (hi.month() - lo.month());
	if (lo._addMonths(months).valueOf() > hi.valueOf()) months -= 1;
	return months * sign;
}

// ---------------------------------------------------------------------------
// durations
// ---------------------------------------------------------------------------

export interface MomentDuration {
	valueOf(): number;
	asMilliseconds(): number;
	asSeconds(): number;
	asMinutes(): number;
	asHours(): number;
	asDays(): number;
	asWeeks(): number;
	asMonths(): number;
	asYears(): number;
	humanize(withSuffix?: boolean): string;
	readonly isDuration: true;
}

const MS_PER_MONTH_APPROX = 30.4375 * MS_PER.day!;
const MS_PER_YEAR_APPROX = 365.25 * MS_PER.day!;

function createDuration(ms: number): MomentDuration {
	return {
		valueOf: () => ms,
		asMilliseconds: () => ms,
		asSeconds: () => ms / MS_PER.second!,
		asMinutes: () => ms / MS_PER.minute!,
		asHours: () => ms / MS_PER.hour!,
		asDays: () => ms / MS_PER.day!,
		asWeeks: () => ms / MS_PER.week!,
		asMonths: () => ms / MS_PER_MONTH_APPROX,
		asYears: () => ms / MS_PER_YEAR_APPROX,
		humanize: (withSuffix = false) => relativeString(ms, 0, !withSuffix),
		isDuration: true,
	};
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function formatMs(m: MomentValue, format: string): string {
	const {mode, weekStart} = m._peek();
	const fields = m._fields();
	const {year, month, date, day, hour, minute, second, millisecond} = fields;
	const hour12 = hour % 12 === 0 ? 12 : hour % 12;
	const offsetMinutes = mode === "local" ? -new Date(m.valueOf()).getTimezoneOffset() : mode;
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const offsetAbs = Math.abs(offsetMinutes);
	const offset = `${offsetSign}${pad(Math.floor(offsetAbs / 60), 2)}:${pad(offsetAbs % 60, 2)}`;

	const short = {
		LTS: "h:mm:ss A", LT: "h:mm A", L: "MM/DD/YYYY", l: "M/D/YYYY",
		LL: "MMMM D, YYYY", ll: "MMM D, YYYY",
		LLL: "MMMM D, YYYY h:mm A", lll: "MMM D, YYYY h:mm A",
		LLLL: "dddd, MMMM D, YYYY h:mm A", llll: "ddd, MMM D, YYYY h:mm A",
	} as const;
	return format.replace(
		/\[([^\]]*)\]|\\(.)|LTS|LT|LLLL|LLL|LL|L|llll|lll|ll|l|YYYY|YY|Y|MMMM|MMM|MM|M|DDDD|DDD|Do|DD|D|dddd|ddd|dd|d|E|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|SS|S|A|a|ZZ|Z|X|x|Q|GGGG|W|ww|w|gggg/g,
		(match, literal: string | undefined, escaped: string | undefined) => {
			if (literal !== undefined) return literal;
			if (escaped !== undefined) return escaped;
			const localized = short[match as keyof typeof short];
			if (localized !== undefined) return formatMs(m, localized);
			switch (match) {
				case "YYYY": return pad(year, 4);
				case "YY": return pad(year % 100, 2);
				case "Y": return String(year);
				case "MMMM": return MONTHS_LONG[month]!;
				case "MMM": return MONTHS_SHORT[month]!;
				case "MM": return pad(month + 1, 2);
				case "M": return String(month + 1);
				case "DDDD": return pad(dayOfYearOf(year, month, date), 3);
				case "DDD": return String(dayOfYearOf(year, month, date));
				case "Do": return ordinal(date);
				case "DD": return pad(date, 2);
				case "D": return String(date);
				case "dddd": return WEEKDAYS_LONG[day]!;
				case "ddd": return WEEKDAYS_SHORT[day]!;
				case "dd": return WEEKDAYS_MIN[day]!;
				case "d": return String(day);
				case "E": return String((day + 6) % 7 + 1);
				case "HH": return pad(hour, 2);
				case "H": return String(hour);
				case "hh": return pad(hour12, 2);
				case "h": return String(hour12);
				case "kk": case "k": return String(hour === 0 ? 24 : hour).padStart(match === "kk" ? 2 : 1, "0");
				case "mm": return pad(minute, 2);
				case "m": return String(minute);
				case "ss": return pad(second, 2);
				case "s": return String(second);
				case "SSS": return pad(millisecond, 3);
				case "SS": return pad(Math.floor(millisecond / 10), 2);
				case "S": return String(Math.floor(millisecond / 100));
				case "A": return hour < 12 ? "AM" : "PM";
				case "a": return hour < 12 ? "am" : "pm";
				case "ZZ": return `${offsetSign}${pad(Math.floor(offsetAbs / 60), 2)}${pad(offsetAbs % 60, 2)}`;
				case "Z": return offset;
				case "X": return String(Math.floor(m.valueOf() / 1000));
				case "x": return String(m.valueOf());
				case "Q": return String(Math.floor(month / 3) + 1);
				case "GGGG": return pad(isoWeekOf(year, month, date).year, 4);
				case "W": return String(isoWeekOf(year, month, date).week);
				case "ww": return pad(localeWeekOf(year, month, date, weekStart), 2);
				case "w": return String(localeWeekOf(year, month, date, weekStart));
				case "gggg": return pad(year, 4);
				default: return match;
			}
		},
	);
}

/** Moment's English relative strings ("in 3 days", "a minute ago"). */
function relativeString(value: number, base: number, withoutSuffix: boolean): string {
	if (Number.isNaN(value) || Number.isNaN(base)) return "Invalid date";
	const delta = value - base;
	const past = delta < 0;
	const abs = Math.abs(delta);
	const sec = abs / 1000;
	const min = abs / MS_PER.minute!;
	const hrs = abs / MS_PER.hour!;
	const days = abs / MS_PER.day!;
	const months = days / 30.4375;
	const years = days / 365.25;
	let text: string;
	if (sec < 45) text = "a few seconds";
	else if (sec < 90) text = "a minute";
	else if (min < 45) text = `${Math.round(min)} minutes`;
	else if (min < 90) text = "an hour";
	else if (hrs < 22) text = `${Math.round(hrs)} hours`;
	else if (hrs < 36) text = "a day";
	else if (days < 25) text = `${Math.round(days)} days`;
	else if (days < 45) text = "a month";
	else if (days < 345) text = `${Math.round(months)} months`;
	else if (days < 548) text = "a year";
	else text = `${Math.round(years)} years`;
	if (withoutSuffix) return text;
	return past ? `${text} ago` : `in ${text}`;
}

/** Moment's default `calendar()` formats for the `en` locale. */
function calendarString(m: MomentValue, reference: number, formats?: Record<string, string>): string {
	const ref = new MomentValue(reference, m._peek().mode, m._peek().weekStart, () => reference);
	const diffDays = m.clone().startOf("day").diff(ref.clone().startOf("day"), "day");
	const defaults: Record<string, string> = {
		sameDay: "[Today at] LT",
		nextDay: "[Tomorrow at] LT",
		nextWeek: "dddd [at] LT",
		lastDay: "[Yesterday at] LT",
		lastWeek: "[Last] dddd [at] LT",
		sameElse: "L",
	};
	const table = {...defaults, ...(formats ?? {})};
	let key: string;
	if (diffDays < -6) key = "sameElse";
	else if (diffDays < -1) key = "lastWeek";
	else if (diffDays < 0) key = "lastDay";
	else if (diffDays < 1) key = "sameDay";
	else if (diffDays < 2) key = "nextDay";
	else if (diffDays < 7) key = "nextWeek";
	else key = "sameElse";
	return m.format(table[key] ?? table.sameElse!);
}

// ---------------------------------------------------------------------------
// input coercion
// ---------------------------------------------------------------------------

function momentMsFrom(input: unknown, mode: OffsetMode, clock: () => number): number {
	if (input === undefined || input === null) return clock();
	if (typeof input === "number") return input;
	if (typeof input === "string") return parseIso(input, mode === 0).ms;
	if (input instanceof MomentValue) return input.valueOf();
	if (isDateObject(input)) return (input as Date).getTime();
	if (isDvDateLike(input)) {
		return typeof input.toJSDate === "function" ? input.toJSDate().getTime() : input.toMillis();
	}
	if (Array.isArray(input)) {
		const parts = input as number[];
		const y = parts[0] ?? 1970, mo = parts[1] ?? 0, d = parts[2] ?? 1;
		const h = parts[3] ?? 0, mi = parts[4] ?? 0, s = parts[5] ?? 0, ms = parts[6] ?? 0;
		return mode === "local"
			? new Date(y, mo, d, h, mi, s, ms).getTime()
			: Date.UTC(y, mo, d, h, mi, s, ms);
	}
	if (typeof input === "object") {
		const o = input as Partial<Fields>;
		const f: Fields = {
			year: o.year ?? 1970, month: o.month ?? 0, date: o.date ?? 1, day: 0,
			hour: o.hour ?? 0, minute: o.minute ?? 0, second: o.second ?? 0, millisecond: o.millisecond ?? 0,
		};
		return mode === "local"
			? new Date(f.year, f.month, f.date, f.hour, f.minute, f.second, f.millisecond).getTime()
			: Date.UTC(f.year, f.month, f.date, f.hour, f.minute, f.second, f.millisecond);
	}
	return Number.NaN;
}

// ---------------------------------------------------------------------------
// the global
// ---------------------------------------------------------------------------

export interface MomentFactory {
	(input?: unknown, format?: string | boolean, strict?: boolean): MomentValue;
	utc(input?: unknown, format?: string): MomentValue;
	unix(seconds: number): MomentValue;
	parseZone(input: unknown): MomentValue;
	now(): number;
	isMoment(value: unknown): boolean;
	isDate(value: unknown): boolean;
	isDuration(value: unknown): boolean;
	min(...values: unknown[]): MomentValue;
	max(...values: unknown[]): MomentValue;
	duration(input?: unknown, unit?: string): MomentDuration;
	locale(name?: string): string;
	months(): string[];
	monthsShort(): string[];
	weekdays(): string[];
	weekdaysShort(): string[];
	weekdaysMin(): string[];
	version: string;
}

/**
 * Build the sandbox `moment` global. `opts.now`/`opts.weekStart` are test seams;
 * the sandbox uses the defaults.
 */
export function createMomentGlobal(opts: MomentOptions = {}): MomentFactory {
	const clock = opts.now ?? (() => Date.now());
	const weekStart = opts.weekStart ?? 0;

	const factory = ((input?: unknown, format?: string | boolean, _strict?: boolean) => {
		// moment(undefined) → now; moment("2024-01-15") → local midnight.
		if (typeof format === "string") {
			const ms = input === undefined ? clock() : parseWithFormat(String(input), format, false);
			return new MomentValue(ms, "local", weekStart, clock);
		}
		const mode: OffsetMode = format === true ? 0 : "local";
		return new MomentValue(momentMsFrom(input, mode, clock), mode, weekStart, clock);
	}) as MomentFactory;

	factory.utc = (input?: unknown, format?: string) => {
		const ms = typeof format === "string" && input !== undefined
			? parseWithFormat(String(input), format, true)
			: momentMsFrom(input, 0, clock);
		return new MomentValue(ms, 0, weekStart, clock);
	};
	factory.unix = (seconds: number) => new MomentValue(seconds * 1000, "local", weekStart, clock);
	factory.parseZone = (input: unknown) => {
		const parsed = typeof input === "string" ? parseIso(input, false) : {ms: momentMsFrom(input, "local", clock), offset: null};
		return new MomentValue(parsed.ms, parsed.offset ?? "local", weekStart, clock);
	};
	factory.now = () => clock();
	factory.isMoment = (value: unknown) => value instanceof MomentValue;
	factory.isDate = (value: unknown) => isDateObject(value);
	factory.isDuration = (value: unknown) => typeof value === "object" && value !== null && (value as MomentDuration).isDuration === true;
	factory.min = (...values: unknown[]) => {
		const instants = values.flat().map((v) => new MomentValue(momentMsFrom(v, "local", clock), "local", weekStart, clock));
		return instants.reduce((a, b) => (b.valueOf() < a.valueOf() ? b : a));
	};
	factory.max = (...values: unknown[]) => {
		const instants = values.flat().map((v) => new MomentValue(momentMsFrom(v, "local", clock), "local", weekStart, clock));
		return instants.reduce((a, b) => (b.valueOf() > a.valueOf() ? b : a));
	};
	factory.duration = (input?: unknown, unit?: string) => {
		if (input === undefined) return createDuration(0);
		if (typeof input === "number") {
			const u = unitOf(unit) ?? "millisecond";
			return createDuration(input * (MS_PER[u] ?? 1));
		}
		if (typeof input === "object" && input !== null) {
			const o = input as Record<string, number | undefined>;
			const n = (...keys: string[]): number => {
				for (const k of keys) {
					const v = o[k];
					if (typeof v === "number") return v;
				}
				return 0;
			};
			// Moment accepts both `{days: 1}` and `{day: 1}` spellings.
			const ms = n("years", "year") * MS_PER_YEAR_APPROX
				+ n("months", "month") * MS_PER_MONTH_APPROX
				+ n("weeks", "week") * MS_PER.week!
				+ n("days", "date", "day") * MS_PER.day!
				+ n("hours", "hour") * MS_PER.hour!
				+ n("minutes", "minute") * MS_PER.minute!
				+ n("seconds", "second") * MS_PER.second!
				+ n("milliseconds", "millisecond");
			return createDuration(ms);
		}
		return createDuration(0);
	};
	factory.locale = () => "en";
	factory.months = () => [...MONTHS_LONG];
	factory.monthsShort = () => [...MONTHS_SHORT];
	factory.weekdays = () => [...WEEKDAYS_LONG];
	factory.weekdaysShort = () => [...WEEKDAYS_SHORT];
	factory.weekdaysMin = () => [...WEEKDAYS_MIN];
	factory.version = "2.29.4-compat";

	return factory;
}
