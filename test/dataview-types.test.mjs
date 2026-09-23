/**
 * Dataview value-surface tests: Duration / DateTime method parity (Luxon-lite),
 * Link factory + methods, and duck-type / clone compatibility with the plain
 * index shapes. Pattern: esbuild bundle → node --test.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-types-"));
try {
  execSync(
    "npx esbuild src/dataview/query/datetime.ts --bundle --format=esm --outfile=" + join(dir, "datetime.mjs") +
    " && npx esbuild src/dataview/link.ts --bundle --format=esm --outfile=" + join(dir, "link.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {parseDuration, parseDate, createDuration, now, today} = await import(join(dir, "datetime.mjs"));
const {createLink, linkFromMeta} = await import(join(dir, "link.mjs"));

const dur = (v) => parseDuration(v);
const date = (v) => parseDate(v);

// ── helpers mirroring values.ts duck-typing ────────────────────────────────

const isDuration = (v) =>
  typeof v === "object" && v !== null && "ms" in v && typeof v.ms === "number";
const isLink = (v) =>
  typeof v === "object" && v !== null && "path" in v && typeof v.path === "string" && "embed" in v;

// ── Duration ───────────────────────────────────────────────────────────────

test("duration: parse keeps ms and docs example (8 minutes → 8)", () => {
  const d = dur("8 minutes");
  assert.equal(d.ms, 480000);
  assert.equal(d.asMinutes(), 8);
  assert.equal(d.toMillis(), 480000);
  assert.equal(d.toSeconds(), 480);
  assert.equal(d.valueOf(), 480000);
  assert.equal(isDuration(d), true);
  assert.equal(dur("nope"), null);
  assert.equal(dur(1500).ms, 1500);
});

test("duration: as()/asX() use luxon casual factors (year=365d, month=30d, week=7d)", () => {
  const d = createDuration(365 * 86400000);
  assert.equal(d.as("years"), 1);
  assert.equal(d.asYears(), 1);
  assert.equal(d.as("months"), 365 / 30);
  assert.equal(d.asMonths(), 365 / 30);
  assert.equal(d.asWeeks(), 52.142857142857146);
  assert.equal(createDuration(90000000).asDays(), 90000000 / 86400000);
  assert.equal(createDuration(90000000).asHours(), 25);
  assert.equal(createDuration(90000000).asMinutes(), 1500);
  assert.equal(createDuration(90000000).asSeconds(), 90000);
  assert.equal(createDuration(90000000).asMilliseconds(), 90000000);
  assert.equal(createDuration(90000000).as("days"), 90000000 / 86400000);
  assert.ok(Number.isNaN(createDuration(1).as("fortnights")));
  assert.equal(dur("P1Y2M").ms, 365 * 86400000 + 2 * 30 * 86400000);
  assert.equal(dur("1d2h30m").ms, 86400000 + 2 * 3600000 + 30 * 60000);
});

test("duration: toObject decomposes; shiftTo re-bases the requested units", () => {
  const d = createDuration(90000000); // 25h
  assert.deepEqual(d.toObject(), {
    years: 0, months: 0, days: 1, hours: 1, minutes: 0, seconds: 0, milliseconds: 0,
  });
  assert.deepEqual(createDuration(-90000000).toObject(), {
    years: 0, months: 0, days: -1, hours: -1, minutes: 0, seconds: 0, milliseconds: 0,
  });
  assert.deepEqual(d.shiftTo("days", "minutes").toObject(), {days: 1, minutes: 60});
  assert.deepEqual(d.shiftTo("minutes").toObject(), {minutes: 1500});
  assert.equal(d.shiftTo("days", "minutes").ms, 90000000, "shiftTo is value-preserving");
  assert.deepEqual(d.shiftTo().toObject(), d.toObject(), "no units → unchanged");
});

test("duration: toISO/toString are decomposition based, toFormat uses y M w d h m s S", () => {
  assert.equal(dur("8 minutes").toISO(), "PT8M");
  assert.equal(dur("8 minutes").toString(), "PT8M");
  assert.equal(dur("8 minutes").toFormat("m"), "8");
  assert.equal(dur("90 minutes").toFormat("h:mm"), "1:30");
  assert.equal(dur("1 day 2 hours").toFormat("d 'days' h 'hours'"), "1 days 2 hours");
  assert.equal(dur("2h").toFormat("mm"), "120");
  assert.equal(createDuration(0).toISO(), "PT0S");
  assert.equal(createDuration(-1000).toISO(), "-PT1S");
  assert.equal(createDuration(1500).toISO(), "PT1.5S");
  assert.equal(createDuration(8 * 86400000 + 2 * 3600000).toISO(), "P8DT2H");
  assert.equal(createDuration(90000000).shiftTo("days", "minutes").toFormat("d 'd' m 'm'"), "1 d 60 m");
});

test("duration: plus/minus/normalize/equals/isValid/toPrimitive", () => {
  const base = dur("1 hour");
  assert.equal(base.plus(dur("30 minutes")).asMinutes(), 90);
  assert.equal(base.plus(60000).asMinutes(), 61);
  assert.equal(base.plus({minutes: 15}).asMinutes(), 75);
  assert.equal(base.minus(dur("90 minutes")).asMinutes(), -30);
  assert.equal(base.normalize().ms, base.ms);
  assert.equal(base.equals(dur("1 hour")), true);
  assert.equal(base.equals(3600000), true);
  assert.equal(base.equals(dur("1 hour 1ms")), false);
  assert.equal(base.isValid, true);
  assert.equal(String(base), "PT1H");
  assert.equal(base + 1, 3600001, "numeric hint → ms (luxon valueOf behaviour)");
  assert.equal(`${base}`, "PT1H", "string hint → ISO");
});

test("duration: methods are non-enumerable — JSON/keys/clone/deepEqual unchanged", () => {
  const d = dur("8 minutes");
  assert.deepEqual(Object.keys(d), ["ms"]);
  assert.deepEqual(d, {ms: 480000});
  assert.equal(JSON.stringify(d), '{"ms":480000}');
  assert.deepEqual(structuredClone(d), {ms: 480000});
  assert.equal(isDuration(structuredClone(d)), true);
  for (const name of ["asMinutes", "toObject", "toFormat", "shiftTo", "isValid"]) {
    assert.ok(name in d && typeof d[name] !== "undefined", name + " present on the value");
  }
});

// ── DateTime ───────────────────────────────────────────────────────────────

test("date: endOf(unit) — docs example endOf('month') on Jan 31", () => {
  assert.equal(date("2024-01-31").endOf("month").toISO(), "2024-01-31T23:59:59.999Z");
  assert.equal(date("2024-06-15").endOf("year").toISO(), "2024-12-31T23:59:59.999Z");
  assert.equal(date("2024-01-31T10:20:30.400Z").endOf("day").toISO(), "2024-01-31T23:59:59.999Z");
  assert.equal(date("2024-01-31T10:20:30.400Z").endOf("hour").toISO(), "2024-01-31T10:59:59.999Z");
  assert.equal(date("2024-01-31T10:20:30.400Z").endOf("minute").toISO(), "2024-01-31T10:20:59.999Z");
  assert.equal(date("2024-01-31T10:20:30.400Z").endOf("second").toISO(), "2024-01-31T10:20:30.999Z");
  // 2024-01-31 is a Wednesday → ISO week ends Sunday 2024-02-04.
  assert.equal(date("2024-01-31T10:20:30.400Z").endOf("week").toISO(), "2024-02-04T23:59:59.999Z");
  assert.equal(date("2023-01-31").endOf("month").toISO(), "2023-01-31T23:59:59.999Z");
});

test("date: set(parts) replaces fields, clamping the day (luxon fromObject rule)", () => {
  assert.equal(date("2024-01-31").set({month: 2}).toISO(), "2024-02-29T00:00:00.000Z");
  assert.equal(date("2023-01-31").set({month: 2}).toISO(), "2023-02-28T00:00:00.000Z");
  assert.equal(date("2024-01-31T10:20:30.400Z").set({hour: 5, minute: 0}).toISO(), "2024-01-31T05:00:30.400Z");
  assert.equal(date("2024-01-31T10:20:30.400Z").set({day: 15, millisecond: 7}).toISO(), "2024-01-15T10:20:30.007Z");
  assert.equal(date("2024-01-31").set({year: 2020}).toISO(), "2020-01-31T00:00:00.000Z");
  assert.equal(date("2024-01-31").set({}).toISO(), "2024-01-31T00:00:00.000Z");
});

test("date: diff/until/hasSame return Durations", () => {
  const a = date("2024-02-01");
  const b = date("2024-01-01");
  assert.equal(a.diff(b, "days").asDays(), 31);
  assert.equal(a.diff(b, "days").as("days"), 31);
  assert.equal(a.diff(b).ms, 31 * 86400000);
  assert.equal(a.diff(b).toMillis(), 31 * 86400000);
  assert.equal(a.diff(b).toISO(), "P1M1D");
  assert.equal(b.diff(a, "days").asDays(), -31, "sign is this - other");
  assert.equal(isDuration(a.diff(b, "days")), true);
  assert.equal(b.until(a).asDays(), 31);
  assert.equal(a.until(b).asDays(), -31);
  assert.equal(a.hasSame(date("2024-02-15"), "month"), true);
  assert.equal(a.hasSame(date("2024-02-15"), "day"), false);
  assert.equal(a.hasSame(date("2024-01-05"), "year"), true);
});

test("date: ISO helpers + toObject + names + daysInMonth", () => {
  const d = date("2024-01-31T10:20:30.400Z");
  assert.equal(d.toISODate(), "2024-01-31");
  assert.equal(d.toISOTime(), "10:20:30.400Z");
  assert.equal(date("2024-01-31").toISOTime(), "00:00:00.000Z");
  assert.equal(d.toISOWeekDate(), "2024-W05-3");
  assert.equal(date("2021-01-01").toISOWeekDate(), "2020-W53-5", "year boundary week");
  assert.deepEqual(d.toObject(), {year: 2024, month: 1, day: 31, hour: 10, minute: 20, second: 30, millisecond: 400});
  assert.equal(date("2024-01-31").weekdayLong(), "Wednesday");
  assert.equal(date("2024-01-07").weekdayLong(), "Sunday");
  assert.equal(d.monthLong(), "January");
  assert.equal(date("2024-12-01").monthLong(), "December");
  assert.equal(date("2024-02-10").daysInMonth(), 29);
  assert.equal(date("2023-02-10").daysInMonth(), 28);
  assert.equal(date("2024-04-01").daysInMonth(), 30);
  assert.equal(date("2024-01-01").daysInMonth(), 31);
});

test("date: toRelative wording is deterministic English (tiered, luxon thresholds)", () => {
  const base = date("2024-01-01T00:00:00Z");
  assert.equal(date("2024-01-04").toRelative(base), "in 3 days");
  assert.equal(date("2024-01-04").toRelative({base}), "in 3 days");
  assert.equal(date("2024-01-01").toRelative(date("2024-01-04")), "3 days ago");
  assert.equal(base.toRelative(base), "now");
  assert.equal(date("2024-01-02").toRelative(base), "in 1 day");
  assert.equal(date("2024-01-01T12:00:00Z").toRelative(base), "in 12 hours");
  assert.equal(date("2024-01-01T00:30:00Z").toRelative(base), "in 30 minutes");
  assert.equal(date("2024-01-01T00:00:30Z").toRelative(base), "in 30 seconds");
  assert.equal(date("2024-02-15").toRelative(date("2024-01-15")), "in 1 month");
  assert.equal(date("2024-05-15").toRelative(date("2024-01-15")), "in 4 months");
  assert.equal(date("2025-06-15").toRelative(date("2024-01-15")), "in 1 year");
  assert.equal(date("2024-01-01T00:00:00.200Z").toRelative(base), "in 0 seconds");
});

test("date: plus/minus take milliseconds; isValid; serialization unchanged", () => {
  assert.equal(date("2024-01-31").plus({milliseconds: 500}).toISO(), "2024-01-31T00:00:00.500Z");
  assert.equal(date("2024-01-31").minus({milliseconds: 1}).toISO(), "2024-01-30T23:59:59.999Z");
  assert.equal(date("2024-01-31").plus({days: 1, milliseconds: 250}).toISO(), "2024-02-01T00:00:00.250Z");
  assert.equal(date("2024-01-31").isValid, true);
  const d = date("2024-01-31");
  assert.deepEqual(Object.keys(d), [], "no own enumerable fields (private #t)");
  assert.equal(JSON.stringify(d), "{}");
});

test("date: parseDate rules unchanged (ISO, date-only, time, luxon formats)", () => {
  assert.equal(parseDate("2024-01-15").toISO(), "2024-01-15T00:00:00.000Z");
  assert.equal(parseDate("2024-01-15T10:20:30Z").toISO(), "2024-01-15T10:20:30.000Z");
  assert.equal(parseDate("2024-01-15T10:20:30.400+02:00").toISO(), "2024-01-15T08:20:30.400Z");
  // Offset-less date-times go through Date.parse → machine-local, as before this change.
  assert.ok(parseDate("2024-01-15 10:20") !== null);
  assert.ok(parseDate("2024-01-15T10:20") !== null);
  assert.equal(parseDate(0).toISO(), "1970-01-01T00:00:00.000Z");
  assert.equal(parseDate(1700000000000).toISO(), "2023-11-14T22:13:20.000Z");
  assert.equal(parseDate(new Date(Date.UTC(2024, 0, 15))).toISO(), "2024-01-15T00:00:00.000Z");
  assert.equal(parseDate("nope"), null);
  assert.equal(parseDate(""), null);
  const d = parseDate("2024-01-15");
  assert.equal(parseDate(d), d, "DvDate passthrough");
  assert.equal(d.toFormat("yyyy-MM-dd HH:mm:ss"), "2024-01-15 00:00:00");
  assert.equal(d.toFormat("yy/M/d"), "24/1/15");
  assert.equal(d.startOf("year").toISO(), "2024-01-01T00:00:00.000Z");
  assert.equal(d.endOf("year").toISO(), "2024-12-31T23:59:59.999Z");
  assert.ok(now() instanceof Object && typeof now().toISO() === "string");
  assert.equal(today().toISOTime(), "00:00:00.000Z");
});

// ── Link ───────────────────────────────────────────────────────────────────

test("link: createLink/type/toString docs examples", () => {
  assert.equal(createLink({path: "A.md", subpath: "#H"}).type, "header");
  assert.equal(createLink({path: "A.md", subpath: "#^blk"}).type, "block");
  assert.equal(createLink({path: "A.md"}).type, "file");
  assert.equal(createLink({path: "A.md", subpath: "H"}).type, "file", "no # → file (port convention)");
  assert.equal(createLink({path: "A", display: "B"}).toString(), "[[A|B]]", "toString === markdown (upstream)");
});

test("link: markdown()/obsidianLink()/toObject()/toJSON()", () => {
  const l = createLink({path: "notes/a.md", subpath: "#Heading", display: "Label"});
  assert.equal(l.markdown(), "[[notes/a.md#Heading|Label]]");
  assert.equal(createLink({path: "a.md", embed: true, display: "D"}).markdown(), "![[a.md|D]]");
  assert.equal(createLink({path: "a.md"}).markdown(), "[[a.md]]");
  assert.equal(l.obsidianLink(), "[Label](notes/a.md)");
  assert.equal(createLink({path: "a.md"}).obsidianLink(), "[a.md](a.md)");
  assert.deepEqual(l.toObject(), {
    path: "notes/a.md", type: "header", subpath: "#Heading", display: "Label", embed: false, external: false,
  });
  assert.deepEqual(l.toJSON(), {path: "notes/a.md", display: "Label", subpath: "#Heading", embed: false});
  assert.equal(JSON.stringify(l), '{"path":"notes/a.md","display":"Label","subpath":"#Heading","embed":false}');
});

test("link: with*/as* are immutable rebuilds", () => {
  const file = createLink({path: "notes/a.md"});
  const header = file.withHeader("H");
  assert.equal(header.subpath, "#H");
  assert.equal(header.type, "header");
  assert.equal(file.subpath, undefined, "original untouched");
  assert.equal(header.withHeader("#H2").subpath, "#H2", "leading # not doubled");
  assert.equal(file.withBlock("blk").subpath, "#^blk");
  assert.equal(file.withBlock("#^blk").subpath, "#^blk");
  assert.equal(header.asFile().subpath, undefined);
  assert.equal(header.asFile().type, "file");
  assert.equal(file.withDisplay("D").display, "D");
  assert.equal(file.withSubpath("#x").type, "header");
  assert.equal(file.withSubpath(undefined).subpath, undefined);
  assert.equal(file.asEmbed(true).embed, true);
  assert.equal(file.asEmbed(true).asEmbed(false).embed, false);
  assert.equal(header.asFile().markdown(), "[[notes/a.md]]");
});

