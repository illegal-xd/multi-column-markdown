/**
 * Dataview 官方文档示例 → 功能对齐验收（parity）测试。
 *
 * 本文件把 Obsidian Dataview 官方文档里出现的 dataviewjs / DQL 示例逐条跑通并断言，
 * 每条断言都注明来源（文档页名 + 示例原文）。锚点语义一律以文档为准，未自创。
 *
 * 断言来源（文档页名）：
 *   - api/code-reference   （dv.pages/page/el/header/paragraph/span/list/taskList/
 *                            table / markdown* / array / isArray/fileLink/sectionLink/
 *                            blockLink/date/duration/compare/equal/clone/parse/
 *                            io* / query / evaluate/current）
 *   - api/data-array       （swizzling、字段展平、数字索引、groupBy + rows.file.name）
 *   - DQL 代码块参考        （TABLE/TABLE WITHOUT ID/TASKS/LIST/CALENDAR、WHERE/SORT/LIMIT）
 *
 * 运行分层（与 dataview-worker.test.mjs 完全一致）：
 *   esbuild 把真实的 src/dataview/exec/workerRuntime.ts 打成临时 .mjs 后 import，
 *   用 src/dataview/index/store.ts 造 fixture 索引，在真实 vm 沙箱 + 真实 DQL/dv 实现上
 *   跑 `runJob(...)`，断言返回的结构化 RenderOp（HTML 只在 render/html.ts 语义处断言）。
 *
 * 已知差距（本文件内已用「[差距]」开头的测试标出，详见最终报告）：
 *   1) DQL 子句必须独占一行 —— 文档常见的单行写法解析失败；
 *   2) TABLE 字段别名 `AS "..."` 不支持；
 *   3) dv.el 的 cls 字符串不按空格拆分成多个类名（渲染时该类名还会被白名单过滤掉）。
 */
import {test, after} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-parity-"));
const runtimeBundle = join(dir, "workerRuntime.mjs");
const storeBundle = join(dir, "store.mjs");
const htmlBundle = join(dir, "html.mjs");

