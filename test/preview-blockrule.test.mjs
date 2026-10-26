/**
 * Block-ruler cost and semantics guards.
 *
 * `columnsBlockRule` runs at *every* block start of the document (markdown-it
 * probes its rulers per block), so its hot path must be O(1) for ordinary
 * lines. It used to slice the whole remaining document on every probe, which
 * made a preview render quadratic in document length (measured: +169ms for a
 * 3200-line document). These tests pin the shape of that path without needing
 * `dist/` — the plugin is bundled into a temp dir, exactly like
 * `benchmark.test.mjs` does for the parser.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";

const root = new URL("..", import.meta.url).pathname;
const require = createRequire(join(root, "package.json"));
const MarkdownIt = require("markdown-it");

const dir = mkdtempSync(join(tmpdir(), "amc-blockrule-"));
// `preview/embed.ts` imports `vscode`; the render path never calls into it for
// these cases, so a stub is enough to make the bundle loadable in Node.
const stub = join(dir, "vscode-stub.mjs");
writeFileSync(
  stub,
  [
    "export const workspace = {workspaceFolders: []};",
    "export const commands = {executeCommand: () => Promise.resolve()};",
    "export const window = {};",
    "export const Uri = {};",
    "export default {workspace, commands, window, Uri};",
    "",
  ].join("\n"),
);
execSync(
  `npx esbuild src/preview/markdownItPlugin.ts --bundle --format=esm --platform=node --alias:vscode=${stub} --outfile=${join(dir, "plugin.mjs")}`,
  {cwd: root, stdio: "pipe"},
);
const {installColumnsMarkdownItPlugin, getColumnHtmlCacheStats} = await import(join(dir, "plugin.mjs"));

const createMd = (withPlugin) => {
  const md = new MarkdownIt({html: true});
  if (withPlugin) installColumnsMarkdownItPlugin(md);
  return md;
};

/**
 * VSCode's preview marks every top-level block with `data-line` (that attribute
 * is what the preview's scroll sync and `anchor.ts` read). Reproduce that here
 * so the column renderer's line arithmetic is exercised without the real host.
 */
const withSourceLines = (md) => {
  md.core.ruler.push("fake_source_line", (state) => {
    for (const token of state.tokens) {
      if (token.map && token.level === 0) token.attrSet("data-line", String(token.map[0]));
    }
  });
  return md;
};

const plainDoc = (paragraphs) =>
  Array.from({length: paragraphs}, (_, i) => `Paragraph ${i} with **bold** and \`code\` here.\n`).join("\n");
const columnBlocks = (count) =>
  Array.from(
    {length: count},
    (_, i) => `%% col-start %%\n%% col-break %%\nLeft ${i}\n%% col-break %%\nRight ${i}\n%% col-end %%`,
  ).join("\n\n");
const timeRender = (md, src, iterations) => {
  md.render(src, {}); // warm the rules/JIT
  const start = performance.now();
  for (let i = 0; i < iterations; i++) md.render(src, {});
  return (performance.now() - start) / iterations;
};

/** `data-line` values in DOM order for containers / columns / column paragraphs. */
const collect = (html, re) => Array.from(html.matchAll(re), (m) => Number(m[1]));
const containerLines = (html) => collect(html, /class="columns-container[^"]*" data-line="(\d+)"/g);
const columnLines = (html) => collect(html, /<div class="column-item[^"]*" data-line="(\d+)"/g);
const textLines = (html) =>
  collect(html, /<p data-line="(\d+)">(?:Left|Right|outer|innerA|innerB|right)<\/p>/g);