test("link: equals is target-based (path+type+subpath), display/embed ignored", () => {
  const a = createLink({path: "a.md", display: "one"});
  assert.equal(a.equals(createLink({path: "a.md", display: "two"})), true);
  assert.equal(a.equals(createLink({path: "a.md", embed: true})), true);
  assert.equal(a.equals(createLink({path: "b.md"})), false);
  assert.equal(a.equals(createLink({path: "a.md", subpath: "#H"})), false);
  assert.equal(a.equals({path: "a.md", embed: false}), true, "plain index-shape links compare fine");
  assert.equal(a.equals(null), false);
  assert.equal(a.equals(undefined), false);
  assert.equal(a.equals("a.md"), false);
});

test("link: external inference + explicit flag", () => {
  // Internal links carry NO external property at all (undefined ⇒ falsy), so the
  // plain `{path, embed}` JSON/deep-equal shape stays byte-identical.
  assert.equal(createLink({path: "notes/a.md"}).external, undefined);
  assert.equal(createLink({path: "https://example.com/x"}).external, true);
  assert.equal(createLink({path: "mailto:a@b.c"}).external, true);
  assert.equal(createLink({path: "notes/a.md", external: true}).external, true);
  assert.equal(createLink({path: "notes/a.md", external: true}).asFile().external, true, "flag survives rebuilds");
});

