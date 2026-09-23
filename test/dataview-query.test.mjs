/**
 * B2 tests — expression engine + DQL (parse & execute).
 * Pattern: esbuild bundle → node --test. All assertions pin concrete values.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-dql-"));
try {
  execSync(
    "npx esbuild src/dataview/query/index.ts --bundle --format=esm --outfile=" + join(dir, "query.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {evaluateExpression, parseDql, executeDql, ExpressionError, DqlError, DvFunctions} = await import(join(dir, "query.mjs"));

// ── helpers ────────────────────────────────────────────────────────────────

function ev(src, scope = {}) {
  return evaluateExpression(src, scope);
}

function makePage(n, extra = {}) {
  const path = `notes/p${String(n).padStart(2, "0")}.md`;
  const status = n % 2 === 0 ? "done" : "todo";
  const fields = {priority: n, status, group: "g" + (n % 3), ...(extra.fields ?? {})};
  return {
    path,
    name: `p${String(n).padStart(2, "0")}`,
    folder: "notes",
    ext: "md",
    ctime: 1700000000000,
    mtime: 1700000000000,
    size: 100,
    frontmatter: {},
    inlineFields: {},
    fields,
    tags: extra.tags ?? [],
    etags: extra.etags ?? extra.tags ?? [],
    aliases: [],
    headings: [],
    sections: [],
    lists: [],
    tasks: extra.tasks ?? [],
    inlinks: [],
    outlinks: [],
  };
}

const parentTask = {
  text: "parent task",
  status: "",
  line: 1,
  indent: 0,
  tags: [],
  fields: {},
  children: [{text: "child done", status: "x", line: 2, indent: 2, tags: [], fields: {}, children: []}],
};
const otherTask = {text: "other open", status: "", line: 4, indent: 0, tags: [], fields: {}, children: []};

const pages = [];
for (let n = 1; n <= 50; n++) {
  const extra = {};
  if (n === 1) {
    extra.fields = {items: [10, 20, 30]};
    extra.tags = ["#proj"];
  }
  if (n === 2) {
    extra.fields = {scalar: 7};
    extra.tags = ["#proj"];
  }
  if (n === 50) extra.tasks = [parentTask, otherTask];
  pages.push(makePage(n, extra));
}
pages.push({
  path: "target.md",
  name: "target",
  folder: "",
  ext: "md",
  ctime: 1700000000000,
  mtime: 1700000000000,
  size: 10,
  frontmatter: {},
  inlineFields: {},
  fields: {priority: 99, status: "todo", group: "gx"},
  tags: [],
  etags: [],
  aliases: [],
  headings: [],
  sections: [],
  lists: [],
  tasks: [],
  inlinks: [],
  outlinks: [],
});
const snapshot = {version: 1, pages, generatedAt: 0};

/**
 * Clause-mechanics helper. Every TABLE query carries an implicit leading "File"
 * id column upstream (and now here) unless `WITHOUT ID`; that column is asserted
 * separately in "TABLE carries an implicit File column unless WITHOUT ID", so
 * this helper strips it to keep the assertions below focused on the clause under
 * test. Use `runRaw` when the id column itself is the subject.
 */
function run(src, opts) {
  return runRaw(src, opts).map((op) => {
    if (op.kind !== "table" || op.headers[0] !== "File") return op;
    return {
      ...op,
      headers: op.headers.slice(1),
      rows: op.rows.map((r) => (r.group === undefined ? {...r, cells: r.cells.slice(1)} : r)),
    };
  });
}

function runRaw(src, opts) {
  return executeDql(parseDql(src), snapshot, opts);
}

// ── operator precedence & expression semantics ─────────────────────────────

test("precedence: * over +; parens override", () => {
  assert.equal(ev("1 + 2 * 3"), 7);
  assert.equal(ev("(1 + 2) * 3"), 9);
  assert.equal(ev("2 * -3"), -6);
  assert.equal(ev("10 % 4 - 1"), 1);
});

