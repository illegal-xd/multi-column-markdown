/**
 * `renderHeatmapCalendar` tests (upstream Richardsl/heatmap-calendar-obsidian
 * semantics): year geometry, palette/intensity mapping, per-entry colours,
 * class contract, today border, and the emitted HTML.
 *
 *   NODE_PATH=./test/helpers/node_modules node --test test/dataview-heatmap.test.mjs
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-heatmap-"));
try {
  execSync(
    "npx esbuild src/dataview/dv/heatmapCalendar.ts --bundle --format=esm --outfile=" + join(dir, "heatmap.mjs") +
    " && npx esbuild src/dataview/render/html.ts --bundle --format=esm --outfile=" + join(dir, "html.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {buildHeatmapOp, heatmapWeekdays, DEFAULT_HEATMAP_COLORS, HEATMAP_WEEK_START_DAY} =
  await import(join(dir, "heatmap.mjs"));
const {renderOpsToHtml} = await import(join(dir, "html.mjs"));

/** Today is irrelevant unless a test asks for it: keep it out of the rendered year. */
const OTHER_YEAR_TODAY = new Date(1999, 0, 1, 12);
const build = (data, opts = {}) => buildHeatmapOp(data, {today: OTHER_YEAR_TODAY, ...opts});
const html = (op) => renderOpsToHtml([op], {basePath: "a.md"});

// ── weekday labels ────────────────────────────────────────────────────────