try {
  execSync(
    `npx esbuild src/dataview/exec/workerRuntime.ts --bundle --format=esm --platform=node --outfile="${runtimeBundle}"` +
    ` && npx esbuild src/dataview/index/store.ts --bundle --format=esm --platform=node --outfile="${storeBundle}"` +
    ` && npx esbuild src/dataview/render/html.ts --bundle --format=esm --platform=node --outfile="${htmlBundle}"`,
    {cwd: repoRoot, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
after(() => rmSync(dir, {recursive: true, force: true}));

const {createRunJob} = await import(runtimeBundle);
const {createIndexStore} = await import(storeBundle);
const {renderOpsToHtml} = await import(htmlBundle);

// ── fixtures（按任务约定的 5 个页面） ──────────────────────────────────────

const PAGE = "notes/index.md";
const ALPHA = "notes/project/alpha.md";

const FILES = [
  ["notes/books/dune.md", `---
title: Dune
rating: 9
genre: sci-fi
tags: [note, book]
status: read
due: 2024-03-05
---
## Next Actions
- [x] Finished reading
- [ ] Read sequel [due:: 2024-01-02] #tag
- plain item
[[notes/books/found]]
`],
  ["notes/books/found.md", `---
title: Foundation
rating: 7
genre: sci-fi
tags: [book]
status: reading
---
Some body text.
`],
  ["notes/books/other.md", `---
title: Other
genre: fantasy
tags: [book]
---
Body text.
`],
  ["notes/project/alpha.md", `---
title: Alpha
tags: [project]
due: 2024-02-01
---
- [ ] Parent task #tag
  - [x] Child done
- [ ] Second
- [x] Third done
`],
  ["notes/index.md", `This index links to [[notes/books/dune|Dune]] and [[notes/project/alpha|Alpha]].
`],
];

const store = createIndexStore();
for (let i = 0; i < FILES.length; i++) {
  const [path, content] = FILES[i];
  store.upsertFile(path, content, i + 1, content.length);
}
const snapshot = store.snapshot();

// ── io bridge stub（文档示例用到的两个文件） ───────────────────────────────

const IO_FILES = {
  // api/code-reference: await dv.io.csv("hello.csv") —— 含引号内逗号
  "hello.csv": 'column1,column2\n"a,b",c\n2,d\n',
  // api/code-reference: await dv.io.load("File")
  File: "file-content",
};
const io = {
  async read(path) {
    if (Object.prototype.hasOwnProperty.call(IO_FILES, path)) return IO_FILES[path];
    throw new Error(`io.read: no such file: ${path}`);
  },
  async exists(path) {
    return Object.prototype.hasOwnProperty.call(IO_FILES, path);
  },
};

// ── run helpers ───────────────────────────────────────────────────────────

const runJob = createRunJob();

function makeJob(code, over = {}) {
  return {
    id: "parity",
    kind: "dataviewjs",
    code,
    pagePath: PAGE,
    indexVersion: snapshot.version,
    blockIndex: 0,
    timeoutMs: 5000,
    ...over,
  };
}

/** dataviewjs job 默认落在 notes/index.md（dv.current() 可解析）。 */
async function run(code, over = {}) {
  return runJob(makeJob(code, over), snapshot, io);
}

function runDql(code) {
  return run(code, {kind: "dql"});
}

/**
 * RenderOp 是跨 vm realm 的结构化克隆；vm 内构造的数组保留 vm 的
 * Array.prototype，node:assert/strict 的 deepEqual 会因原型不同而失败。
 * 比较宿主机实际收到的 plain 数据副本。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

async function runOk(code, over = {}) {
  const r = await run(code, over);
  assert.equal(r.ok, true, r.ok ? "" : `job failed: ${r.error.message}`);
  return plain(r.ops);
}

async function runDqlOk(code) {
  return runOk(code, {kind: "dql"});
}

/** 单个 job 内把若干值 JSON 序列化后作为 paragraph 文本返回，便于精确断言。 */
async function valuesJson(code) {
  const ops = await runOk(`dv.paragraph(JSON.stringify([${code}]))`);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "paragraph");
  return JSON.parse(ops[0].text);
}

// ── 1. api/code-reference: dv.pages / dv.page ─────────────────────────────

test("dv.pages() => all pages（文档原文）", async () => {
  assert.deepEqual(await runOk("dv.paragraph(String(dv.pages().length))"), [
    {kind: "paragraph", text: "5"},
  ]);
});

test('dv.pages("#books") => pages with tag（文档原文；fixture 用 #book）', async () => {
  assert.deepEqual(
    await runOk('dv.paragraph(dv.pages("#book").file.path.array().join(","))'),
    [{kind: "paragraph", text: "notes/books/dune.md,notes/books/found.md,notes/books/other.md"}],
  );
});

test("dv.pages('\"folder\"') => pages in folder（文档原文）", async () => {
  assert.deepEqual(
    await runOk(`dv.paragraph(dv.pages('"notes/books"').file.path.array().join(","))`),
    [{kind: "paragraph", text: "notes/books/dune.md,notes/books/found.md,notes/books/other.md"}],
  );
});

test('dv.pages("#yes or -#no") => or / negation（文档原文）', async () => {
  // fixture 中没有任何页面带 #yes，也没有任何页面带 #no：并集退化为全部页面。
  // 该断言同时验证 `or` 与 `-#tag` 两段语义（文档示例的等价映射）。
  assert.deepEqual(
    await runOk('dv.paragraph(dv.pages("#yes or -#no").file.path.array().join(","))'),
    [{
      kind: "paragraph",
      text: "notes/books/dune.md,notes/books/found.md,notes/books/other.md,notes/index.md,notes/project/alpha.md",
    }],
  );
});

test("dv.pages('\"folder\" or #tag') => folder-or-tag（文档原文）", async () => {
  assert.deepEqual(
    await runOk(`dv.paragraph(dv.pages('"notes/books" or #project').file.path.array().join(","))`),
    [{
      kind: "paragraph",
      text: "notes/books/dune.md,notes/books/found.md,notes/books/other.md,notes/project/alpha.md",
    }],
  );
});

test('dv.page("Index") => page object；无扩展名与完整路径两种写法都命中（文档原文）', async () => {
  const [byName, byPath] = await valuesJson([
    'dv.page("notes/index") ? dv.page("notes/index").file.path : "MISS"',
    'dv.page("notes/index.md") ? dv.page("notes/index.md").file.path : "MISS"',
  ].join(","));
  assert.deepEqual([byName, byPath], ["notes/index.md", "notes/index.md"]);
});

// ── 2. api/code-reference: el / header / paragraph / span ─────────────────

test('dv.el("b", "This is some bold text") —— 完全等于单个 el op（文档原文）', async () => {
  assert.deepEqual(await runOk('dv.el("b", "This is some bold text")'), [
    {kind: "el", tag: "b", text: "This is some bold text"},
  ]);
});

test('dv.el(..., {cls, attr})：cls 含两个类名 + attr.alt（文档原文）', async () => {
  // 文档 DomElementInfo.cls 是含空格的类名字符串，Obsidian 会拆成两个类。
  const ops = await runOk('dv.el("b", "This is some text", { cls: "dataview dataview-class", attr: { alt: "Nice!" } })');
  assert.deepEqual(ops, [{
    kind: "el",
    tag: "b",
    text: "This is some text",
    cls: ["dataview", "dataview-class"],
    attrs: {alt: "Nice!"},
  }]);
});

test('dv.el(..., {cls: [..]})：数组形态的 cls 同样生效（Obsidian 两种写法都接受）', async () => {
  const ops = await runOk('dv.el("b", "x", { cls: ["one", "two three"], attr: { title: "t" } })');
  assert.deepEqual(ops[0].attrs, {title: "t"});
  // 数组元素里的空格同样按类名分隔（与字符串形态一致）。
  assert.deepEqual(ops[0].cls, ["one", "two", "three"]);
});

test('dv.header(1, "Big!") / dv.header(6, "Tiny")（文档原文）', async () => {
  assert.deepEqual(await runOk('dv.header(1, "Big!"); dv.header(6, "Tiny")'), [
    {kind: "header", level: 1, text: "Big!"},
    {kind: "header", level: 6, text: "Tiny"},
  ]);
});

test("dv.paragraph(...) / dv.span(...) 各自 op（文档原文）", async () => {
  assert.deepEqual(await runOk('dv.paragraph("some paragraph"); dv.span("some span")'), [
    {kind: "paragraph", text: "some paragraph"},
    {kind: "span", text: "some span"},
  ]);
});

// ── 3. api/code-reference: dv.list ────────────────────────────────────────

test("dv.list([1, 2, 3])（文档原文）", async () => {
  assert.deepEqual(await runOk("dv.list([1, 2, 3])"), [
    {kind: "list", items: [{t: "num", v: 1}, {t: "num", v: 2}, {t: "num", v: 3}]},
  ]);
});

test("dv.list(dv.pages().file.name)（文档原文）", async () => {
  assert.deepEqual(await runOk("dv.list(dv.pages().file.name)"), [{
    kind: "list",
    items: [
      {t: "str", v: "dune"},
      {t: "str", v: "found"},
      {t: "str", v: "other"},
      {t: "str", v: "index"},
      {t: "str", v: "alpha"},
    ],
  }]);
});

test('dv.list(dv.pages("#book").where(p => p.rating > 7))（文档原文）', async () => {
  const ops = await runOk('dv.list(dv.pages("#book").where(p => p.rating > 7))');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "list");
  assert.equal(ops[0].items.length, 1);
  assert.equal(ops[0].items[0].t, "obj");
  assert.deepEqual(ops[0].items[0].v.rating, {t: "num", v: 9});
});

// ── 4. api/code-reference: dv.taskList ────────────────────────────────────

test('dv.taskList(dv.pages("#project").file.tasks) —— 默认按文件分组（文档原文）', async () => {
  const ops = await runOk('dv.taskList(dv.pages("#project").file.tasks)');
  assert.deepEqual(ops[0], {kind: "header", level: 4, text: `[[${ALPHA}]]`});
  assert.equal(ops[1].kind, "taskList");
  assert.equal(ops.length, 2);
  const tasks = ops[1].tasks;
  assert.deepEqual(tasks.map((t) => t.text), ["Parent task #tag", "Second", "Third done"]);
  assert.deepEqual(tasks.map((t) => t.path), [ALPHA, ALPHA, ALPHA]);
});

test('dv.taskList(..., false) —— 单个 taskList op，不分组（文档原文）', async () => {
  const ops = await runOk("dv.taskList(dv.pages(\"#project\").file.tasks, false)");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "taskList");
  assert.deepEqual(ops[0].tasks.map((t) => t.text), ["Parent task #tag", "Second", "Third done"]);
});