test("precedence: or < and < not < comparison", () => {
  assert.equal(ev("true or false and false"), true); // and binds tighter
  assert.equal(ev("not true == false"), true); // not applies to (true==false)
  assert.equal(ev("1 + 2 == 3 and 4 * 2 == 8"), true);
  assert.equal(ev("false or 1 < 2 and 3 <= 3"), true);
  assert.equal(ev("!(1 > 2)"), true);
});

test("null semantics: == null only vs null; null greatest in ordering", () => {
  assert.equal(ev("null == null"), true);
  assert.equal(ev("null == 1"), false);
  assert.equal(ev("1 == null"), false);
  assert.equal(ev("null != 1"), true);
  assert.equal(ev("1 < null"), true); // null sorts last (greatest)
  assert.equal(ev("null > 1"), true);
  assert.equal(ev("null < null"), false);
  assert.equal(ev("null <= null"), true);
});

test("undefined variable → null (Dataview-loose), literal undefined evaluates", () => {
  assert.equal(ev("missing_var"), null);
  assert.equal(ev("missing_var == null"), true);
  assert.equal(ev("undefined"), undefined);
});

test("undefined is not a supported operator (parse error, not hang)", () => {
  assert.throws(() => ev("x ?? null", {x: 1}), ExpressionError);
});

test("=~ matches by regex; invalid regex → ExpressionError with line/col", () => {
  assert.equal(ev('"hello" =~ "h.*o"'), true);
  assert.equal(ev('"hello" =~ "^x"'), false);
  assert.equal(ev('123 =~ "23"'), true);
  assert.equal(ev('title =~ "^A"', {title: "Alpha"}), true);
  try {
    ev('"a" =~ "("');
    assert.fail("expected ExpressionError");
  } catch (e) {
    assert.ok(e instanceof ExpressionError, "instanceof ExpressionError");
    assert.equal(e.line, 1);
    assert.equal(e.col, 5); // position of the =~ operator token
  }
});

test("string + concatenation; number + number stays numeric", () => {
  assert.equal(ev('"a" + "b"'), "ab");
  assert.equal(ev('"n=" + 42'), "n=42");
  assert.equal(ev("1 + 2"), 3);
  assert.equal(ev('1 + null'), null); // null propagates in arithmetic
  assert.equal(ev('"x" + null'), "x"); // null contributes empty text in concat
});

test("member access: dot, bracket, missing → null, prototype shielded", () => {
  assert.equal(ev("a.b.c", {a: {b: {c: 7}}}), 7);
  assert.equal(ev('a["b"]', {a: {b: 3}}), 3);
  assert.equal(ev('a["b"]["c"]', {a: {b: {c: "deep"}}}), "deep");
  assert.equal(ev("a.missing", {a: {b: 1}}), null);
  assert.equal(ev("toString", {}), null); // own-property walk only
  assert.equal(ev("a.constructor", {a: {}}), null);
  assert.equal(ev("标题", {标题: "题"}), "题"); // unicode identifiers
});

test("literals: array, object, strings with escapes, bool", () => {
  assert.deepEqual(ev('[1, "a", true, null]'), [1, "a", true, null]);
  const obj = ev('{key: 1, "k2": v}', {v: 2});
  assert.equal(obj.key, 1);
  assert.equal(obj.k2, 2);
  assert.equal(Object.getPrototypeOf(obj), null); // null-proto: no pollution
  assert.equal(ev('"a\\nb"'), "a\nb");
  assert.equal(ev("false"), false);
});

test("eval is iterative: long left-deep chains are unlimited", () => {
  let src = "1";
  for (let i = 2; i <= 100; i++) src += ` + ${i}`;
  assert.equal(ev(src), 5050); // 1+…+100
});

test("cyclic member chain hits depth cap (64) → ExpressionError, no stack crash", () => {
  const cyc = {v: 1};
  cyc.self = cyc;
  let src = "cyc";
  for (let i = 0; i < 70; i++) src += ".self";
  src += ".v";
  assert.throws(() => ev(src, {cyc}), ExpressionError);
  // depth within the cap still evaluates
  let ok = "cyc";
  for (let i = 0; i < 10; i++) ok += ".self";
  ok += ".v";
  assert.equal(ev(ok, {cyc}), 1);
});

