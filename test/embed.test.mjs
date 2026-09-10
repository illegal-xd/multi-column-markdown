/**
 * Embed cost-control tests: `![[note]]` expansion must stay bounded no
 * matter what the workspace contains (cycles, fan-out, long chains).
 *
 * These tests exercise the real code path — a temporary workspace with real
 * files — so the recursion, the per-pass content cache and the per-pass
 * budget are all genuinely traversed.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import fs, {mkdtempSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {execSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const cwd = new URL("..", import.meta.url).pathname;

// Real workspace for this test file.
const workspace = mkdtempSync(join(tmpdir(), "amc-embed-ws-"));
process.env.AMC_TEST_WORKSPACE = workspace;
writeFileSync(join(workspace, "child.md"), "Child body text\n");
writeFileSync(join(workspace, "self.md"), "![[self]]\n\n![[self]]\n\n![[self]]\n");
writeFileSync(join(workspace, "hub.md"), "![[child]]\n\n".repeat(60));
for (let i = 1; i <= 5; i++) {
  writeFileSync(join(workspace, `chain${i}.md`), (i === 5 ? "chain body" : `![[chain${i + 1}]]`) + "\n");
}
for (let i = 1; i <= 10; i++) {
  writeFileSync(join(workspace, `deep${i}.md`), (i === 10 ? "deep body" : `![[deep${i + 1}]]`) + "\n");
}

execSync("node esbuild.mjs", {cwd, stdio: "pipe"});

let reads = 0;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = (...args) => {
  reads += 1;
  return originalReadFileSync(...args);
};

const require = createRequire(new URL("./helpers/", import.meta.url));
const MarkdownIt = require(join(cwd, "node_modules/markdown-it/dist/markdown-it.js"));
const ext = require(join(cwd, "dist/extension.js"));
const api = ext.activate({subscriptions: {push() {}}});
const md = new MarkdownIt({html: true});
api.extendMarkdownIt(md);

const renderCounted = (source) => {
  reads = 0;
  const html = md.render(source);
  return {html, reads};
};

const blocks = (html) => (html.match(/amc-embed-markdown/g) ?? []).length;
const cycles = (html) => (html.match(/amc-embed-cycle/g) ?? []).length;
const limited = (html) => (html.match(/amc-embed-limited/g) ?? []).length;

test("a markdown embed renders the target's content", () => {
  const {html, reads: readCount} = renderCounted("![[child]]");
  assert.equal(blocks(html), 1);
  assert.ok(html.includes("Child body text"));
  assert.equal(readCount, 1, `expected a single file read, got ${readCount}`);
});

test("cyclic embeds terminate and are reported, not expanded", () => {
  const {html, reads: readCount} = renderCounted("![[self]]");
  assert.equal(blocks(html), 1, "only the entry file is expanded");
  assert.equal(cycles(html), 3, "each back-reference is marked as circular");
  assert.ok(readCount <= 2, `expected at most 2 file reads, got ${readCount}`);
  assert.ok(html.length < 5000, "output stays small");
});

test("repeated embeds of one file are read once per render pass", () => {
  const {html, reads: readCount} = renderCounted("![[hub]]");
  assert.equal(blocks(html), 50, "expansion is capped by the per-render budget");
  assert.equal(limited(html), 11, "the remaining embeds report the limit");
  assert.ok(readCount <= 3, `expected a content-cached read budget, got ${readCount}`);
});

test("a chain within the depth cap renders to the end", () => {
  const {html} = renderCounted("![[chain1]]");
  assert.equal(blocks(html), 5);
  assert.ok(html.includes("chain body"));
});

test("a chain past the depth cap stops without crashing", () => {
  const {html} = renderCounted("![[deep1]]");
  assert.equal(blocks(html), 8, `depth cap expected 8 expansions, got ${blocks(html)}`);
  assert.ok(!html.includes("deep body"), "content past the cap is not expanded");
});

test("missing embed targets fall back to an image tag", () => {
  const {html} = renderCounted("![[does-not-exist]]");
  assert.ok(html.includes("<img class=\"amc-embed\""));
  assert.equal(blocks(html), 0);
});