test("block ruler: column output stays correct", () => {
  const md = createMd(true);
  const html = md.render(columnBlocks(3), {});
  assert.equal((html.match(/class="columns-container/g) ?? []).length, 3);
  assert.equal((html.match(/class="column-item"/g) ?? []).length, 6);
  assert.ok(html.includes("Left 2") && html.includes("Right 2"));

  const nested = md.render(
    "%% col-start %%\n%% col-break %%\nouter\n\n%% col-start %%\n%% col-break %%\ninner\n%% col-end %%\n%% col-end %%\n",
    {},
  );
  assert.equal((nested.match(/columns-container/g) ?? []).length, 2, "nesting survives the gate");
});

test("data-line: column HTML carries document-absolute line numbers", () => {
  const md = withSourceLines(createMd(true));
  //  0 intro
  //  1 (blank)
  //  2 %% col-start %%
  //  3 %% col-break %%
  //  4 Left
  //  5 %% col-break %%
  //  6 Right
  //  7 %% col-end %%
  const html = md.render("intro\n\n%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%\n", {});

  assert.deepEqual(containerLines(html), [2], "container points at the col-start line");
  assert.deepEqual(columnLines(html), [4, 6], "each column points at its first content line");
  // Nested renders start at 0; the column rebase must shift them into the document.
  assert.deepEqual(textLines(html), [4, 6], "blocks inside columns are shifted, not left relative");
});

test("data-line: nesting is rebased once per column boundary", () => {
  const md = withSourceLines(createMd(true));
  //  0 %% col-start %%
  //  1 %% col-break %%
  //  2 outer
  //  3 (blank)
  //  4 %% col-start %%   <- nested
  //  5 %% col-break %%
  //  6 innerA
  //  7 %% col-break %%
  //  8 innerB
  //  9 %% col-end %%
  // 10 %% col-break %%
  // 11 right
  // 12 %% col-end %%
  const html = md.render(
    "%% col-start %%\n%% col-break %%\nouter\n\n%% col-start %%\n%% col-break %%\ninnerA\n%% col-break %%\ninnerB\n%% col-end %%\n%% col-break %%\nright\n%% col-end %%\n",
    {},
  );

  assert.deepEqual(containerLines(html), [0, 4], "nested container line must not be double-shifted");
  assert.deepEqual(columnLines(html), [2, 6, 8, 11]);
  assert.deepEqual(textLines(html), [2, 6, 8, 11]);
});

test("block ruler: a marker line directly after a paragraph still renders", () => {
  const md = createMd(true);
  // Regression: the silent (terminator) probe used to answer "no block here",
  // so the paragraph rule kept the marker line as paragraph text.
  const html = md.render(
    "hello world\n%% col-start %%\n%% col-break %%\nAAA\n%% col-break %%\nBBB\n%% col-end %%\n",
    {},
  );
  assert.equal((html.match(/class="column-item"/g) ?? []).length, 2);
  assert.ok(!html.includes("%% col-start %%"), "markers must not leak as text");
  assert.ok(html.includes("AAA") && html.includes("BBB"));

  // A malformed (unclosed) block must keep rendering as plain text.
  const unclosed = md.render("hello world\n%% col-start %%\n%% col-break %%\nUnclosed\n", {});
  assert.ok(unclosed.includes("col-start"));
});

test("column HTML cache: unchanged columns are not re-rendered", () => {
  const md = withSourceLines(createMd(true));
  const doc = "intro\n\n%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%\n";

  const first = md.render(doc, {});
  const second = md.render(doc, {});
  assert.equal(first, second, "cached output must be byte-identical");
  const stats = getColumnHtmlCacheStats(md);
  assert.ok(stats.hits >= 2, `expected both columns to hit the cache, got ${stats.hits}`);
  assert.equal(stats.size, 2, "one entry per column text");
});

test("column HTML cache: a cache hit still rebases data-line", () => {
  const md = withSourceLines(createMd(true));
  const region = "%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%\n";

  const atTop = md.render(region, {});
  // Same column text, moved down by one paragraph + blank line.
  const shifted = md.render(`intro\n\nintro2\n\n${region}`, {});

  assert.deepEqual(textLines(atTop), [2, 4]);
  assert.deepEqual(textLines(shifted), [6, 8], "cache hit must still shift lines to the document position");
  assert.ok(getColumnHtmlCacheStats(md).hits >= 2, "the second render reused the cached column HTML");
});

test("column HTML cache: dynamic columns are never cached", () => {
  const md = createMd(true);
  // `![[note]]` output depends on the target file, not on this text.
  const doc = "%% col-start %%\n%% col-break %%\n![[note]]\n%% col-break %%\nplain\n%% col-end %%\n";
  md.render(doc, {});
  const stats = getColumnHtmlCacheStats(md);
  assert.equal(stats.size, 1, "only the plain column is cacheable");
});

test("block ruler: ordinary documents do not pay a growing probe cost", () => {
  const small = plainDoc(200);
  const large = plainDoc(1600); // ~3200 lines
  const baseSmall = timeRender(createMd(false), small, 10);
  const plugSmall = timeRender(createMd(true), small, 10);
  const baseLarge = timeRender(createMd(false), large, 10);
  const plugLarge = timeRender(createMd(true), large, 10);

  // Guard against the quadratic regression: 8x the document must not cost
  // orders of magnitude more overhead. The old code went +12ms -> +169ms.
  assert.ok(
    plugLarge - baseLarge < 25,
    `large-document overhead too high: ${(plugLarge - baseLarge).toFixed(1)}ms (base ${baseLarge.toFixed(1)}ms)`,
  );
  assert.ok(
    plugLarge - baseLarge < 5 * Math.max(plugSmall - baseSmall, 0.5) + 10,
    `overhead grew superlinearly: small ${(plugSmall - baseSmall).toFixed(1)}ms -> large ${(plugLarge - baseLarge).toFixed(1)}ms`,
  );

  // Behaviour is asserted on the same instance: the gate must not swallow regions.
  const md = createMd(true);
  const html = md.render(columnBlocks(2), {});
  assert.equal((html.match(/class="column-item"/g) ?? []).length, 4);
});