test("and/or short-circuit: right side never evaluated when decided", () => {
  assert.equal(ev("false and nope()"), false); // nope() would throw "not a function"
  assert.equal(ev("true or nope()"), true);
  assert.equal(ev("true and 1 == 1"), true);
});

test("parse errors carry 1-based line/col", () => {
  try {
    ev("1 +\n(");
    assert.fail("expected ExpressionError");
  } catch (e) {
    assert.ok(e instanceof ExpressionError);
    assert.equal(e.line, 2);
    assert.equal(e.col, 2); // eof token after "("
    assert.equal(typeof e.col, "number");
  }
  assert.throws(() => ev('call1 + "'), ExpressionError); // unterminated string
});

// ── DvFunctions (≥40; 15+ exercised with concrete values) ──────────────────

test("DvFunctions table has ≥40 entries incl. the required set", () => {
  const required = [
    "default", "choice", "contains", "concat", "join", "unique", "sort", "string", "fixed",
    "lower", "upper", "replace", "regexreplace", "slice", "add", "sub", "mul", "div", "mod",
    "pow", "sqrt", "round", "floor", "ceil", "abs", "min", "max", "log", "exp", "date", "dur",
    "year", "month", "day", "weekday", "hour", "minute", "second", "now", "today", "link",
    "length", "object",
  ];
  assert.ok(Object.keys(DvFunctions).length >= 40, `got ${Object.keys(DvFunctions).length}`);
  for (const name of required) {
    assert.equal(typeof DvFunctions[name], "function", `missing ${name}`);
  }
});

test("functions: choice/default/contains/concat/join/unique", () => {
  assert.equal(ev('choice(1 > 0, "y", "n")'), "y");
  assert.equal(ev('choice(false, "y", "n")'), "n");
  assert.equal(ev("default(null, 5)"), 5);
  assert.equal(ev("default(3, 5)"), 3);
  assert.equal(ev('contains("hello", "ell")'), true);
  assert.equal(ev("contains([1, 2], 2)"), true);
  assert.equal(ev('contains({a: 1}, "a")'), true);
  assert.equal(ev("contains([1], 9)"), false);
  assert.deepEqual(ev("concat([1], [2, 3])"), [1, 2, 3]);
  assert.equal(ev('join(["a", "b"], "-")'), "a-b");
  assert.deepEqual(ev("unique([1, 1, 2, 2, 3])"), [1, 2, 3]);
});

test("functions: sort returns DataArray (asc, desc, keyed)", () => {
  const asc = ev("sort([3, 1, 2])");
  assert.deepEqual(asc.array(), [1, 2, 3]);
  const desc = ev('sort([3, 1, 2], null, "desc")');
  assert.deepEqual(desc.array(), [3, 2, 1]);
  const keyed = ev('sort([{n: 2}, {n: 1}], "n")');
  assert.deepEqual(keyed.array().map((x) => x.n), [1, 2]);
  assert.equal(ev("sort(5)"), null); // non-array → null
});

test("functions: string conversions — string/fixed/lower/upper/replace/regexreplace/slice", () => {
  assert.equal(ev("string(42)"), "42");
  assert.equal(ev("string(null)"), null);
  assert.equal(ev("fixed(3.14159, 2)"), "3.14");
  assert.equal(ev('lower("AbC")'), "abc");
  assert.equal(ev('upper("AbC")'), "ABC");
  assert.equal(ev('replace("hello", "l", "L")'), "heLlo"); // first occurrence (JS semantics)
  assert.equal(ev('regexreplace("hello", "l+", "L")'), "heLo"); // global by default
  assert.deepEqual(ev("slice([1, 2, 3, 4], 1, 3)"), [2, 3]);
  assert.equal(ev('slice("abcdef", 1, 4)'), "bcd");
});

