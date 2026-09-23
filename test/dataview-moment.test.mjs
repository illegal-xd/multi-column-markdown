/**
 * `moment` facade tests (src/dataview/dv/moment.ts).
 *
 * Obsidian ships Moment app-wide, so dataviewjs snippets call
 * `moment("2024-01-15").add(1, "day").format("YYYY-MM-DD")`. The facade must
 * match Moment for the surface snippets use — including the non-obvious parts:
 * date-only strings are LOCAL midnight, `month()` is 0-based, `day()` is
 * Sunday-based, month/year arithmetic clamps (Jan 31 + 1 month → Feb 28/29) and
 * every modifier returns a new value.
 *
 * Determinism: absolute expectations use `moment.utc(...)`; local-zone
 * expectations are derived from the native `Date` so the suite passes in any
 * timezone.
 *
 *   NODE_PATH=./test/helpers/node_modules node --test test/dataview-moment.test.mjs
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-moment-"));
const bundle = join(dir, "moment.mjs");
try {
  execSync(
    `npx esbuild src/dataview/dv/moment.ts --bundle --format=esm --platform=neutral --outfile="${bundle}"`,
    {cwd: repoRoot, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
process.on("exit", () => rmSync(dir, {recursive: true, force: true}));

const {createMomentGlobal} = await import(bundle);

/**
 * Fixed "now": local noon on 2024-01-15, built from local fields so the
 * wall-clock expectations below ("Today at 12:00 PM") hold in any timezone.
 * Instant-based assertions are unaffected.
 */
const NOW = new Date(2024, 0, 15, 12, 0, 0, 0).getTime();
const moment = createMomentGlobal({now: () => NOW});

// ── parsing ───────────────────────────────────────────────────────────────

test("parsing: date-only strings are local midnight, not UTC (Moment, not Date.parse)", () => {
  // `new Date("2024-01-15")` is UTC midnight; Moment treats it as local midnight.
  assert.equal(moment("2024-01-15").valueOf(), new Date(2024, 0, 15, 0, 0, 0, 0).getTime());
  assert.equal(moment("2024-01-15").hour(), 0);
  assert.equal(moment("2024-01-15").format("YYYY-MM-DD"), "2024-01-15");
  // A zoned string keeps its instant.
  assert.equal(moment("2024-01-15T10:30:00Z").valueOf(), Date.UTC(2024, 0, 15, 10, 30));
  // Zone-less date-times are local (native Date semantics agree).
  assert.equal(moment("2024-01-15T10:30:00").valueOf(), new Date(2024, 0, 15, 10, 30).getTime());
});

test("parsing: numbers, Dates, arrays, objects, other moments and dv.date values", () => {
  assert.equal(moment(1700000000000).valueOf(), 1700000000000);
  assert.equal(moment(new Date(NOW)).valueOf(), NOW);
  assert.equal(moment([2024, 0, 15, 10, 30]).valueOf(), new Date(2024, 0, 15, 10, 30).getTime());
  assert.equal(moment({year: 2024, month: 0, date: 15}).valueOf(), new Date(2024, 0, 15).getTime());
  assert.equal(moment(moment.utc(NOW)).valueOf(), NOW);
  // Dataview's own `dv.date(...)`: both bridges are accepted.
  assert.equal(moment({toJSDate: () => new Date(NOW), toMillis: () => -1}).valueOf(), NOW);
  assert.equal(moment({toMillis: () => NOW}).valueOf(), NOW);
  // No argument → the injected clock.
  assert.equal(moment().valueOf(), NOW);
  // `moment.utc()` and `moment.unix()`.
  assert.equal(moment.utc("2024-01-15").valueOf(), Date.UTC(2024, 0, 15));
  assert.equal(moment.unix(1700000000).valueOf(), 1700000000000);
});