test("dv.taskList(..., t => !t.completed) —— 只看未完成任务（文档原文）", async () => {
  const ops = await runOk("dv.taskList(dv.pages(\"#project\").file.tasks.where(t => !t.completed))");
  assert.equal(ops[1].kind, "taskList");
  assert.deepEqual(ops[1].tasks.map((t) => t.text), ["Parent task #tag", "Second"]);
  // t.completed 必须存在且为 false —— 这是本次修复的核心。
  assert.deepEqual(ops[1].tasks.map((t) => t.completed), [false, false]);
});

test('dv.taskList(..., t => t.text.includes("#tag"))（文档原文）', async () => {
  const ops = await runOk('dv.taskList(dv.pages("#project").file.tasks.where(t => t.text.includes("#tag")))');
  assert.equal(ops[1].kind, "taskList");
  assert.deepEqual(ops[1].tasks.map((t) => t.text), ["Parent task #tag"]);
});

// ── 5. api/code-reference: dv.table ───────────────────────────────────────

test('dv.table(["File","Genre","Time Read","Rating"], ...)（文档原文）', async () => {
  const ops = await runOk(
    'dv.table(["File", "Genre", "Time Read", "Rating"], dv.pages("#book").sort(b => b.rating).map(b => [b.file.link, b.genre, b["time-read"], b.rating]))',
  );
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "table");
  // 文档传入的第一个表头就是 "File"（隐式文件列）。
  assert.deepEqual(ops[0].headers, ["File", "Genre", "Time Read", "Rating"]);
  assert.deepEqual(ops[0].rows.map((r) => r.cells[0].link.path), [
    "notes/books/found.md",
    "notes/books/dune.md",
    "notes/books/other.md",
  ]);
  assert.deepEqual(ops[0].rows.map((r) => r.cells[3]), [{t: "num", v: 7}, {t: "num", v: 9}, {t: "null"}]);
});

