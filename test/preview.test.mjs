/**
 * Preview rendering tests: loads the built extension bundle (with a vscode
 * mock), exercises the extendMarkdownIt path, and asserts column HTML:
 * structure, widths, style tokens, spacing tokens (pd/ml/mt/mr/mb),
 * separators, wikilinks and the demo file.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
import {execSync} from "node:child_process";

// Ensure dist is fresh (tests run against the real bundle).
execSync("node esbuild.mjs", {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"});

const require = createRequire(new URL("./helpers/", import.meta.url));
const MarkdownIt = require("/Users/allen/Desktop/github/multi-column-markdown/node_modules/markdown-it");
const ext = require("/Users/allen/Desktop/github/multi-column-markdown/dist/extension.js");

const api = ext.activate({subscriptions: {push() {}}});
assert.equal(typeof api.extendMarkdownIt, "function");

const md = new MarkdownIt({html: true});
api.extendMarkdownIt(md);

const render = (doc) => md.render(doc);

test("basic two columns render", () => {
  const html = render("%% col-start %%\n%% col-break %%\nLeft **bold**\n%% col-break %%\nRight\n%% col-end %%");
  assert.ok(html.includes('class="columns-container columns-ui columns-reading"'));
  assert.equal((html.match(/class="column-item"/g) ?? []).length, 2);
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(!html.includes("col-start"));
});

test("width + style render", () => {
  const html = render("%% col-start %%\n%% col-break:40,b:secondary,bc:blue %%\nA\n%% col-break:60 %%\nB\n%% col-end %%");
  assert.ok(html.includes("flex: 0 0 calc(40% - 4.0px)"));
  assert.ok(html.includes("--columns-col-bg"));
  assert.ok(html.includes("--columns-col-border-color:#3b82f6"));
});

test("nested render", () => {
  const html = render("%% col-start %%\n%% col-break %%\nOuter\n%% col-break %%\n%% col-start %%\n%% col-break %%\nInner\n%% col-end %%\n%% col-end %%");
  assert.ok((html.match(/columns-container/g) ?? []).length >= 2);
  assert.ok(html.includes("Inner"));
});

test("stack group render", () => {
  const html = render("%% col-start %%\n%% col-break:40,stk:1 %%\nS1\n%% col-break:stk:1 %%\nS2\n%% col-break:60 %%\nWide\n%% col-end %%");
  assert.ok(html.includes('class="columns-stack-group"'));
  assert.ok(html.includes("calc(40% - 4.0px)"));
});

test("separator render (left column carries style)", () => {
  const html = render("%% col-start %%\n%% col-break:sep:1,sc:red,ss:dashed %%\nA\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(html.includes("column-separator-visual"));
  assert.ok(html.includes("--sep-color:#ef4444"));
});

test("wikilink + embed render", () => {
  const html = render("[[note|Note]] and ![[img.png]]");
  assert.ok(html.includes('href="note.md"'));
  assert.ok(html.includes(">Note</a>"));
  assert.ok(html.includes('src="img.png"'));
});

test("unclosed region kept as text", () => {
  const html = render("%% col-start %%\n%% col-break %%\nUnclosed");
  assert.ok(html.includes("col-start"));
});

test("spacing tokens render as CSS vars", () => {
  const html = render("%% col-start %%\n%% col-break:pd:8,ml:10,mt:2px,mr:0.5em,mb:0 %%\n**A**\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(html.includes("--columns-col-padding:8px"));
  assert.ok(html.includes("--columns-col-ml:10px"));
  assert.ok(html.includes("--columns-col-mt:2px"));
  assert.ok(html.includes("--columns-col-mr:0.5em"));
  assert.ok(html.includes("--columns-col-mb:0px"));
  // 仅带样式的列输出 spacing 变量
  assert.equal((html.match(/--columns-col-padding/g) ?? []).length, 1);
});

test("plain columns emit no spacing vars", () => {
  const html = render("%% col-start %%\n%% col-break %%\nA\n%% col-end %%");
  assert.ok(!html.includes("--columns-col-padding"));
  assert.ok(!html.includes("--columns-col-ml"));
});

test("demo file parses and renders", () => {
  const demo = readFileSync(new URL("../test/preview.md", import.meta.url), "utf8");
  const html = render(demo);
  assert.ok((html.match(/columns-container/g) ?? []).length > 10);
  assert.ok(html.includes("column-separator-visual"));
  assert.ok(html.includes("columns-stack-group"));
  assert.ok(html.includes("columns-custom-style"));
});