test("parsing: format-directed input and invalid values", () => {
  assert.equal(moment("15/01/2024", "DD/MM/YYYY").format("YYYY-MM-DD"), "2024-01-15");
  assert.equal(moment("2024-01-15 08:05", "YYYY-MM-DD HH:mm").format("HH:mm"), "08:05");
  assert.equal(moment("01/15/2024 8:05 PM", "MM/DD/YYYY h:mm A").format("HH:mm"), "20:05");
  assert.equal(moment.utc("2024-01-15", "YYYY-MM-DD").format("YYYY-MM-DD"), "2024-01-15");

  const bad = moment("not a date");
  assert.equal(bad.isValid(), false);
  assert.equal(bad.format("YYYY-MM-DD"), "Invalid date");
  assert.ok(Number.isNaN(bad.valueOf()));
  assert.equal(bad.isBefore(moment()), false);
  assert.equal(moment("2024-13-45").isValid(), false);
});

// ── formatting ────────────────────────────────────────────────────────────

test("format: Moment tokens (not Luxon tokens) with escaping and localized formats", () => {
  const m = moment.utc("2024-01-15T08:05:07.042Z");
  assert.equal(m.format("YYYY-MM-DDTHH:mm:ss.SSSZ"), "2024-01-15T08:05:07.042+00:00");
  assert.equal(m.format("ddd dddd dd d E"), "Mon Monday Mo 1 1");
  assert.equal(m.format("MMMM MMM MM M"), "January Jan 01 1");
  assert.equal(m.format("Do DD D"), "15th 15 15");
  assert.equal(m.format("h hh A a"), "8 08 AM am");
  assert.equal(m.format("HH H mm m ss s SSS S"), "08 8 05 5 07 7 042 0");
  assert.equal(m.format("Q DDD DDDD"), "1 15 015");
  assert.equal(m.format("X x"), `${Math.floor(m.valueOf() / 1000)} ${m.valueOf()}`);
  assert.equal(m.format("[week] W[-]w"), "week 3-3");
  assert.equal(m.format("\\Y YYYY"), "Y 2024");
  assert.equal(m.format("L LT"), "01/15/2024 8:05 AM");
  assert.equal(m.format("LL"), "January 15, 2024");
  assert.equal(m.format("lll"), "Jan 15, 2024 8:05 AM");
  // Default format is ISO-8601 with offset.
  assert.equal(moment.utc("2024-01-15T08:05:07Z").format(), "2024-01-15T08:05:07+00:00");
  assert.equal(moment.utc("2024-01-15").toISOString(), "2024-01-15T00:00:00.000Z");
});

test("format: local offset reflects the system zone", () => {
  const native = new Date(NOW);
  const offset = -native.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const expected = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  assert.equal(moment(NOW).format("Z"), expected);
  assert.equal(moment(NOW).utcOffset(), offset);
  assert.equal(moment(NOW).utc().utcOffset(), 0);
  assert.equal(moment(NOW).utc().isUTC(), true);
  assert.equal(moment(NOW).utc().local().valueOf(), NOW, "local()/utc() keep the instant");
});

test("format: parseZone keeps the written offset", () => {
  const m = moment.parseZone("2024-01-15T10:00:00+02:00");
  assert.equal(m.format("YYYY-MM-DDTHH:mm"), "2024-01-15T10:00");
  assert.equal(m.format("Z"), "+02:00");
  assert.equal(m.valueOf(), Date.UTC(2024, 0, 15, 8, 0));
  assert.equal(m.utc().format("HH:mm"), "08:00");
});

// ── arithmetic ────────────────────────────────────────────────────────────