test("functions: math — add/sub/mul/div/mod/pow/sqrt/round/floor/ceil/abs/min/max/log/exp", () => {
  assert.equal(ev("add(2, 3)"), 5);
  assert.equal(ev("sub(5, 2)"), 3);
  assert.equal(ev("mul(3, 4)"), 12);
  assert.equal(ev("div(10, 4)"), 2.5);
  assert.equal(ev("mod(7, 3)"), 1);
  assert.equal(ev("pow(2, 10)"), 1024);
  assert.equal(ev("sqrt(9)"), 3);
  assert.equal(ev("round(2.567, 1)"), 2.6);
  assert.equal(ev("floor(2.9)"), 2);
  assert.equal(ev("ceil(2.1)"), 3);
  assert.equal(ev("abs(-5)"), 5);
  assert.equal(ev("min(3, 1, 2)"), 1);
  assert.equal(ev("min([3, 1, 2])"), 1);
  assert.equal(ev("max(3, 1, 2)"), 3);
  assert.equal(ev("log(1)"), 0);
  assert.equal(ev("exp(0)"), 1);
  assert.equal(ev('add(null, 1)'), null);
});

test("functions: dates & durations — date/dur/accessors/now/today", () => {
  const d = ev('date("2024-03-15")');
  assert.equal(d.year, 2024);
  assert.equal(d.month, 3);
  assert.equal(d.day, 15);
  assert.equal(ev('year(date("2024-03-15"))'), 2024);
  assert.equal(ev('month(date("2024-03-15"))'), 3);
  assert.equal(ev('day(date("2024-03-15"))'), 15);
  assert.equal(ev('weekday(date("2024-03-15"))'), 5); // Friday, ISO Mon=1
  assert.equal(ev('hour(date("2024-03-15T10:30:45Z"))'), 10);
  assert.equal(ev('minute(date("2024-03-15T10:30:45Z"))'), 30);
  assert.equal(ev('second(date("2024-03-15T10:30:45Z"))'), 45);
  assert.equal(ev('dur("2h")').ms, 7200000);
  assert.equal(ev('dur("nope")'), null);
  const n = ev("now()");
  assert.equal(typeof n.year, "number");
  const t = ev("today()");
  assert.equal(t.hour, 0);
  assert.equal(t.minute, 0);
  assert.equal(ev('date("garbage")'), null);
});

test("functions: link/length/object", () => {
  const l = ev('link("a/b.md", "Disp")');
  assert.equal(l.path, "a/b.md");
  assert.equal(l.display, "Disp");
  assert.equal(l.embed, false);
  const emb = ev('link("x.md", undefined, true)');
  assert.equal(emb.embed, true);
  assert.equal(ev('length("abc")'), 3);
  assert.equal(ev("length([1, 2, 3])"), 3);
  assert.equal(ev("length(null)"), null);
  assert.deepEqual(ev('object("a", 1, "b", 2)'), {a: 1, b: 2});
  const cloned = ev("object(src)", {src: {k: "v"}});
  assert.equal(cloned.k, "v");
});

// ── DQL parsing ────────────────────────────────────────────────────────────

test("parse: full TABLE query — multiline field expr spans until first clause", () => {
  const q = parseDql([
    "table file.name, choice(true,",
    '  "y", "n")',
    "  from #proj",
    "  WHERE priority > 10",
    '    and status == "done"',
    "  Sort priority desc, file.name",
    "  GROUP BY status",
    "  flatten items",
    "  LIMIT 5",
  ].join("\n"));
  assert.equal(q.type, "table");
  assert.deepEqual(q.fields, [
    {name: "file.name", expr: "file.name"},
    {name: 'choice(true, "y", "n")', expr: 'choice(true,\n  "y", "n")'},
  ]);
  assert.equal(q.source, "#proj");
  assert.equal(q.limit, 5);
});

