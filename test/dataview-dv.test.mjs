/**
 * B3 tests: dv API op shapes, renderOpsToHtml (escaping/links/truncation/empty),
 * renderPlaceholderHtml/renderErrorHtml, app shim. Bundled via esbuild → node --test.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-dv-"));
try {
  execSync(
    "npx esbuild src/dataview/dv/createDvApi.ts --bundle --format=esm --outfile=" + join(dir, "dv.mjs") +
    " && npx esbuild src/dataview/render/html.ts --bundle --format=esm --outfile=" + join(dir, "html.mjs") +
    " && npx esbuild src/dataview/adapter/shim.ts --bundle --format=esm --outfile=" + join(dir, "shim.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {createDvApi} = await import(join(dir, "dv.mjs"));
const {renderOpsToHtml, renderPlaceholderHtml, renderErrorHtml} = await import(join(dir, "html.mjs"));
const {createAppShim} = await import(join(dir, "shim.mjs"));

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
    tasks: [],
    inlinks: [],
    outlinks: [],
    ...over,
  };
}

function makePages() {
  return [
    pageMeta(),
    pageMeta({
      path: "notes/b.md",
      name: "b",
      fields: {title: "Bee"},
      frontmatter: {title: "Bee"},
      tags: ["#proj"],
      etags: ["#proj"],
      headings: [{level: 1, text: "B Heading", line: 0}],
    }),
    pageMeta({path: "other/c.md", name: "c", folder: "other", fields: {title: "Sea"}, frontmatter: {title: "Sea"}}),
  ];
}

function makeConfig(overrides = {}) {
  const pages = overrides.pages ?? makePages();
  const reads = [];
  const config = {
    index: {version: 1, pages, generatedAt: 0},
    current: "current" in overrides ? overrides.current : pages[0],
    input: "block-source",
    filePath: "filePath" in overrides ? overrides.filePath : "notes/a.md",
    io: {
      read: async (p) => {
        reads.push(p);
        return "content:" + p;
      },
      exists: async () => true,
    },
    funcs: {double: (n) => (typeof n === "number" ? n * 2 : n)},
  };
  return {config, reads, pages};
}

function makeSink() {
  const ops = [];
  return {ops, push(op) { ops.push(op); }};
}

function task(over = {}) {
  return {text: "task", status: "", children: [], path: "notes/a.md", line: 1, tags: [], fields: {}, ...over};
}

function dvWith() {
  const {config, reads, pages} = makeConfig();
  const sink = makeSink();
  return {dv: createDvApi(config, sink), sink, config, reads, pages};
}

// ── dv.page / current / pages ─────────────────────────────────────────────

test("dv.page resolves by normalized path (./ prefix, .md suffix) and Link.path", () => {
  const {dv} = dvWith();
  const p = dv.page("notes/a.md");
  assert.equal(p.file.path, "notes/a.md");
  assert.ok(dv.page("./notes/a.md"));
  assert.ok(dv.page("notes/a"));
  assert.equal(dv.page({path: "notes/b.md", embed: false}).file.path, "notes/b.md");
  assert.equal(dv.page("missing.md"), undefined);
  assert.equal(dv.page(), undefined);
});

test("dv.page exposes merged fields + file metadata", () => {
  const {dv} = dvWith();
  const p = dv.page("notes/b.md");
  assert.equal(p.title, "Bee");
  assert.equal(p.file.name, "b");
  assert.equal(p.file.folder, "notes");
  assert.equal(p.file.ext, "md");
  assert.deepEqual(p.file.link, {path: "notes/b.md", embed: false});
});

test("dv.current returns current page; current(path) ≡ page(path); missing current → undefined", () => {
  const a = makeConfig();
  const dv = createDvApi(a.config, makeSink());
  assert.equal(dv.current().file.path, "notes/a.md");
  assert.equal(dv.current("notes/b.md").file.path, "notes/b.md");
  const noCurrent = makeConfig({current: undefined});
  assert.equal(createDvApi(noCurrent.config, makeSink()).current(), undefined);
});

test("dv.pages: no arg → all; path/tag/link filters via matchSource; DataArray surface", () => {
  const {dv} = dvWith();
  const all = dv.pages();
  assert.equal(all.length, 3);
  assert.equal(typeof all.array, "function");
  // String source folder/prefix semantics (Dataview): "notes" matches
  // notes/a.md + notes/sub/*.md — golden source.ts fixed by integrator after
  // B2 E4 exposed the extension-less normPath bug (was: folder → 0 rows).
  assert.equal(dv.pages("notes/a.md").length, 1);
  assert.equal(dv.pages("notes/b").length, 1);
  assert.equal(dv.pages("notes").length, 2);
  assert.equal(dv.pages("notes/").length, 2);
  assert.equal(dv.pages("missing").length, 0);
  const tagged = dv.pages("#proj");
  assert.equal(tagged.length, 1);
  assert.equal(tagged.first().file.path, "notes/b.md");
  assert.equal(dv.pages({path: "notes/b.md", embed: false}).length, 1);
  assert.deepEqual(dv.pages().array().map((p) => p.file.path), ["notes/a.md", "notes/b.md", "other/c.md"]);
});

// ── dv.array / date / duration / fileLink / func / io ─────────────────────

test("dv.array wraps arrays, passes DataArray through, boxes scalars and strings", () => {
  const {dv} = dvWith();
  assert.deepEqual(dv.array([1, 2]).array(), [1, 2]);
  const da = dv.array([3]);
  assert.equal(dv.array(da), da);
  assert.deepEqual(dv.array(5).array(), [5]);
  assert.deepEqual(dv.array("hi").array(), ["hi"]);
  assert.deepEqual(dv.array(new Set([7])).array(), [7]);
});

test("dv.date / dv.duration parse and return null on bad input", () => {
  const {dv} = dvWith();
  const d = dv.date("2024-01-15");
  assert.equal(d.toISO(), "2024-01-15T00:00:00.000Z");
  assert.equal(dv.date(new Date(0)).toISO(), "1970-01-01T00:00:00.000Z");
  assert.equal(dv.date(null), null);
  assert.equal(dv.date(undefined), null);
  assert.equal(dv.date("nope"), null);
  assert.equal(dv.duration("2h").ms, 7200000);
  assert.equal(dv.duration(null), null);
  assert.deepEqual(dv.duration({ms: 500}), {ms: 500});
  assert.equal(dv.duration("hello"), null);
});

test("dv.fileLink builds Link with display kept and embed default false", () => {
  const {dv} = dvWith();
  // 上游签名是 (path, embed = false, display?) —— 顺序已修正。
  assert.deepEqual(dv.fileLink("notes/a.md"), {path: "notes/a.md", embed: false});
  assert.deepEqual(dv.fileLink("p", true, "Label"), {path: "p", display: "Label", embed: true});
});

test("dv.func is the injected funcs table by reference", () => {
  const {dv, config} = dvWith();
  assert.strictEqual(dv.func, config.funcs);
  assert.equal(dv.func.double(21), 42);
});

test("dv.io.read/load normalize ./ and route through config.io.read", async () => {
  const {dv, reads} = dvWith();
  assert.equal(await dv.io.read("./notes/a.md"), "content:notes/a.md");
  assert.equal(await dv.io.load({path: "./notes/b.md", embed: false}), "content:notes/b.md");
  assert.equal(await dv.io.load("other/c.md"), "content:other/c.md");
  assert.deepEqual(reads, ["notes/a.md", "notes/b.md", "other/c.md"]);
});

// ── dv.table op shapes ────────────────────────────────────────────────────

test("dv.table: array rows → String() headers + toCell cells", () => {
  const {dv, sink} = dvWith();
  dv.table(["Name", 1], [["a", 1], ["b", null]]);
  assert.equal(sink.ops.length, 1);
  assert.deepEqual(sink.ops[0], {
    kind: "table",
    headers: ["Name", "1"],
    rows: [
      {cells: [{t: "str", v: "a"}, {t: "num", v: 1}]},
      {cells: [{t: "str", v: "b"}, {t: "null"}]},
    ],
  });
});

test("dv.table: DataArray of page objects → rows keyed by headers", () => {
  const {dv, sink} = dvWith();
  dv.table(["title"], dv.pages());
  assert.deepEqual(sink.ops[0].rows, [
    {cells: [{t: "null"}]},
    {cells: [{t: "str", v: "Bee"}]},
    {cells: [{t: "str", v: "Sea"}]},
  ]);
});

test("dv.table: single object row and scalar row forms", () => {
  const {dv, sink} = dvWith();
  dv.table(["a"], {a: 1});
  assert.deepEqual(sink.ops[0].rows, [{cells: [{t: "num", v: 1}]}]);
  dv.table(["v"], [7]);
  assert.deepEqual(sink.ops[1].rows, [{cells: [{t: "num", v: 7}]}]);
});

test("dv.table groupByFile: first row per file path carries group placeholder", () => {
  const {dv, sink} = dvWith();
  dv.table(
    ["v"],
    [
      {file: {path: "notes/a.md"}, v: 1},
      {file: {path: "notes/a.md"}, v: 2},
      {file: {path: "other/c.md"}, v: 3},
    ],
    true,
  );
  assert.deepEqual(sink.ops[0].rows, [
    {cells: [{t: "num", v: 1}], group: {t: "str", v: "notes/a.md"}},
    {cells: [{t: "num", v: 2}]},
    {cells: [{t: "num", v: 3}], group: {t: "str", v: "other/c.md"}},
  ]);
});

test("dv.table groupByFile with plain array rows (no file meta) stays ungrouped", () => {
  const {dv, sink} = dvWith();
  dv.table(["v"], [[1]], true);
  assert.deepEqual(sink.ops[0].rows, [{cells: [{t: "num", v: 1}]}]);
});

// ── dv.list / taskList op shapes ──────────────────────────────────────────

test("dv.list: single value / array / DataArray → cells; ordered flag only when true", () => {
  const {dv, sink} = dvWith();
  dv.list("one");
  assert.deepEqual(sink.ops[0], {kind: "list", items: [{t: "str", v: "one"}]});
  dv.list([1, [2, 3]]);
  assert.deepEqual(sink.ops[1], {
    kind: "list",
    items: [{t: "num", v: 1}, {t: "arr", v: [{t: "num", v: 2}, {t: "num", v: 3}]}],
  });
  dv.list(dv.array(["x"]));
  assert.deepEqual(sink.ops[2], {kind: "list", items: [{t: "str", v: "x"}]});
  dv.list(["a"], true);
  assert.deepEqual(sink.ops[3], {kind: "list", items: [{t: "str", v: "a"}], ordered: true});
});

test("dv.taskList: filters null/undefined, keeps nested children", () => {
  const {dv, sink} = dvWith();
  const t = task({text: "parent", children: [task({text: "child", status: "x"})]});
  // upstream `taskList(tasks, groupByFile = true)` —— 不分组需显式传 false。
  dv.taskList([null, t, undefined], false);
  assert.equal(sink.ops.length, 1);
  assert.deepEqual(sink.ops[0], {kind: "taskList", tasks: [t]});
  assert.equal(sink.ops[0].tasks[0].children[0].text, "child");
});

test("dv.taskList groupByFile: h4 header per path, then taskList op per group", () => {
  const {dv, sink} = dvWith();
  const t1 = task({path: "notes/a.md", text: "A"});
  const t2 = task({path: "other/c.md", text: "C"});
  const t3 = task({path: "notes/a.md", text: "A2"});
  dv.taskList([t1, t2, t3], true);
  assert.deepEqual(sink.ops, [
    {kind: "header", level: 4, text: "[[notes/a.md]]"},
    {kind: "taskList", tasks: [t1, t3]},
    {kind: "header", level: 4, text: "[[other/c.md]]"},
    {kind: "taskList", tasks: [t2]},
  ]);
});

// ── text/el/html op shapes ────────────────────────────────────────────────

test("dv.header requires a level in [1, 6] (throws outside, like upstream)", () => {
  const {dv, sink} = dvWith();
  dv.header(2.5, "T");
  assert.deepEqual(sink.ops[0], {kind: "header", level: 2, text: "T"});
  assert.throws(() => dv.header(9, "T"), /Header level must be in the range \[1, 6\]/);
  assert.throws(() => dv.header(0, "T"), /Header level/);
  assert.throws(() => dv.header(NaN, "T"), /Header level/);
});

test("dv.paragraph / span / html / markdown push exact ops", () => {
  const {dv, sink} = dvWith();
  dv.paragraph("p");
  dv.span("s");
  dv.html("<b>raw</b>");
  dv.markdown("**m**");
  assert.deepEqual(sink.ops, [
    {kind: "paragraph", text: "p"},
    {kind: "span", text: "s"},
    {kind: "html", html: "<b>raw</b>"},
    {kind: "markdown", text: "**m**"},
  ]);
});

test("dv.text params simplify objects/arrays via cellToText(toCell(v))", () => {
  const {dv, sink} = dvWith();
  dv.paragraph(dv.array([1, 2]));
  dv.header(1, {a: 1});
  assert.equal(sink.ops[0].text, "[1, 2]");
  assert.equal(sink.ops[1].text, "{a: 1}");
});

test("dv.el: whitelisted tag lowercased with cls/attr from DomElementInfo; br is void", () => {
  const {dv, sink} = dvWith();
  dv.el("DIV", "hi", {cls: "x", attr: {title: "t", onclick: "evil()"}});
  dv.el("br");
  assert.deepEqual(sink.ops[0], {kind: "el", tag: "div", text: "hi", cls: ["x"], attrs: {title: "t"}});
  assert.deepEqual(sink.ops[1], {kind: "el", tag: "br", text: ""});
});

test("dv.el: non-whitelisted tag degrades to warn notice + span", () => {
  const {dv, sink} = dvWith();
  dv.el("script", "alert(1)");
  assert.deepEqual(sink.ops, [
    {kind: "notice", level: "warn", message: 'dv.el: tag "script" is not allowed; rendered as span.'},
    {kind: "span", text: "alert(1)"},
  ]);
  dv.el("iframe");
  assert.equal(sink.ops[2].kind, "notice");
  assert.equal(sink.ops[3].kind, "span");
});

// ── renderOpsToHtml: structure ────────────────────────────────────────────

test("table HTML: container/table/row classes + data-dv-total-rows", () => {
  const {dv, sink} = dvWith();
  dv.table(["Name"], [["a"]]);
  const html = renderOpsToHtml(sink.ops, {basePath: "notes/a.md"});
  assert.equal(
    html,
    '<div class="dataview-container" data-dv-kind="table" data-dv-total-rows="1">' +
      '<table class="dataview-table"><thead><tr><th>Name</th></tr></thead>' +
      '<tbody><tr class="dataview-row"><td>a</td></tr></tbody></table></div>',
  );
});

test("table group placeholder row uses colspan + dataview-group-row", () => {
  const html = renderOpsToHtml(
    [{kind: "table", headers: ["v"], rows: [{group: {t: "str", v: "g"}, cells: [{t: "num", v: 1}]}]}],
    {basePath: "a.md"},
  );
  assert.ok(html.includes('<tr class="dataview-group-row"><td colspan="1">g</td></tr>'), html);
  assert.ok(html.includes('<tr class="dataview-row"><td>1</td></tr>'), html);
});

test("empty table renders dataview-empty inside container, no <table>", () => {
  const {dv, sink} = dvWith();
  dv.table(["a"], []);
  const html = renderOpsToHtml(sink.ops, {basePath: "notes/a.md"});
  assert.equal(
    html,
    '<div class="dataview-container" data-dv-kind="table" data-dv-total-rows="0">' +
      '<div class="dataview-empty">No results.</div></div>',
  );
  assert.ok(!html.includes("<table"));
});

test("list HTML: exact ul/ol markup; nested array value → child ul", () => {
  const ops = [{kind: "list", items: [{t: "str", v: "a"}, {t: "arr", v: [{t: "str", v: "b"}, {t: "str", v: "c"}]}]}];
  const html = renderOpsToHtml(ops, {basePath: "a.md"});
  assert.equal(
    html,
    '<div class="dataview-container" data-dv-kind="list"><ul class="dataview-list">' +
      "<li>a</li><li><ul class=\"dataview-list\"><li>b</li><li>c</li></ul></li>" +
      "</ul></div>",
  );
  const ordered = renderOpsToHtml([{kind: "list", items: [{t: "num", v: 1}], ordered: true}], {basePath: "a.md"});
  assert.ok(ordered.includes('<ol class="dataview-list"><li>1</li></ol>'), ordered);
});

test("taskList HTML: checkbox state, nested children ul, exact classes", () => {
  const t = task({
    text: "Buy <milk>",
    status: "x",
    children: [task({text: "sub", status: ""})],
  });
  const html = renderOpsToHtml([{kind: "taskList", tasks: [t]}], {basePath: "a.md"});
  assert.ok(html.startsWith('<div class="dataview-container" data-dv-kind="taskList"><ul class="dataview-task-list">'));
  assert.ok(html.includes('<li class="dataview-task" data-dv-status="x">'), html);
  assert.ok(html.includes('<input type="checkbox" class="dataview-task-checkbox" disabled checked>'), html);
  assert.ok(html.includes('<span class="dataview-task-text">Buy &lt;milk&gt;</span>'), html);
  assert.ok(
    html.includes('<ul class="dataview-task-list"><li class="dataview-task" data-dv-status="">' +
      '<input type="checkbox" class="dataview-task-checkbox" disabled><span class="dataview-task-text">sub</span></li></ul>'),
    html,
  );
  assert.ok(html.endsWith("</li></ul></div>"), html);
});

test("grouped taskList end-to-end: h4 file headers inside render output", () => {
  const {dv, sink} = dvWith();
  dv.taskList([task({path: "notes/a.md", text: "A"}), task({path: "other/c.md", text: "C"})], true);
  const html = renderOpsToHtml(sink.ops, {basePath: "notes/a.md"});
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="header"><h4>[[notes/a.md]]</h4></div>'), html);
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="header"><h4>[[other/c.md]]</h4></div>'), html);
  assert.equal(html.split('data-dv-kind="taskList"').length - 1, 2);
});

test("text ops render semantic tags inside their containers", () => {
  const html = renderOpsToHtml(
    [
      {kind: "paragraph", text: "hi"},
      {kind: "header", level: 2, text: "T"},
      {kind: "span", text: "s"},
      {kind: "markdown", text: "m"},
      {kind: "html", html: "<b>x</b>"},
    ],
    {basePath: "a.md"},
  );
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="paragraph"><p>hi</p></div>'));
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="header"><h2>T</h2></div>'));
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="span"><span>s</span></div>'));
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="markdown">m</div>'));
  assert.ok(html.includes('<div class="dataview-container" data-dv-kind="html"><b>x</b></div>'));
});

test("error/notice/empty ops render contract classes; render levels", () => {
  const html = renderOpsToHtml(
    [
      {kind: "error", message: "bad", detail: "stack"},
      {kind: "notice", level: "warn", message: "w"},
      {kind: "notice", level: "info", message: "i"},
      {kind: "empty", message: "none"},
    ],
    {basePath: "a.md"},
  );
  assert.ok(html.includes('<div class="dataview-error">bad<pre class="dataview-error-detail">stack</pre></div>'));
  assert.ok(html.includes('<div class="dataview-notice dataview-notice-warn">w</div>'));
  assert.ok(html.includes('<div class="dataview-notice dataview-notice-info">i</div>'));
  assert.ok(html.includes('<div class="dataview-empty">none</div>'));
});

test("el op renders tag/attrs/text; void tags; on* handlers dropped", () => {
  const html = renderOpsToHtml(
    [
      {kind: "el", tag: "div", text: 'a "b"', attrs: {title: 'x "y"'}},
      {kind: "el", tag: "br"},
      {kind: "el", tag: "a", text: "go", attrs: {href: "./x.md", onclick: "evil()"}},
    ],
    {basePath: "a.md"},
  );
  assert.ok(html.includes('<div title="x &quot;y&quot;">a &quot;b&quot;</div>'), html);
  assert.ok(html.includes("<br>"), html);
  assert.ok(html.includes('<a href="./x.md">go</a>'), html);
  assert.ok(!html.includes("onclick"), html);
});

test("details/summary render as native disclosure (summary text stays inline)", () => {
  const html = renderOpsToHtml(
    [
      {
        kind: "el",
        tag: "details",
        text: "",
        children: [
          {kind: "el", tag: "summary", text: "**More**"},
          {kind: "el", tag: "div", text: "hidden"},
        ],
      },
    ],
    {basePath: "a.md", renderInline: (md) => `INLINE(${md})`, renderMarkdownBlock: (md) => `BLOCK(${md})`},
  );
  assert.ok(html.includes('<details>'), html);
  // summary is inline: its text is not wrapped in a block-level <p>.
  assert.ok(html.includes("<summary>INLINE(**More**)</summary>"), html);
  assert.ok(!html.includes("<summary><p>"), html);
});

// ── renderOpsToHtml: cell rendering rules ─────────────────────────────────

test("cell rules: date/dur/bool/arr/obj/null/html/md", () => {
  const cells = [
    {t: "date", iso: "2024-01-15T00:00:00.000Z"},
    {t: "dur", ms: 5400000},
    {t: "bool", v: true},
    {t: "arr", v: [{t: "num", v: 1}, {t: "num", v: 2}]},
    {t: "obj", v: {a: {t: "str", v: "x"}}},
    {t: "null"},
    {t: "html", v: "<b>hi</b>"},
    {t: "md", v: "**b**"},
  ];
  const html = renderOpsToHtml([{kind: "table", headers: cells.map((_, i) => String(i)), rows: [{cells}]}], {
    basePath: "a.md",
  });
  assert.ok(html.includes("<td>2024-01-15</td>")); // midnight-only date → default dateFormat
  assert.ok(html.includes("<td>1h 30m</td>"));
  assert.ok(html.includes("<td>true</td>"));
  // upstream renderValue(expandList): arrays/objects expand to nested <ul>, null → renderNullAs ("-").
  assert.ok(html.includes('<td><ul class="dataview-list dataview-result-list-ul"><li class="dataview-result-list-li">1</li><li class="dataview-result-list-li">2</li></ul></td>'));
  assert.ok(html.includes('<td><ul class="dataview-list dataview-result-object-ul"><li class="dataview-result-object-li">a: x</li></ul></td>'));
  assert.ok(html.includes("<td>-</td>"));
  assert.ok(html.includes("<td><b>hi</b></td>"));
  assert.ok(html.includes("<td>**b**</td>"));
});

test("link cell: relative ./ ../ href, .md completion, display default = path", () => {
  const links = [
    {t: "link", link: {path: "notes/b.md", embed: false}},
    {t: "link", link: {path: "other/c.md", embed: false}},
    {t: "link", link: {path: "x", embed: false}},
    {t: "link", link: {path: "p.md", display: 'Say "hi"', embed: false}},
  ];
  const html = renderOpsToHtml([{kind: "table", headers: ["l"], rows: [{cells: links}]}], {basePath: "notes/a.md"});
  assert.ok(html.includes('<a href="./b.md">notes/b.md</a>'), html);
  assert.ok(html.includes('<a href="../other/c.md">other/c.md</a>'), html);
  assert.ok(html.includes('<a href="../x.md">x</a>'), html);
  assert.ok(html.includes('<a href="../p.md">Say &quot;hi&quot;</a>'), html);
  const root = renderOpsToHtml(
    [{kind: "table", headers: ["l"], rows: [{cells: [{t: "link", link: {path: "notes/b.md", embed: false}}]}]}],
    {basePath: "a.md"},
  );
  assert.ok(root.includes('<a href="./notes/b.md">notes/b.md</a>'), root);
});

test("link subpath → VSCode-approx heading slug; weird chars stripped", () => {
  const html = renderOpsToHtml(
    [
      {
        kind: "table",
        headers: ["l"],
        rows: [
          {
            cells: [
              {t: "link", link: {path: "notes/x", subpath: "#My Heading", embed: false}},
              {t: "link", link: {path: "notes/x", subpath: "#Weird! Name?", embed: false}},
            ],
          },
        ],
      },
    ],
    {basePath: "notes/a.md"},
  );
  assert.ok(html.includes('<a href="./x.md#my-heading">notes/x</a>'), html);
  assert.ok(html.includes('<a href="./x.md#weird-name">notes/x</a>'), html);
});

test("renderInline injection applies to str/md cells, paragraph, header, task text", () => {
  const ops = [
    {kind: "table", headers: ["c"], rows: [{cells: [{t: "str", v: "*em*"}, {t: "md", v: "**b**"}]}]},
    {kind: "paragraph", text: "para"},
    {kind: "header", level: 3, text: "head"},
    {kind: "taskList", tasks: [task({text: "tasktext"})]},
  ];
  const html = renderOpsToHtml(ops, {basePath: "a.md", renderInline: (md) => `<i>${md}</i>`});
  assert.ok(html.includes("<td><i>*em*</i></td>"), html);
  assert.ok(html.includes("<td><i>**b**</i></td>"), html);
  assert.ok(html.includes("<p><i>para</i></p>"), html);
  assert.ok(html.includes("<h3><i>head</i></h3>"), html);
  assert.ok(html.includes('<span class="dataview-task-text"><i>tasktext</i></span>'), html);
  const plain = renderOpsToHtml(ops, {basePath: "a.md"});
  assert.ok(plain.includes("<td>*em*</td>"), plain);
  assert.ok(plain.includes("<p>para</p>"), plain);
});

// ── security: escaping ────────────────────────────────────────────────────

test("XSS: <script>/breakout payloads are escaped — no executable script in output", () => {
  const {dv, sink} = dvWith();
  dv.paragraph('<script>alert("pwn")</script>');
  dv.header(1, "<script>x</script>");
  dv.span("</span><script>y</script>");
  dv.table(["<b>h</b>"], [['<script>alert(1)</script>', "<img src=x onerror=alert(1)>"]]);
  dv.el("div", "<script>z</script>", {attr: {'"><script>': "bad", onmouseover: "alert(1)"}});
  const html = renderOpsToHtml(sink.ops, {basePath: "notes/a.md"});
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("<img"), html);
  assert.ok(!html.includes("onmouseover"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
  assert.ok(html.includes("&lt;b&gt;h&lt;/b&gt;"), html);
});

test("XSS: task status and error/notice messages are escaped", () => {
  const html = renderOpsToHtml(
    [
      {kind: "taskList", tasks: [task({status: '"><script>x</script>', text: "<i>t</i>"})]},
      {kind: "error", message: "<script>e</script>", detail: "<script>d</script>"},
      {kind: "notice", level: "info", message: "<script>n</script>"},
    ],
    {basePath: "a.md"},
  );
  assert.ok(!html.includes("<script"), html);
  assert.ok(html.includes('data-dv-status="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'), html);
  assert.ok(html.includes('<span class="dataview-task-text">&lt;i&gt;t&lt;/i&gt;</span>'), html);
});

// ── truncation ────────────────────────────────────────────────────────────

test("maxRows truncates table rows and appends warn notice row", () => {
  const {dv, sink} = dvWith();
  dv.table(["n"], [[0], [1], [2], [3], [4]]);
  const html = renderOpsToHtml(sink.ops, {basePath: "a.md", maxRows: 2});
  assert.ok(html.includes('data-dv-total-rows="5"'), html);
  assert.ok(html.includes("<td>0</td>") && html.includes("<td>1</td>"), html);
  assert.ok(!html.includes("<td>2</td>"), html);
  assert.ok(html.includes("Showing first 2 of 5 rows."), html);
  assert.ok(html.includes('<tr class="dataview-notice-row">'), html);
  assert.ok(html.includes('<div class="dataview-notice dataview-notice-warn">'), html);
});

test("maxCells truncates rows globally with cell-limit notice", () => {
  const {dv, sink} = dvWith();
  dv.table(["n"], [[0], [1], [2], [3], [4]]);
  const html = renderOpsToHtml(sink.ops, {basePath: "a.md", maxCells: 3});
  assert.ok(html.includes("<td>2</td>") && !html.includes("<td>3</td>"), html);
  assert.ok(html.includes("Cell limit reached — output truncated at 3 cells."), html);
});

test("maxCells also truncates list items with notice", () => {
  const html = renderOpsToHtml([{kind: "list", items: [{t: "num", v: 1}, {t: "num", v: 2}, {t: "num", v: 3}]}], {
    basePath: "a.md",
    maxCells: 2,
  });
  assert.ok(html.includes("<li>1</li>") && html.includes("<li>2</li>") && !html.includes("<li>3</li>"), html);
  assert.ok(html.includes("Cell limit reached"), html);
  assert.ok(html.includes('dataview-notice dataview-notice-warn'), html);
});

// ── placeholder / error helpers ───────────────────────────────────────────

test("renderPlaceholderHtml: pending container with kind + hash attrs", () => {
  assert.equal(
    renderPlaceholderHtml("dataviewjs", "h1"),
    '<div class="dataview-container dataview-pending" data-dv-kind="dataviewjs" data-dv-hash="h1"></div>',
  );
  const escaped = renderPlaceholderHtml('a"><b', "x&y");
  assert.ok(escaped.includes('data-dv-kind="a&quot;&gt;&lt;b"'), escaped);
  assert.ok(escaped.includes('data-dv-hash="x&amp;y"'), escaped);
});

test("renderErrorHtml: container + error class, optional detail pre, escaped", () => {
  assert.equal(
    renderErrorHtml("boom"),
    '<div class="dataview-container" data-dv-kind="error"><div class="dataview-error">boom</div></div>',
  );
  const withDetail = renderErrorHtml("boom", "stack <here>");
  assert.ok(withDetail.includes('<div class="dataview-error">boom<pre class="dataview-error-detail">stack &lt;here&gt;</pre></div>'));
  assert.ok(!renderErrorHtml("<script>x</script>").includes("<script"));
});

// ── app shim ──────────────────────────────────────────────────────────────

test("app shim: vault.read routes through config.io with ./ normalized", async () => {
  const {config, reads} = makeConfig();
  const shim = createAppShim(config);
  assert.equal(await shim.vault.read("./notes/a.md"), "content:notes/a.md");
  assert.equal(await shim.vault.read("notes/b.md"), "content:notes/b.md");
  assert.deepEqual(reads, ["notes/a.md", "notes/b.md"]);
});

test("app shim: snapshot lookups (getAbstractFileByPath/getFiles/getFileCache/getActiveFile)", () => {
  const {config} = makeConfig();
  const shim = createAppShim(config);
  assert.deepEqual(shim.vault.getAbstractFileByPath("notes/a.md"), {
    path: "notes/a.md",
    name: "a",
    basename: "a",
  });
  assert.equal(shim.vault.getAbstractFileByPath("./notes/a").path, "notes/a.md");
  assert.equal(shim.vault.getAbstractFileByPath("missing.md"), null);
  const files = shim.vault.getFiles();
  assert.equal(files.length, 3);
  assert.deepEqual(files[0], {path: "notes/a.md", name: "a", basename: "a"});
  const cache = shim.metadataCache.getFileCache("notes/b.md");
  assert.deepEqual(cache.frontmatter, {title: "Bee"});
  assert.deepEqual(cache.headings, [{level: 1, text: "B Heading", line: 0}]);
  assert.equal(shim.metadataCache.getFileCache("missing.md"), null);
  assert.deepEqual(shim.workspace.getActiveFile(), {path: "notes/a.md"});
  assert.deepEqual(shim.meta, {adapter: "vscode", version: 1});
  const noFile = createAppShim({...config, filePath: ""});
  assert.equal(noFile.workspace.getActiveFile(), null);
});

rmSync(dir, {recursive: true, force: true});
