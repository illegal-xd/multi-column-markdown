/**
 * dv API contract tests (upstream DataviewInlineApi parity).
 *
 * Covers the semantics the previous build got wrong or lacked:
 *   fileLink argument order (+ legacy compat), taskList default grouping,
 *   el/header/span/paragraph DomElementInfo + chaining, pagePaths,
 *   sectionLink/blockLink, parse/literal/clone/compare/equal/value, io
 *   (load/normalize/csv), query/tryQuery/queryMarkdown/evaluate/execute/
 *   executeJs/view, markdownTable/List/TaskList.
 *
 * Bundled with esbuild → node --test, same harness as dataview-dv.test.mjs.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-dvapi-"));
try {
  execSync(
    "npx esbuild src/dataview/dv/createDvApi.ts --bundle --format=esm --outfile=" + join(dir, "dv.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {createDvApi} = await import(join(dir, "dv.mjs"));

// ── fixtures ──────────────────────────────────────────────────────────────

function pageMeta(over = {}) {
  return {
    path: "notes/a.md",
    name: "a",
    folder: "notes",
    ext: "md",
    ctime: 0,
    mtime: 0,
    size: 10,
    frontmatter: {},
    inlineFields: {},
    fields: {},
    tags: [],
    etags: [],
    aliases: [],
    headings: [],
    sections: [],
    lists: [],
    listItems: [],
    tasks: [],
    inlinks: [],
    outlinks: [],
    ...over,
  };
}

/** TaskMeta (index layer) — only the fields executeDql/taskMetaToNode read. */
function taskMeta(over = {}) {
  return {
    task: true,
    symbol: "-",
    text: "t",
    visual: "- [ ] t",
    annotated: false,
    status: "",
    checked: false,
    line: 1,
    lineCount: 1,
    indent: 0,
    list: 1,
    tags: [],
    fields: {},
    outlinks: [],
    children: [],
    ...over,
  };
}

/** TaskNode (dv/render shape). */
function task(over = {}) {
  return {text: "task", status: "", children: [], path: "notes/a.md", line: 1, tags: [], fields: {}, ...over};
}

function makePages() {
  return [
    pageMeta({fields: {title: "A"}, frontmatter: {title: "A"}}),
    pageMeta({
      path: "notes/b.md",
      name: "b",
      fields: {title: "Bee"},
      frontmatter: {title: "Bee"},
      tags: ["#proj"],
      etags: ["#proj"],
      tasks: [taskMeta({text: "Buy milk"})],
    }),
    pageMeta({path: "other/c.md", name: "c", folder: "other", fields: {title: "Sea"}, frontmatter: {title: "Sea"}}),
  ];
}

/** config.io reads from `files`; a path is "present" iff it is a `files` key. */
function makeConfig(overrides = {}) {
  const pages = overrides.pages ?? makePages();
  const files = overrides.files ?? {};
  const reads = [];
  const config = {
    index: {version: 1, pages, generatedAt: 0},
    current: "current" in overrides ? overrides.current : pages[0],
    input: "block-source",
    filePath: "filePath" in overrides ? overrides.filePath : "notes/a.md",
    io: {
      async read(p) {
        reads.push(p);
        return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : "content:" + p;
      },
      async exists(p) {
        return Object.prototype.hasOwnProperty.call(files, p);
      },
    },
    funcs: {double: (n) => (typeof n === "number" ? n * 2 : n)},
  };
  return {config, reads, pages, files};
}

function makeSink() {
  const ops = [];
  return {ops, push(op) { ops.push(op); }};
}

function makeDv(overrides = {}) {
  const {config, reads, pages, files} = makeConfig(overrides);
  const sink = makeSink();
  return {dv: createDvApi(config, sink), sink, config, reads, pages, files};
}

// ── fileLink: upstream order + legacy compat ─────────────────────────────
test("dv.fileLink: upstream (path, embed, display) order", () => {
  const {dv} = makeDv();
  const l = dv.fileLink("p.md", true, "Label");
  assert.equal(l.path, "p.md");
  assert.equal(l.embed, true);
  assert.equal(l.display, "Label");
  assert.deepEqual(dv.fileLink("p.md"), {path: "p.md", embed: false});
  assert.equal(typeof l.markdown, "function"); // real Link (link.ts factory)
});