test("link: duck-type + JSON + clone compatibility with the plain index shape", () => {
  const l = createLink({path: "a.md", embed: false});
  assert.equal(isLink(l), true);
  assert.deepEqual(Object.keys(l), ["path", "embed"]);
  assert.deepEqual(l, {path: "a.md", embed: false});
  assert.equal("display" in l, false, "absent fields stay absent (deepEqual-safe)");
  assert.equal("subpath" in l, false);
  assert.deepEqual({...l}, {path: "a.md", embed: false}, "spread keeps the data fields");
  assert.equal(JSON.stringify(l), '{"path":"a.md","embed":false}');
  assert.deepEqual(structuredClone(l), {path: "a.md", embed: false});
  assert.equal(isLink(structuredClone(l)), true);
  assert.equal(typeof l.markdown, "function");
});

test("values survive the DQL engine's detached member call (own accessors)", () => {
  // expression.ts memberGet: own properties only, then `const fn = rec[k]; fn(...)`.
  const d = dur("2h");
  assert.equal(typeof d["asMinutes"], "function");
  const asMinutes = d["asMinutes"];
  assert.equal(asMinutes(), 120, "detached duration method keeps its receiver");
  const toFormat = d["toFormat"];
  assert.equal(toFormat("h"), "2");
  assert.equal(d["toObject"]().hours, 2);
  assert.equal(d["isValid"], true);

  const l = createLink({path: "a.md", subpath: "#H"});
  const detachedToString = l["toString"];
  assert.equal(detachedToString(), "[[a.md#H]]", "detached link method keeps its receiver");
  const detachedWithDisplay = l["withDisplay"];
  assert.equal(detachedWithDisplay("D").markdown(), "[[a.md#H|D]]");
  assert.equal(l["type"], "header", "type is an own accessor, not a prototype getter");
  assert.equal(l["external"], undefined, "internal links carry no external flag");
  assert.equal(l["embed"], false);
  assert.equal(l["path"], "a.md");
});

test("link: linkFromMeta mirrors page.ts helper (incl. LinkMeta with line)", () => {
  assert.deepEqual(linkFromMeta({path: "a.md", embed: false}), {path: "a.md", embed: false});
  assert.deepEqual(linkFromMeta({path: "a.md", display: "D", subpath: "#H", embed: true}).toObject(), {
    path: "a.md", type: "header", subpath: "#H", display: "D", embed: true, external: false,
  });
  const meta = {path: "b.md", display: undefined, subpath: undefined, embed: false, line: 3};
  const l = linkFromMeta(meta);
  assert.deepEqual(l, {path: "b.md", embed: false}, "line is not copied, undefined keys omitted");
  assert.equal(l.type, "file");
  assert.equal(l.embed, false);
});