test("parse: TABLE header stops at first clause keyword; comma split is depth-aware", () => {
  const q = parseDql([
    "TABLE choice(true, false, 1), file.name",
    "FROM #proj",
    'WHERE priority > 10',
    '  and status == "done"',
    "SORT priority DESC, file.name",
    "GROUP BY status",
    "FLATTEN items, tags",
    "LIMIT 5",
  ].join("\n"));
  assert.equal(q.type, "table");
  assert.deepEqual(q.fields, [
    {name: "choice(true, false, 1)", expr: "choice(true, false, 1)"},
    {name: "file.name", expr: "file.name"},
  ]);
  assert.equal(q.source, "#proj");
  assert.ok(q.where.includes("and status"));
  assert.deepEqual(q.sort, [
    {expr: "priority", dir: "desc"},
    {expr: "file.name", dir: "asc"},
  ]);
  assert.equal(q.groupBy, "status");
  assert.deepEqual(q.flatten, ["items", "tags"]);
  assert.equal(q.limit, 5);
});

test("parse: LIST implicit (fields null) vs LIST with expr; TASKS has no fields", () => {
  const bare = parseDql("LIST");
  assert.equal(bare.type, "list");
  assert.equal(bare.fields, null);
  const withExpr = parseDql('LIST\nfile.name\nFROM #x');
  assert.deepEqual(withExpr.fields, [{name: "file.name", expr: "file.name"}]);
  assert.equal(withExpr.source, "#x");
  const tasks = parseDql("TASKS\nFROM #t");
  assert.equal(tasks.type, "tasks");
  assert.equal(tasks.fields, null);
  assert.equal(tasks.source, "#t");
});

test("parse errors: garbage input → DqlError (never hangs)", () => {
  const cases = [
    "",
    "GARBAGE",
    "TABLE",
    "table a\nSORT",
    "table a\nLIMIT abc",
    "table a\nWHERE (",
    "table a,\nFROM #x", // trailing empty field
    "TASKS\nfile.name", // TASKS must not take a field list
    "table a\nFROM\n@@@", // garbage after FROM
  ];
  for (const src of cases) {
    assert.throws(
      () => parseDql(src),
      (e) => e instanceof DqlError && typeof e.message === "string" && e.message.length > 0,
      `expected DqlError for ${JSON.stringify(src)}`,
    );
  }
});

test("parse: DqlError carries clause line when available", () => {
  try {
    parseDql("table a\nFROM\n@@@");
    assert.fail("expected DqlError");
  } catch (e) {
    assert.ok(e instanceof DqlError);
    assert.equal(e.line, 2); // FROM clause starts on line 2
  }
});

// ── execute: TABLE end-to-end on the 51-page snapshot ──────────────────────

test("TABLE + WHERE + SORT ASC: 25 done pages, exact cells", () => {
  const ops = run([
    "TABLE priority, status",
    'WHERE status == "done"',
    "SORT priority ASC",
  ].join("\n"));
  assert.equal(ops.length, 1);
  const t = ops[0];
  assert.equal(t.kind, "table");
  assert.deepEqual(t.headers, ["priority", "status"]);
  assert.equal(t.rows.length, 25);
  assert.deepEqual(t.rows[0].cells, [{t: "num", v: 2}, {t: "str", v: "done"}]);
  assert.deepEqual(t.rows[24].cells, [{t: "num", v: 50}, {t: "str", v: "done"}]);
});

test("SORT DESC + LIMIT truncates to top 3 (42 excluded target via WHERE)", () => {
  const ops = run([
    "TABLE priority",
    'WHERE status == "done"',
    "SORT priority DESC",
    "LIMIT 3",
  ].join("\n"));
  assert.deepEqual(ops[0].rows.map((r) => r.cells[0].v), [50, 48, 46]);
});

test("multiline WHERE with and-shorthand filters correctly", () => {
  const ops = run([
    "TABLE priority",
    "WHERE priority > 40",
    '  and status == "done"',
  ].join("\n"));
  assert.deepEqual(ops[0].rows.map((r) => r.cells[0].v), [42, 44, 46, 48, 50]);
});