test("dv.fileLink: legacy (path, display, embed) order still works + warns once", () => {
  const {dv} = makeDv();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const a = dv.fileLink("p.md", "Label", true);
    const b = dv.fileLink("p.md", "Other", false);
    assert.equal(a.embed, true);
    assert.equal(a.display, "Label");
    assert.equal(b.embed, false);
    assert.equal(b.display, "Other");
    assert.equal(warnings.length, 1, warnings.join("|"));
    assert.match(warnings[0], /deprecated/);
  } finally {
    console.warn = original;
  }
});

// ── taskList: default grouping ───────────────────────────────────────────

test("dv.taskList defaults to grouping by file (h4 file link + group ops)", () => {
  const {dv, sink} = makeDv();
  const t1 = task({path: "notes/a.md", text: "A"});
  const t2 = task({path: "other/c.md", text: "C"});
  const t3 = task({path: "notes/a.md", text: "A2"});
  dv.taskList([t1, t2, t3]);
  assert.deepEqual(sink.ops, [
    {kind: "header", level: 4, text: "[[notes/a.md]]"},
    {kind: "taskList", tasks: [t1, t3]},
    {kind: "header", level: 4, text: "[[other/c.md]]"},
    {kind: "taskList", tasks: [t2]},
  ]);
});

test("dv.taskList(tasks, false) emits one ungrouped taskList op and drops nulls", () => {
  const {dv, sink} = makeDv();
  const t1 = task({path: "notes/a.md", text: "A"});
  const t2 = task({path: "other/c.md", text: "C"});
  dv.taskList([null, t1, t2, undefined], false);
  assert.deepEqual(sink.ops, [{kind: "taskList", tasks: [t1, t2]}]);
});

// ── el / header / span / paragraph: DomElementInfo + chaining ────────────

test("dv.el: cls/attr from DomElementInfo; createEl/appendText chain inside the op", () => {
  const {dv, sink} = makeDv();
  const div = dv.el("div", "hi", {cls: ["a", "b"], attr: {id: "x", onmouseover: "evil()"}});
  assert.equal(div.tag, "div");
  assert.deepEqual(sink.ops[0], {kind: "el", tag: "div", text: "hi", cls: ["a", "b"], attrs: {id: "x"}});
  const b = div.createEl("B", "bold");
  assert.equal(b.tag, "b");
  assert.deepEqual(sink.ops[0].children, [{kind: "el", tag: "b", text: "bold"}]);
  div.appendText("!");
  assert.equal(sink.ops[0].text, "hi!");
  assert.equal(sink.ops.length, 1); // children stay inside the parent op
});

test("dv.el: cls string, href/title shorthands, options.text fallback", () => {
  const {dv, sink} = makeDv();
  dv.el("span", undefined, {cls: "one", href: "./x.md", title: "T", text: "body"});
  assert.deepEqual(sink.ops[0], {
    kind: "el",
    tag: "span",
    text: "body",
    cls: ["one"],
    attrs: {href: "./x.md", title: "T"},
  });
});

test("dv.el: non-whitelisted tag degrades to notice+span and its chain is inert", () => {
  const {dv, sink} = makeDv();
  const h = dv.el("script", "alert(1)");
  h.createEl("b", "y").appendText("z");
  assert.deepEqual(sink.ops, [
    {kind: "notice", level: "warn", message: 'dv.el: tag "script" is not allowed; rendered as span.'},
    {kind: "span", text: "alert(1)"},
  ]);
});

test("dv.el: addEventListener is accepted, never dispatched, one notice per type", () => {
  const {dv, sink} = makeDv();
  const box = dv.el("div", "Box");
  assert.equal(typeof box.addEventListener, "function");
  assert.equal(typeof box.removeEventListener, "function");
  let ran = false;
  box.addEventListener("click", () => {
    ran = true;
    dv.span("never");
  });
  box.addEventListener("click", () => {}); // same type → still a single notice
  box.addEventListener("mouseenter", () => {});
  box.removeEventListener("click", () => {});
  // The element itself is untouched apart from the notices.
  assert.deepEqual(sink.ops[0], {kind: "el", tag: "div", text: "Box"});
  const notices = sink.ops.filter((op) => op.kind === "notice");
  assert.deepEqual(notices.map((n) => n.level), ["warn", "warn"]);
  assert.ok(notices[0].message.includes('addEventListener("click")'), notices[0].message);
  assert.ok(notices[1].message.includes('addEventListener("mouseenter")'), notices[1].message);
  // Handlers never run and never touch the op tree.
  assert.equal(ran, false);
  assert.equal(sink.ops.some((op) => op.kind === "span"), false);
  // Child elements share the block-scoped dedup.
  box.createEl("b", "bold").addEventListener("click", () => {});
  assert.equal(sink.ops.filter((op) => op.kind === "notice").length, 2);
});