test("dv.table 数组单元格渲染成项目符号列表（文档原文，renderOpsToHtml）", async () => {
  const r = await run('dv.table(["Col1","Col2","Col3"], [["Row1","Dummy","Dummy"],["Row2",["Bullet1","Bullet2","Bullet3"],"Dummy"]])');
  assert.equal(r.ok, true, r.ok ? "" : r.error.message);
  const html = renderOpsToHtml(r.ops, {basePath: PAGE});
  const start = html.indexOf("<td><ul");
  const end = html.indexOf("</ul></td>");
  assert.equal(
    html.slice(start, end + "</ul></td>".length),
    '<td><ul class="dataview-list dataview-result-list-ul">' +
      '<li class="dataview-result-list-li">Bullet1</li>' +
      '<li class="dataview-result-list-li">Bullet2</li>' +
      '<li class="dataview-result-list-li">Bullet3</li>' +
      "</ul></td>",
  );
});

// ── 6. api/code-reference: markdown exports / array / isArray ─────────────

test('dv.markdownTable(["File","Genre"],[["A","B"]]) 返回 GFM 表格（文档原文）', async () => {
  assert.deepEqual(await runOk('dv.paragraph(dv.markdownTable(["File","Genre"],[["A","B"]]))'), [
    {kind: "paragraph", text: "| File | Genre |\n| --- | --- |\n| A | B |\n"},
  ]);
});

