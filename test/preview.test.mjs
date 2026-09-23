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
api.extendMarkdownIt(md);

const render = (doc) => md.render(doc);

test("installing the preview plugin twice does not duplicate rules", () => {
  const rules = md.inline.ruler.__rules__;
  assert.equal(rules.filter((rule) => rule.name === "amc_wikilink").length, 1);
  assert.equal(rules.filter((rule) => rule.name === "amc_wikilink_embed").length, 1);
  assert.equal(md.block.ruler.__rules__.filter((rule) => rule.name === "amc_columns").length, 1);
  assert.equal(md.core.ruler.__rules__.filter((rule) => rule.name === "amc-task-lists").length, 1);
});

test("basic two columns render", () => {
  const html = render("%% col-start %%\n%% col-break %%\nLeft **bold**\n%% col-break %%\nRight\n%% col-end %%");
  assert.ok(html.includes('class="columns-container columns-ui columns-reading"'));
  assert.equal((html.match(/class="column-item"/g) ?? []).length, 2);
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(!html.includes("col-start"));
});

test("width + style render", () => {
  const html = render("%% col-start %%\n%% col-break:40,b:secondary,bc:blue %%\nA\n%% col-break:60 %%\nB\n%% col-end %%");
  assert.ok(html.includes("flex: 0 0 calc(40% - 2.5px)"));
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
  assert.ok(html.includes("calc(40% - 2.5px)"));
});

test("gap token renders container var + adjusts shrink", () => {
  const html = render("%% col-start:g:12 %%\n%% col-break:40 %%\nA\n%% col-break:60 %%\nB\n%% col-end %%");
  assert.ok(html.includes("--columns-block-gap:12px"));
  assert.ok(html.includes("flex: 0 0 calc(40% - 6.0px)"));
});

test("no gap token → default shrink (5px gap)", () => {
  const html = render("%% col-start %%\n%% col-break:40 %%\nA\n%% col-break:60 %%\nB\n%% col-end %%");
  assert.ok(html.includes("flex: 0 0 calc(40% - 2.5px)"));
  assert.ok(!html.includes("--columns-block-gap"));
});