test("dv.el: details/summary are allowed (native disclosure needs no JS)", () => {
  const {dv, sink} = makeDv();
  const details = dv.el("details");
  details.createEl("summary", "Show more");
  details.createEl("div", "hidden");
  assert.equal(sink.ops[0].tag, "details");
  assert.deepEqual(sink.ops[0].children.map((c) => c.tag), ["summary", "div"]);
  // Non-whitelisted tags keep degrading.
  dv.el("marquee", "x");
  assert.equal(sink.ops.some((op) => op.kind === "notice" && op.message.includes("marquee")), true);
});

test("dv.header returns a chainable element and rejects levels outside [1, 6]", () => {
  const {dv, sink} = makeDv();
  const h = dv.header(3, "Title");
  assert.equal(h.tag, "h3");
  assert.deepEqual(sink.ops[0], {kind: "header", level: 3, text: "Title"});
  h.appendText("!");
  assert.equal(sink.ops[0].text, "Title!");
  assert.throws(() => dv.header(0, "x"), /Header level must be in the range \[1, 6\]/);
  assert.throws(() => dv.header(7, "x"), /Header level/);
  assert.throws(() => dv.header(NaN, "x"), /Header level/);
  assert.throws(() => dv.header(Infinity, "x"), /Header level/);
  dv.header(2.9, "frac");
  assert.equal(sink.ops[1].level, 2);
});

test("dv.paragraph/span return elements; createEl appends a sibling op", () => {
  const {dv, sink} = makeDv();
  const p = dv.paragraph("x");
  assert.equal(p.tag, "p");
  const s = dv.span("s");
  assert.equal(s.tag, "span");
  p.createEl("b", "y"); // paragraph op has no children field → new sibling op
  assert.deepEqual(sink.ops, [
    {kind: "paragraph", text: "x"},
    {kind: "span", text: "s"},
    {kind: "el", tag: "b", text: "y"},
  ]);
});

// ── pagePaths / links ────────────────────────────────────────────────────

test("dv.pagePaths filters pages with matchSource", () => {
  const {dv} = makeDv();
  assert.deepEqual(dv.pagePaths().array(), ["notes/a.md", "notes/b.md", "other/c.md"]);
  assert.deepEqual(dv.pagePaths("#proj").array(), ["notes/b.md"]);
  assert.deepEqual(dv.pagePaths("other").array(), ["other/c.md"]);
  assert.equal(typeof dv.pagePaths().where, "function"); // DataArray surface
});

test("dv.sectionLink / dv.blockLink build real Links with subpaths", () => {
  const {dv} = makeDv();
  const s = dv.sectionLink("notes/a.md", "My Heading", true, "Disp");
  assert.equal(s.path, "notes/a.md");
  assert.equal(s.subpath, "#My Heading");
  assert.equal(s.embed, true);
  assert.equal(s.display, "Disp");
  assert.equal(s.type, "header");
  assert.equal(dv.sectionLink("p", "#H2").subpath, "#H2"); // no doubling
  const b = dv.blockLink("notes/a.md", "blk");
  assert.equal(b.subpath, "#^blk");
  assert.equal(b.embed, false);
  assert.equal(b.type, "block");
  assert.equal(dv.blockLink("p", "#^blk").subpath, "#^blk");
});

// ── parse / literal / clone / compare / equal / value ────────────────────

test("dv.parse: links/dates/durations via coerceStringField", () => {
  const {dv} = makeDv();
  const link = dv.parse("[[notes/b.md|Bee]]");
  assert.equal(link.path, "notes/b.md");
  assert.equal(link.display, "Bee");
  assert.equal(dv.parse("2024-01-15").toISO(), "2024-01-15T00:00:00.000Z");
  assert.equal(dv.parse("2h").ms, 7200000);
  assert.equal(dv.parse("plain"), "plain");
});

