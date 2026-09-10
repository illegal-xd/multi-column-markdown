import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-wikilink-"));
execSync(`npx esbuild src/core/wikilink.ts --bundle --format=esm --outfile=${join(dir, "wikilink.mjs")}`, {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"});
const {parseWikilinkTarget, wikilinkFragment, isMarkdownTarget} = await import(join(dir, "wikilink.mjs"));

test("parses wikilink alias and heading", () => {
  assert.deepEqual(parseWikilinkTarget("docs/Guide#Setup|Read this"), {
    target: "docs/Guide", fragment: "#Setup", alias: "Read this",
  });
});

test("builds stable heading and block fragments", () => {
  assert.equal(wikilinkFragment("#Setup Here"), "#setup-here");
  assert.equal(wikilinkFragment("^block-1"), "#block-1");
});

test("recognizes markdown embeds without treating image assets as pages", () => {
  assert.equal(isMarkdownTarget("docs/Guide.md"), true);
  assert.equal(isMarkdownTarget("assets/diagram.png"), false);
});