test("separator render (left column carries style)", () => {
  const html = render("%% col-start %%\n%% col-break:sep:1,sc:red,ss:dashed %%\nA\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(html.includes("column-separator-visual"));
  assert.ok(html.includes("--sep-color:#ef4444"));
});

test("separator width is compensated in column shrink (no overflow)", () => {
  const html = render("%% col-start %%\n%% col-break:50,sep:1 %%\nA\n%% col-break:50 %%\nB\n%% col-end %%");
  // shrink = (sepW 8 + gap 5 + gap 5) / 2 cols = 9px → 50% - 9px each + 8px sep + 10px gaps = 100%
  assert.ok(html.includes("flex: 0 0 calc(50% - 9.0px)"));
});

test("custom separator width is compensated in shrink", () => {
  const html = render("%% col-start %%\n%% col-break:50,sep:1,ss:custom,sx:→ %%\nA\n%% col-break:50 %%\nB\n%% col-end %%");
  // custom sep default size 12px → shrink = (12 + 5 + 5) / 2 = 11px
  assert.ok(html.includes("flex: 0 0 calc(50% - 11.0px)"));
});

test("three columns with two separators stay within 100%", () => {
  const html = render("%% col-start %%\n%% col-break:40,sep:1 %%\nA\n%% col-break:30,sep:1 %%\nB\n%% col-break:30 %%\nC\n%% col-end %%");
  // shrink = (2*(8+5) + 2*5) / 3 = 12px → 40% - 12px
  assert.ok(html.includes("flex: 0 0 calc(40% - 12.0px)"));
  assert.ok(html.includes("flex: 0 0 calc(30% - 12.0px)"));
});

test("no sep token → shrink unaffected (default gap only)", () => {
  const html = render("%% col-start %%\n%% col-break:50 %%\nA\n%% col-break:50 %%\nB\n%% col-end %%");
  assert.ok(html.includes("flex: 0 0 calc(50% - 2.5px)"));
});

test("wikilink alias and heading render", () => {
  const html = render("[[docs/guide#Setup Here|Read guide]]");
  assert.ok(html.includes('href="/docs/guide.md#setup-here"'));
  assert.ok(html.includes(">Read guide</a>"));
});

test("wikilink paths with an extension do not duplicate .md", () => {
  const html = render("[[docs/guide.md|Guide]]");
  assert.ok(html.includes('href="/docs/guide.md"'));
  assert.ok(!html.includes("guide.md.md"));
});

test("vault paths stay workspace-root-relative from any folder", () => {
  // `p.file.path` handed to `[[…]]` is workspace-relative ("preview/preview.md").
  // Resolved against the document directory instead, a page in preview/ would look
  // for preview/preview/preview.md, so folder paths are anchored with a leading "/".
  const html = render("[[preview/preview.md|preview.md]]");
  assert.ok(html.includes('href="/preview/preview.md"'), html);
  assert.ok(html.includes(">preview.md</a>"));
});

test("wikilink + image embed render", () => {
  const html = render("[[note|Note]] and ![[img.png|Diagram]]");
  assert.ok(html.includes('href="note.md"'));
  assert.ok(html.includes(">Note</a>"));
  assert.ok(html.includes('src="img.png"'));
  assert.ok(html.includes('alt="Diagram"'));
});

test("unresolvable markdown embeds fall back to an image tag", () => {
  // No workspace folder is configured here, so the target cannot be read.
  // The real expansion / cycle / budget behaviour is covered by
  // embed.test.mjs, which runs against a temporary workspace.
  const html = render("![[cycle.md]]");
  assert.ok(html.includes('class="amc-embed"'));
  assert.ok(!html.includes("amc-embed-cycle"));
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
  const demo = readFileSync(new URL("../preview/preview.md", import.meta.url), "utf8");
  const html = render(demo);
  assert.ok((html.match(/columns-container/g) ?? []).length > 10);
  assert.ok(html.includes("column-separator-visual"));
  assert.ok(html.includes("columns-stack-group"));
  assert.ok(html.includes("columns-custom-style"));
});

test("text-align token renders column text-align var", () => {
  const html = render("%% col-start %%\n%% col-break:ta:center %%\nA\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(html.includes("--columns-col-text-align:center"));
});

test("text-align co-exists with width and other style tokens", () => {
  const html = render("%% col-start %%\n%% col-break:40,ta:right,b:secondary %%\nA\n%% col-break:60 %%\nB\n%% col-end %%");
  assert.ok(html.includes("flex: 0 0 calc(40% - 2.5px)"));
  assert.ok(html.includes("--columns-col-bg"));
  assert.ok(html.includes("--columns-col-text-align:right"));
});

test("bc:transparent renders transparent border color", () => {
  const html = render("%% col-start %%\n%% col-break:bc:transparent,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-color:transparent"));
});

test("border-radius token renders radius var", () => {
  const html = render("%% col-start %%\n%% col-break:br:12 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-radius:12px"));
});

test("border-radius co-exists with width and other style tokens", () => {
  const html = render("%% col-start %%\n%% col-break:40,br:8,b:secondary %%\nA\n%% col-break:60 %%\nB\n%% col-end %%");
  assert.ok(html.includes("flex: 0 0 calc(40% - 2.5px)"));
  assert.ok(html.includes("--columns-col-radius:8px"));
});

test("margin shorthand renders margin var", () => {
  const html = render("%% col-start %%\n%% col-break:m:12 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-margin:12px"));
});

test("border-width renders border-width var (replaces default 1px)", () => {
  const html = render("%% col-start %%\n%% col-break:bw:2,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:2px"));
});

test("border-width alone triggers border display", () => {
  const html = render("%% col-start %%\n%% col-break:bw:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:1px"));
});

test("border-width directional tokens render per-side vars", () => {
  const html = render("%% col-start %%\n%% col-break:bwl:2,bwt:0,bwr:2,bwb:0,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width-l:2px"));
  assert.ok(html.includes("--columns-col-border-width-t:0px"));
  assert.ok(html.includes("--columns-col-border-width-r:2px"));
  assert.ok(html.includes("--columns-col-border-width-b:0px"));
});