test("dv.literal converts JS values (date strings parsed, arrays/objects recursed)", () => {
  const {dv} = makeDv();
  assert.equal(dv.literal(5), 5);
  assert.equal(dv.literal(true), true);
  assert.equal(dv.literal(null), null);
  assert.equal(dv.literal("2024-01-15").toISO(), "2024-01-15T00:00:00.000Z");
  assert.deepEqual(dv.literal([1, "a", {b: 2}]), [1, "a", {b: 2}]);
});

test("dv.clone deep-copies containers and rebuilds Link/date/duration factories", () => {
  const {dv} = makeDv();
  const src = {a: [1, {b: 2}]};
  const copy = dv.clone(src);
  assert.deepEqual(copy, src);
  assert.notEqual(copy, src);
  assert.notEqual(copy.a, src.a);
  assert.notEqual(copy.a[1], src.a[1]);

  const link = dv.fileLink("p.md", true, "L");
  const linkCopy = dv.clone(link);
  assert.notEqual(linkCopy, link);
  assert.equal(linkCopy.markdown(), "![[p.md|L]]");

  const d = dv.date("2024-01-15");
  const dCopy = dv.clone(d);
  assert.notEqual(dCopy, d);
  assert.equal(dCopy.toISO(), d.toISO());

  assert.equal(dv.clone(dv.duration("90m")).ms, 5400000);
  assert.deepEqual(dv.clone(dv.array([1, 2])).array(), [1, 2]);
});

test("dv.compare / dv.equal follow Dataview ordering + equality", () => {
  const {dv} = makeDv();
  assert.ok(dv.compare(1, 2) < 0);
  assert.equal(dv.compare(2, 2), 0);
  assert.ok(dv.compare("b", "a") > 0);
  assert.equal(dv.equal(1, 1), true);
  assert.equal(dv.equal(1, 2), false);
  assert.equal(dv.equal(null, null), true);
  assert.equal(dv.equal([1, 2], [1, 2]), true);
  assert.equal(dv.equal([1, 2], [1, 3]), false);
});

test("dv.value: predicates, typeOf, compareValue, deepCopy", () => {
  const {dv} = makeDv();
  const v = dv.value;
  assert.equal(v.typeOf(1), "number");
  assert.equal(v.typeOf("s"), "string");
  assert.equal(v.typeOf(true), "boolean");
  assert.equal(v.typeOf([1]), "array");
  assert.equal(v.typeOf({}), "object");
  assert.equal(v.typeOf(null), "null");
  assert.equal(v.typeOf(undefined), "null");
  assert.equal(v.typeOf(() => 1), "function");
  assert.equal(v.typeOf(dv.date("2024-01-15")), "date");
  assert.equal(v.typeOf(new Date(0)), "date");
  assert.equal(v.typeOf(dv.duration("1h")), "duration");
  assert.equal(v.typeOf(dv.fileLink("p")), "link");

  assert.equal(v.isLink(dv.fileLink("p")), true);
  assert.equal(v.isLink({}), false);
  assert.equal(v.isDate(new Date()), true);
  assert.equal(v.isDate(dv.date("2024-01-15")), true);
  assert.equal(v.isDuration(dv.duration("1h")), true);
  assert.equal(v.isNumber(1), true);
  assert.equal(v.isString("a"), true);
  assert.equal(v.isBoolean(false), true);
  assert.equal(v.isArray([1]), true);
  assert.equal(v.isArray(dv.array([1])), false); // upstream Values.isArray = Array.isArray
  assert.equal(v.isObject({}), true);
  assert.equal(v.isObject(null), false);
  assert.equal(v.isFunction(() => 1), true);
  assert.equal(v.isNull(null), true);
  assert.equal(v.isNull(undefined), false);
  assert.equal(v.isNullOrUndefined(undefined), true);

  assert.ok(v.compareValue(1, 2) < 0);
  const orig = {a: [1]};
  const deep = v.deepCopy(orig);
  assert.deepEqual(deep, orig);
  assert.notEqual(deep, orig);
  assert.notEqual(deep.a, orig.a);
});

