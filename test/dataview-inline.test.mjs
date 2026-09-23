/**
 * Inline queries — `` `= expr` `` (DQL) and `` `$= expr` `` (JS).
 *
 * Two seams, both real:
 *   A. preview/fencePlugin `installDataviewInlines` — real markdown-it instance,
 *      fake provider: prefix detection, pass-through, gates, error isolation.
 *   B. host/service `getInline` + REAL bundled worker: pending → refresh →
 *      ready, inline error isolation, inline/block key separation.
 *
 * Upstream reference (Obsidian Dataview): inline queries are code spans whose
 * content starts with the inline prefix (`=` for DQL, `$=` for JS); a disabled
 * `inlineQueries` setting leaves them as plain code.
 */
import {test, after} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import MarkdownIt from "markdown-it";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-dv-inline-"));

const bundles = {
  service: join(dir, "host-service.mjs"),
  fence: join(dir, "fence-plugin.mjs"),
  index: join(dir, "dv-index.mjs"),
  worker: join(dir, "dataviewWorker.mjs"),
};

try {
  execSync(
    [
      `npx esbuild src/dataview/host/service.ts --bundle --format=esm --platform=node --outfile="${bundles.service}"`,
      `npx esbuild src/dataview/preview/fencePlugin.ts --bundle --format=esm --platform=node --outfile="${bundles.fence}"`,
      `npx esbuild src/dataview/index/index.ts --bundle --format=esm --platform=node --outfile="${bundles.index}"`,
      `npx esbuild src/dataview/exec/workerEntry.ts --bundle --format=esm --platform=node --outfile="${bundles.worker}"`,
    ].join(" && "),
    {cwd: repoRoot, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}

const {createDataviewService} = await import(bundles.service);
const {installDataviewInlines, installDataviewFences} = await import(bundles.fence);
const {createIndexStore} = await import(bundles.index);

after(() => {
  rmSync(dir, {recursive: true, force: true});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, {label = "condition", timeoutMs = 10000, intervalMs = 20, state} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) {
      const snapshot = typeof state === "function" ? state() : state;
      assert.fail(`waitFor(${label}) timed out after ${timeoutMs}ms; last state: ${JSON.stringify(snapshot)}`);
    }
    await sleep(intervalMs);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// A. installDataviewInlines (real markdown-it, fake provider)
// ═════════════════════════════════════════════════════════════════════════════

/** Records every getInline call so prefix routing can be asserted directly. */
function makeProvider(respond = () => ({status: "ready", html: "<b>ok</b>"})) {
  const calls = [];
  return {
    calls,
    getBlock: () => ({status: "ready", html: "<div>block</div>"}),
    getInline(_env, kind, code) {
      calls.push({kind, code});
      return respond(kind, code);
    },
  };
}

test("inline A1: `= …` → dataview, `$= …` → dataviewjs, wrapped with data-dv-* attrs", () => {
  const provider = makeProvider((kind) => ({status: "ready", html: `<i>${kind}</i>`}));
  const md = new MarkdownIt();
  installDataviewInlines(md, {provider});

  const out = md.renderInline("a `= 1 + 1` b `$= dv.current().file.name` c");
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[0], {kind: "dataview", code: "1 + 1"});
  assert.deepEqual(provider.calls[1], {kind: "dataviewjs", code: "dv.current().file.name"});
  assert.equal(
    out,
    'a <span class="dataview-inline" data-dv-lang="dataview" data-dv-state="ready"><i>dataview</i></span> ' +
      'b <span class="dataview-inline" data-dv-lang="dataviewjs" data-dv-state="ready"><i>dataviewjs</i></span> c',
  );
});

test("inline A2: non-prefixed code spans are byte-identical to the baseline", () => {
  const doc = "use `npm run build` and `x = 1` and `` `= not a query` `` here";
  const baseline = new MarkdownIt().renderInline(doc);
  const provider = makeProvider();
  const md = new MarkdownIt();
  installDataviewInlines(md, {provider});

  assert.equal(md.renderInline(doc), baseline);
  assert.equal(provider.calls.length, 0, "only a leading prefix triggers a query");
  assert.ok(baseline.includes("<code>x = 1</code>"));
});

test("inline A3: prefix inside fenced/indented code is never intercepted", () => {
  const doc = ["```md", "`= 1 + 1`", "```", "", "    `$= 2`", ""].join("\n");
  const baseline = new MarkdownIt().render(doc);
  const provider = makeProvider();
  const md = new MarkdownIt();
  installDataviewInlines(md, {provider});

  assert.equal(md.render(doc), baseline);
  assert.equal(provider.calls.length, 0);
});

test("inline A4: `=` / `$=` with empty body stay literal (upstream keeps them as code)", () => {
  const provider = makeProvider();
  const md = new MarkdownIt();
  installDataviewInlines(md, {provider});

  const out = md.renderInline("`=` and `$=` and `=   `");
  assert.equal(provider.calls.length, 0);
  assert.equal(out, new MarkdownIt().renderInline("`=` and `$=` and `=   `"));
});

test("inline A5: isEnabled=false disables rendering without touching the DOM shape", () => {
  const provider = makeProvider();
  const md = new MarkdownIt();
  let enabled = false;
  installDataviewInlines(md, {provider, isEnabled: () => enabled});

  const doc = "v `= 1`";
  const baseline = new MarkdownIt().renderInline(doc);
  assert.equal(md.renderInline(doc), baseline);
  assert.equal(provider.calls.length, 0);

  enabled = true; // read per span: no re-install needed
  assert.equal(
    md.renderInline(doc),
    'v <span class="dataview-inline" data-dv-lang="dataview" data-dv-state="ready"><b>ok</b></span>',
  );
});

test("inline A6: custom prefixes (jsInlinePrefix/inlinePrefix) are honoured", () => {
  const provider = makeProvider();
  const md = new MarkdownIt();
  installDataviewInlines(md, {
    provider,
    inlinePrefix: () => "==",
    jsInlinePrefix: () => "$js=",
  });

  md.renderInline("`== 1` `$js= 2` `= 3` `$= 4`");
  assert.deepEqual(provider.calls, [
    {kind: "dataview", code: "1"},
    {kind: "dataviewjs", code: "2"},
  ]);
});

test("inline A7: a throwing provider yields an inline error span, not a thrown render", () => {
  const md = new MarkdownIt();
  installDataviewInlines(md, {
    provider: {
      getBlock: () => ({status: "ready", html: ""}),
      getInline: () => {
        throw new Error("provider exploded");
      },
    },
  });

  const out = md.renderInline("x `= 1` y");
  assert.ok(out.includes('data-dv-state="error"'), out);
  assert.ok(out.includes("provider exploded"));
  assert.ok(out.includes('class="dataview-inline"'));
});

test("inline A8: installDataviewInlines is idempotent per markdown-it instance", () => {
  const provider = makeProvider();
  const md = new MarkdownIt();
  installDataviewInlines(md, {provider});
  installDataviewInlines(md, {provider});
  const out = md.renderInline("`= 1`");
  assert.equal(provider.calls.length, 1, "double install must not emit twice");
  assert.equal(out.split("dataview-inline").length - 1, 1);
});

test("inline A9: provider without getInline leaves spans literal (feature-optional contract)", () => {
  const md = new MarkdownIt();
  installDataviewInlines(md, {provider: {getBlock: () => ({status: "ready", html: ""})}});
  assert.equal(md.renderInline("`= 1`"), new MarkdownIt().renderInline("`= 1`"));
});

test("inline A10: both plugins can coexist on one instance (block fence + inline span)", () => {
  const provider = makeProvider(() => ({status: "ready", html: "<i>inline</i>"}));
  const md = new MarkdownIt();
  installDataviewFences(md, {provider});
  installDataviewInlines(md, {provider});

  const doc = ["`= 1`", "", "```dataview", "TABLE file.name", "```", ""].join("\n");
  const out = md.render(doc);
  assert.ok(out.includes('class="dataview-inline"'), out);
  assert.ok(out.includes('<div class="dataview-block" data-dv-lang="dataview"'), out);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. host/service getInline with a REAL worker
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_ENV = () => ({currentDocument: {fsPath: "/ws/page.md", toString: () => "/ws/page.md"}});

function seedStore(pages) {
  const store = createIndexStore();
  pages.forEach(([path, content], i) => {
    store.upsertFile(path, content, 1000 + i * 7, content.length);
  });
  return store;
}

function createHarness(deps = {}) {
  const store = seedStore([["page.md", "---\nrating: 4\n---\n# Page\n\n#proj\n"]]);
  const counters = {refreshes: 0};
  const service = createDataviewService({
    workerPath: bundles.worker,
    store,
    toRelativePath: (p) => (p === undefined ? undefined : p.split("/").slice(-1)[0]),
    refresh: () => {
      counters.refreshes++;
    },
    isIndexReady: () => true,
    hostIo: {read: async () => "io-content", exists: async () => true},
    refreshDebounceMs: 10,
    refreshMinIntervalMs: 20,
    poolSize: 2,
    ...deps,
  });
  return {store, service, counters, dispose: () => service.dispose()};
}

/** First call may be pending; poll until `wantStatus` (getInline is the retry path). */
async function settleInline(h, kind, code, wantStatus = "ready", env = PAGE_ENV()) {
  const first = h.service.getInline(env, kind, code);
  if (first.status === wantStatus) return first;
  let last = first;
  await waitFor(
    () => {
      last = h.service.getInline(env, kind, code);
      return last.status === wantStatus;
    },
    {
      label: `inline ${wantStatus}`,
      state: () => ({status: last.status, html: last.html.slice(0, 200), exec: h.service.stats().exec}),
    },
  );
  return last;
}

test("inline B1: `= this.rating` runs through the real worker and renders the value", async () => {
  const h = createHarness();
  try {
    const state = await settleInline(h, "dataview", "this.rating");
    assert.equal(state.status, "ready");
    assert.ok(state.html.includes("4"), state.html);
  } finally {
    await h.dispose();
  }
});

test("inline B2: `$= 1 + 2` renders the evaluated value (expression semantics)", async () => {
  const h = createHarness();
  try {
    const state = await settleInline(h, "dataviewjs", "1 + 2");
    assert.equal(state.status, "ready");
    assert.ok(state.html.includes("3"), state.html);
  } finally {
    await h.dispose();
  }
});

test("inline B3: `$= dv.current().file.name` reads the page object", async () => {
  const h = createHarness();
  try {
    const state = await settleInline(h, "dataviewjs", "dv.current().file.name");
    assert.ok(state.html.includes("page"), state.html);
  } finally {
    await h.dispose();
  }
});

test("inline B4: inline failure is isolated and cached (no infinite re-run)", async () => {
  const h = createHarness();
  try {
    const state = await settleInline(h, "dataviewjs", "throw new Error('inline boom')", "error");
    assert.equal(state.status, "error");
    assert.ok(state.html.includes("inline boom"), state.html);

    // A neighbouring inline query on the same page still succeeds.
    const ok = await settleInline(h, "dataviewjs", "2 * 21");
    assert.equal(ok.status, "ready");
    assert.ok(ok.html.includes("42"));
  } finally {
    await h.dispose();
  }
});

test("inline B5: inline and block cache keys never collide (same source, both kinds)", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const inline = await settleInline(h, "dataviewjs", "6 * 7");
    // `getBlock` with the same source must enqueue its own job, not reuse the
    // inline result: blocks go through the op-emitting path (no implicit value).
    const block = h.service.getBlock(env, "dataviewjs", "6 * 7");
    assert.ok(block.status === "pending" || block.status === "ready");
    await waitFor(
      () => h.service.getBlock(env, "dataviewjs", "6 * 7").status === "ready",
      {label: "block job after inline", state: () => h.service.stats()},
    );
    assert.ok(inline.html.includes("42"));
  } finally {
    await h.dispose();
  }
});

test("inline B6: identical inline queries in one document dedup to a single job", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const a = h.service.getInline(env, "dataviewjs", "1 + 1");
    const b = h.service.getInline(env, "dataviewjs", "1 + 1");
    assert.equal(a.status, "pending");
    assert.equal(b.status, "pending", "second call during the job must dedup to pending");
    const stats = h.service.stats();
    assert.equal(stats.inFlight, 1, JSON.stringify(stats));
    await settleInline(h, "dataviewjs", "1 + 1");
  } finally {
    await h.dispose();
  }
});
