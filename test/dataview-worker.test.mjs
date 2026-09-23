/**
 * B5 tests: worker-side sandbox runtime (src/dataview/exec/workerRuntime.ts).
 *
 * No worker_threads here: the runtime is bundled with esbuild into a temp
 * `.mjs`, imported, and `createRunJob()` is driven directly with hand-built
 * job/snapshot/io objects. That keeps failures localizable (a plain stack, no
 * message plumbing) while still exercising the real vm sandbox, the real dv /
 * app shims, the real DQL engine and the real index store.
 */
import {test, after} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-worker-"));
const runtimeBundle = join(dir, "workerRuntime.mjs");
const storeBundle = join(dir, "store.mjs");

try {
  execSync(
    `npx esbuild src/dataview/exec/workerRuntime.ts --bundle --format=esm --platform=node --outfile="${runtimeBundle}"` +
    ` && npx esbuild src/dataview/index/store.ts --bundle --format=esm --platform=node --outfile="${storeBundle}"`,
    {cwd: repoRoot, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
after(() => rmSync(dir, {recursive: true, force: true}));

const {createRunJob, adjustStackLines, MAX_OPS} = await import(runtimeBundle);
const {createIndexStore} = await import(storeBundle);

// ── fixtures ──────────────────────────────────────────────────────────────

const CURRENT_PAGE = "notes/cur.md";
const FILES = [
  [CURRENT_PAGE, "---\ntitle: Cur\n---\n#tag1\n"],
  ["other/x.md", "---\ntitle: X\n---\n#tag2\n"],
];

function buildSnapshot(files = FILES) {
  const store = createIndexStore();
  let mtime = 0;
  for (const [path, content] of files) store.upsertFile(path, content, ++mtime, content.length);
  return store.snapshot();
}

const snapshot = buildSnapshot();
const runJob = createRunJob();

function makeJob(code, over = {}) {
  return {
    id: "job-1",
    kind: "dataviewjs",
    code,
    pagePath: CURRENT_PAGE,
    indexVersion: snapshot.version,
    blockIndex: 0,
    timeoutMs: 5000,
    ...over,
  };
}

/** Records every io bridge call; the bridge is the only async escape hatch. */
function makeIo() {
  const calls = [];
  return {
    calls,
    io: {
      async read(path) {
        calls.push({op: "read", path});
        return `IO:${path}`;
      },
      async exists(path) {
        calls.push({op: "exists", path});
        return true;
      },
    },
  };
}

/** Fresh io recorder per run → assertions stay isolated between tests. */
async function runRecorded(code, over = {}) {
  const rec = makeIo();
  const result = await runJob(makeJob(code, over), snapshot, rec.io);
  return {result, calls: rec.calls};
}

async function run(code, over = {}) {
  return (await runRecorded(code, over)).result;
}

const paragraph = (text) => [{kind: "paragraph", text}];

/**
 * RenderOps are JSON-cloneable (they cross the worker boundary as structured
 * clone), but arrays built *inside* the vm keep that realm's Array.prototype —
 * which strict deepEqual rejects for prototype mismatch alone. Compare a
 * plain-data copy: exactly what the host receives after the clone.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── 1. dv rendering → RenderOps ───────────────────────────────────────────

test("dv.paragraph emits exactly one paragraph op", async () => {
  const r = await run('dv.paragraph("hi")');
  assert.equal(r.ok, true);
  assert.deepEqual(r.ops, paragraph("hi"));
});

test("dv.table emits a table op whose cells are the CellValue union", async () => {
  const r = await run('dv.table(["a", "b"], [[1, 2]])');
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.ops), [{
    kind: "table",
    headers: ["a", "b"],
    rows: [{cells: [{t: "num", v: 1}, {t: "num", v: 2}]}],
  }]);
});

// ── 2. page lookup / source filtering ────────────────────────────────────

test("dv.current() resolves the job's page and dv.page() another one", async () => {
  const r = await run(
    'dv.paragraph([dv.current().file.path, dv.page("other/x.md").file.path, String(dv.page("missing.md"))].join("|"))',
  );
  assert.deepEqual(r.ops, paragraph(`${CURRENT_PAGE}|other/x.md|undefined`));
});

test("dv.pages() returns every page of the snapshot", async () => {
  const r = await run("dv.paragraph(String(dv.pages().length))");
  assert.deepEqual(r.ops, paragraph(String(FILES.length)));
});

test('dv.pages("#tag") keeps only pages carrying the tag', async () => {
  const r = await run('dv.paragraph(dv.pages("#tag1").array().map((p) => p.file.path).join(","))');
  assert.deepEqual(r.ops, paragraph(CURRENT_PAGE));
});

test('dv.pages(\'"path"\') (DQL-style quoted literal) matches the exact page', async () => {
  const r = await run('dv.paragraph(String(dv.pages(\'"other/x.md"\').length))');
  assert.deepEqual(r.ops, paragraph("1"));
});

// ── 3. DataArray / date / duration inside the vm ─────────────────────────

test("dv.array(...).sort().array() sorts ascending", async () => {
  const r = await run("dv.paragraph(JSON.stringify(dv.array([3, 1, 2]).sort().array()))");
  assert.deepEqual(r.ops, paragraph("[1,2,3]"));
});

test("dv.array(...).sum() adds the numbers", async () => {
  const r = await run("dv.paragraph(String(dv.array([1, 2, 3]).sum()))");
  assert.deepEqual(r.ops, paragraph("6"));
});

test("dv.date() returns a usable DvDate", async () => {
  const r = await run('const d = dv.date("2024-01-02");' +
    'dv.paragraph([d.year, d.month, d.day, d.weekday, typeof d.toMillis, d.toFormat("yyyy-MM-dd")].join("|"))');
  // 2024-01-02 is a Tuesday; weekday is ISO (2). toFormat is timezone-independent.
  assert.deepEqual(r.ops, paragraph("2024|1|2|2|function|2024-01-02"));
});

test("dv.duration() returns a millisecond Duration", async () => {
  const r = await run('const d = dv.duration("1 day"); dv.paragraph(typeof d.ms + "|" + d.ms)');
  assert.deepEqual(r.ops, paragraph("number|86400000"));
});

// ── 4. async / control flow at the top level ─────────────────────────────

test("top-level await resolves the io bridge before the next statement", async () => {
  const {result, calls} = await runRecorded('const t = await dv.io.read("x.md"); dv.paragraph(t)');
  assert.deepEqual(result.ops, paragraph("IO:x.md"));
  assert.deepEqual(calls, [{op: "read", path: "x.md"}]);
});

test("top-level await suspends the block between statements", async () => {
  const r = await run('dv.paragraph("before"); await new Promise((r) => setTimeout(r, 5)); dv.paragraph("after")');
  assert.deepEqual(r.ops, [...paragraph("before"), ...paragraph("after")]);
});

test("top-level return ends the block immediately", async () => {
  const r = await run('dv.paragraph("kept"); return; dv.paragraph("dropped")');
  assert.deepEqual(r.ops, paragraph("kept"));
});

// ── 5. error reporting + stack line remapping ────────────────────────────

test("a thrown error surfaces message, empty ops and a stack detail", async () => {
  const r = await run('throw new Error("boom")');
  assert.equal(r.ok, false);
  assert.deepEqual(r.ops, []);
  assert.equal(r.error.message, "boom");
  assert.equal(typeof r.error.detail, "string");
  assert.match(r.error.detail, /notes\/cur\.md#dataviewjs-0:\d+:\d+/);
});

test("stack lines point at the user's line, not the wrapped line", async () => {
  const r = await run('const a = 1;\ndv.paragraph(String(a));\nthrow new Error("line3")');
  assert.equal(r.ok, false);
  assert.ok(r.error.detail.includes("notes/cur.md#dataviewjs-0:3:"), r.error.detail);
  assert.ok(!r.error.detail.includes("notes/cur.md#dataviewjs-0:5:"), r.error.detail);
});

test("adjustStackLines subtracts the 2 wrapper lines (WRAP_LINE_OFFSET)", () => {
  assert.equal(
    adjustStackLines("at f (/x/a.md#dataviewjs-0.js:7:3)", "/x/a.md#dataviewjs-0"),
    "at f (/x/a.md#dataviewjs-0.js:5:3)",
  );
});

test("adjustStackLines leaves non-matching and wrapper frames untouched", () => {
  const label = "/x/a.md#dataviewjs-0";
  assert.equal(adjustStackLines("at f (/y/b.md:9:1)", label), "at f (/y/b.md:9:1)");
  // Line 2 is the wrapper's own `"use strict";` line → no valid user line exists.
  assert.equal(adjustStackLines(`at ${label}:2:1`, label), `at ${label}:2:1`);
});

test("a syntax error is reported as a failed job, never thrown at the caller", async () => {
  const r = await run("dv.paragraph(");
  assert.equal(r.ok, false);
  assert.deepEqual(r.ops, []);
  assert.match(r.error.message, /Unexpected/);
});

// ── 6. isolation boundary ────────────────────────────────────────────────

test("the sandbox exposes dv/app/input but no host globals", async () => {
  const r = await run(
    'dv.paragraph([typeof process, typeof require, typeof module, typeof globalThis.exports, typeof dv, typeof app, typeof input].join(","))',
  );
  assert.deepEqual(r.ops, paragraph("undefined,undefined,undefined,undefined,object,object,string"));
});

test("eval and the Function constructor are disabled (codeGeneration.strings:false)", async () => {
  const r = await run([
    "const out = [];",
    'try { eval("1 + 1"); out.push("eval-allowed"); } catch (e) { out.push("eval:" + e.name); }',
    'try { new Function("return 1")(); out.push("fn-allowed"); } catch (e) { out.push("fn:" + e.name); }',
    'dv.paragraph(out.join(","));',
  ].join("\n"));
  assert.deepEqual(r.ops, paragraph("eval:EvalError,fn:EvalError"));
});

test("dynamic import() is rejected and fails the job", async () => {
  const r = await run('await import("node:fs")');
  assert.equal(r.ok, false);
  assert.deepEqual(r.ops, []);
  // Node only invokes the custom importModuleDynamically callback (whose message
  // says "Dynamic import() is not available…") under --experimental-vm-modules;
  // without the flag the rejection comes from the vm itself. Both refuse.
  assert.match(r.error.message, /dynamic import/i);
});

test("each block gets a fresh vm context (no globalThis leakage)", async () => {
  const a = await run('globalThis.leak = 1; dv.paragraph(String(globalThis.leak))');
  const b = await run("dv.paragraph(String(typeof leak))");
  assert.deepEqual(a.ops, paragraph("1"));
  assert.deepEqual(b.ops, paragraph("undefined"));
});

// ── 7. resource limits ───────────────────────────────────────────────────

test(`emitted ops are capped at MAX_OPS (${MAX_OPS}) with a warn notice`, async () => {
  const r = await run('for (let i = 0; i < 5000; i++) { dv.paragraph("x" + i); }');
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, MAX_OPS + 1);
  assert.deepEqual(r.ops[MAX_OPS - 1], {kind: "paragraph", text: "x" + (MAX_OPS - 1)});
  assert.deepEqual(r.ops[MAX_OPS], {kind: "notice", level: "warn", message: `Output truncated at ${MAX_OPS} blocks.`});
});

test("user timers are released when the job settles", async () => {
  // Control: a timer that the block AWAITS does run — so the 5ms budget below
  // is genuinely enough for the detached timer to have fired if it survived.
  const control = await runRecorded('await new Promise((r) => setTimeout(r, 5)); await dv.io.read("before.md")');
  assert.deepEqual(control.calls, [{op: "read", path: "before.md"}]);

  const {result, calls} = await runRecorded('setTimeout(async () => { await dv.io.read("late.md"); }, 5); dv.paragraph("start")');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ops, paragraph("start"));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, []);
});

// ── 8. DQL branch ────────────────────────────────────────────────────────

test("a DQL table job renders a table op", async () => {
  const r = await run('TABLE file.name\nFROM "#tag1"', {kind: "dql"});
  assert.equal(r.ok, true);
  // Upstream TABLE carries an implicit leading "File" id column (a link cell).
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.ops[0].headers, ["File", "file.name"]);
  assert.deepEqual(r.ops[0].rows[0].cells[1], {t: "str", v: "cur"});
  assert.deepEqual(r.ops[0].rows[0].cells[0].t, "link");
});

test("an unparsable DQL job fails with the DqlError message", async () => {
  const r = await run("SELECT nope", {kind: "dql"});
  assert.equal(r.ok, false);
  assert.deepEqual(r.ops, []);
  assert.equal(r.error.message, "Query must start with TABLE, LIST, TASKS or CALENDAR");
});

// ── 9. result envelope / globals ─────────────────────────────────────────

test("the result envelope carries id, indexVersion and a duration", async () => {
  const r = await run('dv.paragraph("x")');
  assert.equal(r.id, "job-1");
  assert.equal(r.indexVersion, snapshot.version);
  assert.equal(typeof r.durationMs, "number");
  assert.ok(r.durationMs >= 0, `durationMs=${r.durationMs}`);
});

test("the input global is the raw block source", async () => {
  const code = 'dv.paragraph("a");\ndv.paragraph(input);';
  const r = await run(code);
  assert.deepEqual(r.ops, [...paragraph("a"), ...paragraph(code)]);
});

// ── 10. app shim + io bridge surface ─────────────────────────────────────

test("app.vault/app.metadataCache read through the snapshot", async () => {
  const r = await run(
    'dv.paragraph([app.vault.getFiles().length, JSON.stringify(app.metadataCache.getFileCache("other/x.md").frontmatter)].join("|"))',
  );
  assert.deepEqual(r.ops, paragraph(`2|{"title":"X"}`));
});

test("dv.io.load() probes existence first (undefined for missing files)", async () => {
  const {result, calls} = await runRecorded('dv.paragraph(await dv.io.load("x.md"))');
  assert.deepEqual(result.ops, paragraph("IO:x.md"));
  // Upstream `load()` returns undefined for a missing file instead of throwing,
  // so it must ask the host whether the file exists before reading it.
  assert.deepEqual(calls, [{op: "exists", path: "x.md"}, {op: "read", path: "x.md"}]);
});

// ── 11. regression guard (loose upper bound, not a benchmark) ────────────

test("a table over dv.pages() with a 1000-line frontmatter page stays under 500ms", async () => {
  const frontmatter = ["---"];
  for (let i = 0; i < 1000; i++) frontmatter.push(`k${i}: v${i}`);
  frontmatter.push("---", "body");
  const bigSnapshot = buildSnapshot([[CURRENT_PAGE, "#tag1\n"], ["big.md", frontmatter.join("\n") + "\n"]]);

  const started = Date.now();
  const r = await runJob(
    makeJob('dv.table(["p"], dv.pages().map((p) => [p.file.path]))', {indexVersion: bigSnapshot.version}),
    bigSnapshot,
    makeIo().io,
  );
  const elapsed = Date.now() - started;

  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.ops), [{
    kind: "table",
    headers: ["p"],
    rows: [{cells: [{t: "str", v: "big.md"}]}, {cells: [{t: "str", v: CURRENT_PAGE}]}],
  }]);
  assert.ok(elapsed < 500, `expected < 500ms, took ${elapsed}ms`);
});
