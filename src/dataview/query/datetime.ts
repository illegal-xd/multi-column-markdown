/**
 * Golden date/duration implementation (Luxon-lite subset).
 *
 * Dataview ships Luxon; we implement only the surface our docs/tests rely on.
 * Deviations are listed in docs/dataview-differences.md.
 */
import type {DateDelta, DvDate, Duration} from "../types";

const MS = {s: 1000, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3} as const;
/** Luxon "casual" factors — identical to what `Duration.as` uses. */
const MONTH_MS = 30 * MS.d;
const QUARTER_MS = 91 * MS.d;
const YEAR_MS = 365 * MS.d;

/** Units accepted by startOf/endOf/hasSame (mirrors types.ts `DvDate`). */
type DvUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
] as const;

function pad(n: number, w: number): string {
	return String(n).padStart(w, "0");
}

/** Last day (28-31) of the given 1-based month, UTC. */
function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Start of `unit` for an epoch-ms instant (UTC, no locale/DST involvement). */
function startOfMs(t: number, unit: DvUnit): number {
	const d = new Date(t);
	d.setUTCMilliseconds(0);
	if (unit === "second") return d.getTime();
	d.setUTCSeconds(0);
	if (unit === "minute") return d.getTime();
	d.setUTCMinutes(0);
	if (unit === "hour") return d.getTime();
	d.setUTCHours(0);
	if (unit === "day") return d.getTime();
	if (unit === "week") {
		const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (wd - 1));
	}
	d.setUTCDate(1);
	if (unit === "month") return d.getTime();
	d.setUTCMonth(0);
	return d.getTime();
}

/** ISO-8601 week-date parts (ISO week 1 contains the year's first Thursday). */
function isoWeekDate(t: number): {year: number; week: number; day: number} {
	const d = new Date(t);
	const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
	const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (4 - day));
	const year = new Date(thursday).getUTCFullYear();
	const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / MS.d + 1) / 7);
	return {year, week, day};
}

/** Luxon's default `toRelative` thresholds, reworded deterministically (no Intl). */
function relativeValue(abs: number): [number, string] {
	if (abs < 45 * MS.s) return [Math.round(abs / MS.s), "second"];
	if (abs < 90 * MS.s) return [1, "minute"];
	if (abs < 45 * MS.m) return [Math.round(abs / MS.m), "minute"];
	if (abs < 90 * MS.m) return [1, "hour"];
	if (abs < 22 * MS.h) return [Math.round(abs / MS.h), "hour"];
	if (abs < 36 * MS.h) return [1, "day"];
	if (abs < 26 * MS.d) return [Math.round(abs / MS.d), "day"];
	if (abs < 46 * MS.d) return [1, "month"];
	if (abs < 320 * MS.d) return [Math.round(abs / MONTH_MS), "month"];
	if (abs < 548 * MS.d) return [1, "year"];
	return [Math.round(abs / YEAR_MS), "year"];
}

function formatRelative(delta: number): string {
	if (delta === 0) return "now";
	const [value, unit] = relativeValue(Math.abs(delta));
	const label = value === 1 ? unit : unit + "s";
	return delta > 0 ? `in ${value} ${label}` : `${value} ${label} ago`;
}

/** Accepts a DvDate, a `{base: DvDate}` options object, or epoch millis. */
function relativeBaseMs(base: unknown): number | null {
	if (base === null || base === undefined) return null;
	if (typeof base === "number") return Number.isFinite(base) ? base : null;
	if (typeof base !== "object") return null;
	if (isDvDateLike(base)) return base.toMillis();
	const inner = (base as {base?: unknown}).base;
	return inner === undefined ? null : relativeBaseMs(inner);
}

class DvDateImpl implements DvDate {
	readonly #t: number;

	constructor(t: number) {
		this.#t = t;
	}

	static from(d: Date): DvDateImpl {
		return new DvDateImpl(d.getTime());
	}