test("arithmetic: mutating chains, explicit clone, clamping and start/endOf", () => {
  // Moment's modifiers mutate the receiver and return it; `clone()` is the copy.
  const base = moment.utc("2024-01-15T10:00:00");
  const next = base.add(1, "day");
  assert.equal(next, base, "add() returns the same (mutated) instance, like Moment");
  assert.equal(base.format("YYYY-MM-DD"), "2024-01-16");
  const copy = base.clone();
  copy.subtract(1, "day");
  assert.equal(copy.format("YYYY-MM-DD"), "2024-01-15");
  assert.equal(base.format("YYYY-MM-DD"), "2024-01-16", "clone() must not share state");

  // Month/year steps clamp instead of rolling over.
  assert.equal(moment.utc("2024-01-31").add(1, "month").format("YYYY-MM-DD"), "2024-02-29");
  assert.equal(moment.utc("2023-01-31").add(1, "month").format("YYYY-MM-DD"), "2023-02-28");
  assert.equal(moment.utc("2024-03-31").subtract(1, "month").format("YYYY-MM-DD"), "2024-02-29");
  assert.equal(moment.utc("2024-02-29").add(1, "year").format("YYYY-MM-DD"), "2025-02-28");
  assert.equal(moment.utc("2024-01-15").add(1, "quarter").format("YYYY-MM-DD"), "2024-04-15");
  assert.equal(moment.utc("2024-01-15").add(2, "week").format("YYYY-MM-DD"), "2024-01-29");
  assert.equal(moment.utc("2024-01-15T10:00:00").add(90, "minutes").format("HH:mm"), "11:30");
  assert.equal(moment.utc("2024-01-15").add(1, "d").format("YYYY-MM-DD"), "2024-01-16", "unit aliases");

  // 2024-01-15 is a Monday: locale week starts Sunday, ISO week starts Monday.
  assert.equal(moment.utc("2024-01-15").startOf("week").format("YYYY-MM-DD"), "2024-01-14");
  assert.equal(moment.utc("2024-01-15").startOf("isoWeek").format("YYYY-MM-DD"), "2024-01-15");
  assert.equal(moment.utc("2024-01-15").startOf("month").format("YYYY-MM-DDTHH:mm"), "2024-01-01T00:00");
  assert.equal(moment.utc("2024-01-15").endOf("month").format("YYYY-MM-DDTHH:mm:ss.SSS"), "2024-01-31T23:59:59.999");
  assert.equal(moment.utc("2024-01-15").endOf("day").format("HH:mm:ss.SSS"), "23:59:59.999");
  assert.equal(moment.utc("2024-01-15").endOf("year").format("YYYY-MM-DD"), "2024-12-31");
  assert.equal(moment.utc("2024-01-15").startOf("quarter").format("YYYY-MM-DD"), "2024-01-01");
});

// ── fields ────────────────────────────────────────────────────────────────

test("fields: Moment indexing (0-based month, Sunday-based day) and derived values", () => {
  const m = moment.utc("2024-01-15T08:05:07.042Z");
  assert.equal(m.year(), 2024);
  assert.equal(m.month(), 0);
  assert.equal(m.date(), 15);
  assert.equal(m.day(), 1, "day() is Sunday-based");
  assert.equal(m.weekday(), 1, "en locale: weekStart = Sunday");
  assert.equal(m.isoWeekday(), 1);
  assert.equal(m.hour(), 8);
  assert.equal(m.hours(), 8);
  assert.equal(m.minute(), 5);
  assert.equal(m.second(), 7);
  assert.equal(m.millisecond(), 42);
  assert.equal(m.quarter(), 1);
  assert.equal(m.dayOfYear(), 15);
  assert.equal(m.week(), 3);
  assert.equal(m.isoWeek(), 3);
  assert.equal(m.daysInMonth(), 31);
  assert.equal(moment.utc("2024-02-01").daysInMonth(), 29);
  assert.equal(moment.utc("2024-02-01").isLeapYear(), true);
  assert.equal(moment.utc("2023-02-01").isLeapYear(), false);
  assert.equal(moment.utc("2024-01-15").get("month"), 0);
  assert.equal(moment.utc("2024-01-15").set("date", 20).format("YYYY-MM-DD"), "2024-01-20");
  assert.equal(moment.utc("2024-01-15").set({hour: 5, minute: 6}).format("HH:mm"), "05:06");
  assert.deepEqual(m.toArray(), [2024, 0, 15, 8, 5, 7, 42]);
  assert.equal(m.toObject().month, 0);
  assert.equal(m.toJSON(), "2024-01-15T08:05:07.042Z");
});

