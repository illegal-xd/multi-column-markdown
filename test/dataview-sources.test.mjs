/**
 * DQL FROM sources + clause parsing (upstream Dataview parity).
 *
 * Covers: negation, and/or (precedence, case-insensitivity, missing spaces),
 * incoming/outgoing, legacy string sources (folder/exact/bare), parent tags,
 * WITHOUT ID, CALENDAR, GROUP BY / FLATTEN `AS` aliases, and the untouched
 * SORT/LIMIT/header behaviour.
 *
 * Pattern: esbuild bundle → node --test (same as dataview-query.test.mjs).
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-src-"));
try {
  execSync(
    "npx esbuild src/dataview/query/index.ts --bundle --format=esm --outfile=" + join(dir, "query.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {matchSource, parseDql, executeDql, evaluateExpression, rewriteSourceExpr, DqlError} = await import(join(dir, "query.mjs"));

// ── fixtures ───────────────────────────────────────────────────────────────

function makePage(path, extra = {}) {
  const name = path.replace(/\.md$/, "").split("/").pop();
  const slash = path.lastIndexOf("/");
  return {
    path,
    name,
    folder: slash >= 0 ? path.slice(0, slash) : "",
    ext: "md",
    ctime: 0,
    mtime: 0,
    size: 1,
    frontmatter: {},
    inlineFields: {},
    fields: extra.fields ?? {},
    tags: extra.etags ?? [],
    etags: extra.etags ?? [],
    aliases: [],
    headings: [],
    sections: [],
    lists: [],
    tasks: [],
    inlinks: extra.inlinks ?? [],
    outlinks: extra.outlinks ?? [],
  };
}
const link = (path) => ({path, embed: false, line: 1});

// A links → target; B links → notes/a (extension-less); C links → notes/a.md.
const A = makePage("notes/a.md", {etags: ["#yes", "#yes/deep", "#proj/web"], outlinks: [link("target")], fields: {priority: 1}});
const B = makePage("notes/b.md", {etags: ["#no"], outlinks: [link("notes/a")], fields: {priority: 2}});
const C = makePage("other/c.md", {etags: ["#other"], outlinks: [link("notes/a.md")], fields: {priority: 3}});
const D = makePage("notes/d.md", {etags: ["#yes", "#no"], fields: {priority: 4, status: "done"}});
const T = makePage("target.md", {fields: {priority: 5}});
const pages = [A, B, C, D, T];
const snapshot = {version: 1, pages, generatedAt: 0};
const ctx = {allPages: pages, currentPath: "notes/a.md"};

/** [page, matched] pairs → set of matched paths. */
function matched(source, context) {
  return pages.filter((p) => matchSource(source, p, context)).map((p) => p.path);
}

// ── A1: negation ───────────────────────────────────────────────────────────

test("source: negation — -#tag / -\"folder\" / -[[link]] exclude matches", () => {
  assert.deepEqual(matched("-#yes"), ["notes/b.md", "other/c.md", "target.md"]);
  assert.deepEqual(matched('-"notes"'), ["other/c.md", "target.md"]);
  assert.deepEqual(matched("-[[target]]"), ["notes/a.md", "notes/b.md", "other/c.md", "notes/d.md"]);
  assert.deepEqual(matched('-"notes/a.md"'), ["notes/b.md", "other/c.md", "notes/d.md", "target.md"]);
  // double negation is identity
  assert.deepEqual(matched("--#yes"), ["notes/a.md", "notes/d.md"]);
});

// ── A2: and / or ───────────────────────────────────────────────────────────