test("dv.isArray / dv.isDataArray", () => {
  const {dv} = makeDv();
  assert.equal(dv.isArray([1]), true);
  assert.equal(dv.isArray(dv.array([1])), false);
  assert.equal(dv.isDataArray(dv.array([1])), true);
  assert.equal(dv.isDataArray([1]), false);
});

// ── host context: app / currentFilePath / settings ───────────────────────

test("dv.app (lazy) / currentFilePath / settings defaults + host overrides", () => {
  const {dv, config} = makeDv();
  assert.equal(dv.currentFilePath, "notes/a.md");
  assert.equal(dv.settings.renderNullAs, "-");
  assert.equal(dv.settings.dateFormat, "yyyy-MM-dd");
  assert.equal(dv.settings.maxRenderDepth, 3);
  assert.deepEqual(dv.app.workspace.getActiveFile(), {path: "notes/a.md"});
  assert.equal(dv.app.vault.getFiles().length, 3);
  assert.equal(dv.app.meta.adapter, "vscode");

  config.settings = {renderNullAs: "N/A", dateFormat: "dd.MM.yyyy", maxRenderDepth: 5, displayResultCount: true};
  const dv2 = createDvApi(config, makeSink());
  assert.equal(dv2.settings.renderNullAs, "N/A");
  assert.equal(dv2.settings.dateFormat, "dd.MM.yyyy");
  assert.equal(dv2.settings.maxRenderDepth, 5);
  assert.equal(dv2.settings.displayResultCount, true);
});

// ── io: load / normalize / csv / read ────────────────────────────────────

test("dv.io.load: missing file resolves to undefined; present file reads", async () => {
  const {dv} = makeDv({files: {"notes/b.md": "B content"}});
  assert.equal(await dv.io.load("notes/b.md"), "B content");
  assert.equal(await dv.io.load("./notes/b.md"), "B content");
  assert.equal(await dv.io.load("nope.md"), undefined);
  assert.equal(await dv.io.load({path: "notes/b.md", embed: false}), "B content");
});

test("dv.io.read is the raw read (normalizeRel only, no existence check)", async () => {
  const {dv, reads} = makeDv({files: {"notes/a.md": "A"}});
  assert.equal(await dv.io.read("./notes/a.md"), "A");
  assert.deepEqual(reads, ["notes/a.md"]);
});

test("dv.io.normalize: same-dir priority, ../ collapse, unresolved passthrough", () => {
  const {dv} = makeDv();
  assert.equal(dv.io.normalize("b.md", "notes/a.md"), "notes/b.md");
  assert.equal(dv.io.normalize("./b.md", "notes/a.md"), "notes/b.md");
  assert.equal(dv.io.normalize("../other/c.md", "notes/a.md"), "other/c.md");
  assert.equal(dv.io.normalize("other/c.md", "notes/a.md"), "other/c.md");
  assert.equal(dv.io.normalize("missing.md", "notes/a.md"), "missing.md");
  assert.equal(dv.io.normalize("b.md"), "notes/b.md"); // originFile defaults to config.filePath
  assert.equal(dv.io.normalize("/rooted/x.md"), "rooted/x.md");
});

test("dv.io.csv: RFC4180 subset (quoted commas, escaped quotes, CRLF, blank lines)", async () => {
  const csv = 'name,note\r\nAlice,"a, b"\r\nBob,"say ""hi"""\r\n\r\nCarol,\r\n';
  const {dv} = makeDv({files: {"data/t.csv": csv}});
  const table = await dv.io.csv("data/t.csv");
  assert.equal(table.length, 3);
  assert.deepEqual(table.array(), [
    {name: "Alice", note: "a, b"},
    {name: "Bob", note: 'say "hi"'},
    {name: "Carol", note: ""},
  ]);
});

test("dv.io.csv: quoted newlines stay inside the field; missing file → undefined", async () => {
  const {dv} = makeDv({files: {"m.csv": 'a,b\n"line1\nline2",2\n'}});
  assert.deepEqual((await dv.io.csv("m.csv")).array(), [{a: "line1\nline2", b: "2"}]);
  assert.equal(await dv.io.csv("nope.csv"), undefined);
});

// ── query / evaluate / execute ───────────────────────────────────────────