test("border-radius directional tokens render corner vars (brl → tl+bl)", () => {
  const html = render("%% col-start %%\n%% col-break:brl:8 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-radius-tl:8px"));
  assert.ok(html.includes("--columns-col-radius-bl:8px"));
});

test("border-radius directional tokens: brt → tl+tr", () => {
  const html = render("%% col-start %%\n%% col-break:brt:10 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-radius-tl:10px"));
  assert.ok(html.includes("--columns-col-radius-tr:10px"));
});

test("per-side border width alone: other sides stay 0px (no default 1px)", () => {
  const html = render("%% col-start %%\n%% col-break:bwt:3,bc:green %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:0px"));
  assert.ok(html.includes("--columns-col-border-width-t:3px"));
});

test("per-side border width + explicit sb:1: other sides stay 0px", () => {
  const html = render("%% col-start %%\n%% col-break:bwl:2,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:0px"));
  assert.ok(html.includes("--columns-col-border-width-l:2px"));
});

test("bw shorthand + per-side: shorthand applies to unspecified sides", () => {
  const html = render("%% col-start %%\n%% col-break:bw:2,bwl:5 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:2px"));
  assert.ok(html.includes("--columns-col-border-width-l:5px"));
});

test("sb:0 wins over bw (explicit off suppresses border vars)", () => {
  const html = render("%% col-start %%\n%% col-break:bw:2,sb:0 %%\nA\n%% col-end %%");
  assert.ok(!html.includes("--columns-col-border-width:"));
});

test("bc alone still defaults to 1px border", () => {
  const html = render("%% col-start %%\n%% col-break:bc:blue %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:1px"));
});

test("sb:1 alone still defaults to 1px border", () => {
  const html = render("%% col-start %%\n%% col-break:sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:1px"));
});

test("container bw renders block border-width var", () => {
  const html = render("%% col-start:bw:2 %%\n%% col-break %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-block-border-width:2px"));
});

test("container bw:0 + sb:1 → explicit bw wins (0px)", () => {
  const html = render("%% col-start:bw:0,sb:1 %%\n%% col-break %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-block-border-width:0px"));
});

test("container sb:0 suppresses block border vars", () => {
  const html = render("%% col-start:sb:0,bw:2 %%\n%% col-break %%\nA\n%% col-end %%");
  assert.ok(!html.includes("--columns-block-border-width"));
});

test("left-border mode defaults to 3px", () => {
  const html = render("%% col-start %%\n%% col-break:lb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-left-border-width:3px"));
});

test("left-border mode respects bwl override", () => {
  const html = render("%% col-start %%\n%% col-break:lb:1,bwl:5 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-left-border-width:5px"));
});

test("left-border mode respects bw shorthand", () => {
  const html = render("%% col-start %%\n%% col-break:lb:1,bw:2 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-left-border-width:2px"));
});

test("bw multi-value expands to per-side vars (bw:0 2)", () => {
  const html = render("%% col-start %%\n%% col-break:bw:0 2,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width:0px 2px"));
  assert.ok(html.includes("--columns-col-border-width-t:0px"));
  assert.ok(html.includes("--columns-col-border-width-b:0px"));
  assert.ok(html.includes("--columns-col-border-width-l:2px"));
  assert.ok(html.includes("--columns-col-border-width-r:2px"));
});

test("bw four-value shorthand expands correctly (bw:1 2 3 4)", () => {
  const html = render("%% col-start %%\n%% col-break:bw:1 2 3 4,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width-t:1px"));
  assert.ok(html.includes("--columns-col-border-width-r:2px"));
  assert.ok(html.includes("--columns-col-border-width-b:3px"));
  assert.ok(html.includes("--columns-col-border-width-l:4px"));
});

test("bw multi-value + per-side override (bw:0 2 + bwl:5)", () => {
  const html = render("%% col-start %%\n%% col-break:bw:0 2,bwl:5,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width-l:5px"));
  assert.ok(html.includes("--columns-col-border-width-t:0px"));
  assert.ok(html.includes("--columns-col-border-width-r:2px"));
});

