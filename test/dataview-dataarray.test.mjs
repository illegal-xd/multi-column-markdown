/**
 * DataArray (query/dataArray.ts) — upstream Dataview array semantics.
 *
 * Assertions are taken from the official "Data Arrays" / "Codeblock Reference"
 * docs idioms (`dv.pages().file.name`, `group.rows.file.name`, `pages[0]`) and
 * from upstream `src/api/data-array.ts` (fetch of master, 2026-09-22).
 * Deliberate deviations from upstream are called out inline and listed in the
 * task report:
 *   - unknown swizzled field with zero hits → `undefined` (upstream: empty DataArray)
 *   - `groupBy`/`distinct` keep first-seen order (upstream sorts by key first)
 *   - `expand` walks siblings in source order (upstream's LIFO stack reverses them)
 *   - `distinct()` without key keeps the historical JSON-value dedupe
 *
 * Pattern: esbuild bundle → node --test.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-da-"));
try {
  execSync(
    "npx esbuild src/dataview/query/dataArray.ts --bundle --format=esm --outfile=" + join(dir, "dataArray.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {createDataArray} = await import(join(dir, "dataArray.mjs"));

/** Page-like fixture: `fields` at the top level plus `file` metadata. */
function page(name, tags = ["#all"], extra = {}) {
  return {file: {name, path: `notes/${name}.md`, tags}, tags, ...extra};
}

const PAGES = [page("a", ["#x", "#y"], {genres: ["g1", "g2"]}), page("b", ["#y"]), page("c", [])];

// ══════════════════════════════════════════════════════════════════════════
// swizzling ([field]) — the docs' core idiom
// ══════════════════════════════════════════════════════════════════════════

test("swizzling: single level projects the field over every element", () => {
  const arr = createDataArray(PAGES);
  assert.deepEqual(arr.file.array().map((f) => f.name), ["a", "b", "c"]);
});

test("swizzling: multi level — dv.pages().file.name (docs idiom)", () => {
  const arr = createDataArray(PAGES);
  const names = arr.file.name;
  assert.deepEqual(names.array(), ["a", "b", "c"]);
  assert.equal(names.length, 3);
});

test("swizzling: multi level — group.rows.file.name (docs GROUP BY idiom)", () => {
  const groups = createDataArray([{key: "open", rows: createDataArray(PAGES.slice(0, 2))}, {key: "done", rows: createDataArray(PAGES.slice(2))}]);
  assert.deepEqual(groups.rows.file.name.array(), ["a", "b", "c"]);
});

test("swizzling: dv.pages(\"#books\").genres auto-flattens one level", () => {
  const arr = createDataArray(PAGES);
  // Only page "a" has genres: g1/g2 are flattened into the result.
  assert.deepEqual(arr.genres.array(), ["g1", "g2"]);
  // tags is an array on every page → all flattened.
  assert.deepEqual(arr.file.tags.array(), ["#x", "#y", "#y"]);
});

test("swizzling: does NOT recursively flatten (one level only, like upstream to())", () => {
  const arr = createDataArray([{a: [[1, 2], [3]]}]);
  const got = arr.a.array();
  assert.equal(got.length, 2);
  assert.deepEqual(got, [[1, 2], [3]]);
});

test("swizzling: elements missing the field are skipped", () => {
  const arr = createDataArray([{file: {name: "a"}}, {other: 1}, {file: {name: "c"}}, null, undefined]);
  assert.deepEqual(arr.file.name.array(), ["a", "c"]);
});

test("swizzling: unknown field with no hits → EMPTY DataArray (upstream Proxy)", () => {
  // Upstream maps the field over every element and DROPS misses, so a field no
  // element carries yields an empty data array — chains stay safe
  // (`dv.pages("#books").genres.length` must not throw).
  const miss = createDataArray(PAGES).zzzNothing;
  assert.equal(typeof miss.array, "function");
  assert.deepEqual(miss.array(), []);
  assert.equal(createDataArray([{a: 1}]).b.length, 0);
  assert.equal(createDataArray([]).anything.length, 0);
  // Field present but nullish on every element → also empty.
  assert.deepEqual(createDataArray([{a: null}, {a: undefined}]).a.array(), []);
  // Chains through a missing field no longer throw (was a documented deviation).
  assert.deepEqual(createDataArray([{a: 1}]).b.c.array(), []);
});

