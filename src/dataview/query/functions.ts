/**
 * Built-in function table shared by dv.func and DQL expressions
 * (contract: `DvFunctions: Record<string, (...args: DvValue[]) => DvValue>`).
 *
 * Semantics follow the Obsidian Dataview docs (reference/functions) and the
 * upstream implementation (blacksmithgu/obsidian-dataview src/expression/functions.ts);
 * every function below cites the doc/source behavior it mirrors. Known
 * deviations from upstream are marked "deviation:" with the reason.
 *
 * Vectorization ("function vectorization", docs section "Calling functions on
 * lists of values"): most functions applied to a list return the list of the
 * function applied to each element. Upstream implements this in
 * `FunctionBuilder.build()` via a per-arity list of vectorized argument
 * positions; we mirror those positions in `VECTORIZE` below and wrap the raw
 * implementations once at module load. Deliberate exceptions (see VECTORIZE):
 *   - `display`, `typeof`, `slice` are NOT vectorized: upstream gives them
 *     explicit array semantics ("array" for `typeof([1,2,3])`, ", "-joined
 *     string for `display(list("Hello","World"))`, the array itself for
 *     `slice([1,2,3,4,5],3)`), which auto-vectorization would break. The
 *     container functions (`contains`/`icontains`/`econtains`, `all`/`any`/
 *     `none`, aggregations, `map`/`filter`/… ) are not vectorized either.
 * Perf: the table (wrappers included) is built once at module load; no
 * per-call dictionary rebuild and no deep copies on the vectorized path.
 */
import type {DvValue, Link} from "../types";
import {compareValues, createDataArray} from "./dataArray";
import {createDvDate, now as nowDate, parseDate, parseDuration, today as todayDate} from "./datetime";
import {looseEquals, makeLink, pathGet, toArrayOrNull, truthy} from "./semantics";
import {formatDurationMs, isDataArray, isDvDate, isDuration, isLink} from "../values";

type Fn = (...args: DvValue[]) => DvValue;

function num(v: DvValue): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function arith(a: DvValue, b: DvValue, op: (x: number, y: number) => number): DvValue {
	const x = num(a);
	const y = num(b);
	if (x === null || y === null) return null;
	return op(x, y);
}

function strArg(v: DvValue): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (isDvDate(v)) return v.toISO();
	return null;
}

function flattenArgs(args: DvValue[]): DvValue[] {
	const out: DvValue[] = [];
	for (const a of args) {
		const arr = toArrayOrNull(a);
		if (arr !== null) out.push(...arr);
		else out.push(a);
	}
	return out;
}

function allNumbers(args: DvValue[]): number[] {
	const out: number[] = [];
	for (const v of flattenArgs(args)) {
		const n = num(v);
		if (n !== null) out.push(n);
	}
	return out;
}

/** Array-or-DataArray → list; anything else → null. */
function isListValue(v: DvValue): boolean {
	return Array.isArray(v) || isDataArray(v);
}

/** `length`/`typeOf` null-checks in Dataview treat undefined like null. */
function isNullish(v: DvValue): boolean {
	return v === null || v === undefined;
}

// ---------------------------------------------------------------------------
// typeof / indexing / display helpers
// ---------------------------------------------------------------------------

/**
 * `typeof(any)` (docs Constructors). Upstream `DefaultFunctions.typeOf` maps
 * array/boolean/date/duration/function/widget/link/null/number/object/string.
 * We have no widgets, so that branch is unreachable ("unknown" fallback kept).
 */
function typeOf(v: DvValue): string {
	if (isNullish(v)) return "null";
	if (typeof v === "boolean") return "boolean";
	if (typeof v === "number") return "number";
	if (typeof v === "string") return "string";
	if (typeof v === "function") return "function";
	if (isListValue(v)) return "array";
	if (isDvDate(v) || v instanceof Date) return "date";
	if (isDuration(v)) return "duration";
	if (isLink(v)) return "link";
	if (typeof v === "object") return "object";
	return "unknown";
}

/** Own-property / numeric-index lookup (upstream `extract` uses Fields.index). */
function indexValue(obj: DvValue, key: DvValue): DvValue {
	if (isNullish(obj)) return null;
	if (typeof obj === "string") {
		const i = typeof key === "number" ? key : Number(key);
		return Number.isInteger(i) ? obj[i] ?? null : null;
	}
	const arr = toArrayOrNull(obj);
	if (arr !== null) {
		const i = typeof key === "number" ? key : Number(key);
		return Number.isInteger(i) ? arr[i] ?? null : null;
	}
	if (typeof obj === "object") {
		const k = String(key);
		return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, DvValue>)[k]! : null;
	}
	return null;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** `normalizeMarkdown` subset used by `display` (docs Utility Functions). */