test("dv.query returns structured table/list results from the DQL engine", async () => {
  const {dv} = makeDv();
  const table = await dv.query("TABLE title\nFROM #proj");
  assert.equal(table.successful, true);
  // Upstream TABLE shape: implicit leading File column holding the page link.
  assert.equal(table.value.type, "table");
  assert.deepEqual(table.value.headers, ["File", "title"]);
  assert.equal(table.value.values[0][0].path, "notes/b.md");
  assert.deepEqual(table.value.values[0][1], "Bee");
  const list = await dv.query("LIST title\nFROM #proj");
  assert.deepEqual(list.value, {type: "list", values: ["Bee"]});
});

test("dv.query: TASKS → {type:'task', values: ListItemNode[]}", async () => {
  const {dv} = makeDv();
  const r = await dv.query("TASKS\nFROM #proj");
  assert.equal(r.successful, true);
  assert.equal(r.value.type, "task");
  assert.equal(r.value.values.length, 1);
  assert.equal(r.value.values[0].text, "Buy milk");
  assert.equal(r.value.values[0].path, "notes/b.md");
});

test("dv.query never throws: parse errors become {successful:false}", async () => {
  const {dv} = makeDv();
  const r = await dv.query("nonsense");
  assert.equal(r.successful, false);
  assert.match(r.error, /must start with TABLE, LIST, TASKS or CALENDAR/);
  await assert.rejects(() => dv.tryQuery("nonsense"), /must start with/);
});

test("dv.query: calendar op (execQuery injection) → DvDate/Link/DvValue values", async () => {
  const {dv, config} = makeDv();
  config.execQuery = () => [
    {kind: "calendar", entries: [{date: "2024-03-05", link: {path: "notes/b.md", embed: false}, value: {t: "num", v: 7}}]},
  ];
  const r = await dv.query("CALENDAR due\nFROM #proj");
  assert.equal(r.successful, true);
  assert.equal(r.value.type, "calendar");
  assert.equal(r.value.values[0].date.toISODate(), "2024-03-05");
  assert.equal(r.value.values[0].link.path, "notes/b.md");
  assert.deepEqual(r.value.values[0].value, [7]);
});

test("dv.query: CellValue link/date/dur round-trip to DvValue", async () => {
  const {dv, config} = makeDv();
  config.execQuery = () => [
    {
      kind: "table",
      headers: ["l", "d", "x"],
      rows: [{
        cells: [
          {t: "link", link: {path: "notes/b.md", embed: false}},
          {t: "date", iso: "2024-01-15T00:00:00.000Z"},
          {t: "dur", ms: 3600000},
        ],
      }],
    },
  ];
  const r = await dv.query("TABLE l, d, x");
  assert.equal(r.successful, true);
  const [l, d, x] = r.value.values[0];
  assert.equal(l.path, "notes/b.md");
  assert.equal(typeof l.markdown, "function");
  assert.equal(d.toISODate(), "2024-01-15");
  assert.equal(x.ms, 3600000);
});

test("dv.queryMarkdown / tryQueryMarkdown use the markdown exporters", async () => {
  const {dv} = makeDv();
  const r = await dv.queryMarkdown("LIST title\nFROM #proj");
  assert.deepEqual(r, {successful: true, value: "- Bee\n"});
  assert.equal(await dv.tryQueryMarkdown("LIST title\nFROM #proj"), "- Bee\n");
  assert.equal((await dv.queryMarkdown("nonsense")).successful, false);
  await assert.rejects(() => dv.tryQueryMarkdown("nonsense"), /must start with/);
});

test("dv.evaluate/tryEvaluate: page scope + this + context override", () => {
  const {dv} = makeDv();
  assert.deepEqual(dv.evaluate("title"), {successful: true, value: "A"});
  assert.equal(dv.evaluate("title", {title: "Override"}).value, "Override");
  assert.equal(dv.evaluate("this.title").value, "A");
  assert.equal(dv.tryEvaluate("1 + 2"), 3);
  const bad = dv.evaluate("!!!");
  assert.equal(bad.successful, false);
  assert.equal(typeof bad.error, "string");
  assert.throws(() => dv.tryEvaluate("!!!"), /./);
});