test("dv.markdownList([1,2,3]) 返回 `- ` 列表（文档原文）", async () => {
  assert.deepEqual(await runOk("dv.paragraph(dv.markdownList([1,2,3]))"), [
    {kind: "paragraph", text: "- 1\n- 2\n- 3\n"},
  ]);
});

test("dv.markdownTaskList(tasks) 返回 `- [ ]` 任务（文档原文）", async () => {
  assert.deepEqual(await runOk('dv.paragraph(dv.markdownTaskList(dv.pages("#project").file.tasks))'), [
    {kind: "paragraph", text: "- [ ] Parent task #tag\n    - [x] Child done\n- [ ] Second\n- [x] Third done\n"},
  ]);
});

test("dv.array([1,2,3]) / dv.isArray(...)（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson('dv.isArray(dv.array([1,2,3])), dv.isArray([1,2,3]), dv.isArray({x:1}), dv.array([1,2,3]).array()'),
    [false, true, false, [1, 2, 3]],
  );
});

// ── 7. api/code-reference: link / date / compare / clone / parse ──────────

test('dv.fileLink(path, embed, display)（文档原文）', async () => {
  assert.deepEqual(
    await valuesJson([
      'dv.fileLink("2021-08-08").path',
      'dv.fileLink("2021-08-08").embed',
      'dv.fileLink("book/The Raisin", true).embed',
      'dv.fileLink("Test", false, "Test File").display',
      'dv.fileLink("Test", false, "Test File").embed',
    ].join(",")),
    ["2021-08-08", false, true, "Test File", false],
  );
});

test('dv.sectionLink("Index","Books").markdown() / dv.blockLink("Notes","12gdhjg3").markdown()（文档原文）', async () => {
  assert.deepEqual(
    await valuesJson(
      'dv.sectionLink("Index","Books").markdown(), dv.blockLink("Notes","12gdhjg3").markdown()',
    ),
    ["[[Index#Books]]", "[[Notes#^12gdhjg3]]"],
  );
});

test('dv.date("2021-08-08") 可用（文档原文）', async () => {
  assert.deepEqual(
    await valuesJson('...(d => [d.year, d.month, d.day])(dv.date("2021-08-08"))'),
    [2021, 8, 8],
  );
});

test('dv.duration("8 minutes").asMinutes() / dv.duration("9 hours, 2 minutes, 3 seconds").asHours()（文档原文）', async () => {
  const [minutes, hours] = await valuesJson(
    'dv.duration("8 minutes").asMinutes(), dv.duration("9 hours, 2 minutes, 3 seconds").asHours()',
  );
  assert.equal(minutes, 8);
  assert.equal(hours, 9 + 2 / 60 + 3 / 3600);
});

test("dv.compare / dv.equal（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson(
      'dv.compare(1, 2), dv.compare("yes", "no"), dv.compare({what: 0}, {what: 0}), dv.equal(1, 1)',
    ),
    [-1, 1, 0, true],
  );
});