test("source: `or`/`and` — case-insensitive, spaces optional, and > or", () => {
  // dv.pages("#yes or -#no") from the docs: C is neither #yes nor #no → kept.
  assert.deepEqual(matched("#yes or -#no"), ["notes/a.md", "other/c.md", "notes/d.md", "target.md"]);
  // dv.pages('"folder" or #tag') from the docs.
  assert.deepEqual(matched('"notes" or #other'), ["notes/a.md", "notes/b.md", "other/c.md", "notes/d.md"]);
  // FROM #tag and -#excluded from the docs (D carries #no → dropped).
  assert.deepEqual(matched('"notes" and -#no'), ["notes/a.md"]);
  // uppercase keyword + no space after the operator
  assert.deepEqual(matched("#yes OR -#no"), ["notes/a.md", "other/c.md", "notes/d.md", "target.md"]);
  assert.deepEqual(matched("#yes or-#no"), ["notes/a.md", "other/c.md", "notes/d.md", "target.md"]);
  // precedence: and binds tighter than or → for D (#yes AND #no) the and-branch
  // (`#no and -#yes`) is false, so only the leading `#yes` keeps it.
  assert.equal(matchSource("#yes or #no and -#yes", D), true);
  assert.equal(matchSource("#no and -#yes or #yes", D), true);
  // explicit parens may override the default precedence
  assert.equal(matchSource("(#yes or #no) and -#yes", D), false);
  assert.equal(matchSource("(#yes or #no) and -#yes", B), true);
});

// ── A3: incoming / outgoing ────────────────────────────────────────────────

test("source: incoming([[link]]) matches pages linking to it (ctx optional)", () => {
  assert.deepEqual(matched("incoming([[notes/a]])", ctx), ["notes/b.md", "other/c.md"]);
  assert.deepEqual(matched('incoming("notes/a")', ctx), ["notes/b.md", "other/c.md"]);
  // extension written either way is the same page
  assert.deepEqual(matched("incoming([[notes/a.md]])", ctx), ["notes/b.md", "other/c.md"]);
  // no argument → current file (ctx.currentPath)
  assert.deepEqual(matched("incoming()", ctx), ["notes/b.md", "other/c.md"]);
  // per-page outlinks make the no-ctx form work too (used by legacy executeDql)
  assert.deepEqual(matched("incoming([[notes/a]])"), ["notes/b.md", "other/c.md"]);
  // without a current path the bare form cannot match anything
  assert.deepEqual(matched("incoming()", {allPages: pages}), []);
});

test("source: outgoing([[link]]) matches the linked pages (needs ctx.allPages)", () => {
  assert.deepEqual(matched("outgoing([[notes/a]])", ctx), ["target.md"]);
  assert.deepEqual(matched('outgoing("notes/a")', ctx), ["target.md"]);
  assert.deepEqual(matched("outgoing([[notes/a.md]])", ctx), ["target.md"]);
  // no argument → current file's outlinks
  assert.deepEqual(matched("outgoing()", ctx), ["target.md"]);
  // no ctx → cannot resolve the target page's outlinks (documented)
  assert.deepEqual(matched("outgoing([[notes/a]])"), []);
  // booleans compose with the link functions
  assert.deepEqual(matched('outgoing([[notes/a]]) or #no', ctx), ["notes/b.md", "notes/d.md", "target.md"]);
  assert.deepEqual(matched('incoming([[notes/a]]) and -#other', ctx), ["notes/b.md"]);
});

// ── A4/A5: legacy string sources + tag parents ─────────────────────────────

test("source: string sources keep folder/exact/bare semantics", () => {
  assert.deepEqual(matched("notes"), ["notes/a.md", "notes/b.md", "notes/d.md"]);
  assert.deepEqual(matched("notes/"), ["notes/a.md", "notes/b.md", "notes/d.md"]);
  assert.deepEqual(matched("notes/a.md"), ["notes/a.md"]);
  assert.deepEqual(matched("notes/a"), ["notes/a.md"]);
  assert.deepEqual(matched("target"), ["target.md"]);
  assert.deepEqual(matched("missing"), []);
  // dv.pages('"notes/a.md"') hands the quoted text through
  assert.deepEqual(matched('"notes/a.md"'), ["notes/a.md"]);
  // Link values (dv.pages(file.link)) keep working
  assert.deepEqual(matched(link("notes/b.md")), ["notes/b.md"]);
  const all = matched(null);
  assert.equal(all.length, pages.length);
  assert.equal(matched(false).length, 0);
  assert.equal(matched(true).length, pages.length);
});