test("dv.execute runs DQL into the sink (embedded dataview block equivalent)", async () => {
  const {dv, sink} = makeDv();
  await dv.execute("LIST title\nFROM #proj");
  assert.deepEqual(sink.ops, [{kind: "list", items: [{t: "str", v: "Bee"}]}]);

  const second = makeDv();
  second.config.execQuery = () => [{kind: "paragraph", text: "injected"}];
  await second.dv.execute("LIST title");
  assert.deepEqual(second.sink.ops, [{kind: "paragraph", text: "injected"}]);
});

test("dv.executeJs hands code to runNested at the current depth", async () => {
  const {dv, config} = makeDv();
  const calls = [];
  config.runNested = async (code, input, depth) => {
    calls.push({code, input, depth});
    return undefined;
  };
  await dv.executeJs("dv.paragraph('x')");
  assert.deepEqual(calls, [{code: "dv.paragraph('x')", input: undefined, depth: 0}]);
});

test("dv.executeJs without an injected executor throws", async () => {
  const {dv} = makeDv();
  await assert.rejects(() => dv.executeJs("x"), /not available/);
});

// ── dv.view ──────────────────────────────────────────────────────────────

test("dv.view: missing view → error op with the upstream message", async () => {
  const {dv, sink} = makeDv();
  await dv.view("views/missing");
  assert.equal(sink.ops.length, 1);
  assert.equal(sink.ops[0].kind, "error");
  assert.equal(
    sink.ops[0].message,
    "Dataview: custom view not found for 'views/missing.js' or 'views/missing/view.js'.",
  );
});

test("dv.view: runs <path>.js via runNested; an existing view.css is skipped with a notice", async () => {
  const {dv, sink, config} = makeDv({files: {"views/v.js": "dv.paragraph('nested')", "views/v.css": "b{}"}});
  const calls = [];
  config.runNested = async (code, input, depth) => {
    calls.push({code, input, depth});
    return undefined;
  };
  await dv.view("views/v");
  assert.deepEqual(calls, [{code: "dv.paragraph('nested')", input: null, depth: 1}]);
  assert.deepEqual(sink.ops, [
    {kind: "notice", level: "info", message: "Dataview: view stylesheet 'views/v.css' ignored (CSS injection is not supported)."},
  ]);
});

test("dv.view: falls back to <path>/view.js and forwards input", async () => {
  const {dv, config} = makeDv({files: {"views/p/view.js": "code"}});
  const calls = [];
  config.runNested = async (code, input, depth) => {
    calls.push({code, input, depth});
    return undefined;
  };
  await dv.view("views/p", 42);
  assert.deepEqual(calls, [{code: "code", input: 42, depth: 1}]);
});

test("dv.view: recursion depth is capped at 8 → error op", async () => {
  const {dv, sink, config} = makeDv({files: {"loop.js": "loop"}});
  let nested = 0;
  config.runNested = async (code) => {
    nested++;
    await dv.view(code);
    return undefined;
  };
  await dv.view("loop");
  assert.equal(nested, 8);
  const errors = sink.ops.filter((o) => o.kind === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /view recursion depth exceeded \(8\)/);
});

// ── markdown exporters + project extensions ─────────────────────────────

test("dv.markdownTable / List / TaskList delegate to render/markdown", () => {
  const {dv} = makeDv();
  assert.equal(dv.markdownTable(["h"], [["a"]]), "| h |\n| --- |\n| a |\n");
  assert.equal(dv.markdownTable(["h"]), "| h |\n| --- |\n");
  assert.equal(dv.markdownList(["a", "b"]), "- a\n- b\n");
  assert.equal(dv.markdownList(), "");
  const t = task({text: "T", status: "x"});
  assert.equal(dv.markdownTaskList([t]), "- [x] T\n");
  assert.equal(dv.markdownTaskList(t), "- [x] T\n");
});

test("dv.markdownTable / markdownList accept DataArray inputs", () => {
  const {dv} = makeDv();
  assert.equal(dv.markdownList(dv.array(["a"])), "- a\n");
  assert.equal(dv.markdownTable(["t"], dv.array([["a"]])), "| t |\n| --- |\n| a |\n");
});

test("dv.html / dv.markdown remain project extensions", () => {
  const {dv, sink} = makeDv();
  dv.html("<b>x</b>");
  dv.markdown("**m**");
  assert.deepEqual(sink.ops, [
    {kind: "html", html: "<b>x</b>"},
    {kind: "markdown", text: "**m**"},
  ]);
});

rmSync(dir, {recursive: true, force: true});
