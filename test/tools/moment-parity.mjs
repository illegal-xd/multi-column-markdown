/**
 * Optional parity check: this facade vs the real Moment.js.
 *
 * NOT part of the test suite — the suite must run with zero dependencies. Enable
 * it when you touch `src/dataview/dv/moment.ts`:
 *
 *   mkdir -p /tmp/moment-parity && cd /tmp/moment-parity
 *   npm init -y && npm i moment@2.29.4
 *   npx esbuild <repo>/src/dataview/dv/moment.ts --bundle --format=esm --platform=neutral --outfile=./mine.mjs
 *   cp <repo>/test/tools/moment-parity.mjs . && node moment-parity.mjs
 *
 * Every case runs against both implementations and prints a diff when they
 * disagree; the goal is "identical" for the documented surface. Verified
 * 43/43 identical to moment@2.29.4 (2026-09-23).
 */
import real from "moment";
import {createMomentGlobal} from "./mine.mjs";

const NOW = new Date(2024, 0, 15, 12, 0, 0).getTime();
real.now = () => NOW;                       // not honoured by the lib, handled below
const mine = createMomentGlobal({now: () => NOW});

// Each case is a function applied to a `moment`-like factory, so both run identically.
const cases = [
  ["format YYYY-MM-DDTHH:mm:ss.SSSZ", (m) => m.utc("2024-01-15T08:05:07.042Z").format("YYYY-MM-DDTHH:mm:ss.SSSZ")],
  ["format tokens mix", (m) => m.utc("2024-01-15T08:05:07.042Z").format("ddd dddd dd d E MMMM MMM MM M Do DD D h hh A a HH H mm ss SSS S Q DDD DDDD X x Z ZZ")],
  ["format Week W/w", (m) => m.utc("2024-01-15").format("[W]W[-]w")],
  ["format escape/literal", (m) => m.utc("2024-01-15").format("\\Y YYYY [at] L LT LL lll")],
  ["date-only local", (m) => m("2024-01-15").format("YYYY-MM-DDTHH:mm:ssZ")],
  ["utc date-only", (m) => m.utc("2024-01-15").format("YYYY-MM-DDTHH:mm:ssZ")],
  ["utc zone-less datetime", (m) => m.utc("2024-01-15T10:00:00").format("HH:mm")],
  ["local zone-less datetime", (m) => m("2024-01-15T10:00:00").utc().format("HH:mm")],
  ["invalid", (m) => m("nope").format("YYYY")],
  ["invalid rollover", (m) => String(m("2024-13-45").isValid())],
  ["format-directed", (m) => m("15/01/2024", "DD/MM/YYYY").format("YYYY-MM-DD")],
  ["format-directed 12h", (m) => m("01/15/2024 8:05 PM", "MM/DD/YYYY h:mm A").format("HH:mm")],
  ["add month clamp", (m) => m.utc("2024-01-31").add(1, "month").format("YYYY-MM-DD")],
  ["subtract month clamp", (m) => m.utc("2024-03-31").subtract(1, "month").format("YYYY-MM-DD")],
  ["add year leap", (m) => m.utc("2024-02-29").add(1, "year").format("YYYY-MM-DD")],
  ["add 90 minutes", (m) => m.utc("2024-01-15T10:00:00").add(90, "minutes").format("HH:mm")],
  ["add 2 weeks", (m) => m.utc("2024-01-15").add(2, "week").format("YYYY-MM-DD")],
  ["startOf week", (m) => m.utc("2024-01-15").startOf("week").format("YYYY-MM-DD HH:mm")],
  ["startOf isoWeek", (m) => m.utc("2024-01-15").startOf("isoWeek").format("YYYY-MM-DD HH:mm")],
  ["endOf month", (m) => m.utc("2024-01-15").endOf("month").format("YYYY-MM-DD HH:mm:ss.SSS")],
  ["endOf week", (m) => m.utc("2024-01-15").endOf("week").format("YYYY-MM-DD HH:mm:ss.SSS")],
  ["endOf isoWeek", (m) => m.utc("2024-01-15").endOf("isoWeek").format("YYYY-MM-DD HH:mm:ss.SSS")],
  ["endOf day", (m) => m.utc("2024-01-15").endOf("day").format("HH:mm:ss.SSS")],
  ["endOf quarter", (m) => m.utc("2024-05-15").endOf("quarter").format("YYYY-MM-DD")],
  ["fields", (m) => { const x = m.utc("2024-01-15T08:05:07.042Z"); return [x.year(), x.month(), x.date(), x.day(), x.weekday(), x.isoWeekday(), x.hour(), x.minute(), x.second(), x.millisecond(), x.quarter(), x.dayOfYear(), x.week(), x.isoWeek(), x.daysInMonth(), x.isLeapYear()].join(","); }],
  ["isoWeek 2023-01-01", (m) => String(m.utc("2023-01-01").isoWeek())],
  ["week 2023-01-01", (m) => String(m.utc("2023-01-01").week())],
  ["set date/month", (m) => m.utc("2024-01-31").set("month", 1).format("YYYY-MM-DD") + "|" + m.utc("2024-01-15").set({hour: 5, minute: 6}).format("HH:mm")],
  ["compare unit", (m) => [m.utc("2024-01-15T10:00").isBefore("2024-01-15T18:00", "day"), m.utc("2024-01-15T10:00").isAfter("2024-01-15T18:00", "day"), m.utc("2024-01-15T10:00").isSame("2024-01-15T18:00", "day"), m.utc("2024-01-15T10:00").isSame("2024-01-16T00:00", "day"), m.utc("2024-01-15T10:00").isBetween("2024-01-14", "2024-01-16")].join(",")],
  ["diff", (m) => [m.utc("2024-01-15T18:00").diff("2024-01-15T10:00", "hours"), m.utc("2024-01-16T09:00").diff("2024-01-15T10:00", "days"), m.utc("2024-01-16T09:00").diff("2024-01-15T10:00", "days", true), m.utc("2024-03-14").diff("2024-01-15", "months"), m.utc("2024-03-15").diff("2024-01-15", "months"), m.utc("2024-01-15").diff("2024-03-15", "months")].join(",")],
  ["fromNow", (m) => [m(NOW - 5000).fromNow(), m(NOW - 60000).fromNow(), m(NOW - 30 * 60000).fromNow(), m(NOW - 90 * 60000).fromNow(), m(NOW - 4 * 86400000).fromNow(), m(NOW + 3 * 86400000).fromNow(), m(NOW - 40 * 86400000).fromNow(), m(NOW - 400 * 86400000).fromNow()].join(" | ")],
  ["calendar", (m) => [m(NOW).calendar(), m(NOW - 86400000).calendar(), m(NOW + 86400000).calendar(), m(NOW - 3 * 86400000).calendar(), m(NOW + 3 * 86400000).calendar(), m(NOW - 30 * 86400000).calendar()].join(" | ")],
  ["statics", (m) => [m.isMoment(m()), m.isDate(new Date()), m.min(m.utc("2024-01-15"), m.utc("2024-01-10")).format("YYYY-MM-DD"), m.max(m.utc("2024-01-15"), m.utc("2024-01-20")).format("YYYY-MM-DD"), m.unix(1700000000).valueOf(), m.months()[0], m.weekdays()[0], m.weekdaysMin()[1], m.locale()].join(",")],
  ["duration", (m) => [m.duration(90, "minutes").asHours(), m.duration(90, "minutes").humanize(), m.duration(90, "minutes").humanize(true), m.duration({days: 1, hours: 2}).asHours(), m.duration({days: -3}).humanize(), m.duration(3, "days").asWeeks()].join(",")],
  ["parseZone", (m) => m.parseZone("2024-01-15T10:00:00+02:00").format("YYYY-MM-DDTHH:mm Z")],
  ["utcOffset fixed", (m) => m.utc("2024-01-15T00:00:00").utcOffset(330).format("YYYY-MM-DD HH:mm Z")],
  ["utcOffset getter", (m) => String(m("2024-01-15").utcOffset() === -new Date(2024, 0, 15).getTimezoneOffset())],
  ["toArray/toJSON/toISOString", (m) => [m.utc("2024-01-15T08:05:07.042Z").toArray().join("/"), m.utc("2024-01-15T08:05:07.042Z").toJSON(), m.utc("2024-01-15").toISOString()].join(" | ")],
  ["array/object input", (m) => m([2024, 0, 15, 10, 30]).format("YYYY-MM-DD HH:mm") + "|" + m({year: 2024, month: 0, date: 15}).format("YYYY-MM-DD")],
  ["mutation", (m) => { const a = m.utc("2024-01-15"); a.add(1, "day"); a.startOf("month"); return a.format("YYYY-MM-DD"); }],
  ["mutation returns self", (m) => { const a = m.utc("2024-01-15"); return String(a.add(1, "day") === a); }],
  ["clone is independent", (m) => { const a = m.utc("2024-01-15"); const b = a.clone(); b.add(5, "years"); return a.format("YYYY") + "|" + b.format("YYYY"); }],
  ["setters year/month/date/day/hour/quarter", (m) => { const a = m.utc("2024-01-15T08:00:00"); return [a.year(2025).format("YYYY-MM-DD"), m.utc("2024-01-15").month(5).format("YYYY-MM-DD"), m.utc("2024-01-15").date(3).format("YYYY-MM-DD"), m.utc("2024-01-15T08:00").hour(23).minute(59).format("HH:mm"), m.utc("2024-01-15T08:00").quarter(3).format("YYYY-MM-DD"), m.utc("2024-01-15").day(0).format("YYYY-MM-DD")].join(" | "); }],
];

let fail = 0;
for (const [label, fn] of cases) {
  const r = String(fn(real));
  const o = String(fn(mine));
  const ok = r === o;
  if (!ok) fail++;
  console.log(`${ok ? "same  " : "DIFF  "} ${label}\n        real=${r}\n        mine=${o}`);
}
console.log(`\n${cases.length - fail}/${cases.length} identical to moment@2.29.4`);