// ── comparison ────────────────────────────────────────────────────────────

test("comparison and diff: unit-scoped predicates and Moment's truncation rules", () => {
  const a = moment.utc("2024-01-15T10:00:00");
  const later = moment.utc("2024-01-15T18:00:00");
  const nextDay = moment.utc("2024-01-16T09:00:00");

  assert.equal(a.isBefore(later), true);
  assert.equal(a.isAfter(later), false);
  assert.equal(a.isSame(later, "day"), true);
  assert.equal(a.isSame(later, "hour"), false);
  assert.equal(a.isSameOrBefore(later), true);
  assert.equal(a.isSameOrAfter(later), false);
  assert.equal(a.isBetween(moment.utc("2024-01-14"), nextDay), true);
  // Unit-scoped comparisons follow Moment: the WHOLE unit is compared, so
  // "10:00 is before 18:00 on the same day" is false at day granularity …
  assert.equal(a.isBefore(later, "day"), false, "isBefore(unit) asks whether this unit ENDS before the other");
  assert.equal(a.isAfter(later, "day"), false);
  // … and true for the previous day, while isAfter(unit) asks for the unit start.
  assert.equal(a.isBefore(nextDay, "day"), true);
  assert.equal(nextDay.isAfter(a, "day"), true);
  // isSame(unit) is inclusive of the unit's last millisecond.
  assert.equal(moment.utc("2024-01-15T23:59:59.999").isSame(a, "day"), true);
  assert.equal(moment.utc("2024-01-16T00:00:00.000").isSame(a, "day"), false);

  assert.equal(later.diff(a, "hours"), 8);
  assert.equal(later.diff(a, "hour", true), 8);
  assert.equal(later.diff(a, "minutes"), 480);
  assert.equal(nextDay.diff(a, "days"), 0, "day diff is 24h-based (Moment), not calendar-based");
  assert.equal(nextDay.diff(a, "days", true), 23 / 24);
  assert.equal(moment.utc("2024-03-14").diff(moment.utc("2024-01-15"), "months"), 1);
  assert.equal(moment.utc("2024-03-15").diff(moment.utc("2024-01-15"), "months"), 2);
  assert.equal(moment.utc("2025-01-15").diff(moment.utc("2024-01-15"), "years"), 1);
  assert.equal(moment.utc("2024-01-15").diff(moment.utc("2024-03-15"), "months"), -2);
  assert.equal(moment.utc("2024-01-15").diff(moment.utc("2024-01-15T00:00:01"), "seconds"), -1);
  assert.equal(moment.utc("2024-01-15").diff(moment.utc("2024-01-14"), "milliseconds"), 86_400_000);
});

// ── relative time ─────────────────────────────────────────────────────────

test("relative strings and calendar() use English and the injected clock", () => {
  const ago = (ms) => moment(NOW - ms).fromNow();
  assert.equal(ago(5_000), "a few seconds ago");
  assert.equal(ago(60_000), "a minute ago");
  assert.equal(ago(30 * 60_000), "30 minutes ago");
  assert.equal(ago(90 * 60_000), "2 hours ago");
  assert.equal(ago(4 * 86_400_000), "4 days ago");
  assert.equal(moment(NOW + 3 * 86_400_000).fromNow(), "in 3 days");
  assert.equal(moment(NOW - 3 * 86_400_000).toNow(), "in 3 days");
  assert.equal(moment(NOW).fromNow(true), "a few seconds");
  assert.equal(moment(NOW - 86_400_000).from(NOW), "a day ago");

  assert.equal(moment(NOW).calendar(), "Today at 12:00 PM");
  assert.equal(moment(NOW - 86_400_000).calendar(), "Yesterday at 12:00 PM");
  assert.equal(moment(NOW + 86_400_000).calendar(), "Tomorrow at 12:00 PM");
  assert.equal(moment(NOW - 3 * 86_400_000).calendar(), "Last Friday at 12:00 PM");
  assert.equal(moment(NOW + 3 * 86_400_000).calendar(), "Thursday at 12:00 PM");
  assert.equal(moment(NOW - 30 * 86_400_000).calendar(), "12/16/2023");
});