test("swizzling: field present with an empty array still yields an empty DataArray", () => {
  const r = createDataArray([{a: []}]).a;
  assert.equal(typeof r.array, "function");
  assert.equal(r.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// numeric indexing + API priority
// ══════════════════════════════════════════════════════════════════════════

test("numeric indexing: arr[0] → element, out of range → undefined", () => {
  const arr = createDataArray([10, 20, 30]);
  assert.equal(arr[0], 10);
  assert.equal(arr[2], 30);
  assert.equal(arr[3], undefined);
  assert.equal(arr[-1], undefined);
  assert.equal(arr["1"], 20);
});

test("method/property names win over swizzling", () => {
  const tricky = createDataArray([{length: 999, array: "x", where: "y", flatten: "z", toJSON: "q", map: "m"}]);
  assert.equal(tricky.length, 1); // not 999
  assert.equal(typeof tricky.array, "function");
  assert.equal(typeof tricky.where, "function");
  assert.equal(typeof tricky.flatten, "function");
  assert.equal(typeof tricky.toJSON, "function");
  assert.equal(typeof tricky.map, "function");
  assert.equal(typeof tricky.includes, "function");
  assert.equal(typeof tricky.isEmpty, "function");
  // And they still work.
  assert.deepEqual(tricky.array(), [{length: 999, array: "x", where: "y", flatten: "z", toJSON: "q", map: "m"}]);
});

test("isDataArray duck-type contract holds (array/length/flatten) and Array.isArray is false", () => {
  const arr = createDataArray([1, 2]);
  assert.equal(typeof arr.array, "function");
  assert.equal(typeof arr.length, "number");
  assert.equal(typeof arr.flatten, "function");
  // We rely on duck typing (values.ts isDataArray) — the proxy must stay a non-array object.
  assert.equal(Array.isArray(arr), false);
  assert.equal(arr.constructor, Array); // upstream maps constructor → Array
});

// ══════════════════════════════════════════════════════════════════════════
// iteration / serialization
// ══════════════════════════════════════════════════════════════════════════

test("iteration: for..of, spread, Array.from, destructuring", () => {
  const arr = createDataArray([1, 2, 3]);
  const seen = [];
  for (const x of arr) seen.push(x);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual([...arr], [1, 2, 3]);
  assert.deepEqual(Array.from(arr), [1, 2, 3]);
  const [head, ...tail] = arr;
  assert.equal(head, 1);
  assert.deepEqual(tail, [2, 3]);
});

test("toJSON: JSON.stringify returns a plain array, not {}", () => {
  const arr = createDataArray(["a", "b"]);
  assert.deepEqual(arr.toJSON(), ["a", "b"]);
  assert.equal(JSON.stringify(arr), '["a","b"]');
  assert.equal(JSON.stringify({rows: createDataArray([1, 2])}), '{"rows":[1,2]}');
});

// ══════════════════════════════════════════════════════════════════════════
// immutability + mutate
// ══════════════════════════════════════════════════════════════════════════

test("immutability: deriving ops return new arrays and leave the source alone", () => {
  const src = [3, 1, 2];
  const arr = createDataArray(src);
  const sorted = arr.sort();
  const reversed = arr.reverse();
  const sliced = arr.slice(0, 2);
  assert.notEqual(sorted, arr);
  assert.deepEqual(arr.array(), [3, 1, 2]);
  assert.deepEqual(src, [3, 1, 2]);
  assert.deepEqual(sorted.array(), [1, 2, 3]);
  assert.deepEqual(reversed.array(), [2, 1, 3]);
  assert.deepEqual(sliced.array(), [3, 1]);
  // array() hands out a copy.
  const copy = arr.array();
  copy.push(99);
  assert.deepEqual(arr.array(), [3, 1, 2]);
});

test("mutate: in-place, returns the same DataArray (chainable)", () => {
  const arr = createDataArray([{n: 1}, {n: 2}, {n: 3}]);
  // Upstream semantics: the callback mutates elements for its side effect;
  // its return value is ignored.
  const out = arr.mutate((o) => {
    o.n *= 2;
  });
  assert.equal(out, arr); // same proxy: still indexable/swizzlable
  assert.deepEqual(arr.array(), [{n: 2}, {n: 4}, {n: 6}]);
  const chained = arr.mutate((o) => {
    o.n += 1;
  }).where((o) => o.n > 4);
  assert.equal(chained.length, 2);
  assert.deepEqual(chained.file.array(), []); // missing field → empty DataArray
  // The edits are in the backing buffer itself, so array() reflects them
  // ([{n:2},{n:4},{n:6}] then +1 for every element).
  assert.deepEqual(arr.array().map((o) => o.n), [3, 5, 7]);
});

// ══════════════════════════════════════════════════════════════════════════
// array ops
// ══════════════════════════════════════════════════════════════════════════

test("where/filter/map/flatMap/forEach pass (value, index, array)", () => {
  const arr = createDataArray([1, 2, 3]);
  assert.deepEqual(arr.where((v, i, a) => v > 1 && a.length === 3 && i > 0).array(), [2, 3]);
  assert.deepEqual(arr.filter((v) => v % 2 === 1).array(), [1, 3]);
  assert.deepEqual(arr.map((v, i, a) => `${i}:${v}:${a.length}`).array(), ["0:1:3", "1:2:3", "2:3:3"]);
  assert.deepEqual(arr.flatMap((v) => [v, v]).array(), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(arr.flatMap((v) => createDataArray([v * 10])).array(), [10, 20, 30]);
  const seen = [];
  arr.forEach((v, i) => {
    seen.push(v + i);
  });
  assert.deepEqual(seen, [1, 3, 5]);
});

test("limit/take/slice/first/last/join", () => {
  const arr = createDataArray([1, 2, 3, 4]);
  assert.deepEqual(arr.limit(2).array(), [1, 2]);
  assert.deepEqual(arr.take(0).array(), []);
  assert.deepEqual(arr.limit(-1).array(), []);
  assert.deepEqual(arr.slice(1, 3).array(), [2, 3]);
  assert.deepEqual(arr.slice(2).array(), [3, 4]);
  assert.equal(arr.first(), 1);
  assert.equal(arr.last(), 4);
  assert.equal(createDataArray([]).first(), undefined);
  assert.equal(createDataArray([]).last(), undefined);
  assert.equal(arr.join(), "1, 2, 3, 4");
  assert.equal(arr.join("-"), "1-2-3-4");
  assert.equal(createDataArray([1, null, undefined, 2]).join(","), "1,,,2");
});

test("concat: plain array / DataArray / Set / generator (iterables)", () => {
  const arr = createDataArray([1]);
  assert.deepEqual(arr.concat([2, 3]).array(), [1, 2, 3]);
  assert.deepEqual(arr.concat(createDataArray([4])).array(), [1, 4]);
  assert.deepEqual(arr.concat(new Set([5])).array(), [1, 5]);
  function* gen() {
    yield 6;
    yield 7;
  }
  assert.deepEqual(arr.concat(gen()).array(), [1, 6, 7]);
  assert.deepEqual(arr.array(), [1]); // unchanged
});

test("indexOf/includes/find/findIndex", () => {
  const arr = createDataArray([{n: 1}, {n: 2}, {n: 2}]);
  assert.equal(arr.indexOf(arr[1]), 1);
  // Upstream compares with the dataview comparator (not `===`), so an
  // equal-shaped object matches as well.
  assert.equal(arr.indexOf({n: 2}), 1);
  assert.equal(arr.includes(arr[2]), true);
  assert.equal(arr.includes({n: 2}), true);
  assert.equal(arr.includes({n: 9}), false);
  assert.equal(createDataArray([1, 2, 3]).indexOf(2), 1);
  assert.equal(createDataArray([1, 2, 3]).indexOf(2, 2), -1);
  assert.equal(createDataArray([1, 2, 3]).indexOf(9), -1);
  assert.equal(createDataArray([1, 2, 3]).includes(3), true);
  assert.equal(createDataArray([1, 2, 3]).includes(9), false);
  assert.equal(arr.find((v) => v.n === 2).n, 2);
  assert.equal(arr.find((v) => v.n === 9), undefined);
  assert.equal(arr.findIndex((v) => v.n === 2), 1);
  assert.equal(arr.findIndex((v) => v.n === 2, 2), 2);
  assert.equal(arr.findIndex((v) => v.n === 9), -1);
});

test("some/every/none/any", () => {
  const arr = createDataArray([1, 2, 3]);
  assert.equal(arr.some((v) => v > 2), true);
  assert.equal(arr.some((v) => v > 9), false);
  assert.equal(arr.every((v) => v > 0), true);
  assert.equal(arr.every((v) => v > 1), false);
  assert.equal(arr.none((v) => v > 9), true);
  assert.equal(arr.none((v) => v > 2), false);
  assert.equal(arr.any((v) => v === 2), true);
  assert.equal(arr.any(), true); // no predicate → non-empty
  assert.equal(createDataArray([]).any(), false);
  assert.equal(createDataArray([]).every(() => false), true);
});

test("flatten: one level of arrays/DataArrays; isEmpty", () => {
  const arr = createDataArray([[1, 2], createDataArray([3]), 4]);
  assert.deepEqual(arr.flatten().array(), [1, 2, 3, 4]);
  assert.equal(createDataArray([]).isEmpty(), true);
  assert.equal(createDataArray([0]).isEmpty(), false);
});

// ══════════════════════════════════════════════════════════════════════════
// sort / groupBy / distinct
// ══════════════════════════════════════════════════════════════════════════

test("sort: natural, string key, function key, direction, comparator, stability", () => {
  assert.deepEqual(createDataArray([3, 1, 2]).sort().array(), [1, 2, 3]);
  assert.deepEqual(createDataArray([3, 1, 2]).sort(undefined, "desc").array(), [3, 2, 1]);
  const objs = [{n: 2, t: "b"}, {n: 1, t: "a"}, {n: 2, t: "c"}];
  assert.deepEqual(createDataArray(objs).sort("n").array().map((o) => o.t), ["a", "b", "c"]);
  assert.deepEqual(createDataArray(objs).sort((o) => o.n, "desc").array().map((o) => o.t), ["b", "c", "a"]);
  // Custom comparator wins over the default dataview comparison.
  const byLen = createDataArray(["aaa", "a", "aa"]).sort(undefined, "asc", (a, b) => a.length - b.length);
  assert.deepEqual(byLen.array(), ["a", "aa", "aaa"]);
  // nulls last on asc (dataview ordering).
  assert.deepEqual(createDataArray([null, 2, null, 1]).sort().array(), [1, 2, null, null]);
  // ordered() is the historical alias.
  assert.deepEqual(createDataArray([2, 1]).ordered().array(), [1, 2]);
  assert.deepEqual(createDataArray([2, 1]).ordered(undefined, "desc").array(), [2, 1]);
});

test("groupBy: keeps first-seen group order, rows is a DataArray", () => {
  const data = [
    {k: "b", v: 1},
    {k: "a", v: 2},
    {k: "b", v: 3},
    {k: "a", v: 4},
  ];
  const groups = createDataArray(data).groupBy((x) => x.k);
  assert.deepEqual(groups.array().map((g) => g.key), ["b", "a"]);
  const rows = groups[0].rows;
  assert.equal(typeof rows.array, "function"); // DataArray, not plain array
  assert.deepEqual(rows.array().map((r) => r.v), [1, 3]);
  assert.deepEqual(groups.rows.v.array(), [1, 3, 2, 4]); // documented swizzle on groups
  // String field key.
  assert.deepEqual(createDataArray(data).groupBy("k").array().map((g) => g.key), ["b", "a"]);
  // Comparator defines key equality (case-insensitive here).
  const ci = createDataArray([{k: "A"}, {k: "a"}, {k: "b"}]).groupBy((x) => x.k, (a, b) => a.toLowerCase() === b.toLowerCase() ? 0 : a < b ? -1 : 1);
  assert.deepEqual(ci.array().map((g) => g.key), ["A", "b"]);
  assert.equal(ci[0].rows.length, 2);
  assert.deepEqual(createDataArray([]).groupBy("k").array(), []);
});

test("distinct: key-based dedupe keeps the first occurrence; unique() unchanged", () => {
  const data = [{k: 1, v: "first"}, {k: 2, v: "x"}, {k: 1, v: "second"}];
  assert.deepEqual(createDataArray(data).distinct((x) => x.k).array().map((d) => d.v), ["first", "x"]);
  assert.deepEqual(createDataArray(data).distinct("k").array().map((d) => d.v), ["first", "x"]);
  // Comparator-defined equality.
  const ci = createDataArray(["A", "a", "b"]).distinct((x) => x, (a, b) => a.toLowerCase() === b.toLowerCase() ? 0 : 1);
  assert.deepEqual(ci.array(), ["A", "b"]);
  // unique/distinct without key keep the historical JSON-value dedupe.
  assert.deepEqual(createDataArray([1, 1, 2, 2, 3]).unique().array(), [1, 2, 3]);
  assert.deepEqual(createDataArray([1, 1, 2]).distinct().array(), [1, 2]);
  assert.deepEqual(createDataArray([{a: 1}, {a: 1}]).unique().array(), [{a: 1}]);
  assert.deepEqual(createDataArray([]).distinct().array(), []);
});

test("groupIn keeps its existing (single-group) shape", () => {
  const groups = createDataArray([1, 2]).groupIn();
  assert.equal(groups.length, 1);
  assert.equal(typeof groups[0].rows.array, "function");
  assert.deepEqual(groups[0].rows.array(), [1, 2]);
});

// ══════════════════════════════════════════════════════════════════════════
// to / expand
// ══════════════════════════════════════════════════════════════════════════

test("to: dotted path, one-level flatten, nullish filtering", () => {
  const arr = createDataArray(PAGES);
  assert.deepEqual(arr.to("file.name").array(), ["a", "b", "c"]);
  assert.deepEqual(arr.to("file.tags").array(), ["#x", "#y", "#y"]);
  assert.deepEqual(arr.to("genres").array(), ["g1", "g2"]);
  // Explicit call: always a DataArray, even with no hits.
  const empty = arr.to("nope");
  assert.equal(typeof empty.array, "function");
  assert.deepEqual(empty.array(), []);
  // Never flattens more than one level, and drops null/undefined values.
  assert.deepEqual(createDataArray([{a: [1, 2]}, {a: null}, {}, {a: 3}]).to("a").array(), [1, 2, 3]);
});

test("expand: depth-first, flat, skips nodes without the key", () => {
  const tree = [
    {id: 1, children: [{id: 2, children: [{id: 3}]}, {id: 4}]},
    {id: 5},
  ];
  // Upstream parity: a node without a non-null `key` is skipped entirely, so
  // only branch nodes appear (leaves 3, 4, 5 have no `children`).
  assert.deepEqual(createDataArray(tree).expand("children").array().map((n) => n.id), [1, 2]);
  // Loose leaves (objects holding the key) are visited too.
  const nested = [{id: 1, sub: {id: 2, sub: {id: 3}}}];
  assert.deepEqual(createDataArray(nested).expand("sub").array().map((n) => n.id), [1, 2]);
  // subtasks alias used by the docs.
  const tasks = [{id: "t1", subtasks: [{id: "t2", subtasks: []}]}];
  assert.deepEqual(createDataArray(tasks).expand("subtasks").array().map((t) => t.id), ["t1", "t2"]);
  // Source-order siblings (upstream's LIFO stack reverses them — documented deviation).
  const wide = [{id: "p", children: [{id: "c1"}, {id: "c2"}, {id: "c3"}]}];
  assert.deepEqual(createDataArray(wide).expand("children").array().map((n) => n.id), ["p"]);
  const wideKids = [{id: "p", children: [{id: "c1", children: []}, {id: "c2", children: []}]}];
  assert.deepEqual(createDataArray(wideKids).expand("children").array().map((n) => n.id), ["p", "c1", "c2"]);
  assert.deepEqual(createDataArray(tree).expand("nope").array(), []);
});

// ══════════════════════════════════════════════════════════════════════════
// aggregations
// ══════════════════════════════════════════════════════════════════════════

test("sum/min/max/avg/mean/median/total with and without a field spec", () => {
  const arr = createDataArray([1, 2, 3, 4]);
  assert.equal(arr.sum(), 10);
  assert.equal(arr.avg(), 2.5);
  assert.equal(arr.mean(), 2.5);
  assert.equal(arr.median(), 2.5);
  assert.equal(arr.min(), 1);
  assert.equal(arr.max(), 4);
  assert.equal(arr.total(), 10);
  const objs = createDataArray([{n: 4}, {n: "2"}, {n: null}, {n: 6}]);
  // Legacy semantics (unchanged): non-finite values are dropped, but `null`
  // coerces to 0 via Number(), so it counts as a zero sample.
  assert.equal(objs.sum("n"), 12);
  assert.equal(objs.avg("n"), 3);
  assert.equal(objs.mean((o) => o.n), 3);
  assert.equal(objs.median("n"), 3);
  assert.equal(objs.min("n"), 0);
  assert.equal(objs.max((o) => o.n), 6);
  assert.equal(createDataArray([]).sum(), 0);
  assert.equal(createDataArray([]).avg(), 0);
  assert.equal(createDataArray([1, 2, 3]).median(), 2);
  assert.equal(createDataArray([true, true]).total(), 2);
});

// ══════════════════════════════════════════════════════════════════════════
// performance — swizzling must stay in the same ballpark as a manual map
// ══════════════════════════════════════════════════════════════════════════

test("[perf] 1000-element pages.file.name vs manual map", () => {
  const N = 1000;
  const reps = 100;
  const pages = Array.from({length: N}, (_, i) => ({file: {name: `f${i}`, tags: ["#a", "#b"]}}));
  const arr = createDataArray(pages);

  // Round-robin so every candidate sees the same machine load (node --test runs
  // test files in parallel, so wall-clock ratios drift under contention).
  const loop = (fn) => () => {
    let acc = 0;
    for (let i = 0; i < reps; i++) acc += fn();
    return acc;
  };
  const cases = {
    swizzle: loop(() => arr.file.name.length),
    singleMap: loop(() => pages.map((p) => p.file.name).length),
    doubleMap: loop(() => pages.map((p) => p.file).map((f) => f.name).length),
    createOnly: loop(() => createDataArray(pages).length),
  };
  const names = Object.keys(cases);

  for (let i = 0; i < 20; i++) for (const n of names) cases[n](); // warm up

  const best = {};
  for (let round = 0; round < 5; round++) {
    for (const n of names) {
      const t0 = process.hrtime.bigint();
      const acc = cases[n]();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
      if (!(n in best) || ms < best[n].ms) best[n] = {ms, acc};
    }
  }

  const sameWorkRatio = best.swizzle.ms / best.doubleMap.ms;
  const perEl = (x) => (x * 1e6 / N).toFixed(1);
  console.log(
    `[perf] N=${N} reps=${reps} best-of-5 round-robin | instance createDataArray: ${(best.createOnly.ms * 1000).toFixed(2)}us (${perEl(best.createOnly.ms)}ns/el) | ` +
      `swizzle arr.file.name: ${(best.swizzle.ms * 1000).toFixed(2)}us (${perEl(best.swizzle.ms)}ns/el, 2 traversals) | ` +
      `manual 1-pass map: ${(best.singleMap.ms * 1000).toFixed(2)}us (${(best.swizzle.ms / best.singleMap.ms).toFixed(2)}x) | ` +
      `manual 2-pass map: ${(best.doubleMap.ms * 1000).toFixed(2)}us (${sameWorkRatio.toFixed(2)}x, same traversal count)`,
  );

  assert.equal(best.swizzle.acc, N * reps);
  assert.equal(best.singleMap.acc, N * reps);
  assert.equal(best.createOnly.acc, N * reps);
  // Catastrophic-regression guards, phrased relative to a neighbouring
  // measurement so parallel test-file load cancels out:
  //  - instance creation must stay a minor fraction of one 1000-element map
  //    (a per-instance 50-closure table used to cost ~20us, i.e. 1.7x a map)
  //  - two swizzle traversals must stay within a small multiple of two maps
  assert.ok(
    best.createOnly.ms < best.singleMap.ms / 2,
    `per-instance cost ${(best.createOnly.ms * 1000).toFixed(2)}us is not negligible vs a map`,
  );
  assert.ok(sameWorkRatio < 5, `same-work ratio ${sameWorkRatio.toFixed(2)}x exceeds 5x`);
});