function normalizeMarkdown(s: string): string {
	return s
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]+)\]\]/g, "$1")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/__(.*?)__/g, "$1")
		.replace(/~~(.*?)~~/g, "$1")
		.replace(/==(.*?)==/g, "$1")
		.replace(/`([^`]*)`/g, "$1");
}

/** `display(x)` — docs examples: links → display, dates → readable, arrays → ", ". */
function displayImpl(v: DvValue): string {
	if (isNullish(v)) return "";
	const arr = toArrayOrNull(v);
	if (arr !== null) return arr.map(displayImpl).join(", ");
	if (typeof v === "string") return normalizeMarkdown(v);
	if (isLink(v)) {
		if (typeof v.display === "string") return displayImpl(v.display);
		const base = v.path.split("/").pop() ?? v.path;
		return base.replace(/\.md$/i, "");
	}
	if (isDvDate(v)) return `${MONTHS_LONG[v.month - 1]!} ${v.day}, ${v.year}`;
	if (v instanceof Date) return `${MONTHS_LONG[v.getUTCMonth()]!} ${v.getUTCDate()}, ${v.getUTCFullYear()}`;
	if (isDuration(v)) return formatDurationMs(v.ms);
	return strArg(v) ?? "";
}

// ---------------------------------------------------------------------------
// reduce / sum / product / average folding
// ---------------------------------------------------------------------------

/** Operands accepted by `reduce(array, operand)` (docs Numeric Operations). */
const FOLD_OPS = new Set(["+", "-", "*", "/", "&", "|"]);

function repeatString(s: string, n: number): DvValue {
	if (!Number.isFinite(n) || n < 0) return null;
	return s.repeat(Math.trunc(n));
}

/**
 * One fold step, mirroring the expression operators (plus the doc example
 * `reduce(["⭐", 3], "*") = "⭐⭐⭐"`, i.e. `*` repeats strings).
 */
function foldApply(op: string, a: DvValue, b: DvValue): DvValue {
	switch (op) {
		case "+": {
			if (typeof a === "string" || typeof b === "string") return (strArg(a) ?? "") + (strArg(b) ?? "");
			if (isNullish(a) || isNullish(b)) return null;
			if (typeof a === "number" && typeof b === "number") return a + b;
			return null;
		}
		case "-":
		case "/": {
			if (isNullish(a) || isNullish(b)) return null;
			if (typeof a === "number" && typeof b === "number") return op === "-" ? a - b : a / b;
			return null;
		}
		case "*": {
			if (isNullish(a) || isNullish(b)) return null;
			if (typeof a === "number" && typeof b === "number") return a * b;
			if (typeof a === "string" && typeof b === "number") return repeatString(a, b);
			if (typeof a === "number" && typeof b === "string") return repeatString(b, a);
			return null;
		}
		case "&":
			return truthy(a) && truthy(b);
		case "|":
			return truthy(a) || truthy(b);
		default:
			return null;
	}
}

/** Left fold with the given operator; null for an empty list (docs: sum([]) = null). */
function foldList(arr: DvValue[], op: string): DvValue {
	if (arr.length === 0) return null;
	let acc: DvValue = arr[0]!;
	for (let i = 1; i < arr.length; i++) acc = foldApply(op, acc, arr[i]!);
	return acc;
}

// ---------------------------------------------------------------------------
// Dates & durations formatting (Luxon token subset)
// ---------------------------------------------------------------------------

let cachedLocale: string | null = null;
/** Locale used by currency/date formatting (upstream: currentLocale()). */
function currentLocale(): string {
	if (cachedLocale === null) cachedLocale = Intl.NumberFormat().resolvedOptions().locale;
	return cachedLocale;
}

interface FmtToken {
	literal: boolean;
	text: string;
}

/**
 * Consume the quoted literal starting at `i` (fmt[i] === "'"); returns the next
 * index. `''` is a literal quote (Luxon rule).
 */
function pushQuoted(fmt: string, i: number, out: FmtToken[]): number {
	if (fmt[i + 1] === "'") {
		out.push({literal: true, text: "'"});
		return i + 2;
	}
	const end = fmt.indexOf("'", i + 1);
	if (end < 0) {
		out.push({literal: true, text: fmt.slice(i + 1)});
		return fmt.length;
	}
	out.push({literal: true, text: fmt.slice(i + 1, end)});
	return end + 1;
}

/**
 * Luxon `Formatter.parseFormat`: `'…'` is a literal and a run of one repeated
 * letter is one token, so `"yyMMdd"` → yy / MM / dd and `"yyyy-MM-dd"` → three
 * tokens. Used by `dateformat` and `date(text, format)`.
 */
function tokenizeFormat(fmt: string): FmtToken[] {
	const out: FmtToken[] = [];
	let i = 0;
	while (i < fmt.length) {
		const c = fmt[i]!;
		if (c === "'") {
			i = pushQuoted(fmt, i, out);
			continue;
		}
		if (/[A-Za-z]/.test(c)) {
			let j = i;
			while (j < fmt.length && fmt[j] === c) j++;
			out.push({literal: false, text: fmt.slice(i, j)});
			i = j;
			continue;
		}
		out.push({literal: true, text: c});
		i++;
	}
	return out;
}

/**
 * Duration format tokens. A word made of one repeated letter is a token
 * ("ddd"), and inside a mixed word only runs of 2+ identical letters are
 * tokens. That keeps the documented `durationformat(d, "M months") =
 * "24000 months"` literal ("months" is not a run), while "ddhhmmss" still
 * tokenizes. (Raw Luxon would split "months" into single-letter units.)
 */
function tokenizeDurationFormat(fmt: string): FmtToken[] {
	const out: FmtToken[] = [];
	let i = 0;
	while (i < fmt.length) {
		const c = fmt[i]!;
		if (c === "'") {
			i = pushQuoted(fmt, i, out);
			continue;
		}
		if (/[A-Za-z]/.test(c)) {
			let j = i;
			while (j < fmt.length && /[A-Za-z]/.test(fmt[j]!)) j++;
			const word = fmt.slice(i, j);
			i = j;
			if (word.split("").every((ch) => ch === word[0])) {
				out.push({literal: false, text: word});
				continue;
			}
			let k = 0;
			while (k < word.length) {
				const ch = word[k]!;
				let m = k;
				while (m < word.length && word[m] === ch) m++;
				out.push({literal: m - k === 1, text: word.slice(k, m)});
				k = m;
			}
			continue;
		}
		out.push({literal: true, text: c});
		i++;
	}
	return out;
}

const MACRO_OPTS: Record<string, Intl.DateTimeFormatOptions> = {
	f: {year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit"},
	ff: {year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"},
	fff: {year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short"},
	ffff: {weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "long"},
};

function pad(n: number, w: number): string {
	return String(n).padStart(w, "0");
}

/** One `dateformat` token (Luxon formatting tokens; our dates are UTC). */
function formatDateToken(dt: {year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number; toMillis(): number}, token: string): string {
	switch (token) {
		case "y":
			return String(dt.year);
		case "yy":
			return pad(dt.year % 100, 2);
		case "yyyy":
			return pad(dt.year, 4);
		case "yyyyyy":
			return pad(dt.year, 6);
		case "M":
			return String(dt.month);
		case "MM":
			return pad(dt.month, 2);
		case "MMM":
			return MONTHS_SHORT[dt.month - 1]!;
		case "MMMM":
			return MONTHS_LONG[dt.month - 1]!;
		case "L":
			return String(dt.month);
		case "LL":
			return pad(dt.month, 2);
		case "LLL":
			return MONTHS_SHORT[dt.month - 1]!;
		case "LLLL":
			return MONTHS_LONG[dt.month - 1]!;
		case "d":
			return String(dt.day);
		case "dd":
			return pad(dt.day, 2);
		case "E":
			return String(dt.weekday);
		case "EEE":
			return WEEKDAYS_SHORT[dt.weekday - 1]!;
		case "EEEE":
			return WEEKDAYS_LONG[dt.weekday - 1]!;
		case "c":
			return String(dt.weekday);
		case "ccc":
			return WEEKDAYS_SHORT[dt.weekday - 1]!;
		case "cccc":
			return WEEKDAYS_LONG[dt.weekday - 1]!;
		case "H":
			return String(dt.hour);
		case "HH":
			return pad(dt.hour, 2);
		case "h":
			return String(dt.hour % 12 === 0 ? 12 : dt.hour % 12);
		case "hh":
			return pad(dt.hour % 12 === 0 ? 12 : dt.hour % 12, 2);
		case "m":
			return String(dt.minute);
		case "mm":
			return pad(dt.minute, 2);
		case "s":
			return String(dt.second);
		case "ss":
			return pad(dt.second, 2);
		case "a":
			return dt.hour < 12 ? "AM" : "PM";
		case "S":
			return String(dt.toMillis() % 1000);
		case "SSS":
			return pad(dt.toMillis() % 1000, 3);
		case "x":
			return String(dt.toMillis());
		case "X":
			return String(Math.floor(dt.toMillis() / 1000));
		case "Z":
			return "+0";
		case "ZZ":
			return "+00:00";
		case "ZZZ":
			return "+0000";
		case "f":
		case "ff":
		case "fff":
		case "ffff": {
			try {
				return new Intl.DateTimeFormat(currentLocale(), {...MACRO_OPTS[token]!, timeZone: "UTC"}).format(new Date(dt.toMillis()));
			} catch {
				return token;
			}
		}
		default:
			return token;
	}
}

function formatDate(dt: Parameters<typeof formatDateToken>[0], fmt: string): string {
	let out = "";
	for (const t of tokenizeFormat(fmt)) out += t.literal ? t.text : formatDateToken(dt, t.text);
	return out;
}

/**
 * Parse `date(text, format)` (docs Constructors, "Uses Luxon tokens"): a
 * token→regex subset covering yyyy/yy/MM/M/LL/L/dd/d/HH/H/hh/h/mm/m/ss/s/S/a
 * plus the epoch formats `x` (millis) / `X` (seconds) upstream special-cases.
 * Requires the whole text to match the pattern; unsupported tokens → null.
 */
function parseDateWithFormat(text: string, format: string): DvValue {
	if (format === "x" || format === "X") {
		const m = /-?[0-9]+/.exec(text);
		if (m === null) return null;
		const n = Number(m[0]);
		return Number.isFinite(n) ? createDvDate(format === "X" ? n * 1000 : n) : null;
	}
	const fields: string[] = [];
	let re = "^";
	for (const t of tokenizeFormat(format)) {
		if (t.literal) {
			re += escapeRegex(t.text);
			continue;
		}
		const letter = t.text[0]!;
		const n = t.text.length;
		let pat: string | null;
		switch (letter) {
			case "y":
				pat = n >= 4 ? "(\\d{4})" : "(\\d{2})";
				break;
			case "M":
			case "L":
				pat = n >= 2 ? "(\\d{2})" : "(\\d{1,2})";
				break;
			case "d":
				pat = n >= 2 ? "(\\d{2})" : "(\\d{1,2})";
				break;
			case "H":
			case "h":
				pat = n >= 2 ? "(\\d{2})" : "(\\d{1,2})";
				break;
			case "m":
				pat = n >= 2 ? "(\\d{2})" : "(\\d{1,2})";
				break;
			case "s":
				pat = n >= 2 ? "(\\d{2})" : "(\\d{1,2})";
				break;
			case "S":
				pat = n >= 3 ? "(\\d{3})" : "(\\d{1,3})";
				break;
			case "a":
				pat = "(AM|PM)";
				break;
			default:
				return null; // unsupported token (names, zones, …) → cannot parse
		}
		fields.push(letter);
		re += pat;
	}
	re += "$";
	const match = new RegExp(re, "i").exec(text);
	if (match === null) return null;
	let year = 1970;
	let mon = 1;
	let day = 1;
	let hour = 0;
	let minute = 0;
	let second = 0;
	let milli = 0;
	let pm = false;
	for (let i = 0; i < fields.length; i++) {
		const raw = match[i + 1]!;
		const v = Number.parseInt(raw, 10);
		switch (fields[i]) {
			case "y":
				year = raw.length <= 2 ? 2000 + v : v;
				break;
			case "M":
			case "L":
				mon = v;
				break;
			case "d":
				day = v;
				break;
			case "H":
				hour = v;
				break;
			case "h":
				hour = v % 12;
				break;
			case "a":
				pm = raw.toLowerCase() === "pm";
				break;
			case "m":
				minute = v;
				break;
			case "s":
				second = v;
				break;
			case "S":
				milli = Number.parseInt(raw.padEnd(3, "0").slice(0, 3), 10);
				break;
		}
	}
	if (pm) hour += 12;
	const t = Date.UTC(year, mon - 1, day, hour, minute, second, milli);
	return Number.isNaN(t) ? null : createDvDate(t);
}

const DUR_SIZE: Record<string, number> = {
	S: 1,
	s: 1000,
	m: 60e3,
	h: 3600e3,
	d: 86400e3,
	w: 604800e3,
	M: 30 * 86400e3,
	y: 365 * 86400e3,
};
const DUR_ORDER = ["y", "M", "w", "d", "h", "m", "s", "S"];

/**
 * `durationformat(duration, fmt)` (docs Utility Functions): tokens
 * S/s/m/h/d/w/M/y, repeated tokens zero-pad to their length, `'…'` is literal.
 * Durations are ms-only here, so units are decomposed greedily (years = 365d,
 * months = 30d, weeks = 7d); months additionally count whole years as 12
 * months so `durationformat(dur("2000 years"), "M months") = "24000 months"`.
 */
function formatDuration(ms: number, fmt: string): string {
	const tokens = tokenizeDurationFormat(fmt);
	const wanted = new Set<string>();
	for (const t of tokens) if (!t.literal && DUR_SIZE[t.text[0]!] !== undefined) wanted.add(t.text[0]!);
	const units = DUR_ORDER.filter((u) => wanted.has(u));
	const values = new Map<string, number>();
	let rest = Math.abs(ms);
	for (const u of units) {
		if (u === "M") {
			const years = Math.floor(rest / DUR_SIZE.y!);
			values.set(u, years * 12 + Math.floor((rest - years * DUR_SIZE.y!) / DUR_SIZE.M!));
			rest = rest % DUR_SIZE.M!;
			continue;
		}
		const size = DUR_SIZE[u]!;
		const count = Math.floor(rest / size);
		values.set(u, count);
		rest -= count * size;
	}
	let out = "";
	for (const t of tokens) {
		if (t.literal) {
			out += t.text;
			continue;
		}
		const unit = t.text[0]!;
		const value = values.get(unit);
		out += value === undefined ? t.text : pad(value, t.text.length);
	}
	return (ms < 0 ? "-" : "") + out;
}

function toDateArg(d: DvValue): {year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number; toMillis(): number} | null {
	if (d === null || d === undefined) return null;
	if (typeof d === "string" || typeof d === "number") return parseDate(d);
	if (isDvDate(d)) return d;
	if (d instanceof Date) return parseDate(d);
	return null;
}

// ---------------------------------------------------------------------------
// hash (cyrb53 — same function upstream uses, so values are stable/identical)
// ---------------------------------------------------------------------------

// cyrb53 (c) 2018 bryc (github.com/bryc). License: Public domain.
function cyrb53(str: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0, ch = 0; i < str.length; i++) {
		ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ---------------------------------------------------------------------------
// Implementation table (raw, before vectorization wrappers)
// ---------------------------------------------------------------------------

/** sort(array, key?, dir?) — key is a dotted field path; returns DataArray. */
function sortFn(array: DvValue, key?: DvValue, dir?: DvValue): DvValue {
	const items = toArrayOrNull(array);
	if (items === null) return null;
	const path = typeof key === "string" ? key : null;
	const direction = dir === "desc" ? -1 : 1;
	const decorated = items.map((v, i) => ({v, i, k: path === null ? v : pathGet(v, path)}));
	decorated.sort((a, b) => {
		const c = compareValues(a.k, b.k);
		return c !== 0 ? c * direction : a.i - b.i; // stable (Schwartzian)
	});
	return createDataArray(decorated.map((d) => d.v));
}

/** `contains`/`econtains` share this body (docs: econtains == contains for strings). */
function containsImpl(container: DvValue, item: DvValue): DvValue {
	if (container === null || container === undefined) return false;
	if (typeof container === "string") return container.includes(String(item ?? ""));
	const arr = toArrayOrNull(container);
	if (arr !== null) return arr.some((x) => looseEquals(x, item ?? null));
	if (typeof container === "object" && !isDvDate(container)) {
		return Object.prototype.hasOwnProperty.call(container, String(item ?? ""));
	}
	return false;
}

function extractImpl(obj: DvValue, keys: DvValue[]): DvValue {
	const out: Record<string, DvValue> = {};
	for (const k of keys) {
		const key = strArg(k);
		if (key === null) continue;
		out[key] = indexValue(obj, key);
	}
	return out;
}

function reduceImpl(array: DvValue, operand: DvValue): DvValue {
	const arr = toArrayOrNull(array);
	if (arr === null) return null;
	if (arr.length === 0) return null;
	if (typeof operand === "function") {
		// Function operand receives (accumulator, element); null elements skipped
		// (upstream `reduce` function variant).
		const f = operand as Fn;
		let acc: DvValue = arr[0]!;
		for (let i = 1; i < arr.length; i++) {
			const cur = arr[i]!;
			if (isNullish(cur)) continue;
			acc = f(acc, cur);
		}
		return acc;
	}
	const op = strArg(operand);
	if (op === null) return null;
	if (!FOLD_OPS.has(op)) return null; // deviation: upstream throws; builtins here never throw
	return foldList(arr, op);
}

function minMaxBy(array: DvValue, func: DvValue, wantMax: boolean): DvValue {
	const arr = toArrayOrNull(array);
	if (arr === null || typeof func !== "function") return null;
	if (arr.length === 0) return null;
	const f = func as Fn;
	const mapped: Array<{v: DvValue; k: DvValue}> = arr.map((v) => ({v, k: f(v)}));
	const present = mapped.filter((m) => !isNullish(m.k));
	if (present.length === 0) return arr[0]!;
	let best: {v: DvValue; k: DvValue} = present[0]!;
	for (let i = 1; i < present.length; i++) {
		const c = compareValues(present[i]!.k, best.k);
		if (wantMax ? c > 0 : c <= 0) best = present[i]!;
	}
	return best.v;
}

const RAW_FUNCTIONS: Record<string, Fn> = {
	// ── general ────────────────────────────────────────────────────────────
	default(v, d) {
		return v === null || v === undefined ? (d ?? null) : v;
	},
	// Same as `default` but never vectorized (docs: ldefault).
	ldefault(v, d) {
		return v === null || v === undefined ? (d ?? null) : v;
	},
	choice(cond, a, b) {
		return truthy(cond ?? null) ? (a ?? null) : (b ?? null);
	},
	contains: containsImpl,
	// Case insensitive `contains` (docs Objects, Arrays, and String Operations).
	icontains(container, item) {
		if (container === null || container === undefined) return false;
		if (typeof container === "string") return container.toLocaleLowerCase().includes((strArg(item) ?? "").toLocaleLowerCase());
		const arr = toArrayOrNull(container);
		if (arr !== null) {
			const needle = typeof item === "string" ? item.toLocaleLowerCase() : null;
			return arr.some((el) => (needle !== null && typeof el === "string" ? el.toLocaleLowerCase() === needle : looseEquals(el, item ?? null)));
		}
		if (typeof container === "object" && !isDvDate(container)) {
			const key = String(item ?? "").toLocaleLowerCase();
			return Object.keys(container as Record<string, unknown>).some((k) => k.toLocaleLowerCase() === key);
		}
		return false;
	},
	// "Exact" contains — no recursive search (docs). For our value model this
	// matches `contains` (lists compare with `==`, objects by own key).
	econtains: containsImpl,
	// Case-insensitive whole-word match; vectorized over both arguments so the
	// documented list form `containsword(["word","Words"], "Word") = [true,false]` works.
	containsword(hay, needle) {
		if (isNullish(hay) || isNullish(needle)) return null;
		const h = strArg(hay);
		const n = strArg(needle);
		if (h === null || n === null) return null;
		try {
			return new RegExp(".*\\b" + escapeRegex(n) + "\\b.*", "i").test(h);
		} catch {
			return null;
		}
	},
	concat(...args) {
		const out: DvValue[] = [];
		for (const a of args) {
			const arr = toArrayOrNull(a);
			if (arr !== null) out.push(...arr);
			else out.push(a);
		}
		return out;
	},
	join(array, sep) {
		const arr = toArrayOrNull(array ?? null);
		if (arr === null) return null;
		const s = sep === null || sep === undefined ? ", " : String(sep);
		return arr.map((v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : strArg(v) ?? String(v))).join(s);
	},
	unique(array) {
		const arr = toArrayOrNull(array ?? null);
		if (arr === null) return null;
		const seen = new Set<unknown>();
		const out: DvValue[] = [];
		for (const v of arr) {
			const k = typeof v === "object" && v !== null ? JSON.stringify(v, replacer) : v;
			if (!seen.has(k)) {
				seen.add(k);
				out.push(v);
			}
		}
		return out;
	},
	sort: sortFn,
	// Reverses lists (and strings); non-collections pass through (docs).
	reverse(v) {
		const arr = toArrayOrNull(v ?? null);
		if (arr !== null) {
			const out = new Array<DvValue>(arr.length);
			for (let i = 0; i < arr.length; i++) out[i] = arr[arr.length - 1 - i]!;
			return out;
		}
		if (typeof v === "string") return v.split("").reverse().join("");
		return v ?? null;
	},

	// ── strings ────────────────────────────────────────────────────────────
	string(v) {
		if (v === null || v === undefined) return null;
		if (typeof v === "string") return v;
		if (typeof v === "number" || typeof v === "boolean") return String(v);
		if (isDvDate(v)) return v.toISO();
		if (typeof v === "object" && v !== null && "path" in v && "embed" in v) return (v as {path: string}).path;
		return null;
	},
	fixed(n, places) {
		const x = num(n ?? null);
		if (x === null) return null;
		const p = places === null || places === undefined ? 0 : num(places) ?? 0;
		return x.toFixed(Math.max(0, Math.min(100, Math.trunc(p))));
	},
	lower(s) {
		const t = strArg(s ?? null);
		return t === null ? null : t.toLowerCase();
	},
	upper(s) {
		const t = strArg(s ?? null);
		return t === null ? null : t.toUpperCase();
	},
	replace(text, pattern, replacement) {
		const t = strArg(text ?? null);
		if (t === null) return null;
		const p = strArg(pattern ?? null);
		if (p === null) return t;
		const r = strArg(replacement ?? null) ?? "";
		// deviation: JS string semantics: replace FIRST occurrence (upstream
		// replaces all); pinned by test/dataview-query.test.mjs.
		return t.replace(p, () => r);
	},
	regexreplace(text, pattern, replacement, flags) {
		const t = strArg(text ?? null);
		if (t === null) return null;
		const p = strArg(pattern ?? null);
		if (p === null) return t;
		const r = strArg(replacement ?? null) ?? "";
		const f = typeof flags === "string" && flags.length > 0 ? flags : "g"; // default global
		let re: RegExp;
		try {
			re = new RegExp(p, f);
		} catch {
			return null; // invalid regex → null (no throw from builtin table)
		}
		return t.replace(re, () => r);
	},
	// `regextest(pattern, string)` — partial match (docs String Operations).
	regextest(pattern, field) {
		const p = strArg(pattern ?? null);
		const f = strArg(field ?? null);
		if (p === null || f === null) return false;
		try {
			return new RegExp(p).test(f);
		} catch {
			return null; // invalid regex → null (deviation: upstream throws)
		}
	},
	// `regexmatch(pattern, string)` — whole-string match (upstream anchors the pattern).
	regexmatch(pattern, field) {
		const raw = strArg(pattern ?? null);
		const f = strArg(field ?? null);
		if (raw === null || f === null) return false;
		const p = !raw.startsWith("^") && !raw.endsWith("$") ? "^" + raw + "$" : raw;
		try {
			return new RegExp(p).test(f);
		} catch {
			return null;
		}
	},
	// Delimiter is a REGEX; capture groups are spliced into the result and
	// undefined captures become "" (upstream splitImpl).
	split(str, delimiter, limit) {
		const s = strArg(str ?? null);
		const d = strArg(delimiter ?? null);
		if (s === null || d === null) return null;
		const lim = limit === null || limit === undefined ? undefined : Math.max(0, Math.trunc(num(limit) ?? 0));
		let parts: string[];
		try {
			parts = s.split(new RegExp(d), lim);
		} catch {
			return null;
		}
		return parts.map((p) => p ?? "");
	},
	slice(collection, start, end) {
		const s = start === null || start === undefined ? 0 : num(start) ?? 0;
		const e = end === null || end === undefined ? undefined : num(end) ?? undefined;
		if (typeof collection === "string") return collection.slice(s, e);
		const arr = toArrayOrNull(collection ?? null);
		return arr === null ? null : arr.slice(s, e);
	},
	startswith(str, prefix) {
		const a = strArg(str ?? null);
		const b = strArg(prefix ?? null);
		return a === null || b === null ? null : a.startsWith(b);
	},
	endswith(str, suffix) {
		const a = strArg(str ?? null);
		const b = strArg(suffix ?? null);
		return a === null || b === null ? null : a.endsWith(b);
	},
	padleft(str, len, padding) {
		const s = strArg(str ?? null);
		const n = num(len ?? null);
		if (s === null || n === null) return null;
		const p = padding === null || padding === undefined ? " " : strArg(padding) ?? " ";
		return s.padStart(Math.trunc(n), p);
	},
	padright(str, len, padding) {
		const s = strArg(str ?? null);
		const n = num(len ?? null);
		if (s === null || n === null) return null;
		const p = padding === null || padding === undefined ? " " : strArg(padding) ?? " ";
		return s.padEnd(Math.trunc(n), p);
	},
	substring(str, start, end) {
		const s = strArg(str ?? null);
		const a = num(start ?? null);
		if (s === null || a === null) return null;
		if (end === null || end === undefined) return s.substring(Math.trunc(a));
		const b = num(end);
		return b === null ? s.substring(Math.trunc(a)) : s.substring(Math.trunc(a), Math.trunc(b));
	},
	truncate(str, length, suffix) {
		const s = strArg(str ?? null);
		const n = num(length ?? null);
		if (s === null || n === null) return null;
		const suf = suffix === null || suffix === undefined ? "..." : strArg(suffix) ?? "...";
		const len = Math.trunc(n);
		if (s.length > len - suf.length) return s.substring(0, Math.max(0, len - suf.length)) + suf;
		return s;
	},

	// ── math ───────────────────────────────────────────────────────────────
	add: (a, b) => arith(a, b, (x, y) => x + y),
	sub: (a, b) => arith(a, b, (x, y) => x - y),
	mul: (a, b) => arith(a, b, (x, y) => x * y),
	div: (a, b) => arith(a, b, (x, y) => x / y),
	mod: (a, b) => arith(a, b, (x, y) => x % y),
	pow: (a, b) => arith(a, b, (x, y) => x ** y),
	sqrt(a) {
		const x = num(a ?? null);
		return x === null || x < 0 ? null : Math.sqrt(x);
	},
	round(a, places) {
		const x = num(a ?? null);
		if (x === null) return null;
		const p = places === null || places === undefined ? 0 : num(places) ?? 0;
		const m = 10 ** Math.max(0, Math.min(100, Math.trunc(p)));
		return Math.round(x * m) / m;
	},
	// `trunc` — 0 + n normalizes -0 to 0 (docs: trunc(-0.837764) = 0).
	trunc(a) {
		const x = num(a ?? null);
		return x === null ? null : Math.trunc(x) + 0;
	},
	floor(a) {
		const x = num(a ?? null);
		return x === null ? null : Math.floor(x) + 0;
	},
	ceil(a) {
		const x = num(a ?? null);
		return x === null ? null : Math.ceil(x) + 0;
	},
	abs(a) {
		const x = num(a ?? null);
		return x === null ? null : Math.abs(x);
	},
	min(...args) {
		const ns = allNumbers(args);
		return ns.length ? Math.min(...ns) : null;
	},
	max(...args) {
		const ns = allNumbers(args);
		return ns.length ? Math.max(...ns) : null;
	},
	log(a, base) {
		const x = num(a ?? null);
		if (x === null || x <= 0) return null;
		if (base === null || base === undefined) return Math.log(x);
		const b = num(base);
		if (b === null || b <= 0 || b === 1) return null;
		return Math.log(x) / Math.log(b);
	},
	exp(a) {
		const x = num(a ?? null);
		return x === null ? null : Math.exp(x);
	},
	// Aggregations (docs Numeric Operations); empty list → null. These are not
	// vectorized: the array argument is the operand.
	sum(v) {
		const arr = toArrayOrNull(v ?? null);
		if (arr === null) return v ?? null;
		return foldList(arr, "+");
	},
	product(v) {
		const arr = toArrayOrNull(v ?? null);
		if (arr === null) return v ?? null;
		return foldList(arr, "*");
	},
	average(v) {
		const arr = toArrayOrNull(v ?? null);
		if (arr === null) return v ?? null;
		if (arr.length === 0) return null;
		const total = foldList(arr, "+");
		return typeof total === "number" ? total / arr.length : null;
	},
	reduce: reduceImpl,
	minby(array, func) {
		return minMaxBy(array, func, false);
	},
	maxby(array, func) {
		return minMaxBy(array, func, true);
	},

	// ── collection helpers ─────────────────────────────────────────────────
	// Pulls the given keys out of each object (vectorizes its first argument).
	extract(object, ...keys) {
		const list = toArrayOrNull(object ?? null);
		if (list !== null) return list.map((el) => extractImpl(el, keys));
		if (isNullish(object)) return null;
		return extractImpl(object, keys);
	},
	nonnull(...args) {
		const out: DvValue[] = [];
		const single = args.length === 1 ? toArrayOrNull(args[0] ?? null) : null;
		for (const v of single ?? args) if (typeOf(v) !== "null") out.push(v);
		return out;
	},
	firstvalue(v) {
		const arr = toArrayOrNull(v ?? null);
		if (arr === null) return null;
		for (const x of arr) if (typeOf(x) !== "null") return x;
		return null;
	},
	// Truthiness over a list, a list + predicate, or multiple arguments (docs).
	all(...args) {
		const arr = args.length <= 2 ? toArrayOrNull(args[0] ?? null) : null;
		if (arr !== null && args.length === 1) return arr.every((v) => truthy(v));
		if (arr !== null && args.length === 2 && typeof args[1] === "function") {
			const f = args[1] as Fn;
			return arr.every((v) => truthy(f(v)));
		}
		return args.every((v) => truthy(v));
	},
	any(...args) {
		const arr = args.length <= 2 ? toArrayOrNull(args[0] ?? null) : null;
		if (arr !== null && args.length === 1) return arr.some((v) => truthy(v));
		if (arr !== null && args.length === 2 && typeof args[1] === "function") {
			const f = args[1] as Fn;
			return arr.some((v) => truthy(f(v)));
		}
		return args.some((v) => truthy(v));
	},
	none(...args) {
		const arr = args.length <= 2 ? toArrayOrNull(args[0] ?? null) : null;
		if (arr !== null && args.length === 1) return !arr.some((v) => truthy(v));
		if (arr !== null && args.length === 2 && typeof args[1] === "function") {
			const f = args[1] as Fn;
			return !arr.some((v) => truthy(f(v)));
		}
		return !args.some((v) => truthy(v));
	},
	filter(array, predicate) {
		const arr = toArrayOrNull(array ?? null);
		if (arr === null || typeof predicate !== "function") return null;
		const f = predicate as Fn;
		return arr.filter((v) => truthy(f(v)));
	},
	map(array, func) {
		const arr = toArrayOrNull(array ?? null);
		if (arr === null || typeof func !== "function") return null;
		const f = func as Fn;
		return arr.map((v) => f(v));
	},
	flat(array, depth) {
		const arr = toArrayOrNull(array ?? null);
		if (arr === null) return null;
		const d = depth === null || depth === undefined ? 1 : num(depth) ?? 1;
		return (arr as unknown[]).flat(Math.max(0, Math.trunc(d))) as DvValue[];
	},

	// ── dates & durations ──────────────────────────────────────────────────
	// `date(any)` / `date(text, format)` — the two-argument form uses the Luxon
	// token subset in `parseDateWithFormat` (docs Constructors).
	date(v, format) {
		if (typeof format === "string") {
			const text = strArg(v ?? null);
			return text === null ? null : parseDateWithFormat(text, format);
		}
		if (v === null || v === undefined) return null;
		if (typeof v === "number" || typeof v === "string" || v instanceof Date || isDvDate(v)) return parseDate(v);
		return null;
	},
	// `date(text, format)` — Luxon token subset parsing (docs Constructors).
	// deviation: only `x`/`X` (epoch) and the numeric-token subset are parsed.
	dateformat(d, format) {
		const dt = toDateArg(d);
		const fmt = strArg(format ?? null);
		if (dt === null || fmt === null) return null;
		return formatDate(dt, fmt);
	},
	dur(v) {
		if (v === null || v === undefined) return null;
		if (typeof v === "number" || typeof v === "string") return parseDuration(v);
		return null;
	},
	durationformat(d, format) {
		const fmt = strArg(format ?? null);
		if (fmt === null) return null;
		let ms: number | null = null;
		if (isDuration(d)) ms = d.ms;
		else if (typeof d === "number") ms = d;
		else if (typeof d === "string") {
			const parsed = parseDuration(d);
			ms = parsed === null ? null : parsed.ms;
		}
		return ms === null ? null : formatDuration(ms, fmt);
	},
	year(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.year;
	},
	month(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.month;
	},
	day(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.day;
	},
	weekday(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.weekday;
	},
	hour(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.hour;
	},
	minute(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.minute;
	},
	second(d) {
		const dt = toDateArg(d);
		return dt === null ? null : dt.second;
	},
	// `striptime(date)` — midnight of the same day (our dates are UTC).
	striptime(d) {
		const dt = toDateArg(d);
		if (dt === null) return null;
		return createDvDate(Date.UTC(dt.year, dt.month - 1, dt.day));
	},
	now() {
		return nowDate();
	},
	today() {
		return todayDate();
	},
	// `localtime(date)` — Dataview's DateTime.toLocal(). DvDate is zone-less, so
	// the exposed fields are shifted by the local UTC offset (wall-clock view).
	localtime(d) {
		const dt = toDateArg(d);
		if (dt === null) return null;
		const ms = dt.toMillis();
		return createDvDate(ms - new Date(ms).getTimezoneOffset() * 60000);
	},

	// ── links / structures ─────────────────────────────────────────────────
	link(path, display, embed) {
		const p = strArg(path ?? null);
		if (p === null || p === "") return null;
		return makeLink(p, display ?? null, embed ?? null);
	},
	// `embed(link, [embed?])` — returns a copy with the embed flag set/cleared.
	embed(link, e) {
		if (!isLink(link)) return null;
		const result: Link = {path: link.path, embed: e === null || e === undefined ? true : truthy(e)};
		if (link.display !== undefined) result.display = link.display;
		if (link.subpath !== undefined) result.subpath = link.subpath;
		return result;
	},
	// `elink(url, [display?])` — external link; the render layer keys off
	// `external`. Display defaults to the url (upstream `elink(c, s, s)`).
	elink(url, display) {
		const u = strArg(url ?? null);
		if (u === null || u === "") return null;
		const d = strArg(display ?? null) ?? u;
		return {path: u, display: d, embed: false, external: true} as unknown as DvValue;
	},
	// `meta(link)` — properties of the link itself (docs Utility Functions).
	meta(link) {
		if (!isLink(link)) return null;
		const raw = link.subpath;
		let subpath: string | null = null;
		let type = "file";
		if (typeof raw === "string" && raw.length > 0) {
			if (raw.startsWith("#^")) {
				subpath = raw.slice(2);
				type = "block";
			} else if (raw.startsWith("#")) {
				subpath = raw.slice(1);
				type = "header";
			} else {
				subpath = raw;
				type = "header";
			}
			if (subpath === "") subpath = null;
		}
		return {display: link.display ?? null, embed: link.embed === true, path: link.path, subpath, type};
	},
	length(v) {
		if (v === null || v === undefined) return null; // deviation: upstream length(null) = 0
		if (typeof v === "string") return v.length;
		const arr = toArrayOrNull(v);
		if (arr !== null) return arr.length;
		if (typeof v === "object" && !isDvDate(v)) return Object.keys(v).length;
		return null;
	},
	object(...args) {
		if (args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0]) && !isDataArray(args[0]) && !isDvDate(args[0])) {
			const src = args[0] as Record<string, DvValue>;
			const out: Record<string, DvValue> = {};
			for (const [k, v] of Object.entries(src)) out[k] = v;
			return out;
		}
		if (args.length % 2 !== 0) return null;
		const out: Record<string, DvValue> = {};
		for (let i = 0; i < args.length; i += 2) {
			const k = args[i];
			if (k === null || k === undefined) return null;
			out[String(k)] = args[i + 1] ?? null;
		}
		return out;
	},
	// `list(…)` / `array(…)` — constructors (docs: `array` is an alias).
	list(...args) {
		return args;
	},
	array(...args) {
		return args;
	},
	// `typeof(any)` — NOT vectorized: `typeof([1, 2, 3]) = "array"` (docs).
	typeof(v) {
		return typeOf(v);
	},
	// `number(string)` — first number in the string, else null (docs).
	number(v) {
		if (typeof v === "number") return v;
		const s = strArg(v ?? null);
		if (s === null) return null;
		const m = /-?[0-9]+(\.[0-9]+)?/.exec(s);
		return m === null ? null : Number.parseFloat(m[0]!);
	},
	// `display(x)` — NOT vectorized: lists join with ", " (docs example).
	display(v) {
		return displayImpl(v);
	},
	// `hash(seed, [text], [variant])` — stable cyrb53 value (docs Utility Functions).
	hash(seed, text, variant) {
		const s = strArg(seed ?? null);
		if (s === null) return null;
		if (typeof text === "number") return cyrb53(s, text);
		const t = strArg(text ?? null);
		if (t === null) return cyrb53(s);
		if (typeof variant === "number") return cyrb53(s + t, variant);
		const v = num(variant ?? null);
		return v === null ? cyrb53(s + t) : cyrb53(s + t, v);
	},
	// `currencyformat(number, [currency])` — Intl.NumberFormat (docs).
	currencyformat(n, currency) {
		const x = num(n ?? null);
		if (x === null) return null;
		const cur = strArg(currency ?? null) ?? "USD";
		try {
			return new Intl.NumberFormat(currentLocale(), {style: "currency", currency: cur}).format(x);
		} catch {
			return null;
		}
	},
};

// ---------------------------------------------------------------------------
// Vectorization
// ---------------------------------------------------------------------------

/**
 * Per-function vectorized argument positions, keyed by arity — mirrors
 * upstream `FunctionBuilder.vectorize(n, positions)`. An argument is only
 * vectorized when it is actually an array/DataArray; the result is limited by
 * the shortest vectorized argument (upstream behavior).
 */
const VECTORIZE: Record<string, Record<number, readonly number[]>> = {
	// constructors / conversions
	date: {1: [0]},
	dur: {1: [0]},
	number: {1: [0]},
	string: {1: [0]},
	// numeric
	round: {1: [0], 2: [0, 1]},
	trunc: {1: [0]},
	floor: {1: [0]},
	ceil: {1: [0]},
	abs: {1: [0]},
	// strings
	lower: {1: [0]},
	upper: {1: [0]},
	replace: {3: [0, 1, 2]},
	regexreplace: {3: [0, 1, 2]},
	regextest: {2: [0, 1]},
	regexmatch: {2: [0, 1]},
	startswith: {2: [0, 1]},
	endswith: {2: [0, 1]},
	padleft: {2: [0, 1], 3: [0, 1, 2]},
	padright: {2: [0, 1], 3: [0, 1, 2]},
	substring: {2: [0, 1], 3: [0, 1, 2]},
	truncate: {2: [0, 1], 3: [0, 1, 2]},
	containsword: {2: [0, 1]},
	// dates / durations / currency
	striptime: {1: [0]},
	dateformat: {2: [0]},
	durationformat: {2: [0]},
	currencyformat: {2: [0]},
	localtime: {1: [0]},
	// utility
	default: {2: [0, 1]},
};

/** Safety cap for self-referential lists (upstream recurses without a bound). */
const MAX_VECTOR_DEPTH = 8;

function vectorizeFn(base: Fn, spec: Record<number, readonly number[]>): Fn {
	const wrapped = (depth: number, args: DvValue[]): DvValue => {
		const positions = spec[args.length];
		if (positions !== undefined && depth < MAX_VECTOR_DEPTH) {
			let vecPos: number[] | null = null;
			const lists: DvValue[][] = [];
			let minLen = Infinity;
			for (const p of positions) {
				const v = args[p];
				if (v !== undefined && isListValue(v)) {
					const arr = toArrayOrNull(v)!;
					if (vecPos === null) vecPos = [];
					vecPos.push(p);
					lists.push(arr);
					if (arr.length < minLen) minLen = arr.length;
				}
			}
			if (vecPos !== null) {
				const sub = args.slice();
				const out: DvValue[] = new Array(minLen);
				for (let i = 0; i < minLen; i++) {
					for (let k = 0; k < vecPos.length; k++) sub[vecPos[k]!] = lists[k]![i]!;
					out[i] = wrapped(depth + 1, sub.slice());
				}
				return out;
			}
		}
		return base(...args);
	};
	return (...args: DvValue[]) => wrapped(0, args);
}

/** Built ONCE at module load (vectorization wrappers included). */
export const DvFunctions: Record<string, Fn> = ((): Record<string, Fn> => {
	const out: Record<string, Fn> = {};
	for (const [name, fn] of Object.entries(RAW_FUNCTIONS)) {
		const spec = VECTORIZE[name];
		out[name] = spec === undefined ? fn : vectorizeFn(fn, spec);
	}
	return out;
})();

/** JSON.stringify replacer that flattens Date/DvDuration-ish values safely. */
function replacer(_k: string, v: unknown): unknown {
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "function") return undefined;
	return v;
}