// ── statics + durations ───────────────────────────────────────────────────

test("statics: min/max/isMoment/isDate/months and durations", () => {
  assert.equal(moment.isMoment(moment()), true);
  assert.equal(moment.isMoment(NOW), false);
  assert.equal(moment.isDate(new Date()), true);
  assert.equal(moment.isDate("2024-01-15"), false);
  assert.equal(moment.min("2024-01-15", "2024-01-10").format("YYYY-MM-DD"), "2024-01-10");
  assert.equal(moment.max(moment.utc("2024-01-15"), "2024-01-20").format("YYYY-MM-DD"), "2024-01-20");
  assert.equal(moment.now(), NOW);
  assert.equal(moment.locale(), "en");
  assert.equal(moment.months()[0], "January");
  assert.equal(moment.monthsShort()[11], "Dec");
  assert.equal(moment.weekdays()[0], "Sunday");
  assert.equal(moment.weekdaysMin()[1], "Mo");

  const d = moment.duration(90, "minutes");
  assert.equal(d.asHours(), 1.5);
  assert.equal(d.asMinutes(), 90);
  assert.equal(d.humanize(), "2 hours");
  assert.equal(d.humanize(true), "in 2 hours");
  assert.equal(moment.duration({days: 1, hours: 2}).asHours(), 26);
  assert.equal(moment.duration(1000).asSeconds(), 1);
  assert.equal(moment.isDuration(d), true);
  assert.equal(moment.isDuration({}), false);
});

test("toDate() hands out a copy and clone() keeps the original", () => {
  const a = moment.utc("2024-01-15");
  const dateA = a.toDate();
  dateA.setFullYear(1999);
  assert.equal(a.format("YYYY"), "2024", "toDate() must return a copy");
  assert.equal(a.clone().add(5, "years").format("YYYY"), "2029");
  assert.equal(a.format("YYYY"), "2024", "the clone took the mutation, not the original");
});

test("field setters mutate, keeping Moment's semantics", () => {
  const m = moment.utc("2024-01-15T08:00:00");
  assert.equal(m.year(), 2024);
  assert.equal(m.year(2025).format("YYYY-MM-DD"), "2025-01-15");
  assert.equal(m.format("YYYY-MM-DD"), "2025-01-15", "the setter mutated the receiver");
  assert.equal(moment.utc("2024-01-31").month(1).format("YYYY-MM-DD"), "2024-02-29", "clamped");
  assert.equal(moment.utc("2024-01-15T08:00").hour(23).minute(59).second(30).format("HH:mm:ss"), "23:59:30");
  assert.equal(moment.utc("2024-01-15T08:00").quarter(3).format("YYYY-MM-DD"), "2024-07-15");
  assert.equal(moment.utc("2024-01-15T08:00").date(3).format("YYYY-MM-DD"), "2024-01-03");
  // Sunday-based day setter moves inside the current week.
  assert.equal(moment.utc("2024-01-15T08:00").day(0).format("YYYY-MM-DD"), "2024-01-14");
  assert.equal(moment.utc("2024-01-15").isoWeekday(7).format("YYYY-MM-DD"), "2024-01-21");
  assert.equal(moment.utc("2024-01-15").dayOfYear(1).format("YYYY-MM-DD"), "2024-01-01");
});
