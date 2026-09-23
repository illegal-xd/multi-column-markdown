/**
 * Render semantics tests (upstream Dataview `ui/render.ts renderValue()` and
 * `ui/export/markdown.ts` equivalents). Bundled via esbuild → node --test:
 *   NODE_PATH=./test/helpers/node_modules node --test test/dataview-render.test.mjs
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-render-"));
try {
  execSync(
    "npx esbuild src/dataview/render/html.ts --bundle --format=esm --outfile=" + join(dir, "html.mjs") +
    " && npx esbuild src/dataview/render/markdown.ts --bundle --format=esm --outfile=" + join(dir, "markdown.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {renderOpsToHtml, renderPlaceholderHtml, renderErrorHtml} = await import(join(dir, "html.mjs"));
const md = await import(join(dir, "markdown.mjs"));
const {markdownTable, markdownList, markdownTaskList} = md;

const cell = (html, opts = {}) =>
  renderOpsToHtml([{kind: "table", headers: ["c"], rows: [{cells: [html]}]}], {basePath: "a.md", ...opts});
const listHtml = (items, opts = {}) => renderOpsToHtml([{kind: "list", items}], {basePath: "a.md", ...opts});
const unescapeAttr = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// ── null / renderNullAs ───────────────────────────────────────────────────

test("null cell → renderNullAs (default '-'), rendered as inline markdown", () => {
  assert.ok(cell({t: "null"}).includes("<td>-</td>"), cell({t: "null"}));
  // renderInline applies → a markdown null placeholder can become bold.
  const bold = cell({t: "null"}, {renderNullAs: "**无**", renderInline: (m) => `<i>${m}</i>`});
  assert.ok(bold.includes("<td><i>**无**</i></td>"), bold);
  // no renderInline → escaped literal.
  const escaped = cell({t: "null"}, {renderNullAs: "<none>"});
  assert.ok(escaped.includes("<td>&lt;none&gt;</td>"), escaped);
  // list op items go through the same rule.
  assert.ok(listHtml([{t: "null"}]).includes("<li>-</li>"), listHtml([{t: "null"}]));
});

// ── dates ─────────────────────────────────────────────────────────────────

test("date cell: midnight renders date only, otherwise date + HH:mm", () => {
  assert.ok(cell({t: "date", iso: "2024-01-15T00:00:00.000Z"}).includes("<td>2024-01-15</td>"));
  assert.ok(cell({t: "date", iso: "2024-01-15T14:30:00.000Z"}).includes("<td>2024-01-15 14:30</td>"));
  assert.ok(cell({t: "date", iso: "2024-01-15T00:00:01.000Z"}).includes("<td>2024-01-15 00:00</td>"));
});

test("date cell honors opts.dateFormat (time suffix follows when present)", () => {
  const opts = {dateFormat: "dd/MM/yyyy"};
  assert.ok(cell({t: "date", iso: "2024-01-15T00:00:00.000Z"}, opts).includes("<td>15/01/2024</td>"));
  assert.ok(cell({t: "date", iso: "2024-01-15T14:30:00.000Z"}, opts).includes("<td>15/01/2024 14:30</td>"));
  // A format that already carries a time token is not doubled up.
  const full = {dateFormat: "yyyy-MM-dd HH:mm"};
  assert.ok(cell({t: "date", iso: "2024-01-15T14:30:00.000Z"}, full).includes("<td>2024-01-15 14:30</td>"));
  assert.ok(!cell({t: "date", iso: "2024-01-15T14:30:00.000Z"}, full).includes("14:30 14:30"));
});

// ── arrays / objects in cells (expandList) ────────────────────────────────

test("array cell → nested bullet list; empty array → empty ul (not [a, b])", () => {
  const html = cell({t: "arr", v: [{t: "num", v: 1}, {t: "str", v: "b"}]});
  assert.ok(
    html.includes(
      '<ul class="dataview-list dataview-result-list-ul">' +
        '<li class="dataview-result-list-li">1</li>' +
        '<li class="dataview-result-list-li">b</li></ul>',
    ),
    html,
  );
  assert.ok(!html.includes("[1, b]"), html);
  assert.ok(cell({t: "arr", v: []}).includes('<td><ul class="dataview-list"></ul></td>'), cell({t: "arr", v: []}));
});

test("nested array cell → nested ul inside its parent li", () => {
  const html = cell({t: "arr", v: [{t: "arr", v: [{t: "num", v: 1}]}, {t: "num", v: 2}]});
  assert.ok(
    html.includes(
      '<li class="dataview-result-list-li"><ul class="dataview-list dataview-result-list-ul">' +
        '<li class="dataview-result-list-li">1</li></ul></li>',
    ),
    html,
  );
  assert.ok(html.includes('<li class="dataview-result-list-li">2</li>'), html);
});

test("object cell → nested ul of `key: value`; empty object → empty ul; keys escaped", () => {
  const html = cell({t: "obj", v: {a: {t: "str", v: "x"}}});
  assert.ok(
    html.includes('<ul class="dataview-list dataview-result-object-ul"><li class="dataview-result-object-li">a: x</li></ul>'),
    html,
  );
  assert.ok(cell({t: "obj", v: {}}).includes('<td><ul class="dataview-list"></ul></td>'));
  // recursion: object value that is itself an object/array.
  const nested = cell({t: "obj", v: {o: {t: "obj", v: {b: {t: "num", v: 2}}}}});
  assert.ok(nested.includes("o: "), nested);
  assert.ok(nested.includes("b: 2"), nested);
  const keyEsc = cell({t: "obj", v: {"<k>": {t: "num", v: 1}}});
  assert.ok(keyEsc.includes("&lt;k&gt;: 1"), keyEsc);
});

// ── arrays / objects inline ───────────────────────────────────────────────

test("inline mode: array → comma joined, empty array → literal `<empty list>`", () => {
  // list op items render their scalar/object cells inline (arrays keep the nested-ul shape).
  const html = listHtml([{t: "obj", v: {a: {t: "arr", v: [{t: "num", v: 1}, {t: "num", v: 2}]}}}]);
  assert.ok(html.includes("<li>a: 1, 2</li>"), html);
  assert.ok(!html.includes("[1, 2]"), html);
  const empty = listHtml([{t: "obj", v: {a: {t: "arr", v: []}}}]);
  assert.ok(empty.includes("a: &lt;empty list&gt;"), empty);
});

test("inline mode: object → `k: v, k2: v2`, empty object → literal `<empty object>`", () => {
  const html = listHtml([{t: "obj", v: {a: {t: "str", v: "x"}, b: {t: "num", v: 1}}}]);
  assert.ok(html.includes("<li>a: x, b: 1</li>"), html);
  const empty = listHtml([{t: "obj", v: {a: {t: "obj", v: {}}}}]);
  assert.ok(empty.includes("a: &lt;empty object&gt;"), empty);
});

test("list op nested array keeps the legacy nested <ul class=\"dataview-list\"> shape", () => {
  const html = listHtml([
    {t: "str", v: "a"},
    {t: "arr", v: [{t: "str", v: "b"}, {t: "arr", v: [{t: "str", v: "c"}]}]},
  ]);
  assert.ok(html.includes('<li>a</li>'), html);
  assert.ok(
    html.includes('<li><ul class="dataview-list"><li>b</li><li><ul class="dataview-list"><li>c</li></ul></li></ul></li>'),
    html,
  );
});

// ── depth ─────────────────────────────────────────────────────────────────

test("maxRenderDepth (default 3): deeper nesting renders the depth marker", () => {
  const arr = (inner) => ({t: "arr", v: [inner]});
  const depth4 = arr(arr(arr(arr({t: "num", v: 9}))));
  const deep = cell(depth4);
  assert.ok(deep.includes("…"), deep);
  assert.ok(!deep.includes(">9<"), deep);
  // shallow enough → real value
  assert.ok(cell(arr(arr({t: "num", v: 9}))).includes(">9<"));
  // explicit maxRenderDepth
  assert.ok(!cell(arr({t: "num", v: 9}), {maxRenderDepth: 10}).includes("…"));
  assert.ok(cell(arr({t: "num", v: 9}), {maxRenderDepth: 0}).includes("…"));
});

// ── links ─────────────────────────────────────────────────────────────────

test("external link → new-tab anchor; internal links keep relative path + #slug", () => {
  const ext = cell({
    t: "link",
    link: {path: "https://example.com/x?q=1&r=2", embed: false, external: true},
  });
  assert.ok(
    ext.includes('<a href="https://example.com/x?q=1&amp;r=2" target="_blank" rel="noopener">https://example.com/x?q=1&amp;r=2</a>'),
    ext,
  );
  assert.ok(!ext.includes("./https"), ext);
  const extDisplay = cell({t: "link", link: {path: "https://e.com", display: "site", embed: false, external: true}});
  assert.ok(extDisplay.includes('>site</a>'), extDisplay);
  // internal link: unchanged behaviour
  const rel = {basePath: "notes/a.md"};
  assert.ok(cell({t: "link", link: {path: "notes/b.md", embed: false}}, rel).includes('<a href="./b.md">notes/b.md</a>'));
  assert.ok(
    cell({t: "link", link: {path: "notes/x", subpath: "#My Heading", embed: false}}, rel).includes(
      '<a href="./x.md#my-heading">notes/x</a>',
    ),
  );
});

test("anchor slug matches GitHub/VSCode normalization; block refs degrade to the file", () => {
  const rel = {basePath: "notes/a.md"};
  const href = (subpath) =>
    renderOpsToHtml([{kind: "list", items: [{t: "link", link: {path: "notes/x", subpath, embed: false}}]}], rel)
      .match(/href="([^"]+)"/)[1];

  // VSCode preview heading ids: lowercase, whitespace runs → one "-", punctuation dropped.
  assert.equal(href("#My   Heading!"), "./x.md#my-heading");
  assert.equal(href("#Section 1.2 — Notes"), "./x.md#section-12--notes");
  assert.equal(href("#snake_case-kept"), "./x.md#snake_case-kept");
  // "#^blockid" is an Obsidian-only anchor: VSCode's preview has none, so the
  // link must still reach the file (working jump beats a dead anchor).
  assert.equal(href("#^blockid"), "./x.md");
});

// ── calendar / badge ops ──────────────────────────────────────────────────

test("calendar op: month-grouped non-interactive list (documented deviation)", () => {
  const html = renderOpsToHtml(
    [
      {
        kind: "calendar",
        entries: [
          {date: "2024-01-15", link: {path: "notes/a.md", embed: false}, value: {t: "str", v: "x"}},
          {date: "2024-01-02", link: {path: "notes/a.md", embed: false}},
          {date: "2024-02-01", link: {path: "notes/b.md", embed: false}},
        ],
      },
    ],
    {basePath: "notes/a.md"},
  );
  assert.ok(html.startsWith('<div class="dataview-container" data-dv-kind="calendar">'), html);
  assert.ok(
    html.includes(
      '<h4>2024-01</h4><ul class="dataview-list dataview-calendar-list">' +
        '<li><a href="./a.md">notes/a.md</a>15: x</li>' +
        '<li><a href="./a.md">notes/a.md</a>02</li></ul>',
    ),
    html,
  );
  assert.ok(html.includes('<h4>2024-02</h4><ul class="dataview-list dataview-calendar-list"><li><a href="./b.md">notes/b.md</a>01</li></ul>'), html);
  // value uses inline rendering; day/month text is escaped.
  const inline = renderOpsToHtml(
    [
      {
        kind: "calendar",
        entries: [{date: "2024-01-<x", link: {path: "notes/a.md", embed: false}, value: {t: "obj", v: {a: {t: "arr", v: [{t: "num", v: 1}, {t: "num", v: 2}]}}}}],
      },
    ],
    {basePath: "notes/a.md"},
  );
  assert.ok(inline.includes("&lt;x"), inline);
  assert.ok(inline.includes("a: 1, 2"), inline);
  assert.ok(!inline.includes("<script"), inline);
});

test("badge op → escaped dataview-badge div", () => {
  const html = renderOpsToHtml([{kind: "badge", text: '42 results <b>"x"</b>'}], {basePath: "a.md"});
  assert.equal(
    html,
    '<div class="dataview-container" data-dv-kind="badge">' +
      '<div class="dataview-badge">42 results &lt;b&gt;&quot;x&quot;&lt;/b&gt;</div></div>',
  );
});

// ── contracts kept ────────────────────────────────────────────────────────

test("payload / budget / helper contracts survive the new cell semantics", () => {
  // payload cells reuse the same renderer (arr cell in a >threshold table).
  const rows = Array.from({length: 100}, () => ({cells: [{t: "null"}]}));
  const html = renderOpsToHtml([{kind: "table", headers: ["n"], rows}], {basePath: "a.md"});
  const m = / data-dv-payload="([^"]*)"/.exec(html);
  assert.ok(m, "payload attribute expected for 100 rows");
  const payload = JSON.parse(unescapeAttr(m[1]));
  assert.deepEqual(payload.rows[0].cells, ["<td>-</td>"]);
  assert.equal(payload.total, 100);
  assert.equal(html.split("<td>-</td>").length - 1, 100);
  // cell budget still truncates
  const capped = renderOpsToHtml([{kind: "table", headers: ["n"], rows}], {basePath: "a.md", maxCells: 3, payloadThreshold: 0});
  assert.ok(capped.includes("Cell limit reached — output truncated at 3 cells."), capped);
  // helper signatures unchanged
  assert.equal(
    renderPlaceholderHtml("dataviewjs", "h1"),
    '<div class="dataview-container dataview-pending" data-dv-kind="dataviewjs" data-dv-hash="h1"></div>',
  );
  assert.ok(renderErrorHtml("boom").includes('<div class="dataview-error">boom</div>'));
});

// ── markdown exports ──────────────────────────────────────────────────────

test("markdownTable: GFM header/separator/rows", () => {
  assert.equal(
    markdownTable(["a", "b"], [["1", "2"], ["3", "4"]]),
    "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
  );
  assert.equal(markdownTable(["only"], []), "| only |\n| --- |\n");
});

test("markdownTable: cell conversion (link/date/duration/array/object/null) + pipe escaping", () => {
  const rows = [[
    {path: "notes/x.md", display: "X", embed: false},
    {path: "notes/y.md", embed: false},
    new Date("2024-01-15T00:00:00.000Z"),
    {toFormat: () => "", toISO: () => "2024-01-15T14:30:00.000Z", year: 2024},
    {ms: 5400000},
    [1, 2],
    {k: "v"},
    null,
    "a|b",
  ]];
  const out = markdownTable(
    ["l", "l2", "d", "dt", "dur", "arr", "obj", "nul", "pipe"],
    rows,
    {renderNullAs: "n/a"},
  );
  assert.equal(
    out,
    "| l | l2 | d | dt | dur | arr | obj | nul | pipe |\n" +
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n" +
      // note: the `|` inside the wikilink is escaped too (escapeTable runs on the final cell text).
      "| [[notes/x.md\\|X]] | [[notes/y.md]] | 2024-01-15 | 2024-01-15 14:30 | 1h 30m | 1, 2 | k: v | n/a | a\\|b |\n",
  );
  // Link with a real markdown() method defers to it.
  assert.ok(markdownTable(["l"], [[{path: "p", embed: false, markdown: () => "[[p|M]]"}]]).includes("| [[p\\|M]] |"));
  // default renderNullAs
  assert.ok(markdownTable(["n"], [[null]]).includes("| - |"));
});

test("markdownList: bullets, nested arrays indented two spaces, objects, null", () => {
  assert.equal(markdownList([1, 2]), "- 1\n- 2\n");
  assert.equal(markdownList([1, [2, 3]]), "- 1\n  - 2\n  - 3\n");
  assert.equal(markdownList([{a: 1}]), "- a: 1\n");
  assert.equal(markdownList([null]), "- -\n");
  assert.equal(markdownList([null], {renderNullAs: "n/a"}), "- n/a\n");
  assert.equal(markdownList([{k: [1, 2]}]), "- k:\n  - 1\n  - 2\n");
  assert.equal(markdownList([]), "");
});

test("markdownTaskList: checkbox state, visual precedence, 4-space nesting, subtasks fallback", () => {
  // upstream `visual` is a display override WITHOUT the checkbox (the `[status]` prefix is added here).
  const tree = {
    task: true,
    status: "x",
    text: "Done",
    visual: "Done!",
    children: [
      {task: true, status: "", text: "sub", visual: "sub!", children: []},
      {task: false, status: "", text: "plain", visual: "plain", children: []},
    ],
  };
  assert.equal(markdownTaskList(tree), "- [x] Done!\n    - [ ] sub!\n    - plain\n");
  assert.equal(markdownTaskList([tree]), "- [x] Done!\n    - [ ] sub!\n    - plain\n");
  // visual ?? text (falls back when visual is missing)
  assert.equal(markdownTaskList({task: true, status: " ", text: "from-text"}), "- [ ] from-text\n");
  // status used verbatim; multi-line text folded
  assert.equal(markdownTaskList({task: true, status: "X", text: "a\nb", visual: "a\nb"}), "- [X] a b\n");
  // legacy `subtasks` fallback
  assert.equal(
    markdownTaskList({task: true, status: "", text: "p", subtasks: [{task: true, status: "x", text: "c"}]}),
    "- [ ] p\n    - [x] c\n",
  );
  // empty input
  assert.equal(markdownTaskList([]), "");
});

// ── block-level markdown reuse (dv.markdown / dv.el on block tags) ─────────

test("markdown op uses the BLOCK renderer (fences/tables render, not escaped)", () => {
  const calls = [];
  const html = renderOpsToHtml([{kind: "markdown", text: "# T\n\n- a"}], {
    basePath: "a.md",
    renderInline: (m) => `INLINE(${m})`,
    renderMarkdownBlock: (m) => {
      calls.push(m);
      return `<h1>T</h1>`;
    },
  });
  assert.deepEqual(calls, ["# T\n\n- a"], "block renderer must receive the raw text");
  assert.ok(html.includes("<h1>T</h1>"), html);
  assert.ok(!html.includes("INLINE("), html);
});

test("dv.el: inline tags use the inline renderer, block tags use the block renderer", () => {
  const opts = {
    basePath: "a.md",
    renderInline: (m) => `I{${m}}`,
    renderMarkdownBlock: (m) => `B{${m}}`,
  };
  const html = renderOpsToHtml(
    [
      {kind: "el", tag: "b", text: "**x**"},
      {kind: "el", tag: "SPAN", text: "**x**"},
      {kind: "el", tag: "div", text: "- item"},
    ],
    opts,
  );
  assert.ok(html.includes("<b>I{**x**}</b>"), html);
  assert.ok(html.includes("<SPAN>I{**x**}</SPAN>"), html);
  assert.ok(html.includes("<div>B{- item}</div>"), html);
});

test("without a block renderer both paths fall back to inline/escape (no host needed)", () => {
  const noHost = renderOpsToHtml([{kind: "markdown", text: "<b>"}, {kind: "el", tag: "div", text: "<b>"}], {
    basePath: "a.md",
  });
  assert.ok(noHost.includes("&lt;b&gt;"), noHost);
  const inlineOnly = renderOpsToHtml([{kind: "el", tag: "div", text: "x"}], {
    basePath: "a.md",
    renderInline: (m) => `I{${m}}`,
  });
  assert.ok(inlineOnly.includes("<div>I{x}</div>"), inlineOnly);
});