test("heatmap: weekday labels start at weekStartDay (default Monday)", () => {
  assert.equal(HEATMAP_WEEK_START_DAY, 1);
  assert.deepEqual(heatmapWeekdays(1), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.deepEqual(heatmapWeekdays(0), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  assert.deepEqual(heatmapWeekdays(6), ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
  // Out-of-range values wrap instead of producing undefined labels.
  assert.deepEqual(heatmapWeekdays(8), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
});

// ── geometry ──────────────────────────────────────────────────────────────

test("heatmap: leading blanks align Jan 1 to the weekStart column", () => {
  // 2022-01-01 is a Saturday → (6 + 7 - 1) % 7 = 5 blanks, 365 days.
  const y2022 = build({year: 2022});
  assert.equal(y2022.boxes.length, 5 + 365);
  assert.deepEqual(y2022.boxes.slice(0, 5).map((b) => b.color), Array(5).fill("transparent"));
  assert.deepEqual(y2022.boxes[0].classes, []);
  assert.equal(y2022.boxes[5].classes.includes("month-jan"), true);
  // 2024 is a leap year whose Jan 1 is a Monday → no blanks, 366 days.
  const y2024 = build({year: 2024});
  assert.equal(y2024.boxes.length, 366);
  assert.equal(y2024.boxes[365].classes.includes("month-dec"), true);
  // weekStartDay = 0 moves the fillers: 2023-01-01 is a Sunday → no blanks.
  assert.equal(build({year: 2023}, {weekStartDay: 0}).boxes.length, 365);
  assert.equal(build({year: 2023}).boxes.length, 6 + 365);
});

test("heatmap: year defaults to the current one and every box carries a month class", () => {
  const op = build({}, {today: new Date(2022, 5, 10, 12)});
  assert.equal(op.year, 2022);
  assert.equal(op.kind, "heatmap");
  assert.deepEqual(op.weekdays, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const months = new Set(op.boxes.flatMap((b) => b.classes.filter((c) => c.startsWith("month-"))));
  assert.deepEqual([...months].sort(), ["month-apr", "month-aug", "month-dec", "month-feb", "month-jan",
    "month-jul", "month-jun", "month-mar", "month-may", "month-nov", "month-oct", "month-sep"]);
});

// ── palette + intensity mapping ───────────────────────────────────────────

test("heatmap: intensities map linearly onto the default 5-colour palette", () => {
  const op = build({
    year: 2022,
    entries: [
      {date: "2022-01-03", intensity: 1},
      {date: "2022-01-04", intensity: 3},
      {date: "2022-01-05", intensity: 5},
    ],
  });
  const boxes = op.boxes.filter((b) => b.classes.includes("hasData"));
  assert.deepEqual(boxes.map((b) => b.color), [DEFAULT_HEATMAP_COLORS[0], DEFAULT_HEATMAP_COLORS[2], DEFAULT_HEATMAP_COLORS[4]]);
  assert.deepEqual(boxes.map((b) => b.date), ["2022-01-03", "2022-01-04", "2022-01-05"]);
  assert.equal(boxes.every((b) => b.classes.includes("isEmpty")), false);
});

test("heatmap: entries without an intensity use defaultEntryIntensity (4)", () => {
  const entries = [
    {date: "2022-02-01"},
    {date: "2022-02-02", intensity: 1},
    {date: "2022-02-03", intensity: 5},
  ];
  const op = build({year: 2022, entries});
  const colorOf = (o, date) => o.boxes.find((b) => b.date === date).color;
  assert.equal(colorOf(op, "2022-02-01"), DEFAULT_HEATMAP_COLORS[3]);
  assert.equal(colorOf(op, "2022-02-02"), DEFAULT_HEATMAP_COLORS[0]);
  assert.equal(colorOf(op, "2022-02-03"), DEFAULT_HEATMAP_COLORS[4]);
  // Explicit override shifts the default with it.
  const custom = build({year: 2022, defaultEntryIntensity: 5, entries});
  assert.equal(colorOf(custom, "2022-02-01"), DEFAULT_HEATMAP_COLORS[4]);
});

test("heatmap: intensityScaleStart/End override the entry-derived range", () => {
  const entries = [
    {date: "2022-03-01", intensity: 10},
    {date: "2022-03-02", intensity: 55},
    {date: "2022-03-03", intensity: 100},
  ];
  const derived = build({year: 2022, entries});
  assert.deepEqual(
    derived.boxes.filter((b) => b.date).map((b) => b.color),
    [DEFAULT_HEATMAP_COLORS[0], DEFAULT_HEATMAP_COLORS[2], DEFAULT_HEATMAP_COLORS[4]],
  );
  const fixed = build({year: 2022, entries, intensityScaleStart: 10, intensityScaleEnd: 100});
  assert.deepEqual(fixed.boxes.filter((b) => b.date).map((b) => b.color), derived.boxes.filter((b) => b.date).map((b) => b.color));
  // A narrow window saturates: 10 → third level (3 of 5), 55/100 → last.
  const saturated = build({year: 2022, entries, intensityScaleStart: 0, intensityScaleEnd: 20});
  assert.deepEqual(
    saturated.boxes.filter((b) => b.date).map((b) => b.color),
    [DEFAULT_HEATMAP_COLORS[2], DEFAULT_HEATMAP_COLORS[4], DEFAULT_HEATMAP_COLORS[4]],
  );
});

test("heatmap: a flat intensity range fills the last palette colour (upstream guard)", () => {
  const op = build({year: 2022, entries: [{date: "2022-04-01", intensity: 7}, {date: "2022-04-02", intensity: 7}]});
  assert.deepEqual(op.boxes.filter((b) => b.date).map((b) => b.color), [DEFAULT_HEATMAP_COLORS[4], DEFAULT_HEATMAP_COLORS[4]]);
});

test("heatmap: custom palettes select per-entry colour, unknown names fall back to the first", () => {
  const colors = {blue: ["#b1", "#b2", "#b3", "#b4", "#b5"], red: ["#r1", "#r2", "#r3", "#r4", "#r5"]};
  const op = build({
    year: 2022,
    colors,
    entries: [
      {date: "2022-05-01", intensity: 1, color: "blue"},
      {date: "2022-05-02", intensity: 1, color: "red"},
      {date: "2022-05-03", intensity: 1, color: "nope"},
      {date: "2022-05-04", intensity: 5},
    ],
  });
  assert.deepEqual(
    op.boxes.filter((b) => b.date).map((b) => b.color),
    ["#b1", "#r1", "#b1", "#b5"],
  );
  // Palette length defines the number of levels: one entry → the flat-range guard fills it.
  const two = build({year: 2022, colors: {x: ["#a", "#b"]}, entries: [{date: "2022-05-04", intensity: 5}]});
  assert.equal(two.boxes.find((b) => b.date === "2022-05-04").color, "#b");
  // A string (or a malformed palette) falls back to the built-in green scale.
  assert.equal(build({year: 2022, colors: "green", entries: [{date: "2022-05-05", intensity: 5}]})
    .boxes.find((b) => b.date === "2022-05-05").color, DEFAULT_HEATMAP_COLORS[4]);
  assert.equal(build({year: 2022, colors: {bad: []}, entries: [{date: "2022-05-06", intensity: 5}]})
    .boxes.find((b) => b.date === "2022-05-06").color, DEFAULT_HEATMAP_COLORS[4]);
});

// ── filtering / content ───────────────────────────────────────────────────

test("heatmap: entries outside the displayed year are dropped, content survives", () => {
  const op = build({
    year: 2022,
    entries: [
      {date: "2021-12-31", intensity: 1, content: "old"},
      {date: "2022-06-15", intensity: 1, content: "🏋️"},
      {date: "not-a-date", intensity: 1},
    ],
  });
  assert.equal(op.boxes.filter((b) => b.classes.includes("hasData")).length, 1);
  assert.equal(op.boxes.find((b) => b.date === "2022-06-15").content, "🏋️");
  assert.equal(op.boxes.some((b) => b.date === "2021-12-31"), false);
});

test("heatmap: today's box gets the border class, only for the current year", () => {
  const op = build({year: 2022, entries: [{date: "2022-01-15", intensity: 1}]}, {today: new Date(2022, 0, 15, 12)});
  const today = op.boxes.filter((b) => b.classes.includes("today"));
  assert.equal(today.length, 1);
  assert.equal(today[0].date, "2022-01-15");
  // showCurrentDayBorder: false drops it.
  assert.equal(build({year: 2022, showCurrentDayBorder: false}, {today: new Date(2022, 0, 15, 12)})
    .boxes.some((b) => b.classes.includes("today")), false);
  // A past/future year never renders a "today" box (documented upstream deviation).
  assert.equal(build({year: 2020}, {today: new Date(2022, 0, 15, 12)}).boxes.some((b) => b.classes.includes("today")), false);
});

test("heatmap: duplicate dates keep the last entry", () => {
  const op = build({
    year: 2022,
    colors: {a: ["#a1", "#a2", "#a3", "#a4", "#a5"]},
    entries: [
      {date: "2022-07-01", intensity: 5, content: "first", color: "a"},
      {date: "2022-07-01", intensity: 1, content: "last", color: "a"},
    ],
  });
  const boxes = op.boxes.filter((b) => b.date === "2022-07-01");
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].content, "last");
});

test("heatmap: missing entries render an empty year (blanks stay transparent)", () => {
  const op = build({year: 2022});
  const blanks = op.boxes.slice(0, 5); // 2022-01-01 is a Saturday → 5 leading blanks
  const days = op.boxes.slice(5);
  assert.equal(blanks.every((b) => b.color === "transparent" && b.classes.length === 0), true);
  assert.equal(days.length, 365);
  assert.equal(days.every((b) => b.classes.includes("isEmpty")), true);
  assert.equal(days.every((b) => b.color === undefined && b.date === undefined && b.content === undefined), true);
});

// ── HTML ──────────────────────────────────────────────────────────────────

test("heatmap: HTML mirrors the upstream class/attribute contract", () => {
  const out = html(build({
    year: 2022,
    entries: [{date: "2022-02-03", intensity: 5, content: "<b>&"}],
  }));
  assert.ok(out.startsWith('<div class="dataview-container" data-dv-kind="heatmap">'), out.slice(0, 80));
  assert.ok(out.includes('<div class="heatmap-calendar-graph">'));
  assert.ok(out.includes('<div class="heatmap-calendar-year">22</div>'));
  assert.ok(out.includes('<ul class="heatmap-calendar-months"><li>Jan</li>'));
  assert.ok(out.includes("<li>Dec</li></ul>"));
  assert.ok(out.includes('<ul class="heatmap-calendar-days"><li>Mon</li>'));
  assert.ok(out.includes('<ul class="heatmap-calendar-boxes">'));
  // Data box: classes + data-date + inline background + escaped content span.
  assert.ok(out.includes('<li class="month-feb hasData" data-date="2022-02-03" style="background-color: #196127">'));
  assert.ok(out.includes('<span class="heatmap-calendar-content">&lt;b&gt;&amp;</span>'));
  // Empty + leading blanks keep the upstream transparent inline style.
  assert.ok(out.includes('<li class="month-jan isEmpty">'));
  assert.ok(out.includes('style="background-color: transparent"'));
  assert.ok(out.includes('<span class="heatmap-calendar-content"></span>'));
});