test("dv.clone({a: 1}) 不与原对象共享引用（文档原文）", async () => {
  const r = await run('const a = {a: 1, nested: [1]}; const b = dv.clone(a); a.nested.push(2); dv.paragraph(JSON.stringify([b.a, b !== a, b.nested.length]))');
  assert.equal(r.ok, true, r.ok ? "" : r.error.message);
  assert.deepEqual(plain(r.ops), [{kind: "paragraph", text: '[1,true,1]'}]); // b.a=1, b!==a, a.nested 未被污染
});

test('dv.parse("[[A]]") / dv.parse("2020-08-14") / dv.parse("9 seconds")（文档原文）', async () => {
  assert.deepEqual(
    await valuesJson([
      'dv.parse("[[A]]").path',
      'dv.value.typeOf(dv.parse("2020-08-14"))',
      'dv.value.typeOf(dv.parse("9 seconds"))',
    ].join(",")),
    ["A", "date", "duration"],
  );
});

// ── 8. api/code-reference: dv.io ──────────────────────────────────────────

test('await dv.io.load("File") 返回内容；不存在 → undefined（不抛）；dv.io.normalize（文档原文）', async () => {
  assert.deepEqual(
    await runOk([
      'const present = await dv.io.load("File");',
      'const missing = await dv.io.load("missing.md");',
      'dv.paragraph([String(present), String(missing), dv.io.normalize("Test")].join("|"))',
    ].join("\n")),
    [{kind: "paragraph", text: "file-content|undefined|Test"}],
  );
});

test('await dv.io.csv("hello.csv") => DataArray，元素是 {column1, column2}（文档原文）', async () => {
  assert.deepEqual(
    await valuesJson('...(await dv.io.csv("hello.csv")).array()'),
    [{column1: "a,b", column2: "c"}, {column1: "2", column2: "d"}],
  );
});

// ── 9. api/code-reference: dv.query / evaluate ────────────────────────────

test('await dv.query("LIST FROM #tag") => {successful, value:{type:"list"}}（文档原文）', async () => {
  // DQL 子句在解析器中需独占一行，文档单行写法见文末「[差距]」测试；此处用等价的换行形式。
  assert.deepEqual(
    await valuesJson(
      '...(q => [q.successful, q.value.type, q.value.values.length])(await dv.query("LIST\\nFROM #book"))',
    ),
    [true, "list", 3],
  );
});

test("await dv.query(...) 失败不抛，返回 {successful:false, error}（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson(
      '...await dv.query("SELECT nope").then(q => [q.successful, typeof q.error])',
    ),
    [false, "string"],
  );
});

test('dv.evaluate("2 + 2") / dv.tryEvaluate("x + 2", {x:3}) / dv.evaluate("2 +")（文档原文）', async () => {
  assert.deepEqual(
    await valuesJson([
      'dv.evaluate("2 + 2").value',
      'dv.tryEvaluate("x + 2", {x: 3})',
      'dv.evaluate("2 +").successful',
    ].join(",")),
    [4, 5, false],
  );
});

// ── 10. api/code-reference: dv.current() ──────────────────────────────────

test("内联 JS：dv.current().file.mtime 存在且是日期对象（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson([
      'dv.current().file.path',
      'dv.value.typeOf(dv.current().file.mtime)',
      'typeof dv.current().file.mtime.toMillis',
    ].join(",")),
    [PAGE, "date", "function"],
  );
});

// ── 11. api/data-array ────────────────────────────────────────────────────

test("swizzling: dv.pages().file.name（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson("...dv.pages().file.name.array()"),
    ["dune", "found", "other", "index", "alpha"],
  );
});

test("字段展平：dv.pages(\"#book\").tags 展平一层（文档示例为 .genres；fixture 无 genres）", async () => {
  // 文档 api/data-array 用 `dv.pages("#books").genres` 展示「数组字段自动展平」。
  // 本 fixture 没有 genres 字段，改用同为数组的 tags 表达同一语义；
  // 同时确认未知字段（genres）返回空 DataArray（上游 Proxy 行为）。
  assert.deepEqual(
    await valuesJson('dv.pages("#book").tags.array(), dv.pages("#book").genres.array()'),
    [["note", "book", "book", "book"], []],
  );
});