test("source: #tag matches the tag and its parents", () => {
  assert.deepEqual(matched("#yes"), ["notes/a.md", "notes/d.md"]);
  assert.deepEqual(matched("#proj"), ["notes/a.md"]); // #proj/web is a child
  assert.deepEqual(matched("#proj/web"), ["notes/a.md"]);
  assert.deepEqual(matched("#yes/deep"), ["notes/a.md"]);
  assert.deepEqual(matched("#yes/nope"), []);
  assert.deepEqual(matched('"#yes"'), ["notes/a.md", "notes/d.md"]); // quoted tag source
});

// ── compound FROM survives the expression layer (end-to-end) ───────────────

test("FROM: compound sources evaluate end-to-end (no boolean collapse)", () => {
  // cells[1] skips the implicit leading "File" id column (upstream TABLE shape).
  const rows = (src) => executeDql(parseDql(src), snapshot)[0].rows.map((r) => r.cells[1].v);
  assert.deepEqual(rows('TABLE priority\nFROM #yes or -#no'), [1, 3, 4, 5]);
  assert.deepEqual(rows('TABLE priority\nFROM "notes" and -#no'), [1]);
  assert.deepEqual(rows('TABLE priority\nFROM -"notes"'), [3, 5]);
  assert.deepEqual(rows('TABLE priority\nFROM incoming([[notes/a]])'), [2, 3]);
  // rewriteSourceExpr hands compound text through as ONE literal…
  assert.equal(evaluateExpression(rewriteSourceExpr("#yes or -#no"), {}), "#yes or -#no");
  // …and keeps the legacy per-token rewrite for simple sources.
  assert.equal(evaluateExpression(rewriteSourceExpr("#yes"), {}), "#yes");
});

// ── B6: WITHOUT ID ─────────────────────────────────────────────────────────

test("parse: TABLE/LIST WITHOUT ID → withoutId + identical column rendering", () => {
  const table = parseDql("TABLE WITHOUT ID file.name, priority\nFROM #yes");
  assert.equal(table.type, "table");
  assert.equal(table.withoutId, true);
  assert.deepEqual(table.fields, [
    {name: "file.name", expr: "file.name"},
    {name: "priority", expr: "priority"},
  ]);

  const list = parseDql('LIST WITHOUT ID priority\nFROM #yes');
  assert.equal(list.type, "list");
  assert.equal(list.withoutId, true);
  assert.deepEqual(list.fields, [{name: "priority", expr: "priority"}]);

  // no WITHOUT ID → flag absent, fields unchanged
  const plain = parseDql("TABLE file.name, priority");
  assert.equal(plain.withoutId, undefined);
  assert.deepEqual(plain.fields, [
    {name: "file.name", expr: "file.name"},
    {name: "priority", expr: "priority"},
  ]);

  // Rendering protocol: a plain TABLE carries the implicit "File" id column
  // (upstream), WITHOUT ID suppresses exactly that column.
  const withId = executeDql(parseDql('TABLE file.name, priority\nFROM "notes/a"'), snapshot)[0];
  const without = executeDql(parseDql('TABLE WITHOUT ID file.name, priority\nFROM "notes/a"'), snapshot)[0];
  assert.deepEqual(withId.headers, ["File", "file.name", "priority"]);
  assert.deepEqual(without.headers, ["file.name", "priority"]);
  assert.equal(without.rows.length, 1);
  assert.equal(without.rows[0].cells.length, 2);
  assert.equal(withId.rows[0].cells.length, 3);
  assert.equal(withId.rows[0].cells[0].t, "link");

  const listOp = executeDql(parseDql('LIST WITHOUT ID priority\nFROM "notes/a"'), snapshot)[0];
  assert.deepEqual(listOp.items, [{t: "num", v: 1}]);
});

// ── B7: CALENDAR (parse layer only) ────────────────────────────────────────

test("parse: CALENDAR <field> with clauses → type calendar, field in fields[0]", () => {
  const bare = parseDql("CALENDAR due");
  assert.equal(bare.type, "calendar");
  assert.deepEqual(bare.fields, [{name: "due", expr: "due"}]);
  assert.equal(bare.source, "");
  assert.deepEqual(bare.sort, []);
  assert.deepEqual(bare.flatten, []);

  const full = parseDql([
    "CALENDAR file.mtime",
    "FROM #yes",
    'WHERE due > date("2020-01-01")',
    "SORT due ASC",
    "LIMIT 3",
  ].join("\n"));
  assert.equal(full.type, "calendar");
  assert.deepEqual(full.fields, [{name: "file.mtime", expr: "file.mtime"}]);
  assert.equal(full.source, "#yes");
  assert.ok(full.where.includes("due >"));
  assert.deepEqual(full.sort, [{expr: "due", dir: "asc"}]);
  assert.equal(full.limit, 3);

  assert.throws(() => parseDql("CALENDAR"), (e) => e instanceof DqlError && e.line === 1);
  assert.throws(() => parseDql("CALENDAR\ndue as of now"), (e) => e instanceof DqlError && e.line === 1);
});

