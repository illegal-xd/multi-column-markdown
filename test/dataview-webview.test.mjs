/**
 * Preview-script tests (src/dataview/webview/main.ts).
 *
 * Only the parsing contract is asserted here: table fragments (`<td>`/`<th>`)
 * must be parsed with a `<tr>` context, because a document-context parse drops
 * the cell tags and the browser folds every cell's text into one anonymous cell
 * — the "all data in the first column" bug on large (windowed) tables. There is
 * no DOM in node, so the test drives the real code with a recording stub.
 *
 *   NODE_PATH=./test/helpers/node_modules node --test test/dataview-webview.test.mjs
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-webview-"));
try {
  execSync(
    "npx esbuild src/dataview/webview/main.ts --bundle --format=esm --outfile=" + join(dir, "webview.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
process.on("exit", () => rmSync(dir, {recursive: true, force: true}));

// ── DOM stub ──────────────────────────────────────────────────────────────
// Minimal surface for the module's activation path plus the fragment helpers.
const parsed = [];
const created = [];

globalThis.document = {
  body: {querySelectorAll: () => []},
  querySelectorAll: () => [],
  createElement(tag) {
    const el = {tagName: String(tag).toUpperCase(), getAttribute: () => null, classList: {contains: () => false}};
    created.push(el);
    return el;
  },
  createRange() {
    // `createContextualFragment` parses in the context of the range's start
    // container, so the stub records what the caller selected.
    let context = null;
    return {
      selectNodeContents(node) {
        context = node;
      },
      createContextualFragment(markup) {
        parsed.push({contextTag: context?.tagName ?? null, markup});
        return {childNodes: []};
      },
    };
  },
};
globalThis.window = {addEventListener() {}, scrollY: 0, scrollTo() {}, requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {}};

const {tableFragment, cellFragment} = await import(join(dir, "webview.mjs"));

// ── tests ─────────────────────────────────────────────────────────────────

test("table fragments parse with a <tr> context, never with the document", () => {
  tableFragment("<th>head</th>");
  cellFragment("<td>cell</td>");
  cellFragment("bare");
  assert.equal(parsed.length, 3, "every fragment must go through the contextual parser");
  assert.deepEqual(
    parsed.map((p) => p.contextTag),
    ["TR", "TR", "TR"],
    "a null/undefined context means a document-context parse (cells would be dropped)",
  );
  // The original markup is preserved (no double-escaping, no rewrapping).
  assert.equal(parsed[0].markup, "<th>head</th>");
  assert.equal(parsed[1].markup, "<td>cell</td>");
  // Contract drift guard: a bare payload still becomes a cell.
  assert.equal(parsed[2].markup, "<td>bare</td>");
  // One reusable detached context element (never inserted into the document).
  assert.equal(created.length, 1);
  assert.equal(created[0].tagName, "TR");
});