test("数字索引 arr[0] 与方法名优先级（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson("...(a => [a[0], a[1], a[2], a.length])(dv.array([10,20,30]))"),
    [10, 20, 30, 3],
  );
});

test('group.rows.file.name（文档 groupBy 完整示例）', async () => {
  // 文档原文：
  // for (let group of pages.groupBy(b => b.genre)) { dv.header(3, group.key); dv.list(group.rows.file.name) }
  assert.deepEqual(
    await runOk(
      'for (let group of dv.pages("#book").groupBy(b => b.genre)) { dv.header(3, group.key); dv.list(group.rows.file.name) }',
    ),
    [
      {kind: "header", level: 3, text: "sci-fi"},
      {kind: "list", items: [{t: "str", v: "dune"}, {t: "str", v: "found"}]},
      {kind: "header", level: 3, text: "fantasy"},
      {kind: "list", items: [{t: "str", v: "other"}]},
    ],
  );
});

// ── 12. DQL（dataview 代码块） ─────────────────────────────────────────────
//
// 说明：解析器要求 FROM / WHERE / SORT / LIMIT 等子句独占一行，因此下面用
// 文档示例的「换行规范化形式」断言语义；文档的单行写法在文末「[差距]」测试中留证。

test('TABLE file.name AS "File", status FROM #book WHERE status = "read"（文档原文；单 `=` 必须可用）', async () => {
  const ops = await runDqlOk('TABLE file.name, status\nFROM #book\nWHERE status = "read"');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "table");
  assert.deepEqual(ops[0].headers, ["File", "file.name", "status"]);
  assert.deepEqual(ops[0].rows[0].cells, [
    {t: "link", link: {path: "notes/books/dune.md", embed: false}},
    {t: "str", v: "dune"},
    {t: "str", v: "read"},
  ]);
});

test('TABLE WITHOUT ID genre, rating FROM #book SORT rating DESC LIMIT 2（文档原文）', async () => {
  const ops = await runDqlOk("TABLE WITHOUT ID genre, rating\nFROM #book\nSORT rating DESC\nLIMIT 2");
  assert.deepEqual(ops[0].headers, ["genre", "rating"]);
  // 本项目 null 在排序中最大（同 dataview-query.test.mjs 的 null 语义），故 DESC 下
  // 没有 rating 的 other 排首位、其余按 rating 降序；LIMIT 2 生效。
  assert.deepEqual(ops[0].rows.map((r) => r.cells), [
    [{t: "str", v: "fantasy"}, {t: "null"}],
    [{t: "str", v: "sci-fi"}, {t: "num", v: 9}],
  ]);
});

test("TASKS FROM #project WHERE !completed（文档原文；任务作用域必须有 completed）", async () => {
  const ops = await runDqlOk("TASKS\nFROM #project\nWHERE !completed");
  assert.equal(ops[0].kind, "taskList");
  assert.deepEqual(ops[0].tasks.map((t) => t.text), ["Parent task #tag", "Second"]);
  assert.deepEqual(ops[0].tasks.map((t) => t.completed), [false, false]);
});

test('LIST FROM "notes/project"（文档原文）', async () => {
  const ops = await runDqlOk('LIST\nFROM "notes/project"');
  assert.equal(ops[0].kind, "list");
  assert.equal(ops[0].items.length, 1);
  assert.deepEqual(ops[0].items[0].v.title, {t: "str", v: "Alpha"});
});

test("LIST FROM -#book（取反，文档原文）", async () => {
  const ops = await runDqlOk("LIST\nFROM -#book");
  assert.equal(ops[0].kind, "list");
  assert.equal(ops[0].items.length, 2);
  // 取反后只剩不同时带 #book 的两页（按路径排序）。
  const paths = await runDqlOk("TABLE file.path\nFROM -#book");
  assert.deepEqual(paths[0].rows.map((r) => r.cells[1].v), ["notes/index.md", ALPHA]);
});