// ── B8: GROUP BY / FLATTEN aliases ─────────────────────────────────────────

test("parse: GROUP BY `AS name` and FLATTEN `AS name` expose aliases", () => {
  const quoted = parseDql('TABLE priority\nGROUP BY status AS "Status"');
  assert.equal(quoted.groupBy, "status");
  assert.equal(quoted.groupByAlias, "Status");

  const bare = parseDql("TABLE priority\nGROUP BY status AS key");
  assert.equal(bare.groupBy, "status");
  assert.equal(bare.groupByAlias, "key");

  const none = parseDql("TABLE priority\nGROUP BY status");
  assert.equal(none.groupBy, "status");
  assert.equal(none.groupByAlias, undefined);

  const flat = parseDql('TABLE priority\nFLATTEN items AS "Item", tags');
  assert.deepEqual(flat.flatten, ["items", "tags"]);
  assert.deepEqual(flat.flattenAliases, ["Item", undefined]);

  // multiple FLATTEN clauses keep flatten/flattenAliases parallel
  const multi = parseDql('TABLE a\nFLATTEN items AS "Item"\nFLATTEN tags');
  assert.deepEqual(multi.flatten, ["items", "tags"]);
  assert.deepEqual(multi.flattenAliases, ["Item", undefined]);

  // aliases on expressions with commas / quotes are not mistaken for `AS`
  const tricky = parseDql('TABLE a\nFLATTEN choice(x, "as is", y) AS "Picked"');
  assert.deepEqual(tricky.flatten, ['choice(x, "as is", y)']);
  assert.deepEqual(tricky.flattenAliases, ["Picked"]);

  // execution is unaffected by the alias (same rows, alias unused here)
  const ops = executeDql(parseDql('TABLE priority\nFROM "notes/d"\nGROUP BY status AS "S"'), snapshot)[0];
  assert.equal(ops.rows[0].group.t, "str");
  assert.deepEqual(ops.rows[0].cells, []);
  // member row = [implicit File link cell, priority]
  assert.equal(ops.rows[1].cells[0].t, "link");
  assert.deepEqual(ops.rows[1].cells[1], {t: "num", v: 4});
});

// ── B9: untouched SORT / LIMIT / header behaviour ──────────────────────────

test("parse: SORT multi-key, LIMIT and plain headers are unchanged", () => {
  const q = parseDql(["TABLE file.name, priority", "SORT priority DESC, file.name ASC", "LIMIT 2"].join("\n"));
  assert.equal(q.type, "table");
  assert.deepEqual(q.fields, [
    {name: "file.name", expr: "file.name"},
    {name: "priority", expr: "priority"},
  ]);
  assert.deepEqual(q.sort, [
    {expr: "priority", dir: "desc"},
    {expr: "file.name", dir: "asc"},
  ]);
  assert.equal(q.limit, 2);
  assert.equal(q.withoutId, undefined);
  assert.equal(q.groupByAlias, undefined);
  assert.deepEqual(q.flattenAliases, []);

  const err = (src) => assert.throws(() => parseDql(src), (e) => e instanceof DqlError);
  err("TABLE"); // empty field list
  err("table a\nLIMIT abc");
  err("table a\nFROM\n@@@"); // garbage FROM still rejected
  err("table a\nFROM #a and "); // malformed compound source
  err("table a\nFROM incoming([[A]]"); // unbalanced call
  try {
    parseDql("table a\nFROM #a and ");
    assert.fail("expected DqlError");
  } catch (e) {
    assert.ok(e instanceof DqlError);
    assert.equal(e.line, 2);
  }
});