	private get d(): Date {
		return new Date(this.#t);
	}

	get iso(): string {
		return this.toISO();
	}

	get year(): number {
		return this.d.getUTCFullYear();
	}

	get month(): number {
		return this.d.getUTCMonth() + 1;
	}

	get day(): number {
		return this.d.getUTCDate();
	}

	get hour(): number {
		return this.d.getUTCHours();
	}

	get minute(): number {
		return this.d.getUTCMinutes();
	}

	get second(): number {
		return this.d.getUTCSeconds();
	}

	get weekday(): number {
		const w = this.d.getUTCDay();
		return w === 0 ? 7 : w;
	}

	/** Token subset: yyyy yy MM M dd d HH H mm m ss s — others pass through. */
	toFormat(fmt: string): string {
		const pad = (n: number, w: number) => String(n).padStart(w, "0");
		return fmt.replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g, (tok) => {
			switch (tok) {
				case "yyyy":
					return pad(this.year, 4);
				case "yy":
					return pad(this.year % 100, 2);
				case "MM":
					return pad(this.month, 2);
				case "M":
					return String(this.month);
				case "dd":
					return pad(this.day, 2);
				case "d":
					return String(this.day);
				case "HH":
					return pad(this.hour, 2);
				case "H":
					return String(this.hour);
				case "mm":
					return pad(this.minute, 2);
				case "m":
					return String(this.minute);
				case "ss":
					return pad(this.second, 2);
				default:
					return String(this.second);
			}
		});
	}

