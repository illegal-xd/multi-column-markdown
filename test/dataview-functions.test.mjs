/**
 * Dataview expression functions + lambda + vectorization tests.
 *
 * Every assertion below is taken from the upstream docs
 * (https://blacksmithgu.github.io/obsidian-dataview/reference/functions/ and
 * .../reference/expressions/) or, where the docs are internally inconsistent or
 * written for bare literals our grammar does not have, from the upstream source
 * (`src/expression/functions.ts`, `src/expression/parse.ts`).
 * Deviations are called out in comments and in the task report.
 *
 * Pattern: esbuild bundle → node --test.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-fn-"));
try {
  execSync(
    "npx esbuild src/dataview/query/index.ts --bundle --format=esm --outfile=" + join(dir, "query.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {evaluateExpression, ExpressionError, DvFunctions} = await import(join(dir, "query.mjs"));

function ev(src, scope = {}) {
  return evaluateExpression(src, scope);
}

// ══════════════════════════════════════════════════════════════════════════
// lambda — docs/reference/expressions + docs examples on map/filter/all/…
// ══════════════════════════════════════════════════════════════════════════

test("lambda: map/filter doc examples", () => {
  // docs: map([1, 2, 3], (x) => x + 2) = [3, 4, 5]
  assert.deepEqual(ev("map([1, 2, 3], (x) => x + 2)"), [3, 4, 5]);
  // docs: map(["yes", "no"], (x) => x + "?") = ["yes?", "no?"]
  assert.deepEqual(ev('map(["yes", "no"], (x) => x + "?")'), ["yes?", "no?"]);
  // docs: filter([1, 2, 3], (x) => x >= 2) = [2, 3]
  assert.deepEqual(ev("filter([1, 2, 3], (x) => x >= 2)"), [2, 3]);
  // docs: filter(["yes", "no", "yas"], (x) => startswith(x, "y")) = ["yes", "yas"]
  assert.deepEqual(ev('filter(["yes", "no", "yas"], (x) => startswith(x, "y"))'), ["yes", "yas"]);
});

test("lambda: all/any/none with predicate (docs examples)", () => {
  // docs: all([1, 2, 3], (x) => x > 0) = true / all([1, 2, 3], (x) => x > 1) = false
  assert.equal(ev("all([1, 2, 3], (x) => x > 0)"), true);
  assert.equal(ev("all([1, 2, 3], (x) => x > 1)"), false);
  // docs: all(["apple", "pie", 3], (x) => typeof(x) = "string") = false
  assert.equal(ev('all(["apple", "pie", 3], (x) => typeof(x) = "string")'), false);
  // docs: any(list(1, 2, 3), (x) => x > 2) = true / any(list(1, 2, 3), (x) => x = 0) = false
  assert.equal(ev("any(list(1, 2, 3), (x) => x > 2)"), true);
  assert.equal(ev("any(list(1, 2, 3), (x) => x = 0)"), false);
  // docs: none([1, 2, 3], (x) => x = 0) = true; none(["Apple","Pi","Banana"], (x) => startswith(x, "A")) = false
  assert.equal(ev("none([1, 2, 3], (x) => x = 0)"), true);
  assert.equal(ev('none(["Apple", "Pi", "Banana"], (x) => startswith(x, "A"))'), false);
});

test("lambda: minby/maxby doc examples (incl. this.file.tasks shape)", () => {
  // docs: minby([1, 2, 3], (k) => k) = 1 ; minby([1, 2, 3], (k) => 0 - k) => 3
  assert.equal(ev("minby([1, 2, 3], (k) => k)"), 1);
  assert.equal(ev("minby([1, 2, 3], (k) => 0 - k)"), 3);
  // docs: maxby([1, 2, 3], (k) => k) = 3 ; maxby([1, 2, 3], (k) => 0 - k) => 1
  assert.equal(ev("maxby([1, 2, 3], (k) => k)"), 3);
  assert.equal(ev("maxby([1, 2, 3], (k) => 0 - k)"), 1);
  // docs: minby(this.file.tasks, (k) => k.due) => (earliest due)
  const tasks = [{due: "2024-03-05"}, {due: "2024-01-01"}, {due: null}];
  assert.equal(ev("minby(tasks, (k) => k.due)", {tasks}).due, "2024-01-01");
  assert.equal(ev("maxby(tasks, (k) => k.due)", {tasks}).due, "2024-03-05");
  assert.equal(ev("minby([], (k) => k)"), null);
});

test("lambda: reduce with string operand and with function operand", () => {
  // docs: reduce([100, 20, 3], "-") = 77 ; reduce([200, 10, 2], "/") = 10
  assert.equal(ev('reduce([100, 20, 3], "-")'), 77);
  assert.equal(ev('reduce([200, 10, 2], "/")'), 10);
  // docs: reduce(["⭐", 3], "*") = "⭐⭐⭐"
  assert.equal(ev('reduce(["⭐", 3], "*")'), "⭐⭐⭐");
  // docs: reduce([1]), "+") = 1  (i.e. reduce([1], "+") collapses to the element)
  assert.equal(ev('reduce([1], "+")'), 1);
  // docs: reduce(values, this.operand) — operand from a field
  assert.equal(ev("reduce(values, this.operand)", {values: [100, 20, 3], this: {operand: "-"}}), 77);
  // boolean operands (docs: "&" matches all(), "|" matches any())
  assert.equal(ev('reduce([true, true, true], "&")'), true);
  assert.equal(ev('reduce([false, false, true], "|")'), true);
  // function operand receives (accumulator, element) — upstream reduce variant
  assert.equal(ev("reduce([1, 2, 3], (acc, x) => acc + x)"), 6);
  assert.equal(ev('reduce([], "+")'), null);
});

test("lambda: single-parameter bare form `x => expr`", () => {
  assert.deepEqual(ev("map([1, 2, 3], x => x * 2)"), [2, 4, 6]);
  assert.deepEqual(ev("filter([0, 1, 2], x => x >= 1)"), [1, 2]);
  assert.deepEqual(ev("map([1, 2], (x) => x + 1)"), [2, 3]);
  // zero-parameter form and immediately-invoked lambda values
  assert.equal(ev("typeof(() => 5)"), "function");
  assert.deepEqual(ev("map([1, 2], () => 7)"), [7, 7]);
  assert.equal(ev("((x) => x + 1)(2)"), 3);
  assert.equal(ev("((a, b) => a * b)(3, 4)"), 12);
  // map/filter pass only the element (upstream `arr.map(v => f(ctx, v))`);
  // a second parameter is therefore null, not the index.
  assert.deepEqual(ev("map([1, 2], (x, i) => i)"), [null, null]);
});

test("lambda: closures see outer scope; params shadow outer names", () => {
  assert.deepEqual(ev("map([1, 2], (x) => x + k)", {k: 10}), [11, 12]);
  assert.deepEqual(ev("map([1], (k) => k + 1)", {k: 10}), [2]);
  // lambda value stored in a variable / passed as an argument
  const g = ev("(x) => x * 3");
  assert.equal(typeof g, "function");
  assert.equal(ev("g(4)", {g}), 12);
  assert.deepEqual(ev("map([1, 2], h)", {h: ev("(x) => x - 1")}), [0, 1]);
  assert.equal(ev("typeof((x) => x + 1)"), "function");
});

test("lambda: nesting", () => {
  assert.deepEqual(ev("map(a, (x) => map(b, (y) => x + y))", {a: [1, 2], b: [10, 20]}), [[11, 21], [12, 22]]);
  assert.deepEqual(ev("map([1, 2], (x) => map([3], (y) => x * y))"), [[3], [6]]);
  assert.deepEqual(ev("map([1, 2], (x) => filter([1, 2, 3], (y) => y > x))"), [[2, 3], [3]]);
});

test("lambda: does not break `=`, `==`, `!=`, `>=`, `=~`, and/or/not", () => {
  assert.equal(ev('status = "open"', {status: "open"}), true);
  assert.equal(ev('status == "open"', {status: "open"}), true);
  assert.equal(ev("1 >= 1"), true);
  assert.equal(ev("2 > 1"), true);
  assert.equal(ev('"hello" =~ "h.*o"'), true);
  assert.equal(ev("not false and 1 != 2"), true);
  assert.equal(ev("minby([1, 2], (k) => k) >= 1"), true); // `>=` after a lambda close paren
  assert.equal(ev("(1 + 2) * 3"), 9); // plain parens are unaffected by the lambda probe
});

test("lambda: errors inside the body carry position (ExpressionError)", () => {
  try {
    ev("map([1], (x) => x(1))"); // x is a number → "Value is not a function"
    assert.fail("expected ExpressionError");
  } catch (e) {
    assert.ok(e instanceof ExpressionError);
    assert.equal(e.line, 1);
    assert.equal(e.col, 17); // position of `x(1)` inside the body
    assert.match(e.message, /not a function/);
  }
  assert.throws(() => ev("map([1], (x) => x +)"), ExpressionError); // body parse error
  assert.throws(() => ev("(x, y) =>"), ExpressionError);
});

// ══════════════════════════════════════════════════════════════════════════
// Constructors — docs Constructors
// ══════════════════════════════════════════════════════════════════════════

test("typeof: docs examples + full category set", () => {
  assert.equal(ev("typeof(8)"), "number"); // docs
  assert.equal(ev('typeof("text")'), "string"); // docs
  assert.equal(ev("typeof([1, 2, 3])"), "array"); // docs
  assert.equal(ev("typeof({a: 1, b: 2})"), "object"); // docs
  assert.equal(ev('typeof(date("2020-01-01"))'), "date"); // docs (bare date() spelled as ISO string)
  assert.equal(ev('typeof(dur("8 minutes"))'), "duration"); // docs
  assert.equal(ev("typeof(null)"), "null");
  assert.equal(ev("typeof(true)"), "boolean");
  assert.equal(ev('typeof(link("a.md"))'), "link");
  assert.equal(ev("typeof((x) => x)"), "function");
});

test("number(string): docs examples", () => {
  assert.equal(ev('number("18 years")'), 18); // docs
  assert.equal(ev("number(34)"), 34); // docs
  assert.equal(ev('number("hmm")'), null); // docs
  assert.equal(ev('number("0.8")'), 0.8);
  assert.equal(ev('number("v-12x")'), -12);
});

test("list/array constructors: docs examples", () => {
  assert.deepEqual(ev("list()"), []); // docs: list() => empty list
  assert.deepEqual(ev("list(1, 2, 3)"), [1, 2, 3]); // docs
  assert.deepEqual(ev('array("a", "b", "c")'), ["a", "b", "c"]); // docs: array is an alias
  assert.equal(ev("length(list())"), 0);
});

test("embed/elink/meta: docs examples", () => {
  // docs: embed(link("Hello.png")) => embedded link
  assert.equal(ev('embed(link("Hello.png")).embed'), true);
  assert.equal(ev('embed(link("Hello.png"), false).embed'), false);
  assert.equal(ev("embed(null)"), null);
  // docs: elink("www.google.com") / elink("www.google.com", "Google")
  const e1 = ev('elink("www.google.com")');
  assert.equal(e1.path, "www.google.com");
  assert.equal(e1.external, true);
  const e2 = ev('elink("www.google.com", "Google")');
  assert.equal(e2.path, "www.google.com");
  assert.equal(e2.display, "Google");
  // docs: meta([[2021-11-01|Displayed link text]]).display = "Displayed link text"
  const withDisplay = {path: "2021-11-01", display: "Displayed link text", embed: false};
  assert.equal(ev("meta(l).display", {l: withDisplay}), "Displayed link text");
  assert.equal(ev("meta(l).display", {l: {path: "2021-11-01", embed: false}}), null);
  assert.equal(ev("meta(l).path", {l: {path: "My Project", subpath: "#^9bcbe8", embed: false}}), "My Project");
  assert.equal(ev("meta(l).subpath", {l: {path: "My Project", subpath: "#^9bcbe8", embed: false}}), "9bcbe8");
  assert.equal(ev("meta(l).subpath", {l: {path: "My Project", subpath: "#Next Actions", embed: false}}), "Next Actions");
  assert.equal(ev("meta(l).subpath", {l: {path: "My Project", embed: false}}), null);
  assert.equal(ev("meta(l).type", {l: {path: "My Project", embed: false}}), "file");
  assert.equal(ev("meta(l).type", {l: {path: "My Project", subpath: "#Next Actions", embed: false}}), "header");
  assert.equal(ev("meta(l).type", {l: {path: "My Project", subpath: "#^9bcbe8", embed: false}}), "block");
  assert.equal(ev("meta(l).embed", {l: {path: "a.md", embed: true}}), true);
});

// ══════════════════════════════════════════════════════════════════════════
// Numeric Operations — docs Numeric Operations
// ══════════════════════════════════════════════════════════════════════════

test("round/trunc/floor/ceil: docs examples", () => {
  assert.equal(ev("round(16.555555)"), 17); // docs
  assert.equal(ev("round(16.555555, 2)"), 16.56); // docs
  assert.equal(ev("trunc(12.937)"), 12); // docs
  assert.equal(ev("trunc(-93.33333)"), -93); // docs
  assert.equal(ev("trunc(-0.837764)"), 0); // docs
  assert.equal(ev("floor(12.937)"), 12); // docs
  assert.equal(ev("floor(-93.33333)"), -94); // docs
  assert.equal(ev("floor(-0.837764)"), -1); // docs
  assert.equal(ev("ceil(12.937)"), 13); // docs
  assert.equal(ev("ceil(-93.33333)"), -93); // docs
  assert.equal(ev("ceil(-0.837764)"), 0); // docs
});

test("product/sum/average/reduce: docs examples", () => {
  assert.equal(ev("product([1, 2, 3])"), 6); // docs
  assert.equal(ev("product([])"), null); // docs
  assert.equal(ev("product(nonnull([null, 1, 2, 4]))"), 8); // docs
  assert.equal(ev("sum([1, 2, 3])"), 6); // docs
  assert.equal(ev("sum([])"), null); // docs
  assert.equal(ev("sum(nonnull([null, 1, 8]))"), 9); // docs
  assert.equal(ev("average([1, 2, 3])"), 2); // docs
  assert.equal(ev("average([])"), null); // docs
  assert.equal(ev("average(nonnull([null, 1, 2]))"), 1.5); // docs
});

// ══════════════════════════════════════════════════════════════════════════
// Objects / Arrays / Strings — docs Objects, Arrays, and String Operations
// ══════════════════════════════════════════════════════════════════════════

test("contains() and friends: docs examples", () => {
  assert.equal(ev('contains("Hello", "Lo")'), false); // docs
  assert.equal(ev('contains("Hello", "lo")'), true); // docs
  assert.equal(ev('icontains("Hello", "Lo")'), true); // docs
  assert.equal(ev('icontains("Hello", "lo")'), true); // docs
  assert.equal(ev('econtains("Hello", "Lo")'), false); // docs
  assert.equal(ev('econtains("Hello", "lo")'), true); // docs
  assert.equal(ev('econtains(["this", "is", "example"], "ex")'), false); // docs
  assert.equal(ev('econtains(["this", "is", "example"], "is")'), true); // docs
  assert.equal(ev("contains(list(1, 2, 3), 3)"), true); // docs
  assert.equal(ev("contains(list(), 1)"), false); // docs
});

test("containsword: docs examples (string + list forms)", () => {
  assert.equal(ev('containsword("word", "word")'), true); // docs
  assert.equal(ev('containsword("word", "Word")'), true); // docs
  assert.equal(ev('containsword("words", "Word")'), false); // docs
  assert.equal(ev('containsword("Hello there!", "hello")'), true); // docs
  assert.equal(ev('containsword("Hello there!", "HeLLo")'), true); // docs
  assert.equal(ev('containsword("Hello there chaps!", "chap")'), false); // docs
  assert.equal(ev('containsword("Hello there chaps!", "chaps")'), true); // docs
  assert.deepEqual(ev('containsword(["I have no words.", "words"], "Word")'), [false, false]); // docs
  assert.deepEqual(ev('containsword(["word", "Words"], "Word")'), [true, false]); // docs
  assert.deepEqual(ev('containsword(["Word", "Words in word"], "WORD")'), [true, true]); // docs
});

test("extract: docs examples (+ first-argument vectorization)", () => {
  assert.deepEqual(ev('extract(object("test", 1))'), {}); // docs
  assert.deepEqual(ev('extract({a: 1, b: 2, c: 3}, "a", "c")'), {a: 1, c: 3});
  assert.deepEqual(ev('extract([{a: 1}, {a: 2}], "a")'), [{a: 1}, {a: 2}]);
});

test("sort/reverse/length/nonnull/firstvalue: docs examples", () => {
  assert.deepEqual(ev("sort(list(3, 2, 1))").array(), [1, 2, 3]); // docs
  assert.deepEqual(ev("reverse(list(1, 2, 3))"), [3, 2, 1]); // docs
  assert.deepEqual(ev('reverse(list("a", "b", "c"))'), ["c", "b", "a"]); // docs
  assert.equal(ev("length([])"), 0); // docs
  assert.equal(ev("length([1, 2, 3])"), 3); // docs
  assert.equal(ev('length(object("hello", 1, "goodbye", 2))'), 2); // docs
  assert.deepEqual(ev("nonnull([])"), []); // docs
  assert.deepEqual(ev("nonnull([null, false])"), [false]); // docs
  assert.deepEqual(ev("nonnull([1, 2, 3])"), [1, 2, 3]); // docs
  assert.equal(ev("firstvalue([null, 1, 2])"), 1); // docs
});

test("all/any/none: docs examples (array + varargs)", () => {
  assert.equal(ev("all([1, 2, 3])"), true); // docs
  assert.equal(ev("all([true, false])"), false); // docs
  assert.equal(ev("all(true, false)"), false); // docs
  assert.equal(ev("all(true, true, true)"), true); // docs
  assert.equal(ev("any(list(1, 2, 3))"), true); // docs
  assert.equal(ev("any(list(true, false))"), true); // docs
  assert.equal(ev("any(list(false, false, false))"), false); // docs
  assert.equal(ev("any(true, false)"), true); // docs
  assert.equal(ev("any(false, false)"), false); // docs
  assert.equal(ev("none([])"), true); // docs
  assert.equal(ev("none([false, false])"), true); // docs
  assert.equal(ev("none([false, true])"), false); // docs
  assert.equal(ev("none([1, 2, 3])"), false); // docs
});

test("flat: docs examples", () => {
  assert.deepEqual(ev("flat(list(1, 2, 3, list(4, 5), 6))"), [1, 2, 3, 4, 5, 6]); // docs
  assert.deepEqual(ev("flat(list(1, list(21, 22), list(list(311, 312, 313))), 4)"), [1, 21, 22, 311, 312, 313]); // docs
});

test("slice: docs examples (container function, not auto-vectorized)", () => {
  assert.deepEqual(ev("slice([1, 2, 3, 4, 5], 3)"), [4, 5]); // docs
  assert.deepEqual(ev('slice(["ant", "bison", "camel", "duck", "elephant"], 0, 2)'), ["ant", "bison"]); // docs
  assert.deepEqual(ev("slice([1, 2, 3, 4, 5], -2)"), [4, 5]); // docs
});

// ══════════════════════════════════════════════════════════════════════════
// String Operations — docs String Operations
// ══════════════════════════════════════════════════════════════════════════

test("regextest/regexmatch: docs examples", () => {
  assert.equal(ev('regextest("\\w+", "hello")'), true); // docs: regextest("\w+", "hello")
  assert.equal(ev('regextest(".", "a")'), true); // docs
  assert.equal(ev('regextest("yes|no", "maybe")'), false); // docs
  assert.equal(ev('regextest("what", "what\'s up dog?")'), true); // docs
  assert.equal(ev('regexmatch("\\w+", "hello")'), true); // docs
  assert.equal(ev('regexmatch("yes|no", "maybe")'), false); // docs
  assert.equal(ev('regexmatch("what", "what\'s up dog?")'), false); // docs
});

test("split: docs examples (regex delimiter, captures spliced in)", () => {
  assert.deepEqual(ev('split("hello world", " ")'), ["hello", "world"]); // docs
  assert.deepEqual(ev('split("hello there world", " ", 2)'), ["hello", "there"]); // docs
  assert.deepEqual(ev('split("hello there world", "(t?here)")'), ["hello ", "there", " world"]); // docs
  assert.deepEqual(ev('split("hello there world", "( )(x)?")'), ["hello", " ", "", "there", " ", "", "world"]); // docs
  // The docs claim split("hello  world", "\s") = ["hello","world"], but upstream
  // is `str.split(new RegExp(delim), limit).map(s => s || "")` which (like JS)
  // keeps the empty field between the two spaces. We assert upstream behavior.
  assert.deepEqual(ev('split("hello  world", "\\s")'), ["hello", "", "world"]);
});

test("replace/regexreplace/lower/upper: docs examples", () => {
  assert.equal(ev('regexreplace("yes", "[ys]", "a")'), "aea"); // docs
  assert.equal(ev('regexreplace("Suite 1000", "\\d+", "-")'), "Suite -"); // docs
  assert.equal(ev('lower("Test")'), "test"); // docs
  assert.equal(ev('lower("TEST")'), "test"); // docs
  assert.equal(ev('upper("Test")'), "TEST"); // docs
  // deviation (pinned by dataview-query.test.mjs): replace() replaces the FIRST
  // occurrence; the docs example "The small dog chased the small cat." needs
  // replace-all. Single-occurrence doc cases still match:
  assert.equal(ev('replace("what", "wh", "h")'), "hat"); // docs
  assert.equal(ev('replace("test", "test", "no")'), "no"); // docs
});

test("startswith/endswith/padleft/padright/substring/truncate: docs examples", () => {
  assert.equal(ev('startswith("yes", "ye")'), true); // docs
  assert.equal(ev('startswith("path/to/something", "path/")'), true); // docs
  assert.equal(ev('startswith("yes", "no")'), false); // docs
  assert.equal(ev('endswith("yes", "es")'), true); // docs
  assert.equal(ev('endswith("path/to/something", "something")'), true); // docs
  assert.equal(ev('endswith("yes", "ye")'), false); // docs
  assert.equal(ev('padleft("hello", 7)'), "  hello"); // docs
  assert.equal(ev('padleft("yes", 5, "!")'), "!!yes"); // docs
  assert.equal(ev('padright("hello", 7)'), "hello  "); // docs
  assert.equal(ev('padright("yes", 5, "!")'), "yes!!"); // docs
  assert.equal(ev('substring("hello", 0, 2)'), "he"); // docs
  assert.equal(ev('substring("hello", 2, 4)'), "ll"); // docs
  assert.equal(ev('substring("hello", 2)'), "llo"); // docs
  assert.equal(ev('substring("hello", 0)'), "hello"); // docs
  assert.equal(ev('truncate("Hello there!", 8)'), "Hello..."); // docs
  assert.equal(ev('truncate("Hello there!", 8, "/")'), "Hello t/"); // docs
  assert.equal(ev('truncate("Hello there!", 10)'), "Hello t..."); // docs
  assert.equal(ev('truncate("Hello there!", 10, "!")'), "Hello the!"); // docs
  assert.equal(ev('truncate("Hello there!", 20)'), "Hello there!"); // docs
});

// ══════════════════════════════════════════════════════════════════════════
// Utility Functions — docs Utility Functions
// ══════════════════════════════════════════════════════════════════════════

test("default/ldefault: docs examples", () => {
  assert.deepEqual(ev("default(list(1, 2, null), 3)"), [1, 2, 3]); // docs
  assert.deepEqual(ev("ldefault(list(1, 2, null), 3)"), [1, 2, null]); // docs
  assert.equal(ev("default(null, 5)"), 5);
  assert.equal(ev("default(3, 5)"), 3);
});

test("display: docs examples", () => {
  assert.equal(ev('display("Hello World")'), "Hello World"); // docs
  assert.equal(ev('display("**Hello** World")'), "Hello World"); // docs
  assert.equal(ev('display("[Hello](https://example.com) [[World]]")'), "Hello World"); // docs
  assert.equal(ev('display(link("path/to/file.md"))'), "file"); // docs
  assert.equal(ev('display(link("path/to/file.md", "displayname"))'), "displayname"); // docs
  assert.equal(ev('display(date("2024-11-18"))'), "November 18, 2024"); // docs
  assert.equal(ev('display(list("Hello", "World"))'), "Hello, World"); // docs
});

test("hash: deterministic + docs shape", () => {
  const a = ev('hash("2024-03-17", "note.md")');
  assert.equal(typeof a, "number");
  assert.equal(ev('hash("2024-03-17", "note.md")'), a); // stable
  assert.notEqual(ev('hash("2024-03-17", "other.md")'), a);
  assert.equal(typeof ev('hash("2024-03-17")'), "number");
  assert.equal(typeof ev('hash("s", "t", 4)'), "number");
  assert.notEqual(ev('hash("s", "t", 4)'), ev('hash("s", "t", 5)'));
  // docs: hash uses a variant number for uniqueness within a task list
  assert.notEqual(ev('hash("d", "file.md", 1)'), ev('hash("d", "file.md", 2)'));
});

test("striptime: docs behavior (year/month/day only)", () => {
  const d = ev('striptime(date("2024-03-15T10:30:45Z"))');
  assert.equal(d.year, 2024);
  assert.equal(d.month, 3);
  assert.equal(d.day, 15);
  assert.equal(d.hour, 0);
  assert.equal(d.minute, 0);
  assert.equal(ev("striptime(null)"), null);
});

test("date(text, format): docs examples (Luxon token subset)", () => {
  // docs: date("12/31/2022", "MM/dd/yyyy") => DateTime for December 31th, 2022
  const a = ev('date("12/31/2022", "MM/dd/yyyy")');
  assert.deepEqual([a.year, a.month, a.day], [2022, 12, 31]);
  // docs: date("210313", "yyMMdd") => DateTime for March 13th, 2021
  const b = ev('date("210313", "yyMMdd")');
  assert.deepEqual([b.year, b.month, b.day], [2021, 3, 13]);
  // docs: date("946778645000", "x") => DateTime for "2000-01-02T03:04:05"
  // (docs show local time; we compare against the same instant in UTC)
  assert.equal(ev('date("946778645000", "x")').toISO(), new Date(946778645000).toISOString());
  assert.equal(ev('date("garbage", "yyyy-MM-dd")'), null);
  assert.equal(ev('date("2022-01-05", "dd/MM/yyyy")'), null); // whole-text match required
  assert.equal(ev("date(null, \"yyyy\")"), null);
  // one-argument form is unchanged
  assert.equal(ev('date("2024-03-15")').day, 15);
});

test("dateformat: docs examples (Luxon token subset)", () => {
  assert.equal(ev('dateformat(date("2022-01-05T12:18:04Z"), "yyyy-MM-dd")'), "2022-01-05"); // docs
  assert.equal(ev('dateformat(date("2022-01-05T12:18:04Z"), "HH:mm:ss")'), "12:18:04"); // docs
  assert.equal(ev('dateformat(date("2022-01-05T12:18:04Z"), "x")'), String(Date.parse("2022-01-05T12:18:04Z"))); // docs
  // docs: dateformat(file.mtime,"ffff") = "Wednesday, August 6, 2014, 1:07 PM <zone>"
  // (our dates are UTC, so the trailing zone name differs; assert the rest)
  const huge = ev('dateformat(date("2014-08-06T13:07:00Z"), "ffff")');
  assert.ok(huge.startsWith("Wednesday, August 6, 2014"), huge);
  assert.ok(huge.includes("1:07 PM"), huge);
  assert.equal(ev('dateformat(date("2024-11-18"), "MMMM d, yyyy")'), "November 18, 2024");
  assert.equal(ev('dateformat(date("2024-11-18"), "dd/MM/yyyy")'), "18/11/2024");
  assert.equal(ev('dateformat(null, "yyyy")'), null);
});

test("durationformat: docs examples (tokens + quoted literals)", () => {
  assert.equal(ev('durationformat(dur("3 days 7 hours 43 seconds"), "ddd\'d\' hh\'h\' ss\'s\'")'), "003d 07h 43s"); // docs
  assert.equal(ev('durationformat(dur("365 days 5 hours 49 minutes"), "yyyy ddd hh mm ss")'), "0001 000 05 49 00"); // docs
  assert.equal(ev('durationformat(dur("2000 years"), "M months")'), "24000 months"); // docs
  assert.equal(ev('durationformat(dur("14d"), "s \'seconds\'")'), "1209600 seconds"); // docs
});

test("currencyformat: Intl.NumberFormat with the default locale", () => {
  const loc = Intl.NumberFormat().resolvedOptions().locale;
  assert.equal(ev('currencyformat(123456.789, "USD")'), new Intl.NumberFormat(loc, {style: "currency", currency: "USD"}).format(123456.789));
  assert.equal(ev("currencyformat(123456.789)"), new Intl.NumberFormat(loc, {style: "currency", currency: "USD"}).format(123456.789));
  assert.equal(ev("currencyformat(null)"), null);
});

test("localtime: shifts to local wall-clock fields", () => {
  const iso = "2024-03-15T12:00:00Z";
  const ms = Date.parse(iso);
  const local = ev(`localtime(date("${iso}"))`);
  assert.equal(local.hour, new Date(ms).getHours());
  assert.equal(local.day, new Date(ms).getDate());
  assert.equal(ev("localtime(null)"), null);
});

// ══════════════════════════════════════════════════════════════════════════
// Vectorization — docs "Calling functions on lists of values"
// ══════════════════════════════════════════════════════════════════════════

test("vectorization: docs examples", () => {
  assert.deepEqual(ev('lower(["YES", "NO"])'), ["yes", "no"]); // docs
  assert.equal(ev('lower("YES")'), "yes"); // docs: scalar stays scalar
  assert.equal(ev('replace("yes", "e", "a")'), "yas"); // docs
  // docs: replace(["yes", "ree"], "e", "a") = ["yas", "raa"] — "raa" requires
  // upstream's replace-ALL, which contradicts our pinned first-occurrence
  // semantics (test/dataview-query.test.mjs: replace("hello","l","L") = "heLlo").
  // Vectorization itself is asserted here; the per-element value follows our
  // documented first-occurrence deviation.
  assert.deepEqual(ev('replace(["yes", "ree"], "e", "a")'), ["yas", "rae"]);
});

test("vectorization: required function coverage", () => {
  assert.deepEqual(ev('upper(["a", "b"])'), ["A", "B"]);
  assert.deepEqual(ev('regexreplace(["yes", "ree"], "e", "a")'), ["yas", "raa"]);
  assert.deepEqual(ev('startswith(["yes", "no"], "y")'), [true, false]);
  assert.deepEqual(ev('endswith(["yes", "no"], "s")'), [true, false]);
  assert.deepEqual(ev('substring(["hello", "world"], 0, 2)'), ["he", "wo"]);
  assert.deepEqual(ev('truncate(["Hello there!", "Hello there!"], 8)'), ["Hello...", "Hello..."]);
  assert.deepEqual(ev('number(["18 years", "hmm"])'), [18, null]);
  assert.deepEqual(ev("string([1, 2])"), ["1", "2"]);
  assert.deepEqual(ev("round([1.4, 2.6])"), [1, 3]);
  assert.deepEqual(ev("floor([1.9, 2.9])"), [1, 2]);
  assert.deepEqual(ev("ceil([1.1, 2.1])"), [2, 3]);
  assert.deepEqual(ev("abs([-1, -2])"), [1, 2]);
  assert.deepEqual(ev("trunc([1.9, -0.5])"), [1, 0]);
  assert.deepEqual(ev('padleft(["a", "bb"], 3)'), ["  a", " bb"]);
  assert.deepEqual(ev('padright(["a", "bb"], 3)'), ["a  ", "bb "]);
  assert.deepEqual(ev('regextest("y", ["yes", "no"])'), [true, false]);
  assert.deepEqual(ev('regexmatch("yes", ["yes", "no"])'), [true, false]);
  assert.deepEqual(ev('dateformat([date("2022-01-05T12:18:04Z")], "yyyy-MM-dd")'), ["2022-01-05"]);
  const ds = ev('striptime([date("2024-03-15T10:30:45Z")])');
  assert.equal(ds[0].hour, 0);
  const dated = ev('date(["2024-03-15"])');
  assert.equal(dated[0].day, 15);
  assert.deepEqual(ev('dur(["2h", "1d"])').map((d) => d.ms), [7200000, 86400000]);
  assert.deepEqual(ev("default([null, 1], 5)"), [5, 1]);
  assert.equal(ev('localtime([date("2024-03-15T12:00:00Z")])')[0].day, new Date(Date.parse("2024-03-15T12:00:00Z")).getDate());
  assert.deepEqual(ev('currencyformat([1, 2], "USD")').length, 2);
  assert.deepEqual(ev('containsword(["word", "Words"], "Word")'), [true, false]);
});

test("vectorization: scalars keep scalar semantics (no wrapping)", () => {
  assert.equal(ev('lower("YES")'), "yes");
  assert.equal(ev('number("18 years")'), 18);
  assert.equal(ev("round(2.567, 1)"), 2.6);
  assert.equal(ev("default(null, 5)"), 5);
  assert.equal(ev('regextest("y", "yes")'), true);
});

test("vectorization: table-level (dv.func surface) is wrapped too", () => {
  assert.deepEqual(DvFunctions.lower(["YES", "NO"]), ["yes", "no"]);
  assert.equal(DvFunctions.typeof([1, 2, 3]), "array");
  assert.equal(DvFunctions.display(["a", "b"]), "a, b");
});

test("NOT vectorized: container/aggregate/array-semantic functions", () => {
  // typeof(array) = "array" (docs) — must not become per-element
  assert.equal(ev("typeof([1, 2, 3])"), "array");
  // display(list(...)) joins with ", " (docs) — must not become a list
  assert.equal(ev('display(list("Hello", "World"))'), "Hello, World");
  // slice's first argument IS the array (docs) — must not become per-element
  assert.deepEqual(ev("slice([1, 2, 3, 4, 5], 3)"), [4, 5]);
  // container semantics
  assert.equal(ev("contains(list(1, 2, 3), 3)"), true);
  assert.equal(ev("econtains([1, 2], 2)"), true);
  assert.equal(ev("icontains([\"Yes\"], \"yes\")"), true);
  // aggregations
  assert.equal(ev("sum([1, 2, 3])"), 6);
  assert.equal(ev("product([1, 2, 3])"), 6);
  assert.equal(ev("average([1, 2, 3])"), 2);
  assert.equal(ev("reduce([100, 20, 3], \"-\")"), 77);
  assert.equal(ev("minby([1, 2, 3], (k) => k)"), 1);
  // collection functions
  assert.equal(ev("length([1, 2])"), 2);
  assert.deepEqual(ev("filter([1, 2, 3], (x) => x > 1)"), [2, 3]);
  assert.deepEqual(ev("map([1, 2], (x) => x + 1)"), [2, 3]);
  assert.deepEqual(ev("reverse([1, 2])"), [2, 1]);
  assert.deepEqual(ev("unique([1, 1, 2])"), [1, 2]);
  assert.deepEqual(ev("nonnull([null, 1])"), [1]);
  assert.equal(ev("firstvalue([null, 1])"), 1);
  assert.deepEqual(ev("sort([2, 1])").array(), [1, 2]);
  assert.equal(ev('join([1, 2, 3], "-")'), "1-2-3");
  assert.deepEqual(ev('extract([{a: 1}], "a")'), [{a: 1}]);
});

test("function table: required names exist and the table is a stable singleton", () => {
  const added = [
    "typeof", "number", "list", "array", "embed", "elink", "meta",
    "trunc", "product", "reduce", "average", "minby", "maxby", "sum",
    "icontains", "econtains", "containsword", "extract", "reverse", "nonnull", "firstvalue",
    "all", "any", "none", "filter", "map", "flat",
    "regextest", "regexmatch", "split", "startswith", "endswith", "padleft", "padright",
    "substring", "truncate", "display", "hash", "striptime", "dateformat", "durationformat",
    "currencyformat", "localtime", "ldefault",
  ];
  for (const name of added) assert.equal(typeof DvFunctions[name], "function", `missing ${name}`);
  assert.ok(Object.keys(DvFunctions).length >= 80, `got ${Object.keys(DvFunctions).length}`);
  // module-load construction: the same function object is returned every lookup
  assert.equal(DvFunctions.lower, DvFunctions.lower);
});