test("GROUP BY: group placeholder rows (cells []) then members, Map order", () => {
  const ops = run([
    "TABLE priority",
    "WHERE priority <= 4",
    "GROUP BY status",
  ].join("\n"));
  const rows = ops[0].rows;
  assert.deepEqual(rows, [
    {group: {t: "str", v: "todo"}, cells: []},
    {cells: [{t: "num", v: 1}]},
    {cells: [{t: "num", v: 3}]},
    {group: {t: "str", v: "done"}, cells: []},
    {cells: [{t: "num", v: 2}]},
    {cells: [{t: "num", v: 4}]},
  ]);
});

test("LIMIT applies to final rows AFTER grouping (spec order step 6→7)", () => {
  const ops = run([
    "TABLE priority",
    "WHERE priority <= 4",
    "GROUP BY status",
    "LIMIT 4",
  ].join("\n"));
  const rows = ops[0].rows;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {group: {t: "str", v: "todo"}, cells: []});
  assert.deepEqual(rows[3], {group: {t: "str", v: "done"}, cells: []});
});

test("FLATTEN: one row per element, `this` rebound, page fields intact", () => {
  const list = run([
    "LIST this",
    'FROM "notes/p01"',
    "FLATTEN items",
  ].join("\n"))[0];
  assert.equal(list.kind, "list");
  assert.deepEqual(list.items, [{t: "num", v: 10}, {t: "num", v: 20}, {t: "num", v: 30}]);

  const tbl = run([
    "TABLE file.name, this",
    'FROM "notes/p01"',
    "FLATTEN items",
  ].join("\n"))[0];
  assert.equal(tbl.rows.length, 3);
  assert.deepEqual(tbl.rows[0].cells, [{t: "str", v: "p01"}, {t: "num", v: 10}]);
  assert.deepEqual(tbl.rows[2].cells, [{t: "str", v: "p01"}, {t: "num", v: 30}]);
});

test("FLATTEN of a non-array keeps the row unchanged", () => {
  const ops = run([
    "LIST scalar",
    'FROM "notes/p02"',
    "FLATTEN scalar",
  ].join("\n"));
  assert.deepEqual(ops[0].items, [{t: "num", v: 7}]); // exactly one row
});

test("FROM: exact file string, bare #tag (rewritten), [[link]] (rewritten), empty → all", () => {
  const byFile = run("TABLE priority\nFROM \"notes/p01\"");
  assert.deepEqual(byFile[0].rows.map((r) => r.cells[0].v), [1]);

  const byTag = run("TABLE priority\nFROM #proj");
  assert.deepEqual(byTag[0].rows.map((r) => r.cells[0].v), [1, 2]);

  const byLink = run("TABLE priority\nFROM [[target]]");
  assert.deepEqual(byLink[0].rows.map((r) => r.cells[0].v), [99]);

  const all = run("TABLE priority\nLIMIT 1");
  assert.deepEqual(all[0].rows.map((r) => r.cells[0].v), [1]); // no FROM → snapshot order
});

test("LIST implicit `this` renders page objects (file excluded by toCell)", () => {
  const ops = run("LIST\nLIMIT 2");
  assert.equal(ops[0].kind, "list");
  assert.equal(ops[0].items.length, 2);
  assert.equal(ops[0].items[0].t, "obj");
  assert.equal(ops[0].items[0].v.priority.v, 1);
  assert.equal(ops[0].items[0].v.file, undefined); // golden toCell drops heavy `file`
});

// ── execute: TASKS ─────────────────────────────────────────────────────────

test("TASKS: matching parent kept, non-matching child pruned, path/line attached", () => {
  const ops = run([
    "TASKS",
    'FROM "notes/p50"',
    'WHERE contains(text, "parent")',
  ].join("\n"));
  assert.equal(ops[0].kind, "taskList");
  const tasks = ops[0].tasks;
  assert.equal(tasks.length, 1); // "other open" filtered out
  assert.equal(tasks[0].text, "parent task");
  assert.equal(tasks[0].path, "notes/p50.md");
  assert.equal(tasks[0].line, 1);
  assert.equal(tasks[0].children.length, 0); // child "child done" evaluated & pruned
  // scope fields usable in WHERE:
  const scoped = run([
    "TASKS",
    'FROM "notes/p50"',
    'WHERE this.text == "other open" and path == "notes/p50.md" and line == 4',
  ].join("\n"));
  assert.deepEqual(scoped[0].tasks.map((t) => t.text), ["other open"]);
});

