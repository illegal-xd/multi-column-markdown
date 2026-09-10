/**
 * Lossless write-back tests: edits must change only what was asked, keeping
 * unknown tokens, comments, blank lines and marker spacing byte-identical.
 * These guarantees are what make in-place document edits (the column editor)
 * safe to perform on a user's file.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-patch-"));
execSync(
  "npx esbuild src/core/patch.ts --bundle --format=esm --outfile=" + join(dir, "patch.mjs") +
  " && npx esbuild src/core/parser.ts --bundle --format=esm --outfile=" + join(dir, "parser.mjs") +
  " && npx esbuild src/core/tree.ts --bundle --format=esm --outfile=" + join(dir, "tree.mjs"),
  {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
);

const P = await import(join(dir, "patch.mjs"));
const {findColumnRegions} = await import(join(dir, "parser.mjs"));
const {parseRegionTree, findNodeAtPath, absoluteSpan, rebaseRegion} = await import(join(dir, "tree.mjs"));

const DOC = [
  "# Title", "",
  "%% col-start:l:stack,b:secondary %%",
  "%% col-break:40,zz:9,b:secondary %%",
  "Left <!-- keep me -->", "",
  "%% col-break:60,tc:red %%",
  "Right",
  "",
  "%% col-end %%",
  "", "Tail text",
].join("\n");

const region = () => findColumnRegions(DOC)[0];
const edit = (e) => e;
const applied = (e) => P.applyEdits(DOC, [e]);

test("marker patch keeps unknown tokens and neighbouring tokens intact", () => {
  const e = edit(P.patchColumnMarker(DOC, region(), 0, {style: {background: "primary"}}));
  assert.equal(DOC.slice(e.from, e.to), "%% col-break:40,zz:9,b:secondary %%");
  assert.equal(e.text, "%% col-break:40,zz:9,b:primary %%");
});

test("marker patch preserves unusual spacing and token order", () => {
  const doc = "%% col-start %%\n%%col-break:40%%\nA\n%% col-end %%";
  const e = P.patchColumnMarker(doc, findColumnRegions(doc)[0], 0, {widthPercent: 75});
  assert.equal(e.text, "%%col-break:75%%");
});

test("marker patch preserves full-width commas", () => {
  const doc = "%% col-start %%\n%% col-break:40，b:pink %%\nA\n%% col-end %%";
  const e = P.patchColumnMarker(doc, findColumnRegions(doc)[0], 0, {widthPercent: 30});
  assert.equal(e.text, "%% col-break:30，b:pink %%");
});

test("setting a style twice is idempotent", () => {
  const once = applied(P.patchColumnMarker(DOC, region(), 0, {style: {background: "secondary", textColor: "red"}}));
  const twice = P.applyEdits(once, [P.patchColumnMarker(once, findColumnRegions(once)[0], 0, {
    style: {background: "secondary", textColor: "red"},
  })]);
  assert.equal(twice, once);
});

test("width 0 drops the width token instead of writing 0", () => {
  const e = P.patchColumnMarker(DOC, region(), 0, {widthPercent: 0});
  assert.equal(e.text, "%% col-break:zz:9,b:secondary %%");
});

test("clearing the style removes every style token, keeping unknown ones", () => {
  const e = P.patchColumnMarker(DOC, region(), 1, {style: {}});
  assert.equal(e.text, "%% col-break:60 %%");
});

test("container patch removes the layout token but keeps styles", () => {
  const e = P.patchContainerMarker(DOC, region(), {layout: "row"});
  assert.equal(DOC.slice(e.from, e.to), "%% col-start:l:stack,b:secondary %%");
  assert.equal(e.text, "%% col-start:b:secondary %%");
});

test("removing a column preserves comments, blank lines and remaining markers", () => {
  const after = applied(P.removeColumn(DOC, region(), 0));
  assert.equal(after, [
    "# Title", "",
    "%% col-start:l:stack,b:secondary %%",
    "%% col-break:60,tc:red %%",
    "Right",
    "",
    "%% col-end %%",
    "", "Tail text",
  ].join("\n"));
  assert.equal(findColumnRegions(after)[0].columns.length, 1);
});

test("inserting a column keeps surviving columns byte-identical", () => {
  const after = applied(P.insertColumn(DOC, region(), 1, {content: "", widthPercent: 0}));
  const lines = after.split("\n");
  assert.ok(after.includes("Left <!-- keep me -->"));
  assert.ok(after.includes("Right"));
  const markers = lines.filter((l) => l.startsWith("%% col-break"));
  assert.equal(markers.length, 3);
  assert.equal(markers[1], "%% col-break:tc:red %%", "existing token kept verbatim");
  assert.equal(markers[2], "%% col-break %%", "the new column is inserted after index 1");
  assert.equal(findColumnRegions(after)[0].columns.length, 3);
});

test("moving a column and moving it back restores the original document", () => {
  const moved = applied(P.moveColumn(DOC, region(), 0, 1));
  assert.notEqual(moved, DOC);
  const back = P.applyEdits(moved, [P.moveColumn(moved, findColumnRegions(moved)[0], 1, 0)]);
  assert.equal(back, DOC);
});

test("move/remove reject out-of-range requests instead of corrupting text", () => {
  assert.equal(P.moveColumn(DOC, region(), 0, 0), null);
  assert.equal(P.moveColumn(DOC, region(), 5, 0), null);
  assert.equal(P.removeColumn(DOC, region(), 9), null);
  assert.equal(P.insertColumn(DOC, region(), 9, {content: "", widthPercent: 0}), null);
});

test("applyEdits handles multiple non-overlapping edits", () => {
  const r = region();
  const after = P.applyEdits(DOC, [
    P.patchColumnMarker(DOC, r, 0, {widthPercent: 25}),
    P.patchColumnMarker(DOC, r, 1, {widthPercent: 75}),
  ]);
  assert.ok(after.includes("%% col-break:25,zz:9,b:secondary %%"));
  assert.ok(after.includes("%% col-break:75,tc:red %%"));
  assert.equal(findColumnRegions(after)[0].columns.map((c) => c.widthPercent).join(","), "25,75");
});

test("tree nodes carry absolute offsets for nested markers", () => {
  const doc = [
    "%% col-start %%",
    "%% col-break %%",
    "outer",
    "",
    "%% col-start %%",
    "%% col-break:40 %%",
    "inner",
    "%% col-end %%",
    "%% col-end %%",
    "",
  ].join("\n");
  const tree = parseRegionTree(doc);
  assert.equal(tree.length, 1);
  const child = tree[0].columns[0].childRegions[0];
  assert.ok(child, "nested region is reachable as a node");
  const span = absoluteSpan(child, child.region.columnMarkerOffsets[0]);
  assert.equal(doc.slice(span[0], span[1]), "%% col-break:40 %%");

  // Rebased to document coordinates, the nested marker patches correctly.
  const patched = P.applyEdits(doc, [
    P.patchColumnMarker(doc, rebaseRegion(child), 0, {widthPercent: 70}),
  ]);
  assert.ok(patched.includes("%% col-break:70 %%"));
  assert.ok(patched.includes("outer") && patched.includes("inner"));
  assert.equal((patched.match(/col-end/g) ?? []).length, 2);
  assert.equal(findColumnRegions(patched)[0].columns.length, 1);
});

test("findNodeAtPath resolves nested containers", () => {
  const doc = "%% col-start %%\n%% col-break %%\n%% col-start %%\n%% col-break %%\ninner\n%% col-end %%\n%% col-end %%\n";
  const root = parseRegionTree(doc)[0];
  assert.equal(findNodeAtPath(root, []), root, "an empty path is the root");
  const inner = findNodeAtPath(root, [{columnIndex: 0, regionIndex: 0}]);
  assert.ok(inner);
  assert.equal(inner.region.columns[0].content, "inner");
  assert.equal(findNodeAtPath(root, [{columnIndex: 3, regionIndex: 0}]), null);
  assert.equal(findNodeAtPath(root, [{columnIndex: 0, regionIndex: 9}]), null);
});
