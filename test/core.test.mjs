/**
 * Core parser/serializer tests (marker syntax, style tokens incl.
 * pd/ml/mt/mr/mb spacing tokens, nesting, stack groups, clamping).
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

// Bundle the parser/serializer to ESM for node import.
const dir = mkdtempSync(join(tmpdir(), "amc-core-"));
try {
  execSync(
    "npx esbuild src/core/parser.ts --bundle --format=esm --outfile=" + join(dir, "parser.mjs") +
    " && npx esbuild src/core/serializer.ts --bundle --format=esm --outfile=" + join(dir, "serializer.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {findColumnRegions, serializeColumns, docContainsColumns, serializeStyleTokens} = await import(join(dir, "parser.mjs"));

test("basic two columns", () => {
  const doc = "%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r.length, 1);
  assert.equal(r[0].columns.length, 2);
  assert.equal(r[0].columns[0].content, "Left");
  assert.equal(r[0].columns[1].content, "Right");
});

test("width + style tokens", () => {
  const doc = "%% col-start %%\n%% col-break:40,b:secondary %%\nA\n%% col-break:w:60,bc:blue,t:text,sb:1 %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].widthPercent, 40);
  assert.equal(r[0].columns[0].style?.background, "secondary");
  assert.equal(r[0].columns[1].widthPercent, 60);
  assert.equal(r[0].columns[1].style?.borderColor, "blue");
  assert.equal(r[0].columns[1].style?.showBorder, true);
});

test("nested regions", () => {
  const doc = "%% col-start %%\n%% col-break %%\nOuter A\n%% col-break %%\n%% col-start %%\n%% col-break %%\nInner 1\n%% col-break %%\nInner 2\n%% col-end %%\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r.length, 1);
  const nested = findColumnRegions(r[0].columns[1].content);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].columns[1].content, "Inner 2");
});

test("stack groups", () => {
  const doc = "%% col-start %%\n%% col-break:40,stk:1 %%\nS1\n%% col-break:stk:1 %%\nS2\n%% col-break:60 %%\nWide\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].stacked, 1);
  assert.equal(r[0].columns[1].stacked, 1);
  assert.equal(r[0].columns[2].stacked, undefined);
});

test("content before first break ignored", () => {
  const doc = "%% col-start %%\nIGNORED\n%% col-break %%\nReal\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns.length, 1);
  assert.equal(r[0].columns[0].content, "Real");
});

test("width sum > 100 resets to equal", () => {
  const doc = "%% col-start %%\n%% col-break:80 %%\nA\n%% col-break:40 %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].widthPercent, 0);
  assert.equal(r[0].columns[1].widthPercent, 0);
});

test("container style + layout", () => {
  const doc = "%% col-start:l:stack,bc:muted %%\n%% col-break:sep:1,sc:red,ss:dashed,sw:2 %%\nX\n%% col-break:lb:1,hd:0 %%\nY\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].layout, "stack");
  assert.equal(r[0].containerStyle?.borderColor, "muted");
  assert.equal(r[0].columns[0].style?.separator, true);
  assert.equal(r[0].columns[0].style?.separatorStyle, "dashed");
  assert.equal(r[0].columns[1].style?.leftBorder, true);
});

test("container gap token: g number → px", () => {
  const doc = "%% col-start:g:12 %%\n%% col-break %%\nA\n%% col-break %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].containerStyle?.gap, "12px");
});

test("container gap token: g with unit / multi-value", () => {
  const doc = "%% col-start:g:0.5em %%\n%% col-break %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].containerStyle?.gap, "0.5em");
});

test("gap round-trips through serialize", () => {
  const doc = "%% col-start:g:10 %%\n%% col-break %%\nA\n%% col-break %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  const round = serializeColumns(r[0].columns, r[0].containerStyle, r[0].layout);
  assert.ok(round.includes("%% col-start:g:10px %%"));
  const r2 = findColumnRegions(round);
  assert.equal(r2[0].containerStyle?.gap, "10px");
});

test("round-trip serialize", () => {
  const doc = "%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%";
  const r = findColumnRegions(doc);
  const round = serializeColumns(r[0].columns, r[0].containerStyle, r[0].layout);
  const r2 = findColumnRegions(round);
  assert.equal(r2[0].columns.length, 2);
  assert.equal(r2[0].columns[0].content, "Left");
});

test("plain doc: no regions", () => {
  const r = findColumnRegions("# Heading\n\nplain text");
  assert.equal(r.length, 0);
  assert.equal(docContainsColumns("# Heading"), false);
});

test("spacing tokens: pd number → px", () => {
  const doc = "%% col-start %%\n%% col-break:pd:8 %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.padding, "8px");
});

test("spacing tokens: pd multi-value shorthand", () => {
  const doc = "%% col-start %%\n%% col-break:pd:4 8 %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.padding, "4px 8px");
});

test("spacing tokens: ml/mt/mr/mb numbers and units", () => {
  const doc = "%% col-start %%\n%% col-break:ml:10,mt:2px,mr:0.5em,mb:0 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.marginLeft, "10px");
  assert.equal(s.marginTop, "2px");
  assert.equal(s.marginRight, "0.5em");
  assert.equal(s.marginBottom, "0px");
});

test("spacing tokens: serialize round-trip", () => {
  const tokens = serializeStyleTokens({
    padding: "8px",
    marginLeft: "10px",
    marginTop: "2px",
    marginRight: "0.5em",
    marginBottom: "0px",
  });
  assert.ok(tokens.includes("pd:8px"));
  assert.ok(tokens.includes("ml:10px"));
  assert.ok(tokens.includes("mt:2px"));
  assert.ok(tokens.includes("mr:0.5em"));
  assert.ok(tokens.includes("mb:0px"));
});

test("spacing tokens: empty value ignored", () => {
  const doc = "%% col-start %%\n%% col-break:pd: %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.padding, undefined);
});

test("spacing tokens: co-exist with other tokens", () => {
  const doc = "%% col-start %%\n%% col-break:b:secondary,pd:12,ml:6 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.background, "secondary");
  assert.equal(s.padding, "12px");
  assert.equal(s.marginLeft, "6px");
});

test("space-separated tokens are tolerated (b + ml both apply)", () => {
  const doc = "%% col-start %%\n%% col-break:b:secondary ml:10 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.background, "secondary");
  assert.equal(s.marginLeft, "10px");
});

test("full-width comma separator is tolerated", () => {
  const doc = "%% col-start %%\n%% col-break:b:secondary，ml:10 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.background, "secondary");
  assert.equal(s.marginLeft, "10px");
});

test("multi-value spacing (pd:4 8) survives token expansion", () => {
  const doc = "%% col-start %%\n%% col-break:pd:4 8,b:secondary %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.padding, "4px 8px");
  assert.equal(s.background, "secondary");
});

test("pb is accepted as a padding alias", () => {
  const doc = "%% col-start %%\n%% col-break:pb:20,ml:10,b:accent-soft %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.padding, "20px");
  assert.equal(s.marginLeft, "10px");
  assert.equal(s.background, "accent-soft");
});

test("user-reported combo renders with ml + padding", () => {
  const doc = "%% col-start %%\n%% col-break:b:secondary %%\nsecondary\n%% col-break:b:accent-soft,ml:10,pb:20 %%\naccent-soft\n%% col-break:b:green-soft,ml:10 %%\ngreen-soft\n%% col-end %%";
  const r = findColumnRegions(doc);
  const s2 = r[0].columns[1].style ?? {};
  const s3 = r[0].columns[2].style ?? {};
  assert.equal(s2.background, "accent-soft");
  assert.equal(s2.marginLeft, "10px");
  assert.equal(s2.padding, "20px");
  assert.equal(s3.marginLeft, "10px");
});

test("text-align token: ta parse", () => {
  const doc = "%% col-start %%\n%% col-break:ta:center %%\nA\n%% col-break:ta:left %%\nB\n%% col-break:ta:right %%\nC\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.textAlign, "center");
  assert.equal(r[0].columns[1].style?.textAlign, "left");
  assert.equal(r[0].columns[2].style?.textAlign, "right");
});

test("text-align token: invalid ta ignored", () => {
  const doc = "%% col-start %%\n%% col-break:ta:justify %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style, undefined);
});

test("text-align token: serialize round-trip", () => {
  const tokens = serializeStyleTokens({textAlign: "center"});
  assert.ok(tokens.includes("ta:center"));
});

test("text-align full round-trip through serializeColumns", () => {
  const doc = "%% col-start %%\n%% col-break:40,ta:right,b:secondary %%\nA\n%% col-break:60 %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  const round = serializeColumns(r[0].columns, r[0].containerStyle, r[0].layout);
  assert.ok(round.includes("%% col-break:40,b:secondary,ta:right %%"));
  const r2 = findColumnRegions(round);
  assert.equal(r2[0].columns[0].style?.textAlign, "right");
});

test("bc:transparent is accepted as border color", () => {
  const doc = "%% col-start %%\n%% col-break:bc:transparent,sb:1 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.borderColor, "transparent");
  assert.equal(s.showBorder, true);
});

test("border-radius token: br number → px", () => {
  const doc = "%% col-start %%\n%% col-break:br:12 %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.borderRadius, "12px");
});

test("border-radius token: br units and multi-value", () => {
  const doc = "%% col-start %%\n%% col-break:br:0.5em %%\nA\n%% col-break:br:4 8 %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.borderRadius, "0.5em");
  assert.equal(r[0].columns[1].style?.borderRadius, "4px 8px");
});

test("border-radius token: serialize round-trip", () => {
  const tokens = serializeStyleTokens({borderRadius: "10px"});
  assert.ok(tokens.includes("br:10px"));
  const doc = "%% col-start %%\n%% col-break:br:8,b:secondary %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  const round = serializeColumns(r[0].columns, r[0].containerStyle, r[0].layout);
  assert.ok(round.includes("%% col-break:b:secondary,br:8px %%"));
});

test("margin shorthand: m single value applies to all sides", () => {
  const doc = "%% col-start %%\n%% col-break:m:8 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.margin, "8px");
});

test("margin shorthand: m multi-value", () => {
  const doc = "%% col-start %%\n%% col-break:m:4 8 %%\nA\n%% col-break:m:4 8 12 16 %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.margin, "4px 8px");
  assert.equal(r[0].columns[1].style?.margin, "4px 8px 12px 16px");
});

test("margin shorthand: m with units", () => {
  const doc = "%% col-start %%\n%% col-break:m:0.5em %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.margin, "0.5em");
});

test("margin shorthand: m + directional ml coexist (direction wins)", () => {
  const doc = "%% col-start %%\n%% col-break:m:8,ml:16 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.margin, "8px");
  assert.equal(s.marginLeft, "16px");
});

test("margin shorthand: serialize round-trip", () => {
  const tokens = serializeStyleTokens({margin: "8px", marginLeft: "16px"});
  assert.ok(tokens.includes("m:8px"));
  assert.ok(tokens.includes("ml:16px"));
  const doc = "%% col-start %%\n%% col-break:m:6,b:secondary %%\nA\n%% col-end %%";
  const r = findColumnRegions(doc);
  const round = serializeColumns(r[0].columns, r[0].containerStyle, r[0].layout);
  assert.ok(round.includes("%% col-break:b:secondary,m:6px %%"));
});

test("border-width token: bw single value", () => {
  const doc = "%% col-start %%\n%% col-break:bw:2 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.borderWidth, "2px");
});

test("border-width token: bw multi-value and units", () => {
  const doc = "%% col-start %%\n%% col-break:bw:1 0 %%\nA\n%% col-break:bw:0.5em %%\nB\n%% col-end %%";
  const r = findColumnRegions(doc);
  assert.equal(r[0].columns[0].style?.borderWidth, "1px 0px");
  assert.equal(r[0].columns[1].style?.borderWidth, "0.5em");
});

test("border-width token: bw:0 disables visible border", () => {
  const doc = "%% col-start %%\n%% col-break:bw:0,sb:1 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.borderWidth, "0px");
  assert.equal(s.showBorder, true);
});

test("border-width token: serialize round-trip", () => {
  const tokens = serializeStyleTokens({borderWidth: "2px"});
  assert.ok(tokens.includes("bw:2px"));
});

test("border-width directional tokens: bwl/bwt/bwr/bwb parse", () => {
  const doc = "%% col-start %%\n%% col-break:bwl:2,bwt:3,bwr:4,bwb:0 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.borderWidthLeft, "2px");
  assert.equal(s.borderWidthTop, "3px");
  assert.equal(s.borderWidthRight, "4px");
  assert.equal(s.borderWidthBottom, "0px");
});

test("border-width directional tokens: serialize round-trip", () => {
  const tokens = serializeStyleTokens({
    borderWidth: "1px",
    borderWidthLeft: "2px",
    borderWidthTop: "3px",
    borderWidthRight: "4px",
    borderWidthBottom: "0px",
  });
  assert.ok(tokens.includes("bw:1px"));
  assert.ok(tokens.includes("bwl:2px"));
  assert.ok(tokens.includes("bwt:3px"));
  assert.ok(tokens.includes("bwr:4px"));
  assert.ok(tokens.includes("bwb:0px"));
});

test("border-radius directional tokens: brl/brt/brr/brb parse", () => {
  const doc = "%% col-start %%\n%% col-break:brl:8,brt:10,brr:12,brb:0 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.borderRadiusLeft, "8px");
  assert.equal(s.borderRadiusTop, "10px");
  assert.equal(s.borderRadiusRight, "12px");
  assert.equal(s.borderRadiusBottom, "0px");
});

test("border-radius directional tokens: serialize round-trip", () => {
  const tokens = serializeStyleTokens({
    borderRadius: "4px",
    borderRadiusLeft: "8px",
    borderRadiusTop: "10px",
    borderRadiusRight: "12px",
    borderRadiusBottom: "0px",
  });
  assert.ok(tokens.includes("br:4px"));
  assert.ok(tokens.includes("brl:8px"));
  assert.ok(tokens.includes("brt:10px"));
  assert.ok(tokens.includes("brr:12px"));
  assert.ok(tokens.includes("brb:0px"));
});

test("directional tokens: units and multi-value", () => {
  const doc = "%% col-start %%\n%% col-break:brl:0.5em,bwl:1 0 %%\nA\n%% col-end %%";
  const s = findColumnRegions(doc)[0].columns[0].style ?? {};
  assert.equal(s.borderRadiusLeft, "0.5em");
  assert.equal(s.borderWidthLeft, "1px 0px");
});

rmSync(dir, {recursive: true, force: true});