test("TASKS: all-match WHERE preserves the full subtree", () => {
  const ops = run([
    "TASKS",
    'FROM "notes/p50"',
    'WHERE status != "never"',
  ].join("\n"));
  assert.deepEqual(ops[0].tasks.map((t) => t.text), ["parent task", "other open"]);
  assert.equal(ops[0].tasks[0].children.length, 1);
  assert.equal(ops[0].tasks[0].children[0].text, "child done");
  assert.equal(ops[0].tasks[0].children[0].status, "x");
});

test("TASKS: failing parent drops entire subtree (child not hoisted)", () => {
  const ops = run([
    "TASKS",
    'FROM "notes/p50"',
    'WHERE status == "x"', // only the child matches — parent gate kills subtree
  ].join("\n"));
  assert.deepEqual(ops[0].tasks, []);
});

// ── execute: maxRows guard ─────────────────────────────────────────────────

test("maxRows truncates rows and appends warn notice AFTER the table op", () => {
  const ops = run("TABLE priority\nSORT priority ASC", {maxRows: 5});
  assert.equal(ops.length, 2);
  assert.equal(ops[0].kind, "table");
  assert.equal(ops[0].rows.length, 5);
  assert.deepEqual(ops[0].rows.map((r) => r.cells[0].v), [1, 2, 3, 4, 5]);
  assert.deepEqual(ops[1], {
    kind: "notice",
    level: "warn",
    message: "Row limit reached (5) — truncated",
  });
});

test("under maxRows → single op, no notice; default cap is 10000", () => {
  const ops = run("TABLE priority");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].rows.length, 51); // 50 notes + target.md
});

test("LIMIT interacts with maxRows: limit under cap → no notice", () => {
  const ops = run("TABLE priority\nLIMIT 3", {maxRows: 5});
  assert.equal(ops.length, 1);
  assert.equal(ops[0].rows.length, 3);
});

// ── error propagation ──────────────────────────────────────────────────────

test("runtime ExpressionError propagates from executeDql (invalid regex in WHERE)", () => {
  const q = parseDql("TABLE priority\nWHERE priority =~ \"(\""); // parses (regex checked at eval)
  assert.throws(() => executeDql(q, snapshot), ExpressionError);
});

test("non-function call → ExpressionError with position", () => {
  try {
    ev("1(2)");
    assert.fail("expected ExpressionError");
  } catch (e) {
    assert.ok(e instanceof ExpressionError);
    assert.equal(e.line, 1);
    assert.equal(e.col, 1);
  }
});

test("empty result still yields a well-formed table op", () => {
  const ops = run("TABLE priority\nWHERE priority > 10000");
  assert.deepEqual(ops, [{kind: "table", headers: ["priority"], rows: []}]);
});

// ── implicit id column (upstream TABLE semantics) ───────────────────────────
test("TABLE carries an implicit File column unless WITHOUT ID", () => {
  const withId = runRaw("TABLE priority\nWHERE status == \"done\"\nSORT priority ASC\nLIMIT 1");
  assert.equal(withId[0].kind, "table");
  assert.deepEqual(withId[0].headers, ["File", "priority"]);
  // The id cell is a link to the row's page (upstream `file.link`).
  assert.equal(withId[0].rows[0].cells[0].t, "link");
  assert.equal(withId[0].rows[0].cells[0].link.path, "notes/p02.md");

  const withoutId = runRaw("TABLE WITHOUT ID priority\nLIMIT 1");
  assert.deepEqual(withoutId[0].headers, ["priority"]);
  assert.equal(withoutId[0].rows[0].cells.length, 1);
});

test("LIST/TASKS are unaffected by WITHOUT ID handling", () => {
  const list = runRaw("LIST\nLIMIT 1");
  assert.equal(list[0].kind, "list");
  const tasks = runRaw("TASKS");
  assert.equal(tasks[0].kind, "taskList");
});