test("bw multi-value + hd: top/bottom stay under hd control", () => {
  const html = render("%% col-start %%\n%% col-break:bw:0 2,hd:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-border-width-l:2px"));
  assert.ok(html.includes("--columns-col-border-width-r:2px"));
  assert.ok(!html.includes("--columns-col-border-width-t:0px"));
  assert.ok(html.includes("--columns-col-horizontal-width:1px"));
});

test("m multi-value expands to per-side vars (m:10 30)", () => {
  const html = render("%% col-start %%\n%% col-break:m:10 30 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-margin:10px 30px"));
  assert.ok(html.includes("--columns-col-mt:10px"));
  assert.ok(html.includes("--columns-col-mb:10px"));
  assert.ok(html.includes("--columns-col-ml:30px"));
  assert.ok(html.includes("--columns-col-mr:30px"));
});

test("m multi-value + directional override (m:10 30 + mt:5)", () => {
  const html = render("%% col-start %%\n%% col-break:m:10 30,mt:5 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-mt:5px"));
  assert.ok(html.includes("--columns-col-ml:30px"));
  assert.ok(html.includes("--columns-col-mb:10px"));
});

test("br multi-value expands to corner vars (br:4 8)", () => {
  const html = render("%% col-start %%\n%% col-break:br:4 8,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-radius:4px 8px"));
  assert.ok(html.includes("--columns-col-radius-tl:4px"));
  assert.ok(html.includes("--columns-col-radius-tr:8px"));
  assert.ok(html.includes("--columns-col-radius-br:4px"));
  assert.ok(html.includes("--columns-col-radius-bl:8px"));
});

test("br multi-value + per-side corner override (br:4 8 + brl:12)", () => {
  const html = render("%% col-start %%\n%% col-break:br:4 8,brl:12,sb:1 %%\nA\n%% col-end %%");
  assert.ok(html.includes("--columns-col-radius-tl:12px"));
  assert.ok(html.includes("--columns-col-radius-bl:12px"));
  assert.ok(html.includes("--columns-col-radius-tr:8px"));
});

test("previewStyle.css ships antd-style task checkbox rules (light + dark)", () => {
  const css = readFileSync(new URL("../media/previewStyle.css", import.meta.url), "utf8");
  // antd checkbox core: appearance-none box, checked fill + tick
  assert.ok(css.includes("input.task-list-item-checkbox"));
  assert.ok(css.includes("appearance: none"));
  assert.ok(css.includes("border-radius: 4px"));
  assert.ok(css.includes("input.task-list-item-checkbox:checked"));
  assert.ok(css.includes("rotate(45deg)"));
  // dark-theme adaptation
  assert.ok(css.includes("body.vscode-dark .columns-container .column-content input.task-list-item-checkbox"));
  // scoped to column content so VSCode default checkbox outside columns is untouched
  assert.ok(!css.includes("body.vscode-markdown-preview input.task-list-item-checkbox"));
});

test("task list items render as checkbox + label (in column)", () => {
  const html = render("%% col-start %%\n%% col-break %%\n- [ ] 待办 A\n- [x] 已完成 B\n%% col-end %%");
  assert.ok(html.includes('class="contains-task-list"'));
  assert.ok(html.includes('class="task-list-item"'));
  assert.ok(html.includes('class="task-list-item-checkbox"'));
  assert.ok(html.includes('class="task-list-item-label"'));
  // checked 项带 checked 属性
  assert.ok(html.includes('checked=""'));
  // 文本前缀 [ ] / [x] 被移除
  assert.ok(!html.includes("[ ]"));
  assert.ok(!html.includes("[x]"));
  assert.ok(html.includes("待办 A"));
  assert.ok(html.includes("已完成 B"));
});

test("task list items render outside columns too (global rule)", () => {
  const html = render("- [ ] 列外待办");
  assert.ok(html.includes("task-list-item-checkbox"));
  assert.ok(html.includes("列外待办"));
});

