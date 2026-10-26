/**
 * Frontmatter robustness.
 *
 * Real notes carry frontmatter that is only *nearly* valid YAML: a plain scalar
 * continued on an indented line, a key-like line where a scalar was expected, a
 * stray tab. Treating that as "the whole block is invalid" silently dropped
 * every field — tags, aliases, everything a query filters on — so these tests
 * pin two behaviours:
 *
 *   1. valid-but-multi-line plain scalars are folded (they used to error);
 *   2. anything still unparseable is recovered line by line, keeping the fields
 *      that do parse, and the failure never reaches the document.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-dv-frontmatter-"));
execSync("npx esbuild src/dataview/index/index.ts --bundle --format=esm --outfile=" + join(dir, "index.mjs"), {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
});
const {parsePageFile, parseYamlValue, parseYamlTolerant} = await import(join(dir, "index.mjs"));

const page = (frontmatter, body = "") => `---\n${frontmatter}\n---\n${body}`;

test("yaml: a plain scalar continued on an indented line is folded", () => {
  const r = parseYamlValue("title: T\ndescription: first part\n  second part\ntags: [a, b]");
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.value, {title: "T", description: "first part second part", tags: ["a", "b"]});
});

test("yaml: a key where a scalar continuation was expected is still an error", () => {
  // This is the shape that real YAML checkers reject as a multi-line implicit
  // key; the strict parser must keep reporting it (recovery handles it instead).
  const r = parseYamlValue("title: T\nnote: value\n  nested: bad\nx: 1");
  assert.ok(r.error, "strict parse must report the malformed continuation");
});

test("yaml: tolerant parse keeps the readable fields and reports the repair", () => {
  const res = parseYamlTolerant("title: T\nnote: value\n  nested: bad\nx: 1");
  assert.deepEqual(res.value, {title: "T", note: "value", x: 1});
  assert.ok(res.recovered, "the repair is reported for diagnostics");
  assert.match(res.recovered, /line 3/);
});

test("yaml: tolerant parse gives up cleanly when nothing is recoverable", () => {
  // Flow errors carry no line number, so there is nothing to repair line by line.
  const res = parseYamlTolerant("a: [1, 2");
  assert.equal(res.value, null);
  assert.ok(res.recovered);
});

test("frontmatter: a recovered block still feeds fields, tags and aliases", () => {
  const content = page(
    [
      "title: My Note",
      "tags: [project, active]",
      "status: draft",
      "created: 2024-01-01",
      "authors: [ann]",
      "this line has no colon", // <- the malformed line
      "last: value",
      "aliases: [mn]",
    ].join("\n"),
    "# Heading\n\nBody text\n",
  );
  const p = parsePageFile("notes/a.md", content, 1700000000000, content.length);

  assert.equal(p.frontmatter.title, "My Note");
  assert.equal(p.frontmatter.status, "draft");
  assert.ok(String(p.frontmatter.created.iso).startsWith("2024-01-01"), "date values keep their coercion");
  assert.deepEqual(p.frontmatter.authors, ["ann"]);
  assert.equal(p.frontmatter.last, "value", "fields after the bad line survive");
  assert.deepEqual(p.tags, ["#project", "#active"], "tags are not lost");
  assert.deepEqual(p.aliases, ["mn"]);
  assert.deepEqual(p.fields.title, "My Note");
  assert.ok(p.headings.some((h) => h.text === "Heading"), "the body is still parsed");
});

test("frontmatter: a continuation key is recovered without losing the block", () => {
  // js-yaml wording for this shape: "implicit keys need to be on a single line".
  const content = page(
    ["title: Note", "note: value", "  nested: bad", "tags: [x]", "after: 1"].join("\n"),
    "body\n",
  );
  const p = parsePageFile("notes/b.md", content, 1700000000000, content.length);
  assert.equal(p.frontmatter.title, "Note");
  assert.equal(p.frontmatter.note, "value");
  assert.equal(p.frontmatter.after, 1);
  assert.deepEqual(p.tags, ["#x"]);
});

test("frontmatter: a key-less line does not cost the rest of the block", () => {
  // Exact shape that broke .state.md: one line without a colon between keys.
  // An external YAML checker reports `implicit keys need to be on a single line`
  // for it; the index must still read every other field.
  const content = page(
    [
      "status: active",
      "updated_at: 2026-10-26 15:05",
      "S13 收尾 — 阶段说明（这一行没有键）",
      "loop: 10",
      "goal:",
      "  explicit: do the thing",
      "resume: |",
      "  line one",
      "  line two",
    ].join("\n"),
    "body\n",
  );
  const p = parsePageFile(".state.md", content, 1, content.length);
  assert.equal(p.fields.status, "active");
  assert.equal(p.fields.loop, 10, "keys after the bad line survive");
  assert.deepEqual(p.fields.goal, {explicit: "do the thing"}, "nested maps after it survive");
  assert.equal(p.fields.resume, "line one\nline two", "block scalars after it survive");
});

test("frontmatter: block scalars and nested maps keep working", () => {
  const content = page(
    ["summary: |", "  line one", "  line two", "nested:", "  a: 1", "  b: [2, 3]"].join("\n"),
    "body\n",
  );
  const p = parsePageFile("notes/c.md", content, 1700000000000, content.length);
  assert.equal(p.frontmatter.summary, "line one\nline two");
  assert.deepEqual(p.frontmatter.nested, {a: 1, b: [2, 3]});
});

test("frontmatter: an empty block is still an empty object (no diagnostics noise)", () => {
  const p = parsePageFile("notes/d.md", "---\n---\nbody\n", 1700000000000, 15);
  assert.deepEqual(p.frontmatter, {});
  assert.deepEqual(p.tags, []);
});
