/**
 * B1 — Dataview data index layer tests: YAML subset, inline fields,
 * tags/etags, tasks/sections/links, incremental store semantics, perf.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

// Bundle the index barrel to ESM for node import (same pattern as core.test.mjs).
const dir = mkdtempSync(join(tmpdir(), "amc-dv-index-"));
try {
  execSync(
    "npx esbuild src/dataview/index/index.ts --bundle --format=esm --outfile=" + join(dir, "index.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {parsePageFile, createIndexStore, parseYamlValue} = await import(join(dir, "index.mjs"));

// ── YAML subset ──────────────────────────────────────────────────────────────

test("yaml: scalars (null/bool/int/float/quoted/plain)", () => {
  const r = parseYamlValue('a: null\nb: true\nc: false\nd: 42\ne: 3.5\nf: "hi"\ng: \'sq\'\nh: plain text');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {a: null, b: true, c: false, d: 42, e: 3.5, f: "hi", g: "sq", h: "plain text"});
});

test("yaml: nested maps by indentation", () => {
  const r = parseYamlValue("top:\n  a: 1\n  inner:\n    b: deep\nother: 2");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {top: {a: 1, inner: {b: "deep"}}, other: 2});
});

test("yaml: inline array and empty flow", () => {
  const r = parseYamlValue('list: [a, 1, true, "x"]\nempty: []\nobj: {}');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {list: ["a", 1, true, "x"], empty: [], obj: {}});
});

test("yaml: block sequence incl. compact map item", () => {
  const r = parseYamlValue("items:\n  - one\n  - two: 2\n  - three");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {items: ["one", {two: 2}, "three"]});
});

test("yaml: block sequence at same indent as key (valid YAML)", () => {
  const r = parseYamlValue("tags:\n- a\n- b");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {tags: ["a", "b"]});
});

test("yaml: | literal and > folded block scalars", () => {
  const r = parseYamlValue("bio: |\n  line1\n  line2\nfolded: >\n  aaa\n  bbb\nafter: 1");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {bio: "line1\nline2", folded: "aaa bbb", after: 1});
});

test("yaml: comments stripped outside quotes only", () => {
  const r = parseYamlValue("# full line\na: 1 # trailing\nb: \"x # kept\"\nc: 2");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {a: 1, b: "x # kept", c: 2});
});

test("yaml: bad input returns error, never throws", () => {
  for (const bad of ['a: [1, 2', 'a: "unclosed', "a: 1\n  b: 2", "{a: ["]) {
    const r = parseYamlValue(bad);
    assert.ok(r.error, `expected error for: ${bad}`);
    assert.equal(r.value, null);
  }
  assert.deepEqual(parseYamlValue(""), {value: null});
  assert.equal(parseYamlValue("just a scalar").value, "just a scalar");
});

// ── parsePageFile: frontmatter / body ───────────────────────────────────────

test("page: frontmatter parsed, body starts after closing ---", () => {
  const content = '---\ntitle: Hello\ndate: 2024-01-15\n---\n# Head\nbody';
  const p = parsePageFile("notes/a.md", content, 100, content.length);
  assert.equal(p.frontmatter.title, "Hello");
  // string values pass through coerceStringField → date becomes tagged
  assert.deepEqual(p.frontmatter.date, {__dv: "date", iso: "2024-01-15T00:00:00.000Z"});
  assert.equal(p.name, "a");
  assert.equal(p.folder, "notes");
  assert.equal(p.ext, "md");
  assert.equal(p.ctime, 100);
  assert.equal(p.mtime, 100);
  assert.equal(p.size, content.length);
  assert.deepEqual(p.headings, [{level: 1, text: "Head", line: 4}]);
});

test("page: bad frontmatter degrades to {} and keeps body", () => {
  const content = '---\nkey: [unclosed\n---\n# Still body';
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(p.frontmatter, {});
  // delimiters recognized → body starts after closing --- (absolute line 3)
  assert.deepEqual(p.headings, [{level: 1, text: "Still body", line: 3}]);
});

test("page: unclosed frontmatter → whole file is body, no throw", () => {
  const content = '---\nno: close\n# In body';
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(p.frontmatter, {});
  assert.deepEqual(p.headings, [{level: 1, text: "In body", line: 2}]);
});

test("page: non-map frontmatter degrades to {} but body still stripped", () => {
  const content = "---\n- a\n- b\n---\n# H";
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(p.frontmatter, {});
  assert.deepEqual(p.headings, [{level: 1, text: "H", line: 4}]);
});

// ── inline fields ───────────────────────────────────────────────────────────

test("inline fields: three wrapper shapes + override + code exclusion", () => {
  const content = [
    "alpha:: one",
    "[beta:: two]",
    "(gamma:: three)",
    "later:: first",
    "later:: second",
    "arr:: [a, b]",
    "due:: 2024-01-15",
    "```",
    "fenced:: nope",
    "```",
    "inline `code:: nope` here",
    "~~~",
    "tilde:: nope",
    "~~~",
  ].join("\n");
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.equal(p.inlineFields.alpha, "one");
  assert.equal(p.inlineFields.beta, "two");
  assert.equal(p.inlineFields.gamma, "three");
  assert.equal(p.inlineFields.later, "second", "later occurrence overrides earlier");
  assert.deepEqual(p.inlineFields.arr, ["a", "b"]);
  assert.deepEqual(p.inlineFields.due, {__dv: "date", iso: "2024-01-15T00:00:00.000Z"});
  assert.equal(p.inlineFields.fenced, undefined, "fenced code excluded");
  assert.equal(p.inlineFields.code, undefined, "inline code excluded");
  assert.equal(p.inlineFields.tilde, undefined, "tilde fence excluded");
});

test("page: fields = frontmatter ∪ inline (inline wins); `file` key preserved", () => {
  const content = '---\ntitle: FM\nfile: reserved\n---\ntitle:: IN\nextra:: x';
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.equal(p.frontmatter.title, "FM");
  assert.equal(p.fields.title, "IN", "inline wins");
  assert.equal(p.fields.file, "reserved", "file key may exist in fields");
  assert.equal(p.fields.extra, "x");
});

// ── tags / etags / aliases ──────────────────────────────────────────────────

test("tags: frontmatter forms + body tags + etags parent expansion", () => {
  const content = [
    "---",
    "tags: [work, project/x]",
    "---",
    "#intro text #work more",
    "foo#nope [[note#Deep]] `#code` #a/b/c",
    "",
  ].join("\n");
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(p.tags, ["#work", "#project/x", "#intro", "#a/b/c"]);
  assert.deepEqual(p.etags, ["#work", "#project/x", "#project", "#intro", "#a/b/c", "#a", "#a/b"]);
  assert.ok(!p.tags.includes("#nope"), "mid-word hashtag is not a tag");
  assert.ok(!p.tags.includes("#Deep"), "wikilink subpath is not a tag");
  assert.ok(!p.tags.includes("#code"), "inline-code hashtag is not a tag");
});

test("tags: string and comma-separated frontmatter forms", () => {
  const a = parsePageFile("a.md", "---\ntags: alpha\n---\n", 1, 10);
  assert.deepEqual(a.tags, ["#alpha"]);
  const b = parsePageFile("b.md", "---\ntags: one, two\n---\n", 1, 10);
  assert.deepEqual(b.tags, ["#one", "#two"]);
});

test("tags: fenced code hashtags excluded", () => {
  const content = "```\n#fenced\n```\n#real";
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(p.tags, ["#real"]);
});

test("aliases: array and single-string normalization", () => {
  const a = parsePageFile("a.md", "---\naliases: [Al, Bo]\n---\n", 1, 10);
  assert.deepEqual(a.aliases, ["Al", "Bo"]);
  const b = parsePageFile("b.md", "---\naliases: Solo\n---\n", 1, 10);
  assert.deepEqual(b.aliases, ["Solo"]);
});

// ── tasks / lists ───────────────────────────────────────────────────────────

test("tasks: nesting by indent, custom status, tags/fields on text", () => {
  const content = [
    "- [ ] open task #home",
    "  - [/] custom child",
    "    - [x] deep grandchild due:: tomorrow",
    "- [X] done uppercase",
    "- plain item",
  ].join("\n");
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.equal(p.tasks.length, 2, "root holds non-nested tasks only");
  const [open, done] = p.tasks;
  assert.equal(open.text, "open task #home");
  assert.equal(open.status, "");
  assert.equal(open.indent, 0);
  assert.equal(open.line, 0);
  assert.deepEqual(open.tags, ["#home"]);
  assert.equal(open.children.length, 1);
  const child = open.children[0];
  assert.equal(child.status, "/", "custom status char kept");
  assert.equal(child.indent, 2);
  assert.equal(child.children.length, 1);
  const deep = child.children[0];
  assert.equal(deep.status, "x");
  assert.equal(deep.line, 2);
  assert.equal(deep.fields.due, "tomorrow");
  assert.equal(done.status, "x", "X normalizes to x");
  assert.equal(p.lists.length, 1, "non-task list item recorded separately");
  assert.equal(p.lists[0].line, 4);
  assert.equal(p.lists[0].text, "plain item");
});

test("list: tags and inline fields extracted from item text", () => {
  const content = "- item with #tag and [k:: v]\n- [ ] not a plain list";
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.equal(p.lists.length, 1);
  assert.deepEqual(p.lists[0].tags, ["#tag"]);
  assert.equal(p.lists[0].fields.k, "v");
  assert.equal(p.tasks.length, 1);
});

// ── headings / sections ─────────────────────────────────────────────────────

test("sections: absolute line numbers, ranges, fence-aware headings", () => {
  const content = [
    "---",
    "title: T",
    "---",
    "# One",
    "",
    "## Two",
    "```",
    "# not a heading",
    "```",
    "### Three",
  ].join("\n");
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(
    p.headings.map((h) => [h.level, h.text, h.line]),
    [[1, "One", 3], [2, "Two", 5], [3, "Three", 9]],
  );
  assert.deepEqual(p.sections[0].range, [3, 5]);
  assert.deepEqual(p.sections[1].range, [5, 9]);
  assert.deepEqual(p.sections[2].range, [9, 10], "last section runs to file end");
  assert.equal(p.sections[0].heading.text, "One");
});

test("heading: #tag line is not a heading", () => {
  const p = parsePageFile("a.md", "#tag only", 1, 10);
  assert.equal(p.headings.length, 0);
  assert.deepEqual(p.tags, ["#tag"]);
});

// ── links ───────────────────────────────────────────────────────────────────

test("links: wiki + markdown outlinks with exclusions", () => {
  const content = [
    "[[Target Note]]",
    "[[Target#Sec|Shown]]",
    "![[Embed]]",
    "[md](./docs/a.md)",
    "[ext](https://x.com)",
    "[mail](mailto:a@b.c)",
    "[anchor](#sec)",
    "`[[CodeLink]]`",
    "```",
    "[[FencedLink]]",
    "```",
  ].join("\n");
  const p = parsePageFile("a.md", content, 1, content.length);
  assert.deepEqual(
    p.outlinks.map((l) => [l.path, l.display, l.subpath, l.embed, l.line]),
    [
      ["Target Note", undefined, undefined, false, 0],
      ["Target", "Shown", "#Sec", false, 1],
      ["Embed", undefined, undefined, true, 2],
      ["docs/a.md", "md", undefined, false, 3],
    ],
  );
  assert.ok(!p.outlinks.some((l) => l.path.includes("x.com") || l.path.startsWith("mailto:") || l.path.startsWith("#")));
  assert.ok(!p.outlinks.some((l) => l.path === "CodeLink" || l.path === "FencedLink"));
  assert.deepEqual(p.inlinks, [], "pure parse has no inlinks");
});

// ── IndexStore: incremental semantics ───────────────────────────────────────

test("store: version bumps on real change only; skip when mtime+size match", () => {
  const store = createIndexStore();
  assert.equal(store.version, 0);
  const content = "hello #t";
  store.upsertFile("a.md", content, 100, content.length);
  assert.equal(store.version, 1);
  assert.equal(store.stats().parseCalls, 1);
  // same mtime + size → skip
  store.upsertFile("a.md", content, 100, content.length);
  assert.equal(store.version, 1, "unchanged file does not bump version");
  assert.equal(store.stats().parseCalls, 1, "unchanged file does not re-parse");
  // changed mtime → re-parse + bump
  store.upsertFile("a.md", content + "!", 200, content.length + 1);
  assert.equal(store.version, 2);
  assert.equal(store.stats().parseCalls, 2);
  assert.equal(typeof store.stats().lastIncrementalMs, "number");
});

test("store: upsert cascades inlinks into target pages (shallow-copied)", () => {
  const store = createIndexStore();
  store.upsertFile("a.md", "link to [[b.md]] here", 1, 20);
  store.upsertFile("b.md", "i am b", 1, 6);
  const b1 = store.getPage("b.md");
  assert.equal(b1.inlinks.length, 1);
  assert.equal(b1.inlinks[0].path, "b.md", "inlink is the source's outlink (target path)");
  assert.equal(b1.inlinks[0].line, 0);

  const snapBefore = store.snapshot();
  const bSnap = snapBefore.pages.find((p) => p.path === "b.md");
  assert.equal(bSnap.inlinks.length, 1);

  // a.md now links elsewhere → b's inlinks cascade to empty
  store.upsertFile("a.md", "link to [[c.md]] now", 2, 20);
  const b2 = store.getPage("b.md");
  assert.equal(b2.inlinks.length, 0, "stale inlink removed by cascade");
  assert.notEqual(b2, b1, "target replaced via shallow copy");
  assert.equal(bSnap.inlinks.length, 1, "old snapshot ref not mutated");

  // target added later still discovers existing source
  store.upsertFile("c.md", "c", 1, 1);
  const c = store.getPage("c.md");
  assert.equal(c.inlinks.length, 1);
});

test("store: removeFile cleans reverse indexes and cascades", () => {
  const store = createIndexStore();
  store.upsertFile("a.md", "---\ntags: [gone]\n---\n[[b.md]]", 1, 30);
  store.upsertFile("b.md", "b", 1, 1);
  assert.deepEqual(store.byTag("#gone"), ["a.md"]);
  assert.deepEqual(store.byFolder(""), ["a.md", "b.md"]);
  const vBefore = store.version;

  store.removeFile("a.md");
  assert.equal(store.getPage("a.md"), undefined);
  assert.deepEqual(store.byTag("#gone"), [], "tag index cleaned");
  assert.deepEqual(store.byFolder(""), ["b.md"], "folder index cleaned");
  assert.equal(store.getPage("b.md").inlinks.length, 0, "cascade removes inlinks from deleted source");
  assert.ok(store.version > vBefore, "remove bumps version");
  const calls = store.stats().parseCalls;
  const vNoop = store.version;
  store.removeFile("missing.md");
  assert.equal(store.version, vNoop, "no-op remove keeps version");
  assert.equal(store.stats().parseCalls, calls, "no-op remove does not parse");
});

test("store: byTag uses etags (parent tags match)", () => {
  const store = createIndexStore();
  store.upsertFile("p.md", "---\ntags: [project/x]\n---\n", 1, 20);
  assert.deepEqual(store.byTag("#project/x"), ["p.md"]);
  assert.deepEqual(store.byTag("#project"), ["p.md"], "parent etag resolves");
});

test("store: snapshot is path-sorted and stable across calls", () => {
  const store = createIndexStore();
  for (const p of ["z.md", "a.md", "m.md", "b/c.md"]) store.upsertFile(p, "x " + p, 1, 3);
  const s1 = store.snapshot();
  const s2 = store.snapshot();
  assert.deepEqual(
    s1.pages.map((p) => p.path),
    ["a.md", "b/c.md", "m.md", "z.md"],
    "sorted by path (code-unit order)",
  );
  assert.deepEqual(s1.pages.map((p) => p.path), s2.pages.map((p) => p.path), "stable order");
  assert.equal(s1.version, store.version);
  assert.ok(s1.generatedAt > 0);
  // returned array is a copy — mutating it must not affect later snapshots
  s1.pages.pop();
  assert.equal(store.snapshot().pages.length, 4);
  assert.deepEqual(store.allPages().map((p) => p.path), ["a.md", "b/c.md", "m.md", "z.md"]);
});

// ── performance: 200-file incremental vs full rebuild ───────────────────────

function makePerfFile(i, n) {
  const link = "note " + ((i + 1) % n);
  return [
    "---",
    "title: Note " + i,
    "tags: [perf, group/" + (i % 10) + "]",
    "---",
    "",
    "# Heading " + i,
    "",
    "Intro with #inline tag and [[" + link + "]].",
    "",
    "- [ ] task due:: 2024-02-01",
    "  - [/] sub",
    "- plain item [k:: v]",
    "",
    "See [[other " + ((i + 3) % n) + "]] and [md](./doc" + i + ".md).",
  ].join("\n");
}

test("perf: 1000 files first index under 2s", () => {
  const store = createIndexStore();
  const files = [];
  for (let i = 0; i < 1000; i++) {
    const content = makePerfFile(i, 1000);
    files.push({path: "notes/f" + i + ".md", content, mtime: 1000, size: content.length});
  }
  const t0 = performance.now();
  for (const f of files) store.upsertFile(f.path, f.content, f.mtime, f.size);
  const ms = performance.now() - t0;
  assert.equal(store.stats().parseCalls, 1000);
  assert.ok(ms < 2000, `1000-file first index took ${ms.toFixed(1)}ms (< 2000ms)`);
});

test("perf: 200 files — incremental total < full rebuild (both really parse)", () => {
  const N = 200;
  const CHANGED = 20;
  const files = [];
  for (let i = 0; i < N; i++) {
    const content = makePerfFile(i, N);
    files.push({path: "notes/f" + i + ".md", content, mtime: 1000, size: content.length});
  }
  // JIT warm-up so neither side pays first-call costs asymmetrically
  const warm = createIndexStore();
  warm.upsertFile("warm.md", makePerfFile(0, 1), 1, 10);

  // Full rebuild: brand-new store parses every file (real parses verified).
  const full = createIndexStore();
  const tFull0 = performance.now();
  for (const f of files) full.upsertFile(f.path, f.content, f.mtime, f.size);
  const fullMs = performance.now() - tFull0;
  assert.equal(full.stats().parseCalls, N, "full rebuild parses all 200");

  // Incremental: pre-indexed store; 20 files change (mtime+size), 180 skip.
  const inc = createIndexStore();
  for (const f of files) inc.upsertFile(f.path, f.content, f.mtime, f.size);
  const baseCalls = inc.stats().parseCalls;
  assert.equal(baseCalls, N);
  const tInc0 = performance.now();
  let expectParsed = 0;
  for (let i = 0; i < N; i++) {
    const f = files[i];
    if (i < CHANGED) {
      expectParsed++;
      inc.upsertFile(f.path, f.content + "\nedited", 2000, f.size + 8);
    } else {
      inc.upsertFile(f.path, f.content, f.mtime, f.size);
    }
  }
  const incMs = performance.now() - tInc0;
  const parsedDelta = inc.stats().parseCalls - baseCalls;

  assert.equal(parsedDelta, expectParsed, "incremental really parses exactly the changed files");
  assert.ok(parsedDelta > 0, "anti-fake-green: incremental side performs real parses");
  assert.ok(incMs < fullMs, `incremental ${incMs.toFixed(1)}ms must beat full ${fullMs.toFixed(1)}ms`);
  assert.ok(incMs / N < 5, `average upsert ${(incMs / N).toFixed(3)}ms < 5ms typical`);
});

rmSync(dir, {recursive: true, force: true});