test("custom hex colors: b/bc/t/sc pass through", () => {
  const html = render("%% col-start %%\n%% col-break:b:#1f2937,bc:#3b82f6,t:#ffffff,sc:#ef4444,sep:1,sb:1 %%\nA\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(html.includes("--columns-col-bg:#1f2937"));
  assert.ok(html.includes("--columns-col-border-color:#3b82f6"));
  assert.ok(html.includes("--columns-col-text:#ffffff"));
  assert.ok(html.includes("--columns-col-sep-color:#ef4444"));
  // 列间分隔符使用自定义色
  assert.ok(html.includes("--sep-color:#ef4444"));
});

test("rgba colors are rejected (hex only), palette still works", () => {
  const html = render("%% col-start %%\n%% col-break:b:rgba(59,130,246,0.12),bc:blue %%\nA\n%% col-end %%");
  assert.ok(!html.includes("--columns-col-bg"));
  assert.ok(html.includes("--columns-col-border-color:#3b82f6"));
});

test("invalid custom colors are rejected (keeps palette behavior)", () => {
  const html = render("%% col-start %%\n%% col-break:b:notacolor,bc:#zzz %%\nA\n%% col-end %%");
  // 无自定义色变量输出；b/notacolor 不产生 bg 变量
  assert.ok(!html.includes("--columns-col-bg"));
  assert.ok(!html.includes("--columns-col-border-color:#zzz"));
});

test("default column radius is 0 (no 4px fallback)", () => {
  const css = readFileSync(new URL("../media/previewStyle.css", import.meta.url), "utf8");
  assert.ok(css.includes("border-radius: var(--columns-col-radius, 0);"));
  assert.ok(!css.includes("var(--columns-col-radius, 4px)"));
});

test("nesting past the depth cap keeps the content visible", () => {
  const nest = (depth) =>
    depth === 0 ? "DEEP TEXT" : `%% col-start %%\n%% col-break %%\n${nest(depth - 1)}\n%% col-end %%`;
  const html = render(nest(10));
  assert.ok(html.includes("DEEP TEXT"), "content must never be dropped silently");
  assert.ok(html.includes("amc-parse-fallback"), "the un-expanded level is marked");
});

test("the preview stylesheet styles the degradation markers", () => {
  const css = readFileSync(new URL("../media/previewStyle.css", import.meta.url), "utf8");
  for (const cls of [".amc-parse-fallback", ".amc-embed-cycle", ".amc-embed-limited"]) {
    assert.ok(css.includes(cls), `${cls} has no styles`);
  }
});

test("ruler and parser agree on a block with a nested example in the header zone", () => {
  // Regression: the ruler used to consume a different line range than the
  // parser produced, so the block rendered as literal text.
  const doc = [
    "%% col-start %%",
    "%% col-start %%",
    "ignored example",
    "%% col-end %%",
    "%% col-break %%",
    "Left",
    "%% col-end %%",
  ].join("\n");
  const html = render(doc);
  assert.equal((html.match(/columns-container/g) ?? []).length, 1);
  assert.ok(html.includes("Left"));
  assert.ok(!html.includes("ignored example"), "the header zone stays ignored");
});

test("fenced marker examples render as code, not as layout", () => {
  const html = render([
    "%% col-start %%",
    "%% col-break %%",
    "```",
    "%% col-start %%",
    "```",
    "%% col-end %%",
  ].join("\n"));
  assert.equal((html.match(/columns-container/g) ?? []).length, 1, "one column block, not two");
  assert.ok(html.includes("<pre><code>%% col-start %%"), "the example renders as a code block");
});

test("an empty column region renders no fallback wrapper", () => {
  const html = render("%% col-start %%\n%% col-break %%\n%% col-end %%");
  assert.ok(html.includes("columns-container"));
  assert.ok(!html.includes("amc-parse-fallback"));
});

test("responsive containers carry the columns-responsive class", () => {
  const html = render("%% col-start:responsive %%\n%% col-break:30 %%\nSidebar\n%% col-break:70 %%\nContent\n%% col-end %%");
  assert.ok(html.includes("columns-responsive"), "responsive class missing");
  assert.ok(html.includes("columns-container"), "base container class missing");
  // The authored width is still emitted inline — responsive is layout-only.
  assert.ok(html.includes("flex: 0 0 calc(30% - 2.5px)"), "width inline style must be preserved");
  assert.ok(html.includes("flex: 0 0 calc(70% - 2.5px)"));
  assert.equal((html.match(/columns-responsive/g) ?? []).length, 1);
});

test("plain containers never carry the responsive class", () => {
  const html = render("%% col-start %%\n%% col-break %%\nA\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(!html.includes("columns-responsive"));
  assert.equal((html.match(/columns-container/g) ?? []).length, 1);
});

test("nested containers do not inherit responsiveness from the parent", () => {
  const doc = [
    "%% col-start:responsive %%",
    "%% col-break %%",
    "Outer A",
    "%% col-break %%",
    "%% col-start %%",
    "%% col-break %%",
    "Inner 1",
    "%% col-break %%",
    "Inner 2",
    "%% col-end %%",
    "%% col-end %%",
  ].join("\n");
  const html = render(doc);
  assert.equal((html.match(/columns-responsive/g) ?? []).length, 1, "only the outer container is responsive");
  assert.equal((html.match(/columns-nested/g) ?? []).length, 1, "the inner container renders nested");
  assert.ok(html.includes("Inner 1") && html.includes("Inner 2"));
});

test("responsive + stack group renders both structures", () => {
  const doc = "%% col-start:responsive %%\n%% col-break:40,stk:1 %%\nS1\n%% col-break:stk:1 %%\nS2\n%% col-break:60 %%\nWide\n%% col-end %%";
  const html = render(doc);
  assert.ok(html.includes("columns-responsive"));
  assert.ok(html.includes("columns-stack-group"), "stack group wrapper must survive");
  assert.equal((html.match(/class="column-item"/g) ?? []).length, 3);
});

test("responsive + explicit stack layout keeps the stacked class", () => {
  const html = render("%% col-start:l:stack,responsive %%\n%% col-break %%\nA\n%% col-break %%\nB\n%% col-end %%");
  assert.ok(html.includes("columns-stacked"), "l:stack layout must be preserved");
  assert.ok(html.includes("columns-responsive"));
});

test("responsive + wikilink and image content render normally", () => {
  const html = render("%% col-start:responsive %%\n%% col-break %%\nSee [[page]] and ![[img.png]]\n%% col-end %%");
  assert.ok(html.includes("columns-responsive"));
  assert.ok(html.includes('href="page.md"'), "wikilink must render inside a responsive column");
  assert.ok(html.includes("<img"), "image embed must render inside a responsive column");
});

test("previewStyle.css ships the responsive collapse rules", () => {
  const css = readFileSync(new URL("../media/previewStyle.css", import.meta.url), "utf8");
  assert.ok(css.includes(".columns-container.columns-responsive"), "responsive container rule missing");
  assert.ok(css.includes("@media (max-width: 640px)"), "narrow breakpoint missing");
  const media = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.ok(media.includes(".columns-container.columns-responsive"), "container override inside the media query");
  assert.ok(media.includes(".columns-responsive"), "child overrides inside the media query");
});

test("stacked states share --columns-stacked-gap (l:stack / stk:N / responsive)", () => {
  const css = readFileSync(new URL("../media/previewStyle.css", import.meta.url), "utf8");
  const chain = "var(--columns-stacked-gap, var(--columns-block-gap, 8px))";

  const stacked = /^\.columns-container\.columns-stacked\s*\{([^}]*)\}/m.exec(css);
  assert.ok(stacked, "columns-stacked rule missing");
  assert.ok(stacked[1].includes(chain), "l:stack must use the stacked gap");

  const group = /^\.columns-container \.columns-stack-group\s*\{([^}]*)\}/m.exec(css);
  assert.ok(group, "stack-group rule missing");
  assert.ok(group[1].includes(chain), "stk:N group must use the stacked gap");

  const media = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.ok(media.includes(chain), "responsive collapse must use the stacked gap");

  const uses = css.match(/var\(--columns-stacked-gap, var\(--columns-block-gap, 8px\)\)/g) ?? [];
  assert.equal(uses.length, 3, "exactly the three stacked states share the chain");
  // An explicit g: token stays meaningful (block gap is read inside the chain).
  assert.ok(/gap:\s*var\(--columns-block-gap,\s*5px\)/.test(css), "row gap unchanged");
});