	toISO(): string {
		return new Date(this.#t).toISOString();
	}

	toMillis(): number {
		return this.#t;
	}

	/** Luxon `DateTime.toJSDate`: a native `Date` for the same instant. */
	toJSDate(): Date {
		return this.d;
	}

	plus(delta: DateDelta): DvDate {
		return new DvDateImpl(shift(this.#t, delta, 1));
	}

	minus(delta: DateDelta): DvDate {
		return new DvDateImpl(shift(this.#t, delta, -1));
	}

	startOf(unit: DvUnit): DvDate {
		return new DvDateImpl(startOfMs(this.#t, unit));
	}

	/** End of unit = startOf(unit) + 1 unit − 1ms (Luxon semantics: no day overflow). */
	endOf(unit: DvUnit): DvDate {
		const delta: DateDelta = {};
		(delta as Record<string, number>)[unit + "s"] = 1;
		return new DvDateImpl(shift(startOfMs(this.#t, unit), delta, 1) - 1);
	}

	/** Replace calendar fields; `day` is clamped to the target month's length. */
	set(parts: {
		year?: number;
		month?: number;
		day?: number;
		hour?: number;
		minute?: number;
		second?: number;
		millisecond?: number;
	}): DvDate {
		const year = parts.year ?? this.year;
		const month = parts.month ?? this.month;
		const day = Math.min(parts.day ?? this.day, daysInMonth(year, month));
		const d = this.d;
		return new DvDateImpl(
			Date.UTC(
				year,
				month - 1,
				day,
				parts.hour ?? this.hour,
				parts.minute ?? this.minute,
				parts.second ?? this.second,
				parts.millisecond ?? d.getUTCMilliseconds(),
			),
		);
	}

	/**
	 * Whole-millisecond difference (`this - other`) as a Duration.
	 * `unit` is accepted for Luxon signature parity; months/years use the fixed
	 * 30d/365d factors instead of Luxon's calendar arithmetic (documented gap).
	 */
	diff(other: DvDate, _unit = "milliseconds"): Duration {
		return createDuration(this.#t - other.toMillis());
	}

	/** Duration from this instant to `other` (positive when `other` is later). */
	until(other: DvDate): Duration {
		return createDuration(other.toMillis() - this.#t);
	}

	hasSame(other: DvDate, unit: DvUnit): boolean {
		return startOfMs(this.#t, unit) === startOfMs(other.toMillis(), unit);
	}

	equals(other: DvDate): boolean {
		return other.toMillis() === this.#t;
	}

	toISODate(): string {
		return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
	}

	toISOTime(): string {
		return `${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}.${pad(this.d.getUTCMilliseconds(), 3)}Z`;
	}

	toISOWeekDate(): string {
		const w = isoWeekDate(this.#t);
		return `${pad(w.year, 4)}-W${pad(w.week, 2)}-${w.day}`;
	}

	/** Deterministic English relative wording ("in 3 days", "2 hours ago"). */
	toRelative(base?: DvDate | {base?: DvDate}): string {
		return formatRelative(this.#t - (relativeBaseMs(base) ?? Date.now()));
	}

	toObject(): Record<string, number> {
		const d = this.d;
		return {
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			hour: d.getUTCHours(),
			minute: d.getUTCMinutes(),
			second: d.getUTCSeconds(),
			millisecond: d.getUTCMilliseconds(),
		};
	}

	weekdayLong(): string {
		return WEEKDAY_NAMES[this.weekday - 1]!;
	}

	monthLong(): string {
		return MONTH_NAMES[this.month - 1]!;
	}

	daysInMonth(): number {
		return daysInMonth(this.year, this.month);
	}

	get isValid(): boolean {
		return true;
	}
}

/** Calendar-aware shift for y/m, fixed-ms shift for smaller units. */
function shift(t: number, delta: DateDelta, sign: 1 | -1): number {
	const d = new Date(t);
	if (delta.years) d.setUTCFullYear(d.getUTCFullYear() + sign * delta.years);
	if (delta.months) d.setUTCMonth(d.getUTCMonth() + sign * delta.months);
	let ms = 0;
	if (delta.weeks) ms += sign * delta.weeks * MS.w;
	if (delta.days) ms += sign * delta.days * MS.d;
	if (delta.hours) ms += sign * delta.hours * MS.h;
	if (delta.minutes) ms += sign * delta.minutes * MS.m;
	if (delta.seconds) ms += sign * delta.seconds * MS.s;
	if (delta.milliseconds) ms += sign * delta.milliseconds;
	return d.getTime() + ms;
}

/**
 * Unit → ms, matching Luxon's casual factors (year=365d, quarter=91d, month=30d).
 * Shared by `parseDuration` and the Duration method surface.
 */
const DURATION_UNIT_MS: Record<string, number> = {
	ms: 1,
	millisecond: 1,
	milliseconds: 1,
	millis: 1,
	s: MS.s,
	sec: MS.s,
	secs: MS.s,
	second: MS.s,
	seconds: MS.s,
	m: MS.m,
	min: MS.m,
	mins: MS.m,
	minute: MS.m,
	minutes: MS.m,
	h: MS.h,
	hr: MS.h,
	hrs: MS.h,
	hour: MS.h,
	hours: MS.h,
	d: MS.d,
	day: MS.d,
	days: MS.d,
	w: MS.w,
	week: MS.w,
	weeks: MS.w,
	month: MONTH_MS,
	months: MONTH_MS,
	quarter: QUARTER_MS,
	quarters: QUARTER_MS,
	y: YEAR_MS,
	year: YEAR_MS,
	years: YEAR_MS,
};

/** ms per unit name; undefined for unknown names (callers decide how to react). */
function unitMs(unit: string): number | undefined {
	return DURATION_UNIT_MS[unit.toLowerCase()];
}

/**
 * Parse durations: ISO-8601 ("P1DT2H"), compact ("1d2h30m"),
 * humanized ("2 hours 30 minutes"). Returns null when not a duration.
 */
export function parseDuration(input: string | number): Duration | null {
	if (typeof input === "number") return Number.isFinite(input) ? createDuration(input) : null;
	const s = input.trim();
	if (!s) return null;

	// ISO-8601: P[nY][nM][nW][nD][T[nH][nM][nS]]
	const iso = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
	if (iso && s.length > 1) {
		const [, y, mo, w, d, h, mi, sec] = iso;
		if (y ?? mo ?? w ?? d ?? h ?? mi ?? sec) {
			let ms = 0;
			if (y) ms += Number(y) * YEAR_MS;
			if (mo) ms += Number(mo) * MONTH_MS;
			if (w) ms += Number(w) * MS.w;
			if (d) ms += Number(d) * MS.d;
			if (h) ms += Number(h) * MS.h;
			if (mi) ms += Number(mi) * MS.m;
			if (sec) ms += Number(sec) * MS.s;
			return createDuration(ms);
		}
		return null;
	}

	// Compact / humanized: sequence of "<number> <unit>"
	let ms = 0;
	let matched = false;
	const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
	let m: RegExpExecArray | null = re.exec(s);
	while (m !== null) {
		const size = unitMs(m[2]!);
		if (size === undefined) return null;
		ms += Number(m[1]) * size;
		matched = true;
		m = re.exec(s);
	}
	// Bare "1d2h" without separators also matches the regex above.
	return matched ? createDuration(ms) : null;
}

/** Parse ISO strings, epoch millis, Date, or DvDate passthrough. */
export function parseDate(input: string | number | Date | DvDate): DvDate | null {
	if (input instanceof DvDateImpl) return input;
	if (typeof input === "number") {
		return Number.isFinite(input) ? DvDateImpl.from(new Date(input)) : null;
	}
	if (input instanceof Date) {
		return Number.isNaN(input.getTime()) ? null : DvDateImpl.from(input);
	}
	if (isDvDateLike(input)) return input;
	const s = input.trim();
	if (!s) return null;
	// Date-only → UTC midnight (Dataview treats date() as UTC).
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		const t = Date.parse(s + "T00:00:00.000Z");
		return Number.isNaN(t) ? null : new DvDateImpl(t);
	}
	const t = Date.parse(s);
	return Number.isNaN(t) ? null : DvDateImpl.from(new Date(t));
}

function isDvDateLike(v: unknown): v is DvDate {
	return typeof v === "object" && v !== null && "toFormat" in v && "toISO" in v && "year" in v;
}

export function now(): DvDate {
	return DvDateImpl.from(new Date());
}

/** Today at UTC midnight (Dataview `today()` uses local; documented gap). */
export function today(): DvDate {
	const d = new Date();
	return new DvDateImpl(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function createDvDate(t: number): DvDate {
	return DvDateImpl.from(new Date(t));
}

/** Strict equality used by expressions. */
export function datesEqual(a: DvDate, b: DvDate): boolean {
	return a.toMillis() === b.toMillis();
}

// ---------------------------------------------------------------------------
// Duration surface (Luxon-lite)
//
// The value stays `{ms}` (values.ts `isDuration` duck-types on that field), the
// methods are non-enumerable own properties so JSON.stringify/Object.keys and
// structured clone keep behaving exactly as before. Cross-boundary clones are
// rebuilt with `createDuration` (integrator wiring).
// ---------------------------------------------------------------------------

type DurationSelf = {
	ms: number;
	[DUR_SHIFTED]?: ReadonlyArray<readonly [string, number]>;
};

/** Slot holding the decomposition requested by `shiftTo` (absent = decompose on demand). */
const DUR_SHIFTED = Symbol("dataviewDurationShifted");

const DURATION_OBJECT_UNITS = ["years", "months", "days", "hours", "minutes", "seconds", "milliseconds"] as const;
/** toFormat/toString token units: y M w d h m s S. */
const DURATION_TOKEN_UNITS = ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"] as const;
const DURATION_FIELD_TOKENS: Record<string, string> = {
	y: "years",
	M: "months",
	w: "weeks",
	d: "days",
	h: "hours",
	m: "minutes",
	s: "seconds",
	S: "milliseconds",
};
/** Single-quoted literals pass through; repeated tokens pad (Luxon rule). */
const DURATION_FORMAT_RE = /'([^']*)'|([yMwdhmsS])\2*/g;

/**
 * One non-enumerable accessor per method, returning the method bound to this
 * value. Accessors are own properties, which matters twice:
 *   - `Object.keys`/`JSON.stringify`/structured clone stay exactly as before,
 *   - the DQL expression engine only sees own properties AND calls member
 *     functions detached (`const fn = rec[k]; fn(...)`) — a plain own method
 *     would run with `this === undefined`.
 */
function methodDescriptors(methods: Record<string, unknown>): PropertyDescriptorMap {
	const out: PropertyDescriptorMap = {};
	for (const name of Object.keys(methods)) {
		const fn = methods[name] as (this: unknown, ...args: never[]) => unknown;
		out[name] = {
			get(this: unknown) {
				return fn.bind(this);
			},
			enumerable: false,
			configurable: true,
		};
	}
	return out;
}

/** Re-decompose `ms` over `units` (largest first); the last unit keeps the fraction. */
function decompose(ms: number, units: readonly string[]): Array<[string, number]> {
	const sign = ms < 0 ? -1 : 1;
	let rest = Math.abs(ms);
	const out: Array<[string, number]> = [];
	for (let i = 0; i < units.length; i++) {
		const unit = units[i]!;
		const size = unitMs(unit) ?? 1;
		const value = i === units.length - 1 ? (sign * rest) / size : sign * Math.floor(rest / size);
		if (i !== units.length - 1) rest -= Math.abs(value) * size;
		out.push([unit, value === 0 ? 0 : value]); // collapse -0
	}
	return out;
}

/**
 * ISO-8601 from the ms decomposition ("PT8M", "P1DT2H", "PT0S").
 * Weeks are folded into days (year=365d, month=30d, day=rest) so that
 * `dur("8 days").toISO()` reads "P8D" rather than "P1W1D".
 */
function durationToISO(ms: number): string {
	const sign = ms < 0 ? "-" : "";
	let rest = Math.abs(ms);
	const parts: string[] = [];
	const add = (value: number, suffix: string): void => {
		if (value !== 0) parts.push(String(value) + suffix);
	};
	const consume = (size: number): number => {
		const whole = Math.floor(rest / size);
		rest -= whole * size;
		return whole;
	};
	add(consume(YEAR_MS), "Y");
	add(consume(MONTH_MS), "M");
	add(consume(MS.d), "D");
	const hours = consume(MS.h);
	const minutes = consume(MS.m);
	const seconds = consume(MS.s);
	const time: string[] = [];
	if (hours !== 0) time.push(hours + "H");
	if (minutes !== 0) time.push(minutes + "M");
	if (seconds !== 0 || rest !== 0) {
		time.push(String(Number((seconds + rest / MS.s).toFixed(6))) + "S");
	}
	if (parts.length === 0 && time.length === 0) return `${sign}PT0S`;
	return sign + "P" + parts.join("") + (time.length > 0 ? "T" + time.join("") : "");
}

/** Duration | number | unit-object → ms (unknown units are ignored). */
function durationDeltaMs(v: unknown): number {
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (v === null || typeof v !== "object") return 0;
	const src = v as Record<string, unknown>;
	if (typeof src["ms"] === "number") return src["ms"];
	let ms = 0;
	for (const [unit, value] of Object.entries(src)) {
		const size = unitMs(unit);
		if (size !== undefined && typeof value === "number") ms += value * size;
	}
	return ms;
}

const DURATION_METHODS = {
	toMillis(this: DurationSelf): number {
		return this.ms;
	},
	toSeconds(this: DurationSelf): number {
		return this.ms / MS.s;
	},
	/** Luxon `as`: year=365d, quarter=91d, month=30d, week=7d. */
	as(this: DurationSelf, unit: string): number {
		const size = unitMs(unit);
		return size === undefined ? Number.NaN : this.ms / size;
	},
	asMilliseconds(this: DurationSelf): number {
		return this.ms;
	},
	asSeconds(this: DurationSelf): number {
		return this.ms / MS.s;
	},
	asMinutes(this: DurationSelf): number {
		return this.ms / MS.m;
	},
	asHours(this: DurationSelf): number {
		return this.ms / MS.h;
	},
	asDays(this: DurationSelf): number {
		return this.ms / MS.d;
	},
	asWeeks(this: DurationSelf): number {
		return this.ms / MS.w;
	},
	asMonths(this: DurationSelf): number {
		return this.ms / MONTH_MS;
	},
	asYears(this: DurationSelf): number {
		return this.ms / YEAR_MS;
	},
	valueOf(this: DurationSelf): number {
		return this.ms;
	},
	toISO(this: DurationSelf): string {
		return durationToISO(this.ms);
	},
	toString(this: DurationSelf): string {
		return durationToISO(this.ms);
	},
	toObject(this: DurationSelf): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [unit, value] of this[DUR_SHIFTED] ?? decompose(this.ms, DURATION_OBJECT_UNITS)) out[unit] = value;
		return out;
	},
	/** Decomposes `ms` over the units the format actually asks for (drops the rest). */
	toFormat(this: DurationSelf, fmt: string): string {
		const values: Record<string, number> = {};
		const shifted = this[DUR_SHIFTED];
		if (shifted) {
			for (const [unit, value] of shifted) values[unit] = value;
		} else {
			const wanted = new Set<string>();
			for (const match of fmt.matchAll(DURATION_FORMAT_RE)) {
				const token = match[2];
				if (token !== undefined) wanted.add(DURATION_FIELD_TOKENS[token]!);
			}
			if (wanted.size > 0) {
				for (const [unit, value] of decompose(this.ms, DURATION_TOKEN_UNITS.filter((u) => wanted.has(u)))) values[unit] = value;
			}
		}
		return fmt.replace(DURATION_FORMAT_RE, (match, literal: string | undefined, token: string | undefined) => {
			if (literal !== undefined) return literal;
			return String(values[DURATION_FIELD_TOKENS[token!]!] ?? 0).padStart(match.length, "0");
		});
	},
	plus(this: DurationSelf, other: Duration | DateDelta | number): Duration {
		return createDuration(this.ms + durationDeltaMs(other));
	},
	minus(this: DurationSelf, other: Duration | DateDelta | number): Duration {
		return createDuration(this.ms - durationDeltaMs(other));
	},
	/** Simplified: re-decomposes `ms` over the requested units, largest first. */
	shiftTo(this: DurationSelf, ...units: string[]): Duration {
		const requested = [...new Set(units.map((u) => u.toLowerCase()).filter((u) => unitMs(u) !== undefined))].sort(
			(a, b) => (unitMs(b) ?? 1) - (unitMs(a) ?? 1),
		);
		const shifted = createDuration(this.ms);
		if (requested.length === 0) return shifted;
		Object.defineProperty(shifted, DUR_SHIFTED, {value: decompose(this.ms, requested), enumerable: false, configurable: true});
		return shifted;
	},
	/** Simplified: an `{ms}` duration has nothing to carry, so this is value-preserving. */
	normalize(this: DurationSelf): Duration {
		return createDuration(this.ms);
	},
	equals(this: DurationSelf, other: unknown): boolean {
		return durationDeltaMs(other) === this.ms;
	},
};

const DURATION_DESCRIPTORS: PropertyDescriptorMap = (() => {
	const out = methodDescriptors(DURATION_METHODS as unknown as Record<string, unknown>);
	out["isValid"] = {get: () => true, enumerable: false, configurable: true};
	(out as Record<string | symbol, PropertyDescriptor>)[Symbol.toPrimitive] = {
		value(this: DurationSelf, hint: string) {
			return hint === "string" ? durationToISO(this.ms) : this.ms;
		},
		enumerable: false,
		configurable: true,
	};
	return out;
})();

/** Build a duration value (own `ms` + non-enumerable Luxon-lite method surface). */
export function createDuration(ms: number): Duration {
	const d = {ms: Number.isFinite(ms) ? ms : 0} as Duration;
	Object.defineProperties(d, DURATION_DESCRIPTORS);
	return d;
}