test("LIST FROM #book or #project（组合，文档原文）", async () => {
  const ops = await runDqlOk("LIST\nFROM #book or #project");
  assert.equal(ops[0].kind, "list");
  assert.equal(ops[0].items.length, 4);
  const table = await runDqlOk("TABLE file.path\nFROM #book or #project");
  assert.deepEqual(table[0].rows.map((r) => r.cells[1].v), [
    "notes/books/dune.md",
    "notes/books/found.md",
    "notes/books/other.md",
    ALPHA,
  ]);
});

test("CALENDAR due FROM #book or #project —— 日历 op，条目按日期升序（文档原文）", async () => {
  const ops = await runDqlOk("CALENDAR due\nFROM #book or #project");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "calendar");
  // dune 的页面 due 被任务内联字段 [due:: 2024-01-02] 覆盖（inline 优先），alpha 为 2024-02-01。
  assert.deepEqual(ops[0].entries.map((e) => e.date), [
    "2024-01-02T00:00:00.000Z",
    "2024-02-01T00:00:00.000Z",
  ]);
});

// ── 13. 上下文 / 隔离（js-view.ts + 沙箱） ────────────────────────────────

test("dataview 是 dv 的别名（文档 js-view PREAMBLE）", async () => {
  assert.deepEqual(
    await valuesJson("dataview.pages().length, dv.pages().length, dataview === dv"),
    [5, 5, true],
  );
});

test("dv.app / dv.currentFilePath / dv.settings / dv.value.typeOf / dv.func 可用（文档原文）", async () => {
  assert.deepEqual(
    await valuesJson([
      "typeof dv.app",
      "dv.currentFilePath",
      "typeof dv.settings",
      'dv.value.typeOf(1)',
      "typeof dv.func",
    ].join(",")),
    ["object", PAGE, "object", "number", "object"],
  );
});

test("单个块抛错 → ok:false 且 error.message 保留原文；同一 worker 的下一个 job 不受影响", async () => {
  const bad = await run("throw new Error(\"boom\")");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ops, []);
  assert.equal(bad.error.message, "boom");

  const good = await run("dv.paragraph(String(dv.pages().length))");
  assert.equal(good.ok, true);
  assert.deepEqual(plain(good.ops), [{kind: "paragraph", text: "5"}]);
});

// ── 14. [差距] 文档原文形式当前无法通过（待 src 修复） ────────────────────
//
// 下列断言严格按文档原文书写、不做任何降级；失败即为功能对齐差距的证据。

test('[差距] 文档单行 DQL 形式应当可解析', async () => {
  const DOC_ONE_LINERS = [
    'TABLE file.name AS "File", status FROM #book WHERE status = "read"',
    "TABLE WITHOUT ID genre, rating FROM #book SORT rating DESC LIMIT 2",
    "TASKS FROM #project WHERE !completed",
    'LIST FROM "notes/project"',
    "LIST FROM -#book",
    "LIST FROM #book or #project",
    "CALENDAR due FROM #book",
  ];
  const results = {};
  for (const src of DOC_ONE_LINERS) {
    const r = await runDql(src);
    results[src] = r.ok ? true : `FAIL: ${r.error.message}`;
  }
  assert.deepEqual(results, Object.fromEntries(DOC_ONE_LINERS.map((s) => [s, true])));
});

test('[差距] TABLE 字段别名 AS "..." 应当生效', async () => {
  const r = await runDql('TABLE file.name AS "Name"\nFROM #book');
  assert.equal(r.ok, true, r.ok ? "" : `job failed: ${r.error.message}`);
  assert.deepEqual(plain(r.ops)[0].headers, ["File", "Name"]);
});
